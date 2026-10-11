// `pipo owner` and `pipo owner reset` (docs/spec.md §6, D84) in-process: on a home without an engine (create, reset,
// --rotate-key, --json, the errors), then against a real engine in its default owner mode: the CLI's own commands
// pass with the engine key, `pipo ui --no-open` points at the setup page with the code, and a reset ends the
// dashboard's sessions. The engine is killed by pid at the end.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readEngineKey, readOwner } from "@pipo/runner";
import { pidsWith, sandbox } from "../../runner/test/helpers";
import { runCli } from "../src/cli";

setDefaultTimeout(60_000);
const sb = sandbox();
afterAll(() => {
  const entry = join(sb.home, "run", "engine.json");
  const pids = pidsWith(sb.root);
  if (existsSync(entry)) pids.push(JSON.parse(readFileSync(entry, "utf8")).pid);
  for (const pid of pids)
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  sb.cleanup();
});

type Result = { code: number; stdout: string; stderr: string };
async function pipo(args: string[], stdin?: string): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  const text = Bun.stdin.text;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  if (stdin !== undefined) (Bun.stdin as any).text = async () => stdin;
  try {
    const code = await runCli(args);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
    (Bun.stdin as any).text = text;
  }
}
const json = (r: Result) => JSON.parse(r.stdout);

test("pipo owner reset creates the owner, sets new passwords, and needs a username first", async () => {
  const home = join(sb.root, "cli-only");
  const none = json(await pipo(["owner", "--home", home, "--json"]));
  expect(none).toMatchObject({ ok: true, mode: "owner", owner: null, sessions: 0, mail: false });

  const noName = await pipo(["owner", "reset", "--home", home, "--password-stdin", "--json"], "long enough pw");
  expect(noName.code).not.toBe(0);
  expect(json(noName).hint).toContain("--username");

  const short = await pipo(
    ["owner", "reset", "--home", home, "--username", "ada", "--password-stdin", "--json"],
    "short",
  );
  expect(json(short).error).toContain("10 characters");

  const created = await pipo(
    ["owner", "reset", "--home", home, "--username", "ada", "--password-stdin", "--json"],
    "long enough pw\n",
  );
  expect(json(created)).toEqual({ ok: true, owner: "ada", created: true, sessions_ended: false, key_rotated: false });
  expect(await Bun.password.verify("long enough pw", readOwner(home)?.password_hash as string)).toBe(true);

  const key = readEngineKey(home);
  const again = await pipo(
    ["owner", "reset", "--home", home, "--password-stdin", "--rotate-key", "--json"],
    "another password",
  );
  expect(json(again)).toMatchObject({ owner: "ada", created: false, sessions_ended: true, key_rotated: true });
  expect(readOwner(home)?.epoch).toBe(2);
  expect(readEngineKey(home)).not.toBe(key);

  const shown = await pipo(["owner", "--home", home]);
  expect(shown.stdout).toContain("owner     ada");
  expect(shown.stdout).toContain("pipo owner reset");
  expect((await pipo(["owner", "nope", "--home", home])).code).not.toBe(0);
});

test("against an engine in owner mode: the CLI uses the key, pipo ui opens the setup page, a reset logs browsers out", async () => {
  const home = sb.home;
  const ui = json(await pipo(["ui", "--home", home, "--no-open", "--json"]));
  expect(ui.owner_setup).toBe(true);
  expect(ui.url).toMatch(/\/ui\/#\/setup\/[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
  const code = ui.url.split("/").pop();
  const base = ui.url.replace(/\/ui\/.*$/, "");

  // The CLI's own commands go through with the engine key.
  const status = await pipo(["status", "--home", home, "--json"]);
  expect(json(status)).toMatchObject({ ok: true, engine: "up" });
  // A browser without a session gets nothing.
  expect((await fetch(`${base}/api/pipelines`)).status).toBe(401);

  const setup = await fetch(`${base}/api/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, username: "ada", password: "long enough pw" }),
  });
  expect(setup.status).toBe(201);
  const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0] as string;
  expect((await fetch(`${base}/api/pipelines`, { headers: { cookie } })).status).toBe(200);
  expect(json(await pipo(["owner", "--home", home, "--json"]))).toMatchObject({ owner: "ada", sessions: 1 });

  expect((await pipo(["owner", "reset", "--home", home, "--password-stdin"], "reset by the cli")).code).toBe(0);
  expect((await fetch(`${base}/api/pipelines`, { headers: { cookie } })).status).toBe(401);
  expect(json(await pipo(["status", "--home", home, "--json"])).engine).toBe("up");
  expect(json(await pipo(["engine", "stop", "--home", home, "--json"])).stopped).toBe(true);
});
