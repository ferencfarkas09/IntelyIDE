//! Zero cost when off: with Remote off there is no thread, socket, task, timer or bus subscriber. This file holds exactly one test
//! so that no other test of the process disturbs the thread count.

mod common;

use std::net::TcpListener;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use intely_agent_core::hub::AgentHub;
use intely_remote::slot::{RemoteSlot, SlotConfig};
use intely_settings::{MemorySecretStore, SecretStore};

fn threads() -> usize {
    let out = Command::new("ps").args(["-M", "-p", &std::process::id().to_string()]).output().expect("ps");
    String::from_utf8_lossy(&out.stdout).lines().count().saturating_sub(1)
}

/// Established or listening sockets of this process towards `port` (empty when lsof is unavailable).
fn sockets_to(port: u16) -> Option<usize> {
    let out = Command::new("lsof").args(["-nP", "-a", "-p", &std::process::id().to_string(), "-i"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    Some(text.lines().filter(|l| l.contains(&format!("->127.0.0.1:{port}"))).count())
}

fn settle(mut f: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[test]
fn off_means_no_thread_socket_task_or_subscriber() {
    // a spy standing in for the relay: counts TCP connections, never answers
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let accepts = Arc::new(AtomicUsize::new(0));
    let a2 = accepts.clone();
    std::thread::spawn(move || {
        let mut held = Vec::new();
        for s in listener.incoming().flatten() {
            a2.fetch_add(1, Ordering::SeqCst);
            held.push(s);
        }
    });
    std::thread::sleep(Duration::from_millis(200));

    let dir = tempfile::tempdir().unwrap();
    let hub = FakeHub::new(dir.path(), intely_remote::util::ManualClock::new(T0));
    let secrets: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::new());
    let baseline = threads();
    let slot = RemoteSlot::new(hub.clone(), secrets, SlotConfig { state_dir: dir.path().join("state"), gateway: cfg(), relay_url: format!("ws://127.0.0.1:{port}"), expected_bundle_hash: None, trust: Default::default(), bundle: None, relay_mode: String::new() }, Arc::new(|_| {}));

    // OFF: constructing the slot, reading its settings and publishing agent events start nothing
    let _ = slot.settings_view();
    for i in 0..50 {
        hub.text(&format!("event {i}"));
    }
    std::thread::sleep(Duration::from_millis(1200));
    assert!(!slot.is_on());
    assert_eq!(threads(), baseline, "no thread while off");
    assert_eq!(hub.bus().receiver_count(), 0, "no bus subscriber while off");
    assert_eq!(accepts.load(Ordering::SeqCst), 0, "the relay spy saw 0 connections while off");
    if let Some(n) = sockets_to(port) {
        assert_eq!(n, 0, "lsof: no relay socket while off");
    }

    // ON: exactly one extra thread, one subscriber, a connection attempt
    slot.enable().unwrap();
    assert!(settle(|| hub.bus().receiver_count() == 1), "one subscriber while on");
    assert!(settle(|| accepts.load(Ordering::SeqCst) >= 1), "the gateway dials out");
    assert_eq!(threads(), baseline + 1, "exactly one gateway thread");

    // OFF again: everything is gone
    slot.disable();
    assert!(settle(|| threads() == baseline), "thread count back to baseline, now {} vs {baseline}", threads());
    assert_eq!(hub.bus().receiver_count(), 0);
    let seen = accepts.load(Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(accepts.load(Ordering::SeqCst), seen, "no reconnect attempts after switching off");
    if let Some(n) = sockets_to(port) {
        assert_eq!(n, 0, "lsof: the relay socket is closed after switching off");
    }
}
