// `POST /api/pipelines/<name>/resolve` happy path (docs/spec.md §9.2, D50) with a real runner process: a packet
// escalated by `then: agent` is retried over REST without `by_kind`, proceeds, and the journal records a human.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Supervisor } from "../src";
import { isAlive, sandbox, testConfig, waitFor } from "./helpers";

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

const NAME = "resolveapi";
const flag = join(box.root, "fail.flag");
writeFileSync(flag, "");
// The `check` step fails while the flag file exists: an exec step, since a fn module has no file system.
const gate = `{ command: sh, args: ["-c", 'if [ -e "$0" ]; then echo flaky is failing >&2; exit 1; fi', ${JSON.stringify(flag)}] }`;
const file = box.write(
  `${NAME}.pipo`,
  `pipo: 1
name: ${NAME}
input: { via: push }
nodes:
  check: { from: input, tap: exec, with: ${gate}, on_error: { retry: 1, delay: 10ms, then: agent } }
output: { from: check, to: file, with: { path: ./${NAME}.jsonl, format: jsonl } }
agent: { control: true }
`,
);

const post = async (url: string, body: unknown = {}) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

test("REST resolve retries an escalated packet and records the caller as a human", async () => {
  const engine = await Supervisor.open({
    home: join(box.root, "home"),
    config: { ...testConfig(), listen: 0 },
    log: () => {},
  });
  engines.push(engine);
  const base = engine.gateway?.url;
  const api = `${base}/api/pipelines/${NAME}`;
  expect((await post(`${base}/api/pipelines`, { file })).status).toBe(201);

  const pushed = await post(`${api}/push`, { data: { n: 1 } });
  expect(pushed.status).toBe(200);
  const id = pushed.body.packet_id as string;

  const journal = join(box.root, "home", "pipelines", NAME, "journal.db");
  const query = (sql: string, ...p: any[]): any[] => {
    const db = new Database(journal, { readonly: true });
    try {
      return db.query(sql).all(...p);
    } finally {
      db.close();
    }
  };
  const state = () => query("SELECT state FROM packets WHERE id = ?", id)[0]?.state;
  await waitFor(() => state() === "escalated", 15_000, "packet escalated");

  rmSync(flag);
  const res = await post(`${api}/resolve`, { ids: [id], action: "retry", reason: "fixed the fn" });
  expect(res.status).toBe(200);
  await waitFor(() => state() === "delivered", 15_000, "packet delivered after retry");

  const ev = query("SELECT detail FROM events WHERE packet_id = ? AND type = 'packet.resolved'", id);
  expect(ev).toHaveLength(1);
  expect(JSON.parse(ev[0].detail)).toMatchObject({
    action: "retry",
    by: "api",
    by_kind: "human",
    reason: "fixed the fn",
  });
});
