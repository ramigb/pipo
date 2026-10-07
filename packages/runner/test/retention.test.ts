import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "@pipo/spec";
import { gaps } from "../src";
import { applyRetention, retentionPolicy, startRetention } from "../src/retention";
import { sandbox } from "./helpers";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const boxes: ReturnType<typeof sandbox>[] = [];
afterEach(() => {
  while (boxes.length) boxes.pop()?.cleanup();
});

function open() {
  const box = sandbox();
  boxes.push(box);
  const db = new Database(join(box.root, "j.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE versions (version INTEGER PRIMARY KEY);
CREATE TABLE packets (id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL, data TEXT, result TEXT,
  updated_at INTEGER NOT NULL, parent TEXT);
CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, packet_id TEXT, type TEXT);
INSERT INTO versions VALUES (1);`);
  return db;
}

function add(db: Database, id: string, state: string, ageDays: number, parent: string | null = null) {
  db.query("INSERT INTO packets (id, state, data, result, updated_at, parent) VALUES (?, ?, '{}', '{}', ?, ?)").run(
    id,
    state,
    NOW - ageDays * DAY,
    parent,
  );
  db.query("INSERT INTO events (at, packet_id, type) VALUES (?, ?, 'x')").run(NOW - ageDays * DAY, id);
}

const ids = (db: Database) =>
  (db.query("SELECT id FROM packets ORDER BY id").all() as { id: string }[]).map((r) => r.id);
const hasData = (db: Database, id: string) =>
  (db.query("SELECT data FROM packets WHERE id = ?").get(id) as { data: string | null }).data !== null;

test("defaults: 7d data, 30d trail, 3d rejected, dead letters kept", () => {
  const db = open();
  add(db, "d-new", "delivered", 1);
  add(db, "d-mid", "delivered", 10);
  add(db, "d-old", "delivered", 31);
  add(db, "f-mid", "filtered", 8);
  add(db, "r-new", "rejected", 1);
  add(db, "r-mid", "rejected", 4);
  add(db, "dl", "dead_lettered", 400);
  const res = applyRetention(db, retentionPolicy(undefined), NOW);
  expect(ids(db)).toEqual(["d-mid", "d-new", "dl", "f-mid", "r-mid", "r-new"]);
  expect(hasData(db, "d-new")).toBe(true);
  expect(hasData(db, "d-mid")).toBe(false);
  expect(hasData(db, "f-mid")).toBe(false);
  expect(hasData(db, "r-new")).toBe(true);
  expect(hasData(db, "r-mid")).toBe(false);
  expect(hasData(db, "dl")).toBe(true);
  expect(res.deleted).toBe(1);
  expect(res.events).toBe(1);
  expect(db.query("SELECT COUNT(*) AS n FROM events WHERE packet_id = 'd-old'").get()).toEqual({ n: 0 });
});

test("custom durations, including a dlq expiry", () => {
  const db = open();
  add(db, "d", "delivered", 3);
  add(db, "dl-old", "dead_lettered", 6);
  add(db, "dl-new", "dead_lettered", 1);
  const policy = retentionPolicy({ data: "1d", trail: "2d", dlq: "5d" });
  applyRetention(db, policy, NOW);
  expect(ids(db)).toEqual(["dl-new"]);
});

test("pending, in-flight and awaiting-delivery packets and versions are never touched", () => {
  const db = open();
  for (const s of ["accepted", "processing", "writing", "verifying", "fanned_out"]) add(db, s, s, 1000);
  applyRetention(db, retentionPolicy({ data: "1ms", trail: "1ms", rejected: "1ms", dlq: "1ms" }), NOW);
  expect(ids(db).length).toBe(5);
  expect(hasData(db, "accepted")).toBe(true);
  expect(db.query("SELECT COUNT(*) AS n FROM versions").get()).toEqual({ n: 1 });
});

test("fan-out parents wait for their copies; unrelated events are kept", () => {
  const db = open();
  add(db, "p", "delivered", 40);
  add(db, "p#a", "processing", 40, "p");
  db.query("INSERT INTO events (at, packet_id, type) VALUES (1, NULL, 'pipeline.paused')").run();
  applyRetention(db, retentionPolicy(undefined), NOW);
  expect(ids(db)).toEqual(["p", "p#a"]);
  db.query("UPDATE packets SET state = 'delivered' WHERE id = 'p#a'").run();
  applyRetention(db, retentionPolicy(undefined), NOW);
  expect(ids(db)).toEqual([]);
  expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
});

test("bounded batches drain everything and a rerun is a no-op", () => {
  const db = open();
  for (let i = 0; i < 25; i++) add(db, `d${i}`, "delivered", 40);
  const first = applyRetention(db, retentionPolicy(undefined), NOW, 4);
  expect(first.deleted).toBe(25);
  expect(first.events).toBe(25);
  expect(applyRetention(db, retentionPolicy(undefined), NOW, 4)).toEqual({ cleared: 0, deleted: 0, events: 0 });
});

test("compaction runs once per day on a fake clock", () => {
  const db = open();
  let t = NOW;
  const runs: boolean[] = [];
  const r = startRetention(db, retentionPolicy(undefined), {
    now: () => t,
    intervalMs: 3_600_000,
    onRun: (x) => runs.push(x.compacted),
  });
  const stamp = () => (db.query("SELECT compacted_at AS at FROM retention_state").get() as { at: number }).at;
  expect(stamp()).toBe(NOW);
  t += DAY - 1;
  r.tick();
  expect(stamp()).toBe(NOW);
  t += 1;
  add(db, "old", "delivered", 40);
  r.tick();
  expect(stamp()).toBe(NOW + DAY);
  expect(runs).toEqual([true]);
  t += DAY / 2;
  r.tick();
  expect(stamp()).toBe(NOW + DAY);
  r.stop();
});

test("the retention gap is gone", () => {
  const box = sandbox();
  boxes.push(box);
  const file = box.write(
    "a.pipo",
    `pipo: 1
name: a
input: { via: http }
output: { to: file, with: { path: out.jsonl } }
retention: { data: 1d }
`,
  );
  const pipeline = load(readFileSync(file, "utf8"), file).value!;
  expect(gaps(pipeline).filter((g) => g.path === "retention")).toEqual([]);
});
