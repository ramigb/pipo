# Agents that build pipelines

An agent can do more than operate pipelines a human wrote: it can write a new one, test it, and run it, while you keep the last word. Everything an agent writes waits for your approval before it runs, unless you turn that off. This page covers the authoring tools, the approval loop, and the settings around them. For the MCP endpoint itself (tokens, scopes, the operating tools), see [Agents as operators](agent-operators.md).

## Connect an agent

Connect an MCP client as in [Agents as operators](agent-operators.md#quick-start-connect-claude-code), and pick the **author** scope on the consent page. With a static token, give it `scope: author`.

## The authoring loop

An agent with the `author` scope builds a pipeline in six steps:

1. **Write and check.** It writes the `.pipo` source and runs `check_pipo` on it until there are no errors. The schema, the spec and every connector's `with:` schema are MCP resources it can read.
2. **Create.** `create_pipeline` writes the pipeline into the engine's workspace as `<workspace>/<name>/<name>.pipo`, with its other files next to it: an `fn` module, JSON schemas, and fixtures under `fixtures/`. It is checked again first: with errors, nothing is written.
3. **Test.** `test_pipeline` dry-runs it against its fixtures and returns each packet's trace through every node. Nothing is called, sent or written, so this is safe before approval.
4. **Wait for approval.** The pipeline is `pending` until you approve it. `list_approvals` shows its state.
5. **Start.** Once approved, `start_pipeline` starts it.
6. **Watch.** `get_status`, `inspect_packet` and `get_events` show how it runs, if the pipeline has `agent: { control: true }`.

To change a pipeline that is running, the agent uses `propose_change`, as for any other pipeline (see [Live changes and proposals](change-protocol.md)). To rewrite one that is stopped, it calls `create_pipeline` again.

A pipeline an agent writes, with what it needs to watch and stop it:

```yaml
pipo: 1
name: greeter
fn: ./fn.ts
input: { via: push }
nodes:
  greet: { from: input, transform: fn.greet }
output: { from: greet, to: file, with: { path: ./out.jsonl, format: jsonl } }
agent:
  control: true
  actions: [stop]
  edit: [nodes.greet]
```

## Approval

Approval is the human step between "an agent wrote this" and "this runs on my machine". A pipeline can run programs (`exec`), call URLs and spend on agents, so you read it first.

- **What you approve** is the files the agent wrote, as they are now. Approval is tied to a hash of those files, so if the agent rewrites the pipeline, or anyone edits its files, it is pending again.
- **Where you approve**: the dashboard's **🔑 Agents** page (it shows the source and every file, with Approve, Approve & start and Reject), or the CLI:

  ```sh
  pipo approvals                          # what agents wrote, and its state
  pipo approvals approve greeter --start  # approve it, and start it
  pipo approvals reject greeter --reason "no exec nodes, please"
  ```

- **Starting it yourself counts as approval.** `pipo start`, the dashboard's Start button or `POST /api/pipelines` approve what is on disk.
- **A rejection** is shown to the agent with your reason. It can change the pipeline and create it again, which asks again.

An agent can't start a pipeline it wrote until it is approved: `start_pipeline` answers `approval_pending` (or `approval_rejected`) with a hint.

### Changes to agent-written pipelines

An agent's proposal to a pipeline any agent wrote is **held**: it is validated and stored, but not applied, and the answer says `held_for_approval: true`. You apply it on the Agents page or with `pipo proposals <name> apply <id>`. Without this, an agent could get a harmless pipeline approved and then propose an `exec` node into it.

Proposals to pipelines a human wrote follow the usual rules: the pipeline's `agent.edit` paths are the grant (see [Live changes](change-protocol.md#what-an-agent-may-change)).

### Auto-approve

If you trust your agents with your machine, turn approval off with `engine.mcp.auto_approve: true` in `config.yaml`, or the **Auto-approve agent pipelines** toggle on the Agents page. Pipelines agents write are then approved as they are created, and their proposals apply as usual. The toggle is saved to `config.yaml` and takes effect at once.

## The tools

| Tool | Scope | Arguments | What it does |
|---|---|---|---|
| `create_pipeline` | author | `pipeline`, `source`, `files?`, `reason?` | Checks the source and writes it into the workspace as `<pipeline>/<pipeline>.pipo`, with `files` (an object of relative path → text) next to it. Answers with the files written, the diagnostics (warnings) and the approval. |
| `test_pipeline` | read | `pipeline` or `source`, `fixtures?`, `stubs?` | Dry-runs the pipeline. With `pipeline`, its `fixtures/` folder is used when `fixtures` is left out. |
| `start_pipeline` | author | `pipeline`, `ttl?` | Starts a pipeline this agent wrote, once approved. Any other pipeline needs `agent.control` and `start` in its `agent.actions`. |
| `stop_pipeline` | author | `pipeline`, `now?` | Drains a pipeline (or stops it at once with `now`). Allowed for pipelines this agent wrote, and for others with `stop` in `agent.actions`. |
| `list_approvals` | read | | The pipelines this agent wrote, their approval state, and whether each runs. |

`create_pipeline`'s rules:

- The name is the source's `name:`, in lowercase letters, digits and `-`.
- File paths are relative and stay in the pipeline's folder: no `..`, no absolute paths, no dot files, and no other `.pipo` file. At most 32 files, 256 KiB each and 1 MiB together.
- It never overwrites a folder it didn't write, or a pipeline another agent wrote. A pipeline that is running is changed with `propose_change` instead.
- Files it wrote before and leaves out on a rewrite are removed.

`check_pipo` and `test_pipeline` never touch the system, so they need only the `read` scope and no approval.

## See also

- [Agents as operators](agent-operators.md)
- [Testing](testing.md)
- [REST, SSE and MCP](api.md#agent-approvals)
- The spec: [§9.4 Agent-authored pipelines](../spec.md#94-agent-authored-pipelines-and-approval)
