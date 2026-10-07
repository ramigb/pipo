// Errors the engine reports to its callers (pipod, and later the gateway, CLI and MCP). Each says what is
// wrong and what to do about it, like the runner's control errors (docs/spec.md §7.2, D24).
import type { Diagnostic } from "@pipo/spec";

export type EngineErrorCode =
  /** config.yaml is unreadable or invalid (D25). */
  | "config"
  /** Another engine already owns this Pipo home. */
  | "conflict"
  /** No supervised pipeline has that name. */
  | "not_found"
  /** The pipeline is not in a state that allows the operation. */
  | "invalid_state"
  /** The pipeline file failed `pipo check`, or uses something not implemented yet. */
  | "invalid_pipeline"
  /** A start option is malformed (a ttl that is not a duration). */
  | "bad_request"
  /** The runner process did not come up. */
  | "start_failed";

export class EngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
    readonly hint?: string,
    readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message);
    this.name = "EngineError";
  }
}
