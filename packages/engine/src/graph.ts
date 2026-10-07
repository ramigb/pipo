// `GET /api/pipelines/<name>/graph` (docs/spec.md §8, D33): the pipeline drawn from its `.pipo` definition (the
// version the runner runs, from the journal; else the file) with per-node counters counted from the journal's events,
// read-only. The UI draws it; counters come from events, so they survive restarts.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { Journal } from "@pipo/runner";
import { asList, load, nodeKind, type Pipeline } from "@pipo/spec";
import { pinnedSource } from "./events";

export interface GraphNode {
  id: string;
  kind: string;
  label: string | null;
  from: { node: string; branch: string | null }[];
  counts: { in: number; ok: number; failed: number; filtered: number };
}

export interface Graph {
  name: string;
  version: number | null;
  source: "journal" | "file";
  nodes: GraphNode[];
}

const ref = (r: string) => {
  const i = r.indexOf(".");
  return i < 0 ? { node: r, branch: null } : { node: r.slice(0, i), branch: r.slice(i + 1) };
};

function counts(journal: string): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  if (!existsSync(journal)) return out;
  let db: Database | undefined;
  try {
    db = Journal.openReadonly(journal);
    const rows = db.query("SELECT node, type, count(*) AS n FROM events GROUP BY node, type").all() as {
      node: string | null;
      type: string;
      n: number;
    }[];
    for (const r of rows) {
      const key = r.node ?? "input";
      out.set(key, { ...out.get(key), [r.type]: (out.get(key)?.[r.type] ?? 0) + r.n });
    }
  } catch {
    // a journal that can't be read yet shows zeros
  } finally {
    db?.close();
  }
  return out;
}

/** Null when the definition can't be read; the caller says which pipeline and file. */
export function pipelineGraph(name: string, file: string, journal: string, version: number | null): Graph | null {
  let source: string | null = version === null ? null : pinnedSource(journal, version);
  const from = source === null ? "file" : "journal";
  if (source === null) {
    try {
      source = readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }
  const p = load(source).value as Pipeline | undefined;
  if (!p?.input || !p.output) return null;
  const c = counts(journal);
  const n = (id: string, ...types: string[]) => types.reduce((s, t) => s + (c.get(id)?.[t] ?? 0), 0);
  const nodes: GraphNode[] = [
    {
      id: "input",
      kind: "input",
      label: p.input.via ?? null,
      from: [],
      counts: {
        in: n("input", "packet.accepted", "packet.rejected"),
        ok: n("input", "packet.accepted"),
        failed: n("input", "packet.rejected"),
        filtered: 0,
      },
    },
  ];
  for (const [id, node] of Object.entries(p.nodes ?? {})) {
    const ok = n(id, "node.done", "node.looped");
    const failed = n(id, "packet.dead_lettered", "node.failed_continued", "packet.dropped");
    const filtered = n(id, "packet.filtered");
    nodes.push({
      id,
      kind: nodeKind(node) ?? "node",
      label: node.label ?? null,
      from: asList(node.from).map(ref),
      counts: { in: ok + failed + filtered, ok, failed, filtered },
    });
  }
  const ok = n("$output", "output.written", "output.batched", "packet.delivered");
  const failed = n("$output", "packet.dead_lettered", "packet.dropped");
  nodes.push({
    id: "output",
    kind: "output",
    label: p.output.to,
    from: asList(p.output.from).map(ref),
    counts: { in: ok + failed, ok, failed, filtered: 0 },
  });
  return { name, version, source: from, nodes };
}
