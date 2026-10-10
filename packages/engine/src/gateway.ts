// The engine's HTTP gateway (docs/spec.md §7.1, §7.2, §7.6, D28): one Bun.serve on 127.0.0.1:<engine.listen>.
// - `/in/<pipeline><path>` is proxied unchanged (method, path, query, headers, raw body) to the runner's own http
//   input, which serves the same route on the port in its registry entry; the runner's reply comes back as is.
//   Never retried: a refused connection reached no runner (503), a failure after sending may have journaled (502).
// - `/api/*` is JSON REST over the Supervisor. Errors are `{error, hint, code}` with a matching status.
// - `/events` is SSE over Supervisor.subscribe(): `id: <pipeline>:<seq>`, `?pipeline=` filter, replay after
//   Last-Event-ID or `?after=` (from the journal when filtered, else from the recent in-memory events).
// Packet reads (`/packets`, `/packets/<id>`, `/dlq`) ask the runner; with no runner running they read the pipeline's
// journal read-only, redacted, payloads withheld when a secret can't be resolved here (D34). DLQ replay and purge
// need a running runner, which commits them (D33). Version reads (`/versions`, `/versions/<v>`, `/diff`) work the
// same way; a rollback needs the running runner, which stores it as a new version for new packets (D38). So do change
// proposals (§9.3, D51): they are read from the journal when nothing runs, while propose, apply, reject and `resolve`
// (D50) need the runner.
// `/mcp` is the agent endpoint (§9.2, D53, mcp.ts): its tools call the `/api` handlers in-process (internal()).
// `/api`, `/events` and `/mcp` only answer requests addressed to a loopback host, and POSTs must be JSON, so a web page
// can't drive the engine through the browser (DNS rebinding, cross-site form posts).

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ControlError, homeAgentBudget, offlineRead, type ReadOp, readRegistryEntry } from "@pipo/runner";
import { serveUi } from "@pipo/ui";
import type { Server } from "bun";
import { deleteBot, listBots, saveBot, testBot } from "./bots";
import { Builder } from "./builder";
import { activityEvents, lifetimeOf, logPage, statsOf } from "./dashboard";
import { EngineError } from "./errors";
import { type EngineEvent, journalEventsAfter, journalEventsTail } from "./events";
import { CodeStamp } from "./freshness";
import { pipelineGraph } from "./graph";
import { journalPath, logPath } from "./home";
import { HttpError } from "./http-error";
import { McpServer } from "./mcp";
import { resourcesOf } from "./resources";
import { listFolders } from "./settings";
import type { RunnerInfo, Supervisor } from "./supervisor";

/** Recent events kept for `/api/events` and SSE replay across all pipelines. */
const RING = 1000;
/** At most this many journal events are replayed into one SSE connection; the rest is a `gap` event. */
const MAX_REPLAY = 10_000;
/** SSE comment sent this often so idle connections and proxies stay open. */
const HEARTBEAT_MS = 15_000;
/** An SSE client with this much unsent (bytes of text) is dropped; it reconnects and replays. */
const MAX_BEHIND = 16 * 1024 * 1024;
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

const ROUTES = [
  "GET  /api/engine",
  "POST /api/engine/restart",
  "GET  /api/agent-budget",
  "GET  /api/settings",
  "POST /api/settings/workspace {path, create?}",
  "GET  /api/folders?path=",
  "GET  /api/bots",
  "POST /api/bots/telegram/<name> {token?, allow?, poll_every?, api?, default?, rename?}",
  "POST /api/bots/telegram/<name>/delete",
  "POST /api/bots/telegram/<name>/test",
  "GET  /api/pipelines",
  "POST /api/pipelines {file, listen?, detached?}",
  "GET  /api/pipelines/<name>",
  "POST /api/pipelines/<name>/start {listen?, detached?}",
  "POST /api/pipelines/<name>/stop {now?}",
  "POST /api/pipelines/<name>/drain",
  "POST /api/pipelines/<name>/restart {listen?, detached?, ttl?}",
  "POST /api/pipelines/<name>/pause {reason?}",
  "POST /api/pipelines/<name>/resume",
  "POST /api/pipelines/<name>/push {data, source?}",
  "POST /api/pipelines/<name>/ack {packet_id}",
  "GET  /api/pipelines/<name>/graph",
  "GET  /api/pipelines/<name>/logs?tail=&after=",
  "GET  /api/pipelines/<name>/activity?limit=",
  "GET  /api/pipelines/<name>/packets?state=&limit=&after=",
  "GET  /api/pipelines/<name>/packets/<packet_id>",
  "GET  /api/pipelines/<name>/dlq?limit=&after=",
  "POST /api/pipelines/<name>/dlq/replay {ids?, all?}",
  "POST /api/pipelines/<name>/dlq/purge {ids?, all?}",
  "GET  /api/pipelines/<name>/versions",
  "GET  /api/pipelines/<name>/versions/<v>",
  "GET  /api/pipelines/<name>/diff?from=&to=",
  "POST /api/pipelines/<name>/rollback {version, by?}",
  "GET  /api/pipelines/<name>/proposals?state=&limit=",
  "GET  /api/pipelines/<name>/proposals/<id>",
  "POST /api/pipelines/<name>/proposals {source, base_version, reason, by?, by_kind?, apply?}",
  "POST /api/pipelines/<name>/proposals/<id>/apply {by?}",
  "POST /api/pipelines/<name>/proposals/<id>/reject {reason, by?}",
  "POST /api/pipelines/<name>/resolve {ids|packet_id, action, by?, by_kind?, reason?}",
  "POST /api/attach {name?}",
  "GET  /api/builder/catalog",
  "GET  /api/builder/agents",
  "GET  /api/builder/files?refresh=",
  "GET  /api/builder/open?file=|pipeline=",
  "POST /api/builder/check {source|pipeline, base?, file?}",
  "POST /api/builder/save {file, source, overwrite?}",
  "POST /api/builder/test {source, file?, fixtures, stubs?}",
  "GET  /api/builder/schema?file=&path=",
  "POST /api/builder/schema {file, path, schema, overwrite?}",
  "GET  /api/events?pipeline=&after=&limit=",
  "GET  /events?pipeline=&after= (SSE)",
  "GET  /ui (dashboard)",
  "POST /mcp (MCP, Authorization: Bearer <token from engine.mcp.tokens>)",
  "ANY  /in/<pipeline><path>",
];

const LIVE_STATES = new Set(["starting", "running", "backoff", "stopping", "unreachable"]);
const START_KEYS = ["listen", "detached", "ttl"];
const PROPOSE_KEYS = ["source", "base_version", "reason", "by", "by_kind", "apply"];
const RESOLVE_KEYS = ["ids", "packet_id", "action", "by", "by_kind", "reason"];

const ENGINE_STATUS: Record<string, number> = {
  bad_request: 400,
  not_found: 404,
  invalid_state: 409,
  conflict: 409,
  invalid_pipeline: 422,
  start_failed: 500,
  config: 500,
};
const CONTROL_STATUS: Record<string, number> = {
  bad_request: 400,
  unknown_op: 400,
  not_found: 404,
  invalid_state: 409,
  rejected: 422,
  invalid_pipeline: 422,
  unavailable: 503,
  internal: 500,
};

/** An event as the gateway serves it: the engine event plus its SSE id. */
export type GatewayEvent = EngineEvent & { id: string };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });

const fail = (e: HttpError) => json(e.status, { error: e.message, hint: e.hint, code: e.code, ...e.extra }, e.headers);

const eventId = (e: EngineEvent) => `${e.pipeline}:${e.seq}`;
const withId = (e: EngineEvent): GatewayEvent => ({ id: eventId(e), ...e });

/** `<pipeline>:<seq>`, or a bare seq when the pipeline is known from `?pipeline=`. */
function parseAfter(raw: string, pipeline: string | null): { pipeline: string; seq: number } {
  const at = raw.lastIndexOf(":");
  const name = at >= 0 ? raw.slice(0, at) : pipeline;
  const seq = Number(at >= 0 ? raw.slice(at + 1) : raw);
  if (!name || !NAME.test(name) || !Number.isInteger(seq) || seq < 0) {
    throw new HttpError(
      400,
      `bad event position '${raw}'`,
      "use an event id such as people-intake:42 (or a bare seq together with ?pipeline=)",
      "bad_request",
    );
  }
  if (pipeline && name !== pipeline) {
    throw new HttpError(
      400,
      `event position '${raw}' names '${name}', but ?pipeline= is '${pipeline}'`,
      "drop one of them, or make them name the same pipeline",
      "bad_request",
    );
  }
  return { pipeline: name, seq };
}

interface SseClient {
  pipeline: string | null;
  /** Per pipeline: journal seqs already replayed, so the live stream skips them once. */
  skip: Map<string, number>;
  write(chunk: string): void;
  /** End the stream once what is queued has been sent. */
  close(): void;
  /** Resolves once the stream ended (everything handed to the connection) or the client went away. */
  done: Promise<void>;
}

export class Gateway {
  private readonly server: Server<undefined>;
  private readonly ring: GatewayEvent[] = [];
  private readonly clients = new Set<SseClient>();
  private readonly unsubscribe: (() => void)[] = [];
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private ready = false;
  private stopped?: Promise<void>;
  private readonly mcp: McpServer;
  private readonly builder: Builder;
  /** Whether the engine's sources changed on disk since it started (D64). */
  private readonly code = new CodeStamp();
  /** Requests being answered (SSE streams excluded: they are closed by stop()). */
  private inflight = 0;
  /** Bound port, kept because Bun reports 0 once the server stopped. */
  readonly port: number;

  /** Bind 127.0.0.1:`port` (0 picks a free one). Throws EngineError (`conflict`) when the port is taken. */
  constructor(
    private readonly engine: Supervisor,
    port: number,
  ) {
    try {
      this.server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: (req, server) => this.handle(req, server),
        error: (e) => json(500, { error: e.message, hint: "see the engine log", code: "internal" }),
      });
    } catch (e) {
      throw new EngineError(
        "conflict",
        `the gateway can't listen on 127.0.0.1:${port}: ${(e as Error).message}`,
        "set engine.listen in config.yaml to a free port (0 picks one), or stop what holds this one",
      );
    }
    this.port = this.server.port as number;
    this.builder = new Builder(engine);
    this.mcp = new McpServer({
      engine,
      tokens: engine.config.mcp?.tokens ?? [],
      api: (method, path, body) => this.internal(method, path, body),
    });
    this.unsubscribe.push(
      engine.subscribe((e) => this.onEvent(e)),
      engine.onState((info) => this.onState(info)),
    );
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.write(": ping\n\n");
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Discovery is done: answer `/api` and `/in` (before this they get 503 and Retry-After). */
  markReady(): void {
    this.ready = true;
  }

  /**
   * Close every SSE stream, let in-flight requests finish (up to 2 s), then close the port and every connection.
   * (Bun's graceful stop(false) leaves idle keep-alive connections served, even after a later stop(true).)
   */
  stop(): Promise<void> {
    this.stopped ??= (async () => {
      for (const u of this.unsubscribe) u();
      clearInterval(this.heartbeat);
      const streams = [...this.clients].map((c) => {
        c.close();
        return c.done;
      });
      const deadline = Date.now() + 2000;
      await Promise.race([Promise.all(streams), Bun.sleep(2000)]);
      while (this.inflight > 0 && Date.now() < deadline) await Bun.sleep(10);
      await this.server.stop(true);
    })();
    return this.stopped;
  }

  // ── events ───────────────────────────────────────────────────────────────────

  private onEvent(e: EngineEvent) {
    const ev = withId(e);
    this.ring.push(ev);
    if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING);
    for (const c of this.clients) {
      if (c.pipeline && c.pipeline !== e.pipeline) continue;
      const skip = c.skip.get(e.pipeline);
      if (skip !== undefined) {
        if (e.seq <= skip) continue;
        c.skip.delete(e.pipeline);
      }
      c.write(sseEvent(ev));
    }
  }

  private onState(info: RunnerInfo) {
    const chunk = `event: state\ndata: ${JSON.stringify(info)}\n\n`;
    for (const c of this.clients) if (!c.pipeline || c.pipeline === info.name) c.write(chunk);
  }

  /** Recent events: one pipeline's from its journal (exact), or all pipelines' from the in-memory ring. */
  private recentEvents(url: URL) {
    const pipeline = url.searchParams.get("pipeline");
    if (pipeline !== null && !NAME.test(pipeline)) throw unknownPipeline(pipeline);
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null ? 100 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new HttpError(400, `bad limit '${limitRaw}'`, "use a whole number from 1 to 1000", "bad_request");
    }
    const afterRaw = url.searchParams.get("after");
    const after = afterRaw === null ? null : parseAfter(afterRaw, pipeline);
    let events: GatewayEvent[];
    let more = false;
    const name = pipeline ?? after?.pipeline;
    if (pipeline !== null) {
      const path = journalPath(this.engine.home, pipeline);
      const page = after ? journalEventsAfter(path, after.seq, limit + 1) : journalEventsTail(path, limit);
      if (!page) throw unknownPipeline(pipeline, "it has no journal under this engine's home");
      more = page.length > limit;
      events = page.slice(0, limit).map((e) => withId({ pipeline, ...e }));
    } else if (after) {
      const at = this.ring.findIndex((e) => e.pipeline === after.pipeline && e.seq === after.seq);
      if (at < 0) {
        throw new HttpError(
          410,
          `event ${afterRaw} is not among the engine's ${this.ring.length} recent events`,
          `read one pipeline's events from its journal instead: GET /api/events?pipeline=${name}&after=${after.seq}`,
          "gone",
        );
      }
      events = this.ring.slice(at + 1, at + 1 + limit);
      more = this.ring.length > at + 1 + limit;
    } else events = this.ring.slice(-limit);
    return { events, more, last_id: events.at(-1)?.id ?? null };
  }

  private sse(req: Request, url: URL, server: Server<undefined>): Response {
    server.timeout(req, 0);
    const pipeline = url.searchParams.get("pipeline");
    if (pipeline !== null && !NAME.test(pipeline)) throw unknownPipeline(pipeline);
    // A reconnecting EventSource sends Last-Event-ID; it wins over the ?after= of its original URL.
    const from = req.headers.get("last-event-id") || url.searchParams.get("after");
    const after = from ? parseAfter(from, pipeline) : null;
    const encoder = new TextEncoder();
    // Pull-based: the connection asks for the next chunk once it took the last, so `done` means flushed, and the
    // queue's size is how far behind the client is.
    let queue: string[] = [];
    let queued = 0;
    let closing = false;
    let wake: (() => void) | undefined;
    let finished!: () => void;
    // An open stream (the dashboard) keeps the engine awake until it closes (§7.5, D61).
    const release = this.engine.hold();
    const c: SseClient = {
      pipeline,
      skip: new Map(),
      done: new Promise<void>((r) => {
        finished = r;
      }),
      write: (chunk) => {
        if (closing) return;
        queue.push(chunk);
        queued += chunk.length;
        if (queued > MAX_BEHIND) {
          queue = [];
          queued = 0;
          c.close();
        }
        wake?.();
      },
      close: () => {
        if (closing) return;
        closing = true;
        this.clients.delete(c);
        release();
        wake?.();
      },
    };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          while (!queue.length && !closing) {
            await new Promise<void>((r) => {
              wake = r;
            });
            wake = undefined;
          }
          if (queue.length) {
            const text = queue.join("");
            queue = [];
            queued = 0;
            controller.enqueue(encoder.encode(text));
            return;
          }
          controller.close();
          finished();
        },
        cancel: () => {
          c.close();
          finished();
        },
      },
      { highWaterMark: 0 },
    );
    // Subscribing and replaying happen in this synchronous block, and journal reads are synchronous, so no event
    // can be emitted in between: the replay and the live stream neither overlap nor leave a hole.
    c.write("retry: 1000\n\n");
    if (after) this.replay(c, after, from as string);
    this.clients.add(c);
    req.signal.addEventListener("abort", () => {
      c.close();
      finished();
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" },
    });
  }

  private replay(c: SseClient, after: { pipeline: string; seq: number }, raw: string) {
    const gap = (error: string, hint: string) =>
      c.write(`event: gap\ndata: ${JSON.stringify({ after: raw, error, hint })}\n\n`);
    if (c.pipeline) {
      const path = journalPath(this.engine.home, after.pipeline);
      let cursor = after.seq;
      let sent = 0;
      for (;;) {
        const page = journalEventsAfter(path, cursor, 500);
        if (!page) {
          gap(
            `the journal of '${after.pipeline}' could not be read, so events after ${raw} can't be replayed`,
            `check the pipeline exists (GET /api/pipelines/${after.pipeline}), then reconnect`,
          );
          break;
        }
        if (!page.length) break;
        for (const e of page) c.write(sseEvent(withId({ pipeline: after.pipeline, ...e })));
        cursor = page.at(-1)?.seq as number;
        sent += page.length;
        if (page.length < 500) break;
        if (sent >= MAX_REPLAY) {
          gap(
            `replay stopped after ${sent} events at ${after.pipeline}:${cursor}; newer events may be missing until the live stream`,
            `page through GET /api/events?pipeline=${after.pipeline}&after=${cursor}`,
          );
          break;
        }
      }
      // The journal may be ahead of the engine's stream: skip those seqs when they arrive live.
      c.skip.set(after.pipeline, Math.max(cursor, after.seq));
      return;
    }
    const at = this.ring.findIndex((e) => e.pipeline === after.pipeline && e.seq === after.seq);
    if (at < 0) {
      gap(
        `event ${raw} is not among the engine's recent events, so what came after it can't be replayed here`,
        "read each pipeline's events with GET /api/events?pipeline=<name>&after=<seq>, or stream one pipeline with /events?pipeline=<name> (replayed from its journal)",
      );
      return;
    }
    for (const e of this.ring.slice(at + 1)) c.write(sseEvent(e));
  }

  // ── routing ──────────────────────────────────────────────────────────────────

  private async handle(req: Request, server: Server<undefined>): Promise<Response> {
    this.inflight++;
    try {
      return await this.route(req, server);
    } finally {
      this.inflight--;
    }
  }

  private async route(req: Request, server: Server<undefined>): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/in" || path.startsWith("/in/")) return await this.proxy(req, url, server);
      if (path === "/events" || path === "/api" || path.startsWith("/api/")) {
        this.local(req);
        this.engine.touch(); // someone is using the engine: it doesn't sleep under them (D31)
        if (path === "/events") {
          if (req.method !== "GET") throw notAllowed("GET");
          return this.sse(req, url, server);
        }
        if (path !== "/api/engine") this.whenReady();
        server.timeout(req, 0); // start and stop wait for runners, which can take longer than Bun's idle timeout
        return await this.api(req, url, path.split("/").slice(2));
      }
      if (path === "/mcp") {
        this.local(req);
        server.timeout(req, 0); // a proposal's dry run and apply can take longer than Bun's idle timeout
        return await this.mcp.handle(req);
      }
      if (path === "/ui" || path.startsWith("/ui/")) {
        return await serveUi(path);
      }
      throw new HttpError(
        404,
        `nothing at ${path}`,
        `the gateway serves /in/<pipeline>/…, /api/…, /events, /mcp and /ui`,
        "not_found",
        {
          routes: ROUTES,
        },
      );
    } catch (e) {
      return errorResponse(e);
    }
  }

  private whenReady() {
    if (!this.ready) {
      throw new HttpError(
        503,
        "the engine is starting: it is still reattaching its runners",
        "try again in a moment",
        "unavailable",
        {},
        { "retry-after": "1" },
      );
    }
  }

  /** Only requests addressed to a loopback host (a page on another site can't rebind its name to 127.0.0.1). */
  private local(req: Request) {
    const host = req.headers.get("host");
    if (!host) return;
    const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d+$/, "");
    if (!LOOPBACK.has(name.toLowerCase())) {
      throw new HttpError(
        403,
        `the engine API does not answer requests for host '${host}'`,
        `address it as http://127.0.0.1:${this.port} or http://localhost:${this.port}`,
        "forbidden",
      );
    }
  }

  private async api(req: Request, url: URL, parts: string[]): Promise<Response> {
    const engine = this.engine;
    const route = parts.join("/");
    const get = req.method === "GET" || req.method === "HEAD";
    const only = (method: "GET" | "POST") => {
      if (method === "GET" ? !get : req.method !== "POST") throw notAllowed(method);
    };
    if (route === "engine") {
      only("GET");
      return json(200, {
        engine_id: engine.engineId,
        pid: process.pid,
        home: engine.home,
        started_at: engine.startedAt,
        listen: this.port,
        // Not ready while shutting down (a signal, the TTL or idle sleep, D31): a client waits for the next engine.
        ready: this.ready && !engine.stopping,
        stopping: engine.stopping,
        pipelines: engine.list().length,
        // Nothing live to keep the engine up (§7.5, D31); it sleeps after engine.idle.
        idle: !engine.list().some((r) => LIVE_STATES.has(r.state)),
        ttl_expires_at: engine.ttlEndsAt === null ? null : new Date(engine.ttlEndsAt).toISOString(),
        // Where the dashboard's builder saves new pipelines (§8, D61).
        workspace: engine.workspace,
        // Pipo was updated since this engine started: the dashboard (served fresh) may be newer than it (D64).
        code_changed: this.code.stale,
      });
    }
    if (route === "engine/restart") {
      // Hand over to a fresh engine on the same port (§8, D65): it answers first, then drains and exits.
      only("POST");
      await readBody(req);
      return json(202, { restarting: true, from: process.pid, ...engine.restart() });
    }
    if (route === "agent-budget") {
      // Today's agent spend of every pipeline of the home vs engine.agent_budget.per_day (§3.11, D58), from the journals.
      only("GET");
      return json(200, homeAgentBudget(engine.home));
    }
    if (route === "settings") {
      // Dashboard settings (§8, D72).
      only("GET");
      return json(200, { workspace: engine.workspace, workspace_from: engine.workspaceFrom, home: engine.home });
    }
    if (route === "settings/workspace") {
      only("POST");
      const body = await readBody(req);
      const workspace = engine.setWorkspace(body.path, body.create === true);
      return json(200, { workspace, workspace_from: engine.workspaceFrom });
    }
    if (route === "folders") {
      // The settings page's folder picker: one folder's sub-folders.
      only("GET");
      return json(200, listFolders(url.searchParams.get("path")));
    }
    if (route === "bots") {
      // Chat bot accounts, `<home>/bots.json` (§3.13, D69). Tokens go in, never out.
      only("GET");
      return json(200, listBots(engine.home));
    }
    if (parts[0] === "bots" && parts[1] === "telegram" && parts[2] && parts.length <= 4) {
      only("POST");
      const name = decodeURIComponent(parts[2]);
      const body = await readBody(req);
      if (parts[3] === undefined) return json(200, saveBot(engine.home, name, body));
      if (parts[3] === "delete") return json(200, deleteBot(engine.home, name));
      if (parts[3] === "test") return json(200, await testBot(engine.home, name));
    }
    if (route === "events") {
      only("GET");
      return json(200, this.recentEvents(url));
    }
    if (route === "attach") {
      only("POST");
      const body = await readBody(req);
      const name = optional(body, "name", "string");
      if (name !== undefined && !NAME.test(name)) throw unknownPipeline(name);
      return json(200, { results: await engine.attach(name) });
    }
    if (route === "pipelines") {
      if (get) {
        const list = engine.list();
        const res = resourcesOf(list.flatMap((i) => (i.pid ? [i.pid] : [])));
        const pipelines = list.map((i) => ({
          ...i,
          lifetime: lifetimeOf(i, journalPath(engine.home, i.name)),
          stats: statsOf(journalPath(engine.home, i.name)),
          resources: (i.pid && res.get(i.pid)) || null,
        }));
        return json(200, { pipelines });
      }
      only("POST");
      const body = await readBody(req);
      const file = optional(body, "file", "string");
      if (!file || !isAbsolute(file)) {
        throw new HttpError(
          400,
          "`file` must be the absolute path of a .pipo file",
          'send {"file": "/path/to/x.pipo"}',
          "bad_request",
        );
      }
      return json(201, await engine.start(file, startOptions(body, ["file", ...START_KEYS])));
    }
    if (parts[0] === "builder" && parts.length === 2) {
      // The dashboard builder (§8, D62).
      const b = this.builder;
      switch (parts[1]) {
        case "catalog":
          only("GET");
          return json(200, b.catalog());
        case "agents":
          only("GET");
          return json(200, await b.agents(url.searchParams.get("refresh") === "1"));
        case "files":
          only("GET");
          return json(200, await b.files(url.searchParams.get("refresh") === "1"));
        case "open":
          only("GET");
          return json(200, b.open(url));
        case "check":
          only("POST");
          return json(200, b.check(await readBody(req)));
        case "save":
          only("POST");
          return json(200, b.save(await readBody(req)));
        case "test":
          only("POST");
          return json(200, await b.test(await readBody(req)));
        case "schema":
          if (get) return json(200, b.readSchema(url));
          only("POST");
          return json(200, b.writeSchema(await readBody(req)));
      }
    }
    if (parts[0] !== "pipelines" || parts.length < 2 || parts.length > 5) throw noRoute(url.pathname);
    const name = parts[1] as string;
    if (!NAME.test(name)) throw unknownPipeline(name);
    const action = parts[2];
    if (action === "graph" && parts.length === 3) {
      only("GET");
      const info = this.need(name);
      const graph = pipelineGraph(name, info.file, journalPath(engine.home, name), info.version);
      if (!graph) throw new HttpError(404, `can't read the definition of '${name}'`, `check ${info.file}`, "not_found");
      return json(200, graph);
    }
    if (action === "logs" && parts.length === 3) {
      only("GET");
      this.need(name);
      const q = url.searchParams;
      const tail = intParam(q.get("tail"), "tail", 200, 1, 1000);
      const after = q.get("after") === null ? null : intParam(q.get("after"), "after", 0, 0, Number.MAX_SAFE_INTEGER);
      return json(200, logPage(logPath(engine.home, name), { tail, after }));
    }
    if (action === "activity" && parts.length === 3) {
      only("GET");
      this.need(name);
      const limit = intParam(url.searchParams.get("limit"), "limit", 50, 1, 500);
      const events = activityEvents(journalPath(engine.home, name), limit);
      return json(200, { events: events ?? [] });
    }
    if (action === "packets" && parts.length <= 4) {
      only("GET");
      if (parts.length === 4)
        return json(200, await this.read(name, "packet", { packet_id: decode(parts[3] as string) }));
      const q = url.searchParams;
      return json(
        200,
        await this.read(name, "packets", { state: q.get("state"), limit: q.get("limit"), after: q.get("after") }),
      );
    }
    if (action === "versions" && parts.length <= 4) {
      only("GET");
      if (parts.length === 4)
        return json(200, await this.read(name, "version", { version: decode(parts[3] as string) }));
      return json(200, await this.read(name, "versions", {}));
    }
    if (action === "diff" && parts.length === 3) {
      only("GET");
      const q = url.searchParams;
      return json(200, await this.read(name, "diff", { from: q.get("from"), to: q.get("to") }));
    }
    if (action === "dlq" && parts.length === 3) {
      only("GET");
      const q = url.searchParams;
      return json(200, await this.read(name, "dlq", { limit: q.get("limit"), after: q.get("after") }));
    }
    if (action === "dlq" && (parts[3] === "replay" || parts[3] === "purge")) {
      only("POST");
      const op = parts[3];
      const body = await readBody(req);
      const all = optional(body, "all", "boolean");
      const by = optional(body, "by", "string");
      if (body.ids !== undefined && !Array.isArray(body.ids)) {
        throw new HttpError(
          400,
          "`ids` must be a list of packet ids",
          'send {"ids": ["01J…"]} or {"all": true}',
          "bad_request",
        );
      }
      this.needRunner(name, op);
      const args = {
        ...(body.ids !== undefined && { ids: body.ids }),
        ...(all !== undefined && { all }),
        by: by ?? "api",
      };
      return json(200, await runnerOp(name, () => engine.request(name, op, args, 120_000)));
    }
    if (action === "proposals") return await this.proposals(req, url, name, parts);
    if (parts.length > 3) throw noRoute(url.pathname);
    if (action === undefined) {
      only("GET");
      const info = this.need(name);
      const runner = info.state === "running" ? await engine.request(name, "status", {}, 2000).catch(() => null) : null;
      const resources = (info.pid && resourcesOf([info.pid]).get(info.pid)) || null;
      return json(200, { ...info, lifetime: lifetimeOf(info, journalPath(engine.home, name)), runner, resources });
    }
    only("POST");
    const body = await readBody(req);
    switch (action) {
      case "start":
        return json(200, await engine.start(this.need(name).file, startOptions(body, START_KEYS)));
      case "stop": {
        const now = optional(body, "now", "boolean");
        this.need(name);
        return json(200, await engine.stop(name, { now: now ?? false }));
      }
      case "drain":
        this.need(name);
        return json(200, await engine.drain(name));
      case "restart": {
        // As `pipo restart`: a deliberate stop (unless already stopped or halted), then a start (D57, D68).
        const opts = startOptions(body, START_KEYS);
        const info = this.need(name);
        if (info.state !== "stopped" && info.state !== "failed") await engine.stop(name);
        return json(200, await engine.start(info.file, opts));
      }
      case "pause": {
        const reason = optional(body, "reason", "string") ?? "manual";
        if (reason !== "manual" && reason !== "agent") {
          throw new HttpError(400, `bad pause reason '${reason}'`, "use manual or agent", "bad_request");
        }
        this.need(name);
        return json(200, await runnerOp(name, () => engine.pause(name, reason)));
      }
      case "resume":
        this.need(name);
        return json(200, await runnerOp(name, () => engine.resume(name)));
      case "push": {
        if (!("data" in body)) {
          throw new HttpError(400, "push needs `data`", 'send {"data": {...}, "source": "optional"}', "bad_request");
        }
        const source = optional(body, "source", "string");
        this.need(name);
        const args = { data: body.data, ...(source !== undefined && { source }) };
        return json(200, await runnerOp(name, () => engine.request(name, "push", args)));
      }
      case "rollback": {
        const unknown = Object.keys(body).filter((k) => k !== "version" && k !== "by");
        if (unknown.length) {
          throw new HttpError(
            400,
            `unknown ${unknown.length > 1 ? "keys" : "key"} ${unknown.map((k) => `\`${k}\``).join(", ")}`,
            "this request takes `version` and `by`",
            "bad_request",
          );
        }
        if (body.version === undefined || body.version === null) {
          throw new HttpError(400, "rollback needs `version`", 'send {"version": 2}', "bad_request");
        }
        const by = optional(body, "by", "string");
        this.needRunner(name, "rollback");
        const args = { version: body.version, by: by ?? "api" };
        return json(200, await runnerOp(name, () => engine.request(name, "rollback", args, 120_000)));
      }
      case "resolve": {
        const unknown = Object.keys(body).filter((k) => !RESOLVE_KEYS.includes(k));
        if (unknown.length) throw unknownKeys(unknown, "ids (or packet_id), action, by, by_kind and reason");
        if (typeof body.action !== "string") {
          throw new HttpError(
            400,
            "resolve needs `action`: retry, dead_letter or drop",
            'send {"ids": ["01J…"], "action": "retry"}',
            "bad_request",
          );
        }
        const by = optional(body, "by", "string");
        const reason = optional(body, "reason", "string");
        const kind = optional(body, "by_kind", "string");
        this.need(name);
        const args = {
          ...(body.ids !== undefined && { ids: body.ids }),
          ...(body.packet_id !== undefined && { packet_id: body.packet_id }),
          action: body.action,
          by: by ?? "api",
          by_kind: kind ?? "human",
          ...(reason !== undefined && { reason }),
        };
        return json(200, await runnerOp(name, () => engine.request(name, "resolve", args)));
      }
      case "ack": {
        const packetId = optional(body, "packet_id", "string");
        if (!packetId) throw new HttpError(400, "ack needs `packet_id`", 'send {"packet_id": "..."}', "bad_request");
        this.need(name);
        return json(200, await runnerOp(name, () => engine.request(name, "ack", { packet_id: packetId })));
      }
      default:
        throw noRoute(url.pathname);
    }
  }

  /** A REST call made in-process for the MCP endpoint, answered exactly as over HTTP (same checks, reads, errors). */
  private async internal(method: "GET" | "POST", path: string, body?: Record<string, unknown>) {
    const url = new URL(path, this.url);
    const req = new Request(url.href, {
      method,
      headers: { "content-type": "application/json" },
      ...(method === "POST" && { body: JSON.stringify(body ?? {}) }),
    });
    let res: Response;
    try {
      if (url.pathname !== "/api/engine") this.whenReady();
      res = await this.api(req, url, url.pathname.split("/").slice(2));
    } catch (e) {
      res = errorResponse(e);
    }
    return { status: res.status, body: (await res.json()) as any };
  }

  /** `/proposals`, `/proposals/<id>` and its `apply` and `reject` (§9.3, D51). */
  private async proposals(req: Request, url: URL, name: string, parts: string[]): Promise<Response> {
    const engine = this.engine;
    if (parts.length > 5) throw noRoute(url.pathname);
    const id = parts[3] === undefined ? undefined : decode(parts[3]);
    const verb = parts[4];
    if (req.method === "GET" || req.method === "HEAD") {
      if (verb !== undefined) throw notAllowed("POST");
      if (id === undefined) {
        const q = url.searchParams;
        return json(200, await this.read(name, "proposals", { state: q.get("state"), limit: q.get("limit") }));
      }
      return json(200, await this.read(name, "proposal", { id }));
    }
    if (req.method !== "POST") throw notAllowed(id === undefined ? "POST" : "GET");
    if (id !== undefined && verb !== "apply" && verb !== "reject") throw noRoute(url.pathname);
    const body = await readBody(req);
    const by = optional(body, "by", "string");
    let op: string;
    let args: Record<string, unknown>;
    if (id === undefined) {
      const unknown = Object.keys(body).filter((k) => !PROPOSE_KEYS.includes(k));
      if (unknown.length) throw unknownKeys(unknown, "source, base_version, reason, by, by_kind and apply");
      const kind = optional(body, "by_kind", "string");
      const apply = optional(body, "apply", "boolean");
      op = "propose";
      args = {
        source: body.source,
        base_version: body.base_version,
        reason: body.reason,
        author: by ?? "api",
        author_kind: kind ?? "human",
        ...(apply !== undefined && { apply }),
      };
    } else if (verb === "apply") {
      const unknown = Object.keys(body).filter((k) => k !== "by");
      if (unknown.length) throw unknownKeys(unknown, "`by`");
      op = "apply_proposal";
      args = { id, by: by ?? "api" };
    } else {
      const unknown = Object.keys(body).filter((k) => k !== "by" && k !== "reason");
      if (unknown.length) throw unknownKeys(unknown, "reason and by");
      op = "reject_proposal";
      args = { id, reason: body.reason, by: by ?? "api" };
    }
    this.needRunner(name, op === "propose" ? "propose" : op === "apply_proposal" ? "apply" : "reject");
    return json(200, await runnerOp(name, () => engine.request(name, op, args, 120_000)));
  }

  /** The pipeline's info, or a 404 that says whether a runner is registered that this engine doesn't supervise. */
  private need(name: string): RunnerInfo {
    const info = this.engine.get(name);
    if (info) return info;
    throw this.unsupervised(name);
  }

  /**
   * A packet read: from the runner while it runs; otherwise (stopped, crashed, not supervised, or the runner went away
   * mid-request) from the journal, read-only. `source` says which.
   */
  private async read(name: string, op: ReadOp, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const info = this.engine.get(name);
    if (info?.state === "running") {
      try {
        return { ...(await this.engine.request(name, op, args, 10_000)), source: "runner" };
      } catch (e) {
        // The runner's own answer (a bad argument, an unknown packet) stands; a runner that is going away doesn't.
        if (e instanceof ControlError && e.code !== "invalid_state" && e.code !== "unavailable") throw e;
      }
    }
    const off = await offlineRead(this.engine.home, op, args, name);
    if (!off) {
      if (info)
        throw new HttpError(404, `'${name}' has no journal yet`, `start it once (pipo start ${name})`, "not_found");
      throw this.unsupervised(name);
    }
    return {
      ...(off.result as Record<string, unknown>),
      source: "journal",
      ...(off.withheld && { withheld: off.withheld }),
    };
  }

  /** A DLQ write needs the runner: a pipeline this engine knows is checked by Supervisor.request; others get a hint. */
  private needRunner(name: string, op: string) {
    if (this.engine.get(name)) return;
    if (existsSync(journalPath(this.engine.home, name))) {
      throw new HttpError(
        409,
        `'${name}' is not running; ${op} needs its runner`,
        `start it (pipo start <file>), then ${op} again`,
        "invalid_state",
      );
    }
    throw this.unsupervised(name);
  }

  private unsupervised(name: string): HttpError {
    const reg = readRegistryEntry(this.engine.home, name);
    return unknownPipeline(
      name,
      reg
        ? `a runner of '${name}' is registered (pid ${reg.pid}) but this engine does not supervise it: run pipo attach ${name}`
        : undefined,
    );
  }

  // ── /in proxy ────────────────────────────────────────────────────────────────

  private async proxy(req: Request, url: URL, server: Server<undefined>): Promise<Response> {
    server.timeout(req, 0); // `respond: delivered` may wait longer than Bun's idle timeout
    const name = url.pathname.split("/")[2] ?? "";
    if (!name) {
      throw new HttpError(404, "no pipeline in the path", "send webhooks to /in/<pipeline><path>", "not_found");
    }
    if (!NAME.test(name)) throw unknownPipeline(name);
    this.whenReady();
    const info = this.need(name);
    if (info.state !== "running") {
      const retry = info.state === "starting" || info.state === "backoff";
      throw new HttpError(
        503,
        `'${name}' is ${info.state}, so it is not accepting requests`,
        info.error?.hint ??
          (retry
            ? "try again in a moment"
            : info.state === "stopping"
              ? "it is stopping; start it again once it stopped (pipo start)"
              : `start it again (pipo start ${name})`),
        "unavailable",
        { state: info.state },
        retry ? { "retry-after": "1" } : {},
      );
    }
    if (!info.listen) {
      throw new HttpError(
        404,
        `'${name}' has no http input`,
        `send its packets with pipo push ${name}, or POST /api/pipelines/${name}/push`,
        "not_found",
      );
    }
    const headers = new Headers(req.headers);
    for (const h of [...HOP_BY_HOP, "host"]) headers.delete(h);
    const ip = server.requestIP(req)?.address;
    if (ip) headers.set("x-forwarded-for", [req.headers.get("x-forwarded-for"), ip].filter(Boolean).join(", "));
    if (req.headers.get("host")) headers.set("x-forwarded-host", req.headers.get("host") as string);
    headers.set("x-forwarded-proto", "http");
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${info.listen}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        // A fresh connection each time: a pooled one to a runner that restarted would fail after sending.
        keepalive: false,
        signal: req.signal,
      });
    } catch (e) {
      const refused = (e as { code?: string }).code === "ConnectionRefused";
      if (refused) {
        throw new HttpError(
          503,
          `'${name}' is not accepting requests: nothing listens on its port ${info.listen}`,
          "it may be stopping or restarting; try again in a moment",
          "unavailable",
          {},
          { "retry-after": "1" },
        );
      }
      throw new HttpError(
        502,
        `'${name}' did not answer: ${(e as Error).message}`,
        `the request may have been accepted before the runner went away; check pipo packets ${name} before sending it again`,
        "bad_gateway",
      );
    }
    const out = new Headers(res.headers);
    // fetch decoded the body, so its encoding and length headers no longer describe it.
    for (const h of [...HOP_BY_HOP, "content-encoding", "content-length"]) out.delete(h);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  }
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, `bad path segment '${segment}'`, "percent-encode the packet id", "bad_request");
  }
}

function sseEvent(e: GatewayEvent): string {
  return `id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`;
}

function intParam(raw: string | null, name: string, dflt: number, min: number, max: number): number {
  if (raw === null) return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `bad ${name} '${raw}'`, `use a whole number from ${min} to ${max}`, "bad_request");
  }
  return n;
}

function unknownPipeline(name: string, hint?: string): HttpError {
  return new HttpError(
    404,
    `no pipeline named '${name}' in this engine`,
    hint ?? "GET /api/pipelines lists them; start one with POST /api/pipelines {file} (pipo start <file>)",
    "not_found",
  );
}

function noRoute(path: string): HttpError {
  return new HttpError(
    404,
    `no API route ${path}`,
    "see `routes`; if the dashboard or the CLI sent this, the engine may be older than them: restart it (pipo engine stop, then pipo ui)",
    "not_found",
    { routes: ROUTES },
  );
}

function notAllowed(method: string): HttpError {
  return new HttpError(
    405,
    `use ${method} here`,
    `send a ${method} request`,
    "method_not_allowed",
    {},
    { allow: method },
  );
}

/** A JSON object body. POSTs must say `Content-Type: application/json`, even when empty (cross-site safety). */
async function readBody(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    throw new HttpError(
      415,
      "the engine API takes JSON",
      "send Content-Type: application/json (an empty body is fine)",
      "unsupported_media_type",
    );
  }
  const text = await req.text();
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (e) {
    throw new HttpError(
      400,
      `the body is not valid JSON: ${(e as Error).message}`,
      "send a JSON object",
      "bad_request",
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "the body must be a JSON object", 'for example {"now": true}', "bad_request");
  }
  return body as Record<string, unknown>;
}

function optional<K extends "string" | "boolean" | "number">(
  body: Record<string, unknown>,
  key: string,
  type: K,
): (K extends "string" ? string : K extends "boolean" ? boolean : number) | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== type) {
    throw new HttpError(400, `\`${key}\` must be a ${type}, got ${JSON.stringify(v)}`, `fix \`${key}\``, "bad_request");
  }
  return v as never;
}

function unknownKeys(unknown: string[], takes: string): HttpError {
  return new HttpError(
    400,
    `unknown ${unknown.length > 1 ? "keys" : "key"} ${unknown.map((k) => `\`${k}\``).join(", ")}`,
    `this request takes ${takes}`,
    "bad_request",
  );
}

function startOptions(body: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new HttpError(
      400,
      `unknown ${unknown.length > 1 ? "keys" : "key"} ${unknown.map((k) => `\`${k}\``).join(", ")}`,
      `this request takes ${allowed.map((k) => `\`${k}\``).join(", ")}`,
      "bad_request",
    );
  }
  const listen = optional(body, "listen", "number");
  if (listen !== undefined && (!Number.isInteger(listen) || listen < 1 || listen > 65535)) {
    throw new HttpError(400, `bad listen ${listen}`, "use a port from 1 to 65535", "bad_request");
  }
  const detached = optional(body, "detached", "boolean");
  // `ttl` (D57): a duration such as "30m" for this start only; the supervisor checks it (400 bad_request).
  const ttl = optional(body, "ttl", "string");
  return {
    ...(listen !== undefined && { listen }),
    ...(detached !== undefined && { detached }),
    ...(ttl !== undefined && { ttl }),
  };
}

/** A control op on a runner: a socket that doesn't answer is 503, not a server error. */
async function runnerOp<T>(name: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    if (e instanceof EngineError || e instanceof ControlError || e instanceof HttpError) throw e;
    throw new HttpError(
      503,
      `'${name}' did not answer: ${(e as Error).message}`,
      `check its state with GET /api/pipelines/${name}, then try again`,
      "unavailable",
    );
  }
}

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return fail(e);
  if (e instanceof EngineError) {
    return fail(
      new HttpError(
        ENGINE_STATUS[e.code] ?? 500,
        e.message,
        e.hint ?? "see the engine log",
        e.code,
        e.diagnostics.length ? { diagnostics: e.diagnostics } : {},
      ),
    );
  }
  if (e instanceof ControlError) {
    return fail(
      new HttpError(CONTROL_STATUS[e.code] ?? 500, e.message, e.hint ?? "see the pipeline's log", e.code, {
        ...(e.packetId ? { packet_id: e.packetId } : {}),
        // A definition that fails `pipo check` (apply, rollback): its diagnostics, as `pipo check --json` (D60).
        ...(e.diagnostics?.length ? { diagnostics: e.diagnostics } : {}),
      }),
    );
  }
  return fail(new HttpError(500, (e as Error)?.message ?? String(e), "see the engine log", "internal"));
}
