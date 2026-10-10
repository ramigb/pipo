// 5-field cron (docs/spec.md §3.3, §7.4): minute hour day-of-month month day-of-week. Ports
// packages/spec/src/cron.ts. Supports `*`, lists, ranges and steps. Evaluated in UTC, with the civil-calendar
// arithmetic below (no time-zone data needed). When both day fields are restricted a day matches if either
// does (standard cron); otherwise both must match.

use crate::expr::{js_trim, number_to_text};

/// A parsed cron expression. Each field is a bit set: bit `n` is set when value `n` matches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cron {
    pub minutes: u64,
    pub hours: u64,
    pub days: u64,
    pub months: u64,
    /// 0-6, Sunday = 0 (7 is accepted as Sunday).
    pub weekdays: u64,
    pub days_restricted: bool,
    pub weekdays_restricted: bool,
}

struct Field {
    name: &'static str,
    min: u64,
    max: u64,
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

fn parse_field(text: &str, f: &Field) -> Result<u64, String> {
    let bad = |why: String| Err(format!("invalid cron {} field '{text}': {why}", f.name));
    let num = |s: &str| -> Result<u64, String> {
        if !digits(s) {
            return bad(format!("'{s}' is not a number (names are not supported)"));
        }
        let n: f64 = s.parse().unwrap_or(f64::INFINITY);
        if n < f.min as f64 || n > f.max as f64 {
            return bad(format!("{} is outside {}-{}", number_to_text(n), f.min, f.max));
        }
        Ok(n as u64)
    };
    let mut out = 0u64;
    for part in text.split(',') {
        if part.is_empty() {
            return bad("empty list item".into());
        }
        let mut pieces = part.split('/');
        let range = pieces.next().unwrap_or("");
        let step = pieces.next();
        if pieces.next().is_some() {
            return bad("more than one '/'".into());
        }
        let mut step_n = 1u64;
        if let Some(step) = step {
            let n: f64 = if digits(step) { step.parse().unwrap_or(f64::INFINITY) } else { 0.0 };
            if n < 1.0 {
                return bad(format!("step '{step}' must be a positive integer"));
            }
            step_n = n as u64;
        }
        let (lo, hi) = if range == "*" {
            (f.min, if f.name == "day-of-week" { 6 } else { f.max })
        } else if range.contains('-') {
            let mut ends = range.split('-');
            let lo = num(ends.next().unwrap_or(""))?;
            let hi = num(ends.next().unwrap_or(""))?;
            if lo > hi {
                return bad(format!("range {lo}-{hi} is backwards"));
            }
            (lo, hi)
        } else {
            let lo = num(range)?;
            (lo, if step.is_none() { lo } else { f.max })
        };
        let mut v = lo;
        while v <= hi {
            out |= 1 << if f.name == "day-of-week" && v == 7 { 0 } else { v };
            v = v.saturating_add(step_n);
        }
    }
    Ok(out)
}

/// Parse a cron expression. The error says what is wrong and how to fix it.
pub fn parse_cron(text: &str) -> Result<Cron, String> {
    let trimmed = js_trim(text);
    let parts: Vec<&str> = trimmed.split(crate::expr::is_js_space).filter(|p| !p.is_empty()).collect();
    if parts.len() != 5 {
        return Err(format!("cron '{text}' has {} field(s), expected 5; {HINT}", parts.len()));
    }
    let mut sets = [0u64; 5];
    for (i, f) in FIELDS.iter().enumerate() {
        sets[i] = parse_field(parts[i], f)?;
    }
    let cron = Cron {
        minutes: sets[0],
        hours: sets[1],
        days: sets[2],
        months: sets[3],
        weekdays: sets[4],
        days_restricted: !parts[2].starts_with('*'),
        weekdays_restricted: !parts[4].starts_with('*'),
    };
    if next_cron(&cron, 0).is_none() {
        return Err(format!("cron '{text}' never fires (for example, day 31 in a month that has only 30 days)"));
    }
    Ok(cron)
}

fn has(set: u64, v: i64) -> bool {
    (0..64).contains(&v) && set & (1 << v) != 0
}

const MINUTE: i64 = 60_000;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 86_400_000;

/// First fire time (epoch ms, UTC) strictly after `after_ms`, or `None` if none within 10 years.
pub fn next_cron(c: &Cron, after_ms: i64) -> Option<i64> {
    let mut t = after_ms.div_euclid(MINUTE) * MINUTE + MINUTE;
    let limit = civil_from_days(t.div_euclid(DAY)).0 + 10;
    loop {
        let days = t.div_euclid(DAY);
        let (year, month, day) = civil_from_days(days);
        if year > limit {
            return None;
        }
        let in_day = t.rem_euclid(DAY);
        let (hour, minute) = (in_day / HOUR, in_day % HOUR / MINUTE);
        if !has(c.months, month) {
            let (y, m) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
            t = days_from_civil(y, m, 1) * DAY;
        } else if !day_matches(c, day, days) {
            t = (days + 1) * DAY;
        } else if !has(c.hours, hour) {
            t = days * DAY + (hour + 1) * HOUR;
        } else if !has(c.minutes, minute) {
            t = t - t.rem_euclid(MINUTE) + MINUTE;
        } else {
            return Some(t);
        }
    }
}

fn day_matches(c: &Cron, day: i64, days: i64) -> bool {
    let by_day = has(c.days, day);
    let by_weekday = has(c.weekdays, (days + 4).rem_euclid(7));
    if c.days_restricted && c.weekdays_restricted { by_day || by_weekday } else { by_day && by_weekday }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's algorithm).
pub(crate) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// (year, month 1-12, day 1-31) of a day count since 1970-01-01.
pub(crate) fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expr::iso_string;

    fn at(iso: &str) -> i64 {
        let (date, time) = iso.trim_end_matches('Z').split_once('T').unwrap();
        let d: Vec<i64> = date.split('-').map(|x| x.parse().unwrap()).collect();
        let t: Vec<i64> = time.split(':').map(|x| x.parse().unwrap()).collect();
        days_from_civil(d[0], d[1], d[2]) * DAY + t[0] * HOUR + t[1] * MINUTE + t[2] * 1000
    }

    fn next(expr: &str, after: &str) -> Option<String> {
        next_cron(&parse_cron(expr).unwrap(), at(after)).map(|n| iso_string(n as f64).unwrap())
    }

    #[test]
    fn calendar_round_trips() {
        for days in [-800_000, -1, 0, 59, 10_956, 20_819, 2_932_896] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    }

    #[test]
    fn every_minute_and_strictly_after() {
        assert_eq!(next("* * * * *", "2026-01-01T00:00:00Z").unwrap(), "2026-01-01T00:01:00.000Z");
        assert_eq!(next("* * * * *", "2026-01-01T00:00:30Z").unwrap(), "2026-01-01T00:01:00.000Z");
    }

    #[test]
    fn steps_and_ranges() {
        assert_eq!(next("*/15 * * * *", "2026-01-01T10:16:00Z").unwrap(), "2026-01-01T10:30:00.000Z");
        assert_eq!(next("10-20/5 * * * *", "2026-01-01T10:11:00Z").unwrap(), "2026-01-01T10:15:00.000Z");
        assert_eq!(next("5/20 * * * *", "2026-01-01T10:26:00Z").unwrap(), "2026-01-01T10:45:00.000Z");
        assert_eq!(next("0 9,17 * * *", "2026-01-01T09:00:00Z").unwrap(), "2026-01-01T17:00:00.000Z");
    }

    #[test]
    fn rolls_over_day_month_and_year() {
        assert_eq!(next("0 0 * * *", "2026-12-31T23:59:00Z").unwrap(), "2027-01-01T00:00:00.000Z");
        assert_eq!(next("0 0 31 * *", "2026-04-15T00:00:00Z").unwrap(), "2026-05-31T00:00:00.000Z");
        assert_eq!(next("0 12 29 2 *", "2026-03-01T00:00:00Z").unwrap(), "2028-02-29T12:00:00.000Z");
        assert_eq!(next("59 23 * * *", "2026-01-01T23:59:00Z").unwrap(), "2026-01-02T23:59:00.000Z");
    }

    #[test]
    fn day_of_week_0_and_7_are_sunday() {
        // 2026-01-01 is a Thursday; the next Sunday is 2026-01-04
        assert_eq!(next("0 0 * * 0", "2026-01-01T00:00:00Z").unwrap(), "2026-01-04T00:00:00.000Z");
        assert_eq!(next("0 0 * * 7", "2026-01-01T00:00:00Z").unwrap(), "2026-01-04T00:00:00.000Z");
        assert_eq!(next("0 0 * * 5-7", "2026-01-01T00:00:00Z").unwrap(), "2026-01-02T00:00:00.000Z");
    }

    #[test]
    fn day_fields_are_ored_when_both_restricted() {
        // 15th or Monday; 2026-01-05 is a Monday
        assert_eq!(next("0 0 15 * 1", "2026-01-01T00:00:00Z").unwrap(), "2026-01-05T00:00:00.000Z");
        assert_eq!(next("0 0 15 * 1", "2026-01-10T00:00:00Z").unwrap(), "2026-01-12T00:00:00.000Z");
        assert_eq!(next("0 0 15 * 1", "2026-01-13T00:00:00Z").unwrap(), "2026-01-15T00:00:00.000Z");
    }

    #[test]
    fn negative_times_work() {
        assert_eq!(next("0 0 * * *", "1969-12-31T12:00:30Z").unwrap(), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn rejects_bad_expressions() {
        let cases = [
            (
                "* * * *",
                "cron '* * * *' has 4 field(s), expected 5; use 5 fields: minute hour day-of-month month day-of-week, e.g. '*/15 9-17 * * 1-5'",
            ),
            ("", "cron '' has 0 field(s), expected 5"),
            ("60 * * * *", "invalid cron minute field '60': 60 is outside 0-59"),
            ("* 24 * * *", "invalid cron hour field '24': 24 is outside 0-23"),
            ("* * 0 * *", "invalid cron day-of-month field '0': 0 is outside 1-31"),
            ("* * * 13 *", "invalid cron month field '13': 13 is outside 1-12"),
            ("* * * * 8", "invalid cron day-of-week field '8': 8 is outside 0-7"),
            ("*/0 * * * *", "invalid cron minute field '*/0': step '0' must be a positive integer"),
            ("*/ * * * *", "invalid cron minute field '*/': step '' must be a positive integer"),
            ("5-1 * * * *", "invalid cron minute field '5-1': range 5-1 is backwards"),
            ("a * * * *", "invalid cron minute field 'a': 'a' is not a number (names are not supported)"),
            ("1,,2 * * * *", "invalid cron minute field '1,,2': empty list item"),
            ("1/2/3 * * * *", "invalid cron minute field '1/2/3': more than one '/'"),
            ("99999999999999999999999 * * * *", "1e+23 is outside 0-59"),
            ("0 0 31 2 *", "cron '0 0 31 2 *' never fires (for example, day 31 in a month that has only 30 days)"),
        ];
        for (expr, want) in cases {
            let err = parse_cron(expr).unwrap_err();
            assert!(err.contains(want), "{expr:?}: {err}");
        }
    }

    #[test]
    fn star_steps_leave_day_fields_unrestricted() {
        let c = parse_cron("0 0 */2 * 1").unwrap();
        assert!(!c.days_restricted && c.weekdays_restricted);
        assert!(parse_cron("\t0  0 1-2-3 * *\n").is_ok());
    }
}
