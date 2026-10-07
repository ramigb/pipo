// Fan-out (docs/spec.md §3.4, D22): each consumer gets its own journaled copy with a stable branch
// path; copies write once each under `packet_id:<branch>`; the packet settles when every copy has.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load, type Pipeline } from "@pipo/spec";
import { gaps, Journal, type Runner } from "../src";
import { computeStats } from "../src/stats";
import { rows, sandbox, settled, startRunner, waitFor } from "./helpers";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function box() {
  const b = sandbox();
  cleanups.push(() => b.cleanup());
  return b;
}

const FNS = `export const boom = () => { throw new Error("boom"); };
export const tag = (d, m) => ({ ...d, via: m.node });`;

async function start(b: ReturnType<typeof box>, name: string, body: string) {
  b.write("fns.ts", FNS);
  const file = b.write(`${name}.pipo`, `pipo: 1\nname: ${name}\nfn: ./fns.ts\n${body}`);
  const r = await startRunner(file, b.home);
  cleanups.push(() => (r.runner.state === "stopped" || r.runner.state === "failed" ? undefined : r.runner.stop()));
  return r;
}

async function post(r: Awaited<ReturnType<typeof start>>, data: unknown): Promise<string> {
  const res = await r.post("", data);
  expect(res.status).toBe(202);
  return ((await res.json()) as { packet_id: string }).packet_id;
}

const SQLITE = `  to: sqlite
  with: { path: ./out.db, table: items, create: true }`;
/** Each branch stamps the packet with what its copy sees, so rows show meta per copy. */
const stamp = (from: string) =>
  `{ from: ${from}, transform: map, with: { data: { n: "\${data.n}", pid: "\${meta.packet_id}", branch: "\${meta.branch}" } } }`;

const units = (runner: Runner, id: string) =>
  Object.fromEntries(runner.journal.copies(id).map((c) => [c.branch, `${c.state}@${c.cursor}`]));

describe("fan-out", () => {
  test("two branches reaching the output write two rows with distinct keys; the packet is delivered once", async () => {
    const b = box();
    const r = await start(
      b,
      "two",
      `input: { via: http }
nodes:
  a: ${stamp("input")}
  b: ${stamp("input")}
output:
  from: [a, b]
${SQLITE}
`,
    );
    const id = await post(r, { n: 1 });
    const root = await settled(r.runner, id);
    expect(root).toMatchObject({ state: "delivered", branch: "", root: null, cursor: null });
    expect(units(r.runner, id)).toEqual({ a: "delivered@null", b: "delivered@null" });
    for (const c of r.runner.journal.copies(id))
      expect(c).toMatchObject({ root: id, parent: id, version: root.version });

    const written = rows(join(b.root, "out.db"), "SELECT packet_id, n, pid, branch FROM items ORDER BY packet_id");
    expect(written).toEqual([
      { packet_id: `${id}:a`, n: 1, pid: id, branch: "a" },
      { packet_id: `${id}:b`, n: 1, pid: id, branch: "b" },
    ]);
    expect(computeStats(r.runner.journal, Date.now())).toMatchObject({
      accepted: 1,
      delivered: 1,
      pending: 0,
      dead_lettered: 0,
    });
    expect(r.runner.journal.counts()).toEqual({ delivered: 1 });
    expect(r.runner.journal.events(id).map((e) => e.type)).toEqual([
      "packet.accepted",
      "packet.fanned_out",
      "packet.delivered",
    ]);
    expect(r.runner.journal.events(`${id}:a`)[0]).toMatchObject({ type: "packet.branched", node: "input" });
  });

  test("one branch filtered: the packet is still delivered", async () => {
    const b = box();
    const r = await start(
      b,
      "filt",
      `input: { via: http }
nodes:
  a: ${stamp("input")}
  keep: { from: input, filter: "data.n > 5" }
output:
  from: [a, keep]
${SQLITE}
`,
    );
    const id = await post(r, { n: 1 });
    expect((await settled(r.runner, id)).state).toBe("delivered");
    expect(units(r.runner, id)).toEqual({ a: "delivered@null", keep: "filtered@null" });
    expect(rows(join(b.root, "out.db"), "SELECT packet_id FROM items")).toEqual([{ packet_id: `${id}:a` }]);
  });

  test("every branch filtered: the packet is filtered", async () => {
    const b = box();
    const r = await start(
      b,
      "allfilt",
      `input: { via: http }
nodes:
  x: { from: input, filter: "false" }
  y: { from: input, filter: "false" }
output:
  from: [x, y]
${SQLITE}
`,
    );
    const id = await post(r, { n: 1 });
    expect((await settled(r.runner, id)).state).toBe("filtered");
  });

  test("one branch dead-lettered: the packet is dead-lettered once the other copy is done", async () => {
    const b = box();
    const r = await start(
      b,
      "dead",
      `input: { via: http }
errors: { retry: 0 }
nodes:
  ok: ${stamp("input")}
  bad: { from: input, transform: fn.boom }
output:
  from: [ok, bad]
${SQLITE}
`,
    );
    const id = await post(r, { n: 1 });
    const root = await settled(r.runner, id);
    expect(root.state).toBe("dead_lettered");
    expect(root.error).toMatchObject({ code: "branch.dead_lettered", node: "bad" });
    expect(root.error?.message).toContain("branch 'bad' dead-lettered: boom");
    expect(units(r.runner, id)).toEqual({ ok: "delivered@null", bad: "dead_lettered@null" });
    expect(rows(join(b.root, "out.db"), "SELECT packet_id FROM items")).toEqual([{ packet_id: `${id}:ok` }]);
    expect(computeStats(r.runner.journal, Date.now())).toMatchObject({ accepted: 1, delivered: 0, dead_lettered: 1 });
  });

  test("nested fan-out after a node, fan-in, and a copy going straight to the output", async () => {
    const b = box();
    const r = await start(
      b,
      "nest",
      `input: { via: http }
nodes:
  a: { from: input, transform: fn.tag }
  c: ${stamp("a")}
  d: ${stamp("a")}
  log: { from: [c, d], tap: log }
output:
  from: [input, log]
  to: file
  with: { path: ./out.jsonl }
`,
    );
    const id = await post(r, { n: 7 });
    expect((await settled(r.runner, id)).state).toBe("delivered");
    expect(units(r.runner, id)).toEqual({
      a: "delivered@null",
      "a/c": "delivered@null",
      "a/d": "delivered@null",
      output: "delivered@null",
    });
    const nested = r.runner.journal.get(`${id}:a/c`);
    expect(nested).toMatchObject({ parent: `${id}:a`, root: id });
    expect(r.runner.journal.events(`${id}:a`).map((e) => e.type)).toEqual([
      "packet.branched",
      "node.done",
      "packet.fanned_out",
      "packet.delivered",
    ]);
    const written = readFileSync(join(b.root, "out.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .sort((x, y) => x.packet_id.localeCompare(y.packet_id));
    expect(written.map((w) => w.packet_id)).toEqual([`${id}:a/c`, `${id}:a/d`, `${id}:output`]);
    expect(written.map((w) => w.data.branch)).toEqual(["a/c", "a/d", undefined]);
    expect(written.map((w) => w.data.pid)).toEqual([id, id, undefined]);
    // The fan-in tap logged each copy under its own unit.
    expect(r.runner.journal.events(`${id}:a/c`).some((e) => e.type === "log")).toBe(true);
    expect(r.runner.journal.events(`${id}:a/d`).some((e) => e.type === "log")).toBe(true);
  });

  test("a route branch with two consumers fans out; the other branch does not", async () => {
    const b = box();
    const r = await start(
      b,
      "routed",
      `input: { via: http }
nodes:
  r: { from: input, route: { big: "data.n > 5", else: else } }
  x: ${stamp("r.big")}
  y: ${stamp("r.big")}
  z: ${stamp("r.else")}
output:
  from: [x, y, z]
${SQLITE}
`,
    );
    const big = await post(r, { n: 9 });
    const small = await post(r, { n: 1 });
    await settled(r.runner, big);
    await settled(r.runner, small);
    expect(units(r.runner, big)).toEqual({ x: "delivered@null", y: "delivered@null" });
    expect(units(r.runner, small)).toEqual({});
    const keys = rows(join(b.root, "out.db"), "SELECT packet_id FROM items").map((w) => w.packet_id);
    expect(keys.sort()).toEqual([`${big}:x`, `${big}:y`, small].sort());
  });

  test("a loop inside a branch carries its iteration and re-runs the fan-out on each pass", async () => {
    const b = box();
    const r = await start(
      b,
      "looped",
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
${SQLITE}
`,
    );
    const id = await post(r, { n: 0 });
    expect((await settled(r.runner, id)).state).toBe("delivered");
    // n: 1 → a loops (iteration 1) → p: 2 → a loops (2) → p: 3 → a passes. Each pass through p fans out again.
    expect(Object.keys(units(r.runner, id)).sort()).toEqual(["a", "a/a", "a/a/a", "a/a/b", "a/b", "b"]);
    expect(r.runner.journal.get(`${id}:a/a/a`)?.iteration).toBe(2);
    const written = rows(join(b.root, "out.db"), "SELECT packet_id, n FROM items ORDER BY packet_id");
    expect(written).toEqual([
      { packet_id: `${id}:a/a/a`, n: 3 },
      { packet_id: `${id}:a/a/b`, n: 3 },
      { packet_id: `${id}:a/b`, n: 2 },
      { packet_id: `${id}:b`, n: 1 },
    ]);
  });

  test("copies are separate batch items", async () => {
    const b = box();
    const r = await start(
      b,
      "batched",
      `input: { via: http }
nodes:
  a: ${stamp("input")}
  b: ${stamp("input")}
output:
  from: [a, b]
  batch: { size: 2, within: 10s }
  to: file
  with: { path: ./out.jsonl }
`,
    );
    const id = await post(r, { n: 1 });
    expect((await settled(r.runner, id)).state).toBe("delivered");
    const lines = readFileSync(join(b.root, "out.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.packet_id).sort()).toEqual([`${id}:a`, `${id}:b`]);
    const sizes = r.runner.journal
      .events(`${id}:a`)
      .filter((e) => e.type === "output.written")
      .map((e) => (e.detail as { batch: number }).batch);
    expect(sizes).toEqual([2]);
  });

  test("respond: delivered waits for every copy", async () => {
    const b = box();
    const r = await start(
      b,
      "respond",
      `input:
  via: http
  with: { respond: delivered, timeout: 5s }
nodes:
  ok: ${stamp("input")}
  bad: { from: input, transform: fn.boom, on_error: { retry: 0 } }
output:
  from: [ok, bad]
${SQLITE}
`,
    );
    const res = await r.post("", { n: 1 });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ state: "dead_lettered", error: expect.stringContaining("boom") });
  });

  test("taps in a branch use the copy's key (packet_id:<branch>:<node>)", async () => {
    const b = box();
    const r = await start(
      b,
      "tapkey",
      `input: { via: http }
nodes:
  a: { from: input, tap: file, with: { path: ./tap.jsonl } }
  b: { from: input, tap: file, with: { path: ./tap.jsonl } }
  t: { from: [a, b], tap: file, with: { path: ./tap.jsonl } }
output:
  from: t
  to: stdout
`,
    );
    const id = await post(r, { n: 1 });
    await settled(r.runner, id);
    const keys = readFileSync(join(b.root, "tap.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).packet_id)
      .sort();
    expect(keys).toEqual([`${id}:a:a`, `${id}:a:t`, `${id}:b:b`, `${id}:b:t`]);
  });

  test("fan-out is no longer a runtime gap", () => {
    const p = load(
      "pipo: 1\nname: g\ninput: { via: http }\nnodes:\n  a: { from: input, tap: log }\n  b: { from: input, tap: log }\noutput: { from: [a, b], to: stdout }\n",
    ).value as Pipeline;
    expect(gaps(p)).toEqual([]);
  });

  test("buffer.max counts packets, not copies", async () => {
    const b = box();
    const r = await start(
      b,
      "buffered",
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
    r.runner.pause();
    await post(r, { n: 1 });
    await post(r, { n: 2 });
    expect((await r.post("", { n: 3 })).status).toBe(503);
    expect(computeStats(r.runner.journal, Date.now()).pending).toBe(2);
    r.runner.resume();
    await waitFor(() => r.runner.journal.counts().delivered === 2, 5000, "both delivered");
  });
});

describe("journal migration", () => {
  test("a journal from before fan-out gains the branch columns and keeps its packets", () => {
    const b = box();
    const path = join(b.root, "old", "journal.db");
    mkdirSync(join(b.root, "old"));
    const db = new Database(path, { create: true });
    db.exec(`CREATE TABLE versions (version INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'human', created_at INTEGER NOT NULL);
    CREATE TABLE packets (id TEXT PRIMARY KEY, version INTEGER NOT NULL REFERENCES versions(version), state TEXT NOT NULL,
      cursor TEXT, data TEXT, trigger TEXT NOT NULL, source TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
      iteration INTEGER NOT NULL DEFAULT 0, hops INTEGER NOT NULL DEFAULT 0, error TEXT, result TEXT,
      received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO versions VALUES (1, 'h', 'src', 'human', 0);
    INSERT INTO packets (id, version, state, cursor, data, trigger, source, received_at, updated_at)
      VALUES ('P1', 1, 'processing', 'n', '{"n":1}', 'http', 'x', 0, 0), ('P2', 1, 'delivered', NULL, '{}', 'http', 'x', 0, 0);`);
    db.close();

    const j = new Journal(path);
    try {
      expect(j.get("P1")).toMatchObject({ state: "processing", cursor: "n", branch: "", root: null, parent: null });
      expect(j.inFlight().map((p) => p.id)).toEqual(["P1"]);
      expect(j.counts()).toEqual({ processing: 1, delivered: 1 });
      expect(j.countInFlight()).toBe(1);
    } finally {
      j.close();
    }
    // Opening again is a no-op.
    new Journal(path).close();
  });
});
