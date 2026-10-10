// The runner binary builds itself in the workspace (docs/spec.md D73): a missing or stale release build is rebuilt with
// cargo before use. Driven against a throwaway workspace and a fake `cargo` on PATH that records its calls.
import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureRunnerBuilt, ensureRunnerBuiltAsync, RunnerBinaryError } from "../src/binary";
import { sandbox } from "./helpers";

const box = sandbox();
afterAll(() => box.cleanup());

const PATH = process.env.PATH;
afterEach(() => {
  process.env.PATH = PATH;
});

let n = 0;
/** A workspace with one crate source file, and a fake cargo whose behaviour is `mode`. */
function workspace(mode: "build" | "fresh" | "fail" | "none") {
  const repo = join(box.root, `ws${++n}`);
  mkdirSync(join(repo, "crates/pipo-runner/src"), { recursive: true });
  writeFileSync(join(repo, "Cargo.toml"), "[workspace]\n");
  writeFileSync(join(repo, "Cargo.lock"), "");
  writeFileSync(join(repo, "crates/pipo-runner/Cargo.toml"), "[package]\n");
  writeFileSync(join(repo, "crates/pipo-runner/src/main.rs"), "fn main() {}\n");
  const bin = join(repo, "target/release/pipo-runner");
  const calls = join(repo, "calls");
  const fake = join(repo, "fakebin");
  mkdirSync(fake);
  if (mode !== "none") {
    const body = {
      build: `mkdir -p target/release && echo built > target/release/pipo-runner`,
      fresh: "true",
      fail: `echo "error[E0425]: nope" >&2; exit 101`,
    }[mode];
    writeFileSync(join(fake, "cargo"), `#!/bin/sh\necho "$@" >> ${calls}\n${body}\n`);
    chmodSync(join(fake, "cargo"), 0o755);
  }
  // Only the fake: no real cargo can be found.
  process.env.PATH = `${fake}:/usr/bin:/bin`;
  const ran = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);
  const age = (path: string, secondsAgo: number) => {
    const t = new Date(Date.now() - secondsAgo * 1000);
    utimesSync(path, t, t);
  };
  return { repo, bin, ran, age };
}

test("a missing binary is built with cargo build --release -p pipo-runner, then used as it is", () => {
  const w = workspace("build");
  expect(ensureRunnerBuilt(w.repo)).toBe(w.bin);
  expect(w.ran()).toEqual(["build --release -p pipo-runner"]);
  expect(ensureRunnerBuilt(w.repo)).toBe(w.bin);
  expect(w.ran()).toHaveLength(1);
});

test("the engine's path awaits the same build instead of blocking", async () => {
  const w = workspace("build");
  expect(await ensureRunnerBuiltAsync(w.repo)).toBe(w.bin);
  expect(await ensureRunnerBuiltAsync(w.repo)).toBe(w.bin);
  expect(w.ran()).toEqual(["build --release -p pipo-runner"]);
});

test("a binary older than a source file, Cargo.toml or Cargo.lock is rebuilt", () => {
  const w = workspace("build");
  ensureRunnerBuilt(w.repo);
  for (const [i, f] of ["crates/pipo-runner/src/main.rs", "crates/pipo-runner/Cargo.toml", "Cargo.lock"].entries()) {
    w.age(w.bin, 60);
    writeFileSync(join(w.repo, f), `// changed ${i}\n`);
    ensureRunnerBuilt(w.repo);
    expect(w.ran()).toHaveLength(i + 2);
  }
  // A new module counts too.
  w.age(w.bin, 60);
  mkdirSync(join(w.repo, "crates/pipo-runner/src/connectors"));
  writeFileSync(join(w.repo, "crates/pipo-runner/src/connectors/new.rs"), "\n");
  ensureRunnerBuilt(w.repo);
  expect(w.ran()).toHaveLength(5);
});

test("when cargo finds nothing to rebuild (a touched file), the binary is marked current so cargo isn't run again", () => {
  const w = workspace("fresh");
  mkdirSync(join(w.repo, "target/release"), { recursive: true });
  writeFileSync(w.bin, "old");
  w.age(w.bin, 60);
  expect(ensureRunnerBuilt(w.repo)).toBe(w.bin);
  expect(statSync(w.bin).mtimeMs).toBeGreaterThanOrEqual(
    statSync(join(w.repo, "crates/pipo-runner/src/main.rs")).mtimeMs,
  );
  ensureRunnerBuilt(w.repo);
  expect(w.ran()).toHaveLength(1);
});

test("a failed build is an error that says to fix it, even when an older binary exists", () => {
  const w = workspace("fail");
  mkdirSync(join(w.repo, "target/release"), { recursive: true });
  writeFileSync(w.bin, "old");
  w.age(w.bin, 60);
  expect(() => ensureRunnerBuilt(w.repo)).toThrow(RunnerBinaryError);
  expect(() => ensureRunnerBuilt(w.repo)).toThrow(
    /cargo build --release -p pipo-runner failed \(exit 101\); fix the errors above/,
  );
});

test("without cargo: a missing binary says to install Rust; a stale one is used with a warning", () => {
  const w = workspace("none");
  expect(() => ensureRunnerBuilt(w.repo)).toThrow(/cargo isn't installed.*https:\/\/rustup\.rs/);
  mkdirSync(join(w.repo, "target/release"), { recursive: true });
  writeFileSync(w.bin, "old");
  w.age(w.bin, 60);
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => warned.push(m);
  try {
    expect(ensureRunnerBuilt(w.repo)).toBe(w.bin);
  } finally {
    console.warn = warn;
  }
  expect(warned.join()).toContain("cargo isn't installed to rebuild it");
});

test("outside a workspace (no crates/pipo-runner) nothing is built: the binary must exist", () => {
  const repo = join(box.root, "installed");
  mkdirSync(join(repo, "target/release"), { recursive: true });
  expect(() => ensureRunnerBuilt(repo)).toThrow(/no crates\/pipo-runner here.*PIPO_RUNNER_BIN/);
  writeFileSync(join(repo, "target/release/pipo-runner"), "x");
  expect(ensureRunnerBuilt(repo)).toBe(join(repo, "target/release/pipo-runner"));
});
