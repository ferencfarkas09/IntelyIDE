//! `RemoteSlot`: the lifecycle owner (remote-plan 2.8). Off means off: no thread, socket, timer, task or bus subscriber exists,
//! and constructing the slot touches neither disk nor network. `enable` starts exactly one thread with a current-thread
//! runtime that runs the gateway; `disable` / `kill` / `panic` end it and everything it owns with it.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use intely_agent_core::hub::AgentHub;
use intely_settings::SecretStore;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

use crate::api::*;
use crate::error::{RemoteError, Result};
use crate::gateway::{CoreStatus, GatewayCfg, GatewayCore, HostEvent};
use crate::pairing::OfferView;
use crate::relay_ws::{day_string, RelayStats, RelayTrust, RelayWs};
use crate::runner::{run, Control, RunnerState};
use crate::store::Store;
use crate::transport::Transport;
use crate::util::{Clock, SystemClock};
use crate::wire::Capability;

type HostCallback = Arc<dyn Fn(HostEvent) + Send + Sync>;

pub struct SlotConfig {
    pub state_dir: PathBuf,
    pub gateway: GatewayCfg,
    /// Relay base URL, `wss://relay.example` or `ws://127.0.0.1:8787`.
    pub relay_url: String,
    pub expected_bundle_hash: Option<String>,
    /// Acknowledged hosts and the launch mode; decides which relay URLs `enable` accepts.
    pub trust: RelayTrust,
    pub bundle: Option<BundleView>,
    /// `local` | `cloudflare` | `custom` (empty reads as `local`).
    pub relay_mode: String,
}

/// Everything that changes when the relay changes. Built by one parser in the Tauri layer (`relay_target`), applied live by
/// [`RemoteSlot::set_relay`] / [`RemoteSlot::apply_relay`].
#[derive(Clone, Debug)]
pub struct RelayConfig {
    pub relay_url: String,
    /// What the QR shows: `host[:port]`.
    pub relay_host: String,
    pub rp_id: String,
    pub origin: String,
    pub expected_bundle_hash: Option<String>,
    pub bundle: Option<BundleView>,
    /// Raw Ed25519 build key (base64url) sent to phones as `welcome`.
    pub bundle_pub: Option<String>,
    pub trust: RelayTrust,
    pub mode: String,
}

/// Callbacks of [`RemoteSlot::apply_relay`] for the parts this crate does not own (settings file, agent hub worker).
pub struct ApplyHooks<'a> {
    /// Writes the new relay keys to the settings. An error aborts before anything irreversible happens.
    pub persist: &'a mut dyn FnMut() -> Result<()>,
    /// Puts the previous settings back after a later step failed.
    pub restore: &'a mut dyn FnMut(),
    /// Ends the hub worker (called after Remote was switched off).
    pub stop_worker: &'a dyn Fn(),
    /// Rebuilds the pending requests (called before Remote is switched on again).
    pub start_worker: &'a dyn Fn(),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApplyOutcome {
    pub host_changed: bool,
    /// Phones were unpaired (panic ran) because the host changed.
    pub unpaired: bool,
    pub was_on: bool,
}

struct Running {
    ctl: UnboundedSender<Control>,
    thread: JoinHandle<()>,
    status: Arc<Mutex<CoreStatus>>,
    runner: Arc<RunnerState>,
}

#[derive(Default)]
struct View {
    offer: Option<OfferView>,
    sas: Option<SasView>,
    tampered: Option<String>,
}

pub struct RemoteSlot {
    hub: Arc<dyn AgentHub>,
    secrets: Arc<dyn SecretStore>,
    clock: Arc<dyn Clock>,
    cfg: Mutex<SlotConfig>,
    host: HostCallback,
    running: Mutex<Option<Running>>,
    store: Mutex<Option<Arc<Store>>>,
    view: Arc<Mutex<View>>,
    stats: Mutex<Arc<RelayStats>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl RemoteSlot {
    /// Cheap and inert: no I/O, no thread.
    pub fn new(hub: Arc<dyn AgentHub>, secrets: Arc<dyn SecretStore>, cfg: SlotConfig, on_host_event: HostCallback) -> Self {
        Self { hub, secrets, clock: Arc::new(SystemClock), cfg: Mutex::new(cfg), host: on_host_event, running: Mutex::new(None), store: Mutex::new(None), view: Arc::new(Mutex::new(View::default())), stats: Mutex::new(Arc::new(RelayStats::default())) }
    }

    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    pub fn is_on(&self) -> bool {
        lock(&self.running).as_ref().is_some_and(|r| r.runner.running.load(Ordering::SeqCst) || !r.thread.is_finished())
    }

    /// Opens (once) the persistent state. A tamper finding is remembered and reported, never repaired.
    pub fn store(&self) -> Result<Arc<Store>> {
        let mut g = lock(&self.store);
        if let Some(s) = g.as_ref() {
            return Ok(s.clone());
        }
        let dir = lock(&self.cfg).state_dir.clone();
        match Store::open(&dir, self.secrets.clone(), self.clock.clone()) {
            Ok(s) => {
                lock(&self.view).tampered = None;
                *g = Some(s.clone());
                Ok(s)
            }
            Err(e) => {
                if matches!(e, RemoteError::Tampered(_)) {
                    lock(&self.view).tampered = Some(e.to_string());
                }
                Err(e)
            }
        }
    }

    /// Starts the production transport.
    pub fn enable(&self) -> Result<()> {
        let (url, trust) = {
            let c = lock(&self.cfg);
            (c.relay_url.clone(), c.trust.clone())
        };
        let stats = lock(&self.stats).clone();
        self.enable_with(Box::new(RelayWs::new_with(&url, &trust)?.with_stats(stats)))
    }

    /// Frames the Mac sent today (UTC day number, count); see [`RelayStats`].
    pub fn frames_today(&self) -> (u64, u64) {
        lock(&self.stats).frames_today()
    }

    fn current_relay(&self) -> RelayConfig {
        let c = lock(&self.cfg);
        RelayConfig {
            relay_url: c.relay_url.clone(),
            relay_host: c.gateway.relay_host.clone(),
            rp_id: c.gateway.rp_id.clone(),
            origin: c.gateway.origin.clone(),
            expected_bundle_hash: c.expected_bundle_hash.clone(),
            bundle: c.bundle.clone(),
            bundle_pub: c.gateway.bundle_pub.clone(),
            trust: c.trust.clone(),
            mode: c.relay_mode.clone(),
        }
    }

    /// Switches the relay while Remote is off. Fails with `busy` while it runs (use [`apply_relay`](Self::apply_relay)),
    /// with the URL rules of [`RelayWs::new_with`], and with `qrBudget` when the pairing QR for this host would not fit.
    pub fn set_relay(&self, cfg: RelayConfig) -> Result<()> {
        if self.is_on() {
            return Err(RemoteError::Invalid("busy: Remote is on; switch it off to change the relay".into()));
        }
        RelayWs::new_with(&cfg.relay_url, &cfg.trust)?;
        if !crate::pairing::qr_fits(&cfg.relay_host) {
            return Err(RemoteError::Invalid("qrBudget: the pairing QR for this host name would not fit".into()));
        }
        {
            let mut c = lock(&self.cfg);
            c.relay_url = cfg.relay_url;
            c.expected_bundle_hash = cfg.expected_bundle_hash;
            c.bundle = cfg.bundle;
            c.trust = cfg.trust;
            c.relay_mode = cfg.mode;
            c.gateway.relay_host = cfg.relay_host;
            c.gateway.rp_id = cfg.rp_id;
            c.gateway.origin = cfg.origin;
            c.gateway.bundle_pub = cfg.bundle_pub;
        }
        // the counter belongs to the relay (and its daily cap) it was counted on
        *lock(&self.stats) = Arc::new(RelayStats::default());
        let mut v = lock(&self.view);
        v.offer = None;
        v.sas = None;
        Ok(())
    }

    /// The one live path for a relay change ((design notes: remote-cloudflare-spec) 4.2): validate, refuse with `needsRepair: <n>` when
    /// the host changes while `n` phones are paired and `confirm_unpair` is false (no side effect), write the settings, run
    /// `panic` while still connected when the host changes with devices (the old room is wiped), switch Remote off, set the
    /// relay, switch it on again if it was on. A failure after the settings were written restores them and the previous relay.
    pub fn apply_relay(&self, target: RelayConfig, confirm_unpair: bool, hooks: ApplyHooks<'_>) -> Result<ApplyOutcome> {
        RelayWs::new_with(&target.relay_url, &target.trust)?;
        if !crate::pairing::qr_fits(&target.relay_host) {
            return Err(RemoteError::Invalid("qrBudget: the pairing QR for this host name would not fit".into()));
        }
        let old = self.current_relay();
        let host_changed = old.rp_id != target.rp_id;
        let devices = self.store_if_present().map_or(0, |s| s.devices().len());
        if host_changed && devices > 0 && !confirm_unpair {
            return Err(RemoteError::Invalid(format!("needsRepair: {devices}")));
        }
        (hooks.persist)()?;
        let was_on = self.is_on();
        let mut unpaired = false;
        if host_changed && devices > 0 {
            if let Err(e) = self.panic() {
                (hooks.restore)();
                return Err(e);
            }
            unpaired = true;
        }
        self.disable();
        (hooks.stop_worker)();
        if let Err(e) = self.set_relay(target) {
            (hooks.restore)();
            return Err(e);
        }
        if was_on {
            (hooks.start_worker)();
            if let Err(e) = self.enable() {
                let _ = self.set_relay(old);
                (hooks.restore)();
                return Err(e);
            }
        }
        Ok(ApplyOutcome { host_changed, unpaired, was_on })
    }

    /// "Send my build key to paired phones": every live session gets `welcome` now, the others at their next session.
    pub fn send_build_key(&self) {
        self.send(Control::SendWelcome);
    }

    pub fn enable_with(&self, transport: Box<dyn Transport>) -> Result<()> {
        let mut running = lock(&self.running);
        if running.as_ref().is_some_and(|r| !r.thread.is_finished()) {
            return Ok(());
        }
        let store = self.store()?;
        let gateway = lock(&self.cfg).gateway.clone();
        let (ctl, ctl_rx) = unbounded_channel();
        let runner = Arc::new(RunnerState::default());
        let status = Arc::new(Mutex::new(CoreStatus::default()));
        let (hub, host, view) = (self.hub.clone(), self.host.clone(), self.view.clone());
        let (st, rn, status2) = (store.clone(), runner.clone(), status.clone());
        let host2: HostCallback = Arc::new(move |e: HostEvent| {
            {
                let mut v = lock(&view);
                match &e {
                    HostEvent::PairingSas { code, device_hint } => v.sas = Some(SasView { code: code.clone(), device_name: device_hint.clone() }),
                    HostEvent::PairingEnded { .. } => {
                        v.sas = None;
                        v.offer = None;
                    }
                    HostEvent::Tampered(m) => v.tampered = Some(m.clone()),
                    _ => {}
                }
            }
            host(e);
        });
        let thread = std::thread::Builder::new()
            .name("intely-remote".into())
            .spawn(move || {
                let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() else { return };
                let identity = st.identity();
                let bus = hub.bus();
                let mut core = GatewayCore::new(gateway, hub, st);
                core.status = status2; // the slot reads the core's own status handle
                rt.block_on(run(core, bus, transport, identity, ctl_rx, host2, rn));
            })
            .map_err(RemoteError::Io)?;
        *running = Some(Running { ctl, thread, status, runner });
        Ok(())
    }

    fn stop_thread(&self) {
        let r = lock(&self.running).take();
        if let Some(r) = r {
            let _ = r.ctl.send(Control::Shutdown);
            let _ = r.thread.join();
        }
        let mut v = lock(&self.view);
        v.offer = None;
        v.sas = None;
    }

    /// Switches Remote off: the thread, the transport socket and the bus subscriber are gone when this returns.
    pub fn disable(&self) {
        self.stop_thread();
    }

    fn ask<T>(&self, make: impl FnOnce(std::sync::mpsc::SyncSender<T>) -> Control) -> Result<T> {
        let (tx, rx) = sync_channel(1);
        {
            let g = lock(&self.running);
            let r = g.as_ref().ok_or_else(|| RemoteError::Invalid("Remote is off".into()))?;
            r.ctl.send(make(tx)).map_err(|_| RemoteError::Invalid("Remote is not running".into()))?;
        }
        rx.recv_timeout(Duration::from_secs(5)).map_err(|_| RemoteError::Invalid("Remote did not answer".into()))
    }

    fn send(&self, c: Control) {
        if let Some(r) = lock(&self.running).as_ref() {
            let _ = r.ctl.send(c);
        }
    }

    pub fn pair_start(&self) -> Result<OfferView> {
        let offer = self.ask(Control::PairStart)?;
        lock(&self.view).offer = Some(offer.clone());
        Ok(offer)
    }

    pub fn pair_confirm(&self, accept: bool, name: Option<String>, capability: Capability) {
        self.send(Control::PairConfirm { accept, name, capability });
    }

    pub fn pair_cancel(&self) {
        self.send(Control::PairCancel);
    }

    /// Revoke one device: effective locally at once (registry), the live socket drops on the next loop turn.
    pub fn revoke(&self, id: &str) -> Result<bool> {
        let removed = self.store()?.revoke(id, "revoked on the Mac")?;
        self.send(Control::RegistryChanged);
        Ok(removed)
    }

    pub fn set_capability(&self, id: &str, cap: Capability) -> Result<()> {
        self.store()?.set_capability(id, cap)?;
        self.send(Control::CapabilityChanged(id.to_string()));
        Ok(())
    }

    /// Kill switch: close every session, refuse connections, switch Remote off.
    pub fn kill(&self) {
        let _ = self.ask(Control::Kill);
        self.stop_thread();
    }

    /// Panic / "Lock all" / revoke-all: revokes every device, rotates key, room and token, wipes the relay room and switches
    /// Remote off. Works when Remote is already off (the registry and identity are rewritten, nothing else happens).
    pub fn panic(&self) -> Result<()> {
        if self.is_on() {
            let _ = self.ask(Control::Panic);
            self.stop_thread();
            Ok(())
        } else {
            let store = self.store()?;
            store.revoke_all("panic while Remote was off")?;
            self.hub.disable_claude_remote_control();
            Ok(())
        }
    }

    /// The store only if it exists already (open, or files on disk): looking at Settings while Remote was never used must not
    /// create keys, Keychain items or files.
    fn store_if_present(&self) -> Option<Arc<Store>> {
        if lock(&self.store).is_none() {
            let dir = lock(&self.cfg).state_dir.clone();
            if !crate::devices::DeviceRegistry::path_in(&dir).exists() && !crate::audit::AuditLog::path_in(&dir).exists() {
                return None;
            }
        }
        self.store().ok()
    }

    pub fn settings_view(&self) -> RemoteSettingsView {
        let (state, status) = {
            let g = lock(&self.running);
            match g.as_ref() {
                Some(r) if !r.thread.is_finished() => (if r.runner.online.load(Ordering::SeqCst) { RemoteState::Online } else { RemoteState::Connecting }, lock(&r.status).clone()),
                _ => (RemoteState::Off, CoreStatus::default()),
            }
        };
        let (relay, expected_bundle_hash, reauth_hours, mac_name, relay_mode, relay_host_allowed, bundle) = {
            let c = lock(&self.cfg);
            let mode = if c.relay_mode.is_empty() { "local".to_string() } else { c.relay_mode.clone() };
            (c.relay_url.clone(), c.expected_bundle_hash.clone(), c.gateway.reauth_hours as u32, c.gateway.mac_name.clone(), mode, RelayWs::new_with(&c.relay_url, &c.trust).is_ok(), c.bundle.clone())
        };
        let stats = lock(&self.stats).clone();
        let (day, frames_sent) = stats.frames_today();
        let now = self.clock.now_ms();
        let store = self.store_if_present();
        let tampered = lock(&self.view).tampered.clone();
        let devices = store
            .as_ref()
            .map(|s| {
                s.devices()
                    .into_iter()
                    .map(|d| DeviceView {
                        reauth_required: crate::limits::effective_capability(&d, now, reauth_hours as u64) != d.capability,
                        has_passkey: d.passkey.is_some(),
                        connected: status.sessions.iter().any(|(id, _)| *id == d.id),
                        id: d.id,
                        name: d.name,
                        capability: d.capability,
                        created_at: d.created_at,
                        last_seen_at: d.last_seen_at,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let v = lock(&self.view);
        RemoteSettingsView {
            state: if tampered.is_some() { RemoteState::Tampered } else { state },
            tampered,
            relay,
            mac_name,
            devices,
            pairing: PairingView { offer: v.offer.clone().filter(|o| status.offer_expires_at.is_some() || o.expires_at > now), sas: v.sas.clone() },
            audit: store.as_ref().map(|s| s.audit_tail(20)).unwrap_or_default(),
            audit_len: store.as_ref().map_or(0, |s| s.audit_len()),
            reauth_hours,
            expected_bundle_hash,
            claude_remote_control: "blocked".into(),
            e2e_note: E2E_NOTE.into(),
            relay_mode,
            relay_host_allowed,
            bundle,
            relay_stats: RelayStatsView { day: day_string(day), frames_sent, consecutive_failures: stats.consecutive_failures(), last_error: stats.last_error() },
        }
    }
}

impl Drop for RemoteSlot {
    fn drop(&mut self) {
        self.stop_thread();
    }
}
