// The proposal control ops (docs/spec.md §9.3, D51), on the runner binary over its control socket: `propose` validates,
// dry-runs when the base requires it, and applies at the safe point unless `apply: false` holds it; `proposals` and
// `proposal` read; `reject_proposal` decides a held one. Refusals say what to do. The same reads work from the journal
// alone (`pipo-runner read`).
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { ControlError } from "../src";
import { sandbox } from "./helpers";
import { offlineRead } from "./proposal-helpers";
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
  const r = await RustRunner.start(box, file, "po", { listen: null });
  cleanups.push(() => (r.proc.exitCode === null ? r.kill() : undefined));
  const version = async () => (await r.request("hello")).version as number;
  const propose = async (source: string, o: Record<string, unknown> = {}) =>
    r.request("propose", { source, base_version: await version(), reason: "tune", author: "agent-ops", ...o });
  return { box, r, propose, version };
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
    expect(await t.version()).toBe(2);
    const list = await t.r.request("proposals", {});
    expect(list.proposals.map((x: any) => [x.id, x.state])).toEqual([[p.id, "applied"]]);
    expect((await t.r.request("proposals", { state: "rejected" })).proposals).toEqual([]);
    expect((await t.r.request("proposal", { id: p.id })).state).toBe("applied");
    const history = await t.r.request("versions", {});
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
    expect(await t.version()).toBe(1);
    const applied = await t.r.request("apply_proposal", { id: p.id, by: "ada" });
    expect(applied).toMatchObject({ version: 2, proposal: p.id });
    expect((await t.r.request("proposal", { id: p.id })).state).toBe("applied");
  });

  test("a held proposal can be rejected with a reason; a decided one can't be rejected again or applied", async () => {
    const t = await setup();
    const held = await t.propose(SRC("two"), { apply: false });
    const rej = await t.r.request("reject_proposal", { id: held.id, reason: "not now", by: "ada" });
    expect(rej).toMatchObject({ state: "rejected", decision: "not now", decided_by: "ada" });
    const again = await err(t.r.request("reject_proposal", { id: held.id, reason: "again" }));
    expect(again?.code).toBe("invalid_state");
    expect(again?.hint).toContain("propose the change again");
    const apply = await err(t.r.request("apply_proposal", { id: held.id, by: "ada" }));
    expect(apply?.code).toBe("invalid_state");

    const done = await t.propose(SRC("two"), { base_version: 1 });
    expect(done.state).toBe("applied");
    const late = await err(t.r.request("reject_proposal", { id: done.id, reason: "too late" }));
    expect(late?.code).toBe("invalid_state");
    expect(late?.hint).toBeTruthy();
    expect((await t.r.request("proposal", { id: done.id })).state).toBe("applied");
  });

  test("an agent's proposal that touches output is stored rejected, not an error, and nothing is applied", async () => {
    const t = await setup();
    const p = await t.propose(SRC("two", { to: "./other.jsonl" }), { author_kind: "agent" });
    expect(p.state).toBe("rejected");
    expect(p.problems.map((x: any) => x.code)).toContain("forbidden_path");
    expect(await t.version()).toBe(1);
  });

  test("a human may change output", async () => {
    const t = await setup();
    const p = await t.propose(SRC("one", { to: "./other.jsonl" }), { author: "ada", author_kind: "human" });
    expect(p.state).toBe("applied");
  });

  test("agent.verify: the dry run passes and the proposal is applied; a diverging one is rejected, not applied", async () => {
    const t = await setup(SRC("one", { verify: "last 5" }));
    for (const n of [0, 1, 2]) {
      const p = await t.r.push({ n });
      expect((await t.r.settled(p.packet_id)).state).toBe("delivered");
    }
    const bad = await t.propose(SRC("strict", { verify: "last 5" }), { author_kind: "agent" });
    expect(bad.state).toBe("rejected");
    expect(bad.decision).toContain("dry run diverged");
    expect(await t.version()).toBe(1);
    const ok = await t.propose(SRC("two", { verify: "last 5" }), { author_kind: "agent" });
    expect(ok).toMatchObject({ state: "applied", applied_version: 2 });
    expect(ok.verification).toMatchObject({ replayed: 3, diverged: 0 });
  });

  test("an agent proposal held after its dry run is verified, then applies", async () => {
    const t = await setup(SRC("one", { verify: "last 5" }));
    const p = await t.propose(SRC("two", { verify: "last 5" }), { author_kind: "agent", apply: false });
    expect(p.state).toBe("verified");
    expect(await t.r.request("apply_proposal", { id: p.id, by: "ada" })).toMatchObject({ version: 2 });
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
      const e = await err(t.r.request("propose", args));
      expect(e?.code).toBe("bad_request");
      expect(e?.hint).toBeTruthy();
    }
    expect((await t.r.request("proposals", {})).proposals).toEqual([]);
    expect((await err(t.r.request("proposals", { state: "bogus" })))?.code).toBe("bad_request");
    expect((await err(t.r.request("proposal", { id: "pr_nope" })))?.code).toBe("not_found");
    expect((await err(t.r.request("reject_proposal", { id: "pr_x" })))?.code).toBe("bad_request");
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
    expect(await t.r.stop()).toBe(0);
    const list = await offlineRead(t.box, "po", "proposals");
    expect(list.code).toBe(0);
    expect(list.value.withheld).toBeNull();
    expect(list.value.result.proposals.map((x: any) => x.id)).toEqual([p.id]);
    const one = await offlineRead(t.box, "po", "proposal", { id: p.id });
    expect(one.value.result.state).toBe("validated");
    const missing = await offlineRead(t.box, "po", "proposal", { id: "pr_nope" });
    expect(missing.code).toBe(1);
    expect(missing.value.error.code).toBe("not_found");
  });
});
