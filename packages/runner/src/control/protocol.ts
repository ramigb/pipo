// Runner control protocol (docs/spec.md §7.2, D24): newline-delimited JSON over the runner's unix socket
// `<home>/run/<name>.sock`. One request per line, `{id, op, args}`; one response per line with the same id,
// `{id, ok: true, result}` or `{id, ok: false, error: {code, message, hint}}`.
import { join } from "node:path";
import type { Diagnostic } from "@pipo/spec";

export const PROTOCOL = 1;

export const OPS = [
  "hello",
  "status",
  "pause",
  "resume",
  "drain",
  "stop",
  "push",
  "ack",
  "events",
  "packets",
  "packet",
  "dlq",
  "replay",
  "purge",
  "versions",
  "version",
  "diff",
  "apply",
  "rollback",
  "propose",
  "proposals",
  "proposal",
  "apply_proposal",
  "reject_proposal",
  "resolve",
] as const;
export type Op = (typeof OPS)[number];

export type ErrorCode =
  | "bad_request"
  | "unknown_op"
  | "unavailable"
  | "rejected"
  | "not_found"
  | "invalid_state"
  /** A pipeline definition that fails `pipo check` (an apply or rollback, D38). */
  | "invalid_pipeline"
  | "internal";

export interface ControlErrorBody {
  code: ErrorCode;
  message: string;
  hint?: string;
  /** Set when the error concerns one packet (e.g. a push the input rejected, which is journaled). */
  packet_id?: string;
  /** `invalid_pipeline`: the `pipo check` diagnostics of the definition, as `pipo check --json` gives them (D60). */
  diagnostics?: Diagnostic[];
}

export interface Request {
  id: string | number;
  op: string;
  args?: Record<string, unknown>;
}

export type Response =
  | { id: string | number | null; ok: true; result: unknown }
  | { id: string | number | null; ok: false; error: ControlErrorBody };

/** Thrown by op handlers (server side) and by the client when the runner answers with an error. */
export class ControlError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
    readonly packetId?: string,
    readonly diagnostics?: Diagnostic[],
  ) {
    super(message);
    this.name = "ControlError";
  }

  body(): ControlErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint && { hint: this.hint }),
      ...(this.packetId && { packet_id: this.packetId }),
      ...(this.diagnostics?.length ? { diagnostics: this.diagnostics } : {}),
    };
  }
}

/** A request line larger than this closes the connection (a push carries one packet, not a file). */
export const MAX_LINE = 16 * 1024 * 1024;

/** sun_path is 108 bytes on Linux and 104 on macOS/BSD, including the trailing NUL. */
export const MAX_SOCKET_PATH = process.platform === "linux" ? 107 : 103;

export function socketPath(home: string, pipeline: string): string {
  return join(home, "run", `${pipeline}.sock`);
}

/** Why a socket can't live at `path`, with what to do about it; null when it can. */
export function socketPathProblem(path: string): { message: string; hint: string } | null {
  const bytes = Buffer.byteLength(path);
  if (bytes > MAX_SOCKET_PATH) {
    return {
      message: `control socket path is ${bytes} bytes, over the ${MAX_SOCKET_PATH}-byte limit for unix sockets: ${path}`,
      hint: "use a shorter Pipo home (--home or PIPO_HOME, e.g. ~/.pipo) or a shorter pipeline name",
    };
  }
  if (process.platform === "linux" && /^\/mnt\/[a-z]\//i.test(path)) {
    return {
      message: `control socket ${path} is on a Windows drive; unix sockets do not work there under WSL`,
      hint: "use a Pipo home on the Linux filesystem (the default ~/.pipo, or --home / PIPO_HOME under /home or /tmp)",
    };
  }
  return null;
}

/** Deep copy with every string (values and keys) passed through `redact`, so secrets never leave the runner. */
export function redactDeep(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[redact(k)] = redactDeep(v, redact);
    return out;
  }
  return value;
}
