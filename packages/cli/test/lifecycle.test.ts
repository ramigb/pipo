// `pipo start|stop|pause|resume|restart|status|logs` (docs/spec.md §6, §7.2) in-process against a real engine started
// on demand in a sandbox home (found through run/engine.json), and with --no-engine against a runner started directly.
// Subprocess output goes to files, never a pipe. An engine or runner that never comes up is retried once.
// The engine is started with --listen 0 (config.yaml is never written); once it sleeps (§7.5, D31) the next command
// starts a new one.
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runner } from "@pipo/runner";
import { sandbox, waitFor } from "../../runner/test/helpers";
import { main } from "../src/cli";
import { cmdLogs, findEngine } from "../src/lifecycle";

const sb = sandbox();
const pids: number[] = [];
let runner: Runner | undefined;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleepyHome = join(sb.root, "sleepy-home");
afterAll(async () => {
  await runner?.stop().catch(() => {});
  for (const path of [
    ...["engine.json", "pushy.json", "direct.json"].map((f) => join(sb.home, "run", f)),
    join(sleepyHome, "run", "engine.json"),
    join(sleepyHome, "run", "napper.json"),
  ]) {
    if (existsSync(path)) pids.push(JSON.parse(readFileSync(path, "utf8")).pid);
  }
  for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
  sb.cleanup();
});

type Result = { code: number; stdout: string; stderr: string };
async function pipo(...args: string[]): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await main(args);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } catch (e) {
    return { code: 1, stdout: out.join("\n"), stderr: `${err.join("\n")}\n${(e as Error).message}` };
  } finally {
    console.log = log;
    console.error = error;
  }
}
const json = (r: Result) => JSON.parse(r.stdout);

const pipe = (name: string) =>
  sb.write(
    `${name}.pipo`,
    `pipo: 1\nname: ${name}\ninput: { via: push }\noutput: { from: input, to: file, with: { path: ./${name}.jsonl } }\n`,
  );
const H = ["--home", sb.home];

test("start → status → pause → resume → stop against an engine started on demand", async () => {
  const file = pipe("pushy");
  // The first start launches the engine; retry once if it never comes up (/mnt load hang).
  let started = await pipo("start", file, ...H, "--json");
  if (started.code !== 0 && /did not come up|not reachable/.test(started.stderr)) {
    started = await pipo("start", file, ...H, "--json");
  }
  expect(started.stderr).not.toContain("engine: down");
  expect(started.code).toBe(0);
  expect(json(started)).toMatchObject({ ok: true, engine: "up", pipeline: "pushy" });
  expect(existsSync(join(sb.home, "logs", "engine.log"))).toBe(true);

  const status = await pipo("status", ...H);
  expect(status.code).toBe(0);
  expect(status.stdout).toMatch(/^PIPELINE +STATE +VER +UPTIME/);
  expect(status.stdout).toMatch(/^pushy +active +v1 /m);
  expect(status.stdout).not.toContain("engine: down");
  const sj = json(await pipo("status", "pushy", ...H, "--json"));
  expect(sj.engine).toBe("up");
  expect(sj.pipelines[0].name).toBe("pushy");
  // The gateway passes the runner's status through, built-in metrics included (§7.6, D54).
  expect(sj.pipelines[0].runner.stats).toMatchObject({
    latency: { output: { count: 0, p50_ms: null } },
    latency_window: 100,
    oldest_pending_age_ms: null,
    oldest_pending_received_at: null,
  });

  expect((await pipo("pause", "pushy", ...H)).stdout).toContain("paused pushy");
  expect(json(await pipo("status", "pushy", ...H, "--json")).pipelines[0].runner.state).toBe("paused");
  expect((await pipo("resume", "pushy", ...H, "--json")).code).toBe(0);
  expect(json(await pipo("status", "pushy", ...H, "--json")).pipelines[0].runner.state).toBe("active");

  const restart = await pipo("restart", "pushy", ...H);
  expect(restart.code).toBe(0);
  expect(restart.stdout).toContain("restarted pushy");
  expect(json(await pipo("status", "pushy", ...H, "--json")).pipelines[0].state).toBe("running");

  const stop = await pipo("stop", "pushy", ...H, "--now", "--json");
  expect(stop.code).toBe(0);
  await waitFor(
    async () => json(await pipo("status", "pushy", ...H, "--json")).pipelines[0].state !== "running",
    15_000,
    "pushy to stop",
  );

  const missing = await pipo("status", "nope", ...H);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("no pipeline named 'nope'");
}, 90_000);

test("start rejects a bad port and a missing target with usage", async () => {
  expect((await pipo("start", ...H)).code).toBe(64);
  const bad = await pipo("start", "x.pipo", "--listen", "abc", ...H);
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain("not a port");
  expect((await pipo("stop")).code).toBe(64);
});

test("--no-engine talks to a runner's control socket and marks output engine: down", async () => {
  const file = pipe("direct");
  for (let attempt = 0; !runner; attempt++) {
    try {
      runner = await Runner.open({ file, home: sb.home, listen: 0, log: () => {} });
      await runner.start();
    } catch (e) {
      runner = undefined;
      if (attempt > 0) throw e;
    }
  }
  const status = await pipo("status", "--no-engine", ...H);
  expect(status.stdout).toMatch(/^direct +active +v1 /m);
  expect(status.stdout).toContain("engine: down");
  const sj = json(await pipo("status", "direct", "--no-engine", "--json", ...H));
  expect(sj.engine).toBe("down");
  expect(sj.pipelines[0].pipeline).toBe("direct");

  const paused = await pipo("pause", "direct", "--no-engine", ...H);
  expect(paused.stdout).toContain("paused direct");
  expect(paused.stdout).toContain("engine: down");
  expect(runner.state).toBe("paused");
  const resumed = json(await pipo("resume", "direct", "--no-engine", "--json", ...H));
  expect(resumed).toMatchObject({ ok: true, engine: "down", pipeline: "direct" });
  expect(runner.state).toBe("active");

  const nope = await pipo("pause", "ghost", "--no-engine", ...H);
  expect(nope.code).toBe(1);
  expect(nope.stderr).toContain("no runner registered for 'ghost'");
  expect((await pipo("start", pipe("other"), "--no-engine", ...H)).stderr).toContain("without the engine");

  const stopped = await pipo("stop", "direct", "--no-engine", "--now", ...H);
  expect(stopped.code).toBe(0);
  await waitFor(() => runner?.state === "stopped", 10_000, "runner to stop");
}, 60_000);

test("logs prints a pipeline's log, filters by node and follows", async () => {
  const log = join(sb.home, "logs", "talky.log");
  writeFileSync(log, "t1 INFO [talky] node enrich ok\nt2 INFO [talky] node other ok\n");
  const lines: string[] = [];
  const { log: realLog } = console;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    expect(await cmdLogs(["talky", "--node", "enrich", ...H, "--no-engine"])).toBe(0);
    expect(lines).toEqual(["t1 INFO [talky] node enrich ok"]);
    lines.length = 0;
    const ctl = new AbortController();
    const done = cmdLogs(["talky", "-f", ...H, "--no-engine"], ctl.signal);
    appendFileSync(log, "t3 INFO [talky] later\n");
    await waitFor(() => lines.includes("t3 INFO [talky] later"), 5000, "followed line");
    ctl.abort();
    expect(await done).toBe(0);
  } finally {
    console.log = realLog;
  }
  const missing = await pipo("logs", "ghost", ...H, "--no-engine");
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("no log for 'ghost'");
});

test("the CLI starts the engine with --listen 0 (config.yaml untouched); after it sleeps the next command starts it again", async () => {
  const home = sleepyHome;
  mkdirSync(home, { recursive: true });
  const cfg = "engine:\n  idle: 1s\n";
  writeFileSync(join(home, "config.yaml"), cfg);
  const engineEntry = () => {
    const path = join(home, "run", "engine.json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { pid: number; listen: number }) : null;
  };
  const file = pipe("napper");
  let started = await pipo("start", file, "--home", home, "--json");
  if (started.code !== 0 && /did not come up|not reachable/.test(started.stderr)) {
    started = await pipo("start", file, "--home", home, "--json");
  }
  expect(started.code).toBe(0);
  expect(json(started)).toMatchObject({ engine: "up", pipeline: "napper" });
  const first = engineEntry();
  expect(first?.listen).toBeGreaterThan(0);
  pids.push(first?.pid as number);
  expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(cfg);

  expect((await pipo("stop", "napper", "--now", "--home", home)).code).toBe(0);
  // Nothing left to run: after engine.idle the engine sleeps and removes its entry.
  await waitFor(() => !engineEntry() && !alive(first?.pid as number), 20_000, "the engine to sleep");

  let status = await pipo("status", "--home", home, "--json");
  if (status.code !== 0 || json(status).engine !== "up") status = await pipo("status", "--home", home, "--json");
  expect(json(status)).toMatchObject({ ok: true, engine: "up", pipelines: [] });
  const second = engineEntry();
  pids.push(second?.pid as number);
  expect(second?.pid).not.toBe(first?.pid);
  await waitFor(() => !engineEntry(), 20_000, "the new engine to sleep");
}, 120_000);

test.if(process.platform === "linux")("an engine.json whose pid was reused is no engine (D27)", async () => {
  const home = join(sb.root, "reused-home");
  mkdirSync(join(home, "run"), { recursive: true });
  const other = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  try {
    const entry = { engine_id: "e_old", pid: other.pid, home, listen: 1 };
    const write = (startedAt: string) =>
      writeFileSync(join(home, "run", "engine.json"), JSON.stringify({ ...entry, started_at: startedAt }));
    write(new Date().toISOString());
    expect(findEngine(home)).toEqual({ port: 1, pid: other.pid });
    write(new Date(Date.now() - 3600_000).toISOString());
    expect(findEngine(home)).toBeNull();
  } finally {
    other.kill("SIGKILL");
  }
});
