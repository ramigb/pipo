// `via: schedule` (docs/spec.md §3.3, §7.4). The runner owns the timer. Each tick is handed to
// the runner's intake, which journals the packet; only then is the next fire armed. Fires missed
// while the runner was down or suspended are skipped, not replayed (spec §14).
import { formatDuration, nextCron, parseCron, parseDuration } from "@pipo/spec";
import type { InputAdapter, Intake } from "./types";

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** setTimeout can't wait longer than this; longer waits are re-armed. */
const MAX_WAIT = 2 ** 31 - 1;

export interface ScheduleInputOptions {
  cron?: string;
  every?: string;
  payload?: unknown;
  clock?: Clock;
  log?: (level: string, message: string) => void;
}

export class ScheduleInput implements InputAdapter {
  private readonly clock: Clock;
  private readonly cron?: ReturnType<typeof parseCron>;
  private readonly everyMs?: number;
  private timer: unknown;
  private stopped = true;
  private inflight: Promise<void> = Promise.resolve();
  private nextTick?: number;

  constructor(private readonly opts: ScheduleInputOptions) {
    this.clock = opts.clock ?? systemClock;
    if ((opts.cron === undefined) === (opts.every === undefined)) {
      throw new Error("schedule needs exactly one of `cron` or `every`");
    }
    if (opts.cron !== undefined) this.cron = parseCron(opts.cron);
    else {
      this.everyMs = parseDuration(opts.every as string);
      if (this.everyMs < 1) throw new Error("schedule `every` must be at least 1ms");
    }
  }

  describe(): string {
    const what =
      this.opts.cron !== undefined
        ? `cron '${this.opts.cron}' (UTC)`
        : `every ${formatDuration(this.everyMs as number)}`;
    return `schedule ${what}${this.nextTick ? `, next at ${new Date(this.nextTick).toISOString()}` : ""}`;
  }

  async start(intake: Intake): Promise<void> {
    this.stopped = false;
    this.arm(this.following(this.clock.now(), this.clock.now()).tick, intake);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    await this.inflight;
  }

  /** The first tick strictly after `tick` and not in the past; `missed` counts ticks skipped. */
  private following(tick: number, now: number): { tick: number; missed: number } {
    if (this.everyMs !== undefined) {
      const n = Math.max(1, Math.floor((now - tick) / this.everyMs) + 1);
      return { tick: tick + n * this.everyMs, missed: n - 1 };
    }
    const next = nextCron(this.cron as NonNullable<typeof this.cron>, Math.max(tick, now)) as number;
    return { tick: next, missed: 0 };
  }

  private arm(tick: number, intake: Intake): void {
    if (this.stopped) return;
    this.nextTick = tick;
    const wait = tick - this.clock.now();
    if (wait > MAX_WAIT) {
      this.timer = this.clock.setTimeout(() => this.arm(tick, intake), MAX_WAIT);
      return;
    }
    this.timer = this.clock.setTimeout(
      () => {
        this.inflight = this.fire(tick, intake);
      },
      Math.max(0, wait),
    );
  }

  private async fire(tick: number, intake: Intake): Promise<void> {
    const source = new Date(tick).toISOString();
    try {
      const r = await intake(structuredClone(this.opts.payload ?? {}), { trigger: "schedule", source });
      if (r.status !== "accepted") {
        const why = r.status === "rejected" ? r.message : r.reason;
        this.opts.log?.("warn", `schedule tick ${source} was not accepted: ${why}`);
      }
    } catch (e) {
      this.opts.log?.("error", `schedule tick ${source} failed: ${(e as Error).message}`);
    }
    // The packet is journaled (or refused) by now; arm the next tick from this one, not from the
    // clock, so a timer that fires a few ms early cannot produce the same tick twice.
    const next = this.following(tick, this.clock.now());
    if (next.missed > 0) this.opts.log?.("warn", `skipped ${next.missed} missed schedule tick(s) (no catch-up)`);
    this.arm(next.tick, intake);
  }
}
