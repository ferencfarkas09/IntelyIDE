//! Orphan protection: the startup sweep kills groups of dead IDE instances and nothing else.

mod common;

use std::time::Duration;

use common::{spawn_owner, Group};
use intely_agent_gate::gate::procinfo::ProcKey;
use intely_agent_gate::{Gate, GateConfig, OrphanRegistry};

/// An owner identity that is verifiably dead: a real process that was started, recorded and SIGKILLed.
fn dead_owner() -> ProcKey {
    let mut owner = spawn_owner();
    let key = ProcKey::of(owner.id() as i32).unwrap();
    unsafe { libc::kill(owner.id() as i32, libc::SIGKILL) };
    let _ = owner.wait();
    assert!(!key.is_alive());
    key
}

fn state_path(dir: &tempfile::TempDir) -> std::path::PathBuf {
    dir.path().join("state").join("gate.json")
}

#[test]
fn startup_sweep_kills_the_groups_of_a_dead_ide_instance() {
    let dir = tempfile::tempdir().unwrap();
    let path = state_path(&dir);
    let mut orphan = Group::with_grandchildren();
    let mut bystander = Group::sleeper(); // not recorded: a foreign process of the same user

    // the previous IDE instance recorded the group and then died
    OrphanRegistry::open_as(&path, dead_owner()).unwrap().record(orphan.pgid(), "L1", "a1").unwrap();
    assert!(orphan.alive());

    // the next start sweeps
    let report = OrphanRegistry::open(&path).unwrap().sweep().unwrap();
    assert_eq!(report.killed, vec![orphan.pgid()], "{report:?}");
    assert!(report.live_owner.is_empty() && report.foreign.is_empty());
    assert!(orphan.gone_within(Duration::from_secs(5)), "leader and grandchildren are gone");
    assert!(bystander.alive(), "never touches processes it did not record");

    // the entry is gone from the file: a second sweep has nothing to do
    let again = OrphanRegistry::open(&path).unwrap().sweep().unwrap();
    assert!(again.killed.is_empty() && again.stale.is_empty());
    assert!(!bystander.gone_within(Duration::from_millis(100)));
}

#[test]
fn a_live_ide_instance_keeps_its_groups() {
    let dir = tempfile::tempdir().unwrap();
    let path = state_path(&dir);
    let group = Group::sleeper();
    let me = OrphanRegistry::open(&path).unwrap();
    me.record(group.pgid(), "L1", "a1").unwrap();

    // a second IDE instance starting up must not touch the first one's agents
    let report = OrphanRegistry::open_as(&path, ProcKey::current()).unwrap().sweep().unwrap();
    assert_eq!(report.live_owner, vec![group.pgid()]);
    assert!(report.killed.is_empty());
    assert!(group.alive());
    assert_eq!(me.recorded().unwrap(), vec![group.pgid()], "entry kept");
}

#[test]
fn a_reused_pid_or_a_foreign_member_is_not_ours() {
    let dir = tempfile::tempdir().unwrap();
    let path = state_path(&dir);
    let mut reused = Group::sleeper();
    // leader exits at once, its background sleeper keeps the group alive
    let mut foreign_member = Group::sh("sleep 300 &");
    let mut leaderless = Group::sh("sleep 300 &");
    assert!(common::wait_until(Duration::from_secs(2), || foreign_member.child.try_wait().unwrap().is_some() && leaderless.child.try_wait().unwrap().is_some()));
    let reg = OrphanRegistry::open_as(&path, dead_owner()).unwrap();
    for (g, id) in [(&reused, "L1"), (&foreign_member, "L2"), (&leaderless, "L3")] {
        reg.record(g.pgid(), id, id).unwrap();
    }
    // L1: as if the recorded leader pid had since been reused (recorded start time differs from the live one)
    // L2: as if one member were older than the recorded leader, so it cannot belong to the group
    let mut json: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    for e in json["entries"].as_array_mut().unwrap() {
        match e["leaseId"].as_str().unwrap() {
            "L1" => e["leaderStart"] = (e["leaderStart"].as_u64().unwrap() - 3600).into(),
            "L2" => e["leaderStart"] = (e["recordedAt"].as_u64().unwrap() + 3600).into(),
            _ => {} // L3: the leader was reaped before recording, so no start time is known
        }
    }
    std::fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();

    let report = OrphanRegistry::open(&path).unwrap().sweep().unwrap();
    assert!(report.foreign.contains(&reused.pgid()) && report.foreign.contains(&foreign_member.pgid()), "{report:?}");
    assert!(reused.alive() && foreign_member.alive(), "left alone");
    assert_eq!(report.killed, vec![leaderless.pgid()], "a genuine group whose leader already exited is still swept");
    assert!(leaderless.gone_within(Duration::from_secs(5)));
    let _ = reused.child.try_wait();
}

#[test]
fn an_empty_group_is_stale_and_unusable_pgids_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = state_path(&dir);
    let reg = OrphanRegistry::open_as(&path, dead_owner()).unwrap();
    assert!(reg.record(0, "L", "a").is_err());
    assert!(reg.record(1, "L", "a").is_err());
    assert!(reg.record(unsafe { libc::getpgrp() }, "L", "a").is_err(), "never track our own group");

    let mut g = Group::sleeper();
    reg.record(g.pgid(), "L1", "a1").unwrap();
    unsafe { libc::killpg(g.pgid(), libc::SIGKILL) };
    assert!(g.gone_within(Duration::from_secs(3)));
    let report = OrphanRegistry::open(&path).unwrap().sweep().unwrap();
    assert_eq!(report.stale, vec![g.pgid()]);
    assert!(report.killed.is_empty());
}

#[test]
fn record_and_forget_round_trip_and_survive_garbage() {
    let dir = tempfile::tempdir().unwrap();
    let path = state_path(&dir);
    let reg = OrphanRegistry::open(&path).unwrap();
    let (a, b) = (Group::sleeper(), Group::sleeper());
    reg.record(a.pgid(), "L1", "a1").unwrap();
    reg.record(b.pgid(), "L2", "a2").unwrap();
    reg.record(a.pgid(), "L1", "a1").unwrap(); // idempotent
    assert_eq!(reg.recorded().unwrap().len(), 2);
    reg.forget(a.pgid()).unwrap();
    assert_eq!(reg.recorded().unwrap(), vec![b.pgid()]);

    std::fs::write(&path, b"not json {").unwrap();
    assert!(reg.recorded().unwrap().is_empty(), "a corrupt state file reads as empty instead of failing the IDE");
    reg.record(a.pgid(), "L3", "a1").unwrap();
    assert_eq!(reg.recorded().unwrap(), vec![a.pgid()]);
}

#[test]
fn the_gate_records_registered_groups_and_forgets_them_on_release() {
    let dir = tempfile::tempdir().unwrap();
    let path = state_path(&dir);
    let reg = std::sync::Arc::new(OrphanRegistry::open(&path).unwrap());
    let gate = Gate::with_orphans(GateConfig::default(), reg.clone());
    let lease = gate
        .acquire(intely_agent_gate::AcquireReq {
            agent_id: "a1".into(),
            provider: "claude".into(),
            writer: false,
            repo_id: None,
            owner: "s".into(),
            ttl_ms: None,
            rss_budget_mb: 0,
        })
        .unwrap();
    let group = Group::sleeper();
    gate.renew(&lease.lease_id, &[group.pgid()]).unwrap();
    assert_eq!(reg.recorded().unwrap(), vec![group.pgid()]);
    gate.release(&lease.lease_id);
    assert!(reg.recorded().unwrap().is_empty());
}
