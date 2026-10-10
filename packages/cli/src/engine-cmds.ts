// `pipo runners`, `pipo attach [name]` and `pipo engine start|stop|status` (docs/spec.md §6, §7.2, §7.5, D27, D30,
// D31, D35). `runners` and `engine status|stop` never start the engine; `attach` and `engine start` do. Without the
// engine, `runners` reads the registry and asks each runner's socket for `hello` itself.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ControlClient, type RegistryEntry } from "@pipo/runner";
import { parseDuration } from "@pipo/spec";
import { CliError } from "./errors";
import {
  Api,
  alive,
  COMMON,
  context,
  type EngineEntry,
  findEngine,
  needEngine,
  probe,
  readEntries,
  readJson,
  resolveHome,
  startEngine,
  usage,
} from "./lifecycle";
import { formatUptime } from "./status";
import { done, paint, spinner } from "./tty";

type RunnerState = "attached" | "detached" | "stale" | "unreachable";

interface RunnerRow {
  name: string;
  pid: number;
  port: number | null;
  version: number | null;
  state: RunnerState;
  detached: boolean;
  started_at: string;
  note: string | null;
}

/** The engine's API when one is up and serving, without starting one. */
async function liveApi(home: string, noEngine: boolean): Promise<Api | null> {
  if (noEngine) return null;
  const engine = findEngine(home);
  return engine && (await probe(engine)) === "ready" ? new Api(engine.port) : null;
}

/** A live runner is reachable when `hello` on its socket names the same pipeline and pid (D27). */
async function handshake(e: RegistryEntry): Promise<{ version: number } | string> {
  if (!e.socket) return "its registry entry has no control socket";
  let client: ControlClient | undefined;
  try {
    client = await ControlClient.connect(e.socket, { connectTimeoutMs: 2000 });
    const hello = await client.request("hello", {}, 3000);
    if (hello.pipeline !== e.pipeline || hello.pid !== e.pid) {
      return `the socket answers for '${hello.pipeline}' (pid ${hello.pid}), not '${e.pipeline}' (pid ${e.pid})`;
    }
    return { version: hello.version };
  } catch (err) {
    return (err as Error).message;
  } finally {
    client?.close();
  }
}

async function collectRunners(home: string, api: Api | null): Promise<RunnerRow[]> {
  const supervised = new Map<string, { pid: number | null; state: string }>();
  if (api) {
    for (const p of (await api.call("GET", "/api/pipelines")).pipelines as any[]) supervised.set(p.name, p);
  }
  const rows: RunnerRow[] = [];
  for (const e of readEntries(home).sort((a, b) => a.pipeline.localeCompare(b.pipeline))) {
    const base = {
      name: e.pipeline,
      pid: e.pid,
      port: e.listen ?? null,
      version: e.version ?? null,
      detached: e.detached === true,
      started_at: e.started_at,
    };
    if (!alive(e)) {
      rows.push({
        ...base,
        state: "stale",
        note: `pid ${e.pid} is gone: 'pipo attach ${e.pipeline}' restarts it, or cleans the entry`,
      });
      continue;
    }
    const hello = await handshake(e);
    if (typeof hello === "string") {
      rows.push({
        ...base,
        state: "unreachable",
        note: `${hello}; left alone: 'pipo attach ${e.pipeline}' tries again`,
      });
      continue;
    }
    const s = supervised.get(e.pipeline);
    const attached = s !== undefined && s.pid === e.pid && s.state !== "unreachable";
    rows.push({
      ...base,
      version: hello.version,
      state: attached ? "attached" : "detached",
      note: attached ? null : api ? `not supervised by the engine: 'pipo attach ${e.pipeline}' adopts it` : null,
    });
  }
  return rows;
}

function table(headers: string[], right: Set<number>, cells: string[][], notes: (string | null)[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const total = widths.reduce((a, b) => a + b + 2, -2);
  const line = (c: string[], note: string | null) => {
    const text = c.map((v, i) => (right.has(i) ? v.padStart(widths[i]!) : v.padEnd(widths[i]!))).join("  ");
    return note ? `${text.padEnd(total)}   ⚠ ${note}` : text.trimEnd();
  };
  return [line(headers, null), ...cells.map((c, i) => line(c, notes[i]!))].join("\n");
}

export function renderRunners(rows: RunnerRow[]): string {
  if (!rows.length) return "no runners found";
  const cells = rows.map((r) => [
    r.name,
    String(r.pid),
    r.port === null ? "-" : String(r.port),
    r.version === null ? "-" : `v${r.version}`,
    r.state,
  ]);
  // The state is the last column, so a note after it lines up.
  return table(
    ["NAME", "PID", "PORT", "VERSION", "STATE"],
    new Set([1, 2, 3]),
    cells,
    rows.map((r) => r.note),
  );
}

export async function cmdRunners(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: COMMON });
  const home = resolveHome(values.home);
  const api = await liveApi(home, values["no-engine"] === true);
  const rows = await collectRunners(home, api);
  if (values.json) console.log(JSON.stringify({ ok: true, engine: api ? "up" : "down", runners: rows }, null, 2));
  else console.log(`${renderRunners(rows)}${api ? "" : "\nengine: down"}`);
  return 0;
}

export async function cmdAttach(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: COMMON });
  if (positionals.length > 1) return usage("pipo attach [name]");
  const name = positionals[0];
  const ctx = await context(values);
  const api = needEngine(ctx, "attach runners");
  const { results } = (await api.call("POST", "/api/attach", name === undefined ? {} : { name })) as {
    results: { name: string; outcome: string; pid: number | null; message: string; hint?: string }[];
  };
  const failed = results.some((r) => r.outcome === "failed");
  if (ctx.json) console.log(JSON.stringify({ ok: !failed, engine: "up", results }, null, 2));
  else if (!results.length) console.log(`nothing to attach: no runners are registered under ${join(ctx.home, "run")}`);
  else {
    const w = Math.max(...results.map((r) => r.name.length));
    const o = Math.max(...results.map((r) => r.outcome.length));
    for (const r of results) {
      console.log(`${r.name.padEnd(w)}  ${r.outcome.padEnd(o)}  ${r.message}`);
      if (r.hint) console.log(`${" ".repeat(w + o + 4)}hint: ${r.hint}`);
    }
  }
  return failed ? 1 : 0;
}

// ---- engine ----

const ENGINE_STOP_TIMEOUT = 40_000;

export async function cmdEngine(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "start":
      return engineStart(rest);
    case "stop":
      return engineStop(rest);
    case "status":
      return engineStatus(rest);
    default:
      return usage("pipo engine start|stop|status [--ttl 8h] [--listen <port>]");
  }
}

const readEngineEntry = (home: string): EngineEntry | null => {
  const e = readJson<EngineEntry>(join(home, "run", "engine.json"));
  return e && alive(e) ? e : null;
};

async function engineStart(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...COMMON, ttl: { type: "string" }, listen: { type: "string" } },
  });
  if (positionals.length) return usage("pipo engine start [--ttl 8h] [--listen <port>]");
  const home = resolveHome(values.home);
  let ttlMs: number | undefined;
  if (values.ttl !== undefined) {
    try {
      ttlMs = parseDuration(values.ttl);
    } catch {}
    if (!(ttlMs !== undefined && ttlMs >= 1)) {
      throw new CliError(`--ttl '${values.ttl}' is not a duration`, "use for example 30m, 8h or 2d", "bad_request");
    }
  }
  let listen: number | undefined;
  if (values.listen !== undefined) {
    listen = /^\d+$/.test(values.listen) ? Number(values.listen) : Number.NaN;
    if (!(listen >= 0 && listen <= 65535)) {
      throw new CliError(
        `--listen '${values.listen}' is not a port`,
        "use 0 to pick a free port, or 1 to 65535",
        "bad_request",
      );
    }
  }
  const running = readEngineEntry(home);
  if (running) {
    const note =
      values.ttl !== undefined || listen !== undefined
        ? "; --ttl and --listen apply to a new engine only: stop it first"
        : "";
    return report(values.json === true, home, "already running", running, note);
  }
  const why = await startEngine(home, { ttl: values.ttl, listen });
  if (why)
    throw new CliError(
      `cannot start the engine: ${why}`,
      "fix that, then run 'pipo engine start' again",
      "engine_down",
    );
  return report(values.json === true, home, "started", readEngineEntry(home));
}

function report(json: boolean, home: string, what: string, e: EngineEntry | null, note = ""): number {
  if (json)
    console.log(
      JSON.stringify({
        ok: true,
        engine: "up",
        result: what.replace(" ", "_"),
        pid: e?.pid ?? null,
        listen: e?.listen ?? null,
        home,
      }),
    );
  else {
    const p = paint(process.stdout);
    console.log(
      done(
        `engine ${what} ${p.dim(`(pid ${e?.pid ?? "?"}${e?.listen ? `, gateway 127.0.0.1:${e.listen}` : ", no gateway"})`)}${note}`,
      ),
    );
  }
  return 0;
}

async function engineStop(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: COMMON });
  if (positionals.length) return usage("pipo engine stop");
  const home = resolveHome(values.home);
  const entry = readEngineEntry(home);
  if (!entry) {
    if (values.json) console.log(JSON.stringify({ ok: true, engine: "down", stopped: false }));
    else console.log("engine: down (it was not running)");
    return 0;
  }
  process.kill(entry.pid, "SIGTERM");
  const deadline = Date.now() + ENGINE_STOP_TIMEOUT;
  const gone = () => {
    const now = readJson<EngineEntry>(join(home, "run", "engine.json"));
    return !now || now.pid !== entry.pid || !alive(entry);
  };
  const spin = spinner(`stopping the engine (pid ${entry.pid}): draining its pipelines`);
  try {
    while (!gone() && Date.now() < deadline) await Bun.sleep(100);
  } finally {
    spin.stop();
  }
  if (!gone()) {
    throw new CliError(
      `the engine (pid ${entry.pid}) did not stop within ${ENGINE_STOP_TIMEOUT / 1000}s`,
      `it drains its pipelines first (see ${join(home, "logs", "engine.log")}); send SIGTERM again to stop them at once`,
      "timeout",
    );
  }
  const note = "pipelines were drained; detached runners keep running (check 'pipo runners')";
  if (values.json) console.log(JSON.stringify({ ok: true, engine: "down", stopped: true, pid: entry.pid, note }));
  else console.log(done(`engine stopped ${paint(process.stdout).dim(`(pid ${entry.pid})`)}; ${note}`));
  return 0;
}

async function engineStatus(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: COMMON });
  if (positionals.length) return usage("pipo engine status");
  const home = resolveHome(values.home);
  const entry = readEngineEntry(home);
  const p = paint(process.stdout);
  const down = () => {
    if (values.json) console.log(JSON.stringify({ ok: true, engine: "down" }));
    else console.log(p.dim("engine: down"));
    return 0;
  };
  if (!entry) return down();
  if (!entry.listen) {
    const msg = `engine: up (pid ${entry.pid}), no gateway`;
    if (values.json)
      console.log(JSON.stringify({ ok: true, engine: "up", pid: entry.pid, listen: null, gateway: false }));
    else
      console.log(`${msg}\nhint: restart it with engine.listen set in config.yaml, or 'pipo engine start --listen 0'`);
    return 0;
  }
  let info: any;
  try {
    const res = await fetch(`http://127.0.0.1:${entry.listen}/api/engine`, { signal: AbortSignal.timeout(3000) });
    info = await res.json();
  } catch (e) {
    throw new CliError(
      `the engine (pid ${entry.pid}) does not answer on port ${entry.listen}: ${(e as Error).message}`,
      `retry; see ${join(home, "logs", "engine.log")}`,
      "unavailable",
    );
  }
  const uptime = Math.max(0, Math.floor((Date.now() - Date.parse(info.started_at)) / 1000));
  const phase = info.stopping ? "stopping" : info.ready ? "ready" : "starting";
  if (values.json) {
    console.log(
      JSON.stringify({
        ok: true,
        engine: "up",
        pid: info.pid,
        listen: info.listen,
        state: phase,
        started_at: info.started_at,
        uptime,
        ttl_expires_at: info.ttl_expires_at ?? null,
        idle: info.idle ?? null,
        pipelines: info.pipelines ?? null,
        home: info.home,
      }),
    );
    return 0;
  }
  const tint = phase === "ready" ? p.green : p.yellow;
  console.log(
    [
      `engine: ${tint(`up (${phase})`)}`,
      p.dim(`pid ${info.pid} · gateway 127.0.0.1:${info.listen} · uptime ${formatUptime(uptime)}`),
      p.dim(
        `pipelines ${info.pipelines ?? "-"} · idle ${info.idle === undefined ? "-" : info.idle ? "yes" : "no"} · ttl ${info.ttl_expires_at ? `expires ${info.ttl_expires_at}` : "none"}`,
      ),
    ].join("\n"),
  );
  return 0;
}
