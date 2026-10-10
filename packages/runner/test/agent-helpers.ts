// Helpers for the agent, budget and escalation tests (docs/spec.md §3.4, §3.11, §9) against the Rust runner: a mock
// Claude Messages API served by the test (`agents.claude_api.base_url` points at it, so no test reaches the network),
// the home's config.yaml, and journal reads of pipeline-level events.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RustRunner } from "./rust";

/** The env var holding the mock's API key; a runner resolves `env:` references at start. */
export const KEY_ENV = { PIPO_TEST_ANTHROPIC_KEY: "test-key-not-real" };

/** Prices that make the arithmetic easy: 1,000 input + 500 output tokens = $0.15. */
export const PRICING = "{ mock-model: { input: 100, output: 100 } }";

export interface ClaudeCall {
  model: string;
  max_tokens: number;
  prompt: string;
  schema: Record<string, unknown>;
  key: string | null;
}

export interface Reply {
  status?: number;
  body: unknown;
  /** Never answer (until the client gives up). */
  hang?: boolean;
}

/** A Messages API answer: one `pipo_output` tool call with `output`, billed `input` + `output` tokens. */
export const toolUse = (output: unknown, input = 1000, outputTokens = 500): Reply => ({
  body: {
    content: [{ type: "tool_use", name: "pipo_output", input: output }],
    stop_reason: "tool_use",
    usage: { input_tokens: input, output_tokens: outputTokens },
  },
});

/** A local Claude API: `reply` answers each call (`n` counts from 1); every call is recorded, aborted ones too. */
export function mockClaude(
  reply: (call: ClaudeCall, n: number) => Reply | Promise<Reply> = () => toolUse({ label: "ok" }),
) {
  const calls: ClaudeCall[] = [];
  const state = { reply, aborted: 0, answered: 0 };
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: async (req) => {
      const body = (await req.json()) as Record<string, any>;
      const call: ClaudeCall = {
        model: body.model,
        max_tokens: body.max_tokens,
        prompt: body.messages?.[0]?.content,
        schema: body.tools?.[0]?.input_schema,
        key: req.headers.get("x-api-key"),
      };
      calls.push(call);
      const r = await state.reply(call, calls.length);
      if (r.hang) {
        await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve()));
        state.aborted++;
        return new Response("aborted", { status: 499 });
      }
      state.answered++;
      return Response.json(r.body, { status: r.status ?? 200 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    state,
    stop: () => server.stop(true),
  };
}

/** `<home>/config.yaml` with the mock as `claude_api` (UTC budget days); `engine` and `agents` add lines. */
export function writeConfig(home: string, o: { url?: string; engine?: string; agents?: string } = {}) {
  mkdirSync(home, { recursive: true });
  const api = o.url
    ? `  claude_api:\n    api_key: env:PIPO_TEST_ANTHROPIC_KEY\n    base_url: ${o.url}\n    pricing: ${PRICING}\n`
    : "";
  writeFileSync(
    join(home, "config.yaml"),
    `engine:\n  timezone: UTC\n${o.engine ?? ""}agents:\n${api}${o.agents ?? ""}${api || o.agents ? "" : "  {}\n"}`,
  );
}

export const LABEL_SCHEMA = JSON.stringify({
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: { label: { type: "string" } },
  required: ["label"],
  additionalProperties: false,
});

/** Details of the pipeline-level events (no packet) of a type, oldest first. */
export function pipelineEvents(r: RustRunner, type: string): any[] {
  return r
    .query<{ detail: string | null }>(
      "SELECT detail FROM events WHERE packet_id IS NULL AND type = ? ORDER BY seq",
      type,
    )
    .map((e) => (e.detail === null ? null : JSON.parse(e.detail)));
}

/** Event types of a packet, oldest first. */
export const types = (r: RustRunner, id: string) => r.events(id).map((e) => e.type);

/** Tokens a packet's agent calls used, from the `agent_spend` table. */
export function packetTokens(r: RustRunner, root: string): number {
  return (
    r.query<{ n: number }>(
      "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM agent_spend WHERE root = ?",
      root,
    )[0]?.n ?? 0
  );
}

/** The next UTC "HH:MM" at least `marginMs` away, and its time (ms): a budget day that ends soon (`reset_at`). */
export function resetSoon(marginMs: number): { at: string; ms: number } {
  const minute = 60_000;
  let ms = Math.ceil((Date.now() + marginMs) / minute) * minute;
  if (ms - Date.now() < marginMs) ms += minute;
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return { at: `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`, ms };
}

/** Midnight UTC of the day containing `ms`, and the next one (ISO): the engine budget day with engine.timezone UTC. */
export function utcDay(ms = Date.now()): { start: string; end: string } {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { start: new Date(start).toISOString(), end: new Date(start + 86_400_000).toISOString() };
}
