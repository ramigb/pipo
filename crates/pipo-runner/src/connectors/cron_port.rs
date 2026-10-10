// 5-field cron (docs/spec.md §3.3, §7.4): minute hour day-of-month month day-of-week. Port of @pipo/spec cron.ts,
// what the schedule input needs, until it moves into `crate::cron`. Supports `*`, lists, ranges and steps, in UTC.
// When both day fields are restricted a day matches if either does (standard cron); otherwise both must match.

use crate::time::{civil_from_days, days_from_civil};
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq)]
pub struct Cron {
    pub minutes: BTreeSet<u32>,
    pub hours: BTreeSet<u32>,
    pub days: BTreeSet<u32>,
    pub months: BTreeSet<u32>,
    /// 0-6, Sunday = 0 (7 is accepted as Sunday).
    pub weekdays: BTreeSet<u32>,
    pub days_restricted: bool,
    pub weekdays_restricted: bool,
}

struct Field {
    name: &'static str,
    min: u32,
    max: u32,
}

const FIELDS: [Field; 5] = [
    Field { name: "minute", min: 0, max: 59 },
    Field { name: "hour", min: 0, max: 23 },
    Field { name: "day-of-month", min: 1, max: 31 },
    Field { name: "month", min: 1, max: 12 },
    Field { name: "day-of-week", min: 0, max: 7 },
];

const HINT: &str = "use 5 fields: minute hour day-of-month month day-of-week, e.g. '*/15 9-17 * * 1-5'";

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn parse_field(text: &str, f: &Field) -> Result<BTreeSet<u32>, String> {
    let bad = |why: String| format!("invalid cron {} field '{text}': {why}", f.name);
    let num = |s: &str| -> Result<u32, String> {
        if !digits(s) {
            return Err(bad(format!("'{s}' is not a number (names are not supported)")));
        }
        let n = s.parse::<u64>().unwrap_or(u64::MAX);
        if n < f.min as u64 || n > f.max as u64 {
            return Err(bad(format!("{n} is outside {}-{}", f.min, f.max)));
        }
        Ok(n as u32)
    };
    let mut out = BTreeSet::new();
    for part in text.split(',') {
        if part.is_empty() {
            return Err(bad("empty list item".into()));
        }
        let mut pieces = part.split('/');
        let range = pieces.next().unwrap_or("");
        let step = pieces.next();
        if pieces.next().is_some() {
            return Err(bad("more than one '/'".into()));
        }
        let mut step_n = 1u32;
        if let Some(s) = step {
            if !digits(s) || s.parse::<u64>().unwrap_or(u64::MAX) < 1 {
                return Err(bad(format!("step '{s}' must be a positive integer")));
            }
            step_n = s.parse::<u64>().unwrap_or(u64::MAX).min(u32::MAX as u64) as u32;
        }
        let (lo, hi) = if range == "*" {
            (f.min, if f.name == "day-of-week" { 6 } else { f.max })
        } else if range.contains('-') {
            let mut ends = range.split('-');
            let (lo, hi) = (num(ends.next().unwrap_or(""))?, num(ends.next().unwrap_or(""))?);
            if lo > hi {
                return Err(bad(format!("range {lo}-{hi} is backwards")));
            }
            (lo, hi)
        } else {
            let lo = num(range)?;
            (lo, if step.is_none() { lo } else { f.max })
        };
        let mut v = lo;
        while v <= hi {
            out.insert(if f.name == "day-of-week" && v == 7 { 0 } else { v });
            v = match v.checked_add(step_n) {
                Some(n) => n,
                None => break,
            };
        }
    }
    Ok(out)
}

/// Parse a cron expression; the error says what is wrong and how to fix it.
pub fn parse_cron(text: &str) -> Result<Cron, String> {
    let parts: Vec<&str> = text.split_whitespace().collect();
    if parts.len() != 5 {
        return Err(format!("cron '{text}' has {} field(s), expected 5; {HINT}", parts.len()));
    }
    let mut sets = vec![];
    for (i, f) in FIELDS.iter().enumerate() {
        sets.push(parse_field(parts[i], f)?);
    }
    let mut sets = sets.into_iter();
    let mut next = || sets.next().unwrap_or_default();
    let cron = Cron {
        minutes: next(),
        hours: next(),
        days: next(),
        months: next(),
        weekdays: next(),
        days_restricted: !parts[2].starts_with('*'),
        weekdays_restricted: !parts[4].starts_with('*'),
    };
    if next_cron(&cron, 0).is_none() {
        return Err(format!("cron '{text}' never fires (for example, day 31 in a month that has only 30 days)"));
    }
    Ok(cron)
}

const MINUTE: i64 = 60_000;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 86_400_000;

/// First fire time (epoch ms, UTC) strictly after `after_ms`, or None if none within 10 years.
pub fn next_cron(c: &Cron, after_ms: i64) -> Option<i64> {
    let mut t = after_ms.div_euclid(MINUTE) * MINUTE + MINUTE;
    let limit = civil_from_days(t.div_euclid(DAY)).0 + 10;
    loop {
        let days = t.div_euclid(DAY);
        let (y, m, d) = civil_from_days(days);
        if y > limit {
            return None;
        }
        let in_day = t.rem_euclid(DAY);
        let weekday = (days + 4).rem_euclid(7) as u32;
        let by_day = c.days.contains(&(d as u32));
        let by_weekday = c.weekdays.contains(&weekday);
        let day_ok = if c.days_restricted && c.weekdays_restricted { by_day || by_weekday } else { by_day && by_weekday };
        if !c.months.contains(&(m as u32)) {
            let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
            t = days_from_civil(ny, nm, 1) * DAY;
        } else if !day_ok {
            t = (days + 1) * DAY;
        } else if !c.hours.contains(&((in_day / HOUR) as u32)) {
            t = t.div_euclid(HOUR) * HOUR + HOUR;
        } else if !c.minutes.contains(&((in_day % HOUR / MINUTE) as u32)) {
            t += MINUTE;
        } else {
            return Some(t);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::{iso, parse_iso};

    fn next(expr: &str, after: &str) -> Option<String> {
        next_cron(&parse_cron(expr).unwrap(), parse_iso(after).unwrap()).map(iso)
    }

    #[test]
    fn next_fire_times() {
        let cases = [
            ("* * * * *", "2026-01-01T00:00:00Z", "2026-01-01T00:01:00.000Z"),
            ("* * * * *", "2026-01-01T00:00:30Z", "2026-01-01T00:01:00.000Z"),
            ("*/15 * * * *", "2026-01-01T10:16:00Z", "2026-01-01T10:30:00.000Z"),
            ("10-20/5 * * * *", "2026-01-01T10:11:00Z", "2026-01-01T10:15:00.000Z"),
            ("5/20 * * * *", "2026-01-01T10:26:00Z", "2026-01-01T10:45:00.000Z"),
            ("0 9,17 * * *", "2026-01-01T09:00:00Z", "2026-01-01T17:00:00.000Z"),
            ("0 0 * * *", "2026-12-31T23:59:00Z", "2027-01-01T00:00:00.000Z"),
            ("0 0 31 * *", "2026-04-15T00:00:00Z", "2026-05-31T00:00:00.000Z"),
            ("0 12 29 2 *", "2026-03-01T00:00:00Z", "2028-02-29T12:00:00.000Z"),
            // 2026-01-01 is a Thursday; the next Sunday is 2026-01-04.
            ("0 0 * * 0", "2026-01-01T00:00:00Z", "2026-01-04T00:00:00.000Z"),
            ("0 0 * * 7", "2026-01-01T00:00:00Z", "2026-01-04T00:00:00.000Z"),
            ("0 0 * * 5-7", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00.000Z"),
            // The 15th or a Monday; 2026-01-05 is a Monday.
            ("0 0 15 * 1", "2026-01-01T00:00:00Z", "2026-01-05T00:00:00.000Z"),
            ("0 0 15 * 1", "2026-01-10T00:00:00Z", "2026-01-12T00:00:00.000Z"),
            ("0 0 15 * 1", "2026-01-13T00:00:00Z", "2026-01-15T00:00:00.000Z"),
            ("0 9 * * 1-5", "2026-03-01T08:59:30Z", "2026-03-02T09:00:00.000Z"),
        ];
        for (expr, after, want) in cases {
            assert_eq!(next(expr, after).as_deref(), Some(want), "{expr} after {after}");
        }
    }

    #[test]
    fn parse_errors() {
        let cases = [
            ("* * * *", "expected 5"),
            ("", "expected 5"),
            ("60 * * * *", "minute"),
            ("* 24 * * *", "hour"),
            ("* * 0 * *", "day-of-month"),
            ("* * * 13 *", "month"),
            ("* * * * 8", "day-of-week"),
            ("*/0 * * * *", "step"),
            ("5-1 * * * *", "backwards"),
            ("a * * * *", "not a number"),
            ("1,,2 * * * *", "empty"),
            ("0 0 31 2 *", "never fires"),
            ("1/2/3 * * * *", "more than one"),
        ];
        for (expr, part) in cases {
            let e = parse_cron(expr).unwrap_err();
            assert!(e.contains(part), "'{expr}': {e}");
        }
        assert_eq!(parse_cron("").unwrap_err(), format!("cron '' has 0 field(s), expected 5; {HINT}"));
        assert_eq!(parse_cron("99 * * * *").unwrap_err(), "invalid cron minute field '99': 99 is outside 0-59");
    }
}
