//! The MCP rows of the policy table (mcp-management spec 5.4, 9.2; permission-modes spec 2.2, P-8): five modes x policy x read-only flag x
//! {lead, delegate, server not in set, unknown tool, no tool name}, the argument guard, the resource tools, the unlisted-tool rule of
//! Automatic, saved allows and the session offer.

mod common;

use std::collections::BTreeMap;

use common::*;
use intely_agent_core::events::types::DecidedBy;
use intely_agent_core::mcp::{McpPolicy, McpServerRules, McpToolRule};
use intely_agent_core::policy::decide::{decide, session_allow_for, Decision, PolicyContext, SavedAllow};
use intely_agent_core::policy::intent::{collect_mcp_args, Actor, ToolClass, ToolIntent};
use intely_agent_core::providers::PermissionMode;
use serde_json::{json, Value};

const MODES: [PermissionMode; 5] = PermissionMode::ALL;
use Decision::{Allow, Ask as Q, Deny};

fn rule(policy: Option<McpPolicy>, read_only: bool) -> McpToolRule {
    McpToolRule { policy, read_only, learned: true }
}

fn rules(default_policy: McpPolicy, fresh: bool, tools: &[(&str, McpToolRule)]) -> McpServerRules {
    McpServerRules { default_policy, tools: tools.iter().map(|(k, v)| (k.to_string(), v.clone())).collect::<BTreeMap<_, _>>(), fresh }
}

struct M {
    fx: Fx,
    state: std::path::PathBuf,
    home: std::path::PathBuf,
    _tmp: tempfile::TempDir,
}

fn m() -> M {
    let fx = fx();
    let tmp = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(tmp.path()).unwrap();
    let home = base.join("home");
    let state = home.join("Library/Application Support/IntelySwitchIDE");
    std::fs::create_dir_all(&state).unwrap();
    M { fx, state, home, _tmp: tmp }
}

impl M {
    fn ctx(&self, mode: PermissionMode, server_rules: McpServerRules) -> PolicyContext {
        let mut c = ctx(&self.fx, mode);
        c.home = Some(self.home.clone());
        c.state_dir = Some(self.state.clone());
        c.strict_jail = mode != PermissionMode::Bypass;
        c.mcp_servers = vec!["fixture".into()];
        c.mcp_tools.insert("fixture".into(), server_rules);
        c
    }
}

fn call(c: &PolicyContext, tool: &str, input: Value) -> (Decision, DecidedBy, String) {
    let d = decide_tool(c, tool, input);
    (d.decision, d.by, d.rule.unwrap_or_default())
}

fn fixture_rules() -> McpServerRules {
    rules(
        McpPolicy::Ask,
        true,
        &[
            ("read", rule(None, true)),
            ("read_allowed", rule(Some(McpPolicy::Allow), true)),
            ("write", rule(None, false)),
            ("write_allowed", rule(Some(McpPolicy::Allow), false)),
            ("blocked", rule(Some(McpPolicy::Deny), false)),
            ("do_thing_deny", rule(Some(McpPolicy::Deny), false)),
        ],
    )
}

type Row = [(Decision, &'static str); 5];

fn check(m: &M, server_rules: McpServerRules, tool: &str, input: Value, want: Row) {
    for (mode, (decision, rule)) in MODES.into_iter().zip(want) {
        let (d, _, r) = call(&m.ctx(mode, server_rules.clone()), tool, input.clone());
        assert_eq!((d, r.as_str()), (decision, rule), "{tool} in {mode:?}");
    }
}

#[test]
fn the_tool_policy_decides_per_mode() {
    let m = m();
    let none = json!({});
    // Plan: only a tool the user allowed AND the server marked read-only; never an Ask
    check(&m, fixture_rules(), "mcp__fixture__read_allowed", none.clone(), [(Allow, "mcp.plan-read-only"), (Allow, "mcp.read-only"), (Allow, "mcp.read-only"), (Allow, "mcp.auto"), (Allow, "mcp.bypass")]);
    check(&m, fixture_rules(), "mcp__fixture__read", none.clone(), [(Deny, "role.read-only"), (Allow, "mcp.read-only"), (Allow, "mcp.read-only"), (Allow, "mcp.auto"), (Allow, "mcp.bypass")]);
    check(&m, fixture_rules(), "mcp__fixture__write", none.clone(), [(Deny, "role.read-only"), (Q, "mcp.ask"), (Q, "mcp.ask"), (Allow, "mcp.auto"), (Allow, "mcp.bypass")]);
    check(&m, fixture_rules(), "mcp__fixture__write_allowed", none.clone(), [(Deny, "role.read-only"), (Allow, "mcp.policy-allow"), (Allow, "mcp.policy-allow"), (Allow, "mcp.auto"), (Allow, "mcp.bypass")]);
    check(&m, fixture_rules(), "mcp__fixture__blocked", none.clone(), [(Deny, "mcp.policy-deny"); 5]);
    // a server whose default is Deny refuses every tool, a Test-listed override notwithstanding
    let deny_all = rules(McpPolicy::Deny, true, &[("ok", rule(Some(McpPolicy::Allow), false))]);
    check(&m, deny_all.clone(), "mcp__fixture__other", none.clone(), [(Deny, "mcp.policy-deny"); 5]);
    check(&m, deny_all, "mcp__fixture__ok", none.clone(), [(Deny, "role.read-only"), (Allow, "mcp.policy-allow"), (Allow, "mcp.policy-allow"), (Allow, "mcp.auto"), (Allow, "mcp.bypass")]);
    // a server judged with the default rules (policy ask, no known tools)
    let c = m.ctx(PermissionMode::Ask, McpServerRules::default());
    assert_eq!(call(&c, "mcp__fixture__x", none).2, "mcp.ask");
}

#[test]
fn an_unlisted_tool_is_denied_in_automatic_unless_the_server_default_is_allow() {
    let m = m();
    let none = json!({});
    // a tool the last Test did not list (an `npx` package update added or renamed it)
    check(&m, fixture_rules(), "mcp__fixture__newtool", none.clone(), [(Deny, "role.read-only"), (Q, "mcp.ask"), (Q, "mcp.ask"), (Deny, "mcp.unlisted-tool"), (Allow, "mcp.bypass")]);
    let allow_default = rules(McpPolicy::Allow, true, &[]);
    check(&m, allow_default, "mcp__fixture__newtool", none.clone(), [(Deny, "role.read-only"), (Allow, "mcp.policy-allow"), (Allow, "mcp.policy-allow"), (Allow, "mcp.auto"), (Allow, "mcp.bypass")]);
    // a stale list: the read-only flag and `listed` are ignored, overrides stay
    let stale = rules(McpPolicy::Ask, false, &[("read", rule(None, true)), ("blocked", rule(Some(McpPolicy::Deny), false))]);
    check(&m, stale.clone(), "mcp__fixture__read", none.clone(), [(Deny, "role.read-only"), (Q, "mcp.ask"), (Q, "mcp.ask"), (Deny, "mcp.unlisted-tool"), (Allow, "mcp.bypass")]);
    check(&m, stale, "mcp__fixture__blocked", none.clone(), [(Deny, "mcp.policy-deny"); 5]);
    // a Deny keyed to the learned name still denies a normalised-equal observed name
    check(&m, fixture_rules(), "mcp__fixture__do.thing_deny", none.clone(), [(Deny, "mcp.policy-deny"); 5]);
    // a 70-character tool name whose fitted key matches is listed
    let long = "x".repeat(70);
    let key = intely_agent_core::mcp::fit("fixture", &long);
    assert_eq!(key.len(), 50);
    let r = rules(McpPolicy::Ask, true, &[(&key, rule(None, false))]);
    check(&m, r, &format!("mcp__fixture__{long}"), none, [(Deny, "role.read-only"), (Q, "mcp.ask"), (Q, "mcp.ask"), (Allow, "mcp.auto"), (Allow, "mcp.bypass")]);
}

#[test]
fn membership_delegates_unknown_names_and_the_read_only_hint() {
    let m = m();
    let none = json!({});
    // a server outside the run's set, a delegate, and garbage names: denied in every mode, Bypass included
    check(&m, fixture_rules(), "mcp__slack__post", none.clone(), [(Deny, "mcp.not-in-set"); 5]);
    for name in ["mcp__", "mcp____x", "mcp__a__"] {
        for mode in MODES {
            let d = decide_intent(&m.ctx(mode, fixture_rules()), ToolIntent::from_claude_tool(name, &none));
            assert_eq!((d.decision, d.by), (Deny, DecidedBy::RoleDeny), "{name} {mode:?}: {d:?}");
        }
    }
    for mode in MODES {
        let mut c = m.ctx(mode, fixture_rules());
        c.delegates = Some([("dev".to_string(), intely_agent_core::policy::decide::DelegateRule { mode: PermissionMode::Edit, allowed_tools: None, role_deny: vec![], capped: false })].into());
        let mut i = ToolIntent::from_claude_tool("mcp__fixture__write_allowed", &none);
        i.actor = Some(Actor { agent_id: "x".into(), role: "dev".into() });
        let d = decide_intent(&c, i);
        assert_eq!((d.decision, d.by, d.rule.as_deref()), (Deny, DecidedBy::RoleDeny, Some("mcp.delegate")), "{mode:?}");
    }
    // the sidecar's readOnlyHint is ignored: the learned table is the only source
    for mode in [PermissionMode::Ask, PermissionMode::Edit] {
        let mut i = ToolIntent::mcp("fixture", "write");
        i.read_only_hint = Some(true);
        let d = decide_intent(&m.ctx(mode, fixture_rules()), i);
        assert_eq!(d.rule.as_deref(), Some("mcp.ask"), "{mode:?}");
    }
    // the role list still applies
    for mode in MODES {
        let mut c = m.ctx(mode, fixture_rules());
        c.role_deny = vec!["mcp__fixture__*".into()];
        assert_eq!(call(&c, "mcp__fixture__read", none.clone()).2, "role.deny-list", "{mode:?}");
    }
    // no MCP call is ever an Ask in Plan, Automatic or Bypass (a property over the table)
    for mode in [PermissionMode::ReadOnly, PermissionMode::Automatic, PermissionMode::Bypass] {
        for tool in ["read", "read_allowed", "write", "write_allowed", "blocked", "newtool", "resources"] {
            let d = decide_intent(&m.ctx(mode, fixture_rules()), ToolIntent::mcp("fixture", tool));
            assert_ne!(d.decision, Q, "{mode:?} {tool}");
        }
    }
}

#[test]
fn the_argument_guard_is_a_hard_stop_in_every_mode() {
    let m = m();
    let state = m.state.join("settings.json").display().to_string();
    let hostile = [
        state.clone(),
        "~/.ssh/id_rsa".to_string(),
        "~/.aws/credentials".to_string(),
        ".git/hooks/x".to_string(),
        ".git/config".to_string(),
        ".env".to_string(),
        "/tmp/intely-mcp-abc/mcp.json".to_string(),
        format!("file://{state}"),
        " ~/.ssh/id_rsa".to_string(),
        "file://~/.ssh/id_rsa".to_string(),
    ];
    for arg in &hostile {
        for tool in ["write_allowed", "read", "write"] {
            for mode in MODES {
                let (d, by, r) = call(&m.ctx(mode, fixture_rules()), &format!("mcp__fixture__{tool}"), json!({ "path": arg, "n": 5 }));
                assert_eq!((d, by, r.as_str()), (Deny, DecidedBy::HardStop, "mcp.protected-arg"), "{arg:?} {tool} {mode:?}");
            }
        }
    }
    // a string nested in arrays and objects is judged too
    let (d, by, _) = call(&m.ctx(PermissionMode::Bypass, fixture_rules()), "mcp__fixture__write", json!({"a": [{"b": ["x", "~/.ssh/id_rsa"]}]}));
    assert_eq!((d, by), (Deny, DecidedBy::HardStop));
    // not fired for ordinary strings
    for arg in ["hello", "src/main.rs", "a sentence with spaces about .git and ~/.ssh", "42"] {
        let (d, by, r) = call(&m.ctx(PermissionMode::Bypass, fixture_rules()), "mcp__fixture__write", json!({ "q": arg }));
        assert_eq!((d, by, r.as_str()), (Allow, DecidedBy::Default, "mcp.bypass"), "{arg:?}");
    }
    // the guard reads `args` and never `paths`: a decide with only `paths` set judges nothing
    let mut i = ToolIntent::mcp("fixture", "write_allowed");
    i.paths = vec!["~/.ssh/id_rsa".into()];
    let d = decide_intent(&m.ctx(PermissionMode::Ask, fixture_rules()), i);
    assert_eq!(d.rule.as_deref(), Some("mcp.policy-allow"));
    // the code files of the run's own servers are named: a hard stop too
    let code = m.fx.cwd.join("src/server.js");
    let mut c = m.ctx(PermissionMode::Bypass, fixture_rules());
    c.mcp_code_paths = vec![code.clone()];
    let (d, by, r) = call(&c, "mcp__fixture__write", json!({ "file": code.display().to_string() }));
    assert_eq!((d, by, r.as_str()), (Deny, DecidedBy::HardStop, "mcp.protected-arg"));
}

#[test]
fn a_call_the_guard_cannot_judge_is_a_hard_stop_in_every_mode() {
    let m = m();
    let many: Vec<String> = (0..299).map(|i| format!("v{i}")).chain(["~/.ssh/id_rsa".to_string()]).collect();
    let deep = (0..20).fold(json!("leaf"), |inner, _| json!({ "k": inner }));
    let wide: Vec<Value> = (0..25_000).map(|_| json!(1)).collect();
    let big = "x".repeat(9 * 1024 * 1024);
    for (label, input) in [("more than 256 candidates", json!({ "a": many })), ("nesting deeper than 16", deep), ("more than 20 000 nodes", json!({ "a": wide })), ("more than 8 MiB of strings", json!({ "a": big }))] {
        let i = ToolIntent::from_claude_tool("mcp__fixture__write_allowed", &input);
        assert!(i.args_unjudgeable, "{label}");
        for mode in MODES {
            let d = decide_intent(&m.ctx(mode, fixture_rules()), i.clone());
            assert_eq!((d.decision, d.by, d.rule.as_deref()), (Deny, DecidedBy::HardStop, Some("mcp.args-unjudgeable")), "{label} {mode:?}");
        }
    }
    // the same predicate runs again in `decide` on the args the sidecar sends
    let mut i = ToolIntent::mcp("fixture", "write_allowed");
    i.args = (0..300).map(|i| format!("v{i}")).collect();
    assert_eq!(decide_intent(&m.ctx(PermissionMode::Bypass, fixture_rules()), i).rule.as_deref(), Some("mcp.args-unjudgeable"));
    // the collection itself: trimmed candidates only, keys not collected, 256 is allowed
    let (args, over) = collect_mcp_args(&json!({"~/.ssh/id_rsa": "x y", "a": "  /etc/x \n", "b": "line\nbreak", "c": "with space", "d": ["ok", " ~/x "]}));
    assert!(!over);
    let mut args = args;
    args.sort();
    assert_eq!(args, vec!["/etc/x".to_string(), "ok".to_string(), "~/x".to_string()]);
    let exactly: Vec<String> = (0..256).map(|i| format!("v{i}")).collect();
    assert!(!collect_mcp_args(&json!(exactly)).1);
    // `args` is never written: not in the serialised intent
    let i = ToolIntent::from_claude_tool("mcp__fixture__write", &json!({"path": "~/.ssh/id_rsa"}));
    assert!(!i.args.is_empty());
    assert!(serde_json::to_string(&i).unwrap().find("id_rsa").is_none(), "the raw argument strings never reach a serialised intent");
    let back: ToolIntent = serde_json::from_value(json!({"class": "mcp", "tool": "mcp__fixture__write", "server": "fixture", "summary": "x", "args": ["a"], "argsUnjudgeable": true})).unwrap();
    assert_eq!((back.args, back.args_unjudgeable), (vec!["a".to_string()], true), "Deserialize reads both");
}

#[test]
fn the_resource_tools_join_the_mcp_class() {
    let m = m();
    for tool in ["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDir", "RefreshMcpTools"] {
        let i = ToolIntent::from_claude_tool(tool, &json!({"server": "fixture", "uri": "file:///x"}));
        assert_eq!((i.class, i.server.as_deref()), (ToolClass::Mcp, Some("fixture")), "{tool}");
        let input = json!({"server": "fixture", "uri": "file:///x"});
        // Plan denies (the pseudo-tool is never read-only); Ask and Edit ask; Automatic and Bypass follow the server default
        check(&m, fixture_rules(), tool, input.clone(), [(Deny, "role.read-only"), (Q, "mcp.ask"), (Q, "mcp.ask"), (Allow, "mcp.auto"), (Allow, "mcp.bypass")]);
        // a server at Deny, a server outside the set, no server, a delegate
        let deny = rules(McpPolicy::Deny, true, &[]);
        check(&m, deny, tool, input.clone(), [(Deny, "mcp.policy-deny"); 5]);
        check(&m, fixture_rules(), tool, json!({"server": "other", "uri": "file:///x"}), [(Deny, "mcp.not-in-set"); 5]);
        check(&m, fixture_rules(), tool, json!({}), [(Deny, "mcp.resource-server"); 5]);
        for mode in MODES {
            let mut c = m.ctx(mode, fixture_rules());
            c.delegates = Some([("dev".to_string(), intely_agent_core::policy::decide::DelegateRule { mode: PermissionMode::Edit, allowed_tools: None, role_deny: vec![], capped: false })].into());
            let mut i = ToolIntent::from_claude_tool(tool, &input);
            i.actor = Some(Actor { agent_id: "x".into(), role: "dev".into() });
            assert_eq!(decide_intent(&c, i).rule.as_deref(), Some("mcp.delegate"), "{tool} {mode:?}");
        }
    }
    // `uri` goes through the argument guard
    let state = m.state.join("settings.json").display().to_string();
    for mode in MODES {
        let (d, by, r) = call(&m.ctx(mode, fixture_rules()), "ReadMcpResourceTool", json!({"server": "fixture", "uri": format!("file://{state}")}));
        assert_eq!((d, by, r.as_str()), (Deny, DecidedBy::HardStop, "mcp.protected-arg"), "{mode:?}");
    }
    // the offer and the saved allow of the pseudo-tool
    let c = m.ctx(PermissionMode::Ask, fixture_rules());
    let d = decide_tool(&c, "ListMcpResourcesTool", json!({"server": "fixture"}));
    assert_eq!(d.session_allow.map(|o| o.scope), Some("fixture.resources".to_string()));
    let (saved, _) = session_allow_for(&c, &ToolIntent::from_claude_tool("ListMcpResourcesTool", &json!({"server": "fixture"}))).unwrap();
    assert_eq!(saved, SavedAllow::McpTool { server: "fixture".into(), tool: "resources".into() });
    let mut c = c;
    c.saved.push(saved);
    assert_eq!(call(&c, "ReadMcpResourceTool", json!({"server": "fixture", "uri": "file:///x"})).2, "mcp.saved");
}

#[test]
fn a_saved_mcp_allow_beats_ask_but_never_a_deny_the_guard_or_a_plan_run() {
    let m = m();
    let saved = SavedAllow::McpTool { server: "fixture".into(), tool: "write".into() };
    for mode in [PermissionMode::Ask, PermissionMode::Edit] {
        let mut c = m.ctx(mode, fixture_rules());
        c.saved.push(saved.clone());
        let (d, by, r) = call(&c, "mcp__fixture__write", json!({}));
        assert_eq!((d, by, r.as_str()), (Allow, DecidedBy::Saved, "mcp.saved"), "{mode:?}: it applies to a write tool");
        let (d, by, _) = call(&c, "mcp__fixture__write", json!({"p": "~/.ssh/id_rsa"}));
        assert_eq!((d, by), (Deny, DecidedBy::HardStop), "the guard first");
        let mut deny = fixture_rules();
        deny.tools.insert("write".into(), rule(Some(McpPolicy::Deny), false));
        let mut c = m.ctx(mode, deny);
        c.saved.push(saved.clone());
        assert_eq!(call(&c, "mcp__fixture__write", json!({})).2, "mcp.policy-deny", "a Deny beats a saved allow");
    }
    let mut c = m.ctx(PermissionMode::ReadOnly, fixture_rules());
    c.saved.push(saved.clone());
    assert_eq!(call(&c, "mcp__fixture__write", json!({})).2, "role.read-only");
    // the offer is made on `mcp.ask` and names `server.tool`
    let c = m.ctx(PermissionMode::Ask, fixture_rules());
    let d = decide_tool(&c, "mcp__fixture__write", json!({}));
    assert_eq!((d.rule.as_deref(), d.session_allow.as_ref().map(|o| o.scope.as_str())), (Some("mcp.ask"), Some("fixture.write")));
    let (s, o) = session_allow_for(&c, &ToolIntent::mcp("fixture", "write")).unwrap();
    assert_eq!((s, o.scope), (saved, "fixture.write".to_string()));
    for mode in [PermissionMode::ReadOnly, PermissionMode::Automatic, PermissionMode::Bypass] {
        assert!(session_allow_for(&m.ctx(mode, fixture_rules()), &ToolIntent::mcp("fixture", "write")).is_none(), "{mode:?}");
    }
    assert!(session_allow_for(&c, &ToolIntent::mcp("fixture", "blocked")).is_none(), "a denied tool has no offer");
    let _ = decide;
}
