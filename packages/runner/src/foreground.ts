// Run one pipeline in the foreground until it ends or is signalled (`pipo run`): the Rust runner binary, in its own
// process group so a terminal's Ctrl-C reaches it once, through this process. Every SIGINT/SIGTERM is forwarded:
// the first drains, a second stops at once (the runner's own rule). Its output is this process's.
import { runnerBinary, runnerEnv } from "./binary";

export interface ForegroundOptions {
  file: string;
  home?: string;
  listen?: number;
  envAllow?: string[];
}

export async function runForeground(opts: ForegroundOptions): Promise<number> {
  const args = [runnerBinary(), opts.file];
  if (opts.home) args.push("--home", opts.home);
  if (opts.listen !== undefined) args.push("--listen", String(opts.listen));
  if (opts.envAllow?.length) args.push("--env-allow", opts.envAllow.join(","));
  const proc = Bun.spawn(args, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: runnerEnv(),
    detached: true,
  });
  const forward = (sig: NodeJS.Signals) => () => {
    if (proc.exitCode === null) proc.kill(sig);
  };
  const onInt = forward("SIGINT");
  const onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    return await proc.exited;
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}
