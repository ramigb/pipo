# Running pipelines

A pipeline runs as its own process, the **runner**. You can start one in two ways:

- **`pipo run`** starts the runner in the foreground of your terminal, without the engine. It's good for development: you see the log as it happens, and Ctrl-C ends it.
- **`pipo start`** asks the [engine](engine.md) to start the runner in the background. The engine supervises it, restarts it after a crash and serves it through the gateway, the dashboard and the agent endpoint.

Either way the pipeline uses the same journal (`<home>/pipelines/<name>/journal.db`), so you can develop with `pipo run`, stop, and then `pipo start` the same file. Packets that were in flight resume where they were.

```sh
pipo check examples/heartbeat               # always check first; a file with errors never starts
pipo run examples/heartbeat/heartbeat.pipo  # foreground, Ctrl-C to drain and stop

pipo start examples/heartbeat/heartbeat.pipo   # background, through the engine
pipo status
pipo stop heartbeat
```

A pipeline that fails `pipo check` refuses to start, with the same diagnostics `pipo check` prints. So does a pipeline that uses a feature the runner can't run yet, or one whose agent CLI or `exec` program isn't installed. The message names the problem and the command that fixes it.

## Foreground: `pipo run`

```sh
pipo run <file> [--listen <port>] [--home <dir>] [--env-allow A,B]
```

`pipo run` starts the runner for one file and streams its log to the terminal. It doesn't use or start the engine.

- **HTTP inputs** are served on the runner's own port, at the same route the gateway uses: `/in/<pipeline><path>`. The port comes from `--listen`, or `input.with.listen` in the file. An http input with neither refuses to start, with a hint.
- **Ctrl-C** drains the pipeline: intake stops, in-flight packets finish (bounded by `lifetime.drain_timeout`), then it exits. A **second Ctrl-C** stops it at once. Packets that were still in flight stay in the journal and resume on the next start.
- **`--env-allow A,B`** lists environment variables that `env:` secrets may read (see [Secrets](secrets.md)).
- Its output is never decorated, whatever the terminal: it's a log.

```sh
PIPO_INTAKE_TOKEN=dev-token pipo run examples/people-intake/people-intake.pipo --listen 8787
curl -X POST localhost:8787/in/people-intake/people \
  -H 'X-Pipo-Token: dev-token' -H 'content-type: application/json' \
  -d '{"name": " Ada ", "age": 36}'
```

> [!NOTE]
> One pipeline has one runner at a time. A second `pipo run` or `pipo start` of the same pipeline is refused while the first one answers on its control socket.

## Through the engine: `pipo start`

```sh
pipo start <file|name> [--ttl 30m] [--detached] [--listen <port>]
```

`pipo start` starts the engine if it isn't running, checks the file, and asks the engine to start a runner for it. It prints the runner's pid once the runner answers:

```text
$ pipo start examples/heartbeat/heartbeat.pipo
started heartbeat (pid 8568)
```

You can give a file or the name of a pipeline the engine already knows. The engine sends the runner's output to `<home>/logs/<name>.log`, which `pipo logs` reads.

| Flag | Effect |
|---|---|
| `--ttl 30m` | Replaces `lifetime.ttl` for this start only. See [Lifetime for one start](#lifetime-for-one-start). |
| `--detached` | The runner keeps running if the engine stops or dies. See [Detached runners](#detached-runners). |
| `--listen <port>` | The port of the HTTP input, 1 to 65535. Overrides `input.with.listen` and is saved in the runner registry. |
| `--no-engine` | `start` and `restart` need the engine, so they refuse with a hint. |

### What a start runs

A start runs the `.pipo` file **only when its content changed** since the last start. Then the file becomes a new version (author `human`, reason `first start` or `file changed`). When the file is unchanged, the latest version stays in force, so a rollback or an applied proposal survives `pipo restart`, a crash restart and a reattach. See [Versions and rollback](versions.md).

## Stopping, pausing and resuming

| Command | What happens |
|---|---|
| `pipo stop <name>` | **Drains**: intake stops, in-flight packets reach a terminal state (bounded by `drain_timeout`), then the runner exits. |
| `pipo stop <name> --now` | Stops at once. In-flight packets stay in the journal and resume on the next start. |
| `pipo pause <name>` | Processing stops, but every input keeps **accepting** packets into the journal, up to `buffer.max`. |
| `pipo resume <name>` | The backlog is processed at full `concurrency`. |
| `pipo restart <name>` | Stops the pipeline (unless it's already stopped or failed), then starts the same file again. Takes `--ttl`, `--detached` and `--listen`. |

```text
$ pipo pause heartbeat
paused heartbeat
$ pipo stop heartbeat
draining heartbeat; it stops when its packets are done
```

If a runner doesn't exit in time (`drain_timeout` plus the engine's `stop_timeout`, or just `stop_timeout` with `--now`), the engine kills it. The journal resumes its packets on the next start.

### Why a pipeline is paused

Every pause records its reason, shown by `pipo status <name>` and the dashboard:

| Reason | Cause | How it ends |
|---|---|---|
| `manual` | `pipo pause`, the dashboard or the API | `pipo resume` |
| `agent` | An agent paused it through the [agent endpoint](agent-operators.md) | `pipo resume`, or the agent resumes it |
| `error` | An error policy with `then: pause` | Fix the cause, then `pipo resume` |
| `stall` | `delivered.stall.then: pause` (see [Delivery checks](delivery.md)) | `pipo resume` |
| `budget` | The daily agent budget is spent (see [Agent nodes](agent-nodes.md)) | The next budget day, or `pipo resume` (which asks for confirmation, because it goes over the cap) |

A pause **outlives a crash**. A runner that restarts after a crash, or that `pipo run` starts again, reads the pause from its journal and starts paused, with the same reason. Only a resume, a clean stop or a halt ends it.

While paused, inputs push back only when the buffer is full: `http` answers `503` with `Retry-After`, `telegram` and `watch` wait and retry, a `schedule` tick or a `system` sample is skipped, and `push` and `pipeline` hand-offs answer `unavailable`.

## Lifetime for one start

`pipo start <name> --ttl 30m` and `pipo restart <name> --ttl 30m` replace the file's `lifetime.ttl` for that start only. `on_end` and `drain_timeout` still come from the file, and a file without a `lifetime` block drains.

- The override survives crash restarts and engine reattaches. It's saved in the runner registry entry.
- It doesn't stick. A later start without `--ttl` uses the file's `ttl` again, and so does `pipo run`.
- A TTL counts from the first start since the last clean stop. A crash doesn't reset it, so a crash restart only gets the time that's left. A deliberate stop or `pipo restart` resets it.

See [Lifetime, concurrency and retention](lifetime.md).

## Detached runners

With `pipo start --detached`, or `engine.detached: true` in `config.yaml`, a runner **keeps running when the engine dies or stops**:

```sh
pipo start examples/heartbeat/heartbeat.pipo --detached
pipo engine stop          # heartbeat keeps running
pipo runners              # shows it as detached
pipo stop heartbeat       # stops it, through its socket if the engine is down
```

- The runner runs in its own session, so a Ctrl-C in the engine's terminal or the engine's death doesn't reach it.
- Schedules, `watch`, `system` and `telegram` inputs fire from the runner itself. So do lifetime limits and stall detection: the runner owns its clocks whether the engine is there or not.
- The runner's log goes to `<home>/logs/<name>.log`.
- When an engine starts again, it **reattaches** the runner and replays the journal events it missed. Nothing fires twice.

Any runner, detached or not, survives the engine being killed with `SIGKILL`. Without `--detached`, a graceful engine stop drains its runners.

## HTTP ports

Pipo never picks a port for an HTTP input by itself, except behind the gateway:

- **With the gateway on** (the engine's `listen`; the CLI starts the engine on a free gateway port by default), an http input without a port gets a free loopback port, and is reachable at `http://127.0.0.1:<gateway>/in/<pipeline><path>`.
- **To have a fixed port**, set `input.with.listen: 8081` in the file, or pass `pipo start <name> --listen 8081`. The flag wins and is saved in the registry, so restarts and reattaches keep the same port. A fixed port is also reachable directly, which matters for detached runners: while the engine is down, only the direct port works.

Before a start, the engine checks that the port is free. If it isn't, the start is refused with the pipeline or the process (pid and command line) that holds it, and a hint to stop it or pass another `--listen`. `pipo check` on several files warns when two pipelines declare the same port (P039).

Everything binds to `127.0.0.1`. Exposing an input to a network is your choice: put a reverse proxy in front of it.

## Finding runners: `pipo runners` and `pipo attach`

`pipo runners` lists every runner found in `<home>/run`, with its pid, port, version and state. It works without the engine and never starts it.

```text
$ pipo runners
NAME        PID  PORT  VERSION  STATE
heartbeat  8568     -       v1  attached
```

| State | Meaning |
|---|---|
| `attached` | The engine supervises it. |
| `detached` | Running on its own: started detached, or the engine is down (the table then ends with `engine: down`). |
| `stale` | The registry entry names a pid that is gone. |
| `unreachable` | The pid is alive, but its control socket doesn't answer the handshake. |

`pipo attach [name]` tells the engine to scan again now: it adopts live runners, restarts dead ones that never stopped cleanly, and cleans stale entries. It prints one line per runner (`adopted`, `restarted`, `removed`, `supervised`, `unreachable` or `failed`, each with a hint) and exits 1 when one failed. Use it after an `unreachable` runner recovers.

## Working without the engine: `--no-engine`

If the engine is down or can't start, or you pass `--no-engine`, the CLI talks to running runners directly through their control sockets (`<home>/run/<name>.sock`). `status`, `logs`, `inspect`, `packets`, `pause`, `resume`, `stop`, `push`, `ack`, `dlq` and the version reads all work, and their output is marked `engine: down`. Reads of a stopped pipeline come from its journal (see [Observing pipelines](observing.md#stopped-pipelines)). `start` and `restart` need the engine and refuse.

## When a runner crashes

The journal makes crashes boring:

- Each packet is journaled **before** its input is acknowledged, and each step's result is committed before the next step runs.
- After a restart, each packet resumes at its last committed step, on the version it was pinned to. So a tap or an `exec` step may run twice (at-least-once). Outputs are idempotent on the packet's key, so a repeated write doesn't duplicate.
- The engine restarts a crashed runner after a backoff (1 s, doubling up to 30 s, back to 1 s after a minute of stable running). After 5 crashes within 10 minutes it gives up and marks the pipeline `crashed`, with the last exit and a hint. Its in-flight packets stay in the journal. Fix the cause, then `pipo start` it again. These numbers are configurable under `engine.restart` (see [Configuration](configuration.md)).
- A runner that exits with `then: halt` is `failed`, and is not restarted.
- A pipeline stopped deliberately stays stopped. The engine doesn't restart it on its next start.

See [The engine](engine.md) for how the supervisor and reattach work, and [Recovering packets](recovery.md) for dealing with packets that failed for good.

## Pipeline states

```text
stopped ─► starting ─► active ◄─► paused
                         │
                         ├─► draining ─► completed   (lifetime reached, or stop requested)
                         ├─► jammed                  (stall detected; still running, flagged)
                         └─► failed                  (an error policy chose `halt`)
```

`pipo status` shows the runner's state. The engine adds its own view of the process: `starting`, `running`, `stopping`, `stopped`, `backoff` (waiting to restart), `crashed`, `failed` and `unreachable`.
