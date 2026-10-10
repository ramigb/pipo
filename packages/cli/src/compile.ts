// `pipo compile` (docs/spec.md §3.6, §5, D73): a pipeline's checked, compiled form for the runner.
// The `fn` module is bundled here, so P059 lives in the CLI rather than in the pure `check()`.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readAgentSettings } from "@pipo/runner";
import {
  AGENTS,
  type AgentManifest,
  type AgentsConfig,
  check,
  type Diagnostic,
  displayPath,
  inputsOf,
  load,
  type Pipeline,
} from "@pipo/spec";
import { fail, usageError as usage } from "./errors";
import { resolveHome } from "./lifecycle";

export interface FnBundle {
  /** The module as written in `fn:`. */
  path: string;
  /** sha256 of the module file as read. */
  hash: string;
  /** One self-contained ES module: TypeScript stripped, local imports inlined. */
  code: string;
  /** The exported functions. */
  exports: string[];
}

export interface Compiled {
  diagnostics: Diagnostic[];
  pipeline: Pipeline | null;
  fn: FnBundle | null;
  schemas: Record<string, unknown>;
  files: Record<string, string>;
  /** What the runner reads from `<home>/config.yaml` for agent nodes (spec §3.11, D36, D58); null without agent nodes. */
  agents: {
    settings: { agents: AgentsConfig; timezone: string; engine_budget: { per_day: number } | null };
    /** Problems in config.yaml: not diagnostics, the runner refuses its start with them. */
    problems: string[];
  } | null;
  /** The agent provider manifests (`AGENTS`), so the runner knows each provider's `runs`, defaults and models. */
  agent_manifests: Record<string, AgentManifest>;
}

const sha256 = (data: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

/** Globals the runner's QuickJS doesn't have. A use other than `typeof x` is P059. */
const HOST_GLOBALS = [
  "Bun",
  "Deno",
  "process",
  "require",
  "Buffer",
  "__dirname",
  "__filename",
  "fetch",
  "WebSocket",
  "XMLHttpRequest",
];
const MARK = "__pipo_host_global_";
const BUILTIN = new Set(builtinModules);

/** Bundle an `fn` module for the runner's QuickJS: the bundle, or why it can't run there (P059). */
export async function bundleFn(modulePath: string): Promise<{ code: string; exports: string[] } | { problem: string }> {
  const hostImports = new Set<string>();
  let build: Awaited<ReturnType<typeof Bun.build>>;
  try {
    build = await Bun.build({
      entrypoints: [modulePath],
      target: "browser",
      format: "esm",
      minify: false,
      sourcemap: "none",
      throw: false,
      define: Object.fromEntries(HOST_GLOBALS.map((g) => [g, `${MARK}${g}`])),
      plugins: [
        {
          name: "pipo-host-imports",
          setup(b) {
            b.onResolve({ filter: /^[^./]/ }, (a) => {
              const bare = a.path.replace(/^node:/, "").split("/")[0] as string;
              if (a.path.startsWith("node:") || a.path.startsWith("bun:") || a.path === "bun" || BUILTIN.has(bare)) {
                hostImports.add(a.path);
                return { path: a.path, external: true };
              }
              return undefined;
            });
          },
        },
      ],
    });
  } catch (e) {
    return { problem: firstLine((e as Error).message) };
  }
  if (!build.success || !build.outputs[0]) {
    const log = build.logs.find((l) => l.level === "error") ?? build.logs[0];
    return { problem: firstLine(log ? log.message : "the bundler gave no output") };
  }
  if (hostImports.size) return { problem: `it imports ${[...hostImports].sort().join(", ")}` };
  const text = await build.outputs[0].text();
  const used = new Set<string>();
  for (const m of text.matchAll(new RegExp(`(typeof\\s+)?${MARK}(\\w+)`, "g"))) if (!m[1]) used.add(m[2] as string);
  if (used.size) return { problem: `it uses ${[...used].sort().join(", ")}` };
  const code = text.replaceAll(MARK, "");
  try {
    return { code, exports: await functionExports(code) };
  } catch (e) {
    return { problem: `loading it threw: ${firstLine(e instanceof Error ? e.message : String(e))}` };
  }
}

const firstLine = (s: string) => s.split("\n")[0]?.trim() || s;

/** The exported function names of a bundle, by importing it once (it's trusted code: P052 passed). */
async function functionExports(code: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "pipo-compile-"));
  const { log, info, debug } = console;
  // stdout carries the JSON reply, so a module that logs while loading writes to stderr instead.
  console.log = console.info = console.debug = console.error;
  try {
    const path = join(dir, "fn.mjs");
    writeFileSync(path, code);
    const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    return Object.keys(mod)
      .filter((k) => typeof mod[k] === "function")
      .sort();
  } finally {
    Object.assign(console, { log, info, debug });
    rmSync(dir, { recursive: true, force: true });
  }
}

/** P059 for a pipeline whose `fn` module can't run in the runner, or null. Call only when `check()` found no errors. */
export async function fnDiagnostic(source: string, file: string): Promise<Diagnostic | null> {
  const loaded = load(source, file);
  const fn = loaded.value?.fn;
  if (typeof fn !== "string") return null;
  const r = await bundleFn(resolve(dirname(file), fn));
  return "problem" in r ? p059(loaded.locate(["fn"], true), file, fn, r.problem) : null;
}

function p059(pos: { line: number; col: number }, file: string, fn: string, why: string): Diagnostic {
  return {
    file,
    ...pos,
    severity: "error",
    code: "P059",
    message: `fn module ${fn} can't run in the runner: ${why}`,
    hint: "fn modules run in an embedded JS engine (QuickJS) without Bun or Node APIs, so keep them self-contained (plain functions over the packet data), or use an exec step for anything that needs the system",
    path: ["fn"],
  };
}

const sortDiagnostics = (ds: Diagnostic[]) =>
  ds.sort((a, b) => a.line - b.line || a.col - b.col || a.code.localeCompare(b.code));

/** The files a definition refers to, as written: what D60 records (runner `referencedFiles`). */
export function referencedFiles(p: Pipeline): string[] {
  const out = new Set<string>();
  if (typeof p.fn === "string") out.add(p.fn);
  for (const [, i] of inputsOf(p)) if (typeof i.schema === "string") out.add(i.schema);
  for (const n of Object.values(p.nodes ?? {})) {
    const s = n.agent !== undefined ? n.with?.schema : undefined;
    if (typeof s === "string" && !s.includes("${")) out.add(s);
  }
  return [...out].sort();
}

/** Check `source` (as `file`) and compile it: the pipeline, its bundled `fn` module, its schemas and file hashes. */
export async function compile(source: string, file: string, opts: { home?: string } = {}): Promise<Compiled> {
  const shown = displayPath(file);
  const diagnostics: Diagnostic[] = check(source, { file, home: opts.home }).map((d) => ({ ...d, file: shown }));
  const out: Compiled = {
    diagnostics,
    pipeline: null,
    fn: null,
    schemas: {},
    files: {},
    agents: null,
    agent_manifests: AGENTS,
  };
  if (diagnostics.some((d) => d.severity === "error")) return out;
  const loaded = load(source, file);
  const p = loaded.value as Pipeline;
  const dir = dirname(resolve(file));
  if (typeof p.fn === "string") {
    const modulePath = resolve(dir, p.fn);
    const hash = sha256(readFileSync(modulePath));
    const r = await bundleFn(modulePath);
    if ("problem" in r) {
      diagnostics.push(p059(loaded.locate(["fn"], true), shown, p.fn, r.problem));
      sortDiagnostics(diagnostics);
      return out;
    }
    out.fn = { path: p.fn, hash, code: r.code, exports: r.exports };
  }
  for (const f of referencedFiles(p)) {
    const path = resolve(dir, f);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    out.files[f] = f === p.fn && out.fn ? out.fn.hash : sha256(bytes);
    if (f !== p.fn) out.schemas[f] = JSON.parse(bytes.toString("utf8"));
  }
  if (Object.values(p.nodes ?? {}).some((n) => n.agent !== undefined)) {
    const { settings, problems } = readAgentSettings(resolveHome(opts.home));
    out.agents = {
      settings: { agents: settings.agents, timezone: settings.timezone, engine_budget: settings.engineBudget },
      problems,
    };
  }
  out.pipeline = p;
  return out;
}

/** `pipo compile <file.pipo> [--home DIR] [--stdin]`: one JSON document on stdout; exit 1 when it has errors. */
export async function cmdCompile(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { home: { type: "string" }, stdin: { type: "boolean" } },
  });
  const file = positionals[0];
  if (!file || positionals.length > 1) return usage("pipo compile <file.pipo> [--home <dir>] [--stdin]");
  let source: string;
  if (values.stdin) source = await Bun.stdin.text();
  else if (!existsSync(file)) {
    return fail(
      "usage",
      64,
      `pipo compile: no such file: ${file} (name a .pipo file, or pass --stdin with the source)`,
    );
  } else source = readFileSync(file, "utf8");
  const out = await compile(source, resolve(file), { home: values.home });
  console.log(JSON.stringify(out));
  return out.pipeline ? 0 : 1;
}
