//! Shared helpers of the host tests: a fixture repo, a collecting sink, and a config pointing at the real or the fake sidecar.
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use intely_agent_core::events::types::{AgentEvent, EventKind};
use intely_agent_host::{AgentHost, HostConfig, HostSink, RepoRef};

pub struct Collector {
    events: Mutex<Vec<AgentEvent>>,
    cv: Condvar,
}

impl Collector {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { events: Mutex::new(Vec::new()), cv: Condvar::new() })
    }

    pub fn all(&self) -> Vec<AgentEvent> {
        self.events.lock().unwrap().clone()
    }

    pub fn of(&self, agent: &str) -> Vec<AgentEvent> {
        self.all().into_iter().filter(|e| e.agent_id == agent).collect()
    }

    /// Waits until an event of `agent` satisfies `pred` (searching everything seen so far).
    pub fn wait(&self, agent: &str, what: &str, secs: u64, pred: impl Fn(&AgentEvent) -> bool) -> AgentEvent {
        let deadline = Instant::now() + Duration::from_secs(secs);
        let mut guard = self.events.lock().unwrap();
        loop {
            if let Some(e) = guard.iter().find(|e| e.agent_id == agent && pred(e)) {
                return e.clone();
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                let kinds: Vec<&str> = guard.iter().filter(|e| e.agent_id == agent).map(|e| e.kind.name()).collect();
                panic!("timeout waiting for {what}; events so far: {kinds:?}");
            }
            guard = self.cv.wait_timeout(guard, left).unwrap().0;
        }
    }

    pub fn wait_kind(&self, agent: &str, kind: &str) -> AgentEvent {
        self.wait(agent, kind, 20, |e| e.kind.name() == kind)
    }

    pub fn wait_turn_end(&self, agent: &str) -> AgentEvent {
        self.wait_kind(agent, "turn.end")
    }
}

impl HostSink for Collector {
    fn events(&self, events: Vec<AgentEvent>) {
        self.events.lock().unwrap().extend(events);
        self.cv.notify_all();
    }
}

pub fn sidecar_js() -> PathBuf {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../sidecar/dist/index.js");
    assert!(p.is_file(), "build the sidecar first: pnpm --filter @intely/sidecar build ({})", p.display());
    p
}

pub fn fake_sidecar_js() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/common/fake-sidecar.mjs")
}

fn base_env() -> HashMap<String, String> {
    ["PATH", "HOME", "LANG"].iter().filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v))).collect()
}

pub fn config(data: &Path, js: PathBuf) -> HostConfig {
    let mut cfg = HostConfig::new(data.to_path_buf(), js, Arc::new(base_env));
    cfg.providers = vec!["mock".into()];
    cfg.mock_speed = 20.0;
    cfg.start_timeout = Duration::from_secs(20);
    cfg
}

pub fn host_with(cfg: HostConfig) -> (AgentHost, Arc<Collector>) {
    let sink = Collector::new();
    (AgentHost::new(cfg, sink.clone()), sink)
}

pub fn git(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .expect("run git");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A repo with one commit and a tracked file `a.txt`.
pub fn fixture_repo(dir: &Path) -> RepoRef {
    let path = dir.join("repo");
    std::fs::create_dir_all(&path).unwrap();
    git(&path, &["init", "-q", "-b", "main"]);
    std::fs::write(path.join("a.txt"), "one\n").unwrap();
    git(&path, &["add", "a.txt"]);
    git(&path, &["commit", "-q", "-m", "init"]);
    RepoRef { id: "repo".into(), path: path.canonicalize().unwrap() }
}

pub fn has_kind(events: &[AgentEvent], kind: &str) -> bool {
    events.iter().any(|e| e.kind.name() == kind)
}

pub fn stop_reason(e: &AgentEvent) -> String {
    match &e.kind {
        EventKind::TurnEnd { stop_reason } => format!("{stop_reason:?}"),
        _ => String::new(),
    }
}
