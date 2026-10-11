// The owner's login (docs/spec.md §11, D84, D86): who may use `/api`, `/events` and the dashboard.
// - `engine.auth: owner` (the default): a request needs the owner's session cookie, or the engine key
//   (`Authorization: Bearer <home>/engine.key`, which the CLI on this machine sends). `open`: anyone who reaches it.
// - First run: no owner yet, so the engine logs a one-time setup code; the dashboard's setup page takes it with the
//   username and password. `pipo owner reset` works too, with or without an engine.
// - Sessions: random tokens, stored as SHA-256 digests in `<home>/sessions.json` (0600), 14 days sliding. A session
//   from an older owner epoch (a password change, a reset, "log out everywhere") is dead.
// - Reset by email (D86, when engine.mail is set): a link to `<public_url>/ui/#/reset/<token>`, 30 minutes, single use.
// - Failures (logins, setup codes, reset tokens) are rate-limited per client address and in total.
import { readFileSync } from "node:fs";
import {
  emailProblem,
  ensureEngineKey,
  type Owner,
  ownerStamp,
  passwordProblem,
  readEngineKey,
  readOwner,
  Secrets,
  sessionsPath,
  setOwnerPassword,
  usernameProblem,
  verifyPassword,
  writeOwner,
} from "@pipo/runner";
import type { EngineConfig } from "./config";
import { randomToken, safeEqual, sha256, writePrivateJson } from "./files";
import { HttpError, optional, readBody, unknownKeys } from "./http-error";
import { MailError, sendMail } from "./smtp";

export const SESSION_COOKIE = "pipo_session";
export const SESSION_TTL_MS = 14 * 24 * 60 * 60_000;
export const RESET_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 50;
const MAX_RESETS = 3;
const TOUCH_EVERY_MS = 60_000;
const RESOLVE_TIMEOUT_MS = 30_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Who a request is: the owner through a session, the CLI through the engine key, or anyone in open mode. */
export interface Caller {
  via: "session" | "key" | "open";
  /** The `by` of what it does when it names none. */
  actor: string;
}

interface Session {
  digest: string;
  epoch: number;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  ip: string | null;
  agent: string | null;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

/** A setup code: 16 characters from an alphabet without look-alikes, in groups of four (80 bits). */
function setupCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return chars.match(/.{4}/g)!.join("-");
}

const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Failed attempts per client address (5 free, then 30 s doubling up to 15 min) and in total (30 a minute). */
export class Limiter {
  private readonly clients = new Map<string, { failures: number; until: number; last: number }>();
  private recent: number[] = [];

  constructor(
    private readonly free = 5,
    private readonly perMinute = 30,
  ) {}

  check(ip: string): void {
    const now = Date.now();
    this.recent = this.recent.filter((t) => t > now - 60_000);
    let wait = 0;
    if (this.recent.length >= this.perMinute) wait = (this.recent[0] as number) + 60_000 - now;
    const c = this.clients.get(ip);
    if (c && c.until > now) wait = Math.max(wait, c.until - now);
    if (wait > 0) {
      const seconds = Math.max(1, Math.ceil(wait / 1000));
      throw new HttpError(
        429,
        "too many failed attempts",
        `wait ${seconds} s and try again; if you forgot the password, run pipo owner reset on the engine's machine`,
        "rate_limited",
        {},
        { "retry-after": String(seconds) },
      );
    }
  }

  fail(ip: string): void {
    const now = Date.now();
    this.recent.push(now);
    const c = this.clients.get(ip) ?? { failures: 0, until: 0, last: now };
    c.failures++;
    c.last = now;
    if (c.failures >= this.free) c.until = now + Math.min(15 * 60_000, 30_000 * 2 ** (c.failures - this.free));
    this.clients.set(ip, c);
    if (this.clients.size > 10_000)
      for (const [k, v] of this.clients) if (v.last < now - 60 * 60_000 && v.until < now) this.clients.delete(k);
  }

  ok(ip: string): void {
    this.clients.delete(ip);
  }
}

export interface OwnerAuthOptions {
  home: string;
  config: EngineConfig;
  /** Where the gateway is reached: public_url, else its loopback URL. Reset links and the setup line use it. */
  base: () => string;
  log: (level: string, message: string) => void;
}

export class OwnerAuth {
  private owner: Owner | null = null;
  private stamp: string | null = null;
  private readonly sessions = new Map<string, Session>();
  private code: string | null = null;
  private readonly resets = new Map<string, number>();
  private readonly limiter = new Limiter();
  /** `forgot` requests, apart from logins: asking for links never locks the owner out of logging in. */
  private readonly mailLimiter = new Limiter(3, 10);
  private keyCache: { key: string | null; at: number } = { key: null, at: 0 };
  private mailPassword: string | null = null;
  private mailUsable = false;
  private dummyHash: Promise<string> | null = null;

  constructor(private readonly opts: OwnerAuthOptions) {
    if (this.mode === "owner") ensureEngineKey(opts.home);
    this.loadSessions();
    this.current();
    void this.resolveMail();
  }

  get mode() {
    return this.opts.config.auth;
  }

  /** Log the setup code while there is no owner (once per code). */
  announce(): void {
    if (this.mode !== "owner" || this.current()) return;
    const fresh = this.code === null;
    const code = this.setupCode();
    if (fresh)
      this.opts.log(
        "info",
        `no owner yet: open ${this.opts.base()}/ui/#/setup and enter the setup code ${code} (or run pipo ui on this machine)`,
      );
  }

  // ── who is asking ──────────────────────────────────────────────────────────

  /** The caller of an `/api` or `/events` request, or a 401 that says how to log in. */
  require(req: Request): Caller {
    if (this.mode === "open") return { via: "open", actor: "api" };
    const caller = this.identify(req);
    if (caller) return caller;
    if (!this.current()) {
      this.announce();
      throw new HttpError(
        401,
        "Pipo has no owner yet",
        "open the dashboard and create the owner with the setup code from the engine log (pipo ui on this machine opens it with the code filled in)",
        "owner_setup_required",
      );
    }
    throw new HttpError(
      401,
      "log in first",
      "log in on the dashboard (/ui); the CLI on the engine's machine uses <home>/engine.key instead",
      "login_required",
    );
  }

  identify(req: Request): Caller | null {
    const owner = this.current();
    const auth = req.headers.get("authorization") ?? "";
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(auth)?.[1];
    if (bearer) {
      const key = this.engineKey();
      if (key && safeEqual(bearer, key)) return { via: "key", actor: "cli" };
      return null;
    }
    const token = cookieOf(req, SESSION_COOKIE);
    if (!token || !owner) return null;
    const session = this.sessions.get(sha256(token));
    if (!session) return null;
    const now = Date.now();
    if (session.epoch !== owner.epoch || Date.parse(session.expires_at) <= now) {
      this.sessions.delete(session.digest);
      this.saveSessions();
      return null;
    }
    if (now - Date.parse(session.last_used_at) > TOUCH_EVERY_MS) {
      session.last_used_at = new Date(now).toISOString();
      session.expires_at = new Date(now + SESSION_TTL_MS).toISOString();
      this.saveSessions();
    }
    return { via: "session", actor: owner.username };
  }

  // ── /api/auth ──────────────────────────────────────────────────────────────

  /** `/api/auth` and `/api/auth/<action>`. `ip` is the client's address (rate limits). */
  async route(req: Request, action: string | undefined, ip: string): Promise<Response> {
    const get = req.method === "GET" || req.method === "HEAD";
    if (action === undefined) {
      if (!get) throw notAllowed("GET");
      return json(200, this.state(req));
    }
    if (req.method !== "POST") throw notAllowed("POST");
    const body = await readBody(req);
    if (this.mode === "open")
      throw new HttpError(
        409,
        "this engine runs with engine.auth: open, so it has no login",
        "set engine.auth: owner in config.yaml (the default) and restart the engine",
        "invalid_state",
      );
    switch (action) {
      case "setup":
        return await this.setup(req, body, ip);
      case "login":
        return await this.login(req, body, ip);
      case "logout": {
        keys(body, []);
        const token = cookieOf(req, SESSION_COOKIE);
        if (token && this.sessions.delete(sha256(token))) this.saveSessions();
        return json(200, { logged_out: true }, { "set-cookie": this.cookie("", 0) });
      }
      case "logout-all": {
        keys(body, []);
        this.signedIn(req);
        const owner = this.current() as Owner;
        writeOwner(this.opts.home, { ...owner, epoch: owner.epoch + 1 });
        this.current();
        return json(200, { logged_out: true }, { "set-cookie": this.cookie("", 0) });
      }
      case "password":
        return await this.changePassword(req, body, ip);
      case "email": {
        keys(body, ["email"]);
        this.signedIn(req);
        const email = body.email === null || body.email === "" ? null : body.email;
        if (email !== null) {
          const problem = emailProblem(email);
          if (problem)
            throw new HttpError(
              400,
              `bad email: ${problem}`,
              "fix the address, or send null to clear it",
              "bad_request",
            );
        }
        const owner = this.current() as Owner;
        writeOwner(this.opts.home, { ...owner, email: email as string | null });
        this.current();
        return json(200, { email });
      }
      case "test-mail": {
        keys(body, []);
        this.signedIn(req);
        const owner = this.current() as Owner;
        if (!owner.email)
          throw new HttpError(
            409,
            "the owner has no email address",
            "save one first, then send a test email",
            "invalid_state",
          );
        await this.send(owner.email, "Pipo test email", [
          `This is a test email from the Pipo engine at ${this.opts.base()}.`,
          "",
          "If you got it, password reset links will reach you too.",
        ]);
        return json(200, { sent: owner.email });
      }
      case "forgot":
        return await this.forgot(body, ip);
      case "reset":
        return await this.reset(req, body, ip);
    }
    throw new HttpError(
      404,
      `no API route /api/auth/${action}`,
      "the auth routes are setup, login, logout, logout-all, password, email, test-mail, forgot and reset",
      "not_found",
    );
  }

  private state(req: Request) {
    const owner = this.current();
    const caller = this.mode === "open" ? null : this.identify(req);
    return {
      mode: this.mode,
      owner: owner !== null,
      user: caller && owner ? owner.username : null,
      via: caller?.via ?? null,
      email: caller && owner ? owner.email : null,
      mail: this.mailUsable,
      // The CLI holds the key, so it may read the code to open the setup page with it filled in.
      ...(caller?.via === "key" && !owner && this.mode === "owner" && { setup_code: this.setupCode() }),
    };
  }

  private async setup(req: Request, body: Record<string, unknown>, ip: string): Promise<Response> {
    keys(body, ["code", "username", "password", "email"]);
    if (this.current())
      throw new HttpError(
        409,
        "Pipo already has an owner",
        "log in instead; to set a new password run pipo owner reset on the engine's machine",
        "invalid_state",
      );
    this.limiter.check(ip);
    const code = optional(body, "code", "string") ?? "";
    const expected = this.setupCode();
    if (!safeEqual(normalizeCode(code), normalizeCode(expected))) {
      this.limiter.fail(ip);
      throw new HttpError(
        403,
        "that setup code is not right",
        "copy the code from the engine log (or the terminal that started it), or run pipo ui on this machine",
        "forbidden",
      );
    }
    const email = body.email === "" || body.email === undefined ? null : body.email;
    const problem =
      usernameProblem(body.username) ?? passwordProblem(body.password) ?? (email === null ? null : emailProblem(email));
    if (problem) throw new HttpError(400, problem, "fix it and send the form again", "bad_request");
    await setOwnerPassword(this.opts.home, {
      username: body.username as string,
      password: body.password as string,
      email: email as string | null,
    });
    this.code = null;
    this.limiter.ok(ip);
    const owner = this.current() as Owner;
    this.opts.log("info", `owner '${owner.username}' created`);
    return json(201, { user: owner.username }, { "set-cookie": this.startSession(req, ip) });
  }

  private async login(req: Request, body: Record<string, unknown>, ip: string): Promise<Response> {
    keys(body, ["username", "password"]);
    this.limiter.check(ip);
    const username = optional(body, "username", "string") ?? "";
    const password = optional(body, "password", "string") ?? "";
    const owner = this.current();
    if (!owner)
      throw new HttpError(401, "Pipo has no owner yet", "create it on the setup page first", "owner_setup_required");
    // Always verify a hash, so a wrong username takes as long as a wrong password.
    const right = owner.username.toLowerCase() === username.toLowerCase();
    const valid = right
      ? await verifyPassword(owner, password)
      : await Bun.password.verify(password, await this.dummy()).catch(() => false);
    if (!right || !valid) {
      this.limiter.fail(ip);
      throw new HttpError(
        401,
        "wrong username or password",
        this.mailUsable
          ? "try again, or use 'Forgot password' to get a reset link by email"
          : "try again; if you forgot it, run pipo owner reset on the engine's machine",
        "login_failed",
      );
    }
    this.limiter.ok(ip);
    return json(200, { user: owner.username }, { "set-cookie": this.startSession(req, ip) });
  }

  private async changePassword(req: Request, body: Record<string, unknown>, ip: string): Promise<Response> {
    keys(body, ["current", "password"]);
    const caller = this.signedIn(req);
    this.limiter.check(ip);
    const owner = this.current() as Owner;
    if (!(await verifyPassword(owner, optional(body, "current", "string") ?? ""))) {
      this.limiter.fail(ip);
      throw new HttpError(403, "the current password is wrong", "type the password you log in with now", "forbidden");
    }
    const problem = passwordProblem(body.password);
    if (problem) throw new HttpError(400, problem, "choose another one", "bad_request");
    await setOwnerPassword(this.opts.home, { password: body.password as string });
    this.limiter.ok(ip);
    this.current();
    this.opts.log("info", "the owner's password was changed; every other session ended");
    const headers: Record<string, string> =
      caller.via === "session" ? { "set-cookie": this.startSession(req, ip) } : {};
    return json(200, { changed: true }, headers);
  }

  private async forgot(body: Record<string, unknown>, ip: string): Promise<Response> {
    keys(body, ["login"]);
    this.mailLimiter.check(ip);
    // Counted either way, so nobody can use it to flood the owner's inbox.
    this.mailLimiter.fail(ip);
    const login = (optional(body, "login", "string") ?? "").trim().toLowerCase();
    const owner = this.current();
    const answer = json(202, {
      accepted: true,
      hint: "if that is the owner's username or email and the engine can send mail, a reset link is on its way; it works once, for 30 minutes",
    });
    if (!owner?.email || !this.mailUsable || !login) return answer;
    if (login !== owner.username.toLowerCase() && login !== owner.email.toLowerCase()) return answer;
    const now = Date.now();
    for (const [k, until] of this.resets) if (until <= now) this.resets.delete(k);
    if (this.resets.size >= MAX_RESETS) return answer;
    const token = randomToken();
    this.resets.set(sha256(token), now + RESET_TTL_MS);
    const link = `${this.opts.base()}/ui/#/reset/${token}`;
    this.send(owner.email, "Reset your Pipo password", [
      `Someone asked to reset the password of '${owner.username}' on the Pipo engine at ${this.opts.base()}.`,
      "",
      "To choose a new password, open this link within 30 minutes (it works once):",
      "",
      link,
      "",
      "If it wasn't you, ignore this email: your password stays as it is.",
    ]).catch((e) => this.opts.log("error", `owner: the reset email failed: ${(e as Error).message}`));
    return answer;
  }

  private async reset(req: Request, body: Record<string, unknown>, ip: string): Promise<Response> {
    keys(body, ["token", "password"]);
    this.limiter.check(ip);
    const digest = sha256(optional(body, "token", "string") ?? "");
    const until = this.resets.get(digest);
    if (until === undefined || until <= Date.now()) {
      this.resets.delete(digest);
      this.limiter.fail(ip);
      throw new HttpError(
        400,
        "this reset link is not valid (any more)",
        "links work once, for 30 minutes: ask for a new one, or run pipo owner reset on the engine's machine",
        "bad_request",
      );
    }
    const problem = passwordProblem(body.password);
    if (problem) throw new HttpError(400, problem, "choose another one", "bad_request");
    await setOwnerPassword(this.opts.home, { password: body.password as string });
    this.resets.clear();
    this.limiter.ok(ip);
    const owner = this.current() as Owner;
    this.opts.log("info", "the owner's password was reset from an email link; every session ended");
    return json(200, { user: owner.username }, { "set-cookie": this.startSession(req, ip) });
  }

  /** The caller, who must be the owner (a session or the key): changing the account needs more than open access. */
  private signedIn(req: Request): Caller {
    const caller = this.identify(req);
    if (!caller || !this.current())
      throw new HttpError(401, "log in first", "log in on the dashboard (/ui)", "login_required");
    return caller;
  }

  // ── mail ───────────────────────────────────────────────────────────────────

  private async resolveMail(): Promise<void> {
    const mail = this.opts.config.mail;
    if (!mail) return;
    if (mail.password === null) {
      this.mailUsable = true;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`resolving it took over ${RESOLVE_TIMEOUT_MS / 1000}s`)),
          RESOLVE_TIMEOUT_MS,
        );
      });
      const resolved = await Promise.race([Secrets.resolve({ smtp: mail.password }), timeout]);
      this.mailPassword = resolved.values.smtp as string;
      this.mailUsable = true;
    } catch (e) {
      this.opts.log(
        "error",
        `mail: engine.mail.password (${mail.password}) is not usable: ${(e as Error).message}; reset links by email are off until it resolves and the engine restarts`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async send(to: string, subject: string, lines: string[]): Promise<void> {
    const mail = this.opts.config.mail;
    if (!mail || !this.mailUsable)
      throw new HttpError(
        409,
        "this engine can't send mail",
        "set engine.mail in config.yaml (host, port, user, password reference, from) and restart the engine",
        "invalid_state",
      );
    try {
      await sendMail({ ...mail, password: this.mailPassword }, { to, subject, text: lines.join("\n") });
    } catch (e) {
      if (e instanceof MailError) throw new HttpError(502, e.message, e.hint, "mail_failed");
      throw e;
    }
  }

  // ── state ──────────────────────────────────────────────────────────────────

  /** The owner, re-read when owner.json changed (`pipo owner reset` writes it directly). */
  private current(): Owner | null {
    const stamp = ownerStamp(this.opts.home);
    if (stamp !== this.stamp) {
      this.stamp = stamp;
      this.owner = readOwner(this.opts.home);
      const epoch = this.owner?.epoch;
      let dropped = false;
      for (const [k, s] of this.sessions)
        if (s.epoch !== epoch) {
          this.sessions.delete(k);
          dropped = true;
        }
      if (dropped) this.saveSessions();
      if (this.owner) this.code = null;
    }
    return this.owner;
  }

  private setupCode(): string {
    this.code ??= setupCode();
    return this.code;
  }

  private engineKey(): string | null {
    // Re-read now and then: `pipo owner reset --rotate-key` replaces it while the engine runs.
    if (Date.now() - this.keyCache.at > 2000) this.keyCache = { key: readEngineKey(this.opts.home), at: Date.now() };
    return this.keyCache.key;
  }

  private dummy(): Promise<string> {
    this.dummyHash ??= Bun.password.hash(randomToken(), { algorithm: "argon2id" });
    return this.dummyHash;
  }

  private startSession(req: Request, ip: string): string {
    const owner = this.current() as Owner;
    const token = randomToken();
    const now = Date.now();
    const session: Session = {
      digest: sha256(token),
      epoch: owner.epoch,
      created_at: new Date(now).toISOString(),
      last_used_at: new Date(now).toISOString(),
      expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
      ip,
      agent: req.headers.get("user-agent")?.slice(0, 200) ?? null,
    };
    this.sessions.set(session.digest, session);
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.last_used_at.localeCompare(b.last_used_at))[0];
      this.sessions.delete((oldest as Session).digest);
    }
    this.saveSessions();
    return this.cookie(token, SESSION_TTL_MS / 1000);
  }

  private cookie(value: string, maxAge: number): string {
    const secure = this.opts.config.public_url?.startsWith("https:") ? "; Secure" : "";
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  }

  private loadSessions() {
    try {
      const raw = JSON.parse(readFileSync(sessionsPath(this.opts.home), "utf8"));
      const now = Date.now();
      for (const s of Array.isArray(raw?.sessions) ? raw.sessions : [])
        if (typeof s?.digest === "string" && Date.parse(s.expires_at) > now) this.sessions.set(s.digest, s as Session);
    } catch {}
  }

  private saveSessions() {
    writePrivateJson(sessionsPath(this.opts.home), { sessions: [...this.sessions.values()] });
  }
}

function cookieOf(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim() || null;
  }
  return null;
}

function keys(body: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length)
    throw unknownKeys(unknown, allowed.length ? allowed.map((k) => `\`${k}\``).join(", ") : "no keys");
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
