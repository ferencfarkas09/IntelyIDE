//! Wire format of events and sidecar messages: serialize/parse round trips, the kind catalogue, invariant cases.

use std::collections::BTreeSet;

use intely_agent_core::events::samples::{cases, sample_events};
use intely_agent_core::events::types::{EventKind, McpServerState, ALL_KINDS};
use intely_agent_core::events::{check, AgentEvent, InvariantChecker, ViolationCode};
use intely_agent_core::sidecar::{sample_messages, AuthHandoff, Reply, Secret, SidecarBody, SidecarMsg};
use serde_json::{json, Value};

#[test]
fn the_sample_stream_covers_every_kind_once_and_is_valid() {
    let events = sample_events();
    let kinds: Vec<&str> = events.iter().map(|e| e.kind.name()).collect();
    let unique: BTreeSet<&str> = kinds.iter().copied().collect();
    assert_eq!(kinds.len(), unique.len(), "each kind exactly once");
    assert_eq!(unique, ALL_KINDS.iter().copied().collect::<BTreeSet<_>>());
    assert_eq!(check(&events), vec![]);
}

#[test]
fn every_event_round_trips_through_json() {
    for e in sample_events() {
        let text = serde_json::to_string(&e).unwrap();
        let back: AgentEvent = serde_json::from_str(&text).unwrap();
        assert_eq!(back, e, "{text}");
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["kind"], e.kind.name());
        assert!(v["agentId"].is_string() && v["seq"].is_number() && v["ts"].is_number() && v["provider"].is_string());
    }
}

#[test]
fn the_wire_shape_follows_the_plan() {
    let events = sample_events();
    let started = serde_json::to_value(&events[0]).unwrap();
    assert_eq!(started["kind"], "session.started");
    assert_eq!(started["effective"], json!({"effort": "high", "permission": "edit", "sandbox": null}));
    assert_eq!(started["auth"], json!({"mode": "subscription", "source": "none", "warning": null}));
    assert_eq!(started["capsDelta"]["effort"]["cap"], "no");
    assert_eq!(started["turnId"], Value::Null, "absent options are written as null");
    let tool = serde_json::to_value(&events[7]).unwrap();
    assert_eq!((tool["kind"].as_str(), tool["toolKind"].as_str(), tool["turnId"].as_str()), (Some("tool.start"), Some("exec"), Some("t1")));
    let raw = serde_json::to_value(&events[5]).unwrap();
    assert_eq!(raw["raw"]["type"], "stream_event");
    let usage = serde_json::to_value(events.iter().find(|e| e.kind.name() == "usage").unwrap()).unwrap();
    assert_eq!(usage["usage"]["costBasis"], "estimated");
    assert_eq!(usage["usage"]["perTurn"]["inputTokens"], 1200);
}

#[test]
fn minimal_events_parse_without_optional_fields() {
    let e: AgentEvent = serde_json::from_value(json!({
        "agentId": "a1", "seq": 17, "ts": 1790000000000u64, "provider": "claude", "kind": "text.delta", "messageId": "m2", "text": "Hel"
    }))
    .unwrap();
    assert_eq!(e.seq, 17);
    let e: AgentEvent = serde_json::from_value(json!({
        "agentId": "a1", "seq": 1, "ts": 1, "provider": "mock", "kind": "permission.request", "reqId": "r", "toolId": "t",
        "intent": {"class": "exec", "rawCommand": "git push", "summary": "push"}
    }))
    .unwrap();
    assert!(matches!(e.kind, intely_agent_core::events::EventKind::PermissionRequest { ref options, .. } if options.is_empty()));
    assert!(serde_json::from_value::<AgentEvent>(json!({"agentId": "a1", "seq": 1, "ts": 1, "provider": "x", "kind": "nope"})).is_err());
}

#[test]
fn invariant_cases_report_exactly_the_expected_codes() {
    for c in cases() {
        let codes: Vec<ViolationCode> = check(&c.events).into_iter().map(|v| v.code).collect();
        assert_eq!(codes, c.expect, "{}", c.name);
    }
}

#[test]
fn the_checker_resyncs_after_a_gap_and_can_start_mid_run() {
    let events = sample_events();
    let mut gappy = events.clone();
    gappy.remove(3);
    assert_eq!(check(&gappy).iter().map(|v| v.code).collect::<Vec<_>>(), vec![ViolationCode::SeqGap], "one gap, no cascade");
    let mut mid = InvariantChecker::with_first_seq(6);
    let mut out: Vec<_> = events[5..].iter().flat_map(|e| mid.push(e)).collect();
    out.extend(mid.finish());
    assert_eq!(out, vec![], "tail of a valid stream is valid when the first seq is declared");
}

fn msg(v: Value) -> SidecarMsg {
    serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{v}: {e}"))
}

/// Rust writes `null` for an absent option; TypeScript may omit the key. Both mean the same.
fn strip_nulls(v: Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.into_iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k, strip_nulls(v))).collect()),
        Value::Array(a) => Value::Array(a.into_iter().map(strip_nulls).collect()),
        other => other,
    }
}

#[test]
fn sidecar_messages_round_trip_exactly() {
    let mut types = BTreeSet::new();
    for s in sample_messages() {
        let m = msg(s.clone());
        types.insert(m.body.type_name());
        assert_eq!(strip_nulls(serde_json::to_value(&m).unwrap()), strip_nulls(s));
    }
    assert_eq!(types.len(), 17, "all message types of 5.5 (and session/permission, session/mcp-status, session/note) are covered: {types:?}");
}

#[test]
fn bad_sidecar_messages_do_not_parse() {
    for bad in [
        json!({"v":1,"id":1,"type":"nope","body":{}}),
        json!({"v":1,"type":"hello","body":{"version":"x","pid":1,"node":"v24","providers":[]}}),
        json!({"v":1,"id":1,"type":"hello"}),
        json!({"v":1,"id":1,"type":"policy/decide","body":{"agentId":"a1"}}),
    ] {
        assert!(serde_json::from_value::<SidecarMsg>(bad.clone()).is_err(), "{bad}");
    }
    let hello = msg(json!({"v":1,"id":1,"type":"hello","body":{"version":"x","pid":1,"node":"v24","providers":[]}}));
    assert!(matches!(hello.body, SidecarBody::Hello { pid: 1, .. }));
}

#[test]
fn an_api_key_never_shows_up_in_debug_output() {
    let handoff = AuthHandoff { mode: intely_agent_core::providers::AuthMode::ApiKey, key: Some(Secret::new("sk-canary-1234567890")) };
    assert!(!format!("{handoff:?}").contains("canary"));
    assert!(serde_json::to_string(&handoff).unwrap().contains("canary"), "the wire carries it (pipe only)");
}

#[test]
fn an_intent_without_the_delegation_fields_serialises_exactly_as_before_they_existed() {
    use intely_agent_core::policy::intent::{Actor, SubagentFlags, ToolIntent};
    let legacy = r#"{"class":"exec","tool":"Bash","rawCommand":"ls","argv":null,"paths":[],"url":null,"server":null,"readOnlyHint":null,"subagentType":null,"parentToolId":null,"summary":"ls"}"#;
    assert_eq!(serde_json::to_string(&ToolIntent::exec("ls")).unwrap(), legacy);
    let back: ToolIntent = serde_json::from_str(legacy).unwrap();
    assert!(back.actor.is_none() && back.isolation.is_none() && back.subagent_flags.is_none());
    let mut full = ToolIntent::from_claude_tool("Agent", &json!({"subagent_type": "r", "isolation": "worktree", "model": "opus", "run_in_background": true}));
    full.actor = Some(Actor { agent_id: "a-1".into(), role: "dev".into() });
    let v = serde_json::to_value(&full).unwrap();
    assert_eq!(v["actor"], json!({"agentId": "a-1", "role": "dev"}));
    assert_eq!(v["isolation"], "worktree");
    assert_eq!(v["subagentFlags"], json!({"hasModel": true, "background": true, "subagentType": "r"}));
    assert_eq!(serde_json::from_value::<ToolIntent>(v).unwrap(), full);
    let _ = SubagentFlags { has_model: false, background: None, subagent_type: None };
}

#[test]
fn session_start_without_delegates_is_unchanged_and_with_them_round_trips() {
    let classic = sample_messages().into_iter().find(|m| m["id"] == 46 && m["type"] == "session/start").unwrap();
    assert!(classic["body"].get("delegates").is_none(), "a classic start carries no delegates key");
    let auto = sample_messages().into_iter().find(|m| m["id"] == 54).unwrap();
    let m: SidecarMsg = serde_json::from_value(auto).unwrap();
    let SidecarBody::SessionStart(s) = m.body else { panic!("not a session/start") };
    let delegates = s.delegates.expect("delegates");
    assert_eq!(delegates.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), ["researcher", "developer"]);
}

#[test]
fn a_policy_decision_with_a_session_allow_round_trips_and_old_decisions_still_parse() {
    use intely_agent_core::events::types::DecidedBy;
    use intely_agent_core::policy::decide::{Decision, PolicyDecision, SessionAllowKind, SessionAllowOffer};
    let d = PolicyDecision {
        decision: Decision::Ask,
        by: DecidedBy::Default,
        reason: "commands need approval unless saved".into(),
        rule: Some("exec.ask".into()),
        session_allow: Some(SessionAllowOffer { kind: SessionAllowKind::Exec, scope: "git status".into() }),
    };
    let v = serde_json::to_value(&d).unwrap();
    assert_eq!(v["sessionAllow"], json!({"kind": "exec", "scope": "git status"}));
    assert_eq!(serde_json::from_value::<PolicyDecision>(v).unwrap(), d);
    // a decision from before the field existed
    let old: PolicyDecision = serde_json::from_value(json!({"decision": "allow", "by": "default", "reason": "x", "rule": "read.inside"})).unwrap();
    assert!(old.session_allow.is_none());
    for kind in ["exec", "net", "mcp", "write"] {
        assert!(serde_json::from_value::<SessionAllowKind>(json!(kind)).is_ok(), "{kind}");
    }
}

#[test]
fn a_policy_context_written_before_the_modes_work_still_loads() {
    use intely_agent_core::policy::decide::{PolicyContext, SavedAllow};
    use intely_agent_core::providers::PermissionMode;
    let c: PolicyContext = serde_json::from_value(json!({"mode": "auto", "cwd": "/x"})).unwrap();
    assert_eq!(c.mode, PermissionMode::Automatic, "the dead `auto` mode reads as `automatic`");
    assert!(c.mcp_tools.is_empty() && c.mcp_code_paths.is_empty() && c.plan_dir.is_none());
    assert_eq!(serde_json::to_value(SavedAllow::WriteInside).unwrap(), json!({"kind": "writeInside"}));
    assert_eq!(serde_json::from_value::<SavedAllow>(json!({"kind": "writeInside"})).unwrap(), SavedAllow::WriteInside);
    let back: PolicyContext = serde_json::from_value(serde_json::to_value(&c).unwrap()).unwrap();
    assert_eq!(back, c);
}

#[test]
fn the_delegate_rule_cap_defaults_to_false_and_the_sdk_coverage_is_exported() {
    use intely_agent_core::policy::decide::DelegateRule;
    let r: DelegateRule = serde_json::from_value(json!({"mode": "edit"})).unwrap();
    assert!(!r.capped);
    assert!(serde_json::from_value::<DelegateRule>(json!({"mode": "ask", "capped": true})).unwrap().capped);
    assert_eq!(intely_agent_core::policy::SDK_TOOL_COVERAGE.len(), 43);
}

#[test]
fn session_info_carries_slash_commands_and_mcp_servers_and_old_events_still_parse() {
    let v = json!({"agentId":"a1","seq":3,"ts":1,"provider":"claude","kind":"session.info",
        "slashCommands":["compact","review"],
        "mcpServers":[{"name":"github","status":"connected","tools":12},{"name":"docs","status":"needsAuth"},{"name":"x","status":"failed","error":"spawn ENOENT"}]});
    let e: AgentEvent = serde_json::from_value(v.clone()).unwrap();
    let EventKind::SessionInfo { slash_commands, mcp_servers, .. } = &e.kind else { panic!("not a session.info") };
    assert_eq!(slash_commands, &["compact", "review"]);
    assert_eq!(mcp_servers.iter().map(|s| s.status).collect::<Vec<_>>(), [McpServerState::Connected, McpServerState::NeedsAuth, McpServerState::Failed]);
    assert_eq!(mcp_servers[0].tools, Some(12));
    assert_eq!(mcp_servers[2].error.as_deref(), Some("spawn ENOENT"));
    let back = serde_json::to_value(&e).unwrap();
    assert_eq!(back["slashCommands"], v["slashCommands"]);
    assert_eq!(strip_nulls(back["mcpServers"].clone()), v["mcpServers"]);
    // an event written before the fields existed: both lists are simply empty
    let old: AgentEvent = serde_json::from_value(json!({"agentId":"a1","seq":4,"ts":1,"provider":"claude","kind":"session.info","title":"t"})).unwrap();
    let EventKind::SessionInfo { slash_commands, mcp_servers, .. } = old.kind else { panic!("not a session.info") };
    assert!(slash_commands.is_empty() && mcp_servers.is_empty());
}

#[test]
fn an_unknown_mcp_state_is_refused_rather_than_guessed() {
    let bad = json!({"agentId":"a1","seq":4,"ts":1,"provider":"claude","kind":"session.info","mcpServers":[{"name":"x","status":"needs-auth"}]});
    assert!(serde_json::from_value::<AgentEvent>(bad).is_err());
}

#[test]
fn the_mcp_status_request_and_its_reply_parse_into_their_own_shapes() {
    let req = sample_messages().into_iter().find(|m| m["id"] == 65).unwrap();
    let SidecarBody::SessionMcpStatus { agent_id, reconnect, toggle } = serde_json::from_value::<SidecarMsg>(req).unwrap().body else { panic!("not a session/mcp-status") };
    assert_eq!((agent_id.as_str(), reconnect), ("a1", None));
    let toggle = toggle.expect("toggle");
    assert_eq!((toggle.server.as_str(), toggle.enabled), ("github", false));
    let reply = sample_messages().into_iter().find(|m| m["id"] == 63 && m["type"] == "reply").unwrap();
    let SidecarBody::Reply(Reply::McpStatus(r)) = serde_json::from_value::<SidecarMsg>(reply).unwrap().body else { panic!("not an MCP status reply") };
    assert!(r.ok);
    assert_eq!(r.servers.iter().map(|s| (s.name.as_str(), s.tools.len())).collect::<Vec<_>>(), [("github", 2), ("docs", 0), ("linear", 0)]);
    assert_eq!(r.servers[1].error.as_deref(), Some("spawn ENOENT"));
    // a plain acknowledgement is still an acknowledgement
    let ack = serde_json::from_value::<SidecarMsg>(json!({"v":1,"id":9,"type":"reply","body":{"ok":true}})).unwrap();
    assert!(matches!(ack.body, SidecarBody::Reply(Reply::Ack(_))));
}
