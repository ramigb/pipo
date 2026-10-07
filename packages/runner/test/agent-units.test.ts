// The claude_api provider against an injected fetch (no network), budget windows, and the `agents:` config keys
// (docs/spec.md §3.4, §3.11, D36, D37).
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentsConfig, priceFor } from "@pipo/spec";
import { parseConfig } from "../../engine/src/config";
import { AgentCallError, budgetWindow, ClaudeProvider, readAgentSettings } from "../src/agents";
import { gaps } from "../src/support";
import { sandbox } from "./helpers";

function fakeFetch(status: number, body: unknown) {
  const seen: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, seen };
}

const req = (schema: Record<string, unknown>) => ({
  model: "claude-sonnet-5-5",
  prompt: "classify",
  schema,
  max_tokens: 100,
  signal: new AbortController().signal,
});

describe("claude_api provider", () => {
  test("forces one tool call with the node's schema and reads its input and usage", async () => {
    const { f, seen } = fakeFetch(200, {
      content: [{ type: "tool_use", name: "pipo_output", input: { label: "urgent" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 5 },
    });
    const p = new ClaudeProvider({ apiKey: "test-key-not-real", baseUrl: "http://mock.invalid", fetch: f });
    const out = await p.complete(req({ $schema: "x", type: "object", properties: { label: { type: "string" } } }));
    expect(out).toEqual({ output: { label: "urgent" }, input_tokens: 125, output_tokens: 30 });
    expect(seen[0]?.url).toBe("http://mock.invalid/v1/messages");
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key-not-real");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(seen[0]?.init.body));
    expect(body).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "classify" }],
      tool_choice: { type: "tool", name: "pipo_output" },
    });
    expect(body.tools[0].input_schema).toEqual({ type: "object", properties: { label: { type: "string" } } });
  });

  test("a non-object schema is wrapped as { value } and unwrapped", async () => {
    const { f, seen } = fakeFetch(200, {
      content: [{ type: "tool_use", name: "pipo_output", input: { value: "spam" } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const p = new ClaudeProvider({ apiKey: "k", baseUrl: "http://mock.invalid", fetch: f });
    expect((await p.complete(req({ type: "string" }))).output).toBe("spam");
    expect(JSON.parse(String(seen[0]?.init.body)).tools[0].input_schema.required).toEqual(["value"]);
  });

  test("API errors and cut-off answers are errors; a cut-off still reports the tokens it billed", async () => {
    const bad = new ClaudeProvider({
      apiKey: "k",
      baseUrl: "http://mock.invalid",
      fetch: fakeFetch(529, { error: { message: "Overloaded" } }).f,
    });
    await expect(bad.complete(req({ type: "object" }))).rejects.toThrow("Claude API answered 529: Overloaded");
    const cut = new ClaudeProvider({
      apiKey: "k",
      baseUrl: "http://mock.invalid",
      fetch: fakeFetch(200, { content: [], stop_reason: "max_tokens", usage: { input_tokens: 9, output_tokens: 100 } })
        .f,
    });
    const e = (await cut.complete(req({ type: "object" })).catch((x) => x)) as AgentCallError;
    expect(e).toBeInstanceOf(AgentCallError);
    expect(e.message).toContain("raise with.max_tokens");
    expect(e.usage).toEqual({ input_tokens: 9, output_tokens: 100 });
  });
});

describe("budget windows", () => {
  test("a calendar day from reset_at, in the configured zone", () => {
    expect(budgetWindow(Date.UTC(2026, 9, 3, 12), "UTC")).toEqual({
      start: Date.UTC(2026, 9, 3),
      end: Date.UTC(2026, 9, 4),
    });
    expect(budgetWindow(Date.UTC(2026, 9, 3, 5), "UTC", "06:00")).toEqual({
      start: Date.UTC(2026, 9, 2, 6),
      end: Date.UTC(2026, 9, 3, 6),
    });
    // Stockholm is UTC+2 in October: its midnight is 22:00 UTC the day before.
    expect(budgetWindow(Date.UTC(2026, 9, 3, 12), "Europe/Stockholm")).toEqual({
      start: Date.UTC(2026, 9, 2, 22),
      end: Date.UTC(2026, 9, 3, 22),
    });
    // The day DST starts (29 March 2026) is 23 hours long there.
    const dst = budgetWindow(Date.UTC(2026, 2, 29, 12), "Europe/Stockholm");
    expect(dst).toEqual({ start: Date.UTC(2026, 2, 28, 23), end: Date.UTC(2026, 2, 29, 22) });
  });
});

describe("agent settings", () => {
  test("prices: an exact model id, else the longest family key it contains", () => {
    const { value } = parseAgentsConfig({ claude_api: { pricing: { "claude-sonnet-5-5": { input: 4, output: 20 } } } });
    const table = value.claude_api?.pricing ?? {};
    expect(priceFor(table, "claude-sonnet-5-5")).toEqual({ input: 4, output: 20 });
    expect(priceFor(table, "claude-sonnet-4-5")).toEqual({ input: 3, output: 15 });
    expect(priceFor(table, "claude-haiku-4-5")).toEqual({ input: 1, output: 5 });
    expect(priceFor(table, "gpt-x")).toBeNull();
  });

  test("the engine config accepts agents and engine.timezone and refuses bad values", () => {
    const ok = parseConfig(
      "engine:\n  timezone: Europe/Stockholm\n  agent_budget: { per_day: 20 }\nagents:\n  claude_api:\n    api_key: op://vault/anthropic/key\n    pricing: { my-model: { input: 1, output: 2 } }\n",
    );
    expect(ok.timezone).toBe("Europe/Stockholm");
    expect(ok.agent_budget).toEqual({ per_day: 20 });
    expect(ok.agents.claude_api?.api_key).toBe("op://vault/anthropic/key");
    expect(ok.agents.claude_api?.pricing["my-model"]).toEqual({ input: 1, output: 2 });
    expect(ok.agents.claude_api?.pricing.sonnet).toEqual({ input: 3, output: 15 });
    const bad = (() => {
      try {
        parseConfig(
          "engine:\n  timezone: Mars/Base\nagents:\n  claude_api:\n    api_key: sk-literal\n    pricing: { m: 3 }\n  gpt: {}\n",
        );
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(bad).toContain("config.yaml:2:13 engine.timezone must be an IANA time zone");
    expect(bad).toContain("agents.claude_api.api_key must be a secret reference");
    expect(bad).toContain("agents.claude_api.pricing.m must be { input");
    expect(bad).toContain("unknown agent provider 'gpt'");
  });

  test("CLI agents take a command (and prices), not an API key (D67)", () => {
    const { value, problems } = parseAgentsConfig({
      codex: { command: "/opt/codex/bin/codex", pricing: { "gpt-5.5": { input: 1, output: 8 } } },
      pi: { api_key: "env:X", base_url: "https://x" },
      opencode: { command: "" },
    });
    expect(value.codex).toEqual({ command: "/opt/codex/bin/codex", pricing: { "gpt-5.5": { input: 1, output: 8 } } });
    expect(value.claude_code).toEqual({ command: "claude", pricing: {} });
    expect(problems.map((p) => p.message)).toEqual([
      "unknown key 'agents.pi.api_key' (known: pricing, command)",
      "unknown key 'agents.pi.base_url' (known: pricing, command)",
      'agents.opencode.command must be the CLI\'s executable, a name on PATH or a path, got ""',
    ]);
    expect(parseAgentsConfig({ claude_api: { command: "claude" } }).problems[0]?.message).toBe(
      "unknown key 'agents.claude_api.command' (known: pricing, api_key, base_url)",
    );
  });

  test("the runner reads the same keys from <home>/config.yaml and reports problems", () => {
    const box = sandbox();
    try {
      expect(readAgentSettings(box.home).problems).toEqual([]);
      mkdirSync(box.home, { recursive: true });
      writeFileSync(join(box.home, "config.yaml"), "engine:\n  timezone: UTC\n  agent_budget: { per_day: 1 }\n");
      const read = readAgentSettings(box.home);
      expect(read.settings).toMatchObject({ timezone: "UTC", engineBudget: { per_day: 1 } });
      writeFileSync(join(box.home, "config.yaml"), "engine:\n  agent_budget: { per_day: -1, per_week: 3 }\n");
      expect(readAgentSettings(box.home).problems[0]).toContain(
        "config.yaml:2:17 engine.agent_budget must be { per_day: <USD> } (a number ≥ 0)",
      );
      writeFileSync(join(box.home, "config.yaml"), "agents:\n  claude_api:\n    api_key: plain\n");
      expect(readAgentSettings(box.home).problems[0]).toContain("config.yaml:3:14 agents.claude_api.api_key must be");
    } finally {
      box.cleanup();
    }
  });

  test("agent nodes, agent_budget and the engine-wide budget are no longer gaps", () => {
    const p = {
      pipo: 1,
      name: "a",
      agent_budget: { per_day: 1 },
      input: { via: "push" },
      nodes: { c: { from: "input", agent: "claude_api", with: { model: "m", prompt: "p", schema: "./s.json" } } },
      output: { from: "c", to: "stdout" },
    } as any;
    expect(gaps(p)).toEqual([]);
  });
});
