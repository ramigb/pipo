// What the dashboard reads (docs/spec.md §8, §9, D59): `lifetime` on the pipeline list and one pipeline, the log tail
// and the agent activity feed over /api, with a real runner for the lifetime and the logs.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "@pipo/runner";
import { Supervisor } from "../src";
import { activityEvents, logPage } from "../src/dashboard";
import { isAlive, sandbox, testConfig } from "./helpers";

const box = sandbox();
const engines: Supervisor[] = [];
const pids: number[] = [];
afterAll(async () => {
  for (const e of engines) {
    for (const r of e.list()) if (r.pid) pids.push(r.pid);
    await Promise.race([e.shutdown({ now: true }), Bun.sleep(10_000)]);
  }
  for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  box.cleanup();
});

const src = (name: string, lifetime: string) => `pipo: 1
name: ${name}
input: { via: push }
output:
  from: input
  to: file
  with: { path: ./${name}.jsonl, format: jsonl }
${lifetime}`;
const get = async (url: string) => {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as any };
};

describe("lifetime, logs and activity over /api", () => {
  test("lifetime remaining on the list and the pipeline, logs tail and follow, activity, bad params", async () => {
    const home = join(box.root, "home");
    const engine = await Supervisor.open({ home, config: { ...testConfig(), listen: 0 }, log: () => {} });
    engines.push(engine);
    const base = `${engine.gateway?.url}/api`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const ttlFile = box.write("ttl.pipo", src("ttlp", "lifetime: { ttl: 2h }\n"));
    expect((await post("/pipelines", { file: ttlFile })).status).toBe(201);
    expect((await post("/pipelines", { file: box.write("plain.pipo", src("plain", "")) })).status).toBe(201);

    const list = (await get(`${base}/pipelines`)).body.pipelines as any[];
    expect(list.find((p) => p.name === "plain").stats).toMatchObject({
      total: 0,
      in_flight: 0,
      oldest_pending_age_ms: null,
    });
    const ttlp = list.find((p) => p.name === "ttlp");
    expect(ttlp.lifetime.ttl).toBe("2h");
    expect(ttlp.lifetime.remaining_ms).toBeGreaterThan(2 * 3600_000 - 60_000);
    expect(ttlp.lifetime.remaining_ms).toBeLessThanOrEqual(2 * 3600_000);
    expect(Date.parse(ttlp.lifetime.ends_at) - Date.now()).toBeLessThanOrEqual(2 * 3600_000);
    expect(list.find((p) => p.name === "plain").lifetime).toEqual({ ttl: null, ends_at: null, remaining_ms: null });
    const one = (await get(`${base}/pipelines/ttlp`)).body;
    expect(one.lifetime.ttl).toBe("2h");

    // Logs: the start wrote some lines; `after` returns only what came later, whole lines only.
    const first = await get(`${base}/pipelines/ttlp/logs?tail=500`);
    expect(first.status).toBe(200);
    expect(first.body.lines.length).toBeGreaterThan(0);
    expect(first.body.next).toBeGreaterThan(0);
    const none = await get(`${base}/pipelines/ttlp/logs?after=${first.body.next}`);
    expect(none.body).toMatchObject({ lines: [], next: first.body.next, reset: false });
    appendFileSync(engine.get("ttlp")?.log as string, "one\ntwo\npartial");
    const more = await get(`${base}/pipelines/ttlp/logs?after=${first.body.next}`);
    expect(more.body.lines).toEqual(["one", "two"]);
    expect((await get(`${base}/pipelines/ttlp/logs?after=999999999`)).body.reset).toBe(true);
    expect((await get(`${base}/pipelines/ttlp/logs?tail=0`)).status).toBe(400);
    expect((await get(`${base}/pipelines/ttlp/logs?after=x`)).body.hint).toContain("whole number");
    expect((await get(`${base}/pipelines/nope/logs`)).status).toBe(404);

    // Activity: empty for a pipeline that never escalated.
    expect((await get(`${base}/pipelines/ttlp/activity`)).body).toEqual({ events: [] });
    expect((await get(`${base}/pipelines/ttlp/activity?limit=0`)).status).toBe(400);
  }, 60_000);

  test("logPage tails by lines and activityEvents reads escalations and resolves newest first", () => {
    const log = join(box.root, "x.log");
    writeFileSync(log, `${Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n")}\n`);
    expect(logPage(log, { tail: 3, after: null }).lines).toEqual(["line 7", "line 8", "line 9"]);
    expect(logPage(join(box.root, "missing.log"), { tail: 3, after: null })).toEqual({
      lines: [],
      next: 0,
      reset: false,
    });

    const path = join(box.root, "journal.db");
    const j = new Journal(path);
    j.event("pipeline.started", {});
    j.event("packet.escalated", { reason: "rejected", error: { message: "bad" } }, "p1", "input");
    j.event("packet.resolved", { action: "retry", by: "bot", by_kind: "agent", reason: "ok" }, "p1", "tag");
    j.close();
    const events = activityEvents(path, 10) ?? [];
    expect(events.map((e) => e.type)).toEqual(["packet.resolved", "packet.escalated"]);
    expect(events[0]?.detail).toMatchObject({ action: "retry", by: "bot" });
    expect(activityEvents(path, 1)).toHaveLength(1);
    expect(activityEvents(join(box.root, "none.db"), 5)).toBeNull();
  });
});

describe("pipeline list stats", () => {
  test("statsOf counts packets per state and the oldest pending age; unreadable journal is null", async () => {
    const { statsOf } = await import("../src/dashboard");
    const path = join(box.root, "stats.db");
    const j = new Journal(path);
    const db = (j as any).db;
    db.query(
      "INSERT INTO versions (version, hash, source, author, reason, created_at) VALUES (1, 'h', 's', 'human', 'first start', 0)",
    ).run();
    const mk = (id: string, state: string, at: number) =>
      db
        .query(
          "INSERT INTO packets (id, version, state, trigger, source, received_at, updated_at) VALUES (?, 1, ?, 't', 's', ?, ?)",
        )
        .run(id, state, at, at);
    mk("a", "delivered", 1000);
    mk("b", "delivered", 1000);
    mk("c", "dead_lettered", 1000);
    mk("d", "processing", 4000);
    mk("e", "escalated", 3000);
    mk("f", "delivered", 9500);
    mk("g", "rejected", 9600);
    j.close();
    expect(statsOf(path, 10_000)).toEqual({
      in_flight: 1,
      pending: 2,
      delivered: 3,
      filtered: 0,
      dead_lettered: 1,
      rejected: 1,
      escalated: 1,
      branched: 0,
      total: 7,
      oldest_pending_age_ms: 7000,
      throughput_per_min: 6,
    });
    expect(statsOf(path, 65_000)?.throughput_per_min).toBe(1);
    writeFileSync(join(box.root, "bad.db"), "not a database");
    expect(statsOf(join(box.root, "bad.db"))).toBeNull();
    expect(statsOf(join(box.root, "missing.db"))).toBeNull();
  });
});
