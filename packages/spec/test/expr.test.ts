// Conformance suite for the expression language (docs/spec.md §3.2). The cases live in fixtures/expr-cases.json,
// which the Rust runner runs too (crates/pipo-runner/tests/expr_conformance.rs). Any replacement for jsep, and
// any port, must pass them unchanged.
//
// A case is { name, ctx?, now?, expr | template | render | segments, expect | error, index? }:
// - `expr` goes through evaluate(), `template` through renderString(), `render` through render() (compared as
//   JSON, so undefined is dropped from objects and null elsewhere), `segments` through segments().
// - `ctx` (the context variables) defaults to {}. `now` fixes the clock, in epoch ms, for now() and iso().
// - `expect` writes undefined as {"$undefined": true}, and NaN, Infinity, -Infinity and -0 as {"$number": "NaN"} etc.
// - `error` is a substring of the ExprError's message, and `index` its position when the parser reports one.
import { describe, expect, setSystemTime, test } from "bun:test";
import { ExprError, evaluate, parse, render, renderString, segments } from "../src";
import cases from "./fixtures/expr-cases.json";

interface Case {
  name: string;
  ctx?: Record<string, unknown>;
  now?: number;
  expr?: string;
  template?: string;
  render?: unknown;
  segments?: string;
  expect?: unknown;
  error?: string;
  index?: number;
}

function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "$undefined") return undefined;
    if (keys.length === 1 && keys[0] === "$number") return Number((v as { $number: string }).$number);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
  }
  return v;
}

function run(c: Case): unknown {
  const ctx = c.ctx ?? {};
  if (c.expr !== undefined) return evaluate(c.expr, ctx);
  if (c.template !== undefined) return renderString(c.template, ctx);
  if (c.segments !== undefined) return segments(c.segments);
  return JSON.parse(JSON.stringify(render(c.render, ctx)) ?? "null");
}

describe("conformance (fixtures/expr-cases.json)", () => {
  test.each((cases as Case[]).map((c) => [c.name, c] as const))("%s", (_name, c) => {
    if (c.now !== undefined) setSystemTime(new Date(c.now));
    try {
      if (c.error === undefined) {
        expect(run(c)).toStrictEqual(decode(c.expect));
        return;
      }
      let error: unknown;
      try {
        run(c);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ExprError);
      expect((error as ExprError).message).toContain(c.error);
      if (c.index !== undefined) expect((error as ExprError).index).toBe(c.index);
    } finally {
      if (c.now !== undefined) setSystemTime();
    }
  });

  test("case names are unique", () => {
    const names = (cases as Case[]).map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("parse", () => {
  test("reports identifiers and helpers", () => {
    const c = parse("len(data.x) > 0 && meta.attempt < 3");
    expect([...c.identifiers].sort()).toEqual(["data", "meta"]);
    expect([...c.helpers]).toEqual(["len"]);
  });

  test("is cached", () => {
    expect(parse("data.a + 1")).toBe(parse("data.a + 1"));
  });

  test("errors from vetting the tree have no position", () => {
    expect(() => parse("eval(1)")).toThrow(ExprError);
    try {
      parse("eval(1)");
    } catch (e) {
      expect((e as ExprError).index).toBeUndefined();
    }
  });
});
