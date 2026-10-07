// The engine's own registry entry, `<home>/run/engine.json` (docs/spec.md §7.1, §7.2, D25): how the CLI finds a
// running engine, and the lock that keeps two engines from supervising the same home.
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { entryAlive, pidRunning } from "@pipo/runner";
import { EngineError } from "./errors";
import { engineEntryPath } from "./home";

export interface EngineEntry {
  engine_id: string;
  pid: number;
  started_at: string;
  home: string;
  /** The gateway's port (D28): `engine.listen`, or the port it picked for `listen: 0` once bound; null without one. */
  listen: number | null;
  /** The engine process's start in clock ticks since boot (Linux), so a reused pid is told apart exactly (D27). */
  proc_start?: number | null;
}

export function readEngineEntry(home: string): EngineEntry | null {
  const path = engineEntryPath(home);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as EngineEntry;
  } catch {
    return null;
  }
}

/** The pid exists and is not a zombie (tests and callers that follow a child process they spawned). */
export const isRunning = pidRunning;

/** Homes claimed by engines in this process (the pid check can't tell them apart). */
const claimed = new Set<string>();

/**
 * Create engine.json for this process, refusing when a live engine already owns `home`. The entry is
 * created with a hard link, so two engines starting at once can't both win; a stale entry (its process is gone, or
 * its pid now belongs to another process) is replaced.
 */
export function claimEngineEntry(entry: EngineEntry): void {
  const path = engineEntryPath(entry.home);
  const refuse = (existing: EngineEntry | null) =>
    new EngineError(
      "conflict",
      `an engine is already running for ${entry.home} (pid ${existing?.pid ?? process.pid}, ${existing?.engine_id ?? "this process"})`,
      `use that engine, or stop it first; if no engine is running, delete ${path}`,
    );
  if (claimed.has(entry.home)) throw refuse(readEngineEntry(entry.home));
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2));
  try {
    for (let tries = 0; ; tries++) {
      try {
        linkSync(tmp, path);
        claimed.add(entry.home);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (tries > 0) throw refuse(readEngineEntry(entry.home));
      }
      const existing = readEngineEntry(entry.home);
      if (existing && existing.pid !== process.pid && entryAlive(existing)) throw refuse(existing);
      rmSync(path, { force: true });
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Rewrite engine.json atomically (write, then rename), but only while it is still this engine's. */
export function updateEngineEntry(home: string, engineId: string, patch: Partial<EngineEntry>): void {
  const current = readEngineEntry(home);
  if (current?.engine_id !== engineId) return;
  const path = engineEntryPath(home);
  const tmp = `${path}.${process.pid}.update.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...current, ...patch }, null, 2));
  renameSync(tmp, path);
}

/** Remove engine.json, but only while it is still this engine's. */
export function releaseEngineEntry(home: string, engineId: string): void {
  claimed.delete(home);
  if (readEngineEntry(home)?.engine_id === engineId) rmSync(engineEntryPath(home), { force: true });
}
