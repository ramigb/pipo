// Small helpers shared by the engine's private stores (mcp-grants.json, approvals.json, owner.json, sessions.json):
// an atomic 0600 JSON write, random tokens and their digests, and a constant-time compare.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Write `value` as JSON to `path` through a temp file and a rename, readable by the owner only. */
export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(`${path}.tmp`, 0o600);
  renameSync(`${path}.tmp`, path);
}

/** 32 random bytes, base64url. */
export const randomToken = () => randomBytes(32).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
