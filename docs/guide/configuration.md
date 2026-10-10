# Configuration

Pipo keeps its state and settings in one folder, the **Pipo home**. Pipeline files hold everything about one pipeline. The home holds what's shared by all of them: the engine's settings, agent provider settings, bots, trust, journals, logs and the runner registry.

## The Pipo home

The home is, in order of precedence:

1. `--home <dir>`, on any `pipo` command (and `pipod`, `pipo-runner`);
2. the `PIPO_HOME` environment variable;
3. `~/.pipo`.

Everything that talks to the same pipelines must use the same home: the engine, the CLI, `pipo run` and chained pipelines. A throwaway home is a good way to experiment without touching your real one:

```sh
export PIPO_HOME=/tmp/pipo-play
pipo run examples/heartbeat/heartbeat.pipo
```

> [!NOTE]
> The journal uses SQLite in WAL mode and the runners use Unix sockets, which need a local file system. Keep the home on one (the default `~/.pipo` is). Under WSL, a home on a Windows drive (`/mnt/c/…`) misbehaves.

### Layout

| Path | What |
|---|---|
| `config.yaml` | Engine and agent settings (below). Optional: a missing file means every default. |
| `bots.json` | Telegram bots (mode 0600). See [Telegram bots](telegram.md). |
| `trust.json` | Templates you've trusted with `pipo trust`. |
| `templates/` | Your own templates for `pipo new`. See [Templates and generators](scaffolding.md). |
| `pipelines/<name>/journal.db` | The pipeline's journal: packets, events, versions, proposals, the DLQ, agent spend. SQLite, WAL mode. |
| `pipelines/<name>/files/` | Files downloaded by a telegram input. |
| `run/<name>.json` | The runner registry entry, while the runner runs. |
| `run/<name>.sock` | The runner's control socket (owner-only). |
| `run/engine.json` | The engine's entry, while it runs: `engine_id`, `pid`, `started_at`, `home`, `listen`. |
| `engine/cursors/<name>.json` | The last journal event the engine streamed for each pipeline, so a restarted engine replays what it missed. |
| `logs/<name>.log` | Each runner's log, as `pipo logs` and the dashboard show it. |

A pipeline's journal outlives its runner: `pipo packets`, `inspect`, `dlq`, `history` and `diff` read it when the pipeline is stopped. Delete `pipelines/<name>/` to forget a pipeline completely. Data in journals is removed over time by each pipeline's `retention` settings (see [Lifetime, concurrency and retention](lifetime.md)).

## `config.yaml`

```yaml
engine:
  listen: 8787                  # serve the gateway (REST, SSE, MCP, the dashboard) on 127.0.0.1:8787
  detached: false
  idle: 5m
  ttl: 8h
  timezone: Europe/Stockholm
  env_allow: [DEPLOY_ENV]
  workspace: /home/me/pipelines
  agent_budget:
    per_day: 10.00
  restart: { backoff: 1s, max_backoff: 30s, stable: 1m, max_restarts: 5, window: 10m }
  mcp:
    tokens:
      - { name: ops-agent, token: env:PIPO_MCP_TOKEN, scope: operate, pipelines: [people-intake] }
agents:
  claude_api:
    api_key: op://Pipo/anthropic/api-key
    pricing:
      claude-sonnet-5-5: { input: 3, output: 15 }
```

Only two top-level keys exist, `engine` and `agents`. **Unknown keys are errors**, so a typo never falls back to a default silently. Every problem is reported at once, with its line and column. The engine reads the file when it starts, so restart it after a change (`pipo engine stop`, then any command). Runners read `agents:`, `engine.timezone` and `engine.agent_budget` themselves, at their own start.

### `engine:`

| Key | Default | Meaning |
|---|---|---|
| `listen` | none | The gateway's port on `127.0.0.1`. `0` picks a free one (recorded in `run/engine.json`). Without it, there's no gateway: no `/api`, `/events`, `/mcp` or `/ui`, and http inputs need their own `listen` port. `pipo engine start --listen` overrides it. |
| `detached` | `false` | Start every runner detached, so it outlives the engine. See [The engine](engine.md). |
| `idle` | `5m` | How long the engine waits with nothing to do before it sleeps (exits). At least `1s`. The next `pipo` command starts it again. |
| `ttl` | none | The engine's own lifetime. When it ends, every pipeline that isn't detached drains and the engine stops. `pipo engine start --ttl` overrides it. |
| `timezone` | the system's | An IANA time zone (`Europe/Stockholm`, `UTC`) for agent budget days. |
| `env_allow` | `[]` | Environment variables that expressions can read as `env.NAME`. Others are invisible. |
| `start_timeout` | `30s` | How long a runner may take to come up and answer. |
| `stop_timeout` | `15s` | How long `pipo stop --now` waits before killing a runner. |
| `workspace` | the working directory | An absolute path: where the builder saves new pipelines and looks for `.pipo` files. Set it from the dashboard's **⚙️ Settings** page, or with `pipo ui --workspace`. |
| `agent_budget` | none | `{per_day: <USD>}`: a cap on the agent spend of every pipeline of this home together, per day in `timezone`. See [Agent nodes](agent-nodes.md#the-engine-wide-cap). |
| `restart` | see below | How crashed runners are restarted. |
| `mcp` | no tokens | `{tokens: [...]}`: the agent endpoint's bearer tokens. With none, `/mcp` refuses every request. See [Agents as operators](agent-operators.md#tokens-and-scopes). |

Durations are written like `500ms`, `30s`, `5m`, `1h` or `7d`.

**`engine.restart`** controls crash restarts. A crashed runner is restarted after `backoff`, doubling on each crash up to `max_backoff`. A runner that ran at least `stable` before crashing starts again from `backoff`. More than `max_restarts` crashes within `window` mark the pipeline `crashed`, and it stays stopped until you start it.

| Key | Default |
|---|---|
| `backoff` | `1s` |
| `max_backoff` | `30s` |
| `stable` | `1m` |
| `max_restarts` | `5` |
| `window` | `10m` |

**`engine.mcp.tokens`** entries:

| Key | Meaning |
|---|---|
| `name` | Letters, digits, `.`, `_`, `-`, up to 64 characters, unique. |
| `token` | `op://…` or `env:VAR`, never the token itself. Resolved when the engine starts. |
| `scope` | `read` (default), `operate` or `edit`. |
| `pipelines` | Optional list of the pipelines it may see. |

### `agents:`

Settings per agent provider. Each provider's map is merged over its defaults, so you only write what you change.

| Key | Providers | Default | Meaning |
|---|---|---|---|
| `api_key` | `claude_api` | `env:ANTHROPIC_API_KEY` | A secret reference (`op://…` or `env:…`), never the key itself. |
| `base_url` | `claude_api` | `https://api.anthropic.com` | The API's base URL, e.g. a local mock for tests. |
| `command` | `claude_code`, `codex`, `pi`, `opencode` | `claude`, `codex`, `pi`, `opencode` | The executable: a name on `PATH`, or a path. |
| `pricing` | all | `opus`, `sonnet`, `haiku` for `claude_api` | Model id (or part of one) → `{input, output}` USD per million tokens. The exact id wins, else the longest key the id contains. |

```yaml
agents:
  claude_api:
    pricing:
      claude-sonnet-5-5: { input: 3, output: 15 }
  claude_code:
    command: /usr/local/bin/claude
  codex:
    pricing:
      gpt-5: { input: 1.25, output: 10 }
```

A problem in `agents:` refuses the start of any pipeline with agent nodes, with the problem named. See [Agent nodes](agent-nodes.md#provider-settings).

## `bots.json`

```json
{
  "telegram": {
    "default": "main",
    "bots": {
      "main": { "token": "env:TELEGRAM_MAIN_TOKEN", "allow": [123456789], "poll_every": "25s" }
    }
  }
}
```

Each bot has a `token` (raw, or an `op://…`/`env:…` reference), an `allow` list of chat or user ids, an optional `poll_every` and an optional `api` (another Bot API server). The dashboard's **🤖 Bots** page writes it. A change applies from a pipeline's next start. See [Telegram bots](telegram.md).

## `trust.json`

`pipo trust <template>` records a template's content hash here, so `fn` modules and `exec` nodes in projects made from it pass `pipo check` (P052). Editing a trusted file means trusting it again. You don't need to edit this file by hand. See [Templates and generators](scaffolding.md).

## The runner registry

While a runner runs, it keeps `run/<name>.json` up to date, written atomically, and removes it on a clean stop:

```json
{ "pipeline": "people-intake", "version": 3, "pid": 41822, "socket": "/home/me/.pipo/run/people-intake.sock",
  "listen": 8081, "detached": true, "ttl": "30m", "state": "active",
  "started_at": "2026-10-03T09:12:44Z", "engine_id": "e_01J9…" }
```

`listen` and `ttl` are the port and the `--ttl` the pipeline was started with, so restarts and reattaches reuse them. A runner polling a Telegram bot also records the bot's id there, so a second pipeline can't poll the same bot. The engine and `pipo runners` use these entries to find runners, including detached ones that outlived an engine. See [The engine](engine.md).

## Logs

Each runner writes its log to `logs/<name>.log`:

```sh
pipo logs people-intake -f            # follow it
pipo logs people-intake --node enrich # one node's lines
```

`pipo run` writes the log to the terminal instead. Secrets are redacted from every log line.

## Environment variables

| Variable | Meaning |
|---|---|
| `PIPO_HOME` | The Pipo home, when `--home` isn't given. Default `~/.pipo`. |
| `PIPO_PLAIN` | `1` turns off colour, symbols and spinners in the CLI's output. |
| `NO_COLOR`, `CI`, `TERM=dumb` | Also turn off decoration. |
| `PIPO_RUNNER_BIN` | Path to a `pipo-runner` binary to use, instead of the one built in the checkout. |
| `PIPO_COMPILE` | The command a runner uses to run `pipo compile`. Set for you by the CLI and the engine. |
| `PIPO_COMPILE_TIMEOUT` | Milliseconds one `pipo compile` may take before the runner kills it and tries again (3 tries). Default `8000`. |
| `ANTHROPIC_API_KEY` | The default `agents.claude_api.api_key` reference. |

Your own variables reach pipelines in two ways:

- **`env:VAR` secret references** (`secrets:`, `api_key`, MCP tokens, bot tokens) read the variable from the environment of the process that resolves them: the runner for pipeline secrets, the engine for MCP tokens. A runner started by the engine inherits the engine's environment.
- **`env.NAME` in expressions** only sees the variables listed in `engine.env_allow` (or `pipo run --env-allow A,B`).

## See also

- [The engine](engine.md)
- [Secrets](secrets.md)
- [REST, SSE and MCP](api.md)
