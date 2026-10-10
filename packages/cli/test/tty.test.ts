import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { setJsonMode } from "../src/errors";
import { fancy, gradient, paint, pipeFrame, say, setPlain, spinner } from "../src/tty";

const TTY = { isTTY: true, write() {} };
const TERM = { TERM: "xterm-256color" };

afterEach(() => {
  setPlain(false);
  setJsonMode(false);
});

test("decoration needs a terminal and no off switch", () => {
  expect(fancy(TTY, TERM)).toBe(true);
  expect(fancy({ write() {} }, TERM)).toBe(false);
  expect(fancy({ isTTY: false, write() {} }, TERM)).toBe(false);
  for (const env of [
    { NO_COLOR: "1" },
    { PIPO_PLAIN: "1" },
    { CI: "true" },
    { TERM: "dumb" },
    { NODE_ENV: "test" },
  ] as Record<string, string>[]) {
    expect(fancy(TTY, { ...TERM, ...env })).toBe(false);
  }
  // Empty or false-y values leave it on (NO_COLOR counts only when non-empty).
  expect(fancy(TTY, { ...TERM, NO_COLOR: "", PIPO_PLAIN: "0", CI: "false" })).toBe(true);
  setPlain(true);
  expect(fancy(TTY, TERM)).toBe(false);
  setPlain(false);
  setJsonMode(true);
  expect(fancy(TTY, TERM)).toBe(false);
});

test("plain paint is the identity; decorated paint adds SGR codes", () => {
  const plain = paint({ write() {} });
  expect(plain.red("x")).toBe("x");
  expect(plain.dim("x")).toBe("x");
  expect(paint(TTY, TERM).green("ok")).toBe("\x1b[32mok\x1b[39m");
});

test("the spinner frame is a packet on a pipeline", () => {
  const plain = paint({ write() {} });
  expect(pipeFrame(0, plain)).toBe("●───○───○");
  expect(pipeFrame(4, plain)).toBe("○───●───○");
  expect(pipeFrame(10, plain)).toBe("○●──○───○");
});

test("gradient falls back to plain cyan on a basic terminal", () => {
  expect(gradient("ab", 2, { TERM: "xterm" })).toBe("\x1b[36mab\x1b[39m");
  expect(gradient("ab", 2, { TERM: "xterm-256color" })).toContain("\x1b[38;5;");
});

test("plain messages keep the `pipo:` and `hint:` format", () => {
  const lines: string[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    say("error", "no such pipeline", "run 'pipo status'");
    say("warn", "engine is old");
  } finally {
    console.error = error;
  }
  expect(lines).toEqual(["pipo: no such pipeline", "  hint: run 'pipo status'", "pipo: engine is old"]);
});

test("a plain spinner writes nothing", async () => {
  const writes: unknown[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((s: unknown) => {
    writes.push(s);
    return true;
  }) as typeof process.stderr.write;
  try {
    const s = spinner("waiting", 0);
    s.text("still waiting");
    await new Promise((r) => setTimeout(r, 30));
    s.stop();
  } finally {
    process.stderr.write = write;
  }
  expect(writes).toEqual([]);
});

test("--plain is accepted by any command and leaves the output as it was", async () => {
  const home = mkdtempSync(join(tmpdir(), "pipo-tty-"));
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  try {
    expect(await runCli(["engine", "status", "--plain", "--home", home])).toBe(0);
    expect(await runCli(["engine", "status", "--home", home, "--plain", "--json"])).toBe(0);
  } finally {
    console.log = log;
    rmSync(home, { recursive: true, force: true });
  }
  expect(out[0]).toBe("engine: down");
  expect(JSON.parse(out[1] ?? "")).toEqual({ ok: true, engine: "down" });
});
