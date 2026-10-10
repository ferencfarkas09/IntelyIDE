//! The remote-eligibility table (remote-plan 4.1) and the strict `low` allow-list.

use intely_agent_core::hub::Eligibility::{self, DesktopOnly, Low, StepUp};
use intely_agent_core::policy::decide::PolicyContext;
use intely_agent_core::policy::intent::ToolIntent;
use intely_agent_core::providers::PermissionMode;
use intely_remote::policy::*;
use intely_remote::wire::Capability::{self, Reply, View};

struct Fx {
    _dir: tempfile::TempDir,
    ctx: PolicyContext,
    state: String,
}

fn fx(mode: PermissionMode) -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let ws = dir.path().join("ws");
    std::fs::create_dir_all(ws.join("src")).unwrap();
    std::fs::write(ws.join("README.md"), "x").unwrap();
    std::fs::write(ws.join("a.js"), "x").unwrap();
    let state = dir.path().join("home/Library/Application Support/IntelySwitchIDE");
    std::fs::create_dir_all(&state).unwrap();
    let mut ctx = PolicyContext::new(mode, &ws);
    ctx.home = Some(dir.path().join("home"));
    ctx.state_dir = Some(state.clone());
    ctx.mcp_servers = vec!["github".into()];
    Fx { _dir: dir, ctx, state: state.to_string_lossy().into_owned() }
}

fn el(f: &Fx, i: ToolIntent) -> Eligibility {
    eligibility(&f.ctx, &i, &LowList::default()).0
}

#[test]
fn the_low_shell_allow_list_is_strict() {
    let f = fx(PermissionMode::Ask);
    for cmd in ["git status", "git diff", "git log -n 5", "git show HEAD", "git branch --list", "git branch --list -a", "ls", "ls -la src", "cat README.md", "head -n 5 README.md", "tail -n 5 README.md", "grep -n foo README.md", "rg foo README.md", "grep -rn foo README.md", "node --check a.js", "npm test", "npm run test", "pnpm run lint", "yarn typecheck", "pwd", "wc -l README.md"] {
        assert_eq!(el(&f, ToolIntent::exec(cmd)), Low, "{cmd}");
    }
    for cmd in [
        "npm install",
        "npm run build",
        "npm run test -- --watch",
        "npm run postinstall",
        "pnpm install",
        "npx cowsay hi",
        "sh -c 'ls'",
        "bash -c ls",
        "env ls",
        "xargs ls",
        "find . -exec rm {} ;",
        "curl https://example.com",
        "wget https://example.com",
        "git status && ls",
        "ls | wc -l",
        "cat README.md > out.txt",
        "cat $(whoami)",
        "cat ../outside",
        "cat /etc/passwd",
        "ls $HOME",
        "ls *",
        "git branch -D x",
        "git config user.name x",
        "git diff --output=/tmp/x",
        "git -c core.pager=sh log",
        "python3 -c 'print(1)'",
        "node a.js",
        "rm -rf src",
        "echo hi > a.js",
        "tee a.js",
        "make test",
        "cat .env",
        "head ~/.ssh/id_rsa",
        "grep -rn SECRET .",
        "grep -rn SECRET",
        "grep -rn foo src",
        "grep -R foo src",
        "grep --recursive foo .",
        "grep -r -e SECRET",
        "rg SECRET",
        "rg -uuu SECRET",
        "rg foo src",
        "rg -A 3 SECRET",
        "grep -d recurse foo .",
    ] {
        assert_ne!(el(&f, ToolIntent::exec(cmd)), Low, "{cmd} must not be a one-tap approval");
    }
}

#[test]
fn working_tree_discarding_git_and_global_config_are_desktop_only() {
    let f = fx(PermissionMode::Ask);
    for cmd in ["git checkout .", "git checkout -- a.js", "git checkout -f main", "git restore .", "git restore --staged a.js", "git clean -fd", "git clean -n", "git apply x.patch", "git config --global core.hooksPath /tmp/h", "git config --system x y", "git -C . restore a.js", "git switch --discard-changes main"] {
        assert_eq!(el(&f, ToolIntent::exec(cmd)), DesktopOnly, "{cmd}");
    }
    assert_ne!(el(&f, ToolIntent::exec("git checkout main")), DesktopOnly);
}

#[test]
fn hard_stops_are_never_remote() {
    let f = fx(PermissionMode::Ask);
    for cmd in [
        "git commit -m x",
        "git commit --amend",
        "git push",
        "git push origin main",
        "git tag v1",
        "git reset --hard HEAD~1",
        "git add -A",
        "git add .",
        "git rebase main",
        "git merge x",
        "gh pr merge 12",
        "sh -c 'git push'",
        "bash -c \"git commit -m x\"",
        "env git push",
        "git -C . commit -m x",
        "xargs git push",
        "/usr/bin/git commit -m x",
    ] {
        assert_eq!(el(&f, ToolIntent::exec(cmd)), DesktopOnly, "{cmd}");
    }
}

#[test]
fn protected_and_state_paths_are_never_remote_whatever_the_tool() {
    let f = fx(PermissionMode::Ask);
    for p in [".git/config", ".git/hooks/pre-commit", ".husky/pre-commit", ".claude/settings.json", ".env", ".env.production", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"] {
        assert_eq!(el(&f, ToolIntent::write(&[p])), DesktopOnly, "{p}");
    }
    let s = &f.state;
    for i in [
        ToolIntent::write(&[&format!("{s}/devices.json")]),
        ToolIntent::write(&[&format!("{s}/../IntelySwitchIDE/settings.json")]),
        ToolIntent::read(&[&format!("{s}/remote-audit.jsonl")]),
        ToolIntent::exec(&format!("echo x > '{s}/devices.json'")),
        ToolIntent::exec(&format!("cp a.js '{s}/devices.json'")),
        ToolIntent::exec(&format!("tee '{s}/settings.json'")),
        ToolIntent::exec(&format!("git -C '{s}' status")),
        ToolIntent::exec(&format!("cat '{s}/devices.json'")),
        ToolIntent::exec("cat ~/Library/Application\\ Support/IntelySwitchIDE/devices.json"),
        ToolIntent::exec("cat \"$HOME/Library/Application Support/IntelySwitchIDE/devices.json\""),
    ] {
        assert_eq!(el(&f, i.clone()), DesktopOnly, "{i:?}");
    }
}

#[test]
fn edits_inside_the_workspace_are_low_except_files_that_run_at_commit_time() {
    let f = fx(PermissionMode::Ask);
    assert_eq!(el(&f, ToolIntent::write(&["src/main.rs"])), Low);
    assert_eq!(el(&f, ToolIntent::write(&["docs/notes.md"])), Low);
    for p in ["package.json", "Makefile", ".github/workflows/ci.yml", "scripts/deploy.sh", ".npmrc", ".gitattributes", "run.sh"] {
        assert_eq!(el(&f, ToolIntent::write(&[p])), StepUp, "{p}");
    }
    assert_eq!(el(&f, ToolIntent::write(&["/tmp/elsewhere.txt"])), StepUp);
    assert_eq!(el(&f, ToolIntent::write(&["../escape.txt"])), StepUp);
}

#[test]
fn env_prefixed_commands_and_tool_config_writes_are_not_low() {
    let f = fx(PermissionMode::Ask);
    for cmd in ["NODE_OPTIONS=--require=./a.js npm test", "PATH=./bin git status", "LD_PRELOAD=./a.so ls", "DYLD_INSERT_LIBRARIES=./a.dylib ls", "BASH_ENV=./a.sh npm test", "npm_config_script_shell=./a.sh npm test", "HOME=/tmp git log"] {
        assert_ne!(el(&f, ToolIntent::exec(cmd)), Low, "{cmd}");
    }
    for p in [".cargo/config.toml", ".mcp.json", "CLAUDE.md", ".gitmodules", "Dockerfile", "Cargo.toml", "build.rs", "vitest.config.ts", "jest.config.js", "webpack.config.js", "babel.config.js", ".babelrc", "setup.py", "conftest.py", ".tool-versions", "pnpm-workspace.yaml", "node_modules/.bin/tsc"] {
        assert_ne!(el(&f, ToolIntent::write(&[p])), Low, "{p}");
    }
    assert_eq!(el(&f, ToolIntent::write(&["src/lib.rs"])), Low);
}

#[test]
fn network_and_unknown_tools_need_step_up_and_plan_approval_is_one_tap() {
    let f = fx(PermissionMode::Ask);
    assert_eq!(el(&f, ToolIntent::net("https://example.com")), StepUp);
    assert_eq!(el(&f, ToolIntent::other("SomeNewTool")), StepUp);
    assert_eq!(el(&f, ToolIntent::other("ExitPlanMode")), Low);
    // an MCP server outside the IDE's set is refused by the broker
    assert_eq!(el(&f, ToolIntent::mcp("evil", "x")), DesktopOnly);
}

#[test]
fn no_mcp_intent_is_phone_approvable_in_any_mode_or_run_state() {
    // the phone would see only `server: tool`, so an MCP call is approved on the Mac (MCP spec 5.2 item 6, 6.7)
    for mode in PermissionMode::ALL {
        let f = fx(mode);
        for (server, tool) in [("github", "create_issue"), ("github", "list_issues"), ("evil", "x")] {
            assert_eq!(el(&f, ToolIntent::mcp(server, tool)), DesktopOnly, "{mode:?} {server}.{tool}");
        }
    }
    let f = fx(PermissionMode::Ask);
    let (e, why) = eligibility(&f.ctx, &ToolIntent::mcp("github", "create_issue"), &LowList::default());
    assert_eq!((e, why), (DesktopOnly, "MCP tools are approved on the Mac"));
    // so neither "allow once" nor "allow for this run" works from a phone
    assert!(matches!(verdict(RemoteAction::ApproveOnce(DesktopOnly), Reply, None), Verdict::Never(_)));
}

#[test]
fn a_request_of_a_run_on_a_server_is_approved_at_the_desktop() {
    use intely_agent_core::policy::fsview::{FsEntry, FsMeta, FsView};
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    /// A server whose files this Mac cannot see: it knows nothing, and it is not this machine.
    struct Elsewhere;
    impl FsView for Elsewhere {
        fn metadata(&self, _: &Path) -> Option<FsMeta> {
            None
        }
        fn symlink_metadata(&self, _: &Path) -> Option<FsMeta> {
            None
        }
        fn read_link(&self, _: &Path) -> Option<PathBuf> {
            None
        }
        fn canonicalize(&self, _: &Path) -> Option<PathBuf> {
            None
        }
        fn read_dir(&self, _: &Path) -> Option<Vec<FsEntry>> {
            None
        }
        fn read_to_string(&self, _: &Path, _: usize) -> Option<String> {
            None
        }
    }
    let mut f = fx(PermissionMode::Ask);
    // on this Mac a plain read of the workspace is approvable from the phone
    assert_eq!(el(&f, ToolIntent::exec("ls")), Low);
    f.ctx.fs = Some(Arc::new(Elsewhere));
    for i in [ToolIntent::exec("ls"), ToolIntent::exec("git status"), ToolIntent::exec("npm test")] {
        let (e, why) = eligibility(&f.ctx, &i, &LowList::default());
        assert_eq!(e, DesktopOnly);
        assert!(why.contains("server"), "{why}");
    }
}

#[test]
fn a_read_only_role_has_nothing_to_approve_remotely() {
    let f = fx(PermissionMode::ReadOnly);
    assert_eq!(el(&f, ToolIntent::exec("npm install")), DesktopOnly);
    assert_eq!(el(&f, ToolIntent::write(&["src/a.rs"])), DesktopOnly);
}

#[test]
fn the_action_table_matches_remote_plan_4_1_row_by_row() {
    use RemoteAction::*;
    let allowed_for_reply = [ViewRuns, ViewDiff, AnswerQuestion, ApprovePlan, FollowUpPrompt, StopRun, StopAll, ApproveOnce(Low)];
    for a in allowed_for_reply {
        assert_eq!(verdict(a, Reply, None), Verdict::Allowed, "{a:?}");
    }
    for a in [ApproveOnce(StepUp), AllowForRun, StartRun] {
        assert_eq!(verdict(a, Reply, None), Verdict::StepUp, "{a:?}");
    }
    let never = [ApproveOnce(DesktopOnly), ChangeRunConfig, AllowAlways, BulkApprove, HardStopped, GitWrite, RewindOrRollback, ChangeSettings, EnableRemoteOrKillOff, PairPromoteRevoke, FileBrowserOrTerminal];
    for a in never {
        assert!(matches!(verdict(a, Reply, None), Verdict::Never(_)), "{a:?}");
        assert!(matches!(verdict(a, View, None), Verdict::Never(_)), "{a:?} for view");
    }
    // a view-only device may only look
    for a in [ViewRuns, ViewDiff] {
        assert_eq!(verdict(a, View, None), Verdict::Allowed);
    }
    for a in [AnswerQuestion, ApprovePlan, FollowUpPrompt, StopRun, StopAll, ApproveOnce(Low), ApproveOnce(StepUp), AllowForRun, StartRun] {
        assert!(matches!(verdict(a, View, None), Verdict::Never(_)), "{a:?}");
    }
    let _: Capability = View;
}

#[test]
fn a_follow_up_depends_on_the_mode_of_the_run_it_steers() {
    use RemoteAction::*;
    // permission-modes spec 5.7: Automatic and Bypass show no approval cards, so a bare "do X" from a phone is not enough
    for mode in [PermissionMode::ReadOnly, PermissionMode::Ask, PermissionMode::Edit] {
        assert_eq!(verdict(FollowUpPrompt, Reply, Some(mode)), Verdict::Allowed, "{mode:?}");
    }
    assert_eq!(verdict(FollowUpPrompt, Reply, None), Verdict::Allowed, "an unknown run fails later, in the host");
    assert_eq!(verdict(FollowUpPrompt, Reply, Some(PermissionMode::Automatic)), Verdict::StepUp);
    assert!(matches!(verdict(FollowUpPrompt, Reply, Some(PermissionMode::Bypass)), Verdict::Never(why) if why.contains("Mac")));
    // stopping and answering a question stay open in every mode, and approving a plan continues in Ask
    for mode in PermissionMode::ALL {
        for a in [StopRun, StopAll, AnswerQuestion, ApprovePlan] {
            assert_eq!(verdict(a, Reply, Some(mode)), Verdict::Allowed, "{a:?} in {mode:?}");
        }
        // a view-only device stays denied whatever the mode is
        assert!(matches!(verdict(FollowUpPrompt, View, Some(mode)), Verdict::Never(_)), "{mode:?}");
        // nothing else a phone cannot do becomes possible with a looser run
        for a in [ChangeRunConfig, AllowAlways, BulkApprove, HardStopped, GitWrite, RewindOrRollback, ChangeSettings] {
            assert!(matches!(verdict(a, Reply, Some(mode)), Verdict::Never(_)), "{a:?} in {mode:?}");
        }
    }
}

#[test]
fn a_prompt_challenge_key_binds_the_run_and_the_exact_text() {
    let key = prompt_step_up_key("a-1-2", "run the tests");
    assert_eq!(parse_prompt_step_up_key(&key).map(|(a, h)| (a, h.len())), Some(("a-1-2", 64)));
    assert_ne!(key, prompt_step_up_key("a-1-2", "run the tests "), "one more character is another prompt");
    assert_ne!(key, prompt_step_up_key("a-1-3", "run the tests"), "and another run is another challenge");
    for bad in ["prompt:", "prompt:a:zz", "prompt::".to_string().as_str(), "start:x", "prompt:a-1-2:abc"] {
        assert!(parse_prompt_step_up_key(bad).is_none(), "{bad}");
    }
}

#[test]
fn a_plan_excerpt_is_cut_at_2_kib_on_a_character_boundary() {
    assert_eq!(plan_excerpt("short plan"), ("short plan".to_string(), false));
    let (cut, truncated) = plan_excerpt(&"é".repeat(2000));
    assert!(truncated && cut.len() <= PLAN_EXCERPT_BYTES && cut.chars().all(|c| c == 'é'), "{}", cut.len());
    let (exact, truncated) = plan_excerpt(&"x".repeat(PLAN_EXCERPT_BYTES));
    assert_eq!((exact.len(), truncated), (PLAN_EXCERPT_BYTES, false));
}

#[test]
fn intent_hash_binds_run_request_and_every_intent_field() {
    let a = ToolIntent::exec("git status");
    let h = intent_hash("agent", "r1", &a);
    assert_eq!(h, intent_hash("agent", "r1", &a));
    assert_ne!(h, intent_hash("agent", "r2", &a));
    assert_ne!(h, intent_hash("other", "r1", &a));
    assert_ne!(h, intent_hash("agent", "r1", &ToolIntent::exec("git status ")));
}
