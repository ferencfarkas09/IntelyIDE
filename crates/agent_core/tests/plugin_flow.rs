//! The flow of the Claude plugin in an IDE, as the owner wants the agent to run (2026-10-06): shell commands that `cd` between the
//! repositories of the run, python heredocs that edit files, `npx eslint | grep | tail` pipelines, `git show > /tmp/x`, `git add
//! <file>`, `git diff --stat`, `git status --porcelain`, scratch files in /tmp. In Automatic and Bypass none of this may stop at a
//! prompt; the hard stops (commit, push, stage-all, .git, secrets) stay.

mod common;

use common::*;
use intely_agent_core::policy::decide::{Decision, PolicyContext};
use intely_agent_core::providers::PermissionMode;

struct Flow {
    admin: String,
    app: String,
    fx: Fx,
}

fn flow() -> Flow {
    let fx = fx();
    // two sibling repositories of one run: `admin` is the working directory, `app` an added directory
    let root = fx.cwd.clone();
    let admin = root.join("admin");
    let app = root.join("app");
    for d in [&admin, &app] {
        std::fs::create_dir_all(d.join("src/pwa")).unwrap();
        std::fs::create_dir_all(d.join(".git")).unwrap();
        std::fs::write(d.join("package.json"), "{\"scripts\":{\"test\":\"jest\"}}").unwrap();
    }
    std::fs::create_dir_all(admin.join("public/.well-known")).unwrap();
    Flow { admin: admin.display().to_string(), app: app.display().to_string(), fx }
}

fn ctx_of(f: &Flow, mode: PermissionMode) -> PolicyContext {
    let mut c = PolicyContext::new(mode, &f.admin);
    c.add_dirs = vec![std::path::PathBuf::from(&f.app)];
    c.home = Some(f.fx.cwd.join("home"));
    c.scratch_dirs = vec![std::path::PathBuf::from("/tmp"), std::path::PathBuf::from("/private/tmp")];
    c
}

fn commands(f: &Flow) -> Vec<(&'static str, String)> {
    let (admin, app) = (&f.admin, &f.app);
    vec![
        (
            "python heredoc edit",
            format!("cd {admin}; python3 - <<'EOF'\np='public/.well-known/apple-app-site-association'\ns=open(p).read()\nold='''a'''\nnew='''b'''\nopen(p,'w').write(s.replace(old,new))\nprint('AASA json ok')\nEOF"),
        ),
        ("eslint across repos", format!("cd {admin}; npx eslint src/pwa/openInAppPrompt.js src/pwa/openInAppPrompt.test.js 2>&1 | grep -v \"npm warn\" | tail -15; cd ../app; npx eslint app/helpers/deepLink/adminLinkNavigation.js 2>&1 | grep -v \"npm warn\" | tail -10")),
        ("git show to /tmp, cp, eslint, rm", format!("cd {admin}; git show HEAD:src/pwa/openInAppPrompt.js > /tmp/oiap_head.js; cp /tmp/oiap_head.js src/pwa/__head_tmp.js; npx eslint src/pwa/__head_tmp.js 2>&1 | grep -c error; rm src/pwa/__head_tmp.js")),
        ("python re edit + jest", format!("cd {admin}; python3 - <<'EOF'\nimport re\np='src/pwa/openInAppPrompt.js'\ns=open(p).read()\nfor a,b in [('{{android = false}} = {{}}', '{{ android = false }} = {{}}')]:\n    s=s.replace(a,b)\nopen(p,'w').write(s)\nEOF\nnpx jest src/pwa/openInAppPrompt.test.js 2>&1 | tail -20")),
        ("git add file + diff stat + status", format!("cd {admin}; git add src/pwa/openInAppPrompt.test.js && git --no-pager diff --stat -- src/pwa public/.well-known; git status --porcelain -- src/pwa; cd ../app && git --no-pager diff --stat -- app/helpers/deepLink")),
        ("plain git read commands", format!("cd {admin} && git log --oneline -5 && git diff HEAD --stat && git config --get remote.origin.url && git rev-parse HEAD")),
        ("npm run in the other repo", format!("cd {app} && npm run lint 2>&1 | tail -20")),
    ]
}

fn assert_all(f: &Flow, mode: PermissionMode, want: Decision, rule: &str) {
    let misses: Vec<String> = commands(f)
        .into_iter()
        .filter_map(|(name, cmd)| {
            let d = bash(&ctx_of(f, mode), &cmd);
            (!(d.decision == want && d.rule.as_deref() == Some(rule))).then(|| format!("{mode:?} {name}: want {want:?}/{rule}, got {:?}/{:?} ({})", d.decision, d.rule, d.reason))
        })
        .collect();
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

#[test]
fn automatic_runs_the_whole_plugin_style_flow_without_a_prompt() {
    assert_all(&flow(), PermissionMode::Automatic, Decision::Allow, "exec.auto");
}

#[test]
fn bypass_runs_it_too() {
    assert_all(&flow(), PermissionMode::Bypass, Decision::Allow, "exec.bypass");
}

#[test]
fn edit_still_asks_for_commands_and_a_saved_prefix_is_the_way_to_stop_asking() {
    assert_all(&flow(), PermissionMode::Edit, Decision::Ask, "exec.ask");
}

#[test]
fn the_hard_stops_hold_inside_the_same_flow_in_every_unattended_mode() {
    let f = flow();
    let admin = &f.admin;
    for mode in [PermissionMode::Automatic, PermissionMode::Bypass] {
        for cmd in [
            format!("cd {admin}; git add -A && git commit -m x"),
            format!("cd {admin}; git add src/pwa/x.js && git push origin HEAD"),
            format!("cd {admin}; git add ."),
            format!("cd {admin}; python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['git','commit','-m','x'])\nEOF"),
            format!("cd {admin}; python3 -c \"print(open('.env').read())\""),
            format!("cd {admin}; cat ~/.ssh/id_rsa"),
            format!("cd {admin}; echo x > .git/hooks/pre-commit"),
        ] {
            let d = bash(&ctx_of(&f, mode), &cmd);
            assert!(d.decision == Decision::Deny && d.by == intely_agent_core::events::types::DecidedBy::HardStop, "{mode:?} {cmd:?} must be a hard stop, got {:?}/{:?} {}", d.decision, d.rule, d.reason);
        }
    }
}

#[test]
fn scratch_is_for_plain_temporary_files_in_automatic_only() {
    let f = flow();
    let auto = ctx_of(&f, PermissionMode::Automatic);
    // a file of the user's in /tmp, written and read with the file tools and with the shell
    for cmd in ["echo x > /tmp/scratch.txt", "cat /tmp/scratch.txt", "cp /tmp/a.js src/b.js", "mkdir -p /tmp/work/sub && ls /tmp/work"] {
        let d = bash(&auto, cmd);
        assert!(d.decision == Decision::Allow, "{cmd}: {:?}/{:?} {}", d.decision, d.rule, d.reason);
    }
    assert_eq!(decide_tool(&auto, "Write", serde_json::json!({ "file_path": "/tmp/notes.md", "content": "x" })).decision, Decision::Allow);
    assert_eq!(decide_tool(&auto, "Read", serde_json::json!({ "file_path": "/tmp/notes.md" })).decision, Decision::Allow);
    // not scratch: the root itself, hidden entries, other tools' state (Claude task output and transcripts), the IDE's own folders
    for cmd in ["ls /tmp", "cat /tmp/.hidden", "cat /private/tmp/claude-502/session/tasks/x.output", "cat /tmp/intely-state/x", "echo x > /tmp"] {
        let d = bash(&auto, cmd);
        assert!(d.decision == Decision::Deny, "{cmd}: {:?}/{:?}", d.decision, d.rule);
    }
    // scratch is no way around the lists: a secret-looking file name is refused there too
    let d = decide_tool(&auto, "Read", serde_json::json!({ "file_path": "/tmp/id_rsa" }));
    assert!(d.decision == Decision::Deny, "{:?}/{:?}", d.decision, d.rule);
    // the attended modes keep asking: scratch is an Automatic convenience
    let edit = ctx_of(&f, PermissionMode::Edit);
    assert_eq!(decide_tool(&edit, "Write", serde_json::json!({ "file_path": "/tmp/notes.md", "content": "x" })).decision, Decision::Ask, "Edit: a write outside the run's folders is asked about, scratch or not");
}

// ---- read-only sub-agents (the researcher / reviewer of the optimal role set) -------------------------------------------------------

fn researcher_ctx(f: &Flow, run: PermissionMode, web: bool) -> PolicyContext {
    use intely_agent_core::policy::decide::DelegateRule;
    let mut c = ctx_of(f, run);
    let mut tools: Vec<String> = ["Read", "Grep", "Glob", "Bash"].iter().map(|t| t.to_string()).collect();
    if web {
        tools.extend(["WebSearch".to_string(), "WebFetch".to_string()]);
    }
    c.delegates = Some(std::collections::BTreeMap::from([(
        "researcher".to_string(),
        DelegateRule { mode: PermissionMode::ReadOnly, allowed_tools: Some(tools), role_deny: Vec::new(), capped: false },
    )]));
    c
}

fn as_researcher(ctx: &PolicyContext, tool: &str, input: serde_json::Value) -> intely_agent_core::policy::decide::PolicyDecision {
    use intely_agent_core::policy::intent::{Actor, ToolIntent};
    let mut intent = ToolIntent::from_claude_tool(tool, &input);
    intent.actor = Some(Actor { agent_id: "sub-1".into(), role: "researcher".into() });
    decide_intent(ctx, intent)
}

#[test]
fn a_read_only_sub_agent_reads_searches_and_runs_read_only_commands_without_a_tool_error() {
    let f = flow();
    for run in [PermissionMode::Automatic, PermissionMode::Bypass, PermissionMode::Edit] {
        let c = researcher_ctx(&f, run, true);
        for cmd in ["git diff --stat", "git log --oneline -5", "ls src", "rg foo src", "cat package.json"] {
            let d = as_researcher(&c, "Bash", serde_json::json!({ "command": format!("cd {} && {cmd}", f.admin) }));
            assert!(d.decision == Decision::Allow, "{run:?} {cmd}: {:?}/{:?} {}", d.decision, d.rule, d.reason);
        }
        for tool in ["Read", "Grep", "Glob"] {
            let input = match tool {
                "Read" => serde_json::json!({ "file_path": format!("{}/package.json", f.admin) }),
                "Grep" => serde_json::json!({ "pattern": "scripts", "path": f.admin }),
                _ => serde_json::json!({ "pattern": "**/*.json", "path": f.admin }),
            };
            let d = as_researcher(&c, tool, input);
            assert!(d.decision == Decision::Allow, "{run:?} {tool}: {:?}/{:?} {}", d.decision, d.rule, d.reason);
        }
    }
}

#[test]
fn it_cannot_write_through_bash_and_is_told_what_works_instead() {
    let f = flow();
    for run in [PermissionMode::Automatic, PermissionMode::Bypass] {
        let c = researcher_ctx(&f, run, true);
        for cmd in ["npm test", "touch x", "echo x > a.txt", "python3 -c \"open('a','w')\"", "rm -rf node_modules"] {
            let d = as_researcher(&c, "Bash", serde_json::json!({ "command": format!("cd {} && {cmd}", f.admin) }));
            assert!(d.decision == Decision::Deny, "{run:?} {cmd}: {:?}/{:?}", d.decision, d.rule);
            assert!(d.reason.contains("this role is read-only") && d.reason.contains("Read, Grep and Glob"), "{}", d.reason);
        }
        let w = as_researcher(&c, "Write", serde_json::json!({ "file_path": format!("{}/x.txt", f.admin), "content": "x" }));
        assert!(w.decision == Decision::Deny, "{run:?}: {:?}/{:?}", w.decision, w.rule);
    }
}

#[test]
fn its_web_tools_work_in_a_run_nobody_answers_and_ask_in_an_attended_one_and_need_the_role_to_list_them() {
    let f = flow();
    let fetch = serde_json::json!({ "url": "https://docs.example.com/guide", "prompt": "summarise" });
    for run in [PermissionMode::Automatic, PermissionMode::Bypass] {
        let d = as_researcher(&researcher_ctx(&f, run, true), "WebFetch", fetch.clone());
        assert!(d.decision == Decision::Allow, "{run:?}: {:?}/{:?} {}", d.decision, d.rule, d.reason);
        let s = as_researcher(&researcher_ctx(&f, run, true), "WebSearch", serde_json::json!({ "query": "jest hasteImpl collision" }));
        assert!(s.decision == Decision::Allow, "{run:?} search: {:?}/{:?} {}", s.decision, s.rule, s.reason);
    }
    // an attended run still asks the person
    let asked = as_researcher(&researcher_ctx(&f, PermissionMode::Ask, true), "WebFetch", fetch.clone());
    assert!(asked.decision == Decision::Ask, "{:?}/{:?}", asked.decision, asked.rule);
    // a role that does not list the web tools never gets them, whatever the mode
    for run in [PermissionMode::Automatic, PermissionMode::Bypass, PermissionMode::Ask] {
        let d = as_researcher(&researcher_ctx(&f, run, false), "WebFetch", fetch.clone());
        assert!(d.decision == Decision::Deny, "{run:?}: {:?}/{:?}", d.decision, d.rule);
    }
    // private hosts stay refused in Automatic, also for a sub-agent
    let local = as_researcher(&researcher_ctx(&f, PermissionMode::Automatic, true), "WebFetch", serde_json::json!({ "url": "http://169.254.169.254/latest/meta-data", "prompt": "x" }));
    assert!(local.decision == Decision::Deny, "{:?}/{:?}", local.decision, local.rule);
}

#[test]
fn an_attended_ask_for_a_listed_command_carries_the_session_allow_offer_on_the_wire() {
    let f = flow();
    for mode in [PermissionMode::Ask, PermissionMode::Edit] {
        for cmd in ["touch twice", "git add src/pwa/x.js", "mkdir -p out"] {
            let d = bash(&ctx_of(&f, mode), cmd);
            assert_eq!(d.decision, Decision::Ask, "{mode:?} {cmd}");
            let json = serde_json::to_value(&d).unwrap();
            assert!(json.get("sessionAllow").is_some_and(|v| !v.is_null()), "{mode:?} {cmd}: {json}");
        }
    }
}

#[test]
fn the_offer_survives_the_context_the_host_really_builds() {
    let f = flow();
    let state = f.fx.cwd.join("state");
    std::fs::create_dir_all(state.join("attachments")).unwrap();
    for mode in [PermissionMode::Ask, PermissionMode::Edit] {
        let mut c = ctx_of(&f, mode);
        c.add_dirs.push(state.join("attachments"));
        c.home = std::env::var_os("HOME").map(std::path::PathBuf::from);
        c.state_dir = Some(state.clone());
        c.strict_jail = true;
        c.plan_dir = Some(state.join("plans").join("a1"));
        c.subagents = vec!["*".into()];
        let d = bash(&c, "touch twice");
        let json = serde_json::to_value(&d).unwrap();
        assert!(json.get("sessionAllow").is_some_and(|v| !v.is_null()), "{mode:?}: {json}");
    }
}
