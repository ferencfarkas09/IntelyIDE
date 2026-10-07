//! Fixture builder for the git integration tests (contract section 9): throwaway repos and bare remotes under one
//! temp dir, isolated from the user's git config, identity "Fixture User". Every repo path is asserted to be under
//! the temp prefix before a command runs, so the real repos can never be touched.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};

use intely_core::env::{EnvOptions, EnvResolver};
use intely_core::exec::{pinned_git_path, CancelToken, GitCtx, RunInfo};
use intely_core::git::{commit, pull_fetch, push};
use intely_core::{
    EnvStatus, EventSink, FileSelection, HunkSelection, OpEvent, OpKind, OpResult, PullMode, PushTarget,
    PushTarget as Target, RepoCommit, RepoConfig, RepoOutcome, RepoSnapshot, TagsMode,
};

pub const NAME: &str = "Fixture User";
pub const EMAIL: &str = "fixture@example.invalid";

static ISOLATE: Once = Once::new();

/// No user or system git config can leak into a fixture, and no ambient git env redirects a command.
fn isolate_env() {
    ISOLATE.call_once(|| {
        std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
        std::env::set_var("GIT_CONFIG_SYSTEM", "/dev/null");
        for k in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"] {
            std::env::remove_var(k);
        }
    });
}

pub struct Sandbox {
    _dir: tempfile::TempDir,
    root: PathBuf,
    seq: AtomicUsize,
}

impl Sandbox {
    pub fn new() -> Self {
        isolate_env();
        let dir = tempfile::Builder::new().prefix("intely-r3-").tempdir().expect("temp dir");
        let root = dir.path().canonicalize().expect("canonical temp dir");
        Self { _dir: dir, root, seq: AtomicUsize::new(0) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// A fresh repo on branch `main` with the fixture identity and a `commit.template` that does not exist.
    pub fn repo(&self, name: &str) -> Fixture {
        let path = self.root.join("work").join(name);
        std::fs::create_dir_all(&path).unwrap();
        let fx = Fixture::at(&self.root, &path, name);
        fx.git(&["init", "-q", "-b", "main"]);
        fx.configure();
        fx
    }

    pub fn bare(&self, name: &str) -> PathBuf {
        let path = self.root.join("remotes").join(format!("{name}.git"));
        std::fs::create_dir_all(&path).unwrap();
        run_git_in(&self.root, &path, &["init", "-q", "--bare", "-b", "main"]);
        path
    }

    /// A repo with a bare `origin`, one commit (`README`) pushed on `main`.
    pub fn repo_with_remote(&self, name: &str) -> Fixture {
        let mut fx = self.repo(name);
        let bare = self.bare(name);
        fx.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
        fx.write("README", "readme\n");
        fx.commit_all("initial");
        fx.git(&["push", "-q", "-u", "origin", "main"]);
        fx.remote = Some(bare);
        fx
    }

    /// Another working copy of `fx`'s remote, e.g. a colleague who pushes first.
    pub fn clone_of(&self, fx: &Fixture, name: &str) -> Fixture {
        let n = self.seq.fetch_add(1, Ordering::Relaxed);
        let path = self.root.join("work").join(format!("{name}-{n}"));
        let remote = fx.remote.as_ref().expect("fixture has a remote");
        run_git_in(&self.root, &self.root, &["clone", "-q", "-b", "main", remote.to_str().unwrap(), path.to_str().unwrap()]);
        let mut other = Fixture::at(&self.root, &path, name);
        other.configure();
        other.remote = fx.remote.clone();
        other
    }

    /// The four roles of the contract: backend (branch `sandbox` with upstream), admin (local and remote branch
    /// names differ, mapped through `pushTargets`), services and shop-pos (both on `main`). Each has one extra
    /// pushed commit, so every working tree is clean and in sync.
    pub fn four(&self) -> Vec<Fixture> {
        let backend = self.repo_with_remote("backend");
        backend.git(&["checkout", "-q", "-b", "sandbox"]);
        backend.git(&["push", "-q", "-u", "origin", "sandbox"]);
        let mut admin = self.repo_with_remote("admin");
        admin.git(&["checkout", "-q", "-b", "feature-light-design"]);
        admin.map_push_target("feature-light-design", "origin", "admin-remote-branch");
        let services = self.repo_with_remote("services");
        let pos = self.repo_with_remote("pos");
        for fx in [&backend, &admin, &services, &pos] {
            fx.write("src/app.txt", "line 1\nline 2\nline 3\n");
            fx.commit_all("add app");
        }
        backend.git(&["push", "-q", "origin", "sandbox"]);
        admin.git(&["push", "-q", "origin", "refs/heads/feature-light-design:refs/heads/admin-remote-branch"]);
        services.git(&["push", "-q", "origin", "main"]);
        pos.git(&["push", "-q", "origin", "main"]);
        vec![backend, admin, services, pos]
    }
}

fn run_git_in(guard_root: &Path, dir: &Path, args: &[&str]) -> String {
    assert!(dir.starts_with(guard_root), "fixture command outside the temp prefix: {}", dir.display());
    let out = Command::new(pinned_git_path())
        .current_dir(dir)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .expect("spawn git");
    assert!(
        out.status.success(),
        "git {args:?} in {} failed: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[derive(Clone)]
pub struct Fixture {
    pub path: PathBuf,
    pub cfg: RepoConfig,
    pub remote: Option<PathBuf>,
    guard_root: PathBuf,
}

impl Fixture {
    fn at(guard_root: &Path, path: &Path, name: &str) -> Self {
        assert!(path.starts_with(guard_root));
        Self {
            path: path.to_path_buf(),
            cfg: RepoConfig {
                id: name.to_owned(),
                path: path.to_string_lossy().into_owned(),
                name: name.to_owned(),
                color: "#4caf7d".to_owned(),
                badge: "FX".to_owned(),
                order: 0,
                push_targets: BTreeMap::new(),
            },
            remote: None,
            guard_root: guard_root.to_path_buf(),
        }
    }

    fn configure(&self) {
        self.git(&["config", "user.name", NAME]);
        self.git(&["config", "user.email", EMAIL]);
        let template = self.path.join(".git").join("no-such-template");
        self.git(&["config", "commit.template", template.to_str().unwrap()]);
        self.git(&["config", "commit.gpgsign", "false"]);
    }

    pub fn id(&self) -> &str {
        &self.cfg.id
    }

    pub fn map_push_target(&mut self, local: &str, remote: &str, branch: &str) {
        self.cfg.push_targets.insert(
            local.to_owned(),
            intely_core::PushTargetMapping { remote: remote.to_owned(), branch: branch.to_owned() },
        );
    }

    /// stdout of a git command run in the repo; panics with stderr when it fails.
    pub fn git(&self, args: &[&str]) -> String {
        run_git_in(&self.guard_root, &self.path, args)
    }

    /// (exit code, stdout, stderr) without asserting success.
    pub fn git_try(&self, args: &[&str]) -> (i32, String, String) {
        assert!(self.path.starts_with(&self.guard_root));
        let out = Command::new(pinned_git_path())
            .current_dir(&self.path)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .expect("spawn git");
        (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        )
    }

    /// (exit code, stdout, stderr) of a git command that reads `input` on stdin.
    pub fn git_stdin(&self, args: &[&str], input: &[u8]) -> (i32, String, String) {
        use std::io::Write;
        assert!(self.path.starts_with(&self.guard_root));
        let mut child = Command::new(pinned_git_path())
            .current_dir(&self.path)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn git");
        child.stdin.take().unwrap().write_all(input).unwrap();
        let out = child.wait_with_output().unwrap();
        (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        )
    }

    /// stdout bytes (for NUL-separated or binary output).
    pub fn git_bytes(&self, args: &[&str]) -> Vec<u8> {
        assert!(self.path.starts_with(&self.guard_root));
        let out = Command::new(pinned_git_path())
            .current_dir(&self.path)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .expect("spawn git");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        out.stdout
    }

    pub fn write(&self, rel: &str, contents: &str) {
        self.write_bytes(rel, contents.as_bytes());
    }

    pub fn write_bytes(&self, rel: &str, contents: &[u8]) {
        let p = self.path.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, contents).unwrap();
    }

    pub fn read(&self, rel: &str) -> Vec<u8> {
        std::fs::read(self.path.join(rel)).unwrap()
    }

    pub fn read_string(&self, rel: &str) -> String {
        String::from_utf8(self.read(rel)).unwrap()
    }

    pub fn remove(&self, rel: &str) {
        std::fs::remove_file(self.path.join(rel)).unwrap();
    }

    pub fn exists(&self, rel: &str) -> bool {
        self.path.join(rel).exists()
    }

    pub fn stage(&self, rels: &[&str]) {
        let mut args = vec!["add", "--"];
        args.extend(rels);
        self.git(&args);
    }

    /// `git add -A` + plain commit; returns the new HEAD.
    pub fn commit_all(&self, msg: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
        self.head()
    }

    pub fn head(&self) -> String {
        self.git(&["rev-parse", "HEAD"]).trim().to_owned()
    }

    pub fn head_opt(&self) -> Option<String> {
        let (code, out, _) = self.git_try(&["rev-parse", "-q", "--verify", "HEAD"]);
        (code == 0).then(|| out.trim().to_owned())
    }

    pub fn branch(&self) -> String {
        self.git(&["symbolic-ref", "--short", "HEAD"]).trim().to_owned()
    }

    pub fn ls_files_s(&self) -> String {
        self.git(&["ls-files", "-s"])
    }

    /// The `ls-files -s` line of one path (empty if not in the index).
    pub fn index_line(&self, path: &str) -> String {
        self.git(&["ls-files", "-s", "--", path]).trim().to_owned()
    }

    pub fn status(&self) -> String {
        self.git(&["status", "--porcelain", "--untracked-files=normal"])
    }

    /// Paths of HEAD's tree, NUL-exact.
    pub fn tree(&self) -> Vec<Vec<u8>> {
        self.git_bytes(&["ls-tree", "-r", "-z", "--name-only", "HEAD"])
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(<[u8]>::to_vec)
            .collect()
    }

    pub fn show(&self, rev_path: &str) -> Vec<u8> {
        self.git_bytes(&["show", rev_path])
    }

    pub fn git_dir(&self) -> PathBuf {
        self.path.join(".git")
    }

    pub fn index_bytes(&self) -> Vec<u8> {
        std::fs::read(self.git_dir().join("index")).unwrap()
    }

    /// Temp indexes left behind by the engine (must be none).
    pub fn temp_indexes(&self) -> Vec<String> {
        std::fs::read_dir(self.git_dir())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("ide-index."))
            .collect()
    }

    /// An executable hook (`name` is `pre-commit`, `pre-push`, ...).
    pub fn hook(&self, name: &str, script: &str) {
        let p = self.git_dir().join("hooks").join(name);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    pub fn remove_hook(&self, name: &str) {
        let _ = std::fs::remove_file(self.git_dir().join("hooks").join(name));
    }

    /// An executable hook in the bare remote (e.g. `pre-receive`).
    pub fn remote_hook(&self, name: &str, script: &str) {
        let remote = self.remote.as_ref().expect("fixture has a remote");
        let p = remote.join("hooks").join(name);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// Tip oid of a branch in the bare remote, `None` if the branch does not exist there.
    pub fn remote_ref(&self, branch: &str) -> Option<String> {
        let remote = self.remote.as_ref().expect("fixture has a remote");
        let out = Command::new(pinned_git_path())
            .current_dir(remote)
            .args(["rev-parse", "-q", "--verify", &format!("refs/heads/{branch}")])
            .output()
            .unwrap();
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
    }

    pub fn remote_git(&self, args: &[&str]) -> String {
        let remote = self.remote.as_ref().expect("fixture has a remote");
        run_git_in(&self.guard_root, remote, args)
    }

    /// A commit object has no AI trailer and carries exactly the fixture identity.
    pub fn assert_clean_commit(&self, rev: &str) {
        let raw = self.git(&["cat-file", "commit", rev]);
        let lower = raw.to_lowercase();
        for banned in ["co-authored-by", "claude", "anthropic", "generated with"] {
            assert!(!lower.contains(banned), "commit {rev} contains {banned:?}:\n{raw}");
        }
        let ident = format!(" {NAME} <{EMAIL}> ");
        for role in ["author", "committer"] {
            let line = raw.lines().find(|l| l.starts_with(&format!("{role} "))).unwrap_or_else(|| panic!("no {role}"));
            assert!(line[role.len()..].starts_with(&ident), "{role} line is {line:?}");
        }
    }
}

#[derive(Default)]
pub struct Sink {
    pub events: Mutex<Vec<OpEvent>>,
}

impl EventSink for Sink {
    fn snapshot(&self, _: RepoSnapshot) {}
    fn op_event(&self, e: OpEvent) {
        self.events.lock().unwrap().push(e);
    }
    fn op_result(&self, _: OpResult) {}
    fn env(&self, _: EnvStatus) {}
}

/// Context factory: one sink collecting every `op:event`, a resolver without the on-disk cache.
pub struct Harness {
    pub sink: Arc<Sink>,
    base: GitCtx,
}

impl Harness {
    pub fn new() -> Self {
        isolate_env();
        let git = pinned_git_path();
        let env = Arc::new(EnvResolver::with_options(
            &git.to_string_lossy(),
            EnvOptions { cache_path: None, ..Default::default() },
        ));
        let sink = Arc::new(Sink::default());
        Self { base: GitCtx::new(git, env, sink.clone()), sink }
    }

    /// A context without a run: no events, no cancellation.
    pub fn plain(&self) -> GitCtx {
        self.base.clone()
    }

    /// A context bound to a new run of `kind`, and the token that cancels it.
    pub fn run(&self, kind: OpKind) -> (GitCtx, CancelToken) {
        let cancel = CancelToken::default();
        let run = RunInfo { run_id: uuid_like(), kind, cancel: cancel.clone() };
        (self.base.with_run(run), cancel)
    }

    pub fn events(&self, repo_id: &str) -> Vec<OpEvent> {
        self.sink.events.lock().unwrap().iter().filter(|e| e.repo_id == repo_id).cloned().collect()
    }

    /// Every streamed output line of a repo.
    pub fn lines(&self, repo_id: &str) -> Vec<String> {
        self.events(repo_id).into_iter().filter_map(|e| e.line.map(|l| l.text)).collect()
    }

    pub async fn commit(&self, fx: &Fixture, files: Vec<FileSelection>, msg: &str) -> RepoOutcome {
        self.commit_with(fx, files, msg, false, false).await
    }

    pub async fn commit_with(
        &self,
        fx: &Fixture,
        files: Vec<FileSelection>,
        msg: &str,
        amend: bool,
        no_verify: bool,
    ) -> RepoOutcome {
        let (ctx, _) = self.run(OpKind::Commit);
        let rc = RepoCommit { repo_id: fx.id().to_owned(), files, message: msg.to_owned(), amend };
        commit::run_commit(&ctx, &fx.cfg, &rc, no_verify).await
    }

    pub async fn push(&self, fx: &Fixture, remote_branch: &str) -> RepoOutcome {
        self.push_with(fx, target(fx, remote_branch, TagsMode::None), false).await
    }

    pub async fn push_with(&self, fx: &Fixture, target: PushTarget, no_verify: bool) -> RepoOutcome {
        let (ctx, _) = self.run(OpKind::Push);
        push::run_push(&ctx, &fx.cfg, &target, no_verify).await
    }

    pub async fn pull(&self, fx: &Fixture, mode: PullMode) -> RepoOutcome {
        let (ctx, _) = self.run(OpKind::Pull);
        pull_fetch::pull(&ctx, &fx.cfg, mode).await
    }

    pub async fn fetch(&self, fx: &Fixture) -> RepoOutcome {
        let (ctx, _) = self.run(OpKind::Fetch);
        pull_fetch::fetch(&ctx, &fx.cfg).await
    }
}

fn uuid_like() -> String {
    static N: AtomicUsize = AtomicUsize::new(0);
    format!("run-{}", N.fetch_add(1, Ordering::Relaxed))
}

pub fn target(fx: &Fixture, remote_branch: &str, tags: TagsMode) -> PushTarget {
    Target {
        repo_id: fx.id().to_owned(),
        remote: "origin".to_owned(),
        remote_branch: remote_branch.to_owned(),
        tags,
        force_with_lease: None,
        confirm_live: None,
    }
}

pub fn whole(path: &str) -> FileSelection {
    FileSelection::Whole { path: path.to_owned(), orig_path: None }
}

pub fn renamed(new: &str, old: &str) -> FileSelection {
    FileSelection::Whole { path: new.to_owned(), orig_path: Some(old.to_owned()) }
}

/// `(hunk index, selected body-line indexes or None for the whole hunk)`
pub fn partial(path: &str, hunks: &[(u32, Option<Vec<u32>>)]) -> FileSelection {
    FileSelection::Partial {
        path: path.to_owned(),
        hunks: hunks.iter().map(|(index, lines)| HunkSelection { index: *index, lines: lines.clone() }).collect(),
    }
}

/// Body lines (` `, `+`, `-` prefixed, no `\ No newline` markers) of each hunk of `git diff HEAD -U3` for `path`.
pub fn hunk_lines(fx: &Fixture, path: &str) -> Vec<Vec<String>> {
    let diff = fx.git(&["diff", "HEAD", "-U3", "--no-color", "--", path]);
    let mut hunks: Vec<Vec<String>> = Vec::new();
    for l in diff.lines() {
        if l.starts_with("@@ ") {
            hunks.push(Vec::new());
        } else if let Some(h) = hunks.last_mut() {
            if !l.starts_with('\\') {
                h.push(l.to_owned());
            }
        }
    }
    hunks
}

/// Index of the body line `needle` (exact match with prefix) inside hunk `hunk`.
pub fn line_index(fx: &Fixture, path: &str, hunk: usize, needle: &str) -> u32 {
    hunk_lines(fx, path)[hunk].iter().position(|l| l == needle).unwrap_or_else(|| panic!("no line {needle:?}")) as u32
}

pub fn sha(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

/// `n` lines "line 1".."line n".
pub fn numbered(n: usize) -> String {
    (1..=n).map(|i| format!("line {i}\n")).collect()
}

/// Replaces the given 1-based lines of a `numbered` text.
pub fn edit_lines(text: &str, edits: &[(usize, &str)]) -> String {
    text.lines()
        .enumerate()
        .map(|(i, l)| {
            let line = edits.iter().find(|(n, _)| *n == i + 1).map_or(l, |(_, t)| *t);
            format!("{line}\n")
        })
        .collect()
}

pub fn wait_until(timeout: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    cond()
}

/// Whether a process with this pid is alive.
pub fn pid_alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks for existence.
    unsafe { libc::kill(pid, 0) == 0 }
}

pub fn read_pid(path: &Path) -> Option<i32> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// A failed outcome's kind, panicking with the outcome when it did not fail.
pub fn failure_kind(o: &RepoOutcome) -> intely_core::FailureKind {
    o.failure.as_ref().unwrap_or_else(|| panic!("expected a failure: {o:?}")).kind.clone()
}

pub fn failure_output(o: &RepoOutcome) -> String {
    o.failure.as_ref().and_then(|f| f.output.clone()).unwrap_or_default()
}

/// A workspace with the given repos and protected branch patterns, generic defaults otherwise. Replaces
/// `workspace::seed()` in tests: no Happy-specific data lives in the engine.
pub fn workspace_of(repos: Vec<RepoConfig>, protected: &[&str]) -> intely_core::Workspace {
    let mut ws = intely_core::workspace::empty();
    ws.repos = repos;
    ws.protected_branches = protected.iter().map(|s| (*s).to_owned()).collect();
    ws
}
