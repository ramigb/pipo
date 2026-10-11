// Approval of agent-written pipelines (docs/spec.md §9.4, D81), kept in `<home>/approvals.json` (0600, atomic).
// A pipeline an agent writes with `create_pipeline` is `pending` until a human approves it (the dashboard's Agents
// page, `pipo approvals approve`, or starting it themselves). Approval is tied to a hash of the files the agent wrote,
// so a later rewrite is pending again. With `engine.mcp.auto_approve` the engine approves on the agent's behalf.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { inputsOf, load, type Pipeline } from "@pipo/spec";
import { writePrivateJson } from "./files";

export type ApprovalState = "pending" | "approved" | "rejected";

export interface Approval {
  name: string;
  /** The `.pipo` file, absolute. */
  file: string;
  /** Files the agent wrote next to it, relative to its folder (the `.pipo` file first). */
  files: string[];
  /** The agent (token or grant name) that wrote it. */
  by: string;
  /** Why the agent wrote it, in its own words. */
  reason: string | null;
  /** folderHash() of `files` when it was written (and approved, if it is). */
  hash: string;
  state: ApprovalState;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  /** Why a human rejected it. */
  note: string | null;
}

/** An approval as answered: `effective` is `pending` again when the files changed since they were approved. */
export interface ApprovalView extends Approval {
  current_hash: string;
  changed: boolean;
  effective: ApprovalState;
}

interface Store {
  approvals: Record<string, Approval>;
}

/** SHA-256 over the listed files of `dir` (path and content of each; a missing file counts as missing). */
export function folderHash(dir: string, files: string[]): string {
  const h = createHash("sha256");
  for (const rel of [...files].sort()) {
    const path = join(dir, rel);
    h.update(`${rel}\0`);
    if (existsSync(path) && statSync(path).isFile()) h.update(readFileSync(path));
    else h.update("\0missing\0");
    h.update("\0");
  }
  return h.digest("hex");
}

/** What a pipeline reaches outside itself, for the human reading it before approval: kind → the places it does. */
export function effectsOf(source: string): Record<string, string[]> {
  let p: Pipeline | undefined;
  try {
    p = load(source).value as Pipeline | undefined;
  } catch {}
  if (!p || typeof p !== "object") return {};
  const out: Record<string, string[]> = {};
  const add = (kind: string, where: string) => {
    out[kind] = [...(out[kind] ?? []), where];
  };
  for (const [name, i] of inputsOf(p)) {
    if (i.via === "http") add("listens", p.inputs ? `inputs.${name}` : "input");
    if (i.via === "watch") add("reads_files", p.inputs ? `inputs.${name}` : "input");
  }
  for (const [id, n] of Object.entries(p.nodes ?? {})) {
    const step = n.tap ?? n.transform;
    if (step === "exec") add("runs_programs", `nodes.${id}`);
    if (step === "http" || step === "telegram") add("calls_out", `nodes.${id}`);
    if (step === "file" || step === "sqlite") add("writes_files", `nodes.${id}`);
    if (n.agent !== undefined) add("spends", `nodes.${id}`);
  }
  const to = p.output?.to;
  if (to === "http" || to === "telegram" || to === "pipeline") add("calls_out", "output");
  if (to === "file" || to === "sqlite") add("writes_files", "output");
  return out;
}

export class Approvals {
  private readonly path: string;

  constructor(home: string) {
    this.path = join(home, "approvals.json");
  }

  private read(): Store {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Store;
      if (parsed && typeof parsed.approvals === "object" && parsed.approvals) return parsed;
    } catch {}
    return { approvals: {} };
  }

  private write(store: Store) {
    writePrivateJson(this.path, store);
  }

  private view(a: Approval): ApprovalView {
    const current = folderHash(dirname(a.file), a.files);
    const changed = current !== a.hash;
    return { ...a, current_hash: current, changed, effective: changed && a.state === "approved" ? "pending" : a.state };
  }

  get(name: string): ApprovalView | null {
    const a = this.read().approvals[name];
    return a ? this.view(a) : null;
  }

  /** The approval of the pipeline in `file`, if an agent wrote it. */
  forFile(file: string): ApprovalView | null {
    const abs = resolve(file);
    const a = Object.values(this.read().approvals).find((x) => resolve(x.file) === abs);
    return a ? this.view(a) : null;
  }

  list(): ApprovalView[] {
    return Object.values(this.read().approvals)
      .sort((a, b) => b.requested_at.localeCompare(a.requested_at))
      .map((a) => this.view(a));
  }

  /** Record what an agent wrote: pending, or approved at once with `auto` (engine.mcp.auto_approve). */
  request(o: { name: string; file: string; files: string[]; by: string; reason: string | null; auto: boolean }) {
    const store = this.read();
    const dir = dirname(o.file);
    const files = [relative(dir, o.file), ...o.files.filter((f) => f !== relative(dir, o.file))];
    const now = new Date().toISOString();
    store.approvals[o.name] = {
      name: o.name,
      file: o.file,
      files,
      by: o.by,
      reason: o.reason,
      hash: folderHash(dir, files),
      state: o.auto ? "approved" : "pending",
      requested_at: now,
      decided_at: o.auto ? now : null,
      decided_by: o.auto ? "auto_approve" : null,
      note: null,
    };
    this.write(store);
    return this.view(store.approvals[o.name] as Approval);
  }

  /** Approve (or reject) what is on disk now. Null when no agent wrote a pipeline by that name. */
  decide(name: string, state: "approved" | "rejected", by: string, note: string | null = null): ApprovalView | null {
    const store = this.read();
    const a = store.approvals[name];
    if (!a) return null;
    a.hash = folderHash(dirname(a.file), a.files);
    a.state = state;
    a.decided_at = new Date().toISOString();
    a.decided_by = by;
    a.note = note;
    this.write(store);
    return this.view(a);
  }

  /** A human started the pipeline in `file`: that approves what an agent wrote there, as it is now (D81). */
  startedByHuman(file: string): void {
    const a = this.forFile(file);
    if (a && a.effective !== "approved") this.decide(a.name, "approved", "human start");
  }
}
