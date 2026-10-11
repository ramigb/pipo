// The agent endpoint (docs/spec.md §9.2, §9.3, §9.4, D53, D81, D82): an MCP server at `/mcp`, Streamable HTTP without
// sessions. A POST carries one JSON-RPC message and gets one JSON answer (a notification gets 202); GET and DELETE are
// 405. Every request needs `Authorization: Bearer <token>`: a token from `engine.mcp.tokens` (resolved from its
// `op://` or `env:` reference when the engine starts, compared in constant time), or an access token of an OAuth grant
// (oauth.ts). A 401 points the client at the OAuth metadata, so it can connect with the human's approval.
// Tools call the gateway's REST handlers in-process (the same checks, runner ops, journal reads and errors), so there
// is no second implementation of any operation. On top of that the endpoint enforces, per tool call:
// - the token's scope (`read` < `operate` < `edit`) and pipeline allowlist (a pipeline outside it does not exist);
// - the pipeline's `agent:` policy of the version in force: `agent.control: true` for every pipeline tool and resource,
//   and `agent.actions` for pause, resume, replay, rerun, push and ack (propose and resolve are checked by the runner, D45, D50);
// - redaction of every result: secrets (those the engine can resolve, plus the MCP tokens themselves), then the
//   pipeline's `agent.redact` paths in packet data, and those fields' values wherever else they appear (log lines,
//   errors), including values read from the journal for every packet the result names.
// Proposals and rollbacks made here are recorded `author_kind: agent` with the token's name as the author.

import { timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FixtureError, Journal, loadFixtures, Secrets } from "@pipo/runner";
import {
  AGENTS,
  buildSchema,
  CHECKS,
  check,
  INPUTS,
  load,
  type Manifest,
  OUTPUTS,
  type Pipeline,
  TAPS,
  TRANSFORMS,
} from "@pipo/spec";
import type { ApprovalView } from "./approvals";
import { createPipeline } from "./authoring";
import { MCP_SCOPES, type McpScope, type McpTokenConfig } from "./config";
import { journalPath } from "./home";
import { HttpError } from "./http-error";
import type { OAuth } from "./oauth";
import type { Supervisor } from "./supervisor";

/** Protocol revisions this server speaks, newest first (Streamable HTTP, 2025-06-18 or later). */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"];
/** Tokens shorter than this are refused when the engine starts: they would be guessable. */
export const MIN_TOKEN_LENGTH = 16;
const MAX_BODY = 4 * 1024 * 1024;
const RESOLVE_TIMEOUT_MS = 30_000;
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const MASK = "[redacted]";
const SPEC_FILE = new URL("../../../docs/spec.md", import.meta.url).pathname;
const GUIDE_DIR = new URL("../../../docs/guide/", import.meta.url).pathname;

/** The guide's pages (docs/guide/*.md), each with the title of its first heading. */
export function guidePages(): { slug: string; title: string }[] {
  let files: string[] = [];
  try {
    files = readdirSync(GUIDE_DIR).filter((f) => /^[a-z0-9-]+\.md$/.test(f));
  } catch {}
  return files.sort().map((f) => {
    const first = readFileSync(join(GUIDE_DIR, f), "utf8").split("\n", 1)[0] ?? "";
    return { slug: f.slice(0, -3), title: first.replace(/^#\s+/, "") || f };
  });
}

/** Every connector as Markdown: what it is, and its `with:` fields (a reading guide next to the JSON Schemas). */
export function connectorsMarkdown(): string {
  const out = [
    "# Connectors",
    "",
    "Every connector, by kind, with its `with:` fields. The full JSON Schema of each is the resource pipo://connectors/<kind>/<name>.",
  ];
  for (const [kind, catalog] of Object.entries(CONNECTORS)) {
    out.push("", `## ${kind}`);
    for (const [name, m] of Object.entries(catalog)) {
      out.push("", `### ${kind} \`${name}\``, "", m.description);
      const w = m.with as {
        properties?: Record<string, { description?: string; type?: unknown }>;
        required?: string[];
      };
      const props = Object.entries(w?.properties ?? {});
      if (!props.length) continue;
      out.push("");
      for (const [key, f] of props) {
        const req = w.required?.includes(key) ? " (required)" : "";
        const type = typeof f.type === "string" ? ` ${f.type}` : "";
        out.push(`- \`${key}\`${type}${req}${f.description ? `: ${f.description}` : ""}`);
      }
    }
  }
  return `${out.join("\n")}\n`;
}

/** One REST call answered in-process by the gateway, exactly as over HTTP. */
export type ApiCall = (
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  /** The agent the call is made for (a start it makes approves nothing, D81). */
  agent?: string,
) => Promise<{ status: number; body: any }>;

export interface McpOptions {
  engine: Supervisor;
  tokens: McpTokenConfig[];
  api: ApiCall;
  /** The gateway's own URL, for links in hints (the dashboard's Agents page). */
  base?: string;
  /** OAuth grants (D82): their access tokens are accepted too. */
  oauth?: OAuth;
  /** Engine log line (token problems at start). */
  log?: (level: string, message: string) => void;
  /** The engine's public URL (D85): its origin may call, and the OAuth challenge names it when addressed by it. */
  publicUrl?: string | null;
}

interface Token {
  name: string;
  scope: McpScope;
  pipelines: string[] | null;
  digest: Buffer;
}

/** A tool's failure, returned as an `isError` result with the REST error shape. */
class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** A JSON-RPC error (protocol level: unknown method or tool, bad params, unknown resource). */
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const digest = (s: string) => Buffer.from(new Bun.CryptoHasher("sha256").update(s).digest());
const rank = (s: McpScope) => MCP_SCOPES.indexOf(s);

// ── tools ────────────────────────────────────────────────────────────────────

type Schema = Record<string, unknown>;
const PIPELINE: Schema = { type: "string", description: "Pipeline name (list_pipelines lists them)" };
const LIMIT: Schema = { type: "integer", minimum: 1, maximum: 1000, description: "Page size (default 50)" };
const AFTER: Schema = { type: "string", description: "The `next` value of the previous page" };

function input(properties: Record<string, Schema>, required: string[] = []): Schema {
  return { type: "object", properties, required, additionalProperties: false };
}

interface ToolContext {
  token: Token;
  args: Record<string, any>;
  /** The pipeline named by `args.pipeline`, after the allowlist and `agent.control` checks. */
  view: View | null;
}

interface Tool {
  name: string;
  title: string;
  description: string;
  scope: McpScope;
  /** Takes `pipeline` (gated by the allowlist and `agent.control`). */
  pipeline: boolean;
  /** The `agent.actions` entry it needs. */
  action?: "pause" | "resume" | "replay" | "rerun" | "push" | "ack";
  readOnly: boolean;
  inputSchema: Schema;
  run(this: McpServer, ctx: ToolContext): Promise<unknown>;
}

const q = (params: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) s.set(k, String(v));
  const text = s.toString();
  return text ? `?${text}` : "";
};
const at = (name: string) => `/api/pipelines/${name}`;

const TOOLS: Tool[] = [
  {
    name: "list_pipelines",
    title: "List pipelines",
    description:
      "The pipelines this engine supervises (that this token may see): state, version, runner pid, port, and whether agents may use it (`agent_control`, the pipeline's agent.control).",
    scope: "read",
    pipeline: false,
    readOnly: true,
    inputSchema: input({}),
    async run({ token }) {
      const { pipelines } = await this.call("GET", "/api/pipelines");
      const out: unknown[] = [];
      for (const p of pipelines as { name: string }[]) {
        if (token.pipelines && !token.pipelines.includes(p.name)) continue;
        const view = this.view(p.name);
        out.push(await this.redact({ ...p, agent_control: view?.pipeline?.agent?.control === true }, view));
      }
      return { pipelines: out };
    },
  },
  {
    name: "get_status",
    title: "Pipeline status",
    description:
      "One pipeline's supervision state and, while it runs, its runner's status: stats (pending, delivered, dead-lettered, escalated…), pause reason, awaiting acks.",
    scope: "read",
    pipeline: true,
    readOnly: true,
    inputSchema: input({ pipeline: PIPELINE }, ["pipeline"]),
    run({ args }) {
      return this.call("GET", at(args.pipeline));
    },
  },
  {
    name: "get_events",
    title: "Pipeline events",
    description:
      "Journal events of one pipeline, oldest first: the last `limit`, or those after `after_seq` (page with `last_id`).",
    scope: "read",
    pipeline: true,
    readOnly: true,
    inputSchema: input(
      {
        pipeline: PIPELINE,
        after_seq: { type: "integer", minimum: 0, description: "Only events after this journal seq" },
        limit: { ...LIMIT, description: "How many (default 100)" },
      },
      ["pipeline"],
    ),
    run({ args }) {
      return this.call("GET", `/api/events${q({ pipeline: args.pipeline, after: args.after_seq, limit: args.limit })}`);
    },
  },
  {
    name: "inspect_packet",
    title: "Inspect packets",
    description:
      "With `packet_id`: that packet's trace through every node (data, timings, attempts, errors, events, fan-out copies). Without it: a page of packets, optionally in one `state` (e.g. escalated, dead_lettered, queued).",
    scope: "read",
    pipeline: true,
    readOnly: true,
    inputSchema: input(
      { pipeline: PIPELINE, packet_id: { type: "string" }, state: { type: "string" }, limit: LIMIT, after: AFTER },
      ["pipeline"],
    ),
    run({ args }) {
      if (args.packet_id !== undefined)
        return this.call("GET", `${at(args.pipeline)}/packets/${encodeURIComponent(args.packet_id)}`);
      return this.call(
        "GET",
        `${at(args.pipeline)}/packets${q({ state: args.state, limit: args.limit, after: args.after })}`,
      );
    },
  },
  {
    name: "list_dlq",
    title: "Dead-letter queue",
    description: "The pipeline's dead-lettered packets with their errors; replay them with `replay`.",
    scope: "read",
    pipeline: true,
    readOnly: true,
    inputSchema: input({ pipeline: PIPELINE, limit: LIMIT, after: AFTER }, ["pipeline"]),
    run({ args }) {
      return this.call("GET", `${at(args.pipeline)}/dlq${q({ limit: args.limit, after: args.after })}`);
    },
  },
  {
    name: "replay",
    title: "Replay dead letters",
    description:
      "Replay dead-lettered packets (`ids`, or `all: true`) from the step they failed at. Needs `replay` in agent.actions and a running pipeline.",
    scope: "operate",
    pipeline: true,
    action: "replay",
    readOnly: false,
    inputSchema: input(
      { pipeline: PIPELINE, ids: { type: "array", items: { type: "string" } }, all: { type: "boolean" } },
      ["pipeline"],
    ),
    run({ args, token }) {
      const body = {
        ...(args.ids !== undefined && { ids: args.ids }),
        ...(args.all !== undefined && { all: args.all }),
      };
      return this.call("POST", `${at(args.pipeline)}/dlq/replay`, { ...body, by: token.name });
    },
  },
  {
    name: "rerun",
    title: "Rerun from a node",
    description:
      "Run settled (delivered or filtered) packets again from node `from` (or `output`) to the output, with the data they had there; the steps before it don't run again. Pick `ids`, or `last`/`since` (a duration)/`all`. Call it with `dry: true` first: the plan lists the packets, those skipped and why, and the steps that will run again (`effect`: spend, external, write). `current: true` runs them on the version in force instead of their own. Needs `rerun` in agent.actions and a running pipeline.",
    scope: "operate",
    pipeline: true,
    action: "rerun",
    readOnly: false,
    inputSchema: input(
      {
        pipeline: PIPELINE,
        from: { type: "string", description: "The node to run again from, or `output`" },
        ids: { type: "array", items: { type: "string" } },
        last: { type: "integer", minimum: 1 },
        since: { type: "string", description: "A duration such as 30m, 1h or 7d" },
        all: { type: "boolean" },
        current: { type: "boolean" },
        dry: { type: "boolean" },
      },
      ["pipeline", "from"],
    ),
    run({ args, token }) {
      const { pipeline, ...body } = args;
      return this.call("POST", `${at(pipeline)}/rerun`, { ...body, by: token.name });
    },
  },
  {
    name: "push",
    title: "Push a packet",
    description:
      "Push one packet (`data`, optional `source`, and `input` when the pipeline has several) into the pipeline; answers with its packet_id once it is journaled. Needs `push` in agent.actions.",
    scope: "operate",
    pipeline: true,
    action: "push",
    readOnly: false,
    inputSchema: input(
      {
        pipeline: PIPELINE,
        data: { description: "The packet's data (any JSON)" },
        source: { type: "string" },
        input: { type: "string", description: "The input's name; needed when the pipeline has several" },
      },
      ["pipeline", "data"],
    ),
    run({ args }) {
      return this.call("POST", `${at(args.pipeline)}/push`, {
        data: args.data,
        ...(args.source !== undefined && { source: args.source }),
        ...(args.input !== undefined && { input: args.input }),
      });
    },
  },
  {
    name: "ack",
    title: "Acknowledge delivery",
    description:
      "Confirm a packet's delivery for a pipeline whose delivery check is `external` (spec §3.10). Needs `ack` in agent.actions.",
    scope: "operate",
    pipeline: true,
    action: "ack",
    readOnly: false,
    inputSchema: input({ pipeline: PIPELINE, packet_id: { type: "string" } }, ["pipeline", "packet_id"]),
    run({ args }) {
      return this.call("POST", `${at(args.pipeline)}/ack`, { packet_id: args.packet_id });
    },
  },
  {
    name: "pause",
    title: "Pause",
    description: "Pause the pipeline (recorded with reason `agent`). Needs `pause` in agent.actions.",
    scope: "operate",
    pipeline: true,
    action: "pause",
    readOnly: false,
    inputSchema: input({ pipeline: PIPELINE }, ["pipeline"]),
    run({ args }) {
      return this.call("POST", `${at(args.pipeline)}/pause`, { reason: "agent" });
    },
  },
  {
    name: "resume",
    title: "Resume",
    description: "Resume a paused pipeline. Needs `resume` in agent.actions.",
    scope: "operate",
    pipeline: true,
    action: "resume",
    readOnly: false,
    inputSchema: input({ pipeline: PIPELINE }, ["pipeline"]),
    run({ args }) {
      return this.call("POST", `${at(args.pipeline)}/resume`, {});
    },
  },
  {
    name: "resolve",
    title: "Resolve escalated packets",
    description:
      "Settle packets handed to the agent (state `escalated`, by `then: agent` or a stall with agent.on_stall: handle): `retry` from where they stopped, `dead_letter` or `drop`. Give unit `ids` or a `packet_id` (spec §9.3, D50).",
    scope: "operate",
    pipeline: true,
    readOnly: false,
    inputSchema: input(
      {
        pipeline: PIPELINE,
        ids: { type: "array", items: { type: "string" } },
        packet_id: { type: "string" },
        action: { type: "string", enum: ["retry", "dead_letter", "drop"] },
        reason: { type: "string" },
      },
      ["pipeline", "action"],
    ),
    run({ args, token }) {
      return this.call("POST", `${at(args.pipeline)}/resolve`, {
        ...(args.ids !== undefined && { ids: args.ids }),
        ...(args.packet_id !== undefined && { packet_id: args.packet_id }),
        action: args.action,
        by: token.name,
        by_kind: "agent",
        ...(args.reason !== undefined && { reason: args.reason }),
      });
    },
  },
  {
    name: "check_pipo",
    title: "Check a .pipo source",
    description:
      "Run `pipo check` on a .pipo source and return its diagnostics (code, message, hint, line). With `pipeline`, file references (fn module, schemas) are checked against that pipeline's folder.",
    scope: "read",
    pipeline: false,
    readOnly: true,
    inputSchema: input({ source: { type: "string" }, pipeline: PIPELINE }, ["source"]),
    async run({ args, token }) {
      let opts: Parameters<typeof check>[1] = { fs: false, home: this.engine.home };
      let view: View | null = null;
      if (args.pipeline !== undefined) {
        view = this.gate(args.pipeline, token);
        const file = this.engine.get(args.pipeline)?.file;
        if (file) opts = { file, home: this.engine.home };
      }
      const diagnostics = check(args.source, opts);
      const errors = diagnostics.filter((d) => d.severity === "error").length;
      return this.redact({ ok: errors === 0, errors, warnings: diagnostics.length - errors, diagnostics }, view);
    },
  },
  {
    name: "propose_change",
    title: "Propose a change",
    description:
      "Propose a new version: the whole .pipo `source` against `base_version` (the version in force), with a short `reason`. It is checked with pipo check and the pipeline's agent.edit paths, dry-run when agent.verify is set, then applied at a safe point unless `apply: false` holds it (spec §9.3). Recorded as made by this agent.",
    scope: "edit",
    pipeline: true,
    readOnly: false,
    inputSchema: input(
      {
        pipeline: PIPELINE,
        source: { type: "string", description: "The whole proposed .pipo file" },
        base_version: { type: "integer", minimum: 1 },
        reason: { type: "string" },
        apply: { type: "boolean", description: "false: store it validated (or verified) without applying" },
      },
      ["pipeline", "source", "base_version", "reason"],
    ),
    async run({ args, token }) {
      const held = this.held(args.pipeline);
      const apply = held ? false : args.apply;
      const result = await this.call("POST", `${at(args.pipeline)}/proposals`, {
        source: args.source,
        base_version: args.base_version,
        reason: args.reason,
        by: token.name,
        by_kind: "agent",
        ...(apply !== undefined && { apply }),
      });
      return held ? { ...result, ...this.heldNote(args.pipeline) } : result;
    },
  },
  {
    name: "get_proposal",
    title: "Change proposals",
    description:
      "With `id`: one change proposal (state, problems, diff, dry-run report). Without it: the pipeline's proposals, optionally in one `state`.",
    scope: "read",
    pipeline: true,
    readOnly: true,
    inputSchema: input({ pipeline: PIPELINE, id: { type: "string" }, state: { type: "string" }, limit: LIMIT }, [
      "pipeline",
    ]),
    run({ args }) {
      if (args.id !== undefined)
        return this.call("GET", `${at(args.pipeline)}/proposals/${encodeURIComponent(args.id)}`);
      return this.call("GET", `${at(args.pipeline)}/proposals${q({ state: args.state, limit: args.limit })}`);
    },
  },
  {
    name: "rollback",
    title: "Roll back",
    description:
      "Make an earlier version's definition the next version. For an agent this is a change proposal of that source against the version in force, so the pipeline's agent.edit paths, pipo check and agent.verify apply as for propose_change.",
    scope: "edit",
    pipeline: true,
    readOnly: false,
    inputSchema: input(
      {
        pipeline: PIPELINE,
        version: { type: "integer", minimum: 1, description: "The version to restore" },
        reason: { type: "string" },
        apply: { type: "boolean" },
      },
      ["pipeline", "version"],
    ),
    async run({ args, token, view }) {
      const latest = view?.version;
      if (latest === undefined || latest === null)
        throw new ToolError("not_found", `'${args.pipeline}' has no versions yet`, `start it once (pipo start <file>)`);
      if (args.version === latest)
        throw new ToolError(
          "invalid_state",
          `v${latest} is already the version in force of '${args.pipeline}'`,
          "list the versions with the resource pipo://pipelines/<name>/versions and pick an earlier one",
        );
      const target = await this.call("GET", `${at(args.pipeline)}/versions/${args.version}`);
      const held = this.held(args.pipeline);
      const apply = held ? false : args.apply;
      const proposal = await this.call("POST", `${at(args.pipeline)}/proposals`, {
        source: target.definition,
        base_version: latest,
        reason: args.reason ?? `rollback to v${args.version}`,
        by: token.name,
        by_kind: "agent",
        ...(apply !== undefined && { apply }),
      });
      return { rollback_to: args.version, ...proposal, ...(held && this.heldNote(args.pipeline)) };
    },
  },
  {
    name: "create_pipeline",
    title: "Create a pipeline",
    description:
      "Write a new pipeline into the engine's workspace as <workspace>/<pipeline>/<pipeline>.pipo, with `files` next to it (an fn module, JSON schemas, fixtures/<case>.json for test_pipeline; relative paths, text). It is checked first: with errors nothing is written and the diagnostics come back. A human then approves it (the dashboard's Agents page, or `pipo approvals approve`) unless the engine auto-approves; start_pipeline waits for that. Rewriting is allowed for a stopped pipeline this agent wrote (it needs approval again); change a running one with propose_change. Add `agent: { control: true, actions: [stop] }` so you can watch and stop it.",
    scope: "author",
    pipeline: false,
    readOnly: false,
    inputSchema: input(
      {
        pipeline: { type: "string", description: "The new pipeline's name (its `name:`)" },
        source: { type: "string", description: "The whole .pipo file" },
        files: {
          type: "object",
          additionalProperties: { type: "string" },
          description: 'Other files by relative path, e.g. {"fn.ts": "…", "fixtures/one.json": "{…}"}',
        },
        reason: { type: "string", description: "What it is for, shown to the human who approves it" },
      },
      ["pipeline", "source"],
    ),
    async run({ args, token }) {
      this.allow(token, args.pipeline);
      const created = authoring(() =>
        createPipeline(this.engine, {
          name: args.pipeline,
          source: args.source,
          files: args.files ?? {},
          by: token.name,
          reason: args.reason ?? null,
        }),
      );
      const { approval, ...rest } = created;
      return { ...rest, approval: this.approvalSummary(approval) };
    },
  },
  {
    name: "test_pipeline",
    title: "Test a pipeline",
    description:
      "Dry-run a pipeline against fixture packets and return each packet's trace through every node. Nothing is called, sent or written: outputs and taps are mocked, exec, http and agent steps answer from `stubs` (or a fixture's stubs), fn steps run for real in the sandbox. Give `pipeline` (one this agent wrote, or one with agent.control; its fixtures/ folder is used when `fixtures` is left out) or a draft `source`. Safe before approval.",
    scope: "read",
    pipeline: false,
    readOnly: true,
    inputSchema: input({
      pipeline: PIPELINE,
      source: { type: "string", description: "A draft .pipo source (instead of `pipeline`)" },
      fixtures: {
        type: "array",
        items: { type: "object" },
        description: 'Packets to run: [{"name": "one", "data": {…}, "stubs": {"<node>": …}}]',
      },
      stubs: { type: "object", description: "Answers of exec, http and agent steps by node id, for every fixture" },
    }),
    async run({ args, token }) {
      if ((args.pipeline === undefined) === (args.source === undefined))
        throw new ToolError("bad_request", "give `pipeline` or `source`, not both", "test_pipeline takes one of them");
      let source = args.source as string | undefined;
      let file: string | undefined;
      let view: View | null = null;
      if (args.pipeline !== undefined) {
        const own = this.own(args.pipeline, token);
        if (!own) view = this.gate(args.pipeline, token);
        file = own?.file ?? this.engine.get(args.pipeline)?.file;
        if (!file)
          throw new ToolError("not_found", `'${args.pipeline}' has no file here`, "test a draft with `source` instead");
        source = readFileSync(file, "utf8");
      }
      let fixtures = args.fixtures as unknown[] | undefined;
      if (fixtures === undefined && file) {
        try {
          fixtures = loadFixtures(join(dirname(file), "fixtures")).map(({ name, data, meta, stubs }) => ({
            name,
            data,
            ...(meta !== undefined && { meta }),
            ...(stubs !== undefined && { stubs }),
          }));
        } catch (e) {
          if (!(e instanceof FixtureError)) throw e;
          throw new ToolError("bad_request", e.message, e.hint ?? "fix the fixture file");
        }
      }
      if (!fixtures?.length)
        throw new ToolError(
          "bad_request",
          "no fixtures to run",
          'pass `fixtures` ([{"name": "one", "data": {…}}]), or write fixtures/<case>.json with create_pipeline',
        );
      const result = await this.call("POST", "/api/builder/test", {
        source,
        ...(file && { file }),
        fixtures,
        ...(args.stubs !== undefined && { stubs: args.stubs }),
      });
      return view ? this.redact(result, view) : result;
    },
  },
  {
    name: "start_pipeline",
    title: "Start a pipeline",
    description:
      "Start a pipeline. One this agent wrote starts once a human approved it (or the engine auto-approves); until then it answers approval_pending. Any other pipeline needs agent.control and `start` in its agent.actions.",
    scope: "author",
    pipeline: false,
    readOnly: false,
    inputSchema: input(
      { pipeline: PIPELINE, ttl: { type: "string", description: "Stop it after this long, e.g. 30m (lifetime.ttl)" } },
      ["pipeline"],
    ),
    async run({ args, token }) {
      const name = args.pipeline as string;
      const own = this.own(name, token);
      let file: string | undefined;
      if (own) {
        if (own.effective === "pending" && this.engine.config.mcp.auto_approve)
          this.engine.approvals.decide(name, "approved", "auto_approve");
        else if (own.effective !== "approved") {
          const summary = this.approvalSummary(own);
          throw new ToolError(
            own.effective === "rejected" ? "approval_rejected" : "approval_pending",
            own.effective === "rejected"
              ? `'${name}' was rejected by ${own.decided_by}${own.note ? `: ${own.note}` : ""}`
              : `'${name}' is waiting for a human's approval${own.changed ? " (its files changed since it was approved)" : ""}`,
            summary.hint,
            { approval: summary },
          );
        }
        file = own.file;
      } else {
        this.gate(name, token, "start");
        file = this.engine.get(name)?.file;
        if (!file)
          throw new ToolError("not_found", `no pipeline named '${name}' in this engine`, "list_pipelines lists them");
      }
      return this.call(
        "POST",
        "/api/pipelines",
        { file, ...(args.ttl !== undefined && { ttl: args.ttl }) },
        token.name,
      );
    },
  },
  {
    name: "stop_pipeline",
    title: "Stop a pipeline",
    description:
      "Stop a pipeline: drain it (in-flight packets finish), or stop at once with `now: true`. Allowed for pipelines this agent wrote, and for others with agent.control and `stop` in their agent.actions.",
    scope: "author",
    pipeline: false,
    readOnly: false,
    inputSchema: input({ pipeline: PIPELINE, now: { type: "boolean" } }, ["pipeline"]),
    run({ args, token }) {
      const name = args.pipeline as string;
      if (!this.own(name, token)) this.gate(name, token, "stop");
      if (!this.engine.get(name))
        throw new ToolError("not_found", `'${name}' has never run in this engine`, "there is nothing to stop");
      return this.call("POST", `${at(name)}/${args.now === true ? "stop" : "drain"}`, {}, token.name);
    },
  },
  {
    name: "list_approvals",
    title: "My pipelines and their approval",
    description:
      "The pipelines this agent wrote with create_pipeline: approval state (pending, approved, rejected; pending again when the files changed since approval), who decided and when, and whether each runs.",
    scope: "read",
    pipeline: false,
    readOnly: true,
    inputSchema: input({}),
    async run({ token }) {
      return {
        auto_approve: this.engine.config.mcp.auto_approve,
        approvals: this.engine.approvals
          .list()
          .filter((a) => a.by === token.name && (!token.pipelines || token.pipelines.includes(a.name)))
          .map((a) => ({ ...this.approvalSummary(a), state_now: this.engine.get(a.name)?.state ?? "never started" })),
      };
    },
  },
];

/** Run an authoring step; its HttpError becomes the tool's error with the same message, hint and code. */
function authoring<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpError) throw new ToolError(e.code, e.message, e.hint, e.extra);
    throw e;
  }
}

/** Check `args` against a tool's input schema (the subset the tools use). */
function validate(tool: Tool, raw: unknown): Record<string, any> {
  const schema = tool.inputSchema as { properties: Record<string, Schema>; required: string[] };
  const takes = Object.keys(schema.properties);
  const shape = takes.length
    ? `it takes ${takes.join(", ")} (required: ${schema.required.join(", ") || "none"})`
    : "it takes none";
  const bad = (message: string) => new ToolError("bad_request", message, `see the tool's inputSchema: ${shape}`);
  if (raw !== undefined && raw !== null && !isMap(raw)) throw bad(`${tool.name} takes an object of arguments`);
  // A null argument is an absent one (some clients send every optional key).
  const args = Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v !== null && v !== undefined));
  for (const key of Object.keys(args)) if (!takes.includes(key)) throw bad(`unknown argument \`${key}\``);
  for (const key of schema.required) if (args[key] === undefined) throw bad(`${tool.name} needs \`${key}\``);
  for (const [key, value] of Object.entries(args)) {
    const s = schema.properties[key] as {
      type?: string;
      enum?: string[];
      minimum?: number;
      maximum?: number;
      items?: { type?: string };
    };
    if (!s.type) continue;
    const n = value as number;
    const item = s.items?.type ?? "string";
    const ok =
      s.type === "array"
        ? Array.isArray(value) && value.every((v) => (item === "object" ? isMap(v) : typeof v === item))
        : s.type === "object"
          ? isMap(value)
          : s.type === "integer"
            ? Number.isInteger(value) &&
              (s.minimum === undefined || n >= s.minimum) &&
              (s.maximum === undefined || n <= s.maximum)
            : typeof value === s.type;
    if (!ok) {
      const range =
        s.minimum !== undefined ? ` from ${s.minimum}${s.maximum !== undefined ? ` to ${s.maximum}` : " up"}` : "";
      throw bad(
        `\`${key}\` must be ${s.type === "array" ? `a list of ${item}s` : `a${s.type === "integer" || s.type === "object" ? "n" : ""} ${s.type}${range}`}, got ${JSON.stringify(value)}`,
      );
    }
    if (s.enum && !s.enum.includes(value as string)) throw bad(`\`${key}\` must be one of ${s.enum.join(", ")}`);
  }
  return args;
}

// ── redaction ────────────────────────────────────────────────────────────────

/** A pipeline as the endpoint sees it: the version in force, and every stored version (for their secrets). */
interface View {
  name: string;
  /** The latest stored version; null before the first start (the file is all there is). */
  version: number | null;
  source: string;
  /** The parsed version in force; null when it doesn't parse. */
  pipeline: Pipeline | null;
  sources: string[];
}

/** Map every string (values and keys) through `fn`. */
function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (isMap(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[fn(k)] = mapStrings(v, fn);
    return out;
  }
  return value;
}

/** `agent.redact` paths as segments inside packet data: `data.email` and `email` both name `data.email`. */
export function redactSegments(paths: string[]): string[][] {
  return paths.map((p) => {
    const segs = p.split(".").filter(Boolean);
    return segs[0] === "data" ? segs.slice(1) : segs;
  });
}

/** Leaves worth masking wherever else they appear (short values would mask unrelated text). */
function collect(value: unknown, found: Set<string>) {
  if (typeof value === "string" || typeof value === "number") {
    const s = String(value);
    if (s.length >= 4) found.add(s);
  } else if (Array.isArray(value)) for (const v of value) collect(v, found);
  else if (isMap(value)) for (const v of Object.values(value)) collect(v, found);
}

function maskAt(node: unknown, segs: string[], i: number, found: Set<string>): unknown {
  if (i === segs.length) {
    collect(node, found);
    return MASK;
  }
  const seg = segs[i] as string;
  if (Array.isArray(node)) {
    // `*` or an index picks elements; any other segment applies to every element (a list of records).
    if (seg === "*") return node.map((v) => maskAt(v, segs, i + 1, found));
    if (/^\d+$/.test(seg)) return node.map((v, n) => (n === Number(seg) ? maskAt(v, segs, i + 1, found) : v));
    return node.map((v) => maskAt(v, segs, i, found));
  }
  if (!isMap(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = seg === "*" || seg === k ? maskAt(v, segs, i + 1, found) : v;
  return out;
}

/** Mask `segs` in every packet payload of `value`: anything under a `data` or `result` key, at any depth. */
export function maskPayloads(value: unknown, segs: string[][], found: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => maskPayloads(v, segs, found));
  if (!isMap(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    let next = v;
    if (k === "data" || k === "result") {
      if (typeof next === "string") {
        try {
          next = JSON.parse(next);
        } catch {}
      }
      for (const s of segs) next = maskAt(next, s, 0, found);
    }
    out[k] = maskPayloads(next, segs, found);
  }
  return out;
}

/** Packet ids a result names (`packet_id` keys), so their stored data can be harvested for values to mask. */
function packetIds(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) packetIds(v, out);
  else if (isMap(value))
    for (const [k, v] of Object.entries(value)) {
      if (k === "packet_id" && typeof v === "string") out.add(v);
      else packetIds(v, out);
    }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── the server ───────────────────────────────────────────────────────────────

export class McpServer {
  private tokens: Token[] = [];
  /** Resolved token values, redacted from every response. */
  private hidden: string[] = [];
  /** OAuth access tokens seen lately, redacted too (only their digests are stored). */
  private recent: string[] = [];
  /** Tokens configured but not usable (unresolvable or too short); details are in the engine log. */
  private unusable = 0;
  private readonly ready: Promise<void>;
  readonly engine: Supervisor;
  private readonly api: ApiCall;
  private readonly base: string;
  private readonly oauth: OAuth | undefined;
  private readonly publicUrl: string | null;

  constructor(opts: McpOptions) {
    this.publicUrl = opts.publicUrl ?? null;
    this.engine = opts.engine;
    this.api = opts.api;
    this.base = opts.base ?? "";
    this.oauth = opts.oauth;
    const log =
      opts.log ??
      ((level, message) =>
        console.log(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [engine] ${message}`));
    this.ready = this.resolve(opts.tokens, log).catch((e) =>
      log("error", `mcp: resolving tokens failed: ${(e as Error).message}`),
    );
  }

  /** Resolve every token reference once, at engine start. A token that fails is left out and logged (never its value). */
  private async resolve(configured: McpTokenConfig[], log: (level: string, message: string) => void) {
    for (const t of configured) {
      let value: string;
      try {
        // An `op` waiting for an unlock must not hang every request: give up on that token after a while.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`resolving ${t.token} took over ${RESOLVE_TIMEOUT_MS / 1000}s`)),
            RESOLVE_TIMEOUT_MS,
          );
        });
        try {
          value = (await Promise.race([Secrets.resolve({ [t.name]: t.token }), timeout])).values[t.name] as string;
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        this.unusable++;
        log(
          "error",
          `mcp: token '${t.name}' is not usable: ${(e as Error).message}; fix engine.mcp.tokens and restart the engine`,
        );
        continue;
      }
      if (value.length < MIN_TOKEN_LENGTH) {
        this.unusable++;
        log(
          "error",
          `mcp: token '${t.name}' is shorter than ${MIN_TOKEN_LENGTH} characters, so it is not used; generate a longer one (openssl rand -hex 32)`,
        );
        continue;
      }
      this.hidden.push(value);
      this.tokens.push({ name: t.name, scope: t.scope, pipelines: t.pipelines, digest: digest(value) });
    }
  }

  /** Answer one request to `/mcp`. The gateway has already checked the Host header. */
  async handle(req: Request): Promise<Response> {
    const origin = req.headers.get("origin");
    if (origin && origin !== "null") {
      let host = "";
      try {
        host = new URL(origin).hostname;
      } catch {}
      if (!LOOPBACK.has(host.toLowerCase()) && origin !== this.publicUrl)
        return httpError(
          403,
          "forbidden",
          `the MCP endpoint does not answer pages from ${origin}`,
          "call it from a local MCP client, not a web page",
        );
    }
    if (req.method !== "POST")
      return httpError(
        405,
        "method_not_allowed",
        "the MCP endpoint takes POST only (no SSE stream, no sessions)",
        "send each JSON-RPC message as a POST",
        { allow: "POST" },
      );
    await this.ready;
    const token = this.authenticate(req);
    if (token instanceof Response) return token;
    if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? ""))
      return httpError(
        415,
        "unsupported_media_type",
        "the MCP endpoint takes JSON",
        "send Content-Type: application/json",
      );
    const declared = Number(req.headers.get("content-length") ?? 0);
    const text = declared > MAX_BODY ? "" : await req.text();
    if (declared > MAX_BODY || text.length > MAX_BODY)
      return httpError(
        413,
        "too_large",
        `the request is larger than ${MAX_BODY / 1024 / 1024} MiB`,
        "send a smaller message (a proposal's source is capped at 1 MiB)",
      );
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      return rpcResponse(null, new RpcError(-32700, `parse error: ${(e as Error).message}`), 400);
    }
    if (Array.isArray(msg)) return rpcResponse(null, new RpcError(-32600, "JSON-RPC batches are not supported"), 400);
    if (!isMap(msg) || msg.jsonrpc !== "2.0")
      return rpcResponse(null, new RpcError(-32600, "not a JSON-RPC 2.0 message"), 400);
    const id = msg.id as string | number | undefined;
    // Notifications and responses (there are no server requests to answer) are accepted with no body.
    if (typeof msg.method !== "string" || id === undefined || id === null) return new Response(null, { status: 202 });
    const version = req.headers.get("mcp-protocol-version");
    if (msg.method !== "initialize" && version && !MCP_PROTOCOL_VERSIONS.includes(version))
      return rpcResponse(
        id,
        new RpcError(-32600, `unsupported MCP-Protocol-Version ${version}`, { supported: MCP_PROTOCOL_VERSIONS }),
        400,
      );
    this.engine.touch(); // an agent is using the engine: it doesn't sleep under it (D31)
    try {
      return rpcResponse(id, await this.dispatch(msg.method, isMap(msg.params) ? msg.params : {}, token));
    } catch (e) {
      if (e instanceof RpcError) return rpcResponse(id, e);
      return rpcResponse(id, new RpcError(-32603, this.redactText((e as Error)?.message ?? String(e))));
    }
  }

  private authenticate(req: Request): Token | Response {
    const host = req.headers.get("host");
    const origin =
      this.publicUrl && host?.toLowerCase() === new URL(this.publicUrl).host
        ? this.publicUrl
        : host
          ? `http://${host}`
          : this.base;
    const challenge = (error?: string) => ({
      "www-authenticate": `Bearer ${error ? `error="${error}", ` : ""}resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    });
    const broken = this.unusable
      ? ` (${this.unusable} token(s) in engine.mcp.tokens could not be used: see the engine log)`
      : "";
    const auth = req.headers.get("authorization") ?? "";
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    if (!m)
      return httpError(
        401,
        "unauthorized",
        `the MCP endpoint needs a bearer token${broken}`,
        `connect with OAuth: add ${origin}/mcp to your MCP client (claude mcp add --transport http pipo ${origin}/mcp) and approve it in the browser; or send Authorization: Bearer <token> with a token from engine.mcp.tokens`,
        challenge(),
      );
    const given = digest(m[1] as string);
    let match: Token | undefined;
    // Compare against every token, in constant time each, so timing tells nothing about which (or whether one) matched.
    for (const t of this.tokens) if (timingSafeEqual(given, t.digest) && !match) match = t;
    if (match) return match;
    const grant = this.oauth?.authenticate(m[1] as string);
    if (grant) {
      if (!this.recent.includes(m[1] as string)) this.recent = [...this.recent, m[1] as string].slice(-32);
      return { name: grant.name, scope: grant.scope, pipelines: grant.pipelines, digest: given };
    }
    return httpError(
      401,
      "unauthorized",
      `the bearer token matches no MCP token or live OAuth grant${broken}`,
      "an OAuth token expires after an hour (the client refreshes it) and ends when its grant is revoked: connect again; or use a token from engine.mcp.tokens (resolved when the engine starts)",
      challenge("invalid_token"),
    );
  }

  private async dispatch(method: string, params: Record<string, unknown>, token: Token): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        return {
          protocolVersion:
            typeof asked === "string" && MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
          serverInfo: { name: "pipo", title: "Pipo engine", version: "0.0.0" },
          instructions: `Pipo pipelines (spec: resource pipo://docs/spec.md; guides: pipo://docs/guide/*). This token is '${token.name}' with scope ${token.scope} (read < operate < edit < author). A pipeline takes agents only with agent.control: true; pause, resume, replay, rerun, push and ack need the pipeline's agent.actions; changes go through propose_change (agent.edit paths). To build a pipeline (scope author): write it and check it with check_pipo, create it with create_pipeline (with fixtures), dry-run it with test_pipeline, wait for a human to approve it (list_approvals), start it with start_pipeline, then watch it with get_status and inspect_packet. Results are redacted.`,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: TOOLS.map((t) => ({
            name: t.name,
            title: t.title,
            description: `${t.description} Scope: ${t.scope}.`,
            inputSchema: t.inputSchema,
            annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false },
          })),
        };
      case "tools/call":
        return await this.callTool(params, token);
      case "resources/list":
        return { resources: this.listResources(token) };
      case "resources/templates/list":
        return { resourceTemplates: RESOURCE_TEMPLATES };
      case "resources/read":
        return await this.readResource(params, token);
      default:
        throw new RpcError(-32601, `method not found: ${method}`);
    }
  }

  private async callTool(params: Record<string, unknown>, token: Token) {
    const tool = TOOLS.find((t) => t.name === params.name);
    if (!tool) throw new RpcError(-32602, `unknown tool: ${String(params.name)}`, { hint: "tools/list lists them" });
    let view: View | null = null;
    try {
      if (rank(token.scope) < rank(tool.scope))
        throw new ToolError(
          "forbidden",
          `${tool.name} needs a token with scope ${tool.scope}; '${token.name}' has ${token.scope}`,
          `use a token with scope ${tool.scope} (engine.mcp.tokens in config.yaml)`,
        );
      const args = validate(tool, params.arguments);
      if (tool.pipeline) view = this.gate(args.pipeline, token, tool.action);
      const result = await tool.run.call(this, { token, args, view });
      return { content: [{ type: "text", text: JSON.stringify(await this.redact(result, view), null, 2) }] };
    } catch (e) {
      const err =
        e instanceof ToolError
          ? e
          : new ToolError("internal", (e as Error)?.message ?? String(e), "see the engine log");
      const body = await this.redact({ error: err.message, hint: err.hint, code: err.code, ...err.extra }, view);
      return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: true };
    }
  }

  /** A REST call in-process; an error answer becomes a ToolError with the same message, hint and code. */
  async call(method: "GET" | "POST", path: string, body?: Record<string, unknown>, agent?: string): Promise<any> {
    const res = await this.api(method, path, body, agent);
    if (res.status >= 400) {
      const { error, hint, code, routes: _routes, ...extra } = (res.body ?? {}) as Record<string, unknown>;
      throw new ToolError(String(code ?? "error"), String(error ?? `HTTP ${res.status}`), String(hint ?? ""), extra);
    }
    return res.body;
  }

  /** The pipeline as stored (latest version in the journal, else its file), or null when this engine has none. */
  view(name: string): View | null {
    let rows: { version: number; source: string }[] = [];
    const path = journalPath(this.engine.home, name);
    if (existsSync(path)) {
      try {
        const db = Journal.openReadonly(path);
        try {
          rows = db.query("SELECT version, source FROM versions ORDER BY version").all() as typeof rows;
        } finally {
          db.close();
        }
      } catch {}
    }
    const latest = rows.at(-1);
    let source = latest?.source;
    if (source === undefined) {
      const file = this.engine.get(name)?.file;
      if (!file) return null;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        return null;
      }
    }
    let pipeline: Pipeline | null = null;
    try {
      const loaded = load(source);
      pipeline = loaded.diagnostics.length ? null : ((loaded.value as Pipeline) ?? null);
    } catch {}
    return {
      name,
      version: latest?.version ?? null,
      source,
      pipeline,
      sources: [...rows.map((r) => r.source), ...(latest ? [] : [source])],
    };
  }

  /** The allowlist, then the version in force's agent policy: `agent.control`, and `agent.actions` for `action`. */
  gate(name: unknown, token: Token, action?: string): View {
    const missing = () =>
      new ToolError(
        "not_found",
        `no pipeline named '${String(name)}' in this engine`,
        "list_pipelines lists the ones this token may use",
      );
    if (typeof name !== "string" || !NAME.test(name)) throw missing();
    if (token.pipelines && !token.pipelines.includes(name)) throw missing();
    const view = this.view(name);
    if (!view) throw missing();
    const agent = view.pipeline?.agent;
    const where = view.version === null ? "its file" : `its version in force (v${view.version})`;
    if (agent?.control !== true)
      throw new ToolError(
        "forbidden",
        `'${name}' does not take agents: ${where} has no \`agent.control: true\``,
        "a human adds `agent: { control: true }` to the pipeline (spec §9.3) and applies or restarts it",
      );
    if (action && !(agent.actions ?? []).includes(action))
      throw new ToolError(
        "forbidden",
        `'${name}' does not let agents ${action}: ${where} has no '${action}' in agent.actions`,
        `a human adds ${action} to agent.actions (spec §9.3); agent.actions is [${(agent.actions ?? []).join(", ")}]`,
      );
    return view;
  }

  /** A pipeline name the token may use (its allowlist); `forbidden` otherwise. */
  allow(token: Token, name: unknown): void {
    if (typeof name !== "string" || !NAME.test(name))
      throw new ToolError(
        "bad_request",
        `'${String(name)}' is not a pipeline name`,
        "use lowercase letters, digits and '-', starting with a letter or digit",
      );
    if (token.pipelines && !token.pipelines.includes(name))
      throw new ToolError(
        "forbidden",
        `'${token.name}' may only use the pipelines ${token.pipelines.join(", ")}`,
        "pick one of those names, or ask for a token without a pipeline allowlist",
      );
  }

  /** The approval of a pipeline this token wrote (create_pipeline), or null. Checks the allowlist. */
  own(name: unknown, token: Token): ApprovalView | null {
    this.allow(token, name);
    const a = this.engine.approvals.get(name as string);
    return a && a.by === token.name ? a : null;
  }

  /** Agent proposals to a pipeline an agent wrote wait for a human, unless the engine auto-approves (§9.4, D81). */
  held(name: string): boolean {
    return !this.engine.config.mcp.auto_approve && this.engine.approvals.get(name) !== null;
  }

  heldNote(name: string) {
    return {
      held_for_approval: true,
      hint: `'${name}' was written by an agent, so agent proposals to it are stored, not applied: a human applies it (the dashboard's Agents page${this.base ? `, ${this.base}/ui/#/agents` : ""}, or pipo proposals ${name} apply <id>)`,
    };
  }

  /** What an agent sees of an approval: its state and what to do next. */
  approvalSummary(a: ApprovalView) {
    const where = `the dashboard's Agents page${this.base ? ` (${this.base}/ui/#/agents)` : ""}`;
    const hint =
      a.effective === "approved"
        ? `approved: start it with start_pipeline (${a.name})`
        : a.effective === "rejected"
          ? `rejected${a.note ? `: ${a.note}` : ""}; change it and create it again to ask once more`
          : `a human approves it on ${where} or with 'pipo approvals approve ${a.name}'; list_approvals shows its state`;
    return {
      pipeline: a.name,
      file: a.file,
      state: a.effective,
      changed_since_approval: a.changed,
      by: a.by,
      requested_at: a.requested_at,
      decided_by: a.decided_by,
      decided_at: a.decided_at,
      hint,
    };
  }

  /**
   * Redact a result for an agent: `agent.redact` paths of the pipeline in packet payloads, those values anywhere else
   * in it (and the values stored for every packet it names), then secrets (the pipeline's that resolve from `env:`
   * here; the runner already redacted its own with all of them) and the MCP tokens.
   */
  async redact(value: unknown, view: View | null): Promise<unknown> {
    let out = value;
    const segs = redactSegments(view?.pipeline?.agent?.redact ?? []);
    if (view && segs.length) {
      const found = new Set<string>();
      out = maskPayloads(out, segs, found);
      this.harvest(view.name, packetIds(out), segs, found);
      const values = [...found].sort((a, b) => b.length - a.length);
      if (values.length) {
        const re = new RegExp(values.map(escapeRe).join("|"), "g");
        out = mapStrings(out, (s) => s.replace(re, MASK));
      }
    }
    const secrets = await this.secretsOf(view);
    return mapStrings(out, (s) => secrets.redact(s));
  }

  private redactText(text: string): string {
    let out = text;
    for (const h of [...this.hidden, ...this.recent]) out = out.split(h).join("***");
    return out;
  }

  /** Values at the redact paths in the journal's data for these packets (current data, results and every step's patch). */
  private harvest(name: string, ids: Set<string>, segs: string[][], found: Set<string>) {
    if (!ids.size) return;
    const path = journalPath(this.engine.home, name);
    if (!existsSync(path)) return;
    let db: ReturnType<typeof Journal.openReadonly> | undefined;
    try {
      db = Journal.openReadonly(path);
      const all = [...ids];
      for (let i = 0; i < all.length; i += 400) {
        const chunk = all.slice(i, i + 400);
        const marks = chunk.map(() => "?").join(", ");
        const rows = db
          .query(`SELECT data, result FROM packets WHERE id IN (${marks}) OR root IN (${marks})`)
          .all(...chunk, ...chunk) as { data: string | null; result: string | null }[];
        for (const row of rows) maskPayloads(row, segs, found);
        const patches = db
          .query(
            `SELECT patch FROM events WHERE patch IS NOT NULL AND (packet_id IN (${marks}) OR packet_id IN (SELECT id FROM packets WHERE root IN (${marks})))`,
          )
          .all(...chunk, ...chunk) as { patch: string }[];
        for (const { patch } of patches) {
          try {
            maskPayloads(JSON.parse(patch), segs, found); // a transition's patch: { state, data, … }
          } catch {}
        }
      }
    } catch {
      // Best effort: what the result itself carries is masked regardless.
    } finally {
      db?.close();
    }
  }

  /** The pipeline's secrets that resolve from `env:` here (no `op` prompt per request), plus the MCP tokens. */
  private async secretsOf(view: View | null): Promise<Secrets> {
    const refs: Record<string, string> = {};
    for (const [i, source] of (view?.sources ?? []).entries()) {
      try {
        const p = load(source).value as Pipeline | undefined;
        for (const [name, ref] of Object.entries(p?.secrets ?? {})) {
          const r = String(ref);
          if (r.startsWith("env:") && process.env[r.slice(4)] !== undefined) refs[`${name}@${i}`] = r;
        }
      } catch {}
    }
    try {
      return await Secrets.resolve(refs, undefined, [...this.hidden, ...this.recent]);
    } catch {
      return await Secrets.resolve({}, undefined, [...this.hidden, ...this.recent]);
    }
  }

  // ── resources ──────────────────────────────────────────────────────────────

  private listResources(token: Token) {
    const out: Record<string, unknown>[] = [
      {
        uri: "pipo://schema/pipo.schema.json",
        name: "pipo.schema.json",
        title: "The .pipo JSON Schema",
        mimeType: "application/schema+json",
      },
    ];
    if (existsSync(SPEC_FILE))
      out.push({
        uri: "pipo://docs/spec.md",
        name: "spec.md",
        title: "The Pipo specification",
        mimeType: "text/markdown",
      });
    for (const page of guidePages())
      out.push({
        uri: `pipo://docs/guide/${page.slug}.md`,
        name: `guide/${page.slug}.md`,
        title: `Guide: ${page.title}`,
        mimeType: "text/markdown",
      });
    out.push({
      uri: "pipo://docs/reference/connectors.md",
      name: "reference/connectors.md",
      title: "Every connector and its with: fields",
      mimeType: "text/markdown",
    });
    for (const [kind, catalog] of Object.entries(CONNECTORS))
      for (const [name, m] of Object.entries(catalog))
        out.push({
          uri: `pipo://connectors/${kind}/${name}`,
          name: `${kind} ${name}`,
          description: m.description,
          mimeType: "application/schema+json",
        });
    for (const info of this.engine.list()) {
      if (token.pipelines && !token.pipelines.includes(info.name)) continue;
      if (this.view(info.name)?.pipeline?.agent?.control !== true) continue;
      out.push(
        {
          uri: `pipo://pipelines/${info.name}/source`,
          name: `${info.name} source`,
          title: `${info.name}: the version in force`,
          mimeType: "application/yaml",
        },
        {
          uri: `pipo://pipelines/${info.name}/versions`,
          name: `${info.name} versions`,
          title: `${info.name}: version history`,
          mimeType: "application/json",
        },
      );
    }
    return out;
  }

  private async readResource(params: Record<string, unknown>, token: Token) {
    const uri = params.uri;
    if (typeof uri !== "string") throw new RpcError(-32602, "resources/read needs `uri`");
    const notFound = (hint = "resources/list and resources/templates/list show what there is") =>
      new RpcError(-32002, `resource not found: ${uri}`, { uri, hint });
    const text = (mimeType: string, body: string) => ({ contents: [{ uri, mimeType, text: body }] });
    if (uri === "pipo://schema/pipo.schema.json")
      return text("application/schema+json", this.redactText(JSON.stringify(buildSchema(), null, 2)));
    if (uri === "pipo://docs/spec.md") {
      if (!existsSync(SPEC_FILE)) throw notFound("this installation has no docs/spec.md");
      return text("text/markdown", this.redactText(readFileSync(SPEC_FILE, "utf8")));
    }
    const guide = /^pipo:\/\/docs\/guide\/([a-z0-9-]+)\.md$/.exec(uri);
    if (guide) {
      const path = join(GUIDE_DIR, `${guide[1]}.md`);
      if (!existsSync(path)) throw notFound("resources/list lists the guide's pages");
      return text("text/markdown", this.redactText(readFileSync(path, "utf8")));
    }
    if (uri === "pipo://docs/reference/connectors.md") return text("text/markdown", connectorsMarkdown());
    let m = /^pipo:\/\/connectors\/([a-z]+)\/([a-z_]+)$/.exec(uri);
    if (m) {
      const manifest = CONNECTORS[m[1] as string]?.[m[2] as string];
      if (!manifest) throw notFound();
      return text("application/schema+json", JSON.stringify({ kind: m[1], name: m[2], ...manifest }, null, 2));
    }
    m = /^pipo:\/\/pipelines\/([^/]+)\/(source|versions)(?:\/(\d+))?$/.exec(uri);
    if (!m || (m[2] === "source" && m[3] !== undefined)) throw notFound();
    const name = m[1] as string;
    let view: View;
    try {
      view = this.gate(name, token);
    } catch (e) {
      const err = e as ToolError;
      throw new RpcError(err.code === "not_found" ? -32002 : -32001, `${err.message} (${uri})`, {
        uri,
        hint: err.hint,
      });
    }
    const redacted = async (v: unknown) => (await this.redact(v, view)) as string;
    if (m[2] === "source") return text("application/yaml", await redacted(view.source));
    try {
      if (m[3] === undefined)
        return text(
          "application/json",
          JSON.stringify(await this.redact(await this.call("GET", `${at(name)}/versions`), view), null, 2),
        );
      const v = await this.call("GET", `${at(name)}/versions/${m[3]}`);
      return text("application/yaml", await redacted(v.definition));
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      throw new RpcError(e.code === "not_found" ? -32002 : -32603, `${e.message} (${uri})`, { uri, hint: e.hint });
    }
  }
}

const CONNECTORS: Record<string, Record<string, Manifest>> = {
  input: INPUTS,
  tap: TAPS,
  transform: TRANSFORMS,
  agent: AGENTS,
  output: OUTPUTS,
  check: CHECKS,
};

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: "pipo://pipelines/{name}/source",
    name: "pipeline source",
    title: "A pipeline's version in force (.pipo source)",
    mimeType: "application/yaml",
  },
  {
    uriTemplate: "pipo://pipelines/{name}/versions",
    name: "pipeline versions",
    title: "A pipeline's versions: author, author_kind, reason, proposal",
    mimeType: "application/json",
  },
  {
    uriTemplate: "pipo://pipelines/{name}/versions/{version}",
    name: "pipeline version",
    title: "The .pipo source of one stored version",
    mimeType: "application/yaml",
  },
  {
    uriTemplate: "pipo://connectors/{kind}/{name}",
    name: "connector schema",
    title: "A connector's `with:` JSON Schema and capabilities (kind: input, tap, transform, agent, output, check)",
    mimeType: "application/schema+json",
  },
];

function httpError(
  status: number,
  code: string,
  error: string,
  hint: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json({ error, hint, code }, { status, headers });
}

function rpcResponse(id: string | number | null, result: unknown, status = 200): Response {
  if (result instanceof RpcError) {
    const error = { code: result.code, message: result.message, ...(result.data && { data: result.data }) };
    return Response.json({ jsonrpc: "2.0", id, error }, { status });
  }
  return Response.json({ jsonrpc: "2.0", id, result }, { status });
}
