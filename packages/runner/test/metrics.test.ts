// Built-in metrics on the control `status` op (docs/spec.md §7.6, D54): per-node latency over the latest completed
// steps, read from the journal, and the age of the oldest pending packet. Plus: caller text never reaches the
// journal with a secret in it, and a start and a live apply check trust in the runner's own home.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ORIGIN_FILE, sha256 } from "@pipo/spec";
import { ControlClient, Journal, Runner } from "../src";
import { computeMetrics, LATENCY_WINDOW, nodeLatency, percentile } from "../src/stats";
import { sandbox, settled, startRunner, waitFor } from "./helpers";

const boxes: ReturnType<typeof sandbox>[] = [];
afterEach(() => {
  for (const b of boxes.splice(0)) b.cleanup();
});
const box = () => {
  const b = sandbox();
  boxes.push(b);
  return b;
};

test("percentiles are nearest-rank over the samples; an empty window is all null", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  expect(nodeLatency(hundred.reverse())).toEqual({ count: 100, p50_ms: 50, p95_ms: 95, max_ms: 100 });
  expect(nodeLatency([7])).toEqual({ count: 1, p50_ms: 7, p95_ms: 7, max_ms: 7 });
  expect(nodeLatency([10, 30])).toEqual({ count: 2, p50_ms: 10, p95_ms: 30, max_ms: 30 });
  expect(nodeLatency([])).toEqual({ count: 0, p50_ms: null, p95_ms: null, max_ms: null });
  expect(percentile([1, 2, 3, 4], 0)).toBe(1);
});

function journalWithVersion(b: ReturnType<typeof sandbox>) {
  const j = new Journal(join(b.home, "pipelines", "m", "journal.db"));
  const v = j.version("h1", "pipo: 1\n");
  const add = (id: string, state: string, received_at: number) =>
    j.insert(
      {
        id,
        version: v,
        state: state as any,
        cursor: null,
        data: {},
        trigger: "push",
        source: "t",
        error: null,
        received_at,
      },
      "packet.accepted",
    );
  return { j, add };
}

test("latency covers the latest LATENCY_WINDOW completed steps per node; output is the $output step", () => {
  const b = box();
  const { j, add } = journalWithVersion(b);
  try {
    add("p1", "processing", 1000);
    // 150 completed steps at `a` taking 0..149 ms: only the newest 100 (50..149) count.
    for (let i = 0; i < 150; i++) j.update("p1", { attempt: 0 }, "node.done", "a", undefined, [], i);
    // Events at `a` without a duration (retries, logs) are not samples.
    j.update("p1", { attempt: 1 }, "step.retry", "a", { attempt: 1 });
    j.event("log", { message: "x" }, "p1", "a");
    j.update("p1", { attempt: 0 }, "output.written", "$output", undefined, [], 12.6);
    const m = computeMetrics(j, ["a", "b"], 5000);
    expect(m.latency_window).toBe(LATENCY_WINDOW);
    expect(m.latency.a).toEqual({ count: 100, p50_ms: 99, p95_ms: 144, max_ms: 149 });
    // A node of the version in force with no completed step yet still has a row.
    expect(m.latency.b).toEqual({ count: 0, p50_ms: null, p95_ms: null, max_ms: null });
    expect(m.latency.output).toEqual({ count: 1, p50_ms: 13, p95_ms: 13, max_ms: 13 });
    // The window read is an indexed one.
    const plan = j.db
      .query("EXPLAIN QUERY PLAN SELECT ms FROM events WHERE node = ? AND ms IS NOT NULL ORDER BY seq DESC LIMIT ?")
      .all("a", 100) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toContain("events_node_ms");
  } finally {
    j.close();
  }
});

test("oldest pending age counts every non-terminal packet, escalated and branched included; null when none", () => {
  const b = box();
  const { j, add } = journalWithVersion(b);
  try {
    expect(computeMetrics(j, [], 5000)).toMatchObject({
      oldest_pending_age_ms: null,
      oldest_pending_received_at: null,
    });
    add("done", "delivered", 100);
    add("dead", "dead_lettered", 200);
    add("bad", "rejected", 300);
    expect(computeMetrics(j, [], 5000).oldest_pending_age_ms).toBeNull();
    add("busy", "processing", 2000);
    add("waiting", "escalated", 1500);
    add("forked", "branched", 1800);
    const m = computeMetrics(j, [], 5000);
    expect(m.oldest_pending_age_ms).toBe(3500);
    expect(m.oldest_pending_received_at).toBe(new Date(1500).toISOString());
    j.update("waiting", { state: "filtered", cursor: null }, "packet.dropped");
    expect(computeMetrics(j, [], 5000).oldest_pending_age_ms).toBe(3200);
    // A clock behind the journal never gives a negative age.
    expect(computeMetrics(j, [], 0).oldest_pending_age_ms).toBe(0);
  } finally {
    j.close();
  }
});

test("a journal from before latency gets the ms column and index on open, keeping its events", () => {
  const b = box();
  const path = join(b.home, "pipelines", "old", "journal.db");
  new Journal(path).close();
  const raw = new Database(path);
  raw.exec("DROP INDEX events_node_ms; ALTER TABLE events DROP COLUMN ms");
  raw
    .query(
      "INSERT INTO events (at, packet_id, type, node, detail, patch) VALUES (1, NULL, 'old.event', 'a', NULL, NULL)",
    )
    .run();
  raw.close();
  const j = new Journal(path);
  try {
    const cols = (j.db.query("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("ms");
    expect(j.db.query("SELECT name FROM sqlite_master WHERE name = 'events_node_ms'").get()).not.toBeNull();
    expect(j.db.query("SELECT type, ms FROM events").all()).toEqual([{ type: "old.event", ms: null }]);
    expect(j.stepDurations("a", 10)).toEqual([]);
  } finally {
    j.close();
  }
  // Opening again is a no-op.
  new Journal(path).close();
});

const PIPE = `pipo: 1
name: met
fn: ./fns.ts
input: { via: http }
nodes:
  keep: { from: input, filter: "data.n != 2" }
  slow: { from: keep, transform: fn.slow }
output:
  from: slow
  to: file
  with: { path: ./out.jsonl, format: jsonl, mode: append }
`;

test("status reports latency per node from real steps and the oldest pending packet; latency survives a restart", async () => {
  const b = box();
  b.write("fns.ts", "export const slow = async (d) => { await Bun.sleep(60); return d; };");
  const file = b.write("met.pipo", PIPE);
  let { runner, post } = await startRunner(file, b.home);
  let client = await ControlClient.forPipeline(b.home, "met");
  try {
    for (const n of [1, 2, 3]) {
      const id = ((await (await post("", { n })).json()) as { packet_id: string }).packet_id;
      await settled(runner, id);
    }
    let s = (await client.request("status")).stats;
    // `keep` completed 3 steps (one filtered); `slow` and the output 2 each.
    expect(s.latency.keep.count).toBe(3);
    expect(s.latency.slow.count).toBe(2);
    expect(s.latency.slow.p50_ms).toBeGreaterThanOrEqual(50);
    expect(s.latency.slow.max_ms).toBeLessThan(5000);
    expect(s.latency.slow.p95_ms).toBeGreaterThanOrEqual(s.latency.slow.p50_ms);
    expect(s.latency.output.count).toBe(2);
    expect(s.latency.output.max_ms).toBeLessThan(5000);
    expect(s.latency_window).toBe(LATENCY_WINDOW);
    expect(s.oldest_pending_age_ms).toBeNull();
    expect(s.oldest_pending_received_at).toBeNull();

    // Paused, a pushed packet stays pending and ages.
    await client.request("pause");
    const pushed = (await client.request("push", { data: { n: 9 } })) as { packet_id: string };
    const row = runner.journal.get(pushed.packet_id);
    expect(row?.state).toBe("accepted");
    s = (await client.request("status")).stats;
    expect(s.oldest_pending_received_at).toBe(new Date(row?.received_at as number).toISOString());
    expect(s.oldest_pending_age_ms).toBeGreaterThanOrEqual(0);
    await Bun.sleep(30);
    const later = (await client.request("status")).stats;
    expect(later.oldest_pending_age_ms).toBeGreaterThan(s.oldest_pending_age_ms);

    client.close();
    await runner.stop();
    ({ runner, post } = await startRunner(file, b.home));
    client = await ControlClient.forPipeline(b.home, "met");
    s = (await client.request("status")).stats;
    expect(s.latency.slow.count).toBeGreaterThanOrEqual(2);
    expect(s.latency.keep.count).toBeGreaterThanOrEqual(3);
    await settled(runner, pushed.packet_id);
    await waitFor(
      async () => (await client.request("status")).stats.oldest_pending_age_ms === null,
      5000,
      "none pending",
    );
    expect((await client.request("status")).stats.latency.slow.count).toBe(3);
  } finally {
    client.close();
    await runner.stop();
  }
});

// ── caller text is redacted before it is journaled ───────────────────────

const SECRET = "s3cr3t-value-zz9";

function allJournalText(home: string, name: string): string {
  const db = new Database(join(home, "pipelines", name, "journal.db"), { readonly: true });
  try {
    const tables = ["events", "proposals", "versions"];
    return tables.map((t) => JSON.stringify(db.query(`SELECT * FROM ${t}`).all())).join("\n");
  } finally {
    db.close();
  }
}

test("a secret in resolve's by and reason, a proposal's author, by and reason, an apply's author never reaches the journal", async () => {
  const b = box();
  process.env.PIPO_TEST_R36 = SECRET;
  b.write("fns.ts", "export const boom = () => { throw new Error('nope'); };");
  const source = (extra = "") =>
    `pipo: 1\nname: red\nfn: ./fns.ts\nsecrets: { token: "env:PIPO_TEST_R36" }\ninput: { via: http }\nagent: { control: true }\nnodes:\n  boom: { from: input, transform: fn.boom, on_error: { retry: 0, then: agent } }\noutput:\n  from: boom\n  to: http\n  with: { url: "http://127.0.0.1:9/x", headers: { authorization: "\${secrets.token}" } }\n${extra}`;
  const file = b.write("red.pipo", source());
  const { runner, post } = await startRunner(file, b.home);
  const client = await ControlClient.forPipeline(b.home, "red");
  try {
    const id = ((await (await post("", { a: 1 })).json()) as { packet_id: string }).packet_id;
    await waitFor(() => runner.journal.get(id)?.state === "escalated", 5000, "escalated");
    await client.request("resolve", {
      ids: [id],
      action: "drop",
      by: `ops ${SECRET}`,
      by_kind: "human",
      reason: `token is ${SECRET}`,
    });
    const p = await client.request("propose", {
      source: source("# v2\n"),
      base_version: 1,
      author: `bot ${SECRET}`,
      author_kind: "human",
      reason: `because ${SECRET}`,
      apply: false,
    });
    expect(p.author).not.toContain(SECRET);
    await client.request("apply_proposal", { id: p.id, by: `approver ${SECRET}` });
    const q = await client.request("propose", {
      source: source("# v3\n"),
      base_version: 2,
      author: "bot",
      author_kind: "human",
      reason: "r",
      apply: false,
    });
    await client.request("reject_proposal", { id: q.id, by: `critic ${SECRET}`, reason: `no ${SECRET}` });
    await client.request("apply", { source: source("# v4\n"), by: `cli ${SECRET}`, reason: `again ${SECRET}` });
    const text = allJournalText(b.home, "red");
    expect(text).toContain("packet.resolved");
    expect(text).toContain("proposal.applied");
    expect(text).toContain("proposal.rejected");
    expect(text).toContain("version.applied");
    expect(text).toContain("***");
    expect(text).not.toContain(SECRET);
  } finally {
    client.close();
    await runner.stop();
    delete process.env.PIPO_TEST_R36;
  }
});

// ── check() reads trust.json from the runner's home ───────────────────────

test("a start and a live apply check fn trust in the runner's home, not $PIPO_HOME", async () => {
  const b = box();
  const dir = join(b.root, "proj");
  mkdirSync(dir, { recursive: true });
  const module = "export function make(d: any) { return d; }\n";
  writeFileSync(join(dir, "p.fn.ts"), module);
  const src = (extra = "") =>
    `pipo: 1\nname: homed\nfn: ./p.fn.ts\ninput: { via: http }\nnodes:\n  x: { from: input, transform: fn.make }\noutput: { from: x, to: stdout }\n${extra}`;
  writeFileSync(join(dir, "p.pipo"), src());
  writeFileSync(
    join(dir, ORIGIN_FILE),
    JSON.stringify({ template: "shared", template_hash: "abc123", modules: { "p.fn.ts": sha256(module) } }),
  );
  mkdirSync(b.home, { recursive: true });
  writeFileSync(
    join(b.home, "trust.json"),
    JSON.stringify({ version: 1, templates: { abc123: { template: "shared", trusted_at: "now" } } }),
  );
  // $PIPO_HOME points at a home that trusts nothing: only the runner's own home may decide.
  const previous = process.env.PIPO_HOME;
  process.env.PIPO_HOME = join(b.root, "elsewhere");
  try {
    const runner = await Runner.open({ file: join(dir, "p.pipo"), home: b.home, listen: 0, log: () => {} });
    try {
      await runner.start();
      const applied = await runner.applyVersion(src("# v2\n"), { author: "t", reason: "r39" });
      expect(applied.changed).toBe(true);
    } finally {
      await runner.stop();
    }
  } finally {
    if (previous === undefined) delete process.env.PIPO_HOME;
    else process.env.PIPO_HOME = previous;
  }
});
