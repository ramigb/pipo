// Version reads and diffs (docs/spec.md §9.3, D38). Port of control/versions.ts.

use super::ControlError;
use serde_json::Value;

/// A version number argument: 3 or `v3`.
pub fn version_arg(raw: Option<&Value>, key: &str) -> Result<i64, ControlError> {
    let bad = || {
        ControlError::new(
            "bad_request",
            format!("`{key}` must be a version number, got {}", crate::expr::js_json(raw.unwrap_or(&Value::Null))),
            "use 3 or v3; pipo history <name> lists the versions",
        )
    };
    let n = match raw {
        Some(Value::String(s)) => {
            let digits = s.strip_prefix(['v', 'V']).unwrap_or(s);
            if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
                return Err(bad());
            }
            digits.parse::<i64>().map_err(|_| bad())?
        }
        Some(Value::Number(n)) => n.as_i64().filter(|_| n.as_f64().map(|f| f.fract() == 0.0).unwrap_or(false)).ok_or_else(bad)?,
        _ => return Err(bad()),
    };
    if n < 1 { Err(bad()) } else { Ok(n) }
}
