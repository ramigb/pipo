# Testing

`pipo test` runs a pipeline against **fixture packets** and compares each result with a saved **snapshot**. It runs the real graph (validation, filters, routes, loops, fan-out, `map` and your `fn` functions) but touches nothing outside: there's no journal, no port and no live connector. Taps and the output are mocked, and agent nodes and HTTP calls answer from stubs. A test is fast, free and repeatable, so it belongs in CI next to `pipo check`.

```text
$ pipo test examples/ticket-triage
✓ bad-answer  dead_lettered
✓ billing  delivered
✓ no-subject  rejected
✓ outage  delivered
ticket-triage: 4 passed, 0 failed
```

## A first test

Take this pipeline, which looks an item up in a catalog and logs and keeps orders worth 100 or more:

```yaml
pipo: 1
name: enrich
input:
  via: http
  with: { path: /orders }
  validate:
    - exists(data.sku)
nodes:
  lookup:
    from: input
    transform: http
    with:
      url: "https://catalog.example.com/items/${data.sku}"
  big:
    from: lookup
    filter: data.price >= 100
  notify:
    from: big
    tap: log
    with: { message: "big order ${data.sku}" }
output:
  from: notify
  to: file
  with: { path: ./out/big-orders.jsonl, format: jsonl }
```

Put fixtures next to it, in a `fixtures/` folder:

```text
enrich/
├── enrich.pipo
└── fixtures/
    ├── expensive.json
    ├── cheap.json
    ├── no-sku.json
    └── catalog-down.json
```

`fixtures/expensive.json` is a packet's data plus the response the `lookup` call should get:

```json
{
  "data": { "sku": "lamp-01" },
  "stubs": { "lookup": { "sku": "lamp-01", "name": "Desk lamp", "price": 120 } }
}
```

`fixtures/cheap.json` has a price of 2, `fixtures/no-sku.json` is just `{ "nothing": true }`, and `fixtures/catalog-down.json` makes the call fail:

```json
{
  "data": { "sku": "lamp-01" },
  "stubs": { "lookup": { "$error": "503 Service Unavailable" } }
}
```

The first run writes a snapshot for each fixture:

```text
$ pipo test enrich
✓ catalog-down  dead_lettered (new snapshot written)
✓ cheap  filtered (new snapshot written)
✓ expensive  delivered (new snapshot written)
✓ no-sku  rejected (new snapshot written)
enrich: 4 passed, 0 failed
```

Review the snapshots in `fixtures/__snapshots__/` and commit them with the pipeline. From then on, `pipo test` fails when a result changes.

## Fixtures

`pipo test <file|dir>` reads every `*.json` file in `<pipeline folder>/fixtures/` (or the folder given with `--fixtures <dir>`). The fixture's name is its file name without `.json`. A folder argument must hold exactly one `.pipo` file.

A fixture is either:

- **the packet's data as JSON**, like `{ "subject": "Help" }`, or
- **an object with `data`**, plus optional `meta` and `stubs`:

```json
{
  "data": { "subject": "Site is down", "body": "Checkout fails for everyone" },
  "meta": { "input": "webhook", "source": "pagerduty" },
  "stubs": { "triage": { "category": "outage", "priority": "high" } }
}
```

`meta` may set `input` (which input the packet arrives on, for a pipeline with several), `trigger`, `source` and `received_at`. Everything else in `meta` is fixed so results are repeatable:

- `meta.packet_id` is the fixture's name.
- `meta.version` is 1.
- `meta.received_at`, `now()` and `iso()` read a fixed clock: 2026-01-01T00:00:00Z.
- `meta.source` is `test` unless the fixture sets it.
- Every `${secrets.*}` renders as `***`. Secrets are never resolved.

## Stubs

A test never calls an agent or an HTTP endpoint. **Agent nodes** and **transforms other than `map` and `fn.*`** (`transform: http`, `transform: exec`) answer from stubs instead, keyed by node id:

- **Per fixture**, in the fixture's `stubs`.
- **For every fixture**, in `fixtures/stubs.json`: `{ "<node id>": <response> }`. A fixture's own stubs win per node.

A response is the value the node returns: the agent's structured answer, or the HTTP response body. Two special forms:

- **A list** gives one response per call, in order, counting retries and loop passes: `"review": [{"approved": false, "feedback": "…"}, {"approved": true}]`.
- **`{"$error": "message"}`** makes that call fail with the message, so you can test retries and error policies. Retries are counted but never waited for.

A node that needs a stub and has none fails the fixture (`stub.missing`), with a hint that names the file to add it to. So does a list that runs out (`stub.exhausted`), and a stub for a node that doesn't take one (`stub.unknown`).

An agent's stub is still checked against the node's `schema`, like a real answer. That's how `bad-answer` in [ticket-triage](../../examples/ticket-triage) tests the dead-letter path.

## What's mocked

| Part | In a test |
|---|---|
| Input `format`, `schema`, `validate` | Run for real. A failing rule gives the outcome `rejected`. |
| Filters, routes, loops, fan-out, `map`, `fn.*` | Run for real. |
| Agent nodes, `transform: http`, `transform: exec` | Answer from stubs. The call they would make (its rendered `with:`) is recorded in `calls`. |
| Taps (`log`, `http`, `file`, `telegram`, `emit`, `exec`, `fn.*`) | Not run. Their rendered `with:` is recorded in `taps`. |
| The output | Not written. What it would write (key, connector and rendered `with:`) is recorded as `write`. |
| Delivery checks | Not run. A written packet counts as delivered. |
| Error policies | Applied, with retries counted but not waited for. |

A fixture's **outcome** is one of `delivered`, `filtered`, `rejected`, `dead_lettered`, `escalated` (`then: agent`), `paused`, `halted` or `failed` (it couldn't run, for example a missing stub). With a fan-out, each copy is a unit with its own outcome.

## Snapshots

Each fixture's result is saved in `fixtures/__snapshots__/<fixture>.snap.json`: the outcome, each unit's path through the graph, its final data, what it would write or the error that stopped it, and the taps and calls it made.

```json
{
  "fixture": "tick",
  "outcome": "delivered",
  "units": [
    {
      "unit": "tick",
      "branch": "",
      "outcome": "delivered",
      "path": ["stamp", "output"],
      "data": { "service": "pipo-example", "status": "alive", "tick": "test" },
      "write": { "key": "tick", "to": "file", "with": { "path": "./out/heartbeat.jsonl", "format": "jsonl", "mode": "append" } }
    }
  ],
  "taps": [],
  "calls": []
}
```

- A missing snapshot is written and reported as **new**.
- A matching result **passes**.
- A different result **fails** and lists the changed paths:

```text
✗ cheap  delivered
    $.outcome: "filtered" → "delivered"
    $.units[0].outcome: "filtered" → "delivered"
    $.units[0].path[2]: (missing) → "notify"
    $.units[0].path[3]: (missing) → "output"
    hint: run pipo test . --update-snapshots if the change is intended
```

- `--update-snapshots` accepts the new results (reported as **updated**).
- A fixture that can't run fails whatever its snapshot says.

## Output and exit code

One line per fixture (`✓` or `✗`, its name and outcome) and a summary. The exit code is 0 only when every fixture passes (or is new or updated).

`--json` prints:

```json
{
  "pipeline": "enrich",
  "fixtures": [
    { "name": "cheap", "outcome": "delivered", "status": "fail", "diff": ["$.outcome: \"filtered\" → \"delivered\""] },
    { "name": "expensive", "outcome": "delivered", "status": "pass" }
  ],
  "passed": 1,
  "failed": 1
}
```

`status` is `pass`, `fail`, `new` or `updated`, with `diff` on a failure and `error` when the fixture couldn't run. Check errors, a bad fixture file or a missing fixtures folder stop the run before anything runs, with a hint.

## In CI

```sh
pipo check pipelines/          # every .pipo file
pipo fmt pipelines/ --check    # exit 1 when a file isn't formatted
for dir in pipelines/*/; do pipo test "$dir" || exit 1; done
```

A test doesn't need a Pipo home, an engine, network access or credentials. `fn` modules from templates you didn't write must be trusted first (`pipo trust`, see [Templates and generators](scaffolding.md#trust)).

## Tests for `fn` modules

`pipo test` covers a function through the pipeline. For unit tests of the module itself, use your usual test runner: the `pipo new` templates include a `bun test` file next to the `fn` stub. Remember that `fn` modules run in the runner's QuickJS without Bun or Node APIs (see [User functions](functions.md)), so test them with plain JavaScript.

## Dry runs elsewhere

The same machinery runs in two other places:

- The builder's **🧪 Test** tab runs a draft against its fixtures, with the real clock instead of the fixed one, and shows the data leaving every step (see [Builder](builder.md#test-dry-runs)).
- A change proposal on a pipeline with `agent.verify: last N` replays the last *N* delivered packets through the new version, with agent nodes replayed from what they returned before (see [Live changes and proposals](change-protocol.md)).
