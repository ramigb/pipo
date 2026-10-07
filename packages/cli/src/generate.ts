// `pipo generate node` (docs/spec.md §10.2): insert a node into an existing .pipo file with the YAML Document
// API, so comments and formatting survive, then re-run check().
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { check, type Diagnostic, FN_REF } from "@pipo/spec";
import { isMap, isScalar, isSeq, type Pair, parseDocument, Scalar, type YAMLMap, type YAMLSeq } from "yaml";
import { CliError } from "./errors";

export const NODE_KINDS = ["tap", "transform", "filter", "route", "agent"] as const;
type Kind = (typeof NODE_KINDS)[number];

const ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Default value of the kind key (`tap: log`) and its minimal `with:`, per kind (manifests in @pipo/spec). */
const DEFAULTS: Record<string, { use: string; with?: unknown }> = {
  "tap:log": { use: "log", with: { level: "info", message: "Packet ${meta.packet_id} at {{id}}" } },
  "tap:http": { use: "http", with: { method: "POST", url: "https://example.com/hook", body: "${json(data)}" } },
  "tap:file": { use: "file", with: { path: "./out/{{id}}.jsonl", format: "jsonl", mode: "append" } },
  "tap:emit": { use: "emit", with: { event: "{{id}}" } },
  "transform:map": { use: "map", with: { data: "${data}" } },
  "transform:http": { use: "http", with: { method: "GET", url: "https://example.com/lookup" } },
  "agent:claude_api": {
    use: "claude_api",
    with: {
      model: "claude-sonnet-5-5",
      prompt: "Describe what to do with this packet.\n${json(data)}",
      schema: "./schemas/{{id}}.schema.json",
      timeout: "60s",
    },
  },
  // CLI agents (D67): the CLI's own default model unless one is named; Claude Code takes the aliases.
  ...Object.fromEntries(
    (["claude_code", "codex", "pi", "opencode"] as const).map((use) => [
      `agent:${use}`,
      {
        use,
        with: {
          ...(use === "claude_code" ? { model: "sonnet" } : {}),
          prompt: "Describe what to do with this packet.\n${json(data)}",
          schema: "./schemas/{{id}}.schema.json",
          timeout: "5m",
        },
      },
    ]),
  ),
};

const AGENT_SCHEMA = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "result": { "type": "string" }
  },
  "required": ["result"]
}
`;

export interface GenerateOptions {
  pipeline: string;
  id: string;
  kind: string;
  from?: string;
  /** The value of the kind key: `log` for a tap, `claude_api` for an agent, `fn.name`, … */
  use?: string;
  cwd?: string;
}

export interface GenerateResult {
  file: string;
  id: string;
  kind: Kind;
  from: string | string[];
  output_from: string | string[];
  created: string[];
  diagnostics: Diagnostic[];
}

/** `<pipeline>` is a .pipo file, a folder holding one, or a pipeline name (./<name>/<name>.pipo or ./<name>.pipo). */
export function resolvePipelineFile(pipeline: string, cwd = process.cwd()): string {
  const candidates = [
    resolve(cwd, pipeline),
    resolve(cwd, `${pipeline}.pipo`),
    resolve(cwd, pipeline, `${pipeline}.pipo`),
  ];
  for (const c of candidates) {
    const s = statSync(c, { throwIfNoEntry: false });
    if (s?.isFile() && c.endsWith(".pipo")) return c;
    if (s?.isDirectory()) {
      const found = readdirSync(c).filter((f) => f.endsWith(".pipo"));
      if (found.length === 1) return join(c, found[0] as string);
      if (found.length > 1) {
        throw new CliError(`${c} holds several .pipo files (${found.join(", ")})`, "pass the file you mean");
      }
    }
  }
  throw new CliError(`no pipeline '${pipeline}' found`, "pass a .pipo file, a folder holding one, or a pipeline name");
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined ? [] : [String(v)]);

function fill(v: unknown, id: string): unknown {
  if (typeof v === "string") return v.replaceAll("{{id}}", id);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, id)]));
  }
  return v;
}

export function generateNode(o: GenerateOptions): GenerateResult {
  const file = resolvePipelineFile(o.pipeline, o.cwd);
  if (!(NODE_KINDS as readonly string[]).includes(o.kind)) {
    throw new CliError(`unknown node kind '${o.kind}'`, `kinds: ${NODE_KINDS.join(", ")}`);
  }
  const kind = o.kind as Kind;
  if (!ID.test(o.id) || o.id === "input" || o.id === "output") {
    throw new CliError(
      `'${o.id}' can't be a node id`,
      "use letters, digits, '_' or '-', starting with a letter or '_' ('input' and 'output' are reserved)",
    );
  }

  const doc = parseDocument(readFileSync(file, "utf8"), { keepSourceTokens: true });
  if (doc.errors.length || !isMap(doc.contents)) {
    throw new CliError(`${file} is not valid YAML`, "run 'pipo check' and fix the syntax errors first");
  }
  const root = doc.contents as YAMLMap;
  const output = root.get("output", true);
  if (!isMap(output)) throw new CliError(`${file} has no output block`, "run 'pipo check' and fix the file first");

  const found: unknown = root.get("nodes", true);
  let nodes = isMap(found) ? found : undefined;
  const existing = nodes ? nodes.items.map((p) => String((p.key as Scalar).value)) : [];
  if (existing.includes(o.id)) {
    throw new CliError(
      `node '${o.id}' already exists in ${file}`,
      `choose another id (existing: ${existing.join(", ")})`,
    );
  }

  // Valid `from` targets: input, node ids, and the branches of route nodes.
  const valid = ["input", ...existing];
  if (nodes) {
    for (const p of nodes.items) {
      const route = isMap(p.value) ? p.value.get("route", true) : undefined;
      if (isMap(route))
        for (const b of route.items) valid.push(`${(p.key as Scalar).value}.${(b.key as Scalar).value}`);
    }
  }
  const feeding = strings(output.toJS(doc).from);
  if (o.from !== undefined && !valid.includes(o.from)) {
    throw new CliError(`--from '${o.from}' is not a node of ${file}`, `valid: ${valid.join(", ")}`);
  }
  const from: string | string[] = o.from ?? (feeding.length === 1 ? (feeding[0] as string) : feeding);
  if (!feeding.length) throw new CliError(`${file} has no output.from`, "run 'pipo check' and fix the file first");

  // The node itself.
  const spec: Record<string, unknown> = { from };
  const key = `${kind}:${o.use ?? (kind === "tap" ? "log" : kind === "transform" ? "map" : kind === "agent" ? "claude_api" : "")}`;
  const created: string[] = [];
  let branch: string | undefined;
  if (kind === "filter") spec.filter = "exists(data)";
  else if (kind === "route") {
    branch = "main";
    spec.route = { main: "else" };
  } else {
    const d = DEFAULTS[key];
    const use = o.use ?? d?.use;
    if (!use || (!d && !FN_REF.test(use))) {
      const known = Object.keys(DEFAULTS)
        .filter((k) => k.startsWith(`${kind}:`))
        .map((k) => k.slice(kind.length + 1));
      throw new CliError(`unknown ${kind} '${o.use}'`, `use one of: ${known.join(", ")}, or fn.<name>`);
    }
    spec[kind] = use;
    if (d?.with) spec.with = fill(d.with, o.id);
  }
  if (kind === "agent") {
    const schema = join(dirname(file), "schemas", `${o.id}.schema.json`);
    if (!existsSync(schema)) {
      mkdirSync(dirname(schema), { recursive: true });
      writeFileSync(schema, AGENT_SCHEMA);
      created.push(schema);
    }
  }

  // Insert before the output: append to `nodes` (creating it ahead of `output` when missing).
  const value = doc.createNode(spec);
  const pair = doc.createPair(o.id, value) as Pair<Scalar>;
  if (!nodes) {
    nodes = doc.createNode({}) as YAMLMap;
    const at = root.items.findIndex((p) => isScalar(p.key) && p.key.value === "output");
    const nodesPair = doc.createPair("nodes", nodes) as Pair<Scalar>;
    nodesPair.key.spaceBefore = true;
    root.items.splice(at, 0, nodesPair);
  } else {
    pair.key.spaceBefore = true;
  }
  nodes.items.push(pair);

  // Re-point the output (or only the entry that came from --from).
  const ref = branch ? `${o.id}.${branch}` : o.id;
  const outFrom = output.get("from", true);
  let outputFrom: string | string[];
  if (o.from === undefined || !feeding.includes(o.from)) {
    outputFrom = o.from === undefined ? ref : (output.toJS(doc).from as string | string[]);
    if (o.from === undefined) output.set("from", ref);
  } else if (isSeq(outFrom)) {
    (outFrom as YAMLSeq).items = (outFrom as YAMLSeq).items.map((i) =>
      isScalar(i) && i.value === o.from ? new Scalar(ref) : i,
    );
    outputFrom = feeding.map((f) => (f === o.from ? ref : f));
  } else {
    output.set("from", ref);
    outputFrom = ref;
  }

  const source = doc.toString({ lineWidth: 0 });
  writeFileSync(file, source);
  return { file, id: o.id, kind, from, output_from: outputFrom, created, diagnostics: check(source, { file }) };
}
