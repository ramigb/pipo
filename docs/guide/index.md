# Pipo documentation

Pipo is a local, self-hosted runtime for **continuous pipelines**. You describe a pipeline in a `.pipo` file. Pipo keeps it running and turns every incoming event into a **delivered**, verified result.

A pipeline has no "done" state, only delivery. Events come in from outside (webhooks, schedules, file changes, chat messages, operating system samples), from inside (the CLI, the dashboard, an agent) or from another pipeline. They pass through a small graph of nodes and are written to one destination: a SQLite table, a file, an HTTP endpoint, a Telegram chat or another pipeline. A packet counts as finished only when Pipo can show it arrived.

```yaml
pipo: 1
name: heartbeat
input:
  via: schedule
  with: { every: 5s, payload: { status: alive } }
nodes:
  stamp:
    from: input
    transform: map
    with:
      data: { status: "${data.status}", tick: "${meta.source}" }
output:
  from: stamp
  to: file
  with: { path: ./out/heartbeat.jsonl, format: jsonl }
delivered:
  check: line_contains
  with: { value: "${meta.packet_id}" }
  within: 5s
```

```text
schedule → stamp → JSONL file → line_contains → delivered
```

Every five seconds this pipeline makes a packet and reshapes it. It appends the packet to a file, then checks that the packet's line is really in the file. If the check fails, the packet is retried or dead-lettered. It is never quietly lost.

## The four parts

| Part | What it does |
|---|---|
| **The `.pipo` file** | One YAML file describes one pipeline. It is the source of truth: readable, diffable and reviewable like any code. |
| **Runner** (`pipo-runner`) | The data plane, a small Rust binary. Each pipeline runs in its own process, with its own durable SQLite journal. |
| **Engine** (`pipod`) | The control plane. It supervises runners, serves the HTTP gateway, a REST API, an event stream, an MCP endpoint for agents, and the dashboard. |
| **CLI** (`pipo`) | Creates, checks, tests, runs, controls and inspects pipelines. Every command has `--json` output for scripts and agents. |

The dashboard and its drag-and-drop builder are served by the engine. They read and write the same `.pipo` files.

## Why Pipo

- **Simple.** It's built for personal and small-team pipelines. One file is one pipeline, and nothing is hidden in a database.
- **Resilient.** Every pipeline is an isolated process with its own journal. A packet is written to the journal before its input is acknowledged, and each step's result is committed before the next step runs. After a crash, work resumes from the last committed step.
- **Delivery-oriented.** "The code ran" is not success. A packet is delivered when the output reports a successful write *and* the configured delivery check passes.
- **Agent-first.** An agent can write a pipeline, run it, step in while it's running and step out again, through the same documented interfaces a person uses: the file format, the CLI, REST and MCP. Agent access and edits are limited by explicit policies.

## What Pipo isn't

- **Not a workflow or approval tool.** There are no human-approval steps or BPM-style processes.
- **Not multi-tenant or hosted.** It runs on your machine or your own server. It binds to `127.0.0.1` by default.
- **Not exactly-once.** Pipo guarantees **at-least-once** delivery, plus idempotency keys at the output. A side effect in the middle of a pipeline can run twice after a crash. See [Core concepts](concepts.md#at-least-once-delivery).
- **Agents don't change engine code.** They change `.pipo` files through a validated, audited protocol.

Pipo runs on Linux and macOS.

## Where to go next

| If you want to… | Read |
|---|---|
| Install Pipo and get the `pipo` command | [Install](install.md) |
| Build and run a first pipeline in ten minutes | [Quick start](quick-start.md) |
| Understand packets, delivery, the journal and versions | [Core concepts](concepts.md) |
| Write pipelines | [The .pipo file](pipo-file.md), [Inputs](inputs.md), [Nodes and the graph](nodes.md), [Outputs](outputs.md), [Delivery checks](delivery.md), [Expressions and templates](expressions.md) |
| Add code or programs | [User functions](functions.md), [Running programs](exec.md) |
| Handle failures | [Error policies](errors.md), [Recovering packets](recovery.md) |
| Use AI agents | [Agent nodes](agent-nodes.md), [Agents as operators](agent-operators.md), [Live changes and proposals](change-protocol.md) |
| Run pipelines for real | [Running pipelines](running.md), [The engine](engine.md), [Observing pipelines](observing.md) |
| Work visually | [Dashboard](dashboard.md), [Builder](builder.md) |
| Test and scaffold | [Testing](testing.md), [Templates and generators](scaffolding.md), [Editor support](editor.md) |
| Look something up | [CLI](../reference/cli.md), [Connectors](../reference/connectors.md), [Diagnostics](../reference/diagnostics.md), [Configuration](configuration.md), [REST, SSE and MCP](api.md) |
| See complete pipelines | [Examples](../reference/examples.md) |

The [specification](../spec.md) is the full, precise definition of the format and the runtime. These guides explain the same rules with more examples.
