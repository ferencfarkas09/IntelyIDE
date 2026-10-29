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
fn with_ultracode_the_lead_may_start_an_inline_workflow_in_every_mode_and_ask_shows_a_card() {
    let fx = fx();
    for mode in MODES {
        let d = decide_tool(&ultra(&fx, mode), "Workflow", script());
        let want = if mode == Ask { (Decision::Ask, "workflow.ask") } else { (Decision::Allow, "workflow.ultracode") };
        assert_eq!((d.decision, d.rule.as_deref().unwrap()), want, "{mode:?}");
    }
    let with_args = json!({"script": "export const meta = { name: 'x' }\nawait agent(args.task)", "args": {"task": "fix"}, "description": "ignored"});
    assert_eq!(decide_tool(&ultra(&fx, Automatic), "Workflow", with_args).decision, Decision::Allow);
}

/// Every spelling a reviewer found that slipped past the old `remote: true` text test, and the worktree isolation the `Agent` path refuses.
const ISOLATION: &[&str] = &[
    "await agent('x', {isolation:'worktree'})",
    "await agent('x', { remote: true })",
    "await agent('x', {remote : true})",
    "await agent('x', { remote: !0 })",
    "await agent('x', { remote: 1 })",
    "await agent('x', { remote /*c*/ : true })",
    "await agent('x', { REMOTE: true })",
    "agent(\"x\", {\"isolation\": \"worktree\"})",
    "// runs in a WorkTree\nawait agent('x')",
];

#[test]
fn isolation_worktree_and_remote_in_a_script_are_a_hard_stop_in_every_mode() {
    let fx = fx();
    for mode in MODES {
        for c in [ultra(&fx, mode), ctx(&fx, mode)] {
            for text in ISOLATION {
                let d = decide_tool(&c, "Workflow", json!({ "script": text }));
                assert_eq!((d.decision, d.by, d.rule.as_deref()), (Decision::Deny, DecidedBy::HardStop, Some("workflow.isolation")), "{mode:?} ultracode={} {text}", c.ultracode);
            }
        }
    }
}

#[test]
fn only_an_inline_script_is_accepted() {
    let fx = fx();
    for mode in MODES {
        let c = ultra(&fx, mode);
        for input in [
            json!({"scriptPath": "/tmp/wf.js", "script": "export const meta = { name: 'decoy' }\nawait agent('harmless')"}),
            json!({"scriptPath": "/tmp/wf.js"}),
            json!({"name": "spec"}),
            json!({"name": "spec", "args": {"q": "x"}}),
            json!({"script": "await agent('x')", "resumeFromRunId": "wf_123"}),
            json!({"script": "await agent('x')", "remote": true}),
            json!({"args": {"q": "x"}}),
            json!({"script": "   "}),
        ] {
            let d = decide_tool(&c, "Workflow", input.clone());
            assert_eq!(d.decision, Decision::Deny, "{mode:?} {input}");
            assert!(matches!(d.rule.as_deref(), Some("workflow.input") | Some("workflow.isolation")), "{mode:?} {input} -> {d:?}");
        }
    }
}

#[test]
fn scripts_that_build_keys_or_code_at_run_time_are_refused() {
    let fx = fx();
    let evasive = [
        "await agent('x', { ['re' + 'mote']: true })",
        "const k = 'x'; await agent('y', { [k]: 1 })",
        "eval('agent(1)')",
        "new Function('return agent')()",
        "await agent('x', { 're\\u006dote': true })",
        "await agent('x', { 're\\x6dote': true })",
        "const k = String.fromCharCode(114); await agent('x')",
        "const o = JSON.parse('{}'); await agent('x', o)",
        "const o = {}; Object.assign(o, {}); await agent('x', o)",
        "const k = 're' + 'mo'; await agent('x')",
    ];
    for mode in MODES {
        for text in evasive {
            let d = decide_tool(&ultra(&fx, mode), "Workflow", json!({ "script": text }));
            assert_eq!(d.decision, Decision::Deny, "{mode:?} {text}");
            assert!(matches!(d.rule.as_deref(), Some("workflow.evasion") | Some("workflow.isolation")), "{mode:?} {text} -> {d:?}");
        }
    }
}

#[test]
fn a_script_cannot_choose_the_model_effort_or_agent_type_of_its_helpers() {
    let fx = fx();
    for text in ["await agent('x', { model: 'opus' })", "await agent('x', {effort : 'max'})", "await agent('x', { agentType: 'general-purpose' })"] {
        let d = decide_tool(&ultra(&fx, Bypass), "Workflow", json!({ "script": text }));
        assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("workflow.override")), "{text}");
    }
}

#[test]
fn a_helper_agent_cannot_start_another_workflow() {
    let fx = fx();
    for mode in MODES {
        let d = decide_intent(&ultra(&fx, mode), helper("Workflow", script()));
        assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("workflow.nested")), "{mode:?}");
    }
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
    let write = |mode| decide(&ultra(&fx, mode), &request(helper("Write", json!({ "file_path": fx.cwd.join("src/new.ts"), "content": "x" })))).decision;
    assert_eq!(write(ReadOnly), Decision::Deny, "a helper of a Plan run cannot create a file either");
    let bash = decide(&ultra(&fx, ReadOnly), &request(helper("Bash", json!({ "command": "echo x > src/a.ts" })))).decision;
    assert_eq!(bash, Decision::Deny, "nor write through the shell");
    assert_eq!(edit(Ask), Decision::Ask);
    assert_eq!(edit(Automatic), Decision::Allow);
}
