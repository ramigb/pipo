// Conformance suite for the expression language (docs/spec.md §3.2). Any replacement for
// jsep must pass this file unchanged.
import { describe, expect, test } from "bun:test";
import { ExprError, evaluate, parse, render, renderString, segments } from "../src";

const ctx = {
  data: { name: " Ada ", age: 36, tags: ["a", "b"], nested: { x: 1 }, nil: null },
  meta: { packet_id: "01J9", received_at: 1_000 },
  env: {},
};

describe("evaluate", () => {
  test.each([
    ["data.age > 30", true],
    ["data.age > 30 && len(trim(data.name)) > 0", true],
    ["data.missing.deep.path", undefined],
    ["data.nil?.x ?? 'fallback'", "fallback"],
    ["data.tags[1]", "b"],
    ["'a' in data.tags", true],
    ["'x' in data.nested", true],
    ["'da' in 'Ada'", true],
    ["data.age == '36'", false],
    ["data.tags == ['a', 'b']", true],
    ["data.age >= 18 ? 'adult' : 'minor'", "adult"],
    ["{ n: upper(trim(data.name)), y: data.age + 1 }", { n: "ADA", y: 37 }],
    ["exists(data.nil)", false],
    ["type(data.tags)", "array"],
    ["default(data.missing, 5)", 5],
    ["matches(data.name, '^\\\\s*A')", true],
    ["duration('2m')", 120_000],
    ["!exists(data.missing)", true],
    ["-data.age", -36],
  ])("%s", (source, expected) => {
    expect(evaluate(source, ctx)).toEqual(expected as any);
  });

  test("never reaches the prototype chain", () => {
    expect(evaluate("data.name.length", ctx)).toBe(5);
    expect(evaluate("data.toString", ctx)).toBeUndefined();
    expect(evaluate("data['constructor']", ctx)).toBeUndefined();
  });

  test("unknown variables are errors", () => {
    expect(() => evaluate("secrets.token", ctx)).toThrow("'secrets' is not available here");
  });
});

describe("parse rejects anything outside the subset", () => {
  test.each([
    ["data.a = 1", ""],
    ["a, b", "single expression"],
    ["data.name.toUpperCase()", "only helper functions"],
    ["eval('1')", "unknown function 'eval'"],
    ["data.__proto__", "'__proto__'"],
    ["1 | 2", "operator '|'"],
    ["this", ""],
    ["{ [k]: 1 }", ""],
  ])("%s", (source, message) => {
    expect(() => parse(source)).toThrow(ExprError);
    if (message) expect(() => parse(source)).toThrow(message);
  });

  test("limits nesting", () => {
    expect(() => parse(`${"!".repeat(40)}1`)).toThrow();
  });

  test("reports identifiers and helpers", () => {
    const c = parse("len(data.x) > 0 && meta.attempt < 3");
    expect([...c.identifiers].sort()).toEqual(["data", "meta"]);
    expect([...c.helpers]).toEqual(["len"]);
  });
});

describe("templates", () => {
  test("a single expression keeps its type", () => {
    expect(renderString("${data.age}", ctx)).toBe(36);
    expect(renderString("${data.tags}", ctx)).toEqual(["a", "b"]);
  });

  test("mixed text renders to a string", () => {
    expect(renderString("age=${data.age} tags=${data.tags} nil=${data.nil}", ctx)).toBe('age=36 tags=["a","b"] nil=');
  });

  test("handles braces and quotes inside expressions", () => {
    expect(renderString("${ {a: '}'}.a }!", ctx)).toBe("}!");
    expect(segments("x ${json({a: 1})} y")).toEqual([
      { text: "x " },
      { expr: "json({a: 1})", offset: 4 },
      { text: " y" },
    ]);
  });

  test("$${ escapes a literal ${", () => {
    expect(renderString("cost: $${data.age}", ctx)).toBe("cost: ${data.age}");
  });

  test("render walks objects and arrays", () => {
    expect(render<unknown>({ id: "${meta.packet_id}", list: ["${data.age}", "x"] }, ctx)).toEqual({
      id: "01J9",
      list: [36, "x"],
    });
  });

  test("unclosed template is an error", () => {
    expect(() => segments("hello ${data")).toThrow("unclosed");
  });
});
