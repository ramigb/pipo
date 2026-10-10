// The runner binary (docs/spec.md §7.1, D73): the data plane is the Rust `pipo-runner` (crates/pipo-runner). The engine,
// `pipo run` and `pipo test` start it through these helpers, so each finds the same binary and hands it the same
// compiler: the runner calls `pipo compile` (TypeScript) to check a definition, found through PIPO_COMPILE. In the
// workspace the binary builds itself: a missing release build, or one older than the crate's sources, is rebuilt with
// cargo before it is used (and `bun install` builds it too, scripts/build-runner.ts).
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const CLI_MAIN = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));
const BUILD = ["build", "--release", "-p", "pipo-runner"];

/** Thrown when there is no runner binary to use; says how to get one. */
export class RunnerBinaryError extends Error {}

/** $PIPO_RUNNER_BIN when set (it must exist), else null. */
function givenBinary(): string | null {
  const given = process.env.PIPO_RUNNER_BIN;
  if (!given) return null;
  if (!existsSync(given)) {
    throw new RunnerBinaryError(
      `PIPO_RUNNER_BIN names ${given}, which doesn't exist; fix it, or unset it to use the workspace's build`,
    );
  }
  return given;
}

/**
 * The runner binary: $PIPO_RUNNER_BIN, else the workspace's release build, built or rebuilt first when needed. A build
 * blocks; the CLI uses this, so cargo's progress shows in the terminal.
 */
export function runnerBinary(): string {
  return givenBinary() ?? ensureRunnerBuilt(REPO);
}

let building: Promise<string> | null = null;

/** runnerBinary() without blocking the event loop during a build (the engine); concurrent callers share one build. */
export async function runnerBinaryAsync(): Promise<string> {
  const given = givenBinary();
  if (given) return given;
  building ??= ensureRunnerBuiltAsync(REPO).finally(() => {
    building = null;
  });
  return building;
}

/** `target/release/pipo-runner` under `repo`, and the newest change to what it is built from (0 when not a workspace). */
function buildInputs(repo: string): { bin: string; newest: number } {
  const crate = join(repo, "crates", "pipo-runner");
  let newest = 0;
  const visit = (path: string) => {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      return;
    }
    if (st.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    else newest = Math.max(newest, st.mtimeMs);
  };
  if (existsSync(crate)) {
    for (const p of [join(crate, "src"), join(crate, "Cargo.toml"), join(repo, "Cargo.toml"), join(repo, "Cargo.lock")])
      visit(p);
  }
  return { bin: join(repo, "target", "release", "pipo-runner"), newest };
}

type Plan = { bin: string; cargo: null } | { bin: string; cargo: string; newest: number };

/**
 * Whether the release build under `repo` must be built first: when it is missing or older than any file it is built
 * from (the crate's sources, its Cargo.toml, the workspace's Cargo.toml and Cargo.lock). Without cargo, a stale binary
 * is used with a warning and a missing one is an error that says how to install Rust.
 */
function plan(repo: string): Plan {
  const { bin, newest } = buildInputs(repo);
  const built = existsSync(bin) ? statSync(bin).mtimeMs : null;
  if (newest === 0 || (built !== null && built >= newest)) {
    if (built === null) {
      throw new RunnerBinaryError(
        `the runner binary ${bin} is missing, and there is no crates/pipo-runner here to build it from; set PIPO_RUNNER_BIN to a pipo-runner binary`,
      );
    }
    return { bin, cargo: null };
  }
  const cargo = Bun.which("cargo", { PATH: process.env.PATH ?? "" });
  if (!cargo) {
    if (built !== null) {
      console.warn(
        "pipo: the runner binary is older than crates/pipo-runner, but cargo isn't installed to rebuild it; using it as it is",
      );
      return { bin, cargo: null };
    }
    throw new RunnerBinaryError(
      `the runner binary ${bin} is missing and cargo isn't installed to build it; install Rust (https://rustup.rs), then run \`bun run build:runner\` (or let pipo build it the next time it needs it)`,
    );
  }
  process.stderr.write(`pipo: ${built === null ? "building" : "rebuilding"} the runner (cargo ${BUILD.join(" ")})\n`);
  return { bin, cargo, newest };
}

function finish(p: Extract<Plan, { newest: number }>, code: number | null): string {
  if (code !== 0 || !existsSync(p.bin)) {
    throw new RunnerBinaryError(
      `cargo ${BUILD.join(" ")} failed (exit ${code}); fix the errors above, or set PIPO_RUNNER_BIN to a runner binary to use meanwhile`,
    );
  }
  // Cargo leaves the binary alone when nothing it depends on really changed (a file touched, a checkout): mark it
  // current, so the next check doesn't run cargo again.
  if (statSync(p.bin).mtimeMs < p.newest) {
    const now = new Date();
    utimesSync(p.bin, now, now);
  }
  return p.bin;
}

const CARGO_IO = { stdin: "ignore", stdout: "ignore", stderr: "inherit" } as const;

/** The release build of the runner under `repo`, built first when needed (see plan). Cargo's output goes to stderr. */
export function ensureRunnerBuilt(repo: string): string {
  const p = plan(repo);
  if (!p.cargo) return p.bin;
  return finish(p, Bun.spawnSync([p.cargo, ...BUILD], { cwd: repo, ...CARGO_IO }).exitCode);
}

/** ensureRunnerBuilt, awaiting the build instead of blocking. */
export async function ensureRunnerBuiltAsync(repo: string): Promise<string> {
  const p = plan(repo);
  if (!p.cargo) return p.bin;
  return finish(p, await Bun.spawn([p.cargo, ...BUILD], { cwd: repo, ...CARGO_IO }).exited);
}

/** `pipo compile` as the runner should call it: this Bun and this workspace's CLI, unless PIPO_COMPILE is set. */
export function compilerArgv(): string {
  return process.env.PIPO_COMPILE || JSON.stringify([process.execPath, CLI_MAIN, "compile"]);
}

/** The environment a runner process gets: the caller's, plus PIPO_COMPILE. */
export function runnerEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { ...(process.env as Record<string, string>), PIPO_COMPILE: compilerArgv(), ...extra };
}

/**
 * Run the binary to its exit (`pipo-runner read`, `pipo-runner test`) with stdin, stdout and stderr on temp files:
 * awaiting a subprocess pipe inside `bun test` sometimes never wakes up.
 */
export async function runBinaryToFiles(
  args: string[],
  stdin = "",
): Promise<{ code: number; out: string; err: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pipo-bin-"));
  try {
    const paths = { in: join(dir, "in"), out: join(dir, "out"), err: join(dir, "err") };
    writeFileSync(paths.in, stdin);
    const proc = Bun.spawn([runnerBinary(), ...args], {
      stdin: Bun.file(paths.in),
      stdout: Bun.file(paths.out),
      stderr: Bun.file(paths.err),
      env: runnerEnv(),
    });
    const code = await proc.exited;
    return { code, out: readFileSync(paths.out, "utf8"), err: readFileSync(paths.err, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
