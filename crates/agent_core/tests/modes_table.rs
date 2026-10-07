//! Permission modes, the non-exec rows of the policy table (permission-modes spec 2.2): writes (P-5), reads (P-6), the web (P-7),
//! spawn and other tools (P-9), the SDK tool coverage (P-9b), `WriteInside` and the widened exec surface (P-11), the no-Ask invariant
//! (P-12), the ten groups of the Bypass dialog (P-14), never-read on the command route (P-18) and the persistence list (P-23).

mod common;

use std::path::PathBuf;

use common::*;
use intely_agent_core::events::types::DecidedBy;
use intely_agent_core::policy::decide::{decide, session_allow_for, Decision, DelegateRule, PolicyContext, SavedAllow, AUTO_KNOWN_OTHER, OTHER_STATE_CHANGE};
use intely_agent_core::policy::intent::{Actor, ToolClass, ToolIntent};
use intely_agent_core::policy::{ToolKind, BYPASS_KEEPS, SDK_TOOL_COVERAGE};
use intely_agent_core::providers::PermissionMode;
use serde_json::{json, Value};

const PLAN: PermissionMode = PermissionMode::ReadOnly;
const ASK: PermissionMode = PermissionMode::Ask;
const EDIT: PermissionMode = PermissionMode::Edit;
const AUTO: PermissionMode = PermissionMode::Automatic;
const BYPASS: PermissionMode = PermissionMode::Bypass;

/// `(decision, rule)` per mode, in the order Plan, Ask, Edit, Automatic, Bypass.
type Row = [(Decision, &'static str); 5];

use Decision::{Allow, Ask as Q, Deny};

/// A fixture whose home folder lies OUTSIDE the run folders (the persistence list and the home-relative never-read list are judged there).
struct Env {
    fx: Fx,
    home: PathBuf,
    state: PathBuf,
    plans: PathBuf,
    _tmp: tempfile::TempDir,
}

fn env() -> Env {
    let fx = mfx();
    let tmp = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(tmp.path()).unwrap();
    let home = base.join("home");
    let state = home.join("Library/Application Support/IntelySwitchIDE");
    let plans = state.join("plans/a1");
    std::fs::create_dir_all(&plans).unwrap();
    std::fs::create_dir_all(home.join(".config/gcloud")).unwrap();
    Env { fx, home, state, plans, _tmp: tmp }
}

impl Env {
    fn ctx(&self, mode: PermissionMode) -> PolicyContext {
        let mut c = ctx(&self.fx, mode);
        c.home = Some(self.home.clone());
        c.state_dir = Some(self.state.clone());
        c.plan_dir = Some(self.plans.clone());
        // the host sets the strict jail in every mode except Bypass
        c.strict_jail = mode != BYPASS;
        c
    }
}

fn run(c: &PolicyContext, tool: &str, input: Value) -> (Decision, DecidedBy, String) {
    let d = decide_tool(c, tool, input);
    (d.decision, d.by, d.rule.unwrap_or_default())
}

/// Judges one tool call in every mode and compares with `want`.
fn matrix(e: &Env, label: &str, tool: &str, input: Value, want: Row) {
    let mut misses = Vec::new();
    for (mode, (decision, rule)) in PermissionMode::ALL.into_iter().zip(want) {
        // `ALL` is in UI order (Plan, Ask, Edit, Automatic, Bypass), the order of `Row`
        let (d, _, r) = run(&e.ctx(mode), tool, input.clone());
        if d != decision || r != rule {
            misses.push(format!("{mode:?}: want {decision:?}/{rule}, got {d:?}/{r}"));
        }
    }
    assert!(misses.is_empty(), "{label} ({tool} {input}):\n{}", misses.join("\n"));
}

/// Every mode is a hard stop with this rule.
fn hard_stop_everywhere(e: &Env, label: &str, tool: &str, input: Value, rule: &str) {
    for mode in PermissionMode::ALL {
        let (d, by, r) = run(&e.ctx(mode), tool, input.clone());
        assert_eq!((d, by, r.as_str()), (Deny, DecidedBy::HardStop, rule), "{label}: {mode:?} ({tool} {input})");
    }
}

#[test]
fn the_ladder_helpers_and_wire_names() {
    use PermissionMode::*;
    assert_eq!(PermissionMode::ALL, [ReadOnly, Ask, Edit, Automatic, Bypass]);
    assert_eq!(serde_json::to_value(PermissionMode::ALL).unwrap(), json!(["readOnly", "ask", "edit", "automatic", "bypass"]));
    assert_eq!(serde_json::from_value::<PermissionMode>(json!("auto")).unwrap(), Automatic, "the old wire name still reads");
    assert_eq!([ReadOnly, Ask, Edit, Automatic, Bypass].map(PermissionMode::strictness), [0, 1, 2, 3, 4]);
    assert_eq!([ReadOnly, Ask, Edit, Automatic, Bypass].map(PermissionMode::is_unattended), [false, false, false, true, true]);
    assert_eq!(Bypass.resume_mode(), Automatic);
}

// ---------------------------------------------------------------------------------------------------------------- P-5 writes

#[test]
fn write_matrix_inside_the_run_folders() {
    let e = env();
    matrix(&e, "ordinary file", "Write", json!({"file_path": "src/new.ts"}), [(Deny, "role.read-only"), (Q, "write.ask"), (Allow, "write.inside"), (Allow, "write.auto"), (Allow, "write.bypass")]);
    matrix(&e, "exec-surface file", "Write", json!({"file_path": "package.json"}), [(Deny, "role.read-only"), (Q, "write.exec-surface"), (Q, "write.exec-surface"), (Allow, "write.auto"), (Allow, "write.bypass")]);
    matrix(&e, "no path", "Edit", json!({}), [(Deny, "role.read-only"), (Q, "write.no-path"), (Q, "write.no-path"), (Deny, "write.no-path"), (Deny, "write.no-path")]);
    for tool in ["Edit", "MultiEdit"] {
        matrix(&e, "other write tools", tool, json!({"file_path": "src/a.ts"}), [(Deny, "role.read-only"), (Q, "write.ask"), (Allow, "write.inside"), (Allow, "write.auto"), (Allow, "write.bypass")]);
    }
    matrix(&e, "notebook", "NotebookEdit", json!({"notebook_path": "n.ipynb"}), [(Deny, "role.read-only"), (Q, "write.ask"), (Allow, "write.inside"), (Allow, "write.auto"), (Allow, "write.bypass")]);
}

#[test]
fn write_matrix_protected_and_outside() {
    let e = env();
    for (label, path, rule) in [
        (".git", ".git/config", "fs.protected"),
        (".husky", ".husky/pre-commit", "fs.protected"),
        (".claude", ".claude/settings.local.json", "fs.protected"),
        ("lockfile", "pnpm-lock.yaml", "fs.protected"),
        (".env", "api/.env.production", "fs.protected"),
    ] {
        hard_stop_everywhere(&e, label, "Write", json!({ "file_path": path }), rule);
    }
    let state_file = e.state.join("settings.json").display().to_string();
    hard_stop_everywhere(&e, "state dir", "Write", json!({ "file_path": state_file }), "fs.protected");
    // outside the run directories: a hard stop under the strict jail (every mode but Bypass), and the table row without it
    let outside = tempfile::tempdir().unwrap();
    let out = std::fs::canonicalize(outside.path()).unwrap().join("x.txt").display().to_string();
    for mode in [PLAN, ASK, EDIT, AUTO] {
        let (d, by, r) = run(&e.ctx(mode), "Write", json!({ "file_path": out }));
        assert_eq!((d, by, r.as_str()), (Deny, DecidedBy::HardStop, "fs.outside-jail"), "{mode:?}");
    }
    assert_eq!(run(&e.ctx(BYPASS), "Write", json!({ "file_path": out })).2, "write.bypass");
    // Bypass ignores the strict jail even when the host forgot to switch it off
    let mut c = e.ctx(BYPASS);
    c.strict_jail = true;
    assert_eq!(run(&c, "Write", json!({ "file_path": out })).2, "write.bypass");
    let rows: [(PermissionMode, (Decision, &str)); 5] = [(PLAN, (Deny, "role.read-only")), (ASK, (Q, "write.outside")), (EDIT, (Q, "write.outside")), (AUTO, (Deny, "write.auto.outside")), (BYPASS, (Allow, "write.bypass"))];
    for (mode, (decision, rule)) in rows {
        let mut c = e.ctx(mode);
        c.strict_jail = false;
        let (d, _, r) = run(&c, "Write", json!({ "file_path": out }));
        assert_eq!((d, r.as_str()), (decision, rule), "{mode:?} without the strict jail");
    }
    // a role list refuses in every mode
    for mode in PermissionMode::ALL {
        let mut c = e.ctx(mode);
        c.role_deny = vec!["Edit".into()];
        assert_eq!(run(&c, "Edit", json!({"file_path": "src/a.ts"})).2, "role.deny-list", "{mode:?}");
    }
}

#[test]
fn the_plan_notes_file_is_the_only_write_plan_mode_allows() {
    let e = env();
    let plan = e.plans.join("plan.md").display().to_string();
    let c = e.ctx(PLAN);
    let (d, by, r) = run(&c, "Write", json!({ "file_path": plan }));
    assert_eq!((d, by, r.as_str()), (Allow, DecidedBy::Default, "plan.file"));
    for (label, path) in [("not markdown", e.plans.join("plan.txt")), ("outside the plan dir", e.state.join("plans/other.md")), ("state file", e.state.join("settings.md")), ("a nested dir that is not the plan dir", e.plans.parent().unwrap().join("a2/plan.md"))] {
        let (d, by, r) = run(&c, "Write", json!({ "file_path": path.display().to_string() }));
        assert_eq!((d, by, r.as_str()), (Deny, DecidedBy::HardStop, "fs.protected"), "{label}");
    }
    // another mode never gets the carve-out, and neither does a delegate
    for mode in [ASK, EDIT, AUTO, BYPASS] {
        let (d, by, r) = run(&e.ctx(mode), "Write", json!({ "file_path": plan }));
        assert_eq!((d, by, r.as_str()), (Deny, DecidedBy::HardStop, "fs.protected"), "{mode:?}");
    }
    let mut cd = e.ctx(PLAN);
    cd.delegates = Some([("ro".to_string(), DelegateRule { mode: PermissionMode::ReadOnly, allowed_tools: None, role_deny: vec![], capped: false })].into());
    let mut i = ToolIntent::from_claude_tool("Write", &json!({ "file_path": plan }));
    i.actor = Some(Actor { agent_id: "x".into(), role: "ro".into() });
    assert_eq!(decide_intent(&cd, i).decision, Deny, "a delegate has no carve-out");
    // a symlink inside the plan dir that points out resolves to its target and is not the plan dir any more
    let elsewhere = tempfile::tempdir().unwrap();
    let target = std::fs::canonicalize(elsewhere.path()).unwrap().join("loot.md");
    std::os::unix::fs::symlink(&target, e.plans.join("link.md")).unwrap();
    let (d, _, r) = run(&c, "Write", json!({ "file_path": e.plans.join("link.md").display().to_string() }));
    assert_ne!(d, Allow, "{r}");
    // a role that lists no Write tool keeps the carve-out closed
    let mut c2 = e.ctx(PLAN);
    c2.role_deny = vec!["Write".into()];
    assert_eq!(run(&c2, "Write", json!({ "file_path": plan })).2, "role.deny-list");
}

// ----------------------------------------------------------------------------------------------------------------- P-6 reads

#[test]
fn read_matrix() {
    let e = env();
    for tool_input in [("Read", json!({"file_path": ".env"})), ("Grep", json!({"pattern": "x", "path": ".env"})), ("LS", json!({"path": ".ssh"}))] {
        hard_stop_everywhere(&e, "never-read", tool_input.0, tool_input.1, "read.never-read");
    }
    matrix(&e, "outside", "Read", json!({"file_path": "/etc/hosts"}), [(Q, "read.outside"), (Q, "read.outside"), (Q, "read.outside"), (Deny, "read.auto.outside"), (Allow, "read.bypass")]);
    matrix(&e, "inside", "Read", json!({"file_path": "src/a.ts"}), [(Allow, "read.inside"), (Allow, "read.inside"), (Allow, "read.inside"), (Allow, "read.inside"), (Allow, "read.inside")]);
    matrix(&e, "Glob without a path", "Glob", json!({"pattern": "**/*.ts"}), [(Allow, "read.inside"), (Allow, "read.inside"), (Allow, "read.inside"), (Allow, "read.inside"), (Allow, "read.inside")]);
    for mode in PermissionMode::ALL {
        let mut c = e.ctx(mode);
        c.role_deny = vec!["Read".into()];
        assert_eq!(run(&c, "Read", json!({"file_path": "src/a.ts"})).2, "role.deny-list", "{mode:?}");
    }
    // the plan notes of the lead are readable in every mode (before the never-read list); a delegate cannot read them
    let plan = e.plans.join("plan.md").display().to_string();
    for mode in PermissionMode::ALL {
        let (d, _, r) = run(&e.ctx(mode), "Read", json!({ "file_path": plan }));
        assert_eq!((d, r.as_str()), (Allow, "read.plan-file"), "{mode:?}");
    }
    let mut cd = e.ctx(AUTO);
    cd.delegates = Some([("dev".to_string(), DelegateRule { mode: PermissionMode::Edit, allowed_tools: None, role_deny: vec![], capped: false })].into());
    let mut i = ToolIntent::from_claude_tool("Read", &json!({ "file_path": plan }));
    i.actor = Some(Actor { agent_id: "x".into(), role: "dev".into() });
    let d = decide_intent(&cd, i);
    assert_eq!((d.decision, d.by, d.rule.as_deref()), (Deny, DecidedBy::HardStop, Some("read.never-read")));
    // other files of the state dir stay never-read
    hard_stop_everywhere(&e, "state dir", "Read", json!({ "file_path": e.state.join("settings.json").display().to_string() }), "read.never-read");
    // `attachments` is the one readable subdirectory
    let att = e.state.join("attachments/x.txt").display().to_string();
    for mode in PermissionMode::ALL {
        // the host adds the attachments directory to the run directories
        let mut c = e.ctx(mode);
        c.add_dirs.push(e.state.join("attachments"));
        let (d, _, r) = run(&c, "Read", json!({ "file_path": att }));
        assert_eq!(d, Allow, "{mode:?}: {r}");
    }
}

/// The never-read extension (spec 2.3.1, P-18): every entry through the Read tool AND the command route, in every mode.
const NEVER_READ_HOME: &[&str] = &[
    ".config/gcloud/credentials.db",
    ".config/gcloud/access_tokens.db",
    ".azure/accessTokens.json",
    ".cargo/credentials.toml",
    ".cargo/credentials",
    ".pypirc",
    ".vault-token",
    ".terraform.d/credentials.tfrc.json",
    ".terraformrc",
    ".config/op/config",
    "Library/Application Support/1Password/x",
    ".claude.json",
    ".claude/projects/x/y.jsonl",
    "Library/Application Support/Claude/x",
    "Library/Application Support/Google/Chrome/Default/Cookies",
    "Library/Application Support/Firefox/Profiles/x/cookies.sqlite",
    "Library/Cookies/Cookies.binarycookies",
    "Library/Safari/History.db",
    "Library/Caches/claude-cli-nodejs/x/mcp-logs-y/z.txt",
    ".aws/credentials",
    ".ssh/id_rsa",
];

/// Readable: the home anchoring must not catch these.
const READABLE_HOME: &[&str] = &[".claude/agents/x.md"];

#[test]
fn never_read_extension_through_the_read_tool_and_the_command_route() {
    let e = env();
    for rel in NEVER_READ_HOME {
        let full = e.home.join(rel).display().to_string();
        hard_stop_everywhere(&e, rel, "Read", json!({ "file_path": full }), "read.never-read");
        for mode in PermissionMode::ALL {
            let (d, by, r) = run(&e.ctx(mode), "Bash", json!({ "command": format!("cat '{full}'") }));
            assert_eq!((d, by, r.as_str()), (Deny, DecidedBy::HardStop, "read.never-read"), "{mode:?} cat {rel}");
            let (d, by, r) = run(&e.ctx(mode), "Bash", json!({ "command": format!("rg -n . {}", e.home.join(rel).to_str().unwrap().replace(' ', "\\ ")) }));
            assert_eq!((d, by), (Deny, DecidedBy::HardStop), "{mode:?} rg {rel}: {r}");
        }
    }
    for rel in READABLE_HOME {
        let full = e.home.join(rel).display().to_string();
        for mode in PermissionMode::ALL {
            let (_, by, _) = run(&e.ctx(mode), "Read", json!({ "file_path": full }));
            assert_ne!(by, DecidedBy::HardStop, "{mode:?} {rel}");
        }
    }
    // a repository's own `.claude` directory stays readable by the Read tool
    let repo_claude = e.fx.cwd.join(".claude/settings.json");
    std::fs::create_dir_all(repo_claude.parent().unwrap()).unwrap();
    for mode in PermissionMode::ALL {
        let (d, _, r) = run(&e.ctx(mode), "Read", json!({ "file_path": repo_claude.display().to_string() }));
        assert_eq!(d, Allow, "{mode:?}: {r}");
    }
}

#[test]
fn never_read_on_the_command_route_covers_operands_redirects_wrappers_scripts_and_the_state_dir() {
    let e = env();
    let w = |name: &str, text: &str| std::fs::write(e.fx.cwd.join(name), text).unwrap();
    w(".env", "SECRET=1");
    w("read-aws.py", &format!("print(open('{}/.aws/credentials').read())\n", e.home.display()));
    let state_settings = e.state.join("settings.json").display().to_string();
    let hostile = [
        "cat .env".to_string(),
        "cat .env.local".to_string(),
        "head -n1 .env".to_string(),
        "rg -n . .env".to_string(),
        "grep x .env".to_string(),
        "cat .env*".to_string(),
        "cat ~/.aws/credentials".to_string(),
        "cat ~/.config/gcloud/credentials.db".to_string(),
        "ls ~/.ssh".to_string(),
        "cd ~/.aws && cat credentials".to_string(),
        "cat --file=.env".to_string(),
        "tail -c+1 .env".to_string(),
        "dd if=.env".to_string(),
        "env X=1 cat .env".to_string(),
        "time cat .env".to_string(),
        "cat < .env".to_string(),
        "git show HEAD:.env".to_string(),
        "python3 read-aws.py".to_string(),
        format!("cat \"{state_settings}\""),
    ];
    for cmd in hostile {
        for mode in PermissionMode::ALL {
            let (d, by, r) = run(&e.ctx(mode), "Bash", json!({ "command": cmd }));
            assert_eq!((d, by, r.as_str()), (Deny, DecidedBy::HardStop, "read.never-read"), "{mode:?} {cmd}");
        }
    }
    // allowed: templates, public keys, attachments, ordinary files, a pattern that merely contains a secret name
    w(".env.example", "A=1");
    w("key.pub", "ssh-ed25519 AAA");
    w("README.md", "x");
    std::fs::create_dir_all(e.state.join("attachments")).unwrap();
    for cmd in ["cat .env.example", "cat key.pub", "cat README.md", &format!("cat {}/attachments/x.txt", e.state.display()), "grep .env README.md", "sed -n '/.wrangler/p' .gitignore", "git check-ignore -v .env"] {
        for mode in [ASK, EDIT, AUTO, BYPASS] {
            let (_, by, r) = run(&e.ctx(mode), "Bash", json!({ "command": cmd }));
            assert_ne!(by, DecidedBy::HardStop, "{mode:?} {cmd}: {r}");
        }
    }
}

// ------------------------------------------------------------------------------------------------------------------ P-7 net

#[test]
fn web_matrix() {
    let e = env();
    let fetch = |url: &str| json!({ "url": url });
    matrix(&e, "public URL", "WebFetch", fetch("https://docs.rs/serde"), [(Q, "net.ask"), (Q, "net.ask"), (Q, "net.ask"), (Allow, "net.auto"), (Allow, "net.bypass")]);
    matrix(&e, "search", "WebSearch", json!({"query": "rust serde"}), [(Q, "net.no-url"), (Q, "net.no-url"), (Q, "net.no-url"), (Allow, "net.auto"), (Allow, "net.bypass")]);
    for url in ["ftp://docs.rs/x", "https://user@docs.rs/x", "file:///etc/passwd", "docs.rs/x"] {
        matrix(&e, url, "WebFetch", fetch(url), [(Q, "net.odd-url"), (Q, "net.odd-url"), (Q, "net.odd-url"), (Deny, "net.auto.odd-url"), (Allow, "net.bypass")]);
    }
    let long = format!("https://docs.rs/{}", "a".repeat(400));
    matrix(&e, "exfil shape", "WebFetch", fetch(&long), [(Q, "net.exfil-shape"), (Q, "net.exfil-shape"), (Q, "net.exfil-shape"), (Deny, "net.auto.exfil-shape"), (Allow, "net.bypass")]);
    for host in ["localhost", "127.0.0.1", "[::1]", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "0x7f.0.0.1", "2130706433", "printer.local", "db.internal", "intranet", "[::ffff:127.0.0.1]", "93.184.216.34", "x.localhost"] {
        let url = format!("http://{host}:8080/x");
        matrix(&e, &url, "WebFetch", fetch(&url), [(Q, "net.ask"), (Q, "net.ask"), (Q, "net.ask"), (Deny, "net.auto.private-host"), (Allow, "net.bypass")]);
        // never a session offer for such a host
        let d = decide_tool(&e.ctx(ASK), "WebFetch", fetch(&url));
        assert!(d.session_allow.is_none(), "{url}");
        assert!(session_allow_for(&e.ctx(ASK), &ToolIntent::net(&url)).is_none(), "{url}");
    }
    // a saved host applies in Ask and Edit only
    for (mode, rule) in [(ASK, "net.saved"), (EDIT, "net.saved"), (PLAN, "net.ask"), (AUTO, "net.auto"), (BYPASS, "net.bypass")] {
        let mut c = e.ctx(mode);
        c.saved.push(SavedAllow::NetHost { host: "docs.rs".into() });
        assert_eq!(run(&c, "WebFetch", fetch("https://DOCS.rs/x?y=1")).2, rule, "{mode:?}");
    }
    // the offer: public plain URL only, on `net.ask`
    let d = decide_tool(&e.ctx(ASK), "WebFetch", fetch("https://docs.rs/serde"));
    assert_eq!(d.session_allow.as_ref().map(|o| o.scope.as_str()), Some("docs.rs"));
    assert!(decide_tool(&e.ctx(PLAN), "WebFetch", fetch("https://docs.rs/serde")).session_allow.is_none(), "never in Plan");
    assert!(decide_tool(&e.ctx(ASK), "WebSearch", json!({"query": "x"})).session_allow.is_none());
    for mode in PermissionMode::ALL {
        let mut c = e.ctx(mode);
        c.role_deny = vec!["Web*".into()];
        assert_eq!(run(&c, "WebFetch", fetch("https://docs.rs")).2, "role.deny-list", "{mode:?}");
    }
}

// ----------------------------------------------------------------------------------------------------- P-9 spawn and other tools

fn matrix_with(e: &Env, label: &str, tool: &str, input: Value, want: Row, setup: &dyn Fn(&mut PolicyContext)) {
    let mut misses = Vec::new();
    for (mode, (decision, rule)) in PermissionMode::ALL.into_iter().zip(want) {
        let mut c = e.ctx(mode);
        setup(&mut c);
        let (d, _, r) = run(&c, tool, input.clone());
        if d != decision || r != rule {
            misses.push(format!("{mode:?}: want {decision:?}/{rule}, got {d:?}/{r}"));
        }
    }
    assert!(misses.is_empty(), "{label} ({tool} {input}):\n{}", misses.join("\n"));
}

#[test]
fn other_tools_matrix() {
    let e = env();
    let none = |_: &mut PolicyContext| {};
    let ui = [(Allow, "other.ui-card"); 5];
    matrix(&e, "ExitPlanMode (lead)", "ExitPlanMode", json!({}), [(Q, "other.exit-plan"), (Allow, "other.ui-card"), (Allow, "other.ui-card"), (Allow, "other.ui-card"), (Allow, "other.ui-card")]);
    matrix(&e, "EnterPlanMode", "EnterPlanMode", json!({}), [(Deny, "other.enter-plan"); 5]);
    matrix(&e, "TodoWrite", "TodoWrite", json!({"todos": []}), ui);
    matrix(&e, "AskUserQuestion", "AskUserQuestion", json!({}), ui);
    for tool in ["TaskCreate", "TaskUpdate", "TaskStop"] {
        matrix(&e, tool, tool, json!({}), [(Deny, "other.read-only"), (Q, "other.unknown"), (Q, "other.unknown"), (Allow, "other.auto"), (Allow, "other.bypass")]);
    }
    for tool in ["TaskGet", "TaskList", "TaskOutput", "BashOutput", "KillShell", "Skill", "CronList", "ReadNotifications", "ReportFindings", "ShowOnboardingRolePicker"] {
        matrix(&e, tool, tool, json!({}), [(Q, "other.unknown"), (Q, "other.unknown"), (Q, "other.unknown"), (Allow, "other.auto"), (Allow, "other.bypass")]);
    }
    for tool in OTHER_STATE_CHANGE {
        // `Monitor` without a `command` (a `ws` watch) arrives as a tool of class other
        let input = if tool == "Monitor" { json!({"description": "x", "timeout_ms": 1000, "ws": {"url": "wss://example.com"}}) } else { json!({}) };
        matrix(&e, tool, tool, input, [(Deny, "other.read-only"), (Q, "other.unknown"), (Q, "other.unknown"), (Deny, "other.state-change"), (Deny, "other.state-change")]);
    }
    matrix(&e, "a tool of a newer CLI", "SomethingNew", json!({}), [(Q, "other.unknown"), (Q, "other.unknown"), (Q, "other.unknown"), (Deny, "other.auto.unknown-tool"), (Allow, "other.bypass")]);
    // a tool without a name
    let nameless = ToolIntent::new(ToolClass::Other, "x");
    let want: Row = [(Q, "other.unknown"), (Q, "other.unknown"), (Q, "other.unknown"), (Deny, "other.auto.unknown-tool"), (Deny, "other.auto.unknown-tool")];
    for (mode, (decision, rule)) in PermissionMode::ALL.into_iter().zip(want) {
        let d = decide_intent(&e.ctx(mode), nameless.clone());
        assert_eq!((d.decision, d.rule.as_deref()), (decision, Some(rule)), "{mode:?} nameless");
    }
    // spawn, non-delegating run
    let listed = |c: &mut PolicyContext| c.subagents = vec!["researcher".into()];
    matrix_with(&e, "listed type", "Task", json!({"subagent_type": "researcher"}), [(Allow, "other.subagent"); 5], &listed);
    matrix_with(&e, "unlisted type", "Agent", json!({"subagent_type": "developer"}), [(Q, "other.subagent"), (Q, "other.subagent"), (Q, "other.subagent"), (Deny, "other.subagent"), (Allow, "other.bypass")], &listed);
    matrix_with(&e, "worktree", "Agent", json!({"subagent_type": "researcher", "isolation": "worktree"}), [(Deny, "delegate.isolation"); 5], &listed);
    for mode in PermissionMode::ALL {
        let d = decide_tool(&e.ctx(mode), "Agent", json!({"subagent_type": "researcher", "isolation": "remote"}));
        assert_eq!((d.decision, d.by), (Deny, DecidedBy::HardStop), "{mode:?}");
    }
    let _ = none;
}

#[test]
fn a_delegate_may_not_leave_plan_mode_in_any_mode() {
    let e = env();
    for mode in PermissionMode::ALL {
        let mut c = e.ctx(mode);
        c.delegates = Some([("dev".to_string(), DelegateRule { mode: PermissionMode::Edit, allowed_tools: None, role_deny: vec![], capped: false })].into());
        let mut i = ToolIntent::from_claude_tool("ExitPlanMode", &json!({}));
        i.actor = Some(Actor { agent_id: "x".into(), role: "dev".into() });
        let d = decide_intent(&c, i);
        assert_eq!((d.decision, d.by, d.rule.as_deref()), (Deny, DecidedBy::RoleDeny, Some("other.exit-plan-delegate")), "{mode:?}");
    }
}

// --------------------------------------------------------------------------------------------------------- P-9b SDK tool coverage

/// A representative input per tool of the pinned SDK.
fn sample_input(tool: &str, e: &Env) -> Value {
    match tool {
        "Bash" => json!({"command": "ls"}),
        "Monitor" => json!({"description": "x", "timeout_ms": 1000, "command": "ls"}),
        "Edit" => json!({"file_path": "src/a.ts", "old_string": "a", "new_string": "b"}),
        "Write" => json!({"file_path": "src/new.ts", "content": "x"}),
        "NotebookEdit" => json!({"notebook_path": "n.ipynb"}),
        "Read" => json!({"file_path": "src/a.ts"}),
        "Glob" => json!({"pattern": "*.ts"}),
        "Grep" => json!({"pattern": "x"}),
        "WebFetch" => json!({"url": "https://docs.rs/x", "prompt": "x"}),
        "WebSearch" => json!({"query": "x"}),
        "Agent" => json!({"subagent_type": "researcher", "description": "x", "prompt": "x"}),
        "ListMcpResourcesTool" | "RefreshMcpTools" => json!({"server": "fixture"}),
        "ReadMcpResourceTool" | "ReadMcpResourceDir" => json!({"server": "fixture", "uri": "file:///x"}),
        "Projects" => json!({"action": "project_write", "local_path": e.fx.cwd.join("src").display().to_string()}),
        "ProposeGoal" => json!({"goal": "x", "ask_user": false}),
        _ => json!({}),
    }
}

fn coverage_ctx(e: &Env, mode: PermissionMode) -> PolicyContext {
    let mut c = e.ctx(mode);
    c.subagents = vec!["*".into()];
    c.mcp_servers = vec!["fixture".into()];
    c
}

#[test]
fn every_tool_of_the_pinned_sdk_is_classified_and_decides_as_its_kind_says() {
    let e = env();
    assert_eq!(SDK_TOOL_COVERAGE.len(), 43, "the pinned sdk-tools.d.ts declares 43 *Input interfaces");
    let mut names: Vec<&str> = SDK_TOOL_COVERAGE.iter().map(|(_, t, _)| *t).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), 43, "one entry per tool");
    let mut reached_other = Vec::new();
    for (input_name, tool, kind) in SDK_TOOL_COVERAGE {
        assert!(input_name.ends_with("Input"), "{input_name}");
        for mode in [AUTO, BYPASS] {
            let c = coverage_ctx(&e, mode);
            let d = decide_tool(&c, tool, sample_input(tool, &e));
            let rule = d.rule.clone().unwrap_or_default();
            match kind {
                ToolKind::OtherStateChange => assert_eq!((d.decision, rule.as_str()), (Deny, "other.state-change"), "{tool} in {mode:?}"),
                ToolKind::PlanMode if *tool == "EnterPlanMode" => assert_eq!((d.decision, rule.as_str()), (Deny, "other.enter-plan"), "{mode:?}"),
                ToolKind::PlanMode => assert_eq!((d.decision, rule.as_str()), (Allow, "other.ui-card"), "{mode:?}"),
                ToolKind::Mcp => assert_eq!(d.decision, Allow, "{tool} with a server in {mode:?}: {d:?}"),
                ToolKind::OtherKnown => {
                    assert_eq!(d.decision, Allow, "{tool} in {mode:?}: {d:?}");
                    if matches!(rule.as_str(), "other.auto" | "other.bypass") {
                        reached_other.push(*tool);
                    }
                }
                _ => assert_eq!(d.decision, Allow, "{tool} ({kind:?}) in {mode:?}: {d:?}"),
            }
            assert_ne!(d.decision, Q, "{tool}");
        }
        // an MCP resource tool without a server is refused, and a server at Deny is refused in every mode
        if *kind == ToolKind::Mcp {
            for mode in [AUTO, BYPASS] {
                let mut c = coverage_ctx(&e, mode);
                let d = decide_tool(&c, tool, json!({}));
                assert_eq!(d.rule.as_deref(), Some("mcp.resource-server"), "{tool} {mode:?}");
                c.mcp_tools.insert("fixture".into(), intely_agent_core::mcp::McpServerRules { default_policy: intely_agent_core::mcp::McpPolicy::Deny, ..Default::default() });
                let d = decide_tool(&c, tool, sample_input(tool, &e));
                assert_eq!((d.decision, d.rule.as_deref()), (Deny, Some("mcp.policy-deny")), "{tool} {mode:?}");
            }
        }
    }
    // the only entries that reach other.auto / other.bypass are exactly AUTO_KNOWN_OTHER
    for t in &reached_other {
        assert!(AUTO_KNOWN_OTHER.contains(t), "{t}");
    }
    for (_, t, kind) in SDK_TOOL_COVERAGE {
        assert_eq!(*kind == ToolKind::OtherKnown, AUTO_KNOWN_OTHER.contains(t) && !matches!(*t, "ExitPlanMode" | "TaskOutput" | "BashOutput" | "KillShell" | "ToolSearch" | "Skill"), "{t}");
        if *kind == ToolKind::OtherStateChange {
            assert!(OTHER_STATE_CHANGE.contains(t), "{t}");
        }
    }
    // a tool outside the constant behaves as the "any other tool name" row
    assert_eq!(run(&coverage_ctx(&e, AUTO), "BrandNewTool", json!({})).2, "other.auto.unknown-tool");
    assert_eq!(run(&coverage_ctx(&e, BYPASS), "BrandNewTool", json!({})).2, "other.bypass");
}

// ------------------------------------------------------------------------------------------------------------------- P-11

#[test]
fn write_inside_saved_allow_and_the_widened_exec_surface() {
    let e = env();
    for mode in [ASK, EDIT] {
        let mut c = e.ctx(mode);
        c.saved.push(SavedAllow::WriteInside);
        let mut by = |input: Value| {
            let d = decide_tool(&c, "Write", input);
            (d.decision, d.by, d.rule.unwrap_or_default())
        };
        assert_eq!(by(json!({"file_path": "src/new.ts"})), (Allow, DecidedBy::Saved, "write.saved".to_string()), "{mode:?}");
        for path in [
            "package.json", "mise.toml", ".mise.toml", ".devcontainer/devcontainer.json", ".circleci/config.yml", ".vscode/tasks.json", ".vscode/launch.json", ".idea/runConfigurations/x.xml", "Rakefile", "tox.ini",
            "Jenkinsfile", "noxfile.py", "azure-pipelines.yml", ".github/workflows/ci.yml", "vite.config.ts",
        ] {
            assert_eq!(by(json!({ "file_path": path })).2, "write.exec-surface", "{mode:?} {path}: saved never covers an exec-surface path");
        }
        for path in ["Cargo.toml", "pyproject.toml", "Dockerfile", "Gemfile", "src/main.rs"] {
            let (d, _, r) = by(json!({ "file_path": path }));
            assert_eq!(d, Allow, "{mode:?} {path}: {r}");
        }
        assert_eq!(by(json!({"file_path": ".git/config"})).1, DecidedBy::HardStop);
        // `.envrc` is already protected by the `.env*` rule, which is stricter than the exec-surface list it also joined
        assert_eq!(by(json!({"file_path": ".envrc"})), (Deny, DecidedBy::HardStop, "fs.protected".to_string()));
        let (d, by_, _) = by(json!({"file_path": "/tmp/x-outside"}));
        assert_eq!((d, by_), (Deny, DecidedBy::HardStop), "outside stays a hard stop under the strict jail");
    }
    // the offer: only on `write.ask`, only for ordinary inside files, scope empty
    let c = e.ctx(ASK);
    let d = decide_tool(&c, "Write", json!({"file_path": "src/new.ts"}));
    assert_eq!((d.rule.as_deref(), d.session_allow.as_ref().map(|o| (o.kind, o.scope.as_str()))), (Some("write.ask"), Some((intely_agent_core::policy::decide::SessionAllowKind::Write, ""))));
    for input in [json!({"file_path": "package.json"}), json!({}), json!({"file_path": "/tmp/x"})] {
        assert!(decide_tool(&c, "Write", input.clone()).session_allow.is_none(), "{input}");
        assert!(session_allow_for(&c, &ToolIntent::from_claude_tool("Write", &input)).is_none(), "{input}");
    }
    let (saved, offer) = session_allow_for(&c, &ToolIntent::from_claude_tool("Edit", &json!({"file_path": "src/a.ts"}))).unwrap();
    assert_eq!((saved, offer.scope), (SavedAllow::WriteInside, String::new()));
    for mode in [PLAN, AUTO, BYPASS] {
        assert!(session_allow_for(&e.ctx(mode), &ToolIntent::from_claude_tool("Edit", &json!({"file_path": "src/a.ts"}))).is_none(), "{mode:?}");
    }
}

// ------------------------------------------------------------------------------------------------------------------- P-12

fn corpus(e: &Env) -> Vec<ToolIntent> {
    let exec = [
        "ls", "git status", "git log -5", "npm test", "npm run build", "node script.js", "node spawn.js", "node home.js", "echo $(date)", "eval x", "$CMD", "cat $F", "cat /etc/passwd", "cd /tmp && ls", "cp a.txt ../b",
        "echo x > /tmp/y", "rm -rf .", "rm -rf ~", "git clean -fd", "python3 -c 'print(1)'", "node -e x", "NODE_OPTIONS=x node script.js", "PATH=x ls", "curl https://example.com", "curl http://127.0.0.1", "nc host 80", "ssh host ls",
        "scp a host:", "rsync a host:b", "git commit -m x", "git push", "git add -A", "sh -c 'ls'", "sh -c 'git commit'", "wrangler deploy", "npm publish", "ps eww", "cat .env", "cat ~/.aws/credentials", "echo x > package.json",
        "FOO=1 ls", "ls 2>/dev/null", "ls | wc -l", "ls; ls", "ls && cat a.txt", "touch src/x", "mkdir -p a/b", "sed -i s/a/b/ src/a.ts", "tail -f a.txt", "find . -name x", "find . -delete", "xargs ls", "env ls", "sudo ls", "command ls",
        "exec -c ls", "git stash", "git reset --hard", "gh pr merge 1", "gh api x", "docker run x", "make", "cargo test", "pnpm install", "npx x", "python3 x.py", "awk '{print}' a.txt", "perl -e x", "ruby -e x", "bun -e y", "lsof -i",
        "launchctl print system", "dd of=/dev/disk2", "chmod -R 777 .", "chown -R x ..", "ln -s a b", "mv a b", "tar xf x.tar", "unzip x.zip", "wget https://example.com/a", "telnet host", "ftp host", "echo $HOME", "printf x",
        "cat <<EOF\nx\nEOF", "cat <(ls)", "ls `ls`", "a=1; echo $a", "export X=1", "alias ll=ls", "trap ls EXIT", "source x.sh", ". x.sh", "bash x.sh", "./x.sh", "git -C /tmp status", "git checkout -- .", "git restore .", "git clone https://example.com/r.git",
        "", "   ", ";", "&&", "((", "'", "\"", "`", "$(", "{a,b}", "\u{0}", "é日本", "ls \u{0}",
    ];
    let mut out: Vec<ToolIntent> = exec.iter().map(|c| ToolIntent::exec(c)).collect();
    let paths = ["src/a.ts", "package.json", ".git/config", ".env", "/tmp/x", "/etc/hosts", "~/.ssh/id_rsa", "~/.zshrc", "../x", "", "src/../../x", "/", "~"];
    for p in paths {
        out.push(ToolIntent::write(&[p]));
        out.push(ToolIntent::read(&[p]));
    }
    out.push(ToolIntent::write(&[]));
    out.push(ToolIntent::read(&[]));
    for u in ["https://docs.rs/x", "http://localhost/x", "ftp://x/y", "https://u@x/y", "", "http://10.0.0.1", "https://example.com/?q=x", "not a url"] {
        out.push(ToolIntent::net(u));
    }
    out.push(ToolIntent::from_claude_tool("WebSearch", &json!({"query": "x"})));
    for (server, tool) in [("fixture", "read"), ("fixture", "write"), ("other", "x"), ("nope", "x"), ("fixture", ""), ("", "x"), ("fixture", "a__b"), ("fixture", &"x".repeat(80))] {
        out.push(ToolIntent::mcp(server, tool));
    }
    for t in ["mcp__", "mcp____x", "mcp__a__"] {
        out.push(ToolIntent::from_claude_tool(t, &json!({})));
    }
    for t in ["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDir", "RefreshMcpTools"] {
        out.push(ToolIntent::from_claude_tool(t, &json!({})));
        out.push(ToolIntent::from_claude_tool(t, &json!({"server": "fixture", "uri": "file:///etc/hosts"})));
        out.push(ToolIntent::from_claude_tool(t, &json!({"server": "fixture", "uri": e.state.join("settings.json").display().to_string()})));
    }
    out.push(ToolIntent::from_claude_tool("mcp__fixture__read", &json!({"path": "~/.ssh/id_rsa", "n": 5})));
    for (_, t, _) in SDK_TOOL_COVERAGE {
        out.push(ToolIntent::from_claude_tool(t, &sample_input(t, e)));
    }
    for t in ["SomethingNew", "Task", "Agent", "ExitPlanMode", "EnterPlanMode", ""] {
        out.push(ToolIntent::from_claude_tool(t, &json!({"subagent_type": "ghost"})));
    }
    out.push(ToolIntent::new(ToolClass::Other, "nameless"));
    out.push(ToolIntent::new(ToolClass::Mcp, "nameless mcp"));
    out
}

fn sweep_ctx(e: &Env, mode: PermissionMode) -> PolicyContext {
    let mut c = coverage_ctx(e, mode);
    c.mcp_servers = vec!["fixture".into(), "other".into()];
    c.delegates = Some(
        [
            ("ro".to_string(), DelegateRule { mode: PermissionMode::ReadOnly, allowed_tools: None, role_deny: vec![], capped: false }),
            ("capped".to_string(), DelegateRule { mode: PermissionMode::Ask, allowed_tools: None, role_deny: vec![], capped: true }),
            ("dev".to_string(), DelegateRule { mode: PermissionMode::Edit, allowed_tools: None, role_deny: vec![], capped: false }),
            ("ask".to_string(), DelegateRule { mode: PermissionMode::Ask, allowed_tools: None, role_deny: vec![], capped: false }),
            (
                "scout".to_string(),
                DelegateRule { mode: PermissionMode::ReadOnly, allowed_tools: Some(["Read", "WebFetch", "WebSearch", "Skill", "ToolSearch", "TaskGet", "Bash"].map(String::from).to_vec()), role_deny: vec![], capped: false },
            ),
        ]
        .into(),
    );
    c
}

#[test]
fn the_unattended_modes_never_ask_for_any_class_actor_or_corpus_intent() {
    let e = env();
    let corpus = corpus(&e);
    assert!(corpus.len() >= 200, "{}", corpus.len());
    let mut judged = 0;
    for mode in [AUTO, BYPASS] {
        for actor in [None, Some("ro"), Some("capped"), Some("dev"), Some("ask"), Some("scout"), Some("?"), Some("ghost")] {
            let c = sweep_ctx(&e, mode);
            for intent in &corpus {
                let mut i = intent.clone();
                i.actor = actor.map(|r| Actor { agent_id: "x".into(), role: r.into() });
                let d = decide(&c, &request(i));
                assert_ne!(d.decision, Q, "{mode:?} {actor:?} {:?} {:?}: {d:?}", intent.tool, intent.raw_command);
                assert!(d.rule.is_some() && !d.reason.is_empty(), "{d:?}");
                judged += 1;
            }
        }
    }
    assert!(judged >= 3200, "{judged}");
}

#[test]
fn a_read_only_delegate_is_refused_not_asked_in_an_unattended_run_and_still_asks_in_an_attended_one_except_its_web_tools_which_just_work() {
    let e = env();
    let rows: [(&str, Value); 6] = [
        ("Read", json!({"file_path": "/etc/hosts"})),
        ("WebFetch", json!({"url": "https://docs.rs/x"})),
        ("WebSearch", json!({"query": "x"})),
        ("Skill", json!({})),
        ("ToolSearch", json!({})),
        ("TaskGet", json!({})),
    ];
    for (tool, input) in rows {
        for mode in [AUTO, BYPASS] {
            let mut i = ToolIntent::from_claude_tool(tool, &input);
            i.actor = Some(Actor { agent_id: "x".into(), role: "scout".into() });
            let d = decide_intent(&sweep_ctx(&e, mode), i);
            if matches!(tool, "WebFetch" | "WebSearch") {
                // the role lists the web tools: looking things up is its job, and an `ask` nobody can answer would only be a tool error
                assert_eq!(d.decision, Allow, "{tool} in {mode:?}: {d:?}");
                assert!(matches!(d.rule.as_deref(), Some("net.auto" | "net.bypass")), "{tool} in {mode:?}: {d:?}");
            } else {
                assert_eq!((d.decision, d.by, d.rule.as_deref()), (Deny, DecidedBy::RoleDeny, Some("delegate.read-only")), "{tool} in {mode:?}: {d:?}");
            }
        }
        for mode in [ASK, PLAN] {
            let mut i = ToolIntent::from_claude_tool(tool, &input);
            i.actor = Some(Actor { agent_id: "x".into(), role: "scout".into() });
            let d = decide_intent(&sweep_ctx(&e, mode), i);
            assert_eq!(d.decision, Q, "{tool} in {mode:?}: {d:?}");
        }
    }
}

// ------------------------------------------------------------------------------------------------------------------- P-14

#[test]
fn bypass_keeps_ids_are_the_ten_groups_of_the_confirm_dialog() {
    assert_eq!(BYPASS_KEEPS, ["git", "gitTricks", "protectedPaths", "persistence", "secrets", "wrangler", "ideState", "procEnv", "isolation", "catastrophic"]);
}

/// A representative per tool class that has a route to the group (never one class standing for all).
fn keeps(e: &Env) -> Vec<(&'static str, &'static str, Value, Vec<PermissionMode>)> {
    let all = PermissionMode::ALL.to_vec();
    let state = e.state.join("settings.json").display().to_string();
    let uri = format!("file://{state}");
    vec![
        ("git", "Bash", json!({"command": "git commit -m x"}), all.clone()),
        ("git", "Bash", json!({"command": "git push origin HEAD"}), all.clone()),
        ("git", "Bash", json!({"command": "git add -A"}), all.clone()),
        ("git", "Bash", json!({"command": "gh pr merge 3"}), all.clone()),
        ("gitTricks", "Bash", json!({"command": "PAGER=evil git log"}), all.clone()),
        ("gitTricks", "Bash", json!({"command": "git -c alias.x=commit x"}), all.clone()),
        ("gitTricks", "Bash", json!({"command": "python3 -c \"import os; os.system('git commit -m x')\""}), all.clone()),
        ("gitTricks", "Bash", json!({"command": "sh -c 'git commit -m x'"}), all.clone()),
        ("gitTricks", "Bash", json!({"command": "g=/usr/bin/git; $g commit -m x"}), vec![BYPASS]),
        ("protectedPaths", "Write", json!({"file_path": ".git/config"}), all.clone()),
        ("protectedPaths", "Bash", json!({"command": "echo x > .git/hooks/pre-commit"}), all.clone()),
        ("protectedPaths", "mcp__fixture__write", json!({"path": ".git/config"}), all.clone()),
        ("persistence", "Write", json!({"file_path": "~/.zshrc"}), all.clone()),
        ("persistence", "Bash", json!({"command": "cp x ~/.zshrc"}), all.clone()),
        ("persistence", "Bash", json!({"command": "echo x >> ~/.zshrc"}), all.clone()),
        ("secrets", "Read", json!({"file_path": "~/.aws/credentials"}), all.clone()),
        ("secrets", "Bash", json!({"command": "cat ~/.aws/credentials"}), all.clone()),
        ("secrets", "Bash", json!({"command": "rg -n . .env"}), all.clone()),
        ("secrets", "mcp__fixture__read", json!({"path": "~/.ssh/id_rsa"}), all.clone()),
        ("secrets", "ReadMcpResourceTool", json!({"server": "fixture", "uri": "file://~/.ssh/id_rsa"}), all.clone()),
        ("wrangler", "Bash", json!({"command": "wrangler deploy"}), all.clone()),
        ("wrangler", "Bash", json!({"command": "npx wrangler secret put X"}), all.clone()),
        ("wrangler", "Bash", json!({"command": "npm publish"}), all.clone()),
        ("ideState", "Read", json!({"file_path": state.clone()}), all.clone()),
        ("ideState", "Write", json!({"file_path": state.clone()}), all.clone()),
        ("ideState", "Bash", json!({"command": format!("cat \"{state}\"")}), all.clone()),
        ("ideState", "Bash", json!({"command": format!("cat \"{state}\" $(echo x)")}), vec![BYPASS]),
        ("ideState", "mcp__fixture__read", json!({"path": state.clone()}), all.clone()),
        ("ideState", "ReadMcpResourceTool", json!({"server": "fixture", "uri": uri}), all.clone()),
        ("procEnv", "Bash", json!({"command": "ps eww -ax"}), all.clone()),
        ("isolation", "Agent", json!({"subagent_type": "researcher", "isolation": "worktree"}), all.clone()),
        ("catastrophic", "Bash", json!({"command": "rm -rf ~"}), all.clone()),
        ("catastrophic", "Bash", json!({"command": "rm -rf /"}), all.clone()),
        ("catastrophic", "Bash", json!({"command": "dd if=/dev/zero of=/dev/disk2"}), all.clone()),
        ("catastrophic", "Bash", json!({"command": "diskutil eraseDisk APFS x disk2"}), all),
    ]
}

#[test]
fn every_group_of_the_bypass_dialog_is_a_hard_stop_in_all_five_modes_through_every_route() {
    let e = env();
    let reps = keeps(&e);
    for group in BYPASS_KEEPS {
        assert!(reps.iter().any(|r| r.0 == group), "no representative for {group}");
    }
    for (group, tool, input, modes) in &reps {
        for mode in modes {
            let mut c = coverage_ctx(&e, *mode);
            c.role_deny = vec![];
            let d = decide_tool(&c, tool, input.clone());
            assert_eq!((d.decision, d.by), (Deny, DecidedBy::HardStop), "{group}: {mode:?} {tool} {input}: {d:?}");
        }
    }
    // the groups that have a route through each class (a representative of one class does not stand for the others)
    for (group, classes) in [("secrets", ["Read", "Bash", "mcp__fixture__read"]), ("ideState", ["Read", "Bash", "mcp__fixture__read"]), ("protectedPaths", ["Write", "Bash", "mcp__fixture__write"]), ("persistence", ["Write", "Bash", "Bash"])] {
        for class in classes {
            assert!(reps.iter().any(|r| r.0 == group && r.1 == class), "{group} has no {class} representative");
        }
    }
    // a delegate reaches the same hard stops
    for (group, tool, input, modes) in &reps {
        if *tool == "Agent" || tool.starts_with("mcp__") || *tool == "ReadMcpResourceTool" {
            continue;
        }
        for mode in modes {
            let mut i = ToolIntent::from_claude_tool(tool, input);
            i.actor = Some(Actor { agent_id: "x".into(), role: "dev".into() });
            let d = decide_intent(&sweep_ctx(&e, *mode), i);
            assert_eq!((d.decision, d.by), (Deny, DecidedBy::HardStop), "{group}: delegate {mode:?} {tool} {input}: {d:?}");
        }
    }
}

// ------------------------------------------------------------------------------------------------------------------- P-23

#[test]
fn writes_to_the_persistence_list_are_hard_stops_in_every_mode_and_readers_are_not_stopped() {
    let e = env();
    let h = e.home.display().to_string();
    let places = [
        format!("{h}/.zshrc"), format!("{h}/.zshenv"), format!("{h}/.zprofile"), format!("{h}/.bash_profile"), format!("{h}/.profile"), format!("{h}/Library/LaunchAgents/x.plist"),
        "/Library/LaunchDaemons/x.plist".to_string(), format!("{h}/.npmrc"), format!("{h}/.claude.json"), format!("{h}/Library/Application Support/Claude/x"), format!("{h}/Library/Keychains/x"),
        "/usr/local/bin/git".to_string(), "/opt/homebrew/bin/x".to_string(), format!("{h}/.local/bin/x"), format!("{h}/bin/x"), "/etc/paths.d/x".to_string(), "/etc/zshrc".to_string(), "/etc/cron.d/x".to_string(),
        format!("{h}/.config/fish/config.fish"),
    ];
    for p in &places {
        for mode in PermissionMode::ALL {
            let c = e.ctx(mode);
            let (d, by, r) = run(&c, "Write", json!({ "file_path": p }));
            assert_eq!((d, by), (Deny, DecidedBy::HardStop), "{mode:?} Write {p}: {r}");
            for cmd in [format!("cp x '{p}'"), format!("echo x >> '{p}'")] {
                let (d, by, r) = run(&c, "Bash", json!({ "command": cmd }));
                assert_eq!((d, by), (Deny, DecidedBy::HardStop), "{mode:?} {cmd}: {r}");
                assert!(matches!(r.as_str(), "fs.protected" | "read.never-read" | "git.binary-copy"), "{cmd}: {r}");
            }
        }
    }
    // a `.zshrc` inside a run directory is an ordinary file
    let d = decide_tool(&e.ctx(EDIT), "Write", json!({"file_path": ".zshrc"}));
    assert_eq!((d.decision, d.rule.as_deref()), (Allow, Some("write.inside")));
    // readers are not stopped by the persistence rule
    let d = decide_tool(&e.ctx(BYPASS), "Bash", json!({"command": format!("cat {h}/.zshrc")}));
    assert_eq!((d.decision, d.rule.as_deref()), (Allow, Some("exec.bypass")));
    let d = decide_tool(&e.ctx(ASK), "Bash", json!({"command": format!("cat {h}/.zshrc")}));
    assert_eq!(d.decision, Q);
}

// ------------------------------------------------------------------------------------------------------- MCP server code (spec 5.4 step 4c)

#[test]
fn the_code_files_of_the_runs_mcp_servers_are_write_protected_in_every_mode_through_every_route() {
    let e = env();
    let tmp = tempfile::tempdir().unwrap();
    let lexical = tmp.path().join("tools");
    std::fs::create_dir_all(&lexical).unwrap();
    std::fs::write(lexical.join("server.js"), "x").unwrap();
    std::fs::write(lexical.join("helper.js"), "x").unwrap();
    // the supplier hands over the canonical path; the model may spell it the way `$TMPDIR` does (`/var/...` for `/private/var/...`)
    let canonical = std::fs::canonicalize(lexical.join("server.js")).unwrap();
    let spelled = lexical.join("server.js").display().to_string();
    for mode in PermissionMode::ALL {
        let mut c = e.ctx(mode);
        c.mcp_code_paths = vec![canonical.clone()];
        for tool in ["Write", "Edit", "MultiEdit"] {
            let (d, by, r) = run(&c, tool, json!({ "file_path": spelled }));
            assert_eq!((d, by, r.as_str()), (Deny, DecidedBy::HardStop, "fs.protected"), "{mode:?} {tool}");
        }
        let (d, by, r) = run(&c, "NotebookEdit", json!({ "notebook_path": spelled }));
        assert_eq!((d, by, r.as_str()), (Deny, DecidedBy::HardStop, "fs.protected"), "{mode:?} NotebookEdit");
        for cmd in [format!("cp x {spelled}"), format!("echo x > {spelled}"), format!("sed -i s/a/b/ {spelled}"), format!("rm {spelled}"), format!("mv {spelled} y")] {
            let (d, by, r) = run(&c, "Bash", json!({ "command": cmd }));
            assert_eq!((d, by), (Deny, DecidedBy::HardStop), "{mode:?} {cmd}: {r}");
        }
        // a sibling file in the same directory is not protected by this rule
        let sibling = lexical.join("helper.js").display().to_string();
        let (_, by, _) = run(&c, "Bash", json!({ "command": format!("rm {sibling}") }));
        assert_ne!(by, DecidedBy::HardStop, "{mode:?} sibling");
    }
}
