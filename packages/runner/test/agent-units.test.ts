// The agent pieces that stay TypeScript (docs/spec.md §3.4, §3.11, D36, D37, D58): the `agents:` and `engine:` config
// keys as `pipo compile`, the engine and `pipo run` read them, and the engine budget day that `homeAgentBudget` /
// `engineSpend` report. The providers and budgets themselves run in the Rust runner: claude.rs, cli.rs, window.rs and
// budget.rs have their unit tests, and agent.test.ts, cli-agents.test.ts and engine-budget.test.ts run them end to end.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentsConfig, priceFor } from "@pipo/spec";
import { parseConfig } from "../../engine/src/config";
import { engineSpend, readAgentSettings } from "../src";
import { engineWindow } from "../src/agents";
import { sandbox } from "./helpers";

describe("engine budget days", () => {
  test("a calendar day from midnight in engine.timezone", () => {
    expect(engineWindow(Date.UTC(2026, 9, 3, 12), "UTC")).toEqual({
      start: Date.UTC(2026, 9, 3),
      end: Date.UTC(2026, 9, 4),
    });
    // Stockholm is UTC+2 in October: its midnight is 22:00 UTC the day before.
    expect(engineWindow(Date.UTC(2026, 9, 3, 12), "Europe/Stockholm")).toEqual({
      start: Date.UTC(2026, 9, 2, 22),
      end: Date.UTC(2026, 9, 3, 22),
    });
    // The day DST starts (29 March 2026) is 23 hours long there.
    expect(engineWindow(Date.UTC(2026, 2, 29, 12), "Europe/Stockholm")).toEqual({
      start: Date.UTC(2026, 2, 28, 23),
      end: Date.UTC(2026, 2, 29, 22),
    });
  });

  test("a home without journals has spent nothing", () => {
    const box = sandbox();
    try {
      mkdirSync(join(box.home, "pipelines", "empty"), { recursive: true });
      expect(
        engineSpend(box.home, { per_day: 2, timezone: "Europe/Stockholm", now: Date.UTC(2026, 9, 3, 12) }),
      ).toEqual({
        per_day: 2,
        spent_usd: 0,
        window_start: "2026-10-02T22:00:00.000Z",
        resets_at: "2026-10-03T22:00:00.000Z",
        timezone: "Europe/Stockholm",
        pipelines: {},
      });
    } finally {
      box.cleanup();
    }
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

  test("readAgentSettings reads the same keys from <home>/config.yaml and reports problems", () => {
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
});
