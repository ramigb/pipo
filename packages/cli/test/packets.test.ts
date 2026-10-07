// `pipo packets|inspect|dlq|push|ack` (docs/spec.md §6, §8, D33, D34): in-process with --no-engine against a runner
// started in the test (and its journal once it stopped), and end to end through an engine started on demand: a step
// that fails the first time only dead-letters a packet, `pipo dlq replay` delivers it exactly once. Subprocess output
// goes to files, never a pipe; an engine that never comes up is retried once.
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runner } from "@pipo/runner";
import { sandbox, waitFor } from "../../runner/test/helpers";
import { main } from "../src/cli";
import { formatMs, table } from "../src/packets";

const sb = sandbox();
const pids: number[] = [];
const runners: Runner[] = [];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
afterAll(async () => {
  for (const r of runners) await r.stop().catch(() => {});
  for (const f of ["engine.json", "flow.json"]) {
    const path = join(sb.home, "run", f);
    if (existsSync(path)) pids.push(JSON.parse(readFileSync(path, "utf8")).pid);
  }
  for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
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
const json = (r: Result) => JSON.parse(r.stdout);
const H = ["--home", sb.home];
const N = [...H, "--no-engine"];

// `once` fails the first time it is called for a packet whose data has `fail: true`, then passes.
sb.write(
  "fns.ts",
  `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const counter = new URL("./calls.json", import.meta.url).pathname;
export const once = (d) => {
  const calls = existsSync(counter) ? JSON.parse(readFileSync(counter, "utf8")) : {};
  const key = String(d.n);
  calls[key] = (calls[key] ?? 0) + 1;
  writeFileSync(counter, JSON.stringify(calls));
  if (d.fail && calls[key] === 1) throw new Error("first call fails");
  return { ...d, checked: true };
};
`,
);
const pipeline = (name: string, extra = "") =>
  sb.write(
    `${name}.pipo`,
    `pipo: 1
name: ${name}
fn: ./fns.ts
input: { via: push }
nodes:
  check: { from: input, transform: fn.once, on_error: { retry: 0, then: dead_letter } }
output: { from: check, to: file, with: { path: ./${name}.jsonl, format: jsonl } }
${extra}`,
  );
const written = (name: string) => {
  const path = join(sb.root, `${name}.jsonl`);
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
};

test("formatting helpers align columns and shorten durations", () => {
  expect(table(["A", "BB"], [["xyz", "1"]], [1])).toBe("A    BB\nxyz  1");
  expect([formatMs(12), formatMs(1500), formatMs(61_000), formatMs(3_720_000)]).toEqual([
    "12ms",
    "1.50s",
    "1m01s",
    "1h02m",
  ]);
});

test("usage errors exit 64; bad JSON and missing files say what to do", async () => {
  expect((await pipo("packets")).code).toBe(64);
  expect((await pipo("inspect", "x")).code).toBe(64);
  expect((await pipo("dlq")).code).toBe(64);
  expect((await pipo("dlq", "replay", "x", ...N)).code).toBe(64);
  expect((await pipo("dlq", "purge", "x", "id", "--all", ...N)).code).toBe(64);
  expect((await pipo("push", "x", ...N)).code).toBe(64);
  expect((await pipo("push", "x", "--data", "{}", "--file", "f", ...N)).code).toBe(64);
  expect((await pipo("ack", "x")).code).toBe(64);
  const bad = await pipo("push", "x", "--data", "{nope", ...N);
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain("not valid JSON");
  const nofile = await pipo("push", "x", "--file", join(sb.root, "missing.json"), ...N);
  expect(nofile.stderr).toContain("cannot read");
  for (const cmd of ["packets", "inspect", "dlq", "push", "ack"]) expect((await pipo(cmd, "--help")).code).toBe(0);
});

test("--no-engine: push, packets, inspect, dlq, replay and purge over the runner's socket; reads from the journal once stopped", async () => {
  const file = pipeline("direct");
  let runner: Runner | undefined;
  for (let attempt = 0; !runner; attempt++) {
    try {
      runner = await Runner.open({ file, home: sb.home, log: () => {} });
      await runner.start();
    } catch (e) {
      runner = undefined;
      if (attempt > 0) throw e;
    }
  }
  runners.push(runner);

  const pushed = await pipo("push", "direct", "--data", '{"n":1}', ...N);
  expect(pushed.code).toBe(0);
  expect(pushed.stdout).toMatch(/^pushed \w+ into direct \(accepted\)\nengine: down$/);
  const ok = pushed.stdout.split(" ")[1] as string;
  writeFileSync(join(sb.root, "data.json"), '{"n":2,"fail":true}');
  const failed = json(await pipo("push", "direct", "--file", join(sb.root, "data.json"), "--json", ...N));
  expect(failed).toMatchObject({ ok: true, engine: "down", pipeline: "direct", result: { state: "accepted" } });
  const dead = failed.result.packet_id as string;
  await waitFor(() => runner?.journal.get(dead)?.state === "dead_lettered", 5000, "dead letter");
  await waitFor(() => runner?.journal.get(ok)?.state === "delivered", 5000, "delivery");

  const list = await pipo("packets", "direct", ...N);
  expect(list.stdout).toMatch(/^PACKET +STATE +NODE +VER +ATT +RECEIVED +UPDATED +ERROR$/m);
  expect(list.stdout).toMatch(new RegExp(`^${dead} +dead_lettered +check +v1 +0 .*first call fails$`, "m"));
  expect(list.stdout).toMatch(new RegExp(`^${ok} +delivered +- +v1 `, "m"));
  expect(list.stdout).toContain("2 of 2");
  const one = json(await pipo("packets", "direct", "--state", "delivered", "--limit", "1", "--json", ...N));
  expect(one).toMatchObject({ engine: "down", source: "runner", total: 1, next: null });
  expect(one.packets[0].packet_id).toBe(ok);
  const badState = await pipo("packets", "direct", "--state", "lost", ...N);
  expect(badState.code).toBe(1);
  expect(badState.stderr).toContain("unknown packet state");

  const trace = await pipo("inspect", "direct", ok, ...N);
  expect(trace.code).toBe(0);
  expect(trace.stdout).toContain(`packet ${ok}  direct v1  delivered`);
  expect(trace.stdout).toMatch(/^ {2}\d\d:\d\d:\d\d\.\d{3} {2}input +accepted/m);
  expect(trace.stdout).toMatch(/data \{"n":1,"checked":true\}/);
  expect(trace.stdout).toMatch(/output +written/);
  expect(trace.stdout).toMatch(/delivered +delivered/);
  expect((await pipo("inspect", "direct", "nope", ...N)).stderr).toContain("no packet 'nope'");

  const dlq = await pipo("dlq", "direct", ...N);
  expect(dlq.stdout).toMatch(/^PACKET +FAILED AT +ATTEMPTS +VER +DEAD SINCE +ERROR$/m);
  expect(dlq.stdout).toMatch(new RegExp(`^${dead} +check +1 +v1 .*node.failed: first call fails$`, "m"));
  expect(dlq.stdout).toContain("1 of 1 dead-lettered");
  expect(json(await pipo("dlq", "list", "direct", "--json", ...N)).packets).toHaveLength(1);

  const replay = await pipo("dlq", "replay", "direct", dead, ...N);
  expect(replay.code).toBe(0);
  expect(replay.stdout).toContain("replayed 1 packet(s)");
  expect(replay.stdout).toContain(`${dead}  → check`);
  await waitFor(() => runner?.journal.get(dead)?.state === "delivered", 5000, "replayed delivery");
  const again = await pipo("dlq", "replay", "direct", dead, ...N);
  expect(again.code).toBe(1);
  expect(again.stderr).toContain("not in the dead-letter queue");
  expect(written("direct").map((r) => r.packet_id)).toEqual([ok, dead]);
  expect((await pipo("inspect", "direct", dead, ...N)).stdout).toMatch(/check +replayed/);

  // Another dead letter, purged.
  const third = json(await pipo("push", "direct", "--data", '{"n":3,"fail":true}', "--json", ...N)).result.packet_id;
  await waitFor(() => runner?.journal.get(third)?.state === "dead_lettered", 5000, "third dead letter");
  const purge = json(await pipo("dlq", "purge", "direct", "--all", "--json", ...N));
  expect(purge.result).toMatchObject({ purged: 1, packets: [third] });
  expect((await pipo("inspect", "direct", third, ...N)).stdout).toContain("purged from the dead-letter queue");

  const ack = await pipo("ack", "direct", ok, ...N);
  expect(ack.code).toBe(1);
  expect(ack.stderr).toContain("does not wait for an ack");

  // Stopped: reads come from the journal, writes need the runner.
  await runner.stop();
  const offline = json(await pipo("packets", "direct", "--json", ...N));
  expect(offline).toMatchObject({ engine: "down", source: "journal", total: 2 });
  expect((await pipo("inspect", "direct", dead, ...N)).stdout).toContain(`packet ${dead}  direct v1  delivered`);
  const refused = await pipo("dlq", "replay", "direct", "--all", ...N);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("'direct' is not running");
  expect(refused.stderr).toContain("pipo start");
  expect((await pipo("push", "direct", "--data", "{}", ...N)).stderr).toContain("is not running");
  expect((await pipo("packets", "ghost", ...N)).stderr).toContain("no pipeline named 'ghost'");
}, 60_000);

test("through an engine started on demand: a step that fails once dead-letters, dlq replay delivers it exactly once", async () => {
  const file = pipeline("flow");
  let started = await pipo("start", file, ...H, "--json");
  if (started.code !== 0 && /did not come up|not reachable/.test(started.stderr)) {
    started = await pipo("start", file, ...H, "--json");
  }
  expect(started.code).toBe(0);
  expect(json(started)).toMatchObject({ engine: "up", pipeline: "flow" });
  const entry = JSON.parse(readFileSync(join(sb.home, "run", "engine.json"), "utf8"));
  pids.push(entry.pid);

  const pushed = json(await pipo("push", "flow", "--data", '{"n":7,"fail":true}', "--json", ...H));
  expect(pushed).toMatchObject({ engine: "up", result: { state: "accepted" } });
  const id = pushed.result.packet_id as string;
  await waitFor(
    async () => json(await pipo("dlq", "flow", "--json", ...H)).packets.some((p: any) => p.packet_id === id),
    15_000,
    "the packet in the DLQ",
  );
  const listed = await pipo("packets", "flow", "--state", "dead_lettered", ...H);
  expect(listed.stdout).toContain(id);
  expect(listed.stdout).not.toContain("engine: down");

  const replay = json(await pipo("dlq", "replay", "flow", "--all", "--json", ...H));
  expect(replay).toMatchObject({ engine: "up", result: { replayed: 1, packets: [{ packet_id: id }] } });
  await waitFor(
    async () => json(await pipo("packets", "flow", "--state", "delivered", "--json", ...H)).total === 1,
    15_000,
    "the replayed packet delivered",
  );
  const trace = json(await pipo("inspect", "flow", id, "--json", ...H));
  expect(trace.source).toBe("runner");
  expect(trace.steps.map((s: any) => s.event)).toEqual([
    "packet.accepted",
    "packet.dead_lettered",
    "dlq.replayed",
    "node.done",
    "output.written",
    "packet.delivered",
  ]);
  expect(json(await pipo("dlq", "replay", "flow", "--all", "--json", ...H)).result.replayed).toBe(0);
  await Bun.sleep(300);
  expect(written("flow").filter((r) => r.packet_id === id)).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(sb.root, "calls.json"), "utf8"))["7"]).toBe(2);

  expect((await pipo("stop", "flow", "--now", ...H)).code).toBe(0);
  await waitFor(
    async () => json(await pipo("status", "flow", ...H, "--json")).pipelines[0]?.state !== "running",
    15_000,
    "flow to stop",
  );
  const offline = json(await pipo("packets", "flow", "--json", ...H));
  expect(offline).toMatchObject({ engine: "up", source: "journal", total: 1 });
}, 120_000);

test("inspect shows a fan-out packet's copies: their steps in the text, and their events in --json", async () => {
  const file = sb.write(
    "fan.pipo",
    `pipo: 1
name: fan
input: { via: push }
nodes:
  a: { from: input, transform: map, with: { data: { n: "\${data.n}" } } }
  b: { from: input, transform: map, with: { data: { n: "\${data.n}" } } }
output: { from: [a, b], to: file, with: { path: ./fan.jsonl, format: jsonl } }
`,
  );
  const runner = await Runner.open({ file, home: sb.home, log: () => {} });
  await runner.start();
  runners.push(runner);
  const id = json(await pipo("push", "fan", "--data", '{"n":1}', "--json", ...N)).result.packet_id as string;
  await waitFor(() => runner.journal.get(id)?.state === "delivered", 5000, "delivery");

  const text = (await pipo("inspect", "fan", id, ...N)).stdout;
  expect(text).toContain(`packet ${id}  fan v1  delivered`);
  expect(text).toMatch(new RegExp(`branch a \\(${id}:a\\) +delivered`));
  expect(text).toMatch(new RegExp(`branch b \\(${id}:b\\) +delivered`));
  expect(text.match(/output +written/g)).toHaveLength(2);

  const trace = json(await pipo("inspect", "fan", id, "--json", ...N));
  expect(trace.copies.map((c: any) => c.packet.packet_id)).toEqual([`${id}:a`, `${id}:b`]);
  for (const c of trace.copies) {
    expect(c.events.map((e: any) => e.type)).toContain("output.written");
    expect(c.steps.map((s: any) => s.event)).toContain("packet.delivered");
  }
  const copy = json(await pipo("inspect", "fan", `${id}:a`, "--json", ...N));
  expect(copy.packet).toMatchObject({ packet_id: `${id}:a`, branch: "a", state: "delivered" });
});
