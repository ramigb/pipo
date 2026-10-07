// Engine config, `<home>/config.yaml` (docs/spec.md §7.1, D25). A missing file means every default.
// Unknown keys are errors, so a typo never silently falls back to a default.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  AGENT_DEFAULTS,
  type AgentsConfig,
  formatDuration,
  isTimeZone,
  load,
  parseAgentsConfig,
  parseDuration,
} from "@pipo/spec";
import { EngineError } from "./errors";
import { configPath } from "./home";

export interface RestartConfig {
  /** First delay before restarting a crashed runner (ms). Doubles on each crash. */
  backoff: number;
  /** The delay never grows past this (ms). */
  max_backoff: number;
  /** A runner up at least this long before it crashes starts again from `backoff` (ms). */
  stable: number;
  /** Restarts allowed within `window`; one more crash marks the pipeline `crashed`. */
  max_restarts: number;
  /** Sliding window for `max_restarts` (ms). */
  window: number;
}

/** What an MCP token may do (§9.2, D53); each scope includes the ones before it. */
export const MCP_SCOPES = ["read", "operate", "edit"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** One `engine.mcp.tokens` entry: a secret reference (never the value), its scope and an optional allowlist. */
export interface McpTokenConfig {
  /** Who the token is: the author of its proposals and the `by` of what it does. */
  name: string;
  /** `op://…` or `env:…`, resolved when the engine starts. */
  token: string;
  scope: McpScope;
  /** Pipelines it may see; null: all. */
  pipelines: string[] | null;
}

export interface EngineConfig {
  /** Engine TTL (ms), §7.5, D31: counted from engine start; on expiry every pipeline drains and the engine stops. */
  ttl: number | null;
  /** How long the engine stays up with nothing to do before it sleeps (exits), §7.5, D31. */
  idle: number;
  /** Start runners detached by default (§7.2, D30): they outlive the engine, and shutdown leaves them running. */
  detached: boolean;
  /** Gateway port (§7.1, D28) on 127.0.0.1; 0 picks a free one (written to run/engine.json). Null: no gateway. */
  listen: number | null;
  /** Environment variables exposed to expressions as `env` (§14.2), passed to every runner. */
  env_allow: string[];
  /** How long a runner may take to register and answer `hello` (ms). */
  start_timeout: number;
  /** How long `stop --now` waits for the runner to exit before killing it (ms). */
  stop_timeout: number;
  restart: RestartConfig;
  /** IANA time zone for agent budget days (§3.11, D37); null: the system's own. */
  timezone: string | null;
  /**
   * Engine-wide agent budget (§3.11, D58). Validated here; runners read it from config.yaml themselves and check it
   * against the spend of every journal of the home.
   */
  agent_budget: { per_day: number } | null;
  /** Top-level `agents:` (§3.11, D36): price tables, API key references and base URLs, merged over the defaults. */
  agents: AgentsConfig;
  /** The MCP endpoint `/mcp` (§9.2, D53): with no tokens it refuses every request. */
  mcp: { tokens: McpTokenConfig[] };
  /** Where the builder saves new pipelines (§8, D72), an absolute path; `--workspace` wins. Null: the working directory. */
  workspace: string | null;
}

export const DEFAULT_CONFIG: EngineConfig = {
  ttl: null,
  idle: 300_000,
  detached: false,
  listen: null,
  env_allow: [],
  start_timeout: 15_000,
  stop_timeout: 15_000,
  restart: { backoff: 1000, max_backoff: 30_000, stable: 60_000, max_restarts: 5, window: 600_000 },
  timezone: null,
  agent_budget: null,
  agents: AGENT_DEFAULTS,
  mcp: { tokens: [] },
  workspace: null,
};

type Field =
  | { kind: "duration"; min?: number }
  | { kind: "boolean" }
  | { kind: "port" }
  | { kind: "count" }
  | { kind: "names" }
  | { kind: "timezone" }
  | { kind: "path" };

const ENGINE_FIELDS: Record<string, Field> = {
  ttl: { kind: "duration", min: 1 },
  idle: { kind: "duration", min: 1000 },
  detached: { kind: "boolean" },
  listen: { kind: "port" },
  env_allow: { kind: "names" },
  start_timeout: { kind: "duration", min: 100 },
  stop_timeout: { kind: "duration", min: 100 },
  timezone: { kind: "timezone" },
  workspace: { kind: "path" },
};
const RESTART_FIELDS: Record<string, Field> = {
  backoff: { kind: "duration", min: 1 },
  max_backoff: { kind: "duration", min: 1 },
  stable: { kind: "duration", min: 1 },
  max_restarts: { kind: "count" },
  window: { kind: "duration", min: 1 },
};

const EXAMPLE = `engine:
  restart: { backoff: 1s, max_backoff: 30s, stable: 1m, max_restarts: 5, window: 10m }`;

const MCP_TOKEN_KEYS = ["name", "token", "scope", "pipelines"];
const MCP_TOKEN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MCP_EXAMPLE = `engine:
  mcp:
    tokens:
      - { name: ops-agent, token: env:PIPO_MCP_TOKEN, scope: operate, pipelines: [people-intake] }`;

/** Read and validate `<home>/config.yaml`. Throws EngineError (`config`) listing every problem. */
export function loadConfig(home: string): EngineConfig {
  const path = configPath(home);
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (e) {
    throw new EngineError("config", `cannot read ${path}: ${(e as Error).message}`, "check the file's permissions");
  }
  return parseConfig(source, path);
}

export function parseConfig(source: string, file = "config.yaml"): EngineConfig {
  const loaded = load(source, file);
  if (loaded.diagnostics.length) {
    const d = loaded.diagnostics[0]!;
    throw new EngineError("config", `${file}:${d.line}:${d.col} ${d.message}`, "fix the YAML syntax", [
      ...loaded.diagnostics,
    ]);
  }
  const raw = loaded.value as unknown;
  const config = structuredClone(DEFAULT_CONFIG);
  const problems: string[] = [];
  const at = (path: (string | number)[], key = false) => {
    const p = loaded.locate(path, key);
    return `${file}:${p.line}:${p.col}`;
  };
  const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

  if (raw === undefined || raw === null) return config;
  if (!isMap(raw)) {
    throw new EngineError("config", `${file}: expected a mapping with an \`engine\` key`, `for example:\n${EXAMPLE}`);
  }
  for (const key of Object.keys(raw)) {
    if (key !== "engine" && key !== "agents")
      problems.push(`${at([key], true)} unknown key '${key}' (top-level keys: engine, agents)`);
  }
  const agents = parseAgentsConfig(raw.agents);
  config.agents = agents.value;
  for (const p of agents.problems) problems.push(`${at(p.path, p.key)} ${p.message}`);
  const engine = raw.engine;
  if (engine !== undefined && engine !== null) {
    if (!isMap(engine)) problems.push(`${at(["engine"])} 'engine' must be a mapping`);
    else {
      readFields(engine, ["engine"], ENGINE_FIELDS, config as unknown as Record<string, unknown>, [
        "restart",
        "agent_budget",
        "mcp",
      ]);
      if (engine.mcp !== undefined && engine.mcp !== null) config.mcp = readMcp(engine.mcp);
      const budget = engine.agent_budget;
      if (budget !== undefined && budget !== null) {
        const perDay = isMap(budget) ? budget.per_day : undefined;
        const extra = isMap(budget) ? Object.keys(budget).filter((k) => k !== "per_day") : [];
        if (!isMap(budget) || typeof perDay !== "number" || perDay < 0 || extra.length)
          problems.push(
            `${at(["engine", "agent_budget"])} engine.agent_budget must be { per_day: <USD> } (a number ≥ 0), got ${JSON.stringify(budget)}`,
          );
        else config.agent_budget = { per_day: perDay };
      }
      const restart = engine.restart;
      if (restart !== undefined && restart !== null) {
        if (!isMap(restart)) problems.push(`${at(["engine", "restart"])} 'engine.restart' must be a mapping`);
        else
          readFields(
            restart,
            ["engine", "restart"],
            RESTART_FIELDS,
            config.restart as unknown as Record<string, unknown>,
          );
      }
    }
  }
  if (!problems.length && config.restart.max_backoff < config.restart.backoff) {
    problems.push(
      `${at(["engine", "restart", "max_backoff"])} engine.restart.max_backoff (${formatDuration(config.restart.max_backoff)}) is shorter than engine.restart.backoff (${formatDuration(config.restart.backoff)})`,
    );
  }
  if (problems.length) {
    throw new EngineError(
      "config",
      `${file} has ${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join("\n")}`,
      `fix or remove those keys (a missing key uses its default); for example:\n${EXAMPLE}`,
    );
  }
  return config;

  function readMcp(mcp: unknown): EngineConfig["mcp"] {
    const out: McpTokenConfig[] = [];
    const seen = new Set<string>();
    if (!isMap(mcp)) {
      problems.push(`${at(["engine", "mcp"])} engine.mcp must be a mapping such as { tokens: [...] }`);
      return { tokens: out };
    }
    for (const key of Object.keys(mcp))
      if (key !== "tokens")
        problems.push(`${at(["engine", "mcp", key], true)} unknown key 'engine.mcp.${key}' (known: tokens)`);
    const tokens = mcp.tokens ?? [];
    if (!Array.isArray(tokens)) {
      problems.push(
        `${at(["engine", "mcp", "tokens"])} engine.mcp.tokens must be a list, for example:\n${MCP_EXAMPLE}`,
      );
      return { tokens: out };
    }
    tokens.forEach((t, i) => {
      const path = ["engine", "mcp", "tokens", i];
      const name = `engine.mcp.tokens[${i}]`;
      if (!isMap(t)) {
        problems.push(
          `${at(path)} ${name} must be a mapping such as { name: ops-agent, token: env:PIPO_MCP_TOKEN, scope: read }`,
        );
        return;
      }
      const before = problems.length;
      for (const key of Object.keys(t))
        if (!MCP_TOKEN_KEYS.includes(key))
          problems.push(
            `${at([...path, key], true)} unknown key '${key}' in ${name} (known: ${MCP_TOKEN_KEYS.join(", ")})`,
          );
      if (typeof t.name !== "string" || !MCP_TOKEN_NAME.test(t.name))
        problems.push(
          `${at([...path, "name"])} ${name}.name must be letters, digits, '.', '_' or '-' (up to 64), got ${JSON.stringify(t.name)}`,
        );
      else if (seen.has(t.name))
        problems.push(
          `${at([...path, "name"])} ${name}.name '${t.name}' is used by another token; names must be unique`,
        );
      if (typeof t.name === "string") seen.add(t.name);
      if (typeof t.token !== "string" || !(t.token.startsWith("op://") || /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(t.token)))
        // Never echo the value: it may be the literal token pasted in.
        problems.push(
          `${at([...path, "token"])} ${name}.token must be a secret reference (op://vault/item/field or env:VAR), never the token itself; put the token in 1Password (or an environment variable) and reference it`,
        );
      const scope = t.scope ?? "read";
      if (!MCP_SCOPES.includes(scope as McpScope))
        problems.push(
          `${at([...path, "scope"])} ${name}.scope must be one of ${MCP_SCOPES.join(", ")}, got ${JSON.stringify(t.scope)}`,
        );
      const pipelines = t.pipelines ?? null;
      if (
        pipelines !== null &&
        (!Array.isArray(pipelines) || !pipelines.every((p) => typeof p === "string" && /^[a-z0-9][a-z0-9-]*$/.test(p)))
      )
        problems.push(`${at([...path, "pipelines"])} ${name}.pipelines must be a list of pipeline names`);
      if (problems.length === before)
        out.push({
          name: t.name as string,
          token: t.token as string,
          scope: scope as McpScope,
          pipelines: pipelines === null ? null : [...(pipelines as string[])],
        });
    });
    return { tokens: out };
  }

  function readFields(
    map: Record<string, unknown>,
    path: string[],
    fields: Record<string, Field>,
    into: Record<string, unknown>,
    nested: string[] = [],
  ) {
    for (const [key, value] of Object.entries(map)) {
      const name = [...path, key].join(".");
      const where = at([...path, key]);
      if (nested.includes(key)) continue;
      const field = fields[key];
      if (!field) {
        const known = [...Object.keys(fields), ...nested].join(", ");
        problems.push(`${at([...path, key], true)} unknown key '${name}' (known: ${known})`);
        continue;
      }
      if (value === null) continue;
      const bad = (expected: string) => problems.push(`${where} ${name} ${expected}, got ${JSON.stringify(value)}`);
      switch (field.kind) {
        case "duration": {
          if (typeof value !== "string") {
            bad("must be a duration such as 500ms, 2s, 5m, 1h");
            break;
          }
          let ms: number;
          try {
            ms = parseDuration(value);
          } catch {
            bad("must be a duration such as 500ms, 2s, 5m, 1h");
            break;
          }
          if (ms < (field.min ?? 0)) bad(`must be at least ${formatDuration(field.min ?? 0)}`);
          else into[key] = ms;
          break;
        }
        case "boolean":
          if (typeof value !== "boolean") bad("must be true or false");
          else into[key] = value;
          break;
        case "port":
          if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 65535)
            bad("must be a port 0–65535 (0 picks a free one)");
          else into[key] = value;
          break;
        case "count":
          if (!Number.isInteger(value) || (value as number) < 0) bad("must be a whole number ≥ 0");
          else into[key] = value;
          break;
        case "timezone":
          if (typeof value !== "string" || !isTimeZone(value))
            bad("must be an IANA time zone such as Europe/Stockholm or UTC");
          else into[key] = value;
          break;
        case "path":
          if (typeof value !== "string" || !isAbsolute(value)) bad("must be an absolute path such as /home/me/pipes");
          else into[key] = value;
          break;
        case "names":
          if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v)))
            bad("must be a list of environment variable names");
          else into[key] = [...value];
          break;
      }
    }
  }
}
