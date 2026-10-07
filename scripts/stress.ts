// Done check D3 (docs/spec.md §12): resilience tests must pass repeatedly, not once.
// Entries may be appended to RESILIENCE. Removing or weakening one (fewer runs, longer tolerance, skipping)
// needs human approval.
import { type Dirent, mkdirSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RESILIENCE = [
  "packages/runner/test/recovery.test.ts",
  "packages/runner/test/watch-replay.test.ts",
  "packages/runner/test/batch-recovery.test.ts",
  "packages/runner/test/fanout-recovery.test.ts",
  "packages/runner/test/control-recovery.test.ts",
  "packages/engine/test/reattach.test.ts",
  "packages/engine/test/gateway.test.ts",
  "packages/engine/test/detached.test.ts",
  "packages/engine/test/lifetime.test.ts",
  "packages/engine/test/engine-kill.test.ts",
  "packages/engine/test/stay-stopped.test.ts",
  "packages/engine/test/paused-crash.test.ts",
  "packages/runner/test/pause-recovery.test.ts",
  "packages/runner/test/dlq-recovery.test.ts",
  "packages/runner/test/agent-recovery.test.ts",
  "packages/runner/test/versions-recovery.test.ts",
  "packages/runner/test/ttl-anchor.test.ts",
  "packages/engine/test/stop-crashed.test.ts",
  "packages/runner/test/proposal-apply-recovery.test.ts",
  "packages/runner/test/escalation-recovery.test.ts",
  "packages/runner/test/proposal-dryrun-recovery.test.ts",
  "packages/runner/test/metrics-recovery.test.ts",
  "packages/engine/test/start-ttl.test.ts",
  "packages/runner/test/version-files-recovery.test.ts",
];
const TIMEOUT_MS = 180_000;
const STARTUP_MS = 45_000;

const arg = Bun.argv.indexOf("--runs");
const runs = arg >= 0 ? Number(Bun.argv[arg + 1]) : 5;
if (!Number.isInteger(runs) || runs < 1) {
  console.error("--runs needs a positive integer, e.g. `bun run stress --runs 2`");
  process.exit(2);
}

/**
 * Runner logs written since `since` in test sandboxes (`<tmp>/pipo-test-*`), newest first. A run
 * killed on timeout never reaches its cleanup, so its sandboxes and their logs are still there.
 */
function runnerLogs(since: number): { path: string; mtime: number }[] {
  const found: { path: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory() && depth > 0) walk(path, depth - 1);
      else if (e.isFile() && /\.log(\.err)?$/.test(e.name)) {
        try {
          const mtime = statSync(path).mtimeMs;
          if (mtime >= since) found.push({ path, mtime });
        } catch {}
      }
    }
  };
  try {
    for (const d of readdirSync(tmpdir())) if (d.startsWith("pipo-test-")) walk(join(tmpdir(), d), 2);
  } catch {}
  return found.sort((a, b) => b.mtime - a.mtime);
}

function printRunnerLogs(since: number, files = 4, lines = 20) {
  const logs = runnerLogs(since);
  if (!logs.length) return console.log("      no runner logs found under the test sandboxes");
  for (const { path } of logs.slice(0, files)) {
    let tail: string[] = [];
    try {
      tail = readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines);
    } catch {}
    console.log(`      ── ${path} (last ${tail.length} lines)`);
    for (const line of tail) console.log(`      ${line}`);
  }
  if (logs.length > files) console.log(`      … and ${logs.length - files} older runner log(s)`);
}

/** True if a test sandbox (`<tmp>/pipo-test-*`) was created since `since`: the test file got past loading. */
function sandboxSince(since: number): boolean {
  try {
    return readdirSync(tmpdir()).some((n) => {
      if (!n.startsWith("pipo-test-")) return false;
      try {
        return statSync(join(tmpdir(), n)).mtimeMs >= since;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

const root = new URL("..", import.meta.url).pathname;
const logs = "/tmp/pipo-stress";
mkdirSync(logs, { recursive: true });
let failed = 0;

for (const file of RESILIENCE) {
  for (let i = 1; i <= runs; i++) {
    const log = `${logs}/${file.replace(/\W+/g, "_")}.${i}.log`;
    const started = Date.now();
    let timedOut = false;
    let code = 1;
    // Bun on /mnt sometimes spins forever loading the test file's modules (~3% of starts), before the
    // first test created its sandbox. That is not a test result: kill it by pid and start it again.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const fd = openSync(log, "w");
      const child = Bun.spawn(["bun", "test", file], { cwd: root, stdout: fd, stderr: fd });
      let stuck = false;
      timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        process.kill(child.pid, "SIGKILL");
      }, TIMEOUT_MS);
      const began = Date.now();
      const watchdog = setTimeout(() => {
        if (runnerLogs(began).length === 0 && !sandboxSince(began)) {
          stuck = true;
          process.kill(child.pid, "SIGKILL");
        }
      }, STARTUP_MS);
      code = await child.exited;
      clearTimeout(timer);
      clearTimeout(watchdog);
      if (!stuck) break;
      console.log(`      ${file} never started (module-load hang, attempt ${attempt}/3); starting it again`);
    }
    const ok = code === 0 && !timedOut;
    if (!ok) failed++;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `${ok ? "pass" : "FAIL"}  ${file}  run ${i}/${runs}  ${secs}s${timedOut ? "  (timed out)" : ""}  ${log}`,
    );
    if (timedOut) printRunnerLogs(started);
  }
}
console.log(failed === 0 ? "stress: all runs passed" : `stress: ${failed} run(s) failed; see the logs above`);
process.exit(failed === 0 ? 0 : 1);
