// `pipo runners`, `pipo attach`, `pipo engine start|stop|status` and the --json error shape (docs/spec.md §6, §7.2,
// D35) in-process against a real engine in a sandbox home (found through run/engine.json). The engine and its
// detached runner are killed by pid at the end. Subprocess output goes to files, never a pipe.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runner } from "@pipo/runner";
import { pidsWith, sandbox, waitFor } from "../../runner/test/helpers";
import { main, runCli } from "../src/cli";

const sb = sandbox();
const pids: number[] = [];
let direct: Runner | undefined;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const entryPid = (home: string, name: string): number | null => {
  const path = join(home, "run", `${name}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).pid : null;
};
const procsWithHome = (root: string): number[] => pidsWith(root);
afterAll(async () => {
  await direct?.stop().catch(() => {});
  for (const home of [sb.home, join(sb.root, "up-home")]) {
    for (const name of ["engine", "dlive"]) {
      const pid = entryPid(home, name);
      if (pid) pids.push(pid);
    }
  }
  // Engines whose start timed out (or that a retry orphaned) never reach a registry entry: find them by home.
  for (const pid of procsWithHome(sb.root)) pids.push(pid);
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
    const code = await runCli(args);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
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

test("--help exits 0 for runners, attach and engine, and they are no longer planned", async () => {
  for (const c of ["runners", "attach", "engine"]) {
    const r = await pipo(c, "--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`pipo ${c}`);
    expect(r.stdout).not.toContain("Not implemented");
  }
  const h = await pipo("help");
  expect(h.stdout).toContain("pipo runners");
  expect(h.stdout).not.toMatch(/Planned.*(runners|attach|engine)/);
  for (const c of ["start", "stop", "status", "pause", "resume", "restart"]) {
    expect((await pipo(c, "--help")).stdout).toContain("--no-engine");
  }
});

test("without an engine: runners reads the registry and sockets, engine status and stop say down", async () => {
  const H = ["--home", sb.home];
  expect((await pipo("runners", ...H)).stdout).toBe("no runners found\nengine: down");
  const file = pipe("dlive");
  for (let attempt = 0; !direct; attempt++) {
    try {
      direct = await Runner.open({ file, home: sb.home, listen: 0, log: () => {} });
      await direct.start();
    } catch (e) {
      direct = undefined;
      if (attempt > 0) throw e;
    }
  }
  const run = join(sb.home, "run");
  const entry = JSON.parse(readFileSync(join(run, "dlive.json"), "utf8"));
  writeFileSync(join(run, "ghost.json"), JSON.stringify({ ...entry, pipeline: "ghost", pid: 4194000, listen: null }));
  writeFileSync(
    join(run, "mute.json"),
    JSON.stringify({ ...entry, pipeline: "mute", socket: join(sb.root, "none.sock") }),
  );

  const table = await pipo("runners", ...H);
  expect(table.code).toBe(0);
  expect(table.stdout).toMatch(/^NAME +PID +PORT +VERSION +STATE/);
  expect(table.stdout).toMatch(new RegExp(`^dlive +${process.pid} +- +v1 +detached$`, "m"));
  expect(table.stdout).toMatch(/^ghost +4194000 +- +v1 +stale +⚠ .*pipo attach ghost/m);
  expect(table.stdout).toMatch(/^mute +\d+ +- +v1 +unreachable +⚠ .*pipo attach mute/m);
  expect(table.stdout).toMatch(/engine: down$/);

  const j = json(await pipo("runners", "--no-engine", "--json", ...H));
  expect(j.engine).toBe("down");
  expect(j.runners.map((r: any) => [r.name, r.state])).toEqual([
    ["dlive", "detached"],
    ["ghost", "stale"],
    ["mute", "unreachable"],
  ]);

  expect((await pipo("engine", "status", ...H)).stdout).toBe("engine: down");
  expect(json(await pipo("engine", "status", "--json", ...H))).toEqual({ ok: true, engine: "down" });
  expect(json(await pipo("engine", "stop", "--json", ...H))).toMatchObject({
    ok: true,
    engine: "down",
    stopped: false,
  });
  expect((await pipo("engine", "bogus")).code).toBe(64);
});

test("engine start, status, runners, attach and stop; a detached runner survives the stop", async () => {
  const home = join(sb.root, "up-home");
  mkdirSync(home, { recursive: true });
  const H = ["--home", home];
  let started = await pipo("engine", "start", "--ttl", "8h", "--listen", "0", "--json", ...H);
  if (started.code !== 0 && /did not come up/.test(started.stderr + started.stdout)) {
    started = await pipo("engine", "start", "--ttl", "8h", "--listen", "0", "--json", ...H);
  }
  expect(started.code).toBe(0);
  expect(json(started)).toMatchObject({ ok: true, engine: "up", result: "started" });
  const enginePid = json(started).pid as number;
  pids.push(enginePid);

  const again = await pipo("engine", "start", "--ttl", "1h", ...H);
  expect(again.stdout).toContain("already running");
  expect(again.stdout).toContain("stop it first");

  const status = json(await pipo("engine", "status", "--json", ...H));
  expect(status).toMatchObject({ ok: true, engine: "up", pid: enginePid, state: "ready", pipelines: 0, idle: true });
  expect(Date.parse(status.ttl_expires_at) - Date.parse(status.started_at)).toBe(8 * 3600_000);
  const text = await pipo("engine", "status", ...H);
  expect(text.stdout).toMatch(/^engine: up \(ready\)\npid \d+ · gateway 127\.0\.0\.1:\d+ · uptime \d+s\n/);
  expect(text.stdout).toContain("pipelines 0 · idle yes · ttl expires ");

  const file = pipe("dlive");
  const s = await pipo("start", file, "--detached", "--json", ...H);
  expect(s.code).toBe(0);
  const runners = json(await pipo("runners", "--json", ...H));
  expect(runners.engine).toBe("up");
  expect(runners.runners).toMatchObject([{ name: "dlive", state: "attached", detached: true, version: 1 }]);
  expect((await pipo("runners", ...H)).stdout).toMatch(/^dlive +\d+ +- +v1 +attached$/m);
  expect(json(await pipo("engine", "status", "--json", ...H))).toMatchObject({ pipelines: 1, idle: false });

  // A bad --ttl is refused before restart stops anything (D57); a good one reaches the runner's registry entry.
  const before = entryPid(home, "dlive");
  const badTtl = await pipo("restart", "dlive", "--ttl", "soon", "--json", ...H);
  expect(badTtl.code).toBe(1);
  expect(json(badTtl)).toMatchObject({
    ok: false,
    code: "bad_request",
    error: "--ttl 'soon' is not a duration",
    hint: "use for example 30m, 8h or 2d",
  });
  expect(entryPid(home, "dlive")).toBe(before);
  expect(alive(before as number)).toBe(true);
  const ttl = await pipo("restart", "dlive", "--ttl", "1h", "--json", ...H);
  expect(ttl.code).toBe(0);
  const entry = JSON.parse(readFileSync(join(home, "run", "dlive.json"), "utf8"));
  expect(entry).toMatchObject({ ttl: "1h", detached: true });
  expect(entry.pid).not.toBe(before);
  expect(json(ttl).result).toMatchObject({ name: "dlive", ttl: "1h", detached: true });

  const attach = json(await pipo("attach", "dlive", "--json", ...H));
  expect(attach).toMatchObject({ ok: true, engine: "up", results: [{ name: "dlive", outcome: "supervised" }] });
  const attachText = await pipo("attach", ...H);
  expect(attachText.stdout).toMatch(/^dlive +supervised +/);
  const missing = await pipo("attach", "nope", ...H);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("no runner registered for 'nope'");

  const ui = await pipo("ui", "--no-open", ...H);
  expect(ui.code).toBe(0);
  expect(ui.stdout).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ui$/);
  expect((await fetch(ui.stdout)).headers.get("content-type")).toContain("text/html");

  const stop = await pipo("engine", "stop", ...H);
  expect(stop.code).toBe(0);
  expect(stop.stdout).toContain(`engine stopped (pid ${enginePid})`);
  expect(stop.stdout).toContain("detached runners keep running");
  expect(existsSync(join(home, "run", "engine.json"))).toBe(false);
  expect((await pipo("engine", "status", ...H)).stdout).toBe("engine: down");

  const after = json(await pipo("runners", "--json", ...H));
  expect(after).toMatchObject({ engine: "down", runners: [{ name: "dlive", state: "detached" }] });
  expect(alive(after.runners[0].pid)).toBe(true);

  // attach starts an engine on demand, which adopts the surviving runner.
  let adopted = await pipo("attach", "--json", ...H);
  if (adopted.code !== 0 && /did not come up|not reachable/.test(adopted.stderr + adopted.stdout)) {
    adopted = await pipo("attach", "--json", ...H);
  }
  expect(adopted.code).toBe(0);
  expect(json(adopted).results[0]).toMatchObject({ name: "dlive", pid: after.runners[0].pid });
  await waitFor(
    async () => json(await pipo("runners", "--json", ...H)).runners[0].state === "attached",
    10_000,
    "attached",
  );
  const next = json(await pipo("engine", "status", "--json", ...H)).pid as number;
  pids.push(next);
  expect((await pipo("engine", "stop", ...H)).code).toBe(0);
  await pipo("stop", "dlive", "--now", "--no-engine", ...H);
}, 120_000);

test("--listen: 0 is refused with the API's message; --json errors are machine-readable", async () => {
  const zero = await pipo("start", "x.pipo", "--listen", "0", "--home", sb.home);
  expect(zero.code).toBe(1);
  expect(zero.stderr).toContain("bad listen 0");
  expect(zero.stderr).toContain("use a port from 1 to 65535");
  const j = await pipo("start", "x.pipo", "--listen", "0", "--json", "--home", sb.home);
  expect(j.code).toBe(1);
  expect(j.stderr).toBe("");
  expect(json(j)).toEqual({
    ok: false,
    error: "bad listen 0",
    hint: "use a port from 1 to 65535",
    code: "bad_request",
  });
  const flag = await pipo("start", "--nope", "--json");
  expect(flag.code).toBe(64);
  expect(json(flag)).toMatchObject({ ok: false, code: "usage" });
  expect(typeof main).toBe("function");
});

test("pipo ui starts the engine when none runs, and reuses a running one (D61)", async () => {
  const home = join(sb.root, "ui-home");
  const first = await pipo("ui", "--no-open", "--json", "--home", home, "--workspace", sb.root);
  expect(first.code).toBe(0);
  const a = json(first);
  expect(a).toMatchObject({ ok: true, started: true, workspace: sb.root, engine_outdated: false });
  expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ui$/);
  const page = await fetch(a.url);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<title>Pipo</title>");
  const again = await pipo("ui", "--no-open", "--home", home);
  expect(again.code).toBe(0);
  expect(again.stdout).toBe(a.url);
  expect(again.stderr).not.toContain("started the engine");
  expect(again.stderr).not.toContain("older than");
  const elsewhere = await pipo("ui", "--no-open", "--home", home, "--workspace", join(sb.root, "other"));
  expect(elsewhere.stderr).toContain(`saves new pipelines under ${sb.root}`);
  pids.push(a.pid);
});
