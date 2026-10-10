// Runner processes (docs/spec.md §7.1, §7.2, D25, D27, D30, D46): one runner subprocess per pipeline, found through
// its registry entry and a `hello` on its control socket (never through stdout), logs appended to
// `<home>/logs/<name>.log`, crashed runners restarted with backoff until the restart policy gives up. The journal
// makes a restart safe: packets in flight resume where their last committed step left them (§7.3). An adopted runner
// is not a child, so its exit is found by polling its pid. Detached runners run in their own session (D30).
// An http input's port is checked before start; a taken one is refused naming its holder.
// A deliberate stop always settles to `stopped` (D27, D46), crashed or killed included: once no runner holds the
// journal, the engine journals the stop the runner could not write (the ttl anchor resets), then drops its entry.
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  ControlError,
  entryAlive,
  type Liveness,
  pidRunning,
  procStart,
  type RegistryEntry,
  readRegistryEntry,
  registryPath,
  runnerBinary,
  runnerEnv,
} from "@pipo/runner";
import { formatDuration, type Pipeline } from "@pipo/spec";
import { EngineError } from "../errors";
import { journalStop, lastEnd } from "../events";
import { journalPath, logPath } from "../home";
import { bindProblem, portHolder } from "../ports";
import { RestartTracker } from "../restart";
import { SupervisorBase } from "./base";
import { type Adopted, type ExitInfo, type Hello, LIVE, type StartOptions, type Supervised } from "./types";
import { call, handshake, registered } from "./util";

export abstract class SupervisorProcesses extends SupervisorBase {
  /** Restart the idle clock (D31). */
  abstract touch(): void;

  // ── runner processes ─────────────────────────────────────────────────────────

  protected supervised(name: string, file: string, opts: StartOptions, drainTimeout: number): Supervised {
    return {
      name,
      file,
      opts: { ...opts },
      drainTimeout,
      state: "starting",
      wanted: "run",
      tracker: new RestartTracker(this.config.restart),
      restarts: 0,
      lastExit: null,
      error: null,
    };
  }

  /** launch() with `launching` set, so stop() waits for it; with `port`, check the port is free first (D30). */
  protected async boot(s: Supervised, port?: number): Promise<void> {
    const launching = (async () => {
      if (port) {
        try {
          await this.checkPort(s.name, port);
        } catch (e) {
          s.refused = true;
          throw e;
        }
      }
      await this.launch(s);
    })();
    s.launching = launching;
    try {
      await launching;
    } finally {
      if (s.launching === launching) s.launching = undefined;
    }
  }

  /** Spawn the runner and wait until it answers `hello`. On failure the process is dead and the error says why. */
  protected async launch(s: Supervised): Promise<void> {
    s.state = "starting";
    s.upAt = undefined;
    s.registry = undefined;
    s.adopted = undefined;
    s.killed = undefined;
    this.changed(s);
    const log = logPath(this.home, s.name);
    mkdirSync(dirname(log), { recursive: true });
    const offset = existsSync(log) ? statSync(log).size : 0;
    this.note(s, `starting runner${s.restarts ? ` (restart ${s.restarts})` : ""}`);
    const proc = this.spawn(s, log);
    s.proc = proc;
    let failure: string;
    try {
      s.registry = await this.waitUp(s, proc);
      s.upAt = Date.now();
      s.state = "running";
      s.error = null;
      void proc.exited.then(() => this.onExit(s, proc));
      this.log("info", `'${s.name}' running (pid ${proc.pid}, v${s.registry.version})`);
      this.feed(s.name).checked = false;
      this.changed(s);
      void this.pump(s);
      return;
    } catch (e) {
      failure = (e as Error).message;
    }
    proc.kill("SIGKILL");
    await proc.exited;
    if (s.proc === proc) s.proc = undefined;
    s.lastExit = exitInfo(proc);
    const tail = logTail(log, offset);
    throw new EngineError(
      "start_failed",
      `'${s.name}' did not start: ${failure}${tail ? `\n${tail}` : ""}`,
      `see ${log}; fix the cause, then start it again`,
    );
  }

  protected spawn(s: Supervised, log: string): Bun.Subprocess {
    const args = [runnerBinary(), s.file, "--home", this.home, "--engine-id", this.engineId];
    if (s.opts.listen !== undefined) args.push("--listen", String(s.opts.listen));
    if (this.config.env_allow.length) args.push("--env-allow", this.config.env_allow.join(","));
    if (s.opts.detached) args.push("--detached");
    if (s.opts.ttl !== undefined) args.push("--ttl", s.opts.ttl);
    // Output goes to the log file, never a pipe: a runner must not block on a reader that went away.
    const fd = openSync(log, "a");
    try {
      // A detached runner gets its own session (setsid): no signal meant for the engine's process group or
      // terminal reaches it, and nothing ties its life to the engine's (D30).
      const detached = !!s.opts.detached;
      return Bun.spawn(args, {
        cwd: dirname(s.file),
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
        detached,
        env: runnerEnv(),
      });
    } finally {
      closeSync(fd);
    }
  }

  /** Up means: the registry entry names this pid, and the socket it names answers `hello` for this pipeline. */
  protected async waitUp(s: Supervised, proc: Bun.Subprocess): Promise<RegistryEntry> {
    const deadline = Date.now() + this.config.start_timeout;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`the runner ${describeExit(proc)}`);
      const entry = readRegistryEntry(this.home, s.name);
      if (entry?.pid === proc.pid && entry.socket) {
        try {
          const hello = await call<{ pipeline: string; pid: number }>(entry.socket, "hello", {}, 2000);
          if (hello.pipeline === s.name && hello.pid === proc.pid) return entry;
        } catch {}
      }
      await Bun.sleep(25);
    }
    throw new Error(
      `the runner did not register and answer on its socket within ${formatDuration(this.config.start_timeout)}`,
    );
  }

  protected onExit(s: Supervised, proc: Bun.Subprocess) {
    if (s.proc !== proc || s.released) return;
    s.proc = undefined;
    s.registry = undefined;
    const upFor = s.upAt ? Date.now() - s.upAt : 0;
    s.upAt = undefined;
    void this.tail(s.name);
    s.lastExit = exitInfo(proc);
    this.settle(s, describeExit(proc), upFor);
  }

  /**
   * An adopted runner's pid is gone. Its exit status can't be read (it is not this engine's child), so the
   * registry tells: a clean stop removes the entry, so an entry still naming the pid means it died. The journal
   * tells a halt (`pipeline.failed`) from a clean stop.
   */
  protected onAdoptedExit(s: Supervised, a: Adopted) {
    a.gone = true;
    if (s.released) return a.done();
    if (s.adopted === a) s.adopted = undefined;
    const unclean = readRegistryEntry(this.home, s.name)?.pid === a.pid;
    const code = unclean ? null : lastEnd(journalPath(this.home, s.name)) === "pipeline.failed" ? 2 : 0;
    s.registry = undefined;
    const upFor = s.upAt ? Date.now() - s.upAt : 0;
    s.upAt = undefined;
    void this.tail(s.name);
    s.lastExit = { code, signal: null, at: new Date().toISOString() };
    const why = unclean
      ? `(pid ${a.pid}, adopted) died without a clean stop`
      : `(pid ${a.pid}, adopted) exited${code === 2 ? " after a halt" : " cleanly"}`;
    this.settle(s, why, upFor);
    a.done();
  }

  /** Decide what an exit means (D25): stopped, failed (halt), or a crash that restarts with backoff. */
  protected settle(s: Supervised, why: string, upFor: number) {
    // The engine had a runner until now, so engine.idle counts from here, not from the last poll (D31).
    this.touch();
    const exit = s.lastExit as ExitInfo;
    this.note(s, `runner ${why}`);
    if (s.wanted === "stop") {
      this.settleStopped(s, true);
      this.log("info", `'${s.name}' stopped`);
    } else if (exit.code === 0) {
      s.wanted = "stop";
      this.settleStopped(s, false);
      this.log(
        "info",
        `'${s.name}' ended on its own (lifetime reached, or stopped through its socket); not restarting`,
      );
    } else if (exit.code === 2) {
      s.state = "failed";
      s.error = {
        message: `'${s.name}' halted: an on_error policy with 'then: halt' stopped it`,
        hint: `see ${logPath(this.home, s.name)}; fix the cause, then start it again (the held packet resumes)`,
      };
      this.log("error", s.error.message);
    } else return this.crashed(s, why, upFor);
    this.changed(s);
  }

  /** The runner died without being asked to: restart it after a backoff, or give up (D25). */
  protected crashed(s: Supervised, why: string, upFor: number) {
    const r = this.config.restart;
    const d = s.tracker.onCrash(Date.now(), upFor);
    if (!d.restart) {
      s.state = "crashed";
      s.error = {
        message: `'${s.name}' kept crashing: ${d.restarts} restart(s) within ${formatDuration(r.window)} did not help (last: ${why}); the engine stopped restarting it`,
        hint: `see ${logPath(this.home, s.name)} for the cause, fix it, then start it again (pipo start ${s.name}); packets in flight stay in the journal and resume then`,
      };
      this.log("error", `${s.error.message}. ${s.error.hint}`);
      this.changed(s);
      return;
    }
    s.state = "backoff";
    s.nextRestartAt = Date.now() + d.delay;
    this.log(
      "warn",
      `'${s.name}' ${why}; restarting in ${formatDuration(d.delay)} (restart ${d.attempt} of ${r.max_restarts} allowed within ${formatDuration(r.window)})`,
    );
    s.timer = setTimeout(() => void this.relaunch(s), d.delay);
    this.changed(s);
  }

  protected async relaunch(s: Supervised) {
    s.timer = undefined;
    s.nextRestartAt = undefined;
    if (s.wanted === "stop" || this.closing) return;
    // A runner of this pipeline may have come up meanwhile (started by hand, or by an engine that died
    // mid-launch): supervise that one rather than start a second that would refuse its socket.
    const reg = readRegistryEntry(this.home, s.name);
    if (reg && pidRunning(reg.pid)) {
      const hello = await handshake(reg);
      // stop() may have come during the handshake: a stopped pipeline is not taken back.
      if ((s.wanted as Supervised["wanted"]) === "stop" || this.closing) return;
      if (hello.ok) return this.adoptInto(s, reg, hello.hello);
    }
    s.restarts++;
    try {
      await this.boot(s);
    } catch (e) {
      // stop() may have been called while this launch was under way.
      if ((s.wanted as Supervised["wanted"]) === "stop") this.markStopped(s);
      else this.crashed(s, (e as Error).message.split("\n")[0] ?? "did not start", 0);
    }
  }

  /** Ask a live runner to stop (`now`) or drain; fall back to SIGTERM, and kill it if it overstays. */
  protected async halt(s: Supervised, now: boolean, wait: boolean) {
    const proc = s.proc;
    const adopted = s.adopted;
    if (!proc && !adopted) return;
    const exited = proc ? proc.exited.then(() => undefined) : (adopted as Adopted).exited;
    const kill = (signal: NodeJS.Signals) => {
      if (proc) proc.kill(signal);
      else if (adopted && !adopted.gone && entryAlive(adopted)) {
        try {
          process.kill(adopted.pid, signal);
        } catch {}
      }
    };
    s.state = "stopping";
    this.changed(s);
    let asked = false;
    if (s.registry?.socket) {
      try {
        await call(s.registry.socket, now ? "stop" : "drain", {}, 5000);
        asked = true;
      } catch (e) {
        // Already stopping or stopped: it is on its way out.
        asked = e instanceof ControlError && e.code === "invalid_state";
      }
    }
    // The runner drains on SIGTERM too (and stops on a second one).
    if (!asked) kill("SIGTERM");
    const exit = async () => {
      const limit = this.config.stop_timeout + (now ? 0 : s.drainTimeout);
      const done = await Promise.race([exited.then(() => true), Bun.sleep(limit).then(() => false)]);
      if (!done) {
        this.log(
          "warn",
          `'${s.name}' did not exit within ${formatDuration(limit)}; killing it (its journal resumes unfinished packets on the next start)`,
        );
        s.killed = true;
        kill("SIGKILL");
        await exited;
      }
    };
    if (wait) await exit();
    else void exit();
  }

  /** Supervise a live runner this engine did not start (it answered `hello`): its exit is found by polling its pid. */
  protected adoptInto(s: Supervised, entry: RegistryEntry, hello: Hello) {
    let done!: () => void;
    const exited = new Promise<void>((r) => {
      done = r;
    });
    s.proc = undefined;
    const proc_start = (entry as RegistryEntry & Liveness).proc_start ?? procStart(entry.pid);
    s.adopted = { pid: entry.pid, proc_start, exited, done, gone: false };
    s.killed = undefined;
    s.registry = entry;
    s.upAt = Date.parse(hello.started_at) || Date.now();
    s.state = "running";
    s.wanted = "run";
    s.error = null;
    this.feed(s.name).checked = false;
    const by = entry.engine_id && entry.engine_id !== this.engineId ? `, started by engine ${entry.engine_id}` : "";
    this.log("info", `'${s.name}' adopted: runner pid ${entry.pid} (v${hello.version}, ${hello.status}${by})`);
    this.note(s, `engine ${this.engineId} attached to runner pid ${entry.pid}`);
    this.changed(s);
    void this.pump(s);
  }

  // ── ports (§7.2, D13, D28) ───────────────────────────────────────────────────

  /**
   * Refuse a start whose http port is taken, naming who holds it (§7.2, D13): another pipeline (from this engine
   * or the registry), the gateway, or the process listening there when /proc tells. Advisory: something may still
   * take the port before the runner binds it, and the runner's own error stops it then.
   */
  protected async checkPort(name: string, port: number) {
    const refuse = (by: string) =>
      new EngineError(
        "conflict",
        `can't start '${name}': port ${port} is in use by ${by}`,
        `stop that first, or use another port (pipo start ${name} --listen <port>, or input.with.listen in the file)`,
      );
    if (this.gateway?.port === port) throw refuse("this engine's gateway");
    for (const other of this.entries.values()) {
      if (other.name === name || !LIVE.includes(other.state) || other.released) continue;
      if ((other.registry?.listen ?? other.opts.listen) === port) {
        const pid = this.pidOf(other);
        throw refuse(`pipeline '${other.name}' (${pid ? `runner pid ${pid}` : other.state})`);
      }
    }
    const entries = registered(this.home)
      .filter((n) => n !== name)
      .flatMap((n) => {
        const e = readRegistryEntry(this.home, n);
        return e && entryAlive(e) ? [e] : [];
      });
    const runner = entries.find((e) => e.listen === port);
    if (runner) throw refuse(`pipeline '${runner.pipeline}' (runner pid ${runner.pid})`);
    const problem = await bindProblem(port);
    if (!problem) return;
    if (problem !== "EADDRINUSE") {
      throw new EngineError(
        "conflict",
        `can't start '${name}': port ${port} on 127.0.0.1 can't be listened on (${problem})`,
        `use another port (pipo start ${name} --listen <port>, or input.with.listen in the file)`,
      );
    }
    const holder = portHolder(port);
    const as = holder && entries.find((e) => e.pid === holder.pid);
    if (as) throw refuse(`pipeline '${as.pipeline}' (runner pid ${as.pid})`);
    throw refuse(
      holder ? `pid ${holder.pid}${holder.command ? ` (${holder.command})` : ""}` : "another process (not identified)",
    );
  }

  /**
   * The port to pass to the runner of an http input. Without one in the file or the start options, the gateway
   * needs the runner listening somewhere: 0 has it pick a free loopback port, which its registry entry reports and
   * the gateway proxies `/in/<name>/…` to (D28). Without a gateway that input could never be reached: refused.
   */
  protected httpPort(pipeline: Pipeline, listen: number | undefined): number | undefined {
    const declared = (pipeline.input.with as { listen?: unknown } | undefined)?.listen;
    if (pipeline.input.via !== "http" || listen !== undefined || declared !== undefined) return listen;
    if (this.gateway) return 0;
    throw new EngineError(
      "invalid_pipeline",
      `'${pipeline.name}' has an http input without a port, and this engine has no gateway to receive its requests`,
      "set engine.listen in config.yaml (the gateway then serves /in/<pipeline>/…), set input.with.listen, or pass --listen",
    );
  }

  // ── stopped stays stopped (D27, D46) ─────────────────────────────────────────

  protected markStopped(s: Supervised) {
    this.settleStopped(s, true);
    this.changed(s);
  }

  /**
   * The pipeline is `stopped`. After a deliberate stop (`stop`, `drain`, shutdown) whose runner did not journal its
   * own end (killed after stop_timeout, crashed, in restart backoff), the engine journals it first (D46), then drops
   * the dead runner's entry: an engine that dies in between leaves an entry whose run ended, which discovery removes
   * without a restart (D27).
   */
  protected settleStopped(s: Supervised, deliberate: boolean) {
    s.state = "stopped";
    if (deliberate) this.closeRun(s);
    void this.forgetDead(s);
  }

  /** Journal the stop of a run whose runner is gone without writing its end (D46). Never while a runner holds it. */
  protected closeRun(s: Supervised) {
    if (s.proc || s.adopted || s.launching) return;
    const entry = readRegistryEntry(this.home, s.name);
    if (entry && entryAlive(entry)) return;
    const reason = s.killed ? "killed" : "crashed";
    try {
      if (!journalStop(journalPath(this.home, s.name), { reason, by: this.engineId })) return;
    } catch (e) {
      this.log(
        "warn",
        `could not journal the stop of '${s.name}': ${(e as Error).message}; its next start keeps the old ttl anchor`,
      );
      return;
    }
    const how = reason === "killed" ? "its runner was killed" : "its runner had crashed";
    this.note(s, `stopped by engine ${this.engineId}; ${how}, so the engine journaled the stop`);
    void this.tail(s.name);
  }

  /**
   * A stopped pipeline stays stopped (D27): its registry entry, when it still names a dead runner (a crash left it
   * during a restart backoff, or a stop had to kill the runner), is removed, so no scan restarts it.
   */
  protected forgetDead(s: Supervised): Promise<void> {
    const entry = readRegistryEntry(this.home, s.name);
    if (!entry || entry.pipeline !== s.name || !Number.isInteger(entry.pid) || entryAlive(entry)) {
      return s.forgetting ?? Promise.resolve();
    }
    const forgetting = this.removeStale(entry).catch((e) =>
      this.log("warn", `could not remove the registry entry of stopped '${s.name}': ${(e as Error).message}`),
    );
    s.forgetting = forgetting;
    void forgetting.then(() => {
      if (s.forgetting === forgetting) s.forgetting = undefined;
    });
    return forgetting;
  }

  /** Remove a dead runner's registry entry (if it still names that pid) and its socket (if nothing answers). */
  protected async removeStale(entry: RegistryEntry) {
    if (readRegistryEntry(this.home, entry.pipeline)?.pid === entry.pid) {
      rmSync(registryPath(this.home, entry.pipeline), { force: true });
    }
    const sock = entry.socket;
    if (sock && existsSync(sock) && lstatSync(sock).isSocket()) {
      const answers = await call(sock, "hello", {}, 1000).then(
        () => true,
        () => false,
      );
      if (!answers) rmSync(sock, { force: true });
    }
    this.log("info", `removed the stale registry entry of '${entry.pipeline}' (pid ${entry.pid} is gone)`);
  }
}

function exitInfo(proc: Bun.Subprocess): ExitInfo {
  return {
    code: proc.signalCode ? null : proc.exitCode,
    signal: proc.signalCode ?? null,
    at: new Date().toISOString(),
  };
}

function describeExit(proc: Bun.Subprocess): string {
  if (proc.signalCode) return `was killed by ${proc.signalCode}`;
  if (proc.exitCode !== null) return `exited with code ${proc.exitCode}`;
  return "did not exit";
}

/** The last lines a runner wrote to its log since `offset`. */
function logTail(log: string, offset: number, lines = 15): string {
  try {
    const text = readFileSync(log).subarray(offset).toString("utf8");
    return text
      .split("\n")
      .filter((l) => l && !l.includes(" ENGINE ["))
      .slice(-lines)
      .map((l) => `  | ${l}`)
      .join("\n");
  } catch {
    return "";
  }
}
