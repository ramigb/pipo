// The control ops a runner answers on its socket (docs/spec.md §7.2, D24). Each op maps onto a Runner method;
// anything the runner returns or logs goes through Secrets.redact (the server redacts every response).
import { load, type Pipeline } from "@pipo/spec";
import { IN_FLIGHT, OUTPUT_STEP, type PacketRow, type ReplayLeaf } from "../journal";
import { RESOLVE_ACTIONS, type ResolveAction, type Runner } from "../runner";
import { computeMetrics, computeStats } from "../stats";
import { ControlError, OPS, PROTOCOL } from "./protocol";
import { READ_OPS, read } from "./reads";
import type { Handled, Handler } from "./server";
import { versionArg } from "./versions";

const PAUSE_REASONS = ["manual", "agent"];
const MAX_EVENTS = 1000;
/** Explicit ids per replay or purge request; `all` has no limit. */
const MAX_IDS = 1000;
/** `all` commits this many packets per transaction, yielding in between so the runner keeps serving. */
const CHUNK = 200;
/** At most this many replayed packets are listed in a reply (the count is always exact). */
const LISTED = 100;

type ReplayItem = { packet_id: string; leaves: ReplayLeaf[] };

export function controlHandler(r: Runner): Handler {
  const hello = () => ({
    protocol: PROTOCOL,
    pipeline: r.pipeline.name,
    version: r.version,
    pid: process.pid,
    state: r.state,
    status: r.status,
    started_at: new Date(r.startedAt).toISOString(),
    socket: r.socket,
    ops: OPS,
  });
  const live = (op: string) => {
    if (r.state === "stopped" || r.state === "failed") {
      throw new ControlError(
        "invalid_state",
        `pipeline is ${r.state}; '${op}' needs a running pipeline`,
        "start it again",
      );
    }
  };

  const name = r.pipeline.name;
  // Versions are immutable, so each pinned pipeline is parsed once.
  const versions = new Map<number, Pipeline>();
  const pipelineOf = (v: number) => {
    let p = versions.get(v);
    if (!p) {
      p = load(r.journal.versionSource(v)).value as Pipeline;
      versions.set(v, p);
    }
    return p;
  };

  /** A packet in the dead-letter queue, or an error saying why `id` isn't one. */
  const dlqEntry = (id: string, op: "replay" | "purge"): PacketRow => {
    const row = r.journal.get(id);
    if (!row) {
      throw new ControlError(
        "not_found",
        `no packet '${id}' in ${name}`,
        `list the dead-letter queue with pipo dlq ${name}`,
      );
    }
    if (row.root) {
      throw new ControlError(
        "invalid_state",
        `${id} is a branch copy of ${row.root}; the dead-letter queue holds whole packets`,
        `${op} ${row.root} instead: it ${op === "replay" ? "replays the copies that failed" : "purges every copy"}`,
      );
    }
    if (row.state !== "dead_lettered") {
      const moving = (IN_FLIGHT as readonly string[]).includes(row.state) || row.state === "branched";
      throw new ControlError(
        "invalid_state",
        `packet ${id} is ${row.state}, not in the dead-letter queue`,
        moving
          ? `it is in flight (replayed already?); follow it with pipo inspect ${name} ${id}`
          : `pipo inspect ${name} ${id} shows what happened to it`,
      );
    }
    return row;
  };

  /**
   * Where each failed unit of a dead-lettered packet resumes (D33): the node it failed on, with the data it had
   * there; an output or delivery-check failure writes again (idempotent on its key), then checks again.
   */
  const planReplay = (id: string): ReplayItem => {
    dlqEntry(id, "replay");
    const leaves = r.journal.deadLeaves(id).map((leaf): ReplayLeaf => {
      const at = leaf.error?.node;
      const pinned = pipelineOf(leaf.version);
      const reset = leaf.error?.code === "loop.max" ? { iteration: 0 } : {};
      if (at === "output" || at === "delivered")
        return { id: leaf.id, cursor: OUTPUT_STEP, state: "writing", ...reset };
      if (at && pinned.nodes?.[at]) return { id: leaf.id, cursor: at, state: "processing", ...reset };
      throw new ControlError(
        "invalid_state",
        `can't tell where packet ${leaf.id} failed (${at ? `'${at}' is not a step of v${leaf.version}` : "its error names no step"}), so it can't be replayed`,
        `purge it (pipo dlq purge ${name} ${id}) and push its data again`,
      );
    });
    if (!leaves.length) {
      throw new ControlError(
        "internal",
        `packet ${id} is dead-lettered but none of its copies is`,
        "see the runner log",
      );
    }
    return { packet_id: id, leaves };
  };

  const commitReplay = (items: ReplayItem[], by: string) => {
    if (!items.length) return;
    try {
      r.journal.replay(items, by);
    } catch (e) {
      throw new ControlError(
        "invalid_state",
        (e as Error).message,
        `list the dead-letter queue again: pipo dlq ${name}`,
      );
    }
    r.requeue(items.flatMap((i) => i.leaves.map((l) => l.id)));
  };

  const commitPurge = (ids: string[], by: string) => {
    if (!ids.length) return;
    try {
      r.journal.purge(ids, by);
    } catch (e) {
      throw new ControlError(
        "invalid_state",
        (e as Error).message,
        `list the dead-letter queue again: pipo dlq ${name}`,
      );
    }
  };

  const deadIds = () =>
    (
      r.journal.db.query("SELECT id FROM packets WHERE state = 'dead_lettered' AND branch = '' ORDER BY id").all() as {
        id: string;
      }[]
    ).map((x) => x.id);

  const running = () => r.state === "active" || r.state === "paused";

  const ops: Record<string, (args: Record<string, unknown>) => Handled | Promise<Handled>> = {
    hello: () => ({ result: hello() }),

    status: () => {
      live("status");
      return {
        result: {
          ...hello(),
          paused_reason: r.state === "paused" ? (r.pauseReason ?? "manual") : null,
          stats: {
            ...computeStats(r.journal, r.startedAt),
            // Per-node latency over the latest completed steps and the oldest pending packet's age (§7.6, D54).
            ...computeMetrics(r.journal, Object.keys(r.pipeline.nodes ?? {})),
            stalled: r.stallInfo,
            // USD spent on agent calls in the current budget day (§3.11, D37), and when a `budget` pause resumes.
            agent_spend_today: r.agentSpendToday(),
          },
          budget_resumes_at: r.budgetResumesAt,
          note: r.stallInfo ? `stalled at '${r.stallInfo.node}'` : null,
          awaiting_ack: r.awaitingAck,
          input: r.address ?? null,
          listen: r.port ?? null,
          last_seq: r.journal.lastSeq(),
        },
      };
    },

    pause: (args) => {
      const reason = args.reason ?? "manual";
      if (typeof reason !== "string" || !PAUSE_REASONS.includes(reason)) {
        throw new ControlError(
          "bad_request",
          `pause reason must be one of ${PAUSE_REASONS.join(", ")}`,
          '{"op":"pause","args":{"reason":"manual"}}',
        );
      }
      if (r.state === "paused") return { result: { state: r.state, already: true } };
      if (r.state !== "active") {
        throw new ControlError(
          "invalid_state",
          `cannot pause: pipeline is ${r.state}`,
          "pause works while it is active",
        );
      }
      r.pause(reason);
      return { result: { state: r.state, already: false } };
    },

    resume: () => {
      if (r.state === "active") return { result: { state: r.state, already: true } };
      if (r.state !== "paused") {
        throw new ControlError(
          "invalid_state",
          `cannot resume: pipeline is ${r.state}`,
          "resume works while it is paused",
        );
      }
      r.resume();
      return { result: { state: r.state, already: false } };
    },

    drain: () => {
      if (r.state === "draining") return { result: { state: r.state, already: true } };
      if (r.state !== "active" && r.state !== "paused") {
        throw new ControlError("invalid_state", `cannot drain: pipeline is ${r.state}`, "drain works while it runs");
      }
      // Reply first: draining ends with the socket closing.
      return { result: { state: "draining", already: false }, after: () => void r.drain() };
    },

    stop: () => {
      live("stop");
      return { result: { state: "stopping" }, after: () => void r.stop() };
    },

    push: async (args) => {
      if (!("data" in args) || args.data === undefined) {
        throw new ControlError("bad_request", "push needs `data`", '{"op":"push","args":{"data":{"name":"Ada"}}}');
      }
      const source = args.source ?? "control";
      if (typeof source !== "string" || source.length > 200) {
        throw new ControlError(
          "bad_request",
          "`source` must be a string of at most 200 characters",
          "e.g. cli, ui, mcp",
        );
      }
      const res = await r.intake(args.data, { trigger: "push", source });
      if (res.status === "accepted") return { result: { packet_id: res.packet_id, state: "accepted" } };
      if (res.status === "rejected") {
        throw new ControlError(
          "rejected",
          res.message,
          "the packet failed input validation and is journaled as rejected; fix the data and push it again",
          res.packet_id,
        );
      }
      throw new ControlError("unavailable", res.reason, unavailableHint(res.reason));
    },

    ack: async (args) => {
      const id = args.packet_id;
      if (typeof id !== "string" || !id) {
        throw new ControlError("bad_request", "ack needs `packet_id`", '{"op":"ack","args":{"packet_id":"01J…"}}');
      }
      const by = typeof args.by === "string" ? args.by.slice(0, 200) : "control";
      return { result: await r.ack(id, by) };
    },

    events: (args) => {
      const after = args.after_seq ?? 0;
      const limit = args.limit ?? 100;
      if (!Number.isInteger(after) || (after as number) < 0) {
        throw new ControlError(
          "bad_request",
          "`after_seq` must be a whole number ≥ 0",
          "use the last seq you saw, or 0",
        );
      }
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_EVENTS) {
        throw new ControlError("bad_request", `\`limit\` must be between 1 and ${MAX_EVENTS}`, "page with after_seq");
      }
      const events = r.journal.eventsAfter(after as number, limit as number);
      const last = events.at(-1)?.seq ?? (after as number);
      return { result: { events, last_seq: last, more: last < r.journal.lastSeq() } };
    },
  };

  for (const op of READ_OPS) {
    ops[op] = (args) => {
      live(op);
      return { result: read(r.journal.db, op, args, name, r.version) };
    };
  }

  // Versions (§9.3, D38): `apply` takes a whole definition, `rollback` an earlier version's; both store a new version.
  ops.apply = async (args) => {
    if (typeof args.source !== "string" || !args.source.trim()) {
      throw new ControlError(
        "bad_request",
        "apply needs `source`: the whole .pipo definition",
        '{"op":"apply","args":{"source":"pipo: 1\\n…","reason":"why"}}',
      );
    }
    const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason.slice(0, 500) : "applied";
    return { result: await r.applyVersion(args.source, { author: byArg(args), reason }) };
  };

  ops.rollback = async (args) => {
    const version = versionArg(args.version, "version");
    return { result: await r.rollback(version, byArg(args)) };
  };

  // §9.3 step 4 (D49): a stored change proposal becomes the next version. One that still needs its dry run (D48) is
  // dry-run first; when that diverges, the reply is the proposal, now `rejected`.
  ops.apply_proposal = async (args) => {
    if (typeof args.id !== "string" || !args.id) {
      throw new ControlError(
        "bad_request",
        "apply_proposal needs `id`: the proposal's id",
        '{"op":"apply_proposal","args":{"id":"pr_01J…","by":"cli"}}',
      );
    }
    return { result: await r.applyProposal(args.id, byArg(args)) };
  };

  // §9.3 (D51): propose → validate → dry run when the base requires one → apply at the safe point, unless held.
  ops.propose = async (args) => {
    const example =
      '{"op":"propose","args":{"source":"pipo: 1\\n…","base_version":1,"reason":"why","author":"agent-ops","author_kind":"agent"}}';
    const kind = args.author_kind ?? "human";
    if (kind !== "agent" && kind !== "human") {
      throw new ControlError("bad_request", "`author_kind` must be agent or human", example);
    }
    if (args.apply !== undefined && typeof args.apply !== "boolean") {
      throw new ControlError("bad_request", "`apply` must be true or false", example);
    }
    const author = typeof args.author === "string" && args.author ? args.author : byArg(args);
    let p = r.proposals.propose({
      source: args.source as string,
      base_version: args.base_version as number | string,
      reason: args.reason as string,
      author,
      author_kind: kind,
    });
    p = await r.proposals.dryRunIfRequired(p.id, { by: "dry-run" });
    if ((p.state !== "validated" && p.state !== "verified") || args.apply === false) return { result: p };
    try {
      await r.applyProposal(p.id, author);
    } catch (e) {
      // The proposal is stored; say why it wasn't applied instead of losing it.
      if (!(e instanceof ControlError)) throw e;
      return { result: { ...r.proposals.get(p.id), apply_error: e.body() } };
    }
    return { result: r.proposals.get(p.id) };
  };

  ops.reject_proposal = (args) => {
    if (typeof args.id !== "string" || !args.id) {
      throw new ControlError(
        "bad_request",
        "reject_proposal needs `id`: the proposal's id",
        '{"op":"reject_proposal","args":{"id":"pr_01J…","reason":"why","by":"cli"}}',
      );
    }
    if (typeof args.reason !== "string" || !args.reason.trim()) {
      throw new ControlError("bad_request", "reject_proposal needs `reason`", "say why it is rejected");
    }
    return { result: r.proposals.markRejected(args.id, { by: byArg(args), reason: args.reason.slice(0, 2000) }) };
  };

  // Packets waiting for the agent (`then: agent`, `agent.on_stall: handle`; §9, D50): retry, dead_letter or drop.
  ops.resolve = (args) => {
    const example = '{"op":"resolve","args":{"ids":["01J…"],"action":"retry","by":"agent-ops","by_kind":"agent"}}';
    const action = args.action;
    if (typeof action !== "string" || !(RESOLVE_ACTIONS as readonly string[]).includes(action)) {
      throw new ControlError("bad_request", `resolve needs \`action\`: one of ${RESOLVE_ACTIONS.join(", ")}`, example);
    }
    if (args.ids !== undefined && args.packet_id !== undefined) {
      throw new ControlError("bad_request", "resolve takes `ids` or `packet_id`, not both", example);
    }
    const ids = args.ids ?? (args.packet_id === undefined ? undefined : [args.packet_id]);
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !id || id.length > 400)) {
      throw new ControlError("bad_request", "resolve needs `ids` (unit ids: packet ids or copy ids)", example);
    }
    if (ids.length > MAX_IDS) {
      throw new ControlError("bad_request", `at most ${MAX_IDS} ids per resolve`, "split the list");
    }
    const kind = args.by_kind ?? null;
    if (kind !== null && kind !== "agent" && kind !== "human") {
      throw new ControlError("bad_request", "`by_kind` must be agent or human", example);
    }
    if (args.reason !== undefined && typeof args.reason !== "string") {
      throw new ControlError("bad_request", "`reason` must be a string", example);
    }
    const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason.slice(0, 2000) : null;
    return {
      result: r.resolve([...new Set(ids as string[])], action as ResolveAction, {
        by: byArg(args),
        by_kind: kind,
        reason,
      }),
    };
  };

  ops.replay = async (args) => {
    if (!running()) {
      throw new ControlError(
        "invalid_state",
        `cannot replay: pipeline is ${r.state}`,
        "replay works while the pipeline is active or paused; start it again (pipo start)",
      );
    }
    const target = targets(args, "replay");
    const by = r.redact(byArg(args));
    const view = (i: ReplayItem) => ({
      packet_id: i.packet_id,
      units: i.leaves.map((l) => ({ id: l.id, node: l.cursor })),
    });
    if (target !== "all") {
      // Validate every id before committing any, all in one synchronous block: a bad id replays nothing.
      const items = target.map(planReplay);
      commitReplay(items, by);
      return { result: { replayed: items.length, packets: items.slice(0, LISTED).map(view), skipped: [] } };
    }
    // `all` is a snapshot: a packet that dead-letters again while this runs is not picked up a second time.
    const ids = deadIds();
    const packets: ReturnType<typeof view>[] = [];
    const skipped: { packet_id: string; error: string }[] = [];
    let replayed = 0;
    for (let i = 0; i < ids.length && running(); i += CHUNK) {
      const items: ReplayItem[] = [];
      for (const id of ids.slice(i, i + CHUNK)) {
        try {
          items.push(planReplay(id));
        } catch (e) {
          // Replayed or purged by someone else meanwhile: not an error for `all`.
          if (r.journal.get(id)?.state === "dead_lettered")
            skipped.push({ packet_id: id, error: (e as Error).message });
        }
      }
      commitReplay(items, by);
      replayed += items.length;
      for (const it of items) if (packets.length < LISTED) packets.push(view(it));
      await Bun.sleep(0);
    }
    return { result: { replayed, packets, skipped } };
  };

  ops.purge = async (args) => {
    live("purge");
    const target = targets(args, "purge");
    const by = r.redact(byArg(args));
    if (target !== "all") {
      for (const id of target) dlqEntry(id, "purge");
      commitPurge(target, by);
      return { result: { purged: target.length, packets: target.slice(0, LISTED) } };
    }
    const ids = deadIds();
    const packets: string[] = [];
    let purged = 0;
    for (let i = 0; i < ids.length && r.state !== "stopped" && r.state !== "failed"; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK).filter((id) => r.journal.get(id)?.state === "dead_lettered");
      commitPurge(chunk, by);
      purged += chunk.length;
      for (const id of chunk) if (packets.length < LISTED) packets.push(id);
      await Bun.sleep(0);
    }
    return { result: { purged, packets } };
  };

  return (op, args) => {
    const fn = ops[op];
    if (!fn) throw new ControlError("unknown_op", `unknown op '${op}'`, `ops: ${OPS.join(", ")}`);
    return fn(args);
  };
}

/** `ids` (packet ids) or `all: true`, never both; ids deduplicated. */
function targets(args: Record<string, unknown>, op: "replay" | "purge"): string[] | "all" {
  const example = `{"op":"${op}","args":{"ids":["01J…"]}} or {"op":"${op}","args":{"all":true}}`;
  if (args.all !== undefined && args.all !== false && args.all !== true) {
    throw new ControlError("bad_request", "`all` must be true or false", example);
  }
  const all = args.all === true;
  if (all && args.ids !== undefined)
    throw new ControlError("bad_request", `${op} takes \`ids\` or \`all\`, not both`, example);
  if (all) return "all";
  const ids = args.ids;
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !id || id.length > 400)) {
    throw new ControlError("bad_request", `${op} needs \`ids\` (packet ids) or \`all: true\``, example);
  }
  if (ids.length > MAX_IDS) {
    throw new ControlError("bad_request", `at most ${MAX_IDS} ids per ${op}`, `split the list, or use all: true`);
  }
  return [...new Set(ids as string[])];
}

function byArg(args: Record<string, unknown>): string {
  return typeof args.by === "string" && args.by ? args.by.slice(0, 200) : "control";
}

function unavailableHint(reason: string): string {
  if (reason.startsWith("buffer full")) return "wait for pending packets to finish, or raise buffer.max";
  if (reason.includes("lifetime")) return "the pipeline reached its lifetime; start it again to accept packets";
  return "push works while the pipeline is active or paused";
}
