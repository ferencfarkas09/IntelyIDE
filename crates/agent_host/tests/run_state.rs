//! The state a run folds from its events: a request that waits for the person is "needs you" whether or not a turn is open.
//! Live (jc): the model ended its turn while a sub-agent worked on, then asked for a plan approval with no turn open; the run read
//! Done with the card on screen, and Stop was ignored.
use intely_agent_core::api::RunStatus;
use intely_agent_core::events::types::AgentEvent;
use intely_agent_host::run::RunState;
use serde_json::json;

fn ev(seq: u64, turn: Option<&str>, kind: serde_json::Value) -> AgentEvent {
    let mut v = json!({ "agentId": "a-1", "seq": seq, "ts": 1_000 + seq, "turnId": turn, "provider": "claude" });
    v.as_object_mut().unwrap().extend(kind.as_object().unwrap().clone());
    serde_json::from_value(v).expect("a wire event")
}

fn plan_request(seq: u64, turn: Option<&str>, req: &str) -> AgentEvent {
    ev(seq, turn, json!({
        "kind": "permission.request", "reqId": req, "toolId": "t-plan",
        "intent": { "class": "other", "tool": "ExitPlanMode", "rawCommand": null, "argv": null, "paths": [], "url": null, "server": null,
                    "readOnlyHint": null, "subagentType": null, "parentToolId": null, "summary": "ExitPlanMode: leave plan mode" },
        "options": ["allow_once", "deny"], "sessionAllow": null, "plan": "step one", "planTruncated": null, "modes": ["ask", "edit", "automatic"],
    }))
}

#[test]
fn an_approval_card_after_the_turn_ended_is_needs_you_until_it_is_answered() {
    let mut st = RunState::default();
    st.apply(&ev(1, Some("turn-1"), json!({ "kind": "user.message", "messageId": "u-1", "text": "plan it", "attachments": [] })));
    assert_eq!(st.status(), RunStatus::Running);
    st.apply(&ev(2, Some("turn-1"), json!({ "kind": "turn.end", "stopReason": "endTurn" })));
    assert_eq!(st.status(), RunStatus::Done, "the lead ended its turn");

    // the sub-agent finished, the lead woke up on its own and asks: no turn id on any of it
    st.apply(&plan_request(3, None, "perm-plan"));
    assert!(!st.turn_open);
    assert_eq!(st.status(), RunStatus::NeedsYou, "a card on screen is never Done");

    st.apply(&ev(4, None, json!({ "kind": "permission.resolved", "reqId": "perm-plan", "outcome": "cancelled", "by": "user" })));
    assert_eq!(st.status(), RunStatus::Done);
}

#[test]
fn inside_an_open_turn_nothing_changes() {
    let mut st = RunState::default();
    st.apply(&ev(1, Some("turn-1"), json!({ "kind": "user.message", "messageId": "u-1", "text": "go", "attachments": [] })));
    st.apply(&plan_request(2, Some("turn-1"), "perm-a"));
    assert_eq!(st.status(), RunStatus::NeedsYou);
    st.apply(&ev(3, Some("turn-1"), json!({ "kind": "permission.resolved", "reqId": "perm-a", "outcome": "allow", "by": "user" })));
    assert_eq!(st.status(), RunStatus::Running);
}
