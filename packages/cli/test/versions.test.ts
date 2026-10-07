// `pipo history|diff|rollback` (docs/spec.md §6 Versions, §9.3, D38): in-process with --no-engine against a runner
// started in the test, then from its journal once it stopped; errors say what to do.
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Runner } from "@pipo/runner";
import { sandbox, waitFor } from "../../runner/test/helpers";
import { main } from "../src/cli";
import { renderHelp } from "../src/commands";

const sb = sandbox();
const runners: Runner[] = [];
afterAll(async () => {
  for (const r of runners) await r.stop().catch(() => {});
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
  } catch (e) {
    const hint = (e as { hint?: string }).hint;
    return {
      code: 1,
      stdout: out.join("\n"),
      stderr: `${err.join("\n")}\n${(e as Error).message}${hint ? `\n  hint: ${hint}` : ""}`,
    };
  } finally {
    console.log = log;
    console.error = error;
  }
}
const N = ["--home", sb.home, "--no-engine"];

sb.write(
  "fns.ts",
  `export const one = (d) => ({ ...d, v: "one" });\nexport const two = (d) => ({ ...d, v: "two" });\n`,
);
const SRC = (tag: string) => `pipo: 1
name: hist
fn: ./fns.ts
input: { via: push }
nodes:
  tag: { from: input, transform: fn.${tag} }
output: { from: tag, to: file, with: { path: ./hist.jsonl, format: jsonl } }
`;
const file = sb.write("hist.pipo", SRC("one"));
const written = () =>
  existsSync(join(sb.root, "hist.jsonl"))
    ? readFileSync(join(sb.root, "hist.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

test("help lists history, diff and rollback and proposals as commands, with nothing planned", () => {
  const help = renderHelp();
  for (const c of ["history", "diff", "rollback"]) {
    expect(help).toContain(`pipo ${c} <name>`);
  }
  expect(help).toContain("pipo proposals <name>");
  expect(help).not.toContain("Planned");
});

test("history, diff and rollback against a running pipeline, then history from its journal", async () => {
  const runner = await Runner.open({ file, home: sb.home, log: () => {} });
  runners.push(runner);
  await runner.start();
  await runner.applyVersion(SRC("two"), { author: "test", reason: "try two" });

  const h = await pipo("history", "hist", ...N);
  expect(h.code).toBe(0);
  const lines = h.stdout.split("\n");
  expect(lines[0]).toMatch(/^ {2}VER\s+CREATED\s+AUTHOR\s+PENDING\s+HASH\s+REASON$/);
  expect(lines[1]).toMatch(/^\*v2\s+\S+ ago\s+test\s+0\s+[0-9a-f]{12}\s+try two$/);
  expect(lines[2]).toMatch(/^ v1\s+\S+ ago\s+human\s+0\s+[0-9a-f]{12}\s+first start$/);
  expect(h.stdout).toContain("* new packets use v2; in-flight packets finish on their own version");
  expect(h.stdout).toEndWith("engine: down");
  const hj = JSON.parse((await pipo("history", "hist", ...N, "--json")).stdout);
  expect(hj).toMatchObject({ ok: true, engine: "down", pipeline: "hist", current: 2, latest: 2, source: "runner" });

  const d = await pipo("diff", "hist", "v1", "2", ...N);
  expect(d.code).toBe(0);
  expect(d.stdout).toContain(
    "--- hist v1\n+++ hist v2\n@@ -3,5 +3,5 @@\n fn: ./fns.ts\n input: { via: push }\n nodes:\n-  tag: { from: input, transform: fn.one }\n+  tag: { from: input, transform: fn.two }\n output:",
  );
  expect(d.stdout).toContain("1 line(s) added, 1 removed");
  expect((await pipo("diff", "hist", "1", "1", ...N)).stdout).toContain("v1 and v1 of hist are identical");

  const rb = await pipo("rollback", "hist", "1", ...N);
  expect(rb.code).toBe(0);
  expect(rb.stdout).toContain("rolled back hist to v1: new packets use v3 (a copy of v1); nothing was in flight");
  expect(runner.version).toBe(3);
  const id = (await runner.intake({ n: 1 }, { trigger: "push", source: "test" })) as { packet_id: string };
  await waitFor(() => written().some((l) => l.packet_id === id.packet_id), 5000, "packet written");
  expect(written().find((l) => l.packet_id === id.packet_id)?.data.v).toBe("one");
  expect((await pipo("rollback", "hist", "v1", ...N)).stdout).toContain("hist already runs that definition (v3)");
  const rbj = JSON.parse((await pipo("rollback", "hist", "2", ...N, "--json")).stdout);
  expect(rbj).toMatchObject({ ok: true, result: { version: 4, previous: 3, changed: true, rolled_back_to: 2 } });

  // Errors: an unknown version, a bad argument, a usage error.
  const unknown = await pipo("rollback", "hist", "9", ...N);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("hist has no version 9 (versions are v1 to v4)");
  expect(unknown.stderr).toContain("hint: list them with pipo history hist");
  const noDiff = await pipo("diff", "hist", "1", "12", ...N);
  expect(noDiff.stderr).toContain("hist has no version 12");
  const bad = await pipo("rollback", "hist", "latest", ...N);
  expect(bad.stderr).toContain("version 'latest' is not a version");
  expect(bad.stderr).toContain("hint: use a version number such as 3 or v3");
  expect((await pipo("diff", "hist", "1", ...N)).code).toBe(64);

  // Stopped: history and diff read the journal; rollback needs the runner.
  await runner.stop();
  const off = await pipo("history", "hist", ...N);
  expect(off.code).toBe(0);
  expect(off.stdout).toContain("not running: the next start runs v4 unless its file changed since the last start");
  expect(off.stdout).toMatch(/ v3\s+\S+ ago\s+cli\s+0\s+[0-9a-f]{12}\s+rollback to v1/);
  expect(JSON.parse((await pipo("history", "hist", ...N, "--json")).stdout)).toMatchObject({ source: "journal" });
  expect((await pipo("diff", "hist", "3", "4", ...N)).stdout).toContain("+  tag: { from: input, transform: fn.two }");
  const stopped = await pipo("rollback", "hist", "1", ...N);
  expect(stopped.code).toBe(1);
  expect(stopped.stderr).toContain("'hist' is not running, so it can't roll back");
  expect(stopped.stderr).toContain("hint: start it first: pipo start <file|hist>");
  const none = await pipo("history", "nope", ...N);
  expect(none.stderr).toContain("no pipeline named 'nope'");
});
