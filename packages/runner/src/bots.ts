// Chat bot accounts (docs/spec.md §3.13, D69): `<home>/bots.json`, written by the dashboard (`/api/bots`) or by hand.
// A bot's token is the raw token or a secret reference (op://…, env:…). The file is kept 0600; tokens are resolved
// at start and redacted like secrets. A connector picks a bot with `with.bot`, else the default; `with.token` skips
// the file.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Pipeline, parseDuration } from "@pipo/spec";
import { defaultResolver, type Resolver } from "./secrets";

export const TELEGRAM_API = "https://api.telegram.org";
export const BOT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const BOT_KEYS = ["token", "allow", "poll_every", "api"];

export interface BotConfig {
  /** The raw token, or `op://…` / `env:…`. */
  token: string;
  /** Chat or user ids whose messages become packets; anyone else is ignored (and logged). */
  allow?: number[];
  poll_every?: string;
  /** Bot API base URL (a local Bot API server, or a test double). */
  api?: string;
}

export interface BotsFile {
  telegram: { default: string | null; bots: Record<string, BotConfig> };
}

/** A bot ready to use: its token resolved. */
export interface Bot {
  name: string;
  token: string;
  api: string;
  allow: number[];
  poll_every?: string;
}

export interface Bots {
  telegram: Map<string, Bot>;
  default: string | null;
}

export class BotsError extends Error {}

export const botsPath = (home: string) => join(home, "bots.json");
export const isReference = (token: string) => token.startsWith("op://") || token.startsWith("env:");
/** The bot's numeric id: the part of a token before `:`. Public, so it can name the bot in the registry and the UI. */
export const botId = (token: string) => token.split(":")[0] ?? "";

const empty = (): BotsFile => ({ telegram: { default: null, bots: {} } });

/** Problems with a bot's settings, in words a user can act on. Never echoes the token. */
export function botProblems(name: string, b: Record<string, unknown>): string[] {
  const out: string[] = [];
  const at = `telegram bot '${name}'`;
  if (!BOT_NAME.test(name)) out.push(`bot name '${name}' must be lowercase letters, digits, '-' or '_'`);
  for (const k of Object.keys(b))
    if (!BOT_KEYS.includes(k)) out.push(`${at}: unknown key '${k}' (known: ${BOT_KEYS.join(", ")})`);
  if (typeof b.token !== "string" || !b.token.trim()) out.push(`${at}: token is missing; paste it from @BotFather`);
  if (b.allow !== undefined && !(Array.isArray(b.allow) && b.allow.every((x) => Number.isInteger(x))))
    out.push(`${at}: allow must be a list of chat or user ids (whole numbers)`);
  if (b.poll_every !== undefined) {
    let ms = 0;
    try {
      ms = parseDuration(String(b.poll_every));
    } catch {}
    if (ms < 1000) out.push(`${at}: poll_every must be a duration of at least 1s, such as 10s or 1m`);
  }
  if (b.api !== undefined && !(typeof b.api === "string" && /^https?:\/\//.test(b.api)))
    out.push(`${at}: api must be an http(s) URL`);
  return out;
}

export function readBots(home: string): BotsFile {
  const path = botsPath(home);
  if (!existsSync(path)) return empty();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new BotsError(`${path} is not valid JSON (${(e as Error).message}); fix it, or delete it and add bots again`);
  }
  const tg = (raw as { telegram?: { default?: unknown; bots?: unknown } } | null)?.telegram;
  const bots = (tg?.bots ?? {}) as Record<string, Record<string, unknown>>;
  if (!bots || typeof bots !== "object" || Array.isArray(bots))
    throw new BotsError(`${path}: telegram.bots must be a map of bot name to settings`);
  const problems = Object.entries(bots).flatMap(([n, b]) =>
    b && typeof b === "object" ? botProblems(n, b) : [`telegram bot '${n}' must be a map`],
  );
  const def = tg?.default ?? null;
  if (def !== null && (typeof def !== "string" || !bots[def]))
    problems.push(`telegram.default names '${def}', which is not one of the bots`);
  if (problems.length)
    throw new BotsError(`${path} has ${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join("\n")}`);
  return { telegram: { default: def as string | null, bots: bots as unknown as Record<string, BotConfig> } };
}

/** Write atomically, readable by the owner only (it may hold raw tokens). */
export function writeBots(home: string, file: BotsFile): void {
  const path = botsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(`${path}.tmp`, 0o600);
  renameSync(`${path}.tmp`, path);
}

/** Every telegram `with:` block of a pipeline (input, taps, output), with where it is. */
export function telegramUses(p: Pipeline): { at: string; with: Record<string, unknown> }[] {
  const out: { at: string; with: Record<string, unknown> }[] = [];
  if (p.input.via === "telegram") out.push({ at: "input", with: p.input.with ?? {} });
  for (const [id, n] of Object.entries(p.nodes ?? {}))
    if (n.tap === "telegram") out.push({ at: `nodes.${id}`, with: (n.with ?? {}) as Record<string, unknown> });
  if (p.output.to === "telegram") out.push({ at: "output", with: p.output.with ?? {} });
  return out;
}

/**
 * The bots a pipeline uses, tokens resolved. Throws BotsError when one is missing or its token can't be resolved.
 * Blocks with an inline `with.token` need no bot from the file.
 */
export async function loadBots(home: string, p: Pipeline, resolver: Resolver = defaultResolver): Promise<Bots> {
  const file = readBots(home);
  const tg = file.telegram;
  const bots: Bots = { telegram: new Map(), default: tg.default };
  for (const use of telegramUses(p)) {
    if (use.with.token !== undefined) continue;
    const name = (use.with.bot as string | undefined) ?? tg.default;
    if (!name)
      throw new BotsError(
        `${use.at} uses telegram but no bot is set up; add one in the dashboard (Bots), or set ${use.at}.with.token to \${secrets.<name>}`,
      );
    if (bots.telegram.has(name)) continue;
    const b = tg.bots[name];
    if (!b)
      throw new BotsError(
        `${use.at}.with.bot names '${name}', but ${botsPath(home)} has no such telegram bot (known: ${Object.keys(tg.bots).join(", ") || "none"}); add it in the dashboard (Bots)`,
      );
    let token = b.token;
    if (isReference(token)) {
      try {
        token = await resolver(token);
      } catch (e) {
        throw new BotsError(`telegram bot '${name}': ${(e as Error).message}`);
      }
    }
    bots.telegram.set(name, {
      name,
      token,
      api: (b.api ?? TELEGRAM_API).replace(/\/+$/, ""),
      allow: b.allow ?? [],
      poll_every: b.poll_every,
    });
  }
  return bots;
}

/** The bot a rendered `with:` block uses: an inline token, the named bot, or the default. */
export function pickBot(bots: Bots | undefined, w: Record<string, unknown>, owner: string): Bot {
  if (w.token !== undefined) {
    const token = String(w.token);
    if (!token) throw new Error(`${owner}.with.token is empty after rendering; check the secret`);
    return { name: `bot ${botId(token)}`, token, api: TELEGRAM_API, allow: [] };
  }
  const name = (w.bot as string | undefined) ?? bots?.default;
  const bot = name ? bots?.telegram.get(name) : undefined;
  if (!bot) throw new Error(`${owner}: telegram bot '${name ?? "(default)"}' was not loaded at start`);
  return bot;
}

// ── Bot API ──────────────────────────────────────────────────────────────────

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

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
