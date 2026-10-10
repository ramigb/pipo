# Quick start

This tutorial builds a small pipeline that receives JSON on a webhook, tidies it with a function, and stores it in SQLite. It covers the whole loop: scaffold, check, run, send data, inspect, test, then run it under the engine with the dashboard. It takes about ten minutes.

You need Pipo installed and the `pipo` command available. See [Install](install.md).

## 1. Scaffold a pipeline

`pipo new` creates a pipeline folder from a template. List the built-in ones:

```sh
pipo templates
```

```text
agent-classifier   built-in  Classify incoming JSON with an agent (schema-checked, budget-capped) and write the result to a file.
blank              built-in  An empty pipeline, HTTP in, stdout out. Start here and add nodes with `pipo generate node`.
cron-to-file       built-in  On a schedule, build a record with a function and append it to a JSONL file.
watch-to-http      built-in  Watch a folder for new files and POST each one's content to an HTTP endpoint.
webhook-to-sqlite  built-in  Receive JSON on a webhook, tidy it with a function and store it in SQLite.
```

Create one from `webhook-to-sqlite`:

```sh
pipo new hello --template webhook-to-sqlite
cd hello
```

```text
Created hello/ from template 'webhook-to-sqlite':
  fixtures/sample.json
  schemas/input.schema.json
  hello.fn.test.ts
  hello.fn.ts
  hello.pipo
```

| File | What it is |
|---|---|
| `hello.pipo` | The pipeline. |
| `hello.fn.ts` | User functions, available in the pipeline as `fn.<name>`. |
| `schemas/input.schema.json` | A JSON Schema every incoming packet must match. |
| `fixtures/sample.json` | A sample packet for `pipo test`. |
| `hello.fn.test.ts` | A `bun test` unit test for the function. |

## 2. Read the pipeline

Open `hello.pipo`. The main parts:

```yaml
secrets:
  token: env:PIPO_TOKEN          # read from an environment variable at start

input:
  via: http                      # packets arrive as HTTP requests
  with:
    path: /events
    method: POST
    listen: 8787                 # the runner serves this port itself
    auth:
      header: X-Pipo-Token       # requests must carry the token
      equals: "${secrets.token}"
  format: json
  schema: ./schemas/input.schema.json
  validate:
    - exists(data)
  on_invalid:
    respond: 422
    message: "Rejected: rule '${error.rule}' failed"

nodes:
  tidy:
    from: input
    transform: fn.tidy           # calls the tidy() export of hello.fn.ts

output:
  from: tidy
  to: sqlite
  with:
    path: ./data/hello.db
    table: events
    create: true
    mode: upsert
    key: id
    columns:
      id: "${meta.packet_id}"
      payload: "${json(data)}"
      received_at: "${meta.received_at}"

delivered:
  check: record_exists           # a row with this id must exist after the write
  with:
    where: { id: "${meta.packet_id}" }
  within: 10s
```

Packets come in through `input`, flow through the `tidy` node and are written by `output`. The `delivered` check then confirms the row is really there. Each part is explained in [The .pipo file](pipo-file.md).

## 3. Check it

```sh
pipo check
```

```text
hello.pipo  ok
```

`pipo check` validates the YAML, every connector's settings, the graph, the expressions and every file the pipeline refers to. With no argument, it checks every `.pipo` file under the current folder. A problem is reported with its position and a hint. For example, after changing `from: input` to `from: inptu`:

```text
hello.pipo:38:11  error    P010  'inptu' is not a node
  did you mean 'input'?
```

A pipeline with errors never starts. See [Diagnostics](../reference/diagnostics.md) for every code.

## 4. Run it in the foreground

`pipo run` runs one pipeline in your terminal, without the engine. The secret comes from the environment:

```sh
PIPO_TOKEN=dev-token pipo run hello.pipo
```

```text
… INFO  [hello] started v1, input: POST http://127.0.0.1:8787/in/hello/events
```

The input is served at `/in/<pipeline><path>`, here `/in/hello/events`.

## 5. Send data

In a second terminal, from the `hello` folder:

```sh
curl -X POST localhost:8787/in/hello/events \
  -H 'X-Pipo-Token: dev-token' -H 'content-type: application/json' \
  -d @fixtures/sample.json
```

```json
{"packet_id":"01M4KT1P4HHAM5956B5D7KM27C","state":"accepted"}
```

The answer is `202 Accepted` as soon as the packet is safely in the journal, before it's processed. Now try requests that fail:

```sh
# wrong token: 401, nothing is journaled
curl -X POST localhost:8787/in/hello/events -H 'X-Pipo-Token: nope' -d '{}'

# doesn't match the schema (name must be a string): 422, journaled as rejected
curl -X POST localhost:8787/in/hello/events -H 'X-Pipo-Token: dev-token' \
  -H 'content-type: application/json' -d '{"name": 5}'
```

```json
{"packet_id":"01M4KT1P5C3Y28BT350ZJYFH1H","state":"rejected","error":"Rejected: rule 'schema' failed","rule":"schema"}
```

## 6. Look at the result

The row is in the SQLite file next to the pipeline:

```sh
sqlite3 data/hello.db 'select * from events'
```

```text
01M4KT1P4HHAM5956B5D7KM27C|{"name":"Ada","tidied":true}|1791666215057
```

Pipo's own record of every packet is the journal. List the packets, newest first:

```sh
pipo packets hello
```

```text
PACKET                      STATE      NODE   VER  ATT  RECEIVED  UPDATED  ERROR
01M4KT1P5C3Y28BT350ZJYFH1H  rejected   input  v1     0  51s ago   51s ago  Rejected: rule 'schema' failed
01M4KT1P4HHAM5956B5D7KM27C  delivered  -      v1     0  51s ago   51s ago
```

`pipo packets`, `pipo inspect` and `pipo dlq` read the journal directly when the pipeline isn't running under the engine, so they work here too. Press Ctrl-C in the first terminal to stop the pipeline. It drains first: it stops taking new packets and lets the ones in flight finish. A second Ctrl-C stops at once.

## 7. Test it

`pipo test` runs the pipeline against the packets in `fixtures/`, with the output and taps mocked, so nothing is written. The first run records a snapshot of each result. Later runs compare against it.

```sh
pipo test .
```

```text
✓ sample  delivered (new snapshot written)
hello: 1 passed, 0 failed
```

Change `tidy()` in `hello.fn.ts` and run it again: the test fails and shows what changed. `pipo test --update-snapshots` accepts the new result. See [Testing](testing.md). The function's own unit test runs with `bun test`.

## 8. Run it under the engine

For pipelines that should keep running, start them through the engine, the control plane that supervises runners and restarts them if they crash. Any command that needs the engine starts it on demand.

```sh
PIPO_TOKEN=dev-token pipo start hello.pipo
```

```text
started hello (pid 8862)
```

> [!NOTE]
> A runner the engine starts inherits the **engine's** environment. `PIPO_TOKEN` reaches it here because this command also starts the engine. If an engine is already running without that variable, stop it (`pipo engine stop`) and start it again with the variable set, or use an `op://` reference. See [Secrets](secrets.md).

Push a packet from the CLI instead of curl. `pipo push` hands a packet to the running pipeline and prints its id once it's journaled:

```sh
pipo push hello --data '{"name": "Grace"}'
```

```text
pushed 01M4KT5GQFE5FBCD30KAFWAR1K into hello (accepted)
```

Watch the pipeline:

```sh
pipo status
```

```text
PIPELINE  STATE   VER  UPTIME  IN/MIN  PENDING  DELIVERED  DLQ  LAST DELIVERY
hello     active   v1     49s       2        0          3    0  20s ago
```

`pipo status hello` adds the age of the oldest pending packet and the latency of each node. Trace one packet through every step:

```sh
pipo inspect hello 01M4KT5GQFE5FBCD30KAFWAR1K
```

```text
packet 01M4KT5GQFE5FBCD30KAFWAR1K  hello v1  delivered
received 2026-10-10T21:05:42.175Z via push (cli), delivered after 11ms

  21:05:42.175  input      accepted
                         data {"name":"Grace"}
  21:05:42.178  tidy       done            +3ms
                         data {"name":"Grace","tidied":true}
  21:05:42.184  output     written         +6ms
  21:05:42.186  delivered  delivered       +2ms
```

Read the runner's log with `pipo logs hello` (`-f` to follow).

## 9. Open the dashboard

```sh
pipo ui
```

This prints the dashboard's address (for example `http://127.0.0.1:32925/ui`) and opens it in your browser. The dashboard shows the pipeline list, a live graph with packets moving along its edges, the packet inspector, logs, the dead-letter queue and version history. Its builder (**✏️ Edit**) opens `hello.pipo` on a canvas. See [Dashboard](dashboard.md) and [Builder](builder.md).

## 10. Stop

```sh
pipo stop hello          # drains, then stops
pipo engine stop         # optional: the engine also sleeps by itself when idle
```

## Next steps

- Learn the model behind what you just did: [Core concepts](concepts.md).
- Add steps: `pipo generate node hello.pipo notify --kind tap` inserts a node before the output. See [Nodes and the graph](nodes.md).
- Make delivery stricter or looser: [Delivery checks](delivery.md).
- Decide what happens on failure: [Error policies](errors.md).
- Browse complete pipelines: [Examples](../reference/examples.md).
