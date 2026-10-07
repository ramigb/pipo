// Stopping a crashed pipeline (docs/spec.md §7.2, §7.4, D27, D32, D46; ledger L-07), with real runner processes
// found through registry files: the stop settles it to `stopped`, removes its dead runner's entry and journals the
// stop the runner could not write, so neither this engine nor the next restarts it, a later start gets a full ttl,
// and a pause in force still outlives the crash.
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRegistryEntry, registryPath } from "@pipo/runner";
import { type SupervisedState, Supervisor } from "../src";
import { isRunning } from "../src/registry";
import { query, sandbox, testConfig, waitFor } from "./helpers";

const box = sandbox();
const engines: Supervisor[] = [];
const pids: number[] = [];
afterAll(async () => {
  for (const e of engines) {
    for (const r of e.list()) if (r.pid) pids.push(r.pid);
    await Promise.race([e.shutdown({ now: true }), Bun.sleep(10_000)]);
  }
  for (const pid of pids) if (isRunning(pid)) process.kill(pid, "SIGKILL");
  box.cleanup();
});

const pipelineFile = (name: string, lifetime = "") =>
  box.write(
    `${name}.pipo`,
    `pipo: 1
name: ${name}
input: { via: push }
output:
  from: input
  to: sqlite
  with: { path: ./${name}.db, table: items, create: true, columns: { packet_id: "\${meta.packet_id}", n: "\${data.n}" } }
${lifetime ? `lifetime: ${lifetime}\n` : ""}`,
  );

/** Crash once and the engine gives up (max_restarts: 0): the pipeline is `crashed`, its entry left behind. */
async function open(home: string) {
  const lines: string[] = [];
  const engine = await Supervisor.open({ home, config: testConfig({ max_restarts: 0 }), log: (l) => lines.push(l) });
  engines.push(engine);
  return { engine, lines };
}

const inState = (engine: Supervisor, name: string, state: SupervisedState) => () => {
  const r = engine.get(name);
  return r?.state === state ? r : null;
};

const journal = (home: string, name: string) => join(home, "pipelines", name, "journal.db");
/** Pipeline-level events of these types, oldest first. */
const pipelineEvents = (home: string, name: string, ...types: string[]) =>
  (
    (query(
      journal(home, name),
      `SELECT seq, type, at, detail FROM events WHERE packet_id IS NULL AND type IN (${types.map(() => "?").join(", ")}) ORDER BY seq`,
      ...types,
    ) ?? []) as { seq: number; type: string; at: number; detail: string | null }[]
  ).map((e) => ({ ...e, detail: e.detail === null ? null : JSON.parse(e.detail) }));
const starts = (home: string, name: string) => pipelineEvents(home, name, "pipeline.started").length;

/** Start, SIGKILL the runner, and wait until the engine gives up on it. Returns the dead runner's pid. */
async function crash(engine: Supervisor, home: string, name: string, file: string) {
  const up = await engine.start(file);
  const pid = up.pid as number;
  pids.push(pid);
  return { pid, up, kill: () => killed(engine, home, name, pid) };
}

async function killed(engine: Supervisor, home: string, name: string, pid: number) {
  process.kill(pid, "SIGKILL");
  await waitFor(inState(engine, name, "crashed"), 10_000, `${name} to be crashed`);
  // The crash left its entry naming the dead runner: that is what a scan or the next engine would restart from.
  expect(readRegistryEntry(home, name)?.pid).toBe(pid);
}

test("stop a crashed pipeline: its entry goes, the stop is journaled, a new engine restarts nothing, a pause stays", async () => {
  const home = join(box.root, "crashed");
  const NAME = "crashed";
  const file = pipelineFile(NAME);
  const { engine, lines } = await open(home);
  const { pid, kill } = await crash(engine, home, NAME, file);
  expect(await engine.pause(NAME, "agent")).toMatchObject({ state: "paused" });
  const held = (await engine.request<{ packet_id: string }>(NAME, "push", { data: { n: 1 } })).packet_id;
  await kill();
  const saved = readFileSync(registryPath(home, NAME), "utf8");

  const stopped = await engine.stop(NAME);
  expect(stopped).toMatchObject({ state: "stopped", pid: null, next_restart_at: null, error: null });
  expect(readRegistryEntry(home, NAME)).toBeNull();
  expect(existsSync(join(home, "run", `${NAME}.sock`))).toBe(false);
  expect(lines.join("\n")).toContain(`removed the stale registry entry of '${NAME}' (pid ${pid} is gone)`);
  // The runner never journaled its end; the engine did, once it was dead, and kept the pause in force (D32).
  const ends = pipelineEvents(home, NAME, "pipeline.started", "pipeline.stopped", "pipeline.paused");
  expect(ends.map((e) => e.type)).toEqual([
    "pipeline.started",
    "pipeline.paused",
    "pipeline.stopped",
    "pipeline.paused",
  ]);
  expect(ends[2]?.detail).toMatchObject({ reason: "crashed", by: engine.engineId });
  expect(ends[3]?.detail).toEqual(ends[1]?.detail);
  // Stopped stays stopped in this engine: a rescan restarts nothing, and stopping again changes nothing.
  expect(await engine.attach()).toEqual([]);
  expect(await engine.stop(NAME)).toMatchObject({ state: "stopped" });
  expect(pipelineEvents(home, NAME, "pipeline.stopped")).toHaveLength(1);
  await engine.shutdown();

  // A new engine on the same home restarts nothing.
  const next = await open(home);
  expect(next.engine.get(NAME)).toBeUndefined();
  await Bun.sleep(800);
  expect(readRegistryEntry(home, NAME)).toBeNull();
  expect(starts(home, NAME)).toBe(1);
  await next.engine.shutdown();

  // As if the engine had died after journaling the stop, before removing the entry: the next one still sees a stop.
  writeFileSync(registryPath(home, NAME), saved);
  const third = await open(home);
  expect(third.engine.get(NAME)).toMatchObject({ state: "stopped", pid: null });
  expect(third.lines.join("\n")).toContain(`'${NAME}' had stopped cleanly before its runner (pid ${pid}) died`);
  expect(readRegistryEntry(home, NAME)).toBeNull();
  await Bun.sleep(500);
  expect(starts(home, NAME)).toBe(1);

  // Started again, it comes back paused with its reason, and the held packet is delivered once on resume.
  const again = await third.engine.start(file);
  pids.push(again.pid as number);
  expect(await third.engine.request(NAME, "status")).toMatchObject({ state: "paused", paused_reason: "agent" });
  await third.engine.resume(NAME);
  await waitFor(
    () => query(journal(home, NAME), "SELECT state FROM packets WHERE id = ?", held)?.[0]?.state === "delivered",
    10_000,
    "held packet delivered",
  );
  expect(query(join(box.root, `${NAME}.db`), "SELECT packet_id FROM items")).toEqual([{ packet_id: held }]);
  await third.engine.shutdown();
}, 90_000);

test("stop a crashed ttl pipeline after its ttl would have run out: the next start gets a full ttl", async () => {
  const home = join(box.root, "ttl");
  const NAME = "ttl";
  const TTL = 2000;
  const file = pipelineFile(NAME, "{ ttl: 2s }");
  const { engine } = await open(home);
  const { kill } = await crash(engine, home, NAME, file);
  const [first] = pipelineEvents(home, NAME, "pipeline.started");
  if (!first) throw new Error("no pipeline.started");
  await kill();
  // Past the first run's ttl: a start anchored to it would drain at once.
  await Bun.sleep(Math.max(0, first.at + TTL + 300 - Date.now()));
  expect(await engine.stop(NAME)).toMatchObject({ state: "stopped" });

  const again = await engine.start(file);
  pids.push(again.pid as number);
  const started = pipelineEvents(home, NAME, "pipeline.started");
  expect(started).toHaveLength(2);
  const second = started[1] as { seq: number; at: number };
  await waitFor(inState(engine, NAME, "stopped"), 15_000, `${NAME} to end its ttl`);
  const draining = pipelineEvents(home, NAME, "pipeline.draining").filter((e) => e.seq > second.seq);
  expect(draining).toHaveLength(1);
  const after = (draining[0] as { at: number }).at - second.at;
  expect(after).toBeGreaterThanOrEqual(TTL - 50);
  expect(after).toBeLessThan(TTL + 750);
  // It ended on its own (its own clean stop), and left nothing behind.
  expect(pipelineEvents(home, NAME, "pipeline.stopped").map((e) => e.detail)).toEqual([
    { reason: "crashed", by: engine.engineId },
    null,
  ]);
  expect(readRegistryEntry(home, NAME)).toBeNull();
  await engine.shutdown();
}, 60_000);
