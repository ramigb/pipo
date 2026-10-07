import { afterEach, describe, expect, test } from "bun:test";
import { load, type Pipeline } from "@pipo/spec";
import { gaps, Runner } from "../src";
import { osSampler, SystemInput } from "../src/connectors/system-input";
import { rows, sandbox, waitFor } from "./helpers";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const pipe = (input: string) => `pipo: 1\nname: sys\ninput: ${input}\noutput: { from: input, to: stdout }\n`;

describe("system input", () => {
  test("has no gaps", () => {
    const p = load(pipe("{ via: system, with: { every: 1m } }")).value as Pipeline;
    expect(gaps(p)).toEqual([]);
  });

  test("an injected sampler yields samples with the expected shape", async () => {
    let n = 0;
    const got: any[] = [];
    const input = new SystemInput({
      every: "20ms",
      metrics: ["cpu", "battery"],
      sampler: (m) => ({ ...Object.fromEntries(m.map((k) => [k, k === "battery" ? null : { n: n }])), calls: ++n }),
    });
    await input.start(async (data, origin) => {
      got.push({ data, origin });
      return { status: "accepted", packet_id: `p${got.length}` };
    });
    await waitFor(() => got.length >= 2, 5000, "two samples");
    await input.stop();
    for (const g of got) {
      expect(g.origin.trigger).toBe("system");
      expect(Object.keys(g.data).sort()).toEqual(["battery", "calls", "cpu", "sampled_at"]);
      expect(g.data.battery).toBeNull();
      expect(g.data.sampled_at).toBe(g.origin.source);
    }
    const count = got.length;
    await Bun.sleep(60);
    expect(got.length).toBe(count);
  });

  test("the real sampler never throws and returns every requested metric", async () => {
    const s = await osSampler()(["cpu", "memory", "disk", "battery", "network"]);
    expect(Object.keys(s).sort()).toEqual(["battery", "cpu", "disk", "memory", "network"]);
    expect((s.memory as any).total).toBeGreaterThan(0);
  });

  test("runs under the runner and journals samples", async () => {
    const box = sandbox();
    cleanups.push(() => box.cleanup());
    const file = box.write("s.pipo", pipe("{ via: system, with: { every: 100ms, metrics: [memory] } }"));
    const runner = await Runner.open({ file, home: box.home, log: () => {} });
    await runner.start();
    cleanups.push(() => (runner.state === "stopped" ? undefined : runner.stop()));
    const db = `${box.home}/pipelines/sys/journal.db`;
    await waitFor(
      () => rows(db, "SELECT id FROM packets WHERE state = 'delivered'").length >= 2,
      10_000,
      "two samples",
    );
    const r = rows(db, "SELECT data, trigger FROM packets")[0];
    expect(r.trigger).toBe("system");
    expect(JSON.parse(r.data).memory.total).toBeGreaterThan(0);
    await runner.stop();
  });
});
