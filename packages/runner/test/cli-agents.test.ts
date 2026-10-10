// CLI agents (docs/spec.md §3.4, §8, D67) against fake CLIs: small shell scripts that answer the readiness probes and
// a call like the real ones, and log how they were called (args, stdin, working folder). Nothing here runs claude,
// codex, pi or opencode. `probeAgents` (TS, what the dashboard's builder shows) is tested directly; the Rust runner
// runs the CLIs per packet. What each CLI is asked and how its answer is read is unit-tested in agents/cli.rs.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentsConfig } from "@pipo/spec";
import { probeAgents } from "../src";
import { writeConfig } from "./agent-helpers";
import { sandbox, waitFor } from "./helpers";
import { RustRunner } from "./rust";

setDefaultTimeout(60_000);

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

interface Fake {
  /** Exact argument strings answered before anything else (probes): stdout and exit code. */
  probes?: Record<string, { stdout?: string; code?: number }>;
  stdout?: string;
  code?: number;
  /** Seconds to sleep before answering a call. */
  sleep?: number;
}

/** Single-quoted for sh. */
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function setup() {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  /** Write a fake CLI named `name` answering as `fake`; returns its path. Each call logs to `<name>.call.*`. */
  const fake = (name: string, f: Fake) => {
    const path = join(box.root, name);
    const log = join(box.root, `${name}.call`);
    const probes = Object.entries(f.probes ?? {})
      .map(([args, p]) => `  ${q(args)}) printf '%s' ${q(p.stdout ?? "")}; exit ${p.code ?? 0} ;;\n`)
      .join("");
    writeFileSync(
      path,
      `#!/bin/sh
case "$*" in
${probes}esac
echo $$ > ${q(`${log}.pid`)}
pwd > ${q(`${log}.cwd`)}
printf '%s\\n' "$@" > ${q(`${log}.args`)}
cat > ${q(`${log}.stdin`)}
${f.sleep ? `sleep ${f.sleep}\n` : ""}printf '%s' ${q(f.stdout ?? "")}
exit ${f.code ?? 0}
`,
    );
    chmodSync(path, 0o755);
    return path;
  };
  const call = (name: string) => {
    const log = join(box.root, `${name}.call`);
    if (!existsSync(`${log}.stdin`)) return null;
    return {
      args: readFileSync(`${log}.args`, "utf8").split("\n").slice(0, -1),
      stdin: readFileSync(`${log}.stdin`, "utf8"),
      cwd: readFileSync(`${log}.cwd`, "utf8").trim(),
      pid: Number(readFileSync(`${log}.pid`, "utf8")),
    };
  };
  return { box, fake, call };
}

const claudeResult = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: '{"label":"ok"}',
    structured_output: { label: "ok" },
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 5, output_tokens: 20 },
    ...o,
  });

const CLAUDE_READY = {
  "--version": { stdout: "2.1 (Claude Code)" },
  // Pretty-printed, as the real CLI prints it.
  "auth status --json": { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }, null, 2) },
};

describe("probeAgents", () => {
  test("not installed, not logged in, or no API key: says so and how to fix it", async () => {
    const { fake } = setup();
    const codex = fake("codex", {
      probes: {
        "--version": { stdout: "codex-cli 0.1\n" },
        "login status": { code: 1 },
        "debug models": {
          stdout: JSON.stringify({
            models: [
              { slug: "gpt-hidden", visibility: "hide" },
              { slug: "gpt-5.6-luna", visibility: "list" },
              { slug: "gpt-5.5", visibility: "list" },
            ],
          }),
        },
      },
    });
    const claude = fake("claude", {
      probes: {
        "--version": { stdout: "2.1 (Claude Code)\n" },
        "auth status --json": { stdout: '{"loggedIn":false}' },
      },
    });
    const { value } = parseAgentsConfig({
      claude_api: { api_key: "env:PIPO_TEST_NO_KEY" },
      claude_code: { command: claude },
      codex: { command: codex },
      pi: { command: "/nonexistent/pi" },
      opencode: { command: "/nonexistent/opencode" },
    });
    const p = await probeAgents(value, {});
    expect(p.claude_api).toMatchObject({ runs: "api", ready: false });
    expect(p.claude_api?.reason).toBe("PIPO_TEST_NO_KEY isn't set where the engine runs, so Claude API has no API key");
    expect(p.claude_api?.hint).toContain("op://");
    expect(p.codex).toEqual({
      label: "Codex",
      runs: "cli",
      ready: false,
      version: "codex-cli 0.1",
      reason: "the Codex CLI is installed but not logged in",
      hint: "run `codex login`, then try again",
      // Installed: its catalog is listed even while it isn't logged in.
      models: ["gpt-5.6-luna", "gpt-5.5"],
    });
    expect(p.claude_code?.reason).toBe("Claude Code is installed but not logged in");
    expect(p.claude_code?.hint).toContain("claude auth login");
    expect(p.claude_code?.models.slice(0, 3)).toEqual(["sonnet", "opus", "haiku"]);
    expect(p.pi).toMatchObject({
      ready: false,
      reason: "pi isn't installed here (no '/nonexistent/pi' on PATH)",
      models: [],
    });
    expect(p.opencode?.ready).toBe(false);
  });

  test("ready: logged-in CLIs, pi and opencode with a model, an API key that is set", async () => {
    const { fake } = setup();
    const table = "provider  model  context\nanthropic claude-haiku-4-5 200K\nopenai gpt-5.5 400K\n";
    const { value } = parseAgentsConfig({
      claude_api: { api_key: "env:PIPO_TEST_KEY" },
      claude_code: { command: fake("claude", { probes: CLAUDE_READY }) },
      codex: {
        command: fake("codex", {
          probes: {
            "--version": { stdout: "codex-cli 0.1\n" },
            "login status": { stdout: "Logged in using ChatGPT\n" },
          },
        }),
      },
      pi: { command: fake("pi", { probes: { "--version": { stdout: "1.0.0" }, "--list-models": { stdout: table } } }) },
      opencode: {
        command: fake("opencode", {
          probes: {
            "--version": { stdout: "1.18" },
            models: { stdout: "\u001b[0mopencode/big-pickle\nopencode-go/glm-5.1\n" },
          },
        }),
      },
    });
    const p = await probeAgents(value, { PIPO_TEST_KEY: "x" });
    expect(p.claude_api).toMatchObject({ ready: true });
    expect(p.claude_api?.models.every((m) => m.startsWith("claude-"))).toBe(true);
    expect(p.claude_code).toMatchObject({ ready: true, version: "2.1 (Claude Code)" });
    expect(p.codex).toMatchObject({ ready: true, version: "codex-cli 0.1" });
    expect(p.pi).toMatchObject({ ready: true, models: ["anthropic/claude-haiku-4-5", "openai/gpt-5.5"] });
    expect(p.opencode).toMatchObject({ ready: true, models: ["opencode-go/glm-5.1"] });
    // A pi without any model set up isn't ready.
    const none = parseAgentsConfig({
      pi: {
        command: fake("pi-none", { probes: { "--version": { stdout: "1.0.0" }, "--list-models": { stdout: "" } } }),
      },
    });
    expect((await probeAgents(none.value, {})).pi).toMatchObject({
      ready: false,
      reason: "pi has no model with credentials set up",
    });
  });
});

describe("in a pipeline", () => {
  const pipeline = (agent: string, w = "") => `pipo: 1
name: cli-agents
input: { via: push }
nodes:
  classify:
    from: input
    agent: ${agent}
    with: { prompt: "Classify \${json(data)}", schema: ./label.schema.json${w} }
    on_error: { retry: 0, then: dead_letter }
output:
  from: classify
  to: file
  with: { path: ./out.jsonl, format: jsonl }
`;

  async function start(box: ReturnType<typeof sandbox>, src: string) {
    const r = await RustRunner.start(box, box.write("p.pipo", src), "cli-agents", { listen: null });
    cleanups.push(() => (r.proc.exitCode === null ? r.kill() : undefined));
    return r;
  }

  test("the CLI from agents.<provider>.command runs per packet; usage journaled at the reported cost", async () => {
    const { box, fake, call } = setup();
    box.write("label.schema.json", JSON.stringify({ type: "object", properties: { label: { type: "string" } } }));
    mkdirSync(join(box.root, "data"));
    const bin = fake("claude", { probes: CLAUDE_READY, stdout: claudeResult() });
    writeConfig(box.home, { agents: `  claude_code:\n    command: ${bin}\n` });
    const r = await start(box, pipeline("claude_code", ", cwd: ./data"));
    const { packet_id: id } = await r.push({ subject: "printer on fire" });
    expect((await r.settled(id, 10_000)).state).toBe("delivered");
    const out = join(box.root, "out.jsonl");
    await waitFor(() => existsSync(out) && readFileSync(out, "utf8").trim(), 5000, "the output line");
    expect(JSON.parse(readFileSync(out, "utf8").trim()).data).toEqual({ label: "ok" });
    const c = call("claude");
    expect(c?.stdin).toBe('Classify {"subject":"printer on fire"}');
    expect(c?.cwd).toBe(join(box.root, "data"));
    expect(c?.args.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    // No model: the CLI's own default.
    expect(c?.args).not.toContain("--model");
    const usage = r.events(id).find((e) => e.type === "agent.usage");
    expect(usage?.detail).toMatchObject({ provider: "claude_code", model: "", input_tokens: 115, cost_usd: 0.0123 });
    expect((await r.status()).stats.agent_spend_today).toBe(0.0123);
  });

  test("an error result fails the step with the CLI's message", async () => {
    const { box, fake } = setup();
    box.write("label.schema.json", JSON.stringify({ type: "object" }));
    const bin = fake("claude", {
      probes: CLAUDE_READY,
      code: 1,
      stdout: claudeResult({ is_error: true, result: "There's an issue with the selected model", total_cost_usd: 0 }),
    });
    writeConfig(box.home, { agents: `  claude_code:\n    command: ${bin}\n` });
    const r = await start(box, pipeline("claude_code", ", model: nope"));
    const row = await r.settled((await r.push({})).packet_id, 10_000);
    expect(row.state).toBe("dead_lettered");
    expect(row.error?.message).toContain("Claude Code: There's an issue with the selected model");
    expect(r.events(row.id).find((e) => e.type === "agent.usage")?.detail).toMatchObject({
      model: "nope",
      cost_usd: 0,
    });
  });

  test("with.timeout stops the CLI's whole process group and fails the step at once", async () => {
    const { box, fake, call } = setup();
    box.write("label.schema.json", JSON.stringify({ type: "object" }));
    const bin = fake("claude", { probes: CLAUDE_READY, sleep: 30, stdout: claudeResult() });
    writeConfig(box.home, { agents: `  claude_code:\n    command: ${bin}\n` });
    const r = await start(box, pipeline("claude_code", ", timeout: 500ms"));
    const started = Date.now();
    const row = await r.settled((await r.push({})).packet_id, 10_000);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(row.state).toBe("dead_lettered");
    expect(row.error?.message).toContain("agent call timed out after 500ms");
    const pid = call("claude")?.pid as number;
    await waitFor(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      5000,
      "the CLI to be killed",
    );
  });

  test("a CLI that isn't logged in refuses the start with the reason and the fix", async () => {
    const { box, fake } = setup();
    box.write("label.schema.json", JSON.stringify({ type: "object" }));
    const bin = fake("codex", { probes: { "--version": { stdout: "codex-cli 0.1" }, "login status": { code: 1 } } });
    writeConfig(box.home, { agents: `  codex:\n    command: ${bin}\n` });
    const refused = await RustRunner.refuse(box, box.write("p.pipo", pipeline("codex")));
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      "agent node 'classify' uses Codex (agent: codex), which can't run here: the Codex CLI is installed but not logged in",
    );
    expect(refused.stderr).toContain("codex login");
  });
});
