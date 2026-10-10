# Agents as operators

Pipo is agent-first: an agent can write a pipeline, run it, watch it, step in when something goes wrong, change it while it runs, and step out again. It uses the same documented interfaces a human uses, with no workarounds. This page covers how agents operate pipelines through the **MCP endpoint**, and what each pipeline lets them do through its `agent:` policy.

## Four roles

| Role | What the agent does | How |
|---|---|---|
| **Author** | Writes `.pipo` files. | The [JSON Schema](../reference/schema.md), [generators](scaffolding.md), `pipo check`, `pipo test`. Every CLI command takes `--json`. |
| **Operator** | Watches pipelines, pauses, resumes and replays them, pushes packets, handles stalled or escalated packets. | The MCP endpoint `/mcp`, REST `/api`, or `pipo … --json`. |
| **Editor** | Changes a *running* pipeline. | Proposals, within the pipeline's `agent.edit` policy. See [Live changes and proposals](change-protocol.md). |
| **Node** | Runs inside the graph, on each packet. | [Agent nodes](agent-nodes.md). |

Agents never change Pipo's own code at runtime. They change `.pipo` files, through a controlled protocol.

## Quick start: connect Claude Code

1. **Give the engine a port**, so it serves `/mcp`. In `<home>/config.yaml` (`~/.pipo/config.yaml` by default):

   ```yaml
   engine:
     listen: 8787
     mcp:
       tokens:
         - name: ops-agent                # the name its actions are recorded under
           token: env:PIPO_MCP_TOKEN      # a reference, never the token itself
           scope: operate                 # read | operate | edit
           pipelines: [people-intake]     # optional allowlist
   ```

2. **Create the token** and start the engine with it in its environment. Tokens are resolved when the engine starts, so a change needs an engine restart:

   ```sh
   export PIPO_MCP_TOKEN=$(openssl rand -hex 24)   # at least 16 characters
   pipo engine stop; pipo engine start
   ```

3. **Let the pipeline be operated** by agents, in its `.pipo` file:

   ```yaml
   agent:
     control: true
     actions: [pause, resume, replay, push]
   ```

4. **Add the server** to Claude Code:

   ```sh
   claude mcp add --transport http pipo http://127.0.0.1:8787/mcp \
     --header "Authorization: Bearer $PIPO_MCP_TOKEN"
   ```

Any MCP client that speaks Streamable HTTP and can send an `Authorization` header works the same way.

> [!TIP]
> Keep the token in 1Password and reference it as `token: op://Pipo/mcp/ops-agent`, instead of an environment variable.

## The MCP endpoint

The engine serves an MCP server at `/mcp` on its gateway (`engine.listen`, on `127.0.0.1`).

- **Transport.** Streamable HTTP without sessions: each POST carries one JSON-RPC message and gets a JSON answer. Notifications get `202`. There is no server stream, so GET and DELETE are `405`. Batches are refused. Revisions `2025-06-18` and `2025-11-25` are supported.
- **Methods.** `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`.
- **Local only.** Like `/api`, it answers only requests addressed to a loopback host (`127.0.0.1`, `localhost`, `[::1]`). A non-loopback `Origin` is `403`, and bodies over 4 MiB are `413`.
- **The same operations** are available over REST and through `pipo … --json`. MCP tools call the REST handlers, so their answers, errors and hints are the same.

### Tokens and scopes

Every request sends `Authorization: Bearer <token>`. A missing or unknown token is `401`. With no usable token configured, `/mcp` answers `403` with a hint on how to add one.

`engine.mcp.tokens` is a list:

| Key | Meaning |
|---|---|
| `name` | Who the token is: letters, digits, `.`, `_` and `-`, up to 64, unique. It is recorded as the author of the agent's proposals and the `by` of what it does. |
| `token` | `op://…` or `env:VAR`. A literal value is a config error, and the error never repeats it. A token that doesn't resolve, or is shorter than 16 characters, is logged and left out. |
| `scope` | `read` (default), `operate` or `edit`. Each includes the ones before it. |
| `pipelines` | Optional allowlist. A pipeline outside it doesn't exist for this token (`not_found`). |

| Scope | Tools |
|---|---|
| `read` | `list_pipelines`, `get_status`, `get_events`, `inspect_packet`, `list_dlq`, `check_pipo`, `get_proposal`, and every resource |
| `operate` | adds `replay`, `rerun`, `push`, `ack`, `pause`, `resume`, `resolve` |
| `edit` | adds `propose_change`, `rollback` |

### What a pipeline allows: the policy

A token's scope is only half of it. The pipeline's `agent:` block (in its version in force) applies on top, checked in this order: the scope, the allowlist, then the policy.

- Every pipeline tool and resource needs `agent.control: true`. Without it, the pipeline is listed by `list_pipelines` with `agent_control: false`, and nothing else works on it.
- `pause`, `resume`, `replay`, `rerun`, `push` and `ack` also need that action in `agent.actions`.
- `propose_change` and `rollback` are checked against `agent.edit` (see [Live changes](change-protocol.md)).
- `resolve` isn't gated by `agent.actions`: `then: agent` and `agent.on_stall: handle` are the grant, for the packets they hand over.

### Tools

Every pipeline tool takes `pipeline` (the name). Results are JSON text. A refused call is a tool result with `isError: true` and `{error, hint, code}`.

| Tool | Scope | Arguments | What it does |
|---|---|---|---|
| `list_pipelines` | read | — | The pipelines this token may see: state, version, runner pid, port, and `agent_control`. |
| `get_status` | read | `pipeline` | Supervision state and, while it runs, the runner's status: stats (pending, delivered, dead-lettered, escalated…), the pause reason, packets awaiting acks. |
| `get_events` | read | `pipeline`, `after_seq?`, `limit?` (1–1000, default 100) | Journal events, oldest first: the last `limit`, or those after `after_seq`. Page with `last_id`. |
| `inspect_packet` | read | `pipeline`, `packet_id?`, `state?`, `limit?`, `after?` | With `packet_id`: the packet's full trace (data, timings, attempts, errors, events, fan-out copies). Without: a page of packets, optionally in one `state` such as `escalated` or `dead_lettered`. |
| `list_dlq` | read | `pipeline`, `limit?`, `after?` | Dead-lettered packets with their errors. |
| `check_pipo` | read | `source`, `pipeline?` | Runs `pipo check` on a `.pipo` source and returns its diagnostics. With `pipeline`, file references are checked against that pipeline's folder. |
| `get_proposal` | read | `pipeline`, `id?`, `state?`, `limit?` | One proposal (state, problems, diff, dry-run report), or the list. |
| `replay` | operate | `pipeline`, `ids?`, `all?` | Replays dead letters from the step they failed at. Needs a running pipeline. |
| `rerun` | operate | `pipeline`, `from`, `ids?` \| `last?` \| `since?` \| `all?`, `current?`, `dry?` | Runs settled packets again from node `from` (or `output`). Call it with `dry: true` first: the plan lists the packets, those skipped and why, and the steps that will run again with their effect (`spend`, `external`, `write`). See [Recovering packets](recovery.md). |
| `push` | operate | `pipeline`, `data`, `source?`, `input?` | Pushes one packet. `input` names the input when there are several. Answers with the `packet_id` once it is journaled. |
| `ack` | operate | `pipeline`, `packet_id` | Confirms delivery for `delivered.check: external`. |
| `pause` | operate | `pipeline` | Pauses the pipeline, recorded with reason `agent`. |
| `resume` | operate | `pipeline` | Resumes a paused pipeline. |
| `resolve` | operate | `pipeline`, `action` (`retry` \| `dead_letter` \| `drop`), `ids?` or `packet_id?`, `reason?` | Settles escalated packets (see below). |
| `propose_change` | edit | `pipeline`, `source`, `base_version`, `reason`, `apply?` | Proposes the whole `.pipo` source as the next version. `apply: false` holds it. |
| `rollback` | edit | `pipeline`, `version`, `reason?`, `apply?` | Proposes an earlier version's source as the next version. |

Unknown arguments are refused, and `null` counts as absent. An agent's `replay`, `rerun`, `resolve`, proposals and rollbacks are recorded with the token's name, and `author_kind`/`by_kind` `agent`.

### Resources

| URI | Contents |
|---|---|
| `pipo://schema/pipo.schema.json` | The `.pipo` JSON Schema. |
| `pipo://docs/spec.md` | The Pipo specification. |
| `pipo://connectors/<kind>/<name>` | A connector's `with:` schema and capabilities. `kind` is `input`, `tap`, `transform`, `agent`, `output` or `check`. |
| `pipo://pipelines/<name>/source` | The pipeline's version in force, as `.pipo` source. |
| `pipo://pipelines/<name>/versions` | Its versions: author, `author_kind`, reason, proposal. |
| `pipo://pipelines/<name>/versions/<n>` | The source of one stored version. |

Pipeline resources follow the same allowlist and `agent.control` rules as the tools. `resources/list` lists only the pipelines the token can use.

### Redaction

Every answer is redacted before it leaves the engine:

- **secrets**, always: the pipeline's secrets, and the MCP token values;
- **paths in packet data** listed in `agent.redact`. Their values are replaced with `[redacted]` in every payload, and then masked wherever else they appear in the answer, such as in log lines, errors or event details.

`agent.redact` paths are dotted, `*` matches one segment, and a leading `data.` is optional. A path that meets a list applies to each element.

```yaml
agent:
  control: true
  redact: [data.email, data.contacts.*.phone]
```

## The `agent:` policy block

```yaml
agent:
  control: true                        # enable the agent endpoint for this pipeline
  actions: [pause, resume, replay, push]
  edit:                                # paths an agent may change; everything else is forbidden
    - nodes.*.with.prompt
    - nodes.normalize
    - errors
  redact: [data.email]
  on_stall: notify                     # notify | handle
  verify: last 20                      # dry-run a proposal on the last 20 delivered packets
```

| Key | Default | Meaning |
|---|---|---|
| `control` | `false` | Enables the agent endpoint for this pipeline, and allows `then: agent`, `delivered.stall.then: agent` and `on_stall: handle` (P034 otherwise). |
| `actions` | none | Operations agents may perform: `pause`, `resume`, `replay`, `rerun`, `push`, `ack`. |
| `edit` | none | Paths an agent's proposal may change. See [Live changes](change-protocol.md#what-an-agent-may-change). |
| `redact` | none | Paths in packet data to hide from agents. |
| `on_stall` | `notify` | `handle` hands every packet in flight to the agent when a stall fires. Needs `delivered.stall`. |
| `verify` | none | `last N` (N from 1 to 1000): proposals are dry-run on the last N delivered packets before they apply. |

The policy that applies is always the one in the **version in force**, never the one in a proposal. So an agent can't widen its own permissions: changes under `agent` are forbidden to agents anyway.

## Handing packets to the agent

A pipeline can hand problem packets to an agent instead of dead-lettering them. The packet is **escalated**: it stops where it was, keeps its data and version, and waits, across restarts, until it is resolved. Nothing is dropped while it waits.

```yaml
nodes:
  enrich:
    from: input
    transform: http
    with: { url: "https://api.example.com/people/${data.id}" }
    on_error:
      retry: 3
      then: agent          # after the retries, hand it to the agent
delivered:
  stall:
    after: 10m
    then: agent            # flag the stall, and tell the agent
agent:
  control: true
  on_stall: handle         # the agent takes over the stalled packets
```

| Source | What happens |
|---|---|
| `then: agent` in an error policy (node `on_error`, `errors`, `loop.then`, `output.on_error`, `output.on_invalid`, `delivered.on_fail`) | Once the retries run out, the packet is escalated with its error. |
| `then: agent` at `input.on_invalid` | The packet was never accepted, so it is rejected as usual, and the agent is told. The agent can push corrected data. |
| `delivered.stall.then: agent` | The pipeline is flagged `jammed`, as with `notify`, and the agent is told. Processing continues. |
| `agent.on_stall: handle` | Every packet in flight when the stall fires is escalated to the agent. |

Escalated packets count as pending, including toward `buffer.max`. So if no agent ever comes, the input fills up and then pushes back (HTTP answers `503`). They don't make a stall themselves, and a drain doesn't wait for them.

### Resolving

An agent (or a human) settles escalated packets with one of three actions:

| Action | Effect |
|---|---|
| `retry` | Puts the packet back in flight at the step it stopped at, on its pinned version, with a fresh attempt count. It doesn't reset the per-packet token budget. |
| `dead_letter` | Moves it to the DLQ, where it can be replayed later like any failure. |
| `drop` | Ends it as `filtered`. Not allowed at the output. |

```sh
pipo packets people-intake --state escalated          # find them
pipo resolve people-intake 01J9Z… --action retry --reason "API is back"
```

The MCP tool is `resolve`, and REST is `POST /api/pipelines/<name>/resolve`. A list of ids is all or nothing: every id is checked first, then all of them commit together. A packet that fanned out is resolved per copy, and the error's hint lists the copies that are waiting.

A typical agent loop: `get_status` shows `escalated > 0`, `inspect_packet` with `state: escalated` lists them, `inspect_packet` with a `packet_id` shows the error, the agent fixes the cause (a proposal, or waiting for an outside system), then `resolve` with `retry`.

## Audit

Everything an agent does is recorded in the pipeline's journal with its token's name: pauses (reason `agent`), replays, resolves (`by`, `by_kind: agent`, `reason`) and versions (`author`, `author_kind: agent`, `reason`, `proposal`). `pipo history` and the dashboard's agent feed show them.

## See also

- [Live changes and proposals](change-protocol.md)
- [REST, SSE and MCP](api.md)
- [Configuration](configuration.md)
- The spec: [§9 Agents in Pipo](../spec.md#9-agents-in-pipo)
