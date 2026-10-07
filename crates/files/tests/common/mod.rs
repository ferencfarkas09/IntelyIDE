//! Throwaway fixture repos under one temp dir, isolated from the user's git config. Nothing here can reach a real repo.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};

use intely_core::env::{EnvOptions, EnvResolver};
use intely_core::exec::{pinned_git_path, GitCtx};
use intely_core::jail::Jail;
use intely_files::{Files, FilesSink, FileChanged, NullEngineSink, RepoRoot, SearchBatch};

static ISOLATE: Once = Once::new();

fn isolate_env() {
    ISOLATE.call_once(|| {
        for (k, v) in [
            ("GIT_CONFIG_GLOBAL", "/dev/null"),
            ("GIT_CONFIG_SYSTEM", "/dev/null"),
            ("GIT_AUTHOR_NAME", "Fixture User"),
            ("GIT_AUTHOR_EMAIL", "fixture@example.invalid"),
            ("GIT_COMMITTER_NAME", "Fixture User"),
            ("GIT_COMMITTER_EMAIL", "fixture@example.invalid"),
            // The tests cover the git grep backend; no ripgrep binary is needed or used.
            ("INTELY_RG", "off"),
        ] {
            std::env::set_var(k, v);
        }
        for k in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] {
            std::env::remove_var(k);
        }
    });
}

#[derive(Default)]
pub struct Recorder {
    pub changes: Mutex<Vec<FileChanged>>,
    pub batches: Mutex<Vec<SearchBatch>>,
}

impl FilesSink for Recorder {
    fn file_changed(&self, e: FileChanged) {
        self.changes.lock().unwrap().push(e);
    }
    fn search_batch(&self, b: SearchBatch) {
        self.batches.lock().unwrap().push(b);
    }
}

impl Recorder {
    /// All batches of one search once the `done` batch arrived.
    pub fn wait_done(&self, search_id: &str) -> Vec<SearchBatch> {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let mine: Vec<SearchBatch> = self.batches.lock().unwrap().iter().filter(|b| b.search_id == search_id).cloned().collect();
            if mine.iter().any(|b| b.done) {
                return mine;
            }
            assert!(Instant::now() < deadline, "search {search_id} never finished");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

pub fn files_with(jail: Jail) -> (Arc<Files>, Arc<Recorder>) {
    isolate_env();
    let git = pinned_git_path();
    let env = Arc::new(EnvResolver::with_options(&git.to_string_lossy(), EnvOptions { cache_path: None, ..Default::default() }));
    let ctx = GitCtx::new(git, env, Arc::new(NullEngineSink)).with_jail(Arc::new(jail));
    let rec = Arc::new(Recorder::default());
    (Arc::new(Files::new(ctx, rec.clone())), rec)
}

pub fn files() -> (Arc<Files>, Arc<Recorder>) {
    files_with(Jail::off())
}

pub struct Sandbox {
    _dir: tempfile::TempDir,
    pub root: PathBuf,
}

impl Sandbox {
    pub fn new() -> Self {
        isolate_env();
        let dir = tempfile::Builder::new().prefix("intely-c1-").tempdir().expect("temp dir");
        let root = dir.path().canonicalize().expect("canonical temp dir");
        Self { _dir: dir, root }
    }

    /// A repo on `main` with one commit (README.md).
    pub fn repo(&self, name: &str) -> Repo {
        let path = self.root.join("work").join(name);
        std::fs::create_dir_all(&path).unwrap();
        let repo = Repo { id: name.to_owned(), path };
        repo.git(&["init", "-q", "-b", "main"]);
        repo.write("README.md", "# fixture\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        repo
    }

    /// `name` cloned from a new bare remote (a local path) with `main` pushed and tracking.
    pub fn repo_with_remote(&self, name: &str) -> Repo {
        let bare = self.root.join("remotes").join(format!("{name}.git"));
        std::fs::create_dir_all(&bare).unwrap();
        run(&bare, &["init", "-q", "--bare", "-b", "main"]);
        let repo = self.repo(name);
        repo.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
        repo.git(&["push", "-q", "-u", "origin", "main"]);
        repo
    }
}

fn run(dir: &Path, args: &[&str]) -> String {
    assert!(dir.to_string_lossy().contains("intely-c1-"), "fixtures only: {}", dir.display());
    let out = Command::new(pinned_git_path()).current_dir(dir).args(args).output().expect("git");
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

pub struct Repo {
    pub id: String,
    pub path: PathBuf,
}

impl Repo {
    pub fn root(&self) -> RepoRoot {
        RepoRoot { id: self.id.clone(), path: self.path.clone() }
    }

    pub fn git(&self, args: &[&str]) -> String {
        run(&self.path, args)
    }

    pub fn write(&self, rel: &str, content: impl AsRef<[u8]>) {
        let p = self.path.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    pub fn commit_all(&self, msg: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
    }

    pub fn exists(&self, rel: &str) -> bool {
        std::fs::symlink_metadata(self.path.join(rel)).is_ok()
    }

    pub fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.path.join(rel)).unwrap()
    }
}

/// Polls `check` for up to `secs` seconds.
pub fn eventually(secs: u64, mut check: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if check() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    check()
}
