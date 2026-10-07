// Telegram (docs/spec.md §3.13, D69): `via: telegram`, `tap: telegram`, `to: telegram`, over the Bot API with fetch.
// The input long-polls getUpdates only while its runner runs. Its offset is saved in the packet's own transaction,
// so an update is journaled once: after a crash it is fetched again only if its packet was not committed. Sends
// are at-least-once: Telegram has no idempotency key, so a crash between a send and its commit sends it again.
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { formatDuration, parseDuration } from "@pipo/spec";
import { type Bot, type Bots, botId, pickBot } from "../bots";
import type { InputAdapter, InputRuntime, InputState, Intake, Origin, OutputAdapter, WriteItem } from "./types";

const DEFAULT_POLL = "25s";
const RETRY_WAIT_MS = 5_000;
const SEND_TRIES = 3;
const MAX_RETRY_AFTER_S = 60;
const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    const t = setTimeout(done, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        done();
      },
      { once: true },
    );
  });

/** One Bot API call. The URL holds the token, so errors name the method, never the URL. */
export async function telegramCall(
  bot: Bot,
  method: string,
  params: Record<string, unknown> | FormData,
  signal?: AbortSignal,
): Promise<any> {
  const form = params instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`${bot.api}/bot${bot.token}/${method}`, {
      method: "POST",
      headers: form ? undefined : { "content-type": "application/json" },
      body: form ? params : JSON.stringify(params),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new TelegramError(`telegram ${method} failed: ${(e as Error).message}; check the network`, 0);
  }
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    result?: unknown;
    description?: string;
    parameters?: { retry_after?: number };
  } | null;
  if (body?.ok) return body.result;
  const why = body?.description ?? `HTTP ${res.status}`;
  const hint =
    res.status === 401 || res.status === 404
      ? "the bot token is wrong or revoked; get a new one from @BotFather and update the bot in the dashboard (Bots)"
      : res.status === 409
        ? "another program reads this bot's updates (another pipeline, or a webhook); stop it, or call deleteWebhook"
        : res.status === 403
          ? "the user blocked the bot, or never pressed Start in its chat"
          : res.status === 429
            ? "Telegram is rate limiting this bot"
            : "see the Telegram Bot API docs for this error";
  throw new TelegramError(
    `telegram ${method} answered ${res.status}: ${why}; ${hint}`,
    res.status,
    body?.parameters?.retry_after,
  );
}

// ── input ─────────────────────────────────────────────────────────────────────

interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

const FILE_KINDS = ["document", "photo", "audio", "voice", "video", "animation"] as const;

export interface TelegramInputOptions {
  bot: Bot;
  /** `with.allow` replaces the bot's list. */
  allow?: number[];
  poll_every?: string;
  /** Download attached files into `filesDir` (default true). */
  download?: boolean;
  filesDir: string;
  log?: (level: string, message: string) => void;
}

export class TelegramInput implements InputAdapter {
  private stopped = true;
  private abort = new AbortController();
  private loop: Promise<void> = Promise.resolve();
  private offset = 0;
  private state?: InputState;
  private readonly pollS: number;
  private readonly allow: Set<number>;

  constructor(private readonly opts: TelegramInputOptions) {
    const ms = parseDuration(opts.poll_every ?? opts.bot.poll_every ?? DEFAULT_POLL);
    if (ms < 1000) throw new Error("telegram poll_every must be at least 1s");
    this.pollS = Math.round(ms / 1000);
    this.allow = new Set(opts.allow ?? opts.bot.allow);
  }

  /** The bot's numeric id (public; the token's part before `:`). */
  get botId(): string {
    return botId(this.opts.bot.token);
  }

  describe(): string {
    return `telegram ${this.opts.bot.name}, long polling (${formatDuration(this.pollS * 1000)})`;
  }

  async start(intake: Intake, runtime?: InputRuntime): Promise<void> {
    this.state = runtime?.state(`telegram:${this.botId}`);
    const saved = this.state?.load();
    if (saved === null) this.state?.baseline(new Map());
    this.offset = Number(saved?.get("offset") ?? 0);
    if (!this.allow.size)
      this.opts.log?.(
        "warn",
        `telegram ${this.opts.bot.name} has no allow list: every message is ignored; the log names each sender's id to add`,
      );
    this.stopped = false;
    this.abort = new AbortController();
    this.loop = this.run(intake);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await this.loop;
  }

  private async run(intake: Intake): Promise<void> {
    const signal = this.abort.signal;
    while (!this.stopped) {
      let updates: { update_id: number; message?: any }[];
      try {
        updates = await telegramCall(
          this.opts.bot,
          "getUpdates",
          { offset: this.offset, timeout: this.pollS, allowed_updates: ["message"] },
          AbortSignal.any([signal, AbortSignal.timeout((this.pollS + 15) * 1000)]),
        );
      } catch (e) {
        if (this.stopped) return;
        this.opts.log?.("error", `${(e as Error).message}; retrying in ${RETRY_WAIT_MS / 1000}s`);
        await sleep(RETRY_WAIT_MS, signal);
        continue;
      }
      for (const u of updates) {
        if (this.stopped) return;
        if (!(await this.take(u, intake))) {
          await sleep(1000, signal);
          break; // fetched again from the same offset
        }
      }
    }
  }

  /** False when the runner can't take the packet now (buffer full, draining): the update is fetched again later. */
  private async take(u: { update_id: number; message?: any }, intake: Intake): Promise<boolean> {
    const next = u.update_id + 1;
    const skip = () => {
      this.state?.put("offset", next);
      this.offset = next;
      return true;
    };
    const m = u.message;
    if (!m) return skip();
    const chat = Number(m.chat?.id);
    const from = Number(m.from?.id);
    if (!this.allow.has(chat) && !this.allow.has(from)) {
      const who = m.from?.username ? `@${m.from.username}` : (m.from?.first_name ?? "someone");
      this.opts.log?.(
        "warn",
        `telegram ${this.opts.bot.name}: ignored a message from ${who} (user id ${from}, chat id ${chat}): not in the allow list; add ${chat} to the bot's allow list in the dashboard (Bots) to accept it`,
      );
      return skip();
    }
    const payload = await this.packet(m);
    let r: Awaited<ReturnType<Intake>>;
    try {
      r = await intake(
        payload,
        { trigger: "telegram", source: String(chat) },
        { commit: () => this.state?.put("offset", next) },
      );
    } catch (e) {
      this.opts.log?.("error", `telegram message ${u.update_id} could not be journaled: ${(e as Error).message}`);
      return false;
    }
    if (r.status === "unavailable") return false;
    this.offset = next;
    return true;
  }

  private async packet(m: any) {
    const kind = FILE_KINDS.find((k) => m[k] !== undefined);
    // A photo comes in several sizes, smallest first.
    const f: TgFile | undefined = kind === "photo" ? m.photo[m.photo.length - 1] : kind ? m[kind] : undefined;
    return {
      message_id: m.message_id,
      date: new Date((m.date ?? 0) * 1000).toISOString(),
      chat_id: m.chat?.id,
      chat_type: m.chat?.type,
      from: {
        id: m.from?.id,
        username: m.from?.username ?? null,
        name: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" "),
      },
      text: m.text ?? m.caption ?? "",
      file: f && kind ? await this.file(kind, f) : null,
    };
  }

  private async file(kind: string, f: TgFile) {
    const out = {
      kind,
      file_id: f.file_id,
      name: f.file_name ?? null,
      mime_type: f.mime_type ?? null,
      size: f.file_size ?? null,
      path: null as string | null,
    };
    if (this.opts.download === false) return out;
    try {
      const info = (await telegramCall(this.opts.bot, "getFile", { file_id: f.file_id })) as { file_path?: string };
      if (!info.file_path) throw new Error("Telegram gave no file path");
      const name = f.file_name ? basename(f.file_name) : `${kind}${extname(info.file_path)}`;
      const path = join(this.opts.filesDir, `${f.file_unique_id}-${name.replace(/[^\w.-]+/g, "_")}`);
      if (!existsSync(path)) {
        const res = await fetch(`${this.opts.bot.api}/file/bot${this.opts.bot.token}/${info.file_path}`, {
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) throw new Error(`download answered ${res.status}`);
        mkdirSync(this.opts.filesDir, { recursive: true });
        await Bun.write(`${path}.part`, await res.arrayBuffer());
        renameSync(`${path}.part`, path);
      }
      out.path = path;
    } catch (e) {
      // Telegram bots can't download files over 20 MB; the packet still carries the file's id and name.
      this.opts.log?.("warn", `telegram ${this.opts.bot.name}: could not download a ${kind}: ${(e as Error).message}`);
    }
    return out;
  }
}

// ── sending (tap and output) ───────────────────────────────────────────────────

/** Send one message from a rendered `with:` block. Answers `{chat_id, message_id}`. */
export async function telegramSend(
  bots: Bots | undefined,
  dir: string,
  w: Record<string, unknown>,
  data: unknown,
  origin: Origin | undefined,
  owner: string,
): Promise<{ chat_id: number | string; message_id: number }> {
  const bot = pickBot(bots, w, owner);
  const chat = w.chat_id ?? (origin?.trigger === "telegram" ? origin.source : undefined);
  if (chat === undefined || chat === "")
    throw new Error(
      `${owner}.with.chat_id is not set and the packet did not come from a telegram input; set ${owner}.with.chat_id`,
    );
  const text = w.text !== undefined ? String(w.text) : typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const media = w.photo !== undefined ? "photo" : w.document !== undefined ? "document" : null;
  const common = { chat_id: chat, ...(w.parse_mode ? { parse_mode: w.parse_mode } : {}) };
  let method = "sendMessage";
  let params: Record<string, unknown> | FormData = { ...common, text: text.slice(0, TEXT_LIMIT) };
  if (media) {
    method = media === "photo" ? "sendPhoto" : "sendDocument";
    const ref = String(w[media]);
    const caption = text.slice(0, CAPTION_LIMIT);
    if (/^https?:\/\//.test(ref)) params = { ...common, [media]: ref, ...(caption ? { caption } : {}) };
    else {
      const path = resolve(dir, ref);
      if (!existsSync(path))
        throw new Error(`${owner}.with.${media}: no file at ${path}; give a path or an http(s) URL`);
      const form = new FormData();
      for (const [k, v] of Object.entries(common)) form.append(k, String(v));
      if (caption) form.append("caption", caption);
      form.append(media, Bun.file(path), basename(path));
      params = form;
    }
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const msg = (await telegramCall(bot, method, params)) as { message_id: number; chat?: { id: number } };
      return { chat_id: msg.chat?.id ?? (chat as number | string), message_id: msg.message_id };
    } catch (e) {
      // Rate limited: wait as Telegram asks, a few times, before the step's own on_error takes over.
      if (!(e instanceof TelegramError) || e.code !== 429 || attempt >= SEND_TRIES) throw e;
      await sleep(Math.min(e.retryAfter ?? 1, MAX_RETRY_AFTER_S) * 1000);
    }
  }
}

export class TelegramOutput implements OutputAdapter {
  constructor(
    private readonly bots: Bots | undefined,
    private readonly dir: string,
  ) {}
  async write(items: WriteItem[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const i of items) out.push(await telegramSend(this.bots, this.dir, i.with, i.data, i.origin, "output"));
    return out;
  }
  async verify(check: string): Promise<boolean> {
    throw new Error(`telegram output does not support delivery check '${check}'`);
  }
  close() {}
}
