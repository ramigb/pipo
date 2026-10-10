// stats.in_per_min, stats.last_delivery_at and the stall note on the control `status` op (docs/spec.md D21, D23, §6).
// The 60 s window itself (a later clock) is unit-tested in crates/pipo-runner/src/stats.rs.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { post, suite } from "./core";
import { waitFor } from "./helpers";

setDefaultTimeout(30_000);
const { start } = suite();

const servers: { stop: (force?: boolean) => unknown }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

test("in_per_min counts packets accepted in the last 60 s; last_delivery_at is the latest delivery", async () => {
  const r = await start(
    "st1",
    "pipo: 1\nname: st1\ninput: { via: http }\noutput:\n  from: input\n  to: file\n  with: { path: ./st1.jsonl, format: jsonl, mode: append }\n",
  );
  expect((await r.status()).stats).toMatchObject({ in_per_min: 0, last_delivery_at: null });
  for (const n of [1, 2, 3]) await r.settled(await post(r, { n }));
  const s = (await r.status()).stats;
  expect(s.in_per_min).toBe(3);
  expect(Date.now() - Date.parse(s.last_delivery_at as string)).toBeLessThan(10_000);
});

test("status op reports a stalled node and clears it after a delivery", async () => {
  const state = { down: true };
  const server = Bun.serve({
    port: 0,
    fetch: () => (state.down ? new Response("down", { status: 500 }) : new Response("ok")),
  });
  servers.push(server);
  const r = await start(
    "st2",
    `pipo: 1\nname: st2\ninput: { via: http }\nerrors: { retry: 100, backoff: fixed, delay: 100ms, then: pause }\noutput:\n  from: input\n  to: http\n  with: { url: "http://127.0.0.1:${server.port}/x", method: POST }\ndelivered:\n  stall: { after: 300ms, then: notify }\n`,
  );
  let s = await r.status();
  expect(s.note).toBeNull();
  expect(s.stats.stalled).toBeNull();
  await post(r, { a: 1 });
  await waitFor(async () => (await r.status()).status === "jammed", 5000, "jammed");
  s = await r.status();
  // Packets wait at the output, so that is where it stalls.
  expect(typeof s.stats.stalled.node).toBe("string");
  expect(s.note).toBe(`stalled at '${s.stats.stalled.node}'`);
  expect(typeof s.stats.stalled.since).toBe("string");
  state.down = false;
  await waitFor(async () => (await r.status()).status !== "jammed", 5000, "unjammed");
  s = await r.status();
  expect(s.stats.stalled).toBeNull();
  expect(s.note).toBeNull();
});
