// `pipo proposals` and `pipo resolve` (docs/spec.md §6, §9.3, D50, D51): in-process with --no-engine against a runner
// started in the test: list, propose (applied, or held with --hold), show, apply, reject; then reads from the journal
// once it stopped; errors say what to do.
import { afterAll, expect, test } from "bun:test";
import { Runner } from "@pipo/runner";
import { sandbox } from "../../runner/test/helpers";
import { main } from "../src/cli";

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
const json = async (...args: string[]) => JSON.parse((await pipo(...args, ...N, "--json")).stdout);

sb.write(
  "fns.ts",
  `export const one = (d) => ({ ...d, v: "one" });\nexport const two = (d) => ({ ...d, v: "two" });\nexport const three = (d) => ({ ...d, v: "three" });\n`,
);
const SRC = (tag: string) => `pipo: 1
name: prop
fn: ./fns.ts
input: { via: push }
nodes:
  tag: { from: input, transform: fn.${tag} }
output: { from: tag, to: file, with: { path: ./prop.jsonl, format: jsonl } }
`;
const file = sb.write("prop.pipo", SRC("one"));
const two = sb.write("two.pipo", SRC("two"));
const three = sb.write("three.pipo", SRC("three"));

test("propose, hold, show, apply and reject; then reads from the journal", async () => {
  const runner = await Runner.open({ file, home: sb.home, log: () => {} });
  runners.push(runner);
  await runner.start();

  const none = await pipo("proposals", "prop", ...N);
  expect(none.stdout).toContain("prop has no change proposals");

  // A human's proposal applies at once, as the current version + 1.
  const done = await json("proposals", "prop", "propose", two, "--reason", "use two", "--by", "ada");
  expect(done).toMatchObject({
    ok: true,
    proposal: { state: "applied", applied_version: 2, author: "ada", author_kind: "human" },
  });
  expect(runner.version).toBe(2);

  // --hold stores it; apply applies it.
  const held = await json("proposals", "prop", "propose", three, "--reason", "use three", "--hold");
  expect(held.proposal.state).toBe("validated");
  expect(runner.version).toBe(2);
  const text = await pipo("proposals", "prop", "show", held.proposal.id, ...N);
  expect(text.stdout).toContain(`${held.proposal.id}  validated  against v2`);
  expect(text.stdout).toContain("+  tag: { from: input, transform: fn.three }");
  const shown = await json("proposals", "prop", "show", held.proposal.id);
  expect(shown.proposal).toMatchObject({ id: held.proposal.id, state: "validated", reason: "use three" });
  const applied = await pipo("proposals", "prop", "apply", held.proposal.id, ...N);
  expect(applied.stdout).toContain(`applied proposal ${held.proposal.id}: new packets use v3`);
  expect(runner.version).toBe(3);

  // Reject needs a reason; a held proposal is rejected; a decided one can't be.
  const again = await json("proposals", "prop", "propose", two, "--reason", "back", "--hold");
  const noReason = await pipo("proposals", "prop", "reject", again.proposal.id, ...N);
  expect(noReason.stderr).toContain("reject needs --reason");
  const rej = await pipo("proposals", "prop", "reject", again.proposal.id, "--reason", "no", ...N);
  expect(rej.stdout).toContain(`rejected proposal ${again.proposal.id}: no`);
  const late = await pipo("proposals", "prop", "reject", held.proposal.id, "--reason", "late", ...N);
  expect(late.code).toBe(1);
  expect(late.stderr).toContain("is applied, so it can't become rejected");
  expect(late.stderr).toContain("hint:");

  const list = await json("proposals", "prop");
  expect(list.proposals.map((p: any) => p.state).sort()).toEqual(["applied", "applied", "rejected"]);
  const onlyRejected = await json("proposals", "prop", "--state", "rejected");
  expect(onlyRejected.proposals).toHaveLength(1);
  expect((await pipo("proposals", "prop", ...N)).stdout).toMatch(/ID\s+STATE\s+VERSION\s+AUTHOR\s+CREATED\s+REASON/);

  // Errors with hints.
  const badState = await pipo("proposals", "prop", "--state", "bogus", ...N);
  expect(badState.stderr).toContain("hint: use one of validated, verified, applied, rejected");
  const noFile = await pipo("proposals", "prop", "propose", "/nonexistent.pipo", "--reason", "x", ...N);
  expect(noFile.stderr).toContain("cannot read /nonexistent.pipo");
  const noWhy = await pipo("proposals", "prop", "propose", two, ...N);
  expect(noWhy.stderr).toContain("propose needs --reason");
  const missing = await pipo("proposals", "prop", "show", "pr_nope", ...N);
  expect(missing.stderr).toContain("prop has no proposal pr_nope");
  expect(missing.stderr).toContain("hint: list them with pipo proposals prop");
  expect((await pipo("proposals", "prop", "frobnicate", ...N)).code).toBe(64);

  // resolve: usage, and the runner's refusal for an unknown packet.
  expect((await pipo("resolve", "prop", ...N)).code).toBe(64);
  const gone = await pipo("resolve", "prop", "01NOPE", "--action", "retry", ...N);
  expect(gone.code).toBe(1);
  expect(gone.stderr).toContain("no packet '01NOPE' in prop");

  // Stopped: reads come from the journal; propose needs the runner.
  await runner.stop();
  const off = await json("proposals", "prop");
  expect(off).toMatchObject({ source: "journal" });
  expect(off.proposals).toHaveLength(3);
  const stopped = await pipo("proposals", "prop", "propose", two, "--reason", "x", ...N);
  expect(stopped.code).toBe(1);
  expect(stopped.stderr).toContain("'prop' is not running, so it can't take proposals");
}, 60_000);

test("propose exits 1 with the reason and a hint when the proposal is rejected; 0 when applied (R-38)", async () => {
  const src = (tag: string) => SRC(tag).replace("name: prop", "name: prop2");
  const f2 = sb.write("prop2.pipo", src("one"));
  const good = sb.write("prop2-good.pipo", src("two"));
  const bad = sb.write("prop2-bad.pipo", src("two").replace("from: input", "from: nowhere"));
  const runner = await Runner.open({ file: f2, home: sb.home, log: () => {} });
  runners.push(runner);
  await runner.start();

  const rejected = await pipo("proposals", "prop2", "propose", bad, "--reason", "broken", ...N);
  expect(rejected.code).toBe(1);
  expect(rejected.stderr).toContain("was rejected: [invalid_pipeline]");
  expect(rejected.stderr).toContain("[P010]");
  expect(rejected.stderr).toContain("hint:");
  const rejectedJson = await pipo("proposals", "prop2", "propose", bad, "--reason", "broken", ...N, "--json");
  expect(rejectedJson.code).toBe(1);
  expect(runner.version).toBe(1);

  const ok = await pipo("proposals", "prop2", "propose", good, "--reason", "fine", ...N);
  expect(ok.code).toBe(0);
  expect(runner.version).toBe(2);
  const held = await pipo("proposals", "prop2", "propose", f2, "--reason", "held", "--hold", ...N);
  expect(held.code).toBe(0);

  expect((await pipo("help", "proposals")).stdout).toContain("--limit");
}, 60_000);
