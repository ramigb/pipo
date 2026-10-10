import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS } from "@pipo/spec";
import { copyExampleDir, sandbox } from "../../runner/test/helpers";
import { main } from "../src/cli";

const MAIN = join(import.meta.dir, "../src/main.ts");
const ROOT = join(import.meta.dir, "../../..");
const sb = sandbox();
afterAll(() => sb.cleanup());

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
  } finally {
    console.log = log;
    console.error = error;
  }
}

async function compile(file: string, home = sb.home) {
  const r = await pipo("compile", file, "--home", home);
  return { code: r.code, out: JSON.parse(r.stdout), stderr: r.stderr };
}

let n = 0;
function project(files: Record<string, string>): string {
  const dir = join(sb.root, `p${n++}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const PIPE = (extra = "", transform = "fn.shout") =>
  `pipo: 1\nname: c\n${extra}input: { via: push }\nnodes:\n  x: { from: input, transform: ${transform} }\noutput: { from: x, to: stdout }\n`;

test("a clean pipeline compiles: definition, bundled fn, hashes; exit 0", async () => {
  const dir = project({
    "c.pipo": PIPE("fn: ./c.fn.ts\n"),
    "c.fn.ts":
      'import { upper } from "./helper";\nexport function shout(d: { s: string }) { return { s: upper(d.s) }; }\nexport const N = 3;\n',
    "helper.ts": "export const upper = (s: string): string => `${s.toUpperCase()}!`;\n",
  });
  const { code, out } = await compile(join(dir, "c.pipo"));
  expect(code).toBe(0);
  expect(out.diagnostics).toEqual([]);
  expect(out.pipeline).toMatchObject({ name: "c", fn: "./c.fn.ts", nodes: { x: { transform: "fn.shout" } } });
  const hash = new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, "c.fn.ts"))).digest("hex");
  expect(out.fn).toMatchObject({ path: "./c.fn.ts", hash, exports: ["shout"] });
  // The helper is inlined: the bundle imports nothing and holds no TypeScript.
  expect(out.fn.code).toContain("toUpperCase");
  expect(out.fn.code).not.toMatch(/^import /m);
  expect(out.fn.code).not.toContain(": string");
  writeFileSync(join(dir, "bundle.mjs"), out.fn.code);
  const mod = await import(join(dir, "bundle.mjs"));
  expect(mod.shout({ s: "hi" })).toEqual({ s: "HI!" });
  expect(out.files).toEqual({ "./c.fn.ts": hash });
  expect(out.schemas).toEqual({});
  expect(out.agents).toBeNull();
  expect(out.agent_manifests).toEqual(JSON.parse(JSON.stringify(AGENTS)));
});

test("errors: exit 1, pipeline null, diagnostics as pipo check --json gives them", async () => {
  const dir = project({ "c.pipo": PIPE("", "fn.nope") });
  const file = join(dir, "c.pipo");
  const { code, out } = await compile(file);
  expect(code).toBe(1);
  expect(out.pipeline).toBeNull();
  expect(out.fn).toBeNull();
  const checked = await pipo("check", file, "--json");
  expect(out.diagnostics).toEqual(JSON.parse(checked.stdout).files[0].diagnostics);
  expect(out.diagnostics.some((d: { code: string }) => d.code === "P012")).toBe(true);
});

test("P059: a module importing node:fs, or using Bun or process, can't run in the runner", async () => {
  const dir = project({
    "c.pipo": PIPE("fn: ./c.fn.ts\n"),
    "c.fn.ts":
      'import { readFileSync } from "node:fs";\nexport function shout() { return readFileSync("/etc/hostname", "utf8"); }\n',
  });
  const file = join(dir, "c.pipo");
  const { code, out } = await compile(file);
  expect(code).toBe(1);
  expect(out.pipeline).toBeNull();
  expect(out.fn).toBeNull();
  expect(out.diagnostics).toEqual([
    expect.objectContaining({
      code: "P059",
      severity: "error",
      line: 3,
      col: 1,
      path: ["fn"],
      message: "fn module ./c.fn.ts can't run in the runner: it imports node:fs",
      hint: expect.stringContaining("QuickJS"),
    }),
  ]);
  // `pipo check` reports it too.
  const checked = await pipo("check", file, "--json");
  expect(checked.code).toBe(1);
  expect(JSON.parse(checked.stdout).files[0].diagnostics).toEqual(out.diagnostics);

  writeFileSync(
    join(dir, "c.fn.ts"),
    "export function shout() { return typeof process === 'undefined' ? Bun.version : process.env.HOME; }\n",
  );
  const globals = await compile(file);
  expect(globals.out.diagnostics[0].message).toBe("fn module ./c.fn.ts can't run in the runner: it uses Bun, process");

  writeFileSync(join(dir, "c.fn.ts"), 'import x from "not-installed-pkg";\nexport const shout = () => x;\n');
  const missing = await compile(file);
  expect(missing.out.diagnostics[0].message).toContain('Could not resolve: "not-installed-pkg"');
});

test("a `typeof` guard and a local named like a host global are fine", async () => {
  const dir = project({
    "c.pipo": PIPE("fn: ./c.fn.ts\n"),
    "c.fn.ts":
      "export function shout(process: { n: number }) { const Bun = 2; return { node: typeof require, n: process.n * Bun }; }\n",
  });
  const { code, out } = await compile(join(dir, "c.pipo"));
  expect(code).toBe(0);
  expect(out.fn.code).toContain("typeof require");
});

test("timers are fine: the runner's QuickJS has setTimeout, clearTimeout, setInterval and clearInterval", async () => {
  const dir = project({
    "c.pipo": PIPE("fn: ./c.fn.ts\n"),
    "c.fn.ts":
      "const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));\nexport async function shout(d: unknown) { clearTimeout(setTimeout(() => {}, 5)); clearInterval(setInterval(() => {}, 5)); await sleep(1); return d; }\n",
  });
  const { code, out } = await compile(join(dir, "c.pipo"));
  expect(out.diagnostics).toEqual([]);
  expect(code).toBe(0);
  expect(out.fn.code).toContain("setTimeout(r, ms)");
});

test("schemas and file hashes: exactly what the runner records (D60)", async () => {
  const dir = join(sb.root, "triage");
  copyExampleDir(join(ROOT, "examples/ticket-triage"), dir);
  const file = join(dir, "ticket-triage.pipo");
  const { code, out } = await compile(file);
  expect(code).toBe(0);
  expect(out.schemas).toEqual({
    "./triage.schema.json": JSON.parse(readFileSync(join(dir, "triage.schema.json"), "utf8")),
  });
  // D60's file hashes: sha256 of each referenced file as it is on disk.
  const schema = readFileSync(join(dir, "triage.schema.json"));
  expect(out.files).toEqual({ "./triage.schema.json": new Bun.CryptoHasher("sha256").update(schema).digest("hex") });
});

test("agents: the home's config.yaml settings, with engine_budget and problems as data", async () => {
  const dir = join(sb.root, "triage-agents");
  copyExampleDir(join(ROOT, "examples/ticket-triage"), dir);
  const home = join(sb.root, "agents-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    "agents:\n  claude_api:\n    api_key: env:MY_KEY\nengine:\n  timezone: Europe/Stockholm\n  agent_budget: { per_day: 2 }\n",
  );
  const ok = await compile(join(dir, "ticket-triage.pipo"), home);
  expect(ok.code).toBe(0);
  expect(ok.out.agents.problems).toEqual([]);
  expect(ok.out.agents.settings).toMatchObject({
    agents: { claude_api: { api_key: "env:MY_KEY" } },
    timezone: "Europe/Stockholm",
    engine_budget: { per_day: 2 },
  });
  expect(ok.out.agents.settings.engineBudget).toBeUndefined();

  writeFileSync(join(home, "config.yaml"), "engine:\n  timezone: Mars/Base\n");
  const bad = await compile(join(dir, "ticket-triage.pipo"), home);
  expect(bad.code).toBe(0);
  expect(bad.out.agents.problems[0]).toContain("engine.timezone must be an IANA time zone");
});

test("usage errors exit 64 with a message on stderr", async () => {
  expect((await pipo("compile")).code).toBe(64);
  const missing = await pipo("compile", join(sb.root, "nope.pipo"));
  expect(missing.code).toBe(64);
  expect(missing.stderr).toContain("no such file");
  expect(missing.stdout).toBe("");
  expect((await pipo("compile", "a.pipo", "b.pipo")).code).toBe(64);
});

test("built-in templates' fn stubs bundle", async () => {
  for (const t of ["cron-to-file", "watch-to-http", "webhook-to-sqlite"]) {
    const dir = join(sb.root, `tpl-${t}`);
    const made = await pipo("new", `demo-${t}`, "--template", t, "--dir", dir, "--home", sb.home);
    expect(made.code).toBe(0);
    const { code, out } = await compile(join(dir, `demo-${t}.pipo`));
    expect({ t, diagnostics: out.diagnostics }).toEqual({ t, diagnostics: [] });
    expect(code).toBe(0);
    expect(out.fn.exports.length).toBeGreaterThan(0);
  }
});

test("real process: --stdin reads the source; the path anchors relative references", async () => {
  const dir = project({
    "c.pipo": "this file on disk is not what gets compiled",
    "c.fn.ts": "export function shout(d: unknown) { return d; }\n",
  });
  const src = join(sb.root, "stdin.pipo");
  writeFileSync(src, PIPE("fn: ./c.fn.ts\n"));
  const out = join(sb.root, "stdin.out");
  const err = join(sb.root, "stdin.err");
  const proc = Bun.spawn(["bun", MAIN, "compile", join(dir, "c.pipo"), "--stdin", "--home", sb.home], {
    stdin: Bun.file(src),
    stdout: Bun.file(out),
    stderr: Bun.file(err),
    timeout: 25_000,
    killSignal: "SIGKILL",
  });
  expect(await proc.exited).toBe(0);
  const text = await Bun.file(out).text();
  expect(text.trim().split("\n")).toHaveLength(1);
  const json = JSON.parse(text);
  expect(json.pipeline.name).toBe("c");
  expect(json.fn.exports).toEqual(["shout"]);
}, 30_000);
