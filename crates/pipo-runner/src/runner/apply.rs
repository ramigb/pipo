// Live versions (docs/spec.md §9.3, D38, D49, D60). Port of the versions part of runner.ts: make a new definition
// the active one at a safe point, checked like a start, stored as a new version with its compiled form.

use super::*;
use crate::versions::{VersionWarning, bound_changes, sha256, stale_module};

/// What an apply or rollback did.
pub struct Applied {
    pub version: i64,
    pub previous: i64,
    pub changed: bool,
    pub pending_older: i64,
    pub warnings: Vec<VersionWarning>,
}

impl Applied {
    pub fn to_value(&self) -> Value {
        let mut v = json!({
            "version": self.version, "previous": self.previous, "changed": self.changed, "pending_older": self.pending_older,
        });
        if !self.warnings.is_empty() {
            v["warnings"] = serde_json::to_value(&self.warnings).unwrap_or(Value::Null);
        }
        v
    }
}

/// Who applies a version and why (D49).
pub struct How {
    pub author: String,
    pub reason: String,
    pub author_kind: Option<String>,
    /// Set by a proposal apply: the proposal is marked applied in the transaction that stores the version.
    pub proposal: Option<(String, String)>,
}

impl Runner {
    fn pending_older(&self) -> i64 {
        let version = self.version();
        self.journal
            .borrow()
            .db()
            .query_row(
                "SELECT COUNT(*) FROM packets WHERE branch = '' AND version != ? AND state IN ('accepted', 'processing', 'writing', 'verifying', 'branched', 'escalated')",
                [version],
                |r| r.get(0),
            )
            .unwrap_or(0)
    }

    /// Refuse an apply unless the runner takes new packets (so the new version would be used).
    fn assert_runnable(&self) -> Result<(), ControlError> {
        let st = self.state();
        if st == RunnerState::Active || st == RunnerState::Paused {
            return Ok(());
        }
        Err(ControlError::new(
            if st == RunnerState::Starting { "unavailable" } else { "invalid_state" },
            format!("cannot apply a version: pipeline is {}", st.as_str()),
            match st {
                RunnerState::Starting => "try again once it runs".to_string(),
                RunnerState::Draining => {
                    "it accepts no new packets while draining, so a new version would never be used; start it again first".to_string()
                }
                _ => format!("start it again first (pipo start {})", self.pipeline().name),
            },
        ))
    }

    fn assert_can_apply(&self) -> Result<(), ControlError> {
        self.assert_runnable()?;
        if self.s.borrow().applying {
            return Err(ControlError::new(
                "invalid_state",
                "another version is being applied right now",
                "try again in a moment",
            ));
        }
        Ok(())
    }

    fn stale(&self, version: i64) -> Vec<VersionWarning> {
        let compiled = self.compiled.borrow().clone();
        let module = compiled.fn_module.as_ref();
        let w = stale_module(
            module.map(|m| m.path.as_str()),
            module.map(|m| m.hash.as_str()),
            &self.dir,
            version,
            &self.pipeline().name,
        );
        self.warn_all(w)
    }

    fn warn_all(&self, warnings: Vec<VersionWarning>) -> Vec<VersionWarning> {
        for w in &warnings {
            self.log("warn", &format!("{}; {}", w.message, w.hint));
        }
        warnings
    }

    /// Make `source` the active definition at a safe point (D38): compiled and checked like a start, stored as a new
    /// version with a `version.applied` event in one transaction, then used by every packet accepted after this
    /// returns. The same content as the active version changes nothing.
    pub async fn apply_version(&self, source: &str, how: How) -> Result<Applied, ControlError> {
        let name = self.pipeline().name.clone();
        self.assert_can_apply()?;
        let previous = self.version();
        let hash = sha256(source.as_bytes());
        if hash == self.s.borrow().version_hash {
            if let Some((id, _)) = &how.proposal {
                return Err(ControlError::new(
                    "invalid_state",
                    format!("proposal {id} changes nothing: its source is the running v{previous}'s"),
                    "reject it; there is nothing to apply",
                ));
            }
            let warnings = self.stale(previous);
            return Ok(Applied {
                version: previous,
                previous,
                changed: false,
                pending_older: self.pending_older(),
                warnings,
            });
        }
        self.s.borrow_mut().applying = true;
        let out = self.apply_checked(source, &hash, previous, &name, how).await;
        self.s.borrow_mut().applying = false;
        out
    }

    async fn apply_checked(
        &self,
        source: &str,
        hash: &str,
        previous: i64,
        name: &str,
        how: How,
    ) -> Result<Applied, ControlError> {
        let shown = self.opts.file.display().to_string();
        let compiled = crate::compile::compile(&self.file, &self.home, Some(source))
            .await
            .map_err(|e| ControlError::new("internal", e, "check that pipo compile works (PIPO_COMPILE)"))?;
        let errors = compiled.errors();
        if !errors.is_empty() {
            // The text for people, and the diagnostics themselves for tools (D60).
            let lines: Vec<String> = errors
                .iter()
                .map(|d| format!("  {}", crate::format::format_diagnostic(d).replace('\n', "\n  ")))
                .collect();
            let mut e = ControlError::new(
                "invalid_pipeline",
                format!(
                    "the new version fails pipo check with {} error(s), so nothing was applied:\n{}",
                    errors.len(),
                    lines.join("\n")
                ),
                format!("fix those, or roll back to a version that passes (pipo history {name})"),
            );
            e.diagnostics = compiled.diagnostics.clone();
            return Err(e);
        }
        let next = Pipeline::from_value(compiled.pipeline.clone().unwrap_or(Value::Null))
            .map_err(|e| ControlError::new("invalid_pipeline", e, "check the definition"))?;
        let bound = bound_changes(&self.pipeline(), &next);
        if !bound.is_empty() {
            return Err(ControlError::new(
                "invalid_state",
                format!(
                    "the new version changes {}, which the runner binds when it starts, so it can't be applied while {name} runs",
                    bound.join(", ")
                ),
                format!(
                    "put that definition in {shown} and restart (pipo restart {name}); a changed file wins on the next start (D38)"
                ),
            ));
        }
        let missing: Vec<String> = gaps(&next)
            .into_iter()
            .filter(|g| g.level == "refuse")
            .map(|g| format!("{} ({})", g.feature, g.path))
            .collect();
        if !missing.is_empty() {
            return Err(ControlError::new(
                "invalid_state",
                format!("the new version uses features this runner does not implement yet: {}", missing.join(", ")),
                "remove them from that version",
            ));
        }
        for (id, node) in next.nodes.iter() {
            let Some(agent) = &node.agent else { continue };
            let model = node.with.as_ref().and_then(|w| w.get("model")).and_then(|m| m.as_str());
            let priced =
                |m: &str| self.agents.pricing.get(agent).and_then(|p| crate::agents::price_for(p, m)).is_some();
            let unpriced =
                !self.agents.is_cli(agent) && model.map(|m| !m.contains("${") && !priced(m)).unwrap_or(false);
            if !self.agents.providers.contains_key(agent) || unpriced {
                return Err(ControlError::new(
                    "invalid_state",
                    format!(
                        "agent node '{id}' needs provider '{agent}'{}, which this runner did not set up when it started",
                        model.map(|m| format!(" with model '{m}'")).unwrap_or_default()
                    ),
                    format!(
                        "put that definition in {shown} and restart (pipo restart {name}), so the provider and its price are set up"
                    ),
                ));
            }
        }
        let number = self.journal.borrow().latest_version().ok().flatten().map(|l| l.version).unwrap_or(0) + 1;
        let compiled = Rc::new(compiled);
        let plan = plan::build(number, compiled.clone(), &self.fns).await.map_err(|e| {
            ControlError::new(
                "invalid_pipeline",
                format!("the new version can't be prepared: {e}"),
                "check its fn module and schema files",
            )
        })?;
        self.assert_runnable()?;
        // From here to the swap nothing awaits: the version, its event, a proposal's `applied` state and the
        // in-memory switch happen together (D38, D49).
        crash_point("apply.prepared");
        let author = self.secrets.redact(&how.author);
        let reason = self.secrets.redact(&how.reason);
        let proposal_id = how.proposal.as_ref().map(|(id, _)| id.clone());
        let version = control_tx(&mut self.journal.borrow_mut(), |j| {
            let audit = crate::journal::VersionAudit {
                author_kind: how.author_kind.clone(),
                proposal: proposal_id.clone(),
                files: Some(crate::versions::file_hashes(&compiled.files)),
            };
            let applied = crate::journal::Applied { expect: number, previous };
            let v = j
                .add_version(hash, source, &author, Some(&reason), Some(applied), &audit, Some(&compiled.raw))
                .map_err(|e| ControlError::new("internal", e.to_string(), "try again"))?;
            crash_point("apply.in_transaction");
            if let Some((id, by)) = &how.proposal {
                self.proposals.mark_applied_in(j, id, v, by)?;
            }
            Ok(v)
        })?;
        crash_point("apply.committed");
        self.set_plan(version, Rc::new(plan));
        {
            let mut s = self.s.borrow_mut();
            s.pipeline = Rc::new(next);
            s.version = version;
            s.version_hash = hash.to_string();
        }
        *self.compiled.borrow_mut() = compiled;
        self.write_registry();
        let older = self.pending_older();
        self.log(
            "info",
            &format!(
                "applied v{version} ({}{}, by {}); new packets use it{}",
                how.proposal.as_ref().map(|(id, _)| format!("proposal {id}: ")).unwrap_or_default(),
                how.reason,
                how.author,
                if older > 0 {
                    format!(", {older} packet(s) in flight finish on their own version")
                } else {
                    String::new()
                }
            ),
        );
        let warnings = self.stale(version);
        Ok(Applied { version, previous, changed: true, pending_older: older, warnings })
    }

    /// §9.3 step 4 (D49): a stored change proposal becomes the next version, through the live apply. One that still
    /// needs its dry run (D48) is dry-run first; when that diverges, the reply is the proposal, now `rejected`.
    pub async fn apply_proposal(&self, id: &str, by: &str) -> Result<Value, ControlError> {
        let name = self.pipeline().name.clone();
        self.assert_can_apply()?;
        let mut p = self.applicable_proposal(id, by)?;
        if p.verify.is_some() && p.state == "validated" {
            // Nothing is held while it replays (as for `propose`), so everything is checked again once it is decided.
            p = self.proposals.dry_run_if_required(id).await?;
            if p.state == "rejected" {
                return Ok(p.to_value());
            }
            self.assert_can_apply()?;
            p = self.applicable_proposal(id, by)?;
        }
        if let Some(verify) = p.verify.as_ref().filter(|_| p.state != "verified") {
            return Err(ControlError::new(
                "invalid_state",
                format!("proposal {id} needs a dry run first (agent.verify: {verify}) and is {}", p.state),
                format!("apply it again: pipo proposals {name} apply {id} runs the dry run first"),
            ));
        }
        let latest = p.base_version;
        if p.author_kind == "agent" {
            let internal = |e: String| ControlError::new("internal", e, "see the runner log");
            let current = self.pipeline_of(latest).await.map_err(internal)?;
            let base =
                self.compiled_version(latest).await.map_err(internal)?.pipeline.clone().unwrap_or_else(|| json!({}));
            let proposed = crate::compile::compile(&self.file, &self.home, Some(&p.source))
                .await
                .map_err(|e| ControlError::new("internal", e, "check that pipo compile works (PIPO_COMPILE)"))?;
            // A source that fails pipo check now is refused by the apply below, with its diagnostics.
            if let Some(proposed) = proposed.pipeline.as_ref().filter(|_| proposed.errors().is_empty()) {
                let problems = crate::proposals::agent_policy_problems(&current, &changed_paths(&base, proposed));
                if let Some(first) = problems.first() {
                    let all: Vec<&str> = problems.iter().map(|x| x.message.as_str()).collect();
                    return Err(ControlError::new(
                        "invalid_state",
                        format!("proposal {id} is not allowed by v{latest}'s agent policy: {}", all.join("; ")),
                        first.hint.clone(),
                    ));
                }
            }
        }
        let how = How {
            author: p.author.clone(),
            reason: p.reason.clone(),
            author_kind: Some(p.author_kind.clone()),
            proposal: Some((id.to_string(), by.to_string())),
        };
        let mut out = self.apply_version(&p.source, how).await?.to_value();
        out["proposal"] = json!(id);
        Ok(out)
    }

    /// The proposal, unless it can't be applied: `applied` or `rejected` refuse; a base that is no longer the latest is
    /// marked `rejected` (`stale base`) and refused, since it can never become current again (D49).
    fn applicable_proposal(&self, id: &str, by: &str) -> Result<Proposal, ControlError> {
        let name = self.pipeline().name.clone();
        let p = self.proposals.get(id)?;
        if p.state == "applied" {
            return Err(ControlError::new(
                "invalid_state",
                format!(
                    "proposal {id} is already applied, as v{}",
                    p.applied_version.map_or("undefined".to_string(), |v| v.to_string())
                ),
                format!("nothing to do; pipo history {name} shows it, and pipo rollback {name} <version> undoes it"),
            ));
        }
        if p.state == "rejected" {
            return Err(ControlError::new(
                "invalid_state",
                format!(
                    "proposal {id} was rejected{}, so it can't be applied",
                    p.decision.as_ref().filter(|d| !d.is_empty()).map(|d| format!(" ({d})")).unwrap_or_default()
                ),
                "propose the change again against the current version if you still want it",
            ));
        }
        let latest = self.journal.borrow().latest_version().ok().flatten().map_or(0, |l| l.version);
        if p.base_version != latest {
            let reason = format!(
                "stale base: the proposal is against v{}, but {name} was at v{latest} when it was applied; propose the change against v{latest}",
                p.base_version
            );
            self.proposals.mark_rejected(id, by, &reason, None)?;
            return Err(ControlError::new(
                "invalid_state",
                format!(
                    "stale base: proposal {id} is against v{}, but {name} is at v{latest} now, so it is rejected",
                    p.base_version
                ),
                format!("read v{latest} (pipo history {name}) and propose the change against it"),
            ));
        }
        Ok(p)
    }

    /// Apply an earlier version's source again, as a new version (§9.3, D38). Its files are compiled as they are now,
    /// so each one that differs from what v<to> recorded is a warning in the reply and the log (D60).
    pub async fn rollback(&self, to: i64, by: &str) -> Result<Value, ControlError> {
        let name = self.pipeline().name.clone();
        let source = self.journal.borrow().version_source(to).map_err(|_| {
            let latest = self.journal.borrow().latest_version().ok().flatten().map(|l| l.version).unwrap_or(0);
            ControlError::new(
                "not_found",
                format!("{name} has no version {to} (versions are v1 to v{latest})"),
                format!("list them with pipo history {name}"),
            )
        })?;
        let applied = self
            .apply_version(
                &source,
                How { author: by.to_string(), reason: format!("rollback to v{to}"), author_kind: None, proposal: None },
            )
            .await?;
        let runs = crate::versions::file_hashes(&self.compiled.borrow().files);
        let recorded = self.journal.borrow().version_files(to).ok().flatten();
        let what = if applied.changed { format!("rollback to v{to}") } else { "running".to_string() };
        let as_ = if applied.version == to { None } else { Some((applied.version, what.as_str())) };
        let changed = self.warn_all(file_changes(recorded.as_ref(), &runs, to, &name, as_));
        let mut warnings = changed;
        warnings.extend(applied.warnings.clone());
        let mut v = json!({
            "version": applied.version, "previous": applied.previous, "changed": applied.changed,
            "pending_older": applied.pending_older, "rolled_back_to": to,
        });
        if !warnings.is_empty() {
            v["warnings"] = serde_json::to_value(&warnings).unwrap_or(Value::Null);
        }
        Ok(v)
    }
}

use crate::crashpoint::crash_point;
use crate::proposals::{Proposal, changed_paths, control_tx};
