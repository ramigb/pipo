// Gateway rules the CLI relies on (docs/spec.md §7.1, D35): GET /api/engine reports pipelines and idle, POST
// /api/pipelines and /start name unknown body keys (400 bad_request), refuse a bad `ttl` with a hint, refuse listen 0,
// and pass a `ttl` override to this start only (D57).
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Supervisor } from "../src";
import { isAlive, sandbox, testConfig } from "./helpers";

const box = sandbox();
let engine: Supervisor | undefined;
const pids: number[] = [];
afterAll(async () => {
  if (engine) {
    for (const r of engine.list()) if (r.pid) pids.push(r.pid);
    await Promise.race([engine.shutdown({ now: true }), Bun.sleep(10_000)]);
  }
  for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  box.cleanup();
});

const file = box.write(
  "cli-gw.pipo",
  "pipo: 1\nname: cli-gw\ninput: { via: push }\noutput: { from: input, to: file, with: { path: ./cli-gw.jsonl } }\n",
);
const post = async (url: string, body: unknown = {}) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

test("engine info, strict start bodies, ttl and listen refusals, a ttl for one start", async () => {
  engine = await Supervisor.open({
    home: join(box.root, "home"),
    config: { ...testConfig(), listen: 0 },
    log: () => {},
  });
  const base = engine.gateway?.url as string;

  const info = await (await fetch(`${base}/api/engine`)).json();
  expect(info).toMatchObject({
    ready: true,
    stopping: false,
    pipelines: 0,
    idle: true,
    ttl_expires_at: null,
    code_changed: false,
  });

  const unknown = await post(`${base}/api/pipelines`, { file, listen: 8080, color: "red", ttl: undefined, extra: 1 });
  expect(unknown.status).toBe(400);
  expect(unknown.body).toMatchObject({ code: "bad_request" });
  expect(unknown.body.error).toContain("`color`, `extra`");
  expect(unknown.body.hint).toContain("`file`, `listen`, `detached`, `ttl`");

  for (const [ttl, error] of [
    ["soon", "ttl 'soon' is not a duration"],
    ["0s", "ttl '0s' must be longer than 0"],
    [30, "`ttl` must be a string, got 30"],
  ] as const) {
    const bad = await post(`${base}/api/pipelines`, { file, ttl });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: "bad_request", error });
  }
  expect(engine.get("cli-gw")).toBeUndefined();

  const zero = await post(`${base}/api/pipelines`, { file, listen: 0 });
  expect(zero.status).toBe(400);
  expect(zero.body).toMatchObject({ error: "bad listen 0", hint: "use a port from 1 to 65535" });

  const created = await post(`${base}/api/pipelines`, { file, ttl: "1h" });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ name: "cli-gw", state: "running", ttl: "1h" });
  expect((await (await fetch(`${base}/api/pipelines/cli-gw`)).json()) as any).toMatchObject({ ttl: "1h" });
  expect((await (await fetch(`${base}/api/engine`)).json()) as any).toMatchObject({ pipelines: 1, idle: false });

  const badStart = await post(`${base}/api/pipelines/cli-gw/start`, { file: "x.pipo" });
  expect(badStart.status).toBe(400);
  expect(badStart.body.error).toContain("unknown key `file`");
  expect(badStart.body.hint).toContain("`listen`, `detached`, `ttl`");

  const stop = await post(`${base}/api/pipelines/cli-gw/stop`, { now: true });
  expect(stop.status).toBe(200);
  expect(stop.body).toMatchObject({ state: "stopped", ttl: "1h" });
  // The override was for that start only: the next start without one goes back to the file's (none here).
  const again = await post(`${base}/api/pipelines/cli-gw/start`, {});
  expect(again.status).toBe(200);
  expect(again.body).toMatchObject({ state: "running", ttl: null });
  const stopAgain = await post(`${base}/api/pipelines/cli-gw/stop`, { now: true });
  expect(stopAgain.status).toBe(200);
}, 60_000);
