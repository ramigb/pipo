// Packets handed to the agent (docs/spec.md §3.9, §3.10, §9, D50), end to end over the Rust runner's control socket:
// `then: agent` in each policy position (node on_error, the errors default, loop.then, output.on_error with and without
// a batch, delivered.on_fail, input.on_invalid), a fan-out copy, `delivered.stall.then: agent` and
// `agent.on_stall: handle`; the `resolve` op (retry on the pinned version, dead_letter, drop) and its refusals. The step
// that fails is an http tap against a server the test turns on and off. SIGKILL while a packet waits is in
// escalation-recovery.test.ts.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ControlError, PacketRow } from "../src";
import { sandbox, waitFor } from "./helpers";
import { RustRunner } from "./rust";

setDefaultTimeout(60_000);

let cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** An endpoint that fails (500) while `down`, counting calls per packet id (the request body's `id`). */
function endpoint() {
  const state = { down: true, hits: new Map<string, number>(), total: 0 };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json().catch(() => ({}))) as { id?: string };
      state.total++;
      if (body.id) state.hits.set(body.id, (state.hits.get(body.id) ?? 0) + 1);
      return state.down ? new Response("down", { status: 500 }) : new Response("ok");
    },
  });
  cleanups.push(() => server.stop(true));
  return { state, url: `http://127.0.0.1:${server.port}/x` };
}

/** `tap: http` to the endpoint: data passes on unchanged, and it fails while the endpoint is down. */
const flaky = (url: string, rest = "") =>
  `{ from: input, tap: http, with: { url: "${url}", method: POST, body: { id: "\${meta.packet_id}" } }${rest} }`;

async function setup(name: string, body: (box: ReturnType<typeof sandbox>, url: string) => string) {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  const ep = endpoint();
  box.write("fns.ts", "export const same = (d) => d;\n");
  const file = box.write(`${name}.pipo`, `pipo: 1\nname: ${name}\nfn: ./fns.ts\n${body(box, ep.url)}`);
  const r = await RustRunner.start(box, file, name, { listen: null });
  cleanups.push(() => (r.proc.exitCode === null ? r.kill() : undefined));
  const push = async (data: unknown) => (await r.push(data)).packet_id;
  const row = (id: string) => r.packet(id) as PacketRow;
  const escalated = (id: string) =>
    waitFor(() => (row(id)?.state === "escalated" ? row(id) : null), 10_000, `${id} escalated`);
  const events = (id: string | null, type: string) =>
    r
      .query<{ detail: string | null }>(
        "SELECT detail FROM events WHERE packet_id IS ? AND type = ? ORDER BY seq",
        id,
        type,
      )
      .map((e) => (e.detail === null ? null : JSON.parse(e.detail)));
  const calls = (id: string) => ep.state.hits.get(id) ?? 0;
  const err = (p: Promise<unknown>) => p.then(() => null).catch((e: ControlError) => e);
  return { box, r, ep, push, row, escalated, events, calls, err };
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
      (_, url) => `input: { via: push }
nodes:
  tag: ${flaky(url, `, on_error: { retry: 1, delay: 10ms, then: agent, message: "tag failed: \${error.message}" }`)}
${FILE_OUT("nodeagent")}
agent: { control: true }
`,
    );
    const id = await t.push({ n: 1 });
    const row = await t.escalated(id);
    expect(row.cursor).toBe("tag");
    expect(row.error).toMatchObject({ code: "node.failed", node: "tag", attempts: 2 });
    expect(row.error?.message).toStartWith("tag failed: ");
    expect(row.error?.message).toContain("500");
    expect(t.events(id, "packet.escalated")).toEqual([{ reason: "error", error: row.error }]);
    expect(t.calls(id)).toBe(2);
    // It waits: no more attempts, nothing written; pending, and listed as escalated.
    await Bun.sleep(200);
    expect(t.calls(id)).toBe(2);
    expect(written(t.box, "nodeagent")).toEqual([]);
    const status = await t.r.status();
    expect(status.stats).toMatchObject({ pending: 1, escalated: 1, dead_lettered: 0 });
    expect((await t.r.request("packets", { state: "escalated" })).packets.map((p: any) => p.packet_id)).toEqual([id]);
    expect(t.r.lines().some((l) => l.includes(`packet ${id} handed to the agent at tag`))).toBe(true);

    // A newer version does not change where it resumes: it finishes on v1 (§7.3).
    const source = readFileSync(join(t.box.root, "nodeagent.pipo"), "utf8").replace(
      /tag: \{ from: input, tap: http.*\n/,
      'tag: { from: input, filter: "true" }\n',
    );
    expect((await t.r.request("apply", { source, reason: "v2" })).version).toBe(2);
    t.ep.state.down = false;
    const res = await t.r.request("resolve", { ids: [id], action: "retry", by: "agent-ops", by_kind: "agent" });
    expect(res).toEqual({ action: "retry", resolved: [{ packet_id: id, state: "processing", node: "tag" }] });
    const done = await t.r.settled(id);
    expect(done).toMatchObject({ state: "delivered", version: 1 });
    expect(t.calls(id)).toBe(3);
    await waitFor(() => written(t.box, "nodeagent").length === 1, 5000, "the output line");
    expect(written(t.box, "nodeagent")).toMatchObject([{ packet_id: id, data: { n: 1 } }]);
    expect(t.events(id, "packet.resolved")).toEqual([
      { action: "retry", by: "agent-ops", by_kind: "agent", reason: null, error: row.error },
    ]);
    // Resolving it again is refused: it no longer waits.
    const again = await t.err(t.r.request("resolve", { ids: [id], action: "retry" }));
    expect(again).toMatchObject({ code: "invalid_state" });
    expect((again as ControlError).message).toContain("is delivered, not waiting for an agent");
  });

  test("the errors default: dead_letter puts it in the DLQ, where a replay resumes it at the node", async () => {
    const t = await setup(
      "defaultagent",
      (_, url) => `input: { via: push }
errors: { then: agent }
nodes:
  tag: ${flaky(url)}
${FILE_OUT("defaultagent")}
agent: { control: true }
`,
    );
    const ids = [await t.push({ n: 1 }), await t.push({ n: 2 })];
    for (const id of ids) await t.escalated(id);
    const res = await t.r.request("resolve", { ids, action: "dead_letter", by: "ops", reason: "bad batch" });
    expect(res.resolved.map((r: any) => r.state)).toEqual(["dead_lettered", "dead_lettered"]);
    expect(t.row(ids[0] as string)).toMatchObject({ state: "dead_lettered", cursor: null, error: { node: "tag" } });
    expect(t.events(ids[0] as string, "packet.resolved")[0]).toMatchObject({
      action: "dead_letter",
      reason: "bad batch",
    });
    expect((await t.r.request("dlq")).total).toBe(2);
    t.ep.state.down = false;
    await t.r.request("replay", { ids: [ids[0]] });
    expect((await t.r.settled(ids[0] as string)).state).toBe("delivered");
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
    await t.r.request("resolve", { ids: [id], action: "retry" });
    await waitFor(
      () => t.row(id).state === "escalated" && t.events(id, "packet.escalated").length === 2,
      5000,
      "again",
    );
    expect(t.events(id, "node.looped").length).toBe(4);
    await t.r.request("resolve", { ids: [id], action: "drop", by: "ops" });
    expect(t.row(id)).toMatchObject({ state: "filtered", error: { code: "loop.max" } });
    expect(t.events(id, "packet.dropped").length).toBe(1);
  });

  test("output.on_error: waits at the output; drop is refused there; a retry writes it once", async () => {
    const t = await setup(
      "outagent",
      (_, url) => `input: { via: push }
nodes:
  tag: { from: input, transform: fn.same }
output:
  from: tag
  to: http
  with: { url: "${url}", method: POST, body: { id: "\${meta.packet_id}" } }
  on_error: { retry: 1, delay: 10ms, then: agent }
agent: { control: true }
`,
    );
    const id = await t.push({ n: 1 });
    const row = await t.escalated(id);
    expect(row).toMatchObject({ cursor: "$output", error: { code: "output.failed", node: "output", attempts: 2 } });
    expect(t.calls(id)).toBe(2);
    const drop = await t.err(t.r.request("resolve", { packet_id: id, action: "drop" }));
    expect(drop).toMatchObject({ code: "invalid_state" });
    expect((drop as ControlError).message).toContain("drop is not allowed");
    expect(t.row(id).state).toBe("escalated");
    t.ep.state.down = false;
    await t.r.request("resolve", { packet_id: id, action: "retry" });
    expect((await t.r.settled(id)).state).toBe("delivered");
    expect(t.calls(id)).toBe(3);
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
    for (const id of [ids[0], ids[2]]) expect((await t.r.settled(id as string)).state).toBe("delivered");
    await t.r.request("resolve", { ids: [ids[1]], action: "retry" });
    await waitFor(() => t.events(ids[1] as string, "packet.escalated").length === 2, 5000, "escalated again");
    expect(t.events(ids[1] as string, "output.batched").length).toBe(2);
    await t.r.request("resolve", { ids: [ids[1]], action: "dead_letter" });
    expect(t.row(ids[1] as string).state).toBe("dead_lettered");
  });

  test("delivered.on_fail: waits with node delivered; dead_letter sends it to the DLQ at the output", async () => {
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
    await t.r.request("resolve", { ids: [id], action: "dead_letter" });
    expect(t.row(id).state).toBe("dead_lettered");
    // The DLQ replay resumes it at the output, as for any delivery failure (D33).
    expect((await t.r.request("dlq")).packets[0].node).toBe("delivered");
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
    const e = await t.err(t.r.request("push", { data: { n: 0 } }));
    const id = (e as ControlError).packetId as string;
    expect(id).toBeTruthy();
    expect(t.row(id).state).toBe("rejected");
    expect(t.events(id, "packet.escalated")).toMatchObject([{ reason: "rejected", waiting: false }]);
    expect((await t.r.status()).stats.escalated).toBe(0);
  });

  test("a fan-out copy waits on its own; the packet settles when the copy is resolved", async () => {
    const t = await setup(
      "fanagent",
      (_, url) => `input: { via: push }
nodes:
  a: { from: input, transform: fn.same }
  b: ${flaky(url, ", on_error: { then: agent }")}
output: { from: [a, b], to: file, with: { path: ./fan.jsonl, format: jsonl } }
agent: { control: true }
`,
    );
    const id = await t.push({ n: 1 });
    const copy = `${id}:b`;
    await t.escalated(copy);
    await waitFor(() => t.row(`${id}:a`).state === "delivered", 5000, "copy a delivered");
    expect(t.row(id).state).toBe("branched");
    expect((await t.r.status()).stats).toMatchObject({ pending: 1, escalated: 1 });
    expect((await t.r.request("packets", { state: "escalated" })).packets.map((p: any) => p.packet_id)).toEqual([copy]);
    const whole = await t.err(t.r.request("resolve", { ids: [id], action: "drop" }));
    expect(whole).toMatchObject({ code: "invalid_state" });
    expect((whole as ControlError).hint).toContain(copy);
    await t.r.request("resolve", { ids: [copy], action: "drop" });
    await waitFor(() => t.row(id).state === "delivered", 5000, "the packet delivered");
    expect((await t.r.status()).stats).toMatchObject({ pending: 0, escalated: 0 });
  });
});

describe("resolve", () => {
  test("bad requests, unknown ids and agents without control are refused, and a list is all or nothing", async () => {
    const t = await setup(
      "resolveargs",
      (_, url) => `input: { via: push }
nodes:
  tag: ${flaky(url, ", on_error: { then: agent }")}
${FILE_OUT("resolveargs")}
agent: { control: true }
`,
    );
    const id = await t.push({ n: 1 });
    await t.escalated(id);
    const code = async (args: Record<string, unknown>) =>
      ((await t.err(t.r.request("resolve", args))) as ControlError)?.code;
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
    await t.r.request("apply", { source, reason: "no agent" });
    expect(await code({ ids: [id], action: "retry", by_kind: "agent" })).toBe("invalid_state");
    expect(t.row(id).state).toBe("escalated");
    t.ep.state.down = false;
    await t.r.request("resolve", { ids: [id], action: "retry", by: "cli", by_kind: "human" });
    expect((await t.r.settled(id)).state).toBe("delivered");
  });

  test("a waiting packet holds a buffer.max slot; drain does not wait for it", async () => {
    const t = await setup(
      "resolvebuffer",
      (_, url) => `input: { via: push }
buffer: { max: 1 }
nodes:
  tag: ${flaky(url, ", on_error: { then: agent }")}
${FILE_OUT("resolvebuffer")}
agent: { control: true }
`,
    );
    const id = await t.push({ n: 1 });
    await t.escalated(id);
    expect(await t.err(t.r.request("push", { data: { n: 2 } }))).toMatchObject({ code: "unavailable" });
    const started = Date.now();
    expect(await t.r.stop()).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(t.r.query("SELECT state FROM packets WHERE id = ?", id)).toEqual([{ state: "escalated" }]);
  });
});

describe("stalls", () => {
  const stalled = (name: string, stall: string, agent: string) =>
    setup(
      name,
      (_, url) => `input: { via: push }
concurrency: 1
errors: { retry: 1000, backoff: fixed, delay: 50ms, then: dead_letter }
nodes:
  tag: { from: input, transform: fn.same }
output:
  from: tag
  to: http
  with: { url: "${url}", method: POST }
delivered:
  stall:
${stall}
agent: ${agent}
`,
    );
  const status = async (r: RustRunner) => (await r.status()).status;

  test("then: agent flags the stall like notify and journals an escalation; packets keep moving", async () => {
    const t = await stalled("stallagent", "    after: 300ms\n    then: agent", "{ control: true }");
    const id = await t.push({ n: 1 });
    await waitFor(async () => (await status(t.r)) === "jammed", 5000, "jammed");
    expect((await t.r.status()).state).toBe("active");
    const [esc] = t.events(null, "pipeline.escalated");
    expect(esc).toMatchObject({ reason: "stall", then: "agent", handle: false });
    expect(esc.message).toContain("jammed");
    expect(t.events(null, "pipeline.stall")[0].then).toBe("agent");
    expect(t.row(id).state).toBe("writing");
    t.ep.state.down = false;
    expect((await t.r.settled(id)).state).toBe("delivered");
    await waitFor(async () => (await status(t.r)) === "active", 5000, "unjammed");
  });

  test("on_stall: handle hands every unit in flight to the agent: queued ones now, the one a worker holds after its attempt", async () => {
    const t = await stalled("stallhandle", "    after: 300ms\n    then: notify", "{ control: true, on_stall: handle }");
    const ids = [await t.push({ n: 1 }), await t.push({ n: 2 }), await t.push({ n: 3 })];
    for (const id of ids) await t.escalated(id);
    const [esc] = t.events(null, "pipeline.escalated");
    expect(esc).toMatchObject({ reason: "stall", then: "notify", handle: true, units: { escalated: 2, marked: 1 } });
    // The first was retrying at the output (concurrency 1): its step's error; the queued ones: the stall's.
    expect(t.row(ids[0] as string).error).toMatchObject({ code: "output.failed", node: "output" });
    expect(t.row(ids[1] as string)).toMatchObject({ cursor: "tag", error: { code: "stall", node: "tag" } });
    for (const id of ids) expect(t.events(id, "packet.escalated")[0].reason).toBe("stall");
    // Waiting units don't keep the stall going, and nothing retries any more.
    const retries = () => t.r.query<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'step.retry'")[0]?.n;
    const before = retries();
    await Bun.sleep(400);
    expect(retries()).toBe(before);
    expect(t.events(null, "pipeline.stall").length).toBe(1);
    t.ep.state.down = false;
    await t.r.request("resolve", { ids, action: "retry", by: "agent-ops", by_kind: "agent" });
    for (const id of ids) expect((await t.r.settled(id)).state).toBe("delivered");
    await waitFor(async () => (await status(t.r)) === "active", 5000, "unjammed");
  });
});
