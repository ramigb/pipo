import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkFile, ORIGIN_FILE } from "@pipo/spec";
import { sandbox } from "../../runner/test/helpers";
import { main } from "../src/cli";
import { newPipeline } from "../src/new";

const sb = sandbox();
let n = 0;
const fresh = () => {
  const cwd = join(sb.root, `case-${n++}`);
  mkdirSync(cwd, { recursive: true });
  return { cwd, home: join(cwd, "home") };
};

/** A template in the home folder (outside the project) with an fn module, based on the built-in cron-to-file. */
function homeTemplate(home: string, name = "shared") {
  const dir = join(home, "templates", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "template.yaml"), "description: shared template\n");
  writeFileSync(
    join(dir, "{{name}}.pipo.tmpl"),
    "pipo: 1\nname: {{name}}\nfn: ./{{name}}.fn.ts\ninput:\n  via: schedule\n  with: { every: 1m }\nnodes:\n  x:\n    from: input\n    transform: fn.make\noutput:\n  from: x\n  to: stdout\n",
  );
  writeFileSync(join(dir, "{{name}}.fn.ts"), "export function make(data: any) { return data; }\n");
  return dir;
}

test("home template: scaffold -> P052 -> trust -> clean -> modify module -> P052 -> trust project -> clean", async () => {
  const { cwd, home } = fresh();
  homeTemplate(home);
  const r = newPipeline({ name: "demo", template: "shared", cwd, home });
  expect(existsSync(join(r.dir, ORIGIN_FILE))).toBe(true);
  expect(r.diagnostics.map((d) => d.code)).toEqual(["P052"]);
  const ds = checkFile(r.file, { home });
  expect(ds).toHaveLength(1);
  expect(ds[0]).toMatchObject({ code: "P052", severity: "error" });
  expect(ds[0]?.hint).toContain("pipo trust shared");

  expect(await main(["trust", "shared", "--home", home])).toBe(0);
  expect(JSON.parse(readFileSync(join(home, "trust.json"), "utf8")).templates).toBeDefined();
  expect(checkFile(r.file, { home })).toEqual([]);

  appendFileSync(join(r.dir, "demo.fn.ts"), "// edited\n");
  const again = checkFile(r.file, { home });
  expect(again.map((d) => d.code)).toEqual(["P052"]);
  expect(again[0]?.hint).toContain("pipo trust");

  expect(await main(["trust", r.dir, "--home", home])).toBe(0);
  expect(checkFile(r.file, { home })).toEqual([]);
});

test("changing the template content requires trusting again", async () => {
  const { cwd, home } = fresh();
  const dir = homeTemplate(home);
  await main(["trust", "shared", "--home", home]);
  const ok = newPipeline({ name: "one", template: "shared", cwd, home });
  expect(ok.diagnostics).toEqual([]);
  appendFileSync(join(dir, "{{name}}.fn.ts"), "// changed upstream\n");
  const r = newPipeline({ name: "two", template: "shared", cwd, home });
  expect(r.diagnostics.map((d) => d.code)).toEqual(["P052"]);
});

test("built-in and project templates are trusted and leave no marker", () => {
  const { cwd, home } = fresh();
  const builtin = newPipeline({ name: "a", template: "cron-to-file", cwd, home });
  expect(existsSync(join(builtin.dir, ORIGIN_FILE))).toBe(false);
  expect(builtin.diagnostics).toEqual([]);
  const local = join(cwd, ".pipo", "templates", "mine");
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, "template.yaml"), "description: mine\n");
  writeFileSync(join(local, "{{name}}.pipo.tmpl"), readFileSync(join(homeTemplate(home, "src"), "{{name}}.pipo.tmpl")));
  writeFileSync(join(local, "{{name}}.fn.ts"), "export function make(d: any) { return d; }\n");
  const r = newPipeline({ name: "b", template: "mine", cwd, home });
  expect(existsSync(join(r.dir, ORIGIN_FILE))).toBe(false);
  expect(r.diagnostics).toEqual([]);
});

test("a template given by path outside the project is untrusted; inside it is trusted", () => {
  const { cwd, home } = fresh();
  const outside = homeTemplate(join(sb.root, `elsewhere-${n}`), "ext");
  const r = newPipeline({ name: "x", template: outside, cwd, home });
  expect(r.diagnostics.map((d) => d.code)).toEqual(["P052"]);
  const inside = join(cwd, "tpl");
  mkdirSync(inside, { recursive: true });
  for (const f of ["template.yaml", "{{name}}.pipo.tmpl", "{{name}}.fn.ts"]) {
    writeFileSync(join(inside, f), readFileSync(join(outside, f)));
  }
  const r2 = newPipeline({ name: "y", template: "./tpl", cwd, home });
  expect(r2.diagnostics).toEqual([]);
});

test("a project without a marker is the user's own code", () => {
  const { cwd, home } = fresh();
  const r = newPipeline({ name: "own", template: "cron-to-file", cwd, home });
  appendFileSync(join(r.dir, "own.fn.ts"), "// mine\n");
  expect(checkFile(r.file, { home })).toEqual([]);
});

test("home template with an exec node: the .pipo is marked, untrusted until trusted, again after an edit", async () => {
  const { cwd, home } = fresh();
  const dir = join(home, "templates", "runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "template.yaml"), "description: runs a program\n");
  writeFileSync(
    join(dir, "{{name}}.pipo.tmpl"),
    "pipo: 1\nname: {{name}}\ninput: { via: push }\nnodes:\n  x: { from: input, tap: exec, with: { command: echo } }\noutput: { from: x, to: stdout }\n",
  );
  const r = newPipeline({ name: "demo", template: "runs", cwd, home });
  expect(JSON.parse(readFileSync(join(r.dir, ORIGIN_FILE), "utf8")).modules).toHaveProperty(["demo.pipo"]);
  expect(r.diagnostics.map((d) => d.code)).toEqual(["P052"]);
  expect(await main(["trust", "runs", "--home", home])).toBe(0);
  expect(checkFile(r.file, { home })).toEqual([]);
  appendFileSync(r.file, "# edited\n");
  expect(checkFile(r.file, { home }).map((d) => d.code)).toEqual(["P052"]);
  expect(await main(["trust", r.dir, "--home", home])).toBe(0);
  expect(checkFile(r.file, { home })).toEqual([]);
});
