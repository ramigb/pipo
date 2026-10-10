# Roadmap

Phase 1, the MVP in `docs/spec.md` §12, is done; its milestones are below. Phase 2 has started (see the end). Each milestone is done when:

- the listed spec sections behave as written;
- the matching gaps are removed from `packages/runner/src/support.ts`;
- new behaviour has tests, including end-to-end tests that run real runner processes where the spec promises resilience;
- `bun run verify` passes;
- any decision the spec didn't cover is recorded in spec §13 or §14.

Milestones are ordered by dependency. Within a milestone, the items can be done in any order.

## Foundation (done)

- The `.pipo` language: schema, YAML loader with positions, the jsep expression evaluator and templates, and `pipo check` (P001–P055). Every example in the spec passes the checker.
- The runner: one process per pipeline, a WAL journal with version pinning, crash recovery, error policies (retry, backoff, `dead_letter`, `drop`, `continue`, `pause`, `halt`), and secret redaction.
- Implemented features:
  - the `http` input, with `json`, `text` and `form` formats and header-token auth;
  - `tap: log`, `transform: map`, `fn.*`, `filter`, `route` and `loop`;
  - the `sqlite` output (insert or upsert, idempotent) and the `stdout` output;
  - the `ack`, `none` and `record_exists` delivery checks;
  - `lifetime.ttl` and drain.
- The CLI commands `check`, `run` and `schema`. VS Code YAML schema wiring.

## M1: connectors (spec §3.3–§3.5, §3.10) (done)

- Inputs:
  - `schedule` (cron and `every`), owned by the runner so it keeps firing when detached;
  - `watch`;
  - `push` (needs M3 for its trigger path, but the runner can expose `intake` over its socket first);
  - `system`.
- HTTP input extras: the `csv` and `bytes` formats, HMAC signature auth, and `respond: delivered`.
- Taps and transforms: `http`, `file`, `emit`.
- Outputs: `file` and `http`, the latter sending an `Idempotency-Key` header.
- Delivery checks: `row_count`, `query`, `file_exists`, `file_nonempty`, `line_contains`, `checksum`, `status`, `follow_up` and `external` (`external` needs the ack path from M3).

## M2: delivery semantics (spec §3.5.1, §3.8, §3.10, §7.3) (done)

- Output batching for `sqlite` and `file`: one transaction per flush, splitting a failed batch in half repeatedly to isolate bad packets, and flushing on pause, stop and drain.
- Stall detection (`delivered.stall`), with the `notify`, `pause` and `agent` actions, the latter built with M5.
- `lifetime.max_packets` and `lifetime.until`, which needs a `stats` context.
- Fan-out. Resolve spec §14.1 first, then implement packet branches in the journal.

## M3: engine, the control plane (spec §7) (done)

- The `pipod` supervisor. It starts each pipeline as a runner subprocess, restarts crashed runners with backoff, and talks to them over unix sockets. The runner gets a control socket for status, pause, resume, drain, push and ack.
- The gateway (`/in/*` proxied to runners), REST `/api/*` and SSE `/events`.
- Registry discovery and reattach (§7.2): the handshake, replaying missed events, cleaning stale entries, detached mode, and `--listen` saved in the registry.
- Engine TTL, idle sleep (§7.5) and starting the engine on demand from the CLI.

## M4: full CLI (spec §6, §10.2, §10.3) (done)

- Pipeline control: `start` (with `--ttl`, D57), `stop`, `pause`, `resume`, `restart`, `status` (the §6 table, plus the oldest pending age and latency per node for one pipeline), `logs`, `packets`, `inspect`, `dlq` (with `replay` and `purge`), `push` and `ack`.
- Versions and runners: `history`, `diff`, `rollback` (a rollback survives restarts, D38), `runners`, `attach` and `engine`. `--json` everywhere, and `--no-engine` for talking to runners directly.
- Authoring: `new` and `generate node` with the built-in templates, `templates`, `trust`, `fmt` and `test` (fixtures, mocked outputs, stubbed agents, snapshots, `--update-snapshots`).
- Agent control: `proposals` and `resolve`.

## M5: agents (spec §3.4, §3.11, §9) (done)

- Agent nodes with the `claude_api` provider (formerly `claude`): a required output schema, timeout and `max_tokens`, with cost tracking from a price table in the engine config.
- `agent_budget`: a per-packet token cap that dead-letters the packet, and a per-day cap that pauses the pipeline with the reason `budget` and resumes at `reset_at`. The engine-wide `engine.agent_budget.per_day` is enforced from the journals (D58).
- The MCP endpoint `/mcp`, with the tools and resources from §9.2, scoped tokens and redaction.
- The change protocol (§9.3): propose, validate against the `agent.edit` policy, optional dry run, apply at a safe point as a new version, with an audit trail. `then: agent` and `on_stall: handle`, settled with `resolve`.

## M6: retention and observability (spec §3.12, §7.6) (done)

- Retention clean-up and daily compaction (D39).
- Built-in metrics in the runner's `stats`, `/api` and `pipo status`: throughput, pending, DLQ size, per-node latency and the age of the oldest pending packet (D41, D54). `meta.key` for delivery checks (D44, D55).

## M7: UI, Phase 1 (spec §8) (done)

- A dashboard served at `/ui` (`packages/ui`, `pipo ui`): pipeline list with stats, live graph with per-node counters, packet inspector, live log tail, the agent feed, the dead-letter queue with replay, version history with diffs, and pause/resume/drain controls (D59).

## M8: editor support (spec §10.1) (done)

- A VS Code extension that registers `.pipo`, attaches the schema, and highlights `${…}` templates. (done, `packages/vscode`)
- [cut] A Pipo language server: completion for `from` node ids, go-to-definition for `fn.*`, live `pipo check` diagnostics, quick fixes and a graph preview.

## Phase 2 (in progress; spec §12)

Done:

- The visual builder in the dashboard (§8, D62, D63): drag-and-drop blocks, wiring, forms from the connector schemas, live `pipo check` with one-click fixes, dry-run tests against sample packets, and saving back to the `.pipo` file with its comments kept. Pipeline pages open their file in it (✏️ Edit).
- Dashboard extras: `pipo ui` starts the engine on demand (D61), a 🧪 test-packet card, an outdated-engine banner with a restart button (D64, D65).
- Agents through local coding CLIs (D66, D67): `claude_code`, `codex`, `pi` and `opencode` next to `claude_api` (the renamed `claude`), checked for install and login at start and in the builder.
- A task manager page with CPU and memory per pipeline, and a restart route (D68).
- Telegram bots: a `telegram` input, tap and output, and a Bots page to manage them (§3.13, D69).
- Data shapes in the builder from input samples and schemas (D70).
- Exec steps that run installed programs, with `pipo trust` for files from templates (D71).
- A Settings page to choose the builder's workspace, and workspace pipelines listed on the Pipelines page, ready to run (D72).
- The test suite runs on macOS.

Next:

- More connectors: `postgres`, `mqtt`, `s3`, queues.
- Join and window nodes, and batch mode for `http`. (Several inputs and chains are built: spec §3.3.1, §3.14. Multiple outputs are not planned: one output by design, spec D78.)
- A connector SDK and a template registry, with sandboxing for `fn` modules (§11).
- Distributed sub-engines: runners placed on other machines, controlled from one engine.
- OpenTelemetry export (`engine.otlp`, D41).
- Pipelines declaring the env vars they need (§14.2); a configurable `watch` content limit and emitting files that already exist on first start (§14.3).
- The editor language server (M8-2).
