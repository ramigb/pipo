// The engine-wide agent budget (docs/spec.md §3.11, D58): `engine.agent_budget.per_day` caps the agent spend of every
// pipeline of one Pipo home. There is no second store: the spend is the sum of the `agent_spend` rows of each journal
// under `<home>/pipelines/*/journal.db`, read when needed. A row is written in the transaction that journals the call
// (D36), so a crash can neither lose a recorded call from the total nor count it twice, detached runners and `pipo run`
// need no engine, and the engine's `pipo status` total is the same sum the runners check.
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openReadonly } from "../journal";
import { readAgentSettings } from "./settings";
import { budgetWindow } from "./window";

const NO_TABLE = /no such table/i;

/** USD spent on agent calls at or after `since` (ms), per pipeline name; `own` is read through its open connection. */
export function homeAgentSpend(
  home: string,
  since: number,
  own?: { name: string; db: Database },
): Record<string, number> {
  const dir = join(home, "pipelines");
  const out: Record<string, number> = {};
  let names: string[] = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {}
  for (const name of names) {
    if (own && name === own.name) {
      out[name] = sumSince(own.db, since);
      continue;
    }
    const path = join(dir, name, "journal.db");
    if (!existsSync(path)) continue;
    let db: Database | undefined;
    try {
      db = openReadonly(path);
      out[name] = sumSince(db, since);
    } catch (e) {
      // A journal from before agent nodes (D36) has spent nothing; anything else must not be read as $0.
      if (!NO_TABLE.test((e as Error).message)) {
        throw new Error(`cannot read the agent spend of '${name}' from ${path}: ${(e as Error).message}`);
      }
    } finally {
      db?.close();
    }
  }
  if (own && !(own.name in out)) out[own.name] = sumSince(own.db, since);
  return out;
}

function sumSince(db: Database, since: number): number {
  return (db.query("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM agent_spend WHERE at >= ?").get(since) as { c: number })
    .c;
}

export interface EngineSpend {
  /** `engine.agent_budget.per_day` (USD), or null when the engine config sets none. */
  per_day: number | null;
  /** USD spent by every pipeline of the home in the current engine budget day. */
  spent_usd: number;
  /** The engine budget day: a calendar day in `engine.timezone`, from midnight (ISO). */
  window_start: string;
  resets_at: string;
  timezone: string;
  /** Per pipeline name, in the same day (pipelines that spent nothing are left out). */
  pipelines: Record<string, number>;
}

/** The engine budget day containing `now`: engine-wide, so midnight in `engine.timezone` (no `reset_at`). */
export function engineWindow(now: number, timezone: string) {
  return budgetWindow(now, timezone);
}

/** What `pipo status` and `GET /api/agent-budget` show (D58). */
export function engineSpend(home: string, o: { per_day: number | null; timezone: string; now?: number }): EngineSpend {
  const w = engineWindow(o.now ?? Date.now(), o.timezone);
  const per = homeAgentSpend(home, w.start);
  const pipelines = Object.fromEntries(
    Object.entries(per)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => [k, round(v)]),
  );
  return {
    per_day: o.per_day,
    spent_usd: round(Object.values(per).reduce((a, b) => a + b, 0)),
    window_start: new Date(w.start).toISOString(),
    resets_at: new Date(w.end).toISOString(),
    timezone: o.timezone,
    pipelines,
  };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** `engineSpend` with the cap and time zone the home's config.yaml sets now: what a runner starting now would apply. */
export function homeAgentBudget(home: string, now?: number): EngineSpend {
  const { settings } = readAgentSettings(home);
  return engineSpend(home, { per_day: settings.engineBudget?.per_day ?? null, timezone: settings.timezone, now });
}
