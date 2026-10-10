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
import { Journal } from "../src";
import { runnerBinary, runnerEnv } from "../src/binary";

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
 * Start a runner process (the Rust binary) and find it through its registry entry (spec §7.2), the way the engine and
 * CLI do; output goes to log files, never pipes (awaiting a pipe inside `bun test` sometimes never wakes up). The
 * runner retries a `pipo compile` that hangs, so a start can take a while under WSL. Every process is pushed onto
 * `spawned` so the suite can kill leftovers.
 */
export async function spawnRunner(
  box: { root: string; home: string },
  spawned: ReturnType<typeof Bun.spawn>[],
  name: string,
  file: string,
  n: number,
  args: string[] = ["--listen", "0"],
  timeoutMs = 30_000,
  /** Extra environment for the runner (e.g. `PIPO_TEST_CRASH_AT`, crashpoint.rs). */
  env: Record<string, string> = {},
) {
  const registry = join(box.home, "run", `${name}.json`);
  const log = join(box.root, `${name}-runner-${n}.log`);
  const proc = Bun.spawn([runnerBinary(), file, ...args, "--home", box.home], {
    stdout: Bun.file(log),
    stderr: Bun.file(`${log}.err`),
    env: runnerEnv(env),
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
    proc.kill("SIGKILL");
    throw e;
  }
}
