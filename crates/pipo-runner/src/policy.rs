// Error policies (docs/spec.md §3.9): retries with backoff, then a final action. Port of policy.ts.

use crate::duration::parse_duration;
use crate::pipeline::ErrorPolicy;
use std::future::Future;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedPolicy {
    pub retry: u32,
    pub exponential: bool,
    pub delay: u64,
    pub max_delay: u64,
    pub then: String,
    pub message: Option<String>,
}

/// Merge a step policy over the pipeline's `errors:` defaults, field by field.
pub fn resolve_policy(defaults: Option<&ErrorPolicy>, step: Option<&ErrorPolicy>) -> ResolvedPolicy {
    let pick = |f: fn(&ErrorPolicy) -> Option<String>| step.and_then(f).or_else(|| defaults.and_then(f));
    let ms = |v: Option<String>, fallback: u64| v.and_then(|d| parse_duration(&d).ok()).unwrap_or(fallback);
    ResolvedPolicy {
        retry: step.and_then(|p| p.retry).or_else(|| defaults.and_then(|p| p.retry)).unwrap_or(0),
        exponential: pick(|p| p.backoff.clone()).as_deref() == Some("exponential"),
        delay: ms(pick(|p| p.delay.clone()).filter(|d| !d.is_empty()), 1000),
        max_delay: ms(pick(|p| p.max_delay.clone()).filter(|d| !d.is_empty()), 60_000),
        then: pick(|p| p.then.clone()).unwrap_or_else(|| "dead_letter".into()),
        // A step's message wins; the default message applies only to steps without their own.
        message: step.and_then(|p| p.message.clone()).or_else(|| defaults.and_then(|p| p.message.clone())),
    }
}

pub fn backoff_delay(policy: &ResolvedPolicy, failed_attempts: u32) -> u64 {
    let base = if policy.exponential {
        let factor = 2f64.powi(failed_attempts.saturating_sub(1).min(62) as i32);
        (policy.delay as f64 * factor).min(u64::MAX as f64) as u64
    } else {
        policy.delay
    };
    base.min(policy.max_delay)
}

/// A step failure. `fatal` ends retries at once (a budget limit the same packet would hit again).
#[derive(Debug, Clone)]
pub struct StepError {
    pub message: String,
    pub fatal: bool,
    /// What kind of error this is, for callers that branch on it (`budget.day`, `budget.packet`).
    pub kind: Option<String>,
    pub detail: Option<serde_json::Value>,
}

impl StepError {
    pub fn new(message: impl Into<String>) -> StepError {
        StepError { message: message.into(), fatal: false, kind: None, detail: None }
    }
}

impl From<String> for StepError {
    fn from(message: String) -> StepError {
        StepError::new(message)
    }
}

impl From<&str> for StepError {
    fn from(message: &str) -> StepError {
        StepError::new(message)
    }
}

pub enum Attempted<T> {
    Ok { value: T, attempts: u32 },
    Failed { error: StepError, attempts: u32, elapsed: u64 },
}

/// Run `f` with the policy's retries. `on_retry` runs before each wait; `stopped` ends retrying early.
pub async fn attempt<T, F, Fut>(
    policy: &ResolvedPolicy,
    mut f: F,
    mut on_retry: impl FnMut(&StepError, u32, u64),
    stopped: impl Fn() -> bool,
) -> Attempted<T>
where
    F: FnMut(u32) -> Fut,
    Fut: Future<Output = Result<T, StepError>>,
{
    let started = Instant::now();
    let mut n = 1;
    loop {
        match f(n).await {
            Ok(value) => return Attempted::Ok { value, attempts: n },
            Err(error) => {
                let elapsed = || started.elapsed().as_millis() as u64;
                if n > policy.retry || stopped() || error.fatal {
                    return Attempted::Failed { error, attempts: n, elapsed: elapsed() };
                }
                let wait = backoff_delay(policy, n);
                on_retry(&error, n, wait);
                tokio::time::sleep(Duration::from_millis(wait)).await;
                if stopped() {
                    return Attempted::Failed { error, attempts: n, elapsed: elapsed() };
                }
            }
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(retry: Option<u32>, backoff: Option<&str>, then: Option<&str>) -> ErrorPolicy {
        ErrorPolicy {
            retry,
            backoff: backoff.map(Into::into),
            delay: None,
            max_delay: None,
            then: then.map(Into::into),
            message: None,
        }
    }

    #[test]
    fn merges_field_by_field() {
        let d = policy(Some(3), Some("exponential"), None);
        let s = policy(None, None, Some("drop"));
        let r = resolve_policy(Some(&d), Some(&s));
        assert_eq!((r.retry, r.exponential, r.then.as_str(), r.delay), (3, true, "drop", 1000));
        assert_eq!(backoff_delay(&r, 1), 1000);
        assert_eq!(backoff_delay(&r, 3), 4000);
        assert_eq!(backoff_delay(&r, 30), 60_000);
        let none = resolve_policy(None, None);
        assert_eq!((none.retry, none.then.as_str()), (0, "dead_letter"));
    }

    #[tokio::test]
    async fn retries_then_fails() {
        let mut p = resolve_policy(None, None);
        p.retry = 2;
        p.delay = 1;
        let mut retries = vec![];
        let out = attempt(
            &p,
            |n| async move { if n < 3 { Err::<u32, _>(StepError::new("no")) } else { Ok(n) } },
            |_, n, _| retries.push(n),
            || false,
        )
        .await;
        assert!(matches!(out, Attempted::Ok { value: 3, attempts: 3 }));
        assert_eq!(retries, vec![1, 2]);
        let out = attempt(
            &p,
            |_| async { Err::<u32, _>(StepError { fatal: true, ..StepError::new("budget") }) },
            |_, _, _| {},
            || false,
        )
        .await;
        assert!(matches!(out, Attempted::Failed { attempts: 1, .. }));
    }
}
