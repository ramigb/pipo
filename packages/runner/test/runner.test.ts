// The runner end to end (docs/spec.md §2.1, §3.3–§3.10, §7.3): the Rust binary behind an http input, its journal read
// read-only. http → transform → sqlite with a delivery check, node kinds and policies, refusals and drain.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { out, post, suite } from "./core";
import { RustRunner } from "./rust";

setDefaultTimeout(30_000);
const { box, start } = suite();

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
    box.write("fns.ts", FNS);
    const r = await start("people", PEOPLE, { env: { PIPO_TEST_TOKEN: "s3cret-token" } });
    const auth = { "X-Token": "s3cret-token" };

    expect((await r.post("/people", { name: "Ada", age: 36 })).status).toBe(401);

    const ok = await r.post("/people", { name: "  Ada ", age: 36 }, auth);
    expect(ok.status).toBe(202);
    const { packet_id } = (await ok.json()) as { packet_id: string };
    expect((await r.settled(packet_id)).state).toBe("delivered");
    expect(out(box.root, "out.db", "SELECT id, name, age FROM people")).toEqual([
      { id: packet_id, name: "Ada", age: 36 },
    ]);

    const bad = await r.post("/people", { name: "Bob", age: 20 }, auth);
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ state: "rejected", error: "bad: data.age > 30", rule: "data.age > 30" });

    expect(r.lines().some((l) => l.includes("Ada  token=***"))).toBe(true);
    expect(r.lines().join("\n")).not.toContain("s3cret-token");
    expect(r.stderr()).not.toContain("s3cret-token");
    expect(r.events(packet_id).map((e) => e.type)).toEqual([
      "packet.accepted",
      "log",
      "node.done",
      "node.done",
      "output.written",
      "packet.delivered",
    ]);
    const journaled = r.query<{ detail: string | null }>("SELECT detail FROM events").map((e) => e.detail ?? "");
    expect(journaled.join("\n")).not.toContain("s3cret-token");
  });
});

let n = 0;
const steps = (name: string, nodes: string, extra = "") => `pipo: 1
name: ${name}
fn: ./fns.ts
input: { via: http }
${nodes}
output:
  from: last
  to: stdout
${extra}`;

async function send(nodes: string, body: unknown, edit = (s: string) => s) {
  box.write("fns.ts", FNS);
  const name = `steps${++n}`;
  const r = await start(name, edit(steps(name, nodes)));
  const id = await post(r, body);
  return { r, row: await r.settled(id) };
}

describe("node kinds and policies", () => {
  test("filter drops packets as filtered", async () => {
    expect(
      (await send("nodes:\n  last:\n    from: input\n    filter: data.keep == true\n", { keep: false })).row.state,
    ).toBe("filtered");
  });

  test("route sends packets down the matching branch", async () => {
    const big = await send(
      `nodes:
  triage:
    from: input
    route: { big: data.n > 10, small: else }
  last:
    from: triage.big
    transform: map
    with: { data: { routed: big } }
`,
      { n: 50 },
    );
    expect(big.row).toMatchObject({ state: "delivered", data: { routed: "big" } });
  });

  test("bounded loop runs until the condition holds", async () => {
    const { row } = await send(
      `nodes:
  last:
    from: input
    transform: map
    with: { data: { n: "\${data.n + 1}" } }
    loop: { back_to: last, until: data.n >= 3, max: 5 }
`,
      { n: 0 },
    );
    expect(row).toMatchObject({ state: "delivered", data: { n: 3 }, iteration: 2 });
  });

  test("loop that never converges is dead-lettered at max", async () => {
    const { row } = await send(
      `nodes:
  last:
    from: input
    transform: map
    with: { data: { n: "\${data.n}" } }
    loop: { back_to: last, until: data.n > 100, max: 2 }
`,
      { n: 0 },
    );
    expect(row.state).toBe("dead_lettered");
    expect(row.error).toMatchObject({ code: "loop.max", node: "last" });
  });

  test("retries with backoff, then succeeds", async () => {
    const { r, row } = await send(
      "nodes:\n  last:\n    from: input\n    transform: fn.flaky\n    on_error: { retry: 3, delay: 10ms }\n",
      { x: 1 },
    );
    expect(row.state).toBe("delivered");
    expect(r.events(row.id).filter((e) => e.type === "step.retry")).toHaveLength(2);
  });

  test("exhausted retries dead-letter with the rendered message", async () => {
    const { row } = await send(
      "nodes:\n  last:\n    from: input\n    transform: fn.boom\n    on_error: { retry: 1, delay: 10ms, message: 'failed at ${error.node} after ${error.attempts}: ${error.message}' }\n",
      {},
    );
    expect(row.state).toBe("dead_lettered");
    expect(row.error).toMatchObject({ code: "node.failed", message: "failed at last after 2: boom", attempts: 2 });
  });

  test("then: continue lets a failing tap pass data on", async () => {
    const { row } = await send(
      "nodes:\n  last:\n    from: input\n    tap: fn.boom\n    on_error: { then: continue }\n",
      {
        a: 1,
      },
    );
    expect(row).toMatchObject({ state: "delivered", data: { a: 1 } });
  });

  test("output validation failure is not retried", async () => {
    const { row } = await send("nodes:\n  last:\n    from: input\n    filter: 'true'\n", { ok: false }, (s) =>
      s.replace("  to: stdout\n", "  to: stdout\n  validate: [data.ok == true]\n  on_error: { retry: 5 }\n"),
    );
    expect(row.error).toMatchObject({ code: "output.invalid", attempts: 1 });
  });
});

describe("refusals", () => {
  test("check errors stop the runner from starting (exit 1)", async () => {
    const file = box.write(
      "bad.pipo",
      "pipo: 1\nname: bad\ninput: { via: http }\noutput: { from: nope, to: stdout }\n",
    );
    const res = await RustRunner.refuse(box, file);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("P010");
  });

  test("a second runner for the same pipeline is refused", async () => {
    box.write("fns.ts", FNS);
    const r = await start("twice", steps("twice", "nodes:\n  last:\n    from: input\n    filter: 'true'\n"));
    const res = await RustRunner.refuse(box, `${box.root}/twice.pipo`, { args: ["--listen", "0"] });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("already running");
    expect((await r.status()).state).toBe("active");
  });
});

describe("lifecycle", () => {
  test("drain stops intake and lets accepted packets finish", async () => {
    box.write(
      "slow.ts",
      "export const slow = async (d) => { await new Promise((r) => setTimeout(r, 150)); return d; };",
    );
    const r = await start(
      "draining",
      steps("draining", "nodes:\n  last:\n    from: input\n    transform: fn.slow\n").replace("./fns.ts", "./slow.ts"),
    );
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await post(r, { i }));
    await r.request("drain");
    const refused = await r.post("", { late: true }).catch(() => null);
    expect(refused === null || refused.status === 503).toBe(true);
    r.client.close();
    expect(await r.proc.exited).toBe(0);
    const states = r.query<{ state: string }>("SELECT state FROM packets ORDER BY id").map((x) => x.state);
    expect(states).toEqual(Array(6).fill("delivered"));
    expect(r.lines().some((l) => l.includes("stopped"))).toBe(true);
  });
});
