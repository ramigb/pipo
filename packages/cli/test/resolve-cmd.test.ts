// `pipo resolve` happy path (docs/spec.md §6, D50): in-process with --no-engine against a runner started in the test.
// A packet escalated by `then: agent` is dead-lettered by the command and lands in the DLQ.
import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, Runner } from "@pipo/runner";
import { sandbox, waitFor } from "../../runner/test/helpers";
import { main } from "../src/cli";

const sb = sandbox();
const runners: Runner[] = [];
const clients: ControlClient[] = [];
afterAll(async () => {
  for (const c of clients) c.close();
  for (const r of runners) await r.stop().catch(() => {});
  sb.cleanup();
});

const flag = join(sb.root, "fail.flag");
writeFileSync(flag, "");
sb.write(
  "fns.ts",
  `import { existsSync } from "node:fs";
export const flaky = (d) => {
  if (existsSync(${JSON.stringify(flag)})) throw new Error("flaky is failing");
  return d;
};
`,
);
const file = sb.write(
  "rcmd.pipo",
  `pipo: 1
name: rcmd
fn: ./fns.ts
input: { via: push }
nodes:
  check: { from: input, transform: fn.flaky, on_error: { retry: 1, delay: 10ms, then: agent } }
output: { from: check, to: file, with: { path: ./rcmd.jsonl, format: jsonl } }
agent: { control: true }
`,
);

test("pipo resolve --action dead_letter moves an escalated packet to the DLQ", async () => {
  const runner = await Runner.open({ file, home: sb.home, log: () => {} });
  runners.push(runner);
  await runner.start();
  const c = await ControlClient.forPipeline(sb.home, "rcmd");
  clients.push(c);
  const id = (await c.request("push", { data: { n: 1 } })).packet_id as string;
  await waitFor(() => runner.journal.get(id)?.state === "escalated", 15_000, "packet escalated");

  const { log } = console;
  console.log = () => {};
  let code: number;
  try {
    code = await main([
      "resolve",
      "rcmd",
      id,
      "--action",
      "dead_letter",
      "--reason",
      "bad data",
      "--home",
      sb.home,
      "--no-engine",
    ]);
  } finally {
    console.log = log;
  }
  expect(code).toBe(0);
  expect(runner.journal.get(id)?.state).toBe("dead_lettered");
  expect(JSON.stringify(await c.request("dlq", {}))).toContain(id);
});
