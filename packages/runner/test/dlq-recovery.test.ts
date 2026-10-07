// DLQ replay across a crash (docs/spec.md §7.3, D33): spawned runners found through their registry entry. A replay
// commits each packet back in flight (patch + event, one transaction) before it is queued, so a SIGKILL right after
// the reply loses nothing: the restart resumes the replayed packets from the journal and writes each exactly once.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, type ControlError } from "../src";
import { sandbox, spawnRunner as spawn, waitFor } from "./helpers";

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
const clients: ControlClient[] = [];
afterAll(() => {
  for (const c of clients) c.close();
  for (const p of spawned) p.kill("SIGKILL");
  box.cleanup();
});

const NAME = "replayed";
const flag = join(box.root, "fail.flag");
box.write(
  "fns.ts",
  `import { existsSync } from "node:fs";
export const flaky = (d) => { if (existsSync(${JSON.stringify(flag)})) throw new Error("flaky is failing"); return d; };
`,
);
box.write(
  `${NAME}.pipo`,
  `pipo: 1
name: ${NAME}
fn: ./fns.ts
input: { via: push }
nodes:
  check: { from: input, transform: fn.flaky, on_error: { retry: 0, then: dead_letter } }
output:
  from: check
  to: sqlite
  with: { path: ./${NAME}.db, table: items, create: true }
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

async function start(n: number) {
  const runner = await spawn(box, spawned, NAME, join(box.root, `${NAME}.pipo`), n, [], 15_000);
  const client = await ControlClient.forPipeline(box.home, NAME);
  clients.push(client);
  return { ...runner, client };
}

test("SIGKILL right after a replay commits: the restart resumes each replayed packet and writes it exactly once", async () => {
  writeFileSync(flag, "");
  const first = await start(1);
  const ids: string[] = [];
  for (let n = 0; n < 4; n++) ids.push((await first.client.request("push", { data: { n } })).packet_id);
  await waitFor(() => ids.every((id) => state(id) === "dead_lettered"), 10_000, "every packet dead-lettered");
  expect((await first.client.request("dlq")).total).toBe(4);

  // Paused, so the replayed packets are committed but not yet processed when the runner dies.
  await first.client.request("pause");
  rmSync(flag);
  const replay = await first.client.request("replay", { ids: ids.slice(0, 3), by: "test" });
  expect(replay.replayed).toBe(3);
  first.client.close();
  first.proc.kill("SIGKILL");
  await first.proc.exited;
  expect(ids.map(state)).toEqual(["processing", "processing", "processing", "dead_lettered"]);

  const second = await start(2);
  // The pause may outlive the crash (D32); either way, resuming lets the replayed packets run.
  await second.client.request("resume");
  await waitFor(() => ids.slice(0, 3).every((id) => state(id) === "delivered"), 10_000, "replayed packets delivered");
  // The fourth was never replayed; replaying it now works, and replaying a delivered one is refused.
  const err = await second.client.request("replay", { ids: [ids[0]] }).catch((e: ControlError) => e);
  expect((err as ControlError).code).toBe("invalid_state");
  await second.client.request("replay", { all: true });
  await waitFor(() => state(ids[3] as string) === "delivered", 10_000, "the last packet delivered");
  second.client.close();
  second.proc.kill("SIGTERM");
  expect(await second.proc.exited).toBe(0);

  for (const id of ids) {
    expect(count(id, "dlq.replayed")).toBe(1);
    expect(count(id, "packet.delivered")).toBe(1);
    expect(count(id, "packet.dead_lettered")).toBe(1);
  }
  const rows = query(join(box.root, `${NAME}.db`), "SELECT packet_id, n FROM items ORDER BY n") ?? [];
  expect(rows).toEqual(ids.map((packet_id, n) => ({ packet_id, n })));
}, 90_000);
