// Agents that write and run pipelines (docs/spec.md §9.4, D81) over `/mcp`, driven by the MCP SDK's client against a
// real engine: create_pipeline writes into the workspace and waits for approval, start_pipeline is refused until a
// human approves (REST, or a human start), an edit after approval needs approval again, test_pipeline dry-runs the
// folder's fixtures, scopes and ownership are enforced, agent proposals to agent-written pipelines are held, and
// engine.mcp.auto_approve lets them run at once.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { main } from "../../cli/src/cli";
import { readEngineEntry } from "../src";
import { sandbox, waitFor } from "./helpers";

const PIPOD = join(import.meta.dir, "../src/main.ts");
const box = sandbox();
const home = join(box.root, "home");
const workspace = join(box.root, "pipes");
const pids: number[] = [];
const clients: Client[] = [];

const tokens = {
  author: randomBytes(24).toString("hex"),
  other: randomBytes(24).toString("hex"),
  edit: randomBytes(24).toString("hex"),
};
const ENV = {
  ...process.env,
  PIPO_MCP_TEST_AUTHOR: tokens.author,
  PIPO_MCP_TEST_OTHER: tokens.other,
  PIPO_MCP_TEST_EDIT: tokens.edit,
};
mkdirSync(home, { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(
  join(home, "config.yaml"),
  `engine:
  start_timeout: 10s
  mcp:
    tokens:
      - { name: builder-agent, token: env:PIPO_MCP_TEST_AUTHOR, scope: author }
      - { name: other-agent, token: env:PIPO_MCP_TEST_OTHER, scope: author, pipelines: [greeter, mine] }
      - { name: editor, token: env:PIPO_MCP_TEST_EDIT, scope: edit }
`,
);

const SOURCE = (name: string, note = "hi") => `pipo: 1
name: ${name}
fn: ./fn.ts
input: { via: push }
nodes:
  greet: { from: input, transform: fn.greet }
  note:
    from: greet
    transform: map
    with: { data: { greeting: "\${data.greeting}", note: ${note} } }
output: { from: note, to: file, with: { path: ./out.jsonl, format: jsonl } }
agent:
  control: true
  actions: [stop]
  edit: [nodes.note]
`;
const FILES = {
  "fn.ts": "export function greet(data) {\n  return { greeting: `hello ${data.name}` };\n}\n",
  "fixtures/ada.json": JSON.stringify({ data: { name: "Ada" } }),
};

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

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  const text = res.content[0]?.text ?? "";
  return { text, body: JSON.parse(text) as any, isError: res.isError === true };
}

async function rest(method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "POST" && { body: JSON.stringify(body ?? {}) }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function startEngine(): Promise<string> {
  for (let tries = 1; ; tries++) {
    const log = join(box.root, `pipod.${tries}.log`);
    const proc = Bun.spawn(["bun", PIPOD, "--home", home, "--listen", "0", "--workspace", workspace], {
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
      const wrote = existsSync(log) && readFileSync(log, "utf8").length > 0;
      proc.kill("SIGKILL");
      if (proc.exitCode !== null || wrote || tries === 3) throw e;
      await proc.exited;
    }
  }
}

beforeAll(async () => {
  base = await startEngine();
}, 90_000);

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await Bun.sleep(300);
  box.cleanup();
});

describe("agent-written pipelines", () => {
  test("create_pipeline writes into the workspace and waits for approval; start is refused with a hint", async () => {
    const agent = await connect(tokens.author);
    const tools = (await agent.listTools()).tools.map((t) => t.name);
    for (const t of ["create_pipeline", "test_pipeline", "start_pipeline", "stop_pipeline", "list_approvals"])
      expect(tools).toContain(t);

    const created = await call(agent, "create_pipeline", {
      pipeline: "greeter",
      source: SOURCE("greeter"),
      files: FILES,
      reason: "greet people",
    });
    expect(created.isError).toBe(false);
    const file = join(workspace, "greeter", "greeter.pipo");
    expect(created.body).toMatchObject({
      name: "greeter",
      file,
      files: ["greeter.pipo", "fn.ts", "fixtures/ada.json"],
      approval: { state: "pending", by: "builder-agent" },
    });
    expect(readFileSync(file, "utf8")).toBe(SOURCE("greeter"));
    expect(readFileSync(join(workspace, "greeter", "fn.ts"), "utf8")).toBe(FILES["fn.ts"]);
    expect(statSync(join(home, "approvals.json")).mode & 0o777).toBe(0o600);

    const refused = await call(agent, "start_pipeline", { pipeline: "greeter" });
    expect(refused.isError).toBe(true);
    expect(refused.body.code).toBe("approval_pending");
    expect(refused.body.hint).toContain("pipo approvals approve greeter");
    expect(refused.body.hint).toContain("/ui/#/agents");

    const mine = await call(agent, "list_approvals");
    expect(mine.body.approvals).toMatchObject([{ pipeline: "greeter", state: "pending", state_now: "never started" }]);
    // Another agent sees only its own.
    const other = await connect(tokens.other);
    expect((await call(other, "list_approvals")).body.approvals).toEqual([]);
  });

  test("test_pipeline dry-runs the folder's fixtures before approval", async () => {
    const agent = await connect(tokens.author);
    const r = await call(agent, "test_pipeline", { pipeline: "greeter" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("hello Ada");
    const draft = await call(agent, "test_pipeline", {
      source: SOURCE("draft")
        .replace("fn: ./fn.ts\n", "")
        .replace("transform: fn.greet", "transform: map, with: { data: { greeting: x } }"),
      fixtures: [{ name: "one", data: { name: "x" } }],
    });
    expect(draft.isError).toBe(false);
    const none = await call(agent, "test_pipeline", { source: SOURCE("draft") });
    expect(none.body.code).toBe("bad_request");
  });

  test("refusals: errors write nothing, paths stay in the folder, scopes and ownership hold", async () => {
    const agent = await connect(tokens.author);
    const broken = await call(agent, "create_pipeline", {
      pipeline: "broken",
      source: "pipo: 1\nname: broken\ninput: { via: push }\noutput: { from: nowhere, to: file, with: { path: ./x } }\n",
    });
    expect(broken.isError).toBe(true);
    expect(broken.body.code).toBe("invalid_pipeline");
    expect(broken.body.diagnostics.some((d: any) => d.code === "P010")).toBe(true);
    expect(existsSync(join(workspace, "broken"))).toBe(false);

    for (const path of ["../escape.ts", "/etc/x", ".hidden", "sub/../../x", "other.pipo"]) {
      const r = await call(agent, "create_pipeline", {
        pipeline: "esc",
        source: SOURCE("esc"),
        files: { [path]: "x" },
      });
      expect(r.isError).toBe(true);
      expect(r.body.code).toBe("bad_request");
    }
    expect(existsSync(join(box.root, "escape.ts"))).toBe(false);

    const misnamed = await call(agent, "create_pipeline", { pipeline: "alpha", source: SOURCE("beta"), files: FILES });
    expect(misnamed.body.code).toBe("bad_request");

    const editor = await connect(tokens.edit);
    const scoped = await call(editor, "create_pipeline", { pipeline: "x", source: SOURCE("x") });
    expect(scoped.body.code).toBe("forbidden");
    expect(scoped.body.error).toContain("scope author");

    const other = await connect(tokens.other);
    const overwrite = await call(other, "create_pipeline", { pipeline: "greeter", source: SOURCE("greeter") });
    expect(overwrite.body.code).toBe("forbidden");
    expect(overwrite.body.error).toContain("written by 'builder-agent'");
    const allow = await call(other, "create_pipeline", { pipeline: "elsewhere", source: SOURCE("elsewhere") });
    expect(allow.body.code).toBe("forbidden");
    const start = await call(other, "start_pipeline", { pipeline: "greeter" });
    expect(start.body.code).toBe("not_found"); // not its own, and the engine never ran it

    // A folder a human made is never overwritten.
    mkdirSync(join(workspace, "mine"));
    writeFileSync(join(workspace, "mine", "notes.txt"), "mine");
    const human = await call(other, "create_pipeline", { pipeline: "mine", source: SOURCE("mine"), files: FILES });
    expect(human.body.code).toBe("conflict");
  });

  test("approved over REST it starts; an edit after approval needs approval again; agent proposals are held", async () => {
    const agent = await connect(tokens.author);
    const listed = await rest("GET", "/api/approvals");
    expect(listed.body.auto_approve).toBe(false);
    const entry = listed.body.approvals.find((a: any) => a.name === "greeter");
    expect(entry).toMatchObject({
      state: "pending",
      effective: "pending",
      by: "builder-agent",
      reason: "greet people",
    });
    expect(entry.contents.map((c: any) => c.path)).toEqual(["greeter.pipo", "fn.ts", "fixtures/ada.json"]);
    expect(entry.contents[1].text).toBe(FILES["fn.ts"]);
    expect(entry.effects).toEqual({ writes_files: ["output"] });

    const approved = await rest("POST", "/api/approvals/greeter/approve", { by: "me" });
    expect(approved.status).toBe(200);
    expect(approved.body.approval).toMatchObject({ state: "approved", decided_by: "me" });

    // Edited on disk after approval: pending again.
    const fn = join(workspace, "greeter", "fn.ts");
    writeFileSync(fn, FILES["fn.ts"].replace("hello", "hey"));
    const again = await call(agent, "start_pipeline", { pipeline: "greeter" });
    expect(again.body.code).toBe("approval_pending");
    expect(again.body.error).toContain("changed since it was approved");
    writeFileSync(fn, FILES["fn.ts"]);

    const started = await call(agent, "start_pipeline", { pipeline: "greeter" });
    expect(started.isError).toBe(false);
    expect(started.body.state).toBe("running");
    const status = await call(agent, "get_status", { pipeline: "greeter" });
    expect(status.isError).toBe(false);

    const running = await call(agent, "create_pipeline", { pipeline: "greeter", source: SOURCE("greeter", "v2") });
    expect(running.body.code).toBe("invalid_state");

    const proposal = await call(agent, "propose_change", {
      pipeline: "greeter",
      source: SOURCE("greeter", "v2"),
      base_version: 1,
      reason: "new note",
    });
    expect(proposal.isError).toBe(false);
    expect(proposal.body.held_for_approval).toBe(true);
    expect(proposal.body.state).not.toBe("applied");
    expect((await rest("GET", "/api/pipelines/greeter")).body.version).toBe(1);

    const stopped = await call(agent, "stop_pipeline", { pipeline: "greeter", now: true });
    expect(stopped.isError).toBe(false);
    expect(stopped.body.state).toBe("stopped");
  });

  test("a rewrite is pending again; a human start approves it", async () => {
    const agent = await connect(tokens.author);
    const rewritten = await call(agent, "create_pipeline", {
      pipeline: "greeter",
      source: SOURCE("greeter", "v3"),
      files: { "fn.ts": FILES["fn.ts"] },
    });
    expect(rewritten.isError).toBe(false);
    expect(rewritten.body.approval.state).toBe("pending");
    // The fixture written before and left out now is removed.
    expect(existsSync(join(workspace, "greeter", "fixtures", "ada.json"))).toBe(false);
    expect((await call(agent, "start_pipeline", { pipeline: "greeter" })).body.code).toBe("approval_pending");

    const human = await rest("POST", "/api/pipelines/greeter/start", {});
    expect(human.status).toBe(200);
    expect((await rest("GET", "/api/approvals/greeter")).body).toMatchObject({
      state: "approved",
      decided_by: "human start",
      pipeline_state: "running",
    });
    await rest("POST", "/api/pipelines/greeter/stop", { now: true });

    const rejected = await rest("POST", "/api/approvals/greeter/reject", { reason: "not now" });
    expect(rejected.body.approval).toMatchObject({ state: "rejected", note: "not now" });
    const refused = await call(agent, "start_pipeline", { pipeline: "greeter" });
    expect(refused.body.code).toBe("approval_rejected");
    expect(refused.body.error).toContain("not now");
  });

  test("engine.mcp.auto_approve: saved from the settings route, and pipelines start without a human", async () => {
    const set = await rest("POST", "/api/settings/agents", { auto_approve: true });
    expect(set.body).toEqual({ auto_approve: true });
    expect(readFileSync(join(home, "config.yaml"), "utf8")).toContain("auto_approve: true");
    expect((await rest("GET", "/api/settings")).body.auto_approve).toBe(true);
    expect((await rest("POST", "/api/settings/agents", { auto_approve: "yes" })).status).toBe(400);

    const agent = await connect(tokens.author);
    const created = await call(agent, "create_pipeline", { pipeline: "quick", source: SOURCE("quick"), files: FILES });
    expect(created.body.approval).toMatchObject({ state: "approved", decided_by: "auto_approve" });
    const started = await call(agent, "start_pipeline", { pipeline: "quick" });
    expect(started.isError).toBe(false);
    const proposal = await call(agent, "propose_change", {
      pipeline: "quick",
      source: SOURCE("quick", "v2"),
      base_version: 1,
      reason: "auto",
    });
    expect(proposal.body.held_for_approval).toBeUndefined();
    await call(agent, "stop_pipeline", { pipeline: "quick", now: true });
    await rest("POST", "/api/settings/agents", { auto_approve: false });
  }, 60_000);

  test("pipo approvals lists what agents wrote, and approves and starts it", async () => {
    const agent = await connect(tokens.author);
    await call(agent, "create_pipeline", { pipeline: "via-cli", source: SOURCE("via-cli"), files: FILES });
    const pipo = async (...args: string[]) => {
      const out: string[] = [];
      const { log } = console;
      console.log = (...a: unknown[]) => void out.push(a.join(" "));
      try {
        return { code: await main([...args, "--home", home]), stdout: out.join("\n") };
      } finally {
        console.log = log;
      }
    };
    const listed = await pipo("approvals");
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(/via-cli\s+pending\s+builder-agent/);
    const json = JSON.parse((await pipo("approvals", "--json")).stdout);
    expect(json.approvals.map((a: any) => a.name)).toContain("via-cli");
    const approved = await pipo("approvals", "approve", "via-cli", "--start", "--by", "tester");
    expect(approved.code).toBe(0);
    expect(approved.stdout).toContain("approved via-cli and started it");
    expect((await rest("GET", "/api/pipelines/via-cli")).body.state).toBe("running");
    await rest("POST", "/api/pipelines/via-cli/stop", { now: true });
  }, 60_000);
});
