//! Protocol handling of the host against a fake sidecar: policy routing, fail-closed answers, refused message types,
//! a deliberately broken policy channel (`PolicyFault`).

mod common;

use std::path::Path;
use std::time::{Duration, Instant};

use common::*;
use intely_agent_core::api::AgentStartRequest;
use intely_agent_host::PolicyFault;
use serde_json::Value;

fn run_fake(cfg: intely_agent_host::HostConfig, repo: &intely_agent_host::RepoRef, out: &Path) -> intely_agent_host::AgentHost {
    let (host, _sink) = host_with(cfg);
    host.start(AgentStartRequest { role: "mock-plain-reply".into(), repo_ids: vec![repo.id.clone()], prompt: out.to_string_lossy().into_owned(), mode: None, mcp_servers: None }, std::slice::from_ref(repo)).expect("start");
    host
}

fn wait_file(path: &Path, secs: u64) -> Value {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Ok(text) = std::fs::read_to_string(path) {
            return serde_json::from_str(&text).expect("json");
        }
        assert!(Instant::now() < deadline, "the fake sidecar wrote nothing to {}", path.display());
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn every_decision_is_judged_by_the_policy_and_anything_doubtful_is_denied() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let out = dir.path().join("replies.json");
    let host = run_fake(config(&dir.path().join("data"), fake_sidecar_js()), &repo, &out);
    let r = wait_file(&out, 20);
    let by = |k: &str| (r[k]["decision"].as_str().unwrap_or("-").to_string(), r[k]["by"].as_str().unwrap_or("-").to_string());
    assert_eq!(by("hardStop"), ("deny".into(), "hardStop".into()), "{r}");
    assert_eq!(by("absoluteGit"), ("deny".into(), "hardStop".into()));
    assert_eq!(by("secondHardStop"), ("deny".into(), "hardStop".into()), "sh -c is unwrapped");
    assert_eq!(by("unknownAgent"), ("deny".into(), "failClosed".into()), "a request for an agent the host does not know");
    assert_eq!(by("garbage"), ("deny".into(), "failClosed".into()), "a body that does not parse");
    assert_eq!(r["forbiddenType"]["error"], "unknownType", "the sidecar has no route to anything but the protocol messages");
    host.shutdown();
}

#[test]
fn a_dropped_policy_reply_leaves_the_sidecar_without_an_answer_to_time_out_on() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let out = dir.path().join("replies.json");
    let mut cfg = config(&dir.path().join("data"), fake_sidecar_js());
    cfg.policy_fault = Some(PolicyFault::Drop);
    let host = run_fake(cfg, &repo, &out);
    let r = wait_file(&out, 30);
    for k in ["hardStop", "absoluteGit", "unknownAgent", "garbage", "secondHardStop"] {
        assert_eq!(r[k]["timeout"], true, "{k}: the host never answered, the sidecar's own 2 s timeout is what denies");
    }
    host.shutdown();
}

#[test]
fn a_closed_policy_pipe_ends_the_sidecar_and_the_run() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let out = dir.path().join("replies.json");
    let mut cfg = config(&dir.path().join("data"), fake_sidecar_js());
    cfg.policy_fault = Some(PolicyFault::ClosePipe);
    let (host, sink) = host_with(cfg);
    let summary = host.start(AgentStartRequest { role: "mock-plain-reply".into(), repo_ids: vec![repo.id.clone()], prompt: out.to_string_lossy().into_owned(), mode: None, mcp_servers: None }, std::slice::from_ref(&repo)).expect("start");
    // the fake exits on stdin EOF: the host notices and nothing keeps running
    let deadline = Instant::now() + Duration::from_secs(10);
    while host.sidecar_pid().is_some() {
        assert!(Instant::now() < deadline, "the sidecar should be gone");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!out.exists(), "no policy answer ever reached the sidecar");
    assert_eq!(host.leases().len(), 0);
    let _ = (summary, sink);
    host.shutdown();
}
