// The engine-wide agent budget in-process (docs/spec.md §3.11, D58): `engine.agent_budget.per_day` from the home's
// config.yaml caps the agent spend of every pipeline of the home, on top of each pipeline's own cap. Two runners share
// one home; every provider is a mock and a fake clock drives the budget days.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeAgentBudget, Runner, StartError } from "../src";
import type { AgentProvider } from "../src/agents";
import { sandbox, settled, waitFor } from "./helpers";

/** 1,000 input + 500 output tokens = $0.15 a call. */
const PRICING = { claude_api: { "mock-model": { input: 100, output: 100 } } };
const DAY = Date.UTC(2026, 9, 3, 12);

class FakeClock {
  private timers: { due: number; fn: () => void; id: number }[] = [];
  private next = 1;
  constructor(public t: number) {}
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.timers.push({ due: this.t + ms, fn, id });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== id);
  };
  set(t: number) {
    this.t = t;
    for (const x of this.timers.filter((x) => x.due <= t)) {
      this.clearTimeout(x.id);
      x.fn();
    }
  }
}

function mock() {
  const calls: string[] = [];
  const provider: AgentProvider = {
    complete: async (req) => {
      calls.push(req.prompt);
      return { output: { label: "ok" }, input_tokens: 1000, output_tokens: 500 };
    },
  };
  return { provider, calls };
}

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function home(config: string) {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  box.write(
    "label.schema.json",
    JSON.stringify({ type: "object", properties: { label: { type: "string" } }, required: ["label"] }),
  );
  mkdirSync(box.home, { recursive: true });
  writeFileSync(join(box.home, "config.yaml"), config);
  return box;
}

const pipeline = (name: string, budget: string) => `pipo: 1
name: ${name}
agent_budget: ${budget}
input: { via: push }
nodes:
  classify:
    from: input
    agent: claude_api
    with: { model: mock-model, prompt: "${name} \${json(data)}", schema: ./label.schema.json }
    on_error: { retry: 0, then: dead_letter }
output:
  from: classify
  to: file
  with: { path: ./${name}.jsonl, format: jsonl }
`;

async function open(box: ReturnType<typeof home>, name: string, budget: string, provider: AgentProvider, t = DAY) {
  const file = box.write(`${name}.pipo`, pipeline(name, budget));
  const clock = new FakeClock(t);
  const lines: string[] = [];
  const runner = await Runner.open({
    file,
    home: box.home,
    clock,
    log: (l) => lines.push(l),
    agents: { providers: { claude_api: provider }, pricing: PRICING, timezone: "UTC" },
  });
  await runner.start();
  cleanups.push(() => (runner.state === "stopped" || runner.state === "failed" ? undefined : runner.stop()));
  const push = async (data: unknown) => {
    const r = await runner.intake(data, { trigger: "push", source: "test" });
    if (r.status !== "accepted") throw new Error(JSON.stringify(r));
    return r.packet_id;
  };
  return { runner, push, clock, lines };
}

const pipelineEvents = (runner: Runner, type: string) =>
  (
    runner.journal.db
      .query("SELECT detail FROM events WHERE packet_id IS NULL AND type = ? ORDER BY seq")
      .all(type) as { detail: string | null }[]
  ).map((e) => (e.detail ? JSON.parse(e.detail) : null));

describe("engine.agent_budget", () => {
  test("two pipelines of one home: once their total reaches the engine cap, the next call of either is refused", async () => {
    const box = home("engine:\n  timezone: UTC\n  agent_budget: { per_day: 0.4 }\n");
    const ma = mock();
    const mb = mock();
    const a = await open(box, "a", "{ per_day: 0.3 }", ma.provider);
    // b's own day starts at 06:00; the engine day is midnight to midnight in engine.timezone.
    const b = await open(box, "b", '{ per_day: 0.3, reset_at: "06:00" }', mb.provider);

    expect((await settled(a.runner, await a.push({ n: 1 }))).state).toBe("delivered");
    expect((await settled(a.runner, await a.push({ n: 2 }))).state).toBe("delivered");
    // $0.30 spent before b's first call: under the $0.40 cap, so it runs (and takes the total over: checked before).
    expect((await settled(b.runner, await b.push({ n: 1 }))).state).toBe("delivered");
    expect(homeAgentBudget(box.home, DAY)).toMatchObject({
      per_day: 0.4,
      spent_usd: 0.45,
      pipelines: { a: 0.3, b: 0.15 },
    });

    // b is at $0.15 of its own $0.30, but the home is at $0.45 of $0.40: refused, held, paused until midnight.
    const held = await b.push({ n: 2 });
    await waitFor(() => b.runner.state === "paused", 5000, "engine budget pause");
    expect(mb.calls).toHaveLength(1);
    expect(b.runner.pauseReason).toBe("budget");
    expect(b.runner.budgetResumesAt).toBe("2026-10-04T00:00:00.000Z");
    const paused = pipelineEvents(b.runner, "pipeline.paused").at(-1);
    expect(paused).toMatchObject({
      reason: "budget",
      cap: "engine",
      resume_at: "2026-10-04T00:00:00.000Z",
      window_start: "2026-10-03T00:00:00.000Z",
      spent_usd: 0.45,
      per_day: 0.4,
      pipeline_spent_usd: 0.15,
    });
    expect(paused.message).toContain("reached engine.agent_budget.per_day $0.4000");
    expect(paused.message).toContain(`raise engine.agent_budget.per_day in ${join(box.home, "config.yaml")}`);
    expect(b.runner.journal.get(held)?.cursor).toBe("classify");
    expect(b.runner.journal.events(held).find((e) => e.type === "packet.held")?.detail).toMatchObject({
      error: { code: "budget.day" },
    });
    expect(b.lines.some((l) => l.includes("paused (budget)") && l.includes("engine.agent_budget"))).toBe(true);

    // a, at its own cap, pauses on that one first (its cap is checked before the engine's).
    await a.push({ n: 3 });
    await waitFor(() => a.runner.state === "paused", 5000, "pipeline budget pause");
    expect(pipelineEvents(a.runner, "pipeline.paused").at(-1)).toMatchObject({ cap: "pipeline", per_day: 0.3 });

    // A manual resume of b goes over the engine cap for today only; b's own cap still applies.
    b.runner.resume();
    expect(pipelineEvents(b.runner, "pipeline.resumed").at(-1)).toEqual({
      engine_budget_override: "2026-10-03T00:00:00.000Z",
      until: "2026-10-04T00:00:00.000Z",
    });
    expect((await settled(b.runner, held)).state).toBe("delivered");
    await b.push({ n: 3 });
    await waitFor(() => b.runner.state === "paused", 5000, "b's own cap");
    expect(pipelineEvents(b.runner, "pipeline.paused").at(-1)).toMatchObject({ cap: "pipeline", spent_usd: 0.3 });
    expect(homeAgentBudget(box.home, DAY).spent_usd).toBe(0.6);

    // The next engine day: a's held packet runs again on a fresh total.
    a.clock.set(Date.UTC(2026, 9, 4));
    expect(a.runner.state).toBe("active");
    await waitFor(() => ma.calls.length === 3, 5000, "a's held call");
    expect(homeAgentBudget(box.home, Date.UTC(2026, 9, 4, 1))).toMatchObject({
      spent_usd: 0.15,
      window_start: "2026-10-04T00:00:00.000Z",
      resets_at: "2026-10-05T00:00:00.000Z",
      pipelines: { a: 0.15 },
    });
  });

  test("an engine-cap override is restored from the journal, even after a later resume of the pipeline's own cap", async () => {
    const box = home("engine:\n  timezone: UTC\n  agent_budget: { per_day: 0.15 }\n");
    const m = mock();
    const first = await open(box, "c", "{ per_day: 0.3 }", m.provider);
    expect((await settled(first.runner, await first.push({ n: 1 }))).state).toBe("delivered");
    await first.push({ n: 2 });
    await waitFor(() => first.runner.state === "paused", 5000, "engine pause");
    first.runner.resume();
    await waitFor(() => m.calls.length === 2, 5000, "the held call, over the engine cap");
    await first.push({ n: 3 });
    await waitFor(() => first.runner.state === "paused", 5000, "pipeline pause");
    expect(pipelineEvents(first.runner, "pipeline.paused").at(-1)).toMatchObject({ cap: "pipeline" });
    first.runner.resume();
    expect(pipelineEvents(first.runner, "pipeline.resumed").at(-1)).toMatchObject({
      budget_override: expect.any(String),
    });
    await waitFor(() => m.calls.length === 3, 5000, "the held call, over both caps");
    await first.runner.stop();

    // The latest `pipeline.resumed` is the pipeline-cap override; the engine one before it still counts today.
    const second = await open(box, "c", "{ per_day: 0.3 }", m.provider);
    expect((await settled(second.runner, await second.push({ n: 4 }))).state).toBe("delivered");
    expect(m.calls).toHaveLength(4);
    expect(second.runner.state).toBe("active");
  });

  test("pipelines without agent spend and folders without a journal count zero; no cap reports null", async () => {
    const box = home("engine:\n  timezone: UTC\n");
    mkdirSync(join(box.home, "pipelines", "empty"), { recursive: true });
    const m = mock();
    const d = await open(box, "d", "{ per_day: 1 }", m.provider);
    await settled(d.runner, await d.push({ n: 1 }));
    expect(homeAgentBudget(box.home, DAY)).toEqual({
      per_day: null,
      spent_usd: 0.15,
      window_start: "2026-10-03T00:00:00.000Z",
      resets_at: "2026-10-04T00:00:00.000Z",
      timezone: "UTC",
      pipelines: { d: 0.15 },
    });
  });

  test("a bad engine.agent_budget refuses the start of a pipeline with agent nodes", async () => {
    const box = home("engine:\n  agent_budget: 5\n");
    const err = await open(box, "e", "{ per_day: 1 }", mock().provider).catch((e) => e);
    expect(err).toBeInstanceOf(StartError);
    expect(err.message).toContain("engine.agent_budget must be { per_day: <USD> }");
  });
});
