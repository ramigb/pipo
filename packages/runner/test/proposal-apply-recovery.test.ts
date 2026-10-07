// Applying a change proposal across SIGKILL (docs/spec.md §7.3, §9.3, D49). Spawned runners, found through their
// registry entry, stream pushed packets while an agent's proposal is applied over the socket, and die by SIGKILL at
// each point around the apply transaction: just before it (`apply.prepared`), inside it between the new version and
// the proposal's `applied` state (`apply.in_transaction`), just after its commit and before the in-memory switch and
// the reply (`apply.committed`, crashpoint.ts), and right after the reply. After each, the journal holds either v1
// with the proposal still applicable, or v2 with the proposal applied, never a mix; a restart runs that version, every
// packet finishes on the version that accepted it, outputs are written exactly once and no version is duplicated.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, Journal, Proposals, readRegistryEntry } from "../src";
import { sandbox, spawnRunner as spawn, waitFor } from "./helpers";

const boxes: ReturnType<typeof sandbox>[] = [];
const spawned: ReturnType<typeof Bun.spawn>[] = [];
const clients: ControlClient[] = [];
afterAll(() => {
  for (const c of clients) c.close();
  for (const p of spawned) p.kill("SIGKILL");
  for (const b of boxes) b.cleanup();
});

const NAME = "papply";
const SRC = (tag: string) => `pipo: 1
name: ${NAME}
fn: ./fns.ts
input: { via: push }
nodes:
  gate: { from: input, transform: fn.gate }
  tag: { from: gate, transform: fn.${tag} }
output:
  from: tag
  to: sqlite
  with: { path: ./${NAME}.db, table: items, create: true }
agent:
  control: true
  edit: [nodes.tag]
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

/** Push packets one after another until stopped (or the runner dies); `acked` are those the runner journaled. */
function stream(client: ControlClient) {
  const acked: string[] = [];
  let stopped = false;
  const done = (async () => {
    for (let n = 1000; !stopped; n++) {
      try {
        acked.push((await client.request("push", { data: { n, wait: false } })).packet_id as string);
      } catch {
        return;
      }
      await Bun.sleep(5);
    }
  })();
  return {
    acked,
    async stop() {
      stopped = true;
      await done;
      return acked;
    },
  };
}

type Point = "apply.prepared" | "apply.in_transaction" | "apply.committed" | null;

async function scenario(point: Point) {
  const box = sandbox();
  boxes.push(box);
  const release = join(box.root, "release");
  box.write(
    "fns.ts",
    `import { existsSync } from "node:fs";
export const gate = async (d) => { while (d.wait && !existsSync(${JSON.stringify(release)})) await Bun.sleep(20); return d; };
export const one = (d) => ({ ...d, v: "one" });
export const two = (d) => ({ ...d, v: "two" });
`,
  );
  const file = box.write(`${NAME}.pipo`, SRC("one"));
  const journal = join(box.home, "pipelines", NAME, "journal.db");
  const packets = () =>
    query(journal, "SELECT id, version, state, cursor FROM packets WHERE branch = '' ORDER BY id") as {
      id: string;
      version: number;
      state: string;
      cursor: string | null;
    }[];
  const versions = () =>
    query(journal, "SELECT version, author, author_kind, reason, proposal FROM versions ORDER BY version");
  const proposal = (id: string) =>
    query(journal, "SELECT state, applied_version FROM proposals WHERE id = ?", id)[0] as {
      state: string;
      applied_version: number | null;
    };
  const eventCount = (type: string) =>
    (query(journal, "SELECT COUNT(*) AS n FROM events WHERE type = ?", type)[0] as { n: number }).n;
  const connect = async () => {
    const c = await ControlClient.forPipeline(box.home, NAME);
    clients.push(c);
    return c;
  };

  // 1. v1 runs; three packets wait at the gate on v1.
  const env: Record<string, string> = point ? { PIPO_TEST_CRASH_AT: point } : {};
  const first = await spawn(box, spawned, NAME, file, 1, [], 15_000, env);
  const c1 = await connect();
  const gated: string[] = [];
  for (let n = 0; n < 3; n++) gated.push((await c1.request("push", { data: { n, wait: true } })).packet_id);
  await waitFor(
    () => packets().filter((p) => gated.includes(p.id) && p.cursor === "gate").length === 3,
    10_000,
    "gated packets at the gate",
  );

  // 2. An agent proposes v2. The store is used from this process, against the runner's journal (the control op to
  // propose is the engine's), while the runner writes nothing: its packets wait at the gate, the stream starts after.
  const store = new Journal(journal);
  const p = new Proposals(store, { pipeline: NAME, file, home: box.home }).propose({
    base_version: 1,
    source: SRC("two"),
    author: "agent-ops",
    author_kind: "agent",
    reason: "tag them two",
  });
  store.close();
  expect(p.state).toBe("validated");
  const pusher = stream(await connect());
  await waitFor(() => pusher.acked.length >= 3, 10_000, "streamed packets");
  const ackedBeforeApply = pusher.acked.length;
  let reply: any;
  let failure: Error | undefined;
  try {
    reply = await c1.request("apply_proposal", { id: p.id, by: "agent-ops" }, 15_000);
  } catch (e) {
    failure = e as Error;
  }
  const ackedAtReply = pusher.acked.length;
  if (point) {
    expect(reply).toBeUndefined();
    expect(failure?.message).toContain("closed the control connection");
  } else {
    expect(failure).toBeUndefined();
    expect(reply).toMatchObject({ version: 2, previous: 1, changed: true, proposal: p.id });
    expect(reply.pending_older).toBeGreaterThanOrEqual(3);
    await waitFor(() => pusher.acked.length >= ackedAtReply + 3, 10_000, "packets after the apply");
    first.proc.kill("SIGKILL");
  }
  await first.proc.exited;
  expect(first.proc.signalCode).toBe("SIGKILL");
  const acked = await pusher.stop();

  // 3. Right after the crash: all or nothing.
  const applied = point === null || point === "apply.committed";
  const rows = packets();
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of [...gated, ...acked]) expect(byId.has(id)).toBe(true);
  if (applied) {
    expect(versions()).toEqual([
      { version: 1, author: "human", author_kind: "human", reason: "first start", proposal: null },
      { version: 2, author: "agent-ops", author_kind: "agent", reason: "tag them two", proposal: p.id },
    ]);
    expect(proposal(p.id)).toEqual({ state: "applied", applied_version: 2 });
  } else {
    expect(versions().map((v) => v.version)).toEqual([1]);
    expect(proposal(p.id)).toEqual({ state: "validated", applied_version: null });
    expect(eventCount("version.applied") + eventCount("proposal.applied")).toBe(0);
  }
  for (const id of [...gated, ...acked.slice(0, ackedBeforeApply)]) expect(byId.get(id)?.version).toBe(1);
  if (point === null) {
    for (const id of acked.slice(ackedAtReply)) expect(byId.get(id)?.version).toBe(2);
  } else {
    // The switch to v2 comes after the commit with no await in between, so a runner killed at any crash point
    // accepted nothing on v2.
    expect(rows.every((r) => r.version === 1)).toBe(true);
  }

  // 4. Restart: the file is unchanged since the start, so the latest version runs (D38).
  const second = await spawn(box, spawned, NAME, file, 2, [], 15_000);
  const c2 = await connect();
  expect((await c2.request("hello")).version).toBe(applied ? 2 : 1);
  expect(readRegistryEntry(box.home, NAME)?.version).toBe(applied ? 2 : 1);
  if (applied) {
    await expect(c2.request("apply_proposal", { id: p.id, by: "agent-ops" })).rejects.toThrow("already applied, as v2");
  } else {
    // Still applicable: applying it now gives v2.
    expect(await c2.request("apply_proposal", { id: p.id, by: "agent-ops" })).toMatchObject({
      version: 2,
      previous: 1,
      proposal: p.id,
    });
  }
  const later: string[] = [];
  for (let n = 2000; n < 2003; n++) later.push((await c2.request("push", { data: { n, wait: false } })).packet_id);
  writeFileSync(release, "");
  await waitFor(() => packets().every((r) => r.state === "delivered"), 20_000, "every packet delivered");

  // 5. Exactly once, each on the version that accepted it; one v2, from the proposal, which is applied.
  const final = packets();
  for (const id of later) expect(final.find((r) => r.id === id)?.version).toBe(2);
  for (const id of gated) expect(final.find((r) => r.id === id)?.version).toBe(1);
  const items = query(join(box.root, `${NAME}.db`), "SELECT packet_id, v FROM items ORDER BY packet_id") as {
    packet_id: string;
    v: string;
  }[];
  expect(items.length).toBe(final.length);
  expect(new Set(items.map((i) => i.packet_id)).size).toBe(items.length);
  const version = new Map(final.map((r) => [r.id, r.version]));
  for (const i of items) expect(i.v).toBe(TAG[version.get(i.packet_id) as number] as string);
  for (const id of [...gated, ...acked, ...later]) expect(version.has(id)).toBe(true);
  expect(versions().map((v) => [v.version, v.proposal])).toEqual([
    [1, null],
    [2, p.id],
  ]);
  expect(proposal(p.id)).toEqual({ state: "applied", applied_version: 2 });
  expect(eventCount("version.applied")).toBe(1);
  expect(eventCount("proposal.applied")).toBe(1);

  c2.close();
  second.proc.kill("SIGTERM");
  expect(await second.proc.exited).toBe(0);
}

describe("SIGKILL around a proposal's apply", () => {
  test(
    "just before the transaction: v1 stays and the proposal is still applicable",
    () => scenario("apply.prepared"),
    90_000,
  );
  test("inside the transaction: nothing of it survives", () => scenario("apply.in_transaction"), 90_000);
  test(
    "just after the commit, before the switch and reply: v2 and the proposal applied",
    () => scenario("apply.committed"),
    90_000,
  );
  test(
    "right after the reply, packets streaming: v2 runs on restart, pinned packets finish on v1",
    () => scenario(null),
    90_000,
  );
});
