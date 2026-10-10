# Outputs

Every pipeline has exactly one `output`. It is where a packet is written once, idempotently, and then verified. A packet that reaches the output and passes its [delivery check](delivery.md) is **delivered**, and that is the only thing "delivered" means.

```yaml
pipo: 1
name: signups-to-sqlite
input:
  via: http
  with: { path: /signups }
output:
  from: input
  to: sqlite
  with:
    path: ./data/signups.db
    table: signups
    create: true
```

Each packet becomes one row. Its top-level fields become columns, plus a `packet_id` column holding the packet's id. A packet written twice (after a crash, a retry or a replay) still makes one row.

## The output block

The envelope is the same for every connector. Only `with:` changes, and `pipo check` checks it against the connector's schema (see [Connectors](../reference/connectors.md#outputs)).

```yaml
output:
  from: <node | input | branch | [list]>   # required: where packets come from
  to: sqlite              # required: sqlite | file | http | stdout | telegram | pipeline
  with: {...}             # the connector's settings; every string is a template
  batch: {...}            # optional: write several packets at once (sqlite, file)
  validate: [...]         # optional: last checks before writing; never retried
  on_invalid: {...}       # optional: what a failed validate rule does
  on_error: {...}         # optional: what a failed write does (retried)
```

- **`from`** works like a node's `from`: an input name, a node id, a route branch (`triage.normal`) or a list of them. Packets from every source in the list are written the same way.
- **`with:`** values are [templates](expressions.md#templates). They can use `data`, `meta`, `env` and `secrets`.
- **`validate`** is a list of [expressions](expressions.md). Every rule must be true, or the packet isn't written. See [Validating before the write](#validating-before-the-write).
- **`on_error`** is an [error policy](errors.md). It applies when the write itself fails: a locked database, a full disk, an HTTP 500.

## Connectors at a glance

| `to` | Writes | Idempotent on | Delivery checks | Batching |
|---|---|---|---|:-:|
| [`sqlite`](#sqlite) | One row per packet | The key column (`packet_id` by default) | `record_exists`, `row_count`, `query` | ✓ |
| [`file`](#file) | One record per packet | `packet_id` (in the file or a sidecar) | `file_exists`, `file_nonempty`, `line_contains`, `checksum` | ✓ |
| [`http`](#http) | One request per packet | `Idempotency-Key` header, if the receiver honours it | `status`, `follow_up` | |
| [`stdout`](#stdout) | One line per packet | none | | |
| [`telegram`](#telegram) | One message per packet | none | | |
| [`pipeline`](#pipeline) | One packet in another pipeline | The sender's name and key | `downstream` | |

Every output also supports the universal checks `ack` (the default), `external` and `none`. `pipo check` rejects any other combination (P031).

## `sqlite`

Writes each packet as a row of a SQLite table. The database file and its folders are created if they don't exist.

| Field | Default | Meaning |
|---|---|---|
| `path` | required | Database file, relative to the `.pipo` file. Templated. |
| `table` | required | Table name: letters, digits and `_`, not starting with a digit. |
| `create` | `false` | Create the table when it doesn't exist, with the key column as `PRIMARY KEY`. |
| `mode` | `insert` | `insert` keeps the first write of a key. `upsert` updates the other columns when the key exists. |
| `key` | `packet_id` | The idempotency key column. |
| `columns` | top-level fields of `data`, plus the key | A map of column name → template. |

### Columns

Without `columns`, `data` must be an object. Each top-level field becomes a column, and the key column (`packet_id` unless you set `key`) is set to the packet's key. A packet whose `data` isn't an object fails the write with a hint to set `columns`.

With `columns`, you choose every column and its value:

```yaml
output:
  from: normalize
  to: sqlite
  with:
    path: ./data/people.db
    table: people
    create: true
    mode: upsert
    key: email
    columns:
      email: "${lower(data.email)}"
      name: "${data.name}"
      age: "${data.age}"
      tags: "${data.tags}"
      seen_at: "${iso(meta.received_at)}"
```

- A column whose value is a single `${…}` keeps its type: numbers are stored as `INTEGER` or `REAL`, `true`/`false` as `1`/`0`, `null` as `NULL`. Objects and arrays are stored as JSON text.
- With an explicit `columns` map, the `key` column must be one of the columns (P037).
- The key column needs a `PRIMARY KEY` or `UNIQUE` constraint, because idempotency relies on `ON CONFLICT`. `create: true` adds one. If you create the table yourself, add the constraint, or the write fails with a hint.
- `create: true` makes untyped columns (SQLite's dynamic typing) named after the columns of the first packet written. It never changes an existing table: add new columns yourself.

### Insert or upsert

Both modes write `INSERT … ON CONFLICT(key)`:

- **`insert`** (default): a second write of the same key does nothing. The first write wins. This is what makes a retry or a recovered write safe.
- **`upsert`**: a second write updates every other column. Use it when the key is a business key (`email`, an order id) and later packets should replace earlier ones.

The write's result is `{rowid, changes}`. It is available as `result` in the [delivery check](delivery.md).

### Choosing a key

The default key, `packet_id`, means "one row per packet". A business key (`key: email`) means "one row per email". Two packets with the same email then share a row: with `insert`, the second one is ignored; with `upsert`, it updates the row. Both packets still count as delivered.

## `file`

Writes each packet to a file. The file and its folders are created as needed.

| Field | Default | Meaning |
|---|---|---|
| `path` | required | File path, relative to the `.pipo` file. A template, so packets can go to different files. |
| `format` | `jsonl` | `jsonl`, `json`, `csv` or `text`. |
| `mode` | `append` | `append` adds to the file; `write` replaces it. |

```yaml
output:
  from: stamp
  to: file
  with:
    path: "./out/${iso(meta.received_at)}.json"
    format: json
    mode: write
```

What each format writes:

| `format` | `mode: append` | `mode: write` |
|---|---|---|
| `jsonl` | One line per packet: `{"packet_id": "…", "data": …}` | The file holds one such line |
| `json` | A JSON array of `{packet_id, data}` entries, rewritten as one file | The file holds `data`, pretty-printed |
| `csv` | One row per packet. The header comes from the first packet's top-level fields; a packet that isn't an object goes in a `value` column | A header and one row |
| `text` | `data` as text, one line per packet (objects as JSON) | `data` as text |

### Idempotency

A repeated write of the same `packet_id` is skipped, even after a crash between writing the file and committing the journal:

- `jsonl` and `json` files are their own index: every record carries its `packet_id`.
- `csv` and `text` appends keep a sidecar file, `<file>.pipo-keys`, that logs each append. On the next open, an append that was cut short by a crash is truncated and written again. Keep the sidecar next to the file.
- `mode: write` replaces the file atomically (write a temp file, then rename), so writing it again is harmless.

> [!NOTE]
> A `json` file in `append` mode must be an array written by Pipo. If something else wrote the file, the write fails with a hint: use `mode: write`, another path, or another format.

## `http`

Sends one request per packet.

| Field | Default | Meaning |
|---|---|---|
| `url` | required | Templated URL. |
| `method` | `POST` | `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. |
| `headers` | none | Header name → templated value. |
| `body` | `data` | The request body. A string is sent as `text/plain`, anything else as JSON. `GET` and `DELETE` send no body. |
| `success` | `200-299` | Statuses that count as success: `204`, `"2xx"`, `"200-299"`, or a list of them. |

```yaml
secrets:
  crm_token: env:CRM_TOKEN
output:
  from: enrich
  to: http
  with:
    method: POST
    url: https://crm.example.com/api/contacts
    headers:
      Authorization: "Bearer ${secrets.crm_token}"
    body:
      email: "${data.email}"
      name: "${data.name}"
      source: pipo
    success: [200, 201, 409]
  on_error:
    retry: 5
    backoff: exponential
    delay: 1s
```

- Each request carries an **`Idempotency-Key`** header: the packet's key (`packet_id`, or `packet_id:<branch>` for a fan-out copy). A retried or recovered write sends the same key. Pipo can't make the receiver honour it: if the receiver ignores the header, a write repeated after a crash can create a duplicate there.
- Setting `Idempotency-Key` yourself in `headers` replaces it with your own key (for example `"${data.order_id}"`). That value becomes the packet's `meta.key`.
- A status outside `success` is a write error, with the start of the response body in the message. It goes to `on_error`.
- Requests time out after 30 s.
- The write's result is `{status}`, which the `status` [delivery check](delivery.md#status) reads.

> [!TIP]
> A `409 Conflict` from a receiver that de-duplicates on the key often means "already have it". Adding `409` to `success` lets a repeated write count as delivered.

## `stdout`

Prints each packet to the runner's standard output. That is the terminal under `pipo run`, and the pipeline's log under the engine (`pipo logs <name>`). It is useful while developing.

| Field | Default | Meaning |
|---|---|---|
| `format` | `jsonl` | `jsonl`: `{"packet_id", "data"}` on one line. `json`: the same, pretty-printed. `text`: `data` as text. |

```yaml
pipo: 1
name: print-ticks
input:
  via: schedule
  with: { every: 10s, payload: { hello: world } }
output:
  from: input
  to: stdout
  with: { format: text }
```

`stdout` has no idempotency and supports only `ack`, `external` and `none`.

## `telegram`

Sends a message with a Telegram bot. With no `chat_id`, it replies to the chat a telegram input's packet came from. The result is `{chat_id, message_id}`. A crash between the send and its commit sends it again. See [Telegram bots](telegram.md).

## `pipeline`

Hands each packet to another pipeline's `via: pipeline` input, exactly once. This is how one stream reaches a second verified destination. The `downstream` delivery check waits until the receiving pipeline has delivered it. See [Chains](chains.md).

```yaml
output:
  from: clean
  to: pipeline
  with: { pipeline: people-store }
```

## Idempotency keys

Pipo delivers **at least once**. A step can run twice after a crash, and an output write can be repeated by a retry, a replay or a [rerun](recovery.md). The idempotency key is what keeps a repeated write from becoming a duplicate.

- **The default key is the packet's id** (`meta.packet_id`).
- **A fan-out copy** gets its own key, `packet_id:<branch>`, where the branch is the path of node ids the copy took (`a`, or nested `a/c`). A copy sent straight to the output has the branch `output`. Copies of one packet never collide.
- **An explicit key** replaces it: the sqlite key column when `columns` sets it, or an `Idempotency-Key` header on an http output.
- **`meta.key`** holds the key the output writes with. At the output and in the delivery check, it is the explicit key if there is one. Earlier nodes see the unit id (`packet_id` or `packet_id:<branch>`), because transforms can still change the data.

```yaml
delivered:
  check: record_exists
  with:
    where: { packet_id: "${meta.key}" }
```

> [!WARNING]
> When a fan-out sends more than one copy of a packet to the output, an explicit key built only from `meta.packet_id` makes every copy write the same row. `pipo check` warns about this (P026). Include `meta.branch` in the key, or use `meta.key`.

## Validating before the write

`output.validate` is the last check before writing. Rules are expressions that can use `data`, `meta`, `env` and `output` (the output block itself, as in `output.with.table`).

```yaml
output:
  from: normalize
  to: sqlite
  with: { path: ./data/people.db, table: people, create: true }
  validate:
    - type(data.age) == "number"
    - len(data.name) <= 200
  on_invalid:
    then: dead_letter
    message: "Packet ${meta.packet_id} failed output rule '${error.rule}'; not written"
```

- A failed rule is deterministic: the same data fails the same way again, so it is **never retried**. `on_invalid.then` applies at once. The default is `dead_letter`.
- `then: drop` isn't allowed here (P033): a packet that reached the output can't silently disappear.
- The error code is `output.invalid`. `error.rule` names the rule that failed.
- With batching, validation runs per packet, before the packet joins a batch. An invalid packet never enters one.

## Write errors

`output.on_error` is an ordinary [error policy](errors.md). It falls back to the top-level `errors:` block field by field. The error code is `output.failed`.

```yaml
output:
  from: enrich
  to: http
  with: { url: https://api.example.com/items }
  on_error:
    retry: 5
    backoff: exponential
    delay: 500ms
    max_delay: 1m
    then: dead_letter
    message: "Could not write ${meta.packet_id} after ${error.attempts} attempts: ${error.message}"
```

`then: drop` and `then: continue` aren't allowed at the output. `pause` holds the packet at the output and pauses the pipeline. `halt` stops it with the packet still pending, and `agent` hands it to an agent. After you fix the cause, [replay](recovery.md) dead-lettered packets: they resume at the output, which writes them again (idempotently) and checks them again.

## Batching

`batch` collects packets that are ready to write and writes them together. It's supported by `sqlite` and `file`. On other outputs `pipo check` rejects it (P032).

```yaml
output:
  from: parse
  to: sqlite
  batch:
    size: 100        # required: flush when this many have collected
    within: 2s       # flush this long after the first one arrived (default 1s)
  with: { path: ./data/events.db, table: events, create: true }
```

A batch is flushed when `size` packets have collected, or `within` has passed since the first one joined, whichever comes first. A flush is one write: one transaction per database file for `sqlite`, one append per file for `file`.

- **Packets stay separate.** Each packet keeps its own id, its own delivery check, its own state and its own place in the dead-letter queue. Delivery checks run per packet after the flush.
- **Failure isolation.** A failed flush is retried under `on_error`. When the retries run out, the batch is split in half and each half is written (and retried) again, repeatedly, until single packets remain. Only a single packet that still fails gets `on_error.then`, with its own error. One bad row can't take 99 good ones with it.
- **Pause, stop and drain** flush a partial batch straight away. A stop waits at most 2 s for the flush. An unfinished flush is redone on the next start.
- **Crash safety.** A packet is journaled as waiting in the batch before it joins. After a restart, waiting packets join a new batch, and its `within` starts again. Anything already written is skipped by the idempotency key.
- **One batch per version.** Packets pinned to different versions are batched separately.
- With `file` and `mode: write`, the last packet in the batch wins, as it would without batching.

Batching pays off with many small packets: one SQLite transaction for 100 rows is far cheaper than 100 transactions.

## Why only one output

A pipeline has one output by design. "Delivered" then always means one thing: this write happened and passed this check. With several outputs, it would be unclear whether delivered means all of them or any of them, a half-written packet would need its own state, and the dead-letter queue, replay and stall detection would each need a per-output form.

For a second destination:

- **No verification needed** (a log line, a notification, telemetry): use a [`tap`](nodes.md#tap) node. Taps run in the middle of the graph and leave `data` unchanged.
- **Verified, with the same guarantees**: end this pipeline with `to: pipeline` and let a second pipeline write and verify it. See [Chains](chains.md).

## See also

- [Delivery checks](delivery.md): when a written packet counts as delivered
- [Error policies](errors.md): retries, backoff and the dead-letter queue
- [Connectors reference](../reference/connectors.md#outputs): every `with:` field
- Spec: [§3.5 output](../spec.md#35-output), [§7.3 delivery guarantees](../spec.md#73-delivery-guarantees)
