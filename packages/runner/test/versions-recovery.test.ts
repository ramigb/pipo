// Rollback across SIGKILL (docs/spec.md §7.3, §9.3, D38): spawned runners found through their registry entry. A
// version applied and a rollback made over the socket are committed before the reply, so a runner killed right after
// restarts on the rolled-back version (its file is unchanged since the last start), while packets accepted before
// each change resume on the version they were pinned to and are written exactly once. A changed file then wins.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, readRegistryEntry } from "../src";
import { gateNode } from "./control-helpers";
import { sandbox, spawnRunner as spawn, waitFor } from "./helpers";

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
const clients: ControlClient[] = [];
afterAll(() => {
  // Let any gated exec program end: it outlives a SIGKILLed runner.
  writeFileSync(join(box.root, "release"), "");
  for (const c of clients) c.close();
  for (const p of spawned) p.kill("SIGKILL");
  box.cleanup();
});

const NAME = "vkill";
const release = join(box.root, "release");
box.write(
  "fns.ts",
  `export const one = (d) => ({ ...d, v: "one" });
export const two = (d) => ({ ...d, v: "two" });
`,
);
const SRC = (tag: string, extra = "") => `pipo: 1
name: ${NAME}
fn: ./fns.ts
input: { via: push }
nodes:
  gate: ${gateNode("input")}
  tag: { from: gate, transform: fn.${tag} }
output:
  from: tag
  to: sqlite
  with: { path: ./${NAME}.db, table: items, create: true }
${extra}`;
const file = box.write(`${NAME}.pipo`, SRC("one"));

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
const packet = (id: string) =>
  query(journal, "SELECT state, version, cursor FROM packets WHERE id = ?", id)?.[0] as
    | { state: string; version: number; cursor: string | null }
    | undefined;
const items = () => query(join(box.root, `${NAME}.db`), "SELECT packet_id, v FROM items ORDER BY packet_id") ?? [];

async function start(n: number) {
  const runner = await spawn(box, spawned, NAME, file, n, [], 15_000);
  expect(readRegistryEntry(box.home, NAME)?.pid).toBe(runner.proc.pid);
  const client = await ControlClient.forPipeline(box.home, NAME);
  clients.push(client);
  return { ...runner, client };
}

async function kill(r: { proc: ReturnType<typeof Bun.spawn>; client: ControlClient }) {
  r.client.close();
  r.proc.kill("SIGKILL");
  await r.proc.exited;
}

test("SIGKILL after a rollback: the restart keeps the rolled-back version; pinned packets finish on theirs", async () => {
  // 1. v1 from the file; a packet waits at the gate on v1. v2 is applied, a packet waits on v2. Rollback to v1 (v3).
  const first = await start(1);
  expect((await first.client.request("hello")).version).toBe(1);
  const a = (await first.client.request("push", { data: { n: 1, wait: true } })).packet_id as string;
  await waitFor(() => packet(a)?.cursor === "gate", 10_000, "packet a at the gate");
  expect(await first.client.request("apply", { source: SRC("two"), by: "test" })).toMatchObject({ version: 2 });
  const b = (await first.client.request("push", { data: { n: 2, wait: true } })).packet_id as string;
  expect(await first.client.request("rollback", { version: 1, by: "test" })).toMatchObject({
    version: 3,
    pending_older: 2,
  });
  const c = (await first.client.request("push", { data: { n: 3, wait: true } })).packet_id as string;
  await waitFor(() => [a, b, c].every((id) => packet(id)?.cursor === "gate"), 10_000, "three packets at the gate");
  await kill(first);
  expect([a, b, c].map((id) => packet(id)?.version)).toEqual([1, 2, 3]);

  // 2. The file is unchanged since the last start, so v3 stays (D38); the packets resume on their pinned versions.
  const second = await start(2);
  expect((await second.client.request("hello")).version).toBe(3);
  expect(readRegistryEntry(box.home, NAME)?.version).toBe(3);
  writeFileSync(release, "");
  const d = (await second.client.request("push", { data: { n: 4, wait: false } })).packet_id as string;
  await waitFor(() => [a, b, c, d].every((id) => packet(id)?.state === "delivered"), 15_000, "all delivered");
  expect(packet(d)?.version).toBe(3);
  expect(items()).toEqual(
    [
      { packet_id: a, v: "one" },
      { packet_id: b, v: "two" },
      { packet_id: c, v: "one" },
      { packet_id: d, v: "one" },
    ].sort((x, y) => x.packet_id.localeCompare(y.packet_id)),
  );
  const history = await second.client.request("versions");
  expect(history.versions.map((v: any) => [v.version, v.author, v.reason])).toEqual([
    [3, "test", "rollback to v1"],
    [2, "test", "applied"],
    [1, "human", "first start"],
  ]);
  await kill(second);

  // 3. Edit the file: it wins on the next start, as v4.
  writeFileSync(file, SRC("two", "description: edited"));
  const third = await start(3);
  expect((await third.client.request("hello")).version).toBe(4);
  const e = (await third.client.request("push", { data: { n: 5, wait: false } })).packet_id as string;
  await waitFor(() => packet(e)?.state === "delivered", 10_000, "packet e delivered");
  expect(items().find((i) => i.packet_id === e)?.v).toBe("two");
  expect(items()).toHaveLength(5);
  third.proc.kill("SIGTERM");
  expect(await third.proc.exited).toBe(0);
}, 90_000);
