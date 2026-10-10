// The real `pipo compile` (through bun) on examples/people-intake, then its bundle in JsFns (docs/rust-runner.md).

use std::path::PathBuf;

use pipo_runner::compile::compile;
use pipo_runner::jsfn::JsFns;
use pipo_runner::pipeline::Pipeline;
use serde_json::json;

#[tokio::test]
async fn pipo_compile_through_bun_then_call_text_transformer() {
    if std::process::Command::new("bun")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("skipped: bun is not on PATH, so `pipo compile` can't run");
        return;
    }
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let main = repo.join("packages/cli/src/main.ts");
    let argv = json!(["bun", main, "compile"]).to_string();
    // SAFETY: the only test in this binary, and nothing else reads the environment concurrently.
    unsafe { std::env::set_var("PIPO_COMPILE", argv) };
    let home = std::env::temp_dir().join(format!("pipo-compile-test-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let file = repo.join("examples/people-intake/people-intake.pipo");

    let compiled = compile(&file, &home, None).await.unwrap();
    assert!(compiled.errors().is_empty(), "{:?}", compiled.diagnostics);
    let pipeline = Pipeline::from_value(compiled.pipeline.clone().unwrap()).unwrap();
    assert_eq!(pipeline.name, "people-intake");
    let module = compiled.fn_module.clone().unwrap();
    assert_eq!(module.exports, vec!["textTransformer"]);
    assert_eq!(compiled.files["./people.fn.ts"], json!(module.hash));
    assert!(compiled.agents.is_none());
    assert_eq!(compiled.agent_manifests["claude_code"]["runs"], "cli");

    let js = JsFns::new();
    js.load(1, &module).await.unwrap();
    let out = js
        .call(
            1,
            "textTransformer",
            &json!({"name": "  Ada  ", "age": 36}),
            &json!({"packet_id": "p1"}),
        )
        .await
        .unwrap();
    assert_eq!(out, Some(json!({"name": "Ada", "age": 36, "bio": ""})));

    // --stdin: the source comes from stdin, the path anchors `fn:`; errors come back as data, not as a failure.
    let source = std::fs::read_to_string(&file)
        .unwrap()
        .replace("fn.textTransformer", "fn.missing");
    let bad = compile(&file, &home, Some(&source)).await.unwrap();
    assert!(bad.pipeline.is_none());
    assert_eq!(bad.errors()[0]["code"], "P012");

    std::fs::remove_dir_all(&home).ok();
}
