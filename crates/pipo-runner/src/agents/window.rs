// Budget windows (docs/spec.md §3.11, D12, D37): a calendar day in the engine's time zone, starting at `reset_at`.
// Port of agents/window.ts, step for step (DST included), with jiff over the system's time zone database.

use crate::time::days_from_civil;
use jiff::Timestamp;
use jiff::tz::TimeZone;

const DAY: i64 = 86_400_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BudgetWindow {
    /// When the current budget day started (ms).
    pub start: i64,
    /// When the next one starts (ms): where a `budget` pause resumes.
    pub end: i64,
}

/// The zone named `tz`; UTC when this system doesn't know it (`prepare_agents` refuses that zone at start).
pub(super) fn zone(tz: &str) -> TimeZone {
    if tz == "UTC" {
        return TimeZone::UTC;
    }
    TimeZone::get(tz).unwrap_or(TimeZone::UTC)
}

/// True when `tz` is an IANA time zone name this system's time zone database has.
pub fn is_time_zone(tz: &str) -> bool {
    tz == "UTC" || TimeZone::get(tz).is_ok()
}

fn timestamp(ms: i64) -> Timestamp {
    Timestamp::from_millisecond(ms).unwrap_or(Timestamp::UNIX_EPOCH)
}

/// The calendar date in `tz` at instant `ms`, as days since the epoch.
fn local_day(ms: i64, tz: &TimeZone) -> i64 {
    let d = tz.to_datetime(timestamp(ms)).date();
    days_from_civil(d.year() as i64, d.month() as i64, d.day() as i64)
}

/// The zone's offset from UTC at instant `ms` (ms).
fn offset(ms: i64, tz: &TimeZone) -> i64 {
    tz.to_offset(timestamp(ms)).seconds() as i64 * 1000
}

/// The instant a wall-clock time in `tz` happens, as window.ts finds it (the later of two readings across a DST change).
fn instant(day: i64, h: i64, mi: i64, tz: &TimeZone) -> i64 {
    let guess = day * DAY + h * 3_600_000 + mi * 60_000;
    let first = guess - offset(guess, tz);
    let second = guess - offset(first, tz);
    first.max(second)
}

/// The budget day containing `now`, in `tz`, with days starting at `reset_at` ("HH:MM", default midnight).
pub fn budget_window(now: i64, tz: &str, reset_at: Option<&str>) -> BudgetWindow {
    window_in(now, &zone(tz), reset_at)
}

pub(super) fn window_in(now: i64, tz: &TimeZone, reset_at: Option<&str>) -> BudgetWindow {
    let (rh, rm) = reset_at
        .and_then(|r| r.split_once(':'))
        .map(|(h, m)| (h.trim().parse::<i64>().unwrap_or(0), m.trim().parse::<i64>().unwrap_or(0)))
        .unwrap_or((0, 0));
    let today = local_day(now, tz);
    let mut start = instant(today, rh, rm, tz);
    if start > now {
        start = instant(today - 1, rh, rm, tz);
    }
    let mut end = instant(local_day(start, tz) + 1, rh, rm, tz);
    // A reset time skipped by a DST change can land oddly; a day is never shorter than an hour or past `now`.
    if end <= now || end - start < 3_600_000 {
        end = start + DAY;
    }
    BudgetWindow { start, end }
}

/// The system's own IANA time zone, used when the engine config sets none.
pub fn system_time_zone() -> String {
    TimeZone::system().iana_name().filter(|n| !n.is_empty()).map(str::to_owned).unwrap_or_else(|| "UTC".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cases computed by window.ts (`budgetWindow`): now, zone, reset_at, start, end.
    const FROM_TS: &[(i64, &str, Option<&str>, i64, i64)] = &[
        (1791028800000, "UTC", None, 1790985600000, 1791072000000),
        (1791003600000, "UTC", Some("06:00"), 1790920800000, 1791007200000),
        (1791028800000, "Europe/Stockholm", None, 1790978400000, 1791064800000),
        (1774785600000, "Europe/Stockholm", None, 1774738800000, 1774821600000),
        (1792929600000, "Europe/Stockholm", None, 1792879200000, 1792969200000),
        (1792929600000, "Europe/Stockholm", Some("02:30"), 1792891800000, 1792978200000),
        (1774785600000, "Europe/Stockholm", Some("02:30"), 1774747800000, 1774830600000),
        (1772971200000, "America/New_York", Some("02:30"), 1772955000000, 1773037800000),
        (1793534400000, "America/New_York", Some("01:30"), 1793511000000, 1793601000000),
        (1793511900000, "America/New_York", Some("01:30"), 1793511000000, 1793601000000),
        (1793513700000, "America/New_York", Some("01:30"), 1793511000000, 1793601000000),
        (1772952300000, "America/New_York", Some("02:30"), 1772868600000, 1772955000000),
        (1772955900000, "America/New_York", Some("02:30"), 1772955000000, 1773037800000),
        (1775390400000, "Australia/Lord_Howe", Some("02:00"), 1775316600000, 1775403000000),
        (1791115200000, "Australia/Lord_Howe", Some("02:00"), 1791041400000, 1791126000000),
        (1767236400000, "Asia/Kathmandu", None, 1767204900000, 1767291300000),
        (1767236400000, "Pacific/Apia", Some("23:59"), 1767178740000, 1767265140000),
    ];

    fn utc(y: i64, mo: i64, d: i64, h: i64) -> i64 {
        days_from_civil(y, mo, d) * DAY + h * 3_600_000
    }

    #[test]
    fn a_calendar_day_from_reset_at_in_the_configured_zone() {
        let w = |start, end| BudgetWindow { start, end };
        assert_eq!(budget_window(utc(2026, 10, 3, 12), "UTC", None), w(utc(2026, 10, 3, 0), utc(2026, 10, 4, 0)));
        assert_eq!(
            budget_window(utc(2026, 10, 3, 5), "UTC", Some("06:00")),
            w(utc(2026, 10, 2, 6), utc(2026, 10, 3, 6))
        );
        // Stockholm is UTC+2 in October: its midnight is 22:00 UTC the day before.
        assert_eq!(
            budget_window(utc(2026, 10, 3, 12), "Europe/Stockholm", None),
            w(utc(2026, 10, 2, 22), utc(2026, 10, 3, 22))
        );
        // The day DST starts (29 March 2026) is 23 hours long there.
        assert_eq!(
            budget_window(utc(2026, 3, 29, 12), "Europe/Stockholm", None),
            w(utc(2026, 3, 28, 23), utc(2026, 3, 29, 22))
        );
    }

    #[test]
    fn dst_gaps_and_folds_match_window_ts() {
        for &(now, tz, reset, start, end) in FROM_TS {
            assert!(is_time_zone(tz), "{tz} is missing from this system's time zone database");
            assert_eq!(budget_window(now, tz, reset), BudgetWindow { start, end }, "{tz} {reset:?} at {now}");
        }
    }

    #[test]
    fn zones() {
        assert!(is_time_zone("UTC"));
        assert!(!is_time_zone("Mars/Base"));
        assert!(!system_time_zone().is_empty());
    }
}
