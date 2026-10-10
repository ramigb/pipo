// `pipo check` (docs/spec.md §5). Phase 1 validates against the JSON Schema; phase 2 runs the
// semantic rules (references, graph, compatibility, expressions, safety) on a well-shaped file.
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import Ajv, { type ErrorObject } from "ajv";
import { parseCron } from "./cron";
import { ExprError, parse } from "./expr/parse";
import { templateExpressions } from "./expr/template";
import { displayPath } from "./format";
import { type Diagnostic, load, type Path } from "./load";
import { AGENTS, FN_REF, OUTPUTS, supportedChecks, TAPS, TRANSFORMS } from "./manifests";
import { buildSchema } from "./schema";
import { untrustedReason } from "./trust";
import {
  asList,
  type Input,
  inputPath,
  inputsOf,
  MAX_INPUTS,
  NODE_KINDS,
  type Node,
  nodeKind,
  type Pipeline,
} from "./types";

export interface CheckOptions {
  file?: string;
  /** Check files the pipeline refers to (fn module, schemas). Defaults to true when `file` is set. */
  fs?: boolean;
  /** Pipo home, where trust.json lives (P052). Defaults to $PIPO_HOME or ~/.pipo. */
  home?: string;
}

/** The most delivered packets `agent.verify: last N` may replay (§9.3, D48). */
export const MAX_VERIFY = 1000;

/** `agent.verify` as its N, or null unless it is `last N` with 1 ≤ N ≤ MAX_VERIFY (P055). */
export function parseVerify(value: unknown): number | null {
  const m = typeof value === "string" ? /^last\s+([1-9]\d{0,3})$/.exec(value.trim()) : null;
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= MAX_VERIFY ? n : null;
}

let validator: ReturnType<Ajv["compile"]> | undefined;
function schemaValidator() {
  validator ??= new Ajv({ allErrors: true, strict: false, verbose: true }).compile(buildSchema());
  return validator;
}

export function checkFile(file: string, opts: { home?: string } = {}): Diagnostic[] {
  return check(readFileSync(file, "utf8"), { file, home: opts.home });
}

/**
 * Check several files as one project: each file's own diagnostics, plus P039 for a `listen` port two files share, P056
 * for a telegram bot two files poll, and P064 for a chain link declared at one end only, or a cycle of chains.
 */
export function checkProject(
  files: string[],
  opts: { home?: string } = {},
): { file: string; diagnostics: Diagnostic[] }[] {
  const results = files.map((file) => ({ file, diagnostics: checkFile(file, { home: opts.home }) }));
  const loadedOk = results
    .filter((r) => !r.diagnostics.some((d) => d.severity === "error"))
    .map((r) => {
      const loaded = load(readFileSync(r.file, "utf8"), r.file);
      return { r, loaded, p: loaded.value as Pipeline };
    });
  const warn = (
    r: (typeof results)[number],
    loaded: ReturnType<typeof load>,
    path: Path,
    code: string,
    message: string,
    hint: string,
    key = false,
  ) => {
    r.diagnostics.push({ file: r.file, ...loaded.locate(path, key), severity: "warning", code, message, hint, path });
    r.diagnostics = sort(r.diagnostics);
  };
  const owners = new Map<number, string>();
  const pollers = new Map<string, string>();
  for (const { r, loaded, p } of loadedOk) {
    // A file's own inputs clash as P062 (an error), so each port and bot is counted once per file here.
    const ports = new Set<number>();
    const bots = new Set<string>();
    for (const [name, input] of inputsOf(p)) {
      const at = inputPath(p, name);
      const port = input.via === "http" ? (input.with as { listen?: unknown } | undefined)?.listen : undefined;
      if (typeof port === "number" && !ports.has(port)) {
        ports.add(port);
        const first = owners.get(port);
        if (first === undefined) owners.set(port, r.file);
        else
          warn(
            r,
            loaded,
            [...at, "with", "listen"],
            "P039",
            `port ${port} is also the listen port of ${displayPath(first)}; only one of them can bind it`,
            "give each pipeline its own port, or run them behind the engine gateway (`/in/<pipeline>`) and drop `listen`",
          );
      }
      // P056: Telegram lets one reader take a bot's messages, so two pipelines polling one bot can't both run.
      if (input.via !== "telegram") continue;
      const bot = botOf(input);
      if (bots.has(bot)) continue;
      bots.add(bot);
      const first = pollers.get(bot);
      if (first === undefined) pollers.set(bot, r.file);
      else
        warn(
          r,
          loaded,
          [...at, "with"],
          "P056",
          `${bot.startsWith("token") ? "this telegram token" : `telegram ${bot}`} is also the input of ${displayPath(first)}; only one of them can poll it at a time`,
          "give each pipeline its own bot (`with.bot`), or send from one bot and receive with another",
          true,
        );
    }
  }
  // P064: both ends of a chain declare it (§3.14, D77). A name not in this run isn't checked: it may live elsewhere.
  const byName = new Map(loadedOk.map((x) => [x.p.name, x]));
  const feeds = (p: Pipeline) =>
    p.output.to === "pipeline" ? String((p.output.with as { pipeline?: unknown })?.pipeline ?? "") : undefined;
  const senders = (p: Pipeline) =>
    inputsOf(p).flatMap(([name, i]) =>
      i.via === "pipeline"
        ? asList((i.with as { from?: string[] } | undefined)?.from).map((s, k) => ({
            sender: s,
            at: [...inputPath(p, name), "with", "from", k] as Path,
          }))
        : [],
    );
  for (const x of loadedOk) {
    const to = feeds(x.p);
    const target = to ? byName.get(to) : undefined;
    if (to && target && !senders(target.p).some((s) => s.sender === x.p.name)) {
      warn(
        x.r,
        x.loaded,
        ["output", "with", "pipeline"],
        "P064",
        `pipeline '${to}' (${displayPath(target.r.file)}) has no \`via: pipeline\` input that lists '${x.p.name}', so it will refuse these packets`,
        `add '${x.p.name}' to the \`from\` list of a \`via: pipeline\` input in ${displayPath(target.r.file)}`,
      );
    }
    for (const s of senders(x.p)) {
      const source = byName.get(s.sender);
      if (source && feeds(source.p) !== x.p.name) {
        warn(
          x.r,
          x.loaded,
          s.at,
          "P064",
          `pipeline '${s.sender}' (${displayPath(source.r.file)}) doesn't send to '${x.p.name}': its output isn't \`to: pipeline\` with \`pipeline: ${x.p.name}\``,
          `set its output to \`to: pipeline\` and \`with: { pipeline: ${x.p.name} }\`, or remove '${s.sender}' from this list`,
        );
      }
    }
    // Each pipeline feeds at most one other, so following `feeds` from here either ends or comes back.
    const seen = [x.p.name];
    for (let next = to; next && byName.has(next); next = feeds(byName.get(next)?.p as Pipeline)) {
      if (next === x.p.name) {
        warn(
          x.r,
          x.loaded,
          ["output", "with", "pipeline"],
          "P064",
          `chain cycle: ${[...seen, next].join(" → ")}`,
          "a packet that goes round a cycle is refused after 16 hand-offs; break the cycle, or make sure a filter ends it",
        );
        break;
      }
      if (seen.includes(next)) break;
      seen.push(next);
    }
  }
  return results;
}

/** How P056/P062 name the bot a telegram input polls. */
function botOf(input: Input): string {
  const w = (input.with ?? {}) as { bot?: unknown; token?: unknown };
  return w.token !== undefined ? `token ${String(w.token)}` : `bot '${String(w.bot ?? "default")}'`;
}

export function check(source: string, opts: CheckOptions = {}): Diagnostic[] {
  const loaded = load(source, opts.file);
  if (loaded.diagnostics.length) return loaded.diagnostics;
  const out: Diagnostic[] = [];
  const report = (
    path: Path,
    code: string,
    message: string,
    extra: { severity?: "error" | "warning"; hint?: string; key?: boolean } = {},
  ) => {
    const pos = loaded.locate(path, extra.key);
    out.push({ file: opts.file, ...pos, severity: extra.severity ?? "error", code, message, hint: extra.hint, path });
  };

  const value = loaded.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    report([], "P002", "a .pipo file must be a YAML mapping with pipo, name, input (or inputs) and output", {
      hint: "start the file with 'pipo: 1', 'name:', then 'input:' and 'output:' blocks; see docs/spec.md §5",
    });
    return out;
  }
  const validate = schemaValidator();
  if (!validate(value)) {
    schemaDiagnostics(validate.errors ?? [], report);
    return sort(out);
  }
  semantics(value, report, (opts.fs ?? true) ? opts.file : undefined, opts.home);
  return sort(out);
}

type Report = (
  path: Path,
  code: string,
  message: string,
  extra?: { severity?: "error" | "warning"; hint?: string; key?: boolean },
) => void;

function sort(ds: Diagnostic[]): Diagnostic[] {
  return ds.sort((a, b) => a.line - b.line || a.col - b.col || a.code.localeCompare(b.code));
}

// ── Phase 1: schema ────────────────────────────────────────────────────────────

function schemaDiagnostics(errors: ErrorObject[], report: Report) {
  const seen = new Set<string>();
  for (const e of errors) {
    if (e.keyword === "if") continue;
    const path: Path = e.instancePath
      .split("/")
      .slice(1)
      .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    let message = e.message ?? "is invalid";
    let key = false;
    let hint: string | undefined;
    const where = path.length ? `'${path.join(".")}'` : "the file";
    switch (e.keyword) {
      case "additionalProperties": {
        const extra = String(e.params.additionalProperty);
        path.push(extra);
        key = true;
        const allowed = Object.keys((e.parentSchema as any)?.properties ?? {});
        message = `unknown key '${extra}' in ${where}`;
        const guess = closest(extra, allowed);
        hint = guess ? `did you mean '${guess}'?` : allowed.length ? `allowed: ${allowed.join(", ")}` : undefined;
        break;
      }
      case "required":
        message = `${where} is missing required key '${e.params.missingProperty}'`;
        hint = `add '${e.params.missingProperty}:' to ${path.length ? where : "the top level of the file"}; see docs/spec.md §5 for the required keys`;
        break;
      case "enum":
        message = `${where} must be one of: ${(e.params.allowedValues as unknown[]).join(", ")}`;
        hint = `use one of: ${(e.params.allowedValues as unknown[]).join(", ")}`;
        break;
      case "const":
        message = `${where} must be ${JSON.stringify(e.params.allowedValue)}`;
        hint = `set it to ${JSON.stringify(e.params.allowedValue)}`;
        break;
      case "pattern":
        message = String(e.params.pattern).includes("(ms|s|m|h|d)")
          ? `${where} must be a duration like 500ms, 10s, 5m, 1h or 7d`
          : `${where} must match ${e.params.pattern}`;
        hint = String(e.params.pattern).includes("(ms|s|m|h|d)")
          ? "write a number and a unit, for example 30s"
          : `change the value so it matches ${e.params.pattern}`;
        break;
      case "type":
        message = `${where} ${message}`;
        hint = `use a value of type ${[e.params.type].flat().join(" or ")} here; see docs/spec.md §5`;
        break;
      default:
        message = `${where} ${message}`;
        hint = `fix the value to satisfy the schema (${e.keyword}); run 'pipo schema' to see it, or see docs/spec.md §5`;
    }
    const id = `${path.join(".")}|${message}`;
    if (seen.has(id)) continue;
    seen.add(id);
    report(path, "P002", message, { key, hint });
  }
}

// ── Phase 2: semantics ─────────────────────────────────────────────────────────

const VARS = {
  input: ["data", "meta", "env"],
  inputWith: ["env", "secrets"],
  node: ["data", "meta", "env"],
  nodeWith: ["data", "meta", "env", "secrets"],
  output: ["data", "meta", "env", "output"],
  outputWith: ["data", "meta", "env", "secrets"],
  delivered: ["data", "meta", "env", "output", "result"],
  deliveredWith: ["data", "meta", "env", "secrets", "output", "result"],
  stall: ["meta", "env", "stats", "stall"],
  lifetime: ["env", "stats"],
};

const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|credential)/i;
const SECRET_VALUE =
  /^(Bearer\s+[A-Za-z0-9._~+/-]{12,}|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})$/;

function semantics(p: Pipeline, report: Report, file: string | undefined, home?: string) {
  const nodes: Record<string, Node> = p.nodes ?? {};
  const ids = Object.keys(nodes);

  // Inputs (§3.3.1, D76)
  if ((p.input === undefined) === (p.inputs === undefined)) {
    report(
      p.input ? ["inputs"] : [],
      "P060",
      p.input ? "declare `input` or `inputs`, not both" : "the pipeline has no input",
      {
        key: !!p.input,
        hint: p.input
          ? "keep `input:` for one input, or move it into `inputs:` under a name"
          : "add an `input:` block (or `inputs:`, a map of name → input); see docs/spec.md §3.3",
      },
    );
    return;
  }
  const inputs = inputsOf(p);
  const inputNames = inputs.map(([n]) => n);
  const at = (name: string): Path => inputPath(p, name);
  if (inputs.length > MAX_INPUTS) {
    report(["inputs"], "P060", `${inputs.length} inputs; a pipeline has at most ${MAX_INPUTS}`, {
      key: true,
      hint: "split the pipeline, or feed it from other pipelines through one `via: pipeline` input (§3.14)",
    });
  }
  for (const name of inputNames) {
    if (name === "output" || (name !== "input" && name in nodes)) {
      report(
        at(name),
        "P061",
        name === "output"
          ? "'output' is reserved and can't be an input name"
          : `input '${name}' has the name of a node`,
        {
          key: true,
          hint: "inputs and nodes share one set of names, since `from:` refers to both; rename one of them",
        },
      );
    }
  }
  const routes = new Map<string, string>();
  const listens = new Map<number, string>();
  const bots = new Map<string, string>();
  const senders = new Map<string, string>();
  for (const [name, input] of inputs) {
    const w = (input.with ?? {}) as Record<string, unknown>;
    if (input.via === "http") {
      const route = `${String(w.method ?? "POST")} ${String(w.path ?? "/")}`;
      const first = routes.get(route);
      if (first !== undefined)
        report([...at(name), "with"], "P062", `inputs '${first}' and '${name}' both take ${route}`, {
          key: true,
          hint: "http inputs share the runner's listener; give each its own `path` (or `method`)",
        });
      else routes.set(route, name);
      if (typeof w.listen === "number") {
        const other = [...listens].find(([port]) => port !== w.listen);
        if (other)
          report(
            [...at(name), "with", "listen"],
            "P062",
            `input '${name}' listens on ${w.listen}, input '${other[1]}' on ${other[0]}`,
            {
              hint: "http inputs share one listener: set `listen` on one of them, or the same port on each",
            },
          );
        listens.set(w.listen, name);
      }
    }
    if (input.via === "telegram") {
      const bot = botOf(input);
      const first = bots.get(bot);
      if (first !== undefined)
        report(
          [...at(name), "with"],
          "P062",
          `inputs '${first}' and '${name}' both poll telegram ${bot.startsWith("token") ? "this token" : bot}`,
          {
            key: true,
            hint: "Telegram lets one reader take a bot's messages: use one input for the bot, and route on the data",
          },
        );
      else bots.set(bot, name);
    }
    if (input.via === "pipeline") {
      asList(w.from as string[] | undefined).forEach((sender, i) => {
        const path: Path = [...at(name), "with", "from", i];
        if (sender === p.name)
          report(path, "P063", `pipeline '${p.name}' can't feed itself`, {
            hint: "loop inside the pipeline with `loop: { back_to, until, max }` instead (§3.4)",
          });
        else if (senders.has(sender))
          report(path, "P063", `'${sender}' already feeds input '${senders.get(sender)}'`, {
            hint: "a sender feeds one input of a pipeline; remove it from one of the lists",
          });
        else senders.set(sender, name);
      });
    }
  }
  if (p.output.to === "pipeline" && (p.output.with as { pipeline?: unknown } | undefined)?.pipeline === p.name) {
    report(["output", "with", "pipeline"], "P063", `pipeline '${p.name}' can't feed itself`, {
      hint: "name another pipeline, whose `via: pipeline` input lists this one (§3.14)",
    });
  }

  // References and node kinds
  const edges = new Map<string, Set<string>>(); // source → consumers ("$output" for the output)
  const consumedBranches = new Map<string, Set<string>>();
  const consumers = new Map<string, Set<string>>(); // full ref (`input`, node, `route.branch`) → consumers
  const addEdge = (from: string, to: string, ref = from) => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)?.add(to);
    if (!consumers.has(ref)) consumers.set(ref, new Set());
    consumers.get(ref)?.add(to);
  };
  const resolveFrom = (owner: string, ownerPath: Path, from: string | string[]) => {
    const list = asList(from);
    list.forEach((ref, i) => {
      const at: Path = Array.isArray(from) ? [...ownerPath, "from", i] : [...ownerPath, "from"];
      if (inputNames.includes(ref)) {
        addEdge(ref, owner);
        return;
      }
      const [base = "", branch, ...rest] = ref.split(".");
      const target = nodes[base];
      if (!target || rest.length) {
        const guess = closest(base, [...inputNames, ...ids]);
        report(at, "P010", `'${ref}' is not ${p.inputs ? "an input or a node" : "a node"}`, {
          hint: guess ? `did you mean '${guess}'?` : `known: ${[...inputNames, ...ids].join(", ")}`,
        });
        return;
      }
      if (branch !== undefined) {
        if (!target.route) {
          report(at, "P011", `'${base}' is not a route node, so it has no branch '${branch}'`);
          return;
        }
        if (!(branch in target.route)) {
          report(at, "P011", `route '${base}' has no branch '${branch}'`, {
            hint: `branches: ${Object.keys(target.route).join(", ")}`,
          });
          return;
        }
        if (!consumedBranches.has(base)) consumedBranches.set(base, new Set());
        consumedBranches.get(base)?.add(branch);
      } else if (target.route) {
        report(at, "P016", `'${base}' is a route node; take packets from one of its branches`, {
          hint: Object.keys(target.route)
            .map((b) => `${base}.${b}`)
            .join(", "),
        });
        return;
      }
      addEdge(base, owner, ref);
    });
  };

  for (const id of ids) {
    const node = nodes[id] as Node;
    const at: Path = ["nodes", id];
    if (id === "input" || id === "output")
      report(at, "P015", `'${id}' is reserved and can't be a node id`, {
        key: true,
        hint: "'input' and 'output' name the pipeline's ends; pick another id for this node",
      });
    resolveFrom(id, at, node.from);

    const kinds = NODE_KINDS.filter((k) => node[k] !== undefined);
    if (kinds.length === 0)
      report(at, "P036", `node '${id}' declares no kind`, { key: true, hint: `add one of: ${NODE_KINDS.join(", ")}` });
    if (kinds.length > 1)
      report(at, "P036", `node '${id}' declares more than one kind (${kinds.join(", ")})`, {
        key: true,
        hint: "split it into one node per kind, chained with `from:`",
      });

    if (node.tap !== undefined) checkAction(node.tap, TAPS, [...at, "tap"], "tap", p, report);
    const command = (node.tap === "exec" || node.transform === "exec") && node.with?.command;
    if (typeof command === "string" && !command.includes("${") && /\s/.test(command.trim())) {
      report([...at, "with", "command"], "P058", `exec command '${command}' looks like a whole command line`, {
        severity: "warning",
        hint: `exec runs no shell: set command to the program only and put each argument in args, for example command: ${command.trim().split(/\s+/)[0]}`,
      });
    }
    if (node.transform !== undefined)
      checkAction(node.transform, TRANSFORMS, [...at, "transform"], "transform", p, report);
    if (node.agent !== undefined && !(node.agent in AGENTS)) {
      report([...at, "agent"], "P030", `unknown agent provider '${node.agent}'`, {
        hint:
          node.agent === "claude"
            ? "the Anthropic API provider is now called claude_api (D66)"
            : `available: ${Object.keys(AGENTS).join(", ")}`,
      });
    }
    // CLI agents run on the user's own subscription and may report no cost at all, so no cap is asked for (D67).
    if (node.agent !== undefined && !p.agent_budget && AGENTS[node.agent]?.runs !== "cli") {
      report([...at, "agent"], "P053", `agent node '${id}' has no cost cap`, {
        severity: "warning",
        hint: "add agent_budget (docs/spec.md §3.11)",
      });
    }
    if (node.route) {
      const names = Object.keys(node.route);
      names.forEach((b, i) => {
        if (node.route?.[b] === "else" && i !== names.length - 1) {
          report([...at, "route", b], "P017", `'else' must be the last branch of route '${id}'`, {
            hint: "move the `else` branch to the end; branches are tried in order",
          });
        }
      });
    }
  }
  resolveFrom("$output", ["output"], p.output.from);

  // Graph shape
  const reach = (start: string, next: (n: string) => Iterable<string>) => {
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length) {
      for (const n of next(queue.shift() as string)) {
        if (seen.has(n)) continue;
        seen.add(n);
        queue.push(n);
      }
    }
    return seen;
  };
  const forward = (n: string) => edges.get(n) ?? [];
  const backward = (n: string) => [...edges].filter(([, to]) => to.has(n)).map(([from]) => from);
  const reached = new Map(inputNames.map((n) => [n, reach(n, forward)]));
  const fromInput = new Set([...reached.values()].flatMap((r) => [...r]));
  const toOutput = reach("$output", backward);
  const fromWhere = p.inputs ? "any input" : "input";
  for (const id of ids) {
    if (!fromInput.has(id))
      report(["nodes", id], "P020", `node '${id}' can't be reached from ${fromWhere}`, { key: true });
    if (!toOutput.has(id)) {
      report(["nodes", id], "P021", `node '${id}' never leads to the output`, {
        key: true,
        hint: `take packets from it in a later node or the output (from: ${nodes[id]?.route ? `${id}.<branch>` : id})`,
      });
    }
  }
  if (!fromInput.has("$output")) report(["output", "from"], "P020", `the output can't be reached from ${fromWhere}`);
  else if (p.inputs) {
    for (const [name, r] of reached) {
      if (r.has("$output")) continue;
      report(at(name), "P021", `input '${name}' never leads to the output`, {
        key: true,
        hint: `take packets from it in a node or the output (from: ${name})`,
      });
    }
  }

  for (const cycle of findCycles(ids, forward)) {
    report(["nodes", cycle[0] as string, "from"], "P022", `cycle ${cycle.join(" → ")}`, {
      hint: "cycles are only allowed through a bounded loop: loop: { back_to, until, max }",
    });
  }

  for (const id of ids) {
    const loop = nodes[id]?.loop;
    if (!loop) continue;
    if (!nodes[loop.back_to]) {
      report(["nodes", id, "loop", "back_to"], "P024", `loop.back_to '${loop.back_to}' is not a node`, {
        hint: `loop back to an upstream node: ${ids.join(", ")}`,
      });
    } else if (loop.back_to !== id && !reach(loop.back_to, forward).has(id)) {
      report(["nodes", id, "loop", "back_to"], "P023", `loop.back_to '${loop.back_to}' is not upstream of '${id}'`, {
        hint: "back_to must be the node itself or one that feeds it (directly or through other nodes)",
      });
    }
  }
  for (const id of ids) {
    const route = nodes[id]?.route;
    if (!route) continue;
    for (const b of Object.keys(route)) {
      if (!consumedBranches.get(id)?.has(b)) {
        report(
          ["nodes", id, "route", b],
          "P025",
          `nothing takes packets from branch '${id}.${b}'; they will be dropped as filtered`,
          {
            severity: "warning",
            key: true,
          },
        );
      }
    }
  }

  // Fan-out copies share meta.packet_id; only the default key tells them apart (D22).
  for (const [ref, to] of consumers) {
    const paths = [...to].filter((c) => c === "$output" || toOutput.has(c));
    if (paths.length < 2) continue;
    const where = `'${ref}' fans out to ${paths.map((c) => (c === "$output" ? "output" : c)).join(", ")}`;
    const hint =
      'add meta.branch to it, e.g. "${meta.packet_id}:${meta.branch}" (the default key is packet_id:<branch> for a copy)';
    const keyAt: [Path, unknown][] = [];
    const w = (p.output.with ?? {}) as { key?: string; columns?: Record<string, unknown>; headers?: unknown };
    if (p.output.to === "sqlite" && w.columns) {
      const key = w.key ?? "packet_id";
      if (key in w.columns) keyAt.push([["output", "with", "columns", key], w.columns[key]]);
    }
    if (p.output.to === "http" && w.headers && typeof w.headers === "object") {
      for (const [h, v] of Object.entries(w.headers)) {
        if (h.toLowerCase() === "idempotency-key") keyAt.push([["output", "with", "headers", h], v]);
      }
    }
    for (const [at, v] of keyAt) {
      if (metaFields(v).has("branch")) continue;
      report(at, "P026", `every copy writes the same key: ${where}, and this key doesn't use meta.branch`, {
        severity: "warning",
        hint,
      });
    }
    walkStrings(p.delivered?.with, ["delivered", "with"], (at, v) => {
      const fields = metaFields(v);
      if (!fields.has("packet_id") || fields.has("branch")) return;
      report(at, "P026", `the delivery check looks a copy up by meta.packet_id, which every copy shares (${where})`, {
        severity: "warning",
        hint,
      });
    });
    break;
  }

  // Compatibility
  const check = p.delivered?.check ?? "ack";
  const supported = supportedChecks(p.output.to);
  if (!supported.includes(check)) {
    report(["delivered", "check"], "P031", `delivered.check '${check}' is not supported by output '${p.output.to}'`, {
      hint: `supported: ${supported.join(", ")}`,
    });
  }
  if (p.output.batch && !OUTPUTS[p.output.to]?.batch) {
    report(["output", "batch"], "P032", `output '${p.output.to}' does not support batch`, {
      key: true,
      hint: `batching works with: ${Object.entries(OUTPUTS)
        .filter(([, m]) => m.batch)
        .map(([n]) => n)
        .join(", ")}`,
    });
  }
  if (p.agent?.verify !== undefined && parseVerify(p.agent.verify) === null) {
    report(["agent", "verify"], "P055", `agent.verify must be 'last N' with N from 1 to ${MAX_VERIFY}`, {
      hint: "e.g. `verify: last 20` dry-runs an agent's change on the last 20 delivered packets (docs/spec.md §9.3)",
    });
  }
  for (const [name, input] of inputs) {
    if (input.on_invalid?.respond !== undefined && input.via !== "http") {
      report([...at(name), "on_invalid", "respond"], "P035", "respond only applies to via: http", {
        key: true,
        hint: `remove \`respond\`, or set ${p.inputs ? `inputs.${name}` : "input"}.via to http`,
      });
    }
    if (input.via !== "schedule") continue;
    const w = (input.with ?? {}) as { cron?: unknown; every?: unknown };
    if ((w.cron === undefined) === (w.every === undefined)) {
      report([...at(name), "with"], "P038", "schedule needs exactly one of `cron` or `every`", {
        key: true,
        hint: "e.g. `every: 5m` or `cron: '0 9 * * 1-5'`",
      });
    } else if (typeof w.cron === "string" && !w.cron.includes("${")) {
      try {
        parseCron(w.cron);
      } catch (e) {
        report([...at(name), "with", "cron"], "P038", (e as Error).message, {
          hint: "5 fields: minute hour day-of-month month day-of-week (UTC)",
        });
      }
    }
  }
  // A telegram send with no chat_id replies to the chat a telegram input's packet came from (§3.13), so every input
  // whose packets can reach the send must be a telegram one.
  const sends: [string, Path, unknown][] = [
    ...ids
      .filter((id) => nodes[id]?.tap === "telegram")
      .map((id): [string, Path, unknown] => [id, ["nodes", id], nodes[id]?.with]),
    ...(p.output.to === "telegram" ? [["$output", ["output"], p.output.with] as [string, Path, unknown]] : []),
  ];
  for (const [step, path, w] of sends) {
    if ((w as { chat_id?: unknown } | undefined)?.chat_id !== undefined) continue;
    const other = inputs.find(([name, i]) => i.via !== "telegram" && reached.get(name)?.has(step));
    if (!other) continue;
    report(
      [...path, ...(w ? ["with"] : [])],
      "P057",
      p.inputs
        ? `telegram send without chat_id, and input '${other[0]}' that reaches it is not telegram`
        : "telegram send without chat_id, and the input is not telegram",
      {
        key: true,
        hint: "set with.chat_id (a reply goes back to the sender's chat only for packets from `via: telegram`)",
      },
    );
  }
  if (p.output.to === "sqlite") {
    const w = (p.output.with ?? {}) as { key?: string; columns?: Record<string, unknown> };
    const key = w.key ?? "packet_id";
    if (w.columns && !(key in w.columns)) {
      report(["output", "with", "columns"], "P037", `columns has no '${key}' column, which is the idempotency key`, {
        key: true,
        hint: w.key ? `add '${key}' to columns` : "set `key:` to one of your columns, or add a packet_id column",
      });
    }
  }
  const policies: [Path, string | undefined, string | null][] = [
    [["errors", "then"], p.errors?.then, "default"],
    ...inputs.map(([name, i]): [Path, string | undefined, string | null] => [
      [...at(name), "on_invalid", "then"],
      i.on_invalid?.then,
      "input",
    ]),
    [["output", "on_invalid", "then"], p.output.on_invalid?.then, "output"],
    [["output", "on_error", "then"], p.output.on_error?.then, "output"],
    [["delivered", "on_fail", "then"], p.delivered?.on_fail?.then, "delivered"],
    ...ids.flatMap((id): [Path, string | undefined, string | null][] => [
      [["nodes", id, "on_error", "then"], nodes[id]?.on_error?.then, nodeKind(nodes[id] as Node) ?? null],
      [["nodes", id, "loop", "then"], nodes[id]?.loop?.then, "loop"],
    ]),
  ];
  for (const [path, then, where] of policies) {
    if (!then) continue;
    if (then === "continue" && where !== "tap") {
      report(path, "P033", "then: continue only applies to tap nodes", {
        hint: "a failed step that changes data can't be skipped",
      });
    }
    if (then === "drop" && (where === "output" || where === "delivered" || where === "default")) {
      report(path, "P033", `then: drop is not allowed ${where === "default" ? "as a default" : `in ${where}`}`);
    }
    if (then === "agent" && !p.agent?.control) {
      report(path, "P034", "then: agent requires agent.control: true");
    }
  }
  // A stall handed to the agent needs the endpoint too (D50).
  if (p.delivered?.stall?.then === "agent" && !p.agent?.control) {
    report(["delivered", "stall", "then"], "P034", "stall then: agent requires agent.control: true", {
      hint: "add `agent: { control: true }`, or use then: notify or pause",
    });
  }
  if (p.agent?.on_stall === "handle" && !p.agent.control) {
    report(["agent", "on_stall"], "P034", "agent.on_stall: handle requires agent.control: true", {
      hint: "set agent.control: true, or use on_stall: notify",
    });
  }

  // Expressions and templates
  const exprAt = (path: Path, source: string, vars: string[]) => checkExpr(path, source, vars, false, p, report);
  const templatesIn = (path: Path, value: unknown, vars: string[]) => {
    walkStrings(value, path, (at, s) => checkExpr(at, s, vars, true, p, report));
  };
  for (const [name, input] of inputs) {
    for (const [i, v] of (input.validate ?? []).entries()) exprAt([...at(name), "validate", i], v, VARS.input);
    templatesIn([...at(name), "with"], input.with, VARS.inputWith);
    templatesIn([...at(name), "on_invalid", "message"], input.on_invalid?.message, [...VARS.input, "error"]);
  }
  templatesIn(["errors", "message"], p.errors?.message, [...VARS.node, "error"]);
  for (const id of ids) {
    const n = nodes[id] as Node;
    const at: Path = ["nodes", id];
    if (n.filter !== undefined) exprAt([...at, "filter"], n.filter, VARS.node);
    for (const [b, e] of Object.entries(n.route ?? {})) if (e !== "else") exprAt([...at, "route", b], e, VARS.node);
    if (n.loop) exprAt([...at, "loop", "until"], n.loop.until, VARS.node);
    templatesIn([...at, "with"], n.with, VARS.nodeWith);
    templatesIn([...at, "on_error", "message"], n.on_error?.message, [...VARS.node, "error"]);
  }
  for (const [i, v] of (p.output.validate ?? []).entries()) exprAt(["output", "validate", i], v, VARS.output);
  templatesIn(["output", "with"], p.output.with, VARS.outputWith);
  templatesIn(["output", "on_invalid", "message"], p.output.on_invalid?.message, [...VARS.output, "error"]);
  templatesIn(["output", "on_error", "message"], p.output.on_error?.message, [...VARS.output, "error"]);
  templatesIn(["delivered", "with"], p.delivered?.with, VARS.deliveredWith);
  templatesIn(["delivered", "on_fail", "message"], p.delivered?.on_fail?.message, [...VARS.delivered, "error"]);
  templatesIn(["delivered", "stall", "message"], p.delivered?.stall?.message, VARS.stall);
  if (p.lifetime?.until) exprAt(["lifetime", "until"], p.lifetime.until, VARS.lifetime);

  // Safety: literal credentials in with: blocks
  const withBlocks: [Path, unknown][] = [
    ...inputs.map(([name, i]): [Path, unknown] => [[...at(name), "with"], i.with]),
    [["output", "with"], p.output.with],
    [["delivered", "with"], p.delivered?.with],
    ...ids.map((id): [Path, unknown] => [["nodes", id, "with"], nodes[id]?.with]),
  ];
  for (const [path, block] of withBlocks) {
    walkStrings(block, path, (at, s) => {
      if (s.includes("${") || !s.trim()) return;
      const key = String(at[at.length - 1]);
      if (SECRET_VALUE.test(s.trim()) || (SECRET_KEY.test(key) && !/^(op:\/\/|env:)/.test(s))) {
        report(at, "P050", `'${key}' looks like a literal credential`, {
          severity: "warning",
          hint: "declare it under secrets: (op://… or env:…) and use ${secrets.<name>}",
        });
      }
    });
  }

  // Files the pipeline refers to
  if (file) checkFiles(p, nodes, resolve(file), report, home);
}

function checkAction(
  value: string,
  catalog: Record<string, unknown>,
  path: Path,
  kind: string,
  p: Pipeline,
  report: Report,
) {
  if (FN_REF.test(value)) {
    if (!p.fn)
      report(path, "P012", `'${value}' needs a function module`, { hint: "add `fn: ./<module>.ts` at the top level" });
    return;
  }
  if (!(value in catalog)) {
    const guess = closest(value, Object.keys(catalog));
    report(path, "P030", `unknown ${kind} '${value}'`, {
      hint: guess ? `did you mean '${guess}'?` : `available: ${Object.keys(catalog).join(", ")}, fn.<name>`,
    });
  }
}

function checkExpr(path: Path, source: string, vars: string[], template: boolean, p: Pipeline, report: Report) {
  let exprs: string[];
  try {
    exprs = template ? templateExpressions(source) : [source];
  } catch (e) {
    report(path, "P040", (e as Error).message);
    return;
  }
  for (const expr of exprs) {
    try {
      const compiled = parse(expr);
      for (const id of compiled.identifiers) {
        if (vars.includes(id)) continue;
        if (id === "secrets") {
          report(path, "P051", "secrets can only be used inside with: blocks");
        } else {
          report(path, "P041", `'${id}' is not available here`, { hint: `available: ${vars.join(", ")}` });
        }
      }
      if (vars.includes("secrets")) {
        for (const name of secretRefs(compiled.ast)) {
          if (!p.secrets || !(name in p.secrets)) {
            report(path, "P013", `secret '${name}' is not declared`, {
              hint: "declare it under the top-level secrets: map",
            });
          }
        }
      }
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      report(path, "P040", `invalid expression '${expr}': ${e.message}`);
    }
  }
}

/** `meta.<field>` names a template or expression string uses; empty when it doesn't parse. */
function metaFields(value: unknown): Set<string> {
  const found = new Set<string>();
  if (typeof value !== "string") return found;
  try {
    for (const expr of templateExpressions(value)) {
      const walk = (n: any) => {
        if (!n || typeof n !== "object") return;
        if (n.type === "MemberExpression" && n.object?.type === "Identifier" && n.object.name === "meta") {
          if (!n.computed && n.property?.type === "Identifier") found.add(n.property.name);
          if (n.computed && n.property?.type === "Literal") found.add(String(n.property.value));
        }
        for (const v of Object.values(n)) walk(v);
      };
      walk(parse(expr).ast);
    }
  } catch {}
  return found;
}

function secretRefs(ast: unknown): string[] {
  const found: string[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (
      n.type === "MemberExpression" &&
      !n.computed &&
      n.object?.type === "Identifier" &&
      n.object.name === "secrets"
    ) {
      found.push(n.property.name);
    }
    for (const v of Object.values(n)) walk(v);
  };
  walk(ast);
  return found;
}

function walkStrings(value: unknown, path: Path, visit: (path: Path, s: string) => void) {
  if (typeof value === "string") visit(path, value);
  else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) walkStrings(v, [...path, i], visit);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walkStrings(v, [...path, k], visit);
  }
}

function checkFiles(p: Pipeline, nodes: Record<string, Node>, file: string, report: Report, home?: string) {
  const base = dirname(file);
  // An exec step runs a program as you, so a .pipo file from a template you didn't write is untrusted like an fn module (D71).
  const execs = Object.entries(nodes).filter(([, n]) => n.tap === "exec" || n.transform === "exec");
  if (execs.length && existsSync(file)) {
    const untrusted = untrustedReason(base, relative(base, file), readFileSync(file, "utf8"), home, "pipeline");
    for (const [id, n] of untrusted ? execs : []) {
      report(
        ["nodes", id, n.tap === "exec" ? "tap" : "transform"],
        "P052",
        `exec node '${id}': ${untrusted?.message}`,
        {
          hint: untrusted?.hint,
        },
      );
    }
  }
  if (p.fn) {
    const fnPath = resolve(base, p.fn);
    if (!existsSync(fnPath)) {
      report(["fn"], "P014", `function module '${p.fn}' does not exist`);
    } else {
      const loader = fnPath.endsWith(".ts") ? "ts" : "js";
      const content = readFileSync(fnPath, "utf8");
      const exports = new Set(new Bun.Transpiler({ loader }).scan(content).exports);
      const untrusted = untrustedReason(base, relative(base, fnPath), content, home);
      if (untrusted) report(["fn"], "P052", untrusted.message, { hint: untrusted.hint });
      for (const [id, n] of Object.entries(nodes)) {
        for (const kind of ["tap", "transform"] as const) {
          const m = n[kind] ? FN_REF.exec(n[kind] as string) : null;
          if (m && !exports.has(m[1] as string)) {
            report(["nodes", id, kind], "P012", `'${p.fn}' does not export '${m[1]}'`, {
              hint: exports.size ? `exports: ${[...exports].join(", ")}` : undefined,
            });
          }
        }
      }
    }
  }
  const files: [Path, unknown][] = [
    ...inputsOf(p).map(([name, i]): [Path, unknown] => [[...inputPath(p, name), "schema"], i.schema]),
    ...Object.entries(nodes).map(([id, n]): [Path, unknown] => [
      ["nodes", id, "with", "schema"],
      n.agent ? n.with?.schema : undefined,
    ]),
  ];
  for (const [path, f] of files) {
    if (typeof f !== "string" || f.includes("${")) continue;
    if (!existsSync(resolve(base, f))) {
      report(path, "P014", `file '${f}' does not exist`);
      continue;
    }
    const problem = schemaFileProblem(resolve(base, f));
    if (problem) {
      report(path, "P054", `'${f}' is not a usable JSON Schema: ${problem}`, {
        hint: "fix the file: it must be JSON and a valid JSON Schema (draft-07 or 2020-12 keywords)",
      });
    }
  }
}

/** Why a schema file can't be compiled (P054), or null. `$schema` is ignored, as the runner does. */
function schemaFileProblem(file: string): string | null {
  let schema: unknown;
  try {
    schema = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return `not JSON (${(e as Error).message})`;
  }
  return schemaProblem(schema);
}

/** Why a parsed value can't be used as a schema file's content (P054), or null. */
export function schemaProblem(schema: unknown): string | null {
  if (typeof schema === "boolean") return null;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "a schema must be an object";
  const { $schema: _ignored, ...rest } = schema as Record<string, unknown>;
  try {
    new Ajv({ strict: false }).compile(rest);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function findCycles(ids: string[], next: (n: string) => Iterable<string>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const visit = (n: string) => {
    state.set(n, "open");
    stack.push(n);
    for (const m of next(n)) {
      if (m === "$output") continue;
      if (state.get(m) === "open") cycles.push([...stack.slice(stack.indexOf(m)), m]);
      else if (!state.has(m)) visit(m);
    }
    stack.pop();
    state.set(n, "done");
  };
  for (const id of ids) if (!state.has(id)) visit(id);
  return cycles;
}

function closest(word: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestScore = 3;
  for (const c of candidates) {
    const d = distance(word, c);
    if (d < bestScore) {
      best = c;
      bestScore = d;
    }
  }
  return best;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j] as number;
      row[j] = Math.min((row[j] as number) + 1, (row[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length] as number;
}
