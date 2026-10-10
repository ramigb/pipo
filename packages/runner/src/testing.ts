// `pipo test` (docs/spec.md §10.3): run a pipeline against fixture packets. The run itself happens in the Rust
// runner (`pipo-runner test`, crates/pipo-runner/src/testing.rs, on the dry run's replay core), so pipeline semantics
// live in one place; this side reads fixture files, validates them, and turns the binary's reply into a report or an
// error. Filters, routes, loops, fan-out, `map` and `fn` transforms run for real; taps and the output are mocked;
// agent nodes and `transform: http` return stubbed responses. Nothing touches a journal, a port or the disk, and
// secrets render as `***`. Results are deterministic: the packet id is the fixture's name, and `meta.received_at`,
// `now()` and `iso()` read a fixed clock.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Diagnostic } from "@pipo/spec";
import { runBinaryToFiles } from "./binary";

/** A feature the runner can't run yet (crates/pipo-runner/src/support.rs); "refuse" blocks the run. */
export interface Gap {
  path: string;
  feature: string;
  level: "refuse" | "warn";
}

/** The fixed clock of a test run unless `now` is given: 2026-01-01T00:00:00Z. */
export const TEST_NOW = Date.UTC(2026, 0, 1);
/** `meta.version` in a test run: the file under test, as its first version. */
export const TEST_VERSION = 1;
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
  for (const fx of opts.fixtures) validateFixture(fx);
  const input = JSON.stringify({ ...opts, file: resolve(opts.file) });
  const { code, out, err } = await runBinaryToFiles(["test"], input);
  let reply: {
    report?: TestReport;
    error?: { kind: string; message: string; hint?: string; diagnostics?: Diagnostic[]; gaps?: Gap[] };
  };
  try {
    reply = JSON.parse(out);
  } catch {
    throw new Error(`the runner's test mode failed (exit ${code}): ${err.trim() || out.trim() || "no output"}`);
  }
  if (reply.report) return reply.report;
  const e = reply.error ?? { kind: "internal", message: `the runner's test mode failed (exit ${code})` };
  if (e.kind === "fixture") throw new FixtureError(e.message, e.hint);
  if (e.kind === "prepare") throw new TestPrepareError(e.message, e.diagnostics ?? [], e.gaps ?? []);
  throw new Error(e.message);
}
