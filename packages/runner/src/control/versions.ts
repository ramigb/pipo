// Version reads for `pipo history` and `pipo diff` (docs/spec.md §6, §9.3, D38): the journal's versions with who
// made each and why, one version's source, and a unified diff of two. Answered by the runner over its control socket,
// or from the journal read-only when no runner runs (D34), like the packet reads in reads.ts.
import type { Database } from "bun:sqlite";
import { PENDING } from "../journal";
import { ControlError } from "./protocol";

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
export function versionArg(raw: unknown, key: string): number {
  const n = typeof raw === "string" ? Number(raw.replace(/^v/i, "")) : raw;
  if (typeof raw === "string" && !/^v?\d+$/i.test(raw)) return bad(raw, key);
  if (!Number.isInteger(n) || (n as number) < 1) return bad(raw, key);
  return n as number;
}

function bad(raw: unknown, key: string): never {
  throw new ControlError(
    "bad_request",
    `\`${key}\` must be a version number, got ${JSON.stringify(raw ?? null)}`,
    "use 3 or v3; pipo history <name> lists the versions",
  );
}

/**
 * The summary columns, with NULL for those a journal read read-only doesn't have yet (`reason` before D38, the audit
 * columns before D49, `files` before D60), since a read without the runner never migrates (D34).
 */
function summaryColumns(db: Database): string {
  const cols = new Set((db.query("PRAGMA table_info(versions)").all() as { name: string }[]).map((c) => c.name));
  const opt = (c: string) => (cols.has(c) ? c : `NULL AS ${c}`);
  return `version, hash, author, ${opt("reason")}, ${opt("author_kind")}, ${opt("proposal")}, ${opt("files")}, created_at`;
}

/** A row's `files` column (JSON text) as an object. */
const withFiles = <T extends { files: unknown }>(row: T): T => ({
  ...row,
  files: typeof row.files === "string" ? (JSON.parse(row.files) as Record<string, string>) : null,
});

export function listVersions(db: Database, current: number | null): VersionList {
  const pendingStates = PENDING;
  const pending = new Map(
    (
      db
        .query(
          `SELECT version, COUNT(*) AS n FROM packets WHERE branch = '' AND state IN (${pendingStates.map(() => "?").join(", ")}) GROUP BY version`,
        )
        .all(...pendingStates) as { version: number; n: number }[]
    ).map((r) => [r.version, r.n]),
  );
  const rows = db.query(`SELECT ${summaryColumns(db)} FROM versions ORDER BY version DESC`).all() as Omit<
    VersionSummary,
    "pending"
  >[];
  return {
    versions: rows.map((r) => ({ ...withFiles(r), pending: pending.get(r.version) ?? 0 })),
    current,
    latest: rows[0]?.version ?? null,
  };
}

/**
 * One version with its definition (the .pipo text; not `source`, which the engine and CLI use for where an answer
 * came from) and, for its audit (§9.3 step 5, D49), the unified `diff` from the version before it (null for v1).
 */
export function getVersion(
  db: Database,
  version: number,
  pipeline: string,
): VersionSummary & { definition: string; diff: string | null } {
  const row = definitionOf(db, version, pipeline);
  const before =
    version > 1
      ? (db.query("SELECT source FROM versions WHERE version = ?").get(version - 1) as {
          source: string;
        } | null)
      : null;
  const diff = before
    ? unifiedDiff(before.source, row.definition, `${pipeline} v${version - 1}`, `${pipeline} v${version}`).diff
    : null;
  return { ...row, diff };
}

function definitionOf(db: Database, version: number, pipeline: string): VersionSummary & { definition: string } {
  const row = db.query(`SELECT ${summaryColumns(db)}, source FROM versions WHERE version = ?`).get(version) as
    | (Omit<VersionSummary, "pending"> & { source: string })
    | null;
  if (!row) {
    const latest = (db.query("SELECT MAX(version) AS v FROM versions").get() as { v: number | null }).v;
    throw new ControlError(
      "not_found",
      `${pipeline} has no version ${version}${latest ? ` (versions are v1 to v${latest})` : ""}`,
      `list them with pipo history ${pipeline}`,
    );
  }
  const pending = db
    .query(
      `SELECT COUNT(*) AS n FROM packets WHERE branch = '' AND version = ? AND state IN (${PENDING.map(() => "?").join(", ")})`,
    )
    .get(version, ...PENDING) as { n: number };
  const { source, ...summary } = row;
  return { ...withFiles(summary), pending: pending.n, definition: source };
}

export function diffVersions(db: Database, from: number, to: number, pipeline: string): VersionDiff {
  const a = definitionOf(db, from, pipeline);
  const b = definitionOf(db, to, pipeline);
  const d = unifiedDiff(a.definition, b.definition, `${pipeline} v${from}`, `${pipeline} v${to}`);
  return { from, to, identical: a.definition === b.definition, ...d };
}

// ── unified diff (line-based LCS, no dependency) ─────────────────────────────

type Op = { kind: " " | "-" | "+"; text: string; a: number; b: number };

const splitLines = (s: string) => {
  const lines = s.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** Above this many cells the middle is shown as removed then added, rather than aligned line by line. */
const MAX_CELLS = 25_000_000;

function lineOps(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ kind: " ", text: a[i] as string, a: i, b: i });
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const n = am.length;
  const m = bm.length;
  if (n * m > MAX_CELLS) {
    for (const [i, t] of am.entries()) ops.push({ kind: "-", text: t, a: pre + i, b: pre });
    for (const [j, t] of bm.entries()) ops.push({ kind: "+", text: t, a: pre + n, b: pre + j });
  } else {
    // lcs[i * (m + 1) + j]: longest common subsequence of am[i..] and bm[j..].
    const lcs = new Int32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * (m + 1) + j] =
          am[i] === bm[j]
            ? (lcs[(i + 1) * (m + 1) + j + 1] as number) + 1
            : Math.max(lcs[(i + 1) * (m + 1) + j] as number, lcs[i * (m + 1) + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        ops.push({ kind: " ", text: am[i] as string, a: pre + i++, b: pre + j++ });
      } else if (j < m && (i === n || (lcs[i * (m + 1) + j + 1] as number) >= (lcs[(i + 1) * (m + 1) + j] as number))) {
        ops.push({ kind: "+", text: bm[j] as string, a: pre + i, b: pre + j++ });
      } else {
        ops.push({ kind: "-", text: am[i] as string, a: pre + i++, b: pre + j });
      }
    }
  }
  for (let k = 0; k < suf; k++) {
    ops.push({ kind: " ", text: a[a.length - suf + k] as string, a: a.length - suf + k, b: b.length - suf + k });
  }
  // Removals before additions within each changed run, as diff(1) prints them.
  const out: Op[] = [];
  for (let k = 0; k < ops.length; ) {
    if ((ops[k] as Op).kind === " ") {
      out.push(ops[k++] as Op);
      continue;
    }
    const run: Op[] = [];
    while (k < ops.length && (ops[k] as Op).kind !== " ") run.push(ops[k++] as Op);
    out.push(...run.filter((o) => o.kind === "-"), ...run.filter((o) => o.kind === "+"));
  }
  return out;
}

/** A unified diff of two texts, line by line, with `context` unchanged lines around each change. */
export function unifiedDiff(
  before: string,
  after: string,
  fromLabel: string,
  toLabel: string,
  context = 3,
): { diff: string; added: number; removed: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = lineOps(a, b);
  const changed = ops.map((o, i) => (o.kind === " " ? -1 : i)).filter((i) => i >= 0);
  const added = ops.filter((o) => o.kind === "+").length;
  const removed = ops.filter((o) => o.kind === "-").length;
  if (!changed.length) {
    return {
      diff:
        before === after ? "" : `--- ${fromLabel}\n+++ ${toLabel}\n(only the newline at the end of the file differs)`,
      added,
      removed,
    };
  }
  const lines = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  let k = 0;
  while (k < changed.length) {
    const start = Math.max(0, (changed[k] as number) - context);
    let end = (changed[k] as number) + context;
    while (k + 1 < changed.length && (changed[k + 1] as number) - context <= end + 1) {
      k++;
      end = (changed[k] as number) + context;
    }
    end = Math.min(ops.length - 1, end);
    const hunk = ops.slice(start, end + 1);
    const aLen = hunk.filter((o) => o.kind !== "+").length;
    const bLen = hunk.filter((o) => o.kind !== "-").length;
    // A line's own index is exact on its side only (a `+` line's `a` is where it would go), so each side starts at
    // its first line in the hunk.
    const firstA = hunk.find((o) => o.kind !== "+");
    const firstB = hunk.find((o) => o.kind !== "-");
    const aStart = firstA ? firstA.a + 1 : (hunk[0] as Op).a;
    const bStart = firstB ? firstB.b + 1 : (hunk[0] as Op).b;
    lines.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const o of hunk) lines.push(`${o.kind}${o.text}`);
    k++;
  }
  return { diff: lines.join("\n"), added, removed };
}
