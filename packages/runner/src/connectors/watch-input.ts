// `via: watch` (docs/spec.md §3.3, §7.4). The runner watches a glob and turns each create, change
// or delete into a packet. fs.watch only wakes the scanner up; the scanner compares the folder
// with its last snapshot (and runs on a slow timer too, for drives where fs events are lost, such
// as WSL /mnt), so rapid duplicate events collapse into one and nothing depends on event order.
// The snapshot is persisted in the journal (spec §14.3): each path's entry is written in the same
// transaction that journals its packet, so an event the runner couldn't take yet is retried on the
// next scan, and a crash can neither lose nor repeat one. On restart the first scan diffs the folder
// against the saved snapshot, replaying what changed while the runner was down; the very first start
// (or a changed glob) only records a baseline.
import { type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { InputAdapter, InputRuntime, InputState, Intake } from "./types";

export type WatchEvent = "create" | "change" | "delete";

/** Largest file read into `data.content`; bigger files are sent without content (`truncated: true`). */
export const MAX_CONTENT_BYTES = 1024 * 1024;

export interface WatchInputOptions {
  /** Glob; relative paths resolve against `dir`. */
  path: string;
  dir: string;
  events?: WatchEvent[];
  read?: "content" | "path";
  /** Wait after the last fs event before scanning (collapses bursts). */
  debounceMs?: number;
  /** Safety-net scan interval for platforms where fs.watch is unreliable. */
  pollMs?: number;
  log?: (level: string, message: string) => void;
}

interface Stamp {
  mtimeMs: number;
  size: number;
}

const GLOB_CHARS = /[*?[\]{}!]/;

/** Split a glob into the literal folder to watch and the pattern below it. */
export function splitGlob(pattern: string, dir: string): { base: string; rest: string } {
  const full = isAbsolute(pattern) ? pattern : resolve(dir, pattern);
  const parts = full.split("/");
  const i = parts.findIndex((p) => GLOB_CHARS.test(p));
  if (i === -1) {
    // A plain folder means every file below it.
    if (statSync(full, { throwIfNoEntry: false })?.isDirectory()) return { base: full, rest: "**/*" };
    return { base: dirname(full), rest: parts[parts.length - 1] as string };
  }
  return { base: parts.slice(0, i).join("/") || "/", rest: parts.slice(i).join("/") };
}

export class WatchInput implements InputAdapter {
  private readonly base: string;
  private readonly rest: string;
  private readonly glob: Bun.Glob;
  private readonly events: Set<WatchEvent>;
  private known = new Map<string, Stamp>();
  private watcher?: FSWatcher;
  private debounce?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private stopped = true;
  private scanning: Promise<void> = Promise.resolve();
  private again = false;
  private running = false;
  private intake?: Intake;
  private state?: InputState;

  constructor(private readonly opts: WatchInputOptions) {
    const { base, rest } = splitGlob(opts.path, opts.dir);
    this.base = base;
    this.rest = rest;
    this.glob = new Bun.Glob(rest);
    this.events = new Set(opts.events?.length ? opts.events : ["create", "change"]);
  }

  describe(): string {
    return `watch ${join(this.base, this.rest)} (${[...this.events].join(", ")})`;
  }

  async start(intake: Intake, runtime?: InputRuntime): Promise<void> {
    this.intake = intake;
    this.stopped = false;
    this.state = runtime?.state(`watch:${join(this.base, this.rest)}`);
    const saved = this.state?.load();
    if (saved) {
      // Replay: the first scan diffs the folder against what the last run had journaled.
      this.known = new Map([...saved].map(([path, v]) => [path, v as Stamp]));
      this.opts.log?.("info", `watch: checking ${this.base} for changes since the last run`);
    } else {
      // First start: files already there are the baseline; only later changes produce packets.
      this.known = this.snapshot();
      this.state?.baseline(this.known);
    }
    try {
      this.watcher = watch(this.base, { recursive: true }, () => this.wake());
      this.watcher.on("error", (e) => this.opts.log?.("warn", `watch: fs events stopped (${e.message}); polling only`));
    } catch (e) {
      this.opts.log?.("warn", `watch: fs.watch unavailable on ${this.base} (${(e as Error).message}); polling only`);
    }
    this.poll = setInterval(() => this.wake(0), this.opts.pollMs ?? 1000);
    // Runs once the runner is active (a timer, not inline); an unavailable intake is retried by the poll.
    if (saved) this.wake(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.debounce);
    clearInterval(this.poll);
    this.watcher?.close();
    this.watcher = undefined;
    await this.scanning;
  }

  private wake(delay = this.opts.debounceMs ?? 50): void {
    if (this.stopped) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      if (this.stopped) return;
      if (this.running) {
        this.again = true;
        return;
      }
      this.scanning = this.scan();
    }, delay);
  }

  private snapshot(): Map<string, Stamp> {
    const out = new Map<string, Stamp>();
    let names: string[] = [];
    try {
      names = [...this.glob.scanSync({ cwd: this.base, onlyFiles: true, dot: true })];
    } catch {
      return out;
    }
    for (const name of names) {
      const path = join(this.base, name);
      try {
        const s = statSync(path);
        out.set(path, { mtimeMs: s.mtimeMs, size: s.size });
      } catch {}
    }
    return out;
  }

  private async scan(): Promise<void> {
    this.running = true;
    try {
      do {
        this.again = false;
        await this.diff();
      } while (this.again && !this.stopped);
    } finally {
      this.running = false;
    }
  }

  private async diff(): Promise<void> {
    const now = this.snapshot();
    const todo: { event: WatchEvent; path: string; stamp: Stamp }[] = [];
    for (const [path, stamp] of now) {
      const old = this.known.get(path);
      if (!old) todo.push({ event: "create", path, stamp });
      else if (old.mtimeMs !== stamp.mtimeMs || old.size !== stamp.size) todo.push({ event: "change", path, stamp });
    }
    for (const [path, stamp] of this.known) if (!now.has(path)) todo.push({ event: "delete", path, stamp });
    todo.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const t of todo) {
      if (this.stopped) return;
      const saved = t.event === "delete" ? undefined : { mtimeMs: t.stamp.mtimeMs, size: t.stamp.size };
      const commit = () => this.state?.put(t.path, saved);
      if (this.events.has(t.event)) {
        const r = await this.emit(t.event, t.path, t.stamp, commit);
        if (r === "full") return; // the runner can't take packets now; the next poll resumes from here
        if (r === "skip") continue;
      } else {
        commit(); // not subscribed: nothing to journal, only the snapshot moves
      }
      if (t.event === "delete") this.known.delete(t.path);
      else this.known.set(t.path, t.stamp);
    }
  }

  /**
   * "taken" when the intake journaled (or rejected) the packet, which also committed the snapshot
   * entry; "skip" to retry this path on the next scan; "full" when the runner takes nothing right now.
   */
  private async emit(
    event: WatchEvent,
    path: string,
    stamp: Stamp,
    commit: () => void,
  ): Promise<"taken" | "skip" | "full"> {
    const data: Record<string, unknown> = { event, path, name: path.slice(this.base.length + 1), size: stamp.size };
    if (event !== "delete") data.mtime = new Date(stamp.mtimeMs).toISOString();
    if (this.opts.read === "content" && event !== "delete") {
      if (stamp.size > MAX_CONTENT_BYTES) {
        data.content = null;
        data.truncated = true;
        this.opts.log?.("warn", `watch: ${path} is over ${MAX_CONTENT_BYTES} bytes; sent without content`);
      } else {
        try {
          data.content = readFileSync(path, "utf8");
        } catch {
          return "skip"; // vanished or locked mid-write: the next scan sees its final state
        }
      }
    }
    const source = `${path}#${event}@${Math.round(stamp.mtimeMs)}`;
    try {
      const r = await (this.intake as Intake)(data, { trigger: "watch", source }, { commit });
      if (r.status === "unavailable") {
        this.opts.log?.("warn", `watch ${event} ${path} not accepted yet: ${r.reason}`);
        return "full";
      }
      if (r.status === "rejected") this.opts.log?.("warn", `watch ${event} ${path} was rejected: ${r.message}`);
      return "taken";
    } catch (e) {
      this.opts.log?.("error", `watch ${event} ${path} failed: ${(e as Error).message}`);
      return "skip";
    }
  }
}
