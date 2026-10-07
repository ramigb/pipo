// Pipeline state the journal carries across a crash (docs/spec.md §2.2, §3.8, §7.3, D32): a runner reads it on open,
// before any worker runs, so a pipeline that was paused when its runner died comes back paused with the same reason,
// and one with a `lifetime.ttl` gets only the time its lifetime has left.
import { parseDuration } from "@pipo/spec";
import type { Journal } from "./journal";

/** The pause a new run takes over from the journal. */
export interface JournaledPause {
  /** `manual`, `agent`, `stall`, `error at <step>`, `budget`… as journaled. */
  reason: string;
  /** The rest of the `pipeline.paused` detail (for example a budget's reset time), kept as journaled. */
  detail: Record<string, unknown>;
  /** When the pause was journaled (ms). */
  at: number;
}

/** Pipeline events that change whether it is paused. A clean stop (or a halt) ends a pause; a crash does not. */
const PAUSE_EVENTS = ["pipeline.paused", "pipeline.resumed", "pipeline.stopped", "pipeline.failed"] as const;

/**
 * The pause still in force: the last `pipeline.paused` with no later `pipeline.resumed`, `pipeline.stopped` or
 * `pipeline.failed`. Null when the pipeline was not paused when its last run ended.
 */
export function journaledPause(journal: Journal): JournaledPause | null {
  const marks = PAUSE_EVENTS.map(() => "?").join(", ");
  const row = journal.db
    .query(
      `SELECT type, at, detail FROM events WHERE packet_id IS NULL AND type IN (${marks}) ORDER BY seq DESC LIMIT 1`,
    )
    .get(...PAUSE_EVENTS) as { type: string; at: number; detail: string | null } | null;
  if (row?.type !== "pipeline.paused") return null;
  let detail: Record<string, unknown> = {};
  try {
    const parsed = row.detail === null ? null : JSON.parse(row.detail);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) detail = parsed as Record<string, unknown>;
  } catch {}
  const { reason, restored: _restored, ...rest } = detail;
  return { reason: typeof reason === "string" && reason ? reason : "manual", detail: rest, at: row.at };
}

/** Pipeline events that end a lifetime: a clean stop, a halt, or a completion. A crash writes none of them. */
const LIFETIME_ENDS = ["pipeline.stopped", "pipeline.failed", "pipeline.completed"] as const;

/**
 * When the pipeline's current lifetime began (ms), which `lifetime.ttl` (§3.8) counts from: the first
 * `pipeline.started` after the last clean end (`pipeline.stopped`, `pipeline.failed`, `pipeline.completed`), or the
 * first ever. A runner that crashed or was killed wrote no end, so its restart keeps the anchor and gets only the time
 * that is left. Null before this run journaled its own `pipeline.started`.
 */
export function lifetimeAnchor(journal: Journal): number | null {
  const marks = LIFETIME_ENDS.map(() => "?").join(", ");
  const row = journal.db
    .query(
      `SELECT at FROM events WHERE packet_id IS NULL AND type = 'pipeline.started' AND seq > COALESCE(
         (SELECT MAX(seq) FROM events WHERE packet_id IS NULL AND type IN (${marks})), 0)
       ORDER BY seq LIMIT 1`,
    )
    .get(...LIFETIME_ENDS) as { at: number } | null;
  return row ? row.at : null;
}

/**
 * Why `text` can't be a start's ttl override (`pipo start --ttl`, D57), or null when it can: a positive duration
 * such as `30m`. The override replaces `lifetime.ttl` for that start and counts from the same anchor.
 */
export function ttlOverrideProblem(text: string): string | null {
  let ms: number;
  try {
    ms = parseDuration(text);
  } catch {
    return `ttl '${text}' is not a duration`;
  }
  return ms >= 1 ? null : `ttl '${text}' must be longer than 0`;
}
