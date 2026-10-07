// Read-only data the dashboard needs beyond the packet and version reads (docs/spec.md §8, §9, D59): the lifetime
// remaining of a pipeline (`lifetime.ttl` or the start's `--ttl`, counted from the journal's lifetime anchor as the
// runner counts it, §3.8), a tail of its log file, and the agent activity feed (escalations, resolves, applied
// versions) read from the journal. Nothing here writes.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { IN_FLIGHT, Journal, PENDING } from "@pipo/runner";
import { load, type Pipeline, parseDuration } from "@pipo/spec";
import type { RunnerInfo } from "./supervisor";

export interface Lifetime {
  /** The ttl in force (the start's override, else the file's `lifetime.ttl`), or null. */
  ttl: string | null;
  /** When the ttl ends the lifetime (ISO), null without a ttl or when the pipeline isn't running. */
  ends_at: string | null;
  /** Milliseconds left (0 once over), null as `ends_at`. */
  remaining_ms: number | null;
}

const NONE: Lifetime = { ttl: null, ends_at: null, remaining_ms: null };
const LIFETIME_ENDS = ["pipeline.stopped", "pipeline.failed", "pipeline.completed"];

/** Run `fn` on the journal read-only; null when it is missing or can't be read. */
function read<T>(path: string, fn: (db: ReturnType<typeof Journal.openReadonly>) => T): T | null {
  if (!existsSync(path)) return null;
  let db: ReturnType<typeof Journal.openReadonly> | undefined;
  try {
    db = Journal.openReadonly(path);
    return fn(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export interface PacketStats {
  /** Accepted, processing, writing or verifying (spec §7.3). */
  in_flight: number;
  /** Everything not yet terminal: in flight, escalated and branched, the one "pending" the detail page counts. */
  pending: number;
  delivered: number;
  filtered: number;
  dead_lettered: number;
  rejected: number;
  /** Units handed to an agent or human (D50). */
  escalated: number;
  /** Packets waiting on their fan-out copies (D22). */
  branched: number;
  total: number;
  /** Age of the oldest packet not yet terminal (ms), null when nothing is pending. */
  oldest_pending_age_ms: number | null;
  /** Packets accepted in the last 60 s: the runner's `in_per_min` (D21), so the list matches `pipo status`. */
  throughput_per_min: number;
}

/** Packet counts by state from the journal (§7.6, D60), for the pipeline list; null when it can't be read. */
export function statsOf(journal: string, now = Date.now()): PacketStats | null {
  return read(journal, (db) => {
    const c: Record<string, number> = {};
    for (const r of db.query("SELECT state, COUNT(*) AS n FROM packets WHERE branch = '' GROUP BY state").all() as {
      state: string;
      n: number;
    }[])
      c[r.state] = r.n;
    const sum = (names: readonly string[]) => names.reduce((n, s) => n + (c[s] ?? 0), 0);
    const marks = PENDING.map(() => "?").join(", ");
    const oldest = (
      db
        .query(`SELECT MIN(received_at) AS at FROM packets WHERE branch = '' AND state IN (${marks})`)
        .get(...PENDING) as { at: number | null }
    ).at;
    const recent = (
      db
        .query("SELECT COUNT(*) AS n FROM packets WHERE received_at >= ? AND branch = '' AND state != 'rejected'")
        .get(now - 60_000) as { n: number }
    ).n;
    return {
      in_flight: sum(IN_FLIGHT),
      pending: sum(PENDING),
      delivered: c.delivered ?? 0,
      filtered: c.filtered ?? 0,
      dead_lettered: c.dead_lettered ?? 0,
      rejected: c.rejected ?? 0,
      escalated: c.escalated ?? 0,
      branched: c.branched ?? 0,
      total: Object.values(c).reduce((n, v) => n + v, 0),
      oldest_pending_age_ms: oldest === null ? null : Math.max(0, now - oldest),
      throughput_per_min: recent,
    };
  });
}

/** The first `pipeline.started` after the last clean end, as the runner's `lifetimeAnchor` reads it (ms) or null. */
const anchor = (path: string): number | null =>
  read(path, (db) => {
    const marks = LIFETIME_ENDS.map(() => "?").join(", ");
    const row = db
      .query(
        `SELECT at FROM events WHERE packet_id IS NULL AND type = 'pipeline.started' AND seq > COALESCE(
           (SELECT MAX(seq) FROM events WHERE packet_id IS NULL AND type IN (${marks}) ), 0)
         ORDER BY seq LIMIT 1`,
      )
      .get(...LIFETIME_ENDS) as { at: number } | null;
    return row ? row.at : null;
  });

export function lifetimeOf(info: RunnerInfo, journal: string, now = Date.now()): Lifetime {
  let ttl = info.ttl;
  if (ttl === null) {
    try {
      ttl = ((load(readFileSync(info.file, "utf8")).value as Pipeline | undefined)?.lifetime?.ttl as string) ?? null;
    } catch {
      return NONE;
    }
  }
  if (!ttl) return NONE;
  if (info.state !== "running") return { ttl, ends_at: null, remaining_ms: null };
  let ms: number;
  try {
    ms = parseDuration(ttl);
  } catch {
    return { ttl, ends_at: null, remaining_ms: null };
  }
  const from = anchor(journal) ?? (info.started_at ? Date.parse(info.started_at) : now);
  const end = from + ms;
  return { ttl, ends_at: new Date(end).toISOString(), remaining_ms: Math.max(0, end - now) };
}

/** At most this many bytes of the log are read per request. */
const MAX_LOG_BYTES = 256 * 1024;

export interface LogPage {
  lines: string[];
  /** The byte offset to ask for next (`?after=`): the end of the last whole line returned. */
  next: number;
  /** True when `after` was past the end of the file (rotated or truncated): `lines` is a fresh tail. */
  reset: boolean;
}

/**
 * The runner's log (`logs/<name>.log`). Without `after`: the last `tail` lines. With `after`: whole lines written
 * since that byte offset. A missing file is an empty page.
 */
export function logPage(path: string, opts: { tail: number; after: number | null }): LogPage {
  if (!existsSync(path)) return { lines: [], next: 0, reset: false };
  const size = statSync(path).size;
  const reset = opts.after !== null && opts.after > size;
  const after = reset ? null : opts.after;
  const from = after ?? Math.max(0, size - MAX_LOG_BYTES);
  const buf = Buffer.alloc(Math.min(size, from + MAX_LOG_BYTES) - from);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, from);
  } finally {
    closeSync(fd);
  }
  // A read that stops mid-line leaves that line for the next request.
  const lastNl = buf.lastIndexOf(10);
  const whole = lastNl < 0 ? Buffer.alloc(0) : buf.subarray(0, lastNl + 1);
  let lines = whole.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  // A tail that starts mid-file starts mid-line: drop the partial first line.
  if (after === null && from > 0) lines = lines.slice(1);
  if (after === null) lines = lines.slice(-opts.tail);
  return { lines, next: from + whole.length, reset };
}

export interface ActivityEvent {
  seq: number;
  at: number;
  type: string;
  packet_id: string | null;
  node: string | null;
  detail: unknown;
}

const ACTIVITY_TYPES = ["packet.escalated", "packet.resolved", "version.applied"];

/** The newest agent-related journal events, newest first: escalations, resolves, applied versions. */
export const activityEvents = (path: string, limit: number): ActivityEvent[] | null =>
  read(path, (db) =>
    (
      db
        .query(
          `SELECT seq, at, type, packet_id, node, detail FROM events WHERE type IN (${ACTIVITY_TYPES.map(() => "?").join(", ")}) ORDER BY seq DESC LIMIT ?`,
        )
        .all(...ACTIVITY_TYPES, limit) as (Omit<ActivityEvent, "detail"> & { detail: string | null })[]
    ).map((r) => ({ ...r, detail: r.detail === null ? null : JSON.parse(r.detail) })),
  );
