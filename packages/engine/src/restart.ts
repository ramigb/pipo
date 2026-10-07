// Restart policy for crashed runners (docs/spec.md §7.1, D25): exponential backoff from `backoff`, doubling up to
// `max_backoff`, back to `backoff` after a run of at least `stable`; more than `max_restarts` restarts within
// `window` gives up. Pure, so the numbers are tested without processes.
import type { RestartConfig } from "./config";

export type RestartDecision = { restart: true; delay: number; attempt: number } | { restart: false; restarts: number };

export class RestartTracker {
  /** Times of the restarts still inside the window. */
  private recent: number[] = [];
  /** Crashes since the last stable run; sets the next delay. */
  private streak = 0;

  constructor(private readonly cfg: RestartConfig) {}

  /** A runner exited without being asked to, after being up for `upFor` ms (0 when it never came up). */
  onCrash(now: number, upFor: number): RestartDecision {
    if (upFor >= this.cfg.stable) this.streak = 0;
    this.recent = this.recent.filter((t) => now - t < this.cfg.window);
    if (this.recent.length >= this.cfg.max_restarts) return { restart: false, restarts: this.recent.length };
    const delay = Math.min(this.cfg.backoff * 2 ** this.streak, this.cfg.max_backoff);
    this.streak++;
    this.recent.push(now);
    return { restart: true, delay, attempt: this.recent.length };
  }
}
