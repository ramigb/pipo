// start, stop, pause, resume, restart, status and logs (docs/spec.md §6, §7.2), plus the engine and socket plumbing
// packets.ts shares. They talk to the engine's REST API (D28), starting the engine on demand; with --no-engine, or
// when the engine can't be reached or started, they talk to the runners' control sockets directly (D24) and mark the
// output `engine: down`. An engine that is going to sleep or reached its TTL (§7.5, D31) is waited out, and a new one
// started.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  ControlClient,
  ControlError,
  type EngineSpend,
  entryAlive,
  homeAgentBudget,
  type RegistryEntry,
  runnerBinary,
} from "@pipo/runner";
import { parseDuration } from "@pipo/spec";
import { parse as parseYaml } from "yaml";
import { CliError, cliHint, usageError } from "./errors";
import { renderAgentBudget, renderDetail, renderStatus, type StatusRow } from "./status";
import { done, flourish, say, spinner, spinning } from "./tty";

const ENGINE_MAIN = new URL("../../engine/src/main.ts", import.meta.url).pathname;
const ENGINE_START_TIMEOUT = 20_000;

export const resolveHome = (home?: string) => resolve(home ?? process.env.PIPO_HOME ?? join(homedir(), ".pipo"));
/** A registry entry's process is still running, and still that process (a reused pid is dead; D27). */
export const alive = entryAlive;
export const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
};

export interface EngineEntry {
  pid: number;
  listen: number | null;
  started_at?: string;
  proc_start?: number | null;
}

export interface Engine {
  port: number;
  pid: number;
}

/** The running engine with a gateway, from `<home>/run/engine.json`; null when absent, dead or without a gateway. */
export function findEngine(home: string): Engine | null {
  const e = readJson<EngineEntry>(join(home, "run", "engine.json"));
  return e && alive(e) && e.listen ? { port: e.listen, pid: e.pid } : null;
}

/** What the engine's `GET /api/engine` says: serving, still reattaching, or shutting down (asleep, TTL; D31). */
export async function probe(engine: Engine): Promise<"ready" | "starting" | "stopping" | "unreachable"> {
  try {
    const r = await fetch(`http://127.0.0.1:${engine.port}/api/engine`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return "unreachable";
    const body = (await r.json()) as { ready?: boolean; stopping?: boolean };
    return body.stopping ? "stopping" : body.ready === true ? "ready" : "starting";
  } catch {
    return "unreachable";
  }
}

/** `engine.listen` from config.yaml, or null when it isn't set (or the file can't be read: the engine says why). */
export function configuredListen(home: string): number | null {
  try {
    const listen = (parseYaml(readFileSync(join(home, "config.yaml"), "utf8")) as any)?.engine?.listen;
    return Number.isInteger(listen) ? listen : null;
  } catch {
    return null;
  }
}

/**
 * Start the engine detached, its output in `<home>/logs/engine.log`, with a gateway: `engine.listen` from config.yaml,
 * else `--listen 0` (a free port, recorded in run/engine.json). Returns null once it is up, or why it isn't.
 */
export async function startEngine(
  home: string,
  opts: { ttl?: string; listen?: number; workspace?: string } = {},
): Promise<string | null> {
  // A stale or missing runner is built here, in the terminal, rather than inside the engine (D73).
  runnerBinary();
  mkdirSync(join(home, "logs"), { recursive: true });
  const logFile = join(home, "logs", "engine.log");
  const offset = existsSync(logFile) ? statSync(logFile).size : 0;
  const args = [ENGINE_MAIN, "--home", home];
  if (opts.listen !== undefined) args.push("--listen", String(opts.listen));
  else if (configuredListen(home) === null) args.push("--listen", "0");
  if (opts.ttl !== undefined) args.push("--ttl", opts.ttl);
  if (opts.workspace !== undefined) args.push("--workspace", opts.workspace);
  const log = openSync(logFile, "a");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", log, log] });
    child.unref();
  } finally {
    closeSync(log);
  }
  const deadline = Date.now() + ENGINE_START_TIMEOUT;
  const spin = spinner("starting the engine");
  try {
    while (Date.now() < deadline) {
      const e = findEngine(home);
      const state = e ? await probe(e) : "unreachable";
      if (state === "ready") return null;
      if (e && state === "starting") spin.text(`the engine (pid ${e.pid}) is reattaching its runners`);
      // It exited: a bad config.yaml, a taken port, or another engine got the home first (that one is used then).
      if (child.exitCode !== null || child.signalCode !== null) {
        const other = findEngine(home);
        if (other && other.pid !== child.pid) return null;
        const said = logLines(logFile, offset);
        return `the engine exited (${child.exitCode ?? child.signalCode})${said ? `: ${said}` : ""} (see ${logFile})`;
      }
      await Bun.sleep(100);
    }
  } finally {
    spin.stop();
  }
  return `the engine did not come up within ${ENGINE_START_TIMEOUT / 1000}s (see ${logFile})`;
}

/** What a process wrote to `file` after `offset`, on one line (the reason an engine refused to start). */
function logLines(file: string, offset: number): string {
  try {
    return readFileSync(file).subarray(offset).toString("utf8").trim().split("\n").slice(-4).join(" ").trim();
  } catch {
    return "";
  }
}

export class Api {
  constructor(readonly port: number) {}
  async call<T = any>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      });
    } catch (e) {
      throw new CliError(`the engine did not answer: ${(e as Error).message}`, "retry, or pass --no-engine");
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      // An apply or rollback error already lists its diagnostics in the message (D60): don't print them twice.
      const extra = Array.isArray(data.diagnostics)
        ? data.diagnostics.filter((d: any) => !String(data.error ?? "").includes(String(d.message ?? d)))
        : [];
      const diag = extra.length ? `\n${extra.map((d: any) => `  ${d.message ?? d}`).join("\n")}` : "";
      const packet = typeof data.packet_id === "string" ? ` (packet ${data.packet_id})` : "";
      throw new CliError(
        `${data.error ?? `engine answered ${res.status}`}${packet}${diag}`,
        cliHint(data.hint),
        typeof data.code === "string" ? data.code : "error",
      );
    }
    return data as T;
  }
}

export interface Ctx {
  home: string;
  json: boolean;
  /** Null: the engine is down (or --no-engine). */
  api: Api | null;
  /** Why the engine is down, when it was wanted. */
  why?: string;
}

/**
 * The engine's API, starting the engine when none runs. One that is still reattaching is waited for; one that is
 * shutting down (it went to sleep, or its TTL expired; D31) is waited out and a new one started.
 */
export async function connect(home: string, noEngine: boolean, start: { workspace?: string } = {}): Promise<Ctx> {
  const json = false;
  if (noEngine) return { home, json, api: null };
  const deadline = Date.now() + ENGINE_START_TIMEOUT;
  let why: string | undefined;
  let started = false;
  const spin = spinner("connecting to the engine");
  try {
    for (;;) {
      const engine = findEngine(home);
      if (engine) {
        const state = await probe(engine);
        if (state === "ready") {
          spin.stop();
          if (started) flourish("ok", `started the engine (pid ${engine.pid}, gateway 127.0.0.1:${engine.port})`);
          return { home, json, api: new Api(engine.port) };
        }
        why =
          state === "stopping"
            ? `the engine (pid ${engine.pid}) is shutting down; try again once it stopped`
            : state === "starting"
              ? `the engine (pid ${engine.pid}) is still reattaching its runners`
              : `the engine (pid ${engine.pid}) does not answer on port ${engine.port}`;
        spin.text(state === "stopping" ? `the engine (pid ${engine.pid}) is shutting down; waiting it out` : why);
      } else {
        const entry = readJson<EngineEntry>(join(home, "run", "engine.json"));
        if (entry && alive(entry) && !entry.listen) {
          why = `the engine (pid ${entry.pid}) runs without a gateway, so the CLI can't reach it; restart it with engine.listen set in config.yaml, or pipod --listen 0`;
          break;
        }
        if (started) {
          why ??= "the engine is not reachable";
          break;
        }
        started = true;
        spin.stop(); // startEngine may build the runner first, with cargo's output on stderr
        why = (await startEngine(home, start)) ?? undefined;
        if (why) break;
        continue;
      }
      if (Date.now() >= deadline) break;
      await Bun.sleep(200);
    }
  } finally {
    spin.stop();
  }
  return { home, json, api: null, why: why ?? "the engine is not reachable" };
}

export const COMMON = {
  json: { type: "boolean" },
  home: { type: "string" },
  "no-engine": { type: "boolean" },
} as const;

export async function context(values: { home?: string; json?: boolean; "no-engine"?: boolean }): Promise<Ctx> {
  const ctx = await connect(resolveHome(values.home), values["no-engine"] === true);
  if (!ctx.api && ctx.why) say("warn", `${ctx.why}; talking to the runners directly (engine: down)`);
  return { ...ctx, json: values.json === true };
}

export function out(ctx: Ctx, data: Record<string, unknown>, text: string) {
  if (ctx.json) console.log(JSON.stringify({ ok: true, engine: ctx.api ? "up" : "down", ...data }, null, 2));
  else console.log(ctx.api ? text : `${text}\nengine: down`);
}

export const usage = usageError;

// ---- runners without the engine ----

export function readEntries(home: string): RegistryEntry[] {
  const dir = join(home, "run");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "engine.json")
    .map((f) => readJson<RegistryEntry>(join(dir, f)))
    .filter((e): e is RegistryEntry => e !== null && typeof e.pipeline === "string");
}

export async function direct<T>(home: string, name: string, op: (c: ControlClient) => Promise<T>): Promise<T> {
  const entry = readEntries(home).find((e) => e.pipeline === name);
  if (!entry) {
    throw new CliError(
      `no runner registered for '${name}' under ${join(home, "run")}`,
      "run 'pipo status --no-engine' to see the runners found, or start the pipeline with 'pipo start'",
    );
  }
  if (!alive(entry)) {
    throw new CliError(
      `the runner of '${name}' (pid ${entry.pid}) is not running`,
      "start it again with 'pipo start <file>'; its journal resumes the packets in flight",
    );
  }
  let client: ControlClient;
  try {
    client = await ControlClient.forPipeline(home, name);
  } catch (e) {
    throw new CliError(
      (e as Error).message,
      "the runner may be starting; retry, or run 'pipo attach' once the engine is up",
    );
  }
  try {
    return await op(client);
  } catch (e) {
    if (e instanceof ControlError) {
      throw new CliError(`${e.message}${e.packetId ? ` (packet ${e.packetId})` : ""}`, e.hint);
    }
    throw new CliError((e as Error).message, "the runner may be stopping; check 'pipo status --no-engine'");
  } finally {
    client.close();
  }
}

// ---- status ----

function rowFrom(name: string, state: string, version: number | null, status: any, error?: string | null): StatusRow {
  const s = status?.stats ?? {};
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const note =
    error ??
    (typeof status?.note === "string" ? status.note : null) ??
    (state === "jammed" ? "jammed: see 'pipo logs'" : null);
  return {
    name,
    state,
    version,
    uptime: num(s.uptime),
    in_per_min: num(s.in_per_min),
    pending: num(s.pending),
    delivered: num(s.delivered),
    dlq: num(s.dead_lettered),
    last_delivery_at: typeof s.last_delivery_at === "string" ? Date.parse(s.last_delivery_at) : num(s.last_delivery_at),
    note,
    // Built-in metrics (§7.6, D54); left undefined when the runner does not report them.
    ...("oldest_pending_age_ms" in s && {
      oldest_pending_ms: num(s.oldest_pending_age_ms),
      oldest_pending_received_at:
        typeof s.oldest_pending_received_at === "string" ? Date.parse(s.oldest_pending_received_at) : null,
    }),
    ...(s.latency &&
      typeof s.latency === "object" && { latency: s.latency, latency_window: num(s.latency_window) ?? undefined }),
    // Agent spend in the pipeline's own budget day (§3.11, D37).
    ...(typeof s.agent_spend_today === "number" && { agent_spend_today: s.agent_spend_today }),
    ...(typeof status?.budget_resumes_at === "string" && { budget_resumes_at: status.budget_resumes_at }),
  };
}

/**
 * Today's agent spend of every pipeline of the home vs `engine.agent_budget.per_day` (§3.11, D58): the engine's
 * `GET /api/agent-budget`, or the same sum read here from the journals when the engine is down (or predates it).
 */
async function agentBudget(ctx: Ctx): Promise<EngineSpend | null> {
  if (ctx.api) {
    const fromApi = await ctx.api.call<EngineSpend>("GET", "/api/agent-budget").catch(() => null);
    if (fromApi) return fromApi;
  }
  try {
    return homeAgentBudget(ctx.home);
  } catch {
    return null;
  }
}

async function collect(ctx: Ctx, only?: string): Promise<{ rows: StatusRow[]; raw: unknown[] }> {
  if (ctx.api) {
    const api = ctx.api;
    const list: any[] = (await api.call("GET", "/api/pipelines")).pipelines;
    const picked = only ? list.filter((p) => p.name === only) : list;
    if (only && !picked.length) throw unknownPipeline(only);
    const details = await Promise.all(
      picked.map((p) => (p.state === "running" ? api.call("GET", `/api/pipelines/${p.name}`).catch(() => p) : p)),
    );
    return {
      raw: details,
      rows: details.map((d) =>
        rowFrom(
          d.name,
          d.runner?.status ?? d.status ?? d.state,
          d.runner?.version ?? d.version,
          d.runner,
          d.error?.message,
        ),
      ),
    };
  }
  const entries = readEntries(ctx.home).filter((e) => !only || e.pipeline === only);
  if (only && !entries.length) throw unknownPipeline(only);
  const raw: unknown[] = [];
  const rows: StatusRow[] = [];
  for (const e of entries.sort((a, b) => a.pipeline.localeCompare(b.pipeline))) {
    if (!alive(e)) {
      raw.push({ ...e, state: "stale" });
      rows.push(rowFrom(e.pipeline, "stale", e.version, null, `runner pid ${e.pid} is gone`));
      continue;
    }
    try {
      const st = await direct(ctx.home, e.pipeline, (c) => c.request("status", {}, 3000));
      raw.push(st);
      rows.push(rowFrom(e.pipeline, st.status ?? st.state, st.version, st));
    } catch (err) {
      raw.push({ ...e, state: "unreachable" });
      rows.push(rowFrom(e.pipeline, "unreachable", e.version, null, (err as Error).message));
    }
  }
  return { rows, raw };
}

function unknownPipeline(name: string): CliError {
  return new CliError(`no pipeline named '${name}'`, "run 'pipo status' to list pipelines, or 'pipo start <file>'");
}

export async function cmdStatus(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...COMMON, watch: { type: "boolean" } },
  });
  const ctx = await context(values);
  const name = positionals[0];
  const show = async () => {
    const { rows, raw } = await collect(ctx, name);
    const budget = await agentBudget(ctx);
    if (ctx.json)
      console.log(JSON.stringify({ ok: true, engine: ctx.api ? "up" : "down", pipelines: raw, agent_budget: budget }));
    else {
      const detail = name && rows[0] ? renderDetail(rows[0]) : "";
      const spend = budget ? renderAgentBudget(budget) : "";
      console.log(
        `${renderStatus(rows)}${detail ? `\n\n${detail}` : ""}${spend ? `\n\n${spend}` : ""}${ctx.api ? "" : "\nengine: down"}`,
      );
    }
  };
  if (!values.watch) {
    await show();
    return 0;
  }
  for (;;) {
    if (!ctx.json) process.stdout.write("\x1b[2J\x1b[H");
    await show();
    await Bun.sleep(2000);
  }
}

// ---- start, stop, pause, resume, restart ----

const isFileArg = (a: string) => a.endsWith(".pipo") || a.includes("/") || existsSync(a);

function startBody(values: { ttl?: string; detached?: boolean; listen?: string }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (values.ttl !== undefined) {
    // Checked here too, so a bad --ttl never stops a pipeline that `restart` then can't start (D57).
    let ms = Number.NaN;
    try {
      ms = parseDuration(values.ttl);
    } catch {}
    if (!(ms >= 1)) {
      throw new CliError(`--ttl '${values.ttl}' is not a duration`, "use for example 30m, 8h or 2d", "bad_request");
    }
    body.ttl = values.ttl;
  }
  if (values.detached) body.detached = true;
  if (values.listen !== undefined) {
    const port = Number(values.listen);
    // The gateway's rule (gateway.ts startOptions): 0 would mean "any free port", which a pipeline listen can't.
    if (!/^\d+$/.test(values.listen)) {
      throw new CliError(`--listen '${values.listen}' is not a port`, "use a port from 1 to 65535", "bad_request");
    }
    if (port < 1 || port > 65535) {
      throw new CliError(`bad listen ${values.listen}`, "use a port from 1 to 65535", "bad_request");
    }
    body.listen = port;
  }
  return body;
}

export function needEngine(ctx: Ctx, what: string): Api {
  if (ctx.api) return ctx.api;
  throw new CliError(
    `cannot ${what} without the engine${ctx.why ? ` (${ctx.why})` : ""}`,
    "run 'pipo run <file>' for a foreground pipeline, or drop --no-engine and fix the engine (see <home>/logs/engine.log)",
  );
}

const START_OPTIONS = {
  ...COMMON,
  ttl: { type: "string" },
  detached: { type: "boolean" },
  listen: { type: "string" },
} as const;

async function doStart(ctx: Ctx, target: string, body: Record<string, unknown>) {
  const api = needEngine(ctx, "start a pipeline");
  runnerBinary(); // built here when stale, so the engine's start doesn't wait on cargo (D73)
  return spinning(`starting ${target}`, () =>
    isFileArg(target)
      ? api.call("POST", "/api/pipelines", { file: isAbsolute(target) ? target : resolve(target), ...body })
      : api.call("POST", `/api/pipelines/${encodeURIComponent(target)}/start`, body),
  );
}

export async function cmdStart(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: START_OPTIONS });
  const target = positionals[0];
  if (!target) return usage("pipo start <file|name> [--ttl 30m] [--detached] [--listen <port>]");
  const body = startBody(values);
  const ctx = await context(values);
  const r = await doStart(ctx, target, body);
  const info = r.pipeline ?? r;
  const name = info.name ?? target;
  out(ctx, { pipeline: name, result: r }, done(`started ${name}${info.pid ? ` (pid ${info.pid})` : ""}`));
  return 0;
}

export async function cmdStop(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...COMMON, now: { type: "boolean" } },
  });
  const name = positionals[0];
  if (!name) return usage("pipo stop <name> [--now]");
  const ctx = await context(values);
  const api = ctx.api;
  const r = await spinning(`${values.now ? "stopping" : "draining"} ${name}`, () =>
    api
      ? api.call("POST", `/api/pipelines/${encodeURIComponent(name)}/${values.now ? "stop" : "drain"}`, {})
      : direct(ctx.home, name, (c) => c.request(values.now ? "stop" : "drain")),
  );
  out(
    ctx,
    { pipeline: name, result: r },
    done(values.now ? `stopped ${name}` : `draining ${name}; it stops when its packets are done`),
  );
  return 0;
}

async function pauseResume(op: "pause" | "resume", args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: COMMON });
  const name = positionals[0];
  if (!name) return usage(`pipo ${op} <name>`);
  const ctx = await context(values);
  const api = ctx.api;
  const r = await spinning(`${op === "pause" ? "pausing" : "resuming"} ${name}`, () =>
    api
      ? api.call("POST", `/api/pipelines/${encodeURIComponent(name)}/${op}`, {})
      : direct(ctx.home, name, (c) => c.request(op)),
  );
  out(ctx, { pipeline: name, result: r }, done(`${op === "pause" ? "paused" : "resumed"} ${name}`));
  return 0;
}
export const cmdPause = (args: string[]) => pauseResume("pause", args);
export const cmdResume = (args: string[]) => pauseResume("resume", args);

export async function cmdRestart(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: START_OPTIONS });
  const name = positionals[0];
  if (!name) return usage("pipo restart <name> [--ttl 30m] [--detached] [--listen <port>]");
  const body = startBody(values);
  const ctx = await context(values);
  const api = needEngine(ctx, "restart a pipeline");
  const info = await api.call("GET", `/api/pipelines/${encodeURIComponent(name)}`);
  // A restart is a deliberate stop, then a start: the stop settles a crashed pipeline too and journals its end, so
  // the ttl anchor resets (§7.4, D46, D57). Stopped and failed (halted) pipelines have nothing to stop.
  if (info.state !== "stopped" && info.state !== "failed") {
    await spinning(`stopping ${name}`, () => api.call("POST", `/api/pipelines/${encodeURIComponent(name)}/stop`, {}));
  }
  const r = await doStart(ctx, name, body);
  out(ctx, { pipeline: name, result: r }, done(`restarted ${name}`));
  return 0;
}

// ---- logs ----

/** Lines that mention the node as a whole word (ids are letters, digits, `_` and `-`). */
export function nodeFilter(node: string | undefined): (line: string) => boolean {
  if (!node) return () => true;
  const esc = node.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^\\w-])${esc}($|[^\\w-])`);
  return (line) => re.test(line);
}

export async function cmdLogs(args: string[], signal?: AbortSignal): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      home: { type: "string" },
      "no-engine": { type: "boolean" },
      f: { type: "boolean", short: "f" },
      node: { type: "string" },
    },
  });
  const name = positionals[0];
  if (!name) return usage("pipo logs <name> [-f] [--node id]");
  const home = resolveHome(values.home);
  const engineDown = values["no-engine"] === true || !findEngine(home);
  const path = join(home, "logs", `${name}.log`);
  if (!existsSync(path)) {
    throw new CliError(
      `no log for '${name}' at ${path}`,
      "check the name with 'pipo status', or start the pipeline; 'pipo run' prints its log to the terminal instead",
    );
  }
  const keep = nodeFilter(values.node);
  let pos = 0;
  let partial = "";
  const emit = (chunk: string) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line || !keep(line)) continue;
      console.log(values.json ? JSON.stringify({ pipeline: name, engine: engineDown ? "down" : "up", line }) : line);
    }
  };
  const readNew = () => {
    const size = statSync(path).size;
    if (size < pos) pos = 0; // rotated or truncated
    if (size === pos) return;
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - pos);
      readSync(fd, buf, 0, buf.length, pos);
      pos = size;
      emit(buf.toString("utf8"));
    } finally {
      closeSync(fd);
    }
  };
  if (engineDown && !values.json) console.error("engine: down");
  readNew();
  while (values.f && !signal?.aborted) {
    await Bun.sleep(250);
    readNew();
  }
  return 0;
}
