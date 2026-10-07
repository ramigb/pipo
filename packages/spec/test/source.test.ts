// toSource (docs/spec.md §8, D62): the builder's `.pipo` text, fresh in the canonical layout, or applied onto a base so
// what didn't change keeps its comments and layout.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { check, deepEqual, load, toSource } from "../src";

const ROOT = join(import.meta.dir, "../../..");
const examples = [...new Glob("examples/**/*.pipo").scanSync(ROOT)].sort();

test("every example: unchanged with itself as base, and a fresh write loads back to the same value", () => {
  expect(examples.length).toBeGreaterThan(0);
  for (const f of examples) {
    const src = readFileSync(join(ROOT, f), "utf8");
    const value = load(src).value as object;
    expect(toSource(value, src)).toBe(src);
    expect(deepEqual(load(toSource(value)).value, value)).toBe(true);
  }
});

test("every example: an edit rewrites only the lines it changes", () => {
  for (const f of examples) {
    const src = readFileSync(join(ROOT, f), "utf8");
    const value = structuredClone(load(src).value) as any;
    value.name = "renamed";
    const out = toSource(value, src).split("\n");
    const before = src.split("\n");
    expect(out.length).toBe(before.length);
    expect(out.filter((l, i) => l !== before[i])).toEqual(["name: renamed"]);
  }
});

const BASE = `# my pipeline
pipo: 1
name: demo

input:
  via: push # pushed by hand

nodes:
  # keeps shouting
  shout:
    from: input
    transform: map
    with:
      data: { b: "\${data.a}" }

output:
  from: shout
  to: stdout
`;

test("comments survive an edit elsewhere; removed keys go, new keys land at their canonical place", () => {
  const v = structuredClone(load(BASE).value) as any;
  v.output.to = "file";
  v.output.with = { path: "./out.jsonl" };
  v.nodes.shout.label = "Shout";
  v.nodes.keep = { from: "shout", filter: "data.b != null" };
  v.output.from = "keep";
  const out = toSource(v, BASE);
  expect(out).toContain("# my pipeline");
  expect(out).toContain("via: push # pushed by hand");
  expect(out).toContain("# keeps shouting");
  expect(out).toContain("  shout:\n    label: Shout\n    from: input\n");
  expect(out).toContain("output:\n  from: keep\n  to: file\n  with:\n    path: ./out.jsonl\n");
  expect(deepEqual(load(out).value, v)).toBe(true);

  delete v.nodes.shout.label;
  v.nodes.shout.with = undefined;
  v.nodes.shout.transform = "fn.x";
  const removed = toSource(v, out);
  expect(removed).not.toContain("label: Shout");
  expect(removed).not.toContain("data: {");
  expect(removed).toContain("# keeps shouting");
  expect(deepEqual(load(removed).value, JSON.parse(JSON.stringify(v)))).toBe(true);
});

test("a fresh write uses the canonical order and passes check", () => {
  const out = toSource({
    output: { to: "stdout", from: ["a", "b"] },
    nodes: {
      a: { with: { level: "info" }, tap: "log", from: "input" },
      b: { filter: "true", from: "input", label: undefined },
    },
    input: { via: "push" },
    name: "fresh",
    pipo: 1,
  });
  expect(out).toBe(
    'pipo: 1\nname: fresh\n\ninput:\n  via: push\n\nnodes:\n  a:\n    from: input\n    tap: log\n    with:\n      level: info\n\n  b:\n    from: input\n    filter: "true"\n\noutput:\n  from: [a, b]\n  to: stdout\n',
  );
  expect(check(out).filter((d) => d.severity === "error")).toEqual([]);
});

test("a base that doesn't parse is ignored", () => {
  expect(toSource({ pipo: 1, name: "x" }, "a: [")).toBe("pipo: 1\nname: x\n");
});
