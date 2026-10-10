# Pipo

Simple, agent-first pipeline manager for continuous data. **`docs/spec.md` is the source of truth.** Read the sections relevant to your task before changing behaviour. `docs/idea.txt` is the original idea and is kept only for history.

## Layout

Bun workspace (Bun ≥ 1.3, TypeScript run directly with no build step).

| Package | Role | Depends on |
|---|---|---|
| `packages/spec` (`@pipo/spec`) | The `.pipo` language: types, JSON Schema, connector manifests, expression parser/evaluator (jsep), YAML loader with positions, `pipo check`. Pure; reads files only to check references. | — |
| `packages/runner` (`@pipo/runner`) | The data plane: one pipeline per process, durable journal, steps, policies, connectors, crash recovery. | spec |
| `packages/cli` (`@pipo/cli`) | The `pipo` command. Every command in `pipo --help`: `check`, `run`, `schema`, `new`, `generate`, `templates`, `fmt`, `test`, `trust`, engine-backed control (`start`, `stop`, `pause`, `resume`, `restart`, `status`, `logs`, `runners`, `attach`, `packets`, `inspect`, `dlq`, `push`, `ack`, `history`, `diff`, `rollback`, `proposals`, `resolve`, `engine`, `ui`), and `compile` (advanced: the checked, compiled JSON the Rust runner runs, docs/rust-runner.md). | spec, runner, engine |
| `packages/engine` (`@pipo/engine`) | The control plane, `pipod`: supervisor (restarts, detached-runner reattach), gateway (`/in/*`, REST `/api/*`, SSE `/events`, MCP `/mcp`, `/ui`), engine TTL and idle sleep. | spec, runner, ui |
| `packages/ui` (`@pipo/ui`) | The dashboard: static ES modules served by the engine at `/ui` (pipelines, live graph, packet inspector, logs, agent feed, DLQ, versions) and the drag-and-drop builder (`#/build`, over `/api/builder/*`). Pure logic (`model.js`, `layout.js`) is unit-tested; no build step, no `innerHTML`. | — |
| `packages/vscode` | VS Code extension: `.pipo` language, schema, `${}` highlighting. Declarative, no runtime code. | — |
| `examples/` | Runnable pipelines. Each must pass `pipo check`. | — |

## Commands

```sh
bun install
bun run verify        # typecheck + lint + all tests. Must pass before every commit
bun test              # all tests
bun test packages/runner/test/recovery.test.ts   # one file
bun run typecheck     # tsc --noEmit (TypeScript 7)
bun run lint          # biome check; `bun run format` to fix formatting
bun pipo check examples          # or: bun packages/cli/src/main.ts check …
bun pipo run examples/people-intake/people-intake.pipo --listen 8787
bun pipo engine start --listen 8787   # control plane; `pipo start <file> [--detached]` starts it on demand too
bun pipo ui                       # open the dashboard at /ui (starts the engine if needed)
bun run coverage      # Phase 1 done-check;  bun run stress   # resilience tests, 5x each
```

## How the pieces fit

- **Check before run.** `Runner.open()` runs the full `check()` and refuses on errors. Every new spec rule goes into `packages/spec/src/check.ts` with a `P0xx` code, a test in `packages/spec/test/check.test.ts`, and, if it's user-visible, a line in spec §5.
- **Runtime gaps are explicit.** `packages/runner/src/support.ts` lists what the runner can't do yet. A pipeline using a `refuse` gap fails to start with a clear message, so nothing is ever silently ignored. Implementing a feature means removing its gap, implementing it, and adding tests.
- **Connectors have two halves.** The manifest (the `with:` schema and capabilities: delivery checks, batch support) lives in `packages/spec/src/manifests.ts`. The runtime implementation lives in `packages/runner/src/connectors/`. The contracts are in `connectors/types.ts`. `OutputAdapter.write` already takes a list so batching fits without a new contract.
- **Journal invariants (spec §7.3):**
  - A packet is inserted before its input is acknowledged.
  - Each step commits exactly one transition (patch + event) in one transaction before the next step runs.
  - Packets stay pinned to their version (the `versions` table stores the source).
  - Output writes are idempotent on the key (default `packet_id`).
  - Never break these. `recovery.test.ts` kills a runner with SIGKILL and asserts exactly-once results.
- **Expressions** go only through `parse()` / `evaluate()` / `render()` in `@pipo/spec`. Never use `eval` or `new Function`. `packages/spec/test/expr.test.ts` is the conformance suite: a parser swap must pass it unchanged.
- **Secrets** are references (`op://`, `env:`) resolved at start. Anything the runner logs or journals goes through `Secrets.redact()`.

## Conventions

- Formatting is Biome: 2 spaces, 120 columns, double quotes. Comments are sparse. A file-level comment names the spec section it implements.
- Errors and diagnostics say what's wrong *and* what to do (a `hint`). Follow the existing messages.
- Tests use `sandbox()` from `packages/runner/test/helpers.ts` (temp dirs under `/tmp`). Never write test data into the repo.
- Keep `docs/spec.md` and the code in sync. `check.test.ts` runs every full YAML example in the spec through `pipo check`. When implementation forces a decision the spec doesn't cover, add it to the spec, and to §13 (decision log) or §14 (open questions).
- Don't add dependencies casually. Current runtime deps are `yaml`, `jsep` (+ object/ternary plugins) and `ajv`.

## Environment notes

- The repo may live on a Windows drive under WSL (`/mnt/…`). SQLite WAL and unix sockets misbehave there, so Pipo home defaults to `~/.pipo` (override with `PIPO_HOME` or `--home`), and tests use `/tmp`.
- Runner state: `<home>/pipelines/<name>/journal.db` and `<home>/run/<name>.json` (registry entry, spec §7.2).
- In tests, don't wait on a subprocess stdout pipe. Inside `bun test`, it occasionally never wakes up. Find runners through their registry entry, and send their output to log files (see `recovery.test.ts`).

## Diagnostic codes

P001 YAML syntax · P002 schema · P010 unknown `from` · P011 bad route branch · P012 fn module/export · P013 undeclared secret · P014 missing file · P015 reserved node id · P016 route used without branch · P017 `else` not last · P020 unreachable · P021 dead end · P022 undeclared cycle · P023 loop target not upstream · P024 loop target unknown · P025 unused route branch (warn) · P026 fan-out copies share an explicit key (warn) · P030 unknown action/provider · P031 delivery check vs output · P032 batch vs output · P033 `then` not allowed here · P034 `then: agent` without control · P035 `respond` outside http · P036 node kind count · P037 sqlite key not in columns · P038 schedule needs one of cron/every, or bad cron · P039 two pipelines in one `pipo check` run share an `input.with.listen` port (warn) · P040 expression syntax · P041 variable not available · P050 literal credential (warn) · P051 secrets outside `with:` · P052 untrusted `fn` module (template not trusted, or module edited since) · P053 agent node without budget (warn) · P054 schema file not valid JSON Schema · P055 `agent.verify` not `last N` (1–1000) · P056 two pipelines in one `pipo check` run poll the same telegram bot (warn) · P057 telegram send without `chat_id` when the input isn't telegram · P058 exec `command` holds spaces (warn) · P059 `fn` module can't run in the runner's QuickJS (a Node/Bun import or global, or it doesn't bundle; checked by the CLI's `pipo check`/`pipo compile`, not `check()`)
