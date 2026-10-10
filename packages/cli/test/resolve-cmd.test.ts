// `pipo resolve` happy path (docs/spec.md §6, D50): in-process with --no-engine against a runner started in the test.
// A packet escalated by `then: agent` is dead-lettered by the command and lands in the DLQ.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, waitFor } from "../../runner/test/helpers";
import { RustRunner } from "../../runner/test/rust";
import { main } from "../src/cli";

setDefaultTimeout(60_000);
const sb = sandbox();
const runners: RustRunner[] = [];
afterAll(async () => {
  for (const r of runners) await r.kill().catch(() => {});
  sb.cleanup();
});

const flag = join(sb.root, "fail.flag");
writeFileSync(flag, "");
// The `check` step fails while the flag file exists: an exec step, since a fn module has no file system.
const gate = `{ command: sh, args: ["-c", 'if [ -e "$0" ]; then echo flaky is failing >&2; exit 1; fi', ${JSON.stringify(flag)}] }`;
const file = sb.write(
  "rcmd.pipo",
  `pipo: 1
name: rcmd
input: { via: push }
nodes:
  check: { from: input, tap: exec, with: ${gate}, on_error: { retry: 1, delay: 10ms, then: agent } }
output: { from: check, to: file, with: { path: ./rcmd.jsonl, format: jsonl } }
agent: { control: true }
`,
);

test("pipo resolve --action dead_letter moves an escalated packet to the DLQ", async () => {
  const runner = await RustRunner.start(sb, file, "rcmd", { listen: null, timeoutMs: 30_000 });
  runners.push(runner);
  const id = (await runner.push({ n: 1 })).packet_id;
  await waitFor(() => runner.packet(id)?.state === "escalated", 15_000, "packet escalated");

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
  expect(runner.packet(id)?.state).toBe("dead_lettered");
  expect(JSON.stringify(await runner.request("dlq", {}))).toContain(id);
});
