// `pipo update` (docs/guide/install.md): run this checkout's install.sh on it, which pulls new commits (a fast-forward,
// never over local changes), runs `bun install` (deps and the runner), links `pipo` to this checkout, verifies the
// install and offers to restart an engine running older code.
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CliError } from "./errors";

export const REPO = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));

/** install.sh's argv for these `pipo update` flags, on this checkout. */
export function installArgs(args: string[]): string[] {
  const { values } = parseArgs({
    args,
    options: {
      yes: { type: "boolean", short: "y" },
      check: { type: "boolean" },
      "no-update": { type: "boolean" },
      "skip-engine": { type: "boolean" },
      branch: { type: "string" },
    },
  });
  const out = [join(REPO, "install.sh"), "--dir", REPO];
  for (const flag of ["yes", "check", "no-update", "skip-engine"] as const) if (values[flag]) out.push(`--${flag}`);
  if (values.branch) out.push("--branch", values.branch);
  return out;
}

export function cmdUpdate(args: string[]): number {
  const argv = installArgs(args);
  if (!existsSync(argv[0] as string)) {
    throw new CliError(`there is no install.sh in ${REPO}`, "this pipo doesn't run from a checkout; reinstall it");
  }
  return Bun.spawnSync(["bash", ...argv], { stdio: ["inherit", "inherit", "inherit"] }).exitCode ?? 1;
}
