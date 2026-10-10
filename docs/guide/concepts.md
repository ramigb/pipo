# Core concepts

This page explains the model behind every Pipo pipeline: packets and their states, the journal, what "delivered" means, failures and the dead-letter queue, versions, and the engine and runners. The other guides build on it.

## Vocabulary

| Term | Meaning |
|---|---|
| **Pipeline** | A named, versioned graph defined in a `.pipo` file: one or more inputs, any number of nodes, exactly one output, and an optional delivery check. |
| **Packet** | One unit of data moving through a pipeline. It gets a [ULID](https://github.com/ulid/spec) `packet_id` when it's accepted and is pinned to the pipeline version that accepted it. |
| **Input** | Where packets come from: a webhook, a schedule, file changes, `pipo push`, OS samples, a Telegram bot, or another pipeline. |
| **Node** | A step in the graph. Its kind (`tap`, `transform`, `filter`, `route` or `agent`) says what it may do to the data. |
| **Output** | Where a packet is written. Every pipeline has exactly one. |
| **Delivery** | A packet is **delivered** when the output reports a successful write *and* the `delivered` check passes. Delivered means done. |
| **Journal** | The pipeline's durable SQLite log. It records every packet's state changes, its data at each step, its version, its errors and the dead-letter queue. |
| **Dead-letter queue (DLQ)** | Packets that failed for good. They stay in the journal, where you can inspect them, replay them or purge them. |
| **Chain** | Pipelines feeding each other: one pipeline's output is another's input, handed over exactly once. See [Chains](chains.md). |
| **Runner** | The process that runs one pipeline. One runner per pipeline. |
| **Engine** | The control plane (`pipod`) that supervises runners and serves the APIs and dashboard. |

## A packet's life

```text
received ──► rejected                      (input validation failed; terminal)
    │
    ▼
accepted ──► processing(node…) ──► writing ──► verifying ──► delivered   (terminal ✓)
                 │                    │            │
                 ├──► filtered        │            │                      (terminal, counted as success)
                 └────────────────────┴────────────┴──► dead_lettered     (terminal ✗)
```

1. **Received.** An input gets an event: an HTTP request, a schedule tick, a file change.
2. **Accepted or rejected.** The input checks the data: its `schema` (a JSON Schema file), then its `validate` rules. A packet that fails is **rejected**. It is journaled with the rule that failed, so you can see it, but it never enters the graph. A packet that passes is **accepted**: it is written to the journal *before* the input acknowledges it. An HTTP sender gets `202 {"packet_id": …}` only once the packet is safe on disk.
3. **Processing.** The packet flows through the nodes. Each node's result is committed to the journal, data and event in one transaction, before the next node runs.
4. **Filtered.** A `filter` node that says no, or a `route` with no matching branch, ends the packet as **filtered**. That counts as success: the pipeline decided not to deliver it.
5. **Writing.** The output connector writes the packet: inserts a row, appends a line, sends a request.
6. **Verifying.** The `delivered` check confirms the write at the destination: the row exists, the line is in the file, a follow-up request succeeds. The default check, `ack`, trusts the connector's own success report.
7. **Delivered** or **dead-lettered.** A packet that passes is delivered. A packet whose step, write or check keeps failing after its retries ends up in the dead-letter queue, unless its error policy says otherwise.

Two more states can appear on the way:

- **Escalated.** A packet handed to an agent (`then: agent`) waits where it stopped, across restarts, until it's resolved: retried from that step, dead-lettered or dropped. It counts as pending. See [Agents as operators](agent-operators.md).
- **Branched.** A packet that fanned out into copies waits until every copy settles. See [fan-out](nodes.md#fan-out).

`pipo inspect <pipeline> <packet_id>` shows a packet's whole trail: every state, the data after each step, timings, attempts and errors.

## A pipeline's life

```text
stopped ─► starting ─► active ◄─► paused
                         │
                         ├─► draining ─► completed   (lifetime reached, or stop requested)
                         ├─► jammed                  (stall detected; still running, flagged)
                         └─► failed                  (an error policy chose `halt`)
```

- **Active**: accepting and processing packets.
- **Paused**: still **accepting** packets into the journal, but not processing them. When `buffer.max` packets are waiting, inputs push back: HTTP answers `503` with `Retry-After`. On resume, the backlog is processed. Every pause records why: `manual`, `agent`, `error`, `stall` or `budget`.
- **Draining**: no new packets; packets in flight finish (bounded by `drain_timeout`), then the pipeline stops. `pipo stop` drains unless you pass `--now`.
- **Completed**: the pipeline reached its `lifetime` (a TTL, a packet count or a condition) and drained.
- **Jammed**: no packet has been delivered for `delivered.stall.after` while packets are pending. It keeps running but is flagged, and can pause or call an agent. See [Delivery checks](delivery.md).
- **Failed**: an error policy chose `then: halt`.

## The journal

Each pipeline has its own journal: a SQLite database in write-ahead-log mode at `<home>/pipelines/<name>/journal.db`. It is the source of truth for everything that happened:

- every packet, with its current state, the node it's at, its version, attempts and last error;
- an event for every state change, with the data each step produced;
- the dead-letter queue;
- every version of the pipeline definition, with who made it and why;
- durable input state, such as a watch input's folder snapshot or a Telegram bot's update offset.

Three rules make crashes safe:

1. **A packet is journaled before its input is acknowledged.** Once a sender has an answer, the packet survives a crash.
2. **Each step commits exactly one transition before the next step runs.** After a crash, a packet resumes from its last committed step, with the data it had there.
3. **Packets stay pinned to their version.** See [Versions](#versions-and-pinning).

Because reads come from the journal, `pipo packets`, `pipo inspect`, `pipo dlq`, `pipo history` and `pipo diff` also work on a stopped pipeline.

Old data is cleaned up by [`retention`](lifetime.md): by default, payloads of delivered packets are kept for 7 days and the event trail for 30. Dead letters stay until you replay or purge them.

## At-least-once delivery

Pipo guarantees **at-least-once** delivery, not exactly-once.

- If the runner crashes after a step ran but before its result was committed, that step runs again on restart. A `tap` that calls an API may call it twice.
- **Outputs are idempotent on a key**, so a repeated write doesn't create a duplicate. The key is `meta.packet_id` by default (`packet_id:<branch>` for a fan-out copy):
  - `sqlite` ignores or updates a row whose key already exists;
  - `file` (`jsonl`) skips a line for a `packet_id` it already wrote;
  - `http` sends an `Idempotency-Key` header, which the receiving service must honour;
  - `pipeline` (a chain) is deduplicated by the receiving pipeline, so each packet is handed over exactly once.
- Taps get their own keys too: an `http` tap sends `Idempotency-Key: <packet_id>:<node>`, and a `file` tap skips a repeat of the same packet and node.
- `concurrency: 1` processes packets one at a time, in order. Above 1 (the default is 4), packets may complete out of order.

> [!TIP]
> Design side effects to be safe to repeat. Name files after the packet (`${meta.packet_id}`), use upserts, and pass the idempotency key to APIs that accept one.

## Failures, retries and the DLQ

Every step that can fail has an **error policy** with the same shape: how many times to retry, how to back off, and what to do once retries run out (`then`):

| `then` | Effect |
|---|---|
| `dead_letter` (default) | Move the packet to the DLQ. |
| `drop` | Discard it and count it as filtered. |
| `continue` | Ignore the failure and pass the data on (taps only). |
| `pause` | Pause the pipeline; the packet waits. |
| `halt` | Fail the pipeline. |
| `agent` | Hand the packet to an agent and wait. |

Validation failures (`on_invalid`) are never retried, since the same data would fail the same way. See [Error policies](errors.md).

A dead-lettered packet keeps its data and the step it failed at. Once you've fixed the cause, `pipo dlq replay <pipeline>` resumes it **at the step it failed on**, not from the start. `pipo rerun` runs already-delivered packets again from a chosen node. See [Recovering packets](recovery.md).

## Versions and pinning

A pipeline is versioned. Each start with a changed file, each live change (a proposal from a person or an agent) and each rollback creates a new version, stored in the journal with the full definition, its compiled form, the content hashes of its `fn` module and schema files, who made it and why.

- **A packet finishes on the version that accepted it.** A new version applies only to newly accepted packets. Packets in flight keep running the old definition, with the old function code, even if the files on disk changed.
- `pipo history <pipeline>` lists versions and how many packets are still pinned to each. `pipo diff` compares two. `pipo rollback` runs an earlier definition again as a new version.
- Every packet records its version, so any result can be traced to the exact definition that produced it.

See [Versions and rollback](versions.md) and [Live changes and proposals](change-protocol.md).

## Runners and the engine

```text
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

- **One runner per pipeline.** A runner is a small Rust process (about 9 MB of memory when idle). It owns its pipeline's journal, inputs, schedules, lifetime, stall detection and connectors. A crash in one pipeline doesn't affect another.
- **TypeScript checks, Rust executes.** When a runner starts, or a new version is applied, it runs `pipo compile`, the same checker as `pipo check`, and refuses to run a definition with errors. The compiled form is stored with the version.
- **The engine supervises.** It restarts crashed runners with backoff, serves the HTTP gateway (`/in/<pipeline>/…`), the REST API, the event stream, the MCP endpoint for agents and the dashboard. It binds to `127.0.0.1` only.
- **The engine is optional for development.** `pipo run` runs one pipeline in the foreground without it.
- **Detached runners outlive the engine.** With `pipo start --detached`, a runner keeps working when the engine stops or crashes. The next engine reattaches to it and catches up from its journal.
- **The engine sleeps when idle.** When nothing is running and nothing is pending, it exits after `engine.idle` (5 minutes by default). The next `pipo` command starts it again.

Runtime state lives in the Pipo home (`~/.pipo`). See [Running pipelines](running.md) and [The engine](engine.md).

## Humans and agents

Agents take part in four ways, all through documented interfaces:

1. **Author**: write `.pipo` files with the JSON Schema, `pipo check` and `pipo test`.
2. **Operator**: watch, pause, resume, replay and push packets through the MCP endpoint, REST or the CLI.
3. **Editor**: propose changes to a running pipeline, limited to the paths its `agent.edit` policy allows, validated and optionally dry-run before they apply.
4. **Node**: run inside the graph as an `agent:` node, with a required output schema, a timeout and a budget.

See [Agent nodes](agent-nodes.md), [Agents as operators](agent-operators.md) and [Live changes and proposals](change-protocol.md).
