// A pause outlives a crash (docs/spec.md §2.2, §7.3, D32), with real runner processes found through their registry
// entry and logging to files: a paused runner SIGKILLed with packets accepted while paused comes back paused with the
// same reason, moves none of them (not even before its input is up) until resumed, and then delivers each exactly
// once. Restored pauses survive a second crash; a clean stop ends a pause; an `error at <step>` hold comes back held.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
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

const MARKER = join(box.root, "down.marker");
box.write(
  "fns.ts",
  `import { existsSync } from "node:fs";
export const flaky = (d) => { if (existsSync(${JSON.stringify(MARKER)})) throw new Error("service down"); return d; };
`,
);

const pipeline = (name: string, onError = "{ retry: 0, then: dead_letter }") => `pipo: 1
name: ${name}
fn: ./fns.ts
input: { via: push }
nodes:
  flaky: { from: input, transform: fn.flaky, on_error: ${onError} }
output:
  from: flaky
  to: sqlite
  with: { path: ./${name}.db, table: items, create: true, columns: { packet_id: "\${meta.packet_id}", n: "\${data.n}" } }
`;

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
const stateOf = (name: string, id: string) =>
  query(journal(name), "SELECT state FROM packets WHERE id = ?", id)?.[0]?.state as string | undefined;
/** Every event of a packet, oldest first. */
const typesOf = (name: string, id: string) =>
  (query(journal(name), "SELECT type FROM events WHERE packet_id = ? ORDER BY seq", id) ?? []).map((r) => r.type);
const written = (name: string) =>
  (query(join(box.root, `${name}.db`), "SELECT packet_id FROM items") ?? []).map((r) => r.packet_id as string);

async function start(name: string, n: number) {
  const runner = await spawn(box, spawned, name, join(box.root, `${name}.pipo`), n, [], 15_000);
  expect(readRegistryEntry(box.home, name)?.pid).toBe(runner.proc.pid);
  const client = await ControlClient.forPipeline(box.home, name);
  clients.push(client);
  return { ...runner, client };
}

async function kill(r: { proc: ReturnType<typeof Bun.spawn>; client: ControlClient }) {
  r.client.close();
  r.proc.kill("SIGKILL");
  await r.proc.exited;
}

async function push(client: ControlClient, from: number, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let n = from; n < from + count; n++) ids.push((await client.request("push", { data: { n } })).packet_id);
  return ids;
}

function exactlyOnce(name: string, ids: string[]) {
  expect(written(name).sort()).toEqual([...ids].sort());
  for (const id of ids) expect(typesOf(name, id).filter((t) => t === "packet.delivered")).toHaveLength(1);
}

test("SIGKILL a paused runner: the reopened runner is paused with the same reason and delivers nothing until resume", async () => {
  const NAME = "paused";
  box.write(`${NAME}.pipo`, pipeline(NAME));

  // 1. Three delivered while active; paused by an agent; five more accepted into the journal while paused.
  const first = await start(NAME, 1);
  const early = await push(first.client, 0, 3);
  await waitFor(() => early.every((id) => stateOf(NAME, id) === "delivered"), 10_000, "early packets delivered");
  expect(await first.client.request("pause", { reason: "agent" })).toMatchObject({ state: "paused" });
  const held = await push(first.client, 3, 5);
  await Bun.sleep(300);
  expect(held.map((id) => stateOf(NAME, id))).toEqual(Array(5).fill("accepted"));
  await kill(first);
  expect(readRegistryEntry(box.home, NAME)).toMatchObject({ pid: first.proc.pid, state: "paused" });

  // 2. The next runner takes the pause over from the journal before any worker runs.
  const second = await start(NAME, 2);
  expect(readRegistryEntry(box.home, NAME)?.state).toBe("paused");
  expect(await second.client.request("status")).toMatchObject({ state: "paused", paused_reason: "agent" });
  // Intake still journals while paused (§2.2); nothing moves.
  const more = await push(second.client, 8, 2);
  await Bun.sleep(1000);
  for (const id of [...held, ...more]) expect(typesOf(NAME, id)).toEqual(["packet.accepted"]);
  expect(written(NAME).sort()).toEqual([...early].sort());

  // 3. A restored pause survives another crash, the same way.
  await kill(second);
  const third = await start(NAME, 3);
  expect(await third.client.request("status")).toMatchObject({ state: "paused", paused_reason: "agent" });
  await Bun.sleep(500);
  for (const id of [...held, ...more]) expect(typesOf(NAME, id)).toEqual(["packet.accepted"]);

  // 4. Resume delivers the backlog, each packet exactly once.
  expect(await third.client.request("resume")).toMatchObject({ state: "active" });
  const all = [...early, ...held, ...more];
  await waitFor(() => all.every((id) => stateOf(NAME, id) === "delivered"), 15_000, "backlog delivered");
  exactlyOnce(NAME, all);

  // 5. A clean stop ends the pause: paused again, stopped over the socket, the next run is active.
  await third.client.request("pause", { reason: "manual" });
  expect(await third.client.request("stop")).toEqual({ state: "stopping" });
  expect(await third.proc.exited).toBe(0);
  const fourth = await start(NAME, 4);
  expect(await fourth.client.request("status")).toMatchObject({ state: "active", paused_reason: null });
  const last = await push(fourth.client, 10, 1);
  await waitFor(() => stateOf(NAME, last[0] as string) === "delivered", 10_000, "packet after a clean stop");
  exactlyOnce(NAME, [...all, ...last]);
  expect(await fourth.client.request("stop")).toEqual({ state: "stopping" });
  expect(await fourth.proc.exited).toBe(0);

  // The journal tells the story: each restored pause is journaled after its run started.
  const restored = query(
    journal(NAME),
    "SELECT detail FROM events WHERE type = 'pipeline.paused' AND packet_id IS NULL ORDER BY seq",
  )?.map((r) => JSON.parse(r.detail));
  expect(restored).toEqual([
    { reason: "agent" },
    { reason: "agent", restored: true },
    { reason: "agent", restored: true },
    { reason: "manual" },
  ]);
}, 120_000);

test("SIGKILL while held by `then: pause`: the reopened runner stays held at that step until resume", async () => {
  const NAME = "held";
  box.write(`${NAME}.pipo`, pipeline(NAME, "{ retry: 0, then: pause }"));
  writeFileSync(MARKER, "");
  try {
    const first = await start(NAME, 1);
    const [failing] = await push(first.client, 0, 1);
    await waitFor(
      async () => (await first.client.request("status")).state === "paused",
      10_000,
      "pause after the failure",
    );
    const queued = await push(first.client, 1, 2);
    await kill(first);
    expect(typesOf(NAME, failing as string).filter((t) => t === "packet.held")).toHaveLength(1);

    // Still failing: if the reopened runner touched the held packet at all, it would be held a second time.
    const second = await start(NAME, 2);
    expect(await second.client.request("status")).toMatchObject({ state: "paused", paused_reason: "error at flaky" });
    await Bun.sleep(1000);
    expect(typesOf(NAME, failing as string).filter((t) => t === "packet.held")).toHaveLength(1);
    for (const id of queued) expect(typesOf(NAME, id)).toEqual(["packet.accepted"]);

    // The service is back: resume, and all three are delivered once.
    rmSync(MARKER, { force: true });
    await second.client.request("resume");
    const all = [failing as string, ...queued];
    await waitFor(() => all.every((id) => stateOf(NAME, id) === "delivered"), 15_000, "all delivered");
    exactlyOnce(NAME, all);
    second.proc.kill("SIGTERM");
    expect(await second.proc.exited).toBe(0);
  } finally {
    rmSync(MARKER, { force: true });
  }
}, 120_000);
