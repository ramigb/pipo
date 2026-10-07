// `apply_proposal` on a proposal that still needs its dry run (docs/spec.md §9.3, D48, D49, D51), in-process over the
// control socket: an agent's proposal left `validated` with `agent.verify` set (held before its dry run, or stranded by
// a dry run that crashed or threw) is dry-run first on the path `propose` uses, then applied in one transaction; a
// diverging dry run stores it `rejected` and that is the reply, not an error. A stale base is rejected before any dry
// run; a second apply while one dry run runs is refused with a hint that names a command. The SIGKILL version lives in
// proposal-dryrun-recovery.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, type ControlError, Runner } from "../src";
import { sandbox, settled, waitFor } from "./helpers";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
  (globalThis as any).__pipoApplyDryGate = undefined;
  (globalThis as any).__pipoApplyDryCalls = undefined;
});

const FNS = `export const one = (d) => ({ ...d, v: "one" });
export const two = (d) => ({ ...d, v: "two" });
export const strict = (d) => { if (d.n >= 2) throw new Error("n too big"); return { ...d, v: "strict" }; };
export const gated = async (d) => {
  globalThis.__pipoApplyDryCalls = (globalThis.__pipoApplyDryCalls ?? 0) + 1;
  if (globalThis.__pipoApplyDryGate) await globalThis.__pipoApplyDryGate;
  return { ...d, v: "gated" };
};
`;

const SRC = (tag: string) => `pipo: 1
name: pad
fn: ./fns.ts
input: { via: push }
nodes:
  tag: { from: input, transform: fn.${tag} }
output: { from: tag, to: file, with: { path: ./pad.jsonl, format: jsonl } }
agent:
  control: true
  edit: [nodes.tag]
  verify: last 5
`;

async function setup() {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  box.write("fns.ts", FNS);
  const file = box.write("pad.pipo", SRC("one"));
  const runner = await Runner.open({ file, home: box.home, log: () => {} });
  await runner.start();
  cleanups.push(() => (runner.state === "stopped" || runner.state === "failed" ? undefined : runner.stop()));
  const c = await ControlClient.forPipeline(box.home, "pad");
  cleanups.push(() => c.close());
  for (const n of [0, 1, 2]) {
    const r = await runner.intake({ n }, { trigger: "push", source: "test" });
    if (r.status !== "accepted") throw new Error(JSON.stringify(r));
    expect((await settled(runner, r.packet_id)).state).toBe("delivered");
  }
  const out = join(box.root, "pad.jsonl");
  const lines = () => (existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).length : 0);
  // An agent's proposal stored `validated` with its dry run not yet run: what a crash between `propose`'s store and
  // its dry run's outcome leaves behind.
  const stranded = (tag: string) => {
    const p = runner.proposals.propose({
      base_version: runner.version,
      source: SRC(tag),
      author: "agent-ops",
      author_kind: "agent",
      reason: `use ${tag}`,
    });
    expect(p).toMatchObject({ state: "validated", verify: "last 5", verification: null });
    return p;
  };
  const events = () =>
    (runner.journal.db.query("SELECT type FROM events WHERE type LIKE 'proposal.%' ORDER BY seq").all() as any[]).map(
      (e) => e.type as string,
    );
  const versions = () =>
    (runner.journal.db.query("SELECT version, proposal FROM versions ORDER BY version").all() as any[]).map((v) => [
      v.version,
      v.proposal,
    ]);
  return { box, runner, c, stranded, events, versions, lines };
}

const err = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e) => e as ControlError,
  );

describe("apply_proposal runs a missing dry run first", () => {
  test("a stranded validated proposal is dry-run, verified and applied as v2 in one call", async () => {
    const t = await setup();
    const p = t.stranded("two");
    const reply = await t.c.request("apply_proposal", { id: p.id, by: "agent-ops" });
    expect(reply).toMatchObject({ version: 2, previous: 1, changed: true, proposal: p.id });
    expect(t.runner.version).toBe(2);
    const after = await t.c.request("proposal", { id: p.id });
    expect(after).toMatchObject({ state: "applied", applied_version: 2, decided_by: "agent-ops" });
    expect(after.verification).toMatchObject({ replayed: 3, passed: 3, diverged: 0 });
    expect(after.decision).toContain("dry run passed");
    expect(t.events()).toEqual(["proposal.validated", "proposal.verified", "proposal.applied"]);
    expect(t.versions()).toEqual([
      [1, null],
      [2, p.id],
    ]);
    // The dry run wrote nothing to the output.
    expect(t.lines()).toBe(3);
  });

  test("a diverging dry run rejects it: the reply is the rejected proposal, not an error, and nothing is applied", async () => {
    const t = await setup();
    const p = t.stranded("strict");
    const reply = await t.c.request("apply_proposal", { id: p.id, by: "agent-ops" });
    expect(reply).toMatchObject({ id: p.id, state: "rejected", applied_version: null, decided_by: "dry-run" });
    expect(reply.decision).toContain("dry run diverged");
    expect(reply.verification).toMatchObject({ replayed: 3, diverged: 1 });
    expect(reply.version).toBeUndefined();
    expect(t.runner.version).toBe(1);
    expect(t.versions()).toEqual([[1, null]]);
    expect(t.events()).toEqual(["proposal.validated", "proposal.rejected"]);
    const again = await err(t.c.request("apply_proposal", { id: p.id, by: "agent-ops" }));
    expect(again).toMatchObject({ code: "invalid_state" });
    expect(again?.message).toContain("was rejected (dry run diverged");
    expect(t.lines()).toBe(3);
  });

  test("propose's dry run throwing leaves it validated; apply_proposal through the op then recovers it", async () => {
    const t = await setup();
    const store = t.runner.proposals;
    const real = store.dryRun.bind(store);
    store.dryRun = async () => {
      throw new Error("disk went away mid dry run");
    };
    const failed = await err(
      t.c.request("propose", {
        source: SRC("two"),
        base_version: 1,
        reason: "use two",
        author: "agent-ops",
        author_kind: "agent",
      }),
    );
    expect(failed?.message).toContain("disk went away");
    store.dryRun = real;
    const stuck = (await t.c.request("proposals", { state: "validated" })).proposals;
    expect(stuck.map((x: any) => x.verify)).toEqual(["last 5"]);
    expect(await t.c.request("apply_proposal", { id: stuck[0].id, by: "ada" })).toMatchObject({
      version: 2,
      proposal: stuck[0].id,
    });
    expect((await t.c.request("proposal", { id: stuck[0].id })).state).toBe("applied");
    expect(t.versions().length).toBe(2);
  });

  test("a stale base is rejected before any dry run runs", async () => {
    const t = await setup();
    const p = t.stranded("two");
    expect(await t.c.request("apply", { source: SRC("strict"), reason: "human edit", by: "ada" })).toMatchObject({
      version: 2,
    });
    const stale = await err(t.c.request("apply_proposal", { id: p.id, by: "agent-ops" }));
    expect(stale).toMatchObject({ code: "invalid_state" });
    expect(stale?.message).toContain("stale base");
    const after = t.runner.proposals.get(p.id);
    expect(after).toMatchObject({ state: "rejected", verification: null });
    expect(after.decision).toContain("stale base");
    expect(t.events()).toEqual(["proposal.validated", "proposal.rejected"]);
  });

  test("a second apply while the dry run runs is refused with a command to follow; the first applies", async () => {
    const t = await setup();
    const p = t.stranded("gated");
    let open!: () => void;
    (globalThis as any).__pipoApplyDryGate = new Promise<void>((r) => {
      open = r;
    });
    (globalThis as any).__pipoApplyDryCalls = 0;
    const first = t.c.request("apply_proposal", { id: p.id, by: "agent-ops" });
    await waitFor(() => (globalThis as any).__pipoApplyDryCalls >= 1, 5000, "the dry run to reach the gated fn");
    expect(t.runner.proposals.get(p.id).state).toBe("validated");
    // Another connection: one connection's requests are answered in order.
    const other = await ControlClient.forPipeline(t.box.home, "pad");
    cleanups.push(() => other.close());
    const second = await err(other.request("apply_proposal", { id: p.id, by: "ada" }));
    expect(second).toMatchObject({ code: "invalid_state" });
    expect(second?.message).toContain("already running");
    expect(second?.hint).toContain(`pipo proposals pad show ${p.id}`);
    open();
    expect(await first).toMatchObject({ version: 2, proposal: p.id });
    expect(t.versions().length).toBe(2);
    expect(t.events()).toEqual(["proposal.validated", "proposal.verified", "proposal.applied"]);
  });

  test("refusal hints name a command a user can run", async () => {
    const t = await setup();
    const p = t.stranded("two");
    const store = t.runner.proposals;
    let refused: ControlError | undefined;
    try {
      t.runner.journal.atomically(() => {
        const v = t.runner.journal.addVersion("h", SRC("two"), "x", "y", { expect: 2, previous: 1 });
        store.markApplied(p.id, { version: v, by: "x" });
      });
    } catch (e) {
      refused = e as ControlError;
    }
    expect(refused?.message).toContain("needs a dry run first");
    expect(refused?.hint).toContain(`pipo proposals pad apply ${p.id}`);
    expect(t.versions()).toEqual([[1, null]]);
    expect((await store.dryRun(p.id)).state).toBe("verified");
    const again = await err(store.dryRun(p.id));
    expect(again?.hint).toContain(`pipo proposals pad apply ${p.id}`);
  });
});
