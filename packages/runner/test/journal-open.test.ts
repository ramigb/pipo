// Opening a journal another process holds locked: busy_timeout is set before the pragmas that take a lock, and
// busy errors that skip the busy handler (SQLITE_BUSY_RECOVERY after a SIGKILL) are retried with a bounded backoff.
import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isBusy, Journal, openReadonly, retryBusy } from "../src/journal";
import { sandbox, waitFor } from "./helpers";

const box = sandbox();
const spawned: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
  for (const p of spawned) p.kill("SIGKILL");
  box.cleanup();
});

test("an open waits for a lock another process holds, instead of failing with 'database is locked'", async () => {
  const path = join(box.root, "locked", "journal.db");
  new Journal(path).close();
  const marker = join(box.root, "locked.flag");
  const holder = box.write(
    "hold.ts",
    `import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
const db = new Database(${JSON.stringify(path)});
db.exec("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE");
writeFileSync(${JSON.stringify(marker)}, "");
Bun.sleepSync(800);
db.exec("COMMIT");
db.close();
`,
  );
  const proc = Bun.spawn(["bun", holder], {
    stdout: Bun.file(join(box.root, "hold.log")),
    stderr: Bun.file(join(box.root, "hold.err")),
  });
  spawned.push(proc);
  await waitFor(() => existsSync(marker) || proc.exitCode !== null, 10_000, "the lock to be taken");
  expect(proc.exitCode).toBeNull();
  const started = Date.now();
  const j = new Journal(path);
  expect(Date.now() - started).toBeGreaterThan(200);
  expect((j.db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
  j.close();
  expect(await proc.exited).toBe(0);
}, 20_000);

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
  const path = join(box.root, "readonly", "journal.db");
  const j = new Journal(path);
  j.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE");
  j.close();
  const marker = join(box.root, "readonly.flag");
  const holder = box.write(
    "hold-ro.ts",
    `import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
const db = new Database(${JSON.stringify(path)});
db.exec("BEGIN EXCLUSIVE");
writeFileSync(${JSON.stringify(marker)}, "");
Bun.sleepSync(400);
db.exec("COMMIT");
db.close();
`,
  );
  const proc = Bun.spawn(["bun", holder], {
    stdout: Bun.file(join(box.root, "hold-ro.log")),
    stderr: Bun.file(join(box.root, "hold-ro.err")),
  });
  spawned.push(proc);
  await waitFor(() => existsSync(marker) || proc.exitCode !== null, 10_000, "the lock to be taken");
  expect(proc.exitCode).toBeNull();
  const started = Date.now();
  const db = openReadonly(path);
  expect(Date.now() - started).toBeGreaterThan(100);
  expect((db.query("SELECT count(*) AS n FROM versions").get() as { n: number }).n).toBe(0);
  db.close();
  expect(await proc.exited).toBe(0);
}, 20_000);
