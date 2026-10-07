// Restart policy (docs/spec.md D25): exponential backoff, reset after a stable run, give up after too many restarts.
import { expect, test } from "bun:test";
import { DEFAULT_CONFIG, RestartTracker } from "../src";

const delays = (t: RestartTracker, times: number[], upFor = 0) =>
  times.map((now) => {
    const d = t.onCrash(now, upFor);
    return d.restart ? d.delay : "give up";
  });

test("backoff doubles from `backoff` and is capped at `max_backoff`", () => {
  const t = new RestartTracker({ ...DEFAULT_CONFIG.restart, max_restarts: 100 });
  expect(delays(t, [0, 1, 2, 3, 4, 5, 6, 7])).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
});

test("a run longer than `stable` starts the backoff over", () => {
  const t = new RestartTracker({ ...DEFAULT_CONFIG.restart, max_restarts: 100 });
  expect(delays(t, [0, 1, 2])).toEqual([1000, 2000, 4000]);
  expect(t.onCrash(3, 60_000)).toEqual({ restart: true, delay: 1000, attempt: 4 });
  expect(t.onCrash(4, 10)).toEqual({ restart: true, delay: 2000, attempt: 5 });
});

test("more than `max_restarts` restarts within `window` gives up", () => {
  const t = new RestartTracker({ ...DEFAULT_CONFIG.restart, max_restarts: 3, window: 1000 });
  expect(delays(t, [0, 100, 200, 300])).toEqual([1000, 2000, 4000, "give up"]);
});

test("restarts older than `window` no longer count", () => {
  const t = new RestartTracker({ ...DEFAULT_CONFIG.restart, max_restarts: 2, window: 1000 });
  expect(delays(t, [0, 500])).toEqual([1000, 2000]);
  expect(t.onCrash(1100, 0)).toEqual({ restart: true, delay: 4000, attempt: 2 });
  expect(t.onCrash(1200, 0)).toEqual({ restart: false, restarts: 2 });
});

test("max_restarts: 0 never restarts", () => {
  const t = new RestartTracker({ ...DEFAULT_CONFIG.restart, max_restarts: 0 });
  expect(t.onCrash(0, 0)).toEqual({ restart: false, restarts: 0 });
});
