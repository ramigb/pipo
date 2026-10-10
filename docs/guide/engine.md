# The engine

The engine, `pipod`, is Pipo's control plane. It starts and supervises runners, serves the HTTP gateway, the REST API, the event stream, the agent endpoint and the dashboard, and keeps the engine's own clocks. It doesn't process packets. That's the runners' job, one process per pipeline.

You rarely start the engine yourself: every `pipo` command that needs it starts it on demand, and it goes to sleep when there's nothing to do.

```sh
pipo engine start --listen 8787   # optional: start it now, with a fixed gateway port
pipo engine status
pipo start examples/heartbeat/heartbeat.pipo
pipo engine stop                  # drains its pipelines; detached runners keep running
```

## Architecture

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

- **The engine** is written in TypeScript and runs on Bun.
- **Each runner** is a small Rust binary (`pipo-runner`, about 9 MB resident when idle). It owns its pipeline's journal, inputs, schedules, lifetime, stall detection and connectors. A crashing runner affects only its own pipeline, and a crashing engine affects no runner.
- **They talk over a unix socket**, `<home>/run/<name>.sock` (owner-only), with newline-delimited JSON requests and responses. Every response is redacted. The CLI uses the same socket when the engine is down (`--no-engine`).

### TypeScript checks, Rust executes

The checker is written once, in TypeScript. When a runner starts, applies a change or rolls back, it runs `pipo compile`, which checks the file exactly as `pipo check` does and returns its compiled form as JSON: the definition, the bundled `fn` module, the parsed schema files, file hashes and agent settings. The runner refuses on any error. Each version stores its compiled form in the journal, so a packet pinned to an older version runs that version's code without reading files again. Bun runs only during a compile, never while packets flow.

`pipo compile <file>` is available as an advanced command. You don't need it day to day.

## Starting and stopping the engine

| Command | Effect |
|---|---|
| `pipo engine start [--ttl 8h] [--listen <port>]` | Starts `pipod` in the background. With an engine already running, says `already running` and changes nothing. |
| `pipo engine status` | Pid, gateway address, uptime, number of pipelines, whether it's idle and its TTL. Prints `engine: down` when none runs. |
| `pipo engine stop` | Graceful shutdown: pipelines drain, detached runners keep running. |
| `pipo ui` | Starts the engine if needed, then opens the dashboard. See [Dashboard](dashboard.md). |

```text
$ pipo engine status
engine: up (ready)
pid 8485 · gateway 127.0.0.1:41985 · uptime 24s
pipelines 1 · idle no · ttl none
```

When the CLI starts the engine on demand, the gateway gets a free port (`--listen 0`) unless `engine.listen` is set in `config.yaml`. The port is recorded in `<home>/run/engine.json`, which is how the CLI and other tools find the engine. Only one engine runs per Pipo home: a second one refuses to start.

`pipod` itself takes `--home`, `--listen`, `--ttl` and `--workspace` (the folder the builder saves new pipelines in). You normally use it through `pipo engine start` or `pipo ui`.

## Engine lifetime

The engine runs while it has work, and sleeps otherwise:

- **Busy** means a pipeline it supervises is starting, running (active, paused, draining or jammed), waiting to restart, stopping or unreachable, or a scan is under way. Detached runners it supervises count as busy, so pending packets always have a runner.
- **Idle sleep.** After `engine.idle` (default `5m`) with nothing to do, the engine shuts down and exits. The next `pipo` command starts it again. Every `/api` and `/events` request restarts the idle clock, and an open event stream (an open dashboard tab, say) keeps the engine awake until it closes. Traffic on `/in` doesn't count.
- **Engine TTL.** With `pipo engine start --ttl 8h`, `pipod --ttl 8h` or `engine.ttl`, the engine drains every pipeline and stops when the time is up. Detached runners keep running and end on their own lifetime.

Stopped, failed and crashed pipelines have no runner, so they don't keep the engine awake. Their leftover packets stay in the journal and resume on their next start.

## The gateway

With a gateway port, the engine serves one HTTP server on `127.0.0.1`:

| Path | What |
|---|---|
| `/in/<pipeline><path>` | Forwarded to the pipeline's http input on its runner's own port, unchanged (method, path, query, body and headers, plus `X-Forwarded-*`). The runner's reply comes back as it is. |
| `/api/*` | The REST API (JSON). See [REST, SSE and MCP](api.md). |
| `/events` | Server-sent events: every journal event, live, with replay after `Last-Event-ID`. |
| `/mcp` | The agent endpoint (MCP). See [Agents as operators](agent-operators.md). |
| `/ui` | The dashboard and builder. |

The gateway doesn't retry anything. An unknown pipeline, or one without an http input, is `404`. A pipeline that isn't running is `503` (with `Retry-After` while it starts or waits to restart). A failure after the request was sent is `502`, with a hint that the packet may have been accepted.

`/api` and `/events` only answer requests whose `Host` is a loopback name, and every API `POST` must be JSON. So a web page you visit can't drive your engine. `/in` has no such limit, because inputs have their own auth (a token header or an HMAC signature, see [Inputs](inputs.md)).

## Supervision and restarts

The engine starts each runner, waits until it answers its handshake (up to `engine.start_timeout`, default `30s`), and watches it:

- **Exit 0** (asked to stop, lifetime ended) means `stopped`. **Exit 2** (an error policy chose `halt`) means `failed`. Neither restarts.
- **Any other exit, or a signal**, is a crash. The runner restarts after `backoff` (`1s`), doubling up to `max_backoff` (`30s`), and back to `backoff` after a run of at least `stable` (`1m`).
- **After `max_restarts` (5) crashes within `window` (`10m`)**, the pipeline is `crashed`, with an error naming the last exit and a hint to fix the cause and start it again. Its in-flight packets stay in the journal.
- **Stop** drains and waits up to `drain_timeout` plus `stop_timeout` (`15s`); `stop --now` waits up to `stop_timeout`. Then the runner is killed, and its journal resumes on the next start.

All of these live under `engine.restart`, `engine.start_timeout` and `engine.stop_timeout` in `config.yaml`. See [Configuration](configuration.md).

## Discovery and reattach

Each runner writes a **registry entry**, `<home>/run/<name>.json`, once its control socket listens, and removes it on a clean stop:

```json
{ "pipeline": "people-intake", "version": 3, "pid": 41822, "socket": "~/.pipo/run/people-intake.sock",
  "listen": 8081, "detached": true, "ttl": "30m", "started_at": "2026-10-03T09:12:44Z", "engine_id": "e_01J9…" }
```

`listen` and `ttl` are the start's options (`ttl` only when the start passed `--ttl`), so a restart or a reattach reuses them.

When the engine starts, and on `pipo attach`, it reads every entry:

- **Alive and answering** (the pid exists and the socket's handshake names the same pipeline, pid and version): the engine **adopts** it. It replays the journal events it missed and takes back control. The pipeline never notices the outage.
- **Dead**, with the entry still there: the runner never stopped cleanly, so the engine restarts it from the file named in the entry, with the same `listen`. The journal resumes in-flight packets on their pinned versions, and a pause is restored with its reason.
- **Alive but not answering**: the engine never kills it or starts a second one. It shows as `unreachable`, with a hint to run `pipo attach` once it recovers.
- An entry whose pipeline was stopped deliberately, or whose file is gone or no longer passes `pipo check`, is removed without a restart.

The engine keeps a cursor per pipeline (`<home>/engine/cursors/<name>.json`) of the last event it streamed, so a restarted engine streams exactly the events after it. Events written between the last save and an engine crash may be streamed twice, so consumers of `/events` should dedupe on the event id (`<pipeline>:<seq>`).

## Detached runners

A runner started with `--detached` (or every runner, with `engine.detached: true`) runs in its own session. The engine's shutdown leaves it running, and so does the engine's death. The runner fires its own schedules and other inputs, enforces its own lifetime and stall detection, and journals what happens. The next engine adopts it and learns what happened from the replayed events, so nothing fires twice.

`pipo stop <name>` stops a detached runner, through the engine or directly through its socket. See [Running pipelines](running.md#detached-runners).

## Restarting the engine

After you update Pipo, a running engine still runs the old code. `pipo ui` warns about it, and the dashboard shows a banner with **🔄 Restart now**. A restart hands over to a fresh engine on the same address: the old one drains its pipelines and exits, and the new one reattaches detached runners and starts the handed-over pipelines again. From a terminal, the same is `pipo engine stop`, then `pipo ui` (or any other command).

Runners are separate processes, so each picks up new code when it next starts.

## The Pipo home

Everything the engine and runners keep lives in one folder, `~/.pipo` by default (`PIPO_HOME` or `--home` to change it):

| Path | What |
|---|---|
| `config.yaml` | Engine and agent settings. See [Configuration](configuration.md). |
| `bots.json` | Telegram bots (mode 0600). See [Telegram bots](telegram.md). |
| `trust.json` | Templates you trusted with `pipo trust`. See [Templates and generators](scaffolding.md#trust). |
| `templates/` | Your own templates for `pipo new`. |
| `pipelines/<name>/journal.db` | The pipeline's journal: packets, events, versions, proposals, the DLQ. |
| `pipelines/<name>/files/` | Files downloaded by a telegram input. |
| `run/<name>.json`, `run/<name>.sock` | A running runner's registry entry and control socket. |
| `run/engine.json` | The running engine: pid, gateway port, start time. |
| `logs/<name>.log`, `logs/engine.log` | Runner and engine output. |
| `engine/cursors/` | The engine's event cursors. |

> [!WARNING]
> Keep the home on a local Linux or macOS filesystem. SQLite's WAL mode and unix sockets don't work reliably on network drives, or on a Windows drive under WSL.
