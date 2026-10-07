// Compile a checked pipeline definition into what the runner executes: the step graph, the
// loaded user functions and an input-schema validator. One plan per pipeline version, so
// in-flight packets finish on the version that accepted them (docs/spec.md §7.3).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { asList, FN_REF, type Pipeline } from "@pipo/spec";
import Ajv from "ajv";
import { OUTPUT_STEP } from "./journal";

/** sha256 of a file's bytes, or undefined when it can't be read. */
export function hashFileContent(path: string): string | undefined {
  try {
    return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

export type UserFn = (data: unknown, meta: Record<string, unknown>) => unknown;

export interface Plan {
  version: number;
  pipeline: Pipeline;
  /** Directory of the .pipo file; relative paths resolve from here. */
  dir: string;
  /**
   * Source ref (`input`, node id, `route.branch`) → the steps that consume it, in file order (nodes,
   * then the output). More than one is a fan-out: each consumer gets its own copy (spec §3.4, D22).
   */
  next: Map<string, string[]>;
  fns: Record<string, UserFn>;
  validateInput?: (data: unknown) => string | null;
  /** Agent node id → its output schema (`with.schema`, spec §3.4) and a validator returning an error or null. */
  agentSchemas: Record<
    string,
    { path: string; schema: Record<string, unknown>; validate: (v: unknown) => string | null }
  >;
}

/** Compile a JSON Schema file with ajv; `$schema` is dropped so draft-07 and 2020-12 files both load. */
function schemaValidator(ajv: Ajv, file: string) {
  const schema = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = schema;
  const validate = ajv.compile(rest);
  return {
    schema,
    validate: (data: unknown) =>
      validate(data)
        ? null
        : (validate.errors ?? [])
            .slice(0, 3)
            .map((e) => `${e.instancePath || "data"} ${e.message}`)
            .join("; "),
  };
}

/**
 * The sha256 of each fn module as this process first imported it, by absolute path (D60). A process imports a module
 * once (later imports return the cached one), so this, not the file on disk, is the code its plans run.
 */
const loadedModules = new Map<string, string>();

/** The hash of the fn module at `path` as this process loaded it, or undefined when it hasn't (D60). */
export const loadedModuleHash = (path: string): string | undefined => loadedModules.get(path);

export async function compile(pipeline: Pipeline, version: number, dir: string): Promise<Plan> {
  const next = new Map<string, string[]>();
  const link = (ref: string, step: string) => {
    const list = next.get(ref) ?? [];
    if (!list.includes(step)) list.push(step);
    next.set(ref, list);
  };
  for (const [id, node] of Object.entries(pipeline.nodes ?? {})) for (const ref of asList(node.from)) link(ref, id);
  for (const ref of asList(pipeline.output.from)) link(ref, OUTPUT_STEP);

  const fns: Record<string, UserFn> = {};
  const used = Object.values(pipeline.nodes ?? {})
    .flatMap((n) => [n.tap, n.transform])
    .filter((v): v is string => !!v && FN_REF.test(v));
  if (used.length) {
    if (!pipeline.fn) throw new Error("pipeline uses fn.* but declares no fn module");
    const path = resolve(dir, pipeline.fn);
    const first = loadedModules.has(path) ? undefined : hashFileContent(path);
    const mod = (await import(path)) as Record<string, unknown>;
    if (first && !loadedModules.has(path)) loadedModules.set(path, first);
    for (const ref of used) {
      const name = (FN_REF.exec(ref) as RegExpExecArray)[1] as string;
      if (typeof mod[name] !== "function") throw new Error(`${pipeline.fn} does not export a function '${name}'`);
      fns[ref] = mod[name] as UserFn;
    }
  }

  let validateInput: Plan["validateInput"];
  if (pipeline.input.schema) {
    const schema = JSON.parse(readFileSync(resolve(dir, pipeline.input.schema), "utf8"));
    const validate = new Ajv({ allErrors: false, strict: false }).compile(schema);
    validateInput = (data) =>
      validate(data) ? null : `${validate.errors?.[0]?.instancePath || "data"} ${validate.errors?.[0]?.message}`;
  }
  const agentSchemas: Plan["agentSchemas"] = {};
  const ajv = new Ajv({ allErrors: true, strict: false });
  for (const [id, node] of Object.entries(pipeline.nodes ?? {})) {
    if (node.agent === undefined) continue;
    const path = String(node.with?.schema);
    try {
      agentSchemas[id] = { path, ...schemaValidator(ajv, resolve(dir, path)) };
    } catch (e) {
      throw new Error(`agent node '${id}': schema ${path} can't be used: ${(e as Error).message}`);
    }
  }
  return { version, pipeline, dir, next, fns, validateInput, agentSchemas };
}
