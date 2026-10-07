// The engine's event stream (docs/spec.md §7.2, §7.6, D27): journal events fed from each runner's `events` op, with a
// per-pipeline cursor under `<home>/engine/cursors/` so a restarted engine replays exactly what came after it.
// Also the read-only journal lookups the engine needs when a runner is not there to answer: the tail of events
// after it exited, how it ended, and the source of a pinned version. And the one write: a deliberate stop the runner
// could not journal itself (D46).
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Journal } from "@pipo/runner";
import { cursorPath } from "./home";

/** One journal event of one pipeline, as the runner's `events` op returns it, tagged with the pipeline. */
export interface EngineEvent {
  pipeline: string;
  /** The journal's event sequence number; increasing per pipeline, so (pipeline, seq) identifies an event. */
  seq: number;
  at: number;
  packet_id: string | null;
  type: string;
  node: string | null;
  detail: unknown;
}

export type JournalEvent = Omit<EngineEvent, "pipeline">;

/** The last seq streamed for `pipeline`, or 0 when the engine never streamed it. */
export function readCursor(home: string, pipeline: string): number {
  const path = cursorPath(home, pipeline);
  if (!existsSync(path)) return 0;
  try {
    const seq = (JSON.parse(readFileSync(path, "utf8")) as { last_seq?: unknown }).last_seq;
    return Number.isInteger(seq) && (seq as number) >= 0 ? (seq as number) : 0;
  } catch {
    return 0;
  }
}

/** Replace the cursor atomically (write, then rename), so a crash leaves the old cursor or the new one. */
export function writeCursor(home: string, pipeline: string, seq: number): void {
  const path = cursorPath(home, pipeline);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pipeline, last_seq: seq, updated_at: new Date().toISOString() }));
  renameSync(tmp, path);
}

function readJournal<T>(path: string, fn: (db: Database) => T): T | null {
  if (!existsSync(path)) return null;
  let db: Database | undefined;
  try {
    db = Journal.openReadonly(path);
    return fn(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Events after `after`, read straight from the journal file (best effort: null when it can't be read). */
export function journalEventsAfter(path: string, after: number, limit: number): JournalEvent[] | null {
  return readJournal(path, (db) =>
    (
      db
        .query("SELECT seq, at, packet_id, type, node, detail FROM events WHERE seq > ? ORDER BY seq LIMIT ?")
        .all(after, limit) as (JournalEvent & { detail: string | null })[]
    ).map((e) => ({ ...e, detail: e.detail === null ? null : JSON.parse(e.detail) })),
  );
}

/** The last `limit` events of the journal, oldest first (best effort: null when it can't be read). */
export function journalEventsTail(path: string, limit: number): JournalEvent[] | null {
  return readJournal(path, (db) =>
    (
      db
        .query("SELECT seq, at, packet_id, type, node, detail FROM events ORDER BY seq DESC LIMIT ?")
        .all(limit) as (JournalEvent & { detail: string | null })[]
    )
      .reverse()
      .map((e) => ({ ...e, detail: e.detail === null ? null : JSON.parse(e.detail) })),
  );
}

/** How the last run ended in the journal: `pipeline.stopped`, `pipeline.failed` (a halt), or null. */
export function lastEnd(path: string): string | null {
  return readJournal(path, (db) => {
    const row = db
      .query(
        "SELECT type FROM events WHERE type IN ('pipeline.started', 'pipeline.stopped', 'pipeline.failed') ORDER BY seq DESC LIMIT 1",
      )
      .get() as { type: string } | null;
    return row && row.type !== "pipeline.started" ? row.type : null;
  });
}

/**
 * The journal's last `pipeline.stopped` or `pipeline.failed` with its time, or null when there is none. Compared
 * with a registry entry's `started_at`, it tells whether that run ended (cleanly, or by a halt) before it died.
 */
export function lastEndEvent(path: string): { type: "pipeline.stopped" | "pipeline.failed"; at: number } | null {
  return readJournal(path, (db) => {
    const row = db
      .query(
        "SELECT type, at FROM events WHERE type IN ('pipeline.stopped', 'pipeline.failed') ORDER BY seq DESC LIMIT 1",
      )
      .get() as { type: "pipeline.stopped" | "pipeline.failed"; at: number } | null;
    return row ?? null;
  });
}

/** The source of a pinned pipeline version (the journal's `versions` table), or null. */
export function pinnedSource(path: string, version: number): string | null {
  return readJournal(path, (db) => {
    const row = db.query("SELECT source FROM versions WHERE version = ?").get(version) as { source: string } | null;
    return row?.source ?? null;
  });
}

/** Pipeline events that end a run's lifetime (§7.4), as the runner's anchor reads them. */
const RUN_ENDS = ["pipeline.stopped", "pipeline.failed", "pipeline.completed"];
/** Pipeline events that decide whether a pause is in force (D32), as the runner reads them on start. */
const PAUSE_MARKS = ["pipeline.paused", "pipeline.resumed", "pipeline.stopped", "pipeline.failed"];

/**
 * Journal the end of a run a deliberate stop could not let the runner write (D46): it was killed after
 * `stop_timeout`, or it was already dead (crashed, in restart backoff). Only call this once no runner holds the
 * journal. In one transaction, and only when the last run has no end yet (so it is idempotent): `pipeline.stopped`
 * with `detail`, which resets the ttl anchor like a clean stop (§7.4); then, when a pause was in force, that pause
 * journaled again with the same detail, because a kill or a crash does not end a pause (D32). Returns whether it wrote.
 */
export function journalStop(path: string, detail: Record<string, unknown>): boolean {
  if (!existsSync(path)) return false;
  const journal = new Journal(path);
  try {
    const db = journal.db;
    const last = (types: string[]) =>
      db
        .query(
          `SELECT type, detail FROM events WHERE packet_id IS NULL AND type IN (${types.map(() => "?").join(", ")}) ORDER BY seq DESC LIMIT 1`,
        )
        .get(...types) as { type: string; detail: string | null } | null;
    return db
      .transaction(() => {
        if (last(["pipeline.started", ...RUN_ENDS])?.type !== "pipeline.started") return false;
        const pause = last(PAUSE_MARKS);
        journal.event("pipeline.stopped", detail);
        if (pause?.type === "pipeline.paused") {
          journal.event("pipeline.paused", pause.detail === null ? undefined : JSON.parse(pause.detail));
        }
        return true;
      })
      .immediate();
  } finally {
    journal.close();
  }
}
