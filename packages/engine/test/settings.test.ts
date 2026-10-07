// Dashboard settings (docs/spec.md §8, D72): the builder's workspace, chosen over /api/settings and kept in config.yaml.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Supervisor } from "../src";
import { loadConfig } from "../src/config";
import { sandbox, testConfig } from "./helpers";

const box = sandbox();
const engines: Supervisor[] = [];
afterAll(async () => {
  for (const e of engines) await Promise.race([e.shutdown({ now: true }), Bun.sleep(10_000)]);
  box.cleanup();
});

test("choose a workspace: used at once, saved for the next start, comments kept", async () => {
  const home = join(box.root, "home");
  const first = join(box.root, "first");
  const pipes = join(box.root, "pipes");
  mkdirSync(join(pipes, "a"), { recursive: true });
  mkdirSync(join(pipes, ".hidden"));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.yaml"), "# mine\nengine:\n  idle: 5m # keep\n");
  const engine = await Supervisor.open({
    home,
    config: { ...testConfig(), listen: 0 },
    workspace: first,
    log: () => {},
  });
  engines.push(engine);
  const base = `${engine.gateway?.url}/api`;
  const get = async (path: string) => (await fetch(`${base}${path}`)).json() as Promise<any>;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  expect(await get("/settings")).toMatchObject({ workspace: first, workspace_from: "flag", home });
  expect(await get(`/folders?path=${encodeURIComponent(pipes)}`)).toEqual({
    path: pipes,
    parent: box.root,
    folders: ["a"],
  });

  expect((await post("/settings/workspace", { path: "relative/dir" })).status).toBe(400);
  const missing = await post("/settings/workspace", { path: join(pipes, "new") });
  expect(missing.status).toBe(400);
  expect(missing.body.hint).toContain('"create": true');

  const made = await post("/settings/workspace", { path: join(pipes, "new"), create: true });
  expect(made.body).toEqual({ workspace: join(pipes, "new"), workspace_from: "settings" });
  expect(existsSync(join(pipes, "new"))).toBe(true);
  expect((await get("/builder/catalog")).workspace).toBe(join(pipes, "new"));
  expect((await get("/engine")).workspace).toBe(join(pipes, "new"));

  const saved = readFileSync(join(home, "config.yaml"), "utf8");
  expect(saved).toContain("# mine");
  expect(saved).toContain("idle: 5m # keep");
  expect(loadConfig(home).workspace).toBe(join(pipes, "new"));
});

test("engine.workspace must be an absolute path", () => {
  const home = join(box.root, "home-bad");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.yaml"), "engine:\n  workspace: pipes\n");
  expect(() => loadConfig(home)).toThrow("engine.workspace must be an absolute path");
});
