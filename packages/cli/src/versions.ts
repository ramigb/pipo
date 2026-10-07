// history, diff and rollback (docs/spec.md §6 Versions, §9.3, D38). Reads go through the engine API, else the live
// runner's socket, else the journal read-only, like packets.ts; a rollback needs the running runner, which stores the
// earlier definition as a new version that only newly accepted packets use.
import { parseArgs } from "node:util";
import type { VersionDiff, VersionList } from "@pipo/runner";
import { CliError } from "./errors";
import { COMMON, context, out, usage } from "./lifecycle";
import { readOp, table, writeOp } from "./packets";
import { formatAgo } from "./status";

/** `3` or `v3`. */
function versionNumber(raw: string, what: string): number {
  if (!/^v?\d+$/i.test(raw) || Number(raw.replace(/^v/i, "")) < 1) {
    throw new CliError(
      `${what} '${raw}' is not a version`,
      "use a version number such as 3 or v3 (pipo history <name>)",
    );
  }
  return Number(raw.replace(/^v/i, ""));
}

export function renderHistory(list: VersionList, name: string, now = Date.now()): string {
  if (!list.versions.length) return `${name} has no versions yet`;
  const active = list.current ?? null;
  const rows = list.versions.map((v) => [
    `${v.version === active ? "*" : " "}v${v.version}`,
    formatAgo(v.created_at, now),
    v.author,
    String(v.pending),
    v.hash.slice(0, 12),
    v.reason ?? "",
  ]);
  const text = table(["  VER", "CREATED", "AUTHOR", "PENDING", "HASH", "REASON"], rows, [3]);
  const foot =
    active !== null
      ? `* new packets use v${active}; in-flight packets finish on their own version`
      : `not running: the next start runs v${list.latest} unless its file changed since the last start (D38)`;
  return `${text}\n${foot}`;
}

export async function cmdHistory(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: COMMON });
  const name = positionals[0];
  if (!name || positionals.length > 1) return usage("pipo history <name>");
  const ctx = await context(values);
  const r = await readOp(ctx, name, "versions", {}, "/versions");
  out(ctx, { pipeline: name, ...r }, renderHistory(r as unknown as VersionList, name));
  return 0;
}

export async function cmdDiff(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: COMMON });
  const [name, a, b] = positionals;
  if (!name || !a || !b || positionals.length > 3) return usage("pipo diff <name> <v1> <v2>");
  const from = versionNumber(a, "v1");
  const to = versionNumber(b, "v2");
  const ctx = await context(values);
  const r = (await readOp(ctx, name, "diff", { from, to }, `/diff?from=${from}&to=${to}`)) as VersionDiff &
    Record<string, unknown>;
  const text = r.identical
    ? `v${from} and v${to} of ${name} are identical`
    : `${r.diff}\n${r.added} line(s) added, ${r.removed} removed`;
  out(ctx, { pipeline: name, ...r }, text);
  return 0;
}

export async function cmdRollback(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: COMMON });
  const [name, v] = positionals;
  if (!name || !v || positionals.length > 2) return usage("pipo rollback <name> <v>");
  const version = versionNumber(v, "version");
  const ctx = await context(values);
  let r: Record<string, any>;
  try {
    r = await writeOp(ctx, name, "rollback", { version, by: "cli" }, "/rollback", "roll back");
  } catch (e) {
    // A reply lost after the runner committed means the rollback happened: say how to tell.
    if (e instanceof CliError && /closed the control connection|did not answer/.test(e.message)) {
      throw new CliError(e.message, `check pipo history ${name}: a rollback that was committed shows as a new version`);
    }
    throw e;
  }
  const text = r.changed
    ? `rolled back ${name} to v${version}: new packets use v${r.version} (a copy of v${version}); ${
        r.pending_older ? `${r.pending_older} packet(s) in flight finish on their own version` : "nothing was in flight"
      }`
    : `${name} already runs that definition (v${r.version}); nothing changed`;
  // Files that changed since v<version> was recorded (D60): it runs them as they are now.
  const warnings = Array.isArray(r.warnings)
    ? r.warnings.map((w: { message: string; hint: string }) => `\nwarning: ${w.message}\n  hint: ${w.hint}`).join("")
    : "";
  out(ctx, { pipeline: name, result: r }, `${text}${warnings}`);
  return 0;
}
