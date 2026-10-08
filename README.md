# Pipo

**Durable pipelines for humans and agents.**

Pipo is a local/self-hosted runtime for continuous pipelines. A pipeline is a plain `.pipo` YAML file: ingest events, transform them with deterministic code, installed programs or agent nodes, and track each packet through to delivered output. Incoming packets are journaled before acknowledgement, and processing resumes after a crash from the last committed node.

Humans and agents create, inspect, edit, validate, test and operate the same artifact through documented interfaces. That is what **agent-first** means here: a shared format, runtime and operating model, with explicit policies for agent access and changes.

### What a pipeline looks like

This small version of the [heartbeat example](examples/heartbeat) appends a record every five seconds, then checks that the packet's line reached the file:

```yaml
pipo: 1
name: heartbeat
input:
  via: schedule
  with: {every: 5s, payload: {status: alive}}
nodes:
  stamp:
    from: input
    transform: map
    with:
      data: {status: "${data.status}", tick: "${meta.source}"}
output:
  from: stamp
  to: file
  with: {path: ./out/heartbeat.jsonl, format: jsonl}
delivered:
  check: line_contains
  with: {value: "${meta.packet_id}"}
  within: 5s
```

```text
schedule → stamp → JSONL file → line_contains → delivered
```

The file fits Git, diffs, pull requests and CI. The visual builder loads and saves that same `.pipo` file. Delivery defaults to the output connector's acknowledgement (`ack`); an explicit `delivered` check, as above, can verify the result at the destination.

- **Get started:** [Quick start](#quick-start)
- **Website:** [`site/`](site) — static landing page and interactive explanations; [run locally](site/README.md)
- **Spec:** [`docs/spec.md`](docs/spec.md)
- **Roadmap:** [`docs/roadmap.md`](docs/roadmap.md)
- **Working on the code:** [`CLAUDE.md`](CLAUDE.md)

## Quick start

Requires [Bun](https://bun.sh) ≥ 1.3, on Linux or macOS. From a checkout of this repository:

```sh
bun install
bun pipo ui                      # starts the engine and opens the dashboard and builder
```

Or from the terminal:

```sh
bun pipo check examples
PIPO_INTAKE_TOKEN=dev-token bun pipo run examples/people-intake/people-intake.pipo --listen 8787
curl -X POST localhost:8787/in/people-intake/people \
  -H 'X-Pipo-Token: dev-token' -H 'content-type: application/json' \
  -d '{"name": " Ada ", "age": 36}'
```

`pipo run` runs one pipeline in the foreground until Ctrl-C (it drains; a second Ctrl-C stops). A pipeline that fails `pipo check` refuses to start and says why.

## Why Pipo?

- **Files are the source of truth.** One `.pipo` file describes one pipeline. Use your editor, the CLI, the builder or an agent; the definition stays readable, reviewable and versionable with normal developer tools.
- **Recovery belongs to the runtime.** Each pipeline runs in an isolated process with its own SQLite WAL journal. Packets are recorded before input acknowledgement, step results are committed before the next step runs, and in-flight packets stay pinned to the version that accepted them. Error policies, retries and the dead-letter queue handle failures without rebuilding this machinery in each pipeline.
- **Execution is not delivery.** A successful step is only part of the job. A packet reaches `delivered` after its output write and the configured delivery check pass. Checks can verify a database row, a file's contents, an HTTP follow-up or an external acknowledgement. Pipo provides **at-least-once** delivery, with idempotency keys; it does not guarantee exactly-once delivery. Repeated side effects are possible, and HTTP destinations must honour the key. See [delivery guarantees](docs/spec.md#73-delivery-guarantees).
- **Humans and agents share the operating model.** Both work with the same format, validator, tests and version mechanisms. Agents can inspect failures, operate pipelines and propose changes through the CLI, REST and MCP endpoint, within explicit access and edit policies. Agent nodes inside the graph are a separate capability, not a requirement for using Pipo.

Pipo is built for local and self-hosted developer workflows: continuous data moving through a small graph, with an inspectable trail to its destination.

## How it works

| Concept | Role |
|---|---|
| **`.pipo` file** | The named pipeline definition: one input, nodes, one output and an optional delivery check. The builder edits this file too. |
| **Packet** | One accepted unit of data, with a `packet_id` and a pinned pipeline version. |
| **Runner** | One process per pipeline, executing its graph and owning its schedules, lifetime and recovery. |
| **Journal** | The runner's durable SQLite log of packets, committed transitions, errors, versions and dead-lettered packets. |
| **Delivery** | The output connector reports a successful write and the configured check passes (`ack` by default). Rejected, filtered and dead-lettered packets have distinct terminal states. |
| **Engine (`pipod`)** | Supervises runners, exposes the HTTP gateway, REST, SSE and MCP, and serves the dashboard and builder. |
| **Agent participation** | An agent can author the file, operate the runtime, propose permitted edits, or run as a node inside the graph. |

Control can move from a human to an agent and back while the pipeline remains the shared durable object. For live changes, proposals are validated against `pipo check` and the agent's edit policy, optionally dry-run, then applied as a new version. New packets use the new version; in-flight packets finish on their pinned version. Agents cannot change `output`, `delivered`, `secrets`, `agent` or `agent_budget`, even with a wildcard edit grant. See the [change protocol](docs/spec.md#93-change-protocol-propose--validate--apply).

## Status

Phase 1 (the MVP in spec §12) is done, and Phase 2 has started: the visual builder is built, agent nodes can run through coding-agent CLIs on your machine, pipelines can talk through Telegram bots, and steps can run installed programs. Pipo runs on Linux and macOS. Working today:

- The `.pipo` language, validated by `pipo check` (P001–P058).
- The runner: durable journal, crash recovery, error policies, batching, fan-out, loops, lifetime and stall detection, retention clean-up, version pinning.
- Inputs `http`, `schedule`, `watch` (a glob, or a plain folder for every file below it), `system`, `push`, `telegram`; taps, transforms and outputs for `http`, `file`, `sqlite`, `stdout`, `telegram`; delivery checks including `external`.
- Exec steps that run a program installed on the machine, such as `ffmpeg` or `pandoc` (see [Running programs](#running-programs)).
- Telegram bots as an input, a tap and an output (see [Telegram bots](#telegram-bots)).
- Agent nodes, through the Anthropic API or a local CLI (see [Agents](#agents)), with schemas, timeouts and `agent_budget` (per packet, per day, and engine-wide).
- The MCP endpoint `/mcp` and the change protocol for agents (proposals, validation, dry run, apply as a new version).
- The engine (`pipod`): supervisor, gateway, SSE events, detached runners and reattach, per-node latency and oldest-pending metrics, and CPU and memory per pipeline.
- The CLI (including `pipo test` and `pipo proposals`), the dashboard with its drag-and-drop builder, and the VS Code extension.

Still to come in Phase 2: more connectors (`postgres`, `mqtt`, `s3`, queues), join and window nodes, multiple outputs, a connector SDK and template registry, distributed sub-engines, OpenTelemetry export, `fn` sandboxing and a language server. See the [roadmap](docs/roadmap.md).

## Running through the engine

```sh
bun pipo engine start --listen 8787          # optional: other commands start it on demand
bun pipo start examples/people-intake/people-intake.pipo
bun pipo start examples/heartbeat/heartbeat.pipo --detached
bun pipo status --watch
bun pipo engine stop                         # detached runners keep running
```

A detached runner keeps running when the engine dies; the next engine (or `pipo attach`) reattaches it. Pass `--no-engine` to talk to runners directly.

## Dashboard and builder

`bun pipo ui` starts the engine if needed, then prints the dashboard's URL and opens it (`--no-open` to only print). The engine serves it at `/ui` (`packages/ui`, static files, no build step).

- **Dashboard:** the pipeline list with stats (pipelines in the workspace that aren't running are listed under 🧰 Ready to run, with a ▶️ Run button), a live graph where packets travel along the edges, a packet inspector that shows what each step changed, a log tail, the agent feed, the dead-letter queue with replay, version history with diffs, and pause, resume, drain, stop, restart and start controls. Each pipeline's page has a 🧪 card to send it a test packet and an ✏️ Edit button that opens it in the builder.
- **🧮 Tasks** (`#/top`): a task manager with every pipeline's state, runner pid, CPU, memory, process count, throughput and pending count, refreshed every 2 s, with the controls on each row.
- **🤖 Bots** (`#/bots`): add, edit, test and remove Telegram bots, and pick the default one.
- **⚙️ Settings** (`#/settings`): the workspace, the folder the builder saves new pipelines in. Walk folders or type a path. The choice applies at once and is saved as `engine.workspace` in `config.yaml`.
- **Builder** (`#/build`): drag blocks from a palette onto a canvas, wire them port to port, and fill them in with forms generated from each connector's schema. `pipo check` runs live, with badges on the blocks and one-click fixes for some problems. 🧪 Test dry-runs the draft against sample packets (nothing is called or written). Save writes the `.pipo` file and keeps its comments; Save & run starts it too.
- When the engine is down, the dashboard says how to wake it and reconnects by itself. When the engine is older than the code on disk, it offers to restart it.

## Agents

An agent node sends its rendered prompt to a model and gets back structured output that must match the node's JSON Schema. Pick the provider with `agent:`:

| `agent:` | Runs | Needs |
|---|---|---|
| `claude_api` | The Anthropic Messages API | An API key (`env:ANTHROPIC_API_KEY` by default, or an `op://…` reference in `config.yaml`) and a price for the model |
| `claude_code` | Your local Claude Code CLI (`claude`) | Installed and logged in |
| `codex` | Your local Codex CLI (`codex`) | Installed and logged in |
| `pi` | Your local pi CLI | Installed, with a model set up |
| `opencode` | Your local opencode CLI | Installed, with a model set up |

CLI agents run as you, on your own account. Each call runs in a fresh, empty folder with the CLI's tools off; `with.cwd` and `with.allow_tools` change that. A pipeline whose agent can't run on this machine refuses to start and says what to do (for example "run `codex login`"). In the builder, agents are grouped under 🤖 Agents. One that isn't set up is greyed out with the reason, and the model field suggests the models each provider offers. Details are in spec §3.4 and D67.

## Telegram bots

Add a bot once on the dashboard's 🤖 Bots page: its token from @BotFather (or an `op://…` / `env:…` reference) and an `allow` list of chat or user ids. Bots are kept in `<home>/bots.json` (mode 0600). Then:

```yaml
input:
  via: telegram             # messages to the default bot
output:
  from: input
  to: telegram              # no chat_id: replies to the chat the message came from
  with: { text: "You said: ${data.text}" }
```

The input long-polls only while the pipeline runs and turns allow-listed messages into packets, downloading any attached file. `tap: telegram` sends mid-pipeline. Each step can pick a bot with `with.bot` or `with.token`. Only one pipeline may poll a bot at a time. Details are in spec §3.13 and D69.

## Running programs

`tap: exec` and `transform: exec` run a program installed on the machine, as you, with no shell:

```yaml
render:
  from: input               # a watch input with read: path
  transform: exec
  with:
    command: ffmpeg
    args: [-y, -loop, "1", -i, ./cover.jpg, -i, "${data.path}", -shortest, "./out/${data.name}.mp4"]
    outputs: ["./out/${data.name}.mp4"]
    timeout: 10m
```

Each item in `args` goes to the program as one argument. `outputs` lists files the program must write, and `result` (`info`, `text` or `json`) decides what a transform's data becomes. A missing program refuses the start. Exec nodes in a file scaffolded from a template outside your project need `pipo trust`, like `fn` modules. Details are in spec §3.4 and D71.

## CLI

Run `bun pipo help <command>` for details. Every command except `run` (which streams logs to the terminal) takes `--json`.

| Area | Commands |
|---|---|
| Authoring | `check`, `fmt`, `test`, `schema`, `new`, `generate node`, `templates`, `trust` |
| Run | `run` (foreground), `start`, `stop`, `pause`, `resume`, `restart` |
| Observe | `status`, `logs`, `runners`, `packets`, `inspect` |
| Recover | `dlq` (`replay`, `purge`), `push`, `ack`, `attach` |
| Versions | `history`, `diff`, `rollback` |
| Engine and UI | `engine start\|stop\|status`, `ui` |
| Agents | `proposals` (`show`, `propose`, `apply`, `reject`), `resolve` |

## Examples

| Example | What it does |
|---|---|
| [`people-intake`](examples/people-intake) | Accepts people from a token-protected webhook, validates and normalises them, stores them in SQLite |
| [`heartbeat`](examples/heartbeat) | Every few seconds, appends a heartbeat to a JSONL file and checks it landed |
| [`inbox-forward`](examples/inbox-forward) | Forwards each new text file in a folder to an HTTP endpoint |
| [`ticket-triage`](examples/ticket-triage) | Classifies support tickets with an agent within a budget; runs against a mock Claude API, no key needed |
| [`telegram-echo`](examples/telegram-echo) | Answers every message the default Telegram bot gets, and logs who wrote what |
| [`audio-to-video`](examples/audio-to-video) | Turns each `.mp3` dropped in a folder into an `.mp4` with a cover image, using `ffmpeg` |

## VS Code

`packages/vscode` registers `.pipo`, attaches the JSON Schema and highlights `${…}` templates. See its [README](packages/vscode/README.md) to install.

## Layout

| Path | What |
|---|---|
| `packages/spec` | The language: schema, manifests, expressions, `pipo check` |
| `packages/runner` | One pipeline per process, the journal, connectors, agent providers |
| `packages/engine` | `pipod`: supervisor, gateway, registry, the builder, bots and settings APIs |
| `packages/cli` | The `pipo` command |
| `packages/ui` | The dashboard and the builder |
| `packages/vscode` | The editor extension |
| `examples/` | Runnable pipelines |
| `site/` | Static website: explanations, demos and quick start; no build step |

## License

Copyright (c) 2026 Rami GB

[GNU Affero General Public License v3.0 (AGPL-3.0-only)](LICENSE)
