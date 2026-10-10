// The builder's pipeline model (docs/spec.md §3, §8): plain operations on a parsed `.pipo` value (the object
// `pipo check` sees), so the canvas never holds YAML. Pure: no DOM, no fetch; every operation returns a new value
// and leaves its argument untouched. The engine turns the value back into YAML (`POST /api/builder/check`).

export const ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;
export const RESERVED = new Set(["input", "output"]);
export const NODE_KINDS = ["tap", "transform", "filter", "route", "agent"];

const clone = (v) => (v === undefined ? v : structuredClone(v));
const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
/** `from` back in its tidy form: a string for one ref, a list for several. */
const tidy = (list) => (list.length === 1 ? list[0] : list);

/** `node` or `node.branch` as {node, branch}. */
export function parseRef(ref) {
  const i = String(ref).indexOf(".");
  return i < 0 ? { node: ref, branch: null } : { node: ref.slice(0, i), branch: ref.slice(i + 1) };
}
export const refOf = (node, branch) => (branch ? `${node}.${branch}` : node);

/** A fresh pipeline: packets pushed in, printed out. */
export function blankPipeline(name = "my-pipeline") {
  return {
    pipo: 1,
    name,
    description: "Made with the Pipo builder ✨",
    input: { via: "push" },
    output: { from: "input", to: "stdout", with: { format: "jsonl" } },
  };
}

/** The inputs as [name, input] in file order: `input:` is the one input named `input` (§3.3.1, D76). */
export function inputsOf(p) {
  if (p?.inputs && typeof p.inputs === "object") return Object.entries(p.inputs);
  return p?.input ? [["input", p.input]] : [];
}

/** Whether `id` names one of the pipeline's inputs. */
export const isInput = (p, id) => inputsOf(p).some(([n]) => n === id);

/** Where input `name` lives in the value: `["input"]` for the shorthand, else `["inputs", name]`. */
export const inputPath = (p, name) => (p?.inputs ? ["inputs", name] : ["input"]);

/** Input `name`'s block, or undefined. */
export const inputOf = (p, name) => inputsOf(p).find(([n]) => n === name)?.[1];

/** The first input's name, where a new block takes its packets from by default. */
export const firstInput = (p) => inputsOf(p)[0]?.[0] ?? "input";

/** The kind of a node value (`tap`, `transform`, …), or null. */
export const kindOf = (node) => NODE_KINDS.find((k) => node?.[k] !== undefined) ?? null;

/** What a node is made of, for labels: `log`, `map`, `fn.clean`, a filter's expression, a route's branch count. */
export function connectorOf(node) {
  const k = kindOf(node);
  if (!k) return null;
  if (k === "filter") return "filter";
  if (k === "route") return "route";
  return String(node[k]);
}

/** Every block on the canvas, in definition order: the inputs, the nodes, output. */
export function blocks(p) {
  const out = inputsOf(p).map(([id, i]) => ({ id, kind: "input", connector: i?.via ?? null, from: [] }));
  for (const [id, n] of Object.entries(p.nodes ?? {})) {
    out.push({
      id,
      kind: kindOf(n) ?? "node",
      connector: connectorOf(n),
      from: asList(n.from).map(parseRef),
      loop: n.loop ?? null,
    });
  }
  if (p.output)
    out.push({
      id: "output",
      kind: "output",
      connector: p.output.to ?? null,
      from: asList(p.output.from).map(parseRef),
    });
  return out;
}

/** Edges as {from, branch, to, ref}; `to` is a node id or `output`. */
export function edges(p) {
  const out = [];
  for (const b of blocks(p))
    for (const f of b.from) out.push({ from: f.node, branch: f.branch, to: b.id, ref: refOf(f.node, f.branch) });
  return out;
}

/** The out-ports of a block: a route's branches, nothing for the output, one plain port otherwise. */
export function outPorts(p, id) {
  if (id === "output") return [];
  if (isInput(p, id)) return [null];
  const n = p.nodes?.[id];
  if (n?.route && typeof n.route === "object") return Object.keys(n.route);
  return [null];
}

const target = (p, to) => (to === "output" ? p.output : p.nodes?.[to]);

/** A new id from `base` that no node uses yet (`map`, `map_2`, …). */
export function freshId(p, base) {
  let stem = String(base || "node")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/^[^A-Za-z_]+/, "");
  if (!stem || RESERVED.has(stem)) stem = `${stem || "node"}_1`;
  // Inputs and nodes share one set of names (P061).
  const taken = new Set([...Object.keys(p.nodes ?? {}), ...inputsOf(p).map(([n]) => n), ...RESERVED]);
  if (!taken.has(stem)) return stem;
  for (let i = 2; ; i++) if (!taken.has(`${stem}_${i}`)) return `${stem}_${i}`;
}

/**
 * A new agent node's model: the API's model id, Claude Code's alias. Other CLIs use their own default unless the
 * builder passes a model it knows they offer (D67).
 */
export const STARTER_MODEL = { claude_api: "claude-sonnet-5-5", claude_code: "sonnet" };

/** Starter values for a new node, so it passes `pipo check` where it can and shows how it's meant to be filled. */
export function starterNode(kind, connector, opts = {}) {
  switch (kind) {
    case "filter":
      return { filter: "data != null" };
    case "route":
      return { route: { yes: "data.ok == true", no: "else" } };
    case "agent": {
      const agent = connector || "claude_api";
      const model = opts.model ?? STARTER_MODEL[agent];
      return {
        agent,
        with: { ...(model ? { model } : {}), prompt: "Summarise this: ${data}", schema: "./summary.schema.json" },
      };
    }
    case "tap":
      if (connector === "http")
        return { tap: "http", with: { url: "https://example.com/hook", method: "POST", body: "${data}" } };
      if (connector === "file") return { tap: "file", with: { path: "./tap.jsonl", format: "jsonl" } };
      if (connector === "emit") return { tap: "emit", with: { event: "hello" } };
      if (connector === "telegram") return { tap: "telegram", with: { chat_id: 0, text: "got a packet: ${data}" } };
      if (connector === "exec") return { tap: "exec", with: { command: "echo", args: ["${data}"] } };
      return { tap: connector || "log", with: { message: "got a packet: ${data}" } };
    case "transform":
      if (connector === "http")
        return { transform: "http", with: { url: "https://example.com/api", method: "POST", body: "${data}" } };
      if (connector === "exec")
        return { transform: "exec", with: { command: "echo", args: ["${data}"], result: "text" } };
      if (connector?.startsWith("fn.")) return { transform: connector };
      return { transform: "map", with: { data: { value: "${data}", at: "${iso(now())}" } } };
    default:
      return {};
  }
}

export const starterInput = (via) =>
  ({
    http: { via: "http", with: { path: "/" } },
    schedule: { via: "schedule", with: { every: "1m" } },
    watch: { via: "watch", with: { path: "./inbox" } },
    system: { via: "system", with: { every: "30s", metrics: ["cpu", "memory"] } },
    telegram: { via: "telegram" },
    pipeline: { via: "pipeline", with: { from: ["other-pipeline"] } },
  })[via] ?? { via };

export function starterOutput(to, name = "pipeline") {
  switch (to) {
    case "file":
      return { to, with: { path: `./${name}.jsonl`, format: "jsonl" } };
    case "sqlite":
      return { to, with: { path: `./${name}.db`, table: "items", create: true } };
    case "http":
      return { to, with: { url: "https://example.com/ingest", method: "POST", body: "${data}" } };
    case "telegram":
      return { to, with: { text: "${data.text}" } };
    case "pipeline":
      return { to, with: { pipeline: "next-pipeline" } };
    default:
      return { to, with: { format: "jsonl" } };
  }
}

/** Add a node; returns {p, id}. */
export function addNode(p, kind, connector, from, opts = {}) {
  const next = clone(p);
  const id = freshId(
    next,
    connector && !connector.startsWith("fn.") && kind !== "filter" && kind !== "route" ? connector : kind,
  );
  const node = { ...(from ? { from } : { from: firstInput(next) }), ...starterNode(kind, connector, opts) };
  next.nodes = { ...(next.nodes ?? {}), [id]: node };
  return { p: next, id };
}

/**
 * Give an agent node another provider (D67). The `with:` keys the new one also takes (prompt, schema, timeout, …)
 * stay and the others go (max_tokens for a CLI agent; cwd and allow_tools for the API). The model becomes `model`,
 * else the provider's starter model, else none (a CLI agent then uses its own default).
 */
export function switchAgent(p, id, agent, withSchema, model) {
  const node = p.nodes?.[id];
  if (!node) return p;
  const next = clone(p);
  const allowed = new Set(Object.keys(withSchema?.properties ?? {}));
  const kept = Object.entries(node.with ?? {}).filter(([k]) => k !== "model" && allowed.has(k));
  const m = model ?? STARTER_MODEL[agent];
  next.nodes[id].agent = agent;
  next.nodes[id].with = Object.fromEntries([...(m && allowed.has("model") ? [["model", m]] : []), ...kept]);
  return next;
}

/** Replace input `name`'s connector, keeping what still applies (format, schema, validate). */
export function setInput(p, via, name = firstInput(p)) {
  if (!isInput(p, name) && inputsOf(p).length) return p;
  const next = clone(p);
  const { with: _w, via: _v, ...rest } = inputOf(next, name) ?? {};
  const value = { ...starterInput(via), ...rest };
  if (next.inputs) next.inputs[name] = value;
  else next.input = value;
  return next;
}

/**
 * Add an input (D76); returns {p, id}. A pipeline with one `input:` moves to `inputs:`, its input keeping the name
 * `input`, so every `from: input` still holds.
 */
export function addInput(p, via) {
  const next = p.inputs || !p.input ? clone(p) : toInputsMap(clone(p));
  const id = freshId(next, via === "http" ? "webhook" : via);
  next.inputs = { ...(next.inputs ?? {}), [id]: starterInput(via) };
  return { p: next, id };
}

/**
 * Remove an input and the edges out of it. The last input stays (a pipeline needs one), and when one input named
 * `input` is left, the file goes back to `input:` (D76).
 */
export function removeInput(p, id) {
  if (!p.inputs || !(id in p.inputs) || Object.keys(p.inputs).length < 2) return p;
  let next = clone(p);
  delete next.inputs[id];
  next = dropRefs(next, id);
  const names = Object.keys(next.inputs);
  if (names.length === 1 && names[0] === "input") {
    const entries = Object.entries(next).map(([k, v]) => (k === "inputs" ? ["input", v.input] : [k, v]));
    next = Object.fromEntries(entries);
  }
  return next;
}

/** `input:` written as `inputs: {input: …}`, in the place `input` had. */
function toInputsMap(p) {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => (k === "input" ? ["inputs", { input: v }] : [k, v])));
}

/** Every ref to block `id` gone: from lists (a node left with none loses `from`), loop targets on it. */
function dropRefs(next, id) {
  const drop = (from) => asList(from).filter((r) => parseRef(r).node !== id);
  for (const n of Object.values(next.nodes ?? {})) {
    const kept = drop(n.from);
    n.from = kept.length ? tidy(kept) : undefined;
    if (n.from === undefined) delete n.from;
    if (n.loop?.back_to === id) delete n.loop;
  }
  if (next.output) {
    const kept = drop(next.output.from);
    next.output.from = kept.length ? tidy(kept) : undefined;
    if (next.output.from === undefined) delete next.output.from;
  }
  return next;
}

/** Replace the output connector, keeping its `from`, batch and policies. */
export function setOutput(p, to) {
  const next = clone(p);
  const { with: _w, to: _t, ...rest } = next.output ?? {};
  next.output = { ...rest, ...starterOutput(to, next.name) };
  if (next.output.from === undefined) next.output.from = firstInput(next);
  // keep `from` first, as people write it
  const { from, ...others } = next.output;
  next.output = { from, ...others };
  return next;
}

/** Remove a node and every edge into or out of it (refs to it, loop targets on it). */
export function removeNode(p, id) {
  if (isInput(p, id)) return removeInput(p, id);
  if (RESERVED.has(id) || !p.nodes?.[id]) return p;
  const next = clone(p);
  delete next.nodes[id];
  dropRefs(next, id);
  if (!Object.keys(next.nodes).length) delete next.nodes;
  return next;
}

/** Why `id` can't be the new name of `old`, or null. */
export function renameProblem(p, old, id) {
  if (id === old) return null;
  if (!ID.test(id)) return "use letters, digits, _ and -, starting with a letter or _";
  if (RESERVED.has(id)) return "'input' and 'output' are taken by the pipeline's ends";
  if (p.nodes?.[id]) return `there is already a node called '${id}'`;
  if (isInput(p, id)) return `there is already an input called '${id}'`;
  return null;
}

/** Rename a node, keeping its place in the file and every ref to it (`old`, `old.branch`, loop targets). */
export function renameNode(p, old, id) {
  // Renaming the `input:` shorthand's input moves it into `inputs:` under its new name (D76).
  if (!p.inputs && p.input && old === "input" && old !== id && !renameProblem(p, old, id)) p = toInputsMap(p);
  const input = p.inputs && old in p.inputs;
  if (old === id || renameProblem(p, old, id) || !(input || p.nodes?.[old])) return p;
  const next = clone(p);
  const swap = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k === old ? id : k, v]));
  if (input) next.inputs = swap(next.inputs);
  else next.nodes = swap(next.nodes);
  const fix = (from) => {
    if (from === undefined) return from;
    const list = asList(from).map((r) => {
      const { node, branch } = parseRef(r);
      return node === old ? refOf(id, branch) : r;
    });
    return Array.isArray(from) ? list : list[0];
  };
  for (const n of Object.values(next.nodes ?? {})) {
    if (n.from !== undefined) n.from = fix(n.from);
    if (n.loop?.back_to === old) n.loop.back_to = id;
  }
  if (next.output?.from !== undefined) next.output.from = fix(next.output.from);
  return next;
}

/** Why an edge from `ref` into `to` can't be drawn, or null. */
export function connectProblem(p, ref, to) {
  const { node } = parseRef(ref);
  if (isInput(p, to)) return "nothing flows into an input";
  if (node === "output") return "the output is the end of the line";
  if (node === to) return "a block can't feed itself (use a loop for that)";
  const t = target(p, to);
  if (!t) return `there is no '${to}'`;
  if (asList(t.from).includes(ref)) return "they're already connected";
  return null;
}

/** Draw an edge: `ref` (`node` or `node.branch`) feeds `to`. */
export function connect(p, ref, to) {
  if (connectProblem(p, ref, to)) return p;
  const next = clone(p);
  const t = target(next, to);
  t.from = tidy([...asList(t.from), ref]);
  if (to === "output") next.output = { from: next.output.from, ...next.output };
  else next.nodes[to] = { from: t.from, ...next.nodes[to] };
  return next;
}

/** Remove the edge from `ref` into `to`. */
export function disconnect(p, ref, to) {
  const next = clone(p);
  const t = target(next, to);
  if (!t) return p;
  const kept = asList(t.from).filter((r) => r !== ref);
  if (kept.length) t.from = tidy(kept);
  else delete t.from;
  return next;
}

/** Rename a route branch, keeping the edges that leave it. */
export function renameBranch(p, id, old, name) {
  const n = p.nodes?.[id];
  if (!n?.route || old === name || !ID.test(name) || n.route[name] !== undefined) return p;
  const next = clone(p);
  next.nodes[id].route = Object.fromEntries(
    Object.entries(next.nodes[id].route).map(([k, v]) => [k === old ? name : k, v]),
  );
  const from = refOf(id, old);
  const to = refOf(id, name);
  const fix = (f) => (Array.isArray(f) ? f.map((r) => (r === from ? to : r)) : f === from ? to : f);
  for (const m of Object.values(next.nodes)) if (m.from !== undefined) m.from = fix(m.from);
  if (next.output?.from !== undefined) next.output.from = fix(next.output.from);
  return next;
}

/** Remove a route branch and the edges that leave it. */
export function removeBranch(p, id, branch) {
  if (!p.nodes?.[id]?.route) return p;
  const next = clone(p);
  delete next.nodes[id].route[branch];
  const ref = refOf(id, branch);
  for (const to of [...Object.keys(next.nodes), "output"]) {
    const t = target(next, to);
    if (t && asList(t.from).includes(ref)) {
      const kept = asList(t.from).filter((r) => r !== ref);
      if (kept.length) t.from = tidy(kept);
      else delete t.from;
    }
  }
  return next;
}

/** Set (or with `undefined`, delete) the value at a dotted path such as `nodes.clean.with.url`. */
export function setPath(p, path, value) {
  const next = clone(p);
  const keys = Array.isArray(path) ? path : String(path).split(".");
  let at = next;
  for (const k of keys.slice(0, -1)) {
    if (at[k] === null || typeof at[k] !== "object") at[k] = {};
    at = at[k];
  }
  const last = keys.at(-1);
  if (value === undefined) delete at[last];
  else at[last] = value;
  return next;
}

export function getPath(p, path) {
  const keys = Array.isArray(path) ? path : String(path).split(".");
  let at = p;
  for (const k of keys) {
    if (at === null || typeof at !== "object") return undefined;
    at = at[k];
  }
  return at;
}

/**
 * Diagnostics grouped by the block they belong to: an input's name, `output`, a node id, or `pipeline` for the rest
 * (their `path` says where; `delivered` counts as the output's).
 */
export function diagnosticsByBlock(diagnostics) {
  const out = new Map();
  for (const d of diagnostics ?? []) {
    const path = d.path ?? [];
    let key = "pipeline";
    if (path[0] === "input") key = "input";
    else if (path[0] === "inputs" && typeof path[1] === "string") key = path[1];
    else if (path[0] === "output" || path[0] === "delivered") key = "output";
    else if (path[0] === "nodes" && typeof path[1] === "string") key = path[1];
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(d);
  }
  return out;
}

/** A pipeline name from free text: lowercase letters, digits and dashes. */
export const slug = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "my-pipeline";

/** A small undo/redo stack of values. */
export class History {
  constructor(value, limit = 100) {
    this.stack = [value];
    this.at = 0;
    this.limit = limit;
  }
  get value() {
    return this.stack[this.at];
  }
  push(value) {
    this.stack = this.stack.slice(0, this.at + 1);
    this.stack.push(value);
    if (this.stack.length > this.limit) this.stack.shift();
    this.at = this.stack.length - 1;
    return value;
  }
  get canUndo() {
    return this.at > 0;
  }
  get canRedo() {
    return this.at < this.stack.length - 1;
  }
  undo() {
    if (this.canUndo) this.at--;
    return this.value;
  }
  redo() {
    if (this.canRedo) this.at++;
    return this.value;
  }
}

/**
 * A starter JSON Schema for a schema file the pipeline names but that doesn't exist yet: for an agent node, an object
 * with one required string named after the file (`./summary.schema.json` → `summary`); for the input, any object.
 */
export function starterSchema(path, purpose = "agent") {
  if (purpose === "input") return { type: "object", description: "The packets this pipeline accepts" };
  const stem = String(path)
    .split("/")
    .pop()
    .replace(/(\.schema)?\.json$/, "");
  const key = /^[A-Za-z_][A-Za-z0-9_]*$/.test(stem) ? stem : "answer";
  return {
    type: "object",
    properties: { [key]: { type: "string", description: `The ${key} the agent writes` } },
    required: [key],
    additionalProperties: false,
  };
}

/** A value that matches a (simple) JSON Schema, for stubbing an agent's answer in a dry run. */
export function exampleOf(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 8) return null;
  if ("const" in schema) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const alt = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(alt) && alt.length) return exampleOf(alt[0], depth + 1);
  const types = [schema.type ?? (schema.properties ? "object" : schema.items ? "array" : undefined)].flat();
  const type = types.find((t) => t !== "null") ?? types[0];
  switch (type) {
    case "object":
      return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, exampleOf(v, depth + 1)]));
    case "array":
      return Array.from({ length: Math.max(1, schema.minItems ?? 1) }, () => exampleOf(schema.items, depth + 1));
    case "string":
      if (schema.format === "date-time") return "2026-01-01T00:00:00Z";
      if (schema.format === "date") return "2026-01-01";
      if (schema.format === "email") return "ada@example.com";
      if (schema.format === "uri" || schema.format === "url") return "https://example.com";
      return "x".repeat(Math.max(0, schema.minLength ?? 0)) || "example";
    case "integer":
    case "number":
      return schema.minimum ?? (schema.exclusiveMinimum === undefined ? 0 : schema.exclusiveMinimum + 1);
    case "boolean":
      return true;
    default:
      return null;
  }
}

/**
 * What `data` looks like as it leaves block `id` (D70): an example, starting from the input's schema file or its
 * connector's sample and carried through each step. null where it can't be known before a run: an http body, a `push`,
 * an `fn` or an http call's answer, or an agent without a readable schema. `ctx`: {inputs: the catalog's inputs,
 * schemaOf(path) → the JSON Schema in that file, or null}.
 */
export function shapeOut(p, id, ctx, seen = new Set()) {
  const input = inputOf(p, id);
  if (input) {
    const schema = typeof input.schema === "string" ? ctx.schemaOf(input.schema) : null;
    if (schema) return exampleOf(schema);
    if (input.via === "schedule") return input.with?.payload ?? {};
    return ctx.inputs?.[input.via]?.sample ?? null;
  }
  const node = p.nodes?.[id];
  if (!node) return null;
  if (node.agent !== undefined) {
    const schema = typeof node.with?.schema === "string" ? ctx.schemaOf(node.with.schema) : null;
    return schema ? exampleOf(schema) : null;
  }
  if (node.transform !== undefined)
    return node.transform === "map" ? fill(node.with?.data, shapeIn(p, id, ctx, seen)) : null;
  return shapeIn(p, id, ctx, seen); // tap, filter, route: data passes on unchanged
}

/** What `data` looks like as it reaches block `id`: the first upstream block whose shape is known. */
export function shapeIn(p, id, ctx, seen = new Set()) {
  if (seen.has(id)) return null; // a cycle
  seen.add(id);
  const from = id === "output" ? p.output?.from : p.nodes?.[id]?.from;
  for (const ref of asList(from)) {
    const shape = shapeOut(p, parseRef(ref).node, ctx, seen);
    if (shape !== null) return shape;
  }
  return null;
}

/** `data` paths in an example, for click-to-insert: `data`, `data.from`, `data.from.id`, `data.items[0]`, … */
export function dataPaths(value, base = "data", out = []) {
  if (out.length >= 80) return out;
  out.push(base);
  if (Array.isArray(value)) {
    if (value.length && value[0] && typeof value[0] === "object") dataPaths(value[0], `${base}[0]`, out);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value))
      dataPaths(v, /^[A-Za-z_]\w*$/.test(k) ? `${base}.${k}` : `${base}["${k}"]`, out);
  }
  return out;
}

const WHOLE = /^\$\{\s*([^{}]*?)\s*\}$/;

/** A `map` template rendered against an example; `${data.a.b}` is looked up, anything fancier is unknown (null). */
function fill(t, data) {
  if (typeof t === "string") {
    const whole = WHOLE.exec(t);
    if (whole) return lookup(whole[1], data);
    return t.replace(/\$\{([^{}]*)\}/g, (_, e) => {
      const v = lookup(e.trim(), data);
      return v === null || v === undefined ? "…" : typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(t)) return t.map((x) => fill(x, data));
  if (t && typeof t === "object") return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, fill(v, data)]));
  return t ?? null;
}

function lookup(expr, data) {
  if (!/^data(\.[A-Za-z_]\w*|\[\d+\])*$/.test(expr)) return null;
  let v = data;
  for (const k of expr
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .slice(1))
    v = v && typeof v === "object" ? v[k] : undefined;
  return v === undefined ? null : v;
}

// Trace steps that ran a node or wrote the output, by their event (the runner's `packet.filtered` is a filter's).
const RAN = new Set(["node.done", "node.looped", "node.failed_continued", "packet.filtered", "output.written"]);

/** Where a rerun from this packet-trace step starts (D79): the node it ran, or `output` for the output's write; null
 * for a step that ran nothing a rerun can start at (the input, a fan-out, a replay or rerun marker). */
export function rerunFrom(step) {
  if (!RAN.has(step?.event) || typeof step.node !== "string") return null;
  return step.node.startsWith("$") ? "output" : step.node;
}
