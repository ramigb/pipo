// Discovery and reattach (docs/spec.md §7.2, D25, D27) with real processes found through registry files: a stale
// entry (dead runner) is restarted from its file and its journal delivers every packet exactly once; an adopted
// runner killed with SIGKILL is noticed by polling and restarted; a live runner that doesn't answer is left alone;
// a reused pid, or a file that is gone, is not mistaken for a runner.
import { afterAll, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, readRegistryEntry } from "@pipo/runner";
import { type EngineEvent, readCursor, type SupervisedState, Supervisor } from "../src";
import { isRunning } from "../src/registry";
import { query, sandbox, spawnRunner, testConfig, waitFor } from "./helpers";

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
const engines: Supervisor[] = [];
afterAll(async () => {
  for (const e of engines) {
    const pids = e.list().flatMap((r) => (r.pid && r.state !== "unreachable" ? [r.pid] : []));
    await Promise.race([e.shutdown({ now: true }), Bun.sleep(10_000)]);
    for (const pid of pids) if (isRunning(pid)) process.kill(pid, "SIGKILL");
  }
  for (const p of spawned) p.kill("SIGKILL");
  box.cleanup();
});

box.write("fns.ts", "export const slow = async (d) => { await new Promise((r) => setTimeout(r, 80)); return d; };\n");
const slowPipeline = (name: string) =>
  box.write(
    `${name}.pipo`,
    `pipo: 1
name: ${name}
fn: ./fns.ts
concurrency: 2
input: { via: push }
nodes:
  slow: { from: input, transform: fn.slow }
output:
  from: slow
  to: sqlite
  with: { path: ./${name}.db, table: items, create: true, columns: { packet_id: "\${meta.packet_id}", n: "\${data.n}" } }
delivered:
  check: record_exists
  with: { where: { packet_id: "\${meta.packet_id}" } }
`,
  );

async function open(home: string, events?: EngineEvent[]) {
  const lines: string[] = [];
  const engine = await Supervisor.open({
    home,
    config: testConfig({ backoff: 300 }),
    log: (l) => lines.push(l),
    onEvent: events && ((e) => events.push(e)),
  });
  engines.push(engine);
  return { engine, lines };
}

const journal = (home: string, name: string) => join(home, "pipelines", name, "journal.db");
const states = (home: string, name: string): Record<string, number> =>
  Object.fromEntries(
    (query(journal(home, name), "SELECT state, COUNT(*) AS n FROM packets GROUP BY state") ?? []).map((r) => [
      r.state,
      r.n,
    ]),
  );

/** Every pushed packet written once to the sqlite output and delivered once in the journal. */
function exactlyOnce(home: string, name: string, ids: string[]) {
  const written = query(join(box.root, `${name}.db`), "SELECT packet_id FROM items") ?? [];
  expect(written.map((r) => r.packet_id).sort()).toEqual([...ids].sort());
  const delivered =
    query(
      journal(home, name),
      "SELECT packet_id, COUNT(*) AS n FROM events WHERE type = 'packet.delivered' GROUP BY packet_id",
    ) ?? [];
  expect(delivered).toHaveLength(ids.length);
  expect(delivered.every((r) => r.n === 1)).toBe(true);
}

const inState = (engine: Supervisor, name: string, state: SupervisedState) => () => {
  const r = engine.get(name);
  return r?.state === state ? r : null;
};

/** Push `n` packets straight to the runner's socket (no engine), returning their ids. */
async function push(socket: string, n: number): Promise<string[]> {
  const client = await ControlClient.connect(socket);
  try {
    const ids: string[] = [];
    for (let i = 0; i < n; i++)
      ids.push((await client.request<{ packet_id: string }>("push", { data: { n: i } })).packet_id);
    return ids;
  } finally {
    client.close();
  }
}

test("a stale entry (runner SIGKILLed with packets in flight) is restarted by name and every packet is delivered once", async () => {
  const home = join(box.root, "stale");
  const file = slowPipeline("stale");
  const { proc, entry } = await spawnRunner(box.root, spawned, home, "stale", file);
  const ids = await push(entry.socket as string, 20);
  proc.kill("SIGKILL");
  await proc.exited;
  const before = states(home, "stale");
  expect(before.delivered ?? 0).toBeLessThan(20); // the kill really interrupted work
  expect(Object.values(before).reduce((a, b) => a + b, 0)).toBe(20); // every accepted packet is journaled
  // The entry is left behind: that is how the engine knows it never stopped cleanly.
  expect(readRegistryEntry(home, "stale")).toMatchObject({ pid: entry.pid, state: "active" });
  expect(existsSync(entry.socket as string)).toBe(true);

  const events: EngineEvent[] = [];
  const { engine, lines } = await open(home, events);
  const info = engine.get("stale");
  expect(info).toMatchObject({ state: "running", adopted: false, restarts: 1, file });
  expect(info?.pid).not.toBe(entry.pid);
  // The stale entry is replaced by the new runner's, started by this engine from the file the entry named.
  expect(readRegistryEntry(home, "stale")).toMatchObject({ pid: info?.pid, engine_id: engine.engineId });
  expect(lines.join("\n")).toContain(
    `'stale' was active but its runner (pid ${entry.pid}) is gone without a clean stop`,
  );

  await waitFor(() => states(home, "stale").delivered === 20, 20_000, "all packets delivered");
  exactlyOnce(home, "stale", ids);
  // The engine never streamed this pipeline before, so its stream starts at the journal's first event.
  await waitFor(
    () => engine.eventCursor("stale") === query(journal(home, "stale"), "SELECT MAX(seq) AS n FROM events")?.[0]?.n,
    10_000,
    "events",
  );
  expect(events.map((e) => e.seq)).toEqual(Array.from({ length: events.length }, (_, i) => i + 1));
  expect(readCursor(home, "stale")).toBe(events.length);

  await engine.shutdown();
  expect(readRegistryEntry(home, "stale")).toBeNull();
}, 120_000);

test("an adopted runner killed with SIGKILL is noticed by polling, restarted with backoff, and loses nothing", async () => {
  const home = join(box.root, "adopted");
  const file = slowPipeline("adopted");
  const { entry } = await spawnRunner(box.root, spawned, home, "adopted", file);
  const { engine, lines } = await open(home);
  expect(engine.get("adopted")).toMatchObject({ state: "running", adopted: true, pid: entry.pid });

  const ids: string[] = [];
  for (let n = 0; n < 10; n++) {
    ids.push((await engine.request<{ packet_id: string }>("adopted", "push", { data: { n } })).packet_id);
  }
  process.kill(entry.pid, "SIGKILL");
  const backoff = await waitFor(inState(engine, "adopted", "backoff"), 5000, "backoff");
  // Not its child: the exit status is unknown, but the entry left behind says it did not stop cleanly.
  expect(backoff.last_exit).toMatchObject({ code: null, signal: null });
  expect(lines.join("\n")).toContain(`'adopted' (pid ${entry.pid}, adopted) died without a clean stop; restarting in`);

  const again = await waitFor(
    () => {
      const r = engine.get("adopted");
      return r?.state === "running" && r.pid !== entry.pid ? r : null;
    },
    40_000,
    "restarted runner",
  );
  expect(again).toMatchObject({ adopted: false, restarts: 1 });
  expect(readRegistryEntry(home, "adopted")).toMatchObject({ pid: again.pid, engine_id: engine.engineId });
  await waitFor(() => states(home, "adopted").delivered === 10, 20_000, "all packets delivered");
  exactlyOnce(home, "adopted", ids);
  await engine.shutdown();
}, 120_000);

test("a live runner that doesn't answer is left alone as unreachable; a reused pid or a missing file is not a runner", async () => {
  const home = join(box.root, "odd");
  const run = join(home, "run");
  const sleeper = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  spawned.push(sleeper);
  const now = new Date().toISOString();
  const entry = (name: string, startedAt: string, file: string) => ({
    pipeline: name,
    version: 1,
    pid: sleeper.pid,
    socket: join(run, `${name}.sock`),
    file,
    listen: null,
    detached: false,
    state: "active",
    started_at: startedAt,
  });
  await Bun.write(join(run, "mute.json"), JSON.stringify(entry("mute", now, join(box.root, "gone.pipo"))));
  // Registered long before the process holding its pid started: the runner is gone and the pid was reused.
  await Bun.write(
    join(run, "reused.json"),
    JSON.stringify(entry("reused", "2020-01-01T00:00:00.000Z", join(box.root, "gone.pipo"))),
  );
  writeFileSync(join(run, "junk.json"), "{ not json");

  const { engine } = await open(home);
  const results = await engine.attach();
  const by = Object.fromEntries(results.map((r) => [r.name, r]));
  // Scanning again checks it again (pipo attach): still no answer, still left alone.
  expect(by.mute).toMatchObject({ outcome: "unreachable", pid: sleeper.pid });
  expect(by.mute?.hint).toContain("pipo attach mute");
  expect(engine.get("mute")).toMatchObject({ state: "unreachable", pid: sleeper.pid });
  expect(engine.get("mute")?.error?.hint).toContain("pipo attach mute");
  expect(isRunning(sleeper.pid)).toBe(true); // never killed
  expect(existsSync(join(run, "mute.json"))).toBe(true);
  await expect(engine.pause("mute")).rejects.toThrow("cannot pause 'mute': it is unreachable");
  await expect(engine.stop("mute")).rejects.toThrow("does not answer the engine");

  // A reused pid is told from /proc (Linux only, spec D27); elsewhere it looks like the same live runner.
  if (process.platform === "linux") {
    expect(engine.get("reused")).toMatchObject({ state: "failed" });
    expect(engine.get("reused")?.error?.message).toContain("can't be restarted: its file");
    expect(existsSync(join(run, "reused.json"))).toBe(false);
  } else expect(engine.get("reused")).toMatchObject({ state: "unreachable" });
  expect(by.junk).toMatchObject({ outcome: "unreachable", message: expect.stringContaining("not readable JSON") });

  // Once the unreachable runner's pid is gone, the next poll rescans it: a stale entry now.
  sleeper.kill("SIGKILL");
  await waitFor(inState(engine, "mute", "failed"), 10_000, "rescan after the pid died");
  expect(existsSync(join(run, "mute.json"))).toBe(false);
  await expect(engine.attach("nobody")).rejects.toThrow("no runner registered for 'nobody'");
  await engine.shutdown();
}, 60_000);
