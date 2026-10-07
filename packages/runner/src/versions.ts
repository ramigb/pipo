// Pipeline versions (docs/spec.md §7.3, §9.3, D38): which definition a start runs, and what a live apply may change.
// A start runs the .pipo file only when its content changed since the last start; otherwise the journal's latest
// version stays, so a rollback outlives a restart. A live apply (rollback) may change anything a new packet reads
// from its own version; what the runner binds once at start (input, output connector, secrets, workers, timers)
// needs a restart.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { load, type Pipeline } from "@pipo/spec";
import { type FileHashes, openReadonly } from "./journal";
import { hashFileContent, loadedModuleHash } from "./plan";

export const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

/** What a start runs and what it will record (Journal.commitStart). */
export interface StartPlan {
  /** The source to check and run, and its content hash. */
  source: string;
  hash: string;
  /** The file's content hash, recorded so the next start can tell whether the file changed (D38). */
  fileHash: string;
  /** Set when the source is the journal's latest version rather than the file (the file is unchanged, D38). */
  fromJournal: { version: number; author: string; reason: string | null } | null;
  /** The journal's latest version when the plan was made (null for a new journal). */
  latest: number | null;
  /** A new version to append (the file), or null to run `latest` as it is. */
  append: { hash: string; source: string; reason: string } | null;
}

interface Peek {
  latest: { version: number; hash: string; source: string; author: string; reason: string | null } | null;
  fileHash: string | null;
}

/** Read what a start needs from an existing journal, read-only, so nothing is written before the start lock. */
function peek(path: string): Peek {
  if (!existsSync(path)) return { latest: null, fileHash: null };
  const db = openReadonly(path);
  try {
    const tables = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name),
    );
    if (!tables.has("versions")) return { latest: null, fileHash: null };
    const reason = (db.query("PRAGMA table_info(versions)").all() as { name: string }[]).some(
      (c) => c.name === "reason",
    );
    const latest = db
      .query(
        `SELECT version, hash, source, author, ${reason ? "reason" : "NULL AS reason"} FROM versions ORDER BY version DESC LIMIT 1`,
      )
      .get() as Peek["latest"];
    const fileHash = tables.has("meta")
      ? ((db.query("SELECT value FROM meta WHERE key = 'file_hash'").get() as { value: string } | null)?.value ?? null)
      : null;
    return { latest, fileHash };
  } finally {
    db.close();
  }
}

/**
 * Decide what a start runs (D38). The file wins when it is new to the journal or its content changed since the last
 * start (a journal from before D38 has no record of that, so the file wins, as it always did); otherwise the latest
 * version stays, which is the file's own unless a rollback was applied since. A file whose content equals the latest
 * version adds nothing.
 */
export function planStart(home: string, file: string, fileSource: string): StartPlan {
  const hash = sha256(fileSource);
  const name = pipelineName(fileSource, file);
  const fresh = (reason: string): StartPlan => ({
    source: fileSource,
    hash,
    fileHash: hash,
    fromJournal: null,
    latest: null,
    append: { hash, source: fileSource, reason },
  });
  if (!name) return fresh("first start");
  const { latest, fileHash: lastFileHash } = peek(join(home, "pipelines", name, "journal.db"));
  if (!latest) return fresh("first start");
  if (latest.hash === hash) {
    return { source: fileSource, hash, fileHash: hash, fromJournal: null, latest: latest.version, append: null };
  }
  if (lastFileHash === hash) {
    return {
      source: latest.source,
      hash: latest.hash,
      fileHash: hash,
      fromJournal: { version: latest.version, author: latest.author, reason: latest.reason },
      latest: latest.version,
      append: null,
    };
  }
  return { ...fresh("file changed"), latest: latest.version };
}

function pipelineName(source: string, file: string): string | null {
  try {
    const name = (load(source, file).value as Partial<Pipeline> | undefined)?.name;
    return typeof name === "string" && /^[a-z0-9][a-z0-9_-]*$/i.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** JSON with sorted keys, so two definitions compare by content, not key order. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * The parts of `next` that differ from `current` but are bound when the runner starts, so a live apply can't change
 * them: the input connector (everything but `schema`, `validate` and `on_invalid`, which each packet reads from its
 * version), the output connector, secrets, worker count, lifetime timers and stall detection.
 */
export function boundChanges(current: Pipeline, next: Pipeline): string[] {
  const out: string[] = [];
  const differ = (a: unknown, b: unknown) => canon(a) !== canon(b);
  if (current.name !== next.name) out.push("name");
  const { schema: _a, validate: _b, on_invalid: _c, ...inA } = current.input;
  const { schema: _d, validate: _e, on_invalid: _f, ...inB } = next.input;
  for (const k of [...new Set([...Object.keys(inA), ...Object.keys(inB)])].sort()) {
    if (differ((inA as Record<string, unknown>)[k], (inB as Record<string, unknown>)[k])) out.push(`input.${k}`);
  }
  if (current.output.to !== next.output.to) out.push("output.to");
  if (differ(current.secrets ?? {}, next.secrets ?? {})) out.push("secrets");
  if ((current.concurrency ?? 4) !== (next.concurrency ?? 4)) out.push("concurrency");
  if (differ(current.lifetime ?? {}, next.lifetime ?? {})) out.push("lifetime");
  if (differ(current.delivered?.stall ?? null, next.delivered?.stall ?? null)) out.push("delivered.stall");
  return out;
}

// ── referenced files (D60) ───────────────────────────────────────────────────

/**
 * The files a definition refers to, as written (relative to its folder): the `fn` module, `input.schema` and each
 * agent node's literal `with.schema`, the references `pipo check` resolves (P012, P014, P054).
 */
export function referencedFiles(p: Pipeline): string[] {
  const out = new Set<string>();
  if (typeof p.fn === "string") out.add(p.fn);
  if (typeof p.input?.schema === "string") out.add(p.input.schema);
  for (const n of Object.values(p.nodes ?? {})) {
    const s = n.agent !== undefined ? n.with?.schema : undefined;
    if (typeof s === "string" && !s.includes("${")) out.add(s);
  }
  return [...out].sort();
}

/**
 * The hashes of the files a version of `p` runs with in this process: the `fn` module as this process loaded it
 * (a module is imported once), else as it is on disk; schema files as they are on disk (each plan reads them).
 * A file that can't be read is left out (`pipo check` refuses a definition whose files are missing).
 */
export function runningFileHashes(p: Pipeline, dir: string): FileHashes {
  const out: FileHashes = {};
  for (const f of referencedFiles(p)) {
    const path = resolve(dir, f);
    const h = (f === p.fn ? loadedModuleHash(path) : undefined) ?? hashFileContent(path);
    if (h) out[f] = h;
  }
  return out;
}

/** A warning about the files a version runs with (D60): not a refusal, the version runs. */
export interface VersionWarning {
  /** `file_changed`: a version's recorded file differs from the one it runs with now. `module_not_reloaded`: the fn
   *  module changed on disk since this process loaded it, so the loaded one keeps running until a restart. */
  code: "file_changed" | "module_not_reloaded";
  /** The file as written in the definition. */
  file: string;
  /** The version whose recorded file differs (`file_changed`) or that runs the loaded module (`module_not_reloaded`). */
  version: number;
  /** sha256 recorded with that version, or loaded by this process. */
  recorded: string;
  /** sha256 of the file it runs with now (`file_changed`) or on disk (`module_not_reloaded`); null when unreadable. */
  current: string | null;
  message: string;
  hint: string;
}

const short = (h: string | null) => (h ? `${h.slice(0, 12)}` : "missing");

/**
 * Compare the files `recorded` with version `of` against those `runs` (D60). `as` names the version that runs them
 * when it is not `of` itself (a rollback runs v<of>'s source as a new version). Versions from before D60 recorded
 * nothing, so there is nothing to compare.
 */
export function fileChanges(
  recorded: FileHashes | null,
  runs: FileHashes,
  of: number,
  pipeline: string,
  as?: { version: number; what: string },
): VersionWarning[] {
  if (!recorded) return [];
  const out: VersionWarning[] = [];
  for (const [file, was] of Object.entries(recorded).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const now = runs[file] ?? null;
    if (now === was) continue;
    const who = as ? `v${as.version} (${as.what})` : `v${of}`;
    out.push({
      code: "file_changed",
      file,
      version: of,
      recorded: was,
      current: now,
      message: `${file} has changed since v${of} was recorded (sha256 ${short(was)}, now ${short(now)}), so ${who} runs the file as it is now, not v${of}'s`,
      hint: `if v${of}'s ${file} is what you want, restore it (e.g. from version control) and restart (pipo restart ${pipeline}); if the new file is intended, nothing to do: a changed .pipo file records the files it runs with as a new version`,
    });
  }
  return out;
}

/** The fn module this process loaded, when the file on disk has changed since (D60). */
export function staleModule(p: Pipeline, dir: string, version: number): VersionWarning[] {
  if (typeof p.fn !== "string") return [];
  const path = resolve(dir, p.fn);
  const loaded = loadedModuleHash(path);
  if (!loaded) return [];
  const disk = hashFileContent(path) ?? null;
  if (disk === loaded) return [];
  return [
    {
      code: "module_not_reloaded",
      file: p.fn,
      version,
      recorded: loaded,
      current: disk,
      message: `${p.fn} has changed on disk since this runner loaded it (sha256 ${short(loaded)}, now ${short(disk)}); v${version} runs the loaded module: a runner loads its fn module once`,
      hint: `restart to load the file as it is now (pipo restart ${p.name})`,
    },
  ];
}
