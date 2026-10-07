// `agent: claude_api` (docs/spec.md §3.4, D36): the Anthropic Messages API over fetch, no SDK. Structured output comes
// from one forced tool call whose input schema is the node's schema. Tests inject a provider or a `fetch`; nothing in
// the test suite reaches the network.
import { AgentCallError, type AgentProvider, type AgentRequest, type AgentResult } from "./types";

const TOOL = "pipo_output";
const API_VERSION = "2023-06-01";

export interface ClaudeOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
}

export class ClaudeProvider implements AgentProvider {
  constructor(private readonly opts: ClaudeOptions) {}

  async complete(req: AgentRequest): Promise<AgentResult> {
    // Tool input must be an object: any other schema is wrapped as `{ value }` and unwrapped again.
    const { $schema: _s, $id: _i, ...schema } = req.schema;
    const wrapped = schema.type !== "object";
    const input_schema = wrapped ? { type: "object", properties: { value: schema }, required: ["value"] } : schema;
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.opts.apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.max_tokens,
        messages: [{ role: "user", content: req.prompt }],
        tools: [{ name: TOOL, description: "Return your answer. Its input must match the schema.", input_schema }],
        tool_choice: { type: "tool", name: TOOL },
      }),
      signal: req.signal,
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {}
    if (!res.ok) {
      const why = body?.error?.message ?? (text.slice(0, 200) || res.statusText);
      throw new AgentCallError(`Claude API answered ${res.status}: ${why}`);
    }
    const u = body?.usage ?? {};
    const usage = {
      // Cache reads and writes are input tokens too; they are priced at the input rate (D36).
      input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      output_tokens: u.output_tokens ?? 0,
    };
    const block = Array.isArray(body?.content)
      ? body.content.find((b: any) => b?.type === "tool_use" && b.name === TOOL)
      : undefined;
    if (!block || body?.stop_reason === "max_tokens") {
      throw new AgentCallError(
        `Claude API returned no complete structured output (stop_reason: ${body?.stop_reason ?? "unknown"})${body?.stop_reason === "max_tokens" ? "; raise with.max_tokens" : ""}`,
        usage,
      );
    }
    return { output: wrapped ? block.input?.value : block.input, ...usage };
  }
}
