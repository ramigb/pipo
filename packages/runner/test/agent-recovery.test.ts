// Agent budgets across SIGKILL (docs/spec.md §3.11, §7.3, D32, D37), with real runner processes found through their
// registry entry and logging to files. `claude_api` is a mock served by the test; the budget day ends within a minute
// or so, through `agent_budget.reset_at` set to the next UTC minute (the runner has no clock to skew).
// - a `budget` pause survives a crash: the next run comes back paused with the same resume time and the day's spend,
//   holds every packet, resumes by itself when the day ends and delivers each packet exactly once;
// - a crash during a call: the call is made again on restart, the packet is delivered once, and only calls that
//   reported usage are counted.
import { afterAll, afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KEY_ENV, LABEL_SCHEMA, mockClaude, pipelineEvents, resetSoon, toolUse, writeConfig } from "./agent-helpers";
import { sandbox, waitFor } from "./helpers";
import { RustRunner } from "./rust";

setDefaultTimeout(150_000);

const box = sandbox();
box.write("label.schema.json", LABEL_SCHEMA);
let running: RustRunner[] = [];
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const r of running) if (r.proc.exitCode === null) await r.kill();
  for (const s of stops) await s();
  running = [];
  stops = [];
});
afterAll(() => box.cleanup());

const pipeline = (name: string, budget: string) => `pipo: 1
name: ${name}
agent_budget: ${budget}
input: { via: push }
nodes:
  classify:
    from: input
    agent: claude_api
    with: { model: mock-model, prompt: "\${json(data)}", schema: ./label.schema.json }
output:
  from: classify
  to: file
  with: { path: ./${name}.jsonl, format: jsonl }
`;

async function start(name: string) {
  const r = await RustRunner.start(box, join(box.root, `${name}.pipo`), name, { listen: null, env: KEY_ENV });
  running.push(r);
  return r;
}

const delivered = (name: string) => {
  const path = join(box.root, `${name}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).packet_id as string);
};

test("a budget pause survives SIGKILL, keeps the day's spend and resumes by itself when the day ends", async () => {
  const name = "budget-crash";
  const api = mockClaude();
  stops.push(api.stop);
  writeConfig(box.home, { url: api.url });
  // Enough time to spend the budget, crash and restart before the day ends.
  const reset = resetSoon(25_000);
  const resumeAt = new Date(reset.ms).toISOString();
  box.write(
    `${name}.pipo`,
    pipeline(name, `{ per_day: 0.3, per_packet: 100000, reset_at: "${reset.at}", warn_at: 50% }`),
  );

  // 1. Two calls spend $0.30; the third packet pauses the pipeline. One at a time: the cap is checked before each
  // call, so calls already in flight together can all go ahead.
  const first = await start(name);
  const ids: string[] = [];
  for (let n = 1; n <= 3; n++) {
    ids.push((await first.push({ n })).packet_id);
    if (n < 3) await first.settled(ids.at(-1) as string);
  }
  await waitFor(async () => (await first.status()).paused_reason === "budget", 10_000, "budget pause");
  const status = await first.status();
  expect(status.budget_resumes_at).toBe(resumeAt);
  expect(status.stats.agent_spend_today).toBe(0.3);
  // Accepted into the journal while paused (§2.2).
  ids.push((await first.push({ n: 4 })).packet_id);
  await waitFor(() => delivered(name).length === 2, 5000, "two lines");
  expect(delivered(name)).toEqual(ids.slice(0, 2));
  await first.kill();
  expect(Date.now()).toBeLessThan(reset.ms);

  // 2. Back paused, same resume time, same spend, nothing moves.
  const second = await start(name);
  const restored = await second.status();
  expect(restored).toMatchObject({ state: "paused", paused_reason: "budget" });
  expect(restored.budget_resumes_at).toBe(resumeAt);
  expect(restored.stats.agent_spend_today).toBe(0.3);
  expect(api.state.answered).toBe(2);
  expect(Date.now()).toBeLessThan(reset.ms);

  // 3. The new day: resumes on its own, delivers the held packets exactly once, on the new day's budget.
  await waitFor(() => delivered(name).length === 4, reset.ms - Date.now() + 20_000, "held packets delivered");
  expect(Date.now()).toBeGreaterThanOrEqual(reset.ms);
  const after = await second.status();
  expect(after.state).toBe("active");
  expect(after.stats.agent_spend_today).toBe(0.3);
  expect([...delivered(name)].sort()).toEqual([...ids].sort());
  expect(api.state.answered).toBe(4);
  expect(pipelineEvents(second, "pipeline.resumed")).toEqual([{ reason: "budget_window" }]);
  expect(pipelineEvents(second, "pipeline.paused")).toMatchObject([
    { reason: "budget", resume_at: resumeAt },
    { reason: "budget", resume_at: resumeAt, restored: true },
  ]);
  // warn_at warned once per budget day.
  expect(pipelineEvents(second, "budget.warning").map((w) => w.spent_usd)).toEqual([0.15, 0.15]);
  expect(second.lines().some((l) => l.includes("resumed: a new agent budget day started"))).toBe(true);
});

test("SIGKILL during an agent call: the call runs again, the packet is delivered once, only reported usage counts", async () => {
  const name = "call-crash";
  let slow = true;
  const api = mockClaude(() => (slow ? { body: null, hang: true } : toolUse({ label: "ok" })));
  stops.push(api.stop);
  writeConfig(box.home, { url: api.url });
  box.write(`${name}.pipo`, pipeline(name, "{ per_day: 100, per_packet: 100000 }"));
  const first = await start(name);
  const id = (await first.push({ n: 1 })).packet_id;
  await waitFor(() => api.calls.length === 1, 10_000, "the call to start");
  await first.kill();
  slow = false;
  expect(first.query("SELECT * FROM agent_spend")).toEqual([]);

  const second = await start(name);
  await waitFor(() => delivered(name).length === 1, 15_000, "delivery after restart");
  expect(delivered(name)).toEqual([id]);
  expect(api.calls).toHaveLength(2);
  expect(api.state.answered).toBe(1);
  const spend = second.query("SELECT root, input_tokens, output_tokens FROM agent_spend");
  expect(spend).toEqual([{ root: id, input_tokens: 1000, output_tokens: 500 }]);
  expect((await second.status()).stats.agent_spend_today).toBe(0.15);
  expect(second.query("SELECT COUNT(*) AS n FROM events WHERE type = 'packet.delivered'")).toEqual([{ n: 1 }]);
});
