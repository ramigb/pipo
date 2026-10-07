// `pipo status` shows today's agent spend (docs/spec.md §3.11, D58): `--json` has `agent_budget` (the home's total per
// pipeline vs `engine.agent_budget.per_day`) and each runner's `stats.agent_spend_today`; the human view adds a line
// under the table, and `pipo status <name>` the pipeline's own spend. Runners run in-process with a mock provider.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runner } from "@pipo/runner";
import type { AgentProvider } from "../../runner/src/agents";
import { sandbox, settled } from "../../runner/test/helpers";
import { main } from "../src/cli";
import { renderAgentBudget } from "../src/status";

const sb = sandbox();
const runners: Runner[] = [];
afterAll(async () => {
  for (const r of runners) await r.stop().catch(() => {});
  sb.cleanup();
});

type Result = { code: number; stdout: string; stderr: string };
async function pipo(...args: string[]): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await main(args);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}
const H = ["--no-engine", "--home", sb.home];

const provider: AgentProvider = {
  complete: async () => ({ output: { label: "ok" }, input_tokens: 1000, output_tokens: 500 }),
};

async function open(name: string) {
  const file = sb.write(
    `${name}.pipo`,
    `pipo: 1
name: ${name}
agent_budget: { per_day: 5 }
input: { via: push }
nodes:
  classify:
    from: input
    agent: claude_api
    with: { model: mock-model, prompt: "\${json(data)}", schema: ./label.schema.json }
output: { from: classify, to: file, with: { path: ./${name}.jsonl, format: jsonl } }
`,
  );
  const runner = await Runner.open({
    file,
    home: sb.home,
    log: () => {},
    agents: {
      providers: { claude_api: provider },
      pricing: { claude_api: { "mock-model": { input: 100, output: 100 } } },
    },
  });
  await runner.start();
  runners.push(runner);
  return runner;
}

test("pipo status --json and the human view show today's agent spend against engine.agent_budget", async () => {
  sb.write(
    "label.schema.json",
    JSON.stringify({ type: "object", properties: { label: { type: "string" } }, required: ["label"] }),
  );
  mkdirSync(sb.home, { recursive: true });
  writeFileSync(join(sb.home, "config.yaml"), "engine:\n  timezone: UTC\n  agent_budget: { per_day: 2 }\n");
  const a = await open("spend-a");
  const b = await open("spend-b");
  const push = async (r: Runner, n: number) => {
    const got = await r.intake({ n }, { trigger: "push", source: "t" });
    if (got.status !== "accepted") throw new Error(JSON.stringify(got));
    await settled(r, got.packet_id);
  };
  await push(a, 1);
  await push(a, 2);
  await push(b, 1);

  const j = JSON.parse((await pipo("status", "--json", ...H)).stdout);
  expect(j.agent_budget).toMatchObject({
    per_day: 2,
    spent_usd: 0.45,
    timezone: "UTC",
    pipelines: { "spend-a": 0.3, "spend-b": 0.15 },
  });
  expect(j.agent_budget.window_start).toMatch(/T00:00:00\.000Z$/);
  expect(Object.fromEntries(j.pipelines.map((p: any) => [p.pipeline, p.stats.agent_spend_today]))).toEqual({
    "spend-a": 0.3,
    "spend-b": 0.15,
  });

  const human = await pipo("status", ...H);
  expect(human.code).toBe(0);
  expect(human.stdout).toMatch(
    /^agent spend today: \$0\.4500 of \$2\.00 engine\.agent_budget\.per_day, resets \d{4}-/m,
  );
  expect(human.stdout).toContain("  spend-a $0.3000, spend-b $0.1500");
  expect((await pipo("status", "spend-a", ...H)).stdout).toMatch(/^agent spend today: \$0\.3000$/m);
}, 30_000);

test("the spend line: reached, no cap, and nothing at all", () => {
  const base = { window_start: "2026-10-04T00:00:00.000Z", resets_at: "2026-10-05T00:00:00.000Z", timezone: "UTC" };
  expect(renderAgentBudget({ ...base, per_day: 1, spent_usd: 1.2, pipelines: { a: 1.2 } })).toBe(
    "agent spend today: $1.20 of $1.00 engine.agent_budget.per_day, reached, resets 2026-10-05T00:00:00.000Z\n  a $1.20",
  );
  expect(renderAgentBudget({ ...base, per_day: null, spent_usd: 0.01, pipelines: { a: 0.01 } })).toBe(
    "agent spend today: $0.0100 (no engine.agent_budget), resets 2026-10-05T00:00:00.000Z\n  a $0.0100",
  );
  expect(renderAgentBudget({ ...base, per_day: null, spent_usd: 0, pipelines: {} })).toBe("");
});
