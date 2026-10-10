// The dry run of change proposals (docs/spec.md §9.3 step 3, D48), on the runner binary: an agent's proposal against a
// base with `agent.verify` is dry-run by `propose` (held here with `apply: false`): the last N delivered packets replay
// in memory through the proposed version with outputs and taps mocked and agent nodes stubbed from the trail; the
// proposal becomes verified, or rejected when a packet diverges (a step fails, input or output.validate no longer
// pass, a stubbed result no longer fits its schema). The real journal gets only the final transition, nothing runs
// twice, and one dry run per proposal runs at a time. A dry run cut short by SIGKILL is in
// proposal-dryrun-recovery.test.ts.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, type ControlError } from "../src";
import { sandbox, waitFor } from "./helpers";
import { claudeMock } from "./proposal-helpers";
import { RustRunner } from "./rust";

// A runner start compiles through Bun, which can hang once in a while under WSL and is then retried (compile.rs).
setDefaultTimeout(60_000);

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const FNS = `export const lower = (d) => ({ ...d, name: String(d.name).toLowerCase() });
export const upper = (d) => ({ ...d, name: String(d.name).toUpperCase(), extra: 1 });
export const strict = (d) => { if (d.n >= 2) throw new Error("n " + d.n + " is too big for s3cret mode"); return d; };
export const noEmail = (d) => { const { email, ...rest } = d; return rest; };
export const slow = async (d) => { await new Promise((r) => setTimeout(r, 700)); return d; };
export const tap = async () => {};
export const boom = () => { throw new Error("a tap ran"); };
`;

const AGENT = (verify = "last 5", edit = "[nodes, input.validate]") =>
  `agent:\n  control: true\n  edit: ${edit}\n${verify ? `  verify: ${verify}\n` : ""}`;

interface Opts {
  transform?: string;
  message?: string;
  validate?: string;
  agent?: string;
  tap?: string;
  secrets?: boolean;
}

const SRC = (o: Opts = {}) => `pipo: 1
name: dr
fn: ./fns.ts
${o.secrets ? "secrets: { word: env:PIPO_DR_WORD }\n" : ""}input:
  via: push
${o.validate ? `  validate: ["${o.validate}"]\n` : ""}nodes:
  normalize: { from: input, transform: fn.${o.transform ?? "lower"} }
  keep: { from: normalize, filter: "data.n >= 0" }
  note: { from: keep, tap: log, with: { message: "${o.message ?? "n=${data.n}"}" } }
  ping: { from: note, tap: fn.${o.tap ?? "tap"} }
output:
  from: ping
  to: file
  with: { path: ./dr.jsonl, format: jsonl }
  validate: ["exists(data.email)"]
${o.agent ?? AGENT()}`;

async function setup(
  base = SRC(),
  packets: Record<string, unknown>[] = [],
  o: { env?: Record<string, string>; files?: Record<string, string> } = {},
) {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  box.write("fns.ts", FNS);
  for (const [name, content] of Object.entries(o.files ?? {})) {
    mkdirSync(join(box.root, name, ".."), { recursive: true });
    writeFileSync(join(box.root, name), content);
  }
  const file = box.write("dr.pipo", base);
  const r = await RustRunner.start(box, file, "dr", { listen: null, env: o.env });
  cleanups.push(() => (r.proc.exitCode === null ? r.kill() : undefined));
  const ids: string[] = [];
  for (const data of packets) {
    const p = await r.push(data);
    await r.settled(p.packet_id, 10_000);
    ids.push(p.packet_id);
  }
  const out = join(box.root, "dr.jsonl");
  /** An agent's proposal against v1, held after its dry run (`apply: false`). */
  const propose = (source: string, extra: Record<string, unknown> = {}) =>
    r.request("propose", {
      base_version: 1,
      source,
      author: "agent-ops",
      author_kind: "agent",
      reason: "tune",
      apply: false,
      ...extra,
    });
  return { box, file, r, ids, out, propose };
}

/** Everything in the journal but proposals and their events, to prove a dry run writes nothing else. */
function snapshot(r: RustRunner) {
  return {
    packets: r.query("SELECT * FROM packets ORDER BY id"),
    events: r.query("SELECT seq, type, packet_id, node FROM events WHERE type NOT LIKE 'proposal.%' ORDER BY seq"),
    versions: r.query("SELECT version FROM versions"),
    spend: r.query("SELECT COUNT(*) AS n FROM agent_spend")[0],
  };
}
const proposalEvents = (r: RustRunner) =>
  r
    .query<{ type: string; detail: string }>(
      "SELECT type, detail FROM events WHERE type LIKE 'proposal.%' ORDER BY seq",
    )
    .map((e) => ({ type: e.type, detail: JSON.parse(e.detail) }));
const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);

const err = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e) => e as ControlError,
  );

const PEOPLE = [
  { n: 0, name: "Ada", email: "a@x" },
  { n: -1, name: "Filtered", email: "f@x" },
  { n: 1, name: "Bob", email: "b@x" },
  { n: 2, name: "Cy", email: "c@x" },
];

describe("dry run", () => {
  test("a compatible change is verified; nothing but the proposal's transition is written, no side effect runs", async () => {
    const t = await setup(SRC(), PEOPLE);
    const delivered = t.ids.filter((_, i) => i !== 1);
    await waitFor(() => lines(t.out).length === 3, 5000, "three lines written");
    const written = lines(t.out);
    const before = snapshot(t.r);

    // The proposed tap throws when called: the dry run mocks taps, so it passes all the same.
    const v = await t.propose(SRC({ transform: "upper", message: "changed ${data.name}", tap: "boom" }));
    expect(v.state).toBe("verified");
    expect(v.verify).toBe("last 5");
    expect(v.decided_by).toBe("dry-run");
    expect(v.decision).toContain("3 delivered packet(s) replayed");
    const report = v.verification;
    expect(report).toMatchObject({
      verify: "last 5",
      requested: 5,
      base_version: 1,
      version: 2,
      replayed: 3,
      passed: 3,
      filtered: 0,
      diverged: 0,
      skipped: 0,
    });
    // Newest delivered first; each would write once under its own key; the log and fn taps were mocked.
    expect(report.packets.map((x: any) => x.packet_id)).toEqual([...delivered].reverse());
    expect(report.packets.map((x: any) => x.writes)).toEqual([...delivered].reverse().map((id) => [id]));
    expect(report.packets.every((x: any) => x.taps === 2 && x.outcome === "passed" && x.version === 1)).toBe(true);

    expect(snapshot(t.r)).toEqual(before);
    expect(lines(t.out)).toEqual(written);
    expect(t.r.lines().some((l) => l.includes("changed"))).toBe(false);
    expect(proposalEvents(t.r).map((e) => e.type)).toEqual(["proposal.validated", "proposal.verified"]);
    expect(proposalEvents(t.r)[1]?.detail).toMatchObject({
      id: v.id,
      by: "dry-run",
      dry_run: { replayed: 3, passed: 3, filtered: 0, diverged: 0, skipped: 0 },
    });
    // A verified proposal is not dry-run again: applying it records no second outcome.
    expect(await t.r.request("apply_proposal", { id: v.id, by: "agent-ops" })).toMatchObject({ version: 2 });
    expect(proposalEvents(t.r).map((e) => e.type)).toEqual([
      "proposal.validated",
      "proposal.verified",
      "proposal.applied",
    ]);
  });

  test("a change that makes a delivered packet fail is rejected, naming the packet and why (redacted)", async () => {
    const t = await setup(SRC({ secrets: true }), PEOPLE, { env: { PIPO_DR_WORD: "s3cret" } });
    const r = await t.propose(SRC({ secrets: true, transform: "strict" }));
    expect(r.state).toBe("rejected");
    const report = r.verification;
    expect(report).toMatchObject({ replayed: 3, passed: 2, diverged: 1 });
    const bad = report.packets.find((x: any) => x.outcome === "diverged");
    expect(bad.packet_id).toBe(t.ids[3]);
    expect(bad.reasons).toEqual([
      {
        unit: t.ids[3],
        step: "normalize",
        code: "node.failed",
        message: "n 2 is too big for *** mode (then: dead_letter)",
      },
    ]);
    expect(r.decision).toContain(`dry run diverged (last 5) on 1 of 3 replayed packet(s): ${t.ids[3]} (node.failed`);
    expect(r.decision).not.toContain("s3cret");
    expect(JSON.stringify(r.verification)).not.toContain("s3cret");
    expect(proposalEvents(t.r).at(-1)).toMatchObject({
      type: "proposal.rejected",
      detail: { dry_run: { diverged: 1 } },
    });
    expect(JSON.stringify(proposalEvents(t.r))).not.toContain("s3cret");
  });

  test("a change after which the output's validate rules no longer pass is rejected (output.invalid)", async () => {
    const t = await setup(SRC(), PEOPLE);
    const r = await t.propose(SRC({ transform: "noEmail" }));
    expect(r.state).toBe("rejected");
    expect(r.verification.diverged).toBe(3);
    expect(r.verification.packets[0].reasons[0]).toMatchObject({
      step: "output",
      code: "output.invalid",
      message: "rule 'exists(data.email)' failed",
    });
  });

  test("a stricter input rule that rejects a delivered packet is divergence; filtering one is reported, not divergence", async () => {
    const t = await setup(SRC(), PEOPLE);
    const rejected = await t.propose(SRC({ validate: "data.n < 2" }));
    expect(rejected.state).toBe("rejected");
    expect(rejected.verification.packets[0].reasons[0]).toMatchObject({
      unit: t.ids[3],
      step: "input",
      code: "input.rejected",
    });

    const filtered = await t.propose(SRC().replace('filter: "data.n >= 0"', 'filter: "data.n >= 1"'));
    expect(filtered.state).toBe("verified");
    expect(filtered.verification).toMatchObject({ replayed: 3, passed: 2, filtered: 1, diverged: 0 });
    expect(filtered.verification.packets.find((x: any) => x.packet_id === t.ids[0]).outcome).toBe("filtered");
  });

  test("only the last N delivered packets replay, on any version; cleared payloads are skipped", async () => {
    const people = Array.from({ length: 7 }, (_, i) => ({ n: i, name: `p${i}`, email: `${i}@x` }));
    const t = await setup(SRC({ agent: AGENT("last 3") }), people);
    // Retention cleared the newest packet's payload (D39): its input is gone, so it is skipped and not counted in N.
    const db = new Database(t.r.journalPath);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.query("UPDATE packets SET data = NULL WHERE id = ?").run(t.ids[6] as string);
    } finally {
      db.close();
    }
    const r = await t.propose(SRC({ agent: AGENT("last 3"), transform: "upper" }));
    expect(r.state).toBe("verified");
    expect(r.verification).toMatchObject({ requested: 3, replayed: 3, skipped: 1 });
    expect(r.verification.packets.map((x: any) => x.packet_id)).toEqual([t.ids[5], t.ids[4], t.ids[3]]);
    expect(r.decision).toContain("1 skipped");
  });

  test("a fan-out replays each copy under its own key; one failing copy makes the packet diverge", async () => {
    const FAN = (b: string) => `pipo: 1
name: dr
fn: ./fns.ts
input: { via: push }
nodes:
  a: { from: input, transform: fn.lower }
  b: { from: input, transform: fn.${b} }
output: { from: [a, b], to: file, with: { path: ./dr.jsonl, format: jsonl } }
${AGENT()}`;
    const t = await setup(FAN("lower"), [PEOPLE[0], PEOPLE[3]] as Record<string, unknown>[]);
    const [ada, cy] = t.ids as [string, string];
    const ok = await t.propose(FAN("upper"));
    expect(ok.state).toBe("verified");
    expect(ok.verification.packets.map((x: any) => x.writes)).toEqual([
      [`${cy}:a`, `${cy}:b`],
      [`${ada}:a`, `${ada}:b`],
    ]);
    const bad = await t.propose(FAN("strict"));
    expect(bad.state).toBe("rejected");
    const cyReport = bad.verification.packets.find((x: any) => x.packet_id === cy);
    expect(cyReport).toMatchObject({ outcome: "diverged", writes: [`${cy}:a`] });
    expect(cyReport.reasons).toMatchObject([{ unit: `${cy}:b`, step: "b", code: "node.failed" }]);
  });

  test("with nothing delivered yet the dry run passes vacuously and says so", async () => {
    const t = await setup(SRC(), []);
    const r = await t.propose(SRC({ transform: "upper" }));
    expect(r.state).toBe("verified");
    expect(r.decision).toBe("dry run passed (last 5): no delivered packets to replay");
  });

  test("a human's proposal, and an agent's against a base without agent.verify, are not dry-run", async () => {
    const t = await setup(SRC(), PEOPLE);
    const human = await t.propose(SRC({ transform: "upper" }), { author: "cli", author_kind: "human" });
    expect(human).toMatchObject({ state: "validated", verify: null, verification: null });

    const u = await setup(SRC({ agent: AGENT("") }), PEOPLE);
    const p = await u.propose(SRC({ agent: AGENT(""), transform: "upper" }));
    expect(p).toMatchObject({ state: "validated", verify: null, verification: null });
    for (const r of [t.r, u.r]) expect(proposalEvents(r).map((e) => e.type)).toEqual(["proposal.validated"]);
  });

  test("mid-run nothing is written and the proposal stays validated; a second run is refused with a command", async () => {
    const t = await setup(SRC(), PEOPLE);
    const before = snapshot(t.r);
    // `propose` applies once the dry run passes; three replays take about two seconds in the slow fn.
    const first = t.r.request("propose", {
      base_version: 1,
      source: SRC({ transform: "slow" }),
      author: "agent-ops",
      author_kind: "agent",
      reason: "slower",
    });
    // Another connection: one connection's requests are answered in order.
    const other = await ControlClient.forPipeline(t.box.home, "dr");
    cleanups.push(() => other.close());
    const [stored] = await waitFor(
      async () => {
        const list = (await other.request("proposals", {})).proposals as { id: string; state: string }[];
        return list.length > 0 ? list : null;
      },
      15_000,
      "the proposal to be stored",
    );
    await Bun.sleep(200);
    const id = stored?.id as string;
    expect((await other.request("proposal", { id })).state).toBe("validated");
    expect(snapshot(t.r)).toEqual(before);
    expect(proposalEvents(t.r).map((e) => e.type)).toEqual(["proposal.validated"]);
    const second = await err(other.request("apply_proposal", { id, by: "ada" }));
    expect(second).toMatchObject({ code: "invalid_state" });
    expect(second?.message).toContain("already running");
    expect(second?.hint).toContain(`pipo proposals dr show ${id}`);
    expect(await first).toMatchObject({ id, state: "applied", applied_version: 2 });
    expect(proposalEvents(t.r).map((e) => e.type)).toEqual([
      "proposal.validated",
      "proposal.verified",
      "proposal.applied",
    ]);
    expect(t.r.query("SELECT version FROM versions ORDER BY version")).toEqual([{ version: 1 }, { version: 2 }]);
  });
});

describe("dry run with agent nodes", () => {
  const SCHEMA = (props: Record<string, unknown>, required: string[]) =>
    JSON.stringify({ type: "object", properties: props, required, additionalProperties: false });
  const AGENT_SRC = (o: { schema?: string; tag?: string; extraNode?: string } = {}) => `pipo: 1
name: dr
agent_budget: { per_day: 10, per_packet: 100000 }
input: { via: push }
nodes:
  classify:
    from: input
    agent: claude_api
    with: { model: mock-model, prompt: "Classify \${json(data)}", schema: ${o.schema ?? "./label.schema.json"} }
  tag:
    from: ${o.extraNode ? "again" : "classify"}
    transform: map
    with: { data: { label: "\${data.label}", tag: ${o.tag ?? "one"} } }
${o.extraNode ?? ""}output: { from: tag, to: file, with: { path: ./dr.jsonl, format: jsonl } }
agent:
  control: true
  edit: [nodes]
  verify: last 10
`;

  async function open(src: string) {
    const api = claudeMock((n) => ({ label: `l${n}` }));
    cleanups.push(() => api.stop());
    const config = `agents:
  claude_api:
    api_key: env:PIPO_DR_CLAUDE_KEY
    base_url: ${api.url}
    pricing:
      mock-model: { input: 1, output: 1 }
`;
    const t = await setup(src, [{ n: 1 }, { n: 2 }], {
      env: { PIPO_DR_CLAUDE_KEY: "test-key" },
      files: {
        "home/config.yaml": config,
        "label.schema.json": SCHEMA({ label: { type: "string" } }, ["label"]),
        "strict.schema.json": SCHEMA({ label: { type: "string" }, score: { type: "number" } }, ["label", "score"]),
      },
    });
    for (const id of t.ids) expect(t.r.packet(id)?.state).toBe("delivered");
    return { ...t, calls: api.calls };
  }

  test("agent nodes replay their recorded output and are never called; spend is untouched", async () => {
    const t = await open(AGENT_SRC());
    expect(t.calls()).toBe(2);
    const spend = snapshot(t.r).spend;
    const r = await t.propose(AGENT_SRC({ tag: "two" }));
    expect(r.state).toBe("verified");
    expect(r.verification).toMatchObject({ replayed: 2, passed: 2, diverged: 0 });
    expect(r.verification.packets.every((p: any) => p.stubbed === 1)).toBe(true);
    expect(t.calls()).toBe(2);
    expect(snapshot(t.r).spend).toEqual(spend);
  });

  test("a recorded output that no longer fits the agent node's proposed schema is divergence (agent.schema)", async () => {
    const t = await open(AGENT_SRC());
    const r = await t.propose(AGENT_SRC({ schema: "./strict.schema.json" }));
    expect(r.state).toBe("rejected");
    expect(r.verification.packets[0].reasons[0]).toMatchObject({ step: "classify", code: "agent.schema" });
    expect(t.calls()).toBe(2);
  });

  test("an agent node with nothing recorded for the packet can't be verified, so the dry run rejects it", async () => {
    const t = await open(AGENT_SRC());
    const again = `  again:
    from: classify
    agent: claude_api
    with: { model: mock-model, prompt: "Again", schema: ./label.schema.json }
`;
    const r = await t.propose(AGENT_SRC({ extraNode: again }));
    expect(r.state).toBe("rejected");
    expect(r.verification.packets[0].reasons[0]).toMatchObject({ step: "again", code: "unverifiable" });
    expect(t.calls()).toBe(2);
  });
});
