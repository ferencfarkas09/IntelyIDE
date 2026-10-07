//! The remote-eligibility table (remote-plan 4.1). Everything a phone may do is decided here, in Rust, from the same broker
//! (`agent_core::policy`) the desktop uses: hard stops are decided before a card exists, `low` is a strict allow-list (not
//! "looks harmless"; unparseable = not low), and nothing on the never-remote list is offered or accepted, whatever the client sends.

use std::path::Path;

use intely_agent_core::hub::{Eligibility, PendingKind, PendingRequest, Risk};
use intely_agent_core::policy::decide::{decide, Decision, PolicyContext};
use intely_agent_core::policy::hardstop::{analyze, Analysis};
use intely_agent_core::policy::intent::{PolicyRequest, ToolClass, ToolIntent};
use intely_agent_core::policy::paths::Jail;
use intely_agent_core::providers::PermissionMode;

use crate::util::sha256_hex;
use crate::wire::Capability;

/// A pending ask expires after this long and is never auto-allowed.
pub const REQUEST_TTL_MS: u64 = 5 * 60_000;

/// Mac-side configuration of the `low` shell class: package scripts that are read-only by convention.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LowList {
    pub package_scripts: Vec<String>,
}

impl Default for LowList {
    fn default() -> Self {
        Self { package_scripts: ["test", "lint", "typecheck"].map(String::from).to_vec() }
    }
}

/// Every row of the 4.1 table as an action, so the table is one `match` and one test.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteAction {
    ViewRuns,
    ViewDiff,
    AnswerQuestion,
    ApprovePlan,
    FollowUpPrompt,
    StopRun,
    StopAll,
    /// Approve a permission card, `Allow once`; the eligibility is the one computed for that card.
    ApproveOnce(Eligibility),
    /// "Allow for this run".
    AllowForRun,
    StartRun,
    ChangeRunConfig,
    AllowAlways,
    BulkApprove,
    HardStopped,
    GitWrite,
    RewindOrRollback,
    ChangeSettings,
    EnableRemoteOrKillOff,
    PairPromoteRevoke,
    FileBrowserOrTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Allowed,
    /// A fresh passkey assertion bound to the request.
    StepUp,
    Never(&'static str),
}

/// `run_mode` is the mode of the run the action is about (the LOOSER of its live effective mode and the one recorded for it; the recorded one for
/// a run with no live session), `None` when no run is involved or the run is unknown. Automatic and Bypass runs show no approval cards, so a
/// lost phone must not be able to steer them with a bare "do X": a follow-up to an Automatic run needs a passkey step-up bound to the run and the
/// prompt, and a Bypass run is steered on the Mac (permission-modes spec 5.7).
pub fn verdict(action: RemoteAction, cap: Capability, run_mode: Option<PermissionMode>) -> Verdict {
    use RemoteAction::*;
    match action {
        ViewRuns | ViewDiff => Verdict::Allowed,
        // everything below needs `reply`
        _ if cap < Capability::Reply => Verdict::Never("this device is view-only"),
        FollowUpPrompt => match run_mode {
            Some(PermissionMode::Bypass) => Verdict::Never("a Bypass run is steered on the Mac"),
            Some(PermissionMode::Automatic) => Verdict::StepUp,
            _ => Verdict::Allowed,
        },
        // stopping is always safe; the answer to a question is data, not an instruction to act
        AnswerQuestion | ApprovePlan | StopRun | StopAll => Verdict::Allowed,
        ApproveOnce(Eligibility::Low) => Verdict::Allowed,
        ApproveOnce(Eligibility::StepUp) | AllowForRun | StartRun => Verdict::StepUp,
        ApproveOnce(Eligibility::DesktopOnly) => Verdict::Never("this can only be decided on the Mac"),
        ChangeRunConfig => Verdict::Never("role, model, permission mode and effort are changed on the Mac"),
        AllowAlways | BulkApprove => Verdict::Never("saved rules and bulk approval are desktop-only"),
        HardStopped | GitWrite | RewindOrRollback => Verdict::Never("blocked by policy; the human does this in the IDE"),
        ChangeSettings | EnableRemoteOrKillOff | PairPromoteRevoke => Verdict::Never("desktop trusted-gesture only"),
        FileBrowserOrTerminal => Verdict::Never("does not exist remotely"),
    }
}

/// Hash of the intent exactly as the Mac judged it; a remote answer must quote it back.
pub fn intent_hash(agent_id: &str, req_id: &str, intent: &ToolIntent) -> String {
    let body = serde_json::to_string(intent).expect("intent serializes");
    sha256_hex(format!("intely-intent/v1\n{agent_id}\n{req_id}\n{body}").as_bytes())
}

/// Quoting and escaping must not hide the state directory: `Application\ Support`, `"$HOME/Library/..."`, `'..'`.
fn normalized(s: &str) -> String {
    s.chars().filter(|c| !matches!(c, '\\' | '\'' | '"')).collect::<String>().to_ascii_lowercase()
}

fn mentions_state_dir(ctx: &PolicyContext, intent: &ToolIntent) -> bool {
    let mut needles: Vec<String> = vec!["application support/intelyswitchide".into()];
    if let Some(d) = &ctx.state_dir {
        needles.push(normalized(&d.to_string_lossy()));
    }
    let hay = intent.raw_command.iter().chain(intent.argv.iter().flatten()).chain(intent.paths.iter()).chain(intent.url.iter());
    hay.into_iter().map(|h| normalized(h)).any(|h| needles.iter().any(|n| h.contains(n.as_str())))
}

/// Files that run when the human commits, pushes, installs or opens a shell, beyond the broker's own list (remote-plan 4.1).
fn runs_later(path: &Path) -> bool {
    let comps: Vec<String> = path.components().filter_map(|c| c.as_os_str().to_str().map(str::to_ascii_lowercase)).collect();
    let base = comps.last().map(String::as_str).unwrap_or("");
    let stem = base.split('.').next().unwrap_or("");
    comps.iter().any(|c| matches!(c.as_str(), "scripts" | ".husky" | ".githooks" | "hooks" | ".cargo" | "node_modules" | ".bin" | ".claude" | ".mcp" | ".github" | ".circleci" | ".devcontainer"))
        // tool configuration that is code or steers a tool the human runs: `*.config.*`, rc files, build and test setup
        || base.contains(".config.") || base.ends_with("rc") || base.contains("rc.") && base.starts_with('.')
        || matches!(stem, "dockerfile" | "containerfile" | "docker-compose" | "compose" | "build" | "conftest" | "sitecustomize" | "usercustomize" | "setup" | "gemfile" | "pom" | "gradlew" | "claude" | "agents" | "gemini")
        || matches!(base, ".mcp.json" | ".gitmodules" | "cargo.toml" | "pyproject.toml" | "setup.cfg" | "tox.ini" | "pnpm-workspace.yaml" | ".tool-versions" | ".node-version" | ".nvmrc" | ".envrc" | "build.gradle" | "build.gradle.kts" | "settings.gradle" | "cmakelists.txt" | "podfile" | "procfile" | "pipfile" | "requirements.txt" | "bunfig.toml" | "deno.json" | "lefthook.yml" | "mise.toml" | "flake.nix")
        || matches!(base, ".zshrc" | ".bashrc" | ".bash_profile" | ".profile" | ".zprofile" | ".zshenv" | "justfile" | "taskfile.yml" | "rakefile" | "makefile" | ".npmrc" | ".yarnrc" | ".yarnrc.yml" | ".gitattributes" | "package.json")
        || matches!(path.extension().and_then(|e| e.to_str()), Some("sh" | "bash" | "zsh" | "command" | "pth" | "gradle" | "mk" | "cmake" | "nix"))
}

fn package_script(words: &[String], list: &LowList) -> bool {
    let [pm, rest @ ..] = words else { return false };
    if !matches!(pm.as_str(), "npm" | "pnpm" | "yarn" | "bun") {
        return false;
    }
    match rest {
        [s] => list.package_scripts.iter().any(|x| x == s),
        [run, s] if run == "run" => list.package_scripts.iter().any(|x| x == s),
        _ => false,
    }
}

/// `grep -r`/`rg` walk whole trees (and `rg` always does): from a directory or from no path at all they read `.env`,
/// `.git/config` and friends, which no operand check can see. Only an explicit existing file is `low`.
fn recursive_search_unsafe(texts: &[String], jail: &Jail) -> bool {
    let name = texts.first().map(|t| t.rsplit('/').next().unwrap_or(t)).unwrap_or("");
    if !matches!(name, "grep" | "egrep" | "fgrep" | "rg") {
        return false;
    }
    let args = &texts[1..];
    let recursive = name == "rg"
        || args.iter().any(|t| {
            t == "recurse" || t.starts_with("--rec") || t.starts_with("--deref") || t.starts_with("--directories") || (t.starts_with('-') && !t.starts_with("--") && t.chars().any(|c| matches!(c, 'r' | 'R' | 'd')))
        });
    if !recursive {
        return false;
    }
    let has_e = args.iter().any(|t| t == "-e" || t == "--regexp" || (t.starts_with("-e") && !t.starts_with("--")));
    let mut operands: Vec<&String> = Vec::new();
    let mut after_dd = false;
    for t in args {
        if !after_dd && t == "--" {
            after_dd = true;
        } else if after_dd || !t.starts_with('-') {
            operands.push(t);
        }
    }
    if operands.iter().any(|t| jail.resolve(t).is_dir()) {
        return true;
    }
    let paths = if has_e { &operands[..] } else { operands.get(1..).unwrap_or(&[]) };
    !paths.iter().any(|t| jail.resolve(t).is_file())
}

/// Git commands that discard working-tree changes or write the user's global configuration: human-only, never behind a
/// passkey (remote-plan 4.1: any git write is never remote).
fn destructive_git(texts: &[String]) -> bool {
    if texts.first().map(String::as_str) != Some("git") {
        return false;
    }
    let mut i = 1;
    while let Some(t) = texts.get(i) {
        match t.as_str() {
            "-C" | "-c" | "--git-dir" | "--work-tree" | "--namespace" | "--config-env" => i += 2,
            _ if t.starts_with('-') => i += 1,
            _ => break,
        }
    }
    let Some(sub) = texts.get(i).map(|s| s.to_ascii_lowercase()) else { return false };
    let args = &texts[i + 1..];
    let any = |f: &dyn Fn(&str) -> bool| args.iter().any(|a| f(a));
    match sub.as_str() {
        "clean" | "restore" | "apply" | "am" => true,
        "checkout" => any(&|a| a == "." || a == "--" || a == "-f" || a == "--force" || a == "-p" || a == "--patch" || a == "--ours" || a == "--theirs"),
        "switch" => any(&|a| a == "-f" || a == "--force" || a == "--discard-changes"),
        "config" => any(&|a| matches!(a, "--global" | "--system" | "--worktree" | "--file" | "-f") || a.starts_with("--file=")),
        _ => false,
    }
}

/// The strict `low` shell allow-list: git status/diff/log/show/rev-parse/ls-files/blame and `git branch --list`, `ls`, `pwd`,
/// `cat`/`head`/`tail`/`wc`/`grep`/`rg` on workspace files, `node --check`, and the configured read-only package scripts.
/// No pipes, redirects, `$()`, `sh -c`, `env`, `xargs`, `find -exec`, `curl`, installs or `npx`.
fn low_exec(a: &Analysis, jail: &Jail, list: &LowList) -> bool {
    if a.hard_stop.is_some() || !a.issues.is_empty() || a.redirects_write || a.has_assigns {
        // a leading `VAR=value` (PATH, NODE_OPTIONS, LD_PRELOAD, BASH_ENV, HOME ...) changes what the command runs
        return false;
    }
    let cmds: Vec<&Vec<_>> = a.simple.iter().filter(|w| !w.is_empty()).collect();
    if cmds.len() != 1 {
        // `a && b` and pipelines are not low, even when each part is (the card must show one thing)
        return false;
    }
    let words = cmds[0];
    if words.iter().any(|w| w.dynamic || w.glob) {
        return false;
    }
    let texts: Vec<String> = words.iter().map(|w| w.text.clone()).collect();
    if package_script(&texts, list) {
        return a.scripts.len() <= 1;
    }
    if !a.scripts.is_empty() {
        return false;
    }
    // `git branch --list [-a|-r]`
    if texts.first().is_some_and(|t| t == "git") && texts.get(1).is_some_and(|t| t == "branch") {
        return texts.len() >= 3 && texts[2..].iter().all(|t| matches!(t.as_str(), "--list" | "-a" | "-r" | "--all" | "--remotes" | "-l")) && texts[2..].iter().any(|t| t == "--list" || t == "-l");
    }
    if recursive_search_unsafe(&texts, jail) {
        return false;
    }
    // `tail` has the same operand shape as `head`; borrow its (strict) judgement
    let mut cloned = a.clone();
    for cmd in cloned.simple.iter_mut() {
        if cmd.first().is_some_and(|w| w.text == "tail") {
            cmd[0].text = "head".into();
        }
    }
    intely_agent_core::policy::autoallow::is_low_risk_read(&cloned, jail)
}

fn risk_of(e: Eligibility, intent: &ToolIntent) -> Risk {
    match e {
        Eligibility::Low => Risk::Low,
        Eligibility::DesktopOnly => Risk::Blocked,
        Eligibility::StepUp => match intent.class {
            ToolClass::Write if intent.paths.iter().all(|p| !p.starts_with('/') && !p.starts_with('~') && !p.contains("..")) => Risk::Medium,
            ToolClass::Other => Risk::Medium,
            _ => Risk::High,
        },
    }
}

/// Eligibility of a permission request for a remote answer, re-computed from the broker's context. Used when the card is
/// built and again at answer time; the stricter of the two wins.
pub fn eligibility(ctx: &PolicyContext, intent: &ToolIntent, list: &LowList) -> (Eligibility, &'static str) {
    if mentions_state_dir(ctx, intent) {
        return (Eligibility::DesktopOnly, "touches the IDE's own state directory");
    }
    if intent.class == ToolClass::Mcp {
        // whatever the broker says (an unattended mode allows it): the phone never approves an MCP call, it would see only `server: tool`
        return (Eligibility::DesktopOnly, "MCP tools are approved on the Mac");
    }
    let req = PolicyRequest { agent_id: String::new(), tool_id: String::new(), provider: String::new(), intent: intent.clone() };
    let d = decide(ctx, &req);
    match d.decision {
        Decision::Deny => return (Eligibility::DesktopOnly, "blocked by policy"),
        Decision::Allow => return (Eligibility::Low, ""),
        Decision::Ask => {}
    }
    let jail = Jail::new(&ctx.cwd, &ctx.add_dirs, ctx.home.as_deref()).with_state_dir(ctx.state_dir.as_deref());
    match intent.class {
        ToolClass::Exec => {
            let a = match (&intent.raw_command, &intent.argv) {
                (Some(raw), _) => analyze(raw, &jail),
                (None, Some(argv)) if !argv.is_empty() => intely_agent_core::policy::hardstop::analyze_argv(argv, &jail),
                _ => return (Eligibility::StepUp, "no command to judge"),
            };
            let touches_state = ctx.state_dir.as_deref().is_some_and(|sd| a.simple.iter().flatten().filter(|w| !w.dynamic).any(|w| jail.resolve(&w.text).starts_with(sd)));
            let destructive = a.simple.iter().any(|w| destructive_git(&w.iter().map(|x| x.text.clone()).collect::<Vec<_>>()));
            if a.hard_stop.is_some() || touches_state || destructive {
                (Eligibility::DesktopOnly, "blocked by policy")
            } else if low_exec(&a, &jail, list) {
                (Eligibility::Low, "")
            } else {
                (Eligibility::StepUp, "a command outside the read-only allow-list")
            }
        }
        ToolClass::Write => {
            let resolved: Vec<_> = intent.paths.iter().map(|p| jail.resolve(p)).collect();
            if resolved.is_empty() {
                return (Eligibility::StepUp, "no target path to judge");
            }
            if resolved.iter().any(|p| jail.protected_reason(p).is_some()) {
                return (Eligibility::DesktopOnly, "writes a protected path");
            }
            if resolved.iter().any(|p| !jail.contains(p)) {
                return (Eligibility::StepUp, "writes outside the workspace");
            }
            if resolved.iter().any(|p| jail.exec_surface_reason(p).is_some() || runs_later(p)) {
                return (Eligibility::StepUp, "writes a file that runs at commit, push or install time");
            }
            (Eligibility::Low, "")
        }
        ToolClass::Read => (Eligibility::StepUp, "reads outside the workspace"),
        ToolClass::Net => (Eligibility::StepUp, "network access"),
        // the phone never approves an MCP call (it would see only `server: tool`); MCP is managed and approved on the Mac
        ToolClass::Mcp => (Eligibility::DesktopOnly, "MCP tools are approved on the Mac"),
        ToolClass::Other => match intent.tool.as_deref() {
            Some("ExitPlanMode") => (Eligibility::Low, ""),
            _ => (Eligibility::StepUp, "an unlisted tool"),
        },
    }
}

/// Builds the pending-request record a hub registers for a permission ask: eligibility, risk, intent hash and expiry.
pub fn pending_permission(agent_id: &str, req_id: &str, tool_id: &str, intent: &ToolIntent, ctx: &PolicyContext, list: &LowList, now_ms: u64) -> PendingRequest {
    let (eligibility, _) = eligibility(ctx, intent, list);
    PendingRequest {
        req_id: req_id.into(),
        agent_id: agent_id.into(),
        kind: PendingKind::Permission,
        tool_id: Some(tool_id.into()),
        intent: Some(intent.clone()),
        intent_hash: intent_hash(agent_id, req_id, intent),
        risk: risk_of(eligibility, intent),
        eligibility,
        expires_at: now_ms + REQUEST_TTL_MS,
        plan_excerpt: None,
        plan_truncated: None,
    }
}

/// Longest plan excerpt (bytes) a pending ExitPlanMode record carries to the phone.
pub const PLAN_EXCERPT_BYTES: usize = 2048;

/// The first 2 KiB of an already redacted plan (cut on a character boundary) and whether it was cut.
pub fn plan_excerpt(plan: &str) -> (String, bool) {
    if plan.len() <= PLAN_EXCERPT_BYTES {
        return (plan.to_string(), false);
    }
    let mut end = PLAN_EXCERPT_BYTES;
    while !plan.is_char_boundary(end) {
        end -= 1;
    }
    (plan[..end].to_string(), true)
}

/// The key of the passkey challenge that guards one follow-up prompt: bound to the run and to the exact text.
pub fn prompt_step_up_key(agent_id: &str, text: &str) -> String {
    format!("prompt:{agent_id}:{}", sha256_hex(text.as_bytes()))
}

/// `(agent id, text hash)` of a [`prompt_step_up_key`].
pub fn parse_prompt_step_up_key(key: &str) -> Option<(&str, &str)> {
    let (agent, hash) = key.strip_prefix("prompt:")?.rsplit_once(':')?;
    (!agent.is_empty() && hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())).then_some((agent, hash))
}

/// A question or plan approval: always answerable by a `reply` device, no step-up.
pub fn pending_question(agent_id: &str, req_id: &str, tool_id: Option<&str>, prompt: &str, now_ms: u64) -> PendingRequest {
    PendingRequest {
        req_id: req_id.into(),
        agent_id: agent_id.into(),
        kind: PendingKind::Question,
        tool_id: tool_id.map(str::to_string),
        intent: None,
        intent_hash: sha256_hex(format!("intely-question/v1\n{agent_id}\n{req_id}\n{prompt}").as_bytes()),
        risk: Risk::Low,
        eligibility: Eligibility::Low,
        expires_at: now_ms + REQUEST_TTL_MS,
        plan_excerpt: None,
        plan_truncated: None,
    }
}

/// Used by the gateway to refuse a path that points into the state dir without a full intent.
pub fn is_state_path(ctx: &PolicyContext, path: &Path) -> bool {
    ctx.state_dir.as_deref().is_some_and(|d| path.starts_with(d))
}
