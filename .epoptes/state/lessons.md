# Lessons
Rules learned the hard way (≤ 30 lines). Add one only when a mistake cost more than one fix round and could recur. Replace stale ones.
- Workers run `bun run format` repo-wide; in parallel rounds tell them to format only their own files (`bunx biome format --write <paths>`).
- Give §13 D-numbers in the brief (next free one per worker) — parallel workers otherwise pick the same number.
- Bun on /mnt sometimes hangs at 100% CPU loading modules (~3% of spawns). E2E tests that spawn runners must retry a runner that never opened its journal; a whole `bun test` hang is a flake, rerun once before debugging.
- Long builder-deep tasks with SIGKILL e2e take ~45 min; don't pair them late in a cycle.
- qa misreports exit codes when it pipes output; in qa briefs ask for `cmd > /tmp/x.txt 2>&1; echo "exit=$?"`. A single coverage `--help` timeout is usually the Bun /mnt load hang: rerun before filing.
- Workers must never run `git stash`/`git checkout`/`git restore` in a parallel round (R-1 worker stashed while M3-8 was running). Put "no git commands that touch the worktree" in parallel briefs.
- Before blaming the Bun /mnt load hang for an e2e flake, instrument the test helper: R-13 (2 cycles) was a fixed packet-number budget in the test running out, not Bun or the engine.
- qa (20-turn cap) can't babysit `bun scripts/stress.ts` and runs out on verify + 2 extras; give it ≤ 3 commands, or run verify yourself in one Bash call (timeout 600000) when time is short. The orchestrator runs stress itself with Bash `run_in_background`.
- Main checkout busy (stress run, another worker)? Dispatch with Agent `isolation: worktree`, qa-verify inside the worktree, then cp its changed files into main and commit only those paths. `git worktree remove` is denied: leftovers stay in .claude/worktrees (in .git/info/exclude).
- Engine tests leak runner/engine processes (R-31): before stress, list `bun …/packages/(runner|engine)/src/main.ts` processes with /tmp homes and kill them by pid.
- A worker's report can describe work that isn't on disk (c19 M6-3b: clean worktree, no logs). Before merging, check `git -C <wt> status --short` and the timestamps of the /tmp verify logs; ask for real command output in the report.
- SIGKILL e2e timing bounds must allow a restart that starts late (Bun /mnt load hang): bound the drain from `max(deadline, restart)`, not from the first start.
