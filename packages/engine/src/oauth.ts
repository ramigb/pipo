// OAuth for the MCP endpoint (docs/spec.md §9.2, D82), as the MCP authorization spec (2025-06-18) asks: the engine is
// both the protected resource (`/mcp`) and its authorization server. An MCP client discovers it from the 401's
// `WWW-Authenticate: Bearer resource_metadata=…` (RFC 9728), reads the server metadata (RFC 8414), registers itself
// (RFC 7591, public clients only), and sends the browser to `/oauth/authorize` with PKCE (S256). That request waits in
// memory and the browser lands on the dashboard's consent page (`/ui/#/connect/<id>`), where the human picks the scope
// and pipelines; only the dashboard can approve (loopback `/api`, JSON POSTs). The client then trades the one-time
// code for an access token (1 h) and a refresh token (30 d, rotated on use) at `/oauth/token`.
// Grants live in `<home>/mcp-grants.json` (0600, atomic) as SHA-256 digests only, so they survive engine restarts and
// the file holds nothing a client could use; `pipo mcp grants revoke` or the Agents page revokes one.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_SCOPES, type McpScope } from "./config";
import { safeEqual, sha256, randomToken as token, writePrivateJson } from "./files";
import { HttpError } from "./http-error";

export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
const MAX_CLIENTS = 100;
const MAX_PENDING = 100;
const MAX_REDIRECTS = 10;
const MAX_LIVE_ACCESS = 8;
const GRANT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PIPELINE = /^[a-z0-9][a-z0-9-]*$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: string;
}

export interface Grant {
  id: string;
  client_id: string;
  client_name: string;
  /** Who the agent is: the author of its proposals, the `by` of what it does, and the owner of what it writes. */
  name: string;
  /** Who approved it on the consent page (D84): the owner's username, or `api` in open mode. */
  approved_by?: string;
  scope: McpScope;
  pipelines: string[] | null;
  resource: string;
  created_at: string;
  last_used_at: string | null;
  refresh_digest: string;
  /** The refresh token rotated away last: using it again revokes the grant (it leaked). */
  previous_refresh_digest: string | null;
  refresh_expires_at: string;
  access: { digest: string; expires_at: string }[];
}

interface Store {
  clients: Record<string, OAuthClient>;
  grants: Grant[];
}

/** An authorization request waiting for the human on the consent page. */
interface Pending {
  id: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  scope: McpScope;
  resource: string;
  expires: number;
}

interface Code {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: McpScope;
  pipelines: string[] | null;
  name: string;
  expires: number;
  approved_by: string;
}

/** Who a bearer token is, when it belongs to a live grant. */
export interface GrantIdentity {
  grant_id: string;
  name: string;
  scope: McpScope;
  pipelines: string[] | null;
}

const nowIso = () => new Date().toISOString();
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A redirect URI a public client may register: http on a loopback host (any port), or https. No fragment. */
export function redirectProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return "must be a URL";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "must be an absolute URL";
  }
  if (url.hash) return "must not have a fragment";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return null;
  return "must be http://localhost (or 127.0.0.1, [::1]) on any port, or https://";
}

/** The highest scope named in a space-separated `scope`, or null when it names none. */
export function scopeFrom(raw: string | null): McpScope | null {
  if (!raw) return null;
  const asked = raw.split(/\s+/).filter((s): s is McpScope => (MCP_SCOPES as readonly string[]).includes(s));
  if (!asked.length) return null;
  return asked.reduce((a, b) => (MCP_SCOPES.indexOf(b) > MCP_SCOPES.indexOf(a) ? b : a));
}

/** Whether `raw` names this engine's MCP endpoint, under any loopback host or its public URL (D85). */
function isOurResource(raw: string, port: number, publicUrl: string | null): boolean {
  try {
    const u = new URL(raw);
    const local = u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname) && Number(u.port || 80) === port;
    return (local || u.origin === publicUrl) && u.pathname.replace(/\/+$/, "") === "/mcp" && !u.search && !u.hash;
  } catch {
    return false;
  }
}

export class OAuth {
  private readonly path: string;
  private readonly pending = new Map<string, Pending>();
  private readonly codes = new Map<string, Code>();
  /** Codes already traded, for 10 minutes: a second use revokes the grant it made (RFC 6749 §4.1.2). */
  private readonly used = new Map<string, { grant: string; expires: number }>();

  constructor(
    home: string,
    private readonly port: () => number,
    private readonly publicUrl: string | null = null,
  ) {
    this.path = join(home, "mcp-grants.json");
  }

  // ── store ──────────────────────────────────────────────────────────────────

  private read(): Store {
    try {
      const s = JSON.parse(readFileSync(this.path, "utf8")) as Store;
      if (isMap(s) && isMap(s.clients) && Array.isArray(s.grants)) return s;
    } catch {}
    return { clients: {}, grants: [] };
  }

  private write(store: Store) {
    const now = Date.now();
    // Expired grants go, and clients without a grant once they are a month old.
    store.grants = store.grants.filter((g) => Date.parse(g.refresh_expires_at) > now);
    const live = new Set(store.grants.map((g) => g.client_id));
    for (const [id, c] of Object.entries(store.clients))
      if (!live.has(id) && now - Date.parse(c.created_at) > REFRESH_TTL_MS) delete store.clients[id];
    writePrivateJson(this.path, store);
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expires < now) this.codes.delete(k);
    for (const [k, v] of this.used) if (v.expires < now) this.used.delete(k);
  }

  // ── metadata ───────────────────────────────────────────────────────────────

  /** RFC 9728: where the MCP endpoint's tokens come from. */
  resourceMetadata(origin: string) {
    return {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: [...MCP_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "Pipo engine",
      resource_documentation: "https://ramigb.github.io/pipo/docs/agent-operators.html",
    };
  }

  /** RFC 8414: the authorization server. */
  serverMetadata(origin: string) {
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      scopes_supported: [...MCP_SCOPES],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    };
  }

  // ── registration (RFC 7591) ────────────────────────────────────────────────

  register(body: unknown): Record<string, unknown> {
    const fail = (description: string) => new OAuthError(400, "invalid_client_metadata", description);
    if (!isMap(body)) throw fail("send the client metadata as a JSON object");
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > MAX_REDIRECTS)
      throw new OAuthError(400, "invalid_redirect_uri", `redirect_uris must list 1 to ${MAX_REDIRECTS} URIs`);
    for (const u of uris) {
      const problem = redirectProblem(u);
      if (problem) throw new OAuthError(400, "invalid_redirect_uri", `redirect URI ${JSON.stringify(u)} ${problem}`);
    }
    const grantTypes = body.grant_types ?? ["authorization_code"];
    if (!Array.isArray(grantTypes) || !grantTypes.every((g) => g === "authorization_code" || g === "refresh_token"))
      throw fail("grant_types may be authorization_code and refresh_token");
    const responseTypes = body.response_types ?? ["code"];
    if (!Array.isArray(responseTypes) || !responseTypes.every((r) => r === "code"))
      throw fail("response_types may only be code");
    const rawName = typeof body.client_name === "string" ? body.client_name : "MCP client";
    // Printable only, and short: the consent page shows it, marked as the client's own (unverified) claim.
    const name = rawName.replace(/\p{C}/gu, "").trim().slice(0, 100) || "MCP client";
    const store = this.read();
    const clients = Object.values(store.clients);
    if (clients.length >= MAX_CLIENTS) {
      // Make room: the oldest client without a grant goes.
      const live = new Set(store.grants.map((g) => g.client_id));
      const spare = clients
        .filter((c) => !live.has(c.client_id))
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      if (!spare.length)
        throw new OAuthError(400, "invalid_client_metadata", "too many registered clients; revoke some grants first");
      delete store.clients[(spare[0] as OAuthClient).client_id];
    }
    const client: OAuthClient = {
      client_id: `c_${randomBytes(12).toString("base64url")}`,
      client_name: name,
      redirect_uris: [...(uris as string[])],
      created_at: nowIso(),
    };
    store.clients[client.client_id] = client;
    this.write(store);
    return {
      client_id: client.client_id,
      client_id_issued_at: Math.floor(Date.parse(client.created_at) / 1000),
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  // ── authorization ──────────────────────────────────────────────────────────

  /**
   * `GET /oauth/authorize`: a valid request waits for the human and the browser goes to the consent page. A bad
   * client or redirect URI gets an error page (never a redirect to an unchecked URI); other errors go back to the
   * client's redirect URI.
   */
  authorize(url: URL, origin: string): Response {
    this.sweep();
    const q = url.searchParams;
    const store = this.read();
    const client = store.clients[q.get("client_id") ?? ""];
    if (!client)
      return errorPage(
        "Unknown client",
        "This MCP client is not registered with this engine. Connect it again from the client.",
      );
    let redirect = q.get("redirect_uri");
    if (redirect === null && client.redirect_uris.length === 1) redirect = client.redirect_uris[0] as string;
    if (redirect === null || !client.redirect_uris.includes(redirect))
      return errorPage("Unknown redirect", "The redirect URI does not match the one this client registered.");
    const state = q.get("state");
    const back = (error: string, description: string) => {
      const to = new URL(redirect);
      to.searchParams.set("error", error);
      to.searchParams.set("error_description", description);
      if (state !== null) to.searchParams.set("state", state);
      to.searchParams.set("iss", origin);
      return new Response(null, { status: 302, headers: { location: to.href, "cache-control": "no-store" } });
    };
    if (q.get("response_type") !== "code") return back("unsupported_response_type", "only response_type=code");
    const challenge = q.get("code_challenge");
    if (!challenge || !/^[A-Za-z0-9\-_]{43}$/.test(challenge))
      return back("invalid_request", "PKCE is required: send code_challenge (S256)");
    if (q.get("code_challenge_method") !== "S256") return back("invalid_request", "code_challenge_method must be S256");
    const resource = q.get("resource") ?? `${origin}/mcp`;
    if (!isOurResource(resource, this.port(), this.publicUrl))
      return back("invalid_target", `resource must be ${origin}/mcp`);
    if (this.pending.size >= MAX_PENDING) return back("temporarily_unavailable", "too many requests waiting");
    const id = randomBytes(16).toString("base64url");
    this.pending.set(id, {
      id,
      client_id: client.client_id,
      redirect_uri: redirect,
      state,
      code_challenge: challenge,
      scope: scopeFrom(q.get("scope")) ?? "read",
      resource,
      expires: Date.now() + REQUEST_TTL_MS,
    });
    return new Response(null, {
      status: 302,
      headers: { location: `/ui/#/connect/${id}`, "cache-control": "no-store" },
    });
  }

  private need(id: string): { p: Pending; client: OAuthClient } {
    this.sweep();
    const p = this.pending.get(id);
    const client = p && this.read().clients[p.client_id];
    if (!p || !client)
      throw new HttpError(
        404,
        "this connection request is unknown or expired",
        "start the connection again from the MCP client (requests wait 10 minutes)",
        "not_found",
      );
    return { p, client };
  }

  /** What the consent page shows. */
  request(id: string, pipelines: string[]) {
    const { p, client } = this.need(id);
    const redirect = new URL(p.redirect_uri);
    return {
      id,
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uri: p.redirect_uri,
      redirect_host: redirect.host,
      redirect_local: redirect.protocol === "http:",
      scope: p.scope,
      scopes: [...MCP_SCOPES],
      resource: p.resource,
      expires_at: new Date(p.expires).toISOString(),
      pipelines,
      suggested_name: grantName(client.client_name),
    };
  }

  /** The human approved: a one-time code goes back to the client. Answers where the browser goes next. */
  approve(id: string, body: Record<string, unknown>, origin: string, by = "api"): { redirect: string } {
    const { p } = this.need(id);
    const bad = (message: string, hint: string) => new HttpError(400, message, hint, "bad_request");
    const scope = body.scope ?? p.scope;
    if (typeof scope !== "string" || !(MCP_SCOPES as readonly string[]).includes(scope))
      throw bad(`scope must be one of ${MCP_SCOPES.join(", ")}`, 'send {"scope": "read"}');
    const pipelines = body.pipelines ?? null;
    if (
      pipelines !== null &&
      (!Array.isArray(pipelines) ||
        !pipelines.length ||
        !pipelines.every((x) => typeof x === "string" && PIPELINE.test(x)))
    )
      throw bad("pipelines must be null (all) or a non-empty list of pipeline names", 'send {"pipelines": null}');
    const name = body.name;
    if (typeof name !== "string" || !GRANT_NAME.test(name))
      throw bad(
        "name must be letters, digits, '.', '_' or '-' (up to 64)",
        "it is the name the agent's actions are recorded under, e.g. claude-code",
      );
    this.pending.delete(id);
    const code = token();
    this.codes.set(code, {
      client_id: p.client_id,
      redirect_uri: p.redirect_uri,
      code_challenge: p.code_challenge,
      resource: p.resource,
      scope: scope as McpScope,
      pipelines: pipelines === null ? null : [...new Set(pipelines as string[])],
      name,
      approved_by: by,
      expires: Date.now() + CODE_TTL_MS,
    });
    const to = new URL(p.redirect_uri);
    to.searchParams.set("code", code);
    if (p.state !== null) to.searchParams.set("state", p.state);
    to.searchParams.set("iss", origin);
    return { redirect: to.href };
  }

  deny(id: string, origin: string): { redirect: string } {
    const { p } = this.need(id);
    this.pending.delete(id);
    const to = new URL(p.redirect_uri);
    to.searchParams.set("error", "access_denied");
    to.searchParams.set("error_description", "the request was denied on the Pipo dashboard");
    if (p.state !== null) to.searchParams.set("state", p.state);
    to.searchParams.set("iss", origin);
    return { redirect: to.href };
  }

  // ── tokens ─────────────────────────────────────────────────────────────────

  /** `POST /oauth/token`, form-encoded: `authorization_code` (with PKCE) or `refresh_token` (rotated). */
  token(form: URLSearchParams): Record<string, unknown> {
    this.sweep();
    const type = form.get("grant_type");
    if (type === "authorization_code") return this.exchange(form);
    if (type === "refresh_token") return this.refresh(form);
    throw new OAuthError(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  }

  private exchange(form: URLSearchParams) {
    const raw = form.get("code") ?? "";
    const code = this.codes.get(raw);
    const store = this.read();
    if (!code) {
      const used = this.used.get(raw);
      if (used) {
        // A code used twice was intercepted: what it gave is revoked.
        store.grants = store.grants.filter((g) => g.id !== used.grant);
        this.write(store);
      }
      throw new OAuthError(400, "invalid_grant", "the code is unknown, expired or already used");
    }
    if (form.get("client_id") !== code.client_id)
      throw new OAuthError(400, "invalid_grant", "the code was issued to another client");
    const redirect = form.get("redirect_uri");
    if (redirect !== null && redirect !== code.redirect_uri)
      throw new OAuthError(400, "invalid_grant", "redirect_uri does not match the authorization request");
    const resource = form.get("resource");
    if (resource !== null && resource !== code.resource)
      throw new OAuthError(400, "invalid_target", "resource does not match the authorization request");
    const verifier = form.get("code_verifier") ?? "";
    if (!VERIFIER.test(verifier))
      throw new OAuthError(400, "invalid_grant", "code_verifier is missing or malformed (PKCE)");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (!safeEqual(challenge, code.code_challenge))
      throw new OAuthError(400, "invalid_grant", "code_verifier does not match the code_challenge (PKCE)");
    this.codes.delete(raw);
    const client = store.clients[code.client_id];
    const access = token();
    const refresh = token();
    const now = Date.now();
    const grant: Grant = {
      id: `g_${randomBytes(9).toString("base64url")}`,
      client_id: code.client_id,
      client_name: client?.client_name ?? "MCP client",
      name: code.name,
      approved_by: code.approved_by,
      scope: code.scope,
      pipelines: code.pipelines,
      resource: code.resource,
      created_at: nowIso(),
      last_used_at: null,
      refresh_digest: sha256(refresh),
      previous_refresh_digest: null,
      refresh_expires_at: new Date(now + REFRESH_TTL_MS).toISOString(),
      access: [{ digest: sha256(access), expires_at: new Date(now + ACCESS_TTL_MS).toISOString() }],
    };
    store.grants.push(grant);
    this.write(store);
    this.used.set(raw, { grant: grant.id, expires: now + REQUEST_TTL_MS });
    return tokenAnswer(access, refresh, grant.scope);
  }

  private refresh(form: URLSearchParams) {
    const digest = sha256(form.get("refresh_token") ?? "");
    const store = this.read();
    const now = Date.now();
    const stolen = store.grants.find((g) => g.previous_refresh_digest && safeEqual(g.previous_refresh_digest, digest));
    if (stolen) {
      // A rotated-away refresh token came back: someone else has a copy. The grant ends for both.
      store.grants = store.grants.filter((g) => g !== stolen);
      this.write(store);
      throw new OAuthError(400, "invalid_grant", "the refresh token was already used; connect again");
    }
    const grant = store.grants.find((g) => safeEqual(g.refresh_digest, digest));
    if (!grant || Date.parse(grant.refresh_expires_at) <= now)
      throw new OAuthError(400, "invalid_grant", "the refresh token is unknown, revoked or expired; connect again");
    const client = form.get("client_id");
    if (client !== null && client !== grant.client_id)
      throw new OAuthError(400, "invalid_grant", "the refresh token was issued to another client");
    const resource = form.get("resource");
    if (resource !== null && resource !== grant.resource)
      throw new OAuthError(400, "invalid_target", "resource does not match the grant");
    const access = token();
    const refresh = token();
    grant.previous_refresh_digest = grant.refresh_digest;
    grant.refresh_digest = sha256(refresh);
    grant.refresh_expires_at = new Date(now + REFRESH_TTL_MS).toISOString();
    grant.access = [
      ...grant.access.filter((a) => Date.parse(a.expires_at) > now).slice(-(MAX_LIVE_ACCESS - 1)),
      { digest: sha256(access), expires_at: new Date(now + ACCESS_TTL_MS).toISOString() },
    ];
    this.write(store);
    return tokenAnswer(access, refresh, grant.scope);
  }

  /** The grant a bearer token belongs to, while it is live. Every live token is compared, in constant time. */
  authenticate(bearer: string): GrantIdentity | null {
    const digest = sha256(bearer);
    const now = Date.now();
    const store = this.read();
    let found: Grant | undefined;
    for (const g of store.grants)
      for (const a of g.access) if (safeEqual(a.digest, digest) && Date.parse(a.expires_at) > now && !found) found = g;
    if (!found) return null;
    // Recorded at most once a minute, so a busy agent doesn't rewrite the file on every call.
    if (!found.last_used_at || now - Date.parse(found.last_used_at) > 60_000) {
      found.last_used_at = new Date(now).toISOString();
      this.write(store);
    }
    return { grant_id: found.id, name: found.name, scope: found.scope, pipelines: found.pipelines };
  }

  // ── grants ─────────────────────────────────────────────────────────────────

  grants() {
    return this.read().grants.map((g) => ({
      id: g.id,
      name: g.name,
      client_id: g.client_id,
      client_name: g.client_name,
      scope: g.scope,
      pipelines: g.pipelines,
      approved_by: g.approved_by ?? null,
      created_at: g.created_at,
      last_used_at: g.last_used_at,
      expires_at: g.refresh_expires_at,
    }));
  }

  revoke(id: string): boolean {
    const store = this.read();
    const before = store.grants.length;
    store.grants = store.grants.filter((g) => g.id !== id);
    if (store.grants.length === before) return false;
    this.write(store);
    return true;
  }
}

/** An OAuth protocol error, answered as `{error, error_description}` (RFC 6749 §5.2). */
export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    description: string,
  ) {
    super(description);
  }
}

function tokenAnswer(access: string, refresh: string, scope: McpScope) {
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: refresh,
    scope,
  };
}

/** A grant name from a client's self-declared name: `Claude Code` → `claude-code`. */
export function grantName(clientName: string): string {
  const slug = clientName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "")
    .slice(0, 64);
  return slug || "mcp-client";
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** A plain error page for a request that can't be sent back to its client. */
function errorPage(title: string, message: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)} · Pipo</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1>🔑 ${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>`;
  return new Response(html, {
    status: 400,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
