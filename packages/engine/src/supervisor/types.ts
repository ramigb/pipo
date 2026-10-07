// Engine supervisor types (docs/spec.md §7.1, §7.2, D25, D27, D30, D57): the states a supervised pipeline goes
// through, the start, stop and shutdown options, the RunnerInfo and AttachResult views the API serves, and the
// supervisor's own record of each pipeline (its runner process, spawned or adopted, and its restart tracking).
import type { RegistryEntry } from "@pipo/runner";
import type { EngineConfig } from "../config";
import type { EngineEvent } from "../events";
import type { RestartTracker } from "../restart";

/**
 * - `starting`: the runner process is coming up · `running`: it answered `hello` (started here, or adopted)
 * - `backoff`: it crashed and restarts after a delay · `stopping`: a stop or drain was asked for
 * - `stopped`: it exited cleanly (asked to, or its lifetime ended) · `failed`: it halted (`on_error: halt`), never
 *   came up when started, or died and can't be restarted · `crashed`: it kept crashing and the engine gave up
 * - `unreachable`: a live runner that did not answer the handshake; left alone until `pipo attach` (D27)
 */
export type SupervisedState =
  | "starting"
  | "running"
  | "backoff"
  | "stopping"
  | "stopped"
  | "failed"
  | "crashed"
  | "unreachable";

export interface StartOptions {
  /**
   * Port for an http input; overrides `input.with.listen`, lands in the registry entry and is reused by restarts,
   * reattaches and later starts of the same pipeline. Refused for other inputs, and when the port is taken.
   */
  listen?: number;
  /**
   * Keep running when the engine stops or dies (§7.2, D30). Defaults to `engine.detached`, or to what the pipeline
   * was last started with by this engine.
   */
  detached?: boolean;
  /**
   * `lifetime.ttl` for this start (D57), e.g. `30m`: replaces the file's and counts from the same anchor (§7.4). The
   * runner gets it as `--ttl` and saves it in its registry entry, so crash restarts and reattaches keep it. Unlike
   * `listen` and `detached` it does not stick: a later start without it goes back to the file's ttl.
   */
  ttl?: string;
}

export interface StopOptions {
  /** Stop at once instead of draining. In-flight packets stay journaled and resume on the next start. */
  now?: boolean;
}

export interface ShutdownOptions extends StopOptions {
  /** Stop detached runners too. By default shutdown leaves them running, and the next engine adopts them (D30). */
  stopDetached?: boolean;
}

export interface ExitInfo {
  /** null when killed by a signal, or when an adopted runner died uncleanly (its exit status can't be known). */
  code: number | null;
  signal: string | null;
  at: string;
}

export interface RunnerInfo {
  name: string;
  file: string;
  state: SupervisedState;
  /** The runner's own status from its registry entry (`active`, `paused`, `jammed`, `draining`) while it runs. */
  status: string | null;
  pid: number | null;
  version: number | null;
  socket: string | null;
  listen: number | null;
  detached: boolean;
  /** The ttl override this run was started with (D57); null when the file's `lifetime.ttl` (if any) applies. */
  ttl: string | null;
  /** True when the runner was already running and this engine attached to it (it is not the engine's child). */
  adopted: boolean;
  /** When the current runner process came up. */
  started_at: string | null;
  /** Restarts after crashes since the last start(). */
  restarts: number;
  last_exit: ExitInfo | null;
  next_restart_at: string | null;
  error: { message: string; hint: string } | null;
  log: string;
}

/** What discovery did with one registry entry (D27). */
export type AttachOutcome =
  /** A live runner answered the handshake and is supervised now. */
  | "adopted"
  /** Its runner had died without a clean stop; it was started again from its file. */
  | "restarted"
  /** The stale entry was removed; nothing restarted (the engine had given up on it). */
  | "removed"
  /** A live runner that did not answer the handshake; left alone. */
  | "unreachable"
  /** Already supervised by this engine; nothing to do. */
  | "supervised"
  /** It died and could not be restarted (see `message` and `hint`). */
  | "failed";

export interface AttachResult {
  name: string;
  outcome: AttachOutcome;
  pid: number | null;
  message: string;
  hint?: string;
}

export interface SupervisorOptions {
  /** Pipo home; defaults to $PIPO_HOME or ~/.pipo. */
  home?: string;
  /** Engine config; defaults to `<home>/config.yaml` (D25). */
  config?: EngineConfig;
  /** Engine log lines; defaults to stdout. */
  log?: (line: string) => void;
  /** Called on every state change (a seam for events and the UI). */
  onChange?: (info: RunnerInfo) => void;
  /** Called with every journal event, from the start (so the events replayed during open() are seen too). */
  onEvent?: (event: EngineEvent) => void;
  /** Poll interval for adopted runners' liveness and for new events (ms). Default 500. */
  pollMs?: number;
  /** Called once the engine shut itself down (§7.5, D31): it slept after `engine.idle`, or `engine.ttl` expired. */
  onEnd?: (reason: EndReason) => void;
  /** Where the dashboard's builder may save new `.pipo` files (§8, D61); defaults to the engine's working directory. */
  workspace?: string;
}

/** Why the engine ended itself: nothing to do for `engine.idle` or `engine.ttl` expired (D31), or it handed over to a new engine (D65). */
export type EndReason = "idle" | "ttl" | "restart";

/** A runner this engine did not start: no exit to await, so a poll of its pid resolves `exited`. */
export interface Adopted {
  pid: number;
  /** Its start in clock ticks since boot, taken once its hello proved it is the runner (Linux; null elsewhere). */
  proc_start: number | null;
  exited: Promise<void>;
  done: () => void;
  gone: boolean;
}

/** The event feed of one pipeline: its cursor, and a chain that keeps fetches in order. */
export interface Feed {
  cursor: number;
  /** Whether the current runner's journal was checked against the cursor (a reset journal restarts it at 0). */
  checked: boolean;
  busy?: Promise<void>;
}

export interface Hello {
  pipeline: string;
  version: number;
  pid: number;
  state: string;
  status: string;
  started_at: string;
}

export interface Supervised {
  name: string;
  file: string;
  opts: StartOptions;
  drainTimeout: number;
  state: SupervisedState;
  wanted: "run" | "stop";
  proc?: Bun.Subprocess;
  adopted?: Adopted;
  registry?: RegistryEntry;
  upAt?: number;
  tracker: RestartTracker;
  restarts: number;
  lastExit: ExitInfo | null;
  error: { message: string; hint: string } | null;
  timer?: ReturnType<typeof setTimeout>;
  nextRestartAt?: number;
  launching?: Promise<void>;
  /** An unreachable runner's pid died; a rescan is queued. */
  rescan?: boolean;
  /** Left running by shutdown (detached): this engine no longer follows it. */
  released?: boolean;
  /** The port check refused the start: nothing was started, so the entry is dropped again. */
  refused?: boolean;
  /** Removing the registry entry of a stopped pipeline's dead runner (forgetDead), so stop() can wait for it. */
  forgetting?: Promise<void>;
  /** The current runner was SIGKILLed by a stop that outlasted `stop_timeout`. */
  killed?: boolean;
}

export const LIVE: SupervisedState[] = ["starting", "running", "backoff", "stopping"];
