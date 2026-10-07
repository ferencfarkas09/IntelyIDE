//! Leases, admission, expiry, owner death, tree RSS and the idle reaper, against real child processes.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{spawn_owner, wait_until, Group};
use intely_agent_gate::gate::reaper::{self, Reaper, ReaperConfig};
use intely_agent_gate::gate::{procinfo, rss};
use intely_agent_gate::{AcquireReq, AdmissionKind, Gate, GateConfig, ReclaimReason};

fn req(agent: &str, provider: &str, writer: bool, repo: Option<&str>) -> AcquireReq {
    AcquireReq {
        agent_id: agent.into(),
        provider: provider.into(),
        writer,
        repo_id: repo.map(Into::into),
        owner: "sidecar-1".into(),
        ttl_ms: None,
        rss_budget_mb: 0,
    }
}

fn fast_cfg() -> GateConfig {
    GateConfig { term_grace: Duration::from_millis(500), ..GateConfig::default() }
}

#[test]
fn caps_agents_providers_and_writers() {
    let gate = Gate::new(GateConfig { max_agents: 4, max_per_provider: vec![("claude".into(), 2)], max_writers: 2, ..GateConfig::default() });
    gate.acquire(req("a1", "claude", false, None)).unwrap();
    gate.acquire(req("a2", "claude", false, None)).unwrap();
    let e = gate.acquire(req("a3", "claude", false, None)).unwrap_err();
    assert_eq!(e.kind, AdmissionKind::NoSlot, "{e}");
    assert!(e.detail.contains("claude"), "{}", e.detail);
    gate.acquire(req("g1", "gemini", false, None)).unwrap();
    gate.acquire(req("g2", "gemini", false, None)).unwrap();
    assert_eq!(gate.acquire(req("g3", "gemini", false, None)).unwrap_err().kind, AdmissionKind::NoSlot, "global cap");
    assert_eq!(gate.live_count(), 4);

    let gate = Gate::new(GateConfig::default());
    let w1 = gate.acquire(req("w1", "claude", true, Some("admin"))).unwrap();
    gate.acquire(req("w2", "claude", true, Some("backend"))).unwrap();
    // 2 writers is the cap; the third is a slot problem on another repo, a write-lease problem on the same repo.
    let e = gate.acquire(req("w3", "claude", true, Some("app"))).unwrap_err();
    assert_eq!(e.kind, AdmissionKind::NoSlot, "{e}");
    let e = gate.acquire(req("w4", "claude", true, Some("admin"))).unwrap_err();
    assert_eq!(e.kind, AdmissionKind::WriteLease, "{e}");
    assert!(e.detail.contains("w1"), "{}", e.detail);
    // readers do not need a write lease
    gate.release(&w1.lease_id);
    gate.acquire(req("r1", "claude", false, Some("admin"))).unwrap();
    gate.acquire(req("w5", "claude", true, Some("admin"))).expect("a reader does not hold the write lease");
}

#[test]
fn one_write_lease_per_repo_and_writer_needs_a_repo() {
    let gate = Gate::new(GateConfig::default());
    gate.acquire(req("w1", "claude", true, Some("admin"))).unwrap();
    assert_eq!(gate.acquire(req("w2", "gemini", true, Some("admin"))).unwrap_err().kind, AdmissionKind::WriteLease);
    assert_eq!(gate.acquire(req("w3", "claude", true, None)).unwrap_err().kind, AdmissionKind::WriteLease);
    assert_eq!(gate.acquire(req("w1", "claude", false, None)).unwrap_err().kind, AdmissionKind::NoSlot, "same agent twice");
}

#[test]
fn set_writer_flips_a_live_lease_with_the_admission_rules_of_acquire() {
    let gate = Gate::new(GateConfig::default());
    let a = gate.acquire(req("a", "claude", false, Some("admin"))).unwrap();
    let flag = |id: &str| gate.leases().into_iter().find(|l| l.agent_id == id).map(|l| l.writer);
    assert_eq!(flag("a"), Some(false));
    // a free slot: the lease becomes a writer and LeaseInfo follows; asking again is a no-op
    gate.set_writer(&a.lease_id, true, Some("admin")).unwrap();
    assert_eq!(flag("a"), Some(true));
    gate.set_writer(&a.lease_id, true, Some("admin")).unwrap();
    // one writer per repository: another lease on the same repo is refused and keeps its flag
    let b = gate.acquire(req("b", "claude", false, Some("admin"))).unwrap();
    let e = gate.set_writer(&b.lease_id, true, Some("admin")).unwrap_err();
    assert_eq!(e.kind, AdmissionKind::WriteLease, "{e}");
    assert!(e.detail.contains("a"), "{}", e.detail);
    assert_eq!(flag("b"), Some(false));
    // the writer cap counts the other leases only
    let c = gate.acquire(req("c", "claude", true, Some("backend"))).unwrap();
    let d = gate.acquire(req("d", "claude", false, Some("app"))).unwrap_err();
    assert_eq!(d.kind, AdmissionKind::NoSlot, "three agents is the cap");
    let e = gate.set_writer(&b.lease_id, true, Some("app")).unwrap_err();
    assert_eq!(e.kind, AdmissionKind::NoSlot, "two writers is the cap: {e}");
    // a downgrade always succeeds and frees the slot and the repository for the next one
    gate.set_writer(&a.lease_id, false, None).unwrap();
    assert_eq!(flag("a"), Some(false));
    gate.set_writer(&b.lease_id, true, Some("admin")).unwrap();
    assert_eq!(flag("b"), Some(true));
    // a lease without a repository cannot become a writer, and an unknown lease is refused
    gate.release(&c.lease_id);
    let n = gate.acquire(req("n", "claude", false, None)).unwrap();
    assert_eq!(gate.set_writer(&n.lease_id, true, None).unwrap_err().kind, AdmissionKind::WriteLease);
    assert_eq!(gate.set_writer("L-nope", true, Some("x")).unwrap_err().kind, AdmissionKind::NoSlot);
    assert_eq!(flag("n"), Some(false), "nothing changed on an error");
}

#[test]
fn admission_errors_serialize_like_the_wire_format() {
    let gate = Gate::new(GateConfig { max_agents: 1, ..GateConfig::default() });
    gate.acquire(req("a1", "claude", false, None)).unwrap();
    let e = gate.acquire(req("a2", "claude", false, None)).unwrap_err();
    let json = serde_json::to_value(&e).unwrap();
    assert_eq!(json["error"], "noSlot");
    assert!(json["detail"].as_str().unwrap().contains("cap"));
    for (kind, name) in [(AdmissionKind::RssBudget, "rssBudget"), (AdmissionKind::WriteLease, "writeLease")] {
        assert_eq!(serde_json::to_value(kind).unwrap(), name);
    }
}

#[test]
fn rss_budget_blocks_a_start_and_a_release_frees_it() {
    let gate = Gate::new(GateConfig { rss_budget_bytes: 100 * 1024 * 1024, ..GateConfig::default() });
    let mut first = req("a1", "claude", false, None);
    first.rss_budget_mb = 80;
    let lease = gate.acquire(first).unwrap();
    let mut second = req("a2", "claude", false, None);
    second.rss_budget_mb = 80;
    let e = gate.acquire(second.clone()).unwrap_err();
    assert_eq!(e.kind, AdmissionKind::RssBudget, "{e}");
    assert!(e.detail.contains("80 MB"), "{}", e.detail);
    assert!(gate.release(&lease.lease_id));
    assert!(!gate.release(&lease.lease_id), "double release is a no-op");
    gate.acquire(second).unwrap();
}

#[test]
fn a_running_tree_counts_by_measured_rss_not_by_its_reservation() {
    let gate = Gate::new(GateConfig { rss_budget_bytes: 100 * 1024 * 1024, ..GateConfig::default() });
    let mut first = req("a1", "claude", false, None);
    first.rss_budget_mb = 90; // reserved while no process is registered
    let lease = gate.acquire(first).unwrap();
    let group = Group::sleeper();
    gate.renew(&lease.lease_id, &[group.pgid()]).unwrap();
    // a sleeping `sh` uses a few MB, far below the 90 MB reservation
    let mut second = req("a2", "claude", false, None);
    second.rss_budget_mb = 60;
    gate.acquire(second).expect("measured RSS replaces the reservation once a process is registered");
}

#[test]
fn renew_registers_groups_and_rejects_unsafe_ones() {
    let gate = Gate::new(GateConfig::default());
    let lease = gate.acquire(req("a1", "claude", false, None)).unwrap();
    let own = unsafe { libc::getpgrp() };
    let group = Group::sleeper();
    let ok = gate.renew(&lease.lease_id, &[group.pgid(), 0, 1, own]).unwrap();
    assert_eq!(ok.rejected_pgids, vec![0, 1, own]);
    assert_eq!(gate.lease_pgids(&lease.lease_id), vec![group.pgid()]);
    assert!(gate.renew("L999", &[]).is_err());
}

#[test]
fn an_expired_lease_is_reclaimed_and_its_groups_are_killed() {
    let gate = Gate::new(fast_cfg());
    let seen = Arc::new(AtomicUsize::new(0));
    let counter = seen.clone();
    gate.on_reclaim(move |r| {
        assert_eq!(r.reason, ReclaimReason::Expired);
        counter.fetch_add(1, Ordering::SeqCst);
    });
    let mut r = req("a1", "claude", true, Some("admin"));
    r.ttl_ms = Some(300);
    let lease = gate.acquire(r).unwrap();
    let mut group = Group::with_grandchildren();
    gate.renew(&lease.lease_id, &[group.pgid()]).unwrap();
    assert!(group.alive());

    assert!(gate.sweep().is_empty(), "not expired yet");
    std::thread::sleep(Duration::from_millis(350));
    let reclaimed = gate.sweep();
    assert_eq!(reclaimed.len(), 1);
    assert_eq!(reclaimed[0].pgids, vec![group.pgid()]);
    assert_eq!(seen.load(Ordering::SeqCst), 1);
    assert_eq!(gate.live_count(), 0, "slot and write lease are free again");
    gate.acquire(req("a2", "claude", true, Some("admin"))).expect("write lease free after reclaim");
    assert!(group.gone_within(Duration::from_secs(3)), "leader and both grandchildren must be gone");
    assert!(gate.join_kills());
}

#[test]
fn heartbeats_keep_a_lease_alive_and_silence_loses_it() {
    let gate = Gate::new(fast_cfg());
    let _reaper = Reaper::spawn(gate.clone(), ReaperConfig { interval: Duration::from_millis(50), idle: reaper::DEFAULT_IDLE });
    let mut r = req("a1", "claude", false, None);
    r.ttl_ms = Some(400);
    let lease = gate.acquire(r).unwrap();
    let mut group = Group::sleeper();
    gate.renew(&lease.lease_id, &[group.pgid()]).unwrap();

    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_millis(1500) {
        assert_eq!(gate.heartbeat("sidecar-1"), 1);
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(gate.has_lease(&lease.lease_id), "heartbeats renew implicitly");
    assert!(group.alive());

    assert!(wait_until(Duration::from_secs(3), || !gate.has_lease(&lease.lease_id)), "silence for one TTL reclaims");
    assert!(group.gone_within(Duration::from_secs(3)));
}

#[test]
fn sigkill_of_the_owner_frees_slots_and_kills_groups_within_one_ttl() {
    let gate = Gate::new(fast_cfg());
    let _reaper = Reaper::spawn(gate.clone(), ReaperConfig { interval: Duration::from_millis(50), idle: reaper::DEFAULT_IDLE });
    let mut owner = spawn_owner();
    gate.register_owner("sidecar-1", Some(owner.id() as i32));
    let mut r = req("a1", "claude", true, Some("admin"));
    r.ttl_ms = Some(15_000);
    let lease = gate.acquire(r).unwrap();
    let mut group = Group::with_grandchildren();
    gate.renew(&lease.lease_id, &[group.pgid()]).unwrap();
    gate.heartbeat("sidecar-1");

    let killed_at = Instant::now();
    unsafe { libc::kill(owner.id() as i32, libc::SIGKILL) };
    let _ = owner.wait();
    assert!(wait_until(Duration::from_secs(5), || gate.live_count() == 0), "lease must be reclaimed");
    assert!(group.gone_within(Duration::from_secs(5)), "the agent's groups must be gone");
    assert!(killed_at.elapsed() < Duration::from_secs(15), "well inside one TTL, not after it");
    gate.acquire(req("a2", "claude", true, Some("admin"))).expect("write lease freed");
}

#[test]
fn a_closed_owner_pipe_reclaims_immediately() {
    let gate = Gate::new(fast_cfg());
    let a = gate.acquire(req("a1", "claude", false, None)).unwrap();
    let mut other = req("a2", "claude", false, None);
    other.owner = "sidecar-2".into();
    let b = gate.acquire(other).unwrap();
    let mut group = Group::sleeper();
    gate.renew(&a.lease_id, &[group.pgid()]).unwrap();
    let out = gate.owner_closed("sidecar-1");
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].reason, ReclaimReason::OwnerClosed);
    assert!(gate.has_lease(&b.lease_id), "other owners are untouched");
    assert!(group.gone_within(Duration::from_secs(3)));
}

#[test]
fn a_group_that_ignores_sigterm_gets_sigkill_after_the_grace() {
    let gate = Gate::new(GateConfig { term_grace: Duration::from_millis(700), ..GateConfig::default() });
    let lease = gate.acquire(req("a1", "claude", false, None)).unwrap();
    let mut group = Group::stubborn();
    gate.renew(&lease.lease_id, &[group.pgid()]).unwrap();
    assert!(wait_until(Duration::from_secs(2), || procinfo::live_group_pids(group.pgid()).len() == 3));
    // let the shell install its trap before the first signal
    std::thread::sleep(Duration::from_millis(200));

    let t0 = Instant::now();
    gate.reclaim(&lease.lease_id, ReclaimReason::Cancelled).unwrap();
    std::thread::sleep(Duration::from_millis(400));
    assert!(group.alive(), "SIGTERM alone does not end it");
    assert!(group.gone_within(Duration::from_secs(3)), "SIGKILL after the grace");
    assert!(t0.elapsed() >= Duration::from_millis(700), "not before the grace elapsed: {:?}", t0.elapsed());
    assert!(gate.join_kills());
}

#[test]
fn gate_never_signals_its_own_process_group_or_pid_1() {
    use intely_agent_gate::gate::cancel::{terminate_group, TermOutcome};
    assert_eq!(terminate_group(unsafe { libc::getpgrp() }, Duration::from_millis(10)), TermOutcome::Refused);
    assert_eq!(terminate_group(1, Duration::from_millis(10)), TermOutcome::Refused);
    assert_eq!(terminate_group(0, Duration::from_millis(10)), TermOutcome::Refused);
    assert_eq!(terminate_group(-5, Duration::from_millis(10)), TermOutcome::Refused);
}

#[test]
fn idle_leases_are_reaped_but_busy_ones_are_not() {
    let gate = Gate::new(fast_cfg());
    let idle = gate.acquire(req("idle", "claude", false, None)).unwrap();
    let busy = gate.acquire(req("busy", "claude", false, None)).unwrap();
    let mut idle_group = Group::sleeper();
    let busy_group = Group::sleeper();
    gate.renew(&idle.lease_id, &[idle_group.pgid()]).unwrap();
    gate.renew(&busy.lease_id, &[busy_group.pgid()]).unwrap();
    gate.set_busy(&busy.lease_id, true);
    std::thread::sleep(Duration::from_millis(250));
    gate.touch(&idle.lease_id); // activity resets the clock
    assert!(reaper::reap_idle(&gate, Duration::from_millis(200)).is_empty());
    std::thread::sleep(Duration::from_millis(250));

    let reaped = reaper::reap_idle(&gate, Duration::from_millis(200));
    assert_eq!(reaped.len(), 1);
    assert_eq!(reaped[0].agent_id, "idle");
    assert_eq!(reaped[0].reason, ReclaimReason::Idle);
    assert!(idle_group.gone_within(Duration::from_secs(3)));
    assert!(busy_group.alive(), "a running turn is never idle");
    assert!(gate.has_lease(&busy.lease_id));
}

/// Parent shell with a memory-holding child in another process group (like a sandbox shell or MCP server).
const HOLDER: &str = r#"perl -e 'use POSIX; if (fork() == 0) { setpgrp(0, 0); $n = 60000000; $x = "a" x $n; sleep 300; exit } sleep 300'"#;

#[test]
fn tree_rss_includes_a_spawned_child_even_in_another_process_group() {
    let group = Group::sh(HOLDER);
    let root = group.pgid();
    assert!(wait_until(Duration::from_secs(15), || rss::tree_rss(&[root], &[root]).bytes >= 55 * 1024 * 1024), "child memory must show up in the tree");

    let alone = procinfo::rss_bytes(root).expect("parent rss");
    let tree = rss::tree_rss(&[root], &[root]);
    assert!(tree.procs >= 2, "{tree:?}");
    assert!(tree.bytes >= alone + 50 * 1024 * 1024, "tree {} vs parent {}", tree.bytes, alone);
    // by group alone the child (own pgid) is missed; by ppid walk it is found
    let by_group = rss::tree_rss(&[], &[root]);
    assert!(by_group.bytes < 50 * 1024 * 1024, "{by_group:?}");
    assert!(rss::tree_rss(&[root], &[]).bytes >= 50 * 1024 * 1024);

    // the gate reports the same through its lease view
    let gate = Gate::new(GateConfig::default());
    let lease = gate.acquire(req("a1", "claude", false, None)).unwrap();
    gate.renew(&lease.lease_id, &[root]).unwrap();
    let info = gate.leases();
    assert!(info[0].tree_rss_mb >= 50, "{info:?}");
    assert!(gate.total_tree_rss().bytes >= 50 * 1024 * 1024);
}

#[test]
fn procinfo_sees_children_groups_and_zombies() {
    let mut group = Group::with_grandchildren();
    let pgid = group.pgid();
    assert!(wait_until(Duration::from_secs(2), || procinfo::group_pids(pgid).len() == 3));
    assert!(wait_until(Duration::from_secs(2), || procinfo::child_pids(pgid).len() == 2));
    assert_eq!(procinfo::pgid_of(pgid), Some(pgid));
    assert_eq!(procinfo::parent_of(pgid), Some(std::process::id() as i32));
    assert_eq!(rss::descendants(pgid).len(), 3);
    assert!(rss::tree_pids(&[pgid], &[pgid]).len() == 3, "union does not double count");

    let key = procinfo::ProcKey::of(pgid).unwrap();
    assert!(key.is_alive());
    unsafe { libc::killpg(pgid, libc::SIGKILL) };
    assert!(wait_until(Duration::from_secs(3), || !key.is_alive()), "a killed (zombie) leader counts as gone");
    let _ = group.child.wait();
    assert!(!procinfo::is_alive(i32::MAX));
    assert_eq!(procinfo::rss_bytes(i32::MAX), None);
}

#[test]
fn spawn_noise_is_cleaned_up() {
    // guards the helper itself: Group::drop kills grandchildren too
    let pgid = {
        let g = Group::with_grandchildren();
        assert!(wait_until(Duration::from_secs(2), || procinfo::group_pids(g.pgid()).len() == 3));
        g.pgid()
    };
    assert!(wait_until(Duration::from_secs(3), || procinfo::live_group_pids(pgid).is_empty()));
}
