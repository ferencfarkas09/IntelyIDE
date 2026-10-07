//! Helpers shared by the gate tests: real child processes (sleepers, grandchildren) in their own process groups,
//! polling, and throwaway git fixture repos that are isolated from the user's git configuration.

#![allow(dead_code)]

use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Once;
use std::time::{Duration, Instant};

use intely_agent_gate::gate::{procinfo, rss};

static ISOLATE: Once = Once::new();

/// No user or system git config can leak into a fixture, and no ambient git env redirects a command.
pub fn isolate_env() {
    ISOLATE.call_once(|| {
        std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
        std::env::set_var("GIT_CONFIG_SYSTEM", "/dev/null");
        for k in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"] {
            std::env::remove_var(k);
        }
    });
}

/// A child in its own process group; the whole group is killed and reaped on drop.
pub struct Group {
    pub child: Child,
}

impl Group {
    /// `sh -c script` as the leader of a new process group (pgid == pid).
    pub fn sh(script: &str) -> Self {
        let child = Command::new("sh")
            .arg("-c")
            .arg(script)
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sh");
        Self { child }
    }

    pub fn sleeper() -> Self {
        Self::sh("sleep 300")
    }

    /// Leader plus two grandchildren, all in the same group.
    pub fn with_grandchildren() -> Self {
        Self::sh("sleep 300 & sleep 300 & wait")
    }

    /// Ignores SIGTERM (children inherit the ignore), so only SIGKILL ends it.
    pub fn stubborn() -> Self {
        Self::sh("trap '' TERM; sleep 300 & sleep 300 & wait")
    }

    pub fn pgid(&self) -> i32 {
        self.child.id() as i32
    }

    pub fn alive(&self) -> bool {
        !procinfo::live_group_pids(self.pgid()).is_empty()
    }

    /// Waits until the whole group is gone; reaps the leader so it does not linger as a zombie.
    pub fn gone_within(&mut self, timeout: Duration) -> bool {
        let ok = wait_until(timeout, || !self.alive());
        let _ = self.child.try_wait();
        ok
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        // descendants that moved to another process group would survive the killpg below
        for pid in rss::descendants(self.pgid()).into_iter().filter(|p| *p != self.pgid()) {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        unsafe { libc::killpg(self.pgid(), libc::SIGKILL) };
        let _ = self.child.wait();
    }
}

/// A process that is not a group leader of its own and is not in the test's group is irrelevant here; this one is
/// a plain child used as a stand-in for the sidecar (the lease owner).
pub fn spawn_owner() -> Child {
    Command::new("sleep").arg("300").process_group(0).spawn().expect("spawn owner")
}

pub fn wait_until(timeout: Duration, mut f: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + timeout;
    loop {
        if f() {
            return true;
        }
        if Instant::now() >= end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub fn real_git() -> PathBuf {
    intely_core::exec::pinned_git_path()
}

/// A throwaway repo on branch `main` under a temp dir.
pub struct Repo {
    _dir: tempfile::TempDir,
    pub path: PathBuf,
}

impl Repo {
    pub fn new() -> Self {
        isolate_env();
        let dir = tempfile::Builder::new().prefix("intely-gate-").tempdir().expect("temp dir");
        let path = dir.path().canonicalize().expect("canonical temp dir").join("repo");
        std::fs::create_dir_all(&path).unwrap();
        let repo = Self { _dir: dir, path };
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.name", "Fixture User"]);
        repo.git(&["config", "user.email", "fixture@example.invalid"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo
    }

    pub fn root(&self) -> &Path {
        self._dir.path()
    }

    pub fn write(&self, rel: &str, content: impl AsRef<[u8]>) {
        let p = self.path.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    pub fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.path.join(rel)).unwrap()
    }

    pub fn exists(&self, rel: &str) -> bool {
        std::fs::symlink_metadata(self.path.join(rel)).is_ok()
    }

    pub fn git(&self, args: &[&str]) -> String {
        let out = Command::new(real_git()).arg("-C").arg(&self.path).args(args).output().expect("run git");
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim_end().to_string()
    }

    pub fn commit_all(&self, msg: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
    }

    pub fn index_bytes(&self) -> Vec<u8> {
        std::fs::read(self.path.join(".git/index")).unwrap_or_default()
    }
}
