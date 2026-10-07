// lifetime.max_packets and lifetime.until with the `stats` context (docs/spec.md §3.8, D21).
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { computeStats } from "../src/stats";
import { sandbox, settled, startRunner, waitFor } from "./helpers";

const boxes: ReturnType<typeof sandbox>[] = [];
afterEach(() => {
  for (const b of boxes.splice(0)) b.cleanup();
});

const pipeline = (lifetime: string) => `pipo: 1
name: life
input: { via: http }
output:
  from: input
  to: file
  with: { path: ./out.jsonl, format: jsonl, mode: append }
lifetime:
${lifetime}
`;

/** Read the journal from outside the runner (works after it has stopped and closed its handle). */
function journalQuery<T>(box: { home: string }, sql: string, ...args: string[]): T[] {
  const db = new Database(join(box.home, "pipelines", "life", "journal.db"), { readonly: true });
  try {
    return db.query(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}
const events = (box: { home: string }, type: string) =>
  journalQuery<{ detail: string }>(box, "SELECT detail FROM events WHERE type = ?", type).map((e) =>
    JSON.parse(e.detail),
  );

function setup(lifetime: string) {
  const box = sandbox();
  boxes.push(box);
  return { box, file: box.write("life.pipo", pipeline(lifetime)) };
}

test("max_packets: exactly N accepted under concurrent posts, then 503 and drain", async () => {
  const { box, file } = setup("  max_packets: 5");
  const { runner, post } = await startRunner(file, box.home);
  const results = await Promise.all(Array.from({ length: 12 }, (_, n) => post("", { n })));
  const statuses = results.map((r) => r.status);
  expect(statuses.filter((s) => s === 202).length).toBe(5);
  const refused = results.find((r) => r.status === 503);
  if (!refused) throw new Error("no request was refused");
  expect(((await refused.json()) as { error: string }).error).toContain("lifetime.max_packets (5)");
  expect(await runner.finished).toBe(0);
  expect(runner.state).toBe("stopped");
  expect(journalQuery(box, "SELECT state, COUNT(*) AS n FROM packets GROUP BY state")).toEqual([
    { state: "delivered", n: 5 },
  ]);
  expect(events(box, "pipeline.lifetime").map((e) => e.reason)).toEqual(["max_packets"]);
});

test("max_packets survives a restart: the journal count, not memory, decides", async () => {
  const { box, file } = setup("  max_packets: 3");
  const first = await startRunner(file, box.home);
  for (const n of [1, 2]) expect((await first.post("", { n })).status).toBe(202);
  await waitFor(() => first.runner.journal.counts().delivered === 2, 10_000, "2 delivered");
  await first.runner.stop();

  const second = await startRunner(file, box.home);
  const both = await Promise.all([second.post("", { n: 3 }), second.post("", { n: 4 })]);
  expect(both.map((r) => r.status).sort()).toEqual([202, 503]);
  await second.runner.finished;

  // Restarting once the limit is reached stops again without accepting anything.
  const third = await startRunner(file, box.home);
  expect(await third.runner.finished).toBe(0);
  expect(journalQuery(box, "SELECT COUNT(*) AS n FROM packets")).toEqual([{ n: 3 }]);
  expect(events(box, "pipeline.lifetime").map((e) => e.reason)).toEqual(["max_packets", "max_packets"]);
});

test("max_packets: rejected packets do not count", async () => {
  const box = sandbox();
  boxes.push(box);
  const file = box.write(
    "life.pipo",
    pipeline("  max_packets: 2").replace("input: { via: http }", "input: { via: http, validate: [data.ok == true] }"),
  );
  const { runner, post } = await startRunner(file, box.home);
  expect((await post("", { ok: false })).status).toBe(422);
  expect((await post("", { ok: true })).status).toBe(202);
  expect((await post("", { ok: false })).status).toBe(422);
  expect((await post("", { ok: true })).status).toBe(202);
  await runner.finished;
  expect(journalQuery(box, "SELECT state, COUNT(*) AS n FROM packets GROUP BY state ORDER BY state")).toEqual([
    { state: "delivered", n: 2 },
    { state: "rejected", n: 2 },
  ]);
});

test("until: stops when stats.delivered reaches the value and records why", async () => {
  const { box, file } = setup("  until: stats.delivered >= 3");
  const { runner, post } = await startRunner(file, box.home);
  for (let n = 0; n < 3; n++) {
    expect((await post("", { n })).status).toBe(202);
    await waitFor(() => runner.journal.counts().delivered === n + 1 || runner.state !== "active", 10_000, "delivery");
  }
  expect(await runner.finished).toBe(0);
  const [ev] = events(box, "pipeline.lifetime");
  expect(ev.reason).toBe("until");
  expect(ev.stats).toMatchObject({ delivered: 3, pending: 0 });
  expect(journalQuery(box, "SELECT COUNT(*) AS n FROM packets")).toEqual([{ n: 3 }]);
});

test("until: an expression that fails at runtime is logged once and does not stop the pipeline", async () => {
  const { box, file } = setup("  until: len(stats.delivered) > 1");
  const { runner, post, lines } = await startRunner(file, box.home);
  for (let n = 0; n < 3; n++) expect((await post("", { n })).status).toBe(202);
  await waitFor(() => runner.journal.counts().delivered === 3, 10_000, "delivered");
  expect(runner.state).toBe("active");
  expect(lines.filter((l) => l.includes("lifetime.until could not be evaluated")).length).toBe(1);
  expect(lines.join("\n")).toContain("Fix the expression");
  await runner.stop();
  expect(events(box, "pipeline.lifetime_error").length).toBe(1);
});

test("until: stats.uptime is re-evaluated on a timer", async () => {
  const { box, file } = setup("  until: stats.uptime >= 1");
  const { runner } = await startRunner(file, box.home);
  expect(await runner.finished).toBe(0);
  expect(events(box, "pipeline.lifetime").map((e) => e.reason)).toEqual(["until"]);
});

test("computeStats counts accepted, pending, delivered and dead-lettered from the journal", async () => {
  const { box, file } = setup("  ttl: 1h");
  const { runner, post } = await startRunner(file, box.home);
  const res = await post("", { n: 1 });
  await settled(runner, ((await res.json()) as { packet_id: string }).packet_id);
  const s = computeStats(runner.journal, Date.now() - 5000);
  expect(s).toMatchObject({ accepted: 1, delivered: 1, pending: 0, dead_lettered: 0, uptime: 5 });
  await runner.stop();
});
