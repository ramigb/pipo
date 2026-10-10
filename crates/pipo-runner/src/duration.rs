// Durations such as "500ms", "2s", "5m", "1.5h", "7d" (docs/spec.md §3.1). Ports packages/spec/src/duration.ts.

/// Parse a duration into milliseconds, exactly as the TS `parseDuration` does (so "1.5ms" is 1.5).
pub fn parse_duration_f64(text: &str) -> Result<f64, String> {
    let invalid = || format!("invalid duration '{text}' (expected e.g. 500ms, 2s, 5m, 1h, 7d)");
    let t = crate::expr::js_trim(text);
    let split = t.find(|c: char| !c.is_ascii_digit() && c != '.').ok_or_else(invalid)?;
    let (number, unit) = t.split_at(split);
    let unit_ms = match unit {
        "ms" => 1.0,
        "s" => 1000.0,
        "m" => 60_000.0,
        "h" => 3_600_000.0,
        "d" => 86_400_000.0,
        _ => return Err(invalid()),
    };
    let valid = match number.split_once('.') {
        Some((int, frac)) => !int.is_empty() && !frac.is_empty() && !frac.contains('.'),
        None => !number.is_empty(),
    };
    if !valid {
        return Err(invalid());
    }
    Ok(number.parse::<f64>().map_err(|_| invalid())? * unit_ms)
}

/// Parse a duration into whole milliseconds: the TS value rounded to the nearest millisecond (saturating).
pub fn parse_duration(text: &str) -> Result<u64, String> {
    parse_duration_f64(text).map(|ms| ms.round() as u64)
}

/// A short human form, as the TS `formatDuration`: "250ms", "1.5s", "42s", "3m20s", "2h5m".
pub fn format_duration(ms: u64) -> String {
    if ms < 1000 {
        return format!("{ms}ms");
    }
    if ms < 60_000 {
        return format!("{}s", to_fixed(ms as f64 / 1000.0, if ms < 10_000 { 1 } else { 0 }));
    }
    if ms < 3_600_000 {
        return format!("{}m{}s", ms / 60_000, ms % 60_000 / 1000);
    }
    format!("{}h{}m", ms / 3_600_000, ms % 3_600_000 / 60_000)
}

/// `Number.prototype.toFixed` for 1 <= x < 2^53: the exact decimal value of the double, rounded half up.
fn to_fixed(x: f64, digits: usize) -> String {
    // A double >= 1 has at most 52 fractional bits, so 64 decimal places are its exact value.
    let exact = format!("{x:.64}");
    let (int, frac) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut kept: Vec<u8> = int.bytes().chain(frac.bytes().take(digits)).collect();
    if frac.as_bytes().get(digits).is_some_and(|d| *d >= b'5') {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                break;
            }
            i -= 1;
            if kept[i] == b'9' {
                kept[i] = b'0';
            } else {
                kept[i] += 1;
                break;
            }
        }
    }
    let s = String::from_utf8(kept).unwrap_or_default();
    if digits == 0 {
        return s;
    }
    let (a, b) = s.split_at(s.len() - digits);
    format!("{a}.{b}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_units() {
        assert_eq!(parse_duration("500ms"), Ok(500));
        assert_eq!(parse_duration("2s"), Ok(2000));
        assert_eq!(parse_duration("5m"), Ok(300_000));
        assert_eq!(parse_duration("1.5h"), Ok(5_400_000));
        assert_eq!(parse_duration("7d"), Ok(604_800_000));
        assert_eq!(parse_duration(" 30s\n"), Ok(30_000));
        assert_eq!(parse_duration_f64("1.5ms"), Ok(1.5));
        assert_eq!(parse_duration("1.5ms"), Ok(2));
    }

    #[test]
    fn rejects_anything_else() {
        for bad in ["", "5", "m", "5 m", "-5s", "1.s", ".5s", "1.2.3s", "5w", "5M", "1e3s", "30 minutes"] {
            assert_eq!(
                parse_duration(bad),
                Err(format!("invalid duration '{bad}' (expected e.g. 500ms, 2s, 5m, 1h, 7d)")),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn formats_like_format_duration() {
        let cases = [
            (0, "0ms"),
            (999, "999ms"),
            (1000, "1.0s"),
            (1050, "1.1s"),
            (1150, "1.1s"),
            (1250, "1.3s"),
            (9999, "10.0s"),
            (10_000, "10s"),
            (10_500, "11s"),
            (59_999, "60s"),
            (60_000, "1m0s"),
            (200_000, "3m20s"),
            (3_600_000, "1h0m"),
            (7_500_000, "2h5m"),
        ];
        for (ms, s) in cases {
            assert_eq!(format_duration(ms), s, "{ms}");
        }
    }
}
