// The TypeScript test suite, test files in parallel: `bun test` runs every file in one process, one after another,
// and most of the suite's time is spent waiting on runner processes, not on the CPU. Each file runs in its own
// `bun test <file>` (tests already use their own sandboxes, homes and free ports), the slowest first, from the
// durations of the last run. Output goes to one log per file; a failing file's log is printed at the end.
//
//   bun run test                      every test file
//   bun run test packages/engine      files under a path (or a file)
//   bun run test --jobs 4             at most 4 files at once (default: half the cores, 2 to 8)
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const TIMEOUT_MS = 300_000;
// Files share the machine, so a test that starts a runner (and its `pipo compile`) can take longer than Bun's 5 s
// default: every test gets the 30 s runner tests are given anyway. A test's own timeout still wins.
const TEST_TIMEOUT_MS = 30_000;
const TIMES = join(root, "node_modules", ".cache", "pipo-test-times.json");

const args = process.argv.slice(2);
let jobs = Math.min(8, Math.max(2, Math.floor(availableParallelism() / 2)));
const filters: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i] as string;
  if (a === "--jobs" || a === "-j") {
    jobs = Number(args[++i]);
    if (!Number.isInteger(jobs) || jobs < 1) {
      console.error("--jobs needs a positive whole number, e.g. bun run test --jobs 4");
      process.exit(2);
    }
  } else filters.push(relative(root, join(process.cwd(), a)));
}

const files = [...new Bun.Glob("packages/*/test/**/*.test.ts").scanSync({ cwd: root })]
  .filter((f) => !f.includes("node_modules"))
  .filter((f) => !filters.length || filters.some((p) => f === p || f.startsWith(`${p.replace(/\/$/, "")}/`)))
  .sort();
if (!files.length) {
  console.error(`no test files match ${filters.join(", ")}; give a test file or a folder under packages/`);
  process.exit(2);
}

let times: Record<string, number> = {};
try {
  times = JSON.parse(readFileSync(TIMES, "utf8"));
} catch {}
// Slowest first, so a long file doesn't start last and hold up the end; unknown files count as slow.
const queue = [...files].sort((a, b) => (times[b] ?? 1e9) - (times[a] ?? 1e9));

const logs = join("/tmp", `pipo-test-logs-${process.pid}`);
rmSync(logs, { recursive: true, force: true });
mkdirSync(logs, { recursive: true });

interface Result {
  file: string;
  ok: boolean;
  ms: number;
  log: string;
  timedOut: boolean;
  summary: string;
}
const results: Result[] = [];
const started = Date.now();
const tty = process.stdout.isTTY;

async function run(file: string): Promise<Result> {
  const log = join(logs, `${file.replace(/\W+/g, "_")}.log`);
  const t0 = Date.now();
  const fd = openSync(log, "w");
  const child = Bun.spawn(["bun", "test", "--timeout", String(TEST_TIMEOUT_MS), file], {
    cwd: root,
    stdout: fd,
    stderr: fd,
  });
  closeSync(fd);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, TIMEOUT_MS);
  const code = await child.exited;
  clearTimeout(timer);
  const ms = Date.now() - t0;
  const text = readSafe(log);
  const pass = text.match(/^\s*(\d+) pass/m)?.[1] ?? "?";
  const fail = text.match(/^\s*(\d+) fail/m)?.[1] ?? "?";
  return {
    file,
    ok: code === 0 && !timedOut,
    ms,
    log,
    timedOut,
    summary: timedOut ? `timed out after ${TIMEOUT_MS / 1000}s` : `${pass} pass, ${fail} fail`,
  };
}

function readSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function worker() {
  for (let file = queue.shift(); file; file = queue.shift()) {
    const r = await run(file);
    results.push(r);
    const line = `${r.ok ? "pass" : "FAIL"}  ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.file}  (${r.summary})`;
    console.log(tty && !r.ok ? `\x1b[31m${line}\x1b[0m` : line);
  }
}

console.log(`${files.length} test files, ${jobs} at a time; logs in ${logs}`);
await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));

for (const r of results) if (!r.timedOut) times[r.file] = r.ms;
try {
  mkdirSync(dirname(TIMES), { recursive: true });
  writeFileSync(TIMES, JSON.stringify(times, null, 1));
} catch {}

const failed = results.filter((r) => !r.ok);
for (const r of failed) {
  console.log(`\n──── ${r.file} (${r.summary}) ── ${r.log}`);
  // The failures and their errors, without the passing tests' lines.
  const lines = readSafe(r.log)
    .split("\n")
    .filter((l) => !/^\(pass\)/.test(l.trim()));
  console.log(lines.slice(-150).join("\n"));
}
const wall = ((Date.now() - started) / 1000).toFixed(1);
const cpu = (results.reduce((n, r) => n + r.ms, 0) / 1000).toFixed(0);
console.log(
  `\n${failed.length ? `${failed.length} of ${results.length} test files failed` : `all ${results.length} test files passed`} in ${wall}s (${cpu}s of file time)`,
);
const slow = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);
console.log(`slowest: ${slow.map((r) => `${relative("packages", r.file)} ${(r.ms / 1000).toFixed(0)}s`).join(", ")}`);
if (!failed.length) rmSync(logs, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
