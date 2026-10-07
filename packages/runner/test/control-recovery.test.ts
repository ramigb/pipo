// Control socket end to end (docs/spec.md §7.2, §3.10, D24): spawned runners found through their registry
// entry, packets pushed and acked over the socket, and SIGKILL while packets await an `external` ack: after a
// restart they keep their original deadline, and acking them delivers each exactly once.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, readRegistryEntry } from "../src";
import { sandbox, spawnRunner as spawn, waitFor } from "./helpers";

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
const clients: ControlClient[] = [];
afterAll(() => {
  for (const c of clients) c.close();
  for (const p of spawned) p.kill("SIGKILL");
  box.cleanup();
});

const pipeline = (name: string, within: string) => `pipo: 1
name: ${name}
input: { via: push }
output:
  from: input
  to: sqlite
  with: { path: ./${name}.db, table: items, create: true }
delivered:
  check: external
  within: ${within}
  on_fail: { then: dead_letter, message: "no ack for \${meta.packet_id}" }
`;

/** Read-only query that treats a busy or missing database as "not yet". */
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

const journal = (name: string) => join(box.home, "pipelines", name, "journal.db");
const state = (name: string, id: string) =>
  query(journal(name), "SELECT state FROM packets WHERE id = ?", id)?.[0]?.state as string | undefined;
const count = (name: string, id: string, type: string) =>
  query(journal(name), "SELECT COUNT(*) AS n FROM events WHERE packet_id = ? AND type = ?", id, type)?.[0]?.n ?? 0;
const deadline = (name: string, id: string) => {
  const r = query(
    journal(name),
    "SELECT detail FROM events WHERE packet_id = ? AND type = 'delivery.awaiting_ack' ORDER BY seq DESC LIMIT 1",
    id,
  )?.[0];
  return r ? (JSON.parse(r.detail).deadline as number) : undefined;
};

async function start(name: string, n: number) {
  const file = join(box.root, `${name}.pipo`);
  const runner = await spawn(box, spawned, name, file, n, [], 15_000);
  // Found through the registry entry, as the engine and CLI do.
  const entry = readRegistryEntry(box.home, name);
  expect(entry?.pid).toBe(runner.proc.pid);
  const client = await ControlClient.forPipeline(box.home, name);
  clients.push(client);
  expect(await client.request("hello")).toMatchObject({ pipeline: name, pid: runner.proc.pid });
  return { ...runner, client };
}

async function kill(r: { proc: ReturnType<typeof Bun.spawn>; client: ControlClient }) {
  r.client.close();
  r.proc.kill("SIGKILL");
  await r.proc.exited;
}

test("push and ack over a spawned runner's socket; no ack applies on_fail after `within`", async () => {
  const NAME = "acked";
  box.write(`${NAME}.pipo`, pipeline(NAME, "1500ms"));
  const r = await start(NAME, 1);

  const a = (await r.client.request("push", { data: { n: 1 } })).packet_id as string;
  expect(state(NAME, a)).toBeDefined(); // journaled before the reply
  await waitFor(() => deadline(NAME, a), 5000, "packet to await its ack");
  expect(state(NAME, a)).toBe("verifying");
  await r.client.request("ack", { packet_id: a });
  await waitFor(() => state(NAME, a) === "delivered", 5000, "acked packet delivered");

  const t0 = Date.now();
  const b = (await r.client.request("push", { data: { n: 2 } })).packet_id as string;
  await waitFor(() => state(NAME, b) === "dead_lettered", 10_000, "unacked packet dead-lettered");
  expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);

  const rows = query(join(box.root, `${NAME}.db`), "SELECT packet_id, n FROM items ORDER BY n") ?? [];
  expect(rows).toEqual([
    { packet_id: a, n: 1 },
    { packet_id: b, n: 2 },
  ]);

  // A clean stop over the socket removes the socket and the registry entry.
  expect(await r.client.request("stop")).toEqual({ state: "stopping" });
  expect(await r.proc.exited).toBe(0);
  expect(readRegistryEntry(box.home, NAME)).toBeNull();
  expect(existsSync(join(box.home, "run", `${NAME}.sock`))).toBe(false);
}, 60_000);

test("SIGKILL while packets await an ack: the restart keeps waiting, each ack delivers exactly once", async () => {
  const NAME = "killed";
  box.write(`${NAME}.pipo`, pipeline(NAME, "60s"));
  const ids: string[] = [];

  // 1. Five packets written and waiting; one ack lands just before the kill.
  const first = await start(NAME, 1);
  for (let n = 0; n < 5; n++) ids.push((await first.client.request("push", { data: { n } })).packet_id);
  await waitFor(() => ids.every((id) => deadline(NAME, id)), 10_000, "all five to await their ack");
  const deadlines = ids.map((id) => deadline(NAME, id));
  await first.client.request("ack", { packet_id: ids[0] });
  await kill(first);
  expect(ids.map((id) => state(NAME, id)).slice(1)).toEqual(["verifying", "verifying", "verifying", "verifying"]);

  // 2. The restart finds the stale socket, keeps every deadline, and the ack made before the kill still counts.
  const second = await start(NAME, 2);
  await waitFor(() => state(NAME, ids[0] as string) === "delivered", 10_000, "pre-kill ack delivered");
  for (const id of ids.slice(1, 3)) await second.client.request("ack", { packet_id: id });
  // An ack repeated after the restart is harmless.
  expect(await second.client.request("ack", { packet_id: ids[0] })).toMatchObject({ already: true });
  await waitFor(() => ids.slice(0, 3).every((id) => state(NAME, id) === "delivered"), 10_000, "acks delivered");
  expect((await second.client.request("status")).awaiting_ack).toBe(2);
  expect(ids.map((id) => deadline(NAME, id))).toEqual(deadlines);

  // 3. Kill again while two still wait; the third run delivers them on ack.
  await kill(second);
  const third = await start(NAME, 3);
  for (const id of ids.slice(3)) await third.client.request("ack", { packet_id: id });
  await waitFor(() => ids.every((id) => state(NAME, id) === "delivered"), 10_000, "every packet delivered");
  third.proc.kill("SIGTERM");
  expect(await third.proc.exited).toBe(0);

  for (const id of ids) {
    expect(count(NAME, id, "packet.delivered")).toBe(1);
    expect(count(NAME, id, "packet.acked")).toBe(1);
    expect(count(NAME, id, "delivery.awaiting_ack")).toBe(1);
  }
  const rows = query(join(box.root, `${NAME}.db`), "SELECT packet_id, n FROM items ORDER BY n") ?? [];
  expect(rows).toEqual(ids.map((packet_id, n) => ({ packet_id, n })));
}, 120_000);

test("SIGKILL while waiting: the deadline counts from the original write, not from the restart", async () => {
  const NAME = "expired";
  const WITHIN = 3000;
  box.write(`${NAME}.pipo`, pipeline(NAME, `${WITHIN}ms`));
  const first = await start(NAME, 1);
  const id = (await first.client.request("push", { data: { n: 1 } })).packet_id as string;
  const due = await waitFor(() => deadline(NAME, id), 5000, "packet to await its ack");
  await kill(first);

  const second = await start(NAME, 2);
  const restarted = Date.parse(readRegistryEntry(box.home, NAME)?.started_at as string);
  await waitFor(() => state(NAME, id) === "dead_lettered", 15_000, "packet dead-lettered");
  const failedAt = query(journal(NAME), "SELECT updated_at FROM packets WHERE id = ?", id)?.[0]?.updated_at as number;
  // A fresh window would end at restart + WITHIN; the kept one ends at the original deadline (or at once, if
  // the restart came after it).
  expect(failedAt).toBeLessThan(Math.max(due, restarted) + 1000);
  expect(failedAt).toBeGreaterThanOrEqual(due);
  expect(count(NAME, id, "delivery.awaiting_ack")).toBe(1);
  await kill(second);
}, 60_000);
