// Templates for `pipo new` and `pipo templates` (docs/spec.md §10.2). Built-in templates are real folders under
// packages/cli/templates/, laid out exactly like user templates: a folder with template.yaml and files that
// contain {{var}} placeholders. A file name ending in `.tmpl` loses that suffix (so `x.test.ts.tmpl` is not
// picked up as a test of this repo, and `x.pipo.tmpl` is not mistaken for a pipeline).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { CliError } from "./errors";

export type TemplateSource = "project" | "home" | "built-in" | "path";

export interface TemplateVariable {
  name: string;
  prompt?: string;
  default?: string;
}

export interface Template {
  name: string;
  source: TemplateSource;
  dir: string;
  description: string;
  variables: TemplateVariable[];
}

export const BUILTIN_DIR = join(import.meta.dir, "../templates");
const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;

import { trustHome as pipoHome } from "@pipo/spec";

export { pipoHome };

/** Templates from your own project (./.pipo/templates, built-in, or a path inside the project) are trusted; others need `pipo trust` (D29). */
export function isOutsideProject(t: Template, cwd = process.cwd()): boolean {
  if (t.source === "home") return true;
  if (t.source !== "path") return false;
  const rel = relative(resolve(cwd), t.dir);
  return rel.startsWith("..") || isAbsolute(rel);
}

interface Roots {
  cwd?: string;
  home?: string;
}

function roots(o: Roots): [TemplateSource, string][] {
  return [
    ["project", join(o.cwd ?? process.cwd(), ".pipo", "templates")],
    ["home", join(pipoHome(o.home), "templates")],
    ["built-in", BUILTIN_DIR],
  ];
}

function readTemplate(name: string, source: TemplateSource, dir: string): Template {
  const file = join(dir, "template.yaml");
  if (!existsSync(file)) {
    throw new CliError(
      `template '${name}' (${source}) has no template.yaml`,
      `add ${file} with a description and variables`,
    );
  }
  let doc: unknown;
  try {
    doc = parse(readFileSync(file, "utf8")) ?? {};
  } catch (e) {
    throw new CliError(`${file}: ${(e as Error).message.split("\n")[0]}`, "fix the YAML in template.yaml");
  }
  const d = doc as { description?: unknown; variables?: unknown };
  const variables: TemplateVariable[] = [];
  for (const v of Array.isArray(d.variables) ? d.variables : []) {
    if (!v || typeof v.name !== "string" || v.name === "name") {
      throw new CliError(
        `${file}: each variable needs a 'name' (and 'name' itself is always provided)`,
        "declare variables as: - {name: table, prompt: Table name, default: events}",
      );
    }
    variables.push({
      name: v.name,
      prompt: v.prompt === undefined ? undefined : String(v.prompt),
      default: v.default === undefined ? undefined : String(v.default),
    });
  }
  return { name, source, dir, description: typeof d.description === "string" ? d.description.trim() : "", variables };
}

/** Every template that can be used, first source winning on a repeated name. Sorted by name. */
export function listTemplates(o: Roots = {}): Template[] {
  const seen = new Map<string, Template>();
  for (const [source, root] of roots(o)) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root).sort()) {
      const dir = join(root, entry);
      if (seen.has(entry) || !statSync(dir).isDirectory()) continue;
      seen.set(entry, readTemplate(entry, source, dir));
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findTemplate(name: string, o: Roots = {}): Template {
  if (name.includes("/") || name.startsWith(".")) {
    const dir = resolve(o.cwd ?? process.cwd(), name);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new CliError(
        `no template folder at ${dir}`,
        "give a template name (see 'pipo templates') or a folder with a template.yaml",
      );
    }
    return readTemplate(basename(dir), "path", dir);
  }
  const all = listTemplates(o);
  const t = all.find((x) => x.name === name);
  if (!t) {
    throw new CliError(
      `no template named '${name}'`,
      `available: ${all.map((x) => x.name).join(", ")} (see 'pipo templates')`,
    );
  }
  return t;
}

function substitute(text: string, vars: Record<string, string>, where: string): string {
  return text.replace(PLACEHOLDER, (_, key: string) => {
    const v = vars[key];
    if (v === undefined) {
      throw new CliError(
        `${where}: unknown placeholder {{${key}}}`,
        `declare '${key}' under variables: in template.yaml, or use one of: ${Object.keys(vars).join(", ")}`,
      );
    }
    return v;
  });
}

export function resolveVariables(t: Template, name: string, set: Record<string, string>): Record<string, string> {
  const known = new Set(t.variables.map((v) => v.name));
  for (const key of Object.keys(set)) {
    if (!known.has(key)) {
      throw new CliError(
        `template '${t.name}' has no variable '${key}'`,
        known.size ? `variables: ${[...known].join(", ")}` : "this template has no variables",
      );
    }
  }
  const vars: Record<string, string> = { name };
  for (const v of t.variables) {
    const value =
      set[v.name] ?? (v.default === undefined ? undefined : substitute(v.default, vars, `${t.name}/template.yaml`));
    if (value === undefined) {
      throw new CliError(
        `template '${t.name}' needs a value for '${v.name}'${v.prompt ? ` (${v.prompt})` : ""}`,
        `pass --set ${v.name}=<value>`,
      );
    }
    vars[v.name] = value;
  }
  return vars;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Render a template into `target` (created if missing). Returns the relative paths written. */
export function scaffold(t: Template, target: string, vars: Record<string, string>): string[] {
  // Render everything first so a bad placeholder leaves nothing half-written.
  const files: [string, string][] = [];
  for (const src of walk(t.dir)) {
    const rel = relative(t.dir, src);
    if (rel === "template.yaml") continue;
    const outRel = substitute(rel, vars, `${t.name}/${rel}`).replace(/\.tmpl$/, "");
    files.push([outRel, substitute(readFileSync(src, "utf8"), vars, `${t.name}/${rel}`)]);
  }
  for (const [rel, content] of files) {
    const path = join(target, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return files.map(([rel]) => rel);
}
