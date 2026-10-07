// CLI agents (docs/spec.md §3.4, D67): `claude_code`, `codex`, `pi` and `opencode` hand the rendered prompt to a
// coding-agent CLI installed and logged in on this machine, running as the user. Each call gets its own temp folder:
// the prompt goes in on stdin from a file, and the CLI's stdout and stderr (and Codex's last message) go to files that
// are read once the process exits, so no pipe has to be drained. The CLI runs in its own process group, which is
// killed whole when the call is aborted. Without `allow_tools` the CLI runs with its tools off (or read-only), in an
// empty folder unless `cwd` names one.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS } from "@pipo/spec";
import { AgentCallError, type AgentProvider, type AgentRequest, type AgentResult, type AgentUsage } from "./types";

export interface CliRun {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  stdin?: string;
  /** Where the process runs; the run's own folder when not given. */
  cwd?: string;
  signal?: AbortSignal;
  /** Kill the process after this many ms. */
  timeoutMs?: number;
  /** The folder for the stdin/stdout/stderr files; a temp folder, removed afterwards, when not given. */
  dir?: string;
  env?: Record<string, string | undefined>;
}

/** Run a command to its exit with stdin, stdout and stderr on files. Rejects only when it can't be started. */
export async function runCli(command: string, args: string[], o: RunOptions = {}): Promise<CliRun> {
  const own = !o.dir;
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "pipo-cli-"));
  const paths = { in: join(dir, "stdin"), out: join(dir, "stdout"), err: join(dir, "stderr") };
  writeFileSync(paths.in, o.stdin ?? "");
  const fds = [openSync(paths.in, "r"), openSync(paths.out, "w"), openSync(paths.err, "w")];
  try {
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: o.cwd ?? dir,
        stdio: fds,
        detached: true,
        env: (o.env ?? process.env) as NodeJS.ProcessEnv,
      });
      let hard: ReturnType<typeof setTimeout> | undefined;
      const group = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {}
      };
      const kill = () => {
        group("SIGTERM");
        hard ??= setTimeout(() => group("SIGKILL"), 2000);
      };
      const timer = o.timeoutMs ? setTimeout(kill, o.timeoutMs) : undefined;
      const done = () => {
        clearTimeout(timer);
        clearTimeout(hard);
        o.signal?.removeEventListener("abort", kill);
      };
      o.signal?.addEventListener("abort", kill, { once: true });
      if (o.signal?.aborted) kill();
      child.once("error", (e) => {
        done();
        reject(e);
      });
      child.once("exit", (code, signal) => {
        done();
        // Whatever the CLI left running in its group (MCP servers, shells) goes with it.
        group("SIGTERM");
        resolve({ code, signal });
      });
    });
    return { ...exit, stdout: readFileSync(paths.out, "utf8"), stderr: readFileSync(paths.err, "utf8") };
  } finally {
    for (const fd of fds) closeSync(fd);
    if (own) rmSync(dir, { recursive: true, force: true });
  }
}

/** The last `n` characters of a CLI's stderr, on one line, for an error message. */
function tail(text: string, n = 300): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > n ? `…${t.slice(-n)}` : t;
}

function exitText(label: string, run: CliRun): string {
  const how = run.signal ? `was killed (${run.signal})` : `exited with code ${run.code}`;
  const why = tail(run.stderr) || tail(run.stdout);
  return `${label} ${how}${why ? `: ${why}` : ""}`;
}

/** JSON lines of a CLI's event stream (or one JSON document); lines that aren't JSON (banners, warnings) are skipped. */
function jsonLines(text: string): any[] {
  try {
    return [JSON.parse(text)];
  } catch {}
  const out: any[] = [];
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("{")) continue;
    try {
      out.push(JSON.parse(l));
    } catch {}
  }
  return out;
}

/** The JSON value in a model's text answer: the whole text, a fenced block, or the outermost {…} / […]. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const tries = [t];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence?.[1]) tries.push(fence[1].trim());
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const a = t.indexOf(open);
    const b = t.lastIndexOf(close);
    if (a >= 0 && b > a) tries.push(t.slice(a, b + 1));
  }
  for (const s of tries) {
    try {
      return JSON.parse(s);
    } catch {}
  }
  throw new Error(`the answer is not JSON: ${tail(t, 200) || "(empty)"}`);
}

/** A non-object schema is asked for as `{ value }` (structured output wants an object) and unwrapped again. */
function wrapSchema(schema: Record<string, unknown>): { schema: Record<string, unknown>; wrapped: boolean } {
  const { $schema: _s, $id: _i, ...rest } = schema;
  if (rest.type === "object") return { schema: rest, wrapped: false };
  return {
    schema: { type: "object", properties: { value: rest }, required: ["value"], additionalProperties: false },
    wrapped: true,
  };
}

type Schema = Record<string, any>;

/**
 * OpenAI's strict structured output (Codex): every object closed and every property required, the optional ones
 * nullable (their nulls are dropped from the answer again). Null for a schema it can't express, such as an object
 * without `properties`; that schema is then asked for in the prompt instead.
 */
export function strictSchema(schema: Schema): Schema | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const out: Schema = { ...schema };
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (!Array.isArray(schema[key])) continue;
    const list = schema[key].map(strictSchema);
    if (list.includes(null)) return null;
    out[key] = list;
  }
  for (const key of ["$defs", "definitions"]) {
    if (!schema[key] || typeof schema[key] !== "object") continue;
    const defs: Schema = {};
    for (const [k, v] of Object.entries(schema[key] as Schema)) {
      const d = strictSchema(v);
      if (d === null) return null;
      defs[k] = d;
    }
    out[key] = defs;
  }
  if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    const items = strictSchema(schema.items);
    if (items === null) return null;
    out.items = items;
  }
  // "Anything" ({}, or a schema without a type) can't be said strictly.
  if (!["type", "anyOf", "oneOf", "allOf", "enum", "const", "$ref", "properties"].some((k) => k in schema)) return null;
  const types = [schema.type].flat();
  if (types.includes("object") || schema.properties) {
    const props = schema.properties as Schema | undefined;
    if (!props || !Object.keys(props).length || (schema.additionalProperties && schema.additionalProperties !== false))
      return null;
    const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
    const closed: Schema = {};
    for (const [k, v] of Object.entries(props)) {
      const sub = strictSchema(v);
      if (sub === null) return null;
      closed[k] = required.has(k) ? sub : { anyOf: [sub, { type: "null" }] };
    }
    out.properties = closed;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

/** Drop the nulls strictSchema let optional properties have, so the answer matches the node's own schema. */
function dropNulls(value: unknown, schema: Schema | undefined): unknown {
  if (!schema || typeof schema !== "object" || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => dropNulls(v, schema.items));
  const props = schema.properties as Schema | undefined;
  if (!props) return value;
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null && !required.has(k) && props[k]) continue;
    out[k] = dropNulls(v, props[k]);
  }
  return out;
}

function schemaInPrompt(prompt: string, schema: Record<string, unknown>): string {
  return `${prompt}\n\n---\nAnswer with only a JSON value that matches this JSON Schema: no other text, no code fences.\n${JSON.stringify(schema)}\n`;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

interface Parsed extends AgentUsage {
  output: unknown;
}

interface Call {
  req: AgentRequest;
  schema: Record<string, unknown>;
  /** The schema the CLI enforces itself, or null: then it is asked for in the prompt. */
  native: Record<string, unknown> | null;
  /** The call's folder: `schema.json` and `last.txt` live here. */
  dir: string;
}

export interface Readiness {
  ready: boolean;
  version?: string;
  reason?: string;
  hint?: string;
}

interface CliSpec {
  /** The schema this CLI can enforce (as given, or rewritten), or null when it can't. */
  native(schema: Schema): Schema | null;
  args(c: Call): string[];
  env?(c: Call): Record<string, string>;
  parse(run: CliRun, c: Call): Parsed;
  /** Logged in (or set up with at least one model), once installed. */
  auth(command: string): Promise<Readiness>;
  models(command: string): Promise<string[]>;
  install: string;
}

const PROBE_MS = 20_000;
const probe = (command: string, args: string[]) => runCli(command, args, { timeoutMs: PROBE_MS });

/** The models offered for Claude (Claude Code takes the aliases too); there is no CLI command that lists them. */
export const CLAUDE_MODELS = [
  "sonnet",
  "opus",
  "haiku",
  "fable",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-haiku-4-5",
  "claude-fable-5-1",
];

const SPECS: Record<string, CliSpec> = {
  claude_code: {
    install:
      "install Claude Code (curl -fsSL https://claude.ai/install.sh | bash, or npm install -g @anthropic-ai/claude-code)",
    native: (schema) => schema,
    args: ({ req, native }) => [
      "-p",
      "--output-format",
      "json",
      ...(native ? ["--json-schema", JSON.stringify(native)] : []),
      "--no-session-persistence",
      // No hooks, plugins, MCP servers or CLAUDE.md from the user's setup: the node's prompt is the whole context.
      "--safe-mode",
      ...(req.model ? ["--model", req.model] : []),
      ...(req.allow_tools ? ["--permission-mode", "bypassPermissions"] : ["--tools", ""]),
    ],
    parse(run) {
      const body = jsonLines(run.stdout).findLast((j) => j?.type === "result");
      if (!body) throw new AgentCallError(exitText("Claude Code", run));
      const u = body.usage ?? {};
      const usage: AgentUsage = {
        input_tokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
        output_tokens: num(u.output_tokens),
        cost_usd: num(body.total_cost_usd),
      };
      if (body.is_error || body.subtype !== "success")
        throw new AgentCallError(`Claude Code: ${tail(String(body.result ?? body.subtype ?? "failed"))}`, usage);
      let output = body.structured_output;
      if (output === undefined) {
        try {
          output = extractJson(String(body.result ?? ""));
        } catch (e) {
          throw new AgentCallError(`Claude Code returned no structured output: ${(e as Error).message}`, usage);
        }
      }
      return { output, ...usage };
    },
    async auth(command) {
      const run = await probe(command, ["auth", "status", "--json"]);
      const status = jsonLines(run.stdout)[0];
      if (status?.loggedIn === true) return { ready: true };
      return {
        ready: false,
        reason: "Claude Code is installed but not logged in",
        hint: "run `claude auth login` (or start `claude` and use /login), then try again",
      };
    },
    models: async () => CLAUDE_MODELS,
  },

  codex: {
    install: "install the Codex CLI (npm install -g @openai/codex)",
    native: strictSchema,
    args: ({ req, dir, native }) => [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--color",
      "never",
      "--json",
      ...(native ? ["--output-schema", join(dir, "schema.json")] : []),
      "--output-last-message",
      join(dir, "last.txt"),
      "--sandbox",
      req.allow_tools ? "workspace-write" : "read-only",
      ...(req.model ? ["--model", req.model] : []),
      "-",
    ],
    parse(run, { dir }) {
      const events = jsonLines(run.stdout);
      const usage: AgentUsage = { input_tokens: 0, output_tokens: 0 };
      for (const e of events)
        if (e?.type === "turn.completed") {
          // cached_input_tokens is part of input_tokens, and reasoning_output_tokens part of output_tokens.
          usage.input_tokens += num(e.usage?.input_tokens);
          usage.output_tokens += num(e.usage?.output_tokens);
        }
      const failed = events.findLast((e) => e?.type === "turn.failed" || e?.type === "error");
      if (failed) {
        const raw = String(failed.error?.message ?? failed.message ?? "failed");
        let message = raw;
        try {
          message = JSON.parse(raw)?.error?.message ?? raw;
        } catch {}
        throw new AgentCallError(`Codex: ${tail(message)}`, usage);
      }
      let last = "";
      try {
        last = readFileSync(join(dir, "last.txt"), "utf8");
      } catch {}
      if (!last.trim()) throw new AgentCallError(exitText("Codex returned no answer;", run), usage);
      try {
        return { output: extractJson(last), ...usage };
      } catch (e) {
        throw new AgentCallError(`Codex: ${(e as Error).message}`, usage);
      }
    },
    async auth(command) {
      const run = await probe(command, ["login", "status"]);
      if (run.code === 0 && /logged in/i.test(run.stdout + run.stderr)) return { ready: true };
      return {
        ready: false,
        reason: "the Codex CLI is installed but not logged in",
        hint: "run `codex login`, then try again",
      };
    },
    async models(command) {
      const run = await probe(command, ["debug", "models"]);
      try {
        const list = JSON.parse(run.stdout)?.models;
        if (!Array.isArray(list)) return [];
        return list
          .filter((m: any) => typeof m?.slug === "string" && (m.visibility ?? "list") === "list")
          .map((m: any) => m.slug as string);
      } catch {
        return [];
      }
    },
  },

  pi: {
    install: "install pi (npm install -g @earendil-works/pi-coding-agent)",
    native: () => null,
    args: ({ req }) => [
      "-p",
      "--mode",
      "json",
      "--no-session",
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      ...(req.model ? ["--model", req.model] : []),
      ...(req.allow_tools ? [] : ["--no-tools"]),
    ],
    parse(run) {
      const usage: AgentUsage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
      let last: any;
      for (const e of jsonLines(run.stdout)) {
        if (e?.type !== "message_end" || e.message?.role !== "assistant") continue;
        const u = e.message.usage ?? {};
        usage.input_tokens += num(u.input) + num(u.cacheRead) + num(u.cacheWrite);
        usage.output_tokens += num(u.output);
        usage.cost_usd = num(usage.cost_usd) + num(u.cost?.total);
        last = e.message;
      }
      if (!last) throw new AgentCallError(exitText("pi", run));
      if (last.stopReason === "error" || last.stopReason === "aborted")
        throw new AgentCallError(`pi: ${tail(String(last.errorMessage ?? `request ${last.stopReason}`))}`, usage);
      const text = (Array.isArray(last.content) ? last.content : [])
        .filter((c: any) => c?.type === "text")
        .map((c: any) => String(c.text))
        .join("");
      try {
        return { output: extractJson(text), ...usage };
      } catch (e) {
        throw new AgentCallError(`pi: ${(e as Error).message}`, usage);
      }
    },
    async auth(command) {
      const models = await SPECS.pi?.models(command);
      if (models?.length) return { ready: true };
      return {
        ready: false,
        reason: "pi has no model with credentials set up",
        hint: "set up a provider in pi (start `pi` and use /login, or export a provider API key), then try again",
      };
    },
    async models(command) {
      const run = await probe(command, ["--list-models"]);
      if (run.code !== 0) return [];
      return run.stdout
        .split("\n")
        .slice(1)
        .map((l) => l.trim().split(/\s+/))
        .filter((c) => c.length >= 2 && c[0] && c[1])
        .map((c) => `${c[0]}/${c[1]}`);
    },
  },

  opencode: {
    install: "install opencode (curl -fsSL https://opencode.ai/install | bash)",
    native: () => null,
    args: ({ req }) => [
      "run",
      "--format",
      "json",
      ...(req.model ? ["--model", req.model] : []),
      ...(req.allow_tools ? ["--auto"] : []),
    ],
    // Tools off: opencode asks for nothing, and every tool is denied on top of the empty folder.
    env: ({ req }): Record<string, string> =>
      req.allow_tools
        ? {}
        : {
            OPENCODE_PERMISSION: JSON.stringify(
              Object.fromEntries(
                [
                  "read",
                  "edit",
                  "glob",
                  "grep",
                  "list",
                  "bash",
                  "task",
                  "webfetch",
                  "websearch",
                  "external_directory",
                ].map((k) => [k, "deny"]),
              ),
            ),
          },
    parse(run) {
      const usage: AgentUsage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
      let text: string | undefined;
      for (const e of jsonLines(run.stdout)) {
        if (e?.type === "text" && typeof e.part?.text === "string") text = e.part.text;
        if (e?.type === "step_finish") {
          const t = e.part?.tokens ?? {};
          usage.input_tokens += num(t.input) + num(t.cache?.read) + num(t.cache?.write);
          usage.output_tokens += num(t.output);
          usage.cost_usd = num(usage.cost_usd) + num(e.part?.cost);
        }
        if (e?.type === "error") {
          const err = e.error ?? {};
          throw new AgentCallError(`opencode: ${tail(String(err.data?.message ?? err.name ?? "failed"))}`, usage);
        }
      }
      if (text === undefined) throw new AgentCallError(exitText("opencode returned no answer;", run), usage);
      try {
        return { output: extractJson(text), ...usage };
      } catch (e) {
        throw new AgentCallError(`opencode: ${(e as Error).message}`, usage);
      }
    },
    async auth(command) {
      const models = await SPECS.opencode?.models(command);
      if (models?.length) return { ready: true };
      return {
        ready: false,
        reason: "opencode has no model set up",
        hint: "run `opencode auth login`, then try again",
      };
    },
    async models(command) {
      const run = await probe(command, ["models"]);
      if (run.code !== 0) return [];
      return run.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^[\w.-]+\/\S+$/.test(l));
    },
  },
};

export const CLI_AGENTS = Object.keys(SPECS);

const label = (provider: string) => AGENTS[provider]?.label ?? provider;

/** Whether a CLI agent can run here: installed (answers `--version`) and logged in or set up. */
export async function cliReadiness(provider: string, command: string): Promise<Readiness> {
  const spec = SPECS[provider];
  if (!spec) return { ready: false, reason: `'${provider}' is not a CLI agent` };
  let version: string | undefined;
  try {
    const run = await probe(command, ["--version"]);
    if (run.code !== 0) {
      return {
        ready: false,
        reason: `${label(provider)} is installed but '${command} --version' failed: ${tail(run.stderr || run.stdout) || `exit ${run.code}`}`,
        hint: `check that '${command}' works in a terminal, or point agents.${provider}.command in config.yaml at a working one`,
      };
    }
    version = run.stdout.trim().split("\n")[0];
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      ready: false,
      reason:
        code === "ENOENT"
          ? `${label(provider)} isn't installed here (no '${command}' on PATH)`
          : `'${command}' can't be started: ${(e as Error).message}`,
      hint: `${spec.install}, or point agents.${provider}.command in config.yaml at it`,
    };
  }
  try {
    return { ...(await spec.auth(command)), version };
  } catch (e) {
    return { ready: false, version, reason: `${label(provider)}'s login check failed: ${(e as Error).message}` };
  }
}

/** The models a CLI agent offers here, as its CLI lists them (an empty list when it can't say). */
export async function cliModels(provider: string, command: string): Promise<string[]> {
  try {
    return (await SPECS[provider]?.models(command)) ?? [];
  } catch {
    return [];
  }
}

export class CliProvider implements AgentProvider {
  constructor(
    readonly provider: string,
    readonly command: string,
  ) {
    if (!SPECS[provider]) throw new Error(`'${provider}' is not a CLI agent`);
  }

  async complete(req: AgentRequest): Promise<AgentResult> {
    const spec = SPECS[this.provider] as CliSpec;
    const { schema, wrapped } = wrapSchema(req.schema);
    const dir = mkdtempSync(join(tmpdir(), `pipo-${this.provider}-`));
    try {
      const work = join(dir, "work");
      mkdirSync(work);
      const native = spec.native(schema);
      if (native) writeFileSync(join(dir, "schema.json"), JSON.stringify(native));
      const call: Call = { req, schema, native, dir };
      let run: CliRun;
      try {
        run = await runCli(this.command, spec.args(call), {
          stdin: native ? req.prompt : schemaInPrompt(req.prompt, schema),
          cwd: req.cwd ?? work,
          signal: req.signal,
          dir,
          env: { ...process.env, ...spec.env?.(call) },
        });
      } catch (e) {
        throw new AgentCallError(
          `${label(this.provider)} can't be started ('${this.command}'): ${(e as Error).message}`,
        );
      }
      if (req.signal.aborted) throw new AgentCallError(`${label(this.provider)} was stopped (with.timeout)`);
      const parsed = spec.parse(run, call);
      let output = native && native !== schema ? dropNulls(parsed.output, schema) : parsed.output;
      if (wrapped) output = output && typeof output === "object" ? (output as Schema).value : undefined;
      return { ...parsed, output };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
