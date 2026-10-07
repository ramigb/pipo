import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type RegistryEntry, readRegistryEntry } from "@pipo/runner";
import { cmdline, holds } from "../../runner/test/helpers";
import { DEFAULT_CONFIG, type EngineConfig, type RestartConfig } from "../src";

export { holds };

const PIPOD = join(import.meta.dir, "../src/main.ts");
const RUNNER = join(dirname(Bun.resolveSync("@pipo/runner", import.meta.dir)), "main.ts");
type Proc = ReturnType<typeof Bun.spawn>;

/** A throwaway project folder plus Pipo home, both on the Linux filesystem (sockets don't work on /mnt). */
export function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pipo-test-")));
  return {
    root,
    home: join(root, "home"),
    write(name: string, content: string) {
      const path = join(root, name);
      writeFileSync(path, content);
      return path;
    },
    cleanup() {
      killLeftovers(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * SIGKILL every engine or runner process registered under a `run/` folder anywhere in `root`. Detached runners
 * outlive their engine by design (D30), so a test that stops or kills an engine must not leave them behind.
 * Pids are checked against their command line so a reused pid is never touched; already-dead ones are skipped.
 */
export function killLeftovers(root: string) {
  const walk = (dir: string, depth: number) => {
    let names: import("node:fs").Dirent[];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      const path = join(dir, d.name);
      if (d.isDirectory() && d.name === "run") {
        for (const f of readdirSync(path)) if (f.endsWith(".json")) killEntry(join(path, f));
      } else if (d.isDirectory() && depth < 4) walk(path, depth + 1);
    }
  };
  walk(root, 0);
}

function killEntry(file: string) {
  try {
    const pid = JSON.parse(readFileSync(file, "utf8")).pid;
    if (!Number.isInteger(pid) || pid <= 1) return;
    const cmd = cmdline(pid);
    if (/packages\/(engine|runner)\/src\/main\.ts/.test(cmd)) process.kill(pid, "SIGKILL");
  } catch {
    // unreadable entry or already dead
  }
}

export async function waitFor<T>(
  fn: () => T | Promise<T>,
  timeoutMs = 10_000,
  what = "condition",
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await Bun.sleep(25);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/** Engine config for tests: fast restarts, and a start timeout that still covers Bun's slow loads from /mnt. */
export function testConfig(restart: Partial<RestartConfig> = {}): EngineConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    start_timeout: 10_000,
    stop_timeout: 5_000,
    restart: { ...DEFAULT_CONFIG.restart, backoff: 100, max_backoff: 400, ...restart },
  };
}

/** Read-only query that treats a busy or missing database as "not yet". */
export function query(path: string, sql: string, ...params: any[]): any[] | null {
  if (!existsSync(path)) return null;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    return db.query(sql).all(...params);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start pipod and wait until `ready` says so; output goes to log files, never pipes. Under WSL, Bun occasionally
 * spins forever loading modules from /mnt before any code ran; such a process is killed and started again.
 */
export async function spawnPipod<T>(
  root: string,
  spawned: Proc[],
  home: string,
  args: string[],
  ready: (proc: Proc) => T,
  n: number | string,
  timeoutMs = 15_000,
) {
  for (let tries = 1; ; tries++) {
    const log = join(root, `pipod-${n}.${tries}.log`);
    const proc = Bun.spawn(["bun", PIPOD, "--home", home, ...args], {
      stdout: Bun.file(log),
      stderr: Bun.file(`${log}.err`),
    });
    spawned.push(proc);
    try {
      const value = await waitFor(() => ready(proc), timeoutMs, `pipod ${n}`);
      return { proc, log, value };
    } catch (e) {
      // Anything it wrote means it got past loading; only a silent, still-running process is retried.
      const wrote = existsSync(log) && readFileSync(log, "utf8").length > 0;
      proc.kill("SIGKILL");
      if (proc.exitCode !== null || wrote || tries === 3) throw e;
      await proc.exited;
      console.warn(`pipod ${n} stuck loading modules (try ${tries}); restarting it`);
    }
  }
}

/**
 * Start a runner without an engine (as `pipo run` would) and find it through its registry entry. A process stuck
 * loading modules (it never opened its journal) is killed and started again.
 */
export async function spawnRunner(
  root: string,
  spawned: Proc[],
  home: string,
  name: string,
  file: string,
  timeoutMs = 15_000,
  /** Extra environment variables (a spawned process sees the environment Bun started with, not later changes). */
  env: Record<string, string> = {},
): Promise<{ proc: Proc; entry: RegistryEntry }> {
  const journal = join(home, "pipelines", name, "journal.db");
  for (let tries = 1; ; tries++) {
    const log = join(root, `${name}-runner.${tries}.log`);
    const proc = Bun.spawn(["bun", RUNNER, file, "--home", home], {
      cwd: dirname(file),
      env: { ...process.env, ...env },
      stdout: Bun.file(log),
      stderr: Bun.file(`${log}.err`),
    });
    spawned.push(proc);
    try {
      const entry = await waitFor(
        () => {
          if (proc.exitCode !== null) throw new Error(`runner exited (${proc.exitCode}): ${readFileSync(log, "utf8")}`);
          const e = readRegistryEntry(home, name);
          return e?.pid === proc.pid ? e : null;
        },
        timeoutMs,
        `${name} runner registry entry`,
      );
      return { proc, entry };
    } catch (e) {
      const got = proc.exitCode !== null || holds(proc.pid, journal);
      proc.kill("SIGKILL");
      if (got || tries === 3) throw e;
      await proc.exited;
      console.warn(`${name} runner stuck loading modules (try ${tries}); restarting it`);
    }
  }
}
