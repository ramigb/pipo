// Chains (docs/spec.md §3.14, D77): `to: pipeline` hands each packet to another pipeline's `via: pipeline` input
// over its control socket, exactly once (the receiver dedups on sender and key), and `delivered.check: downstream`
// waits for the receiver to deliver it.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { out, suite } from "./core";
import { waitFor } from "./helpers";

setDefaultTimeout(30_000);
const { box: b, start } = suite();

const sender = (name: string, to: string, extra = "") => `pipo: 1
name: ${name}
input: { via: push }
output:
  from: input
  to: pipeline
  with: { pipeline: ${to} }
  on_error: { retry: 30, delay: 200ms }
${extra}`;

const receiver = (name: string, from: string[], extra = "") => `pipo: 1
name: ${name}
inputs:
  intake:
    via: pipeline
    with: { from: [${from.join(", ")}] }
    validate: [exists(data.n)]
nodes:
  stamp:
    from: intake
    transform: map
    with: { data: { n: "\${data.n}", source: "\${meta.source}", trigger: "\${meta.trigger}", up: "\${meta.upstream.packet_id}", depth: "\${meta.upstream.depth}" } }
output:
  from: stamp
  to: sqlite
  with: { path: ./${name}.db, table: items, create: true }
${extra}`;

describe("chains", () => {
  test("a packet is handed over once; the receiver sees its sender; a repeated write is a duplicate", async () => {
    const store = await start("store", receiver("store", ["intake"]), { listen: null });
    const intake = await start("intake", sender("intake", "store"), { listen: null });
    const { packet_id } = await intake.push({ n: 7 });
    const sent = await intake.settled(packet_id);
    expect(sent.state).toBe("delivered");
    expect(sent.result).toMatchObject({ pipeline: "store", duplicate: false });
    const theirs = (sent.result as { packet_id: string }).packet_id;
    expect((await store.settled(theirs)).state).toBe("delivered");
    expect(out(b.root, "store.db", "SELECT n, source, trigger, up, depth FROM items")).toEqual([
      { n: 7, source: "intake", trigger: "pipeline", up: packet_id, depth: 1 },
    ]);
    expect(store.packet(theirs)).toMatchObject({ trigger: "pipeline", source: "intake", input: "intake" });
    // The same key again (a retry after a crash) gets the packet the first write made.
    const again = await store.request("deliver", { from: "intake", key: packet_id, data: { n: 7 } });
    expect(again).toEqual({ packet_id: theirs, duplicate: true, state: "delivered" });
    expect(store.query("SELECT count(*) AS n FROM packets")).toEqual([{ n: 1 }]);
  });

  test("a sender the receiver doesn't list is refused, and nothing is journaled", async () => {
    const store = await start("strict", receiver("strict", ["someone-else"]), { listen: null });
    const e = await store.request("deliver", { from: "intruder", key: "k1", data: { n: 1 } }).catch((x) => x);
    expect(e).toMatchObject({ code: "rejected" });
    expect(String(e.message)).toContain("doesn't take packets from 'intruder'");
    const deep = await store
      .request("deliver", { from: "someone-else", key: "k2", data: { n: 1 }, upstream: { depth: 17 } })
      .catch((x) => x);
    expect(deep).toMatchObject({ code: "rejected" });
    expect(store.query("SELECT count(*) AS n FROM packets")).toEqual([{ n: 0 }]);
  });

  test("a receiver that is down: the sender retries and delivers once it is up", async () => {
    const intake = await start("early", sender("early", "late"), { listen: null });
    const { packet_id } = await intake.push({ n: 1 });
    await waitFor(() => intake.events(packet_id).some((e) => e.type === "step.retry"), 10_000, "a retry");
    expect(intake.packet(packet_id)?.state).not.toBe("delivered");
    const log = intake.lines().join("\n");
    expect(log).toContain("pipeline 'late' is not running");
    const late = await start("late", receiver("late", ["early"]), { listen: null });
    expect((await intake.settled(packet_id, 15_000)).state).toBe("delivered");
    await waitFor(() => late.query("SELECT count(*) AS n FROM packets")[0].n === 1, 5000, "the receiver's packet");
  });

  test("a packet the receiver rejects is a write error that names it", async () => {
    await start("picky", receiver("picky", ["loose"]), { listen: null });
    const intake = await start(
      "loose",
      sender("loose", "picky").replace("retry: 30, delay: 200ms", "retry: 1, delay: 10ms"),
      { listen: null },
    );
    const { packet_id } = await intake.push({ other: 1 });
    const row = await intake.settled(packet_id);
    expect(row.state).toBe("dead_lettered");
    expect(row.error?.message).toContain("pipeline 'picky' rejected the packet (downstream_rejected)");
  });

  test("check: downstream passes once the receiver delivers, and fails at once when it dead-letters", async () => {
    // The receiver dead-letters n = 0 at its sqlite output (a NOT NULL column it can't fill).
    await start(
      "end",
      receiver("end", ["front"]).replace(
        "  with: { path: ./end.db, table: items, create: true }",
        "  validate: [data.n != 0]\n  on_invalid: { then: dead_letter }\n  with: { path: ./end.db, table: items, create: true }",
      ),
      { listen: null },
    );
    const front = await start(
      "front",
      sender("front", "end", "delivered:\n  check: downstream\n  within: 20s\n  on_fail: { then: dead_letter }\n"),
      { listen: null },
    );
    const good = await front.push({ n: 1 });
    expect((await front.settled(good.packet_id, 15_000)).state).toBe("delivered");
    const started = Date.now();
    const bad = await front.push({ n: 0 });
    const row = await front.settled(bad.packet_id, 15_000);
    expect(row.state).toBe("dead_lettered");
    expect(row.error?.message).toContain("pipeline 'end' ended packet");
    expect(row.error?.message).toContain("dead_lettered");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
