// System input end to end (docs/spec.md §3.3): the Rust runner binary sampling the machine. The sample shape and the
// real sampler's metrics are unit-tested in crates/pipo-runner/src/connectors/system.rs.
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sandbox, waitFor } from "./helpers";
import { RustRunner } from "./rust";

setDefaultTimeout(30_000);

const box = sandbox();
let running: RustRunner[] = [];
afterEach(async () => {
  for (const r of running) if (r.proc.exitCode === null) await r.kill();
  running = [];
});
afterAll(() => box.cleanup());

describe("system input", () => {
  test("runs under the runner and journals samples", async () => {
    const file = box.write(
      "sys.pipo",
      "pipo: 1\nname: sys\ninput: { via: system, with: { every: 100ms, metrics: [memory, cpu] } }\noutput: { from: input, to: stdout }\n",
    );
    const r = await RustRunner.start(box, file, "sys", { listen: null });
    running.push(r);
    const got = await waitFor(
      () => {
        const p = r.query<{ data: string; trigger: string; source: string }>(
          "SELECT data, trigger, source FROM packets WHERE state = 'delivered'",
        );
        return p.length >= 2 ? p : null;
      },
      10_000,
      "two samples",
    );
    for (const p of got) {
      const data = JSON.parse(p.data);
      expect(p.trigger).toBe("system");
      expect(Object.keys(data).sort()).toEqual(["cpu", "memory", "sampled_at"]);
      expect(data.memory.total).toBeGreaterThan(0);
      expect(data.sampled_at).toBe(p.source);
    }
    expect(await r.stop()).toBe(0);
  });
});
