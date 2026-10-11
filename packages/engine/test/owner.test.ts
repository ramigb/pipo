// The owner's login (docs/spec.md §11, D84, D85) against in-process engines: 401s before and after setup, the setup
// code (only the engine key reads it), the session cookie and its attributes, the engine key, login failures and the
// rate limit, password changes, log out (here and everywhere), an epoch bumped on disk (pipo owner reset), sessions
// that survive an engine restart, the consent page needing the owner, Origin and Host checks with engine.public_url,
// open mode, the exposure rules, and the remote `/in` rule end to end through a runner.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { readEngineKey, readOwner, setOwnerPassword } from "@pipo/runner";
import { EngineError, Supervisor } from "../src";
import { checkExposure, DEFAULT_CONFIG, type EngineConfig } from "../src/config";
import { fromNetwork } from "../src/gateway";
import { isAlive, sandbox, testConfig, waitFor } from "./helpers";

const box = sandbox();
const engines: Supervisor[] = [];
afterAll(async () => {
  const pids: number[] = [];
  for (const e of engines) {
    for (const r of e.list()) if (r.pid) pids.push(r.pid);
    await Promise.race([e.shutdown({ now: true }), Bun.sleep(10_000)]);
  }
  for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  box.cleanup();
});

const PASSWORD = "correct horse battery";

async function open(home: string, config: Partial<EngineConfig> = {}) {
  const engine = await Supervisor.open({
    home,
    config: { ...testConfig(), auth: "owner", listen: 0, ...config },
    log: () => {},
  });
  engines.push(engine);
  return { engine, base: engine.gateway?.url as string };
}

type Answer = { status: number; body: any; headers: Headers };
const answer = async (res: Response): Promise<Answer> => ({
  status: res.status,
  body: await res.json().catch(() => null),
  headers: res.headers,
});

function client(base: string) {
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }).then(answer);
  return {
    get: (path: string, headers: Record<string, string> = {}) => call("GET", path, undefined, headers),
    post: (path: string, body: unknown = {}, headers: Record<string, string> = {}) => call("POST", path, body, headers),
  };
}

const cookieOf = (a: Answer) => (a.headers.get("set-cookie") ?? "").split(";")[0] as string;
const withCookie = (cookie: string) => ({ cookie });
const key = (home: string) => ({ authorization: `Bearer ${readEngineKey(home)}` });

describe("owner login", () => {
  const home = join(box.root, "owner-home");
  let base = "";
  let api: ReturnType<typeof client>;
  let session = "";

  test("before setup: 401 owner_setup_required; only the engine key reads the setup code", async () => {
    ({ base } = await open(home));
    api = client(base);
    const r = await api.get("/api/pipelines");
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("owner_setup_required");
    expect(r.body.hint).toContain("setup code");
    const events = await fetch(`${base}/events`);
    expect(events.status).toBe(401);

    const state = await api.get("/api/auth");
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ mode: "owner", owner: false, user: null, mail: false });
    expect(state.body.setup_code).toBeUndefined();
    expect(state.headers.get("cache-control")).toBe("no-store");

    expect(statSync(join(home, "engine.key")).mode & 0o777).toBe(0o600);
    const withKey = await api.get("/api/auth", key(home));
    expect(withKey.body.setup_code).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
    expect(withKey.body.via).toBe("key");
    expect((await api.get("/api/pipelines", key(home))).status).toBe(200);
    expect((await api.get("/api/pipelines", { authorization: "Bearer not-the-key" })).status).toBe(401);
  });

  test("setup needs the code; then it creates the owner and a session cookie", async () => {
    const code = (await api.get("/api/auth", key(home))).body.setup_code as string;
    const wrong = await api.post("/api/auth/setup", {
      code: "AAAA-AAAA-AAAA-AAAA",
      username: "ada",
      password: PASSWORD,
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body.hint).toContain("engine log");
    const short = await api.post("/api/auth/setup", { code, username: "ada", password: "short" });
    expect(short.status).toBe(400);
    expect(short.body.error).toContain("10 characters");
    const badName = await api.post("/api/auth/setup", { code, username: "-ada", password: PASSWORD });
    expect(badName.status).toBe(400);
    const extra = await api.post("/api/auth/setup", { code, username: "ada", password: PASSWORD, role: "admin" });
    expect(extra.status).toBe(400);

    // Lowercase and without dashes is the same code.
    const ok = await api.post("/api/auth/setup", {
      code: code.toLowerCase().replaceAll("-", ""),
      username: "ada",
      password: PASSWORD,
      email: "ada@example.com",
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ user: "ada" });
    const cookie = ok.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^pipo_session=[A-Za-z0-9_-]{43}; /);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Secure");
    session = cookieOf(ok);

    const owner = readOwner(home);
    expect(owner).toMatchObject({ username: "ada", email: "ada@example.com", epoch: 1 });
    expect(owner?.password_hash).toStartWith("$argon2id$");
    expect(statSync(join(home, "owner.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "sessions.json")).mode & 0o777).toBe(0o600);

    const again = await api.post("/api/auth/setup", { code, username: "eve", password: PASSWORD });
    expect(again.status).toBe(409);
    expect((await api.get("/api/auth", key(home))).body.setup_code).toBeUndefined();
  });

  test("the session admits /api and /events; without it, 401 login_required", async () => {
    expect((await api.get("/api/pipelines", withCookie(session))).status).toBe(200);
    const state = await api.get("/api/auth", withCookie(session));
    expect(state.body).toMatchObject({
      mode: "owner",
      owner: true,
      user: "ada",
      via: "session",
      email: "ada@example.com",
    });
    const ctrl = new AbortController();
    const events = await fetch(`${base}/events`, { headers: withCookie(session), signal: ctrl.signal });
    expect(events.status).toBe(200);
    ctrl.abort();
    const none = await api.get("/api/engine");
    expect(none.status).toBe(401);
    expect(none.body.code).toBe("login_required");
    expect((await api.get("/api/engine", withCookie("pipo_session=forged"))).status).toBe(401);
  });

  test("login: a wrong username or password is one answer; the right one gets a cookie", async () => {
    const wrongPw = await api.post("/api/auth/login", { username: "ada", password: "nope nope nope" });
    const wrongUser = await api.post("/api/auth/login", { username: "eve", password: PASSWORD });
    expect([wrongPw.status, wrongUser.status]).toEqual([401, 401]);
    expect(wrongPw.body.error).toBe(wrongUser.body.error);
    expect(wrongPw.body.code).toBe("login_failed");
    expect(wrongPw.body.hint).toContain("pipo owner reset");
    const ok = await api.post("/api/auth/login", { username: "ADA", password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ user: "ada" });
    expect((await api.get("/api/pipelines", withCookie(cookieOf(ok)))).status).toBe(200);
  });

  test("the consent page needs the owner, and the grant records who approved it", async () => {
    const redirect = "http://127.0.0.1:33418/callback";
    const reg = await api.post("/oauth/register", { client_name: "Agent", redirect_uris: [redirect] });
    expect(reg.status).toBe(201);
    const verifier = randomBytes(32).toString("base64url");
    const res = await fetch(
      `${base}/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: reg.body.client_id,
        redirect_uri: redirect,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      })}`,
      { redirect: "manual" },
    );
    const id = /#\/connect\/(.+)$/.exec(res.headers.get("location") ?? "")?.[1] as string;
    const body = { scope: "read", pipelines: null, name: "agent" };
    const anon = await api.post(`/api/oauth/requests/${id}/approve`, body);
    expect(anon.status).toBe(401);
    const ok = await api.post(`/api/oauth/requests/${id}/approve`, body, withCookie(session));
    expect(ok.status).toBe(200);
    const code = new URL(ok.body.redirect).searchParams.get("code") as string;
    const token = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: reg.body.client_id,
        redirect_uri: redirect,
        code_verifier: verifier,
      }).toString(),
    });
    expect(token.status).toBe(200);
    const grants = await api.get("/api/mcp/grants", withCookie(session));
    expect(grants.body.grants[0].approved_by).toBe("ada");
  });

  test("pages from other sites and other host names are refused", async () => {
    const evil = await api.post(
      "/api/auth/login",
      { username: "ada", password: PASSWORD },
      { origin: "http://evil.example" },
    );
    expect(evil.status).toBe(403);
    expect(evil.body.error).toContain("evil.example");
    const otherPort = await api.get("/api/pipelines", { ...withCookie(session), origin: "http://127.0.0.1:1" });
    expect(otherPort.status).toBe(403);
    const own = await api.post("/api/auth/login", { username: "ada", password: PASSWORD }, { origin: base });
    expect(own.status).toBe(200);
    const host = await api.get("/api/auth", { host: "pipo.example.com" });
    expect(host.status).toBe(403);
    expect(host.body.hint).toContain("engine.public_url");
  });

  test("changing the password ends every other session, and the caller gets a new one", async () => {
    const other = cookieOf(await api.post("/api/auth/login", { username: "ada", password: PASSWORD }));
    const wrong = await api.post(
      "/api/auth/password",
      { current: "wrong wrong wrong", password: "a brand new password" },
      withCookie(session),
    );
    expect(wrong.status).toBe(403);
    const anon = await api.post("/api/auth/password", { current: PASSWORD, password: "a brand new password" });
    expect(anon.status).toBe(401);
    const ok = await api.post(
      "/api/auth/password",
      { current: PASSWORD, password: "a brand new password" },
      withCookie(session),
    );
    expect(ok.status).toBe(200);
    expect((await api.get("/api/pipelines", withCookie(other))).status).toBe(401);
    expect((await api.get("/api/pipelines", withCookie(session))).status).toBe(401);
    session = cookieOf(ok);
    expect((await api.get("/api/pipelines", withCookie(session))).status).toBe(200);
    expect(readOwner(home)?.epoch).toBe(2);
  });

  test("the email can be set and cleared; a test email needs engine.mail", async () => {
    const bad = await api.post("/api/auth/email", { email: "not-an-email" }, withCookie(session));
    expect(bad.status).toBe(400);
    expect((await api.post("/api/auth/email", { email: null }, withCookie(session))).body).toEqual({ email: null });
    expect(readOwner(home)?.email).toBeNull();
    expect((await api.post("/api/auth/email", { email: "ada@example.org" }, withCookie(session))).status).toBe(200);
    const mail = await api.post("/api/auth/test-mail", {}, withCookie(session));
    expect(mail.status).toBe(409);
    expect(mail.body.hint).toContain("engine.mail");
    const forgot = await api.post("/api/auth/forgot", { login: "ada" });
    expect(forgot.status).toBe(202);
  });

  test("log out ends this session; log out everywhere ends them all", async () => {
    const a = cookieOf(await api.post("/api/auth/login", { username: "ada", password: "a brand new password" }));
    const b = cookieOf(await api.post("/api/auth/login", { username: "ada", password: "a brand new password" }));
    const out = await api.post("/api/auth/logout", {}, withCookie(a));
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await api.get("/api/pipelines", withCookie(a))).status).toBe(401);
    expect((await api.get("/api/pipelines", withCookie(b))).status).toBe(200);
    expect((await api.post("/api/auth/logout-all", {}, withCookie(b))).status).toBe(200);
    expect((await api.get("/api/pipelines", withCookie(b))).status).toBe(401);
    expect((await api.get("/api/pipelines", withCookie(session))).status).toBe(401);
    expect((await api.get("/api/pipelines", key(home))).status).toBe(200);
    session = cookieOf(await api.post("/api/auth/login", { username: "ada", password: "a brand new password" }));
  });

  test("sessions survive an engine restart; a reset on disk (pipo owner reset) ends them", async () => {
    for (const e of engines.splice(0)) await e.shutdown({ now: true });
    ({ base } = await open(home));
    api = client(base);
    expect((await api.get("/api/pipelines", withCookie(session))).status).toBe(200);
    await setOwnerPassword(home, { password: "reset from the cli" });
    await waitFor(async () => (await api.get("/api/pipelines", withCookie(session))).status === 401, 5000, "reset");
    const ok = await api.post("/api/auth/login", { username: "ada", password: "reset from the cli" });
    expect(ok.status).toBe(200);
  });

  test("failed attempts are rate-limited (429 with Retry-After)", async () => {
    for (let i = 0; i < 5; i++)
      expect((await api.post("/api/auth/login", { username: "ada", password: "wrong password" })).status).toBe(401);
    const limited = await api.post("/api/auth/login", { username: "ada", password: "reset from the cli" });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("open mode, public_url and exposure", () => {
  test("open mode needs no login and has no login routes", async () => {
    const home = join(box.root, "open-home");
    const { base } = await open(home, { auth: "open" });
    const api = client(base);
    expect((await api.get("/api/pipelines")).status).toBe(200);
    expect((await api.get("/api/auth")).body).toMatchObject({ mode: "open", owner: false, user: null });
    const login = await api.post("/api/auth/login", { username: "ada", password: PASSWORD });
    expect(login.status).toBe(409);
    expect(login.body.hint).toContain("engine.auth: owner");
  });

  test("with public_url, its host is answered, links name it, and cookies are Secure", async () => {
    const home = join(box.root, "public-home");
    const { base } = await open(home, { public_url: "https://pipo.example.com" });
    const api = client(base);
    const host = { host: "pipo.example.com" };
    const r = await api.get("/api/pipelines", host);
    expect(r.status).toBe(401);
    expect((await api.get("/api/pipelines", { host: "other.example.com" })).status).toBe(403);
    const meta = await api.get("/.well-known/oauth-protected-resource", host);
    expect(meta.body.resource).toBe("https://pipo.example.com/mcp");
    const code = (await api.get("/api/auth", key(home))).body.setup_code;
    const ok = await api.post(
      "/api/auth/setup",
      { code, username: "ada", password: PASSWORD },
      { ...host, origin: "https://pipo.example.com" },
    );
    expect(ok.status).toBe(201);
    expect(ok.headers.get("set-cookie")).toContain("; Secure");
  });

  test("an engine on every interface needs the owner's login and public_url", async () => {
    const config = (over: Partial<EngineConfig>) => ({ ...structuredClone(DEFAULT_CONFIG), ...over });
    expect(() => checkExposure(config({ host: "127.0.0.1", auth: "open" }))).not.toThrow();
    expect(() => checkExposure(config({ host: "0.0.0.0", auth: "open", public_url: "https://a.example" }))).toThrow(
      /engine.auth: open/,
    );
    expect(() => checkExposure(config({ host: "::" }))).toThrow(/public_url/);
    expect(() => checkExposure(config({ host: "0.0.0.0", public_url: "https://a.example" }))).not.toThrow();
    const home = join(box.root, "exposed-home");
    const err = await Supervisor.open({ home, config: { ...testConfig(), host: "0.0.0.0", listen: 0 }, log: () => {} })
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.code).toBe("config");
  });

  test("fromNetwork: only loopback callers on loopback names, without a proxy in between, are local", () => {
    const req = (host: string, headers: Record<string, string> = {}) =>
      new Request("http://x/in/p", { headers: { host, ...headers } });
    expect(fromNetwork(req("127.0.0.1:4747"), "127.0.0.1")).toBe(false);
    expect(fromNetwork(req("localhost:4747"), "::1")).toBe(false);
    expect(fromNetwork(req("[::1]:4747"), "::ffff:127.0.0.1")).toBe(false);
    expect(fromNetwork(req("127.0.0.1:4747"), "192.168.1.5")).toBe(true);
    expect(fromNetwork(req("pipo.example.com"), "127.0.0.1")).toBe(true);
    expect(fromNetwork(req("127.0.0.1:4747", { "x-forwarded-for": "1.2.3.4" }), "127.0.0.1")).toBe(true);
    expect(fromNetwork(req("127.0.0.1:4747", { forwarded: "for=1.2.3.4" }), "127.0.0.1")).toBe(true);
    expect(fromNetwork(req("127.0.0.1:4747"), undefined)).toBe(true);
  });

  test("/in: a request from the network reaches an input without auth only with public: true", async () => {
    const home = join(box.root, "in-home");
    const file = (name: string, extra: string) =>
      box.write(
        `${name}.pipo`,
        `pipo: 1\nname: ${name}\ninput: { via: http, with: { path: /hook${extra} } }\noutput: { from: input, to: file, with: { path: ./${name}.jsonl } }\n`,
      );
    const { engine, base } = await open(home, { auth: "open" });
    await engine.start(file("closed-hook", ""));
    await engine.start(file("open-hook", ", public: true"));
    const send = (name: string, headers: Record<string, string> = {}) =>
      fetch(`${base}/in/${name}/hook`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      }).then(answer);
    // A forged header from a local caller is dropped: the gateway alone decides.
    expect((await send("closed-hook", { "x-pipo-remote": "1" })).status).toBe(202);
    const proxied = await send("closed-hook", { "x-forwarded-for": "203.0.113.9" });
    expect(proxied.status).toBe(403);
    expect(proxied.body.hint).toContain("public: true");
    expect((await send("open-hook", { "x-forwarded-for": "203.0.113.9" })).status).toBe(202);
  });
});
