// The in-process test harness behind `pipo test` (docs/spec.md §10.3): fixtures run through the pipeline on the dry
// run's replay core, with outputs and taps mocked, agent nodes and `transform: http` stubbed, error policies applied
// without waiting, and deterministic results.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HELPERS } from "@pipo/spec";
import { FixtureError, loadFixtures, TEST_NOW, TestPrepareError, testPipeline } from "../src";
import { sandbox } from "./helpers";

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
  (globalThis as any).__pipoTestCalls = undefined;
});

function box(files: Record<string, string>) {
  const b = sandbox();
  cleanups.push(() => b.cleanup());
  mkdirSync(b.home, { recursive: true });
  for (const [name, content] of Object.entries(files)) b.write(name, content);
  return b;
}

const PEOPLE = join(import.meta.dir, "../../../examples/people-intake/people-intake.pipo");

describe("testPipeline", () => {
  test("people-intake: delivered, rejected and dead-lettered fixtures, with the mocked tap and sqlite row", async () => {
    const b = box({});
    const report = await testPipeline({
      file: PEOPLE,
      home: b.home,
      fixtures: [
        { name: "ada", data: { name: " Ada ", age: 36 } },
        { name: "young", data: { name: "Bob", age: 20 } },
        { name: "long", data: { name: "x".repeat(201), age: 40 } },
      ],
    });
    expect(report.pipeline).toBe("people-intake");
    expect(report.counts).toEqual({
      delivered: 1,
      filtered: 0,
      rejected: 1,
      dead_lettered: 1,
      escalated: 0,
      paused: 0,
      halted: 0,
      failed: 0,
    });
    const [ada, young, long] = report.fixtures;
    const row = { id: "ada", name: "Ada", age: 36, bio: "", received_at: TEST_NOW };
    expect(ada).toEqual({
      fixture: "ada",
      outcome: "delivered",
      units: [
        {
          unit: "ada",
          branch: "",
          outcome: "delivered",
          path: ["logger", "normalize", "output"],
          data: { name: "Ada", age: 36, bio: "" },
          write: {
            key: "ada",
            to: "sqlite",
            with: {
              path: "./data/people.db",
              table: "people",
              create: true,
              mode: "upsert",
              key: "id",
              columns: row,
            },
            record: row,
          },
        },
      ],
      taps: [
        {
          unit: "ada",
          node: "logger",
          tap: "log",
          with: { level: "info", message: "Received ada via http from test" },
        },
      ],
      calls: [],
    });
    expect(young).toEqual({
      fixture: "young",
      outcome: "rejected",
      units: [],
      taps: [],
      calls: [],
      error: {
        step: "input",
        code: "input.invalid",
        message: "Rejected: rule 'data.age > 30' failed",
        rule: "data.age > 30",
      },
    });
    expect(long?.outcome).toBe("dead_lettered");
    expect(long?.units[0]?.error).toEqual({
      step: "output",
      code: "output.invalid",
      message: "Packet long failed output rule 'len(data.name) <= 200'; not written",
      rule: "len(data.name) <= 200",
      attempts: 1,
      then: "dead_letter",
    });
    // Nothing was written next to the pipeline, and no secret was resolved (PIPO_INTAKE_TOKEN is not needed).
    expect(long?.units[0]?.write).toBeUndefined();
  });

  test("route and fan-out: copies per branch, filters per copy, nothing written to disk", async () => {
    const b = box({
      "routes.pipo": `pipo: 1
name: routes
secrets:
  token: env:PIPO_TEST_SURELY_UNSET_TOKEN
input: { via: push }
nodes:
  sort:
    from: input
    route:
      big: "data.n >= 10"
      small: else
  audit: { from: sort.big, tap: log, with: { message: "big \${data.n} \${secrets.token}" } }
  double: { from: sort.big, transform: map, with: { data: { n: "\${data.n * 2}" } } }
  positive: { from: sort.small, filter: "data.n >= 0" }
output:
  from: [audit, double, positive]
  to: sqlite
  with: { path: ./out.db, table: t, create: true }
`,
    });
    const report = await testPipeline({
      file: join(b.root, "routes.pipo"),
      home: b.home,
      fixtures: [
        { name: "big", data: { n: 12 } },
        { name: "small", data: { n: 3 } },
        { name: "neg", data: { n: -1 } },
      ],
    });
    const [big, small, neg] = report.fixtures;
    expect(big?.outcome).toBe("delivered");
    expect(big?.units).toEqual([
      { unit: "big", branch: "", outcome: "branched", path: ["sort.big"], copies: ["big:audit", "big:double"] },
      {
        unit: "big:audit",
        branch: "audit",
        outcome: "delivered",
        path: ["audit", "output"],
        data: { n: 12 },
        write: {
          key: "big:audit",
          to: "sqlite",
          with: { path: "./out.db", table: "t", create: true },
          record: { n: 12, packet_id: "big:audit" },
        },
      },
      {
        unit: "big:double",
        branch: "double",
        outcome: "delivered",
        path: ["double", "output"],
        data: { n: 24 },
        write: {
          key: "big:double",
          to: "sqlite",
          with: { path: "./out.db", table: "t", create: true },
          record: { n: 24, packet_id: "big:double" },
        },
      },
    ]);
    // The secret is never resolved: it renders as the redacted placeholder.
    expect(big?.taps).toEqual([{ unit: "big:audit", node: "audit", tap: "log", with: { message: "big 12 ***" } }]);
    expect(small?.units.map((u) => [u.unit, u.outcome, u.path])).toEqual([
      ["small", "delivered", ["sort.small", "positive", "output"]],
    ]);
    expect(neg?.outcome).toBe("filtered");
    expect(neg?.units).toEqual([
      { unit: "neg", branch: "", outcome: "filtered", path: ["sort.small", "positive"], data: { n: -1 } },
    ]);
    expect(readdirSync(b.root).sort()).toEqual(["home", "routes.pipo"]);
    expect(existsSync(join(b.root, "out.db"))).toBe(false);
  });

  test("error policies: retries are counted without waiting, then drop/halt/continue/dead_letter as the runner does", async () => {
    const b = box({
      "fns.ts": `export const guard = (d) => {
  globalThis.__pipoTestCalls = (globalThis.__pipoTestCalls ?? 0) + 1;
  if (d.n < 0) throw new Error("negative " + d.n);
  return d;
};
export const stop = (d) => { if (d.n === 13) throw new Error("unlucky"); return d; };
export const gone = (d) => { if (d.n === 7) throw new Error("seven"); return d; };
`,
      "policies.pipo": `pipo: 1
name: policies
fn: ./fns.ts
errors: { retry: 2, delay: 1m, backoff: fixed, then: dead_letter, message: "failed at \${error.node} after \${error.attempts}: \${error.message}" }
input: { via: push, validate: ["exists(data.n)"] }
nodes:
  guard: { from: input, transform: fn.guard }
  note: { from: guard, tap: log, with: { message: "\${len(data.n)}" }, on_error: { then: continue } }
  stop: { from: note, transform: fn.stop, on_error: { retry: 0, then: halt } }
  gone: { from: stop, transform: fn.gone, on_error: { retry: 1, then: drop } }
output:
  from: gone
  to: stdout
`,
    });
    const started = Date.now();
    const report = await testPipeline({
      file: join(b.root, "policies.pipo"),
      home: b.home,
      fixtures: [
        { name: "ok", data: { n: 1 } },
        { name: "neg", data: { n: -1 } },
        { name: "thirteen", data: { n: 13 } },
        { name: "seven", data: { n: 7 } },
        { name: "nothing", data: { m: 1 } },
      ],
    });
    // A 1m delay twice per failure would take minutes if retries waited.
    expect(Date.now() - started).toBeLessThan(10_000);
    const by = Object.fromEntries(report.fixtures.map((f) => [f.fixture, f]));
    expect(by.ok?.outcome).toBe("delivered");
    expect(by.ok?.units[0]?.warnings).toEqual([
      {
        step: "note",
        code: "node.failed",
        message: "len() expects a string, array or object, got number",
        attempts: 3,
        then: "continue",
      },
    ]);
    expect(by.ok?.units[0]?.write).toEqual({ key: "ok", to: "stdout", with: {} });
    expect(by.neg?.outcome).toBe("dead_lettered");
    expect(by.neg?.units[0]?.error).toEqual({
      step: "guard",
      code: "node.failed",
      message: "failed at guard after 3: negative -1",
      attempts: 3,
      then: "dead_letter",
    });
    expect(by.neg?.units[0]?.path).toEqual(["guard"]);
    expect(by.thirteen?.outcome).toBe("halted");
    expect(by.thirteen?.units[0]?.error).toMatchObject({ step: "stop", attempts: 1, then: "halt" });
    expect(by.seven?.outcome).toBe("filtered");
    expect(by.seven?.units[0]?.error).toMatchObject({ step: "gone", attempts: 2, then: "drop" });
    expect(by.nothing?.outcome).toBe("rejected");
    // guard ran once for each of ok, thirteen and seven, and three times for neg.
    expect((globalThis as any).__pipoTestCalls).toBe(6);
  });

  const LOOP = `pipo: 1
name: loopy
agent_budget: { per_packet: 20000 }
input: { via: push }
nodes:
  draft:
    from: input
    agent: claude_api
    with: { model: claude-test, prompt: "Draft about \${data.topic}", schema: ./draft.schema.json }
  review:
    from: draft
    agent: claude_api
    with: { model: claude-test, prompt: "Review: \${data.text}", schema: ./review.schema.json }
    on_error: { retry: 1, delay: 1m }
    loop: { back_to: draft, until: "data.approved == true", max: 2, then: dead_letter }
output:
  from: review
  to: stdout
`;
  const loopBox = () =>
    box({
      "loopy.pipo": LOOP,
      "draft.schema.json": JSON.stringify({ type: "object", required: ["text"] }),
      "review.schema.json": JSON.stringify({
        type: "object",
        required: ["approved"],
        properties: { approved: { type: "boolean" } },
      }),
    });

  test("a loop with agent stubs as lists, consumed in call order; $error responses count as failed attempts", async () => {
    const b = loopBox();
    const report = await testPipeline({
      file: join(b.root, "loopy.pipo"),
      home: b.home,
      stubs: { draft: [{ text: "v1" }, { text: "v2" }] },
      fixtures: [
        {
          name: "twice",
          data: { topic: "cats" },
          stubs: {
            review: [{ approved: false, text: "v1" }, { $error: "overloaded" }, { approved: true, text: "v2" }],
          },
        },
        { name: "never", data: { topic: "dogs" }, stubs: { draft: { text: "same" }, review: { approved: false } } },
        { name: "short", data: { topic: "owls" }, stubs: { review: { approved: false, text: "no" } } },
        { name: "badschema", data: { topic: "rats" }, stubs: { review: { approved: "yes" } } },
      ],
    });
    const [twice, never, short, badschema] = report.fixtures;
    expect(twice?.outcome).toBe("delivered");
    expect(twice?.units[0]?.path).toEqual(["draft", "review", "draft", "review", "output"]);
    expect(twice?.units[0]?.data).toEqual({ approved: true, text: "v2" });
    expect(twice?.calls).toEqual([
      {
        unit: "twice",
        node: "draft",
        kind: "agent",
        attempt: 1,
        with: expect.objectContaining({ prompt: "Draft about cats" }),
      },
      {
        unit: "twice",
        node: "review",
        kind: "agent",
        attempt: 1,
        with: expect.objectContaining({ prompt: "Review: v1" }),
      },
      {
        unit: "twice",
        node: "draft",
        kind: "agent",
        attempt: 1,
        with: expect.objectContaining({ prompt: "Draft about " }),
      },
      {
        unit: "twice",
        node: "review",
        kind: "agent",
        attempt: 1,
        with: expect.objectContaining({ prompt: "Review: v2" }),
      },
      {
        unit: "twice",
        node: "review",
        kind: "agent",
        attempt: 2,
        with: expect.objectContaining({ prompt: "Review: v2" }),
      },
    ]);
    // A single response is used for every call: the loop runs out at max 2 (three passes).
    expect(never?.outcome).toBe("dead_lettered");
    expect(never?.units[0]?.error).toMatchObject({ step: "review", code: "loop.max", then: "dead_letter" });
    expect(never?.calls.length).toBe(6);
    // The run-wide draft list has two responses; the third pass needs another.
    expect(short?.outcome).toBe("failed");
    expect(short?.units[0]?.error).toEqual({
      step: "draft",
      code: "stub.exhausted",
      message: "stubs.draft has 2 response(s), and call 3 needs another",
      hint: "add responses to stubs.draft in fixtures/short.json (one per call, retries and loop passes included)",
    });
    // A stubbed response that misses the agent's schema is a node error under on_error (retried, then dead-lettered).
    expect(badschema?.outcome).toBe("dead_lettered");
    expect(badschema?.units[0]?.error).toMatchObject({ step: "review", attempts: 2 });
    expect(badschema?.units[0]?.error?.message).toContain("agent output does not match ./review.schema.json");
  });

  test("a missing stub fails the fixture with a hint naming the fixture file; other fixtures still run", async () => {
    const b = loopBox();
    const report = await testPipeline({
      file: join(b.root, "loopy.pipo"),
      home: b.home,
      fixtures: [
        { name: "sample", data: { topic: "x" }, file: join(b.root, "fixtures", "sample.json") },
        { name: "stubbed", data: { topic: "y" }, stubs: { draft: { text: "t" }, review: { approved: true } } },
        { name: "typo", data: { topic: "z" }, stubs: { drafts: {} } },
      ],
    });
    const [sample, stubbed, typo] = report.fixtures;
    expect(sample?.outcome).toBe("failed");
    expect(sample?.units[0]?.error).toEqual({
      step: "draft",
      code: "stub.missing",
      message: "agent node 'draft' has no stub, and a test never calls it",
      hint: 'add stubs.draft to fixtures/sample.json: {"data": …, "stubs": {"draft": <response>}} (a list gives one response per call)',
    });
    expect(stubbed?.outcome).toBe("delivered");
    expect(typo).toMatchObject({
      outcome: "failed",
      units: [],
      error: { step: "drafts", code: "stub.unknown", hint: "nodes that take a stub: draft, review" },
    });
    expect(report.counts.failed).toBe(2);
  });

  test("transform: http is stubbed too, with its rendered request recorded and secrets as ***", async () => {
    const b = box({
      "fetch.pipo": `pipo: 1
name: fetch
secrets:
  key: env:PIPO_TEST_SURELY_UNSET_KEY
input: { via: push }
nodes:
  lookup:
    from: input
    transform: http
    with: { method: GET, url: "https://example.invalid/\${data.id}?key=\${secrets.key}" }
output:
  from: lookup
  to: file
  with: { path: ./out.jsonl, format: jsonl }
`,
    });
    const report = await testPipeline({
      file: join(b.root, "fetch.pipo"),
      home: b.home,
      fixtures: [{ name: "one", data: { id: 7 }, stubs: { lookup: { id: 7, name: "seven" } } }],
    });
    const [one] = report.fixtures;
    expect(one?.outcome).toBe("delivered");
    expect(one?.calls).toEqual([
      {
        unit: "one",
        node: "lookup",
        kind: "transform",
        attempt: 1,
        with: { method: "GET", url: "https://example.invalid/7?key=***" },
      },
    ]);
    expect(one?.units[0]?.write).toEqual({
      key: "one",
      to: "file",
      with: { path: "./out.jsonl", format: "jsonl" },
    });
    expect(existsSync(join(b.root, "out.jsonl"))).toBe(false);
  });

  test("deterministic: two runs are deep-equal, and now()/iso() read the fixed clock only inside the run", async () => {
    const b = box({
      "clock.pipo": `pipo: 1
name: clock
input: { via: push }
nodes:
  stamp:
    from: input
    transform: map
    with: { data: { n: "\${data.n}", at: "\${now()}", iso: "\${iso()}", got: "\${meta.received_at}" } }
output:
  from: stamp
  to: stdout
`,
    });
    const file = join(b.root, "clock.pipo");
    const fixtures = [
      { name: "a", data: { n: 1 } },
      { name: "b", data: { n: 2 }, meta: { received_at: 5, source: "elsewhere" } },
    ];
    const one = await testPipeline({ file, home: b.home, fixtures });
    await Bun.sleep(5);
    const two = await testPipeline({ file, home: b.home, fixtures });
    expect(two).toEqual(one);
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(one.fixtures[0]?.units[0]?.data).toEqual({
      n: 1,
      at: TEST_NOW,
      iso: new Date(TEST_NOW).toISOString(),
      got: TEST_NOW,
    });
    expect(one.fixtures[1]?.units[0]?.data).toMatchObject({ got: 5 });
    const later = await testPipeline({ file, home: b.home, fixtures, now: 1_000 });
    expect(later.fixtures[0]?.units[0]?.data).toMatchObject({ at: 1_000, got: 1_000 });
    // Outside a test run the helpers read the real clock.
    const helpers = HELPERS as { now: () => number; iso: () => string };
    expect(Math.abs(helpers.now() - Date.now())).toBeLessThan(5_000);
    expect(Math.abs(Date.parse(helpers.iso()) - Date.now())).toBeLessThan(5_000);

    // The people-intake report repeats exactly too.
    const people = { file: PEOPLE, home: b.home, fixtures: [{ name: "ada", data: { name: "Ada", age: 31 } }] };
    expect(await testPipeline(people)).toEqual(await testPipeline(people));
  });

  test("a pipeline with check errors is refused before any fixture runs", async () => {
    const b = box({ "bad.pipo": "pipo: 1\nname: bad\ninput: { via: push }\noutput: { from: nowhere, to: stdout }\n" });
    const err = await testPipeline({ file: join(b.root, "bad.pipo"), home: b.home, fixtures: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(TestPrepareError);
    expect((err as TestPrepareError).diagnostics.some((d) => d.code === "P010")).toBe(true);
  });
});

describe("loadFixtures", () => {
  test("bare data and the structured form; expected.json, *.snap.json, other files and folders are skipped", () => {
    const b = box({});
    const dir = join(b.root, "fixtures");
    mkdirSync(join(dir, "nested.json"), { recursive: true });
    const put = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value));
    put("sample.json", { subject: "Server is down" });
    put("expected.json", { label: "urgent" });
    put("sample.snap.json", { outcome: "delivered" });
    put("structured.json", { data: { n: 1 }, meta: { source: "s", received_at: 9 }, stubs: { classify: [{ a: 1 }] } });
    put("datakey.json", { data: 1, other: 2 });
    put("array.json", [1, 2]);
    writeFileSync(join(dir, "notes.txt"), "not a fixture");
    const fixtures = loadFixtures(dir);
    expect(fixtures).toEqual([
      { name: "array", data: [1, 2], file: join(dir, "array.json") },
      { name: "datakey", data: { data: 1, other: 2 }, file: join(dir, "datakey.json") },
      { name: "sample", data: { subject: "Server is down" }, file: join(dir, "sample.json") },
      {
        name: "structured",
        data: { n: 1 },
        meta: { source: "s", received_at: 9 },
        stubs: { classify: [{ a: 1 }] },
        file: join(dir, "structured.json"),
      },
    ]);
    expect(loadFixtures(join(b.root, "missing"))).toEqual([]);
  });

  test("bad JSON and bad meta are clear errors", () => {
    const b = box({});
    const dir = join(b.root, "fixtures");
    mkdirSync(dir);
    writeFileSync(join(dir, "broken.json"), "{ nope");
    expect(() => loadFixtures(dir)).toThrow(FixtureError);
    expect(() => loadFixtures(dir)).toThrow(/broken\.json: not valid JSON/);
    writeFileSync(join(dir, "broken.json"), JSON.stringify({ data: {}, meta: { packet_id: "x" } }));
    expect(() => loadFixtures(dir)).toThrow(/meta\.packet_id can't be set/);
    writeFileSync(join(dir, "broken.json"), JSON.stringify({ data: {}, meta: { received_at: "soon" } }));
    expect(() => loadFixtures(dir)).toThrow(/meta\.received_at must be a number/);
  });

  test("duplicate fixture names are refused", async () => {
    const b = box({});
    const err = await testPipeline({
      file: PEOPLE,
      home: b.home,
      fixtures: [
        { name: "a", data: {} },
        { name: "a", data: {} },
      ],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(FixtureError);
    expect((err as Error).message).toContain("two fixtures are named 'a'");
  });
});

test("trace: each unit's steps with the data leaving them, routes as <id>.<branch>, copies starting from their parent", async () => {
  const b = box({
    "trace.pipo": `pipo: 1
name: trace
input: { via: push }
nodes:
  big: { from: input, filter: "data.n > 1" }
  double: { from: big, transform: map, with: { data: { n: "\${data.n * 2}" } } }
  kind: { from: double, route: { many: "data.n > 4", few: else } }
  shout: { from: kind.many, transform: map, with: { data: { n: "\${data.n}", loud: true } } }
  quiet: { from: kind.few, transform: map, with: { data: { n: "\${data.n}", loud: false } } }
  copy_a: { from: [shout, quiet], tap: log }
  copy_b: { from: [shout, quiet], tap: log }
output: { from: [copy_a, copy_b], to: stdout }
`,
  });
  const file = join(b.root, "trace.pipo");
  const fixtures = [
    { name: "small", data: { n: 1 } },
    { name: "many", data: { n: 3 } },
  ];
  const plain = await testPipeline({ file, home: b.home, fixtures });
  expect(plain.fixtures.flatMap((f) => f.units).some((u) => "steps" in u)).toBe(false);

  const report = await testPipeline({ file, home: b.home, fixtures, trace: true });
  const [small, many] = report.fixtures;
  expect(small?.outcome).toBe("filtered");
  expect(small?.units[0]?.steps).toEqual([{ step: "input", data: { n: 1 } }]);
  expect(many?.outcome).toBe("delivered");
  const [root, a, bb] = many?.units ?? [];
  expect(root?.outcome).toBe("branched");
  const shared = [
    { step: "input", data: { n: 3 } },
    { step: "big", data: { n: 3 } },
    { step: "double", data: { n: 6 } },
    { step: "kind.many", data: { n: 6 } },
    { step: "shout", data: { n: 6, loud: true } },
  ];
  expect(root?.steps).toEqual(shared);
  expect(a?.steps).toEqual([
    ...shared,
    { step: "copy_a", data: { n: 6, loud: true } },
    { step: "output", data: { n: 6, loud: true } },
  ]);
  expect(bb?.steps).toEqual([
    ...shared,
    { step: "copy_b", data: { n: 6, loud: true } },
    { step: "output", data: { n: 6, loud: true } },
  ]);
  // Everything else is as without a trace.
  const strip = (r: typeof report) => JSON.stringify(r, (k, v) => (k === "steps" ? undefined : v));
  expect(strip(report)).toBe(JSON.stringify(plain));
});
