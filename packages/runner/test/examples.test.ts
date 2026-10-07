// End-to-end runs of the pipelines in examples/ (copied into a sandbox so they write under /tmp).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeAgentBudget, Runner } from "../src";
import { copyExampleDir, sandbox, waitFor } from "./helpers";

const EXAMPLES = join(import.meta.dir, "../../../examples");

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function copyExample(name: string) {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  const dir = join(box.root, name);
  copyExampleDir(join(EXAMPLES, name), dir);
  return { box, dir, file: join(dir, `${name}.pipo`) };
}

async function open(file: string, home: string) {
  const runner = await Runner.open({ file, home, log: () => {} });
  await runner.start();
  cleanups.push(() => (runner.state === "stopped" ? undefined : runner.stop()));
  return runner;
}

describe("examples", () => {
  test("heartbeat appends a line per tick with distinct packet ids", async () => {
    const { box, dir, file } = copyExample("heartbeat");
    // Speed the 5s example up for the test; everything else is the shipped file.
    writeFileSync(file, readFileSync(file, "utf8").replace("every: 5s", "every: 100ms"));
    const runner = await open(file, box.home);
    const out = join(dir, "out", "heartbeat.jsonl");
    const lines = await waitFor(
      () => {
        try {
          const l = readFileSync(out, "utf8").trim().split("\n");
          return l.length >= 2 ? l : null;
        } catch {
          return null;
        }
      },
      10_000,
      "two heartbeat lines",
    );
    const recs = lines.map((l) => JSON.parse(l));
    expect(new Set(recs.map((r) => r.packet_id)).size).toBe(recs.length);
    expect(recs[0].data).toMatchObject({ service: "pipo-example", status: "alive" });
    await runner.stop();
  });

  test("inbox-forward POSTs each dropped file once, with an Idempotency-Key", async () => {
    const { box, dir, file } = copyExample("inbox-forward");
    const inbox = join(dir, "inbox");
    mkdirSync(inbox, { recursive: true });
    const got: { key: string | null; body: any }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        got.push({ key: req.headers.get("idempotency-key"), body: await req.json() });
        return new Response("ok");
      },
    });
    cleanups.push(() => server.stop(true));
    process.env.INBOX_URL = `http://127.0.0.1:${server.port}/ingest`;
    cleanups.push(() => {
      delete process.env.INBOX_URL;
    });
    const runner = await open(file, box.home);
    writeFileSync(join(inbox, "a.txt"), "alpha");
    writeFileSync(join(inbox, "b.txt"), "beta");
    await waitFor(() => got.length >= 2, 10_000, "two POSTs");
    await Bun.sleep(300);
    expect(got.length).toBe(2);
    const byFile = Object.fromEntries(got.map((g) => [g.body.file, g]));
    expect(byFile["a.txt"]?.body).toEqual({ file: "a.txt", text: "alpha" });
    expect(byFile["b.txt"]?.body).toEqual({ file: "b.txt", text: "beta" });
    expect(got.every((g) => g.key)).toBe(true);
    expect(new Set(got.map((g) => g.key)).size).toBe(2);
    await runner.stop();
  });

  test("ticket-triage runs against its mock Claude API through the real provider, under the engine-wide cap", async () => {
    const { box, dir, file } = copyExample("ticket-triage");
    const { mockClaude } = await import(join(dir, "mock-claude.ts"));
    const requests: any[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        requests.push({ key: req.headers.get("x-api-key"), body: await req.clone().json() });
        return mockClaude(req);
      },
    });
    cleanups.push(() => server.stop(true));
    process.env.PIPO_EXAMPLE_MOCK_KEY = "unused";
    cleanups.push(() => {
      delete process.env.PIPO_EXAMPLE_MOCK_KEY;
    });
    // One call costs $0.0009 (400 + 100 tokens at the built-in Haiku price): the cap allows two (D58, checked before
    // each call, so the second goes over it), well under the pipeline's own $0.50.
    mkdirSync(box.home, { recursive: true });
    writeFileSync(
      join(box.home, "config.yaml"),
      `engine:\n  timezone: UTC\n  agent_budget: { per_day: 0.0015 }\nagents:\n  claude_api:\n    base_url: http://127.0.0.1:${server.port}\n    api_key: env:PIPO_EXAMPLE_MOCK_KEY\n`,
    );
    const runner = await Runner.open({ file, home: box.home, listen: 0, log: () => {} });
    await runner.start();
    cleanups.push(() => (runner.state === "stopped" ? undefined : runner.stop()));
    const post = (ticket: unknown) =>
      fetch(`http://127.0.0.1:${runner.port}/in/ticket-triage/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ticket),
      });
    expect((await post({ subject: "", body: "no subject" })).status).toBe(422);
    expect((await post({ subject: "Site is down", body: "Checkout fails for everyone" })).status).toBeLessThan(300);
    expect((await post({ subject: "Charged twice", body: "Two charges on my invoice" })).status).toBeLessThan(300);
    const out = join(dir, "out", "triaged.jsonl");
    const lines = await waitFor(
      () => {
        try {
          const l = readFileSync(out, "utf8").trim().split("\n");
          return l.length >= 2 ? l.map((x) => JSON.parse(x)) : null;
        } catch {
          return null;
        }
      },
      10_000,
      "two triaged tickets",
    );
    expect(lines.map((l) => l.data).sort((a, b) => a.category.localeCompare(b.category))).toEqual([
      { category: "billing", priority: "normal", summary: "billing ticket: Charged twice" },
      { category: "outage", priority: "high", summary: "outage ticket: Site is down" },
    ]);
    expect(requests.map((r) => r.key)).toEqual(["unused", "unused"]);
    expect(requests[0].body.tool_choice).toEqual({ type: "tool", name: "pipo_output" });

    // The third ticket is accepted, then held: the home's spend reached engine.agent_budget.per_day.
    expect((await post({ subject: "Login loop", body: "Cannot sign in" })).status).toBeLessThan(300);
    await waitFor(() => runner.state === "paused", 10_000, "engine budget pause");
    expect(runner.pauseReason).toBe("budget");
    expect(requests).toHaveLength(2);
    expect(homeAgentBudget(box.home)).toMatchObject({
      per_day: 0.0015,
      spent_usd: 0.0018,
      pipelines: { "ticket-triage": 0.0018 },
    });
    await runner.stop();
  });
});
