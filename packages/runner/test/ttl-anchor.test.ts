// A pipeline's `lifetime.ttl` is anchored across crash restarts (docs/spec.md §3.8, §7.3, ledger L-05): it counts from
// the first `pipeline.started` after the last clean end, so a runner SIGKILLed part-way gets only the time that is left,
// and one killed while its ttl drain was under way drains again at once. Real runner processes are found through the
// journal and their registry entry; their output goes to log files, never pipes.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, Journal, Runner } from "../src";
import { lifetimeAnchor } from "../src/lifecycle-state";
import { holds, sandbox, spawnRunner, waitFor } from "./helpers";

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
const clients: ControlClient[] = [];
afterAll(() => {
  for (const c of clients) c.close();
  for (const p of spawned) p.kill("SIGKILL");
  box.cleanup();
});

const MAIN = join(import.meta.dir, "../src/main.ts");
const MARKER = join(box.root, "slow.marker");
box.write(
  "fns.ts",
  `import { existsSync } from "node:fs";
export const slow = async (d) => { while (existsSync(${JSON.stringify(MARKER)})) await Bun.sleep(25); return d; };
`,
);

const pipeline = (name: string, lifetime: string) => `pipo: 1
name: ${name}
fn: ./fns.ts
input: { via: push }
nodes:
  slow: { from: input, transform: fn.slow }
output:
  from: slow
  to: sqlite
  with: { path: ./${name}.db, table: items, create: true, columns: { packet_id: "\${meta.packet_id}", n: "\${data.n}" } }
lifetime: ${lifetime}
`;

const journalPath = (name: string) => join(box.home, "pipelines", name, "journal.db");

function query(path: string, sql: string, ...params: any[]): any[] {
  if (!existsSync(path)) return [];
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    return db.query(sql).all(...params);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** Pipeline-level events of these types, oldest first. */
const pipelineEvents = (name: string, ...types: string[]) =>
  query(
    journalPath(name),
    `SELECT seq, type, at FROM events WHERE packet_id IS NULL AND type IN (${types.map(() => "?").join(", ")}) ORDER BY seq`,
    ...types,
  ) as { seq: number; type: string; at: number }[];

/**
 * Start a runner that may end its lifetime (and exit) before a registry entry can be seen, so it is found through the
 * `pipeline.started` it journals after `afterSeq`. A process that never got that far and never opened its journal is
 * the Bun-on-/mnt module-load hang: it is killed by pid and started again (as `spawnRunner` does).
 */
async function restart(name: string, n: number, afterSeq: number) {
  const journal = journalPath(name);
  for (let tries = 1; ; tries++) {
    const log = join(box.root, `${name}-runner-${n}.${tries}.log`);
    const proc = Bun.spawn(["bun", MAIN, join(box.root, `${name}.pipo`), "--home", box.home], {
      stdout: Bun.file(log),
      stderr: Bun.file(`${log}.err`),
    });
    spawned.push(proc);
    try {
      await waitFor(
        () => {
          if (pipelineEvents(name, "pipeline.started").some((e) => e.seq > afterSeq)) return true;
          if (proc.exitCode !== null)
            throw new Error(`runner exited (${proc.exitCode}):\n${readFileSync(`${log}.err`, "utf8")}`);
          return false;
        },
        10_000,
        `${name} runner ${n} to journal pipeline.started`,
      );
      return proc;
    } catch (e) {
      if (proc.exitCode !== null || holds(proc.pid, journal) || tries === 3) {
        proc.kill("SIGKILL");
        throw e;
      }
      console.warn(`${name} runner ${n} stuck loading modules (try ${tries}); restarting it`);
      proc.kill("SIGKILL");
      await proc.exited;
    }
  }
}

/** Wait for a process to exit on its own and return its exit code. */
async function exitOf(proc: ReturnType<typeof Bun.spawn>, ms: number): Promise<number | null> {
  return Promise.race([proc.exited, Bun.sleep(ms).then(() => null)]);
}

// ── the anchor rule ──────────────────────────────────────────────────────────

test("lifetimeAnchor: the first pipeline.started after the last clean stop, halt or completion", () => {
  const journal = new Journal(join(box.root, "anchor", "journal.db"));
  try {
    const at = (type: string, ms: number) => {
      journal.event(type);
      journal.db.query("UPDATE events SET at = ? WHERE seq = (SELECT MAX(seq) FROM events)").run(ms);
    };
    expect(lifetimeAnchor(journal)).toBeNull();
    at("pipeline.started", 1000);
    expect(lifetimeAnchor(journal)).toBe(1000);
    // A crash writes no end: the restarts keep the first start.
    at("pipeline.paused", 1500);
    at("pipeline.started", 2000);
    at("pipeline.draining", 2500);
    at("pipeline.started", 3000);
    expect(lifetimeAnchor(journal)).toBe(1000);
    // A packet's events never count, whatever their type.
    journal.event("pipeline.stopped", null, "some-packet");
    expect(lifetimeAnchor(journal)).toBe(1000);
    // A clean stop ends the lifetime: until the next start there is no anchor, then that start is it.
    at("pipeline.stopped", 4000);
    expect(lifetimeAnchor(journal)).toBeNull();
    at("pipeline.started", 5000);
    at("pipeline.started", 6000);
    expect(lifetimeAnchor(journal)).toBe(5000);
    // A halt ends it too.
    at("pipeline.failed", 7000);
    at("pipeline.started", 8000);
    expect(lifetimeAnchor(journal)).toBe(8000);
    at("pipeline.completed", 9000);
    at("pipeline.started", 10_000);
    expect(lifetimeAnchor(journal)).toBe(10_000);
  } finally {
    journal.close();
  }
});

// ── in process ───────────────────────────────────────────────────────────────

test("a start whose anchored ttl is already over ends its lifetime at once", async () => {
  const name = "over";
  const file = box.write(`${name}.pipo`, pipeline(name, "{ ttl: 3s }"));
  const runner = await Runner.open({ file, home: box.home, log: () => {} });
  // An earlier run started 10 s ago and never stopped cleanly.
  runner.journal.event("pipeline.started");
  runner.journal.db
    .query("UPDATE events SET at = ? WHERE seq = (SELECT MAX(seq) FROM events)")
    .run(Date.now() - 10_000);
  const t0 = Date.now();
  await runner.start();
  expect(await Promise.race([runner.finished, Bun.sleep(1500).then(() => "still running")])).toBe(0);
  expect(Date.now() - t0).toBeLessThan(1500);
  expect(pipelineEvents(name, "pipeline.started", "pipeline.draining", "pipeline.stopped").map((e) => e.type)).toEqual([
    "pipeline.started",
    "pipeline.started",
    "pipeline.draining",
    "pipeline.stopped",
  ]);
});

test("a ttl longer than a timer can hold (24.8 days) does not fire at once", async () => {
  const name = "long";
  const file = box.write(`${name}.pipo`, pipeline(name, "{ ttl: 30d }"));
  const runner = await Runner.open({ file, home: box.home, log: () => {} });
  await runner.start();
  await Bun.sleep(300);
  expect(runner.state).toBe("active");
  await runner.stop();
});

// ── SIGKILL, real processes ──────────────────────────────────────────────────

test("SIGKILL at ~2 s of a 3 s ttl: the restarted runner ends at ~3 s from the first start, not ~5 s", async () => {
  const name = "anchored";
  const TTL = 3000;
  box.write(`${name}.pipo`, pipeline(name, "{ ttl: 3s }"));

  const first = await spawnRunner(box, spawned, name, join(box.root, `${name}.pipo`), 1, [], 15_000);
  const [anchor] = await waitFor(() => {
    const s = pipelineEvents(name, "pipeline.started");
    return s.length ? s : null;
  }, 10_000);
  if (!anchor) throw new Error("no pipeline.started");
  await Bun.sleep(Math.max(0, anchor.at + 2000 - Date.now()));
  first.proc.kill("SIGKILL");
  await first.proc.exited;
  // Killed before its ttl: it never drained or stopped.
  expect(pipelineEvents(name, "pipeline.draining", "pipeline.stopped")).toEqual([]);

  const second = await restart(name, 2, anchor.seq);
  expect(await exitOf(second, 15_000)).toBe(0);
  const events = pipelineEvents(name, "pipeline.started", "pipeline.draining", "pipeline.stopped");
  expect(events.map((e) => e.type)).toEqual([
    "pipeline.started",
    "pipeline.started",
    "pipeline.draining",
    "pipeline.stopped",
  ]);
  const [, started2, draining] = events as [unknown, { at: number }, { at: number }];
  // Never before the anchored deadline; at it (or at once, if the restart itself came after it). A fresh ttl from the
  // restart would drain at started2 + 3 s, at least 2 s later than this allows.
  const due = Math.max(anchor.at + TTL, started2.at);
  expect(draining.at).toBeGreaterThanOrEqual(anchor.at + TTL - 50);
  expect(draining.at - due).toBeLessThan(750);
  // A restart slowed by a module-load hang can start after the deadline; then only `due` above bounds the drain.
  if (started2.at < anchor.at + TTL) expect(draining.at - anchor.at).toBeLessThan(TTL + 2000);
}, 60_000);

test("SIGKILL during the ttl drain: the restart drains again at once and delivers the in-flight packet once", async () => {
  const name = "redrain";
  box.write(`${name}.pipo`, pipeline(name, "{ ttl: 2s, drain_timeout: 1m }"));
  writeFileSync(MARKER, "");

  const first = await spawnRunner(box, spawned, name, join(box.root, `${name}.pipo`), 1, [], 15_000);
  const client = await ControlClient.forPipeline(box.home, name);
  clients.push(client);
  const { packet_id } = await client.request<{ packet_id: string }>("push", { data: { n: 1 } });
  // The ttl ends; the drain waits for the packet stuck in `slow`.
  const [draining1] = await waitFor(() => {
    const d = pipelineEvents(name, "pipeline.draining");
    return d.length ? d : null;
  }, 10_000);
  if (!draining1) throw new Error("no pipeline.draining");
  client.close();
  first.proc.kill("SIGKILL");
  await first.proc.exited;
  expect(pipelineEvents(name, "pipeline.stopped")).toEqual([]);
  rmSync(MARKER);

  const second = await restart(name, 2, draining1.seq);
  expect(await exitOf(second, 15_000)).toBe(0);
  const events = pipelineEvents(name, "pipeline.started", "pipeline.draining", "pipeline.stopped");
  expect(events.map((e) => e.type)).toEqual([
    "pipeline.started",
    "pipeline.draining",
    "pipeline.started",
    "pipeline.draining",
    "pipeline.stopped",
  ]);
  const [, , started2, draining2] = events as { at: number }[] as [unknown, unknown, { at: number }, { at: number }];
  // A fresh 2 s ttl would drain 2 s after the restart.
  expect(draining2.at - started2.at).toBeLessThan(750);
  expect(query(join(box.root, `${name}.db`), "SELECT packet_id FROM items").map((r) => r.packet_id)).toEqual([
    packet_id,
  ]);
  const delivered = query(
    journalPath(name),
    "SELECT seq FROM events WHERE packet_id = ? AND type = 'packet.delivered'",
    packet_id,
  );
  expect(delivered).toHaveLength(1);
}, 60_000);
