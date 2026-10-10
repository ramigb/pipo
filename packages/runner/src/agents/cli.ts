// Whether the CLI agents (docs/spec.md §3.4, D67: `claude_code`, `codex`, `pi`, `opencode`) can run on this machine,
// and which models they offer: what the dashboard's builder shows (probe.ts). The calls themselves run in the Rust
// runner (crates/pipo-runner/src/agents/cli.rs), which makes the same readiness check at start. Each probe runs the CLI
// in its own process group with stdin, stdout and stderr on files, so no pipe has to be drained.
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS } from "@pipo/spec";

export interface CliRun {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  stdin?: string;
  /** Where the process runs; the run's own folder when not given. */
  cwd?: string;
  signal?: AbortSignal;
  /** Kill the process after this many ms. */
  timeoutMs?: number;
  /** The folder for the stdin/stdout/stderr files; a temp folder, removed afterwards, when not given. */
  dir?: string;
  env?: Record<string, string | undefined>;
}

/** Run a command to its exit with stdin, stdout and stderr on files. Rejects only when it can't be started. */
export async function runCli(command: string, args: string[], o: RunOptions = {}): Promise<CliRun> {
  const own = !o.dir;
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "pipo-cli-"));
  const paths = { in: join(dir, "stdin"), out: join(dir, "stdout"), err: join(dir, "stderr") };
  writeFileSync(paths.in, o.stdin ?? "");
  const fds = [openSync(paths.in, "r"), openSync(paths.out, "w"), openSync(paths.err, "w")];
  try {
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: o.cwd ?? dir,
        stdio: fds,
        detached: true,
        env: (o.env ?? process.env) as NodeJS.ProcessEnv,
      });
      let hard: ReturnType<typeof setTimeout> | undefined;
      const group = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {}
      };
      const kill = () => {
        group("SIGTERM");
        hard ??= setTimeout(() => group("SIGKILL"), 2000);
      };
      const timer = o.timeoutMs ? setTimeout(kill, o.timeoutMs) : undefined;
      const done = () => {
        clearTimeout(timer);
        clearTimeout(hard);
        o.signal?.removeEventListener("abort", kill);
      };
      o.signal?.addEventListener("abort", kill, { once: true });
      if (o.signal?.aborted) kill();
      child.once("error", (e) => {
        done();
        reject(e);
      });
      child.once("exit", (code, signal) => {
        done();
        // Whatever the CLI left running in its group (MCP servers, shells) goes with it.
        group("SIGTERM");
        resolve({ code, signal });
      });
    });
    return { ...exit, stdout: readFileSync(paths.out, "utf8"), stderr: readFileSync(paths.err, "utf8") };
  } finally {
    for (const fd of fds) closeSync(fd);
    if (own) rmSync(dir, { recursive: true, force: true });
  }
}

/** The last `n` characters of a CLI's stderr, on one line, for an error message. */
function tail(text: string, n = 300): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/** JSON lines of a CLI's event stream (or one JSON document); lines that aren't JSON (banners, warnings) are skipped. */
function jsonLines(text: string): any[] {
  try {
    return [JSON.parse(text)];
  } catch {}
  const out: any[] = [];
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("{")) continue;
    try {
      out.push(JSON.parse(l));
    } catch {}
  }
  return out;
}

export interface Readiness {
  ready: boolean;
  version?: string;
  reason?: string;
  hint?: string;
}

interface CliSpec {
  /** Logged in (or set up with at least one model), once installed. */
  auth(command: string): Promise<Readiness>;
  models(command: string): Promise<string[]>;
  install: string;
}

const PROBE_MS = 20_000;
const probe = (command: string, args: string[]) => runCli(command, args, { timeoutMs: PROBE_MS });

/** The models offered for Claude (Claude Code takes the aliases too); there is no CLI command that lists them. */
export const CLAUDE_MODELS = [
  "sonnet",
  "opus",
  "haiku",
  "fable",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-haiku-4-5",
  "claude-fable-5-1",
];

const SPECS: Record<string, CliSpec> = {
  claude_code: {
    install:
      "install Claude Code (curl -fsSL https://claude.ai/install.sh | bash, or npm install -g @anthropic-ai/claude-code)",
    async auth(command) {
      const run = await probe(command, ["auth", "status", "--json"]);
      const status = jsonLines(run.stdout)[0];
      if (status?.loggedIn === true) return { ready: true };
      return {
        ready: false,
        reason: "Claude Code is installed but not logged in",
        hint: "run `claude auth login` (or start `claude` and use /login), then try again",
      };
    },
    models: async () => CLAUDE_MODELS,
  },
  codex: {
    install: "install the Codex CLI (npm install -g @openai/codex)",
    async auth(command) {
      const run = await probe(command, ["login", "status"]);
      if (run.code === 0 && /logged in/i.test(run.stdout + run.stderr)) return { ready: true };
      return {
        ready: false,
        reason: "the Codex CLI is installed but not logged in",
        hint: "run `codex login`, then try again",
      };
    },
    async models(command) {
      const run = await probe(command, ["debug", "models"]);
      try {
        const list = JSON.parse(run.stdout)?.models;
        if (!Array.isArray(list)) return [];
        return list
          .filter((m: any) => typeof m?.slug === "string" && (m.visibility ?? "list") === "list")
          .map((m: any) => m.slug as string);
      } catch {
        return [];
      }
    },
  },
  pi: {
    install: "install pi (npm install -g @earendil-works/pi-coding-agent)",
    async auth(command) {
      const models = await SPECS.pi?.models(command);
      if (models?.length) return { ready: true };
      return {
        ready: false,
        reason: "pi has no model with credentials set up",
        hint: "set up a provider in pi (start `pi` and use /login, or export a provider API key), then try again",
      };
    },
    async models(command) {
      const run = await probe(command, ["--list-models"]);
      if (run.code !== 0) return [];
      return run.stdout
        .split("\n")
        .slice(1)
        .map((l) => l.trim().split(/\s+/))
        .filter((c) => c.length >= 2 && c[0] && c[1])
        .map((c) => `${c[0]}/${c[1]}`);
    },
  },
  opencode: {
    install: "install opencode (curl -fsSL https://opencode.ai/install | bash)",
    async auth(command) {
      const models = await SPECS.opencode?.models(command);
      if (models?.length) return { ready: true };
      return {
        ready: false,
        reason: "opencode has no model set up",
        hint: "run `opencode auth login`, then try again",
      };
    },
    async models(command) {
      const run = await probe(command, ["models"]);
      if (run.code !== 0) return [];
      return run.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^[\w.-]+\/\S+$/.test(l));
    },
  },
};

export const CLI_AGENTS = Object.keys(SPECS);

const label = (provider: string) => AGENTS[provider]?.label ?? provider;

/** Whether a CLI agent can run here: installed (answers `--version`) and logged in or set up. */
export async function cliReadiness(provider: string, command: string): Promise<Readiness> {
  const spec = SPECS[provider];
  if (!spec) return { ready: false, reason: `'${provider}' is not a CLI agent` };
  let version: string | undefined;
  try {
    const run = await probe(command, ["--version"]);
    if (run.code !== 0) {
      return {
        ready: false,
        reason: `${label(provider)} is installed but '${command} --version' failed: ${tail(run.stderr || run.stdout) || `exit ${run.code}`}`,
        hint: `check that '${command}' works in a terminal, or point agents.${provider}.command in config.yaml at a working one`,
      };
    }
    version = run.stdout.trim().split("\n")[0];
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      ready: false,
      reason:
        code === "ENOENT"
          ? `${label(provider)} isn't installed here (no '${command}' on PATH)`
          : `'${command}' can't be started: ${(e as Error).message}`,
      hint: `${spec.install}, or point agents.${provider}.command in config.yaml at it`,
    };
  }
  try {
    return { ...(await spec.auth(command)), version };
  } catch (e) {
    return { ready: false, version, reason: `${label(provider)}'s login check failed: ${(e as Error).message}` };
  }
}

/** The models a CLI agent offers here, as its CLI lists them (an empty list when it can't say). */
export async function cliModels(provider: string, command: string): Promise<string[]> {
  try {
    return (await SPECS[provider]?.models(command)) ?? [];
  } catch {
    return [];
  }
}
