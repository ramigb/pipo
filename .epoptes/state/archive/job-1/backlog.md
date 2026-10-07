# Backlog

**Current milestone: M4**   (the orchestrator moves this line forward)

**Markers:** `[ ]` todo · `[~]` in progress · `[x]` done · `[blocked: why]` · `[cut]`
**Notes:** IDs are stable; new tasks get the next free number. Parallel tasks must own separate files. Targets are cumulative active time; if more than 45 min behind, cut from the end (M8, then M7 polish, then M6), never resilience tests.
**Sources:** docs/roadmap.md (milestones), docs/spec.md (behaviour), CLAUDE.md (conventions).

## Feedback (from `epoptes feedback`)
- [x] F-1 Start with M0 before M1 (M0 was done first in c1).
- [x] F-2 M3-9 approved and applied by the human; unblock, mark done, include in stress runs.

## Review fixes
- [x] R-1 [med] tests: packages/cli/test/help.test.ts spawns the CLI with a 5 s timeout; under full-suite load (engine tests) check/generate --help time out (exit 143). Make it robust.

- [x] R-2 [med] tests: packages/cli/test/cli.test.ts spawns the CLI with bun test's 5 s default; under full-suite load `check --json` timed out (c8). Apply R-1's fix (longer timeout + retry) to every subprocess test there.

- [x] R-3 [high] engine resilience: a pipeline stopped during restart backoff or via SIGKILL fallback keeps a stale registry entry (supervisor.ts:436-447, 1284-1289; stale() only drops crashed/failed, 794-802) → next attach/engine restarts it. removeStale on settle to `stopped`; add `stopped` to D27; e2e: stop in backoff / forced kill → new engine restarts nothing.
- [x] R-4 [high] engine resilience: reused pid → engine restarts without removing entry, Runner.open refuses "already running" (bare isAlive, runner.ts:179,1336) → crash loop; same flaw in claimEngineEntry (registry.ts), CLI findEngine (lifecycle.ts:19,48), Supervisor.start (supervisor.ts:380). One shared liveness check (alive + pidReused vs started_at) exported from @pipo/runner; test with an existing file.
- [x] R-5 [high] runner/engine resilience: pause lost on crash: engine relaunch (supervisor.ts:1229-1250) never restores pause; restore() pauses after workers start (runner.ts:227-230). Runner restores pause (reason) from journal before starting workers; SIGKILL test on paused runner (same and new engine) → nothing delivered until resume.
- [x] R-6 [med] CLI DX: hints name `pipo attach`/`pipo runners` which are planned only (commands.ts:186-187). Implement them (M4-3) or fix hints.
- [x] R-7 (rest → M4-9) [med] CLI/gateway: `start --ttl` silently dropped by gateway startOptions (gateway.ts:733-739); `--listen 0` accepted by CLI but 400 at API; --json errors are plain stderr (main.ts) → print {ok:false,error,hint,code} to stdout; list --no-engine in start/stop/status help; API 400 on unknown body keys.
- [ ] R-8 [med] spec sync + runner TTL + SSE: reword §7.4/§7.5 to D30/D31 and close §14.5; anchor pipeline TTL to first `pipeline.started` since last clean stop (runner.ts:262-268 re-arms on crash restart), test across SIGKILL; gateway.ts:375 skip = max(cursor, after.seq) + test.

- [ ] R-9 [low] engine: `stop` on a `crashed` pipeline keeps its registry entry; tiny window between SIGKILL fallback and entry removal (from R-3).
- [x] R-10 [low] docs: spec §7.2 control-socket ops list is stale (packets/packet/dlq/replay/purge added in M4-2).
- [ ] R-11 [low] versions: a version stores only the .pipo text, not fn modules/schema files; live apply puts structured diagnostics in message text only (from M4-3).
- [x] R-12 [low] UI/spec: §7.1/§8 don't mention `/ui` or `GET /api/pipelines/<name>/graph` (D40 records them); add to the body text.
- [x] R-13 [high] stress/D3: packages/engine/test/engine-kill.test.ts fails 1/5 (c10 and c11) — "timed out after 30000ms waiting for direct requests accepted with no engine". Find the root cause (Bun /mnt module-load hang on a spawned runner/CLI → add the retry pattern from lessons; or a real race in direct mode after engine SIGKILL). Don't relax the assertion; builder-deep.
- [x] R-14 [high] cli: --json ignored for usage/unknown-command/not-implemented errors; one shared helper (cli.ts:156, lifecycle.ts:212) printing {ok:false,error,hint,code}.
- [x] R-15 [high] cli: engine API hints ("GET /api/pipelines…") leak to CLI users for not_found; map to CLI wording in packages/cli/src/errors.ts.
- [x] R-16 [med] ui: §8 list columns (state, version, in/min, pending, delivered, DLQ, last delivery), pause/resume/drain buttons, DLQ+replay and versions/diff tabs, 375px overflow. (critic final: ui 4)
- [ ] R-17 [med] check: §7.2 duplicate-port warning across files in one project not implemented (new P039).
- [blocked: needs approval — narrow §7.6/§12 or build OTLP, MCP, latency; filed as §14.6] R-18 [med] spec §7.6 vs code: engine.otlp (cut), per-node latency, oldest-packet age, MCP /mcp in §12 — needs a §14 question or implementation.
- [ ] R-19 [low] code quality: split runner.ts/supervisor.ts; UI dead code (app.js:192, .cols, traceView name); P002 hints; absolute paths outside cwd.

## M0 · Done-check scripts exist and run (target 0:20)
- [x] M0-1 `scripts/phase1-coverage.ts` (D2): exit 1 and print `remaining: N` plus each item until Phase 1 is complete. Checks: (a) synthetic pipelines covering every manifest input/tap/transform/output/delivery check, every `then`, batch, lifetime max_packets/until, stall, fan-out, agent nodes, agent/agent_budget/retention blocks: `gaps()` must return nothing for each; (b) `bun pipo help` has no "Planned" line and every command in spec §6 answers `--help` with exit 0; (c) packages/engine, packages/ui, packages/vscode exist with package.json. Add a `coverage` script to package.json.
- [x] M0-2 `scripts/stress.ts` (D3): runs each file in a RESILIENCE list (start: `packages/runner/test/recovery.test.ts`) 5× with a per-run timeout; exit 0 only if all pass; prints a per-run summary. Later milestones append files (appending is allowed, removing or weakening needs approval). Add a `stress` script to package.json.
- [x] M0-3 Make sure `.epoptes/run/` and `.epoptes/cycles/` are gitignored; `bun run verify` and `bun run stress` pass.

## M1 · Connectors (spec §3.3–§3.5, §3.10) (target 2:20)
- [x] M1-1 Input `schedule` (cron + `every`, optional fixed `payload`), owned by the runner. A small 5-field cron parser of our own is preferred; croner (MIT) is acceptable.
- [x] M1-2 Inputs `watch` (glob, create/change/delete, read content|path) and `system` (cpu, memory, disk, battery, network samples).
- [x] M1-3 HTTP input extras: `csv` and `bytes` formats, HMAC signature auth, `respond: delivered` (wait for a terminal state up to `timeout`).
- [x] M1-4 Taps and transforms: `tap: http`, `transform: http` (the response becomes data), `tap: file`, `tap: emit`.
- [x] M1-5 Outputs: `file` (jsonl/json/csv/text, append/write, idempotent repeat-skip by packet_id) and `http` (Idempotency-Key header, `success` codes).
- [x] M1-6 Delivery checks: row_count, query, file_exists, file_nonempty, line_contains, checksum, status, follow_up (`external` comes in M3).
- [x] M1-8 Connector registry (`connectors/index.ts` maps kind → factory; runner.ts and support.ts read from it) so later connectors are added without touching runner.ts. Do with M1-5.
- [x] M1-9 [med] watch: persist the last-seen snapshot (path, mtime, size) in the journal and diff on start so files created/changed/deleted while the runner was down are emitted; then resolve spec §14.3 as a (harness, pending review) §13 row.
- [x] M1-7 Runnable examples: schedule→file and watch→http (against a local test server), each passing `pipo check`, with e2e tests.
- [x] M1-10 [med] foreground.ts: install the SIGTERM handler before writing the registry entry (today a SIGTERM right after the entry appears exits 143 and skips the drain); add a test.
- [x] M1-11 [low] packages/runner/src/index.ts: re-export InputState/InputRuntime types from connectors/types.ts.

## M2 · Delivery semantics (spec §3.5.1, §3.8, §3.10, §7.3) (target 3:50)
- [x] M2-1 Output batching for sqlite and file: flush at size/within, one transaction, split a failed batch in half repeatedly, flush on pause/stop/drain; SIGKILL mid-flush e2e test (builder-deep). Add it to stress.ts.
- [x] M2-2 Stall detection (`delivered.stall`: after, notify|pause, message with `stall.*`).
- [x] M2-3 `lifetime.max_packets` and `lifetime.until` with a `stats` context.
- [x] M2-4 Resolve spec §14.1 (fan-out idempotency) as a `(harness, pending review)` decision, then implement fan-out with packet branches in the journal (builder-deep), with a SIGKILL-during-fan-out e2e test in stress.ts.
- [x] M2-5 [low] stress.ts: on a timed-out run, keep and print the paths and last lines of that run's runner logs (a watch-replay 180s timeout in c3 could not be diagnosed).
- [x] M2-6 [med] Test hangs: recovery.test.ts lacks the never-opened-journal spawn retry (timed out 1/5 in a c3 stress run); batch tests (batch.test.ts + batch-recovery.test.ts) hung 1/3 in c3 qa. Add the retry helper (share it via test/helpers.ts) and find the batch hang. Do not weaken assertions.

## M3 · Engine control plane (spec §7) (target 6:20) — PAUSE FOR REVIEW AFTER
- [x] M3-1 Runner control socket (`<home>/run/<name>.sock`): status, pause, resume, drain, stop, push, ack. Enables the `push` input and the `external` delivery check. Registry entry gains `socket`.
- [x] M3-2 `packages/engine` (`pipod`) supervisor, part 1: package + bin, start runners as subprocesses (logs to <home>/logs), restart crashed ones with backoff, engine config/home, use runner ControlClient (packages/runner/src/control).
- [x] M3-8 Engine supervisor, part 2 (split from M3-2): registry discovery with socket `hello` handshake (name + version), replay missed events via `events` op (after_seq), clean stale entries, restart pipelines that were active.
- [x] M3-3 Gateway `/in/*` proxied to runners, REST `/api/*`, SSE `/events`; bind 127.0.0.1.
- [x] M3-4 Detached mode: runners outlive the engine; `--listen` saved in the registry; runner-owned lifetime and stall while the engine is down.
- [x] M3-5 Engine TTL (drains everything), idle sleep (§7.5), start on demand from the CLI.
- [x] M3-6 E2E: SIGKILL the engine with detached runners → runners keep delivering; engine restart reattaches with no loss or duplicates. (stress.ts line pending human: see M3-9)
- [x] M3-9 (F-2: human appended the five engine tests in 8a2cd78; c10 orchestrator appended stay-stopped, paused-crash, pause-recovery, dlq-recovery) Append `packages/engine/test/reattach.test.ts` and `packages/engine/test/gateway.test.ts` and `packages/engine/test/detached.test.ts`, `packages/engine/test/lifetime.test.ts` (c8), `packages/engine/test/engine-kill.test.ts`, `stay-stopped.test.ts`, `paused-crash.test.ts`, `packages/runner/test/pause-recovery.test.ts`, `dlq-recovery.test.ts` (c9) to RESILIENCE in scripts/stress.ts (appending is allowed by the run rules). The human should add it, or allow the edit.
- [x] M3-10 [med] runner http input (packages/runner/src): set Bun.serve idleTimeout above the longest `respond: delivered` wait (default 10 s cuts it off), and drop the stale "engine gateway is not built yet" message (found in M3-3).
- [x] M3-11 (from M4-1) pipod flags `--listen`/`--ttl` so the CLI needn't write config.yaml; when config.yaml exists without listen, CLI on-demand start should still get a gateway port. Fold into M3-5.
- [x] M3-12 [med] (from M4-1) runner stats add `in_per_min`, `last_delivery_at`, and a stalled/jammed note (node id) so `pipo status` fills IN/MIN, LAST DELIVERY and ⚠.
- [x] M3-7 Critic review of M3, file fixes, then `epoptes pause` for the human.

## M4 · Full CLI (spec §6, §10.2, §10.3) (target 7:50)
- [x] M4-1 start, stop, pause, resume, restart, status (table as in §6), logs; `--json` everywhere; `--no-engine` talks to runner sockets.
- [x] M4-2 packets, inspect (full trace), dlq (list, replay, purge), push, ack.
- [x] M4-3 history, diff, rollback (split: runners/attach/engine → M4-3a)
- [x] M4-3a runners, attach, engine start|stop|status (+R-6, R-7 part: --json errors, listen rule, unknown keys; start --ttl refused for now → M4-9)
- [ ] M4-9 (from R-7) engine-side `start --ttl` pipeline lifetime override (supervisor → runner --ttl, registry)
- [x] M4-4 new and generate node with built-in templates (webhook-to-sqlite, cron-to-file, watch-to-http, agent-classifier, blank), templates (incl. user templates in ./.pipo/templates, ~/.pipo/templates).
- [x] M4-7 (split from M4-4) trust: content hash; untrusted fn modules refused by check and runner.
- [x] M4-6 Every §6 command answers `--help` with exit 0 (today `run --help` hangs, `check --help` exits 1).
- [ ] M2-7 [low] (moved from M2, needed by inspect) Spec §14.4: decide/implement a `meta.key` expression variable (resolved output key) so `delivered.with` lookups match fan-out copies; `journal.events(id)` could include copies' events (for pipo inspect, M4).
- [ ] M4-8 (split from M4-5) `pipo test`: in-process run against fixtures, outputs and taps mocked, agent stubs, snapshots (`--update-snapshots`), spec §10.3. Needs runner hooks (packages/runner/src).
- [x] M4-5 fmt (stable YAML formatting, D29). `test` split to M4-8.

## M5 · Agents (spec §3.4, §3.11, §9) (target 9:20)
- [x] M5-1 Agent nodes with the `claude` provider behind an injectable client; tests use a mocked provider only (no live calls); output-schema validation, timeout, max_tokens; cost from an engine-config price table.
- [x] M5-2 `agent_budget`: per-packet token cap → dead-letter; per-day cap → pause with reason `budget`, resume at `reset_at`; `warn_at` event.
- [ ] M5-5 [med] (from M5-2) enforce engine-wide `engine.agent_budget.per_day` (parsed, warn gap today); show agent spend in `pipo status`; a runnable agent example (mock-friendly).
- [ ] M5-3 MCP endpoint `/mcp` (tools and resources from §9.2), scoped tokens, redaction.
- [ ] M5-4 Change protocol (§9.3): propose → validate against `agent.edit` → optional dry run → apply at a safe point as a new version → audit and rollback; `then: agent`, `on_stall: handle`.

## M6 · Retention and observability (spec §3.12, §7.6) (target 9:50)
- [x] M6-1 Retention clean-up and daily compaction with the §3.12 defaults.
- [ ] M6-2 Built-in metrics (stats in /api, §7.6). [cut: OTLP/HTTP export — c9, schedule (~35 min behind, 2h16m to wrap-up); no done check needs it]

## M7 · Dashboard UI, Phase 1 (spec §8) (target 10:50)
- [x] M7-1 `packages/ui` served at `/ui`: pipeline list, live graph with per-node counters, packet inspector.
- [ ] M7-2 Logs, DLQ with replay, version history with diffs, agent activity feed, pause/resume/drain controls; light and dark themes; critic review.

## M8 · Editor support (spec §10.1) (target 11:35)
- [x] M8-1 `packages/vscode`: registers `.pipo`, attaches the schema, highlights `${…}` templates and expressions.
- [cut] (c8: ~1h behind at end of M3; D2 only needs packages/vscode) M8-2 Pipo language server: `from` completion, go-to-definition for `fn.*`, live `pipo check` diagnostics, quick fixes.
