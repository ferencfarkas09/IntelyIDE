//! MongoDB Studio (Beta-M1 core): thin Tauri glue over `intely_mongo::studio::Studio`, compiled only with
//! `--features mongo-studio`. The master switch is off by default and a build without the feature contains none of this
//! (no driver, no TLS stack). Nothing here returns a connection string; `mongo_profile_save` takes one and hands it to
//! the secret store. The only thing a command can run is a `ReadCommand`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use intely_core::jail::{Jail, Mode};
use intely_core::{BusyItem, BusyKind, EngineError, SwitchWarning};
use intely_mongo::ai::transport::ClaudeOneShotPort;
use intely_mongo::api::{
    AiAsk, AiCapabilities, AiExplanation, AiPayload, AiResult, CancelView, ConnectionView, DialogHandle, DialogKind, ForgetReport, HostKeyView, ImportPreview, ImportReport, LocalHit, ProfileDraft, ProfileInput,
    ProfileMeta, ProfileView, ResetReport, RunRequest, SecretKind, SecretsStatus, SessionSecrets, StudioStatus, TestReport, UriParse, WindowView, WireSecret,
};
use intely_mongo::host::redact;
use intely_mongo::jail::NetworkPolicy;
use intely_mongo::profile::{ProfileStore, KEYCHAIN_SERVICE};
use intely_mongo::studio::{Sink, Studio, TestProgress, TierNames};
use intely_mongo::error::StudioError;
use intely_settings::{MemorySecretStore, SecretStore, SettingsStore};
use tauri::{AppHandle, Emitter, Manager, State};

use super::settings::SettingsState;
use super::switchhook::{self, BoxFuture, SwitchHook};

type Res<T> = Result<T, EngineError>;

/// The studio, or why it could not start (an unreadable settings.json); every command then reports that reason.
pub struct MongoState {
    studio: Result<Arc<Studio>, EngineError>,
    /// Cancel flag of the AI call in flight (one per studio tab); set by `mongo_ai_cancel`, polled by the model port.
    ai_calls: std::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>,
    /// For the persisted `mongo.happyPreset` switch (copied into the studio before an import).
    settings: Option<Arc<SettingsStore>>,
    /// The native file dialogs; Rust opens them, the webview never supplies a path.
    dialogs: Arc<dyn Dialogs>,
}

impl MongoState {
    fn studio(&self) -> Res<&Arc<Studio>> {
        self.studio.as_ref().map_err(Clone::clone)
    }
}

fn to_engine(e: StudioError) -> EngineError {
    EngineError::new(e.code, redact(&e.message))
}

struct Events(AppHandle);

impl Sink for Events {
    fn state(&self, status: &StudioStatus) {
        let _ = self.0.emit("mongo:state", status);
    }

    fn test_progress(&self, progress: &TestProgress) {
        let _ = self.0.emit("mongo:test", progress);
    }
}

/// The Keychain item per connection lives under its own service (`...intelyswitchide.mongo`). Tests, the E2E harness
/// and the read-only smoke never touch the Keychain (a dev build can pop a permission dialog).
fn secret_store() -> Arc<dyn SecretStore> {
    #[cfg(target_os = "macos")]
    if !["INTELY_E2E", "INTELY_E2E_SCRIPT", "INTELY_READONLY", "INTELY_SECRETS"].iter().any(|v| std::env::var_os(v).is_some_and(|x| !x.is_empty())) {
        return Arc::new(intely_settings::FallbackSecretStore::new(Arc::new(intely_settings::ScopedKeychainStore::new(KEYCHAIN_SERVICE))));
    }
    Arc::new(MemorySecretStore::new())
}

fn network_policy() -> NetworkPolicy {
    match Jail::global().mode() {
        Mode::ReadOnly => NetworkPolicy::Refused,
        Mode::E2e => NetworkPolicy::LoopbackOnly,
        Mode::Off => NetworkPolicy::Full,
    }
}

/// Called once from `setup` after the settings module: opens nothing (no client, no task, no Keychain read).
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let parts = app.state::<SettingsState>().parts();
    let settings = parts.as_ref().map(|(s, _)| Arc::clone(s));
    let studio = match parts {
        Some((settings, _)) => {
            let studio = Arc::new(Studio::new(Arc::new(ProfileStore::new(settings, secret_store())), network_policy()));
            studio.set_sink(Arc::new(Events(app.handle().clone())));
            studio.migrate_happy_preset();
            studio.watch_tunnel_ends();
            Ok(studio)
        }
        None => Err(EngineError::new("mongoSettings", "settings.json could not be read")),
    };
    app.manage(MongoState { studio, ai_calls: Default::default(), settings, dialogs: Arc::new(NativeDialogs) });
    Ok(())
}

#[tauri::command]
pub async fn mongo_status(state: State<'_, MongoState>) -> Res<StudioStatus> {
    Ok(state.studio()?.status())
}

#[tauri::command]
pub async fn mongo_set_enabled(state: State<'_, MongoState>, enabled: bool) -> Res<StudioStatus> {
    state.studio()?.set_enabled(enabled).map_err(to_engine)
}

/// Parse a mongosh-style literal into canonical Extended JSON (pure, no server).
#[tauri::command]
pub fn mongo_parse_literal(text: String) -> Result<String, EngineError> {
    intely_mongo::shell::parse(&text).map(|v| v.to_string()).map_err(|e| EngineError::new("mongoParse", e.to_string()))
}

#[tauri::command]
pub async fn mongo_profiles(state: State<'_, MongoState>) -> Res<Vec<ProfileView>> {
    state.studio()?.profile_list().map_err(to_engine)
}

#[tauri::command]
pub async fn mongo_profile_save(state: State<'_, MongoState>, input: ProfileInput) -> Res<ProfileView> {
    state.studio()?.profile_save(input).map_err(to_engine)
}

#[tauri::command]
pub async fn mongo_profile_delete(state: State<'_, MongoState>, id: String) -> Res<()> {
    state.studio()?.profile_delete(&id).map_err(to_engine)
}

#[tauri::command]
pub async fn mongo_profile_duplicate(state: State<'_, MongoState>, id: String) -> Res<ProfileView> {
    state.studio()?.profile_duplicate(&id).map_err(to_engine)
}

#[tauri::command]
pub async fn mongo_dismiss_notices(state: State<'_, MongoState>) -> Res<()> {
    state.studio()?.dismiss_notices();
    Ok(())
}

#[tauri::command]
pub async fn mongo_connect(state: State<'_, MongoState>, id: String, secrets: Option<SessionSecrets>) -> Res<ConnectionView> {
    let studio = Arc::clone(state.studio()?);
    studio.connect_with(&id, secrets.unwrap_or_default()).await.map_err(to_engine)
}

#[tauri::command]
pub async fn mongo_disconnect(state: State<'_, MongoState>, id: String) -> Res<()> {
    state.studio()?.disconnect(&id);
    Ok(())
}

#[tauri::command]
pub async fn mongo_test(state: State<'_, MongoState>, input: ProfileInput, test_id: Option<String>) -> Res<TestReport> {
    let studio = Arc::clone(state.studio()?);
    match test_id {
        Some(id) => studio.test_with(input, &id).await,
        None => studio.test(input).await,
    }
    .map_err(to_engine)
}

#[tauri::command]
pub async fn mongo_run(state: State<'_, MongoState>, req: RunRequest) -> Res<WindowView> {
    let studio = Arc::clone(state.studio()?);
    studio.run(req).await.map_err(to_engine)
}

#[tauri::command]
pub async fn mongo_window(state: State<'_, MongoState>, tab: String, offset: u32, count: u32) -> Res<WindowView> {
    let studio = Arc::clone(state.studio()?);
    studio.window(&tab, offset, count).await.map_err(to_engine)
}

#[tauri::command]
pub async fn mongo_cursor_close(state: State<'_, MongoState>, tab: String) -> Res<()> {
    state.studio()?.cursor_close(&tab);
    Ok(())
}

#[tauri::command]
pub async fn mongo_cancel(state: State<'_, MongoState>, tab: String) -> Res<CancelView> {
    let studio = Arc::clone(state.studio()?);
    studio.cancel(&tab).await.map_err(to_engine)
}

// ---- AI find (privacy P1: schema only; a draft is never run by the backend) --------------------------------------------

/// Haiku answers finds; every tier uses it unless `INTELY_MONGO_AI_MODEL` names another model.
const FIND_MODEL: &str = "claude-haiku-4-5-20251001";

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// `name` on the process `PATH`, else the newest nvm install (a Finder-launched app has a short `PATH`).
fn find_binary(name: &str) -> Option<PathBuf> {
    let on_path = std::env::var_os("PATH").into_iter().flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).map(|d| d.join(name)).find(|p| p.is_file());
    on_path.or_else(|| {
        let nvm = std::env::var_os("HOME").map(|h| Path::new(&h).join(".nvm/versions/node"))?;
        let mut versions: Vec<PathBuf> = std::fs::read_dir(nvm).ok()?.filter_map(|e| e.ok()).map(|e| e.path().join("bin").join(name)).filter(|p| p.is_file()).collect();
        versions.sort();
        versions.pop()
    })
}

/// The model transport: the toolless Claude one-shot (`scripts/mongo-fixture/claude-complete.mjs`, the M0-proven path). A
/// native provider `complete()` replaces it later; the port boundary does not change. In the E2E jail the call count is
/// capped (default 20 per fixture) so a test cannot run away with model calls.
fn ai_port(studio: &Studio, cancel: Arc<AtomicBool>) -> Result<(ClaudeOneShotPort, TierNames), EngineError> {
    let no_provider = |m: &str| EngineError::new("mongoNoProvider", m);
    let node = env_path("INTELY_NODE").or_else(|| find_binary("node")).ok_or_else(|| no_provider("Node.js was not found (set INTELY_NODE)"))?;
    let script = env_path("INTELY_MONGO_AI_SCRIPT").unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../scripts/mongo-fixture/claude-complete.mjs")));
    if !script.is_file() {
        return Err(no_provider("the AI transport script is missing"));
    }
    let model = std::env::var("INTELY_MONGO_AI_MODEL").ok().filter(|m| !m.is_empty()).unwrap_or_else(|| FIND_MODEL.to_string());
    let cap = std::env::var("INTELY_MONGO_AI_CALL_CAP").ok().and_then(|v| v.parse().ok()).unwrap_or(if Jail::global().mode() == Mode::E2e { 20 } else { 1_000_000 });
    let claude_bin = env_path("INTELY_CLAUDE_BIN").or_else(|| find_binary("claude"));
    let names: TierNames = [model.clone(), model.clone(), model.clone()];
    let port = ClaudeOneShotPort {
        node,
        script,
        models: names.clone(),
        call_cap: cap,
        counter_file: studio.profiles().settings_dir().join("mongo-ai-calls.count"),
        timeout: Duration::from_secs(150),
        claude_bin,
        cancel: Some(cancel),
    };
    Ok((port, names))
}

/// "What is sent?": the exact post-filter bytes, built without a model call.
#[tauri::command]
pub async fn mongo_ai_payload(state: State<'_, MongoState>, req: AiAsk) -> Res<AiPayload> {
    let studio = Arc::clone(state.studio()?);
    studio.ai_payload(&req).await.map_err(to_engine)
}

/// A validated, explained draft (or a clarification question). Never runs the query.
#[tauri::command]
pub async fn mongo_ai_generate(state: State<'_, MongoState>, req: AiAsk) -> Res<AiResult> {
    let studio = Arc::clone(state.studio()?);
    let flag = Arc::new(AtomicBool::new(false));
    state.ai_calls.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(req.tab.clone(), Arc::clone(&flag));
    let result = match ai_port(&studio, flag) {
        Ok((port, names)) => studio.ai_generate(&port, &names, &req).await.map_err(to_engine),
        Err(e) => Err(e),
    };
    state.ai_calls.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&req.tab);
    result
}

/// Stops the tab's model call: the one-shot child process is killed and the call ends with `mongoCancelled`.
#[tauri::command]
pub async fn mongo_ai_cancel(state: State<'_, MongoState>, tab: String) -> Res<bool> {
    let flag = state.ai_calls.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&tab).cloned();
    if let Some(f) = &flag {
        f.store(true, Ordering::Relaxed);
    }
    Ok(flag.is_some())
}

/// Plain-language explanation of the query in the editors; built locally, no model call.
#[tauri::command]
pub async fn mongo_ai_explain(state: State<'_, MongoState>, req: AiAsk) -> Res<AiExplanation> {
    let studio = Arc::clone(state.studio()?);
    studio.ai_explain(&req).await.map_err(to_engine)
}

// ---- connection manager ((design notes: mongo-everyone-spec) 5.6) ---------------------------------------------------------------
// Exempt from the switch (they answer while Studio is off; none opens a socket or starts a process): mongo_status,
// mongo_set_enabled, mongo_parse_literal, mongo_profiles, mongo_profile_save, mongo_profile_delete, mongo_profile_meta,
// mongo_secrets_status, mongo_reset_all. Every other command is gated by the studio itself (`mongoDisabled`).

#[tauri::command]
pub async fn mongo_uri_parse(state: State<'_, MongoState>, uri: String) -> Res<UriParse> {
    state.studio()?.uri_parse(&uri).map_err(to_engine)
}

#[tauri::command]
pub async fn mongo_uri_render(state: State<'_, MongoState>, spec: intely_mongo::connspec::ConnSpec, draft: Option<String>) -> Res<String> {
    state.studio()?.uri_render(&spec, draft.as_deref()).map_err(to_engine)
}

#[tauri::command]
pub async fn mongo_draft_discard(state: State<'_, MongoState>, draft: String) -> Res<()> {
    state.studio()?.draft_discard(&draft).map_err(to_engine)
}

#[tauri::command]
pub async fn mongo_profile_convert(state: State<'_, MongoState>, id: String) -> Res<ProfileDraft> {
    state.studio()?.profile_convert(&id).map_err(to_engine)
}

#[tauri::command]
pub async fn mongo_profile_meta(state: State<'_, MongoState>, id: String, meta: ProfileMeta) -> Res<ProfileView> {
    state.studio()?.profile_meta(&id, meta).map_err(to_engine)
}

#[tauri::command]
pub async fn mongo_profile_secret(state: State<'_, MongoState>, id: String, kind: SecretKind, value: Option<WireSecret>) -> Res<ProfileView> {
    state.studio()?.profile_secret(&id, kind, value).map_err(to_engine)
}

#[tauri::command]
pub async fn mongo_secrets_status(state: State<'_, MongoState>, id: Option<String>) -> Res<SecretsStatus> {
    state.studio()?.secrets_status(id.as_deref()).map_err(to_engine)
}

#[tauri::command]
pub async fn mongo_test_cancel(state: State<'_, MongoState>, test_id: String) -> Res<bool> {
    let studio = Arc::clone(state.studio()?);
    studio.test_cancel(&test_id).await.map_err(to_engine)
}

#[cfg(unix)]
#[tauri::command]
pub async fn mongo_ssh_hostkey(state: State<'_, MongoState>, ssh: intely_mongo::connspec::SshSpec) -> Res<HostKeyView> {
    let studio = Arc::clone(state.studio()?);
    studio.ssh_hostkey(ssh).await.map_err(to_engine)
}

#[cfg(unix)]
#[tauri::command]
pub async fn mongo_ssh_trust(state: State<'_, MongoState>, host: String, port: u16, fingerprint: String) -> Res<()> {
    let studio = Arc::clone(state.studio()?);
    studio.ssh_trust(&host, port, &fingerprint).await.map_err(to_engine)
}

#[cfg(unix)]
#[tauri::command]
pub async fn mongo_ssh_forget(state: State<'_, MongoState>, host: String, port: u16, typed_host: String) -> Res<ForgetReport> {
    let studio = Arc::clone(state.studio()?);
    studio.ssh_forget(&host, port, &typed_host).await.map_err(to_engine)
}

/// SSH tunnels are unix-only (no ControlMaster on Windows); the commands still exist so the UI gets a clear answer.
#[cfg(not(unix))]
fn no_tunnels<T>() -> Res<T> {
    Err(EngineError::new("mongoTunnel", "tunnel.noSsh: SSH tunnels are not available on this system"))
}

#[cfg(not(unix))]
#[tauri::command]
pub async fn mongo_ssh_hostkey(_state: State<'_, MongoState>, _ssh: intely_mongo::connspec::SshSpec) -> Res<HostKeyView> {
    no_tunnels()
}

#[cfg(not(unix))]
#[tauri::command]
pub async fn mongo_ssh_trust(_state: State<'_, MongoState>, _host: String, _port: u16, _fingerprint: String) -> Res<()> {
    no_tunnels()
}

#[cfg(not(unix))]
#[tauri::command]
pub async fn mongo_ssh_forget(_state: State<'_, MongoState>, _host: String, _port: u16, _typed_host: String) -> Res<ForgetReport> {
    no_tunnels()
}

// ---- native dialogs: Rust opens them, the webview gets a one-time handle and never a path ---------------------------------

/// The native file dialogs. A trait so a test can stand in for the operating system.
pub trait Dialogs: Send + Sync {
    /// `None` when the user cancelled.
    fn pick_open(&self) -> Res<Option<PathBuf>>;
    fn pick_save(&self, suggested: &str) -> Res<Option<PathBuf>>;
}

/// A file name that is safe to hand to a dialog script: `[A-Za-z0-9._-]`, at most 64 characters, no leading dot.
fn dialog_file_name(suggested: Option<&str>) -> String {
    let clean: String = suggested.unwrap_or("").chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')).take(64).collect();
    let clean = clean.trim_start_matches('.').to_string();
    if clean.is_empty() { "intely-mongo-profiles.json".to_string() } else { clean }
}

struct NativeDialogs;

impl NativeDialogs {
    /// The E2E harness has no one to click: it names the path in the environment (loopback fixtures only, and the
    /// studio's write jail still checks it).
    fn scripted() -> Option<Option<PathBuf>> {
        if Jail::global().mode() != Mode::E2e {
            return None;
        }
        Some(std::env::var_os("INTELY_MONGO_DIALOG_PATH").filter(|v| !v.is_empty()).map(PathBuf::from))
    }

    #[cfg(target_os = "macos")]
    fn osascript(script: &str) -> Res<Option<PathBuf>> {
        let out = std::process::Command::new("/usr/bin/osascript")
            .args(["-e", script])
            .env_clear()
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|_| EngineError::new("mongoDialog", "the file dialog could not be opened"))?;
        if !out.status.success() {
            return Ok(None); // cancelled (osascript exits 1 with "User canceled")
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let path = text.trim_end_matches(['\n', '\r']);
        Ok((!path.is_empty()).then(|| PathBuf::from(path)))
    }
}

impl Dialogs for NativeDialogs {
    fn pick_open(&self) -> Res<Option<PathBuf>> {
        if let Some(p) = Self::scripted() {
            return Ok(p);
        }
        #[cfg(target_os = "macos")]
        return Self::osascript("POSIX path of (choose file with prompt \"Import connections\")");
        #[cfg(not(target_os = "macos"))]
        Err(EngineError::new("mongoDialog", "native file dialogs are not available on this system"))
    }

    fn pick_save(&self, suggested: &str) -> Res<Option<PathBuf>> {
        if let Some(p) = Self::scripted() {
            return Ok(p);
        }
        #[cfg(target_os = "macos")]
        return Self::osascript(&format!("POSIX path of (choose file name with prompt \"Export connections\" default name \"{}\")", dialog_file_name(Some(suggested))));
        #[cfg(not(target_os = "macos"))]
        {
            let _ = suggested;
            Err(EngineError::new("mongoDialog", "native file dialogs are not available on this system"))
        }
    }
}

/// Opens the dialog (off the async threads), then lets the studio issue the one-time handle. `None`: cancelled.
async fn dialog_handle(studio: &Arc<Studio>, dialogs: Arc<dyn Dialogs>, kind: DialogKind, suggested: Option<String>) -> Res<Option<DialogHandle>> {
    // the switch and the read-only jail answer before any dialog appears
    if !studio.is_enabled() {
        return Err(EngineError::new("mongoDisabled", "MongoDB Studio is off (Settings > Database)"));
    }
    if network_policy() == NetworkPolicy::Refused && kind == DialogKind::Export {
        return Err(EngineError::new("readOnly", "the read-only jail refuses writes"));
    }
    let picked = tauri::async_runtime::spawn_blocking(move || match kind {
        DialogKind::Import => dialogs.pick_open(),
        DialogKind::Export => dialogs.pick_save(&dialog_file_name(suggested.as_deref())),
    })
    .await
    .map_err(|_| EngineError::new("mongoDialog", "the file dialog stopped"))??;
    match picked {
        Some(path) => studio.dialog_issue(kind, path).map(Some).map_err(to_engine),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn mongo_dialog_open(state: State<'_, MongoState>) -> Res<Option<DialogHandle>> {
    let studio = Arc::clone(state.studio()?);
    dialog_handle(&studio, Arc::clone(&state.dialogs), DialogKind::Import, None).await
}

#[tauri::command]
pub async fn mongo_dialog_save(state: State<'_, MongoState>, suggested_name: Option<String>) -> Res<Option<DialogHandle>> {
    let studio = Arc::clone(state.studio()?);
    dialog_handle(&studio, Arc::clone(&state.dialogs), DialogKind::Export, suggested_name).await
}

#[tauri::command]
pub async fn mongo_profiles_export(state: State<'_, MongoState>, ids: Vec<String>, include_tunnel: bool, include_paths: bool, handle: String) -> Res<u32> {
    let opts = intely_mongo::exchange::ExportOptions { include_tunnel, include_paths };
    state.studio()?.profiles_export(&ids, opts, &handle).map_err(to_engine)
}

#[tauri::command]
pub async fn mongo_profiles_import_preview(state: State<'_, MongoState>, handle: String) -> Res<ImportPreview> {
    let studio = state.studio()?;
    if let Some(on) = state.settings.as_ref().and_then(|s| s.get("mongo").ok()).and_then(|o| o.get("happyPreset").and_then(serde_json::Value::as_bool)) {
        studio.set_happy_preset(on);
    }
    studio.profiles_import_preview(&handle).map_err(to_engine)
}

#[tauri::command]
pub async fn mongo_profiles_import(state: State<'_, MongoState>, handle: String, selected: Vec<u32>) -> Res<ImportReport> {
    state.studio()?.profiles_import(&handle, &selected).map_err(to_engine)
}

#[tauri::command]
pub async fn mongo_detect_local(state: State<'_, MongoState>) -> Res<Vec<LocalHit>> {
    let studio = Arc::clone(state.studio()?);
    studio.detect_local().await.map_err(to_engine)
}

#[tauri::command]
pub async fn mongo_ai_capabilities(state: State<'_, MongoState>) -> Res<AiCapabilities> {
    let studio = state.studio()?;
    let script = env_path("INTELY_MONGO_AI_SCRIPT").unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../scripts/mongo-fixture/claude-complete.mjs")));
    let claude = env_path("INTELY_CLAUDE_BIN").or_else(|| find_binary("claude"));
    let mut caps = studio.ai_capabilities(Some(&script), claude.as_deref()).map_err(to_engine)?;
    // the transport also finds node under nvm, which the studio's own PATH check does not know about
    caps.node = caps.node || env_path("INTELY_NODE").is_some_and(|p| p.is_file()) || find_binary("node").is_some();
    Ok(caps)
}

#[tauri::command]
pub async fn mongo_reset_all(state: State<'_, MongoState>, typed_phrase: String, audit_too: Option<bool>) -> Res<ResetReport> {
    let studio = Arc::clone(state.studio()?);
    studio.reset_all(&typed_phrase, audit_too.unwrap_or(false)).await.map_err(to_engine)
}

// ---- the workspace switch ((design notes: workspaces-spec) 4.10 row 10, D20) -------------------------------------------------

/// What the switch needs from the studio; the real one is [`Studio`], a fake stands in for it in the tests.
pub trait MongoControl: Send + Sync + 'static {
    /// Ids of the live connections.
    fn connections(&self) -> Vec<String>;
    /// Closes one connection with its SSH tunnel and writes its audit entry (what the Disconnect button does).
    fn disconnect(&self, id: &str);
    /// Tunnels that are still up after the connections went (a failed pipeline can leave one).
    fn tunnels_up(&self) -> usize;
    fn close_tunnels(&self, timeout: Duration);
}

impl MongoControl for Studio {
    fn connections(&self) -> Vec<String> {
        self.status().connections.into_iter().map(|c| c.id).collect()
    }

    fn disconnect(&self, id: &str) {
        Studio::disconnect(self, id);
    }

    fn tunnels_up(&self) -> usize {
        self.tunnels().count()
    }

    fn close_tunnels(&self, timeout: Duration) {
        self.close_all_blocking(timeout);
    }
}

/// The `SwitchHook` of MongoDB Studio: connections and SSH tunnels are live and belong to no workspace in the UI's mind,
/// so a switch closes them (decision D20) with the audit entry a manual disconnect writes. Profiles are global and stay.
pub struct MongoHook<C: MongoControl> {
    control: Arc<C>,
}

impl<C: MongoControl> MongoHook<C> {
    pub fn new(control: Arc<C>) -> Self {
        Self { control }
    }
}

/// `Some(hook)` when the studio started (an unreadable settings.json leaves none).
pub fn hook(app: &AppHandle) -> Option<Arc<dyn SwitchHook>> {
    let state = app.try_state::<MongoState>()?;
    let studio = state.studio().ok()?.clone();
    Some(Arc::new(MongoHook::new(studio)))
}

const STOP_TUNNELS: Duration = Duration::from_millis(600);

impl<C: MongoControl> SwitchHook for MongoHook<C> {
    fn name(&self) -> &'static str {
        "mongo"
    }

    fn busy(&self) -> Vec<BusyItem> {
        let labels = self.control.connections();
        if labels.is_empty() {
            return Vec::new();
        }
        vec![BusyItem { kind: BusyKind::Mongo, count: labels.len() as u32, labels }]
    }

    fn stop(&self) -> BoxFuture<'_, Vec<SwitchWarning>> {
        let control = self.control.clone();
        Box::pin(async move {
            let left = switchhook::blocking(move || {
                for id in control.connections() {
                    control.disconnect(&id);
                }
                if control.tunnels_up() > 0 {
                    control.close_tunnels(STOP_TUNNELS);
                }
                control.connections().len() + control.tunnels_up()
            })
            .await;
            if left == Some(0) {
                Vec::new()
            } else {
                vec![switchhook::stuck("mongo")]
            }
        })
    }
}

/// `RunEvent::Exit`: cancels runs, closes every connection and tunnel without needing a runtime, then removes the
/// control sockets. Opens nothing when Studio never ran.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<MongoState>() {
        if let Ok(studio) = state.studio() {
            studio.close_all_blocking(Duration::from_secs(3));
        }
    }
}

/// Whether an SSH tunnel is up: the close guard warns before quitting.
pub fn tunnel_up(app: &AppHandle) -> bool {
    app.try_state::<MongoState>().and_then(|s| s.studio().ok().map(|st| st.tunnels().count() > 0)).unwrap_or(false)
}

/// Every command of (design notes: mongo-everyone-spec) 5.6 plus the existing ones; the test below keeps this list, the module
/// and the registration block in `lib.rs` in step.
#[cfg(test)]
pub const COMMANDS: &[&str] = &[
    "mongo_status", "mongo_set_enabled", "mongo_parse_literal", "mongo_profiles", "mongo_profile_save", "mongo_profile_delete",
    "mongo_profile_duplicate", "mongo_dismiss_notices", "mongo_connect", "mongo_disconnect", "mongo_test", "mongo_run", "mongo_window",
    "mongo_cursor_close", "mongo_cancel", "mongo_ai_payload", "mongo_ai_generate", "mongo_ai_explain", "mongo_ai_cancel", "mongo_uri_parse",
    "mongo_uri_render", "mongo_draft_discard", "mongo_profile_convert", "mongo_profile_meta", "mongo_profile_secret", "mongo_secrets_status",
    "mongo_test_cancel", "mongo_ssh_hostkey", "mongo_ssh_trust", "mongo_ssh_forget", "mongo_dialog_open", "mongo_dialog_save",
    "mongo_profiles_export", "mongo_profiles_import_preview", "mongo_profiles_import", "mongo_detect_local", "mongo_ai_capabilities",
    "mongo_reset_all",
];

#[cfg(test)]
mod tests {
    use super::*;
    use intely_mongo::api::Environment;

    const CANARY: &str = "CANARY-pw-7f3a";

    fn studio() -> (PathBuf, Arc<Studio>) {
        let dir = std::env::temp_dir().join(format!("intely-mongo-glue-{}-{}", std::process::id(), CANARY.len() + COMMANDS.len() + rand_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = Arc::new(SettingsStore::open(dir.join("settings.json")).unwrap());
        let profiles = Arc::new(ProfileStore::new(settings, Arc::new(MemorySecretStore::new())));
        (dir, Arc::new(Studio::new(profiles, NetworkPolicy::LoopbackOnly)))
    }

    fn rand_suffix() -> usize {
        use std::sync::atomic::AtomicUsize;
        static N: AtomicUsize = AtomicUsize::new(0);
        N.fetch_add(1, Ordering::SeqCst)
    }

    struct FakeDialogs {
        open: Option<PathBuf>,
        save: Option<PathBuf>,
        asked: std::sync::Mutex<Vec<String>>,
    }

    impl Dialogs for FakeDialogs {
        fn pick_open(&self) -> Res<Option<PathBuf>> {
            self.asked.lock().unwrap().push("open".into());
            Ok(self.open.clone())
        }
        fn pick_save(&self, suggested: &str) -> Res<Option<PathBuf>> {
            self.asked.lock().unwrap().push(format!("save:{suggested}"));
            Ok(self.save.clone())
        }
    }

    #[test]
    fn every_command_is_defined_and_registered_exactly_once() {
        let module = include_str!("mongo.rs");
        let lib = include_str!("../lib.rs");
        for name in COMMANDS {
            assert!(module.contains(&format!("fn {name}(")), "{name} is not defined in mongo.rs");
            assert_eq!(lib.matches(&format!("modules::mongo::{name},")).count(), 1, "{name} must be registered once in lib.rs");
        }
        let registered = lib.matches("modules::mongo::mongo_").count();
        assert_eq!(registered, COMMANDS.len(), "lib.rs registers a mongo command that COMMANDS does not list");
    }

    #[test]
    fn an_error_message_is_scrubbed_before_it_leaves() {
        let e = to_engine(StudioError::new("mongoServer", format!("failed mongodb://bob:{CANARY}@db.example.com:27017/x")));
        assert!(!e.message.contains(CANARY), "{}", e.message);
    }

    /// Exempt commands answer while Studio is off; all others say `mongoDisabled` (the exact list of 5.6).
    #[test]
    fn the_switch_gates_exactly_the_commands_the_spec_names() {
        let (dir, s) = studio();
        assert!(!s.is_enabled());
        let disabled = |r: Result<(), StudioError>| r.err().is_some_and(|e| e.code == "mongoDisabled");
        tauri::async_runtime::block_on(async {
            // gated
            assert!(disabled(s.uri_parse("mongodb://127.0.0.1/x").map(|_| ())), "mongo_uri_parse");
            let spec = intely_mongo::connspec::ConnSpec::default();
            assert!(disabled(s.uri_render(&spec, None).map(|_| ())), "mongo_uri_render");
            assert!(disabled(s.draft_discard("x")), "mongo_draft_discard");
            assert!(disabled(s.profile_convert("x").map(|_| ())), "mongo_profile_convert");
            assert!(disabled(s.profile_secret("x", SecretKind::Password, None).map(|_| ())), "mongo_profile_secret");
            assert!(disabled(s.connect_with("x", SessionSecrets::default()).await.map(|_| ())), "mongo_connect");
            assert!(disabled(s.test_with(ProfileInput::default(), "t1").await.map(|_| ())), "mongo_test");
            assert!(disabled(s.test_cancel("t1").await.map(|_| ())), "mongo_test_cancel");
            assert!(disabled(s.detect_local().await.map(|_| ())), "mongo_detect_local");
            assert!(disabled(s.ai_capabilities(None, None).map(|_| ())), "mongo_ai_capabilities");
            assert!(disabled(s.profiles_export(&[], intely_mongo::exchange::ExportOptions { include_tunnel: false, include_paths: false }, "h").map(|_| ())), "mongo_profiles_export");
            assert!(disabled(s.profiles_import_preview("h").map(|_| ())), "mongo_profiles_import_preview");
            assert!(disabled(s.profiles_import("h", &[]).map(|_| ())), "mongo_profiles_import");
            assert!(disabled(s.dialog_issue(DialogKind::Import, dir.join("a.json")).map(|_| ())), "mongo_dialog_*");
            #[cfg(unix)]
            {
                assert!(disabled(s.ssh_trust("h", 22, "SHA256:x").await), "mongo_ssh_trust");
                assert!(disabled(s.ssh_forget("h", 22, "h").await.map(|_| ())), "mongo_ssh_forget");
            }
            // exempt
            assert!(!s.status().enabled);
            assert!(s.profile_list().is_ok(), "mongo_profiles");
            assert!(s.secrets_status(None).is_ok(), "mongo_secrets_status");
            assert!(s.profile_meta("nope", ProfileMeta::default()).err().is_none_or(|e| e.code != "mongoDisabled"), "mongo_profile_meta");
            assert!(s.reset_all("wrong phrase", false).await.err().is_some_and(|e| e.code != "mongoDisabled"), "mongo_reset_all");
            assert!(s.profile_delete("nope").err().is_none_or(|e| e.code != "mongoDisabled"), "mongo_profile_delete");
            assert!(s.set_enabled(true).is_ok(), "mongo_set_enabled");
            // nothing was created for the gated calls while it was off
            assert!(!s.extras_created() || s.is_enabled());
        });
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_native_dialog_hands_the_webview_a_token_and_never_a_path() {
        let (dir, s) = studio();
        let target = dir.join("export-target.json");
        let dialogs = Arc::new(FakeDialogs { open: Some(dir.join("in.json")), save: Some(target.clone()), asked: Default::default() });
        tauri::async_runtime::block_on(async {
            // switch off: no dialog appears at all
            let off = dialog_handle(&s, dialogs.clone(), DialogKind::Export, None).await.unwrap_err();
            assert_eq!(off.code, "mongoDisabled");
            assert!(dialogs.asked.lock().unwrap().is_empty());

            s.set_enabled(true).unwrap();
            let mut spec = intely_mongo::connspec::ConnSpec::default();
            spec.hosts = vec![intely_mongo::connspec::HostPort { host: "127.0.0.1".into(), port: Some(27017) }];
            let p = s.profile_save(ProfileInput { name: "Local".into(), environment: Environment::Local, spec: Some(spec), ..Default::default() }).unwrap();
            // a hostile suggested name cannot smuggle a path or script text into the dialog
            let handle = dialog_handle(&s, dialogs.clone(), DialogKind::Export, Some("../../etc/\"; do shell script \"x".into())).await.unwrap().expect("handle");
            let wire = serde_json::to_string(&handle).unwrap();
            assert!(!wire.contains(dir.to_str().unwrap()), "the handle must not carry the path: {wire}");
            assert_eq!(dialogs.asked.lock().unwrap().as_slice(), ["save:etcdoshellscriptx"]);

            // the path the webview never saw is what the export writes to
            let n = s.profiles_export(&[p.id.clone()], intely_mongo::exchange::ExportOptions { include_tunnel: true, include_paths: false }, &handle.token).unwrap();
            assert_eq!(n, 1);
            let written = std::fs::read_to_string(&target).unwrap();
            assert!(written.contains("Local") && !written.contains(CANARY));
            // one time only
            assert!(s.profiles_export(&[p.id], intely_mongo::exchange::ExportOptions { include_tunnel: true, include_paths: false }, &handle.token).is_err());

            // cancelling the dialog is not an error and issues nothing
            let cancelled = Arc::new(FakeDialogs { open: None, save: None, asked: Default::default() });
            assert!(dialog_handle(&s, cancelled, DialogKind::Import, None).await.unwrap().is_none());
        });
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_dialog_file_name_is_reduced_to_a_safe_charset() {
        assert_eq!(dialog_file_name(None), "intely-mongo-profiles.json");
        assert_eq!(dialog_file_name(Some("..hidden.json")), "hidden.json");
        assert_eq!(dialog_file_name(Some("a b/c\"d")), "abcd");
        assert_eq!(dialog_file_name(Some(&"x".repeat(200))).len(), 64);
    }

    /// Remote gateway (docs/remote-gateway.md): no mongo command or event is reachable from a phone, and the remote
    /// redactor masks the secret shapes the connection manager adds.
    #[test]
    fn the_remote_gateway_exposes_no_mongo_command_or_event() {
        let sources = [
            include_str!("../../../crates/remote/src/gateway.rs"),
            include_str!("../../../crates/remote/src/policy.rs"),
            include_str!("../../../crates/remote/src/api.rs"),
            include_str!("../../../crates/remote/src/wire.rs"),
            include_str!("../../../crates/remote/src/slot.rs"),
            include_str!("../../../crates/remote/src/relay_ws.rs"),
            include_str!("../../../docs/remote-gateway.md"),
            include_str!("remote.rs"),
        ];
        for src in sources {
            assert!(!src.contains("mongo_") && !src.contains("\"mongo:"), "a remote source mentions a mongo command or event");
        }
    }

    #[test]
    fn remote_redaction_masks_the_new_secret_shapes() {
        use intely_remote::redact::scrub_text;
        for text in [
            format!("mongodb+srv://bob:{CANARY}@cluster0.example.mongodb.net/db?retryWrites=true"),
            format!("mongodb://bob:{CANARY}@10.0.0.5:27017,10.0.0.6:27017/?replicaSet=rs0&tls=true"),
            format!("ssh://deploy:{CANARY}@bastion.example.com"),
            format!("mongodb://127.0.0.1/?tlsCertificateKeyFilePassword={CANARY}"),
            format!("export MONGO_PASSWORD={CANARY}"),
            format!("\"keyPassword\": \"{CANARY}\""),
            format!("-----BEGIN ENCRYPTED PRIVATE KEY-----\n{CANARY}\n-----END ENCRYPTED PRIVATE KEY-----"),
        ] {
            let out = scrub_text(&text);
            assert!(!out.contains(CANARY), "not masked: {text} -> {out}");
        }
    }
}

#[cfg(test)]
mod hook_tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct Fake {
        conns: Mutex<Vec<String>>,
        closed: Mutex<Vec<String>>,
        tunnels: Mutex<usize>,
        stubborn: bool,
    }

    impl MongoControl for Fake {
        fn connections(&self) -> Vec<String> {
            self.conns.lock().unwrap().clone()
        }
        fn disconnect(&self, id: &str) {
            self.closed.lock().unwrap().push(id.to_owned());
            if !self.stubborn {
                self.conns.lock().unwrap().retain(|c| c != id);
            }
        }
        fn tunnels_up(&self) -> usize {
            *self.tunnels.lock().unwrap()
        }
        fn close_tunnels(&self, _: Duration) {
            *self.tunnels.lock().unwrap() = 0;
        }
    }

    fn fake(conns: &[&str], tunnels: usize, stubborn: bool) -> Arc<Fake> {
        Arc::new(Fake { conns: Mutex::new(conns.iter().map(|s| (*s).to_owned()).collect()), closed: Mutex::default(), tunnels: Mutex::new(tunnels), stubborn })
    }

    #[test]
    fn a_connection_is_closed_once_with_its_tunnel_and_stop_twice_is_harmless() {
        let control = fake(&["prod", "local"], 1, false);
        let hook = MongoHook::new(control.clone());
        assert_eq!(hook.name(), "mongo");
        let busy = hook.busy();
        assert_eq!((busy[0].kind.clone(), busy[0].count, busy[0].labels.clone()), (BusyKind::Mongo, 2, vec!["prod".to_owned(), "local".to_owned()]));

        assert!(tauri::async_runtime::block_on(hook.stop()).is_empty());
        assert_eq!(*control.closed.lock().unwrap(), vec!["prod", "local"], "each connection exactly once, through the audited disconnect");
        assert_eq!(control.tunnels_up(), 0);
        assert!(hook.busy().is_empty());
        assert!(tauri::async_runtime::block_on(hook.stop()).is_empty(), "stop twice");
        assert_eq!(control.closed.lock().unwrap().len(), 2, "nothing was closed the second time");
    }

    #[test]
    fn a_connection_that_does_not_close_is_reported_as_stuck() {
        let hook = MongoHook::new(fake(&["prod"], 0, true));
        assert_eq!(tauri::async_runtime::block_on(hook.stop()), vec![switchhook::stuck("mongo")]);
    }
}
