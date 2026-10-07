// Engine supervisor end to end (docs/spec.md §7.1, §7.2, §7.3, D25): real runner processes, found through their
// registry entry and a `hello`, never through stdout. SIGKILL of a runner restarts it with backoff and the journal
// delivers every packet exactly once; a stop is not restarted; a crash loop gives up with a hint.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, entryAlive, procStart, readRegistryEntry } from "@pipo/runner";
import { EngineError, type RestartConfig, readEngineEntry, type SupervisedState, Supervisor } from "../src";
import { claimEngineEntry, releaseEngineEntry } from "../src/registry";
import { isAlive, query, sandbox, testConfig, waitFor } from "./helpers";

const boxes: ReturnType<typeof sandbox>[] = [];
const engines: Supervisor[] = [];
afterAll(async () => {
  for (const e of engines) {
    const pids = e.list().flatMap((r) => (r.pid ? [r.pid] : []));
    await Promise.race([e.shutdown({ now: true }), Bun.sleep(10_000)]);
    for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  }
  for (const b of boxes) b.cleanup();
});

async function setup(restart: Partial<RestartConfig> = {}) {
  const box = sandbox();
  boxes.push(box);
  const lines: string[] = [];
  const engine = await Supervisor.open({ home: box.home, config: testConfig(restart), log: (l) => lines.push(l) });
  engines.push(engine);
  return { box, engine, lines };
}

const pushPipeline = (name: string, extra = "") => `pipo: 1
name: ${name}
fn: ./fns.ts
concurrency: 2
input: { via: push }
nodes:
  slow:
    from: input
    transform: fn.slow
output:
  from: slow
  to: sqlite
  with: { path: ./${name}.db, table: items, create: true, columns: { packet_id: "\${meta.packet_id}", n: "\${data.n}" } }
delivered:
  check: record_exists
  with: { where: { packet_id: "\${meta.packet_id}" } }
${extra}`;

const FNS = `export const slow = async (d) => { await Bun.sleep(80); return d; };
export const boom = () => process.exit(3);
`;

/** A waitFor condition: the pipeline's info once it reaches `state`. */
const inState = (engine: Supervisor, name: string, state: SupervisedState) => () => {
  const r = engine.get(name);
  return r?.state === state ? r : null;
};

const journal = (home: string, name: string) => join(home, "pipelines", name, "journal.db");
function states(home: string, name: string): Record<string, number> {
  const all = query(journal(home, name), "SELECT state, COUNT(*) AS n FROM packets GROUP BY state") ?? [];
  return Object.fromEntries(all.map((r) => [r.state, r.n]));
}

test("start: the runner comes up, is found through its registry entry and answers hello", async () => {
  const { box, engine } = await setup();
  box.write("fns.ts", FNS);
  const file = box.write("up.pipo", pushPipeline("up"));

  const info = await engine.start(file);
  expect(info).toMatchObject({ name: "up", state: "running", restarts: 0, error: null, detached: false });
  const entry = readRegistryEntry(box.home, "up");
  expect(entry?.pid).toBe(info.pid as number);
  expect(entry?.engine_id).toBe(engine.engineId);
  expect(readEngineEntry(box.home)).toMatchObject({ engine_id: engine.engineId, pid: process.pid });

  const client = await ControlClient.connect(entry?.socket as string);
  const hello = await client.request("hello");
  client.close();
  expect(hello).toMatchObject({ pipeline: "up", pid: info.pid, state: "active" });

  // Control goes through the runner's socket; the registry status follows.
  expect(await engine.pause("up")).toEqual({ state: "paused", already: false });
  expect(engine.get("up")?.status).toBe("paused");
  expect(await engine.resume("up")).toEqual({ state: "active", already: false });
  const pushed = await engine.request<{ packet_id: string }>("up", "push", { data: { n: 1 } });
  await waitFor(() => states(box.home, "up").delivered === 1, 10_000, "pushed packet delivered");
  expect(query(join(box.root, "up.db"), "SELECT packet_id FROM items")).toEqual([{ packet_id: pushed.packet_id }]);

  // The runner's output goes to <home>/logs/<name>.log, with the engine's own lines.
  const log = readFileSync(info.log, "utf8");
  expect(info.log).toBe(join(box.home, "logs", "up.log"));
  expect(log).toContain("ENGINE [up] starting runner");
  expect(log).toContain("started v1");

  // Starting it twice is refused.
  await expect(engine.start(file)).rejects.toThrow("'up' is already running");
}, 60_000);

test("SIGKILL: the runner restarts after its backoff and every pushed packet is delivered exactly once", async () => {
  const { box, engine, lines } = await setup({ backoff: 600, max_backoff: 5000 });
  box.write("fns.ts", FNS);
  const file = box.write("kills.pipo", pushPipeline("kills"));
  const first = await engine.start(file);

  const ids: string[] = [];
  for (let n = 0; n < 20; n++) {
    ids.push((await engine.request<{ packet_id: string }>("kills", "push", { data: { n } })).packet_id);
  }
  const pid = readRegistryEntry(box.home, "kills")?.pid as number;
  expect(pid).toBe(first.pid as number);
  process.kill(pid, "SIGKILL");
  const killedAt = Date.now();

  // The engine notices and waits out the backoff; meanwhile the journal holds every accepted packet.
  const backoff = await waitFor(inState(engine, "kills", "backoff"), 5000, "backoff");
  expect(backoff.last_exit).toMatchObject({ code: null, signal: "SIGKILL" });
  expect(backoff.next_restart_at).not.toBeNull();
  const before = states(box.home, "kills");
  expect(before.delivered ?? 0).toBeLessThan(20); // the kill really interrupted work
  expect(Object.values(before).reduce((a, b) => a + b, 0)).toBe(20); // nothing accepted was lost

  const second = await waitFor(
    () => {
      const r = engine.get("kills");
      return r?.state === "running" && r.pid !== pid ? r : null;
    },
    40_000,
    "restarted runner",
  );
  expect(second.restarts).toBe(1);
  expect(Date.parse(second.started_at as string) - killedAt).toBeGreaterThanOrEqual(600);
  expect(readRegistryEntry(box.home, "kills")).toMatchObject({ pid: second.pid, engine_id: engine.engineId });
  expect(lines.join("\n")).toMatch(/'kills' was killed by SIGKILL; restarting in 600ms \(restart 1 of 5/);

  await waitFor(() => states(box.home, "kills").delivered === 20, 20_000, "all packets delivered");
  const written = query(join(box.root, "kills.db"), "SELECT packet_id, n FROM items ORDER BY n") ?? [];
  expect(written.map((r) => r.packet_id).sort()).toEqual([...ids].sort());
  expect(written.map((r) => r.n)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  const delivered = query(
    journal(box.home, "kills"),
    "SELECT packet_id, COUNT(*) AS n FROM events WHERE type = 'packet.delivered' GROUP BY packet_id",
  );
  expect(delivered?.length).toBe(20);
  expect(delivered?.every((r) => r.n === 1)).toBe(true);
  expect(readFileSync(second.log, "utf8")).toContain("resuming");
}, 90_000);

test("stop: the runner exits cleanly, its registry entry goes, and it is not restarted", async () => {
  const { box, engine } = await setup({ backoff: 50 });
  box.write("fns.ts", FNS);
  const file = box.write("halts.pipo", pushPipeline("halts"));
  const { pid } = await engine.start(file);

  const stopped = await engine.stop("halts", { now: true });
  expect(stopped).toMatchObject({ state: "stopped", pid: null, last_exit: { code: 0, signal: null } });
  expect(existsSync(join(box.home, "run", "halts.json"))).toBe(false);
  expect(isAlive(pid as number)).toBe(false);
  await Bun.sleep(500); // ten backoffs: nothing comes back
  expect(engine.get("halts")?.state).toBe("stopped");
  expect(existsSync(join(box.home, "run", "halts.json"))).toBe(false);
  await expect(engine.pause("halts")).rejects.toThrow("cannot pause 'halts': it is stopped");

  // Started again by name; then drained (the default stop).
  const again = await engine.start("halts");
  expect(again.state).toBe("running");
  expect(await engine.stop("halts")).toMatchObject({ state: "stopped", last_exit: { code: 0 } });
  await Bun.sleep(300);
  expect(engine.get("halts")?.state).toBe("stopped");
}, 60_000);

test("a runner whose lifetime ends exits 0 on its own and is not restarted", async () => {
  const { box, engine } = await setup({ backoff: 50 });
  box.write("fns.ts", FNS);
  const file = box.write("brief.pipo", pushPipeline("brief", "lifetime: { max_packets: 1, on_end: drain }\n"));
  await engine.start(file);
  await engine.request("brief", "push", { data: { n: 1 } });
  const done = await waitFor(inState(engine, "brief", "stopped"), 15_000, "stop");
  expect(done.last_exit).toMatchObject({ code: 0 });
  await Bun.sleep(400);
  expect(engine.get("brief")).toMatchObject({ state: "stopped", restarts: 0 });
  expect(states(box.home, "brief")).toEqual({ delivered: 1 });
}, 60_000);

test("crash loop: after max_restarts within the window the engine gives up and says what to do", async () => {
  const { box, engine, lines } = await setup({ backoff: 50, max_backoff: 100, max_restarts: 2, window: 60_000 });
  box.write("fns.ts", FNS);
  const file = box.write(
    "poison.pipo",
    `pipo: 1
name: poison
fn: ./fns.ts
input: { via: push }
nodes:
  boom: { from: input, transform: fn.boom }
output: { from: boom, to: file, with: { path: ./poison.jsonl } }
`,
  );
  await engine.start(file);
  // The packet is journaled before the push is answered; then it kills its runner, and every restart resumes it.
  await engine.request("poison", "push", { data: { n: 1 } }).catch(() => {});

  const crashed = await waitFor(inState(engine, "poison", "crashed"), 60_000, "crashed");
  expect(crashed.restarts).toBe(2);
  expect(crashed.pid).toBeNull();
  expect(crashed.last_exit?.code).toBe(3);
  expect(crashed.error?.message).toContain("'poison' kept crashing: 2 restart(s) within 1m0s did not help");
  expect(crashed.error?.message).toContain("code 3");
  expect(crashed.error?.hint).toContain(join(box.home, "logs", "poison.log"));
  expect(crashed.error?.hint).toContain("pipo start poison");
  expect(lines.some((l) => l.includes("ERROR [engine] 'poison' kept crashing"))).toBe(true);

  await Bun.sleep(500);
  expect(engine.get("poison")?.state).toBe("crashed");
  const entry = readRegistryEntry(box.home, "poison");
  expect(entry && isAlive(entry.pid)).toBeFalsy();
  // The poison packet is still in the journal, in flight: nothing was lost or dropped.
  expect(states(box.home, "poison")).toEqual({ accepted: 1 });
  await expect(engine.resume("poison")).rejects.toThrow(/cannot resume 'poison': it is crashed/);
}, 90_000);

test("refusals: a broken file, a pipeline named engine, a second engine on the same home, unknown names", async () => {
  const { box, engine } = await setup();
  const broken = box.write(
    "broken.pipo",
    "pipo: 1\nname: broken\ninput: { via: push }\noutput: { from: nowhere, to: stdout }\n",
  );
  const e = await engine.start(broken).catch((x) => x);
  expect(e).toBeInstanceOf(EngineError);
  expect(e.code).toBe("invalid_pipeline");
  expect(e.message).toContain("P010");
  expect(engine.get("broken")).toBeUndefined();

  const ok = box.write(
    "named.pipo",
    "pipo: 1\nname: engine\ninput: { via: push }\noutput: { from: input, to: stdout }\n",
  );
  await expect(engine.start(ok)).rejects.toThrow("a pipeline can't be named 'engine'");

  await expect(Supervisor.open({ home: box.home, config: testConfig() })).rejects.toThrow(
    /an engine is already running/,
  );
  await expect(engine.stop("ghost")).rejects.toThrow("no pipeline named 'ghost'");

  await engine.shutdown();
  expect(readEngineEntry(box.home)).toBeNull();
  await expect(engine.start(ok)).rejects.toThrow("the engine is shutting down");
}, 30_000);

test("shutdown while a runner is still coming up lets it finish, then drains it (no kill, no stale entry)", async () => {
  const { box, engine } = await setup();
  box.write("fns.ts", FNS);
  const file = box.write("early.pipo", pushPipeline("early"));
  const starting = engine.start(file);
  // The registry entry appears before the engine's `hello` handshake is done.
  await waitFor(() => readRegistryEntry(box.home, "early"), 20_000, "registry entry");
  const closing = engine.shutdown();
  const info = await starting;
  await closing;
  expect(info.state).toBe("running");
  expect(engine.get("early")).toMatchObject({ state: "stopped", last_exit: { code: 0, signal: null } });
  expect(readRegistryEntry(box.home, "early")).toBeNull();
  expect(readEngineEntry(box.home)).toBeNull();
}, 60_000);

// ── liveness: a registry entry's pid may now belong to another process (D27) ─────────────────────────────────────

const sleepers: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
  for (const p of sleepers) p.kill("SIGKILL");
});
/** A live process that is not the one an entry registered: a stand-in for a reused pid. */
function sleeper() {
  const p = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  sleepers.push(p);
  return p;
}
const longAgo = () => new Date(Date.now() - 3600_000).toISOString();
const linux = process.platform === "linux";

test.if(linux)(
  "entryAlive: a live pid that started after the entry registered, or isn't its process, is dead",
  async () => {
    const now = new Date().toISOString();
    expect(entryAlive({ pid: process.pid, started_at: now })).toBe(true);
    expect(entryAlive({ pid: process.pid, started_at: now, proc_start: procStart() })).toBe(true);

    const other = sleeper();
    // Registered an hour before the process now holding the pid started: the pid was reused.
    expect(entryAlive({ pid: other.pid, started_at: longAgo() })).toBe(false);
    expect(entryAlive({ pid: other.pid, started_at: now })).toBe(true);
    // A recorded process start is exact and beats the clocks (a wall clock that jumped, a VM that slept).
    const ticks = procStart(other.pid) as number;
    expect(entryAlive({ pid: other.pid, started_at: now, proc_start: ticks + 1 })).toBe(false);
    expect(entryAlive({ pid: other.pid, started_at: longAgo(), proc_start: ticks })).toBe(true);

    other.kill("SIGKILL");
    await other.exited;
    expect(entryAlive({ pid: other.pid, started_at: now })).toBe(false);
    // kill(0) and kill(-1) would signal a process group: never "alive".
    for (const pid of [0, -1, Number.NaN]) expect(entryAlive({ pid, started_at: now })).toBe(false);
  },
);

test.if(linux)(
  "claimEngineEntry replaces an engine.json whose pid was reused, and refuses a live engine's",
  async () => {
    const box = sandbox();
    boxes.push(box);
    const run = join(box.home, "run");
    mkdirSync(run, { recursive: true });
    const other = sleeper();
    const stale = { engine_id: "e_old", pid: other.pid, home: box.home, listen: null };
    writeFileSync(join(run, "engine.json"), JSON.stringify({ ...stale, started_at: longAgo() }));

    const engine = await Supervisor.open({ home: box.home, config: testConfig(), log: () => {} });
    engines.push(engine);
    expect(readEngineEntry(box.home)).toMatchObject({
      engine_id: engine.engineId,
      pid: process.pid,
      proc_start: procStart(),
    });
    await engine.shutdown();

    // The same pid as a live engine that registered after it started: refused, the entry untouched.
    const live = { ...stale, started_at: new Date().toISOString(), proc_start: procStart(other.pid) };
    writeFileSync(join(run, "engine.json"), JSON.stringify(live));
    const mine = {
      engine_id: "e_new",
      pid: process.pid,
      started_at: new Date().toISOString(),
      home: box.home,
      listen: null,
    };
    expect(() => claimEngineEntry(mine)).toThrow(/an engine is already running/);
    expect(readEngineEntry(box.home)).toMatchObject({ engine_id: "e_old" });
    // Recorded under another process start: that engine is gone, whatever the clocks say.
    writeFileSync(join(run, "engine.json"), JSON.stringify({ ...live, proc_start: (live.proc_start as number) + 1 }));
    claimEngineEntry(mine);
    expect(readEngineEntry(box.home)).toMatchObject({ engine_id: "e_new" });
    releaseEngineEntry(box.home, "e_new");
  },
);

test.if(linux)(
  "start over a runner entry whose pid was reused starts the pipeline and replaces the entry",
  async () => {
    const { box, engine } = await setup();
    box.write("fns.ts", FNS);
    const file = box.write("reborn.pipo", pushPipeline("reborn"));
    const other = sleeper();
    const run = join(box.home, "run");
    mkdirSync(run, { recursive: true });
    writeFileSync(
      join(run, "reborn.json"),
      JSON.stringify({
        pipeline: "reborn",
        version: 1,
        pid: other.pid,
        file,
        socket: join(run, "reborn.sock"),
        listen: null,
        detached: false,
        state: "active",
        started_at: longAgo(),
      }),
    );

    const info = await engine.start(file);
    expect(info).toMatchObject({ name: "reborn", state: "running", restarts: 0, error: null });
    expect(info.pid).not.toBe(other.pid);
    expect(readRegistryEntry(box.home, "reborn")).toMatchObject({ pid: info.pid, engine_id: engine.engineId });
    expect(other.exitCode).toBeNull(); // the process holding the reused pid is never touched
    await engine.shutdown();
  },
  60_000,
);
