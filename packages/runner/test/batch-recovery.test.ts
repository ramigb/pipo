// Batching under SIGKILL (docs/spec.md §3.5.1, §7.3, D20): packets waiting in a batch, a flush
// killed before the output committed, and a flush killed after the output committed but before
// the journal did, all end up delivered exactly once after a restart.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { holds, sandbox, spawnRunner as spawn, waitFor } from "./helpers";

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
  for (const p of spawned) p.kill("SIGKILL");
  box.cleanup();
});

const spawnRunner = (name: string, file: string, n: number) =>
  spawn(box, spawned, name, file, n, ["--listen", "0"], 15_000);
const journalOf = (name: string) => join(box.home, "pipelines", name, "journal.db");

async function post(name: string, port: number, n: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/in/${name}`, { method: "POST", body: JSON.stringify({ n }) });
  expect(res.status).toBe(202);
  return ((await res.json()) as { packet_id: string }).packet_id;
}

/** Read-only query that treats a busy database as "not yet". */
function query(path: string, sql: string): any[] | null {
  if (!existsSync(path)) return null;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    return db.query(sql).all();
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

const cursors = (name: string) =>
  (query(journalOf(name), "SELECT state, cursor FROM packets") ?? []).map((r) => `${r.state}@${r.cursor}`);
const allAtBatch = (name: string, count: number) => {
  const c = cursors(name);
  return c.length === count && c.every((s) => s === "writing@$batch");
};

/** Hold the journal's write lock so a flush can write the output but not commit its transitions. */
function lockJournal(name: string) {
  const db = new Database(journalOf(name));
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("BEGIN IMMEDIATE");
  return () => {
    db.exec("ROLLBACK");
    db.close();
  };
}

const sqlitePipeline = (name: string) => `pipo: 1
name: ${name}
input: { via: http }
output:
  from: input
  to: sqlite
  batch: { size: 100, within: 3s }
  with: { path: ./${name}.db, table: items, create: true, columns: { packet_id: "\${meta.packet_id}", n: "\${data.n}" } }
delivered:
  check: record_exists
  with: { where: { packet_id: "\${meta.packet_id}" } }
`;

test("sqlite: SIGKILL after the flush committed but before the journal did, and mid-flush: exactly once", async () => {
  const name = "bsql";
  const file = box.write(`${name}.pipo`, sqlitePipeline(name));
  const out = join(box.root, `${name}.db`);
  const ids: string[] = [];

  // 1. Five packets wait in a batch; the journal is locked, so the flush writes the output and blocks.
  const first = await spawnRunner(name, file, 1);
  for (let n = 0; n < 5; n++) ids.push(await post(name, first.port, n));
  await waitFor(() => allAtBatch(name, 5), 5000, "5 packets at $batch");
  const unlockJournal = lockJournal(name);
  await waitFor(() => query(out, "SELECT 1 FROM items")?.length === 5, 10_000, "flush written to the output");
  first.proc.kill("SIGKILL");
  await first.proc.exited;
  unlockJournal();
  expect(cursors(name)).toEqual(Array(5).fill("writing@$batch")); // written, not committed

  // 2. The output is locked: the restarted runner re-batches the 5 plus 4 new ones and is killed mid-flush.
  const lock = new Database(out);
  lock.exec("PRAGMA busy_timeout = 5000");
  lock.exec("BEGIN EXCLUSIVE");
  const second = await spawnRunner(name, file, 2);
  for (let n = 5; n < 9; n++) ids.push(await post(name, second.port, n));
  await waitFor(() => allAtBatch(name, 9), 5000, "9 packets at $batch");
  await waitFor(() => holds(second.proc.pid, out), 10_000, "flush started"); // opens the output on its first flush
  await Bun.sleep(300);
  second.proc.kill("SIGKILL");
  await second.proc.exited;
  lock.exec("ROLLBACK");
  lock.close();
  expect(query(out, "SELECT n FROM items")).toHaveLength(5);
  expect(cursors(name)).toEqual(Array(9).fill("writing@$batch"));

  // 3. A clean restart drains: the partial batch is flushed at once, re-writes are no-ops.
  const third = await spawnRunner(name, file, 3);
  third.proc.kill("SIGTERM");
  expect(await third.proc.exited).toBe(0);
  expect(cursors(name)).toEqual(Array(9).fill("delivered@null"));
  const written = query(out, "SELECT packet_id, n FROM items ORDER BY n") ?? [];
  expect(written.map((r) => r.packet_id).sort()).toEqual([...ids].sort());
  expect(written.map((r) => r.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  expect(readFileSync(third.log, "utf8")).toContain("resuming 9 packet(s)");
}, 90_000);

test("file: SIGKILL after the append but before the journal commit, and with a partial batch waiting", async () => {
  const name = "bfile";
  const file = box.write(
    `${name}.pipo`,
    `pipo: 1
name: ${name}
input: { via: http }
output:
  from: input
  to: file
  batch: { size: 100, within: 4s }
  with: { path: ./${name}.jsonl }
delivered:
  check: line_contains
  with: { value: "\${meta.packet_id}" }
`,
  );
  const out = join(box.root, `${name}.jsonl`);
  const lines = () => (existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean) : []);
  const ids: string[] = [];

  // 1. Appended, journal commit blocked, killed.
  const first = await spawnRunner(name, file, 1);
  for (let n = 0; n < 5; n++) ids.push(await post(name, first.port, n));
  await waitFor(() => allAtBatch(name, 5), 5000, "5 packets at $batch");
  const unlockJournal = lockJournal(name);
  await waitFor(() => lines().length === 5, 10_000, "flush appended");
  first.proc.kill("SIGKILL");
  await first.proc.exited;
  unlockJournal();
  expect(cursors(name)).toEqual(Array(5).fill("writing@$batch"));

  // 2. Restarted: the 5 rejoin a batch with 4 new packets; killed before `within` flushes it.
  const second = await spawnRunner(name, file, 2);
  for (let n = 5; n < 9; n++) ids.push(await post(name, second.port, n));
  await waitFor(() => allAtBatch(name, 9), 3000, "9 packets at $batch");
  second.proc.kill("SIGKILL");
  await second.proc.exited;
  expect(lines()).toHaveLength(5);
  expect(cursors(name)).toEqual(Array(9).fill("writing@$batch"));

  // 3. Drain: everything delivered, each packet's line exactly once.
  const third = await spawnRunner(name, file, 3);
  third.proc.kill("SIGTERM");
  expect(await third.proc.exited).toBe(0);
  expect(cursors(name)).toEqual(Array(9).fill("delivered@null"));
  const records = lines().map((l) => JSON.parse(l));
  expect(records.map((r) => r.packet_id).sort()).toEqual([...ids].sort());
  expect(records.map((r) => r.data.n).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
}, 90_000);
