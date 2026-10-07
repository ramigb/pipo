// delivered.stall: detection, notify (jammed) and pause, unjam, once per episode (docs/spec.md §3.10, D23).
// `then: agent` and `agent.on_stall: handle` (D50) are in escalation.test.ts.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, settled, startRunner, waitFor } from "./helpers";

const boxes: ReturnType<typeof sandbox>[] = [];
afterEach(() => {
  for (const b of boxes.splice(0)) b.cleanup();
});

/** The output is an http endpoint that fails while `down` holds, so packets retry and pile up. */
function setup(stall: string) {
  const box = sandbox();
  boxes.push(box);
  const state = { down: true };
  const server = Bun.serve({
    port: 0,
    fetch: () => (state.down ? new Response("down", { status: 500 }) : new Response("ok")),
  });
  const file = box.write(
    "s.pipo",
    `pipo: 1
name: stalls
input: { via: http }
errors: { retry: 100, backoff: fixed, delay: 100ms, then: pause }
output:
  from: input
  to: http
  with: { url: "http://127.0.0.1:${server.port}/x", method: POST }
delivered:
  stall:
${stall}
`,
  );
  return { box, file, state, server };
}

const events = (runner: { journal: { db?: unknown } } & any, type: string) =>
  (runner.journal.db.query("SELECT detail FROM events WHERE type = ?").all(type) as { detail: string }[]).map((e) =>
    JSON.parse(e.detail),
  );

test("notify: jams, journals the rendered message once, unjams after a delivery", async () => {
  const { box, file, state, server } = setup(`    after: 300ms
    then: notify
    message: "jammed \${stall.pending} for \${stall.duration}; oldest \${stall.oldest.packet_id} at \${stall.oldest.node} attempt \${stall.oldest.attempt} err \${stall.oldest.last_error} accepted \${stats.accepted}"`);
  const { runner, post } = await startRunner(file, box.home);
  try {
    const res = await post("", { a: 1 });
    const id = ((await res.json()) as { packet_id: string }).packet_id;
    await waitFor(() => runner.status === "jammed", 5000, "jammed");
    expect(runner.state).toBe("active");
    const reg = JSON.parse(readFileSync(join(box.home, "run", "stalls.json"), "utf8"));
    expect(reg.state).toBe("jammed");
    await Bun.sleep(700);
    const fired = events(runner, "pipeline.stall");
    expect(fired.length).toBe(1);
    expect(fired[0].message).toContain(`jammed 1 for`);
    expect(fired[0].message).toContain(`oldest ${id} at`);
    expect(fired[0].message).toContain("accepted 1");
    expect(fired[0].message).toMatch(/err .*500/);
    state.down = false;
    await settled(runner, id);
    await waitFor(() => runner.status === "active", 5000, "unjam");
    expect(events(runner, "pipeline.unjammed").length).toBe(1);
  } finally {
    await runner.stop();
    server.stop(true);
  }
});

test("pause: pauses with reason stall; resume processes the backlog", async () => {
  const { box, file, state, server } = setup(`    after: 300ms
    then: pause`);
  const { runner, post } = await startRunner(file, box.home);
  try {
    const res = await post("", { a: 1 });
    const id = ((await res.json()) as { packet_id: string }).packet_id;
    await waitFor(() => runner.state === "paused", 5000, "paused");
    expect(events(runner, "pipeline.paused").map((e) => e.reason)).toEqual(["stall"]);
    expect(events(runner, "pipeline.stall")[0].message).toContain("jammed");
    state.down = false;
    runner.resume();
    expect(runner.state).toBe("active");
    await settled(runner, id);
  } finally {
    await runner.stop();
    server.stop(true);
  }
});

test("does not fire with nothing pending or while paused", async () => {
  const { box, file, server } = setup(`    after: 200ms
    then: notify`);
  const { runner, post } = await startRunner(file, box.home);
  try {
    await Bun.sleep(600);
    expect(events(runner, "pipeline.stall").length).toBe(0);
    runner.pause("manual");
    await post("", { a: 1 });
    await Bun.sleep(700);
    expect(runner.status).toBe("paused");
    expect(events(runner, "pipeline.stall").length).toBe(0);
  } finally {
    await runner.stop();
    server.stop(true);
  }
});
