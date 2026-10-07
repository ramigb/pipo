// The `stats` expression context (docs/spec.md §3.2): counts read from the journal, so they survive restarts.
// Reused by lifetime (§3.8); stall messages and `pipo status` read the same numbers. `computeMetrics` adds the
// built-in metrics of §7.6 (per-node latency, oldest-pending age; D54) for the control `status` op.
// Counts are per packet: a fan-out's branch copies are not packets of their own (D22). A packet that
// fanned out stays pending until every copy is terminal, then counts once with its summary state.
import { type Journal, OUTPUT_STEP } from "./journal";

export interface Stats {
  /** Packets that passed input validation (every state except `rejected`), across all runs. */
  accepted: number;
  delivered: number;
  /** Accepted but not yet delivered, filtered or dead-lettered (D21), including packets waiting on copies (D22). */
  pending: number;
  /** Pending packets with a unit (the packet or a copy) waiting for an agent (D50); part of `pending`. */
  escalated: number;
  dead_lettered: number;
  /** Whole seconds since this run started (D21); resets on restart. */
  uptime: number;
  /** Packets accepted in the last 60 s (D21), for `pipo status` IN/MIN. */
  in_per_min: number;
  /** ISO time of the latest delivered packet, or null when none has been (D21). */
  last_delivery_at: string | null;
}

export function computeStats(journal: Journal, startedAt: number, now = Date.now()): Stats {
  const c = journal.counts();
  const lastAt = journal.lastDeliveredAt();
  const n = (s: string) => c[s] ?? 0;
  const accepted = Object.entries(c).reduce((sum, [state, k]) => (state === "rejected" ? sum : sum + k), 0);
  return {
    accepted,
    delivered: n("delivered"),
    pending: accepted - n("delivered") - n("filtered") - n("dead_lettered"),
    escalated: journal.countEscalated(),
    dead_lettered: n("dead_lettered"),
    uptime: Math.max(0, Math.floor((now - startedAt) / 1000)),
    in_per_min: journal.acceptedSince(now - 60_000),
    last_delivery_at: lastAt === null ? null : new Date(lastAt).toISOString(),
  };
}

/** Completed steps per node that latency is computed over: the latest ones, whatever their age (D54). */
export const LATENCY_WINDOW = 100;

/** One node's step durations over the window (§7.6, D54); percentiles by nearest rank, all null when count is 0. */
export interface NodeLatency {
  count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
}

/** Built-in metrics the control `status` op adds to `stats` (§7.6, D54). Read from the journal, so detached and restarted runners report them. */
export interface Metrics {
  /** Per node id, plus `output` for the output write. */
  latency: Record<string, NodeLatency>;
  latency_window: number;
  /** Age of the oldest packet not yet terminal (escalated, held and batched ones included), or null when none is pending. */
  oldest_pending_age_ms: number | null;
  /** ISO time that packet was received, or null. */
  oldest_pending_received_at: string | null;
}

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1] as number;
}

export function nodeLatency(samples: number[]): NodeLatency {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
    max_ms: sorted.length ? (sorted[sorted.length - 1] as number) : null,
  };
}

/** `nodes` are the node ids of the version in force; `output` is the output step's write. */
export function computeMetrics(journal: Journal, nodes: string[], now = Date.now()): Metrics {
  const latency: Record<string, NodeLatency> = {};
  for (const id of nodes) latency[id] = nodeLatency(journal.stepDurations(id, LATENCY_WINDOW));
  latency.output = nodeLatency(journal.stepDurations(OUTPUT_STEP, LATENCY_WINDOW));
  const at = journal.oldestPendingReceivedAt();
  return {
    latency,
    latency_window: LATENCY_WINDOW,
    oldest_pending_age_ms: at === null ? null : Math.max(0, now - at),
    oldest_pending_received_at: at === null ? null : new Date(at).toISOString(),
  };
}
