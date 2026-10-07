// Runtime connector contracts. Manifests (schemas, capabilities) live in @pipo/spec.

export interface Origin {
  trigger: string;
  source: string;
}

export type IntakeResult =
  | { status: "accepted"; packet_id: string }
  | { status: "rejected"; packet_id: string; rule?: string; message: string; respond?: number }
  | { status: "unavailable"; reason: string };

export interface IntakeOptions {
  /**
   * Synchronous journal writes (e.g. `InputState.put`) committed in the same transaction that
   * journals the packet, accepted or rejected, so an input's cursor never runs ahead of or behind
   * its packets. Not run when the result is `unavailable` or the intake throws.
   */
  commit?: () => void;
}

/** Hands a raw payload to the runner, which validates and journals it before answering. */
export type Intake = (payload: unknown, origin: Origin, opts?: IntakeOptions) => Promise<IntakeResult>;

/**
 * Durable state an input keeps in the pipeline journal so it can resume after a restart (spec §14.3).
 * A pipeline has one input, so a baseline replaces any state saved under another scope.
 */
export interface InputState {
  /** Every saved entry, or null when nothing was saved for this scope yet (first start). */
  load(): Map<string, unknown> | null;
  /** Replace the scope's entries in one transaction and mark the scope as started. */
  baseline(entries: Map<string, unknown>): void;
  /** Upsert one entry, or delete it with `undefined`. Inside an intake `commit` it joins the packet's transaction. */
  put(key: string, value: unknown): void;
}

/** What the runner lends an input at start. */
export interface InputRuntime {
  /** Journal-backed state for `scope` (e.g. a watch input's resolved glob). */
  state(scope: string): InputState;
}

export interface InputAdapter {
  /** `runtime` is absent when the input runs without a journal (unit tests). */
  start(intake: Intake, runtime?: InputRuntime): Promise<void>;
  /** Stop accepting. Must be safe to call more than once. */
  stop(): Promise<void>;
  /** Human-readable address, e.g. the URL an http input listens on. */
  describe(): string;
}

export interface WriteItem {
  /** The idempotency key: `packet_id`, or `packet_id:<branch>` for a fan-out copy (D22). */
  packetId: string;
  data: unknown;
  /** The output's `with:` block, rendered for this packet. */
  with: Record<string, unknown>;
  /** Where the packet came from (a telegram reply goes back to its chat). */
  origin?: Origin;
}

export interface OutputAdapter {
  /**
   * Write one or more packets. Takes a list so batching (spec §3.5.1) fits without a new
   * contract; returns one result per item in order. Throws if the write failed as a whole.
   */
  write(items: WriteItem[]): Promise<unknown[]>;
  /** Run a connector-specific delivery check. Universal checks (ack, none, external) never get here. */
  verify(check: string, checkWith: Record<string, unknown>, item: WriteItem, result: unknown): Promise<boolean>;
  close(): void;
}
