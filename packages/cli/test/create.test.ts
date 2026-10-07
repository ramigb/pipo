import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkFile } from "@pipo/spec";
import { sandbox } from "../../runner/test/helpers";
import { CliError } from "../src/errors";
import { generateNode } from "../src/generate";
import { newPipeline } from "../src/new";
import { findTemplate, listTemplates } from "../src/templates";

const sb = sandbox();
let n = 0;
const fresh = () => {
  const cwd = join(sb.root, `case-${n++}`);
  mkdirSync(cwd, { recursive: true });
  return { cwd, home: join(cwd, "home") };
};
const fails = (fn: () => unknown, message: RegExp, hint: RegExp) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).message).toMatch(message);
    expect((e as CliError).hint).toMatch(hint);
    return;
  }
  throw new Error("expected an error");
};

const BUILTIN = ["agent-classifier", "blank", "cron-to-file", "watch-to-http", "webhook-to-sqlite"];

test("the five built-in templates are listed as built-in", () => {
  const { cwd, home } = fresh();
  const all = listTemplates({ cwd, home });
  expect(all.map((t) => t.name)).toEqual(BUILTIN);
  for (const t of all) {
    expect(t.source).toBe("built-in");
    expect(t.description).not.toBe("");
  }
});

for (const template of BUILTIN) {
  test(`template ${template} scaffolds and passes check with no errors or warnings`, () => {
    const { cwd, home } = fresh();
    const r = newPipeline({ name: "demo-pipe", template, cwd, home });
    expect(r.diagnostics).toEqual([]);
    expect(checkFile(join(cwd, "demo-pipe", "demo-pipe.pipo"))).toEqual([]);
    expect(r.files).toContain("demo-pipe.pipo");
    if (template !== "blank") {
      expect(r.files.some((f) => f.endsWith(".test.ts"))).toBe(true);
      expect(r.files.some((f) => f.startsWith("fixtures/"))).toBe(true);
    }
    for (const f of r.files) expect(readFileSync(join(r.dir, f), "utf8")).not.toContain("{{");
  });
}

test("templates declare secrets as env: references", () => {
  const { cwd, home } = fresh();
  newPipeline({ name: "a", template: "webhook-to-sqlite", cwd, home });
  expect(readFileSync(join(cwd, "a", "a.pipo"), "utf8")).toContain("token: env:PIPO_TOKEN");
});

test("a project template overrides a built-in; --set values and {{name}} are substituted", () => {
  const { cwd, home } = fresh();
  const dir = join(cwd, ".pipo", "templates", "blank");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "template.yaml"), "description: mine\nvariables:\n  - {name: port, prompt: Port}\n");
  writeFileSync(
    join(dir, "{{name}}.pipo.tmpl"),
    "pipo: 1\nname: {{name}}\ninput:\n  via: http\n  with: { listen: {{port}} }\noutput: { from: input, to: stdout }\n",
  );
  // a home template with the same name loses to the project one
  const homeDir = join(home, "templates", "blank");
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(join(homeDir, "template.yaml"), "description: home\n");

  const t = listTemplates({ cwd, home }).find((x) => x.name === "blank");
  expect(t).toMatchObject({ source: "project", description: "mine" });

  const r = newPipeline({ name: "mine", template: "blank", set: { port: "9001" }, cwd, home });
  expect(readFileSync(r.file, "utf8")).toContain("listen: 9001");
  expect(r.diagnostics).toEqual([]);
});

test("a home template is found, and shows as home", () => {
  const { cwd, home } = fresh();
  const dir = join(home, "templates", "greeter");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "template.yaml"), "description: hi\n");
  expect(findTemplate("greeter", { cwd, home }).source).toBe("home");
});

test("a missing variable is an error that names --set; defaults fill in otherwise", () => {
  const { cwd, home } = fresh();
  const dir = join(cwd, ".pipo", "templates", "needy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "template.yaml"),
    "variables:\n  - {name: table, prompt: Table name}\n  - {name: x, default: '{{name}}-x'}\n",
  );
  writeFileSync(
    join(dir, "{{name}}.pipo.tmpl"),
    "pipo: 1\nname: {{name}}\ninput: { via: http }\noutput: { from: input, to: stdout }\n# {{table}} {{x}}\n",
  );
  fails(() => newPipeline({ name: "p", template: "needy", cwd, home }), /needs a value for 'table'/, /--set table=/);
  expect(existsSync(join(cwd, "p"))).toBe(false);
  fails(
    () => newPipeline({ name: "p", template: "needy", set: { nope: "1" }, cwd, home }),
    /no variable 'nope'/,
    /variables: table, x/,
  );
  const r = newPipeline({ name: "p", template: "needy", set: { table: "t" }, cwd, home });
  expect(readFileSync(r.file, "utf8")).toContain("# t p-x");
});

test("an unknown placeholder names the file and writes nothing", () => {
  const { cwd, home } = fresh();
  const dir = join(cwd, ".pipo", "templates", "typo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "template.yaml"), "description: x\n");
  writeFileSync(join(dir, "{{name}}.pipo.tmpl"), "pipo: 1\nname: {{nmae}}\n");
  fails(
    () => newPipeline({ name: "p", template: "typo", cwd, home }),
    /typo\/\{\{name\}\}\.pipo\.tmpl: unknown placeholder \{\{nmae\}\}/,
    /template\.yaml/,
  );
  expect(existsSync(join(cwd, "p"))).toBe(false);
});

test("new refuses a non-empty folder, a bad name and an unknown template", () => {
  const { cwd, home } = fresh();
  mkdirSync(join(cwd, "busy"));
  writeFileSync(join(cwd, "busy", "x.txt"), "x");
  fails(() => newPipeline({ name: "busy", cwd, home }), /already exists and is not empty/, /--dir/);
  fails(() => newPipeline({ name: "Bad_Name", cwd, home }), /not a valid pipeline name/, /lowercase/);
  fails(() => newPipeline({ name: "ok", template: "nope", cwd, home }), /no template named 'nope'/, /blank/);
  mkdirSync(join(cwd, "empty"));
  expect(newPipeline({ name: "empty", cwd, home }).diagnostics).toEqual([]);
  expect(newPipeline({ name: "x", dir: "elsewhere/x", cwd, home }).dir).toBe(join(cwd, "elsewhere", "x"));
});

const PIPE = `# Top comment
pipo: 1
name: gen

input:
  via: http
  with:
    path: /gen # inline comment
  format: json

nodes:
  # first node
  one:
    from: input
    tap: log

output:
  from: one
  to: stdout
`;

function pipe() {
  const { cwd } = fresh();
  const file = join(cwd, "gen.pipo");
  writeFileSync(file, PIPE);
  return { cwd, file };
}

test("generate node inserts before the output, keeps comments and passes check", () => {
  const { cwd, file } = pipe();
  const r = generateNode({ pipeline: file, id: "shape", kind: "transform", cwd });
  expect(r.from).toBe("one");
  expect(r.output_from).toBe("shape");
  expect(r.diagnostics).toEqual([]);
  const text = readFileSync(file, "utf8");
  for (const c of ["# Top comment", "# inline comment", "# first node"]) expect(text).toContain(c);
  expect(text).toContain("  shape:\n    from: one\n    transform: map");
  expect(text).toMatch(/output:\n {2}from: shape/);
  expect(checkFile(file)).toEqual([]);
});

test("generate node works for every kind, by pipeline name", () => {
  for (const kind of ["tap", "transform", "filter", "route", "agent"]) {
    const { cwd, file } = pipe();
    const r = generateNode({ pipeline: "gen.pipo", id: "new1", kind, cwd });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    if (kind === "agent") {
      expect(existsSync(join(cwd, "schemas", "new1.schema.json"))).toBe(true);
      expect(r.diagnostics.map((d) => d.code)).toEqual(["P053"]);
    } else expect(r.diagnostics).toEqual([]);
    expect(checkFile(file).filter((d) => d.severity === "error")).toEqual([]);
  }
});

test("generate node --use each CLI agent: checks clean with no budget, 5m timeout (D67)", () => {
  for (const use of ["claude_code", "codex", "pi", "opencode"]) {
    const { cwd, file } = pipe();
    const r = generateNode({ pipeline: file, id: "ask", kind: "agent", use, cwd });
    expect(r.diagnostics).toEqual([]);
    const text = readFileSync(file, "utf8");
    expect(text).toContain(`    agent: ${use}\n`);
    expect(text).toContain("timeout: 5m");
    expect(text.includes("model: sonnet")).toBe(use === "claude_code");
  }
});

test("generate node --from a node that does not feed the output leaves the output alone and reports the dead end", () => {
  const { cwd } = pipe();
  const r = generateNode({ pipeline: "gen.pipo", id: "side", kind: "tap", from: "input", cwd });
  expect(r.output_from).toBe("one");
  expect(r.diagnostics.map((d) => d.code)).toEqual(["P021"]);
});

test("generate node creates the nodes map when the pipeline has none", () => {
  const { cwd } = fresh();
  const r = newPipeline({ name: "bare", cwd, home: join(cwd, "home") });
  const g = generateNode({ pipeline: r.file, id: "keep", kind: "filter", cwd });
  expect(g.diagnostics).toEqual([]);
  expect(readFileSync(r.file, "utf8")).toMatch(/nodes:\n {2}keep:\n {4}from: input\n {4}filter: /);
});

test("generate node refuses duplicates, bad kinds, bad ids, unknown --from and unknown variants", () => {
  const { cwd, file } = pipe();
  fails(() => generateNode({ pipeline: file, id: "one", kind: "tap", cwd }), /already exists/, /another id/);
  fails(
    () => generateNode({ pipeline: file, id: "x", kind: "sink", cwd }),
    /unknown node kind 'sink'/,
    /tap, transform/,
  );
  fails(() => generateNode({ pipeline: file, id: "input", kind: "tap", cwd }), /can't be a node id/, /reserved/);
  fails(
    () => generateNode({ pipeline: file, id: "x", kind: "tap", from: "ghost", cwd }),
    /--from 'ghost'/,
    /valid: input, one/,
  );
  fails(
    () => generateNode({ pipeline: file, id: "x", kind: "tap", use: "fax", cwd }),
    /unknown tap 'fax'/,
    /log, http/,
  );
  expect(readFileSync(file, "utf8")).toBe(PIPE);
});

test("generate node after a route can use a branch, and --from re-points only that entry of a fan-in", () => {
  const { cwd, file } = pipe();
  generateNode({ pipeline: file, id: "split", kind: "route", cwd });
  expect(readFileSync(file, "utf8")).toMatch(/output:\n {2}from: split\.main/);
  const r = generateNode({ pipeline: file, id: "after", kind: "tap", from: "split.main", cwd });
  expect(r.output_from).toBe("after");
  expect(r.diagnostics).toEqual([]);

  const text = readFileSync(file, "utf8").replace("from: after\n", "from: [after, one]\n");
  writeFileSync(file, text);
  const g = generateNode({ pipeline: file, id: "late", kind: "tap", from: "after", cwd });
  expect(g.output_from).toEqual(["late", "one"]);
});
