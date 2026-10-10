// The resilience promise (docs/spec.md §7.3): a runner killed with SIGKILL mid-flight loses
// nothing and duplicates nothing once it restarts.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rows, sandbox, spawnRunner as spawn, waitFor } from "./helpers";

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
  for (const p of spawned) p.kill("SIGKILL");
  box.cleanup();
});

const REGISTRY = join(box.home, "run", "crashy.json");
const spawnRunner = (file: string, n: number) => spawn(box, spawned, "crashy", file, n);

const PIPELINE = `pipo: 1
name: crashy
fn: ./fns.ts
concurrency: 2
input: { via: http }
nodes:
  slow:
    from: input
    transform: fn.slow
output:
  from: slow
  to: sqlite
  with: { path: ./out.db, table: items, create: true, columns: { packet_id: "\${meta.packet_id}", n: "\${data.n}" } }
delivered:
  check: record_exists
  with: { where: { packet_id: "\${meta.packet_id}" } }
`;

function states(): Record<string, number> {
  const db = new Database(join(box.home, "pipelines", "crashy", "journal.db"), { readonly: true });
  try {
    const all = db.query("SELECT state, COUNT(*) AS n FROM packets GROUP BY state").all() as {
      state: string;
      n: number;
    }[];
    return Object.fromEntries(all.map((r) => [r.state, r.n]));
  } finally {
    db.close();
  }
}

test("SIGKILL mid-flight: every accepted packet is delivered exactly once after restart", async () => {
  box.write("fns.ts", "export const slow = async (d) => { await new Promise((r) => setTimeout(r, 80)); return d; };");
  const file = box.write("crashy.pipo", PIPELINE);

  const first = await spawnRunner(file, 1);
  const ids: string[] = [];
  for (let n = 0; n < 20; n++) {
    const res = await fetch(`http://127.0.0.1:${first.port}/in/crashy`, {
      method: "POST",
      body: JSON.stringify({ n }),
    });
    expect(res.status).toBe(202);
    ids.push(((await res.json()) as { packet_id: string }).packet_id);
  }
  first.proc.kill("SIGKILL");
  await first.proc.exited;

  const before = states();
  expect(before.delivered ?? 0).toBeLessThan(20); // the kill really did interrupt work
  expect(Object.values(before).reduce((a, b) => a + b, 0)).toBe(20); // nothing accepted was lost

  // The killed runner left a stale registry entry (dead pid); it must not block a restart.
  const second = await spawnRunner(file, 2);
  await waitFor(() => states().delivered === 20, 15_000, "all packets delivered");

  const written = rows(join(box.root, "out.db"), "SELECT packet_id, n FROM items ORDER BY n");
  expect(written.map((r) => r.packet_id).sort()).toEqual([...ids].sort());
  expect(written.map((r) => r.n)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  // Exactly one terminal transition per packet in the journal too.
  const journal = join(box.home, "pipelines", "crashy", "journal.db");
  const delivered = rows(
    journal,
    "SELECT packet_id, COUNT(*) AS n FROM events WHERE type = 'packet.delivered' GROUP BY packet_id",
  );
  expect(delivered.length).toBe(20);
  expect(delivered.every((r) => r.n === 1)).toBe(true);

  second.proc.kill("SIGTERM");
  expect(await second.proc.exited).toBe(0);
  expect(existsSync(REGISTRY)).toBe(false);
  expect(readFileSync(second.log, "utf8")).toContain("resuming");
}, 30_000);
