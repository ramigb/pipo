import { isAbsolute, relative } from "node:path";
import type { Diagnostic } from "./load";

/** A path relative to `cwd`, or the absolute path when the file lies outside it (no `../../..` chains). */
export function displayPath(file: string, cwd = process.cwd()): string {
  const rel = relative(cwd, file);
  if (!rel) return file;
  return rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel) ? file : rel;
}

/** `file:line:col  severity  code  message` plus an indented hint, as in docs/spec.md §5. */
export function formatDiagnostic(d: Diagnostic): string {
  const where = `${d.file ?? "<input>"}:${d.line}:${d.col}`;
  const head = `${where}  ${d.severity.padEnd(7)}  ${d.code}  ${d.message}`;
  return d.hint ? `${head}\n  ${d.hint}` : head;
}

export function summarize(ds: Diagnostic[]): string {
  const errors = ds.filter((d) => d.severity === "error").length;
  const warnings = ds.length - errors;
  if (!ds.length) return "ok";
  return [
    errors && `${errors} error${errors > 1 ? "s" : ""}`,
    warnings && `${warnings} warning${warnings > 1 ? "s" : ""}`,
  ]
    .filter(Boolean)
    .join(", ");
}
