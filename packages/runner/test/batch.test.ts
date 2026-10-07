// Output batching (docs/spec.md §3.5.1, D20): size and within flushes, pause/stop/drain flushing
// the partial batch, failure isolation by splitting, and validation before a packet joins.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gaps, type Runner } from "../src";
import { FileOutput } from "../src/connectors/file-output";
import type { WriteItem } from "../src/connectors/types";
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

const SQLITE_WITH = `{ path: ./out.db, table: items, create: true, columns: { packet_id: "\${meta.packet_id}", n: "\${data.n}" } }`;

function pipeline(name: string, output: string, extra = "") {
  return `pipo: 1\nname: ${name}\ninput: { via: http }\n${extra}output:\n  from: input\n${output}`;
}

async function start(b: ReturnType<typeof box>, name: string, source: string) {
  const file = b.write(`${name}.pipo`, source);
  const r = await startRunner(file, b.home);
  cleanups.push(() => (r.runner.state === "stopped" || r.runner.state === "failed" ? undefined : r.runner.stop()));
  return r;
}

async function post(r: Awaited<ReturnType<typeof start>>, data: unknown): Promise<string> {
  const res = await r.post("", data);
  expect(res.status).toBe(202);
  return ((await res.json()) as { packet_id: string }).packet_id;
}

const atBatch = (runner: Runner, ids: string[]) =>
  waitFor(() => ids.every((id) => runner.journal.get(id)?.cursor === "$batch"), 5000, "packets waiting in the batch");

/** Batch size each packet was written with, from its `output.written` event (read from the file, so it works after stop). */
function flushSizes(runner: Runner, home: string, ids: string[]) {
  const db = join(home, "pipelines", runner.pipeline.name, "journal.db");
  const sizes = new Map(
    rows(db, "SELECT packet_id, detail FROM events WHERE type = 'output.written'").map((e) => [
      e.packet_id,
      JSON.parse(e.detail)?.batch,
    ]),
  );
  return ids.map((id) => sizes.get(id));
}

describe("batch flushing", () => {
  test("flushes at size; drain writes the partial batch at once instead of waiting for within", async () => {
    const b = box();
    const r = await start(
      b,
      "bsize",
      pipeline("bsize", `  to: sqlite\n  batch: { size: 3, within: 1h }\n  with: ${SQLITE_WITH}\n`),
    );
    const ids: string[] = [];
    for (let n = 0; n < 7; n++) ids.push(await post(r, { n }));
    for (const id of ids.slice(0, 6)) expect((await settled(r.runner, id)).state).toBe("delivered");
    await Bun.sleep(300);
    expect(r.runner.journal.get(ids[6] as string)).toMatchObject({ state: "writing", cursor: "$batch" });
    expect(rows(join(b.root, "out.db"), "SELECT n FROM items")).toHaveLength(6);

    const started = Date.now();
    await r.runner.drain();
    expect(Date.now() - started).toBeLessThan(5000);
    const journal = join(b.home, "pipelines", "bsize", "journal.db");
    expect(rows(journal, "SELECT state FROM packets").map((x) => x.state)).toEqual(Array(7).fill("delivered"));
    expect(flushSizes(r.runner, b.home, ids)).toEqual([3, 3, 3, 3, 3, 3, 1]);
    expect(rows(join(b.root, "out.db"), "SELECT n FROM items ORDER BY n").map((x) => x.n)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  test("flushes a partial batch once within has passed since the first packet joined", async () => {
    const b = box();
    const r = await start(
      b,
      "bwithin",
      pipeline("bwithin", "  to: file\n  batch: { size: 100, within: 400ms }\n  with: { path: ./out.jsonl }\n"),
    );
    const started = Date.now();
    const ids = [await post(r, { n: 1 }), await post(r, { n: 2 })];
    await atBatch(r.runner, ids);
    await Bun.sleep(150);
    expect(r.runner.journal.counts()).toEqual({ writing: 2 });
    for (const id of ids) expect((await settled(r.runner, id)).state).toBe("delivered");
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
    expect(flushSizes(r.runner, b.home, ids)).toEqual([2, 2]);
    const lines = readFileSync(join(b.root, "out.jsonl"), "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).packet_id)).toEqual(ids);
  });

  test("within defaults to 1s when the file leaves it out", async () => {
    const b = box();
    const r = await start(
      b,
      "bdefault",
      pipeline("bdefault", "  to: file\n  batch: { size: 100 }\n  with: { path: ./out.jsonl }\n"),
    );
    const started = Date.now();
    const id = await post(r, { n: 1 });
    expect((await settled(r.runner, id, 5000)).state).toBe("delivered");
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });

  test("pause flushes the partial batch; the written packets are verified after resume", async () => {
    const b = box();
    const r = await start(
      b,
      "bpause",
      pipeline("bpause", `  to: sqlite\n  batch: { size: 100, within: 1h }\n  with: ${SQLITE_WITH}\n`),
    );
    const ids = [await post(r, { n: 1 }), await post(r, { n: 2 }), await post(r, { n: 3 })];
    await atBatch(r.runner, ids);
    r.runner.pause();
    await waitFor(() => r.runner.journal.counts().verifying === 3, 5000, "flush on pause");
    expect(rows(join(b.root, "out.db"), "SELECT n FROM items")).toHaveLength(3);
    await Bun.sleep(200);
    expect(r.runner.journal.counts()).toEqual({ verifying: 3 }); // paused: written, not yet verified
    r.runner.resume();
    for (const id of ids) expect((await settled(r.runner, id)).state).toBe("delivered");
  });

  test("stop flushes the partial batch; the next start verifies what was written", async () => {
    const b = box();
    const source = pipeline("bstop", `  to: sqlite\n  batch: { size: 100, within: 1h }\n  with: ${SQLITE_WITH}\n`);
    const r = await start(b, "bstop", source);
    const ids = [await post(r, { n: 1 }), await post(r, { n: 2 })];
    await atBatch(r.runner, ids);
    await r.runner.stop();
    expect(rows(join(b.root, "out.db"), "SELECT n FROM items ORDER BY n").map((x) => x.n)).toEqual([1, 2]);

    const again = await start(b, "bstop", source);
    for (const id of ids) expect((await settled(again.runner, id)).state).toBe("delivered");
    expect(rows(join(b.root, "out.db"), "SELECT n FROM items")).toHaveLength(2);
  });

  test("packets left waiting at $batch by a stop are batched again on restart and written once", async () => {
    const b = box();
    // A flush that can't run at stop (the output is locked) leaves the packets at $batch.
    const source = pipeline(
      "bleft",
      `  to: sqlite\n  batch: { size: 100, within: 1h }\n  with: ${SQLITE_WITH}\n  on_error: { retry: 5, delay: 1s }\n`,
    );
    const r = await start(b, "bleft", source);
    const ids = [await post(r, { n: 1 }), await post(r, { n: 2 })];
    await atBatch(r.runner, ids);
    const lock = new Database(join(b.root, "out.db"));
    lock.exec("PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS items (packet_id PRIMARY KEY, n)");
    lock.exec("BEGIN EXCLUSIVE");
    await r.runner.stop();
    lock.exec("ROLLBACK");
    lock.close();
    const db = join(b.home, "pipelines", "bleft", "journal.db");
    expect(rows(db, "SELECT cursor FROM packets").map((x) => x.cursor)).toEqual(["$batch", "$batch"]);

    const again = await start(b, "bleft", source);
    await again.runner.drain();
    expect(rows(db, "SELECT state FROM packets").map((x) => x.state)).toEqual(["delivered", "delivered"]);
    expect(rows(join(b.root, "out.db"), "SELECT n FROM items ORDER BY n").map((x) => x.n)).toEqual([1, 2]);
  }, 20_000);
});

describe("failure isolation", () => {
  test("sqlite: one bad packet among 8 is isolated by splitting; 7 delivered, 1 dead with its own error", async () => {
    const b = box();
    const db = new Database(join(b.root, "out.db"));
    db.exec("CREATE TABLE items (packet_id TEXT PRIMARY KEY, n INTEGER CHECK (n <> 5))");
    db.close();
    const r = await start(
      b,
      "biso",
      pipeline(
        "biso",
        `  to: sqlite\n  batch: { size: 8, within: 1h }\n  with: { path: ./out.db, table: items, columns: { packet_id: "\${meta.packet_id}", n: "\${data.n}" } }\n  on_error: { retry: 1, delay: 10ms }\n`,
      ),
    );
    const ids: string[] = [];
    for (let n = 0; n < 8; n++) ids.push(await post(r, { n }));
    const final = await Promise.all(ids.map((id) => settled(r.runner, id)));
    expect(final.map((p) => p.state)).toEqual([
      ...Array(5).fill("delivered"),
      "dead_lettered",
      ...Array(2).fill("delivered"),
    ]);
    const dead = final[5];
    expect(dead?.error).toMatchObject({ code: "output.failed", node: "output", attempts: 2 });
    expect(dead?.error?.message).toContain("CHECK constraint failed");
    expect(rows(join(b.root, "out.db"), "SELECT n FROM items ORDER BY n").map((x) => x.n)).toEqual([
      0, 1, 2, 3, 4, 6, 7,
    ]);
    // 8 → 4+4, the failing 4 → 2+2, the failing 2 → 1+1.
    const splits = rows(
      join(b.home, "pipelines", "biso", "journal.db"),
      "SELECT detail FROM events WHERE type = 'output.batch_split'",
    );
    expect(splits.map((s) => JSON.parse(s.detail).size)).toEqual([8, 4, 2]);
    // 0–3 in the good half of 4, then 4 alone, 5 dead, 6–7 as a pair.
    expect(flushSizes(r.runner, b.home, ids)).toEqual([4, 4, 4, 4, 1, undefined, 2, 2]);
  });

  test("file: one bad packet among 8 is isolated; re-written good packets are not duplicated", async () => {
    const b = box();
    mkdirSync(join(b.root, "out"));
    writeFileSync(join(b.root, "out", "bad"), "a file, so out/bad/x.jsonl can't be created");
    const r = await start(
      b,
      "bisof",
      pipeline(
        "bisof",
        `  to: file\n  batch: { size: 8, within: 1h }\n  with: { path: "./out/\${data.dir}/x.jsonl" }\n`,
      ),
    );
    const ids: string[] = [];
    for (let n = 0; n < 8; n++) ids.push(await post(r, { n, dir: n === 2 ? "bad" : "good" }));
    const final = await Promise.all(ids.map((id) => settled(r.runner, id)));
    expect(final.filter((p) => p.state === "delivered")).toHaveLength(7);
    expect(final[2]?.state).toBe("dead_lettered");
    expect(final[2]?.error?.message).toContain("EEXIST");
    const lines = readFileSync(join(b.root, "out", "good", "x.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines.map((l) => JSON.parse(l).data.n)).toEqual([0, 1, 3, 4, 5, 6, 7]);
  });

  test("then: pause holds the isolated packet at $batch and pauses; the others are written", async () => {
    const b = box();
    const db = new Database(join(b.root, "out.db"));
    db.exec("CREATE TABLE items (packet_id TEXT PRIMARY KEY, n INTEGER CHECK (n <> 1))");
    db.close();
    const r = await start(
      b,
      "bhold",
      pipeline(
        "bhold",
        `  to: sqlite\n  batch: { size: 3, within: 1h }\n  with: { path: ./out.db, table: items, columns: { packet_id: "\${meta.packet_id}", n: "\${data.n}" } }\n  on_error: { then: pause }\n`,
      ),
    );
    const ids = [await post(r, { n: 0 }), await post(r, { n: 1 }), await post(r, { n: 2 })];
    const held = () => r.runner.journal.events(ids[1] as string).filter((e) => e.type === "packet.held").length;
    await waitFor(() => r.runner.state === "paused" && held() === 1, 5000, "pause");
    await waitFor(() => rows(join(b.root, "out.db"), "SELECT n FROM items").length === 2, 5000, "good packets");
    expect(r.runner.journal.get(ids[1] as string)).toMatchObject({ state: "writing", cursor: "$batch" });
    expect(rows(join(b.root, "out.db"), "SELECT n FROM items ORDER BY n").map((x) => x.n)).toEqual([0, 2]);

    // On resume the held packet joins a new batch; drain flushes it, it fails again and is held again.
    r.runner.resume();
    for (const id of [ids[0], ids[2]]) expect((await settled(r.runner, id as string)).state).toBe("delivered");
    await r.runner.drain();
    const journal = join(b.home, "pipelines", "bhold", "journal.db");
    expect(
      rows(journal, `SELECT COUNT(*) AS n FROM events WHERE type = 'packet.held' AND packet_id = '${ids[1]}'`)[0].n,
    ).toBe(2);
    expect(rows(journal, `SELECT state, cursor FROM packets WHERE id = '${ids[1]}'`)[0]).toEqual({
      state: "writing",
      cursor: "$batch",
    });
  });
});

describe("validation", () => {
  test("invalid packets never join a batch", async () => {
    const b = box();
    const r = await start(
      b,
      "bvalid",
      pipeline(
        "bvalid",
        `  to: sqlite\n  batch: { size: 4, within: 1h }\n  with: ${SQLITE_WITH}\n  validate: ["data.n != 2"]\n`,
      ),
    );
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) ids.push(await post(r, { n }));
    const final = await Promise.all(ids.map((id) => settled(r.runner, id)));
    expect(final.map((p) => p.state)).toEqual(["delivered", "delivered", "dead_lettered", "delivered", "delivered"]);
    expect(final[2]?.error?.code).toBe("output.invalid");
    const types = r.runner.journal.events(ids[2] as string).map((e) => e.type);
    expect(types).not.toContain("output.batched");
    expect(types).not.toContain("output.written");
    expect(flushSizes(r.runner, b.home, ids)).toEqual([4, 4, undefined, 4, 4]);
  });

  test("the runner no longer refuses output.batch", () => {
    const p = {
      pipo: 1,
      name: "x",
      input: { via: "http" },
      output: { from: "input", to: "sqlite", batch: { size: 2 } },
    };
    expect(gaps(p as any).filter((g) => g.path === "output.batch")).toEqual([]);
  });
});

describe("file adapter batches", () => {
  const item = (packetId: string, data: unknown, w: Record<string, unknown>): WriteItem => ({
    packetId,
    data,
    with: w,
  });

  test("csv: a batch is one sidecar entry; a torn batch append is cut back and written again once", async () => {
    const b = box();
    const w = { path: "out.csv", format: "csv" };
    const out = new FileOutput(b.root);
    await out.write([item("a", { n: 1 }, w), item("b", { n: 2 }, w)]);
    out.close();
    const path = join(b.root, "out.csv");
    const log = readFileSync(`${path}.pipo-keys`, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(log).toEqual([
      ["begin", ["a", "b"], 0, 6],
      ["done", ["a", "b"]],
    ]);

    // A crash mid-append: the begin record is there, half the rows are not.
    const size = statSync(path).size;
    appendFileSync(`${path}.pipo-keys`, `${JSON.stringify(["begin", ["c", "d"], size, 4])}\n`);
    appendFileSync(path, "3");
    const fresh = new FileOutput(b.root);
    const res = await fresh.write([item("b", { n: 2 }, w), item("c", { n: 3 }, w), item("d", { n: 4 }, w)]);
    expect(res).toEqual([
      { path, skipped: true },
      { path, written: true },
      { path, written: true },
    ]);
    fresh.close();
    expect(readFileSync(path, "utf8")).toBe("n\n1\n2\n3\n4\n");
  });

  test("jsonl: a batch is one append and skips packets already in the file", async () => {
    const b = box();
    const w = { path: "out.jsonl" };
    const out = new FileOutput(b.root);
    await out.write([item("a", 1, w)]);
    const again = new FileOutput(b.root);
    const res = await again.write([item("a", 1, w), item("b", 2, w), item("b", 2, w)]);
    expect(res.map((x: any) => x.written === true)).toEqual([false, true, false]);
    const lines = readFileSync(join(b.root, "out.jsonl"), "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).packet_id)).toEqual(["a", "b"]);
  });

  test("mode write: one replace per flush, the last packet's content wins", async () => {
    const b = box();
    const w = { path: "snap.json", format: "json", mode: "write" };
    const out = new FileOutput(b.root);
    await out.write([item("a", { v: 1 }, w), item("b", { v: 2 }, w)]);
    expect(JSON.parse(readFileSync(join(b.root, "snap.json"), "utf8"))).toEqual({ v: 2 });
  });
});
