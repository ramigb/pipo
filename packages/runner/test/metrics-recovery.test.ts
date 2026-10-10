// Latency samples under SIGKILL (docs/spec.md §7.6, §7.3, D54): a step's duration commits with the transition that
// completes it, so a step killed mid-run leaves no sample, its rerun leaves exactly one, and a restarted runner
// reports the samples of the run before (they live in the journal, not in memory).
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { ControlClient } from "../src";
import { sandbox, spawnRunner as spawn, waitFor } from "./helpers";

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
  for (const p of spawned) p.kill("SIGKILL");
  box.cleanup();
});

const N = 6;
const PIPELINE = `pipo: 1
name: timed
fn: ./fns.ts
concurrency: 1
input: { via: http }
nodes:
  slow: { from: input, transform: fn.slow }
output:
  from: slow
  to: sqlite
  with: { path: ./out.db, table: items, create: true, columns: { packet_id: "\${meta.packet_id}", n: "\${data.n}" } }
`;

function query<T>(sql: string): T[] {
  const db = new Database(join(box.home, "pipelines", "timed", "journal.db"), { readonly: true });
  try {
    return db.query(sql).all() as T[];
  } finally {
    db.close();
  }
}
const delivered = () => query<{ n: number }>("SELECT COUNT(*) AS n FROM packets WHERE state = 'delivered'")[0]?.n ?? 0;
const samples = (node: string) =>
  query<{ packet_id: string; n: number; ms: number }>(
    `SELECT packet_id, COUNT(*) AS n, MIN(ms) AS ms FROM events WHERE node = '${node}' AND ms IS NOT NULL GROUP BY packet_id`,
  );

test("SIGKILL mid-step: one latency sample per completed step, none for the killed run, all reported after restart", async () => {
  box.write("fns.ts", "export const slow = async (d) => { await new Promise((r) => setTimeout(r, 250)); return d; };");
  const file = box.write("timed.pipo", PIPELINE);

  const first = await spawn(box, spawned, "timed", file, 1);
  for (let n = 0; n < N; n++) {
    const res = await fetch(`http://127.0.0.1:${first.port}/in/timed`, { method: "POST", body: JSON.stringify({ n }) });
    expect(res.status).toBe(202);
  }
  // Kill it once some packets are through and the next one is inside `slow` (250 ms per step, one at a time).
  await waitFor(() => delivered() >= 2, 15_000, "two deliveries");
  await Bun.sleep(100);
  first.proc.kill("SIGKILL");
  await first.proc.exited;

  const before = samples("slow");
  const done = delivered();
  expect(done).toBeLessThan(N); // the kill interrupted work
  // Every sample belongs to a step that committed; the step in progress left none.
  const pastSlow = query<{ n: number }>("SELECT COUNT(*) AS n FROM packets WHERE cursor IS NULL OR cursor != 'slow'")[0]
    ?.n;
  expect(before.length).toBe(pastSlow as number);
  expect(before.length).toBeLessThan(N);

  const second = await spawn(box, spawned, "timed", file, 2);
  await waitFor(() => delivered() === N, 20_000, "all delivered");

  const slow = samples("slow");
  const output = samples("$output");
  // Exactly one sample per packet per step, even for the step that ran twice.
  expect(slow.length).toBe(N);
  expect(slow.every((s) => s.n === 1)).toBe(true);
  expect(slow.every((s) => s.ms >= 200)).toBe(true);
  expect(output.length).toBe(N);
  expect(output.every((s) => s.n === 1)).toBe(true);

  // The restarted runner reports the first run's samples too.
  const client = await ControlClient.forPipeline(box.home, "timed");
  try {
    const stats = (await client.request("status")).stats;
    expect(stats.latency.slow.count).toBe(N);
    expect(stats.latency.slow.p50_ms).toBeGreaterThanOrEqual(200);
    expect(stats.latency.output.count).toBe(N);
    expect(stats.oldest_pending_age_ms).toBeNull();
  } finally {
    client.close();
  }
  second.proc.kill("SIGTERM");
  expect(await second.proc.exited).toBe(0);
}, 60_000);
