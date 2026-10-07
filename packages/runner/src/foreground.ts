// Run one pipeline in the current process until it ends or is signalled. Used by the runner
// entry point and by `pipo run`. SIGINT/SIGTERM drain; a second signal stops at once.
import { formatDiagnostic } from "@pipo/spec";
import { Runner, type RunnerOptions, StartError } from "./runner";

export async function runForeground(opts: RunnerOptions): Promise<number> {
  const err = (line: string) => console.error(line);
  // Handlers go in before anything else exists (registry entry, inputs). A signal that lands
  // while the runner is still starting is remembered and honoured as soon as it can be.
  let runner: Runner | undefined;
  let signals = 0;
  const onSignal = () => {
    signals++;
    if (!runner) return;
    if (signals === 1) void runner.drain();
    else void runner.stop(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const release = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
  try {
    runner = await Runner.open(opts);
    if (signals > 0) {
      await runner.stop();
      return 0;
    }
    await runner.start();
  } catch (e) {
    release();
    if (!(e instanceof StartError)) throw e;
    err(`pipo: ${e.message}`);
    for (const d of e.diagnostics) err(formatDiagnostic(d));
    for (const g of e.gaps) err(`  ${g.level === "refuse" ? "not implemented" : "ignored"}: ${g.feature} at ${g.path}`);
    return 1;
  }
  if (signals > 0) void runner.drain();
  const code = await runner.finished;
  release();
  return code;
}
