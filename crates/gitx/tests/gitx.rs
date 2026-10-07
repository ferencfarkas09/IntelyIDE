//! GitX tests: fixture repos under a temp dir, a fake `gh` script first on the PATH, no network and no real gh.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use intely_core::exec::pinned_git_path;
use intely_core::jail::Jail;
use intely_gitx::doctor::{self, find_orphans, helper_name, DoctorOpts};
use intely_gitx::gh::{self, redact, Gh};
use intely_gitx::pr::{self, RepoRef};
use intely_gitx::types::{CreateRequest, Level};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new(pinned_git_path())
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

fn commit(dir: &Path, file: &str, message: &str) {
    fs::write(dir.join(file), format!("{message}\n")).unwrap();
    git(dir, &["add", file]);
    git(dir, &["commit", "-q", "-m", message]);
}

const FAKE_GH: &str = r#"#!/bin/bash
d="$(cd "$(dirname "$0")" && pwd)"
n=$(ls "$d"/call.* 2>/dev/null | wc -l | tr -d ' ')
printf '%s\0' "$@" > "$d/call.$n"
case "$1 $2" in
  "--version "*) echo "gh version 2.80.0 (fake)";;
  "auth status") [ -f "$d/noauth" ] && { echo "You are not logged in to any GitHub hosts. To log in, run: gh auth login" >&2; exit 1; }; echo "Logged in as fixture (token: gho_ABCDEFGHIJKLMNOPQRSTUV)"; exit 0;;
  "pr list")
    case "$*" in
      *--head*) echo '[{"number":7,"title":"feat: invoices","state":"OPEN","isDraft":true,"headRefName":"feature/invoices","baseRefName":"main","author":{"login":"fixture"},"url":"https://github.com/acme/repo/pull/7","reviewDecision":"REVIEW_REQUIRED","statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS","name":"lint"},{"__typename":"CheckRun","status":"IN_PROGRESS","conclusion":"","name":"test"}],"updatedAt":"2026-10-03T10:00:00Z"}]';;
      *) echo '[{"number":7,"title":"feat: invoices","state":"OPEN","isDraft":true,"headRefName":"feature/invoices","baseRefName":"main","author":{"login":"fixture"},"url":"https://github.com/acme/repo/pull/7","reviewDecision":"APPROVED","statusCheckRollup":[{"__typename":"StatusContext","state":"FAILURE","context":"ci"}],"updatedAt":"2026-10-03T10:00:00Z"},{"number":5,"title":"fix: fee","state":"OPEN","isDraft":false,"headRefName":"fix/fee","baseRefName":"main","author":{"login":"fixture"},"url":"https://github.com/acme/repo/pull/5","reviewDecision":"","statusCheckRollup":[],"updatedAt":"2026-10-02T10:00:00Z"}]';;
    esac;;
  "pr view") echo '{"number":7,"title":"feat: invoices","body":"Adds invoices.\n\n<script>x</script>","state":"OPEN","isDraft":true,"headRefName":"feature/invoices","baseRefName":"main","author":{"login":"fixture"},"url":"https://github.com/acme/repo/pull/7","reviewDecision":"APPROVED","latestReviews":[{"author":{"login":"anna"},"state":"APPROVED"}],"statusCheckRollup":[],"updatedAt":"2026-10-03T10:00:00Z"}';;
  "pr checks") echo '[{"name":"lint","workflow":"CI","state":"SUCCESS","bucket":"pass","link":"https://github.com/acme/repo/actions/runs/1"},{"name":"test","workflow":"CI","state":"PENDING","bucket":"pending","link":""}]'; exit 8;;
  "pr create") echo "Creating draft pull request"; echo "https://github.com/acme/repo/pull/9";;
  *) echo "unexpected: $*" >&2; exit 2;;
esac
"#;

struct Fx {
    root: tempfile::TempDir,
    work: PathBuf,
    bin: PathBuf,
}

impl Fx {
    /// `work` with a bare origin, `main` pushed, `feature/invoices` pushed with -u and two conventional commits.
    fn new() -> Fx {
        let root = tempfile::tempdir().unwrap();
        let (origin, work, bin) = (root.path().join("origin.git"), root.path().join("work"), root.path().join("bin"));
        fs::create_dir_all(&work).unwrap();
        fs::create_dir_all(&bin).unwrap();
        git(root.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
        git(&work, &["init", "-q", "-b", "main"]);
        git(&work, &["remote", "add", "origin", origin.to_str().unwrap()]);
        commit(&work, "a.txt", "chore: first");
        git(&work, &["push", "-q", "-u", "origin", "main"]);
        git(&work, &["remote", "set-head", "origin", "main"]);
        git(&work, &["checkout", "-q", "-b", "feature/invoices"]);
        commit(&work, "b.txt", "feat(billing): add invoice model");
        commit(&work, "c.txt", "feat(billing): render invoice pdf");
        git(&work, &["push", "-q", "-u", "origin", "feature/invoices"]);
        let gh = bin.join("gh");
        fs::write(&gh, FAKE_GH).unwrap();
        fs::set_permissions(&gh, fs::Permissions::from_mode(0o755)).unwrap();
        Fx { root, work, bin }
    }
    fn jail(&self) -> Arc<Jail> {
        Arc::new(Jail::e2e(self.root.path()))
    }
    fn path(&self) -> String {
        format!("{}:/usr/bin:/bin", self.bin.display())
    }
    fn calls(&self) -> Vec<Vec<String>> {
        let mut files: Vec<_> = fs::read_dir(&self.bin).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("call.")).collect();
        files.sort_by_key(|e| e.file_name().to_string_lossy().trim_start_matches("call.").parse::<u32>().unwrap_or(0));
        files.iter().map(|e| fs::read(e.path()).unwrap().split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect()).collect()
    }
    fn repo<'a>(&'a self, live: &'a [String]) -> RepoRef<'a> {
        RepoRef { path: &self.work, name: "work", live_patterns: live }
    }
}

fn request(base: &str, repo: &str, head: &str) -> CreateRequest {
    CreateRequest { title: "feat(billing): invoices".into(), body: "Extended English: Adds invoices.".into(), base: base.into(), draft: true, confirm_repo: repo.into(), confirm_head: head.into() }
}

#[test]
fn reads_summarise_ci_and_review_state() {
    let fx = Fx::new();
    let gh = Gh::locate(fx.jail(), &fx.path()).unwrap();
    let live = vec![];
    let l = pr::list(&gh, &fx.jail(), fx.repo(&live).path).unwrap();
    assert_eq!(l.branch.as_deref(), Some("feature/invoices"));
    assert_eq!(l.current.len(), 1);
    assert_eq!((l.current[0].ci.as_str(), l.current[0].review.as_str(), l.current[0].checks_passed, l.current[0].checks_pending), ("pending", "reviewRequired", 1, 1));
    assert_eq!(l.mine.len(), 2);
    assert_eq!((l.mine[0].ci.as_str(), l.mine[0].review.as_str()), ("failing", "approved"));
    assert_eq!((l.mine[1].ci.as_str(), l.mine[1].review.as_str(), l.mine[1].is_draft), ("none", "none", false));
    let d = pr::view(&gh, &fx.work, 7).unwrap();
    assert!(d.body.contains("<script>"), "the body is returned as plain text, the UI never renders it as HTML");
    assert_eq!(d.reviews[0].author, "anna");
    assert_eq!(d.checks.iter().map(|c| c.bucket.as_str()).collect::<Vec<_>>(), ["pass", "pending"]);
    assert_eq!(d.checks[1].link, None);
    // read-only: only list, view and checks were asked
    assert!(fx.calls().iter().all(|c| matches!((c[0].as_str(), c[1].as_str()), ("pr", "list" | "view" | "checks"))));
}

#[test]
fn the_plan_drafts_title_body_and_shows_the_exact_command() {
    let fx = Fx::new();
    let live = vec!["main".to_owned(), "release/*".to_owned()];
    let p = pr::plan(&fx.jail(), &fx.repo(&live), None, true);
    assert_eq!(p.refusal, None);
    assert_eq!((p.head.as_deref(), p.base.as_deref(), p.upstream.as_deref(), p.unpushed), (Some("feature/invoices"), Some("main"), Some("origin/feature/invoices"), 0));
    assert_eq!(p.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["feat(billing): add invoice model", "feat(billing): render invoice pdf"]);
    assert_eq!(p.title, "feat(billing): invoices");
    assert!(p.body.starts_with("Extended English: This pull request brings 2 commits from `feature/invoices` into `main`."));
    assert!(p.body.contains("- feat(billing): add invoice model ("));
    assert!(!p.body.to_lowercase().contains("co-authored") && !p.body.contains("Generated"));
    assert!(p.command.starts_with("gh pr create --draft --base=main --head=feature/invoices --title="), "{}", p.command);
    assert!(p.bases.contains(&"main".to_owned()));
}

#[test]
fn create_needs_the_typed_repo_and_head_and_is_a_draft() {
    let fx = Fx::new();
    let live = vec!["main".to_owned()];
    let r = fx.repo(&live);
    for (repo, head) in [("", ""), ("work", ""), ("", "feature/invoices"), ("Work", "feature/invoices"), ("work", "feature/invoice"), ("work ", "feature/invoices")] {
        let e = pr::create(fx.jail(), &fx.path(), &r, &request("main", repo, head)).unwrap_err();
        assert_eq!(e.code, "confirmRequired", "{repo:?} {head:?}");
    }
    assert!(fx.calls().is_empty(), "nothing ran without the exact confirmation");
    let done = pr::create(fx.jail(), &fx.path(), &r, &request("main", "work", "feature/invoices")).unwrap();
    assert_eq!(done.url, "https://github.com/acme/repo/pull/9");
    let calls = fx.calls();
    assert_eq!(calls.len(), 2, "auth status, then the one create");
    assert_eq!(calls[0], ["auth", "status"]);
    assert_eq!(calls[1], ["pr", "create", "--draft", "--base=main", "--head=feature/invoices", "--title=feat(billing): invoices", "--body=Extended English: Adds invoices."]);
    // what ran is what was shown
    let shown = pr::preview(&fx.jail(), &r, &request("main", "", "")).unwrap();
    assert_eq!(shown, done.command);
    let forbidden = ["merge", "edit", "close", "review", "comment", "ready", "--web", "--fill", "push"];
    assert!(calls.iter().flatten().all(|a| !forbidden.contains(&a.as_str())));
}

#[test]
fn a_ready_pr_only_when_asked() {
    let fx = Fx::new();
    let live = vec![];
    let mut req = request("main", "work", "feature/invoices");
    req.draft = false;
    pr::create(fx.jail(), &fx.path(), &fx.repo(&live), &req).unwrap();
    assert!(!fx.calls()[1].contains(&"--draft".to_owned()));
}

#[test]
fn a_branch_without_an_upstream_is_refused_and_never_pushed() {
    let fx = Fx::new();
    git(&fx.work, &["checkout", "-q", "-b", "wip/local"]);
    commit(&fx.work, "d.txt", "feat: local only");
    let live = vec!["main".to_owned()];
    let p = pr::plan(&fx.jail(), &fx.repo(&live), None, true);
    let r = p.refusal.expect("refused");
    assert_eq!(r.code, "noUpstream");
    assert!(r.message.contains("Push dialog"));
    let e = pr::create(fx.jail(), &fx.path(), &fx.repo(&live), &request("main", "work", "wip/local")).unwrap_err();
    assert_eq!(e.code, "noUpstream");
    assert!(fx.calls().is_empty());
    let remote = git(&fx.work, &["ls-remote", "--heads", "origin"]);
    assert!(!remote.contains("wip/local"), "the bridge never pushes");
}

#[test]
fn a_live_branch_is_never_the_head() {
    let fx = Fx::new();
    git(&fx.work, &["checkout", "-q", "main"]);
    commit(&fx.work, "e.txt", "feat: straight on main");
    for live in [vec!["main".to_owned()], vec![], vec!["release/*".to_owned()]] {
        // the remote HEAD branch counts as live even without a pattern
        let p = pr::plan(&fx.jail(), &fx.repo(&live), Some("feature/invoices"), true);
        assert_eq!(p.refusal.as_ref().map(|r| r.code.as_str()), Some("liveHead"), "{live:?}");
        let e = pr::create(fx.jail(), &fx.path(), &fx.repo(&live), &request("feature/invoices", "work", "main")).unwrap_err();
        assert_eq!(e.code, "liveHead");
    }
    assert!(fx.calls().is_empty());
    // a live branch as the base is fine
    git(&fx.work, &["checkout", "-q", "feature/invoices"]);
    assert_eq!(pr::plan(&fx.jail(), &fx.repo(&["main".to_owned()]), Some("main"), true).refusal, None);
}

#[test]
fn other_refusals_have_their_own_codes() {
    let fx = Fx::new();
    let live = vec![];
    assert_eq!(pr::plan(&fx.jail(), &fx.repo(&live), Some("nope"), true).refusal.unwrap().code, "unknownBase");
    assert_eq!(pr::plan(&fx.jail(), &fx.repo(&live), Some("feature/invoices"), true).refusal.unwrap().code, "sameBranch");
    git(&fx.work, &["checkout", "-q", "--detach"]);
    assert_eq!(pr::plan(&fx.jail(), &fx.repo(&live), None, true).refusal.unwrap().code, "detachedHead");
    git(&fx.work, &["checkout", "-q", "-b", "same/as-main", "main"]);
    git(&fx.work, &["push", "-q", "-u", "origin", "same/as-main"]);
    assert_eq!(pr::plan(&fx.jail(), &fx.repo(&live), None, true).refusal.unwrap().code, "nothingAhead");
    git(&fx.work, &["branch", "-q", "--set-upstream-to=origin/main"]);
    assert_eq!(pr::plan(&fx.jail(), &fx.repo(&live), None, true).refusal.unwrap().code, "upstreamMismatch");
}

#[test]
fn unpushed_commits_are_counted_not_pushed() {
    let fx = Fx::new();
    commit(&fx.work, "f.txt", "feat: not pushed yet");
    let p = pr::plan(&fx.jail(), &fx.repo(&[]), None, true);
    assert_eq!((p.unpushed, p.commits.len(), p.refusal), (1, 3, None));
}

#[test]
fn read_only_mode_refuses_create_and_every_gh_call() {
    let fx = Fx::new();
    let ro = Arc::new(Jail::read_only());
    let live = vec![];
    assert_eq!(pr::create(Arc::clone(&ro), &fx.path(), &fx.repo(&live), &request("main", "work", "feature/invoices")).unwrap_err().code, "readOnly");
    let gh = Gh::locate(Arc::clone(&ro), &fx.path()).unwrap();
    assert_eq!(pr::list(&gh, &ro, &fx.work).unwrap_err().code, "readOnly");
    assert_eq!(pr::view(&gh, &fx.work, 7).unwrap_err().code, "readOnly");
    let st = gh::status(ro, &fx.path(), &fx.work);
    assert_eq!((st.installed, st.blocked.as_deref(), st.authenticated), (true, Some("readOnly"), None));
    assert_eq!(pr::plan(&Jail::read_only(), &fx.repo(&live), None, true).refusal.unwrap().code, "readOnly");
    assert!(fx.calls().iter().all(|c| c[0] == "--version"), "only the local version probe ran");
}

#[test]
fn the_test_jail_runs_a_fake_under_the_fixture_only_and_only_for_fixture_repos() {
    let fx = Fx::new();
    // a "real" gh outside the fixture root is refused
    let outside = tempfile::tempdir().unwrap();
    let real = outside.path().join("gh");
    fs::write(&real, "#!/bin/sh\necho real\n").unwrap();
    fs::set_permissions(&real, fs::Permissions::from_mode(0o755)).unwrap();
    let e = Gh::locate(fx.jail(), &format!("{}:/usr/bin", outside.path().display())).err().unwrap();
    assert_eq!(e.code, "testJail");
    // a repo outside the fixture root is refused even with the fake
    let stray = tempfile::tempdir().unwrap();
    git(stray.path(), &["init", "-q", "-b", "main"]);
    let gh = Gh::locate(fx.jail(), &fx.path()).unwrap();
    assert_eq!(pr::view(&gh, stray.path(), 1).unwrap_err().code, "testJail");
}

#[test]
fn a_missing_or_signed_out_gh_is_reported() {
    let fx = Fx::new();
    let none = tempfile::tempdir().unwrap();
    assert_eq!(Gh::locate(fx.jail(), &none.path().display().to_string()).err().unwrap().code, "ghMissing");
    assert!(!gh::status(fx.jail(), &none.path().display().to_string(), &fx.work).installed);
    fs::write(fx.bin.join("noauth"), "").unwrap();
    let live = vec![];
    let e = pr::create(fx.jail(), &fx.path(), &fx.repo(&live), &request("main", "work", "feature/invoices")).unwrap_err();
    assert_eq!(e.code, "ghAuth");
    assert!(fx.calls().iter().all(|c| c[1] != "create"));
    let st = gh::status(fx.jail(), &fx.path(), &fx.work);
    assert_eq!((st.authenticated, st.version.as_deref()), (Some(false), Some("2.80.0")));
}

#[test]
fn tokens_never_come_back() {
    assert_eq!(redact("a ghp_ABCDEF0123456789abcdef and github_pat_11AAA_bbb end"), "a [token] and [token] end");
    assert_eq!(redact("no token here, ünïcode ok"), "no token here, ünïcode ok");
    let fx = Fx::new();
    let gh = Gh::locate(fx.jail(), &fx.path()).unwrap();
    let o = gh.run(&fx.work, &["auth".into(), "status".into()], Duration::from_secs(60)).unwrap();
    assert!(o.stdout.contains("[token]") && !o.stdout.contains("gho_ABCDEF"));
}

#[test]
fn drafts_follow_the_commit_style() {
    let c = |s: &str, b: &str| ("0123456789abcdef".to_owned(), s.to_owned(), b.to_owned());
    let (t, b) = pr::draft("fix/fee-rounding", "main", &[c("fix: round the delivery fee", "Rounds half up.\n\nMore.")]);
    assert_eq!(t, "fix: round the delivery fee");
    assert!(b.starts_with("Extended English: This pull request brings 1 commit from `fix/fee-rounding` into `main`. Rounds half up."));
    let (t, _) = pr::draft("feature/invoice-pdf", "main", &[c("chore: tidy", ""), c("feat(api): add endpoint", ""), c("feat(ui): add button", "")]);
    assert_eq!(t, "feat: invoice pdf");
    let (t, _) = pr::draft("main2", "main", &[c("docs: a", ""), c("fix: b", "")]);
    assert_eq!(t, "fix: main2");
    let (t, _) = pr::draft("x", "main", &[c("update things", ""), c("more things", "")]);
    assert!(t.starts_with("chore: "));
    assert!(pr::command_line(&pr::create_parts("main", "h", "it's", "a\nb", true)).contains("--title='it'\\''s' --body='a\nb'"));
}

// ---- doctor -----------------------------------------------------------------------------------------------------------

fn fake_tool(dir: &Path, name: &str, version_line: &str) {
    let p = dir.join(name);
    fs::write(&p, format!("#!/bin/sh\necho '{version_line}'\n")).unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
}

fn old(path: &Path, minutes: u64) {
    let f = fs::OpenOptions::new().write(true).open(path).or_else(|_| fs::File::open(path)).unwrap();
    f.set_modified(SystemTime::now() - Duration::from_secs(minutes * 60)).unwrap();
}

fn doctor_opts(fx: &Fx, extra: impl FnOnce(&mut DoctorOpts)) -> DoctorOpts {
    fake_tool(&fx.bin, "node", "v24.1.0");
    fake_tool(&fx.bin, "claude", "2.1.0 (Claude Code)");
    // only git is linked in, so a codex or gh installed on this machine is never found
    let only_git = fx.root.path().join("only-git");
    fs::create_dir_all(&only_git).unwrap();
    let _ = std::os::unix::fs::symlink(pinned_git_path(), only_git.join("git"));
    let login = format!("{}:{}:/usr/bin:/bin", fx.bin.display(), only_git.display());
    let global = fx.root.path().join("gitconfig");
    fs::write(&global, "[credential]\n\thelper = osxkeychain\n\thelper = !f() { echo password=SECRETVALUE; }; f\n").unwrap();
    let mut o = DoctorOpts::new(login, "/usr/bin:/bin".into(), "ready".into(), vec![("work".into(), fx.work.clone())], fx.root.path().join("state"));
    o.env = vec![("GIT_CONFIG_GLOBAL".into(), global.to_string_lossy().into_owned()), ("GIT_CONFIG_SYSTEM".into(), "/dev/null".into())];
    o.temp_dir = fx.root.path().join("tmp");
    fs::create_dir_all(&o.temp_dir).unwrap();
    extra(&mut o);
    o
}

fn find<'a>(r: &'a [intely_gitx::types::DoctorCheck], code: &str) -> Option<&'a intely_gitx::types::DoctorCheck> {
    r.iter().find(|c| c.code == code)
}

#[test]
fn doctor_reports_tools_credentials_and_path_without_values() {
    let fx = Fx::new();
    let report = doctor::run(&doctor_opts(&fx, |_| {}));
    let node = report.iter().find(|c| c.code == "tool.ok" && c.params["tool"] == "node").unwrap();
    assert_eq!((node.level, node.params["version"].as_str()), (Level::Ok, "24.1.0"));
    assert!(node.items[0].name.ends_with("/bin/node"));
    let claude = report.iter().find(|c| c.params.get("tool").is_some_and(|t| t == "claude")).unwrap();
    assert_eq!(claude.params["version"], "2.1.0");
    assert_eq!(find(&report, "tool.ok").map(|_| ()), Some(()));
    let codex = report.iter().find(|c| c.code == "tool.missing" && c.params["tool"] == "codex").unwrap();
    assert_eq!(codex.level, Level::Info);
    assert!(report.iter().any(|c| c.code == "tool.ok" && c.params["tool"] == "git"));
    let cred = find(&report, "cred.ok").expect("credential helpers");
    assert_eq!(cred.items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["custom", "osxkeychain"]);
    let json = serde_json::to_string(&report).unwrap();
    assert!(!json.contains("SECRETVALUE") && !json.contains("password"), "credential values never enter the report");
    // the GUI PATH lacks the tool dirs: informational, with the safe fix
    let gui = find(&report, "path.guiMinimal").unwrap();
    assert_eq!((gui.level, gui.fix.as_deref()), (Level::Info, Some("refreshEnv")));
    assert!(gui.items.iter().any(|i| i.name == fx.bin.to_string_lossy()));
}

#[test]
fn doctor_flags_a_plaintext_store_a_missing_helper_and_a_failed_login_env() {
    let fx = Fx::new();
    let global = fx.root.path().join("gitconfig2");
    fs::write(&global, "[credential]\n\thelper = store --file=/home/u/.git-credentials\n").unwrap();
    let report = doctor::run(&doctor_opts(&fx, |o| {
        o.env[0].1 = global.to_string_lossy().into_owned();
        o.env_state = "failed".into();
    }));
    let c = find(&report, "cred.plaintext").unwrap();
    assert_eq!((c.level, c.items[0].name.as_str()), (Level::Warn, "store"));
    assert!(!serde_json::to_string(&report).unwrap().contains(".git-credentials"));
    assert_eq!(find(&report, "path.loginFailed").unwrap().fix.as_deref(), Some("refreshEnv"));
    let none = doctor::run(&doctor_opts(&fx, |o| o.env[0].1 = "/dev/null".into()));
    assert_eq!(find(&none, "cred.none").unwrap().level, Level::Warn);
}

#[test]
fn doctor_finds_stale_locks_hooks_and_large_untracked_directories_and_deletes_nothing() {
    let fx = Fx::new();
    let gd = fx.work.join(".git");
    fs::write(gd.join("index.lock"), "").unwrap();
    old(&gd.join("index.lock"), 180);
    fs::write(gd.join("HEAD.lock"), "").unwrap();
    let hooks = gd.join("hooks");
    fs::create_dir_all(&hooks).unwrap();
    fs::write(hooks.join("pre-commit"), "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(hooks.join("pre-commit"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(hooks.join("commit-msg"), "x").unwrap();
    fs::write(hooks.join("pre-push.sample"), "x").unwrap();
    let big = fx.work.join("scratch-data");
    fs::create_dir_all(&big).unwrap();
    for i in 0..520 {
        fs::write(big.join(format!("f{i}.txt")), "x").unwrap();
    }
    let report = doctor::run(&doctor_opts(&fx, |_| {}));
    let stale = find(&report, "lock.stale").unwrap();
    assert_eq!((stale.items[0].name.as_str(), stale.items.len(), stale.repo_id.as_deref()), ("index.lock", 1, Some("work")));
    assert!(stale.items[0].age_minutes.unwrap() >= 179);
    assert_eq!(find(&report, "lock.fresh").unwrap().items[0].name, "HEAD.lock");
    let h = find(&report, "hooks.found").unwrap();
    assert_eq!(h.items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["commit-msg", "pre-commit"]);
    assert_eq!(find(&report, "hooks.notExecutable").unwrap().items[0].name, "commit-msg");
    let u = find(&report, "untracked.large").unwrap();
    assert_eq!((u.items[0].name.as_str(), u.items[0].count), ("scratch-data/", Some(520)));
    assert!(gd.join("index.lock").exists() && big.join("f0.txt").exists(), "report only: nothing is deleted");
}

#[test]
fn doctor_reports_core_hooks_path_by_name_only() {
    let fx = Fx::new();
    let dir = fx.work.join(".githooks");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("pre-commit"), "#!/bin/sh\n").unwrap();
    fs::set_permissions(dir.join("pre-commit"), fs::Permissions::from_mode(0o755)).unwrap();
    git(&fx.work, &["config", "core.hooksPath", ".githooks"]);
    let report = doctor::run(&doctor_opts(&fx, |_| {}));
    let h = find(&report, "hooks.foundAt").unwrap();
    assert_eq!((h.params["hooksPath"].as_str(), h.items[0].name.as_str()), (".githooks", "pre-commit"));
}

#[test]
fn doctor_warns_on_low_disk_and_lists_old_ide_temp_directories() {
    let fx = Fx::new();
    let report = doctor::run(&doctor_opts(&fx, |o| o.warn_free_bytes = u64::MAX));
    let d = find(&report, "disk.low").unwrap();
    assert_eq!(d.level, Level::Warn);
    assert!(d.items.iter().any(|i| i.name == "work") && d.items.iter().any(|i| i.name == "IDE state"));
    assert_eq!(find(&doctor::run(&doctor_opts(&fx, |_| {})), "disk.ok").unwrap().level, Level::Ok);
    let critical = doctor::run(&doctor_opts(&fx, |o| (o.warn_free_bytes, o.error_free_bytes) = (u64::MAX, u64::MAX)));
    assert_eq!(find(&critical, "disk.critical").unwrap().level, Level::Error);
    assert!(doctor::free_bytes(fx.root.path()).unwrap() > 0);

    let tmp = fx.root.path().join("tmp");
    let (stale, recent, other) = (tmp.join("intely-run-old"), tmp.join("intely-run-new"), tmp.join("something-else"));
    for d in [&stale, &recent, &other] {
        fs::create_dir_all(d).unwrap();
        fs::write(d.join("f"), "12345").unwrap();
    }
    old(&stale, 3 * 24 * 60);
    old(&other, 3 * 24 * 60);
    let report = doctor::run(&doctor_opts(&fx, |_| {}));
    let t = find(&report, "temp.old").unwrap();
    assert_eq!((t.items.len(), t.items[0].name.as_str(), t.items[0].bytes, t.params["count"].as_str()), (1, "intely-run-old", Some(5), "1"));
    assert!(stale.exists(), "report only");
}

#[test]
fn orphans_are_idle_ide_children_under_launchd_only() {
    let ps = "\
  101     1  02:10:03 /usr/local/bin/node /Users/x/IDE/sidecar/dist/index.js --stdio
  102   101     05:00 /Users/x/.local/bin/claude -p --output-format stream-json /Users/x/IDE/sidecar/dist/index.js
  103     1  1-02:00:00 /usr/bin/git -C /tmp/intely-run-git-501/x status
  104     1     10:00 /usr/local/bin/node /Users/x/live/backend.mjs
  105     1     00:30 /usr/bin/git status
  garbage line
";
    let found = find_orphans(ps, &["sidecar/dist/index.js".into(), "intely-run-git-".into()]);
    assert_eq!(found.iter().map(|o| (o.pid, o.age_minutes, o.name.as_str())).collect::<Vec<_>>(), [(101, 130, "node index.js"), (103, 26 * 60, "git")]);
    assert!(find_orphans(ps, &[]).is_empty());
    let r = helper_name;
    assert_eq!((r("osxkeychain").as_str(), r("/usr/bin/git-credential-osxkeychain").as_str(), r("!f() { echo password=x; }; f").as_str(), r("!/opt/homebrew/bin/gh auth git-credential").as_str(), r("store --file=/x").as_str()), ("osxkeychain", "osxkeychain", "custom", "gh", "store"));
}
