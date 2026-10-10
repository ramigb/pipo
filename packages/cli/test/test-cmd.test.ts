import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyExampleDir, sandbox } from "../../runner/test/helpers";
import { runCli } from "../src/cli";
import { changedPaths } from "../src/test-cmd";

const ROOT = join(import.meta.dir, "../../..");
const sb = sandbox();
let n = 0;

// In-process, errors included (runCli prints a thrown CliError to stderr, as the real command does).
async function pipo(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await runCli([...args, "--home", sb.home]);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const PIPE = `pipo: 1
name: demo
input: { via: push }
nodes:
  shape:
    from: input
    transform: map
    with: { data: { n: "\${data.n}" } }
output: { from: shape, to: file, with: { path: ./out.jsonl } }
`;

const AGENT_PIPE = `pipo: 1
name: demo
agent_budget: { per_day: 1.0, per_packet: 1000 }
input: { via: push }
nodes:
  classify:
    from: input
    agent: claude_api
    with: { model: claude-sonnet-5-5, prompt: "go \${json(data)}", schema: ./c.schema.json }
output: { from: classify, to: file, with: { path: ./out.jsonl } }
`;

/** A pipeline folder under /tmp with the given fixtures. */
function project(fixtures: Record<string, unknown>, pipe = PIPE) {
  const dir = join(sb.root, `case-${n++}`);
  mkdirSync(join(dir, "fixtures"), { recursive: true });
  writeFileSync(join(dir, "demo.pipo"), pipe);
  writeFileSync(join(dir, "c.schema.json"), JSON.stringify({ type: "object", required: ["label"] }));
  for (const [name, v] of Object.entries(fixtures)) writeFileSync(join(dir, "fixtures", name), JSON.stringify(v));
  return dir;
}
const snap = (dir: string, name: string) => join(dir, "fixtures", "__snapshots__", `${name}.snap.json`);

test("first run writes snapshots and reports new; second run passes", async () => {
  const dir = project({ "a.json": { n: 1 } });
  const first = await pipo("test", dir);
  expect(first.code).toBe(0);
  expect(first.stdout).toContain("✓ a  delivered (new snapshot written)");
  expect(first.stdout).toContain("demo: 1 passed, 0 failed");
  expect(JSON.parse(readFileSync(snap(dir, "a"), "utf8")).outcome).toBe("delivered");
  const second = await pipo("test", join(dir, "demo.pipo"));
  expect(second.code).toBe(0);
  expect(second.stdout).toContain("✓ a  delivered\n");
});

test("a changed result fails with the changed paths and a hint; --update-snapshots accepts it", async () => {
  const dir = project({ "a.json": { n: 1 } });
  await pipo("test", dir);
  writeFileSync(join(dir, "fixtures", "a.json"), JSON.stringify({ n: 2 }));
  const bad = await pipo("test", dir);
  expect(bad.code).toBe(1);
  expect(bad.stdout).toContain("✗ a");
  expect(bad.stdout).toContain("$.units[0].data.n: 1 → 2");
  expect(bad.stdout).toContain("--update-snapshots if the change is intended");
  const upd = await pipo("test", dir, "--update-snapshots");
  expect(upd.code).toBe(0);
  expect(upd.stdout).toContain("(snapshot updated)");
  expect((await pipo("test", dir)).code).toBe(0);
});

test("a missing stub fails the fixture with its hint and writes no snapshot; stubs.json fixes it", async () => {
  const dir = project({ "a.json": { n: 1 } }, AGENT_PIPE);
  const r = await pipo("test", dir);
  expect(r.stderr).toBe("");
  expect(r.stdout).toContain("✗ a  failed");
  expect(r.stdout).toContain("stubs.classify");
  expect(existsSync(snap(dir, "a"))).toBe(false);
  writeFileSync(join(dir, "fixtures", "stubs.json"), JSON.stringify({ classify: { label: "x" } }));
  const ok = await pipo("test", dir);
  expect(ok.code).toBe(0);
  expect(readdirSync(join(dir, "fixtures")).sort()).toEqual(["__snapshots__", "a.json", "stubs.json"]);
});

test("--json prints the fixtures with status and outcome, and the counts", async () => {
  const dir = project({ "a.json": { n: 1 }, "b.json": { n: 2 } });
  await pipo("test", dir);
  writeFileSync(join(dir, "fixtures", "b.json"), JSON.stringify({ n: 3 }));
  const r = await pipo("test", dir, "--json");
  expect(r.code).toBe(1);
  const j = JSON.parse(r.stdout);
  expect(j).toMatchObject({ pipeline: "demo", passed: 1, failed: 1 });
  expect(j.fixtures[0]).toEqual({ name: "a", status: "pass", outcome: "delivered" });
  expect(j.fixtures[1]).toMatchObject({ name: "b", status: "fail", outcome: "delivered" });
  expect(j.fixtures[1].diff[0]).toContain("→");
});

test("errors say what to do: no fixtures, no folder, no pipeline, check errors", async () => {
  const dir = project({});
  const none = await pipo("test", dir);
  expect(none.code).toBe(1);
  expect(none.stderr).toContain("has no fixtures");
  expect(none.stderr).toContain("hint:");
  const missing = await pipo("test", dir, "--fixtures", join(dir, "nope"));
  expect(missing.stderr).toContain("no fixtures folder");
  expect(missing.stderr).toContain("--fixtures");
  const nofile = await pipo("test", join(sb.root, "nothing"));
  expect(nofile.stderr).toContain("no such file or directory");
  const bad = project({ "a.json": { n: 1 } }, PIPE.replace("from: input", "from: nowhere"));
  const check = await pipo("test", bad);
  expect(check.code).toBe(1);
  expect(check.stderr).toContain("P010");
  expect(check.stderr).toContain("pipo check");
  const json = JSON.parse((await pipo("test", dir, "--json")).stdout);
  expect(json).toMatchObject({ ok: false, code: "error" });
  expect(json.hint).toContain("<name>.json");
});

test("changedPaths lists both sides of every difference", () => {
  expect(changedPaths({ a: [1, 2], b: "x" }, { a: [1, 3, 4], c: true })).toEqual([
    "$.a[1]: 2 → 3",
    "$.a[2]: (missing) → 4",
    '$.b: "x" → (missing)',
    "$.c: (missing) → true",
  ]);
});

for (const example of ["people-intake", "heartbeat", "inbox-forward", "ticket-triage", "ci", "deploy"]) {
  test(`examples/${example} passes pipo test (copied into a sandbox; snapshots are committed)`, async () => {
    const dir = join(sb.root, `ex-${example}`);
    copyExampleDir(join(ROOT, "examples", example), dir);
    const r = await pipo("test", dir);
    expect(r.stdout).not.toContain("new snapshot");
    expect(r.code).toBe(0);
  });
}

for (const template of ["agent-classifier", "cron-to-file", "watch-to-http", "webhook-to-sqlite"]) {
  test(`a ${template} scaffold passes pipo test out of the box`, async () => {
    const dir = join(sb.root, `scaffold-${template}`);
    const made = await pipo("new", "demo-pipe", "--template", template, "--dir", dir);
    expect(made.code).toBe(0);
    const r = await pipo("test", dir);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("1 passed, 0 failed");
    expect(r.code).toBe(0);
  });
}
