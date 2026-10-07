// Chat bots in the dashboard (docs/spec.md §3.13, §8, D69): `/api/bots` reads and edits `<home>/bots.json`. A token
// goes in and never comes out: a raw one is shown as its bot id, a reference (op://…, env:…) as written.
import {
  BOT_NAME,
  type BotConfig,
  BotsError,
  botId,
  botProblems,
  defaultResolver,
  isReference,
  readBots,
  TELEGRAM_API,
  telegramCall,
  writeBots,
} from "@pipo/runner";
import { HttpError } from "./http-error";

const KEYS = ["token", "allow", "poll_every", "api", "default", "rename"];

const bad = (message: string, hint: string) => new HttpError(400, message, hint, "bad_request");

function read(home: string) {
  try {
    return readBots(home);
  } catch (e) {
    if (e instanceof BotsError) throw bad(e.message, "fix the file by hand, or delete it and add the bots again");
    throw e;
  }
}

export function listBots(home: string) {
  const tg = read(home).telegram;
  return {
    telegram: {
      default: tg.default,
      bots: Object.entries(tg.bots).map(([name, b]) => ({
        name,
        default: name === tg.default,
        token: isReference(b.token) ? b.token : null,
        bot_id: isReference(b.token) ? null : botId(b.token),
        allow: b.allow ?? [],
        poll_every: b.poll_every ?? null,
        api: b.api ?? null,
      })),
    },
  };
}

/** Add or change a bot. Keys left out keep their value; `token` is required for a new bot. */
export function saveBot(home: string, name: string, body: Record<string, unknown>) {
  const unknown = Object.keys(body).filter((k) => !KEYS.includes(k));
  if (unknown.length) throw bad(`unknown key(s) ${unknown.join(", ")}`, `this request takes ${KEYS.join(", ")}`);
  const file = read(home);
  const tg = file.telegram;
  const before = tg.bots[name];
  const to = body.rename === undefined || body.rename === null ? name : String(body.rename);
  if (!BOT_NAME.test(to)) throw bad(`bot name '${to}' is not valid`, "use lowercase letters, digits, '-' or '_'");
  if (to !== name && tg.bots[to]) throw bad(`there is already a bot named '${to}'`, "pick another name");
  const next: Record<string, unknown> = { ...(before ?? {}) };
  for (const k of ["token", "allow", "poll_every", "api"]) {
    const v = body[k];
    if (v === undefined) continue;
    if (v === null || v === "") delete next[k];
    else next[k] = typeof v === "string" ? v.trim() : v;
  }
  const problems = botProblems(to, next);
  if (problems.length) throw bad(problems.join("; "), "fix the fields named and save again");
  delete tg.bots[name];
  tg.bots[to] = next as unknown as BotConfig;
  if (tg.default === name || body.default === true || !tg.default) tg.default = to;
  writeBots(home, file);
  return listBots(home);
}

export function deleteBot(home: string, name: string) {
  const file = read(home);
  const tg = file.telegram;
  if (!tg.bots[name])
    throw new HttpError(404, `no telegram bot named '${name}'`, "GET /api/bots lists them", "not_found");
  delete tg.bots[name];
  if (tg.default === name) tg.default = Object.keys(tg.bots)[0] ?? null;
  writeBots(home, file);
  return listBots(home);
}

/** Ask Telegram who the bot is (getMe): proves the token works. */
export async function testBot(home: string, name: string) {
  const b = read(home).telegram.bots[name];
  if (!b) throw new HttpError(404, `no telegram bot named '${name}'`, "GET /api/bots lists them", "not_found");
  let token = b.token;
  try {
    if (isReference(token)) token = await defaultResolver(token);
    const me = (await telegramCall(
      { name, token, api: (b.api ?? TELEGRAM_API).replace(/\/+$/, ""), allow: [] },
      "getMe",
      {},
    )) as {
      id: number;
      username?: string;
      first_name?: string;
    };
    return { ok: true, id: me.id, username: me.username ?? null, name: me.first_name ?? null };
  } catch (e) {
    // Never echo the token, even inside a message from fetch.
    return { ok: false, error: (e as Error).message.split(token).join("***") };
  }
}
