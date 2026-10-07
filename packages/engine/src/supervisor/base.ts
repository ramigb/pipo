// Supervisor state and event stream (docs/spec.md §7.1, §7.2, §7.6, D27): the pipelines this engine supervises, the
// RunnerInfo view of each, state-change listeners, and the engine log. Every supervised runner's journal events feed
// one in-memory stream, with a persisted cursor per pipeline: running runners are asked over their control socket,
// and the tail an exited runner wrote after the last poll is read from its journal file.
import { appendFileSync } from "node:fs";
import { ControlClient, readRegistryEntry } from "@pipo/runner";
import type { EngineConfig } from "../config";
import { EngineError } from "../errors";
import { type EngineEvent, type JournalEvent, journalEventsAfter, readCursor, writeCursor } from "../events";
import type { Gateway } from "../gateway";
import { journalPath, logPath } from "../home";
import type { Feed, RunnerInfo, Supervised, SupervisorOptions } from "./types";

/** Events per `events` request, and requests per poll, so one busy pipeline can't hold the stream up for long. */
const PAGE = 500;
const PAGES_PER_POLL = 10;

export abstract class SupervisorBase {
  protected readonly entries = new Map<string, Supervised>();
  protected readonly feeds = new Map<string, Feed>();
  protected readonly listeners = new Set<(event: EngineEvent) => void>();
  protected readonly stateListeners = new Set<(info: RunnerInfo) => void>();
  protected closing?: Promise<void>;
  /** The HTTP gateway (D28), when `engine.listen` is set. */
  gateway?: Gateway;

  protected constructor(
    readonly home: string,
    readonly config: EngineConfig,
    readonly engineId: string,
    readonly startedAt: string,
    protected readonly opts: SupervisorOptions,
  ) {}

  // ── events (§7.2, §7.6, D27) ──────────────────────────────────────────────────

  protected feed(name: string): Feed {
    let f = this.feeds.get(name);
    if (!f) {
      f = { cursor: readCursor(this.home, name), checked: false };
      this.feeds.set(name, f);
    }
    return f;
  }

  /** Run `job` after the feed's earlier work, so fetches never overlap and events go out in seq order. */
  protected serial(f: Feed, job: () => Promise<void>): Promise<void> {
    const run = (f.busy ?? Promise.resolve()).then(job).catch((e) => this.log("warn", `events: ${e?.message ?? e}`));
    f.busy = run;
    void run.then(() => {
      if (f.busy === run) f.busy = undefined;
    });
    return run;
  }

  /** Ask the running runner for the events after the cursor (a poll that finds a fetch under way skips). */
  protected pump(s: Supervised): Promise<void> {
    const f = this.feed(s.name);
    if (f.busy) return f.busy;
    return this.serial(f, () => this.fetch(s.name, s.registry?.socket, f));
  }

  protected async fetch(name: string, socket: string | undefined, f: Feed) {
    if (!socket) return;
    let client: ControlClient;
    try {
      client = await ControlClient.connect(socket, { connectTimeoutMs: 1000, timeoutMs: 5000 });
    } catch {
      return; // stopping, or gone: its exit reads the rest from the journal
    }
    try {
      if (!f.checked) {
        const status = await client.request<{ last_seq: number }>("status").catch(() => null);
        if (status) {
          f.checked = true;
          if (status.last_seq < f.cursor) {
            this.log(
              "warn",
              `'${name}' journal ends at seq ${status.last_seq}, before the engine's cursor ${f.cursor} (was it reset?); streaming it from the start`,
            );
            f.cursor = 0;
            this.saveCursor(name, 0);
          }
        }
      }
      for (let page = 0; page < PAGES_PER_POLL; page++) {
        const r = await client.request<{ events: JournalEvent[]; more: boolean }>("events", {
          after_seq: f.cursor,
          limit: PAGE,
        });
        this.deliver(name, f, r.events);
        if (!r.more || !r.events.length) break;
      }
    } catch {
      // The runner went away mid-fetch; the next poll or its exit catches up from the cursor.
    } finally {
      client.close();
    }
  }

  /** After a runner exited: the events it wrote after the last poll, read from its journal file. */
  protected tail(name: string): Promise<void> {
    const f = this.feed(name);
    return this.serial(f, async () => {
      for (;;) {
        const page = journalEventsAfter(journalPath(this.home, name), f.cursor, PAGE);
        if (!page?.length) return;
        this.deliver(name, f, page);
        if (page.length < PAGE) return;
      }
    });
  }

  /** Emit events past the cursor, then persist the cursor: replays after an engine crash start right after it. */
  protected deliver(name: string, f: Feed, events: JournalEvent[]) {
    let n = 0;
    for (const e of events) {
      if (e.seq <= f.cursor) continue;
      f.cursor = e.seq;
      n++;
      this.emit({ pipeline: name, ...e });
    }
    if (n) this.saveCursor(name, f.cursor);
  }

  protected saveCursor(name: string, seq: number) {
    try {
      writeCursor(this.home, name, seq);
    } catch (e) {
      this.log("warn", `could not save the event cursor of '${name}': ${(e as Error).message}`);
    }
  }

  protected emit(event: EngineEvent) {
    for (const fn of [this.opts.onEvent, ...this.listeners]) {
      if (!fn) continue;
      try {
        fn(event);
      } catch (e) {
        this.log("warn", `an event listener failed: ${(e as Error).message}`);
      }
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  protected need(name: string): Supervised {
    const s = this.entries.get(name);
    if (!s) {
      const known = [...this.entries.keys()];
      throw new EngineError(
        "not_found",
        `no pipeline named '${name}' in this engine`,
        known.length ? `known: ${known.join(", ")}` : "start one first (pipo start <file>)",
      );
    }
    return s;
  }

  /** The control socket of a running pipeline, or an error naming its state. */
  protected running(s: Supervised, op: string): string {
    if (s.state !== "running" || !s.registry?.socket) {
      throw new EngineError(
        "invalid_state",
        `cannot ${op} '${s.name}': it is ${s.state}`,
        s.state === "unreachable"
          ? (s.error?.hint ?? `pipo attach ${s.name}`)
          : s.state === "crashed" || s.state === "failed" || s.state === "stopped"
            ? `start it again (pipo start ${s.name})`
            : "try again once it is running",
      );
    }
    return s.registry.socket;
  }

  protected pidOf(s: Supervised): number | null {
    return s.proc?.pid ?? s.adopted?.pid ?? (s.state === "unreachable" ? (s.registry?.pid ?? null) : null);
  }

  protected info(s: Supervised): RunnerInfo {
    const pid = this.pidOf(s);
    const reg = pid && s.registry ? readRegistryEntry(this.home, s.name) : null;
    const live = reg?.pid === pid ? reg : null;
    return {
      name: s.name,
      file: s.file,
      state: s.state,
      status: live?.state ?? null,
      pid,
      // The live entry first: a rollback gives the running runner a new version (D38).
      version: live?.version ?? s.registry?.version ?? null,
      socket: s.registry?.socket ?? null,
      // 0 asks the runner to pick its port; that is only known once its registry entry says so.
      listen: live?.listen ?? s.registry?.listen ?? (s.opts.listen || null),
      detached: live?.detached ?? s.opts.detached ?? false,
      ttl: (live ? live.ttl : s.opts.ttl) ?? null,
      adopted: !!s.adopted,
      started_at: s.upAt ? new Date(s.upAt).toISOString() : null,
      restarts: s.restarts,
      last_exit: s.lastExit,
      next_restart_at: s.nextRestartAt ? new Date(s.nextRestartAt).toISOString() : null,
      error: s.error,
      log: logPath(this.home, s.name),
    };
  }

  protected changed(s: Supervised) {
    const info = this.info(s);
    for (const fn of [this.opts.onChange, ...this.stateListeners]) {
      if (!fn) continue;
      try {
        fn(info);
      } catch (e) {
        this.log("warn", `a state listener failed: ${(e as Error).message}`);
      }
    }
  }

  protected log(level: string, message: string) {
    (this.opts.log ?? console.log)(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [engine] ${message}`);
  }

  /** An engine line in the runner's own log, so `pipo logs` shows restarts next to what caused them. */
  protected note(s: Supervised, message: string) {
    try {
      appendFileSync(logPath(this.home, s.name), `${new Date().toISOString()} ENGINE [${s.name}] ${message}\n`);
    } catch {}
  }
}
