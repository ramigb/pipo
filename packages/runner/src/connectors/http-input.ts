// `via: http` (docs/spec.md §3.3, D17, D30). Served at /in/<pipeline><path>, on the runner's own port.
import { createHmac, timingSafeEqual } from "node:crypto";
import { parseDuration } from "@pipo/spec";
import type { InputAdapter, Intake, IntakeResult } from "./types";

export interface HttpInputOptions {
  pipeline: string;
  path: string;
  method: string;
  port: number;
  hostname: string;
  format: "json" | "text" | "form" | "csv" | "bytes";
  auth?: { header: string; equals: string };
  hmac?: { header: string; secret: string; algorithm: "sha256" | "sha1" };
  respond?: "accepted" | "delivered";
  /** How long `respond: delivered` waits for a terminal state. */
  timeout?: string;
  /** Seconds an idle connection is kept (Bun's `idleTimeout`). Default 10; tests lower it. */
  idleTimeout?: number;
}

/** Bun's own default, and the floor: idle keep-alive connections are still reaped. */
const IDLE_SECONDS = 10;
/** The most Bun accepts for a connection timeout; past it only 0 (no limit) is left. */
const MAX_IDLE_SECONDS = 255;

/**
 * The connection timeout for a request that waits `waitMs` for its packet to settle (`respond: delivered`, D30):
 * the wait plus 10 s for intake and the reply, so the idle timeout never cuts the answer off. A wait too long for
 * Bun's limit gets 0 (no limit): it is still bounded, by `timeout` itself.
 */
export function deliveredTimeout(waitMs: number): number {
  const seconds = Math.ceil(waitMs / 1000) + IDLE_SECONDS;
  return seconds > MAX_IDLE_SECONDS ? 0 : seconds;
}

/** What the runner reports when a packet settles: the final state and, if it failed, why. */
export interface Settled {
  state: string;
  error?: { code?: string; message?: string; node?: string } | null;
}

/** Resolves when the packet reaches a terminal state, or null when `ms` passes first. */
export type AwaitTerminal = (packetId: string, ms: number) => Promise<Settled | null>;

class BadBody extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

/** RFC 4180 records: quoted fields, doubled quotes, newlines inside quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  const endRow = () => {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    field = "";
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && !started) quoted = started = true;
    else if (c === '"')
      throw new BadBody("stray quote in csv field", "quote the whole field and double any inner quotes");
    else if (c === ",") {
      row.push(field);
      field = "";
      started = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      field += c;
      started = true;
    }
  }
  if (quoted) throw new BadBody("csv has an unterminated quote", "close every quoted field");
  if (field !== "" || row.length) endRow();
  return rows;
}

function csvRecords(text: string): Record<string, string>[] {
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  if (rows.length < 2)
    throw new BadBody(
      "csv needs a header row and at least one record",
      "send the header line first, then one line per record",
    );
  const [header, ...records] = rows as [string[], ...string[][]];
  if (new Set(header).size !== header.length || header.some((h) => h === ""))
    throw new BadBody("csv header has empty or repeated column names", "give every column a unique name");
  return records.map((r, i) => {
    if (r.length !== header.length)
      throw new BadBody(
        `csv record ${i + 1} has ${r.length} field(s), the header has ${header.length}`,
        "every record needs one value per header column",
      );
    return Object.fromEntries(header.map((h, j) => [h, r[j] as string]));
  });
}

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class HttpInput implements InputAdapter {
  private server: ReturnType<typeof Bun.serve> | undefined;
  /** Set by the runner; needed for `respond: delivered`. */
  awaitTerminal?: AwaitTerminal;
  readonly route: string;

  constructor(private readonly opts: HttpInputOptions) {
    this.route = `/in/${opts.pipeline}${opts.path === "/" ? "" : opts.path}`;
  }

  get port(): number | undefined {
    return this.server?.port;
  }

  describe(): string {
    return `${this.opts.method} http://${this.opts.hostname}:${this.server?.port ?? this.opts.port}${this.route}`;
  }

  async start(intake: Intake): Promise<void> {
    const { opts, route } = this;
    const waitMs = parseDuration(opts.timeout ?? "30s");
    this.server = Bun.serve({
      port: opts.port,
      hostname: opts.hostname,
      idleTimeout: opts.idleTimeout ?? IDLE_SECONDS,
      fetch: async (req, server) => {
        const url = new URL(req.url);
        const path = url.pathname.replace(/\/+$/, "") || "/";
        if (path !== route) return reply(404, { error: `no input at ${path}` });
        if (req.method !== opts.method) return reply(405, { error: `use ${opts.method}` }, { Allow: opts.method });
        if (opts.auth && !sameSecret(req.headers.get(opts.auth.header) ?? "", opts.auth.equals)) {
          return reply(401, { error: "unauthorized", hint: `send the token in the ${opts.auth.header} header` });
        }
        const raw = Buffer.from(await req.arrayBuffer());
        if (opts.hmac && !this.signed(req.headers.get(opts.hmac.header), raw)) {
          return reply(401, {
            error: "invalid or missing signature",
            hint: `send the hex ${opts.hmac.algorithm} HMAC of the raw body in the ${opts.hmac.header} header`,
          });
        }
        let payloads: unknown[];
        try {
          payloads = await this.parse(req, raw);
        } catch (e) {
          if (e instanceof BadBody) return reply(400, { error: e.message, hint: e.hint });
          return reply(400, { error: `body is not valid ${opts.format}`, hint: `send a ${opts.format} body` });
        }
        // Waiting for delivery is not idleness: give this request room for its whole wait.
        if (opts.respond === "delivered") server.timeout(req, deliveredTimeout(waitMs));
        const source = server.requestIP(req)?.address ?? "unknown";
        const results: IntakeResult[] = [];
        for (const payload of payloads) {
          const result = await intake(payload, { trigger: "http", source });
          results.push(result);
          if (result.status === "unavailable") break;
        }
        return this.answer(results, opts.format === "csv");
      },
    });
  }

  private signed(header: string | null, body: Buffer): boolean {
    const h = this.opts.hmac;
    if (!h || !header) return false;
    const given = header
      .trim()
      .replace(/^(sha256|sha1)=/i, "")
      .toLowerCase();
    return sameSecret(given, createHmac(h.algorithm, h.secret).update(body).digest("hex"));
  }

  private async parse(req: Request, raw: Buffer): Promise<unknown[]> {
    switch (this.opts.format) {
      case "json":
        return [JSON.parse(raw.toString("utf8"))];
      case "text":
        return [raw.toString("utf8")];
      case "form": {
        const form = await new Response(raw, {
          headers: { "content-type": req.headers.get("content-type") ?? "" },
        }).formData();
        return [Object.fromEntries(form.entries())];
      }
      case "csv":
        return csvRecords(raw.toString("utf8"));
      case "bytes":
        return [
          {
            base64: raw.toString("base64"),
            content_type: req.headers.get("content-type") ?? "application/octet-stream",
            size: raw.length,
          },
        ];
    }
  }

  private async answer(results: IntakeResult[], many: boolean): Promise<Response> {
    const unavailable = results.find((r) => r.status === "unavailable");
    const accepted = results.filter((r) => r.status === "accepted");
    if (unavailable && !accepted.length) return reply(503, { error: unavailable.reason }, { "Retry-After": "5" });
    const rejected = results.find((r) => r.status === "rejected");
    const wait = this.opts.respond === "delivered" && this.awaitTerminal;
    const ms = parseDuration(this.opts.timeout ?? "30s");
    const packets = await Promise.all(
      results.map(async (r) => {
        if (r.status === "rejected")
          return { packet_id: r.packet_id, state: "rejected", error: r.message, rule: r.rule };
        if (r.status === "unavailable") return { state: "unavailable", error: r.reason };
        if (!wait) return { packet_id: r.packet_id, state: "accepted" };
        const done = await wait(r.packet_id, ms);
        if (!done) return { packet_id: r.packet_id, state: "accepted" };
        return { packet_id: r.packet_id, state: done.state, ...(done.error && { error: done.error.message }) };
      }),
    );
    const body = many ? { packets } : packets[0];
    if (rejected && rejected.status === "rejected" && !accepted.length) return reply(rejected.respond ?? 422, body);
    if (unavailable) return reply(503, { packets, error: unavailable.reason }, { "Retry-After": "5" });
    if (rejected) return reply(rejected.status === "rejected" ? (rejected.respond ?? 422) : 422, body);
    if (packets.some((p) => p.state === "dead_lettered")) return reply(502, body);
    // Waiting for an agent (D50) is not a result yet: accepted, with its state and error.
    if (packets.some((p) => p.state === "accepted" || p.state === "escalated")) return reply(202, body);
    return reply(wait ? 200 : 202, body);
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    // Let in-flight requests finish, but don't wait forever on idle keep-alive connections.
    await Promise.race([server.stop(), Bun.sleep(2000)]);
    await server.stop(true);
  }
}
