// Packets waiting for the agent across SIGKILL (docs/spec.md §3.9, §7.3, §9, D50). Spawned runners, found through their
// registry entry, die at exact points (crashpoint.ts): just before a unit is handed to the agent (the restart runs its
// step again and hands it over once), while units wait (the restart neither runs nor loses them), and just after a
// `resolve` retry commits, before its units are queued or the reply is sent (the restart resumes them). Each retried
// packet is written exactly once, on its pinned version; the one dead-lettered is never written.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient } from "../src";
import { sandbox, spawnRunner as spawn, waitFor } from "./helpers";

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
const clients: ControlClient[] = [];
afterAll(() => {
  for (const c of clients) c.close();
  for (const p of spawned) p.kill("SIGKILL");
  box.cleanup();
});

const NAME = "waiting";
const flag = join(box.root, "fail.flag");
const callsLog = join(box.root, "calls.log");
box.write(
  "fns.ts",
  `import { appendFileSync, existsSync } from "node:fs";
export const flaky = (d, meta) => {
  appendFileSync(${JSON.stringify(callsLog)}, meta.packet_id + "\\n");
  if (existsSync(${JSON.stringify(flag)})) throw new Error("flaky is failing");
  return d;
};
`,
);
box.write(
  `${NAME}.pipo`,
  `pipo: 1
name: ${NAME}
fn: ./fns.ts
input: { via: push }
nodes:
  check: { from: input, transform: fn.flaky, on_error: { retry: 1, delay: 10ms, then: agent } }
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
const calls = (id: string) =>
  existsSync(callsLog)
    ? readFileSync(callsLog, "utf8")
        .split("\n")
        .filter((l) => l === id).length
    : 0;

async function start(n: number, crashAt?: string) {
  const runner = await spawn(
    box,
    spawned,
    NAME,
    join(box.root, `${NAME}.pipo`),
    n,
    [],
    15_000,
    crashAt ? { PIPO_TEST_CRASH_AT: crashAt } : {},
  );
  const client = await ControlClient.forPipeline(box.home, NAME);
  clients.push(client);
  return { ...runner, client };
}

test("a packet waiting for the agent survives SIGKILL: not re-run, not lost; a committed retry resumes and writes once", async () => {
  writeFileSync(flag, "");

  // 1. Killed just before the hand-over commits: the step is still in flight, so the restart runs it again.
  const first = await start(1, "escalate.prepared");
  const a = (await first.client.request("push", { data: { n: 0 } })).packet_id as string;
  expect(await first.proc.exited).not.toBe(0);
  expect(state(a)).toBe("accepted");
  expect(count(a, "packet.escalated")).toBe(0);
  expect(calls(a)).toBe(2);

  const second = await start(2);
  await waitFor(() => state(a) === "escalated", 10_000, "a handed to the agent after the restart");
  expect(calls(a)).toBe(4);
  const b = (await second.client.request("push", { data: { n: 1 } })).packet_id as string;
  const c = (await second.client.request("push", { data: { n: 2 } })).packet_id as string;
  await waitFor(() => state(b) === "escalated" && state(c) === "escalated", 10_000, "b and c waiting");

  // 2. Killed while they wait: the restart neither runs them nor loses them.
  second.client.close();
  second.proc.kill("SIGKILL");
  await second.proc.exited;
  rmSync(flag);
  const third = await start(3, "resolve.committed");
  await Bun.sleep(500);
  expect([a, b, c].map(state)).toEqual(["escalated", "escalated", "escalated"]);
  expect([a, b, c].map(calls)).toEqual([4, 2, 2]);
  expect((await third.client.request("status")).stats).toMatchObject({ pending: 3, escalated: 3 });

  // 3. Killed right after a retry commits, before the units are queued or the reply goes out.
  const reply = await third.client
    .request("resolve", { ids: [a, b], action: "retry", by: "agent-ops", by_kind: "agent" }, 10_000)
    .catch((e: Error) => e);
  expect(reply).toBeInstanceOf(Error);
  expect(await third.proc.exited).not.toBe(0);
  expect([a, b, c].map(state)).toEqual(["processing", "processing", "escalated"]);

  const fourth = await start(4);
  await waitFor(() => state(a) === "delivered" && state(b) === "delivered", 10_000, "a and b delivered");
  await fourth.client.request("resolve", { ids: [c], action: "dead_letter", by: "ops" });
  expect(state(c)).toBe("dead_lettered");
  fourth.client.close();
  fourth.proc.kill("SIGTERM");
  expect(await fourth.proc.exited).toBe(0);

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
}, 120_000);
