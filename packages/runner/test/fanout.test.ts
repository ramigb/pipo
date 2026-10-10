// Fan-out (docs/spec.md §3.4, D22): each consumer gets its own journaled copy with a stable branch
// path; copies write once each under `packet_id:<branch>`; the packet settles when every copy has.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { counts, post, suite } from "./core";
import { rows, waitFor } from "./helpers";
import type { RustRunner } from "./rust";

setDefaultTimeout(30_000);
const { box: b, start: startFile } = suite();

const FNS = `export const boom = () => { throw new Error("boom"); };
export const tag = (d, m) => ({ ...d, via: m.node });`;

function start(name: string, body: string) {
  b.write("fns.ts", FNS);
  return startFile(name, `pipo: 1\nname: ${name}\nfn: ./fns.ts\n${body}`);
}

const SQLITE = `  to: sqlite
  with: { path: ./NAME.db, table: items, create: true }`;
/** Each branch stamps the packet with what its copy sees, so rows show meta per copy. */
const stamp = (from: string) =>
  `{ from: ${from}, transform: map, with: { data: { n: "\${data.n}", pid: "\${meta.packet_id}", branch: "\${meta.branch}" } } }`;

type Copy = {
  id: string;
  branch: string;
  state: string;
  cursor: string | null;
  root: string;
  parent: string;
  version: number;
};
const copies = (r: RustRunner, id: string) =>
  r.query<Copy>("SELECT id, branch, state, cursor, root, parent, version FROM packets WHERE root = ? ORDER BY id", id);
const units = (r: RustRunner, id: string) =>
  Object.fromEntries(copies(r, id).map((c) => [c.branch, `${c.state}@${c.cursor}`]));
/** The runner's stats, as `status` reports them. */
const stats = async (r: RustRunner) => (await r.status()).stats;

describe("fan-out", () => {
  test("two branches reaching the output write two rows with distinct keys; the packet is delivered once", async () => {
    const NAME = "two";
    const r = await start(
      NAME,
      `input: { via: http }
nodes:
  a: ${stamp("input")}
  b: ${stamp("input")}
output:
  from: [a, b]
${SQLITE.replace("NAME", NAME)}
`,
    );
    const id = await post(r, { n: 1 });
    const root = await r.settled(id);
    expect(root).toMatchObject({ state: "delivered", branch: "", root: null, cursor: null });
    expect(units(r, id)).toEqual({ a: "delivered@null", b: "delivered@null" });
    for (const c of copies(r, id)) expect(c).toMatchObject({ root: id, parent: id, version: root.version });

    const written = rows(join(b.root, `${NAME}.db`), "SELECT packet_id, n, pid, branch FROM items ORDER BY packet_id");
    expect(written).toEqual([
      { packet_id: `${id}:a`, n: 1, pid: id, branch: "a" },
      { packet_id: `${id}:b`, n: 1, pid: id, branch: "b" },
    ]);
    expect(await stats(r)).toMatchObject({
      accepted: 1,
      delivered: 1,
      pending: 0,
      dead_lettered: 0,
    });
    expect(counts(r)).toEqual({ delivered: 1 });
    expect(r.events(id).map((e) => e.type)).toEqual(["packet.accepted", "packet.fanned_out", "packet.delivered"]);
    expect(r.events(`${id}:a`)[0]).toMatchObject({ type: "packet.branched", node: "input" });
  });

  test("one branch filtered: the packet is still delivered", async () => {
    const NAME = "filt";
    const r = await start(
      NAME,
      `input: { via: http }
nodes:
  a: ${stamp("input")}
  keep: { from: input, filter: "data.n > 5" }
output:
  from: [a, keep]
${SQLITE.replace("NAME", NAME)}
`,
    );
    const id = await post(r, { n: 1 });
    expect((await r.settled(id)).state).toBe("delivered");
    expect(units(r, id)).toEqual({ a: "delivered@null", keep: "filtered@null" });
    expect(rows(join(b.root, `${NAME}.db`), "SELECT packet_id FROM items")).toEqual([{ packet_id: `${id}:a` }]);
  });

  test("every branch filtered: the packet is filtered", async () => {
    const NAME = "allfilt";
    const r = await start(
      NAME,
      `input: { via: http }
nodes:
  x: { from: input, filter: "false" }
  y: { from: input, filter: "false" }
output:
  from: [x, y]
${SQLITE.replace("NAME", NAME)}
`,
    );
    const id = await post(r, { n: 1 });
    expect((await r.settled(id)).state).toBe("filtered");
  });

  test("one branch dead-lettered: the packet is dead-lettered once the other copy is done", async () => {
    const NAME = "dead";
    const r = await start(
      NAME,
      `input: { via: http }
errors: { retry: 0 }
nodes:
  ok: ${stamp("input")}
  bad: { from: input, transform: fn.boom }
output:
  from: [ok, bad]
${SQLITE.replace("NAME", NAME)}
`,
    );
    const id = await post(r, { n: 1 });
    const root = await r.settled(id);
    expect(root.state).toBe("dead_lettered");
    expect(root.error).toMatchObject({ code: "branch.dead_lettered", node: "bad" });
    expect(root.error?.message).toContain("branch 'bad' dead-lettered: boom");
    expect(units(r, id)).toEqual({ ok: "delivered@null", bad: "dead_lettered@null" });
    expect(rows(join(b.root, `${NAME}.db`), "SELECT packet_id FROM items")).toEqual([{ packet_id: `${id}:ok` }]);
    expect(await stats(r)).toMatchObject({ accepted: 1, delivered: 0, dead_lettered: 1 });
  });

  test("nested fan-out after a node, fan-in, and a copy going straight to the output", async () => {
    const NAME = "nest";
    const r = await start(
      NAME,
      `input: { via: http }
nodes:
  a: { from: input, transform: fn.tag }
  c: ${stamp("a")}
  d: ${stamp("a")}
  log: { from: [c, d], tap: log }
output:
  from: [input, log]
  to: file
  with: { path: ./${NAME}.jsonl }
`,
    );
    const id = await post(r, { n: 7 });
    expect((await r.settled(id)).state).toBe("delivered");
    expect(units(r, id)).toEqual({
      a: "delivered@null",
      "a/c": "delivered@null",
      "a/d": "delivered@null",
      output: "delivered@null",
    });
    const nested = r.packet(`${id}:a/c`);
    expect(nested).toMatchObject({ parent: `${id}:a`, root: id });
    expect(r.events(`${id}:a`).map((e) => e.type)).toEqual([
      "packet.branched",
      "node.done",
      "packet.fanned_out",
      "packet.delivered",
    ]);
    const written = readFileSync(join(b.root, `${NAME}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .sort((x, y) => x.packet_id.localeCompare(y.packet_id));
    expect(written.map((w) => w.packet_id)).toEqual([`${id}:a/c`, `${id}:a/d`, `${id}:output`]);
    expect(written.map((w) => w.data.branch)).toEqual(["a/c", "a/d", undefined]);
    expect(written.map((w) => w.data.pid)).toEqual([id, id, undefined]);
    // The fan-in tap logged each copy under its own unit.
    expect(r.events(`${id}:a/c`).some((e) => e.type === "log")).toBe(true);
    expect(r.events(`${id}:a/d`).some((e) => e.type === "log")).toBe(true);
  });

  test("a route branch with two consumers fans out; the other branch does not", async () => {
    const NAME = "routed";
    const r = await start(
      NAME,
      `input: { via: http }
nodes:
  r: { from: input, route: { big: "data.n > 5", else: else } }
  x: ${stamp("r.big")}
  y: ${stamp("r.big")}
  z: ${stamp("r.else")}
output:
  from: [x, y, z]
${SQLITE.replace("NAME", NAME)}
`,
    );
    const big = await post(r, { n: 9 });
    const small = await post(r, { n: 1 });
    await r.settled(big);
    await r.settled(small);
    expect(units(r, big)).toEqual({ x: "delivered@null", y: "delivered@null" });
    expect(units(r, small)).toEqual({});
    const keys = rows(join(b.root, `${NAME}.db`), "SELECT packet_id FROM items").map((w) => w.packet_id);
    expect(keys.sort()).toEqual([`${big}:x`, `${big}:y`, small].sort());
  });

  test("a loop inside a branch carries its iteration and re-runs the fan-out on each pass", async () => {
    const NAME = "looped";
    const r = await start(
      NAME,
      `input: { via: http }
nodes:
  p: { from: input, transform: map, with: { data: { n: "\${data.n + 1}" } } }
  a:
    from: p
    filter: "true"
    loop: { back_to: p, until: "data.n >= 3", max: 5 }
  b: { from: p, tap: log }
output:
  from: [a, b]
${SQLITE.replace("NAME", NAME)}
`,
    );
    const id = await post(r, { n: 0 });
    expect((await r.settled(id)).state).toBe("delivered");
    // n: 1 → a loops (iteration 1) → p: 2 → a loops (2) → p: 3 → a passes. Each pass through p fans out again.
    expect(Object.keys(units(r, id)).sort()).toEqual(["a", "a/a", "a/a/a", "a/a/b", "a/b", "b"]);
    expect(r.packet(`${id}:a/a/a`)?.iteration).toBe(2);
    const written = rows(join(b.root, `${NAME}.db`), "SELECT packet_id, n FROM items ORDER BY packet_id");
    expect(written).toEqual([
      { packet_id: `${id}:a/a/a`, n: 3 },
      { packet_id: `${id}:a/a/b`, n: 3 },
      { packet_id: `${id}:a/b`, n: 2 },
      { packet_id: `${id}:b`, n: 1 },
    ]);
  });

  test("copies are separate batch items", async () => {
    const NAME = "batched";
    const r = await start(
      NAME,
      `input: { via: http }
nodes:
  a: ${stamp("input")}
  b: ${stamp("input")}
output:
  from: [a, b]
  batch: { size: 2, within: 10s }
  to: file
  with: { path: ./${NAME}.jsonl }
`,
    );
    const id = await post(r, { n: 1 });
    expect((await r.settled(id)).state).toBe("delivered");
    const lines = readFileSync(join(b.root, `${NAME}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.packet_id).sort()).toEqual([`${id}:a`, `${id}:b`]);
    const sizes = r
      .events(`${id}:a`)
      .filter((e) => e.type === "output.written")
      .map((e) => (e.detail as { batch: number }).batch);
    expect(sizes).toEqual([2]);
  });

  test("respond: delivered waits for every copy", async () => {
    const NAME = "respond";
    const r = await start(
      NAME,
      `input:
  via: http
  with: { respond: delivered, timeout: 5s }
nodes:
  ok: ${stamp("input")}
  bad: { from: input, transform: fn.boom, on_error: { retry: 0 } }
output:
  from: [ok, bad]
${SQLITE.replace("NAME", NAME)}
`,
    );
    const res = await r.post("", { n: 1 });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ state: "dead_lettered", error: expect.stringContaining("boom") });
  });

  test("taps in a branch use the copy's key (packet_id:<branch>:<node>)", async () => {
    const NAME = "tapkey";
    const r = await start(
      NAME,
      `input: { via: http }
nodes:
  a: { from: input, tap: file, with: { path: ./${NAME}-tap.jsonl } }
  b: { from: input, tap: file, with: { path: ./${NAME}-tap.jsonl } }
  t: { from: [a, b], tap: file, with: { path: ./${NAME}-tap.jsonl } }
output:
  from: t
  to: stdout
`,
    );
    const id = await post(r, { n: 1 });
    await r.settled(id);
    const keys = readFileSync(join(b.root, `${NAME}-tap.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).packet_id)
      .sort();
    expect(keys).toEqual([`${id}:a:a`, `${id}:a:t`, `${id}:b:b`, `${id}:b:t`]);
  });

  test("buffer.max counts packets, not copies", async () => {
    const NAME = "buffered";
    const r = await start(
      NAME,
      `input: { via: http }
buffer: { max: 2 }
nodes:
  a: { from: input, tap: log }
  b: { from: input, tap: log }
output:
  from: [a, b]
  to: stdout
`,
    );
    await r.request("pause");
    await post(r, { n: 1 });
    await post(r, { n: 2 });
    expect((await r.post("", { n: 3 })).status).toBe(503);
    expect((await stats(r)).pending).toBe(2);
    await r.request("resume");
    await waitFor(() => counts(r).delivered === 2, 5000, "both delivered");
  });
});
