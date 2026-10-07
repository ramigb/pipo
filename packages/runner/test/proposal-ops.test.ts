// The proposal control ops (docs/spec.md §9.3, D51), in-process over the control socket: `propose` validates, dry-runs
// when the base requires it, and applies at the safe point unless `apply: false` holds it; `proposals` and `proposal`
// read; `reject_proposal` decides a held one. Refusals say what to do. The same reads work from the journal alone.
import { afterEach, describe, expect, test } from "bun:test";
import { ControlClient, type ControlError, offlineRead, Runner } from "../src";
import { sandbox, settled } from "./helpers";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const FNS = `export const one = (d) => ({ ...d, v: "one" });
export const two = (d) => ({ ...d, v: "two" });
export const strict = (d) => { if (d.n >= 2) throw new Error("n too big"); return { ...d, v: "strict" }; };
`;

const SRC = (tag: string, o: { verify?: string; edit?: string; to?: string } = {}) => `pipo: 1
name: po
fn: ./fns.ts
input: { via: push }
nodes:
  tag: { from: input, transform: fn.${tag} }
output: { from: tag, to: file, with: { path: ${o.to ?? "./po.jsonl"}, format: jsonl } }
agent:
  control: true
  edit: ${o.edit ?? "[nodes.tag]"}
${o.verify ? `  verify: ${o.verify}\n` : ""}`;

async function setup(base = SRC("one")) {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  box.write("fns.ts", FNS);
  const file = box.write("po.pipo", base);
  const runner = await Runner.open({ file, home: box.home, log: () => {} });
  await runner.start();
  cleanups.push(() => (runner.state === "stopped" || runner.state === "failed" ? undefined : runner.stop()));
  const c = await ControlClient.forPipeline(box.home, "po");
  cleanups.push(() => c.close());
  const propose = (source: string, o: Record<string, unknown> = {}) =>
    c.request("propose", { source, base_version: runner.version, reason: "tune", author: "agent-ops", ...o });
  return { box, runner, c, propose };
}

const err = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e) => e as ControlError,
  );

describe("propose", () => {
  test("a valid agent proposal is applied right away as v2, and listed and read back", async () => {
    const t = await setup();
    const p = await t.propose(SRC("two"), { author_kind: "agent" });
    expect(p).toMatchObject({ state: "applied", applied_version: 2, base_version: 1, author: "agent-ops" });
    expect(p.diff).toContain("+  tag: { from: input, transform: fn.two }");
    expect(t.runner.version).toBe(2);
    const list = await t.c.request("proposals", {});
    expect(list.proposals.map((x: any) => [x.id, x.state])).toEqual([[p.id, "applied"]]);
    expect((await t.c.request("proposals", { state: "rejected" })).proposals).toEqual([]);
    expect((await t.c.request("proposal", { id: p.id })).state).toBe("applied");
    const history = await t.c.request("versions", {});
    expect(history.versions[0]).toMatchObject({ version: 2, author_kind: "agent", proposal: p.id });
  });

  test("a human's proposal defaults to applying; author_kind defaults to human", async () => {
    const t = await setup();
    const p = await t.propose(SRC("two"), { author: "ada" });
    expect(p).toMatchObject({ state: "applied", author_kind: "human", applied_version: 2 });
  });

  test("apply: false holds it validated; apply_proposal applies it later", async () => {
    const t = await setup();
    const p = await t.propose(SRC("two"), { apply: false });
    expect(p.state).toBe("validated");
    expect(t.runner.version).toBe(1);
    const applied = await t.c.request("apply_proposal", { id: p.id, by: "ada" });
    expect(applied).toMatchObject({ version: 2, proposal: p.id });
    expect((await t.c.request("proposal", { id: p.id })).state).toBe("applied");
  });

  test("a held proposal can be rejected with a reason; a decided one can't be rejected again or applied", async () => {
    const t = await setup();
    const held = await t.propose(SRC("two"), { apply: false });
    const rej = await t.c.request("reject_proposal", { id: held.id, reason: "not now", by: "ada" });
    expect(rej).toMatchObject({ state: "rejected", decision: "not now", decided_by: "ada" });
    const again = await err(t.c.request("reject_proposal", { id: held.id, reason: "again" }));
    expect(again?.code).toBe("invalid_state");
    expect(again?.hint).toContain("propose the change again");
    const apply = await err(t.c.request("apply_proposal", { id: held.id, by: "ada" }));
    expect(apply?.code).toBe("invalid_state");

    const done = await t.propose(SRC("two"), { base_version: 1 });
    expect(done.state).toBe("applied");
    const late = await err(t.c.request("reject_proposal", { id: done.id, reason: "too late" }));
    expect(late?.code).toBe("invalid_state");
    expect(late?.hint).toBeTruthy();
    expect((await t.c.request("proposal", { id: done.id })).state).toBe("applied");
  });

  test("an agent's proposal that touches output is stored rejected, not an error, and nothing is applied", async () => {
    const t = await setup();
    const p = await t.propose(SRC("two", { to: "./other.jsonl" }), { author_kind: "agent" });
    expect(p.state).toBe("rejected");
    expect(p.problems.map((x: any) => x.code)).toContain("forbidden_path");
    expect(t.runner.version).toBe(1);
  });

  test("a human may change output", async () => {
    const t = await setup();
    const p = await t.propose(SRC("one", { to: "./other.jsonl" }), { author: "ada", author_kind: "human" });
    expect(p.state).toBe("applied");
  });

  test("agent.verify: the dry run passes and the proposal is applied; a diverging one is rejected, not applied", async () => {
    const t = await setup(SRC("one", { verify: "last 5" }));
    for (const n of [0, 1, 2]) {
      const r = await t.runner.intake({ n }, { trigger: "push", source: "test" });
      if (r.status !== "accepted") throw new Error(JSON.stringify(r));
      await settled(t.runner, r.packet_id);
    }
    const bad = await t.propose(SRC("strict", { verify: "last 5" }), { author_kind: "agent" });
    expect(bad.state).toBe("rejected");
    expect(bad.decision).toContain("dry run diverged");
    expect(t.runner.version).toBe(1);
    const ok = await t.propose(SRC("two", { verify: "last 5" }), { author_kind: "agent" });
    expect(ok).toMatchObject({ state: "applied", applied_version: 2 });
    expect(ok.verification).toMatchObject({ replayed: 3, diverged: 0 });
  });

  test("an agent proposal held after its dry run is verified, then applies", async () => {
    const t = await setup(SRC("one", { verify: "last 5" }));
    const p = await t.propose(SRC("two", { verify: "last 5" }), { author_kind: "agent", apply: false });
    expect(p.state).toBe("verified");
    expect(await t.c.request("apply_proposal", { id: p.id, by: "ada" })).toMatchObject({ version: 2 });
  });

  test("bad input is bad_request with a hint and stores nothing", async () => {
    const t = await setup();
    for (const args of [
      { source: "", base_version: 1, reason: "x" },
      { source: SRC("two"), base_version: "nope", reason: "x" },
      { source: SRC("two"), base_version: 1 },
      { source: SRC("two"), base_version: 1, reason: "x", author_kind: "robot" },
      { source: SRC("two"), base_version: 1, reason: "x", apply: "yes" },
    ]) {
      const e = await err(t.c.request("propose", args));
      expect(e?.code).toBe("bad_request");
      expect(e?.hint).toBeTruthy();
    }
    expect((await t.c.request("proposals", {})).proposals).toEqual([]);
    expect((await err(t.c.request("proposals", { state: "bogus" })))?.code).toBe("bad_request");
    expect((await err(t.c.request("proposal", { id: "pr_nope" })))?.code).toBe("not_found");
    expect((await err(t.c.request("reject_proposal", { id: "pr_x" })))?.code).toBe("bad_request");
  });

  test("a stale base is stored rejected with its problem", async () => {
    const t = await setup();
    await t.propose(SRC("two"));
    const stale = await t.propose(SRC("one"), { base_version: 1 });
    expect(stale.state).toBe("rejected");
    expect(stale.problems[0].code).toBe("stale_base");
  });

  test("proposals read from the journal with no runner", async () => {
    const t = await setup();
    const p = await t.propose(SRC("two"), { apply: false });
    const path = `${t.box.home}/pipelines/po/journal.db`;
    const list = await offlineRead(path, "proposals", {}, "po");
    expect((list!.result as any).proposals.map((x: any) => x.id)).toEqual([p.id]);
    const one = await offlineRead(path, "proposal", { id: p.id }, "po");
    expect((one!.result as any).state).toBe("validated");
    expect(await offlineRead(path, "proposal", { id: "pr_nope" }, "po").catch((e) => e.code)).toBe("not_found");
  });
});
