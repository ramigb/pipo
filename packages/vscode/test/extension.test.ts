import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..");
const json = (p: string) => JSON.parse(readFileSync(join(dir, p), "utf8"));
const pkg = json("package.json");
const injection = json("syntaxes/pipo-injection.tmLanguage.json");

test("package.json contributes are well-formed and point at existing files", () => {
  expect(pkg.private).toBe(true);
  expect(pkg.dependencies).toBeUndefined();
  expect(pkg.devDependencies).toBeUndefined();
  expect(pkg.engines.vscode).toBeString();
  const lang = pkg.contributes.languages[0];
  expect(lang.id).toBe("pipo");
  expect(lang.extensions).toEqual([".pipo"]);
  const paths = [
    lang.configuration,
    ...pkg.contributes.grammars.map((g: { path: string }) => g.path),
    ...pkg.contributes.yamlValidation.map((v: { url: string }) => v.url),
  ];
  for (const p of paths) expect(existsSync(join(dir, p))).toBe(true);
  expect(pkg.contributes.yamlValidation[0].fileMatch).toBe("*.pipo");
  const main = pkg.contributes.grammars.find((g: { scopeName: string }) => g.scopeName === "source.pipo");
  expect(json(main.path).patterns).toEqual([{ include: "source.yaml" }]);
  expect(pkg.contributes.grammars.find((g: { injectTo?: string[] }) => g.injectTo)?.injectTo).toEqual(["source.pipo"]);
  const cfg = json("language-configuration.json");
  expect(cfg.comments.lineComment).toBe("#");
  expect(cfg.autoClosingPairs).toContainEqual({ open: "${", close: "}", notIn: ["comment"] });
});

const begin = new RegExp(injection.repository.template.begin);
const strings = injection.repository.expr.patterns
  .filter((p: { name?: string }) => p.name?.startsWith("string."))
  .map((p: { match: string }) => new RegExp(p.match));

test("injection begins at ${ and not at a bare $", () => {
  expect(begin.test("x: ${data.name}")).toBe(true);
  expect(begin.test('to: "${ a ? 1 : 2 }"')).toBe(true);
  expect(begin.test("x: $data")).toBe(false);
  expect(begin.test("x: {data}")).toBe(false);
});

test("injection handles strings containing braces and nested braces", () => {
  const src = '${ a ? "}" : b }';
  const inner = src.slice(2);
  const hit = strings.map((r: RegExp) => r.exec(inner)?.[0]).find(Boolean);
  expect(hit).toBe('"}"');
  const nested = injection.repository.expr.patterns.find((p: { begin?: string }) => p.begin);
  expect(new RegExp(nested.begin).test("{ a: 1 }")).toBe(true);
  expect(injection.repository.template.patterns).toEqual([{ include: "#expr" }]);
});

test("bundled schema equals the published schema", () => {
  const published = readFileSync(join(dir, "..", "..", "schema", "pipo.schema.json"), "utf8");
  expect(readFileSync(join(dir, "schemas", "pipo.schema.json"), "utf8")).toBe(published);
});
