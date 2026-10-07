// The dry run of a change proposal (docs/spec.md §9.3 step 3, D48): `agent.verify: last N` replays the last N
// delivered packets through the proposed definition, in memory, with every side effect mocked.
//
// Nothing here writes: the real journal is only read (the packets and their trails), and no throwaway journal is
// needed because a replay never leaves this process's memory. Outputs and taps are recorded, not called; agent nodes
// and `transform: http` are stubbed from the packet's own trail (what they returned when it was delivered); filters,
// routes, `map` and `fn` transforms run for real (`fn` modules are trusted code, read as they are now, D38). A crash
// mid-run therefore leaves the proposal `validated` and the journal untouched; only the caller's final state move
// (`Proposals.dryRun`) is written.
//
// The per-packet replay (`replayPacket`) is shared with `pipo test` (testing.ts, §10.3): the same walk through the
// graph, with the caller deciding what a mocked tap, a stubbed node, a mocked write and a failure mean.
//
// The divergence rule ("diverge beyond the schema"): a packet that was delivered diverges when, under the proposed
// version, it is rejected by the input's schema or `validate`, any step fails (whatever the policy's `then`, except a
// tap with `then: continue`), a stubbed result no longer matches the agent node's schema, a stubbed node has nothing
// recorded to replay, or it fails `output.validate` or its `output.with` can't be rendered. Different values, and
// packets the proposed version filters, are not divergence; they are reported.

import type { Database } from "bun:sqlite";
import { dirname } from "node:path";
import {
  evaluate,
  load as loadSource,
  MAX_VERIFY,
  type Node,
  nodeKind,
  type Pipeline,
  parseVerify,
  render,
} from "@pipo/spec";
import { OUTPUT_STEP } from "./journal";
import { resolveKey } from "./output-key";
import { compile, type Plan } from "./plan";
import { type ResolvedPolicy, resolvePolicy } from "./policy";

export { MAX_VERIFY, parseVerify };

/** How long one `fn` call may take in a dry run before the packet counts as diverged. */
export const DRY_RUN_STEP_TIMEOUT = 30_000;
/** Steps one replayed packet may take (all copies together); loops are bounded by `pipo check`, this is a backstop. */
const MAX_STEPS = 10_000;
/** Reasons kept per packet and characters per message, so a report stays small in the journal. */
const MAX_REASONS = 5;
const MAX_MESSAGE = 500;

export type DryRunOutcome = "passed" | "filtered" | "diverged";

export interface DivergenceReason {
  /** The journal unit: the packet, or `packet_id:<branch>` for a fan-out copy (D22). */
  unit: string;
  /** Where: `input`, a node id, or `output`. */
  step: string;
  code:
    | "input.rejected"
    | "node.failed"
    | "loop.max"
    | "agent.schema"
    | "unverifiable"
    | "output.invalid"
    | "output.render"
    | "too_many_steps";
  message: string;
}

export interface DryRunPacket {
  packet_id: string;
  /** The version that delivered it. */
  version: number;
  outcome: DryRunOutcome;
  /** Output keys the proposed version would write (mocked), one per delivered unit. */
  writes: string[];
  /** Taps that would have run (mocked), as `<unit>@<node>`. */
  taps: number;
  /** Node results replayed from the trail (agent nodes, `transform: http`). */
  stubbed: number;
  reasons?: DivergenceReason[];
  /** Tap failures that `then: continue` let through: reported, not divergence. */
  warnings?: DivergenceReason[];
}

export interface DryRunReport {
  verify: string;
  /** N from `last N`. */
  requested: number;
  base_version: number;
  /** The version number the proposal would get (`meta.version` in the replay). */
  version: number;
  replayed: number;
  passed: number;
  filtered: number;
  diverged: number;
  /** Delivered packets whose input is gone (retention cleared it, D39) are skipped and counted here, not in N. */
  skipped: number;
  packets: DryRunPacket[];
  started_at: number;
  ms: number;
}

/** The proposal can't be replayed at all (a schema file or fn module that won't load): the proposal is rejected. */
export class DryRunPrepareError extends Error {}

export interface DryRunArgs {
  /** The real journal, read only. */
  db: Database;
  source: string;
  base_version: number;
  verify: string;
  /** The pipeline file: `fn` modules and schema files are read from its folder (D38). */
  file?: string;
  /** Folder for relative paths when there is no file. */
  dir?: string;
  /** `env` in expressions (engine.env_allow). */
  env?: Record<string, string>;
  now?: () => number;
  stepTimeoutMs?: number;
}

interface Delivered {
  id: string;
  version: number;
  trigger: string;
  source: string;
  received_at: number;
}

const unjson = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(String(v)));
const clip = (s: string) => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}…` : s);

/** The newest delivered packets, newest first, up to `n` that still have their input in the trail. */
function deliveredPackets(db: Database, n: number): { picked: (Delivered & { input: unknown })[]; skipped: number } {
  const picked: (Delivered & { input: unknown })[] = [];
  let skipped = 0;
  const page = db.query(
    `SELECT id, version, trigger, source, received_at, data IS NULL AS cleared FROM packets
     WHERE branch = '' AND state = 'delivered' ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
  );
  const accepted = db.query(
    "SELECT patch FROM events WHERE packet_id = ? AND type = 'packet.accepted' AND patch IS NOT NULL ORDER BY seq LIMIT 1",
  );
  // Skipped packets don't count towards N, but the scan is bounded so a journal emptied by retention stays cheap.
  for (let offset = 0; picked.length < n && offset < n * 4; offset += n) {
    const rows = page.all(n, offset) as (Delivered & { cleared: number })[];
    for (const { cleared, ...r } of rows) {
      if (picked.length >= n) break;
      // A payload retention cleared (D39) is gone for good: its copy in the trail is not used either.
      const e = cleared ? null : (accepted.get(r.id) as { patch: string } | null);
      const patch = e ? (unjson(e.patch) as { data?: unknown } | null) : null;
      if (!patch || !Object.hasOwn(patch, "data")) skipped++;
      else picked.push({ ...r, input: patch.data });
    }
    if (rows.length < n) break;
  }
  return { picked, skipped };
}

/** What a node returned when the packet was delivered, by unit and node, in order (one entry per pass). */
function recordedResults(db: Database, root: string): Map<string, unknown[]> {
  const rows = db
    .query(
      `SELECT packet_id, node, patch FROM events
       WHERE (packet_id = ? OR (packet_id >= ? AND packet_id < ?)) AND patch IS NOT NULL
         AND type IN ('node.done', 'node.looped', 'packet.fanned_out') ORDER BY seq`,
    )
    .all(root, `${root}:`, `${root};`) as { packet_id: string; node: string | null; patch: string }[];
  const out = new Map<string, unknown[]>();
  for (const r of rows) {
    const patch = unjson(r.patch) as { data?: unknown } | null;
    if (!r.node || !patch || !Object.hasOwn(patch, "data")) continue;
    const k = `${r.packet_id}\0${r.node}`;
    out.set(k, [...(out.get(k) ?? []), patch.data]);
  }
  return out;
}

/** Replay up to N delivered packets through `source`. Throws DryRunPrepareError when the source can't be compiled. */
export async function dryRun(args: DryRunArgs): Promise<DryRunReport> {
  const now = args.now ?? Date.now;
  const started = now();
  const requested = parseVerify(args.verify);
  if (requested === null) {
    throw new DryRunPrepareError(
      `agent.verify '${args.verify}' of v${args.base_version} is not 'last N' with N from 1 to ${MAX_VERIFY}`,
    );
  }
  const loaded = loadSource(args.source, args.file);
  const pipeline = loaded.value as Pipeline | undefined;
  if (loaded.diagnostics.length || !pipeline) throw new DryRunPrepareError("the proposed source does not parse");
  const version = args.base_version + 1;
  const dir = args.dir ?? (args.file ? dirname(args.file) : process.cwd());
  let plan: Plan;
  try {
    plan = await compile(pipeline, version, dir);
  } catch (e) {
    throw new DryRunPrepareError(`the proposed version can't be prepared: ${(e as Error).message}`);
  }
  const env = args.env ?? {};
  // Secret values are never needed: nothing is sent. A placeholder renders like the redacted value would.
  const secrets = Object.fromEntries(Object.keys(pipeline.secrets ?? {}).map((k) => [k, "***"]));
  const timeout = args.stepTimeoutMs ?? DRY_RUN_STEP_TIMEOUT;

  const { picked, skipped } = deliveredPackets(args.db, requested);
  const packets: DryRunPacket[] = [];
  for (const p of picked) {
    packets.push(await replay(args.db, plan, p, { env, secrets, timeout }));
  }
  const count = (o: DryRunOutcome) => packets.filter((p) => p.outcome === o).length;
  return {
    verify: args.verify,
    requested,
    base_version: args.base_version,
    version,
    replayed: packets.length,
    passed: count("passed"),
    filtered: count("filtered"),
    diverged: count("diverged"),
    skipped,
    packets,
    started_at: started,
    ms: now() - started,
  };
}

async function replay(
  db: Database,
  plan: Plan,
  p: Delivered & { input: unknown },
  opts: { env: Record<string, string>; secrets: Record<string, string>; timeout: number },
): Promise<DryRunPacket> {
  const out: DryRunPacket = {
    packet_id: p.id,
    version: p.version,
    outcome: "filtered",
    writes: [],
    taps: 0,
    stubbed: 0,
  };
  const reasons: DivergenceReason[] = [];
  const warnings: DivergenceReason[] = [];
  let recorded: Map<string, unknown[]> | undefined;
  const used = new Map<string, number>();
  const pipeline = plan.pipeline;

  const stub = (u: ReplayUnit, id: string, what: string): unknown => {
    recorded ??= recordedResults(db, p.id);
    const k = `${u.id}\0${id}`;
    const list = recorded.get(k) ?? [];
    const n = used.get(k) ?? 0;
    if (n >= list.length) {
      throw new ReplayAbort({
        step: id,
        code: "unverifiable",
        message: `${what} '${id}' has no recorded result for ${u.id}${n ? ` beyond pass ${n}` : ""} (it did not run there when the packet was delivered), and a dry run never calls it`,
      });
    }
    used.set(k, n + 1);
    out.stubbed++;
    return structuredClone(list[n]);
  };
  const reason = (unit: string, step: string, code: DivergenceReason["code"], message: string) => ({
    unit,
    step,
    code,
    message: clip(message),
  });

  await replayPacket(plan, p, {
    // Recorded results are per pass, so an attempt that fails is not retried: it diverges.
    retry: false,
    env: opts.env,
    secrets: opts.secrets,
    timeout: opts.timeout,
    rejected: (f) => reasons.push(reason(p.id, "input", "input.rejected", f.message)),
    tap: (u, _id, node, s) => {
      // Mocked: rendered (so a template the proposal broke still fails) but never run, `fn` taps included.
      if (!plan.fns[node.tap as string]) render(node.with ?? {}, s.ctx(u.data));
      out.taps++;
    },
    call: (u, id, node, kind, s) => {
      if (kind === "transform") {
        render(node.with ?? {}, s.ctx(u.data));
        return stub(u, id, `transform: ${node.transform}`);
      }
      const data = stub(u, id, "agent node");
      const mismatch = plan.agentSchemas[id]?.validate(data);
      if (mismatch) {
        throw new ReplayAbort({
          step: id,
          code: "agent.schema",
          message: `the recorded agent output does not match ${plan.agentSchemas[id]?.path}: ${mismatch}`,
        });
      }
      return data;
    },
    write: (u, s) => {
      try {
        render(pipeline.output.with ?? {}, s.ctx(u.data));
      } catch (e) {
        throw new ReplayAbort({
          step: "output",
          code: "output.render",
          message: `output.with can't be rendered: ${(e as Error).message}`,
        });
      }
    },
    continued: (u, f) => warnings.push(reason(u.id, f.step, "node.failed", f.message)),
    ended: (u, end) => {
      if (end.kind === "written") out.writes.push(u.id);
      else if (end.kind === "aborted") {
        reasons.push(reason(u.id, end.reason.step, end.reason.code as DivergenceReason["code"], end.reason.message));
      } else if (end.kind === "failed") {
        // Whatever the policy's `then`, a step that fails diverges.
        const f = end.failure;
        if (f.code === "loop.max" || f.code === "output.invalid") reasons.push(reason(u.id, f.step, f.code, f.message));
        else reasons.push(reason(u.id, f.step, "node.failed", `${f.message} (then: ${f.policy.then})`));
      }
    },
  });

  if (reasons.length) {
    out.outcome = "diverged";
    out.reasons = reasons.slice(0, MAX_REASONS);
  } else out.outcome = out.writes.length ? "passed" : "filtered";
  if (warnings.length) out.warnings = warnings.slice(0, MAX_REASONS);
  return out;
}

// ── the replay core, shared with `pipo test` (testing.ts) ────────────────────────────────────────────────────────────

/** One journal unit in a replay: the packet, or a fan-out copy (`packet_id:<branch>`, D22). */
export interface ReplayUnit {
  id: string;
  root: string | null;
  branch: string;
  cursor: string;
  data: unknown;
  hops: number;
  iteration: number;
  /** The steps this unit ran, in order: node ids (a route as `<id>.<branch>` once it picked one), then `output`. */
  path: string[];
}

/** Thrown by a hook when a unit can't go on and no error policy applies (nothing to replay, a harness limit). */
export class ReplayAbort extends Error {
  constructor(readonly reason: { step: string; code: string; message: string; hint?: string }) {
    super(reason.message);
  }
}

/** A step that failed once its policy's retries ran out (`policy.then` says what the runner would do next). */
export interface ReplayFailure {
  /** A node id or `output`. */
  step: string;
  code: "node.failed" | "loop.max" | "output.invalid" | "output.failed";
  message: string;
  rule?: string;
  attempts: number;
  policy: ResolvedPolicy;
  /** The unit's data where it failed (a `loop.max` failure keeps the last pass's result, as the runner does). */
  data: unknown;
  meta: Record<string, unknown>;
}

export type ReplayEnd =
  | { kind: "written" }
  | { kind: "filtered"; at: string }
  | { kind: "branched"; copies: string[] }
  | { kind: "failed"; failure: ReplayFailure }
  | { kind: "aborted"; reason: ReplayAbort["reason"] };

/** What a hook gets for one attempt of a step. */
export interface ReplayScope {
  meta: Record<string, unknown>;
  attempt: number;
  /** The template context for `with:` blocks: data, meta, env and the (placeholder) secrets. */
  ctx: (data: unknown) => Record<string, unknown>;
}

export interface ReplayPacketInput {
  id: string;
  trigger: string;
  source: string;
  received_at: number;
  input: unknown;
}

export interface ReplayHooks {
  /** Run a failing step again up to its policy's `retry` (never waiting for backoff), or fail on the first attempt. */
  retry: boolean;
  env: Record<string, string>;
  secrets: Record<string, string>;
  /** Per `fn` call, in ms. */
  timeout: number;
  /** The input's schema or `validate` rejected the packet; nothing else runs. */
  rejected(f: {
    code: "input.schema" | "input.invalid";
    rule: string;
    message: string;
    meta: Record<string, unknown>;
  }): void;
  /** A unit was created (the packet, or a copy of `parent`), in creation order. */
  started?(u: ReplayUnit, parent: ReplayUnit | null): void;
  /** A tap was reached (mocked). Throw for a node error under the tap's `on_error`. */
  tap(u: ReplayUnit, id: string, node: Node, s: ReplayScope): void | Promise<void>;
  /** An agent node or a `transform` other than `map` and `fn.*`: return its result, or throw (a node error). */
  call(u: ReplayUnit, id: string, node: Node, kind: "agent" | "transform", s: ReplayScope): unknown;
  /** The unit passed `output.validate`: the mocked write. Throw for an output error under `output.on_error`. */
  write(u: ReplayUnit, s: ReplayScope): void | Promise<void>;
  /**
   * A step succeeded: the data leaving it (a route as `<id>.<branch>`, each loop pass, a filter that passed, a tap,
   * and `output` once written). For a trace; it can't change the replay.
   */
  stepped?(u: ReplayUnit, step: string, data: unknown): void;
  /** A tap failed and `then: continue` passed the data on unchanged. */
  continued(u: ReplayUnit, f: ReplayFailure): void;
  /** The unit ended: written (mocked), filtered, fanned out, failed after its policy, or aborted. */
  ended(u: ReplayUnit, end: ReplayEnd): void;
}

/** Attempts as `attempt` (policy.ts) runs them, without the backoff waits. A ReplayAbort is never retried. */
async function tries<T>(
  policy: ResolvedPolicy,
  retry: boolean,
  work: (attempt: number) => Promise<T> | T,
): Promise<{ ok: true; value: T; attempts: number } | { ok: false; error: Error; attempts: number }> {
  const max = retry ? policy.retry + 1 : 1;
  for (let n = 1; ; n++) {
    try {
      return { ok: true, value: await work(n), attempts: n };
    } catch (e) {
      if (e instanceof ReplayAbort) throw e;
      if (n >= max) return { ok: false, error: e instanceof Error ? e : new Error(String(e)), attempts: n };
    }
  }
}

/**
 * Replay one packet through `plan` in memory, as the runner runs it (spec §7.3): the input's schema and `validate`,
 * then filters, routes, loops, fan-out copies, `map` and `fn` transforms for real; taps, agent nodes, other transforms
 * and the output go through the hooks. Units run one after another in creation order, so a replay is deterministic.
 */
export async function replayPacket(plan: Plan, p: ReplayPacketInput, h: ReplayHooks): Promise<void> {
  const pipeline = plan.pipeline;
  const meta = (u: ReplayUnit, node: string, attempt = 1) => {
    const m = {
      packet_id: u.root ?? u.id,
      branch: u.branch,
      pipeline: pipeline.name,
      version: plan.version,
      node,
      trigger: p.trigger,
      source: p.source,
      received_at: p.received_at,
      attempt,
      hops: u.hops,
      iteration: u.iteration,
      key: u.id,
    };
    if (node === "output")
      m.key = resolveKey(pipeline.output, u.id, { data: u.data, meta: m, env: h.env, secrets: h.secrets });
    return m;
  };
  const scope = (u: ReplayUnit, node: string, attempt: number): ReplayScope => {
    const m = meta(u, node, attempt);
    return { meta: m, attempt, ctx: (data) => ({ data, meta: m, env: h.env, secrets: h.secrets }) };
  };
  const timed = async <T>(what: string, work: () => Promise<T> | T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${what} took longer than ${h.timeout} ms`)), h.timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  // Input: the schema and `validate` rules see the original payload.
  const root: ReplayUnit = {
    id: p.id,
    root: null,
    branch: "",
    cursor: "",
    data: p.input,
    hops: 0,
    iteration: 0,
    path: [],
  };
  const inMeta = meta(root, "input");
  const schemaError = plan.validateInput?.(p.input);
  if (schemaError) {
    return h.rejected({ code: "input.schema", rule: "schema", message: `schema: ${schemaError}`, meta: inMeta });
  }
  for (const rule of pipeline.input.validate ?? []) {
    let message: string | null = null;
    try {
      if (!evaluate(rule, { data: p.input, meta: inMeta, env: h.env })) message = `rule '${rule}' failed`;
    } catch (e) {
      message = `rule '${rule}' could not be evaluated: ${(e as Error).message}`;
    }
    if (message) return h.rejected({ code: "input.invalid", rule, message, meta: inMeta });
  }

  const queue: ReplayUnit[] = [];
  const fanOut = (parent: ReplayUnit, to: string[], data: unknown, hops: number) => {
    const copies = to.map((cursor): ReplayUnit => {
      const segment = cursor === OUTPUT_STEP ? "output" : cursor;
      const branch = parent.branch ? `${parent.branch}/${segment}` : segment;
      return {
        id: `${parent.root ?? parent.id}:${branch}`,
        root: parent.root ?? parent.id,
        branch,
        cursor,
        data,
        hops,
        iteration: parent.iteration,
        path: [],
      };
    });
    h.ended(parent, { kind: "branched", copies: copies.map((c) => c.id) });
    for (const c of copies) h.started?.(c, parent);
    queue.push(...copies);
  };
  const first = plan.next.get("input") ?? [];
  if (first.length === 1) {
    const u = { ...root, cursor: first[0] as string, data: structuredClone(p.input) };
    h.started?.(u, null);
    queue.push(u);
  } else {
    h.started?.(root, null);
    fanOut(root, first, p.input, 0);
  }

  let steps = 0;
  while (queue.length) {
    const u = queue.shift() as ReplayUnit;
    try {
      for (;;) {
        if (++steps > MAX_STEPS) {
          throw new ReplayAbort({ step: u.cursor, code: "too_many_steps", message: `more than ${MAX_STEPS} steps` });
        }
        if (u.cursor === OUTPUT_STEP) {
          await output(u);
          break;
        }
        const next = await step(u);
        if (next === "ended") break;
        if (Array.isArray(next)) {
          fanOut(u, next[0], next[1], u.hops + 1);
          break;
        }
      }
    } catch (e) {
      if (!(e instanceof ReplayAbort)) throw e;
      h.ended(u, { kind: "aborted", reason: e.reason });
    }
  }

  function fail(u: ReplayUnit, f: ReplayFailure): "ended" {
    h.ended(u, { kind: "failed", failure: f });
    return "ended";
  }

  async function output(u: ReplayUnit): Promise<void> {
    u.path.push("output");
    const out = pipeline.output;
    const m = meta(u, "output");
    for (const rule of out.validate ?? []) {
      let ok = false;
      let why = `rule '${rule}' failed`;
      try {
        ok = !!evaluate(rule, { data: u.data, meta: m, env: h.env, output: out });
      } catch (e) {
        why = `rule '${rule}' could not be evaluated: ${(e as Error).message}`;
      }
      if (!ok) {
        // Never retried: the same data fails the same way (spec §3.9).
        const policy = {
          ...resolvePolicy(undefined, undefined),
          then: out.on_invalid?.then ?? "dead_letter",
          message: out.on_invalid?.message,
        };
        fail(u, {
          step: "output",
          code: "output.invalid",
          rule,
          message: why,
          attempts: 1,
          policy,
          data: u.data,
          meta: m,
        });
        return;
      }
    }
    const policy = resolvePolicy(pipeline.errors, out.on_error);
    const run = await tries(policy, h.retry, (n) => h.write(u, scope(u, "output", n)));
    if (!run.ok) {
      const f = { message: run.error.message, attempts: run.attempts, policy, data: u.data, meta: m };
      fail(u, { step: "output", code: "output.failed", ...f });
      return;
    }
    h.stepped?.(u, "output", u.data);
    h.ended(u, { kind: "written" });
  }

  /** Run the node at `u.cursor`; move `u` on, or say it ended or fanned out ([consumers, data]). */
  async function step(u: ReplayUnit): Promise<"moved" | "ended" | [string[], unknown]> {
    const id = u.cursor;
    const node = pipeline.nodes?.[id] as Node | undefined;
    if (!node) {
      throw new ReplayAbort({ step: id, code: "node.failed", message: `no node '${id}' in the proposed version` });
    }
    u.path.push(id);
    const kind = nodeKind(node);
    const policy = resolvePolicy(pipeline.errors, node.on_error);
    // Filters and routes are deterministic: retrying them can't change the outcome (as in the runner).
    const effective = kind === "filter" || kind === "route" ? { ...policy, retry: 0 } : policy;
    const run = await tries(
      effective,
      h.retry,
      async (n): Promise<{ data: unknown; pass?: boolean; branch?: string }> => {
        const s = scope(u, id, n);
        const ctx = { data: u.data, meta: s.meta, env: h.env };
        switch (kind) {
          case "filter":
            return { data: u.data, pass: !!evaluate(node.filter as string, ctx) };
          case "route": {
            for (const [branch, expr] of Object.entries(node.route ?? {})) {
              if (expr === "else" || evaluate(expr, ctx)) return { data: u.data, branch };
            }
            return { data: u.data, branch: undefined };
          }
          case "tap":
            await h.tap(u, id, node, s);
            return { data: u.data };
          case "transform": {
            const t = node.transform as string;
            const fn = plan.fns[t];
            let data: unknown;
            if (fn) data = await timed(`${t} at ${id}`, () => fn(structuredClone(u.data), s.meta));
            else if (t === "map") data = (render(node.with ?? {}, s.ctx(u.data)) as Record<string, unknown>).data;
            else data = await h.call(u, id, node, "transform", s);
            if (data === undefined) throw new Error(`${t} returned nothing; return the new data`);
            return { data };
          }
          case "agent":
            return { data: await h.call(u, id, node, "agent", s) };
          default:
            throw new Error(`node kind '${kind}' is not implemented`);
        }
      },
    );
    if (!run.ok) {
      const f: ReplayFailure = {
        step: id,
        code: "node.failed",
        message: run.error.message,
        attempts: run.attempts,
        policy,
        data: u.data,
        meta: meta(u, id),
      };
      if (kind === "tap" && policy.then === "continue") {
        h.continued(u, f);
        return advance(u, id, u.data);
      }
      return fail(u, f);
    }
    const value = run.value;
    if (value.pass === false) {
      h.ended(u, { kind: "filtered", at: id });
      return "ended";
    }
    if (node.loop) {
      if (!evaluate(node.loop.until, { data: value.data, meta: meta(u, id), env: h.env })) {
        if (u.iteration < node.loop.max) {
          h.stepped?.(u, id, value.data);
          u.cursor = node.loop.back_to;
          u.data = value.data;
          u.iteration++;
          u.hops++;
          return "moved";
        }
        return fail(u, {
          step: id,
          code: "loop.max",
          message: `loop reached max ${node.loop.max} without '${node.loop.until}'`,
          attempts: 1,
          policy: { ...policy, then: node.loop.then ?? "dead_letter" },
          data: value.data,
          meta: meta(u, id),
        });
      }
    }
    if (kind === "route") {
      if (!value.branch) {
        h.ended(u, { kind: "filtered", at: id });
        return "ended";
      }
      u.path[u.path.length - 1] = `${id}.${value.branch}`;
      return advance(u, `${id}.${value.branch}`, value.data);
    }
    return advance(u, id, value.data);
  }

  function advance(u: ReplayUnit, ref: string, data: unknown): "moved" | "ended" | [string[], unknown] {
    h.stepped?.(u, ref, data);
    const to = plan.next.get(ref) ?? [];
    if (!to.length) {
      h.ended(u, { kind: "filtered", at: ref });
      return "ended";
    }
    if (to.length > 1) return [to, data];
    u.cursor = to[0] as string;
    u.data = data;
    u.hops++;
    return "moved";
  }
}
