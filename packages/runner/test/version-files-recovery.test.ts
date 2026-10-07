// Version file hashes across SIGKILL and restarts (docs/spec.md §9.3, D60): spawned runners found through their
// registry entry, logs in files. The hashes are committed with the version row, so they survive a SIGKILL right
// after the reply. A start whose version recorded an fn module that has changed since warns in its log; a rollback to
// such a version warns in its reply and records the module it runs with, so the next start has nothing to warn about.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

const NAME = "vfiles";
const FNS = (tag: string) => `export const one = (d) => ({ ...d, v: "one${tag}" });
export const two = (d) => ({ ...d, v: "two${tag}" });
`;
const fns = box.write("fns.ts", FNS(""));
const SRC = (tag: string) => `pipo: 1
name: ${NAME}
fn: ./fns.ts
input: { via: push }
nodes:
  tag: { from: input, transform: fn.${tag} }
output:
  from: tag
  to: sqlite
  with: { path: ./${NAME}.db, table: items, create: true }
`;
const file = box.write(`${NAME}.pipo`, SRC("one"));
const sha = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

const journal = join(box.home, "pipelines", NAME, "journal.db");
function versions(): { version: number; files: string | null }[] {
  const db = new Database(journal, { readonly: true });
  try {
    return db.query("SELECT version, files FROM versions ORDER BY version").all() as any[];
  } finally {
    db.close();
  }
}
const recorded = (v: number) => {
  const row = versions().find((r) => r.version === v);
  return row?.files ? JSON.parse(row.files) : null;
};
const logOf = (r: { log: string }) =>
  [r.log, `${r.log}.err`].map((p) => (existsSync(p) ? readFileSync(p, "utf8") : "")).join("");

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

test("SIGKILL after apply and rollback keeps each version's file hashes; a changed fn module warns on start and rollback", async () => {
  // 1. v1 from the file, v2 applied; both record the fn module as it is. SIGKILL right after the apply's reply.
  const a = sha(fns);
  const first = await start(1);
  expect(await first.client.request("apply", { source: SRC("two"), by: "test" })).toMatchObject({ version: 2 });
  await kill(first);
  expect(recorded(1)).toEqual({ "./fns.ts": a });
  expect(recorded(2)).toEqual({ "./fns.ts": a });

  // 2. Edit the module. The .pipo file is unchanged, so v2 runs (D38), with the new module: the start warns.
  writeFileSync(fns, FNS("-edited"));
  const b = sha(fns);
  const second = await start(2);
  expect((await second.client.request("hello")).version).toBe(2);
  await waitFor(
    () => logOf(second).includes("./fns.ts has changed since v2 was recorded"),
    10_000,
    "the start's file warning in the log",
  );
  expect(logOf(second)).toContain(`sha256 ${a.slice(0, 12)}, now ${b.slice(0, 12)}`);

  // 3. Rollback to v1: it warns that v1's module changed and v3 runs the file as it is; then SIGKILL.
  const r = await second.client.request("rollback", { version: 1, by: "test" });
  expect(r).toMatchObject({ version: 3, changed: true, rolled_back_to: 1 });
  expect(r.warnings).toEqual([
    expect.objectContaining({ code: "file_changed", file: "./fns.ts", version: 1, recorded: a, current: b }),
  ]);
  await kill(second);
  expect(recorded(3)).toEqual({ "./fns.ts": b });

  // 4. The restart runs v3, which recorded the module it runs with: no warning; packets run the edited module.
  const third = await start(3);
  expect((await third.client.request("hello")).version).toBe(3);
  const id = (await third.client.request("push", { data: { n: 1 } })).packet_id as string;
  await waitFor(
    () => {
      const db = existsSync(join(box.root, `${NAME}.db`)) ? new Database(join(box.root, `${NAME}.db`)) : null;
      try {
        return (db?.query("SELECT v FROM items WHERE packet_id = ?").get(id) as { v: string } | null)?.v;
      } catch {
        return null;
      } finally {
        db?.close();
      }
    },
    10_000,
    "the packet written",
  ).then((v) => expect(v).toBe("one-edited"));
  expect(logOf(third)).not.toContain("has changed since");
  third.client.close();
  third.proc.kill("SIGTERM");
  expect(await third.proc.exited).toBe(0);
}, 90_000);
