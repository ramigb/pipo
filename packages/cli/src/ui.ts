// `pipo ui [--no-open] [--workspace dir]` (docs/spec.md §6, §8, D61): open the dashboard, which the engine serves at
// /ui. Starts the engine first when none runs (its builder saves new pipelines under --workspace, default the current
// folder); an open dashboard keeps it awake. Warns when the engine is older than Pipo's code here (D64). Prints the
// URL and tries to open it in a browser.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { CliError } from "./errors";
import { connect, findEngine, resolveHome } from "./lifecycle";
import { banner, fancy, flourish, paint, say } from "./tty";

function openBrowser(url: string): void {
  const candidates = process.platform === "darwin" ? ["open"] : ["wslview", "xdg-open"];
  for (const cmd of candidates) {
    try {
      const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
      return;
    } catch {
      // try the next one; opening is best effort
    }
  }
}

export async function cmdUi(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      home: { type: "string" },
      "no-open": { type: "boolean" },
      workspace: { type: "string" },
    },
  });
  const home = resolveHome(values.home);
  const workspace = values.workspace === undefined ? undefined : resolve(values.workspace);
  const before = findEngine(home)?.pid;
  if (!values.json) await banner();
  const ctx = await connect(home, false, { workspace });
  if (!ctx.api) {
    throw new CliError(
      `can't open the dashboard: ${ctx.why ?? "the engine is not reachable"}`,
      `see ${home}/logs/engine.log, then run 'pipo ui' again`,
    );
  }
  const info = await ctx.api.call<{ pid: number; started_at?: string; workspace?: string; code_changed?: boolean }>(
    "GET",
    "/api/engine",
  );
  // Started before Pipo was updated (or too old to tell): the dashboard is served fresh and may need newer routes (D64).
  const outdated = info.code_changed !== false;
  const started = info.pid !== before;
  const url = `http://127.0.0.1:${ctx.api.port}/ui`;
  const elsewhere = workspace !== undefined && info.workspace !== undefined && info.workspace !== workspace;
  if (values.json) {
    console.log(
      JSON.stringify(
        { ok: true, url, started, pid: info.pid, workspace: info.workspace ?? null, engine_outdated: outdated },
        null,
        2,
      ),
    );
  } else {
    // On a terminal, connect() already said it started the engine.
    if (started && !fancy()) say("ok", `started the engine (pid ${info.pid})`);
    if (!started) flourish("ok", `engine running (pid ${info.pid}, gateway 127.0.0.1:${ctx.api.port})`);
    if (outdated) {
      say(
        "warn",
        `the running engine (pid ${info.pid}${info.started_at ? `, started ${info.started_at}` : ""}) is older than Pipo's code here, so the dashboard may miss features; restart it: pipo engine stop, then pipo ui`,
      );
    }
    if (elsewhere) {
      say(
        "warn",
        `the running engine saves new pipelines under ${info.workspace}, not ${workspace}; restart it from there ('pipo engine stop', then 'pipo ui --workspace ${workspace}')`,
      );
    }
    if (info.workspace) flourish("info", `workspace ${paint().dim(info.workspace)}`);
    // The URL alone on stdout, for scripts; dressed only when stdout is a terminal.
    const p = paint(process.stdout);
    console.log(fancy(process.stdout) ? `${p.cyan("➜")} ${p.bold("dashboard")}  ${p.underline(p.cyan(url))}\n` : url);
  }
  if (!values["no-open"]) openBrowser(url);
  return 0;
}
