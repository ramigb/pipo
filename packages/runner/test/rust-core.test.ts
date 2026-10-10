// The Rust runner's core semantics end to end (docs/spec.md §2.1, §3.4, §3.9, §7.3): the binary, driven over its
// control socket with a push input and a stdout output, `fn` code in its embedded QuickJS.
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sandbox, waitFor } from "./helpers";
import { RustRunner } from "./rust";

// A runner start compiles through Bun, which can hang once in a while under WSL and is then retried (compile.rs).
setDefaultTimeout(30_000);

const box = sandbox();
let running: RustRunner[] = [];
afterEach(async () => {
  for (const r of running) if (r.proc.exitCode === null) await r.kill();
  running = [];
});
afterAll(() => box.cleanup());

const FNS = `
export const clean = (d) => ({ ...d, name: d.name.trim() });
export const boom = () => { throw new Error("boom"); };
let calls = 0;
export const flaky = (d) => { if (++calls < 3) throw new Error("flaky " + calls); return d; };
export const inc = (d) => ({ ...d, n: (d.n ?? 0) + 1 });
export const slow = (d) => { const t = Date.now(); while (Date.now() - t < 40) {} return d; };
export const later = async (d) => ({ ...d, later: await Promise.resolve(true) });
`;

let n = 0;
async function start(body: string, fns = FNS) {
  const name = `p${++n}`;
  box.write("fns.ts", fns);
  const file = box.write(`${name}.pipo`, `pipo: 1\nname: ${name}\nfn: ./fns.ts\ninput: { via: push }\n${body}`);
  const r = await RustRunner.start(box, file, name, { listen: null });
  running.push(r);
  return r;
}

const outputFrom = (from: string) => `output:\n  from: ${from}\n  to: stdout\n`;

describe("node kinds", () => {
  test("transform, filter, route and map", async () => {
    const r = await start(`nodes:
  clean: { from: input, transform: fn.clean }
  adults: { from: clean, filter: "data.age >= 18" }
  kind:
    from: adults
    route: { senior: "data.age >= 65", else: else }
  label_senior: { from: kind.senior, transform: map, with: { data: { name: "\${upper(data.name)}", senior: true } } }
${outputFrom("[label_senior, kind.else]")}`);
    const a = await r.push({ name: "  Ada ", age: 70 });
    const b = await r.push({ name: "Bob", age: 30 });
    const c = await r.push({ name: "Kid", age: 10 });
    expect((await r.settled(a.packet_id)).data).toEqual({ name: "ADA", senior: true });
    expect((await r.settled(b.packet_id)).data).toEqual({ name: "Bob", age: 30 });
    expect((await r.settled(c.packet_id)).state).toBe("filtered");
    await waitFor(() => r.lines().some((l) => l.includes('"name":"ADA"')), 5000, "stdout line");
    expect(r.events(a.packet_id).map((e) => e.type)).toEqual([
      "packet.accepted",
      "node.done",
      "node.done",
      "node.done",
      "node.done",
      "output.written",
      "packet.delivered",
    ]);
  });

  test("an async fn is awaited", async () => {
    const r = await start(`nodes:
  l: { from: input, transform: fn.later }
${outputFrom("l")}`);
    const ok = await r.push({ x: 1 });
    expect((await r.settled(ok.packet_id)).data).toEqual({ x: 1, later: true });
  });

  test("validate rejects with the rule and a rendered message", async () => {
    const name = `p${++n}`;
    const file = box.write(
      `${name}.pipo`,
      `pipo: 1
name: ${name}
input:
  via: push
  validate: ["type(data.name) == 'string'"]
  on_invalid: { message: "bad: \${error.rule}" }
${outputFrom("input")}`,
    );
    const r = await RustRunner.start(box, file, name, { listen: null });
    running.push(r);
    await expect(r.push({ name: 3 })).rejects.toThrow("bad: type(data.name) == 'string'");
    const [row] = r.query("SELECT state, error FROM packets");
    expect(row.state).toBe("rejected");
  });
});

describe("policies", () => {
  test("retries, then dead-letters with the policy message; a DLQ replay delivers", async () => {
    const r = await start(`nodes:
  f:
    from: input
    transform: fn.flaky
    on_error: { retry: 1, delay: 10ms, message: "flaky failed: \${error.message}" }
${outputFrom("f")}`);
    const p = await r.push({ a: 1 });
    const row = await r.settled(p.packet_id);
    expect(row.state).toBe("dead_lettered");
    expect(row.error).toMatchObject({ code: "node.failed", message: "flaky failed: flaky 2", node: "f", attempts: 2 });
    const res = await r.request("replay", { ids: [p.packet_id], by: "test" });
    expect(res.replayed).toBe(1);
    expect((await r.settled(p.packet_id)).state).toBe("delivered");
  });

  test("then: drop, continue (taps) and pause", async () => {
    const r = await start(`nodes:
  t: { from: input, tap: fn.boom, on_error: { then: continue } }
  d: { from: t, transform: fn.boom, on_error: { then: pause } }
${outputFrom("d")}`);
    const p = await r.push({ a: 1 });
    await waitFor(async () => (await r.status()).state === "paused", 5000, "pause");
    expect((await r.status()).paused_reason).toBe("error at d");
    expect(r.events(p.packet_id).map((e) => e.type)).toContain("node.failed_continued");
    expect(r.packet(p.packet_id)?.state).toBe("processing");
  });

  test("then: agent escalates; resolve retry and dead_letter", async () => {
    const r = await start(`nodes:
  x: { from: input, transform: fn.boom, on_error: { then: agent } }
agent: { control: true }
${outputFrom("x")}`);
    const a = await r.push({ a: 1 });
    const b = await r.push({ b: 1 });
    await waitFor(() => r.packet(b.packet_id)?.state === "escalated", 5000, "escalation");
    await waitFor(() => r.packet(a.packet_id)?.state === "escalated", 5000, "escalation");
    const res = await r.request("resolve", { ids: [a.packet_id], action: "dead_letter", by: "test" });
    expect(res.resolved[0]).toMatchObject({ packet_id: a.packet_id, state: "dead_lettered", node: "x" });
    await r.request("resolve", { ids: [b.packet_id], action: "retry", by: "test" });
    await waitFor(() => r.packet(b.packet_id)?.state === "escalated", 5000, "escalated again");
    await expect(r.request("resolve", { ids: [a.packet_id], action: "drop" })).rejects.toThrow("not waiting");
  });

  test("loops count iterations and fail at max", async () => {
    const r = await start(`nodes:
  step:
    from: input
    transform: fn.inc
    loop: { back_to: step, until: "data.n >= 3", max: 5 }
  never:
    from: step
    transform: fn.inc
    loop: { back_to: never, until: "false", max: 2 }
${outputFrom("never")}`);
    const p = await r.push({ n: 0 });
    const row = await r.settled(p.packet_id);
    expect(row.state).toBe("dead_lettered");
    expect(row.error?.code).toBe("loop.max");
    // `iteration` is per unit, not per loop: the second loop starts where the first one's count ended (as in TS).
    expect(row.data).toMatchObject({ n: 3 });
  });
});

describe("fan-out", () => {
  test("copies settle their packet; a dead copy dead-letters it", async () => {
    const r = await start(`nodes:
  a: { from: input, transform: fn.clean }
  b: { from: input, transform: fn.boom }
${outputFrom("[a, b]")}`);
    const p = await r.push({ name: " x " });
    const row = await r.settled(p.packet_id);
    expect(row.state).toBe("dead_lettered");
    expect(row.error?.code).toBe("branch.dead_lettered");
    const copies = r.query("SELECT id, state FROM packets WHERE root = ? ORDER BY id", p.packet_id);
    expect(copies).toEqual([
      { id: `${p.packet_id}:a`, state: "delivered" },
      { id: `${p.packet_id}:b`, state: "dead_lettered" },
    ]);
  });
});

describe("lifecycle", () => {
  test("pause holds packets; resume delivers them", async () => {
    const r = await start(outputFrom("input"));
    expect(await r.request<Record<string, unknown>>("pause", { reason: "manual" })).toEqual({
      state: "paused",
      already: false,
    });
    const p = await r.push({ a: 1 });
    await Bun.sleep(200);
    expect(r.packet(p.packet_id)?.state).toBe("accepted");
    await r.request("resume");
    expect((await r.settled(p.packet_id)).state).toBe("delivered");
  });

  test("external acks deliver; a missing ack dead-letters at the deadline", async () => {
    const r = await start(`${outputFrom("input")}delivered: { check: external, within: 400ms }\n`);
    const a = await r.push({ a: 1 });
    const b = await r.push({ b: 1 });
    await waitFor(() => r.packet(a.packet_id)?.state === "verifying", 5000, "verifying");
    expect(await r.request("ack", { packet_id: a.packet_id })).toMatchObject({ acked: true, already: false });
    expect((await r.settled(a.packet_id)).state).toBe("delivered");
    const late = await r.settled(b.packet_id);
    expect(late.state).toBe("dead_lettered");
    expect(late.error?.code).toBe("delivery.unverified");
  });

  test("apply and rollback switch versions; in-flight packets keep theirs", async () => {
    const r = await start(`nodes:
  x: { from: input, transform: map, with: { data: { v: 1 } } }
${outputFrom("x")}`);
    const name = r.name;
    const v2 = `pipo: 1\nname: ${name}\nfn: ./fns.ts\ninput: { via: push }\nnodes:\n  x: { from: input, transform: map, with: { data: { v: 2 } } }\n${outputFrom("x")}`;
    const applied = await r.request("apply", { source: v2, reason: "v2", by: "test" });
    expect(applied).toMatchObject({ version: 2, previous: 1, changed: true });
    const p = await r.push({});
    expect((await r.settled(p.packet_id)).data).toEqual({ v: 2 });
    const back = await r.request("rollback", { version: 1, by: "test" });
    expect(back).toMatchObject({ version: 3, rolled_back_to: 1, changed: true });
    const q = await r.push({});
    expect((await r.settled(q.packet_id)).data).toEqual({ v: 1 });
    await expect(r.request("apply", { source: "pipo: 1\nname: other\n" })).rejects.toThrow("pipo check");
  });

  test("SIGTERM drains and exits 0; SIGKILL loses nothing", async () => {
    const r = await start(`concurrency: 2
nodes:
  s: { from: input, transform: fn.slow }
${outputFrom("s")}`);
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push((await r.push({ i })).packet_id);
    await r.kill();
    const pending = r.query<{ n: number }>("SELECT COUNT(*) AS n FROM packets WHERE state != 'delivered'")[0]?.n ?? 0;
    expect(pending).toBeGreaterThan(0);
    const file = `${box.root}/${r.name}.pipo`;
    const again = await RustRunner.start(box, file, r.name, { listen: null });
    running.push(again);
    await waitFor(
      () => again.query<{ n: number }>("SELECT COUNT(*) AS n FROM packets WHERE state = 'delivered'")[0]?.n === 20,
      15_000,
      "all delivered",
    );
    expect(await again.stop()).toBe(0);
    expect(again.lines().some((l) => l.includes("stopped"))).toBe(true);
  });
});
