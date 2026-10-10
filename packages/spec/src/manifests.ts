// Built-in connector catalog (docs/spec.md §3.3–§3.5, §3.10). Pure data: the JSON Schema
// for each connector's `with:` block plus its capabilities. Runtime implementations live in
// @pipo/runner and must cover what they claim here.

type JsonSchema = Record<string, unknown>;

const DURATION = { type: "string", pattern: "^\\d+(\\.\\d+)?(ms|s|m|h|d)$" };
const PIPELINE_NAME = { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" };
const HTTP_METHOD = { enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] };

// Chat bots (§3.13, D69): `bot` names one in `<home>/bots.json` (default: its default bot), `token` sets one inline.
const TELEGRAM_BOT = { bot: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$" }, token: { type: "string" } };

function obj(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

export interface Manifest {
  description: string;
  with: JsonSchema;
}

export interface InputManifest extends Manifest {
  /** What one packet's `data` looks like, for the dashboard (D70). Left out when the sender decides (http, push). */
  sample?: unknown;
}

export interface OutputManifest extends Manifest {
  /** Delivery checks this output supports, besides the universal ones. */
  checks: string[];
  batch: boolean;
}

export const INPUTS: Record<string, InputManifest> = {
  http: {
    description: "Webhook or API call to /in/<pipeline><path>",
    with: obj({
      path: { type: "string", pattern: "^/", default: "/" },
      method: HTTP_METHOD,
      auth: {
        type: "object",
        properties: {
          header: { type: "string" },
          equals: { type: "string" },
          hmac: obj(
            { header: { type: "string" }, secret: { type: "string" }, algorithm: { enum: ["sha256", "sha1"] } },
            ["header", "secret"],
          ),
        },
        additionalProperties: false,
      },
      respond: { enum: ["accepted", "delivered"] },
      timeout: DURATION,
      listen: { type: "integer", minimum: 1, maximum: 65535 },
    }),
  },
  schedule: {
    description: "Timer, by cron expression or fixed interval",
    with: obj({ cron: { type: "string" }, every: DURATION, payload: {} }),
    sample: {},
  },
  watch: {
    description: "File system changes",
    with: obj(
      {
        path: { type: "string" },
        events: { type: "array", items: { enum: ["create", "change", "delete"] } },
        read: { enum: ["content", "path"] },
      },
      ["path"],
    ),
    sample: {
      event: "create",
      path: "/home/me/inbox/note.txt",
      name: "note.txt",
      size: 12,
      mtime: "2026-01-01T09:00:00.000Z",
      content: "hello there\n",
    },
  },
  push: { description: "Packets pushed by `pipo push`, the UI or an agent", with: obj({}) },
  // Chains (§3.14, D77): the pipelines allowed to feed this input with their `to: pipeline` output.
  pipeline: {
    description: "Packets from another pipeline's `to: pipeline` output",
    with: obj({ from: { type: "array", items: PIPELINE_NAME, minItems: 1, uniqueItems: true } }, ["from"]),
  },
  system: {
    description: "Operating system samples",
    with: obj(
      {
        every: DURATION,
        metrics: { type: "array", items: { enum: ["cpu", "memory", "disk", "battery", "network"] } },
      },
      ["every"],
    ),
    sample: {
      cpu: { percent: 12.5, cores: 8, load: [0.42, 0.38, 0.3] },
      memory: { total: 17179869184, free: 4294967296, used: 12884901888, percent: 75 },
      disk: { path: "/", total: 499963174912, free: 199985269964, used: 299977904948, percent: 60 },
      battery: { percent: 80, status: "Discharging" },
      network: { rx_bytes: 123456789, tx_bytes: 9876543 },
      sampled_at: "2026-01-01T09:00:00.000Z",
    },
  },
  telegram: {
    description: "Messages to a Telegram bot (long polling while the pipeline runs)",
    with: obj({
      ...TELEGRAM_BOT,
      allow: { type: "array", items: { type: "integer" } },
      poll_every: DURATION,
      download: { type: "boolean" },
    }),
    sample: {
      message_id: 42,
      date: "2026-01-01T09:00:00.000Z",
      chat_id: 123456789,
      chat_type: "private",
      from: { id: 123456789, username: "ada", name: "Ada Lovelace" },
      text: "hello",
      file: {
        kind: "document",
        file_id: "BQACAgQAAxkBAAI",
        name: "report.pdf",
        mime_type: "application/pdf",
        size: 52000,
        path: "/home/me/.pipo/pipelines/bot/files/report.pdf",
      },
    },
  },
};

const HTTP_CALL = obj(
  {
    method: HTTP_METHOD,
    url: { type: "string" },
    headers: { type: "object", additionalProperties: { type: "string" } },
    body: {},
    success: { type: "array", items: { type: ["integer", "string"] } },
  },
  ["url"],
);

const TELEGRAM_SEND = obj({
  ...TELEGRAM_BOT,
  chat_id: { type: ["integer", "string"] },
  text: { type: "string" },
  photo: { type: "string" },
  document: { type: "string" },
  parse_mode: { enum: ["Markdown", "MarkdownV2", "HTML"] },
});

// Run a program on this machine (§3.4, D71). No shell: `args` go to the program as they are, one string each.
const EXEC_WITH = obj(
  {
    command: { type: "string", minLength: 1, examples: ["ffmpeg"] },
    args: { type: "array", items: { type: "string" } },
    cwd: { type: "string" },
    env: { type: "object", additionalProperties: { type: "string" } },
    stdin: { type: "string" },
    timeout: DURATION,
    success: { type: "array", items: { type: "integer" }, minItems: 1 },
    result: { enum: ["info", "text", "json"] },
    outputs: { type: "array", items: { type: "string" } },
  },
  ["command"],
);

export const TAPS: Record<string, Manifest> = {
  log: {
    description: "Write a log line",
    with: obj({ level: { enum: ["debug", "info", "warn", "error"] }, message: { type: "string" } }),
  },
  http: { description: "Call an HTTP endpoint; data passes on unchanged", with: HTTP_CALL },
  file: {
    description: "Append or write to a file",
    with: obj(
      {
        path: { type: "string" },
        format: { enum: ["jsonl", "json", "csv", "text"] },
        mode: { enum: ["append", "write"] },
      },
      ["path"],
    ),
  },
  telegram: { description: "Send a Telegram message; data passes on unchanged", with: TELEGRAM_SEND },
  emit: { description: "Emit a custom event", with: obj({ event: { type: "string" }, detail: {} }, ["event"]) },
  exec: { description: "Run a program on this machine; data passes on unchanged", with: EXEC_WITH },
};

export const TRANSFORMS: Record<string, Manifest> = {
  map: { description: "Replace data with the rendered `with.data` template", with: obj({ data: {} }, ["data"]) },
  http: { description: "Call an HTTP endpoint; the response body becomes data", with: HTTP_CALL },
  exec: { description: "Run a program on this machine; its result becomes data", with: EXEC_WITH },
};

/**
 * An agent provider (§3.4). `runs: "api"` calls a model API with a key from config.yaml (D36); `runs: "cli"` hands the
 * prompt to a coding-agent CLI installed and logged in on this machine, which runs as the user (D67).
 */
export interface AgentManifest extends Manifest {
  /** How the dashboard names it. */
  label: string;
  runs: "api" | "cli";
  /** The CLI's executable (`agents.<provider>.command` in config.yaml overrides it). */
  command?: string;
  /** Default `with.timeout`. */
  timeout: string;
}

// A CLI agent's `with:`. `model` is optional (the CLI's own default), `cwd` is where it runs (default: a fresh empty
// folder per call), `allow_tools` lets it use its tools (edit files, run commands) without asking.
const CLI_AGENT_WITH = obj(
  {
    model: { type: "string" },
    prompt: { type: "string" },
    schema: { type: "string" },
    timeout: DURATION,
    cwd: { type: "string" },
    allow_tools: { type: "boolean" },
  },
  ["prompt", "schema"],
);

export const AGENTS: Record<string, AgentManifest> = {
  claude_api: {
    label: "Claude API",
    description: "Claude via the Anthropic API (needs an API key)",
    runs: "api",
    timeout: "60s",
    with: obj(
      {
        model: { type: "string" },
        prompt: { type: "string" },
        schema: { type: "string" },
        timeout: DURATION,
        max_tokens: { type: "integer", minimum: 1 },
      },
      ["model", "prompt", "schema"],
    ),
  },
  claude_code: {
    label: "Claude Code",
    description: "Your local Claude Code CLI (claude), logged in as you",
    runs: "cli",
    command: "claude",
    timeout: "5m",
    with: CLI_AGENT_WITH,
  },
  codex: {
    label: "Codex",
    description: "Your local OpenAI Codex CLI (codex), logged in as you",
    runs: "cli",
    command: "codex",
    timeout: "5m",
    with: CLI_AGENT_WITH,
  },
  pi: {
    label: "pi",
    description: "Your local pi coding agent CLI (pi), with its configured providers",
    runs: "cli",
    command: "pi",
    timeout: "5m",
    with: CLI_AGENT_WITH,
  },
  opencode: {
    label: "opencode",
    description: "Your local opencode CLI (opencode), with its configured providers",
    runs: "cli",
    command: "opencode",
    timeout: "5m",
    with: CLI_AGENT_WITH,
  },
};

export const OUTPUTS: Record<string, OutputManifest> = {
  sqlite: {
    description: "SQLite table",
    with: obj(
      {
        path: { type: "string" },
        table: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        create: { type: "boolean" },
        mode: { enum: ["insert", "upsert"] },
        key: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        columns: { type: "object", propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" } },
      },
      ["path", "table"],
    ),
    checks: ["record_exists", "row_count", "query"],
    batch: true,
  },
  file: {
    description: "File on disk",
    with: obj(
      {
        path: { type: "string" },
        format: { enum: ["jsonl", "json", "csv", "text"] },
        mode: { enum: ["append", "write"] },
      },
      ["path"],
    ),
    checks: ["file_exists", "file_nonempty", "line_contains", "checksum"],
    batch: true,
  },
  http: { description: "HTTP endpoint", with: HTTP_CALL, checks: ["status", "follow_up"], batch: false },
  telegram: { description: "Telegram message", with: TELEGRAM_SEND, checks: [], batch: false },
  pipeline: {
    description: "Another pipeline, fed through its `via: pipeline` input (§3.14)",
    with: obj({ pipeline: PIPELINE_NAME, data: {} }, ["pipeline"]),
    checks: ["downstream"],
    batch: false,
  },
  stdout: {
    description: "Standard output",
    with: obj({ format: { enum: ["jsonl", "json", "text"] } }),
    checks: [],
    batch: false,
  },
};

/** Delivery checks every output supports. */
export const UNIVERSAL_CHECKS = ["ack", "external", "none"];

export const CHECKS: Record<string, Manifest> = {
  ack: { description: "The connector's own success report is enough", with: obj({}) },
  external: { description: "Wait for an outside acknowledgement", with: obj({}) },
  none: { description: "Don't verify", with: obj({}) },
  record_exists: {
    description: "A row matching `where` exists",
    with: obj({ where: { type: "object", minProperties: 1 } }, ["where"]),
  },
  row_count: {
    description: "`query` returns at least `min` rows",
    // `min` is a number or a template that renders to one (every delivered.with value is a template, §3.10).
    with: obj(
      { query: { type: "string" }, params: { type: "array" }, min: { type: ["integer", "string"], minimum: 0 } },
      ["query"],
    ),
  },
  query: {
    description: "Custom SQL returns a truthy first column",
    with: {
      ...obj({ sql: { type: "string" }, query: { type: "string" }, params: { type: "array" } }),
      anyOf: [{ required: ["sql"] }, { required: ["query"] }],
    },
  },
  file_exists: { description: "The file exists", with: obj({ path: { type: "string" } }) },
  file_nonempty: { description: "The file exists and is not empty", with: obj({ path: { type: "string" } }) },
  line_contains: {
    description: "A line contains `value`",
    with: obj({ path: { type: "string" }, value: { type: "string" } }, ["value"]),
  },
  checksum: {
    description: "The file hash equals `sha256`",
    with: obj({ path: { type: "string" }, sha256: { type: "string" } }, ["sha256"]),
  },
  status: {
    description: "Write response status is in `success`",
    with: obj({ success: { type: "array" } }),
  },
  downstream: { description: "The receiving pipeline delivered the packet", with: obj({}) },
  follow_up: {
    description: "A GET to `url` succeeds, or its body matches `match`",
    with: obj({ url: { type: "string" }, headers: { type: "object" }, success: { type: "array" }, match: {} }, ["url"]),
  },
};

export function supportedChecks(output: string): string[] {
  const m = OUTPUTS[output];
  return m ? [...UNIVERSAL_CHECKS, ...m.checks] : [];
}

export const FN_REF = /^fn\.([A-Za-z_$][\w$]*)$/;
