// A pipeline's `lifetime.ttl` is anchored across crash restarts (docs/spec.md §3.8, §7.3, ledger L-05): it counts from
// the first `pipeline.started` after the last clean end, so a runner SIGKILLed part-way gets only the time that is left,
// and one killed while its ttl drain was under way drains again at once. Real Rust runner processes are found through
// the journal and their registry entry; their output goes to log files, never pipes. The anchor rule itself is
// unit-tested in crates/pipo-runner/src/lifecycle.rs.
import { Database } from "bun:sqlite";
import { afterAll, afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runnerBinary, runnerEnv } from "../src/binary";
import { sandbox, spawnRunner, waitFor } from "./helpers";
import { RustRunner } from "./rust";

setDefaultTimeout(30_000);

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
let running: RustRunner[] = [];
afterEach(async () => {
  for (const r of running) if (r.proc.exitCode === null) await r.kill();
  running = [];
});
afterAll(() => {
  for (const p of spawned) if (p.exitCode === null) p.kill("SIGKILL");
  box.cleanup();
});

const MARKER = join(box.root, "slow.marker");

// `slow` holds a packet while the marker file exists (an exec tap, so the packet's data is kept).
const pipeline = (name: string, lifetime: string) => `pipo: 1
name: ${name}
input: { via: push }
nodes:
  slow:
    from: input
    tap: exec
    with: { command: sh, args: ["-c", "while [ -e ${MARKER} ]; do sleep 0.025; done"], timeout: 1m }
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
 * `pipeline.started` it journals after `afterSeq`.
 */
async function restart(name: string, n: number, afterSeq: number) {
  const log = join(box.root, `${name}-runner-${n}.log`);
  const proc = Bun.spawn([runnerBinary(), join(box.root, `${name}.pipo`), "--home", box.home], {
    stdout: Bun.file(log),
    stderr: Bun.file(`${log}.err`),
    env: runnerEnv(),
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
      20_000,
      `${name} runner ${n} to journal pipeline.started`,
    );
    return proc;
  } catch (e) {
    proc.kill("SIGKILL");
    throw e;
  }
}

/** Wait for a process to exit on its own and return its exit code. */
async function exitOf(proc: ReturnType<typeof Bun.spawn>, ms: number): Promise<number | null> {
  return Promise.race([proc.exited, Bun.sleep(ms).then(() => null)]);
}

test("a start whose anchored ttl is already over ends its lifetime at once", async () => {
  const name = "over";
  const file = box.write(`${name}.pipo`, pipeline(name, "{ ttl: 3s }"));
  const first = await RustRunner.start(box, file, name, { listen: null });
  running.push(first);
  await first.kill();
  // That run started 10 s ago and never stopped cleanly.
  const db = new Database(journalPath(name));
  db.query("UPDATE events SET at = ? WHERE type = 'pipeline.started'").run(Date.now() - 10_000);
  db.close();
  const [started1] = pipelineEvents(name, "pipeline.started");
  const t0 = Date.now();
  const second = await restart(name, 2, started1?.seq ?? 0);
  expect(await exitOf(second, 5000)).toBe(0);
  expect(Date.now() - t0).toBeLessThan(5000);
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
  const r = await RustRunner.start(box, file, name, { listen: null });
  running.push(r);
  await Bun.sleep(300);
  expect((await r.status()).state).toBe("active");
  expect(await r.stop()).toBe(0);
});

// ── SIGKILL, real processes ──────────────────────────────────────────────────

test("SIGKILL at ~2 s of a 3 s ttl: the restarted runner ends at ~3 s from the first start, not ~5 s", async () => {
  const name = "anchored";
  const TTL = 3000;
  box.write(`${name}.pipo`, pipeline(name, "{ ttl: 3s }"));

  const first = await spawnRunner(box, spawned, name, join(box.root, `${name}.pipo`), 1, []);
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
  // A restart slowed by a compile retry can start after the deadline; then only `due` above bounds the drain.
  if (started2.at < anchor.at + TTL) expect(draining.at - anchor.at).toBeLessThan(TTL + 2000);
}, 60_000);

test("SIGKILL during the ttl drain: the restart drains again at once and delivers the in-flight packet once", async () => {
  const name = "redrain";
  box.write(`${name}.pipo`, pipeline(name, "{ ttl: 2s, drain_timeout: 1m }"));
  writeFileSync(MARKER, "");

  const first = await RustRunner.start(box, join(box.root, `${name}.pipo`), name, { listen: null });
  spawned.push(first.proc);
  const { packet_id } = await first.push({ n: 1 });
  // The ttl ends; the drain waits for the packet stuck in `slow`.
  const [draining1] = await waitFor(() => {
    const d = pipelineEvents(name, "pipeline.draining");
    return d.length ? d : null;
  }, 10_000);
  if (!draining1) throw new Error("no pipeline.draining");
  await first.kill();
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
  expect(query(join(box.root, `${name}.db`), "SELECT packet_id, n FROM items")).toEqual([{ packet_id, n: 1 }]);
  const delivered = query(
    journalPath(name),
    "SELECT seq FROM events WHERE packet_id = ? AND type = 'packet.delivered'",
    packet_id,
  );
  expect(delivered).toHaveLength(1);
}, 60_000);
