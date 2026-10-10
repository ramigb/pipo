# Observing pipelines

Everything a pipeline does is journaled: every packet's state change, every step's result, every error and every pipeline event. The CLI, the dashboard, the REST API and agents all read the same journal, so they always agree.

```sh
pipo status                      # every pipeline, one line each
pipo status heartbeat            # one pipeline, with its latency per node
pipo logs heartbeat -f           # follow the runner's log
pipo packets heartbeat --state dead_lettered
pipo inspect heartbeat 01M4KT85SWN3EJGZAYEF3JWBQQ
```

Every command here takes `--json`, which is the stable format for scripts and agents. The text output is for people.

## `pipo status`

Without a name, `pipo status` prints one line per pipeline the engine knows:

```text
$ pipo status
PIPELINE        STATE    VER  UPTIME   IN/MIN  PENDING  DELIVERED  DLQ  LAST DELIVERY
people-intake   active   v3   12m04s       42        3      5,112    2  1s ago
ticket-triage   jammed   v1   2h10m         0       17        230    0  6m ago   ⚠ stalled at 'review'
```

| Column | Meaning |
|---|---|
| `STATE` | The pipeline's state: `active`, `paused`, `draining`, `jammed`, or what the engine knows of a pipeline without a runner (`stopped`, `crashed`, `failed`, …). |
| `VER` | The version in force for new packets. |
| `UPTIME` | Time since this runner started. It resets on a restart. |
| `IN/MIN` | Packets accepted in the last 60 seconds. |
| `PENDING` | Accepted packets that aren't delivered, filtered or dead-lettered yet. This includes packets held by a pause, waiting in a batch, waiting for their fan-out copies, or escalated to an agent. |
| `DELIVERED` | Delivered packets, all time. |
| `DLQ` | Packets in the dead-letter queue. |
| `LAST DELIVERY` | When the latest packet was delivered. |

A `⚠` note flags a stalled pipeline and the node its oldest packet is stuck at. A dash means the runner doesn't report that value (it isn't running, or it's older). Counts come from the journal, so they survive restarts.

With a name, `pipo status` adds the built-in metrics:

```text
$ pipo status heartbeat
PIPELINE   STATE   VER  UPTIME  IN/MIN  PENDING  DELIVERED  DLQ  LAST DELIVERY
heartbeat  active   v1     16s       3        0          3    0  1s ago

oldest pending: none
latency (last 100 steps per node):
  NODE    COUNT  P50  P95  MAX
  stamp       3  0ms  0ms  0ms
  output      3  0ms  0ms  0ms
```

- **Oldest pending** is the age and receive time of the oldest packet that isn't settled. A growing age with a steady count is the first sign of a jam. A replayed dead letter keeps its original `received_at`.
- **Latency** has one row per node of the version in force, plus `output` (the write). It covers each node's latest 100 completed steps, whatever their age. A step's latency runs from when the runner starts it to the commit of its result, retries and their waits included. Delivery checks aren't included. A step that was escalated, held or killed by a crash counts only once it completes.
- **Agent spend today** shows when the pipeline's agent nodes spent anything in its budget day, and when a `budget` pause will lift.

Under the table, `pipo status` also prints the whole home's agent spend for the day against `engine.agent_budget.per_day`, when a cap is set or anything was spent. See [Agent nodes](agent-nodes.md).

`pipo status --watch` redraws every 2 seconds until Ctrl-C.

## `pipo logs`

```sh
pipo logs <name> [-f] [--node <id>]
```

Prints the runner's log from `<home>/logs/<name>.log`, which the engine writes for every runner it starts, detached ones included. `-f` follows new lines. `--node <id>` keeps only lines that mention that node id as a whole word.

```text
2026-10-10T21:05:00.125Z ENGINE [heartbeat] starting runner
2026-10-10T21:05:02.698Z INFO  [heartbeat] started v1, input: schedule every 5.0s
```

Lines come from the runner (`DEBUG`, `INFO`, `WARN`, `ERROR`), from `tap: log` nodes, from `console.*` in `fn` modules, and from the engine about the runner (`ENGINE`). Secrets are redacted before anything is written. A pipeline run with `pipo run` logs to your terminal instead.

## `pipo packets`

```sh
pipo packets <name> [--state <s>] [--limit <n>] [--after <id>]
```

Lists packets, newest first:

```text
$ pipo packets heartbeat --limit 3
PACKET                      STATE      NODE  VER  ATT  RECEIVED  UPDATED  ERROR
01M4KT5QNWMWMH7EAR88AJ5E76  delivered  -     v1     0  3s ago    3s ago
01M4KT5JSKV6X74WNFTRZXK950  delivered  -     v1     0  8s ago    8s ago
01M4KT5DXCZSZMDJ9GNG7NB6KD  delivered  -     v1     0  13s ago   13s ago
3 of 9; next page: pipo packets heartbeat --after 01M4KT5DXCZSZMDJ9GNG7NB6KD
```

`NODE` is where an unsettled packet is, `ATT` its attempt at that step, and `ERROR` its last error. `--state` takes one of `accepted`, `processing`, `writing`, `verifying`, `delivered`, `filtered`, `dead_lettered`, `rejected`, `branched` (a packet that fanned out, waiting for its copies) and `escalated` (waiting for an agent; this lists fan-out copies too). `--limit` is 1 to 1000 (default 50). Fan-out copies aren't listed separately: inspect the packet to see them.

## `pipo inspect`

```sh
pipo inspect <name> <packet_id>
```

Traces one packet through every step: when it ran, how long it took, the data after it, its attempts and errors.

```text
$ pipo inspect heartbeat 01M4KT85SWN3EJGZAYEF3JWBQQ
packet 01M4KT85SWN3EJGZAYEF3JWBQQ  heartbeat v1  delivered
received 2026-10-10T21:07:07.708Z via schedule (2026-10-10T21:07:07.706Z), delivered after 7ms

  21:07:07.708  input      accepted
                         data {"service":"pipo-example","status":"alive"}
  21:07:07.710  stamp      done            +2ms
                         data {"service":"pipo-example","status":"alive","tick":"2026-10-10T21:07:07.706Z"}
  21:07:07.713  output     written         +3ms
  21:07:07.715  delivered  delivered       +2ms
```

The header names the packet's pinned version and state, how it arrived (`via` the trigger, with `meta.source` in brackets) and how long it took. Each line is one committed step. A failed attempt shows its error, a retry shows its attempt number, and a fan-out shows each copy's path. A rejected packet shows the rule that failed. Use it to answer "what happened to this packet, and why?".

The dashboard's packet inspector shows the same trace, with each step's changes highlighted. See [Dashboard](dashboard.md#packet-inspector).

## Events

Every packet state change and pipeline state change is an **event**, written to the journal with a sequence number. Some you'll meet:

| Event | When |
|---|---|
| `packet.accepted`, `packet.rejected` | Input validation passed or failed. |
| `node.done`, `node.failed`, `node.looped` | A step finished, failed (with its attempt) or sent the packet back. |
| `packet.fanned_out`, `packet.branched` | A node fed several nodes, and the packet waits for its copies. |
| `output.written`, `output.batched`, `output.batch_split` | The output wrote (or batched) the packet. |
| `delivery.unverified`, `delivery.awaiting_ack` | A delivery check failed, or waits for `pipo ack`. |
| `packet.delivered`, `packet.filtered`, `packet.dead_lettered` | The packet settled. |
| `packet.escalated`, `packet.resolved` | Handed to an agent, and settled again. |
| `dlq.replayed`, `dlq.purged`, `packet.rerun` | Recovery actions. |
| `pipeline.started`, `pipeline.paused`, `pipeline.resumed`, `pipeline.draining`, `pipeline.stopped`, `pipeline.completed`, `pipeline.failed` | The pipeline's lifecycle. |
| `pipeline.lifetime`, `pipeline.stall`, `pipeline.unjammed` | A lifetime limit was reached, a stall was detected or cleared. |
| `budget.warning` | Agent spend reached `agent_budget.warn_at`. |
| `version.applied` | A new version is in force. |

The engine streams them live over server-sent events at `/events` (event ids `<pipeline>:<seq>`), and `GET /api/events` pages through them. A client that reconnects with `Last-Event-ID` gets what it missed. See [REST, SSE and MCP](api.md).

## Metrics

The built-in metrics need no setup: throughput (`IN/MIN`), pending count, DLQ size, latency per node and the age of the oldest pending packet. They come from the journal, so they survive restarts and work for detached runners. You'll find them in `pipo status` (and `--json`), in `GET /api/pipelines/<name>` under `runner.stats`, and on the dashboard.

A telemetry node (a `tap: http` to your metrics service) is only needed for custom business metrics. OpenTelemetry export is planned.

The dashboard's **🧮 Tasks** page adds the CPU, memory and process count of each runner, including the agent CLIs it runs.

## Stopped pipelines

`packets`, `inspect`, `dlq`, `history` and `diff` also work on a pipeline that isn't running: the engine (or the CLI with `--no-engine`) opens its journal read-only. Payloads are redacted with the secrets the pipeline's versions declare, resolved from `env:` only (a read never prompts 1Password). If a secret can't be resolved, payloads show as `[withheld: …]` instead. Writes (`push`, `ack`, `replay`, `purge`, `rerun`) need a running runner, and say so.
