// Reruns over the control socket (docs/spec.md D79), against the Rust runner: settled packets go back in flight at
// a node they passed, with the data they had there, and run from it to the output again; the steps before it don't.
// The plan (`dry`), selection by ids, `last` and `since`, pinned and `current` versions, fan-out copies, and errors.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import type { ControlError } from "../src";
import { sandbox, waitFor } from "./helpers";
import { RustRunner } from "./rust";

setDefaultTimeout(60_000);

let cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function boot(src: string, name: string) {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  box.write("fns.ts", `export const tag = (d) => ({ ...d, tag: "v1" });\n`);
  const file = box.write(`${name}.pipo`, src);
  const r = await RustRunner.start(box, file, name, { listen: null });
  cleanups.push(() => (r.proc.exitCode === null ? r.kill() : undefined));
  return { box, r };
}

const error = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ControlError;
  }
  throw new Error("expected the request to fail");
};

const STAMP = (tag = "${data.tag}") => `pipo: 1
name: stamped
fn: ./fns.ts
input: { via: push }
nodes:
  enrich: { from: input, transform: fn.tag }
  keep: { from: enrich, filter: "data.n != 0" }
  stamp: { from: keep, transform: map, with: { data: { n: "\${data.n}", tag: "${tag}", at: "\${now()}" } } }
output:
  from: stamp
  to: sqlite
  with:
    path: ./out.db
    table: rows
    create: true
    mode: upsert
    key: n
    columns: { n: "\${data.n}", tag: "\${data.tag}", at: "\${data.at}" }
`;

const rows = (root: string) => {
  const db = new Database(join(root, "out.db"), { readonly: true });
  try {
    return db.query("SELECT n, tag, at FROM rows ORDER BY n").all() as { n: number; tag: string; at: number }[];
  } finally {
    db.close();
  }
};

const done = (r: RustRunner, id: string, node: string) =>
  r.events(id).filter((e) => e.type === "node.done" && e.node === node).length;

describe("rerun", () => {
  test("reruns a node and everything after it with the data it had there; the steps before it don't run", async () => {
    const { box, r } = await boot(STAMP(), "stamped");
    const ids: string[] = [];
    for (const n of [1, 2, 0]) {
      const { packet_id } = await r.push({ n });
      ids.push(packet_id);
      await r.settled(packet_id);
    }
    const [one, two, zero] = ids as [string, string, string];
    const before = rows(box.root);
    expect(before.map((x) => [x.n, x.tag])).toEqual([
      [1, "v1"],
      [2, "v1"],
    ]);

    // The plan commits nothing.
    const plan = await r.request("rerun", { from: "stamp", ids: [one], dry: true });
    expect(plan).toMatchObject({ from: "stamp", dry: true, rerun: 1, skipped: [], skipped_count: 0 });
    expect(plan.packets).toEqual([{ packet_id: one, version: 1, units: [one] }]);
    expect(plan.path).toEqual([
      { step: "stamp", kind: "transform: map", effect: null },
      { step: "output", kind: "output: sqlite", effect: "write" },
    ]);
    expect(r.events(one).some((e) => e.type === "packet.rerun")).toBe(false);

    await Bun.sleep(5);
    const res = await r.request("rerun", { from: "stamp", ids: [one], by: "test" });
    expect(res.rerun).toBe(1);
    expect((await r.settled(one)).state).toBe("delivered");
    const after = rows(box.root);
    expect(after.map((x) => [x.n, x.tag])).toEqual(before.map((x) => [x.n, x.tag]));
    expect(after[0]!.at).toBeGreaterThan(before[0]!.at);
    expect(after[1]!.at).toBe(before[1]!.at);
    expect([done(r, one, "enrich"), done(r, one, "stamp")]).toEqual([1, 2]);
    const rerun = r.events(one).find((e) => e.type === "packet.rerun");
    expect(rerun).toMatchObject({ node: "stamp", detail: { by: "test", from: "stamp", version: 1, was: "delivered" } });

    // A packet the filter dropped never reached `stamp`: ids are all or nothing.
    const e = await error(r.request("rerun", { from: "stamp", ids: [two, zero] }));
    expect(e.code).toBe("invalid_state");
    expect(e.message).toBe(`packet ${zero} can't rerun from 'stamp': it never reached 'stamp'`);
    expect(r.events(two).some((x) => x.type === "packet.rerun")).toBe(false);
    // From the filter itself it does rerun, and is filtered again.
    expect((await r.request("rerun", { from: "keep", ids: [zero] })).rerun).toBe(1);
    expect((await r.settled(zero)).state).toBe("filtered");

    // `last` takes the newest packets that can rerun and lists the others it passed over.
    const last = await r.request("rerun", { from: "stamp", last: 2, dry: true });
    expect(last.packets.map((p: { packet_id: string }) => p.packet_id)).toEqual([two, one]);
    expect(last.skipped).toEqual([{ packet_id: zero, reason: "it never reached 'stamp'" }]);
    const since = await r.request("rerun", { from: "stamp", since: "1h" });
    expect([since.rerun, since.skipped_count]).toEqual([2, 1]);
    for (const id of [one, two]) expect((await r.settled(id)).state).toBe("delivered");
    expect((await r.request("rerun", { from: "stamp", since: "1h", last: 1, dry: true })).rerun).toBe(1);
  });

  test("runs on the pinned version unless `current` re-pins it to the version in force", async () => {
    const { box, r } = await boot(STAMP(), "stamped");
    const { packet_id } = await r.push({ n: 1 });
    await r.settled(packet_id);
    expect((await r.request("apply", { source: STAMP("${data.tag}-again"), reason: "v2" })).version).toBe(2);

    await r.request("rerun", { from: "stamp", ids: [packet_id] });
    expect((await r.settled(packet_id)).version).toBe(1);
    expect(rows(box.root)[0]!.tag).toBe("v1");

    await r.request("rerun", { from: "stamp", ids: [packet_id], current: true });
    expect((await r.settled(packet_id)).version).toBe(2);
    expect(rows(box.root)[0]!.tag).toBe("v1-again");
    const ev = r.events(packet_id).filter((e) => e.type === "packet.rerun");
    expect(ev.map((e) => e.detail)).toEqual([
      { by: "control", from: "stamp", version: 1, was: "delivered" },
      { by: "control", from: "stamp", version: 2, was: "delivered", from_version: 1 },
    ]);

    // From the output, it only writes (and checks) again.
    expect((await r.request("rerun", { from: "output", ids: [packet_id] })).rerun).toBe(1);
    expect((await r.settled(packet_id)).state).toBe("delivered");
    expect(done(r, packet_id, "stamp")).toBe(3);

    const e = await error(r.request("rerun", { from: "nope", ids: [packet_id], current: true }));
    expect([e.code, e.message, e.hint]).toEqual([
      "bad_request",
      "v2 of stamped has no node 'nope'",
      "rerun from one of: enrich, keep, stamp, output",
    ]);
  });

  test("reruns the fan-out copies that passed the node, and their packet settles again", async () => {
    const { r } = await boot(
      `pipo: 1
name: forked
input: { via: push }
nodes:
  a: { from: input, transform: map, with: { data: { n: "\${data.n}" } } }
  left: { from: a, transform: map, with: { data: { n: "\${data.n}", side: left } } }
  right: { from: a, transform: map, with: { data: { n: "\${data.n}", side: right } } }
output: { from: [left, right], to: file, with: { path: ./out.jsonl, format: jsonl } }
`,
      "forked",
    );
    const { packet_id } = await r.push({ n: 1 });
    expect((await r.settled(packet_id)).state).toBe("delivered");
    await waitFor(() => r.packet(`${packet_id}:right`)?.state === "delivered");

    const e = await error(r.request("rerun", { from: "a", ids: [packet_id] }));
    expect(e.message).toBe(
      `packet ${packet_id} can't rerun from 'a': it fans out at or after 'a', so its copies would be made again; rerun from a node inside a branch`,
    );
    const copy = await error(r.request("rerun", { from: "left", ids: [`${packet_id}:left`] }));
    expect([copy.code, copy.hint]).toEqual([
      "invalid_state",
      `rerun ${packet_id} instead: it reruns the copies that passed 'left'`,
    ]);

    const res = await r.request("rerun", { from: "left", ids: [packet_id] });
    expect(res.packets).toEqual([{ packet_id, version: 1, units: [`${packet_id}:left`] }]);
    await waitFor(() => r.events(packet_id).filter((x) => x.type === "packet.delivered").length === 2);
    expect(r.packet(packet_id)!.state).toBe("delivered");
    expect([done(r, `${packet_id}:left`, "left"), done(r, `${packet_id}:right`, "right")]).toEqual([2, 1]);
  });

  test("bad requests, and a paused pipeline holds the units until it resumes", async () => {
    const { r } = await boot(STAMP(), "stamped");
    const { packet_id } = await r.push({ n: 1 });
    await r.settled(packet_id);
    const bad = async (args: Record<string, unknown>) => (await error(r.request("rerun", args))).message;
    expect(await bad({ ids: [packet_id] })).toBe("rerun needs `from`: the node to run again from (or `output`)");
    expect(await bad({ from: "stamp" })).toBe("rerun needs `ids`, `last`, `since` or `all: true`");
    expect(await bad({ from: "stamp", ids: [packet_id], all: true })).toBe(
      "rerun takes `ids`, or `last`/`since`/`all`, not both",
    );
    expect(await bad({ from: "stamp", since: "soon" })).toBe(
      "invalid duration 'soon' (expected e.g. 500ms, 2s, 5m, 1h, 7d)",
    );
    expect((await error(r.request("rerun", { from: "stamp", ids: ["nope"] }))).code).toBe("not_found");

    await r.request("pause");
    expect((await r.request("rerun", { from: "stamp", all: true })).rerun).toBe(1);
    await Bun.sleep(300);
    expect(r.packet(packet_id)!.state).toBe("processing");
    await r.request("resume");
    expect((await r.settled(packet_id)).state).toBe("delivered");
  });
});
