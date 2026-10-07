// Runner control socket (docs/spec.md §7.2, D24): every op, its errors, the socket's lifecycle, the
// `push` input and the `external` delivery check, all in-process. Kill-and-restart lives in control-recovery.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { ControlClient, ControlError, OPS, Runner, readRegistryEntry, StartError, socketPath } from "../src";
import { ControlServer } from "../src/control/server";
import { sandbox, settled, waitFor } from "./helpers";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function setup() {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  return box;
}

async function boot(
  src: string,
  name: string,
  box = setup(),
  resolver?: (ref: string) => Promise<string>,
  listen?: number,
) {
  const file = box.write(`${name}.pipo`, src);
  const lines: string[] = [];
  const runner = await Runner.open({ file, home: box.home, log: (l) => lines.push(l), resolver, listen });
  await runner.start();
  cleanups.push(() => (runner.state === "stopped" || runner.state === "failed" ? undefined : runner.stop()));
  const client = await ControlClient.forPipeline(box.home, name);
  cleanups.push(() => client.close());
  return { box, file, runner, client, lines };
}

const PUSH = (name: string, extra = "") => `pipo: 1
name: ${name}
input:
  via: push
  validate: ["data.n >= 0"]
output: { from: input, to: file, with: { path: ./out.jsonl, format: jsonl } }
${extra}`;

const EXTERNAL = (name: string, delivered: string, nodes = "", from = "input") => `pipo: 1
name: ${name}
fn: ./fns.ts
input: { via: push }
${nodes}
output: { from: ${from}, to: file, with: { path: ./out.jsonl, format: jsonl } }
delivered: ${delivered}
`;

const lines = (path: string) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** One raw request line, answered on the same connection (for malformed input the client never sends). */
function raw(path: string, payloads: string[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const c = createConnection({ path });
    let buf = "";
    const got: any[] = [];
    c.setEncoding("utf8");
    c.on("error", reject);
    c.on("data", (d: string) => {
      buf += d;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        got.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
      if (got.length === payloads.length) {
        c.destroy();
        resolve(got);
      }
    });
    c.on("connect", () => {
      for (const p of payloads) c.write(`${p}\n`);
    });
  });
}

describe("handshake and status", () => {
  test("hello names the pipeline and version; the registry entry carries the socket", async () => {
    const { box, runner, client } = await boot(PUSH("hi"), "hi");
    const hello = await client.request("hello");
    expect(hello).toMatchObject({
      protocol: 1,
      pipeline: "hi",
      version: runner.version,
      pid: process.pid,
      state: "active",
      status: "active",
    });
    expect(hello.ops).toEqual([...OPS]);
    const entry = readRegistryEntry(box.home, "hi");
    expect(entry?.socket).toBe(socketPath(box.home, "hi"));
    expect(entry?.started_at).toBe(hello.started_at);
    // Only the owner may drive the runner.
    expect(statSync(entry?.socket as string).mode & 0o777).toBe(0o600);
  });

  test("status reports state, stats, pause reason and the last event seq", async () => {
    const { client } = await boot(PUSH("st"), "st");
    const { packet_id } = await client.request("push", { data: { n: 1 } });
    await waitFor(async () => (await client.request("status")).stats.delivered === 1, 5000, "delivery");
    const s = await client.request("status");
    expect(s).toMatchObject({ pipeline: "st", state: "active", paused_reason: null, awaiting_ack: 0, listen: null });
    expect(s.stats).toMatchObject({ accepted: 1, delivered: 1, pending: 0, dead_lettered: 0 });
    expect(s.input).toContain("push");
    expect(s.last_seq).toBeGreaterThan(0);
    expect(typeof packet_id).toBe("string");
  });
});

describe("protocol errors", () => {
  test("unknown op lists the ops; bad JSON answers and keeps the connection usable", async () => {
    const { client, runner } = await boot(PUSH("err"), "err");
    const e = (await client.request("frobnicate").catch((x) => x)) as ControlError;
    expect(e).toBeInstanceOf(ControlError);
    expect(e.code).toBe("unknown_op");
    expect(e.hint).toBe(`ops: ${OPS.join(", ")}`);

    const [bad, notObject, noOp, badArgs, ok] = await raw(runner.socket, [
      "{not json",
      "[1,2]",
      '{"id":3}',
      '{"id":4,"op":"status","args":[1]}',
      '{"id":5,"op":"hello"}',
    ]);
    expect(bad).toMatchObject({ id: null, ok: false, error: { code: "bad_request" } });
    expect(bad.error.message).toContain("bad JSON");
    expect(bad.error.hint).toContain('"op"');
    expect(notObject).toMatchObject({ id: null, ok: false, error: { code: "bad_request" } });
    expect(noOp).toMatchObject({ id: 3, ok: false, error: { code: "bad_request", message: "missing `op`" } });
    expect(badArgs).toMatchObject({ id: 4, ok: false, error: { code: "bad_request" } });
    expect(ok).toMatchObject({ id: 5, ok: true, result: { pipeline: "err" } });
  });

  test("many requests in flight on one connection all get their own answer", async () => {
    const { client } = await boot(PUSH("many"), "many");
    const ids = await Promise.all(
      Array.from({ length: 20 }, (_, n) => client.request("push", { data: { n } }).then((r) => r.packet_id)),
    );
    expect(new Set(ids).size).toBe(20);
  });

  test("responses are redacted", async () => {
    const box = setup();
    const path = join(box.home, "r.sock");
    const server = await ControlServer.listen(
      path,
      () => {
        throw new ControlError("invalid_state", "token s3cr3t-value leaked", "not s3cr3t-value either");
      },
      { redact: (t) => t.split("s3cr3t-value").join("***") },
    );
    cleanups.push(() => server.close());
    const client = await ControlClient.connect(path);
    cleanups.push(() => client.close());
    const e = (await client.request("status").catch((x) => x)) as ControlError;
    expect(e.message).toBe("token *** leaked");
    expect(e.hint).toBe("not *** either");
  });

  test("results are redacted, keys included", async () => {
    const box = setup();
    const path = join(box.home, "r2.sock");
    const server = await ControlServer.listen(
      path,
      () => ({ result: { msg: ["a s3cr3t-value b"], "s3cr3t-value": 1, n: 2 } }),
      { redact: (t) => t.split("s3cr3t-value").join("***") },
    );
    cleanups.push(() => server.close());
    const client = await ControlClient.connect(path);
    cleanups.push(() => client.close());
    expect(await client.request("status")).toEqual({ msg: ["a *** b"], "***": 1, n: 2 });
  });

  test("a runner's secrets never come back over the socket", async () => {
    const src = `pipo: 1
name: sec
secrets: { tok: "env:PIPO_TEST_UNUSED" }
input:
  via: push
  validate: ["data.n >= 0"]
  on_invalid: { message: "bad packet \${data.tag}" }
output: { from: input, to: stdout }
`;
    const { client } = await boot(src, "sec", setup(), async () => "hunter2-secret");
    const e = (await client
      .request("push", { data: { n: -1, tag: "hunter2-secret" } })
      .catch((x) => x)) as ControlError;
    expect(e.code).toBe("rejected");
    expect(e.message).toBe("bad packet ***");
    const { events } = await client.request("events", { after_seq: 0, limit: 1000 });
    expect(JSON.stringify(events)).not.toContain("hunter2");
  });
});

describe("push", () => {
  test("a pushed packet is journaled before the reply and delivered", async () => {
    const { box, runner, client } = await boot(PUSH("p"), "p");
    const { packet_id, state } = await client.request("push", { data: { n: 7 }, source: "cli" });
    expect(state).toBe("accepted");
    // Journaled before the reply.
    expect(runner.journal.get(packet_id)).toMatchObject({ trigger: "push", source: "cli" });
    expect((await settled(runner, packet_id)).state).toBe("delivered");
    expect(lines(join(box.root, "out.jsonl"))).toEqual([{ packet_id, data: { n: 7 } }]);
  });

  test("an invalid packet is journaled as rejected and the error carries its id", async () => {
    const { runner, client } = await boot(PUSH("rej"), "rej");
    const e = (await client.request("push", { data: { n: -1 } }).catch((x) => x)) as ControlError;
    expect(e.code).toBe("rejected");
    expect(e.message).toContain("data.n >= 0");
    expect(e.hint).toContain("fix the data");
    expect(runner.journal.get(e.packetId as string)?.state).toBe("rejected");

    const missing = (await client.request("push", {}).catch((x) => x)) as ControlError;
    expect(missing).toMatchObject({ code: "bad_request", message: "push needs `data`" });
    const badSource = (await client.request("push", { data: 1, source: 5 }).catch((x) => x)) as ControlError;
    expect(badSource.code).toBe("bad_request");
  });

  test("buffer.max refuses with a hint; nothing is journaled", async () => {
    const { runner, client } = await boot(PUSH("buf", "buffer: { max: 1 }\n"), "buf");
    await client.request("pause");
    await client.request("push", { data: { n: 1 } });
    const e = (await client.request("push", { data: { n: 2 } }).catch((x) => x)) as ControlError;
    expect(e.code).toBe("unavailable");
    expect(e.message).toContain("buffer full");
    expect(e.hint).toContain("buffer.max");
    expect(runner.journal.counts()).toEqual({ accepted: 1 });
  });

  test("lifetime.max_packets refuses later pushes with a hint", async () => {
    const box = setup();
    box.write("fns.ts", "export const slow = async (d) => { await Bun.sleep(500); return d; };");
    const src = PUSH("life", "fn: ./fns.ts\nlifetime: { max_packets: 1, on_end: drain }\n").replace(
      "output: { from: input,",
      "nodes:\n  s: { from: input, transform: fn.slow }\noutput: { from: s,",
    );
    const { runner, client } = await boot(src, "life", box);
    // The slow packet keeps the drain going while the second push arrives.
    await client.request("push", { data: { n: 1 } });
    const e = (await client.request("push", { data: { n: 2 } }).catch((x) => x)) as ControlError;
    expect(e.code).toBe("unavailable");
    expect(e.message).toContain("max_packets");
    expect(e.hint).toContain("lifetime");
    await runner.finished;
  });

  test("push works for any input: an http pipeline takes pushed packets too", async () => {
    const src = `pipo: 1
name: hp
input: { via: http }
output: { from: input, to: file, with: { path: ./out.jsonl, format: jsonl } }
`;
    const { runner, client } = await boot(src, "hp", setup(), undefined, 0);
    const { packet_id } = await client.request("push", { data: { via: "push" } });
    expect((await settled(runner, packet_id)).trigger).toBe("push");
  });
});

describe("pause, resume, drain, stop", () => {
  test("pause and resume, with reasons and invalid states", async () => {
    const { runner, client } = await boot(PUSH("pr"), "pr");
    expect(await client.request("resume")).toEqual({ state: "active", already: true });
    const bad = (await client.request("pause", { reason: "lunch" }).catch((x) => x)) as ControlError;
    expect(bad.code).toBe("bad_request");
    expect(bad.message).toContain("manual, agent");
    expect(await client.request("pause", { reason: "agent" })).toEqual({ state: "paused", already: false });
    expect((await client.request("status")).paused_reason).toBe("agent");
    expect(await client.request("pause")).toEqual({ state: "paused", already: true });
    // Paused still journals pushes; they wait.
    const { packet_id } = await client.request("push", { data: { n: 1 } });
    await Bun.sleep(100);
    expect(runner.journal.get(packet_id)?.state).toBe("accepted");
    expect(await client.request("resume")).toEqual({ state: "active", already: false });
    expect((await settled(runner, packet_id)).state).toBe("delivered");
    expect((await client.request("status")).paused_reason).toBeNull();
    const events = runner.journal.eventsAfter(0, 1000).map((e) => e.type);
    expect(events).toContain("pipeline.paused");
    expect(events).toContain("pipeline.resumed");
  });

  test("drain replies, refuses pushes, then stops and removes the socket and registry entry", async () => {
    const { box, runner, client } = await boot(PUSH("dr"), "dr");
    const socket = runner.socket;
    expect(await client.request("drain")).toEqual({ state: "draining", already: false });
    await runner.finished;
    expect(runner.state).toBe("stopped");
    expect(existsSync(socket)).toBe(false);
    expect(readRegistryEntry(box.home, "dr")).toBeNull();
    await expect(ControlClient.forPipeline(box.home, "dr")).rejects.toThrow("no runner registered");
  });

  test("stop replies, then stops at once", async () => {
    const { runner, client } = await boot(PUSH("so"), "so");
    expect(await client.request("stop")).toEqual({ state: "stopping" });
    expect(await runner.finished).toBe(0);
    expect(existsSync(runner.socket)).toBe(false);
    await expect(client.request("hello")).rejects.toThrow();
  });
});

describe("events", () => {
  test("pages through journal events by seq", async () => {
    const { runner, client } = await boot(PUSH("ev"), "ev");
    for (let n = 0; n < 3; n++) await settled(runner, (await client.request("push", { data: { n } })).packet_id);
    const first = await client.request("events", { after_seq: 0, limit: 2 });
    expect(first.events).toHaveLength(2);
    expect(first.more).toBe(true);
    expect(first.events[0]).toMatchObject({ seq: 1, type: "pipeline.started" });
    const rest = await client.request("events", { after_seq: first.last_seq, limit: 1000 });
    expect(rest.more).toBe(false);
    expect(rest.events[0].seq).toBe(first.last_seq + 1);
    expect(rest.events.filter((e: any) => e.type === "packet.delivered")).toHaveLength(3);
    const none = await client.request("events", { after_seq: rest.last_seq });
    expect(none).toEqual({ events: [], last_seq: rest.last_seq, more: false });

    for (const args of [{ after_seq: -1 }, { after_seq: 1.5 }, { limit: 0 }, { limit: 5000 }, { after_seq: "x" }]) {
      expect(((await client.request("events", args).catch((x) => x)) as ControlError).code).toBe("bad_request");
    }
  });
});

describe("external delivery check", () => {
  const fns = (box: ReturnType<typeof sandbox>) =>
    box.write("fns.ts", "export const slow = async (d) => { await Bun.sleep(400); return d; };");

  test("an ack delivers a written packet; a repeated ack is harmless", async () => {
    const box = setup();
    fns(box);
    const { runner, client } = await boot(EXTERNAL("ext", "{ check: external, within: 30s }"), "ext", box);
    const { packet_id } = await client.request("push", { data: { n: 1 } });
    await waitFor(() => runner.awaitingAck === 1, 5000, "packet to await its ack");
    const row = runner.journal.get(packet_id);
    expect(row).toMatchObject({ state: "verifying", cursor: "$verify" });
    expect(lines(join(box.root, "out.jsonl"))).toHaveLength(1);
    expect((await client.request("status")).awaiting_ack).toBe(1);

    expect(await client.request("ack", { packet_id, by: "test" })).toEqual({
      packet_id,
      state: "verifying",
      acked: true,
      already: false,
    });
    expect((await settled(runner, packet_id, 2000)).state).toBe("delivered");
    expect(runner.awaitingAck).toBe(0);
    expect(await client.request("ack", { packet_id })).toMatchObject({ state: "delivered", already: true });
    const types = runner.journal.events(packet_id).map((e) => e.type);
    expect(types.filter((t) => t === "packet.acked")).toHaveLength(1);
    expect(types).toContain("delivery.awaiting_ack");
  });

  test("no ack within `within` applies on_fail", async () => {
    const box = setup();
    fns(box);
    const delivered =
      '{ check: external, within: 300ms, on_fail: { then: dead_letter, message: "no ack for ${meta.packet_id}" } }';
    const { runner, client } = await boot(EXTERNAL("late", delivered), "late", box);
    const t0 = Date.now();
    const { packet_id } = await client.request("push", { data: { n: 1 } });
    const row = await settled(runner, packet_id, 5000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
    expect(row.state).toBe("dead_lettered");
    expect(row.error).toMatchObject({ code: "delivery.unverified", message: `no ack for ${packet_id}` });
    const e = (await client.request("ack", { packet_id }).catch((x) => x)) as ControlError;
    expect(e.code).toBe("invalid_state");
    expect(e.message).toContain("dead_lettered");
    expect(e.hint).toContain("dead-letter queue");
  });

  test("waiting for acks does not hold workers: other packets keep flowing", async () => {
    const box = setup();
    fns(box);
    const { runner, client } = await boot(
      EXTERNAL("flow", "{ check: external, within: 30s }").replace(
        "input: { via: push }",
        "concurrency: 1\ninput: { via: push }",
      ),
      "flow",
      box,
    );
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) ids.push((await client.request("push", { data: { n } })).packet_id);
    await waitFor(() => runner.awaitingAck === 5, 5000, "all five parked with one worker");
    for (const id of ids) await client.request("ack", { packet_id: id });
    for (const id of ids) expect((await settled(runner, id, 2000)).state).toBe("delivered");
  });

  test("an ack that arrives before the packet reaches the output is kept", async () => {
    const box = setup();
    fns(box);
    const { runner, client } = await boot(
      EXTERNAL("early", "{ check: external, within: 30s }", "nodes:\n  s: { from: input, transform: fn.slow }", "s"),
      "early",
      box,
    );
    const { packet_id } = await client.request("push", { data: { n: 1 } });
    const res = await client.request("ack", { packet_id });
    expect(["accepted", "processing"]).toContain(res.state);
    const t0 = Date.now();
    expect((await settled(runner, packet_id, 5000)).state).toBe("delivered");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test("on_fail pause holds the packet; resume opens a new window and an ack then delivers", async () => {
    const box = setup();
    fns(box);
    const { runner, client } = await boot(
      EXTERNAL("hold", "{ check: external, within: 200ms, on_fail: { then: pause } }"),
      "hold",
      box,
    );
    const { packet_id } = await client.request("push", { data: { n: 1 } });
    await waitFor(() => runner.state === "paused", 5000, "pause after the missed ack");
    expect((await client.request("status")).paused_reason).toBe("error at $verify");
    await client.request("ack", { packet_id });
    expect(runner.journal.get(packet_id)?.state).toBe("verifying");
    await client.request("resume");
    expect((await settled(runner, packet_id, 2000)).state).toBe("delivered");
  });

  test("a clean restart keeps the remaining deadline", async () => {
    const box = setup();
    fns(box);
    const src = EXTERNAL("keep", "{ check: external, within: 1500ms }");
    const first = await boot(src, "keep", box);
    const { packet_id } = await first.client.request("push", { data: { n: 1 } });
    await waitFor(() => first.runner.awaitingAck === 1, 5000, "packet to await its ack");
    const deadline = (
      first.runner.journal.latestEvent(packet_id, ["delivery.awaiting_ack"])?.detail as { deadline: number }
    )?.deadline;
    first.client.close();
    await first.runner.stop();

    const second = await boot(src, "keep", box);
    const row = await settled(second.runner, packet_id, 5000);
    expect(row.state).toBe("dead_lettered");
    // It failed at the original deadline, not a fresh `within` after the restart.
    expect(Math.abs(row.updated_at - deadline)).toBeLessThan(500);
    const marks = second.runner.journal.events(packet_id).filter((e) => e.type === "delivery.awaiting_ack");
    expect(marks).toHaveLength(1);
  });

  test("ack errors: unknown packet, missing id, pipeline without external, fanned-out packet", async () => {
    const box = setup();
    fns(box);
    const fan = await boot(
      EXTERNAL(
        "fan",
        "{ check: external, within: 30s }",
        "nodes:\n  a: { from: input, tap: log }\n  b: { from: input, tap: log }",
        "[a, b]",
      ),
      "fan",
      box,
    );
    const nf = (await fan.client.request("ack", { packet_id: "nope" }).catch((x) => x)) as ControlError;
    expect(nf.code).toBe("not_found");
    expect(nf.hint).toContain("<packet_id>:<branch>");
    const missing = (await fan.client.request("ack", {}).catch((x) => x)) as ControlError;
    expect(missing.code).toBe("bad_request");

    const { packet_id } = await fan.client.request("push", { data: { n: 1 } });
    await waitFor(() => fan.runner.awaitingAck === 2, 5000, "both copies to await their ack");
    const root = (await fan.client.request("ack", { packet_id }).catch((x) => x)) as ControlError;
    expect(root.code).toBe("invalid_state");
    expect(root.hint).toContain(`${packet_id}:a`);
    expect(root.hint).toContain(`${packet_id}:b`);
    await fan.client.request("ack", { packet_id: `${packet_id}:a` });
    await fan.client.request("ack", { packet_id: `${packet_id}:b` });
    expect((await settled(fan.runner, packet_id, 3000)).state).toBe("delivered");

    const plain = await boot(PUSH("plain"), "plain");
    const p = await plain.client.request("push", { data: { n: 1 } });
    const notExt = (await plain.client.request("ack", { packet_id: p.packet_id }).catch((x) => x)) as ControlError;
    expect(notExt.code).toBe("invalid_state");
    expect(notExt.message).toContain("delivered.check is 'ack'");
  });

  test("drain waits for packets awaiting an ack", async () => {
    const box = setup();
    fns(box);
    const { runner, client } = await boot(EXTERNAL("dw", "{ check: external, within: 30s }"), "dw", box);
    const { packet_id } = await client.request("push", { data: { n: 1 } });
    await waitFor(() => runner.awaitingAck === 1, 5000, "packet to await its ack");
    await client.request("drain");
    await Bun.sleep(200);
    expect(runner.state).toBe("draining");
    await client.request("ack", { packet_id });
    await runner.finished;
    expect(runner.journal === undefined || runner.state === "stopped").toBe(true);
    const entry = lines(join(box.root, "out.jsonl"));
    expect(entry).toHaveLength(1);
  });
});

describe("socket lifecycle", () => {
  test("a stale socket left by a dead runner is removed", async () => {
    const box = setup();
    const path = socketPath(box.home, "stale");
    mkdirSync(join(box.home, "run"), { recursive: true });
    // A process killed while listening leaves its socket file behind, as a killed runner does.
    const owner = Bun.spawn(
      [process.execPath, "-e", `require("node:net").createServer().listen(${JSON.stringify(path)})`],
      { stdout: "ignore", stderr: "ignore" },
    );
    await waitFor(() => existsSync(path), 5000, "socket file");
    owner.kill("SIGKILL");
    await owner.exited;
    expect(existsSync(path)).toBe(true);
    const { lines: log, client } = await boot(PUSH("stale"), "stale", box);
    expect(log.some((l) => l.includes("removed stale control socket"))).toBe(true);
    expect((await client.request("hello")).pipeline).toBe("stale");
  });

  test("a live owner of the socket makes the runner refuse to start", async () => {
    const box = setup();
    const path = socketPath(box.home, "owned");
    const other = await ControlServer.listen(path, () => ({ result: null }));
    cleanups.push(() => other.close());
    const file = box.write("owned.pipo", PUSH("owned"));
    const err = (await Runner.open({ file, home: box.home, log: () => {} }).catch((e) => e)) as StartError;
    expect(err).toBeInstanceOf(StartError);
    expect(err.message).toContain("another runner is listening");
    expect(err.message).toContain("pipo stop");
    // The owner keeps its socket.
    const c = await ControlClient.connect(path);
    expect(await c.request("hello")).toBeNull();
    c.close();
  });

  test("something that is not a socket at the path is refused, not deleted", async () => {
    const box = setup();
    const path = socketPath(box.home, "file");
    mkdirSync(join(box.home, "run"), { recursive: true });
    writeFileSync(path, "mine");
    const file = box.write("file.pipo", PUSH("file"));
    const err = (await Runner.open({ file, home: box.home, log: () => {} }).catch((e) => e)) as StartError;
    expect(err.message).toContain("is not a socket");
    expect(readFileSync(path, "utf8")).toBe("mine");
  });

  test("a socket path over the unix limit is refused before anything is created", async () => {
    const box = setup();
    const home = join(box.root, "h".repeat(120));
    const file = box.write("long.pipo", PUSH("long"));
    const err = (await Runner.open({ file, home, log: () => {} }).catch((e) => e)) as StartError;
    expect(err).toBeInstanceOf(StartError);
    expect(err.message).toMatch(/over the \d+-byte limit for unix sockets/);
    expect(err.message).toContain("PIPO_HOME");
    expect(existsSync(join(home, "pipelines"))).toBe(false);
  });

  test("a socket on a Windows drive under WSL is refused with a hint", async () => {
    if (process.platform !== "linux") return;
    const box = setup();
    const file = box.write("win.pipo", PUSH("win"));
    const err = (await Runner.open({ file, home: "/mnt/c/pipo-test-never-created", log: () => {} }).catch(
      (e) => e,
    )) as StartError;
    expect(err.message).toContain("Windows drive");
    expect(err.message).toContain("~/.pipo");
  });

  test("an input that fails to start leaves no socket behind", async () => {
    const box = setup();
    const busy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    cleanups.push(() => busy.stop(true));
    const file = box.write(
      "busy.pipo",
      "pipo: 1\nname: busy\ninput: { via: http }\noutput: { from: input, to: stdout }\n",
    );
    const runner = await Runner.open({ file, home: box.home, listen: busy.port, log: () => {} });
    cleanups.push(() => runner.journal.close());
    expect(existsSync(runner.socket)).toBe(true);
    await expect(runner.start()).rejects.toThrow();
    expect(existsSync(runner.socket)).toBe(false);
    expect(readRegistryEntry(box.home, "busy")).toBeNull();
  });

  test("a client's pending requests fail when the runner goes away", async () => {
    const box = setup();
    const path = join(box.home, "slow.sock");
    const server = await ControlServer.listen(path, async () => {
      await Bun.sleep(5000);
      return { result: null };
    });
    const client = await ControlClient.connect(path);
    const pending = client.request("status").catch((e) => e as Error);
    await Bun.sleep(50);
    await server.close();
    expect(String(await pending)).toContain("closed");
    expect(existsSync(path)).toBe(false);
    await expect(ControlClient.connect(path)).rejects.toThrow("cannot connect");
  });
});
