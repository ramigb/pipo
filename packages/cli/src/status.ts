// `pipo status` table (docs/spec.md §6): one row per pipeline, thousands separators, a ⚠ note for stalled or jammed ones.
// `pipo status <name>` adds the built-in metrics under it (§7.6, D54): oldest pending age and latency per node. Below
// both, today's agent spend of the whole home against `engine.agent_budget.per_day` (§3.11, D58).
export interface NodeLatency {
  count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
}

export interface StatusRow {
  name: string;
  state: string;
  version: number | null;
  /** Seconds since the runner started. */
  uptime: number | null;
  in_per_min: number | null;
  pending: number | null;
  delivered: number | null;
  dlq: number | null;
  /** ms since the epoch */
  last_delivery_at: number | null;
  note: string | null;
  /** Age (ms) of the oldest pending packet; null when none is, undefined when the runner does not report it. */
  oldest_pending_ms?: number | null;
  /** ms since the epoch */
  oldest_pending_received_at?: number | null;
  /** Per node id (and `output`); undefined when the runner does not report it. */
  latency?: Record<string, NodeLatency>;
  latency_window?: number;
  /** USD spent on agent calls in the pipeline's budget day (§3.11); undefined when the runner does not report it. */
  agent_spend_today?: number;
  /** When a `budget` pause resumes (ISO). */
  budget_resumes_at?: string;
}

/** Today's agent spend of the home (D58), as `GET /api/agent-budget` reports it. */
export interface AgentBudgetView {
  per_day: number | null;
  spent_usd: number;
  window_start: string;
  resets_at: string;
  timezone: string;
  pipelines: Record<string, number>;
}

const HEADERS = ["PIPELINE", "STATE", "VER", "UPTIME", "IN/MIN", "PENDING", "DELIVERED", "DLQ", "LAST DELIVERY"];
// Numeric columns are right-aligned, as in the spec's example.
const RIGHT = new Set([2, 3, 4, 5, 6, 7]);

export function formatCount(n: number | null): string {
  return n === null ? "-" : n.toLocaleString("en-US");
}

/** `45s`, `12m04s`, `2h10m`, `3d04h`. */
export function formatUptime(seconds: number | null): string {
  if (seconds === null) return "-";
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${pad(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 86400)}d${pad(Math.floor((s % 86400) / 3600))}h`;
}

export function formatAgo(at: number | null, now = Date.now()): string {
  if (at === null) return "-";
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function renderStatus(rows: StatusRow[], now = Date.now()): string {
  if (!rows.length) return "no pipelines";
  const cells = rows.map((r) => [
    r.name,
    r.state,
    r.version === null ? "-" : `v${r.version}`,
    formatUptime(r.uptime),
    formatCount(r.in_per_min),
    formatCount(r.pending),
    formatCount(r.delivered),
    formatCount(r.dlq),
    formatAgo(r.last_delivery_at, now),
  ]);
  const widths = HEADERS.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[], note: string | null) => {
    const text = c
      .map((v, i) => (i === c.length - 1 ? v : RIGHT.has(i) ? v.padStart(widths[i]!) : v.padEnd(widths[i]!)))
      .join("  ");
    return note ? `${text.padEnd(widths.reduce((a, b) => a + b + 2, -2))}   ⚠ ${note}` : text.trimEnd();
  };
  return [line(HEADERS, null).replace(/\s+$/, ""), ...cells.map((c, i) => line(c, rows[i]!.note))].join("\n");
}

/** `850ms`, `1.5s`, `12.0s`, then `3m12s`, `2h10m` as uptime. */
export function formatMs(ms: number | null): string {
  if (ms === null) return "-";
  const n = Math.max(0, Math.round(ms));
  if (n < 1000) return `${n}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  return formatUptime(n / 1000);
}

/** The metrics block under `pipo status <name>`; empty when the runner reports none (stopped, or an older runner). */
export function renderDetail(row: StatusRow): string {
  const out: string[] = [];
  if (row.oldest_pending_ms !== undefined) {
    out.push(
      row.oldest_pending_ms === null
        ? "oldest pending: none"
        : `oldest pending: ${formatUptime(row.oldest_pending_ms / 1000)}${row.oldest_pending_received_at == null ? "" : ` (received ${new Date(row.oldest_pending_received_at).toISOString()})`}`,
    );
  }
  if (row.agent_spend_today)
    out.push(
      `agent spend today: ${formatUsd(row.agent_spend_today)}${row.budget_resumes_at ? ` (paused by the budget until ${row.budget_resumes_at})` : ""}`,
    );
  const latency = row.latency ? Object.entries(row.latency) : [];
  if (latency.length) {
    const window = row.latency_window ? ` (last ${row.latency_window} steps per node)` : "";
    out.push(`latency${window}:`);
    const head = ["NODE", "COUNT", "P50", "P95", "MAX"];
    const cells = latency.map(([id, l]) => [
      id,
      formatCount(l.count),
      formatMs(l.p50_ms),
      formatMs(l.p95_ms),
      formatMs(l.max_ms),
    ]);
    const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
    const line = (c: string[]) =>
      `  ${c.map((v, i) => (i === 0 ? v.padEnd(widths[i]!) : v.padStart(widths[i]!))).join("  ")}`.trimEnd();
    out.push(line(head), ...cells.map(line));
  }
  return out.join("\n");
}

/** `$0.0450` under a dollar, `$12.30` from a dollar up, as the budget messages print. */
export function formatUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

/**
 * The engine-wide agent spend line (D58), and the spend per pipeline when any spent today. Empty when there is no
 * engine cap and nothing was spent, so a home without agents shows nothing.
 */
export function renderAgentBudget(b: AgentBudgetView): string {
  if (b.per_day === null && !b.spent_usd) return "";
  const cap =
    b.per_day === null ? "(no engine.agent_budget)" : `of ${formatUsd(b.per_day)} engine.agent_budget.per_day`;
  const reached = b.per_day !== null && b.spent_usd >= b.per_day ? ", reached" : "";
  const out = [`agent spend today: ${formatUsd(b.spent_usd)} ${cap}${reached}, resets ${b.resets_at}`];
  const per = Object.entries(b.pipelines);
  if (per.length) out.push(`  ${per.map(([name, usd]) => `${name} ${formatUsd(usd)}`).join(", ")}`);
  return out.join("\n");
}
