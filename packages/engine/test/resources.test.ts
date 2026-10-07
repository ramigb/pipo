import { expect, test } from "bun:test";
import { resourcesOf, sumTrees } from "../src/resources";

test("sums cpu and memory over each runner's process tree, and skips gone pids", () => {
  const ps = [
    "  1     0  0.0   100",
    " 10     1  5.0  1000",
    " 11    10 20.5  2000",
    " 12    11  1.2   500",
    " 20     1  3.0   300",
  ].join("\n");
  const r = sumTrees(ps, [10, 20, 99]);
  expect(r.get(10)).toEqual({ cpu: 26.7, rss: 3500 * 1024, procs: 3 });
  expect(r.get(20)).toEqual({ cpu: 3, rss: 300 * 1024, procs: 1 });
  expect(r.has(99)).toBe(false);
});

test("reads this process from ps", () => {
  const me = resourcesOf([process.pid]).get(process.pid);
  expect(me?.rss).toBeGreaterThan(0);
  expect(me?.procs).toBeGreaterThanOrEqual(1);
});
