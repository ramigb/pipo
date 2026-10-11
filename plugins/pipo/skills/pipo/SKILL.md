---
name: pipo
description: Build, test, run and operate Pipo pipelines (.pipo files) through the local Pipo engine's MCP tools. Use when the user wants a data pipeline, a webhook, schedule or file-watch automation, or asks about a Pipo pipeline's state, packets, dead letters or changes.
---

# Pipo

Pipo runs **pipelines**: one `.pipo` YAML file each, from an input, through nodes, to exactly one output. Every packet is journaled, so each step is traceable and nothing is lost in a crash. You work through the `pipo` MCP server (the engine at `http://127.0.0.1:4747/mcp`). If its tools are missing, the engine isn't running or isn't connected: ask the user to run `pipo engine start`, then `/mcp` to connect (their browser opens a Pipo page to approve you; building pipelines needs the **author** scope).

## Building a pipeline

1. **Read before you write.** Use `pipo://docs/guide/pipo-file.md`, `pipo://docs/reference/connectors.md` and `pipo://schema/pipo.schema.json`. Each connector's `with:` schema is `pipo://connectors/<kind>/<name>`. The guide's pages are all `pipo://docs/guide/<page>.md`.
2. **Write the source, then `check_pipo`** until there are no errors. Every diagnostic has a code (`P0xx`) and a hint: follow the hint.
3. **`create_pipeline`** with the source, its `fn` module and fixtures in `files`, and a one-sentence `reason` (the human reads it when approving). Nothing is written while there are errors.
4. **`test_pipeline {pipeline}`** dry-runs the folder's `fixtures/*.json`: nothing is called, sent or written. Read each fixture's trace; fix and create again until it does what was asked.
5. **Approval.** The pipeline is `pending` until the user approves it on the dashboard's Agents page (or with `pipo approvals approve <name>`). Tell the user it's waiting and what it does. `list_approvals` shows the state. Don't try to get around approval.
6. **`start_pipeline`**, then watch it with `get_status`, `inspect_packet` and `get_events`.
7. **Change it later** with `propose_change` (the whole new source, against `base_version`). On a pipeline an agent wrote, the change is held until the user applies it.

## The file, in short

```yaml
pipo: 1
name: signups                    # [a-z0-9-], unique; the folder and file take this name
description: Adults who sign up, tidied and stored.
fn: ./signups.fn.ts              # optional: exports become fn.<name>
input: { via: http, with: { path: /signups } }
nodes:
  adults: { from: input, filter: data.age >= 18 }
  tidy:
    from: adults
    transform: map
    with: { data: { name: "${trim(data.name)}", email: "${lower(data.email)}" } }
  stamp: { from: tidy, transform: fn.stamp }
output:
  from: stamp
  to: sqlite
  with: { path: ./signups.db, table: signups, create: true, mode: upsert, key: email }
agent:
  control: true                  # lets you watch it (get_status, inspect_packet)
  actions: [stop, pause, resume]
  edit: [nodes.tidy]             # what your proposals may change later
```

- **Required:** `pipo: 1`, `name`, `output`, and exactly one of `input` or `inputs`. Unknown keys are errors.
- **Wiring:** each node says where its packets come from with `from` (an input, a node id, a list, or a route branch `triage.urgent`). Exactly one `output`; its `from` may be a list.
- **Node kinds** (exactly one per node): `tap` (side effect; `log`, `http`, `file`, `emit`, `telegram`, `exec`, `fn.<name>`), `transform` (replaces `data`; `map`, `http`, `exec`, `fn.<name>`), `filter` (an expression), `route` (branch → expression, the last may be `else`), `agent` (`claude_api`, `claude_code`, …; needs a schema and a budget).
- **Inputs** (`via`): `http`, `schedule` (`cron` or `every`), `watch`, `push`, `system`, `telegram`, `pipeline`. **Outputs** (`to`): `sqlite`, `file`, `http`, `stdout`, `telegram`, `pipeline`.
- **Expressions** (`filter`, `route`, `validate`) are a safe JavaScript subset: `data.age >= 18 && exists(data.email)`. **Templates** are `"${expr}"` strings in `with:`; a value that is just `"${expr}"` keeps its type.
- **Secrets** are never literal: declare `secrets: { api_key: env:API_KEY }` (or `op://vault/item/field`) and use `${secrets.api_key}` inside `with:` only.
- **Paths** are relative to the `.pipo` file's folder.
- **Errors:** `errors: { retry: 2, delay: 1s, then: dead_letter }` for the pipeline, `on_error` per node.

## fn modules

```ts
// signups.fn.ts: plain JavaScript/TypeScript, run in a sandbox (no Node, Bun, fs, fetch or process)
export function stamp(data: { name: string }, meta: { packet_id: string }) {
  return { ...data, id: meta.packet_id };
}
```

A transform returns the new data (never `undefined`). To wait, use `await new Promise((r) => setTimeout(r, n))`. Values cross as JSON.

## Fixtures

`fixtures/<case>.json` is a packet's data, or `{"data": {…}, "meta": {…}, "stubs": {"<node>": <response>}}`. `http`, `exec` and agent steps answer from `stubs` (`{"$error": "503"}` makes one fail). Write a fixture for the happy path and one for each branch or failure that matters.

## Operating

`list_pipelines`, `get_status`, `inspect_packet {packet_id}` (a packet's full trace), `list_dlq` and `replay`, `rerun {from, dry: true}` first, `push`, `pause`/`resume`, `resolve` for escalated packets. Each needs the pipeline's `agent.control: true`, and most need the action in `agent.actions`. A refusal comes with a hint: read it before retrying.

## Rules

- Never put a secret value in a file, a fixture or a tool argument. Use `env:` or `op://` references.
- An `exec` node runs a program on the user's machine; `http` steps send data out. Say so in `reason`, and prefer `fn` or `map` when they do the job.
- Keep a pipeline's files in its own folder; `create_pipeline` refuses anything else.
