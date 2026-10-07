// Supervisor helpers shared by launch and discovery (docs/spec.md §7.2, D27, D30, D57): the control-socket call and
// `hello` handshake, the registry names under `<home>/run`, the start options a registry entry implies, and the
// `pipo check` a file must pass before a runner is started from it.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ControlClient, gaps, type RegistryEntry, readRegistryEntry } from "@pipo/runner";
import { check, formatDiagnostic, load, type Pipeline } from "@pipo/spec";
import { EngineError } from "../errors";
import type { AttachOutcome, AttachResult, Hello, StartOptions, Supervised } from "./types";

export const DEFAULT_DRAIN = "2m";

/**
 * The start options a registry entry implies: its port, whether it runs detached, and its ttl override (D27, D30,
 * D57), so a crash restart or a discovery restart of an adopted or dead runner keeps them.
 */
export function fromEntry(entry: RegistryEntry): StartOptions {
  // A bad one is passed on as it is: the runner refuses to start with it rather than silently dropping it.
  const ttl = typeof entry.ttl === "string" ? entry.ttl : undefined;
  return { listen: entry.listen ?? undefined, detached: entry.detached === true, ...(ttl !== undefined && { ttl }) };
}

export function result(s: Supervised, outcome: AttachOutcome, message: string, hint?: string): AttachResult {
  const pid = s.proc?.pid ?? s.adopted?.pid ?? s.registry?.pid ?? null;
  return { name: s.name, outcome, pid, message, ...(hint && { hint }) };
}

/** Names with a registry entry under `<home>/run` (engine.json is the engine's own). */
export function registered(home: string): string[] {
  try {
    return readdirSync(join(home, "run"))
      .filter((f) => f.endsWith(".json") && f !== "engine.json")
      .map((f) => f.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

/** `hello` over the entry's socket, confirming pipeline, pid and version (§7.2). */
export async function handshake(
  entry: RegistryEntry,
): Promise<{ ok: true; hello: Hello } | { ok: false; why: string }> {
  if (!entry.socket) return { ok: false, why: "its registry entry names no control socket" };
  let hello: Hello;
  try {
    hello = await call<Hello>(entry.socket, "hello", {}, 2000);
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
  if (hello.pipeline !== entry.pipeline) return { ok: false, why: `its socket answers as '${hello.pipeline}'` };
  if (hello.pid !== entry.pid) return { ok: false, why: `its socket is held by pid ${hello.pid}` };
  if (hello.version !== entry.version) {
    // A version applied between reading the entry and the answer (D38) rewrites the entry too: read it again once.
    const now = readRegistryEntry(dirname(dirname(entry.socket)), entry.pipeline);
    if (now?.pid !== entry.pid || now.version !== hello.version) {
      return { ok: false, why: `it runs v${hello.version} but its registry entry says v${entry.version}` };
    }
  }
  return { ok: true, hello };
}

/** Check a pipeline file the way the runner will, so a broken file fails here instead of crash-looping. */
export function inspect(file: string): Pipeline {
  const source = readFileSync(file, "utf8");
  const diagnostics = check(source, { file });
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length) {
    throw new EngineError(
      "invalid_pipeline",
      `${file} has ${errors.length} error(s):\n${errors.map((d) => `  ${formatDiagnostic(d)}`).join("\n")}`,
      `fix them (pipo check ${file})`,
      diagnostics,
    );
  }
  const pipeline = load(source, file).value as Pipeline;
  const refused = gaps(pipeline).filter((g) => g.level === "refuse");
  if (refused.length) {
    throw new EngineError(
      "invalid_pipeline",
      `${pipeline.name} uses features the runner does not implement yet: ${refused.map((g) => `${g.feature} at ${g.path}`).join("; ")}`,
      "remove them from the pipeline for now",
    );
  }
  return pipeline;
}

export async function call<T = any>(
  socket: string,
  op: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  const client = await ControlClient.connect(socket, { connectTimeoutMs: 2000, timeoutMs });
  try {
    return await client.request<T>(op, args);
  } finally {
    client.close();
  }
}
