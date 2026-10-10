# Agent nodes

An agent node sends a prompt to a model and replaces the packet's `data` with the model's answer. The answer must match a JSON Schema you provide, so the rest of the pipeline always gets data in a known shape. Use agent nodes to classify, extract, summarise or draft.

```yaml
nodes:
  triage:
    from: input
    agent: claude_api
    with:
      model: claude-haiku-4-5
      prompt: |
        Triage this support ticket. Pick its category and priority and summarise it in one sentence.
        Subject: ${data.subject}
        Body: ${data.body}
      schema: ./triage.schema.json
      timeout: 30s
      max_tokens: 512
    on_error:
      retry: 2
      then: dead_letter
```

`triage.schema.json` describes the answer:

```json
{
  "type": "object",
  "properties": {
    "category": { "enum": ["billing", "outage", "bug", "other"] },
    "priority": { "enum": ["high", "normal", "low"] },
    "summary": { "type": "string" }
  },
  "required": ["category", "priority", "summary"],
  "additionalProperties": false
}
```

After the node, `data` is `{category, priority, summary}`, ready for a `route` on `data.priority` or a SQLite row. The [ticket-triage](../../examples/ticket-triage) example is this pipeline, complete with a mock of the API so it runs without a key.

Agent nodes are one of four ways agents take part in Pipo. The others, where an agent writes, operates or edits pipelines, are in [Agents as operators](agent-operators.md).

## Providers

Pick the provider with the node's kind key, `agent:`.

| `agent:` | Runs | Needs | Default `timeout` |
|---|---|---|---|
| `claude_api` | The Anthropic Messages API | An API key, and a price for the model | `60s` |
| `claude_code` | Your local Claude Code CLI (`claude`) | Installed and logged in | `5m` |
| `codex` | Your local OpenAI Codex CLI (`codex`) | Installed and logged in | `5m` |
| `pi` | Your local pi CLI (`pi`) | Installed, with a provider set up | `5m` |
| `opencode` | Your local opencode CLI (`opencode`) | Installed, with a model set up | `5m` |

CLI agents run as you, on your own account or subscription.

### `claude_api`

| `with:` | Required | Meaning |
|---|:-:|---|
| `model` | yes | The model id, e.g. `claude-sonnet-5-5`. |
| `prompt` | yes | The prompt, a template. |
| `schema` | yes | Path to a JSON Schema file, relative to the pipeline file. |
| `timeout` | | How long one call may take. Default `60s`. |
| `max_tokens` | | The answer's token limit. Default `4096`, and never more than what the packet has left of `agent_budget.per_packet`. |

The call forces one tool call whose input schema is the node's schema, so the model answers in exactly that shape. A schema that isn't an object is wrapped as `{value}` and unwrapped again. An answer cut off by `max_tokens` is an error, and its tokens still count.

### CLI agents: `claude_code`, `codex`, `pi`, `opencode`

| `with:` | Required | Meaning |
|---|:-:|---|
| `prompt` | yes | The prompt, a template. |
| `schema` | yes | Path to a JSON Schema file, relative to the pipeline file. |
| `model` | | The model. Left out, the CLI uses its own default. |
| `timeout` | | How long one call may take. Default `5m`. The whole process group is killed after it. |
| `cwd` | | A folder to run in, relative to the pipeline file. Default: a fresh, empty folder per call. |
| `allow_tools` | | `true` lets the CLI use its tools (edit files, run commands) without asking. Default `false`. |

Each call runs the CLI in its own process, with the prompt on stdin. By default:

- it runs in a **fresh, empty folder** that is removed afterwards;
- its **tools are off**, or read-only where the CLI can't turn them off (Codex runs with `--sandbox read-only`);
- Claude Code runs without your hooks, plugins, MCP servers or `CLAUDE.md`, and nothing is saved as a session.

Claude Code and Codex are made to answer in the schema's shape. pi and opencode can't enforce a schema, so the prompt ends with an instruction to answer with only JSON matching it, and the JSON is taken from the last answer. Either way, the runner then checks the answer against the schema.

`cwd` and `allow_tools` turn a CLI agent into a worker on real files. The [ci](../../examples/ci) example has Claude Code fix a failing build in a checkout of the commit (`cwd` is a template, so each packet can name its own folder):

```yaml
nodes:
  fix:
    from: verdict.red
    agent: claude_code
    with:
      model: sonnet
      cwd: "${data.workspace}"
      allow_tools: true
      timeout: 10m
      schema: ./fix.schema.json
      prompt: |
        The tests fail on main at commit ${data.short}. You are in a checkout of that commit.
        `bun test` says:

        ${data.tests.log}
        Find the cause and fix it with the smallest change that makes `bun test` pass.
    on_error: {retry: 0, then: dead_letter}
```

> [!WARNING]
> With `allow_tools: true` the CLI can change files and run commands as you, in `cwd`, without asking. Only use it with a `cwd` you'd let the agent change, and data you trust.

### Is the agent ready?

A pipeline whose agent can't run on this machine **refuses to start**, with the reason and the command that fixes it:

| Provider | Ready when | Fix |
|---|---|---|
| `claude_api` | Its API key resolves, and the model has a price. | Set the key (see below), or add a price in `config.yaml`. |
| `claude_code` | `claude` is installed and logged in. | `claude auth login` (or start `claude` and use `/login`). |
| `codex` | `codex` is installed and `codex login status` succeeds. | `codex login`. |
| `pi` | `pi` is installed with a provider set up. | Start `pi` and use `/login`, or export a provider's API key. |
| `opencode` | `opencode` is installed with a model set up. | `opencode auth login`. |

In the [builder](builder.md), agents that aren't ready are greyed out with the same reason. `GET /api/builder/agents` gives the same answer to scripts.

## Provider settings

Provider settings live in the Pipo home's `config.yaml`, under a top-level `agents:` map. Runners read it themselves, so `pipo run` and engine-started runners agree. A problem there refuses the start of any pipeline with agent nodes.

```yaml
agents:
  claude_api:
    api_key: op://Pipo/anthropic/api-key     # or env:ANTHROPIC_API_KEY (the default)
    base_url: https://api.anthropic.com      # the default
    pricing:
      claude-sonnet-5-5: { input: 3, output: 15 }   # USD per million tokens
  codex:
    command: /opt/codex/bin/codex            # the executable; default codex on PATH
    pricing:
      gpt-5: { input: 1.25, output: 10 }
```

| Key | Providers | Meaning |
|---|---|---|
| `api_key` | `claude_api` | A secret reference (`env:VAR` or `op://…`), never the key itself. Default `env:ANTHROPIC_API_KEY`. |
| `base_url` | `claude_api` | The API's base URL. Default `https://api.anthropic.com`. Point it at a mock server for tests. |
| `command` | CLI agents | The executable: a name on `PATH` or a path. Defaults: `claude`, `codex`, `pi`, `opencode`. |
| `pricing` | all | Model id, or part of one, → `{input, output}` in USD per million tokens. |

**Prices.** For `claude_api`, `opus` (5/25), `sonnet` (3/15) and `haiku` (1/5) are built in. A model id matches a key exactly, or else the longest key it contains, so `sonnet` prices `claude-sonnet-5-5`. A `claude_api` model with no price **refuses the start**, because an unpriced call would make the budget meaningless.

**CLI agent cost** is what the CLI reports (Claude Code, pi and opencode report USD), else its tokens priced from `pricing`, else $0. A CLI that reports nothing can't be stopped by a cap, so `pipo check` doesn't ask for an `agent_budget` when a pipeline only uses CLI agents.

See [Configuration](configuration.md) for the rest of `config.yaml`.

## The schema

`with.schema` is required. It names a JSON Schema file relative to the pipeline file, and it can't be a template.

- The answer is checked against it. A mismatch is a node error, handled by the node's `on_error`.
- `pipo check` reports a missing file as P014, and a file that isn't valid JSON Schema as P054.
- `$schema` is ignored, so draft-07 and 2020-12 files both load.
- Each version of the pipeline stores the schema it was compiled with. Packets pinned to an older version are checked against that version's schema.

In the builder, an agent block's inspector edits its schema file in place, as the "answer shape", and the one-click fix for P014 creates a starter schema.

## Prompts

`prompt` is a [template](expressions.md): `${…}` is rendered against the packet before the call.

- `${data.subject}` puts in one field.
- `${json(data)}` puts in the whole payload as JSON.
- `meta` and `env` work too, as in any template.

A YAML block scalar (`|`) keeps multi-line prompts readable.

## Errors, retries and loops

An agent node fails when the provider fails, the call times out, the answer doesn't match the schema, or a budget refuses the call. All of these are node errors under `on_error` (see [Error policies](errors.md)). Every attempt's tokens count against the budget, including failed ones.

A bounded loop lets a second agent review the first one's work:

```yaml
nodes:
  draft:
    from: input
    agent: claude_api
    with:
      model: claude-sonnet-5-5
      prompt: |
        Draft a reply to this ticket. If reviewer feedback is present, address it.
        ${json(data)}
      schema: ./schemas/draft.schema.json
  review:
    from: draft
    agent: claude_api
    with:
      model: claude-sonnet-5-5
      prompt: |
        Set approved=true only if the reply is correct; otherwise explain why in `feedback`.
        ${json(data)}
      schema: ./schemas/review.schema.json
    loop:
      back_to: draft
      until: data.approved == true
      max: 3
      then: dead_letter
```

`agent_budget.per_packet` counts every pass of the loop, so a loop can't spend past it. See [Nodes and the graph](nodes.md).

## Budgets: `agent_budget`

Agent nodes cost money, so a pipeline with `claude_api` nodes should set a budget (`pipo check` warns otherwise, P053).

```yaml
agent_budget:
  per_day: 5.00        # USD across all agent nodes of this pipeline, per calendar day
  reset_at: "00:00"    # optional: when the day starts, in engine.timezone
  per_packet: 20000    # tokens (input + output) one packet may use, across all agent nodes and loop passes
  warn_at: 80%         # emit a budget.warning event at this share of per_day
```

| Limit | When it's reached |
|---|---|
| `per_packet` | That packet goes to the dead-letter queue with error code `budget.packet`. The pipeline keeps running. `max_tokens` of each call is lowered to what the packet has left. |
| `per_day` | The pipeline **pauses** with the reason `budget`. It keeps journaling new packets up to `buffer.max`, so nothing is lost. It resumes by itself when the next budget day starts. |
| `warn_at` | A `budget.warning` event, once per budget day, in the journal and the event stream. |

`pipo resume` on a budget pause resumes straight away, after a confirmation, and goes over the cap until the day ends.

The day is a calendar day in the engine's time zone (`engine.timezone` in `config.yaml`, default the system's), starting at `reset_at`. A calendar day gives one clear moment to resume, and avoids the pause/resume flapping of a rolling 24 hours.

> [!NOTE]
> Caps are checked before each call, not reserved. Calls already in flight when a cap is reached (up to the pipeline's `concurrency`) still finish and are counted, so the day's spend can end up slightly above the cap.

### The engine-wide cap

A cap for the whole Pipo home, on top of each pipeline's own, goes in `config.yaml`:

```yaml
engine:
  timezone: Europe/Stockholm
  agent_budget:
    per_day: 10.00     # USD, all pipelines of this home together
```

It counts every pipeline's spend from midnight in `engine.timezone` (pipelines' `reset_at` doesn't apply). When the total reaches it, the next agent call of any pipeline is refused the same way: the packet is held and that pipeline pauses with the reason `budget` (`cap: engine`) until the next day. `pipo resume` overrides the engine cap for that one pipeline until the day ends. To allow more today, raise the cap and restart the pipeline. A change to the cap applies from a pipeline's next start.

### Seeing the spend

- `pipo status <name>` shows `agent spend today: $…`.
- `pipo status` shows the home's total for the day against the engine cap, and each pipeline's spend.
- `GET /api/agent-budget` returns the same as JSON: `per_day`, `spent_usd`, `window_start`, `resets_at`, `timezone` and `pipelines`.
- `pipo inspect <name> <packet_id>` shows an `agent.usage` event for every call: provider, model, tokens and `cost_usd`.

Every call's cost is journaled the moment the provider reports it, before the answer is even checked. So a paid call is never forgotten, and purging the DLQ never gives money back.

## Testing without calls

`pipo test` never calls a provider. Agent nodes are answered from stubs in the pipeline's `fixtures/` folder:

```json
{ "triage": { "category": "other", "priority": "low", "summary": "other ticket" } }
```

`fixtures/stubs.json` maps node ids to answers for every fixture, and a fixture's own `stubs` override them per node. The stubbed answer is still checked against the node's schema, so a fixture can test what happens with a bad answer. See [Testing](testing.md).

The builder's 🧪 test run generates a stub from the node's schema. A proposal's dry run (`agent.verify`) replays what the node answered for each delivered packet before.

### Run against a mock API

For a run without a key or cost, point `claude_api` at a local server that speaks the Messages API. The ticket-triage example includes one:

```sh
export PIPO_HOME=/tmp/pipo-triage MOCK_CLAUDE_KEY=unused
mkdir -p $PIPO_HOME
cat > $PIPO_HOME/config.yaml <<'EOF'
engine:
  timezone: UTC
agents:
  claude_api:
    base_url: http://127.0.0.1:8790
    api_key: env:MOCK_CLAUDE_KEY
EOF
bun examples/ticket-triage/mock-claude.ts &
pipo run examples/ticket-triage/ticket-triage.pipo
curl -s localhost:8791/in/ticket-triage/tickets -H 'content-type: application/json' \
  -d '{"subject": "Site is down", "body": "Checkout fails for everyone"}'
```

A throwaway `PIPO_HOME` keeps the test away from your real `~/.pipo`.

## Live changes

Agents (and humans) can change a running pipeline's prompts through a proposal, if `agent.edit` allows it (`nodes.*.with.prompt`, for example). Switching a node to a provider the runner didn't set up at start, or to a model with no price, can't be done live: put it in the file and restart. Agents can never change `agent_budget`. See [Live changes and proposals](change-protocol.md).

## See also

- [Connectors: agent providers](../reference/connectors.md#agent-providers)
- [Agents as operators](agent-operators.md)
- The spec: [§3.4 nodes](../spec.md#34-nodes) and [§3.11 agent_budget](../spec.md#311-agent_budget)
