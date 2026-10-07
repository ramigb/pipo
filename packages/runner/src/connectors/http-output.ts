// `to: http` (docs/spec.md §3.5). Sends `Idempotency-Key: <packet_id>` so a retried or
// recovered write is safe for receivers that honour it. A status outside `success` throws,
// which flows into the output's error policy (retry, then dead-letter, …).
import { toText } from "@pipo/spec";
import type { OutputAdapter, WriteItem } from "./types";

const TIMEOUT_MS = 30_000;
const FOLLOW_UP_TIMEOUT_MS = 5_000;
const DEFAULT_SUCCESS: unknown[] = ["200-299"];

/** Accepts 204, "204", "2xx" and "200-299". */
export function statusMatcher(spec: unknown): (status: number) => boolean {
  const list = Array.isArray(spec) && spec.length ? spec : DEFAULT_SUCCESS;
  const tests = list.map((s): ((n: number) => boolean) => {
    const text = String(s).trim().toLowerCase();
    if (/^\d{3}$/.test(text)) return (n) => n === Number(text);
    const cls = text.match(/^([1-5])xx$/);
    if (cls) return (n) => Math.floor(n / 100) === Number(cls[1]);
    const range = text.match(/^(\d{3})\s*-\s*(\d{3})$/);
    if (range) return (n) => n >= Number(range[1]) && n <= Number(range[2]);
    throw new Error(`invalid success status '${s}'; use 204, "2xx" or "200-299"`);
  });
  return (n) => tests.some((t) => t(n));
}

const subset = (want: unknown, got: unknown): boolean => {
  if (want && typeof want === "object") {
    if (!got || typeof got !== "object") return false;
    if (Array.isArray(want)) {
      return Array.isArray(got) && want.every((w) => got.some((g) => subset(w, g)));
    }
    return Object.entries(want).every(([k, v]) => subset(v, (got as Record<string, unknown>)[k]));
  }
  return want === got;
};

/** `match` is text the body must contain, or (object/number/bool) a JSON subset the parsed body must include. */
function bodyMatches(body: string, match: unknown): boolean {
  if (typeof match === "string") return body.includes(match);
  try {
    return subset(match, JSON.parse(body));
  } catch {
    return body.includes(String(match));
  }
}

export interface HttpResult {
  status: number;
  text: string;
  contentType: string;
}

/** One request from an http `with:` block (output, tap or transform). Throws unless the status is in `success`. */
export async function httpCall(
  w: Record<string, unknown>,
  data: unknown,
  idempotencyKey: string,
  owner: string,
): Promise<HttpResult> {
  const s = w as { method?: string; url?: string; headers?: Record<string, string>; body?: unknown; success?: unknown };
  const method = s.method ?? "POST";
  if (!s.url) throw new Error(`${owner}.with.url is empty after rendering; check the template`);
  const headers: Record<string, string> = { "Idempotency-Key": idempotencyKey, ...(s.headers ?? {}) };
  const lower = new Set(Object.keys(headers).map((h) => h.toLowerCase()));
  let body: string | undefined;
  if (method !== "GET" && method !== "DELETE") {
    const payload = s.body === undefined ? data : s.body;
    body = typeof payload === "string" ? payload : JSON.stringify(payload);
    if (!lower.has("content-type"))
      headers["Content-Type"] = typeof payload === "string" ? "text/plain" : "application/json";
  }
  const ok = statusMatcher(s.success);
  let res: Response;
  try {
    res = await fetch(s.url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new Error(`${method} ${s.url} failed: ${(e as Error).message}`);
  }
  const text = await res.text().catch(() => "");
  if (!ok(res.status)) {
    const snippet = text ? `: ${toText(text).slice(0, 200)}` : "";
    throw new Error(
      `${method} ${s.url} answered ${res.status}, not in the success list${snippet} (set ${owner}.with.success to accept it)`,
    );
  }
  return { status: res.status, text, contentType: res.headers.get("content-type") ?? "" };
}

export class HttpOutput implements OutputAdapter {
  async write(items: WriteItem[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const item of items) results.push(await this.send(item));
    return results;
  }

  private async send(item: WriteItem): Promise<unknown> {
    const { status } = await httpCall(item.with, item.data, item.packetId, "output");
    return { status };
  }

  async verify(check: string, checkWith: Record<string, unknown>, _item: WriteItem, result: unknown): Promise<boolean> {
    if (check === "status") {
      const status = (result as { status?: unknown } | null)?.status;
      if (typeof status !== "number")
        throw new Error("no stored write status to check; the packet was written without one");
      return statusMatcher(checkWith.success)(status);
    }
    if (check !== "follow_up") throw new Error(`http output does not support delivery check '${check}'`);
    const url = checkWith.url;
    if (typeof url !== "string" || !url)
      throw new Error("delivered.with.url is empty after rendering; check the template");
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: (checkWith.headers as Record<string, string> | undefined) ?? {},
        signal: AbortSignal.timeout(FOLLOW_UP_TIMEOUT_MS),
      });
      text = await res.text();
    } catch (e) {
      throw new Error(`GET ${url} failed: ${(e as Error).message}; check that the receiver is reachable`);
    }
    if (!statusMatcher(checkWith.success)(res.status)) return false;
    return checkWith.match === undefined ? true : bodyMatches(text, checkWith.match);
  }

  close(): void {}
}
