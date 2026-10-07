// Applying a change proposal live (docs/spec.md §9.3 steps 4–5, D38, D45, D49), in-process over the control socket:
// version N+1 and the proposal's `applied` state land in one transaction with the audit (author, author_kind, reason,
// proposal id, diff); in-flight packets finish on N; refusals (already applied, rejected, stale base,
// a check that fails now) and what each leaves behind; rollback across a proposal's version; the audit columns'
// migration. Kill-and-restart around the apply lives in proposal-apply-recovery.test.ts.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, type ControlError, Journal, offlineRead, Runner, readRegistryEntry } from "../src";
import { sandbox, settled, waitFor } from "./helpers";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
  (globalThis as any).__pipoApplyGate = undefined;
});

const FNS = `export const gate = async (d) => { const g = globalThis.__pipoApplyGate; if (g && d.wait) await g; return d; };
export const one = (d) => ({ ...d, v: "one" });
export const two = (d) => ({ ...d, v: "two" });
export const three = (d) => ({ ...d, v: "three" });
`;

const POLICY = (verify = "") => `agent:
  control: true
  edit: [nodes.tag]
${verify ? `  verify: ${verify}\n` : ""}`;

const SRC = (name: string, tag: string, policy = POLICY()) => `pipo: 1
name: ${name}
fn: ./fns.ts
input: { via: push }
nodes:
  gate: { from: input, transform: fn.gate }
  tag: { from: gate, transform: fn.${tag} }
output: { from: tag, to: file, with: { path: ./${name}.jsonl, format: jsonl } }
${policy}`;

async function setup(name: string, policy = POLICY()) {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  box.write("fns.ts", FNS);
  const file = box.write(`${name}.pipo`, SRC(name, "one", policy));
  const lines: string[] = [];
  const runner = await Runner.open({ file, home: box.home, log: (l) => lines.push(l) });
  await runner.start();
  cleanups.push(() => (runner.state === "stopped" || runner.state === "failed" ? undefined : runner.stop()));
  const c = await ControlClient.forPipeline(box.home, name);
  cleanups.push(() => c.close());
  const propose = (tag: string, o: { base?: number; kind?: "agent" | "human"; reason?: string } = {}) =>
    runner.proposals.propose({
      base_version: o.base ?? runner.version,
      source: SRC(name, tag, policy),
      author: o.kind === "human" ? "cli" : "agent-ops",
      author_kind: o.kind ?? "agent",
      reason: o.reason ?? `use ${tag}`,
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
  return { box, file, runner, c, lines, propose, written };
}

function gate() {
  let open!: () => void;
  (globalThis as any).__pipoApplyGate = new Promise<void>((r) => {
    open = r;
  });
  return open;
}

const err = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e) => e as ControlError,
  );

const pipelineEvents = (j: Journal) =>
  (
    j.db.query("SELECT seq, type, detail FROM events WHERE packet_id IS NULL ORDER BY seq").all() as {
      seq: number;
      type: string;
      detail: string | null;
    }[]
  ).map((e) => ({ seq: e.seq, type: e.type, detail: e.detail === null ? null : JSON.parse(e.detail) }));

describe("apply_proposal", () => {
  test("a validated proposal becomes v2 for new packets with its audit; in-flight packets finish on v1", async () => {
    const t = await setup("ap");
    const release = gate();
    const a = (await t.c.request("push", { data: { n: 1, wait: true } })).packet_id;
    await waitFor(() => t.runner.journal.get(a)?.cursor === "gate", 5000, "packet a at the gate");
    const p = t.propose("two", { reason: "tag them two" });
    expect(p.state).toBe("validated");

    const res = await t.c.request("apply_proposal", { id: p.id, by: "agent-ops" });
    expect(res).toEqual({ version: 2, previous: 1, changed: true, pending_older: 1, proposal: p.id });
    expect(t.runner.version).toBe(2);
    expect((await t.c.request("hello")).version).toBe(2);
    expect(readRegistryEntry(t.box.home, "ap")?.version).toBe(2);
    expect(t.lines.some((l) => l.includes(`applied v2 (proposal ${p.id}: tag them two, by agent-ops)`))).toBe(true);

    const b = (await t.c.request("push", { data: { n: 2 } })).packet_id;
    expect((await settled(t.runner, b)).version).toBe(2);
    release();
    expect((await settled(t.runner, a)).version).toBe(1);
    expect(t.written()).toEqual({ [a]: "one", [b]: "two" });

    // The proposal and its version point at each other.
    expect(t.runner.proposals.get(p.id)).toMatchObject({
      state: "applied",
      applied_version: 2,
      decided_by: "agent-ops",
    });
    const h = await t.c.request("versions");
    expect(h.versions[0]).toMatchObject({
      version: 2,
      author: "agent-ops",
      author_kind: "agent",
      reason: "tag them two",
      proposal: p.id,
    });
    expect(h.versions[1]).toMatchObject({ version: 1, author: "human", author_kind: "human", proposal: null });
    const v2 = await t.c.request("version", { version: "v2" });
    expect(v2.definition).toBe(p.source);
    expect(v2.diff).toContain("--- ap v1\n+++ ap v2\n");
    expect(v2.diff).toContain("-  tag: { from: gate, transform: fn.one }\n+  tag: { from: gate, transform: fn.two }");
    // The same hunks as the proposal's own diff (only the headers name it differently).
    const hunks = (d: string) => d.split("\n").slice(2).join("\n");
    expect(hunks(v2.diff)).toBe(hunks(p.diff));
    expect((await t.c.request("version", { version: 1 })).diff).toBeNull();

    // version.applied and proposal.applied are one transaction: adjacent events.
    const ev = pipelineEvents(t.runner.journal).filter(
      (e) => e.type === "version.applied" || e.type.startsWith("proposal."),
    );
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
    const again = await err(t.c.request("apply_proposal", { id: p.id }));
    expect(again).toMatchObject({ code: "invalid_state" });
    expect(again?.message).toContain("already applied, as v2");
    expect(again?.hint).toContain("pipo rollback ap");
    expect(t.runner.journal.latestVersion()?.version).toBe(2);
  });

  test("refusals: unknown id, rejected, stale base (which rejects it), a check that fails now (which doesn't)", async () => {
    const t = await setup("ref");
    expect(await err(t.c.request("apply_proposal", {}))).toMatchObject({ code: "bad_request" });
    expect(await err(t.c.request("apply_proposal", { id: "pr_nope" }))).toMatchObject({ code: "not_found" });

    // Rejected at propose time (an agent touching the output).
    const bad = t.runner.proposals.propose({
      base_version: 1,
      source: SRC("ref", "one").replace("./ref.jsonl", "./other.jsonl"),
      author: "agent-ops",
      author_kind: "agent",
      reason: "elsewhere",
    });
    expect(bad.state).toBe("rejected");
    const r1 = await err(t.c.request("apply_proposal", { id: bad.id }));
    expect(r1).toMatchObject({ code: "invalid_state" });
    expect(r1?.message).toContain("was rejected");

    // Two proposals on v1: the first lands, the second's base is stale and it is rejected on the spot.
    const first = t.propose("two");
    const second = t.propose("three");
    expect((await t.c.request("apply_proposal", { id: first.id, by: "cli" })).version).toBe(2);
    const stale = await err(t.c.request("apply_proposal", { id: second.id, by: "cli" }));
    expect(stale).toMatchObject({ code: "invalid_state" });
    expect(stale?.message).toContain(`stale base: proposal ${second.id} is against v1, but ref is at v2 now`);
    expect(stale?.hint).toContain("propose the change against it");
    expect(t.runner.proposals.get(second.id)).toMatchObject({ state: "rejected", decided_by: "cli" });
    expect(t.runner.proposals.get(second.id).decision).toContain("stale base");
    expect(t.runner.journal.latestVersion()?.version).toBe(2);

    // A proposal that passed at propose time but fails pipo check now (its fn export is gone): refused, still
    // validated, nothing stored; it applies once the module is fixed.
    const third = t.propose("three", { kind: "human" });
    writeFileSync(join(t.box.root, "fns.ts"), FNS.replace(/export const three.*\n/, ""));
    const broken = await err(t.c.request("apply_proposal", { id: third.id }));
    expect(broken).toMatchObject({ code: "invalid_pipeline" });
    expect(t.runner.proposals.get(third.id).state).toBe("validated");
    expect(t.runner.journal.latestVersion()?.version).toBe(2);
    writeFileSync(join(t.box.root, "fns.ts"), FNS);
    expect(await t.c.request("apply_proposal", { id: third.id })).toMatchObject({ version: 3, proposal: third.id });
    expect(t.runner.proposals.get(third.id)).toMatchObject({ state: "applied", applied_version: 3 });
    const h = await t.c.request("versions");
    expect(h.versions[0]).toMatchObject({ author: "cli", author_kind: "human", proposal: third.id });
  });

  test("agent.verify: a validated proposal is dry-run by apply_proposal first; a verified one applies as is", async () => {
    const t = await setup("vf", POLICY("last 5"));
    const a = (await t.c.request("push", { data: { n: 1 } })).packet_id;
    await settled(t.runner, a);
    const p = t.propose("two");
    expect(p).toMatchObject({ state: "validated", verify: "last 5" });
    expect(await t.c.request("apply_proposal", { id: p.id, by: "agent-ops" })).toMatchObject({ version: 2 });
    expect(t.runner.proposals.get(p.id)).toMatchObject({
      state: "applied",
      applied_version: 2,
      decided_by: "agent-ops",
    });
    expect(t.runner.proposals.get(p.id).verification).toMatchObject({ replayed: 1, diverged: 0 });

    const q = t.propose("three");
    expect((await t.runner.proposals.dryRun(q.id)).state).toBe("verified");
    expect(await t.c.request("apply_proposal", { id: q.id, by: "agent-ops" })).toMatchObject({ version: 3 });
    expect(t.runner.proposals.get(q.id)).toMatchObject({ state: "applied", applied_version: 3 });
  });

  test("refused while draining; nothing is written", async () => {
    const t = await setup("dr");
    const p = t.propose("two");
    const release = gate();
    const a = (await t.c.request("push", { data: { n: 1, wait: true } })).packet_id;
    await waitFor(() => t.runner.journal.get(a)?.cursor === "gate", 5000, "packet a at the gate");
    await t.c.request("drain");
    const e = await err(t.c.request("apply_proposal", { id: p.id }));
    expect(e).toMatchObject({ code: "invalid_state" });
    expect(e?.message).toContain("pipeline is draining");
    expect(t.runner.proposals.get(p.id).state).toBe("validated");
    release();
    await t.runner.finished;
  });
});

describe("rollback after a proposal", () => {
  test("restores the earlier version as a new one, and the proposal's version again; both outlive a restart", async () => {
    const t = await setup("rbp");
    const p = t.propose("two");
    await t.c.request("apply_proposal", { id: p.id, by: "agent-ops" });

    const rb = await t.c.request("rollback", { version: 1, by: "cli" });
    expect(rb).toMatchObject({ version: 3, previous: 2, changed: true, rolled_back_to: 1 });
    const a = (await t.c.request("push", { data: { n: 1 } })).packet_id;
    expect((await settled(t.runner, a)).version).toBe(3);
    expect(t.written()[a]).toBe("one");
    const h = await t.c.request("versions");
    expect(h.versions[0]).toMatchObject({
      version: 3,
      author: "cli",
      reason: "rollback to v1",
      author_kind: null,
      proposal: null,
    });
    expect((await t.c.request("version", { version: 3 })).definition).toBe(SRC("rbp", "one"));
    // The proposal stays applied (as v2): a rollback is a new version, not an undo of the record.
    expect(t.runner.proposals.get(p.id)).toMatchObject({ state: "applied", applied_version: 2 });

    // Rolling forward to the proposal's version is a rollback like any other.
    expect(await t.c.request("rollback", { version: 2, by: "cli" })).toMatchObject({ version: 4, rolled_back_to: 2 });
    expect((await t.c.request("version", { version: 4 })).definition).toBe(p.source);

    // The file is unchanged since the start, so the restart keeps v4 (D38).
    t.c.close();
    await t.runner.stop();
    const again = await Runner.open({ file: t.file, home: t.box.home, log: () => {} });
    await again.start();
    cleanups.push(() => (again.state === "stopped" ? undefined : again.stop()));
    expect(again.version).toBe(4);
    const b = await again.intake({ n: 2 }, { trigger: "push", source: "test" });
    if (b.status !== "accepted") throw new Error(JSON.stringify(b));
    expect((await settled(again, b.packet_id)).version).toBe(4);
    expect(t.written()[b.packet_id]).toBe("two");
  });
});

describe("journal", () => {
  test("a journal from before D49 gains author_kind and proposal (null for old versions); offline reads cope", async () => {
    const box = sandbox();
    cleanups.push(() => box.cleanup());
    mkdirSync(join(box.root, "old"));
    const path = join(box.root, "old", "journal.db");
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
    const before = (await offlineRead(path, "versions", {}, "old")) as any;
    expect(before.result.versions[0]).toMatchObject({ version: 2, author_kind: null, proposal: null });
    const v2 = (await offlineRead(path, "version", { version: 2 }, "old")) as any;
    expect(v2.result.diff).toBe("--- old v1\n+++ old v2\n@@ -1,1 +1,1 @@\n-one\n+two");

    const j = new Journal(path);
    try {
      const cols = (j.db.query("PRAGMA table_info(versions)").all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain("author_kind");
      expect(cols).toContain("proposal");
      expect(j.db.query("SELECT author_kind, proposal FROM versions WHERE version = 1").get()).toEqual({
        author_kind: null,
        proposal: null,
      });
      expect(
        j.addVersion(
          "h3",
          "three",
          "agent-ops",
          "r",
          { expect: 3, previous: 2 },
          { author_kind: "agent", proposal: "pr_x" },
        ),
      ).toBe(3);
    } finally {
      j.close();
    }
    // Opening again migrates nothing twice.
    new Journal(path).close();
  });
});
