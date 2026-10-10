// Chains across a crash (docs/spec.md §3.14, §7.3, D77): the sender is SIGKILLed after the receiver journaled the
// packet but before the sender committed its write (crash point `pipeline.delivered`). On restart the sender writes
// again, the receiver answers with the packet it already has, and the data exists downstream exactly once.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { out, suite } from "./core";

setDefaultTimeout(60_000);
const { box: b, start } = suite();

const SENDER = `pipo: 1
name: up
input: { via: push }
output:
  from: input
  to: pipeline
  with: { pipeline: down }
`;
const RECEIVER = `pipo: 1
name: down
inputs:
  intake: { via: pipeline, with: { from: [up] } }
output:
  from: intake
  to: sqlite
  with: { path: ./down.db, table: items, create: true }
`;

describe("chains across a crash", () => {
  test("a sender killed between the hand-off and its commit writes again; the receiver has the packet once", async () => {
    const down = await start("down", RECEIVER, { listen: null });
    const crashing = await start("up", SENDER, { listen: null, env: { PIPO_TEST_CRASH_AT: "pipeline.delivered" } });
    const { packet_id } = await crashing.push({ n: 1 });
    expect(await crashing.proc.exited).not.toBe(0);
    expect(down.query("SELECT count(*) AS n FROM packets")).toEqual([{ n: 1 }]);
    const up = await start("up", SENDER, { listen: null });
    const sent = await up.settled(packet_id, 15_000);
    expect(sent.state).toBe("delivered");
    expect(sent.result).toMatchObject({ pipeline: "down", duplicate: true });
    const id = down.query<{ id: string }>("SELECT id FROM packets")[0]?.id as string;
    expect((sent.result as { packet_id: string }).packet_id).toBe(id);
    expect((await down.settled(id)).state).toBe("delivered");
    expect(out(b.root, "down.db", "SELECT count(*) AS n FROM items")).toEqual([{ n: 1 }]);
    expect(down.query("SELECT sender, key, input FROM inbox")).toEqual([
      { sender: "up", key: packet_id, input: "intake" },
    ]);
  });
});
