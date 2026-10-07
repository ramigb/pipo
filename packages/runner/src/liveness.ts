// Is the process a registry entry names still that process? (docs/spec.md §7.2, D25, D27.) Runner entries
// (`run/<name>.json`) and the engine's (`run/engine.json`) both name a pid, which outlives its process: after a crash
// or a reboot the pid can belong to anything. One answer for every caller, so a reused pid never makes a dead runner
// look alive (a refused start, a crash loop) and a live one is never taken for dead.
import { readFileSync } from "node:fs";

/** What liveness needs from an entry: its pid, when it registered, and (when recorded) its process start ticks. */
export interface Liveness {
  pid: number;
  started_at?: string | null;
  /** The process's start time in clock ticks since boot (`/proc/<pid>/stat` field 22), Linux only. */
  proc_start?: number | null;
}

/** Slack between a process starting and it writing `started_at`'s clock: /proc's boot time is whole seconds. */
const REUSE_SLACK_MS = 2000;

/** `/proc/<pid>/stat` fields from field 3 (state) on; null off Linux or when the process is gone. */
function procStat(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

/** The pid exists (EPERM: someone else's, still alive) and is not a zombie. Says nothing about which process it is. */
export function pidRunning(pid: number): boolean {
  // kill(0 or negative) would signal a process group: never a registry entry's pid.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const state = procStat(pid)?.[0];
  return state !== "Z" && state !== "X";
}

/** When `pid` started, in clock ticks since boot; null off Linux or when unknown. Immune to wall-clock jumps. */
export function procStart(pid = process.pid): number | null {
  const ticks = Number(procStat(pid)?.[19]);
  return Number.isInteger(ticks) ? ticks : null;
}

/** When `pid` started (ms since the epoch), from /proc on Linux; null elsewhere or when unknown. */
export function processStartedAt(pid: number): number | null {
  const ticks = procStart(pid);
  if (ticks === null) return null;
  try {
    const btime = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1];
    // starttime is in clock ticks since boot; USER_HZ is 100 on Linux.
    return btime ? Number(btime) * 1000 + ticks * 10 : null;
  } catch {
    return null;
  }
}

/**
 * True when `pid` now belongs to a process that started after `startedAt` (the registered process died and its pid
 * was reused, for example after a reboot). Only answers on Linux; elsewhere it is never sure, so false.
 */
export function pidReused(pid: number, startedAt: string | null | undefined): boolean {
  const started = processStartedAt(pid);
  const registered = Date.parse(startedAt ?? "");
  return started !== null && Number.isFinite(registered) && started > registered + REUSE_SLACK_MS;
}

/**
 * The process an entry names is still running: its pid exists, is not a zombie, and is the same process. Sameness is
 * exact when the entry records `proc_start` (Linux); otherwise a process that started after the entry's `started_at`
 * holds a reused pid and the entry's process is dead (D27). Off Linux only the pid can be checked.
 */
export function entryAlive(entry: Liveness): boolean {
  if (!pidRunning(entry.pid)) return false;
  if (typeof entry.proc_start === "number") {
    const now = procStart(entry.pid);
    if (now !== null) return now === entry.proc_start;
  }
  return !pidReused(entry.pid, entry.started_at);
}
