// Agent provider settings from the engine config's `agents:` map (docs/spec.md §3.11, D36, D67): the price table
// (`agents.<provider>.pricing`, USD per million tokens), and the API key reference and base URL of an API provider or
// the executable of a CLI one. Shared by the engine, which validates `config.yaml`, and the runner, which reads the
// same file when it has agent nodes.
import { AGENTS } from "./manifests";

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
}

/** Model id, or a part of one (a family such as `sonnet`), → price. The longest key the model id contains wins. */
export type PricingTable = Record<string, ModelPrice>;

export interface AgentProviderConfig {
  pricing: PricingTable;
  /** API providers: a secret reference (`op://…` or `env:…`), never the key itself (§3.7). */
  api_key?: string;
  /** API providers: the API's base URL. */
  base_url?: string;
  /** CLI providers: the executable, a name looked up on PATH or a path (D67). */
  command?: string;
}

export type AgentsConfig = Record<string, AgentProviderConfig>;

/** Built-in defaults, so `pipo run` works without a config file. `agents.<provider>.pricing` adds or overrides keys. */
export const AGENT_DEFAULTS: AgentsConfig = Object.fromEntries(
  Object.entries(AGENTS).map(([name, m]): [string, AgentProviderConfig] => [
    name,
    m.runs === "cli"
      ? { pricing: {}, command: m.command as string }
      : name === "claude_api"
        ? {
            pricing: {
              opus: { input: 5, output: 25 },
              sonnet: { input: 3, output: 15 },
              haiku: { input: 1, output: 5 },
            },
            api_key: "env:ANTHROPIC_API_KEY",
            base_url: "https://api.anthropic.com",
          }
        : { pricing: {} },
  ]),
);

/** The price for `model`: an exact key, else the longest key contained in the model id; null when none matches. */
export function priceFor(table: PricingTable, model: string): ModelPrice | null {
  if (table[model]) return table[model];
  let best: string | undefined;
  for (const key of Object.keys(table)) if (model.includes(key) && (!best || key.length > best.length)) best = key;
  return best ? (table[best] as ModelPrice) : null;
}

/** USD for one call. */
export function costOf(price: ModelPrice, inputTokens: number, outputTokens: number): number {
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** True when `tz` is an IANA time zone name this runtime knows. */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface ConfigProblem {
  path: string[];
  message: string;
  /** Point at the key rather than its value. */
  key?: boolean;
}

const API_KEYS = ["pricing", "api_key", "base_url"];
const CLI_KEYS = ["pricing", "command"];
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Validate an `agents:` map and merge it over the defaults. Problems carry the config path they belong to. */
export function parseAgentsConfig(raw: unknown): { value: AgentsConfig; problems: ConfigProblem[] } {
  const value = structuredClone(AGENT_DEFAULTS);
  const problems: ConfigProblem[] = [];
  if (raw === undefined || raw === null) return { value, problems };
  if (!isMap(raw)) {
    problems.push({ path: ["agents"], message: "'agents' must be a mapping of provider → settings" });
    return { value, problems };
  }
  for (const [provider, settings] of Object.entries(raw)) {
    const at = ["agents", provider];
    const into = value[provider];
    if (!into) {
      problems.push({
        path: at,
        key: true,
        message: `unknown agent provider '${provider}' (known: ${Object.keys(AGENT_DEFAULTS).join(", ")})`,
      });
      continue;
    }
    if (settings === null) continue;
    if (!isMap(settings)) {
      problems.push({ path: at, message: `agents.${provider} must be a mapping` });
      continue;
    }
    const known = AGENTS[provider]?.runs === "cli" ? CLI_KEYS : API_KEYS;
    for (const [key, v] of Object.entries(settings)) {
      const name = `agents.${provider}.${key}`;
      if (!known.includes(key)) {
        problems.push({
          path: [...at, key],
          key: true,
          message: `unknown key '${name}' (known: ${known.join(", ")})`,
        });
        continue;
      }
      if (v === null) continue;
      if (key === "api_key") {
        if (typeof v !== "string" || !/^(op:\/\/|env:)/.test(v))
          problems.push({
            path: [...at, key],
            message: `${name} must be a secret reference (op://… or env:…), never the key itself`,
          });
        else into.api_key = v;
      } else if (key === "base_url") {
        if (typeof v !== "string" || !/^https?:\/\/[^\s]+$/.test(v))
          problems.push({ path: [...at, key], message: `${name} must be an http(s) URL, got ${JSON.stringify(v)}` });
        else into.base_url = v.replace(/\/+$/, "");
      } else if (key === "command") {
        if (typeof v !== "string" || !v.trim())
          problems.push({
            path: [...at, key],
            message: `${name} must be the CLI's executable, a name on PATH or a path, got ${JSON.stringify(v)}`,
          });
        else into.command = v;
      } else if (!isMap(v)) {
        problems.push({ path: [...at, key], message: `${name} must map model ids to { input, output } USD per Mtok` });
      } else {
        for (const [model, price] of Object.entries(v)) {
          const ok =
            isMap(price) &&
            Object.keys(price).every((k) => k === "input" || k === "output") &&
            typeof price.input === "number" &&
            typeof price.output === "number" &&
            price.input >= 0 &&
            price.output >= 0;
          if (!ok)
            problems.push({
              path: [...at, key, model],
              message: `${name}.${model} must be { input: <USD per Mtok>, output: <USD per Mtok> }, got ${JSON.stringify(price)}`,
            });
          else into.pricing[model] = { input: price.input as number, output: price.output as number };
        }
      }
    }
  }
  return { value, problems };
}
