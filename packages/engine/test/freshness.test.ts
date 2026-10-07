// The engine tells whether its sources changed on disk since it started (docs/spec.md §8, D64), so the dashboard and
// `pipo ui` can ask for a restart instead of failing on routes the engine doesn't have yet.
import { afterAll, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodeStamp, codeRoots } from "../src/freshness";
import { sandbox } from "./helpers";

const box = sandbox();
afterAll(() => {
  setSystemTime();
  box.cleanup();
});

test("a stamp notices an edited, added or removed source file (re-checked at most every 5 s)", () => {
  const src = join(box.root, "src");
  mkdirSync(join(src, "deep"), { recursive: true });
  writeFileSync(join(src, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(src, "deep", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(src, "notes.md"), "not code\n");
  let now = Date.now();
  const tick = (ms: number) => {
    now += ms;
    setSystemTime(now);
  };
  setSystemTime(now);
  const stamp = new CodeStamp([src]);
  expect(stamp.stale).toBe(false);
  writeFileSync(join(src, "notes.md"), "still not code, and ignored\n");
  tick(6000);
  expect(stamp.stale).toBe(false);
  utimesSync(join(src, "deep", "b.ts"), new Date(now), new Date(now + 1000));
  // within 5 s of the last look: not re-stat'ed yet
  tick(1000);
  expect(stamp.stale).toBe(false);
  tick(5000);
  expect(stamp.stale).toBe(true);
  // and it stays stale
  expect(stamp.stale).toBe(true);

  const other = new CodeStamp([src]);
  rmSync(join(src, "a.ts"));
  tick(6000);
  expect(other.stale).toBe(true);
});

test("the engine's own sources are found in this checkout", () => {
  const roots = codeRoots();
  expect(roots.map((r) => r.split("/").slice(-2).join("/"))).toEqual(["engine/src", "runner/src", "spec/src"]);
  expect(new CodeStamp(roots).stale).toBe(false);
});
