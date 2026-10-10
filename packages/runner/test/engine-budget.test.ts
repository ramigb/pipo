// The engine-wide agent budget end to end (docs/spec.md §3.11, D58): `engine.agent_budget.per_day` from the home's
// config.yaml (handed to the Rust runner by `pipo compile`) caps the agent spend of every pipeline of the home, on top
// of each pipeline's own cap. Runners share one home and one mock `claude_api`; `homeAgentBudget` (TS, what the
// engine and `pipo status` show) reads the same journals. The next engine day (midnight in engine.timezone) can't be
// reached in a test without a clock; budget.rs covers it (the_engine_cap_sums_every_journal_of_the_home).
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homeAgentBudget } from "../src";
import { KEY_ENV, mockClaude, pipelineEvents, utcDay, writeConfig } from "./agent-helpers";
import { sandbox, waitFor } from "./helpers";
import { RustRunner } from "./rust";

setDefaultTimeout(60_000);

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function home(engine: string) {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  const api = mockClaude();
  cleanups.push(() => api.stop());
  box.write(
    "label.schema.json",
    JSON.stringify({ type: "object", properties: { label: { type: "string" } }, required: ["label"] }),
  );
  writeConfig(box.home, { url: api.url, engine });
  return { box, api };
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

async function open(box: ReturnType<typeof sandbox>, name: string, budget: string) {
  const file = box.write(`${name}.pipo`, pipeline(name, budget));
  const r = await RustRunner.start(box, file, name, { listen: null, env: KEY_ENV });
  cleanups.push(() => (r.proc.exitCode === null ? r.kill() : undefined));
  const push = async (data: unknown) => (await r.push(data)).packet_id;
  const paused = () => waitFor(async () => (await r.status()).state === "paused", 5000, `${name} paused`);
  return { r, push, paused };
}

const callsOf = (api: ReturnType<typeof mockClaude>, name: string) =>
  api.calls.filter((c) => c.prompt.startsWith(`${name} `)).length;

describe("engine.agent_budget", () => {
  test("two pipelines of one home: once their total reaches the engine cap, the next call of either is refused", async () => {
    const { box, api } = home("  agent_budget: { per_day: 0.4 }\n");
    const today = utcDay();
    const a = await open(box, "a", "{ per_day: 0.3 }");
    // b's own day starts at 06:00; the engine day is midnight to midnight in engine.timezone.
    const b = await open(box, "b", '{ per_day: 0.3, reset_at: "06:00" }');

    expect((await a.r.settled(await a.push({ n: 1 }))).state).toBe("delivered");
    expect((await a.r.settled(await a.push({ n: 2 }))).state).toBe("delivered");
    // $0.30 spent before b's first call: under the $0.40 cap, so it runs (and takes the total over: checked before).
    expect((await b.r.settled(await b.push({ n: 1 }))).state).toBe("delivered");
    expect(homeAgentBudget(box.home)).toMatchObject({
      per_day: 0.4,
      spent_usd: 0.45,
      window_start: today.start,
      resets_at: today.end,
      pipelines: { a: 0.3, b: 0.15 },
    });

    // b is at $0.15 of its own $0.30, but the home is at $0.45 of $0.40: refused, held, paused until midnight.
    const held = await b.push({ n: 2 });
    await b.paused();
    expect(callsOf(api, "b")).toBe(1);
    const status = await b.r.status();
    expect(status.paused_reason).toBe("budget");
    expect(status.budget_resumes_at).toBe(today.end);
    const paused = pipelineEvents(b.r, "pipeline.paused").at(-1);
    expect(paused).toMatchObject({
      reason: "budget",
      cap: "engine",
      resume_at: today.end,
      window_start: today.start,
      spent_usd: 0.45,
      per_day: 0.4,
      pipeline_spent_usd: 0.15,
    });
    expect(paused.message).toContain("reached engine.agent_budget.per_day $0.4000");
    expect(paused.message).toContain(`raise engine.agent_budget.per_day in ${join(box.home, "config.yaml")}`);
    expect(b.r.packet(held)?.cursor).toBe("classify");
    expect(b.r.events(held).find((e) => e.type === "packet.held")?.detail).toMatchObject({
      error: { code: "budget.day" },
    });
    expect(b.r.lines().some((l) => l.includes("paused (budget)") && l.includes("engine.agent_budget"))).toBe(true);

    // a, at its own cap, pauses on that one first (its cap is checked before the engine's).
    await a.push({ n: 3 });
    await a.paused();
    expect(pipelineEvents(a.r, "pipeline.paused").at(-1)).toMatchObject({ cap: "pipeline", per_day: 0.3 });

    // A manual resume of b goes over the engine cap for today only; b's own cap still applies.
    await b.r.request("resume");
    expect(pipelineEvents(b.r, "pipeline.resumed").at(-1)).toEqual({
      engine_budget_override: today.start,
      until: today.end,
    });
    expect((await b.r.settled(held)).state).toBe("delivered");
    await b.push({ n: 3 });
    await b.paused();
    expect(pipelineEvents(b.r, "pipeline.paused").at(-1)).toMatchObject({ cap: "pipeline", spent_usd: 0.3 });
    expect(homeAgentBudget(box.home).spent_usd).toBe(0.6);
    expect(callsOf(api, "a")).toBe(2);
    expect(callsOf(api, "b")).toBe(2);
  });

  test("an engine-cap override is restored from the journal, even after a later resume of the pipeline's own cap", async () => {
    const { box, api } = home("  agent_budget: { per_day: 0.15 }\n");
    const first = await open(box, "c", "{ per_day: 0.3 }");
    expect((await first.r.settled(await first.push({ n: 1 }))).state).toBe("delivered");
    await first.push({ n: 2 });
    await first.paused();
    expect(pipelineEvents(first.r, "pipeline.paused").at(-1)).toMatchObject({ cap: "engine" });
    await first.r.request("resume");
    await waitFor(() => api.calls.length === 2, 5000, "the held call, over the engine cap");
    await first.push({ n: 3 });
    await first.paused();
    expect(pipelineEvents(first.r, "pipeline.paused").at(-1)).toMatchObject({ cap: "pipeline" });
    await first.r.request("resume");
    expect(pipelineEvents(first.r, "pipeline.resumed").at(-1)).toMatchObject({ budget_override: expect.any(String) });
    await waitFor(() => api.calls.length === 3, 5000, "the held call, over both caps");
    await waitFor(() => first.r.query("SELECT 1 FROM packets WHERE state != 'delivered'").length === 0, 5000, "idle");
    expect(await first.r.stop()).toBe(0);

    // The latest `pipeline.resumed` is the pipeline-cap override; the engine one before it still counts today.
    const second = await open(box, "c", "{ per_day: 0.3 }");
    expect((await second.r.settled(await second.push({ n: 4 }))).state).toBe("delivered");
    expect(api.calls).toHaveLength(4);
    expect((await second.r.status()).state).toBe("active");
  });

  test("pipelines without agent spend and folders without a journal count zero; no cap reports null", async () => {
    const { box } = home("");
    mkdirSync(join(box.home, "pipelines", "empty"), { recursive: true });
    const d = await open(box, "d", "{ per_day: 1 }");
    await d.r.settled(await d.push({ n: 1 }));
    // A pipeline with a journal but no agent calls.
    const file = box.write(
      "quiet.pipo",
      "pipo: 1\nname: quiet\ninput: { via: push }\noutput: { from: input, to: stdout }\n",
    );
    const quiet = await RustRunner.start(box, file, "quiet", { listen: null });
    cleanups.push(() => (quiet.proc.exitCode === null ? quiet.kill() : undefined));
    await quiet.settled((await quiet.push({})).packet_id);
    const today = utcDay();
    expect(homeAgentBudget(box.home)).toEqual({
      per_day: null,
      spent_usd: 0.15,
      window_start: today.start,
      resets_at: today.end,
      timezone: "UTC",
      pipelines: { d: 0.15 },
    });
  });

  test("a bad engine.agent_budget refuses the start of a pipeline with agent nodes", async () => {
    const { box } = home("  agent_budget: 5\n");
    const file = box.write("e.pipo", pipeline("e", "{ per_day: 1 }"));
    const refused = await RustRunner.refuse(box, file, { env: KEY_ENV });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("engine.agent_budget must be { per_day: <USD> }");
  });
});
