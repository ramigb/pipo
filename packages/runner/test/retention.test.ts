// Retention (docs/spec.md §3.12, D39) through the Rust runner: a pass runs when the runner starts and every 10
// minutes after. The pass itself (defaults, custom durations, untouched pending packets, fan-out parents, bounded
// batches, daily compaction) is unit-tested in crates/pipo-runner/src/retention.rs.
import { expect, setDefaultTimeout, test } from "bun:test";
import { post, suite } from "./core";
import { waitFor } from "./helpers";

setDefaultTimeout(30_000);
const { box, startFile } = suite();

const source = (retention: string) => `pipo: 1
name: kept
input: { via: http, validate: [data.ok == true] }
output: { from: input, to: file, with: { path: ./kept.jsonl } }
retention: ${retention}
`;

test("a start clears settled packets past their retention and keeps the rest", async () => {
  const file = box.write("kept.pipo", source("{ data: 1h, rejected: 1h }"));
  const first = await startFile(file, "kept");
  const ok = await post(first, { ok: true });
  await first.settled(ok);
  expect((await first.post("", { ok: false })).status).toBe(422);
  expect(first.query("SELECT COUNT(*) AS n FROM retention_state")).toEqual([{ n: 1 }]);
  expect(await first.stop()).toBe(0);
  const data = () =>
    first.query<{ state: string; data: string | null }>("SELECT state, data FROM packets ORDER BY state");
  expect(data().every((p) => p.data !== null)).toBe(true);

  // A shorter data and rejected window: the next start's pass clears both payloads but keeps the trail.
  await Bun.sleep(50);
  box.write("kept.pipo", source("{ data: 10ms, rejected: 10ms, trail: 1h }"));
  const second = await startFile(file, "kept");
  await waitFor(() => data().every((p) => p.data === null), 5000, "payloads cleared");
  expect(data().map((p) => p.state)).toEqual(["delivered", "rejected"]);
  expect(second.events(ok).map((e) => e.type)).toContain("packet.delivered");
  expect(await second.stop()).toBe(0);

  // A trail window that has passed removes the packets and their events.
  await Bun.sleep(50);
  box.write("kept.pipo", source("{ data: 10ms, rejected: 10ms, trail: 10ms }"));
  const third = await startFile(file, "kept");
  await waitFor(() => data().length === 0, 5000, "packets removed");
  expect(third.events(ok)).toEqual([]);
  // Versions and pipeline-level events stay.
  expect(third.query<{ n: number }>("SELECT COUNT(*) AS n FROM versions")[0]?.n).toBe(3);
  expect(third.query<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE packet_id IS NULL")[0]?.n).toBeGreaterThan(
    0,
  );
});
