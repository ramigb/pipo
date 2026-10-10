// Done check D2 (docs/spec.md §12): is Phase 1 complete? Prints `remaining: N` and one line per missing item.
// Exit 0 only when nothing remains. Do not weaken: items may be added, never removed, without human approval.
import { existsSync } from "node:fs";
import { runnerBinary } from "../packages/runner/src/binary";
import { CHECKS, INPUTS, OUTPUTS, TAPS, TRANSFORMS } from "../packages/spec/src/manifests";
import type { Pipeline } from "../packages/spec/src/types";

const root = new URL("..", import.meta.url).pathname;
const missing: string[] = [];

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

// Kinds listed in spec §3 win when the manifests lack one.
const INPUT_KINDS = union(Object.keys(INPUTS), ["http", "schedule", "watch", "push", "system"]);
const TAP_KINDS = union(Object.keys(TAPS), ["log", "http", "file", "emit"]);
const TRANSFORM_KINDS = union(Object.keys(TRANSFORMS), ["map", "http"]);
const OUTPUT_KINDS = union(Object.keys(OUTPUTS), ["sqlite", "file", "http", "stdout"]);
const CHECK_KINDS = union(Object.keys(CHECKS), [
  "ack",
  "record_exists",
  "row_count",
  "query",
  "file_exists",
  "file_nonempty",
  "line_contains",
  "checksum",
  "status",
  "follow_up",
  "external",
  "none",
]);
const FORMATS = ["json", "text", "csv", "form", "bytes"];
const THEN = ["dead_letter", "drop", "continue", "pause", "halt", "agent"];

function base(): any {
  return {
    pipo: 1,
    name: "coverage",
    input: { via: "http" },
    nodes: {},
    output: { from: "input", to: "stdout" },
  };
}

// `top` is merged over the base pipeline, `output` over its output, `n` adds one node the output reads from.
function item(label: string, top: Record<string, any> = {}, output: Record<string, any> = {}, n?: any) {
  const p = base();
  Object.assign(p, top);
  Object.assign(p.output, output);
  if (n) {
    p.nodes.n = n;
    p.output.from = "n";
  }
  items.push({ label, pipeline: p as Pipeline });
}

// The runner's own gaps (crates/pipo-runner/src/support.rs), all items in one call.
const items: { label: string; pipeline: Pipeline }[] = [];
function runnerGaps() {
  const r = Bun.spawnSync([runnerBinary(), "gaps"], {
    stdin: Buffer.from(JSON.stringify(items.map((i) => i.pipeline))),
  });
  if (r.exitCode !== 0) throw new Error(`pipo-runner gaps failed: ${r.stderr.toString()}`);
  const all = JSON.parse(r.stdout.toString()) as { path: string; feature: string; level: string }[][];
  items.forEach(({ label }, i) => {
    for (const g of all[i] ?? []) missing.push(`gap: ${label} — ${g.feature} [${g.level}] at ${g.path}`);
  });
}

for (const via of INPUT_KINDS) item(`input ${via}`, { input: { via } });
for (const format of FORMATS) item(`input format ${format}`, { input: { via: "http", format } });
for (const kind of TAP_KINDS) item(`tap ${kind}`, {}, {}, { from: "input", tap: kind });
for (const kind of TRANSFORM_KINDS) item(`transform ${kind}`, {}, {}, { from: "input", transform: kind });
item("filter node", {}, {}, { from: "input", filter: "true" });
item("route node", {}, {}, { from: "input", route: { a: "true", else: "x" } });
for (const to of OUTPUT_KINDS) item(`output ${to}`, {}, { to });
for (const check of CHECK_KINDS) item(`delivered check ${check}`, { delivered: { check } });
for (const then of THEN) {
  item(`then ${then} (errors)`, { errors: { then } });
  item(`then ${then} (output.on_error)`, {}, { on_error: { then } });
}
item("output batch", {}, { batch: { size: 100, within: "2s" } });
item("lifetime max_packets", { lifetime: { max_packets: 10 } });
item("lifetime until", { lifetime: { until: "stats.delivered >= 1" } });
item("delivered.stall", { delivered: { check: "ack", stall: { after: "5m", then: "pause" } } });
item(
  "fan-out",
  { nodes: { a: { from: "input", tap: "log" }, b: { from: "input", tap: "log" } } },
  { from: ["a", "b"] },
);
item("agent node", {}, {}, { from: "input", agent: "claude_api", with: { prompt: "x", schema: {} } });
item("agent block", { agent: { control: true } });
item("agent_budget block", { agent_budget: { per_day: 5, per_packet: 20000 } });
item("retention block", { retention: { data: "7d", trail: "30d" } });
runnerGaps();

// (b) CLI: no "Planned" line, and every spec §6 command answers --help.
const COMMANDS = [
  "new",
  "generate",
  "templates",
  "check",
  "fmt",
  "test",
  "start",
  "runners",
  "attach",
  "stop",
  "pause",
  "resume",
  "restart",
  "status",
  "logs",
  "packets",
  "inspect",
  "dlq",
  "push",
  "ack",
  "history",
  "diff",
  "rollback",
  "proposals",
  "engine",
  "ui",
  "run",
];
const cli = ["bun", `${root}packages/cli/src/main.ts`];
const help = Bun.spawnSync([...cli, "help"], {
  stdout: "pipe",
  stderr: "pipe",
  timeout: 20_000,
  killSignal: "SIGKILL",
});
if (/planned/i.test(help.stdout.toString())) missing.push("cli: `pipo help` still has a 'Planned' section");
for (const cmd of COMMANDS) {
  const r = Bun.spawnSync([...cli, cmd, "--help"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  if (r.exitCode !== 0) missing.push(`cli: \`pipo ${cmd} --help\` exits ${r.exitCode ?? "timeout"} (spec §6)`);
}

// (c) the planned packages
for (const pkg of ["engine", "ui", "vscode"])
  if (!existsSync(`${root}packages/${pkg}/package.json`)) missing.push(`package: packages/${pkg}/package.json missing`);

console.log(`remaining: ${missing.length}`);
for (const m of missing) console.log(m);
process.exit(missing.length === 0 ? 0 : 1);
