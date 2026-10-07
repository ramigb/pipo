// An error that says what is wrong and what to do about it (CLAUDE.md conventions).
export class CliError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    /** Machine-readable kind (`bad_request`, `not_found`, … from the engine API); `error` when the CLI itself failed. */
    readonly code: string = "error",
  ) {
    super(message);
  }
}

/** What `--json` prints to stdout for a failed command (the exit code is unchanged). */
export function errorJson(e: unknown): { ok: false; error: string; hint: string | null; code: string } {
  const cli = e instanceof CliError ? e : undefined;
  const code = cli?.code ?? (e as NodeJS.ErrnoException)?.code ?? "error";
  return {
    ok: false,
    error: (e as Error)?.message ?? String(e),
    hint: cli?.hint ?? null,
    code: String(code),
  };
}

/** Engine API hints name REST routes; a CLI user gets the `pipo` command that does the same. */
export function cliHint(hint: string | undefined): string | undefined {
  if (!hint) return hint;
  return hint
    .replace(
      /GET \/api\/pipelines lists them; start one with POST \/api\/pipelines \{file\}( \(pipo start <file>\))?/,
      "run 'pipo status' to list pipelines, or 'pipo start <file>'",
    )
    .replace(/GET \/api\/pipelines\/([^\s,)]+)/g, "'pipo status $1'")
    .replace(/, or POST \/api\/pipelines\/\S+/g, "")
    .replace(/pipo push (\S+?)(?=,|$)/, "'pipo push $1'");
}

let jsonMode = false;
/** Set once per invocation by `main`, so helpers deep in a command can honour `--json` without threading it. */
export function setJsonMode(on: boolean) {
  jsonMode = on;
}

let currentCommand: string | undefined;
/** The command being run, so usage errors can point at its `--help`. */
export function setCommand(name: string | undefined) {
  currentCommand = name;
}

export type FailCode = "usage" | "unknown_command";

/** A failure that is not an exception (bad usage or an unknown command): text on stderr, or `{ok:false,…}` on stdout under `--json`. */
export function fail(code: FailCode, exit: number, message: string, hint?: string, printed = false): number {
  if (printed && !jsonMode) return exit;
  if (jsonMode) console.log(JSON.stringify({ ok: false, error: message, hint: hint ?? null, code }));
  else console.error(code === "usage" ? message : `pipo: ${message}${hint ? ` ${hint}` : ""}`);
  return exit;
}

export function usageError(text: string): number {
  const hint = `run pipo ${currentCommand && !currentCommand.startsWith("-") ? `${currentCommand} ` : ""}--help`;
  return fail("usage", 64, `usage: ${text}`, hint);
}

/** A flag `parseArgs` refused: names it, says where the usage is, exit 64 like every usage error. */
export function badOption(message: string): number {
  const hint = `run pipo ${currentCommand && !currentCommand.startsWith("-") ? `${currentCommand} ` : ""}--help`;
  if (!jsonMode) console.error(`pipo: ${message}\n  hint: ${hint}`);
  return fail("usage", 64, message, hint, true);
}
