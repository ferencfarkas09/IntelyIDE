//! The host against the real sidecar bundle and the mock provider (no model call, no Tauri).

mod common;

use common::*;
use intely_agent_core::api::{AgentStartRequest, PermissionDecision, RunStatus};
use intely_agent_core::events::invariants::InvariantChecker;
use intely_agent_core::events::types::{EventKind, NoteState, PermissionOutcome, StopReason, ToolStatus};
use intely_agent_core::events::log::{EventLog, JsonlEventLog};

fn start(host: &intely_agent_host::AgentHost, role: &str, repo: &intely_agent_host::RepoRef) -> Result<intely_agent_core::api::AgentSummary, intely_core::EngineError> {
    host.start(AgentStartRequest { role: role.into(), repo_ids: vec![repo.id.clone()], prompt: "go".into(), mode: None, mcp_servers: None }, std::slice::from_ref(repo))
}

fn assert_invariants(events: &[intely_agent_core::events::types::AgentEvent]) {
    let mut checker = InvariantChecker::new();
    let violations: Vec<_> = events.iter().flat_map(|e| checker.push(e)).collect();
    assert!(violations.is_empty(), "invariants violated: {violations:?}");
}

#[test]
fn a_plain_run_is_lazy_stored_and_published_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let (host, sink) = host_with(config(&dir.path().join("data"), sidecar_js()));
    assert_eq!(host.sidecar_pid(), None, "nothing is spawned before the first run");
    assert!(host.list().is_empty());
    assert_eq!(host.sidecar_pid(), None, "listing does not spawn the sidecar either");

    let summary = start(&host, "mock-plain-reply", &repo).expect("start");
    assert!(host.sidecar_pid().is_some());
    let end = sink.wait_turn_end(&summary.agent_id);
    assert_eq!(stop_reason(&end), "EndTurn");

    let events = sink.of(&summary.agent_id);
    assert_invariants(&events);
    assert!(matches!(events[1].kind, EventKind::UserMessage { .. }) || matches!(events[0].kind, EventKind::UserMessage { .. }), "the prompt is the first thing in the log");
    assert!(has_kind(&events, "session.started") && has_kind(&events, "text.done") && has_kind(&events, "usage"));

    // append-before-publish: whatever was published is in the log, identically
    let stored = host.history(&summary.agent_id, None).unwrap();
    assert_eq!(stored.len(), events.len());
    assert_eq!(serde_json::to_value(&stored).unwrap(), serde_json::to_value(&events).unwrap());
    let tail = host.history(&summary.agent_id, Some(events[3].seq)).unwrap();
    assert_eq!(tail.len(), events.len() - 4, "a reader that comes back with its last seq gets exactly the missing events");

    let listed = host.list();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].status, RunStatus::Done);
    assert_eq!(listed[0].role, "mock-plain-reply");
    assert!(!listed[0].title.is_empty());
    host.shutdown();
    assert_eq!(host.sidecar_pid(), None);
}

#[test]
fn permission_answers_resolve_exactly_once_and_forged_ones_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let (host, sink) = host_with(config(&dir.path().join("data"), sidecar_js()));
    let id = start(&host, "mock-tool-permission", &repo).unwrap().agent_id;
    let req = sink.wait_kind(&id, "permission.request");
    let EventKind::PermissionRequest { req_id, .. } = &req.kind else { unreachable!() };
    assert_eq!(host.list()[0].status, RunStatus::NeedsYou);

    let code = |r: Result<(), intely_core::EngineError>| r.expect_err("must be refused").code;
    assert_eq!(code(host.answer_permission(&id, "forged", PermissionDecision::AllowOnce)), "unknownRequest");
    assert_eq!(code(host.answer_permission("a-other", req_id, PermissionDecision::AllowOnce)), "unknownAgent");
    // "allow always in this session" only when the card offered it (this scripted card does not); role + repository rules stay unavailable
    assert_eq!(code(host.answer_permission(&id, req_id, PermissionDecision::AllowRun)), "optionNotOffered");
    assert_eq!(code(host.answer_permission(&id, req_id, PermissionDecision::AllowAlways)), "optionNotOffered");

    host.answer_permission(&id, req_id, PermissionDecision::AllowOnce).expect("first answer");
    let resolved = sink.wait_kind(&id, "permission.resolved");
    assert!(matches!(resolved.kind, EventKind::PermissionResolved { outcome: PermissionOutcome::Allow, .. }));
    let again = host.answer_permission(&id, req_id, PermissionDecision::Deny).expect_err("second answer");
    assert!(["alreadyAnswered", "unknownRequest"].contains(&again.code.as_str()), "the loser gets a clear no-op, got {}", again.code);

    sink.wait_turn_end(&id);
    assert_invariants(&sink.of(&id));
    host.shutdown();
}

#[test]
fn deny_is_answered_and_a_second_writer_on_the_same_repo_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let (host, sink) = host_with(config(&dir.path().join("data"), sidecar_js()));
    let id = start(&host, "mock-tool-permission", &repo).unwrap().agent_id;
    let req = sink.wait_kind(&id, "permission.request");
    let second = start(&host, "mock-tool-permission", &repo).expect_err("the repo is being written");
    assert_eq!(second.code, "writeLease", "{}", second.message);
    assert_eq!(host.list().len(), 1, "a refused start leaves no run behind");

    let EventKind::PermissionRequest { req_id, .. } = &req.kind else { unreachable!() };
    host.answer_permission(&id, req_id, PermissionDecision::Deny).unwrap();
    let denied = sink.wait(&id, "denied tool result", 20, |e| matches!(&e.kind, EventKind::ToolResult { status: ToolStatus::Denied, .. }));
    assert!(matches!(denied.kind, EventKind::ToolResult { .. }));
    sink.wait_turn_end(&id);

    // a finished run does not hold the repo: the next writer takes over, the old session resumes on demand
    let third = start(&host, "mock-tool-permission", &repo).expect("a finished run yields its slot");
    assert_ne!(third.agent_id, id);
    sink.wait_kind(&third.agent_id, "permission.request");
    assert_eq!(host.list().iter().filter(|a| a.status == RunStatus::NeedsYou).count(), 1);
    host.shutdown();
}

#[test]
fn stop_ends_the_turn_cancelled_and_the_run_can_go_on() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let mut cfg = config(&dir.path().join("data"), sidecar_js());
    cfg.mock_speed = 1.0;
    let (host, sink) = host_with(cfg);
    let id = start(&host, "mock-interrupt", &repo).unwrap().agent_id;
    sink.wait_kind(&id, "tool.start");
    host.interrupt(&id).unwrap();
    let end = sink.wait_turn_end(&id);
    assert_eq!(stop_reason(&end), "Cancelled");
    let events = sink.of(&id);
    assert_invariants(&events);
    assert_eq!(events.iter().filter(|e| e.kind.name() == "turn.end").count(), 1, "exactly one turn.end");
    assert!(events.iter().any(|e| matches!(&e.kind, EventKind::ToolResult { status: ToolStatus::Cancelled, .. })));
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert_eq!(host.leases().len(), 1, "a soft cancel keeps the lease: the session lives on");
    assert_eq!(host.list()[0].status, RunStatus::Done);
    host.shutdown();
}

#[test]
fn a_killed_sidecar_closes_the_open_turn_and_frees_every_slot() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let mut cfg = config(&dir.path().join("data"), sidecar_js());
    cfg.mock_speed = 1.0;
    let (host, sink) = host_with(cfg);
    let id = start(&host, "mock-interrupt", &repo).unwrap().agent_id;
    sink.wait_kind(&id, "tool.start");
    let pid = host.sidecar_pid().expect("running");
    // SAFETY: SIGKILL to the sidecar we spawned.
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    let end = sink.wait_turn_end(&id);
    assert_eq!(stop_reason(&end), format!("{:?}", StopReason::Error));
    let events = sink.of(&id);
    assert_invariants(&events);
    assert!(events.iter().any(|e| matches!(&e.kind, EventKind::Error { .. })), "the user is told why the run ended");
    assert_eq!(host.list()[0].status, RunStatus::Error);
    assert_eq!(host.leases().len(), 0, "the gate reclaimed the lease");
    assert_eq!(host.sidecar_pid(), None);

    // the run resumes on a fresh sidecar, with the seq continuing
    let last_seq = events.last().unwrap().seq;
    host.send(&id, "again").expect("resume");
    sink.wait(&id, "the resumed turn", 20, |e| e.seq > last_seq && e.kind.name() == "tool.start");
    host.interrupt(&id).unwrap();
    sink.wait(&id, "second turn end", 20, |e| e.seq > last_seq && e.kind.name() == "turn.end");
    // (the mock replays its script, tool ids included, so only the numbering is checked across the resume)
    let all = sink.of(&id);
    assert!(all.windows(2).all(|w| w[1].seq == w[0].seq + 1), "seq continues gap-free across the resume");
    host.shutdown();
}

#[test]
fn a_run_is_snapshotted_before_it_starts_and_rewind_restores_the_tree() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    std::fs::write(repo.path.join("a.txt"), "dirty before the run\n").unwrap();
    let (host, sink) = host_with(config(&dir.path().join("data"), sidecar_js()));
    let id = start(&host, "mock-plain-reply", &repo).unwrap().agent_id;
    sink.wait_turn_end(&id);
    assert!(!git(&repo.path, &["rev-parse", "--verify", &format!("refs/intely/snapshots/{id}")]).is_empty(), "the snapshot ref exists");

    // the "agent" edits, adds and deletes files
    std::fs::write(repo.path.join("a.txt"), "changed by the agent\n").unwrap();
    std::fs::write(repo.path.join("new.txt"), "new\n").unwrap();
    host.rewind(&id).expect("rewind");
    assert_eq!(std::fs::read_to_string(repo.path.join("a.txt")).unwrap(), "dirty before the run\n");
    assert!(!repo.path.join("new.txt").exists());
    host.shutdown();
}

#[test]
fn a_run_without_a_rewind_snapshot_is_refused_unless_the_user_opts_out_for_that_run() {
    use intely_agent_host::{RepoRef, StartOptions, NO_SAFETY_NET};
    let dir = tempfile::tempdir().unwrap();
    // a folder that is not a git repository cannot be snapshotted
    let plain = dir.path().join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    let repo = RepoRef { id: "plain".into(), path: plain.canonicalize().unwrap() };
    let (host, sink) = host_with(config(&dir.path().join("data"), sidecar_js()));
    let err = start(&host, "mock-plain-reply", &repo).unwrap_err();
    assert_eq!(err.code, NO_SAFETY_NET, "{err:?}");
    assert!(err.message.contains("run without safety net"), "{}", err.message);
    assert!(host.list().is_empty(), "a refused run leaves nothing behind");

    let role = intely_agent_host::roles::builtin(&config(&dir.path().join("data"), sidecar_js())).into_iter().find(|r| r.name == "mock-plain-reply").unwrap();
    let req = AgentStartRequest { role: role.name.clone(), repo_ids: vec![repo.id.clone()], prompt: "go".into(), mode: None, mcp_servers: None };
    let id = host.start_role_with(&role, req, std::slice::from_ref(&repo), StartOptions { run_without_safety_net: true, ..Default::default() }).expect("opt-out starts").agent_id;
    sink.wait_turn_end(&id);
    assert!(host.rewind(&id).is_err(), "there is nothing to rewind to");
    host.shutdown();
}

#[test]
fn the_policy_context_of_a_run_is_path_jailed_to_its_repos_plus_the_read_only_attachment_dir() {
    use intely_agent_core::policy::decide::{decide, Decision};
    use intely_agent_core::policy::intent::{PolicyRequest, ToolIntent};
    use intely_agent_core::providers::PermissionMode;
    use intely_agent_host::run::{context_for, Meta, RepoRef as Repo};
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let state = base.join("state");
    let meta = Meta {
        agent_id: "a1".into(),
        provider: "claude".into(),
        role: "developer".into(),
        model: "m".into(),
        effort: None,
        permission: PermissionMode::Edit,
        repos: vec![Repo { id: "r".into(), path: base.join("repo") }, Repo { id: "s".into(), path: base.join("second") }],
        started_at: 0,
        native_id: None,
        snapshots: Vec::new(),
        mcp: Vec::new(),
        role_hash: None,
        role_permission: None,
    };
    let ctx = context_for(&meta, None, Vec::new(), &state);
    assert!(ctx.strict_jail);
    let judge = |intent: ToolIntent| decide(&ctx, &PolicyRequest { agent_id: "a1".into(), tool_id: "t".into(), provider: "claude".into(), intent });
    let inside = base.join("second/src/a.ts").display().to_string();
    assert_eq!(judge(ToolIntent::write(&[&inside])).decision, Decision::Allow);
    let outside = base.join("elsewhere/a.ts").display().to_string();
    let d = judge(ToolIntent::write(&[&outside]));
    assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("fs.outside-jail")));
    let attachment = state.join("attachments/x/shot.png").display().to_string();
    assert_eq!(judge(ToolIntent::write(&[&attachment])).decision, Decision::Deny, "the attachment store is never writable");
    assert_eq!(judge(ToolIntent::read(&[&attachment])).decision, Decision::Allow, "but readable");
}

#[test]
fn history_survives_a_restart_and_an_unfinished_turn_is_closed() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let data = dir.path().join("data");
    let id;
    {
        let (host, sink) = host_with(config(&data, sidecar_js()));
        id = start(&host, "mock-plain-reply", &repo).unwrap().agent_id;
        sink.wait_turn_end(&id);
        host.shutdown();
    }
    // a crashed IDE leaves a log whose turn never ended
    let log = JsonlEventLog::new(&data);
    let mut events = log.read(&id).unwrap();
    let last = events.pop().unwrap();
    assert!(matches!(last.kind, EventKind::Usage { .. }) || last.kind.name() == "turn.end");
    let mut cut = events.clone();
    if last.kind.name() != "turn.end" {
        cut.push(last);
    }
    let torn = dir.path().join("torn");
    let torn_log = JsonlEventLog::new(&torn);
    cut.retain(|e| e.kind.name() != "turn.end");
    for e in &cut {
        torn_log.append(e).unwrap();
    }
    std::fs::copy(data.join("runs").join(format!("{id}.meta.json")), {
        std::fs::create_dir_all(torn.join("runs")).unwrap();
        torn.join("runs").join(format!("{id}.meta.json"))
    })
    .unwrap();

    let (host, _sink) = host_with(config(&torn, sidecar_js()));
    let listed = host.list();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].status, RunStatus::Error, "the run that was working when the IDE closed is shown as failed, not as running");
    let stored = host.history(&id, None).unwrap();
    assert_invariants(&stored);
    assert_eq!(host.sidecar_pid(), None);
}

/// (state, parent, text, tool) of every `note` event of one note, in log order.
fn note_states(events: &[intely_agent_core::events::types::AgentEvent], note: &str) -> Vec<(NoteState, Option<String>, Option<String>, Option<String>, Option<String>)> {
    events
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::Note { note_id, state, parent_tool_id, text, tool_id, reason } if note_id == note => Some((*state, parent_tool_id.clone(), text.clone(), tool_id.clone(), reason.clone())),
            _ => None,
        })
        .collect()
}

#[test]
fn a_note_rides_with_the_next_tool_call_of_the_agent_it_is_for() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let mut cfg = config(&dir.path().join("data"), sidecar_js());
    cfg.mock_speed = 1.0;
    let (host, sink) = host_with(cfg);
    let id = start(&host, "mock-notes", &repo).unwrap().agent_id;
    // the researcher (the `Agent` call t1) is in the middle of its first tool call
    sink.wait(&id, "the sub-agent's first tool call", 20, |e| matches!(&e.kind, EventKind::ToolStart { tool_id, .. } if tool_id == "t2"));
    let note = host.note(&id, Some("t1".into()), "  use the staging database  ").unwrap();

    // refused: not a running sub-agent, nothing to say, too much to say
    assert_eq!(host.note(&id, Some("t9".into()), "x").unwrap_err().code, "noteUnknownTarget");
    assert_eq!(host.note(&id, None, "   ").unwrap_err().code, "noteEmpty");
    assert_eq!(host.note(&id, None, &"x".repeat(4001)).unwrap_err().code, "noteTooLong");

    let end = sink.wait_turn_end(&id);
    assert_eq!(stop_reason(&end), "EndTurn");
    let events = sink.of(&id);
    assert_invariants(&events);
    let states = note_states(&events, &note);
    assert_eq!(states.len(), 2, "queued, then delivered: {states:?}");
    assert_eq!(states[0], (NoteState::Queued, Some("t1".into()), Some("use the staging database".into()), None, None), "the text is trimmed and the target named");
    assert_eq!((states[1].0, states[1].1.as_deref(), states[1].3.as_deref()), (NoteState::Delivered, Some("t1"), Some("t3")), "it rode on the sub-agent's NEXT tool call");
    // the log has it too, in the same order
    let stored = host.history(&id, None).unwrap();
    assert_eq!(note_states(&stored, &note), states);
    host.shutdown();
}

#[test]
fn a_note_for_the_lead_waits_for_the_lead_and_a_note_the_agent_can_no_longer_read_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture_repo(dir.path());
    let mut cfg = config(&dir.path().join("data"), sidecar_js());
    cfg.mock_speed = 1.0;
    let (host, sink) = host_with(cfg);
    let id = start(&host, "mock-notes", &repo).unwrap().agent_id;
    sink.wait(&id, "the sub-agent's last tool call", 20, |e| matches!(&e.kind, EventKind::ToolStart { tool_id, .. } if tool_id == "t4"));
    // t4 is the researcher's last call: nothing after it can carry a note, and the lead makes no tool call at all
    let to_sub = host.note(&id, Some("t1".into()), "too late for you").unwrap();
    let to_lead = host.note(&id, None, "and for the lead").unwrap();
    sink.wait_turn_end(&id);
    let events = sink.of(&id);
    assert_invariants(&events);

    let sub = note_states(&events, &to_sub);
    assert_eq!(sub.len(), 2, "{sub:?}");
    assert_eq!((sub[1].0, sub[1].4.as_deref()), (NoteState::Dropped, Some("finished")), "its sub-agent ended first");
    let lead = note_states(&events, &to_lead);
    assert_eq!(lead.len(), 2, "{lead:?}");
    assert_eq!((lead[0].1.clone(), lead[1].0, lead[1].4.as_deref()), (None, NoteState::Dropped, Some("turnEnded")), "the turn ended before the lead made another call");

    // between turns there is nobody to read a note
    assert_eq!(host.note(&id, None, "anyone there?").unwrap_err().code, "noteNoTurn");
    host.shutdown();
}
