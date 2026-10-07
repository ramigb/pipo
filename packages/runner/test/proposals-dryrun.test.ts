// The dry run of change proposals (docs/spec.md §9.3 step 3, D48): the last N delivered packets replay in memory
// through the proposed version with outputs and taps mocked and agent nodes stubbed from the trail; the proposal
// becomes verified, or rejected when a packet diverges (a step fails, input or output.validate no longer pass, a
// stubbed result no longer fits its schema). The real journal gets only the final transition, so a crash (here a
// SIGKILLed process mid-run) leaves the proposal validated and rerunnable.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ControlError, Journal, Proposals, Runner } from "../src";
import type { AgentProvider } from "../src/agents";
import { sandbox, settled, waitFor } from "./helpers";

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
  (globalThis as any).__pipoDryGate = undefined;
  (globalThis as any).__pipoDryCalls = undefined;
});

const FNS = `import { writeFileSync } from "node:fs";
export const lower = (d) => ({ ...d, name: String(d.name).toLowerCase() });
export const upper = (d) => ({ ...d, name: String(d.name).toUpperCase(), extra: 1 });
export const strict = (d) => { if (d.n >= 2) throw new Error("n " + d.n + " is too big for s3cret mode"); return d; };
export const noEmail = (d) => { const { email, ...rest } = d; return rest; };
export const gated = async (d) => {
  globalThis.__pipoDryCalls = (globalThis.__pipoDryCalls ?? 0) + 1;
  if (globalThis.__pipoDryGate) await globalThis.__pipoDryGate;
  return d;
};
export const hang = async (d) => {
  if (process.env.PIPO_DRYRUN_MARKER) { writeFileSync(process.env.PIPO_DRYRUN_MARKER, "in"); await Bun.sleep(60000); }
  return d;
};
export const tap = async () => { globalThis.__pipoDryCalls = (globalThis.__pipoDryCalls ?? 0) + 1; };
`;

const AGENT = (verify = "last 5", edit = "[nodes, input.validate]") =>
  `agent:\n  control: true\n  edit: ${edit}\n${verify ? `  verify: ${verify}\n` : ""}`;

const SRC = (o: { transform?: string; message?: string; validate?: string; agent?: string } = {}) => `pipo: 1
name: dr
fn: ./fns.ts
input:
  via: push
${o.validate ? `  validate: ["${o.validate}"]\n` : ""}nodes:
  normalize: { from: input, transform: fn.${o.transform ?? "lower"} }
  keep: { from: normalize, filter: "data.n >= 0" }
  note: { from: keep, tap: log, with: { message: "${o.message ?? "n=${data.n}"}" } }
  ping: { from: note, tap: fn.tap }
output:
  from: ping
  to: file
  with: { path: ./dr.jsonl, format: jsonl }
  validate: ["exists(data.email)"]
${o.agent ?? AGENT()}`;

async function setup(base = SRC(), packets: Record<string, unknown>[] = [], extraFiles: Record<string, string> = {}) {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  box.write("fns.ts", FNS);
  for (const [name, content] of Object.entries(extraFiles)) box.write(name, content);
  const file = box.write("dr.pipo", base);
  const runner = await Runner.open({ file, home: box.home, log: () => {} });
  await runner.start();
  cleanups.push(() => (runner.state === "stopped" || runner.state === "failed" ? undefined : runner.stop()));
  const ids: string[] = [];
  for (const data of packets) {
    const r = await runner.intake(data, { trigger: "push", source: "test" });
    if (r.status !== "accepted") throw new Error(JSON.stringify(r));
    await settled(runner, r.packet_id);
    ids.push(r.packet_id);
  }
  // The real side effects so far: the output file and the fn tap's calls.
  const out = join(box.root, "dr.jsonl");
  const store = (redact?: (t: string) => string) =>
    new Proposals(runner.journal, { pipeline: "dr", file, home: box.home, redact });
  return { box, file, runner, ids, out, store };
}

const agent = (source: string) => ({
  base_version: 1,
  source,
  author: "agent-ops",
  author_kind: "agent" as const,
  reason: "tune",
});

/** Everything in the journal but proposals and their events, to prove a dry run writes nothing else. */
function snapshot(j: Journal) {
  return {
    packets: j.db.query("SELECT * FROM packets ORDER BY id").all(),
    events: j.db
      .query("SELECT seq, type, packet_id, node FROM events WHERE type NOT LIKE 'proposal.%' ORDER BY seq")
      .all(),
    versions: j.db.query("SELECT version FROM versions").all(),
    spend: j.db.query("SELECT COUNT(*) AS n FROM agent_spend").get(),
  };
}
const proposalEvents = (j: Journal) =>
  (
    j.db.query("SELECT type, detail FROM events WHERE type LIKE 'proposal.%' ORDER BY seq").all() as {
      type: string;
      detail: string;
    }[]
  ).map((e) => ({ type: e.type, detail: JSON.parse(e.detail) }));
const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);

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
    const tapCalls = (globalThis as any).__pipoDryCalls;
    expect(tapCalls).toBe(3);
    const written = lines(t.out);
    const store = t.store();
    const p = store.propose(agent(SRC({ transform: "upper", message: "changed ${data.name}" })));
    expect(p.state).toBe("validated");
    expect(p.verify).toBe("last 5");
    const before = snapshot(t.runner.journal);

    const v = await store.dryRun(p.id);
    expect(v.state).toBe("verified");
    expect(v.decided_by).toBe("dry-run");
    expect(v.decision).toContain("3 delivered packet(s) replayed");
    const report = v.verification as any;
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

    expect(snapshot(t.runner.journal)).toEqual(before);
    expect(lines(t.out)).toEqual(written);
    expect((globalThis as any).__pipoDryCalls).toBe(tapCalls);
    expect(proposalEvents(t.runner.journal).map((e) => e.type)).toEqual(["proposal.validated", "proposal.verified"]);
    expect(proposalEvents(t.runner.journal)[1]?.detail).toMatchObject({
      id: p.id,
      by: "dry-run",
      dry_run: { replayed: 3, passed: 3, filtered: 0, diverged: 0, skipped: 0 },
    });
    // A verified proposal is not dry-run again.
    await expect(store.dryRun(p.id)).rejects.toMatchObject({ code: "invalid_state" });
  });

  test("a change that makes a delivered packet fail is rejected, naming the packet and why (redacted)", async () => {
    const t = await setup(SRC(), PEOPLE);
    const store = t.store((s) => s.replaceAll("s3cret", "***"));
    const p = store.propose(agent(SRC({ transform: "strict" })));
    const r = await store.dryRun(p.id);
    expect(r.state).toBe("rejected");
    const report = r.verification as any;
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
    expect(proposalEvents(t.runner.journal).at(-1)).toMatchObject({
      type: "proposal.rejected",
      detail: { dry_run: { diverged: 1 } },
    });
  });

  test("a change after which the output's validate rules no longer pass is rejected (output.invalid)", async () => {
    const t = await setup(SRC(), PEOPLE);
    const store = t.store();
    const r = await store.dryRun(store.propose(agent(SRC({ transform: "noEmail" }))).id);
    expect(r.state).toBe("rejected");
    const report = r.verification as any;
    expect(report.diverged).toBe(3);
    expect(report.packets[0].reasons[0]).toMatchObject({
      step: "output",
      code: "output.invalid",
      message: "rule 'exists(data.email)' failed",
    });
  });

  test("a stricter input rule that rejects a delivered packet is divergence; filtering one is reported, not divergence", async () => {
    const t = await setup(SRC(), PEOPLE);
    const store = t.store();
    const rejected = await store.dryRun(store.propose(agent(SRC({ validate: "data.n < 2" }))).id);
    expect(rejected.state).toBe("rejected");
    expect((rejected.verification as any).packets[0].reasons[0]).toMatchObject({
      unit: t.ids[3],
      step: "input",
      code: "input.rejected",
    });

    const filterSrc = SRC().replace('filter: "data.n >= 0"', 'filter: "data.n >= 1"');
    const filtered = await store.dryRun(store.propose(agent(filterSrc)).id);
    expect(filtered.state).toBe("verified");
    expect(filtered.verification).toMatchObject({ replayed: 3, passed: 2, filtered: 1, diverged: 0 });
    expect((filtered.verification as any).packets.find((x: any) => x.packet_id === t.ids[0]).outcome).toBe("filtered");
  });

  test("only the last N delivered packets replay, on any version; cleared payloads are skipped", async () => {
    const people = Array.from({ length: 7 }, (_, i) => ({ n: i, name: `p${i}`, email: `${i}@x` }));
    const t = await setup(SRC({ agent: AGENT("last 3") }), people);
    // Retention cleared the newest packet's payload (D39): its input is gone, so it is skipped and not counted in N.
    t.runner.journal.db.query("UPDATE packets SET data = NULL WHERE id = ?").run(t.ids[6] as string);
    const store = t.store();
    const r = await store.dryRun(store.propose(agent(SRC({ agent: AGENT("last 3"), transform: "upper" }))).id);
    expect(r.state).toBe("verified");
    expect(r.verification).toMatchObject({ requested: 3, replayed: 3, skipped: 1 });
    expect((r.verification as any).packets.map((x: any) => x.packet_id)).toEqual([t.ids[5], t.ids[4], t.ids[3]]);
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
    const store = t.store();
    const ok = await store.dryRun(store.propose(agent(FAN("upper"))).id);
    expect(ok.state).toBe("verified");
    expect((ok.verification as any).packets.map((x: any) => x.writes)).toEqual([
      [`${cy}:a`, `${cy}:b`],
      [`${ada}:a`, `${ada}:b`],
    ]);
    const bad = await store.dryRun(store.propose(agent(FAN("strict"))).id);
    expect(bad.state).toBe("rejected");
    const cyReport = (bad.verification as any).packets.find((x: any) => x.packet_id === cy);
    expect(cyReport).toMatchObject({ outcome: "diverged", writes: [`${cy}:a`] });
    expect(cyReport.reasons).toMatchObject([{ unit: `${cy}:b`, step: "b", code: "node.failed" }]);
  });

  test("with nothing delivered yet the dry run passes vacuously and says so", async () => {
    const t = await setup(SRC(), []);
    const store = t.store();
    const r = await store.dryRun(store.propose(agent(SRC({ transform: "upper" }))).id);
    expect(r.state).toBe("verified");
    expect(r.decision).toBe("dry run passed (last 5): no delivered packets to replay");
  });

  test("only a validated agent proposal against a base with agent.verify is dry-run; a stale one is rejected", async () => {
    const t = await setup(SRC(), PEOPLE);
    const store = t.store();
    const human = store.propose({ ...agent(SRC({ transform: "upper" })), author: "cli", author_kind: "human" });
    expect(human.verify).toBeNull();
    const err = await store.dryRun(human.id).catch((e: ControlError) => e);
    expect(err).toMatchObject({ code: "invalid_state", hint: "apply it directly" });

    const stale = store.propose(agent(SRC({ transform: "upper" })));
    t.runner.journal.addVersion("h2", SRC({ transform: "upper" }), "human", "edit");
    const r = await store.dryRun(stale.id);
    expect(r.state).toBe("rejected");
    expect(r.decision).toContain("stale base");
    expect(r.verification).toBeNull();
  });

  test("a base without agent.verify needs no dry run", async () => {
    const t = await setup(SRC({ agent: AGENT("") }), PEOPLE);
    const store = t.store();
    const p = store.propose(agent(SRC({ agent: AGENT(""), transform: "upper" })));
    expect(p.state).toBe("validated");
    await expect(store.dryRun(p.id)).rejects.toMatchObject({ code: "invalid_state" });
  });

  test("mid-run nothing is written and the proposal stays validated; a second concurrent run is refused", async () => {
    const t = await setup(SRC(), PEOPLE);
    const store = t.store();
    const p = store.propose(agent(SRC({ transform: "gated" })));
    const before = snapshot(t.runner.journal);
    const events = proposalEvents(t.runner.journal);
    let open!: () => void;
    (globalThis as any).__pipoDryGate = new Promise<void>((r) => {
      open = r;
    });
    (globalThis as any).__pipoDryCalls = 0;
    const running = store.dryRun(p.id);
    await waitFor(() => (globalThis as any).__pipoDryCalls >= 1, 5000, "the dry run to reach the gated fn");
    expect(store.get(p.id).state).toBe("validated");
    expect(snapshot(t.runner.journal)).toEqual(before);
    expect(proposalEvents(t.runner.journal)).toEqual(events);
    await expect(store.dryRun(p.id)).rejects.toMatchObject({ code: "invalid_state" });
    open();
    expect((await running).state).toBe("verified");
  });

  test("a dry run SIGKILLed mid-run leaves the proposal validated and the journal as it was; it then runs again", async () => {
    const t = await setup(SRC(), PEOPLE);
    const store = t.store();
    const p = store.propose(agent(SRC({ transform: "hang" })));
    const dbPath = join(t.box.home, "pipelines", "dr", "journal.db");
    await t.runner.stop();
    const before = (() => {
      const j = new Journal(dbPath);
      try {
        return { snap: snapshot(j), events: proposalEvents(j) };
      } finally {
        j.close();
      }
    })();

    const script = t.box.write(
      "dry.ts",
      `import { Journal, Proposals } from ${JSON.stringify(join(import.meta.dir, "../src/index.ts"))};
const [db, file, id] = process.argv.slice(2);
await new Proposals(new Journal(db), { pipeline: "dr", file }).dryRun(id);
`,
    );
    const marker = join(t.box.root, "in-dry-run");
    for (let tries = 1; ; tries++) {
      const proc = Bun.spawn(["bun", script, dbPath, t.file, p.id], {
        env: { ...process.env, PIPO_DRYRUN_MARKER: marker },
        stdout: Bun.file(join(t.box.root, `dry-${tries}.log`)),
        stderr: Bun.file(join(t.box.root, `dry-${tries}.err`)),
      });
      cleanups.push(() => proc.kill("SIGKILL"));
      const outcome = await waitFor(
        () => (existsSync(marker) ? "in" : proc.exitCode !== null ? "exited" : null),
        15_000,
        "the dry run to reach the fn",
      ).catch(() => "stuck");
      proc.kill("SIGKILL");
      await proc.exited;
      if (outcome === "in") break;
      // Under WSL, Bun sometimes never finishes loading modules from /mnt; nothing ran yet, so start it again.
      if (outcome === "exited" || tries === 3) {
        const err = readFileSync(join(t.box.root, `dry-${tries}.err`), "utf8");
        throw new Error(`the dry run process never reached the fn (${outcome}):\n${err}`);
      }
    }

    const j = new Journal(dbPath);
    cleanups.push(() => j.close());
    expect(j.db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(snapshot(j)).toEqual(before.snap);
    expect(proposalEvents(j)).toEqual(before.events);
    const again = new Proposals(j, { pipeline: "dr", file: t.file });
    expect(again.get(p.id).state).toBe("validated");
    const r = await again.dryRun(p.id);
    expect(r.state).toBe("verified");
    expect(snapshot(j)).toEqual(before.snap);
  }, 60_000);
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
    const box = sandbox();
    cleanups.push(() => box.cleanup());
    box.write("label.schema.json", SCHEMA({ label: { type: "string" } }, ["label"]));
    box.write(
      "strict.schema.json",
      SCHEMA({ label: { type: "string" }, score: { type: "number" } }, ["label", "score"]),
    );
    const file = box.write("dr.pipo", src);
    let calls = 0;
    const provider: AgentProvider = {
      complete: async () => {
        calls++;
        return { output: { label: `l${calls}` }, input_tokens: 10, output_tokens: 5 };
      },
    };
    const runner = await Runner.open({
      file,
      home: box.home,
      log: () => {},
      agents: {
        providers: { claude_api: provider },
        pricing: { claude_api: { "mock-model": { input: 1, output: 1 } } },
      },
    });
    await runner.start();
    cleanups.push(() => (runner.state === "stopped" || runner.state === "failed" ? undefined : runner.stop()));
    const ids: string[] = [];
    for (const n of [1, 2]) {
      const r = await runner.intake({ n }, { trigger: "push", source: "test" });
      if (r.status !== "accepted") throw new Error(JSON.stringify(r));
      expect((await settled(runner, r.packet_id)).state).toBe("delivered");
      ids.push(r.packet_id);
    }
    const store = new Proposals(runner.journal, { pipeline: "dr", file, home: box.home });
    return { runner, store, ids, calls: () => calls };
  }

  test("agent nodes replay their recorded output and are never called; spend is untouched", async () => {
    const t = await open(AGENT_SRC());
    const spend = snapshot(t.runner.journal).spend;
    const r = await t.store.dryRun(t.store.propose(agent(AGENT_SRC({ tag: "two" }))).id);
    expect(r.state).toBe("verified");
    expect(r.verification).toMatchObject({ replayed: 2, passed: 2, diverged: 0 });
    expect((r.verification as any).packets.every((p: any) => p.stubbed === 1)).toBe(true);
    expect(t.calls()).toBe(2);
    expect(snapshot(t.runner.journal).spend).toEqual(spend);
  });

  test("a recorded output that no longer fits the agent node's proposed schema is divergence (agent.schema)", async () => {
    const t = await open(AGENT_SRC());
    const r = await t.store.dryRun(t.store.propose(agent(AGENT_SRC({ schema: "./strict.schema.json" }))).id);
    expect(r.state).toBe("rejected");
    expect((r.verification as any).packets[0].reasons[0]).toMatchObject({ step: "classify", code: "agent.schema" });
    expect(t.calls()).toBe(2);
  });

  test("an agent node with nothing recorded for the packet can't be verified, so the dry run rejects it", async () => {
    const t = await open(AGENT_SRC());
    const again = `  again:
    from: classify
    agent: claude_api
    with: { model: mock-model, prompt: "Again", schema: ./label.schema.json }
`;
    const r = await t.store.dryRun(t.store.propose(agent(AGENT_SRC({ extraNode: again }))).id);
    expect(r.state).toBe("rejected");
    expect((r.verification as any).packets[0].reasons[0]).toMatchObject({ step: "again", code: "unverifiable" });
    expect(t.calls()).toBe(2);
  });
});
