// Which agent providers can run on this machine, and with which models (docs/spec.md §8, D67): what the dashboard's
// builder shows next to each agent. A CLI agent is ready when it is installed and logged in (or set up), the same
// check a runner makes at start; `claude_api` is ready when its API key reference can be resolved here, as far as
// that can be told without resolving it (`env:` is looked up, `op://` is assumed fine).
import { AGENTS, type AgentsConfig } from "@pipo/spec";
import { CLAUDE_MODELS, cliModels, cliReadiness } from "./cli";

export interface AgentProbe {
  label: string;
  runs: "api" | "cli";
  ready: boolean;
  /** The CLI's `--version`. */
  version?: string;
  /** Why it can't run here, and what to do about it. */
  reason?: string;
  hint?: string;
  /** Models to offer for `with.model`; a free-text field still takes any. */
  models: string[];
}

export async function probeAgents(
  config: AgentsConfig,
  env: Record<string, string | undefined> = process.env,
): Promise<Record<string, AgentProbe>> {
  const entries = await Promise.all(
    Object.entries(AGENTS).map(async ([name, m]): Promise<[string, AgentProbe]> => {
      const base = { label: m.label, runs: m.runs };
      if (m.runs === "api") {
        const ref = config[name]?.api_key ?? "";
        const variable = ref.startsWith("env:") ? ref.slice(4) : null;
        const models = CLAUDE_MODELS.filter((x) => x.startsWith("claude-"));
        if (variable && !env[variable]) {
          return [
            name,
            {
              ...base,
              ready: false,
              reason: `${variable} isn't set where the engine runs, so ${m.label} has no API key`,
              hint: `set ${variable} before starting the engine, or point agents.${name}.api_key in config.yaml at a secret reference such as op://vault/item/field (1Password)`,
              models,
            },
          ];
        }
        return [name, { ...base, ready: true, models }];
      }
      const command = config[name]?.command ?? (m.command as string);
      const ready = await cliReadiness(name, command);
      // Listing models is skipped when the CLI isn't even installed.
      const models = ready.ready || ready.version ? await cliModels(name, command) : [];
      return [name, { ...base, ...ready, models }];
    }),
  );
  return Object.fromEntries(entries);
}
