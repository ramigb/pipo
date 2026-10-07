// 5-field cron (docs/spec.md §3.3, §7.4): minute hour day-of-month month day-of-week.
// Supports `*`, lists, ranges and steps. Evaluated in UTC. When both day fields are restricted
// a day matches if either does (standard cron); otherwise both must match.

export interface Cron {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0-6, Sunday = 0 (7 is accepted as Sunday). */
  weekdays: ReadonlySet<number>;
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
] as const;

const HINT = "use 5 fields: minute hour day-of-month month day-of-week, e.g. '*/15 9-17 * * 1-5'";

function parseField(text: string, f: (typeof FIELDS)[number]): Set<number> {
  const out = new Set<number>();
  const bad = (why: string): never => {
    throw new Error(`invalid cron ${f.name} field '${text}': ${why}`);
  };
  const num = (s: string): number => {
    if (!/^\d+$/.test(s)) return bad(`'${s}' is not a number (names are not supported)`);
    const n = Number(s);
    if (n < f.min || n > f.max) return bad(`${n} is outside ${f.min}-${f.max}`);
    return n;
  };
  for (const part of text.split(",")) {
    if (part === "") bad("empty list item");
    const [range = "", step, extra] = part.split("/");
    if (extra !== undefined) bad("more than one '/'");
    let stepN = 1;
    if (step !== undefined) {
      if (!/^\d+$/.test(step) || Number(step) < 1) bad(`step '${step}' must be a positive integer`);
      stepN = Number(step);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = f.min;
      hi = f.name === "day-of-week" ? 6 : f.max;
    } else if (range.includes("-")) {
      const [a = "", b = ""] = range.split("-");
      lo = num(a);
      hi = num(b);
      if (lo > hi) bad(`range ${lo}-${hi} is backwards`);
    } else {
      lo = num(range);
      hi = step === undefined ? lo : f.max;
    }
    for (let v = lo; v <= hi; v += stepN) out.add(f.name === "day-of-week" && v === 7 ? 0 : v);
  }
  return out;
}

/** Parse a cron expression. Throws an Error that says what is wrong and how to fix it. */
export function parseCron(text: string): Cron {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5 || parts[0] === "") {
    throw new Error(`cron '${text}' has ${parts[0] === "" ? 0 : parts.length} field(s), expected 5; ${HINT}`);
  }
  const [minutes, hours, days, months, weekdays] = FIELDS.map((f, i) => parseField(parts[i] as string, f));
  const cron: Cron = {
    minutes: minutes as Set<number>,
    hours: hours as Set<number>,
    days: days as Set<number>,
    months: months as Set<number>,
    weekdays: weekdays as Set<number>,
    daysRestricted: !(parts[2] as string).startsWith("*"),
    weekdaysRestricted: !(parts[4] as string).startsWith("*"),
  };
  if (nextCron(cron, 0) === null) {
    throw new Error(`cron '${text}' never fires (for example, day 31 in a month that has only 30 days)`);
  }
  return cron;
}

function dayMatches(c: Cron, d: Date): boolean {
  const byDay = c.days.has(d.getUTCDate());
  const byWeekday = c.weekdays.has(d.getUTCDay());
  return c.daysRestricted && c.weekdaysRestricted ? byDay || byWeekday : byDay && byWeekday;
}

/** First fire time (epoch ms, UTC) strictly after `afterMs`, or null if none within 10 years. */
export function nextCron(c: Cron, afterMs: number): number | null {
  const t = new Date(Math.floor(afterMs / 60_000) * 60_000 + 60_000);
  const limit = t.getUTCFullYear() + 10;
  while (t.getUTCFullYear() <= limit) {
    if (!c.months.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0, 0, 0);
    } else if (!dayMatches(c, t)) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
    } else if (!c.hours.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
    } else if (!c.minutes.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
    } else {
      return t.getTime();
    }
  }
  return null;
}
