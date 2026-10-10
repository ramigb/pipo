// Packets waiting for the agent across SIGKILL (docs/spec.md §3.9, §7.3, §9, D50). Spawned runners, found through their
// registry entry, die at exact points (crashpoint.rs, PIPO_TEST_CRASH_AT): just before a unit is handed to the agent
// (the restart runs its step again and hands it over once), while units wait (the restart neither runs nor loses
// them), and just after a `resolve` retry commits, before its units are queued or the reply is sent (the restart
// resumes them). Each retried packet is written exactly once, on its pinned version; the one dead-lettered is never
// written. The failing step is an http tap against a server the test turns on and off, which counts the calls.
import { Database } from "bun:sqlite";
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sandbox, waitFor } from "./helpers";
import { RustRunner } from "./rust";

setDefaultTimeout(120_000);

const box = sandbox();
const running: RustRunner[] = [];
const ep = { down: true, hits: new Map<string, number>() };
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const { id } = (await req.json()) as { id: string };
    ep.hits.set(id, (ep.hits.get(id) ?? 0) + 1);
    return ep.down ? new Response("down", { status: 500 }) : new Response("ok");
  },
});
afterAll(async () => {
  for (const r of running) if (r.proc.exitCode === null) await r.kill();
  server.stop(true);
  box.cleanup();
});

const NAME = "waiting";
const file = box.write(
  `${NAME}.pipo`,
  `pipo: 1
name: ${NAME}
input: { via: push }
nodes:
  check:
    from: input
    tap: http
    with: { url: "http://127.0.0.1:${server.port}/x", method: POST, body: { id: "\${meta.packet_id}" } }
    on_error: { retry: 1, delay: 10ms, then: agent }
output:
  from: check
  to: sqlite
  with: { path: ./${NAME}.db, table: items, create: true }
agent: { control: true }
`,
);

function query(path: string, sql: string, ...params: any[]): any[] | null {
  if (!existsSync(path)) return null;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    return db.query(sql).all(...params);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
const journal = join(box.home, "pipelines", NAME, "journal.db");
const state = (id: string) => query(journal, "SELECT state FROM packets WHERE id = ?", id)?.[0]?.state;
const count = (id: string, type: string) =>
  query(journal, "SELECT COUNT(*) AS n FROM events WHERE packet_id = ? AND type = ?", id, type)?.[0]?.n ?? 0;
const calls = (id: string) => ep.hits.get(id) ?? 0;

async function start(crashAt?: string) {
  const r = await RustRunner.start(box, file, NAME, {
    listen: null,
    env: crashAt ? { PIPO_TEST_CRASH_AT: crashAt } : {},
  });
  running.push(r);
  return r;
}

test("a packet waiting for the agent survives SIGKILL: not re-run, not lost; a committed retry resumes and writes once", async () => {
  // 1. Killed just before the hand-over commits: the step is still in flight, so the restart runs it again.
  const first = await start("escalate.prepared");
  const a = (await first.push({ n: 0 })).packet_id;
  expect(await first.proc.exited).not.toBe(0);
  expect(state(a)).toBe("accepted");
  expect(count(a, "packet.escalated")).toBe(0);
  expect(calls(a)).toBe(2);

  const second = await start();
  await waitFor(() => state(a) === "escalated", 10_000, "a handed to the agent after the restart");
  expect(calls(a)).toBe(4);
  const b = (await second.push({ n: 1 })).packet_id;
  const c = (await second.push({ n: 2 })).packet_id;
  await waitFor(() => state(b) === "escalated" && state(c) === "escalated", 10_000, "b and c waiting");

  // 2. Killed while they wait: the restart neither runs them nor loses them.
  await second.kill();
  ep.down = false;
  const third = await start("resolve.committed");
  await Bun.sleep(500);
  expect([a, b, c].map(state)).toEqual(["escalated", "escalated", "escalated"]);
  expect([a, b, c].map(calls)).toEqual([4, 2, 2]);
  expect((await third.status()).stats).toMatchObject({ pending: 3, escalated: 3 });

  // 3. Killed right after a retry commits, before the units are queued or the reply goes out.
  const reply = await third
    .request("resolve", { ids: [a, b], action: "retry", by: "agent-ops", by_kind: "agent" })
    .catch((e: Error) => e);
  expect(reply).toBeInstanceOf(Error);
  expect(await third.proc.exited).not.toBe(0);
  expect([a, b, c].map(state)).toEqual(["processing", "processing", "escalated"]);

  const fourth = await start();
  await waitFor(() => state(a) === "delivered" && state(b) === "delivered", 10_000, "a and b delivered");
  await fourth.request("resolve", { ids: [c], action: "dead_letter", by: "ops" });
  expect(state(c)).toBe("dead_lettered");
  expect(await fourth.stop()).toBe(0);

  for (const id of [a, b, c]) {
    expect(count(id, "packet.escalated")).toBe(1);
    expect(count(id, "packet.resolved")).toBe(1);
  }
  for (const id of [a, b]) expect(count(id, "packet.delivered")).toBe(1);
  expect([a, b, c].map(calls)).toEqual([5, 3, 2]);
  expect(query(journal, "SELECT DISTINCT version FROM packets")).toEqual([{ version: 1 }]);
  const rows = query(join(box.root, `${NAME}.db`), "SELECT packet_id, n FROM items ORDER BY n") ?? [];
  expect(rows).toEqual([
    { packet_id: a, n: 0 },
    { packet_id: b, n: 1 },
  ]);
});
