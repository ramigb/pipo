// Version reads for `pipo history` and `pipo diff` (docs/spec.md §6, §9.3, D38): the shapes of the journal's versions
// (who made each and why), one version's source, and a unified diff of two. Answered by the runner over its control
// socket, or by offlineRead() when no runner runs (D34).
export interface VersionSummary {
  version: number;
  /** sha256 of the source. */
  hash: string;
  /** Who made it: `human` (a start from the file), or who applied it (`cli`, `api`, a proposal's author). */
  author: string;
  /** Why: `first start`, `file changed`, `rollback to v<n>`, a proposal's reason; null in journals from before D38. */
  reason: string | null;
  /** `human` (a start from the file) or `agent`; null when the channel didn't say, and before D49. */
  author_kind: "human" | "agent" | null;
  /** The change proposal it was applied from (§9.3, D49); null otherwise. */
  proposal: string | null;
  /** sha256 of each file it ran with (`fn` module, schema files), by the path its source gives (D60); null before D60. */
  files: Record<string, string> | null;
  created_at: number;
  /** Packets pinned to it and not finished yet. */
  pending: number;
}

export interface VersionList {
  /** Newest first. */
  versions: VersionSummary[];
  /** The version new packets use, when a runner answers; null from the journal. */
  current: number | null;
  /** The newest version: the one the next start runs unless the file changed since the last start (D38). */
  latest: number | null;
}

export interface VersionDiff {
  from: number;
  to: number;
  identical: boolean;
  added: number;
  removed: number;
  /** Unified diff (`---`/`+++` headers, `@@` hunks, 3 lines of context); empty when identical. */
  diff: string;
}

/** A version number: `3`, `"3"` or `"v3"`. */
