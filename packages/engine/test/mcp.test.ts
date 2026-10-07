// The MCP endpoint `/mcp` (docs/spec.md §9.2, §9.3, D53) driven by the MCP SDK's own client over Streamable HTTP,
// against a real engine and runner processes on a temp home: initialize, the tool list, bearer tokens (missing,
// wrong), scopes and pipeline allowlists, the pipeline's agent policy (control, actions), redaction of secrets and
// `agent.redact` paths, proposals and rollbacks recorded as the agent's, and resources.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readRegistryEntry } from "@pipo/runner";
import { DEFAULT_CONFIG, EngineError, parseConfig, readEngineEntry, type Supervisor } from "../src";
import { McpServer } from "../src/mcp";
import { isAlive, query, sandbox, waitFor } from "./helpers";

const PIPOD = join(import.meta.dir, "../src/main.ts");
const box = sandbox();
const home = join(box.root, "home");
const pids: number[] = [];
const clients: Client[] = [];

// Test-only values, generated per run. They reach pipod (and its runners) only through the spawned engine's
// environment: Bun.spawn does not pass on changes made to this process's env.
const tokens = {
  read: randomBytes(24).toString("hex"),
  operate: randomBytes(24).toString("hex"),
  edit: randomBytes(24).toString("hex"),
};
const SECRET = `sv-${randomBytes(12).toString("hex")}`;
const EMAIL = "ada.lovelace@example.org";
const ENV = {
  ...process.env,
  PIPO_MCP_TEST_READ: tokens.read,
  PIPO_MCP_TEST_OPERATE: tokens.operate,
  PIPO_MCP_TEST_EDIT: tokens.edit,
  PIPO_MCP_TEST_SECRET: SECRET,
};
mkdirSync(home, { recursive: true });
writeFileSync(
  join(home, "config.yaml"),
  `engine:
  start_timeout: 10s
  mcp:
    tokens:
      - { name: reader, token: env:PIPO_MCP_TEST_READ, scope: read, pipelines: [mcpdemo] }
      - { name: operator, token: env:PIPO_MCP_TEST_OPERATE, scope: operate }
      - { name: editor-agent, token: env:PIPO_MCP_TEST_EDIT, scope: edit }
`,
);

const NAME = "mcpdemo";
const SRC = (note: string) => `pipo: 1
name: ${NAME}
input: { via: push }
secrets:
  api_key: env:PIPO_MCP_TEST_SECRET
nodes:
  tag:
    from: input
    transform: map
    with:
      data:
        name: "\${data.name}"
        email: "\${data.email}"
        note: ${note}
        key: "\${secrets.api_key}"
  shout: { from: tag, tap: log }
output: { from: shout, to: file, with: { path: ./${NAME}.jsonl, format: jsonl } }
agent:
  control: true
  actions: [pause, resume, push]
  edit: [nodes.tag]
  redact: [data.email]
`;
const file = box.write(`${NAME}.pipo`, SRC("v1"));
const plain = box.write(
  "plain.pipo",
  `pipo: 1\nname: plain\ninput: { via: push }\noutput: { from: input, to: file, with: { path: ./plain.jsonl, format: jsonl } }\n`,
);

let base = "";

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "pipo-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

/** A tool call's JSON text result, with its error flag. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  const text = res.content[0]?.text ?? "";
  return { text, body: JSON.parse(text) as any, isError: res.isError === true };
}

/** Start pipod on a free gateway port with the test env; output to log files, found through run/engine.json. */
async function startEngine(): Promise<string> {
  for (let tries = 1; ; tries++) {
    const log = join(box.root, `pipod.${tries}.log`);
    const proc = Bun.spawn(["bun", PIPOD, "--home", home, "--listen", "0"], {
      env: ENV,
      stdout: Bun.file(log),
      stderr: Bun.file(`${log}.err`),
    });
    pids.push(proc.pid);
    try {
      return await waitFor(
        async () => {
          if (proc.exitCode !== null)
            throw new Error(`pipod exited (${proc.exitCode}): ${readFileSync(`${log}.err`, "utf8")}`);
          const entry = readEngineEntry(home);
          if (entry?.pid !== proc.pid || !entry.listen) return null;
          const res = await fetch(`http://127.0.0.1:${entry.listen}/api/engine`).catch(() => null);
          return res?.ok && ((await res.json()) as { ready: boolean }).ready
            ? `http://127.0.0.1:${entry.listen}`
            : null;
        },
        20_000,
        "pipod",
      );
    } catch (e) {
      // Under WSL Bun occasionally hangs loading modules before writing anything; only that is retried.
      const wrote = existsSync(log) && readFileSync(log, "utf8").length > 0;
      proc.kill("SIGKILL");
      if (proc.exitCode !== null || wrote || tries === 3) throw e;
      await proc.exited;
    }
  }
}

async function start(path: string) {
  const res = await fetch(`${base}/api/pipelines`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: path }),
  });
  if (res.status !== 201) throw new Error(`start ${path}: ${res.status} ${await res.text()}`);
  const entry = readRegistryEntry(home, ((await res.json()) as { name: string }).name);
  if (entry) pids.push(entry.pid);
}

beforeAll(async () => {
  base = await startEngine();
  await start(file);
  await start(plain);
}, 90_000);

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
  for (const name of [NAME, "plain"]) {
    const entry = readRegistryEntry(home, name);
    if (entry) pids.push(entry.pid);
  }
  for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  box.cleanup();
});

describe("/mcp", () => {
  test("initialize negotiates a 2025-06-18+ revision and tools/list has every §9.2 tool", async () => {
    const client = await connect(tokens.edit);
    expect(client.getServerVersion()?.name).toBe("pipo");
    expect(client.getServerCapabilities()).toMatchObject({ tools: {}, resources: {} });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of [
      "list_pipelines",
      "get_status",
      "get_events",
      "inspect_packet",
      "list_dlq",
      "replay",
      "push",
      "ack",
      "pause",
      "resume",
      "check_pipo",
      "propose_change",
      "get_proposal",
      "rollback",
    ])
      expect(names).toContain(name);
    expect(names).toContain("resolve"); // D50
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
    await client.ping();
  }, 30_000);

  test("a missing or wrong bearer token is 401 with a hint, and the client can't connect", async () => {
    const rpc = { jsonrpc: "2.0", id: 1, method: "ping" };
    const send = (headers: Record<string, string>) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify(rpc),
      });
    const missing = await send({});
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    expect(((await missing.json()) as any).hint).toContain("Authorization: Bearer");
    const wrong = await send({ authorization: `Bearer ${randomBytes(24).toString("hex")}` });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as any).error).toContain("matches no MCP token");
    await expect(connect("not-a-token-at-all")).rejects.toThrow();
    // Not JSON-RPC over GET: no SSE stream is offered.
    expect((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${tokens.read}` } })).status).toBe(405);
    // A web page can't reach it.
    expect((await send({ authorization: `Bearer ${tokens.read}`, origin: "https://evil.example" })).status).toBe(403);
  }, 30_000);

  test("read tools: list_pipelines honours the allowlist, get_status needs agent.control", async () => {
    const editor = await connect(tokens.edit);
    const all = await call(editor, "list_pipelines");
    expect(all.isError).toBe(false);
    const byName = Object.fromEntries(all.body.pipelines.map((p: any) => [p.name, p]));
    expect(byName[NAME]).toMatchObject({ state: "running", agent_control: true });
    expect(byName.plain).toMatchObject({ agent_control: false });

    const reader = await connect(tokens.read);
    const mine = await call(reader, "list_pipelines");
    expect(mine.body.pipelines.map((p: any) => p.name)).toEqual([NAME]);
    const hidden = await call(reader, "get_status", { pipeline: "plain" });
    expect(hidden).toMatchObject({ isError: true, body: { code: "not_found" } });

    const status = await call(reader, "get_status", { pipeline: NAME });
    expect(status.isError).toBe(false);
    expect(status.body).toMatchObject({ name: NAME, state: "running", runner: { status: "active" } });

    const off = await call(editor, "get_status", { pipeline: "plain" });
    expect(off).toMatchObject({ isError: true, body: { code: "forbidden" } });
    expect(off.body.error).toContain("agent.control");
    expect(off.body.hint).toContain("agent: { control: true }");
  }, 30_000);

  test("scopes and agent.actions are enforced, with hints", async () => {
    const reader = await connect(tokens.read);
    const push = await call(reader, "push", { pipeline: NAME, data: { name: "x" } });
    expect(push).toMatchObject({ isError: true, body: { code: "forbidden" } });
    expect(push.body.error).toContain("scope operate");
    expect(push.body.hint).toContain("engine.mcp.tokens");

    const operator = await connect(tokens.operate);
    const propose = await call(operator, "propose_change", {
      pipeline: NAME,
      source: SRC("v9"),
      base_version: 1,
      reason: "x",
    });
    expect(propose).toMatchObject({ isError: true, body: { code: "forbidden" } });
    // `replay` is not in this pipeline's agent.actions.
    const replay = await call(operator, "replay", { pipeline: NAME, all: true });
    expect(replay).toMatchObject({ isError: true, body: { code: "forbidden" } });
    expect(replay.body.error).toContain("agent.actions");
    const badArgs = await call(operator, "push", { pipeline: NAME });
    expect(badArgs).toMatchObject({ isError: true, body: { code: "bad_request" } });
    expect(badArgs.body.error).toContain("needs `data`");
  }, 30_000);

  test("operate: pause and resume as the agent; push, then reads redact secrets and agent.redact paths", async () => {
    const operator = await connect(tokens.operate);
    const paused = await call(operator, "pause", { pipeline: NAME });
    expect(paused.isError).toBe(false);
    const journal = join(home, "pipelines", NAME, "journal.db");
    const ev = query(journal, "SELECT detail FROM events WHERE type = 'pipeline.paused' ORDER BY seq DESC LIMIT 1");
    expect(JSON.parse(ev?.[0]?.detail ?? "{}").reason).toBe("agent");
    expect((await call(operator, "resume", { pipeline: NAME })).isError).toBe(false);

    const pushed = await call(operator, "push", { pipeline: NAME, data: { name: "Ada", email: EMAIL } });
    expect(pushed.isError).toBe(false);
    const id = pushed.body.packet_id as string;
    await waitFor(
      () => query(journal, "SELECT state FROM packets WHERE id = ?", id)?.[0]?.state === "delivered",
      15_000,
      "delivered",
    );

    const trace = await call(operator, "inspect_packet", { pipeline: NAME, packet_id: id });
    expect(trace.isError).toBe(false);
    expect(trace.body.packet.data).toMatchObject({ name: "Ada", email: "[redacted]", note: "v1" });
    const reads = [
      trace.text,
      (await call(operator, "inspect_packet", { pipeline: NAME })).text,
      (await call(operator, "get_events", { pipeline: NAME, limit: 1000 })).text,
      (await call(operator, "list_dlq", { pipeline: NAME })).text,
    ];
    // The log tap journaled the whole data as text; the email is masked there too.
    expect(reads[2]).toContain('\\"name\\":\\"Ada\\"');
    for (const text of reads) {
      expect(text).not.toContain(EMAIL);
      expect(text).not.toContain(SECRET);
      for (const t of Object.values(tokens)) expect(text).not.toContain(t);
    }
  }, 60_000);

  test("propose_change and rollback are recorded author_kind agent with the token's name", async () => {
    const editor = await connect(tokens.edit);
    const done = await call(editor, "propose_change", {
      pipeline: NAME,
      source: SRC("v2"),
      base_version: 1,
      reason: "note v2",
    });
    expect(done.isError).toBe(false);
    expect(done.body).toMatchObject({
      state: "applied",
      applied_version: 2,
      author: "editor-agent",
      author_kind: "agent",
    });
    // A self-declared `by_kind` can't be smuggled in: the tool takes no such argument.
    const smuggle = await call(editor, "propose_change", {
      pipeline: NAME,
      source: SRC("v3"),
      base_version: 2,
      reason: "x",
      by_kind: "human",
    });
    expect(smuggle).toMatchObject({ isError: true, body: { code: "bad_request" } });

    const proposal = await call(editor, "get_proposal", { pipeline: NAME, id: done.body.id });
    expect(proposal.body).toMatchObject({ id: done.body.id, author_kind: "agent" });

    const back = await call(editor, "rollback", { pipeline: NAME, version: 1 });
    expect(back.isError).toBe(false);
    expect(back.body).toMatchObject({ rollback_to: 1, state: "applied", applied_version: 3, author_kind: "agent" });

    const versions = await editor.readResource({ uri: `pipo://pipelines/${NAME}/versions` });
    const list = JSON.parse((versions.contents[0] as { text: string }).text).versions as any[];
    expect(list.find((v) => v.version === 2)).toMatchObject({ author: "editor-agent", author_kind: "agent" });
    expect(list.find((v) => v.version === 3)).toMatchObject({ author: "editor-agent", author_kind: "agent" });
  }, 60_000);

  test("check_pipo returns diagnostics with hints", async () => {
    const reader = await connect(tokens.read);
    const bad = await call(reader, "check_pipo", {
      source: "pipo: 1\nname: bad\ninput: { via: push }\noutput: { from: nope, to: stdout }\n",
    });
    expect(bad.isError).toBe(false);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.diagnostics.map((d: any) => d.code)).toContain("P010");
    const good = await call(reader, "check_pipo", { source: SRC("v5"), pipeline: NAME });
    expect(good.body).toMatchObject({ ok: true, errors: 0 });
  }, 30_000);

  test("resources: the JSON Schema, the spec, connector schemas and pipeline sources", async () => {
    const reader = await connect(tokens.read);
    const { resources } = await reader.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("pipo://schema/pipo.schema.json");
    expect(uris).toContain("pipo://docs/spec.md");
    expect(uris).toContain("pipo://connectors/output/sqlite");
    expect(uris).toContain(`pipo://pipelines/${NAME}/source`);
    expect(uris).not.toContain("pipo://pipelines/plain/source");
    const { resourceTemplates } = await reader.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain("pipo://pipelines/{name}/versions/{version}");

    const schema = await reader.readResource({ uri: "pipo://schema/pipo.schema.json" });
    const json = JSON.parse((schema.contents[0] as { text: string }).text);
    expect(json.properties).toHaveProperty("nodes");

    const source = await reader.readResource({ uri: `pipo://pipelines/${NAME}/source` });
    const text = (source.contents[0] as { text: string }).text;
    expect(text).toContain(`name: ${NAME}`);
    expect(text).toContain("env:PIPO_MCP_TEST_SECRET");
    const v1 = await reader.readResource({ uri: `pipo://pipelines/${NAME}/versions/1` });
    expect((v1.contents[0] as { text: string }).text).toContain("note: v1");

    const spec = await reader.readResource({ uri: "pipo://docs/spec.md" });
    expect((spec.contents[0] as { text: string }).text).toContain("### 9.2 Agent endpoint");
    const sqlite = await reader.readResource({ uri: "pipo://connectors/output/sqlite" });
    expect(JSON.parse((sqlite.contents[0] as { text: string }).text)).toMatchObject({ kind: "output", name: "sqlite" });

    await expect(reader.readResource({ uri: "pipo://pipelines/plain/source" })).rejects.toThrow(/-32002/);
    await expect(reader.readResource({ uri: "pipo://nope" })).rejects.toThrow(/not found/);
  }, 30_000);

  test("with the pipeline stopped, reads come from the journal and are still redacted", async () => {
    const res = await fetch(`${base}/api/pipelines/${NAME}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const reader = await connect(tokens.read);
    const page = await call(reader, "inspect_packet", { pipeline: NAME, state: "delivered" });
    expect(page.body.source).toBe("journal");
    const id = page.body.packets[0].packet_id as string;
    const trace = await call(reader, "inspect_packet", { pipeline: NAME, packet_id: id });
    expect(trace.body).toMatchObject({ source: "journal", packet: { data: { email: "[redacted]" } } });
    const events = await call(reader, "get_events", { pipeline: NAME, limit: 1000 });
    for (const text of [page.text, trace.text, events.text]) {
      expect(text).not.toContain(EMAIL);
      expect(text).not.toContain(SECRET);
    }
    // Writes need the runner, and say so.
    const operator = await connect(tokens.operate);
    const pause = await call(operator, "pause", { pipeline: NAME });
    expect(pause.isError).toBe(true);
    expect(pause.body.hint.length).toBeGreaterThan(5);
  }, 60_000);
});

describe("engine.mcp config and token resolution", () => {
  test("tokens are references with a scope; literal values are refused without echoing them", () => {
    const ok = parseConfig(
      "engine:\n  mcp:\n    tokens:\n      - { name: a, token: op://Pipo/mcp/a, scope: edit, pipelines: [x] }\n      - { name: b, token: env:B_TOKEN }\n",
    );
    expect(ok.mcp.tokens).toEqual([
      { name: "a", token: "op://Pipo/mcp/a", scope: "edit", pipelines: ["x"] },
      { name: "b", token: "env:B_TOKEN", scope: "read", pipelines: null },
    ]);
    expect(DEFAULT_CONFIG.mcp.tokens).toEqual([]);
    const literal = "sk-live-0123456789abcdef0123";
    const err = (() => {
      try {
        parseConfig(
          `engine:\n  mcp:\n    tokens:\n      - { name: a, token: ${literal} }\n      - { name: a, token: env:X, scope: admin, extra: 1 }\n`,
        );
      } catch (e) {
        return e as EngineError;
      }
    })();
    expect(err).toBeInstanceOf(EngineError);
    expect(err?.message).toContain("must be a secret reference");
    expect(err?.message).not.toContain(literal);
    expect(err?.message).toContain("scope must be one of read, operate, edit");
    expect(err?.message).toContain("unknown key 'extra'");
    expect(err?.message).toContain("is used by another token");
  });

  test("no usable token: /mcp refuses with 403 and says why; a short or unresolvable token is logged, not used", async () => {
    const lines: string[] = [];
    const fake = { home: box.root, touch() {}, list: () => [], get: () => undefined } as unknown as Supervisor;
    const ping = (server: McpServer) =>
      server.handle(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer whatever-whatever-whatever" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        }),
      );
    const none = await ping(new McpServer({ engine: fake, tokens: [], api: async () => ({ status: 500, body: {} }) }));
    expect(none.status).toBe(403);
    expect(((await none.json()) as any).hint).toContain("engine.mcp.tokens");

    process.env.PIPO_MCP_TEST_SHORT = "short";
    const bad = new McpServer({
      engine: fake,
      tokens: [
        { name: "tiny", token: "env:PIPO_MCP_TEST_SHORT", scope: "read", pipelines: null },
        { name: "gone", token: "env:PIPO_MCP_TEST_UNSET_VAR", scope: "read", pipelines: null },
      ],
      api: async () => ({ status: 500, body: {} }),
      log: (level, message) => lines.push(`${level} ${message}`),
    });
    const res = await ping(bad);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toContain("none of the 2 MCP token(s)");
    expect(lines.join("\n")).toContain("'tiny' is shorter than 16 characters");
    expect(lines.join("\n")).toContain("'gone' is not usable");
    expect(lines.join("\n")).not.toContain("short\n");
  });
});
