// What a runner prepares at start for its agent nodes (docs/spec.md §3.4, D36, D67): a provider per `agent:` value (an
// injected one, the API one with its key resolved from a secret reference, or a CLI one that was found installed and
// logged in) and the price table per provider. For an API provider, a model without a price refuses the start: an
// unpriced call would make the daily cap meaningless. CLI agents report their cost or tokens, priced when a price
// is known and counted as $0 otherwise.
import { AGENTS, type Node, type Pipeline, type PricingTable, priceFor } from "@pipo/spec";
import { defaultResolver, type Resolver } from "../secrets";
import { ClaudeProvider } from "./claude";
import { CliProvider, cliReadiness } from "./cli";
import type { AgentSettings } from "./settings";
import type { AgentProvider } from "./types";

export interface AgentOptions {
  /** Providers by name; replaces the real one (tests inject a mock, so nothing reaches the network). */
  providers?: Record<string, AgentProvider>;
  /** Extra prices by provider, merged over the config's (USD per million tokens). */
  pricing?: Record<string, PricingTable>;
  /** IANA time zone for budget days; overrides `engine.timezone`. */
  timezone?: string;
}

export interface AgentRuntime {
  providers: Map<string, AgentProvider>;
  pricing: Record<string, PricingTable>;
  /** Resolved API keys: redacted from everything the runner logs or journals. */
  hidden: string[];
}

/** Thrown with a message and a hint; the runner turns it into a StartError. */
export class AgentSetupError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

export async function prepareAgents(
  pipeline: Pipeline,
  settings: AgentSettings,
  opts: AgentOptions = {},
  resolver: Resolver = defaultResolver,
): Promise<AgentRuntime> {
  const nodes = Object.entries(pipeline.nodes ?? {}).filter(
    (e): e is [string, Node & { agent: string }] => typeof e[1].agent === "string",
  );
  const rt: AgentRuntime = { providers: new Map(), pricing: {}, hidden: [] };
  for (const [id, node] of nodes) {
    const name = node.agent;
    const manifest = AGENTS[name];
    const config = settings.agents[name];
    if (!manifest || !config)
      throw new AgentSetupError(
        `agent node '${id}': no provider '${name}'`,
        `use one of ${Object.keys(AGENTS).join(", ")}`,
      );
    rt.pricing[name] ??= { ...config.pricing, ...opts.pricing?.[name] };
    const model = node.with?.model;
    if (
      manifest.runs === "api" &&
      typeof model === "string" &&
      !model.includes("${") &&
      !priceFor(rt.pricing[name] as PricingTable, model)
    ) {
      throw new AgentSetupError(
        `agent node '${id}': no price for model '${model}', so its cost can't be counted against agent_budget`,
        `add agents.${name}.pricing.${model}: { input: <USD per Mtok>, output: <USD per Mtok> } to config.yaml in the Pipo home`,
      );
    }
    if (rt.providers.has(name)) continue;
    const injected = opts.providers?.[name];
    if (injected) {
      rt.providers.set(name, injected);
      continue;
    }
    if (manifest.runs === "cli") {
      const command = config.command ?? (manifest.command as string);
      const ready = await cliReadiness(name, command);
      if (!ready.ready) {
        throw new AgentSetupError(
          `agent node '${id}' uses ${manifest.label} (agent: ${name}), which can't run here: ${ready.reason}`,
          ready.hint ?? `make '${command}' work in a terminal, then start again`,
        );
      }
      rt.providers.set(name, new CliProvider(name, command));
      continue;
    }
    let apiKey: string;
    try {
      apiKey = await resolver(config.api_key as string);
    } catch (e) {
      throw new AgentSetupError(
        `agent provider '${name}' needs an API key (${config.api_key}): ${(e as Error).message}`,
        `set it there, or point agents.${name}.api_key in config.yaml at a secret reference such as op://vault/item/field (1Password)`,
      );
    }
    rt.hidden.push(apiKey);
    rt.providers.set(name, new ClaudeProvider({ apiKey, baseUrl: config.base_url as string }));
  }
  return rt;
}
