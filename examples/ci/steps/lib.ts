// Shared by the step scripts ci.pipo runs (`exec`). Each build has a record, out/work/<packet id>.json, written at
// checkout. A step after an agent node gets only the agent's answer on stdin, so it reads the build from there.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OUT = join(import.meta.dir, "..", "out");

export interface Build {
  id: string;
  repo: string;
  name: string;
  sha: string;
  short: string;
  branch: string;
  message: string;
  author: string;
  url: string | null;
  workspace: string;
  artifact: string;
  status?: "passed" | "failed" | "fixed";
  tests?: { ok: boolean; pass: number; fail: number; failures: string[]; log: string };
  fixes?: Fix[];
}

/** Claude Code's answer (fix.schema.json). */
export interface Fix {
  summary: string;
  cause: string;
  files: string[];
}

export const recordPath = (id: string) => join(OUT, "work", `${id}.json`);
export const readBuild = (id: string): Build => JSON.parse(readFileSync(recordPath(id), "utf8"));
export const writeBuild = (b: Build) => writeFileSync(recordPath(b.id), `${JSON.stringify(b, null, 2)}\n`);

/** Run a command; throws with its output when it fails. */
export function run(cmd: string[], cwd?: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${r.exitCode}): ${r.stderr.toString().trim() || r.stdout.toString()}`);
  }
  return r.stdout.toString().trim();
}

export const git = (cwd: string, ...args: string[]) =>
  run(["git", "-c", "advice.detachedHead=false", "-c", "init.defaultBranch=main", ...args], cwd);

export async function stdinJson<T>(): Promise<T> {
  return JSON.parse(await Bun.stdin.text());
}
