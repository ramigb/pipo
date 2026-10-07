# Decisions
Append-only. Each entry: date · decision · why. To change one, add an entry that supersedes it.

## 2026-10-03 · Kickoff (from the interview)
- Runtime Claude Code; orchestrator opus/high; builder sonnet/medium; builder-deep opus/high for engine, journal and change-protocol work; qa haiku/low; critic opus/high at M3, M7 and final · the user's choice; the engine and resilience work needs judgement.
- Time box 12h active, wrap-up 80 min, grace 40 min, early finish on; no per-cycle dollar cap · the user's choice.
- Done = D1 `bun run verify`, D2 `bun scripts/phase1-coverage.ts`, D3 `bun scripts/stress.ts`, D4 critic ≥ 7 on every criterion · machine-checkable where possible.
- Checkpoints: git commits per verified task on `main`, never push · the repo exists (foundation commit 795244c).
- Pause for human review after M3 (engine) · the most architectural piece; the user wants to review it before the CLI, agents and UI build on it.
- Scope cuts come from the end of the roadmap (M8, M7 polish, M6) when more than 45 min behind · M1–M5 are the core.
- Spec §14 open questions: the orchestrator decides, logs a `(harness, pending review)` §13 row, implements, and sends a `note` event; any other spec behaviour change needs approval · the user's choice.
- New dependencies: permissive licences only (MIT, Apache-2.0, BSD, ISC), each logged here with why; anything else needs approval · the user's choice.
- No live Claude API calls; agent nodes are tested with a mocked provider · spending money needs approval.
- UI bar: a clean developer tool (Temporal/Inngest-like), plain TypeScript or Preact, light and dark · the user's choice.
- Notifications on milestone, blocked and done; the user checks in through the dashboard or `epoptes feedback` · the user's choice.
- c4: scripts/stress.ts gained a startup watchdog (M2-6): if `bun test` creates no sandbox and no runner log within 45 s it is killed and restarted (≤3 tries) — a Bun module-load hang, not a test result. No assertions or run counts changed. Flagged for human review since stress.ts is a done check.
- c9: cut the OTLP/HTTP export half of M6-2 for schedule (~35 min behind M4 target with 2h16m to wrap-up; D2 needs agents, retention, ui and vscode packages, none need OTLP). Built-in metrics stay.

## 2026-10-04 · Job 2 "Phase 1 ledger" (from the interview)
- Work list is docs/phase1-ledger.md; backlog tasks map to L-nn items and both are ticked together · the user's hand-over document.
- L-01 (b): build metrics (L-12) and MCP (L-11) now, OTLP to Phase 2 · L-02 keep D30 (runners own their timers) · L-03 accept D14–D40 as they are · L-04 meta.key yes, §14.2/§14.3 to Phase 2 · the human's answers; recorded in spec §13 as `(human, 2026-10-04)`, no approval needed for those edits.
- Time box 10h, wrap-up 70 min, grace 40 min; no review pauses; cycle timeout stays 90 min (r1: 8% timeouts) · the user's choice.
- Done = D1 verify, D2 coverage, D3 stress, D4 critic ≥ 7 with the UI judged from headless-Chrome screenshots (375/1440, light/dark), D5 ledger complete and docs match code · the user's choice.
- UI checked with the installed google-chrome / cached Playwright Chromium, no new dependency · the user's choice.
- Critic reviews at M2 (change protocol), M6 (UI) and final; critic maxTurns 25 → 35 for screenshots.
- Cut order when > 45 min behind: M7 (L-19, L-18, L-20), then L-16, then L-15; never L-05..L-11 or resilience tests.
- 2026-10-04 c18: lifetime.test.ts 'engine.ttl from --ttl' timed out once in verify (50s wait for pipod ttl) right after M5-3; 3/3 reruns pass. Watch for recurrence (stress run 2).
- c20: L-19 runner.ts split cut (scope control order: L-19 first; 21 min to wrap-up, would need builder-deep ~40 min + stress ~25 min). supervisor.ts split done.
