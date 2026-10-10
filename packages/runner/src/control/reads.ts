// Packet, version and proposal reads (docs/spec.md §6, §8, D33, D34): the shapes the runner answers over its control
// socket, and offlineRead(), the answer from the journal alone when no runner runs. The runner binary does the reading
// (`pipo-runner read`), so the redaction and the trace logic live in one place (D73).
import { runBinaryToFiles } from "../binary";
import type { PacketRow } from "../journal";
import { ControlError, type ErrorCode } from "./protocol";

export interface PacketSummary {
  packet_id: string;
  state: string;
  /** Where it is (in flight) or where it failed (dead-lettered, rejected); null otherwise. */
  node: string | null;
  version: number;
  trigger: string;
  source: string;
  attempt: number;
  error: PacketRow["error"];
  /** Branch copies (D22); 0 when it never fanned out. */
  copies: number;
  received_at: number;
  updated_at: number;
}

export interface PacketPage {
  packets: PacketSummary[];
  /** Packets matching the filter, all pages together. */
  total: number;
  /** Pass as `after` for the next page; null on the last one. */
  next: string | null;
}

export interface TraceStep {
  /** The step that ran: a node id, `input`, `$output`, `$batch`, `$verify`; null when copies settled it (D22). */
  node: string | null;
  /** The event that committed the step (`node.done`, `output.written`, `packet.dead_lettered`, `dlq.replayed`…). */
  event: string;
  /** The packet's state after the step. */
  state: string | null;
  started_at: number;
  at: number;
  duration_ms: number;
  attempts: number;
  retries: { attempt: number; at: number; wait_ms: number | null; error: string | null }[];
  error: PacketRow["error"];
  /** The data after the step; absent when unknown (journals from before D33, or payloads withheld). */
  data?: unknown;
  /** True when the step changed the data. */
  changed: boolean;
  /** Other events while the step ran: logs, held, awaiting an ack, events a connector emitted. */
  notes: { type: string; at: number; detail: unknown }[];
}

export interface TraceEvent {
  seq: number;
  at: number;
  type: string;
  node: string | null;
  detail: unknown;
}

export interface UnitTrace {
  packet: (PacketSummary & { root: string | null; branch: string; data?: unknown; result?: unknown }) | null;
  steps: TraceStep[];
  /** The step still in progress (in-flight units): where it is, since when, retries so far. */
  pending: { node: string | null; since: number; retries: TraceStep["retries"]; notes: TraceStep["notes"] } | null;
  events: TraceEvent[];
  /** Branch copies, each with its own trace (D22). */
  copies: UnitTrace[];
  /** Set when the packet was purged from the dead-letter queue: what is left of it. */
  purged?: { at: number; detail: unknown };
}

export const READ_OPS = ["packets", "packet", "dlq", "versions", "version", "diff", "proposals", "proposal"] as const;
export type ReadOp = (typeof READ_OPS)[number];

/**
 * A read op answered from `<home>/pipelines/<pipeline>/journal.db` while no runner runs, redacted as the runner's
 * answers are, with payloads withheld when a secret can't be resolved (D34). Null when the pipeline has no journal.
 * A bad argument or an unknown packet throws the runner's ControlError.
 */
export async function offlineRead(
  home: string,
  op: ReadOp,
  args: Record<string, unknown>,
  pipeline: string,
): Promise<{ result: unknown; withheld: string | null } | null> {
  const { code, out, err } = await runBinaryToFiles([
    "read",
    "--home",
    home,
    "--pipeline",
    pipeline,
    "--op",
    op,
    "--args",
    JSON.stringify(args),
  ]);
  let body: any;
  try {
    body = JSON.parse(out);
  } catch {
    throw new Error(`pipo-runner read exited ${code}: ${err.trim() || out.trim() || "no output"}`);
  }
  if (body?.error) {
    const e = body.error as { code: ErrorCode; message: string; hint?: string };
    throw new ControlError(e.code, e.message, e.hint ?? "");
  }
  return body as { result: unknown; withheld: string | null } | null;
}
