// stats.in_per_min, stats.last_delivery_at and the stall note on the control `status` op (docs/spec.md D21, D23, §6).
import { afterEach, expect, test } from "bun:test";
import { ControlClient } from "../src";
import { computeStats } from "../src/stats";
import { sandbox, settled, startRunner, waitFor } from "./helpers";

const boxes: ReturnType<typeof sandbox>[] = [];
afterEach(() => {
  for (const b of boxes.splice(0)) b.cleanup();
});

function setup(extra: string) {
  const box = sandbox();
  boxes.push(box);
  const file = box.write(
    "s.pipo",
    `pipo: 1\nname: st\ninput: { via: http }\noutput:\n  from: input\n  to: file\n  with: { path: ./out.jsonl, format: jsonl, mode: append }\n${extra}\n`,
  );
  return { box, file };
}

test("in_per_min counts packets accepted in the last 60 s; last_delivery_at is the latest delivery", async () => {
  const { box, file } = setup("");
  const { runner, post } = await startRunner(file, box.home);
  try {
    const t0 = Date.now();
    expect(computeStats(runner.journal, t0)).toMatchObject({ in_per_min: 0, last_delivery_at: null });
    for (const n of [1, 2, 3]) {
      const id = ((await (await post("", { n })).json()) as { packet_id: string }).packet_id;
      await settled(runner, id);
    }
    const s = computeStats(runner.journal, runner.startedAt);
    expect(s.in_per_min).toBe(3);
    expect(Date.now() - Date.parse(s.last_delivery_at as string)).toBeLessThan(10_000);
    // A minute later the window is empty, but the last delivery is still known.
    const later = computeStats(runner.journal, runner.startedAt, Date.now() + 61_000);
    expect(later.in_per_min).toBe(0);
    expect(later.last_delivery_at).toBe(s.last_delivery_at);
  } finally {
    await runner.stop();
  }
});

test("status op reports a stalled node and clears it after a delivery", async () => {
  const box = sandbox();
  boxes.push(box);
  const state = { down: true };
  const server = Bun.serve({
    port: 0,
    fetch: () => (state.down ? new Response("down", { status: 500 }) : new Response("ok")),
  });
  const file = box.write(
    "s.pipo",
    `pipo: 1\nname: st\ninput: { via: http }\nerrors: { retry: 100, backoff: fixed, delay: 100ms, then: pause }\noutput:\n  from: input\n  to: http\n  with: { url: "http://127.0.0.1:${server.port}/x", method: POST }\ndelivered:\n  stall: { after: 300ms, then: notify }\n`,
  );
  const { runner, post } = await startRunner(file, box.home);
  const client = await ControlClient.forPipeline(box.home, "st");
  try {
    let s = await client.request("status");
    expect(s.note).toBeNull();
    expect(s.stats.stalled).toBeNull();
    await post("", { a: 1 });
    await waitFor(() => runner.status === "jammed", 5000, "jammed");
    s = await client.request("status");
    expect(s.stats.stalled.node).toBe(runner.stallInfo?.node as string);
    expect(s.note).toBe(`stalled at '${s.stats.stalled.node}'`);
    expect(typeof s.stats.stalled.since).toBe("string");
    state.down = false;
    await waitFor(() => runner.status !== "jammed", 5000, "unjammed");
    s = await client.request("status");
    expect(s.stats.stalled).toBeNull();
    expect(s.note).toBeNull();
  } finally {
    client.close();
    await runner.stop();
    server.stop(true);
  }
});
