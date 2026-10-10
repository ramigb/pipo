# Inputs

An input defines how packets arrive, how their bodies are parsed and what makes them valid. Every pipeline has at least one. Most have exactly one, written as `input:`. A pipeline with several uses `inputs:` (see [Several inputs](#several-inputs)).

```yaml
input:
  via: http                      # http | schedule | watch | push | system | telegram | pipeline
  with: {...}                    # connector settings
  format: json                   # json | text | csv | form | bytes (http only)
  schema: ./person.schema.json   # optional JSON Schema check, run before `validate`
  validate:                      # every rule must be true
    - exists(data)
    - data.age > 30
  on_invalid:                    # deterministic failure: never retried
    respond: 422                 # http only
    message: "Rejected: rule '${error.rule}' failed"
```

| `via` | Triggered by | Key `with:` settings |
|---|---|---|
| [`http`](#http) | A webhook or API call to `/in/<pipeline><path>` | `path`, `method`, `auth`, `respond`, `timeout`, `listen` |
| [`schedule`](#schedule) | A timer | `cron` or `every`, `payload` |
| [`watch`](#watch) | File system changes | `path`, `events`, `read` |
| [`push`](#push) | `pipo push`, the dashboard or an agent | none |
| [`system`](#system) | Sampling the operating system | `every`, `metrics` |
| [`telegram`](#telegram) | A message to a Telegram bot | `bot` or `token`, `allow`, `poll_every`, `download` |
| [`pipeline`](#pipeline) | Another pipeline's `to: pipeline` output | `from` |

Every field of every input is listed in the [Connectors reference](../reference/connectors.md#inputs).

## How a packet is accepted

When an input receives something, the runner:

1. parses it into `data` (for `http`, according to `format`);
2. checks `data` against the input's `schema` file, if there is one;
3. evaluates the `validate` rules in order, stopping at the first one that is false;
4. if everything passed, journals the packet as **accepted** and only then acknowledges it to the sender;
5. if a check failed, journals the packet as **rejected**, with the failed rule, and applies `on_invalid`.

A rejected packet never enters the graph, and is never retried: the same data would fail the same way. It is still in the journal, so `pipo packets <name> --state rejected` lists it with its reason. Rejected payloads are kept for 3 days by default (`retention.rejected`).

Every packet gets `meta` values that say where it came from: `meta.trigger` is the input's `via` (`http`, `schedule`, …), `meta.source` says more (the client's IP, the tick time, the file path), and `meta.input` is the input's name (`input` for a pipeline with a single `input:`). See [Expressions and templates](expressions.md).

## `schema`, `validate` and `on_invalid`

**`schema`** names a JSON Schema file, relative to the `.pipo` file. `pipo check` makes sure it exists and is a valid schema (P014, P054). When `data` doesn't match, the failed rule is `schema` and the message describes the mismatch.

**`validate`** is a list of [expressions](expressions.md). Every one must be truthy. They see `data`, `meta` and `env`:

```yaml
validate:
  - exists(data.email) && matches(data.email, "^[^@]+@[^@]+$")
  - len(data.items) > 0
  - data.amount <= 10000
```

An expression that can't be evaluated counts as a failed rule. The failed rule's text becomes `error.rule`.

**`on_invalid`** decides what happens to a rejected packet:

| Field | Meaning |
|---|---|
| `respond` | The HTTP status to answer with (400–599, default `422`). `http` inputs only (P035). |
| `message` | A template for the rejection message, with `error.rule`, `error.message` and `error.code` available. |
| `then` | Only `agent`: it also tells the agent about the rejection (the packet is still rejected, since it was never accepted). Needs `agent.control: true`. Any other `then` is P033, because a packet that was never accepted can't be retried, dead-lettered, dropped or held. |

The error codes are `input.schema` and `input.invalid`.

## `http`

```yaml
pipo: 1
name: orders
secrets:
  hook_secret: env:ORDERS_HOOK_SECRET
input:
  via: http
  with:
    path: /orders
    method: POST
    listen: 8081
    auth:
      hmac:
        header: X-Signature
        secret: "${secrets.hook_secret}"
        algorithm: sha256
  format: json
  validate:
    - exists(data.order_id)
output:
  from: input
  to: file
  with: { path: ./out/orders.jsonl, format: jsonl }
```

The route is `/in/<pipeline><path>`, here `/in/orders/orders`. `path` defaults to `/`, which serves `/in/orders` itself, and `method` defaults to `POST`. A trailing slash on the request doesn't matter.

### Where it listens

- **`listen: <port>`** makes the runner bind that port on `127.0.0.1` itself. `pipo run --listen` and `pipo start --listen` override it.
- **Through the engine**, the gateway also serves `/in/<pipeline>/…` on the engine's port (`engine.listen`) and forwards it to the runner, so an input without `listen` works while the engine is up.
- A detached runner with no `listen` is unreachable while the engine is down. Pipo never picks a port for you. See [Running pipelines](running.md).

With `pipo run` and no port anywhere, the runner refuses to start and says how to give it one.

### Authentication

Two methods, which can be combined:

| `auth` | How it works |
|---|---|
| `header` + `equals` | The request must carry the header with exactly this value, compared in constant time. Use a secret: `equals: "${secrets.token}"`. |
| `hmac: {header, secret, algorithm}` | The header must carry the hex HMAC of the **raw body**, keyed with `secret`. `algorithm` is `sha256` (default) or `sha1`. A `sha256=` or `sha1=` prefix, as GitHub sends it, is accepted. |

A missing or wrong token or signature is `401`, and nothing is journaled. To compute a signature for testing:

```sh
body='{"order_id": 1}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$ORDERS_HOOK_SECRET" | sed 's/^.* //')
curl -X POST localhost:8081/in/orders/orders -H "X-Signature: sha256=$sig" \
  -H 'content-type: application/json' -d "$body"
```

### Body formats

`format` (default `json`) decides how the body becomes `data`:

| `format` | `data` |
|---|---|
| `json` | The parsed JSON value. |
| `text` | The body as a string. |
| `csv` | One packet **per record**: an object keyed by the header row. The header row is required, and column names must be unique. |
| `form` | An object of fields, from `application/x-www-form-urlencoded` or `multipart/form-data`. An uploaded file becomes `{filename, content_type, size, base64}`. |
| `bytes` | `{base64, content_type, size}`. |

A body that doesn't parse is `400` with a hint. Bodies over 128 MB are refused with `413`.

### Responses

By default (`respond: accepted`), the input answers as soon as the packet is journaled:

| Status | When | Body |
|---|---|---|
| `202` | Accepted | `{"packet_id": "…", "state": "accepted"}` |
| `422` (or `on_invalid.respond`) | Rejected by `schema` or `validate` | `{"packet_id", "state": "rejected", "error", "rule"}` |
| `400` | The body doesn't parse as `format` | `{"error", "hint"}` |
| `401` | Wrong token or signature | `{"error", "hint"}` |
| `404` / `405` | No input at that path / wrong method (`Allow` lists the right ones) | `{"error", "hint"}` |
| `503` + `Retry-After: 5` | Not running, draining, past its lifetime, or the buffer is full | `{"error"}` |

With **`respond: delivered`**, the request waits until the packet settles, up to `timeout` (default `30s`), and reports the final state:

| Status | Final state |
|---|---|
| `200` | `delivered` or `filtered` |
| `502` | `dead_lettered`, with the error message |
| `202` | Still pending when `timeout` ran out, or waiting for an agent |

`respond: delivered` suits synchronous callers, such as a form that should show whether the data was stored. For a `csv` body, the answer lists every record under `packets`.

`meta.trigger` is `http` and `meta.source` is the client's IP address.

## `schedule`

```yaml
pipo: 1
name: nightly-report
input:
  via: schedule
  with:
    cron: "0 3 * * *"           # 03:00 UTC every day
    payload: { report: daily }
output:
  from: input
  to: stdout
```

Set exactly one of `cron` and `every` (P038):

- **`cron`** is a 5-field expression (minute, hour, day of month, month, day of week) with `*`, lists (`1,15`), ranges (`1-5`) and steps (`*/10`). When both day fields are restricted, either may match. Cron is evaluated in **UTC**.
- **`every`** is a duration (`30s`, `5m`, `1h`), counted from when the runner starts.

Each tick becomes one packet. `data` is `payload` (default `{}`), `meta.trigger` is `schedule`, and `meta.source` is the tick time in ISO 8601. The next tick is armed only after the packet is journaled. Ticks missed while the runner was down or the machine was asleep are **skipped**, not replayed, and the log says how many. A tick that arrives while the buffer is full is skipped too.

## `watch`

```yaml
pipo: 1
name: inbox
input:
  via: watch
  with:
    path: ./inbox/*.txt
    events: [create, change]
    read: content
output:
  from: input
  to: file
  with: { path: ./out/seen.jsonl, format: jsonl }
```

| Field | Meaning |
|---|---|
| `path` | A glob, relative to the `.pipo` file (`./inbox/**/*.md`). A plain folder means every file below it. |
| `events` | Which changes make packets: `create`, `change`, `delete`. Default `[create, change]`. |
| `read` | `content` puts the file's text in `data.content`. `path` (the default) sends only the file's details. |

Each packet's `data`:

```json
{
  "event": "create",
  "path": "/home/me/project/inbox/note.txt",
  "name": "note.txt",
  "size": 12,
  "mtime": "2026-01-01T09:00:00.000Z",
  "content": "hello there\n"
}
```

`name` is the path relative to the watched folder. A `delete` has no `mtime` or `content`. A file over 1 MB is sent with `content: null` and `truncated: true`. `meta.source` is `<path>#<event>@<mtime>`.

How it behaves:

- **The first start records a baseline.** Files that already exist don't make packets. Only changes after that do.
- **Restarts catch up.** The folder's snapshot is saved in the journal with each packet, so after a restart the runner compares the folder with the snapshot and sends what changed while it was down. A crash can neither lose nor repeat an event.
- **Bursts collapse.** File events only wake a scanner, which compares the folder with its snapshot, so several quick writes to one file make one `change`. The scanner also runs every second, for file systems where events get lost.
- **Changing `path`** starts a new baseline.

> [!TIP]
> To process large or binary files, use `read: path` and hand `data.path` to an [`exec`](exec.md) step or an `fn` function.

## `push`

```yaml
pipo: 1
name: notes
input:
  via: push
output:
  from: input
  to: file
  with: { path: ./out/notes.jsonl, format: jsonl }
```

A `push` input has no listener. Packets arrive through the runner's control socket, from:

- `pipo push notes --data '{"text": "hi"}'` or `--file packet.json`;
- the dashboard's **🧪 Send a test packet** card;
- an agent, through the MCP `push` tool or `POST /api/pipelines/<name>/push`.

The command returns the packet id once the packet is journaled. `meta.trigger` is `push`. `meta.source` says who pushed it: `cli` for `pipo push` (or the value of `--source <s>`), `ui` for the dashboard, or the `source` an agent or REST caller passes.

Pushing is not limited to `via: push` inputs: `pipo push` can hand a packet to any running pipeline, which is handy for testing an `http` or `schedule` pipeline. With several inputs, name one with `--input`. Without it, the push goes to the only input, or to the only `via: push` input.

## `system`

```yaml
pipo: 1
name: machine-health
input:
  via: system
  with:
    every: 1m
    metrics: [cpu, memory, disk]
nodes:
  busy:
    from: input
    filter: data.cpu.percent > 80 || data.memory.percent > 90
output:
  from: busy
  to: file
  with: { path: ./out/alerts.jsonl, format: jsonl }
```

Every `every` (required), the runner samples the requested `metrics` (default: all five) and makes one packet:

```json
{
  "cpu": { "percent": 12.5, "cores": 8, "load": [0.42, 0.38, 0.3] },
  "memory": { "total": 17179869184, "free": 4294967296, "used": 12884901888, "percent": 75 },
  "disk": { "path": "/", "total": 499963174912, "free": 199985269964, "used": 299977904948, "percent": 60 },
  "battery": { "percent": 80, "status": "Discharging" },
  "network": { "rx_bytes": 123456789, "tx_bytes": 9876543 },
  "sampled_at": "2026-01-01T09:00:00.000Z"
}
```

A metric the platform can't provide (a battery on a server) is `null`. `meta.source` is the sample time.

## `telegram`

```yaml
input:
  via: telegram              # messages to the default bot
  with:
    allow: [123456789]       # chat or user ids; replaces the bot's own list
```

The runner long-polls a Telegram bot while the pipeline runs, and turns each message from an allowed chat or user into a packet: `{message_id, date, chat_id, chat_type, from, text, file}`. Attached files are downloaded. Bots are set up once per Pipo home, on the dashboard's **🤖 Bots** page. Only one pipeline may poll a given bot. See [Telegram bots](telegram.md).

## `pipeline`

```yaml
input:
  via: pipeline
  with:
    from: [people-intake]    # the pipelines allowed to feed this one
```

Packets come from another pipeline's `to: pipeline` output, handed over exactly once. Both ends declare the link. `meta.trigger` is `pipeline`, `meta.source` is the sender's name, and `meta.upstream` names the sender's packet. See [Chains](chains.md).

## Several inputs

A pipeline can have up to 16 inputs, under `inputs:` as a map of name to input. Nodes and the output take packets from an input by its name:

```yaml
pipo: 1
name: people
inputs:
  webhook:
    via: http
    with: { path: /people }
    validate:
      - exists(data.name)
  nightly:
    via: schedule
    with: { cron: "0 3 * * *", payload: { backfill: true } }
nodes:
  fetch:
    from: nightly
    transform: http
    with: { method: GET, url: "https://example.com/people/latest" }
  clean:
    from: [webhook, fetch]       # fan-in: each packet flows through on its own
    transform: map
    with:
      data: { name: "${trim(data.name)}", via: "${meta.input}" }
output:
  from: clean
  to: sqlite
  with: { path: ./people.db, table: people, create: true }
```

`input:` is shorthand for `inputs:` with one input named `input`, so `from: input` keeps working.

- **Names** follow node ids (`[A-Za-z_][A-Za-z0-9_-]*`) and share their namespace. An input can't have a node's name or be called `output` (P061). A file has exactly one of `input` and `inputs` (P060).
- **Each input is its own edge.** It has its own `format`, `schema`, `validate`, `on_invalid` and `respond`, and its own durable state (a watch snapshot, a Telegram offset), so adding a second input never resets the first. `meta.input` says which input a packet came from, so a `route` can tell them apart. To give packets from different inputs one shape, put a transform after each before they meet.
- **The rest is shared**: one journal, one `buffer.max`, one `concurrency`, one `lifetime` (`max_packets` counts packets from every input) and one pause.
- **HTTP inputs share one listener.** Two of them need different `path`s or `method`s, and if more than one sets `listen`, it must be the same port. Two Telegram inputs can't poll the same bot. Either clash is P062.
- **Pushing** to a pipeline with several inputs needs `--input <name>`, unless exactly one of them is `via: push`.

## Backpressure

Accepted packets wait in the journal until a worker takes them. `buffer.max` (default `10000`) caps how many may wait. A paused pipeline keeps accepting until that cap, so nothing is lost during a pause. When the buffer is full, each input pushes back in its own way:

| Input | When the buffer is full |
|---|---|
| `http` | Answers `503` with `Retry-After: 5`. |
| `telegram`, `watch` | Wait and try again; nothing is lost. |
| `schedule`, `system` | Skip that tick or sample. |
| `push`, `pipeline` | Answer `unavailable`; a sending pipeline retries under its output's `on_error`. |

Packets handed to an agent count as pending too. With no agent resolving them, the buffer eventually fills.

## Changing inputs on a running pipeline

Within an input, `schema`, `validate` and `on_invalid` can change in a live version (a proposal or `pipo rollback`). Adding, removing or renaming an input, or changing its `via` or `with:`, changes what the runner binds at start, so it needs a restart. See [Live changes and proposals](change-protocol.md).
