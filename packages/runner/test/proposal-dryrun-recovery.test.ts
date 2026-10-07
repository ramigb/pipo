// A proposal's dry run across SIGKILL (docs/spec.md §7.3, §9.3, D48, D49, D51). A spawned runner, found through its
// registry entry, takes an agent's proposal through the `propose` control op; its base sets `agent.verify`, so the
// dry run replays the delivered packets, and the runner dies by SIGKILL inside it (crashpoint.ts): once every packet
// is replayed, before the outcome's transaction (`dryrun.replayed`), or just after that commits, before the apply
// (`dryrun.decided`). Before the commit the proposal stays `validated` with nothing of the dry run in the journal;
// after it, `verified`. Either way, after a restart the public `apply_proposal` op takes it to v2 (running the dry
// run again only when it never committed), with exactly one v2, outputs written exactly once, each packet on the
// version that accepted it.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, readRegistryEntry } from "../src";
import { sandbox, spawnRunner as spawn, waitFor } from "./helpers";

const boxes: ReturnType<typeof sandbox>[] = [];
const spawned: ReturnType<typeof Bun.spawn>[] = [];
const clients: ControlClient[] = [];
afterAll(() => {
  for (const c of clients) c.close();
  for (const p of spawned) p.kill("SIGKILL");
  for (const b of boxes) b.cleanup();
});

const NAME = "pdry";
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
agent:
  control: true
  edit: [nodes.tag]
  verify: last 5
`;
const TAG: Record<number, string> = { 1: "one", 2: "two" };

function query(path: string, sql: string, ...params: any[]): any[] {
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    return db.query(sql).all(...params);
  } finally {
    db.close();
  }
}

type Point = "dryrun.replayed" | "dryrun.decided";

async function scenario(point: Point) {
  const box = sandbox();
  boxes.push(box);
  box.write(
    "fns.ts",
    `export const one = (d) => ({ ...d, v: "one" });
export const two = (d) => ({ ...d, v: "two" });
`,
  );
  const file = box.write(`${NAME}.pipo`, SRC("one"));
  const journal = join(box.home, "pipelines", NAME, "journal.db");
  const out = join(box.root, `${NAME}.db`);
  const packets = () =>
    query(journal, "SELECT id, version, state FROM packets WHERE branch = '' ORDER BY id") as {
      id: string;
      version: number;
      state: string;
    }[];
  const versions = () => query(journal, "SELECT version, author_kind, proposal FROM versions ORDER BY version");
  const proposals = () =>
    query(journal, "SELECT id, state, applied_version, verification FROM proposals ORDER BY created_at") as {
      id: string;
      state: string;
      applied_version: number | null;
      verification: string | null;
    }[];
  const eventCount = (type: string) =>
    (query(journal, "SELECT COUNT(*) AS n FROM events WHERE type = ?", type)[0] as { n: number }).n;
  const items = () =>
    query(out, "SELECT packet_id, v FROM items ORDER BY packet_id") as { packet_id: string; v: string }[];
  const connect = async () => {
    const c = await ControlClient.forPipeline(box.home, NAME);
    clients.push(c);
    return c;
  };

  // 1. v1 runs and delivers three packets: what the dry run replays.
  const first = await spawn(box, spawned, NAME, file, 1, [], 15_000, { PIPO_TEST_CRASH_AT: point });
  const c1 = await connect();
  const before: string[] = [];
  for (let n = 0; n < 3; n++) before.push((await c1.request("push", { data: { n } })).packet_id);
  await waitFor(
    () => packets().length === 3 && packets().every((p) => p.state === "delivered"),
    15_000,
    "the first packets delivered",
  );
  expect(items().length).toBe(3);

  // 2. An agent proposes v2 through the control op; the runner dies inside the dry run.
  let failure: Error | undefined;
  try {
    await c1.request(
      "propose",
      { source: SRC("two"), base_version: 1, reason: "tag them two", author: "agent-ops", author_kind: "agent" },
      15_000,
    );
  } catch (e) {
    failure = e as Error;
  }
  expect(failure?.message).toContain("closed the control connection");
  await first.proc.exited;
  expect(first.proc.signalCode).toBe("SIGKILL");

  // 3. Right after the crash: the proposal is stored; the dry run's outcome is there only if its transaction committed.
  // Nothing else of the dry run reached the journal or the output.
  const [stored, ...others] = proposals();
  expect(others).toEqual([]);
  const id = stored?.id as string;
  expect(query(journal, "PRAGMA integrity_check")[0]).toEqual({ integrity_check: "ok" });
  if (point === "dryrun.replayed") {
    expect(stored).toMatchObject({ state: "validated", applied_version: null, verification: null });
    expect(eventCount("proposal.verified") + eventCount("proposal.rejected")).toBe(0);
  } else {
    expect(stored).toMatchObject({ state: "verified", applied_version: null });
    expect(JSON.parse(stored?.verification as string)).toMatchObject({ replayed: 3, passed: 3, diverged: 0 });
    expect(eventCount("proposal.verified")).toBe(1);
  }
  expect(versions().map((v) => v.version)).toEqual([1]);
  expect(eventCount("version.applied") + eventCount("proposal.applied")).toBe(0);
  expect(packets().length).toBe(3);
  expect(items().length).toBe(3);

  // 4. Restart (the file is unchanged, so v1 runs); the stranded proposal is found and applied through the public op.
  const second = await spawn(box, spawned, NAME, file, 2, [], 15_000);
  const c2 = await connect();
  expect((await c2.request("hello")).version).toBe(1);
  const listed = (await c2.request("proposals", { state: stored?.state })).proposals;
  expect(listed.map((x: any) => x.id)).toEqual([id]);
  const reply = await c2.request("apply_proposal", { id, by: "agent-ops" }, 30_000);
  expect(reply).toMatchObject({ version: 2, previous: 1, changed: true, proposal: id });
  expect((await c2.request("hello")).version).toBe(2);
  expect(readRegistryEntry(box.home, NAME)?.version).toBe(2);
  const applied = await c2.request("proposal", { id });
  expect(applied).toMatchObject({ state: "applied", applied_version: 2 });
  expect(applied.verification).toMatchObject({ replayed: 3, passed: 3, diverged: 0 });
  await expect(c2.request("apply_proposal", { id, by: "agent-ops" })).rejects.toThrow("already applied, as v2");

  // 5. New packets run on v2; every output exactly once, on the version that accepted it; exactly one v2, from the
  // proposal; the dry run's outcome recorded once (it ran again only when it had not committed).
  const later: string[] = [];
  for (let n = 10; n < 13; n++) later.push((await c2.request("push", { data: { n } })).packet_id);
  await waitFor(
    () => packets().length === 6 && packets().every((p) => p.state === "delivered"),
    20_000,
    "every packet delivered",
  );
  const final = packets();
  const version = new Map(final.map((r) => [r.id, r.version]));
  for (const p of before) expect(version.get(p)).toBe(1);
  for (const p of later) expect(version.get(p)).toBe(2);
  const written = items();
  expect(written.length).toBe(6);
  expect(new Set(written.map((i) => i.packet_id)).size).toBe(6);
  for (const i of written) expect(i.v).toBe(TAG[version.get(i.packet_id) as number] as string);
  expect(versions()).toEqual([
    { version: 1, author_kind: "human", proposal: null },
    { version: 2, author_kind: "agent", proposal: id },
  ]);
  expect(eventCount("proposal.verified")).toBe(1);
  expect(eventCount("proposal.rejected")).toBe(0);
  expect(eventCount("proposal.applied")).toBe(1);
  expect(eventCount("version.applied")).toBe(1);

  c2.close();
  second.proc.kill("SIGTERM");
  expect(await second.proc.exited).toBe(0);
}

describe("SIGKILL inside a proposal's dry run", () => {
  test(
    "after the replay, before its outcome commits: still validated; apply_proposal dry-runs it again and applies v2",
    () => scenario("dryrun.replayed"),
    90_000,
  );
  test(
    "just after the outcome commits, before the apply: verified; apply_proposal applies v2 without a second dry run",
    () => scenario("dryrun.decided"),
    90_000,
  );
});
