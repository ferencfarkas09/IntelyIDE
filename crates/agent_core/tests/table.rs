//! providers-plan 5.4: one row per line of the ToolIntent table, driven through the Claude tool mapping.

mod common;

use common::*;
use intely_agent_core::events::types::DecidedBy::{self, *};
use intely_agent_core::policy::decide::Decision::{self, *};
use intely_agent_core::policy::decide::{PolicyContext, SavedAllow};
use intely_agent_core::providers::PermissionMode::{self, Automatic, Bypass, Edit, ReadOnly};
use serde_json::{json, Value};

type Setup = fn(&mut PolicyContext);

struct Row {
    label: &'static str,
    tool: &'static str,
    input: Value,
    mode: PermissionMode,
    setup: Setup,
    expect: (Decision, DecidedBy),
}

fn none(_: &mut PolicyContext) {}

fn row(label: &'static str, tool: &'static str, input: Value, mode: PermissionMode, expect: (Decision, DecidedBy)) -> Row {
    Row { label, tool, input, mode, setup: none, expect }
}

fn rows() -> Vec<Row> {
    let saved_status: Setup = |c| c.saved.push(SavedAllow::ExecPrefix { argv: vec!["git".into(), "status".into()] });
    let saved_all_git: Setup = |c| {
        c.saved.push(SavedAllow::ExecPrefix { argv: vec!["git".into()] });
        c.saved.push(SavedAllow::ExecPrefix { argv: vec!["sh".into()] });
    };
    let saved_host: Setup = |c| c.saved.push(SavedAllow::NetHost { host: "docs.rs".into() });
    let mcp_set: Setup = |c| c.mcp_servers = vec!["github".into()];
    let mcp_saved: Setup = |c| {
        c.mcp_servers = vec!["github".into()];
        c.saved.push(SavedAllow::McpTool { server: "github".into(), tool: "get_issue".into() });
    };
    let role_deny_bash: Setup = |c| c.role_deny = vec!["Bash".into()];
    let role_deny_web: Setup = |c| c.role_deny = vec!["Web*".into()];
    let subagents: Setup = |c| c.subagents = vec!["researcher".into()];
    let b = |label, cmd: &'static str, mode, expect| row(label, "Bash", json!({ "command": cmd }), mode, expect);
    vec![
        // Bash / exec
        b("exec: plain command asks", "npm test", Edit, (Ask, Default)),
        b("exec: git status is a low-risk read", "git status", Edit, (Allow, Default)),
        b("exec: env prefix is not a low-risk read", "FOO=bar git status", Edit, (Ask, Default)),
        b("exec: redirect into an eslint config asks", "echo x > .eslintrc.js", Edit, (Ask, Default)),
        b("exec: tee -a into package.json asks", "printf x | tee -a package.json", PermissionMode::Ask, (Ask, Default)),
        b("exec: tee -a into package.json runs in Automatic", "printf x | tee -a package.json", Automatic, (Allow, Default)),
        b("exec: tee -a into package.json runs in Bypass", "printf x | tee -a package.json", Bypass, (Allow, Default)),
        b("exec: reading an exec-surface file is a low-risk read", "cat vite.config.ts", Edit, (Allow, Default)),
        b("exec: PAGER prefix is a hard stop", "PAGER=evil git log", Edit, (Deny, HardStop)),
        b("exec: git status asks in an ask role", "git status", PermissionMode::Ask, (Ask, Default)),
        b("exec: git add still asks", "git add file.txt", Edit, (Ask, Default)),
        b("exec: absolute git push", "/usr/bin/git push origin HEAD", Edit, (Deny, HardStop)),
        b("exec: sh -c git commit", "sh -c \"git commit -m x\"", Edit, (Deny, HardStop)),
        b("exec: env git push", "env git push", Edit, (Deny, HardStop)),
        b("exec: git -C x commit", "git -C x commit -m y", Edit, (Deny, HardStop)),
        b("exec: reset --hard", "git reset --hard HEAD~1", Edit, (Deny, HardStop)),
        b("exec: add -A", "git add -A", Edit, (Deny, HardStop)),
        b("exec: add .", "git add .", Edit, (Deny, HardStop)),
        b("exec: -c user.*", "git -c user.name=x status", Edit, (Deny, HardStop)),
        b("exec: update-ref", "git update-ref refs/heads/main HEAD", Edit, (Deny, HardStop)),
        b("exec: cherry-pick", "git cherry-pick abc", Edit, (Deny, HardStop)),
        b("exec: rebase", "git rebase main", Edit, (Deny, HardStop)),
        b("exec: merge", "git merge feature", Edit, (Deny, HardStop)),
        b("exec: notes", "git notes add -m x", Edit, (Deny, HardStop)),
        b("exec: gh pr merge", "gh pr merge 12 --squash", Edit, (Deny, HardStop)),
        b("exec: unparseable asks", "echo $(date)", Edit, (Ask, Default)),
        b("exec: plan runs a low-risk read", "ls", ReadOnly, (Allow, Default)),
        b("exec: plan denies a command that is not a read", "npm test", ReadOnly, (Deny, RoleDeny)),
        b("exec: hard stop beats read-only role", "git push", ReadOnly, (Deny, HardStop)),
        b("exec: automatic runs a script runner", "npm test", Automatic, (Allow, Default)),
        b("exec: bypass runs a script runner", "npm test", Bypass, (Allow, Default)),
        Row { setup: saved_status, ..b("exec: saved prefix allows", "git status --short", Edit, (Allow, Saved)) },
        Row { setup: saved_status, ..b("exec: saved prefix does not cover a second command", "git status && rm -rf x", Edit, (Ask, Default)) },
        Row { setup: saved_status, ..b("exec: saved prefix does not cover other verbs", "git remote show origin", Edit, (Ask, Default)) },
        Row { setup: saved_status, ..b("exec: saved never applies to unparseable", "git status $(rm -rf x)", Edit, (Ask, Default)) },
        Row { setup: saved_all_git, ..b("exec: saved never applies to sh -c", "sh -c 'git status'", Edit, (Ask, Default)) },
        Row { setup: saved_all_git, ..b("exec: a permissive saved allow cannot unlock git commit", "git commit -m x", Edit, (Deny, HardStop)) },
        Row { setup: saved_all_git, ..b("exec: a permissive saved allow cannot unlock git push", "git push", Edit, (Deny, HardStop)) },
        Row { setup: role_deny_bash, ..b("exec: role deny list", "ls", Edit, (Deny, RoleDeny)) },
        Row { setup: role_deny_bash, ..b("exec: hard stop is reported before role deny", "git push", Edit, (Deny, HardStop)) },
        // Edit / Write / MultiEdit / NotebookEdit
        row("write: inside in an edit role", "Edit", json!({"file_path": "src/a.ts"}), Edit, (Allow, Default)),
        row("write: Write inside", "Write", json!({"file_path": "src/new.ts"}), Edit, (Allow, Default)),
        row("write: MultiEdit inside", "MultiEdit", json!({"file_path": "src/a.ts"}), Edit, (Allow, Default)),
        row("write: NotebookEdit inside", "NotebookEdit", json!({"notebook_path": "n.ipynb"}), Edit, (Allow, Default)),
        row("write: .husky/pre-commit", "Write", json!({"file_path": ".husky/pre-commit"}), Edit, (Deny, HardStop)),
        row("write: .git/config", "Edit", json!({"file_path": ".git/config"}), Edit, (Deny, HardStop)),
        row("write: .git/hooks", "Write", json!({"file_path": ".git/hooks/pre-push"}), Edit, (Deny, HardStop)),
        row("write: .claude settings", "Write", json!({"file_path": ".claude/settings.local.json"}), Edit, (Deny, HardStop)),
        row("write: lockfile", "Edit", json!({"file_path": "pnpm-lock.yaml"}), Edit, (Deny, HardStop)),
        row("write: nested lockfile", "Edit", json!({"file_path": "apps/x/package-lock.json"}), Edit, (Deny, HardStop)),
        row("write: .env", "Write", json!({"file_path": ".env"}), Edit, (Deny, HardStop)),
        row("write: .env.production", "Write", json!({"file_path": "api/.env.production"}), Edit, (Deny, HardStop)),
        row("write: dot-dot into .git", "Write", json!({"file_path": "src/../.git/HEAD"}), Edit, (Deny, HardStop)),
        row("write: hard stop beats read-only role", "Write", json!({"file_path": ".git/config"}), ReadOnly, (Deny, HardStop)),
        row("write: outside the working directory asks", "Write", json!({"file_path": "/tmp/elsewhere.txt"}), Edit, (Ask, Default)),
        row("write: read-only role denies", "Edit", json!({"file_path": "src/a.ts"}), ReadOnly, (Deny, RoleDeny)),
        row("write: ask role asks", "Edit", json!({"file_path": "src/a.ts"}), PermissionMode::Ask, (Ask, Default)),
        row("write: no path asks", "Edit", json!({}), Edit, (Ask, Default)),
        // Read / Grep / Glob / LS
        row("read: inside", "Read", json!({"file_path": "src/a.ts"}), Edit, (Allow, Default)),
        row("read: inside in a read-only role", "Read", json!({"file_path": "src/a.ts"}), ReadOnly, (Allow, Default)),
        row("read: Grep without path", "Grep", json!({"pattern": "x"}), ReadOnly, (Allow, Default)),
        row("read: LS inside", "LS", json!({"path": "sub"}), Edit, (Allow, Default)),
        row("read: Glob relative", "Glob", json!({"pattern": "**/*.ts"}), Edit, (Allow, Default)),
        row("read: .env is on the never-read list", "Read", json!({"file_path": ".env"}), Edit, (Deny, HardStop)),
        row("read: key file", "Read", json!({"file_path": "certs/server.pem"}), Edit, (Deny, HardStop)),
        row("read: .env.example is fine", "Read", json!({"file_path": ".env.example"}), Edit, (Allow, Default)),
        row("read: .git is readable", "Read", json!({"file_path": ".git/HEAD"}), Edit, (Allow, Default)),
        row("read: outside asks", "Read", json!({"file_path": "/etc/hosts"}), Edit, (Ask, Default)),
        row("read: absolute Glob pattern outside asks", "Glob", json!({"pattern": "/etc/*"}), Edit, (Ask, Default)),
        row("read: ssh keys via ~ are never read", "Read", json!({"file_path": "~/.ssh/id_ed25519"}), Edit, (Deny, HardStop)),
        // WebFetch / WebSearch
        row("net: first fetch asks", "WebFetch", json!({"url": "https://docs.rs/serde"}), Edit, (Ask, Default)),
        row("net: search asks", "WebSearch", json!({"query": "rust serde"}), Edit, (Ask, Default)),
        row("net: a plan lead asks for the web", "WebFetch", json!({"url": "https://docs.rs/serde"}), ReadOnly, (Ask, Default)),
        row("net: automatic fetches a public host", "WebFetch", json!({"url": "https://docs.rs/serde"}), Automatic, (Allow, Default)),
        row("net: bypass fetches", "WebFetch", json!({"url": "http://localhost:3000/x"}), Bypass, (Allow, Default)),
        Row { setup: saved_host, ..row("net: saved host allows", "WebFetch", json!({"url": "https://DOCS.rs/x?y=1"}), Edit, (Allow, Saved)) },
        Row { setup: saved_host, ..row("net: other host still asks", "WebFetch", json!({"url": "https://evil.example/x"}), Edit, (Ask, Default)) },
        Row { setup: saved_host, ..row("net: look-alike host still asks", "WebFetch", json!({"url": "https://docs.rs.evil.example/x"}), Edit, (Ask, Default)) },
        Row { setup: saved_host, ..row("net: userinfo URL never saved", "WebFetch", json!({"url": "https://docs.rs@evil.example/x"}), Edit, (Ask, Default)) },
        Row { setup: role_deny_web, ..row("net: role deny glob", "WebFetch", json!({"url": "https://docs.rs"}), Edit, (Deny, RoleDeny)) },
        // mcp__<server>__<tool>
        row("mcp: server outside the IDE set", "mcp__slack__post_message", json!({}), Edit, (Deny, RoleDeny)),
        Row { setup: mcp_set, ..row("mcp: server in the set asks", "mcp__github__create_issue", json!({}), Edit, (Ask, Default)) },
        // the learned table is the single source of read-only (mcp-management spec 5.4): a saved allow now applies to any tool
        Row { setup: mcp_saved, ..row("mcp: a saved session allow applies to any tool of the server", "mcp__github__get_issue", json!({}), Edit, (Allow, Saved)) },
        Row { setup: mcp_set, ..row("mcp: read-only role denies unannotated tools", "mcp__github__get_issue", json!({}), ReadOnly, (Deny, RoleDeny)) },
        // Task / Agent and UI cards
        Row { setup: subagents, ..row("other: listed subagent", "Task", json!({"subagent_type": "researcher"}), Edit, (Allow, Default)) },
        Row { setup: subagents, ..row("other: Agent alias", "Agent", json!({"subagent_type": "researcher"}), Edit, (Allow, Default)) },
        Row { setup: subagents, ..row("other: unlisted subagent asks", "Task", json!({"subagent_type": "developer"}), Edit, (Ask, Default)) },
        row("other: no subagents listed asks", "Task", json!({"subagent_type": "researcher"}), Edit, (Ask, Default)),
        row("other: TodoWrite", "TodoWrite", json!({}), ReadOnly, (Allow, Default)),
        row("other: ExitPlanMode in a read-only role asks", "ExitPlanMode", json!({}), ReadOnly, (Ask, Default)),
        row("other: ExitPlanMode in an edit role", "ExitPlanMode", json!({}), Edit, (Allow, Default)),
        row("other: AskUserQuestion", "AskUserQuestion", json!({}), Edit, (Allow, Default)),
        row("other: unknown tool asks", "SomethingNew", json!({}), Edit, (Ask, Default)),
    ]
}

#[test]
fn every_row_of_the_5_4_table() {
    let fx = fx();
    for r in rows() {
        let mut c = ctx(&fx, r.mode);
        (r.setup)(&mut c);
        let d = decide_tool(&c, r.tool, r.input.clone());
        assert_eq!((d.decision, d.by), r.expect, "{}: {d:?}", r.label);
    }
}

#[test]
fn the_table_covers_every_class_and_mode() {
    let labels: Vec<_> = rows().into_iter().map(|r| r.label).collect();
    for prefix in ["exec:", "write:", "read:", "net:", "mcp:", "other:"] {
        assert!(labels.iter().filter(|l| l.starts_with(prefix)).count() >= 4, "{prefix}");
    }
    assert!(labels.len() >= 75, "{}", labels.len());
}
