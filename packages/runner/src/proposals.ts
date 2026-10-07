// Agent change protocol: the proposal store and its validation (docs/spec.md §9.3, D4, D38, D45).
//
// A proposal is a whole proposed `.pipo` source against version N (the version store keeps sources too, so a
// proposal diffs, checks and applies like a version). `propose` validates it synchronously and stores it, with a
// pipeline-level `proposal.<state>` event, in one transaction, so a proposal is never half-recorded.
//
// States (every move is one transaction: the row's new state plus its event):
//
//   propose ──► validated ──► verified ──► applied
//      │            │  └──────────┼──────► applied   (when the base policy has no `agent.verify`)
//      ▼            ▼             ▼
//   rejected     rejected      rejected
//
// - validated: passed `pipo check`, the `agent.edit` path policy (agents only), and can be applied live (D38 bound
//   changes, runner gaps); its base was the latest version when it was made.
// - verified:  the dry run (`agent.verify: last N`, `dryRun`, dryrun.ts, D48) passed. Required before apply when
//   `verify` was set on the base version for an agent's proposal; `propose` and `apply_proposal` both run it, when it is
//   still missing, through `dryRunIfRequired`.
// - applied:   `Runner.applyProposal` (D49) stores version N+1 and calls `markApplied` inside the same journal
//   transaction (`journal.atomically`), so a crash leaves either both or neither; N+1 must follow the base directly.
// - rejected:  at propose time (stale base, check failure, path policy …), or later through `markRejected` (a
//   diverging dry run, a base that went stale before apply, a human's reject).
//
// `then: agent` and the engine (REST, control ops, `pipo proposals`) read through `get`/`list`, or `readProposals`
// on a read-only journal (D34). Stored sources are the author's text (secret references, not values), like versions;
// reasons, diagnostics and events go through `redact`, and responses must be redacted by whoever serves them (D24).
import type { Database } from "bun:sqlite";
import { check, type Diagnostic, load, type Pipeline } from "@pipo/spec";
import { ControlError, redactDeep } from "./control/protocol";
import { unifiedDiff, versionArg } from "./control/versions";
import { crashPoint } from "./crashpoint";
import { DryRunPrepareError, type DryRunReport, dryRun } from "./dryrun";
import { ulid } from "./ids";
import type { Journal } from "./journal";
import { gaps } from "./support";
import { boundChanges } from "./versions";

export type ProposalState = "validated" | "verified" | "applied" | "rejected";
export const PROPOSAL_STATES: readonly ProposalState[] = ["validated", "verified", "applied", "rejected"];
/** Who wrote it: an agent is held to `agent.control` and `agent.edit`; a human (CLI, API) is not (D45). */
export type AuthorKind = "agent" | "human";

/** Top-level keys an agent may never change, whatever `agent.edit` lists (§9.3; `agent_budget`, D47). */
export const AGENT_FORBIDDEN = ["output", "delivered", "secrets", "agent", "agent_budget"] as const;

export type ProblemCode =
  /** The base is not the latest version. */
  | "stale_base"
  /** The base version doesn't let agents edit (no `agent.control: true` or no `agent.edit`). */
  | "not_allowed"
  /** A change under `output`, `delivered`, `secrets`, `agent` or `agent_budget` by an agent (D47). */
  | "forbidden_path"
  /** A change no `agent.edit` pattern covers. */
  | "not_editable"
  /** Fails `pipo check` (the diagnostics are on the proposal). */
  | "invalid_pipeline"
  /** Changes what the runner binds at start, so it can't be applied live (D38). */
  | "bound_change"
  /** Uses a feature the runner refuses (support.ts). */
  | "unsupported"
  /** The source is the base's, byte for byte. */
  | "no_change";

export interface ProposalProblem {
  code: ProblemCode;
  message: string;
  hint: string;
  /** The changed path it is about (dotted), when there is one. */
  path?: string;
}

export interface ProposalInput {
  /** Version N the source was written against: `3` or `"v3"`. */
  base_version: number | string;
  /** The whole proposed `.pipo` source. */
  source: string;
  /** Agent id, or the human channel (`cli`, `api`). */
  author: string;
  author_kind: AuthorKind;
  reason: string;
}

export interface ProposalSummary {
  id: string;
  pipeline: string;
  base_version: number;
  author: string;
  author_kind: AuthorKind;
  reason: string;
  state: ProposalState;
  /** Dotted paths that differ from the base, by structure (a list is compared whole). */
  changed_paths: string[];
  added: number;
  removed: number;
  /** `agent.verify` of the base version, when a dry run is required before apply (agents only); else null. */
  verify: string | null;
  applied_version: number | null;
  /** Who made the latest decision (verify, apply, reject); null while only validated at propose time. */
  decided_by: string | null;
  created_at: number;
  decided_at: number | null;
}

export interface Proposal extends ProposalSummary {
  source: string;
  /** Unified diff from version N (3 lines of context), as `pipo diff` prints it. */
  diff: string;
  problems: ProposalProblem[];
  /** `pipo check` output on the proposed source (warnings too). */
  diagnostics: Diagnostic[];
  /** Why it was decided later (a reject's reason, a dry run's summary). */
  decision: string | null;
  /** The dry run's report. */
  verification: unknown;
}

/** Bounds on what a proposal may carry, so an author can't bloat the journal. */
export const MAX_SOURCE_BYTES = 1024 * 1024;
export const MAX_REASON_CHARS = 2000;
export const MAX_AUTHOR_CHARS = 200;

// ── changed paths and the edit policy (pure) ─────────────────────────────────

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isMap(a) && isMap(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
  }
  return false;
}

/**
 * The deepest paths where two parsed documents differ: a key added, removed or changed. Maps are walked key by key;
 * a list, a scalar or a change of type is one path, so `agent.edit` must cover a list as a whole. Key order and
 * formatting are not changes. Sorted.
 */
export function changedPaths(before: unknown, after: unknown): string[][] {
  const out: string[][] = [];
  const walk = (a: unknown, b: unknown, at: string[]) => {
    if (isMap(a) && isMap(b)) {
      for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])]) walk(a[k], b[k], [...at, k]);
    } else if (!same(a, b)) out.push(at);
  };
  walk(before, after, []);
  return out.sort((x, y) => x.join("\0").localeCompare(y.join("\0")));
}

/** `pattern` (dotted, `*` = exactly one segment) covers `path` when it matches a prefix of it: a pattern covers its subtree. */
export function covers(pattern: string, path: readonly string[]): boolean {
  const segs = pattern.split(".");
  return segs.length <= path.length && segs.every((s, i) => s === "*" || s === path[i]);
}

const dotted = (path: readonly string[]) => (path.length ? path.join(".") : "(the whole file)");

/** What an agent's change may not do under the base version's `agent:` policy (§9.3). Humans skip this (D45). */
export function agentPolicyProblems(base: Pipeline, changed: string[][]): ProposalProblem[] {
  const policy = base.agent;
  if (policy?.control !== true || !policy.edit?.length) {
    return [
      {
        code: "not_allowed",
        message: `${base.name} takes no change proposals from agents: its current version has ${policy?.control !== true ? "no `agent.control: true`" : "no `agent.edit` paths"}`,
        hint: "a human must add `agent: {control: true, edit: [...]}` to the pipeline file first; agents can't grant themselves edits",
      },
    ];
  }
  const out: ProposalProblem[] = [];
  for (const path of changed) {
    const at = dotted(path);
    if ((AGENT_FORBIDDEN as readonly string[]).includes(path[0] as string)) {
      out.push({
        code: "forbidden_path",
        path: at,
        message: `agents may never change \`${path[0]}\` (changed: ${at})`,
        hint: `output, delivered, secrets, agent and agent_budget are human-only, even if agent.edit lists them; leave ${path[0]} as in the base version`,
      });
    } else if (!policy.edit.some((p) => covers(p, path))) {
      out.push({
        code: "not_editable",
        path: at,
        message: `${at} is not covered by agent.edit (${policy.edit.join(", ")})`,
        hint: "change only paths agent.edit lists (a pattern covers its subtree; * is one segment), or ask a human to widen agent.edit",
      });
    }
  }
  return out;
}

// ── validation ───────────────────────────────────────────────────────────────

export interface Validation {
  changed: string[][];
  problems: ProposalProblem[];
  diagnostics: Diagnostic[];
  verify: string | null;
}

/**
 * Validate a proposed source against its base (§9.3 step 2). Every problem is reported, not just the first, so an
 * agent can fix them in one go. `file` is the pipeline's file: `fn` modules and schemas are read from its folder as
 * they are now (D38). Synchronous, so nothing in the runner interleaves between this read of the journal and the
 * store.
 */
export function validateProposal(args: {
  base: { version: number; source: string };
  latest: number;
  source: string;
  authorKind: AuthorKind;
  file?: string;
  home?: string;
}): Validation {
  const { base, latest, source, authorKind } = args;
  const problems: ProposalProblem[] = [];
  if (base.version !== latest) {
    problems.push({
      code: "stale_base",
      message: `the proposal is against v${base.version}, but the pipeline is at v${latest} now`,
      hint: `read v${latest} (pipo history, the version op) and propose your change against it`,
    });
  }
  if (source === base.source) {
    problems.push({
      code: "no_change",
      message: `the proposed source is the same as v${base.version}`,
      hint: "propose the full .pipo source with your change in it",
    });
  }
  const before = (load(base.source, args.file).value ?? {}) as Pipeline;
  const afterLoaded = load(source, args.file);
  const after = afterLoaded.diagnostics.length ? undefined : (afterLoaded.value as Pipeline | undefined);
  const changed = after === undefined ? [] : changedPaths(before, after);
  if (after !== undefined && authorKind === "agent") problems.push(...agentPolicyProblems(before, changed));

  const diagnostics = check(source, { file: args.file, home: args.home });
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length) {
    problems.push({
      code: "invalid_pipeline",
      message: `the proposed source fails pipo check with ${errors.length} error(s)`,
      hint: "fix the errors in `diagnostics` (pipo check on a local copy shows the same) and propose again",
    });
  } else if (after) {
    const bound = boundChanges(before, after);
    if (bound.length) {
      problems.push({
        code: "bound_change",
        message: `it changes ${bound.join(", ")}, which the runner binds when it starts, so it can't be applied live`,
        hint: "a human must put that change in the pipeline file and restart it (D38)",
      });
    }
    const missing = gaps(after).filter((g) => g.level === "refuse");
    if (missing.length) {
      problems.push({
        code: "unsupported",
        message: `it uses features this runner does not implement yet: ${missing.map((g) => `${g.feature} (${g.path})`).join(", ")}`,
        hint: "remove them from the proposal",
      });
    }
  }
  const verify = authorKind === "agent" ? (before.agent?.verify ?? null) : null;
  return { changed, problems, diagnostics, verify };
}

/** One line on a dry run's outcome: the decision of a verified or rejected proposal. */
export function dryRunSummary(r: DryRunReport): string {
  const skipped = r.skipped ? `, ${r.skipped} skipped (input gone under retention)` : "";
  if (!r.diverged) {
    return r.replayed
      ? `dry run passed (${r.verify}): ${r.replayed} delivered packet(s) replayed on the proposed version, ${r.passed} delivered, ${r.filtered} filtered${skipped}`
      : `dry run passed (${r.verify}): no delivered packets to replay${skipped}`;
  }
  const first = r.packets
    .filter((p) => p.outcome === "diverged")
    .slice(0, 3)
    .map((p) => {
      const why = p.reasons?.[0];
      return why ? `${p.packet_id} (${why.code} at ${why.step}: ${why.message})` : p.packet_id;
    });
  const more = r.diverged > first.length ? `, and ${r.diverged - first.length} more` : "";
  return `dry run diverged (${r.verify}) on ${r.diverged} of ${r.replayed} replayed packet(s): ${first.join("; ")}${more}`;
}

// ── the store ────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  pipeline: string;
  base_version: number;
  source: string;
  diff: string;
  added: number;
  removed: number;
  changed_paths: string;
  author: string;
  author_kind: AuthorKind;
  reason: string;
  state: ProposalState;
  problems: string;
  diagnostics: string;
  verify: string | null;
  verification: string | null;
  applied_version: number | null;
  decided_by: string | null;
  decision: string | null;
  created_at: number;
  decided_at: number | null;
}

const SUMMARY_COLUMNS =
  "id, pipeline, base_version, author, author_kind, reason, state, changed_paths, added, removed, verify, applied_version, decided_by, created_at, decided_at";

function decodeSummary(r: Row): ProposalSummary {
  return {
    id: r.id,
    pipeline: r.pipeline,
    base_version: r.base_version,
    author: r.author,
    author_kind: r.author_kind,
    reason: r.reason,
    state: r.state,
    changed_paths: JSON.parse(r.changed_paths),
    added: r.added,
    removed: r.removed,
    verify: r.verify,
    applied_version: r.applied_version,
    decided_by: r.decided_by,
    created_at: r.created_at,
    decided_at: r.decided_at,
  };
}

function decode(r: Row): Proposal {
  return {
    ...decodeSummary(r),
    source: r.source,
    diff: r.diff,
    problems: JSON.parse(r.problems),
    diagnostics: JSON.parse(r.diagnostics),
    decision: r.decision,
    verification: r.verification === null ? null : JSON.parse(r.verification),
  };
}

const hasTable = (db: Database) =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'proposals'").get();

/** Reads that work on any journal, also read-only and from before proposals (an empty list), for D34-style reads. */
export const readProposals = {
  list(db: Database, opts: { state?: ProposalState; limit?: number } = {}): ProposalSummary[] {
    if (!hasTable(db)) return [];
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    const rows = (
      opts.state
        ? db
            .query(`SELECT ${SUMMARY_COLUMNS} FROM proposals WHERE state = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
            .all(opts.state, limit)
        : db.query(`SELECT ${SUMMARY_COLUMNS} FROM proposals ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit)
    ) as Row[];
    return rows.map(decodeSummary);
  },
  get(db: Database, id: string): Proposal | null {
    if (!hasTable(db)) return null;
    const r = db.query("SELECT * FROM proposals WHERE id = ?").get(id) as Row | null;
    return r ? decode(r) : null;
  },
};

export interface ProposalStoreOptions {
  pipeline: string;
  /** The pipeline's file; its folder is where `fn` modules and schemas are read from (D38). */
  file?: string;
  /** Pipo home, for trust (P052). */
  home?: string;
  /** Secret redaction (Secrets.redact) for reasons, diagnostics and events. */
  redact?: (text: string) => string;
  now?: () => number;
  /** `env` in expressions during a dry run (engine.env_allow), as the runner sees it. */
  env?: Record<string, string>;
  /** How long one `fn` call may take in a dry run (default DRY_RUN_STEP_TIMEOUT). */
  dryRunStepTimeoutMs?: number;
}

const str = (v: unknown, key: string, max: number): string => {
  if (typeof v !== "string" || !v.trim()) {
    throw new ControlError("bad_request", `\`${key}\` must be a non-empty string`, `pass ${key} with the proposal`);
  }
  if (v.length > max) {
    throw new ControlError("bad_request", `\`${key}\` is longer than ${max} characters`, `shorten ${key}`);
  }
  return v;
};

export class Proposals {
  private readonly redact: (text: string) => string;
  private readonly now: () => number;
  /** Proposals whose dry run is in progress in this process, so two never run at once. */
  private readonly dryRunning = new Set<string>();

  constructor(
    readonly journal: Journal,
    readonly opts: ProposalStoreOptions,
  ) {
    this.redact = opts.redact ?? ((t) => t);
    this.now = opts.now ?? Date.now;
  }

  /**
   * Validate and store a proposal (§9.3 steps 1–2). Bad input (a missing field, an unknown base) throws a
   * ControlError and stores nothing; a proposal that fails validation is stored `rejected` with its problems, so the
   * audit trail keeps every attempt. One transaction writes the row and its `proposal.validated|rejected` event.
   */
  propose(input: ProposalInput): Proposal {
    const base = versionArg(input?.base_version, "base_version");
    if (typeof input.source !== "string" || !input.source.trim()) {
      throw new ControlError("bad_request", "`source` must be the whole proposed .pipo source", "pass source");
    }
    if (Buffer.byteLength(input.source) > MAX_SOURCE_BYTES) {
      throw new ControlError(
        "bad_request",
        `\`source\` is larger than ${MAX_SOURCE_BYTES} bytes`,
        "a .pipo file that big is not a pipeline definition; move data out of it",
      );
    }
    // Every caller-supplied text is redacted before it is stored or journaled.
    const author = this.redact(str(input.author, "author", MAX_AUTHOR_CHARS));
    const reason = str(input.reason, "reason", MAX_REASON_CHARS);
    if (input.author_kind !== "agent" && input.author_kind !== "human") {
      throw new ControlError(
        "bad_request",
        `\`author_kind\` must be agent or human, got ${JSON.stringify(input.author_kind ?? null)}`,
        "agents propose as agent; the CLI and API as human",
      );
    }
    const { pipeline } = this.opts;
    let baseSource: string;
    try {
      baseSource = this.journal.versionSource(base);
    } catch {
      const latest = this.journal.latestVersion()?.version ?? 0;
      throw new ControlError(
        "not_found",
        `${pipeline} has no version ${base}${latest ? ` (versions are v1 to v${latest})` : ""}`,
        `propose against the current version; pipo history ${pipeline} lists them`,
      );
    }
    const id = `pr_${ulid(this.now())}`;
    return this.journal.atomically(() => {
      const latest = this.journal.latestVersion()?.version ?? 0;
      const v = validateProposal({
        base: { version: base, source: baseSource },
        latest,
        source: input.source,
        authorKind: input.author_kind,
        file: this.opts.file,
        home: this.opts.home,
      });
      const d = unifiedDiff(baseSource, input.source, `${pipeline} v${base}`, `${pipeline} proposal ${id}`);
      const state: ProposalState = v.problems.length ? "rejected" : "validated";
      const changed = v.changed.map(dotted);
      const problems = redactDeep(v.problems, this.redact) as ProposalProblem[];
      const diagnostics = redactDeep(v.diagnostics, this.redact) as Diagnostic[];
      const safeReason = this.redact(reason);
      const at = this.now();
      this.journal.db
        .query(
          `INSERT INTO proposals (id, pipeline, base_version, source, diff, added, removed, changed_paths, author,
             author_kind, reason, state, problems, diagnostics, verify, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          pipeline,
          base,
          input.source,
          d.diff,
          d.added,
          d.removed,
          JSON.stringify(changed),
          author,
          input.author_kind,
          safeReason,
          state,
          JSON.stringify(problems),
          JSON.stringify(diagnostics),
          v.verify,
          at,
        );
      this.journal.event(`proposal.${state}`, {
        id,
        base_version: base,
        author,
        author_kind: input.author_kind,
        reason: safeReason,
        changed_paths: changed,
        ...(problems.length && { problems: problems.map((p) => ({ code: p.code, ...(p.path && { path: p.path }) })) }),
      });
      return this.get(id);
    });
  }

  get(id: string): Proposal {
    const p = readProposals.get(this.journal.db, id);
    if (!p) {
      throw new ControlError(
        "not_found",
        `${this.opts.pipeline} has no proposal ${id}`,
        `list them with pipo proposals ${this.opts.pipeline}`,
      );
    }
    return p;
  }

  list(opts: { state?: ProposalState; limit?: number } = {}): ProposalSummary[] {
    return readProposals.list(this.journal.db, opts);
  }

  /** The dry run passed. validated → verified. */
  markVerified(id: string, how: { by: string; report?: unknown; summary?: string }): Proposal {
    return this.transition(id, ["validated"], "verified", how.by, {
      decision: how.summary ?? null,
      verification: how.report,
    });
  }

  /** A dry run diverged, the base went stale at apply, or a human rejected it. validated|verified → rejected. */
  markRejected(id: string, how: { by: string; reason: string; report?: unknown }): Proposal {
    return this.transition(id, ["validated", "verified"], "rejected", how.by, {
      decision: how.reason,
      verification: how.report,
    });
  }

  /**
   * The one path to a required dry run, for `propose` and `apply_proposal` alike (D48, D51): a `validated` proposal
   * whose base set `agent.verify` is dry-run now and comes back `verified` or `rejected`; any other comes back as it
   * is. So a proposal a crash, a stop or an error left `validated` mid-run is recovered by applying it again.
   */
  async dryRunIfRequired(id: string, how: { by?: string } = {}): Promise<Proposal> {
    const p = this.get(id);
    return p.state === "validated" && p.verify ? this.dryRun(id, how) : p;
  }

  /**
   * §9.3 step 3 (D48): dry-run a `validated` agent proposal whose base sets `agent.verify: last N`, then record the
   * outcome in one transaction with its event: `verified`, or `rejected` when a replayed packet diverged, the base went
   * stale, or the proposed version can't be prepared. The report (counts, packet ids, reasons) is stored redacted.
   * Nothing is written before that transition, so a crash mid-run leaves the proposal `validated`, ready to run again.
   */
  async dryRun(id: string, how: { by?: string } = {}): Promise<Proposal> {
    const by = how.by ?? "dry-run";
    const p = this.get(id);
    if (p.state !== "validated") {
      throw new ControlError(
        "invalid_state",
        `proposal ${id} is ${p.state}; only a validated proposal is dry-run`,
        p.state === "verified"
          ? `it already passed; apply it: pipo proposals ${this.opts.pipeline} apply ${id}`
          : "propose the change again if you still want it",
      );
    }
    if (!p.verify) {
      throw new ControlError(
        "invalid_state",
        `proposal ${id} needs no dry run: ${p.author_kind === "human" ? "it is a human's" : `v${p.base_version} sets no agent.verify`}`,
        "apply it directly",
      );
    }
    if (this.dryRunning.has(id)) {
      throw new ControlError(
        "invalid_state",
        `a dry run of proposal ${id} is already running`,
        `wait for it: pipo proposals ${this.opts.pipeline} show ${id} shows the outcome once it is decided`,
      );
    }
    this.dryRunning.add(id);
    try {
      const latest = this.journal.latestVersion()?.version ?? 0;
      if (latest !== p.base_version) {
        return this.transition(id, ["validated"], "rejected", by, {
          decision: `stale base: the proposal is against v${p.base_version}, but the pipeline is at v${latest} now; propose the change against v${latest}`,
        });
      }
      let report: DryRunReport;
      try {
        report = await dryRun({
          db: this.journal.db,
          source: p.source,
          base_version: p.base_version,
          verify: p.verify,
          file: this.opts.file,
          env: this.opts.env,
          now: this.now,
          stepTimeoutMs: this.opts.dryRunStepTimeoutMs,
        });
      } catch (e) {
        if (!(e instanceof DryRunPrepareError)) throw e;
        return this.transition(id, ["validated"], "rejected", by, {
          decision: `the dry run could not start: ${e.message}`,
        });
      }
      crashPoint("dryrun.replayed");
      const counts = {
        replayed: report.replayed,
        passed: report.passed,
        filtered: report.filtered,
        diverged: report.diverged,
        skipped: report.skipped,
      };
      const decided = this.transition(id, ["validated"], report.diverged ? "rejected" : "verified", by, {
        decision: dryRunSummary(report),
        verification: report,
        event: { dry_run: counts },
      });
      crashPoint("dryrun.decided");
      return decided;
    } finally {
      this.dryRunning.delete(id);
    }
  }

  /**
   * Version `version` was stored from this proposal. Call it inside the transaction that adds the version
   * (`journal.atomically(() => { const v = journal.addVersion(…); proposals.markApplied(id, {version: v, by}) })`),
   * so a crash keeps both or neither. Throws, rolling that transaction back, unless `version` exists and directly
   * follows the proposal's base, and unless a required dry run passed.
   */
  markApplied(id: string, how: { version: number; by: string }): Proposal {
    const p = this.get(id);
    if (p.verify && p.state !== "verified") {
      throw new ControlError(
        "invalid_state",
        `proposal ${id} needs a dry run first (agent.verify: ${p.verify}) and is ${p.state}`,
        `apply it again: pipo proposals ${this.opts.pipeline} apply ${id} (the apply_proposal op) runs the dry run first`,
      );
    }
    const v = this.journal.db.query("SELECT version FROM versions WHERE version = ?").get(how.version);
    if (!v || how.version !== p.base_version + 1) {
      throw new ControlError(
        "invalid_state",
        `proposal ${id} is against v${p.base_version}, so it can only become v${p.base_version + 1}, not v${how.version}`,
        "propose the change again against the current version",
      );
    }
    return this.transition(id, ["validated", "verified"], "applied", how.by, { applied_version: how.version });
  }

  /** One state move: the row and its `proposal.<to>` event in one transaction; refused unless the row is in `from`. */
  private transition(
    id: string,
    from: ProposalState[],
    to: ProposalState,
    by: string,
    extra: {
      decision?: string | null;
      verification?: unknown;
      applied_version?: number;
      /** More detail for the `proposal.<to>` event (a dry run's counts). */
      event?: Record<string, unknown>;
    },
  ): Proposal {
    const byName = this.redact(str(by, "by", MAX_AUTHOR_CHARS));
    return this.journal.atomically(() => {
      const p = this.get(id);
      if (!from.includes(p.state)) {
        throw new ControlError(
          "invalid_state",
          `proposal ${id} is ${p.state}, so it can't become ${to}`,
          p.state === "applied" || p.state === "rejected"
            ? "it is decided; propose the change again if you still want it"
            : `it must be ${from.join(" or ")} first`,
        );
      }
      const decision =
        extra.decision === undefined ? p.decision : extra.decision === null ? null : this.redact(extra.decision);
      const verification =
        extra.verification === undefined ? null : JSON.stringify(redactDeep(extra.verification, this.redact));
      const at = this.now();
      this.journal.db
        .query(
          `UPDATE proposals SET state = ?, decided_by = ?, decided_at = ?, decision = ?,
             verification = COALESCE(?, verification), applied_version = COALESCE(?, applied_version)
           WHERE id = ? AND state = ?`,
        )
        .run(to, byName, at, decision, verification, extra.applied_version ?? null, id, p.state);
      this.journal.event(`proposal.${to}`, {
        id,
        base_version: p.base_version,
        by: byName,
        ...(decision && { reason: decision }),
        ...(extra.applied_version !== undefined && { version: extra.applied_version }),
        ...extra.event,
      });
      return this.get(id);
    });
  }
}
