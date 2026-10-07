// Error policies (docs/spec.md §3.9): retries with backoff, then a final action.
import { type ErrorPolicy, parseDuration } from "@pipo/spec";

export interface ResolvedPolicy {
  retry: number;
  backoff: "fixed" | "exponential";
  delay: number;
  maxDelay: number;
  then: NonNullable<ErrorPolicy["then"]>;
  message?: string;
}

const DEFAULTS: ResolvedPolicy = { retry: 0, backoff: "fixed", delay: 1000, maxDelay: 60_000, then: "dead_letter" };

/** Merge step policy over the pipeline's `errors:` defaults, field by field. */
export function resolvePolicy(defaults: ErrorPolicy | undefined, step: ErrorPolicy | undefined): ResolvedPolicy {
  const merged = { ...defaults, ...step };
  return {
    retry: merged.retry ?? DEFAULTS.retry,
    backoff: merged.backoff ?? DEFAULTS.backoff,
    delay: merged.delay ? parseDuration(merged.delay) : DEFAULTS.delay,
    maxDelay: merged.max_delay ? parseDuration(merged.max_delay) : DEFAULTS.maxDelay,
    then: merged.then ?? DEFAULTS.then,
    // A step's message wins; the default message applies only to steps without their own policy message.
    message: step?.message ?? defaults?.message,
  };
}

export function backoffDelay(policy: ResolvedPolicy, failedAttempts: number): number {
  const base = policy.backoff === "exponential" ? policy.delay * 2 ** (failedAttempts - 1) : policy.delay;
  return Math.min(base, policy.maxDelay);
}

export type Attempted<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; error: Error; attempts: number; elapsed: number };

/**
 * Run `fn` with the policy's retries. `onRetry` is called before each wait; `stopped` ends retrying early, and so does
 * an error marked `final` (a budget limit, which the same packet would hit again).
 */
export async function attempt<T>(
  policy: ResolvedPolicy,
  fn: (attempt: number) => Promise<T>,
  onRetry?: (error: Error, attempt: number, waitMs: number) => void,
  stopped?: () => boolean,
): Promise<Attempted<T>> {
  const started = Date.now();
  for (let n = 1; ; n++) {
    try {
      return { ok: true, value: await fn(n), attempts: n };
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      if (n > policy.retry || stopped?.() || (error as { final?: boolean }).final === true)
        return { ok: false, error, attempts: n, elapsed: Date.now() - started };
      const wait = backoffDelay(policy, n);
      onRetry?.(error, n, wait);
      await Bun.sleep(wait);
      if (stopped?.()) return { ok: false, error, attempts: n, elapsed: Date.now() - started };
    }
  }
}
