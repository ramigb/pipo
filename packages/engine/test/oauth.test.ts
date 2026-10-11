// OAuth for the MCP endpoint (docs/spec.md §9.2, D82) against an in-process engine: the 401 challenge, the protected
// resource and server metadata, client registration, authorize → consent page → code → token with PKCE, a code used
// twice, refresh rotation (and a rotated-away refresh token used again), grants that survive an engine restart, a
// denied request, revocation, and the wrong resource or redirect.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../cli/src/cli";
import { Supervisor } from "../src";
import { grantName, redirectProblem, scopeFrom } from "../src/oauth";
import { sandbox, testConfig } from "./helpers";

const box = sandbox();
const home = join(box.root, "home");
const engines: Supervisor[] = [];
afterAll(async () => {
  for (const e of engines) await Promise.race([e.shutdown({ now: true }), Bun.sleep(10_000)]);
  box.cleanup();
});

let base = "";
const REDIRECT = "http://127.0.0.1:33418/callback";

async function open(port = 0): Promise<Supervisor> {
  const engine = await Supervisor.open({ home, config: { ...testConfig(), listen: port }, log: () => {} });
  engines.push(engine);
  base = engine.gateway?.url as string;
  return engine;
}

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any, headers: res.headers });
const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(json);
const form = (path: string, fields: Record<string, string>) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  }).then(json);
const authorize = (params: Record<string, string>) =>
  fetch(`${base}/oauth/authorize?${new URLSearchParams(params)}`, { redirect: "manual" });

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function register(name = "Test Agent") {
  const r = await post("/oauth/register", {
    client_name: name,
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
  });
  expect(r.status).toBe(201);
  return r.body.client_id as string;
}

/** Register, authorize, approve on the "consent page" and trade the code. */
async function connect(opts: { scope?: string; grant?: string; name?: string; pipelines?: string[] | null } = {}) {
  const client = await register();
  const { verifier, challenge } = pkce();
  const res = await authorize({
    response_type: "code",
    client_id: client,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    scope: opts.scope ?? "read",
    resource: `${base}/mcp`,
  });
  expect(res.status).toBe(302);
  const id = /^\/ui\/#\/connect\/(.+)$/.exec(res.headers.get("location") ?? "")?.[1] as string;
  expect(id).toBeTruthy();
  const approved = await post(`/api/oauth/requests/${id}/approve`, {
    scope: opts.grant ?? opts.scope ?? "read",
    pipelines: opts.pipelines ?? null,
    name: opts.name ?? "test-agent",
  });
  expect(approved.status).toBe(200);
  const back = new URL(approved.body.redirect);
  expect(back.searchParams.get("state")).toBe("st-1");
  const code = back.searchParams.get("code") as string;
  const tokens = await form("/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: client,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
    resource: `${base}/mcp`,
  });
  expect(tokens.status).toBe(200);
  return { client, code, verifier, ...(tokens.body as { access_token: string; refresh_token: string; scope: string }) };
}

const mcp = (token: string | null, method = "initialize") =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });

describe("OAuth for /mcp", () => {
  test("helpers: redirect URIs, scopes and grant names", () => {
    expect(redirectProblem("http://localhost:1234/cb")).toBeNull();
    expect(redirectProblem("http://[::1]/cb")).toBeNull();
    expect(redirectProblem("https://example.com/cb")).toBeNull();
    expect(redirectProblem("http://example.com/cb")).toContain("localhost");
    expect(redirectProblem("https://example.com/cb#x")).toContain("fragment");
    expect(redirectProblem("myapp://cb")).not.toBeNull();
    expect(scopeFrom("read operate edit author")).toBe("author");
    expect(scopeFrom("openid profile")).toBeNull();
    expect(scopeFrom(null)).toBeNull();
    expect(grantName("Claude Code")).toBe("claude-code");
    expect(grantName("!!!")).toBe("mcp-client");
  });

  test("a request without a token gets 401 pointing at the resource metadata, which points at the server", async () => {
    await open();
    const res = await mcp(null);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    );
    const body = (await res.json()) as any;
    expect(body.hint).toContain("OAuth");
    const bad = await mcp("not-a-token");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');

    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const r = await fetch(`${base}${path}`).then(json);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ["read", "operate", "edit", "author"],
      });
    }
    const as = await fetch(`${base}/.well-known/oauth-authorization-server`).then(json);
    expect(as.body).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    // A non-loopback Host is refused here too.
    const evil = await fetch(`${base}/.well-known/oauth-authorization-server`, { headers: { host: "evil.example" } });
    expect(evil.status).toBe(403);
  });

  test("registration takes public clients with loopback or https redirects only", async () => {
    const bad = await post("/oauth/register", { redirect_uris: ["http://evil.example/cb"] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_redirect_uri");
    expect((await post("/oauth/register", {})).body.error).toBe("invalid_redirect_uri");
    const ok = await post("/oauth/register", { client_name: "X\u0007Y", redirect_uris: [REDIRECT] });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ client_name: "XY", token_endpoint_auth_method: "none", redirect_uris: [REDIRECT] });
    const text = await fetch(`${base}/oauth/register`, { method: "POST", body: "x" });
    expect(text.status).toBe(415);
  });

  test("authorize checks the client, redirect, PKCE and resource before the consent page", async () => {
    const client = await register();
    const { challenge } = pkce();
    const good = {
      response_type: "code",
      client_id: client,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s",
      resource: `${base}/mcp`,
    };
    const unknown = await authorize({ ...good, client_id: "c_nope" });
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get("content-type")).toContain("text/html");
    const wrongRedirect = await authorize({ ...good, redirect_uri: "http://127.0.0.1:1/other" });
    expect(wrongRedirect.status).toBe(400);
    expect(wrongRedirect.headers.get("location")).toBeNull();

    const back = async (params: Record<string, string>) => {
      const res = await authorize(params);
      expect(res.status).toBe(302);
      return new URL(res.headers.get("location") as string);
    };
    const { code_challenge: _c, ...noPkce } = good;
    expect((await back(noPkce)).searchParams.get("error")).toBe("invalid_request");
    expect((await back({ ...good, code_challenge_method: "plain" })).searchParams.get("error")).toBe("invalid_request");
    expect((await back({ ...good, response_type: "token" })).searchParams.get("error")).toBe(
      "unsupported_response_type",
    );
    const target = await back({ ...good, resource: "http://127.0.0.1:1/mcp" });
    expect(target.searchParams.get("error")).toBe("invalid_target");
    expect(target.searchParams.get("state")).toBe("s");

    const res = await authorize({ ...good, scope: "read operate edit author" });
    const id = /connect\/(.+)$/.exec(res.headers.get("location") ?? "")?.[1] as string;
    const shown = await fetch(`${base}/api/oauth/requests/${id}`).then(json);
    expect(shown.body).toMatchObject({
      client_name: "Test Agent",
      redirect_host: "127.0.0.1:33418",
      redirect_local: true,
      scope: "author",
      suggested_name: "test-agent",
    });
    expect((await fetch(`${base}/api/oauth/requests/nope`)).status).toBe(404);

    const denied = await post(`/api/oauth/requests/${id}/deny`, {});
    const to = new URL(denied.body.redirect);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("s");
    expect((await fetch(`${base}/api/oauth/requests/${id}`)).status).toBe(404);
  });

  test("code → token with PKCE; the token works on /mcp with the scope the human chose", async () => {
    const client = await register();
    const { verifier, challenge } = pkce();
    const res = await authorize({
      response_type: "code",
      client_id: client,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "read",
    });
    const id = /connect\/(.+)$/.exec(res.headers.get("location") ?? "")?.[1] as string;
    expect((await post(`/api/oauth/requests/${id}/approve`, { scope: "root", name: "x" })).status).toBe(400);
    expect((await post(`/api/oauth/requests/${id}/approve`, { scope: "edit", name: "bad name" })).status).toBe(400);
    const approved = await post(`/api/oauth/requests/${id}/approve`, { scope: "edit", name: "my-agent" });
    const code = new URL(approved.body.redirect).searchParams.get("code") as string;
    const trade = (fields: Record<string, string>) =>
      form("/oauth/token", { grant_type: "authorization_code", code, client_id: client, ...fields });
    expect((await trade({})).body.error).toBe("invalid_grant");
    expect((await trade({ code_verifier: randomBytes(32).toString("base64url") })).body.error).toBe("invalid_grant");
    expect((await trade({ code_verifier: verifier, redirect_uri: "http://127.0.0.1:1/x" })).body.error).toBe(
      "invalid_grant",
    );
    const ok = await trade({ code_verifier: verifier, redirect_uri: REDIRECT });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "edit" });

    const init = await mcp(ok.body.access_token);
    expect(init.status).toBe(200);
    const body = (await init.json()) as any;
    expect(body.result.instructions).toContain("'my-agent' with scope edit");

    // The code is single-use; a second use revokes the grant it gave.
    const again = await trade({ code_verifier: verifier });
    expect(again.body.error).toBe("invalid_grant");
    expect((await mcp(ok.body.access_token)).status).toBe(401);
    expect(statSync(join(home, "mcp-grants.json")).mode & 0o777).toBe(0o600);
  });

  test("refresh rotates; a rotated-away refresh token used again ends the grant", async () => {
    const first = await connect({ scope: "operate" });
    const refreshed = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: first.client,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(first.refresh_token);
    expect((await mcp(refreshed.body.access_token)).status).toBe(200);
    expect((await mcp(first.access_token)).status).toBe(200); // still live until it expires

    const replay = await form("/oauth/token", { grant_type: "refresh_token", refresh_token: first.refresh_token });
    expect(replay.body.error).toBe("invalid_grant");
    expect((await mcp(refreshed.body.access_token)).status).toBe(401);
    const unknown = await form("/oauth/token", { grant_type: "password" });
    expect(unknown.body.error).toBe("unsupported_grant_type");
  });

  test("grants are listed and revoked over REST; they survive an engine restart", async () => {
    const kept = await connect({ scope: "read", name: "kept" });
    const gone = await connect({ scope: "author", name: "gone", pipelines: ["people-intake"] });
    const list = await fetch(`${base}/api/mcp/grants`).then(json);
    const byName = Object.fromEntries(list.body.grants.map((g: any) => [g.name, g]));
    expect(byName.gone).toMatchObject({ scope: "author", pipelines: ["people-intake"], client_name: "Test Agent" });
    expect(list.body.tokens).toEqual([]);
    expect(JSON.stringify(list.body)).not.toContain(gone.access_token);

    const revoked = await post(`/api/mcp/grants/${byName.gone.id}/revoke`, {});
    expect(revoked.body).toEqual({ revoked: byName.gone.id });
    expect((await mcp(gone.access_token)).status).toBe(401);
    expect((await post("/api/mcp/grants/g_nope/revoke", {})).status).toBe(404);

    const engine = engines.pop() as Supervisor;
    const port = Number(new URL(base).port);
    await engine.shutdown({ now: true });
    await open(port);
    expect((await mcp(kept.access_token)).status).toBe(200);
  });

  test("pipo mcp grants lists the grants and revokes one", async () => {
    const agent = await connect({ scope: "edit", name: "cli-listed" });
    const pipo = async (...args: string[]) => {
      const out: string[] = [];
      const { log } = console;
      console.log = (...a: unknown[]) => void out.push(a.join(" "));
      try {
        return { code: await main([...args, "--home", home]), stdout: out.join("\n") };
      } finally {
        console.log = log;
      }
    };
    const listed = await pipo("mcp", "grants");
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(/cli-listed\s+edit\s+all\s+OAuth: Test Agent/);
    const id = JSON.parse((await pipo("mcp", "grants", "--json")).stdout).grants.find(
      (g: any) => g.name === "cli-listed",
    ).id;
    const revoked = await pipo("mcp", "grants", "revoke", id);
    expect(revoked.code).toBe(0);
    expect((await mcp(agent.access_token)).status).toBe(401);
  });
});
