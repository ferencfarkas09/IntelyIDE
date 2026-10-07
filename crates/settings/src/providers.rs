//! The provider registry ((design notes: providers-plan) 1.3, 4.1-4.3): static definitions, the per-provider switch and auth
//! mode (kept in the `providers` settings namespace), CLI detection through the login-shell PATH, the state machine and
//! the Doctor findings. Nothing here runs at startup: detection runs when Settings > Providers opens or on Test.
//!
//! Credentials: subscription logins are never read (the IDE only launches the user's own CLI); API keys live in the
//! [`SecretStore`] under [`provider_key`] and only their presence is exposed.

use std::collections::HashMap;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::error::{code, Result, SettingsError};
use crate::events::Listeners;
use crate::hash::sha256_hex;
use crate::secrets::{provider_key, redact, SecretStore};
use crate::store::{Object, SettingsStore};
use crate::types::{
    AuthModeInfo, CliDetection, DoctorFinding, DoctorLevel, LaunchInfo, LaunchStatus, ProviderHost, ProviderInfo, ProviderKind, ProviderState,
    ProviderStateChange, ProviderTest,
};

const NAMESPACE: &str = "providers";
const EXPERIMENTAL_KEY: &str = "experimental";
const DETECT_TIMEOUT: Duration = Duration::from_secs(10);

pub struct CliDef {
    pub bin: &'static str,
    pub version_args: &'static [&'static str],
    /// Nothing is hard-coded until a spike measured it (plan 0); the Doctor compares when one is set.
    pub min_version: Option<&'static str>,
}

pub struct AuthDef {
    pub id: &'static str,
    pub label: &'static str,
    pub needs_key: bool,
}

/// How the IDE starts an experimental provider. The user confirms the full command line once (`confirm_launch`).
pub struct LaunchDef {
    /// The proposal; the program is the detected CLI. Fixed unless `editable`.
    pub args: &'static [&'static str],
    /// A custom agent: the user types program and arguments.
    pub editable: bool,
    /// The flags were run against the real program. False where only a fake agent exists.
    pub verified: bool,
}

pub struct ProviderDef {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: ProviderKind,
    pub host: ProviderHost,
    pub default_enabled: bool,
    pub auth_modes: &'static [AuthDef],
    pub cli: CliDef,
    /// Everything but Claude: runs only with the `Experimental providers` switch on and a confirmed command line.
    pub experimental: bool,
    /// The sidecar adapter that serves this provider (`--providers` list entry and `session/start.provider`).
    pub adapter: &'static str,
    pub launch: LaunchDef,
}

const NO_LAUNCH: LaunchDef = LaunchDef { args: &[], editable: false, verified: true };

const fn auth(id: &'static str, label: &'static str, needs_key: bool) -> AuthDef {
    AuthDef { id, label, needs_key }
}

pub static PROVIDERS: [ProviderDef; 8] = [
    ProviderDef {
        id: "claude",
        name: "Claude",
        kind: ProviderKind::Sdk,
        host: ProviderHost::Sidecar,
        default_enabled: true,
        auth_modes: &[
            auth("subscription", "Subscription (own CLI)", false),
            auth("apiKey", "API key", true),
            auth("bedrock", "Bedrock", false),
            auth("vertex", "Vertex", false),
        ],
        cli: CliDef { bin: "claude", version_args: &["--version"], min_version: None },
        experimental: false,
        adapter: "claude",
        launch: NO_LAUNCH,
    },
    ProviderDef {
        id: "codex",
        name: "Codex",
        kind: ProviderKind::Cli,
        host: ProviderHost::Sidecar,
        default_enabled: false,
        auth_modes: &[auth("chatgpt", "ChatGPT sign-in", false), auth("apiKey", "API key", true)],
        cli: CliDef { bin: "codex", version_args: &["--version"], min_version: None },
        experimental: true,
        adapter: "codex",
        // `codex app-server` was measured on the installed CLI (providers-plan: Codex spike results)
        launch: LaunchDef { args: &["app-server"], editable: false, verified: true },
    },
    ProviderDef {
        id: "gemini",
        name: "Gemini",
        kind: ProviderKind::Acp,
        host: ProviderHost::Sidecar,
        default_enabled: false,
        auth_modes: &[auth("google", "Google login", false), auth("apiKey", "API key", true), auth("vertex", "Vertex", false)],
        cli: CliDef { bin: "gemini", version_args: &["--version"], min_version: None },
        experimental: true,
        adapter: "gemini",
        launch: LaunchDef { args: &["--acp"], editable: false, verified: false },
    },
    ProviderDef {
        id: "copilot",
        name: "GitHub Copilot",
        kind: ProviderKind::Acp,
        host: ProviderHost::Sidecar,
        default_enabled: false,
        auth_modes: &[auth("cliLogin", "CLI login", false), auth("token", "Token", true)],
        cli: CliDef { bin: "copilot", version_args: &["--version"], min_version: None },
        experimental: true,
        adapter: "copilot",
        launch: LaunchDef { args: &["--acp", "--stdio"], editable: false, verified: false },
    },
    ProviderDef {
        id: "opencode",
        name: "OpenCode",
        kind: ProviderKind::Acp,
        host: ProviderHost::Sidecar,
        default_enabled: false,
        auth_modes: &[auth("cliLogin", "CLI login", false), auth("apiKey", "API key", true)],
        cli: CliDef { bin: "opencode", version_args: &["--version"], min_version: None },
        experimental: true,
        adapter: "opencode",
        launch: LaunchDef { args: &["acp"], editable: false, verified: false },
    },
    ProviderDef {
        id: "goose",
        name: "Goose",
        kind: ProviderKind::Acp,
        host: ProviderHost::Sidecar,
        default_enabled: false,
        auth_modes: &[auth("configured", "Configured in Goose", false)],
        cli: CliDef { bin: "goose", version_args: &["--version"], min_version: None },
        experimental: true,
        adapter: "goose",
        launch: LaunchDef { args: &["acp"], editable: false, verified: false },
    },
    ProviderDef {
        id: "qwen",
        name: "Qwen Code",
        kind: ProviderKind::Acp,
        host: ProviderHost::Sidecar,
        default_enabled: false,
        auth_modes: &[auth("oauth", "Qwen login", false), auth("apiKey", "API key", true)],
        cli: CliDef { bin: "qwen", version_args: &["--version"], min_version: None },
        experimental: true,
        adapter: "qwen",
        launch: LaunchDef { args: &["--acp"], editable: false, verified: false },
    },
    // A custom agent that speaks the Agent Client Protocol: no program to look for, the user gives the command line.
    ProviderDef {
        id: "acp",
        name: "ACP agent",
        kind: ProviderKind::Acp,
        host: ProviderHost::Sidecar,
        default_enabled: false,
        auth_modes: &[auth("agent", "The agent's own login", false)],
        cli: CliDef { bin: "", version_args: &["--version"], min_version: None },
        experimental: true,
        adapter: "acp",
        launch: LaunchDef { args: &[], editable: true, verified: false },
    },
];

pub fn definition(id: &str) -> Option<&'static ProviderDef> {
    PROVIDERS.iter().find(|d| d.id == id)
}

/// Variables that can silently change which credential a CLI uses (names only; values are never read into a finding).
const STRAY_ENV: [(&str, &str, &str); 6] = [
    ("claude", "ANTHROPIC_API_KEY", "can switch a subscription session to API billing"),
    ("claude", "ANTHROPIC_BASE_URL", "redirects Claude requests to another endpoint"),
    ("codex", "OPENAI_API_KEY", "can override the ChatGPT sign-in"),
    ("gemini", "GEMINI_API_KEY", "can override the Google login"),
    ("gemini", "GOOGLE_API_KEY", "can override the Google login"),
    ("copilot", "GH_TOKEN", "can override the Copilot CLI login"),
];

// ---- CLI detection -------------------------------------------------------------------------------------------------

fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// `command -v <bin>` against an explicit PATH string; relative and empty entries are ignored.
pub fn find_in_path(bin: &str, path: &str) -> Option<PathBuf> {
    std::env::split_paths(path).filter(|d| d.is_absolute()).map(|d| d.join(bin)).find(|p| is_executable(p))
}

/// The first dotted number in a `--version` output (`claude 2.1.284 (build x)` gives `2.1.284`).
pub fn parse_version(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|token| {
        let start = token.find(|c: char| c.is_ascii_digit())?;
        let candidate: String = token[start..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        let candidate = candidate.trim_end_matches('.');
        let parts: Vec<&str> = candidate.split('.').collect();
        (parts.len() >= 2 && parts.iter().all(|p| !p.is_empty())).then(|| candidate.to_owned())
    })
}

fn version_parts(v: &str) -> Vec<u64> {
    v.split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

pub fn version_at_least(version: &str, min: &str) -> bool {
    let (mut a, mut b) = (version_parts(version), version_parts(min));
    let len = a.len().max(b.len());
    a.resize(len, 0);
    b.resize(len, 0);
    a >= b
}

fn read_capped(pipe: Option<impl Read>) -> String {
    let mut buf = Vec::new();
    if let Some(p) = pipe {
        let _ = p.take(8192).read_to_end(&mut buf);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// A CLI that is being replaced (an auto-update) can be "text file busy" for a moment; retry briefly.
fn spawn_retrying(cmd: &mut Command) -> std::io::Result<std::process::Child> {
    const ETXTBSY: i32 = 26;
    let mut attempts = 0;
    loop {
        match cmd.spawn() {
            Err(e) if e.raw_os_error() == Some(ETXTBSY) && attempts < 10 => {
                attempts += 1;
                std::thread::sleep(Duration::from_millis(25));
            }
            other => return other,
        }
    }
}

/// Runs `<bin> <args>` with a scrubbed environment (PATH, HOME only: no keys, no tokens) and a timeout.
fn run_version(bin: &Path, args: &[&str], path: &str, timeout: Duration) -> std::result::Result<String, String> {
    let mut cmd = Command::new(bin);
    cmd.args(args).env_clear().env("PATH", path).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(home) = std::env::var_os("HOME") {
        cmd.env("HOME", home);
    }
    let mut child = spawn_retrying(&mut cmd).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("--version did not answer within {} s", timeout.as_secs_f32().max(0.1)));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    let stdout = read_capped(child.stdout.take());
    let stderr = read_capped(child.stderr.take());
    if !status.success() {
        let first = stderr.lines().chain(stdout.lines()).find(|l| !l.trim().is_empty()).unwrap_or_default();
        return Err(format!("--version exited with {status}: {}", redact(first.trim()).chars().take(200).collect::<String>()));
    }
    Ok(if parse_version(&stdout).is_some() { stdout } else { stderr })
}

pub fn detect_cli(def: &CliDef, path: &str, timeout: Duration) -> CliDetection {
    let mut found = CliDetection {
        bin: def.bin.to_owned(),
        path: None,
        version: None,
        min_version: def.min_version.map(str::to_owned),
        meets_min: None,
        error: None,
    };
    let Some(bin) = find_in_path(def.bin, path) else { return found };
    found.path = Some(bin.display().to_string());
    match run_version(&bin, def.version_args, path, timeout) {
        Ok(output) => match parse_version(&output) {
            Some(v) => {
                found.meets_min = def.min_version.map(|min| version_at_least(&v, min));
                found.version = Some(v);
            }
            None => found.error = Some("no version number in the --version output".to_owned()),
        },
        Err(e) => found.error = Some(e),
    }
    found
}

// ---- state machine -------------------------------------------------------------------------------------------------

type KeyPresence = std::result::Result<bool, String>;

/// What the CLI, the key and the confirmed command line say, ignoring the switch.
fn health(def: &ProviderDef, mode: &AuthDef, detection: Option<&CliDetection>, key: Option<&KeyPresence>, launch: Option<&LaunchInfo>) -> (ProviderState, Option<String>) {
    let custom = def.cli.bin.is_empty();
    if !custom {
        let Some(cli) = detection else { return (ProviderState::Probing, Some("Not detected yet".to_owned())) };
        if cli.path.is_none() {
            return (ProviderState::NotInstalled, Some(format!("{} was not found on PATH", def.cli.bin)));
        }
        if let Some(e) = &cli.error {
            return (ProviderState::Error, Some(format!("{}: {e}", def.cli.bin)));
        }
        if cli.meets_min == Some(false) {
            let (v, min) = (cli.version.as_deref().unwrap_or("?"), cli.min_version.as_deref().unwrap_or("?"));
            return (ProviderState::Error, Some(format!("{} {v} is older than the supported minimum {min}", def.cli.bin)));
        }
    }
    if mode.needs_key {
        if def.experimental {
            // Runs hand the agent no key yet (the login of the agent's own CLI is used), so a key mode cannot run.
            return (ProviderState::NeedsLogin, Some("Key sign-in is not wired for runs yet: pick the login mode".to_owned()));
        }
        match key {
            Some(Ok(true)) => {}
            Some(Err(e)) => return (ProviderState::Error, Some(format!("Keychain: {e}"))),
            _ => return (ProviderState::NeedsKey, Some(format!("No {} stored", mode.label.to_lowercase()))),
        }
    }
    if let Some(l) = launch.filter(|l| l.status != LaunchStatus::Confirmed) {
        let why = match (l.status == LaunchStatus::Stale, custom) {
            (true, _) => "The stored command line changed or its program is gone: confirm it again",
            (false, true) => "Enter the command line of the agent and confirm it",
            (false, false) => "Confirm the command line the IDE will start",
        };
        return (ProviderState::NeedsConfirm, Some(why.to_owned()));
    }
    (ProviderState::Ready, None)
}

fn launch_hash(command: &str, args: &[String]) -> String {
    sha256_hex(format!("{command}\0{}", args.join("\0")).as_bytes())
}

/// A command line is data for `Command::new`, never for a shell, but it is shown to the user in full and must stay one line.
fn clean_line(text: &str) -> bool {
    !text.is_empty() && text.len() <= 1024 && !text.chars().any(char::is_control)
}

/// What the IDE would start for `def`, and whether the user confirmed exactly that.
fn launch_info(def: &ProviderDef, entry: Option<&Object>, detection: Option<&CliDetection>) -> Option<LaunchInfo> {
    if !def.experimental {
        return None;
    }
    let proposal: Vec<String> = def.launch.args.iter().map(|a| (*a).to_owned()).collect();
    let stored = entry.and_then(|e| e.get("confirmed")).and_then(Value::as_object);
    let confirmed = stored.and_then(|c| {
        let command = c.get("command")?.as_str()?.to_owned();
        let args: Vec<String> = c.get("args")?.as_array()?.iter().map(|a| a.as_str().map(str::to_owned)).collect::<Option<_>>()?;
        Some((command, args, c.get("hash").and_then(Value::as_str).map(str::to_owned), c.get("at").and_then(Value::as_u64).and_then(|a| u32::try_from(a).ok())))
    });
    Some(match confirmed {
        Some((command, args, hash, at)) => {
            let exists = is_executable(Path::new(&command));
            let intact = hash.as_deref() == Some(launch_hash(&command, &args).as_str()) && (def.launch.editable || args == proposal);
            LaunchInfo {
                resolved: exists,
                status: if exists && intact { LaunchStatus::Confirmed } else { LaunchStatus::Stale },
                command,
                args,
                editable: def.launch.editable,
                verified: def.launch.verified,
                confirmed_at: at,
                hash: hash.map(|h| h.chars().take(16).collect()),
            }
        }
        None => {
            let found = detection.and_then(|d| d.path.clone());
            LaunchInfo {
                resolved: found.is_some(),
                command: found.unwrap_or_else(|| def.cli.bin.to_owned()),
                args: proposal,
                editable: def.launch.editable,
                verified: def.launch.verified,
                status: LaunchStatus::Unconfirmed,
                confirmed_at: None,
                hash: None,
            }
        }
    })
}

/// A provider the host may start now: switched on, command line confirmed. The sidecar `--providers` list and the
/// launch of every session are computed from these entries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchEntry {
    pub id: String,
    pub adapter: String,
    /// Absolute path of the confirmed program.
    pub command: String,
    pub args: Vec<String>,
    pub allow_weak_writer: bool,
}

// ---- registry ------------------------------------------------------------------------------------------------------

pub struct ProviderRegistry {
    settings: Arc<SettingsStore>,
    secrets: Arc<dyn SecretStore>,
    timeout: Duration,
    detections: Mutex<HashMap<&'static str, CliDetection>>,
    keys: Mutex<HashMap<&'static str, KeyPresence>>,
    /// Serialises the read-modify-write of one provider's entry in settings.json.
    write: Mutex<()>,
    listeners: Listeners<ProviderStateChange>,
}

fn experimental_on(settings: &Object) -> bool {
    settings.get(EXPERIMENTAL_KEY).and_then(Value::as_bool).unwrap_or(false)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl ProviderRegistry {
    pub fn new(settings: Arc<SettingsStore>, secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            settings,
            secrets,
            timeout: DETECT_TIMEOUT,
            detections: Mutex::default(),
            keys: Mutex::default(),
            write: Mutex::new(()),
            listeners: Listeners::default(),
        }
    }

    /// How long `--version` may take before the CLI is reported as unresponsive (default 10 s).
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Fires `providers:state` for every provider whose state changed (not on the first listing).
    pub fn subscribe(&self, cb: impl Fn(&ProviderStateChange) + Send + Sync + 'static) {
        self.listeners.add(cb);
    }

    /// From the cache only: no process is started and no Keychain call is made.
    pub fn list(&self) -> Result<Vec<ProviderInfo>> {
        let config = self.settings.get(NAMESPACE)?;
        Ok(PROVIDERS.iter().map(|d| self.info(d, &config)).collect())
    }

    /// Looks for the known CLIs on `path` (the login-shell PATH) and refreshes key presence for providers that need one.
    pub fn detect(&self, path: &str) -> Result<Vec<ProviderInfo>> {
        self.emitting(|| {
            let found: Vec<(&'static str, CliDetection)> = std::thread::scope(|s| {
                let timeout = self.timeout;
                let tasks: Vec<_> = PROVIDERS.iter().filter(|d| !d.cli.bin.is_empty()).map(|d| (d.id, s.spawn(move || detect_cli(&d.cli, path, timeout)))).collect();
                tasks.into_iter().filter_map(|(id, t)| t.join().ok().map(|det| (id, det))).collect()
            });
            lock(&self.detections).extend(found);
            let config = self.settings.get(NAMESPACE)?;
            PROVIDERS.iter().for_each(|d| self.refresh_key(d, &config));
            Ok(PROVIDERS.iter().map(|d| self.info(d, &config)).collect())
        })
    }

    /// A cheap probe (`--version` plus key presence); never a billed completion.
    pub fn test(&self, id: &str, path: &str) -> Result<ProviderTest> {
        let def = unknown(id)?;
        let started = Instant::now();
        self.emitting(|| {
            if !def.cli.bin.is_empty() {
                lock(&self.detections).insert(def.id, detect_cli(&def.cli, path, self.timeout));
            }
            let config = self.settings.get(NAMESPACE)?;
            self.refresh_key(def, &config);
            let (_, mode) = self.config(def, &config);
            let detection = lock(&self.detections).get(def.id).cloned();
            let launch = launch_info(def, config.get(def.id).and_then(Value::as_object), detection.as_ref());
            let (state, message) = health(def, mode, detection.as_ref(), lock(&self.keys).get(def.id), launch.as_ref());
            let ok = state == ProviderState::Ready;
            let message = if ok { self.info(def, &config).cli.map(|c| format!("{} {} at {}", c.bin, c.version.unwrap_or_default(), c.path.unwrap_or_default())).or(Some("Command line confirmed".to_owned())) } else { message };
            Ok(ProviderTest { ok, message, latency_ms: Some(u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX)) })
        })
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<ProviderInfo> {
        self.update_entry(id, "enabled", json!(enabled))
    }

    pub fn set_auth_mode(&self, id: &str, mode: &str) -> Result<ProviderInfo> {
        let def = unknown(id)?;
        if !def.auth_modes.iter().any(|m| m.id == mode) {
            return Err(SettingsError::new(code::INVALID_AUTH_MODE, format!("{} has no auth mode `{mode}`", def.name)));
        }
        self.update_entry(id, "authMode", json!(mode))
    }

    /// Call after `secrets.set`/`remove` so the provider state follows the Keychain without another Keychain query.
    pub fn key_changed(&self, key: &str, present: bool) {
        let Some(def) = PROVIDERS.iter().find(|d| provider_key(d.id) == key) else { return };
        let _ = self.emitting(|| {
            lock(&self.keys).insert(def.id, Ok(present));
            Ok(())
        });
    }

    /// Findings from the cached detection (run [`detect`](Self::detect) first) and the environment. `env_has` answers
    /// whether a variable is set; values are never read.
    pub fn doctor(&self, env_has: &dyn Fn(&str) -> bool) -> Result<Vec<DoctorFinding>> {
        let infos = self.list()?;
        let mut out = Vec::new();
        let mut push = |provider: Option<&str>, level: DoctorLevel, code: &str, message: String| {
            out.push(DoctorFinding { provider: provider.map(str::to_owned), level, code: code.to_owned(), message });
        };
        for info in infos.iter().filter(|i| i.enabled && i.state != ProviderState::Off) {
            let id = Some(info.id.as_str());
            match (&info.state, &info.cli) {
                (ProviderState::NeedsConfirm, _) => push(id, DoctorLevel::Warn, "launchUnconfirmed", info.message.clone().unwrap_or_default()),
                (ProviderState::Probing, _) => push(id, DoctorLevel::Info, "notDetected", format!("{} has not been detected yet", info.name)),
                (ProviderState::NotInstalled, _) => push(id, DoctorLevel::Error, "cliMissing", info.message.clone().unwrap_or_default()),
                (ProviderState::Error, _) => push(id, DoctorLevel::Error, "cliProbeFailed", info.message.clone().unwrap_or_default()),
                (state, Some(cli)) => {
                    let line = format!("{} {} at {}", cli.bin, cli.version.as_deref().unwrap_or("?"), cli.path.as_deref().unwrap_or("?"));
                    push(id, DoctorLevel::Ok, "cliFound", line);
                    if *state == ProviderState::NeedsKey {
                        push(id, DoctorLevel::Warn, "keyMissing", info.message.clone().unwrap_or_default());
                    }
                }
                _ => {}
            }
            for (_, var, why) in STRAY_ENV.iter().filter(|(p, var, _)| *p == info.id && env_has(var)) {
                let overrides_mode = !(info.id == "claude" && info.auth_mode == "apiKey") || *var == "ANTHROPIC_BASE_URL";
                if overrides_mode {
                    push(id, DoctorLevel::Warn, "strayEnv", format!("{var} is set in the IDE environment and {why} (value not shown)"));
                }
            }
        }
        Ok(out)
    }

    // ---- experimental providers (Settings > Providers) ----

    /// The global `Experimental providers` switch (default off, remembered in settings.json).
    pub fn experimental(&self) -> Result<bool> {
        Ok(experimental_on(&self.settings.get(NAMESPACE)?))
    }

    pub fn set_experimental(&self, on: bool) -> Result<bool> {
        self.emitting(|| {
            let _guard = lock(&self.write);
            Ok(experimental_on(&self.settings.set(NAMESPACE, Object::from_iter([(EXPERIMENTAL_KEY.to_owned(), json!(on))]))?))
        })
    }

    /// The user confirmed this exact command line. Stored with its SHA-256, so a line changed behind the IDE's back (or a
    /// program that vanished) turns the provider back to `needsConfirm`. `command` must be an absolute path to an
    /// executable file; the arguments of a provider with a fixed proposal must be exactly the proposal.
    pub fn confirm_launch(&self, id: &str, command: &str, args: Vec<String>) -> Result<ProviderInfo> {
        let def = unknown(id)?;
        let bad = |msg: String| SettingsError::new(code::INVALID_LAUNCH, msg);
        if !def.experimental {
            return Err(bad(format!("{} has no command line to confirm", def.name)));
        }
        if !clean_line(command) || !Path::new(command).is_absolute() {
            return Err(bad("the program must be an absolute path on one line".to_owned()));
        }
        if !is_executable(Path::new(command)) {
            return Err(bad(format!("{command} is not an executable file")));
        }
        let proposal: Vec<&str> = def.launch.args.to_vec();
        if def.launch.editable {
            if args.len() > 64 || !args.iter().all(|a| clean_line(a)) {
                return Err(bad("every argument must be a non-empty single line (at most 64 of them)".to_owned()));
            }
        } else if args.iter().map(String::as_str).ne(proposal.iter().copied()) {
            return Err(bad(format!("{} starts with `{}`: the arguments are fixed", def.name, proposal.join(" "))));
        }
        let hash = launch_hash(command, &args);
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        self.modify_entry(id, |entry| {
            entry.insert("confirmed".to_owned(), json!({ "command": command, "args": args, "hash": hash, "at": at }));
        })
    }

    pub fn revoke_launch(&self, id: &str) -> Result<ProviderInfo> {
        self.modify_entry(id, |entry| {
            entry.remove("confirmed");
        })
    }

    /// Settings > Safety: lets one provider run roles that change files below the write tier. Turning it on needs the
    /// provider id typed exactly (the same ceremony as a live-branch push); turning it off needs nothing.
    pub fn set_allow_weak_writer(&self, id: &str, allow: bool, typed: &str) -> Result<ProviderInfo> {
        let def = unknown(id)?;
        if allow && (!def.experimental || typed.trim() != def.id) {
            return Err(SettingsError::new(code::CONFIRMATION_REQUIRED, format!("type `{}` to allow it to change files", def.id)));
        }
        self.modify_entry(id, |entry| {
            entry.insert("allowWeakWriter".to_owned(), json!(allow));
        })
    }

    /// What the host may start right now: global switch on, the provider's own switch on, a login mode, and a confirmed,
    /// still intact command line. Claude is not listed (it is always available).
    pub fn launch_table(&self) -> Result<Vec<LaunchEntry>> {
        let config = self.settings.get(NAMESPACE)?;
        if !experimental_on(&config) {
            return Ok(Vec::new());
        }
        Ok(PROVIDERS
            .iter()
            .filter(|d| d.experimental)
            .filter_map(|d| {
                let (enabled, mode) = self.config(d, &config);
                if !enabled || mode.needs_key {
                    return None;
                }
                let entry = config.get(d.id).and_then(Value::as_object);
                let launch = launch_info(d, entry, None).filter(|l| l.status == LaunchStatus::Confirmed)?;
                Some(LaunchEntry { id: d.id.to_owned(), adapter: d.adapter.to_owned(), command: launch.command, args: launch.args, allow_weak_writer: entry.and_then(|e| e.get("allowWeakWriter")).and_then(Value::as_bool).unwrap_or(false) })
            })
            .collect())
    }

    /// Where `bin` of a provider was found by the last detection (the Codex binary comes from here when no override is set).
    pub fn detected_path(&self, id: &str) -> Option<PathBuf> {
        lock(&self.detections).get(id).and_then(|d| d.path.as_ref()).map(PathBuf::from)
    }

    /// The version the last detection read (stale-evidence check of the enforcement chip).
    pub fn detected_version(&self, id: &str) -> Option<String> {
        lock(&self.detections).get(id).and_then(|d| d.version.clone())
    }

    // ---- internals ----

    fn modify_entry(&self, id: &str, f: impl FnOnce(&mut Object)) -> Result<ProviderInfo> {
        let def = unknown(id)?;
        self.emitting(|| {
            let _guard = lock(&self.write);
            let mut entry = self.settings.get(NAMESPACE)?.get(def.id).and_then(Value::as_object).cloned().unwrap_or_default();
            f(&mut entry);
            let config = self.settings.set(NAMESPACE, Object::from_iter([(def.id.to_owned(), Value::Object(entry))]))?;
            Ok(self.info(def, &config))
        })
    }

    fn config(&self, def: &'static ProviderDef, settings: &Object) -> (bool, &'static AuthDef) {
        let entry = settings.get(def.id).and_then(Value::as_object);
        let enabled = entry.and_then(|e| e.get("enabled")).and_then(Value::as_bool).unwrap_or(def.default_enabled);
        let mode = entry
            .and_then(|e| e.get("authMode"))
            .and_then(Value::as_str)
            .and_then(|m| def.auth_modes.iter().find(|a| a.id == m))
            .unwrap_or(&def.auth_modes[0]);
        (enabled, mode)
    }

    fn info(&self, def: &'static ProviderDef, settings: &Object) -> ProviderInfo {
        let (enabled, mode) = self.config(def, settings);
        let detection = lock(&self.detections).get(def.id).cloned();
        let key = lock(&self.keys).get(def.id).cloned();
        let has_key = matches!(key, Some(Ok(true)));
        let entry = settings.get(def.id).and_then(Value::as_object);
        let launch = launch_info(def, entry, detection.as_ref());
        // The switch is the user's intent; an experimental provider also needs the global switch to actually run.
        let runs = enabled && (!def.experimental || experimental_on(settings));
        let (state, message) = if runs { health(def, mode, detection.as_ref(), key.as_ref(), launch.as_ref()) } else { (ProviderState::Off, None) };
        let configured = if def.cli.bin.is_empty() {
            launch.as_ref().is_some_and(|l| l.status == LaunchStatus::Confirmed)
        } else if mode.needs_key {
            has_key
        } else {
            detection.as_ref().is_some_and(|d| d.path.is_some())
        };
        ProviderInfo {
            id: def.id.to_owned(),
            name: def.name.to_owned(),
            kind: def.kind.clone(),
            host: def.host.clone(),
            enabled,
            state,
            configured,
            auth_modes: def.auth_modes.iter().map(|a| AuthModeInfo { id: a.id.to_owned(), label: a.label.to_owned(), needs_key: a.needs_key }).collect(),
            auth_mode: mode.id.to_owned(),
            experimental: def.experimental,
            has_key,
            cli: detection,
            launch,
            allow_weak_writer: entry.and_then(|e| e.get("allowWeakWriter")).and_then(Value::as_bool).unwrap_or(false),
            message,
        }
    }

    /// Asks the secret store only for an enabled provider whose current auth mode needs a key.
    fn refresh_key(&self, def: &'static ProviderDef, settings: &Object) {
        let (enabled, mode) = self.config(def, settings);
        if enabled && mode.needs_key {
            let presence = self.secrets.has(&provider_key(def.id)).map_err(|e| redact(&e.message));
            lock(&self.keys).insert(def.id, presence);
        }
    }

    fn update_entry(&self, id: &str, field: &str, value: Value) -> Result<ProviderInfo> {
        let def = unknown(id)?;
        self.emitting(|| {
            let _guard = lock(&self.write);
            let mut entry = self.settings.get(NAMESPACE)?.get(def.id).and_then(Value::as_object).cloned().unwrap_or_default();
            entry.insert(field.to_owned(), value);
            let config = self.settings.set(NAMESPACE, Object::from_iter([(def.id.to_owned(), Value::Object(entry))]))?;
            self.refresh_key(def, &config);
            Ok(self.info(def, &config))
        })
    }

    fn states(&self) -> Option<HashMap<&'static str, ProviderState>> {
        self.list().ok().map(|l| PROVIDERS.iter().zip(l).map(|(d, i)| (d.id, i.state)).collect())
    }

    fn emitting<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        let before = self.states();
        let out = f()?;
        if let (Some(before), Some(after)) = (before, self.states()) {
            PROVIDERS
                .iter()
                .filter(|d| before.get(d.id) != after.get(d.id))
                .for_each(|d| self.listeners.emit(&ProviderStateChange { id: d.id.to_owned(), state: after[d.id].clone() }));
        }
        Ok(out)
    }
}

fn unknown(id: &str) -> Result<&'static ProviderDef> {
    definition(id).ok_or_else(|| SettingsError::new(code::UNKNOWN_PROVIDER, format!("unknown provider `{id}`")))
}
