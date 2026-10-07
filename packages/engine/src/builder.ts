// The dashboard builder's API (docs/spec.md §8, D62), under `/api/builder/*`: the connector catalog, the `.pipo` files
// of the engine's workspace (D61), opening one (with its fixtures), a live `pipo check` of a draft (a source, or a
// pipeline value written onto its base with toSource), saving, and a test run of a draft against fixture packets
// (testPipeline with a trace: nothing is called, sent or written).
//
// Saving and opening are limited to `.pipo` files inside the workspace (real paths, so `..` and symlinked folders
// can't lead out) or exactly the file of a pipeline the engine knows. Schema files (`/schema`: an agent node's
// `with.schema`, the input's `schema`) are `.json` files in or below an allowed pipeline file's folder.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type AgentProbe,
  FixtureError,
  loadFixtures,
  probeAgents,
  readAgentSettings,
  TestPrepareError,
  testPipeline,
} from "@pipo/runner";
import {
  AGENTS,
  CHECKS,
  check,
  type Diagnostic,
  INPUTS,
  load,
  NODE_KINDS,
  OUTPUTS,
  schemaProblem,
  TAPS,
  TRANSFORMS,
  toSource,
} from "@pipo/spec";
import { pinnedSource } from "./events";
import { journalPath } from "./home";
import { HttpError } from "./http-error";
import type { Supervisor } from "./supervisor";

/** Error-policy `then` values (§3.9), for the builder's pickers. */
const THEN = ["dead_letter", "drop", "continue", "pause", "halt", "agent"];
/** Proposal sources are capped the same (D45). */
const MAX_SOURCE = 1024 * 1024;
const MAX_FILES = 500;
const MAX_DEPTH = 4;
const MAX_FIXTURES = 50;
const SKIP = new Set(["node_modules", "fixtures", "__snapshots__"]);
const NAME = /^[a-z0-9][a-z0-9-]*$/;

type Body = Record<string, unknown>;

const bad = (message: string, hint: string, extra: Body = {}) =>
  new HttpError(400, message, hint, "bad_request", extra);
const isObject = (v: unknown): v is Body => !!v && typeof v === "object" && !Array.isArray(v);

function only(body: Body, keys: string[]) {
  const unknown = Object.keys(body).filter((k) => !keys.includes(k));
  if (unknown.length) throw bad(`unknown field(s) ${unknown.join(", ")}`, `this route takes ${keys.join(", ")}`);
}

function str(body: Body, key: string, required: boolean): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) {
    if (required) throw bad(`\`${key}\` is required`, `send {"${key}": "…"}`);
    return undefined;
  }
  if (typeof v !== "string") throw bad(`\`${key}\` must be a string, got ${JSON.stringify(v)}`, `fix \`${key}\``);
  return v;
}

function sourceOf(body: Body, key = "source"): string {
  const source = str(body, key, true) as string;
  if (Buffer.byteLength(source) > MAX_SOURCE) {
    throw new HttpError(413, `the source is over ${MAX_SOURCE} bytes`, "split the pipeline, or trim it", "too_large");
  }
  return source;
}

/** `path` with symlinks resolved, also when it (or its folders) doesn't exist yet: the nearest existing ancestor's. */
function realish(path: string): string {
  let at = path;
  const rest: string[] = [];
  while (!existsSync(at)) {
    const up = dirname(at);
    if (up === at) break;
    rest.unshift(basename(at));
    at = up;
  }
  try {
    return join(realpathSync(at), ...rest);
  } catch {
    return path;
  }
}

const within = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** How long a probe of the agent CLIs is reused: each one runs a few CLI commands. */
const AGENT_PROBE_TTL = 5 * 60_000;

export class Builder {
  private probe: { at: number; value: Promise<Record<string, AgentProbe>> } | null = null;

  constructor(private readonly engine: Supervisor) {}

  private get workspace(): string {
    return this.engine.workspace;
  }

  private known(file: string) {
    return this.engine.list().find((r) => resolve(r.file) === file);
  }

  /** The `.pipo` file a request names, if it may be read or written; 400 or 403 otherwise. */
  private allowed(raw: string | undefined, what: "open" | "save"): { file: string; inside: boolean } {
    if (!raw || !isAbsolute(raw)) {
      throw bad("`file` must be an absolute path", `for example ${join(this.workspace, "my-pipeline.pipo")}`);
    }
    const file = resolve(raw);
    if (!file.endsWith(".pipo")) {
      throw bad(`${file} is not a .pipo file`, "the builder only reads and writes pipeline files ending in .pipo");
    }
    const root = realish(this.workspace);
    const inside = within(root, realish(file));
    if (!inside && !this.known(file)) {
      throw new HttpError(
        403,
        `can't ${what} ${file}: it is outside the workspace ${this.workspace}`,
        `the builder ${what === "save" ? "saves" : "opens"} files under the workspace or of pipelines the engine runs; start the engine from that folder (pipo ui --workspace <dir>, or pipod --workspace <dir>)`,
        "forbidden",
        { workspace: this.workspace },
      );
    }
    return { file, inside };
  }

  private diagnostics(source: string, file: string): Diagnostic[] {
    return check(source, { file, home: this.engine.home });
  }

  catalog() {
    const pick = (m: Record<string, { description: string; with: unknown }>) =>
      Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { description: v.description, with: v.with }]));
    return {
      workspace: this.workspace,
      inputs: Object.fromEntries(
        Object.entries(INPUTS).map(([k, v]) => [k, { description: v.description, with: v.with, sample: v.sample }]),
      ),
      taps: pick(TAPS),
      transforms: pick(TRANSFORMS),
      agents: Object.fromEntries(
        Object.entries(AGENTS).map(([k, v]) => [
          k,
          { description: v.description, with: v.with, label: v.label, runs: v.runs, timeout: v.timeout },
        ]),
      ),
      outputs: Object.fromEntries(
        Object.entries(OUTPUTS).map(([k, v]) => [
          k,
          { description: v.description, with: v.with, checks: v.checks, batch: v.batch },
        ]),
      ),
      checks: pick(CHECKS),
      node_kinds: [...NODE_KINDS],
      then: THEN,
    };
  }

  /**
   * Which agents can run on this machine and their models (D67), as a runner started now would see them (the
   * `agents:` settings of the home's config.yaml). Cached for a few minutes; `refresh` probes again.
   */
  async agents(refresh = false): Promise<{ agents: Record<string, AgentProbe>; checked_at: string }> {
    if (refresh || !this.probe || Date.now() - this.probe.at > AGENT_PROBE_TTL) {
      const { settings } = readAgentSettings(this.engine.home);
      const value = probeAgents(settings.agents);
      this.probe = { at: Date.now(), value };
      value.catch(() => {
        if (this.probe?.value === value) this.probe = null;
      });
    }
    return { agents: await this.probe.value, checked_at: new Date(this.probe.at).toISOString() };
  }

  files() {
    const root = this.workspace;
    const files: { file: string; rel: string; name: string | null }[] = [];
    const walk = (dir: string, depth: number) => {
      let names: string[];
      try {
        names = readdirSync(dir).sort();
      } catch {
        return;
      }
      for (const n of names) {
        if (files.length >= MAX_FILES) return;
        if (n.startsWith(".") || SKIP.has(n)) continue;
        const path = join(dir, n);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(path);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (depth < MAX_DEPTH) walk(path, depth + 1);
        } else if (n.endsWith(".pipo") && st.isFile()) {
          let name: string | null = null;
          try {
            const v = load(readFileSync(path, "utf8")).value as { name?: unknown } | undefined;
            name = typeof v?.name === "string" ? v.name : null;
          } catch {}
          files.push({ file: path, rel: relative(root, path), name });
        }
      }
    };
    walk(root, 1);
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return { workspace: root, files };
  }

  open(url: URL) {
    const pipeline = url.searchParams.get("pipeline");
    let raw = url.searchParams.get("file") ?? undefined;
    if (pipeline !== null) {
      if (raw !== undefined) throw bad("send `file` or `pipeline`, not both", "drop one of them");
      const info = NAME.test(pipeline) ? this.engine.get(pipeline) : undefined;
      if (!info) {
        throw new HttpError(
          404,
          `no pipeline named '${pipeline}' in this engine`,
          "GET /api/pipelines lists them; open a file with ?file=<path> instead",
          "not_found",
        );
      }
      raw = info.file;
    }
    const { file } = this.allowed(raw, "open");
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch (e) {
      throw new HttpError(
        404,
        `can't read ${file}: ${(e as Error).message}`,
        "check the path; GET /api/builder/files lists the workspace's pipelines",
        "not_found",
      );
    }
    const dir = join(dirname(file), "fixtures");
    let fixtures: { name: string; data: unknown; meta?: unknown; stubs?: unknown }[] = [];
    let fixturesError: string | undefined;
    try {
      fixtures = loadFixtures(dir).map(({ name, data, meta, stubs }) => ({
        name,
        data,
        ...(meta === undefined ? {} : { meta }),
        ...(stubs === undefined ? {} : { stubs }),
      }));
    } catch (e) {
      fixturesError = e instanceof FixtureError && e.hint ? `${e.message} (${e.hint})` : (e as Error).message;
    }
    let stubs: Body | null = null;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, "stubs.json"), "utf8"));
      if (isObject(parsed)) stubs = parsed;
    } catch {}
    const info = this.known(file);
    const version = info?.version ?? null;
    return {
      file,
      source,
      pipeline: load(source, file).value ?? null,
      diagnostics: this.diagnostics(source, file),
      fixtures,
      ...(fixturesError === undefined ? {} : { fixtures_error: fixturesError }),
      stubs,
      running: info
        ? {
            name: info.name,
            state: info.state,
            version,
            version_source: version === null ? null : pinnedSource(journalPath(this.engine.home, info.name), version),
          }
        : null,
    };
  }

  /** A schema file next to a pipeline: `file` is the pipeline (it may not exist yet), `path` as the pipeline names it. */
  private schemaTarget(file: string | undefined, path: string | undefined) {
    const pipeline = this.allowed(file, "open");
    if (!path || isAbsolute(path) || !path.endsWith(".json")) {
      throw bad(
        `schema path '${path ?? ""}' must be a relative .json path`,
        "name it as the pipeline does, for example ./summary.schema.json",
      );
    }
    const dir = dirname(pipeline.file);
    const target = resolve(dir, path);
    if (!within(realish(dir), realish(target))) {
      throw new HttpError(
        403,
        `${path} is outside the pipeline's folder ${dir}`,
        "keep schema files in the pipeline's folder or below it",
        "forbidden",
      );
    }
    return { pipeline, target };
  }

  readSchema(url: URL) {
    const path = url.searchParams.get("path") ?? undefined;
    const { target } = this.schemaTarget(url.searchParams.get("file") ?? undefined, path);
    if (!existsSync(target)) return { file: target, path, exists: false, schema: null, problem: null };
    const text = readFileSync(target, "utf8");
    let schema: unknown = null;
    let problem: string | null;
    try {
      schema = JSON.parse(text);
      problem = schemaProblem(schema);
    } catch (e) {
      problem = `not JSON (${(e as Error).message})`;
    }
    return { file: target, path, exists: true, schema, problem, ...(schema === null ? { text } : {}) };
  }

  writeSchema(body: Body) {
    only(body, ["file", "path", "schema", "overwrite"]);
    const { pipeline, target } = this.schemaTarget(str(body, "file", true), str(body, "path", true));
    const problem = schemaProblem(body.schema);
    if (body.schema === undefined || problem) {
      throw bad(
        `that is not a usable JSON Schema: ${problem ?? "send it as `schema`"}`,
        'for example {"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"]}',
      );
    }
    if (body.overwrite !== undefined && typeof body.overwrite !== "boolean") {
      throw bad("`overwrite` must be true or false", "send overwrite: true to replace an existing file");
    }
    const exists = existsSync(target);
    if (exists && body.overwrite !== true) {
      throw new HttpError(409, `${target} already exists`, "send overwrite: true to replace it", "conflict", {
        file: target,
      });
    }
    const dir = dirname(target);
    if (!existsSync(dir)) {
      if (!pipeline.inside) throw bad(`the folder ${dir} does not exist`, "create it first");
      mkdirSync(dir, { recursive: true });
    }
    const tmp = join(dir, `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(body.schema, null, 2)}\n`);
    renameSync(tmp, target);
    return { file: target, created: !exists };
  }

  check(body: Body) {
    only(body, ["source", "pipeline", "base", "file"]);
    const hasSource = body.source !== undefined && body.source !== null;
    const hasPipeline = body.pipeline !== undefined && body.pipeline !== null;
    if (hasSource === hasPipeline) {
      throw bad(
        "send exactly one of `source` and `pipeline`",
        "`source` is .pipo text; `pipeline` is its parsed value",
      );
    }
    let source: string;
    if (hasPipeline) {
      if (!isObject(body.pipeline)) throw bad("`pipeline` must be an object", "send the parsed pipeline as JSON");
      source = toSource(body.pipeline, str(body, "base", false));
      if (Buffer.byteLength(source) > MAX_SOURCE) sourceOf({ source });
    } else source = sourceOf(body);
    const value = load(source).value as { name?: unknown } | undefined;
    const raw = str(body, "file", false);
    if (raw !== undefined && !isAbsolute(raw)) throw bad("`file` must be an absolute path", "or leave it out");
    const name = typeof value?.name === "string" && NAME.test(value.name) ? value.name : "draft";
    const file = raw === undefined ? join(this.workspace, `${name}.pipo`) : resolve(raw);
    const diagnostics = this.diagnostics(source, file);
    return {
      source,
      pipeline: value ?? null,
      diagnostics,
      ok: !diagnostics.some((d) => d.severity === "error"),
    };
  }

  save(body: Body) {
    only(body, ["file", "source", "overwrite"]);
    const source = sourceOf(body);
    if (body.overwrite !== undefined && typeof body.overwrite !== "boolean") {
      throw bad("`overwrite` must be true or false", "send overwrite: true to replace an existing file");
    }
    const { file, inside } = this.allowed(str(body, "file", true), "save");
    const exists = existsSync(file);
    if (exists && body.overwrite !== true) {
      throw new HttpError(409, `${file} already exists`, "send overwrite: true to replace it", "conflict", { file });
    }
    if (exists && !statSync(file).isFile()) throw bad(`${file} is not a file`, "pick another name");
    const dir = dirname(file);
    if (!existsSync(dir)) {
      if (!inside) throw bad(`the folder ${dir} does not exist`, "create it first");
      mkdirSync(dir, { recursive: true });
    }
    const tmp = join(dir, `.${basename(file)}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, source);
    renameSync(tmp, file);
    return { file, created: !exists, diagnostics: this.diagnostics(source, file) };
  }

  async test(body: Body) {
    only(body, ["source", "file", "fixtures", "stubs"]);
    const source = sourceOf(body);
    const raw = str(body, "file", false);
    if (raw !== undefined && !isAbsolute(raw)) throw bad("`file` must be an absolute path", "or leave it out");
    const value = load(source).value as { name?: unknown } | undefined;
    const name = typeof value?.name === "string" && NAME.test(value.name) ? value.name : "draft";
    const file = raw === undefined ? join(this.workspace, `${name}.pipo`) : resolve(raw);
    const fixtures = body.fixtures;
    const form = 'send fixtures: [{"name": "one", "data": {…}}] (meta and stubs are optional)';
    if (!Array.isArray(fixtures) || !fixtures.length) throw bad("`fixtures` must be a non-empty list", form);
    if (fixtures.length > MAX_FIXTURES) throw bad(`at most ${MAX_FIXTURES} fixtures per run`, "send fewer");
    if (!fixtures.every(isObject)) throw bad("each fixture must be an object", form);
    if (body.stubs !== undefined && body.stubs !== null && !isObject(body.stubs)) {
      throw bad("`stubs` must be an object of node id → response", 'for example {"classify": {"label": "urgent"}}');
    }
    try {
      return await testPipeline({
        file,
        source,
        fixtures: fixtures as never,
        stubs: (body.stubs ?? undefined) as Body | undefined,
        home: this.engine.home,
        trace: true,
        now: Date.now(),
      });
    } catch (e) {
      if (e instanceof TestPrepareError) {
        throw new HttpError(
          422,
          e.message,
          e.gaps.length
            ? "remove the features the runner doesn't implement yet (see gaps)"
            : "fix the diagnostics first (POST /api/builder/check shows them)",
          "invalid_pipeline",
          { diagnostics: e.diagnostics, gaps: e.gaps },
        );
      }
      if (e instanceof FixtureError) throw bad(e.message, e.hint ?? form);
      throw e;
    }
  }
}
