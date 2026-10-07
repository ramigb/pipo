// Versions, rollback and restart semantics (docs/spec.md §7.3, §9.3, D38), in-process: a rollback stores the earlier
// source as a new version that only new packets use while an in-flight packet finishes on its pinned version; a start
// runs the file only when it changed since the last start; old journals migrate; history, version and diff reads.
// Kill-and-restart lives in versions-recovery.test.ts.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, type ControlError, Journal, offlineRead, Runner, readRegistryEntry, unifiedDiff } from "../src";
import { sandbox, settled, waitFor } from "./helpers";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
  (globalThis as any).__pipoGate = undefined;
});

function setup() {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  box.write(
    "fns.ts",
    `export const gate = async (d) => { const g = globalThis.__pipoGate; if (g && d.wait) await g; return d; };
export const one = (d) => ({ ...d, v: "one" });
export const two = (d) => ({ ...d, v: "two" });
`,
  );
  return box;
}

const SRC = (name: string, tag: "one" | "two", extra = "") => `pipo: 1
name: ${name}
fn: ./fns.ts
input: { via: push }
nodes:
  gate: { from: input, transform: fn.gate }
  tag: { from: gate, transform: fn.${tag} }
output: { from: tag, to: file, with: { path: ./${name}.jsonl, format: jsonl } }
${extra}`;

async function open(box: ReturnType<typeof setup>, file: string) {
  const lines: string[] = [];
  const runner = await Runner.open({ file, home: box.home, log: (l) => lines.push(l) });
  await runner.start();
  cleanups.push(() => (runner.state === "stopped" || runner.state === "failed" ? undefined : runner.stop()));
  return { runner, lines };
}

async function client(box: { home: string }, name: string) {
  const c = await ControlClient.forPipeline(box.home, name);
  cleanups.push(() => c.close());
  return c;
}

const written = (box: { root: string }, name: string) => {
  const path = join(box.root, `${name}.jsonl`);
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { packet_id: string; data: any })
    : [];
};

function gate() {
  let open!: () => void;
  (globalThis as any).__pipoGate = new Promise<void>((r) => {
    open = r;
  });
  return open;
}

describe("rollback", () => {
  test("stores a new version that new packets use; an in-flight packet finishes on its pinned version", async () => {
    const box = setup();
    const file = box.write("rb.pipo", SRC("rb", "one"));
    const { runner } = await open(box, file);
    const c = await client(box, "rb");
    expect(runner.version).toBe(1);

    // v2 via `apply`; a packet accepted on v2 waits at the gate, in flight.
    const release = gate();
    const applied = await c.request("apply", { source: SRC("rb", "two"), by: "test", reason: "try two" });
    expect(applied).toMatchObject({ version: 2, previous: 1, changed: true, pending_older: 0 });
    const a = (await c.request("push", { data: { n: 1, wait: true } })).packet_id;
    await waitFor(() => runner.journal.get(a)?.cursor === "gate", 5000, "packet a at the gate");

    const rb = await c.request("rollback", { version: "v1" });
    expect(rb).toMatchObject({ version: 3, previous: 2, changed: true, pending_older: 1, rolled_back_to: 1 });
    expect(runner.version).toBe(3);
    expect((await c.request("hello")).version).toBe(3);
    expect(readRegistryEntry(box.home, "rb")?.version).toBe(3);

    const b = (await c.request("push", { data: { n: 2 } })).packet_id;
    expect((await settled(runner, b)).version).toBe(3);
    expect(runner.journal.get(a)?.state).not.toBe("delivered");
    release();
    expect((await settled(runner, a)).version).toBe(2);
    const out = Object.fromEntries(written(box, "rb").map((l) => [l.packet_id, l.data.v]));
    expect(out).toEqual({ [a]: "two", [b]: "one" });

    const v = runner.journal.db
      .query("SELECT version, hash, author, reason FROM versions ORDER BY version")
      .all() as any[];
    expect(v.map((r) => [r.version, r.author, r.reason])).toEqual([
      [1, "human", "first start"],
      [2, "test", "try two"],
      [3, "control", "rollback to v1"],
    ]);
    expect(v[2].hash).toBe(v[0].hash);
    const events = runner.journal.db
      .query("SELECT detail FROM events WHERE type = 'version.applied' ORDER BY seq")
      .all() as { detail: string }[];
    expect(events.map((e) => JSON.parse(e.detail))).toMatchObject([
      { version: 2, previous: 1, author: "test", reason: "try two" },
      { version: 3, previous: 2, author: "control", reason: "rollback to v1" },
    ]);

    // History and diff over the socket.
    const h = await c.request("versions");
    expect(h).toMatchObject({ current: 3, latest: 3 });
    expect(h.versions.map((x: any) => x.version)).toEqual([3, 2, 1]);
    const d = await c.request("diff", { from: 1, to: 2 });
    expect(d).toMatchObject({ from: 1, to: 2, identical: false, added: 1, removed: 1 });
    expect(d.diff).toContain("--- rb v1\n+++ rb v2\n@@ -4,5 +4,5 @@");
    expect(d.diff).toContain("-  tag: { from: gate, transform: fn.one }\n+  tag: { from: gate, transform: fn.two }");
    expect(await c.request("diff", { from: 1, to: 3 })).toMatchObject({ identical: true, diff: "" });
    expect((await c.request("version", { version: 2 })).definition).toBe(SRC("rb", "two"));
  });

  test("refusals change nothing: unknown version, failing check, bound-at-start changes; same content is a no-op", async () => {
    const box = setup();
    const file = box.write("ref.pipo", SRC("ref", "one"));
    const { runner } = await open(box, file);
    const c = await client(box, "ref");
    const err = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e) => e as ControlError,
      );

    const unknown = await err(c.request("rollback", { version: 9 }));
    expect(unknown).toMatchObject({ code: "not_found", message: "ref has no version 9 (versions are v1 to v1)" });
    expect(unknown?.hint).toBe("list them with pipo history ref");
    expect((await err(c.request("rollback", { version: "latest" })))?.code).toBe("bad_request");
    expect((await err(c.request("version", { version: 4 })))?.code).toBe("not_found");

    const broken = await err(c.request("apply", { source: SRC("ref", "one").replace("from: gate", "from: nowhere") }));
    expect(broken?.code).toBe("invalid_pipeline");
    expect(broken?.message).toContain("P010");

    const life = await err(c.request("apply", { source: SRC("ref", "two", "lifetime: { max_packets: 100 }") }));
    expect(life?.code).toBe("invalid_state");
    expect(life?.message).toContain("changes lifetime, which the runner binds when it starts");
    expect(life?.hint).toContain("pipo restart ref");
    const conc = await err(c.request("apply", { source: SRC("ref", "two", "concurrency: 2") }));
    expect(conc?.message).toContain("concurrency");

    expect(await c.request("rollback", { version: 1 })).toMatchObject({ version: 1, changed: false });
    expect(await c.request("apply", { source: SRC("ref", "one") })).toMatchObject({ version: 1, changed: false });
    expect(runner.journal.latestVersion()?.version).toBe(1);
    expect(runner.version).toBe(1);

    // A draining pipeline takes no new packets, so it takes no new version either.
    const r2 = await c.request("apply", { source: SRC("ref", "two") });
    expect(r2.version).toBe(2);
    const release = gate();
    const held = (await c.request("push", { data: { n: 1, wait: true } })).packet_id;
    await waitFor(() => runner.journal.get(held)?.cursor === "gate", 5000, "packet at the gate");
    const drained = runner.drain();
    const draining = await err(c.request("rollback", { version: 1 }));
    expect(draining?.code).toBe("invalid_state");
    expect(draining?.message).toContain("draining");
    expect(runner.journal.latestVersion()?.version).toBe(2);
    release();
    await drained;
  });
});

describe("restart (D38)", () => {
  test("the latest version stays across a restart unless the file changed since the last start", async () => {
    const box = setup();
    const file = box.write("rs.pipo", SRC("rs", "one"));
    let { runner } = await open(box, file);
    await runner.applyVersion(SRC("rs", "two"), { author: "test", reason: "two" });
    expect(runner.version).toBe(2);
    await runner.stop();

    // File unchanged since the last start: v2 (applied) stays, and new packets use it.
    ({ runner } = await open(box, file));
    expect(runner.version).toBe(2);
    expect(runner.journal.lastPipelineEvent("pipeline.started")?.detail).toMatchObject({ version: 2 });
    const c = await client(box, "rs");
    const p1 = (await c.request("push", { data: { n: 1 } })).packet_id;
    await settled(runner, p1);
    expect(written(box, "rs").find((l) => l.packet_id === p1)?.data.v).toBe("two");
    await runner.stop();

    // The file changed: it wins, as a new version.
    writeFileSync(file, SRC("rs", "one", "description: edited"));
    ({ runner } = await open(box, file));
    expect(runner.version).toBe(3);
    await runner.applyVersion(SRC("rs", "two"), { author: "test", reason: "two again" });
    await runner.stop();
    ({ runner } = await open(box, file));
    expect(runner.version).toBe(4);
    await runner.stop();

    // A changed file whose content equals the latest version adds nothing.
    writeFileSync(file, SRC("rs", "two"));
    ({ runner } = await open(box, file));
    expect(runner.version).toBe(4);
    const rows = runner.journal.db.query("SELECT version, author, reason FROM versions ORDER BY version").all();
    expect(rows).toEqual([
      { version: 1, author: "human", reason: "first start" },
      { version: 2, author: "test", reason: "two" },
      { version: 3, author: "human", reason: "file changed" },
      { version: 4, author: "test", reason: "two again" },
    ]);
  });

  test("a journal version that no longer passes check refuses the start and says how to get the file back", async () => {
    const box = setup();
    const file = box.write("bad.pipo", SRC("bad", "one"));
    const { runner } = await open(box, file);
    await runner.applyVersion(SRC("bad", "two"), { author: "test", reason: "two" });
    await runner.stop();
    // fn.two disappears: v2 (the latest, which a start with the unchanged file runs) now fails P012.
    writeFileSync(join(box.root, "fns.ts"), "export const gate = (d) => d;\nexport const one = (d) => d;\n");
    const e = await Runner.open({ file, home: box.home, log: () => {} }).catch((x) => x);
    expect(e.message).toContain("v2 of the pipeline");
    expect(e.message).toContain("edit the file to run it instead");
    expect(e.diagnostics.some((d: any) => d.code === "P012")).toBe(true);
  });
});

describe("journal", () => {
  test("a journal from before D38 loses the unique hash, gains reason, keeps its packets and their versions", () => {
    const box = setup();
    const path = join(box.root, "old", "journal.db");
    mkdirSync(join(box.root, "old"));
    const db = new Database(path, { create: true });
    db.exec(`CREATE TABLE versions (version INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'human', created_at INTEGER NOT NULL);
    CREATE TABLE packets (id TEXT PRIMARY KEY, version INTEGER NOT NULL REFERENCES versions(version), state TEXT NOT NULL,
      cursor TEXT, data TEXT, trigger TEXT NOT NULL, source TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
      iteration INTEGER NOT NULL DEFAULT 0, hops INTEGER NOT NULL DEFAULT 0, error TEXT, result TEXT,
      received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO versions VALUES (1, 'h1', 'one', 'human', 0), (2, 'h2', 'two', 'human', 1);
    INSERT INTO packets (id, version, state, cursor, data, trigger, source, received_at, updated_at)
      VALUES ('P1', 1, 'processing', 'n', '{}', 'push', 'x', 0, 0), ('P2', 2, 'accepted', 'n', '{}', 'push', 'x', 0, 0);`);
    db.close();

    const j = new Journal(path);
    try {
      const sql = (j.db.query("SELECT sql FROM sqlite_master WHERE name = 'versions'").get() as { sql: string }).sql;
      expect(sql).not.toContain("UNIQUE");
      expect(j.versionSource(1)).toBe("one");
      expect(j.get("P2")?.version).toBe(2);
      expect(j.inFlight().map((p) => p.id)).toEqual(["P1", "P2"]);
      // The same source again is a new version now; foreign keys still hold.
      expect(j.addVersion("h1", "one", "cli", "rollback to v1", { expect: 3, previous: 2 })).toBe(3);
      expect(() =>
        j.db.exec(
          "INSERT INTO packets (id, version, state, trigger, source, received_at, updated_at) VALUES ('P3', 99, 'accepted', 'push', 'x', 0, 0)",
        ),
      ).toThrow();
      expect(() => j.addVersion("h4", "four", "cli", null, { expect: 9, previous: 3 })).toThrow("not v9");
      expect(j.latestVersion()?.version).toBe(3);
    } finally {
      j.close();
    }
    new Journal(path).close();
  });

  test("history and diff read a stopped pipeline's journal, old ones included", async () => {
    const box = setup();
    const file = box.write("off.pipo", SRC("off", "one"));
    const { runner } = await open(box, file);
    await runner.applyVersion(SRC("off", "two"), { author: "test", reason: "two" });
    await runner.stop();
    const path = join(box.home, "pipelines", "off", "journal.db");
    const h = (await offlineRead(path, "versions", {}, "off")) as any;
    expect(h.result).toMatchObject({ current: null, latest: 2 });
    expect(h.result.versions[0]).toMatchObject({ version: 2, author: "test", reason: "two", pending: 0 });
    const d = (await offlineRead(path, "diff", { from: "v1", to: "2" }, "off")) as any;
    expect(d.result.diff).toContain("+  tag: { from: gate, transform: fn.two }");
    await expect(offlineRead(path, "version", { version: 7 }, "off")).rejects.toThrow("off has no version 7");

    // A journal from before D38 has no `reason` column.
    const old = join(box.root, "pre.db");
    const db = new Database(old, { create: true });
    db.exec(`CREATE TABLE versions (version INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'human', created_at INTEGER NOT NULL);
      CREATE TABLE packets (id TEXT PRIMARY KEY, version INTEGER, state TEXT, branch TEXT NOT NULL DEFAULT '');
      INSERT INTO versions VALUES (1, 'h', 'pipo: 1', 'human', 5);`);
    db.close();
    const legacy = (await offlineRead(old, "versions", {}, "pre")) as any;
    expect(legacy.result.versions).toEqual([
      {
        version: 1,
        hash: "h",
        author: "human",
        reason: null,
        author_kind: null,
        proposal: null,
        files: null,
        created_at: 5,
        pending: 0,
      },
    ]);
  });
});

describe("unified diff", () => {
  test("hunks with context, insertions and deletions at the edges, and identical texts", () => {
    const a = Array.from({ length: 12 }, (_, i) => `l${i + 1}`);
    const b = ["x", "l1", "l2", "L3", ...a.slice(3, 11)];
    const d = unifiedDiff(`${a.join("\n")}\n`, `${b.join("\n")}\n`, "p v1", "p v2");
    expect(d.diff).toBe(
      [
        "--- p v1",
        "+++ p v2",
        "@@ -1,6 +1,7 @@",
        "+x",
        " l1",
        " l2",
        "-l3",
        "+L3",
        " l4",
        " l5",
        " l6",
        "@@ -9,4 +10,3 @@",
        " l9",
        " l10",
        " l11",
        "-l12",
      ].join("\n"),
    );
    expect([d.added, d.removed]).toEqual([2, 2]);
    // Changes 2·context lines apart or closer share one hunk.
    expect(
      unifiedDiff("a\nb\nc\nd\ne\nf\ng\nh\n", "A\nb\nc\nd\ne\nf\ng\nH\n", "a", "b").diff.match(/@@/g),
    ).toHaveLength(2);
    expect(unifiedDiff("x\n", "y\n", "a", "b").diff).toBe("--- a\n+++ b\n@@ -1,1 +1,1 @@\n-x\n+y");
    expect(unifiedDiff("", "y\n", "a", "b").diff).toBe("--- a\n+++ b\n@@ -0,0 +1,1 @@\n+y");
    expect(unifiedDiff("same\n", "same\n", "a", "b")).toEqual({ diff: "", added: 0, removed: 0 });
  });
});
