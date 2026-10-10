// Packet and DLQ endpoints of the engine API (docs/spec.md §6, §8, D33, D34) with a real runner process: the packet
// page with its state filter, one packet's trace, the dead-letter queue, replay (delivered exactly once, a repeat is
// a 409) and purge; once the pipeline stopped, reads come from its journal and writes say to start it.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Supervisor } from "../src";
import { isAlive, query, sandbox, testConfig, waitFor } from "./helpers";

const box = sandbox();
const engines: Supervisor[] = [];
const pids: number[] = [];
afterAll(async () => {
  for (const e of engines) {
    for (const r of e.list()) if (r.pid) pids.push(r.pid);
    await Promise.race([e.shutdown({ now: true }), Bun.sleep(10_000)]);
  }
  for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  box.cleanup();
});

const NAME = "dlqapi";
const flag = join(box.root, "fail.flag");
box.write("fns.ts", "export const mark = (d) => ({ ...d, ok: true });\n");
// The `check` step fails while the flag file exists: an exec step, since a fn module has no file system.
const gate = `{ command: sh, args: ["-c", 'if [ -e "$0" ]; then echo flaky is failing >&2; exit 1; fi', ${JSON.stringify(flag)}] }`;
const file = box.write(
  `${NAME}.pipo`,
  `pipo: 1
name: ${NAME}
fn: ./fns.ts
input: { via: push }
nodes:
  check: { from: input, tap: exec, with: ${gate}, on_error: { retry: 0, then: dead_letter } }
  mark: { from: check, transform: fn.mark }
output: { from: mark, to: file, with: { path: ./${NAME}.jsonl, format: jsonl } }
`,
);

const post = (url: string, body: unknown = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = async (url: string) => {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as any };
};
const written = () =>
  existsSync(join(box.root, `${NAME}.jsonl`))
    ? readFileSync(join(box.root, `${NAME}.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

describe("packets and dlq over /api", () => {
  const home = join(box.root, "home");
  const journal = join(home, "pipelines", NAME, "journal.db");
  const state = (id: string) => query(journal, "SELECT state FROM packets WHERE id = ?", id)?.[0]?.state;
  let engine: Supervisor;
  let api: string;
  const ids: string[] = [];

  test("lists packets, traces one, lists the DLQ, replays exactly once and purges", async () => {
    engine = await Supervisor.open({ home, config: { ...testConfig(), listen: 0 }, log: () => {} });
    engines.push(engine);
    api = `${engine.gateway?.url}/api/pipelines/${NAME}`;
    expect((await post(`${engine.gateway?.url}/api/pipelines`, { file })).status).toBe(201);

    const ok = (await (await post(`${api}/push`, { data: { n: 0 } })).json()) as { packet_id: string };
    await waitFor(() => state(ok.packet_id) === "delivered", 10_000, "first packet delivered");
    writeFileSync(flag, "");
    for (let n = 1; n <= 3; n++) {
      ids.push(((await (await post(`${api}/push`, { data: { n } })).json()) as { packet_id: string }).packet_id);
    }
    await waitFor(() => ids.every((id) => state(id) === "dead_lettered"), 10_000, "three dead-lettered");

    const all = await get(`${api}/packets?limit=2`);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ total: 4, source: "runner", next: ids[1] });
    expect(all.body.packets.map((p: any) => p.packet_id)).toEqual([ids[2], ids[1]]);
    const page2 = await get(`${api}/packets?limit=2&after=${all.body.next}`);
    expect(page2.body.packets.map((p: any) => p.packet_id)).toEqual([ids[0], ok.packet_id]);
    const delivered = await get(`${api}/packets?state=delivered`);
    expect(delivered.body.packets.map((p: any) => p.packet_id)).toEqual([ok.packet_id]);
    const bad = await get(`${api}/packets?state=lost`);
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: "bad_request" });
    expect(bad.body.hint).toContain("dead_lettered");

    const trace = await get(`${api}/packets/${ok.packet_id}`);
    expect(trace.status).toBe(200);
    expect(trace.body.packet).toMatchObject({ packet_id: ok.packet_id, state: "delivered" });
    expect(trace.body.steps.map((s: any) => s.node)).toEqual(["input", "check", "mark", "$output", "$verify"]);
    expect(trace.body.steps[2]).toMatchObject({ changed: true, data: { n: 0, ok: true } });
    const missing = await get(`${api}/packets/nope`);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "not_found" });
    expect(missing.body.hint).toBeString();

    const dlq = await get(`${api}/dlq`);
    expect(dlq.body.total).toBe(3);
    expect(dlq.body.packets[0]).toMatchObject({ state: "dead_lettered", node: "check" });
    expect(dlq.body.packets[0].error.message).toBe("sh exited with code 1: flaky is failing");

    rmSync(flag);
    const replay = await post(`${api}/dlq/replay`, { ids: [ids[0]] });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: 1, packets: [{ packet_id: ids[0] }] });
    await waitFor(() => state(ids[0] as string) === "delivered", 10_000, "replayed packet delivered");
    const again = await post(`${api}/dlq/replay`, { ids: [ids[0]] });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "invalid_state" });
    expect((await post(`${api}/dlq/replay`, {})).status).toBe(400);
    expect((await post(`${api}/dlq/replay`, { ids: "x" })).status).toBe(400);
    expect((await fetch(`${api}/dlq/replay`)).status).toBe(405);

    const purge = await post(`${api}/dlq/purge`, { ids: [ids[1]] });
    expect(await purge.json()).toMatchObject({ purged: 1 });
    expect(state(ids[1] as string)).toBeUndefined();
    expect(written().filter((r) => r.packet_id === ids[0])).toHaveLength(1);
    expect(written()).toHaveLength(2);

    // A rerun from `mark` (D79): the plan, then the rerun; the file output skips the packet_id it already has.
    const plan = await post(`${api}/rerun`, { from: "mark", ids: [ids[0]], dry: true });
    expect(await plan.json()).toMatchObject({ rerun: 1, dry: true, path: [{ step: "mark" }, { step: "output" }] });
    const rerun = await post(`${api}/rerun`, { from: "mark", ids: [ids[0]] });
    expect(await rerun.json()).toMatchObject({ rerun: 1, packets: [{ packet_id: ids[0] }] });
    await waitFor(
      () =>
        query(journal, "SELECT 1 FROM events WHERE packet_id = ? AND type = 'packet.delivered'", ids[0])?.length === 2,
      10_000,
      "rerun packet delivered",
    );
    const ev = query(journal, "SELECT detail FROM events WHERE packet_id = ? AND type = 'packet.rerun'", ids[0]);
    expect(JSON.parse(ev?.[0]?.detail ?? "{}")).toMatchObject({ by: "api", from: "mark" });
    expect(written()).toHaveLength(2);
    const unknown = await post(`${api}/rerun`, { from: "mark", ids: [ids[0]], everything: true });
    expect([unknown.status, ((await unknown.json()) as any).error]).toEqual([400, "unknown key `everything`"]);
    const dead = await post(`${api}/rerun`, { from: "mark", ids: [ids[2]] });
    expect(dead.status).toBe(409);
    expect(((await dead.json()) as any).error).toContain("it is dead-lettered; replay it with pipo dlq replay");
  }, 60_000);

  test("once stopped, reads come from the journal and writes say to start the pipeline", async () => {
    await engine.stop(NAME, { now: true });
    const list = await get(`${api}/packets`);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ source: "journal", total: 3 });
    const dlq = await get(`${api}/dlq`);
    expect(dlq.body.packets.map((p: any) => p.packet_id)).toEqual([ids[2]]);
    const trace = await get(`${api}/packets/${ids[0]}`);
    expect(trace.body.source).toBe("journal");
    expect(trace.body.steps.map((s: any) => s.event)).toContain("dlq.replayed");
    const purged = await get(`${api}/packets/${ids[1]}`);
    expect(purged.body.purged.detail).toMatchObject({ by: "api" });

    const replay = await post(`${api}/dlq/replay`, { ids: [ids[2]] });
    expect(replay.status).toBe(409);
    const body = (await replay.json()) as any;
    expect(body.code).toBe("invalid_state");
    expect(body.hint).toContain("pipo start");
    expect(state(ids[2] as string)).toBe("dead_lettered");
    const rerun = await post(`${api}/rerun`, { from: "mark", all: true });
    expect(rerun.status).toBe(409);
    expect(((await rerun.json()) as any).hint).toContain("pipo start");

    const unknown = await get(`${engine.gateway?.url}/api/pipelines/ghost/packets`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("not_found");
    const ghost = await post(`${engine.gateway?.url}/api/pipelines/ghost/dlq/purge`, { all: true });
    expect(ghost.status).toBe(404);
    expect((await get(`${api}/packets/a/b`)).status).toBe(404);
  }, 30_000);
});
