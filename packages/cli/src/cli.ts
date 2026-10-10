// `pipo` CLI dispatch (docs/spec.md §6). Every command that reports supports --json.
// Separate from main.ts so tests can call it in-process.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { runForeground } from "@pipo/runner";
import { buildSchema, checkProject, type Diagnostic, displayPath, formatDiagnostic, summarize } from "@pipo/spec";
import { commandHelp, renderCommandHelp, renderHelp } from "./commands";
import { cmdCompile, fnDiagnostic } from "./compile";
import { cmdAttach, cmdEngine, cmdRunners } from "./engine-cmds";
import { badOption, CliError, errorJson, fail, setCommand, setJsonMode, usageError as usage } from "./errors";
import { formatPipo } from "./fmt";
import { generateNode } from "./generate";
import { cmdLogs, cmdPause, cmdRestart, cmdResume, cmdStart, cmdStatus, cmdStop } from "./lifecycle";
import { newPipeline } from "./new";
import { cmdAck, cmdDlq, cmdInspect, cmdPackets, cmdPush } from "./packets";
import { cmdProposals, cmdResolve } from "./proposals";
import { listTemplates } from "./templates";
import { cmdTest } from "./test-cmd";
import { trust } from "./trust";
import { cmdUi } from "./ui";
import { cmdDiff, cmdHistory, cmdRollback } from "./versions";

/** `main`, with a thrown error reported: text on stderr, or `{ok:false,error,hint,code}` on stdout under `--json`. */
export async function runCli(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (e) {
    if (argv.includes("--json")) console.log(JSON.stringify(errorJson(e)));
    else {
      console.error(`pipo: ${(e as Error).message}`);
      if (e instanceof CliError && e.hint) console.error(`  hint: ${e.hint}`);
    }
    return 1;
  }
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  setJsonMode(argv.includes("--json"));
  setCommand(command);
  if (command === undefined || command === "--help" || command === "-h") return showHelp();
  if (command === "help") return showHelp(rest[0]);
  if (!commandHelp(command)) return unknown(command);
  if (rest.includes("--help") || rest.includes("-h")) return showHelp(command);
  try {
    return await dispatch(command, rest);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_")) {
      return badOption(((e as Error).message.split(/\. (?=To specify)/)[0] ?? "bad option").replace(/\.$/, ""));
    }
    throw e;
  }
}

async function dispatch(command: string, rest: string[]): Promise<number> {
  switch (command) {
    case "check":
      return cmdCheck(rest);
    case "compile":
      return cmdCompile(rest);
    case "run":
      return cmdRun(rest);
    case "new":
      return cmdNew(rest);
    case "generate":
      return cmdGenerate(rest);
    case "templates":
      return cmdTemplates(rest);
    case "fmt":
      return cmdFmt(rest);
    case "trust":
      return cmdTrust(rest);
    case "start":
      return cmdStart(rest);
    case "stop":
      return cmdStop(rest);
    case "pause":
      return cmdPause(rest);
    case "resume":
      return cmdResume(rest);
    case "restart":
      return cmdRestart(rest);
    case "status":
      return cmdStatus(rest);
    case "logs":
      return cmdLogs(rest);
    case "runners":
      return cmdRunners(rest);
    case "attach":
      return cmdAttach(rest);
    case "engine":
      return cmdEngine(rest);
    case "packets":
      return cmdPackets(rest);
    case "inspect":
      return cmdInspect(rest);
    case "dlq":
      return cmdDlq(rest);
    case "push":
      return cmdPush(rest);
    case "history":
      return cmdHistory(rest);
    case "diff":
      return cmdDiff(rest);
    case "rollback":
      return cmdRollback(rest);
    case "ack":
      return cmdAck(rest);
    case "proposals":
      return cmdProposals(rest);
    case "resolve":
      return cmdResolve(rest);
    case "test":
      return cmdTest(rest);
    case "ui":
      return cmdUi(rest);
    default:
      console.log(JSON.stringify(buildSchema(), null, 2));
      return 0;
  }
}

function showHelp(name?: string): number {
  if (name === undefined) console.log(renderHelp());
  else {
    const c = commandHelp(name);
    if (!c) return unknown(name);
    console.log(renderCommandHelp(c));
  }
  return 0;
}

function unknown(name: string): number {
  return fail("unknown_command", 2, `unknown command '${name}'.`, "run pipo --help");
}

function findPipoFiles(target: string, out: string[] = []): string[] {
  const s = statSync(target, { throwIfNoEntry: false });
  if (!s)
    throw new CliError(`no such file or directory: ${target}`, "name a .pipo file or a folder holding .pipo files");
  if (s.isFile()) return [...out, target];
  for (const entry of readdirSync(target)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(target, entry);
    const st = statSync(path);
    if (st.isDirectory()) findPipoFiles(path, out);
    else if (entry.endsWith(".pipo")) out.push(path);
  }
  return out;
}

async function cmdCheck(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean" } } });
  const files = (positionals.length ? positionals : ["."]).flatMap((t) => findPipoFiles(t));
  const results: { file: string; diagnostics: Diagnostic[] }[] = [];
  for (const r of checkProject(files)) {
    // P059: the fn module must bundle for the runner's QuickJS (only checked once the rest is clean).
    if (!r.diagnostics.some((d) => d.severity === "error")) {
      const p059 = await fnDiagnostic(readFileSync(r.file, "utf8"), r.file);
      if (p059) r.diagnostics.push(p059);
      r.diagnostics.sort((a, b) => a.line - b.line || a.col - b.col || a.code.localeCompare(b.code));
    }
    results.push({
      file: displayPath(r.file),
      diagnostics: r.diagnostics.map((d) => ({ ...d, file: displayPath(r.file) })),
    });
  }
  const all = results.flatMap((r) => r.diagnostics);
  const failed = all.some((d) => d.severity === "error");
  if (values.json) {
    console.log(JSON.stringify({ ok: !failed, files: results }, null, 2));
  } else {
    if (!files.length) console.log("no .pipo files found");
    for (const r of results) {
      for (const d of r.diagnostics) console.log(formatDiagnostic(d));
      if (!r.diagnostics.length) console.log(`${r.file}  ok`);
    }
    if (all.length) console.log(`\n${summarize(all)}`);
  }
  return failed ? 1 : 0;
}

function parseSet(pairs: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i < 1) throw new CliError(`--set '${p}' is not key=value`, "write it as --set table=events");
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}

function printDiagnostics(diagnostics: Diagnostic[]) {
  for (const d of diagnostics) console.log(formatDiagnostic(d));
  if (diagnostics.length) console.log(`\n${summarize(diagnostics)}`);
}

function cmdNew(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      template: { type: "string" },
      set: { type: "string", multiple: true },
      dir: { type: "string" },
      home: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const name = positionals[0];
  if (!name) return usage("pipo new <name> [--template <t>] [--set key=value …] [--dir <path>]");
  const r = newPipeline({
    name,
    template: values.template,
    dir: values.dir,
    set: parseSet(values.set),
    home: values.home,
  });
  const rel = relative(process.cwd(), r.dir) ? displayPath(r.dir) : ".";
  const failed = r.diagnostics.some((d) => d.severity === "error");
  if (values.json) {
    console.log(JSON.stringify({ ok: !failed, ...r, dir: rel, file: displayPath(r.file) }, null, 2));
  } else {
    console.log(`Created ${rel}/ from template '${r.template}':`);
    for (const f of r.files) console.log(`  ${f}`);
    printDiagnostics(r.diagnostics);
    console.log(`\nNext: pipo check ${displayPath(r.file)}`);
  }
  return failed ? 1 : 0;
}

function cmdGenerate(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { kind: { type: "string" }, from: { type: "string" }, use: { type: "string" }, json: { type: "boolean" } },
  });
  const [what, pipeline, id] = positionals;
  if (what !== "node") {
    return usage("pipo generate node <pipeline> <id> --kind <kind> [--from <node>]  (only 'node' can be generated)");
  }
  if (!pipeline || !id || !values.kind) {
    return usage("pipo generate node <pipeline> <id> --kind <kind> [--from <node>]");
  }
  const r = generateNode({ pipeline, id, kind: values.kind, from: values.from, use: values.use });
  const failed = r.diagnostics.some((d) => d.severity === "error");
  const file = displayPath(r.file);
  if (values.json) {
    console.log(JSON.stringify({ ok: !failed, ...r, file }, null, 2));
  } else {
    console.log(
      `Added ${r.kind} node '${r.id}' to ${file} (from: ${JSON.stringify(r.from)}, output.from: ${JSON.stringify(r.output_from)})`,
    );
    for (const c of r.created) console.log(`Created ${displayPath(c)}`);
    if (!r.diagnostics.length) console.log(`${file}  ok`);
    printDiagnostics(r.diagnostics);
  }
  return failed ? 1 : 0;
}

function cmdTemplates(args: string[]): number {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" }, home: { type: "string" } } });
  const all = listTemplates({ home: values.home });
  if (values.json) {
    console.log(
      JSON.stringify(
        all.map((t) => ({
          name: t.name,
          source: t.source,
          description: t.description,
          variables: t.variables,
          dir: t.dir,
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  const w = Math.max(...all.map((t) => t.name.length));
  for (const t of all) console.log(`${t.name.padEnd(w)}  ${t.source.padEnd(8)}  ${t.description}`);
  return 0;
}

async function cmdRun(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { listen: { type: "string" }, home: { type: "string" }, "env-allow": { type: "string" } },
  });
  const file = positionals[0];
  if (!file) {
    return usage("pipo run <file> [--listen <port>] [--home <dir>] [--env-allow A,B]");
  }
  return runForeground({
    file,
    listen: values.listen === undefined ? undefined : Number(values.listen),
    home: values.home,
    envAllow: values["env-allow"]?.split(",").filter(Boolean),
  });
}

function cmdFmt(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { check: { type: "boolean" }, json: { type: "boolean" } },
  });
  const files = (positionals.length ? positionals : ["."]).flatMap((t) => findPipoFiles(t));
  const changed: string[] = [];
  const failed: { file: string; message: string; hint?: string }[] = [];
  for (const f of files) {
    const file = displayPath(f);
    const before = readFileSync(f, "utf8");
    try {
      const after = formatPipo(before, file);
      if (after === before) continue;
      changed.push(file);
      if (!values.check) writeFileSync(f, after);
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      failed.push({ file, message: e.message, hint: e.hint });
    }
  }
  const bad = failed.length > 0 || (values.check === true && changed.length > 0);
  if (values.json) {
    console.log(JSON.stringify({ ok: !bad, checked: values.check === true, changed, errors: failed }, null, 2));
    return bad ? 1 : 0;
  }
  for (const f of failed) console.error(`${f.message}\n  hint: ${f.hint}`);
  if (values.check) {
    for (const f of changed) console.log(`would reformat ${f}`);
    if (changed.length) console.log(`\n${changed.length} file(s) need formatting. Run 'pipo fmt' to fix.`);
  } else {
    for (const f of changed) console.log(`formatted ${f}`);
  }
  if (!bad && !changed.length) console.log(`${files.length} file(s) already formatted`);
  return bad ? 1 : 0;
}

function cmdTrust(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { home: { type: "string" }, json: { type: "boolean" } },
  });
  const target = positionals[0];
  if (!target) return usage("pipo trust <template|project-folder> [--home <dir>]");
  const r = trust(target, { home: values.home });
  if (values.json) console.log(JSON.stringify({ ok: true, ...r }, null, 2));
  else {
    console.log(
      r.kind === "template"
        ? `Trusted template '${r.template}' (${r.hash.slice(0, 12)}). Projects scaffolded from it now pass 'pipo check'.`
        : `Trusted ${r.modules.join(", ")} in ${target} (template '${r.template}', ${r.hash.slice(0, 12)}).`,
    );
    console.log(`Recorded in ${r.store}`);
  }
  return 0;
}
