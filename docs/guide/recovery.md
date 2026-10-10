# Recovering packets

Pipo never loses a packet it has accepted. A packet that fails for good lands in the **dead-letter queue** (DLQ), with its data and the error. A packet handed to an agent waits, **escalated**, until someone settles it. A packet that was delivered can be **rerun** from any node it passed. This page shows how to use each, and when.

| Situation | Tool |
|---|---|
| A packet failed for good (retries ran out, a delivery check failed) | [`pipo dlq replay`](#replaying-dead-letters) after fixing the cause |
| Dead letters you don't want | [`pipo dlq purge`](#purging-dead-letters) |
| Delivered packets need a step run again (fixed code, a changed destination) | [`pipo rerun`](#rerunning-settled-packets) |
| A packet waits for an agent (`then: agent`, `on_stall: handle`) | [`pipo resolve`](#settling-escalated-packets) |
| A packet waits for an outside confirmation (`check: external`) | [`pipo ack`](#acknowledging-external-delivery) |
| You want to send a packet in by hand | [`pipo push`](#pushing-a-packet) |

All of these need the pipeline's runner (start it first), and each takes `--json`. The dashboard has the same actions on a pipeline's **💀 DLQ** tab and in the packet inspector. Agents use the [MCP tools](agent-operators.md) of the same names.

## The dead-letter queue

A packet is dead-lettered when an error policy's `then: dead_letter` applies: a step's retries ran out, a validation rule at the output failed, a delivery check never passed within `within`, an agent's answer didn't match its schema, or a per-packet budget was spent. See [Error policies](errors.md).

```text
$ pipo dlq sender
PACKET                      FAILED AT  ATTEMPTS  VER  DEAD SINCE  ERROR
01M4KTMCZ7J7Z6Y9DTCWHJ0SSP  output            2  v1   5s ago      output.failed: POST http://127.0.0.1:59999/hook failed: … Connection refused
01M4KTMBN4QV509KGNN0P5H23R  output            2  v1   6s ago      output.failed: POST http://127.0.0.1:59999/hook failed: … Connection refused
2 of 2 dead-lettered; replay with pipo dlq replay sender <id…>|--all
```

`FAILED AT` is the step the packet stopped at, and `VER` the version it's pinned to. `pipo inspect <name> <id>` shows the full story, every attempt included:

```text
$ pipo inspect sender 01M4KTMCZ7J7Z6Y9DTCWHJ0SSP
packet 01M4KTMCZ7J7Z6Y9DTCWHJ0SSP  sender v1  dead_lettered
received 2026-10-10T21:13:48.263Z via push (cli), dead_lettered after 108ms

  21:13:48.263  input   accepted
                      data {"msg":"yo"}
  21:13:48.265  shape   done            +2ms
  21:13:48.371  output  dead-lettered   +106ms  2 attempts
                      retry 1: POST http://127.0.0.1:59999/hook failed: … Connection refused (waited 100ms)
                      error output.failed: POST http://127.0.0.1:59999/hook failed: … Connection refused
```

Dead letters are kept until you replay or purge them (`retention.dlq` defaults to `forever`). `pipo dlq` pages with `--limit` and `--after` like `pipo packets`, and works on a stopped pipeline too, from its journal.

### Replaying dead letters

```sh
pipo dlq replay <name> <id…>
pipo dlq replay <name> --all
```

A replay puts each packet back in flight **at the step it failed on**, with the data it had there, on its pinned version, with its attempts reset to 0. Steps that already succeeded don't run again.

```text
$ pipo dlq replay sender 01M4KTMCZ7J7Z6Y9DTCWHJ0SSP
replayed 1 packet(s) from the dead-letter queue of sender
  01M4KTMCZ7J7Z6Y9DTCWHJ0SSP  → output
follow them with pipo packets sender or pipo inspect sender <id>
```

- A packet that failed at the output or its delivery check resumes at the output, which writes again (idempotent on the packet's key) and checks again.
- A packet that hit a loop's `max` starts its iterations over.
- For a fan-out, only the dead-lettered copies are replayed.
- A list of ids is all or nothing. An id that isn't in the DLQ refuses the request, so repeating a replay never runs a packet twice.
- The replay is committed before the packets run, so a crash in the middle resumes them.
- The pipeline must be `active` or `paused`. A paused pipeline holds the replayed packets until you resume it.

> [!WARNING]
> A replay runs on the packet's **pinned version**, with that version's `fn` code and schemas. If the failure came from a bug in the pipeline itself, the same packet fails the same way again. Fix the destination or the data outside Pipo before you replay, or see [the second scenario](#i-fixed-a-bug-in-a-transform) for packets that need new code.

### Purging dead letters

```sh
pipo dlq purge <name> <id…>
pipo dlq purge <name> --all
```

Purge deletes the packets, their copies and their events. One `dlq.purged` event records what was purged (version, error, receive time and who did it). Nothing else is touched.

## Rerunning settled packets

```sh
pipo rerun <name> --from <node> [ids… | --last n | --since 1h | --all] [--current] [--yes]
```

A rerun puts **delivered or filtered** packets back in flight at a node they passed, with the data they had when they first reached it, and runs that node and everything after it again, down to the output. Steps before the node never run again. Use it to re-apply a step after something outside it changed: rebuild a site from its database, re-tag posts after editing an `fn` module, or send again after fixing an endpoint, without sending the input again.

It **prints a plan first** and runs nothing without `--yes`:

```text
$ pipo rerun heartbeat --from stamp --last 2
plan: rerun 2 packet(s) of heartbeat from 'stamp', each on its own version
  01M4KT8AP4M6Y3HYQHJER88KKD
  01M4KT85SWN3EJGZAYEF3JWBQQ
steps that run again:
  STEP    KIND            EFFECT
  stamp   transform: map
  output  output: file    writes again (idempotent on its key)
nothing ran yet: run it with --yes
```

The `EFFECT` column flags the steps that matter when they run again: agent nodes that **spend**, `http`, `exec` and `telegram` steps that reach **outside**, and a `file` tap or the output, which **write**.

**Which packets:**

| Selector | Packets |
|---|---|
| `<id…>` | These packets, 1 to 1000. All or nothing: if one can't rerun, nothing runs. |
| `--last n` | The newest *n* that can. |
| `--since 1h` | Received in that window. With `--last`, the newest *n* of those. |
| `--all` | Every delivered or filtered packet that passed the node. |

With `--last`, `--since` and `--all`, packets that can't rerun are skipped and listed with the reason: it never reached the node, its payload was already cleared by [retention](lifetime.md), it fanned out at or after the node (rerun from a node inside the branch instead), or its version has no such node. Pending, escalated and dead-lettered packets are never candidates: they're still moving, or `pipo dlq replay` is for them.

**Which version.** By default each packet reruns on its own pinned version, like a replay. `--current` re-pins it to the version in force, for a backfill after the pipeline or its `fn` module changed. The node must exist in that version.

**What happens.** The rerun is committed before anything runs (one `packet.rerun` event per packet), so a crash resumes it. Each packet then runs like any other: its steps, the output's write and the delivery check. Outputs are idempotent on the key: sqlite `upsert` updates the row while `insert` keeps the first write, `file` skips a `packet_id` it already has, and `http` sends the same `Idempotency-Key`. A rerun packet counts as pending until it settles again. A `to: pipeline` output hands over with the same key, so the receiving pipeline answers with the packet it already has: rerun the receiver too.

The dashboard's packet inspector has **🔁 Rerun from here** on each step of a settled packet. It shows the same plan before it runs.

## Settling escalated packets

A packet handed to the agent (`then: agent`, or a stall with `agent.on_stall: handle`) waits in state `escalated`, across restarts, until it's resolved. Without an agent, the packets simply wait. Nothing is dropped.

```sh
pipo packets ticket-triage --state escalated     # what's waiting
pipo resolve ticket-triage <id…> --action retry --reason "provider back up"
```

| `--action` | Effect |
|---|---|
| `retry` | Runs the packet again from the step it stopped at, on its pinned version. |
| `dead_letter` | Moves it to the DLQ. |
| `drop` | Discards it, counted as filtered. Not allowed at the output. |

`--reason` is kept in the journal, and `--by` names who acted (default: your OS user). The **🤖 Agent** tab of the dashboard lists what was handed over and how it was resolved. See [Agents as operators](agent-operators.md).

## Acknowledging external delivery

With `delivered.check: external`, a written packet waits in `verifying` until something outside Pipo confirms it, within `within`:

```sh
pipo ack <name> <packet_id>
```

The same is `POST /api/pipelines/<name>/ack` and the MCP tool `ack`. A fan-out copy is acknowledged by its output key, `<packet_id>:<branch>`. An ack that arrives before the packet reaches the output is kept and delivers it on arrival. Acknowledging twice is harmless. See [Delivery checks](delivery.md).

## Pushing a packet

```sh
pipo push <name> --data '{"name": "Ada", "age": 36}'
pipo push <name> --file packet.json [--source me] [--input webhook]
```

`pipo push` sends one packet into a running pipeline, through any input type, and prints its id once it's journaled. It goes through the input's `format`, `schema` and `validate`, and a rejected push says which rule failed. `meta.trigger` is `push`, and `meta.source` is `--source` (default `cli`). With several inputs, `--input` names one; it can be left out when there's only one, or exactly one `via: push` input.

Push is also handy for testing a running pipeline by hand. The dashboard's **🧪 Send a test packet** card does the same.

## After a crash

You don't need to do anything. Each packet resumes at its last committed step, on its pinned version, when the runner starts again (the engine restarts it, or you start it). Steps that were running when it crashed run again, so a tap or an `exec` step may run twice. An output write that was in flight is repeated with the same key, so it doesn't duplicate. See [Running pipelines](running.md#when-a-runner-crashes).

## Worked scenarios

### A destination was down for an hour

Your pipeline writes to an HTTP endpoint that went down. Packets retried as `output.on_error` says, then went to the DLQ.

1. See what failed: `pipo dlq <name>`. The errors all name the destination.
2. Bring the destination back, and check it answers.
3. Replay them all: `pipo dlq replay <name> --all`. Each resumes at the output and writes again with the same `Idempotency-Key`, so a write that reached the server before it went down isn't doubled (if the server honours the key).
4. Watch them settle: `pipo status <name>` and `pipo packets <name> --state dead_lettered`.

To ride out outages without dead letters next time, give the output a longer retry (`retry: 10`, `backoff: exponential`, `max_delay: 5m`), or `then: pause`, which pauses the pipeline and holds the packet until you `pipo resume`. A `delivered.stall` block tells you when nothing has been delivered for a while. See [Error policies](errors.md).

### I fixed a bug in a transform

A bug in `fn.normalize` wrote wrong values for a day. You fixed the module.

1. Restart the pipeline so the fixed module becomes a new version: `pipo restart <name>`. New packets use it.
2. Plan a rerun of yesterday's packets from the fixed node, on the new version:

   ```sh
   pipo rerun <name> --from normalize --since 24h --current
   ```

3. Read the plan. Check the skipped packets and the steps flagged `spend`, `external` or `write`.
4. Run it: add `--yes`. With an sqlite output in `upsert` mode, each row is updated in place.

Packets the bug **dead-lettered** aren't rerun candidates, and replaying them runs the old code again. Take their data from `pipo inspect <name> <id> --json`, `pipo push` it into the fixed pipeline, and purge the old dead letters once the new packets are delivered.

### A filter dropped packets it shouldn't have

Filtered packets are settled, so they can be rerun. Fix the filter's expression in the file, `pipo restart`, then `pipo rerun <name> --from <filter-node> --since 7d --current` and check the plan.

### Packets stuck waiting for an agent

`pipo status` shows pending packets, and `pipo packets <name> --state escalated` lists them. Read why with `pipo inspect`, fix the cause, then `pipo resolve <name> <ids…> --action retry`.
