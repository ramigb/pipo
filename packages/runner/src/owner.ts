// The owner account (docs/spec.md §11, D84): one person, a username and a password (argon2id, Bun.password), and an
// optional email for reset links (D86). Kept in `<home>/owner.json` (0600, atomic). `epoch` grows on every password
// change or reset, and a session from an older epoch is dead, so `pipo owner reset` (which writes this file directly,
// with or without an engine) logs every browser out.
// `<home>/engine.key` is the engine key: whoever can read the home is the owner, so the CLI sends it instead of a login.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Owner {
  username: string;
  email: string | null;
  password_hash: string;
  epoch: number;
  created_at: string;
  password_changed_at: string;
}

export const ownerPath = (home: string) => join(home, "owner.json");
export const sessionsPath = (home: string) => join(home, "sessions.json");
export const engineKeyPath = (home: string) => join(home, "engine.key");

export const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MIN_PASSWORD = 10;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function usernameProblem(v: unknown): string | null {
  return typeof v === "string" && USERNAME.test(v)
    ? null
    : "a username is letters, digits, '.', '_' or '-' (up to 64), starting with a letter or digit";
}

export function passwordProblem(v: unknown): string | null {
  if (typeof v !== "string" || v.length < MIN_PASSWORD)
    return `a password needs at least ${MIN_PASSWORD} characters (a few words make a good one)`;
  if (v.length > 1024) return "a password can be at most 1024 characters";
  return null;
}

export function emailProblem(v: unknown): string | null {
  return typeof v === "string" && v.length <= 254 && EMAIL.test(v) ? null : "an email looks like name@example.com";
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The owner, or null when there is none yet (or the file is unreadable, which the setup screen then replaces). */
export function readOwner(home: string): Owner | null {
  try {
    const o = JSON.parse(readFileSync(ownerPath(home), "utf8"));
    if (isMap(o) && typeof o.username === "string" && typeof o.password_hash === "string")
      return {
        username: o.username,
        email: typeof o.email === "string" ? o.email : null,
        password_hash: o.password_hash,
        epoch: Number.isInteger(o.epoch) ? (o.epoch as number) : 0,
        created_at: String(o.created_at ?? ""),
        password_changed_at: String(o.password_changed_at ?? ""),
      };
  } catch {}
  return null;
}

export function writeOwner(home: string, owner: Owner): void {
  writePrivate(ownerPath(home), `${JSON.stringify(owner, null, 2)}\n`);
}

/** Write through a temp file and a rename, readable by the owner only. */
function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  chmodSync(`${path}.tmp`, 0o600);
  renameSync(`${path}.tmp`, path);
}

/**
 * A stamp that changes whenever owner.json is replaced (every write is a rename, so a new inode), or "" when it is
 * missing: a cheap "did it change" check that doesn't depend on the clock's granularity.
 */
export function ownerStamp(home: string): string {
  try {
    const st = statSync(ownerPath(home));
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}

/**
 * Create the owner, or set a new password (and username) for it. Bumps the epoch, so every session ends, and clears
 * `sessions.json`. Validates first; throws an Error whose message says what to fix.
 */
export async function setOwnerPassword(
  home: string,
  opts: { password: string; username?: string; email?: string | null },
): Promise<Owner> {
  const current = readOwner(home);
  const username = opts.username ?? current?.username;
  if (username === undefined) throw new Error("there is no owner yet: give a username too");
  const problem =
    usernameProblem(username) ?? passwordProblem(opts.password) ?? (opts.email ? emailProblem(opts.email) : null);
  if (problem) throw new Error(problem);
  const now = new Date().toISOString();
  const owner: Owner = {
    username,
    email: opts.email === undefined ? (current?.email ?? null) : opts.email || null,
    password_hash: await Bun.password.hash(opts.password, { algorithm: "argon2id" }),
    epoch: (current?.epoch ?? 0) + 1,
    created_at: current?.created_at || now,
    password_changed_at: now,
  };
  writeOwner(home, owner);
  rmSync(sessionsPath(home), { force: true });
  return owner;
}

export function verifyPassword(owner: Owner, password: string): Promise<boolean> {
  return Bun.password.verify(password, owner.password_hash).catch(() => false);
}

/** The engine key, or null when none was made yet. */
export function readEngineKey(home: string): string | null {
  try {
    const key = readFileSync(engineKeyPath(home), "utf8").trim();
    return key.length >= 32 ? key : null;
  } catch {
    return null;
  }
}

/** Replace the engine key with a new random one (0600). */
export function rotateEngineKey(home: string): string {
  const key = randomBytes(32).toString("base64url");
  writePrivate(engineKeyPath(home), `${key}\n`);
  return key;
}

/** The engine key, made on first use. */
export function ensureEngineKey(home: string): string {
  return readEngineKey(home) ?? rotateEngineKey(home);
}
