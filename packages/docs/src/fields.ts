// One-line descriptions of every connector's `with:` fields and the top-level keys, for the generated Connectors and
// JSON Schema pages. Keys are `<group>.<connector>.<field>` (group: input, tap, transform, agent, output, check, or
// top for top-level keys, as `top.pipo.<key>`); `*.<connector>.<field>` covers a connector in every group (http,
// exec, telegram). docs.test.ts fails when a manifest field has no description.

const FIELDS: Record<string, string> = {
  // Top-level keys (§3.1)
  "top.pipo.pipo": "Spec version; always `1`.",
  "top.pipo.name": "The pipeline's name, unique per Pipo home: lower-case letters, digits and `-`.",
  "top.pipo.description": "Free text describing the pipeline.",
  "top.pipo.fn": "Path to a TypeScript or JavaScript module whose exports are available as `fn.<name>`.",
  "top.pipo.secrets": "Named secret references (`op://…` or `env:…`), used in `with:` blocks as `${secrets.<name>}`.",
  "top.pipo.lifetime": "When the pipeline ends: `ttl`, `max_packets`, `until`, `on_end`, `drain_timeout`.",
  "top.pipo.concurrency": "Packets processed in parallel; default 4, and `1` gives FIFO order.",
  "top.pipo.buffer":
    "`max`: accepted-but-unprocessed packets kept while paused or busy; beyond it inputs push back (http answers 503).",
  "top.pipo.errors":
    "The default error policy (`retry`, `backoff`, `delay`, `max_delay`, `then`, `message`) for every step.",
  "top.pipo.input": "The pipeline's one input; shorthand for `inputs:` with one input named `input`.",
  "top.pipo.inputs": "Several inputs, as a map of input name → input (at most 16).",
  "top.pipo.nodes": "The graph's steps, as a map of node id → node.",
  "top.pipo.output": "Where packets are written and verified; exactly one per pipeline.",
  "top.pipo.delivered": "Delivery verification and stall detection; default `check: ack`.",
  "top.pipo.agent":
    "What agents may do with this pipeline: `control`, `actions`, `edit`, `redact`, `on_stall`, `verify`.",
  "top.pipo.agent_budget": "Cost caps for agent nodes: `per_day` (USD), `per_packet` (tokens), `reset_at`, `warn_at`.",
  "top.pipo.retention": "How long journal data is kept: `data`, `trail`, `rejected`, `dlq`.",

  // Inputs
  "input.http.path": "Route below `/in/<pipeline>`; default `/`.",
  "input.http.method": "HTTP method accepted; default `POST`.",
  "input.http.auth":
    "Request authentication: `header` + `equals` (a token header), or `hmac: {header, secret, algorithm}` (a body signature; `sha256` by default).",
  "input.http.respond":
    "`accepted` (default): answer `202 {packet_id}` once journaled; `delivered`: wait for the final state up to `timeout`.",
  "input.http.timeout": "How long `respond: delivered` waits for delivery; default `30s`.",
  "input.http.listen": "A port the runner binds itself on 127.0.0.1, so the input works without the engine gateway.",
  "input.schedule.cron": "5-field cron expression, evaluated in UTC. Exactly one of `cron` and `every` (P038).",
  "input.schedule.every": "Fixed interval, counted from when the runner starts.",
  "input.schedule.payload": "The `data` of every tick; default `{}`.",
  "input.watch.path":
    "Glob of files to watch, relative to the pipeline file; a plain folder means every file below it.",
  "input.watch.events": "Which changes become packets; default `[create, change]`.",
  "input.watch.read": "`path` (default): describe the file; `content`: also read its text into `data.content`.",
  "input.pipeline.from":
    "The pipelines allowed to feed this input with their `to: pipeline` output; others are refused.",
  "input.system.every": "How often to sample.",
  "input.system.metrics": "Which metrics to sample; default all of them.",
  "input.telegram.bot": "A bot name from `<home>/bots.json` (never a template); default the home's default bot.",
  "input.telegram.token": "A bot token instead of a named bot, e.g. `${secrets.tg_token}`.",
  "input.telegram.allow":
    "Chat or user ids whose messages become packets; replaces the bot's own list. Messages from anyone else are ignored.",
  "input.telegram.poll_every":
    "How long one long-poll waits for messages; default the bot's, else `25s`, at least `1s`.",
  "input.telegram.download": "Download attached files into the pipeline's folder; default `true`.",

  // Shared: http calls (tap, transform, output)
  "*.http.method": "HTTP method; default `POST`.",
  "*.http.url": "The URL to call (a template).",
  "*.http.headers": "Request headers (templates). An `Idempotency-Key: <key>` header is sent unless you set one.",
  "*.http.body":
    "Request body (a template); default the packet's `data`. A string is sent as text, anything else as JSON. Not sent for GET and DELETE.",
  "*.http.success": 'Status codes that count as success, as `204`, `"2xx"` or `"200-299"`; default `2xx`.',

  // Shared: telegram sends (tap, output)
  "*.telegram.bot": "A bot name from `<home>/bots.json` (never a template); default the home's default bot.",
  "*.telegram.token": "A bot token instead of a named bot, e.g. `${secrets.tg_token}`.",
  "*.telegram.chat_id":
    "Chat to send to; default the chat a telegram input's packet came from (required with any other input, P057).",
  "*.telegram.text":
    "Message text, or a file's caption; default `data` (as JSON when not a string), cut at 4096 characters.",
  "*.telegram.photo": "A photo to send: a path relative to the pipeline file, or an http(s) URL.",
  "*.telegram.document": "A file to send: a path relative to the pipeline file, or an http(s) URL.",
  "*.telegram.parse_mode": "Telegram formatting of `text`; off by default, so text from data can't break it.",

  // Shared: exec (tap, transform)
  "*.exec.command": "The program: a name found on `PATH`, or a path relative to the pipeline file. No shell.",
  "*.exec.args": "Arguments, each passed to the program as one argument (templates).",
  "*.exec.cwd": "Folder to run in, relative to the pipeline file; default the pipeline file's folder.",
  "*.exec.env": "Extra environment variables for the program.",
  "*.exec.stdin": "Text fed to the program's standard input.",
  "*.exec.timeout": "Kill the program after this long; default `5m`.",
  "*.exec.success": "Exit codes that count as success; default `[0]`.",
  "*.exec.result":
    "What a transform's `data` becomes: `info` (default; exit code, stdout, stderr, duration, files), `text` (stdout) or `json` (stdout parsed).",
  "*.exec.outputs": "Files the program must write: their folders are created first, and a missing one is a node error.",

  // Taps
  "tap.log.level": "Log level; default `info`.",
  "tap.log.message": "The line to log (a template); default the packet's `data` as JSON.",
  "tap.file.path": "File to write, relative to the pipeline file (a template).",
  "tap.file.format": "How each packet is written; default `jsonl`.",
  "tap.file.mode": "`append` (default) or `write` (replace the file).",
  "tap.emit.event": "Name of the custom event to record in the journal and the event stream.",
  "tap.emit.detail": "Data attached to the event (a template).",

  // Transforms
  "transform.map.data": "The new `data`: a template, rendered per packet (a whole `${expr}` keeps its type).",

  // Agents
  "agent.claude_api.model": "Model id, e.g. `claude-sonnet-5-5`.",
  "agent.claude_api.prompt": "The prompt (a template); use `${json(data)}` to include the packet.",
  "agent.claude_api.schema": "JSON Schema file the answer must match, relative to the pipeline file.",
  "agent.claude_api.timeout": "How long one call may take; default `60s`.",
  "agent.claude_api.max_tokens":
    "Most output tokens per call; default 4096 (and never more than the packet's budget has left).",
  "agent.claude_code.model": "Model to ask the CLI for; default the CLI's own.",
  "agent.claude_code.prompt": "The prompt (a template); use `${json(data)}` to include the packet.",
  "agent.claude_code.schema": "JSON Schema file the answer must match, relative to the pipeline file.",
  "agent.claude_code.timeout": "How long one call may take; default `5m`.",
  "agent.claude_code.cwd": "Folder to run in, relative to the pipeline file; default a fresh, empty folder per call.",
  "agent.claude_code.allow_tools":
    "Let the CLI use its tools (edit files, run commands) without asking; default `false`.",

  // Outputs
  "output.sqlite.path": "Database file, relative to the pipeline file.",
  "output.sqlite.table": "Table to write to.",
  "output.sqlite.create": "Create the table (with the key as PRIMARY KEY) when it's missing; default `false`.",
  "output.sqlite.mode": "`insert` (default): a repeated key is ignored; `upsert`: it updates the row.",
  "output.sqlite.key": "The idempotency key column; default `packet_id`. It needs a PRIMARY KEY or UNIQUE constraint.",
  "output.sqlite.columns":
    "Column → template map; default the top-level fields of `data` plus the key column set to the packet's key.",
  "output.file.path": "File to write, relative to the pipeline file (a template).",
  "output.file.format":
    "`jsonl` (default; each line carries `packet_id`, so a repeated write is skipped), `json`, `csv` or `text`.",
  "output.file.mode": "`append` (default) or `write` (replace the file).",
  "output.pipeline.pipeline": "The pipeline to feed; its `via: pipeline` input must list this one in `from`.",
  "output.pipeline.data": "What to hand over (a template); default the packet's `data`.",
  "output.stdout.format": "How each packet is printed; default `jsonl`.",

  // Delivery checks
  "check.record_exists.where": "Column → value pairs a row must match (with `=` and `AND`).",
  "check.row_count.query": "A read-only SELECT.",
  "check.row_count.params": "Values bound to the query's `?` placeholders.",
  "check.row_count.min": "Rows the query must return at least: a number, or a template that renders to one; default 1.",
  "check.query.sql": "A read-only SELECT whose first column in the first row must be truthy.",
  "check.query.query": "Alias of `sql`.",
  "check.query.params": "Values bound to the query's `?` placeholders.",
  "check.file_exists.path": "File to look for; default the output's own `path`.",
  "check.file_nonempty.path": "File to look at; default the output's own `path`.",
  "check.line_contains.path": "File to search; default the output's own `path`.",
  "check.line_contains.value": "Text one line of the file must contain, e.g. `${meta.packet_id}`.",
  "check.checksum.path": "File to hash; default the output's own `path`.",
  "check.checksum.sha256": "Expected SHA-256 of the file: 64 hex characters, any case.",
  "check.status.success": 'Status codes that count as delivered, as `204`, `"2xx"` or `"200-299"`; default `2xx`.',
  "check.follow_up.url": "URL to GET after the write.",
  "check.follow_up.headers": "Headers for the follow-up request.",
  "check.follow_up.success": "Status codes that count as success; default `2xx`.",
  "check.follow_up.match": "Text the body must contain, or an object that must be a subset of the JSON body.",
};

// The other CLI agents take the same `with:` as Claude Code.
for (const provider of ["codex", "pi", "opencode"]) {
  for (const field of ["model", "prompt", "schema", "timeout", "cwd", "allow_tools"]) {
    FIELDS[`agent.${provider}.${field}`] = FIELDS[`agent.claude_code.${field}`]!;
  }
}

export function fieldDoc(group: string, connector: string, field: string): string | undefined {
  return FIELDS[`${group}.${connector}.${field}`] ?? FIELDS[`*.${connector}.${field}`];
}
