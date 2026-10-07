//! JsonlEventLog against the contract every EventLog must pass, plus its file-level behavior.

use std::fs;
use std::io::Write;
use std::time::{Duration, SystemTime};

use intely_agent_core::events::log::{contract, EventLog, JsonlEventLog, LogError, RETENTION_DAYS};
use intely_agent_core::events::samples::sample_events;

#[test]
fn passes_the_event_log_contract() {
    let dir = tempfile::tempdir().unwrap();
    contract::check(&JsonlEventLog::new(dir.path()));
}

#[test]
fn one_append_only_file_per_run_with_one_json_object_per_line() {
    let dir = tempfile::tempdir().unwrap();
    let log = JsonlEventLog::new(dir.path());
    let events = sample_events();
    log.append_batch(&events).unwrap();
    let text = fs::read_to_string(dir.path().join("runs/a1.jsonl")).unwrap();
    assert_eq!(text.lines().count(), events.len());
    assert!(text.ends_with('\n'));
    for (line, e) in text.lines().zip(&events) {
        let v: serde_json::Value = serde_json::from_str(line).unwrap();
        assert_eq!(v["agentId"], "a1");
        assert_eq!(v["kind"], e.kind.name());
    }
}

#[test]
fn a_second_instance_continues_the_same_file_and_enforces_order() {
    let dir = tempfile::tempdir().unwrap();
    let events = sample_events();
    JsonlEventLog::new(dir.path()).append_batch(&events[..5]).unwrap();
    let log = JsonlEventLog::new(dir.path());
    assert!(matches!(log.append(&events[4]), Err(LogError::OutOfOrder { last: 5, got: 5, .. })));
    log.append_batch(&events[5..]).unwrap();
    assert_eq!(log.read("a1").unwrap(), events);
}

#[test]
fn a_torn_last_line_is_skipped_and_cut_off_by_the_next_append() {
    let dir = tempfile::tempdir().unwrap();
    let events = sample_events();
    let log = JsonlEventLog::new(dir.path());
    log.append_batch(&events[..3]).unwrap();
    drop(log);
    let path = dir.path().join("runs/a1.jsonl");
    let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
    f.write_all(b"{\"agentId\":\"a1\",\"seq\":3,\"ts\":1,\"prov").unwrap();
    drop(f);

    let log = JsonlEventLog::new(dir.path());
    assert_eq!(log.read("a1").unwrap(), events[..3].to_vec(), "torn tail ignored");
    log.append(&events[3]).unwrap();
    assert_eq!(log.read("a1").unwrap(), events[..4].to_vec());
    assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 4, "no fragment left behind");
}

#[test]
fn corruption_in_the_middle_is_an_error_with_a_line_number() {
    let dir = tempfile::tempdir().unwrap();
    let log = JsonlEventLog::new(dir.path());
    log.append_batch(&sample_events()[..3]).unwrap();
    let path = dir.path().join("runs/a1.jsonl");
    let text = fs::read_to_string(&path).unwrap();
    let mut lines: Vec<&str> = text.lines().collect();
    lines[1] = "not json";
    fs::write(&path, lines.join("\n") + "\n").unwrap();
    match log.read("a1") {
        Err(LogError::Corrupt { line: 2, .. }) => {}
        other => panic!("{other:?}"),
    }
}

#[test]
fn files_older_than_the_retention_window_are_pruned() {
    let dir = tempfile::tempdir().unwrap();
    let log = JsonlEventLog::new(dir.path());
    let mut old = sample_events()[0].clone();
    old.agent_id = "old".into();
    log.append(&old).unwrap();
    log.append(&sample_events()[0]).unwrap();
    let day = Duration::from_secs(24 * 3600);
    let aged = fs::File::options().write(true).open(dir.path().join("runs/old.jsonl")).unwrap();
    aged.set_modified(SystemTime::now() - day * (RETENTION_DAYS as u32 + 1)).unwrap();
    drop(aged);

    assert_eq!(log.prune(SystemTime::now()).unwrap(), vec!["old".to_string()]);
    assert_eq!(log.runs().unwrap(), vec!["a1".to_string()]);
    assert_eq!(log.read("old").unwrap(), vec![]);
    // a pruned run can start over
    log.append(&old).unwrap();
    assert_eq!(log.read("old").unwrap().len(), 1);
    assert!(log.prune(SystemTime::now()).unwrap().is_empty());
}

#[test]
fn concurrent_runs_do_not_interleave_lines() {
    let dir = tempfile::tempdir().unwrap();
    let log = std::sync::Arc::new(JsonlEventLog::new(dir.path()));
    let threads: Vec<_> = (0..4)
        .map(|n| {
            let log = log.clone();
            std::thread::spawn(move || {
                for mut e in sample_events() {
                    e.agent_id = format!("run-{n}");
                    log.append(&e).unwrap();
                }
            })
        })
        .collect();
    threads.into_iter().for_each(|t| t.join().unwrap());
    assert_eq!(log.runs().unwrap().len(), 4);
    for n in 0..4 {
        assert_eq!(log.read(&format!("run-{n}")).unwrap().len(), sample_events().len());
    }
}

#[test]
fn pruning_an_empty_data_directory_is_fine() {
    let dir = tempfile::tempdir().unwrap();
    assert!(JsonlEventLog::new(dir.path()).prune(SystemTime::now()).unwrap().is_empty());
    assert!(JsonlEventLog::new(dir.path()).runs().unwrap().is_empty());
}
