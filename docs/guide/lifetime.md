# Lifetime, concurrency and retention

A pipeline runs until it's stopped, unless you give it a lifetime. These top-level keys control how long it runs, how many packets it works on at once, how much it may buffer, and how long the journal keeps what happened.

```yaml
pipo: 1
name: backfill
lifetime:
  ttl: 2h                       # end two hours after the start
  max_packets: 50000            # or after 50,000 accepted packets
  until: stats.pending == 0 && stats.delivered >= 50000
  on_end: drain
  drain_timeout: 5m
concurrency: 8
buffer: { max: 20000 }
retention:
  data: 1d
  trail: 7d
input:
  via: push
output:
  from: input
  to: file
  with: { path: ./out/backfill.jsonl }
```

## `lifetime`

| Field | Meaning |
|---|---|
| `ttl` | Wall-clock lifetime, counted from the start (see [the TTL anchor](#the-ttl-anchor)). |
| `max_packets` | Stop accepting after this many accepted packets. Rejected packets don't count. |
| `until` | An [expression](expressions.md) over `stats` and `env`. The pipeline ends when it becomes true. |
| `on_end` | `drain` (default): stop intake, finish in-flight packets, then stop. `stop`: stop at once. |
| `drain_timeout` | How long a drain may take (default `2m`). Packets still pending then stay in the journal. |

With no `lifetime`, the pipeline runs until you stop it. When a limit is reached, the runner stops intake, then drains or stops, as `on_end` says, and the pipeline ends as `completed`. Reaching any of them journals a `pipeline.lifetime` event whose `reason` is `ttl`, `max_packets` or `until`, and logs it (`lifetime ttl 2h reached; draining`).

**Refused packets.** Once intake has stopped, new packets are refused as `unavailable`. An http input answers `503`, and for `max_packets` and `until` the message names the limit. A `pipo push` gets the same answer.

**`until`** is evaluated at the start, after every accepted packet, after every packet that settles, and once a second (so a condition on `stats.uptime` works). `stats` holds `accepted`, `delivered`, `pending`, `escalated`, `dead_lettered`, `uptime` (whole seconds since this run started), `in_per_min` and `last_delivery_at`. The counts come from the journal, so they survive restarts, except `uptime`, which restarts with the runner. An `until` that fails to evaluate at run time is logged once and ignored: the pipeline keeps running.

```yaml
until: stats.delivered >= 1000                     # a fixed amount of work
until: stats.uptime > 600 && stats.pending == 0    # ten minutes, then finish what's left
until: stats.dead_lettered > 50                    # give up when too much fails
```

### The TTL anchor

A `ttl` counts from the first start since the pipeline last ended cleanly:

- A deliberate `pipo stop`, `pipo restart`, a completed lifetime or a halt resets it. The next start begins a new lifetime.
- A crash, a crash restart by the engine, a reattach, or a new version does **not** reset it. After a crash restart, the runner arms only the time that's left, and ends at once if the time is already up. A crashing pipeline can't outlive its TTL.

### `--ttl` for one start

```sh
pipo start nightly-import --ttl 30m
pipo restart nightly-import --ttl 1h
```

`--ttl` replaces `lifetime.ttl` for that start only. It counts from the same anchor, is kept in the runner registry (so crash restarts and reattaches keep it), and `on_end` and `drain_timeout` still come from the file. A later start without `--ttl` uses the file's `ttl` again.

### Engine TTL

The engine has its own lifetime too (`pipo engine start --ttl 8h`, or `engine.ttl` in `config.yaml`). When it ends, every pipeline the engine runs drains, and the engine stops. Detached runners keep running and end on their own lifetime. See [The engine](engine.md).

## Concurrency and ordering

```yaml
concurrency: 4     # default
```

`concurrency` is how many packets the pipeline processes at once. Each worker takes one packet through its next step, so a slow step (a model call, an API with latency) doesn't hold up the others.

- `concurrency: 1` gives **FIFO order**: packets are processed and delivered in the order they were accepted.
- Above 1, packets may finish out of order.
- Agent budget caps are checked before each call, so with higher concurrency more calls can be in flight when a cap is reached. See [Agent nodes](agent-nodes.md).
- `concurrency` is bound at start: changing it needs a restart, not a live apply.

## `buffer.max` and backpressure

```yaml
buffer: { max: 10000 }   # default
```

`buffer.max` caps how many accepted packets may be pending at once: in flight, held by a pause, waiting in a batch, waiting on fan-out copies, or escalated to an agent. When the buffer is full, each input pushes back in its own way:

| Input | When the buffer is full |
|---|---|
| `http` | Answers `503` with `Retry-After` |
| `telegram`, `watch` | Wait and try again; nothing is lost |
| `schedule` | Skips the tick |
| `system` | Skips the sample |
| `push`, `pipeline` | Answer `unavailable` (a `to: pipeline` sender retries under its `on_error`) |

All inputs of a pipeline share one buffer.

## Pausing

A paused pipeline stops processing, but keeps **accepting** packets into the journal, up to `buffer.max`. Nothing is dropped while you look at a problem.

```sh
pipo pause people-intake
pipo resume people-intake     # works through the backlog at full concurrency
```

Every pause records why it happened:

| Reason | Cause |
|---|---|
| `manual` | `pipo pause`, the dashboard or the API |
| `agent` | An agent, through MCP |
| `error at <step>` | An error policy with `then: pause` |
| `stall` | `delivered.stall.then: pause` |
| `budget` | An agent budget's daily cap; it resumes by itself when the next budget day starts |

A pause outlives a crash: a runner that restarts finds the pause in its journal and comes back paused, with the same reason. A clean stop ends a pause. Pause, stop and drain flush a partial [output batch](outputs.md#batching) right away.

## Draining and stopping

- `pipo stop <name>` **drains**: intake stops, in-flight packets reach a terminal state (bounded by `drain_timeout`), then the runner exits.
- `pipo stop <name> --now` stops at once. In-flight packets stay in the journal and resume from their last committed step on the next start.

Escalated packets don't hold up a drain: they wait in the journal for whoever resolves them.

## `retention`

The journal keeps every packet's data and trail. `retention` decides for how long.

```yaml
retention:
  data: 7d          # payloads of delivered and filtered packets
  trail: 30d        # packet metadata and the event trail (states, timings, errors)
  rejected: 3d      # payloads of rejected input
  dlq: forever      # dead letters: a duration, or forever
```

These are also the defaults.

- **`data`** clears the payloads of settled packets (`data` and the write's result). The packet and its trail stay, so `pipo packets` and `pipo inspect` still show what happened, without the data. A packet whose data was cleared can't be [rerun](recovery.md).
- **`trail`** deletes settled packets and their events entirely.
- **`rejected`** clears the payloads of rejected packets.
- **`dlq`** keeps dead letters until they're replayed or purged (`pipo dlq purge`). A duration deletes them after that long.

Clean-up runs at start and every 10 minutes, in small batches, so a large journal is cleaned gradually. Packets that are still pending, fan-out parents waiting for their copies, pipeline-level events and the version history are never removed. Once a day at most, the journal is also compacted (a WAL checkpoint and `VACUUM`) to give the space back.

> [!TIP]
> Payloads are usually what makes a journal large. A high-volume pipeline with big payloads can keep a short `data` (`1d`) and a longer `trail` (`30d`): you keep a month of history and timing, and a day of data to replay or rerun from.

## See also

- [Running pipelines](running.md): start, stop, pause and resume
- [Observing pipelines](observing.md): `pipo status`, pending counts and latency
- Spec: [§3.8 lifetime](../spec.md#38-lifetime), [§3.12 retention](../spec.md#312-retention), [§7.4 time and schedules](../spec.md#74-time-and-schedules)
