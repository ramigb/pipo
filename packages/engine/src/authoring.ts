// Pipelines written by agents (docs/spec.md §9.4, D81): `create_pipeline` over MCP. The source and its files (fn
// module, schemas, fixtures) are written to a staging folder in the workspace and checked there; only a pipeline
// without errors lands in `<workspace>/<name>/`, and its approval is recorded (pending, or approved with
// engine.mcp.auto_approve). An agent may rewrite only a stopped pipeline it wrote itself.
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { check, type Diagnostic, load } from "@pipo/spec";
import type { ApprovalView } from "./approvals";
import { realish, within, writeAtomic } from "./builder";
import { HttpError } from "./http-error";
import type { Supervisor } from "./supervisor";
import { LIVE } from "./supervisor/types";

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const MAX_SOURCE = 1024 * 1024;
export const MAX_AGENT_FILES = 32;
export const MAX_AGENT_FILE = 256 * 1024;
export const MAX_AGENT_TOTAL = 1024 * 1024;

const bad = (message: string, hint: string, extra: Record<string, unknown> = {}) =>
  new HttpError(400, message, hint, "bad_request", extra);

/** A file path an agent may write: relative, inside the pipeline's folder, no dot segments, not another pipeline. */
export function agentPath(raw: string, name: string): string {
  const shape = "use a relative path inside the pipeline's folder, such as fn.ts, schema/out.json or fixtures/one.json";
  if (!raw || raw.length > 200 || /[\0\\]/.test(raw) || raw.startsWith("/"))
    throw bad(`file path '${raw}' is not allowed`, shape);
  const rel = normalize(raw);
  const segs = rel.split("/");
  if (segs.some((s) => s === "" || s === ".." || s.startsWith(".")))
    throw bad(`file path '${raw}' leaves the folder or names a dot file`, shape);
  if (rel.endsWith(".pipo"))
    throw bad(
      `file path '${raw}' is a .pipo file`,
      `the pipeline itself goes in \`source\` (written as ${name}.pipo); one pipeline per folder`,
    );
  return rel;
}

export interface CreateRequest {
  name: string;
  source: string;
  files: Record<string, string>;
  by: string;
  reason: string | null;
}

export interface CreateResult {
  name: string;
  file: string;
  folder: string;
  files: string[];
  diagnostics: Diagnostic[];
  approval: ApprovalView;
}

/** Check and write an agent's pipeline into the workspace. Throws HttpError with a hint on every refusal. */
export function createPipeline(engine: Supervisor, req: CreateRequest): CreateResult {
  const { name, source, by } = req;
  if (!NAME.test(name))
    throw bad(
      `'${name}' is not a pipeline name`,
      "use lowercase letters, digits and '-', starting with a letter or digit",
    );
  if (Buffer.byteLength(source) > MAX_SOURCE)
    throw new HttpError(413, `the source is over ${MAX_SOURCE} bytes`, "split the pipeline, or trim it", "too_large");
  const declared = (load(source).value as { name?: unknown } | undefined)?.name;
  if (declared !== name)
    throw bad(
      `the source's \`name:\` is ${JSON.stringify(declared ?? null)}, not '${name}'`,
      `set \`name: ${name}\` in the source, or create it under its own name`,
    );
  const entries = Object.entries(req.files);
  if (entries.length > MAX_AGENT_FILES)
    throw bad(`${entries.length} files is too many`, `send at most ${MAX_AGENT_FILES} files per pipeline`);
  let total = 0;
  const files = new Map<string, string>();
  for (const [raw, content] of entries) {
    if (typeof content !== "string")
      throw bad(`file '${raw}' must be text`, 'send files as {"path": "content"}, e.g. {"fn.ts": "export …"}');
    const rel = agentPath(raw, name);
    const size = Buffer.byteLength(content);
    if (size > MAX_AGENT_FILE)
      throw new HttpError(413, `file '${raw}' is over ${MAX_AGENT_FILE / 1024} KiB`, "keep files small", "too_large");
    total += size;
    if (files.has(rel)) throw bad(`file '${raw}' is given twice`, "send each path once");
    files.set(rel, content);
  }
  if (total > MAX_AGENT_TOTAL)
    throw new HttpError(
      413,
      `the files are over ${MAX_AGENT_TOTAL / 1024 / 1024} MiB together`,
      "keep files small",
      "too_large",
    );

  const workspace = engine.workspace;
  const folder = join(workspace, name);
  const file = join(folder, `${name}.pipo`);
  if (!within(realish(workspace), realish(folder)))
    throw new HttpError(403, `${folder} leads outside the workspace ${workspace}`, "pick another name", "forbidden");
  const owned = engine.approvals.get(name);
  const known = engine.get(name);
  if (known && realish(known.file) !== realish(file))
    throw new HttpError(
      409,
      `a pipeline named '${name}' already exists (${known.file})`,
      "pick another name, or propose a change to it with propose_change",
      "conflict",
    );
  if (owned && owned.by !== by)
    throw new HttpError(
      403,
      `'${name}' was written by '${owned.by}', not '${by}'`,
      "pick another name, or propose a change with propose_change",
      "forbidden",
    );
  if (!owned && existsSync(folder))
    throw new HttpError(
      409,
      `${folder} already exists and was not written by an agent`,
      "pick another name; to change a human's pipeline, use propose_change",
      "conflict",
    );
  if (known && (LIVE.includes(known.state) || known.state === "unreachable"))
    throw new HttpError(
      409,
      `'${name}' is ${known.state}`,
      "change a running pipeline with propose_change, or stop it first (stop_pipeline)",
      "invalid_state",
    );

  // Checked in a staging folder first, so a pipeline with errors never replaces a good one.
  mkdirSync(workspace, { recursive: true });
  const staging = mkdtempSync(join(workspace, ".pipo-staging-"));
  let diagnostics: Diagnostic[];
  try {
    const write = (rel: string, content: string) => {
      const path = join(staging, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeAtomic(path, content);
    };
    write(`${name}.pipo`, source);
    for (const [rel, content] of files) write(rel, content);
    diagnostics = check(source, { file: join(staging, `${name}.pipo`), home: engine.home }).map(
      (d) => JSON.parse(JSON.stringify(d).replaceAll(staging, folder)) as Diagnostic,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length)
    throw new HttpError(
      422,
      `'${name}' has ${errors.length} error(s), so nothing was written: ${errors[0]?.code} ${errors[0]?.message}`,
      "fix the diagnostics (check_pipo shows them) and create it again",
      "invalid_pipeline",
      { diagnostics },
    );

  mkdirSync(folder, { recursive: true });
  const write = (rel: string, content: string) => {
    const path = join(folder, rel);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && !statSync(path).isFile()) throw bad(`${path} is a folder`, "use another file path");
    writeAtomic(path, content);
  };
  write(`${name}.pipo`, source);
  for (const [rel, content] of files) write(rel, content);
  // Files the agent wrote before and left out now are removed, so an old module can't linger.
  for (const rel of owned?.files ?? []) {
    if (rel === `${name}.pipo` || files.has(rel)) continue;
    try {
      unlinkSync(join(folder, rel));
    } catch {}
  }
  const approval = engine.approvals.request({
    name,
    file,
    files: [...files.keys()],
    by,
    reason: req.reason,
    auto: engine.config.mcp.auto_approve,
  });
  return {
    name,
    file,
    folder,
    files: [relative(folder, file), ...files.keys()],
    diagnostics,
    approval,
  };
}
