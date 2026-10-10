// Fan-out under SIGKILL (docs/spec.md §3.4, §7.3, D22): a runner killed again and again while packets
// fan out never leaves a partial fan-out, and after a restart every packet is terminal with exactly
// one output row per (packet, branch).
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, spawnRunner as spawn, waitFor } from "./helpers";

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
  for (const p of spawned) p.kill("SIGKILL");
  box.cleanup();
});

const NAME = "fanny";
const JOURNAL = join(box.home, "pipelines", NAME, "journal.db");
const OUT = join(box.root, "out.db");
const spawnRunner = (file: string, n: number) => spawn(box, spawned, NAME, file, n, ["--listen", "0"], 15_000);

// input fans out to a and b; a fans out again to c and d. Every copy that reaches the output is a
// branch copy, so the delivery check can look rows up by `packet_id:branch` (the default key).
const PIPELINE = `pipo: 1
name: ${NAME}
fn: ./fns.ts
concurrency: 3
input: { via: http }
nodes:
  a: { from: input, transform: fn.slow }
  b: { from: input, transform: fn.slow }
  c: { from: a, transform: fn.slow }
  d: { from: a, transform: fn.slow }
output:
  from: [b, c, d]
  to: sqlite
  with: { path: ./out.db, table: items, create: true }
delivered:
  check: record_exists
  with: { where: { packet_id: "\${meta.packet_id}:\${meta.branch}" } }
`;

/** Read-only query that treats a busy or missing database as "not yet". */
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

type Unit = { id: string; state: string; parent: string | null; branch: string };
const units = (): Unit[] => query(JOURNAL, "SELECT id, state, parent, branch FROM packets") ?? [];

/** The journal after a kill: every fan-out is whole, and copies exist only under a fanned-out unit. */
function assertNoPartialFanOut() {
  const all = units();
  const children = new Map<string, string[]>();
  for (const u of all) if (u.parent) children.set(u.parent, [...(children.get(u.parent) ?? []), u.branch]);
  for (const u of all) {
    const kids = (children.get(u.id) ?? []).sort();
    if (u.branch === "") expect(kids.length ? kids : ["a", "b"]).toEqual(["a", "b"]);
    else if (u.branch === "a") expect(kids.length ? kids : ["a/c", "a/d"]).toEqual(["a/c", "a/d"]);
    else expect(kids).toEqual([]);
    // A unit fanned out if and only if its copies exist.
    expect(
      u.state === "branched" || (kids.length > 0 && ["delivered", "dead_lettered", "filtered"].includes(u.state)),
    ).toBe(kids.length > 0);
  }
  return all;
}

async function post(port: number, n: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/in/${NAME}`, { method: "POST", body: JSON.stringify({ n }) });
  expect(res.status).toBe(202);
  return ((await res.json()) as { packet_id: string }).packet_id;
}

async function kill(proc: ReturnType<typeof Bun.spawn>) {
  proc.kill("SIGKILL");
  await proc.exited;
}

test("SIGKILL repeatedly during fan-out: one row per (packet, branch), every packet terminal", async () => {
  box.write(
    "fns.ts",
    "export const slow = async (d) => { await new Promise((r) => setTimeout(r, 40)); return { n: d.n }; };",
  );
  const file = box.write(`${NAME}.pipo`, PIPELINE);
  const ids: string[] = [];

  // 1. 20 packets accepted, killed while their copies are being processed.
  const first = await spawnRunner(file, 1);
  for (let n = 0; n < 20; n++) ids.push(await post(first.port, n));
  await waitFor(() => units().some((u) => u.branch === "a/c"), 5000, "a nested fan-out");
  await kill(first.proc);
  let all = assertNoPartialFanOut();
  expect(all.filter((u) => u.branch === "").length).toBe(20); // nothing accepted was lost
  expect(all.filter((u) => u.branch === "" && u.state === "delivered").length).toBeLessThan(20);

  // 2. and 3. Restart, accept more, kill again mid-flight; restart and kill once more.
  const second = await spawnRunner(file, 2);
  for (let n = 20; n < 30; n++) ids.push(await post(second.port, n));
  await Bun.sleep(150);
  await kill(second.proc);
  all = assertNoPartialFanOut();
  expect(all.filter((u) => u.branch === "").length).toBe(30);

  const third = await spawnRunner(file, 3);
  await Bun.sleep(250);
  await kill(third.proc);
  assertNoPartialFanOut();

  // 4. A clean run finishes everything.
  const fourth = await spawnRunner(file, 4);
  await waitFor(
    () => {
      const roots = units().filter((u) => u.branch === "");
      return roots.length === 30 && roots.every((u) => u.state === "delivered");
    },
    30_000,
    "every packet delivered",
  );
  fourth.proc.kill("SIGTERM");
  expect(await fourth.proc.exited).toBe(0);

  all = assertNoPartialFanOut();
  expect(all.every((u) => u.state === "delivered")).toBe(true);
  expect(all).toHaveLength(30 * 5); // packet, a, b, a/c, a/d

  const written = (query(OUT, "SELECT packet_id, n FROM items") ?? []).map((r) => `${r.packet_id}=${r.n}`).sort();
  const expected = ids.flatMap((id, n) => ["b", "a/c", "a/d"].map((branch) => `${id}:${branch}=${n}`)).sort();
  expect(written).toEqual(expected);
  expect(readFileSync(fourth.log, "utf8")).toContain("started");
}, 120_000);
