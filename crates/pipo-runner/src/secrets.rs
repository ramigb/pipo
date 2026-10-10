// Secret references (docs/spec.md §3.7). Port of secrets.ts: resolved once at start, never written anywhere,
// and redacted from every log line, journal error and event the runner produces.

use serde_json::{Map, Value};

/// Resolve one reference: `env:NAME` or `op://…` (1Password CLI).
pub async fn resolve_ref(reference: &str) -> Result<String, String> {
    if let Some(name) = reference.strip_prefix("env:") {
        return std::env::var(name).map_err(|_| format!("environment variable {name} is not set"));
    }
    if reference.starts_with("op://") {
        let out = tokio::process::Command::new("op")
            .args(["read", "--no-newline", reference])
            .output()
            .await
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "1Password CLI 'op' is not installed; install it or use env: references".to_string()
                } else {
                    format!("op read failed for {reference}: {e}")
                }
            })?;
        if !out.status.success() {
            return Err(format!("op read failed for {reference}: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    Err(format!("unsupported secret reference '{reference}' (use op://… or env:…)"))
}

#[derive(Debug, Clone, Default)]
pub struct Secrets {
    /// Name → value, exposed to templates as `secrets.*`.
    pub values: Map<String, Value>,
    /// Every value to hide, longest first, so a secret containing another is fully masked.
    sorted: Vec<String>,
}

impl Secrets {
    /// `hidden` values (an agent provider's API key, a bot token) are redacted too, but not exposed as `secrets.*`.
    pub async fn resolve(refs: Option<&Map<String, Value>>, hidden: Vec<String>) -> Result<Secrets, String> {
        let mut values = Map::new();
        for (name, reference) in refs.into_iter().flatten() {
            let reference = reference.as_str().map(str::to_owned).unwrap_or_else(|| reference.to_string());
            let value = resolve_ref(&reference).await.map_err(|e| format!("secret '{name}': {e}"))?;
            values.insert(name.clone(), Value::String(value));
        }
        Ok(Secrets::from_values(values, hidden))
    }

    pub fn from_values(values: Map<String, Value>, hidden: Vec<String>) -> Secrets {
        let mut sorted: Vec<String> = values
            .values()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .chain(hidden)
            .filter(|v| v.chars().count() >= 4)
            .collect();
        sorted.sort_by_key(|s| std::cmp::Reverse(s.len()));
        Secrets { values, sorted }
    }

    pub fn redact(&self, text: &str) -> String {
        let mut out = text.to_string();
        for s in &self.sorted {
            if out.contains(s.as_str()) {
                out = out.replace(s.as_str(), "***");
            }
        }
        out
    }

    /// Every string in `v` (values and keys) redacted (redactDeep in control/protocol.ts).
    pub fn redact_value(&self, v: &Value) -> Value {
        if self.sorted.is_empty() {
            return v.clone();
        }
        match v {
            Value::String(s) => Value::String(self.redact(s)),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.redact_value(x)).collect()),
            Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (self.redact(k), self.redact_value(x))).collect()),
            other => other.clone(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.sorted.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_longest_first() {
        let mut values = Map::new();
        values.insert("a".into(), json!("abcd"));
        values.insert("b".into(), json!("abcdef"));
        let s = Secrets::from_values(values, vec!["xyz".into(), "token-1234".into()]);
        assert_eq!(s.redact("abcdef abcd xyz token-1234"), "*** *** xyz ***");
        assert_eq!(s.redact_value(&json!({"abcd": ["abcd", 1]})), json!({"***": ["***", 1]}));
    }
}
