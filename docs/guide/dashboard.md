# Dashboard

The dashboard is the visual way to watch and operate your pipelines, and to build new ones. The engine serves it at `/ui` on its gateway. It's static files talking to the engine's REST API and event stream, so everything it does is also available from the CLI and the API.

```sh
pipo ui                       # starts the engine if needed, prints the URL and opens it
pipo ui --no-open             # only print the URL
pipo ui --workspace ~/pipes   # where the builder saves new pipelines (when it starts the engine)
```

`pipo ui --json` prints `{url, started, pid, workspace}`. An open dashboard keeps the engine awake: the idle clock only starts once the last tab closes.

The top bar has **🏠 Pipelines**, **🧮 Tasks**, **🛠️ Builder**, **🤖 Bots** and **⚙️ Settings**, the engine's status, the live event stream's status, and **🌗** to switch between the light and dark themes (it follows your system until you pick one). Animations respect your system's reduced-motion setting.

## Pipelines

The home page (`#/`) lists every pipeline the engine knows as a card: its state, its version, packets accepted, delivered and pending, the dead-letter count, throughput per minute, CPU and memory, and the lifetime remaining, counting down live when the pipeline has a TTL.

Below them, **🧰 Ready to run** lists the `.pipo` files in the workspace that aren't running, each with **▶️ Run** and **✏️ Edit**. **✨ New pipeline** opens the [builder](builder.md) on a fresh draft.

## A pipeline's page

Click a card to open the pipeline (`#/p/<name>`). Its header has the controls, the counters and **✏️ Edit**, which opens the file in the builder. Edit works even before the pipeline has a journal (it never started, or failed to start).

| Control | Effect |
|---|---|
| **⏸️ Pause** / **▶️ Resume** | Pause processing (inputs keep journaling) or resume it. |
| **🚰 Drain** | Stop taking input, finish what's in flight, then stop. Asks first. |
| **⏹️ Stop** | Stop the pipeline. Packets in flight stay in the journal and resume on the next start. Asks first. |
| **🔄 Restart** | Stop, then start the same file again. Asks first. |
| **🌱 Start** | Start a stopped or failed pipeline (in place of Stop). |

The page has five tabs. A tab that can't load shows its error in place of its content.

### 🗺️ Overview

- **The live graph.** The pipeline drawn from its definition, with counters on each node (in, ok, failed, filtered) and error badges. Packets travel along the edges as they flow. Click a node to see its counters.
- **🔀 Graph | 🏙️ City.** The same pipeline as a small isometric town: each node is a building whose shape says what it does, and each wire is a coloured data lane. Live events send a van down each lane a packet takes, and show retries (🔁), dead letters (💥), filtered packets (🧹) and deliveries (✅) at their building. Click a building for its counters. Buildings can be moved, and the town is read-only otherwise. Your choice of view is remembered per browser.
- **🧪 Send a test packet.** Type JSON and push it into the running pipeline (`POST …/push`). It runs for real: taps fire and the output is written.
- **📦 Recent packets**, with **🔍 Follow the last one**. Click a packet to open it in the inspector.

### 📜 Logs

The tail of the runner's log (`<home>/logs/<name>.log`), followed live: the same lines as `pipo logs -f`.

### 🤖 Agent

- **📝 Proposals**: each change proposal with its status, author (🧑 human or 🤖 agent), reason, size of the change and the version it became. Proposals come from the builder's Apply live, `pipo proposals … propose` and agents.
- **🤖 Agent activity**: packets handed to the agent (`then: agent`, stalls with `on_stall: handle`) and why, how each was resolved and by whom, and every applied version.

See [Agents as operators](agent-operators.md) and [Live changes and proposals](change-protocol.md).

### 💀 DLQ

The dead-letter queue: each packet, the step it failed at, its attempts and error. **🔁 Replay** puts one packet back in flight at the step it failed on; **🔁 Replay all** replays them all. Click a packet to inspect it. See [Recovering packets](recovery.md#the-dead-letter-queue).

### 🕰️ Versions

Every version with its author, reason, creation time and pending packets, the current one marked **⭐ current**. **🔎 diff vs v*N*** shows a version's diff against the current one, and **⏪ Roll back** runs an earlier version again, as a new version, after a confirmation. See [Versions and rollback](versions.md).

## Packet inspector

`#/p/<name>/<packet_id>` traces one packet through every step, like `pipo inspect`: its version, source, receive time, key and total time, then one entry per step with its event, duration, attempts and time.

- The first step shows the data the packet came in with.
- Each later step shows only what it changed: the top-level keys it set or changed (**✏️ changed**), or **data unchanged**. Keys a step dropped show as `removed: − key`, never as `null`, since `null` is a value a step can really write.
- Errors show on the step that failed.

On a delivered or filtered packet, each node step has **🔁 Rerun from here**. It shows the rerun plan (the steps that will run again, flagged when they call an agent again, reach outside again or write again) and runs it after you confirm. See [Recovering packets](recovery.md#rerunning-settled-packets).

## 🧮 Tasks

The task manager (`#/top`) lists every pipeline with its state, runner pid, CPU, memory, process count, throughput and pending count. It refreshes every 2 seconds and sorts by CPU. CPU and memory cover the runner's whole process tree, including agent CLIs it runs: CPU is a percentage of one core, summed, so it can pass 100. Each row has the pipeline's controls. Stop, drain and restart ask first.

## 🤖 Bots

The Telegram bots of this Pipo home (`#/bots`): add, edit, rename, test, make one the default, and remove. A token is typed into a password field and never shown again. A token can also be a reference (`op://…` or `env:…`). Bots are stored in `<home>/bots.json`, and a change applies from a pipeline's next start. See [Telegram bots](telegram.md).

## ⚙️ Settings

- **🔌 Engine**: its pid, address and start time, with **🔄 Restart engine** and **⏻ Stop engine**.
- **📁 Workspace**: the folder the builder saves new pipelines in, and where **🧰 Ready to run** looks for files. Pick one by walking folders from the current one, or type a path. A missing folder can be created. The choice applies at once and is saved as `engine.workspace` in `config.yaml`, so the next engine uses it too. Pipelines already saved stay where they are.

The workspace defaults to the folder the engine was started from. `pipo ui --workspace <dir>` or `pipod --workspace <dir>` set it for one engine, and a choice made here wins over both.

## When the engine is down or out of date

- **Offline.** When the engine can't be reached (it went to sleep, or was stopped), the dashboard shows **The engine is napping 😴** with the command to wake it, and reconnects by itself once it's back.
- **Stopping the engine.** **⏻ Stop engine** (on 🧮 Tasks and ⚙️ Settings) asks first, then stops it as `pipo engine stop` does: pipelines drain, detached runners keep running, crashed pipelines are remembered. The page then shows the stopped screen with the command to start it again.
- **Out of date.** After you update Pipo, the engine still runs the old code. The dashboard notices and shows a banner with **🔄 Restart now**: the old engine finishes what's in flight and stops, a fresh one starts at the same address (reattaching detached runners and starting the handed-over pipelines again), and the page reloads by itself. `pipo ui` prints the same warning. Per-start options (`--listen`, `--ttl`) aren't carried over, and a paused pipeline starts again active.

## Security

The dashboard and the API answer only on `127.0.0.1`, only to requests whose `Host` is a loopback name, and every API `POST` must be JSON. A web page you visit can't drive your engine. Data from pipelines is always rendered as text.
