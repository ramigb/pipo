# Delivery checks

When the output connector reports a successful write, the packet is **written**. The `delivered` block decides when it is **delivered**. By default the connector's own success report is enough (`check: ack`). An explicit check verifies the result at the destination: the row exists, the line is in the file, a follow-up request sees it.

```yaml
pipo: 1
name: heartbeat
input:
  via: schedule
  with: { every: 5s, payload: { status: alive } }
output:
  from: input
  to: file
  with: { path: ./out/heartbeat.jsonl, format: jsonl }
delivered:
  check: line_contains
  with: { value: "${meta.packet_id}" }
  within: 5s
  on_fail:
    then: dead_letter
    message: "No line for ${meta.packet_id} after ${error.elapsed}"
```

The packet's states are `writing` → `verifying` → `delivered`. A check that doesn't pass in time sends the packet to `on_fail`. By default that means the dead-letter queue.

## The `delivered` block

```yaml
delivered:
  check: record_exists      # what to verify; must be supported by output.to
  with: {...}               # the check's settings; every value is a template
  within: 10s               # keep re-checking until this deadline (default 10s)
  on_fail: {...}            # error policy when it doesn't pass
  stall: {...}              # pipeline health: see "Stall detection" below
```

- **`check`** defaults to `ack`.
- **`with:`** values are [templates](expressions.md#templates), rendered per packet. They can use `data`, `meta`, `env`, `secrets`, `output` (the output block, as in `output.with.table`) and `result` (what the write returned).
- **`within`** is how long to keep trying. The check runs right after the write, then about every 250 ms (or every `within`, if shorter) until it passes or the deadline is reached.
- **`on_fail`** is an [error policy](errors.md). Its `then` and `message` apply when the check hasn't passed by `within`. It doesn't fall back to the top-level `errors:` block, and `then: drop` isn't allowed here (P033). The error code is `delivery.unverified`.

A check that can't run counts as a failed attempt and is retried until `within`: bad SQL, an unreadable file, an unreachable URL. The last such error becomes the packet's error message.

## Compatibility

Each output supports the universal checks, plus its own. `pipo check` rejects any other combination (P031):

| Check | sqlite | file | http | stdout | telegram | pipeline | Passes when |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| `ack` (default) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | The connector reported success. For `pipeline`, the receiver journaled the packet. |
| `record_exists` | ✓ | | | | | | A row matching `with.where` exists. |
| `row_count` | ✓ | | | | | | `with.query` returns at least `with.min` rows. |
| `query` | ✓ | | | | | | A custom SQL query's first column is truthy. |
| `file_exists` | | ✓ | | | | | The file exists. |
| `file_nonempty` | | ✓ | | | | | The file exists and isn't empty. |
| `line_contains` | | ✓ | | | | | A line of the file contains `with.value`. |
| `checksum` | | ✓ | | | | | The file's SHA-256 equals `with.sha256`. |
| `status` | | | ✓ | | | | The write's response status is in `with.success`. |
| `follow_up` | | | ✓ | | | | A GET to `with.url` succeeds, or its body matches `with.match`. |
| `downstream` | | | | | | ✓ | The receiving pipeline delivered the packet. |
| `external` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Someone acknowledged the packet with `pipo ack`. |
| `none` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Always: nothing is verified. |

A rejected combination looks like this:

```text
people-intake.pipo:61:10  error  P031  delivered.check 'file_exists' is not supported by output 'sqlite'
  supported: ack, record_exists, row_count, query, external, none
```

## SQLite checks

SQLite checks open the output's database with a **read-only** connection, so a check can never change data. Put values in `params`, never into the SQL text.

### `record_exists`

| Field | Meaning |
|---|---|
| `where` | Required. Column → value pairs, matched with `=` and joined with `AND`, in the output's `table`. |

```yaml
output:
  from: normalize
  to: sqlite
  with:
    path: ./data/people.db
    table: people
    create: true
    key: id
    columns:
      id: "${meta.packet_id}"
      name: "${data.name}"
delivered:
  check: record_exists
  with:
    where: { id: "${meta.packet_id}" }
  within: 10s
```

### `row_count`

| Field | Meaning |
|---|---|
| `query` | Required. A read-only `SELECT`. |
| `params` | Values bound to its `?` placeholders, in order. |
| `min` | Rows it must return. Default `1`. A number, or a template that renders to one (`"${data.expected}"`). |

```yaml
delivered:
  check: row_count
  with:
    query: "SELECT 1 FROM order_lines WHERE order_id = ?"
    params: ["${data.order_id}"]
    min: 1
```

### `query`

| Field | Meaning |
|---|---|
| `sql` | Required (`query` is accepted as an alias). A read-only `SELECT`. The first column of the first row must be truthy. |
| `params` | Values bound to its `?` placeholders. |

```yaml
delivered:
  check: query
  with:
    sql: "SELECT total = ? FROM invoices WHERE id = ?"
    params: ["${data.total}", "${data.invoice_id}"]
```

## File checks

`path` defaults to the output's own (rendered) `path` for every file check.

### `file_exists` and `file_nonempty`

| Field | Meaning |
|---|---|
| `path` | Optional. The file to look at. |

`file_nonempty` also needs the file's size to be greater than 0. Both suit `mode: write` outputs, where each packet writes its own file:

```yaml
output:
  from: render
  to: file
  with: { path: "./out/${meta.packet_id}.json", format: json, mode: write }
delivered:
  check: file_nonempty
```

### `line_contains`

| Field | Meaning |
|---|---|
| `value` | Required. A substring that one line of the file must contain. |
| `path` | Optional. |

With a `jsonl` file, every line carries its packet's id, so `value: "${meta.packet_id}"` confirms the packet's own line landed.

### `checksum`

| Field | Meaning |
|---|---|
| `sha256` | Required. 64 hex characters, any case. The hash of the whole file. |
| `path` | Optional. |

This suits a file whose expected content is known in advance, for example when the packet carries the hash of what it writes.

## HTTP checks

### `status`

| Field | Meaning |
|---|---|
| `success` | Statuses that pass, as in the output: `204`, `"2xx"`, `"200-299"`, or a list. Default `2xx`. |

This check reads the status stored from the write, and sends no new request. Use it to be stricter than the output's own `success`. For example, the output can accept `409` as "already there" so it isn't retried, while the check passes only `201`.

### `follow_up`

| Field | Meaning |
|---|---|
| `url` | Required. A GET is sent here. |
| `headers` | Request headers (templates, so they can use `secrets`). |
| `success` | Statuses that pass. Default `2xx`. |
| `match` | Optional. Text the body must contain, or an object that must be a subset of the JSON body. |

```yaml
secrets:
  crm_token: env:CRM_TOKEN
output:
  from: input
  to: http
  with:
    url: https://crm.example.com/api/contacts
    headers: { Authorization: "Bearer ${secrets.crm_token}" }
delivered:
  check: follow_up
  with:
    url: "https://crm.example.com/api/contacts?email=${data.email}"
    headers: { Authorization: "Bearer ${secrets.crm_token}" }
    match: { email: "${data.email}" }
  within: 30s
```

Each follow-up request times out after 5 s. A non-success status is a "not yet", and an unreachable URL is an error. Both are retried until `within`.

## `downstream`

For a `to: pipeline` output only. It waits until the receiving pipeline's packet settles: `delivered` passes. `dead_lettered`, `filtered`, `rejected`, or a packet the receiver no longer has, fails at once with the receiver's reason. A receiver that isn't running is a failed attempt, re-checked until `within`. Give `within` room for the receiver's own retries. See [Chains](chains.md).

## `external`

The packet waits, parked without holding a worker, until something outside Pipo acknowledges it:

```sh
pipo ack people-intake 01J9Z3K4X7R8M2N5P6Q7S8T9V0
```

The same acknowledgement is available over REST (`POST /api/pipelines/<name>/ack`) and MCP (the `ack` tool). `within` is the deadline, counted from the write. It is stored in the journal, so a restart keeps it. An ack sent while the pipeline is paused still counts. A packet that isn't acknowledged in time goes to `on_fail`.

```yaml
delivered:
  check: external
  within: 1h
  on_fail:
    then: dead_letter
    message: "Nobody confirmed ${meta.packet_id} within an hour"
```

Use it when a person, another system or an agent confirms the result: a human proof-read, a downstream job that reports back, a payment that settles.

## `none`

Don't verify. The packet is delivered as soon as the write succeeds, as with `ack`. The difference is intent: `none` says that something outside Pipo checks the results, for example after a one-off run bounded by [`lifetime`](lifetime.md).

## Stall detection

Delivery checks verify single packets. `stall` watches the whole pipeline: it notices when packets are pending but none is getting through.

```yaml
delivered:
  stall:
    after: 5m           # required: no progress for this long while packets are pending
    then: pause         # notify (default) | pause | agent
    message: >
      Pipeline jammed: ${stall.pending} packets pending and none delivered for ${stall.duration}.
      Oldest packet ${stall.oldest.packet_id} has been at '${stall.oldest.node}' for ${stall.oldest.age}
      (attempt ${stall.oldest.attempt}, last error: ${stall.oldest.last_error}).
```

**When it fires.** While the pipeline is active, the runner checks every second (more often for a short `after`). A stall is: packets are pending, and no packet has been delivered or filtered for `after`. The clock starts from the latest of: the last delivered or filtered packet, the start or last resume, and the last check that found nothing pending. So a fresh backlog after a quiet hour doesn't fire at once. Escalated packets (waiting for an agent) don't count, because they aren't moving.

**What it does.** It fires once per episode. It journals a `pipeline.stall` event with the rendered message, logs it, and then:

| `then` | Effect |
|---|---|
| `notify` (default) | Flags the pipeline `jammed`. It keeps running; `pipo status` and the dashboard show it. |
| `pause` | Pauses the pipeline with the reason `stall`. Packets keep being journaled, up to `buffer.max`. |
| `agent` | Flags it as `notify` does, and tells the agent endpoint (needs `agent.control`, P034). |

With `agent.on_stall: handle`, the packets in flight when the stall fires are handed to the agent to resolve. See [Agents as operators](agent-operators.md).

**When it clears.** The next delivered or filtered packet ends a `jammed` episode (event `pipeline.unjammed`). A resume also starts a new episode with a fresh clock. Nothing is checked while the pipeline is paused.

**The message** is a template with `stats.*` (`accepted`, `delivered`, `pending`, `dead_lettered`, `uptime`, …), `stall.pending`, `stall.duration`, and `stall.oldest.{packet_id, node, age, attempt, last_error}`. Without `message`, a default one is used.

## Choosing a check

| Situation | Check |
|---|---|
| Development, or a destination you trust | `ack` (the default) |
| A SQLite table you own | `record_exists` on the key |
| Several rows per packet | `row_count` |
| Anything a query can express | `query` |
| One file per packet | `file_exists` or `file_nonempty` |
| A JSONL log | `line_contains` on `${meta.packet_id}` |
| An API that can be read back | `follow_up` |
| An API that answers precisely | `status` |
| Another pipeline finishes the job | `downstream` |
| A person or another system confirms | `external` |
| Results are checked outside Pipo | `none` |

A check costs a little time and an extra read per packet. In exchange, "delivered" means the result was seen at the destination. Triggers that delete rows, a database file replaced by another process, a proxy that answers 200 and drops the request: these are the failures a check catches and an `ack` doesn't.

## See also

- [Outputs](outputs.md): writes and idempotency keys
- [Error policies](errors.md): `on_fail` and the dead-letter queue
- [Recovering packets](recovery.md): replaying packets whose check failed
- Spec: [§3.10 delivery verification](../spec.md#310-delivered-delivery-verification)
