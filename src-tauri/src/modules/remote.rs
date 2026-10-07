//! Tauri glue of IntelyIDE Remote ((design notes: remote-plan), track Rm1): commands and state on top of `intely_remote`. Commands are
//! listed under the "wave3 Rm1 remote commands" marker in `lib.rs`; the state is created in `setup`.
//!
//! Zero cost when off: `setup` only creates an empty state. Nothing here reads disk, starts a thread, opens a socket or
//! subscribes to events until `remote_enable`. The webview never sees keys, tokens or the Noise state; it sees the
//! `RemoteSettingsView` and the one-time pairing offer. Pairing, promotion, revocation, enabling, the kill switch and panic are
//! commands only the webview can call (an agent has no IPC path to them), which is the desktop trusted gesture of the plan.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use intely_agent_core::api::{AgentSummary, PermissionDecision, QuestionAnswer};
use intely_agent_core::bus::EventBus;
use intely_agent_core::events::types::{AgentEvent, EventKind};
use intely_agent_core::events::{EventLog, JsonlEventLog, LogError};
use intely_agent_core::hub::{AgentHub, HubError, Origin, PendingKind, PendingRequest, PendingTable, PromptMode, Resolution, StartParams};
use intely_agent_core::policy::decide::PolicyContext;
use intely_agent_core::projection::RunProjection;
use intely_agent_core::providers::PermissionMode;
use intely_agent_host::AgentHost;
use intely_core::EngineError;
use intely_remote::api::{BundleSource, BundleView, RemoteSettingsView};
use intely_remote::gateway::{GatewayCfg, HostEvent};
use intely_remote::pairing::OfferView;
use intely_remote::policy::{pending_permission, pending_question, plan_excerpt, LowList};
use intely_remote::relay_ws::{parse_relay, ParsedRelay, RelayJail, RelayTrust};
use intely_remote::slot::{ApplyHooks, RelayConfig, RemoteSlot, SlotConfig};
use intely_remote::wire::Capability;
use intely_remote::RemoteError;
use intely_settings::{SecretStore, SettingsStore};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use super::settings::SettingsState;
use super::switchhook::{self, BoxFuture, SwitchGate, SwitchHook};

type Res<T> = Result<T, EngineError>;

/// Local `wrangler dev` unless the user configured something else (and the client refuses any non-local host anyway).
const DEFAULT_RELAY: &str = "ws://127.0.0.1:8787";
const NS: &str = "remote";

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn engine(e: impl std::fmt::Display) -> EngineError {
    EngineError::new("remote", e.to_string())
}

// ---------------------------------------------------------------- the hub over the running AgentHost

/// The host already appended an event to its JSONL log before it hands it to the sink, so the bus must not append again:
/// this log reads through to the same files and treats `append` as done. Append-before-publish still holds.
struct PreAppendedLog(JsonlEventLog);

impl EventLog for PreAppendedLog {
    fn append(&self, _event: &AgentEvent) -> Result<(), LogError> {
        Ok(())
    }

    fn read(&self, agent_id: &str) -> Result<Vec<AgentEvent>, LogError> {
        self.0.read(agent_id)
    }

    fn runs(&self) -> Result<Vec<String>, LogError> {
        self.0.runs()
    }
}

/// `AgentHub` for the phone, on top of `AgentHost` (the single run surface). The host stays the authority for answers
/// (its own exactly-once check); this table adds the remote rules: origin, intent hash, expiry, desktop-only.
pub struct HostHub {
    host: AgentHost,
    bus: EventBus,
    log: Arc<PreAppendedLog>,
    table: PendingTable,
    data_dir: PathBuf,
    low: LowList,
    /// One context per run, with the mode it was built for: a live mode switch rebuilds it (a stale one would keep the old folder boundary).
    contexts: Mutex<HashMap<String, (PermissionMode, PolicyContext)>>,
    /// Worker queue of `enqueue`; exists only while Remote is on.
    queue: Mutex<Option<std::sync::mpsc::Sender<Vec<AgentEvent>>>>,
    /// Set while a workspace switch is under way: nothing a phone asks may start a run then.
    gate: Mutex<Option<Arc<SwitchGate>>>,
}

impl HostHub {
    fn new(host: AgentHost, data_dir: PathBuf) -> Arc<Self> {
        let log = Arc::new(PreAppendedLog(JsonlEventLog::new(&data_dir)));
        Arc::new(Self { host, bus: EventBus::new(log.clone()), log, table: PendingTable::new(), data_dir, low: LowList::default(), contexts: Mutex::new(HashMap::new()), queue: Mutex::new(None), gate: Mutex::new(None) })
    }

    fn set_gate(&self, gate: Option<Arc<SwitchGate>>) {
        *lock(&self.gate) = gate;
    }

    /// Everything a phone could still answer belongs to the workspace that is being left: it is cancelled, so a late
    /// "approve" finds nothing (`unknown request`) instead of acting on whatever the new workspace runs. Returns how many.
    fn cancel_pending(&self) -> usize {
        let open = self.table.open();
        for p in &open {
            self.table.cancel(&p.req_id);
        }
        open.len()
    }

    /// The host calls its sink with its state lock held, and `on_events` needs that state (`policy_context` reads the run
    /// metadata), so it must not run on the host's thread: a worker applies the batches in order. Started with the first
    /// batch after Remote was switched on, ended by `stop_worker`.
    fn enqueue(self: &Arc<Self>, events: &[AgentEvent]) {
        let mut q = lock(&self.queue);
        let tx = q.get_or_insert_with(|| {
            let (tx, rx) = std::sync::mpsc::channel::<Vec<AgentEvent>>();
            let weak = Arc::downgrade(self);
            let _ = std::thread::Builder::new().name("remote-hub".into()).spawn(move || {
                for batch in rx {
                    let Some(hub) = weak.upgrade() else { break };
                    hub.on_events(&batch);
                }
            });
            tx
        });
        let _ = tx.send(events.to_vec());
    }

    fn stop_worker(&self) {
        lock(&self.queue).take();
    }

    /// Registers requests, closes answered ones and publishes. Registration comes first so a gateway that reacts to the
    /// event finds the request.
    fn on_events(&self, events: &[AgentEvent]) {
        for e in events {
            match &e.kind {
                EventKind::PermissionRequest { req_id, tool_id, intent, plan, .. } => {
                    if let Some(ctx) = self.policy_context(&e.agent_id) {
                        self.table.register(pending_with_plan(&e.agent_id, req_id, tool_id, intent, plan.as_deref(), &ctx, &self.low));
                    }
                }
                EventKind::QuestionRequest { req_id, tool_id, prompt, .. } => self.table.register(pending_question(&e.agent_id, req_id, tool_id.as_deref(), prompt, now_ms())),
                EventKind::PermissionResolved { req_id, .. } => self.close(req_id, &e.agent_id, PendingKind::Permission),
                EventKind::ToolResult { tool_id, .. } => {
                    for q in self.table.open().into_iter().filter(|p| p.kind == PendingKind::Question && p.tool_id.as_deref() == Some(tool_id.as_str()) && p.agent_id == e.agent_id) {
                        self.close(&q.req_id, &q.agent_id, PendingKind::Question);
                    }
                }
                EventKind::TurnEnd { .. } => {
                    for p in self.table.open().into_iter().filter(|p| p.agent_id == e.agent_id) {
                        self.table.cancel(&p.req_id);
                    }
                }
                _ => {}
            }
            let _ = self.bus.publish(e);
        }
    }

    /// Resolved on the Mac (or by the run itself): nobody can win it any more.
    fn close(&self, req_id: &str, agent_id: &str, kind: PendingKind) {
        let _ = self.table.resolve(req_id, agent_id, kind, None, &Origin::Desktop, now_ms());
    }

    /// Requests that were already open when Remote was switched on, rebuilt from the run logs.
    fn rebuild_pending(&self) {
        for run in self.host.list() {
            let Ok(events) = self.host.history(&run.agent_id, None) else { continue };
            if RunProjection::fold(&run.agent_id, &events).waiting_on.is_empty() {
                continue;
            }
            let mut open: Vec<&AgentEvent> = Vec::new();
            for e in &events {
                match &e.kind {
                    EventKind::PermissionRequest { .. } | EventKind::QuestionRequest { .. } => open.push(e),
                    EventKind::PermissionResolved { req_id, .. } => open.retain(|o| !matches!(&o.kind, EventKind::PermissionRequest { req_id: r, .. } if r == req_id)),
                    EventKind::ToolResult { tool_id, .. } => open.retain(|o| !matches!(&o.kind, EventKind::QuestionRequest { tool_id: Some(t), .. } if t == tool_id)),
                    EventKind::TurnEnd { .. } => open.clear(),
                    _ => {}
                }
            }
            for e in open {
                self.on_events_register_only(e);
            }
        }
    }

    fn on_events_register_only(&self, e: &AgentEvent) {
        match &e.kind {
            EventKind::PermissionRequest { req_id, tool_id, intent, plan, .. } => {
                if let Some(ctx) = self.policy_context(&e.agent_id) {
                    self.table.register(pending_with_plan(&e.agent_id, req_id, tool_id, intent, plan.as_deref(), &ctx, &self.low));
                }
            }
            EventKind::QuestionRequest { req_id, tool_id, prompt, .. } => self.table.register(pending_question(&e.agent_id, req_id, tool_id.as_deref(), prompt, now_ms())),
            _ => {}
        }
    }
}

/// The pending record of a permission card; an ExitPlanMode card also carries the first 2 KiB of the (already redacted) plan, so the person
/// who approves on the phone sees what they agree to. Approving from the phone continues the run in Ask and never in a looser mode.
fn pending_with_plan(agent_id: &str, req_id: &str, tool_id: &str, intent: &intely_agent_core::policy::intent::ToolIntent, plan: Option<&str>, ctx: &PolicyContext, low: &LowList) -> PendingRequest {
    let mut p = pending_permission(agent_id, req_id, tool_id, intent, ctx, low, now_ms());
    if let Some(plan) = plan.filter(|_| intent.tool.as_deref() == Some("ExitPlanMode")) {
        let (excerpt, cut) = plan_excerpt(plan);
        p.plan_excerpt = Some(excerpt);
        p.plan_truncated = Some(cut);
    }
    p
}

fn unavailable(e: EngineError) -> HubError {
    HubError::Unavailable(format!("{}: {}", e.code, e.message))
}

impl AgentHub for HostHub {
    fn list_runs(&self) -> Vec<AgentSummary> {
        self.host.list()
    }

    fn pending_requests(&self) -> Vec<PendingRequest> {
        self.table.open()
    }

    /// Rebuilt from the run's persisted metadata: the first repo is the working directory, the others are add-dirs. The
    /// role's deny lists, MCP set and saved allows are not known here, so the context is the *stricter* one (an MCP server
    /// outside the set is refused, a subagent type is asked, nothing is a saved allow).
    fn policy_context(&self, agent_id: &str) -> Option<PolicyContext> {
        // the run's mode as Rust holds it now: a cached context for another mode is stale (D8: Rust stays the authority across a switch)
        let mode = self.host.mode_of(agent_id)?;
        if let Some((cached, c)) = lock(&self.contexts).get(agent_id) {
            if *cached == mode {
                return Some(c.clone());
            }
        }
        let meta = self.host.metas().into_iter().find(|m| m.agent_id == agent_id)?;
        let mut paths = meta.repos.iter().map(|r| r.path.clone());
        let mut ctx = PolicyContext::new(mode, paths.next()?);
        ctx.add_dirs = paths.collect();
        ctx.home = std::env::var_os("HOME").map(PathBuf::from);
        ctx.state_dir = Some(self.data_dir.clone());
        // only Plan reads without a folder boundary to enforce, and only Bypass has none (permission-modes spec 5.7)
        ctx.strict_jail = mode != PermissionMode::ReadOnly && mode != PermissionMode::Bypass;
        lock(&self.contexts).insert(agent_id.to_string(), (mode, ctx.clone()));
        Some(ctx)
    }

    fn log(&self) -> Arc<dyn EventLog> {
        self.log.clone()
    }

    fn bus(&self) -> EventBus {
        self.bus.clone()
    }

    fn send_prompt(&self, agent_id: &str, text: &str, mode: PromptMode, _origin: &Origin) -> Result<(), HubError> {
        if mode == PromptMode::Interrupt {
            self.host.interrupt(agent_id).map_err(unavailable)?;
        }
        self.host.send(agent_id, text).map_err(unavailable)
    }

    fn answer_permission(&self, req_id: &str, agent_id: &str, decision: PermissionDecision, intent_hash: Option<&str>, origin: &Origin) -> Result<Resolution, HubError> {
        let req = self.table.resolve(req_id, agent_id, PendingKind::Permission, intent_hash, origin, now_ms())?;
        match self.host.answer_permission(agent_id, req_id, decision) {
            Ok(()) => Ok(Resolution { req_id: req_id.into(), agent_id: agent_id.into(), origin: origin.clone() }),
            Err(e) if e.code == "alreadyAnswered" => {
                // the desktop got there between our claim and the host's check
                self.table.reopen(req);
                self.close(req_id, agent_id, PendingKind::Permission);
                Err(HubError::AlreadyResolved { by: Origin::Desktop })
            }
            Err(e) => {
                self.table.reopen(req);
                Err(unavailable(e))
            }
        }
    }

    fn answer_question(&self, req_id: &str, agent_id: &str, answer: QuestionAnswer, intent_hash: Option<&str>, origin: &Origin) -> Result<Resolution, HubError> {
        let req = self.table.resolve(req_id, agent_id, PendingKind::Question, intent_hash, origin, now_ms())?;
        match self.host.answer_question(agent_id, req_id, answer) {
            Ok(()) => Ok(Resolution { req_id: req_id.into(), agent_id: agent_id.into(), origin: origin.clone() }),
            Err(e) if e.code == "alreadyAnswered" => {
                self.table.reopen(req);
                self.close(req_id, agent_id, PendingKind::Question);
                Err(HubError::AlreadyResolved { by: Origin::Desktop })
            }
            Err(e) => {
                self.table.reopen(req);
                Err(unavailable(e))
            }
        }
    }

    fn interrupt(&self, agent_id: &str, _origin: &Origin) -> Result<(), HubError> {
        self.host.interrupt(agent_id).map_err(unavailable)
    }

    fn start_run(&self, _start: StartParams, _origin: &Origin) -> Result<AgentSummary, HubError> {
        let gate = lock(&self.gate).clone();
        if let Err(e) = switchhook::check_optional(gate.as_deref()) {
            return Err(unavailable(e));
        }
        Err(HubError::Unavailable("starting runs from the phone needs run templates (Phase 5)".into()))
    }

    fn resolved_origin(&self, req_id: &str) -> Option<Origin> {
        self.table.resolved_origin(req_id)
    }

    /// Every sidecar-launched Claude run already carries `disableRemoteControl: true` (sidecar settings overlay), so there
    /// is no live Remote Control session to close; nothing to do and nothing reached.
    fn disable_claude_remote_control(&self) -> usize {
        0
    }
}

// ---------------------------------------------------------------- state

struct Live {
    slot: Arc<RemoteSlot>,
    hub: Arc<HostHub>,
}

/// Inert until the first command. `live` is created lazily because the agent host does not exist yet during `setup`.
pub struct RemoteState {
    live: Mutex<Option<Arc<Live>>>,
    settings: Option<Arc<SettingsStore>>,
    secrets: Option<Arc<dyn SecretStore>>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum HostEventView {
    PairingSas { code: String, device_hint: String },
    PairingEnded { outcome: String },
    DevicesChanged,
    Anomaly { device_id: String },
    Tampered { message: String },
    NeedsYouAging,
    /// The relay URL, mode or bundle changed live (`apply_relay`); the Settings page reloads its view.
    RelayChanged,
}

fn view_of(e: HostEvent) -> HostEventView {
    match e {
        HostEvent::PairingSas { code, device_hint } => HostEventView::PairingSas { code, device_hint },
        HostEvent::PairingEnded { outcome } => HostEventView::PairingEnded { outcome },
        HostEvent::DevicesChanged => HostEventView::DevicesChanged,
        HostEvent::Anomaly { device_id } => HostEventView::Anomaly { device_id },
        HostEvent::Tampered(message) => HostEventView::Tampered { message },
        HostEvent::NeedsYouAging => HostEventView::NeedsYouAging,
    }
}

// ---------------------------------------------------------------- the workspace switch

/// The `SwitchHook` of Remote: pending asks of the old workspace are cancelled and the Mac UI hears
/// `remote:workspaceChanged` (no repo data; a phone that syncs again gets the new run list). Costs nothing while Remote is off.
struct RemoteHook {
    app: AppHandle,
}

impl SwitchHook for RemoteHook {
    fn name(&self) -> &'static str {
        "remote"
    }

    fn busy(&self) -> Vec<intely_core::BusyItem> {
        Vec::new()
    }

    fn stop(&self) -> BoxFuture<'_, Vec<intely_core::SwitchWarning>> {
        Box::pin(async move {
            if let Some(state) = self.app.try_state::<RemoteState>() {
                let live = lock(&state.live).clone();
                if let Some(live) = live {
                    live.hub.cancel_pending();
                }
            }
            let _ = self.app.emit("remote:workspaceChanged", serde_json::json!({}));
            Vec::new()
        })
    }
}

pub fn hook(app: &AppHandle) -> Option<Arc<dyn SwitchHook>> {
    Some(Arc::new(RemoteHook { app: app.clone() }))
}

/// Called once from `setup` (wave3 Rm1 state marker). Reads nothing and starts nothing.
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let parts = app.try_state::<SettingsState>().and_then(|s| s.parts());
    let (settings, secrets) = match parts {
        Some((s, k)) => (Some(s), Some(k)),
        None => (None, None),
    };
    app.manage(RemoteState { live: Mutex::new(None), settings, secrets });
    Ok(())
}

/// `RunEvent::Exit`: the gateway thread and its socket end with the app.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<RemoteState>() {
        if let Some(live) = lock(&state.live).take() {
            live.slot.disable();
            live.hub.stop_worker();
        }
    }
}

/// The one-line hook of `agents.rs` (`TauriHostSink::events`): committed host events go to the Remote hub, but only while
/// Remote is on. Off costs one `try_state` and one lock.
pub fn tap(app: &AppHandle, events: &[AgentEvent]) {
    let Some(state) = app.try_state::<RemoteState>() else { return };
    let live = lock(&state.live).clone();
    if let Some(live) = live.filter(|l| l.slot.is_on()) {
        live.hub.enqueue(events);
    }
}

fn remote_settings(state: &RemoteState) -> serde_json::Map<String, serde_json::Value> {
    state.settings.as_ref().and_then(|s| s.get(NS).ok()).unwrap_or_default()
}

/// rpId and origin of the PWA from the relay URL (WebAuthn does not accept an IP address as rpId: `localhost` stands in).
fn relying_party(relay: &ParsedRelay) -> (String, String) {
    let rp = if relay.host.parse::<std::net::IpAddr>().is_ok() { "localhost".to_string() } else { relay.host.clone() };
    (rp, format!("{}://{}", if relay.secure { "https" } else { "http" }, relay.authority().replace("127.0.0.1", "localhost")))
}

/// The launch mode as the relay client sees it: `relay_cloud::relay_jail_for` (the one definition; `INTELY_CLOUD=1` lifts only the
/// read-only jail for the relay side, the repos stay jailed and the E2E jail always wins).
fn relay_jail() -> RelayJail {
    use intely_core::jail::Jail;
    super::relay_cloud::relay_jail_for(&Jail::global(), super::relay_cloud::cloud_flag())
}

fn str_of<'a>(m: &'a serde_json::Map<String, serde_json::Value>, key: &str) -> Option<&'a str> {
    m.get(key).and_then(|v| v.as_str())
}

/// The ONE parser of the relay keys (`relayUrl`, `relayMode`, `cloud.bundle`, `custom.pubkey`, `trust.allowedHosts`, legacy
/// `expectedBundleHash`); `live()` and the apply path both use it. Precedence of the shown hash: the signed, deployed
/// `cloud.bundle` (only in mode `cloudflare`) over the legacy settings key.
fn relay_target(cfg: &serde_json::Map<String, serde_json::Value>, jail: RelayJail) -> RelayConfig {
    let relay_url = str_of(cfg, "relayUrl").unwrap_or(DEFAULT_RELAY).to_string();
    let mode = match str_of(cfg, "relayMode") {
        Some(m @ ("cloudflare" | "custom")) => m.to_string(),
        _ => "local".to_string(),
    };
    let parsed = parse_relay(&relay_url).ok();
    let (relay_host, rp_id, origin) = match &parsed {
        Some(p) => {
            let (rp, o) = relying_party(p);
            (p.authority(), rp, o)
        }
        None => (relay_url.split("://").nth(1).unwrap_or(&relay_url).to_string(), "localhost".into(), "http://localhost".into()),
    };
    let allowed_hosts = cfg.get("trust").and_then(|t| t.get("allowedHosts")).and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|h| h.as_str()).map(str::to_ascii_lowercase).collect()).unwrap_or_default();
    let mut expected_bundle_hash = str_of(cfg, "expectedBundleHash").map(str::to_string);
    let (mut bundle, mut bundle_pub) = (expected_bundle_hash.as_ref().map(|h| BundleView::new(&h.replace(' ', ""), "", 0, 0, BundleSource::Settings)), None);
    match mode.as_str() {
        "cloudflare" => {
            if let Some(b) = cfg.get("cloud").and_then(|c| c.get("bundle")).and_then(|b| b.as_object()) {
                if let (Some(hash), Some(pubkey)) = (str_of(b, "hash"), str_of(b, "pub")) {
                    let view = BundleView::new(hash, pubkey, b.get("seq").and_then(|v| v.as_u64()).unwrap_or(0), b.get("builtAt").and_then(|v| v.as_u64()).unwrap_or(0), BundleSource::SignedLocal);
                    expected_bundle_hash = Some(view.hash_short.clone());
                    bundle = Some(view);
                    bundle_pub = Some(pubkey.to_string());
                }
            }
        }
        "custom" => bundle_pub = cfg.get("custom").and_then(|c| c.get("pubkey")).and_then(|k| k.as_str()).filter(|k| k.len() == 43).map(str::to_string),
        _ => {}
    }
    RelayConfig { relay_url, relay_host, rp_id, origin, expected_bundle_hash, bundle, bundle_pub, trust: RelayTrust { allowed_hosts, jail, resolver: None }, mode }
}

/// `code: message` errors of the relay client become `EngineError`s with that code (the UI maps the code to text).
fn engine_remote(e: RemoteError) -> EngineError {
    const CODES: [&str; 12] = ["urlSyntax", "scheme", "userinfo", "ipLiteral", "idn", "insecure", "readOnly", "testJail", "hostNotAllowed", "qrBudget", "busy", "needsRepair"];
    let text = e.to_string();
    match text.split_once(": ") {
        // the number of paired phones travels in `detail`
        Some(("needsRepair", n)) => EngineError { code: "needsRepair".into(), message: "switching relay hosts unpairs the paired phones".into(), detail: Some(n.to_string()) },
        Some((code, rest)) if CODES.contains(&code) => EngineError::new(code, rest.to_string()),
        _ => EngineError::new("remote", text),
    }
}

fn mac_name() -> String {
    std::env::var("HOSTNAME").ok().filter(|h| !h.is_empty()).unwrap_or_else(|| "My Mac".into())
}

fn live(app: &AppHandle, state: &RemoteState) -> Res<Arc<Live>> {
    if let Some(l) = lock(&state.live).clone() {
        return Ok(l);
    }
    let secrets = state.secrets.clone().ok_or_else(|| EngineError::new("unavailable", "Settings are unavailable, so Remote cannot start"))?;
    let agents = app.try_state::<crate::agents::AgentSlot>().ok_or_else(|| EngineError::new("unavailable", "the agent host is not ready yet"))?;
    let (host, data_dir) = (agents.host().clone(), agents.data_dir().to_path_buf());
    let cfg = remote_settings(state);
    let target = relay_target(&cfg, relay_jail());
    let gateway = GatewayCfg {
        mac_name: cfg.get("macName").and_then(|v| v.as_str()).map(str::to_string).unwrap_or_else(mac_name),
        rp_id: target.rp_id.clone(),
        origin: target.origin.clone(),
        relay_host: target.relay_host.clone(),
        reauth_hours: cfg.get("reauthHours").and_then(|v| v.as_u64()).unwrap_or(12).clamp(1, 72),
        bundle_pub: target.bundle_pub.clone(),
        ..GatewayCfg::default()
    };
    let hub = HostHub::new(host, data_dir.clone());
    hub.set_gate(switchhook::gate_of(app));
    let emitter = app.clone();
    let slot = Arc::new(RemoteSlot::new(
        hub.clone(),
        secrets,
        SlotConfig { state_dir: data_dir, gateway, relay_url: target.relay_url, expected_bundle_hash: target.expected_bundle_hash, trust: target.trust, bundle: target.bundle, relay_mode: target.mode },
        Arc::new(move |e| {
            let _ = emitter.emit("remote:event", view_of(e));
        }),
    ));
    let l = Arc::new(Live { slot, hub });
    *lock(&state.live) = Some(l.clone());
    Ok(l)
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn remote_status(app: AppHandle, state: State<'_, RemoteState>) -> Res<RemoteSettingsView> {
    Ok(live(&app, &state)?.slot.settings_view())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfigPatch {
    #[serde(default)]
    relay_url: Option<String>,
    #[serde(default)]
    mac_name: Option<String>,
    #[serde(default)]
    reauth_hours: Option<u64>,
}

/// Persists `macName` and `reauthHours`. The relay URL is not changed here, in any state: there is exactly one live path
/// (`apply_relay`), reached through `remote_apply_local_relay` and the `relay_cloud_*` commands; a `relay_url` is answered
/// with the error `useApply`.
#[tauri::command]
pub fn remote_configure(state: State<'_, RemoteState>, patch: RemoteConfigPatch) -> Res<()> {
    let store = state.settings.as_ref().ok_or_else(|| EngineError::new("unavailable", "Settings are unavailable"))?;
    if patch.relay_url.is_some() {
        return Err(EngineError::new("useApply", "the relay is changed with the apply commands, not with configure"));
    }
    let mut p = serde_json::Map::new();
    if let Some(n) = patch.mac_name {
        p.insert("macName".into(), n.chars().take(60).collect::<String>().into());
    }
    if let Some(h) = patch.reauth_hours {
        p.insert("reauthHours".into(), h.clamp(1, 72).into());
    }
    store.set(NS, p).map_err(|e| EngineError::new(e.code, e.message))?;
    Ok(())
}

#[tauri::command]
pub async fn remote_enable(app: AppHandle, state: State<'_, RemoteState>) -> Res<RemoteSettingsView> {
    let l = live(&app, &state)?;
    let l2 = l.clone();
    tauri::async_runtime::spawn_blocking(move || {
        l2.hub.rebuild_pending();
        l2.slot.enable().map_err(engine)
    })
    .await
    .map_err(|e| engine(e))??;
    Ok(l.slot.settings_view())
}

#[tauri::command]
pub async fn remote_disable(app: AppHandle, state: State<'_, RemoteState>) -> Res<RemoteSettingsView> {
    let l = live(&app, &state)?;
    let l2 = l.clone();
    tauri::async_runtime::spawn_blocking(move || {
        l2.slot.disable();
        l2.hub.stop_worker();
    })
    .await.map_err(|e| engine(e))?;
    Ok(l.slot.settings_view())
}

#[tauri::command]
pub async fn remote_pair_start(app: AppHandle, state: State<'_, RemoteState>) -> Res<OfferView> {
    let l = live(&app, &state)?;
    tauri::async_runtime::spawn_blocking(move || l.slot.pair_start().map_err(engine)).await.map_err(|e| engine(e))?
}

#[tauri::command]
pub fn remote_pair_confirm(app: AppHandle, state: State<'_, RemoteState>, accept: bool, name: Option<String>, capability: Option<Capability>) -> Res<()> {
    // `view` unless the Mac user explicitly picks `reply`
    live(&app, &state)?.slot.pair_confirm(accept, name, capability.unwrap_or(Capability::View));
    Ok(())
}

#[tauri::command]
pub fn remote_pair_cancel(app: AppHandle, state: State<'_, RemoteState>) -> Res<()> {
    live(&app, &state)?.slot.pair_cancel();
    Ok(())
}

#[tauri::command]
pub fn remote_revoke(app: AppHandle, state: State<'_, RemoteState>, id: String) -> Res<bool> {
    live(&app, &state)?.slot.revoke(&id).map_err(engine)
}

#[tauri::command]
pub fn remote_set_capability(app: AppHandle, state: State<'_, RemoteState>, id: String, capability: Capability) -> Res<()> {
    live(&app, &state)?.slot.set_capability(&id, capability).map_err(engine)
}

/// The kill switch: closes every session at once, refuses connections, switches Remote off.
#[tauri::command]
pub async fn remote_kill(app: AppHandle, state: State<'_, RemoteState>) -> Res<RemoteSettingsView> {
    let l = live(&app, &state)?;
    let l2 = l.clone();
    tauri::async_runtime::spawn_blocking(move || {
        l2.slot.kill();
        l2.hub.stop_worker();
    })
    .await.map_err(|e| engine(e))?;
    Ok(l.slot.settings_view())
}

/// Panic / "Lock all" / revoke all: every device revoked, key, room and token rotated, relay room wiped, Remote off.
#[tauri::command]
pub async fn remote_panic(app: AppHandle, state: State<'_, RemoteState>) -> Res<RemoteSettingsView> {
    let l = live(&app, &state)?;
    let l2 = l.clone();
    let r = tauri::async_runtime::spawn_blocking(move || {
        let r = l2.slot.panic().map_err(engine);
        l2.hub.stop_worker();
        r
    })
    .await
    .map_err(|e| engine(e))?;
    r?;
    Ok(l.slot.settings_view())
}

// ---------------------------------------------------------------- live relay change

/// The signed build of a deployed relay (`cloud.bundle`): the hash is the lowercase hex manifest hash, `pubkey` the raw
/// Ed25519 key in base64url.
#[derive(Debug, Clone)]
pub struct BundleRecord {
    pub hash: String,
    pub pubkey: String,
    pub seq: u64,
    pub built_at: u64,
}

/// What `relay_cloud_apply` / `relay_cloud_custom_apply` / `remote_apply_local_relay` hand to [`apply_relay`]. Never exposed
/// as a webview command: the URL comes from a recorded and verified profile, not from the webview.
#[derive(Debug, Clone)]
pub struct ApplyRelayPatch {
    pub relay_url: String,
    /// `local` | `cloudflare` | `custom`.
    pub mode: String,
    pub bundle: Option<BundleRecord>,
    /// A host to add to `trust.allowedHosts` (the user typed it, or this IDE deployed it).
    pub acknowledge_host: Option<String>,
    pub confirm_unpair: bool,
}

/// Blocking (callers use `spawn_blocking`). Order: validate, `needsRepair` when the host changes with phones paired and no
/// confirmation (no side effect), write the settings, `panic` while still connected when the host changes with phones, switch
/// Remote off, set the relay, switch it on again if it was on. A failure after the write restores the previous settings.
pub fn apply_relay(app: &AppHandle, state: &RemoteState, patch: ApplyRelayPatch) -> Res<RemoteSettingsView> {
    let store = state.settings.as_ref().ok_or_else(|| EngineError::new("unavailable", "Settings are unavailable"))?;
    let l = live(app, state)?;
    let old = remote_settings(state);
    let mut p = serde_json::Map::new();
    p.insert("relayUrl".into(), patch.relay_url.clone().into());
    p.insert("relayMode".into(), patch.mode.clone().into());
    if let Some(b) = &patch.bundle {
        let mut cloud = old.get("cloud").and_then(|c| c.as_object()).cloned().unwrap_or_default();
        cloud.insert("bundle".into(), serde_json::json!({"hash": b.hash, "pub": b.pubkey, "seq": b.seq, "builtAt": b.built_at}));
        p.insert("cloud".into(), cloud.into());
    }
    if let Some(h) = &patch.acknowledge_host {
        let parsed = parse_relay(&format!("wss://{h}")).map_err(engine_remote)?;
        let mut hosts: Vec<String> = old.get("trust").and_then(|t| t.get("allowedHosts")).and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).map(str::to_string).collect()).unwrap_or_default();
        if !hosts.iter().any(|x| x.eq_ignore_ascii_case(&parsed.authority())) {
            hosts.push(parsed.authority());
        }
        let mut trust = old.get("trust").and_then(|t| t.as_object()).cloned().unwrap_or_default();
        trust.insert("allowedHosts".into(), hosts.into());
        p.insert("trust".into(), trust.into());
    }
    let mut merged = old.clone();
    for (k, v) in &p {
        merged.insert(k.clone(), v.clone());
    }
    let target = relay_target(&merged, relay_jail());
    let write = |patch: serde_json::Map<String, serde_json::Value>| store.set(NS, patch).map(|_| ()).map_err(|e| RemoteError::Invalid(format!("settings: {}", e.message)));
    let mut persist = || write(p.clone());
    let mut restore = || {
        let back = p.keys().map(|k| (k.clone(), old.get(k).cloned().unwrap_or(serde_json::Value::Null))).collect();
        let _ = write(back);
    };
    let (stop, start) = (|| l.hub.stop_worker(), || l.hub.rebuild_pending());
    l.slot.apply_relay(target, patch.confirm_unpair, ApplyHooks { persist: &mut persist, restore: &mut restore, stop_worker: &stop, start_worker: &start }).map_err(engine_remote)?;
    let _ = app.emit("remote:event", HostEventView::RelayChanged);
    Ok(l.slot.settings_view())
}

/// Local mode: a relay on this machine (`ws://127.0.0.1:<port>`, `localhost`, `[::1]`), applied live. Anything else is
/// refused here and goes through the cloud commands.
#[tauri::command]
pub async fn remote_apply_local_relay(app: AppHandle, _state: State<'_, RemoteState>, url: String, confirm_unpair: bool) -> Res<RemoteSettingsView> {
    if !parse_relay(&url).is_ok_and(|p| p.local) {
        return Err(EngineError::new("hostNotAllowed", "only a relay on this machine can be applied here"));
    }
    let patch = ApplyRelayPatch { relay_url: url, mode: "local".into(), bundle: None, acknowledge_host: None, confirm_unpair };
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || apply_relay(&app2, &app2.state::<RemoteState>(), patch)).await.map_err(engine)?
}

/// "Send my build key to paired phones": live sessions get the signing key now, the others at their next session.
#[tauri::command]
pub fn remote_send_build_key(app: AppHandle, state: State<'_, RemoteState>) -> Res<()> {
    live(&app, &state)?.slot.send_build_key();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct NoHostSink;
    impl intely_agent_host::HostSink for NoHostSink {
        fn events(&self, _: Vec<AgentEvent>) {}
    }

    /// A hub over a real but idle agent host (the sidecar starts with the first run only).
    fn idle_hub(dir: &std::path::Path) -> Arc<HostHub> {
        let cfg = intely_agent_host::HostConfig::new(dir.to_path_buf(), dir.join("no-sidecar.js"), Arc::new(HashMap::new));
        HostHub::new(AgentHost::new(cfg, Arc::new(NoHostSink)), dir.to_path_buf())
    }

    #[test]
    fn a_switch_cancels_what_a_phone_could_still_answer_and_a_late_answer_finds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let hub = idle_hub(dir.path());
        hub.table.register(pending_question("a1", "r1", None, "which branch?", now_ms()));
        hub.table.register(pending_question("a2", "r2", Some("t"), "again?", now_ms()));
        assert_eq!(hub.pending_requests().len(), 2);
        assert_eq!(hub.cancel_pending(), 2);
        assert!(hub.pending_requests().is_empty());
        assert_eq!(hub.cancel_pending(), 0, "twice is harmless");
        let late = hub.answer_question("r1", "a1", QuestionAnswer { option_ids: vec![], text: None }, None, &Origin::Desktop).unwrap_err();
        assert!(matches!(late, HubError::Unknown), "{late:?}");
    }

    #[test]
    fn starting_a_run_from_a_phone_is_rejected_while_the_switching_gate_is_set() {
        use super::super::switchhook::testing::FakeClock;
        let dir = tempfile::tempdir().unwrap();
        let hub = idle_hub(dir.path());
        let gate = SwitchGate::new(Arc::new(FakeClock::new()));
        hub.set_gate(Some(gate.clone()));
        let start = || hub.start_run(StartParams { template_id: "t".into(), params: serde_json::Value::Null }, &Origin::Desktop);
        let before = start().unwrap_err().to_string();
        assert!(!before.contains("workspaceSwitching"), "{before}");
        gate.set().hold();
        let during = start().unwrap_err().to_string();
        assert!(during.contains("workspaceSwitching"), "{during}");
    }

    fn map(v: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn the_default_target_is_the_local_relay_without_a_bundle_or_key() {
        let t = relay_target(&map(json!({})), RelayJail::Off);
        assert_eq!((t.relay_url.as_str(), t.mode.as_str(), t.rp_id.as_str()), (DEFAULT_RELAY, "local", "localhost"));
        assert_eq!(t.relay_host, "127.0.0.1:8787");
        assert!(t.bundle.is_none() && t.bundle_pub.is_none() && t.expected_bundle_hash.is_none());
    }

    #[test]
    fn the_signed_cloud_bundle_beats_the_legacy_hash_only_in_cloudflare_mode() {
        let cfg = json!({"relayUrl": "wss://r.example.workers.dev", "relayMode": "cloudflare", "expectedBundleHash": "dead beef 0000 1111",
            "cloud": {"bundle": {"hash": "a1b2c3d4e5f60718aabbccdd", "pub": "pubpubpub", "seq": 5, "builtAt": 9}}, "trust": {"allowedHosts": ["R.example.workers.dev"]}});
        let t = relay_target(&map(cfg.clone()), RelayJail::Off);
        assert_eq!(t.expected_bundle_hash.as_deref(), Some("a1b2 c3d4 e5f6 0718"));
        assert_eq!(t.bundle_pub.as_deref(), Some("pubpubpub"));
        assert_eq!((t.rp_id.as_str(), t.origin.as_str()), ("r.example.workers.dev", "https://r.example.workers.dev"));
        assert_eq!(t.trust.allowed_hosts, vec!["r.example.workers.dev".to_string()]);
        // back in local mode the cloud bundle no longer applies, the legacy key does
        let mut local = map(cfg);
        local.insert("relayMode".into(), "local".into());
        let t = relay_target(&local, RelayJail::Off);
        assert_eq!(t.expected_bundle_hash.as_deref(), Some("dead beef 0000 1111"));
        assert!(t.bundle_pub.is_none());
    }

    #[test]
    fn a_custom_relay_pins_only_a_well_formed_public_key() {
        let key = "A".repeat(43);
        let t = relay_target(&map(json!({"relayUrl": "wss://c.example", "relayMode": "custom", "custom": {"pubkey": key}})), RelayJail::Off);
        assert_eq!(t.bundle_pub.as_deref(), Some(key.as_str()));
        let t = relay_target(&map(json!({"relayUrl": "wss://c.example", "relayMode": "custom", "custom": {"pubkey": "short"}})), RelayJail::Off);
        assert!(t.bundle_pub.is_none());
    }

    #[test]
    fn relay_client_errors_keep_their_code() {
        let e = engine_remote(RemoteError::Invalid("needsRepair: 2".into()));
        assert_eq!((e.code.as_str(), e.detail.as_deref()), ("needsRepair", Some("2")));
        let e = engine_remote(RemoteError::Invalid("hostNotAllowed: this relay host has not been acknowledged".into()));
        assert_eq!(e.code, "hostNotAllowed");
        let e = engine_remote(RemoteError::Invalid("something else: entirely".into()));
        assert_eq!(e.code, "remote");
    }
}
