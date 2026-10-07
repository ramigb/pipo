// Test-only crash points for the SIGKILL tests of docs/spec.md §7.3 (D49). With `PIPO_TEST_CRASH_AT=<name>` in its
// environment, a runner SIGKILLs itself when it reaches that point, so a test can prove a transition is
// all-or-nothing at an exact spot rather than by timing. Unset, which it always is outside tests, it does nothing.
const AT = process.env.PIPO_TEST_CRASH_AT;

/**
 * The points a test may name: around the transaction of a live apply (runner.ts `applyVersion`), just before a unit is
 * handed to the agent, just after a `resolve` commits, before its units are queued and the reply is sent (D50), and
 * around a proposal's dry run (proposals.ts `dryRun`, D48): once every packet is replayed, before the outcome's
 * transaction, and just after that commits, before anything is applied.
 */
export type CrashPoint =
  | "apply.prepared"
  | "apply.in_transaction"
  | "apply.committed"
  | "escalate.prepared"
  | "resolve.committed"
  | "dryrun.replayed"
  | "dryrun.decided";

export function crashPoint(name: CrashPoint): void {
  if (AT !== name) return;
  process.kill(process.pid, "SIGKILL");
  // SIGKILL can't be caught or blocked, so this is not reached; never carry on past a crash point regardless.
  for (;;) Bun.sleepSync(1000);
}
