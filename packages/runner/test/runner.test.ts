import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { gaps, type Runner, StartError } from "../src";
import { rows, sandbox, settled, startRunner } from "./helpers";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function setup() {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  return box;
}

async function run(file: string, home: string) {
  const r = await startRunner(file, home);
  cleanups.push(() => (r.runner.state === "stopped" || r.runner.state === "failed" ? undefined : r.runner.stop()));
  return r;
}

const PEOPLE = `pipo: 1
name: people
fn: ./fns.ts
input:
  via: http
  with: { path: /people, auth: { header: X-Token, equals: "\${secrets.token}" } }
  validate:
    - type(data.name) == "string"
    - data.age > 30
  on_invalid: { respond: 422, message: "bad: \${error.rule}" }
secrets:
  token: env:PIPO_TEST_TOKEN
nodes:
  log:
    from: input
    tap: log
    with: { message: "got \${data.name} token=\${secrets.token}" }
  clean:
    from: log
    transform: fn.clean
output:
  from: clean
  to: sqlite
  with:
    path: ./out.db
    table: people
    create: true
    mode: upsert
    key: id
    columns: { id: "\${meta.packet_id}", name: "\${data.name}", age: "\${data.age}" }
delivered:
  check: record_exists
  with: { where: { id: "\${meta.packet_id}" } }
`;

const FNS = `export const clean = (d) => ({ ...d, name: d.name.trim() });
export const boom = () => { throw new Error("boom"); };
let calls = 0;
export const flaky = (d) => { if (++calls < 3) throw new Error("flaky " + calls); return d; };
`;

describe("http → transform → sqlite → record_exists", () => {
  test("delivers valid packets, rejects invalid ones, redacts secrets", async () => {
    process.env.PIPO_TEST_TOKEN = "s3cret-token";
    const box = setup();
    box.write("fns.ts", FNS);
    const { runner, post, lines } = await run(box.write("people.pipo", PEOPLE), box.home);
    const auth = { "X-Token": "s3cret-token" };

    expect((await post("/people", { name: "Ada", age: 36 })).status).toBe(401);

    const ok = await post("/people", { name: "  Ada ", age: 36 }, auth);
    expect(ok.status).toBe(202);
    const { packet_id } = (await ok.json()) as { packet_id: string };
    expect((await settled(runner, packet_id)).state).toBe("delivered");
    expect(rows(join(box.root, "out.db"), "SELECT id, name, age FROM people")).toEqual([
      { id: packet_id, name: "Ada", age: 36 },
    ]);

    const bad = await post("/people", { name: "Bob", age: 20 }, auth);
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ state: "rejected", error: "bad: data.age > 30", rule: "data.age > 30" });

    expect(lines.some((l) => l.includes("Ada  token=***"))).toBe(true);
    expect(lines.join("\n")).not.toContain("s3cret-token");
    expect(runner.journal.events(packet_id).map((e) => e.type)).toEqual([
      "packet.accepted",
      "log",
      "node.done",
      "node.done",
      "output.written",
      "packet.delivered",
    ]);
  });
});

const steps = (nodes: string, extra = "") => `pipo: 1
name: steps
fn: ./fns.ts
input: { via: http }
${nodes}
output:
  from: last
  to: stdout
${extra}`;

async function send(box: ReturnType<typeof setup>, source: string, body: unknown) {
  box.write("fns.ts", FNS);
  const { runner, post } = await run(box.write("p.pipo", source), box.home);
  const res = await post("", body);
  const { packet_id } = (await res.json()) as { packet_id: string };
  return { runner, row: await settled(runner, packet_id) };
}

describe("node kinds and policies", () => {
  test("filter drops packets as filtered", async () => {
    const src = steps("nodes:\n  last:\n    from: input\n    filter: data.keep == true\n");
    expect((await send(setup(), src, { keep: false })).row.state).toBe("filtered");
  });

  test("route sends packets down the matching branch", async () => {
    const src = steps(`nodes:
  triage:
    from: input
    route: { big: data.n > 10, small: else }
  last:
    from: triage.big
    transform: map
    with: { data: { routed: big } }
`);
    const big = await send(setup(), src, { n: 50 });
    expect(big.row).toMatchObject({ state: "delivered", data: { routed: "big" } });
  });

  test("bounded loop runs until the condition holds", async () => {
    const src = steps(`nodes:
  last:
    from: input
    transform: map
    with: { data: { n: "\${data.n + 1}" } }
    loop: { back_to: last, until: data.n >= 3, max: 5 }
`);
    const { row } = await send(setup(), src, { n: 0 });
    expect(row).toMatchObject({ state: "delivered", data: { n: 3 }, iteration: 2 });
  });

  test("loop that never converges is dead-lettered at max", async () => {
    const src = steps(`nodes:
  last:
    from: input
    transform: map
    with: { data: { n: "\${data.n}" } }
    loop: { back_to: last, until: data.n > 100, max: 2 }
`);
    const { row } = await send(setup(), src, { n: 0 });
    expect(row.state).toBe("dead_lettered");
    expect(row.error).toMatchObject({ code: "loop.max", node: "last" });
  });

  test("retries with backoff, then succeeds", async () => {
    const src = steps(
      "nodes:\n  last:\n    from: input\n    transform: fn.flaky\n    on_error: { retry: 3, delay: 10ms }\n",
    );
    const { runner, row } = await send(setup(), src, { x: 1 });
    expect(row.state).toBe("delivered");
    expect(runner.journal.events(row.id).filter((e) => e.type === "step.retry")).toHaveLength(2);
  });

  test("exhausted retries dead-letter with the rendered message", async () => {
    const src = steps(
      "nodes:\n  last:\n    from: input\n    transform: fn.boom\n    on_error: { retry: 1, delay: 10ms, message: 'failed at ${error.node} after ${error.attempts}: ${error.message}' }\n",
    );
    const { row } = await send(setup(), src, {});
    expect(row.state).toBe("dead_lettered");
    expect(row.error).toMatchObject({ code: "node.failed", message: "failed at last after 2: boom", attempts: 2 });
  });

  test("then: continue lets a failing tap pass data on", async () => {
    const src = steps("nodes:\n  last:\n    from: input\n    tap: fn.boom\n    on_error: { then: continue }\n");
    expect((await send(setup(), src, { a: 1 })).row).toMatchObject({ state: "delivered", data: { a: 1 } });
  });

  test("output validation failure is not retried", async () => {
    const src = steps("nodes:\n  last:\n    from: input\n    filter: 'true'\n").replace(
      "  to: stdout\n",
      "  to: stdout\n  validate: [data.ok == true]\n  on_error: { retry: 5 }\n",
    );
    const { row } = await send(setup(), src, { ok: false });
    expect(row.error).toMatchObject({ code: "output.invalid", attempts: 1 });
  });
});

describe("refusals", () => {
  test("check errors stop the runner from starting", async () => {
    const box = setup();
    const file = box.write(
      "bad.pipo",
      "pipo: 1\nname: bad\ninput: { via: http }\noutput: { from: nope, to: stdout }\n",
    );
    const err = (await startRunner(file, box.home).catch((e) => e)) as StartError;
    expect(err).toBeInstanceOf(StartError);
    expect(err.diagnostics.map((d) => d.code)).toContain("P010");
  });

  test("features the runner lacks are refused, not ignored", () => {
    // Every feature `pipo check` accepts runs now; a definition past check (a newer spec) still meets the gate.
    const p = {
      pipo: 1,
      name: "s",
      input: { via: "mqtt" },
      output: { from: "input", to: "stdout" },
      agent: { control: true },
    } as any;
    // An `agent:` block is served by the engine's /mcp endpoint (§9.2), so it is no gap.
    expect(gaps(p)).toEqual([{ path: "input.via", feature: "input 'mqtt' (spec §3.3)", level: "refuse" }]);
  });

  test("a second runner for the same pipeline is refused", async () => {
    const box = setup();
    box.write("fns.ts", FNS);
    const file = box.write("p.pipo", steps("nodes:\n  last:\n    from: input\n    filter: 'true'\n"));
    await run(file, box.home);
    const err = (await startRunner(file, box.home).catch((e) => e)) as StartError;
    expect(err.message).toContain("already running");
  });
});

describe("lifecycle", () => {
  test("drain stops intake and lets accepted packets finish", async () => {
    const box = setup();
    box.write("fns.ts", `export const slow = async (d) => { await Bun.sleep(150); return d; };`);
    const { runner, post } = await run(
      box.write("p.pipo", steps("nodes:\n  last:\n    from: input\n    transform: fn.slow\n")),
      box.home,
    );
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(((await (await post("", { i })).json()) as { packet_id: string }).packet_id);
    const journal = runner.journal;
    const done = runner.drain();
    const refused = await post("", { late: true }).catch(() => null);
    expect(refused === null || refused.status === 503).toBe(true);
    await done;
    expect((runner as Runner).state).toBe("stopped");
    const reopened = new (journal.constructor as any)(journal.db.filename);
    expect(ids.map((id) => reopened.get(id).state)).toEqual(Array(6).fill("delivered"));
    reopened.close();
  });
});
