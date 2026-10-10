//! Host configuration and the environment hygiene around the sidecar (providers-plan 4.2, 5.5).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use intely_agent_core::delegates::DelegateResolver;
use intely_agent_core::mcp::{McpRulesSupplier, McpScrubSupplier, McpSupplier};
use intely_agent_core::providers::Effort;
use intely_agent_gate::{CancelPlan, GateConfig};

use crate::roles::RoleDef;
use crate::run::RepoRef;

/// Supplies the login-shell environment at the moment it is needed (it resolves asynchronously after startup).
pub type EnvSupplier = Arc<dyn Fn() -> HashMap<String, String> + Send + Sync>;

/// Finds a role by name for a run on `repos`: the Roles layer's files and overlay. `None` falls back to the built-ins.
pub type RoleResolver = Arc<dyn Fn(&str, &[RepoRef]) -> Option<RoleDef> + Send + Sync>;

/// What the Auto lead runs with, read from Settings > Roles ("Auto run") at every start. Already resolved: the model is an id
/// and the effort is what that model can do (`None` for Haiku).
#[derive(Debug, Clone, PartialEq)]
pub struct AgentDefaults {
    /// Resolved model id of the lead (`agents.defaultModel`, default Sonnet 5.5).
    pub model: String,
    /// `agents.defaultEffort` (default medium; `max` is refused).
    pub effort: Option<Effort>,
    /// Most `Agent` calls per run (`agents.delegationCap`, 1..=40, default 12).
    pub delegation_cap: u32,
    /// Spend cap of the whole session (`agents.maxBudgetUsd`); `None` = no money cap, the turn ceilings still apply.
    pub max_budget_usd: Option<f64>,
    /// Kill switch `agents.auto.enabled` (default on): off = New run uses the role picker.
    pub auto_enabled: bool,
    /// Kill switch `agents.delegation.enabled` (default on): off = Auto runs as one agent.
    pub delegation_enabled: bool,
}

impl Default for AgentDefaults {
    fn default() -> Self {
        Self { model: "claude-sonnet-5-5".into(), effort: Some(Effort::Medium), delegation_cap: 12, max_budget_usd: None, auto_enabled: true, delegation_enabled: true }
    }
}

impl AgentDefaults {
    /// Invalid values fall back to the defaults, never an error at start.
    pub fn sanitized(mut self) -> Self {
        let d = Self::default();
        if self.model.trim().is_empty() {
            self.model = d.model;
        }
        if self.effort == Some(Effort::Max) {
            self.effort = d.effort;
        }
        self.delegation_cap = self.delegation_cap.clamp(1, 40);
        self.max_budget_usd = self.max_budget_usd.filter(|b| b.is_finite() && *b > 0.0);
        self
    }
}

/// The Auto defaults as the settings say right now.
pub type DefaultsSupplier = Arc<dyn Fn() -> AgentDefaults + Send + Sync>;

/// `agents.includeUserMemory` as it is now (read at every start).
pub type UserMemorySupplier = Arc<dyn Fn() -> bool + Send + Sync>;

/// Test and e2e switch that damages the policy channel on purpose. Only ever set from `INTELY_E2E=1` runs or tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyFault {
    /// Never answer `policy/decide`: the sidecar must deny after its 2 s timeout.
    Drop,
    /// Close the sidecar's stdin when the first `policy/decide` arrives: the sidecar must deny and stop.
    ClosePipe,
}

/// e2e and dev only: one ACP provider (`gemini`) runs against the scripted fake agent instead of its CLI. The scripts
/// double as the scripted mock roles (`mock-acp-*`), the only write roles allowed on a provider below the write tier.
#[derive(Debug, Clone)]
pub struct AcpMock {
    pub provider: String,
    /// `sidecar/tests/fakes/fake-acp-agent.mjs`.
    pub agent_js: PathBuf,
    /// `sidecar/tests/fakes/acp-scripts`; `<scenario>.jsonl` per role.
    pub scripts_dir: PathBuf,
}

/// One experimental provider the user switched on and whose command line they confirmed (Settings > Providers). The host
/// computes the sidecar `--providers` list and every `session/start` of a non-Claude provider from these entries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderLaunch {
    /// The provider id as roles and runs name it; it is also the sidecar adapter id.
    pub id: String,
    pub adapter: String,
    /// Absolute path of the confirmed program (for Codex: the `codex` binary, `env.codexBin`).
    pub command: String,
    pub args: Vec<String>,
    /// Settings > Safety: this provider may run roles that change files below the write tier.
    pub allow_weak_writer: bool,
}

/// What the host may start now, read whenever a session opens (the settings can change while the IDE runs).
pub type LaunchSupplier = Arc<dyn Fn() -> Vec<ProviderLaunch> + Send + Sync>;

/// The installed CLI version of a provider as last detected (`None` = not known); recorded enforcement for another version is stale.
pub type VersionSupplier = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

#[derive(Clone)]
pub struct HostConfig {
    /// `~/Library/Application Support/IntelySwitchIDE`: runs/, shims/, gate.json, enforcement.json.
    pub data_dir: PathBuf,
    /// The bundled sidecar (`sidecar/dist/index.js`).
    pub sidecar_js: PathBuf,
    /// Overrides the `node` found on the login `PATH`.
    pub node: Option<PathBuf>,
    /// Overrides the `claude` found on the login `PATH`.
    pub claude_bin: Option<PathBuf>,
    pub git: PathBuf,
    pub env: EnvSupplier,
    /// Adapters the sidecar may load: `claude`, plus `mock` for scripted runs.
    pub providers: Vec<String>,
    /// Replaces the model of every Claude role (tests and cheap smoke runs).
    pub model_override: Option<String>,
    /// Caps the spend of every Claude run (tests and cheap smoke runs).
    pub max_budget_usd: Option<f64>,
    /// Speed factor of the mock scenarios (1 = as recorded).
    pub mock_speed: f64,
    pub gate: GateConfig,
    pub cancel: CancelPlan,
    pub policy_fault: Option<PolicyFault>,
    /// The Roles layer (`intely-roles`); runs of a role it does not know use the built-in table.
    pub role_resolver: Option<RoleResolver>,
    /// How long `session/start` may take (the Claude CLI needs a few seconds to initialise).
    pub start_timeout: Duration,
    /// How long a finished run on a server keeps its session (and its `claude` process there) for follow-up messages before it is
    /// closed; it resumes with the next message. The same ten minutes as a run on this Mac.
    pub remote_idle: Duration,
    /// Scripted fake ACP agent for one provider (`INTELY_E2E` runs only); `None` in production.
    pub acp_mock: Option<AcpMock>,
    /// Confirmed experimental providers; `None` = none exist (tests, mock-only runs). Nothing but Claude starts without an entry.
    pub launch: Option<LaunchSupplier>,
    /// Installed CLI versions for the enforcement staleness check; `None` = trust the recorded run.
    pub cli_version: Option<VersionSupplier>,
    /// Builds the delegate set of an Auto run from the CURRENT role files (set by the Tauri layer next to the role resolver);
    /// `None` = no roles exist (tests), so the lead works alone.
    pub delegate_resolver: Option<DelegateResolver>,
    /// Model, effort, delegation cap, budget and kill switches of the Auto lead; `None` = the built-in defaults.
    pub agent_defaults: Option<DefaultsSupplier>,
    /// The switch `agents.includeUserMemory`: the user's own `~/.claude/CLAUDE.md` goes into the prompt of a Claude run. `None` = on.
    pub user_memory: Option<UserMemorySupplier>,
    /// Resolves the MCP servers a run selected into config and per-tool rules (secrets included, see `McpResolved`); `None` = no MCP in
    /// this build (tests, mock-only runs): a start that selects servers then fails with `mcpUnavailable`.
    pub mcp_supplier: Option<McpSupplier>,
    /// What the Settings say now about the servers of live runs: the input of the tighten-only live update. `None` = no live updates.
    pub mcp_rules: Option<McpRulesSupplier>,
    /// Secret values of the MCP servers of a run, to scrub a transcript the CLI wrote. `None` = pattern redaction only.
    pub mcp_scrub: Option<McpScrubSupplier>,
    /// Kill switch `INTELY_NO_UNATTENDED=1`: `agent_modes` omits `automatic` and `bypass`, `start`/`set_mode` return `modeDisabled`,
    /// a resume of an unattended run continues in Ask. No UI.
    pub no_unattended: bool,
    /// The servers a run may execute on (Settings > Servers); `None` = none exist (tests, a build without them): a start that names a
    /// server then fails with `serversUnavailable`.
    pub servers: Option<Arc<crate::remote::ServerRegistry>>,
}

impl HostConfig {
    pub fn new(data_dir: PathBuf, sidecar_js: PathBuf, env: EnvSupplier) -> Self {
        Self {
            data_dir,
            sidecar_js,
            node: None,
            claude_bin: None,
            git: intely_core::exec::pinned_git_path(),
            env,
            providers: vec!["claude".into()],
            model_override: None,
            max_budget_usd: None,
            mock_speed: 1.0,
            gate: GateConfig::default(),
            cancel: CancelPlan::default(),
            policy_fault: None,
            role_resolver: None,
            start_timeout: Duration::from_secs(60),
            remote_idle: intely_agent_gate::gate::reaper::DEFAULT_IDLE,
            acp_mock: None,
            launch: None,
            cli_version: None,
            delegate_resolver: None,
            agent_defaults: None,
            user_memory: None,
            mcp_supplier: None,
            mcp_rules: None,
            mcp_scrub: None,
            no_unattended: false,
            servers: None,
        }
    }

    /// The Auto defaults right now (sanitised).
    pub fn defaults(&self) -> AgentDefaults {
        self.agent_defaults.as_ref().map(|f| f()).unwrap_or_default().sanitized()
    }

    /// Whether the user's global CLAUDE.md goes into a Claude run now.
    pub fn include_user_memory(&self) -> bool {
        self.user_memory.as_ref().map(|f| f()).unwrap_or(true)
    }

    pub fn mock_enabled(&self) -> bool {
        self.providers.iter().any(|p| p == "mock")
    }

    /// The experimental providers that may start right now.
    pub fn launches(&self) -> Vec<ProviderLaunch> {
        self.launch.as_ref().map(|f| f()).unwrap_or_default()
    }

    /// Adapters the sidecar must offer: the fixed list (`claude`, scripted `mock`/e2e) plus every confirmed provider's adapter.
    pub fn sidecar_providers(&self) -> Vec<String> {
        let mut out = self.providers.clone();
        for l in self.launches() {
            if !out.contains(&l.adapter) {
                out.push(l.adapter);
            }
        }
        out
    }
}

/// The only variables the sidecar and the agents get: what a CLI needs to find its tools, its login and a locale.
/// An allow-list, because a deny-list misses `DATABASE_URL`, `*_KEY`, `SENTRY_DSN`, `GIT_ASKPASS` and the next
/// secret anyone names differently. Mirrors `sidecar/src/env.ts`.
const ALLOWED_ENV: &[&str] =
    &["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR", "LANG", "NVM_DIR", "GNUPGHOME", "CLAUDE_CONFIG_DIR", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"];

fn allowed(name: &str) -> bool {
    ALLOWED_ENV.contains(&name) || name.starts_with("LC_")
}

/// The environment of the sidecar process and the base of the agents' environment: nothing from the IDE process,
/// only the allow-listed login-shell variables.
pub fn scrub_env(vars: &HashMap<String, String>) -> BTreeMap<String, String> {
    vars.iter().filter(|(k, _)| allowed(k)).map(|(k, v)| (k.clone(), v.clone())).collect()
}

/// First executable called `name` on the `PATH` of `vars` (falls back to the process `PATH`).
pub fn find_on_path(name: &str, vars: &HashMap<String, String>) -> Option<PathBuf> {
    let path = vars.get("PATH").cloned().or_else(|| std::env::var("PATH").ok())?;
    std::env::split_paths(&path).map(|d| d.join(name)).find(|p| is_executable(p))
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sidecar_never_sees_ide_switches_or_credentials() {
        let vars: HashMap<String, String> = [
            ("PATH", "/usr/bin"),
            ("HOME", "/Users/x"),
            ("LANG", "en_US.UTF-8"),
            ("INTELY_E2E", "1"),
            ("INTELY_WORKSPACE", "/x"),
            ("GITHUB_TOKEN", "t"),
            ("NPM_TOKEN", "t"),
            ("ANTHROPIC_API_KEY", "k"),
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_ENTRYPOINT", "cli"),
            ("CLAUDE_CONFIG_DIR", "/Users/x/.claude"),
            ("SSH_AUTH_SOCK", "/tmp/agent"),
            ("MY_SECRET", "s"),
            ("DB_PASSWORD", "p"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let kept: Vec<String> = scrub_env(&vars).into_keys().collect();
        assert_eq!(kept, ["CLAUDE_CONFIG_DIR", "HOME", "LANG", "PATH"]);
    }

    #[test]
    fn a_dirty_environment_leaks_nothing_outside_the_allow_list() {
        let canaries = [
            "DATABASE_URL", "MONGODB_URI", "SENTRY_DSN", "GIT_ASKPASS", "PRIVATE_KEY", "STRIPE_KEY", "NPM_CONFIG__AUTH", "AWS_ACCESS_KEY_ID",
            "GITHUB_TOKEN", "SSH_AUTH_SOCK", "GIT_CONFIG_GLOBAL", "REDIS_URL", "INTELY_E2E", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY",
        ];
        let mut vars: HashMap<String, String> = canaries.iter().map(|k| (k.to_string(), "CANARY".to_string())).collect();
        vars.extend([("PATH", "/usr/bin"), ("LC_ALL", "C"), ("USER", "u")].map(|(k, v)| (k.to_string(), v.to_string())));
        let kept = scrub_env(&vars);
        assert!(kept.values().all(|v| v != "CANARY"), "{kept:?}");
        assert_eq!(kept.len(), 3);
    }
}
