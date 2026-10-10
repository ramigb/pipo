// `pipo start --ttl` (docs/spec.md §3.8, §7.2, §7.4, D30, D57; ledger L-16): a start's ttl override reaches the
// runner and its registry entry, ends the pipeline on time, and is for that start only. With real processes found
// through registry files (never stdout): a runner SIGKILLed part-way is restarted by the supervisor with the same
// override and still ends at the ttl counted from the first start; after pipod itself is SIGKILLed, the next engine
// takes the override from the registry entry, both for a runner it adopts and then loses, and for one that died while
// no engine ran. Every process is killed by pid at the end.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { readRegistryEntry } from "@pipo/runner";
import { RustRunner } from "../../runner/test/rust";
import { type EngineEntry, readEngineEntry, type SupervisedState, Supervisor } from "../src";
import { isRunning } from "../src/registry";
import { query, sandbox, spawnPipod, testConfig, waitFor } from "./helpers";

setDefaultTimeout(60_000);

type Proc = ReturnType<typeof Bun.spawn>;
const box = sandbox();
const engines: Supervisor[] = [];
const spawned: Proc[] = [];
const pids: number[] = [];
afterAll(async () => {
  for (const e of engines) {
    for (const r of e.list()) if (r.pid) pids.push(r.pid);
    await Promise.race([e.shutdown({ now: true, stopDetached: true }), Bun.sleep(10_000)]);
  }
  for (const p of spawned) p.kill("SIGKILL");
  for (const pid of pids) if (isRunning(pid)) process.kill(pid, "SIGKILL");
  box.cleanup();
});

/** A push pipeline whose file says `ttl: 1h`, so only an override can end it within the test. */
const pipelineFile = (name: string) =>
  box.write(
    `${name}.pipo`,
    `pipo: 1
name: ${name}
input: { via: push }
output:
  from: input
  to: sqlite
  with: { path: ./${name}.db, table: items, create: true, columns: { packet_id: "\${meta.packet_id}", n: "\${data.n}" } }
lifetime: { ttl: 1h }
`,
  );

async function open(home: string, lines: string[] = []) {
  const engine = await Supervisor.open({ home, config: testConfig(), log: (l) => lines.push(l) });
  engines.push(engine);
  return engine;
}

const inState = (engine: Supervisor, name: string, state: SupervisedState) => () => {
  const r = engine.get(name);
  return r?.state === state ? r : null;
};

type Ev = { seq: number; type: string; at: number; detail: Record<string, unknown> | null };
/** Pipeline-level lifecycle events, oldest first. */
const lifecycle = (home: string, name: string): Ev[] =>
  (
    (query(
      join(home, "pipelines", name, "journal.db"),
      `SELECT seq, type, at, detail FROM events WHERE packet_id IS NULL
         AND type IN ('pipeline.started', 'pipeline.draining', 'pipeline.stopped') ORDER BY seq`,
    ) ?? []) as (Omit<Ev, "detail"> & { detail: string | null })[]
  ).map((e) => ({ ...e, detail: e.detail === null ? null : JSON.parse(e.detail) }));

/** The registry entry once it names a live runner other than `not`, with its pid recorded for clean-up. */
async function liveEntry(home: string, name: string, not?: number, ms = 30_000) {
  const entry = await waitFor(
    () => {
      const e = readRegistryEntry(home, name);
      return e && e.pid !== not && isRunning(e.pid) ? e : null;
    },
    ms,
    `${name} runner registry entry`,
  );
  pids.push(entry.pid);
  return entry;
}

/** The first `pipeline.started` (the ttl's anchor), once journaled. */
const anchorOf = (home: string, name: string) =>
  waitFor(() => lifecycle(home, name).find((e) => e.type === "pipeline.started"), 10_000, `${name} started`);

/**
 * The run ended on the ttl counted from `anchor`, not from the restart: the journal shows two starts, then one drain
 * and one stop, and the drain came at the anchored deadline (or at once, when the restart came after it). A fresh ttl
 * from the restart would drain `ttl` after the second start.
 */
function endedOnAnchor(home: string, name: string, anchor: Ev, ttl: number) {
  const events = lifecycle(home, name);
  expect(events.map((e) => e.type)).toEqual([
    "pipeline.started",
    "pipeline.started",
    "pipeline.draining",
    "pipeline.stopped",
  ]);
  const [first, second, draining] = events as [Ev, Ev, Ev, Ev];
  expect(first.seq).toBe(anchor.seq);
  // Every start of this run carries the override, the restart's too.
  expect(first.detail).toMatchObject({ ttl: `${ttl / 1000}s` });
  expect(second.detail).toMatchObject({ ttl: `${ttl / 1000}s` });
  const due = Math.max(anchor.at + ttl, second.at);
  expect(draining.at).toBeGreaterThanOrEqual(anchor.at + ttl - 50);
  expect(draining.at - due).toBeLessThan(750);
  expect(second.at + ttl - draining.at).toBeGreaterThan(1000);
}

test("the runner refuses a bad ttl override, and drains on one when the file has no lifetime block", async () => {
  const home = join(box.root, "runner");
  const file = box.write(
    "bare.pipo",
    "pipo: 1\nname: bare\ninput: { via: push }\noutput: { from: input, to: file, with: { path: ./bare.jsonl } }\n",
  );
  const runnerBox = { root: box.root, home };
  const soon = await RustRunner.refuse(runnerBox, file, { args: ["--ttl", "soon"] });
  expect(soon.code).toBe(1);
  expect(soon.stderr).toContain("ttl 'soon' is not a duration; use for example --ttl 30m, 8h or 2d");
  const zero = await RustRunner.refuse(runnerBox, file, { args: ["--ttl", "0s"] });
  expect(zero.code).toBe(1);
  expect(zero.stderr).toContain("must be longer than 0");
  const runner = await RustRunner.start(runnerBox, file, "bare", { listen: null, args: ["--ttl", "300ms"] });
  pids.push(runner.pid);
  expect(readRegistryEntry(home, "bare")).toMatchObject({ pid: runner.pid, ttl: "300ms" });
  expect(await Promise.race([runner.proc.exited, Bun.sleep(3000).then(() => "still running")])).toBe(0);
  runner.client.close();
  expect(lifecycle(home, "bare").map((e) => e.type)).toEqual([
    "pipeline.started",
    "pipeline.draining",
    "pipeline.stopped",
  ]);
  expect(runner.lines().join("\n")).toContain("lifetime ttl 300ms from the start (the file's: none)");
});

test("start with a ttl: the runner and its registry entry get it, it drains on time; the next start uses the file's", async () => {
  const home = join(box.root, "plain");
  const name = "plain";
  const file = pipelineFile(name);
  const engine = await open(home);

  await expect(engine.start(file, { ttl: "soon" })).rejects.toMatchObject({
    code: "bad_request",
    message: "ttl 'soon' is not a duration",
  });
  await expect(engine.start(file, { ttl: "0ms" })).rejects.toMatchObject({ code: "bad_request" });
  expect(engine.get(name)).toBeUndefined();

  const up = await engine.start(file, { ttl: "2s" });
  pids.push(up.pid as number);
  expect(up).toMatchObject({ state: "running", ttl: "2s" });
  expect(readRegistryEntry(home, name)).toMatchObject({ pid: up.pid, ttl: "2s" });
  const stopped = await waitFor(inState(engine, name, "stopped"), 15_000, "ended on its ttl");
  expect(stopped.error).toBeNull();
  expect(readRegistryEntry(home, name)).toBeNull();
  const events = lifecycle(home, name);
  expect(events.map((e) => e.type)).toEqual(["pipeline.started", "pipeline.draining", "pipeline.stopped"]);
  const [started, draining] = events as [Ev, Ev];
  expect(started.detail).toMatchObject({ ttl: "2s" });
  expect(draining.at - started.at).toBeGreaterThanOrEqual(1950);
  expect(draining.at - started.at).toBeLessThan(2750);

  // Not saved like --listen: a start without it goes back to the file's ttl (1h), from a new anchor.
  const again = await engine.start(name);
  pids.push(again.pid as number);
  expect(again).toMatchObject({ state: "running", ttl: null });
  const entry = readRegistryEntry(home, name);
  expect(entry?.pid).toBe(again.pid as number);
  expect(entry && "ttl" in entry).toBe(false);
  await Bun.sleep(2500);
  expect(engine.get(name)).toMatchObject({ state: "running", pid: again.pid });
  const latest = lifecycle(home, name).at(-1);
  expect(latest?.type).toBe("pipeline.started");
  expect(latest?.detail && "ttl" in latest.detail).toBe(false);
  await engine.stop(name, { now: true });
}, 60_000);

test("SIGKILL ~1.5 s into a detached start with ttl 4s: the supervisor's restart keeps it and ends ~4 s from the first start", async () => {
  const home = join(box.root, "crash");
  const name = "crash";
  const TTL = 4000;
  const file = pipelineFile(name);
  const engine = await open(home);
  const up = await engine.start(file, { ttl: "4s", detached: true });
  const first = await liveEntry(home, name);
  expect(first).toMatchObject({ pid: up.pid, ttl: "4s", detached: true });
  const anchor = await anchorOf(home, name);

  await Bun.sleep(Math.max(0, anchor.at + 1500 - Date.now()));
  process.kill(first.pid, "SIGKILL");
  // The supervisor restarts it with the same override, which its new registry entry carries.
  const second = await liveEntry(home, name, first.pid);
  expect(second).toMatchObject({ ttl: "4s", detached: true });
  expect(engine.get(name)).toMatchObject({ ttl: "4s", restarts: 1 });

  const stopped = await waitFor(inState(engine, name, "stopped"), 20_000, "ended on its anchored ttl");
  expect(stopped.restarts).toBe(1);
  endedOnAnchor(home, name, anchor, TTL);
  expect(readRegistryEntry(home, name)).toBeNull();
}, 60_000);

test("pipod SIGKILLed: the next engine takes the ttl from the registry for an adopted runner and for a dead one", async () => {
  const home = join(box.root, "engine-kill");
  // Each runner's ttl in ms. The orphan starts first and the adopted runner last, so the adopted runner's ttl counts
  // from the latest start and a slow start under load (a Bun module-load hang costs a start_timeout) can't use it up
  // before the next engine scans: a runner whose ttl ended stopped cleanly and removed its entry, and there would be
  // nothing to adopt. The orphan's ttl is twice as long, so the same slow start can't end it before it is killed
  // while no engine runs (with one shared ttl it could, and the "dies with no engine" case never happened).
  const TTL: Record<string, number> = { orphan: 30_000, adopted: 15_000 };
  const ttlOf = (name: string) => `${(TTL[name] as number) / 1000}s`;
  const files = { orphan: pipelineFile("orphan"), adopted: pipelineFile("adopted") };
  const { proc: pipod, value } = await spawnPipod(
    box.root,
    spawned,
    home,
    ["--listen", "0"],
    (p) => {
      const e = readEngineEntry(home);
      return e?.pid === p.pid && e.listen ? e : null;
    },
    "ttl",
    50_000,
  );
  const base = `http://127.0.0.1:${(value as EngineEntry).listen}`;
  await waitFor(
    async () =>
      (
        (await fetch(`${base}/api/engine`).then(
          (r) => r.json(),
          () => null,
        )) as any
      )?.ready,
    30_000,
    "engine ready",
  );
  const runners: Record<string, number> = {};
  const anchors: Record<string, Ev> = {};
  for (const [name, file] of Object.entries(files)) {
    const res = await fetch(`${base}/api/pipelines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file, ttl: ttlOf(name), detached: true }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name, ttl: ttlOf(name), detached: true });
    const entry = await liveEntry(home, name);
    expect(entry).toMatchObject({ ttl: ttlOf(name), detached: true });
    runners[name] = entry.pid;
    anchors[name] = await anchorOf(home, name);
  }

  pipod.kill("SIGKILL");
  await pipod.exited;
  // While no engine runs, one runner dies too: its entry (with the ttl) is all the next engine has. It must still be
  // running here, or this case is not tested at all.
  if (!isRunning(runners.orphan as number))
    throw new Error(
      `the orphan ended before its kill, ${Date.now() - (anchors.orphan as Ev).at} ms after its start: ${JSON.stringify(lifecycle(home, "orphan"))}`,
    );
  process.kill(runners.orphan as number, "SIGKILL");
  await waitFor(() => !isRunning(runners.orphan as number), 5000, "orphan dead");
  // Late enough that a fresh ttl from the restart would end clearly after the anchored one.
  await Bun.sleep(Math.max(0, (anchors.orphan as Ev).at + 3000 - Date.now()));

  const lines: string[] = [];
  const scanAt = Date.now();
  const engine = await open(home, lines);
  // Why, if not: the adopted runner's age when the scan began, its lifecycle events and the new engine's log.
  const explain = () =>
    `adopted runner ${Date.now() - (anchors.adopted as Ev).at} ms after its start (scan began at ${scanAt - (anchors.adopted as Ev).at} ms); events ${JSON.stringify(lifecycle(home, "adopted"))}\n${lines.join("\n")}`;
  if (!engine.get("adopted")) throw new Error(`the new engine did not adopt 'adopted': ${explain()}`);
  expect(engine.get("adopted")).toMatchObject({
    state: "running",
    adopted: true,
    pid: runners.adopted,
    ttl: ttlOf("adopted"),
  });
  // The orphan's restart carries the ttl (its second pipeline.started says so, checked below); it may already have
  // ended, when its anchored ttl was over before the restart.
  expect(engine.get("orphan")).toMatchObject({ adopted: false, ttl: ttlOf("orphan") });

  // The adopted runner crashes under the new engine, which restarts it with the ttl it adopted.
  await Bun.sleep(Math.max(0, (anchors.adopted as Ev).at + 2000 - Date.now()));
  if (!isRunning(runners.adopted as number)) throw new Error(`the adopted runner ended before its kill: ${explain()}`);
  process.kill(runners.adopted as number, "SIGKILL");
  expect(await liveEntry(home, "adopted", runners.adopted)).toMatchObject({ ttl: ttlOf("adopted"), detached: true });

  for (const name of ["adopted", "orphan"]) {
    const anchor = anchors[name] as Ev;
    const ttl = TTL[name] as number;
    await waitFor(
      inState(engine, name, "stopped"),
      Math.max(0, anchor.at + ttl - Date.now()) + 20_000,
      `${name} ended on its anchored ttl`,
    );
    endedOnAnchor(home, name, anchor, ttl);
    expect(readRegistryEntry(home, name)).toBeNull();
  }
}, 180_000);
