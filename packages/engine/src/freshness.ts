// Has the engine's code changed on disk since it started? (docs/spec.md §8, D64) The engine loads its code (engine,
// runner and spec sources) once, but serves the dashboard's files fresh on every request, and an open dashboard keeps
// it awake (D61). After an update the page can be newer than the engine behind it; this tells them apart, so the
// dashboard and `pipo ui` can say "restart the engine". A stamp is the path, size and mtime of every source file.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Re-stat the sources at most this often; the engine's status route is polled. */
const EVERY_MS = 5000;

/** The source folders this engine runs from: engine, runner and spec `src/`, where they exist (a monorepo checkout). */
export function codeRoots(): string[] {
  const packages = new URL("../..", import.meta.url).pathname;
  return ["engine", "runner", "spec"].map((p) => join(packages, p, "src")).filter((d) => existsSync(d));
}

function stamp(roots: string[]): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (st.isDirectory()) walk(path);
        else if (/\.(ts|js|json)$/.test(name)) parts.push(`${path}:${st.size}:${st.mtimeMs}`);
      } catch {
        parts.push(`${path}:gone`);
      }
    }
  };
  for (const root of roots) walk(root);
  return String(Bun.hash(parts.join("\n")));
}

export class CodeStamp {
  private readonly loaded: string;
  private checkedAt = 0;
  private changed = false;

  constructor(private readonly roots: string[] = codeRoots()) {
    this.loaded = stamp(roots);
  }

  /** True once any source file was added, removed or edited since the engine started (checked at most every 5 s). */
  get stale(): boolean {
    if (this.changed) return true;
    const now = Date.now();
    if (now - this.checkedAt < EVERY_MS) return false;
    this.checkedAt = now;
    this.changed = stamp(this.roots) !== this.loaded;
    return this.changed;
  }
}
