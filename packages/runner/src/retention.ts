// Retention clean-up and daily compaction (spec §3.12, D39). Only settled packets are ever touched:
// pending and in-flight ones, versions, and pipeline-level events (pause/resume state) are kept.

import type { Database } from "bun:sqlite";
import { type Pipeline, parseDuration } from "@pipo/spec";

export interface RetentionPolicy {
  /** Payloads (data, result) of delivered/filtered packets, ms. */
  data: number;
  /** Packet metadata and event trail of delivered/filtered/rejected packets, ms. */
  trail: number;
  /** Payloads of rejected input, ms. */
  rejected: number;
  /** Dead letters (with their trail), ms; null keeps them until handled. */
  dlq: number | null;
}

export interface RetentionResult {
  /** Packets whose payload was cleared. */
  cleared: number;
  /** Packets deleted (their events go with them). */
  deleted: number;
  events: number;
}

const DAY = 86_400_000;
const BATCH = 500;

export function retentionPolicy(spec: Pipeline["retention"]): RetentionPolicy {
  const ms = (v: string | undefined, fallback: string) => parseDuration(v ?? fallback);
  return {
    data: ms(spec?.data, "7d"),
    trail: ms(spec?.trail, "30d"),
    rejected: ms(spec?.rejected, "3d"),
    dlq: spec?.dlq === undefined || spec.dlq === "forever" ? null : parseDuration(spec.dlq),
  };
}

/** One clean-up pass. Bounded batches, each in its own transaction; rerunning it is a no-op. */
export function applyRetention(db: Database, policy: RetentionPolicy, now: number, batch = BATCH): RetentionResult {
  const out: RetentionResult = { cleared: 0, deleted: 0, events: 0 };

  const clear = (states: string[], olderThan: number) => {
    const marks = states.map(() => "?").join(",");
    const stmt = db.query(
      `UPDATE packets SET data = NULL, result = NULL WHERE id IN (
         SELECT id FROM packets WHERE state IN (${marks}) AND updated_at < ? AND (data IS NOT NULL OR result IS NOT NULL) LIMIT ?)`,
    );
    for (;;) {
      const n = db.transaction(() => stmt.run(...states, olderThan, batch).changes)();
      out.cleared += n;
      if (n < batch) return;
    }
  };

  // Leaves first: a packet with fan-out copies stays until its copies are gone.
  const remove = (states: string[], olderThan: number) => {
    const marks = states.map(() => "?").join(",");
    const pick = db.query(
      `SELECT id FROM packets p WHERE state IN (${marks}) AND updated_at < ?
         AND NOT EXISTS (SELECT 1 FROM packets c WHERE c.parent = p.id) LIMIT ?`,
    );
    for (;;) {
      const ids = (pick.all(...states, olderThan, batch) as { id: string }[]).map((r) => r.id);
      if (!ids.length) return;
      db.transaction(() => {
        for (const id of ids) {
          out.events += db.query("DELETE FROM events WHERE packet_id = ?").run(id).changes;
          out.deleted += db.query("DELETE FROM packets WHERE id = ?").run(id).changes;
        }
      })();
    }
  };

  clear(["delivered", "filtered"], now - policy.data);
  clear(["rejected"], now - policy.rejected);
  remove(["delivered", "filtered", "rejected"], now - policy.trail);
  if (policy.dlq !== null) remove(["dead_lettered"], now - policy.dlq);
  return out;
}

/** Checkpoint the WAL and rebuild the file. VACUUM needs a quiet moment, so a busy database waits for the next tick. */
export function compact(db: Database): boolean {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
    return true;
  } catch {
    return false;
  }
}

export interface RetentionOptions {
  /** Time between clean-up passes (default 10 minutes). */
  intervalMs?: number;
  now?: () => number;
  /** Called after each pass that removed something, and on compaction. */
  onRun?: (r: RetentionResult & { compacted: boolean }) => void;
}

/** Runs a pass at start and then every interval; compacts when a day has passed since the last compaction. */
export function startRetention(db: Database, policy: RetentionPolicy, opts: RetentionOptions = {}) {
  const now = opts.now ?? Date.now;
  db.exec(
    "CREATE TABLE IF NOT EXISTS retention_state (id INTEGER PRIMARY KEY CHECK (id = 1), compacted_at INTEGER NOT NULL)",
  );
  const lastCompacted = () =>
    (db.query("SELECT compacted_at AS at FROM retention_state WHERE id = 1").get() as { at: number } | null)?.at ??
    null;

  const tick = () => {
    const t = now();
    let result: RetentionResult = { cleared: 0, deleted: 0, events: 0 };
    let compacted = false;
    try {
      result = applyRetention(db, policy, t);
      const last = lastCompacted();
      if (last === null) {
        // First start: the file is fresh or was never aged; begin the daily cycle without a rebuild.
        db.query("INSERT OR REPLACE INTO retention_state (id, compacted_at) VALUES (1, ?)").run(t);
      } else if (t - last >= DAY && compact(db)) {
        db.query("INSERT OR REPLACE INTO retention_state (id, compacted_at) VALUES (1, ?)").run(t);
        compacted = true;
      }
    } catch {
      return; // database closing or locked: try again next tick
    }
    if (compacted || result.cleared || result.deleted) opts.onRun?.({ ...result, compacted });
  };

  tick();
  const timer = setInterval(tick, opts.intervalMs ?? 600_000);
  timer.unref?.();
  return {
    tick,
    stop() {
      clearInterval(timer);
    },
  };
}
