// `agent_budget` (docs/spec.md §3.11, D37). Every number comes from the journal's `agent_spend` rows, so a restart
// (clean or a crash) never resets a packet's tokens or the day's spend. The runner applies the outcomes: a
// `budget.packet` dead letter, a `budget` pause until the next window, a `budget.warning` event. The engine-wide cap
// (`engine.agent_budget.per_day`, D58) is checked the same way, against the sum of every journal of the home.
import { join } from "node:path";
import type { Pipeline } from "@pipo/spec";
import type { Journal } from "../journal";
import { engineWindow, homeAgentSpend } from "./home-spend";
import { type BudgetWindow, budgetWindow } from "./window";

/** Which cap a `budget` pause came from: the pipeline's `agent_budget.per_day`, or `engine.agent_budget.per_day`. */
export type BudgetCap = "pipeline" | "engine";

export interface EngineCap {
  /** The Pipo home whose pipeline journals share the cap. */
  home: string;
  /** This pipeline's name: its own spend is read through its open journal. */
  name: string;
  per_day: number;
}

/** A budget limit stops the call. Never retried: the same packet would hit the same limit. */
export class BudgetStop extends Error {
  readonly final = true;
  constructor(
    readonly kind: "packet" | "day",
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BudgetStop";
  }
}

const iso = (ms: number) => new Date(ms).toISOString();
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export class AgentBudget {
  /** Start of the window a manual `pipo resume` overrode the daily cap for (§3.11): no budget pause until it ends. */
  private override?: number;
  /** Start of the engine budget day a manual resume of an engine-cap pause overrode (D58). */
  private engineOverride?: number;
  /** Start of the window a `budget.warning` was already emitted for. */
  private warned?: number;

  constructor(
    private readonly journal: Journal,
    private readonly limits: () => Pipeline["agent_budget"],
    readonly timezone: string,
    private readonly now: () => number,
    readonly engine: EngineCap | null = null,
  ) {
    // The latest override of each cap, whatever plain resumes came after it (only the current day's one applies).
    const resumed = journal.lastPipelineEventWith("pipeline.resumed", "budget_override")?.detail as {
      budget_override?: string;
    } | null;
    if (resumed?.budget_override) this.override = Date.parse(resumed.budget_override);
    const engineResumed = journal.lastPipelineEventWith("pipeline.resumed", "engine_budget_override")?.detail as {
      engine_budget_override?: string;
    } | null;
    if (engineResumed?.engine_budget_override) this.engineOverride = Date.parse(engineResumed.engine_budget_override);
    const warned = journal.lastPipelineEvent("budget.warning")?.detail as { window_start?: string } | null;
    if (warned?.window_start) this.warned = Date.parse(warned.window_start);
  }

  window(): BudgetWindow {
    return budgetWindow(this.now(), this.timezone, this.limits()?.reset_at);
  }

  spentToday(): number {
    return this.journal.agentSpendSince(this.window().start);
  }

  /**
   * Throws BudgetStop("day") when a daily cap is used up and not overridden for its window: the pipeline's first, then
   * the engine's (D58). Checked before each call, so calls already under way (in any runner of the home) can go over.
   */
  checkDay(): void {
    const perDay = this.limits()?.per_day;
    if (perDay !== undefined) {
      const w = this.window();
      if (this.override !== w.start) {
        const spent = this.journal.agentSpendSince(w.start);
        if (spent >= perDay) {
          throw new BudgetStop(
            "day",
            `agent spend today ${usd(spent)} reached agent_budget.per_day ${usd(perDay)}; resumes at ${iso(w.end)}`,
            {
              cap: "pipeline",
              resume_at: iso(w.end),
              window_start: iso(w.start),
              spent_usd: round(spent),
              per_day: perDay,
            },
          );
        }
      }
    }
    const e = this.engine;
    if (!e) return;
    const w = this.engineWindow();
    if (this.engineOverride === w.start) return;
    const per = homeAgentSpend(e.home, w.start, { name: e.name, db: this.journal.db });
    const spent = Object.values(per).reduce((a, b) => a + b, 0);
    if (spent < e.per_day) return;
    throw new BudgetStop(
      "day",
      `agent spend today across all pipelines of this Pipo home ${usd(spent)} reached engine.agent_budget.per_day ${usd(e.per_day)}; resumes at ${iso(w.end)}. To allow more today, raise engine.agent_budget.per_day in ${join(e.home, "config.yaml")} and restart the pipeline`,
      {
        cap: "engine",
        resume_at: iso(w.end),
        window_start: iso(w.start),
        spent_usd: round(spent),
        per_day: e.per_day,
        pipeline_spent_usd: round(per[e.name] ?? 0),
      },
    );
  }

  /** The engine budget day (D58): midnight to midnight in the engine's time zone. */
  engineWindow(): BudgetWindow {
    return engineWindow(this.now(), this.timezone);
  }

  /** Tokens the packet used so far; throws BudgetStop("packet") when it already reached `per_packet`. */
  checkPacket(root: string, perPacket: number | undefined): number {
    const used = this.journal.packetAgentTokens(root);
    if (perPacket !== undefined && used >= perPacket) throw packetStop(used, perPacket);
    return used;
  }

  /** After a recorded call: the `budget.warning` detail when spend just crossed `warn_at` for this window. */
  warning(): Record<string, unknown> | null {
    const b = this.limits();
    if (b?.per_day === undefined || !b.warn_at) return null;
    const w = this.window();
    if (this.warned === w.start) return null;
    const spent = this.journal.agentSpendSince(w.start);
    const pct = Number.parseFloat(b.warn_at);
    if (spent < (b.per_day * pct) / 100) return null;
    this.warned = w.start;
    return {
      spent_usd: round(spent),
      per_day: b.per_day,
      warn_at: b.warn_at,
      window_start: iso(w.start),
      resets_at: iso(w.end),
      message: `agent spend today ${usd(spent)} is ${b.warn_at} or more of agent_budget.per_day ${usd(b.per_day)}`,
    };
  }

  /**
   * A manual resume of a `budget` pause goes over the cap that paused it until that cap's day ends; the other cap
   * still applies. Returns the window.
   */
  overrideToday(cap: BudgetCap = "pipeline"): BudgetWindow {
    if (cap === "engine") {
      const w = this.engineWindow();
      this.engineOverride = w.start;
      return w;
    }
    const w = this.window();
    this.override = w.start;
    return w;
  }
}

export function packetStop(used: number, perPacket: number): BudgetStop {
  return new BudgetStop("packet", `packet used ${used} agent tokens, reaching agent_budget.per_packet (${perPacket})`, {
    tokens: used,
    per_packet: perPacket,
  });
}

export const round = (n: number) => Math.round(n * 1e6) / 1e6;
