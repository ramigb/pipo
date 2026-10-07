const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export const DURATION_PATTERN = "^\\d+(\\.\\d+)?(ms|s|m|h|d)$";

/** Parse "500ms", "2s", "5m", "1.5h", "7d" into milliseconds. Throws on anything else. */
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(text.trim());
  if (!m) throw new Error(`invalid duration '${text}' (expected e.g. 500ms, 2s, 5m, 1h, 7d)`);
  return Number(m[1]) * (UNITS[m[2] as string] as number);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`;
}
