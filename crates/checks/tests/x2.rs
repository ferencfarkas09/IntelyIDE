//! Fixture tests of the Wave 3 X2 extras. Every repo is a throwaway `tempfile` directory with the global and system git
//! config switched off; the real repositories are never touched. Secret-looking strings are assembled at run time so this
//! file holds no token-shaped literal.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use intely_checks::discover::{discover, Planned};
use intely_checks::envnames::{analyze, analyze_repo, is_real_env, read_names, referenced_names};
use intely_checks::hygiene::{delete_branch, report};
use intely_checks::runner::{CheckRunner, CheckSink};
use intely_checks::secrets::{detect, redact, redact_line, scan_diff, scan_paths, scan_text};
use intely_checks::types::{CheckInfo, CheckRun, CheckStatus, LogChunk};
use intely_checks::worktrees::{CreateRequest, WorktreeStore};
use intely_core::jail::Jail;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"])
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    git(d.path(), &["init", "-q", "-b", "main"]);
    fs::write(d.path().join("a.txt"), "one\n").unwrap();
    git(d.path(), &["add", "a.txt"]);
    git(d.path(), &["commit", "-q", "-m", "first"]);
    d
}

fn branch_with_commit(d: &Path, name: &str, file: &str) {
    git(d, &["checkout", "-q", "-b", name]);
    fs::write(d.join(file), "x\n").unwrap();
    git(d, &["add", file]);
    git(d, &["commit", "-q", "-m", &format!("work on {name}")]);
    git(d, &["checkout", "-q", "main"]);
}

fn fake(prefix: &str, body: &str) -> String {
    format!("{prefix}{body}")
}

// ---- secrets ------------------------------------------------------------------------------------------------------

fn canaries() -> Vec<(&'static str, String)> {
    let jwt = format!("{}.{}.{}", fake("eyJ", "hbGciOiJIUzI1NiJ9"), fake("eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0"), "dummysignature123");
    vec![
        ("GitHub token", fake("ghp_", &"a1B2".repeat(9))),
        ("GitHub token", fake("github_pat_", &"Zz9_".repeat(8))),
        ("AWS access key id", fake("AKIA", "ABCDEFGHIJKLMNOP")),
        ("JWT", jwt),
        ("Slack token", fake("xoxb-", "1234567890-abcdefghij")),
        ("Stripe live key", fake("sk_live_", "abcdefghijklmnop1234")),
        ("Google API key", fake("AIza", &"Sy_0".repeat(9))),
    ]
}

#[test]
fn every_token_shape_is_found_and_redacted() {
    for (kind, token) in canaries() {
        let line = format!("const k = \"{token}\";");
        let hits = detect(&line);
        assert_eq!(hits.len(), 1, "{kind}: {line}");
        assert_eq!(hits[0].kind, kind);
        let red = redact_line(&line);
        assert!(!red.contains(&token), "{kind} leaked: {red}");
        assert!(red.contains(&format!("[redacted: {kind}]")), "{red}");
    }
}

#[test]
fn url_credentials_and_private_keys_are_found() {
    let pw = fake("p4ss", "W0rdX9");
    let line = format!("MONGO_URL=mongodb+srv://admin:{pw}@cluster0.example.net/db");
    let hits = detect(&line);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].kind, "Credentials in a URL");
    let red = redact_line(&line);
    assert!(!red.contains(&pw) && red.contains("admin:") && red.contains("@cluster0"), "{red}");
    let header = format!("-----BEGIN {} PRIVATE KEY-----", "RSA");
    assert_eq!(detect(&header)[0].kind, "Private key");
    assert!(!redact_line(&header).contains("BEGIN RSA"));
}

#[test]
fn lookalikes_and_placeholders_are_not_findings() {
    for line in [
        "const t = process.env.GITHUB_TOKEN;",
        "url = `postgres://user:${PASSWORD}@db/app`",
        "postgres://user:password@localhost:5432/dev",
        "https://example.com/path?x=1",
        "ghp_short",
        "eyJhbGciOiJIUzI1NiJ9.onlytwosegments",
        "AKIA_NOT_A_KEY",
        "xghp_not_a_boundary_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "mongodb://user:<password>@host/db",
        "see https://user:xxxxxxxx@host/",
    ] {
        assert!(detect(line).is_empty(), "false positive: {line}");
    }
}

#[test]
fn only_added_lines_of_a_diff_count_and_line_numbers_follow_the_new_file() {
    let token = fake("ghp_", &"q".repeat(36));
    let old = fake("ghp_", &"w".repeat(36));
    let diff = format!(
        "diff --git a/src/a.js b/src/a.js\nindex 1..2 100644\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1,3 +1,4 @@\n const a = 1;\n-const old = \"{old}\";\n+const b = 2;\n+const t = \"{token}\";\n context {old}\n"
    );
    let f = scan_diff(&diff);
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!((f[0].path.as_str(), f[0].line, f[0].kind.as_str()), ("src/a.js", 3, "GitHub token"));
    assert!(!f[0].preview.contains(&token) && f[0].preview.contains("[redacted: GitHub token]"));
}

#[test]
fn env_files_are_never_scanned_or_read_for_secrets() {
    let token = fake("ghp_", &"z".repeat(36));
    let diff = format!("--- a/.env\n+++ b/.env\n@@ -0,0 +1 @@\n+TOKEN={token}\n");
    assert!(scan_diff(&diff).is_empty());
    assert!(scan_text(".env.local", &format!("TOKEN={token}")).is_empty());
    assert_eq!(scan_text("src/x.js", &format!("a\nb {token}\n")).iter().map(|f| f.line).collect::<Vec<_>>(), vec![2]);
}

#[test]
fn redact_keeps_multi_line_text_shape() {
    let token = fake("ghp_", &"k".repeat(36));
    let out = redact(&format!("first\nsecond {token}\nthird"));
    assert_eq!(out.lines().count(), 3);
    assert!(!out.contains(&token));
}

// ---- env names ----------------------------------------------------------------------------------------------------

#[test]
fn a_real_env_file_is_refused_and_an_example_gives_names_only() {
    let d = tempfile::tempdir().unwrap();
    let value = "CANARY_VALUE_do_not_leak";
    fs::write(d.path().join(".env"), format!("REAL_ONLY_KEY={value}\n")).unwrap();
    fs::write(d.path().join(".env.local"), format!("LOCAL_KEY={value}\n")).unwrap();
    fs::write(d.path().join(".env.example"), format!("# comment\nPORT=3000\nexport DB_URL={value}\nbad key=1\n  API_KEY = {value}\n")).unwrap();
    assert!(read_names(&d.path().join(".env")).is_err());
    assert!(read_names(&d.path().join(".env.local")).is_err());
    assert_eq!(read_names(&d.path().join(".env.example")).unwrap(), vec!["API_KEY", "DB_URL", "PORT"]);
    assert!(is_real_env(".env") && is_real_env("sub/.env.production") && !is_real_env(".env.example"));
    let json = serde_json::to_string(&analyze_repo("r", d.path())).unwrap();
    assert!(!json.contains(value) && !json.contains("REAL_ONLY_KEY") && !json.contains("LOCAL_KEY"), "{json}");
    assert!(json.contains("\"kind\":\"real\""));
}

#[test]
fn references_are_found_and_compared_with_the_declared_names() {
    let d = tempfile::tempdir().unwrap();
    fs::write(d.path().join(".env.example"), "DECLARED_USED=\nDECLARED_UNUSED=\n").unwrap();
    fs::create_dir_all(d.path().join("src")).unwrap();
    fs::create_dir_all(d.path().join("node_modules/dep")).unwrap();
    fs::write(d.path().join("src/a.js"), "const a = process.env.DECLARED_USED + process.env['MISSING_ONE'] + process.env.NODE_ENV;\n").unwrap();
    fs::write(d.path().join("src/b.ts"), "export const u = import.meta.env.VITE_MISSING_TWO;\n").unwrap();
    fs::write(d.path().join("node_modules/dep/x.js"), "process.env.FROM_DEPENDENCY\n").unwrap();
    let r = analyze_repo("r", d.path());
    assert_eq!(r.missing.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), vec!["MISSING_ONE", "VITE_MISSING_TWO"]);
    assert_eq!(r.missing[0].used_in, vec!["src/a.js"]);
    assert_eq!(r.unused, vec!["DECLARED_UNUSED"]);
    assert!(r.has_example && r.declared == 2 && r.referenced == 3);
    let names = referenced_names("process.env.a_lower process.env.OK_1 process.env[\"Q_2\"] import.meta.env.MODE");
    assert_eq!(names.into_iter().collect::<Vec<_>>(), vec!["OK_1", "Q_2"]);
}

#[test]
fn the_matrix_puts_names_that_differ_between_repos_first() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    fs::write(a.path().join(".env.example"), "SHARED=\nONLY_A=\n").unwrap();
    fs::write(b.path().join(".env.example"), "SHARED=\n").unwrap();
    let report = analyze(&[("a".into(), a.path().to_path_buf()), ("b".into(), b.path().to_path_buf())]);
    assert_eq!(report.names[0].name, "ONLY_A");
    assert_eq!(report.names[0].repos.iter().map(|p| p.declared).collect::<Vec<_>>(), vec![true, false]);
    assert_eq!(report.names[1].name, "SHARED");
}

// ---- checks discovery and runner ----------------------------------------------------------------------------------

fn node_repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    fs::write(
        d.path().join("package.json"),
        r#"{"name":"fx","scripts":{"lint":"eslint .","lint:changed":"echo SCRIPT_BODY_MARKER","deploy":"ssh prod deploy","swagger:validate":"echo ok"},"devDependencies":{"jest":"^29"}}"#,
    )
    .unwrap();
    d
}

#[test]
fn discovery_offers_the_safe_checks_and_never_a_script_body() {
    let d = node_repo();
    let changed = vec!["src/a.js".to_owned(), "src/b.ts".to_owned(), "README.md".to_owned(), "../evil.js".to_owned(), "-rf.js".to_owned()];
    let found = discover("fx", d.path(), &changed);
    let ids: Vec<&str> = found.iter().map(|p| p.info.id.as_str()).collect();
    assert_eq!(ids, vec!["npm:lint:changed", "tests:related", "npm:swagger:validate", "node:check"]);
    assert!(!ids.iter().any(|i| i.contains("deploy")));
    let json = serde_json::to_string(&found.iter().map(|p| &p.info).collect::<Vec<_>>()).unwrap();
    assert!(!json.contains("SCRIPT_BODY_MARKER") && !json.contains("eslint"), "{json}");
    let tests = found.iter().find(|p| p.info.id == "tests:related").unwrap();
    assert_eq!(tests.info.file_count, 2);
    let argv = &tests.commands[0];
    assert!(argv.contains(&"./src/a.js".to_owned()) && argv.contains(&"./src/b.ts".to_owned()));
    assert!(!argv.iter().any(|a| a.contains("evil") || a.starts_with("-rf")));
    let node = found.iter().find(|p| p.info.id == "node:check").unwrap();
    assert_eq!(node.commands, vec![vec!["node".to_owned(), "--check".to_owned(), "./src/a.js".to_owned()]]);
}

#[test]
fn checks_without_matching_files_are_offered_but_disabled() {
    let d = node_repo();
    let found = discover("fx", d.path(), &["notes.md".to_owned()]);
    assert!(found.iter().find(|p| p.info.id == "tests:related").unwrap().info.disabled.is_some());
    assert!(found.iter().find(|p| p.info.id == "node:check").unwrap().info.disabled.is_some());
    assert!(found.iter().find(|p| p.info.id == "npm:lint:changed").unwrap().info.disabled.is_none());
}

#[derive(Default)]
struct Collect {
    states: Mutex<Vec<CheckRun>>,
    lines: Mutex<Vec<String>>,
}

impl CheckSink for Collect {
    fn state(&self, run: CheckRun) {
        self.states.lock().unwrap().push(run);
    }
    fn log(&self, chunk: LogChunk) {
        self.lines.lock().unwrap().extend(chunk.lines);
    }
}

fn sh(script: &str) -> Planned {
    Planned {
        info: CheckInfo { id: "t".into(), label: "T".into(), kind: "lint".into(), runner: "sh".into(), file_count: 0, disabled: None, note: None },
        commands: vec![vec!["sh".into(), "-c".into(), script.into()]],
    }
}

fn wait_done(sink: &Collect) -> CheckRun {
    let until = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(r) = sink.states.lock().unwrap().iter().rev().find(|r| r.status != CheckStatus::Running) {
            return r.clone();
        }
        assert!(Instant::now() < until, "check did not finish");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn output_streams_masked_and_a_failing_exit_code_is_reported() {
    let d = tempfile::tempdir().unwrap();
    let sink = Arc::new(Collect::default());
    let runner = CheckRunner::new(Arc::new(Jail::off()), sink.clone());
    let token = fake("ghp_", &"m".repeat(36));
    let planned = sh(&format!("echo hello; echo token={token}; echo oops >&2; exit 3"));
    runner.start("fx", d.path(), &planned, false, HashMap::new()).unwrap();
    let done = wait_done(&sink);
    assert_eq!((done.status, done.exit_code), (CheckStatus::Failed, Some(3)));
    let lines = sink.lines.lock().unwrap().join("\n");
    assert!(lines.contains("hello") && lines.contains("oops"), "{lines}");
    assert!(!lines.contains(&token), "token leaked into the log: {lines}");
    let stored = runner.logs("fx:t", 0).unwrap().lines.join("\n");
    assert!(!stored.contains(&token) && stored.contains("hello"));
}

#[test]
fn a_passing_check_and_a_stop_end_in_the_right_state() {
    let d = tempfile::tempdir().unwrap();
    let sink = Arc::new(Collect::default());
    let runner = CheckRunner::new(Arc::new(Jail::off()), sink.clone());
    runner.start("fx", d.path(), &sh("exit 0"), false, HashMap::new()).unwrap();
    assert_eq!(wait_done(&sink).status, CheckStatus::Passed);
    sink.states.lock().unwrap().clear();
    runner.start("fx", d.path(), &sh("sleep 30"), false, HashMap::new()).unwrap();
    assert_eq!(runner.start("fx", d.path(), &sh("sleep 30"), false, HashMap::new()).unwrap_err().code, "alreadyRunning");
    std::thread::sleep(Duration::from_millis(200));
    runner.stop("fx:t").unwrap();
    assert_eq!(wait_done(&sink).status, CheckStatus::Stopped);
}

#[test]
fn read_only_mode_needs_the_allow_processes_switch() {
    let d = tempfile::tempdir().unwrap();
    let sink = Arc::new(Collect::default());
    let runner = CheckRunner::new(Arc::new(Jail::read_only()), sink.clone());
    assert_eq!(runner.start("fx", d.path(), &sh("exit 0"), false, HashMap::new()).unwrap_err().code, "readOnly");
    runner.start("fx", d.path(), &sh("exit 0"), true, HashMap::new()).unwrap();
    assert_eq!(wait_done(&sink).status, CheckStatus::Passed);
    let outside = Jail::e2e(tempfile::tempdir().unwrap().path());
    let runner = CheckRunner::new(Arc::new(outside), sink);
    assert_eq!(runner.start("fx", d.path(), &sh("exit 0"), true, HashMap::new()).unwrap_err().code, "testJail");
}

// ---- branch hygiene -----------------------------------------------------------------------------------------------

#[test]
fn hygiene_lists_merged_and_unmerged_branches_and_tags() {
    let d = repo();
    branch_with_commit(d.path(), "feat/done", "done.txt");
    git(d.path(), &["merge", "-q", "--no-ff", "-m", "merge done", "feat/done"]);
    branch_with_commit(d.path(), "feat/wip", "wip.txt");
    git(d.path(), &["tag", "v1.0.0"]);
    git(d.path(), &["tag", "-a", "-m", "release one", "v1.1.0"]);
    let jail = Jail::off();
    let now = 4_000_000_000;
    let h = report(&jail, "fx", d.path(), &[], 60, now).unwrap();
    assert_eq!(h.default_branch.as_deref(), Some("main"));
    let by = |n: &str| h.branches.iter().find(|b| b.name == n).unwrap();
    assert!(by("main").current && by("main").protected && !by("main").deletable);
    assert!(by("feat/done").merged && by("feat/done").deletable);
    assert!(!by("feat/wip").merged && !by("feat/wip").deletable);
    assert_eq!((by("feat/wip").ahead, by("feat/wip").behind), (1, 0));
    assert!(by("feat/wip").stale && by("feat/wip").age_days > 60);
    assert!(!by("main").stale);
    assert_eq!(h.tags.iter().map(|t| (t.name.as_str(), t.annotated)).collect::<Vec<_>>().len(), 2);
    assert!(h.tags.iter().any(|t| t.name == "v1.1.0" && t.annotated && t.subject == "release one"));
}

#[test]
fn a_merged_branch_is_deleted_only_after_the_name_is_typed() {
    let d = repo();
    branch_with_commit(d.path(), "feat/done", "done.txt");
    git(d.path(), &["merge", "-q", "--no-ff", "-m", "merge done", "feat/done"]);
    let jail = Jail::off();
    assert_eq!(delete_branch(&jail, d.path(), "feat/done", &[], "yes").unwrap_err().code, "confirmRequired");
    assert!(git(d.path(), &["branch", "--list", "feat/done"]).contains("feat/done"));
    let note = delete_branch(&jail, d.path(), "feat/done", &[], "feat/done").unwrap();
    assert!(note.contains("Restore it with"));
    assert!(git(d.path(), &["branch", "--list", "feat/done"]).trim().is_empty());
}

#[test]
fn protected_current_unmerged_and_odd_names_are_refused() {
    let d = repo();
    branch_with_commit(d.path(), "feat/wip", "wip.txt");
    branch_with_commit(d.path(), "release/1.0", "r.txt");
    git(d.path(), &["merge", "-q", "--no-ff", "-m", "m", "release/1.0"]);
    branch_with_commit(d.path(), "live-hotfix", "h.txt");
    git(d.path(), &["merge", "-q", "--no-ff", "-m", "m2", "live-hotfix"]);
    git(d.path(), &["checkout", "-q", "-b", "other"]);
    let jail = Jail::off();
    let code = |n: &str, p: &[String]| delete_branch(&jail, d.path(), n, p, n).unwrap_err().code;
    assert_eq!(code("main", &[]), "protectedBranch");
    assert_eq!(code("release/1.0", &[]), "protectedBranch");
    assert_eq!(code("live-hotfix", &["live-*".to_owned()]), "protectedBranch");
    assert_eq!(code("other", &[]), "currentBranch");
    assert_eq!(code("feat/wip", &[]), "notMerged");
    assert_eq!(code("--force", &[]), "invalidName");
    assert_eq!(code("no/such", &[]), "repoMissing");
    for b in ["main", "release/1.0", "live-hotfix", "feat/wip"] {
        assert!(!git(d.path(), &["branch", "--list", b]).trim().is_empty(), "{b} must survive");
    }
}

#[test]
fn deleting_respects_the_jail() {
    let d = repo();
    branch_with_commit(d.path(), "feat/done", "done.txt");
    git(d.path(), &["merge", "-q", "--no-ff", "-m", "merge done", "feat/done"]);
    assert_eq!(delete_branch(&Jail::read_only(), d.path(), "feat/done", &[], "feat/done").unwrap_err().code, "readOnly");
    let elsewhere = tempfile::tempdir().unwrap();
    assert_eq!(delete_branch(&Jail::e2e(elsewhere.path()), d.path(), "feat/done", &[], "feat/done").unwrap_err().code, "testJail");
    assert!(git(d.path(), &["branch", "--list", "feat/done"]).contains("feat/done"));
    // Inside the fixture root the jail lets it through.
    delete_branch(&Jail::e2e(d.path()), d.path(), "feat/done", &[], "feat/done").unwrap();
}

// ---- worktrees ----------------------------------------------------------------------------------------------------

fn store() -> (tempfile::TempDir, WorktreeStore) {
    let data = tempfile::tempdir().unwrap();
    let s = WorktreeStore::new(data.path());
    (data, s)
}

fn req(name: &str, confirm: &str) -> CreateRequest {
    CreateRequest { name: name.into(), confirm: confirm.into(), ..Default::default() }
}

#[test]
fn an_ide_worktree_is_created_listed_as_owned_and_removed_with_the_typed_name() {
    let d = repo();
    let (_data, s) = store();
    let jail = Jail::off();
    assert_eq!(s.create(&jail, "fx", d.path(), &req("run-1", "nope")).unwrap_err().code, "confirmRequired");
    assert_eq!(s.create(&jail, "fx", d.path(), &req("../x", "../x")).unwrap_err().code, "invalidName");
    let made = s.create(&jail, "fx", d.path(), &req("run-1", "run-1")).unwrap();
    assert!(made.owned && !made.main && made.branch.as_deref() == Some("intely/run-1"));
    assert!(fs::canonicalize(&made.path).unwrap().starts_with(fs::canonicalize(s.root()).unwrap()));
    let rows = s.list(&jail, "fx", d.path()).unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows[0].main && !rows[0].owned && rows[0].external.is_none());
    assert_eq!(s.remove(&jail, "fx", d.path(), &made.path, "wrong").unwrap_err().code, "confirmRequired");
    assert!(Path::new(&made.path).exists());
    let note = s.remove(&jail, "fx", d.path(), &made.path, "run-1").unwrap();
    assert!(note.contains("intely/run-1"));
    assert!(!Path::new(&made.path).exists());
    assert_eq!(s.list(&jail, "fx", d.path()).unwrap().len(), 1);
    assert!(git(d.path(), &["branch", "--list", "intely/run-1"]).contains("intely/run-1"), "the branch is kept");
}

#[test]
fn a_foreign_worktree_is_listed_but_never_removed() {
    let d = repo();
    let (data, s) = store();
    let jail = Jail::off();
    let cursor_dir: PathBuf = data.path().join("home/.cursor/worktrees/fx/abc");
    fs::create_dir_all(cursor_dir.parent().unwrap()).unwrap();
    git(d.path(), &["worktree", "add", "-q", "-b", "cursor-branch", cursor_dir.to_str().unwrap()]);
    let rows = s.list(&jail, "fx", d.path()).unwrap();
    let foreign = rows.iter().find(|w| !w.main).unwrap();
    assert!(!foreign.owned);
    assert_eq!(foreign.external.as_deref(), Some("cursor"));
    let err = s.remove(&jail, "fx", d.path(), &foreign.path, &foreign.name).unwrap_err();
    assert_eq!(err.code, "notOwned");
    assert!(cursor_dir.exists());
    // An owned record for another repo id does not authorise it either.
    s.create(&jail, "other", d.path(), &req("mine", "mine")).unwrap();
    assert_eq!(s.remove(&jail, "fx", d.path(), &foreign.path, &foreign.name).unwrap_err().code, "notOwned");
}

#[test]
fn worktrees_respect_the_jail() {
    let d = repo();
    let (_data, s) = store();
    assert_eq!(s.create(&Jail::read_only(), "fx", d.path(), &req("a", "a")).unwrap_err().code, "readOnly");
    let elsewhere = tempfile::tempdir().unwrap();
    assert_eq!(s.create(&Jail::e2e(elsewhere.path()), "fx", d.path(), &req("a", "a")).unwrap_err().code, "testJail");
    assert_eq!(s.list(&Jail::off(), "fx", d.path()).unwrap().len(), 1, "nothing was created");
    // Listing is allowed even in read-only mode.
    assert_eq!(s.list(&Jail::read_only(), "fx", d.path()).unwrap().len(), 1);
    let made = s.create(&Jail::off(), "fx", d.path(), &req("b", "b")).unwrap();
    assert_eq!(s.remove(&Jail::read_only(), "fx", d.path(), &made.path, "b").unwrap_err().code, "readOnly");
    assert!(Path::new(&made.path).exists());
}

#[test]
fn scan_paths_covers_tracked_edits_untracked_files_and_refuses_env_files() {
    let d = repo();
    let token = fake("ghp_", &"d".repeat(36));
    let canary = fake("AKIA", "ZYXWVUTSRQPONMLK");
    fs::write(d.path().join("a.txt"), format!("one\nconfig token {token}\n")).unwrap();
    fs::write(d.path().join("new.js"), format!("// {canary}\n")).unwrap();
    fs::write(d.path().join(".env"), format!("T={token}\n")).unwrap();
    fs::write(d.path().join("clean.js"), "let a = 1;\n").unwrap();
    let paths: Vec<String> = ["a.txt", "new.js", ".env", "clean.js", "../escape"].iter().map(|s| s.to_string()).collect();
    let scan = scan_paths(&Jail::off(), "fx", d.path(), &paths).unwrap();
    let kinds: Vec<(&str, u32, &str)> = scan.findings.iter().map(|f| (f.path.as_str(), f.line, f.kind.as_str())).collect();
    assert_eq!(kinds, vec![("a.txt", 2, "GitHub token"), ("new.js", 1, "AWS access key id")]);
    assert_eq!(scan.skipped, vec![".env", "../escape"]);
    let json = serde_json::to_string(&scan).unwrap();
    assert!(!json.contains(&token) && !json.contains(&canary), "{json}");
    // Unticked files are not judged.
    assert!(scan_paths(&Jail::off(), "fx", d.path(), &["clean.js".to_owned()]).unwrap().findings.is_empty());
}

#[test]
fn env_missing_list_is_capped_but_total_is_reported() {
    let d = tempfile::tempdir().unwrap();
    let body: String = (0..250).map(|i| format!("process.env.VAR_{i:03};\n")).collect();
    fs::write(d.path().join("a.js"), body).unwrap();
    let r = analyze_repo("r", d.path());
    assert_eq!(r.missing.len(), 200);
    assert_eq!(r.missing_total, 250);
}
