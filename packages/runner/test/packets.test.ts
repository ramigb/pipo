// Packet reads and the dead-letter queue over the control socket (docs/spec.md §6, §8, D33, D34), against the Rust
// runner: the `packets` page with state filter and paging, a packet's trace (data after each node, timings, retries,
// errors), the `dlq` list, `replay` back at the failed node on the packet's pinned version (fan-out copies too),
// `purge`, their errors, redaction, and reads from a journal with no runner (`pipo-runner read`). Kill-and-restart
// lives in dlq-recovery.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ControlError } from "../src";
import { offlineRead } from "./control-helpers";
import { sandbox, waitFor } from "./helpers";
import { RustRunner, type StartOptions } from "./rust";

// A runner start compiles through Bun, which can hang once in a while under WSL and is then retried (compile.rs).
setDefaultTimeout(60_000);

let cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function setup() {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  box.write(
    "fns.ts",
    `export const tag = (d) => ({ ...d, tag: "v1" });
export const tag2 = (d) => ({ ...d, tag: "v2" });
`,
  );
  return box;
}

async function boot(src: string, name: string, box = setup(), o: StartOptions = {}) {
  const file = box.write(`${name}.pipo`, src);
  const r = await RustRunner.start(box, file, name, { listen: null, ...o });
  cleanups.push(() => (r.proc.exitCode === null ? r.kill() : undefined));
  return { box, file, r, client: r.client };
}

// `flaky` is an exec tap that fails while fail.flag exists next to the pipeline, so a test decides when a step fails.
const FLAKY = `tap: exec, with: { command: sh, args: ["-c", "if [ -f fail.flag ]; then echo flaky is failing >&2; exit 1; fi"] }`;

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
  check: { from: enrich, ${FLAKY}, on_error: { retry: 0, then: dead_letter } }
  note: { from: check, tap: log, with: { message: "seen \${meta.packet_id}" } }
output: { from: note, to: file, with: { path: ./out.jsonl, format: jsonl } }
${extra}`;

describe("packets", () => {
  test("pages newest first with a state filter; bad arguments say what to send", async () => {
    const box = setup();
    const { r, client } = await boot(LINEAR("pg"), "pg", box);
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) ids.push((await client.request("push", { data: { n } })).packet_id);
    for (const id of ids) await r.settled(id);
    failing(box, true);
    const dead = (await client.request("push", { data: { n: 9 } })).packet_id;
    await r.settled(dead);

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
    expect(dl.packets[0].error).toMatchObject({ code: "node.failed", node: "check" });
    expect(dl.packets[0].error.message).toContain("flaky is failing");

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
      "on_error: { retry: 3, delay: 200ms }",
    );
    const { r, client } = await boot(src, "tr", box);
    failing(box, true);
    const { packet_id } = await client.request("push", { data: { name: "Ada" } });
    // Let the first attempt fail, then let the retry pass.
    await waitFor(() => r.events(packet_id).some((e) => e.type === "step.retry"), 5000, "a retry");
    failing(box, false);
    await r.settled(packet_id);

    const t = await client.request("packet", { packet_id });
    expect(t.packet).toMatchObject({ packet_id, state: "delivered", version: 1, trigger: "push", copies: 0 });
    expect(t.packet.data).toEqual({ name: "Ada", tag: "v1" });
    const nodes = t.steps.map((s: any) => s.node);
    expect(nodes).toEqual(["input", "enrich", "check", "note", "$output", "$verify"]);
    const [input, enrich, check, note, output, verify] = t.steps;
    expect(input).toMatchObject({ event: "packet.accepted", state: "accepted", data: { name: "Ada" }, changed: true });
    expect(enrich).toMatchObject({ event: "node.done", changed: true, data: { name: "Ada", tag: "v1" } });
    expect(check.attempts).toBeGreaterThanOrEqual(2);
    expect(check.retries[0]).toMatchObject({ attempt: 1 });
    expect(check.retries[0].error).toContain("flaky is failing");
    expect(check).toMatchObject({ changed: false, data: { name: "Ada", tag: "v1" } });
    expect(note).toMatchObject({ changed: false });
    expect(note.notes.find((n: any) => n.type === "log")?.detail.message).toBe(`seen ${packet_id}`);
    expect(output).toMatchObject({ event: "output.written", state: "verifying" });
    expect(verify).toMatchObject({ event: "packet.delivered", state: "delivered", error: null });
    for (const s of t.steps) {
      expect(s.duration_ms).toBeGreaterThanOrEqual(0);
      expect(s.at).toBeGreaterThanOrEqual(s.started_at);
    }
    expect(check.duration_ms).toBeGreaterThanOrEqual(200); // it waited out the retry delay
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
    const { r, client } = await boot(src, "sec", box, { env: { PIPO_TEST_TOKEN: "s3cr3t-value" } });
    const { packet_id } = await client.request("push", { data: { leaked: "s3cr3t-value" } });
    await r.settled(packet_id);
    const t = await client.request("packet", { packet_id });
    expect(JSON.stringify(t)).not.toContain("s3cr3t-value");
    expect(t.packet.data.leaked).toBe("***");
  });
});

describe("dlq replay", () => {
  test("re-queues at the failed node with its data and pinned version; delivered once; repeats are errors", async () => {
    const box = setup();
    failing(box, true);
    const { r, client, file } = await boot(LINEAR("rp"), "rp", box);
    const { packet_id } = await client.request("push", { data: { n: 1 } });
    const dead = await r.settled(packet_id);
    expect(dead.state).toBe("dead_lettered");
    const list = await client.request("dlq");
    expect(list.packets.map((p: any) => p.packet_id)).toEqual([packet_id]);
    expect(list.packets[0].node).toBe("check");

    // A new version of the file: the replayed packet still finishes on v1 (spec §7.3).
    expect(await r.stop()).toBe(0);
    const second = await boot(readFileSync(file, "utf8").replace("fn.tag }", "fn.tag2 }"), "rp", box);
    expect((await second.client.request("hello")).version).toBe(2);
    failing(box, false);

    const res = await second.client.request("replay", { ids: [packet_id], by: "test" });
    expect(res).toEqual({
      replayed: 1,
      packets: [{ packet_id, units: [{ id: packet_id, node: "check" }] }],
      skipped: [],
    });
    const done = await second.r.settled(packet_id);
    expect(done).toMatchObject({ state: "delivered", version: 1, error: null, attempt: 0 });
    // `enrich` ran once, on v1, before the failure; the replay resumed at `check` with that data.
    expect(out(box)).toEqual([{ n: 1, tag: "v1" }]);

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
    const { r, client } = await boot(LINEAR("all"), "all", box);
    const ids: string[] = [];
    for (let n = 0; n < 3; n++) ids.push((await client.request("push", { data: { n } })).packet_id);
    for (const id of ids) await r.settled(id);
    failing(box, false);

    const mixed = await error(client.request("replay", { ids: [ids[0], "nope"] }));
    expect(mixed.code).toBe("not_found");
    expect(r.packet(ids[0] as string)?.state).toBe("dead_lettered");

    await client.request("pause");
    const res = await client.request("replay", { all: true });
    expect(res.replayed).toBe(3);
    // Committed in flight right away, processed once resumed.
    for (const id of ids) expect(r.packet(id)?.state).toBe("processing");
    expect((await client.request("dlq")).total).toBe(0);
    await client.request("resume");
    for (const id of ids) expect((await r.settled(id)).state).toBe("delivered");
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
  b: { from: input, ${FLAKY}, on_error: { retry: 0 } }
output: { from: [a, b], to: file, with: { path: ./out.jsonl, format: jsonl } }
`;
    failing(box, true);
    const { r, client } = await boot(src, "fan", box);
    const { packet_id } = await client.request("push", { data: { n: 1 } });
    const dead = await r.settled(packet_id);
    expect(dead).toMatchObject({ state: "dead_lettered", error: { code: "branch.dead_lettered" } });
    expect(out(box)).toEqual([{ n: 1, tag: "v1" }]);
    expect((await error(client.request("replay", { ids: [`${packet_id}:b`] }))).hint).toContain(`replay ${packet_id}`);

    failing(box, false);
    const res = await client.request("replay", { ids: [packet_id] });
    expect(res.packets[0].units).toEqual([{ id: `${packet_id}:b`, node: "b" }]);
    await waitFor(() => r.packet(packet_id)?.state === "delivered", 5000, "the packet to settle");
    expect(out(box)).toEqual([{ n: 1, tag: "v1" }, { n: 1 }]);
    const t = await client.request("packet", { packet_id });
    // The packet went back to `branched` with the replay, then settled again when its copy delivered.
    expect(t.steps.slice(-2).map((s: any) => [s.event, s.state])).toEqual([
      ["dlq.replayed", "branched"],
      ["packet.delivered", "delivered"],
    ]);
    expect(t.copies.map((c: any) => c.packet.packet_id)).toEqual([`${packet_id}:a`, `${packet_id}:b`]);
    expect(t.copies[1].steps.map((s: any) => s.event)).toContain("dlq.replayed");
  });

  test("a draining pipeline refuses a replay", async () => {
    const box = setup();
    failing(box, true);
    // A packet awaiting its ack keeps the drain going.
    const { r, client } = await boot(LINEAR("dr", "delivered: { check: external, within: 30s }\n"), "dr", box);
    const { packet_id } = await client.request("push", { data: { n: 1 } });
    await r.settled(packet_id);
    failing(box, false);
    const held = (await client.request("push", { data: { n: 2 } })).packet_id;
    await waitFor(() => r.packet(held)?.state === "verifying", 5000, "a packet awaiting its ack");
    await client.request("drain");
    const e = await error(client.request("replay", { ids: [packet_id] }));
    expect(e.code).toBe("invalid_state");
    expect(e.hint).toContain("pipo start");
    expect(r.packet(packet_id)?.state).toBe("dead_lettered");
    await client.request("ack", { packet_id: held });
    expect(await r.proc.exited).toBe(0);
  });
});

describe("dlq purge", () => {
  test("removes the packet and its events, records dlq.purged, leaves everything else", async () => {
    const box = setup();
    const { r, client } = await boot(LINEAR("pu"), "pu", box);
    const keep = (await client.request("push", { data: { n: 0 } })).packet_id;
    await r.settled(keep);
    failing(box, true);
    const gone = (await client.request("push", { data: { n: 1 } })).packet_id;
    await r.settled(gone);
    const keepEvents = r.events(keep).length;

    expect((await error(client.request("purge", { ids: [keep] }))).code).toBe("invalid_state");
    const res = await client.request("purge", { ids: [gone], by: "test" });
    expect(res).toEqual({ purged: 1, packets: [gone] });
    expect(r.packet(gone)).toBeNull();
    expect(r.events(gone).map((e) => e.type)).toEqual(["dlq.purged"]);
    expect(r.events(keep)).toHaveLength(keepEvents);
    expect(r.packet(keep)?.state).toBe("delivered");

    const t = await client.request("packet", { packet_id: gone });
    expect(t.packet).toBeNull();
    expect(t.purged.detail).toMatchObject({ by: "test", version: 1, error: { node: "check" } });
    expect((await error(client.request("purge", { ids: [gone] }))).code).toBe("not_found");
    expect((await client.request("purge", { all: true })).purged).toBe(0);
    const s = await client.request("status");
    expect(s.stats).toMatchObject({ accepted: 1, delivered: 1, dead_lettered: 0 });
  });
});

describe("offline reads (pipo-runner read)", () => {
  test("a stopped pipeline's journal is read read-only, redacted, payloads withheld when a secret can't be resolved", async () => {
    const box = setup();
    const env = { PIPO_TEST_OFFLINE_TOKEN: "offline-s3cret" };
    const src = `pipo: 1
name: off
secrets: { tok: "env:PIPO_TEST_OFFLINE_TOKEN" }
input: { via: push }
output: { from: input, to: file, with: { path: ./out.jsonl, format: jsonl } }
`;
    const { r, client } = await boot(src, "off", box, { env });
    const { packet_id } = await client.request("push", { data: { v: "offline-s3cret" } });
    await r.settled(packet_id);
    expect(await r.stop()).toBe(0);

    const page = await offlineRead(box, "off", "packets", {}, env);
    expect(page.code).toBe(0);
    expect(page.out.result.packets[0].packet_id).toBe(packet_id);
    const trace = (await offlineRead(box, "off", "packet", { packet_id }, env)).out;
    expect(trace.withheld).toBeNull();
    expect(trace.result.packet.data).toEqual({ v: "***" });
    expect(await offlineRead(box, "none", "packets")).toEqual({ code: 0, out: null });
    const missing = await offlineRead(box, "off", "packet", { packet_id: "nope" }, env);
    expect(missing.code).toBe(1);
    expect(missing.out.error).toMatchObject({ code: "not_found", message: "no packet 'nope' in off" });
    // Without the env var the secret can't be resolved, so payloads are withheld.
    const unresolved = (await offlineRead(box, "off", "packet", { packet_id })).out;
    expect(unresolved.withheld).toContain("tok");

    // A version that declares an op:// secret: it can't be resolved without the runner, so payloads are withheld.
    const db = new Database(join(box.home, "pipelines", "off", "journal.db"));
    const other = src.replace("env:PIPO_TEST_OFFLINE_TOKEN", "op://vault/item/field");
    db.query(
      "INSERT INTO versions (version, hash, source, author, created_at, compiled) VALUES (2, 'other', ?, 'human', 0, ?)",
    ).run(other, JSON.stringify({ diagnostics: [], pipeline: { secrets: { tok: "op://vault/item/field" } } }));
    db.close();
    const withheld = (await offlineRead(box, "off", "packet", { packet_id }, env)).out;
    expect(withheld.withheld).toContain("tok");
    expect(withheld.result.packet.data).toStartWith("[withheld:");
    expect(withheld.result.steps[0].data).toStartWith("[withheld:");
    expect(JSON.stringify(withheld)).not.toContain("offline-s3cret");
  });
});
