# Pipo — Specification

> **Pipo** is a simple, agent-first pipeline manager for continuous data.
> You describe a pipeline in a `.pipo` file. Pipo keeps it running and turns every incoming event into a **delivered**, verified result.

- Status: draft v1
- Supersedes: `docs/idea.txt`

---

## 1. What Pipo is

Pipo runs **continuous pipelines**. A pipeline has no "done" state, only **delivery**. Events come in from outside (webhooks, API calls, sensors, schedules, file changes) or from inside (CLI, UI, an agent). They pass through a small graph of nodes and are written to a destination: a database, a file or an API. An event counts as finished when Pipo can show it was delivered.

Pipo has four parts:

| Part | Role |
|---|---|
| **Engine** (`pipod`) | Control plane, written in Bun. It supervises pipeline processes, runs the HTTP gateway, keeps time and schedules, and exposes the agent endpoint and the UI. |
| **Runner** (`pipo-runner`) | Data plane, a Rust binary. Each pipeline runs as its own process with its own durable journal. |
| **CLI** (`pipo`) | Creates, validates, tests, runs, controls and inspects pipelines. |
| **UI** | Phase 1 is a live status and debugging dashboard. Phase 2 adds a visual editor for `.pipo` files. |

### Why Pipo (rather than n8n and similar tools)

- **Simple.** It's built for personal and small-team pipelines, and developer experience comes first. One file describes one pipeline, the file is the source of truth, and there's nothing hidden in a database.
- **Agent-first.** An agent can write pipelines, run them, step in while they're running and step out again, all through the same documented interfaces a human uses. It needs no workarounds.
- **Resilient.** Every pipeline is an isolated process with its own journal. A crashing pipeline, or even a crashing engine, does not take the others down.
- **Delivery-oriented.** Success is defined by verified delivery at the destination, not by "the code ran".

### Non-goals

- Not a human-approval or BPM workflow tool.
- Not multi-tenant or hosted. It's a local or self-hosted tool.
- Agents don't change engine code at runtime. They change `.pipo` files through a controlled protocol (§9).
- No exactly-once delivery. Pipo guarantees **at-least-once** delivery, plus idempotency keys (§7.3).

---

## 2. Core concepts

| Term | Meaning |
|---|---|
| **Pipeline** | A named, versioned graph defined in a `.pipo` file: one `input`, any number of `nodes`, one `output`, and an optional `delivered` check. |
| **Packet** | One unit of data moving through a pipeline. Every packet gets a ULID `packet_id` when it is accepted and is pinned to the pipeline version that accepted it. |
| **Node** | A step in the graph. Its *kind* (`tap`, `transform`, `filter`, `route` or `agent`) says what it may do to the data. |
| **Delivery** | A packet is **delivered** when the output connector reports a successful write *and* the `delivered` check passes. Delivered means done. |
| **Journal** | The pipeline's durable SQLite log (WAL mode). It records every packet's state changes, its version, its errors and the dead-letter queue. |
| **Dead-letter queue (DLQ)** | Packets that failed for good. They are stored in the journal and can be inspected and replayed. |
| **Lifetime** | How long a pipeline runs: until stopped, until a TTL expires, or until a condition is met. |

### 2.1 Packet lifecycle

```
received ──► rejected                      (input validation failed; terminal)
    │
    ▼
accepted ──► processing(node…) ──► writing ──► verifying ──► delivered   (terminal ✓)
                 │                    │            │
                 ├──► filtered        │            │                      (terminal, counted as success)
                 └────────────────────┴────────────┴──► dead_lettered     (terminal ✗)
```

A packet is written to the journal **before** its input is acknowledged. After a crash, the packet resumes from its last committed node.

A packet (or a fan-out copy) handed to the agent (`then: agent`, `agent.on_stall: handle`) is **escalated**: it stops where it was and waits, across restarts, until it is resolved: retried from that step, dead-lettered or dropped (§9.2, D50). It counts as pending.

### 2.2 Pipeline lifecycle

```
stopped ─► starting ─► active ◄─► paused
                         │
                         ├─► draining ─► completed   (lifetime reached, or stop requested)
                         ├─► jammed                  (stall detected; still running, flagged)
                         └─► failed                  (an error policy chose `halt`)
```

- **Pause** stops processing but keeps **accepting** packets into the journal, up to `buffer.max`. Beyond that limit, HTTP inputs answer `503 Retry-After`. On **resume**, the backlog is processed. Every pause records why it happened: `manual`, `agent`, `error`, `stall` or `budget`.
- **Drain** stops intake, lets in-flight packets reach a terminal state (bounded by `drain_timeout`) and then stops.

---

## 3. The `.pipo` file

A `.pipo` file is **YAML** with a published JSON Schema. Plain YAML tooling works out of the box (§10.1), agents write it reliably, and the Phase 2 visual editor can load and save it without losing anything.

### 3.1 Top-level keys

```yaml
pipo: 1                 # required — spec version
name: people-intake     # required — unique per engine, [a-z0-9-]
description: ...        # optional
fn: ./people.fn.ts      # optional — module of user functions (§3.6)
secrets: {...}          # optional — named secret references (§3.7)
lifetime: {...}         # optional — when the pipeline ends (§3.8)
concurrency: 4          # optional — packets processed in parallel (default 4; 1 = FIFO)
buffer: { max: 10000 }  # optional — max accepted-but-unprocessed packets
errors: {...}           # optional — default error policy (§3.9)
input: {...}            # required
nodes: {...}            # optional — map of node id → node
output: {...}           # required
delivered: {...}        # optional — delivery verification (§3.10); default `check: ack`
agent: {...}            # optional — what agents may do with this pipeline (§9.3)
agent_budget: {...}     # optional — cost caps for agent nodes (§3.11)
retention: {...}        # optional — how long journal data is kept (§3.12)
```

The same pattern repeats everywhere: **verb: connector**, then **`with:`** for that connector's settings.
`input.via: http` · `nodes.x.tap: log` · `output.to: sqlite` · `delivered.check: record_exists`.
Each connector publishes the JSON Schema for its `with:` block, so validation and autocomplete adapt to the connector you choose.

### 3.2 Expressions and templates

Expressions appear in `validate`, `filter`, `route`, `loop.until` and `lifetime.until`. They use a **safe subset of JavaScript expression syntax**. **[jsep](https://github.com/EricSmekens/jsep)** turns the text into a syntax tree. Pipo then evaluates that tree with its own evaluator, which accepts only the node types it allows. JavaScript's `eval` and `Function` are never used. jsep sits behind an internal `parse()` interface and is covered by a conformance test suite, so the parser can be replaced later without changing how expressions behave.

- **Allowed:** literals (string, number, boolean, `null`, array, object); member and index access (`data.a.b`, `data.items[0]`, optional chaining `?.`); the operators `+ - * / %`, `== != === !== < <= > >=`, `&& || !` and `??`; `in`; the ternary `a ? b : c`; and calls to the helper functions listed below.
- **Not allowed:** assignment, `++`/`--`, statements, arrow functions, `new`, `this`, method calls on values (write `len(x)`, not `x.length()`), and any global other than the context variables.
- **Semantics:**
  - Member access on a missing or `null` value gives `undefined`. It never throws, so `data.a.b` is safe even when `a` is missing.
  - `==` and `===` both compare strictly and deeply, with no type coercion: `36 == "36"` is false and `[1] == [1]` is true.
  - `x in y` tests membership: an array containing `x`, a string containing the substring `x`, or an object having the key `x`.
  - Only own properties are visible. Prototype members such as `toString` are `undefined`.
- **Limits:** the source length (2,000 characters), the syntax-tree depth (32) and the number of nodes (256) are capped. Expressions can't loop, so evaluation time is bounded by their size. `matches()` patterns are capped at 200 characters. `matches()` runs on the runner's regular-expression engine (Rust's `regex` crate), which has no lookaround or backreferences: such a pattern is an error ("Invalid regular expression…"), as is any pattern that fails to parse; `pipo check` and `pipo compile` don't run patterns.
- **Escaping:** in templates, `$${` writes a literal `${`.
- `pipo check` parses every expression at validation time and reports unknown identifiers and helper functions with their exact position in the file.

Templates are strings containing `${expr}`. When a whole value is a single `${expr}`, the result **keeps its type** (number, object and so on) instead of being turned into a string.

**Helper functions:** `exists(x)`, `len(x)`, `size(x)` (bytes), `type(x)`, `lower(s)`, `upper(s)`, `trim(s)`, `matches(s, re)`, `default(x, y)`, `json(x)`, `now()` (epoch ms), `iso(ms)`, `duration("5m")`.

**Context variables:**

| Variable | Available in | Contents |
|---|---|---|
| `data` | everywhere a packet exists | The packet payload as this step sees it. |
| `meta` | same | `packet_id`, `branch` (fan-out path, empty when unbranched, D22), `pipeline`, `version`, `node`, `trigger`, `source`, `received_at`, `attempt`, `hops`, `iteration`, `key` (what the output writes the packet under: `packet_id`, `packet_id:<branch>` for a fan-out copy, or the explicit key from sqlite `columns` or an http `Idempotency-Key` header; D22, D44, D55) |
| `env` | everywhere | Environment variables the engine allows through (`engine.env_allow`). |
| `secrets` | `with:` blocks only | Resolved secrets (§3.7). They are never available in messages or logs. |
| `output` | `output`, `delivered` | The output block, e.g. `output.with.table`. |
| `result` | `delivered` | What the connector returned from the write, e.g. `rowid` or HTTP status. |
| `error` | `message` fields | `message`, `code`, `rule`, `node`, `attempts`, `elapsed` |
| `stats` | `lifetime.until`, stall messages | `accepted`, `delivered`, `pending`, `dead_lettered`, `uptime` |
| `stall` | stall messages | `pending`, `duration`, `oldest.{packet_id,node,age,attempt,last_error}` |

### 3.3 `input`

Every pipeline has exactly one input. It defines how packets arrive, how they're parsed and what makes them valid.

```yaml
input:
  via: http                 # http | schedule | watch | push | system | telegram | (phase 2: mqtt, queue)
  with: {...}               # connector settings
  format: json              # json | text | csv | form | bytes
  schema: ./person.schema.json   # optional JSON Schema check, run before `validate`
  validate:                 # every rule must be true
    - exists(data)
    - data.age > 30
  on_invalid:               # deterministic failure: never retried
    respond: 422            # http only
    message: "Rejected: rule '${error.rule}' failed"
```

| `via` | Triggered by | Key `with:` settings |
|---|---|---|
| `http` | A webhook or API call to `/in/<pipeline><path>` | `path`, `method`, `auth` (header token or HMAC signature), `respond: accepted \| delivered`, `listen` (a port the runner binds itself; can be overridden with `pipo start --listen`, §7.2) |
| `schedule` | A timer | `cron` or `every`, `payload` (optional fixed data) |
| `watch` | File system changes | `path` (glob; a plain folder means every file below it), `events: [create, change]`, `read: content \| path` |
| `push` | `pipo push`, the UI or an agent (MCP) | none |
| `system` | Sampling the operating system | `every`, `metrics: [cpu, memory, disk, battery, network]` |
| `telegram` | A message to a Telegram bot (§3.13) | `bot` or `token`, `allow`, `poll_every`, `download` |

Each input's manifest carries a `sample`: what one packet's `data` looks like (`watch`, `system`, `telegram`; `schedule` sends its `payload`). `http` and `push` have none, since the sender decides, unless `schema` names a file (D70).

By default, `http` answers `202 {"packet_id": "..."}` once the packet is in the journal. With `respond: delivered`, it waits for delivery up to `timeout` and returns the final state.

### 3.4 `nodes`

`nodes` is a map from node id to node. Each node has:

- **`from`** (required): where its packets come from. This can be `input`, a node id, a route branch (`triage.urgent`) or a list of these (fan-in: each packet flows through on its own).
- **Exactly one kind key**, listed in the table below.
- `with`, `on_error`, `loop` and `label` (optional).

Connections are declared **once**, via `from`. Downstream links are worked out from them. When one node feeds several nodes (fan-out), each branch gets a copy of the packet, and the packet counts as delivered only when every branch reaches a terminal state.

| Kind | Effect on `data` | Value | Examples |
|---|---|---|---|
| `tap` | Unchanged. Side effects only. | `log`, `http`, `file`, `emit`, `telegram` (§3.13), `exec`, `fn.<name>` | logging, telemetry, notifications |
| `transform` | Replaced by the result. | `fn.<name>`, `map` (data becomes the rendered `with.data` template), `http` (the response becomes data), `exec` (the program's result becomes data) | reshape, enrich, fetch, convert media |
| `filter` | Unchanged, or the packet is dropped as `filtered`. | expression | `data.age >= 18` |
| `route` | Unchanged. The packet goes to one named branch. | map of branch → expression; the last one may be `else` | priority triage |
| `agent` | Replaced by the agent's structured output. | provider: `claude_api`, or a local CLI: `claude_code`, `codex`, `pi`, `opencode` | classify, extract, summarise, draft |

**Agent nodes** use `with: { model, prompt, schema, timeout, max_tokens }`. Their cost is limited by the pipeline's `agent_budget` (§3.11). The `schema` (JSON Schema) is **required**: the agent's output is checked against it, and a non-matching result counts as an error under the node's `on_error` policy. This keeps the uncertainty of the agent's output contained inside the node. `timeout` defaults to `60s` and `max_tokens` to `4096`; the provider's API key and price table come from the engine config (D36).

**CLI agents.** `claude_code` (Claude Code), `codex` (the OpenAI Codex CLI), `pi` and `opencode` hand the prompt to a coding-agent CLI installed and logged in on the machine, which runs as the user, on the user's own account or subscription (D67). They use `with: { model, prompt, schema, timeout, cwd, allow_tools }`. `model` is optional (the CLI's own default when left out). `timeout` defaults to `5m`. The schema is required and checked the same way: Claude Code and Codex are made to answer in its shape, and pi and opencode are asked for JSON in the prompt. Each call runs in a fresh, empty folder with the CLI's tools off, or read-only where it can't turn them off. `cwd` (relative to the pipeline file) names the folder to run in instead, and `allow_tools: true` lets the CLI use its tools (edit files, run commands) without asking. A pipeline using a CLI agent that isn't installed or logged in refuses to start, with the reason and the command that fixes it.

**Exec nodes.** `tap: exec` and `transform: exec` run a program installed on the machine (ffmpeg, ImageMagick, pandoc, a script), as the user (D71). They use `with: { command, args, cwd, env, stdin, timeout, success, result, outputs }`, and every string is a template. `command` is the program: a name found on `PATH`, or a path relative to the pipeline file. `args` is a list, and each item goes to the program as one argument. There is no shell, so a file name with spaces or quotes can't break the command. `cwd` (relative to the pipeline file, which is the default) is where it runs. `env` adds environment variables, `stdin` is fed to it, and `timeout` (default `5m`) kills it. `success` lists the exit codes that count as success (default `[0]`); any other exit is a node error carrying the end of stderr. `outputs` lists the files the program must write: their folders are created first, a missing one after the run is a node error, and a transform returns them in `files`. `result` decides what a transform's `data` becomes: `info` (default) is `{exit_code, stdout, stderr, duration_ms, files}` with the last 64 KB of each stream, `text` is stdout, and `json` is stdout parsed (both up to 1 MB). A pipeline whose `command` isn't installed refuses to start, with a hint. If the runner crashes before the step commits, the program runs again, so name output files after the packet (`${meta.packet_id}`, or the input file's name) and a rerun overwrites rather than duplicates.

```yaml
render:
  from: input            # a watch input with read: path
  transform: exec
  with:
    command: ffmpeg
    args: [-y, -loop, "1", -i, ./cover.jpg, -i, "${data.path}", -c:v, libx264, -tune, stillimage,
           -c:a, aac, -pix_fmt, yuv420p, -shortest, "./out/${data.name}.mp4"]
    outputs: ["./out/${data.name}.mp4"]
    timeout: 10m
```

**Loops.** The graph may not contain cycles, with one exception: a node may declare a bounded loop back to an earlier node.

```yaml
loop:
  back_to: draft            # an upstream node id (or the node itself)
  until: data.approved == true
  max: 3                    # required
  then: dead_letter         # what happens when `max` is reached without `until` being true
```

`max` is how many times a packet may be sent back. `meta.iteration` counts how many times it has been sent back so far. The count belongs to the packet (or fan-out copy), not to one loop: a packet that passes two loops starts the second with the first one's count, and both `max` checks see the running total. Any cycle not declared through `loop.back_to` is a validation error.

### 3.5 `output`

Every pipeline has exactly **one** output in v1. Side effects that need no verification belong in `tap` nodes. The **envelope is the same for every connector**. Only `with:` differs, and it is checked against that connector's schema. The `output` block is designed so that a later `outputs:` map of named outputs can be added without breaking existing files.

```yaml
output:
  from: <node | [nodes]>
  to: sqlite                # sqlite | file | http | stdout | telegram | (phase 2: postgres, s3, queue, mqtt)
  batch:                    # optional — write several packets in one go (§3.5.1)
    size: 100
    within: 2s
  with: {...}               # connector settings
  validate: [...]           # last check before writing (deterministic, no retry)
  on_invalid: {...}
  on_error: {...}           # failures at write time (retryable)
```

| `to` | Key `with:` settings | Idempotency |
|---|---|---|
| `sqlite` | `path`, `table`, `create` (default `false`), `mode: insert \| upsert`, `key` (default `packet_id`), `columns` (template map; default: top-level fields of `data` plus the key column set to `meta.packet_id`) | Conflicts on `key` are ignored (`insert`) or update the row (`upsert`). The key column needs a PRIMARY KEY or UNIQUE constraint, which `create: true` adds. |
| `file` | `path` (templated), `format: jsonl \| json \| csv \| text`, `mode: append \| write` | `jsonl` lines carry `packet_id`; a repeated write is skipped |
| `http` | `method`, `url`, `headers`, `body`, `success: [200-299]` | Sends an `Idempotency-Key: <packet_id>` header |
| `stdout` | `format` | none |
| `telegram` | `bot` or `token`, `chat_id`, `text`, `photo`, `document`, `parse_mode` (§3.13) | none: a crash between the send and its commit sends it again |

#### 3.5.1 Batching

`batch` collects packets that are ready to be written. They are flushed together when `size` packets have collected, or `within` has passed since the first packet arrived, whichever comes first. A flush is one write: a single transaction for `sqlite`, a single append for `file`.

- **Packets stay separate.** Batching affects only how packets are written. Each packet keeps its own `packet_id`, its own `delivered` check, its own state and its own place in the dead-letter queue.
- **Failure isolation.** If a batch write fails, it is retried under `on_error`. If the retries run out, the batch is **split in half and retried, repeatedly**, until single packets remain. Only the packets that still fail go to the dead-letter queue, so one bad packet can't take 99 good ones with it.
- **Validation** (`output.validate`) runs per packet *before* a packet joins a batch. Invalid packets never enter a batch.
- **Pause, stop and drain** flush any partial batch straight away.
- **Crash safety.** A packet is journaled as waiting in the batch before it joins it, so a crash loses nothing. After a restart, waiting packets join a new batch (its `within` starts again), and anything already written is skipped by the idempotency key. `within` defaults to `1s` (D20).
- **Supported in v1:** `sqlite` and `file`. On `http` and `stdout`, `pipo check` rejects `batch`. A batch mode for `http` (one request carrying an array) is planned for Phase 2.

### 3.6 User functions

`fn: ./people.fn.ts` points to a TypeScript or JavaScript module. Each exported function is available as `fn.<name>`:

```ts
// people.fn.ts
import type { Meta } from "pipo";
export function textTransformer(data: any, meta: Meta) {
  return { ...data, name: data.name.trim(), bio: (data.bio ?? "").slice(0, 500) };
}
```

Functions run in an embedded JavaScript engine (QuickJS) inside the pipeline's runner, as plain JavaScript. A module gets the ES built-ins QuickJS has (`JSON`, `Math`, `Date`, `Promise`, `Map`, `Set`, `RegExp`, typed arrays, …), `console` (to the runner log), and `setTimeout`/`clearTimeout` (and `setInterval`/`clearInterval`), and nothing from Bun or Node: no `node:`/`bun:` imports and no `Bun`, `process`, `require`, `Buffer` or `fetch`. A module may be TypeScript and may import local files and installed packages: `pipo compile` bundles it (with `Bun.build`) into one self-contained ES module, and `pipo check` reports P059 when it can't (§5). A function gets `(data, meta)` and returns the new data, or a Promise of it; values cross as JSON. Each version pins the code it was compiled with, so a packet pinned to an older version runs that version's functions. `console.log`, `console.info`, `console.debug`, `console.warn` and `console.error` write to the runner's log. Calls run concurrently, as in Bun: while one awaits a timer (`await new Promise((r) => setTimeout(r, 500))`, say for a rate-limit backoff), the runner's other workers' calls run. A call that takes longer than 30 s from its start until its result, time spent waiting on timers included, is stopped and fails like any step error; so is a call whose Promise waits on nothing that could ever settle it. Timers belong to the call that set them and are cancelled when it ends, so nothing runs in the background between calls. Anything that needs the system (files, network, programs) belongs in a connector or an `exec` step. Functions are trusted code. A crash affects only that pipeline. Function modules that arrive through a template you didn't write are **untrusted** until you run `pipo trust <template>`. `pipo check` and `pipo start` refuse untrusted modules (§11).

### 3.7 Secrets

Secret values never appear in a `.pipo` file. They are declared by **reference** and resolved by the runner at runtime:

```yaml
secrets:
  telemetry_token: op://Pipo/telemetry/api-token   # 1Password (recommended)
  intake_token: env:PIPO_INTAKE_TOKEN              # environment variable
```

- Supported providers: `op://` (1Password) and `env:`.
- Secrets can only be used inside `with:` blocks, as `${secrets.<name>}`.
- They are redacted from the journal, logs, the UI and every response to agents.
- `pipo check` warns about literal values that look like credentials.

### 3.8 `lifetime`

```yaml
lifetime:
  ttl: 30m                       # wall-clock lifetime from start
  max_packets: 10000             # stop accepting after N accepted packets
  until: stats.delivered >= 1000 # stop when this becomes true
  on_end: drain                  # drain (default) | stop
  drain_timeout: 2m
```

If nothing is set, the pipeline runs until it is stopped. The engine can also have its own TTL (§7.5), which drains every pipeline.

`pipo start <name> --ttl 30m` (and `pipo restart --ttl`) replaces `ttl` for that start only. It counts from the same anchor (§7.4), and `on_end` and `drain_timeout` still come from the file. A later start without `--ttl` uses the file's `ttl` again (D57).

### 3.9 Error policies

Every error hook has the same shape. The top-level `errors:` block sets defaults, and any step can override them.

```yaml
on_error:
  retry: 3                  # attempts after the first one
  backoff: exponential      # fixed | exponential
  delay: 500ms
  max_delay: 1m
  then: dead_letter         # what happens once retries run out (see below)
  message: "…${error.message}…"
```

| `then` | Meaning | Allowed in |
|---|---|---|
| `dead_letter` | Move the packet to the DLQ. | everywhere (default) |
| `drop` | Discard the packet and count it as `filtered`. | input, nodes |
| `continue` | Ignore the failure and pass the data on unchanged. | `tap` nodes only |
| `pause` | Pause the pipeline. The packet stays pending. | everywhere |
| `halt` | Fail the pipeline. | everywhere |
| `agent` | Hand the packet and its error to the agent endpoint (§9). The packet waits, `escalated`, until it is resolved: retried from the failed step, dead-lettered, or dropped where `drop` is allowed (D50). | everywhere, if `agent.control` is on |

`on_invalid` (for validation failures) is never retried, because the same input would fail the same way again. At `input.on_invalid`, `then: agent` can't make the packet wait, because it was never accepted: it is rejected as usual and the agent is told (D50).

### 3.10 `delivered`: delivery verification

When the output connector acknowledges a write, the packet is *written*. The `delivered` block decides when it is *delivered*.

```yaml
delivered:
  check: record_exists      # what to verify (must be supported by output.to — see matrix)
  with: {...}
  within: 10s               # keep re-checking until this deadline
  on_fail: {...}            # error policy
  stall:                    # pipeline-level health ("jammed")
    after: 5m               # no delivery progress for this long while packets are pending
    then: pause             # notify | pause | agent (flag it as notify does and tell the agent, D50)
    message: "…"          # rendered with stats.* and stall.*; see D23 for when it fires and clears
```

**Compatibility matrix.** `pipo check` rejects any combination that isn't listed here:

| Check | sqlite | file | http | stdout | Meaning |
|---|:-:|:-:|:-:|:-:|---|
| `ack` (default) | ✓ | ✓ | ✓ | ✓ | The connector's own success report is enough. |
| `record_exists` | ✓ | | | | A row matching `with.where` exists. |
| `row_count` | ✓ | | | | `with.query` returns at least `with.min` rows. |
| `query` | ✓ | | | | A custom SQL query returns true. |
| `file_exists` | | ✓ | | | `with.path` exists. |
| `file_nonempty` | | ✓ | | | `with.path` exists and its size is greater than 0. |
| `line_contains` | | ✓ | | | The file contains a line with `with.value`. |
| `checksum` | | ✓ | | | The file hash equals `with.sha256`. |
| `status` | | | ✓ | | The write response status is in `with.success`. |
| `follow_up` | | | ✓ | | A GET to `with.url` returns success, or a body matching `with.match`. |
| `external` | ✓ | ✓ | ✓ | ✓ | Wait for an outside acknowledgement (`pipo ack`, `POST /api/.../ack` or MCP) within `within`. |
| `none` | ✓ | ✓ | ✓ | ✓ | Don't verify. Use it with `lifetime` when something outside Pipo checks the results. |

**`with:` fields per check.** All values are templates, rendered per packet.

| Check | Fields |
|---|---|
| `record_exists` | `where` (required): column → value pairs, matched with `=` and `AND` |
| `row_count` | `query` (required): a read-only SELECT; `params`: values bound to its `?` placeholders; `min`: default `1` |
| `query` | `sql` (required; `query` is accepted as an alias): a read-only SELECT whose first column in the first row must be truthy; `params` as above |
| `file_exists`, `file_nonempty` | `path`: defaults to the output's own `path` |
| `line_contains` | `value` (required): a substring of one line; `path` as above |
| `checksum` | `sha256` (required): 64 hex characters, case-insensitive; `path` as above |
| `status` | `success`: status list as in §3.5 (`204`, `"2xx"`, `"200-299"`); default `2xx` |
| `follow_up` | `url` (required); `headers`; `success` (default `2xx`); `match`: text the body must contain, or an object that must be a subset of the JSON body |

Check queries run on a read-only connection, so a check can never change data. Put data in `params`, never into the SQL text. A check that cannot run (bad SQL, unreadable file, unreachable `follow_up` URL) counts as a failed attempt and is retried until `within`; its message becomes the error.

Example of a rejection:

```
people-intake.pipo:61:10  error  P031  delivered.check 'file_exists' is not supported by output 'sqlite'
  supported: ack, record_exists, row_count, query, external, none
```

### 3.11 `agent_budget`

Agent nodes cost money, so the budget caps that cost for the whole pipeline. It has two limits:

```yaml
agent_budget:
  per_day: 5.00             # USD across all agent nodes in this pipeline, per calendar day
  reset_at: "00:00"         # optional — when the day starts, in the engine's time zone (engine.timezone)
  per_packet: 20000         # tokens (input + output) one packet may use across all agent nodes and loop passes
  warn_at: 80%              # emit a `budget.warning` event
```

- **Per-packet cap reached:** that packet goes to the dead-letter queue with error code `budget.packet`. The pipeline keeps running.
- **Daily cap reached:** the pipeline **pauses** with the reason `budget`. It keeps journaling new packets up to `buffer.max`, so no data is lost. It resumes automatically when the next budget window opens, or straight away with `pipo resume` (which asks for confirmation, because it goes over the cap).
- **Why a calendar day rather than a rolling 24 hours:** a calendar day gives one clear moment to resume, matches how providers bill and how people think about "$5 a day", and avoids the pause/resume flapping a rolling window causes as old spending ages out minute by minute.
- **Cost** is calculated from the token counts each provider reports and a price table in the engine config (`agents.<provider>.pricing`). A CLI agent's cost is what the CLI reports (Claude Code, pi and opencode report USD), else its tokens priced from that table, else $0, so a cap can't stop a CLI agent that reports nothing (D67). `pipo check` doesn't ask CLI agents for a cap (no P053). The UI and `pipo status` show spending to date.
- An engine-wide cap (`engine.agent_budget.per_day`, USD, in the home's `config.yaml`) can also be set. It applies on top of the pipeline caps, to the spend of every pipeline of the Pipo home together, per calendar day in `engine.timezone` (from midnight). It is checked like the daily cap, before each call. When the total reaches it, the next agent call of any pipeline of the home is refused the same way: the packet is held and that pipeline pauses with the reason `budget` (`cap: engine`) until the next engine day, or `pipo resume` overrides the engine cap for that pipeline until the day ends. To allow more today, raise the cap in `config.yaml` and restart the pipeline. `pipo status` and `GET /api/agent-budget` show the day's spend per pipeline and the total against the cap (D58).

### 3.12 `retention`

```yaml
retention:
  data: 7d                  # payloads of delivered/filtered packets
  trail: 30d                # packet metadata + event trail (states, timings, errors)
  rejected: 3d              # payloads of rejected input
  dlq: forever              # dead letters stay until replayed or purged (`pipo dlq purge`)
```

These are also the defaults. The journal is compacted once a day. Data from packets that are still pending, and from version history, is never removed.

### 3.13 Chat bots

A pipeline can read from a Telegram bot and send with one (D69). Bots are set up once per Pipo home, in `<home>/bots.json`, from the dashboard's **🤖 Bots** page (or `/api/bots`, §8). Each bot has a name, a token (the raw token from @BotFather, or a reference: `op://…`, `env:…`), an `allow` list and an optional `poll_every`. One bot is the default.

```yaml
input:
  via: telegram             # messages to the default bot
nodes:
  alert:
    from: input
    tap: telegram           # send mid-pipeline, here with another bot
    with: { bot: alerts, chat_id: 123456, text: "new message: ${data.text}" }
output:
  from: alert
  to: telegram              # no chat_id: replies to the chat the message came from
  with: { text: "Thanks, got it" }
```

- **Which bot.** Every telegram `with:` takes `bot` (a name from `bots.json`, never a template) or `token` (inline, e.g. `${secrets.tg_token}`). With neither, the default bot is used. A pipeline that names a missing bot, or has no bot at all, refuses to start and says how to add one. Tokens are resolved at start and redacted like secrets (§3.7). A change to `bots.json` applies from a pipeline's next start.
- **Input.** The runner long-polls `getUpdates` only while the pipeline runs: one request waits up to `poll_every` (default `25s`, at least `1s`) and returns as soon as a message arrives. Only messages whose chat or sender id is in `allow` (`with.allow` replaces the bot's list) become packets. Others are ignored, and the log names the sender's ids so they can be added. With no `allow` list, every message is ignored. The update offset is saved in the transaction that journals the packet, so each message becomes exactly one packet across crashes. `data` is `{message_id, date, chat_id, chat_type, from: {id, username, name}, text, file}`; `text` is the text or the caption. `meta.trigger` is `telegram` and `meta.source` the chat id.
- **Files.** An attached document, photo (the largest size), audio, voice, video or animation is downloaded to `<home>/pipelines/<name>/files/<unique id>-<name>` and described in `data.file: {kind, file_id, name, mime_type, size, path}`. `download: false` keeps only the description. Telegram doesn't let bots download files over 20 MB; such a file comes with `path: null` and a warning in the log.
- **Sending** (`tap: telegram`, `to: telegram`). `chat_id` defaults to the chat a telegram input's packet came from; with another input it is required (P057). `text` defaults to `data` (as JSON when it isn't a string), cut at Telegram's 4096 characters. `photo` or `document` (a path relative to the pipeline file, or an http(s) URL) sends a file, with `text` as its caption (1024 characters). `parse_mode` is `Markdown`, `MarkdownV2` or `HTML`; it is off by default, so text from data can't break the formatting. A `429` is retried up to 3 times after Telegram's `retry_after`, then the step's `on_error` applies. The output's result is `{chat_id, message_id}`, and its only delivery checks are the universal ones.
- **One poller per bot.** Telegram lets one reader take a bot's updates. A runner records the bot id it polls in its registry entry (`telegram_bot`), and a second pipeline polling the same bot refuses to start, naming the first. `pipo check` on several files warns about it (P056). Sending needs no poll, so any number of pipelines can send with one bot.

---

## 4. Full example

The refined version of the example in `idea.txt`. The cycle in the original (node1 ↔ node2) has been removed, and every node now reaches the output.

```yaml
pipo: 1
name: people-intake
description: Accept people from a webhook, normalise them, report telemetry and store them in SQLite.

fn: ./people.fn.ts

secrets:
  intake_token: op://Pipo/people-intake/webhook-token
  telemetry_token: op://Pipo/telemetry/api-token

lifetime:
  ttl: 30m
  on_end: drain

errors:
  retry: 2
  backoff: exponential
  delay: 500ms
  then: dead_letter

input:
  via: http
  with:
    path: /people
    method: POST
    auth:
      header: X-Pipo-Token
      equals: "${secrets.intake_token}"
  format: json
  validate:
    - exists(data)
    - type(data.name) == "string" && len(trim(data.name)) > 0
    - data.age > 30
  on_invalid:
    respond: 422
    message: "Rejected: rule '${error.rule}' failed"

nodes:
  logger:
    label: Logger
    from: input
    tap: log
    with:
      level: info
      message: "Received ${meta.packet_id} via ${meta.trigger} from ${meta.source}"

  normalize:
    from: logger
    transform: fn.textTransformer

  telemetry:
    label: Telemetry
    from: normalize
    tap: http
    with:
      method: POST
      url: https://telemetry.example.com/v1/events
      headers:
        Authorization: "Bearer ${secrets.telemetry_token}"
      body:
        event: pipo.packet.processed
        pipeline: "${meta.pipeline}"
        version: "${meta.version}"
        packet_id: "${meta.packet_id}"
        node: "${meta.node}"
        trigger: "${meta.trigger}"
        received_at: "${iso(meta.received_at)}"
        latency_ms: "${now() - meta.received_at}"
        payload_bytes: "${size(data)}"
    on_error:
      retry: 3
      then: continue            # telemetry must never block delivery

output:
  from: telemetry
  to: sqlite
  with:
    path: ./data/people.db
    table: people
    create: true
    mode: upsert
    key: id
    columns:
      id: "${meta.packet_id}"
      name: "${data.name}"
      age: "${data.age}"
      bio: "${data.bio}"
      received_at: "${meta.received_at}"
  validate:
    - type(data.age) == "number"
    - len(data.name) <= 200
  on_invalid:
    then: dead_letter
    message: "Packet ${meta.packet_id} failed output rule '${error.rule}'; not written"
  on_error:
    retry: 5
    backoff: exponential
    max_delay: 1m
    then: dead_letter
    message: "Could not write ${meta.packet_id} to ${output.with.path}#${output.with.table} after ${error.attempts} attempts: ${error.message}"

delivered:
  check: record_exists
  with:
    where: { id: "${meta.packet_id}" }
  within: 10s
  on_fail:
    then: dead_letter
    message: >
      Delivery unverified: sqlite acknowledged packet ${meta.packet_id} (rowid ${result.rowid}),
      but no row with id=${meta.packet_id} exists in ${output.with.table} after ${error.elapsed}.
      Look for a rolled-back transaction, a trigger deleting rows, or another process replacing ${output.with.path}.
  stall:
    after: 5m
    then: pause
    message: >
      Pipeline jammed: ${stall.pending} packets pending and none delivered for ${stall.duration}.
      Oldest packet ${stall.oldest.packet_id} has been at '${stall.oldest.node}' for ${stall.oldest.age}
      (attempt ${stall.oldest.attempt}, last error: ${stall.oldest.last_error}).

agent:
  control: true
  actions: [pause, resume, replay, push]
  edit:
    - nodes.normalize
    - nodes.telemetry.with
    - errors
```

### 4.1 Agent node with a bounded loop and routing

```yaml
pipo: 1
name: ticket-triage

agent_budget:
  per_day: 3.00
  per_packet: 15000

input:
  via: http
  with: { path: /tickets }
  format: json
  validate:
    - len(data.subject) > 0

nodes:
  draft:
    from: input
    agent: claude_api
    with:
      model: claude-sonnet-5-5
      prompt: |
        Classify this support ticket (priority: high|normal) and draft a first reply.
        If reviewer feedback is present, address it.
        ${json(data)}
      schema: ./schemas/draft.schema.json
      timeout: 60s

  review:
    from: draft
    agent: claude_api
    with:
      model: claude-sonnet-5-5
      prompt: |
        Check the classification and the reply. Set approved=true only if both are correct;
        otherwise put concrete feedback in `feedback`.
        ${json(data)}
      schema: ./schemas/review.schema.json
    loop:
      back_to: draft
      until: data.approved == true
      max: 3
      then: dead_letter

  triage:
    from: review
    route:
      urgent: data.priority == "high"
      normal: else

  page:
    from: triage.urgent
    tap: http
    with:
      method: POST
      url: https://pager.example.com/hooks/support
      body: { ticket: "${data.id}", subject: "${data.subject}" }

output:
  from: [triage.normal, page]
  to: file
  with:
    path: ./out/tickets.jsonl
    format: jsonl

delivered:
  check: line_contains
  with: { value: "${meta.packet_id}" }
```

---

## 5. Validation (`pipo check`)

Every finding is reported as `file:line:col severity code message`. The validator runs before any start or change, including changes proposed by agents.

| Group | Rules |
|---|---|
| **Schema** | The YAML is well-formed. Required keys are present. Each connector's `with:` matches its schema. Durations and cron expressions parse (`schedule` needs exactly one of `cron` or `every`, P038). `agent.verify` is `last N` with *N* from 1 to 1000 (P055). |
| **References** | Every `from` target exists. Route branches exist. `fn.<name>` is exported by the `fn` module. Schema files exist and are valid JSON Schema (P054). `${secrets.x}` names are declared. |
| **Graph** | Every node can be reached from `input`. Every node leads to `output` (no dead ends). The only cycles are declared `loop.back_to` edges, and each has a `max`. `back_to` points upstream. |
| **Compatibility** | A telegram send without `chat_id` needs `via: telegram` (P057, §3.13). `delivered.check` is supported by `output.to` (§3.10). `batch` is supported by `output.to` (§3.5.1). `then: continue` appears only on taps. `then: agent`, `delivered.stall.then: agent` and `agent.on_stall: handle` require `agent.control` (P034). `respond` is used only with `via: http`. When a fan-out sends more than one copy to the output, an explicit key (the sqlite `columns` key, an http `Idempotency-Key` header) or a `delivered.with` lookup by `meta.packet_id` that doesn't use `meta.branch` is a warning (P026, D22). |
| **Expressions** | Expressions parse, use only allowed helpers, and use only the context variables available at that position. |
| **Safety** | Warns about literal credential-like strings. Warns when an exec `command` holds spaces, since it is probably a whole command line that belongs in `args` (P058). `secrets` may not appear outside `with:`. Agent nodes must have a `schema`. Warns when there are agent nodes but no `agent_budget`. Untrusted `fn` modules, and exec nodes in an untrusted pipeline file, are refused (P052). An `fn` module must bundle into one self-contained module that runs without Bun or Node APIs: an import of `node:*`/`bun:*` or a Node built-in, a use of a host global (`Bun`, `process`, `require`, `Buffer`, `fetch`, …, other than in `typeof`), or a failed bundle is an error (P059, §3.6; checked by the CLI's `pipo check` and `pipo compile` once the file has no other errors). Across a multi-file `pipo check` (a folder, or several files), warns when two http inputs declare the same `input.with.listen` port (P039; `listen` is a bare port on the runner's loopback, so equal ports always collide; a single-file check never warns), and when two telegram inputs poll the same bot (P056). |

---

## 6. CLI (`pipo`)

Every command except `pipo run` supports `--json` for scripts and agents (`pipo run` is the foreground data plane and streams its logs to the terminal). If the engine isn't running, `pipo` starts it on demand.

`pipo run <file> [--listen <port>]` runs one pipeline in the foreground without the engine, which is useful during development. Its HTTP input is served at the same `/in/<pipeline><path>` route the gateway uses, on the runner's own port. Ctrl-C drains the pipeline, and a second Ctrl-C stops it at once.

| Area | Commands |
|---|---|
| **Create** | `pipo new <name> [--template <t>]` · `pipo generate node <pipeline> <id> --kind <kind> [--from <node>]` · `pipo templates` |
| **Validate and test** | `pipo check [file]` · `pipo compile <file> [--home <dir>] [--stdin]` (advanced, used by the runner: one JSON document with the diagnostics, the definition, the bundled `fn` module, schemas, file hashes and agent settings; exit 1 when there are errors) · `pipo fmt [file]` · `pipo test <file|dir> [--fixtures dir] [--update-snapshots] [--json]` (runs fixtures in-process with outputs mocked, compares with snapshots) |
| **Run** | `pipo start <file\|name> [--ttl 30m] [--detached] [--listen <port>]` (`--ttl` replaces `lifetime.ttl` for this start, saved in the runner registry, D57) · `pipo runners` (every runner found, with pid, port, version and whether it's attached, detached, stale or unreachable) · `pipo attach [name]` (scan again and reattach) · `pipo stop <name> [--now]` (drains unless `--now`) · `pipo pause <name>` · `pipo resume <name>` · `pipo restart <name>` |
| **Observe** | `pipo status [name] [--watch]` · `pipo logs <name> [-f] [--node id]` · `pipo packets <name> [--state s] [--limit n] [--after id]` · `pipo inspect <name> <packet_id>` (full trace: data at each node, timings, errors). `packets`, `inspect` and `dlq` also work on a stopped pipeline, from its journal (D34). |
| **Recover** | `pipo dlq <name>` · `pipo dlq replay <name> [ids…\|--all]` (resumes each packet at the step it failed on, D33) · `pipo dlq purge <name> [ids…\|--all]` · `pipo push <name> --data '{…}'\|--file f` · `pipo ack <name> <packet_id>` |
| **Versions** | `pipo history <name>` (who made each version, why, and packets still pinned to it) · `pipo diff <name> <v1> <v2>` (unified diff) · `pipo rollback <name> <v>` (runs v's definition again as a new version, for new packets only; needs the runner) · `pipo proposals <name>` (list; `--state`) with `show <id>` (diff, problems, dry-run summary), `propose <file> --reason "…" [--base n] [--hold]`, `apply <id>` and `reject <id> --reason "…"` (D51); `pipo resolve <name> <id…> --action retry|dead_letter|drop` settles packets handed to the agent (D50). `history` and `diff` also work on a stopped pipeline, from its journal (D34, D38). |
| **Engine** | `pipo engine start\|stop\|status [--ttl 8h] [--listen <port>]` (`stop` drains the pipelines; detached runners keep running, D35) · `pipo ui [--workspace <dir>]` (starts the engine when none runs, then opens the dashboard, D61; warns when the running engine is older than Pipo's code, D64) |

```
$ pipo status
PIPELINE        STATE    VER  UPTIME   IN/MIN  PENDING  DELIVERED  DLQ  LAST DELIVERY
people-intake   active   v3   12m04s       42        3      5,112    2  1s ago
ticket-triage   jammed   v1   2h10m         0       17        230    0  6m ago   ⚠ stalled at 'review'
```

---

## 7. Engine

### 7.1 Architecture

```
            ┌───────────────────────── pipod (control plane) ─────────────────────────┐
  webhooks ─┤ HTTP gateway /in/*   REST /api/*   MCP /mcp   SSE /events   UI /ui      │
  CLI, UI  ─┤ supervisor · scheduler · version store · proposal queue                 │
            └──────┬──────────────────────┬──────────────────────┬────────────────────┘
                   │ unix socket          │                      │
            ┌──────▼──────┐        ┌──────▼──────┐        ┌──────▼──────┐
            │ runner      │        │ runner      │        │ runner      │   data plane:
            │ people-…    │        │ ticket-…    │        │ …           │   one Rust process
            │ journal.db  │        │ journal.db  │        │ journal.db  │   per pipeline
            └─────────────┘        └─────────────┘        └─────────────┘
```

- **The engine is built on Bun** and uses `Bun.serve`, `bun:sqlite` and Bun subprocesses.
- **The runner is a Rust binary** (`pipo-runner`, `crates/pipo-runner`), small enough to run one per pipeline: about 9 MB resident when idle. TypeScript checks and Rust executes: the runner runs `pipo compile` (the CLI's checker) at start, on `apply`/`rollback` and when it validates a proposal, and stores each version's compiled form in the journal, so Bun runs only for the moment of a compile, never while packets flow. `fn` modules run in the runner's embedded QuickJS (§3.6). The binary also answers `pipo test` (`pipo-runner test`) and reads without a runner (`pipo-runner read`, D34). D73 has the details.
- **One runner process per pipeline.** The runner owns that pipeline's journal, its inputs (in detached mode), its schedules and its connectors. The engine restarts crashed runners with backoff.
- **Engine config and restarts.** The engine (`pipod`) reads `config.yaml` (an `engine:` map: `ttl`, `detached`, `listen`, `idle`, `env_allow`, `start_timeout`, `stop_timeout`, `restart`, `timezone`, `agent_budget`, `mcp` (the agent endpoint's tokens, §9.2), `workspace` (where the builder saves new pipelines, D72); and an `agents:` map of provider settings: `pricing`, plus `api_key` and `base_url` for `claude_api` or `command` (the executable) for a CLI agent, D36, D67), writes its own entry to `run/engine.json`, and sends each runner's output to `logs/<name>.log`. Restart backoff and when the engine gives up are in D25.
- **Gateway.** With `engine.listen` set (`0` picks a free port, which `run/engine.json` records), the engine serves `/in/<pipeline>/…` (proxied to the runner's own port), REST `/api/*`, SSE `/events` and the dashboard at `/ui` (§8, D40) on `127.0.0.1`. REST includes `GET /api/pipelines/<name>/graph`, the nodes, edges and per-node counters the UI draws, and `GET /api/agent-budget`, the day's agent spend of the home against `engine.agent_budget.per_day` (D58). Details in D28.
- **State lives in `~/.pipo/`:** `config.yaml`; `pipelines/<name>/{journal.db, versions/}`; `run/<name>.json` (the runner registry, §7.2) and `run/<name>.sock`; `logs/`.
- By default the server binds to `127.0.0.1`. Exposing inputs to a network is an explicit choice.

### 7.2 Detached mode

With `pipo start --detached`, or `detached: true` in engine config, a runner **keeps running if the engine dies**:

- Inputs other than HTTP (`schedule`, `watch`, `system`) fire from the runner itself.
- Runners enforce their own `lifetime` and stall detection while the engine is away. When the engine reattaches it follows them through the journal events rather than arming them again, so nothing fires twice (D30).
- Status events are written to the journal while the engine is away.
- The runner runs in its own session, so neither a signal to the engine's terminal nor the engine's death reaches it. Stopping the engine leaves detached runners running; `pipo stop <name>` stops one. Details in D30.

**HTTP ports.** Pipo never assigns ports automatically. A detached HTTP input gets its own port in one of two ways:

- in the file: `input.with.listen: 8081`
- when starting it: `pipo start people-intake --detached --listen 8081`. This overrides the file and is saved in the runner registry, so restarts and reattaches reuse the same port.

Before starting, the engine checks that the port is free (the CLI's start goes through it). If it isn't, the start is refused with an error that names the process holding the port, or the pipeline if another runner holds it. `pipo check` warns when two pipelines in the same project declare the same port. While the engine is up, the gateway also proxies `/in/<pipeline>/…` to the runner, so the input is reachable both through the gateway and directly on its port. While the engine is down, only the direct port works. An HTTP input without `listen` is unreachable until the engine returns.

**Runner registry.** Each runner writes `~/.pipo/run/<name>.json` atomically and removes it on a clean stop:

```json
{ "pipeline": "people-intake", "version": 3, "pid": 41822, "socket": "~/.pipo/run/people-intake.sock",
  "listen": 8081, "detached": true, "ttl": "30m", "started_at": "2026-10-03T09:12:44Z", "engine_id": "e_01J9…" }
```

`ttl` is there only when the start passed `--ttl` (D57). Like `listen`, the engine passes it again when it restarts a crashed runner, adopts a live one, or restarts one that died while no engine ran.

**Control socket.** Each runner listens on `run/<name>.sock` (owner-only) and writes its registry entry only once the socket listens. The protocol is newline-delimited JSON: a request `{id, op, args}` gets one response `{id, ok: true, result}` or `{id, ok: false, error: {code, message, hint}}` (an `invalid_pipeline` error adds `diagnostics`, as `pipo check --json` gives them, D60). The ops are `hello` (pipeline, version, pid, state, status, `started_at`: the handshake), `status` (adds `stats`, `paused_reason`, `awaiting_ack`, `last_seq`), `pause` (`reason: manual | agent`), `resume`, `drain`, `stop`, `push` (`data`, optional `source`; replies with the `packet_id` once the packet is journaled), `ack` (`packet_id`, for the `external` check, §3.10), `events` (`after_seq`, `limit`: journal events with their `seq`, so a reattaching engine replays what it missed), the packet reads and DLQ ops of D33 (`packets` (`state`, `limit`, `after`), `packet` (`id`), `dlq`, and `replay` and `purge` (`ids` or `all`)), and the version ops of D38: `versions`, `version` (`version`), `diff` (`from`, `to`), `apply` (`source`, `reason`, `by`) and `rollback` (`version`, `by`), and `apply_proposal` (`id`, `by`: a change proposal becomes the next version, D49), and `resolve` (`ids` or `packet_id`, `action`, `by`, `by_kind`, `reason`: retry, dead-letter or drop packets waiting for the agent, D50). Every response is redacted. A runner refuses to start when a live runner answers on its socket, and removes a socket nothing answers on. Details in D24.

**Discovery and reattach.** The engine and the CLI both use the registry:

- **When the engine starts**, it reads every registry entry. For each one, it checks that the pid is alive and performs a socket handshake confirming the pipeline name and version.
  - If the runner is alive, the engine reattaches: it replays the events it missed from the runner's journal and takes back TTLs, stall detection and control. The pipeline never notices the outage.
  - If the runner is dead, the engine removes the stale entry. If the pipeline was active, the engine restarts it, and the journal resumes the packets that were in flight.
  - If the pid is alive but the handshake fails, the engine leaves the runner alone (never kills it or starts a second one) and shows it as `unreachable` until `pipo attach` succeeds. Adopted runners, restarts and the event cursor are in D27.
- **`pipo runners`** lists every runner the registry and socket checks find: pid, port, version and whether it is attached, detached or stale.
- **`pipo attach [name]`** tells the engine to scan again and reattach now, for example after a failed handshake. Without a name, it reattaches every runner it can.
- **If the engine is down or can't start**, or when `--no-engine` is passed, the CLI talks to detached runners directly through their sockets. `status`, `logs`, `inspect`, `pause`, `resume` and `stop` all work, and their output is marked `engine: down`. Any command that does start the engine reattaches every runner as part of starting up.

### 7.3 Delivery guarantees

- **At-least-once.** A packet is journaled before it is acknowledged, and each node's result is committed before the next node runs. After a crash, processing resumes from the last committed node, so a tap may run twice.
- **Idempotency.** Outputs use `meta.packet_id` as their idempotency key (§3.5; `packet_id:<branch>` for a fan-out copy, D22), so a repeated write does not create a duplicate. The same applies to a batch written again after a crash.
- **Version pinning.** A packet finishes on the pipeline version that accepted it, with that version's own `fn` code and schema files as compiled when the version was stored (`versions.compiled`, D73), never re-read from disk. A new version applies only to newly accepted packets.
- **Ordering.** `concurrency: 1` gives FIFO order. Above that, packets may complete out of order.

### 7.4 Time and schedules

Each runner owns the clocks of its pipeline: schedules, `lifetime` (`ttl`, `max_packets`, `until`), stall detection and retention clean-up, attached or detached (D30). The engine never arms them itself, so a reattach can't fire anything twice. It learns what happened from the journal events it replays (`pipeline.lifetime`, `pipeline.stall`, `pipeline.paused`, `pipeline.stopped`). The engine keeps only its own clocks: the engine TTL and idle sleep (§7.5).

A pipeline's `ttl` is anchored to the first `pipeline.started` since the last clean `pipeline.stopped`, `pipeline.completed` or halt (`pipeline.failed`). A deliberate stop or `pipo restart` resets it; a crash or a new version does not. A start's `--ttl` (D57) counts from the same anchor. After a crash restart the runner arms only the time that is left, and ends at once if it is already over, so a crashing pipeline can't run past its TTL.

`schedule` inputs (§3.3) use a 5-field cron expression (`*`, lists, ranges, steps; when both day fields are restricted, either may match) or an `every` duration. Cron is evaluated in UTC. `every` counts from when the runner starts. Each tick becomes one packet with `meta.trigger: schedule` and `meta.source` set to the tick time (ISO 8601). The packet is journaled before the next tick is armed. Ticks missed while the runner was down or suspended are skipped, not replayed.

### 7.5 Engine lifetime

- The engine runs while any pipeline is `active`, `paused`, `draining` or `jammed`, or has pending packets.
- When every pipeline is stopped or completed and nothing is pending, the engine **sleeps**: it exits, and the next `pipo` command starts it again. It waits `engine.idle` (default `5m`) with nothing to do before it sleeps (D31). Detached runners it supervises count as busy, so pending packets always have a runner.
- **An open event stream keeps it awake.** While any `/events` stream is connected (an open dashboard, say), the engine does not sleep; the idle clock starts when the last one closes. The TTL still applies (D61).
- **Engine TTL** (`pipo engine start --ttl 8h`, `pipod --ttl 8h`, or `engine.ttl` in config): when it expires, every pipeline drains and the engine stops. Detached runners keep running and end on their own lifetime, which the runner owns (D30, D31).

### 7.6 Observability

Every packet state change and pipeline state change is an event. Events are written to the journal, streamed over `/events` (SSE, event ids `<pipeline>:<seq>`, D28) to the UI and CLI. Built-in metrics cover throughput, pending count, DLQ size, latency per node and the age of the oldest pending packet. They appear in the runner's `stats` (the control `status` op), in `/api` (`GET /api/pipelines/<name>`, under `runner.stats`) and in `pipo status`. Export as OpenTelemetry (`engine.otlp`) is a Phase 2 item (D41). A telemetry node like the one in §4 is only needed for *custom* business telemetry.

The latency and oldest-pending fields are read from the journal, so they survive restarts and work for detached runners (D54):

- `stats.latency`: one entry per node id of the version in force, plus `output` (the output write), each `{count, p50_ms, p95_ms, max_ms}`. They cover the node's latest `stats.latency_window` (100) completed steps, whatever their age. `count` is the number of steps in that window. Percentiles use the nearest rank. With no completed step, `count` is 0 and the rest are null. A step's latency is the time from when the runner starts it to the commit of the transition that completes it, retries and their waits included. A completed step is a node's result (moved on, fanned out, filtered or dead-lettered) or the output's write. For a batch, it is the write of the packet's group. An escalated or held step has no latency until it runs again and completes. A step killed by a crash has none either, and its rerun after the restart counts once. Delivery checks are not included.
- `stats.oldest_pending_age_ms` and `stats.oldest_pending_received_at` (ISO): the age and `received_at` of the oldest packet that is not terminal. Pending here means what `stats.pending` counts: in flight, held by a pause, in a batch, waiting on its fan-out copies or escalated to an agent. Both are null when nothing is pending. A replayed DLQ packet keeps its `received_at`.
- `pipo status <name>` prints them under the table (`oldest pending: 3m12s (received …)`, and a `NODE COUNT P50 P95 MAX` table). `--json` has the raw fields. The list without a name keeps its columns.
- Agent spend (§3.11, D58): the runner's `stats.agent_spend_today` (USD in the pipeline's own budget day) shows under `pipo status <name>` as `agent spend today: $…`. Under the table, `pipo status` prints the home's total for the engine day against `engine.agent_budget.per_day` and the spend per pipeline, shown when a cap is set or anything was spent. `--json` has it as `agent_budget` (`per_day` or null, `spent_usd`, `window_start`, `resets_at`, `timezone`, `pipelines`), the same object as `GET /api/agent-budget`.

---

## 8. UI

**Phase 1: observe and debug**
The engine serves it at `/ui` (`pipo ui` starts the engine when none runs, then prints the URL and opens it, D61); it is static files with no build step (D40). It has the pipeline list (with the lifetime remaining, counting down live, and packet counts per state, the oldest pending age and `throughput_per_min` (packets accepted in the last 60 s, as `in_per_min` in D21) from `GET /api/pipelines`, `stats`, null when the journal can't be read), the live graph, the packet inspector, a live log tail, the agent feed (proposals with status, author and reason, and what was handed to the agent or resolved), the DLQ and the versions with diffs (D59).

- A list of pipelines showing state, version, throughput, pending, delivered and DLQ counts, and lifetime remaining.
- A graph view drawn from the `.pipo` file, with live counters and error badges on each node.
- A packet inspector that traces one packet through every node, showing its data, timings, attempts and errors. The first step shows the data the packet came in with; each later step shows the top-level keys it set or changed, and the keys it dropped as `removed: − key` (never as `null`, which is a value a step can really write).
- Live logs, the DLQ (with replay), version history with diffs, and a feed of agent activity and proposals.
- Pause, resume, drain, stop, restart and start controls, on each pipeline's page and in the task manager.
- A task manager (`#/top`, **🧮 Tasks**): every pipeline with its state, runner pid, CPU, memory, process count, throughput and pending count, refreshed every 2 s and sorted by CPU, with its controls on each row (D68).
- A bots page (`#/bots`, **🤖 Bots**): add, edit, rename, test, make default and remove the Telegram bots of the home (§3.13, D69). A token is typed into a password field and never shown again.
- A settings page (`#/settings`, **⚙️ Settings**): the workspace, the folder the builder saves new pipelines in (D72). Pick one by walking folders from the current one, or type a path; a missing folder can be created. The choice applies at once and is saved as `engine.workspace` in `config.yaml`.

The dashboard has a friendly, playful look (D63). It has light and dark themes, follows the system theme until one is picked, and respects `prefers-reduced-motion`. Each pipeline's overview has a **🧪 Send a test packet** card that pushes a packet into the running pipeline (`POST …/push`); on the live graph, packets travel along the edges as they flow. A pipeline's page always has a **✏️ Edit** button that opens its file in the builder, even before the pipeline has a journal (it never started, or failed to start); a tab that can't load shows its error in place of its content. When the engine can't be reached, the dashboard shows a "napping" screen that names the command to wake it and reconnects by itself (D61). When the engine is older than Pipo's code on disk (it was updated since the engine started), the dashboard shows a banner asking for a restart, with a **🔄 Restart now** button (D65), and an API route the engine doesn't know yet is reported as that, not as a bare 404 (D64).

**Phase 2: build** (the builder, `#/build`)
- A visual node editor that saves back to the `.pipo` file. The file remains the source of truth, and edits run through `pipo check` live. Blocks are dragged (or clicked) from a palette of inputs, steps and outputs onto a canvas. A new block slots in after the selected block, or before the output, and takes over what was fed there. Blocks are wired by dragging from an out-port (one per route branch) onto another block. A block or wire is removed with Delete, and removing a block wires its parents straight to what it fed. Undo and redo cover every edit. Block positions are kept in the browser, not in the file, and so are unsaved edits, per file: reopening a file brings them back (its saved version one undo away) as long as the file hasn't changed since. Otherwise the saved version opens and the old edits are dropped with a note. Work started in one file (a check, a dry run, a save) finishes for that file even if another is opened meanwhile. Agents sit in one **🤖 Agents** row of the palette that folds open in place (Claude API, Claude Code, Codex, pi, opencode). One that can't run on this machine (not installed, not logged in, no API key; `GET /api/builder/agents`) is greyed out: clicking it says why and what to do instead of adding it, and an agent block using it shows the same in its inspector, with a 🔄 check again. Changing an agent block's provider keeps the settings the new one also takes (prompt, schema, timeout) and drops the others. Its model field suggests the provider's models but takes any text; a new Claude Code block starts on `sonnet`, a Codex block on Codex's first listed model, and pi and opencode on their own default (D67). Diagnostics show as badges on their block and in a problems list. Some come with a one-click fix: a schema file the pipeline names but that doesn't exist (P014 on an agent's `with.schema` or the input's `schema`) is created with a starter schema, and an agent node without a cost cap (P053) gets `agent_budget: {per_day: 1}`. Every block's inspector shows **📦 data**: an example of `data` as it reaches the block (as it leaves, for the input), and clicking one of its paths puts it in the field last used, as `${data.x}` in a template or `data.x` in an expression (D70). An agent node's inspector edits its schema file in place (the "answer shape"), and the dry run's stub for it is generated from that schema. Until a draft is saved, its file is the one Save offers, `<workspace>/<name>/<name>.pipo`, and checks, dry runs and schema files resolve relative paths from there.
- Pickers for connectors and node kinds, driven by connector schemas, plus a test run against fixtures. Each connector's `with:` form is generated from its JSON Schema in the manifests. The test panel dry-runs the draft against a sample packet or the pipeline's fixtures (it starts on the file's first fixture, and a picked fixture runs with its own `meta` and `stubs` unless its data is edited), lights up the path on the canvas and shows the data leaving every step (D62).
- **Save** writes the file (a new one goes in the engine's workspace, D61). **▶️ Save & run** saves and starts it. For a running pipeline, **🚀 Apply live** sends the draft as a human proposal (`by: ui`, `apply: true`, §9.3) and, once it is applied, saves the file too, so the next start runs the same version. A refused proposal leaves the file as it was.

The builder talks to the engine through `/api/builder/*` (D62). All of it is local `/api` (loopback only, JSON POSTs), and none of it starts, stops or changes a running pipeline; the builder uses the existing routes for that (`POST /api/pipelines`, proposals).

- `GET /api/builder/catalog`: `{workspace, inputs, taps, transforms, agents, outputs, checks, node_kinds, then}`. Each connector is `{description, with}` (the JSON Schema of its `with:` block from the connector manifests); outputs add `checks` (the delivery checks they support besides `ack`, `external` and `none`) and `batch`; agents add `label`, `runs` (`api` or `cli`) and their default `timeout`.
- `GET /api/builder/agents[?refresh=1]`: `{agents, checked_at}`, which agents can run on the engine's machine (D67). Each is `{label, runs, ready, version?, reason?, hint?, models}`: a CLI agent is ready when it's installed and logged in (the check a runner makes at start), `claude_api` when its `env:` key is set (an `op://` one is assumed fine). `models` are the ones to offer for `with.model`. The answer is cached for 5 minutes; `refresh=1` checks again.
- `GET /api/builder/files`: `{workspace, files: [{file, rel, name}]}`, the `.pipo` files under the workspace (D61), four folders deep at most, skipping dot folders, `node_modules`, `fixtures` and `__snapshots__`, sorted by `rel`, at most 500. `name` is null when the file doesn't parse.
- `GET /api/builder/open?file=<abs>` or `?pipeline=<name>`: `{file, source, pipeline, diagnostics, fixtures, fixtures_error?, stubs, running}`. `pipeline` is the parsed value (null on a YAML error), `diagnostics` is `pipo check`'s. `fixtures` (`[{name, data, meta?, stubs?}]`) and `stubs` come from the file's `fixtures/` folder as `pipo test` reads them (§10.3); a bad fixture leaves the list empty and says why in `fixtures_error`. `running` is `{name, state, version, version_source}` when the engine knows a pipeline with that file (`version_source` is the definition of the version in force, from its journal), else null.
- `POST /api/builder/check {source | pipeline, base?, file?}`: a live `pipo check` of a draft. Send exactly one of `source` (`.pipo` text) and `pipeline` (a parsed value, written to text with `base`, see D62). Always `200 {source, pipeline, diagnostics, ok}`; `ok` is false when any diagnostic is an error. `file` (default `<workspace>/<name>.pipo`) is where relative paths (`fn`, schemas) are looked up.
- `POST /api/builder/save {file, source, overwrite?}`: writes the file (atomically) and returns `{file, created, diagnostics}`. A file with errors is saved too: it is a draft, and `pipo start` refuses it with the same diagnostics.
- `GET /api/builder/schema?file=&path=` and `POST /api/builder/schema {file, path, schema, overwrite?}`: read or write a schema file named by the pipeline at `file` (which need not exist yet). `path` is relative, ends in `.json` and must stay in or below the pipeline's folder (real paths), and `file` follows the open/save rule (D62). The read returns `{file, path, exists, schema, problem}`; the write refuses a value that isn't a usable JSON Schema (`400`, as P054 judges it), an existing file without `overwrite` (`409`), and creates missing folders only inside the workspace.
- `POST /api/builder/test {source, file?, fixtures, stubs?}`: runs the draft against 1–50 fixture packets as `pipo test` does (§10.3: taps and the output mocked, agent nodes and `transform: http` stubbed, nothing sent or written), with the real clock and a trace, and returns the test report: `{pipeline, fixtures: [{fixture, outcome, units, taps, calls, error?}], counts}`. Each unit has `steps: [{step, data}]`. A draft with check errors or a feature the runner refuses is `422 invalid_pipeline` with `diagnostics` and `gaps`; a bad fixture is `400`.

---

## 9. Agents in Pipo

### 9.1 Four roles

1. **Author.** Agents write `.pipo` files using the published JSON Schema, the generators and `pipo check`/`pipo test`. They do not change engine code. That happens only in Pipo's own development.
2. **Operator.** Agents use the agent endpoint (§9.2) to watch pipelines, pause, resume and replay them, push packets and handle stalled packets or packets escalated with `then: agent`.
3. **Editor.** Agents change a *running* pipeline through the change protocol (§9.3), within the pipeline's `agent:` policy.
4. **Node.** `agent:` nodes run inside the graph with a required output schema, a timeout and a budget (§3.4).

### 9.2 Agent endpoint

The engine serves an **MCP server at `/mcp`** (Streamable HTTP, revision 2025-06-18 or later: one JSON-RPC message per POST, answered as JSON; no sessions, no server stream). It also offers the same operations over REST and through `pipo … --json`; its tools call the REST handlers. Access uses scoped bearer tokens listed in engine config, each a reference (`op://` or `env:`) resolved when the engine starts:

```yaml
engine:
  mcp:
    tokens:
      - name: ops-agent                  # author of its proposals, `by` of what it does
        token: op://Pipo/mcp/ops-agent   # or env:PIPO_MCP_TOKEN; never the token itself
        scope: operate                   # read (default) | operate | edit
        pipelines: [people-intake]       # optional allowlist (default: all)
```

- **Scopes.** `read`: `list_pipelines`, `get_status`, `get_events`, `inspect_packet`, `list_dlq`, `check_pipo`, `get_proposal` and every resource. `operate` adds `replay`, `push`, `ack`, `pause`, `resume` and `resolve`. `edit` adds `propose_change` and `rollback`. Requests send `Authorization: Bearer <token>`: a missing or unknown token is `401`, and with no usable token configured `/mcp` answers `403` with a hint. A pipeline outside a token's allowlist does not exist for it.
- **The pipeline's policy** (its version in force) applies on top: every pipeline tool and resource needs `agent.control: true`; `pause`, `resume`, `replay`, `push` and `ack` also need that action in `agent.actions`; proposals are checked against `agent.edit` (§9.3). Proposals and rollbacks made over MCP are recorded `author_kind: agent` with the token's name. An agent's `rollback` is a proposal of the older version's source, so the same checks apply.
- **Tools:** `list_pipelines`, `get_status`, `get_events`, `inspect_packet`, `list_dlq`, `replay`, `push`, `ack`, `pause`, `resume`, `check_pipo`, `propose_change`, `get_proposal`, `rollback`, and `resolve` for escalated packets (D50).
- **Resources:** pipeline sources and versions (`pipo://pipelines/<name>/source`, `…/versions`, `…/versions/<n>`), connector schemas (`pipo://connectors/<kind>/<name>`), the `.pipo` JSON Schema (`pipo://schema/pipo.schema.json`) and this spec (`pipo://docs/spec.md`).
- Every response is redacted: secrets always, plus any extra paths listed in `agent.redact` (paths in packet data such as `data.email`; their values are masked wherever else they appear in the response too). Details in D53.

### 9.3 Change protocol: propose → validate → apply

```yaml
agent:
  control: true                        # enables the endpoint for this pipeline
  actions: [pause, resume, replay, push]
  edit:                                # paths an agent may change; everything else is forbidden
    - nodes.*.with.prompt
    - nodes.normalize
    - errors
  redact: [data.email]
  on_stall: notify                     # notify | handle (agent takes over stalled packets)
```

1. **Propose.** The agent submits a patch against version *N*, with a short reason.
2. **Validate.** The patch must pass `pipo check`, and it must touch only paths listed under `agent.edit`. Changes to `output`, `delivered`, `secrets`, `agent` and `agent_budget` are always forbidden for agents (D47).
3. **Dry-run (optional).** If `agent.verify: last 20` is set, the new version replays the last 20 delivered packets in memory, with outputs and taps mocked and agent nodes replayed from what they returned before. The proposal is rejected if results diverge beyond the schema: a replayed packet fails a step, or no longer passes the input's or the output's `validate` rules or an agent node's schema (D48).
4. **Apply at a safe point.** A proposal that passed validation (and the dry run, when set) is applied right away; `agent.edit` is the grant, there is no separate human approval (D51). It can be held instead (`apply: false`, `pipo proposals … propose --hold`): it stays `validated` or `verified` until anyone with control applies it (`apply_proposal`) or rejects it (`reject_proposal`, only from those two states). The control ops are `propose`, `proposals`, `proposal`, `apply_proposal` and `reject_proposal`; REST has `GET/POST /api/pipelines/<name>/proposals`, `GET …/proposals/<id>`, `POST …/proposals/<id>/apply` and `…/reject`; reads work from the journal with no runner. Version *N+1* is activated for newly accepted packets. In-flight packets finish on version *N* (§7.3). The version and the proposal's `applied` state are committed together, so a crash leaves one or the other, never half (D49).
5. **Audit.** Each version records who made it (human or agent id, and which of the two), the reason, the proposal it came from, the diff and the content hashes of the `fn` module and schema files it runs with. `pipo rollback` restores any earlier version's definition; its files are read as they are now, and each one that changed since that version was recorded is a warning (D60).

Every packet records which version processed it, so any result can be traced back to the exact definition that produced it.

**Escalated packets.** A packet handed to the agent (`then: agent`, or a stall with `agent.on_stall: handle`) waits in state `escalated` until it is resolved with `retry` (from the step it stopped at, on its pinned version), `dead_letter` or `drop` (not at the output). The runner control op `resolve` does it today; REST, the CLI and MCP call it (D50). Without an agent the packets simply wait; nothing is dropped.

---

## 10. Toolchain

### 10.1 Editor support (VS Code first)

- The **`.pipo` JSON Schema** is published by `pipo schema`. Connector `with:` blocks use conditional schemas based on `via`, `to`, `tap` and so on.
- The **VS Code extension**:
  - registers `.pipo` as YAML and attaches the schema, which gives completion, hover help and structural checks;
  - adds a TextMate injection that highlights `${…}` templates and expressions;
  - includes a small **Pipo language server** for what a schema can't express: completing node ids in `from`, going to the definition of `fn.*` in the TS module, showing `pipo check` diagnostics live, offering quick-fixes (e.g. "unsupported delivery check: choose from …") and showing a graph preview.

### 10.2 Generators

- `pipo new <name> --template <t>` scaffolds a pipeline folder: the `.pipo` file, an `fn` stub, schemas, fixtures and a test.
- Built-in templates: `webhook-to-sqlite`, `cron-to-file`, `watch-to-http`, `agent-classifier`, `blank`.
- Your own templates live in `./.pipo/templates/` or `~/.pipo/templates/`. A template is a folder plus `template.yaml`, which defines prompts and variables. Files use `{{var}}` placeholders.
- `pipo generate node` inserts a node into an existing file, wires its `from` and keeps the file formatted.

### 10.3 Testing

`pipo test` runs a pipeline in the runner binary (`pipo-runner test`, D73) against fixture packets, with no journal and no live connectors. Outputs and taps are mocked, agent nodes can be stubbed from recorded responses, and results are compared with snapshots. This is the same machinery as the dry-run in §9.3.

- **Fixtures.** `pipo test <file|dir>` reads `<pipeline folder>/fixtures/*.json` (or `--fixtures dir`): a packet's data as JSON, or `{"data": …, "meta": {…}, "stubs": {…}}`. Run-wide stubs (node id → response) go in `fixtures/stubs.json`; a fixture's own `stubs` win per node. A folder argument must hold exactly one `.pipo` file.
- **Snapshots.** Each fixture's result is kept in `fixtures/__snapshots__/<fixture>.snap.json`. A missing snapshot is written and reported as `new`. A different result fails with the changed paths and a hint; `--update-snapshots` accepts it (`updated`). A fixture that cannot run (a missing stub, say) fails whatever its snapshot says.
- **Output.** One line per fixture (`✓`/`✗`, its outcome) and a summary. The exit code is 0 only when every fixture passes. `--json` prints `{pipeline, fixtures: [{name, status: pass|fail|new|updated, outcome, diff?, error?}], passed, failed}`. Check errors, a bad fixture or a missing fixtures folder are errors with a hint, and nothing runs.

The dashboard's test run uses the same machinery with a trace: each unit also lists its `steps`, the data leaving every step (D62). `pipo test` and its snapshots don't include them.

---

## 11. Security

- Secrets are referenced through `op://` (1Password, recommended) or `env:` and never stored in `.pipo` files, the journal, logs or agent responses (§3.7).
- The engine binds to localhost by default. HTTP inputs support token-header or HMAC signature auth.
- Agent access uses scoped tokens, is limited by each pipeline's `agent:` policy and is fully audited.
- `exec` nodes run programs as the user, with no shell and no sandbox (D71). A `.pipo` file with exec nodes that came from a template outside your project is untrusted, like an `fn` module, until you run `pipo trust`, and again after you edit it.
- `fn` modules and connectors are trusted code. `fn` modules run in the runner's embedded QuickJS without Bun or Node APIs (§3.6), with a time limit per call and a memory limit; that keeps them off the system, but it is not a reviewed sandbox. Each pipeline is isolated at the process level. Templates from outside your project are untrusted until you run `pipo trust`, which records a hash of the content. If the content changes, it has to be trusted again. Sandboxing arrives with the Phase 2 template registry.

---

## 12. Roadmap

**Phase 1: MVP**
- The spec v1 format, `pipo check`, `pipo fmt` and `pipo test`.
- The engine, with one runner per pipeline, the journal, detached mode, the scheduler and the gateway.
- Inputs: `http`, `schedule`, `watch`, `push`, `system`. Outputs: `sqlite`, `file`, `http`, `stdout`. Node kinds: `tap`, `transform`, `filter`, `route`, `agent`, and loops.
- Delivery checks and stall detection, plus the DLQ and replay.
- Output batching (`sqlite`, `file`), agent budgets and retention.
- The CLI, generators, the JSON Schema and the VS Code extension.
- The Phase 1 UI dashboard, the MCP agent endpoint and the change protocol.

**Phase 2**
- The visual editor in the UI (built: the builder, §8, D62).
- Agents through local coding-agent CLIs: `claude_code`, `codex`, `pi`, `opencode` (built: §3.4, D67).
- More connectors: `postgres`, `mqtt` (sensors), `s3`, queues.
- Join and window nodes, multiple outputs (`outputs:`), and batch mode for `http`.
- A connector SDK and a template registry.
- **Distributed:** sub-engines on other machines or operating systems, with runners placed remotely and controlled from one engine.
- OpenTelemetry export (`engine.otlp`, D41).
- Pipelines declaring the env vars they need (§14.2, D44).
- A configurable `watch` content limit, and emitting files that already exist on first start (§14.3, D44).
- Sandboxing `fn` modules (§11).
- The editor language server.

---

## 13. Decision log

| # | Topic | Decision | Section |
|---|---|---|---|
| D1 | File syntax | YAML with a published JSON Schema, `.pipo` extension | §3 |
| D2 | Cycles | Graph without cycles. The only cycles allowed are bounded `loop.back_to` edges with a required `max`. | §3.4 |
| D3 | Isolation | One runner process per pipeline, plus a detached mode that survives the engine going down | §7.1, §7.2 |
| D4 | Agent edits | Propose → validate → apply, limited by the pipeline's `agent.edit` policy, versioned and auditable | §9.3 |
| D5 | Batching | `output.batch` only (no batch node). Delivery stays per packet, and failed batches are split until the bad packets are isolated. | §3.5.1 |
| D6 | Outputs | One output per pipeline in v1. A future `outputs:` map won't break existing files. | §3.5 |
| D7 | Expressions | A safe JavaScript expression subset: an existing parser plus Pipo's own evaluator, which allows only listed syntax | §3.2 |
| D8 | Agent cost | A per-day cap for the pipeline (the pipeline pauses when it's reached) plus a per-packet token cap (the packet goes to the dead-letter queue) | §3.11 |
| D9 | Retention | Defaults: data 7 days, trail 30 days, rejected 3 days, dead letters kept until handled. Compaction runs daily. | §3.12 |
| D10 | `fn` isolation | No sandbox in v1. Outside templates need `pipo trust`, which is tied to a content hash. | §3.6, §11 |
| D11 | Expression parser | jsep, behind an internal `parse()` interface with a conformance test suite | §3.2 |
| D12 | Budget window | A calendar day in the engine's time zone, with an optional `reset_at`. A rolling window was rejected because it makes the pipeline flap between paused and running. | §3.11 |
| D13 | Detached ports | Never assigned automatically. Set with `listen` in the file or `pipo start --listen`, checked by the CLI before start, and saved in the runner registry. The engine and the CLI both find and reattach runners through `~/.pipo/run/*.json`. | §7.2 |
| D14 | Schedule catch-up and time | Ticks missed while a runner is down are skipped (a late timer fires once, then moves on to the next future tick). Cron runs in UTC. `every` counts from runner start. `catch_up`, `timezone` and an anchored `every` may come later. | §3.3, §7.4 |
| D15 | File and http output details | `file`: `jsonl` lines and `json`+`append` array entries are `{packet_id, data}`; `csv` takes its header from the first packet's top-level fields (non-objects use a `value` column); `csv`/`text` append use a `<file>.pipo-keys` sidecar for idempotency; `mode: write` replaces the file atomically. `http`: `data` is sent as JSON when `body` is unset, no body for GET/DELETE, 30 s timeout, `success` accepts `204`, `"2xx"`, `"200-299"`. | §3.5 |
| D16 | Tap and transform idempotency | Taps are at-least-once across a crash. `tap: http` and `transform: http` send `Idempotency-Key: <packet_id>:<node>`; `tap: file` skips a repeat of the same packet and node (records carry `packet_id` as `<packet_id>:<node>`); `tap: emit` events commit in the step's own transition, and a failed tap records none. | §3.4 |
| D17 | http input bodies, signatures and `respond: delivered` | `csv`: first line is the header, each record is one packet (values are strings); the reply is `202 {"packets": [...]}`; malformed csv is `400` with `error` and `hint` and nothing is journaled. `bytes`: `data` is `{base64, content_type, size}`. HMAC: the header holds the hex digest of the raw body (an `sha256=` prefix is accepted), `algorithm` defaults to `sha256`, compared in constant time; a bad or missing signature is `401` before any packet is journaled. `respond: delivered`: `timeout` defaults to `30s`; `200` with `{packet_id, state}` when delivered or filtered, `502` with `error` when dead-lettered, `202` with `state: accepted` when the timeout passes first (the packet carries on). | §3.3 |
| D18 | Delivery check fields | `query` takes `sql` (alias `query`) plus optional `params` for bound values; `row_count` takes `query`, `params`, `min` (default 1). Check queries run read-only. `file` checks default `path` to the output path; `checksum` is sha256 of the whole file. `follow_up` uses a 5 s timeout, is false on a non-success status, and throws (retried until `within`) when the URL is unreachable. | §3.10 |
| D19 | Watch restart replay | The watch input keeps its snapshot (path → mtime, size) in the journal. Each path's entry is updated in the transaction that journals its packet (accepted or rejected); unsubscribed events only update the snapshot. On restart, the first scan compares the folder with the saved snapshot and emits each create, change or delete made while the runner was down exactly once (several edits become one `change`; a file created and deleted while down emits nothing). The first start, or a start after the resolved glob changed, records a baseline and emits nothing. Unlike a missed schedule tick (D14), a changed file is data that still exists. Replay waits while `buffer.max` is full. Resolves §14.3. | §3.3, §14.3 |
| D20 | Batch journaling and details | A packet that passes `output.validate` commits a move to the `$batch` cursor (state `writing`, event `output.batched`) before it joins the in-memory batch, so no new state or table is needed. On restart, `$batch` packets join a new batch without validating again, and `within` restarts when the first of them joins. A successful flush commits every packet's move to verification (`output.written` with `{batch: n}`) in one journal transaction; delivery checks then run per packet. A crash between the output write and that commit writes the batch again, and the idempotency key makes it a no-op. Every write (the batch, each half, each single packet) is retried under `on_error`; only a single packet that still fails gets `on_error.then` with its own error (`pause`/`halt` hold it at `$batch`). `within` defaults to `1s`. Stop waits at most 2 s for its flush; an unfinished flush is redone on the next start. Drain also flushes whenever nothing upstream can still join. There is one batch per pipeline version. `sqlite` uses one transaction per database file. `file` uses one append per file (a `csv`/`text` sidecar entry lists every key of the flush); `json` and `mode: write` use one replace, and with `mode: write` the last packet's content wins, as without batching. | §3.5.1, §7.3 |
| D21 | Lifetime limits and `stats` | `stats` counts come from the journal, so they survive restarts, except `uptime`: whole seconds since this run started (resets on restart). `accepted` counts packets that passed input validation (every state but `rejected`); rejected packets do not count toward `max_packets`. `pending` is accepted packets not yet delivered, filtered or dead-lettered (held and batched packets included). Reaching `max_packets` (checked and inserted in the same synchronous step, so concurrent requests cannot overshoot) or a true `until` journals `pipeline.lifetime` with `{reason: max_packets\|until, stats}`, stops intake, then drains or stops per `on_end`. Later packets are refused with `unavailable` (HTTP 503, message names the limit). `until` is evaluated at start, after every accept and every packet end, and once a second (so `stats.uptime` works); a runtime evaluation error is logged once and journaled as `pipeline.lifetime_error`, and the pipeline keeps running. A restart that finds the limit already reached stops again after start. `stats` also carries `in_per_min` (packets accepted in the last 60 s, an indexed range read on `received_at`) and `last_delivery_at` (ISO time of the latest delivered packet, null before the first; indexed on `(state, updated_at)`), which `pipo status` shows as IN/MIN and LAST DELIVERY. The control `status` op adds `stats.stalled` (`{node, since}` of the oldest in-flight unit while a stall is flagged, else null) and `note` (`stalled at '<node>'` or null), shown as `⚠ stalled at '<node>'`; older runners lack these fields and the table shows `-`. | §3.8, §3.2 |
| D22 | Fan-out copies | When a source (`input`, a node or a route branch) has several consumers, the step that produced the packet commits, in one transaction, its own transition (state `branched`, no cursor, event `packet.fanned_out`) and one copy per consumer, so a crash never leaves a partial fan-out; a fan-out at `input` journals the packet and its copies before the ack. Each copy is its own journal unit, pinned to the packet's version, with a branch path of consumer ids (`a`, nested `a/c`; a copy sent straight to the output is `output`) and unit id `<packet_id>:<branch>`. `meta.packet_id` is the same for every copy; `meta.branch` holds the path (empty for an unbranched packet). The default idempotency key is `packet_id`, and `packet_id:<branch>` for a copy: it is the sqlite default key column, the file record's `packet_id` and the http `Idempotency-Key`; tap keys (D16) become `<packet_id>:<branch>:<node>`. Pipelines without fan-out are unchanged. Inside a branch, filters, routes and error policies act on that copy only; a route branch with several consumers fans out again; a loop back to a node upstream of a fan-out repeats it, so each pass makes new copies (the path grows, bounded by `max`; `iteration` carries over); fan-in does not merge copies. Each copy is one batch item. A unit that fanned out settles in the same transaction as its last copy: `dead_lettered` if any copy is (error `branch.dead_lettered` naming the first such branch), else `delivered` if any copy is, else `filtered`; `respond: delivered` answers then. `stats`, `buffer.max` and state counts count packets, not copies: a packet that fanned out is `pending` until it settles. Dead-letter entries are the copies. `pipo check` warns (P026) when copies reach the output and an explicit key or a `delivered.with` lookup by `meta.packet_id` doesn't use `meta.branch`. Resolves §14.1. | §3.4, §3.5, §7.3, §14.1 |
| D23 | Stall detection | The runner checks for a stall every `min(1s, after/4)` (at least 50 ms) while `active`. A stall is `pending > 0` and no packet reached `delivered` or `filtered` for `after`, measured from the latest of: the last such packet, start or resume, and the last check that found nothing pending (so a fresh backlog after a quiet period does not fire at once). It fires once per episode: it journals `pipeline.stall` with `{message, then, stall, stats}` (message rendered with `stats.*`/`stall.*`, redacted, also logged; `stall.oldest` is the oldest in-flight unit, `last_error` is its error or latest retry error, empty when none) and then either flags the pipeline `jammed` (`notify`: state stays `active` and processing continues; `jammed` shows as `status` and as `state` in the registry entry) or pauses it with reason `stall` (`pause`). The next delivery or filter ends a `jammed` episode (event `pipeline.unjammed`); resume also starts a new episode and a fresh clock. Nothing is checked while paused. `then: agent` flags the stall as `notify` does and also journals `pipeline.escalated`; `agent.on_stall: handle` hands the units in flight to the agent (D50). Without `message` a default one is journaled. | §2.2, §3.10 |
| D24 | Control socket, `push` and `external` | Protocol as in §7.2, version 1 (`hello.protocol`); error codes `bad_request`, `unknown_op` (hint lists the ops), `unavailable`, `rejected`, `not_found`, `invalid_state`, `internal`; bad JSON gets an error and the connection stays usable; `drain` and `stop` reply before acting. The socket is bound in `Runner.open` and is the start lock: a socket nothing answers on is removed, a live one or a non-socket file at the path refuses start, and so does a path over the unix limit (107 bytes on Linux, 103 elsewhere) or on a Windows drive under WSL; it is mode 0600 and removed on a clean stop. `push` works for every input (`meta.trigger: push`, `meta.source` from `source`, default `control`); `via: push` only has no listener of its own. A rejected push is journaled as `rejected` and answered with code `rejected` and its `packet_id`; `buffer.max` and `lifetime` answer `unavailable`, and a reached lifetime is named even while the pipeline drains. `external`: the packet stays `verifying` at the output and is parked without holding a worker. Its deadline is the `output.written` time plus `within`, journaled once as `delivery.awaiting_ack`, so a restart keeps the remaining time; after an `on_fail` hold (`pause`, `halt`) the next run of the check opens a new window. `ack` takes the journal unit id (the output key: `packet_id`, or `packet_id:<branch>` for a fan-out copy; acking a packet that fanned out is an error listing its copies) and commits a `packet.acked` event before replying. An ack that arrives before the packet reaches the output is kept and delivers it on arrival, so a fast outside system can't lose the race with the journal. Repeating an ack, or acking a delivered packet, answers `already: true`; acking a dead-lettered or filtered packet, or one whose version does not use `external`, is an error. The deadline keeps running while paused; an acked packet delivers on resume. Drain waits for parked packets, bounded by `drain_timeout`. `events` pages with `limit` 1–1000 and answers `{events, last_seq, more}`. | §3.3, §3.10, §7.2 |
| D25 | Engine config and restart policy | `<home>/config.yaml` has one top-level key, `engine:`, with `ttl` (duration), `detached` (default false), `listen` (gateway port), `env_allow` (list), `start_timeout` (default `30s`, enough for the runner to retry a hung `pipo compile`, D73), `stop_timeout` (default `15s`) and `restart: {backoff: 1s, max_backoff: 30s, stable: 1m, max_restarts: 5, window: 10m}`. A missing file or key takes the default; an unknown key or a bad value stops the engine from starting, with `file:line:col` and a hint. The engine creates `run/engine.json` (`engine_id`, `pid`, `started_at`, `home`, `listen`) exclusively: a live engine on the same home refuses a second one, and an entry whose pid is dead is replaced. It removes the entry on shutdown. Runners it starts carry its `engine_id` in their registry entry. A pipeline that fails `pipo check` is refused before any process starts, and so is one named `engine` (its registry entry would be `run/engine.json`). A runner is up once its registry entry names its pid and its socket answers `hello` for that pipeline. Its stdout and stderr are appended to `logs/<name>.log`, next to the engine's start and exit lines. Exit 0 (asked to stop, lifetime ended, or stopped through its socket) means `stopped`, and exit 2 (`then: halt`) means `failed`; neither restarts. Any other exit, or a signal, is a crash: the runner restarts after `backoff`, doubling up to `max_backoff`, and back to `backoff` after a run of at least `stable`. A crash after `max_restarts` restarts within `window` marks the pipeline `crashed`, with an error that names the last exit and a hint to fix the cause and start it again; its in-flight packets stay in the journal. A runner that doesn't come up within `start_timeout` is killed. `stop` drains, waiting up to `drain_timeout` plus `stop_timeout`; `stop --now` waits up to `stop_timeout`. After that the runner is killed and its journal resumes on the next start. `ttl` drains the pipelines and stops the engine when it expires, and `idle` sets the idle-sleep grace (D31); `listen` (`0` picks a free port) starts the gateway (D28); `detached: true` starts every runner detached (D30). | §7.1, §7.2, §7.5 |
| D26 | Scaffolding details | Template files ending in `.tmpl` drop that suffix when scaffolded (so `pipo check` and `bun test` ignore the template sources). Variables come from `--set key=value` or their `default` (defaults may use `{{name}}`); an undeclared `--set` key or a missing required value is an error; `pipo new` never prompts. `--dir` names the folder to create. Scaffolds carry a `fixtures/` folder that passes `pipo test` out of the box (the agent-classifier one has a `stubs.json`), next to bun tests of the fn stub. `pipo generate node` takes a file, folder or pipeline name, plus `--use <value>` (for example `http`, `fn.x`); it inserts before the output, so `--from X` re-points only the output entries that came from X (a route feeds the output as `<id>.main`), and an agent node gets `schemas/<id>.schema.json` if missing. A pipeline named `engine` is refused, because `run/engine.json` is the engine's own entry (D25). | §6, §10.2, §10.3 |
| D27 | Discovery, reattach and the event stream | The engine claims `run/engine.json` before reading any registry entry, so a second engine never touches the runners. A runner is live when its pid exists, is not a zombie and (on Linux) did not start after the entry's `started_at` (otherwise the pid was reused and the runner is dead), and `hello` on the entry's socket names the same pipeline, pid and version. A live runner is adopted: it is supervised like a child, but its exit is found by polling its pid every 500 ms. An entry that still names that pid means it died uncleanly (a clean stop removes the entry; a last journal event `pipeline.failed` means it halted), and it gets the D25 restart policy. A live pid whose handshake fails is never killed: the pipeline is `unreachable` (control is refused, and shutdown leaves it running) with a hint to run `pipo attach`, and it is checked again once its pid dies. A dead runner's entry means it never stopped cleanly, whatever its state (`active`, `jammed`, `paused`, `draining`). The engine restarts it from the file in the entry's `file` field, reusing the entry's `listen`, and counts that as restart 1 under D25. There is no resume-from-journal entry point: the file's folder is needed anyway for `fn` modules and schemas. The journal resumes in-flight packets on their pinned versions, and a changed file becomes a new version for new packets only. The restarted runner is drained again if it was `draining`. A pause needs nothing from the engine: the runner takes it over from its journal, with its reason, before any packet moves (D32; amended). The new runner replaces the entry, so an engine that dies half-way leaves the evidence for the next one. The entry, plus a socket nothing answers on, is removed without a restart when the file is gone or fails `pipo check`, or when this engine had already marked the pipeline `crashed` or `failed`; the pipeline is then `failed`, with a hint. Amendment, stopped stays stopped: whenever a pipeline settles to `stopped` and its entry still names a dead runner (a stop during a restart backoff, or a stop that had to kill its runner after `stop_timeout`), the engine removes that entry and its socket at once. Discovery also removes a dead entry without a restart when this engine marked the pipeline `stopped` after that runner started, or when the journal's last `pipeline.stopped` (the pipeline is then `stopped`) or `pipeline.failed` (then `failed`: it halted) is at or after the entry's `started_at`, meaning the runner ended before it could remove its entry. An end journaled before `started_at` belongs to an earlier run and doesn't count. Events: the engine polls each supervised runner's `events` op (every 500 ms, pages of 500, at most 10 pages a poll) into one in-memory stream. After a runner exits, the engine reads the events it wrote after the last poll from its journal. The cursor (the last seq streamed) is kept per pipeline in `<home>/engine/cursors/<name>.json` and written atomically after each batch is emitted, so a restarted engine replays exactly the events after it. Events between the last save and an engine crash may be seen twice, so consumers dedupe on (pipeline, seq). A pipeline the engine never streamed starts from seq 0, and so does a journal whose last seq is below the cursor (it was reset). | §7.2, §7.6 |
| D28 | Gateway | With `engine.listen` set, the engine serves one HTTP server on `127.0.0.1` only. It binds right after claiming `run/engine.json` and writes the bound port there (`listen`; `0` picks a free one); a taken port stops the engine before it touches any runner. Until discovery is done, `/api` (except `GET /api/engine`) and `/in` answer `503` with `Retry-After`. **`/in/<pipeline><path>`** is forwarded unchanged (method, path, query, raw body, headers except hop-by-hop, plus `X-Forwarded-For/Host/Proto`) to `127.0.0.1:<listen>` from the runner's registry entry, which serves the same route (§6), and the runner's reply (status, headers, body, `respond` replies included) comes back as is. With the gateway on, an http input with no port in the file or the start options is started on a free loopback port (`--listen 0`); with it off, such a pipeline is refused at start. Nothing is retried: an unknown pipeline or one without an http input is `404`, a pipeline that isn't `running` is `503` (with `Retry-After` while starting or in backoff), a refused connection is `503`, and a failure after the request was sent is `502` with a hint that the packet may have been accepted (at-least-once, §7.3). **`/api`** (JSON): `GET /api/engine`; `GET /api/pipelines`; `POST /api/pipelines {file, listen?, detached?}` (absolute path; `listen` 1–65535 and `detached` as in D30); `GET /api/pipelines/<name>` (adds the runner's `status` reply as `runner`); `POST /api/pipelines/<name>/start {listen?, detached?}`, `/stop {now?}`, `/drain`, `/restart {listen?, detached?, ttl?}` (D68), `/pause {reason?: manual\|agent}`, `/resume`, `/push {data, source?}`, `/ack {packet_id}`; `POST /api/attach {name?}`; `GET /api/events?pipeline=&after=&limit=` (1–1000, default 100). Errors are `{error, hint, code}`: `400` bad request, `404` not found, `409` invalid state or conflict (a taken port included, D30), `415` not JSON, `422` invalid pipeline (with `diagnostics`) or rejected push (with `packet_id`), `503` unavailable. `/api` and `/events` answer only requests whose `Host` is a loopback name, and every API `POST` must be `Content-Type: application/json`, so a web page can't drive the engine (DNS rebinding, cross-site posts); `/in` has no such limit (inputs have their own auth). **`/events`** (SSE): each journal event as JSON `data:` with `id: <pipeline>:<seq>`, pipeline state changes as `event: state` (no id), a comment every 15 s; `?pipeline=` filters. Replay after `Last-Event-ID` (or `?after=`): with `?pipeline=`, exactly the journal's events after that seq (at most 10 000, then `event: gap` with a hint), then live without repeats; without it, from the last 1000 events this engine streamed, or `event: gap` with a hint when the id is older or the engine restarted. `/api/events` reads the same way (`410` for an id no longer among the recent events). A client more than 16 MiB behind is dropped and replays on reconnect. Shutdown closes the gateway last, after the pipelines stopped and their last events were sent. `/mcp` is the agent endpoint (§9.2, D53). | §6, §7.1, §7.2, §7.6 |
| D29 | `fmt` and `trust` details | `pipo fmt` keeps comments and puts keys in the order of the spec examples (top level, input, node, output; `with:` blocks keep your order). It indents 2 spaces and writes flow collections unpadded (`[a]`, `{a: 1}`). It keeps block scalars (`>`, `\|`) as written, re-indented, and never re-wraps other lines. It puts blank lines around block sections and keeps the ones you wrote between scalar keys. It refuses a file that fails YAML parse. `--check` changes nothing and exits 1 listing the files that would change. Templates from `~/.pipo/templates` or a path outside the project are untrusted; built-in, `./.pipo/templates` and in-project paths are trusted. `pipo new` writes `.pipo-origin.json` (template hash plus fn module hashes) for untrusted templates. `pipo trust <template>` records the template's content hash in `<home>/trust.json`. `check` reports P052 when the template hash is untrusted or the module differs from the recorded hash; `pipo trust <project-folder>` re-accepts an edited module. Files without a marker are your own code. | §3.6, §5, §11 |
| D30 | Detached runners, `listen` and long `respond: delivered` waits | A detached runner (`detached: true` in a start request, or `engine.detached`) is spawned with `--detached` in its own session (`setsid`), so no signal sent to the engine's process group or terminal reaches it, and its output goes to `logs/<name>.log`, never a pipe. Its registry entry says `detached: true`. Engine shutdown (SIGINT/SIGTERM) stops the other runners as before, but leaves detached ones running: a launch under way finishes, a pending restart is cancelled (the stale entry stays for the next engine), and the engine stops following the process. The supervisor's `shutdown({stopDetached: true})` stops them too, and `pipo stop <name>` stops one. Any runner survives an engine SIGKILL (nothing ties a runner to the engine's life), and the next engine adopts both kinds (D27). An adopted or restarted runner keeps its entry's `detached` and `listen`. Lifetime (`ttl`, `max_packets`, `until`; D21), stall detection (D23) and schedules always run in the runner, attached or not, and their outcomes are journaled (`pipeline.lifetime`, `pipeline.stall`, `pipeline.paused`, `pipeline.stopped`). The engine never arms them itself, so a reattach can't fire them twice: it learns what happened from the replayed events. A pipeline `ttl` is anchored across crash restarts (D42). `listen` in a start request overrides `input.with.listen` (refused for an input other than http), is passed to the runner as `--listen`, written to the registry by the runner, and reused by crash restarts and reattaches. `listen` and `detached` also stick for later starts of the same pipeline by the same engine, until they are given again. Before starting, the engine checks the port (the one given, else a literal `input.with.listen`) on 127.0.0.1. The start is refused (`conflict`, HTTP 409) when another live pipeline holds the port (from this engine or the registry), when it is the gateway's, or when the port can't be bound. The message names the pipeline and runner pid, or the pid and command line of the listening process (from /proc on Linux), or says "another process (not identified)", and the hint says to stop it or pass another `--listen`. The check is advisory: if something takes the port before the runner binds it, the runner's own bind error stops it. An http input's request headers must arrive within 10 s, and a keep-alive connection is closed after 10 s without a new request, but nothing cuts off a request whose answer is pending, so a `respond: delivered` wait is bounded only by its `timeout`. | §3.3, §7.2, §7.4 |
| D31 | Engine lifetime, `pipod` flags and start on demand | The engine is busy while a pipeline it supervises is `starting`, `running` (any runner status: `active`, `paused`, `draining`, `jammed`, so pending packets always have a runner), in restart backoff or `stopping`, or `unreachable` (a live runner it can't see into), or while a scan (`pipo attach`, discovery) runs. Detached runners it supervises count the same. `stopped`, `failed` and `crashed` pipelines have no runner, so they don't keep it up: their leftover packets stay in the journal and resume on their next start. Once discovery is done, the engine sleeps after `engine.idle` (a new config key, a duration of at least `1s`, default `5m`) without being busy: it shuts down as on SIGTERM (detached runners left running) and exits 0, removing `run/engine.json`. Every `/api` and `/events` request restarts the idle clock (so the CLI's start on demand, a `pipo status --watch` or a UI keep it up), `/in` traffic does not, and an open SSE stream does not either. There is no grace before the first pipeline: an engine started for `pipo status` with nothing to run sleeps after `engine.idle`. `engine.ttl` counts from engine start (`ttl_expires_at` in `GET /api/engine`); on expiry the engine drains every pipeline except detached ones, which keep running on their own lifetime as at shutdown (D30), and exits 0. When the engine ends itself (idle or TTL), it removes the registry entries of pipelines it marked `crashed` (as a rescan would, D27), so the next engine, started by any `pipo` command, doesn't restart them. `GET /api/engine` also says `stopping`, and `ready` is false while the engine shuts down. `pipod --listen <port>` (0 picks a free one) and `--ttl <duration>` override `engine.listen` and `engine.ttl`; a bad value exits 2 with the usage, and `--help` exits 0. The CLI starts the engine on demand with `--listen 0` unless `engine.listen` is set in config.yaml, and never writes config.yaml. It waits up to 20 s for an engine that is still reattaching, waits out one that is shutting down, then starts a new one; an engine that exits during startup is reported with the end of `logs/engine.log`, and one running without a gateway is reported as such (`engine: down`). | §7.1, §7.5 |
| D32 | A pause outlives a crash | A runner derives its pause from its journal when it starts, before any worker runs: the last `pipeline.paused` with no later `pipeline.resumed`, `pipeline.stopped` or `pipeline.failed` means it starts `paused` with that event's reason (and the rest of its detail, such as a budget's reset time), whatever started it: the engine's crash restart, a new engine's discovery restart, or `pipo run`. A clean stop or a halt ends a pause; a crash, or a stop that had to kill the runner, does not. Recovered packets are queued, but none moves until resume, not even while the input is still starting; intake accepts into the journal as for any pause (§2.2), up to `buffer.max`. The runner journals `pipeline.paused` with `{reason, restored: true}` after `pipeline.started`, and its registry entry says `paused` from its first write. A `then: pause` hold of a recovered packet while the input starts pauses it the same way. The engine no longer pauses a restarted runner itself (D27). Resume wakes every worker, so a backlog is processed at full `concurrency`. A packet waiting for an `external` ack in a run that restarted paused is checked against its journaled deadline on resume, and acks sent during the pause count. | §2.2, §7.2, §7.3 |
| D33 | Packet reads, DLQ replay and purge | Runner control ops (§7.2) `packets` (`state`, `limit` 1–1000, default 50, `after`: newest first, `next` names the next page; branch copies are not listed), `packet` (one packet's trace), `dlq`, `replay` and `purge` (`ids`, at most 1000, or `all: true`; optional `by`), served by the engine as `GET /api/pipelines/<name>/packets[/<id>]`, `GET …/dlq`, `POST …/dlq/replay` and `POST …/dlq/purge`. Every transition's patch is stored on its event (`events.patch`, added to older journals on open), so the trace shows the data after each step, when it ran, how long it took, its attempts and errors; older events trace by event type, without data. **Replay** puts each failed unit back in flight at the step it failed on, with the data it had there, on its pinned version, `attempt` 0 (a `loop.max` failure also resets `iteration`); an output or delivery-check failure resumes at the output, which writes again (idempotent on its key) and checks again. For a fan-out only the dead-lettered copies are replayed, and their dead-lettered ancestors go back to `branched` so they settle again. One transaction commits every patch with a `dlq.replayed` event (the old error in its detail) before the units are queued, so a crash resumes them. A list of ids is all or nothing; an id not in the DLQ is `invalid_state` (`not_found` if unknown), so a repeat never runs a packet twice; a copy id is refused (the DLQ holds whole packets). `all` takes a snapshot and commits 200 packets per transaction. Replay needs the pipeline `active` or `paused`. **Purge** deletes the packet, its copies and their events, and records one `dlq.purged` event (version, error, `received_at`, `by`); nothing else is touched. | §3.9, §6, §8 |
| D34 | Reads without a runner | When no runner of the pipeline is running (stopped, crashed, or the engine does not supervise it), the engine and `pipo --no-engine` answer `packets`, `packet` and `dlq` from `<home>/pipelines/<name>/journal.db` opened read-only, marked `source: journal`. Errors and events were redacted by the runner when written. Payloads are redacted with the secrets every stored version declares, resolved from `env:` only (a read never prompts `op`); when any can't be resolved, packet data and results are replaced by `[withheld: …]` and `withheld` says why. Writes (`push`, `ack`, `replay`, `purge`) need the runner and say to start it. The runner binary answers these reads too (`pipo-runner read --home DIR --pipeline NAME --op OP [--args JSON]`, D73): it prints `{result, withheld}` (`null` when the pipeline has no journal), or `{error: {code, message, hint}}` with exit code 1; the secrets come from each version's stored compiled form. | §6, §7.2 |
| D35 | Runners, attach and engine commands | `pipo runners` reads `<home>/run/*.json` and asks each runner's socket for `hello` (the same pipeline and pid, D27); it never starts the engine. State: `stale` (pid gone), `unreachable` (alive, no valid handshake), `attached` (the engine supervises that pid, asked through `GET /api/pipelines`), else `detached` (running on its own, including whenever the engine is down; the table then ends with `engine: down`). `pipo attach [name]` starts the engine on demand and calls `POST /api/attach`; it prints one line per runner (adopted, restarted, removed, supervised, unreachable, failed, each with its hint) and exits 1 when one failed. `pipo engine start [--ttl 8h] [--listen p]` starts `pipod` detached as on-demand start does (`--listen 0` unless `engine.listen` is set) and says `already running` for a live engine, whose lifetime and port it doesn't change. `pipo engine stop` sends SIGTERM to the pid in `run/engine.json` and waits for the entry to go (graceful shutdown: pipelines drain, detached runners keep running, D30). `pipo engine status` reads `GET /api/engine` (`pid`, `listen`, `started_at`, `ttl_expires_at`, plus `pipelines` and `idle`, true when no pipeline keeps the engine up, D31) and prints `engine: down` when none runs; all three exit 0 without an engine except where start fails, and take `--json`. A pipeline `listen` of 0 is refused by the CLI and the gateway alike (`bad listen 0`, hint `use a port from 1 to 65535`). The gateway names unknown body keys of `POST /api/pipelines` and `/start` (400 `bad_request`) and refuses `ttl` there (hint: set ttl in the pipeline's lifetime block); the CLI passes that error through, because a per-start `ttl` is not built yet. Under `--json` a failed command prints `{ok: false, error, hint, code}` on stdout with the same exit code (`code` is the engine's, else `error` or the Node error code). | §6, §7.2, §7.5 |
| D36 | Agent node runtime | A provider implements `complete({model, prompt, schema, max_tokens, signal}) → {output, input_tokens, output_tokens}`. `claude_api` (called `claude` before D66) calls the Anthropic Messages API over `fetch` (no SDK) with one forced tool call whose `input_schema` is the node's schema (a non-object schema is wrapped as `{value}`); a non-2xx answer, or no complete tool call (`stop_reason: max_tokens`), is an error, and the latter still reports its tokens. The node renders `with` (prompt, model, timeout, max_tokens), aborts the call after `timeout` (default `60s`; `max_tokens` default `4096`, clamped to what the packet has left of `per_packet`), and checks the output against `with.schema` with ajv (`$schema` ignored, so draft-07 and 2020-12 files load; `pipo check` reports a file that isn't JSON or a valid schema as P054). A mismatch, timeout or provider error is a node error under `on_error`; tokens of every attempt count. **Settings:** the engine config's top-level `agents:` map, `agents.<provider>: {pricing, api_key, base_url}`. `pricing` maps a model id, or a part of one (`opus`, `sonnet`, `haiku` are built in at 5/25, 3/15 and 1/5 USD per million input/output tokens), to `{input, output}` USD per Mtok; an exact id wins, else the longest key the id contains. A literal model with no price refuses the start (an unpriced call would make the cap meaningless). `api_key` is a secret reference (`op://…` or `env:…`, default `env:ANTHROPIC_API_KEY`), never a literal; it is resolved at start only when no provider is injected, and redacted like any secret. Runners read `agents:` and `engine.timezone` from `<home>/config.yaml` themselves (the engine already passes `--home`), so `pipo run` and engine-started runners agree; problems there refuse a start of a pipeline with agent nodes. **Journal:** the moment a provider reports usage, one transaction writes an `agent.usage` event on the unit (provider, model, tokens, `cost_usd`, attempt; shown in the packet trace) and an `agent_spend` row keyed by that event's seq, before the output is checked or the step's transition commits, so a paid call is never forgotten; a crash before that row means the call is made again on restart (and counted again). A DLQ purge deletes events but not `agent_spend`, so it never gives money back. The control `status` op reports `stats.agent_spend_today` (USD in the current budget day) and `budget_resumes_at`. | §3.4, §3.11, §7.1 |
| D37 | Budget windows and restore | A budget day is a calendar day in `engine.timezone` (an IANA name; default the system's zone) starting at `reset_at` (default `00:00`); spend is the sum of `agent_spend` rows since the day started, timed by the runner's clock. **Per packet:** tokens (input + output) of every unit of the packet (branch copies, loop passes) since its latest `dlq.replayed`, so a replayed packet gets a fresh budget. Before each call, a packet at or over `per_packet` is dead-lettered with `budget.packet` (whatever `on_error.then` says, never retried); a call that takes it over is recorded, then dead-letters it the same way. **Per day:** checked before each call, so up to `concurrency` calls already under way can go past the cap. At or over `per_day` the packet is held at its node (`packet.held`, error `budget.day`) and the pipeline pauses with `pipeline.paused {reason: budget, resume_at, window_start, spent_usd, per_day, message}`. A timer resumes it at `resume_at` (`pipeline.resumed {reason: budget_window}`). A restored budget pause (D32) re-arms that timer from the journaled `resume_at`, and resumes at once if it passed while no runner was up. Any other resume (`pipo resume`, the API) goes over the cap until the day ends, journaled as `pipeline.resumed {budget_override, until}` and read back on start; the CLI does not ask for confirmation yet. **`warn_at`:** once per day, the first recorded call that brings spend to `warn_at` of `per_day` journals a pipeline-level `budget.warning` (spent, cap, day start, `resets_at`) and logs it. **Engine-wide cap:** `engine.agent_budget.per_day` is enforced across the pipelines of a home (D58). | §3.11, §2.2, §7.3 |
| D38 | Versions, rollback and restarts | Versions are a timeline in the journal's `versions` table (`version`, `hash` of the source, `source`, `author`, `reason`, `created_at`); an earlier source used again is a new version, so journals from before D38 are migrated on open (the `hash` uniqueness is dropped and `reason` added, in one transaction). **Restart:** a start runs the `.pipo` file only when its content changed since the last start (its hash is kept in the journal's `meta` table); otherwise the latest version stays, so a rollback outlives `pipo restart`, a crash restart and a reattach. A changed file whose content equals the latest version adds nothing; a journal from before D38 has no recorded hash, so the file wins as before. The start records its version (author `human`, reason `first start` or `file changed`) and the file hash in one transaction after it holds the control socket (the start lock), so a refused second start writes nothing. A latest version that no longer passes `pipo check` refuses the start, with a hint to edit the file. **Apply and rollback:** the runner ops `apply` (`source`, `reason`, `by`) and `rollback` (`version`, `by`; reason `rollback to v<n>`) check the definition like a start (`invalid_pipeline` with the diagnostics, nothing written), store it as a new version with a pipeline-level `version.applied` event (`version`, `previous`, `author`, `reason`, `hash`) in one transaction, then switch new packets to it before anything else runs; packets already accepted finish on their pinned version (§7.3), and the registry entry and `hello` name the new version. The same content as the running version changes nothing (`changed: false`). Refused while starting (`unavailable`, try again), and (`invalid_state`) while draining or stopped, while another apply runs, and when the change touches what the runner binds at start: `name`, `input` other than `schema`/`validate`/`on_invalid`, `output.to`, `secrets`, `concurrency`, `lifetime`, `delivered.stall`, or an agent provider or unpriced model it did not set up; the hint says to put the definition in the file and restart. A version stores the `.pipo` text and the content hashes of its `fn` module and schema files (D60); the files themselves are read from the folder as they are now, with a warning when they differ from what the version recorded. **Reads:** `versions` (newest first, with `pending` packets pinned to each, `current`: the running version, or null from the journal, and `latest`), `version` (with its `definition`) and `diff` (unified, 3 lines of context, `identical`, `added`, `removed`) are answered by the runner or, with no runner, from the journal read-only (D34). Engine API: `GET /api/pipelines/<name>/versions[/<v>]`, `GET …/diff?from=&to=`, `POST …/rollback {version, by?}` (other keys are a `400`; a stopped pipeline is a `409` that says to start it). Versions are given as `3` or `v3`. The CLI's rollback author is `cli`, the API's `api`. | §2.2, §6, §7.2, §7.3, §9.3 |
| D39 | Retention clean-up | The runner applies `retention` (§3.12 defaults when absent) at start and every 10 minutes, in bounded batches: `data`/`result` are cleared for delivered and filtered packets after `data`, for rejected ones after `rejected`; settled packets and their events are deleted after `trail`; dead letters only when `dlq` is a duration. Fan-out parents wait for their copies; in-flight packets, `versions` and pipeline-level events are never touched. Compaction (WAL checkpoint + `VACUUM`) runs at most once per 24 h, tracked in a `retention_state` table; a busy database retries on the next tick. |
| D40 | UI serving and graph route | The engine serves the dashboard (`packages/ui`, static files, no build step) at `/ui`; unknown extension-less `/ui/*` paths fall back to `index.html`. It adds a read-only `GET /api/pipelines/<name>/graph` (nodes, edges and per-node in/ok/failed counters from the journal) for the live graph. `pipo ui` needs a running engine and prints the URL; opening a browser is best effort. |
| D41 | Observability and MCP scope (human, 2026-10-04) | Phase 1 builds per-node latency and the age of the oldest pending packet (runner `stats`, `/api`, `pipo status`) and the MCP endpoint `/mcp`. OTLP export (`engine.otlp`) moves to Phase 2. Resolves §14.6. | §7.6, §9.2, §12 |
| D42 | Detached runners own their timers (human, 2026-10-04) | D30 stays: runners own TTL, stall and schedule timers, attached or detached, and the engine learns outcomes from replayed journal events. A pipeline's TTL is anchored to the first `pipeline.started` since the last clean `pipeline.stopped` or `pipeline.completed`, so a crash restart arms only the time left (and ends at once if it is over). §7.4 and §7.5 reworded. Resolves §14.5. | §7.4, §7.5 |
| D43 | D14–D40 accepted (human, 2026-10-04) | D14–D40 are confirmed as written. The "harness, pending review" markers are removed. | §13 |
| D44 | `meta.key` and deferred questions (human, 2026-10-04) | Expressions get `meta.key`: the packet's output key, `packet_id:<branch>` for a fan-out copy (D22). Built in D55. §14.2 (env var declarations) and §14.3 (watch limit, first-start emit) move to Phase 2. Resolves §14.4. | §3.2, §12, §14 |
| D45 | Change proposals: format, policy and store (harness, pending review) | A proposal is the whole proposed `.pipo` source against version *N*, with `author`, `author_kind` (`agent` or `human`) and a `reason`. Changed paths come from a structural diff of the parsed documents: maps key by key, a list or a scalar as one path, so key order, formatting and comments are no change. An `agent.edit` pattern is dotted, `*` is exactly one segment, and a pattern covers its subtree (`nodes.normalize` covers `nodes.normalize.with.x`). An agent's proposal needs `agent.control: true` and a non-empty `agent.edit` in version *N* (the policy in force, never the proposed one); changes under `output`, `delivered`, `secrets` and `agent` are refused even when listed. A human's proposal (CLI, API) is held only to `pipo check` and what a live apply allows, like the `apply` op (D38). Every proposal is also refused when *N* isn't the latest version (`stale_base`), when it fails `pipo check` (with the diagnostics), when it changes what the runner binds at start (D38), when it uses a feature the runner refuses, or when it equals *N*; all problems are reported at once, each with `message` and `hint`. Bad input (a missing field, an unknown *N*) stores nothing; otherwise the proposal is stored, `validated` or `rejected`, with its unified diff from *N*, in the journal's `proposals` table, with a pipeline-level `proposal.<state>` event in the same transaction. States: `validated` → `verified` (the dry run, when version *N* sets `agent.verify` for an agent's proposal) → `applied`; `validated` or `verified` → `rejected`. `applied` is committed in the same transaction as version *N+1*, which must directly follow *N*. Reasons, diagnostics and events are redacted; the source is stored as written (secret references, not values). Sources are capped at 1 MiB and reasons at 2000 characters. `approve: human` is not in the schema or this spec; D51 settles it: there is no such key. | §9.3, §7.3 |
| D46 | A deliberate stop settles a crashed or killed pipeline (harness, pending review) | Whatever the state it stops from (running, `backoff`, `crashed`, or a stop that had to SIGKILL its runner after `stop_timeout`), `stop` (and `drain`, and shutdown for the runners it stops) settles the pipeline to `stopped`; `stop` on a `crashed` pipeline used to change nothing. When its runner did not journal its own end, the engine does, once no live runner holds the journal (its registry entry names none): one transaction appends `pipeline.stopped` with `{reason: killed\|crashed, by: <engine_id>}`, only when the last run has no end yet, so it is idempotent. That resets the ttl anchor as a clean stop does (§7.4). A pause in force is journaled again after it (same detail) in the same transaction, because a kill or a crash does not end a pause (D32). Only then are the dead runner's entry and socket removed (D27): an engine that dies in between leaves an entry whose run ended at or after its `started_at`, which discovery removes without a restart. Engine shutdown leaves `crashed` pipelines as they are (D31). | §7.2, §7.4 |
| D47 | Agents can't change `agent_budget` (harness, pending review) | `agent_budget` joins `output`, `delivered`, `secrets` and `agent` as a top-level key an agent's proposal may never change, even when `agent.edit` lists it or `*` covers it (`forbidden_path`). The cap limits what agents cost, so an agent raising it would defeat it; a human changes it in the pipeline file. Resolves §14.7. | §9.3, §3.11 |
| D48 | Dry-run semantics (harness, pending review) | `agent.verify: last N` (*N* from 1 to 1000, P055) is stored on an agent's proposal from version *N*'s policy, and `verified` is required before apply. The dry run takes the newest *N* delivered packets (by delivery time, any version; not copies), each from its original input (the `packet.accepted` trail entry); one whose payload retention cleared (D39) is skipped, counted, and not counted in *N*; fewer than *N* replays what there is, and none passes. Each replays in memory through the proposed version, with `meta.version` *N+1* and its own `packet_id`, fan-out copies (`packet_id:<branch>`) and loops as the runner runs them: filters, routes, `map` and `fn` transforms run (`fn` modules as they are now, D38; 30 s per call); taps (`fn` ones too) and the output are mocked: their `with:` is rendered but nothing is called, sent or written; agent nodes and `transform: http` return what that unit's node returned when it was delivered (pass by pass), checked again against the proposed agent schema; the delivery check is not run; secrets render as `***`; retries are not waited for. A packet **diverges** when the proposed input schema or `validate` rejects it, a step fails (whatever its `then`, except a tap with `then: continue`, which is reported as a warning), a replayed agent output fails its schema, a node with no recorded result for that unit (a new agent node, a new path) would have to be called (`unverifiable`), or it fails `output.validate` or `output.with` can't be rendered. Different values, added or removed fields, and packets the proposed version filters are not divergence; they are reported. Any divergence rejects the proposal; otherwise it is `verified`. Nothing is written to the journal (no throwaway journal is needed) until one transaction stores the state, the report (counts, then per packet: id, version, outcome, would-be output keys, mocked taps, replayed results, up to 5 reasons of 500 characters; no payloads) and a `proposal.verified|rejected` event with the summary and counts, all redacted; a crash before that leaves the proposal `validated` and rerunnable. `propose` and `apply_proposal` run it through one path: applying a `validated` proposal that still needs it (`pipo proposals <name> apply <id>`) runs it first, so a dry run cut short by a crash, a stop or an error is rerun by applying again. A proposal whose base is no longer the latest version, or whose version can't be prepared (a schema file or `fn` module that won't load), is rejected without a report. One dry run per proposal at a time. | §9.3, §10.3 |
| D49 | Applying a proposal (harness, pending review) | The runner op `apply_proposal` (`id`, `by`) applies a proposal through the live apply of D38 (same `pipo check`, bound-change, runner-gap and agent-provider checks, same safe point). It is refused (`invalid_state`, with a hint) when the proposal is `applied` (the message names its version) or `rejected`, when its base set `agent.verify` and it isn't `verified` yet, when the runner is not active or paused, or while another apply runs; an agent's proposal is checked again against the `agent.edit` policy of the version in force. When its base is no longer the latest version it is refused and marked `rejected` (`stale base: …`) in the same step, since a base never becomes current again. Any other refusal (a `pipo check` that fails now because an `fn` module or schema changed) writes nothing and leaves the proposal as it was. One transaction stores version *N+1* (author, `author_kind` and reason from the proposal, plus its `proposal` id), its `version.applied` event (with `author_kind` and `proposal`), the proposal's `applied` state with `applied_version` *N+1* and its `proposal.applied` event; the runner then switches new packets to *N+1* with nothing awaited in between, so no packet is accepted on *N+1* before it is committed. The reply is the apply's (`version`, `previous`, `changed`, `pending_older`) plus `proposal`. A SIGKILL before the commit leaves *N* and the proposal applicable; after it, *N+1* and the proposal applied, which the next start runs (the file did not change, D38). **Audit:** the `versions` table gains `author_kind` (`human` for a start from the file, the proposal's for a proposal; null for the `apply` and `rollback` ops, whose `by` names a channel, and for older versions) and `proposal`, both added on open in one transaction; `versions` and `version` return them, and `version` adds `diff`, the unified diff from the version before it (null for v1). A rollback after a proposal is an ordinary new version; the proposal stays `applied` with its own version. Test-only: `PIPO_TEST_CRASH_AT` makes a runner SIGKILL itself at a named point around the apply transaction. | §7.2, §7.3, §9.3 |
| D50 | Packets handed to the agent (harness, pending review) | **Escalation.** `then: agent` in any error-policy position (node `on_error`, the `errors` default, `loop.then`, `output.on_error`, `output.on_invalid`, `delivered.on_fail`) acts once the policy's retries run out: one transaction sets the unit (a packet or a fan-out copy) to state `escalated`, keeps its data and version, records the error, and sets the cursor to where a retry resumes (the node; the output for an output, batch or delivery-check failure, which writes again, idempotently, and checks again), with a `packet.escalated` event `{reason: error, error}`. Nothing runs an escalated unit, in this run or after a restart, until it is resolved; a SIGKILL before that commit runs the step again (at least once, §7.3). An `http` input with `respond: delivered` answers 202 with the state at once. At `input.on_invalid` the packet was never accepted, so it is journaled `rejected` as always, with a `packet.escalated` event `{reason: rejected, waiting: false}` in the same transaction; the agent can push corrected data. **Counting.** Escalated units are pending: in `stats.pending`, in `buffer.max` (so with no agent the input fills up and then answers 503; nothing is dropped) and in a version's pending count; `stats.escalated` counts the packets with an escalated unit. They are not moving, so they don't make a stall (D23 counts only units in flight) and drain does not wait for them. **Stalls.** `delivered.stall.then: agent` flags the stall as `notify` does (`jammed`, processing continues) and journals `pipeline.escalated` `{reason: stall, message, then, handle, stall}`. `agent.on_stall: handle` (whatever `then` says) hands every unit in flight when the stall fires to the agent: queued, held and ack-parked units at once (500 per transaction), a unit a worker or an output batch holds at its next safe point: before its next step or attempt, or when its current attempt fails (its retries end early, its policy is not applied, except the per-packet token cap, which still dead-letters). A unit that moves on first is no longer stalled. A stall's escalation has error code `stall` (the step's own error for a unit whose attempt failed) and event reason `stall`; `pipeline.escalated` adds `units: {escalated, marked}`. The marks are in memory: after a crash those units run again, and a stall that persists hands them over again. `on_stall` does nothing without `delivered.stall`. **Resolve.** Runner control op `resolve` (`ids` of units, up to 1000, or `packet_id`; `action`: `retry`, `dead_letter` or `drop`; optional `by`, `by_kind` `agent`/`human`, `reason`; REST `POST …/resolve` defaults `by_kind` to `human`): every id is checked first and one transaction commits all of them, each with a `packet.resolved` event `{action, by, by_kind, reason, error}`, so a list is all or nothing. `retry` puts the unit back in flight at its cursor (on its pinned version, `attempt` 0; a `loop.max` failure also resets `iteration`) and queues it after the commit, so a crash after the commit resumes it; it does not reset the per-packet token budget, so retries can't spend past the cap. `dead_letter` (into the DLQ, where replay resumes it like any failure, D33) and `drop` (`filtered`; refused at the output, as `then: drop` is) end it, and a copy settles its packet in the same transaction (D22). Refused (`invalid_state`) unless the pipeline is active or paused, when a unit is not `escalated` (for a packet that fanned out, the hint lists its waiting copies), or when `by_kind` is `agent` and `agent.control` is off in the version in force. `agent.actions` does not gate it: `then: agent` and `on_stall: handle` are the grant, for those units only. The op `packets` with `state: escalated` lists units, copies included. `pipo check` requires `agent.control` for `delivered.stall.then: agent` and `agent.on_stall: handle` too (P034). REST (`POST /api/pipelines/<name>/resolve`) and the CLI (`pipo resolve`) exist (D51); MCP has the `resolve` tool (D53). Test-only crash points `escalate.prepared` and `resolve.committed` (D49). | §2.1, §3.9, §3.10, §9 |
| D51 | Proposals over control ops, REST and CLI (harness, pending review) | There is no `approve: human` key (no schema change): an agent's proposal that passes validation, and the dry run when version *N* sets `agent.verify`, is applied right away at the safe point, since `agent.edit` is the grant. A proposal may be held instead (`apply: false`, CLI `--hold`): it is stored `validated` or `verified` and stops, to be applied (`apply_proposal`) or rejected (new op `reject_proposal`, `reason` required, only from `validated` or `verified`) by anyone with control. Humans' proposals follow the same flow (default apply). The runner op `propose` (`source`, `base_version`, `reason`, `author`, `author_kind` default `human`, `apply`) validates, dry-runs when required, then applies, and returns the proposal; bad input is `bad_request`, a proposal stored `rejected` is a normal result (state and problems), and a stored proposal whose apply was refused comes back with `apply_error`. `proposals` (`state`, `limit`) and `proposal` (`id`) read, also from the journal with no runner (an older journal has none). REST: `GET/POST /api/pipelines/<name>/proposals`, `GET …/proposals/<id>`, `POST …/proposals/<id>/apply` and `…/reject`, and `POST …/resolve` (D50), with `by`/`by_kind` (default `api`, `human`); writes need the runner. CLI: `pipo proposals` and `pipo resolve` (§6). Closes D45's open sentence on `approve: human`. `apply_proposal` on a `validated` proposal that needs the dry run runs it first (D48) instead of refusing as D49 had it, applies when it passes, and when it diverges replies with the proposal, now `rejected`, not an error. Over the control ops and REST, `author_kind` and `by_kind` are what the caller declares (those channels are local and unauthenticated); only `/mcp` fixes them: its proposals, rollbacks and resolves are always `agent`, with the token's name (D53, R-35). |
| D52 | `pipo test` harness (harness, pending review) | `pipo test` runs each fixture in memory on the §9.3 dry run's replay core. Filters, routes, loops, fan-out copies, `map` and `fn` transforms run. Taps (`fn` too) and the output are mocked: their `with:` is rendered and recorded, nothing is called, sent or written, and no delivery check or batching runs. Agent nodes and `transform: http` return stubs. Error policies apply as in the runner: retries count attempts but never wait, filters and routes are not retried. `then` maps to `dead_lettered`, `filtered` (drop), `escalated`, `paused` or `halted`, and a tap's `continue` is a warning. Secrets are never resolved and render as `***`; `env` is empty. **Fixtures:** every `*.json` in `fixtures/` (not subfolders), sorted by name, except `expected.json`, `stubs.json` and `*.snap.json`. An object with a `data` key and only `data`/`meta`/`stubs` keys is structured; anything else is the packet data. `meta` may set only `trigger` (default `input.via`), `source` (default `test`) and `received_at`. **Stubs:** node id → response, run-wide and per fixture (the fixture wins per node). A single value answers every call. A list answers one call each, in order, retries and loop passes included (wrap an array response). `{"$error": "msg"}` makes that call fail. An agent response is checked against its schema as a node error. A missing stub, a list that runs out, or a stub for an unstubbable node fails the fixture with a hint. **Results** are deterministic: `packet_id` is the fixture name, `meta.version` is 1, and `meta.received_at`, `now()` and `iso()` read a fixed clock (2026-01-01T00:00:00Z unless set). Each fixture reports its outcome (`rejected`, or across its units the first of failed, halted, paused, escalated, dead_lettered, delivered, filtered). It also reports units in creation order: id, branch, outcome, path (routes as `<id>.<branch>`), copies, final data, the write (idempotency key, rendered `output.with`, and the sqlite row), the error (step, code, rendered policy message, rule, attempts, then, hint) and warnings. Then the mocked tap calls and the stubbed calls with their rendered `with:`. A pipeline with check errors or a refused gap is not tested. **Command:** run-wide stubs are read from `fixtures/stubs.json`. Snapshots are `fixtures/__snapshots__/<fixture>.snap.json`, one per fixture, holding its result. A missing one is written on the first run and reported `new`. A mismatch fails with the changed paths, and `--update-snapshots` accepts it. A `failed` fixture fails whatever its snapshot says. Exit 0 only when all pass. | §10.3, §9.3 |
| D53 | MCP endpoint: transport, tokens and scopes (harness, pending review) | **Transport.** Streamable HTTP without sessions: each POST carries one JSON-RPC message (batches are refused) and gets `application/json`; notifications and responses get `202`; GET and DELETE are `405` (the server sends no requests or notifications, so there is no stream). Revisions 2025-11-25 and 2025-06-18: `initialize` answers the client's revision when it is one of them, else the newest; an unsupported `MCP-Protocol-Version` header is `400`. Methods: `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`. Hand-rolled in `packages/engine/src/mcp.ts`, no runtime dependency; `@modelcontextprotocol/sdk` (MIT) is a dev dependency of `@pipo/engine`, used only by the test's client. The same loopback Host check as `/api`, a non-loopback `Origin` is `403` (DNS rebinding), and bodies over 4 MiB are `413`. **Tokens** (`engine.mcp.tokens`): `name` (letters, digits, `.`, `_`, `-`, up to 64, unique), `token` (only `op://…` or `env:VAR`; a literal is a config error whose message never repeats it), `scope` (`read` by default, `operate`, `edit`; each includes the one before) and optional `pipelines` (allowlist). Each is resolved once when the engine starts (a change needs an engine restart), within 30 s; one that does not resolve, or is shorter than 16 characters, is logged and left out, never fatal to the engine. A bearer token is compared as a SHA-256 digest with `timingSafeEqual` against every configured token. **Tools** call the gateway's REST handlers in-process, so statuses, hints and the journal fallbacks are those of `/api`; a REST error becomes a tool result with `isError: true` and `{error, hint, code}` as text; an unknown tool or method is a JSON-RPC error, an unknown resource `-32002`. Arguments are checked against each tool's `inputSchema` (unknown keys refused, `null` is absent). Results are JSON text. `resolve` (D50) is a fifteenth tool. **Policy**, in order: the scope (`forbidden`, with a hint), the allowlist (outside it: `not_found`, as for an unknown name), then the version in force (the journal's latest version, or the file before a first start): `agent.control: true` for every pipeline tool and resource, since it "enables the endpoint for this pipeline" (§9.3; `list_pipelines` lists every allowed pipeline with `agent_control`), and the action in `agent.actions` for `pause` (journaled with reason `agent`), `resume`, `replay`, `push` and `ack` (no `actions`: none). `propose_change`, `rollback`, `resolve` and `replay` pass the token's name as `by`, and `author_kind`/`by_kind` `agent`; the runner checks `agent.edit` (D45) and `agent.control` (D50). `rollback` is in the `edit` scope and is a proposal of version *v*'s source against the version in force, so `agent.edit`, the forbidden paths (D47) and `agent.verify` apply and the audit names the agent (the `rollback` op would record neither). **Redaction**, per result: the pipeline's `agent.redact` paths (dotted, `*` is one segment, a leading `data.` is optional, a segment that meets a list applies to each element) are masked as `[redacted]` in every payload (any `data` or `result` key, at any depth); every value so masked (strings and numbers of 4 or more characters), and those at the same paths in the journal's stored data and step patches of every packet the result names (`packet_id`), are then masked wherever else they appear in it (log lines, errors, event details; a payload retention already cleared can't be found); then `Secrets.redact` with the pipeline's secrets that resolve from `env:` in the engine (no `op` prompt per request; the runner already redacted its answers with all of them) and the MCP token values. | §9.2, §7.1, §11 |
| D54 | Built-in latency and oldest-pending metrics (harness, pending review) | **Window:** per node, the latest 100 completed steps (count-based, not time-based, so a quiet pipeline still shows its recent latency), p50 and p95 by nearest rank, plus max and count. **Measure:** the runner times each node and output step from its start (after the version's plan is ready) to its completing transition. The duration is stored as `ms` on that transition's event, in the same transaction, so a sample commits exactly once with the step (§7.3) and a SIGKILL mid-step leaves none. Batched writes record their group's write time. Delivery checks, escalated and held steps record none. **Journal:** additive migration: column `events.ms` (null on older events) and the partial index `events_node_ms ON events(node, seq) WHERE ms IS NOT NULL`, so each node's window is one short indexed read. **Oldest pending:** `MIN(received_at)` of packets (not copies) in a pending state, escalated ones included. **Where:** the control `status` op adds `latency`, `latency_window`, `oldest_pending_age_ms` and `oldest_pending_received_at` to `stats` (not to the `stats` expression context). The gateway passes them through unchanged. `pipo status <name>` shows them under the table. | §7.6 |
| D55 | `meta.key` runtime (harness, pending review) | `meta.key` is computed by one function, shared by the write and the expression. It is the unit id, or the explicit key from sqlite `columns[key]` or an http `Idempotency-Key` header. It is the explicit key only at the output and delivery-check steps (earlier nodes see the unit id, since transforms can still change the data). Inside the output's own `with:`, `meta.key` is the unit id, so a key expression cannot read its own result. The dry run and `pipo test` expose it the same way. | §3.2, D22, D44 |
| D56 | (unused) | Number skipped during the Phase 1 run; no decision. | — |
| D57 | `pipo start --ttl` (harness, pending review) | `pipo start --ttl <duration>` and `pipo restart --ttl`, and `ttl` in the body of `POST /api/pipelines` and `/start`, replace `lifetime.ttl` for that start. The value must be a positive duration; a bad one is `400 bad_request`, and the CLI checks it before `restart` stops anything. `on_end` and `drain_timeout` still come from the file, and a file without a `lifetime` block drains. The engine passes it to the runner as `--ttl`. The runner arms it from the anchor of §7.4, like the file's ttl, records it on `pipeline.started` (`detail.ttl`), and writes it to its registry entry as `ttl`. The engine shows it as `ttl` in `/api/pipelines[/<name>]`, or null when the file's applies. **Survival:** the override is part of the start options. A crash restart reuses it. A reattaching engine takes it from the registry entry, for a runner it adopts (and may restart later) and for one that died while no engine ran. A detached runner enforces it on its own (D30). A crash does not reset the anchor, so a crash restart gets only the time that is left. **Scope:** unlike `listen` and `detached`, it does not stick. A later start without `--ttl` uses the file's `ttl` again, and so does `pipo run`. `pipo restart` stops the pipeline first whenever it isn't already `stopped` or `failed` (a `crashed` one too, D46). That stop is journaled, so the restart gets a new anchor, with or without `--ttl`. The journal stores the override only on the event, not as state. A start reads it from its own options, never from the journal. This replaces the `ttl` refusal of D35. | §3.8, §6, §7.2, §7.4 |
| D58 | Engine-wide agent budget (harness, pending review) | **Store:** none of its own. The home's spend is the sum of the `agent_spend` rows (D36) of every `<home>/pipelines/*/journal.db`, the runner's own through its connection and the others opened read-only (with the R-32 busy retry) at each check. Each row is committed in the transaction that journals the call, so a crash can't lose a recorded call from the total or count it twice, and detached runners and `pipo run` need no engine. A journal deleted from the home no longer counts; a journal that can't be read fails the call as a node error (never read as $0). **Settings:** runners read `engine.agent_budget` from `<home>/config.yaml` at start, like `agents:` and `engine.timezone` (D36), with the engine's validation; a bad value refuses the start of a pipeline with agent nodes. A changed cap applies from the next start. **Day:** a calendar day in `engine.timezone`, from midnight (pipelines' `reset_at` doesn't apply), timed by the runners' clocks. **Check:** before each call, after the pipeline's own `per_day` (which wins when both are reached). At or over the cap, the packet is held and the pipeline pauses as in D37, `pipeline.paused {reason: budget, cap: engine, resume_at (the next engine midnight), window_start, spent_usd (home total), per_day (engine cap), pipeline_spent_usd, message}`, with a message that names the cap and the `config.yaml` to raise it in. A pipeline-cap pause now carries `cap: pipeline`. **Overshoot:** check-before-call, not reserve-then-settle: calls already under way in any runner of the home when the total reaches the cap still complete, so the home can go over by at most the calls in flight at that moment (the sum of each running pipeline's `concurrency`, each call bounded by its `max_tokens` and prompt), as D37 bounds one pipeline. **Override:** `pipo resume` of a budget pause overrides only the cap that paused it, for this pipeline, until that cap's day ends: `pipeline.resumed {budget_override, until}` (pipeline cap) or `{engine_budget_override, until}` (engine cap). On start, each is read from the latest `pipeline.resumed` that carries it. **Reporting:** `GET /api/agent-budget` and `pipo status` (`agent_budget` in `--json`, a line under the table) show `per_day` (or null), `spent_usd`, `window_start`, `resets_at`, `timezone` and the spend per pipeline in the engine day, reading the cap from `config.yaml` as a runner starting now would. With the engine down, the CLI sums the journals itself. | §3.11, §7.2, §7.6 |
| D59 | Dashboard reads: lifetime, logs, agent activity (harness, pending review) | `GET /api/pipelines` items and `GET /api/pipelines/<name>` carry `lifetime: {ttl, ends_at, remaining_ms}`: the ttl in force (the start's `--ttl`, else the file's `lifetime.ttl`; null without one) counted from the journal's lifetime anchor exactly as the runner counts it (§3.8, D57); `ends_at` and `remaining_ms` are null unless the pipeline is `running`. `GET /api/pipelines/<name>/logs?tail=&after=` reads `logs/<name>.log`: without `after`, the last `tail` lines (1–1000, default 200); with `after` (a byte offset), only whole lines written since, plus `next` (the offset to ask for next) and `reset` (true when `after` is past the end of the file, so `lines` is a fresh tail); at most 256 KiB per call. `GET /api/pipelines/<name>/activity?limit=` (1–500, default 50) lists the newest `packet.escalated`, `packet.resolved` and `version.applied` journal events, newest first, read-only from the journal. Proposals come from the existing `…/proposals`. The UI follows the log by polling `after` every 2 s and counts the lifetime down client-side. | §7.5, §8 |
| D60 | Versions remember their files; structured apply diagnostics (harness, pending review) | **Record.** Each version row stores `files`: the sha256 of each file its definition refers to (the `fn` module, `input.schema` and agent nodes' literal `with.schema`, the references `pipo check` resolves), keyed by the path as written, as JSON, in the same insert (so the same transaction) as the version; a start that appends a version records them in `commitStart`'s transaction. They are the files the version was compiled with (D73): each version stores its compiled `fn` bundle and schemas, so an edited module takes effect when a start, `apply` or `rollback` compiles it into a version. Files are hashed, not copied: restoring old code is version control's job. Only directly referenced files are hashed, not modules the `fn` module imports. Journals from before D60 gain the column on open, null for their versions, which never warn; read-only reads return `files: null` for them. `versions` and `version` return `files`. **Warn, never refuse.** A mismatch is a warning `{code, file, version, recorded, current, message, hint}`: `file_changed` when a version's recorded file differs from the one it runs with now, `module_not_reloaded` when an `apply` or `rollback` that changes nothing (`changed: false`) finds the `fn` module on disk different from what the running version was compiled with (its hint says to restart, which compiles the file as it is now). A rollback to v*n* compares v*n*'s record with the new version's (what it was compiled with now). Their replies carry `warnings` (only when there are any; `pipo rollback` prints them), and the runner logs each one. A start compares the record of the version it runs, and of each version with recovered packets, with the files they run with, and logs each mismatch (`warn`); it repeats on every start until a new version records the new files (a changed `.pipo` file, an apply or a rollback). **Diagnostics.** A live apply (`apply`, `rollback`, `apply_proposal`) that fails `pipo check` keeps its `invalid_pipeline` message, which lists the errors, and adds `diagnostics`: all of the check's diagnostics (errors and warnings) in the shape `pipo check --json` uses (`code`, `severity`, `message`, `hint`, `line`, `col`, `path`, `file`). The engine API passes them in its `422` body, as it does for a start that fails its check. | §7.2, §7.3, §9.3, D38 |
| D61 | `pipo ui` boots the engine; open dashboards keep it awake | `pipo ui` starts the engine on demand, like every other command that needs it, and fails with the reason and the engine log's path only when it can't. `--json` prints `{url, started, pid, workspace}`. Every connected `/events` stream holds the engine awake (§7.5); when the last one closes the idle clock starts again, so a closed dashboard tab lets it sleep after `engine.idle`. `engine.ttl` is not affected. The engine has a **workspace**, the folder where the dashboard builder saves new pipelines (§8): `pipod --workspace <dir>`, else the engine's working directory (for an engine `pipo` starts on demand, the folder the command ran in). `pipo ui --workspace <dir>` passes it when it starts the engine and warns when a running engine has another one. `GET /api/engine` reports it as `workspace`. | §6, §7.5, §8 |
| D62 | Dashboard builder API | `/api/builder/*` (§8) serves the builder: the catalog from the connector manifests, the workspace's `.pipo` files, opening one with its fixtures, a live check, saving and a test run. **What may be read and written.** Only files ending in `.pipo`, given as absolute paths, that are inside the workspace (D61) once symlinks are resolved (the nearest existing folder's real path, so `..` and a symlinked folder can't lead out), or exactly the file of a pipeline the engine knows (`GET /api/pipelines`), wherever it is. Anything else is `403 forbidden` with the workspace in the hint. A relative path or another extension is `400`. Saving creates missing folders only inside the workspace, refuses an existing file unless `overwrite: true` (`409 conflict`), writes atomically (temp file and rename) and caps the source at 1 MiB (`413`), as proposals do (D45). It saves drafts with errors and returns the diagnostics. **Source from a value (`toSource`, in `@pipo/spec`).** Without a base, the value is written in `pipo fmt`'s canonical order (top-level keys, node keys, input and output keys), with a blank line around blocks and lists of up to 6 short scalars in flow style (`[a, b]`). With a base (the text the value was loaded from), the value is applied onto the base's YAML document: maps are merged key by key (removed keys go, new keys land at their canonical place among the known ones, else at the end), lists item by item, and a changed scalar is replaced but keeps its comments and quoting. What didn't change keeps its comments, layout and block scalars exactly, and flow collections are padded like most of the base's. A value equal to the base's returns the base unchanged; a base that doesn't parse is ignored. **Trace.** The replay core gets a `stepped` hook (each successful step and the data leaving it: a route as `<id>.<branch>`, every loop pass, a filter that passed, a tap, a tap failure that `then: continue` passed on, and `output` once written). `testPipeline({trace: true})` records it as `steps` on each unit: the root starts with `{step: "input", data}`, and a fan-out copy starts with its parent's steps, including the one that fanned out. Without `trace` the report is unchanged, so `pipo test` snapshots don't move. The builder's test run uses the real clock (`now()`), not `pipo test`'s fixed one. | §8, §10.3 |
| D63 | Dashboard look and modules | The dashboard is a set of static ES modules, still with no build step (D40): `dom.js` (DOM helpers, toasts, the API client), `look.js` (Pipo the mascot, emoji for states, node kinds and connectors), `layout.js` (the layered auto-layout shared by the live graph and the builder), `model.js` (pure edits of a parsed `.pipo` value, unit-tested), `app.js` (the dashboard) and `builder.js`. No script may parse HTML from strings (a test checks every file). The look is a soft pastel palette (lilac, mint, peach) with rounded cards, emoji labels and a small mascot. It has light and dark themes and respects reduced motion. Data from the engine is rendered as text. | §8 |
| D64 | Outdated engines | The engine loads its code once but serves the dashboard's files fresh, and an open dashboard keeps it awake (D61), so after an update the page can be newer than the engine behind it. At start the engine stamps its sources (path, size and modification time of every `.ts`/`.js`/`.json` file under the engine, runner and spec `src/` folders it runs from), and `GET /api/engine` reports `code_changed: true` once the files on disk differ (re-checked at most every 5 s). The dashboard checks it on every view and every 30 s; when it is true, or missing (an engine from before this decision), it shows a dismissible banner that says to run `pipo engine stop`, then `pipo ui`. `pipo ui` prints the same warning on stderr and reports `engine_outdated` with `--json`. The engine never restarts itself: stopping drains its pipelines, which is the user's call. Runners are separate processes and pick up new code when they start. | §6, §8 |
| D65 | Restarting the engine from the dashboard | `POST /api/engine/restart` (JSON, loopback only, like all of `/api`) answers `202 {restarting, from, pid, listen, pipelines}` and hands over: the engine spawns `pipod --after <its pid>` with the same home, workspace and gateway port, plus the files of the pipelines running here that aren't detached; then it ends as on idle sleep (drains them, releases engine.json, exits). The new pipod waits up to 15 minutes for the old pid to exit before it claims the home, so port and home are free, reattaches detached runners as any start does (D27), and starts the handed-over files again; with `--after` it stays up even if none of them start. Its output goes to `<home>/logs/engine.log`. Per-start options of the handed-over pipelines (`--listen`, `--ttl` overrides, D57) are not carried over, a paused pipeline starts again active, and an engine TTL from `--ttl` is not carried over (`engine.ttl` in config.yaml applies again). A restart while the engine is starting or shutting down is `409`. The dashboard offers it from the outdated-engine banner (D64) after a confirmation, shows a restarting screen while the old engine drains, and reloads the page once an engine with another pid is ready. Engines from before D64 have no such route; the banner tells their users to restart from a terminal. | §8 |
| D66 | `claude` is now `claude_api` | The Anthropic API provider is named `claude_api` (`agent: claude_api`, `agents.claude_api` in config.yaml), so it reads apart from the local Claude Code CLI (D67). Pipo is unreleased, so there is no alias: `agent: claude` fails `pipo check` with P030 and a hint naming the new value. | §3.4, D36 |
| D67 | CLI agents | **Providers.** `claude_code`, `codex`, `pi` and `opencode` run a coding-agent CLI on the runner's machine as the user, with the user's own login (`AGENTS[...].runs: "cli"`; `claude_api` is `runs: "api"`). **A call.** The node's `with` is rendered as for any agent; the runner resolves `cwd` against the pipeline file's folder (a missing folder is a node error), and hands the provider the prompt, the loaded schema (a non-object schema asked for as `{value}` and unwrapped), the model (empty: the CLI's default), `cwd` and `allow_tools`. The provider makes a temp folder per call and runs the CLI in its own process group, with the prompt on **stdin from a file** and stdout and stderr **to files**, read after the process exits (no pipe to drain; the runner already avoids waiting on pipes, see CLAUDE.md). The node's `timeout` kills the whole group (SIGTERM, then SIGKILL after 2 s). The folder is removed afterwards. Without `cwd`, the CLI runs in an empty `work/` folder inside it. **Per CLI.** Claude Code: `claude -p --output-format json --json-schema <schema> --no-session-persistence --safe-mode` (none of the user's hooks, plugins, MCP servers or CLAUDE.md), `--tools ""` (or `--permission-mode bypassPermissions` with `allow_tools`), `--model`; the answer is `structured_output` of the `result` object, its usage (cache tokens count as input) and `total_cost_usd`. Codex: `codex exec --skip-git-repo-check --ephemeral --json --output-schema <file> --output-last-message <file> --sandbox read-only` (`workspace-write` with `allow_tools`) `[--model] -`; the answer is the last-message file, tokens from `turn.completed`, an error from `turn.failed` or `error` (the API's own message unwrapped). pi: `pi -p --mode json --no-session --no-context-files --no-extensions --no-skills --no-prompt-templates --no-themes --no-tools` (tools on with `allow_tools`); opencode: `opencode run --format json` with every tool denied through `OPENCODE_PERMISSION` (or `--auto` with `allow_tools`). Neither enforces a schema, so the prompt ends with an instruction to answer with only JSON matching the schema, and the JSON is taken from the last assistant text (the whole text, a fenced block, or the outermost braces); usage and cost are summed over the run's messages or steps. Whatever the CLI answers is then checked against the schema by the runner, as for every agent. **Cost.** A reported USD cost wins; else tokens are priced from `agents.<provider>.pricing` when a key matches; else the call counts $0. An unpriced model doesn't refuse the start (unlike `claude_api`), and P053 isn't raised for CLI agents: they run on the user's subscription, where a USD cap may not mean much. **Ready or not.** At start, a runner checks each CLI agent it uses: installed (`<command> --version`), then logged in (`claude auth status --json` → `loggedIn`; `codex login status`) or set up (pi and opencode list at least one model: `pi --list-models`, `opencode models`). A CLI that isn't ready refuses the start with what's wrong and the command that fixes it (install, `claude auth login`, `codex login`, …). `agents.<provider>.command` in config.yaml points at another executable; CLI providers take only `pricing` and `command` there. **Models.** Codex lists its catalog (`codex debug models`, entries with `visibility: list`), pi and opencode list theirs, and Claude Code has no list command, so Pipo offers the Claude aliases and model ids. | §3.4, §3.11, §7.1 |
| D68 | Task manager | `GET /api/pipelines` items and `GET /api/pipelines/<name>` carry `resources: {cpu, rss, procs}` for a pipeline with a runner pid, else null: the runner's whole process tree (CLI agents run as its children, D67), from one `ps -A -o pid,ppid,pcpu,rss` per request, so it works on Linux and macOS. `cpu` is percent of one core summed over the tree (it can pass 100), `rss` is resident bytes, `procs` the number of processes. `ps` reports a decaying average on macOS and the lifetime average on Linux. `POST /api/pipelines/<name>/restart {listen?, detached?, ttl?}` does what `pipo restart` does: a stop (unless the pipeline is already `stopped` or `failed`), then a start with the given options. The dashboard's task manager (`#/top`) lists them with each pipeline's controls; stop, drain and restart ask for a confirmation first. | §8 |
| D69 | Telegram bots | **Store.** `<home>/bots.json`, `{telegram: {default, bots: {<name>: {token, allow?, poll_every?, api?}}}}`, written atomically with mode 0600 by the dashboard or by hand. A token may be the raw token: Pipo is a personal tool and bot tokens are cheap to revoke, so the dashboard takes what @BotFather gives. A reference (`op://…`, `env:…`) is resolved at start like a secret. `api` points at another Bot API server (a local one, or a test double). **API.** `GET /api/bots` lists bots without tokens: a raw token shows only its bot id (the public part before `:`), a reference as written. `POST /api/bots/telegram/<name> {token?, allow?, poll_every?, api?, default?, rename?}` adds or changes one (keys left out keep their value; a new bot needs `token`; the first bot becomes the default). `POST …/<name>/delete` removes one (the default moves to the next bot). `POST …/<name>/test` calls `getMe` and answers `{ok, id, username, name}` or `{ok: false, error}`. **Runtime.** Only bots a pipeline names (or the default) are loaded, at start; `with.bot` is a literal so this is known up front. Input polling is long polling (`timeout` = `poll_every`), so the setting caps idle requests without delaying messages. The offset lives in the input state (scope `telegram:<bot id>`), written in the packet's transaction; an ignored or non-message update advances it on its own. Sends are at-least-once: Telegram has no idempotency key. **Later.** WhatsApp (Cloud API) fits the same store as a `whatsapp` map, but its input needs a public webhook. | §3.13, §8 |
| D70 | Data shapes in the builder | **Where they come from.** The input's `schema` file (an example generated from it), else its manifest's `sample` (`INPUTS[...].sample`, passed by `GET /api/builder/catalog`), else, for `schedule`, `with.payload`. **Carried through.** Taps, filters and routes pass `data` on unchanged; `map` renders its `with.data` template against the example (a whole `${data.a.b}` keeps its type; any other expression is unknown); an agent node gives an example of its schema file; `fn` and `http` transforms give unknown. A block fed by several gets the first known shape. **Only a hint.** The examples are never checked against the pipeline: `pipo check` doesn't warn on a field that isn't in the shape (a possible later step). | §3.3, §8 |
| D71 | Exec nodes | `tap: exec` and `transform: exec` run a program on the runner's machine. **No shell.** `args` is a list handed to the program as it is; a `command` with spaces gets warning P058 rather than being split, so the split is never guessed. **How it runs.** Like a CLI agent (D67, the same `runCli`): its own process group, stdin from a file, stdout and stderr to files read after the exit (no pipe to drain), the whole group SIGTERMed on `timeout` and SIGKILLed 2 s later. `cwd` defaults to the pipeline file's folder, not an empty temp folder as for CLI agents: the user writes the command, and relative paths like `./cover.jpg` should mean what they look like. `env` is added to the runner's environment. **Results.** `info` keeps the last 64 KB of stdout and stderr; `text` and `json` refuse more than 1 MB of stdout, with a hint to write a file listed in `outputs`. Text returned is redacted like everything else (§3.7). **Start.** A literal `command` that isn't on `PATH` (or, with a slash, isn't a file next to the pipeline) refuses the start with an install hint; a templated one fails per call instead. **Trust.** `pipo new` from a template outside the project records the `.pipo` file in `.pipo-origin.json` when it has exec nodes, and `pipo check` reports P052 on each exec node while the template is untrusted or the file has changed since; `pipo trust <project>` re-accepts it. **At least once.** A crash between the run and the step's commit runs the program again; outputs named after the packet make that an overwrite. Not done: the program is not stopped when the runner is SIGKILLed (its process group outlives it, as for CLI agents). | §3.4, §5, §11 |
| D72 | Choosing the workspace in the dashboard | `GET /api/settings` answers `{workspace, workspace_from, home}`; `workspace_from` is `settings` (chosen in the dashboard since this engine started), `flag` (`--workspace`), `config` (`engine.workspace`) or `default` (the engine's working directory), which is also the order that wins. `POST /api/settings/workspace {path, create?}` takes an absolute path (`~` is expanded), makes a missing folder only with `create: true` (else `400` with that hint), refuses a file, switches the builder at once and writes `engine.workspace` into `config.yaml` with the file's other keys and comments kept (a config the engine couldn't parse is never written). A restart (D65) keeps it, since it hands `--workspace` on. `GET /api/folders?path=` lists one folder's sub-folders for the picker, `{path, parent, folders}` (default: the user's home folder; dot folders and `node_modules` left out, at most 500). Pipelines already saved stay where they are; the builder's file list shows the new folder's. | §7.1, §8 |
| D73 | The runner is a Rust binary | **Why.** There is one runner per pipeline, so its idle cost adds up: the Bun runner idled at about 105 MB resident and 24 threads, `pipo-runner` (`crates/pipo-runner`) at about 9 MB and 2 threads. Throughput and a Bun-free deploy were not goals. Pipo had no users, so the switch was made without a compatibility path. **TypeScript checks, Rust executes.** `pipo compile <file.pipo> [--home DIR] [--stdin]` (TS, the CLI) is the only checker. It prints one JSON document, `{diagnostics, pipeline, fn: {path, hash, code, exports}, schemas, files, agents, agent_manifests}`, and exits 1 on errors (64 on bad usage). `diagnostics` are `pipo check --json`'s; the rest is filled only without errors: `load()`'s value, the `fn` module bundled by `Bun.build` (browser target, ESM) into one self-contained module, the parsed schema files, D60's file hashes, the home's agent settings from `config.yaml` (so the runner never parses YAML) with their problems, which refuse the start, and `@pipo/spec`'s agent manifests. The runner runs `$PIPO_COMPILE` (a JSON argv; the engine, `pipo run` and `pipo test` set it to their own Bun and CLI), else `pipo compile`: at start, on `apply`/`rollback` and when it validates a proposal. A compile that doesn't answer within 8 s is killed and run again, up to 3 tries, because Bun under WSL sometimes hangs while loading modules. **Versions keep their compiled form** in `versions.compiled` (the only addition to the journal schema), so a packet pinned to an older version runs that version's code and schemas without reading files or compiling again (§7.3). Before, `fn` modules and schema files were re-read from disk. **Execution.** The runner is single-threaded: a tokio current-thread runtime, with the `fn` module's QuickJS runtime on a second thread (§3.6: an event loop with timers, 4 calls in flight by default, 30 s of wall time per call, 256 MB for the runtime; P059 refuses Bun and Node APIs). Expressions are evaluated by a Rust port of `@pipo/spec`'s subset; both run the shared cases in `packages/spec/test/fixtures/expr-cases.json`. The known differences: `matches()` uses Rust's `regex` crate (§3.2); parsing stops at about 128 levels of redundant parentheses (the TS parser stops at depth 32 for everything else); indexing a string inside a surrogate pair gives U+FFFD. Schemas are checked at run time with the `jsonschema` crate, so its messages (`/category "urgent!" is not one of "outage", "billing" or 2 other candidates`) differ from ajv's, which `pipo check` still uses. Budget days use the system's time zone database (`/usr/share/zoneinfo`; no zone data in the binary), so a runner with agent nodes refuses to start when `engine.timezone` isn't in it (install `tzdata`, or use `UTC`). **One place for pipeline semantics.** `pipo test` (`pipo-runner test`, JSON on stdin), the proposal dry run (§9.3) and reads without a runner (`pipo-runner read`, D34) run in the binary. **Unchanged.** The journal schema (plus `versions.compiled`), the control protocol and its ops, the registry entry, the runner's arguments (`pipo-runner <file.pipo> [--listen N] [--home DIR] [--env-allow A,B] [--engine-id ID] [--detached] [--ttl D]`), its exit codes (0 stopped, 2 halted, 1 failed to start, 64 usage) and its log lines. The engine and CLI find the binary through `runnerBinary()`: `$PIPO_RUNNER_BIN`, else the workspace's `target/release/pipo-runner` (`cargo build --release -p pipo-runner`). **Kept as they were.** `meta.iteration` counts per packet, not per loop (§3.4). | §3.2, §3.4, §3.6, §7.1, §7.3, §10.3, D34 |

## 14. Open questions

1. **Fan-out and idempotency.** Resolved by D22: each branch copy is its own journal unit with the key `packet_id:<branch>`, and `pipo check` warns (P026) when an explicit key can't tell copies apart.
2. **Runner-level env allowlist.** Expressions see `env` only for variables in `engine.env_allow`. Until the engine exists, `pipo run --env-allow A,B` sets it. Should a pipeline also be able to declare the variables it needs? Deferred to Phase 2 (D44).
3. **Watch and system input details.** `watch` finds events by comparing folder snapshots (fs.watch only triggers a scan; a 1 s poll covers drives where fs events are lost), so bursts of writes collapse into one `change`. The snapshot is kept in the journal and updated in the same transaction as each packet, so changes made while the runner was down are emitted exactly once on the next start (D19). The first start, or a changed glob, takes the files already there as a baseline. `data` is `{event, path, name, size, mtime, content?}`; `meta.source` is `<path>#<event>@<mtime ms>`. `read: content` reads UTF-8 text up to 1 MiB; larger files are sent with `content: null, truncated: true`. `events` defaults to `[create, change]`. `system` data is `{<metric>: {...} | null, sampled_at}`; unavailable metrics (battery on servers, WSL) are `null`, and `cpu.percent` is a delta between samples. Should the size limit be configurable, and should a first start be able to emit the files already there? Deferred to Phase 2 (D44).
4. **Matching the output key in delivery checks.** With fan-out, the default output key is `packet_id` for unbranched packets and `packet_id:<branch>` for copies (D22), so a `delivered.with` lookup by `meta.packet_id` misses copies. Resolved by D44: yes, expressions get `meta.key`, holding the resolved output key (§3.2). Built in D55.
5. **Who owns the clock for detached runners.** Resolved by D42: D30 stands. Runners own these timers and the engine learns outcomes from replayed events (§7.4, §7.5).
6. **Observability scope in Phase 1.** Resolved by D41: per-node latency, oldest-pending age and MCP `/mcp` are built in Phase 1. OTLP export moves to Phase 2.
7. **Can an agent change its own `agent_budget`?** `agent.edit: ["*"]` covered it, so an agent could raise the cap that limits its own spending. Resolved by D47: no, `agent_budget` is human-only like `output`, `delivered`, `secrets` and `agent`.
8. **Can an agent fix a waiting packet's data?** `resolve` retries an escalated packet with the data it had (D50), so a packet that fails on its data (`output.on_invalid`, a schema) fails again, and the agent can only dead-letter it or push a corrected copy. Should `retry` take replacement data? It would let an agent change data the pipeline never produced, and `agent.redact` hides parts of what it would edit.
