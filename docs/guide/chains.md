# Chains

A chain is two pipelines joined end to end: one pipeline's output feeds another pipeline's input. Use a chain when:

- one stream has to reach **a second verified destination**. A pipeline has exactly one output by design, so the second destination gets its own pipeline, with its own output and delivery check;
- a large pipeline is easier to run as **parts that are versioned, paused and restarted on their own**, for example an intake that cleans data and a store that writes it.

Each packet is handed over **exactly once**, however often the sender retries or either side crashes.

## A sender and a receiver

Both ends declare the link. The sender's output is `to: pipeline`:

```yaml
pipo: 1
name: people-intake
input:
  via: http
  with: { path: /people }
nodes:
  clean:
    from: input
    transform: map
    with:
      data:
        name: "${trim(data.name)}"
        email: "${lower(trim(data.email))}"
output:
  from: clean
  to: pipeline
  with: { pipeline: people-store }
  on_error: { retry: 10, backoff: exponential, delay: 1s, max_delay: 30s }
delivered:
  check: downstream        # wait until people-store has written and verified it
  within: 2m
```

The receiver has an input `via: pipeline` that lists the pipelines allowed to feed it:

```yaml
pipo: 1
name: people-store
inputs:
  intake:
    via: pipeline
    with: { from: [people-intake] }
    validate:
      - exists(data.email)
  manual:
    via: push
output:
  from: [intake, manual]
  to: sqlite
  with:
    path: ./data/people.db
    table: people
    create: true
    mode: upsert
    key: email
    columns:
      email: "${data.email}"
      name: "${data.name}"
delivered:
  check: record_exists
  with:
    where: { email: "${data.email}" }
```

Start the receiver first, then the sender:

```sh
pipo start people-store.pipo
pipo start people-intake.pipo --listen 8790
curl -X POST localhost:8790/in/people-intake/people \
  -H 'content-type: application/json' -d '{"name": " Ada ", "email": "Ada@Example.com"}'
```

The repository has a complete pair: [signup-intake](../../examples/signup-intake) (a web form and a nightly import, cleaned and handed on) and [signup-store](../../examples/signup-store) (one row per sign-up, also fed by `pipo push`).

## The two ends

### Sender: `to: pipeline`

| `with:` | Meaning |
|---|---|
| `pipeline` (required) | The name of the pipeline to feed. |
| `data` | A template for what the receiver gets as `data`. Defaults to the packet's `data`. |

It is an ordinary output: `output.validate`, `on_invalid` and `on_error` work as usual. `batch` isn't supported on `to: pipeline` (P032); a batch mode for it is planned.

The output's result, available to `delivered` as `result`, is `{pipeline, packet_id, duplicate}`: the receiving pipeline, the receiver's packet id, and whether that packet already existed.

### Receiver: `via: pipeline`

| `with:` | Meaning |
|---|---|
| `from` (required) | The pipelines allowed to feed this input: a list of one or more names. |

A pipeline can have up to 16 inputs, so a receiver can also take packets from `http`, `push` or anything else (see [Inputs](inputs.md)). `meta.input` tells a `route` which one a packet came through. Each `via: pipeline` input has its own `format`, `schema`, `validate` and `on_invalid`, like any input.

## What `pipo check` enforces

| Code | Severity | Rule |
|---|---|---|
| [P063](../reference/diagnostics.md#p063) | error | A `via: pipeline` input can't list the pipeline itself, one sender can't appear in two inputs of the same pipeline, and `to: pipeline` can't name its own pipeline. |
| [P064](../reference/diagnostics.md#p064) | warning | In a check of several files (a folder), a link declared at one end only, or chains that form a cycle. |
| [P031](../reference/diagnostics.md#p031) | error | `delivered.check: downstream` is only valid with `to: pipeline`. |

P064 can only see the pipelines in the same run, so check a project as a folder:

```sh
pipo check examples          # both ends of signup-intake → signup-store together
```

A name that isn't in the run isn't checked, since the other end may live in another folder.

## How the hand-off works

Chains work within one **Pipo home**. The sender finds the receiver through its registry entry (`<home>/run/<receiver>.json`) and sends each packet over the receiver's control socket, one `deliver` request per write with a 10 s timeout. Both pipelines must run under the same home. Chains across machines are planned along with distributed engines.

The receiver journals the packet before it answers, **in the same transaction** that records the sender's name and the packet's key (`meta.key`) in its inbox. So:

- a write repeated after a crash, a timeout or a retry finds the inbox row and gets back the packet that already exists, marked `duplicate: true`, and nothing new is journaled;
- the sender then commits its write with that result.

Across the hand-off, each sender unit (a packet, or a fan-out copy with its own `packet_id:<branch>` key) becomes exactly one receiver packet. Inbox rows are removed with their packet when retention clears it.

### What the receiver sees

| Field | Value |
|---|---|
| `meta.trigger` | `pipeline` |
| `meta.source` | The sender's name. |
| `meta.input` | The receiving input's name. |
| `meta.upstream` | `{pipeline, packet_id, key, depth}`: the sender, its packet and key, and how many hand-offs the data has made. `null` for packets that didn't come from a pipeline. |

`depth` is 1 for a packet from a sender whose own packet had no upstream, and grows by one at each hop. A packet past **depth 16** is refused (`rejected`, nothing journaled), so a cycle of pipelines can't run forever.

## When the write fails

A failed hand-off is a write error on the sender's output, handled by its `output.on_error` like any other. The two error codes are:

| Error | When | What happens |
|---|---|---|
| `downstream_unavailable` | The receiver isn't running, is draining or stopping, has reached its lifetime, has a full buffer, or doesn't answer within 10 s. | Retried under `on_error`. Packets wait in the sender's journal. The hint says to start the receiver (`pipo start <name>`). |
| `downstream_rejected` | The receiver's input rejected the packet (`schema`, `validate`), the sender isn't in its `from` list, or the depth is over 16. | The receiver keeps it as `rejected` and applies its own `on_invalid`. The error carries the receiver's message. |

Nothing starts the receiver for you. Give the sender a generous `on_error` (many retries, exponential backoff) so a short outage of the receiver doesn't dead-letter packets, and use `delivered.stall` on the sender to notice a long one.

> [!TIP]
> A rejected packet is rejected again on every retry, because the data doesn't change. Check what the receiver requires earlier, with `output.validate` on the sender, so bad packets dead-letter at once with a clear message instead of retrying.

## When a packet counts as delivered

The sender's `delivered.check` decides:

| Check | The sender's packet is delivered when… |
|---|---|
| `ack` (default) | The receiver has journaled it. From then on, the receiver's journal owns it. |
| `downstream` | The receiver's packet is `delivered`. The sender re-checks until `within` (default `10s`). |
| `external`, `none` | As for any output (see [Delivery checks](delivery.md)). |

With `check: downstream`:

- `delivered` on the receiver passes the check;
- `dead_lettered`, `filtered` or `rejected` on the receiver, or a packet the receiver no longer has, fails it **at once** with the receiver's reason, and the sender's `delivered.on_fail` applies;
- a receiver that isn't running is a failed attempt, re-checked until `within`.

Give `within` room for the receiver's own retries and delivery check. The signup-intake example uses `within: 1m`.

## Replaying across a chain

When a sender's packet is dead-lettered by `check: downstream`, the real problem is in the receiver, which owns its packet. Fix it in this order:

1. Fix the cause in the receiver (its file, its destination, its data).
2. Replay the **receiver's** dead letter: `pipo dlq replay people-store <id>`.
3. Replay the **sender's** dead letter: `pipo dlq replay people-intake <id>`.

The sender's replay writes again. The receiver answers with the packet it already has, now `delivered`, and the check passes. Replaying only the sender finds the same dead-lettered packet on the receiver and fails again. See [Recovering packets](recovery.md).

## Pausing, changing and testing

- **Pause.** A paused receiver still journals what it receives, like any input, up to `buffer.max`. Pausing it doesn't make the sender fail.
- **Live changes.** Changing `output.with.pipeline` is a live change (a proposal or `apply`). Changing `output.to`, or a receiver's `from` list, needs a restart, because the runner binds them at start.
- **Tests and dry runs.** `pipo test`, the builder's test run and a proposal's dry run mock the output as always: the hand-off is rendered and recorded, and nothing is sent. Test each pipeline with fixtures that look like what the other end produces.
- **Fan-out.** Each fan-out copy that reaches a `to: pipeline` output becomes its own packet downstream, because each copy has its own key.

## See also

- [Inputs](inputs.md) and [Outputs](outputs.md)
- [Delivery checks](delivery.md)
- The spec: [§3.14 Chains](../spec.md#314-chains-one-pipeline-feeding-another)
