// `pipo new` (docs/spec.md §10.2): scaffold a pipeline folder from a template, then check it.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { checkFile, type Diagnostic, hashDir, ORIGIN_FILE, type Origin, sha256 } from "@pipo/spec";
import { parse } from "yaml";
import { CliError } from "./errors";
import { findTemplate, isOutsideProject, resolveVariables, scaffold } from "./templates";

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface NewOptions {
  name: string;
  template?: string;
  dir?: string;
  set?: Record<string, string>;
  cwd?: string;
  home?: string;
}

export interface NewResult {
  dir: string;
  template: string;
  file: string;
  files: string[];
  diagnostics: Diagnostic[];
}

export function newPipeline(o: NewOptions): NewResult {
  if (!NAME.test(o.name)) {
    throw new CliError(
      `'${o.name}' is not a valid pipeline name`,
      "use lowercase letters, digits and hyphens, starting with a letter or digit (e.g. people-intake)",
    );
  }
  const cwd = o.cwd ?? process.cwd();
  const dir = resolve(cwd, o.dir ?? o.name);
  if (existsSync(dir) && (!statSync(dir).isDirectory() || readdirSync(dir).length > 0)) {
    throw new CliError(
      `${dir} already exists and is not empty`,
      "pick another name, or use --dir with an empty folder",
    );
  }
  const t = findTemplate(o.template ?? "blank", { cwd, home: o.home });
  const vars = resolveVariables(t, o.name, o.set ?? {});
  const files = scaffold(t, dir, vars);
  const file = join(dir, `${o.name}.pipo`);
  if (!existsSync(file)) {
    throw new CliError(
      `template '${t.name}' produced no ${o.name}.pipo`,
      "a template needs a '{{name}}.pipo.tmpl' file at its top level",
    );
  }
  if (isOutsideProject(t, cwd)) writeOrigin(t.name, t.dir, dir, file);
  const diagnostics = checkFile(file, { home: o.home });
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length && t.source === "built-in") {
    throw new CliError(
      `built-in template '${t.name}' does not pass pipo check (${errors[0]?.code}: ${errors[0]?.message})`,
      "this is a bug in Pipo's templates; please report it",
    );
  }
  return { dir, template: t.name, file, files, diagnostics };
}

/** Mark the fn module, and the .pipo file when it runs programs (exec, D71), of a project scaffolded from a template outside the project (D29). */
function writeOrigin(template: string, templateDir: string, dir: string, file: string) {
  let doc: { fn?: unknown; nodes?: Record<string, { tap?: unknown; transform?: unknown }> } | null;
  try {
    doc = parse(readFileSync(file, "utf8"));
  } catch {
    return;
  }
  const modules: Record<string, string> = {};
  const module = typeof doc?.fn === "string" ? resolve(dir, doc.fn) : undefined;
  if (module && existsSync(module)) modules[relative(dir, module)] = sha256(readFileSync(module, "utf8"));
  if (Object.values(doc?.nodes ?? {}).some((n) => n?.tap === "exec" || n?.transform === "exec"))
    modules[relative(dir, file)] = sha256(readFileSync(file, "utf8"));
  if (!Object.keys(modules).length) return;
  const origin: Origin = { template, template_hash: hashDir(templateDir), modules };
  writeFileSync(join(dir, ORIGIN_FILE), `${JSON.stringify(origin, null, 2)}\n`);
}
