// The runner binary (docs/spec.md §7.1, D73): the data plane is the Rust `pipo-runner` (crates/pipo-runner). The engine,
// `pipo run` and `pipo test` start it through these helpers, so each finds the same binary and hands it the same
// compiler: the runner calls `pipo compile` (TypeScript) to check a definition, found through PIPO_COMPILE.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const CLI_MAIN = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));

/** Thrown when the binary isn't there; says how to build it. */
export class RunnerBinaryError extends Error {}

/** The runner binary: $PIPO_RUNNER_BIN, else the workspace's release build. */
export function runnerBinary(): string {
  const bin = process.env.PIPO_RUNNER_BIN || `${REPO}target/release/pipo-runner`;
  if (!existsSync(bin)) {
    throw new RunnerBinaryError(
      `the runner binary ${bin} is missing; build it with \`cargo build --release -p pipo-runner\` (or set PIPO_RUNNER_BIN)`,
    );
  }
  return bin;
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
