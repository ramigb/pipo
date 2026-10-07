// Packets handed to the agent (docs/spec.md §3.9, §3.10, §9, D50), in-process over the control socket: `then: agent`
// in each policy position (node on_error, the errors default, loop.then, output.on_error with and without a batch,
// delivered.on_fail, input.on_invalid), a fan-out copy, `delivered.stall.then: agent` and `agent.on_stall: handle`;
// the `resolve` op (retry on the pinned version, dead_letter, drop) and its refusals. SIGKILL while a packet waits is in
// escalation-recovery.test.ts.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, type ControlError, type PacketRow, Runner } from "../src";
import { rows, sandbox, settled, waitFor } from "./helpers";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function setup(name: string, body: (box: ReturnType<typeof sandbox>) => string) {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  const flag = join(box.root, "fail.flag");
  box.write(
    "fns.ts",
    `import { existsSync, appendFileSync } from "node:fs";
export const flaky = (d, meta) => {
  appendFileSync(${JSON.stringify(join(box.root, "calls.log"))}, meta.packet_id + (meta.branch ? ":" + meta.branch : "") + "\\n");
  if (existsSync(${JSON.stringify(flag)})) throw new Error("flaky is failing");
  return { ...d, ok: true };
};
export const same = (d) => d;
`,
  );
  writeFileSync(flag, "");
  const file = box.write(`${name}.pipo`, `pipo: 1\nname: ${name}\nfn: ./fns.ts\n${body(box)}`);
  const lines: string[] = [];
  const runner = await Runner.open({ file, home: box.home, listen: 0, log: (l) => lines.push(l) });
  await runner.start();
  cleanups.push(() => (runner.state === "stopped" || runner.state === "failed" ? undefined : runner.stop()));
  const c = await ControlClient.forPipeline(box.home, name);
  cleanups.push(() => c.close());
  const push = async (data: unknown) => (await c.request("push", { data })).packet_id as string;
  const row = (id: string) => runner.journal.get(id) as PacketRow;
  const escalated = (id: string) =>
    waitFor(() => (row(id)?.state === "escalated" ? row(id) : null), 10_000, `${id} escalated`);
  const events = (id: string | null, type: string) =>
    (
      runner.journal.db
        .query("SELECT detail FROM events WHERE packet_id IS ? AND type = ? ORDER BY seq")
        .all(id, type) as { detail: string | null }[]
    ).map((e) => (e.detail === null ? null : JSON.parse(e.detail)));
  const calls = (id: string) => {
    const log = join(box.root, "calls.log");
    return existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((l) => l === id).length
      : 0;
  };
  const err = (p: Promise<unknown>) => p.then(() => null).catch((e: ControlError) => e);
  return { box, runner, c, push, row, escalated, events, calls, err, lines, flag: () => rmSync(flag, { force: true }) };
}

const FILE_OUT = (name: string) => `output: { from: tag, to: file, with: { path: ./${name}.jsonl, format: jsonl } }`;
const written = (box: { root: string }, name: string) => {
  const path = join(box.root, `${name}.jsonl`);
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
};

describe("then: agent", () => {
  test("node on_error: the packet waits at the node, counts as pending, and a retry runs it on its pinned version", async () => {
    const t = await setup(
      "nodeagent",
      () => `input: { via: push }
nodes:
  tag: { from: input, transform: fn.flaky, on_error: { retry: 1, delay: 10ms, then: agent, message: "tag failed: \${error.message}" } }
${FILE_OUT("nodeagent")}
agent: { control: true }
`,
    );
    const id = await t.push({ n: 1 });
    const row = await t.escalated(id);
    expect(row.cursor).toBe("tag");
    expect(row.error).toMatchObject({
      code: "node.failed",
      node: "tag",
      attempts: 2,
      message: "tag failed: flaky is failing",
    });
    expect(t.events(id, "packet.escalated")).toEqual([{ reason: "error", error: row.error }]);
    expect(t.calls(id)).toBe(2);
    // It waits: no more attempts, nothing written; pending, and listed as escalated.
    await Bun.sleep(200);
    expect(t.calls(id)).toBe(2);
    expect(written(t.box, "nodeagent")).toEqual([]);
    const status = await t.c.request("status");
    expect(status.stats).toMatchObject({ pending: 1, escalated: 1, dead_lettered: 0 });
    expect((await t.c.request("packets", { state: "escalated" })).packets.map((p: any) => p.packet_id)).toEqual([id]);
    expect(t.lines.some((l) => l.includes(`packet ${id} handed to the agent at tag`))).toBe(true);

    // A newer version does not change where it resumes: it finishes on v1 (§7.3).
    const source = readFileSync(join(t.box.root, "nodeagent.pipo"), "utf8").replace("fn.flaky", "fn.same");
    expect((await t.c.request("apply", { source, reason: "v2" })).version).toBe(2);
    t.flag();
    const res = await t.c.request("resolve", { ids: [id], action: "retry", by: "agent-ops", by_kind: "agent" });
    expect(res).toEqual({ action: "retry", resolved: [{ packet_id: id, state: "processing", node: "tag" }] });
    const done = await settled(t.runner, id);
    expect(done).toMatchObject({ state: "delivered", version: 1 });
    expect(t.calls(id)).toBe(3);
    expect(written(t.box, "nodeagent")).toMatchObject([{ packet_id: id, data: { n: 1, ok: true } }]);
    expect(t.events(id, "packet.resolved")).toEqual([
      { action: "retry", by: "agent-ops", by_kind: "agent", reason: null, error: row.error },
    ]);
    // Resolving it again is refused: it no longer waits.
    const again = await t.err(t.c.request("resolve", { ids: [id], action: "retry" }));
    expect(again).toMatchObject({ code: "invalid_state" });
    expect((again as ControlError).message).toContain("is delivered, not waiting for an agent");
  });

  test("the errors default: dead_letter puts it in the DLQ, where a replay resumes it at the node", async () => {
    const t = await setup(
      "defaultagent",
      () => `input: { via: push }
errors: { then: agent }
nodes:
  tag: { from: input, transform: fn.flaky }
${FILE_OUT("defaultagent")}
agent: { control: true }
`,
    );
    const ids = [await t.push({ n: 1 }), await t.push({ n: 2 })];
    for (const id of ids) await t.escalated(id);
    const res = await t.c.request("resolve", { ids, action: "dead_letter", by: "ops", reason: "bad batch" });
    expect(res.resolved.map((r: any) => r.state)).toEqual(["dead_lettered", "dead_lettered"]);
    expect(t.row(ids[0] as string)).toMatchObject({ state: "dead_lettered", cursor: null, error: { node: "tag" } });
    expect(t.events(ids[0] as string, "packet.resolved")[0]).toMatchObject({
      action: "dead_letter",
      reason: "bad batch",
    });
    expect((await t.c.request("dlq")).total).toBe(2);
    t.flag();
    await t.c.request("replay", { ids: [ids[0]] });
    expect((await settled(t.runner, ids[0] as string)).state).toBe("delivered");
    expect(t.row(ids[1] as string).state).toBe("dead_lettered");
  });

  test("loop.then: a loop that reaches max waits; a retry gets a fresh iteration budget", async () => {
    const t = await setup(
      "loopagent",
      () => `input: { via: push }
nodes:
  tag:
    from: input
    transform: fn.same
    loop: { back_to: tag, until: "data.done == true", max: 2, then: agent }
${FILE_OUT("loopagent")}
agent: { control: true }
`,
    );
    const id = await t.push({ done: false });
    const row = await t.escalated(id);
    expect(row).toMatchObject({ cursor: "tag", error: { code: "loop.max", node: "tag" }, iteration: 2 });
    await t.c.request("resolve", { ids: [id], action: "retry" });
    await waitFor(
      () => t.row(id).state === "escalated" && t.events(id, "packet.escalated").length === 2,
      5000,
      "again",
    );
    expect(t.events(id, "node.looped").length).toBe(4);
    await t.c.request("resolve", { ids: [id], action: "drop", by: "ops" });
    expect(t.row(id)).toMatchObject({ state: "filtered", error: { code: "loop.max" } });
    expect(t.events(id, "packet.dropped").length).toBe(1);
  });

  test("output.on_error: waits at the output; drop is refused there; a retry writes it once", async () => {
    const state = { down: true, hits: 0 };
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        state.hits++;
        return state.down ? new Response("down", { status: 503 }) : new Response("ok");
      },
    });
    cleanups.push(() => void server.stop(true));
    const t = await setup(
      "outagent",
      () => `input: { via: push }
nodes:
  tag: { from: input, transform: fn.same }
output:
  from: tag
  to: http
  with: { url: "http://127.0.0.1:${server.port}/x", method: POST }
  on_error: { retry: 1, delay: 10ms, then: agent }
agent: { control: true }
`,
    );
    const id = await t.push({ n: 1 });
    const row = await t.escalated(id);
    expect(row).toMatchObject({ cursor: "$output", error: { code: "output.failed", node: "output", attempts: 2 } });
    expect(state.hits).toBe(2);
    const drop = await t.err(t.c.request("resolve", { packet_id: id, action: "drop" }));
    expect(drop).toMatchObject({ code: "invalid_state" });
    expect((drop as ControlError).message).toContain("drop is not allowed");
    expect(t.row(id).state).toBe("escalated");
    state.down = false;
    await t.c.request("resolve", { packet_id: id, action: "retry" });
    expect((await settled(t.runner, id)).state).toBe("delivered");
    expect(state.hits).toBe(3);
  });

  test("output.on_error with a batch: the split isolates the failing packet, which waits; a retry batches it again", async () => {
    const t = await setup("batchagent", (box) => {
      const db = new Database(join(box.root, "out.db"));
      db.exec("CREATE TABLE items (packet_id TEXT PRIMARY KEY, n INTEGER CHECK (n <> 1))");
      db.close();
      return `input: { via: push }
nodes:
  tag: { from: input, transform: fn.same }
output:
  from: tag
  to: sqlite
  with: { path: ./out.db, table: items, columns: { packet_id: "\${meta.packet_id}", n: "\${data.n}" } }
  batch: { size: 3, within: 200ms }
  on_error: { then: agent }
agent: { control: true }
`;
    });
    const ids = [await t.push({ n: 0 }), await t.push({ n: 1 }), await t.push({ n: 2 })];
    const row = await t.escalated(ids[1] as string);
    expect(row).toMatchObject({ cursor: "$output", error: { code: "output.failed", node: "output" } });
    for (const id of [ids[0], ids[2]]) expect((await settled(t.runner, id as string)).state).toBe("delivered");
    await t.c.request("resolve", { ids: [ids[1]], action: "retry" });
    await waitFor(() => t.events(ids[1] as string, "packet.escalated").length === 2, 5000, "escalated again");
    expect(t.events(ids[1] as string, "output.batched").length).toBe(2);
    await t.c.request("resolve", { ids: [ids[1]], action: "dead_letter" });
    expect(t.row(ids[1] as string).state).toBe("dead_lettered");
  });

  test("delivered.on_fail: waits with node delivered; a retry writes again (idempotent) and checks again", async () => {
    const t = await setup(
      "verifyagent",
      (box) => `input: { via: push }
nodes:
  tag: { from: input, transform: fn.same }
output: { from: tag, to: file, with: { path: ${join(box.root, "v.jsonl")}, format: jsonl } }
delivered:
  check: line_contains
  with: { value: "a line nobody writes" }
  within: 200ms
  on_fail: { then: agent }
agent: { control: true }
`,
    );
    const id = await t.push({ want: "never-there" });
    const row = await t.escalated(id);
    expect(row).toMatchObject({ cursor: "$output", error: { code: "delivery.unverified", node: "delivered" } });
    await t.c.request("resolve", { ids: [id], action: "dead_letter" });
    expect(t.row(id).state).toBe("dead_lettered");
    // The DLQ replay resumes it at the output, as for any delivery failure (D33).
    expect((await t.c.request("dlq")).packets[0].node).toBe("delivered");
  });

  test("input.on_invalid: the rejection is journaled with an escalation the agent sees; nothing waits", async () => {
    const t = await setup(
      "inputagent",
      () => `input:
  via: push
  validate: ["data.n > 0"]
  on_invalid: { then: agent }
nodes:
  tag: { from: input, transform: fn.same }
${FILE_OUT("inputagent")}
agent: { control: true }
`,
    );
    const e = await t.err(t.c.request("push", { data: { n: 0 } }));
    const id = (e as ControlError).packetId as string;
    expect(t.row(id).state).toBe("rejected");
    expect(t.events(id, "packet.escalated")).toMatchObject([{ reason: "rejected", waiting: false }]);
    expect((await t.c.request("status")).stats.escalated).toBe(0);
  });

  test("a fan-out copy waits on its own; the packet settles when the copy is resolved", async () => {
    const t = await setup(
      "fanagent",
      () => `input: { via: push }
nodes:
  a: { from: input, transform: fn.same }
  b: { from: input, transform: fn.flaky, on_error: { then: agent } }
output: { from: [a, b], to: file, with: { path: ./fan.jsonl, format: jsonl } }
agent: { control: true }
`,
    );
    const id = await t.push({ n: 1 });
    const copy = `${id}:b`;
    await t.escalated(copy);
    await waitFor(() => t.row(`${id}:a`).state === "delivered", 5000, "copy a delivered");
    expect(t.row(id).state).toBe("branched");
    expect((await t.c.request("status")).stats).toMatchObject({ pending: 1, escalated: 1 });
    expect((await t.c.request("packets", { state: "escalated" })).packets.map((p: any) => p.packet_id)).toEqual([copy]);
    const whole = await t.err(t.c.request("resolve", { ids: [id], action: "drop" }));
    expect(whole).toMatchObject({ code: "invalid_state" });
    expect((whole as ControlError).hint).toContain(copy);
    await t.c.request("resolve", { ids: [copy], action: "drop" });
    expect(t.row(id).state).toBe("delivered");
    expect((await t.c.request("status")).stats).toMatchObject({ pending: 0, escalated: 0 });
  });
});

describe("resolve", () => {
  test("bad requests, unknown ids and agents without control are refused, and a list is all or nothing", async () => {
    const t = await setup(
      "resolveargs",
      () => `input: { via: push }
nodes:
  tag: { from: input, transform: fn.flaky, on_error: { then: agent } }
${FILE_OUT("resolveargs")}
agent: { control: true }
`,
    );
    const id = await t.push({ n: 1 });
    await t.escalated(id);
    const code = async (args: Record<string, unknown>) =>
      ((await t.err(t.c.request("resolve", args))) as ControlError)?.code;
    expect(await code({ ids: [id] })).toBe("bad_request");
    expect(await code({ ids: [id], action: "continue" })).toBe("bad_request");
    expect(await code({ action: "retry" })).toBe("bad_request");
    expect(await code({ ids: [id], packet_id: id, action: "retry" })).toBe("bad_request");
    expect(await code({ ids: [id], action: "retry", by_kind: "robot" })).toBe("bad_request");
    expect(await code({ ids: ["nope"], action: "retry" })).toBe("not_found");
    // One unknown id resolves nothing.
    expect(await code({ ids: [id, "nope"], action: "dead_letter" })).toBe("not_found");
    expect(t.row(id).state).toBe("escalated");

    // A version without agent.control: agents can't resolve, people can (the policy in force, D50).
    const source = readFileSync(join(t.box.root, "resolveargs.pipo"), "utf8")
      .replace(", on_error: { then: agent }", "")
      .replace("agent: { control: true }\n", "");
    await t.c.request("apply", { source, reason: "no agent" });
    expect(await code({ ids: [id], action: "retry", by_kind: "agent" })).toBe("invalid_state");
    expect(t.row(id).state).toBe("escalated");
    t.flag();
    await t.c.request("resolve", { ids: [id], action: "retry", by: "cli", by_kind: "human" });
    expect((await settled(t.runner, id)).state).toBe("delivered");
  });

  test("a waiting packet holds a buffer.max slot; drain does not wait for it", async () => {
    const t = await setup(
      "resolvebuffer",
      () => `input: { via: push }
buffer: { max: 1 }
nodes:
  tag: { from: input, transform: fn.flaky, on_error: { then: agent } }
${FILE_OUT("resolvebuffer")}
agent: { control: true }
`,
    );
    const id = await t.push({ n: 1 });
    await t.escalated(id);
    expect(await t.err(t.c.request("push", { data: { n: 2 } }))).toMatchObject({ code: "unavailable" });
    const started = Date.now();
    await t.runner.drain();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(t.runner.state).toBe("stopped");
    const journal = join(t.box.home, "pipelines", "resolvebuffer", "journal.db");
    expect(rows(journal, `SELECT state FROM packets WHERE id = '${id}'`)).toEqual([{ state: "escalated" }]);
  });
});

describe("stalls", () => {
  function stallSetup(name: string, stall: string, agent: string) {
    const state = { down: true };
    const server = Bun.serve({
      port: 0,
      fetch: () => (state.down ? new Response("down", { status: 500 }) : new Response("ok")),
    });
    cleanups.push(() => void server.stop(true));
    return {
      state,
      t: setup(
        name,
        () => `input: { via: push }
concurrency: 1
errors: { retry: 1000, backoff: fixed, delay: 50ms, then: dead_letter }
nodes:
  tag: { from: input, transform: fn.same }
output:
  from: tag
  to: http
  with: { url: "http://127.0.0.1:${server.port}/x", method: POST }
delivered:
  stall:
${stall}
agent: ${agent}
`,
      ),
    };
  }

  test("then: agent flags the stall like notify and journals an escalation; packets keep moving", async () => {
    const { state, t: setupDone } = stallSetup("stallagent", "    after: 300ms\n    then: agent", "{ control: true }");
    const t = await setupDone;
    const id = await t.push({ n: 1 });
    await waitFor(() => t.runner.status === "jammed", 5000, "jammed");
    expect(t.runner.state).toBe("active");
    const [esc] = t.events(null, "pipeline.escalated");
    expect(esc).toMatchObject({ reason: "stall", then: "agent", handle: false });
    expect(esc.message).toContain("jammed");
    expect(t.events(null, "pipeline.stall")[0].then).toBe("agent");
    expect(t.row(id).state).toBe("writing");
    state.down = false;
    expect((await settled(t.runner, id)).state).toBe("delivered");
    await waitFor(() => t.runner.status === "active", 5000, "unjammed");
  });

  test("on_stall: handle hands every unit in flight to the agent: queued ones now, the one a worker holds after its attempt", async () => {
    const { state, t: setupDone } = stallSetup(
      "stallhandle",
      "    after: 300ms\n    then: notify",
      "{ control: true, on_stall: handle }",
    );
    const t = await setupDone;
    const ids = [await t.push({ n: 1 }), await t.push({ n: 2 }), await t.push({ n: 3 })];
    for (const id of ids) await t.escalated(id);
    const [esc] = t.events(null, "pipeline.escalated");
    expect(esc).toMatchObject({ reason: "stall", then: "notify", handle: true, units: { escalated: 2, marked: 1 } });
    // The first was retrying at the output (concurrency 1): its step's error; the queued ones: the stall's.
    expect(t.row(ids[0] as string).error).toMatchObject({ code: "output.failed", node: "output" });
    expect(t.row(ids[1] as string)).toMatchObject({ cursor: "tag", error: { code: "stall", node: "tag" } });
    for (const id of ids) expect(t.events(id, "packet.escalated")[0].reason).toBe("stall");
    // Waiting units don't keep the stall going, and nothing retries any more.
    const retries = (
      t.runner.journal.db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'step.retry'").get() as any
    ).n;
    await Bun.sleep(400);
    expect(
      (t.runner.journal.db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'step.retry'").get() as any).n,
    ).toBe(retries);
    expect(t.events(null, "pipeline.stall").length).toBe(1);
    state.down = false;
    await t.c.request("resolve", { ids, action: "retry", by: "agent-ops", by_kind: "agent" });
    for (const id of ids) expect((await settled(t.runner, id)).state).toBe("delivered");
    await waitFor(() => t.runner.status === "active", 5000, "unjammed");
  });
});
