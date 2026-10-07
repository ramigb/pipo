// Packet reads for `pipo packets`, `pipo inspect` and `pipo dlq` (docs/spec.md §6, §8, D33): a page of packets, one
// packet's trace through every node (data, timings, attempts, errors) and the dead-letter queue. The runner answers
// them over its control socket; when no runner is running, the engine and the CLI read the journal read-only through
// offlineRead(), which redacts with the secrets it can resolve and withholds payloads when it can't (D34).
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { load, type Pipeline } from "@pipo/spec";
import { BRANCHED, ESCALATED, IN_FLIGHT, openReadonly, type PacketRow, TERMINAL } from "../journal";
import { PROPOSAL_STATES, type Proposal, type ProposalState, type ProposalSummary, readProposals } from "../proposals";
import { Secrets } from "../secrets";
import { ControlError, redactDeep } from "./protocol";
import { diffVersions, getVersion, listVersions, versionArg } from "./versions";

export const PACKET_STATES: readonly string[] = [...IN_FLIGHT, ...TERMINAL, BRANCHED, ESCALATED];
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 1000;

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

type RawEvent = TraceEvent & { patch: Record<string, unknown> | null };

/** Transition events in journals written before patches were recorded (D33). */
const LEGACY_TRANSITIONS = new Set([
  "packet.accepted",
  "packet.rejected",
  "packet.branched",
  "node.done",
  "node.looped",
  "node.failed_continued",
  "packet.filtered",
  "packet.dropped",
  "packet.dead_lettered",
  "packet.delivered",
  "output.batched",
  "output.written",
  "packet.fanned_out",
]);

const unjson = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(String(v)));

function hasPatchColumn(db: Database): boolean {
  return (db.query("PRAGMA table_info(events)").all() as { name: string }[]).some((c) => c.name === "patch");
}

// ── argument parsing (shared by the runner ops, the engine API and the CLI) ──

function limitArg(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_LIMIT;
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_LIMIT) {
    throw new ControlError(
      "bad_request",
      `\`limit\` must be a whole number from 1 to ${MAX_LIMIT}`,
      "page with `after`",
    );
  }
  return n as number;
}

function afterArg(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > 200) {
    throw new ControlError("bad_request", "`after` must be a packet id", "use the `next` value of the previous page");
  }
  return raw;
}

export function stateArg(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || !PACKET_STATES.includes(raw)) {
    throw new ControlError(
      "bad_request",
      `unknown packet state ${JSON.stringify(raw)}`,
      `use one of ${PACKET_STATES.join(", ")}`,
    );
  }
  return raw;
}

export function packetIdArg(raw: unknown, op: string): string {
  if (typeof raw !== "string" || !raw || raw.length > 400) {
    throw new ControlError("bad_request", `${op} needs \`packet_id\``, `{"op":"${op}","args":{"packet_id":"01J…"}}`);
  }
  return raw;
}

// ── queries ──────────────────────────────────────────────────────────────────

/**
 * One page of packets (not branch copies, D22), newest first, optionally in one state. `escalated` lists units, copies
 * included: each waits for an agent on its own and is resolved by its own id (D50).
 */
export function listPackets(db: Database, args: Record<string, unknown>): PacketPage {
  const state = stateArg(args.state);
  const limit = limitArg(args.limit);
  const after = afterArg(args.after);
  const where = state === ESCALATED ? [] : ["p.branch = ''"];
  const params: (string | number)[] = [];
  if (state) {
    where.push("p.state = ?");
    params.push(state);
  }
  const total = (
    db.query(`SELECT COUNT(*) AS n FROM packets p WHERE ${where.join(" AND ")}`).get(...params) as { n: number }
  ).n;
  if (after) {
    where.push("p.id < ?");
    params.push(after);
  }
  const rows = db
    .query(
      `SELECT p.*, (SELECT COUNT(*) FROM packets c WHERE c.root = p.id) AS n_copies FROM packets p
       WHERE ${where.join(" AND ")} ORDER BY p.id DESC LIMIT ?`,
    )
    .all(...params, limit + 1) as Record<string, unknown>[];
  const page = rows.slice(0, limit).map((r) => summary(r));
  return { packets: page, total, next: rows.length > limit ? (page.at(-1)?.packet_id ?? null) : null };
}

/** The dead-letter queue: dead-lettered packets, newest first. */
export function listDlq(db: Database, args: Record<string, unknown>): PacketPage {
  return listPackets(db, { ...args, state: "dead_lettered" });
}

function summary(r: Record<string, unknown>): PacketSummary {
  const error = unjson(r.error) as PacketRow["error"];
  const state = r.state as string;
  const inFlight = (IN_FLIGHT as readonly string[]).includes(state);
  return {
    packet_id: r.id as string,
    state,
    node: inFlight ? ((r.cursor as string | null) ?? null) : (error?.node ?? null),
    version: r.version as number,
    trigger: r.trigger as string,
    source: r.source as string,
    attempt: r.attempt as number,
    error,
    copies: (r.n_copies as number | undefined) ?? 0,
    received_at: r.received_at as number,
    updated_at: r.updated_at as number,
  };
}

/**
 * One packet's trace (spec §8): the packet, then every step it took with the data after it, when it ran, how long it
 * took, its attempts and errors, then its branch copies' traces. A copy id (`<packet_id>:<branch>`) traces that copy.
 * Null when the journal has never seen the id.
 */
export function packetTrace(db: Database, id: string): UnitTrace | null {
  const patches = hasPatchColumn(db);
  const row = db.query("SELECT * FROM packets WHERE id = ?").get(id) as Record<string, unknown> | null;
  if (row) return unitTrace(db, row, patches);
  const events = eventsOf(db, id, patches);
  const purged = events.findLast((e) => e.type === "dlq.purged");
  if (!purged) return null;
  return {
    packet: null,
    steps: [],
    pending: null,
    events: events.map(stripPatch),
    copies: [],
    purged: { at: purged.at, detail: purged.detail },
  };
}

function eventsOf(db: Database, id: string, patches: boolean): RawEvent[] {
  return (
    db
      .query(
        `SELECT seq, at, type, node, detail, ${patches ? "patch" : "NULL AS patch"} FROM events WHERE packet_id = ? ORDER BY seq`,
      )
      .all(id) as Record<string, unknown>[]
  ).map((e) => ({
    seq: e.seq as number,
    at: e.at as number,
    type: e.type as string,
    node: (e.node as string | null) ?? null,
    detail: unjson(e.detail),
    patch: unjson(e.patch) as Record<string, unknown> | null,
  }));
}

const stripPatch = ({ patch: _, ...e }: RawEvent): TraceEvent => e;

function unitTrace(db: Database, row: Record<string, unknown>, patches: boolean): UnitTrace {
  const id = row.id as string;
  const events = eventsOf(db, id, patches);
  const { steps, pending } = buildSteps(events);
  const s = summary({ ...row, n_copies: 0 });
  const children = db.query("SELECT * FROM packets WHERE parent = ? ORDER BY branch").all(id) as Record<
    string,
    unknown
  >[];
  const inFlight = (IN_FLIGHT as readonly string[]).includes(s.state);
  return {
    packet: {
      ...s,
      copies: (db.query("SELECT COUNT(*) AS n FROM packets WHERE parent = ?").get(id) as { n: number }).n,
      root: (row.root as string | null) ?? null,
      branch: row.branch as string,
      data: unjson(row.data),
      result: unjson(row.result),
    },
    steps,
    pending: inFlight
      ? {
          node: s.node,
          since: steps.at(-1)?.at ?? s.received_at,
          retries: pending.retries,
          notes: pending.notes,
        }
      : null,
    events: events.map(stripPatch),
    copies: children.map((c) => unitTrace(db, c, patches)),
  };
}

const looksLikeError = (v: unknown): v is NonNullable<PacketRow["error"]> =>
  !!v && typeof v === "object" && typeof (v as any).code === "string" && typeof (v as any).message === "string";

function buildSteps(events: RawEvent[]) {
  const legacy = !events.some((e) => e.patch);
  const steps: TraceStep[] = [];
  let retries: TraceStep["retries"] = [];
  let notes: TraceStep["notes"] = [];
  let data: unknown;
  let known = false;
  let prevAt: number | null = null;
  events.forEach((e, i) => {
    const next = events[i + 1];
    const transition = legacy
      ? LEGACY_TRANSITIONS.has(e.type) &&
        // Before D33 a fan-out logged the step's own event just before packet.fanned_out.
        !(e.type === "node.done" && next?.type === "packet.fanned_out" && next.node === e.node)
      : !!e.patch && ("state" in e.patch || "cursor" in e.patch);
    if (!transition) {
      if (e.type === "step.retry") {
        const d = (e.detail ?? {}) as { attempt?: number; wait?: number; error?: string };
        retries.push({
          attempt: d.attempt ?? retries.length + 1,
          at: e.at,
          wait_ms: d.wait ?? null,
          error: d.error ?? null,
        });
      } else notes.push({ type: e.type, at: e.at, detail: e.detail });
      return;
    }
    const patch = e.patch ?? {};
    let changed = false;
    if ("data" in patch) {
      changed = !known || JSON.stringify(patch.data) !== JSON.stringify(data);
      data = patch.data;
      known = true;
    }
    const error = "error" in patch ? (patch.error as PacketRow["error"]) : looksLikeError(e.detail) ? e.detail : null;
    const started = prevAt ?? e.at;
    const first = steps.length === 0;
    steps.push({
      node: e.node ?? (first && e.type !== "packet.branched" ? "input" : null),
      event: e.type,
      state: (patch.state as string | undefined) ?? legacyState(e.type),
      started_at: started,
      at: e.at,
      duration_ms: e.at - started,
      attempts: error?.attempts ?? (retries.length ? (retries.at(-1)?.attempt ?? 0) + 1 : 1),
      retries,
      error: error ?? null,
      ...(known && { data }),
      changed,
      notes,
    });
    prevAt = e.at;
    retries = [];
    notes = [];
  });
  return { steps, pending: { retries, notes } };
}

function legacyState(type: string): string | null {
  const m = /^packet\.(accepted|rejected|filtered|dead_lettered|delivered)$/.exec(type);
  if (m) return m[1] as string;
  if (type === "packet.dropped") return "filtered";
  if (type === "packet.fanned_out") return BRANCHED;
  return null;
}

// ── shared dispatch and offline reads ────────────────────────────────────────

export const READ_OPS = ["packets", "packet", "dlq", "versions", "version", "diff", "proposals", "proposal"] as const;
export type ReadOp = (typeof READ_OPS)[number];

/**
 * Answer a read op against a journal database (the runner's own, or a read-only one). `current` is the version a
 * running runner gives new packets (D38); null when reading the journal alone.
 */
export function read(
  db: Database,
  op: ReadOp,
  args: Record<string, unknown>,
  pipeline: string,
  current: number | null = null,
): unknown {
  if (op === "packets") return listPackets(db, args);
  if (op === "dlq") return listDlq(db, args);
  if (op === "versions") return listVersions(db, current);
  if (op === "version") return getVersion(db, versionArg(args.version, "version"), pipeline);
  if (op === "diff") {
    return diffVersions(db, versionArg(args.from, "from"), versionArg(args.to, "to"), pipeline);
  }
  if (op === "proposals") return listProposals(db, args);
  if (op === "proposal") return getProposal(db, args.id, pipeline);
  const id = packetIdArg(args.packet_id, "packet");
  const trace = packetTrace(db, id);
  if (!trace) {
    throw new ControlError(
      "not_found",
      `no packet '${id}' in ${pipeline}`,
      `list packets with pipo packets ${pipeline}; a fan-out copy's id is <packet_id>:<branch>`,
    );
  }
  return trace;
}

/** Change proposals, newest first (§9.3, D45); an older journal without the table has none. */
function listProposals(db: Database, args: Record<string, unknown>): { proposals: ProposalSummary[] } {
  const state = args.state ?? undefined;
  if (state !== undefined && !(PROPOSAL_STATES as readonly unknown[]).includes(state)) {
    throw new ControlError(
      "bad_request",
      `\`state\` must be one of ${PROPOSAL_STATES.join(", ")}, got ${JSON.stringify(state)}`,
      "omit state to list every proposal",
    );
  }
  const limit = args.limit === undefined || args.limit === null ? undefined : Number(args.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)) {
    throw new ControlError("bad_request", `\`limit\` must be a whole number from 1 to ${MAX_LIMIT}`, "omit it for 50");
  }
  return { proposals: readProposals.list(db, { state: state as ProposalState | undefined, limit }) };
}

function getProposal(db: Database, id: unknown, pipeline: string): Proposal {
  if (typeof id !== "string" || !id) {
    throw new ControlError(
      "bad_request",
      "proposal needs `id`: the proposal's id",
      `pipo proposals ${pipeline} lists them`,
    );
  }
  const p = readProposals.get(db, id);
  if (!p) {
    throw new ControlError(
      "not_found",
      `${pipeline} has no proposal ${id}`,
      `list them with pipo proposals ${pipeline}`,
    );
  }
  return p;
}

/** Remove payloads (packet data and result, the data after each step) from a read result, recursively. */
export function withholdPayloads(value: unknown, reason: string): unknown {
  if (Array.isArray(value)) return value.map((v) => withholdPayloads(v, reason));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "data" || k === "result") out[k] = `[withheld: ${reason}]`;
    else out[k] = withholdPayloads(v, reason);
  }
  return out;
}

/**
 * Redaction for reading a journal without its runner (D34): the secrets every stored version declares, resolved
 * from `env:` only (no `op` prompt from a read). When any can't be resolved here, payloads are withheld, since the
 * values they might contain can't be masked; errors and events were already redacted by the runner when written.
 */
export async function offlineRedaction(
  db: Database,
): Promise<{ redact: (s: string) => string; withheld: string | null }> {
  const refs: Record<string, string> = {};
  for (const { version, source } of db.query("SELECT version, source FROM versions").all() as {
    version: number;
    source: string;
  }[]) {
    try {
      const p = load(source).value as Pipeline | undefined;
      for (const [name, ref] of Object.entries(p?.secrets ?? {})) refs[`${name}@${version}`] = String(ref);
    } catch {}
  }
  const resolvable: Record<string, string> = {};
  const missing: string[] = [];
  for (const [key, ref] of Object.entries(refs)) {
    const name = key.slice(0, key.lastIndexOf("@"));
    if (ref.startsWith("env:") && process.env[ref.slice(4)] !== undefined) resolvable[key] = ref;
    else if (!missing.includes(name)) missing.push(name);
  }
  const secrets = await Secrets.resolve(resolvable);
  return {
    redact: (s) => secrets.redact(s),
    withheld: missing.length
      ? `secret(s) ${missing.join(", ")} can't be resolved without the runner; start the pipeline to see payloads`
      : null,
  };
}

/** Open a journal read-only; null when it doesn't exist. */
export function openJournalReadOnly(path: string): Database | null {
  if (!existsSync(path)) return null;
  return openReadonly(path);
}

/**
 * A read op answered from `<home>/pipelines/<name>/journal.db` while no runner runs, redacted like the runner's
 * answers. Null when the pipeline has no journal.
 */
export async function offlineRead(
  path: string,
  op: ReadOp,
  args: Record<string, unknown>,
  pipeline: string,
): Promise<{ result: unknown; withheld: string | null } | null> {
  const db = openJournalReadOnly(path);
  if (!db) return null;
  try {
    const { redact, withheld } = await offlineRedaction(db);
    const raw = read(db, op, args, pipeline);
    const redacted = redactDeep(raw, redact);
    return { result: withheld ? withholdPayloads(redacted, withheld) : redacted, withheld };
  } finally {
    db.close();
  }
}
