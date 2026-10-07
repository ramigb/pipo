// The runner side of the control socket (docs/spec.md §7.2, D24). Owns `<home>/run/<name>.sock`: removes a
// stale socket left by a killed runner, refuses one a live runner still answers on, and unlinks it on close.
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { ControlError, MAX_LINE, OPS, type Request, type Response, redactDeep, socketPathProblem } from "./protocol";

/** What an op handler returns: the result, and optionally work to run once the reply is written (stop, drain). */
export interface Handled {
  result: unknown;
  after?: () => void;
}

export type Handler = (op: string, args: Record<string, unknown>) => Handled | Promise<Handled>;

export interface ServerOptions {
  /** Applied to every response before it is written. */
  redact?: (s: string) => string;
  log?: (level: string, message: string) => void;
}

/** True if something accepts connections on the unix socket at `path`. */
export function probe(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const c = createConnection({ path });
    const done = (alive: boolean) => {
      clearTimeout(timer);
      c.removeAllListeners();
      c.on("error", () => {});
      c.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    c.once("connect", () => done(true));
    c.once("error", () => done(false));
  });
}

export class ControlServer {
  private readonly sockets = new Set<Socket>();
  private closing?: Promise<void>;

  private constructor(
    readonly path: string,
    private readonly server: Server,
    private readonly handler: Handler,
    private readonly opts: ServerOptions,
  ) {}

  /** Listen on `path`. Throws ControlError (with a hint) when the path is unusable or a live runner owns it. */
  static async listen(path: string, handler: Handler, opts: ServerOptions = {}): Promise<ControlServer> {
    const problem = socketPathProblem(path);
    if (problem) throw new ControlError("unavailable", problem.message, problem.hint);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

    let existing: ReturnType<typeof lstatSync> | undefined;
    try {
      existing = lstatSync(path);
    } catch {}
    if (existing) {
      if (!existing.isSocket()) {
        throw new ControlError(
          "unavailable",
          `${path} exists and is not a socket`,
          "move or delete that file; Pipo keeps runner sockets under <home>/run/",
        );
      }
      if (await probe(path)) {
        throw new ControlError(
          "unavailable",
          `another runner is listening on ${path}`,
          "stop it first (`pipo stop <name>`), or use a different --home",
        );
      }
      // Left behind by a runner that was killed: nothing answers on it.
      rmSync(path, { force: true });
      opts.log?.("info", `removed stale control socket ${path}`);
    }

    const self: { s?: ControlServer } = {};
    const server = createServer((socket) => self.s?.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        const inUse = e.code === "EADDRINUSE";
        reject(
          new ControlError(
            "unavailable",
            inUse
              ? `another runner is listening on ${path}`
              : `could not listen on control socket ${path}: ${e.message}`,
            inUse
              ? "stop it first (`pipo stop <name>`), or use a different --home"
              : "use a Pipo home on a local Linux or macOS filesystem (--home or PIPO_HOME)",
          ),
        );
      });
      server.listen(path, () => resolve());
    });
    // Only this user may drive the runner.
    try {
      chmodSync(path, 0o600);
    } catch {}
    self.s = new ControlServer(path, server, handler, opts);
    return self.s;
  }

  /** Stop listening, drop every connection and remove the socket file. Safe to call more than once. */
  close(): Promise<void> {
    this.closing ??= new Promise<void>((resolve) => {
      for (const s of this.sockets) s.destroy();
      this.sockets.clear();
      this.server.close(() => resolve());
      // close() waits for connections; they are destroyed above, but never hang a shutdown on it.
      setTimeout(resolve, 500);
    }).then(() => rmSync(this.path, { force: true }));
    return this.closing;
  }

  private accept(socket: Socket) {
    if (this.closing) return void socket.destroy();
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    // Replies go out in request order, even when a later request finishes first.
    let chain = Promise.resolve();
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          const reply = this.answer(line);
          chain = chain.then(async () => {
            const { response, after } = await reply;
            if (socket.destroyed) return after?.();
            socket.write(`${JSON.stringify(response)}\n`, () => after?.());
          });
        }
        nl = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_LINE) {
        const error = new ControlError(
          "bad_request",
          `request line is over ${MAX_LINE} bytes`,
          "send one packet per push; large files belong in a watch input",
        );
        socket.end(`${JSON.stringify({ id: null, ok: false, error: error.body() })}\n`);
        buffer = "";
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => this.sockets.delete(socket));
  }

  private async answer(line: string): Promise<{ response: Response; after?: () => void }> {
    let req: Request;
    try {
      req = JSON.parse(line);
    } catch (e) {
      return this.error(null, new ControlError("bad_request", `bad JSON: ${(e as Error).message}`, EXAMPLE));
    }
    if (!req || typeof req !== "object" || Array.isArray(req)) {
      return this.error(null, new ControlError("bad_request", "a request must be a JSON object", EXAMPLE));
    }
    const id = typeof req.id === "string" || typeof req.id === "number" ? req.id : null;
    if (typeof req.op !== "string") return this.error(id, new ControlError("bad_request", "missing `op`", EXAMPLE));
    if (!(OPS as readonly string[]).includes(req.op)) {
      return this.error(id, new ControlError("unknown_op", `unknown op '${req.op}'`, `ops: ${OPS.join(", ")}`));
    }
    const args = req.args ?? {};
    if (typeof args !== "object" || Array.isArray(args)) {
      return this.error(id, new ControlError("bad_request", "`args` must be an object", EXAMPLE));
    }
    try {
      const { result, after } = await this.handler(req.op, args as Record<string, unknown>);
      const redacted = this.opts.redact ? redactDeep(result ?? null, this.opts.redact) : (result ?? null);
      return { response: { id, ok: true, result: redacted }, after };
    } catch (e) {
      if (e instanceof ControlError) return this.error(id, e);
      this.opts.log?.("error", `control op '${req.op}' failed: ${(e as Error).stack ?? e}`);
      return this.error(id, new ControlError("internal", (e as Error).message, "see the runner log"));
    }
  }

  private error(id: Response["id"], e: ControlError): { response: Response } {
    const body = this.opts.redact
      ? (redactDeep(e.body(), this.opts.redact) as ReturnType<ControlError["body"]>)
      : e.body();
    return { response: { id, ok: false, error: body } };
  }
}

const EXAMPLE = 'one JSON object per line, e.g. {"id":1,"op":"status","args":{}}';
