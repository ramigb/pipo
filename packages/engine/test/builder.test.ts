// The dashboard builder's API (docs/spec.md §8, D62): catalog, workspace files, open (with fixtures), a live check of
// a source or a pipeline value written onto its base, save (only .pipo files in the workspace or of a known
// pipeline), and a traced test run of a draft.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Supervisor } from "../src";
import { isAlive, sandbox, testConfig } from "./helpers";

const box = sandbox();
const ws = join(box.root, "ws");
let engine: Supervisor;
let base: string;

const PIPE = `# a comment to keep
pipo: 1
name: shout

input:
  via: push # by hand

nodes:
  shout:
    from: input
    transform: map
    with:
      data: { b: "\${data.a}" }

output:
  from: shout
  to: stdout
`;

beforeAll(async () => {
  mkdirSync(join(ws, "shout", "fixtures"), { recursive: true });
  mkdirSync(join(ws, "node_modules", "x"), { recursive: true });
  mkdirSync(join(ws, ".hidden"), { recursive: true });
  writeFileSync(join(ws, "shout", "shout.pipo"), PIPE);
  writeFileSync(join(ws, "shout", "fixtures", "one.json"), JSON.stringify({ a: 1 }));
  writeFileSync(join(ws, "shout", "fixtures", "two.json"), JSON.stringify({ data: { a: 2 }, meta: { source: "t" } }));
  writeFileSync(join(ws, "shout", "fixtures", "stubs.json"), JSON.stringify({}));
  writeFileSync(join(ws, "broken.pipo"), "a: [");
  writeFileSync(join(ws, "node_modules", "x", "skip.pipo"), PIPE);
  writeFileSync(join(ws, ".hidden", "skip.pipo"), PIPE);
  engine = await Supervisor.open({
    home: join(box.root, "home"),
    config: { ...testConfig(), listen: 0 },
    log: () => {},
    workspace: ws,
  });
  base = engine.gateway?.url as string;
});

afterAll(async () => {
  const pids = engine.list().flatMap((r) => (r.pid ? [r.pid] : []));
  await Promise.race([engine.shutdown({ now: true }), Bun.sleep(10_000)]);
  for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  box.cleanup();
});

const get = async (path: string) => {
  const r = await fetch(`${base}/api/builder/${path}`);
  return { status: r.status, body: (await r.json()) as any };
};
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${base}/api/builder/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
};

test("catalog: connectors with their with: schemas, node kinds and then values", async () => {
  const { status, body } = await get("catalog");
  expect(status).toBe(200);
  expect(body.workspace).toBe(ws);
  expect(Object.keys(body.inputs)).toEqual(["http", "schedule", "watch", "push", "pipeline", "system", "telegram"]);
  expect(body.inputs.watch.with.required).toEqual(["path"]);
  expect(body.inputs.telegram.sample.from.username).toBe("ada");
  expect(body.inputs.http.sample).toBeUndefined();
  expect(body.taps.log.description).toBeString();
  expect(Object.keys(body.transforms)).toEqual(["map", "http", "exec"]);
  expect(body.agents.claude_api.with.required).toContain("prompt");
  expect(body.outputs.sqlite).toMatchObject({ batch: true, checks: ["record_exists", "row_count", "query"] });
  expect(body.checks.ack).toBeDefined();
  expect(body.node_kinds).toEqual(["tap", "transform", "filter", "route", "agent"]);
  expect(body.then).toContain("dead_letter");
  expect((await fetch(`${base}/api/builder/catalog`, { method: "POST" })).status).toBe(405);
});

test("catalog: agents carry their label, how they run and their default timeout (D67)", async () => {
  const { body } = await get("catalog");
  expect(Object.keys(body.agents)).toEqual(["claude_api", "claude_code", "codex", "pi", "opencode"]);
  expect(body.agents.claude_api).toMatchObject({ label: "Claude API", runs: "api", timeout: "60s" });
  expect(body.agents.codex).toMatchObject({ label: "Codex", runs: "cli", timeout: "5m" });
  expect(body.agents.codex.with.properties.allow_tools).toEqual({ type: "boolean" });
});

test("agents: which agents can run here, why not, and their models (D67)", async () => {
  // A logged-in fake codex with a model catalog; the other CLIs point at nothing.
  const codex = join(box.root, "fake-codex");
  const catalog = JSON.stringify({
    models: [
      { slug: "gpt-a", visibility: "list" },
      { slug: "x", visibility: "hide" },
    ],
  });
  writeFileSync(
    codex,
    `#!${process.execPath}\nconst a = process.argv.slice(2).join(" ");\n` +
      `if (a === "--version") console.log("codex-cli 9.9");\n` +
      `else if (a === "login status") console.log("Logged in using ChatGPT");\n` +
      `else if (a === "debug models") console.log(${JSON.stringify(catalog)});\n`,
  );
  chmodSync(codex, 0o755);
  writeFileSync(
    join(box.root, "home", "config.yaml"),
    `agents:\n  claude_api:\n    api_key: env:PIPO_TEST_UNSET_KEY\n  codex:\n    command: ${codex}\n` +
      "  claude_code:\n    command: /nonexistent/claude\n  pi:\n    command: /nonexistent/pi\n  opencode:\n    command: /nonexistent/opencode\n",
  );
  const { status, body } = await get("agents?refresh=1");
  expect(status).toBe(200);
  expect(body.checked_at).toBeString();
  expect(body.agents.codex).toEqual({
    label: "Codex",
    runs: "cli",
    ready: true,
    version: "codex-cli 9.9",
    models: ["gpt-a"],
  });
  expect(body.agents.claude_code).toMatchObject({
    ready: false,
    reason: "Claude Code isn't installed here (no '/nonexistent/claude' on PATH)",
    models: [],
  });
  expect(body.agents.claude_code.hint).toContain("agents.claude_code.command");
  expect(body.agents.claude_api).toMatchObject({
    ready: false,
    reason: "PIPO_TEST_UNSET_KEY isn't set where the engine runs, so Claude API has no API key",
  });
  expect(body.agents.claude_api.models).toContain("claude-sonnet-5-5");
  // Cached until refreshed.
  writeFileSync(join(box.root, "home", "config.yaml"), "");
  expect((await get("agents")).body.checked_at).toBe(body.checked_at);
});

test("files: .pipo files of the workspace, skipping node_modules and dot folders", async () => {
  const { body } = await get("files");
  expect(body).toEqual({
    workspace: ws,
    files: [
      { file: join(ws, "broken.pipo"), rel: "broken.pipo", name: null },
      { file: join(ws, "shout", "shout.pipo"), rel: "shout/shout.pipo", name: "shout" },
    ],
  });
});

test("open: source, value, diagnostics and fixtures; refuses files outside the workspace", async () => {
  const file = join(ws, "shout", "shout.pipo");
  const { status, body } = await get(`open?file=${encodeURIComponent(file)}`);
  expect(status).toBe(200);
  expect(body.file).toBe(file);
  expect(body.source).toBe(PIPE);
  expect(body.pipeline.nodes.shout.transform).toBe("map");
  expect(body.diagnostics).toEqual([]);
  expect(body.fixtures).toEqual([
    { name: "one", data: { a: 1 } },
    { name: "two", data: { a: 2 }, meta: { source: "t" } },
  ]);
  expect(body.stubs).toEqual({});
  expect(body.running).toBeNull();

  const outside = box.write("outside.pipo", PIPE);
  const refused = await get(`open?file=${encodeURIComponent(outside)}`);
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe("forbidden");
  expect(refused.body.hint).toContain("--workspace");
  expect((await get(`open?file=${encodeURIComponent(join(ws, "nope.pipo"))}`)).status).toBe(404);
  expect((await get("open?pipeline=nope")).status).toBe(404);
  expect((await get("open?file=relative.pipo")).status).toBe(400);
});

test("check: a source, or a pipeline value written onto its base with its comments kept", async () => {
  const src = await post("check", { source: PIPE });
  expect(src.status).toBe(200);
  expect(src.body).toMatchObject({ source: PIPE, ok: true, diagnostics: [] });

  const value = structuredClone(src.body.pipeline);
  value.output.to = "file";
  value.output.with = { path: "./out.jsonl" };
  const edited = await post("check", { pipeline: value, base: PIPE });
  expect(edited.status).toBe(200);
  expect(edited.body.ok).toBe(true);
  expect(edited.body.source).toContain("# a comment to keep");
  expect(edited.body.source).toContain("via: push # by hand");
  expect(edited.body.source).toContain("  to: file\n  with:\n    path: ./out.jsonl\n");

  const broken = await post("check", { source: PIPE.replace("from: shout", "from: nowhere") });
  expect(broken.status).toBe(200);
  expect(broken.body.ok).toBe(false);
  expect(broken.body.diagnostics.map((d: any) => d.code)).toContain("P010");

  expect((await post("check", {})).status).toBe(400);
  expect((await post("check", { source: PIPE, pipeline: value })).status).toBe(400);
  expect((await post("check", { source: PIPE, nope: 1 })).status).toBe(400);
});

test("save: new files in the workspace, overwrite on request; refuses the rest", async () => {
  const file = join(ws, "new", "deep", "fresh.pipo");
  const created = await post("save", { file, source: PIPE });
  expect(created.status).toBe(200);
  expect(created.body).toEqual({ file, created: true, diagnostics: [] });
  expect(readFileSync(file, "utf8")).toBe(PIPE);

  const again = await post("save", { file, source: `${PIPE}# more\n` });
  expect(again.status).toBe(409);
  expect(again.body.code).toBe("conflict");
  const over = await post("save", { file, source: `${PIPE}# more\n`, overwrite: true });
  expect(over.body.created).toBe(false);
  expect(readFileSync(file, "utf8")).toEndWith("# more\n");

  const outside = await post("save", { file: join(box.root, "elsewhere", "x.pipo"), source: PIPE });
  expect(outside.status).toBe(403);
  expect(existsSync(join(box.root, "elsewhere"))).toBe(false);
  const traversal = await post("save", { file: `${ws}/../escape.pipo`, source: PIPE });
  expect(traversal.status).toBe(403);
  expect(existsSync(join(box.root, "escape.pipo"))).toBe(false);
  mkdirSync(join(box.root, "target"));
  symlinkSync(join(box.root, "target"), join(ws, "link"));
  const linked = await post("save", { file: join(ws, "link", "x.pipo"), source: PIPE });
  expect(linked.status).toBe(403);
  expect(existsSync(join(box.root, "target", "x.pipo"))).toBe(false);
  expect((await post("save", { file: join(ws, "x.txt"), source: PIPE })).status).toBe(400);
  expect((await post("save", { file: "x.pipo", source: PIPE })).status).toBe(400);
  expect((await post("save", { file: join(ws, "big.pipo"), source: "#".repeat(1024 * 1024 + 1) })).status).toBe(413);
});

test("save and open: the file of a pipeline the engine knows, even outside the workspace", async () => {
  mkdirSync(join(box.root, "known"));
  const file = join(box.root, "known", "known.pipo");
  writeFileSync(file, PIPE.replace("name: shout", "name: known"));
  await engine.start(file);
  const opened = await get("open?pipeline=known");
  expect(opened.status).toBe(200);
  expect(opened.body.file).toBe(file);
  expect(opened.body.running).toMatchObject({ name: "known", state: "running", version: 1 });
  expect(opened.body.running.version_source).toContain("name: known");
  const saved = await post("save", { file, source: `${opened.body.source}# edited\n`, overwrite: true });
  expect(saved.status).toBe(200);
  expect(readFileSync(file, "utf8")).toEndWith("# edited\n");
  // Only that exact file: a sibling is still outside.
  expect((await post("save", { file: join(box.root, "known", "other.pipo"), source: PIPE })).status).toBe(403);
}, 30_000);

test("test: a traced run of a draft, with a stubbed transform: http; bad drafts and fixtures are refused", async () => {
  const draft = `pipo: 1
name: enrich
input: { via: push }
nodes:
  big: { from: input, filter: "data.n > 1" }
  lookup: { from: big, transform: http, with: { url: "https://example.invalid/\${data.n}" } }
output: { from: lookup, to: stdout }
`;
  const { status, body } = await post("test", {
    source: draft,
    fixtures: [
      { name: "small", data: { n: 1 } },
      { name: "big", data: { n: 2 }, stubs: { lookup: { found: true } } },
    ],
  });
  expect(status).toBe(200);
  expect(body.pipeline).toBe("enrich");
  const [small, big] = body.fixtures;
  expect(small.outcome).toBe("filtered");
  expect(small.units[0].steps).toEqual([{ step: "input", data: { n: 1 } }]);
  expect(big.outcome).toBe("delivered");
  expect(big.units[0].steps).toEqual([
    { step: "input", data: { n: 2 } },
    { step: "big", data: { n: 2 } },
    { step: "lookup", data: { found: true } },
    { step: "output", data: { found: true } },
  ]);
  expect(big.calls[0].with.url).toBe("https://example.invalid/2");

  const missing = await post("test", { source: draft, fixtures: [{ name: "big", data: { n: 2 } }] });
  expect(missing.body.fixtures[0].outcome).toBe("failed");
  expect(missing.body.fixtures[0].units[0].error.code).toBe("stub.missing");

  const invalid = await post("test", {
    source: draft.replace("from: lookup", "from: nowhere"),
    fixtures: [{ name: "a", data: {} }],
  });
  expect(invalid.status).toBe(422);
  expect(invalid.body.code).toBe("invalid_pipeline");
  expect(invalid.body.diagnostics.map((d: any) => d.code)).toContain("P010");

  expect((await post("test", { source: draft, fixtures: [] })).status).toBe(400);
  const dup = await post("test", {
    source: draft,
    fixtures: [
      { name: "a", data: {} },
      { name: "a", data: {} },
    ],
  });
  expect(dup.status).toBe(400);
  expect(dup.body.hint).toBeString();
});

test("schema: an agent node's missing schema file is created next to the pipeline, which clears P014", async () => {
  const file = join(ws, "ask", "ask.pipo");
  const pipeline = {
    pipo: 1,
    name: "ask",
    input: { via: "push" },
    nodes: {
      sum: {
        from: "input",
        agent: "claude_api",
        with: { model: "claude-sonnet-5-5", prompt: "Summarise: ${data}", schema: "./summary.schema.json" },
      },
    },
    output: { from: "sum", to: "stdout" },
    agent_budget: { per_day: 1 },
  };
  const before = await post("check", { pipeline, file });
  expect(before.body.diagnostics.map((d: any) => d.code)).toContain("P014");

  const missing = await get(`schema?file=${encodeURIComponent(file)}&path=./summary.schema.json`);
  expect(missing.body).toMatchObject({ exists: false, schema: null, file: join(ws, "ask", "summary.schema.json") });

  const schema = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] };
  // the pipeline isn't saved yet: its folder in the workspace is created
  const made = await post("schema", { file, path: "./summary.schema.json", schema });
  expect(made.status).toBe(200);
  expect(made.body.created).toBe(true);
  expect(JSON.parse(readFileSync(join(ws, "ask", "summary.schema.json"), "utf8"))).toEqual(schema);
  const after = await post("check", { pipeline, file });
  expect(after.body.diagnostics.map((d: any) => d.code)).not.toContain("P014");
  expect(after.body.ok).toBe(true);

  const read = await get(`schema?file=${encodeURIComponent(file)}&path=./summary.schema.json`);
  expect(read.body).toMatchObject({ exists: true, schema, problem: null });

  // and the dry run validates the stubbed answer against it
  const ran = await post("test", {
    source: after.body.source,
    file,
    fixtures: [{ name: "one", data: { a: 1 }, stubs: { sum: { summary: "short" } } }],
  });
  expect(ran.body.fixtures[0].outcome).toBe("delivered");

  expect((await post("schema", { file, path: "./summary.schema.json", schema })).status).toBe(409);
  expect((await post("schema", { file, path: "./summary.schema.json", schema, overwrite: true })).status).toBe(200);
});

test("schema: refuses paths outside the pipeline's folder, non-JSON names and unusable schemas", async () => {
  const file = join(ws, "ask", "ask.pipo");
  const ok = { type: "object" };
  const no = async (body: unknown, status: number, text: string) => {
    const r = await post("schema", body);
    expect(r.status).toBe(status);
    expect(`${r.body.error} ${r.body.hint}`).toContain(text);
  };
  await no({ file, path: "../escape.schema.json", schema: ok }, 403, "outside the pipeline's folder");
  await no({ file, path: "/tmp/abs.schema.json", schema: ok }, 400, "relative .json path");
  await no({ file, path: "./x.ts", schema: ok }, 400, "relative .json path");
  await no({ file: join(box.root, "elsewhere", "x.pipo"), path: "./s.json", schema: ok }, 403, "outside the workspace");
  await no({ file, path: "./bad.schema.json", schema: { type: "nope" } }, 400, "not a usable JSON Schema");
  await no({ file, path: "./bad.schema.json", schema: [1] }, 400, "not a usable JSON Schema");
  expect(existsSync(join(ws, "ask", "bad.schema.json"))).toBe(false);
  const r = await get(`schema?file=${encodeURIComponent(file)}&path=../escape.json`);
  expect(r.status).toBe(403);
});
