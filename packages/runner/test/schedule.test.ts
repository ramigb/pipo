import { afterEach, describe, expect, test } from "bun:test";
import { load, type Pipeline } from "@pipo/spec";
import { type Clock, gaps, Runner } from "../src";
import { ScheduleInput } from "../src/connectors/schedule-input";
import { rows, sandbox, settled, waitFor } from "./helpers";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const pipe = (input: string) => `pipo: 1\nname: tick\ninput: ${input}\noutput: { from: input, to: stdout }\n`;

describe("schedule input", () => {
  test("has no gaps", () => {
    const p = load(pipe("{ via: schedule, with: { every: 1m } }")).value as Pipeline;
    expect(gaps(p)).toEqual([]);
  });

  test("every produces packets with the fixed payload, delivered to the output", async () => {
    const box = sandbox();
    cleanups.push(() => box.cleanup());
    const file = box.write("t.pipo", pipe("{ via: schedule, with: { every: 100ms, payload: { kind: ping, n: 1 } } }"));
    const lines: string[] = [];
    const runner = await Runner.open({ file, home: box.home, log: (l) => lines.push(l) });
    await runner.start();
    cleanups.push(() => (runner.state === "stopped" ? undefined : runner.stop()));
    const db = `${box.home}/pipelines/tick/journal.db`;
    const ids = await waitFor(
      () => {
        const r = rows(db, "SELECT id FROM packets WHERE state = 'delivered'");
        return r.length >= 2 ? r.map((x) => x.id as string) : null;
      },
      10_000,
      "two delivered ticks",
    );
    for (const id of ids) {
      const row = await settled(runner, id);
      expect(row.data).toEqual({ kind: "ping", n: 1 });
      expect(row.trigger).toBe("schedule");
    }
    const sources = rows(db, "SELECT source FROM packets").map((r) => r.source);
    expect(new Set(sources).size).toBe(sources.length);
    expect(lines.some((l) => l.includes('"kind":"ping"'))).toBe(true);
    await runner.stop();
  });

  test("an invalid cron refuses to start", async () => {
    const box = sandbox();
    cleanups.push(() => box.cleanup());
    const file = box.write("t.pipo", pipe("{ via: schedule, with: { cron: '99 * * * *' } }"));
    const err = (await Runner.open({ file, home: box.home }).catch((e) => e)) as Error;
    expect(err.message).toContain("1 error");
  });
});

/** A hand-cranked clock: timers run only when the test advances time. */
function fakeClock(start: number) {
  let now = start;
  let pending: { at: number; fn: () => void } | undefined;
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      pending = { at: now + ms, fn };
      return pending;
    },
    clearTimeout: () => {
      pending = undefined;
    },
  };
  return {
    clock,
    get wake() {
      return pending?.at;
    },
    /** Move to the pending timer's time (plus `extra` ms) and run it. */
    async fire(extra = 0) {
      const p = pending;
      if (!p) throw new Error("no timer armed");
      pending = undefined;
      now = p.at + extra;
      p.fn();
      await Bun.sleep(0);
    },
    jump(to: number) {
      now = to;
    },
  };
}

describe("schedule input with an injected clock", () => {
  const seen: { payload: unknown; source: string }[] = [];
  const intake = async (payload: unknown, origin: { source: string }) => {
    seen.push({ payload, source: origin.source });
    return { status: "accepted" as const, packet_id: "x" };
  };

  test("cron fires at each wall-clock tick, once per tick", async () => {
    seen.length = 0;
    const t = Date.parse("2026-03-01T08:59:30Z");
    const fc = fakeClock(t);
    const input = new ScheduleInput({ cron: "0 9 * * 1-5", payload: { a: 1 }, clock: fc.clock });
    await input.start(intake);
    expect(new Date(fc.wake as number).toISOString()).toBe("2026-03-02T09:00:00.000Z"); // Sunday -> Monday
    await fc.fire(-5); // timer wakes a few ms early: must not repeat the tick
    expect(seen).toEqual([{ payload: { a: 1 }, source: "2026-03-02T09:00:00.000Z" }]);
    expect(new Date(fc.wake as number).toISOString()).toBe("2026-03-03T09:00:00.000Z");
    await input.stop();
  });

  test("ticks missed while suspended are skipped, not replayed", async () => {
    seen.length = 0;
    const fc = fakeClock(Date.parse("2026-03-02T09:00:00Z"));
    const logs: string[] = [];
    const input = new ScheduleInput({ every: "1m", clock: fc.clock, log: (_l, m) => logs.push(m) });
    await input.start(intake);
    await fc.fire(); // tick at 09:01
    await fc.fire(8.5 * 60_000); // the 09:02 timer wakes at 09:10:30 after a suspend
    expect(seen.length).toBe(2);
    expect(new Date(fc.wake as number).toISOString()).toBe("2026-03-02T09:11:00.000Z");
    expect(logs.some((l) => l.includes("skipped"))).toBe(true);
    await input.stop();
  });

  test("stop cancels the timer", async () => {
    const fc = fakeClock(0);
    const input = new ScheduleInput({ every: "1s", clock: fc.clock });
    await input.start(intake);
    await input.stop();
    expect(fc.wake).toBeUndefined();
  });
});
