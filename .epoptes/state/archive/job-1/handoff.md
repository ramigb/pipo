# Handoff (end of cycle 12: wrap-up, end state of run r1)
D1 verify green (485 tests). D2 coverage: 4 remaining (agent change protocol, `pipo test`). D3 stress 80/80 (c12, engine-kill fixed). Final critic (D4): spec 7, resilience 8, DX 7, ui 4 (scored before R-16), code 7 → D4 not met on ui.

## End state
- Packages: spec, runner, cli, engine (supervisor, control socket, gateway, reattach, detached), ui (/ui, `pipo ui`), vscode. README/CLAUDE.md/roadmap are current (25d8c99).
- c12: R-13 (engine-kill flake: test packet budget ran out; fixed in the test, assertions unchanged), R-14/R-15 (CLI --json errors, CLI-worded hints), R-16 (UI: list stats, pause/resume/drain, DLQ replay, versions/diff/rollback tabs, responsive; not viewed in a real browser).

## For the human: decisions pending review
- §13 D14–D40 are all marked (harness, pending review); the most consequential are D22 (fan-out keys), D30 (detached runners keep their own clocks, see §14.5), D38 (file vs rollback at start), D39 (retention), D40 (UI serving).
- §14.6 (new, blocked): narrow §7.6/§12 (OTLP export, MCP /mcp, per-node latency, oldest-pending age) to Phase 2, or build them?

## Top 10 next tasks
1. M5-4 agent change protocol: proposals, `then: agent`, `agent` block (3 of the 4 D2 items).
2. M4-8 `pipo test` (the last D2 item; help still says Planned).
3. Re-run the critic on the UI after R-16, then add live logs and the agent/proposal feed (§8), plus lifetime remaining in the list (needs it in the API).
4. M5-3 MCP server at /mcp (pending §14.6).
5. R-17 duplicate `listen` port warning across files in a project (P039).
6. M6-2 metrics: per-node latency and oldest-pending age in stats (§7.6, pending §14.6).
7. R-11 versions also store fn modules/schema files; structured diagnostics on live apply.
8. R-19 split runner.ts (1.8k lines) and supervisor.ts (1.6k); P002 hints; absolute paths outside cwd.
9. M4-9 `pipo start --ttl`; M5-5 engine-wide agent budget; M7-2 remaining UI.
10. Usage errors under --json have `hint: null`; give them a `pipo <cmd> --help` hint.

## Gotchas
- qa verify takes ~5 min; stress needs its own dispatch (~20+ min). Bun on /mnt hangs ~3% of spawns.
