// Helpers for the control socket, packet read and version tests that drive the Rust runner binary.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runnerBinary, runnerEnv } from "../src/binary";

/**
 * An `exec` tap's shell script: a packet whose `WAIT` env is `true` holds until `release` exists next to the pipeline
 * file. It gives up after 30 s, since the program outlives a SIGKILLed runner (D71) and must not outlive the test.
 */
export const GATE =
  "[ x$WAIT = xtrue ] || exit 0; i=0; while [ ! -f release ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i+1)); done";

/** The gate as a node definition (YAML flow map body), placed after `from`. */
export const gateNode = (from: string) =>
  `{ from: ${from}, tap: exec, with: { command: sh, args: ["-c", "${GATE}"], env: { WAIT: "\${data.wait}" } } }`;

let reads = 0;

/**
 * A read without a runner (D34): `pipo-runner read --home H --pipeline N --op OP --args JSON`. Output goes to a file,
 * never a pipe. Resolves with the exit code and the printed JSON (`{result, withheld}`, `null`, or `{error}`).
 */
export async function offlineRead(
  box: { root: string; home: string },
  pipeline: string,
  op: string,
  args: Record<string, unknown> = {},
  env: Record<string, string> = {},
): Promise<{ code: number; out: any }> {
  const log = join(box.root, `read-${process.pid}-${++reads}.json`);
  const proc = Bun.spawn(
    [runnerBinary(), "read", "--home", box.home, "--pipeline", pipeline, "--op", op, "--args", JSON.stringify(args)],
    { stdout: Bun.file(log), stderr: Bun.file(`${log}.err`), env: runnerEnv(env) },
  );
  const code = await proc.exited;
  const text = readFileSync(log, "utf8").trim();
  if (!text) throw new Error(`pipo-runner read printed nothing (exit ${code}): ${readFileSync(`${log}.err`, "utf8")}`);
  return { code, out: JSON.parse(text) };
}
