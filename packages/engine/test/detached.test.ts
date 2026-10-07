// Detached mode and the `listen` override (docs/spec.md §7.2, D13, D30) with real processes found through registry
// files, never stdout. A detached runner runs in its own session, survives a pipod SIGKILL, keeps delivering on its
// own port, enforces its own lifetime and stall detection (journaled) while no engine runs, and the next engine adopts
// the same pid. Shutdown leaves detached runners running. A `listen` override lands in the registry and is reused by
// a crash restart and a later start; a taken port is refused naming the pipeline or process holding it.
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, readRegistryEntry } from "@pipo/runner";
import { EngineError, type EngineEvent, readEngineEntry, Supervisor } from "../src";
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

async function open(home: string, events?: EngineEvent[]) {
  const engine = await Supervisor.open({
    home,
    config: testConfig({ backoff: 200 }),
    log: () => {},
    onEvent: events && ((e) => events.push(e)),
  });
  engines.push(engine);
  return engine;
}

/** A port nothing listens on right now. */
function freePort(): number {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = s.port as number;
  s.stop(true);
  return port;
}

/**
 * The session id of `pid`: a runner started in its own session is its session's leader. Off Linux, the process group:
 * setsid makes the leader its group's leader too, and a plain child shares its parent's.
 */
function session(pid: number): number {
  if (process.platform !== "linux") return Number(Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)]).stdout);
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]);
}

const lines = (path: string): { packet_id: string; data: any }[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

const httpFile = (name: string, listen?: number) =>
  box.write(
    `${name}.pipo`,
    `pipo: 1
name: ${name}
input:
  via: http
  with: { path: /hook, respond: delivered, timeout: 10s${listen ? `, listen: ${listen}` : ""} }
output: { from: input, to: file, with: { path: ./${name}.jsonl, format: jsonl } }
`,
  );
const pushFile = (name: string, extra = "") =>
  box.write(
    `${name}.pipo`,
    `pipo: 1\nname: ${name}\ninput: { via: push }\noutput: { from: input, to: file, with: { path: ./${name}.jsonl, format: jsonl } }\n${extra}`,
  );

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("listen override: saved in the registry, reused by a crash restart and a later start; taken ports are refused naming the holder", async () => {
  const home = join(box.root, "ports");
  const engine = await open(home);
  const port = freePort();
  // The file names another port: the start option wins.
  const a = httpFile("porta", freePort());
  const info = await engine.start(a, { listen: port });
  expect(info).toMatchObject({ state: "running", listen: port });
  expect(readRegistryEntry(home, "porta")).toMatchObject({ pid: info.pid, listen: port });
  expect((await post(`http://127.0.0.1:${port}/in/porta/hook`, { n: 1 })).status).toBe(200);

  // A crash restart reuses the saved port.
  process.kill(info.pid as number, "SIGKILL");
  const again = await waitFor(
    () => {
      const r = engine.get("porta");
      return r?.state === "running" && r.pid !== info.pid ? r : null;
    },
    40_000,
    "porta restarted",
  );
  expect(again.listen).toBe(port);
  expect(readRegistryEntry(home, "porta")).toMatchObject({ pid: again.pid, listen: port });
  expect((await post(`http://127.0.0.1:${port}/in/porta/hook`, { n: 2 })).status).toBe(200);

  // Another pipeline on that port is refused, naming the pipeline and its runner; nothing of it is left behind.
  const b = httpFile("portb");
  const taken = await engine.start(b, { listen: port }).catch((e) => e);
  expect(taken).toBeInstanceOf(EngineError);
  expect(taken.code).toBe("conflict");
  expect(taken.message).toBe(
    `can't start 'portb': port ${port} is in use by pipeline 'porta' (runner pid ${again.pid})`,
  );
  expect(taken.hint).toContain("--listen <port>");
  expect(engine.get("portb")).toBeUndefined();
  expect(readRegistryEntry(home, "portb")).toBeNull();

  // A port in the file held by some other process: refused, naming that process (this test, here).
  const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") });
  try {
    const c = httpFile("portc", blocker.port as number);
    const held = await engine.start(c).catch((e) => e);
    expect(held).toBeInstanceOf(EngineError);
    // The holder is named from /proc (Linux only, spec D30).
    expect(held.message).toContain(
      process.platform === "linux"
        ? `can't start 'portc': port ${blocker.port} is in use by pid ${process.pid}`
        : `can't start 'portc': port ${blocker.port} is in use by another process (not identified)`,
    );
    expect(engine.get("portc")).toBeUndefined();
  } finally {
    blocker.stop(true);
  }

  // `listen` only means something for an http input.
  await expect(engine.start(pushFile("portd"), { listen: freePort() })).rejects.toThrow(
    "a listen port only applies to an http input",
  );

  // Stopped and started again by name: the saved port is used again.
  await engine.stop("porta");
  expect(readRegistryEntry(home, "porta")).toBeNull();
  const later = await engine.start("porta");
  expect(later.listen).toBe(port);
  expect(readRegistryEntry(home, "porta")).toMatchObject({ pid: later.pid, listen: port });
  await engine.shutdown();
  expect(lines(join(box.root, "porta.jsonl")).map((r) => r.data.n)).toEqual([1, 2]);
}, 120_000);

test("shutdown leaves a detached runner running in its own session; the next engine adopts that pid and can stop it", async () => {
  const home = join(box.root, "leave");
  const file = pushFile("kept");
  const first = await open(home);
  const info = await first.start(file, { detached: true });
  const pid = info.pid as number;
  runnerPids.push(pid);
  expect(info).toMatchObject({ state: "running", detached: true });
  expect(readRegistryEntry(home, "kept")).toMatchObject({ pid, detached: true, engine_id: first.engineId });
  expect(session(pid)).toBe(pid);
  // A plain runner shares the engine's session; only a detached one gets its own.
  const plain = await first.start(pushFile("plain"));
  expect(plain.detached).toBe(false);
  expect(session(plain.pid as number)).toBe(session(process.pid));

  await first.shutdown();
  expect(readEngineEntry(home)).toBeNull();
  expect(isRunning(pid)).toBe(true);
  expect(readRegistryEntry(home, "kept")).toMatchObject({ pid, detached: true });
  expect(isRunning(plain.pid as number)).toBe(false);
  expect(readRegistryEntry(home, "plain")).toBeNull();
  expect(readFileSync(join(home, "logs", "kept.log"), "utf8")).toContain(`runner pid ${pid} keeps running (detached)`);

  const second = await open(home);
  expect(second.get("kept")).toMatchObject({ state: "running", adopted: true, pid, detached: true, restarts: 0 });
  const { packet_id } = await second.request<{ packet_id: string }>("kept", "push", { data: { n: 1 } });
  await waitFor(() => lines(join(box.root, "kept.jsonl")).some((r) => r.packet_id === packet_id), 10_000, "delivery");
  await second.stop("kept");
  expect(isRunning(pid)).toBe(false);
  expect(readRegistryEntry(home, "kept")).toBeNull();
  await second.shutdown();
}, 90_000);

test("pipod SIGKILL: detached runners keep delivering and enforce their own lifetime and stall; the next engine adopts the same pid", async () => {
  const home = join(box.root, "pipod");
  await Bun.write(join(home, "config.yaml"), "engine:\n  listen: 0\n  detached: true\n");
  const port = freePort();
  const hooks = httpFile("hooks");
  // No engine needed to end it: a ttl, and a stall while a packet waits for an ack that never comes.
  const life = pushFile(
    "life",
    "lifetime: { ttl: 8s, on_end: stop }\ndelivered: { check: external, within: 1m, stall: { after: 300ms } }\n",
  );
  const { proc, value: gw } = await spawnPipod(
    box.root,
    spawned,
    home,
    [],
    () => {
      const e = readEngineEntry(home);
      return e?.listen ? `http://127.0.0.1:${e.listen}` : null;
    },
    "detached",
    50_000,
  );
  await waitFor(
    async () => ((await (await fetch(`${gw}/api/engine`)).json()) as { ready: boolean }).ready,
    20_000,
    "gateway ready",
  );
  // What the CLI sends for `pipo start <file> --detached --listen <port>`.
  const started = await post(`${gw}/api/pipelines`, { file: hooks, detached: true, listen: port });
  expect(started.status).toBe(201);
  expect(await started.json()).toMatchObject({ name: "hooks", state: "running", detached: true, listen: port });
  // engine.detached: true makes every start detached.
  const lifeStarted = await post(`${gw}/api/pipelines`, { file: life });
  expect(lifeStarted.status).toBe(201);
  expect(await lifeStarted.json()).toMatchObject({ name: "life", state: "running", detached: true });
  const hooksEntry = readRegistryEntry(home, "hooks");
  const lifeEntry = readRegistryEntry(home, "life");
  if (!hooksEntry || !lifeEntry) throw new Error("registry entries missing");
  runnerPids.push(hooksEntry.pid, lifeEntry.pid);
  expect(hooksEntry).toMatchObject({ detached: true, listen: port });
  expect(lifeEntry).toMatchObject({ detached: true });
  expect(session(hooksEntry.pid)).toBe(hooksEntry.pid);
  // Through the gateway first, while the engine is up.
  expect((await post(`${gw}/in/hooks/hook`, { n: 1 })).status).toBe(200);

  proc.kill("SIGKILL");
  await proc.exited;
  const killedAt = Date.now();
  expect(isRunning(hooksEntry.pid)).toBe(true);
  expect(isRunning(lifeEntry.pid)).toBe(true);

  // With no engine, the runner's own port still delivers.
  const direct = await post(`http://127.0.0.1:${port}/in/hooks/hook`, { n: 2 });
  expect(direct.status).toBe(200);
  const directReply = (await direct.json()) as { packet_id: string; state: string };
  expect(directReply.state).toBe("delivered");

  // The runner flags the stall itself and journals it, then stops itself when its ttl ends.
  const client = await ControlClient.connect(lifeEntry.socket as string);
  await client.request("push", { data: { n: 1 } });
  client.close();
  const lifeJournal = join(home, "pipelines", "life", "journal.db");
  await waitFor(
    () => query(lifeJournal, "SELECT at FROM events WHERE type = 'pipeline.stall'")?.length,
    10_000,
    "stall journaled",
  );
  await waitFor(() => !isRunning(lifeEntry.pid) && !readRegistryEntry(home, "life"), 20_000, "life ended on ttl");
  const ends = query(
    lifeJournal,
    "SELECT type, at FROM events WHERE type IN ('pipeline.stall', 'pipeline.stopped') ORDER BY seq",
  );
  expect(ends?.map((e) => e.type)).toEqual(["pipeline.stall", "pipeline.stopped"]);
  expect(ends?.every((e) => e.at >= killedAt)).toBe(true);

  // The next engine adopts the same runner: no second one, no kill, nothing restarted.
  const events: EngineEvent[] = [];
  const engine = await open(home, events);
  expect(engine.get("hooks")).toMatchObject({
    state: "running",
    adopted: true,
    pid: hooksEntry.pid,
    detached: true,
    listen: port,
    restarts: 0,
  });
  expect(engine.get("life")).toBeUndefined();
  const { packet_id } = await engine.request<{ packet_id: string }>("hooks", "push", { data: { n: 3 } });
  await waitFor(
    () => events.some((e) => e.packet_id === packet_id && e.type === "packet.delivered"),
    10_000,
    "live event after reattach",
  );
  // The events written while no engine ran are replayed, the direct delivery included.
  expect(events.some((e) => e.packet_id === directReply.packet_id && e.type === "packet.delivered")).toBe(true);
  const out = lines(join(box.root, "hooks.jsonl"));
  expect(out.map((r) => r.data.n)).toEqual([1, 2, 3]);
  expect(new Set(out.map((r) => r.packet_id)).size).toBe(3);

  await engine.stop("hooks");
  expect(isRunning(hooksEntry.pid)).toBe(false);
  await engine.shutdown();
}, 150_000);
