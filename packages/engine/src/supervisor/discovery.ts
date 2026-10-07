// Discovery and reattach (docs/spec.md §7.2, D27, D30): on open, and on attach(), every `<home>/run/<name>.json` is
// checked. A live runner that answers `hello` is adopted (it is not a child, so its exit is found by polling its
// pid); a live one that doesn't is left alone as `unreachable`; a dead one that never stopped cleanly is restarted
// from its file, unless its run had already ended (a journaled stop or halt) or this engine stopped it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { entryAlive, pidRunning, type RegistryEntry, readRegistryEntry, registryPath } from "@pipo/runner";
import { load, type Pipeline, parseDuration } from "@pipo/spec";
import { EngineError } from "../errors";
import { lastEndEvent, pinnedSource } from "../events";
import { journalPath, logPath } from "../home";
import { SupervisorProcesses } from "./processes";
import { type AttachResult, type Hello, LIVE, type RunnerInfo, type Supervised } from "./types";
import { DEFAULT_DRAIN, fromEntry, handshake, inspect, registered, result } from "./util";

export abstract class SupervisorDiscovery extends SupervisorProcesses {
  /** Ask the runner to drain (Supervisor.drain): a restarted pipeline that was draining finishes its drain. */
  abstract drain(name: string): Promise<RunnerInfo>;

  // ── discovery (§7.2, D27) ────────────────────────────────────────────────────

  protected async scanNow(name?: string): Promise<AttachResult[]> {
    if (name !== undefined && !existsSync(registryPath(this.home, name))) {
      const s = this.entries.get(name);
      if (s && LIVE.includes(s.state)) return [result(s, "supervised", `'${name}' is ${s.state} under this engine`)];
      throw new EngineError(
        "not_found",
        `no runner registered for '${name}' under ${join(this.home, "run")}`,
        s ? `it is ${s.state}; start it again (pipo start ${name})` : "pipo runners lists the registered runners",
      );
    }
    const names = name !== undefined ? [name] : registered(this.home);
    const found = await Promise.all(
      names.map((n) =>
        this.discover(n).catch(
          (e): AttachResult => ({ name: n, outcome: "failed", pid: null, message: (e as Error).message }),
        ),
      ),
    );
    return found.filter((r): r is AttachResult => r !== null);
  }

  /** Check one registry entry: adopt, leave alone, or restart (§7.2). */
  protected async discover(name: string): Promise<AttachResult | null> {
    const known = this.entries.get(name);
    if (known && LIVE.includes(known.state)) return result(known, "supervised", `'${name}' is ${known.state}`);
    const path = registryPath(this.home, name);
    let entry = readRegistryEntry(this.home, name);
    if (!entry && existsSync(path)) {
      // Entries are replaced atomically, so this is rare; read once more before calling it broken.
      await Bun.sleep(50);
      entry = readRegistryEntry(this.home, name);
    }
    if (!entry) {
      if (!existsSync(path)) return null; // it stopped cleanly meanwhile
      return {
        name,
        outcome: "unreachable",
        pid: null,
        message: `${path} is not readable JSON`,
        hint: `if no runner of '${name}' is running, delete ${path}`,
      };
    }
    if (entry.pipeline !== name || !Number.isInteger(entry.pid) || entry.pid <= 0) {
      return {
        name,
        outcome: "unreachable",
        pid: null,
        message: `${path} does not describe a runner of '${name}'`,
        hint: `if no runner of '${name}' is running, delete ${path}`,
      };
    }
    // A hello naming this pid proves the runner alive whatever the clocks say; without one, a pid now held by
    // another process (the runner died and its pid was reused) is a dead runner, not an unreachable one.
    if (pidRunning(entry.pid)) {
      const hello = await handshake(entry);
      if (hello.ok) return this.adopt(name, entry, hello.hello);
      if (entryAlive(entry)) return this.unreachable(name, entry, hello.why);
    }
    return this.stale(name, entry, known);
  }

  protected adopt(name: string, entry: RegistryEntry, hello: Hello): AttachResult {
    const s = this.supervised(name, entry.file ?? "", fromEntry(entry), this.pinnedDrainTimeout(name, hello.version));
    this.entries.set(name, s);
    this.adoptInto(s, entry, hello);
    return result(s, "adopted", `adopted '${name}' (pid ${entry.pid}, v${hello.version}, ${hello.status})`);
  }

  protected unreachable(name: string, entry: RegistryEntry, why: string): AttachResult {
    const s = this.supervised(name, entry.file ?? "", fromEntry(entry), 0);
    s.state = "unreachable";
    s.registry = entry;
    s.error = {
      message: `'${name}' is running (pid ${entry.pid}) but did not answer the engine's handshake: ${why}`,
      hint: `the engine leaves it alone and won't start a second one; once it answers, run pipo attach ${name} (or stop pid ${entry.pid} yourself: SIGTERM drains it); see ${logPath(this.home, name)}`,
    };
    this.entries.set(name, s);
    this.log("warn", `${s.error.message}. ${s.error.hint}`);
    this.changed(s);
    return result(s, "unreachable", s.error.message, s.error.hint);
  }

  /**
   * The runner is dead but its entry is still there, so it never stopped cleanly (a clean stop removes it). Restart
   * it from the file its entry names: the new runner replaces the entry, and its journal resumes the packets in
   * flight (pinned to their version). The entry is only removed when nothing restarts, so an engine that dies
   * half-way leaves the next one the same evidence.
   */
  protected async stale(name: string, entry: RegistryEntry, known?: Supervised): Promise<AttachResult> {
    const was = entry.state;
    const gone = `its runner (pid ${entry.pid}) is gone without a clean stop`;
    if (known && (known.state === "crashed" || known.state === "failed" || this.stoppedHere(known, entry))) {
      await this.removeStale(entry);
      return result(
        known,
        "removed",
        `removed the stale registry entry of '${name}' (${known.state}, so not restarted)`,
        `pipo start ${name}`,
      );
    }
    // The run this entry describes may have ended before its runner died (killed after journaling its stop, before
    // removing the entry): a clean stop stays stopped and a halt stays failed. An end journaled before the entry's
    // `started_at` belongs to an earlier run, so it doesn't count.
    const end = lastEndEvent(journalPath(this.home, name));
    const since = Date.parse(entry.started_at ?? "");
    if (end && Number.isFinite(since) && end.at >= since) {
      await this.removeStale(entry);
      const s = known ?? this.supervised(name, entry.file ?? "", fromEntry(entry), 0);
      s.lastExit = { code: end.type === "pipeline.failed" ? 2 : 0, signal: null, at: new Date(end.at).toISOString() };
      s.wanted = "stop";
      if (end.type === "pipeline.stopped") {
        s.state = "stopped";
        s.error = null;
      } else {
        s.state = "failed";
        s.error = {
          message: `'${name}' halted: an on_error policy with 'then: halt' stopped it (runner pid ${entry.pid})`,
          hint: `see ${logPath(this.home, name)}; fix the cause, then start it again (pipo start ${name}; the held packet resumes)`,
        };
      }
      this.entries.set(name, s);
      const how = end.type === "pipeline.stopped" ? "stopped cleanly" : "halted";
      this.log("info", `'${name}' had ${how} before its runner (pid ${entry.pid}) died; not restarting it`);
      this.changed(s);
      return result(
        s,
        "removed",
        `removed the stale registry entry of '${name}' (it had ${how}, so not restarted)`,
        `pipo start ${name}`,
      );
    }
    const file = entry.file;
    let pipeline: Pipeline | undefined;
    let problem: string | undefined;
    if (!file || !existsSync(file)) problem = file ? `its file ${file} is gone` : "its registry entry names no file";
    else {
      try {
        pipeline = inspect(file);
        if (pipeline.name !== name) problem = `${file} now names pipeline '${pipeline.name}'`;
      } catch (e) {
        problem = (e as Error).message;
      }
    }
    if (problem || !pipeline) {
      await this.removeStale(entry);
      const s = this.supervised(name, file ?? "", fromEntry(entry), 0);
      s.state = "failed";
      s.error = {
        message: `'${name}' died while ${was} and can't be restarted: ${problem}`,
        hint: "restore the file, or start the pipeline from its file (pipo start <file>); its in-flight packets stay in the journal and resume then",
      };
      this.entries.set(name, s);
      this.log("error", `${s.error.message}. ${s.error.hint}`);
      this.changed(s);
      return result(s, "failed", s.error.message, s.error.hint);
    }
    const s = this.supervised(
      name,
      file as string,
      fromEntry(entry),
      parseDuration(pipeline.lifetime?.drain_timeout ?? DEFAULT_DRAIN),
    );
    s.restarts = 1;
    s.tracker.onCrash(Date.now(), 0);
    s.lastExit = { code: null, signal: null, at: new Date().toISOString() };
    this.entries.set(name, s);
    this.log("warn", `'${name}' was ${was} but ${gone}; restarting it from ${file} so its journal resumes`);
    this.note(s, `runner pid ${entry.pid} died without a clean stop; restarting`);
    try {
      await this.boot(s);
    } catch (e) {
      if ((s.wanted as Supervised["wanted"]) === "stop") this.markStopped(s);
      else this.crashed(s, (e as Error).message.split("\n")[0] ?? "did not start", 0);
      return result(s, "failed", (e as Error).message, (e as EngineError).hint);
    }
    await this.restore(s, was);
    return result(s, "restarted", `restarted '${name}' (was ${was}; ${gone})`);
  }

  /**
   * Put a restarted pipeline back the way it was: draining finishes its drain. A pause needs nothing here: the
   * runner takes it over from its journal, with its reason, before any packet moves (D32).
   */
  protected async restore(s: Supervised, was: string) {
    if (s.state !== "running" || was !== "draining") return;
    try {
      await this.drain(s.name);
      this.log("info", `'${s.name}' draining again, as it was when its runner died`);
    } catch (e) {
      this.log("warn", `'${s.name}' could not be put back to ${was}: ${(e as Error).message}`);
    }
  }

  /**
   * This engine stopped the pipeline after the entry's runner started: a stop asked for during a restart backoff,
   * or one that had to kill the runner. Its entry is dropped, never restarted (D27). An entry written after the
   * stop is a runner someone started since (pipo run), and gets the usual rules.
   */
  protected stoppedHere(known: Supervised, entry: RegistryEntry): boolean {
    if (known.state !== "stopped") return false;
    const since = Date.parse(entry.started_at ?? "");
    const stoppedAt = Date.parse(known.lastExit?.at ?? "");
    return !Number.isFinite(since) || !Number.isFinite(stoppedAt) || since <= stoppedAt;
  }

  /** drain_timeout of the version the runner runs, from the journal (its file may have changed since). */
  protected pinnedDrainTimeout(name: string, version: number): number {
    try {
      const source = pinnedSource(journalPath(this.home, name), version);
      const p = source ? (load(source).value as Pipeline | undefined) : undefined;
      return parseDuration(p?.lifetime?.drain_timeout ?? DEFAULT_DRAIN);
    } catch {
      return parseDuration(DEFAULT_DRAIN);
    }
  }
}
