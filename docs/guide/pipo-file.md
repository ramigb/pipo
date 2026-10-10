# The .pipo file

A pipeline is one `.pipo` file: YAML with a published JSON Schema. The file is the source of truth. The CLI, the dashboard's builder and agents all read and write the same file, and nothing about a pipeline's definition is hidden anywhere else.

This page covers the file's overall shape, the conventions every block shares, and how to check and format a file. The blocks themselves have their own pages: [Inputs](inputs.md), [Nodes and the graph](nodes.md), [Outputs](outputs.md) and [Delivery checks](delivery.md).

## The smallest pipeline

```yaml
pipo: 1
name: echo
input:
  via: push
output:
  from: input
  to: stdout
```

Three keys are required: `pipo` (the spec version, always `1`), `name`, and `output`. Every pipeline also needs exactly one of `input` or `inputs`. Nodes are optional: here the output takes packets straight from the input.

## Top-level keys

```yaml
pipo: 1                 # required: spec version
name: people-intake     # required: unique per Pipo home, [a-z0-9-]
description: ...        # optional
fn: ./people.fn.ts      # optional: module of user functions
secrets: {...}          # optional: named secret references
lifetime: {...}         # optional: when the pipeline ends
concurrency: 4          # optional: packets processed in parallel (default 4; 1 = FIFO)
buffer: { max: 10000 }  # optional: max accepted-but-unprocessed packets
errors: {...}           # optional: default error policy
input: {...}            # one input, or:
inputs: {...}           #   several, as a map of input name → input
nodes: {...}            # optional: map of node id → node
output: {...}           # required
delivered: {...}        # optional: delivery verification (default check: ack)
agent: {...}            # optional: what agents may do with this pipeline
agent_budget: {...}     # optional: cost caps for agent nodes
retention: {...}        # optional: how long journal data is kept
```

| Key | Purpose | Guide |
|---|---|---|
| `pipo` | Spec version. Must be `1`. | |
| `name` | The pipeline's name: lower-case letters, digits and dashes, starting with a letter or digit. It names the journal, the registry entry, the HTTP route (`/in/<name>/…`) and the pipeline in every command. Two pipelines in one Pipo home can't share a name. | |
| `description` | Free text, shown in the dashboard. | |
| `fn` | Path (relative to the file) of a TypeScript or JavaScript module whose exports are available as `fn.<name>`. | [User functions](functions.md) |
| `secrets` | Named references (`env:NAME`, `op://vault/item/field`), used as `${secrets.<name>}` inside `with:` blocks. | [Secrets](secrets.md) |
| `lifetime` | `ttl`, `max_packets`, `until`, `on_end`, `drain_timeout`. | [Lifetime](lifetime.md) |
| `concurrency` | How many packets are processed at once. Default `4`. `1` keeps strict arrival order. | [Lifetime](lifetime.md) |
| `buffer.max` | How many accepted packets may wait before inputs push back. Default `10000`. | [Inputs](inputs.md#backpressure) |
| `errors` | The default error policy for every step. | [Error policies](errors.md) |
| `input` / `inputs` | Where packets come from. | [Inputs](inputs.md) |
| `nodes` | The steps between the input and the output. | [Nodes and the graph](nodes.md) |
| `output` | Where packets are written. Exactly one. | [Outputs](outputs.md) |
| `delivered` | How a write is verified, and stall detection. | [Delivery checks](delivery.md) |
| `agent` | Agent access: control, allowed actions, editable paths, redaction. | [Agents as operators](agent-operators.md) |
| `agent_budget` | Daily and per-packet cost caps for agent nodes. | [Agent nodes](agent-nodes.md) |
| `retention` | How long payloads and the event trail are kept. | [Lifetime](lifetime.md) |

Unknown keys are errors (P002), so a typo like `ouput:` is caught instead of ignored.

## The verb: connector pattern

The same pattern repeats everywhere: a **verb** names the connector, and **`with:`** holds that connector's settings.

```yaml
input:
  via: http              # input verb
  with: { path: /people }
nodes:
  logger:
    from: input
    tap: log             # node kind as the verb
    with: { level: info }
output:
  from: logger
  to: sqlite             # output verb
  with: { path: ./people.db, table: people }
delivered:
  check: record_exists   # delivery-check verb
  with: { where: { id: "${meta.packet_id}" } }
```

| Block | Verb | Connectors |
|---|---|---|
| Input | `via` | `http`, `schedule`, `watch`, `push`, `system`, `telegram`, `pipeline` |
| Node | `tap` | `log`, `http`, `file`, `emit`, `telegram`, `exec`, `fn.<name>` |
| Node | `transform` | `map`, `http`, `exec`, `fn.<name>` |
| Node | `agent` | `claude_api`, `claude_code`, `codex`, `pi`, `opencode` |
| Output | `to` | `sqlite`, `file`, `http`, `stdout`, `telegram`, `pipeline` |
| Delivery | `check` | `ack`, `record_exists`, `row_count`, `query`, `file_exists`, `file_nonempty`, `line_contains`, `checksum`, `status`, `follow_up`, `downstream`, `external`, `none` |

Each connector publishes a JSON Schema for its `with:` block, so `pipo check`, editor completion and the builder's forms all adapt to the connector you choose. The [Connectors reference](../reference/connectors.md) lists every field.

## Ids and names

- **Node ids** and **input names** match `[A-Za-z_][A-Za-z0-9_-]*` and share one namespace. `input` and `output` are reserved as node ids (P015). An input under `inputs:` can't be named `output` or share a node's id (P061).
- **Route branches** are addressed as `<node>.<branch>`, for example `triage.urgent`.
- **Bot names** (Telegram) and **pipeline names** in chains use the pipeline-name rule: `[a-z0-9][a-z0-9-]*`.

## Values

**Durations** are a number and a unit: `ms`, `s`, `m`, `h` or `d`. Decimals are allowed: `500ms`, `10s`, `1.5m`, `2h`, `7d`. `retention.dlq` also accepts `forever`.

**Paths** in a `.pipo` file (`fn`, schema files, output files, `exec` commands and `cwd`) are relative to the folder that holds the file, not to where you run `pipo`.

**Expressions** appear in `validate`, `filter`, `route`, `loop.until` and `lifetime.until`: a safe subset of JavaScript expression syntax, such as `data.age >= 18 && exists(data.email)`.

**Templates** are strings containing `${expr}`, used in `with:` blocks and messages. A value that is a single `${expr}` keeps its type (a number stays a number). Write `$${` for a literal `${`. See [Expressions and templates](expressions.md).

**Secrets** are never written in the file. Declare a reference under `secrets:` and use it as `${secrets.<name>}`, only inside `with:` blocks.

## An annotated example

This pipeline takes people from a webhook, validates and tidies them, and stores them in SQLite with a verified write:

```yaml
pipo: 1                          # spec version: always 1
name: people-intake              # unique per Pipo home: lower case, digits and dashes
description: Accept people from a webhook, tidy them and store them in SQLite.

secrets:                         # references only; values are resolved when the runner starts
  intake_token: env:PIPO_INTAKE_TOKEN

lifetime:                        # optional: when the pipeline ends (default: when stopped)
  ttl: 8h
  on_end: drain

concurrency: 4                   # packets processed in parallel (1 = strict FIFO)
buffer: { max: 10000 }           # accepted-but-unprocessed packets before inputs push back

errors:                          # default error policy for every step
  retry: 2
  backoff: exponential
  delay: 500ms
  then: dead_letter

input:
  via: http                      # verb: connector
  with:                          # that connector's settings
    path: /people
    method: POST
    auth:
      header: X-Pipo-Token
      equals: "${secrets.intake_token}"
  format: json
  validate:                      # every rule must be true, or the packet is rejected
    - type(data.name) == "string" && len(trim(data.name)) > 0
    - data.age >= 18
  on_invalid:
    respond: 422
    message: "Rejected: rule '${error.rule}' failed"

nodes:
  log:
    label: Log arrivals          # shown in the dashboard instead of the id
    from: input
    tap: log
    with:
      message: "Received ${meta.packet_id} from ${meta.source}"

  tidy:
    from: log
    transform: map               # data becomes the rendered template
    with:
      data:
        name: "${trim(data.name)}"
        age: "${data.age}"
        email: "${lower(default(data.email, ''))}"

output:
  from: tidy
  to: sqlite
  with:
    path: ./data/people.db
    table: people
    create: true
    mode: upsert
    key: id
    columns:
      id: "${meta.packet_id}"
      name: "${data.name}"
      age: "${data.age}"
      email: "${data.email}"
  on_error:
    retry: 5
    max_delay: 1m

delivered:                       # optional: how delivery is verified (default check: ack)
  check: record_exists
  with:
    where: { id: "${meta.packet_id}" }
  within: 10s
  stall:
    after: 5m
    then: notify

retention:
  data: 7d
  trail: 30d
```

The graph is declared once, through `from`: `input → log → tidy → output`. Downstream links are worked out from it. The [specification's full example](../spec.md#4-full-example) adds an `fn` module, an HTTP telemetry tap and an agent policy.

## Checking a file

`pipo check` validates `.pipo` files without running anything:

```sh
pipo check                      # every .pipo under the current folder
pipo check people-intake.pipo   # one file
pipo check examples             # every .pipo under a folder
```

It checks, in order of what usually goes wrong:

| Group | What it checks |
|---|---|
| **Schema** | The YAML is well-formed, required keys exist, every connector's `with:` matches its schema, durations and cron expressions parse. |
| **References** | Every `from` target and route branch exists, `fn.<name>` is exported by the `fn` module, schema files exist and are valid JSON Schema, `${secrets.x}` names are declared. |
| **Inputs** | One of `input`/`inputs`, at most 16 inputs, no clashing names, routes, ports or bots. |
| **Graph** | Every node is reachable from an input, every node leads to the output, and the only cycles are declared loops with a `max`. |
| **Compatibility** | The delivery check and `batch` are supported by the output, `then: continue` is only on taps, `respond` only on http inputs, `then: agent` only with `agent.control`. |
| **Expressions** | Every expression and template parses and uses only allowed helpers and the context variables available at that position. |
| **Safety** | Literal credentials (warning), secrets outside `with:`, agent nodes without a schema or budget, untrusted `fn` modules, `fn` modules that use Node or Bun APIs. |

Each finding is printed as `file:line:col  severity  code  message`, with a hint below it that says what to do:

```text
bad.pipo:8:11  error    P010  'inptu' is not a node
  did you mean 'input'?
bad.pipo:15:10  error    P031  delivered.check 'file_exists' is not supported by output 'sqlite'
  supported: ack, external, none, record_exists, row_count, query

2 errors
```

**Errors** make `pipo check` exit with code 1, and stop a pipeline from starting. **Warnings** are reported, but the exit code stays 0. Every start, live change and proposal runs the same checks, so a file that fails `pipo check` never runs.

With several files or a folder, `pipo check` also compares the pipelines: two HTTP inputs on the same `listen` port (P039), two pipelines polling the same Telegram bot (P056), and chain links declared at one end only (P064).

For scripts and agents, `--json` prints the findings as data:

```json
{
  "ok": false,
  "files": [
    {
      "file": "bad.pipo",
      "diagnostics": [
        {
          "file": "bad.pipo",
          "line": 8,
          "col": 11,
          "severity": "error",
          "code": "P010",
          "message": "'inptu' is not a node",
          "hint": "did you mean 'input'?",
          "path": ["nodes", "keep", "from"]
        }
      ]
    }
  ]
}
```

`path` is the location in the YAML as a list of keys. Every code is explained in [Diagnostics](../reference/diagnostics.md).

## Formatting

`pipo fmt` rewrites files in one canonical layout: known keys in the spec's order (`pipo`, `name`, `description`, … at the top; `label`, `from`, the kind, `with`, `on_error`, `loop` in a node), consistent indentation and spacing between sections. Comments are kept.

```sh
pipo fmt                     # every .pipo under the current folder
pipo fmt people-intake.pipo
pipo fmt --check             # change nothing; exit 1 and list files that would change
```

`pipo fmt --check` is useful in CI. The builder also keeps comments when it saves a file.

## The JSON Schema

`pipo schema` prints the `.pipo` JSON Schema. Connector `with:` blocks are conditional on `via`, `to`, `tap`, `transform`, `agent` and `check`, so completion follows the connector you pick. The VS Code extension attaches it to `.pipo` files. Other editors with the YAML language server can use a modeline:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/ramigb/pipo/main/schema/pipo.schema.json
```

The schema checks structure only. References, the graph, expressions and compatibility need `pipo check`. See [JSON Schema](../reference/schema.md) and [Editor support](editor.md).

## Files next to a pipeline

A pipeline folder usually looks like this, as `pipo new` scaffolds it:

```text
hello/
  hello.pipo                 the pipeline
  hello.fn.ts                user functions (fn: ./hello.fn.ts)
  schemas/input.schema.json  JSON Schemas for inputs and agent nodes
  fixtures/sample.json       packets for pipo test
  fixtures/__snapshots__/    pipo test's recorded results
```

Each version of a pipeline stores the compiled `fn` module and schema files it was started with, so editing those files never changes how packets already in flight are processed. See [Versions and rollback](versions.md).
