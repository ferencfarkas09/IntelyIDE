//! Ultracode (the New run picker): the lead may start `Workflow` in every mode, and only in a run that has it on. The helper agents a
//! workflow starts reach the broker as sub-agents (the CLI's hook input carries their `agent_id`, type `workflow-agent`): the hard stops
//! hold for them exactly as for the lead, in Automatic and Bypass too.

mod common;

use common::*;
use intely_agent_core::events::types::DecidedBy;
use intely_agent_core::policy::decide::{decide, Decision, PolicyContext};
use intely_agent_core::policy::intent::{Actor, ToolIntent};
use intely_agent_core::providers::PermissionMode::{self, *};
use serde_json::json;

const MODES: [PermissionMode; 5] = [ReadOnly, Ask, Edit, Automatic, Bypass];

fn ultra(fx: &Fx, mode: PermissionMode) -> PolicyContext {
    let mut c = ctx(fx, mode);
    c.ultracode = true;
    c
}

/// A call of a workflow's helper agent: the actor comes from the hook input, never from the tool input.
fn helper(tool: &str, input: serde_json::Value) -> ToolIntent {
    let mut i = ToolIntent::from_claude_tool(tool, &input);
    i.actor = Some(Actor { agent_id: "wf-agent-1".into(), role: "workflow-agent".into() });
    i
}

fn script() -> serde_json::Value {
    json!({"script": "export const meta = { name: 'fix', description: 'x' }\nawait agent('fix the total')"})
}

#[test]
fn without_ultracode_a_workflow_stays_refused_in_the_unattended_modes_and_asks_in_the_attended_ones() {
    let fx = fx();
    for mode in MODES {
        let d = decide_tool(&ctx(&fx, mode), "Workflow", script());
        let want = match mode {
            ReadOnly => (Decision::Deny, "other.read-only"),
            Ask | Edit => (Decision::Ask, "other.unknown"),
            Automatic | Bypass => (Decision::Deny, "other.state-change"),
        };
        assert_eq!((d.decision, d.rule.as_deref().unwrap()), want, "{mode:?}");
    }
}

#[test]
fn with_ultracode_the_lead_may_start_a_workflow_in_every_mode() {
    let fx = fx();
    for mode in MODES {
        let d = decide_tool(&ultra(&fx, mode), "Workflow", script());
        assert_eq!((d.decision, d.rule.as_deref()), (Decision::Allow, Some("workflow.ultracode")), "{mode:?}");
    }
}

#[test]
fn a_workflow_that_runs_off_this_machine_and_a_nested_one_are_refused() {
    let fx = fx();
    for mode in MODES {
        let c = ultra(&fx, mode);
        for input in [json!({"name": "spec", "remote": true}), json!({"script": "await agent('x', {remote : true})"}), json!({"script": "agent(\"x\", {\"remote\": true})"})] {
            let d = decide_tool(&c, "Workflow", input.clone());
            assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("workflow.remote")), "{mode:?} {input}");
        }
        let d = decide_intent(&c, helper("Workflow", script()));
        assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("workflow.nested")), "{mode:?}");
    }
    assert!(!intely_agent_core::policy::intent::workflow_goes_remote(&json!({"remote": false, "script": "const remoteOk = true"})));
}

#[test]
fn a_helper_agent_cannot_commit_push_or_touch_git_internals_in_any_mode() {
    let fx = fx();
    for mode in MODES {
        let c = ultra(&fx, mode);
        for cmd in ["git commit -m x", "git push origin main", "git -C . commit -am x", "git add -A", "cd sub && git push --force", "env git commit -m y"] {
            let d = decide(&c, &request(helper("Bash", json!({ "command": cmd }))));
            assert_eq!(d.decision, Decision::Deny, "{mode:?}: {cmd} -> {d:?}");
            if matches!(mode, Automatic | Bypass) {
                assert_eq!(d.by, DecidedBy::HardStop, "{mode:?}: {cmd} is a hard stop, not a mode answer");
            }
        }
        for path in [".git/config", ".git/hooks/pre-commit", ".claude/settings.json", ".husky/pre-push"] {
            let d = decide(&c, &request(helper("Write", json!({ "file_path": fx.cwd.join(path), "content": "x" }))));
            assert_eq!(d.decision, Decision::Deny, "{mode:?}: write {path} -> {d:?}");
        }
    }
}

#[test]
fn a_helper_agent_is_judged_in_the_run_mode_like_the_lead() {
    let fx = fx();
    let read = |mode| decide(&ultra(&fx, mode), &request(helper("Read", json!({ "file_path": fx.cwd.join("src/a.ts") })))).decision;
    assert_eq!(read(Automatic), Decision::Allow);
    let edit = |mode| decide(&ultra(&fx, mode), &request(helper("Edit", json!({ "file_path": fx.cwd.join("src/a.ts"), "old_string": "a", "new_string": "b" })))).decision;
    assert_eq!(edit(ReadOnly), Decision::Deny, "Plan stays read-only for the helpers");
    assert_eq!(edit(Ask), Decision::Ask);
    assert_eq!(edit(Automatic), Decision::Allow);
}
