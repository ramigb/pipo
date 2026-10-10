# Error policies

Steps fail: an API answers 500, a database is locked, a model returns the wrong shape. An **error policy** says what happens next: how often to retry, how long to wait, and what to do when retries run out. Every error hook in a `.pipo` file has the same shape.

```yaml
pipo: 1
name: forward-orders
errors:                       # defaults for every step
  retry: 3
  backoff: exponential
  delay: 500ms
  max_delay: 30s
  then: dead_letter
input:
  via: http
  with: { path: /orders }
nodes:
  notify:
    from: input
    tap: http
    with: { url: "https://hooks.example.com/orders", body: { id: "${data.id}" } }
    on_error:
      retry: 1
      then: continue          # a failed notification must never block the order
output:
  from: notify
  to: http
  with: { url: "https://erp.example.com/api/orders" }
  on_error:
    retry: 8
    message: "ERP refused ${meta.packet_id} after ${error.attempts} attempts: ${error.message}"
```

## The shape

```yaml
on_error:
  retry: 3                  # attempts after the first one (default 0)
  backoff: exponential      # fixed (default) | exponential
  delay: 500ms              # wait before the first retry (default 1s)
  max_delay: 1m             # cap on any single wait (default 1m)
  then: dead_letter         # what happens when retries run out (default dead_letter)
  message: "…${error.message}…"   # the error recorded on the packet
```

Durations are a number and a unit: `ms`, `s`, `m`, `h` or `d` (`500ms`, `1.5s`, `2h`).

## Where policies go

| Hook | Applies to | Retried? | Falls back to `errors:` |
|---|---|:-:|:-:|
| `errors` | Default for node and output errors | | |
| `nodes.<id>.on_error` | A failing step: an http call, an `fn` error, an agent's bad answer, an exec exit code | ✓ | ✓ |
| `output.on_error` | A failing write | ✓ | ✓ |
| `nodes.<id>.loop.then` | A loop reaching `max` without `until` | | |
| `input.on_invalid` | An input `schema` or `validate` failure | never | |
| `output.on_invalid` | An `output.validate` failure | never | |
| `delivered.on_fail` | A delivery check not passing by `within` | (re-checked until `within`) | |

**Inheritance.** A node's `on_error` and the output's `on_error` are merged with the top-level `errors:` block field by field: a step's own value wins, anything it leaves out comes from `errors`, and anything both leave out takes the default. A step's `message` wins; `errors.message` applies only to steps without their own.

**`on_invalid` is never retried.** A validation failure is deterministic: the same data fails the same way again. Its `then` applies at once.

## Backoff

Retry *n* (counting from 1) waits:

- `fixed`: `delay` every time.
- `exponential`: `delay × 2^(n−1)`, so 500 ms, 1 s, 2 s, 4 s, …

Either way, a wait never exceeds `max_delay`. With `retry: 5`, `backoff: exponential`, `delay: 1s` and `max_delay: 10s`, the waits are 1 s, 2 s, 4 s, 8 s and 10 s: the step runs 6 times over about 25 s before `then` applies.

While a packet waits, it holds its place but not the pipeline: the other workers keep processing other packets (`concurrency`, default 4). Each attempt is visible in `pipo inspect`, and `meta.attempt` tells a step which attempt it's on.

## What happens when retries run out

| `then` | Meaning | Allowed in |
|---|---|---|
| `dead_letter` | Move the packet to the dead-letter queue. The default. | everywhere but `input.on_invalid` |
| `drop` | Discard the packet, counted as `filtered` (a success). | nodes, `loop.then` |
| `continue` | Ignore the failure and pass `data` on unchanged. | `tap` nodes only |
| `pause` | Pause the pipeline. The packet stays pending at the step that failed. | everywhere but `input.on_invalid` |
| `halt` | Fail the pipeline. The packet stays pending. | everywhere but `input.on_invalid` |
| `agent` | Hand the packet to an agent, which decides. | everywhere, with `agent.control: true` |

`pipo check` rejects a `then` where it isn't allowed (P033). `continue` on a transform, filter, route or agent node is refused: a step that changes data can't be skipped. `drop` is refused at the output, in `delivered.on_fail` and as an `errors:` default, so a packet that reached the output can't silently disappear. `agent` without `agent.control: true` is P034. An input's `on_invalid` takes only `then: agent`: invalid input is always rejected, so nothing else can happen to it.

### `dead_letter`

The packet's state becomes `dead_lettered`, with its error, the step it failed at, and the data it had there. It stays in the dead-letter queue (DLQ) until you replay or purge it (by default, `retention.dlq: forever`). [Replay](recovery.md) resumes it at the step it failed on, with the same data, on its pinned version.

```sh
pipo dlq people-intake                 # list the dead letters, with their errors
pipo inspect people-intake <packet_id> # the full trace of one
pipo dlq replay people-intake --all    # after fixing the cause
```

### `pause`

The pipeline pauses with the reason `error at <step>`. The failing packet is held where it is, and nothing else is processed. New packets are still journaled, up to `buffer.max`. `pipo resume` runs the held packet again from that step. Use it when a failure means "stop and look": an expired credential, a schema change at the destination.

### `halt`

The pipeline fails: it stops, in state `failed`, and the engine doesn't restart it. The packet stays pending and runs again from its step on the next start. Use it for failures that must never be skipped or worked around.

### `continue`

For taps only. A tap's failure is logged, and the packet carries on with its data unchanged. Use it for side effects that must never block delivery: telemetry, notifications, logs.

### `agent`

The packet is **escalated**: it stops where it was, keeps its data and version, and waits, across restarts, until something resolves it. An agent connected over [MCP](agent-operators.md), the dashboard or `pipo resolve` can:

- `retry` it from the step it stopped at,
- `dead_letter` it,
- or `drop` it (not at the output).

```sh
pipo resolve people-intake 01J9Z3K4X7R8M2N5P6Q7S8T9V0 --action retry --reason "endpoint fixed"
```

Escalated packets count as pending. With no agent, they simply wait and nothing is dropped; if they pile up, the input fills `buffer.max` and pushes back. At `input.on_invalid`, `then: agent` can't make the packet wait, because it was never accepted: the packet is rejected as usual, and the agent is told so it can push corrected data.

## Error messages

`message` is a [template](expressions.md#templates) rendered when the policy gives up. The result becomes the packet's error, shown in the DLQ, `pipo inspect`, the dashboard and the journal. It can use the step's usual variables plus `error`:

| Variable | Meaning |
|---|---|
| `error.message` | What went wrong, e.g. `POST https://… answered 503, not in the success list` |
| `error.code` | A stable code (see below) |
| `error.rule` | The validate rule that failed, for `on_invalid` |
| `error.node` | The step that failed |
| `error.attempts` | How many times it ran |
| `error.elapsed` | How long the attempts took, e.g. `12s` |

At the output, `output` is available too (`${output.with.table}`); in `delivered.on_fail`, `result` is too. A message that fails to render falls back to the raw error, with the rendering problem appended. Messages are [redacted](secrets.md).

```yaml
on_invalid:
  respond: 422            # http inputs: the status to answer (default 422)
  message: "Rejected: rule '${error.rule}' failed"
```

**Error codes** you'll see on packets:

| Code | Raised by |
|---|---|
| `input.schema`, `input.invalid` | The input's JSON Schema or a `validate` rule |
| `node.failed` | A step that failed |
| `loop.max` | A loop that reached `max` |
| `output.invalid` | An `output.validate` rule |
| `output.failed` | The output's write |
| `delivery.unverified` | A delivery check that didn't pass |
| `budget.packet` | An agent node over the per-packet token cap (always dead-lettered) |
| `branch.dead_lettered` | A packet whose fan-out copy was dead-lettered |
| `stall` | A packet handed to the agent by a stall |

## Rejected input

At the input, a packet that fails its `schema` or `validate` rules is **rejected**: it is journaled as `rejected` (so it can be inspected) but never accepted, processed or counted toward `lifetime.max_packets`. An `http` input answers with `on_invalid.respond` (default `422`) and the message. Rejected payloads are kept for `retention.rejected` (default 3 days).

## Fan-out and errors

After a fan-out, each branch is its own copy of the packet. Retries, `drop`, `continue` and dead-lettering act on that copy only. The packet as a whole settles once every copy has: `dead_lettered` if any copy was, else `delivered` if any copy was, else `filtered`. Dead-letter entries are the copies, and a replay resumes only the failed ones.

## See also

- [Recovering packets](recovery.md): DLQ replay, purge, rerun and resolve
- [Delivery checks](delivery.md): `on_fail` and stall detection
- [Agents as operators](agent-operators.md): escalation and `resolve`
- Spec: [§3.9 error policies](../spec.md#39-error-policies)
