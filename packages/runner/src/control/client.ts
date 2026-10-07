// Client for the runner control socket (docs/spec.md §7.2, D24), shared by the engine and the CLI
// (`--no-engine`). Finds a runner through its registry entry, never by guessing a pid.
import { existsSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { ControlError, type ControlErrorBody, type Response } from "./protocol";

export interface RegistryEntry {
  pipeline: string;
  version: number;
  pid: number;
  socket?: string;
  file?: string;
  listen: number | null;
  detached: boolean;
  /** The start's `--ttl` override, when it had one (D57); absent when the file's `lifetime.ttl` applies. */
  ttl?: string;
  state: string;
  started_at: string;
  /** Process start ticks since boot (Linux); exact pid-reuse check (R-4). */
  proc_start?: number | null;
  /** Set when an engine started the runner (§7.2). */
  engine_id?: string;
}

export function registryPath(home: string, pipeline: string): string {
  return join(home, "run", `${pipeline}.json`);
}

/** The runner registry entry for `pipeline`, or null when there is none (or it is unreadable mid-write). */
export function readRegistryEntry(home: string, pipeline: string): RegistryEntry | null {
  const path = registryPath(home, pipeline);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RegistryEntry;
  } catch {
    return null;
  }
}

export interface ClientOptions {
  /** How long to wait for the connection. Default 2 s. */
  connectTimeoutMs?: number;
  /** Default per-request timeout. Default 30 s. */
  timeoutMs?: number;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class ControlClient {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<string | number, Pending>();
  private closedError?: Error;

  private constructor(
    readonly path: string,
    private readonly socket: Socket,
    private readonly timeoutMs: number,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (e) => this.fail(new Error(`control socket ${path}: ${e.message}`)));
    // The runner never half-closes: once it ends the connection, nothing more will be answered.
    const closed = () => {
      this.fail(new Error(`runner closed the control connection (${path})`));
      socket.destroy();
    };
    socket.on("end", closed);
    socket.on("close", closed);
  }

  /** Connect to the unix socket at `path`. */
  static connect(path: string, opts: ClientOptions = {}): Promise<ControlClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`timed out connecting to ${path}`));
      }, opts.connectTimeoutMs ?? 2000);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        resolve(new ControlClient(path, socket, opts.timeoutMs ?? 30_000));
      });
      socket.once("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`cannot connect to runner socket ${path}: ${e.message}`));
      });
    });
  }

  /** Connect to the runner of `pipeline` found in `<home>/run/<pipeline>.json`. */
  static async forPipeline(home: string, pipeline: string, opts: ClientOptions = {}): Promise<ControlClient> {
    const entry = readRegistryEntry(home, pipeline);
    if (!entry) throw new Error(`no runner registered for '${pipeline}' under ${join(home, "run")}`);
    if (!entry.socket) throw new Error(`the runner of '${pipeline}' (pid ${entry.pid}) has no control socket`);
    return ControlClient.connect(entry.socket, opts);
  }

  /** Send one op. Resolves with its result; rejects with a ControlError when the runner answers with an error. */
  request<T = any>(op: string, args: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<NoInfer<T>> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`runner did not answer '${op}' within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.socket.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }

  close() {
    this.fail(new Error("control client closed"));
    this.socket.destroy();
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf("\n");
      let res: Response;
      try {
        res = JSON.parse(line);
      } catch {
        continue;
      }
      const p = res.id === null ? undefined : this.pending.get(res.id);
      if (!p) continue;
      this.pending.delete(res.id as string | number);
      clearTimeout(p.timer);
      if (res.ok) p.resolve(res.result);
      else {
        const e: ControlErrorBody = res.error;
        p.reject(new ControlError(e.code, e.message, e.hint, e.packet_id, e.diagnostics));
      }
    }
  }

  private fail(e: Error) {
    this.closedError ??= e;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
}
