//! `AgentHost::rewind` obeys the process-wide jail. The jail is read once per process, so the run is created in one
//! child process (no jail) and rewound in another (jailed).

mod common;

use common::*;
use intely_agent_core::api::AgentStartRequest;
use std::path::PathBuf;
use std::process::Command;

fn dir_from_env() -> PathBuf {
    PathBuf::from(std::env::var("JAIL_TEST_DIR").expect("child of rewind_is_refused_under_the_jail"))
}

fn child(test: &str, dir: &std::path::Path, envs: &[(&str, &str)]) -> std::process::Output {
    let mut cmd = Command::new(std::env::current_exe().unwrap());
    cmd.args([test, "--exact", "--ignored", "--nocapture"]).env("JAIL_TEST_DIR", dir);
    for k in ["INTELY_READONLY", "INTELY_E2E", "INTELY_E2E_SCRIPT", "INTELY_FIXTURE_ROOT"] {
        cmd.env_remove(k);
    }
    for (k, v) in envs {
        cmd.env(k, v);
    }
    cmd.output().unwrap()
}

#[test]
#[ignore = "child process of rewind_is_refused_under_the_jail"]
fn child_make_run() {
    let dir = dir_from_env();
    let repo = fixture_repo(&dir);
    std::fs::write(repo.path.join("a.txt"), "dirty before the run\n").unwrap();
    let (host, sink) = host_with(config(&dir.join("data"), sidecar_js()));
    let id = host
        .start(AgentStartRequest { role: "mock-plain-reply".into(), repo_ids: vec![repo.id.clone()], prompt: "go".into(), mode: None, mcp_servers: None }, std::slice::from_ref(&repo))
        .unwrap()
        .agent_id;
    sink.wait_turn_end(&id);
    host.shutdown();
    std::fs::write(repo.path.join("a.txt"), "CHANGED after the run\n").unwrap();
    std::fs::write(dir.join("run-id"), id).unwrap();
}

#[test]
#[ignore = "child process of rewind_is_refused_under_the_jail"]
fn child_rewind() {
    let dir = dir_from_env();
    let id = std::fs::read_to_string(dir.join("run-id")).unwrap();
    let (host, _sink) = host_with(config(&dir.join("data"), sidecar_js()));
    let err = host.rewind(&id).expect_err("a jailed rewind must be refused");
    println!("CODE={}", err.code);
}

#[test]
fn rewind_is_refused_under_the_jail() {
    let dir = tempfile::tempdir().unwrap();
    let made = child("child_make_run", dir.path(), &[]);
    assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stdout));
    let a_txt = dir.path().join("repo/a.txt");
    let other_root = tempfile::tempdir().unwrap();
    let cases: [(&str, Vec<(&str, &str)>); 2] = [
        ("readOnly", vec![("INTELY_READONLY", "1")]),
        ("testJail", vec![("INTELY_E2E", "1"), ("INTELY_FIXTURE_ROOT", other_root.path().to_str().unwrap())]),
    ];
    for (code, envs) in cases {
        let out = child("child_rewind", dir.path(), &envs);
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success(), "{stdout}{}", String::from_utf8_lossy(&out.stderr));
        assert!(stdout.contains(&format!("CODE={code}")), "{stdout}");
        assert_eq!(std::fs::read_to_string(&a_txt).unwrap(), "CHANGED after the run\n", "the tree is untouched under {code}");
    }
}
