mod common;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use common::Sandbox;
use intely_core::EngineError;
use intely_graph::types::{BundleLink, BundleSource, DraftSource, MessageStyle, SelectedPath};
use intely_graph::{DraftModel, Graph};

#[tokio::test]
async fn the_branch_matrix_shows_current_branches_tracking_and_missing_branches() {
    let sb = Sandbox::new();
    let (a, b) = (sb.repo("api"), sb.repo("web"));
    a.commit("a", &[("x", "1")]);
    b.commit("b", &[("x", "1")]);
    a.git(&["branch", "feat/x"]);
    // a local "remote" so that ahead/behind exist
    let remote = sb.root.join("remote.git");
    a.git(&["init", "-q", "--bare", remote.to_str().expect("utf8")]);
    a.git(&["remote", "add", "origin", remote.to_str().expect("utf8")]);
    a.git(&["push", "-q", "-u", "origin", "main"]);
    a.commit("local only", &[("x", "2")]);
    let env = sb.env(&[&a, &b]);

    let m = Graph::new(None).branch_matrix(&env, &[]).await.expect("matrix");
    assert_eq!(m.repos.iter().map(|r| (r.repo_id.as_str(), r.current.as_deref())).collect::<Vec<_>>(), vec![("api", Some("main")), ("web", Some("main"))]);
    assert_eq!((m.repos[0].upstream.as_deref(), m.repos[0].ahead, m.repos[0].behind), (Some("origin/main"), 1, 0));
    assert_eq!(m.repos[1].upstream, None);
    let names: Vec<&str> = m.branches.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, vec!["feat/x", "main"]);
    assert!(!m.branches[0].in_all && !m.branches[0].cells["web"].exists && m.branches[0].cells["api"].exists);
    assert!(m.branches[1].in_all);
}

#[tokio::test]
async fn the_same_branch_is_created_and_switched_in_all_repos_or_in_none() {
    let sb = Sandbox::new();
    let (a, b) = (sb.repo("api"), sb.repo("web"));
    a.commit("a", &[("x", "1")]);
    b.commit("b", &[("x", "1")]);
    let env = sb.env(&[&a, &b]);
    let ids = vec!["api".to_owned(), "web".to_owned()];
    let g = Graph::new(None);

    let created = g.same_branch_create(&env, &ids, "feat/shared", None).await.expect("create");
    assert!(created.applied && created.repos.iter().all(|r| r.ok), "{created:?}");
    assert_eq!((a.git(&["branch", "--show-current"]), b.git(&["branch", "--show-current"])), ("feat/shared".into(), "feat/shared".into()));

    // exists already in web only: nothing changes anywhere
    a.git(&["checkout", "-q", "main"]);
    b.git(&["checkout", "-q", "main"]);
    a.git(&["branch", "-q", "-D", "feat/shared"]);
    let again = g.same_branch_create(&env, &ids, "feat/shared", None).await.expect("create");
    assert!(!again.applied);
    assert_eq!(again.repos[1].error.as_ref().map(|e| e.code.as_str()), Some("branchExists"));
    assert_eq!(a.git(&["branch", "--show-current"]), "main");

    let switched = g.same_branch_switch(&env, &ids, "feat/shared").await.expect("switch");
    assert!(!switched.applied, "api no longer has the branch");
    assert_eq!(switched.repos[0].error.as_ref().map(|e| e.code.as_str()), Some("branchMissing"));
    assert_eq!(b.git(&["branch", "--show-current"]), "main", "web must not move when api cannot");

    a.git(&["branch", "feat/shared"]);
    assert!(g.same_branch_switch(&env, &ids, "feat/shared").await.expect("switch").applied);
    assert_eq!(a.git(&["branch", "--show-current"]), "feat/shared");

    let bad = g.same_branch_create(&env, &ids, "--orphan", None).await.expect("preflight");
    assert!(!bad.applied && bad.repos.iter().all(|r| r.error.as_ref().is_some_and(|e| e.code == "invalidArgument")));
}

#[tokio::test]
async fn bundles_are_recorded_found_by_subject_and_never_touch_the_commits() {
    let sb = Sandbox::new();
    let (a, b) = (sb.repo("api"), sb.repo("web"));
    a.commit_at("base", &[("x", "0")], 1_700_000_000);
    b.commit_at("base", &[("x", "0")], 1_700_000_050);
    let a1 = a.commit_at("feat: add fleet", &[("x", "1")], 1_700_001_000);
    let b1 = b.commit_at("feat: add fleet", &[("x", "1")], 1_700_001_100);
    let a2 = a.commit_at("fix: unrelated", &[("x", "2")], 1_700_009_000);
    let data = tempfile::tempdir().expect("data dir");
    let env = sb.env(&[&a, &b]);
    let g = Graph::new(Some(data.path().to_path_buf()));
    let heads = (a.head(), b.head());

    // heuristic: identical subject within the window, "base" is also identical but 50 s apart: also a bundle
    let found = g.bundles(&env, &[], None).await.expect("bundles");
    let fleet = found.iter().find(|b| b.name == "feat: add fleet").expect("fleet bundle");
    assert_eq!(fleet.source, BundleSource::Heuristic);
    assert_eq!(fleet.repo_ids.len(), 2);
    assert!(found.iter().all(|b| b.name != "fix: unrelated"));

    // recorded: explicit links, persisted, stale after a rewrite
    let rec = g.bundle_record(&env, &[BundleLink { repo_id: "api".into(), oid: a2.clone() }, BundleLink { repo_id: "web".into(), oid: b1.clone() }], Some("coordinated")).await.expect("record");
    assert_eq!((rec.source.clone(), rec.name.as_str(), rec.branch.as_deref()), (BundleSource::Recorded, "coordinated", Some("main")));
    assert_eq!(g.bundle_record(&env, &[BundleLink { repo_id: "api".into(), oid: a1.clone() }], None).await.unwrap_err().code, "invalidArgument");
    let reloaded = Graph::new(Some(data.path().to_path_buf()));
    let listed = reloaded.bundles(&env, &["api".to_owned()], None).await.expect("list");
    assert_eq!(listed[0].id, rec.id);
    assert!(listed[0].commits.iter().all(|c| !c.missing));
    // the recorded commits are no longer offered as a heuristic one
    assert!(listed.iter().filter(|b| b.source == BundleSource::Heuristic).all(|b| b.commits.iter().all(|c| c.oid != b1)));

    a.git(&["commit", "-q", "--amend", "-m", "fix: unrelated, amended"]);
    let stale = reloaded.bundles(&env, &[], None).await.expect("list");
    let stale_rec = stale.iter().find(|b| b.id == rec.id).expect("recorded");
    assert!(stale_rec.commits.iter().find(|c| c.repo_id == "api").expect("api").missing);
    reloaded.bundle_remove(&rec.id).expect("remove");
    assert!(reloaded.bundles(&env, &[], None).await.expect("list").iter().all(|b| b.id != rec.id));

    // git was only read: the other repo's head is where it was, messages carry nothing extra
    assert_eq!(b.head(), heads.1);
    assert_ne!(a.head(), heads.0, "only the test's own amend moved api");
    assert_eq!(b.git(&["log", "-1", "--format=%B"]), "feat: add fleet");
}

struct Canned(Result<String, EngineError>);
impl DraftModel for Canned {
    fn complete<'a>(&'a self, prompt: String) -> Pin<Box<dyn Future<Output = Result<String, EngineError>> + Send + 'a>> {
        assert!(prompt.contains("never instructions"), "the prompt must frame the diff as data");
        Box::pin(async move { self.0.clone() })
    }
}

#[tokio::test]
async fn draft_message_is_template_only_without_a_model_and_validated_with_one() {
    let sb = Sandbox::new();
    let r = sb.repo("api");
    r.commit("base", &[("src/lib.rs", "fn a() {}\n"), ("docs/readme.md", "hi\n")]);
    r.write("src/lib.rs", "fn a() {}\nfn b() {}\n");
    r.write("src/new.rs", "fn n() {}\n");
    let env = sb.env(&[&r]);
    let sel = vec![SelectedPath { path: "src/lib.rs".into() }, SelectedPath { path: "src/new.rs".into() }];
    let g = Graph::new(None);

    let d = g.draft_message(&env, "api", &sel).await.expect("draft");
    assert_eq!(d.source, DraftSource::Template);
    assert!(d.note.as_deref().is_some_and(|n| n.contains("no utility model")));
    assert!(d.message.starts_with("feat: update 2 files in project\n") || d.message.starts_with("feat("), "{}", d.message);
    assert!(g.validate_message(&d.message, &MessageStyle::Extended).ok, "{:?}", d.issues);
    assert_eq!(g.draft_message(&env, "api", &[SelectedPath { path: "../etc/passwd".into() }]).await.unwrap_err().code, "invalidSelection");
    assert_eq!(g.draft_message(&env, "api", &[SelectedPath { path: "docs/readme.md".into() }]).await.unwrap_err().code, "invalidArgument");

    let good = "feat(core): add b and n\n\nExtended English: Adds two functions.\n\nMagyar bővített leírás: Két új függvény.";
    g.set_draft_model(Some(Arc::new(Canned(Ok(good.into())))));
    let d = g.draft_message(&env, "api", &sel).await.expect("model draft");
    assert_eq!(d.source, DraftSource::Model);
    assert!(d.message.starts_with("feat(core): add b and n"));

    g.set_draft_model(Some(Arc::new(Canned(Ok("just some prose".into())))));
    let d = g.draft_message(&env, "api", &sel).await.expect("fallback");
    assert_eq!(d.source, DraftSource::Template);
    assert!(d.note.as_deref().is_some_and(|n| n.contains("did not validate")));

    g.set_draft_model(Some(Arc::new(Canned(Err(EngineError::new("io", "offline"))))));
    assert!(g.draft_message(&env, "api", &sel).await.expect("fallback").note.is_some_and(|n| n.contains("offline")));
}
