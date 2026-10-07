// The proposal store and its validation (docs/spec.md §9.3, D45): stale base, pipo check, the agent.edit path policy
// (wildcards, subtrees, the always-forbidden keys), audit fields, the diff, state moves and their journal events, and
// a round trip through a reopened journal. Applying live is in proposal-apply(-recovery).test.ts.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type ControlError, changedPaths, covers, Journal, Proposals, readProposals } from "../src";
import { sandbox } from "./helpers";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
});

interface Opts {
  message?: string;
  level?: string;
  tag?: string;
  path?: string;
  agent?: string | null;
  extra?: string;
}

const AGENT = `agent:
  control: true
  edit:
    - nodes.*.with.message
    - nodes.normalize
    - errors
`;

const SRC = (o: Opts = {}) => `pipo: 1
name: demo
input: { via: push }
nodes:
  normalize:
    from: input
    transform: map
    with:
      data: { name: "\${data.name}", tag: ${o.tag ?? "one"} }
  note:
    from: normalize
    tap: log
    with: { level: ${o.level ?? "info"}, message: ${o.message ?? "hi"} }
output: { from: note, to: file, with: { path: ${o.path ?? "./demo.jsonl"}, format: jsonl } }
${o.agent === null ? "" : (o.agent ?? AGENT)}${o.extra ?? ""}`;

function setup(base = SRC(), opts: { redact?: (t: string) => string } = {}) {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  const file = box.write("demo.pipo", base);
  const dbPath = join(box.root, "journal.db");
  let journal = new Journal(dbPath);
  journal.version(new Bun.CryptoHasher("sha256").update(base).digest("hex"), base, "human", "first start");
  const make = () => new Proposals(journal, { pipeline: "demo", file, home: box.home, redact: opts.redact });
  let store = make();
  cleanups.push(() => journal.close());
  return {
    box,
    file,
    dbPath,
    get journal() {
      return journal;
    },
    get store() {
      return store;
    },
    reopen() {
      journal.close();
      journal = new Journal(dbPath);
      store = make();
    },
    addVersion(source: string) {
      return journal.addVersion(new Bun.CryptoHasher("sha256").update(source).digest("hex"), source, "human", "edit");
    },
  };
}

const agent = (source: string, base = 1) => ({
  base_version: base,
  source,
  author: "agent-ops",
  author_kind: "agent" as const,
  reason: "friendlier log line",
});
const codes = (p: { problems: { code: string }[] }) => p.problems.map((x) => x.code);
const pipelineEvents = (j: Journal) =>
  (
    j.db.query("SELECT type, detail FROM events WHERE packet_id IS NULL ORDER BY seq").all() as {
      type: string;
      detail: string;
    }[]
  ).map((e) => ({ type: e.type, detail: JSON.parse(e.detail) }));

describe("changed paths and patterns", () => {
  test("maps are walked key by key; a list is one path; key order and formatting are no change", () => {
    expect(changedPaths({ a: { b: 1, c: [1, 2] }, d: 1 }, { d: 1, a: { c: [1, 3], b: 1 } })).toEqual([["a", "c"]]);
    expect(changedPaths({ a: 1 }, { a: 1, b: { c: 2 } })).toEqual([["b"]]);
    expect(changedPaths({ a: { x: 1 } }, { a: 2 })).toEqual([["a"]]);
    expect(changedPaths({ a: [{ k: 1, j: 2 }] }, { a: [{ j: 2, k: 1 }] })).toEqual([]);
  });

  test("* is exactly one segment and a pattern covers its subtree", () => {
    expect(covers("nodes.*.with.message", ["nodes", "note", "with", "message"])).toBe(true);
    expect(covers("nodes.*.with.message", ["nodes", "a", "b", "with", "message"])).toBe(false);
    expect(covers("nodes.normalize", ["nodes", "normalize", "with", "data", "tag"])).toBe(true);
    expect(covers("nodes.normalize.with", ["nodes", "normalize"])).toBe(false);
    expect(covers("nodes.norm", ["nodes", "normalize"])).toBe(false);
  });
});

describe("propose and validate", () => {
  test("an agent's change inside agent.edit is validated, stored with its audit fields and diff, and evented", () => {
    const t = setup();
    const before = Date.now();
    const p = t.store.propose(agent(SRC({ message: "hello" })));
    expect(p.state).toBe("validated");
    expect(p.id).toMatch(/^pr_[0-9A-Z]{26}$/);
    expect(p).toMatchObject({
      pipeline: "demo",
      base_version: 1,
      author: "agent-ops",
      author_kind: "agent",
      reason: "friendlier log line",
      changed_paths: ["nodes.note.with.message"],
      problems: [],
      verify: null,
      applied_version: null,
      decided_by: null,
      decided_at: null,
      added: 1,
      removed: 1,
    });
    expect(p.created_at).toBeGreaterThanOrEqual(before);
    expect(p.source).toBe(SRC({ message: "hello" }));
    expect(p.diff).toBe(
      [
        "--- demo v1",
        `+++ demo proposal ${p.id}`,
        "@@ -10,7 +10,7 @@",
        "   note:",
        "     from: normalize",
        "     tap: log",
        "-    with: { level: info, message: hi }",
        "+    with: { level: info, message: hello }",
        " output: { from: note, to: file, with: { path: ./demo.jsonl, format: jsonl } }",
        " agent:",
        "   control: true",
      ].join("\n"),
    );
    expect(pipelineEvents(t.journal).at(-1)).toEqual({
      type: "proposal.validated",
      detail: {
        id: p.id,
        base_version: 1,
        author: "agent-ops",
        author_kind: "agent",
        reason: "friendlier log line",
        changed_paths: ["nodes.note.with.message"],
      },
    });
    // Proposing writes no version: only apply does.
    expect(t.journal.latestVersion()?.version).toBe(1);
  });

  test("a stored proposal round-trips from a reopened journal and from a read-only one", () => {
    const t = setup();
    const p = t.store.propose(agent(SRC({ message: "hello" })));
    const rejected = t.store.propose(agent(SRC({ level: "warn" })));
    t.reopen();
    expect(t.store.get(p.id)).toEqual(p);
    expect(t.store.get(rejected.id)).toEqual(rejected);
    expect(t.store.list().map((x) => x.id)).toEqual([rejected.id, p.id]);
    expect(t.store.list({ state: "validated" }).map((x) => x.id)).toEqual([p.id]);
    const ro = new Database(t.dbPath, { readonly: true });
    try {
      expect(readProposals.get(ro, p.id)).toEqual(p);
      expect(readProposals.list(ro, { state: "rejected" })[0]).not.toHaveProperty("source");
    } finally {
      ro.close();
    }
  });

  test("a subtree pattern covers deeper changes", () => {
    const t = setup();
    const p = t.store.propose(agent(SRC({ tag: "two" })));
    expect(p.state).toBe("validated");
    expect(p.changed_paths).toEqual(["nodes.normalize.with.data.tag"]);
  });

  test("* matches one segment only: a sibling key under a wildcard pattern is not editable", () => {
    const t = setup();
    const p = t.store.propose(agent(SRC({ level: "warn" })));
    expect(p.state).toBe("rejected");
    expect(p.problems).toEqual([expect.objectContaining({ code: "not_editable", path: "nodes.note.with.level" })]);
    expect(p.problems[0]?.hint).toContain("agent.edit");
  });

  test("a path not listed in agent.edit is rejected, and every problem is reported at once", () => {
    const t = setup();
    const p = t.store.propose(
      agent(SRC({ message: "hello", extra: "description: changed by an agent\nbuffer: { max: 10 }\n" })),
    );
    expect(p.state).toBe("rejected");
    expect(p.changed_paths).toEqual(["buffer", "description", "nodes.note.with.message"]);
    expect(p.problems.map((x) => [x.code, x.path])).toEqual([
      ["not_editable", "buffer"],
      ["not_editable", "description"],
    ]);
  });

  for (const [key, change] of [
    ["output", (agentBlock: string) => SRC({ path: "./other.jsonl", agent: agentBlock })],
    ["delivered", (agentBlock: string) => SRC({ agent: agentBlock, extra: "delivered: { check: file_exists }\n" })],
    ["secrets", (agentBlock: string) => SRC({ agent: agentBlock, extra: "secrets: { token: env:PIPO_TEST_TOKEN }\n" })],
    ["agent", (agentBlock: string) => SRC({ agent: `${agentBlock}  redact: [data.name]\n` })],
    // D47: an agent can't raise its own spending cap, even with edit: ["*"].
    ["agent_budget", (agentBlock: string) => SRC({ agent: agentBlock, extra: "agent_budget: { per_day: 100 }\n" })],
  ] as const) {
    test(`agents may never change ${key}, even when agent.edit lists it`, () => {
      const policy = `agent:\n  control: true\n  edit: ["*", output, delivered, secrets, agent, agent_budget]\n`;
      const t = setup(SRC({ agent: policy }));
      const p = t.store.propose(agent(change(policy)));
      expect(p.state).toBe("rejected");
      expect(p.changed_paths.every((c) => c === key || c.startsWith(`${key}.`))).toBe(true);
      expect(codes(p)).toContain("forbidden_path");
      expect(codes(p)).not.toContain("not_editable");
      expect(p.problems.find((x) => x.code === "forbidden_path")?.message).toContain(`\`${key}\``);
    });
  }

  test("a pipeline without agent.control or agent.edit takes no agent proposals", () => {
    for (const block of [null, "agent:\n  control: false\n  edit: [nodes]\n", "agent:\n  control: true\n"]) {
      const t = setup(SRC({ agent: block }));
      const p = t.store.propose(agent(SRC({ agent: block, message: "hello" })));
      expect(p.state).toBe("rejected");
      expect(codes(p)).toEqual(["not_allowed"]);
      expect(p.problems[0]?.hint).toContain("human");
    }
  });

  test("a human is not bound by agent.edit or the forbidden keys, only by check and what apply allows", () => {
    const t = setup(SRC({ agent: null }));
    const human = (source: string) => ({
      base_version: "v1",
      source,
      author: "cli",
      author_kind: "human" as const,
      reason: "ops",
    });
    const ok = t.store.propose(human(SRC({ agent: null, path: "./other.jsonl", level: "warn" })));
    expect(ok.state).toBe("validated");
    expect(ok.changed_paths).toEqual(["nodes.note.with.level", "output.with.path"]);
    const bound = t.store.propose(human(SRC({ agent: null, extra: "concurrency: 2\n" })));
    expect(bound.state).toBe("rejected");
    expect(codes(bound)).toEqual(["bound_change"]);
    expect(bound.problems[0]?.message).toContain("concurrency");
  });

  test("a stale base is rejected and says to propose against the current version", () => {
    const t = setup();
    t.addVersion(SRC({ tag: "two" }));
    const p = t.store.propose(agent(SRC({ message: "hello" })));
    expect(p.state).toBe("rejected");
    expect(codes(p)).toEqual(["stale_base"]);
    expect(p.problems[0]).toMatchObject({
      message: expect.stringContaining("v2"),
      hint: expect.stringContaining("v2"),
    });
    // The diff is still against the base the author named.
    expect(p.diff.split("\n")[0]).toBe("--- demo v1");
  });

  test("a source that fails pipo check is rejected with its diagnostics", () => {
    const t = setup();
    const p = t.store.propose(agent(SRC({ message: "hello" }).replace("from: normalize", "from: nowhere")));
    expect(p.state).toBe("rejected");
    expect(codes(p)).toContain("invalid_pipeline");
    expect(p.diagnostics.map((d) => d.code)).toContain("P010");
    // Bad YAML still stores the attempt, with no changed paths.
    const bad = t.store.propose(agent("pipo: 1\nname: [demo\n"));
    expect(bad.state).toBe("rejected");
    expect(bad.changed_paths).toEqual([]);
    expect(bad.diagnostics[0]?.code).toBe("P001");
  });

  test("the same source as the base is no change", () => {
    const t = setup();
    expect(codes(t.store.propose(agent(SRC())))).toEqual(["no_change"]);
  });

  test("a comment-only change touches no path, so an agent may make it", () => {
    const t = setup();
    const p = t.store.propose(agent(`# reviewed\n${SRC()}`));
    expect(p.state).toBe("validated");
    expect(p.changed_paths).toEqual([]);
  });

  test("bad input stores nothing: unknown base, missing fields, bad author kind", () => {
    const t = setup();
    const err = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e as ControlError;
      }
      throw new Error("expected an error");
    };
    expect(err(() => t.store.propose(agent(SRC({ message: "x" }), 9)))).toMatchObject({
      code: "not_found",
      message: expect.stringContaining("v1 to v1"),
    });
    expect(err(() => t.store.propose({ ...agent(SRC({ message: "x" })), reason: " " })).code).toBe("bad_request");
    expect(err(() => t.store.propose({ ...agent(SRC({ message: "x" })), base_version: "latest" })).code).toBe(
      "bad_request",
    );
    expect(err(() => t.store.propose({ ...agent(SRC({ message: "x" })), author_kind: "robot" as never })).code).toBe(
      "bad_request",
    );
    expect(err(() => t.store.get("pr_nope"))).toMatchObject({ code: "not_found", hint: expect.any(String) });
    expect(t.store.list()).toEqual([]);
    expect(pipelineEvents(t.journal)).toEqual([]);
  });

  test("reasons, diagnostics and events are redacted; the source is kept as written", () => {
    const t = setup(SRC(), { redact: (s) => s.split("s3cr3t-value").join("***") });
    const p = t.store.propose({ ...agent(SRC({ message: "hello" })), reason: "token s3cr3t-value leaked" });
    expect(p.reason).toBe("token *** leaked");
    expect(JSON.stringify(pipelineEvents(t.journal))).not.toContain("s3cr3t-value");
  });
});

describe("decisions", () => {
  test("validated → applied inside the transaction that adds the version; both or neither are written", () => {
    const t = setup();
    const p = t.store.propose(agent(SRC({ message: "hello" })));
    const rival = t.store.propose(agent(SRC({ tag: "two" })));
    // A wrong version number rolls the whole transaction back, version included.
    expect(() =>
      t.journal.atomically(() => {
        t.addVersion(p.source);
        t.store.markApplied(p.id, { version: 7, by: "agent-ops" });
      }),
    ).toThrow(/can only become v2/);
    expect(t.journal.latestVersion()?.version).toBe(1);
    expect(t.store.get(p.id).state).toBe("validated");

    const applied = t.journal.atomically(() => {
      const v = t.addVersion(p.source);
      return t.store.markApplied(p.id, { version: v, by: "agent-ops" });
    });
    expect(applied).toMatchObject({ state: "applied", applied_version: 2, decided_by: "agent-ops" });
    expect(applied.decided_at).toBeNumber();
    t.reopen();
    expect(t.store.get(p.id).state).toBe("applied");
    expect(pipelineEvents(t.journal).at(-1)).toEqual({
      type: "proposal.applied",
      detail: { id: p.id, base_version: 1, by: "agent-ops", version: 2 },
    });
    // Decided proposals stay decided.
    expect(() => t.store.markRejected(p.id, { by: "cli", reason: "no" })).toThrow(/is applied/);
    // A rival validated on the same base can't land on top of v2: its apply rolls back, and it is rejected as stale.
    expect(() =>
      t.journal.atomically(() =>
        t.store.markApplied(rival.id, { version: t.addVersion(rival.source), by: "agent-ops" }),
      ),
    ).toThrow(/can only become v2, not v3/);
    expect(t.journal.latestVersion()?.version).toBe(2);
    expect(t.store.markRejected(rival.id, { by: "runner", reason: "stale: v2 was applied" }).state).toBe("rejected");
    // A new proposal against v2 is fine.
    expect(t.store.propose(agent(SRC({ message: "hello", tag: "three" }), 2)).state).toBe("validated");
  });

  test("agent.verify makes a dry run required before apply; verified and rejected keep their report", () => {
    const policy = `${AGENT}  verify: last 5\n`;
    const t = setup(SRC({ agent: policy }));
    const p = t.store.propose(agent(SRC({ agent: policy, message: "hello" })));
    expect(p.verify).toBe("last 5");
    expect(() =>
      t.journal.atomically(() => t.store.markApplied(p.id, { version: t.addVersion(p.source), by: "agent-ops" })),
    ).toThrow(/needs a dry run/);
    expect(t.journal.latestVersion()?.version).toBe(1);
    const v = t.store.markVerified(p.id, {
      by: "runner",
      report: { replayed: 5, diverged: 0 },
      summary: "5 of 5 match",
    });
    expect(v).toMatchObject({
      state: "verified",
      decision: "5 of 5 match",
      verification: { replayed: 5, diverged: 0 },
    });
    expect(() => t.store.markVerified(p.id, { by: "runner" })).toThrow(/is verified/);
    const r = t.store.markRejected(p.id, { by: "cli", reason: "not now" });
    expect(r).toMatchObject({ state: "rejected", decision: "not now", decided_by: "cli" });
    expect(r.verification).toEqual({ replayed: 5, diverged: 0 });
    expect(pipelineEvents(t.journal).map((e) => e.type)).toEqual([
      "proposal.validated",
      "proposal.verified",
      "proposal.rejected",
    ]);
    // A human's proposal has no dry-run requirement.
    expect(
      t.store.propose({ ...agent(SRC({ agent: policy, tag: "x" })), author: "cli", author_kind: "human" }).verify,
    ).toBeNull();
  });
});

describe("journal migration", () => {
  test("a journal from before proposals gets the table on open and keeps its versions", () => {
    const t = setup();
    t.journal.db.exec("DROP TABLE proposals");
    const ro = () => new Database(t.dbPath, { readonly: true });
    const before = ro();
    expect(readProposals.list(before)).toEqual([]);
    expect(readProposals.get(before, "pr_x")).toBeNull();
    before.close();
    t.reopen();
    expect(t.journal.latestVersion()?.version).toBe(1);
    expect(t.store.propose(agent(SRC({ message: "hello" }))).state).toBe("validated");
  });
});
