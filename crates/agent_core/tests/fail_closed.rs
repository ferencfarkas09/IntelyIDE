//! providers-plan 5.5: a broken channel is a denial, never an allow.

mod common;

use common::*;
use intely_agent_core::events::types::DecidedBy;
use intely_agent_core::policy::decide::{decide, decide_text, decide_wire, fail_closed, Decision};
use intely_agent_core::policy::intent::ToolIntent;
use intely_agent_core::providers::PermissionMode;
use serde_json::{json, Value};

fn valid_body(command: &str) -> Value {
    json!({"agentId": "a1", "toolId": "t9", "provider": "claude", "intent": {"class": "exec", "rawCommand": command, "summary": "x"}})
}

fn assert_denied(d: &intely_agent_core::policy::decide::PolicyDecision, what: &str) {
    assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::FailClosed), "{what}: {d:?}");
    assert!(!d.reason.is_empty() && d.rule.as_deref() == Some("fail-closed"), "{what}");
}

#[test]
fn no_context_means_deny() {
    assert_denied(&decide_wire(None, &valid_body("ls")), "unknown agent");
    assert_denied(&decide_text(None, &valid_body("ls").to_string()), "unknown agent, text");
}

#[test]
fn garbage_bodies_mean_deny() {
    let fx = fx();
    let c = ctx(&fx, PermissionMode::Edit);
    let garbage = [
        Value::Null,
        json!(42),
        json!("allow"),
        json!([]),
        json!({}),
        json!({"agentId": "a1"}),
        json!({"agentId": 1, "toolId": "t", "provider": "p", "intent": {"class": "exec", "summary": "x"}}),
        json!({"agentId": "a1", "toolId": "t", "provider": "p", "intent": {"class": "teleport", "summary": "x"}}),
        json!({"agentId": "a1", "toolId": "t", "provider": "p", "intent": {"class": "exec"}}),
        json!({"agentId": "a1", "toolId": "t", "provider": "p", "intent": "git push"}),
        json!({"decision": "allow", "by": "user", "reason": "pre-approved"}),
    ];
    for g in &garbage {
        assert_denied(&decide_wire(Some(&c), g), &g.to_string());
    }
    for text in ["", "{", "{\"agentId\":", "not json", "\u{0}", "{\"agentId\":\"a1\"} trailing"] {
        assert_denied(&decide_text(Some(&c), text), text);
    }
}

#[test]
fn a_valid_body_is_judged_normally() {
    let fx = fx();
    let c = ctx(&fx, PermissionMode::Edit);
    let d = decide_wire(Some(&c), &valid_body("/usr/bin/git push origin HEAD"));
    assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop));
    let d = decide_text(Some(&c), &valid_body("npm test").to_string());
    assert_eq!((d.decision, d.by), (Decision::Ask, DecidedBy::Default));
    assert_eq!(decide_wire(Some(&c), &valid_body("npm test")), decide(&c, &request(ToolIntent::exec("npm test"))));
}

#[test]
fn an_exec_intent_with_nothing_to_judge_asks_or_denies_never_allows() {
    let fx = fx();
    let empty = ToolIntent::new(intely_agent_core::policy::intent::ToolClass::Exec, "nothing");
    let d = decide_intent(&ctx(&fx, PermissionMode::Edit), empty.clone());
    assert_eq!(d.decision, Decision::Ask);
    let d = decide_intent(&ctx(&fx, PermissionMode::ReadOnly), empty);
    assert_eq!(d.decision, Decision::Deny);
    let mut argv = ToolIntent::new(intely_agent_core::policy::intent::ToolClass::Exec, "empty argv");
    argv.argv = Some(vec![]);
    assert_eq!(decide_intent(&ctx(&fx, PermissionMode::Edit), argv).decision, Decision::Ask);
}

#[test]
fn an_exec_intent_with_nothing_to_judge_is_a_denial_in_the_unattended_modes() {
    let fx = fx();
    let empty = ToolIntent::new(intely_agent_core::policy::intent::ToolClass::Exec, "nothing");
    for mode in [PermissionMode::Automatic, PermissionMode::Bypass] {
        let d = decide_intent(&ctx(&fx, mode), empty.clone());
        assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("exec.unparseable")), "{mode:?}");
    }
    // a broken body is still a fail-closed denial whatever the mode
    for mode in PermissionMode::ALL {
        let c = ctx(&fx, mode);
        assert_denied(&decide_wire(Some(&c), &json!({"agentId": "a1"})), "missing fields");
        assert_denied(&decide_text(Some(&c), "{"), "truncated");
    }
}

#[test]
fn argv_intents_are_judged_without_a_raw_command() {
    let fx = fx();
    let c = ctx(&fx, PermissionMode::Edit);
    let mut i = ToolIntent::new(intely_agent_core::policy::intent::ToolClass::Exec, "push");
    i.argv = Some(vec!["/usr/bin/git".into(), "push".into()]);
    let d = decide_intent(&c, i);
    assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop));
    let mut i = ToolIntent::new(intely_agent_core::policy::intent::ToolClass::Exec, "sh");
    i.argv = Some(vec!["sh".into(), "-c".into(), "git commit".into()]);
    assert_eq!(decide_intent(&c, i).by, DecidedBy::HardStop);
}

#[test]
fn the_decision_wire_shape_matches_the_spec() {
    let d = fail_closed("pipe closed");
    assert_eq!(serde_json::to_value(&d).unwrap(), json!({"decision": "deny", "by": "failClosed", "reason": "pipe closed", "rule": "fail-closed", "sessionAllow": null}));
    let fx = fx();
    let d = decide(&ctx(&fx, PermissionMode::Edit), &request(ToolIntent::exec("/usr/bin/git push origin HEAD")));
    let v = serde_json::to_value(&d).unwrap();
    assert_eq!((v["decision"].as_str(), v["by"].as_str()), (Some("deny"), Some("hardStop")));
}
