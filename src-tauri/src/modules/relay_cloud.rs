//! Tauri glue for the relay deploy wizard ((design notes: remote-cloudflare-spec) 4.9, 4.11): the commands behind Settings > Remote > Relay.
//! Everything outward-facing goes through `intely_relay_deploy` (the pinned wrangler, spawned only from a command of this file) and
//! `intely_relay_bundle` (plain HTTPS GETs to the user's own relay). No command is callable by an agent (webview IPC only).
//!
//! Zero cost when off: `setup` creates an inert [`CloudState`] (no thread, no disk, no Keychain access). `relay_cloud_status` reads
//! settings and a few `package.json` files and spawns nothing. A wrangler process exists only while the user's click is running.
//!
//! Launch mode (spec 4.9, D18): `INTELY_READONLY` refuses every command except status, logs and stop; `INTELY_CLOUD=1` lifts that
//! for these relay commands only (the repos stay jailed); the E2E jail always wins over the flag. [`relay_jail_for`] is the one
//! place that turns (jail, flag) into what the relay client may do, including a non-loopback relay (see docs/safety.md).
//!
//! Deploy, rollback and remove are gated twice on the Rust side: a plan (`relay_cloud_plan`: the exact argv, directory, Worker name and
//! a one-time nonce with a short expiry) must exist and be presented with the typed name, and every one of them writes a `started`
//! and a result record to `cloud-audit.jsonl` (`intely_relay_deploy::cloud_audit`), refusing to start when it cannot.
//!
//! Events: `relay-cloud:state` ([`CloudRun`]) and `relay-cloud:log` (`LogChunk`, the shape of `checks:log`). Errors are
//! `EngineError`s whose `code` the UI maps to `remote.cloud.err.<code>`; wrangler output only ever leaves masked.

use std::sync::mpsc::{self, TryRecvError};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use intely_core::jail::{Jail, Mode, READ_ONLY};
use intely_core::EngineError;
use intely_relay_bundle::{check_relay_with, fingerprint, BundleVerdict, Expected, RelayCheck, ReqwestHttp};
use intely_relay_deploy::cloud_audit::{event, AuditRecord, CloudAudit};
use intely_relay_deploy::gate::effective_jail;
use intely_relay_deploy::keys;
use intely_relay_deploy::output::{valid_account_id, Account, AuthType, WhoAmI};
use intely_relay_deploy::pipeline::{DeployPreview, DeployRecord, DeployRequest, PreviewRequest};
use intely_relay_deploy::{
    AuthCtx, AuthMode, DeployError, Deployer, Deps, JobEvent, KitReport, LimitsNotice, LiveGesture, LogChunk, Plan, PlanOp, PlanRequest, ProcessSpawner, RelayKit,
    Secret, Step, StepStatus, SystemClock,
};
use intely_remote::api::RemoteSettingsView;
use intely_remote::relay_ws::{parse_relay, RelayJail, RelayTrust, RelayWs};
use intely_remote::RemoteError;
use intely_settings::secrets::SecretsHealth;
use intely_settings::{SecretStore, SettingsStore};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use super::remote::{apply_relay, ApplyRelayPatch, BundleRecord, RemoteState};
use super::settings::SettingsState;

type Res<T> = Result<T, EngineError>;
type Obj = serde_json::Map<String, Value>;

const NS: &str = "remote";
const DEFAULT_LOCAL_RELAY: &str = "ws://127.0.0.1:8787";
/// How long a command waits for the operation to take the runner before it answers without a run id.
const BEGIN_WAIT: Duration = Duration::from_secs(3);
const LOG_FLUSH_LINES: usize = 20;
const LOG_FLUSH_EVERY: Duration = Duration::from_millis(100);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn unavailable(why: &str) -> EngineError {
    EngineError::new("unavailable", why.to_string())
}

fn join_err(e: impl std::fmt::Display) -> EngineError {
    EngineError::new("internal", format!("the background task failed: {e}"))
}

fn settings_err(e: intely_settings::SettingsError) -> EngineError {
    EngineError::new("unavailable", format!("settings: {}", e.message))
}

fn keychain_err(e: intely_settings::SettingsError) -> EngineError {
    EngineError::new("keychain", format!("the secret store failed ({})", e.code))
}

/// `code: message` errors of the relay client keep their code (the UI maps the code to text).
fn remote_err(e: RemoteError) -> EngineError {
    const CODES: [&str; 12] = ["urlSyntax", "scheme", "userinfo", "ipLiteral", "idn", "insecure", "readOnly", "testJail", "hostNotAllowed", "qrBudget", "busy", "needsRepair"];
    let text = e.to_string();
    match text.split_once(": ") {
        Some((code, rest)) if CODES.contains(&code) => EngineError::new(code, rest.to_string()),
        _ => EngineError::new("remote", text),
    }
}

// ---------------------------------------------------------------- launch mode (spec 4.9)

/// `INTELY_CLOUD=1` (also `pnpm dev:app --cloud`): the relay tools work in read-only mode.
pub fn cloud_flag() -> bool {
    cloud_flag_from(std::env::var("INTELY_CLOUD").ok().as_deref())
}

/// The flag LIFTS a restriction, so it fails closed, unlike the jail variables (which restrict and treat any non-empty value as on):
/// only an explicit yes enables it. `off`, `no`, `none` or a typo leave read-only mode as it is.
pub fn cloud_flag_from(value: Option<&str>) -> bool {
    value.is_some_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// Reads settings or files, spawns nothing, opens no socket: allowed in every mode.
    Free,
    /// Spawns a process, opens a socket, touches keys or writes the relay settings: refused in read-only mode unless `INTELY_CLOUD=1`.
    Relay,
}

/// Every command of spec 4.11 (plus `relay_cloud_retry`) and what the launch mode says about it.
pub const COMMANDS: [(&str, Gate); 24] = [
    ("relay_cloud_status", Gate::Free),
    ("relay_cloud_logs", Gate::Free),
    ("relay_cloud_stop", Gate::Free),
    ("relay_cloud_prepare", Gate::Relay),
    ("relay_cloud_login", Gate::Relay),
    ("relay_cloud_logout", Gate::Relay),
    ("relay_cloud_token_set", Gate::Relay),
    ("relay_cloud_token_clear", Gate::Relay),
    ("relay_cloud_whoami", Gate::Relay),
    ("relay_cloud_choose_account", Gate::Relay),
    ("relay_cloud_preview", Gate::Relay),
    ("relay_cloud_plan", Gate::Relay),
    ("relay_cloud_deploy", Gate::Relay),
    ("relay_cloud_retry", Gate::Relay),
    ("relay_cloud_verify", Gate::Relay),
    ("relay_cloud_apply", Gate::Relay),
    ("relay_cloud_custom_set", Gate::Relay),
    ("relay_cloud_custom_apply", Gate::Relay),
    ("relay_cloud_rollback", Gate::Relay),
    ("relay_cloud_forget", Gate::Relay),
    ("relay_cloud_vapid_generate", Gate::Relay),
    ("relay_cloud_vapid_push", Gate::Relay),
    ("relay_cloud_rotate", Gate::Relay),
    ("relay_cloud_remove", Gate::Relay),
];

/// The per-command jail table of spec 4.9. The wrangler/pnpm/node spawns are gated once more inside `Deployer` and the network
/// once more inside the bundle crate and `RelayWs`, so a bug here cannot open a door the lower layers keep shut.
pub fn allow(jail: &Jail, cloud: bool, command: &str) -> Res<()> {
    let gate = COMMANDS.iter().find(|(n, _)| *n == command).map(|(_, g)| *g).ok_or_else(|| unavailable("unknown relay command"))?;
    if gate == Gate::Free {
        return Ok(());
    }
    match effective_jail(jail, cloud).mode() {
        Mode::ReadOnly => Err(EngineError::new(READ_ONLY, format!("read-only mode (INTELY_READONLY): {command} is refused; start with INTELY_CLOUD=1 to enable the relay tools only"))),
        _ => Ok(()),
    }
}

fn guard(command: &str) -> Res<()> {
    allow(&Jail::global(), cloud_flag(), command)
}

fn relay_jail(jail: &Jail) -> RelayJail {
    match jail.mode() {
        Mode::Off => RelayJail::Off,
        Mode::ReadOnly => RelayJail::ReadOnly,
        Mode::E2e => RelayJail::E2e,
    }
}

/// Where the relay kit is meant to be: the explicit `INTELY_RELAY_KIT`, else the checkout this binary was built from when it still
/// holds the kit. A personal build is installed under /Applications, outside the checkout, so the walk up from the executable
/// (dev builds) cannot find it; the sidecar has the same stop-gap (`agents.rs` `sidecar_js`). Packaged releases drop both (PK3).
fn relay_kit_hint(jail: &Jail) -> Option<String> {
    if let Some(v) = std::env::var("INTELY_RELAY_KIT").ok().filter(|v| !v.is_empty()) {
        return Some(v);
    }
    if jail.mode() == Mode::E2e {
        return None; // the test jail only accepts a kit inside the fixture root, set explicitly
    }
    let checkout = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    (checkout.join("remote-relay/package.json").is_file() && checkout.join("remote-web/package.json").is_file()).then(|| checkout.to_string_lossy().into_owned())
}

/// The PATH the relay tools (node, pnpm, and wrangler's `#!/usr/bin/env node`) are looked up in and run with. A Finder-launched app has
/// launchd's bare PATH, so an nvm or pnpm install is invisible to it (the wizard then showed "node and pnpm" as needing attention and
/// Prepare failed): the login shell's PATH the engine cached (`env.json`) and the usual install directories are added. The test jail
/// keeps the process PATH, its tools are fixtures.
fn tool_path_for(jail: &Jail) -> String {
    let process = std::env::var("PATH").unwrap_or_default();
    if jail.mode() == Mode::E2e {
        return process;
    }
    let login = intely_core::env::default_cache_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["vars"]["PATH"].as_str().map(str::to_owned));
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    intely_relay_deploy::tool_path(&process, login.as_deref(), home.as_deref())
}

/// What the relay client (`RelayWs`, the relay check, `ensure_room`) may do for a launch mode and the `INTELY_CLOUD` flag; the ONE
/// definition, also used by `remote.rs`. Only the relay side is lifted: `READONLY` + `INTELY_CLOUD=1` behaves like Off here, so a
/// host the user acknowledged (`wss://`, no IP literal, no private DNS answer; `RelayWs::new_with`) can be reached and cloud commands
/// run. The jail the repositories see is `Jail::global()` itself and is never replaced by this: no commit, push or file write opens up.
/// The E2E jail always wins (loopback only). What this does NOT do: nothing here limits what an already paired phone may ask the Mac
/// for; that stays under the agent and remote policies, which run under the unchanged jail.
pub fn relay_jail_for(jail: &Jail, cloud: bool) -> RelayJail {
    relay_jail(&effective_jail(jail, cloud))
}

// ---------------------------------------------------------------- views

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunStarted {
    /// Empty when the operation ended before it could be observed (the `relay-cloud:state` event carries the result).
    pub run_id: String,
}

/// `relay-cloud:state`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudRun {
    pub run_id: String,
    pub op: String,
    /// `running` | `ok` | `failed` | `cancelled`.
    pub status: &'static str,
    pub step: Option<Step>,
    pub step_status: Option<StepStatus>,
    pub code: Option<String>,
    /// A masked tail for a failure.
    pub detail: Option<String>,
    /// The sign-in URL (plain text, host `dash.cloudflare.com`).
    pub login_url: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ProfileView {
    worker_name: String,
    account_name: Option<String>,
    account_id_tail: Option<String>,
    auth_mode: String,
    url: String,
    deployed_at: Option<u64>,
    version_id: Option<String>,
    custom_domain: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AuthView {
    auth_mode: String,
    token_stored: bool,
    last: Option<Value>,
    checked_at: Option<u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct KeysView {
    signing_key: bool,
    signing_fingerprint: Option<String>,
    vapid: bool,
    vapid_public: Option<String>,
    push_deployed: bool,
    /// A rotated key is staged and waits for the verified redeploy that carries it (`remote.cloud.rotation`).
    signing_rotation_pending: bool,
    vapid_rotation_pending: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct BundleView {
    hash_short: String,
    hash_full: String,
    pub_fingerprint: String,
    seq: u64,
    built_at: u64,
    deployed: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct BusyView {
    run_id: String,
    op: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SecretStoreView {
    backend: String,
    durable: bool,
}

/// `KitReport` plus the dirty-file count the UI contract carries (the git status is only taken by the preview, so 0 here).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct KitOut {
    #[serde(flatten)]
    kit: KitReport,
    dirty_files: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CloudView {
    /// The jail as the relay tools see it (`INTELY_CLOUD=1` already applied): `off` | `readOnly` | `e2e`.
    jail: &'static str,
    cloud_flag: bool,
    kit: KitOut,
    secret_store_durable: bool,
    workers_subdomain: Option<String>,
    update_available: bool,
    interrupted: bool,
    mode: String,
    profile: Option<ProfileView>,
    auth: AuthView,
    keys: KeysView,
    bundle: Option<BundleView>,
    last_check: Option<Value>,
    limits: LimitsNotice,
    busy: Option<BusyView>,
    remove_enabled: bool,
    secret_store: SecretStoreView,
    custom: Option<Value>,
}

/// A serializable `RelayCheck` (the bundle crate's type is plain data without serde).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckOut {
    reachable: bool,
    latency_ms: Option<u32>,
    relay_version: Option<String>,
    protocol: Option<String>,
    do_ok: Option<bool>,
    push_configured: Option<bool>,
    served_hash: Option<String>,
    verdict: &'static str,
    sw_matches: Option<bool>,
    checked_at: u64,
    problems: Vec<String>,
}

pub fn check_out(c: &RelayCheck) -> CheckOut {
    CheckOut {
        reachable: c.reachable,
        latency_ms: c.latency_ms,
        relay_version: c.relay_version.clone(),
        protocol: c.protocol.clone(),
        do_ok: c.do_ok,
        push_configured: c.push_configured,
        served_hash: c.served_hash.clone(),
        verdict: intely_relay_deploy::pipeline::verdict_name(&c.verdict),
        sw_matches: c.sw_matches,
        checked_at: c.checked_at,
        problems: c.problems.clone(),
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VapidView {
    public: String,
    fingerprint: String,
}

fn s_of(o: &Obj, k: &str) -> Option<String> {
    o.get(k).and_then(|v| v.as_str()).filter(|v| !v.is_empty()).map(str::to_owned)
}

fn u_of(o: &Obj, k: &str) -> Option<u64> {
    o.get(k).and_then(|v| v.as_u64())
}

fn obj_of(o: &Obj, k: &str) -> Obj {
    o.get(k).and_then(|v| v.as_object()).cloned().unwrap_or_default()
}

fn group4(s: &str) -> String {
    s.as_bytes().chunks(4).filter_map(|c| std::str::from_utf8(c).ok()).collect::<Vec<_>>().join(" ")
}

fn tail4(id: &str) -> String {
    let n = id.chars().count();
    id.chars().skip(n.saturating_sub(4)).collect()
}

fn auth_mode_of(cloud: &Obj) -> AuthMode {
    if s_of(cloud, "authMode").as_deref() == Some("token") {
        AuthMode::Token
    } else {
        AuthMode::Oauth
    }
}

fn mode_name(m: AuthMode) -> &'static str {
    match m {
        AuthMode::Oauth => "oauth",
        AuthMode::Token => "token",
    }
}

pub struct ViewInputs<'a> {
    pub remote: &'a Obj,
    pub jail: &'a Jail,
    pub cloud_flag: bool,
    pub kit: KitReport,
    pub token_stored: bool,
    pub secrets: Option<SecretsHealth>,
    pub busy: Option<(String, String)>,
}

/// Pure over its inputs (no I/O), so the tests build any state they like.
pub fn build_view(i: &ViewInputs) -> CloudView {
    let cloud = obj_of(i.remote, "cloud");
    let effective = effective_jail(i.jail, i.cloud_flag);
    let mode = match s_of(i.remote, "relayMode").as_deref() {
        Some(m @ ("cloudflare" | "custom")) => m.to_owned(),
        _ => "local".to_owned(),
    };
    let profile = match (s_of(&cloud, "workerName"), s_of(&cloud, "url")) {
        (Some(worker_name), Some(url)) => Some(ProfileView {
            worker_name,
            account_name: s_of(&cloud, "accountName"),
            account_id_tail: s_of(&cloud, "accountId").map(|id| tail4(&id)),
            auth_mode: mode_name(auth_mode_of(&cloud)).to_owned(),
            url,
            deployed_at: u_of(&cloud, "deployedAt"),
            version_id: s_of(&cloud, "versionId"),
            custom_domain: s_of(&cloud, "customDomain"),
        }),
        _ => None,
    };
    let bundle_obj = obj_of(&cloud, "bundle");
    let bundle = match (s_of(&bundle_obj, "hash"), s_of(&bundle_obj, "pub")) {
        (Some(hash), Some(pubkey)) => Some(BundleView {
            hash_short: group4(&hash.chars().take(16).collect::<String>()),
            hash_full: hash,
            pub_fingerprint: fingerprint(&pubkey),
            seq: u_of(&bundle_obj, "seq").unwrap_or(0),
            built_at: u_of(&bundle_obj, "builtAt").unwrap_or(0),
            deployed: profile.is_some(),
        }),
        _ => None,
    };
    let vapid = obj_of(&cloud, "vapid");
    let mut last = cloud.get("lastWhoami").cloned().filter(|v| v.is_object());
    if let (Some(Value::Object(l)), Some(chosen)) = (last.as_mut(), s_of(&cloud, "accountId")) {
        l.insert("chosenAccountId".into(), chosen.into());
    }
    let durable = i.secrets.as_ref().is_some_and(|h| (h.backend == "keychain" && !h.degraded) || (effective.mode() == Mode::E2e && h.backend == "memory" && !h.degraded));
    let workers_subdomain = profile.as_ref().and_then(|p| p.url.strip_prefix("wss://")).and_then(|h| h.strip_suffix(".workers.dev")).and_then(|h| h.split_once('.')).map(|(_, sub)| sub.to_owned());
    CloudView {
        jail: match effective.mode() {
            Mode::Off => "off",
            Mode::ReadOnly => "readOnly",
            Mode::E2e => "e2e",
        },
        cloud_flag: i.cloud_flag,
        kit: KitOut { kit: i.kit.clone(), dirty_files: 0 },
        secret_store_durable: durable,
        workers_subdomain,
        update_available: false,
        interrupted: false,
        mode,
        profile,
        auth: AuthView { auth_mode: mode_name(auth_mode_of(&cloud)).to_owned(), token_stored: i.token_stored, last, checked_at: u_of(&cloud, "whoamiAt") },
        keys: KeysView {
            signing_key: bundle.is_some(),
            signing_fingerprint: bundle.as_ref().map(|b| b.pub_fingerprint.clone()),
            vapid: s_of(&vapid, "public").is_some(),
            vapid_public: s_of(&vapid, "public"),
            push_deployed: cloud.get("pushDeployed").and_then(|v| v.as_bool()).unwrap_or(false),
            signing_rotation_pending: obj_of(&cloud, "rotation").get("signing").and_then(|v| v.as_bool()).unwrap_or(false),
            vapid_rotation_pending: obj_of(&cloud, "rotation").get("vapid").and_then(|v| v.as_bool()).unwrap_or(false),
        },
        bundle,
        last_check: i.remote.get("lastCheck").cloned().filter(|v| v.is_object()),
        limits: LimitsNotice::current(),
        busy: i.busy.clone().map(|(run_id, op)| BusyView { run_id, op }),
        remove_enabled: cloud.get("removeEnabled").and_then(|v| v.as_bool()).unwrap_or(false),
        secret_store: SecretStoreView { backend: i.secrets.as_ref().map(|h| h.backend.to_owned()).unwrap_or_default(), durable },
        custom: i.remote.get("custom").cloned().filter(|v| v.is_object()),
    }
}

// ---------------------------------------------------------------- events

/// Where `relay-cloud:*` events go. The Tauri implementation emits to the webview; tests collect.
pub trait Sink: Send + Sync {
    fn state(&self, run: &CloudRun);
    fn log(&self, chunk: &LogChunk);
}

struct AppSink(AppHandle);

impl Sink for AppSink {
    fn state(&self, run: &CloudRun) {
        let _ = self.0.emit("relay-cloud:state", run);
    }

    fn log(&self, chunk: &LogChunk) {
        let _ = self.0.emit("relay-cloud:log", chunk);
    }
}

/// Batches the masked lines (20 lines or 100 ms) so a chatty `pnpm install` does not flood the webview.
struct Run<'a> {
    sink: &'a dyn Sink,
    d: &'a Deployer,
    op: &'static str,
    run_id: String,
    seq: u32,
    buf: Vec<String>,
    last_flush: Instant,
    started: bool,
}

impl<'a> Run<'a> {
    fn new(sink: &'a dyn Sink, d: &'a Deployer, op: &'static str) -> Self {
        Self { sink, d, op, run_id: String::new(), seq: 0, buf: Vec::new(), last_flush: Instant::now(), started: false }
    }

    fn id(&mut self) -> String {
        if self.run_id.is_empty() {
            if let Some((id, _)) = self.d.runner().busy() {
                self.run_id = id;
            }
        }
        self.run_id.clone()
    }

    fn event(&mut self, status: &'static str) -> CloudRun {
        CloudRun { run_id: self.id(), op: self.op.to_owned(), status, step: None, step_status: None, code: None, detail: None, login_url: None }
    }

    fn start(&mut self) {
        if !self.started {
            self.started = true;
            let e = self.event("running");
            self.sink.state(&e);
        }
    }

    fn flush(&mut self) {
        if self.buf.is_empty() {
            return;
        }
        let lines = std::mem::take(&mut self.buf);
        let n = lines.len() as u32;
        let chunk = LogChunk { run_id: self.id(), start_seq: self.seq, lines, reset: false };
        self.seq += n;
        self.last_flush = Instant::now();
        self.sink.log(&chunk);
    }

    fn on(&mut self, ev: JobEvent) {
        self.start();
        match ev {
            JobEvent::Log(l) => {
                self.buf.push(l);
                if self.buf.len() >= LOG_FLUSH_LINES || self.last_flush.elapsed() >= LOG_FLUSH_EVERY {
                    self.flush();
                }
            }
            JobEvent::Step(s) => {
                self.flush();
                self.run_id = s.run_id.clone();
                let mut e = self.event("running");
                e.step = Some(s.step);
                e.step_status = Some(s.status);
                e.code = s.code;
                self.sink.state(&e);
            }
            JobEvent::LoginUrl(u) => {
                self.flush();
                let mut e = self.event("running");
                e.login_url = Some(u);
                self.sink.state(&e);
            }
        }
    }

    fn finish(&mut self, err: Option<&EngineError>) {
        self.flush();
        let mut e = self.event(match err {
            None => "ok",
            Some(x) if x.code == "cancelled" => "cancelled",
            Some(_) => "failed",
        });
        if let Some(x) = err {
            e.code = Some(x.code.clone());
            e.detail = Some(x.message.clone());
        }
        self.sink.state(&e);
    }
}

/// Runs `f` with the event plumbing; blocking. The final `relay-cloud:state` event goes out after `f` returned, so everything `f`
/// recorded (the profile in settings) is already there when the UI reloads its view.
fn drive<R>(sink: &dyn Sink, d: &Deployer, op: &'static str, f: impl FnOnce(&Deployer, &mut dyn FnMut(JobEvent)) -> Res<R>) -> Res<R> {
    let mut run = Run::new(sink, d, op);
    // A panic in the job must still end with a failed `relay-cloud:state` event; unwinding drops the runner guard.
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(d, &mut |ev| run.on(ev))))
        .unwrap_or_else(|_| Err(EngineError::new("internal", "the operation stopped unexpectedly".to_string())));
    run.finish(r.as_ref().err());
    r
}

/// Starts `f` on its own thread and answers with the run id as soon as the operation took the runner (`begin` is the name it uses),
/// or with its error when it failed before that (`busy`, a jail refusal, a missing kit).
fn start_job(
    sink: Arc<dyn Sink>,
    d: Arc<Deployer>,
    op: &'static str,
    begin: &'static str,
    f: impl FnOnce(&Deployer, &mut dyn FnMut(JobEvent)) -> Res<()> + Send + 'static,
) -> Res<RunStarted> {
    let (tx, rx) = mpsc::channel::<Res<()>>();
    let d2 = d.clone();
    std::thread::Builder::new()
        .name(format!("relay-cloud-{op}"))
        .spawn(move || {
            let r = drive(&*sink, &d2, op, f);
            let _ = tx.send(r);
        })
        .map_err(join_err)?;
    let t0 = Instant::now();
    loop {
        match rx.try_recv() {
            Ok(Err(e)) => return Err(e),
            Ok(Ok(())) => return Ok(RunStarted { run_id: String::new() }),
            Err(TryRecvError::Disconnected) => return Err(join_err("the operation thread ended unexpectedly")),
            Err(TryRecvError::Empty) => {}
        }
        if let Some((id, o)) = d.runner().busy() {
            if o == begin {
                return Ok(RunStarted { run_id: id });
            }
        }
        if t0.elapsed() > BEGIN_WAIT {
            return Ok(RunStarted { run_id: String::new() });
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

// ---------------------------------------------------------------- state

/// Inert until the first command: no thread, no disk access, no Keychain access.
pub struct CloudState {
    shared: Arc<Shared>,
}

struct Shared {
    settings: Option<Arc<SettingsStore>>,
    secrets: Option<Arc<dyn SecretStore>>,
    deployer: Mutex<Option<Arc<Deployer>>>,
    whoami: Mutex<Option<WhoAmI>>,
    /// Created at the first cloud operation (it needs the data directory); nothing exists on disk before that.
    audit: Mutex<Option<Arc<CloudAudit>>>,
}

impl CloudState {
    pub fn new(settings: Option<Arc<SettingsStore>>, secrets: Option<Arc<dyn SecretStore>>) -> Self {
        Self { shared: Arc::new(Shared { settings, secrets, deployer: Mutex::new(None), whoami: Mutex::new(None), audit: Mutex::new(None) }) }
    }
}

/// Called once from `setup` (wave5 relay cloud state marker). Reads nothing and starts nothing.
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let parts = app.try_state::<SettingsState>().and_then(|s| s.parts());
    let (settings, secrets) = match parts {
        Some((s, k)) => (Some(s), Some(k)),
        None => (None, None),
    };
    app.manage(CloudState::new(settings, secrets));
    Ok(())
}

fn whoami_json(w: &WhoAmI) -> Value {
    serde_json::to_value(w).unwrap_or(Value::Null)
}

fn whoami_from_json(v: &Value) -> Option<WhoAmI> {
    let o = v.as_object()?;
    let accounts = o
        .get("accounts")?
        .as_array()?
        .iter()
        .filter_map(|a| Some(Account { id: a.get("id")?.as_str()?.to_owned(), name: a.get("name").and_then(|n| n.as_str()).unwrap_or("").to_owned() }))
        .collect();
    Some(WhoAmI {
        logged_in: o.get("loggedIn")?.as_bool()?,
        auth_type: match o.get("authType").and_then(|a| a.as_str()) {
            Some("oauth") => Some(AuthType::Oauth),
            Some("token") => Some(AuthType::Token),
            _ => None,
        },
        email_hint: o.get("emailHint").and_then(|e| e.as_str()).map(str::to_owned),
        accounts,
        chosen_account_id: o.get("chosenAccountId").and_then(|e| e.as_str()).map(str::to_owned),
    })
}

fn random_hex(bytes: usize) -> Res<String> {
    use std::io::Read;
    let mut buf = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).map_err(|e| unavailable(&format!("no random source: {e}")))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

impl Shared {
    fn store(&self) -> Res<&Arc<SettingsStore>> {
        self.settings.as_ref().ok_or_else(|| unavailable("Settings are unavailable"))
    }

    fn secrets(&self) -> Res<&Arc<dyn SecretStore>> {
        self.secrets.as_ref().ok_or_else(|| unavailable("the secret store is unavailable"))
    }

    fn remote(&self) -> Obj {
        self.settings.as_ref().and_then(|s| s.get(NS).ok()).unwrap_or_default()
    }

    fn cloud(&self) -> Obj {
        obj_of(&self.remote(), "cloud")
    }

    fn set_remote(&self, patch: Obj) -> Res<()> {
        self.store()?.set(NS, patch).map(|_| ()).map_err(settings_err)
    }

    /// `remote.cloud` is written as a whole sub-object (the store merges shallowly).
    fn update_cloud(&self, f: impl FnOnce(&mut Obj)) -> Res<()> {
        let mut cloud = self.cloud();
        f(&mut cloud);
        let mut p = Obj::new();
        p.insert("cloud".into(), cloud.into());
        self.set_remote(p)
    }

    fn install_id(&self) -> Res<String> {
        if let Some(id) = s_of(&self.remote(), "installId") {
            return Ok(id);
        }
        let id = random_hex(16)?;
        let mut p = Obj::new();
        p.insert("installId".into(), id.clone().into());
        self.set_remote(p)?;
        Ok(id)
    }

    fn jail(&self) -> Jail {
        effective_jail(&Jail::global(), cloud_flag())
    }

    fn auth_ctx(&self) -> AuthCtx {
        let c = self.cloud();
        AuthCtx { mode: auth_mode_of(&c), account_id: s_of(&c, "accountId") }
    }

    fn cached_whoami(&self) -> Option<WhoAmI> {
        lock(&self.whoami).clone().or_else(|| self.cloud().get("lastWhoami").and_then(whoami_from_json))
    }

    fn remember_whoami(&self, w: &WhoAmI) {
        *lock(&self.whoami) = Some(w.clone());
        let auto = (w.accounts.len() == 1).then(|| w.accounts[0].clone());
        let _ = self.update_cloud(|c| {
            c.insert("lastWhoami".into(), whoami_json(w));
            c.insert("whoamiAt".into(), now_secs().into());
            if let Some(a) = auto {
                if s_of(c, "accountId").is_none() {
                    c.insert("accountId".into(), a.id.into());
                    c.insert("accountName".into(), a.name.into());
                }
            }
        });
    }

    /// The account a deploy targets: the chosen one, or the only one.
    fn resolve_account(&self) -> Result<Account, DeployError> {
        let chosen = s_of(&self.cloud(), "accountId");
        let who = self.cached_whoami().unwrap_or_else(WhoAmI::logged_out);
        let mut a = who.resolve_account(chosen.as_deref(), None)?;
        if a.name.is_empty() {
            a.name = s_of(&self.cloud(), "accountName").unwrap_or_default();
        }
        Ok(a)
    }

    /// `<data dir>/cloud-audit.jsonl`: next to the relay state directory, not inside it, so "forget" does not delete it.
    fn audit(&self, app: &AppHandle) -> Res<Arc<CloudAudit>> {
        if let Some(a) = lock(&self.audit).clone() {
            return Ok(a);
        }
        let agents = app.try_state::<crate::agents::AgentSlot>().ok_or_else(|| unavailable("the agent host is not ready yet"))?;
        let a = Arc::new(CloudAudit::new(agents.data_dir()));
        *lock(&self.audit) = Some(a.clone());
        Ok(a)
    }

    fn deployer(&self, app: &AppHandle) -> Res<Arc<Deployer>> {
        if let Some(d) = lock(&self.deployer).clone() {
            return Ok(d);
        }
        let secrets = self.secrets()?.clone();
        let agents = app.try_state::<crate::agents::AgentSlot>().ok_or_else(|| unavailable("the agent host is not ready yet"))?;
        let data_dir = agents.data_dir().to_path_buf();
        let jail = Jail::global();
        let cloud = cloud_flag();
        let kit = RelayKit::locate(&jail, relay_kit_hint(&jail).as_deref(), None, std::env::current_exe().ok().as_deref())?;
        let install_id = self.install_id()?;
        let eff = effective_jail(&jail, cloud);
        // The only place a LiveGesture is minted (spec 4.12.3): inside a command call of this module.
        let spawner = Arc::new(ProcessSpawner::new(LiveGesture::mint_in_tauri_command("relay_cloud")));
        let d = Arc::new(Deployer::new(Deps {
            kit,
            data_dir,
            jail: (*jail).clone(),
            cloud,
            spawner,
            http: Arc::new(ReqwestHttp::new(eff)),
            clock: Arc::new(SystemClock),
            store: secrets,
            var: Arc::new({
                let jail = (*jail).clone();
                move |k: &str| if k == "PATH" { Some(tool_path_for(&jail)) } else { std::env::var(k).ok() }
            }),
            install_id,
        }));
        *lock(&self.deployer) = Some(d.clone());
        Ok(d)
    }

    /// The Record step's output goes into `remote.cloud`. The relay URL is NOT applied: the user clicks `Use this relay now`.
    fn record_deploy(&self, rec: &DeployRecord) -> Res<()> {
        self.update_cloud(|c| {
            c.insert("workerName".into(), rec.worker_name.clone().into());
            c.insert("accountId".into(), rec.account_id.clone().into());
            c.insert("accountName".into(), rec.account_name.clone().into());
            c.insert("authMode".into(), mode_name(rec.auth_mode).into());
            c.insert("url".into(), rec.url.clone().into());
            c.insert("host".into(), rec.host.clone().into());
            match &rec.custom_domain {
                Some(d) => c.insert("customDomain".into(), d.clone().into()),
                None => c.remove("customDomain"),
            };
            c.insert("deployedAt".into(), rec.deployed_at.into());
            c.insert("versionId".into(), rec.version_id.clone().map(Value::from).unwrap_or(Value::Null));
            c.insert("wranglerVersion".into(), rec.wrangler_version.clone().map(Value::from).unwrap_or(Value::Null));
            c.insert("relayVersion".into(), rec.relay_version.clone().map(Value::from).unwrap_or(Value::Null));
            c.insert("relayCodeHash".into(), rec.relay_code_hash.clone().into());
            c.insert("stamp".into(), rec.stamp.clone().into());
            c.insert("pushDeployed".into(), rec.push_deployed.into());
            if let Some(p) = &rec.vapid_public {
                c.insert("vapid".into(), json!({"public": p, "setAt": rec.deployed_at}));
            }
            c.insert("bundle".into(), json!({"hash": rec.bundle.hash, "pub": rec.bundle.pubkey, "seq": rec.bundle.seq, "builtAt": rec.bundle.built_at}));
            // a rotation that this verified deploy committed is no longer pending
            let mut pending = obj_of(c, "rotation");
            if rec.key_rotated {
                pending.remove("signing");
            }
            if rec.vapid_rotated {
                pending.remove("vapid");
            }
            if pending.is_empty() {
                c.remove("rotation");
            } else {
                c.insert("rotation".into(), pending.into());
            }
        })?;
        let mut p = Obj::new();
        p.insert("lastCheck".into(), serde_json::to_value(&rec.check).unwrap_or(Value::Null));
        self.set_remote(p)
    }

    fn store_check(&self, c: &RelayCheck) {
        let mut p = Obj::new();
        p.insert("lastCheck".into(), serde_json::to_value(check_out(c)).unwrap_or(Value::Null));
        let _ = self.set_remote(p);
    }
}

// ---------------------------------------------------------------- the cloud audit trail

fn audit_err(e: DeployError) -> EngineError {
    // a damaged chain has its own code: the UI tells the user the way out (stop using the relay, then Forget, which keeps the file aside)
    let code = if e.code() == "auditCorrupt" { "auditCorrupt" } else { "unavailable" };
    EngineError::new(code, format!("the cloud audit log cannot be written ({}): nothing was started", e.code()))
}

/// Runs `f` between a `started` and a result record of `cloud-audit.jsonl`. Fails closed: when the `started` record cannot be written
/// (a damaged chain, a read-only disk) `f` does not run at all. The result record is best effort (the operation already happened).
/// Only the event, a detail slug, the Worker name and the account id tail are recorded, never argv values, output or secrets.
fn audited<R>(audit: &CloudAudit, event: &str, detail: &str, worker: &str, account_tail: &str, f: impl FnOnce() -> Res<R>) -> Res<R> {
    audit.append(&AuditRecord { ts: now_secs(), event, detail, outcome: "started", worker, account_tail }).map_err(audit_err)?;
    let r = f();
    let outcome = match &r {
        Ok(_) => "ok".to_owned(),
        Err(e) if e.code == "cancelled" => "cancelled".to_owned(),
        Err(e) => format!("failed:{}", e.code),
    };
    if let Err(e) = audit.append(&AuditRecord { ts: now_secs(), event, detail, outcome: &outcome, worker, account_tail }) {
        eprintln!("relay-cloud: the audit result record could not be written ({})", e.code());
    }
    r
}

/// A follow-up fact of an operation that already ran (a rotation committed by a verified redeploy): best effort.
fn note(audit: &CloudAudit, event: &str, detail: &str, worker: &str, account_tail: &str) {
    let rec = AuditRecord { ts: now_secs(), event, detail, outcome: "ok", worker, account_tail };
    if let Err(e) = audit.append(&rec) {
        eprintln!("relay-cloud: the audit record could not be written ({})", e.code());
    }
}

// ---------------------------------------------------------------- helpers

/// `wss://host[:port]` / `ws://127.0.0.1:port` to the matching HTTP base the relay check uses.
pub fn http_base(relay_url: &str) -> Res<String> {
    let p = parse_relay(relay_url).map_err(remote_err)?;
    Ok(format!("{}://{}", if p.secure { "https" } else { "http" }, p.authority()))
}

fn verify_ok(c: &RelayCheck) -> Res<()> {
    if !c.reachable {
        return Err(EngineError::new("network", "the relay did not answer"));
    }
    match c.verdict {
        BundleVerdict::Ok => Ok(()),
        BundleVerdict::BadSignature | BundleVerdict::KeyMismatch => Err(EngineError::new("badSignature", "the relay serves a bundle that does not verify under the pinned key")),
        _ => Err(EngineError::new("bundleMismatch", "the relay serves a different bundle than the recorded one")),
    }
}

fn valid_pubkey(k: &str) -> bool {
    k.len() == 43 && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// An API token as typed: no spaces or control characters, a sane length. The value is never logged, echoed or returned.
pub fn valid_token(t: &str) -> bool {
    (8..=512).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_graphic())
}

fn parse_step(s: &str) -> Res<Step> {
    Ok(match s {
        "deploy" => Step::Deploy,
        "secrets" => Step::Secrets,
        "health" => Step::Health,
        "verify" => Step::Verify,
        _ => return Err(EngineError::new("previewStale", "this step cannot be retried on its own")),
    })
}

fn expected_of(bundle: &Obj, pubkey: Option<String>, hash: Option<String>) -> Expected {
    Expected { hash, pubkey, min_seq: u_of(bundle, "seq") }
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn relay_cloud_status(state: State<'_, CloudState>) -> Res<CloudView> {
    guard("relay_cloud_status")?;
    let s = &state.shared;
    let remote = s.remote();
    let jail = Jail::global();
    let kit = match RelayKit::locate(&jail, relay_kit_hint(&jail).as_deref(), None, std::env::current_exe().ok().as_deref()) {
        Ok(k) => k.check(&tool_path_for(&jail)),
        Err(_) => KitReport::missing(),
    };
    // Only ask the Keychain about the token when the user chose token mode: status never triggers a prompt otherwise.
    let token_stored = auth_mode_of(&obj_of(&remote, "cloud")) == AuthMode::Token && s.secrets.as_ref().is_some_and(|k| k.has(keys::KEY_API_TOKEN).unwrap_or(false));
    let busy = lock(&s.deployer).as_ref().and_then(|d| d.runner().busy());
    Ok(build_view(&ViewInputs { remote: &remote, jail: &jail, cloud_flag: cloud_flag(), kit, token_stored, secrets: s.secrets.as_ref().map(|k| k.health()), busy }))
}

#[tauri::command]
pub async fn relay_cloud_prepare(app: AppHandle, state: State<'_, CloudState>) -> Res<RunStarted> {
    guard("relay_cloud_prepare")?;
    let d = state.shared.deployer(&app)?;
    start_job(Arc::new(AppSink(app)), d, "prepare", "prepare", |d, e| Ok(d.prepare(e)?))
}

#[tauri::command]
pub async fn relay_cloud_login(app: AppHandle, state: State<'_, CloudState>, device: bool) -> Res<RunStarted> {
    guard("relay_cloud_login")?;
    let s = state.shared.clone();
    let d = s.deployer(&app)?;
    start_job(Arc::new(AppSink(app)), d, "login", "login", move |d, e| {
        d.login(device, e)?;
        s.update_cloud(|c| {
            c.insert("authMode".into(), "oauth".into());
        })
    })
}

#[tauri::command]
pub async fn relay_cloud_logout(app: AppHandle, state: State<'_, CloudState>) -> Res<RunStarted> {
    guard("relay_cloud_logout")?;
    let s = state.shared.clone();
    let d = s.deployer(&app)?;
    start_job(Arc::new(AppSink(app)), d, "logout", "logout", move |d, e| {
        d.logout(e)?;
        *lock(&s.whoami) = None;
        s.update_cloud(|c| {
            c.remove("lastWhoami");
            c.remove("whoamiAt");
        })
    })
}

/// Write-only: the value goes to the Keychain and is dropped. No command returns it.
#[tauri::command]
pub fn relay_cloud_token_set(state: State<'_, CloudState>, token: String) -> Res<()> {
    guard("relay_cloud_token_set")?;
    let token = token.trim().to_owned();
    if !valid_token(&token) {
        return Err(EngineError::new("authInvalid", "that does not look like an API token"));
    }
    let s = &state.shared;
    s.secrets()?.set(keys::KEY_API_TOKEN, Secret::new(token)).map_err(keychain_err)?;
    s.update_cloud(|c| {
        c.insert("authMode".into(), "token".into());
    })
}

#[tauri::command]
pub fn relay_cloud_token_clear(state: State<'_, CloudState>) -> Res<()> {
    guard("relay_cloud_token_clear")?;
    let s = &state.shared;
    s.secrets()?.remove(keys::KEY_API_TOKEN).map_err(keychain_err)?;
    *lock(&s.whoami) = None;
    s.update_cloud(|c| {
        c.insert("authMode".into(), "oauth".into());
        c.remove("lastWhoami");
        c.remove("whoamiAt");
    })
}

#[tauri::command]
pub async fn relay_cloud_whoami(app: AppHandle, state: State<'_, CloudState>) -> Res<WhoAmI> {
    guard("relay_cloud_whoami")?;
    let s = state.shared.clone();
    let d = s.deployer(&app)?;
    let sink = Arc::new(AppSink(app));
    tauri::async_runtime::spawn_blocking(move || {
        let auth = s.auth_ctx();
        let w = drive(&*sink, &d, "whoami", |d, e| Ok(d.whoami(&auth, e)?))?;
        s.remember_whoami(&w);
        Ok(s.cached_whoami().unwrap_or(w))
    })
    .await
    .map_err(join_err)?
}

/// Token mode also uses this for the manual Account ID field (a scoped token may not list accounts).
#[tauri::command]
pub fn relay_cloud_choose_account(state: State<'_, CloudState>, account_id: String) -> Res<()> {
    guard("relay_cloud_choose_account")?;
    let s = &state.shared;
    let id = account_id.trim().to_owned();
    let known = s.cached_whoami().and_then(|w| w.accounts.into_iter().find(|a| a.id == id));
    if known.is_none() && !valid_account_id(&id) {
        return Err(EngineError::new("needsAccount", "that is not a Cloudflare account id"));
    }
    s.update_cloud(|c| {
        c.insert("accountId".into(), id.into());
        c.insert("accountName".into(), known.map(|a| a.name).unwrap_or_default().into());
    })
}

#[tauri::command]
pub async fn relay_cloud_preview(
    app: AppHandle,
    state: State<'_, CloudState>,
    worker_name: String,
    push: bool,
    custom_domain: Option<String>,
    allow_seq_clock_skew: Option<bool>,
) -> Res<DeployPreview> {
    guard("relay_cloud_preview")?;
    let s = state.shared.clone();
    let d = s.deployer(&app)?;
    let sink = Arc::new(AppSink(app));
    tauri::async_runtime::spawn_blocking(move || {
        let account = s.resolve_account()?;
        let req = PreviewRequest { worker_name, push, custom_domain, account, auth_mode: s.auth_ctx().mode, allow_seq_clock_skew: allow_seq_clock_skew.unwrap_or(false) };
        drive(&*sink, &d, "preview", |d, e| Ok(d.preview(&req, e)?))
    })
    .await
    .map_err(join_err)?
}

/// The plan of a deploy (from a live preview), a rollback or a remove (of the recorded Worker): the exact argv, directory, Worker
/// name and a one-time nonce with a short expiry, held here in Rust. The UI shows the command from the plan; the operation must
/// present the nonce and the typed Worker name (`plan.rs`). The Worker name never comes from the webview.
#[tauri::command]
pub async fn relay_cloud_plan(app: AppHandle, state: State<'_, CloudState>, op: String, preview_id: Option<String>) -> Res<Plan> {
    guard("relay_cloud_plan")?;
    let s = state.shared.clone();
    let d = s.deployer(&app)?;
    let op = PlanOp::parse(&op).ok_or_else(|| EngineError::new("invalid", "unknown plan operation"))?;
    let req = match op {
        PlanOp::Deploy => PlanRequest::Deploy { preview_id: preview_id.ok_or_else(|| EngineError::new("previewStale", "no review to plan from"))? },
        PlanOp::Rollback | PlanOp::Remove => {
            let c = s.cloud();
            let worker = s_of(&c, "workerName").ok_or_else(|| EngineError::new("previewStale", "no relay was deployed yet"))?;
            let auth = s.auth_ctx();
            if op == PlanOp::Rollback {
                PlanRequest::Rollback { worker, auth }
            } else {
                if !c.get("removeEnabled").and_then(|v| v.as_bool()).unwrap_or(false) {
                    return Err(EngineError::new("removeDisabled", "removing a relay from Cloudflare is not enabled yet"));
                }
                PlanRequest::Remove { worker, auth, force: false }
            }
        }
    };
    tauri::async_runtime::spawn_blocking(move || Ok(d.plan(&req)?)).await.map_err(join_err)?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn relay_cloud_deploy(
    app: AppHandle,
    state: State<'_, CloudState>,
    preview_id: String,
    confirm_name: String,
    overwrite_phrase: Option<String>,
    plan_id: Option<String>,
    acknowledge_unverified: Option<bool>,
) -> Res<RunStarted> {
    guard("relay_cloud_deploy")?;
    let s = state.shared.clone();
    let d = s.deployer(&app)?;
    let audit = s.audit(&app)?;
    // a deploy of the Worker the profile already holds is a redeploy
    let subject = d.preview_subject(&preview_id);
    let event = match &subject {
        Some((worker, _)) if s_of(&s.cloud(), "workerName").as_deref() == Some(worker.as_str()) => event::REDEPLOY,
        _ => event::DEPLOY,
    };
    let (worker, tail) = subject.unwrap_or_default();
    start_job(Arc::new(AppSink(app)), d, "deploy", "deploy", move |d, e| {
        audited(&audit, event, "", &worker, &tail, || {
            let rec = d.deploy(&DeployRequest { preview_id, confirm_name, overwrite_phrase, plan_id: plan_id.unwrap_or_default(), acknowledge_unverified: acknowledge_unverified.unwrap_or(false) }, e)?;
            s.record_deploy(&rec)?;
            if rec.key_rotated {
                note(&audit, event::ROTATE, "signing-committed", &worker, &tail);
            }
            if rec.vapid_rotated {
                note(&audit, event::ROTATE, "vapid-committed", &worker, &tail);
            }
            Ok(())
        })
    })
}

/// `Retry from this step` (Deploy, Secrets, Health, Verify) after a failed job.
#[tauri::command]
pub async fn relay_cloud_retry(app: AppHandle, state: State<'_, CloudState>, job_id: String, from: String) -> Res<RunStarted> {
    guard("relay_cloud_retry")?;
    let step = parse_step(&from)?;
    let s = state.shared.clone();
    let d = s.deployer(&app)?;
    let audit = s.audit(&app)?;
    // a retry re-runs wrangler against the real account: it leaves the same started/result lines as the deploy it continues
    let subject = d.job_subject(&job_id);
    let event = match &subject {
        Some((worker, _)) if s_of(&s.cloud(), "workerName").as_deref() == Some(worker.as_str()) => event::REDEPLOY,
        _ => event::DEPLOY,
    };
    let (worker, tail) = subject.unwrap_or_default();
    start_job(Arc::new(AppSink(app)), d, "deploy", "deploy", move |d, e| {
        audited(&audit, event, "retry", &worker, &tail, || {
            let rec = d.retry(&job_id, step, e)?;
            s.record_deploy(&rec)?;
            if rec.key_rotated {
                note(&audit, event::ROTATE, "signing-committed", &worker, &tail);
            }
            if rec.vapid_rotated {
                note(&audit, event::ROTATE, "vapid-committed", &worker, &tail);
            }
            Ok(())
        })
    })
}

#[tauri::command]
pub fn relay_cloud_stop(state: State<'_, CloudState>, run_id: String) -> Res<()> {
    guard("relay_cloud_stop")?;
    if let Some(d) = lock(&state.shared.deployer).as_ref() {
        d.stop(&run_id);
    }
    Ok(())
}

#[tauri::command]
pub fn relay_cloud_logs(state: State<'_, CloudState>, run_id: String, from_seq: u32) -> Res<LogChunk> {
    guard("relay_cloud_logs")?;
    let chunk = lock(&state.shared.deployer).as_ref().and_then(|d| d.logs(&run_id, from_seq));
    Ok(chunk.unwrap_or(LogChunk { run_id, start_seq: from_seq, lines: Vec::new(), reset: false }))
}

/// `target`: `deployed` (the recorded profile and its signed bundle) or `custom` (the typed URL and optional public key).
/// Plain HTTPS GETs to that relay only; read-only mode refuses, the E2E jail allows loopback only.
#[tauri::command]
pub async fn relay_cloud_verify(state: State<'_, CloudState>, target: String, url: Option<String>, pubkey: Option<String>) -> Res<CheckOut> {
    guard("relay_cloud_verify")?;
    let s = state.shared.clone();
    let jail = s.jail();
    let (relay_url, expected) = match target.as_str() {
        "deployed" => {
            let c = s.cloud();
            let b = obj_of(&c, "bundle");
            (s_of(&c, "url").ok_or_else(|| EngineError::new("previewStale", "no relay was deployed yet"))?, expected_of(&b, s_of(&b, "pub"), s_of(&b, "hash")))
        }
        "custom" => {
            let c = obj_of(&s.remote(), "custom");
            let key = pubkey.filter(|k| !k.is_empty()).or_else(|| s_of(&c, "pubkey"));
            if key.as_deref().is_some_and(|k| !valid_pubkey(k)) {
                return Err(EngineError::new("pubkeyInvalid", "the build public key is 43 base64url characters"));
            }
            (url.filter(|u| !u.is_empty()).or_else(|| s_of(&c, "url")).ok_or_else(|| EngineError::new("urlSyntax", "enter the relay URL first"))?, Expected { hash: None, pubkey: key, min_seq: None })
        }
        _ => return Err(EngineError::new("invalid", "unknown verify target")),
    };
    let base = http_base(&relay_url)?;
    let check = check_relay_with(&base, &expected, None, &jail, &ReqwestHttp::new(jail.clone())).await;
    s.store_check(&check);
    Ok(check_out(&check))
}

/// `mode` is `cloudflare` (the recorded, verified profile; the bundle verdict is re-checked now) or `local` ("stop using this relay").
/// The URL is never supplied by the webview.
#[tauri::command]
pub async fn relay_cloud_apply(app: AppHandle, state: State<'_, CloudState>, mode: String, confirm_unpair: bool) -> Res<RemoteSettingsView> {
    guard("relay_cloud_apply")?;
    let s = state.shared.clone();
    let patch = match mode.as_str() {
        "cloudflare" => {
            let c = s.cloud();
            let url = s_of(&c, "url").ok_or_else(|| EngineError::new("previewStale", "no relay was deployed yet"))?;
            let b = obj_of(&c, "bundle");
            let (Some(hash), Some(pubkey)) = (s_of(&b, "hash"), s_of(&b, "pub")) else {
                return Err(EngineError::new("bundleMismatch", "there is no signed bundle record to check"));
            };
            let jail = s.jail();
            let base = http_base(&url)?;
            let check = check_relay_with(&base, &expected_of(&b, Some(pubkey.clone()), Some(hash.clone())), None, &jail, &ReqwestHttp::new(jail.clone())).await;
            s.store_check(&check);
            verify_ok(&check)?;
            let local = parse_relay(&url).map_err(remote_err)?.local;
            ApplyRelayPatch {
                relay_url: url.clone(),
                mode: "cloudflare".into(),
                bundle: Some(BundleRecord { hash, pubkey, seq: u_of(&b, "seq").unwrap_or(0), built_at: u_of(&b, "builtAt").unwrap_or(0) }),
                // a host this IDE deployed is acknowledged by that fact
                acknowledge_host: if local { None } else { s_of(&c, "host") },
                confirm_unpair,
            }
        }
        "local" => ApplyRelayPatch { relay_url: DEFAULT_LOCAL_RELAY.into(), mode: "local".into(), bundle: None, acknowledge_host: None, confirm_unpair },
        _ => return Err(EngineError::new("useApply", "use the custom commands for a custom relay")),
    };
    tauri::async_runtime::spawn_blocking(move || apply_relay(&app, &app.state::<RemoteState>(), patch)).await.map_err(join_err)?
}

/// Stores the URL and the optional build public key of a bring-your-own relay after the typed host acknowledgement. Does nothing outward.
#[tauri::command]
pub fn relay_cloud_custom_set(state: State<'_, CloudState>, url: String, pubkey: Option<String>, acknowledge_host: String) -> Res<()> {
    guard("relay_cloud_custom_set")?;
    let s = &state.shared;
    let p = parse_relay(&url).map_err(remote_err)?;
    if !p.local && acknowledge_host.trim().to_ascii_lowercase() != p.authority() {
        return Err(EngineError::new("confirmMismatch", "the typed host does not match the relay URL"));
    }
    // The same rules the live client applies (wss only, no IP literals, no userinfo, jail), with the typed host allowed.
    let trust = RelayTrust { allowed_hosts: vec![p.authority()], jail: relay_jail(&s.jail()), resolver: None };
    RelayWs::new_with(&url, &trust).map_err(remote_err)?;
    let key = pubkey.map(|k| k.trim().to_owned()).filter(|k| !k.is_empty());
    if key.as_deref().is_some_and(|k| !valid_pubkey(k)) {
        return Err(EngineError::new("pubkeyInvalid", "the build public key is 43 base64url characters"));
    }
    let mut c = json!({"url": url, "acknowledgedAt": now_secs()});
    if let Some(k) = key {
        c["pubkey"] = k.into();
    }
    let mut patch = Obj::new();
    patch.insert("custom".into(), c);
    s.set_remote(patch)
}

#[tauri::command]
pub async fn relay_cloud_custom_apply(app: AppHandle, state: State<'_, CloudState>, confirm_unpair: bool) -> Res<RemoteSettingsView> {
    guard("relay_cloud_custom_apply")?;
    let s = state.shared.clone();
    let c = obj_of(&s.remote(), "custom");
    let url = s_of(&c, "url").ok_or_else(|| EngineError::new("urlSyntax", "no custom relay was set"))?;
    let p = parse_relay(&url).map_err(remote_err)?;
    let jail = s.jail();
    let key = s_of(&c, "pubkey");
    let check = check_relay_with(&http_base(&url)?, &Expected { hash: None, pubkey: key.clone(), min_seq: None }, None, &jail, &ReqwestHttp::new(jail.clone())).await;
    s.store_check(&check);
    if key.is_some() {
        verify_ok(&check)?;
    } else if !check.reachable {
        return Err(EngineError::new("network", "the relay did not answer"));
    }
    let patch = ApplyRelayPatch { relay_url: url, mode: "custom".into(), bundle: None, acknowledge_host: (!p.local).then(|| p.authority()), confirm_unpair };
    tauri::async_runtime::spawn_blocking(move || apply_relay(&app, &app.state::<RemoteState>(), patch)).await.map_err(join_err)?
}

#[tauri::command]
pub async fn relay_cloud_rollback(app: AppHandle, state: State<'_, CloudState>, confirm_name: String, plan_id: Option<String>) -> Res<RunStarted> {
    guard("relay_cloud_rollback")?;
    let s = state.shared.clone();
    let d = s.deployer(&app)?;
    let audit = s.audit(&app)?;
    let c = s.cloud();
    let worker = s_of(&c, "workerName").ok_or_else(|| EngineError::new("previewStale", "no relay was deployed yet"))?;
    let auth = s.auth_ctx();
    let tail = tail4(&s_of(&c, "accountId").unwrap_or_default());
    start_job(Arc::new(AppSink(app)), d, "rollback", "rollback", move |d, e| {
        audited(&audit, event::ROLLBACK, "", &worker, &tail, || Ok(d.rollback(&worker, &auth, &confirm_name, &plan_id.unwrap_or_default(), e)?))
    })
}

/// Hidden in the UI until the manual plan M8 passed (`remote.cloud.removeEnabled`, default false); refused here as well. On success the
/// profile is cleared and the app falls back to the local relay (unpairing phones through the same guarded apply path).
#[tauri::command]
pub async fn relay_cloud_remove(app: AppHandle, state: State<'_, CloudState>, confirm_name: String, plan_id: Option<String>) -> Res<RunStarted> {
    guard("relay_cloud_remove")?;
    let s = state.shared.clone();
    let c = s.cloud();
    if !c.get("removeEnabled").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err(EngineError::new("removeDisabled", "removing a relay from Cloudflare is not enabled yet"));
    }
    let d = s.deployer(&app)?;
    let audit = s.audit(&app)?;
    let worker = s_of(&c, "workerName").ok_or_else(|| EngineError::new("previewStale", "no relay was deployed yet"))?;
    let auth = s.auth_ctx();
    let tail = tail4(&s_of(&c, "accountId").unwrap_or_default());
    let app2 = app.clone();
    start_job(Arc::new(AppSink(app)), d, "remove", "remove", move |d, e| {
        audited(&audit, event::REMOVE, "", &worker, &tail, || {
            d.remove(&worker, &auth, &confirm_name, &plan_id.unwrap_or_default(), false, e)?;
            s.update_cloud(|c| {
                for k in ["workerName", "url", "host", "customDomain", "deployedAt", "versionId", "wranglerVersion", "relayVersion", "relayCodeHash", "stamp", "pushDeployed", "bundle"] {
                    c.remove(k);
                }
            })?;
            let patch = ApplyRelayPatch { relay_url: DEFAULT_LOCAL_RELAY.into(), mode: "local".into(), bundle: None, acknowledge_host: None, confirm_unpair: true };
            apply_relay(&app2, &app2.state::<RemoteState>(), patch).map(|_| ())
        })
    })
}

/// Local only: forgets the profile and deletes the Keychain items and the state directory. Does not touch Cloudflare.
#[tauri::command]
pub async fn relay_cloud_forget(app: AppHandle, state: State<'_, CloudState>, confirm: String) -> Res<()> {
    guard("relay_cloud_forget")?;
    if confirm != "forget" {
        return Err(EngineError::new("confirmMismatch", "type forget to confirm"));
    }
    let s = state.shared.clone();
    if s_of(&s.remote(), "relayMode").as_deref() == Some("cloudflare") {
        return Err(EngineError::new("useApply", "stop using this relay first"));
    }
    if lock(&s.deployer).as_ref().is_some_and(|d| d.runner().busy().is_some()) {
        return Err(EngineError::new("busy", "another relay operation is running"));
    }
    let secrets = s.secrets()?.clone();
    let audit = s.audit(&app)?;
    let c = s.cloud();
    let worker = s_of(&c, "workerName").unwrap_or_default();
    let tail = tail4(&s_of(&c, "accountId").unwrap_or_default());
    // Forget is the way out of a damaged audit log: the file is kept aside and a new chain starts, so this record can be written.
    if let Some(aside) = audit.quarantine(now_secs()).map_err(audit_err)? {
        eprintln!("relay-cloud: the damaged cloud audit log was kept as {}", aside.display());
    }
    audited(&audit, event::FORGET, "", &worker, &tail, || {
        for k in [
            keys::KEY_SIGNING,
            keys::KEY_SIGNING_NEXT,
            keys::KEY_SIGNING_NEXT_SHIPPED,
            keys::KEY_SEQ,
            keys::KEY_VAPID_PRIVATE,
            keys::KEY_VAPID_NEXT,
            keys::KEY_VAPID_NEXT_SHIPPED,
            keys::KEY_API_TOKEN,
        ] {
            secrets.remove(k).map_err(keychain_err)?;
        }
        if let Some(agents) = app.try_state::<crate::agents::AgentSlot>() {
            let dir = agents.data_dir().join("relay-deploy");
            if dir.is_dir() {
                std::fs::remove_dir_all(&dir).map_err(|e| unavailable(&format!("could not delete the relay state directory: {e}")))?;
            }
        }
        *lock(&s.whoami) = None;
        let mut p = Obj::new();
        p.insert("cloud".into(), Value::Object(Obj::new()));
        p.insert("lastCheck".into(), Value::Null);
        s.set_remote(p)
    })
}

/// The VAPID pair is generated in Rust: the private half goes straight to the Keychain, only the public half is returned.
#[tauri::command]
pub fn relay_cloud_vapid_generate(state: State<'_, CloudState>) -> Res<VapidView> {
    guard("relay_cloud_vapid_generate")?;
    let s = &state.shared;
    let (_private, public) = keys::ensure_vapid(&**s.secrets()?, &s.jail())?;
    s.update_cloud(|c| {
        c.insert("vapid".into(), json!({"public": public, "setAt": now_secs()}));
    })?;
    Ok(VapidView { fingerprint: group4(&public.chars().take(16).collect::<String>()), public })
}

/// The three `secret put` calls (values on stdin) for an existing profile.
#[tauri::command]
pub async fn relay_cloud_vapid_push(app: AppHandle, state: State<'_, CloudState>) -> Res<RunStarted> {
    guard("relay_cloud_vapid_push")?;
    let s = state.shared.clone();
    let d = s.deployer(&app)?;
    let c = s.cloud();
    let worker = s_of(&c, "workerName").ok_or_else(|| EngineError::new("previewStale", "no relay was deployed yet"))?;
    let host = s_of(&c, "host").ok_or_else(|| EngineError::new("previewStale", "no relay was deployed yet"))?;
    let auth = s.auth_ctx();
    let audit = s.audit(&app)?;
    let tail = tail4(&s_of(&c, "accountId").unwrap_or_default());
    start_job(Arc::new(AppSink(app)), d, "vapidPush", "vapidPush", move |d, e| {
        audited(&audit, event::VAPID_PUSH, "", &worker, &tail, || {
            d.put_vapid_secrets(&worker, &host, &auth, e)?;
            s.update_cloud(|c| {
                c.insert("pushDeployed".into(), true.into());
            })
        })
    })
}

/// Key rotation is staged: `signing` / `vapid` generate the new key and hold it NEXT TO the active one (`remote.cloud.rotation`
/// marks it pending). The next preview signs with it, and only the verified redeploy that carries it makes it the active key
/// (`record_deploy` clears the mark); until then a failed redeploy loses nothing. Phones pin the signing key, so after the commit
/// every paired phone must be paired again; with a staged push key phones re-subscribe on their next open.
/// `signingCancel` / `vapidCancel` roll a pending rotation back: the staged key is deleted and the active one stays.
#[tauri::command]
pub fn relay_cloud_rotate(app: AppHandle, state: State<'_, CloudState>, kind: String, confirm: String) -> Res<()> {
    guard("relay_cloud_rotate")?;
    if confirm != "rotate" {
        return Err(EngineError::new("confirmMismatch", "type rotate to confirm"));
    }
    let s = &state.shared;
    if lock(&s.deployer).as_ref().is_some_and(|d| d.runner().busy().is_some()) {
        return Err(EngineError::new("busy", "another relay operation is running"));
    }
    let (detail, field, stage) = match kind.as_str() {
        "signing" => ("signing-staged", "signing", true),
        "vapid" => ("vapid-staged", "vapid", true),
        "signingCancel" => ("signing-cancelled", "signing", false),
        "vapidCancel" => ("vapid-cancelled", "vapid", false),
        _ => return Err(EngineError::new("invalid", "unknown key kind")),
    };
    let audit = s.audit(&app)?;
    let c = s.cloud();
    let worker = s_of(&c, "workerName").unwrap_or_default();
    let tail = tail4(&s_of(&c, "accountId").unwrap_or_default());
    let store = &**s.secrets()?;
    audited(&audit, event::ROTATE, detail, &worker, &tail, || {
        match (field, stage) {
            ("signing", true) => {
                keys::stage_signing_key(store, &s.jail())?;
            }
            ("vapid", true) => {
                keys::stage_vapid(store, &s.jail())?;
            }
            ("signing", false) => {
                keys::discard_staged_signing_key(store)?;
            }
            _ => {
                keys::discard_staged_vapid(store)?;
            }
        }
        s.update_cloud(|c| {
            let mut pending = obj_of(c, "rotation");
            if stage {
                pending.insert(field.into(), true.into());
            } else {
                pending.remove(field);
            }
            if pending.is_empty() {
                c.remove("rotation");
            } else {
                c.insert("rotation".into(), pending.into());
            }
        })
    })
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    use intely_relay_deploy::{Op, Reply, ScriptedSpawner, Spawner};
    use intely_settings::secrets::MemorySecretStore;

    use super::*;

    #[derive(Default)]
    struct Collect {
        states: Mutex<Vec<CloudRun>>,
        logs: Mutex<Vec<LogChunk>>,
    }

    impl Sink for Collect {
        fn state(&self, run: &CloudRun) {
            lock(&self.states).push(run.clone());
        }

        fn log(&self, chunk: &LogChunk) {
            lock(&self.logs).push(chunk.clone());
        }
    }

    static N: AtomicU32 = AtomicU32::new(0);

    /// The directories one test created; they are deleted when its thread ends (every test runs on its own thread).
    struct Cleanup(std::cell::RefCell<Vec<PathBuf>>);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            for p in self.0.borrow().iter() {
                let _ = fs::remove_dir_all(p);
            }
        }
    }

    thread_local! {
        static DIRS: Cleanup = const { Cleanup(std::cell::RefCell::new(Vec::new())) };
    }

    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("intely-relay-cloud-{}-{}-{tag}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        DIRS.with(|d| d.0.borrow_mut().push(p.clone()));
        p
    }

    /// A kit in a temp dir with a stand-in wrangler file that is never executed (the scripted spawner answers instead).
    fn temp_kit(root: &Path) -> RelayKit {
        let relay = root.join("remote-relay");
        fs::create_dir_all(relay.join("node_modules/.bin")).unwrap();
        fs::create_dir_all(relay.join("node_modules/wrangler")).unwrap();
        fs::create_dir_all(root.join("remote-web")).unwrap();
        fs::write(relay.join("package.json"), r#"{"name":"x","version":"0.1.0","devDependencies":{"wrangler":"4.147.0"}}"#).unwrap();
        fs::write(relay.join("node_modules/wrangler/package.json"), r#"{"version":"4.147.0"}"#).unwrap();
        fs::write(relay.join("node_modules/.bin/wrangler"), "#!/bin/sh\nexit 1\n").unwrap();
        fs::write(root.join("remote-web/package.json"), "{}").unwrap();
        RelayKit::at(root).unwrap()
    }

    fn deployer(spawner: ScriptedSpawner, jail: Jail, cloud: bool) -> (Arc<Deployer>, Arc<ScriptedSpawner>, PathBuf) {
        let root = tmp("kit");
        let spawner = Arc::new(spawner);
        let sp: Arc<dyn Spawner> = spawner.clone();
        let d = Arc::new(Deployer::new(Deps {
            kit: temp_kit(&root),
            data_dir: root.join("data"),
            jail,
            cloud,
            spawner: sp,
            http: Arc::new(ReqwestHttp::new(Jail::read_only())),
            clock: Arc::new(SystemClock),
            store: Arc::new(MemorySecretStore::new()),
            var: Arc::new(|k| (k == "PATH").then(|| "/usr/bin:/bin".to_owned())),
            install_id: "test-install".to_owned(),
        }));
        (d, spawner, root)
    }

    fn map(v: Value) -> Obj {
        v.as_object().cloned().unwrap()
    }

    // ---- the jail table (spec 4.9)

    #[test]
    fn every_command_of_the_spec_is_in_the_table() {
        let spec = [
            "status", "prepare", "login", "logout", "token_set", "token_clear", "whoami", "choose_account", "preview", "plan", "deploy", "stop", "logs", "verify", "apply", "custom_set", "custom_apply",
            "rollback", "forget", "vapid_generate", "vapid_push", "rotate", "remove",
        ];
        for c in spec {
            assert!(COMMANDS.iter().any(|(n, _)| *n == format!("relay_cloud_{c}")), "relay_cloud_{c} is missing from the gate table");
        }
        let mut names: Vec<_> = COMMANDS.iter().map(|(n, _)| *n).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), COMMANDS.len(), "no duplicate rows");
    }

    #[test]
    fn read_only_refuses_every_relay_command_but_status_logs_and_stop() {
        for (name, gate) in COMMANDS {
            let r = allow(&Jail::read_only(), false, name);
            match gate {
                Gate::Free => assert!(r.is_ok(), "{name} spawns nothing and stays available"),
                Gate::Relay => assert_eq!(r.unwrap_err().code, READ_ONLY, "{name} must be refused in read-only mode"),
            }
        }
    }

    #[test]
    fn the_cloud_flag_lifts_read_only_for_the_relay_commands_only() {
        for (name, _) in COMMANDS {
            assert!(allow(&Jail::read_only(), true, name).is_ok(), "{name}");
        }
        assert_eq!(effective_jail(&Jail::read_only(), true).mode(), Mode::Off, "only the relay tools see the lifted jail");
        assert_eq!(Jail::read_only().mode(), Mode::ReadOnly, "the jail itself is unchanged: the repos stay read-only");
    }

    /// Every command that writes to the user's real Cloudflare account (or deletes the local keys) leaves a started and a result line.
    /// Read from the source: a new command of that kind cannot be added without its `audited(` wrapper and still pass.
    #[test]
    fn every_command_that_changes_the_account_or_the_keys_is_audited() {
        let src = include_str!("relay_cloud.rs");
        let body_of = |name: &str| -> String {
            let at = src.find(&format!("fn {name}(")).unwrap_or_else(|| panic!("{name} exists"));
            let rest = &src[at..];
            let end = rest.find("\n#[tauri::command]").unwrap_or(rest.len());
            rest[..end].to_owned()
        };
        for name in ["relay_cloud_deploy", "relay_cloud_retry", "relay_cloud_rollback", "relay_cloud_remove", "relay_cloud_forget", "relay_cloud_rotate", "relay_cloud_vapid_push"] {
            assert!(body_of(name).contains("audited("), "{name} must run inside `audited`");
        }
    }

    #[test]
    fn the_cloud_flag_needs_an_explicit_yes() {
        for on in ["1", "true", "TRUE", " yes ", "on"] {
            assert!(cloud_flag_from(Some(on)), "{on:?}");
        }
        for off in ["", "0", "false", "off", "OFF", "no", "none", "disabled", "2", "y", "enable"] {
            assert!(!cloud_flag_from(Some(off)), "{off:?} must not lift read-only mode");
        }
        assert!(!cloud_flag_from(None));
    }

    #[test]
    fn the_test_jail_ignores_the_cloud_flag_and_off_allows_everything() {
        let e2e = Jail::e2e(std::env::temp_dir());
        assert_eq!(effective_jail(&e2e, true).mode(), Mode::E2e, "E2E always wins over INTELY_CLOUD");
        for (name, _) in COMMANDS {
            assert!(allow(&Jail::off(), false, name).is_ok());
            assert!(allow(&e2e, true, name).is_ok(), "{name}: the lower layers gate spawns and sockets in the test jail");
        }
        assert!(allow(&Jail::off(), false, "relay_cloud_nope").is_err(), "an unknown command is never allowed");
    }

    #[test]
    fn read_only_without_the_flag_spawns_nothing_even_when_a_command_slips_through() {
        // the Deployer gates the spawn a second time: Prepare (pnpm) is refused in read-only mode
        let (d, sp, _root) = deployer(ScriptedSpawner::new(), Jail::read_only(), false);
        let sink = Collect::default();
        let r = drive(&sink, &d, "prepare", |d, e| Ok(d.prepare(e)?));
        assert!(r.is_err());
        assert!(sp.calls().is_empty(), "no process may be spawned in read-only mode");
        assert_eq!(lock(&sink.states).last().unwrap().status, "failed");
    }

    // ---- INTELY_CLOUD for a non-loopback relay (docs/safety.md, "INTELY_CLOUD"): relay side only, repositories stay jailed

    #[test]
    fn the_relay_jail_table_for_every_launch_mode_and_flag() {
        let e2e = Jail::e2e(std::env::temp_dir());
        assert!(matches!(relay_jail_for(&Jail::off(), false), RelayJail::Off));
        assert!(matches!(relay_jail_for(&Jail::off(), true), RelayJail::Off));
        assert!(matches!(relay_jail_for(&Jail::read_only(), false), RelayJail::ReadOnly), "read-only without the flag: no non-loopback relay");
        assert!(matches!(relay_jail_for(&Jail::read_only(), true), RelayJail::Off), "read-only with INTELY_CLOUD=1: the relay side behaves like off");
        assert!(matches!(relay_jail_for(&e2e, false), RelayJail::E2e));
        assert!(matches!(relay_jail_for(&e2e, true), RelayJail::E2e), "the test jail always wins: loopback only");
    }

    #[test]
    fn a_non_loopback_relay_needs_the_flag_in_read_only_mode_and_an_acknowledged_host_even_with_it() {
        let url = "wss://relay.my-sub.workers.dev";
        let host = parse_relay(url).unwrap().authority();
        let trust = |jail: RelayJail, allowed: &[&str]| RelayTrust { allowed_hosts: allowed.iter().map(|h| h.to_string()).collect(), jail, resolver: None };
        let code = |t: RelayTrust| RelayWs::new_with(url, &t).err().map(|e| remote_err(e).code);
        assert_eq!(code(trust(relay_jail_for(&Jail::read_only(), false), &[&host])).as_deref(), Some("readOnly"));
        assert_eq!(code(trust(relay_jail_for(&Jail::read_only(), true), &[&host])), None, "an acknowledged host is reachable with the flag");
        assert_eq!(code(trust(relay_jail_for(&Jail::read_only(), true), &[])).as_deref(), Some("hostNotAllowed"), "the flag does not acknowledge a host");
        assert_eq!(code(trust(relay_jail_for(&Jail::e2e(std::env::temp_dir()), true), &[&host])).as_deref(), Some("testJail"));
        assert_eq!(code(trust(relay_jail_for(&Jail::off(), false), &[&host])), None);
    }

    #[test]
    fn the_flag_lifts_nothing_for_the_repositories() {
        // the jail the repositories see is the unchanged jail: every mutating operation stays refused
        let jail = Jail::read_only();
        let repo = Path::new("/tmp/some-repo");
        let _lifted = effective_jail(&jail, true);
        assert_eq!(jail.mode(), Mode::ReadOnly);
        for op in ["commit", "push", "write file"] {
            assert_eq!(jail.check_op(op, repo).unwrap_err().code, READ_ONLY, "{op}");
        }
        assert_eq!(jail.check_git(repo, &["push", "origin", "main"]).unwrap_err().code, READ_ONLY);
        assert_eq!(jail.check_git(repo, &["commit", "-m", "x"]).unwrap_err().code, READ_ONLY);
    }

    /// `INTELY_CLOUD` is read in `relay_cloud.rs` and nowhere near the git engine, the file writer or the agent host.
    #[test]
    fn the_cloud_flag_never_reaches_the_repository_side() {
        fn text(p: &Path) -> String {
            fs::read_to_string(p).unwrap_or_default()
        }
        let app = Path::new(env!("CARGO_MANIFEST_DIR"));
        let crates = app.join("../crates");
        for krate in ["core", "gitx", "files", "agent_core", "agent_gate", "agent_host", "runner", "term", "checks", "settings", "roles"] {
            let mut files = Vec::new();
            rust_files(&crates.join(krate), &mut files);
            for f in files {
                assert!(!text(&f).contains("INTELY_CLOUD"), "{} mentions INTELY_CLOUD", f.display());
            }
        }
        let mut files = Vec::new();
        rust_files(&app.join("src"), &mut files);
        let needle = format!("{}{}", "INTELY_", "CLOUD");
        let call = format!("{}{}", "effective_jail", "(");
        for f in files {
            let name = f.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_owned();
            let t = text(&f);
            if !matches!(name.as_str(), "relay_cloud.rs" | "remote.rs") {
                assert!(!t.contains(&needle), "{} mentions the cloud flag; only relay_cloud.rs (and a comment in remote.rs) may", f.display());
                assert!(!t.contains(&call), "{} lifts the jail; only relay_cloud.rs may", f.display());
            }
        }
        // remote.rs asks relay_cloud for its relay jail and does not read the variable itself
        let remote = text(&app.join("src/modules/remote.rs"));
        assert!(!remote.contains("env::var(\"INTELY_CLOUD\")") && remote.contains("relay_jail_for"));
    }

    // ---- the cloud audit trail around an operation

    fn audit_in(tag: &str) -> (PathBuf, CloudAudit) {
        let dir = tmp(tag);
        let a = CloudAudit::new(&dir);
        (dir, a)
    }

    #[test]
    fn an_operation_is_recorded_before_and_after_and_a_failure_keeps_its_code() {
        let (_dir, audit) = audit_in("audit-ok");
        let ran = std::cell::Cell::new(0);
        assert!(audited(&audit, event::DEPLOY, "", "intely-relay-0123456789ab", "cdef", || {
            ran.set(ran.get() + 1);
            Ok(())
        })
        .is_ok());
        let r: Res<()> = audited(&audit, event::REMOVE, "", "intely-relay-0123456789ab", "cdef", || Err(EngineError::new("confirmMismatch", "typed name")));
        assert_eq!(r.unwrap_err().code, "confirmMismatch");
        let r: Res<()> = audited(&audit, event::ROLLBACK, "", "intely-relay-0123456789ab", "cdef", || Err(EngineError::new("cancelled", "stopped")));
        assert!(r.is_err());
        assert_eq!(ran.get(), 1);
        let rows: Vec<(String, String)> = audit.read().into_iter().map(|e| (e.event, e.outcome)).collect();
        let want = [("deploy", "started"), ("deploy", "ok"), ("remove", "started"), ("remove", "failed:confirmMismatch"), ("rollback", "started"), ("rollback", "cancelled")];
        assert_eq!(rows, want.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>());
        assert_eq!(audit.verify(), Ok(6));
    }

    #[test]
    fn nothing_runs_when_the_started_record_cannot_be_written() {
        let dir = tmp("audit-closed");
        fs::write(dir.join("not-a-directory"), "x").unwrap();
        let audit = CloudAudit::new(&dir.join("not-a-directory"));
        let ran = std::cell::Cell::new(false);
        let r: Res<()> = audited(&audit, event::DEPLOY, "", "w", "cdef", || {
            ran.set(true);
            Ok(())
        });
        assert_eq!(r.unwrap_err().code, "unavailable");
        assert!(!ran.get(), "the operation must not start without its record");
        // a damaged chain is not continued either
        let (_d, audit) = audit_in("audit-damaged");
        audited(&audit, event::DEPLOY, "", "w", "cdef", || Ok(())).unwrap();
        fs::write(audit.path(), "garbage\n").unwrap();
        let r: Res<()> = audited(&audit, event::DEPLOY, "", "w", "cdef", || {
            ran.set(true);
            Ok(())
        });
        assert_eq!(r.as_ref().map(|_| ()).unwrap_err().code, "auditCorrupt");
        assert!(!ran.get());
        // Forget's way out: the damaged file is kept aside and the next operation can be recorded again
        assert!(audit.quarantine(9).unwrap().is_some());
        audited(&audit, event::FORGET, "", "w", "cdef", || {
            ran.set(true);
            Ok(())
        })
        .unwrap();
        assert!(ran.get());
        assert_eq!(audit.verify(), Ok(3), "the reset line plus started and ok");
    }

    #[test]
    fn a_remove_without_a_plan_spawns_nothing_and_leaves_a_failed_record() {
        let (d, sp, root) = deployer(ScriptedSpawner::new().on(Op::Delete, Reply::ok()), Jail::off(), false);
        fs::create_dir_all(root.join("data/relay-deploy/intely-relay-0123456789ab")).unwrap();
        fs::write(root.join("data/relay-deploy/intely-relay-0123456789ab/wrangler.jsonc"), "{}").unwrap();
        let (_dir, audit) = audit_in("audit-remove");
        let auth = AuthCtx { mode: AuthMode::Oauth, account_id: Some("0123456789abcdef0123456789abcdef".into()) };
        let worker = "intely-relay-0123456789ab";
        let r = audited(&audit, event::REMOVE, "", worker, "cdef", || Ok(d.remove(worker, &auth, worker, &"0".repeat(32), false, &mut |_| {})?));
        assert_eq!(r.unwrap_err().code, "previewStale");
        assert!(sp.calls_of(Op::Delete).is_empty(), "no plan, no wrangler");
        let rows: Vec<String> = audit.read().into_iter().map(|e| e.outcome).collect();
        assert_eq!(rows, ["started", "failed:previewStale"]);
        // with a plan and the typed name it runs, and the record says so
        let plan = d.plan(&PlanRequest::Remove { worker: worker.into(), auth: auth.clone(), force: false }).unwrap();
        assert!(audited(&audit, event::REMOVE, "", worker, "cdef", || Ok(d.remove(worker, &auth, worker, &plan.plan_id, false, &mut |_| {})?)).is_ok());
        assert_eq!(sp.calls_of(Op::Delete).len(), 1);
        assert_eq!(audit.verify(), Ok(4));
        let text = fs::read_to_string(audit.path()).unwrap();
        assert!(!text.contains("--") && !text.contains(plan.plan_id.as_str()) && !text.contains(&root.to_string_lossy().to_string()), "no argv value, nonce or path: {text}");
    }

    // ---- state and view

    #[test]
    fn setup_state_is_inert() {
        let st = CloudState::new(None, None);
        assert!(lock(&st.shared.deployer).is_none());
        assert!(lock(&st.shared.whoami).is_none());
        assert!(st.shared.remote().is_empty(), "no settings are read or written without a store");
    }

    fn view(remote: Obj, jail: &Jail, cloud: bool) -> CloudView {
        build_view(&ViewInputs { remote: &remote, jail, cloud_flag: cloud, kit: KitReport::missing(), token_stored: false, secrets: None, busy: None })
    }

    #[test]
    fn a_pending_rotation_shows_in_the_view_without_touching_the_keychain() {
        let remote = map(json!({"cloud": {"rotation": {"signing": true}}}));
        let v = serde_json::to_value(view(remote, &Jail::off(), false)).unwrap();
        assert_eq!(v["keys"]["signingRotationPending"], true);
        assert_eq!(v["keys"]["vapidRotationPending"], false);
        let v = serde_json::to_value(view(Obj::new(), &Jail::off(), false)).unwrap();
        assert_eq!((v["keys"]["signingRotationPending"].clone(), v["keys"]["vapidRotationPending"].clone()), (json!(false), json!(false)));
    }

    #[test]
    fn the_default_view_is_local_mode_without_a_profile() {
        let v = serde_json::to_value(view(Obj::new(), &Jail::off(), false)).unwrap();
        assert_eq!(v["mode"], "local");
        assert!(v["profile"].is_null() && v["bundle"].is_null());
        assert_eq!(v["jail"], "off");
        assert_eq!(v["removeEnabled"], false);
        assert_eq!(v["auth"]["authMode"], "oauth");
        assert!(v["limits"]["rows"].is_array(), "the costs notice comes from the crate constants");
        assert_eq!(v["kit"]["found"], false);
    }

    #[test]
    fn the_view_reports_the_effective_jail_for_the_read_only_banner() {
        assert_eq!(serde_json::to_value(view(Obj::new(), &Jail::read_only(), false)).unwrap()["jail"], "readOnly");
        let lifted = serde_json::to_value(view(Obj::new(), &Jail::read_only(), true)).unwrap();
        assert_eq!(lifted["jail"], "off");
        assert_eq!(lifted["cloudFlag"], true);
        assert_eq!(serde_json::to_value(view(Obj::new(), &Jail::e2e(std::env::temp_dir()), true)).unwrap()["jail"], "e2e");
    }

    #[test]
    fn a_recorded_profile_and_bundle_show_up_with_the_id_tail_only() {
        let pubkey = "A".repeat(43);
        let remote = map(json!({
            "relayMode": "cloudflare",
            "cloud": {
                "workerName": "intely-relay-0123456789ab", "url": "wss://x.y.workers.dev", "accountId": "0123456789abcdef0123456789abcdef", "accountName": "Acme",
                "authMode": "token", "deployedAt": 1790000000u64, "pushDeployed": true, "vapid": {"public": "BPubKey", "setAt": 1},
                "bundle": {"hash": "a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718", "pub": pubkey, "seq": 7, "builtAt": 5},
                "removeEnabled": true,
                "lastWhoami": {"loggedIn": true, "authType": "oauth", "emailHint": "f***@h***.hu", "accounts": [{"id": "0123456789abcdef0123456789abcdef", "name": "Acme"}], "chosenAccountId": null}
            }
        }));
        let v = serde_json::to_value(view(remote, &Jail::off(), false)).unwrap();
        assert_eq!(v["mode"], "cloudflare");
        assert_eq!(v["profile"]["accountIdTail"], "cdef");
        assert_eq!(v["profile"]["authMode"], "token");
        assert_eq!(v["bundle"]["hashShort"], "a1b2 c3d4 e5f6 0718");
        assert_eq!(v["bundle"]["seq"], 7);
        assert_eq!(v["keys"]["vapidPublic"], "BPubKey");
        assert_eq!(v["keys"]["pushDeployed"], true);
        assert_eq!(v["removeEnabled"], true);
        assert_eq!(v["auth"]["last"]["chosenAccountId"], "0123456789abcdef0123456789abcdef");
        assert!(v["profile"].get("accountId").is_none(), "the profile view carries the id tail only");
    }

    #[test]
    fn the_secret_store_is_durable_only_for_the_keychain_or_the_test_jail_memory_store() {
        let h = |backend, degraded| Some(SecretsHealth { backend, degraded, message: None });
        let dur = |jail: &Jail, health| {
            serde_json::to_value(build_view(&ViewInputs { remote: &Obj::new(), jail, cloud_flag: false, kit: KitReport::missing(), token_stored: false, secrets: health, busy: None })).unwrap()["secretStore"]["durable"].clone()
        };
        assert_eq!(dur(&Jail::off(), h("keychain", false)), true);
        assert_eq!(dur(&Jail::off(), h("keychain", true)), false);
        assert_eq!(dur(&Jail::off(), h("memory", false)), false);
        assert_eq!(dur(&Jail::e2e(std::env::temp_dir()), h("memory", false)), true);
    }

    // ---- helpers

    #[test]
    fn relay_urls_map_to_the_http_base_the_check_uses() {
        assert_eq!(http_base("wss://a.b.workers.dev").unwrap(), "https://a.b.workers.dev");
        assert_eq!(http_base("ws://127.0.0.1:8787").unwrap(), "http://127.0.0.1:8787");
        assert!(http_base("ws://evil.example").is_err());
        assert!(http_base("wss://user@host").is_err());
    }

    #[test]
    fn token_and_key_shapes() {
        assert!(valid_token("cfut_0123456789abcdef0123456789abcdef"));
        assert!(!valid_token("short"));
        assert!(!valid_token("has space inside the token value"));
        assert!(!valid_token(&"x".repeat(513)));
        assert!(valid_pubkey(&"a".repeat(43)) && !valid_pubkey(&"a".repeat(42)) && !valid_pubkey(&format!("{}+", "a".repeat(42))));
        assert!(parse_step("deploy").is_ok() && parse_step("stage").is_err());
    }

    #[test]
    fn the_whoami_cache_round_trips_without_losing_accounts() {
        let w = WhoAmI {
            logged_in: true,
            auth_type: Some(AuthType::Oauth),
            email_hint: Some("f***@h***.hu".into()),
            accounts: vec![Account { id: "0123456789abcdef0123456789abcdef".into(), name: "Acme".into() }],
            chosen_account_id: None,
        };
        assert_eq!(whoami_from_json(&whoami_json(&w)).unwrap(), w);
        assert!(whoami_from_json(&json!({"nope": 1})).is_none());
    }

    #[test]
    fn check_out_serializes_the_verdict_by_name() {
        let c = RelayCheck {
            reachable: true,
            latency_ms: Some(12),
            relay_version: Some("0.1.0".into()),
            protocol: Some("intely.v1".into()),
            do_ok: None,
            push_configured: Some(false),
            served_hash: Some("ab".into()),
            verdict: BundleVerdict::KeyMismatch,
            sw_matches: Some(true),
            checked_at: 5,
            problems: vec!["x".into()],
        };
        let v = serde_json::to_value(check_out(&c)).unwrap();
        assert_eq!(v["verdict"], "keyMismatch");
        assert_eq!(v["latencyMs"], 12);
        assert_eq!(verify_ok(&c).unwrap_err().code, "badSignature");
    }

    // ---- the event plumbing

    #[test]
    fn a_job_emits_running_log_batches_and_one_final_state_in_order() {
        let (d, sp, _root) = deployer(ScriptedSpawner::new().on(Op::Logout, Reply::ok().lines(&["Logging out", "done"])), Jail::off(), false);
        let sink = Arc::new(Collect::default());
        let sink_dyn: Arc<dyn Sink> = sink.clone();
        assert!(start_job(sink_dyn, d.clone(), "logout", "logout", |d, e| Ok(d.logout(e)?)).is_ok());
        for _ in 0..300 {
            if lock(&sink.states).iter().any(|s| s.status != "running") {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let states = lock(&sink.states).clone();
        assert_eq!(states.first().unwrap().status, "running");
        assert_eq!(states.last().unwrap().status, "ok");
        assert_eq!(states.iter().filter(|s| s.status == "ok").count(), 1);
        let lines: Vec<String> = lock(&sink.logs).iter().flat_map(|c| c.lines.clone()).collect();
        assert!(lines.first().unwrap().starts_with("$ "), "the echo line comes first: {lines:?}");
        assert!(lines.contains(&"Logging out".to_owned()) && lines.contains(&"done".to_owned()));
        assert_eq!(lock(&sink.logs).first().unwrap().start_seq, 0);
        assert_eq!(sp.calls_of(Op::Logout).len(), 1);
    }

    #[test]
    fn log_sequence_numbers_continue_across_batches_and_match_the_runner_ring() {
        let many: Vec<String> = (0..45).map(|i| format!("line {i}")).collect();
        let refs: Vec<&str> = many.iter().map(String::as_str).collect();
        let (d, _sp, _root) = deployer(ScriptedSpawner::new().on(Op::Logout, Reply::ok().lines(&refs)), Jail::off(), false);
        let sink = Collect::default();
        drive(&sink, &d, "logout", |d, e| Ok(d.logout(e)?)).unwrap();
        let logs = lock(&sink.logs).clone();
        assert!(logs.len() >= 2, "45 lines flush in several batches");
        let mut next = 0;
        for c in &logs {
            assert_eq!(c.start_seq, next);
            next += c.lines.len() as u32;
        }
        assert_eq!(next, 46, "echo line plus 45 output lines");
        assert_eq!(d.logs(&logs[0].run_id, 0).unwrap().lines.len() as u32, next);
    }

    #[test]
    fn a_second_operation_while_one_runs_fails_with_busy_and_stop_frees_the_runner() {
        let (d, _sp, _root) = deployer(ScriptedSpawner::new().on(Op::Login, Reply::ok().blocking()), Jail::off(), false);
        let sink: Arc<dyn Sink> = Arc::new(Collect::default());
        let first = start_job(sink.clone(), d.clone(), "login", "login", |d, e| Ok(d.login(false, e)?)).unwrap();
        assert!(!first.run_id.is_empty(), "the run id is known as soon as the runner is taken");
        let second = start_job(sink, d.clone(), "logout", "logout", |d, e| Ok(d.logout(e)?));
        assert_eq!(second.unwrap_err().code, "busy");
        d.stop(&first.run_id);
        for _ in 0..300 {
            if d.runner().busy().is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(d.runner().busy().is_none());
    }

    #[test]
    fn a_failing_job_reports_its_code() {
        let (d, _sp, _root) = deployer(ScriptedSpawner::new().on(Op::Logout, Reply::exit(1, &["Authentication error [code: 10000]"])), Jail::off(), false);
        let sink = Collect::default();
        assert!(drive(&sink, &d, "logout", |d, e| Ok(d.logout(e)?)).is_err());
        let last = lock(&sink.states).last().unwrap().clone();
        assert_eq!(last.status, "failed");
        assert!(last.code.is_some());
    }

    #[test]
    fn a_panicking_job_still_ends_with_a_failed_state_event() {
        let (d, _sp, _root) = deployer(ScriptedSpawner::new(), Jail::off(), false);
        let sink = Collect::default();
        let r: Res<()> = drive(&sink, &d, "deploy", |_d, _e| panic!("boom"));
        assert_eq!(r.unwrap_err().code, "internal");
        let last = lock(&sink.states).last().unwrap().clone();
        assert_eq!(last.status, "failed");
        assert_eq!(last.code.as_deref(), Some("internal"));
    }

    // ---- static guards (spec 4.12.3)

    fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                rust_files(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }

    #[test]
    fn no_source_file_of_the_app_names_the_kits_real_wrangler_and_only_this_module_mints_a_live_gesture() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files = Vec::new();
        rust_files(&root.join("src"), &mut files);
        rust_files(&root.join("tests"), &mut files);
        // the needles are built at run time so this file does not contain them itself
        let real = format!("{}/{}/{}", "remote-relay", "node_modules/.bin", "wrangler");
        let mint = format!("{}{}", "mint_in_tauri", "_command");
        for f in files {
            let text = fs::read_to_string(&f).unwrap_or_default();
            assert!(!text.contains(&real), "{} references the kit's real wrangler", f.display());
            if f.file_name().is_some_and(|n| n != "relay_cloud.rs") {
                assert!(!text.contains(&mint), "{} mints a LiveGesture; only relay_cloud.rs may", f.display());
            }
        }
    }
}
