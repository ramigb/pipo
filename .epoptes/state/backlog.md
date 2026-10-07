# Backlog: Phase 1 ledger

**Current milestone: Wrap-up**   (the orchestrator moves this line forward)

**Markers:** `[ ]` todo · `[~]` in progress · `[x]` done · `[blocked: why]` · `[cut]`
**Notes:** IDs are stable; new tasks get the next free number. Parallel tasks must own separate files. Each task names its ledger item (docs/phase1-ledger.md); tick both together.

## M1 · Decisions in the spec + bugs (target 0:45)
- [x] M1-1 (L-01..L-04, L-22) spec edits for the human's 2026-10-04 decisions: §13 rows `(human, 2026-10-04)`, remove `(harness, pending review)` from D14–D40, narrow §7.6 (OTLP → Phase 2), reword §7.4/§7.5 to D30/D31 and close §14.5, §14.4 → meta.key, §14.2/§14.3/§14.6 closed into a "Phase 2" list in §12 · builder · owns docs/spec.md
- [x] M1-2 (L-05) anchor pipeline TTL to the first `pipeline.started` since the last clean stop; e2e SIGKILL test (ttl 3s, kill ~2s, drains ~3s total), appended to scripts/stress.ts RESILIENCE · builder-deep
- [x] M1-3 (L-06) SSE replay skip = max(cursor, after.seq); reconnect test with Last-Event-ID at latest seq · builder
- [x] M1-4 (L-07) remove the registry entry when a stopped pipeline settles, whatever its prior state; test: stop a crashed pipeline, new engine restarts nothing · builder-deep (supervisor)
- [x] M1-5 (L-08) `--json` usage errors get `hint: "run pipo <cmd> --help"` via packages/cli/src/errors.ts · builder
- [x] M1-6 run `bun scripts/stress.ts` after M1-2/M1-4 · qa (c14: 89/90, gateway 1 flake → R-30/R-31; rerun after M2-3); c15: 99/100, ttl-anchor SQLITE_BUSY_RECOVERY on reopen → R-32

## M2 · Agent change protocol, L-09 (target 3:15)
- [x] M2-1 proposal store and validation: patch against version N, `pipo check` + `agent.edit` path policy (output, delivered, secrets, agent always forbidden), audit record (author, reason, diff) · builder-deep
- [x] M2-2 dry run: `agent.verify: last N` replays delivered packets with outputs mocked; also add `agent_budget` to the always-forbidden agent paths (new §14 question + D47 harness row + `epoptes event note`; M2-1 found `edit: ["*"]` lets an agent raise its own budget) · builder-deep
- [x] M2-3 apply at a safe point as version N+1 (in-flight packets stay on N, D38), rollback; e2e SIGKILL during apply · builder-deep
- [x] M2-4 `then: agent` in every policy position (errors, output.on_error), `delivered.stall.then: agent`, `agent.on_stall: handle`; remove the gaps in support.ts · builder-deep
- [x] M2-5 REST + runner control ops, `pipo proposals <name>` (approve/reject when `approve: human`), `--json` · builder
- [x] M2-6 critic review of the change protocol (versions, crash safety) · critic

## M3 · `pipo test`, L-10 → D2 green (target 4:30)
- [x] M3-1 runner hooks to inject mock outputs/taps and stub agent nodes from recorded responses · builder-deep
- [x] M3-2 `pipo test` command: fixtures, snapshots (`--update-snapshots`), `--json`; fixtures for every example so `bun pipo test examples/...` passes · builder
- [x] M3-3 remove the `Planned` section from `pipo help` (packages/cli/src/commands.ts); qa confirms `bun scripts/phase1-coverage.ts` exits 0 (D2) · builder + qa

## M4 · MCP + metrics, L-11 L-12 (target 6:00)
- [x] M4-1 (L-12) per-node latency and oldest-pending age in runner `stats`, `/api`, `pipo status` · builder-deep
- [x] M4-2 (L-11) `/mcp` endpoint with `@modelcontextprotocol/sdk` (MIT, log in §13): §9.2 tools and resources, scoped tokens (`op://`/`env:`), redaction of secrets and `agent.redact`; in-process MCP client test · builder-deep
- [x] M4-3 run `bun scripts/stress.ts` · qa (c18: 110/110)

## M5 · Smaller features (target 7:15)
- [x] M5-1 (L-14) `meta.key` expression variable; `pipo inspect` shows copies' events · builder
- [x] M5-2 (L-17) P039 duplicate `listen` port warning in check.ts, spec §5, CLAUDE.md codes · builder
- [x] M5-3 (L-16) `pipo start --ttl` through supervisor and registry, works with anchored TTL · builder-deep
- [x] M5-4 (L-15) engine-wide `agent_budget.per_day`, spend in `pipo status`, runnable agent example with the mocked provider · builder

## M6 · Dashboard, L-13 (target 8:00)
- [x] M6-1 `scripts/ui-shots.ts`: headless Chrome screenshots of every view at 375/1440 px, light and dark, into /tmp/pipo-ui-shots/ (see loop.md §4) · builder
- [x] M6-2 live logs, agent activity + proposals feed, lifetime remaining in the list (API exposes it) · builder
- [x] M6-3 critic UI review from screenshots; fix to ≥ 7 · critic + builder

## M7 · Quality, L-18..L-20 (target 8:50; cut first)
- [x] M7-1 (L-20) UI dead code (check first), P002 hints, absolute paths for files outside cwd · builder
- [x] M7-2 (L-18) content hashes of fn/schema files per version, warn on mismatch; structured diagnostics on failed live apply · builder-deep
- [x] M7-3 (supervisor.ts half; runner.ts half [cut] time box) (L-19) split runner.ts and supervisor.ts by concern, no behaviour change; D1 + D3 green · builder-deep

## Wrap-up (from 8:50)
- [x] W-1 (L-21, L-23) roadmap, README, CLAUDE.md, spec §12 match the code
- [x] W-2 final D1–D3, screenshots, critic D4 + D5, ledger hand-over table

## Feedback (from `epoptes feedback`)

## Review fixes
- [blocked: no repro in ~1100 runs; likely Bun /mnt hang, see R-31/R-32] R-30 [high] engine: `start` right after `stop` intermittently 500s (stress c14 gateway.test.ts 1/5 fail; suspect D46 settle/cleanup race) · builder-deep (for D3)
- [x] R-31 [med] engine tests leak runner/engine processes (found 4 alive, hours old, 2 at 100% CPU: `twice` from engine-kill/supervisor/gateway tests, `loose` ttl-h from lifetime.test.ts); kill everything started by pid in afterAll; gateway.test.ts start assertion shows the response body on failure · builder (for D3)
- [x] R-32 (in M2-4) [med] runner journal.ts: set `busy_timeout` before `PRAGMA journal_mode = WAL` (R-30 saw ~0.1% 'database is locked' on concurrent opens) · after M2-3 lands (for D3)
- [x] R-33 [high] runner/engine: read-only journal opens (versions.ts peek, control/reads.ts, engine events.ts/graph.ts) fail `SQLITE_BUSY_RECOVERY` right after a SIGKILL (stress c16 ttl-anchor 1/5: restart died in planStart→peek); set busy_timeout + `retryBusy` on every read-only open · builder (for D3)
- [x] R-34 [high] runner proposals: a crash/stop mid dry run strands an agent proposal `validated` (no public rerun; D48 says rerunnable). `apply_proposal` runs the dry run itself when `verify` is set and the proposal is validated, then applies; fix hints; SIGKILL e2e through the public op (runner.ts:814, proposals.ts:617, ops.ts:334) · builder-deep (M2-6)
- [x] R-35 [med] spec: `author_kind` is self-declared over REST/ops until MCP tokens (L-11); say so in D51 or §14, and in the support.ts agent warning · with L-11 (M2-6)
- [x] R-36 [med] redaction: resolve `reason`/`by` (runner.ts:1399) and proposal `author`/`by` (proposals.ts:491, 673) go to the journal unredacted; redact + tests (M2-6)
- [x] R-37 [med] REST resolve: default `by_kind` human (gateway.ts:689); happy-path tests resolving a real escalated unit via REST (retry) and `pipo resolve` (dead_letter) (M2-6)
- [x] R-38 [med] CLI `pipo proposals propose` exits 0 on rejected/apply_error → exit 1; document `--limit` (cli/src/proposals.ts:150, commands.ts) (M2-6)
- [x] R-39 [low] runner: pass `home` to check() in applyVersion (runner.ts:672) and open (runner.ts:258), as proposals do (M2-6)
- [x] R-40 [low] stale task ids in comments (proposals.ts:20, proposal-apply-recovery.test.ts:126); escalation code out of runner.ts → part of M7-3 (M2-6)
- [x] R-41 [med] tests still leak engines: an engine on `<tmp>/up-home` (main checkout) ran 1h33m at 100% CPU after a test run; find the test using `up-home`, kill what it starts by pid in afterAll (as R-31) · builder (for D3)
- [x] R-42 [high] ui: 375 px actions/key columns clipped in scrolled tables (DLQ Replay, versions diff/rollback, agent cols, packets source); `opt` class on secondary cols, nowrap time cells, actions in first column below 600 px (app.js, style.css) (M6-3, for L-13)
- [x] R-43 [med] ui: number column headers miss `num`; one `thead(cols,numIdx,optIdx)` helper; version as `v2` + `current` pill (M6-3)
- [x] R-44 [med] ui: DLQ error unreadable (truncated, packet id prefix); wrap 2 lines, drop prefix / show rule; Replay in inspector for dead_lettered (M6-3)
- [x] R-45 [med] ui: packet inspector thin: dense header (state·v·source·received·key·total ms), per-step "data unchanged" vs patch (M6-3)
- [x] R-46 [med] ui: every SSE event re-renders #app (selection/scroll lost), N+1 /api calls; filter by pipeline, skip finished packets, per-pipeline stats in GET /api/pipelines (gateway.ts ~550) (M6-3)
- [x] R-47 [med] ui: ui-shots misses diff open, proposal expanded, paused banner, escalations, dead-lettered inspector, hostile data; add them + test that app.js never uses innerHTML (M6-3)
- [x] R-48 [low] ui: 375 px graph cut off; stack layers vertically or scale SVG (M6-3)
- [x] R-49 [low] ui: theme button shows mode, "pipeline(s)", "lifetime left" header, caret on proposal rows, confirm on Drain (M6-3)
- [x] R-50 [med] ui 375 px: expanded proposal row and version diff overflow sideways (`.diff div {white-space:pre}`); own scroll box or detail below table (style.css:315, app.js:592-604) (M6 c20)
- [x] R-51 [med] ui/api: "pending" inconsistent: list uses in_flight (no escalated), oldest-pending uses PENDING; use sum(PENDING) or add escalated count (app.js:240, engine dashboard.ts:76) (M6 c20)
- [x] R-52 [med] ui: escalated/accepted/processing/branched have no `s-*` colour; escalated amber; show held/escalated count on graph node (style.css:156-171, app.js:390) (M6 c20)
- [x] R-53 [low] ui inspector: skip input-step data equal to payload, show patch, no "data unchanged" on dead-lettered step, errText on inspector error line (app.js:859-885) (M6 c20)
- [x] R-54 [low] ui header: one status (paused overrides running) + Resume; DLQ meta drop duplicated node (app.js:428, 713) (M6 c20)
- [x] R-55 [low] ui-shots: update theme button label after setting theme; real hostile data in hostile-list (scripts/ui-shots.ts:313, 325) (M6 c20)
- [x] R-56 [med] cli: ERR_PARSE_ARGS_* → usageError (names flag, hint `pipo <cmd> --help`, exit 64, code usage) (cli.ts:27) (final)
- [x] R-57 [med] cli: missing path → CliError with hint, as test-cmd.ts:36 (cli.ts:126) (final)
- [x] R-58 [med] spec tests: assert P015 P017 P023 P024 P030 P035 P036 in check.test.ts (final)
- [x] R-59 [med] ui: clamp packet-list source cell (ellipsis + title), inspector source overflow-wrap:anywhere (app.js:850, 908) (final)
- [x] R-60 [low] cli: `pipo run --json` or note the exception in §6; README:49 agree (final)
- [x] R-61 [low] cli: top-level help rows ≤ ~100 cols (final)
- [x] R-62 [low] spec: explain skipped D56 in §13 (final)
