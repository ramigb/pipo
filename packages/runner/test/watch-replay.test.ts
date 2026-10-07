// Watch input restart behaviour (docs/spec.md §14.3): the snapshot lives in the journal, so files
// created, changed or deleted while the runner was down are emitted exactly once on the next start.
import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Journal, Runner } from "../src";
import { rows, sandbox, spawnRunner as spawn, waitFor } from "./helpers";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

type Event = { event: string; name: string; size: number };

function project(name: string, events = "[create, change, delete]", glob = "./drop/*.txt") {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  const drop = join(box.root, "drop");
  mkdirSync(drop);
  const db = join(box.home, "pipelines", name, "journal.db");
  const pipo = (ev = events, g = glob) =>
    box.write(
      `${name}.pipo`,
      `pipo: 1\nname: ${name}\ninput: { via: watch, with: { path: ${g}, events: ${ev}, read: content } }\noutput: { from: input, to: stdout }\n`,
    );
  pipo();
  const file = (f: string) => join(drop, f);
  const packets = (): Event[] =>
    existsSync(db)
      ? rows(db, "SELECT data FROM packets ORDER BY received_at, id").map((r) => {
          const d = JSON.parse(r.data);
          return { event: d.event, name: d.name, size: d.size };
        })
      : [];
  /** Start, let the replay scan run (it fires straight after start), then stop. */
  const cycle = async (expectCount: number) => {
    const runner = await Runner.open({ file: join(box.root, `${name}.pipo`), home: box.home, log: () => {} });
    await runner.start();
    cleanups.push(() => (runner.state === "stopped" ? undefined : runner.stop()));
    await waitFor(() => packets().length >= expectCount, 10_000, `${expectCount} packets`);
    await Bun.sleep(300); // nothing extra arrives
    await waitFor(
      () =>
        rows(
          db,
          "SELECT COUNT(*) AS n FROM packets WHERE state NOT IN ('delivered', 'filtered', 'dead_lettered', 'rejected')",
        )[0].n === 0,
      10_000,
      "packets settled",
    );
    await runner.stop();
    return runner;
  };
  return { box, db, file, packets, cycle, pipo };
}

const sorted = (e: Event[]) => [...e].sort((a, b) => `${a.name}${a.event}`.localeCompare(`${b.name}${b.event}`));

describe("watch replay", () => {
  test("changes made while the runner was down are emitted exactly once", async () => {
    const t = project("wr");
    writeFileSync(t.file("keep.txt"), "keep");
    writeFileSync(t.file("mod.txt"), "before");
    writeFileSync(t.file("del.txt"), "doomed");

    await t.cycle(0); // first start: baseline only
    expect(t.packets()).toEqual([]);

    writeFileSync(t.file("new.txt"), "fresh");
    writeFileSync(t.file("mod.txt"), "after, longer");
    rmSync(t.file("del.txt"));
    writeFileSync(t.file("ignored.json"), "{}");

    await t.cycle(3);
    expect(sorted(t.packets())).toEqual([
      { event: "delete", name: "del.txt", size: 6 },
      { event: "change", name: "mod.txt", size: 13 },
      { event: "create", name: "new.txt", size: 5 },
    ]);
    const replayed = rows(t.db, "SELECT data FROM packets WHERE json_extract(data, '$.event') = 'create'")[0];
    expect(JSON.parse(replayed.data).content).toBe("fresh");

    await t.cycle(3); // restart again: nothing re-emitted
    expect(t.packets()).toHaveLength(3);
  }, 30_000);

  test("live events are persisted too, so a restart does not repeat them", async () => {
    const t = project("wl");
    const runner = await Runner.open({ file: join(t.box.root, "wl.pipo"), home: t.box.home, log: () => {} });
    await runner.start();
    writeFileSync(t.file("live.txt"), "live");
    await waitFor(() => t.packets().length === 1, 10_000, "live create");
    await runner.stop();
    await t.cycle(1);
    expect(t.packets()).toEqual([{ event: "create", name: "live.txt", size: 4 }]);
  }, 30_000);

  test("an empty folder is still a baseline: files created while down are replayed", async () => {
    const t = project("we");
    await t.cycle(0);
    writeFileSync(t.file("a.txt"), "a");
    await t.cycle(1);
    expect(t.packets()).toEqual([{ event: "create", name: "a.txt", size: 1 }]);
  }, 30_000);

  test("unsubscribed events still move the snapshot; a changed glob starts a new baseline", async () => {
    const t = project("wf", "[create]");
    writeFileSync(t.file("m.txt"), "1");
    await t.cycle(0);
    writeFileSync(t.file("m.txt"), "22");
    writeFileSync(t.file("n.txt"), "n");
    await t.cycle(1);
    expect(t.packets()).toEqual([{ event: "create", name: "n.txt", size: 1 }]);

    t.pipo("[create, change, delete]"); // new version, same glob: the change was already seen
    await t.cycle(1);
    expect(t.packets()).toHaveLength(1);

    writeFileSync(t.file("late.txt"), "late");
    t.pipo("[create, change, delete]", "./drop/*"); // different glob: a fresh baseline, no replay
    await t.cycle(1);
    expect(t.packets()).toHaveLength(1);
  }, 30_000);

  test("the snapshot write shares the packet's transaction", () => {
    const box = sandbox();
    cleanups.push(() => box.cleanup());
    const j = new Journal(join(box.home, "j.db"));
    const v = j.version("h", "src");
    const s = j.inputState("watch:/x/*.txt");
    expect(s.load()).toBeNull();
    s.baseline(new Map([["/x/a.txt", { mtimeMs: 1, size: 1 }]]));
    const row = (id: string) => ({
      id,
      version: v,
      state: "accepted" as const,
      cursor: "$output",
      data: {},
      trigger: "watch",
      source: "s",
      error: null,
      received_at: Date.now(),
    });
    j.insert(row("p1"), "packet.accepted", undefined, () => s.put("/x/b.txt", { mtimeMs: 2, size: 2 }));
    // A failing commit rolls back the packet; a failing packet insert rolls back the commit.
    expect(() =>
      j.insert(row("p2"), "packet.accepted", undefined, () => {
        s.put("/x/c.txt", { mtimeMs: 3, size: 3 });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(() => j.insert(row("p1"), "packet.accepted", undefined, () => s.put("/x/a.txt", undefined))).toThrow();
    expect(j.get("p2")).toBeNull();
    expect([...(s.load() as Map<string, unknown>).keys()].sort()).toEqual(["/x/a.txt", "/x/b.txt"]);
    // A new scope replaces the old one (one input per pipeline).
    j.inputState("watch:/y/*").baseline(new Map());
    expect(s.load()).toBeNull();
    j.close();
  });

  test("journals from before input state existed still open", () => {
    const box = sandbox();
    cleanups.push(() => box.cleanup());
    const path = join(box.home, "old.db");
    new Journal(path).close();
    const db = new Database(path);
    db.exec("DROP TABLE input_state; DROP TABLE input_scopes;");
    db.close();
    const j = new Journal(path);
    expect(j.inputState("watch:/x").load()).toBeNull();
    j.close();
  });
});

// ── end to end: SIGKILL in the middle of a replay ─────────────────────────────

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
  for (const p of spawned) p.kill("SIGKILL");
  box.cleanup();
});
const spawnRunner = (file: string, n: number) => spawn(box, spawned, "watchy", file, n, [], 15_000).then((r) => r.proc);
const JOURNAL = join(box.home, "pipelines", "watchy", "journal.db");

// buffer.max 2 with a slow node throttles intake, so the replay is still running when it is killed.
const E2E = `pipo: 1
name: watchy
fn: ./fns.ts
concurrency: 1
buffer: { max: 2 }
input: { via: watch, with: { path: ./drop/*.txt, events: [create, change, delete], read: content } }
nodes:
  slow:
    from: input
    transform: fn.slow
output:
  from: slow
  to: file
  with: { path: ./out.jsonl }
`;

function journaled(): { path: string; event: string; size: number; state: string }[] {
  if (!existsSync(JOURNAL)) return [];
  return rows(JOURNAL, "SELECT data, state FROM packets").map((r) => {
    const d = JSON.parse(r.data);
    return { path: d.path, event: d.event, size: d.size, state: r.state };
  });
}

function snapshot(): Map<string, { size: number }> {
  return new Map(rows(JOURNAL, "SELECT key, value FROM input_state").map((r) => [r.key, JSON.parse(r.value)]));
}

test("SIGKILL mid-replay: every downtime change is emitted exactly once after restart", async () => {
  box.write("fns.ts", "export const slow = async (d) => { await Bun.sleep(100); return d; };");
  const file = box.write("watchy.pipo", E2E);
  const drop = join(box.root, "drop");
  mkdirSync(drop);
  const at = (f: string) => join(drop, f);
  for (let i = 0; i < 3; i++) writeFileSync(at(`m${i}.txt`), "m");
  for (let i = 0; i < 3; i++) writeFileSync(at(`d${i}.txt`), "d");

  // Run 1 (in-process) takes the baseline and stops cleanly.
  const first = await Runner.open({ file, home: box.home, log: () => {} });
  await first.start();
  await first.stop();
  expect(journaled()).toEqual([]);

  // While down: 8 creates, 3 changes (new sizes), 3 deletes.
  const expected = new Map<string, { event: string; size: number | null }>();
  for (let i = 0; i < 8; i++) {
    writeFileSync(at(`c${i}.txt`), `created ${i}`);
    expected.set(at(`c${i}.txt`), { event: "create", size: `created ${i}`.length });
  }
  for (let i = 0; i < 3; i++) {
    writeFileSync(at(`m${i}.txt`), `modified ${i}`);
    expected.set(at(`m${i}.txt`), { event: "change", size: `modified ${i}`.length });
  }
  for (let i = 0; i < 3; i++) {
    rmSync(at(`d${i}.txt`));
    expected.set(at(`d${i}.txt`), { event: "delete", size: null });
  }

  // Run 2 (a process) starts replaying and is killed part-way through.
  const second = await spawnRunner(file, 2);
  await waitFor(() => journaled().length >= 4, 15_000, "replay under way");
  second.kill("SIGKILL");
  await second.exited;

  const mid = journaled();
  expect(mid.length).toBeLessThan(expected.size); // the kill really interrupted the replay
  // Atomicity at the kill point: a path's snapshot entry moved exactly when its packet was journaled.
  const snap = snapshot();
  const done = new Set(mid.map((p) => p.path));
  for (const [path, want] of expected) {
    const advanced = want.size === null ? !snap.has(path) : snap.get(path)?.size === want.size;
    expect({ path, advanced }).toEqual({ path, advanced: done.has(path) });
  }

  // Run 3 (a process) finishes the replay without repeating anything.
  const third = await spawnRunner(file, 3);
  await waitFor(
    () => {
      const all = journaled();
      return all.length >= expected.size && all.every((p) => p.state === "delivered");
    },
    30_000,
    "replay finished and delivered",
  );
  third.kill("SIGTERM");
  expect(await third.exited).toBe(0);

  // Run 4 (in-process): a clean restart re-emits nothing.
  const fourth = await Runner.open({ file, home: box.home, log: () => {} });
  await fourth.start();
  await Bun.sleep(1200); // the replay scan and one poll
  await fourth.stop();

  const all = journaled();
  expect(all).toHaveLength(expected.size);
  const got = new Map(all.map((p) => [p.path, { event: p.event, size: p.event === "delete" ? null : p.size }]));
  expect(got).toEqual(expected);
  const lines = readFileSync(join(box.root, "out.jsonl"), "utf8").trim().split("\n");
  expect(lines).toHaveLength(expected.size);
  expect(new Set(lines.map((l) => JSON.parse(l).data.path)).size).toBe(expected.size);
}, 90_000);
