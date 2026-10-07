// What a runner with agent nodes reads from `<home>/config.yaml` (docs/spec.md §3.11, D36): the `agents:` map, and
// `engine.timezone` / `engine.agent_budget` (D58). The engine validates the whole file before it starts a runner; `pipo
// run` gets the same checks here, limited to these keys.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentsConfig, isTimeZone, load, parseAgentsConfig } from "@pipo/spec";
import { systemTimeZone } from "./window";

export interface AgentSettings {
  agents: AgentsConfig;
  timezone: string;
  /** `engine.agent_budget`: the cap on the whole home's agent spend per day (§3.11, D58), or null. */
  engineBudget: { per_day: number } | null;
}

export function readAgentSettings(home: string): { settings: AgentSettings; problems: string[] } {
  const file = join(home, "config.yaml");
  const problems: string[] = [];
  let raw: Record<string, any> = {};
  if (existsSync(file)) {
    try {
      const loaded = load(readFileSync(file, "utf8"), file);
      const d = loaded.diagnostics[0];
      if (d) problems.push(`${file}:${d.line}:${d.col} ${d.message}`);
      else if (loaded.value && typeof loaded.value === "object") raw = loaded.value as Record<string, any>;
      const parsed = parseAgentsConfig(raw.agents);
      for (const p of parsed.problems) {
        const at = loaded.locate(p.path, p.key);
        problems.push(`${file}:${at.line}:${at.col} ${p.message}`);
      }
      const tz = raw.engine?.timezone;
      if (tz !== undefined && tz !== null && (typeof tz !== "string" || !isTimeZone(tz))) {
        const at = loaded.locate(["engine", "timezone"]);
        problems.push(`${file}:${at.line}:${at.col} engine.timezone must be an IANA time zone such as UTC`);
      }
      // The same rule as the engine's config check (packages/engine/src/config.ts), so `pipo run` refuses the same file.
      const budget = raw.engine?.agent_budget;
      let engineBudget: AgentSettings["engineBudget"] = null;
      if (budget !== undefined && budget !== null) {
        const isMap = typeof budget === "object" && !Array.isArray(budget);
        const perDay = isMap ? budget.per_day : undefined;
        const extra = isMap ? Object.keys(budget).filter((k) => k !== "per_day") : [];
        if (!isMap || typeof perDay !== "number" || !(perDay >= 0) || extra.length) {
          const at = loaded.locate(["engine", "agent_budget"]);
          problems.push(
            `${file}:${at.line}:${at.col} engine.agent_budget must be { per_day: <USD> } (a number ≥ 0), got ${JSON.stringify(budget)}`,
          );
        } else engineBudget = { per_day: perDay };
      }
      return {
        settings: {
          agents: parsed.value,
          timezone: typeof tz === "string" && isTimeZone(tz) ? tz : systemTimeZone(),
          engineBudget,
        },
        problems,
      };
    } catch (e) {
      problems.push(`cannot read ${file}: ${(e as Error).message}`);
    }
  }
  return {
    settings: { agents: parseAgentsConfig(undefined).value, timezone: systemTimeZone(), engineBudget: null },
    problems,
  };
}
