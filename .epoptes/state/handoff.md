# Handoff (end of run r2, c23): Phase 1 complete
End state: every `docs/phase1-ledger.md` item is [x] (the runner.ts half of L-19 is [cut] to Phase 2). D1: verify passed 681/681 (c23; one run before it hit a `lifetime.test.ts` pipod-start timeout from the Bun load hang, which cleared on rerun). D2: coverage remaining 0 (c22). D4: final critic (c21) scored ≥ 7 on every criterion. D5: met per the c21 critic.
D3 (c23): full stress 119/120. The one failure was `ttl-anchor` run 4, a test bound that assumed a prompt restart (the restart hit the module-load hang and started after the ttl). The bound is now conditional, and `ttl-anchor` passed 5/5 on its own. A clean full 5× stress rerun hasn't been done since that fix: the first job for the next run.
For the human to review: §13 rows D50–D60, marked (harness, pending review).
Gotchas: the next §13 row is D61, the next §14 is 9, the next P-code is P056. Bun on /mnt hangs on ~3% of spawns: rerun once before filing. Start a stress run at the top of a cycle; the runner kills background jobs when a cycle ends.

Top 10 next tasks (Phase 2 candidates):
1. Rerun `bun run stress` (expect 120/120) and update the ledger's D3 row.
2. Review and settle D50–D60 (remove the pending-review markers or change behaviour).
3. Split runner.ts by concern (the runner half of L-19), no behaviour change, stress green.
4. OTLP export (moved out of §7.6) on top of the built-in metrics (D54).
5. §14.2 and §14.3 (moved to Phase 2 by the human).
6. Multiple outputs (`outputs:` map) and http batch mode.
7. postgres / mqtt / s3 / queue connectors via a connector SDK.
8. join / window nodes.
9. Visual editor on top of the dashboard graph; editor language server.
10. Bind MCP tokens to identity so `author_kind`/`by_kind` stop being self-declared over REST (R-35 note); find the test that leaks runner/engine processes.
