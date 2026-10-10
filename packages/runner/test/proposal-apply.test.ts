// Applying a change proposal live (docs/spec.md §9.3 steps 4–5, D38, D45, D49), on the runner binary over its control
// socket: version N+1 and the proposal's `applied` state land in one transaction with the audit (author, author_kind,
// reason, proposal id, diff); in-flight packets finish on N; refusals (already applied, rejected, stale base,
// a check that fails now, draining) and what each leaves behind; rollback across a proposal's version and a restart;
// offline reads of a journal from before the audit columns. Kill-and-restart around the apply lives in
// proposal-apply-recovery.test.ts. Packets are held in flight by a `transform: http` step against a gate server.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ControlError, readRegistryEntry } from "../src";
import { sandbox, waitFor } from "./helpers";
import { gateServer, offlineRead } from "./proposal-helpers";
import { RustRunner } from "./rust";

// A runner start compiles through Bun, which can hang once in a while under WSL and is then retried (compile.rs).
setDefaultTimeout(60_000);

let cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const FNS = `export const one = (d) => ({ ...d, v: "one" });
export const two = (d) => ({ ...d, v: "two" });
export const three = (d) => ({ ...d, v: "three" });
`;

const POLICY = (verify = "") => `agent:
  control: true
  edit: [nodes.tag]
${verify ? `  verify: ${verify}\n` : ""}`;

async function setup(name: string, policy = POLICY()) {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  const gate = gateServer();
  cleanups.push(() => gate.stop());
  const SRC = (tag: string) => `pipo: 1
name: ${name}
fn: ./fns.ts
input: { via: push }
nodes:
  gate: { from: input, transform: http, with: { url: "${gate.url}" } }
  tag: { from: gate, transform: fn.${tag} }
output: { from: tag, to: file, with: { path: ./${name}.jsonl, format: jsonl } }
${policy}`;
  box.write("fns.ts", FNS);
  const file = box.write(`${name}.pipo`, SRC("one"));
  let r = await RustRunner.start(box, file, name, { listen: null });
  cleanups.push(() => (r.proc.exitCode === null ? r.kill() : undefined));
  const version = async () => (await r.request("hello")).version as number;
  /** A held proposal (`apply: false`): validated, or verified when the base sets agent.verify. */
  const propose = async (tag: string, o: { base?: number; kind?: "agent" | "human"; reason?: string } = {}) =>
    r.request("propose", {
      base_version: o.base ?? (await version()),
      source: SRC(tag),
      author: o.kind === "human" ? "cli" : "agent-ops",
      author_kind: o.kind ?? "agent",
      reason: o.reason ?? `use ${tag}`,
      apply: false,
    });
  const written = () => {
    const path = join(box.root, `${name}.jsonl`);
    return existsSync(path)
      ? Object.fromEntries(
          readFileSync(path, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { packet_id: string; data: any })
            .map((l) => [l.packet_id, l.data.v]),
        )
      : {};
  };
  return {
    box,
    file,
    gate,
    SRC,
    get r() {
      return r;
    },
    async restart() {
      expect(await r.stop()).toBe(0);
      r = await RustRunner.start(box, file, name, { listen: null });
    },
    version,
    propose,
    written,
  };
}

const err = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e) => e as ControlError,
  );

const pipelineEvents = (r: RustRunner) =>
  r
    .query<{ seq: number; type: string; detail: string | null }>(
      "SELECT seq, type, detail FROM events WHERE packet_id IS NULL ORDER BY seq",
    )
    .map((e) => ({ seq: e.seq, type: e.type, detail: e.detail === null ? null : JSON.parse(e.detail) }));
const latest = (r: RustRunner) => r.query<{ v: number }>("SELECT MAX(version) AS v FROM versions")[0]?.v;

describe("apply_proposal", () => {
  test("a validated proposal becomes v2 for new packets with its audit; in-flight packets finish on v1", async () => {
    const t = await setup("ap");
    const a = (await t.r.push({ n: 1, wait: true })).packet_id;
    await waitFor(() => t.gate.held() === 1, 5000, "packet a at the gate");
    const p = await t.propose("two", { reason: "tag them two" });
    expect(p.state).toBe("validated");

    const res = await t.r.request("apply_proposal", { id: p.id, by: "agent-ops" });
    expect(res).toEqual({ version: 2, previous: 1, changed: true, pending_older: 1, proposal: p.id });
    expect(await t.version()).toBe(2);
    expect(readRegistryEntry(t.box.home, "ap")?.version).toBe(2);
    await waitFor(
      () => t.r.lines().some((l) => l.includes(`applied v2 (proposal ${p.id}: tag them two, by agent-ops)`)),
      5000,
      "the apply's log line",
    );

    const b = (await t.r.push({ n: 2 })).packet_id;
    expect((await t.r.settled(b)).version).toBe(2);
    t.gate.release();
    expect((await t.r.settled(a)).version).toBe(1);
    await waitFor(() => Object.keys(t.written()).length === 2, 5000, "both written");
    expect(t.written()).toEqual({ [a]: "one", [b]: "two" });

    // The proposal and its version point at each other.
    expect(await t.r.request("proposal", { id: p.id })).toMatchObject({
      state: "applied",
      applied_version: 2,
      decided_by: "agent-ops",
    });
    const h = await t.r.request("versions");
    expect(h.versions[0]).toMatchObject({
      version: 2,
      author: "agent-ops",
      author_kind: "agent",
      reason: "tag them two",
      proposal: p.id,
    });
    expect(h.versions[1]).toMatchObject({ version: 1, author: "human", author_kind: "human", proposal: null });
    const v2 = await t.r.request("version", { version: "v2" });
    expect(v2.definition).toBe(p.source);
    expect(v2.diff).toContain("--- ap v1\n+++ ap v2\n");
    expect(v2.diff).toContain("-  tag: { from: gate, transform: fn.one }\n+  tag: { from: gate, transform: fn.two }");
    // The same hunks as the proposal's own diff (only the headers name it differently).
    const hunks = (d: string) => d.split("\n").slice(2).join("\n");
    expect(hunks(v2.diff)).toBe(hunks(p.diff));
    expect((await t.r.request("version", { version: 1 })).diff).toBeNull();

    // version.applied and proposal.applied are one transaction: adjacent events.
    const ev = pipelineEvents(t.r).filter((e) => e.type === "version.applied" || e.type.startsWith("proposal."));
    expect(ev.map((e) => e.type)).toEqual(["proposal.validated", "version.applied", "proposal.applied"]);
    expect(ev[2]?.seq).toBe((ev[1]?.seq as number) + 1);
    expect(ev[1]?.detail).toMatchObject({
      version: 2,
      previous: 1,
      author: "agent-ops",
      author_kind: "agent",
      reason: "tag them two",
      proposal: p.id,
    });
    expect(ev[2]?.detail).toEqual({ id: p.id, base_version: 1, by: "agent-ops", version: 2 });

    // Applying it again is refused and changes nothing.
    const again = await err(t.r.request("apply_proposal", { id: p.id }));
    expect(again).toMatchObject({ code: "invalid_state" });
    expect(again?.message).toContain("already applied, as v2");
    expect(again?.hint).toContain("pipo rollback ap");
    expect(latest(t.r)).toBe(2);
  });

  test("refusals: unknown id, rejected, stale base (which rejects it), a check that fails now (which doesn't)", async () => {
    const t = await setup("ref");
    expect(await err(t.r.request("apply_proposal", {}))).toMatchObject({ code: "bad_request" });
    expect(await err(t.r.request("apply_proposal", { id: "pr_nope" }))).toMatchObject({ code: "not_found" });

    // Rejected at propose time (an agent touching the output).
    const bad = await t.r.request("propose", {
      base_version: 1,
      source: t.SRC("one").replace("./ref.jsonl", "./other.jsonl"),
      author: "agent-ops",
      author_kind: "agent",
      reason: "elsewhere",
    });
    expect(bad.state).toBe("rejected");
    const r1 = await err(t.r.request("apply_proposal", { id: bad.id }));
    expect(r1).toMatchObject({ code: "invalid_state" });
    expect(r1?.message).toContain("was rejected");

    // Two proposals on v1: the first lands, the second's base is stale and it is rejected on the spot.
    const first = await t.propose("two");
    const second = await t.propose("three");
    expect((await t.r.request("apply_proposal", { id: first.id, by: "cli" })).version).toBe(2);
    const stale = await err(t.r.request("apply_proposal", { id: second.id, by: "cli" }));
    expect(stale).toMatchObject({ code: "invalid_state" });
    expect(stale?.message).toContain(`stale base: proposal ${second.id} is against v1, but ref is at v2 now`);
    expect(stale?.hint).toContain("propose the change against it");
    const marked = await t.r.request("proposal", { id: second.id });
    expect(marked).toMatchObject({ state: "rejected", decided_by: "cli" });
    expect(marked.decision).toContain("stale base");
    expect(latest(t.r)).toBe(2);

    // A proposal that passed at propose time but fails pipo check now (its fn export is gone): refused, still
    // validated, nothing stored; it applies once the module is fixed.
    const third = await t.propose("three", { kind: "human" });
    expect(third.state).toBe("validated");
    writeFileSync(join(t.box.root, "fns.ts"), FNS.replace(/export const three.*\n/, ""));
    const broken = await err(t.r.request("apply_proposal", { id: third.id }));
    expect(broken).toMatchObject({ code: "invalid_pipeline" });
    expect((await t.r.request("proposal", { id: third.id })).state).toBe("validated");
    expect(latest(t.r)).toBe(2);
    writeFileSync(join(t.box.root, "fns.ts"), FNS);
    expect(await t.r.request("apply_proposal", { id: third.id })).toMatchObject({ version: 3, proposal: third.id });
    expect(await t.r.request("proposal", { id: third.id })).toMatchObject({ state: "applied", applied_version: 3 });
    const h = await t.r.request("versions");
    expect(h.versions[0]).toMatchObject({ author: "cli", author_kind: "human", proposal: third.id });
  });

  test("agent.verify: a held agent proposal is dry-run before it is stored as verified, then applies as is", async () => {
    const t = await setup("vf", POLICY("last 5"));
    const a = (await t.r.push({ n: 1 })).packet_id;
    await t.r.settled(a);
    const p = await t.propose("two");
    expect(p).toMatchObject({ state: "verified", verify: "last 5" });
    expect(await t.r.request("apply_proposal", { id: p.id, by: "agent-ops" })).toMatchObject({ version: 2 });
    const applied = await t.r.request("proposal", { id: p.id });
    expect(applied).toMatchObject({ state: "applied", applied_version: 2, decided_by: "agent-ops" });
    expect(applied.verification).toMatchObject({ replayed: 1, diverged: 0 });
    const kinds = pipelineEvents(t.r)
      .map((e) => e.type)
      .filter((k) => k.startsWith("proposal."));
    expect(kinds).toEqual(["proposal.validated", "proposal.verified", "proposal.applied"]);
  });

  test("refused while draining; nothing is written", async () => {
    const t = await setup("dr");
    const p = await t.propose("two");
    const a = (await t.r.push({ n: 1, wait: true })).packet_id;
    await waitFor(() => t.gate.held() === 1, 5000, "packet a at the gate");
    await t.r.request("drain");
    const e = await err(t.r.request("apply_proposal", { id: p.id }));
    expect(e).toMatchObject({ code: "invalid_state" });
    expect(e?.message).toContain("pipeline is draining");
    expect((await t.r.request("proposal", { id: p.id })).state).toBe("validated");
    t.gate.release();
    expect(await t.r.proc.exited).toBe(0);
    expect(t.r.packet(a)?.state).toBe("delivered");
    expect(latest(t.r)).toBe(1);
  });
});

describe("rollback after a proposal", () => {
  test("restores the earlier version as a new one, and the proposal's version again; both outlive a restart", async () => {
    const t = await setup("rbp");
    const p = await t.propose("two");
    await t.r.request("apply_proposal", { id: p.id, by: "agent-ops" });

    const rb = await t.r.request("rollback", { version: 1, by: "cli" });
    expect(rb).toMatchObject({ version: 3, previous: 2, changed: true, rolled_back_to: 1 });
    const a = (await t.r.push({ n: 1 })).packet_id;
    expect((await t.r.settled(a)).version).toBe(3);
    expect(t.written()[a]).toBe("one");
    const h = await t.r.request("versions");
    expect(h.versions[0]).toMatchObject({
      version: 3,
      author: "cli",
      reason: "rollback to v1",
      author_kind: null,
      proposal: null,
    });
    expect((await t.r.request("version", { version: 3 })).definition).toBe(t.SRC("one"));
    // The proposal stays applied (as v2): a rollback is a new version, not an undo of the record.
    expect(await t.r.request("proposal", { id: p.id })).toMatchObject({ state: "applied", applied_version: 2 });

    // Rolling forward to the proposal's version is a rollback like any other.
    expect(await t.r.request("rollback", { version: 2, by: "cli" })).toMatchObject({
      version: 4,
      rolled_back_to: 2,
    });
    expect((await t.r.request("version", { version: 4 })).definition).toBe(p.source);

    // The file is unchanged since the start, so the restart keeps v4 (D38).
    await t.restart();
    expect(await t.version()).toBe(4);
    const b = (await t.r.push({ n: 2 })).packet_id;
    expect((await t.r.settled(b)).version).toBe(4);
    await waitFor(() => t.written()[b], 5000, "b written");
    expect(t.written()[b]).toBe("two");
  });
});

describe("journal", () => {
  test("a journal from before D49 reads offline with author_kind and proposal as null", async () => {
    const box = sandbox();
    cleanups.push(() => box.cleanup());
    mkdirSync(join(box.home, "pipelines", "old"), { recursive: true });
    const path = join(box.home, "pipelines", "old", "journal.db");
    const db = new Database(path, { create: true });
    db.exec(`CREATE TABLE versions (version INTEGER PRIMARY KEY, hash TEXT NOT NULL, source TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'human', reason TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE packets (id TEXT PRIMARY KEY, version INTEGER NOT NULL REFERENCES versions(version),
        state TEXT NOT NULL, cursor TEXT, data TEXT, trigger TEXT NOT NULL, source TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0, iteration INTEGER NOT NULL DEFAULT 0, hops INTEGER NOT NULL DEFAULT 0,
        error TEXT, result TEXT, received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        branch TEXT NOT NULL DEFAULT '');
      INSERT INTO versions VALUES (1, 'h1', 'one\n', 'human', 'first start', 0), (2, 'h2', 'two\n', 'cli', 'x', 1);`);
    db.close();

    // Read-only, unmigrated: the audit reads as null.
    const before = await offlineRead(box, "old", "versions");
    expect(before.code).toBe(0);
    expect(before.value.result.versions[0]).toMatchObject({ version: 2, author_kind: null, proposal: null });
    const v2 = await offlineRead(box, "old", "version", { version: 2 });
    expect(v2.value.result.diff).toBe("--- old v1\n+++ old v2\n@@ -1,1 +1,1 @@\n-one\n+two");
    // The read left the journal as it was.
    const after = new Database(path, { readonly: true });
    try {
      const cols = (after.query("PRAGMA table_info(versions)").all() as { name: string }[]).map((c) => c.name);
      expect(cols).not.toContain("author_kind");
    } finally {
      after.close();
    }
  });
});
