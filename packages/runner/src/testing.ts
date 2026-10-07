// `pipo test` (docs/spec.md §10.3): run a pipeline in-process against fixture packets, on the dry run's replay core
// (dryrun.ts, §9.3 step 3). Filters, routes, loops, fan-out, `map` and `fn` transforms run for real; taps and the
// output are mocked (their `with:` is rendered and recorded, nothing is called, sent or written); agent nodes and
// `transform: http` return stubbed responses. Error policies apply as in the runner, with retries counted but never
// waited for. Nothing touches a journal, a port or the disk (the pipeline, its schemas and `fn` module are only read),
// and secrets are never resolved: every `secrets.*` renders as `***`.
//
// Results are deterministic, so a caller can snapshot them: the packet id is the fixture's name, `meta.received_at`,
// `now()` and `iso()` read a fixed clock, and every list is in the order the replay produced it.
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  check,
  type Diagnostic,
  FN_REF,
  formatDuration,
  HELPERS,
  load,
  nodeKind,
  type Pipeline,
  render,
  renderString,
} from "@pipo/spec";
import { SqliteOutput } from "./connectors/sqlite-output";
import { DRY_RUN_STEP_TIMEOUT, ReplayAbort, type ReplayFailure, type ReplayUnit, replayPacket } from "./dryrun";
import { outputKey } from "./output-key";
import { compile, type Plan } from "./plan";
import { type Gap, gaps } from "./support";

/** The fixed clock of a test run unless `now` is given: 2026-01-01T00:00:00Z. */
export const TEST_NOW = Date.UTC(2026, 0, 1);
/** `meta.version` in a test run: the file under test, as its first version. */
export const TEST_VERSION = 1;
/** What every `secrets.*` renders as: the redacted form, so no result can carry a secret. */
const SECRET = "***";
/** `meta.source` unless the fixture sets it. */
const SOURCE = "test";
/** Fixture files that are not fixtures: the agent-classifier scaffold's sample response, `pipo test`'s run-wide stubs, and snapshots. */
const NOT_FIXTURES = (file: string) => file === "expected.json" || file === "stubs.json" || file.endsWith(".snap.json");
const FIXTURE_KEYS = ["data", "meta", "stubs"];
const META_KEYS = ["trigger", "source", "received_at"];
const FORM = 'a fixture is the packet\'s data as JSON, or {"data": …, "meta": {…}, "stubs": {…}}';

/** Node id → its response, or a list of responses used one per call in order (retries and loop passes included). */
export type Stubs = Record<string, unknown>;

export interface FixtureMeta {
  trigger?: string;
  source?: string;
  received_at?: number;
}

export interface Fixture {
  /** Unique; also the packet id (`meta.packet_id`), so results don't change between runs. */
  name: string;
  data: unknown;
  meta?: FixtureMeta;
  /** Over the run's stubs, per node. */
  stubs?: Stubs;
  /** The file it was loaded from, for hints. */
  file?: string;
}

/** A fixture file or list that can't be used; nothing ran. */
export class FixtureError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/** The pipeline can't be tested at all: it has check errors, uses an unimplemented feature, or won't compile. */
export class TestPrepareError extends Error {
  constructor(
    message: string,
    readonly diagnostics: Diagnostic[] = [],
    readonly gaps: Gap[] = [],
  ) {
    super(message);
  }
}

/** A unit's end, in journal state words (§2.1); `paused` and `halted` units stay pending in a real run. */
export type UnitOutcome =
  | "delivered"
  | "filtered"
  | "dead_lettered"
  | "escalated"
  | "paused"
  | "halted"
  | "failed"
  | "branched";
export type TestOutcome = Exclude<UnitOutcome, "branched"> | "rejected";
export const TEST_OUTCOMES: readonly TestOutcome[] = [
  "delivered",
  "filtered",
  "rejected",
  "dead_lettered",
  "escalated",
  "paused",
  "halted",
  "failed",
];

export interface TestError {
  /** `input`, a node id or `output`. */
  step: string;
  code: string;
  /** The policy's `message` when it has one, rendered as the runner would; otherwise the error itself. */
  message: string;
  rule?: string;
  attempts?: number;
  /** The policy's final action. */
  then?: string;
  hint?: string;
}

export interface TestWrite {
  /** The idempotency key: the unit id (`packet_id`, or `packet_id:<branch>`, D22), or sqlite's key column value. */
  key: string;
  to: string;
  /** `output.with` as rendered for this unit. */
  with: Record<string, unknown>;
  /** The row a `sqlite` output would write. */
  record?: Record<string, unknown>;
}

export interface TestUnit {
  unit: string;
  branch: string;
  outcome: UnitOutcome;
  path: string[];
  /** For `branched`: the copies, in order. */
  copies?: string[];
  /** The data where the unit ended (what was written, for `delivered`). */
  data?: unknown;
  write?: TestWrite;
  error?: TestError;
  /** Tap failures `then: continue` let through. */
  warnings?: TestError[];
  /**
   * With `trace`: the data leaving each step, in order, from `input` (a copy starts with its parent's steps); a
   * route's step is `<id>.<branch>`, and `output` is there once written.
   */
  steps?: TestStep[];
}

export interface TestStep {
  step: string;
  data: unknown;
}

export interface TestTap {
  unit: string;
  node: string;
  tap: string;
  /** The rendered `with:` (built-in taps; `fn` taps are recorded without one). */
  with?: Record<string, unknown>;
}

export interface TestCall {
  unit: string;
  node: string;
  kind: "agent" | "transform";
  attempt: number;
  /** The rendered `with:` (the prompt, the request), as the provider or endpoint would have got it. */
  with: Record<string, unknown>;
}

export interface FixtureResult {
  fixture: string;
  /** The packet's outcome: `rejected`, or across its units the first of failed, halted, paused, escalated, dead_lettered, delivered, filtered (as a fan-out settles, D22). */
  outcome: TestOutcome;
  /** In creation order: the packet, then its copies. Empty when the input rejected it. */
  units: TestUnit[];
  taps: TestTap[];
  calls: TestCall[];
  /** Why the packet was rejected, or why the fixture could not run. */
  error?: TestError;
}

export interface TestReport {
  pipeline: string;
  fixtures: FixtureResult[];
  counts: Record<TestOutcome, number>;
}

export interface TestOptions {
  /** The pipeline file: `fn` modules and schema files are read from its folder. */
  file: string;
  /** The definition to test instead of the file's content (the file still locates relative paths). */
  source?: string;
  fixtures: Fixture[];
  /** For every fixture; a fixture's own stubs win, node by node. */
  stubs?: Stubs;
  /** The fixed clock, in ms since the epoch (default TEST_NOW). */
  now?: number;
  /** `env` in expressions (default none). */
  env?: Record<string, string>;
  /** Pipo home for `pipo check` (trust, P052). */
  home?: string;
  /** Per `fn` call, in ms (default 30 s). */
  stepTimeoutMs?: number;
  /** Record each unit's steps with their data (TestUnit.steps), for the dashboard's test run (§8, D62). */
  trace?: boolean;
}

// `now()` and `iso()` read the test clock inside a test run and the real one everywhere else.
const clock = new AsyncLocalStorage<number>();
let clockInstalled = false;
function installClock() {
  if (clockInstalled) return;
  clockInstalled = true;
  const { now, iso } = HELPERS as { now: () => number; iso: (ms: unknown) => string };
  HELPERS.now = () => clock.getStore() ?? now();
  HELPERS.iso = (ms) => {
    const fixed = clock.getStore();
    return iso(typeof ms === "number" || fixed === undefined ? ms : fixed);
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A fixture from a file's JSON: the structured form when it is an object with `data` and only data/meta/stubs. */
export function parseFixture(name: string, text: string, file?: string): Fixture {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new FixtureError(`${file ?? name}: not valid JSON: ${(e as Error).message}`, FORM);
  }
  const fx: Fixture =
    isObject(raw) && Object.hasOwn(raw, "data") && Object.keys(raw).every((k) => FIXTURE_KEYS.includes(k))
      ? {
          name,
          data: raw.data,
          ...(raw.meta === undefined ? {} : { meta: raw.meta as FixtureMeta }),
          ...(raw.stubs === undefined ? {} : { stubs: raw.stubs as Stubs }),
        }
      : { name, data: raw };
  if (file) fx.file = file;
  validateFixture(fx);
  return fx;
}

/** Every `*.json` file in `dir` (not in subfolders) except `expected.json`, `stubs.json` and `*.snap.json`, by file name. */
export function loadFixtures(dir: string): Fixture[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !NOT_FIXTURES(f) && statSync(join(dir, f)).isFile())
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((f) => parseFixture(f.slice(0, -".json".length), readFileSync(join(dir, f), "utf8"), join(dir, f)));
}

function validateFixture(fx: Fixture) {
  const where = fx.file ?? `fixture '${fx.name}'`;
  if (typeof fx.name !== "string" || !fx.name) throw new FixtureError("a fixture needs a name", FORM);
  if (fx.meta !== undefined) {
    if (!isObject(fx.meta)) throw new FixtureError(`${where}: meta must be an object`, FORM);
    for (const [k, v] of Object.entries(fx.meta)) {
      if (!META_KEYS.includes(k)) {
        throw new FixtureError(
          `${where}: meta.${k} can't be set`,
          `a fixture may set meta.${META_KEYS.join(", meta.")}; the rest comes from the run`,
        );
      }
      const ok = k === "received_at" ? typeof v === "number" && Number.isFinite(v) : typeof v === "string";
      if (!ok)
        throw new FixtureError(`${where}: meta.${k} must be a ${k === "received_at" ? "number (ms)" : "string"}`);
    }
  }
  if (fx.stubs !== undefined && !isObject(fx.stubs)) {
    throw new FixtureError(`${where}: stubs must be an object of node id → response`, FORM);
  }
}

/** Run every fixture through the pipeline in `file`, one after another. Throws TestPrepareError or FixtureError. */
export async function testPipeline(opts: TestOptions): Promise<TestReport> {
  const file = resolve(opts.file);
  const source = opts.source ?? readFileSync(file, "utf8");
  const diagnostics = check(source, { file, home: opts.home });
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new TestPrepareError(`${opts.file} has ${errors.length} error(s)`, diagnostics);
  const pipeline = load(source, file).value as Pipeline;
  const refused = gaps(pipeline).filter((g) => g.level === "refuse");
  if (refused.length) {
    throw new TestPrepareError(`${pipeline.name} uses features this runner does not implement yet`, [], refused);
  }
  let plan: Plan;
  try {
    plan = await compile(pipeline, TEST_VERSION, dirname(file));
  } catch (e) {
    throw new TestPrepareError(`${pipeline.name} can't be prepared: ${(e as Error).message}`);
  }
  if (opts.stubs !== undefined && !isObject(opts.stubs)) {
    throw new FixtureError("stubs must be an object of node id → response");
  }
  const seen = new Set<string>();
  for (const fx of opts.fixtures) {
    validateFixture(fx);
    if (seen.has(fx.name)) {
      throw new FixtureError(`two fixtures are named '${fx.name}'`, "fixture names are packet ids; make them unique");
    }
    seen.add(fx.name);
  }

  installClock();
  const now = opts.now ?? TEST_NOW;
  const results = await clock.run(now, async () => {
    const out: FixtureResult[] = [];
    for (const fx of opts.fixtures) out.push(await runFixture(plan, fx, opts, now));
    return out;
  });
  const counts = Object.fromEntries(TEST_OUTCOMES.map((o) => [o, 0])) as Record<TestOutcome, number>;
  for (const r of results) counts[r.outcome]++;
  return { pipeline: pipeline.name, fixtures: results, counts };
}

/** Nodes a stub stands in for: agent nodes and transforms other than `map` and `fn.*`. */
function stubbable(pipeline: Pipeline): string[] {
  return Object.entries(pipeline.nodes ?? {})
    .filter(([, n]) => {
      const kind = nodeKind(n);
      if (kind === "agent") return true;
      return kind === "transform" && n.transform !== "map" && !FN_REF.test(n.transform as string);
    })
    .map(([id]) => id);
}

const OUTCOME_OF: Record<string, UnitOutcome> = {
  dead_letter: "dead_lettered",
  drop: "filtered",
  agent: "escalated",
  pause: "paused",
  halt: "halted",
};
const RANK: UnitOutcome[] = ["failed", "halted", "paused", "escalated", "dead_lettered", "delivered", "filtered"];

async function runFixture(plan: Plan, fx: Fixture, opts: TestOptions, now: number): Promise<FixtureResult> {
  const pipeline = plan.pipeline;
  const env = opts.env ?? {};
  const secrets = Object.fromEntries(Object.keys(pipeline.secrets ?? {}).map((k) => [k, SECRET]));
  const where = `fixtures/${basename(fx.file ?? `${fx.name}.json`)}`;
  const result: FixtureResult = { fixture: fx.name, outcome: "filtered", units: [], taps: [], calls: [] };
  const stubs: Stubs = { ...(opts.stubs ?? {}), ...(fx.stubs ?? {}) };

  const known = stubbable(pipeline);
  const unknown = Object.keys(stubs).find((id) => !known.includes(id));
  if (unknown !== undefined) {
    result.outcome = "failed";
    result.error = {
      step: unknown,
      code: "stub.unknown",
      message: `stubs.${unknown} names no agent node or transform: http in ${pipeline.name}`,
      hint: known.length ? `nodes that take a stub: ${known.join(", ")}` : `remove stubs.${unknown}`,
    };
    return result;
  }

  const used = new Map<string, number>();
  const take = (id: string, what: string): unknown => {
    if (!Object.hasOwn(stubs, id)) {
      throw new ReplayAbort({
        step: id,
        code: "stub.missing",
        message: `${what} '${id}' has no stub, and a test never calls it`,
        hint: `add stubs.${id} to ${where}: {"data": …, "stubs": {"${id}": <response>}} (a list gives one response per call)`,
      });
    }
    const s = stubs[id];
    const n = used.get(id) ?? 0;
    used.set(id, n + 1);
    if (!Array.isArray(s)) return structuredClone(s);
    if (n >= s.length) {
      throw new ReplayAbort({
        step: id,
        code: "stub.exhausted",
        message: `stubs.${id} has ${s.length} response(s), and call ${n + 1} needs another`,
        hint: `add responses to stubs.${id} in ${where} (one per call, retries and loop passes included)`,
      });
    }
    return structuredClone(s[n]);
  };
  /** `{"$error": "…"}` as a response makes that call fail with the message, so retries and policies can be tested. */
  const respond = (value: unknown): unknown => {
    if (isObject(value) && Object.keys(value).length === 1 && typeof value.$error === "string") {
      throw new Error(value.$error);
    }
    return value;
  };
  const message = (template: string | undefined, ctx: Record<string, unknown>, fallback: string): string => {
    if (!template) return fallback;
    try {
      return String(renderString(template, ctx)).trim();
    } catch (e) {
      return `${fallback} (message template failed: ${(e as Error).message})`;
    }
  };
  const errorOf = (f: ReplayFailure): TestError => {
    const error = {
      message: f.message,
      code: f.code,
      rule: f.rule,
      node: f.step,
      attempts: f.attempts,
      elapsed: formatDuration(0),
    };
    const ctx = { data: f.data, meta: f.meta, env, output: pipeline.output, result: null, error };
    return {
      step: f.step,
      code: f.code,
      message: message(f.policy.message, ctx, f.message),
      ...(f.rule === undefined ? {} : { rule: f.rule }),
      attempts: f.attempts,
      then: f.policy.then,
    };
  };

  interface Entry {
    u: ReplayUnit;
    outcome: UnitOutcome;
    copies?: string[];
    data?: unknown;
    hasData: boolean;
    write?: TestWrite;
    error?: TestError;
    warnings: TestError[];
    steps?: TestStep[];
  }
  const entries = new Map<string, Entry>();
  const writes = new Map<string, TestWrite>();
  const entry = (u: ReplayUnit): Entry => {
    let e = entries.get(u.id);
    if (!e) {
      e = { u, outcome: "filtered", hasData: false, warnings: [] };
      entries.set(u.id, e);
    }
    return e;
  };
  const end = (u: ReplayUnit, outcome: UnitOutcome, data: unknown) => {
    const e = entry(u);
    e.outcome = outcome;
    e.data = data;
    e.hasData = true;
    return e;
  };

  try {
    await replayPacket(
      plan,
      {
        id: fx.name,
        trigger: fx.meta?.trigger ?? pipeline.input.via,
        source: fx.meta?.source ?? SOURCE,
        received_at: fx.meta?.received_at ?? now,
        input: structuredClone(fx.data),
      },
      {
        retry: true,
        env,
        secrets,
        timeout: opts.stepTimeoutMs ?? DRY_RUN_STEP_TIMEOUT,
        rejected: (f) => {
          const inv = pipeline.input.on_invalid;
          const ctx = {
            data: fx.data,
            meta: f.meta,
            env,
            error: { code: f.code, rule: f.rule, message: f.message, node: "input" },
          };
          result.outcome = "rejected";
          result.error = { step: "input", code: f.code, message: message(inv?.message, ctx, f.message), rule: f.rule };
        },
        started: (u, parent) => {
          const e = entry(u);
          if (!opts.trace) return;
          e.steps = parent
            ? [...(entries.get(parent.id)?.steps ?? [])]
            : [{ step: "input", data: structuredClone(fx.data) }];
        },
        stepped: (u, step, data) => {
          if (opts.trace) entry(u).steps?.push({ step, data: structuredClone(data) });
        },
        tap: (u, id, node, s) => {
          const tap = node.tap as string;
          if (plan.fns[tap]) {
            result.taps.push({ unit: u.id, node: id, tap });
            return;
          }
          const w = render(node.with ?? {}, s.ctx(u.data)) as Record<string, unknown>;
          result.taps.push({ unit: u.id, node: id, tap, ...(node.with === undefined ? {} : { with: w }) });
        },
        call: (u, id, node, kind, s) => {
          const w = render(node.with ?? {}, s.ctx(u.data)) as Record<string, unknown>;
          const value = take(id, kind === "agent" ? "agent node" : `transform: ${node.transform}`);
          result.calls.push({ unit: u.id, node: id, kind, attempt: s.attempt, with: w });
          const data = respond(value);
          if (kind === "agent") {
            const schema = plan.agentSchemas[id];
            const mismatch = schema?.validate(data);
            if (mismatch) throw new Error(`agent output does not match ${schema?.path}: ${mismatch}`);
          }
          return data;
        },
        write: (u, s) => {
          const out = pipeline.output;
          const w = render(out.with ?? {}, s.ctx(u.data)) as Record<string, unknown>;
          const write: TestWrite = { key: outputKey(out.to, w, u.id), to: out.to, with: w };
          if (out.to === "sqlite") write.record = SqliteOutput.row({ packetId: u.id, data: u.data, with: w }).values;
          writes.set(u.id, write);
        },
        continued: (u, f) => {
          entry(u).warnings.push({
            step: f.step,
            code: f.code,
            message: f.message,
            attempts: f.attempts,
            then: "continue",
          });
        },
        ended: (u, e) => {
          switch (e.kind) {
            case "written":
              end(u, "delivered", u.data).write = writes.get(u.id);
              break;
            case "filtered":
              end(u, "filtered", u.data);
              break;
            case "branched": {
              const x = entry(u);
              x.outcome = "branched";
              x.copies = e.copies;
              break;
            }
            case "failed":
              end(u, OUTCOME_OF[e.failure.policy.then] ?? "dead_lettered", e.failure.data).error = errorOf(e.failure);
              break;
            case "aborted": {
              const { step, code, message: m, hint } = e.reason;
              end(u, "failed", u.data).error = { step, code, message: m, ...(hint === undefined ? {} : { hint }) };
              break;
            }
          }
        },
      },
    );
  } catch (e) {
    // Not a step failure (a loop's `until` that can't be evaluated): the fixture fails, the run goes on.
    result.outcome = "failed";
    result.error = { step: "replay", code: "internal", message: (e as Error).message };
  }

  for (const e of entries.values()) {
    result.units.push({
      unit: e.u.id,
      branch: e.u.branch,
      outcome: e.outcome,
      path: [...e.u.path],
      ...(e.copies ? { copies: e.copies } : {}),
      ...(e.hasData ? { data: e.data } : {}),
      ...(e.write ? { write: e.write } : {}),
      ...(e.error ? { error: e.error } : {}),
      ...(e.warnings.length ? { warnings: e.warnings } : {}),
      ...(e.steps ? { steps: e.steps } : {}),
    });
  }
  if (result.outcome !== "rejected" && result.outcome !== "failed") {
    const leaves = result.units.filter((u) => u.outcome !== "branched").map((u) => u.outcome);
    result.outcome = (RANK.find((o) => leaves.includes(o)) ?? "filtered") as TestOutcome;
  }
  return result;
}
