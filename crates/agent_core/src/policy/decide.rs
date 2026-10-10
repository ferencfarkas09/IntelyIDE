//! The permission broker (providers-plan 1.6, 5.4; permission-modes spec 2). Order is fixed: hard stop -> role deny -> mode rules
//! -> saved allow -> ask. In the attended modes everything it cannot judge becomes `ask` (never a saved allow); in the unattended
//! modes (Automatic, Bypass) the verdict set is `{Allow, Deny}` (spec 2.4); a broken channel becomes `deny` (fail closed).
//! Every decision records `by`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::autoallow::{automatic_refusal, is_low_risk_read, is_private_host, net_auto_check, url_host};
use super::hardstop::{analyze, analyze_argv, raw_text_stop, Analysis};
use super::intent::{mcp_candidate, Actor, PolicyRequest, ToolClass, ToolIntent, MCP_RESOURCE_TOOLS};
use super::paths::{canonical_lossy, Jail};
use super::session_allow::{exec_offer, saved_exec_allows};
use crate::mcp::{fit as mcp_fit, normalize_tool_name, McpPolicy, McpServerRules, RESOURCES_TOOL};
use crate::events::types::DecidedBy;
use crate::providers::PermissionMode;

wire_enums! {
    pub enum Decision {
        Allow,
        Deny,
        Ask,
    }

    /// What kind of saved allow an "Allow always in this session" answer would create.
    pub enum SessionAllowKind {
        Exec,
        Net,
        Mcp,
        Write,
    }
}

wire_types! {
    /// Reply to `policy/decide`.
    #[serde(rename_all = "camelCase")]
    pub struct PolicyDecision {
        pub decision: Decision,
        pub by: DecidedBy,
        pub reason: String,
        /// Which rule fired (`git.push`, `fs.protected`, ...), for the Inspector and for tests.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub rule: Option<String>,
        /// Set only on an Ask the user could answer with "allow always in this session".
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub session_allow: Option<SessionAllowOffer>,
    }

    /// What an "Allow always in this session" answer would allow; the card states exactly this. Plain data: the UI
    /// composes the sentence from `kind` and `scope`.
    #[serde(rename_all = "camelCase")]
    pub struct SessionAllowOffer {
        pub kind: SessionAllowKind,
        /// exec: the argv prefix joined by one space (`git status`); net: the host; mcp: `server.tool`; write: empty.
        pub scope: String,
    }
}

/// A remembered "always allow". Never overrides a hard stop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SavedAllow {
    /// An exact argv prefix of one simple command (never a shell, never `sh -c`).
    ExecPrefix { argv: Vec<String> },
    NetHost { host: String },
    McpTool { server: String, tool: String },
    /// Edits inside the run directories that touch no exec-surface, protected or outside path (`{"kind":"writeInside"}`).
    WriteInside,
}

/// What the broker knows about one agent: its role and where it may work. Held by Rust, never sent over the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyContext {
    pub mode: PermissionMode,
    pub cwd: PathBuf,
    #[serde(default)]
    pub add_dirs: Vec<PathBuf>,
    #[serde(default)]
    pub home: Option<PathBuf>,
    /// Tool names the role forbids (exact, or a trailing `*` prefix glob such as `mcp__slack__*`).
    #[serde(default)]
    pub role_deny: Vec<String>,
    /// Subagent types the role may spawn (`*` = any).
    #[serde(default)]
    pub subagents: Vec<String>,
    /// MCP servers of the IDE's own set (`strict-mcp-config`).
    #[serde(default)]
    pub mcp_servers: Vec<String>,
    #[serde(default)]
    pub saved: Vec<SavedAllow>,
    /// The IDE's state directory (hard stop for writes, never-read for reads).
    #[serde(default)]
    pub state_dir: Option<PathBuf>,
    /// Writable-mode jail: a file-tool write outside `cwd` and `add_dirs` is a hard stop, not an Ask.
    #[serde(default)]
    pub strict_jail: bool,
    /// Scratch roots (`/tmp`, `/private/tmp`) where Automatic may keep temporary files: a plain `git show HEAD:f > /tmp/x` is how an
    /// agent compares a file with HEAD. Only Automatic uses them (Bypass has no boundary, Ask and Edit keep asking); never-read and
    /// protected paths stay refused there too.
    #[serde(default)]
    pub scratch_dirs: Vec<PathBuf>,
    /// `None` = a single-role run (the legacy path, judged exactly as before). `Some(map)` = delegation is active: the
    /// lead may start these roles and every call carrying an `actor` is judged by that role's rule ((design notes: roles-orchestration-spec) 5.2).
    #[serde(default)]
    pub delegates: Option<BTreeMap<String, DelegateRule>>,
    /// How many `Agent` calls the lead may make in this run.
    #[serde(default = "default_delegation_cap")]
    pub delegation_cap: u32,
    /// `Agent` calls admitted so far. Shared by every clone of this context and incremented inside `decide`, so parallel
    /// calls cannot exceed the cap.
    #[serde(default)]
    pub delegation_used: DelegationCounter,
    /// Saved allows of the delegates, keyed by role name. `saved` belongs to the lead (and to the legacy single-role
    /// path); an allowance granted to one role never applies to another.
    #[serde(default)]
    pub saved_by_role: BTreeMap<String, Vec<SavedAllow>>,
    /// Where the CLI may write its plan notes in Plan mode (permission-modes spec GZ-3); `None` = no carve-out.
    #[serde(default)]
    pub plan_dir: Option<PathBuf>,
    /// Per-server tool rules, keyed by server NAME, for the servers in `mcp_servers`. A server in `mcp_servers` without an entry
    /// is judged with `McpServerRules::default()` (default policy `ask`, no known tools).
    #[serde(default)]
    pub mcp_tools: BTreeMap<String, crate::mcp::McpServerRules>,
    /// Canonical paths of the code files of the run's stdio MCP servers (`McpResolved.code_paths`). A write to one of them is
    /// `fs.protected` in every mode, Bypass included (MCP spec 5.4 step 4c).
    #[serde(default)]
    pub mcp_code_paths: Vec<PathBuf>,
}

pub const DEFAULT_DELEGATION_CAP: u32 = 12;

fn default_delegation_cap() -> u32 {
    DEFAULT_DELEGATION_CAP
}

/// While on, an `Agent` call that omits `run_in_background` is denied (the Agent tool's own text says agents run in the
/// background by default, and a role must run in the foreground so the lead waits for its report). OFF: the foreground is forced
/// twice, by the sidecar's `updatedInput` rewrite (`run_in_background: false`, proven against the real CLI) and by
/// `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, which stops the CLI offering the parameter at all, so the model omits it. An explicit
/// `run_in_background: true` stays denied in every setting (`delegate.background`).
pub const STRICT_BACKGROUND: bool = false;

/// The rule the broker holds for one delegate role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegateRule {
    pub mode: PermissionMode,
    /// The role's tool allow-list (base names); `None` = inherits the lead's tools.
    #[serde(default)]
    pub allowed_tools: Option<Vec<String>>,
    /// Extra tool names the role forbids (same syntax as `PolicyContext::role_deny`).
    #[serde(default)]
    pub role_deny: Vec<String>,
    /// The role comes from a repository file whose permission the user never set explicitly: never lifted in an unattended run
    /// (permission-modes spec GZ-24).
    #[serde(default)]
    pub capped: bool,
}

/// An atomic counter that survives `Clone` by sharing: two clones of one context count together.
#[derive(Debug, Clone, Default)]
pub struct DelegationCounter(Arc<AtomicU32>);

impl DelegationCounter {
    pub fn get(&self) -> u32 {
        self.0.load(Ordering::SeqCst)
    }

    /// Counts one call unless `cap` is reached; `false` = refused. Atomic: two parallel callers at `cap - 1` get one `true`.
    pub fn try_take(&self, cap: u32) -> bool {
        self.0.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < cap).then_some(n + 1)).is_ok()
    }
}

impl PartialEq for DelegationCounter {
    fn eq(&self, other: &Self) -> bool {
        self.get() == other.get()
    }
}

impl Eq for DelegationCounter {}

impl Serialize for DelegationCounter {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u32(self.get())
    }
}

impl<'de> Deserialize<'de> for DelegationCounter {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(Self(Arc::new(AtomicU32::new(u32::deserialize(d)?))))
    }
}

impl PolicyContext {
    pub fn new(mode: PermissionMode, cwd: impl Into<PathBuf>) -> Self {
        Self { mode, cwd: cwd.into(), add_dirs: Vec::new(), home: None, role_deny: Vec::new(), subagents: Vec::new(), mcp_servers: Vec::new(), saved: Vec::new(), state_dir: None, strict_jail: false, scratch_dirs: Vec::new(), delegates: None, delegation_cap: DEFAULT_DELEGATION_CAP, delegation_used: DelegationCounter::default(), saved_by_role: BTreeMap::new(), plan_dir: None, mcp_tools: BTreeMap::new(), mcp_code_paths: Vec::new() }
    }
}

fn verdict(decision: Decision, by: DecidedBy, rule: &str, reason: impl Into<String>) -> PolicyDecision {
    PolicyDecision { decision, by, reason: reason.into(), rule: Some(rule.to_string()), session_allow: None }
}

fn hard_stop(rule: &str, reason: impl Into<String>) -> PolicyDecision {
    verdict(Decision::Deny, DecidedBy::HardStop, rule, reason)
}

fn role_deny(rule: &str, reason: impl Into<String>) -> PolicyDecision {
    verdict(Decision::Deny, DecidedBy::RoleDeny, rule, reason)
}

fn ask(rule: &str, reason: impl Into<String>) -> PolicyDecision {
    verdict(Decision::Ask, DecidedBy::Default, rule, reason)
}

fn allow(rule: &str, reason: impl Into<String>) -> PolicyDecision {
    verdict(Decision::Allow, DecidedBy::Default, rule, reason)
}

/// The channel was down, slow or garbled: refuse.
pub fn fail_closed(reason: impl Into<String>) -> PolicyDecision {
    verdict(Decision::Deny, DecidedBy::FailClosed, "fail-closed", reason)
}

/// Judges a `policy/decide` body; a missing context or a body that does not parse is a denial.
pub fn decide_wire(ctx: Option<&PolicyContext>, body: &Value) -> PolicyDecision {
    let Some(ctx) = ctx else { return fail_closed("no policy context for this agent") };
    match serde_json::from_value::<PolicyRequest>(body.clone()) {
        Ok(req) => decide(ctx, &req),
        Err(e) => fail_closed(format!("malformed policy request: {e}")),
    }
}

/// Same for raw text off the pipe (truncated or garbled JSON is a denial too).
pub fn decide_text(ctx: Option<&PolicyContext>, body: &str) -> PolicyDecision {
    match serde_json::from_str::<Value>(body) {
        Ok(v) => decide_wire(ctx, &v),
        Err(e) => fail_closed(format!("policy request is not JSON: {e}")),
    }
}

/// The rules that apply to ONE call: the run's, tightened (or, in the unattended modes, lifted) by the role of the actor
/// ((design notes: roles-orchestration-spec) 5.2, permission-modes spec 3).
struct Eff<'a> {
    ctx: &'a PolicyContext,
    /// The mode THIS call is judged in: the run mode for the lead, `delegate_mode` for a delegate.
    mode: PermissionMode,
    role_deny: Vec<String>,
    /// The role's tool allow-list; `None` = no list.
    allowed: Option<&'a [String]>,
    /// A read-only delegate that lists a web tool explicitly may ask for it (the legacy path keeps its denial).
    allow_net_ask: bool,
    saved: &'a [SavedAllow],
    /// The actor is not a role this run knows (`?` included): every call that gets past the hard stops is denied.
    unknown_actor: Option<&'a Actor>,
    actor: Option<&'a Actor>,
    delegating: bool,
    strict_background: bool,
}

/// The more restrictive of two modes on the ladder `PermissionMode::strictness`; a tie keeps `a`.
pub fn stricter(a: PermissionMode, b: PermissionMode) -> PermissionMode {
    if b.strictness() < a.strictness() {
        b
    } else {
        a
    }
}

/// The mode a delegate's call is judged in (permission-modes spec 3). Role tool allow/deny lists and the isolation hard stop apply
/// on top, always. `capped`: the role comes from a repository file whose permission the user never set explicitly; its permission is
/// a CEILING, not a grant, so an unattended run (no cards) never lifts it.
///
/// | run \ role | readOnly | ask | edit | capped |
/// |---|---|---|---|---|
/// | Plan | readOnly | readOnly | readOnly | readOnly |
/// | Ask | readOnly | ask | ask | ask |
/// | Edit | readOnly | ask | edit | ask |
/// | Automatic | readOnly | automatic | automatic | readOnly |
/// | Bypass | readOnly | bypass | bypass | readOnly |
pub fn delegate_mode(run: PermissionMode, role: PermissionMode, capped: bool) -> PermissionMode {
    use PermissionMode::*;
    if role == ReadOnly || run == ReadOnly {
        return ReadOnly;
    }
    // A capped role is a ceiling: it is never above `ask`, whatever its recorded permission says.
    let role = if capped && role == Edit { Ask } else { role };
    match run {
        Automatic | Bypass if capped => ReadOnly,
        Automatic | Bypass if matches!(role, Ask | Edit) => run,
        _ => stricter(run, role),
    }
}

fn effective<'a>(ctx: &'a PolicyContext, intent: &'a ToolIntent, strict_background: bool) -> Eff<'a> {
    let base = Eff {
        ctx,
        mode: ctx.mode,
        role_deny: ctx.role_deny.clone(),
        allowed: None,
        allow_net_ask: false,
        saved: &ctx.saved,
        unknown_actor: None,
        actor: None,
        delegating: ctx.delegates.is_some(),
        strict_background,
    };
    let (Some(map), Some(actor)) = (ctx.delegates.as_ref(), intent.actor.as_ref()) else { return base };
    let Some(rule) = map.get(&actor.role) else {
        // Unknown names and `?` (the sidecar could not name the agent) land here: fail closed, in every mode.
        return Eff { unknown_actor: Some(actor), actor: Some(actor), mode: PermissionMode::ReadOnly, ..base };
    };
    let mut role_deny = ctx.role_deny.clone();
    role_deny.extend(rule.role_deny.iter().cloned());
    role_deny.extend(["Agent".to_string(), "Task".to_string()]);
    let allow_net_ask = rule.allowed_tools.as_ref().is_some_and(|t| t.iter().any(|n| matches!(tool_base(n), "WebFetch" | "WebSearch")));
    Eff {
        mode: delegate_mode(ctx.mode, rule.mode, rule.capped),
        role_deny,
        allowed: rule.allowed_tools.as_deref(),
        allow_net_ask,
        saved: ctx.saved_by_role.get(&actor.role).map(Vec::as_slice).unwrap_or(&[]),
        actor: Some(actor),
        ..base
    }
}

/// What "allow always in this session" would save for this pending request, or `None` when it must not be offered.
/// Deterministic and side-effect free (it does not touch the delegation counter); the run mode and the actor's effective
/// mode must be `ask` or `edit`; the per-kind preconditions are the table of permission-modes spec 2.7. The host calls
/// the same function with the stored intent at answer time and trusts only its own result (spec 5.3).
pub fn session_allow_for(ctx: &PolicyContext, intent: &ToolIntent) -> Option<(SavedAllow, SessionAllowOffer)> {
    if !matches!(intent.class, ToolClass::Exec | ToolClass::Write | ToolClass::Net | ToolClass::Mcp) || !matches!(ctx.mode, PermissionMode::Ask | PermissionMode::Edit) {
        return None;
    }
    let (d, eff_mode) = judge(ctx, intent, STRICT_BACKGROUND);
    if d.decision != Decision::Ask || !matches!(eff_mode, PermissionMode::Ask | PermissionMode::Edit) {
        return None;
    }
    let offer = d.session_allow?;
    let saved = match offer.kind {
        SessionAllowKind::Exec => SavedAllow::ExecPrefix { argv: offer.scope.split(' ').map(str::to_string).collect() },
        SessionAllowKind::Net => SavedAllow::NetHost { host: offer.scope.clone() },
        SessionAllowKind::Mcp => {
            let (server, tool) = offer.scope.split_once('.')?;
            SavedAllow::McpTool { server: server.to_string(), tool: tool.to_string() }
        }
        SessionAllowKind::Write => SavedAllow::WriteInside,
    };
    Some((saved, offer))
}

/// `Bash(npm test:*)` -> `Bash`.
fn tool_base(name: &str) -> &str {
    name.split('(').next().unwrap_or(name).trim()
}

pub fn decide(ctx: &PolicyContext, req: &PolicyRequest) -> PolicyDecision {
    decide_with(ctx, req, STRICT_BACKGROUND)
}

/// [`decide`] with `STRICT_BACKGROUND` spelled out (tests exercise both settings).
pub fn decide_with(ctx: &PolicyContext, req: &PolicyRequest, strict_background: bool) -> PolicyDecision {
    let (d, eff_mode) = judge(ctx, &req.intent, strict_background);
    settle_unattended(ctx, eff_mode, d)
}

/// The verdict of the class rules and the mode the call was judged in.
fn judge(ctx: &PolicyContext, intent: &ToolIntent, strict_background: bool) -> (PolicyDecision, PermissionMode) {
    let jail = Jail::new(&ctx.cwd, &ctx.add_dirs, ctx.home.as_deref()).with_state_dir(ctx.state_dir.as_deref()).with_mcp_code_paths(&ctx.mcp_code_paths).with_scratch(&ctx.scratch_dirs);
    let eff = effective(ctx, intent, strict_background);
    let d = match intent.class {
        ToolClass::Exec => decide_exec(&eff, intent, &jail),
        ToolClass::Write => decide_write(&eff, intent, &jail),
        ToolClass::Read => decide_read(&eff, intent, &jail),
        ToolClass::Net => decide_net(&eff, intent),
        ToolClass::Mcp => decide_mcp(&eff, intent, &jail),
        ToolClass::Other => decide_other(&eff, intent),
    };
    (d, eff.mode)
}

/// The no-Ask invariant of the unattended modes (spec 2.4): a run in Automatic or Bypass never shows a card, so an `Ask` that a
/// rule still returns becomes a denial. A read-only delegate's table rows ask in an attended run; here they are the
/// `delegate.read-only` refusal. Any other `Ask` is a policy bug: it asserts in debug builds and is a fail-closed denial in release.
fn settle_unattended(ctx: &PolicyContext, eff_mode: PermissionMode, d: PolicyDecision) -> PolicyDecision {
    if d.decision != Decision::Ask || !ctx.mode.is_unattended() {
        return d;
    }
    let converted = convert_unattended_ask(eff_mode, d);
    debug_assert!(converted.rule.as_deref() == Some("delegate.read-only"), "the policy asked in an unattended mode: {converted:?}");
    converted
}

/// An `Ask` in an unattended run, as a denial (see [`settle_unattended`]).
fn convert_unattended_ask(eff_mode: PermissionMode, d: PolicyDecision) -> PolicyDecision {
    if eff_mode == PermissionMode::ReadOnly {
        return role_deny(
            "delegate.read-only",
            format!("this sub-agent is read-only and the run is unattended, so nothing can be asked ({}); give the role a write permission in Settings > Roles or switch the run to Ask", d.reason),
        );
    }
    role_deny("policy.ask-in-unattended", "internal: the policy asked in an unattended mode")
}

/// Called right after the hard stops of every class: the role layer of the order (hard stop -> role -> mode -> saved -> ask).
fn denied_by_role_list(eff: &Eff, intent: &ToolIntent) -> Option<PolicyDecision> {
    if let Some(d) = denied_by_role_list_unknown_actor(eff) {
        return Some(d);
    }
    let name = intent.tool.as_deref()?;
    if eff.role_deny.iter().any(|d| d == name || d.strip_suffix('*').is_some_and(|prefix| name.starts_with(prefix))) {
        return Some(role_deny("role.deny-list", format!("{name} is disabled for this role")));
    }
    if let Some(list) = eff.allowed {
        if !list.iter().any(|t| tool_base(t) == name) {
            let who = eff.actor.map(|a| a.role.as_str()).unwrap_or("this role");
            return Some(role_deny("role.tool-not-allowed", format!("{name} is not one of {who}'s tools")));
        }
    }
    None
}

/// An `Ask` that the user could answer with "allow always in this session" (spec 2.7).
fn ask_with_offer(rule: &str, reason: impl Into<String>, offer: Option<SessionAllowOffer>) -> PolicyDecision {
    PolicyDecision { session_allow: offer, ..ask(rule, reason) }
}

/// Where a plan notes file may live: the lead's `plan_dir` (spec GZ-3), canonical. `None` for a delegate or without a plan dir.
fn plan_dir_of(eff: &Eff) -> Option<PathBuf> {
    if eff.actor.is_some() {
        return None;
    }
    eff.ctx.plan_dir.as_ref().map(|d| canonical_lossy(d))
}

const PLAN_EXEC_REASON: &str = "plan mode runs only read-only commands inside the repositories (git status/log/diff/show/branch, ls, cat, head, tail, wc, grep, rg, sed -n 1,20p, awk '{print $1}', sort, uniq, cut, find without -exec or -delete; 2>/dev/null is fine, any other redirect, variable, substitution or script is not); switch to Ask, Accept edits or Automatic to run this";
const DELEGATE_EXEC_REASON: &str = "this role is read-only: it runs only read-only commands inside the repositories (git status/log/diff/show/branch, ls, cat, head, tail, wc, grep, rg, sed -n 1,20p, awk '{print $1}', sort, uniq, cut, find without -exec or -delete; 2>/dev/null is fine, any other redirect, variable, substitution or script is not); use the Read, Grep and Glob tools, or report back so the lead hands the change to a role that can write";

/// Why a read-only run or a read-only sub-agent may not run this command (the model re-plans from the text, so it must name what works).
fn read_only_exec_reason(eff: &Eff, jail: &Jail) -> String {
    let base = if eff.actor.is_some() { DELEGATE_EXEC_REASON } else { PLAN_EXEC_REASON };
    format!("{base}. The run's folders are: {}", jail.folders_hint())
}

fn decide_exec(eff: &Eff, intent: &ToolIntent, jail: &Jail) -> PolicyDecision {
    let analysis: Option<Analysis> = match (&intent.raw_command, &intent.argv) {
        (Some(raw), _) => Some(analyze(raw, jail)),
        (None, Some(argv)) if !argv.is_empty() => Some(analyze_argv(argv, jail)),
        _ => None,
    };
    if let Some(stop) = analysis.as_ref().and_then(|a| a.hard_stop.as_ref()) {
        return hard_stop(&stop.rule, format!("{} (commit, push and stage-all are done by the human in the IDE)", stop.reason));
    }
    // Bypass has no static check for what the analyser cannot judge; the raw text is searched instead (spec 2.3.1 `exec.raw-text`).
    if eff.mode == PermissionMode::Bypass && analysis.as_ref().is_some_and(|a| !a.issues.is_empty()) {
        let raw = match (&intent.raw_command, &intent.argv) {
            (Some(raw), _) => raw.clone(),
            (None, Some(argv)) => argv.join(" "),
            _ => String::new(),
        };
        if let Some(why) = raw_text_stop(&raw, jail) {
            return hard_stop("exec.raw-text", why);
        }
    }
    if let Some(d) = denied_by_role_list(eff, intent) {
        return d;
    }
    let Some(a) = analysis else {
        return match eff.mode {
            PermissionMode::ReadOnly => role_deny("role.read-only", read_only_exec_reason(eff, jail)),
            PermissionMode::Ask | PermissionMode::Edit => ask("exec.unparseable", "no command to judge"),
            PermissionMode::Automatic | PermissionMode::Bypass => role_deny("exec.unparseable", "no command to run: the call has neither a command string nor an argument list"),
        };
    };
    match eff.mode {
        PermissionMode::ReadOnly => {
            if is_low_risk_read(&a, jail) {
                allow("exec.low-risk-read", "read-only command on workspace files")
            } else {
                role_deny("role.read-only", read_only_exec_reason(eff, jail))
            }
        }
        PermissionMode::Automatic => match automatic_refusal(&a, jail) {
            Some(r) => role_deny(r.rule, r.reason),
            None => allow("exec.auto", "this run works without asking; the command analysed cleanly and stays inside the run's folders"),
        },
        PermissionMode::Bypass => allow("exec.bypass", "this run has no prompts and no folder boundary; hard stops still apply"),
        PermissionMode::Ask | PermissionMode::Edit => decide_exec_attended(eff, &a, jail),
    }
}

/// Ask and Edit: the rules of the attended modes (unchanged in meaning; saved prefixes now need the whole command to be clean).
fn decide_exec_attended(eff: &Eff, a: &Analysis, jail: &Jail) -> PolicyDecision {
    let scripts = if a.scripts.is_empty() { String::new() } else { format!(" [runs: {}]", a.scripts.join(" | ")) };
    if !a.issues.is_empty() {
        return ask("exec.unparseable", format!("cannot be judged statically: {}{scripts}", a.issues.join(", ")));
    }
    if !a.exec_surface_writes.is_empty() {
        // Like a Write/Edit of the same file: it runs when the human commits, so a saved prefix must not cover it.
        return ask(
            "exec.write-exec-surface",
            format!("writes {}, which executes code when you commit, push, install, lint, test or build", a.exec_surface_writes.join(", ")),
        );
    }
    if !a.scripts.is_empty() {
        // The script text can change after a "yes", so it is never a saved allow; the card shows what it runs.
        return ask("exec.script", format!("runs a script that contains no git write or protected path{scripts}"));
    }
    if saved_exec_allows(eff.saved, a, jail) {
        return verdict(Decision::Allow, DecidedBy::Saved, "exec.saved", "matches a saved command prefix");
    }
    if eff.mode == PermissionMode::Edit && is_low_risk_read(a, jail) {
        return allow("exec.low-risk-read", "read-only command on workspace files");
    }
    let offer = exec_offer(a, jail).map(|prefix| SessionAllowOffer { kind: SessionAllowKind::Exec, scope: prefix.join(" ") });
    ask_with_offer("exec.ask", "commands need approval unless saved", offer)
}

fn decide_write(eff: &Eff, intent: &ToolIntent, jail: &Jail) -> PolicyDecision {
    let resolved: Vec<PathBuf> = intent.paths.iter().map(|p| jail.resolve(p)).collect();
    // The CLI writes its plan notes in Plan mode with no prompt: one narrow carve-out for the lead (spec GZ-3), before the
    // protected-path test because the plan directory lives under the state directory.
    if eff.mode == PermissionMode::ReadOnly && !resolved.is_empty() {
        if let Some(dir) = plan_dir_of(eff) {
            if resolved.iter().all(|p| p.starts_with(&dir) && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("md"))) {
                if let Some(d) = denied_by_role_list(eff, intent) {
                    return d;
                }
                return allow("plan.file", "plan notes file of this run");
            }
        }
    }
    for p in &resolved {
        if let Some(why) = jail.protected_reason(p) {
            return hard_stop("fs.protected", format!("{why} is never written by an agent ({})", p.display()));
        }
    }
    // Bypass has no folder boundary whatever `strict_jail` says; every other mode keeps it.
    let strict = eff.ctx.strict_jail && eff.ctx.mode != PermissionMode::Bypass;
    let inside = |p: &PathBuf| jail.contains(p) || (eff.mode == PermissionMode::Automatic && jail.in_scratch(p));
    if strict {
        if let Some(outside) = resolved.iter().find(|p| !inside(p)) {
            return hard_stop("fs.outside-jail", format!("{} is outside the repositories of this run; agents write only inside them", outside.display()));
        }
    }
    if let Some(d) = denied_by_role_list(eff, intent) {
        return d;
    }
    if eff.mode == PermissionMode::ReadOnly {
        return role_deny("role.read-only", "a read-only role cannot write; in plan mode the plan notes file is the only thing that is written");
    }
    if resolved.is_empty() {
        return match eff.mode {
            PermissionMode::Automatic | PermissionMode::Bypass => role_deny("write.no-path", "no target path to judge: the call names no file"),
            _ => ask("write.no-path", "no target path to judge"),
        };
    }
    if let Some(outside) = resolved.iter().find(|p| !inside(p)) {
        return match eff.mode {
            PermissionMode::Automatic => role_deny("write.auto.outside", format!("{} is outside the run's folders; Automatic edits only inside them. The run's folders are: {}. Write inside one of them, or ask the user to switch to Bypass or to add the folder", outside.display(), jail.folders_hint())),
            PermissionMode::Bypass => allow("write.bypass", "this run has no folder boundary"),
            _ => ask("write.outside", format!("{} is outside the working directories", outside.display())),
        };
    }
    match eff.mode {
        PermissionMode::Automatic => return allow("write.auto", "this run works without asking inside its folders"),
        PermissionMode::Bypass => return allow("write.bypass", "this run has no prompts"),
        _ => {}
    }
    if let Some(why) = resolved.iter().find_map(|p| jail.exec_surface_reason(p)) {
        return ask("write.exec-surface", format!("{why}; it executes code when you commit, push, install, lint, test or build"));
    }
    if eff.saved.iter().any(|s| matches!(s, SavedAllow::WriteInside)) {
        return verdict(Decision::Allow, DecidedBy::Saved, "write.saved", "edits inside the run's folders are allowed for this session");
    }
    if eff.mode == PermissionMode::Edit {
        return allow("write.inside", "edit role writing inside the working directory");
    }
    ask_with_offer("write.ask", "this role asks before every write", Some(SessionAllowOffer { kind: SessionAllowKind::Write, scope: String::new() }))
}

fn decide_read(eff: &Eff, intent: &ToolIntent, jail: &Jail) -> PolicyDecision {
    let resolved: Vec<PathBuf> = intent.paths.iter().map(|p| jail.resolve(p)).collect();
    // The lead may read its own plan notes in every mode (spec GZ-3), before the never-read list (the directory is under the state dir).
    if !resolved.is_empty() {
        if let Some(dir) = plan_dir_of(eff) {
            if resolved.iter().all(|p| p.starts_with(&dir)) {
                if let Some(d) = denied_by_role_list(eff, intent) {
                    return d;
                }
                return allow("read.plan-file", "plan notes file of this run");
            }
        }
    }
    if let Some((p, why)) = resolved.iter().find_map(|p| jail.never_read_reason(p).map(|w| (p, w))) {
        return hard_stop("read.never-read", format!("{why}: {} is on the agent never-read list", p.display()));
    }
    if let Some(d) = denied_by_role_list(eff, intent) {
        return d;
    }
    if let Some(outside) = resolved.iter().find(|p| !(jail.contains(p) || (eff.mode == PermissionMode::Automatic && jail.in_scratch(p)))) {
        return match eff.mode {
            PermissionMode::Automatic => role_deny("read.auto.outside", format!("{} is outside the run's folders; Automatic reads only inside them. The run's folders are: {}. Search each repository separately, or ask the user to switch to Bypass or to add the folder", outside.display(), jail.folders_hint())),
            PermissionMode::Bypass => allow("read.bypass", "this run has no folder boundary"),
            _ if eff.mode == PermissionMode::ReadOnly => ask("read.outside", format!("{} is outside the working directories. The run's folders are: {}. Search each repository separately", outside.display(), jail.folders_hint())),
            _ => ask("read.outside", format!("{} is outside the working directories", outside.display())),
        };
    }
    allow("read.inside", "read inside the working directories")
}

fn decide_net(eff: &Eff, intent: &ToolIntent) -> PolicyDecision {
    if let Some(d) = denied_by_role_list(eff, intent) {
        return d;
    }
    let read_only = eff.mode == PermissionMode::ReadOnly;
    // A Plan lead may ask for the web (spec GZ-2); a read-only DELEGATE keeps its denial unless its role lists the web tool.
    if read_only && eff.actor.is_some() && !eff.allow_net_ask {
        return role_deny("role.read-only", "a read-only role has no network access");
    }
    // A read-only delegate whose role lists the web tools, in a run nobody answers (Automatic, Bypass): looking things up is the point of
    // such a role, and `ask` would only turn into a denial there. It is judged by the run's own network rule.
    if read_only && eff.actor.is_some() && eff.ctx.mode.is_unattended() {
        return if eff.ctx.mode == PermissionMode::Bypass { allow("net.bypass", "this run has no prompts") } else { decide_net_auto(intent) };
    }
    match eff.mode {
        PermissionMode::Automatic => return decide_net_auto(intent),
        PermissionMode::Bypass => return allow("net.bypass", "this run has no prompts"),
        _ => {}
    }
    let Some(url) = intent.url.as_deref() else { return ask("net.no-url", "no URL to judge (search)") };
    let Some(host) = url_host(url) else { return ask("net.odd-url", "not a plain http(s) URL") };
    // A long URL or one with line breaks may carry file content out: always ask, never saved.
    if url.len() > 300 || url.contains(['\n', '\r', '\0']) {
        return ask("net.exfil-shape", format!("URL to {host} is unusually long and could carry file content"));
    }
    // A saved host never applies to a read-only effective mode: the role was never meant to reach the network on its own.
    if !read_only && eff.saved.iter().any(|s| matches!(s, SavedAllow::NetHost { host: h } if h.eq_ignore_ascii_case(&host))) {
        return verdict(Decision::Allow, DecidedBy::Saved, "net.saved", format!("{host} is saved for this role"));
    }
    // Never offered for a private host, an IP literal or a bare name (spec 2.7).
    let offer = (!read_only && !is_private_host(&host)).then(|| SessionAllowOffer { kind: SessionAllowKind::Net, scope: host.clone() });
    ask_with_offer("net.ask", format!("first request to {host}"), offer)
}

/// Automatic: web search and plain http(s) fetches of public hosts; everything the Ask rules would call odd is refused.
fn decide_net_auto(intent: &ToolIntent) -> PolicyDecision {
    let Some(url) = intent.url.as_deref() else { return allow("net.auto", "web search") };
    match net_auto_check(url) {
        Ok(host) => allow("net.auto", format!("plain http(s) request to {host}")),
        Err((rule, reason)) => role_deny(rule, reason),
    }
}

/// MCP calls (mcp-management spec 5.4): the order is parse, delegate, membership, role list, argument guard, tool policy, the
/// unlisted-tool rule of Automatic, then the mode rows. Normative: that spec; this is its implementation.
fn decide_mcp(eff: &Eff, intent: &ToolIntent, jail: &Jail) -> PolicyDecision {
    let tool_name = intent.tool.as_deref().unwrap_or_default();
    let server = intent.server.as_deref().unwrap_or_default();
    let resource_tool = MCP_RESOURCE_TOOLS.contains(&tool_name);
    if resource_tool && server.is_empty() {
        return role_deny("mcp.resource-server", format!("{tool_name} without a server: name the MCP server, nothing is judged on a wildcard"));
    }
    let tool: Option<&str> = if resource_tool {
        Some(RESOURCES_TOOL)
    } else {
        tool_name.strip_prefix("mcp__").and_then(|t| t.strip_prefix(server)).and_then(|t| t.strip_prefix("__"))
    };
    let Some(tool) = tool.filter(|t| !server.is_empty() && !t.is_empty()) else {
        return role_deny("mcp.unknown", "MCP call without a server and a tool name");
    };
    if intent.actor.is_some() {
        return role_deny("mcp.delegate", "sub-agents do not get MCP tools");
    }
    if !eff.ctx.mcp_servers.iter().any(|s| s == server) {
        return role_deny("mcp.not-in-set", format!("MCP server {server} is not in the IDE's MCP set"));
    }
    if let Some(d) = denied_by_role_list(eff, intent) {
        return d;
    }
    // 4b. The argument guard: a string that points at the IDE's own state, a secret or a protected path is a hard stop in every mode.
    if intent.args_unjudgeable {
        return hard_stop("mcp.args-unjudgeable", format!("{server}.{tool}: the arguments are too large or too deep to check"));
    }
    let candidates: Vec<&str> = intent.args.iter().filter_map(|a| mcp_candidate(a)).collect();
    if candidates.len() > MCP_MAX_ARG_CANDIDATES {
        return hard_stop("mcp.args-unjudgeable", format!("{server}.{tool}: the arguments are too large or too deep to check"));
    }
    for c in candidates {
        let p = jail.resolve(c.strip_prefix("file://").unwrap_or(c));
        if let Some(why) = jail.protected_reason(&p).or_else(|| jail.never_read_reason(&p)) {
            return hard_stop("mcp.protected-arg", format!("{server}.{tool}: an argument points at {why}"));
        }
    }
    // 5. The user's tool policy (per-tool override, else the server default).
    let default_rules = McpServerRules::default();
    let rules = eff.ctx.mcp_tools.get(server).unwrap_or(&default_rules);
    let key = if tool == RESOURCES_TOOL { tool.to_string() } else { mcp_fit(server, &normalize_tool_name(tool)) };
    let v = rules.effective(&key);
    if v.policy == McpPolicy::Deny {
        return role_deny("mcp.policy-deny", format!("{server}.{tool} is set to Deny in Settings > MCP servers"));
    }
    if eff.mode == PermissionMode::Automatic && !v.listed && rules.default_policy != McpPolicy::Allow {
        return role_deny("mcp.unlisted-tool", format!("{server}.{tool} was not in the last test of this server: run Test again in Settings > MCP servers"));
    }
    match eff.mode {
        PermissionMode::ReadOnly => {
            if v.policy == McpPolicy::Allow && v.read_only {
                allow("mcp.plan-read-only", format!("{server}.{tool} is allowed and marked read-only"))
            } else {
                role_deny("role.read-only", format!("{server}.{tool} is not a tool the user allowed and the server marked read-only; plan mode uses only those"))
            }
        }
        PermissionMode::Ask | PermissionMode::Edit => {
            if v.read_only {
                return allow("mcp.read-only", format!("{server}.{tool} is marked read-only"));
            }
            if v.policy == McpPolicy::Allow {
                return allow("mcp.policy-allow", format!("{server}.{tool} is set to Allow in Settings > MCP servers"));
            }
            if eff.saved.iter().any(|s| matches!(s, SavedAllow::McpTool { server: s, tool: t } if s == server && t == tool)) {
                return verdict(Decision::Allow, DecidedBy::Saved, "mcp.saved", format!("{server}.{tool} is saved for this session"));
            }
            ask_with_offer("mcp.ask", format!("{server}.{tool} needs approval"), Some(SessionAllowOffer { kind: SessionAllowKind::Mcp, scope: format!("{server}.{tool}") }))
        }
        PermissionMode::Automatic => allow("mcp.auto", format!("{server}.{tool}: this run works without asking")),
        PermissionMode::Bypass => allow("mcp.bypass", format!("{server}.{tool}: this run has no prompts")),
    }
}

/// More candidate strings than this and the call is `mcp.args-unjudgeable` (the sidecar caps at the same number).
const MCP_MAX_ARG_CANDIDATES: usize = 256;

/// The `Agent`/`Task` tool: neutralises its dangerous inputs and, when delegation is active, admits only the roles of this run.
fn decide_spawn(eff: &Eff, intent: &ToolIntent) -> PolicyDecision {
    let name = intent.tool.as_deref().unwrap_or("Agent");
    // A worktree or remote environment: never, in any run.
    if intent.isolation.as_deref().is_some_and(|i| !i.is_empty()) {
        return hard_stop("delegate.isolation", format!("{name} with isolation creates a worktree or remote environment; agents work inside the run's repositories"));
    }
    if eff.delegating {
        if let Some(d) = denied_by_role_list_unknown_actor(eff) {
            return d;
        }
        if eff.actor.is_some() {
            return role_deny("delegate.nested", "an agent cannot start other agents");
        }
    }
    if let Some(d) = denied_by_role_list(eff, intent) {
        return d;
    }
    let flags = intent.subagent_flags.as_ref();
    if flags.is_some_and(|f| f.has_model) {
        return role_deny("delegate.model", "do not set model; the role decides");
    }
    if !eff.delegating {
        return match intent.subagent_type.as_deref() {
            Some(t) if eff.ctx.subagents.iter().any(|s| s == t || s == "*") => allow("other.subagent", format!("role may spawn {t}")),
            _ => match eff.mode {
                PermissionMode::Automatic => role_deny("other.subagent", "this subagent type is not listed for this role; ask the user to switch to Bypass or list it in the role"),
                PermissionMode::Bypass => allow("other.bypass", "this run has no prompts"),
                _ => ask("other.subagent", "subagent type is not listed for this role"),
            },
        };
    }
    let background = flags.and_then(|f| f.background);
    if background == Some(true) || (background.is_none() && eff.strict_background) {
        return role_deny("delegate.background", "run the agent in the foreground (run_in_background: false)");
    }
    let map = eff.ctx.delegates.as_ref();
    let valid = || map.map(|m| m.keys().cloned().collect::<Vec<_>>().join(", ")).unwrap_or_default();
    match intent.subagent_type.as_deref() {
        Some(t) if map.is_some_and(|m| m.contains_key(t)) => {
            if !eff.ctx.delegation_used.try_take(eff.ctx.delegation_cap) {
                return role_deny("delegate.cap", format!("delegation limit of {} reached; do the rest yourself", eff.ctx.delegation_cap));
            }
            allow("delegate.spawn", format!("starts the {t} role"))
        }
        other => role_deny("delegate.unknown-type", format!("{} is not one of this run's roles; valid roles: {}", other.unwrap_or("(no subagent_type)"), valid())),
    }
}

fn denied_by_role_list_unknown_actor(eff: &Eff) -> Option<PolicyDecision> {
    let actor = eff.unknown_actor?;
    let valid: Vec<&str> = eff.ctx.delegates.iter().flat_map(|m| m.keys().map(String::as_str)).collect();
    if actor.role == "?" {
        // the Claude CLI sent no agent id for a call made while a sub-agent was running; the call may be the sub-agent's or the lead's
        return Some(role_deny(
            "delegate.unknown-actor",
            "the IDE could not tell which agent made this call (the Claude CLI sent no agent id while a sub-agent was running), so it refused the call to stay safe; run the same call again",
        ));
    }
    Some(role_deny("delegate.unknown-actor", format!("the caller ({}) is not one of this run's roles; valid roles: {}", actor.role, valid.join(", "))))
}

/// Tools that only touch the session's own UI and task state, or read: Automatic and Bypass run them (spec 2.2 `AUTO_KNOWN_OTHER`).
pub const AUTO_KNOWN_OTHER: [&str; 17] = [
    "TodoWrite", "AskUserQuestion", "ExitPlanMode", "TaskCreate", "TaskUpdate", "TaskStop", "TaskGet", "TaskList", "TaskOutput", "BashOutput", "KillShell", "ToolSearch", "Skill", "CronList",
    "ReadNotifications", "ReportFindings", "ShowOnboardingRolePicker",
];

/// Tools that create state outliving the session or living outside the run directories, or that publish, upload or send something
/// off the machine, where no command analysis or hard stop can see it (spec GZ-6): denied in Automatic AND Bypass. `Mcp` is the
/// generic open-ended tool; `Monitor` is here for its `ws` form (a `Monitor` with a command is judged as a command).
pub const OTHER_STATE_CHANGE: [&str; 16] = [
    "EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "RemoteTrigger", "ScheduleWakeup", "Workflow", "Artifact", "Projects", "ClaudeDesign", "SendFeedback", "PushNotification",
    "ProposeSkills", "ProposeGoal", "Mcp", "Monitor",
];

fn decide_other(eff: &Eff, intent: &ToolIntent) -> PolicyDecision {
    use PermissionMode::*;
    let Some(name) = intent.tool.as_deref() else {
        return match eff.mode {
            Automatic | Bypass => role_deny("other.auto.unknown-tool", "tool without a name"),
            _ => ask("other.unknown", "tool without a name"),
        };
    };
    if matches!(name, "Task" | "Agent") {
        return decide_spawn(eff, intent);
    }
    // An MCP-looking name that arrived as another class is not judged as an unknown tool (Bypass would allow it).
    if name.starts_with("mcp__") {
        return role_deny("mcp.unknown", "MCP call that was not classified as one: it is refused");
    }
    if let Some(d) = denied_by_role_list(eff, intent) {
        return d;
    }
    match name {
        // Leaving plan mode is the human's call, not the agent's; a delegate never gets to ask (spec GZ-8).
        "ExitPlanMode" if eff.actor.is_some() => role_deny("other.exit-plan-delegate", "only the lead can leave plan mode; a sub-agent reports its plan back instead"),
        "ExitPlanMode" if eff.mode == ReadOnly => ask("other.exit-plan", "a read-only run asks before leaving plan mode"),
        // The CLI would flip to plan mode while Rust stays in the run mode (spec GZ-7).
        "EnterPlanMode" => role_deny("other.enter-plan", "EnterPlanMode is disabled: switching modes is the user's choice"),
        "TodoWrite" | "ExitPlanMode" | "AskUserQuestion" => allow("other.ui-card", format!("{name} is rendered as a UI card")),
        "ToolSearch" if eff.actor.is_none() => allow("other.tool-search", "ToolSearch only loads tool definitions"),
        "TaskCreate" | "TaskUpdate" | "TaskStop" => match eff.mode {
            ReadOnly => role_deny("other.read-only", format!("{name} changes state, which a read-only role may not do")),
            Ask | Edit => ask("other.unknown", format!("unknown tool {name}")),
            Automatic => allow("other.auto", format!("{name} only touches the session's own task state")),
            Bypass => allow("other.bypass", format!("{name} only touches the session's own task state")),
        },
        n if AUTO_KNOWN_OTHER.contains(&n) => match eff.mode {
            ReadOnly | Ask | Edit => ask("other.unknown", format!("unknown tool {name}")),
            Automatic => allow("other.auto", format!("{name} only reads or touches the session's own state")),
            Bypass => allow("other.bypass", format!("{name} only reads or touches the session's own state")),
        },
        n if OTHER_STATE_CHANGE.contains(&n) => match eff.mode {
            ReadOnly => role_deny("other.read-only", format!("{name} changes state, which a read-only role may not do")),
            Ask | Edit => ask("other.unknown", format!("unknown tool {name}")),
            Automatic | Bypass => role_deny("other.state-change", format!("{name} creates state outside the run or sends something off this machine, which no unattended mode allows; ask the user to do it or switch to Ask")),
        },
        _ => match eff.mode {
            ReadOnly | Ask | Edit => ask("other.unknown", format!("unknown tool {name}")),
            Automatic => role_deny("other.auto.unknown-tool", format!("{name} is not a tool this version knows, so Automatic cannot judge it; ask the user to switch to Bypass or to Ask")),
            Bypass => allow("other.bypass", format!("{name}: this run has no prompts")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_forced_ask_in_an_unattended_run_is_a_denial() {
        let ask = PolicyDecision { decision: Decision::Ask, by: DecidedBy::Default, reason: "x".into(), rule: Some("some.rule".into()), session_allow: None };
        let d = convert_unattended_ask(PermissionMode::Automatic, ask.clone());
        assert_eq!((d.decision, d.by, d.rule.as_deref()), (Decision::Deny, DecidedBy::RoleDeny, Some("policy.ask-in-unattended")));
        let d = convert_unattended_ask(PermissionMode::ReadOnly, ask);
        assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("delegate.read-only")));
        assert!(d.reason.contains("Settings > Roles"));
    }

    #[test]
    fn stricter_keeps_the_first_on_a_tie() {
        use PermissionMode::*;
        assert_eq!(stricter(Edit, Ask), Ask);
        assert_eq!(stricter(Ask, Edit), Ask);
        assert_eq!(stricter(Automatic, Bypass), Automatic);
        assert_eq!(stricter(Bypass, ReadOnly), ReadOnly);
    }
}
