import { Database } from "bun:sqlite";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, type PacketRow, Runner } from "../src";

/** A throwaway project folder plus Pipo home, both on the Linux filesystem. */
export function sandbox() {
  // Real path: macOS tmpdir() is a symlink (/var -> /private/var), and processes report the real one.
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
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Copies an example folder, leaving out what local runs leave behind (gitignored `out/`, `data/`, `inbox/`). */
export function copyExampleDir(src: string, dest: string) {
  cpSync(src, dest, { recursive: true, filter: (path) => !/[\\/](out|data|inbox)$/.test(path.slice(src.length)) });
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

export async function startRunner(file: string, home: string, lines: string[] = []) {
  const runner = await Runner.open({ file, home, listen: 0, log: (l) => lines.push(l) });
  await runner.start();
  const url = (path: string) => `http://127.0.0.1:${runner.port}/in/${runner.pipeline.name}${path}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url(path), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { runner, url, post, lines };
}

/** Wait until a packet reaches a terminal state and return it. */
export function settled(runner: Runner, id: string, timeoutMs = 10_000): Promise<PacketRow> {
  return waitFor(
    () => {
      const row = runner.journal.get(id);
      return row && ["delivered", "filtered", "dead_lettered", "rejected"].includes(row.state) ? row : null;
    },
    timeoutMs,
    `packet ${id} to settle`,
  );
}

export function rows(dbPath: string, sql: string): any[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query(sql).all();
  } finally {
    db.close();
  }
}

export function openJournal(home: string, pipeline: string) {
  return new Journal(join(home, "pipelines", pipeline, "journal.db"));
}

const MAIN = join(import.meta.dir, "../src/main.ts");

const linux = process.platform === "linux";

/** True once `pid` has `file` open (e.g. it got into Runner.open, or started its first flush). /proc, else lsof. */
export function holds(pid: number, file: string): boolean {
  if (!linux) return Bun.spawnSync(["lsof", "-a", "-p", String(pid), "--", file]).exitCode === 0;
  try {
    return readdirSync(`/proc/${pid}/fd`).some((fd) => {
      try {
        return readlinkSync(`/proc/${pid}/fd/${fd}`) === file;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** `pid`'s command line; "" when it's gone. /proc, else ps. */
export function cmdline(pid: number): string {
  if (!linux)
    return Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)])
      .stdout.toString()
      .trim();
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
  } catch {
    return "";
  }
}

/** Every pid but this one whose command line contains `text`. */
export function pidsWith(text: string): number[] {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString();
  return out
    .split("\n")
    .map((l) => /^\s*(\d+) (.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m && m[2]!.includes(text) && Number(m[1]) !== process.pid)
    .map((m) => Number(m[1]));
}

/**
 * Start a runner process and find it through its registry entry (spec §7.2), the way the engine
 * and CLI do; output goes to log files, never pipes (awaiting a pipe inside `bun test` sometimes
 * never wakes up). Under WSL, Bun occasionally spins forever loading modules from /mnt (~3% of
 * spawns), before any runner code ran. Such a process never opened its journal, so it is killed by
 * pid and started again; a runner that hangs after opening its journal fails the test.
 * Every process is pushed onto `spawned` so the suite can kill leftovers.
 */
export async function spawnRunner(
  box: { root: string; home: string },
  spawned: ReturnType<typeof Bun.spawn>[],
  name: string,
  file: string,
  n: number,
  args: string[] = ["--listen", "0"],
  timeoutMs = 10_000,
  /** Extra environment for the runner (e.g. `PIPO_TEST_CRASH_AT`, crashpoint.ts). */
  env: Record<string, string> = {},
) {
  const registry = join(box.home, "run", `${name}.json`);
  const journal = join(box.home, "pipelines", name, "journal.db");
  for (let tries = 1; ; tries++) {
    const log = join(box.root, `${name}-runner-${n}.${tries}.log`);
    const proc = Bun.spawn(["bun", MAIN, file, ...args, "--home", box.home], {
      stdout: Bun.file(log),
      stderr: Bun.file(`${log}.err`),
      ...(Object.keys(env).length && { env: { ...process.env, ...env } }),
    });
    spawned.push(proc);
    try {
      const entry = await waitFor(
        () => {
          if (proc.exitCode !== null) {
            throw new Error(`runner exited (${proc.exitCode}):\n${readFileSync(`${log}.err`, "utf8")}`);
          }
          if (!existsSync(registry)) return null;
          const e = JSON.parse(readFileSync(registry, "utf8"));
          return e.pid === proc.pid ? (e as { listen: number }) : null;
        },
        timeoutMs,
        `${name} runner ${n} registry entry`,
      );
      return { proc, port: entry.listen, log };
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
