// Packet reads and the dead-letter queue over the control socket (docs/spec.md §6, §8, D33, D34), in-process: the
// `packets` page with state filter and paging, a packet's trace (data after each node, timings, retries, errors), the
// `dlq` list, `replay` back at the failed node on the packet's pinned version (fan-out copies too), `purge`, their
// errors, redaction, and reads from a journal with no runner (offlineRead). Kill-and-restart lives in dlq-recovery.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, type ControlError, Journal, offlineRead, Runner } from "../src";
import { sandbox, settled, waitFor } from "./helpers";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function setup() {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  // `flaky` throws while fail.flag exists next to it, so a test decides when a step fails.
  box.write(
    "fns.ts",
    `import { existsSync } from "node:fs";
const flag = new URL("./fail.flag", import.meta.url).pathname;
export const flaky = (d) => { if (existsSync(flag)) throw new Error("flaky is failing"); return { ...d, flaky: true }; };
export const tag = (d) => ({ ...d, tag: "v1" });
export const tag2 = (d) => ({ ...d, tag: "v2" });
`,
  );
  return box;
}

async function boot(src: string, name: string, box = setup(), resolver?: (ref: string) => Promise<string>) {
  const file = box.write(`${name}.pipo`, src);
  const runner = await Runner.open({ file, home: box.home, log: () => {}, resolver });
  await runner.start();
  cleanups.push(() => (runner.state === "stopped" || runner.state === "failed" ? undefined : runner.stop()));
  const client = await ControlClient.forPipeline(box.home, name);
  cleanups.push(() => client.close());
  return { box, file, runner, client };
}

const failing = (box: { root: string }, on: boolean) => {
  const flag = join(box.root, "fail.flag");
  if (on) writeFileSync(flag, "");
  else rmSync(flag, { force: true });
};

const out = (box: { root: string }, file = "out.jsonl") => {
  const path = join(box.root, file);
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l).data)
    : [];
};

const error = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ControlError;
  }
  throw new Error("expected the request to fail");
};

const LINEAR = (name: string, extra = "") => `pipo: 1
name: ${name}
fn: ./fns.ts
input: { via: push }
nodes:
  enrich: { from: input, transform: fn.tag }
  check: { from: enrich, transform: fn.flaky, on_error: { retry: 0, then: dead_letter } }
  note: { from: check, tap: log, with: { message: "seen \${meta.packet_id}" } }
output: { from: note, to: file, with: { path: ./out.jsonl, format: jsonl } }
${extra}`;

describe("packets", () => {
  test("pages newest first with a state filter; bad arguments say what to send", async () => {
    const box = setup();
    const { runner, client } = await boot(LINEAR("pg"), "pg", box);
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) ids.push((await client.request("push", { data: { n } })).packet_id);
    for (const id of ids) await settled(runner, id);
    failing(box, true);
    const dead = (await client.request("push", { data: { n: 9 } })).packet_id;
    await settled(runner, dead);

    const first = await client.request("packets", { limit: 2 });
    expect(first.total).toBe(6);
    expect(first.packets.map((p: any) => p.packet_id)).toEqual([dead, ids[4]]);
    expect(first.next).toBe(ids[4]);
    const second = await client.request("packets", { limit: 2, after: first.next });
    expect(second.packets.map((p: any) => p.packet_id)).toEqual([ids[3], ids[2]]);
    const last = await client.request("packets", { limit: 10, after: ids[1] });
    expect(last.packets.map((p: any) => p.packet_id)).toEqual([ids[0]]);
    expect(last.next).toBeNull();

    const delivered = await client.request("packets", { state: "delivered" });
    expect(delivered.total).toBe(5);
    const dl = await client.request("packets", { state: "dead_lettered" });
    expect(dl.packets).toHaveLength(1);
    expect(dl.packets[0]).toMatchObject({ packet_id: dead, state: "dead_lettered", node: "check", version: 1 });
    expect(dl.packets[0].error).toMatchObject({ code: "node.failed", node: "check", message: "flaky is failing" });

    const bad = await error(client.request("packets", { state: "lost" }));
    expect(bad.code).toBe("bad_request");
    expect(bad.hint).toContain("dead_lettered");
    expect((await error(client.request("packets", { limit: 0 }))).code).toBe("bad_request");
    expect((await error(client.request("packets", { limit: 1001 }))).code).toBe("bad_request");
  });
});

describe("packet trace", () => {
  test("data after each node, timings, retries and logs; unknown ids are not_found", async () => {
    const box = setup();
    const src = LINEAR("tr").replace(
      "on_error: { retry: 0, then: dead_letter }",
      "on_error: { retry: 2, delay: 30ms }",
    );
    const { runner, client } = await boot(src, "tr", box);
    failing(box, true);
    const { packet_id } = await client.request("push", { data: { name: "Ada" } });
    // Let the first attempt fail, then let the retry pass.
    await waitFor(() => runner.journal.events(packet_id).some((e) => e.type === "step.retry"), 5000, "a retry");
    failing(box, false);
    await settled(runner, packet_id);

    const t = await client.request("packet", { packet_id });
    expect(t.packet).toMatchObject({ packet_id, state: "delivered", version: 1, trigger: "push", copies: 0 });
    expect(t.packet.data).toEqual({ name: "Ada", tag: "v1", flaky: true });
    const nodes = t.steps.map((s: any) => s.node);
    expect(nodes).toEqual(["input", "enrich", "check", "note", "$output", "$verify"]);
    const [input, enrich, check, note, output, verify] = t.steps;
    expect(input).toMatchObject({ event: "packet.accepted", state: "accepted", data: { name: "Ada" }, changed: true });
    expect(enrich).toMatchObject({ event: "node.done", changed: true, data: { name: "Ada", tag: "v1" } });
    expect(check.attempts).toBeGreaterThanOrEqual(2);
    expect(check.retries[0]).toMatchObject({ attempt: 1, error: "flaky is failing" });
    expect(check.data).toEqual({ name: "Ada", tag: "v1", flaky: true });
    expect(note).toMatchObject({ changed: false });
    expect(note.notes.find((n: any) => n.type === "log")?.detail.message).toBe(`seen ${packet_id}`);
    expect(output).toMatchObject({ event: "output.written", state: "verifying" });
    expect(verify).toMatchObject({ event: "packet.delivered", state: "delivered", error: null });
    for (const s of t.steps) {
      expect(s.duration_ms).toBeGreaterThanOrEqual(0);
      expect(s.at).toBeGreaterThanOrEqual(s.started_at);
    }
    expect(check.duration_ms).toBeGreaterThanOrEqual(30); // it waited out the retry delay
    expect(t.pending).toBeNull();
    expect(t.events.length).toBeGreaterThan(t.steps.length);
    expect(t.events[0]).not.toHaveProperty("patch");

    const missing = await error(client.request("packet", { packet_id: "nope" }));
    expect(missing.code).toBe("not_found");
    expect(missing.hint).toContain("pipo packets tr");
    expect((await error(client.request("packet", {}))).code).toBe("bad_request");
  });

  test("secrets in packet data are redacted in the trace", async () => {
    const box = setup();
    const src = `pipo: 1
name: sec
secrets: { tok: "env:PIPO_TEST_TOKEN" }
input: { via: push }
output: { from: input, to: file, with: { path: ./out.jsonl, format: jsonl } }
`;
    const { runner, client } = await boot(src, "sec", box, async () => "s3cr3t-value");
    const { packet_id } = await client.request("push", { data: { leaked: "s3cr3t-value" } });
    await settled(runner, packet_id);
    const t = await client.request("packet", { packet_id });
    expect(JSON.stringify(t)).not.toContain("s3cr3t-value");
    expect(t.packet.data.leaked).toBe("***");
  });
});

describe("dlq replay", () => {
  test("re-queues at the failed node with its data and pinned version; delivered once; repeats are errors", async () => {
    const box = setup();
    failing(box, true);
    const { runner, client, file } = await boot(LINEAR("rp"), "rp", box);
    const { packet_id } = await client.request("push", { data: { n: 1 } });
    const dead = await settled(runner, packet_id);
    expect(dead.state).toBe("dead_lettered");
    const list = await client.request("dlq");
    expect(list.packets.map((p: any) => p.packet_id)).toEqual([packet_id]);
    expect(list.packets[0].node).toBe("check");

    // A new version of the file: the replayed packet still finishes on v1 (spec §7.3).
    await runner.stop();
    writeFileSync(file, readFileSync(file, "utf8").replace("fn.tag }", "fn.tag2 }"));
    const second = await boot(readFileSync(file, "utf8"), "rp", box);
    expect(second.runner.version).toBe(2);
    failing(box, false);

    const r = await second.client.request("replay", { ids: [packet_id], by: "test" });
    expect(r).toEqual({
      replayed: 1,
      packets: [{ packet_id, units: [{ id: packet_id, node: "check" }] }],
      skipped: [],
    });
    const done = await settled(second.runner, packet_id);
    expect(done).toMatchObject({ state: "delivered", version: 1, error: null, attempt: 0 });
    // `enrich` ran once, on v1, before the failure; the replay resumed at `check` with that data.
    expect(out(box)).toEqual([{ n: 1, tag: "v1", flaky: true }]);

    const again = await error(second.client.request("replay", { ids: [packet_id] }));
    expect(again.code).toBe("invalid_state");
    expect(again.message).toContain("not in the dead-letter queue");
    expect((await error(second.client.request("replay", { ids: ["nope"] }))).code).toBe("not_found");
    expect((await error(second.client.request("replay", {}))).code).toBe("bad_request");
    expect((await error(second.client.request("replay", { ids: ["x"], all: true }))).code).toBe("bad_request");
    await Bun.sleep(200);
    expect(out(box)).toHaveLength(1);

    const t = await second.client.request("packet", { packet_id });
    const events = t.steps.map((s: any) => `${s.node}:${s.event}`);
    expect(events).toContain("check:packet.dead_lettered");
    expect(events).toContain("check:dlq.replayed");
    const replayed = t.steps.find((s: any) => s.event === "dlq.replayed");
    expect(replayed).toMatchObject({ state: "processing", changed: false, data: { n: 1, tag: "v1" } });
    expect(t.events.find((e: any) => e.type === "dlq.replayed").detail).toMatchObject({
      by: "test",
      error: { code: "node.failed", node: "check" },
    });
  });

  test("a bad id in the list replays nothing; --all is a snapshot and works while paused", async () => {
    const box = setup();
    failing(box, true);
    const { runner, client } = await boot(LINEAR("all"), "all", box);
    const ids: string[] = [];
    for (let n = 0; n < 3; n++) ids.push((await client.request("push", { data: { n } })).packet_id);
    for (const id of ids) await settled(runner, id);
    failing(box, false);

    const mixed = await error(client.request("replay", { ids: [ids[0], "nope"] }));
    expect(mixed.code).toBe("not_found");
    expect(runner.journal.get(ids[0] as string)?.state).toBe("dead_lettered");

    await client.request("pause");
    const r = await client.request("replay", { all: true });
    expect(r.replayed).toBe(3);
    // Committed in flight right away, processed once resumed.
    for (const id of ids) expect(runner.journal.get(id)?.state).toBe("processing");
    expect((await client.request("dlq")).total).toBe(0);
    await client.request("resume");
    for (const id of ids) expect((await settled(runner, id)).state).toBe("delivered");
    expect(out(box)).toHaveLength(3);
    expect((await client.request("replay", { all: true })).replayed).toBe(0);
  });

  test("a fan-out replays only the copy that failed; the packet settles again", async () => {
    const box = setup();
    const src = `pipo: 1
name: fan
fn: ./fns.ts
input: { via: push }
nodes:
  a: { from: input, transform: fn.tag }
  b: { from: input, transform: fn.flaky, on_error: { retry: 0 } }
output: { from: [a, b], to: file, with: { path: ./out.jsonl, format: jsonl } }
`;
    failing(box, true);
    const { runner, client } = await boot(src, "fan", box);
    const { packet_id } = await client.request("push", { data: { n: 1 } });
    const dead = await settled(runner, packet_id);
    expect(dead).toMatchObject({ state: "dead_lettered", error: { code: "branch.dead_lettered" } });
    expect(out(box)).toEqual([{ n: 1, tag: "v1" }]);
    expect((await error(client.request("replay", { ids: [`${packet_id}:b`] }))).hint).toContain(`replay ${packet_id}`);

    failing(box, false);
    const r = await client.request("replay", { ids: [packet_id] });
    expect(r.packets[0].units).toEqual([{ id: `${packet_id}:b`, node: "b" }]);
    await waitFor(() => runner.journal.get(packet_id)?.state === "delivered", 5000, "the packet to settle");
    expect(out(box)).toEqual([
      { n: 1, tag: "v1" },
      { n: 1, flaky: true },
    ]);
    const t = await client.request("packet", { packet_id });
    // The packet went back to `branched` with the replay, then settled again when its copy delivered.
    expect(t.steps.slice(-2).map((s: any) => [s.event, s.state])).toEqual([
      ["dlq.replayed", "branched"],
      ["packet.delivered", "delivered"],
    ]);
    expect(t.copies.map((c: any) => c.packet.packet_id)).toEqual([`${packet_id}:a`, `${packet_id}:b`]);
    expect(t.copies[1].steps.map((s: any) => s.event)).toContain("dlq.replayed");
  });

  test("a draining or stopped pipeline refuses a replay", async () => {
    const box = setup();
    failing(box, true);
    const { runner, client } = await boot(LINEAR("dr"), "dr", box);
    const { packet_id } = await client.request("push", { data: { n: 1 } });
    await settled(runner, packet_id);
    runner.state = "draining"; // as seen by the op while a drain is under way
    const e = await error(client.request("replay", { ids: [packet_id] }));
    runner.state = "active";
    expect(e.code).toBe("invalid_state");
    expect(e.hint).toContain("pipo start");
  });
});

describe("dlq purge", () => {
  test("removes the packet and its events, records dlq.purged, leaves everything else", async () => {
    const box = setup();
    const { runner, client } = await boot(LINEAR("pu"), "pu", box);
    const keep = (await client.request("push", { data: { n: 0 } })).packet_id;
    await settled(runner, keep);
    failing(box, true);
    const gone = (await client.request("push", { data: { n: 1 } })).packet_id;
    await settled(runner, gone);
    const keepEvents = runner.journal.events(keep).length;

    expect((await error(client.request("purge", { ids: [keep] }))).code).toBe("invalid_state");
    const r = await client.request("purge", { ids: [gone], by: "test" });
    expect(r).toEqual({ purged: 1, packets: [gone] });
    expect(runner.journal.get(gone)).toBeNull();
    expect(runner.journal.events(gone).map((e) => e.type)).toEqual(["dlq.purged"]);
    expect(runner.journal.events(keep)).toHaveLength(keepEvents);
    expect(runner.journal.get(keep)?.state).toBe("delivered");

    const t = await client.request("packet", { packet_id: gone });
    expect(t.packet).toBeNull();
    expect(t.purged.detail).toMatchObject({ by: "test", version: 1, error: { node: "check" } });
    expect((await error(client.request("purge", { ids: [gone] }))).code).toBe("not_found");
    expect((await client.request("purge", { all: true })).purged).toBe(0);
    const s = await client.request("status");
    expect(s.stats).toMatchObject({ accepted: 1, delivered: 1, dead_lettered: 0 });
  });
});

describe("offline reads", () => {
  test("a stopped pipeline's journal is read read-only, redacted, payloads withheld when a secret can't be resolved", async () => {
    const box = setup();
    process.env.PIPO_TEST_OFFLINE_TOKEN = "offline-s3cret";
    cleanups.push(() => {
      delete process.env.PIPO_TEST_OFFLINE_TOKEN;
    });
    const src = (secret: string) => `pipo: 1
name: off
secrets: { tok: "${secret}" }
input: { via: push }
output: { from: input, to: file, with: { path: ./out.jsonl, format: jsonl } }
`;
    const { runner, client } = await boot(src("env:PIPO_TEST_OFFLINE_TOKEN"), "off", box);
    const { packet_id } = await client.request("push", { data: { v: "offline-s3cret" } });
    await settled(runner, packet_id);
    await runner.stop();
    const path = join(box.home, "pipelines", "off", "journal.db");

    const page = await offlineRead(path, "packets", {}, "off");
    expect((page as any).result.packets[0].packet_id).toBe(packet_id);
    const trace = (await offlineRead(path, "packet", { packet_id }, "off")) as any;
    expect(trace.withheld).toBeNull();
    expect(trace.result.packet.data).toEqual({ v: "***" });
    expect(await offlineRead(join(box.home, "pipelines", "none", "journal.db"), "packets", {}, "none")).toBeNull();
    await expect(offlineRead(path, "packet", { packet_id: "nope" }, "off")).rejects.toThrow("no packet 'nope'");

    // A version that declares an op:// secret: it can't be resolved without the runner, so payloads are withheld.
    const j = new Journal(path);
    j.version("other", src("op://vault/item/field"));
    j.close();
    const withheld = (await offlineRead(path, "packet", { packet_id }, "off")) as any;
    expect(withheld.withheld).toContain("tok");
    expect(withheld.result.packet.data).toStartWith("[withheld:");
    expect(withheld.result.steps[0].data).toStartWith("[withheld:");
    expect(JSON.stringify(withheld)).not.toContain("offline-s3cret");
  });

  test("journals from before patches gain the column and still trace by event type", () => {
    const box = setup();
    const path = join(box.root, "old.db");
    const db = new Database(path, { create: true });
    db.exec(`CREATE TABLE versions (version INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
               author TEXT NOT NULL DEFAULT 'human', created_at INTEGER NOT NULL);
             CREATE TABLE packets (id TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL, cursor TEXT, data TEXT,
               trigger TEXT NOT NULL, source TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, iteration INTEGER NOT NULL DEFAULT 0,
               hops INTEGER NOT NULL DEFAULT 0, error TEXT, result TEXT, received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, packet_id TEXT, type TEXT NOT NULL,
               node TEXT, detail TEXT);
             INSERT INTO versions VALUES (1, 'h', 'pipo: 1', 'human', 1);
             INSERT INTO packets VALUES ('p1', 1, 'delivered', NULL, '{"a":1}', 'push', 'cli', 0, 0, 2, NULL, NULL, 100, 300);
             INSERT INTO events (at, packet_id, type, node, detail) VALUES (100, 'p1', 'packet.accepted', NULL, NULL),
               (150, 'p1', 'node.done', 'n', NULL), (300, 'p1', 'packet.delivered', '$verify', NULL);`);
    db.close();
    const j = new Journal(path);
    const cols = (j.db.query("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("patch");
    j.close();
    return offlineRead(path, "packet", { packet_id: "p1" }, "old").then((r: any) => {
      expect(r.result.steps.map((s: any) => [s.node, s.state, s.duration_ms])).toEqual([
        ["input", "accepted", 0],
        ["n", null, 50],
        ["$verify", "delivered", 150],
      ]);
      expect(r.result.steps[0]).not.toHaveProperty("data");
    });
  });
});
