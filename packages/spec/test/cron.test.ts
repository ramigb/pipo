// Cron expressions (docs/spec.md §3.3): `pipo check` parses them for P038. The runner's own copy is
// crates/pipo-runner/src/cron.rs, which runs these same cases.
import { describe, expect, test } from "bun:test";
import { nextCron, parseCron } from "../src/cron";

const at = (iso: string) => Date.parse(iso);
const next = (expr: string, after: string) => {
  const n = nextCron(parseCron(expr), at(after));
  return n === null ? null : new Date(n).toISOString();
};

describe("cron next fire (UTC)", () => {
  test("every minute and strictly-after semantics", () => {
    expect(next("* * * * *", "2026-01-01T00:00:00Z")).toBe("2026-01-01T00:01:00.000Z");
    expect(next("* * * * *", "2026-01-01T00:00:30Z")).toBe("2026-01-01T00:01:00.000Z");
  });
  test("steps and ranges", () => {
    expect(next("*/15 * * * *", "2026-01-01T10:16:00Z")).toBe("2026-01-01T10:30:00.000Z");
    expect(next("10-20/5 * * * *", "2026-01-01T10:11:00Z")).toBe("2026-01-01T10:15:00.000Z");
    expect(next("5/20 * * * *", "2026-01-01T10:26:00Z")).toBe("2026-01-01T10:45:00.000Z");
    expect(next("0 9,17 * * *", "2026-01-01T09:00:00Z")).toBe("2026-01-01T17:00:00.000Z");
  });
  test("rolls over day, month and year", () => {
    expect(next("0 0 * * *", "2026-12-31T23:59:00Z")).toBe("2027-01-01T00:00:00.000Z");
    expect(next("0 0 31 * *", "2026-04-15T00:00:00Z")).toBe("2026-05-31T00:00:00.000Z");
    expect(next("0 12 29 2 *", "2026-03-01T00:00:00Z")).toBe("2028-02-29T12:00:00.000Z");
  });
  test("day-of-week 0 and 7 are both Sunday", () => {
    // 2026-01-01 is a Thursday; the next Sunday is 2026-01-04
    expect(next("0 0 * * 0", "2026-01-01T00:00:00Z")).toBe("2026-01-04T00:00:00.000Z");
    expect(next("0 0 * * 7", "2026-01-01T00:00:00Z")).toBe("2026-01-04T00:00:00.000Z");
    expect(next("0 0 * * 5-7", "2026-01-01T00:00:00Z")).toBe("2026-01-02T00:00:00.000Z");
  });
  test("dom and dow are ORed when both are restricted", () => {
    // 15th or Monday; 2026-01-05 is a Monday
    expect(next("0 0 15 * 1", "2026-01-01T00:00:00Z")).toBe("2026-01-05T00:00:00.000Z");
    expect(next("0 0 15 * 1", "2026-01-10T00:00:00Z")).toBe("2026-01-12T00:00:00.000Z");
    expect(next("0 0 15 * 1", "2026-01-13T00:00:00Z")).toBe("2026-01-15T00:00:00.000Z");
  });
});

describe("cron parse errors", () => {
  test.each([
    ["* * * *", "expected 5"],
    ["", "expected 5"],
    ["60 * * * *", "minute"],
    ["* 24 * * *", "hour"],
    ["* * 0 * *", "day-of-month"],
    ["* * * 13 *", "month"],
    ["* * * * 8", "day-of-week"],
    ["*/0 * * * *", "step"],
    ["5-1 * * * *", "backwards"],
    ["a * * * *", "not a number"],
    ["1,,2 * * * *", "empty"],
    ["0 0 31 2 *", "never fires"],
  ])("'%s' is rejected", (expr, part) => {
    expect(() => parseCron(expr)).toThrow(part);
  });
});
