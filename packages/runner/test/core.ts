// Shared bits for the core-flow tests (runner, batch, fan-out, delivery checks, policies, metrics): a sandbox whose
// Rust runners are killed after each test, and small request helpers over `RustRunner`.
import { afterAll, afterEach, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runnerBinary, runnerEnv } from "../src/binary";
import { rows, sandbox } from "./helpers";
import { RustRunner, type StartOptions } from "./rust";

export function suite() {
  const box = sandbox();
  let running: RustRunner[] = [];
  afterEach(async () => {
    for (const r of running) if (r.proc.exitCode === null) await r.kill();
    running = [];
  });
  afterAll(() => box.cleanup());
  return {
    box,
    /** Write `<name>.pipo` and start it; `--listen 0` unless told otherwise. */
    async start(name: string, source: string, o: StartOptions = {}) {
      const file = box.write(`${name}.pipo`, source);
      const r = await RustRunner.start(box, file, name, o);
      running.push(r);
      return r;
    },
    /** Start a file already written. */
    async startFile(file: string, name: string, o: StartOptions = {}) {
      const r = await RustRunner.start(box, file, name, o);
      running.push(r);
      return r;
    },
  };
}

/** POST to the runner's http input; expects 202 and returns the packet id. */
export async function post(r: RustRunner, data: unknown, path = ""): Promise<string> {
  const res = await r.post(path, data);
  expect(res.status).toBe(202);
  return ((await res.json()) as { packet_id: string }).packet_id;
}

/** The `drain` op, then the exit code (the runner exits once drained). */
export async function drain(r: RustRunner): Promise<number> {
  await r.request("drain");
  r.client.close();
  return await r.proc.exited;
}

/** The `stop` op (stop now; mid-step packets resume on the next start), then the exit code. */
export async function stopNow(r: RustRunner): Promise<number> {
  await r.request("stop");
  r.client.close();
  return await r.proc.exited;
}

/** Packet counts by state, from the journal (packets, not their fan-out copies). */
export function counts(r: RustRunner): Record<string, number> {
  const all = r.query<{ state: string; n: number }>(
    "SELECT state, COUNT(*) AS n FROM packets WHERE branch = '' GROUP BY state",
  );
  return Object.fromEntries(all.map((x) => [x.state, x.n]));
}

/** Read a result database in the sandbox. */
export const out = (root: string, file: string, sql: string) => rows(join(root, file), sql);

/**
 * `pipo-runner test` (what `pipo test` runs): the request as JSON on stdin, the reply (`{report}` or `{error}`) from
 * stdout. Both go through files, never pipes.
 */
export async function runnerTest(box: { root: string }, request: Record<string, unknown>) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const input = join(box.root, `test-${stamp}.json`);
  const output = join(box.root, `test-${stamp}.out`);
  writeFileSync(input, JSON.stringify(request));
  const proc = Bun.spawn([runnerBinary(), "test"], {
    stdin: Bun.file(input),
    stdout: Bun.file(output),
    stderr: Bun.file(`${output}.err`),
    env: runnerEnv(),
  });
  const code = await proc.exited;
  const text = readFileSync(output, "utf8");
  try {
    return JSON.parse(text) as { report?: any; error?: { kind: string; message: string } };
  } catch {
    throw new Error(`pipo-runner test failed (exit ${code}): ${readFileSync(`${output}.err`, "utf8")}${text}`);
  }
}
