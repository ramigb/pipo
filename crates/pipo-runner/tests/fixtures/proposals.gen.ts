// Regenerates proposals.json, the expected outputs of the TypeScript unifiedDiff, changedPaths, covers and
// agentPolicyProblems that the Rust ports must match exactly (tests/reads.rs, tests/proposals.rs).
// Run from the repo root: bun crates/pipo-runner/tests/fixtures/proposals.gen.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentPolicyProblems, changedPaths, covers, unifiedDiff } from "../../../../packages/runner/src";

let seed = 42;
const rand = (n: number) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % n;
};

const texts: [string, string][] = [
  ["", ""],
  ["a\n", "a\n"],
  ["a", "a\n"],
  ["a\n", "a"],
  ["", "y\n"],
  ["x\n", ""],
  ["x\n", "y\n"],
  ["a\nb\nc\nd\ne\nf\ng\nh\n", "A\nb\nc\nd\ne\nf\ng\nH\n"],
  ["a\nb\nc\nd\ne\nf\ng\nh\ni\n", "A\nb\nc\nd\ne\nf\ng\nh\nI\n"],
  ["a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", "A\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n"],
  ["\n\n\n", "\n\n"],
  ["a\r\nb\r\n", "a\r\nc\r\n"],
  ["héllo\nwörld\n", "héllo\nwürld\n"],
];
// Random edits over a small alphabet, so lines repeat and the LCS has choices to make.
for (let k = 0; k < 60; k++) {
  const n = rand(14);
  const a = Array.from({ length: n }, () => "abcde"[rand(5)] as string);
  const b = a.slice();
  for (let e = rand(5); e >= 0; e--) {
    const at = rand(b.length + 1);
    const op = rand(3);
    if (op === 0) b.splice(at, 0, "abcdeX"[rand(6)] as string);
    else if (op === 1) b.splice(at, 1);
    else b[at] = "xyz"[rand(3)] as string;
  }
  const end = (lines: string[]) => (lines.length && rand(4) ? `${lines.join("\n")}\n` : lines.join("\n"));
  texts.push([end(a), end(b)]);
}
const diffs = texts.map(([before, after], i) => ({
  before,
  after,
  context: i % 7 === 6 ? 1 : 3,
  expected: unifiedDiff(before, after, "p v1", "p v2", i % 7 === 6 ? 1 : 3),
}));

// Around MAX_CELLS: a 4999 x 4999 middle is aligned (LCS); a 5002 x 5002 one falls back to removed-then-added.
const big = (n: number, side: string) =>
  `head\n${Array.from({ length: n }, (_, i) => (i % 100 === 0 ? `common ${i}` : `${side} ${i}`)).join("\n")}\ntail\n`;
const large = [5000, 5003].map((n) => {
  const d = unifiedDiff(big(n, "a"), big(n, "b"), "a", "b");
  return {
    n,
    added: d.added,
    removed: d.removed,
    lines: d.diff.split("\n").length,
    sha256: new Bun.CryptoHasher("sha256").update(d.diff).digest("hex"),
  };
});

const docs: [unknown, unknown][] = [
  [
    { a: { b: 1, c: [1, 2] }, d: 1 },
    { d: 1, a: { c: [1, 3], b: 1 } },
  ],
  [{ a: 1 }, { a: 1, b: { c: 2 } }],
  [{ a: { x: 1 } }, { a: 2 }],
  [{ a: [{ k: 1, j: 2 }] }, { a: [{ j: 2, k: 1 }] }],
  [{ a: null }, {}],
  [{ a: null }, { a: null }],
  [{ a: 1 }, { a: 1.5 }],
  [{ a: "1" }, { a: 1 }],
  [{ a: {} }, { a: [] }],
  [1, 2],
  [{ a: 1 }, null],
  [{}, {}],
  [
    { Zeta: 1, alpha: 1, a_b: 1, aB: 1, "a-b": 1, a1: 1, A: { b: 1 }, ab: { c: 1 } },
    { Zeta: 2, alpha: 2, a_b: 2, aB: 2, "a-b": 2, a1: 2, A: { b: 2 }, ab: { c: 2 } },
  ],
  [
    { nodes: { b: { with: { x: 1 } }, a: { with: { x: 1, y: [1] } } }, output: { to: "file" } },
    { nodes: { a: { with: { x: 2, y: [2] } }, c: { from: "a" } }, output: { to: "http" }, agent: { control: true } },
  ],
  [
    { "x.y": { z: 1 }, x: { y: 1 } },
    { "x.y": { z: 2 }, x: { y: 2 } },
  ],
];
const changed = docs.map(([before, after]) => ({ before, after, expected: changedPaths(before, after) }));

const patterns = [
  ["nodes.*.with.message", ["nodes", "note", "with", "message"]],
  ["nodes.*.with.message", ["nodes", "a", "b", "with", "message"]],
  ["nodes.normalize", ["nodes", "normalize", "with", "data", "tag"]],
  ["nodes.normalize.with", ["nodes", "normalize"]],
  ["nodes.norm", ["nodes", "normalize"]],
  ["*", ["anything"]],
  ["*", []],
  ["", [""]],
  ["*.*", ["a", "b", "c"]],
] as const;
const coverage = patterns.map(([pattern, path]) => ({ pattern, path, expected: covers(pattern, path) }));

const base = (agent?: unknown) => ({
  pipo: 1,
  name: "demo",
  input: { via: "push" },
  output: { from: "input", to: "stdout" },
  ...(agent === undefined ? {} : { agent }),
});
const policies: [unknown, string[][]][] = [
  [undefined, [["nodes", "a"]]],
  [{ control: false, edit: ["nodes"] }, [["nodes", "a"]]],
  [{ control: true }, [["nodes", "a"]]],
  [{ control: true, edit: [] }, [["nodes", "a"]]],
  [
    { control: true, edit: ["nodes.*.with"] },
    [
      ["nodes", "a", "with", "x"],
      ["nodes", "a", "from"],
    ],
  ],
  [
    { control: true, edit: ["*"] },
    [["output", "to"], ["agent"], ["agent_budget", "per_day"], ["secrets"], ["delivered"]],
  ],
  [{ control: true, edit: ["nodes", "errors"] }, [[], ["description"], ["nodes", "x"]]],
];
const policy = policies.map(([agent, changedList]) => ({
  base: base(agent),
  changed: changedList,
  expected: agentPolicyProblems(base(agent) as never, changedList),
}));

const out = join(import.meta.dir, "proposals.json");
writeFileSync(out, `${JSON.stringify({ diffs, large, changed, covers: coverage, policy }, null, 2)}\n`);
// As `bun run format` would leave it, so `bun run lint` passes.
Bun.spawnSync([join(import.meta.dir, "../../../../node_modules/.bin/biome"), "format", "--write", out]);
