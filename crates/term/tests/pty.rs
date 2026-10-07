//! Real shells on a real pty, always inside a temp directory.

use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

use intely_agent_gate::gate::procinfo::live_group_pids;
use intely_agent_gate::OrphanRegistry;
use intely_core::jail::{Jail, READ_ONLY, TEST_JAIL};
use intely_term::types::TermEvent;
use intely_term::{Opened, SpawnSpec, TermManager};

const WAIT: Duration = Duration::from_secs(10);

fn spec(cwd: &Path) -> SpawnSpec {
    SpawnSpec { cwd: cwd.to_path_buf(), cols: 80, rows: 24, env: HashMap::new(), shell: Some("/bin/sh".into()) }
}

fn open(m: &TermManager, cwd: &Path) -> (Opened, Receiver<TermEvent>) {
    let (tx, rx) = channel();
    let opened = m.open(spec(cwd), Box::new(move |e| drop(tx.send(e)))).expect("open");
    (opened, rx)
}

/// Reads events until `done` accepts the output collected so far; returns the output and the number of data events.
fn read_until(rx: &Receiver<TermEvent>, done: impl Fn(&str) -> bool) -> (String, usize) {
    let (mut out, mut events) = (String::new(), 0);
    let end = Instant::now() + WAIT;
    while !done(&out) {
        let left = end.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(TermEvent::Data { data }) => {
                out.push_str(&data);
                events += 1;
            }
            Ok(TermEvent::Exit { .. }) => break,
            Err(_) => panic!("timed out; output so far: {out:?}"),
        }
    }
    (out, events)
}

fn manager() -> TermManager {
    TermManager::new(Arc::new(Jail::off()), None)
}

#[test]
fn typed_input_is_echoed_and_executed() {
    let dir = tempfile::tempdir().unwrap();
    let m = manager();
    let (t, rx) = open(&m, dir.path());
    m.write(&t.term_id, "echo hello-$((40+2))\r").unwrap();
    // The echoed command line reads `$((40+2))`; only the executed one prints `hello-42`.
    let (out, _) = read_until(&rx, |o| o.contains("hello-42"));
    assert!(out.contains("hello-42"));
    m.shutdown();
}

#[test]
fn the_shell_starts_in_the_requested_directory() {
    let dir = tempfile::tempdir().unwrap();
    let m = manager();
    let (t, rx) = open(&m, dir.path());
    m.write(&t.term_id, "pwd -P\r").unwrap();
    let want = dir.path().canonicalize().unwrap();
    let (out, _) = read_until(&rx, |o| o.lines().any(|l| l.trim_end() == want.to_str().unwrap()));
    assert!(out.contains(want.to_str().unwrap()));
    m.shutdown();
}

#[test]
fn resize_reaches_the_shell() {
    let dir = tempfile::tempdir().unwrap();
    let m = manager();
    let (t, rx) = open(&m, dir.path());
    m.write(&t.term_id, "stty size\r").unwrap();
    read_until(&rx, |o| o.contains("24 80"));
    m.resize(&t.term_id, 100, 30).unwrap();
    m.write(&t.term_id, "stty size\r").unwrap();
    read_until(&rx, |o| o.contains("30 100"));
    m.shutdown();
}

#[test]
fn closing_ends_the_shell_and_its_background_jobs_and_reports_the_exit() {
    let dir = tempfile::tempdir().unwrap();
    let m = manager();
    let (t, rx) = open(&m, dir.path());
    m.write(&t.term_id, "sleep 300 &\recho job:$!\r").unwrap();
    let pid_of = |o: &str| o.lines().find_map(|l| l.trim_end().strip_prefix("job:")?.parse::<i32>().ok());
    let (out, _) = read_until(&rx, |o| pid_of(o).is_some());
    let job = pid_of(&out).unwrap();
    assert!(alive(job) && alive(t.pid));
    m.close(&t.term_id);
    let end = Instant::now() + WAIT;
    while alive(job) || !live_group_pids(t.pid).is_empty() {
        if Instant::now() > end {
            let ps = std::process::Command::new("ps").args(["-o", "pid,ppid,pgid,stat,command", "-p", &format!("{},{job}", t.pid)]).output().unwrap();
            panic!("shell {} or its job {job} is still alive:\n{}", t.pid, String::from_utf8_lossy(&ps.stdout));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(matches!(wait_exit(&rx), TermEvent::Exit { .. }));
    assert!(m.write(&t.term_id, "x").is_err(), "a closed terminal is gone");
    m.close(&t.term_id);
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

fn wait_exit(rx: &Receiver<TermEvent>) -> TermEvent {
    let end = Instant::now() + WAIT;
    loop {
        match rx.recv_timeout(end.saturating_duration_since(Instant::now())).expect("exit event") {
            e @ TermEvent::Exit { .. } => return e,
            TermEvent::Data { .. } => {}
        }
    }
}

#[test]
fn a_shell_that_exits_reports_its_code_and_leaves_no_session() {
    let dir = tempfile::tempdir().unwrap();
    let m = manager();
    let (t, rx) = open(&m, dir.path());
    m.write(&t.term_id, "exit 3\r").unwrap();
    assert_eq!(wait_exit(&rx), TermEvent::Exit { code: Some(3) });
    let end = Instant::now() + WAIT;
    while !m.open_ids().is_empty() {
        assert!(Instant::now() < end, "session was not removed");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn heavy_output_is_coalesced_and_arrives_complete() {
    let dir = tempfile::tempdir().unwrap();
    let m = manager();
    let (t, rx) = open(&m, dir.path());
    m.write(&t.term_id, "i=1; while [ $i -le 20000 ]; do echo line-$i; i=$((i+1)); done; echo done-$((1+1))\r").unwrap();
    let (out, events) = read_until(&rx, |o| o.contains("done-2"));
    assert!(out.contains("line-20000"));
    assert!(events < 2000, "{events} events for 20000 lines is not batched");
    m.shutdown();
}

#[test]
fn non_ascii_output_survives_chunk_boundaries() {
    let dir = tempfile::tempdir().unwrap();
    let m = manager();
    let (t, rx) = open(&m, dir.path());
    // Octal escapes, so the test does not depend on how the shell's line editor treats multi-byte input.
    m.write(&t.term_id, "i=0; while [ $i -lt 3000 ]; do printf '\\303\\241rv\\303\\255z\\305\\261r\\305\\221\\n'; i=$((i+1)); done; echo end-$((1+1))\r").unwrap();
    let (out, _) = read_until(&rx, |o| o.contains("end-2"));
    assert!(!out.contains('\u{FFFD}'));
    assert_eq!(out.matches("árvízűrő\r\n").count(), 3000, "{} lines", out.matches("\r\n").count());
    m.shutdown();
}

#[test]
fn the_jail_keeps_terminals_inside_the_fixture_root() {
    let fixture = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let m = TermManager::new(Arc::new(Jail::e2e(fixture.path())), None);
    let (tx, _rx) = channel();
    let refused = m.open(spec(outside.path()), Box::new(move |e| drop(tx.send(e)))).unwrap_err();
    assert_eq!(refused.code, TEST_JAIL);
    let (t, rx) = {
        let (tx, rx) = channel();
        (m.open(spec(fixture.path()), Box::new(move |e| drop(tx.send(e)))).expect("inside the fixture"), rx)
    };
    // The shell in a jail cannot reach a remote through git's own transports.
    m.write(&t.term_id, "echo allow-$GIT_ALLOW_PROTOCOL\r").unwrap();
    read_until(&rx, |o| o.contains("allow-file"));
    m.shutdown();

    let ro = TermManager::new(Arc::new(Jail::read_only()), None);
    let (tx, _rx) = channel();
    let err = ro.open(spec(fixture.path()), Box::new(move |e| drop(tx.send(e)))).unwrap_err();
    assert_eq!(err.code, READ_ONLY);
}

#[test]
fn a_missing_directory_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let m = manager();
    let (tx, _rx) = channel();
    let err = m.open(spec(&dir.path().join("nope")), Box::new(move |e| drop(tx.send(e)))).unwrap_err();
    assert_eq!(err.code, "io");
}

#[test]
fn every_shell_is_recorded_for_the_orphan_sweep_until_it_is_gone() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("term-gate.json");
    let registry = Arc::new(OrphanRegistry::open(&state).unwrap());
    let m = TermManager::new(Arc::new(Jail::off()), Some(registry.clone()));
    let (t, rx) = open(&m, dir.path());
    assert_eq!(registry.recorded().unwrap(), vec![t.pid]);
    m.close(&t.term_id);
    wait_exit(&rx);
    let end = Instant::now() + WAIT;
    while !registry.recorded().unwrap().is_empty() {
        assert!(Instant::now() < end, "pgid still recorded");
        std::thread::sleep(Duration::from_millis(20));
    }
}
