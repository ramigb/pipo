// `tap: exec` and `transform: exec` (docs/spec.md §3.4, D71): run a program installed on this machine. No shell: the
// rendered `args` go to the program as they are. It runs like a CLI agent (D67): its own process group, stdin from a
// file, stdout and stderr to files read after it exits, the whole group killed on `timeout`. Relative paths (`cwd`,
// `outputs`) resolve against the pipeline file's folder. A crash before the step commits runs the program again, so
// output paths keyed on `${meta.packet_id}` make a rerun overwrite rather than duplicate.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseDuration } from "@pipo/spec";
import { runCli } from "../agents/cli";
import type { StepAdapter, StepInput, StepResult } from "./steps";

const DEFAULT_TIMEOUT = "5m";
/** How much of stdout and stderr `result: info` keeps (the end of each). */
const KEEP = 64 * 1024;
/** The most stdout `result: text | json` takes; bigger results belong in a file listed in `outputs`. */
const MAX_STDOUT = 1024 * 1024;

const tail = (s: string, n: number) => (s.length > n ? s.slice(-n) : s);

/** Where `command` is found: a path (relative to `dir`) when it has a slash, else on PATH. Undefined when nowhere. */
export function findCommand(command: string, dir: string): string | undefined {
  if (command.includes("/")) {
    const path = resolve(dir, command);
    return existsSync(path) ? path : undefined;
  }
  return Bun.which(command) ?? undefined;
}

export class ExecStep implements StepAdapter {
  constructor(
    private readonly dir: string,
    private readonly transform: boolean,
    private readonly redact: (s: string) => string = (s) => s,
  ) {}

  async run(i: StepInput): Promise<StepResult> {
    const w = i.with;
    const at = `nodes.${i.node}.with`;
    const command = String(w.command ?? "");
    if (!command) throw new Error(`${at}.command is empty after rendering; check the template`);
    const args = ((w.args as unknown[]) ?? []).map(String);
    const cwd = w.cwd ? resolve(this.dir, String(w.cwd)) : this.dir;
    if (!existsSync(cwd)) throw new Error(`${at}.cwd '${w.cwd}' does not exist; create it or fix the path`);
    const outputs = ((w.outputs as unknown[]) ?? []).map((o) => resolve(cwd, String(o)));
    for (const o of outputs) mkdirSync(dirname(o), { recursive: true });
    const env = { ...process.env, ...((w.env as Record<string, string>) ?? {}) };
    const success = (w.success as number[]) ?? [0];
    const timeout = String(w.timeout ?? DEFAULT_TIMEOUT);

    const started = Date.now();
    const run = await runCli(command, args, {
      cwd,
      env,
      stdin: w.stdin === undefined ? "" : String(w.stdin),
      timeoutMs: parseDuration(timeout),
    }).catch((e) => {
      const hint = isAbsolute(command) || command.includes("/") ? "check the path" : "is it installed and on PATH?";
      throw new Error(`${at}.command '${command}' could not be started (${(e as Error).message}); ${hint}`);
    });
    const duration_ms = Date.now() - started;
    if (run.signal || run.code === null || !success.includes(run.code)) {
      const timedOut = duration_ms >= parseDuration(timeout);
      const how = run.signal
        ? `was killed (${run.signal}${timedOut ? `, after the ${timeout} timeout` : ""})`
        : `exited with code ${run.code}`;
      const why = tail(run.stderr.trim() || run.stdout.trim(), 500).replace(/\s+/g, " ");
      throw new Error(`${command} ${how}${why ? `: ${this.redact(why)}` : ""}`);
    }
    const missing = outputs.filter((o) => !existsSync(o));
    if (missing.length) {
      throw new Error(
        `${command} exited with code ${run.code} but did not write ${missing.join(", ")} (${at}.outputs)`,
      );
    }
    if (!this.transform) return {};

    const result = w.result ?? "info";
    if (result === "info") {
      return {
        data: {
          exit_code: run.code,
          stdout: this.redact(tail(run.stdout, KEEP)),
          stderr: this.redact(tail(run.stderr, KEEP)),
          duration_ms,
          files: outputs,
        },
      };
    }
    if (run.stdout.length > MAX_STDOUT) {
      throw new Error(
        `${command} wrote ${run.stdout.length} bytes to stdout, over the 1 MB limit for result: ${result}; write it to a file listed in ${at}.outputs and use result: info`,
      );
    }
    const stdout = this.redact(run.stdout);
    if (result === "text") return { data: stdout };
    try {
      return { data: JSON.parse(stdout) };
    } catch {
      throw new Error(`${command} printed something that is not JSON (${at}.result is json): ${tail(stdout, 200)}`);
    }
  }
  close() {}
}
