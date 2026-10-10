// The proposal store and its validation (docs/spec.md §9.3, D45–D51): changed paths, `agent.edit` patterns and the
// policy against the TypeScript outputs (fixtures/proposals.json); then, through the real `pipo compile` (bun), stale
// bases, pipo check, the path policy, audit fields, the diff, state moves and their journal events, a reopened and a
// read-only journal; and the `propose`, `apply_proposal` and `reject_proposal` ops on an in-process runner.

use std::cell::RefCell;
use std::path::PathBuf;
use std::process::Command;
use std::rc::Rc;
use std::sync::Once;
use std::sync::atomic::{AtomicUsize, Ordering};

use pipo_runner::control::ControlError;
use pipo_runner::control::ops::handle;
use pipo_runner::journal::{Journal, VersionAudit, open_readonly};
use pipo_runner::pipeline::Pipeline;
use pipo_runner::proposals::*;
use pipo_runner::runner::{Runner, RunnerOptions};
use pipo_runner::versions::sha256;
use serde_json::{Map, Value, json};

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        static N: AtomicUsize = AtomicUsize::new(0);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "pipo-proposals-{}-{nanos}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/proposals.json")).expect("fixtures/proposals.json parses")
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
}

#[test]
fn changed_paths_match_the_typescript_outputs() {
    for case in fixture()["changed"].as_array().unwrap() {
        let got = changed_paths(&case["before"], &case["after"]);
        let expected: Vec<Vec<String>> = case["expected"].as_array().unwrap().iter().map(strings).collect();
        assert_eq!(got, expected, "{} → {}", case["before"], case["after"]);
    }
}

#[test]
fn covers_and_the_agent_policy_match_the_typescript_outputs() {
    let f = fixture();
    for case in f["covers"].as_array().unwrap() {
        let got = covers(case["pattern"].as_str().unwrap(), &strings(&case["path"]));
        assert_eq!(json!(got), case["expected"], "{case}");
    }
    for case in f["policy"].as_array().unwrap() {
        let base = Pipeline::from_value(case["base"].clone()).unwrap();
        let changed: Vec<Vec<String>> = case["changed"].as_array().unwrap().iter().map(strings).collect();
        let got = serde_json::to_value(agent_policy_problems(&base, &changed)).unwrap();
        assert_eq!(got.to_string(), case["expected"].to_string(), "{}", case["base"]);
    }
}

#[test]
fn locale_compare_orders_like_bun() {
    let mut v = vec!["b", "A", "a", "_x", "-x", "1", "B", "a\0b", "ab", "Zeta", "alpha"];
    v.sort_by(|a, b| locale_compare(a, b));
    assert_eq!(v, ["_x", "-x", "1", "a", "A", "a\0b", "ab", "alpha", "b", "B", "Zeta"]);
}

// ── the store, through `pipo compile` ────────────────────────────────────────

/// Points `pipo compile` at the repo's CLI through bun; false (skip) when bun is missing.
fn compiler() -> bool {
    static ONCE: Once = Once::new();
    if Command::new("bun").arg("--version").output().is_err() {
        eprintln!("skipped: bun is not on PATH, so `pipo compile` can't run");
        return false;
    }
    ONCE.call_once(|| {
        let main =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/cli/src/main.ts").canonicalize().unwrap();
        // SAFETY: inside call_once, which every test that compiles calls before anything reads the environment.
        unsafe { std::env::set_var("PIPO_COMPILE", json!(["bun", main, "compile"]).to_string()) };
    });
    true
}

const AGENT: &str =
    "agent:\n  control: true\n  edit:\n    - nodes.*.with.message\n    - nodes.normalize\n    - errors\n";

#[derive(Default, Clone)]
struct Opts {
    message: Option<&'static str>,
    level: Option<&'static str>,
    tag: Option<&'static str>,
    format: Option<&'static str>,
    agent: Option<Option<String>>,
    extra: Option<&'static str>,
}

fn src(o: Opts) -> String {
    format!(
        r#"pipo: 1
name: demo
input: {{ via: push }}
nodes:
  normalize:
    from: input
    transform: map
    with:
      data: {{ name: "${{data.name}}", tag: {} }}
  note:
    from: normalize
    tap: log
    with: {{ level: {}, message: {} }}
output: {{ from: note, to: stdout, with: {{ format: {} }} }}
{}{}"#,
        o.tag.unwrap_or("one"),
        o.level.unwrap_or("info"),
        o.message.unwrap_or("hi"),
        o.format.unwrap_or("jsonl"),
        match o.agent {
            None => AGENT.to_string(),
            Some(None) => String::new(),
            Some(Some(a)) => a,
        },
        o.extra.unwrap_or("")
    )
}

fn msg(message: &'static str) -> Opts {
    Opts { message: Some(message), ..Default::default() }
}

fn with_agent(block: &str) -> Opts {
    Opts { agent: Some(Some(block.to_string())), ..Default::default() }
}

struct Store {
    tmp: Tmp,
    journal: Rc<RefCell<Journal>>,
    store: Proposals,
    redact: Rc<dyn Fn(&str) -> String>,
}

impl Store {
    fn db(&self) -> PathBuf {
        self.tmp.0.join("journal.db")
    }
    fn file(&self) -> PathBuf {
        self.tmp.0.join("demo.pipo")
    }
    fn open(tmp: Tmp, redact: Rc<dyn Fn(&str) -> String>) -> Store {
        let journal = Rc::new(RefCell::new(Journal::open(tmp.0.join("journal.db")).unwrap()));
        let opts = ProposalStoreOptions {
            pipeline: "demo".into(),
            file: tmp.0.join("demo.pipo"),
            home: tmp.0.join("home"),
            redact: redact.clone(),
            now: Rc::new(pipo_runner::time::now_ms),
            env: serde_json::json!({}),
        };
        Store { store: Proposals::new(journal.clone(), opts), journal, tmp, redact }
    }
    fn reopen(self) -> Store {
        let Store { tmp, journal, store, redact } = self;
        drop(store);
        Rc::try_unwrap(journal).ok().unwrap().into_inner().close().unwrap();
        Store::open(tmp, redact)
    }
    fn add_version(&self, source: &str) -> i64 {
        let hash = sha256(source.as_bytes());
        self.journal
            .borrow_mut()
            .add_version(&hash, source, "human", Some("edit"), None, &VersionAudit::default(), None)
            .unwrap()
    }
    fn events(&self) -> Vec<(String, Value)> {
        let j = self.journal.borrow();
        let mut stmt = j.db().prepare("SELECT type, detail FROM events WHERE packet_id IS NULL ORDER BY seq").unwrap();
        stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, serde_json::from_str(&r.get::<_, String>(1)?).unwrap())))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }
    fn latest(&self) -> i64 {
        self.journal.borrow().latest_version().unwrap().unwrap().version
    }
}

/// A journal at v1 of `base`, stored with its compiled form as the runner stores it.
async fn setup_with(base: &str, redact: Rc<dyn Fn(&str) -> String>) -> Store {
    let tmp = Tmp::new();
    std::fs::write(tmp.0.join("demo.pipo"), base).unwrap();
    let s = Store::open(tmp, redact);
    let compiled = pipo_runner::compile::compile(&s.file(), &s.tmp.0.join("home"), Some(base)).await.unwrap();
    assert!(compiled.errors().is_empty(), "{:?}", compiled.diagnostics);
    let hash = sha256(base.as_bytes());
    s.journal.borrow_mut().version(&hash, base, "human", Some("first start"), Some(&compiled.raw)).unwrap();
    s
}

async fn setup(base: &str) -> Store {
    setup_with(base, Rc::new(|t: &str| t.to_string())).await
}

fn input(source: &str, base: Value, kind: &str) -> ProposalInput {
    ProposalInput {
        base_version: base,
        source: json!(source),
        author: json!(if kind == "agent" { "agent-ops" } else { "cli" }),
        author_kind: json!(kind),
        reason: json!("friendlier log line"),
    }
}

fn agent(source: &str) -> ProposalInput {
    input(source, json!(1), "agent")
}

fn codes(p: &Proposal) -> Vec<String> {
    p.problems.as_array().unwrap().iter().map(|x| x["code"].as_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn an_agent_change_inside_agent_edit_is_validated_stored_and_evented() {
    if !compiler() {
        return;
    }
    let t = setup(&src(Opts::default())).await;
    let before = pipo_runner::time::now_ms();
    let p = t.store.propose(&agent(&src(msg("hello")))).await.unwrap();
    assert_eq!(p.state, "validated");
    assert!(p.id.starts_with("pr_") && p.id.len() == 29, "{}", p.id);
    let v = p.to_value();
    let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        [
            "id",
            "pipeline",
            "base_version",
            "author",
            "author_kind",
            "reason",
            "state",
            "changed_paths",
            "added",
            "removed",
            "verify",
            "applied_version",
            "decided_by",
            "created_at",
            "decided_at",
            "source",
            "diff",
            "problems",
            "diagnostics",
            "decision",
            "verification"
        ]
    );
    assert_eq!(
        (p.pipeline.as_str(), p.base_version, p.author.as_str(), p.author_kind.as_str(), p.reason.as_str()),
        ("demo", 1, "agent-ops", "agent", "friendlier log line")
    );
    assert_eq!(p.changed_paths, json!(["nodes.note.with.message"]));
    assert_eq!(
        (p.problems.clone(), p.verify.clone(), p.applied_version, p.decided_by.clone(), p.decided_at),
        (json!([]), None, None, None, None)
    );
    assert_eq!((p.added, p.removed), (1, 1));
    assert!(p.created_at >= before);
    assert_eq!(p.source, src(msg("hello")));
    assert_eq!(
        p.diff,
        [
            "--- demo v1".to_string(),
            format!("+++ demo proposal {}", p.id),
            "@@ -10,7 +10,7 @@".into(),
            "   note:".into(),
            "     from: normalize".into(),
            "     tap: log".into(),
            "-    with: { level: info, message: hi }".into(),
            "+    with: { level: info, message: hello }".into(),
            " output: { from: note, to: stdout, with: { format: jsonl } }".into(),
            " agent:".into(),
            "   control: true".into(),
        ]
        .join("\n")
    );
    let events = t.events();
    let (kind, detail) = events.last().unwrap();
    assert_eq!(kind, "proposal.validated");
    assert_eq!(
        detail.to_string(),
        json!({ "id": p.id, "base_version": 1, "author": "agent-ops", "author_kind": "agent", "reason": "friendlier log line",
                "changed_paths": ["nodes.note.with.message"] })
        .to_string()
    );
    // Proposing writes no version: only apply does.
    assert_eq!(t.latest(), 1);
}

#[tokio::test]
async fn a_stored_proposal_round_trips_from_a_reopened_and_a_read_only_journal() {
    if !compiler() {
        return;
    }
    let t = setup(&src(Opts::default())).await;
    let p = t.store.propose(&agent(&src(msg("hello")))).await.unwrap();
    let rejected = t.store.propose(&agent(&src(Opts { level: Some("warn"), ..Default::default() }))).await.unwrap();
    let t = t.reopen();
    assert_eq!(t.store.get(&p.id).unwrap(), p);
    assert_eq!(t.store.get(&rejected.id).unwrap(), rejected);
    let ids: Vec<String> = t.store.list(None, None).unwrap().into_iter().map(|x| x.id).collect();
    assert_eq!(ids, [rejected.id.clone(), p.id.clone()]);
    let ids: Vec<String> = t.store.list(Some("validated"), None).unwrap().into_iter().map(|x| x.id).collect();
    assert_eq!(ids, [p.id.as_str()]);
    let ro = open_readonly(t.db(), 1000).unwrap();
    assert_eq!(read_get(&ro, &p.id).unwrap(), Some(p));
    let summary = serde_json::to_value(&read_list(&ro, Some("rejected"), None).unwrap()[0]).unwrap();
    assert!(summary.get("source").is_none());
}

#[tokio::test]
async fn edit_patterns_cover_subtrees_and_star_is_one_segment() {
    if !compiler() {
        return;
    }
    let t = setup(&src(Opts::default())).await;
    let p = t.store.propose(&agent(&src(Opts { tag: Some("two"), ..Default::default() }))).await.unwrap();
    assert_eq!(p.state, "validated");
    assert_eq!(p.changed_paths, json!(["nodes.normalize.with.data.tag"]));
    let p = t.store.propose(&agent(&src(Opts { level: Some("warn"), ..Default::default() }))).await.unwrap();
    assert_eq!(p.state, "rejected");
    assert_eq!(
        (p.problems[0]["code"].as_str(), p.problems[0]["path"].as_str()),
        (Some("not_editable"), Some("nodes.note.with.level"))
    );
    assert!(p.problems[0]["hint"].as_str().unwrap().contains("agent.edit"));
    // Every problem at once.
    let o = Opts {
        message: Some("hello"),
        extra: Some("description: changed by an agent\nbuffer: { max: 10 }\n"),
        ..Default::default()
    };
    let p = t.store.propose(&agent(&src(o))).await.unwrap();
    assert_eq!(p.changed_paths, json!(["buffer", "description", "nodes.note.with.message"]));
    let found: Vec<(String, String)> = p
        .problems
        .as_array()
        .unwrap()
        .iter()
        .map(|x| (x["code"].as_str().unwrap().into(), x["path"].as_str().unwrap().into()))
        .collect();
    assert_eq!(
        found,
        [("not_editable".to_string(), "buffer".to_string()), ("not_editable".into(), "description".into())]
    );
    let last = t.events().pop().unwrap().1;
    assert_eq!(
        last["problems"],
        json!([{ "code": "not_editable", "path": "buffer" }, { "code": "not_editable", "path": "description" }])
    );
}

#[tokio::test]
async fn agents_may_never_change_the_forbidden_keys() {
    if !compiler() {
        return;
    }
    let policy =
        "agent:\n  control: true\n  edit: [\"*\", output, delivered, secrets, agent, agent_budget]\n".to_string();
    let changes: Vec<(&str, Opts)> = vec![
        ("output", Opts { format: Some("json"), ..with_agent(&policy) }),
        ("delivered", Opts { extra: Some("delivered: { check: none }\n"), ..with_agent(&policy) }),
        ("secrets", Opts { extra: Some("secrets: { token: env:PIPO_TEST_TOKEN }\n"), ..with_agent(&policy) }),
        ("agent", with_agent(&format!("{policy}  redact: [data.name]\n"))),
        // D47: an agent can't raise its own spending cap, even with edit: ["*"].
        ("agent_budget", Opts { extra: Some("agent_budget: { per_day: 100 }\n"), ..with_agent(&policy) }),
    ];
    let t = setup(&src(with_agent(&policy))).await;
    for (key, change) in changes {
        let p = t.store.propose(&agent(&src(change))).await.unwrap();
        assert_eq!(p.state, "rejected", "{key}");
        let paths = strings(&p.changed_paths);
        assert!(
            !paths.is_empty() && paths.iter().all(|c| c == key || c.starts_with(&format!("{key}."))),
            "{key}: {paths:?}"
        );
        assert!(codes(&p).contains(&"forbidden_path".into()), "{key}: {:?}", p.problems);
        assert!(!codes(&p).contains(&"not_editable".into()));
        let forbidden = p.problems.as_array().unwrap().iter().find(|x| x["code"] == "forbidden_path").unwrap();
        assert!(forbidden["message"].as_str().unwrap().contains(&format!("`{key}`")));
    }
}

#[tokio::test]
async fn a_pipeline_without_agent_control_or_edit_takes_no_agent_proposals() {
    if !compiler() {
        return;
    }
    for block in [None, Some("agent:\n  control: false\n  edit: [nodes]\n"), Some("agent:\n  control: true\n")] {
        let o = Opts { agent: Some(block.map(str::to_string)), ..Default::default() };
        let t = setup(&src(o.clone())).await;
        let p = t.store.propose(&agent(&src(Opts { message: Some("hello"), ..o }))).await.unwrap();
        assert_eq!(p.state, "rejected");
        assert_eq!(codes(&p), ["not_allowed"]);
        assert!(p.problems[0]["hint"].as_str().unwrap().contains("human"));
    }
}

#[tokio::test]
async fn a_human_is_held_only_to_check_and_what_apply_allows() {
    if !compiler() {
        return;
    }
    let none = || Opts { agent: Some(None), ..Default::default() };
    let t = setup(&src(none())).await;
    let ok = t
        .store
        .propose(&input(&src(Opts { format: Some("json"), level: Some("warn"), ..none() }), json!("v1"), "human"))
        .await
        .unwrap();
    assert_eq!(ok.state, "validated");
    assert_eq!(ok.changed_paths, json!(["nodes.note.with.level", "output.with.format"]));
    let bound = t
        .store
        .propose(&input(&src(Opts { extra: Some("concurrency: 2\n"), ..none() }), json!(1), "human"))
        .await
        .unwrap();
    assert_eq!(bound.state, "rejected");
    assert_eq!(codes(&bound), ["bound_change"]);
    assert!(bound.problems[0]["message"].as_str().unwrap().contains("concurrency"));
}

#[tokio::test]
async fn stale_bases_check_failures_no_change_and_comments() {
    if !compiler() {
        return;
    }
    let t = setup(&src(Opts::default())).await;
    // A source that fails pipo check is rejected with its diagnostics.
    let p = t.store.propose(&agent(&src(msg("hello")).replace("from: normalize", "from: nowhere"))).await.unwrap();
    assert_eq!(p.state, "rejected");
    assert!(codes(&p).contains(&"invalid_pipeline".into()));
    assert!(p.diagnostics.as_array().unwrap().iter().any(|d| d["code"] == "P010"));
    let bad = t.store.propose(&agent("pipo: 1\nname: [demo\n")).await.unwrap();
    assert_eq!((bad.state.as_str(), bad.changed_paths.clone()), ("rejected", json!([])));
    assert_eq!(bad.diagnostics[0]["code"], "P001");
    // The same source as the base is no change; a comment is no path.
    assert_eq!(codes(&t.store.propose(&agent(&src(Opts::default()))).await.unwrap()), ["no_change"]);
    let c = t.store.propose(&agent(&format!("# reviewed\n{}", src(Opts::default())))).await.unwrap();
    assert_eq!((c.state.as_str(), c.changed_paths.clone()), ("validated", json!([])));
    // A stale base: the diff is still against the base the author named.
    t.add_version(&src(Opts { tag: Some("two"), ..Default::default() }));
    let p = t.store.propose(&agent(&src(msg("hello")))).await.unwrap();
    assert_eq!(codes(&p), ["stale_base"]);
    assert!(p.problems[0]["message"].as_str().unwrap().contains("v2"));
    assert!(p.problems[0]["hint"].as_str().unwrap().contains("v2"));
    assert_eq!(p.diff.split('\n').next(), Some("--- demo v1"));
    // Against v2, stored without a compiled form, the base is compiled from its source.
    let p = t
        .store
        .propose(&input(
            &src(Opts { tag: Some("two"), message: Some("hello"), ..Default::default() }),
            json!(2),
            "agent",
        ))
        .await
        .unwrap();
    assert_eq!((p.state.as_str(), p.changed_paths.clone()), ("validated", json!(["nodes.note.with.message"])));
}

#[tokio::test]
async fn bad_input_stores_nothing() {
    if !compiler() {
        return;
    }
    let t = setup(&src(Opts::default())).await;
    let e = |r: Result<Proposal, ControlError>| r.unwrap_err();
    let unknown = e(t.store.propose(&input(&src(msg("x")), json!(9), "agent")).await);
    assert_eq!(
        (unknown.code, unknown.message.as_str()),
        ("not_found", "demo has no version 9 (versions are v1 to v1)")
    );
    let mut blank = agent(&src(msg("x")));
    blank.reason = json!(" ");
    assert_eq!(e(t.store.propose(&blank).await).code, "bad_request");
    let latest = e(t.store.propose(&input(&src(msg("x")), json!("latest"), "agent")).await);
    assert_eq!(latest.message, "`base_version` must be a version number, got \"latest\"");
    let robot = e(t.store.propose(&input(&src(msg("x")), json!(1), "robot")).await);
    assert_eq!(robot.message, "`author_kind` must be agent or human, got \"robot\"");
    let mut long = agent(&src(msg("x")));
    long.author = json!("a".repeat(201));
    assert_eq!(e(t.store.propose(&long).await).message, "`author` is longer than 200 characters");
    let mut big = agent(&src(msg("x")));
    big.source = json!(format!("{}#{}", src(msg("x")), "x".repeat(MAX_SOURCE_BYTES)));
    assert_eq!(e(t.store.propose(&big).await).message, "`source` is larger than 1048576 bytes");
    let missing = t.store.get("pr_nope").unwrap_err();
    assert_eq!((missing.code, missing.hint.as_deref()), ("not_found", Some("list them with pipo proposals demo")));
    assert!(t.store.list(None, None).unwrap().is_empty());
    assert!(t.events().is_empty());
}

#[tokio::test]
async fn reasons_diagnostics_and_events_are_redacted_and_the_source_kept() {
    if !compiler() {
        return;
    }
    let t = setup_with(&src(Opts::default()), Rc::new(|s: &str| s.replace("s3cr3t-value", "***"))).await;
    let mut i = agent(&src(msg("hello")));
    i.reason = json!("token s3cr3t-value leaked");
    let p = t.store.propose(&i).await.unwrap();
    assert_eq!(p.reason, "token *** leaked");
    assert!(!format!("{:?}", t.events()).contains("s3cr3t-value"));
    let r = t.store.mark_rejected(&p.id, "cli", "s3cr3t-value again", Some(json!({ "k": "s3cr3t-value" }))).unwrap();
    assert_eq!((r.decision.as_deref(), r.verification.clone()), (Some("*** again"), json!({ "k": "***" })));
}

#[tokio::test]
async fn applied_commits_with_the_version_or_not_at_all() {
    if !compiler() {
        return;
    }
    let t = setup(&src(Opts::default())).await;
    let p = t.store.propose(&agent(&src(msg("hello")))).await.unwrap();
    let rival = t.store.propose(&agent(&src(Opts { tag: Some("two"), ..Default::default() }))).await.unwrap();
    let apply = |id: &str, source: &str, version: Option<i64>| {
        let hash = sha256(source.as_bytes());
        control_tx(&mut t.journal.borrow_mut(), |j| {
            let v = j.add_version(&hash, source, "human", None, None, &VersionAudit::default(), None).unwrap();
            t.store.mark_applied_in(j, id, version.unwrap_or(v), "agent-ops")
        })
    };
    // A wrong version number rolls the whole transaction back, version included.
    let wrong = apply(&p.id, &p.source, Some(7)).unwrap_err();
    assert_eq!(wrong.message, format!("proposal {} is against v1, so it can only become v2, not v7", p.id));
    assert_eq!(t.latest(), 1);
    assert_eq!(t.store.get(&p.id).unwrap().state, "validated");
    let applied = apply(&p.id, &p.source, None).unwrap();
    assert_eq!(
        (applied.state.as_str(), applied.applied_version, applied.decided_by.as_deref()),
        ("applied", Some(2), Some("agent-ops"))
    );
    assert!(applied.decided_at.is_some());
    let t = t.reopen();
    assert_eq!(t.store.get(&p.id).unwrap().state, "applied");
    let (kind, detail) = t.events().pop().unwrap();
    assert_eq!(kind, "proposal.applied");
    assert_eq!(
        detail.to_string(),
        json!({ "id": p.id, "base_version": 1, "by": "agent-ops", "version": 2 }).to_string()
    );
    // Decided proposals stay decided.
    let again = t.store.mark_rejected(&p.id, "cli", "no", None).unwrap_err();
    assert_eq!(
        (again.code, again.message.clone()),
        ("invalid_state", format!("proposal {} is applied, so it can't become rejected", p.id))
    );
    assert_eq!(again.hint.as_deref(), Some("it is decided; propose the change again if you still want it"));
    // A rival validated on the same base can't land on top of v2.
    let hash = sha256(rival.source.as_bytes());
    let late = control_tx(&mut t.journal.borrow_mut(), |j| {
        let v = j.add_version(&hash, &rival.source, "human", None, None, &VersionAudit::default(), None).unwrap();
        t.store.mark_applied_in(j, &rival.id, v, "agent-ops")
    })
    .unwrap_err();
    assert!(late.message.ends_with("can only become v2, not v3"), "{}", late.message);
    assert_eq!(t.latest(), 2);
    assert_eq!(t.store.mark_rejected(&rival.id, "runner", "stale: v2 was applied", None).unwrap().state, "rejected");
    let next = t
        .store
        .propose(&input(
            &src(Opts { message: Some("hello"), tag: Some("three"), ..Default::default() }),
            json!(2),
            "agent",
        ))
        .await
        .unwrap();
    assert_eq!(next.state, "validated");
}

#[tokio::test]
async fn agent_verify_requires_a_verified_dry_run_before_apply() {
    if !compiler() {
        return;
    }
    let policy = format!("{AGENT}  verify: last 5\n");
    let t = setup(&src(with_agent(&policy))).await;
    let p = t.store.propose(&agent(&src(Opts { message: Some("hello"), ..with_agent(&policy) }))).await.unwrap();
    assert_eq!(p.verify.as_deref(), Some("last 5"));
    let hash = sha256(p.source.as_bytes());
    let refused = control_tx(&mut t.journal.borrow_mut(), |j| {
        let v = j.add_version(&hash, &p.source, "human", None, None, &VersionAudit::default(), None).unwrap();
        t.store.mark_applied_in(j, &p.id, v, "agent-ops")
    })
    .unwrap_err();
    assert!(refused.message.contains("needs a dry run"), "{}", refused.message);
    assert!(refused.hint.as_deref().unwrap().contains(&format!("pipo proposals demo apply {}", p.id)));
    assert_eq!(t.latest(), 1);
    // Nothing was delivered yet, so the dry run has nothing to replay and passes.
    let v = t.store.dry_run_if_required(&p.id).await.unwrap();
    assert_eq!(v.state, "verified");
    assert_eq!(v.decision.as_deref(), Some("dry run passed (last 5): no delivered packets to replay"));
    assert_eq!(v.verification["replayed"], json!(0));
    assert_eq!(t.store.dry_run_if_required(&p.id).await.unwrap().state, "verified");
    let again = t.store.dry_run(&p.id, "dry-run").await.unwrap_err();
    assert_eq!(again.code, "invalid_state");
    assert!(again.hint.as_deref().unwrap().contains(&format!("pipo proposals demo apply {}", p.id)));
    let twice = t.store.mark_verified(&p.id, "runner", None, None).unwrap_err();
    assert!(twice.message.contains("is verified"));
    let r = t.store.mark_rejected(&p.id, "cli", "not now", None).unwrap();
    assert_eq!(
        (r.state.as_str(), r.decision.as_deref(), r.decided_by.as_deref()),
        ("rejected", Some("not now"), Some("cli"))
    );
    assert_eq!(r.verification["verify"], json!("last 5"));
    let kinds: Vec<String> = t.events().into_iter().map(|e| e.0).collect();
    assert_eq!(kinds, ["proposal.validated", "proposal.verified", "proposal.rejected"]);
    // A human's proposal has no dry-run requirement.
    let human =
        t.store.propose(&input(&src(Opts { tag: Some("x"), ..with_agent(&policy) }), json!(1), "human")).await.unwrap();
    assert_eq!(human.verify, None);
    assert_eq!(t.store.dry_run_if_required(&human.id).await.unwrap().id, human.id);
    let direct = t.store.dry_run(&human.id, "dry-run").await.unwrap_err();
    assert_eq!((direct.code, direct.hint.as_deref()), ("invalid_state", Some("apply it directly")));
}

#[tokio::test]
async fn a_dry_run_whose_base_went_stale_rejects_without_a_report() {
    if !compiler() {
        return;
    }
    let policy = format!("{AGENT}  verify: last 5\n");
    let t = setup(&src(with_agent(&policy))).await;
    let p = t.store.propose(&agent(&src(Opts { message: Some("hello"), ..with_agent(&policy) }))).await.unwrap();
    assert_eq!((p.state.as_str(), p.verify.as_deref()), ("validated", Some("last 5")));
    t.add_version(&src(Opts { tag: Some("two"), ..with_agent(&policy) }));
    let r = t.store.dry_run(&p.id, "dry-run").await.unwrap();
    assert_eq!((r.state.as_str(), r.verification.clone()), ("rejected", Value::Null));
    assert!(r.decision.as_deref().unwrap().starts_with("stale base: the proposal is against v1"), "{:?}", r.decision);
    let kinds: Vec<String> = t.events().into_iter().map(|e| e.0).collect();
    assert_eq!(kinds, ["proposal.validated", "proposal.rejected"]);
}

#[tokio::test]
async fn a_journal_from_before_proposals_reads_empty_then_gets_the_table() {
    if !compiler() {
        return;
    }
    let t = setup(&src(Opts::default())).await;
    t.journal.borrow().db().execute_batch("DROP TABLE proposals").unwrap();
    {
        let ro = open_readonly(t.db(), 1000).unwrap();
        assert!(read_list(&ro, None, None).unwrap().is_empty());
        assert_eq!(read_get(&ro, "pr_x").unwrap(), None);
    }
    let t = t.reopen();
    assert_eq!(t.latest(), 1);
    assert_eq!(t.store.propose(&agent(&src(msg("hello")))).await.unwrap().state, "validated");
}

// ── the ops on an in-process runner ──────────────────────────────────────────

const OPS_AGENT: &str = "agent:\n  control: true\n  edit: [nodes.tag]\n";

fn po(tag: &str, format: &str, verify: bool) -> String {
    format!(
        "pipo: 1\nname: po\ninput: {{ via: push }}\nnodes:\n  tag: {{ from: input, transform: map, with: {{ data: {{ v: {tag} }} }} }}\noutput: {{ from: tag, to: stdout, with: {{ format: {format} }} }}\n{OPS_AGENT}{}",
        if verify { "  verify: last 5\n" } else { "" }
    )
}

async fn op(r: &Rc<Runner>, name: &str, args: Value) -> Result<Value, ControlError> {
    handle(r, name, args.as_object().unwrap()).await.map(|(v, _)| v)
}

async fn runner(tmp: &Tmp, source: &str) -> Rc<Runner> {
    let file = tmp.0.join("po.pipo");
    std::fs::write(&file, source).unwrap();
    let opts = RunnerOptions {
        file,
        home: tmp.0.join("home"),
        log: Some(Rc::new(|_: &str| {})),
        print: Some(Rc::new(|_: &str| {})),
        ..Default::default()
    };
    let r = Runner::open(opts).await.unwrap_or_else(|e| panic!("{}: {:?}", e.message, e.diagnostics));
    r.start().await.unwrap_or_else(|e| panic!("{}", e.message));
    r
}

fn propose_args(source: &str, extra: Value) -> Value {
    let mut a = json!({ "source": source, "base_version": 1, "reason": "tune", "author": "agent-ops" });
    for (k, v) in extra.as_object().unwrap() {
        a[k] = v.clone();
    }
    a
}

#[test]
fn propose_apply_and_reject_over_the_ops() {
    if !compiler() {
        return;
    }
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    tokio::task::LocalSet::new().block_on(&rt, async {
        let tmp = Tmp::new();
        let r = runner(&tmp, &po("one", "jsonl", false)).await;

        // A valid agent proposal is applied right away as v2, then listed and read back.
        let p = op(&r, "propose", propose_args(&po("two", "jsonl", false), json!({ "author_kind": "agent" })))
            .await
            .unwrap();
        assert_eq!(
            (p["state"].as_str(), p["applied_version"].as_i64(), p["base_version"].as_i64()),
            (Some("applied"), Some(2), Some(1))
        );
        assert!(
            p["diff"].as_str().unwrap().contains("+  tag: { from: input, transform: map, with: { data: { v: two } } }")
        );
        assert_eq!(r.version(), 2);
        let list = op(&r, "proposals", json!({})).await.unwrap();
        assert_eq!(list["proposals"][0]["id"], p["id"]);
        assert_eq!(op(&r, "proposals", json!({ "state": "rejected" })).await.unwrap()["proposals"], json!([]));
        assert_eq!(op(&r, "proposal", json!({ "id": p["id"] })).await.unwrap()["state"], "applied");
        let history = op(&r, "versions", json!({})).await.unwrap();
        assert_eq!(
            (history["versions"][0]["author_kind"].as_str(), history["current"].as_i64()),
            (Some("agent"), Some(2))
        );
        assert_eq!(history["versions"][0]["proposal"], p["id"]);
        let audit = op(&r, "version", json!({ "version": 2 })).await.unwrap();
        assert!(audit["diff"].as_str().unwrap().starts_with("--- po v1\n+++ po v2"));

        // author_kind defaults to human, and a human may change the output.
        let h =
            op(&r, "propose", propose_args(&po("two", "json", false), json!({ "base_version": 2, "author": "ada" })))
                .await
                .unwrap();
        assert_eq!(
            (h["state"].as_str(), h["author_kind"].as_str(), h["applied_version"].as_i64()),
            (Some("applied"), Some("human"), Some(3))
        );

        // An agent touching output is stored rejected, not an error, and nothing is applied.
        let o = op(
            &r,
            "propose",
            propose_args(&po("x", "jsonl", false), json!({ "base_version": 3, "author_kind": "agent" })),
        )
        .await
        .unwrap();
        assert_eq!(o["state"], "rejected");
        assert!(o["problems"].as_array().unwrap().iter().any(|x| x["code"] == "forbidden_path"));
        assert_eq!(r.version(), 3);

        // apply: false holds it; apply_proposal applies it later.
        let held =
            op(&r, "propose", propose_args(&po("three", "json", false), json!({ "base_version": 3, "apply": false })))
                .await
                .unwrap();
        assert_eq!(held["state"], "validated");
        assert_eq!(r.version(), 3);
        let applied = op(&r, "apply_proposal", json!({ "id": held["id"], "by": "ada" })).await.unwrap();
        assert_eq!(
            applied,
            json!({ "version": 4, "previous": 3, "changed": true, "pending_older": 0, "proposal": held["id"] })
        );
        let again = op(&r, "apply_proposal", json!({ "id": held["id"] })).await.unwrap_err();
        assert_eq!(again.message, format!("proposal {} is already applied, as v4", held["id"].as_str().unwrap()));

        // A held proposal can be rejected; a decided one can't be rejected again, or applied.
        let held =
            op(&r, "propose", propose_args(&po("four", "json", false), json!({ "base_version": 4, "apply": false })))
                .await
                .unwrap();
        let rej =
            op(&r, "reject_proposal", json!({ "id": held["id"], "reason": "not now", "by": "ada" })).await.unwrap();
        assert_eq!(
            (rej["state"].as_str(), rej["decision"].as_str(), rej["decided_by"].as_str()),
            (Some("rejected"), Some("not now"), Some("ada"))
        );
        let twice = op(&r, "reject_proposal", json!({ "id": held["id"], "reason": "again" })).await.unwrap_err();
        assert_eq!(twice.code, "invalid_state");
        assert!(twice.hint.unwrap().contains("propose the change again"));
        let refused = op(&r, "apply_proposal", json!({ "id": held["id"], "by": "ada" })).await.unwrap_err();
        assert_eq!(
            refused.message,
            format!("proposal {} was rejected (not now), so it can't be applied", held["id"].as_str().unwrap())
        );

        // A stale base is stored rejected; a held one whose base went stale is rejected when applied.
        let stale_held =
            op(&r, "propose", propose_args(&po("five", "json", false), json!({ "base_version": 4, "apply": false })))
                .await
                .unwrap();
        let six =
            op(&r, "propose", propose_args(&po("six", "json", false), json!({ "base_version": 4 }))).await.unwrap();
        assert_eq!(six["state"], "applied");
        let stale =
            op(&r, "propose", propose_args(&po("one", "json", false), json!({ "base_version": 4 }))).await.unwrap();
        assert_eq!(
            (stale["state"].as_str(), stale["problems"][0]["code"].as_str()),
            (Some("rejected"), Some("stale_base"))
        );
        let late = op(&r, "apply_proposal", json!({ "id": stale_held["id"], "by": "ada" })).await.unwrap_err();
        assert!(late.message.starts_with("stale base:"), "{}", late.message);
        let marked = op(&r, "proposal", json!({ "id": stale_held["id"] })).await.unwrap();
        assert_eq!((marked["state"].as_str(), marked["decided_by"].as_str()), (Some("rejected"), Some("ada")));
        assert!(
            marked["decision"]
                .as_str()
                .unwrap()
                .starts_with("stale base: the proposal is against v4, but po was at v5")
        );

        // Bad input is bad_request with a hint and stores nothing.
        let before = op(&r, "proposals", json!({})).await.unwrap()["proposals"].as_array().unwrap().len();
        for a in [
            json!({ "source": "", "base_version": 5, "reason": "x" }),
            json!({ "source": po("two", "json", false), "base_version": "nope", "reason": "x" }),
            json!({ "source": po("two", "json", false), "base_version": 5 }),
            json!({ "source": po("two", "json", false), "base_version": 5, "reason": "x", "author_kind": "robot" }),
            json!({ "source": po("two", "json", false), "base_version": 5, "reason": "x", "apply": "yes" }),
            json!({ "source": po("two", "json", false), "base_version": 5, "reason": "x", "apply": null }),
        ] {
            let e = op(&r, "propose", a.clone()).await.unwrap_err();
            assert_eq!(e.code, "bad_request", "{a}");
            assert!(e.hint.is_some());
        }
        assert_eq!(op(&r, "proposals", json!({})).await.unwrap()["proposals"].as_array().unwrap().len(), before);
        assert_eq!(op(&r, "proposals", json!({ "state": "bogus" })).await.unwrap_err().code, "bad_request");
        assert_eq!(op(&r, "proposal", json!({ "id": "pr_nope" })).await.unwrap_err().code, "not_found");
        assert_eq!(op(&r, "reject_proposal", json!({ "id": "pr_x" })).await.unwrap_err().code, "bad_request");
        assert_eq!(op(&r, "apply_proposal", json!({})).await.unwrap_err().code, "bad_request");

        r.stop(0).await;
        // The same reads from the journal with no runner.
        let path = tmp.0.join("home/pipelines/po/journal.db");
        let list = pipo_runner::control::reads::offline_read(&path, "proposals", &Map::new(), "po").unwrap().unwrap();
        assert_eq!(list["result"]["proposals"][0]["id"], stale["id"]);
    });
}

#[test]
fn an_agent_proposal_is_dry_run_then_applied() {
    if !compiler() {
        return;
    }
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    tokio::task::LocalSet::new().block_on(&rt, async {
        let tmp = Tmp::new();
        let r = runner(&tmp, &po("one", "jsonl", true)).await;
        let p = op(&r, "propose", propose_args(&po("two", "jsonl", true), json!({ "author_kind": "agent" })))
            .await
            .unwrap();
        // The dry run runs first (nothing delivered yet, so it passes), then the proposal applies.
        assert_eq!((p["state"].as_str(), p["verify"].as_str()), (Some("applied"), Some("last 5")));
        assert!(p["decision"].as_str().unwrap_or_default().starts_with("dry run passed (last 5)"));
        assert_eq!(r.version(), 2);
        let e = op(&r, "apply_proposal", json!({ "id": p["id"], "by": "ada" })).await.unwrap_err();
        assert_eq!(e.code, "invalid_state");
        // A human's proposal needs no dry run.
        let h =
            op(&r, "propose", propose_args(&po("three", "jsonl", true), json!({ "author": "ada", "base_version": 2 })))
                .await
                .unwrap();
        assert_eq!(h["state"], "applied");
        r.stop(0).await;
    });
}
