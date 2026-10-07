#!/usr/bin/env bun
// pipod, the Pipo engine (docs/spec.md §7.1, §7.2, D25, D27). On start it reattaches every runner in <home>/run
// (restarting those that died while active), then supervises the pipelines it is given. With engine.listen set in
// config.yaml (or --listen) it serves the gateway on 127.0.0.1 (/in, /api, /events; D28). Detached runners
// (engine.detached, or `detached` in a start request; D30) run in their own session and outlive pipod.
// Lifetime (§7.5, D31): it sleeps (exits 0) after engine.idle with nothing to do, and when engine.ttl (or --ttl)
// expires it drains every pipeline that isn't detached and exits 0.
// SIGINT/SIGTERM drain every pipeline that isn't detached and exit; a second signal stops them at once.
// The dashboard builder saves new pipelines under --workspace (default: the working directory; §8, D61).
// --after <pid> (a restart from the dashboard, D65): wait for that engine to exit first, and keep running even when
// the pipelines it hands over fail to start again.
// Usage: pipod [--home <dir>] [--listen <port>] [--ttl <dur>] [--workspace <dir>] [file.pipo …]
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { formatDuration, parseDuration } from "@pipo/spec";
import { type EngineConfig, loadConfig } from "./config";
import { EngineError } from "./errors";
import { resolveHome } from "./home";
import { Supervisor } from "./supervisor";

const USAGE = "usage: pipod [--home <dir>] [--listen <port>] [--ttl <duration>] [--workspace <dir>] [file.pipo …]";
const HELP = `${USAGE}

Start the Pipo engine and the pipelines given, one runner process per pipeline.
Runners already registered in <home>/run are reattached first; one that died
while running is restarted, and its journal resumes the packets in flight.
Crashed runners restart with backoff (engine.restart in <home>/config.yaml).
With engine.listen set, the gateway serves /in/<pipeline>/…, /api and /events
on 127.0.0.1 (its port is in <home>/run/engine.json).
With engine.detached: true, runners keep running when pipod stops or dies;
the next pipod reattaches them. SIGINT/SIGTERM drain the other pipelines.
With every pipeline stopped or completed for engine.idle (default 5m), pipod
sleeps: it exits, and the next pipo command starts it again. When engine.ttl
expires, it drains every pipeline that isn't detached and exits.

  --home <dir>        Pipo home (default ~/.pipo, or PIPO_HOME)
  --listen <port>     gateway port on 127.0.0.1, 0 picks a free one (overrides engine.listen)
  --ttl <duration>    stop after this long, e.g. 8h (overrides engine.ttl)
  --workspace <dir>   where the dashboard saves new pipelines (default: the working directory)
  -h, --help          show this help`;

function report(e: unknown): void {
  if (!(e instanceof EngineError)) throw e;
  console.error(`pipod: ${e.message}`);
  if (e.hint) console.error(`  hint: ${e.hint.replaceAll("\n", "\n        ")}`);
}

function args() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        home: { type: "string" },
        listen: { type: "string" },
        ttl: { type: "string" },
        workspace: { type: "string" },
        after: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    console.error(`pipod: ${(e as Error).message}\n${USAGE}`);
    process.exit(2);
  }
}

const parsed = args();
if (parsed.values.help) {
  console.log(HELP);
  process.exit(0);
}

/** config.yaml, with the flags on top (they override it). Exits 2 on a bad flag or config. */
function configure(home: string): EngineConfig {
  const bad = (message: string) => {
    console.error(`pipod: ${message}\n${USAGE}`);
    process.exit(2);
  };
  let config: EngineConfig;
  try {
    config = loadConfig(home);
  } catch (e) {
    report(e);
    process.exit(2);
  }
  const { listen, ttl } = parsed.values;
  if (listen !== undefined) {
    const port = /^\d+$/.test(listen) ? Number(listen) : Number.NaN;
    if (!(port >= 0 && port <= 65535)) bad(`--listen '${listen}' is not a port (use 0–65535; 0 picks a free one)`);
    config.listen = port;
  }
  if (ttl !== undefined) {
    let ms = 0;
    try {
      ms = parseDuration(ttl);
    } catch {}
    if (!(ms >= 1)) bad(`--ttl '${ttl}' is not a duration (for example 30m, 8h, 2d)`);
    config.ttl = ms;
  }
  return config;
}

const home = resolveHome(parsed.values.home);
const config = configure(home);

// A restart (D65): the old engine drains first, which can take a while; its port and engine.json are free once it exits.
const after = parsed.values.after === undefined ? null : Number(parsed.values.after);
if (after !== null) {
  if (!Number.isInteger(after) || after <= 0) {
    console.error(`pipod: --after '${parsed.values.after}' is not a pid\n${USAGE}`);
    process.exit(2);
  }
  const alive = () => {
    try {
      process.kill(after, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const deadline = Date.now() + 15 * 60_000;
  console.log(`${new Date().toISOString()} INFO  [engine] waiting for engine pid ${after} to drain and exit`);
  while (alive()) {
    if (Date.now() > deadline) {
      console.error(`pipod: engine pid ${after} did not exit within 15 minutes; not starting a second one`);
      process.exit(1);
    }
    await Bun.sleep(200);
  }
}
let engine: Supervisor;
try {
  engine = await Supervisor.open({
    home,
    config,
    // Idle sleep or TTL (D31): shutdown already drained what had to drain and released run/engine.json.
    onEnd: () => process.exit(0),
    ...(parsed.values.workspace !== undefined && { workspace: resolve(parsed.values.workspace) }),
  });
} catch (e) {
  report(e);
  process.exit(2);
}

const say = (level: string, message: string) =>
  console.log(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [engine] ${message}`);
if (engine.ttlEndsAt !== null) {
  say(
    "info",
    `engine.ttl ${formatDuration(config.ttl as number)}: pipelines drain and the engine stops at ${new Date(engine.ttlEndsAt).toISOString()}`,
  );
}

let signals = 0;
const onSignal = () => {
  signals++;
  void engine.shutdown({ now: signals > 1 }).then(() => process.exit(0));
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

say("info", `engine ${engine.engineId} up (pid ${process.pid}, home ${engine.home})`);
let started = 0;
for (const file of parsed.positionals) {
  if (signals) break;
  try {
    await engine.start(file);
    started++;
  } catch (e) {
    // Reattached (or restarted) during discovery: it is running, which is what was asked for.
    const running = engine.list().find((r) => r.file === resolve(file) && r.state === "running");
    if (running) {
      say("info", `'${running.name}' is already running (pid ${running.pid}${running.adopted ? ", reattached" : ""})`);
      started++;
    } else report(e);
  }
}
if (parsed.positionals.length && !started && !signals && after === null) {
  await engine.shutdown({ now: true });
  process.exit(1);
}
// Stay up until signalled; the supervisor's timers and child processes do the work.
setInterval(() => {}, 1 << 30);
