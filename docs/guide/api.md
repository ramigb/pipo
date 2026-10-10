# REST, SSE and MCP

The engine (`pipod`) serves one HTTP server, the **gateway**, with five parts:

| Path | What |
|---|---|
| `/in/<pipeline><path>` | Ingress: webhooks and API calls into pipelines' `http` inputs. |
| `/api/…` | JSON REST: everything the CLI and the dashboard do. |
| `/events` | Server-Sent Events: every journal event, live. |
| `/mcp` | The MCP endpoint for agents (see [Agents as operators](agent-operators.md)). |
| `/ui` | The [dashboard](dashboard.md) and [builder](builder.md). |

The gateway runs when `engine.listen` is set in `config.yaml`, or the engine is started with `--listen`:

```sh
pipo engine start --listen 8787     # 0 picks a free port
pipo engine status                  # prints the port; it is also in <home>/run/engine.json
```

It binds to `127.0.0.1` only. Every CLI command has `--json`, which gives the same data as this API.

## Conventions

**Local only.** `/api`, `/events` and `/mcp` answer only requests whose `Host` is a loopback name (`127.0.0.1`, `localhost`, `[::1]`). Anything else is `403`. Every `POST` to `/api` must have `Content-Type: application/json` (`415` otherwise). Together, these stop a web page in your browser from driving the engine (DNS rebinding, cross-site form posts). `/in` has no such limits: inputs have their own auth.

**Errors** are JSON with a status that matches:

```json
{ "error": "no pipeline named 'people-intak' in this engine", "hint": "GET /api/pipelines lists them; start one with POST /api/pipelines {file} (pipo start <file>)", "code": "not_found" }
```

| Status | `code` | When |
|---|---|---|
| `400` | `bad_request` | A missing or malformed field, an unknown key. |
| `403` | `forbidden` | A non-loopback `Host`, or a builder path outside the workspace. |
| `404` | `not_found` | No such pipeline, packet, version or route. An unknown route lists every route in `routes`. |
| `405` | | Wrong method. |
| `409` | `invalid_state`, `conflict` | The pipeline isn't in a state that allows it (stopped, draining), a port is taken, a file exists. |
| `413` | | Body too large. |
| `415` | | A `POST` that isn't JSON. |
| `422` | `invalid_pipeline`, `rejected` | The file fails `pipo check` (with `diagnostics`), or a pushed packet was rejected (with `packet_id`). |
| `503` | `unavailable` | The engine is still reattaching runners after a start (with `Retry-After`), or a runner is unreachable. |

A `diagnostics` list has the shape of `pipo check --json`: `code`, `severity`, `message`, `hint`, `line`, `col`, `path`, `file`.

**Names and ids.** Pipeline names are `[a-z0-9-]`. Versions may be given as `3` or `v3`.

**Reads without a runner.** Packet, DLQ, version and proposal reads ask the runner when it runs. Otherwise they read the pipeline's journal read-only. The answer's `source` says which: `runner` or `journal`. A payload that can't be redacted safely without the runner (a secret that can't be resolved here) is withheld and listed in `withheld`.

**Writes need a runner.** DLQ replay and purge, rerun, rollback, proposals and resolve are committed by the runner. With the pipeline stopped they answer `409` with a hint to start it.

## Engine

| Method | Path | Body | Answer |
|---|---|---|---|
| `GET` | `/api/engine` | | `{engine_id, pid, home, started_at, listen, ready, stopping, pipelines, idle, ttl_expires_at, workspace, code_changed}` |
| `POST` | `/api/engine/stop` | `{}` | `202 {stopping, pid, …}`, then the engine stops as on `pipo engine stop`: pipelines drain, detached runners keep running. |
| `POST` | `/api/engine/restart` | `{}` | `202 {restarting, from, …}`: hands over to a fresh engine on the same port. |
| `GET` | `/api/agent-budget` | | The home's agent spend today: `{per_day, spent_usd, window_start, resets_at, timezone, pipelines}`. `per_day` is `null` with no engine cap. |
| `POST` | `/api/attach` | `{name?}` | Scan the registry and reattach runners now, as `pipo attach`. `{results}` |

`code_changed: true` means Pipo's code on disk changed since this engine started; the dashboard then offers a restart. `GET /api/engine` answers even while the engine is starting.

## Pipelines

| Method | Path | Body | Answer |
|---|---|---|---|
| `GET` | `/api/pipelines` | | `{pipelines: [...]}`, see below. |
| `POST` | `/api/pipelines` | `{file, listen?, detached?}` | `201`: start the `.pipo` file at `file`, an absolute path. |
| `GET` | `/api/pipelines/<name>` | | The pipeline, plus `runner` (the runner's status, while it runs: `stats`, `paused_reason`, `awaiting_ack`, `last_seq`…), `lifetime` and `resources`. |
| `POST` | `/api/pipelines/<name>/start` | `{listen?, detached?}` | Start it again from its file. |
| `POST` | `/api/pipelines/<name>/stop` | `{now?}` | Drain and stop, or stop at once with `now: true`. |
| `POST` | `/api/pipelines/<name>/drain` | `{}` | Stop intake, finish in-flight packets, stop. |
| `POST` | `/api/pipelines/<name>/restart` | `{listen?, detached?, ttl?}` | A deliberate stop, then a start. |
| `POST` | `/api/pipelines/<name>/pause` | `{reason?}` | `reason` is `manual` (default) or `agent`. It keeps accepting packets. |
| `POST` | `/api/pipelines/<name>/resume` | `{}` | |
| `GET` | `/api/pipelines/<name>/graph` | | `{name, version, source, nodes, definition}`: each node's `id`, `kind`, `label`, `from` and `counts` `{in, ok, failed, filtered}`, drawn from the version in force. |
| `GET` | `/api/pipelines/<name>/logs?tail=&after=` | | `{lines, next, reset}`: the last `tail` lines (default 200, at most 1000), or the lines after byte offset `after`. Follow a log by passing `next` back as `after`. `reset: true` means the log was truncated. |
| `GET` | `/api/pipelines/<name>/activity?limit=` | | `{events}`: the newest agent-related events (escalations, resolves, applied versions), default 50, at most 500. |

Each entry of `GET /api/pipelines`:

| Field | Meaning |
|---|---|
| `name`, `file` | The pipeline and its `.pipo` file. |
| `state` | Supervision state: `starting`, `running`, `backoff`, `stopping`, `stopped`, `failed`, `crashed` or `unreachable`. |
| `status` | The runner's own status while it runs: `active`, `paused`, `jammed`, `draining`. |
| `pid`, `version`, `socket`, `listen`, `detached`, `ttl`, `adopted`, `started_at` | The runner process. |
| `restarts`, `last_exit`, `next_restart_at`, `error` | Crash restarts and the last failure (`{message, hint}`). |
| `log` | The log file. |
| `lifetime` | `{ttl, ends_at, remaining_ms}`. |
| `stats` | From the journal: `in_flight`, `pending`, `delivered`, `filtered`, `dead_lettered`, `rejected`, `escalated`, `branched`, `total`, `oldest_pending_age_ms`, `throughput_per_min`. `null` when the journal can't be read. |
| `resources` | CPU, memory and process count of the runner. |
| `chain` | `{feeds, fed_by}`: the pipelines it feeds and is fed by (see [Chains](chains.md)). |

Start a pipeline and wait for it:

```sh
curl -s localhost:8787/api/pipelines -H 'content-type: application/json' \
  -d "{\"file\": \"$PWD/people-intake.pipo\"}"
curl -s localhost:8787/api/pipelines/people-intake | jq '.state, .runner.stats'
```

A start that fails `pipo check` answers `422` with the `diagnostics`. A taken port answers `409` and names the process holding it.

## Packets

| Method | Path | Body | Answer |
|---|---|---|---|
| `POST` | `/api/pipelines/<name>/push` | `{data, source?, input?}` | `{packet_id}` once the packet is journaled. `input` names the input when there are several. A rejected packet is `422` with `packet_id`. |
| `POST` | `/api/pipelines/<name>/ack` | `{packet_id}` | Confirms delivery of a packet waiting on `delivered.check: external`. |
| `GET` | `/api/pipelines/<name>/packets?state=&limit=&after=` | | A page of packets, newest first. `after` is the previous page's `next`. |
| `GET` | `/api/pipelines/<name>/packets/<packet_id>` | | One packet's full trace: data after each step, timings, attempts, errors, events, fan-out copies. |
| `POST` | `/api/pipelines/<name>/rerun` | `{from, ids?, last?, since?, all?, current?, dry?, by?}` | Runs settled packets again from node `from`. With `dry: true`, only the plan. See [Recovering packets](recovery.md). |
| `POST` | `/api/pipelines/<name>/resolve` | `{ids \| packet_id, action, by?, by_kind?, reason?}` | Settles escalated packets: `action` is `retry`, `dead_letter` or `drop`. `by` defaults to `api`, `by_kind` to `human`. |

```sh
curl -s localhost:8787/api/pipelines/people-intake/push -H 'content-type: application/json' \
  -d '{"data": {"name": "Ada", "age": 36}, "source": "manual"}'
curl -s 'localhost:8787/api/pipelines/people-intake/packets?state=dead_lettered&limit=10'
```

## Dead-letter queue

| Method | Path | Body | Answer |
|---|---|---|---|
| `GET` | `/api/pipelines/<name>/dlq?limit=&after=` | | Dead-lettered packets with their errors. |
| `POST` | `/api/pipelines/<name>/dlq/replay` | `{ids?, all?, by?}` | Replays each packet from the step it failed at. |
| `POST` | `/api/pipelines/<name>/dlq/purge` | `{ids?, all?, by?}` | Deletes dead letters for good. |

Give `ids` (a list) or `all: true`.

## Versions and proposals

| Method | Path | Body | Answer |
|---|---|---|---|
| `GET` | `/api/pipelines/<name>/versions` | | Newest first, with who made each, why, `author_kind`, `proposal`, `files`, and the packets still pinned to each. Also `current` and `latest`. |
| `GET` | `/api/pipelines/<name>/versions/<v>` | | One version with its `definition` and `diff` from the version before it. |
| `GET` | `/api/pipelines/<name>/diff?from=&to=` | | `{diff, identical, added, removed}`: a unified diff of two versions. |
| `POST` | `/api/pipelines/<name>/rollback` | `{version, by?}` | Makes version `v`'s definition the next version. `warnings` lists files that changed since. |
| `GET` | `/api/pipelines/<name>/proposals?state=&limit=` | | Proposals, newest first. |
| `GET` | `/api/pipelines/<name>/proposals/<id>` | | One proposal: state, problems, diff, dry-run report. |
| `POST` | `/api/pipelines/<name>/proposals` | `{source, base_version, reason, by?, by_kind?, apply?}` | Propose a whole new source. `apply: false` holds it. A proposal stored as `rejected` is a normal answer, with its problems. |
| `POST` | `/api/pipelines/<name>/proposals/<id>/apply` | `{by?}` | |
| `POST` | `/api/pipelines/<name>/proposals/<id>/reject` | `{reason, by?}` | |

See [Live changes and proposals](change-protocol.md) and [Versions and rollback](versions.md).

## Events

### `GET /events`: the live stream

Server-Sent Events of every journal event of every pipeline, plus pipeline state changes:

```sh
curl -N localhost:8787/events?pipeline=people-intake
```

```text
retry: 1000

id: people-intake:1042
data: {"id":"people-intake:1042","pipeline":"people-intake","seq":1042,"at":1760083200000,"packet_id":"01J9Z…","type":"packet.delivered","node":null,"detail":{…}}

event: state
data: {"name":"people-intake","state":"running","status":"paused",…}
```

- Each journal event is a `data:` line with `id: <pipeline>:<seq>`. The object has `pipeline`, `seq` (increasing per pipeline), `at` (epoch ms), `packet_id`, `type` (such as `packet.accepted`, `packet.delivered`, `pipeline.paused`), `node` and `detail`.
- `event: state` carries a pipeline's new supervision state (the same object as an entry of `GET /api/pipelines`). It has no id.
- A comment is sent every 15 s to keep the connection open.
- `?pipeline=<name>` limits the stream to one pipeline.

**Reconnecting.** Browsers' `EventSource` sends `Last-Event-ID` by itself; other clients can pass `?after=<id>`. With `?pipeline=`, the stream replays exactly the journal's events after that `seq` (up to 10 000, then an `event: gap` with a hint), then continues live without repeats. Without `?pipeline=`, it replays from the last 1000 events the engine streamed; when the id is older, or the engine restarted, it sends `event: gap` with a hint. A client more than 16 MiB behind is dropped and replays when it reconnects.

An open stream keeps the engine awake: it doesn't go to sleep while a dashboard is open.

### `GET /api/events`: a page

`GET /api/events?pipeline=&after=&limit=` returns `{events, more, last_id}`: the last `limit` events (default 100, 1–1000), or those after `after`. Page by passing `last_id` back as `after`. With `pipeline`, it reads that pipeline's journal, so it works for any `seq`. Without it, `after` must still be among the engine's recent events (`410` otherwise).

## Ingress: `/in`

Webhooks reach a pipeline's `http` input at `/in/<pipeline><path>`, where `<path>` is the input's `with.path`:

```sh
curl -X POST localhost:8787/in/people-intake/people \
  -H 'X-Pipo-Token: dev-token' -H 'content-type: application/json' -d '{"name": "Ada", "age": 36}'
```

The gateway forwards the request unchanged (method, path, query, raw body and headers, plus `X-Forwarded-For`, `-Host` and `-Proto`) to the runner's own port, and passes the runner's answer back as is. The runner answers:

| Answer | When |
|---|---|
| `202 {"packet_id": "…", "state": "accepted"}` | The packet is journaled (the default, `respond: accepted`). |
| `200 {"packet_id": "…", "state": "delivered"}` | With `respond: delivered`, once the packet is delivered (or filtered). A packet still pending after `timeout`, or escalated to an agent, is a `202` with its state. A dead-lettered packet is a `502` with its `error`. |
| `422 {"packet_id": "…", "state": "rejected", "error": "…", "rule": "…"}` | Validation failed. `error` is the rendered `on_invalid.message`; `on_invalid.respond` sets another status. |
| `400` | The body doesn't parse as the input's `format`. |
| `401` | The input's `auth` (token header or HMAC signature) failed. |
| `503` with `Retry-After` | The pipeline's buffer is full, or it isn't running. |

A `csv` body can hold several records; the answer is then `{"packets": [...]}`, one entry per record.

The gateway adds its own errors. It never retries:

| Answer | When |
|---|---|
| `404` | No such pipeline, or it has no http input. |
| `503` | The pipeline isn't running (with `Retry-After` while it starts or is in crash backoff), or the connection was refused. |
| `502` | A failure after the request was sent. The packet may have been accepted, so retry only with an idempotent sender. |

The same route is served directly on the runner's own port (`with.listen`, or `--listen`), which keeps working while the engine is down. `pipo run --listen <port>` serves it without any engine. See [Running pipelines](running.md).

## Builder

The dashboard's builder uses these routes. They read and write `.pipo` files, but never start, stop or change a running pipeline.

| Method | Path | Body | Answer |
|---|---|---|---|
| `GET` | `/api/builder/catalog` | | Every connector with its `with:` JSON Schema: `{workspace, inputs, taps, transforms, agents, outputs, checks, node_kinds, then}`. |
| `GET` | `/api/builder/agents?refresh=1` | | `{agents, checked_at}`: which agent providers can run on this machine, with `ready`, `reason`, `hint` and `models`. Cached 5 minutes. |
| `GET` | `/api/builder/files?refresh=1` | | `{workspace, files: [{file, rel, name}]}`: the `.pipo` files under the workspace. |
| `GET` | `/api/builder/open?file=<abs>` or `?pipeline=<name>` | | `{file, source, pipeline, diagnostics, fixtures, stubs, running}`. |
| `POST` | `/api/builder/check` | `{source \| pipeline, base?, file?}` | `{source, pipeline, diagnostics, ok}`: a live `pipo check` of a draft. Always `200`. |
| `POST` | `/api/builder/save` | `{file, source, overwrite?}` | `{file, created, diagnostics}`. Drafts with errors are saved too. |
| `POST` | `/api/builder/test` | `{source, file?, fixtures, stubs?}` | A dry run against 1–50 fixture packets, as `pipo test`, with each step's data. |
| `GET` | `/api/builder/schema?file=&path=` | | `{file, path, exists, schema, problem}`: a schema file the pipeline names. |
| `POST` | `/api/builder/schema` | `{file, path, schema, overwrite?}` | Writes a schema file. |

Files must be absolute paths to `.pipo` files inside the workspace, or the file of a pipeline the engine knows. Anything else is `403`. Saving an existing file needs `overwrite: true` (`409` otherwise), and sources are capped at 1 MiB (`413`).

## Bots and settings

| Method | Path | Body | Answer |
|---|---|---|---|
| `GET` | `/api/bots` | | `{telegram: {default, bots: [{name, default, token, bot_id, allow, poll_every, api}]}}`. A raw token is never returned: `token` is only set for a reference (`op://…`, `env:…`), and `bot_id` shows a raw token's public part. |
| `POST` | `/api/bots/telegram/<name>` | `{token?, allow?, poll_every?, api?, default?, rename?}` | Add or change a bot. Keys left out keep their value; a new bot needs `token`. |
| `POST` | `/api/bots/telegram/<name>/delete` | `{}` | Remove a bot. The default moves to the next one. |
| `POST` | `/api/bots/telegram/<name>/test` | `{}` | Calls Telegram's `getMe`: `{ok, id, username, name}` or `{ok: false, error}`. |
| `GET` | `/api/settings` | | `{workspace, workspace_from, home}`. |
| `POST` | `/api/settings/workspace` | `{path, create?}` | Sets the builder's workspace, saved as `engine.workspace` in `config.yaml`. |
| `GET` | `/api/folders?path=` | | `{path, parent, folders}`: a folder's sub-folders, for the folder picker. |

See [Telegram bots](telegram.md).

## MCP: `/mcp`

The MCP endpoint takes one JSON-RPC message per `POST`, authenticated with `Authorization: Bearer <token>`. Its tools call the REST handlers above, so the answers match. Tokens, scopes, tools and resources are described in [Agents as operators](agent-operators.md#the-mcp-endpoint).

```sh
curl -s localhost:8787/mcp -H "Authorization: Bearer $PIPO_MCP_TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "get_status", "arguments": {"pipeline": "people-intake"}}}'
```

## The runner's control socket

Underneath the engine, each runner listens on a Unix socket, `<home>/run/<name>.sock`, with newline-delimited JSON requests `{id, op, args}`. The engine, the CLI's `--no-engine` mode and chains use it. It is an internal protocol: use REST or the CLI instead. The spec documents it in [§7.2](../spec.md#72-detached-mode).

## See also

- [The engine](engine.md)
- [Configuration](configuration.md)
- [CLI reference](../reference/cli.md)
