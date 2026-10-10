// Schedule input end to end (docs/spec.md §3.3): the Rust runner binary on short real `every:` durations. Cron timing
// (wall-clock ticks, early wake-ups, ticks skipped after a suspend) is unit-tested in
// crates/pipo-runner/src/connectors/schedule.rs and cron parsing in crates/pipo-runner/src/cron.rs.
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

const pipe = (name: string, input: string) =>
  `pipo: 1\nname: ${name}\ninput: ${input}\noutput: { from: input, to: stdout }\n`;

describe("schedule input", () => {
  test("every produces packets with the fixed payload, delivered to the output", async () => {
    const file = box.write(
      "tick.pipo",
      pipe("tick", "{ via: schedule, with: { every: 100ms, payload: { kind: ping, n: 1 } } }"),
    );
    const r = await RustRunner.start(box, file, "tick", { listen: null });
    running.push(r);
    const ids = await waitFor(
      () => {
        const got = r.query<{ id: string }>("SELECT id FROM packets WHERE state = 'delivered'");
        return got.length >= 2 ? got.map((x) => x.id) : null;
      },
      10_000,
      "two delivered ticks",
    );
    for (const id of ids) {
      const row = await r.settled(id);
      expect(row.data).toEqual({ kind: "ping", n: 1 });
      expect(row.trigger).toBe("schedule");
    }
    const sources = r.query<{ source: string }>("SELECT source FROM packets").map((x) => x.source);
    expect(new Set(sources).size).toBe(sources.length);
    // A tick's source is the time it was due (ISO).
    expect(sources.every((s) => !Number.isNaN(Date.parse(s)))).toBe(true);
    await waitFor(() => r.lines().some((l) => l.includes('"kind":"ping"')), 5000, "stdout line");
    expect(await r.stop()).toBe(0);
  });

  test("an invalid cron refuses to start", async () => {
    const file = box.write("bad.pipo", pipe("bad", "{ via: schedule, with: { cron: '99 * * * *' } }"));
    const res = await RustRunner.refuse(box, file);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("P038");
    expect(res.stderr).toContain("minute");
  });
});
