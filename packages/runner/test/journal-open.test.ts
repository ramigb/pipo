// Opening a journal another process holds locked: busy_timeout is set before the pragmas that take a lock, and
// busy errors that skip the busy handler (SQLITE_BUSY_RECOVERY after a SIGKILL) are retried with a bounded backoff.
// The Rust runner's open is driven end to end here (its retry_busy is unit-tested in journal.rs); the TS read side
// (openReadonly, retryBusy) is tested directly.
import { Database } from "bun:sqlite";
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runnerBinary, runnerEnv } from "../src/binary";
import { isBusy, openReadonly, retryBusy } from "../src/journal";
import { holds, sandbox, waitFor } from "./helpers";
import { RustRunner } from "./rust";

setDefaultTimeout(30_000);
const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
  for (const p of spawned) p.kill("SIGKILL");
  box.cleanup();
});

/**
 * A Bun process that takes an exclusive lock on `path`, writes `marker`, and holds it until `release` exists or, with
 * `ms`, for that long.
 */
function holdLock(name: string, path: string, setup: string, ms = 15_000) {
  const marker = join(box.root, `${name}.flag`);
  const release = join(box.root, `${name}.release`);
  const holder = box.write(
    `${name}.ts`,
    `import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
const db = new Database(${JSON.stringify(path)});
db.exec(${JSON.stringify(setup)});
writeFileSync(${JSON.stringify(marker)}, "");
const deadline = Date.now() + ${ms};
while (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline) Bun.sleepSync(20);
db.exec("COMMIT");
db.close();
`,
  );
  const proc = Bun.spawn([process.execPath, holder], {
    stdout: Bun.file(join(box.root, `${name}.log`)),
    stderr: Bun.file(join(box.root, `${name}.err`)),
  });
  spawned.push(proc);
  return { proc, marker, release };
}

test("the runner's open waits for a lock another process holds, instead of failing with 'database is locked'", async () => {
  const file = box.write(
    "locked.pipo",
    "pipo: 1\nname: locked\ninput: { via: push }\noutput: { from: input, to: stdout }\n",
  );
  // A first run creates the journal.
  const first = await RustRunner.start(box, file, "locked", { listen: null });
  expect(await first.stop()).toBe(0);
  const path = join(box.home, "pipelines", "locked", "journal.db");

  const lock = holdLock("locked", path, "PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE");
  await waitFor(() => existsSync(lock.marker) || lock.proc.exitCode !== null, 10_000, "the lock to be taken");
  expect(lock.proc.exitCode).toBeNull();

  const log = join(box.root, "locked-runner.log");
  const runner = Bun.spawn([runnerBinary(), file, "--home", box.home], {
    stdout: Bun.file(log),
    stderr: Bun.file(`${log}.err`),
    env: runnerEnv(),
  });
  spawned.push(runner);
  const registry = join(box.home, "run", "locked.json");
  // It reaches the journal, then waits on the lock: alive, with no registry entry yet.
  await waitFor(() => holds(runner.pid, path) || runner.exitCode !== null, 20_000, "the runner to open the journal");
  await Bun.sleep(500);
  expect(runner.exitCode).toBeNull();
  expect(existsSync(registry)).toBe(false);

  Bun.write(lock.release, "");
  expect(await lock.proc.exited).toBe(0);
  await waitFor(
    () => {
      if (runner.exitCode !== null) throw new Error(`runner exited: ${readFileSync(`${log}.err`, "utf8")}`);
      return existsSync(registry) && JSON.parse(readFileSync(registry, "utf8")).pid === runner.pid;
    },
    10_000,
    "the runner to start",
  );
  const db = new Database(path, { readonly: true });
  try {
    expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
  } finally {
    db.close();
  }
  runner.kill("SIGTERM");
  expect(await runner.exited).toBe(0);
});

test("retryBusy retries busy errors (SQLITE_BUSY_RECOVERY too) with a bounded backoff, and nothing else", () => {
  const busy = (code: string) => Object.assign(new Error("database is locked"), { code });
  const waits: number[] = [];
  let n = 0;
  const value = retryBusy(
    () => {
      if (++n < 3) throw busy("SQLITE_BUSY_RECOVERY");
      return "open";
    },
    5000,
    (ms) => waits.push(ms),
  );
  expect(value).toBe("open");
  expect(waits).toEqual([25, 50]);

  waits.length = 0;
  expect(() =>
    retryBusy(
      () => {
        throw busy("SQLITE_BUSY");
      },
      1000,
      (ms) => waits.push(ms),
    ),
  ).toThrow("database is locked");
  expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1000);
  expect(waits.length).toBeGreaterThan(2);

  let calls = 0;
  expect(() =>
    retryBusy(() => {
      calls++;
      throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    }),
  ).toThrow("disk I/O error");
  expect(calls).toBe(1);
  expect(isBusy(busy("SQLITE_BUSY_SNAPSHOT"))).toBe(true);
  expect(isBusy(new Error("x"))).toBe(false);
});

test("a read-only open waits out an exclusive lock held by another process instead of failing busy", async () => {
  mkdirSync(join(box.root, "readonly"));
  const path = join(box.root, "readonly", "journal.db");
  const j = new Database(path);
  j.exec("PRAGMA journal_mode = DELETE; CREATE TABLE versions (version INTEGER PRIMARY KEY)");
  j.close();
  // The read-only open blocks this process, so the holder lets go by itself.
  const lock = holdLock("hold-ro", path, "BEGIN EXCLUSIVE", 400);
  await waitFor(() => existsSync(lock.marker) || lock.proc.exitCode !== null, 10_000, "the lock to be taken");
  expect(lock.proc.exitCode).toBeNull();
  const started = Date.now();
  const db = openReadonly(path);
  expect(Date.now() - started).toBeGreaterThan(100);
  expect((db.query("SELECT count(*) AS n FROM versions").get() as { n: number }).n).toBe(0);
  db.close();
  expect(await lock.proc.exited).toBe(0);
});
