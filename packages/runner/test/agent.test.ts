// Agent nodes and budgets end to end (docs/spec.md §3.4, §3.11, D36, D37): the Rust runner calls `claude_api`, whose
// `base_url` (config.yaml) points at a mock Messages API served by the test, so no test reaches the network. The day
// boundary of a budget (the automatic resume) is in agent-recovery.test.ts, where it is combined with a crash.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ClaudeCall,
  KEY_ENV,
  LABEL_SCHEMA,
  mockClaude,
  packetTokens,
  pipelineEvents,
  type Reply,
  toolUse,
  types,
  utcDay,
  writeConfig,
} from "./agent-helpers";
import { sandbox, waitFor } from "./helpers";
import { RustRunner } from "./rust";

setDefaultTimeout(60_000);

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

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

/** A sandbox whose home's config.yaml points `claude_api` at a fresh mock answering with `reply`. */
function setup(reply?: (call: ClaudeCall, n: number) => Reply | Promise<Reply>) {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  const api = mockClaude(reply);
  cleanups.push(() => api.stop());
  box.write("label.schema.json", LABEL_SCHEMA);
  writeConfig(box.home, { url: api.url });
  return { box, api };
}

async function open(box: ReturnType<typeof sandbox>, src: string, name = "agents") {
  const file = box.write(`${name}.pipo`, src);
  const r = await RustRunner.start(box, file, name, { listen: null, env: KEY_ENV });
  cleanups.push(() => (r.proc.exitCode === null ? r.kill() : undefined));
  const push = async (data: unknown) => (await r.push(data)).packet_id;
  return { r, push, out: join(box.root, "out.jsonl") };
}

const spendToday = async (r: RustRunner) => (await r.status()).stats.agent_spend_today as number;

describe("agent nodes", () => {
  test("output matching the schema becomes data; usage and cost are journaled", async () => {
    const { box, api } = setup();
    const { r, push, out } = await open(box, pipeline());
    const id = await push({ subject: "printer on fire" });
    expect((await r.settled(id)).state).toBe("delivered");
    await waitFor(() => readFileSync(out, "utf8").trim(), 5000, "the output line");
    expect(JSON.parse(readFileSync(out, "utf8").trim()).data).toEqual({ label: "ok" });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({
      model: "mock-model",
      max_tokens: 4096,
      prompt: 'Classify {"subject":"printer on fire"}',
      key: "test-key-not-real",
    });
    expect(api.calls[0]?.schema).toMatchObject({ type: "object", required: ["label"] });
    const usage = r.events(id).find((e) => e.type === "agent.usage");
    expect(usage).toMatchObject({
      node: "classify",
      detail: { provider: "claude_api", model: "mock-model", input_tokens: 1000, output_tokens: 500, cost_usd: 0.15 },
    });
    expect(await spendToday(r)).toBe(0.15);
    // The resolved key never reaches the journal or the log.
    expect(JSON.stringify(r.query("SELECT * FROM events"))).not.toContain("test-key-not-real");
    expect(r.lines().join("\n")).not.toContain("test-key-not-real");
  });

  test("output not matching the schema is a node error under on_error, and every paid attempt counts", async () => {
    const { box } = setup((_, n) => toolUse(n < 3 ? { wrong: 1 } : { label: "x" }, 10, 10));
    const { r, push } = await open(box, pipeline({ onError: "{ retry: 1, delay: 10ms, then: dead_letter }" }));
    const id = await push({ n: 1 });
    const row = await r.settled(id);
    expect(row.state).toBe("dead_lettered");
    expect(row.error).toMatchObject({ code: "node.failed", node: "classify", attempts: 2 });
    expect(row.error?.message).toContain("agent output does not match ./label.schema.json");
    expect(types(r, id).filter((t) => t === "agent.usage")).toHaveLength(2);
    expect(packetTokens(r, id)).toBe(40);
    // A retry that passes the schema delivers.
    const ok = await push({ n: 2 });
    expect((await r.settled(ok)).state).toBe("delivered");
  });

  test("an API error is a node error with the API's message", async () => {
    const { box } = setup(() => ({ status: 529, body: { error: { message: "Overloaded" } } }));
    const { r, push } = await open(box, pipeline());
    const row = await r.settled(await push({}));
    expect(row.state).toBe("dead_lettered");
    expect(row.error?.message).toContain("Claude API answered 529: Overloaded");
    expect(await spendToday(r)).toBe(0);
  });

  test("a call past with.timeout is aborted and is a node error", async () => {
    const { box, api } = setup(() => ({ body: null, hang: true }));
    const nodes = `  last:
    from: input
    agent: claude_api
    with: { model: mock-model, prompt: hi, schema: ./label.schema.json, timeout: 300ms, max_tokens: 50 }`;
    const { r, push } = await open(box, pipeline({ nodes }));
    const id = await push({});
    const row = await r.settled(id, 10_000);
    expect(row.state).toBe("dead_lettered");
    expect(row.error?.message).toContain("agent call timed out after 300ms");
    await waitFor(() => api.state.aborted === 1, 5000, "the request to be dropped");
    expect(api.calls[0]?.max_tokens).toBe(50);
    expect(await spendToday(r)).toBe(0);
  });

  test("a model without a price, or a provider without its API key, refuses to start", async () => {
    const { box } = setup();
    const file = box.write("p.pipo", pipeline().replace("mock-model", "gpt-unknown"));
    const unpriced = await RustRunner.refuse(box, file, { env: KEY_ENV });
    expect(unpriced.code).toBe(1);
    expect(unpriced.stderr).toContain("no price for model 'gpt-unknown'");
    // The key is an `env:` reference; without that variable the start is refused before any call.
    const config = join(box.home, "config.yaml");
    writeFileSync(config, readFileSync(config, "utf8").replace("env:PIPO_TEST_ANTHROPIC_KEY", "env:PIPO_TEST_NO_KEY"));
    const file2 = box.write("q.pipo", pipeline({ name: "agents-key" }));
    const nokey = await RustRunner.refuse(box, file2, { env: KEY_ENV });
    expect(nokey.code).toBe(1);
    expect(nokey.stderr).toContain("agent provider 'claude_api' needs an API key (env:PIPO_TEST_NO_KEY)");
    expect(nokey.stderr).toContain("op://");
  });
});

describe("agent_budget", () => {
  test("per_packet: a packet over its token cap is dead-lettered with budget.packet, never retried", async () => {
    const { box, api } = setup();
    const nodes = `  first:
    from: input
    agent: claude_api
    with: { model: mock-model, prompt: one, schema: ./label.schema.json }
  last:
    from: first
    agent: claude_api
    with: { model: mock-model, prompt: two, schema: ./label.schema.json }
    on_error: { retry: 3, delay: 10ms }`;
    const { r, push } = await open(box, pipeline({ nodes, budget: "agent_budget: { per_packet: 2000 }" }));
    const id = await push({});
    const row = await r.settled(id);
    expect(row.state).toBe("dead_lettered");
    expect(row.error).toMatchObject({ code: "budget.packet", node: "last" });
    expect(row.error?.message).toContain("3000 agent tokens");
    // The second call asked for at most what the packet had left.
    expect(api.calls.map((c) => c.max_tokens)).toEqual([2000, 500]);
    expect((await r.status()).state).toBe("active");
    expect(packetTokens(r, id)).toBe(3000);
  });

  test("per_day: reached → paused `budget` until the next day, warn_at warns once; packets keep being accepted", async () => {
    const { box, api } = setup();
    const { r, push } = await open(box, pipeline({ budget: "agent_budget: { per_day: 0.3, warn_at: 50% }" }));
    const today = utcDay();
    const a = await push({ n: 1 });
    expect((await r.settled(a)).state).toBe("delivered");
    const b = await push({ n: 2 });
    expect((await r.settled(b)).state).toBe("delivered");
    expect(pipelineEvents(r, "budget.warning")).toHaveLength(1);
    expect(pipelineEvents(r, "budget.warning")[0]).toMatchObject({
      spent_usd: 0.15,
      warn_at: "50%",
      window_start: today.start,
    });
    const c = await push({ n: 3 });
    await waitFor(async () => (await r.status()).state === "paused", 5000, "budget pause");
    const status = await r.status();
    expect(status.paused_reason).toBe("budget");
    expect(status.budget_resumes_at).toBe(today.end);
    expect(pipelineEvents(r, "pipeline.paused").at(-1)).toMatchObject({
      reason: "budget",
      cap: "pipeline",
      resume_at: today.end,
      spent_usd: 0.3,
      per_day: 0.3,
    });
    expect(types(r, c)).toContain("packet.held");
    expect(r.packet(c)?.cursor).toBe("classify");
    expect(api.calls).toHaveLength(2);
    expect(r.lines().some((l) => l.includes("paused (budget)"))).toBe(true);
    // Still accepting while paused (§2.2).
    const d = await push({ n: 4 });
    await Bun.sleep(200);
    expect(r.packet(d)?.state).toBe("accepted");
    expect(api.calls).toHaveLength(2);
  });

  test("a manual resume goes over the daily cap until the day ends", async () => {
    const { box } = setup();
    const { r, push } = await open(box, pipeline({ budget: "agent_budget: { per_day: 0.15 }" }));
    const today = utcDay();
    expect((await r.settled(await push({ n: 1 }))).state).toBe("delivered");
    const held = await push({ n: 2 });
    await waitFor(async () => (await r.status()).state === "paused", 5000, "budget pause");
    expect(await r.request<Record<string, unknown>>("resume")).toEqual({ state: "active", already: false });
    expect(pipelineEvents(r, "pipeline.resumed").at(-1)).toEqual({ budget_override: today.start, until: today.end });
    expect((await r.settled(held)).state).toBe("delivered");
    expect((await r.settled(await push({ n: 3 }))).state).toBe("delivered");
    expect(await spendToday(r)).toBe(0.45);
    expect(r.lines().some((l) => l.includes("resumed over agent_budget.per_day"))).toBe(true);
  });

  test("spend, per-packet tokens and the override survive a restart (journal, not memory)", async () => {
    const { box } = setup();
    const src = pipeline({ budget: "agent_budget: { per_day: 0.3, per_packet: 100000 }" });
    const first = await open(box, src);
    const id = await first.push({ n: 1 });
    await first.r.settled(id);
    expect(await spendToday(first.r)).toBe(0.15);
    expect(await first.r.stop()).toBe(0);

    // A DLQ purge never gives money back: spend lives in its own table, not in the events.
    const db = new Database(first.r.journalPath);
    db.exec("DELETE FROM events WHERE type = 'agent.usage'");
    db.close();

    const second = await open(box, src);
    expect(await spendToday(second.r)).toBe(0.15);
    expect(packetTokens(second.r, id)).toBe(1500);
    await second.r.settled(await second.push({ n: 2 }));
    await second.push({ n: 3 });
    await waitFor(async () => (await second.r.status()).paused_reason === "budget", 5000, "budget pause after reopen");
    expect(await spendToday(second.r)).toBe(0.3);

    // A manual resume over the cap holds across a restart, until the day ends.
    await second.r.request("resume");
    await waitFor(
      () => second.r.query("SELECT 1 FROM packets WHERE state != 'delivered'").length === 0,
      5000,
      "drained",
    );
    expect(await second.r.stop()).toBe(0);
    const third = await open(box, src);
    expect((await third.r.status()).state).toBe("active");
    expect((await third.r.settled(await third.push({ n: 4 }))).state).toBe("delivered");
    expect(await spendToday(third.r)).toBe(0.6);
  });
});
