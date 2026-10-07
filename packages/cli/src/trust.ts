// `pipo trust` (docs/spec.md §3.6, §11, D10, D29): record that you reviewed a template's content, or re-accept a
// scaffolded project's fn modules after you edited them.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { hashDir, ORIGIN_FILE, readOrigin, readTrust, sha256, trustPath } from "@pipo/spec";
import { CliError } from "./errors";
import { findTemplate } from "./templates";

export interface TrustResult {
  kind: "template" | "project";
  template: string;
  hash: string;
  modules: string[];
  store: string;
}

export function trust(target: string, o: { cwd?: string; home?: string } = {}): TrustResult {
  const cwd = o.cwd ?? process.cwd();
  const path = resolve(cwd, target);
  const folder = existsSync(path) && statSync(path).isFile() ? dirname(path) : path;
  // A folder that carries a provenance marker is a scaffolded project; anything else names a template.
  const origin = existsSync(join(folder, ORIGIN_FILE)) ? readOrigin(folder) : undefined;
  const store = readTrust(o.home);
  const save = (hash: string, template: string) => {
    store.templates[hash] = { template, trusted_at: new Date().toISOString() };
    const file = trustPath(o.home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
    return file;
  };
  if (origin) {
    const modules: string[] = [];
    for (const rel of Object.keys(origin.modules)) {
      const file = join(folder, rel);
      if (!existsSync(file)) {
        throw new CliError(`${rel} listed in ${ORIGIN_FILE} no longer exists`, `restore it, or delete ${ORIGIN_FILE}`);
      }
      origin.modules[rel] = sha256(readFileSync(file, "utf8"));
      modules.push(rel);
    }
    writeFileSync(join(folder, ORIGIN_FILE), `${JSON.stringify(origin, null, 2)}\n`);
    return {
      kind: "project",
      template: origin.template,
      hash: origin.template_hash,
      modules: modules.map((m) => relative(cwd, join(folder, m))),
      store: save(origin.template_hash, origin.template),
    };
  }
  const t = findTemplate(target, { cwd, home: o.home });
  const hash = hashDir(t.dir);
  return { kind: "template", template: t.name, hash, modules: [], store: save(hash, t.name) };
}
