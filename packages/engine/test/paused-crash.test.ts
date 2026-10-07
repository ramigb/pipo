// A paused pipeline stays paused across runner crashes (docs/spec.md §2.2, §7.2, D27, D32), with real runner
// processes found through registry files: the same engine relaunching a crashed child, an engine adopting a paused
// runner and relaunching it after a SIGKILL, and a new engine restarting a dead paused runner all bring it back
// paused with its original reason (not the engine's `manual`), and no packet accepted while paused moves until resume.
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { ControlClient, readRegistryEntry } from "@pipo/runner";
import { type RunnerInfo, Supervisor } from "../src";
import { isRunning } from "../src/registry";
import { query, sandbox, spawnRunner, testConfig, waitFor } from "./helpers";

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
const engines: Supervisor[] = [];
const pids: number[] = [];
afterAll(async () => {
  for (const e of engines) {
    for (const r of e.list()) if (r.pid) pids.push(r.pid);
    await Promise.race([e.shutdown({ now: true }), Bun.sleep(10_000)]);
  }
  for (const pid of pids) if (isRunning(pid)) process.kill(pid, "SIGKILL");
  for (const p of spawned) p.kill("SIGKILL");
  box.cleanup();
});

const pipelineFile = (name: string) =>
  box.write(
    `${name}.pipo`,
    `pipo: 1
name: ${name}
input: { via: push }
nodes:
  shape: { from: input, transform: map, with: { data: { n: "\${data.n}" } } }
output:
  from: shape
  to: sqlite
  with: { path: ./${name}.db, table: items, create: true, columns: { packet_id: "\${meta.packet_id}", n: "\${data.n}" } }
`,
  );

async function open(home: string) {
  const lines: string[] = [];
  const engine = await Supervisor.open({ home, config: testConfig({ backoff: 100 }), log: (l) => lines.push(l) });
  engines.push(engine);
  return { engine, lines };
}

const journal = (home: string, name: string) => join(home, "pipelines", name, "journal.db");
const typesOf = (home: string, name: string, id: string) =>
  (query(journal(home, name), "SELECT type FROM events WHERE packet_id = ? ORDER BY seq", id) ?? []).map((r) => r.type);
const delivered = (home: string, name: string, ids: string[]) =>
  ids.every(
    (id) => query(journal(home, name), "SELECT state FROM packets WHERE id = ?", id)?.[0]?.state === "delivered",
  );

/** Every id written once to the sqlite output and delivered once in the journal. */
function exactlyOnce(home: string, name: string, ids: string[]) {
  const written = query(join(box.root, `${name}.db`), "SELECT packet_id FROM items") ?? [];
  expect(written.map((r) => r.packet_id).sort()).toEqual([...ids].sort());
  for (const id of ids) expect(typesOf(home, name, id).filter((t) => t === "packet.delivered")).toHaveLength(1);
}

/** The relaunched runner (a new pid), once it answers. */
const relaunched = (engine: Supervisor, name: string, old: number) => () => {
  const r = engine.get(name);
  return r?.state === "running" && r.pid && r.pid !== old ? r : null;
};

/** Paused with `reason`, as the runner and its registry entry say, and the held packets untouched. */
async function stillPaused(engine: Supervisor, home: string, name: string, reason: string, held: string[]) {
  expect(engine.get(name)?.status).toBe("paused");
  expect(readRegistryEntry(home, name)?.state).toBe("paused");
  expect(await engine.request(name, "status")).toMatchObject({ state: "paused", paused_reason: reason });
  await Bun.sleep(800);
  for (const id of held) expect(typesOf(home, name, id)).toEqual(["packet.accepted"]);
}

async function pushAll(engine: Supervisor, name: string, from: number, count: number) {
  const ids: string[] = [];
  for (let n = from; n < from + count; n++)
    ids.push((await engine.request<{ packet_id: string }>(name, "push", { data: { n } })).packet_id);
  return ids;
}

test("a paused pipeline's runner crashes: the same engine relaunches it paused, with its reason", async () => {
  const home = join(box.root, "same");
  const NAME = "same";
  const { engine, lines } = await open(home);
  const up = await engine.start(pipelineFile(NAME));
  const early = await pushAll(engine, NAME, 0, 2);
  await waitFor(() => delivered(home, NAME, early), 10_000, "early packets");
  expect(await engine.pause(NAME, "agent")).toMatchObject({ state: "paused", already: false });
  const held = await pushAll(engine, NAME, 2, 4);

  process.kill(up.pid as number, "SIGKILL");
  const again = (await waitFor(relaunched(engine, NAME, up.pid as number), 20_000, "relaunch")) as RunnerInfo;
  pids.push(again.pid as number);
  expect(again).toMatchObject({ adopted: false, restarts: 1 });
  await stillPaused(engine, home, NAME, "agent", held);
  expect(lines.join("\n")).not.toContain("paused again");

  expect(await engine.resume(NAME)).toMatchObject({ state: "active" });
  await waitFor(() => delivered(home, NAME, [...early, ...held]), 15_000, "backlog delivered");
  exactlyOnce(home, NAME, [...early, ...held]);
  await engine.shutdown();
  expect(readRegistryEntry(home, NAME)).toBeNull();
}, 90_000);

test("a new engine adopts a paused runner, and relaunches it paused after a SIGKILL", async () => {
  const home = join(box.root, "adopted");
  const NAME = "adopted";
  const { proc, entry } = await spawnRunner(box.root, spawned, home, NAME, pipelineFile(NAME));
  const client = await ControlClient.connect(entry.socket as string);
  await client.request("pause", { reason: "agent" });
  const held: string[] = [];
  for (let n = 0; n < 3; n++) held.push((await client.request("push", { data: { n } })).packet_id);
  client.close();

  const { engine } = await open(home);
  expect(engine.get(NAME)).toMatchObject({ state: "running", adopted: true, pid: entry.pid, status: "paused" });
  await stillPaused(engine, home, NAME, "agent", held);

  proc.kill("SIGKILL");
  const again = (await waitFor(relaunched(engine, NAME, entry.pid), 20_000, "relaunch")) as RunnerInfo;
  pids.push(again.pid as number);
  expect(again.adopted).toBe(false);
  await stillPaused(engine, home, NAME, "agent", held);

  await engine.resume(NAME);
  await waitFor(() => delivered(home, NAME, held), 15_000, "backlog delivered");
  exactlyOnce(home, NAME, held);
  await engine.shutdown();
}, 90_000);

test("a paused runner that died while no engine ran: the next engine restarts it paused, with its reason", async () => {
  const home = join(box.root, "dead");
  const NAME = "dead";
  const { proc, entry } = await spawnRunner(box.root, spawned, home, NAME, pipelineFile(NAME));
  const client = await ControlClient.connect(entry.socket as string);
  await client.request("pause", { reason: "agent" });
  const held: string[] = [];
  for (let n = 0; n < 3; n++) held.push((await client.request("push", { data: { n } })).packet_id);
  client.close();
  proc.kill("SIGKILL");
  await proc.exited;
  expect(readRegistryEntry(home, NAME)).toMatchObject({ pid: entry.pid, state: "paused" });

  const { engine, lines } = await open(home);
  const info = engine.get(NAME) as RunnerInfo;
  pids.push(info.pid as number);
  expect(info).toMatchObject({ state: "running", adopted: false, restarts: 1 });
  expect(info.pid).not.toBe(entry.pid);
  expect(lines.join("\n")).toContain(`'${NAME}' was paused but its runner (pid ${entry.pid}) is gone`);
  // The runner took the pause over itself: the engine's old `manual` re-pause would have lost `agent`.
  await stillPaused(engine, home, NAME, "agent", held);

  await engine.resume(NAME);
  await waitFor(() => delivered(home, NAME, held), 15_000, "backlog delivered");
  exactlyOnce(home, NAME, held);
  await engine.shutdown();
}, 90_000);
