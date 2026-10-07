// The agent provider contract (docs/spec.md §3.4, D36, D67). A provider turns a rendered prompt into structured output and
// reports the tokens it used. The runner validates the output, accounts the cost and applies the budget (§3.11).

export interface AgentRequest {
  /** Empty for a CLI agent without `with.model`: the CLI's own default (D67). */
  model: string;
  prompt: string;
  /** The node's JSON Schema (`with.schema`, loaded). The provider asks for output matching it; the runner checks it. */
  schema: Record<string, unknown>;
  max_tokens: number;
  /** Aborted when the node's `timeout` passes. */
  signal: AbortSignal;
  /** CLI agents: where the CLI runs (`with.cwd`, resolved); a fresh empty folder when not set (D67). */
  cwd?: string;
  /** CLI agents: `with.allow_tools`, the CLI may use its tools without asking. */
  allow_tools?: boolean;
}

export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  /** USD, when the provider reports what the call cost (Claude Code, pi, opencode); else it's priced from tokens. */
  cost_usd?: number;
}

export interface AgentResult extends AgentUsage {
  output: unknown;
}

export interface AgentProvider {
  complete(req: AgentRequest): Promise<AgentResult>;
}

/** A failed call. `usage` is set when the provider still billed tokens (e.g. the answer was cut off by max_tokens). */
export class AgentCallError extends Error {
  constructor(
    message: string,
    readonly usage?: AgentUsage,
  ) {
    super(message);
    this.name = "AgentCallError";
  }
}
