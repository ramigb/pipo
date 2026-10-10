// `bun install` builds the runner binary (package.json postinstall; docs/spec.md D73). Pipo also builds it on demand
// (runnerBinary), so a machine without Rust still installs: it gets a hint instead of a failed install.
import { RunnerBinaryError, runnerBinary } from "../packages/runner/src/binary";

if (!Bun.which("cargo") && !process.env.PIPO_RUNNER_BIN) {
  console.warn(
    "pipo: cargo isn't installed, so the runner (crates/pipo-runner) wasn't built; install Rust (https://rustup.rs), then run `bun run build:runner`",
  );
  process.exit(0);
}
try {
  console.log(`pipo: runner ready at ${runnerBinary()}`);
} catch (e) {
  if (!(e instanceof RunnerBinaryError)) throw e;
  console.error(e.message);
  process.exit(1);
}
