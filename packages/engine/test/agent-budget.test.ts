// The engine-wide agent budget with real runner processes (docs/spec.md §3.11, §7.3, D58), found through their
// registry entries, logging to files. Runners use the real `claude` provider against a mock Messages API served by this
// test (no network beyond loopback, no key, no cost): each call reports 400 + 100 tokens, $0.0009 at the Haiku price.
// - two pipelines of one home, each far under its own cap, share `engine.agent_budget.per_day`: once the total reaches
//   it, the next call is refused (`budget` pause, cap `engine`), also while the other runner lies dead after a SIGKILL;
// - SIGKILL loses no recorded spend and counts none twice: after restarts, the total is still one row per paid call;
// - the engine's `GET /api/agent-budget` reports the same total, per pipeline, against the cap.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, homeAgentBudget } from "@pipo/runner";
import { Supervisor } from "../src";
import { isAlive, query, sandbox, spawnRunner, testConfig, waitFor } from "./helpers";

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
const clients: ControlClient[] = [];
const engines: Supervisor[] = [];
const pids: number[] = [];
const requests: string[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const body = (await req.json()) as { model: string; messages: { content: string }[] };
    requests.push(body.messages[0]?.content ?? "");
    return Response.json({
      type: "message",
      model: body.model,
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t", name: "pipo_output", input: { label: "ok" } }],
      usage: { input_tokens: 400, output_tokens: 100 },
    });
  },
});
afterAll(async () => {
  for (const c of clients) c.close();
  for (const e of engines) await Promise.race([e.shutdown({ now: true }), Bun.sleep(10_000)]);
  for (const p of spawned) p.kill("SIGKILL");
  for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  server.stop(true);
  box.cleanup();
});

mkdirSync(box.home, { recursive: true });
writeFileSync(
  join(box.home, "config.yaml"),
  `engine:\n  timezone: UTC\n  agent_budget: { per_day: 0.0025 }\nagents:\n  claude_api:\n    base_url: http://127.0.0.1:${server.port}\n    api_key: env:PIPO_TEST_MOCK_KEY\n`,
);
box.write(
  "label.schema.json",
  JSON.stringify({ type: "object", properties: { label: { type: "string" } }, required: ["label"] }),
);
const file = (name: string) =>
  box.write(
    `${name}.pipo`,
    `pipo: 1
name: ${name}
agent_budget: { per_day: 0.5 }
input: { via: push }
nodes:
  classify:
    from: input
    agent: claude_api
    with: { model: claude-haiku-4-5, prompt: "${name} \${json(data)}", schema: ./label.schema.json }
output: { from: classify, to: file, with: { path: ./${name}.jsonl, format: jsonl } }
`,
  );

async function start(name: string) {
  const r = await spawnRunner(box.root, spawned, box.home, name, file(name), 15_000, { PIPO_TEST_MOCK_KEY: "unused" });
  pids.push(r.proc.pid);
  const client = await ControlClient.forPipeline(box.home, name);
  clients.push(client);
  return { ...r, client, push: async (n: number) => (await client.request("push", { data: { n } })).packet_id };
}

async function kill(r: Awaited<ReturnType<typeof start>>) {
  r.client.close();
  r.proc.kill("SIGKILL");
  await r.proc.exited;
}

const delivered = (name: string) => {
  const path = join(box.root, `${name}.jsonl`);
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length : 0;
};
const rows = (name: string) =>
  query(join(box.home, "pipelines", name, "journal.db"), "SELECT cost_usd FROM agent_spend")?.length ?? 0;
const lastPause = (name: string) => {
  const r = query(
    join(box.home, "pipelines", name, "journal.db"),
    "SELECT detail FROM events WHERE type = 'pipeline.paused' ORDER BY seq DESC LIMIT 1",
  );
  return r?.[0] ? JSON.parse(r[0].detail) : null;
};
const pausedOnBudget = async (r: Awaited<ReturnType<typeof start>>) =>
  (await r.client.request("status")).paused_reason === "budget";

test("two runners share engine.agent_budget.per_day across SIGKILLs; the engine reports the same total", async () => {
  // 1. a spends $0.0018 of the home's $0.0025; b's first call still fits ($0.0027 after it).
  const a = await start("a");
  const b = await start("b");
  await a.push(1);
  await a.push(2);
  await waitFor(() => delivered("a") === 2, 15_000, "a's two deliveries");
  await b.push(1);
  await waitFor(() => delivered("b") === 1, 15_000, "b's delivery");
  expect(requests).toHaveLength(3);

  // 2. a dies with SIGKILL (its journal possibly mid-WAL). b's next call reads a's spend from that journal: refused.
  await kill(a);
  await b.push(2);
  await waitFor(() => pausedOnBudget(b), 15_000, "b paused by the engine cap");
  expect(lastPause("b")).toMatchObject({
    reason: "budget",
    cap: "engine",
    per_day: 0.0025,
    pipeline_spent_usd: 0.0009,
  });
  expect(lastPause("b").spent_usd).toBeCloseTo(0.0027, 9);
  expect(requests).toHaveLength(3);
  const status = await b.client.request("status");
  expect(status.stats.agent_spend_today).toBeCloseTo(0.0009, 9);

  // 3. a comes back: nothing lost or doubled, and its own next call is refused by the same total.
  const a2 = await start("a");
  const total = homeAgentBudget(box.home);
  expect(total).toMatchObject({ per_day: 0.0025, timezone: "UTC" });
  expect(total.spent_usd).toBeCloseTo(0.0027, 9);
  expect(total.pipelines.a).toBeCloseTo(0.0018, 9);
  expect(total.pipelines.b).toBeCloseTo(0.0009, 9);
  await a2.push(3);
  await waitFor(() => pausedOnBudget(a2), 15_000, "a paused by the engine cap after its restart");
  expect(lastPause("a")).toMatchObject({ cap: "engine", pipeline_spent_usd: 0.0018 });

  // 4. b, killed while paused, comes back paused on the same cap with the same spend (D32).
  await kill(b);
  const b2 = await start("b");
  expect(await pausedOnBudget(b2)).toBe(true);
  expect(lastPause("b")).toMatchObject({ cap: "engine", restored: true });
  expect(requests).toHaveLength(3);
  expect(rows("a") + rows("b")).toBe(3);
  expect(homeAgentBudget(box.home).spent_usd).toBeCloseTo(0.0027, 9);

  // 5. An engine adopts both and reports the same sum over REST.
  const engine = await Supervisor.open({ home: box.home, config: { ...testConfig(), listen: 0 }, log: () => {} });
  engines.push(engine);
  const res = await fetch(`${engine.gateway?.url}/api/agent-budget`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body).toMatchObject({ per_day: 0.0025, timezone: "UTC" });
  expect(body.spent_usd).toBeCloseTo(0.0027, 9);
  expect(Object.keys(body.pipelines).sort()).toEqual(["a", "b"]);
  expect(Date.parse(body.resets_at) - Date.parse(body.window_start)).toBe(86_400_000);
}, 120_000);
