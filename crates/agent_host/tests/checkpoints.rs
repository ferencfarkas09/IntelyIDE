//! Run checkpoints through the host: one before each follow-up prompt and after each turn, named save points, a restore with a dry
//! run, explicit confirmation, kept later edits and the same "not while a run works there" rule as Rewind.

#![cfg(unix)]
mod common;

use common::*;
use intely_agent_core::api::{AgentStartRequest, PermissionDecision};
use intely_agent_core::events::types::EventKind;

fn start(host: &intely_agent_host::AgentHost, role: &str, repo: &intely_agent_host::RepoRef) -> String {
    host.start(AgentStartRequest { role: role.into(), repo_ids: vec![repo.id.clone()], prompt: "go".into(), mode: None, mcp_servers: None, ..Default::default() }, std::slice::from_ref(repo)).expect("start").agent_id
}

fn read(repo: &intely_agent_host::RepoRef, rel: &str) -> String {
    std::fs::read_to_string(repo.path.join(rel)).unwrap()
}

/// Waits (a few seconds at most) until the timeline has `n` steps: the checkpoint after a turn is written off the event thread.
fn wait_steps(host: &intely_agent_host::AgentHost, id: &str, n: usize) -> Vec<intely_agent_host::RunCheckpoint> {
    for _ in 0..100 {
        let list = host.checkpoints(id).unwrap();
        if list.len() >= n {
            return list;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    panic!("the timeline of {id} never reached {n} steps: {:?}", host.checkpoints(id).unwrap());
}

#[test]
fn a_step_per_prompt_a_save_point_and_a_restore_that_keeps_later_edits() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let (host, sink) = host_with(config(&dir.path().join("data"), sidecar_js()));
    let id = start(&host, "mock-plain-reply", &repo);
    sink.wait_turn_end(&id);
    // the mock changes nothing: the timeline is the snapshot alone
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert_eq!(host.checkpoints(&id).unwrap().iter().map(|c| c.kind.as_str()).collect::<Vec<_>>(), ["start"]);

    // between the turns the files change; the next prompt takes a checkpoint first
    std::fs::write(repo.path.join("a.txt"), "step one\n").unwrap();
    let last = sink.of(&id).last().unwrap().seq;
    host.send(&id, "again").expect("send");
    sink.wait(&id, "second turn end", 20, |e| e.seq > last && matches!(e.kind, EventKind::TurnEnd { .. }));
    let steps = wait_steps(&host, &id, 2);
    assert_eq!((steps[1].seq, steps[1].kind.as_str(), steps[1].changed), (1, "turn", 1));
    assert_eq!(steps[1].repos[0].repo_id, repo.id);

    let save = host.save_point(&id, "before the risky part").unwrap();
    assert_eq!(save, 2);
    let steps = host.checkpoints(&id).unwrap();
    assert_eq!(steps.last().unwrap().label.as_deref(), Some("before the risky part"));

    // the person edits a.txt again and adds a file: going back to the start keeps both
    std::fs::write(repo.path.join("a.txt"), "my own edit\n").unwrap();
    std::fs::write(repo.path.join("mine.txt"), "mine\n").unwrap();
    let plan = host.checkpoint_plan(&id, 0).unwrap();
    assert_eq!(plan[0].plan.conflicts, ["a.txt", "mine.txt"]);
    let refused = host.checkpoint_restore(&id, 0, false, false).unwrap_err();
    assert_eq!(refused.code, "confirmRequired");
    let done = host.checkpoint_restore(&id, 0, true, false).unwrap();
    assert_eq!(done[0].report.kept, ["a.txt", "mine.txt"]);
    assert_eq!(read(&repo, "a.txt"), "my own edit\n", "a later edit is never overwritten without the explicit choice");
    // the restore is undoable: the state right before it is a step of its own
    let steps = host.checkpoints(&id).unwrap();
    assert!(steps.iter().any(|c| c.kind == "restore" && c.label.as_deref() == Some("before restoring step 0")), "{steps:?}");

    // with the explicit choice the start comes back exactly
    host.checkpoint_restore(&id, 0, true, true).unwrap();
    assert_eq!(read(&repo, "a.txt"), "one\n");
    assert!(!repo.path.join("mine.txt").exists());
    // and the step before the restore brings the edits back
    let before = host.checkpoints(&id).unwrap().into_iter().rev().find(|c| c.label.as_deref() == Some("before restoring step 0")).unwrap();
    host.checkpoint_restore(&id, before.seq, true, true).unwrap();
    assert_eq!(read(&repo, "a.txt"), "my own edit\n");

    let diff = host.checkpoint_compare(&id, &repo.id, 0, Some(1)).unwrap();
    assert_eq!(diff.iter().map(|f| (f.path.as_str(), f.change.as_str())).collect::<Vec<_>>(), [("a.txt", "modified")]);
    assert!(host.checkpoint_patch(&id, &repo.id, 0, Some(1), "a.txt").unwrap().contains("+step one"));
    assert_eq!(host.checkpoint_compare(&id, "other", 0, None).unwrap_err().code, "unknownRepo");
    host.delete_checkpoints(&id).unwrap();
    assert_eq!(host.checkpoints(&id).unwrap().len(), 1, "the Rewind snapshot stays");
    host.shutdown();
}

#[test]
fn no_restore_while_the_run_or_another_run_in_the_repository_works() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let mut cfg = config(&dir.path().join("data"), sidecar_js());
    cfg.gate.writers_per_repo = 2;
    let (host, sink) = host_with(cfg);
    let first = start(&host, "mock-plain-reply", &repo);
    sink.wait_turn_end(&first);
    std::fs::write(repo.path.join("a.txt"), "first\n").unwrap();
    host.save_point(&first, "mine").unwrap();

    let second = start(&host, "mock-tool-permission", &repo);
    let req = sink.wait_kind(&second, "permission.request");
    let EventKind::PermissionRequest { req_id, .. } = &req.kind else { unreachable!() };
    assert_eq!(host.checkpoint_restore(&second, 0, true, true).unwrap_err().code, "agentRunning");
    let busy = host.checkpoint_restore(&first, 0, true, true).unwrap_err();
    assert_eq!(busy.code, "repoBusy", "{}", busy.message);
    assert_eq!(read(&repo, "a.txt"), "first\n");
    host.answer_permission(&second, req_id, PermissionDecision::Deny).unwrap();
    sink.wait_turn_end(&second);
    host.checkpoint_restore(&first, 0, true, true).expect("fine once nobody works there");
    assert_eq!(read(&repo, "a.txt"), "one\n");
    host.shutdown();
}

#[test]
fn the_config_protection_is_off_by_default_persisted_and_copies_outside_the_repo() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    std::fs::write(repo.path.join(".gitignore"), ".env.local\n").unwrap();
    std::fs::write(repo.path.join(".env.local"), "TOKEN=abc\n").unwrap();
    let data = dir.path().join("data");
    let (host, sink) = host_with(config(&data, sidecar_js()));
    let s = host.checkpoint_settings();
    assert!(!s.protect_config, "off by default");
    assert!(s.names.contains(&".env.local".to_string()));
    let id = start(&host, "mock-plain-reply", &repo);
    sink.wait_turn_end(&id);
    let seq = host.save_point(&id, "no copy").unwrap();
    assert!(host.checkpoint_config(&id, seq).unwrap().is_empty(), "nothing is copied while the switch is off");

    assert!(host.set_protect_config(true).unwrap().protect_config);
    let seq = host.save_point(&id, "with copy").unwrap();
    let copies = host.checkpoint_config(&id, seq).unwrap();
    assert_eq!(copies.iter().map(|c| (c.path.as_str(), c.state.as_str())).collect::<Vec<_>>(), [(".env.local", "same")]);
    assert!(data.join("checkpoint-files").is_dir());
    std::fs::write(repo.path.join(".env.local"), "TOKEN=broken\n").unwrap();
    assert_eq!(host.restore_checkpoint_config(&id, seq, &repo.id, &[".env.local".into()], false).unwrap_err().code, "confirmRequired");
    host.restore_checkpoint_config(&id, seq, &repo.id, &[".env.local".into()], true).unwrap();
    assert_eq!(read(&repo, ".env.local"), "TOKEN=abc\n");
    host.shutdown();

    // the switch survives a restart; switching it off forgets the copies
    let (again, _) = host_with(config(&data, sidecar_js()));
    assert!(again.checkpoint_settings().protect_config);
    again.set_protect_config(false).unwrap();
    assert!(again.checkpoint_config(&id, seq).unwrap().is_empty());
    again.shutdown();
}
