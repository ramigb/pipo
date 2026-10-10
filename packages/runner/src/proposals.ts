// Change proposals (docs/spec.md §9.3, D4, D38, D45): the shapes the runner answers over its control socket
// (`propose`, `proposals`, `proposal`, `apply_proposal`, `reject_proposal`). The store, validation and the dry run live
// in the Rust runner (crates/pipo-runner/src/proposals.rs, dryrun.rs).
import type { Diagnostic } from "@pipo/spec";

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
