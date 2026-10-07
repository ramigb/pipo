// CLI agents (docs/spec.md §3.4, D67) against fake CLIs: small Bun scripts that log how they were called (args, stdin,
// working folder) and answer like the real ones. Nothing here runs claude, codex, pi or opencode.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runner, StartError } from "../src";
import { AgentCallError, CliProvider, cliModels, cliReadiness, extractJson, strictSchema } from "../src/agents";
import { sandbox, settled } from "./helpers";

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

interface Fake {
  /** Exact argument strings answered before anything else (probes): stdout and exit code. */
  probes?: Record<string, { stdout?: string; code?: number }>;
  stdout?: string;
  stderr?: string;
  code?: number;
  /** Written to the file after --output-last-message (Codex). */
  last?: string;
  sleep?: number;
}

function setup() {
  const box = sandbox();
  cleanups.push(() => box.cleanup());
  const log = join(box.root, "calls.jsonl");
  /** Write a fake CLI named `name` answering as `fake`; returns its path. */
  const fake = (name: string, f: Fake) => {
    const path = join(box.root, name);
    writeFileSync(
      path,
      `#!${process.execPath}
const fs = require("node:fs");
const f = ${JSON.stringify(f)};
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const at = args.indexOf("--output-schema");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  args, stdin, cwd: process.cwd(), pid: process.pid,
  permission: process.env.OPENCODE_PERMISSION ?? null,
  schema: at >= 0 ? JSON.parse(fs.readFileSync(args[at + 1], "utf8")) : null,
}) + "\\n");
const probe = (f.probes ?? {})[args.join(" ")];
if (probe) { process.stdout.write(probe.stdout ?? ""); process.exit(probe.code ?? 0); }
if (f.sleep) await Bun.sleep(f.sleep);
const last = args.indexOf("--output-last-message");
if (f.last !== undefined && last >= 0) fs.writeFileSync(args[last + 1], f.last);
process.stdout.write(f.stdout ?? "");
process.stderr.write(f.stderr ?? "");
process.exit(f.code ?? 0);
`,
    );
    chmodSync(path, 0o755);
    return path;
  };
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  return { box, fake, calls };
}

const SCHEMA = { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { label: {} } };
const req = (o: Record<string, unknown> = {}) => ({
  model: "",
  prompt: "Classify this",
  schema: SCHEMA as Record<string, unknown>,
  max_tokens: 4096,
  signal: new AbortController().signal,
  ...o,
});
const lines = (...events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;

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

describe("claude_code", () => {
  test("prompt on stdin, schema enforced, tools off and no user setup, in a fresh empty folder", async () => {
    const { fake, calls } = setup();
    const bin = fake("claude", { stdout: claudeResult() });
    const r = await new CliProvider("claude_code", bin).complete(req({ model: "haiku" }));
    expect(r).toEqual({ output: { label: "ok" }, input_tokens: 115, output_tokens: 20, cost_usd: 0.0123 });
    const c = calls()[0];
    expect(c.stdin).toBe("Classify this");
    expect(c.args.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(JSON.parse(c.args[c.args.indexOf("--json-schema") + 1])).toEqual({
      type: "object",
      properties: { label: {} },
    });
    expect(c.args).toContain("--safe-mode");
    expect(c.args).toContain("--no-session-persistence");
    expect(c.args.slice(c.args.indexOf("--tools"), c.args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(c.args.slice(c.args.indexOf("--model"), c.args.indexOf("--model") + 2)).toEqual(["--model", "haiku"]);
    expect(c.cwd).toMatch(/pipo-claude_code-.*\/work$/);
    // The call's folder is gone afterwards.
    expect(existsSync(c.cwd)).toBe(false);
  });

  test("allow_tools and cwd; no model means the CLI's default", async () => {
    const { box, fake, calls } = setup();
    const bin = fake("claude", { stdout: claudeResult() });
    await new CliProvider("claude_code", bin).complete(req({ allow_tools: true, cwd: box.root }));
    const c = calls()[0];
    expect(c.args).not.toContain("--tools");
    expect(c.args).not.toContain("--model");
    expect(c.args.slice(c.args.indexOf("--permission-mode"))).toEqual(["--permission-mode", "bypassPermissions"]);
    expect(c.cwd).toBe(box.root);
  });

  test("an error result fails the call and still reports what it cost", async () => {
    const { fake } = setup();
    const bin = fake("claude", {
      code: 1,
      stdout: claudeResult({ is_error: true, result: "There's an issue with the selected model", total_cost_usd: 0 }),
    });
    const e = await new CliProvider("claude_code", bin).complete(req()).catch((x) => x);
    expect(e).toBeInstanceOf(AgentCallError);
    expect(e.message).toBe("Claude Code: There's an issue with the selected model");
    expect(e.usage).toMatchObject({ input_tokens: 115, cost_usd: 0 });
  });

  test("no JSON at all names the exit code and stderr", async () => {
    const { fake } = setup();
    const bin = fake("claude", { code: 3, stderr: "boom\nreally" });
    await expect(new CliProvider("claude_code", bin).complete(req())).rejects.toThrow(
      "Claude Code exited with code 3: boom really",
    );
  });
});

const LABEL = {
  type: "object",
  properties: { label: { type: "string" }, note: { type: "string" } },
  required: ["label"],
};

describe("codex", () => {
  test("read-only sandbox, strict schema file, answer from the last-message file, tokens from turn.completed", async () => {
    const { fake, calls } = setup();
    const bin = fake("codex", {
      last: '{"label":"ok","note":null}',
      stdout: lines(
        { type: "thread.started" },
        { type: "item.completed", item: { type: "error", message: "Model metadata not found" } },
        { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 16 } },
      ),
    });
    const r = await new CliProvider("codex", bin).complete(req({ model: "gpt-5.5", schema: LABEL }));
    // The optional property strict mode made nullable is dropped again.
    expect(r).toEqual({ output: { label: "ok" }, input_tokens: 1000, output_tokens: 16 });
    const c = calls()[0];
    expect(c.args[0]).toBe("exec");
    expect(c.args.at(-1)).toBe("-");
    expect(c.stdin).toBe("Classify this");
    expect(c.args.slice(c.args.indexOf("--sandbox"), c.args.indexOf("--sandbox") + 2)).toEqual([
      "--sandbox",
      "read-only",
    ]);
    expect(c.args).toContain("--ephemeral");
    expect(c.args).toContain("--skip-git-repo-check");
    expect(c.schema).toEqual({
      type: "object",
      properties: { label: { type: "string" }, note: { anyOf: [{ type: "string" }, { type: "null" }] } },
      required: ["label", "note"],
      additionalProperties: false,
    });
  });

  test("a schema strict mode can't say (an open object) is asked for in the prompt instead", async () => {
    const { fake, calls } = setup();
    const bin = fake("codex", { last: 'Sure: {"anything":1}', stdout: lines({ type: "turn.completed", usage: {} }) });
    const r = await new CliProvider("codex", bin).complete(req({ schema: { type: "object" } }));
    expect(r.output).toEqual({ anything: 1 });
    const c = calls()[0];
    expect(c.args).not.toContain("--output-schema");
    expect(c.stdin).toContain("Answer with only a JSON value that matches this JSON Schema");
  });

  test("strictSchema closes nested objects, keeps arrays and unions, refuses what it can't say", () => {
    expect(
      strictSchema({
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "object", properties: { k: { type: "string" } } } },
          kind: { anyOf: [{ type: "string" }, { type: "integer" }] },
        },
        required: ["tags"],
      }),
    ).toEqual({
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: {
            type: "object",
            properties: { k: { anyOf: [{ type: "string" }, { type: "null" }] } },
            required: ["k"],
            additionalProperties: false,
          },
        },
        kind: { anyOf: [{ anyOf: [{ type: "string" }, { type: "integer" }] }, { type: "null" }] },
      },
      required: ["tags", "kind"],
      additionalProperties: false,
    });
    expect(strictSchema({ type: "object", properties: { x: {} } })).toBeNull();
    expect(
      strictSchema({ type: "object", properties: { x: { type: "string" } }, additionalProperties: true }),
    ).toBeNull();
  });

  test("a non-object schema is asked for as { value } and unwrapped", async () => {
    const { fake, calls } = setup();
    const bin = fake("codex", { last: '{"value":"positive"}', stdout: lines({ type: "turn.completed", usage: {} }) });
    // A plain string schema is wrapped, and the wrapper is strict already.
    const r = await new CliProvider("codex", bin).complete(req({ schema: { type: "string" }, allow_tools: true }));
    expect(r.output).toBe("positive");
    const c = calls()[0];
    expect(c.schema).toEqual({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    });
    expect(c.args[c.args.indexOf("--sandbox") + 1]).toBe("workspace-write");
  });

  test("turn.failed: the API's own message, not the JSON around it", async () => {
    const { fake } = setup();
    const msg = JSON.stringify({ type: "error", status: 400, error: { message: "The 'x' model is not supported" } });
    const bin = fake("codex", { code: 1, stdout: lines({ type: "turn.failed", error: { message: msg } }) });
    await expect(new CliProvider("codex", bin).complete(req())).rejects.toThrow(
      "Codex: The 'x' model is not supported",
    );
  });
});

describe("pi and opencode (schema asked for in the prompt)", () => {
  test("pi: last assistant message, fenced JSON, usage and cost summed over turns", async () => {
    const { fake, calls } = setup();
    const msg = (text: string, input: number, cost: number) => ({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
        usage: { input, output: 5, cacheRead: 1, cacheWrite: 0, cost: { total: cost } },
      },
    });
    const bin = fake("pi", {
      stdout: lines(
        { type: "session" },
        msg("thinking", 10, 0.01),
        { type: "message_end", message: { role: "user" } },
        msg('Here:\n```json\n{"label":"ok"}\n```', 20, 0.02),
      ),
    });
    const r = await new CliProvider("pi", bin).complete(req({ model: "anthropic/claude-haiku-4-5" }));
    expect(r.output).toEqual({ label: "ok" });
    expect(r.input_tokens).toBe(32);
    expect(r.output_tokens).toBe(10);
    expect(r.cost_usd).toBeCloseTo(0.03);
    const c = calls()[0];
    expect(c.args).toContain("--no-tools");
    expect(c.args).toContain("--no-session");
    expect(c.args).toContain("--no-context-files");
    expect(c.stdin).toStartWith("Classify this\n\n---\nAnswer with only a JSON value");
    expect(c.stdin).toContain('{"type":"object","properties":{"label":{}}}');
  });

  test("pi: an errored message fails the call with its message", async () => {
    const { fake } = setup();
    const bin = fake("pi", {
      stdout: lines({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "No API key for provider" },
      }),
    });
    await expect(new CliProvider("pi", bin).complete(req())).rejects.toThrow("pi: No API key for provider");
  });

  test("opencode: last text, tokens and cost from step_finish, every tool denied unless allow_tools", async () => {
    const { fake, calls } = setup();
    const bin = fake("opencode", {
      stdout: lines(
        { type: "step_start", part: {} },
        { type: "text", part: { text: '{"label":"ok"}' } },
        { type: "step_finish", part: { tokens: { input: 7, output: 3, cache: { read: 2, write: 1 } }, cost: 0.5 } },
      ),
    });
    const r = await new CliProvider("opencode", bin).complete(req({ model: "opencode/big-pickle" }));
    expect(r).toEqual({ output: { label: "ok" }, input_tokens: 10, output_tokens: 3, cost_usd: 0.5 });
    const off = calls()[0];
    expect(off.args.slice(0, 3)).toEqual(["run", "--format", "json"]);
    expect(off.args).not.toContain("--auto");
    expect(JSON.parse(off.permission)).toMatchObject({ bash: "deny", edit: "deny", read: "deny" });
    await new CliProvider("opencode", bin).complete(req({ allow_tools: true }));
    const on = calls()[1];
    expect(on.args).toContain("--auto");
    expect(on.permission).toBeNull();
  });

  test("opencode: an error event fails the call", async () => {
    const { fake } = setup();
    const bin = fake("opencode", {
      stdout: lines({ type: "error", error: { name: "ProviderAuthError", data: { message: "no credentials" } } }),
    });
    await expect(new CliProvider("opencode", bin).complete(req())).rejects.toThrow("opencode: no credentials");
  });

  test("extractJson: whole text, a fenced block, or the outermost braces", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Sure!\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('The answer is {"a":{"b":3}} as asked.')).toEqual({ a: { b: 3 } });
    expect(extractJson("[1,2]")).toEqual([1, 2]);
    expect(() => extractJson("no json here")).toThrow("the answer is not JSON: no json here");
  });
});

describe("timeouts", () => {
  test("an aborted call kills the CLI's whole process group and fails at once", async () => {
    const { fake, calls } = setup();
    const bin = fake("codex", { sleep: 30_000 });
    const ctl = new AbortController();
    const started = Date.now();
    setTimeout(() => ctl.abort(), 300);
    await expect(new CliProvider("codex", bin).complete(req({ signal: ctl.signal }))).rejects.toThrow(
      "Codex was stopped (with.timeout)",
    );
    expect(Date.now() - started).toBeLessThan(5000);
    const pid = calls()[0].pid;
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("readiness and models", () => {
  test("not installed: says so and how to fix it", async () => {
    const r = await cliReadiness("codex", "/nonexistent/codex");
    expect(r.ready).toBe(false);
    expect(r.reason).toBe("Codex isn't installed here (no '/nonexistent/codex' on PATH)");
    expect(r.hint).toContain("npm install -g @openai/codex");
    expect(r.hint).toContain("agents.codex.command");
  });

  test("installed but not logged in, and logged in", async () => {
    const { fake } = setup();
    const out = fake("codex-out", {
      probes: { "--version": { stdout: "codex-cli 0.1\n" }, "login status": { code: 1 } },
    });
    expect(await cliReadiness("codex", out)).toEqual({
      ready: false,
      version: "codex-cli 0.1",
      reason: "the Codex CLI is installed but not logged in",
      hint: "run `codex login`, then try again",
    });
    const inn = fake("codex-in", {
      probes: { "--version": { stdout: "codex-cli 0.1\n" }, "login status": { stdout: "Logged in using ChatGPT\n" } },
    });
    expect(await cliReadiness("codex", inn)).toEqual({ ready: true, version: "codex-cli 0.1" });
    const claude = fake("claude", {
      probes: {
        "--version": { stdout: "2.1 (Claude Code)\n" },
        "auth status --json": { stdout: '{"loggedIn":false}' },
      },
    });
    const r = await cliReadiness("claude_code", claude);
    expect(r.reason).toBe("Claude Code is installed but not logged in");
    expect(r.hint).toContain("claude auth login");
  });

  test("pi and opencode are ready when they list a model", async () => {
    const { fake } = setup();
    const table = "provider  model  context\nanthropic claude-haiku-4-5 200K\nopenai gpt-5.5 400K\n";
    const pi = fake("pi", { probes: { "--version": { stdout: "1.0.0" }, "--list-models": { stdout: table } } });
    expect(await cliModels("pi", pi)).toEqual(["anthropic/claude-haiku-4-5", "openai/gpt-5.5"]);
    expect((await cliReadiness("pi", pi)).ready).toBe(true);
    const none = fake("pi-none", { probes: { "--version": { stdout: "1.0.0" }, "--list-models": { stdout: "" } } });
    expect(await cliReadiness("pi", none)).toMatchObject({
      ready: false,
      reason: "pi has no model with credentials set up",
    });
    const oc = fake("opencode", {
      probes: {
        "--version": { stdout: "1.18" },
        models: { stdout: "\u001b[0mopencode/big-pickle\nopencode-go/glm-5.1\n" },
      },
    });
    expect(await cliModels("opencode", oc)).toEqual(["opencode-go/glm-5.1"]);
  });

  test("codex lists the models its catalog shows, claude_code offers the Claude aliases", async () => {
    const { fake } = setup();
    const catalog = JSON.stringify({
      models: [
        { slug: "gpt-hidden", visibility: "hide" },
        { slug: "gpt-5.6-luna", visibility: "list" },
        { slug: "gpt-5.5", visibility: "list" },
      ],
    });
    const codex = fake("codex", { probes: { "debug models": { stdout: catalog } } });
    expect(await cliModels("codex", codex)).toEqual(["gpt-5.6-luna", "gpt-5.5"]);
    expect((await cliModels("claude_code", "claude")).slice(0, 3)).toEqual(["sonnet", "opus", "haiku"]);
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

  test("the CLI from agents.<provider>.command runs per packet; usage journaled at the reported cost", async () => {
    const { box, fake, calls } = setup();
    box.write("label.schema.json", JSON.stringify({ type: "object", properties: { label: { type: "string" } } }));
    mkdirSync(join(box.root, "data"));
    mkdirSync(box.home, { recursive: true });
    const bin = fake("claude", {
      // Pretty-printed, as the real CLI prints it.
      probes: {
        "--version": { stdout: "2.1 (Claude Code)" },
        "auth status --json": { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }, null, 2) },
      },
      stdout: claudeResult(),
    });
    writeFileSync(join(box.home, "config.yaml"), `agents:\n  claude_code:\n    command: ${bin}\n`);
    const file = box.write("p.pipo", pipeline("claude_code", ", cwd: ./data"));
    const runner = await Runner.open({ file, home: box.home, log: () => {} });
    await runner.start();
    cleanups.push(() => runner.stop());
    const r = await runner.intake({ subject: "printer on fire" }, { trigger: "push", source: "test" });
    if (r.status !== "accepted") throw new Error(JSON.stringify(r));
    expect((await settled(runner, r.packet_id)).state).toBe("delivered");
    expect(JSON.parse(readFileSync(join(box.root, "out.jsonl"), "utf8").trim()).data).toEqual({ label: "ok" });
    const call = calls().find((c) => c.args[0] === "-p");
    expect(call.stdin).toBe('Classify {"subject":"printer on fire"}');
    expect(call.cwd).toBe(join(box.root, "data"));
    const usage = runner.journal.events(r.packet_id).find((e) => e.type === "agent.usage");
    expect(usage?.detail).toMatchObject({ provider: "claude_code", model: "", input_tokens: 115, cost_usd: 0.0123 });
  });

  test("a CLI that isn't logged in refuses the start with the reason and the fix", async () => {
    const { box, fake } = setup();
    box.write("label.schema.json", JSON.stringify({ type: "object" }));
    mkdirSync(box.home, { recursive: true });
    const bin = fake("codex", { probes: { "--version": { stdout: "codex-cli 0.1" }, "login status": { code: 1 } } });
    writeFileSync(join(box.home, "config.yaml"), `agents:\n  codex:\n    command: ${bin}\n`);
    const file = box.write("p.pipo", pipeline("codex"));
    const e = await Runner.open({ file, home: box.home, log: () => {} }).catch((x) => x);
    expect(e).toBeInstanceOf(StartError);
    expect(e.message).toContain(
      "agent node 'classify' uses Codex (agent: codex), which can't run here: the Codex CLI is installed but not logged in",
    );
    expect(e.message).toContain("codex login");
  });
});
