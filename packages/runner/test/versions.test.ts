// Versions, rollback and restart semantics (docs/spec.md §7.3, §9.3, D38), against the Rust runner: a rollback stores
// the earlier source as a new version that only new packets use while an in-flight packet finishes on its pinned
// version; a start runs the file only when it changed since the last start; history, version and diff reads, over the
// socket and from a stopped pipeline's journal. Kill-and-restart lives in versions-recovery.test.ts. Journal
// migrations and the unified diff itself are Rust tests (crates/pipo-runner/tests/journal.rs, tests/reads.rs).
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ControlError, readRegistryEntry } from "../src";
import { gateNode, offlineRead } from "./control-helpers";
import { sandbox, waitFor } from "./helpers";
import { RustRunner } from "./rust";

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
    `export const one = (d) => ({ ...d, v: "one" });
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
  gate: ${gateNode("input")}
  tag: { from: gate, transform: fn.${tag} }
output: { from: tag, to: file, with: { path: ./${name}.jsonl, format: jsonl } }
${extra}`;

async function open(box: ReturnType<typeof setup>, file: string, name: string) {
  const r = await RustRunner.start(box, file, name, { listen: null });
  cleanups.push(() => {
    // A gated exec program outlives a SIGKILLed runner: let it end.
    writeFileSync(join(box.root, "release"), "");
    return r.proc.exitCode === null ? r.kill() : undefined;
  });
  return r;
}

const release = (box: { root: string }) => writeFileSync(join(box.root, "release"), "");

const written = (box: { root: string }, name: string) => {
  const path = join(box.root, `${name}.jsonl`);
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { packet_id: string; data: any })
    : [];
};

const err = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e) => e as ControlError,
  );

const latest = (r: RustRunner) => r.query<{ v: number }>("SELECT MAX(version) AS v FROM versions")[0]?.v;

describe("rollback", () => {
  test("stores a new version that new packets use; an in-flight packet finishes on its pinned version", async () => {
    const box = setup();
    const file = box.write("rb.pipo", SRC("rb", "one"));
    const r = await open(box, file, "rb");
    const c = r.client;
    expect((await c.request("hello")).version).toBe(1);

    // v2 via `apply`; a packet accepted on v2 waits at the gate, in flight.
    const applied = await c.request("apply", { source: SRC("rb", "two"), by: "test", reason: "try two" });
    expect(applied).toMatchObject({ version: 2, previous: 1, changed: true, pending_older: 0 });
    const a = (await c.request("push", { data: { n: 1, wait: true } })).packet_id;
    await waitFor(() => r.packet(a)?.cursor === "gate", 5000, "packet a at the gate");

    const rb = await c.request("rollback", { version: "v1" });
    expect(rb).toMatchObject({ version: 3, previous: 2, changed: true, pending_older: 1, rolled_back_to: 1 });
    expect((await c.request("hello")).version).toBe(3);
    expect(readRegistryEntry(box.home, "rb")?.version).toBe(3);

    const b = (await c.request("push", { data: { n: 2 } })).packet_id;
    expect((await r.settled(b)).version).toBe(3);
    expect(r.packet(a)?.state).not.toBe("delivered");
    release(box);
    expect((await r.settled(a, 10_000)).version).toBe(2);
    const out = Object.fromEntries(written(box, "rb").map((l) => [l.packet_id, l.data.v]));
    expect(out).toEqual({ [a]: "two", [b]: "one" });

    const v = r.query("SELECT version, hash, author, reason FROM versions ORDER BY version");
    expect(v.map((x) => [x.version, x.author, x.reason])).toEqual([
      [1, "human", "first start"],
      [2, "test", "try two"],
      [3, "control", "rollback to v1"],
    ]);
    expect(v[2].hash).toBe(v[0].hash);
    const events = r.query<{ detail: string }>("SELECT detail FROM events WHERE type = 'version.applied' ORDER BY seq");
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
    const r = await open(box, file, "ref");
    const c = r.client;

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
    expect(latest(r)).toBe(1);
    expect((await c.request("hello")).version).toBe(1);

    // A draining pipeline takes no new packets, so it takes no new version either.
    const r2 = await c.request("apply", { source: SRC("ref", "two") });
    expect(r2.version).toBe(2);
    const held = (await c.request("push", { data: { n: 1, wait: true } })).packet_id;
    await waitFor(() => r.packet(held)?.cursor === "gate", 5000, "packet at the gate");
    expect(await c.request("drain")).toMatchObject({ state: "draining" });
    const draining = await err(c.request("rollback", { version: 1 }));
    expect(draining?.code).toBe("invalid_state");
    expect(draining?.message).toContain("draining");
    expect(latest(r)).toBe(2);
    release(box);
    expect(await r.proc.exited).toBe(0);
    expect(r.packet(held)?.state).toBe("delivered");
  });
});

describe("restart (D38)", () => {
  test("the latest version stays across a restart unless the file changed since the last start", async () => {
    const box = setup();
    const file = box.write("rs.pipo", SRC("rs", "one"));
    let r = await open(box, file, "rs");
    await r.request("apply", { source: SRC("rs", "two"), by: "test", reason: "two" });
    expect((await r.request("hello")).version).toBe(2);
    expect(await r.stop()).toBe(0);

    // File unchanged since the last start: v2 (applied) stays, and new packets use it.
    r = await open(box, file, "rs");
    expect((await r.request("hello")).version).toBe(2);
    const [started] = r.query<{ detail: string }>(
      "SELECT detail FROM events WHERE type = 'pipeline.started' ORDER BY seq DESC LIMIT 1",
    );
    expect(JSON.parse(started?.detail ?? "{}")).toMatchObject({ version: 2 });
    const p1 = (await r.push({ n: 1 })).packet_id;
    await r.settled(p1);
    expect(written(box, "rs").find((l) => l.packet_id === p1)?.data.v).toBe("two");
    expect(await r.stop()).toBe(0);

    // The file changed: it wins, as a new version.
    writeFileSync(file, SRC("rs", "one", "description: edited"));
    r = await open(box, file, "rs");
    expect((await r.request("hello")).version).toBe(3);
    await r.request("apply", { source: SRC("rs", "two"), by: "test", reason: "two again" });
    expect(await r.stop()).toBe(0);
    r = await open(box, file, "rs");
    expect((await r.request("hello")).version).toBe(4);
    expect(await r.stop()).toBe(0);

    // A changed file whose content equals the latest version adds nothing.
    writeFileSync(file, SRC("rs", "two"));
    r = await open(box, file, "rs");
    expect((await r.request("hello")).version).toBe(4);
    expect(r.query("SELECT version, author, reason FROM versions ORDER BY version")).toEqual([
      { version: 1, author: "human", reason: "first start" },
      { version: 2, author: "test", reason: "two" },
      { version: 3, author: "human", reason: "file changed" },
      { version: 4, author: "test", reason: "two again" },
    ]);
  });

  test("a journal version that no longer passes check refuses the start and says how to get the file back", async () => {
    const box = setup();
    const file = box.write("bad.pipo", SRC("bad", "one"));
    const r = await open(box, file, "bad");
    await r.request("apply", { source: SRC("bad", "two"), by: "test", reason: "two" });
    expect(await r.stop()).toBe(0);
    // fn.two disappears: v2 (the latest, which a start with the unchanged file runs) now fails P012.
    writeFileSync(join(box.root, "fns.ts"), "export const one = (d) => d;\n");
    const refused = await RustRunner.refuse(box, file);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("v2 of the pipeline");
    expect(refused.stderr).toContain("edit the file to run it instead");
    expect(refused.stderr).toContain("P012");
  });
});

describe("reads without a runner", () => {
  test("history, version and diff read a stopped pipeline's journal", async () => {
    const box = setup();
    const file = box.write("off.pipo", SRC("off", "one"));
    const r = await open(box, file, "off");
    await r.request("apply", { source: SRC("off", "two"), by: "test", reason: "two" });
    expect(await r.stop()).toBe(0);
    const h = (await offlineRead(box, "off", "versions")).out;
    expect(h.result).toMatchObject({ current: null, latest: 2 });
    expect(h.result.versions[0]).toMatchObject({ version: 2, author: "test", reason: "two", pending: 0 });
    const d = (await offlineRead(box, "off", "diff", { from: "v1", to: "2" })).out;
    expect(d.result.diff).toContain("+  tag: { from: gate, transform: fn.two }");
    const v = (await offlineRead(box, "off", "version", { version: 2 })).out;
    expect(v.result.definition).toBe(SRC("off", "two"));
    const missing = await offlineRead(box, "off", "version", { version: 7 });
    expect(missing.code).toBe(1);
    expect(missing.out.error.message).toContain("off has no version 7");
  });
});
