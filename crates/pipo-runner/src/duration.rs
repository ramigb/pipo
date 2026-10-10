// TEMPORARY stand-in until the expr port merges (same behaviour as @pipo/spec duration.ts).
pub fn parse_duration(text: &str) -> Result<u64, String> {
    let t = text.trim();
    let bad = || format!("invalid duration '{text}' (expected e.g. 500ms, 2s, 5m, 1h, 7d)");
    let split = t.find(|c: char| !(c.is_ascii_digit() || c == '.')).ok_or_else(bad)?;
    let (n, unit) = t.split_at(split);
    let mult = match unit { "ms" => 1.0, "s" => 1000.0, "m" => 60_000.0, "h" => 3_600_000.0, "d" => 86_400_000.0, _ => return Err(bad()) };
    if n.is_empty() || n.starts_with('.') || n.ends_with('.') || n.matches('.').count() > 1 { return Err(bad()); }
    Ok((n.parse::<f64>().map_err(|_| bad())? * mult) as u64)
}
pub fn format_duration(ms: u64) -> String {
    if ms < 1000 { return format!("{ms}ms"); }
    if ms < 60_000 { return if ms < 10_000 { format!("{:.1}s", ms as f64 / 1000.0) } else { format!("{:.0}s", ms as f64 / 1000.0) }; }
    if ms < 3_600_000 { return format!("{}m{}s", ms / 60_000, (ms % 60_000) / 1000); }
    format!("{}h{}m", ms / 3_600_000, (ms % 3_600_000) / 60_000)
}
