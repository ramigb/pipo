// Helpers for the proposal tests (docs/spec.md §9.3): a gate for `transform: http` steps that holds packets until
// released, offline reads through `pipo-runner read` (D34), and a mock Claude API for agent nodes (`base_url`).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runnerBinary } from "../src/binary";

/**
 * An HTTP endpoint for a `transform: http` step: it echoes the packet's data back, holding packets whose data has
 * `wait: true` until `release()`. Being outside the runner, it holds packets across a runner's SIGKILL and restart.
 */
export function gateServer() {
  let released = false;
  let waiting: (() => void)[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const body = (await req.json()) as { wait?: boolean };
      if (body?.wait && !released) {
        const held = new Promise<void>((r) => waiting.push(r));
        await held;
      }
      return Response.json(body);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/gate`,
    /** Requests held right now (a dead runner's included). */
    held: () => waiting.length,
    release() {
      released = true;
      for (const w of waiting) w();
      waiting = [];
    },
    stop() {
      this.release();
      server.stop(true);
    },
  };
}

/** A mock Claude Messages API: each call answers the node's tool call with `answer(n)` (n counts from 1). */
export function claudeMock(answer: (n: number) => unknown) {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      await req.json();
      calls++;
      return Response.json({
        content: [{ type: "tool_use", name: "pipo_output", input: answer(calls) }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls: () => calls, stop: () => server.stop(true) };
}

let reads = 0;

/** `pipo-runner read`: a read op answered from the journal with no runner; `value` is what it printed. */
export async function offlineRead(
  box: { root: string; home: string },
  pipeline: string,
  op: string,
  args: Record<string, unknown> = {},
): Promise<{ code: number; value: any }> {
  const out = join(box.root, `read-${process.pid}-${++reads}.json`);
  const proc = Bun.spawn(
    [runnerBinary(), "read", "--home", box.home, "--pipeline", pipeline, "--op", op, "--args", JSON.stringify(args)],
    { stdout: Bun.file(out), stderr: Bun.file(`${out}.err`) },
  );
  const code = await proc.exited;
  return { code, value: JSON.parse(readFileSync(out, "utf8")) };
}
