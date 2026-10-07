//! Throwaway repos under one temp dir, isolated from the user's git config, and an [`Env`] jailed to that dir.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Once};

use intely_core::env::EnvResolver;
use intely_core::exec::{pinned_git_path, GitCtx};
use intely_core::jail::Jail;
use intely_core::{EnvStatus, EventSink, OpEvent, OpResult, RepoConfig, RepoSnapshot, Workspace};
use intely_graph::Env;

struct NullSink;
impl EventSink for NullSink {
    fn snapshot(&self, _: RepoSnapshot) {}
    fn op_event(&self, _: OpEvent) {}
    fn op_result(&self, _: OpResult) {}
    fn env(&self, _: EnvStatus) {}
}

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
        ] {
            std::env::set_var(k, v);
        }
        for k in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR"] {
            std::env::remove_var(k);
        }
    });
}

pub struct Sandbox {
    _dir: tempfile::TempDir,
    pub root: PathBuf,
}

impl Sandbox {
    pub fn new() -> Self {
        isolate_env();
        let dir = tempfile::Builder::new().prefix("intely-graph-").tempdir().expect("temp dir");
        let root = dir.path().canonicalize().expect("canonical temp dir");
        Self { _dir: dir, root }
    }

    pub fn repo(&self, name: &str) -> Repo {
        let path = self.root.join(name);
        std::fs::create_dir_all(&path).expect("repo dir");
        let repo = Repo { id: name.to_owned(), path, clock: std::cell::Cell::new(1_700_000_000) };
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.name", "Fixture User"]);
        repo.git(&["config", "user.email", "fixture@example.invalid"]);
        repo
    }

    /// An engine context jailed to this sandbox.
    pub fn env(&self, repos: &[&Repo]) -> Env {
        self.env_in(&self.root, repos)
    }

    pub fn env_in(&self, jail_root: &Path, repos: &[&Repo]) -> Env {
        let git = pinned_git_path();
        let ctx = GitCtx::new(git.clone(), Arc::new(EnvResolver::new(&git.to_string_lossy())), Arc::new(NullSink))
            .with_jail(Arc::new(Jail::e2e(jail_root)));
        Env::new(ctx, workspace(repos))
    }
}

pub fn workspace(repos: &[&Repo]) -> Workspace {
    serde_json::from_value(serde_json::json!({
        "version": 1,
        "repos": repos.iter().enumerate().map(|(i, r)| serde_json::json!({
            "id": r.id, "path": r.path, "name": r.id, "color": "#336699", "badge": &r.id[..1].to_uppercase(), "order": i, "pushTargets": {}
        })).collect::<Vec<_>>(),
        "protectedBranches": ["main", "master", "release/*"],
        "settings": { "messageMode": "shared", "untrackedChecked": false }
    }))
    .expect("workspace")
}

pub struct Repo {
    pub id: String,
    pub path: PathBuf,
    clock: std::cell::Cell<i64>,
}

impl Repo {
    pub fn config(&self) -> RepoConfig {
        workspace(&[self]).repos.remove(0)
    }

    pub fn git(&self, args: &[&str]) -> String {
        let out = self.git_raw(args, None);
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    fn git_raw(&self, args: &[&str], date: Option<i64>) -> std::process::Output {
        assert!(self.path.starts_with(std::env::temp_dir().canonicalize().unwrap_or_default()) || self.path.starts_with("/private"), "fixture outside the temp dir");
        let mut cmd = Command::new(pinned_git_path());
        cmd.arg("-C").arg(&self.path).args(args).env("GIT_EDITOR", ":").stdin(Stdio::null());
        if let Some(t) = date {
            let d = format!("@{t} +0000");
            cmd.env("GIT_AUTHOR_DATE", &d).env("GIT_COMMITTER_DATE", &d);
        }
        cmd.output().expect("run git")
    }

    pub fn write(&self, rel: &str, content: &str) {
        let p = self.path.join(rel);
        std::fs::create_dir_all(p.parent().expect("parent")).expect("dirs");
        std::fs::write(p, content).expect("write");
    }

    /// Commit `files` (path, content) with a strictly increasing commit time; returns the oid.
    pub fn commit(&self, subject: &str, files: &[(&str, &str)]) -> String {
        let t = self.clock.get() + 60;
        self.commit_at(subject, files, t)
    }

    pub fn commit_at(&self, subject: &str, files: &[(&str, &str)], time: i64) -> String {
        self.clock.set(time);
        for (p, c) in files {
            self.write(p, c);
        }
        self.git(&["add", "-A"]);
        let out = self.git_raw(&["commit", "-q", "--allow-empty", "-m", subject], Some(time));
        assert!(out.status.success(), "commit failed: {}", String::from_utf8_lossy(&out.stderr));
        self.git(&["rev-parse", "HEAD"])
    }

    pub fn subjects(&self) -> Vec<String> {
        self.git(&["log", "--format=%s"]).lines().map(str::to_owned).collect()
    }

    pub fn head(&self) -> String {
        self.git(&["rev-parse", "HEAD"])
    }
}
