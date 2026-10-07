// Helper functions available in expressions (docs/spec.md §3.2).
import { parseDuration } from "../duration";

export function typeOf(x: unknown): string {
  if (x === null) return "null";
  if (Array.isArray(x)) return "array";
  return typeof x;
}

function text(x: unknown, fn: string): string {
  if (typeof x !== "string") throw new Error(`${fn}() expects a string, got ${typeOf(x)}`);
  return x;
}

export const HELPERS: Record<string, (...args: unknown[]) => unknown> = {
  exists: (x) => x !== undefined && x !== null,
  len: (x) => {
    if (typeof x === "string" || Array.isArray(x)) return x.length;
    if (x && typeof x === "object") return Object.keys(x).length;
    if (x === undefined || x === null) return 0;
    throw new Error(`len() expects a string, array or object, got ${typeOf(x)}`);
  },
  size: (x) => {
    if (x === undefined) return 0;
    if (x instanceof Uint8Array) return x.byteLength;
    return Buffer.byteLength(typeof x === "string" ? x : JSON.stringify(x));
  },
  type: typeOf,
  lower: (s) => text(s, "lower").toLowerCase(),
  upper: (s) => text(s, "upper").toUpperCase(),
  trim: (s) => text(s, "trim").trim(),
  matches: (s, re) => {
    const pattern = text(re, "matches");
    if (pattern.length > 200) throw new Error("matches() pattern is longer than 200 characters");
    return new RegExp(pattern).test(text(s, "matches"));
  },
  default: (x, y) => (x === undefined || x === null ? y : x),
  json: (x) => JSON.stringify(x),
  now: () => Date.now(),
  iso: (ms) => new Date(typeof ms === "number" ? ms : Date.now()).toISOString(),
  duration: (s) => parseDuration(text(s, "duration")),
};
