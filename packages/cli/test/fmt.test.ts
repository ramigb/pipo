import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "@pipo/spec";
import { parse } from "yaml";
import { sandbox } from "../../runner/test/helpers";
import { main } from "../src/cli";
import { CliError } from "../src/errors";
import { formatPipo } from "../src/fmt";

const sb = sandbox();
const repo = join(import.meta.dir, "../../..");

function pipoFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) pipoFiles(p, out);
    else if (e.endsWith(".pipo")) out.push(p);
  }
  return out;
}

const spec = readFileSync(join(repo, "docs/spec.md"), "utf8");
const sources: [string, string][] = [
  ...pipoFiles(join(repo, "examples")).map((f): [string, string] => [f, readFileSync(f, "utf8")]),
  ...[...spec.matchAll(/```yaml\n(pipo: 1\n[\s\S]*?)```/g)].map((m): [string, string] => [
    `spec ${/name: (\S+)/.exec(m[1] as string)?.[1]}`,
    m[1] as string,
  ]),
];

test("there are sources to format", () => {
  expect(sources.length).toBeGreaterThanOrEqual(5);
});

test.each(sources)("%s: fmt is idempotent and keeps the parsed document and check() results", (name, src) => {
  const once = formatPipo(src, name);
  expect(formatPipo(once, name)).toBe(once);
  expect(parse(once)).toEqual(parse(src));
  const strip = (ds: ReturnType<typeof check>) => ds.map((d) => `${d.severity} ${d.code} ${d.message}`);
  expect(strip(check(once, { fs: false }))).toEqual(strip(check(src, { fs: false })));
});

const MESSY = `# top comment
nodes:
  b:   # trailing note
    with: {x: 1}
    transform: map
    from: input
    label: B
output:
  on_error: {then: drop}
  # about to
  to: stdout
  from: b
input:
    via: http
    format: json
name: m
pipo: 1
`;

test("canonical key order, 2-space indent, comments preserved", () => {
  const out = formatPipo(MESSY);
  expect(out).toContain("# top comment");
  expect(out).toContain("# trailing note");
  expect(out).toContain("# about to");
  const top = [...out.matchAll(/^([a-z_]+):/gm)].map((m) => m[1]);
  expect(top).toEqual(["pipo", "name", "input", "nodes", "output"]);
  expect(out.indexOf("label: B")).toBeLessThan(out.indexOf("from: input"));
  expect(out.indexOf("from: input")).toBeLessThan(out.indexOf("transform: map"));
  expect(out.indexOf("transform: map")).toBeLessThan(out.indexOf("with:"));
  expect(out).toContain("\n  via: http\n");
  expect(out.indexOf("from: b")).toBeLessThan(out.indexOf("to: stdout"));
  expect(out.indexOf("to: stdout")).toBeLessThan(out.indexOf("on_error:"));
});

test("a file with broken YAML is refused with a hint", () => {
  try {
    formatPipo("pipo: 1\nname: [oops\n", "bad.pipo");
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).message).toContain("bad.pipo");
    expect((e as CliError).hint).toContain("fix the YAML");
    return;
  }
  throw new Error("expected an error");
});

test("pipo fmt rewrites files, --check lists them and exits 1, folders are walked", async () => {
  const dir = join(sb.root, "fmt");
  mkdirSync(join(dir, "sub"), { recursive: true });
  const a = join(dir, "a.pipo");
  const b = join(dir, "sub", "b.pipo");
  writeFileSync(a, MESSY);
  writeFileSync(b, formatPipo(MESSY));
  expect(await main(["fmt", "--check", dir])).toBe(1);
  expect(readFileSync(a, "utf8")).toBe(MESSY);
  expect(await main(["fmt", dir])).toBe(0);
  expect(readFileSync(a, "utf8")).toBe(formatPipo(MESSY));
  expect(await main(["fmt", "--check", dir])).toBe(0);
  const bad = join(dir, "bad.pipo");
  writeFileSync(bad, "name: [oops\n");
  expect(await main(["fmt", bad])).toBe(1);
  expect(readFileSync(bad, "utf8")).toBe("name: [oops\n");
});

test("flow collections are not padded", () => {
  const out = formatPipo("pipo: 1\nname: f\ninput: { via: watch, with: { events: [ create ] } }\n");
  expect(out).toContain("events: [create]");
  expect(out).toContain("{via: watch");
  expect(out).not.toContain("[ ");
});

test("block scalars keep their style and line breaks", () => {
  const src = [
    "pipo: 1",
    "name: b",
    "output:",
    "  from: input",
    "  to: stdout",
    "  on_error:",
    "    then: dead_letter",
    "    message: >",
    "      first line of text that is",
    "      broken by hand here",
    "  validate:",
    "    - exists(data)",
    "description: |-",
    "    kept",
    "    literally",
    "",
  ].join("\n");
  const out = formatPipo(src);
  expect(out).toContain("    message: >\n      first line of text that is\n      broken by hand here\n");
  expect(out).toContain("description: |-\n  kept\n  literally\n");
  expect(parse(out)).toEqual(parse(src));
  expect(formatPipo(out)).toBe(out);
});
