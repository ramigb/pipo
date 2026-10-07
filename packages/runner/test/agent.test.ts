// Agent nodes and budgets in-process (docs/spec.md §3.4, §3.11, D36, D37). Every provider here is a mock: no test
// reaches the network. A fake clock drives budget days, so a day boundary passes on demand.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Runner, StartError } from "../src";
import type { AgentProvider, AgentRequest, AgentResult } from "../src/agents";
import { sandbox, settled, waitFor } from "./helpers";

const SCHEMA = JSON.stringify({
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: { label: { type: "string" } },
  required: ["label"],
  additionalProperties: false,
});

/** Prices that make the arithmetic easy: 1,000 input + 500 output tokens = $0.15. */
const PRICING = { claude_api: { "mock-model": { input: 100, output: 100 } } };

class FakeClock {
  t: number;
  private timers: { due: number; fn: () => void; id: number }[] = [];
  private next = 1;
  constructor(t: number) {
    this.t = t;
  }
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
  get armed() {
    return this.timers.map((x) => x.due);
  }
}

type Reply = (req: AgentRequest, call: number) => Promise<AgentResult> | AgentResult;
function mock(reply: Reply = () => ({ output: { label: "ok" }, input_tokens: 1000, output_tokens: 500 })) {
  const calls: AgentRequest[] = [];
  const provider: AgentProvider = {
    complete: async (req) => {
      calls.push(req);
      return reply(req, calls.length);
    },
  };
  return { provider, calls };
}

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function setup() {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  box.write("label.schema.json", SCHEMA);
  return box;
}

const pipeline = (o: { budget?: string; nodes?: string; onError?: string; name?: string } = {}) => `pipo: 1
name: ${o.name ?? "agents"}
${o.budget ?? "agent_budget: { per_day: 10, per_packet: 100000 }"}
input: { via: push }
nodes:
${
  o.nodes ??
  `  classify:
    from: input
    agent: claude_api
    with: { model: mock-model, prompt: "Classify \${json(data)}", schema: ./label.schema.json }
    on_error: ${o.onError ?? "{ retry: 0, then: dead_letter }"}`
}
output:
  from: ${o.nodes ? "last" : "classify"}
  to: file
  with: { path: ./out.jsonl, format: jsonl }
`;

async function open(
  box: ReturnType<typeof setup>,
  src: string,
  provider: AgentProvider,
  clock = new FakeClock(Date.UTC(2026, 9, 3, 12)),
) {
  const file = box.write("p.pipo", src);
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
  return { runner, push, clock, lines, out: join(box.root, "out.jsonl") };
}

const types = (runner: Runner, id: string) => runner.journal.events(id).map((e) => e.type);
const pipelineEvents = (runner: Runner, type: string) =>
  (
    runner.journal.db
      .query("SELECT detail FROM events WHERE packet_id IS NULL AND type = ? ORDER BY seq")
      .all(type) as { detail: string | null }[]
  ).map((e) => (e.detail ? JSON.parse(e.detail) : null));

describe("agent nodes", () => {
  test("output matching the schema becomes data; usage and cost are journaled", async () => {
    const box = setup();
    const m = mock();
    const { runner, push, out } = await open(box, pipeline(), m.provider);
    const id = await push({ subject: "printer on fire" });
    expect((await settled(runner, id)).state).toBe("delivered");
    expect(JSON.parse(readFileSync(out, "utf8").trim()).data).toEqual({ label: "ok" });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]).toMatchObject({
      model: "mock-model",
      max_tokens: 4096,
      prompt: 'Classify {"subject":"printer on fire"}',
    });
    expect(m.calls[0]?.schema).toMatchObject({ type: "object", required: ["label"] });
    const usage = runner.journal.events(id).find((e) => e.type === "agent.usage");
    expect(usage).toMatchObject({
      node: "classify",
      detail: { provider: "claude_api", model: "mock-model", input_tokens: 1000, output_tokens: 500, cost_usd: 0.15 },
    });
    expect(runner.agentSpendToday()).toBe(0.15);
  });

  test("output not matching the schema is a node error under on_error, and every paid attempt counts", async () => {
    const box = setup();
    const m = mock((_, n) => ({ output: n < 3 ? { wrong: 1 } : { label: "x" }, input_tokens: 10, output_tokens: 10 }));
    const { runner, push } = await open(
      box,
      pipeline({ onError: "{ retry: 1, delay: 10ms, then: dead_letter }" }),
      m.provider,
    );
    const id = await push({ n: 1 });
    const row = await settled(runner, id);
    expect(row.state).toBe("dead_lettered");
    expect(row.error).toMatchObject({ code: "node.failed", node: "classify", attempts: 2 });
    expect(row.error?.message).toContain("agent output does not match ./label.schema.json");
    expect(types(runner, id).filter((t) => t === "agent.usage")).toHaveLength(2);
    expect(runner.journal.packetAgentTokens(id)).toBe(40);
    // A retry that passes the schema delivers.
    const ok = await push({ n: 2 });
    expect((await settled(runner, ok)).state).toBe("delivered");
  });

  test("a call past with.timeout is aborted and is a node error", async () => {
    const box = setup();
    let aborted = false;
    const m = mock(
      (req) =>
        new Promise((_, reject) => {
          req.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const nodes = `  last:
    from: input
    agent: claude_api
    with: { model: mock-model, prompt: hi, schema: ./label.schema.json, timeout: 100ms, max_tokens: 50 }`;
    const { runner, push } = await open(box, pipeline({ nodes }), m.provider);
    const id = await push({});
    const row = await settled(runner, id);
    expect(row.state).toBe("dead_lettered");
    expect(row.error?.message).toContain("agent call timed out after 100ms");
    expect(aborted).toBe(true);
    expect(m.calls[0]?.max_tokens).toBe(50);
    expect(runner.agentSpendToday()).toBe(0);
  });

  test("a model without a price, or a provider without an API key, refuses to start", async () => {
    const box = setup();
    const file = box.write("p.pipo", pipeline().replace("mock-model", "gpt-unknown"));
    const err = (await Runner.open({ file, home: box.home, log: () => {} }).catch((e) => e)) as StartError;
    expect(err).toBeInstanceOf(StartError);
    expect(err.message).toContain("no price for model 'gpt-unknown'");
    // No provider injected: the real one needs its key, resolved from a reference (never a network call here).
    const file2 = box.write("q.pipo", pipeline({ name: "agents-key" }).replace("mock-model", "claude-sonnet-5-5"));
    const err2 = (await Runner.open({
      file: file2,
      home: box.home,
      log: () => {},
      resolver: async (ref) => {
        throw new Error(`cannot resolve ${ref} in this test`);
      },
    }).catch((e) => e)) as StartError;
    expect(err2).toBeInstanceOf(StartError);
    expect(err2.message).toContain("agent provider 'claude_api' needs an API key (env:ANTHROPIC_API_KEY)");
    expect(err2.message).toContain("op://");
  });
});

describe("agent_budget", () => {
  test("per_packet: a packet over its token cap is dead-lettered with budget.packet, never retried", async () => {
    const box = setup();
    const m = mock();
    const nodes = `  first:
    from: input
    agent: claude_api
    with: { model: mock-model, prompt: one, schema: ./label.schema.json }
  last:
    from: first
    agent: claude_api
    with: { model: mock-model, prompt: two, schema: ./label.schema.json }
    on_error: { retry: 3, delay: 10ms }`;
    const { runner, push } = await open(
      box,
      pipeline({ nodes, budget: "agent_budget: { per_packet: 2000 }" }),
      m.provider,
    );
    const id = await push({});
    const row = await settled(runner, id);
    expect(row.state).toBe("dead_lettered");
    expect(row.error).toMatchObject({ code: "budget.packet", node: "last" });
    expect(row.error?.message).toContain("3000 agent tokens");
    // The second call asked for at most what the packet had left.
    expect(m.calls.map((c) => c.max_tokens)).toEqual([2000, 500]);
    expect(runner.state).toBe("active");
    // A packet that already used its cap never calls again: a DLQ replay gets a fresh per-packet budget (D33).
    expect(runner.journal.packetAgentTokens(id)).toBe(3000);
  });

  test("per_day: reached → paused `budget` until the next day, warn_at warns once; the new day resumes it", async () => {
    const box = setup();
    const m = mock();
    // 23:00 UTC: the day resets at 06:00, so the next window opens in 7 hours.
    const clock = new FakeClock(Date.UTC(2026, 9, 3, 23));
    const { runner, push } = await open(
      box,
      pipeline({ budget: 'agent_budget: { per_day: 0.3, reset_at: "06:00", warn_at: 50% }' }),
      m.provider,
      clock,
    );
    const a = await push({ n: 1 });
    expect((await settled(runner, a)).state).toBe("delivered");
    const b = await push({ n: 2 });
    expect((await settled(runner, b)).state).toBe("delivered");
    expect(pipelineEvents(runner, "budget.warning")).toHaveLength(1);
    expect(pipelineEvents(runner, "budget.warning")[0]).toMatchObject({
      spent_usd: 0.15,
      warn_at: "50%",
      window_start: "2026-10-03T06:00:00.000Z",
    });
    const c = await push({ n: 3 });
    await waitFor(() => runner.state === "paused", 5000, "budget pause");
    expect(runner.pauseReason).toBe("budget");
    expect(runner.budgetResumesAt).toBe("2026-10-04T06:00:00.000Z");
    expect(pipelineEvents(runner, "pipeline.paused").at(-1)).toMatchObject({
      reason: "budget",
      resume_at: "2026-10-04T06:00:00.000Z",
      spent_usd: 0.3,
      per_day: 0.3,
    });
    expect(types(runner, c)).toContain("packet.held");
    expect(runner.journal.get(c)?.cursor).toBe("classify");
    expect(m.calls).toHaveLength(2);
    // Still accepting while paused (§2.2).
    const d = await push({ n: 4 });
    clock.set(Date.UTC(2026, 9, 4, 5, 59));
    expect(runner.state).toBe("paused");
    clock.set(Date.UTC(2026, 9, 4, 6));
    expect(runner.state).toBe("active");
    expect(pipelineEvents(runner, "pipeline.resumed").at(-1)).toEqual({ reason: "budget_window" });
    expect((await settled(runner, c)).state).toBe("delivered");
    expect((await settled(runner, d)).state).toBe("delivered");
    expect(runner.agentSpendToday()).toBe(0.3);
    // The new day warned once more, at its own 50%.
    expect(pipelineEvents(runner, "budget.warning")).toHaveLength(2);
  });

  test("a manual resume goes over the daily cap until the day ends, and the next day caps again", async () => {
    const box = setup();
    const m = mock();
    const clock = new FakeClock(Date.UTC(2026, 9, 3, 12));
    const { runner, push } = await open(
      box,
      pipeline({ budget: "agent_budget: { per_day: 0.15 }" }),
      m.provider,
      clock,
    );
    expect((await settled(runner, await push({ n: 1 }))).state).toBe("delivered");
    const held = await push({ n: 2 });
    await waitFor(() => runner.state === "paused", 5000, "budget pause");
    runner.resume();
    expect(pipelineEvents(runner, "pipeline.resumed").at(-1)).toEqual({
      budget_override: "2026-10-03T00:00:00.000Z",
      until: "2026-10-04T00:00:00.000Z",
    });
    expect((await settled(runner, held)).state).toBe("delivered");
    expect((await settled(runner, await push({ n: 3 }))).state).toBe("delivered");
    expect(runner.agentSpendToday()).toBe(0.45);
    clock.set(Date.UTC(2026, 9, 4, 1));
    expect((await settled(runner, await push({ n: 4 }))).state).toBe("delivered");
    await push({ n: 5 });
    await waitFor(() => runner.state === "paused", 5000, "budget pause on the next day");
  });

  test("spend, per-packet tokens and the override survive a restart (journal, not memory)", async () => {
    const box = setup();
    const m = mock();
    const clock = new FakeClock(Date.UTC(2026, 9, 3, 12));
    const first = await open(
      box,
      pipeline({ budget: "agent_budget: { per_day: 0.3, per_packet: 100000 }" }),
      m.provider,
      clock,
    );
    const id = await first.push({ n: 1 });
    await settled(first.runner, id);
    expect(first.runner.agentSpendToday()).toBe(0.15);
    await first.runner.stop();

    const second = await open(
      box,
      pipeline({ budget: "agent_budget: { per_day: 0.3, per_packet: 100000 }" }),
      m.provider,
      clock,
    );
    expect(second.runner.agentSpendToday()).toBe(0.15);
    expect(second.runner.journal.packetAgentTokens(id)).toBe(1500);
    await settled(second.runner, await second.push({ n: 2 }));
    await second.push({ n: 3 });
    await waitFor(() => second.runner.state === "paused", 5000, "budget pause after reopen");
    // A DLQ purge never gives money back: spend lives in its own table.
    second.runner.journal.db.query("DELETE FROM events WHERE type = 'agent.usage'").run();
    expect(second.runner.agentSpendToday()).toBe(0.3);
  });
});
