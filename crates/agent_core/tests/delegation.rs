//! Delegation ((design notes: roles-orchestration-spec) 5, 8.2): the broker judges a call by the role of its actor.
//! The cases live in `packages/protocol/fixtures/delegation-cases.json`, shared with the TypeScript golden test; the table
//! below is their source (`INTELY_WRITE_FIXTURES=1 cargo test -p intely-agent-core --test delegation` rewrites the file).

mod common;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use common::*;
use intely_agent_core::events::types::DecidedBy;
use intely_agent_core::policy::decide::{decide, decide_with, Decision, DelegateRule, PolicyContext, SavedAllow};
use intely_agent_core::policy::intent::{Actor, PolicyRequest, ToolIntent};
use intely_agent_core::providers::PermissionMode;
use serde_json::{json, Value};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol/fixtures/delegation-cases.json")
}

/// The named role sets the cases refer to.
fn sets() -> Value {
    let standard = json!({
        // a read-only role without an allow-list (the mode alone must hold)
        "ro": {"mode": "readOnly"},
        // what the Roles layer builds for a read-only file role: an explicit read set
        "researcher": {"mode": "readOnly", "allowedTools": ["Read", "Grep", "Glob", "LS", "TodoWrite"]},
        // read-only role that lists a web tool explicitly
        "scout": {"mode": "readOnly", "allowedTools": ["Read", "WebFetch"]},
        // edit role, inherits the lead's tools (has Bash)
        "dev": {"mode": "edit"},
        "dev2": {"mode": "edit"},
        // edit role without Bash
        "writer": {"mode": "edit", "allowedTools": ["Read", "Edit", "Write", "Grep", "Glob"]},
        // a repository role held at its ceiling
        "repo-ask": {"mode": "ask"},
        // `tools:` present but empty in the file: nothing is allowed
        "empty": {"mode": "readOnly", "allowedTools": []},
        // extra role deny of the file
        "nodeploy": {"mode": "edit", "roleDeny": ["WebFetch", "mcp__*"]}
    });
    // the roles of the run-mode ladder cases (permission-modes spec 3): a read-only role, an edit role, an ask role and a repository role
    // that is `capped` (its permission was never set explicitly, so an unattended run never lifts it)
    let modes = json!({
        "ro": {"mode": "readOnly"},
        "dev": {"mode": "edit"},
        "asker": {"mode": "ask"},
        "repo-cap": {"mode": "ask", "capped": true}
    });
    json!({"standard": standard, "modes": modes})
}

struct Case {
    name: String,
    set: Option<&'static str>,
    mode: &'static str,
    strict_jail: bool,
    cap: u32,
    used: u32,
    strict_background: bool,
    saved: Value,
    saved_by_role: Value,
    actor: Option<(&'static str, &'static str)>,
    tool: &'static str,
    input: Value,
    expect: (&'static str, &'static str, &'static str),
}

fn case(name: impl Into<String>, actor: Option<&'static str>, tool: &'static str, input: Value, expect: (&'static str, &'static str, &'static str)) -> Case {
    Case {
        name: name.into(),
        set: Some("standard"),
        mode: "edit",
        strict_jail: true,
        cap: 12,
        used: 0,
        strict_background: false,
        saved: json!([]),
        saved_by_role: json!({}),
        actor: actor.map(|r| (r, "agent-1")),
        tool,
        input,
        expect,
    }
}

const D: &str = "default";
const H: &str = "hardStop";
const R: &str = "roleDeny";

fn cases() -> Vec<Case> {
    let mut out = Vec::new();
    // Every role x the probes. (actor, expected) pairs per probe.
    let per = |out: &mut Vec<Case>, label: &str, tool: &'static str, input: Value, rows: &[(&'static str, (&'static str, &'static str, &'static str))]| {
        for (actor, expect) in rows {
            out.push(case(format!("{label} by {actor}"), Some(actor), tool, input.clone(), *expect));
        }
    };
    let edit = json!({"file_path": "src/a.ts", "old_string": "a", "new_string": "b"});
    per(&mut out, "Edit inside", "Edit", edit, &[
        ("ro", ("deny", R, "role.read-only")),
        ("researcher", ("deny", R, "role.tool-not-allowed")),
        ("dev", ("allow", D, "write.inside")),
        ("writer", ("allow", D, "write.inside")),
        ("repo-ask", ("ask", D, "write.ask")),
        ("empty", ("deny", R, "role.tool-not-allowed")),
    ]);
    per(&mut out, "Write outside the repo", "Write", json!({"file_path": "/etc/x-outside", "content": "x"}), &[
        ("ro", ("deny", H, "fs.outside-jail")),
        ("researcher", ("deny", H, "fs.outside-jail")),
        ("dev", ("deny", H, "fs.outside-jail")),
        ("writer", ("deny", H, "fs.outside-jail")),
    ]);
    per(&mut out, "Write .git/config", "Write", json!({"file_path": ".git/config", "content": "x"}), &[
        ("ro", ("deny", H, "fs.protected")),
        ("researcher", ("deny", H, "fs.protected")),
        ("dev", ("deny", H, "fs.protected")),
        ("writer", ("deny", H, "fs.protected")),
    ]);
    per(&mut out, "Write .claude/settings.local.json", "Write", json!({"file_path": ".claude/settings.local.json", "content": "x"}), &[
        ("ro", ("deny", H, "fs.protected")),
        ("dev", ("deny", H, "fs.protected")),
        ("writer", ("deny", H, "fs.protected")),
    ]);
    per(&mut out, "Bash write into a lockfile", "Bash", json!({"command": "echo x > pnpm-lock.yaml"}), &[
        ("ro", ("deny", H, "fs.protected")),
        ("researcher", ("deny", H, "fs.protected")),
        ("dev", ("deny", H, "fs.protected")),
        ("writer", ("deny", H, "fs.protected")),
    ]);
    per(&mut out, "Bash ls", "Bash", json!({"command": "ls"}), &[
        // permission-modes spec GZ-1: a low-risk read command runs in a read-only effective mode too
        ("ro", ("allow", D, "exec.low-risk-read")),
        ("researcher", ("deny", R, "role.tool-not-allowed")),
        ("writer", ("deny", R, "role.tool-not-allowed")),
        // rev 2: in edit mode `ls` is a low-risk read and is allowed
        ("dev", ("allow", D, "exec.low-risk-read")),
        ("repo-ask", ("ask", D, "exec.ask")),
    ]);
    per(&mut out, "Bash npm test", "Bash", json!({"command": "npm test"}), &[
        ("ro", ("deny", R, "role.read-only")),
        ("researcher", ("deny", R, "role.tool-not-allowed")),
        ("writer", ("deny", R, "role.tool-not-allowed")),
        ("dev", ("ask", D, "exec.ask")),
    ]);
    per(&mut out, "git commit", "Bash", json!({"command": "git commit -m x"}), &[
        ("ro", ("deny", H, "git.commit")),
        ("researcher", ("deny", H, "git.commit")),
        ("dev", ("deny", H, "git.commit")),
        ("writer", ("deny", H, "git.commit")),
        ("repo-ask", ("deny", H, "git.commit")),
    ]);
    per(&mut out, "git push", "Bash", json!({"command": "git push origin HEAD"}), &[
        ("ro", ("deny", H, "git.push")),
        ("researcher", ("deny", H, "git.push")),
        ("dev", ("deny", H, "git.push")),
        ("writer", ("deny", H, "git.push")),
    ]);
    per(&mut out, "absolute git push", "Bash", json!({"command": "/usr/bin/git push origin HEAD"}), &[
        ("researcher", ("deny", H, "git.push")),
        ("dev", ("deny", H, "git.push")),
        ("writer", ("deny", H, "git.push")),
    ]);
    per(&mut out, "git add -A", "Bash", json!({"command": "git add -A"}), &[
        ("ro", ("deny", H, "git.add-all")),
        ("researcher", ("deny", H, "git.add-all")),
        ("dev", ("deny", H, "git.add-all")),
        ("writer", ("deny", H, "git.add-all")),
    ]);
    per(&mut out, "Read .env", "Read", json!({"file_path": ".env"}), &[
        ("ro", ("deny", H, "read.never-read")),
        ("researcher", ("deny", H, "read.never-read")),
        ("dev", ("deny", H, "read.never-read")),
        ("writer", ("deny", H, "read.never-read")),
    ]);
    per(&mut out, "Read inside", "Read", json!({"file_path": "src/a.ts"}), &[
        ("ro", ("allow", D, "read.inside")),
        ("researcher", ("allow", D, "read.inside")),
        ("dev", ("allow", D, "read.inside")),
        ("writer", ("allow", D, "read.inside")),
        ("empty", ("deny", R, "role.tool-not-allowed")),
    ]);
    per(&mut out, "WebFetch", "WebFetch", json!({"url": "https://docs.rs/serde"}), &[
        ("scout", ("ask", D, "net.ask")),
        ("researcher", ("deny", R, "role.tool-not-allowed")),
        ("ro", ("deny", R, "role.read-only")),
        ("dev", ("ask", D, "net.ask")),
        ("nodeploy", ("deny", R, "role.deny-list")),
    ]);
    // mcp-management spec 5.4 step 2: a sub-agent never gets MCP tools, whatever its role lists
    per(&mut out, "MCP tool", "mcp__github__get_issue", json!({"number": 5}), &[
        ("researcher", ("deny", R, "mcp.delegate")),
        ("nodeploy", ("deny", R, "mcp.delegate")),
    ]);
    per(&mut out, "Agent by a sub-agent", "Agent", json!({"subagent_type": "researcher", "run_in_background": false}), &[
        ("ro", ("deny", R, "delegate.nested")),
        ("researcher", ("deny", R, "delegate.nested")),
        ("dev", ("deny", R, "delegate.nested")),
        ("writer", ("deny", R, "delegate.nested")),
    ]);
    // the lead (no actor)
    let lead = |name: &str, input: Value, expect| case(name, None, "Agent", input, expect);
    out.push(lead("lead starts a listed role", json!({"subagent_type": "researcher", "run_in_background": false}), ("allow", D, "delegate.spawn")));
    out.push(lead("lead: Task alias starts a listed role", json!({"subagent_type": "writer", "run_in_background": false}), ("allow", D, "delegate.spawn")));
    out.push(lead("lead: general-purpose is not a role of this run", json!({"subagent_type": "general-purpose", "run_in_background": false}), ("deny", R, "delegate.unknown-type")));
    out.push(lead("lead: Explore is not a role of this run", json!({"subagent_type": "Explore", "run_in_background": false}), ("deny", R, "delegate.unknown-type")));
    out.push(lead("lead: explore (case) is not a role of this run", json!({"subagent_type": "explore", "run_in_background": false}), ("deny", R, "delegate.unknown-type")));
    out.push(lead("lead: no subagent_type", json!({"run_in_background": false}), ("deny", R, "delegate.unknown-type")));
    out.push(lead("lead: model override", json!({"subagent_type": "researcher", "model": "opus", "run_in_background": false}), ("deny", R, "delegate.model")));
    out.push(lead("lead: background", json!({"subagent_type": "researcher", "run_in_background": true}), ("deny", R, "delegate.background")));
    out.push(lead("lead: background omitted, lenient", json!({"subagent_type": "researcher"}), ("allow", D, "delegate.spawn")));
    out.push(Case { strict_background: true, ..lead("lead: background omitted, strict", json!({"subagent_type": "researcher"}), ("deny", R, "delegate.background")) });
    out.push(lead("lead: worktree isolation", json!({"subagent_type": "researcher", "isolation": "worktree", "run_in_background": false}), ("deny", H, "delegate.isolation")));
    out.push(lead("lead: remote isolation", json!({"subagent_type": "researcher", "isolation": "remote"}), ("deny", H, "delegate.isolation")));
    out.push(Case { used: 11, ..lead("lead: the 12th call is the last", json!({"subagent_type": "researcher", "run_in_background": false}), ("allow", D, "delegate.spawn")) });
    out.push(Case { used: 12, ..lead("lead: the 13th call is refused", json!({"subagent_type": "researcher", "run_in_background": false}), ("deny", R, "delegate.cap")) });
    out.push(Case { cap: 1, used: 1, ..lead("lead: a cap of 1", json!({"subagent_type": "writer", "run_in_background": false}), ("deny", R, "delegate.cap")) });
    // actors the run does not know (the sidecar sends `?` when it cannot name the agent: fail closed)
    let unknown = |name: &str, role: &'static str, tool: &'static str, input: Value, expect| Case { actor: Some((role, "agent-9")), ..case(name, None, tool, input, expect) };
    out.push(unknown("actor ? Edit", "?", "Edit", json!({"file_path": "src/a.ts"}), ("deny", R, "delegate.unknown-actor")));
    out.push(unknown("actor ? Read", "?", "Read", json!({"file_path": "src/a.ts"}), ("deny", R, "delegate.unknown-actor")));
    out.push(unknown("actor ? Bash ls", "?", "Bash", json!({"command": "ls"}), ("deny", R, "delegate.unknown-actor")));
    out.push(unknown("actor ? WebFetch", "?", "WebFetch", json!({"url": "https://docs.rs/serde"}), ("deny", R, "delegate.unknown-actor")));
    out.push(unknown("actor ? git push", "?", "Bash", json!({"command": "git push"}), ("deny", H, "git.push")));
    out.push(unknown("actor ? Agent", "?", "Agent", json!({"subagent_type": "researcher", "run_in_background": false}), ("deny", R, "delegate.unknown-actor")));
    out.push(unknown("actor ghost Edit", "ghost", "Edit", json!({"file_path": "src/a.ts"}), ("deny", R, "delegate.unknown-actor")));
    out.push(unknown("actor Explore Read", "Explore", "Read", json!({"file_path": "src/a.ts"}), ("deny", R, "delegate.unknown-actor")));
    out.push(unknown("actor explore (case) Read", "explore", "Read", json!({"file_path": "src/a.ts"}), ("deny", R, "delegate.unknown-actor")));
    // a delegate is never more permissive than the run
    out.push(Case { mode: "readOnly", ..case("edit role under a read-only run", Some("writer"), "Edit", json!({"file_path": "src/a.ts"}), ("deny", R, "role.read-only")) });
    out.push(Case { mode: "ask", ..case("edit role under an ask run", Some("dev"), "Edit", json!({"file_path": "src/a.ts"}), ("ask", D, "write.ask")) });
    // saved allows are keyed by role
    out.push(Case {
        saved_by_role: json!({"dev": [{"kind": "execPrefix", "argv": ["npm", "test"]}]}),
        ..case("saved allow of dev applies to dev", Some("dev"), "Bash", json!({"command": "npm test"}), ("allow", "saved", "exec.saved"))
    });
    out.push(Case {
        saved_by_role: json!({"dev": [{"kind": "execPrefix", "argv": ["npm", "test"]}]}),
        ..case("saved allow of dev does not apply to dev2", Some("dev2"), "Bash", json!({"command": "npm test"}), ("ask", D, "exec.ask"))
    });
    out.push(Case {
        saved: json!([{"kind": "execPrefix", "argv": ["npm", "test"]}]),
        ..case("saved allow of the lead does not apply to a delegate", Some("dev"), "Bash", json!({"command": "npm test"}), ("ask", D, "exec.ask"))
    });
    out.push(Case {
        saved: json!([{"kind": "execPrefix", "argv": ["npm", "test"]}]),
        ..case("saved allow of the lead applies to the lead", None, "Bash", json!({"command": "npm test"}), ("allow", "saved", "exec.saved"))
    });
    // the lead itself
    out.push(case("lead Edit inside", None, "Edit", json!({"file_path": "src/a.ts"}), ("allow", D, "write.inside")));
    out.push(case("lead git commit", None, "Bash", json!({"command": "git commit -m x"}), ("deny", H, "git.commit")));
    // legacy: delegation not active (delegates = None)
    let legacy = |name: &str, actor: Option<&'static str>, tool: &'static str, input: Value, mode: &'static str, expect| Case { set: None, mode, ..case(name, actor, tool, input, expect) };
    out.push(legacy("legacy: an actor is judged by the run's mode", Some("researcher"), "Edit", json!({"file_path": "src/a.ts"}), "edit", ("allow", D, "write.inside")));
    // permission-modes spec GZ-2: a plan lead may ask for the web (it used to be denied)
    out.push(legacy("legacy: a plan run asks for WebFetch", None, "WebFetch", json!({"url": "https://docs.rs/serde"}), "readOnly", ("ask", D, "net.ask")));
    out.push(legacy("legacy: Agent with isolation", None, "Agent", json!({"subagent_type": "researcher", "isolation": "worktree"}), "edit", ("deny", H, "delegate.isolation")));
    out.push(legacy("legacy: Agent with model", None, "Agent", json!({"subagent_type": "researcher", "model": "opus"}), "edit", ("deny", R, "delegate.model")));
    out.push(legacy("legacy: Agent without flags asks as before", None, "Agent", json!({"subagent_type": "researcher"}), "edit", ("ask", D, "other.subagent")));
    out.push(legacy("legacy: git push", Some("researcher"), "Bash", json!({"command": "git push"}), "readOnly", ("deny", H, "git.push")));
    // the run-mode ladder (permission-modes spec 3, D7): the same delegates under every run mode
    let ladder = |out: &mut Vec<Case>, mode: &'static str, label: &str, role: &'static str, tool: &'static str, input: Value, expect| {
        out.push(Case { set: Some("modes"), mode, ..case(format!("{mode} run: {label} by {role}"), Some(role), tool, input, expect) });
    };
    let write = json!({"file_path": "src/a.ts", "old_string": "a", "new_string": "b"});
    let test = json!({"command": "npm test"});
    let status = json!({"command": "git status"});
    let outside = json!({"file_path": "/etc/hosts"});
    for (mode, rows) in [
        ("readOnly", [
            ("dev", ("deny", R, "role.read-only"), ("deny", R, "role.read-only")),
            ("asker", ("deny", R, "role.read-only"), ("deny", R, "role.read-only")),
            ("ro", ("deny", R, "role.read-only"), ("deny", R, "role.read-only")),
            ("repo-cap", ("deny", R, "role.read-only"), ("deny", R, "role.read-only")),
        ]),
        ("ask", [
            ("dev", ("ask", D, "write.ask"), ("ask", D, "exec.ask")),
            ("asker", ("ask", D, "write.ask"), ("ask", D, "exec.ask")),
            ("ro", ("deny", R, "role.read-only"), ("deny", R, "role.read-only")),
            ("repo-cap", ("ask", D, "write.ask"), ("ask", D, "exec.ask")),
        ]),
        ("edit", [
            ("dev", ("allow", D, "write.inside"), ("ask", D, "exec.ask")),
            ("asker", ("ask", D, "write.ask"), ("ask", D, "exec.ask")),
            ("ro", ("deny", R, "role.read-only"), ("deny", R, "role.read-only")),
            ("repo-cap", ("ask", D, "write.ask"), ("ask", D, "exec.ask")),
        ]),
        ("automatic", [
            ("dev", ("allow", D, "write.auto"), ("allow", D, "exec.auto")),
            ("asker", ("allow", D, "write.auto"), ("allow", D, "exec.auto")),
            ("ro", ("deny", R, "role.read-only"), ("deny", R, "role.read-only")),
            ("repo-cap", ("deny", R, "role.read-only"), ("deny", R, "role.read-only")),
        ]),
        ("bypass", [
            ("dev", ("allow", D, "write.bypass"), ("allow", D, "exec.bypass")),
            ("asker", ("allow", D, "write.bypass"), ("allow", D, "exec.bypass")),
            ("ro", ("deny", R, "role.read-only"), ("deny", R, "role.read-only")),
            ("repo-cap", ("deny", R, "role.read-only"), ("deny", R, "role.read-only")),
        ]),
    ] {
        for (role, w, t) in rows {
            ladder(&mut out, mode, "Edit inside", role, "Edit", write.clone(), w);
            ladder(&mut out, mode, "npm test", role, "Bash", test.clone(), t);
        }
        // a low-risk read runs for a read-only effective mode in every run mode (GZ-1); the capped role is read-only in the unattended modes
        ladder(&mut out, mode, "git status", "ro", "Bash", status.clone(), ("allow", D, "exec.low-risk-read"));
        let unattended = matches!(mode, "automatic" | "bypass");
        ladder(&mut out, mode, "git status", "repo-cap", "Bash", status.clone(), if unattended || mode == "readOnly" { ("allow", D, "exec.low-risk-read") } else { ("ask", D, "exec.ask") });
        // a read outside the run's folders: a read-only delegate asks in an attended run and is DENIED (never asked) in an unattended one (2.4)
        ladder(&mut out, mode, "Read outside", "ro", "Read", outside.clone(), if unattended { ("deny", R, "delegate.read-only") } else { ("ask", D, "read.outside") });
    }
    out
}


fn ctx_for(fx: &Fx, c: &Value) -> PolicyContext {
    let mode = match c["mode"].as_str().unwrap() {
        "readOnly" => PermissionMode::ReadOnly,
        "ask" => PermissionMode::Ask,
        "automatic" => PermissionMode::Automatic,
        "bypass" => PermissionMode::Bypass,
        _ => PermissionMode::Edit,
    };
    let mut ctx = ctx(fx, mode);
    ctx.strict_jail = c["strictJail"].as_bool().unwrap_or(false);
    ctx.delegation_cap = c["delegationCap"].as_u64().unwrap_or(12) as u32;
    for _ in 0..c["delegationUsed"].as_u64().unwrap_or(0) {
        assert!(ctx.delegation_used.try_take(u32::MAX));
    }
    if !c["delegates"].is_null() {
        let map: BTreeMap<String, DelegateRule> = serde_json::from_value(c["delegates"].clone()).unwrap();
        ctx.delegates = Some(map);
    }
    ctx.saved = serde_json::from_value(c["saved"].clone()).unwrap_or_default();
    ctx.saved_by_role = serde_json::from_value(c["savedByRole"].clone()).unwrap_or_default();
    ctx
}

fn intent_of(tool: &str, input: &Value, actor: Option<&Value>) -> ToolIntent {
    let mut i = ToolIntent::from_claude_tool(tool, input);
    i.actor = actor.map(|a| serde_json::from_value::<Actor>(a.clone()).unwrap());
    i
}

fn fixture_json() -> Value {
    let sets = sets();
    let cases: Vec<Value> = cases()
        .into_iter()
        .map(|c| {
            let actor = c.actor.map(|(role, id)| json!({"agentId": id, "role": role}));
            let intent = intent_of(c.tool, &c.input, actor.as_ref());
            json!({
                "name": c.name,
                "delegates": c.set.map(|s| sets[s].clone()).unwrap_or(Value::Null),
                "ctx": {"mode": c.mode, "strictJail": c.strict_jail, "delegationCap": c.cap, "delegationUsed": c.used, "strictBackground": c.strict_background, "saved": c.saved, "savedByRole": c.saved_by_role},
                "actor": actor,
                "tool": c.tool,
                "input": c.input,
                "intent": serde_json::to_value(&intent).unwrap(),
                "expected": {"decision": c.expect.0, "by": c.expect.1, "rule": c.expect.2},
            })
        })
        .collect();
    json!({"cases": cases})
}

/// The fixture file's text; with `INTELY_WRITE_FIXTURES` set it is rewritten from the table first (once per process).
fn fixture_text() -> (String, String) {
    static WRITE: std::sync::Once = std::sync::Once::new();
    let want = serde_json::to_string_pretty(&fixture_json()).unwrap() + "\n";
    WRITE.call_once(|| {
        if std::env::var("INTELY_WRITE_FIXTURES").is_ok() {
            std::fs::write(fixture_path(), &want).unwrap();
        }
    });
    let have = std::fs::read_to_string(fixture_path()).expect("packages/protocol/fixtures/delegation-cases.json (INTELY_WRITE_FIXTURES=1 writes it)");
    (have, want)
}

#[test]
fn the_golden_fixture_is_up_to_date() {
    let (have, want) = fixture_text();
    assert_eq!(have, want, "delegation-cases.json is stale: run with INTELY_WRITE_FIXTURES=1");
}

fn name_of(by: DecidedBy) -> &'static str {
    match by {
        DecidedBy::HardStop => "hardStop",
        DecidedBy::RoleDeny => "roleDeny",
        DecidedBy::Saved => "saved",
        DecidedBy::User => "user",
        DecidedBy::Default => "default",
        DecidedBy::FailClosed => "failClosed",
    }
}

fn decision_name(d: Decision) -> &'static str {
    match d {
        Decision::Allow => "allow",
        Decision::Deny => "deny",
        Decision::Ask => "ask",
    }
}

#[test]
fn every_golden_case_is_decided_as_recorded() {
    let fx = fx();
    let file: Value = serde_json::from_str(&fixture_text().0).unwrap();
    let cases = file["cases"].as_array().unwrap();
    assert!(cases.len() >= 90, "{}", cases.len());
    for c in cases {
        let mut full = c["ctx"].clone();
        full["delegates"] = c["delegates"].clone();
        let ctx = ctx_for(&fx, &full);
        let intent: ToolIntent = serde_json::from_value(c["intent"].clone()).unwrap();
        let req = PolicyRequest { agent_id: "a1".into(), tool_id: "t1".into(), provider: "claude".into(), intent };
        let d = decide_with(&ctx, &req, c["ctx"]["strictBackground"].as_bool().unwrap_or(false));
        let got = (decision_name(d.decision), name_of(d.by), d.rule.clone().unwrap_or_default());
        let want = (c["expected"]["decision"].as_str().unwrap(), c["expected"]["by"].as_str().unwrap(), c["expected"]["rule"].as_str().unwrap().to_string());
        assert_eq!(got, want, "{}: {d:?}", c["name"]);
    }
}

fn standard_ctx(fx: &Fx) -> PolicyContext {
    let sets = sets();
    let mut c = ctx(fx, PermissionMode::Edit);
    c.strict_jail = true;
    c.delegates = Some(serde_json::from_value(sets["standard"].clone()).unwrap());
    c
}

fn req(intent: ToolIntent) -> PolicyRequest {
    request(intent)
}

#[test]
fn commit_push_and_stage_all_are_hard_stops_for_every_role_and_for_the_lead() {
    let fx = fx();
    let c = standard_ctx(&fx);
    let roles: Vec<String> = c.delegates.as_ref().unwrap().keys().cloned().collect();
    let cmds = ["git commit -m x", "git push origin HEAD", "/usr/bin/git push", "git add -A", "git add .", "env git push", "sh -c 'git commit -m x'"];
    for role in roles.iter().map(String::as_str).chain(["?", "ghost", ""]) {
        for cmd in cmds {
            let mut intent = ToolIntent::from_claude_tool("Bash", &json!({"command": cmd}));
            if !role.is_empty() {
                intent.actor = Some(Actor { agent_id: "x".into(), role: role.into() });
            }
            let d = decide(&c, &req(intent));
            assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop), "{role} {cmd}: {d:?}");
        }
    }
}

#[test]
fn two_parallel_agent_calls_at_cap_minus_one_admit_exactly_one() {
    let fx = fx();
    for round in 0..50 {
        let mut c = standard_ctx(&fx);
        c.delegation_cap = 3;
        for _ in 0..2 {
            assert_eq!(decide(&c, &req(ToolIntent::from_claude_tool("Agent", &json!({"subagent_type": "researcher", "run_in_background": false})))).decision, Decision::Allow);
        }
        let c = Arc::new(c);
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let c = c.clone();
                std::thread::spawn(move || decide(&c.clone(), &req(ToolIntent::from_claude_tool("Agent", &json!({"subagent_type": "writer", "run_in_background": false})))).decision)
            })
            .collect();
        let allowed = handles.into_iter().map(|h| h.join().unwrap()).filter(|d| *d == Decision::Allow).count();
        assert_eq!(allowed, 1, "round {round}: exactly one of the parallel calls fits under the cap");
        assert_eq!(c.delegation_used.get(), 3);
    }
}

#[test]
fn a_clone_of_the_context_counts_with_the_original() {
    let fx = fx();
    let c = standard_ctx(&fx);
    let clone = c.clone();
    let agent = || req(ToolIntent::from_claude_tool("Agent", &json!({"subagent_type": "researcher", "run_in_background": false})));
    assert_eq!(decide(&clone, &agent()).decision, Decision::Allow);
    assert_eq!(c.delegation_used.get(), 1, "the clone shares the counter");
    assert_eq!(c, c.clone());
}

#[test]
fn a_context_survives_a_json_round_trip() {
    let fx = fx();
    let c = standard_ctx(&fx);
    let back: PolicyContext = serde_json::from_value(serde_json::to_value(&c).unwrap()).unwrap();
    assert_eq!(back, c);
    let old: PolicyContext = serde_json::from_value(json!({"mode": "edit", "cwd": "/x"})).unwrap();
    assert!(old.delegates.is_none() && old.delegation_cap == 12 && old.delegation_used.get() == 0, "contexts written before delegation still load");
}

/// A tiny deterministic generator (the crate has no rand dependency).
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.next() as usize % items.len()]
    }
}

#[test]
fn a_read_only_actor_is_never_allowed_to_write_run_or_reach_the_network() {
    let fx = fx();
    let c = standard_ctx(&fx);
    let mut rng = Lcg(0xde1e6a7e);
    let actors = ["ro", "researcher", "scout", "empty", "?", "ghost", "Explore", "RO", "", "researcher "];
    let tools: [(&str, Value); 14] = [
        ("Edit", json!({"file_path": "src/a.ts"})),
        ("Write", json!({"file_path": "src/new.ts"})),
        ("MultiEdit", json!({"file_path": "src/a.ts"})),
        ("NotebookEdit", json!({"notebook_path": "n.ipynb"})),
        ("Bash", json!({"command": "npm test"})),
        ("Bash", json!({"command": "ls"})),
        ("Bash", json!({"command": "cat src/a.ts"})),
        ("Monitor", json!({"command": "tail -f x"})),
        ("WebFetch", json!({"url": "https://docs.rs/serde"})),
        ("WebSearch", json!({"query": "x"})),
        ("mcp__github__create_issue", json!({})),
        ("SomethingNew", json!({"command": "rm -rf x"})),
        ("Edit", json!({"file_path": "/tmp/x"})),
        ("Write", json!({"file_path": ".husky/pre-commit"})),
    ];
    let mut cc = c.clone();
    cc.mcp_servers = vec!["github".into()];
    for _ in 0..4_000 {
        let actor = *rng.pick(&actors);
        let (tool, input) = rng.pick(&tools);
        let mut intent = ToolIntent::from_claude_tool(tool, input);
        if !actor.is_empty() {
            intent.actor = Some(Actor { agent_id: "x".into(), role: actor.into() });
        }
        let d = decide(&cc, &req(intent));
        if !actor.is_empty() {
            let reaches_net = matches!(*tool, "WebFetch" | "WebSearch");
            let low_risk_read = *tool == "Bash" && matches!(input["command"].as_str(), Some("ls" | "cat src/a.ts"));
            if reaches_net && actor == "scout" {
                // the one explicit exception: a read-only delegate that lists a web tool may ASK, never be allowed
                assert_ne!(d.decision, Decision::Allow, "{actor} {tool}: {d:?}");
            } else if low_risk_read && actor == "ro" {
                // permission-modes spec GZ-1: a read-only delegate with Bash may run a low-risk read command
                assert_eq!((d.decision, d.rule.as_deref()), (Decision::Allow, Some("exec.low-risk-read")), "{actor} {tool} {input}: {d:?}");
            } else {
                assert_eq!(d.decision, Decision::Deny, "{actor} {tool} {input}: {d:?}");
            }
        }
    }
}

#[test]
fn a_read_only_delegate_listing_a_web_tool_asks_but_a_saved_host_never_allows_it() {
    let fx = fx();
    let mut c = standard_ctx(&fx);
    c.saved_by_role.insert("scout".into(), vec![SavedAllow::NetHost { host: "docs.rs".into() }]);
    let mut intent = ToolIntent::from_claude_tool("WebFetch", &json!({"url": "https://docs.rs/serde"}));
    intent.actor = Some(Actor { agent_id: "x".into(), role: "scout".into() });
    let d = decide(&c, &req(intent.clone()));
    assert_eq!((d.decision, d.rule.as_deref()), (Decision::Ask, Some("net.ask")));
    intent.url = Some(format!("https://docs.rs/{}", "a".repeat(400)));
    assert_eq!(decide(&c, &req(intent)).rule.as_deref(), Some("net.exfil-shape"), "the exfil-shape rule still applies");
}

#[test]
fn the_deny_reason_of_a_wrong_type_names_the_valid_roles() {
    let fx = fx();
    let c = standard_ctx(&fx);
    let d = decide(&c, &req(ToolIntent::from_claude_tool("Agent", &json!({"subagent_type": "general-purpose", "run_in_background": false}))));
    assert!(d.reason.contains("researcher") && d.reason.contains("writer"), "{}", d.reason);
}

#[test]
fn strict_background_is_off_because_the_foreground_is_forced_twice() {
    use intely_agent_core::policy::decide::STRICT_BACKGROUND;
    let fx = fx();
    let c = standard_ctx(&fx);
    let omitted = req(ToolIntent::from_claude_tool("Agent", &json!({"subagent_type": "researcher"})));
    let d = decide(&c, &omitted);
    assert_eq!(d.decision == Decision::Allow, !STRICT_BACKGROUND, "{d:?}");
    assert_eq!(decide_with(&c, &omitted, false).decision, Decision::Allow);
    assert!(!STRICT_BACKGROUND);
    assert_eq!(decide_with(&c, &omitted, true).rule.as_deref(), Some("delegate.background"));
    // an explicit `true` stays denied with the flag off
    let explicit = req(ToolIntent::from_claude_tool("Agent", &json!({"subagent_type": "researcher", "run_in_background": true})));
    let d = decide(&c, &explicit);
    assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("delegate.background")), "{d:?}");
}

#[test]
fn delegate_mode_follows_the_table_of_spec_3() {
    use intely_agent_core::policy::decide::delegate_mode;
    use PermissionMode::*;
    // (run, role, capped) -> mode, the 20 cells of the table plus the capped column
    let table: [(PermissionMode, [PermissionMode; 3], PermissionMode); 5] = [
        (ReadOnly, [ReadOnly, ReadOnly, ReadOnly], ReadOnly),
        (Ask, [ReadOnly, Ask, Ask], Ask),
        (Edit, [ReadOnly, Ask, Edit], Ask),
        (Automatic, [ReadOnly, Automatic, Automatic], ReadOnly),
        (Bypass, [ReadOnly, Bypass, Bypass], ReadOnly),
    ];
    for (run, [ro, ask, edit], capped) in table {
        assert_eq!(delegate_mode(run, ReadOnly, false), ro, "{run:?} x readOnly");
        assert_eq!(delegate_mode(run, Ask, false), ask, "{run:?} x ask");
        assert_eq!(delegate_mode(run, Edit, false), edit, "{run:?} x edit");
        assert_eq!(delegate_mode(run, Edit, true), capped, "{run:?} x capped");
        assert_eq!(delegate_mode(run, Ask, true), capped, "{run:?} x capped ask");
    }
}

#[test]
fn an_uncapped_repository_role_is_lifted_and_a_capped_one_is_held_read_only_in_an_unattended_run() {
    let fx = fx();
    let delegates = |capped: bool| -> BTreeMap<String, DelegateRule> {
        BTreeMap::from([("repo".to_string(), DelegateRule { mode: PermissionMode::Ask, allowed_tools: None, role_deny: Vec::new(), capped })])
    };
    let as_repo = |tool: &str, input: Value| {
        let mut i = ToolIntent::from_claude_tool(tool, &input);
        i.actor = Some(Actor { agent_id: "x".into(), role: "repo".into() });
        i
    };
    for mode in [PermissionMode::Automatic, PermissionMode::Bypass] {
        let mut c = ctx(&fx, mode);
        c.delegates = Some(delegates(false));
        let d = decide(&c, &req(as_repo("Edit", json!({"file_path": "src/a.ts"}))));
        assert_eq!(d.decision, Decision::Allow, "{mode:?} uncapped: {d:?}");
        c.delegates = Some(delegates(true));
        let d = decide(&c, &req(as_repo("Edit", json!({"file_path": "src/a.ts"}))));
        assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("role.read-only")), "{mode:?} capped write: {d:?}");
        assert_eq!(decide(&c, &req(as_repo("Read", json!({"file_path": "src/a.ts"})))).decision, Decision::Allow, "a read inside stays possible");
        assert_eq!(decide(&c, &req(as_repo("Bash", json!({"command": "git status"})))).rule.as_deref(), Some("exec.low-risk-read"));
        assert_eq!(decide(&c, &req(as_repo("Bash", json!({"command": "npm test"})))).rule.as_deref(), Some("role.read-only"));
        let d = decide(&c, &req(as_repo("Read", json!({"file_path": "/etc/hosts"}))));
        assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("delegate.read-only")), "{mode:?}: {d:?}");
        assert!(d.reason.contains("Settings > Roles"), "{}", d.reason);
    }
}
