// The pipod entry point (docs/spec.md §7.1, §7.2, D25, D27): engine.json, runners tagged with its engine_id, SIGTERM
// drains every runner and releases the home, a bad config.yaml stops it before anything starts, a second engine on
// the same home refuses, and after a SIGKILL the next engine adopts the runner and replays the events it missed.
// Processes are found through registry files; output goes to log files, never pipes.
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, type RegistryEntry, readRegistryEntry } from "@pipo/runner";
import { type EngineEntry, type EngineEvent, readCursor, readEngineEntry, Supervisor } from "../src";
import { isRunning } from "../src/registry";
import { isAlive, query, sandbox, spawnPipod, testConfig, waitFor } from "./helpers";

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
const runnerPids: number[] = [];
afterAll(() => {
  for (const p of spawned) p.kill("SIGKILL");
  for (const pid of runnerPids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  box.cleanup();
});

const pipod = <T>(
  home: string,
  args: string[],
  ready: (proc: ReturnType<typeof Bun.spawn>) => T,
  n: number,
  ms?: number,
) => spawnPipod(box.root, spawned, home, args, ready, n, ms);

test("pipod starts its pipelines tagged with its engine_id; SIGTERM drains them and releases the home", async () => {
  const home = join(box.root, "home");
  const file = box.write(
    "tagged.pipo",
    "pipo: 1\nname: tagged\ninput: { via: push }\noutput: { from: input, to: file, with: { path: ./tagged.jsonl } }\n",
  );
  const { proc, log, value } = await pipod(
    home,
    [file],
    () => {
      const engine = readEngineEntry(home);
      const runner = readRegistryEntry(home, "tagged");
      return engine && runner ? ([engine, runner] as [EngineEntry, RegistryEntry]) : null;
    },
    1,
    // pipod itself retries a runner stuck loading modules after its start_timeout (15 s).
    50_000,
  );
  const [engine, runner] = value;
  runnerPids.push(runner.pid);
  expect(engine).toMatchObject({ pid: proc.pid, home, listen: null });
  expect(engine.engine_id).toMatch(/^e_[0-9A-Z]{26}$/);
  expect(runner.engine_id).toBe(engine.engine_id);
  expect(runner.pid).not.toBe(proc.pid);
  expect(existsSync(join(home, "logs", "tagged.log"))).toBe(true);

  proc.kill("SIGTERM");
  expect(await proc.exited).toBe(0);
  expect(isAlive(runner.pid)).toBe(false);
  expect(readRegistryEntry(home, "tagged")).toBeNull();
  expect(readEngineEntry(home)).toBeNull();
  expect(readFileSync(log, "utf8")).toContain("'tagged' stopped");
}, 90_000);

test("pipod refuses a bad config.yaml with the position and a hint, and exits 2", async () => {
  const home = join(box.root, "bad");
  await Bun.write(join(home, "config.yaml"), "engine:\n  restart:\n    backof: 1s\n");
  const { value: code, log } = await pipod(home, [], (proc) => proc.exitCode, 2);
  expect(code).toBe(2);
  const err = readFileSync(`${log}.err`, "utf8");
  expect(err).toContain("config.yaml:3:5 unknown key 'engine.restart.backof'");
  expect(err).toContain("hint:");
  expect(readEngineEntry(home)).toBeNull();
}, 60_000);

const pushFile = (name: string) =>
  box.write(
    `${name}.pipo`,
    `pipo: 1\nname: ${name}\ninput: { via: push }\noutput: { from: input, to: file, with: { path: ./${name}.jsonl } }\n`,
  );

test("a second pipod on the same home refuses with a hint and exits 2; the first keeps the home", async () => {
  const home = join(box.root, "twice");
  const first = await pipod(home, [], () => readEngineEntry(home), 5, 30_000);
  const { value: code, log } = await pipod(home, [], (proc) => proc.exitCode, 6, 30_000);
  expect(code).toBe(2);
  const err = readFileSync(`${log}.err`, "utf8");
  expect(err).toContain(`an engine is already running for ${home} (pid ${first.proc.pid}`);
  expect(err).toContain("hint:");
  expect(readEngineEntry(home)).toMatchObject({ pid: first.proc.pid, engine_id: first.value.engine_id });
  first.proc.kill("SIGTERM");
  expect(await first.proc.exited).toBe(0);
  expect(readEngineEntry(home)).toBeNull();
}, 90_000);

test("pipod SIGKILL: the runner keeps running; the next engine adopts it and replays exactly the events after its cursor", async () => {
  const home = join(box.root, "adopt");
  const file = pushFile("adopt");
  const journal = join(home, "pipelines", "adopt", "journal.db");
  const { proc, value } = await pipod(
    home,
    [file],
    () => {
      const engine = readEngineEntry(home);
      const runner = readRegistryEntry(home, "adopt");
      // The engine streams the runner's events and persists its cursor.
      return engine && runner && readCursor(home, "adopt") > 0
        ? ([engine, runner] as [EngineEntry, RegistryEntry])
        : null;
    },
    7,
    50_000,
  );
  const [old, runner] = value;
  runnerPids.push(runner.pid);
  proc.kill("SIGKILL");
  await proc.exited;
  expect(isRunning(runner.pid)).toBe(true);
  const cursor = readCursor(home, "adopt");

  // With no engine, packets go straight to the runner's socket; their events wait in its journal.
  const client = await ControlClient.connect(runner.socket as string);
  for (let n = 0; n < 5; n++) await client.request("push", { data: { n } });
  client.close();
  const delivered = () => query(journal, "SELECT COUNT(*) AS n FROM packets WHERE state = 'delivered'")?.[0]?.n;
  await waitFor(() => delivered() === 5, 10_000, "pushed packets delivered");
  const missed = query(journal, "SELECT seq, type FROM events WHERE seq > ? ORDER BY seq", cursor) ?? [];
  expect(missed.filter((e) => e.type === "packet.delivered")).toHaveLength(5);
  const last = missed.at(-1)?.seq as number;

  const seen: EngineEvent[] = [];
  const engine = await Supervisor.open({ home, config: testConfig(), log: () => {}, onEvent: (e) => seen.push(e) });
  try {
    // The stale engine.json (dead pid) was replaced; the runner was adopted, not started again.
    expect(readEngineEntry(home)).toMatchObject({ engine_id: engine.engineId, pid: process.pid });
    expect(engine.engineId).not.toBe(old.engine_id);
    expect(engine.get("adopt")).toMatchObject({ state: "running", adopted: true, pid: runner.pid, restarts: 0 });
    expect(readRegistryEntry(home, "adopt")).toMatchObject({ pid: runner.pid, engine_id: old.engine_id });
    await expect(engine.start(file)).rejects.toThrow("'adopt' is already running");

    // Replay: exactly the events after the old cursor, in order, none twice, none missing.
    await waitFor(() => seen.some((e) => e.seq >= last), 10_000, "replayed events");
    expect(seen.slice(0, missed.length).map((e) => [e.seq, e.type])).toEqual(missed.map((e) => [e.seq, e.type]));
    expect(seen.every((e) => e.pipeline === "adopt")).toBe(true);

    // Live: control works through the engine, and new events keep coming.
    const { packet_id } = await engine.request<{ packet_id: string }>("adopt", "push", { data: { n: 99 } });
    await waitFor(
      () => seen.some((e) => e.packet_id === packet_id && e.type === "packet.delivered"),
      10_000,
      "live event",
    );
  } finally {
    await engine.shutdown();
  }
  // Shutdown drains an adopted runner like its own; its last events are read from its journal.
  expect(isRunning(runner.pid)).toBe(false);
  expect(readRegistryEntry(home, "adopt")).toBeNull();
  const lastSeq = query(journal, "SELECT MAX(seq) AS n FROM events")?.[0]?.n as number;
  expect(readCursor(home, "adopt")).toBe(lastSeq);
  expect(seen.at(-1)?.type).toBe("pipeline.stopped");
  const seqs = seen.map((e) => e.seq);
  expect(seqs).toEqual(Array.from({ length: lastSeq - cursor }, (_, i) => cursor + 1 + i));
}, 120_000);
