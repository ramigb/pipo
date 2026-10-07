// `pipo test` (docs/spec.md §10.3, D52): run a pipeline's fixtures in-process through testPipeline and compare each
// result with its snapshot, `<fixtures>/__snapshots__/<fixture>.snap.json`. A missing snapshot is written and reported
// as `new`; a different one fails with the changed paths until `--update-snapshots` rewrites it. Run-wide stubs are read
// from `<fixtures>/stubs.json`. Exit 0 only when every fixture passes (or is new or updated).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  FixtureError,
  type FixtureResult,
  loadFixtures,
  type Stubs,
  TestPrepareError,
  type TestReport,
  testPipeline,
} from "@pipo/runner";
import { formatDiagnostic } from "@pipo/spec";
import { CliError } from "./errors";
import { resolveHome, usage } from "./lifecycle";

const USAGE = "pipo test <file|dir> [--fixtures dir] [--update-snapshots] [--json]";
const MAX_DIFF = 8;

type Status = "pass" | "fail" | "new" | "updated";
interface Row {
  name: string;
  status: Status;
  outcome: string;
  diff?: string[];
  error?: string;
}

/** The pipeline file: the argument itself, or the one `.pipo` file in the folder it names. */
function pipelineFile(target: string): string {
  const s = statSync(target, { throwIfNoEntry: false });
  if (!s) throw new CliError(`no such file or directory: ${target}`, "name a .pipo file or the folder holding one");
  if (s.isFile()) return target;
  const files = readdirSync(target).filter((f) => f.endsWith(".pipo"));
  if (files.length !== 1) {
    throw new CliError(
      files.length ? `${target} holds ${files.length} .pipo files` : `${target} holds no .pipo file`,
      "name the pipeline file: pipo test <folder>/<name>.pipo",
    );
  }
  return join(target, files[0] as string);
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Paths (`$.units[0].data.name`) where two JSON values differ, with both sides. */
export function changedPaths(want: unknown, got: unknown, path = "$", out: string[] = []): string[] {
  if (Array.isArray(want) && Array.isArray(got)) {
    for (let i = 0; i < Math.max(want.length, got.length); i++) changedPaths(want[i], got[i], `${path}[${i}]`, out);
  } else if (isObject(want) && isObject(got)) {
    for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
      changedPaths(want[k], got[k], `${path}.${k}`, out);
    }
  } else if (JSON.stringify(want) !== JSON.stringify(got)) {
    const show = (v: unknown) => (v === undefined ? "(missing)" : JSON.stringify(v));
    out.push(`${path}: ${show(want)} → ${show(got)}`);
  }
  return out;
}

function readStubs(dir: string): Stubs | undefined {
  const file = join(dir, "stubs.json");
  if (!existsSync(file)) return undefined;
  const hint = 'stubs.json is an object of node id → response, for example {"classify": {"label": "urgent"}}';
  let stubs: unknown;
  try {
    stubs = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new CliError(`${file}: not valid JSON: ${(e as Error).message}`, hint);
  }
  if (!isObject(stubs)) throw new CliError(`${file} must be an object of node id → response`, hint);
  return stubs;
}

function judge(r: FixtureResult, snapshots: string, update: boolean): Row {
  const row = { name: r.fixture, outcome: r.outcome };
  if (r.outcome === "failed") {
    const e = r.error ?? r.units.find((u) => u.error)?.error;
    const why = e?.message ?? "the fixture could not run";
    return { ...row, status: "fail", error: e?.hint ? `${why} (${e.hint})` : why };
  }
  const file = join(snapshots, `${r.fixture}.snap.json`);
  const text = `${JSON.stringify(r, null, 2)}\n`;
  const write = () => {
    mkdirSync(snapshots, { recursive: true });
    writeFileSync(file, text);
  };
  if (!existsSync(file)) {
    write();
    return { ...row, status: "new" };
  }
  let want: unknown;
  try {
    want = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    want = undefined;
  }
  const diff = changedPaths(want, JSON.parse(text));
  if (!diff.length) return { ...row, status: "pass" };
  if (update) {
    write();
    return { ...row, status: "updated" };
  }
  return { ...row, status: "fail", diff };
}

export async function cmdTest(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      home: { type: "string" },
      fixtures: { type: "string" },
      "update-snapshots": { type: "boolean" },
    },
  });
  if (positionals.length !== 1) return usage(USAGE);
  const target = positionals[0] as string;
  const file = resolve(pipelineFile(target));
  const dir = resolve(values.fixtures ?? join(dirname(file), "fixtures"));
  if (!existsSync(dir)) {
    throw new CliError(
      `no fixtures folder at ${dir}`,
      `add ${join(dir, "<name>.json")} (a packet's data as JSON), or point at another folder with --fixtures`,
    );
  }
  let report: TestReport;
  try {
    const fixtures = loadFixtures(dir);
    if (!fixtures.length) {
      throw new CliError(`${dir} has no fixtures`, "add <name>.json files holding a packet's data (spec §10.3)");
    }
    report = await testPipeline({ file, fixtures, stubs: readStubs(dir), home: resolveHome(values.home) });
  } catch (e) {
    if (e instanceof FixtureError) throw new CliError(e.message, e.hint);
    if (e instanceof TestPrepareError) {
      const lines = [
        ...e.diagnostics.filter((d) => d.severity === "error").map(formatDiagnostic),
        ...e.gaps.map((g) => `${g.path}: ${g.feature} is not implemented yet`),
      ];
      const detail = lines.length ? `\n${lines.join("\n")}` : "";
      throw new CliError(`${e.message}${detail}`, "fix these first; `pipo check` shows them all");
    }
    throw e;
  }
  const snapshots = join(dir, "__snapshots__");
  const rows = report.fixtures.map((r) => judge(r, snapshots, values["update-snapshots"] === true));
  const failed = rows.filter((r) => r.status === "fail").length;
  const passed = rows.length - failed;
  if (values.json) {
    console.log(JSON.stringify({ pipeline: report.pipeline, fixtures: rows, passed, failed }, null, 2));
    return failed ? 1 : 0;
  }
  const mark = { pass: "✓", new: "✓", updated: "✓", fail: "✗" };
  for (const r of rows) {
    const note = r.status === "new" ? " (new snapshot written)" : r.status === "updated" ? " (snapshot updated)" : "";
    console.log(`${mark[r.status]} ${r.name}  ${r.outcome}${note}`);
    if (r.error) console.log(`    ${r.error}`);
    const more = (r.diff?.length ?? 0) - MAX_DIFF;
    for (const d of (r.diff ?? []).slice(0, MAX_DIFF)) console.log(`    ${d}`);
    if (more > 0) console.log(`    … ${more} more`);
    if (r.diff) console.log(`    hint: run pipo test ${target} --update-snapshots if the change is intended`);
  }
  console.log(`${report.pipeline}: ${passed} passed, ${failed} failed`);
  return failed ? 1 : 0;
}
