# Nodes and the graph

Nodes are the steps between a pipeline's inputs and its output. `nodes` is a map from node id to node. Each node says where its packets come from (`from`) and what it does to them (its **kind**). The graph is the set of `from` links. You declare each connection once, at the receiving end.

```yaml
pipo: 1
name: signups
input:
  via: push
nodes:
  adults:
    from: input
    filter: data.age >= 18
  tidy:
    from: adults
    transform: map
    with:
      data: { name: "${trim(data.name)}", email: "${lower(data.email)}" }
  announce:
    from: tidy
    tap: log
    with: { message: "new signup: ${data.name}" }
output:
  from: announce
  to: file
  with: { path: ./out/signups.jsonl, format: jsonl }
```

```text
push → adults (filter) → tidy (map) → announce (log) → file
```

## A node's keys

| Key | Required | Meaning |
|---|:-:|---|
| `from` | yes | Where packets come from: an input, a node id, a route branch (`triage.urgent`), or a list of these. |
| *kind* | yes, exactly one | `tap`, `transform`, `filter`, `route` or `agent`. |
| `with` | | The connector's settings, checked against its schema. Values are [templates](expressions.md). |
| `on_error` | | The error policy for this node, overriding the pipeline's `errors` defaults field by field. |
| `loop` | | A bounded loop back to an earlier node. See [Loops](#loops). |
| `label` | | A display name for the dashboard, the builder and logs. |

Node ids match `[A-Za-z_][A-Za-z0-9_-]*`. `input` and `output` are reserved (P015).

## Node kinds

| Kind | Effect on `data` | Value |
|---|---|---|
| [`tap`](#tap) | Unchanged. Side effects only. | `log`, `http`, `file`, `emit`, `telegram`, `exec`, `fn.<name>` |
| [`transform`](#transform) | Replaced by the result. | `map`, `http`, `exec`, `fn.<name>` |
| [`filter`](#filter) | Unchanged, or the packet is dropped as `filtered`. | An expression |
| [`route`](#route) | Unchanged. The packet goes to one named branch. | A map of branch name → expression; the last may be `else` |
| [`agent`](#agent) | Replaced by the agent's structured output. | `claude_api`, `claude_code`, `codex`, `pi`, `opencode` |

A node with no kind, or with two, is an error (P036).

## `tap`

A tap does something on the side, and `data` passes on unchanged. Use taps for logging, notifications and telemetry: things whose result doesn't change the packet and doesn't need a delivery check.

Taps run **at least once**. If the runner crashes after a tap ran but before its step was committed, the tap runs again on restart. Built-in taps carry a key so a repeat can be recognized: `<packet_id>:<node>` (with the branch for a fan-out copy).

A tap is the only kind that may use `on_error.then: continue`, which ignores a failure and passes the data on:

```yaml
telemetry:
  from: normalize
  tap: http
  with:
    url: https://telemetry.example.com/v1/events
    body: { pipeline: "${meta.pipeline}", packet: "${meta.packet_id}" }
  on_error:
    retry: 3
    then: continue          # telemetry must never block delivery
```

### `tap: log`

Writes a line to the runner's log (`pipo logs <name>`) and journals it as a `log` event, which the dashboard shows.

| Field | Meaning |
|---|---|
| `level` | `debug`, `info` (default), `warn` or `error`. |
| `message` | A template. Default: `data` as JSON. |

```yaml
logger:
  from: input
  tap: log
  with:
    level: info
    message: "Received ${meta.packet_id} via ${meta.trigger} from ${meta.source}"
```

Secrets are redacted from the message.

### `tap: http`

Calls an HTTP endpoint. The response is ignored; a status outside `success` is a node error.

| Field | Meaning |
|---|---|
| `url` | Required. A template. |
| `method` | `GET`, `POST` (default), `PUT`, `PATCH` or `DELETE`. |
| `headers` | A map of header → template. |
| `body` | The body (a template). Default: `data`. A string is sent as `text/plain`, anything else as JSON. `GET` and `DELETE` send no body. |
| `success` | Statuses that count as success, such as `[200, "2xx", "200-299"]`. Default `2xx`. |

Each request carries `Idempotency-Key: <packet_id>:<node>` unless you set that header yourself. Requests time out after 30 seconds.

### `tap: file`

Appends to or writes a file, with the same settings as the [`file` output](outputs.md): `path` (a template, relative to the `.pipo` file), `format` (`jsonl`, `json`, `csv` or `text`) and `mode` (`append` or `write`). A `jsonl` line is `{"packet_id": "<packet_id>:<node>", "data": …}`, and a repeat of the same packet and node is skipped.

```yaml
archive:
  from: input
  tap: file
  with: { path: "./archive/${meta.input}.jsonl", format: jsonl }
```

### `tap: emit`

Journals a custom event, committed in the same transaction as the step. It shows in the dashboard's event feed and on the `/events` stream.

| Field | Meaning |
|---|---|
| `event` | Required. The event's type. |
| `detail` | Any value (a template). |

```yaml
flag:
  from: classify
  tap: emit
  with: { event: vip.seen, detail: { customer: "${data.customer_id}" } }
```

### `tap: telegram`

Sends a Telegram message mid-pipeline: `bot` or `token`, `chat_id`, `text`, `photo`, `document`, `parse_mode`. Without `chat_id`, it replies to the chat a telegram input's packet came from. See [Telegram bots](telegram.md).

### `tap: exec`

Runs a program installed on the machine, such as `ffmpeg` or a script, with no shell. A tap ignores the program's output. See [Running programs](exec.md).

### `tap: fn.<name>`

Calls a function exported by the pipeline's `fn` module with `(data, meta)`. Its return value is ignored. See [User functions](functions.md).

## `transform`

A transform replaces `data` with its result. The next node sees the new value.

### `transform: map`

Replaces `data` with the rendered `with.data` template. It's the simplest way to reshape, rename or add fields, with no code:

```yaml
stamp:
  from: input
  transform: map
  with:
    data:
      status: "${data.status}"
      tick: "${meta.source}"
      received: "${iso(meta.received_at)}"
      size: "${size(data)}"
```

A value that is exactly one `${expr}` keeps its type, so `size` stays a number. `with.data` can also be a single template: `data: "${data.items[0]}"`.

### `transform: http`

Calls an HTTP endpoint and makes the response body the new `data`. The settings are the same as `tap: http`. A JSON response (by its `Content-Type`) is parsed. Anything else becomes a string. A JSON content type with a body that doesn't parse is an error.

```yaml
enrich:
  from: input
  transform: http
  with:
    method: GET
    url: "https://api.example.com/users/${data.user_id}"
    headers: { Authorization: "Bearer ${secrets.api_token}" }
```

The response replaces `data` entirely, and fan-out copies are never merged back, so anything you need from before the call has to travel in the request or come back in the response. Make network calls with `transform: http`: `fn` modules have no network access.

### `transform: exec`

Runs a program and makes its result `data`: by default `{exit_code, stdout, stderr, duration_ms, files}`, or with `result: text` the program's stdout, or with `result: json` its stdout parsed. See [Running programs](exec.md).

### `transform: fn.<name>`

Calls an exported function with `(data, meta)`. What it returns (or what its Promise resolves to) becomes `data`. Returning nothing is a node error. See [User functions](functions.md).

```ts
// people.fn.ts
export function textTransformer(data: any) {
  return { ...data, name: data.name.trim(), bio: (data.bio ?? "").slice(0, 500) };
}
```

```yaml
normalize:
  from: logger
  transform: fn.textTransformer
```

## `filter`

A filter is an [expression](expressions.md). When it's truthy, the packet passes unchanged. When it's falsy, the packet ends as **filtered**, which counts as success:

```yaml
adults:
  from: input
  filter: data.age >= 18 && exists(data.email)
```

Filters are deterministic, so they're never retried. An expression that fails to evaluate is a node error, handled by `on_error.then`.

## `route`

A route sends each packet to exactly one named branch. Branches are tried in order, and the first whose expression is truthy wins. The last branch may be `else`, which always matches (P017 if it isn't last):

```yaml
pipo: 1
name: triage
input:
  via: push
nodes:
  triage:
    from: input
    route:
      urgent: data.priority == "high"
      billing: '"invoice" in lower(data.subject)'
      normal: else
  page:
    from: triage.urgent
    tap: log
    with: { level: warn, message: "URGENT ${data.subject}" }
  billing:
    from: triage.billing
    transform: map
    with:
      data: { subject: "${data.subject}", team: billing }
output:
  from: [page, billing, triage.normal]
  to: file
  with: { path: ./out/tickets.jsonl, format: jsonl }
```

- Downstream nodes take packets from a branch as `<route>.<branch>`. A node can't take packets from the route itself (P016).
- A packet that matches no branch, in a route without `else`, ends as **filtered**.
- A branch nothing takes packets from is a warning (P025).
- `meta.input` lets a route tell packets from several inputs apart: `from_webhook: meta.input == "webhook"`.

Like filters, routes are never retried.

## `agent`

An agent node sends a rendered prompt to a model and replaces `data` with the answer, which must match the node's JSON Schema:

```yaml
classify:
  from: input
  agent: claude_api
  with:
    model: claude-sonnet-5-5
    prompt: |
      Classify this support ticket (priority: high|normal).
      ${json(data)}
    schema: ./schemas/classify.schema.json
    timeout: 60s
```

`schema` is required. An answer that doesn't match it is a node error. Agent nodes run through the Anthropic API or a coding-agent CLI on your machine, and their cost is capped by the pipeline's `agent_budget`. See [Agent nodes](agent-nodes.md).

## `from`: building the graph

`from` can name:

- an input: `input`, or a name under `inputs:`;
- a node id;
- a route branch: `triage.urgent`;
- a list of any of these.

`pipo check` makes sure the graph is sound:

- every `from` target exists (P010) and every branch exists (P011);
- every node is reachable from an input (P020), and every input leads somewhere (P021);
- every node leads to the output (P021: no dead ends);
- there are no cycles except declared loops (P022).

### Fan-in

A list in `from` merges several sources into one node. Each packet still flows through on its own; nothing is joined or waited for:

```yaml
clean:
  from: [webhook, fetch]
  transform: fn.clean
```

The output's `from` can be a list too: `output: { from: [triage.normal, page], … }`.

### Fan-out

When several nodes (or the output) take packets from the same source, each gets its own **copy** of the packet:

```yaml
pipo: 1
name: fan-out
input:
  via: push
nodes:
  audit:
    from: input
    tap: file
    with: { path: ./out/audit.jsonl, format: jsonl }
  notify:
    from: input
    tap: log
    with: { message: "new packet ${meta.packet_id} on branch ${meta.branch}" }
output:
  from: [audit, notify]
  to: file
  with: { path: ./out/all.jsonl, format: jsonl }
```

How copies behave:

- **Atomic.** The step that fans out commits its own result and every copy in one transaction, so a crash never leaves half a fan-out. A fan-out right at the input journals the packet and its copies before the input is acknowledged.
- **Same `packet_id`, own branch.** Every copy has the packet's `meta.packet_id`. `meta.branch` holds its path of consumer ids (`audit`, or nested like `a/c`; a copy sent straight to the output is `output`). An unbranched packet has an empty `meta.branch`.
- **Own key.** Each copy reaching the output is written under `packet_id:<branch>` (`meta.key`), so the copies don't overwrite each other. If you set an explicit key (a sqlite `columns` key, an http `Idempotency-Key`) or a delivery lookup by `meta.packet_id`, include `meta.branch` in it, or `pipo check` warns (P026).
- **Independent.** Inside a branch, filters, routes and error policies act on that copy only. A route branch with several consumers fans out again. Fan-in doesn't merge copies back together.
- **Settling.** The packet is pending until every copy settles. Then it is `dead_lettered` if any copy was, else `delivered` if any copy was, else `filtered`. Status counts count packets, not copies. Dead-letter entries are the copies, so each can be replayed on its own.

> [!NOTE]
> Fan-out is for sending one packet down several paths. To send data to a second destination with the same delivery guarantees, use a [chain](chains.md): a pipeline has exactly one output by design.

## Loops

The graph may not contain cycles, with one exception: a node may declare a bounded loop back to an earlier node.

```yaml
pipo: 1
name: refine
input:
  via: push
nodes:
  draft:
    from: input
    transform: map
    with:
      data: { text: "${data.text}", tries: "${meta.iteration + 1}" }
  review:
    from: draft
    transform: map
    with:
      data: { text: "${data.text}", tries: "${data.tries}", approved: "${data.tries >= 2}" }
    loop:
      back_to: draft
      until: data.approved == true
      max: 3
      then: dead_letter
output:
  from: review
  to: stdout
```

| Field | Meaning |
|---|---|
| `back_to` | Required. The node to go back to: an upstream node, or the node itself (P023, P024). |
| `until` | Required. An expression on the node's **result**. When it's true, the packet moves on. |
| `max` | Required. How many times a packet may be sent back (at least 1). |
| `then` | What happens when `max` is reached without `until` being true: an error-policy `then`, default `dead_letter`. The error code is `loop.max`. |

`meta.iteration` counts how many times the packet has been sent back. The count belongs to the packet (or fan-out copy), not to one loop: a packet that passes two loops starts the second with the first one's count, and both `max` checks see the running total. A loop back to a node upstream of a fan-out repeats the fan-out on each pass.

Loops shine with agent nodes: a draft agent and a review agent that sends the draft back with feedback, as in the [ticket-triage example](../reference/example-ticket-triage.md).

## Errors in nodes

Every node has an error policy: the pipeline's `errors:` block, overridden field by field by the node's `on_error`:

```yaml
errors:                  # defaults for every step
  retry: 2
  backoff: exponential
  delay: 500ms
  then: dead_letter
nodes:
  enrich:
    from: input
    transform: http
    with: { url: "https://api.example.com/x/${data.id}" }
    on_error:
      retry: 5           # this node retries more; backoff, delay and then come from errors
      max_delay: 30s
```

Without any policy, a failing step isn't retried and the packet is dead-lettered. When a step fails, its retries run with the backoff, then `then` decides: `dead_letter`, `drop`, `continue` (taps only, P033), `pause`, `halt` or `agent`. Filters and routes are never retried. See [Error policies](errors.md).

## Adding nodes from the CLI

`pipo generate node` inserts a node before the output, wires it, and keeps the file formatted:

```sh
pipo generate node hello.pipo notify --kind tap
```

```text
Added tap node 'notify' to hello.pipo (from: "tidy", output.from: "notify")
```

`--from <node>` picks another upstream node, and `--use` picks the connector (`http`, `fn.<name>`, …; default `log` for taps, `map` for transforms, `claude_api` for agents). See [Templates and generators](scaffolding.md). The [builder](builder.md) does the same by drag and drop.
