// Engine lifetime (docs/spec.md §7.5, D31) with real processes found through registry files, never stdout: the engine
// stays up while a pipeline is paused with pending packets, sleeps (exits 0, run/engine.json removed) once everything
// stopped and `engine.idle` passed, and when `engine.ttl` expires it drains its pipelines and stops while detached
// runners keep running. pipod flags override config.yaml. API calls keep an idle engine awake, and a pipeline the
// engine gave up on (crashed) loses its stale registry entry when the engine ends, so the next engine doesn't restart it.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, readRegistryEntry } from "@pipo/runner";
import { type EndReason, type EngineEntry, readEngineEntry, Supervisor } from "../src";
import { isRunning } from "../src/registry";
import { isAlive, query, sandbox, spawnPipod, testConfig, waitFor } from "./helpers";

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
const engines: Supervisor[] = [];
const runnerPids: number[] = [];
afterAll(async () => {
  for (const e of engines) {
    for (const r of e.list()) if (r.pid) runnerPids.push(r.pid);
    await Promise.race([e.shutdown({ now: true, stopDetached: true }), Bun.sleep(10_000)]);
  }
  for (const p of spawned) p.kill("SIGKILL");
  for (const pid of runnerPids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  box.cleanup();
});

const pipod = <T>(
  home: string,
  args: string[],
  ready: (proc: ReturnType<typeof Bun.spawn>) => T,
  n: number | string,
  ms?: number,
) => spawnPipod(box.root, spawned, home, args, ready, n, ms);

const pushFile = (name: string) =>
  box.write(
    `${name}.pipo`,
    `pipo: 1\nname: ${name}\ninput: { via: push }\noutput: { from: input, to: file, with: { path: ./${name}.jsonl, format: jsonl } }\n`,
  );

function config(home: string, yaml: string) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.yaml"), yaml);
}

const counts = (journal: string, state: string) =>
  query(journal, "SELECT COUNT(*) AS n FROM packets WHERE state = ?", state)?.[0]?.n as number | undefined;

test("pipod stays up while a pipeline is paused with pending packets, and sleeps once it stopped and engine.idle passed", async () => {
  const home = join(box.root, "sleepy-home");
  config(home, "engine:\n  idle: 1s\n");
  const file = pushFile("sleepy");
  const journal = join(home, "pipelines", "sleepy", "journal.db");
  const { proc, log, value } = await pipod(
    home,
    [file],
    () => {
      const engine = readEngineEntry(home);
      const runner = readRegistryEntry(home, "sleepy");
      return engine && runner ? { engine, runner } : null;
    },
    "sleepy",
    50_000,
  );
  runnerPids.push(value.runner.pid);
  const client = await ControlClient.connect(value.runner.socket as string);
  try {
    await client.request("pause", { reason: "manual" });
    for (let n = 0; n < 3; n++) await client.request("push", { data: { n } });
    expect(counts(journal, "delivered") ?? 0).toBe(0);
    // Paused, with pending packets: well past engine.idle, the engine is still up.
    await Bun.sleep(3000);
    expect(proc.exitCode).toBeNull();
    expect(readEngineEntry(home)).toMatchObject({ pid: proc.pid });

    await client.request("resume");
    await waitFor(() => counts(journal, "delivered") === 3, 10_000, "pending packets delivered");
    // Active and idle (nothing pending) still counts as running: the engine stays.
    await Bun.sleep(2000);
    expect(proc.exitCode).toBeNull();
    await client.request("stop");
  } finally {
    client.close();
  }
  await waitFor(() => !isRunning(value.runner.pid), 10_000, "runner to stop");
  const stoppedAt = Date.now();
  expect(await Promise.race([proc.exited, Bun.sleep(15_000).then(() => "still up")])).toBe(0);
  // Not before engine.idle (1 s) passed after the last pipeline stopped (minus one poll of slack).
  expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(500);
  expect(readEngineEntry(home)).toBeNull();
  expect(readRegistryEntry(home, "sleepy")).toBeNull();
  const said = readFileSync(log, "utf8");
  expect(said).toContain("sleeping; the next pipo command starts the engine again");
  expect(said).toContain("engine stopped");
}, 120_000);

test("engine.ttl from --ttl (over config.yaml) drains the pipelines, leaves detached runners running and stops; --listen overrides engine.listen", async () => {
  const home = join(box.root, "ttl-home");
  // A port that is taken: if config.yaml's listen were used, the engine could not start.
  const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("taken") });
  const ttlMs = 12_000;
  try {
    config(home, `engine:\n  ttl: 1h\n  idle: 1h\n  listen: ${taken.port}\n`);
    const attached = pushFile("timed");
    const loose = pushFile("loose");
    const journal = join(home, "pipelines", "timed", "journal.db");
    const { proc, log, value } = await pipod(
      home,
      ["--listen", "0", "--ttl", `${ttlMs / 1000}s`, attached],
      () => {
        const engine = readEngineEntry(home);
        const runner = readRegistryEntry(home, "timed");
        return engine && runner ? { engine, runner } : null;
      },
      "ttl",
      50_000,
    );
    runnerPids.push(value.runner.pid);
    const engine = value.engine as EngineEntry;
    expect(engine.listen).not.toBe(taken.port);
    expect(engine.listen).toBeGreaterThan(0);
    const gw = `http://127.0.0.1:${engine.listen}`;
    const info = (await (await fetch(`${gw}/api/engine`)).json()) as Record<string, unknown>;
    expect(info).toMatchObject({ ready: true, stopping: false });
    expect(Date.parse(info.ttl_expires_at as string) - Date.parse(engine.started_at)).toBe(ttlMs);

    const started = await fetch(`${gw}/api/pipelines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: loose, detached: true }),
    });
    expect(started.status).toBe(201);
    const detached = readRegistryEntry(home, "loose");
    expect(detached).toMatchObject({ detached: true });
    runnerPids.push(detached?.pid as number);

    // A packet in flight when the TTL expires is finished by the drain.
    const client = await ControlClient.connect(value.runner.socket as string);
    await client.request("push", { data: { n: 1 } });
    client.close();

    expect(await Promise.race([proc.exited, Bun.sleep(ttlMs + 30_000).then(() => "still up")])).toBe(0);
    // It stopped because of the TTL, not before it.
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(engine.started_at) + ttlMs);
    expect(readEngineEntry(home)).toBeNull();
    expect(isRunning(value.runner.pid)).toBe(false);
    expect(readRegistryEntry(home, "timed")).toBeNull();
    expect(counts(journal, "delivered")).toBe(1);
    const last = query(journal, "SELECT type FROM events ORDER BY seq DESC LIMIT 1")?.[0]?.type;
    expect(last).toBe("pipeline.stopped");
    // The detached runner keeps its own lifetime (D30, D31): still running, still registered.
    expect(isRunning(detached?.pid as number)).toBe(true);
    expect(readRegistryEntry(home, "loose")?.pid).toBe(detached?.pid);
    const said = readFileSync(log, "utf8");
    expect(said).toContain("engine.ttl (12s) expired: draining every pipeline");
    expect(said).toContain("'loose' left running (detached");

    const c = await ControlClient.connect(detached?.socket as string);
    await c.request("stop").catch(() => {});
    c.close();
    await waitFor(() => !isRunning(detached?.pid as number), 10_000, "detached runner to stop");
  } finally {
    taken.stop(true);
  }
}, 150_000);

test("pipod --help exits 0; a bad --listen or --ttl exits 2 with the usage", async () => {
  const home = join(box.root, "flags-home");
  // Wrapped: waitFor treats a bare 0 as "not yet".
  const exited = (p: ReturnType<typeof Bun.spawn>) => (p.exitCode === null ? null : { code: p.exitCode });
  const help = await pipod(home, ["--help"], exited, "help", 30_000);
  expect(help.value.code).toBe(0);
  const text = readFileSync(help.log, "utf8");
  expect(text).toContain("--listen <port>");
  expect(text).toContain("--ttl <duration>");
  expect(text).toContain("engine.idle");

  const badPort = await pipod(home, ["--listen", "99999"], exited, "bad-port", 30_000);
  expect(badPort.value.code).toBe(2);
  expect(readFileSync(`${badPort.log}.err`, "utf8")).toContain("--listen '99999' is not a port");
  const badTtl = await pipod(home, ["--ttl", "soon"], exited, "bad-ttl", 30_000);
  expect(badTtl.value.code).toBe(2);
  expect(readFileSync(`${badTtl.log}.err`, "utf8")).toContain("--ttl 'soon' is not a duration");
  expect(readEngineEntry(home)).toBeNull();
}, 90_000);

test("API calls keep an idle engine awake; when it sleeps, a pipeline it gave up on (crashed) loses its stale entry", async () => {
  const home = join(box.root, "crash-home");
  const ended: { reason: EndReason; at: number }[] = [];
  const engine = await Supervisor.open({
    home,
    config: { ...testConfig({ max_restarts: 0 }), idle: 1500, listen: 0 },
    log: () => {},
    onEnd: (reason) => ended.push({ reason, at: Date.now() }),
  });
  engines.push(engine);
  const gw = engine.gateway?.url as string;
  // Nothing runs, but someone keeps asking: the engine stays up.
  const until = Date.now() + 3500;
  while (Date.now() < until) {
    expect((await fetch(`${gw}/api/pipelines`)).status).toBe(200);
    await Bun.sleep(300);
  }
  expect(ended).toEqual([]);
  expect(engine.stopping).toBe(false);

  const file = pushFile("crashy");
  const info = await engine.start(file);
  runnerPids.push(info.pid as number);
  process.kill(info.pid as number, "SIGKILL");
  await waitFor(() => engine.get("crashy")?.state === "crashed", 10_000, "crashy to be crashed");
  const crashedAt = Date.now();
  // Its entry still names the dead runner: the next engine would restart it (D27)…
  expect(readRegistryEntry(home, "crashy")?.pid).toBe(info.pid as number);

  await waitFor(() => ended.length > 0, 10_000, "the engine to sleep");
  expect(ended[0]?.reason).toBe("idle");
  expect((ended[0]?.at as number) - crashedAt).toBeGreaterThanOrEqual(1000);
  expect(engine.stopping).toBe(true);
  // …so an engine that ends itself removes it: crashed stays crashed until started again.
  expect(readRegistryEntry(home, "crashy")).toBeNull();
  expect(readEngineEntry(home)).toBeNull();
  await expect(engine.start(file)).rejects.toThrow("shutting down");
}, 60_000);

test("an open /events stream (the dashboard) keeps an idle engine awake; it sleeps once the stream closes (D61)", async () => {
  const ended: { reason: EndReason; at: number }[] = [];
  const engine = await Supervisor.open({
    home: join(box.root, "hold-home"),
    config: { ...testConfig(), idle: 800, listen: 0 },
    log: () => {},
    onEnd: (reason) => ended.push({ reason, at: Date.now() }),
  });
  engines.push(engine);
  const abort = new AbortController();
  const res = await fetch(`${engine.gateway?.url}/events`, { signal: abort.signal });
  expect(res.status).toBe(200);
  const reader = res.body?.getReader();
  await reader?.read(); // the stream is open (its retry line arrived)
  await Bun.sleep(2500);
  expect(ended).toEqual([]);
  expect(engine.stopping).toBe(false);
  const closedAt = Date.now();
  abort.abort();
  await reader?.cancel().catch(() => {});
  await waitFor(() => ended.length > 0, 10_000, "the engine to sleep");
  expect(ended[0]?.reason).toBe("idle");
  expect((ended[0]?.at as number) - closedAt).toBeGreaterThanOrEqual(500);
}, 30_000);

test("POST /api/engine/stop answers first, then drains its pipelines and ends with reason stop (the dashboard's button)", async () => {
  const home = join(box.root, "stop-home");
  const ended: { reason: EndReason; at: number }[] = [];
  const engine = await Supervisor.open({
    home,
    config: { ...testConfig(), listen: 0 },
    log: () => {},
    onEnd: (reason) => ended.push({ reason, at: Date.now() }),
  });
  engines.push(engine);
  const info = await engine.start(pushFile("stoppy"));
  runnerPids.push(info.pid as number);
  const res = await fetch(`${engine.gateway?.url}/api/engine/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(202);
  expect(await res.json()).toMatchObject({ stopping: true, pid: process.pid, pipelines: ["stoppy"], detached: [] });
  await waitFor(() => ended.length > 0, 20_000, "the engine to stop");
  expect(ended[0]?.reason).toBe("stop");
  expect(isAlive(info.pid as number)).toBe(false);
  expect(readEngineEntry(home)).toBeNull();
}, 60_000);
