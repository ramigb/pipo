// lifetime.max_packets and lifetime.until with the `stats` context (docs/spec.md §3.8, D21).
import { expect, setDefaultTimeout, test } from "bun:test";
import { runnerBinary, runnerEnv } from "../src/binary";
import { counts, post, suite } from "./core";
import { waitFor } from "./helpers";
import type { RustRunner } from "./rust";

setDefaultTimeout(30_000);
const { start, startFile, box } = suite();

let n = 0;
const pipeline = (name: string, lifetime: string) => `pipo: 1
name: ${name}
input: { via: http }
output:
  from: input
  to: file
  with: { path: ./${name}.jsonl, format: jsonl, mode: append }
lifetime:
${lifetime}
`;

const events = (r: RustRunner, type: string) =>
  r.query<{ detail: string }>("SELECT detail FROM events WHERE type = ?", type).map((e) => JSON.parse(e.detail));

function setup(lifetime: string, edit = (s: string) => s) {
  const name = `life${++n}`;
  return start(name, edit(pipeline(name, lifetime)));
}

test("max_packets: exactly N accepted under concurrent posts, then 503 and drain", async () => {
  const r = await setup("  max_packets: 5");
  const results = await Promise.all(Array.from({ length: 12 }, (_, n) => r.post("", { n }).catch(() => null)));
  const statuses = results.map((res) => res?.status);
  expect(statuses.filter((s) => s === 202).length).toBe(5);
  const refused = results.find((res) => res?.status === 503);
  if (!refused) throw new Error("no request was refused");
  expect(((await refused.json()) as { error: string }).error).toContain("lifetime.max_packets (5)");
  expect(await r.proc.exited).toBe(0);
  expect(r.query("SELECT state, COUNT(*) AS n FROM packets GROUP BY state")).toEqual([{ state: "delivered", n: 5 }]);
  expect(events(r, "pipeline.lifetime").map((e) => e.reason)).toEqual(["max_packets"]);
});

test("max_packets survives a restart: the journal count, not memory, decides", async () => {
  const name = `life${++n}`;
  const file = box.write(`${name}.pipo`, pipeline(name, "  max_packets: 3"));
  const first = await startFile(file, name);
  for (const n of [1, 2]) await post(first, { n });
  await waitFor(() => counts(first).delivered === 2, 10_000, "2 delivered");
  expect(await first.stop()).toBe(0);

  const second = await startFile(file, name);
  const both = await Promise.all([second.post("", { n: 3 }), second.post("", { n: 4 })]);
  expect(both.map((res) => res.status).sort()).toEqual([202, 503]);
  expect(await second.proc.exited).toBe(0);

  // Restarting once the limit is reached stops again without accepting anything. It may exit before its registry
  // entry is seen, so start it as a plain process.
  const log = `${box.root}/${name}-third.log`;
  const third = Bun.spawn([runnerBinary(), file, "--home", box.home, "--listen", "0"], {
    stdout: Bun.file(log),
    stderr: Bun.file(`${log}.err`),
    env: runnerEnv(),
  });
  expect(await third.exited).toBe(0);
  expect(first.query("SELECT COUNT(*) AS n FROM packets")).toEqual([{ n: 3 }]);
  expect(events(first, "pipeline.lifetime").map((e) => e.reason)).toEqual(["max_packets", "max_packets"]);
});

test("max_packets: rejected packets do not count", async () => {
  const r = await setup("  max_packets: 2", (s) =>
    s.replace("input: { via: http }", "input: { via: http, validate: [data.ok == true] }"),
  );
  expect((await r.post("", { ok: false })).status).toBe(422);
  expect((await r.post("", { ok: true })).status).toBe(202);
  expect((await r.post("", { ok: false })).status).toBe(422);
  expect((await r.post("", { ok: true })).status).toBe(202);
  expect(await r.proc.exited).toBe(0);
  expect(r.query("SELECT state, COUNT(*) AS n FROM packets GROUP BY state ORDER BY state")).toEqual([
    { state: "delivered", n: 2 },
    { state: "rejected", n: 2 },
  ]);
});

test("until: stops when stats.delivered reaches the value and records why", async () => {
  const r = await setup("  until: stats.delivered >= 3");
  for (let n = 0; n < 3; n++) {
    await post(r, { n });
    await waitFor(() => counts(r).delivered === n + 1 || r.proc.exitCode !== null, 10_000, "delivery");
  }
  expect(await r.proc.exited).toBe(0);
  const [ev] = events(r, "pipeline.lifetime");
  expect(ev.reason).toBe("until");
  expect(ev.stats).toMatchObject({ delivered: 3, pending: 0 });
  expect(r.query("SELECT COUNT(*) AS n FROM packets")).toEqual([{ n: 3 }]);
});

test("until: an expression that fails at runtime is logged once and does not stop the pipeline", async () => {
  const r = await setup("  until: len(stats.delivered) > 1");
  for (let n = 0; n < 3; n++) await post(r, { n });
  await waitFor(() => counts(r).delivered === 3, 10_000, "delivered");
  expect((await r.status()).state).toBe("active");
  const lines = [...r.lines(), ...r.stderr().split("\n")];
  expect(lines.filter((l) => l.includes("lifetime.until could not be evaluated")).length).toBe(1);
  expect(lines.join("\n")).toContain("Fix the expression");
  expect(await r.stop()).toBe(0);
  expect(events(r, "pipeline.lifetime_error").length).toBe(1);
});

test("until: stats.uptime is re-evaluated on a timer", async () => {
  const r = await setup("  until: stats.uptime >= 1");
  expect(await r.proc.exited).toBe(0);
  expect(events(r, "pipeline.lifetime").map((e) => e.reason)).toEqual(["until"]);
});

test("status stats count accepted, pending, delivered and dead-lettered from the journal", async () => {
  const r = await setup("  ttl: 1h");
  await r.settled(await post(r, { n: 1 }));
  await Bun.sleep(1100);
  const s = (await r.status()).stats;
  expect(s).toMatchObject({ accepted: 1, delivered: 1, pending: 0, dead_lettered: 0, escalated: 0, in_per_min: 1 });
  expect(s.uptime).toBeGreaterThanOrEqual(1);
  expect(typeof s.last_delivery_at).toBe("string");
});
