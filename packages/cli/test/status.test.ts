// Unit tests for the `pipo status` table (docs/spec.md §6) and the log node filter.
import { expect, test } from "bun:test";
import { nodeFilter } from "../src/lifecycle";
import {
  formatAgo,
  formatCount,
  formatMs,
  formatUptime,
  renderDetail,
  renderStatus,
  type StatusRow,
} from "../src/status";

const row = (r: Partial<StatusRow>): StatusRow => ({
  name: "p",
  state: "active",
  version: 1,
  uptime: null,
  in_per_min: null,
  pending: null,
  delivered: null,
  dlq: null,
  last_delivery_at: null,
  note: null,
  ...r,
});

test("formats counts with thousands separators and a dash for unknown", () => {
  expect(formatCount(5112)).toBe("5,112");
  expect(formatCount(0)).toBe("0");
  expect(formatCount(null)).toBe("-");
});

test("formats uptime and ages like the spec example", () => {
  expect(formatUptime(724)).toBe("12m04s");
  expect(formatUptime(7800)).toBe("2h10m");
  expect(formatUptime(9)).toBe("9s");
  expect(formatUptime(null)).toBe("-");
  expect(formatAgo(1_000_000 - 1000, 1_000_000)).toBe("1s ago");
  expect(formatAgo(1_000_000 - 360_000, 1_000_000)).toBe("6m ago");
});

test("renders the table in the spec's column style, with a note for jammed pipelines", () => {
  const now = 10_000_000;
  const text = renderStatus(
    [
      row({
        name: "people-intake",
        version: 3,
        uptime: 724,
        in_per_min: 42,
        pending: 3,
        delivered: 5112,
        dlq: 2,
        last_delivery_at: now - 1000,
      }),
      row({
        name: "ticket-triage",
        state: "jammed",
        uptime: 7800,
        in_per_min: 0,
        pending: 17,
        delivered: 230,
        dlq: 0,
        last_delivery_at: now - 360_000,
        note: "stalled at 'review'",
      }),
    ],
    now,
  );
  const lines = text.split("\n");
  expect(lines[0]).toMatch(/^PIPELINE +STATE +VER +UPTIME +IN\/MIN +PENDING +DELIVERED +DLQ +LAST DELIVERY$/);
  expect(lines[1]).toMatch(/^people-intake +active +v3 +12m04s +42 +3 +5,112 +2 +1s ago$/);
  expect(lines[2]).toMatch(/^ticket-triage +jammed +v1 +2h10m +0 +17 +230 +0 +6m ago +⚠ stalled at 'review'$/);
  // Same column starts on every line.
  expect(lines[1]!.indexOf("active")).toBe(lines[0]!.indexOf("STATE"));
  expect(lines[0]!.indexOf("LAST DELIVERY")).toBe(lines[1]!.indexOf("1s ago"));
});

test("shows - for stats the runner does not report, and says so when empty", () => {
  expect(renderStatus([row({ name: "x" })])).toMatch(/^x +active +v1 +- +- +- +- +- +-$/m);
  expect(renderStatus([])).toBe("no pipelines");
});

test("--node matches the id as a whole word only", () => {
  const keep = nodeFilter("enrich");
  expect(keep("12:00 INFO [p] node enrich ok")).toBe(true);
  expect(keep("12:00 INFO [p] node enrich-2 ok")).toBe(false);
  expect(keep("12:00 INFO [p] enriched")).toBe(false);
  expect(nodeFilter(undefined)("anything")).toBe(true);
});

test("fills IN/MIN, LAST DELIVERY and the stalled note from a runner's stats", () => {
  const now = 10_000_000;
  const out = renderStatus(
    [
      row({ name: "a", uptime: 5, in_per_min: 42, pending: 1, delivered: 9, dlq: 0, last_delivery_at: now - 1000 }),
      row({ name: "old", state: "jammed", note: "stalled at 'review'", last_delivery_at: now - 360_000 }),
    ],
    now,
  );
  const lines = out.split("\n");
  expect(lines[1]).toMatch(/^a +active +v1 +5s +42 +1 +9 +0 +1s ago$/);
  expect(lines[2]).toMatch(/^old +jammed +v1 +- +- +- +- +- +6m ago +⚠ stalled at 'review'$/);
});

test("formats latencies as ms, seconds, then like uptime", () => {
  expect(formatMs(0)).toBe("0ms");
  expect(formatMs(849.6)).toBe("850ms");
  expect(formatMs(1500)).toBe("1.5s");
  expect(formatMs(192_000)).toBe("3m12s");
  expect(formatMs(null)).toBe("-");
});

test("pipo status <name> detail: oldest pending age and a latency table; nothing when the runner reports none", () => {
  const text = renderDetail(
    row({
      oldest_pending_ms: 192_400,
      oldest_pending_received_at: Date.parse("2026-10-04T10:00:00.000Z"),
      latency_window: 100,
      latency: {
        clean: { count: 100, p50_ms: 12, p95_ms: 40, max_ms: 1200 },
        output: { count: 0, p50_ms: null, p95_ms: null, max_ms: null },
      },
    }),
  );
  const lines = text.split("\n");
  expect(lines[0]).toBe("oldest pending: 3m12s (received 2026-10-04T10:00:00.000Z)");
  expect(lines[1]).toBe("latency (last 100 steps per node):");
  expect(lines[2]).toMatch(/^ {2}NODE +COUNT +P50 +P95 +MAX$/);
  expect(lines[3]).toMatch(/^ {2}clean +100 +12ms +40ms +1\.2s$/);
  expect(lines[4]).toMatch(/^ {2}output +0 +- +- +-$/);
  expect(renderDetail(row({ oldest_pending_ms: null }))).toBe("oldest pending: none");
  expect(renderDetail(row({}))).toBe("");
});
