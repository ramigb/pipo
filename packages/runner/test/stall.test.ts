// delivered.stall: detection, notify (jammed) and pause, unjam, once per episode (docs/spec.md §3.10, D23).
// `then: agent` and `agent.on_stall: handle` (D50) are in escalation.test.ts.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { post, suite } from "./core";
import { waitFor } from "./helpers";
import type { RustRunner } from "./rust";

setDefaultTimeout(30_000);
const { box, start } = suite();

const servers: { stop: (force?: boolean) => unknown }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

let n = 0;
/** The output is an http endpoint that fails while `down` holds, so packets retry and pile up. */
async function setup(stall: string) {
  const state = { down: true };
  const server = Bun.serve({
    port: 0,
    fetch: () => (state.down ? new Response("down", { status: 500 }) : new Response("ok")),
  });
  servers.push(server);
  const name = `stalls${++n}`;
  const r = await start(
    name,
    `pipo: 1
name: ${name}
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
  return { r, state };
}

const events = (r: RustRunner, type: string) =>
  r.query<{ detail: string }>("SELECT detail FROM events WHERE type = ?", type).map((e) => JSON.parse(e.detail));
const status = async (r: RustRunner) => (await r.status()) as { state: string; status: string };

test("notify: jams, journals the rendered message once, unjams after a delivery", async () => {
  const { r, state } = await setup(`    after: 300ms
    then: notify
    message: "jammed \${stall.pending} for \${stall.duration}; oldest \${stall.oldest.packet_id} at \${stall.oldest.node} attempt \${stall.oldest.attempt} err \${stall.oldest.last_error} accepted \${stats.accepted}"`);
  const id = await post(r, { a: 1 });
  await waitFor(async () => (await status(r)).status === "jammed", 5000, "jammed");
  expect((await status(r)).state).toBe("active");
  const reg = JSON.parse(readFileSync(join(box.home, "run", `${r.name}.json`), "utf8"));
  expect(reg.state).toBe("jammed");
  expect((await r.status()).note).toContain("stalled at");
  await Bun.sleep(700);
  const fired = events(r, "pipeline.stall");
  expect(fired.length).toBe(1);
  expect(fired[0].message).toContain("jammed 1 for");
  expect(fired[0].message).toContain(`oldest ${id} at`);
  expect(fired[0].message).toContain("accepted 1");
  expect(fired[0].message).toMatch(/err .*500/);
  state.down = false;
  await r.settled(id, 10_000);
  await waitFor(async () => (await status(r)).status === "active", 5000, "unjam");
  expect(events(r, "pipeline.unjammed").length).toBe(1);
});

test("pause: pauses with reason stall; resume processes the backlog", async () => {
  const { r, state } = await setup(`    after: 300ms
    then: pause`);
  const id = await post(r, { a: 1 });
  await waitFor(async () => (await status(r)).state === "paused", 5000, "paused");
  expect((await r.status()).paused_reason).toBe("stall");
  expect(events(r, "pipeline.paused").map((e) => e.reason)).toEqual(["stall"]);
  expect(events(r, "pipeline.stall")[0].message).toContain("jammed");
  state.down = false;
  expect(await r.request("resume")).toMatchObject({ state: "active" });
  await r.settled(id, 10_000);
});

test("does not fire with nothing pending or while paused", async () => {
  const { r } = await setup(`    after: 200ms
    then: notify`);
  await Bun.sleep(600);
  expect(events(r, "pipeline.stall").length).toBe(0);
  await r.request("pause", { reason: "manual" });
  await post(r, { a: 1 });
  await Bun.sleep(700);
  expect((await status(r)).status).toBe("paused");
  expect(events(r, "pipeline.stall").length).toBe(0);
});
