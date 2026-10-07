// `pipo status <name>` shows the built-in metrics (docs/spec.md §7.6, D54) and `--json` carries the raw fields, here
// against a runner started in-process (--no-engine: the gateway passes the same runner `status` result through).
import { afterAll, expect, test } from "bun:test";
import { Runner } from "@pipo/runner";
import { sandbox, waitFor } from "../../runner/test/helpers";
import { main } from "../src/cli";

const sb = sandbox();
let runner: Runner | undefined;
afterAll(async () => {
  await runner?.stop().catch(() => {});
  sb.cleanup();
});

type Result = { code: number; stdout: string; stderr: string };
async function pipo(...args: string[]): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await main(args);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}
const H = ["--no-engine", "--home", sb.home];

test("pipo status <name> --json has latency per node and the oldest pending age; the human view shows them", async () => {
  const file = sb.write(
    "mets.pipo",
    'pipo: 1\nname: mets\ninput: { via: push }\nnodes:\n  tidy: { from: input, transform: map, with: { data: { n: "${data.n}" } } }\noutput: { from: tidy, to: file, with: { path: ./mets.jsonl } }\n',
  );
  runner = await Runner.open({ file, home: sb.home, listen: 0, log: () => {} });
  await runner.start();
  const r = runner;
  for (const n of [1, 2]) await r.intake({ n }, { trigger: "push", source: "test" });
  await waitFor(() => (r.journal.counts().delivered ?? 0) === 2, 10_000, "two deliveries");

  let j = JSON.parse((await pipo("status", "mets", "--json", ...H)).stdout);
  let stats = j.pipelines[0].stats;
  expect(stats.latency.tidy).toMatchObject({ count: 2 });
  expect(typeof stats.latency.tidy.p50_ms).toBe("number");
  expect(typeof stats.latency.tidy.p95_ms).toBe("number");
  expect(typeof stats.latency.tidy.max_ms).toBe("number");
  expect(stats.latency.output).toMatchObject({ count: 2 });
  expect(stats.latency_window).toBe(100);
  expect(stats.oldest_pending_age_ms).toBeNull();
  expect(stats.oldest_pending_received_at).toBeNull();

  const human = await pipo("status", "mets", ...H);
  expect(human.code).toBe(0);
  expect(human.stdout).toMatch(/^mets +active +v1 /m);
  expect(human.stdout).toContain("oldest pending: none");
  expect(human.stdout).toMatch(/^ {2}NODE +COUNT +P50 +P95 +MAX$/m);
  expect(human.stdout).toMatch(/^ {2}tidy +2 +\d+ms +\d+ms +\d+ms$/m);
  expect(human.stdout).toMatch(/^ {2}output +2 /m);
  // The list view keeps the spec's columns, without the detail block.
  expect((await pipo("status", ...H)).stdout).not.toContain("oldest pending");

  r.pause("manual");
  const pushed = await r.intake({ n: 3 }, { trigger: "push", source: "test" });
  j = JSON.parse((await pipo("status", "mets", "--json", ...H)).stdout);
  stats = j.pipelines[0].stats;
  expect(stats.oldest_pending_age_ms).toBeGreaterThanOrEqual(0);
  expect(stats.oldest_pending_received_at).toBe(
    new Date(r.journal.get((pushed as { packet_id: string }).packet_id)?.received_at as number).toISOString(),
  );
  expect((await pipo("status", "mets", ...H)).stdout).toMatch(/^oldest pending: \d+s \(received \d{4}-/m);
}, 30_000);
