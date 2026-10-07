// Trust for `fn` modules that arrive through templates (docs/spec.md §3.6, §11, D10, D29).
// A scaffolded project carries a provenance marker next to its fn module; `pipo trust` records the template's
// content hash in <home>/trust.json; `pipo check` reads both and reports P052 for untrusted modules.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

export const ORIGIN_FILE = ".pipo-origin.json";

export interface Origin {
  template: string;
  /** Content hash of the template when the project was scaffolded (see `hashDir`). */
  template_hash: string;
  /** fn module path (relative to the marker's folder) -> sha256 of its content as scaffolded or last trusted. */
  modules: Record<string, string>;
}

export interface TrustStore {
  version: 1;
  /** template content hash -> who/what was trusted. */
  templates: Record<string, { template: string; trusted_at: string }>;
}

export function trustHome(home?: string): string {
  return home ?? process.env.PIPO_HOME ?? join(homedir(), ".pipo");
}

export const trustPath = (home?: string) => join(trustHome(home), "trust.json");

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Hash of every file under `dir` (sorted relative paths and contents). Any change to a template changes it. */
export function hashDir(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const entry of readdirSync(d).sort()) {
      const path = join(d, entry);
      if (statSync(path).isDirectory()) walk(path);
      else
        h.update(`${relative(dir, path)}\0`)
          .update(readFileSync(path))
          .update("\0");
    }
  };
  walk(dir);
  return h.digest("hex");
}

export function readTrust(home?: string): TrustStore {
  const file = trustPath(home);
  if (!existsSync(file)) return { version: 1, templates: {} };
  try {
    const t = JSON.parse(readFileSync(file, "utf8")) as Partial<TrustStore>;
    return { version: 1, templates: t.templates ?? {} };
  } catch {
    return { version: 1, templates: {} };
  }
}

export function readOrigin(dir: string): Origin | undefined {
  const file = join(dir, ORIGIN_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const o = JSON.parse(readFileSync(file, "utf8")) as Origin;
    return o && typeof o.template_hash === "string" && o.modules && typeof o.modules === "object" ? o : undefined;
  } catch {
    return undefined;
  }
}

/** Why a module is untrusted, or undefined when it is the user's own code or has been trusted. */
export function untrustedReason(
  dir: string,
  moduleRel: string,
  moduleContent: string,
  home?: string,
  what = "function module",
): { message: string; hint: string } | undefined {
  const origin = readOrigin(dir);
  const recorded = origin?.modules[moduleRel];
  if (!origin || recorded === undefined) return undefined;
  if (recorded !== sha256(moduleContent)) {
    return {
      message: `${what} '${moduleRel}' changed since it came from template '${origin.template}' and is untrusted`,
      hint: `review it, then run \`pipo trust ${dir}\``,
    };
  }
  if (!readTrust(home).templates[origin.template_hash]) {
    return {
      message: `${what} '${moduleRel}' comes from template '${origin.template}', which is not trusted`,
      hint: `read the template, then run \`pipo trust ${origin.template}\``,
    };
  }
  return undefined;
}
