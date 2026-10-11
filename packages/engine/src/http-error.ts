// An API error with its HTTP status (docs/spec.md §7.1, D28): served as `{error, hint, code, ...extra}`.
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly hint: string,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** A JSON object body. POSTs must say `Content-Type: application/json`, even when empty (cross-site safety). */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
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

export function optional<K extends "string" | "boolean" | "number">(
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

export function unknownKeys(unknown: string[], takes: string): HttpError {
  return new HttpError(
    400,
    `unknown ${unknown.length > 1 ? "keys" : "key"} ${unknown.map((k) => `\`${k}\``).join(", ")}`,
    `this request takes ${takes}`,
    "bad_request",
  );
}
