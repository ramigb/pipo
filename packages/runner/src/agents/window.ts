// Budget windows (docs/spec.md §3.11, D12, D37): a calendar day in the engine's time zone, starting at `reset_at`.

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();

function wall(ms: number, tz: string): Wall {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return {
    y: p.year as number,
    mo: p.month as number,
    d: p.day as number,
    h: p.hour as number,
    mi: p.minute as number,
    s: p.second as number,
  };
}

/** The zone's offset from UTC at instant `ms` (ms). */
function offset(ms: number, tz: string): number {
  const w = wall(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock time in `tz` happens (the later reading across a DST change). */
function instant(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offset(guess, tz);
  const second = guess - offset(first, tz);
  return Math.max(first, second);
}

export interface BudgetWindow {
  /** When the current budget day started (ms). */
  start: number;
  /** When the next one starts (ms): where a `budget` pause resumes. */
  end: number;
}

/** The budget day containing `now`, in `tz`, with days starting at `resetAt` ("HH:MM", default midnight). */
export function budgetWindow(now: number, tz: string, resetAt = "00:00"): BudgetWindow {
  const [rh, rm] = resetAt.split(":").map(Number) as [number, number];
  const w = wall(now, tz);
  let start = instant(w.y, w.mo, w.d, rh, rm, tz);
  if (start > now) {
    const prev = wall(Date.UTC(w.y, w.mo - 1, w.d) - 86_400_000, "UTC");
    start = instant(prev.y, prev.mo, prev.d, rh, rm, tz);
  }
  const s = wall(start, tz);
  const next = wall(Date.UTC(s.y, s.mo - 1, s.d) + 86_400_000, "UTC");
  let end = instant(next.y, next.mo, next.d, rh, rm, tz);
  // A reset time skipped by a DST change can land oddly; a day is never shorter than an hour or past `now`.
  if (end <= now || end - start < 3_600_000) end = start + 86_400_000;
  return { start, end };
}

/** The system's own time zone, used when the engine config sets none. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
