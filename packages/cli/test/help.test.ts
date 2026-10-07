import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "../../runner/test/helpers";
import { main } from "../src/cli";
import { COMMANDS } from "../src/commands";

const MAIN = join(import.meta.dir, "../src/main.ts");
const sb = sandbox();

type Result = { code: number; stdout: string; stderr: string };

// In-process: call main() with console captured. Used for everything that does not need a real process.
async function pipo(...args: string[]): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await main(args);
    return { code, stdout: out.join("\n") + "\n", stderr: err.join("\n") + "\n" };
  } finally {
    console.log = log;
    console.error = error;
  }
}

// Real process, output to files (never a pipe). One retry when an attempt hangs loading modules (/mnt load hang).
let n = 0;
async function spawnPipo(...args: string[]): Promise<Result> {
  for (let attempt = 0; ; attempt++) {
    const out = join(sb.root, `out-${n}.log`);
    const err = join(sb.root, `err-${n++}.log`);
    const proc = Bun.spawn(["bun", MAIN, ...args], {
      stdout: Bun.file(out),
      stderr: Bun.file(err),
      cwd: sb.root,
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    const code = await proc.exited;
    if (code === 137 && attempt < 1) continue;
    return { code, stdout: await Bun.file(out).text(), stderr: await Bun.file(err).text() };
  }
}

for (const c of COMMANDS.filter((c) => c.name !== "help")) {
  for (const flag of ["--help", "-h"]) {
    test(`pipo ${c.name} ${flag} prints usage and exits 0`, async () => {
      const r = await pipo(c.name, flag);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(c.usage);
    });
  }
}

test("help --help does not need other arguments, even with bad ones", async () => {
  const r = await pipo("check", "--bogus", "--help");
  expect(r.code).toBe(0);
});

test("pipo help lists commands; pipo help <cmd> shows one", async () => {
  const all = await pipo("help");
  expect(all.code).toBe(0);
  expect(all.stdout).toContain("pipo run <file>");
  const one = await pipo("help", "run");
  expect(one.code).toBe(0);
  expect(one.stdout).toContain("--listen <port>");
});

test("test answers --help, and help has no Planned section", async () => {
  const h = await pipo("test", "--help");
  expect(h.code).toBe(0);
  expect(h.stdout).toContain("--update-snapshots");
  expect((await pipo("help")).stdout).not.toContain("Planned");
  expect((await pipo("test")).code).toBe(64);
});

test("unknown command exits 2 with a hint", async () => {
  for (const args of [["frobnicate"], ["help", "frobnicate"]]) {
    const r = await pipo(...args);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("pipo --help");
  }
});

test("new, generate and templates are implemented, not planned", async () => {
  const r = await pipo("help");
  expect(r.stdout).toContain("pipo new <name>");
  expect(r.stdout).toContain("pipo templates");
  expect(r.stdout).not.toContain("Planned");
});

test("real process: templates --json lists the built-ins; new reports errors with a hint", async () => {
  const j = await spawnPipo("templates", "--json", "--home", join(sb.root, "nohome"));
  expect(JSON.parse(j.stdout).map((t: { name: string }) => t.name)).toContain("webhook-to-sqlite");
  const bad = await spawnPipo("new", "Bad Name");
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain("hint:");
}, 40_000);

test("real process smoke: every implemented command answers --help and -h with exit 0", async () => {
  for (const c of COMMANDS.filter((c) => c.name !== "help")) {
    const r = await spawnPipo(c.name, c.name === "run" ? "-h" : "--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(c.usage);
  }
}, 120_000);

test("help for run, new and generate has no side effects", async () => {
  const cwd = process.cwd();
  const home = join(sb.root, "pipo-home");
  const saved = process.env.PIPO_HOME;
  process.env.PIPO_HOME = home;
  const dir = join(sb.root, "cwd");
  mkdirSync(dir, { recursive: true });
  process.chdir(dir);
  try {
    for (const args of [
      ["run", "--help"],
      ["run", "x.pipo", "-h"],
      ["new", "demo", "--help"],
      ["generate", "--help"],
    ]) {
      expect((await pipo(...args)).code).toBe(0);
    }
  } finally {
    process.chdir(cwd);
    if (saved === undefined) delete process.env.PIPO_HOME;
    else process.env.PIPO_HOME = saved;
  }
  expect(readdirSync(dir)).toEqual([]);
  expect(existsSync(home)).toBe(false);
});

test("--json: usage errors, unknown commands print {ok:false,…} and keep their exit codes", async () => {
  const u = await pipo("stop", "--json");
  expect(u.code).toBe(64);
  expect(JSON.parse(u.stdout)).toMatchObject({ ok: false, code: "usage", error: "usage: pipo stop <name> [--now]" });
  expect(u.stderr.trim()).toBe("");
  const k = await pipo("frobnicate", "--json");
  expect(k.code).toBe(2);
  expect(JSON.parse(k.stdout)).toMatchObject({ ok: false, code: "unknown_command" });
  const text = await pipo("stop");
  expect(text.code).toBe(64);
  expect(text.stderr).toContain("usage: pipo stop");
});

test("--json usage errors carry a hint naming the command's --help", async () => {
  const usage = JSON.parse((await pipo("new", "--json")).stdout);
  expect(usage).toMatchObject({ ok: false, code: "usage", hint: "run pipo new --help" });
  const unknown = JSON.parse((await pipo("frobnicate", "--json")).stdout);
  expect(unknown).toMatchObject({ ok: false, code: "unknown_command", hint: "run pipo --help" });
});

test("top-level help rows fit 100 columns and every command is listed", async () => {
  const h = (await pipo("help")).stdout;
  for (const line of h.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
  for (const c of COMMANDS) expect(h).toContain(`pipo ${c.name}`);
});

test("a bad flag is a usage error: exit 64, names the flag, hints at --help; --json has the failure shape", async () => {
  const r = await pipo("check", "--bogus");
  expect(r.code).toBe(64);
  expect(r.stderr).toContain("--bogus");
  expect(r.stderr).toContain("run pipo check --help");
  const j = await pipo("check", "--bogus", "--json");
  expect(j.code).toBe(64);
  expect(JSON.parse(j.stdout)).toEqual({
    ok: false,
    error: expect.stringContaining("--bogus"),
    hint: "run pipo check --help",
    code: "usage",
  });
  expect((await pipo("fmt", "--check=x")).code).toBe(64);
});

test("a missing path is a Pipo error with a hint, not an ENOENT", async () => {
  const missing = join(sb.root, "nope.pipo");
  let err: unknown;
  await pipo("check", missing).catch((e) => {
    err = e;
  });
  expect((err as Error).constructor.name).toBe("CliError");
  expect((err as Error).message).toContain(missing);
  expect((err as { hint?: string }).hint).toContain(".pipo");
});
