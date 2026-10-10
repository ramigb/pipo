// Output batching (docs/spec.md §3.5.1, D20): size and within flushes, pause/stop/drain flushing
// the partial batch, failure isolation by splitting, and validation before a packet joins.
import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { counts, drain, out, post, stopNow, suite } from "./core";
import { waitFor } from "./helpers";
import type { RustRunner } from "./rust";

setDefaultTimeout(30_000);
const { box: b, start } = suite();

const SQLITE_WITH = `{ path: ./NAME.db, table: items, create: true, columns: { packet_id: "\${meta.packet_id}", n: "\${data.n}" } }`;

function pipeline(name: string, output: string, extra = "") {
  return `pipo: 1\nname: ${name}\ninput: { via: http }\n${extra}output:\n  from: input\n${output.replaceAll("NAME", name)}`;
}

const items = (name: string, sql = "SELECT n FROM items ORDER BY n") => out(b.root, `${name}.db`, sql);

const atBatch = (r: RustRunner, ids: string[]) =>
  waitFor(() => ids.every((id) => r.packet(id)?.cursor === "$batch"), 5000, "packets waiting in the batch");

/** Batch size each packet was written with, from its `output.written` event. */
function flushSizes(r: RustRunner, ids: string[]) {
  const sizes = new Map(
    r
      .query<{ packet_id: string; detail: string }>(
        "SELECT packet_id, detail FROM events WHERE type = 'output.written'",
      )
      .map((e) => [e.packet_id, JSON.parse(e.detail)?.batch]),
  );
  return ids.map((id) => sizes.get(id));
}

describe("batch flushing", () => {
  test("flushes at size; drain writes the partial batch at once instead of waiting for within", async () => {
    const r = await start(
      "bsize",
      pipeline("bsize", `  to: sqlite\n  batch: { size: 3, within: 1h }\n  with: ${SQLITE_WITH}\n`),
    );
    const ids: string[] = [];
    for (let n = 0; n < 7; n++) ids.push(await post(r, { n }));
    for (const id of ids.slice(0, 6)) expect((await r.settled(id)).state).toBe("delivered");
    await Bun.sleep(300);
    expect(r.packet(ids[6] as string)).toMatchObject({ state: "writing", cursor: "$batch" });
    expect(items("bsize")).toHaveLength(6);

    const started = Date.now();
    expect(await drain(r)).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.query("SELECT state FROM packets").map((x) => x.state)).toEqual(Array(7).fill("delivered"));
    expect(flushSizes(r, ids)).toEqual([3, 3, 3, 3, 3, 3, 1]);
    expect(items("bsize").map((x) => x.n)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("flushes a partial batch once within has passed since the first packet joined", async () => {
    const r = await start(
      "bwithin",
      pipeline("bwithin", "  to: file\n  batch: { size: 100, within: 400ms }\n  with: { path: ./bwithin.jsonl }\n"),
    );
    const started = Date.now();
    const ids = [await post(r, { n: 1 }), await post(r, { n: 2 })];
    await atBatch(r, ids);
    await Bun.sleep(150);
    expect(counts(r)).toEqual({ writing: 2 });
    for (const id of ids) expect((await r.settled(id)).state).toBe("delivered");
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
    expect(flushSizes(r, ids)).toEqual([2, 2]);
    const lines = readFileSync(join(b.root, "bwithin.jsonl"), "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).packet_id)).toEqual(ids);
  });

  test("within defaults to 1s when the file leaves it out", async () => {
    const r = await start(
      "bdefault",
      pipeline("bdefault", "  to: file\n  batch: { size: 100 }\n  with: { path: ./bdefault.jsonl }\n"),
    );
    const started = Date.now();
    const id = await post(r, { n: 1 });
    expect((await r.settled(id, 5000)).state).toBe("delivered");
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });

  test("pause flushes the partial batch; the written packets are verified after resume", async () => {
    const r = await start(
      "bpause",
      pipeline("bpause", `  to: sqlite\n  batch: { size: 100, within: 1h }\n  with: ${SQLITE_WITH}\n`),
    );
    const ids = [await post(r, { n: 1 }), await post(r, { n: 2 }), await post(r, { n: 3 })];
    await atBatch(r, ids);
    await r.request("pause");
    await waitFor(() => counts(r).verifying === 3, 5000, "flush on pause");
    expect(items("bpause")).toHaveLength(3);
    await Bun.sleep(200);
    expect(counts(r)).toEqual({ verifying: 3 }); // paused: written, not yet verified
    await r.request("resume");
    for (const id of ids) expect((await r.settled(id)).state).toBe("delivered");
  });

  test("stop flushes the partial batch; the next start verifies what was written", async () => {
    const source = pipeline("bstop", `  to: sqlite\n  batch: { size: 100, within: 1h }\n  with: ${SQLITE_WITH}\n`);
    const r = await start("bstop", source);
    const ids = [await post(r, { n: 1 }), await post(r, { n: 2 })];
    await atBatch(r, ids);
    expect(await stopNow(r)).toBe(0);
    expect(items("bstop").map((x) => x.n)).toEqual([1, 2]);

    const again = await start("bstop", source);
    for (const id of ids) expect((await again.settled(id)).state).toBe("delivered");
    expect(items("bstop")).toHaveLength(2);
  });

  test("packets left waiting at $batch by a stop are batched again on restart and written once", async () => {
    // A flush that can't run at stop (the output is locked) leaves the packets at $batch.
    const source = pipeline(
      "bleft",
      `  to: sqlite\n  batch: { size: 100, within: 1h }\n  with: ${SQLITE_WITH}\n  on_error: { retry: 5, delay: 1s }\n`,
    );
    const r = await start("bleft", source);
    const ids = [await post(r, { n: 1 }), await post(r, { n: 2 })];
    await atBatch(r, ids);
    const lock = new Database(join(b.root, "bleft.db"));
    lock.exec("PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS items (packet_id PRIMARY KEY, n)");
    lock.exec("BEGIN EXCLUSIVE");
    expect(await stopNow(r)).toBe(0);
    lock.exec("ROLLBACK");
    lock.close();
    expect(r.query("SELECT cursor FROM packets").map((x) => x.cursor)).toEqual(["$batch", "$batch"]);

    const again = await start("bleft", source);
    expect(await drain(again)).toBe(0);
    expect(again.query("SELECT state FROM packets").map((x) => x.state)).toEqual(["delivered", "delivered"]);
    expect(items("bleft").map((x) => x.n)).toEqual([1, 2]);
  });
});

describe("failure isolation", () => {
  test("sqlite: one bad packet among 8 is isolated by splitting; 7 delivered, 1 dead with its own error", async () => {
    const db = new Database(join(b.root, "biso.db"));
    db.exec("CREATE TABLE items (packet_id TEXT PRIMARY KEY, n INTEGER CHECK (n <> 5))");
    db.close();
    const r = await start(
      "biso",
      pipeline(
        "biso",
        `  to: sqlite\n  batch: { size: 8, within: 1h }\n  with: { path: ./biso.db, table: items, columns: { packet_id: "\${meta.packet_id}", n: "\${data.n}" } }\n  on_error: { retry: 1, delay: 10ms }\n`,
      ),
    );
    const ids: string[] = [];
    for (let n = 0; n < 8; n++) ids.push(await post(r, { n }));
    const final = await Promise.all(ids.map((id) => r.settled(id)));
    expect(final.map((p) => p.state)).toEqual([
      ...Array(5).fill("delivered"),
      "dead_lettered",
      ...Array(2).fill("delivered"),
    ]);
    const dead = final[5];
    expect(dead?.error).toMatchObject({ code: "output.failed", node: "output", attempts: 2 });
    expect(dead?.error?.message).toContain("CHECK constraint failed");
    expect(items("biso").map((x) => x.n)).toEqual([0, 1, 2, 3, 4, 6, 7]);
    // 8 → 4+4, the failing 4 → 2+2, the failing 2 → 1+1.
    const splits = r.query("SELECT detail FROM events WHERE type = 'output.batch_split'");
    expect(splits.map((s) => JSON.parse(s.detail).size)).toEqual([8, 4, 2]);
    // 0–3 in the good half of 4, then 4 alone, 5 dead, 6–7 as a pair.
    expect(flushSizes(r, ids)).toEqual([4, 4, 4, 4, 1, undefined, 2, 2]);
  });

  test("file: one bad packet among 8 is isolated; re-written good packets are not duplicated", async () => {
    mkdirSync(join(b.root, "out"));
    writeFileSync(join(b.root, "out", "bad"), "a file, so out/bad/x.jsonl can't be created");
    const r = await start(
      "bisof",
      pipeline(
        "bisof",
        `  to: file\n  batch: { size: 8, within: 1h }\n  with: { path: "./out/\${data.dir}/x.jsonl" }\n`,
      ),
    );
    const ids: string[] = [];
    for (let n = 0; n < 8; n++) ids.push(await post(r, { n, dir: n === 2 ? "bad" : "good" }));
    const final = await Promise.all(ids.map((id) => r.settled(id)));
    expect(final.filter((p) => p.state === "delivered")).toHaveLength(7);
    expect(final[2]?.state).toBe("dead_lettered");
    // Rust words the OS error its own way ("File exists (os error 17)", not Node's EEXIST).
    expect(final[2]?.error?.message).toContain("File exists");
    const lines = readFileSync(join(b.root, "out", "good", "x.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines.map((l) => JSON.parse(l).data.n)).toEqual([0, 1, 3, 4, 5, 6, 7]);
  });

  test("then: pause holds the isolated packet at $batch and pauses; the others are written", async () => {
    const db = new Database(join(b.root, "bhold.db"));
    db.exec("CREATE TABLE items (packet_id TEXT PRIMARY KEY, n INTEGER CHECK (n <> 1))");
    db.close();
    const r = await start(
      "bhold",
      pipeline(
        "bhold",
        `  to: sqlite\n  batch: { size: 3, within: 1h }\n  with: { path: ./bhold.db, table: items, columns: { packet_id: "\${meta.packet_id}", n: "\${data.n}" } }\n  on_error: { then: pause }\n`,
      ),
    );
    const ids = [await post(r, { n: 0 }), await post(r, { n: 1 }), await post(r, { n: 2 })];
    const held = () => r.events(ids[1] as string).filter((e) => e.type === "packet.held").length;
    await waitFor(async () => (await r.status()).state === "paused" && held() === 1, 5000, "pause");
    await waitFor(() => items("bhold").length === 2, 5000, "good packets");
    expect(r.packet(ids[1] as string)).toMatchObject({ state: "writing", cursor: "$batch" });
    expect(items("bhold").map((x) => x.n)).toEqual([0, 2]);

    // On resume the held packet joins a new batch; drain flushes it, it fails again and is held again.
    await r.request("resume");
    for (const id of [ids[0], ids[2]]) expect((await r.settled(id as string)).state).toBe("delivered");
    expect(await drain(r)).toBe(0);
    expect(r.events(ids[1] as string).filter((e) => e.type === "packet.held")).toHaveLength(2);
    expect(r.packet(ids[1] as string)).toMatchObject({ state: "writing", cursor: "$batch" });
  });
});

describe("validation", () => {
  test("invalid packets never join a batch", async () => {
    const r = await start(
      "bvalid",
      pipeline(
        "bvalid",
        `  to: sqlite\n  batch: { size: 4, within: 1h }\n  with: ${SQLITE_WITH}\n  validate: ["data.n != 2"]\n`,
      ),
    );
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) ids.push(await post(r, { n }));
    const final = await Promise.all(ids.map((id) => r.settled(id)));
    expect(final.map((p) => p.state)).toEqual(["delivered", "delivered", "dead_lettered", "delivered", "delivered"]);
    expect(final[2]?.error?.code).toBe("output.invalid");
    const types = r.events(ids[2] as string).map((e) => e.type);
    expect(types).not.toContain("output.batched");
    expect(types).not.toContain("output.written");
    expect(flushSizes(r, ids)).toEqual([4, 4, undefined, 4, 4]);
  });
});
