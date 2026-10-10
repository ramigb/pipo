# The Rust runner

The runner (the data plane, spec §7.1) moves from `packages/runner` (TypeScript on Bun) to `crates/pipo-runner`, a Rust
binary. This file covers the plan and the boundary while the port runs. When the port is done, the decisions move to
spec §13 and this file goes.

## Why

The goal is lighter runner processes: one runner per pipeline, so its memory, startup time and steady-state cost add
up across pipelines. A Bun process idles at about 40–60 MB; the Rust runner aims for under 10 MB idle. Throughput and
a Bun-free deploy aren't goals yet.

## The boundary: TypeScript checks, Rust executes

- **`pipo compile` (TS, `packages/cli`) is the only checker.** `pipo compile <file.pipo> [--home DIR] [--stdin]`
  takes a source (the file, or stdin with `--stdin`, where `<file.pipo>` only anchors relative paths and names the
  diagnostics) and prints one JSON document, exiting 1 when it has errors (64 on bad usage):

  ```json
  { "diagnostics": [ ... ], "pipeline": { ... } | null,
    "fn": { "path": "./x.fn.ts", "hash": "<sha256>", "code": "...", "exports": ["..."] } | null,
    "schemas": { "./x.schema.json": { ... } }, "files": { "./x.schema.json": "<sha256>" },
    "agents": { "settings": { "agents": { ... }, "timezone": "UTC", "engine_budget": { "per_day": 1 } | null }, "problems": [] } | null,
    "agent_manifests": { "claude_api": { ... } } }
  ```

  `diagnostics` are what `pipo check --json` gives for the file. `pipeline` is `load()`'s value; it, `fn`, `schemas`,
  `files` and `agents` are filled only when there are no errors. `fn.code` is the `fn` module bundled by `Bun.build`
  (target browser, ESM) into one self-contained ES module (TS stripped, imports inlined); `fn.exports` are its exported
  functions. `schemas` are the parsed `input.schema` and agent `with.schema` files, keyed as written. `files` is D60's
  file hashes. `agents` is set when the pipeline has agent nodes: the home's `config.yaml` agent settings (so the runner
  never parses YAML) and their problems, which refuse the start. `agent_manifests` is `AGENTS` from `@pipo/spec`.
- **The runner calls `pipo compile`** at start, on `apply`/`rollback`, and when a proposal is validated. It runs
  `$PIPO_COMPILE` (a JSON argv array; the engine and CLI set it), or `pipo compile` when that isn't set. Bun is
  needed only for the moment of a compile, never while packets flow.
- **Each version stores its compiled form** in `versions.compiled` (JSON: pipeline, fn bundle, schemas). A packet
  pinned to an old version runs that version's own code and schemas, without reading files or compiling again. This
  tightens §7.3: before, `fn` modules and schema files were re-read from disk.
- **Expressions are evaluated in Rust** (`expr/`), a port of `@pipo/spec`'s jsep subset. `packages/spec/test/expr.test.ts`
  cases are exported to `crates/pipo-runner/tests/fixtures/expr.json`, and both implementations must pass them.
- **`fn` modules run in an embedded QuickJS** (`rquickjs`, `jsfn.rs`), one runtime per runner on its own thread; calls
  are serialized over a channel. Each version's bundle is loaded as its own module, values cross as JSON, a call is
  stopped after 30 s and the runtime is capped at 256 MB. A module can't use Bun or Node APIs: if its bundle imports
  them or uses their globals, `pipo compile` (and `pipo check`) reports P059.
- **Budget days use the system's time zone database** (`jiff` over `/usr/share/zoneinfo`; no zone data in the
  binary). `pipo compile` checks `engine.timezone` against Bun's own list, so a runner with agent nodes refuses to start
  when that zone isn't in the system's database (install `tzdata`, or use `UTC`, which always works).

## What stays the same (the contracts)

- The journal schema (`journal.db`), plus one new column, `versions.compiled`. Engine and CLI code that reads
  journals keeps working.
- The control protocol (newline-delimited JSON on `<home>/run/<name>.sock`) and its ops, args, results and error
  codes.
- The registry entry (`<home>/run/<name>.json`) and its liveness fields (`pid`, `proc_start`).
- The runner's arguments: `pipo-runner <file.pipo> [--listen N] [--home DIR] [--env-allow A,B] [--engine-id ID]
  [--detached] [--ttl D]`, exit codes (0 stopped, 2 halted, 1 failed to start, 64 usage), and log line format.

## What moves into Rust

The whole of `packages/runner/src` except the client side that the engine and CLI import: `ControlClient`, registry
reading, liveness, journal reads, bots-file management, agent settings and probes. `pipo test` and the proposal dry
run run in the Rust binary (`pipo-runner test …`, `pipo-runner dry-run …`), so pipeline semantics live in one place.

## Layout (`crates/pipo-runner/src`)

| Module | Ports |
|---|---|
| `expr/` (`parse`, `eval`, `helpers`, `template`), `duration`, `cron` | `@pipo/spec` expr, duration, cron |
| `pipeline` | `@pipo/spec` types (serde) |
| `compile` | calls `pipo compile` |
| `plan`, `jsfn` | plan.ts; QuickJS host |
| `journal`, `ids` | journal.ts, ids.ts |
| `secrets`, `policy`, `stats`, `retention`, `lifecycle`, `versions`, `liveness`, `support`, `crashpoint` | same-named .ts |
| `control/` (`protocol`, `server`, `ops`, `reads`, `versions`) | control/*.ts |
| `connectors/` | connectors/*.ts |
| `agents/` | agents/*.ts |
| `runner` | runner.ts |
| `proposals`, `dryrun`, `testing` | same-named .ts |

## Milestones

1. Crate, `expr` with the conformance fixtures, `pipeline`, `journal`, `pipo compile`, `plan`/`jsfn`.
2. Runner core: intake, steps, policies, fan-out, batches, delivery checks, pause/drain/stop, lifetime, stall, the
   control socket and ops, the push input, and the stdout/file outputs. Then `recovery.test.ts` runs against the binary.
3. Connectors: http/schedule/watch/system/telegram inputs; sqlite/http/telegram outputs; http/file/emit/telegram/exec steps.
4. Agents: providers, budgets, escalation and resolve.
5. Versions, proposals, dry run, and `pipo test` in Rust.
6. The engine and CLI spawn the binary, the runner tests are ported to drive it, and the TS execution code is deleted.

## Tests

- Rust unit tests (`cargo test`) for modules with no I/O: expr, cron, durations, policy, and the journal on a temp file.
- Behaviour tests stay in `bun test`. They drive the binary through its control socket and read its journal
  read-only, as the engine does. A test no longer injects a clock, resolver or agent provider into the process: it uses
  short real durations, `env:` secrets, and a local mock server (`claude_api` with `base_url`) or a fake CLI command.
- `bun run verify` runs `cargo build --release` and `cargo test` before the TS suite.
