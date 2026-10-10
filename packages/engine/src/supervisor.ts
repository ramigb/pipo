// Engine supervisor (docs/spec.md §7.1, §7.2, §7.5, D25, D27, D28, D30, D31, D57): the API the gateway, MCP and
// pipod use (start, stop, drain, pause, resume, request, attach, list, shutdown), and the engine's own lifetime.
// The work is split by concern under supervisor/: base.ts (supervised pipelines and the journal event stream),
// processes.ts (launching runners, restarts with backoff, stopping, port checks), discovery.ts (reattach to the
// runners in `<home>/run`), types.ts and util.ts.
// With `engine.listen` set, the gateway (gateway.ts, D28) binds right after engine.json is claimed and serves the API
// once discovery is done; its real port goes into engine.json. It closes last on shutdown.
// Detached runners (§7.2, D30) run in their own session, so they outlive the engine (even a SIGKILL); shutdown leaves
// them running and the next engine adopts them. Lifetime and stall detection stay in the runner in every mode.
// Engine lifetime (§7.5, D31): with nothing live for `engine.idle` the engine sleeps, and when `engine.ttl` (counted
// from its start) expires it drains its pipelines and stops; both end with shutdown() and then `onEnd`.
// A start's `ttl` override (D57) goes to the runner as `--ttl` and into its registry entry; crash restarts, adoption
// and discovery restarts take it from there, so it holds until the next deliberate start.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { entryAlive, procStart, readRegistryEntry, ulid } from "@pipo/runner";
import { formatDuration, inputsOf, type Pipeline, parseDuration } from "@pipo/spec";
import { type EngineConfig, loadConfig } from "./config";
import { EngineError } from "./errors";
import type { EngineEvent } from "./events";
import { Gateway } from "./gateway";
import { logPath, resolveHome } from "./home";
import { claimEngineEntry, releaseEngineEntry, updateEngineEntry } from "./registry";
import { checkWorkspace, saveWorkspace } from "./settings";
import { SupervisorDiscovery } from "./supervisor/discovery";
import {
  type AttachResult,
  type EndReason,
  LIVE,
  type RunnerInfo,
  type ShutdownOptions,
  type StartOptions,
  type StopOptions,
  type Supervised,
  type SupervisorOptions,
} from "./supervisor/types";
import { call, DEFAULT_DRAIN, inspect } from "./supervisor/util";

export type {
  AttachOutcome,
  AttachResult,
  EndReason,
  ExitInfo,
  RunnerInfo,
  ShutdownOptions,
  StartOptions,
  StopOptions,
  SupervisedState,
  SupervisorOptions,
} from "./supervisor/types";

/** How often adopted runners are checked for exit and running ones asked for new events. */
const POLL_MS = 500;

export class Supervisor extends SupervisorDiscovery {
  private scanning?: Promise<void>;
  private poller?: ReturnType<typeof setInterval>;
  /** Discovery is done: the idle clock and the TTL apply from here. */
  private ready = false;
  /** Scans (attach) under way: the engine is not idle while one may adopt or restart a runner. */
  private scans = 0;
  /** Open dashboards and event streams (hold()): the engine doesn't sleep while one is connected (D61). */
  private holds = 0;
  /** The last moment the engine had something to do, or was asked for something (touch()). */
  private lastBusy = Date.now();
  /** Set when the engine ends itself (idle sleep or TTL); shutdown then forgets the pipelines it gave up on. */
  private endReason?: EndReason;

  private constructor(
    home: string,
    config: EngineConfig,
    engineId: string,
    startedAt: string,
    opts: SupervisorOptions,
  ) {
    super(home, config, engineId, startedAt, opts);
  }

  /**
   * Load config, claim `<home>/run/engine.json`, then discover the runners already registered (attach()).
   * Rejects with EngineError (`config`, `conflict`) before touching any runner.
   */
  static async open(opts: SupervisorOptions = {}): Promise<Supervisor> {
    const home = resolveHome(opts.home);
    const config = opts.config ?? loadConfig(home);
    const engineId = `e_${ulid()}`;
    const startedAt = new Date().toISOString();
    // The claim comes first: a second engine on this home must never touch its runners (nor fight for its port).
    claimEngineEntry({
      engine_id: engineId,
      pid: process.pid,
      started_at: startedAt,
      home,
      listen: config.listen,
      proc_start: procStart(),
    });
    const engine = new Supervisor(home, config, engineId, startedAt, opts);
    if (config.listen !== null) {
      // Bound before discovery, so its event ring sees the replays; it answers 503 until markReady().
      try {
        engine.gateway = new Gateway(engine, config.listen);
        updateEngineEntry(home, engineId, { listen: engine.gateway.port });
      } catch (e) {
        await engine.gateway?.stop();
        releaseEngineEntry(home, engineId);
        throw e;
      }
      engine.log("info", `gateway listening on ${engine.gateway.url} (/in, /api, /events)`);
    }
    engine.poller = setInterval(() => engine.tick(), opts.pollMs ?? POLL_MS);
    engine.poller.unref?.();
    try {
      const found = await engine.attach();
      const counts = new Map<string, number>();
      for (const r of found) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
      if (found.length)
        engine.log("info", `discovery: ${[...counts].map(([k, n]) => `${n} ${k}`).join(", ")} (from ${home}/run)`);
    } catch (e) {
      engine.log("error", `discovery failed: ${(e as Error).message}; run pipo attach to try again`);
    }
    engine.gateway?.markReady();
    engine.ready = true;
    engine.lastBusy = Date.now();
    return engine;
  }

  /**
   * Scan the registry again and reattach (§7.2, `pipo attach [name]`): adopt live runners that answer `hello`,
   * leave live ones that don't as `unreachable`, restart pipelines whose runner died without a clean stop, and
   * remove stale entries. Without a name, every registry entry is checked. Scans run one at a time.
   */
  attach(name?: string): Promise<AttachResult[]> {
    if (this.closing)
      return Promise.reject(new EngineError("invalid_state", "the engine is shutting down", "start it again later"));
    this.scans++;
    const run = (this.scanning ?? Promise.resolve()).then(() => this.scanNow(name));
    void run.then(
      () => this.scans--,
      () => this.scans--,
    );
    this.scanning = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** attach() for every registry entry. */
  scan(): Promise<AttachResult[]> {
    return this.attach();
  }

  /** Receive every journal event of every supervised pipeline, in seq order per pipeline. Returns unsubscribe. */
  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Receive every pipeline state change (RunnerInfo), as `onChange` does. Returns unsubscribe. */
  onState(listener: (info: RunnerInfo) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** The last journal seq streamed for `name` (persisted in `<home>/engine/cursors/<name>.json`). */
  eventCursor(name: string): number {
    return this.feed(name).cursor;
  }

  /**
   * Start the pipeline in `file` (or a pipeline this engine knows, by name) and wait until its runner
   * answers `hello`. Throws EngineError when the file fails `pipo check`, the pipeline already runs, or the runner
   * does not come up (the message carries the end of its log).
   */
  async start(fileOrName: string, opts: StartOptions = {}): Promise<RunnerInfo> {
    if (this.closing) throw new EngineError("invalid_state", "the engine is shutting down", "start it again later");
    const ttl = opts.ttl === undefined ? undefined : startTtl(opts.ttl);
    let file = resolve(fileOrName);
    const known = this.entries.get(fileOrName);
    if (!existsSync(file) && known?.file) file = known.file;
    if (!existsSync(file)) {
      throw new EngineError(
        "not_found",
        `no pipeline file at ${file}`,
        "pass the path to a .pipo file, or the name of a pipeline this engine knows",
      );
    }
    const pipeline = inspect(file);
    const name = pipeline.name;
    if (name === "engine") {
      throw new EngineError(
        "invalid_pipeline",
        "a pipeline can't be named 'engine': run/engine.json is the engine's own registry entry",
        "rename the pipeline (the `name:` key)",
      );
    }
    const existing = this.entries.get(name);
    if (existing && LIVE.includes(existing.state)) {
      throw new EngineError(
        "invalid_state",
        `'${name}' is already ${existing.state}`,
        `stop it first (pipo stop ${name})`,
      );
    }
    const reg = readRegistryEntry(this.home, name);
    if (reg && entryAlive(reg)) {
      const by = reg.engine_id ? `started by engine ${reg.engine_id}` : "started outside the engine";
      throw new EngineError(
        "conflict",
        `'${name}' is already running (pid ${reg.pid}, ${by})`,
        `supervise that runner with pipo attach ${name}, or stop it first (SIGTERM drains it)`,
      );
    }
    const inputs = inputsOf(pipeline);
    const http = inputs.some(([, i]) => i.via === "http");
    if (opts.listen !== undefined && !http) {
      const what = inputs.length === 1 ? `a ${inputs[0]?.[1].via} input` : "no http input";
      throw new EngineError(
        "invalid_pipeline",
        `'${name}' has ${what}: a listen port only applies to an http input`,
        "start it without --listen",
      );
    }
    // Options given before (to this engine) stick until given again: the port and detached mode are "saved" (D30).
    const listen = this.httpPort(pipeline, opts.listen ?? (http ? existing?.opts.listen : undefined));
    const detached = opts.detached ?? existing?.opts.detached ?? this.config.detached;
    // The ttl override is for this start only (D57): never taken from an earlier one.
    const s = this.supervised(
      name,
      file,
      { listen, detached, ...(ttl !== undefined && { ttl }) },
      parseDuration(pipeline.lifetime?.drain_timeout ?? DEFAULT_DRAIN),
    );
    this.entries.set(name, s);
    try {
      await this.boot(s, http ? (listen ?? declaredPort(pipeline)) : undefined);
    } catch (e) {
      if (s.refused) {
        // Refused before any process started: leave no trace of the attempt.
        if (existing) this.entries.set(name, existing);
        else this.entries.delete(name);
        throw e;
      }
      if (s.wanted === "stop") this.markStopped(s);
      else {
        s.state = "failed";
        s.error = { message: (e as Error).message, hint: (e as EngineError).hint ?? `see ${logPath(this.home, name)}` };
        this.changed(s);
      }
      throw e;
    }
    return this.info(s);
  }

  /** Stop a pipeline: drain it (or stop at once with `now`) and wait for its runner to exit. It is not restarted. */
  async stop(name: string, opts: StopOptions = {}): Promise<RunnerInfo> {
    const s = this.need(name);
    if (s.state === "unreachable") {
      throw new EngineError(
        "invalid_state",
        `cannot stop '${name}': its runner (pid ${s.registry?.pid}) does not answer the engine`,
        s.error?.hint ?? `pipo attach ${name}`,
      );
    }
    s.wanted = "stop";
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = undefined;
      s.nextRestartAt = undefined;
    }
    if (s.launching) await s.launching.catch(() => {});
    if (s.proc || s.adopted) await this.halt(s, opts.now ?? false, true);
    else if (LIVE.includes(s.state) || s.state === "crashed") {
      // No runner (in restart backoff, or the engine gave up on it): stopping settles it all the same (D46).
      s.error = null;
      this.markStopped(s);
    }
    // Stopped stays stopped (D27): a crashed runner in backoff, or one killed after stop_timeout, left its entry.
    if (s.state === "stopped") await this.forgetDead(s);
    return this.info(s);
  }

  /** Ask the runner to drain: stop intake, finish in-flight packets, then exit. Returns once the runner agreed. */
  async drain(name: string): Promise<RunnerInfo> {
    const s = this.need(name);
    this.running(s, "drain");
    s.wanted = "stop";
    await this.halt(s, false, false);
    return this.info(s);
  }

  /** Pause processing (packets are still accepted into the journal). */
  pause(name: string, reason: "manual" | "agent" = "manual"): Promise<{ state: string; already: boolean }> {
    return this.request(name, "pause", { reason });
  }

  resume(name: string): Promise<{ state: string; already: boolean }> {
    return this.request(name, "resume");
  }

  /**
   * Send any control op (§7.2) to a running pipeline's runner: `status`, `push`, `ack`, `events`… Rejects with a
   * ControlError when the runner answers with an error. `stop` and `drain` go through stop() and drain().
   */
  async request<T = any>(name: string, op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (op === "stop" || op === "drain") {
      const info = op === "stop" ? await this.stop(name, { now: true }) : await this.drain(name);
      return info as T;
    }
    const s = this.need(name);
    const socket = this.running(s, op);
    return call<T>(socket, op, args, timeoutMs);
  }

  get(name: string): RunnerInfo | undefined {
    const s = this.entries.get(name);
    return s && this.info(s);
  }

  list(): RunnerInfo[] {
    return [...this.entries.values()].map((s) => this.info(s));
  }

  /**
   * Stop every pipeline (draining unless `now`), then release engine.json. Unreachable runners are left alone, and
   * so are detached ones unless `stopDetached` (D30): they keep running and the next engine adopts them.
   * A second call with `now` escalates.
   */
  shutdown(opts: ShutdownOptions = {}): Promise<void> {
    const leave = (s: Supervised) => !opts.stopDetached && this.detached(s);
    // A crashed pipeline has no runner to stop, and stays crashed: only an engine ending itself forgets it (D31).
    const ours = () =>
      [...this.entries.values()].filter((s) => s.state !== "unreachable" && s.state !== "crashed" && !leave(s));
    if (this.closing) {
      if (!opts.now) return this.closing;
      return Promise.all(ours().map((s) => this.stop(s.name, { now: true }).catch(() => {}))).then(() => this.closing);
    }
    this.closing = (async () => {
      await this.scanning;
      const left = [...this.entries.values()].filter((s) => s.state !== "unreachable" && leave(s));
      await Promise.all([
        ...ours().map((s) =>
          this.stop(s.name, opts).catch((e) => this.log("error", `stopping '${s.name}': ${(e as Error).message}`)),
        ),
        ...left.map((s) => this.release(s)),
      ]);
      clearInterval(this.poller);
      if (this.endReason) await this.forgetCrashed();
      // Let the last event fetches (the tails of the runners that just stopped) save their cursors.
      await Promise.race([Promise.all([...this.feeds.values()].map((f) => f.busy)), Bun.sleep(2000)]);
      // Last, so API callers and SSE clients see the pipelines stop.
      await this.gateway?.stop();
      releaseEngineEntry(this.home, this.engineId);
      this.log("info", "engine stopped");
    })();
    return this.closing;
  }

  /** True once shutdown began (a signal, the TTL, idle sleep, or a caller): starts and attaches are refused. */
  get stopping(): boolean {
    return this.closing !== undefined;
  }

  /** When `engine.ttl` expires (ms since the epoch), or null without a TTL (§7.5, D31). */
  get ttlEndsAt(): number | null {
    return this.config.ttl === null ? null : Date.parse(this.startedAt) + this.config.ttl;
  }

  /** Someone asked the engine for something (an API call): the idle clock starts again (D31). */
  touch(): void {
    this.lastBusy = Date.now();
  }

  /**
   * Someone is watching (an open `/events` stream, such as the dashboard): the engine doesn't sleep until every
   * hold is released (§7.5, D61). The TTL still applies. Returns the release, which is safe to call twice.
   */
  hold(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.lastBusy = Date.now();
    };
  }

  /** Chosen in the dashboard's settings (D72): wins over `--workspace` until the engine stops. */
  private chosenWorkspace?: string;

  /**
   * The folder the builder saves new pipelines in (§8, D61, D72): the one chosen in the dashboard, else `--workspace`,
   * else `engine.workspace` in config.yaml, else the engine's working directory.
   */
  get workspace(): string {
    return resolve(this.chosenWorkspace ?? this.opts.workspace ?? this.config.workspace ?? process.cwd());
  }

  /** Where `workspace` comes from, for the settings page. */
  get workspaceFrom(): "settings" | "flag" | "config" | "default" {
    if (this.chosenWorkspace) return "settings";
    if (this.opts.workspace) return "flag";
    return this.config.workspace ? "config" : "default";
  }

  /** Switch the builder to another folder now, and save it as `engine.workspace` for the next engine start (D72). */
  setWorkspace(path: unknown, create = false): string {
    const dir = checkWorkspace(path, create);
    saveWorkspace(this.home, dir);
    this.config.workspace = dir;
    this.chosenWorkspace = dir;
    this.log("info", `workspace is now ${dir} (saved as engine.workspace in config.yaml)`);
    return dir;
  }

  /**
   * Whether the engine has work (§7.5): a pipeline whose runner is starting, running (active, paused, draining or
   * jammed, so any pending packets have a runner), restarting after a crash or stopping, or a live runner it can't
   * see into (unreachable), a scan under way, or an open event stream (hold()). Stopped, failed and crashed
   * pipelines have no runner to keep up.
   */
  private busy(): boolean {
    if (this.scans > 0 || this.holds > 0) return true;
    for (const s of this.entries.values()) {
      if (s.released) continue;
      if (LIVE.includes(s.state) || s.state === "unreachable") return true;
    }
    return false;
  }

  /** Each poll: sleep after `engine.idle` with nothing to do, or end when `engine.ttl` expired (D31). */
  private lifetime(now: number) {
    if (!this.ready || this.closing) return;
    const ttlEnd = this.ttlEndsAt;
    if (ttlEnd !== null && now >= ttlEnd) {
      this.log(
        "info",
        `engine.ttl (${formatDuration(this.config.ttl as number)}) expired: draining every pipeline, then stopping (detached runners keep running)`,
      );
      return this.end("ttl");
    }
    if (this.busy()) {
      this.lastBusy = now;
      return;
    }
    if (now - this.lastBusy >= this.config.idle) {
      this.log(
        "info",
        `nothing to do for ${formatDuration(this.config.idle)} (every pipeline is stopped or completed): sleeping; the next pipo command starts the engine again`,
      );
      this.end("idle");
    }
  }

  /**
   * Hand over to a fresh engine (§8, D65), for code that changed on disk since this one started (D64): spawn pipod
   * with `--after <this pid>`, so it waits for this process to exit and then comes up on the same port, home and
   * workspace, starting again the pipelines running here that aren't detached (detached runners are reattached as on
   * any start). Then end as on idle sleep: drain, release engine.json, exit. The new engine's output goes to
   * `<home>/logs/engine.log`.
   */
  restart(): { pid: number; listen: number | null; pipelines: string[] } {
    if (!this.ready || this.closing || this.endReason) {
      throw new EngineError(
        "invalid_state",
        "the engine is still starting or already shutting down",
        "wait a moment, then try again",
      );
    }
    const again = this.list().filter(
      (r) => !r.detached && (r.state === "running" || r.state === "starting" || r.state === "backoff"),
    );
    const listen = this.gateway?.port ?? null;
    const args = [
      new URL("./main.ts", import.meta.url).pathname,
      "--home",
      this.home,
      "--workspace",
      this.workspace,
      "--after",
      String(process.pid),
      ...(listen === null ? [] : ["--listen", String(listen)]),
      ...again.map((r) => r.file),
    ];
    mkdirSync(join(this.home, "logs"), { recursive: true });
    const log = openSync(join(this.home, "logs", "engine.log"), "a");
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", log, log] });
      child.unref();
    } finally {
      closeSync(log);
    }
    this.log(
      "info",
      `restarting: the new engine (pid ${child.pid}) takes over once this one has drained${again.length ? `, and starts ${again.map((r) => r.name).join(", ")} again` : ""}`,
    );
    // Let the API answer first.
    setTimeout(() => this.end("restart"), 300);
    return { pid: child.pid as number, listen, pipelines: again.map((r) => r.name) };
  }

  /**
   * Stop as on SIGTERM, once the API has answered (`POST /api/engine/stop`): pipelines drain, detached runners keep
   * running (D30), and crashed pipelines are remembered, since the engine didn't give up on its own.
   */
  stopOnRequest(): { pipelines: string[]; detached: string[] } {
    const live = this.list().filter((r) => LIVE.includes(r.state));
    if (!this.closing) setTimeout(() => void this.shutdown().then(() => this.opts.onEnd?.("stop")), 300);
    this.log("info", "stopping: asked over the API");
    return {
      pipelines: live.filter((r) => !r.detached).map((r) => r.name),
      detached: live.filter((r) => r.detached).map((r) => r.name),
    };
  }

  private end(reason: EndReason) {
    this.endReason = reason;
    void this.shutdown().then(() => this.opts.onEnd?.(reason));
  }

  /**
   * The engine ends itself: pipelines it marked `crashed` gave up for good, so their registry entries (still naming
   * the dead runner) are removed. Otherwise the next engine, started by any pipo command, would restart them (D27).
   */
  private async forgetCrashed() {
    for (const s of this.entries.values()) {
      if (s.state !== "crashed") continue;
      const entry = readRegistryEntry(this.home, s.name);
      if (!entry || entryAlive(entry)) continue;
      await this.removeStale(entry);
      this.note(s, `engine ${this.engineId} ended (${this.endReason}); '${s.name}' stays crashed until started again`);
    }
  }

  /** Detached: started so (or adopted with a registry entry saying so). */
  private detached(s: Supervised): boolean {
    return s.opts.detached ?? s.registry?.detached ?? false;
  }

  /**
   * Shutdown leaves a detached runner running (D30): let a launch under way finish, cancel a pending restart (its
   * registry entry stays, so the next engine restarts it), and stop following the process.
   */
  private async release(s: Supervised) {
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = undefined;
      s.nextRestartAt = undefined;
    }
    if (s.launching) await s.launching.catch(() => {});
    s.released = true;
    s.proc?.unref();
    const pid = this.pidOf(s);
    if (!pid) return;
    this.log("info", `'${s.name}' left running (detached, pid ${pid}); the next engine reattaches it`);
    this.note(s, `engine ${this.engineId} shut down; runner pid ${pid} keeps running (detached)`);
  }

  /** Every poll: notice adopted runners that died, rescan unreachable ones that died, fetch new events. */
  private tick() {
    this.lifetime(Date.now());
    for (const s of this.entries.values()) {
      if (s.released) continue;
      const a = s.adopted;
      if (a && !a.gone && !entryAlive(a)) this.onAdoptedExit(s, a);
      else if (s.state === "unreachable" && s.registry && !s.rescan && !entryAlive(s.registry) && !this.closing) {
        s.rescan = true;
        void this.attach(s.name).catch(() => {});
      } else if ((s.state === "running" || s.state === "stopping") && s.registry?.socket) void this.pump(s);
    }
  }
}

/** Why `text` can't be a start's ttl override, or null: a positive duration such as `30m` (D57). */
function ttlProblem(text: string): string | null {
  let ms: number;
  try {
    ms = parseDuration(text);
  } catch {
    return `ttl '${text}' is not a duration`;
  }
  return ms >= 1 ? null : `ttl '${text}' must be longer than 0`;
}

/** A start's ttl override, checked (D57). */
function startTtl(text: string): string {
  const problem = typeof text === "string" ? ttlProblem(text) : "ttl must be a string";
  if (problem) throw new EngineError("bad_request", problem, "give a duration such as 30m, 8h or 2d");
  return text.trim();
}

/** An http input's `with.listen` when the file gives a literal port (an expression is only known once the runner renders it). */
function declaredPort(pipeline: Pipeline): number | undefined {
  for (const [, input] of inputsOf(pipeline)) {
    if (input.via !== "http") continue;
    const v = (input.with as { listen?: unknown } | undefined)?.listen;
    const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
    if (Number.isInteger(n) && (n as number) > 0) return n as number;
  }
  return undefined;
}
