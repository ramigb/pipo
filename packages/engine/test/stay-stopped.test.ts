// A stopped pipeline stays stopped (docs/spec.md §7.2, D25, D27, D46), with real runner processes found through
// registry files: a stop during a restart backoff, or one that had to SIGKILL its runner after stop_timeout, leaves no
// entry for the next scan or engine to restart, and the stop the runner could not write is journaled. A dead entry
// whose run journaled its clean stop is not restarted either; one whose run started after that stop still is.
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, readRegistryEntry, registryPath } from "@pipo/runner";
import { type SupervisedState, Supervisor } from "../src";
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

box.write("fns.ts", "export const stuck = async (d) => { await Bun.sleep(30_000); return d; };\n");
const pipelineFile = (name: string, node = "") =>
  box.write(
    `${name}.pipo`,
    `pipo: 1
name: ${name}
fn: ./fns.ts
concurrency: 1
input: { via: push }
${node ? `nodes:\n  ${node}\n` : ""}output:
  from: ${node ? node.split(":")[0] : "input"}
  to: sqlite
  with: { path: ./${name}.db, table: items, create: true, columns: { packet_id: "\${meta.packet_id}", n: "\${data.n}" } }
`,
  );

async function open(home: string, config = testConfig()) {
  const lines: string[] = [];
  const engine = await Supervisor.open({ home, config, log: (l) => lines.push(l) });
  engines.push(engine);
  return { engine, lines };
}

const inState = (engine: Supervisor, name: string, state: SupervisedState) => () => {
  const r = engine.get(name);
  return r?.state === state ? r : null;
};

const journal = (home: string, name: string) => join(home, "pipelines", name, "journal.db");
/** The last pipeline start or stop in the journal, with its detail. */
const lastEnd = (home: string, name: string) => {
  const row = query(
    journal(home, name),
    "SELECT type, detail FROM events WHERE packet_id IS NULL AND type IN ('pipeline.started', 'pipeline.stopped') ORDER BY seq DESC LIMIT 1",
  )?.[0];
  return row && { type: row.type, detail: row.detail === null ? null : JSON.parse(row.detail) };
};
const starts = (home: string, name: string) =>
  query(journal(home, name), "SELECT COUNT(*) AS n FROM events WHERE type = 'pipeline.started'")?.[0]?.n as number;

/** A new engine on the same home finds nothing to restart, and after a while still no runner came up. */
async function nothingRestarts(home: string, name: string) {
  const before = starts(home, name);
  const { engine, lines } = await open(home);
  expect(engine.get(name)).toBeUndefined();
  expect(lines.join("\n")).not.toContain("restarting it from");
  await Bun.sleep(800);
  expect(readRegistryEntry(home, name)).toBeNull();
  expect(starts(home, name)).toBe(before);
  await engine.shutdown();
}

test("stop during a restart backoff: the dead runner's entry goes, and a new engine restarts nothing", async () => {
  const home = join(box.root, "backoff");
  const NAME = "backoff";
  const file = pipelineFile(NAME);
  const { engine, lines } = await open(home, testConfig({ backoff: 10_000, max_backoff: 10_000 }));
  const up = await engine.start(file);
  const pid = up.pid as number;
  pids.push(pid);
  process.kill(pid, "SIGKILL");
  await waitFor(inState(engine, NAME, "backoff"), 5000, "backoff");
  // The crash left its entry: that is what a scan would restart from.
  expect(readRegistryEntry(home, NAME)?.pid).toBe(pid);

  const stopped = await engine.stop(NAME);
  expect(stopped).toMatchObject({ state: "stopped", pid: null, next_restart_at: null });
  expect(readRegistryEntry(home, NAME)).toBeNull();
  expect(existsSync(join(home, "run", `${NAME}.sock`))).toBe(false);
  expect(lines.join("\n")).toContain(`removed the stale registry entry of '${NAME}' (pid ${pid} is gone)`);
  // The crashed run never journaled its end; the deliberate stop did (D46), so the next start gets a fresh ttl.
  expect(lastEnd(home, NAME)).toEqual({ type: "pipeline.stopped", detail: { reason: "crashed", by: engine.engineId } });
  // A rescan by the same engine restarts nothing, and the cancelled backoff never fires.
  expect(await engine.attach()).toEqual([]);
  await Bun.sleep(300);
  expect(engine.get(NAME)?.state).toBe("stopped");
  await engine.shutdown();

  await nothingRestarts(home, NAME);
}, 60_000);

test("stop that falls back to SIGKILL after stop_timeout: nothing restarts, in this engine or the next", async () => {
  const home = join(box.root, "killed");
  const NAME = "killed";
  const file = pipelineFile(NAME, "stuck: { from: input, transform: fn.stuck }");
  // The runner's own stop waits up to 1 s for its busy worker; the engine kills it long before that.
  const { engine, lines } = await open(home, { ...testConfig(), stop_timeout: 150 });
  const up = await engine.start(file);
  const pid = up.pid as number;
  pids.push(pid);
  await engine.request(NAME, "push", { data: { n: 1 } });
  await Bun.sleep(300); // the worker is inside fn.stuck now

  const stopped = await engine.stop(NAME, { now: true });
  expect(stopped.state).toBe("stopped");
  expect(stopped.last_exit?.signal).toBe("SIGKILL");
  expect(lines.join("\n")).toContain(`'${NAME}' did not exit within`);
  expect(isRunning(pid)).toBe(false);
  // Killed, so the run never journaled its stop: the engine did once it was dead (D46), and its entry is gone.
  expect(lastEnd(home, NAME)).toEqual({ type: "pipeline.stopped", detail: { reason: "killed", by: engine.engineId } });
  expect(readRegistryEntry(home, NAME)).toBeNull();
  expect(await engine.attach()).toEqual([]);
  await engine.shutdown();

  await nothingRestarts(home, NAME);
}, 60_000);

test("a dead entry whose run journaled a clean stop is removed, not restarted; an entry from a later run restarts", async () => {
  const home = join(box.root, "clean");
  const NAME = "clean";
  const file = pipelineFile(NAME);
  const { proc, entry } = await spawnRunner(box.root, spawned, home, NAME, file);
  const saved = readFileSync(registryPath(home, NAME), "utf8");
  const client = await ControlClient.connect(entry.socket as string);
  await client.request("stop");
  client.close();
  expect(await proc.exited).toBe(0);
  expect(readRegistryEntry(home, NAME)).toBeNull();

  // As if the runner had been killed after journaling its stop, before removing its entry.
  writeFileSync(registryPath(home, NAME), saved);
  const { engine, lines } = await open(home);
  expect(engine.get(NAME)).toMatchObject({ state: "stopped", pid: null });
  expect(lines.join("\n")).toContain(`'${NAME}' had stopped cleanly before its runner (pid ${entry.pid}) died`);
  expect(readRegistryEntry(home, NAME)).toBeNull();
  expect(starts(home, NAME)).toBe(1);
  await engine.shutdown();

  // An entry whose run started after that stop (killed before it journaled anything) did not stop cleanly.
  const later = { ...JSON.parse(saved), started_at: new Date(Date.now() + 1000).toISOString() };
  writeFileSync(registryPath(home, NAME), JSON.stringify(later));
  const next = await open(home);
  expect(next.engine.get(NAME)).toMatchObject({ state: "running", restarts: 1 });
  expect(starts(home, NAME)).toBe(2);
  await next.engine.shutdown();
  expect(readRegistryEntry(home, NAME)).toBeNull();
}, 60_000);
