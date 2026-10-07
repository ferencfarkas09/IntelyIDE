//! The gateway core: a synchronous, deterministic state machine (frames in, frames out). It owns no socket, task or timer, so
//! tests drive it frame by frame with an injected clock, and the async runner (`runner.rs`) is a thin loop around it. It
//! consumes `AgentHub` / `EventLog` / `EventBus` and enforces, for every phone message, the capability, rate, step-up and
//! eligibility rules of remote-plan section 4 before anything reaches the hub.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use intely_agent_core::api::{AgentSummary, PermissionDecision, QuestionAnswer, RunStatus};
use intely_agent_core::events::{AgentEvent, DecidedBy, EventKind, PermissionOutcome, StopReason};
use intely_agent_core::hub::{AgentHub, Eligibility, HubError, Origin, PendingKind, PendingRequest, Risk, StartParams};
use intely_agent_core::projection::RunProjection;
use intely_agent_core::providers::PermissionMode;

use crate::audit::Record;
use crate::devices::{Device, Passkey, DEFAULT_REAUTH_HOURS};
use crate::limits::{effective_capability, Bucket, DeviceLimits, RateVerdict, PENDING_PER_RUN};
use crate::noise::{framed, tag, Handshake, Kind, Transport};
use crate::pairing::{offer_view, Offer, OfferView, CONFIRM_TIMEOUT_MS, HELLO_TIMEOUT_MS, MAX_FAILED_ATTEMPTS};
use crate::policy::{eligibility, parse_prompt_step_up_key, prompt_step_up_key, verdict, LowList, RemoteAction, Verdict};
use crate::redact::{display, wire_intent, Redactor};
use crate::stepup::{parse_public_key, verify, Challenge};
use crate::store::Store;
use crate::transport::{Admin, LinkId, NotifyKind};
use crate::util::{sha256_hex, Clock};
use crate::wire::*;

const MAX_LINKS: usize = 16;
const TAIL_EVENTS: usize = 50;
const CATCH_UP_BATCH: usize = 400;
const MAX_BAD_FRAMES: u32 = 5;
const REPUSH_MS: u64 = 10 * 60_000;
const AUDIT_BUDGET_PER_MIN: u32 = 20;
const MAX_PROMPT_CHARS: usize = 8000;

#[derive(Debug, Clone)]
pub struct GatewayCfg {
    pub mac_name: String,
    /// WebAuthn relying-party id and origin of the PWA (the relay hostname).
    pub rp_id: String,
    pub origin: String,
    /// What the QR shows as relay host.
    pub relay_host: String,
    pub reauth_hours: u64,
    pub low_list: LowList,
    /// A reconnect must arrive on the link named like the device (true with the relay, which authenticates the id).
    pub strict_link_ids: bool,
    /// The Mac's build-signing public key (raw Ed25519, base64url); sent to phones as `welcome` so they can pin it.
    pub bundle_pub: Option<String>,
}

impl Default for GatewayCfg {
    fn default() -> Self {
        Self { mac_name: "My Mac".into(), rp_id: "localhost".into(), origin: "http://localhost".into(), relay_host: "localhost".into(), reauth_hours: DEFAULT_REAUTH_HOURS, low_list: LowList::default(), strict_link_ids: true, bundle_pub: None }
    }
}

/// Things the Mac UI should hear about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostEvent {
    /// The phone proved the one-time code: show these 6 digits and ask whether they match.
    PairingSas { code: String, device_hint: String },
    PairingEnded { outcome: String },
    DevicesChanged,
    /// A device was demoted to view-only after repeated rate-limit hits.
    Anomaly { device_id: String },
    Tampered(String),
    /// A pending ask has waited 10 minutes: the Mac may re-notify.
    NeedsYouAging,
}

#[derive(Debug)]
pub enum Out {
    Frame { link: LinkId, bytes: Vec<u8> },
    Admin(Admin),
    Close(LinkId),
    Host(HostEvent),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CoreStatus {
    pub enabled: bool,
    pub links: usize,
    pub sessions: Vec<(String, bool)>,
    pub offer_expires_at: Option<u64>,
    pub awaiting_confirm: Option<(String, String)>,
}

struct Session {
    device_id: String,
    transport: Transport,
    synced: bool,
    sent: HashMap<String, u64>,
    announced: HashSet<String>,
    bad: u32,
}

enum Link {
    PairWait { transport: Transport, sas: String, phone_static: [u8; 32], since: u64 },
    PairAwait { transport: Transport, sas: String, phone_static: [u8; 32], name: String, passkey: Option<Passkey>, since: u64 },
    Session(Session),
}

struct AnswerArgs {
    op_id: String,
    req_id: String,
    agent_id: String,
    decision: Option<PermissionDecision>,
    question: Option<QuestionAnswer>,
    intent_hash: Option<String>,
    step_up: Option<StepUpProof>,
}

pub struct GatewayCore {
    cfg: GatewayCfg,
    hub: Arc<dyn AgentHub>,
    store: Arc<Store>,
    clock: Arc<dyn Clock>,
    enabled: bool,
    links: HashMap<LinkId, Link>,
    offer: Option<Offer>,
    limits: HashMap<String, DeviceLimits>,
    redactor: Redactor,
    projections: HashMap<String, RunProjection>,
    questions: HashMap<String, (String, Vec<String>)>,
    challenges: HashMap<(String, String), (Challenge, String)>,
    revoked_links: VecDeque<(LinkId, String)>,
    strikes: HashMap<LinkId, u32>,
    first_seen: HashMap<String, u64>,
    repushed: HashSet<String>,
    audit_window: (u64, u32),
    last_ack: Option<Vec<u8>>,
    last_verify: u64,
    reset_sent: HashMap<LinkId, u64>,
    pub status: Arc<Mutex<CoreStatus>>,
}

fn risk_str(r: Risk) -> &'static str {
    match r {
        Risk::Low => "low",
        Risk::Medium => "medium",
        Risk::High => "high",
        Risk::Blocked => "blocked",
    }
}

impl GatewayCore {
    pub fn new(cfg: GatewayCfg, hub: Arc<dyn AgentHub>, store: Arc<Store>) -> Self {
        let clock = store.clock.clone();
        let core = Self {
            cfg,
            hub,
            store,
            clock,
            enabled: true,
            links: HashMap::new(),
            offer: None,
            limits: HashMap::new(),
            redactor: Redactor::new(),
            projections: HashMap::new(),
            questions: HashMap::new(),
            challenges: HashMap::new(),
            revoked_links: VecDeque::new(),
            strikes: HashMap::new(),
            first_seen: HashMap::new(),
            repushed: HashSet::new(),
            audit_window: (0, 0),
            last_ack: None,
            last_verify: 0,
            reset_sent: HashMap::new(),
            status: Arc::new(Mutex::new(CoreStatus { enabled: true, ..CoreStatus::default() })),
        };
        core.store.audit(Record::new("remote.started"));
        core
    }

    fn now(&self) -> u64 {
        self.clock.now_ms()
    }

    fn refresh_status(&self) {
        let mut sessions: Vec<(String, bool)> = self.links.values().filter_map(|l| if let Link::Session(s) = l { Some((s.device_id.clone(), s.synced)) } else { None }).collect();
        sessions.sort();
        let awaiting = self.links.values().find_map(|l| if let Link::PairAwait { sas, name, .. } = l { Some((sas.clone(), name.clone())) } else { None });
        let mut st = self.status.lock().unwrap_or_else(|p| p.into_inner());
        *st = CoreStatus { enabled: self.enabled, links: self.links.len(), sessions, offer_expires_at: self.offer.as_ref().map(|o| o.expires_at), awaiting_confirm: awaiting };
    }

    /// Audits an unauthenticated-input rejection with a budget, so garbage cannot flood the log.
    fn audit_limited(&mut self, rec: Record<'_>) {
        let now = self.now();
        if now.saturating_sub(self.audit_window.0) >= 60_000 {
            self.audit_window = (now, 0);
        }
        if self.audit_window.1 < AUDIT_BUDGET_PER_MIN {
            self.audit_window.1 += 1;
            self.store.audit(rec);
        } else if self.audit_window.1 == AUDIT_BUDGET_PER_MIN {
            self.audit_window.1 += 1;
            self.store.audit(Record::new("audit.suppressed").detail("further rejected frames this minute are not logged"));
        }
    }

    // ---------------------------------------------------------------- pairing

    /// Starts a pairing: the Mac user clicked "Pair device".
    pub fn pair_start(&mut self) -> (OfferView, Vec<Out>) {
        let otp = crate::noise::new_otp();
        let offer = Offer::new(otp, self.now());
        let view = offer_view(&offer, &self.store.identity(), &self.cfg.relay_host);
        let outs = vec![Out::Admin(Admin::PairOpen { hash: offer.relay_token_hash(), ttl_ms: crate::pairing::OFFER_TTL_MS })];
        self.offer = Some(offer);
        self.store.audit(Record::new("pairing.started"));
        self.refresh_status();
        (view, outs)
    }

    pub fn pair_cancel(&mut self) -> Vec<Out> {
        let mut outs = Vec::new();
        self.end_pairing("cancelled", &mut outs);
        outs
    }

    fn end_pairing(&mut self, outcome: &str, outs: &mut Vec<Out>) {
        let had = self.offer.take().is_some();
        let pair_links: Vec<LinkId> = self.links.iter().filter(|(_, l)| matches!(l, Link::PairWait { .. } | Link::PairAwait { .. })).map(|(k, _)| k.clone()).collect();
        for l in &pair_links {
            self.links.remove(l);
            outs.push(Out::Close(l.clone()));
        }
        if had || !pair_links.is_empty() {
            self.store.audit(Record::new("pairing.ended").detail(outcome));
            outs.push(Out::Host(HostEvent::PairingEnded { outcome: outcome.into() }));
        }
        self.refresh_status();
    }

    /// The Mac user pressed "Codes match" (or "Don't match") and picked the name and capability.
    pub fn pair_confirm(&mut self, accept: bool, name: Option<String>, capability: Capability) -> Vec<Out> {
        let mut outs = Vec::new();
        let Some(link) = self.links.iter().find(|(_, l)| matches!(l, Link::PairAwait { .. })).map(|(k, _)| k.clone()) else { return outs };
        let Some(Link::PairAwait { transport, phone_static, name: hint, passkey, .. }) = self.links.remove(&link) else { return outs };
        self.links.insert(link.clone(), Link::PairWait { transport, sas: String::new(), phone_static, since: 0 }); // placeholder so push_msg finds the transport
        if !accept {
            self.send_pair_reply(&link, &PairReply::Rejected { reason: "The codes did not match, or the Mac user declined.".into() }, &mut outs);
            self.store.audit(Record::new("pairing.declined").detail("codes did not match or declined"));
            self.end_pairing("declined", &mut outs);
            return outs;
        }
        let id = crate::devices::DeviceRegistry::new_device_id();
        let token = crate::devices::DeviceRegistry::new_device_token();
        let now = self.now();
        let device = Device {
            id: id.clone(),
            name: display(name.as_deref().unwrap_or(&hint), 40),
            static_pub: hex::encode(phone_static),
            passkey,
            capability,
            created_at: now,
            last_seen_at: now,
            last_reauth_at: now,
            token_hash: sha256_hex(token.as_bytes()),
            push_endpoint_hash: None,
            pinned: self.cfg.bundle_pub.is_some(),
        };
        let hash = device.token_hash.clone();
        match self.store.with_registry(|r| r.add(device)) {
            Ok(()) => {
                // the relay must know the device before the phone reconnects with its token
                outs.push(Out::Admin(Admin::DevAdd { id: id.clone(), hash }));
                if let Some(bundle_pub) = self.cfg.bundle_pub.clone() {
                    self.send_pair_reply(&link, &PairReply::Welcome { bundle_pub }, &mut outs);
                }
                self.send_pair_reply(&link, &PairReply::Accepted { device_id: id.clone(), device_token: token, capability, mac_name: self.cfg.mac_name.clone() }, &mut outs);
                self.store.audit(Record::new("pairing.accepted").device(&id).detail(if capability == Capability::Reply { "reply" } else { "view" }));
                outs.push(Out::Host(HostEvent::DevicesChanged));
                self.end_pairing("accepted", &mut outs);
            }
            Err(e) => {
                self.send_pair_reply(&link, &PairReply::Rejected { reason: e.to_string() }, &mut outs);
                self.end_pairing("failed", &mut outs);
            }
        }
        outs
    }

    fn send_pair_reply(&mut self, link: &str, reply: &PairReply, outs: &mut Vec<Out>) {
        let bytes = encode_pair_reply(reply);
        let t = match self.links.get_mut(link) {
            Some(Link::PairWait { transport, .. }) | Some(Link::PairAwait { transport, .. }) => transport,
            _ => return,
        };
        if let Ok(ct) = t.encrypt(&bytes) {
            outs.push(Out::Frame { link: link.into(), bytes: framed(tag::DATA, &ct) });
        }
    }

    fn on_pair_init(&mut self, link: &str, body: &[u8], outs: &mut Vec<Out>) {
        let now = self.now();
        let psk = match self.offer.as_mut() {
            Some(o) if now < o.expires_at && o.failed < MAX_FAILED_ATTEMPTS && o.active.as_ref().is_none_or(|(_, t)| now.saturating_sub(*t) >= HELLO_TIMEOUT_MS) => {
                o.active = Some((link.to_string(), now));
                o.psk()
            }
            _ => {
                self.audit_limited(Record::new("pairing.rejected").detail("no open offer for this attempt"));
                return;
            }
        };
        let result = (|| -> crate::error::Result<(Transport, String, [u8; 32])> {
            let mut hs = Handshake::responder(Kind::Pairing, &self.store.identity().static_key, Some(&psk))?;
            hs.read(body)?;
            let phone = hs.remote_static().ok_or_else(|| crate::error::RemoteError::Noise("no static key".into()))?;
            let msg2 = hs.write(&[])?;
            let sas = hs.sas();
            outs.push(Out::Frame { link: link.into(), bytes: framed(tag::PAIR_RESP, &msg2) });
            Ok((hs.into_transport()?, sas, phone))
        })();
        match result {
            Ok((transport, sas, phone_static)) => {
                self.links.insert(link.to_string(), Link::PairWait { transport, sas, phone_static, since: now });
            }
            Err(_) => {
                outs.retain(|o| !matches!(o, Out::Frame { link: l, .. } if l == link));
                self.fail_pair_attempt(link, outs);
            }
        }
        self.refresh_status();
    }

    fn fail_pair_attempt(&mut self, link: &str, outs: &mut Vec<Out>) {
        self.links.remove(link);
        let burned = match self.offer.as_mut() {
            Some(o) => {
                o.failed += 1;
                o.active = None;
                o.failed >= MAX_FAILED_ATTEMPTS
            }
            None => false,
        };
        self.audit_limited(Record::new("pairing.failedAttempt").detail("handshake or code proof failed"));
        if burned {
            self.end_pairing("tooManyFailures", outs);
        }
    }

    fn on_pair_data(&mut self, link: &str, body: &[u8], outs: &mut Vec<Out>) {
        let now = self.now();
        let Some(l) = self.links.get_mut(link) else { return };
        match l {
            Link::PairWait { transport, sas, phone_static, .. } => {
                let plain = transport.decrypt(body);
                let hello = plain.ok().and_then(|p| decode_pair(&p).ok());
                let Some(PairMsg::Hello { name }) = hello else {
                    self.fail_pair_attempt(link, outs);
                    return;
                };
                // the phone proved the PSK: the offer is spent (single use)
                let (sas, phone_static) = (sas.clone(), *phone_static);
                let Some(Link::PairWait { transport, .. }) = self.links.remove(link) else { return };
                self.offer = None;
                let name = display(&name, 40);
                self.links.insert(link.to_string(), Link::PairAwait { transport, sas: sas.clone(), phone_static, name: name.clone(), passkey: None, since: now });
                self.store.audit(Record::new("pairing.codeProven").detail(&format!("device name: {name}")));
                outs.push(Out::Host(HostEvent::PairingSas { code: sas, device_hint: name }));
            }
            Link::PairAwait { transport, passkey, .. } => {
                let Ok(plain) = transport.decrypt(body) else { return };
                if let Ok(PairMsg::PasskeyRegister { credential_id, public_key }) = decode_pair(&plain) {
                    if let Some(point) = parse_public_key(&public_key) {
                        *passkey = Some(Passkey { credential_id: credential_id.chars().take(256).collect(), public_key: hex::encode(point), counter: 0 });
                    }
                }
            }
            Link::Session(_) => {}
        }
        self.refresh_status();
    }

    // ---------------------------------------------------------------- reconnect sessions

    fn on_ik_init(&mut self, link: &str, body: &[u8], outs: &mut Vec<Out>) {
        if self.links.len() >= MAX_LINKS && !self.links.contains_key(link) {
            return;
        }
        let ident = self.store.identity();
        let mut hs = match Handshake::responder(Kind::Reconnect, &ident.static_key, None) {
            Ok(h) => h,
            Err(_) => return,
        };
        if hs.read(body).is_err() {
            self.bump_strike(link, outs);
            self.audit_limited(Record::new("ik.rejected").detail("handshake did not authenticate"));
            return;
        }
        let Some(phone) = hs.remote_static() else { return };
        let Some(dev) = self.store.device_by_static(&phone) else {
            self.audit_limited(Record::new("ik.rejected").detail("unknown or revoked device key"));
            return;
        };
        if self.cfg.strict_link_ids && dev.id != link {
            self.audit_limited(Record::new("ik.rejected").device(&dev.id).detail("device key arrived on another link"));
            return;
        }
        let msg2 = match hs.write(&[]).and_then(|m| hs.into_transport().map(|t| (m, t))) {
            Ok(x) => x,
            Err(_) => return,
        };
        outs.push(Out::Frame { link: link.into(), bytes: framed(tag::IK_RESP, &msg2.0) });
        self.links.insert(link.to_string(), Link::Session(Session { device_id: dev.id.clone(), transport: msg2.1, synced: false, sent: HashMap::new(), announced: HashSet::new(), bad: 0 }));
        let now = self.now();
        self.store.with_registry(|r| r.touch(&dev.id, now));
        self.store.audit(Record::new("session.opened").device(&dev.id));
        // first message: who you are and what you may do
        let (cap, reauth) = self.cap_of(&dev);
        self.push_msg(link, &ServerMsg::Hello { capability: cap, device_id: dev.id.clone(), mac_name: self.cfg.mac_name.clone(), reauth_required: reauth }, outs);
        if let Some(bundle_pub) = self.cfg.bundle_pub.clone() {
            self.push_msg(link, &ServerMsg::Welcome { bundle_pub }, outs);
            self.store.with_registry(|r| r.mark_pinned(&dev.id));
        }
        let snap = self.snapshot(&dev, cap);
        self.push_msg(link, &snap, outs);
        self.refresh_status();
    }

    fn cap_of(&self, d: &Device) -> (Capability, bool) {
        let eff = effective_capability(d, self.now(), self.cfg.reauth_hours);
        (eff, eff != d.capability)
    }

    fn bump_strike(&mut self, link: &str, outs: &mut Vec<Out>) {
        let n = self.strikes.entry(link.to_string()).or_insert(0);
        *n += 1;
        if *n >= MAX_BAD_FRAMES {
            self.strikes.remove(link);
            self.links.remove(link);
            outs.push(Out::Close(link.into()));
        }
    }

    // ---------------------------------------------------------------- frames in

    pub fn on_frame(&mut self, link: &str, frame: &[u8]) -> Vec<Out> {
        let mut outs = Vec::new();
        if !self.enabled || frame.len() < 2 {
            return outs;
        }
        let (t, body) = (frame[0], &frame[1..]);
        match t {
            tag::PAIR_INIT => self.on_pair_init(link, body, &mut outs),
            tag::IK_INIT => self.on_ik_init(link, body, &mut outs),
            tag::DATA => self.on_data(link, body, &mut outs),
            _ => {
                self.bump_strike(link, &mut outs);
                self.audit_limited(Record::new("frame.rejected").detail("unknown frame tag"));
            }
        }
        self.sweep_revoked(&mut outs);
        self.refresh_status();
        outs
    }

    fn on_data(&mut self, link: &str, body: &[u8], outs: &mut Vec<Out>) {
        match self.links.get(link) {
            Some(Link::PairWait { .. }) | Some(Link::PairAwait { .. }) => return self.on_pair_data(link, body, outs),
            Some(Link::Session(_)) => {}
            None => {
                // data for a session we dropped: a revoked device is told nothing and the attempt is recorded
                if let Some((_, dev)) = self.revoked_links.iter().find(|(l, _)| l == link).cloned() {
                    self.audit_limited(Record::new("rejected.revoked").device(&dev).detail("frame from a revoked device"));
                    return;
                }
                // not revoked, just unknown (the Mac restarted, or the session was dropped): tell the phone to redo the handshake,
                // at most once every 5 s per link, and only to a registered device id so strangers get no reply
                let now = self.now();
                if self.store.device(link).is_some() && now.saturating_sub(self.reset_sent.get(link).copied().unwrap_or(0)) >= 5_000 {
                    self.reset_sent.insert(link.to_string(), now);
                    if self.reset_sent.len() > 64 {
                        self.reset_sent.retain(|_, t| now.saturating_sub(*t) < 5_000);
                    }
                    outs.push(Out::Frame { link: link.into(), bytes: vec![tag::RESET, 0] });
                }
                return;
            }
        }
        let Some(Link::Session(s)) = self.links.get_mut(link) else { return };
        let plain = match s.transport.decrypt(body) {
            Ok(p) => {
                s.bad = 0;
                p
            }
            Err(_) => {
                s.bad += 1;
                let (bad, dev) = (s.bad, s.device_id.clone());
                self.audit_limited(Record::new("frame.rejected").device(&dev).detail("did not authenticate (garbage or replay)"));
                if bad >= MAX_BAD_FRAMES {
                    self.drop_link(link, "too many bad frames", outs);
                }
                return;
            }
        };
        let device_id = s.device_id.clone();
        // revocation is checked on every frame: it never depends on the relay
        let Some(dev) = self.store.device(&device_id) else {
            self.audit_limited(Record::new("rejected.revoked").device(&device_id).detail("command from a device that was removed"));
            self.kick(link, &device_id, outs);
            return;
        };
        let msg = match decode_client(&plain) {
            Ok(m) => m,
            Err(e) => {
                self.audit_limited(Record::new("frame.malformed").device(&device_id).detail(&e.to_string()));
                self.push_msg(link, &ack_err("", "malformed", "not a valid message"), outs);
                if let Some(Link::Session(s)) = self.links.get_mut(link) {
                    s.bad += 1;
                    if s.bad >= MAX_BAD_FRAMES {
                        self.drop_link(link, "too many malformed messages", outs);
                    }
                }
                return;
            }
        };
        let now = self.now();
        self.store.with_registry(|r| r.touch(&device_id, now));
        self.handle(link, dev, msg, outs);
    }

    fn drop_link(&mut self, link: &str, why: &str, outs: &mut Vec<Out>) {
        self.push_msg(link, &ServerMsg::Bye { reason: why.into() }, outs);
        self.links.remove(link);
        outs.push(Out::Close(link.into()));
    }

    /// A removed device: it gets a final `revoked`, then nothing.
    fn kick(&mut self, link: &str, device_id: &str, outs: &mut Vec<Out>) {
        self.push_msg(link, &ServerMsg::Revoked, outs);
        self.links.remove(link);
        self.limits.remove(device_id);
        self.challenges.retain(|(d, _), _| d != device_id);
        self.revoked_links.push_back((link.to_string(), device_id.to_string()));
        while self.revoked_links.len() > 64 {
            self.revoked_links.pop_front();
        }
        outs.push(Out::Close(link.into()));
    }

    /// Drops every session whose device no longer exists in the registry (revoke from Settings, panic, expiry).
    pub fn sweep_revoked(&mut self, outs: &mut Vec<Out>) {
        let gone: Vec<(LinkId, String)> = self
            .links
            .iter()
            .filter_map(|(k, l)| if let Link::Session(s) = l { Some((k.clone(), s.device_id.clone())) } else { None })
            .filter(|(_, d)| self.store.device(d).is_none())
            .collect();
        for (link, dev) in gone {
            self.kick(&link, &dev, outs);
            outs.push(Out::Admin(Admin::DevRevoke { id: dev }));
            outs.push(Out::Host(HostEvent::DevicesChanged));
        }
    }

    /// Called by the slot right after a local revoke so the socket drops within a tick, not on the next frame.
    pub fn on_registry_changed(&mut self) -> Vec<Out> {
        let mut outs = Vec::new();
        self.sweep_revoked(&mut outs);
        self.refresh_status();
        outs
    }

    pub fn on_peer_down(&mut self, link: &str) {
        if matches!(self.links.get(link), Some(Link::Session(_))) {
            self.links.remove(link);
        }
        self.refresh_status();
    }

    // ---------------------------------------------------------------- outbound helpers

    fn transport_of(&mut self, link: &str) -> Option<&mut Transport> {
        match self.links.get_mut(link)? {
            Link::Session(s) => Some(&mut s.transport),
            Link::PairWait { transport, .. } | Link::PairAwait { transport, .. } => Some(transport),
        }
    }

    fn push_msg(&mut self, link: &str, msg: &ServerMsg, outs: &mut Vec<Out>) {
        let mut bytes = encode_server(msg);
        if bytes.len() > MAX_PLAINTEXT {
            match shrink(msg) {
                Some(m) => bytes = encode_server(&m),
                None => return,
            }
            if bytes.len() > MAX_PLAINTEXT {
                return;
            }
        }
        if matches!(msg, ServerMsg::Ack { .. }) {
            self.last_ack = Some(bytes.clone());
        }
        if let Some(t) = self.transport_of(link) {
            if let Ok(ct) = t.encrypt(&bytes) {
                outs.push(Out::Frame { link: link.into(), bytes: framed(tag::DATA, &ct) });
            }
        }
    }

    fn sessions_of(&self) -> Vec<(LinkId, String)> {
        self.links.iter().filter_map(|(k, l)| if let Link::Session(s) = l { Some((k.clone(), s.device_id.clone())) } else { None }).collect()
    }

    // ---------------------------------------------------------------- run cards, snapshot, cards

    fn projection(&mut self, agent: &str) -> &RunProjection {
        if !self.projections.contains_key(agent) {
            let events = self.hub.log().read(agent).unwrap_or_default();
            self.projections.insert(agent.to_string(), RunProjection::fold(agent, &events));
        }
        &self.projections[agent]
    }

    fn run_card(&mut self, s: &AgentSummary) -> RunCard {
        let p = self.projection(&s.agent_id).clone();
        RunCard {
            agent_id: s.agent_id.clone(),
            title: display(&p.title.clone().unwrap_or_else(|| s.title.clone()), 120),
            role: display(&s.role, 60),
            provider: display(&s.provider, 40),
            model: display(&s.model, 80),
            status: p.status,
            last_text: display(&p.last_text, 160),
            waiting_on: p.waiting_on.clone(),
            last_seq: p.last_seq,
            started_at: s.started_at,
            mode: Some(steering_mode(s)),
        }
    }

    fn effective_eligibility(&self, dev_cap: Capability, p: &PendingRequest, rank: usize, limits_forced: bool) -> (Eligibility, Option<String>) {
        if dev_cap < Capability::Reply {
            return (Eligibility::DesktopOnly, Some("This device is view-only.".into()));
        }
        let mut e = p.eligibility;
        let mut reason = None;
        if p.kind == PendingKind::Permission {
            match (&p.intent, self.hub.policy_context(&p.agent_id)) {
                (Some(intent), Some(ctx)) => {
                    let (now_e, why) = eligibility(&ctx, intent, &self.cfg.low_list);
                    if now_e > e {
                        e = now_e;
                        reason = Some(why.to_string());
                    }
                }
                _ => {
                    e = Eligibility::DesktopOnly;
                    reason = Some("The Mac cannot judge this request again.".into());
                }
            }
        }
        if rank >= PENDING_PER_RUN {
            e = Eligibility::DesktopOnly;
            reason = Some("Too many open requests for this run; answer on the Mac.".into());
        }
        if e == Eligibility::Low && p.kind == PendingKind::Permission && limits_forced {
            e = Eligibility::StepUp;
            reason = Some("Many approvals in a row: confirm with your passkey.".into());
        }
        if e == Eligibility::StepUp && reason.is_none() {
            reason = Some("Needs your passkey.".into());
        }
        (e, reason)
    }

    fn question_content(&mut self, agent: &str, req_id: &str) -> (String, Vec<String>) {
        if let Some(q) = self.questions.get(req_id) {
            return q.clone();
        }
        let found = self.hub.log().read(agent).ok().and_then(|evs| {
            evs.into_iter().find_map(|e| match e.kind {
                EventKind::QuestionRequest { req_id: r, prompt, options, .. } if r == req_id => Some((display(&prompt, 2048), options.iter().take(12).map(|o| display(&o.label, 160)).collect::<Vec<_>>())),
                _ => None,
            })
        });
        let q = found.unwrap_or_default();
        self.questions.insert(req_id.to_string(), q.clone());
        q
    }

    fn card(&mut self, dev: &Device, cap: Capability, p: &PendingRequest, rank: usize) -> ReqCard {
        let forced = self.limits.get(&dev.id).is_some_and(|l| l.step_up_forced(self.now()));
        let (eligibility, reason) = self.effective_eligibility(cap, p, rank, forced);
        let intent = p.intent.as_ref().map(wire_intent);
        let (question, options) = if p.kind == PendingKind::Question {
            let (q, o) = self.question_content(&p.agent_id, &p.req_id);
            (Some(q), o)
        } else {
            (None, Vec::new())
        };
        ReqCard {
            req_id: p.req_id.clone(),
            agent_id: p.agent_id.clone(),
            kind: p.kind,
            tool_id: p.tool_id.clone(),
            tool: intent.as_ref().and_then(|i| i.tool.clone()),
            command: intent.as_ref().and_then(|i| i.raw_command.clone()),
            argv: intent.as_ref().and_then(|i| i.argv.clone()),
            paths: intent.as_ref().map(|i| i.paths.clone()).unwrap_or_default(),
            url: intent.as_ref().and_then(|i| i.url.clone()),
            summary: intent.map(|i| i.summary).unwrap_or_default(),
            question,
            options,
            intent_hash: p.intent_hash.clone(),
            risk: p.risk,
            eligibility,
            reason,
            expires_at: p.expires_at,
            plan_excerpt: p.plan_excerpt.clone(),
            plan_truncated: p.plan_truncated,
        }
    }

    fn cards(&mut self, dev: &Device, cap: Capability) -> Vec<ReqCard> {
        let mut pending = self.hub.pending_requests();
        pending.sort_by(|a, b| a.expires_at.cmp(&b.expires_at).then(a.req_id.cmp(&b.req_id)));
        let mut per_run: HashMap<String, usize> = HashMap::new();
        let mut out = Vec::new();
        for p in &pending {
            let rank = per_run.entry(p.agent_id.clone()).or_insert(0);
            let r = *rank;
            *rank += 1;
            out.push(self.card(dev, cap, p, r));
        }
        out
    }

    fn snapshot(&mut self, dev: &Device, cap: Capability) -> ServerMsg {
        let runs_src = self.hub.list_runs();
        let mut runs: Vec<RunCard> = runs_src.iter().map(|s| self.run_card(s)).collect();
        runs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        runs.truncate(40);
        let seq_by_run = runs.iter().map(|r| (r.agent_id.clone(), r.last_seq)).collect();
        let needs_you = self.cards(dev, cap);
        ServerMsg::Snapshot { runs, needs_you, seq_by_run }
    }

    // ---------------------------------------------------------------- replay and live events

    fn wire(&mut self, e: &AgentEvent) -> Option<AgentEvent> {
        self.redactor.wire_event(e)
    }

    fn send_event(&mut self, link: &str, e: &AgentEvent, outs: &mut Vec<Out>) {
        if let Some(w) = self.wire(e) {
            self.push_msg(link, &ServerMsg::Event { agent_id: e.agent_id.clone(), seq: e.seq, ev: w }, outs);
        }
        if let Some(Link::Session(s)) = self.links.get_mut(link) {
            let n = s.sent.entry(e.agent_id.clone()).or_insert(0);
            *n = (*n).max(e.seq);
        }
    }

    /// A fresh start of one run on the phone: the card plus the recent tail.
    fn send_run_snapshot(&mut self, link: &str, agent: &str, outs: &mut Vec<Out>) {
        let Some(summary) = self.hub.list_runs().into_iter().find(|s| s.agent_id == agent) else { return };
        let log = self.hub.log();
        let last = log.last_seq(agent).ok().flatten().unwrap_or(0);
        let from = last.saturating_sub(TAIL_EVENTS as u64 - 1).max(1);
        let raw = log.read_from(agent, from, TAIL_EVENTS).unwrap_or_default();
        let mut events: Vec<AgentEvent> = raw.iter().filter_map(|e| self.wire(e)).collect();
        let run = self.run_card(&summary);
        let max_seq = raw.last().map(|e| e.seq).unwrap_or(last);
        loop {
            let msg = ServerMsg::RunSnapshot { run: run.clone(), last_seq: max_seq, events: events.clone() };
            if encode_server(&msg).len() <= MAX_PLAINTEXT || events.is_empty() {
                self.push_msg(link, &msg, outs);
                break;
            }
            events.remove(0);
        }
        if let Some(Link::Session(s)) = self.links.get_mut(link) {
            s.sent.insert(agent.to_string(), max_seq);
        }
    }

    /// Sends what the phone is missing for one run, from the log; falls back to a snapshot when the log no longer reaches back.
    fn catch_up(&mut self, link: &str, agent: &str, outs: &mut Vec<Out>) {
        let Some(Link::Session(s)) = self.links.get(link) else { return };
        let Some(&sent) = s.sent.get(agent) else { return self.send_run_snapshot(link, agent, outs) };
        let log = self.hub.log();
        loop {
            let Some(Link::Session(s)) = self.links.get(link) else { return };
            let sent = s.sent.get(agent).copied().unwrap_or(sent);
            let last = log.last_seq(agent).ok().flatten().unwrap_or(0);
            if sent > last {
                // the phone is ahead of the log (rotated or restarted run): start over
                return self.send_run_snapshot(link, agent, outs);
            }
            if sent == last {
                return;
            }
            let batch = log.read_from(agent, sent + 1, CATCH_UP_BATCH).unwrap_or_default();
            match batch.first() {
                Some(f) if f.seq == sent + 1 => batch.iter().for_each(|e| self.send_event(link, e, outs)),
                _ => return self.send_run_snapshot(link, agent, outs),
            }
        }
    }

    fn do_sync(&mut self, link: &str, dev: &Device, cap: Capability, last_seq: &std::collections::BTreeMap<String, u64>, outs: &mut Vec<Out>) {
        let runs = self.hub.list_runs();
        for r in &runs {
            match last_seq.get(&r.agent_id) {
                Some(n) => {
                    if let Some(Link::Session(s)) = self.links.get_mut(link) {
                        s.sent.insert(r.agent_id.clone(), *n);
                    }
                    self.catch_up(link, &r.agent_id, outs);
                }
                None => self.send_run_snapshot(link, &r.agent_id, outs),
            }
        }
        let cards = self.cards(dev, cap);
        for c in cards {
            if let Some(Link::Session(s)) = self.links.get_mut(link) {
                s.announced.insert(c.req_id.clone());
            }
            self.push_msg(link, &ServerMsg::ReqNew { req: c }, outs);
        }
        if let Some(Link::Session(s)) = self.links.get_mut(link) {
            s.synced = true;
        }
    }

    /// One event from the bus.
    pub fn on_event(&mut self, e: &AgentEvent) -> Vec<Out> {
        let mut outs = Vec::new();
        if !self.enabled {
            return outs;
        }
        if let Some(p) = self.projections.get_mut(&e.agent_id) {
            p.apply(e);
        }
        if let EventKind::QuestionRequest { req_id, prompt, options, .. } = &e.kind {
            self.questions.insert(req_id.clone(), (display(prompt, 2048), options.iter().take(12).map(|o| display(&o.label, 160)).collect()));
        }
        for (link, device_id) in self.sessions_of() {
            let (synced, sent) = match self.links.get(&link) {
                Some(Link::Session(s)) => (s.synced, s.sent.get(&e.agent_id).copied()),
                _ => continue,
            };
            if !synced {
                continue; // the sync that follows replays from the log, which already holds this event
            }
            match sent {
                Some(n) if e.seq <= n => {}
                Some(n) if e.seq == n + 1 => self.send_event(&link, e, &mut outs),
                _ => self.catch_up(&link, &e.agent_id, &mut outs),
            }
            if let Some(dev) = self.store.device(&device_id) {
                self.live_cards(&link, &dev, e, &mut outs);
            }
        }
        self.notify_for(e, &mut outs);
        self.refresh_status();
        outs
    }

    /// `req.new` / `req.resolved` next to the event stream.
    fn live_cards(&mut self, link: &str, dev: &Device, e: &AgentEvent, outs: &mut Vec<Out>) {
        let (cap, _) = self.cap_of(dev);
        match &e.kind {
            EventKind::PermissionRequest { req_id, .. } | EventKind::QuestionRequest { req_id, .. } => {
                let mut pending = self.hub.pending_requests();
                pending.retain(|p| p.agent_id == e.agent_id);
                pending.sort_by(|a, b| a.expires_at.cmp(&b.expires_at).then(a.req_id.cmp(&b.req_id)));
                if let Some(rank) = pending.iter().position(|p| &p.req_id == req_id) {
                    let card = self.card(dev, cap, &pending[rank].clone(), rank);
                    if let Some(Link::Session(s)) = self.links.get_mut(link) {
                        s.announced.insert(req_id.clone());
                    }
                    self.first_seen.entry(req_id.clone()).or_insert(self.clock.now_ms());
                    self.push_msg(link, &ServerMsg::ReqNew { req: card }, outs);
                }
            }
            EventKind::PermissionResolved { req_id, outcome, by } => {
                let origin = self.hub.resolved_origin(req_id).unwrap_or(Origin::Desktop);
                self.push_msg(link, &ServerMsg::ReqResolved { req_id: req_id.clone(), agent_id: e.agent_id.clone(), outcome: *outcome, by: *by, origin }, outs);
                if let Some(Link::Session(s)) = self.links.get_mut(link) {
                    s.announced.remove(req_id);
                }
            }
            EventKind::ToolResult { .. } | EventKind::TurnEnd { .. } => self.reconcile_questions(link, &e.agent_id, outs),
            _ => {}
        }
    }

    /// A question has no `resolved` event: when it stops being pending, tell the phone.
    fn reconcile_questions(&mut self, link: &str, agent: &str, outs: &mut Vec<Out>) {
        let open: HashSet<String> = self.hub.pending_requests().into_iter().map(|p| p.req_id).collect();
        let stale: Vec<String> = match self.links.get(link) {
            Some(Link::Session(s)) => s.announced.iter().filter(|r| !open.contains(*r)).cloned().collect(),
            _ => return,
        };
        for r in stale {
            let origin = self.hub.resolved_origin(&r);
            let outcome = if origin.is_some() { PermissionOutcome::Allow } else { PermissionOutcome::Cancelled };
            self.push_msg(link, &ServerMsg::ReqResolved { req_id: r.clone(), agent_id: agent.into(), outcome, by: DecidedBy::User, origin: origin.unwrap_or(Origin::Desktop) }, outs);
            if let Some(Link::Session(s)) = self.links.get_mut(link) {
                s.announced.remove(&r);
            }
        }
    }

    fn notify_for(&mut self, e: &AgentEvent, outs: &mut Vec<Out>) {
        if self.store.devices().is_empty() {
            return;
        }
        let kind = match &e.kind {
            EventKind::PermissionRequest { .. } | EventKind::QuestionRequest { .. } => Some(NotifyKind::NeedsYou),
            EventKind::TurnEnd { stop_reason: StopReason::EndTurn } => Some(NotifyKind::Finished),
            EventKind::TurnEnd { stop_reason: StopReason::Error | StopReason::Refusal } | EventKind::Error { retryable: false, .. } => Some(NotifyKind::Failed),
            _ => None,
        };
        if let Some(kind) = kind {
            // content-free: the relay only learns the kind and a run reference for collapsing
            outs.push(Out::Admin(Admin::Notify { kind, collapse_key: Some(sha256_hex(e.agent_id.as_bytes())[..16].to_string()) }));
        }
    }

    /// The bus receiver fell behind: every synced session catches up from the log (or restarts a run from a snapshot).
    pub fn on_lagged(&mut self) -> Vec<Out> {
        let mut outs = Vec::new();
        let agents: Vec<String> = self.hub.list_runs().into_iter().map(|r| r.agent_id).collect();
        self.projections.clear();
        for (link, _) in self.sessions_of() {
            if !matches!(self.links.get(&link), Some(Link::Session(s)) if s.synced) {
                continue;
            }
            for a in &agents {
                self.catch_up(&link, a, &mut outs);
            }
        }
        outs
    }

    // ---------------------------------------------------------------- phone commands

    fn handle(&mut self, link: &str, dev: Device, msg: ClientMsg, outs: &mut Vec<Out>) {
        let (cap, reauth) = self.cap_of(&dev);
        let now = self.now();
        let op_of = |m: &ClientMsg| -> Option<String> {
            match m {
                ClientMsg::Answer { op_id, .. } | ClientMsg::Prompt { op_id, .. } | ClientMsg::Stop { op_id, .. } | ClientMsg::StopAll { op_id } | ClientMsg::Start { op_id, .. } | ClientMsg::DiffGet { op_id, .. } | ClientMsg::StepUpBegin { op_id, .. } | ClientMsg::Reauth { op_id, .. } | ClientMsg::SignOut { op_id } => Some(op_id.clone()),
                _ => None,
            }
        };
        // idempotency: a repeated opId returns the first reply and does nothing
        if let Some(op) = op_of(&msg) {
            if let Some(cached) = self.limits.entry(dev.id.clone()).or_default().seen_op(&op).cloned() {
                if let Some(t) = self.transport_of(link) {
                    if let Ok(ct) = t.encrypt(&cached) {
                        outs.push(Out::Frame { link: link.into(), bytes: framed(tag::DATA, &ct) });
                    }
                }
                return;
            }
        }
        self.last_ack = None;
        let mut local = Vec::new();
        let op = op_of(&msg);
        match msg {
            ClientMsg::Ping => self.push_msg(link, &ServerMsg::Pong, &mut local),
            ClientMsg::Sync { last_seq } => self.do_sync(link, &dev, cap, &last_seq, &mut local),
            ClientMsg::DiffGet { op_id, agent_id, tool_id } => self.on_diff(link, &op_id, &agent_id, &tool_id, &mut local),
            ClientMsg::SignOut { op_id } => {
                let _ = self.store.revoke(&dev.id, "signed out on the phone");
                self.push_msg(link, &ack_ok(&op_id), &mut local);
                outs.push(Out::Host(HostEvent::DevicesChanged));
            }
            ClientMsg::Reauth { op_id, step_up } => self.on_reauth(link, &dev, &op_id, step_up, &mut local),
            ClientMsg::StepUpBegin { op_id, req_id } => self.on_stepup_begin(link, &dev, cap, &op_id, &req_id, &mut local),
            ClientMsg::Prompt { op_id, agent_id, text, mode, step_up } => {
                // An Automatic or Bypass run shows no approval cards, so what the phone may say to it depends on the run's mode
                let run_mode = self.run_mode_of(&agent_id);
                let r = self.guard(&dev, cap, RemoteAction::FollowUpPrompt, run_mode, Some(Bucket::Prompt), &op_id, &agent_id);
                let need_step_up = verdict(RemoteAction::FollowUpPrompt, cap, run_mode) == Verdict::StepUp;
                match r {
                    Err((code, msg)) => self.reject(link, &dev, &op_id, "prompt", &code, &msg, &agent_id, &mut local),
                    Ok(()) if text.trim().is_empty() || text.chars().count() > MAX_PROMPT_CHARS => self.reject(link, &dev, &op_id, "prompt", "badPrompt", "empty or too long", &agent_id, &mut local),
                    Ok(()) => {
                        // the assertion answers the challenge issued for exactly this run and this text
                        let proof = if need_step_up { self.verify_step_up(&dev, &prompt_step_up_key(&agent_id, &text), step_up.as_ref()) } else { Ok(()) };
                        match proof {
                            Err(msg) => {
                                self.store.audit(Record::new("stepup.failed").device(&dev.id).agent(&agent_id).detail("prompt"));
                                self.push_msg(link, &ack_err(&op_id, "stepUpRequired", &msg), &mut local);
                            }
                            Ok(()) => match self.hub.send_prompt(&agent_id, &text, mode, &Origin::Remote { device_id: dev.id.clone() }) {
                                Ok(()) => {
                                    if need_step_up {
                                        self.store.audit(Record::new("stepup.ok").device(&dev.id).agent(&agent_id).detail("prompt"));
                                    }
                                    self.store.audit(Record::new("prompt").device(&dev.id).agent(&agent_id).detail(&format!("{} chars, {:?}", text.chars().count(), mode)));
                                    self.push_msg(link, &ack_ok(&op_id), &mut local);
                                }
                                Err(e) => self.reject(link, &dev, &op_id, "prompt", e.code(), &e.to_string(), &agent_id, &mut local),
                            },
                        }
                    }
                }
            }
            ClientMsg::Stop { op_id, agent_id } => match self.guard(&dev, cap, RemoteAction::StopRun, None, None, &op_id, &agent_id) {
                Err((code, msg)) => self.reject(link, &dev, &op_id, "stop", &code, &msg, &agent_id, &mut local),
                Ok(()) => match self.hub.interrupt(&agent_id, &Origin::Remote { device_id: dev.id.clone() }) {
                    Ok(()) => {
                        self.store.audit(Record::new("stop").device(&dev.id).agent(&agent_id));
                        self.push_msg(link, &ack_ok(&op_id), &mut local);
                    }
                    Err(e) => self.reject(link, &dev, &op_id, "stop", e.code(), &e.to_string(), &agent_id, &mut local),
                },
            },
            ClientMsg::StopAll { op_id } => match self.guard(&dev, cap, RemoteAction::StopAll, None, None, &op_id, "") {
                Err((code, msg)) => self.reject(link, &dev, &op_id, "stopAll", &code, &msg, "", &mut local),
                Ok(()) => {
                    let origin = Origin::Remote { device_id: dev.id.clone() };
                    let mut n = 0;
                    for r in self.hub.list_runs() {
                        if matches!(r.status, RunStatus::Running | RunStatus::NeedsYou) && self.hub.interrupt(&r.agent_id, &origin).is_ok() {
                            n += 1;
                        }
                    }
                    self.store.audit(Record::new("stopAll").device(&dev.id).detail(&format!("{n} runs")));
                    self.push_msg(link, &ack_ok(&op_id), &mut local);
                }
            },
            ClientMsg::Start { op_id, template_id, params, step_up } => self.on_start(link, &dev, cap, &op_id, template_id, params, step_up, &mut local),
            ClientMsg::Answer { op_id, req_id, agent_id, decision, question, intent_hash, step_up } => {
                self.on_answer(link, &dev, cap, AnswerArgs { op_id, req_id, agent_id, decision, question, intent_hash, step_up }, &mut local)
            }
        }
        let _ = (reauth, now);
        // remember the ack of a command so a retried opId gets the same answer without a second effect
        if let (Some(op), Some(ack)) = (op, self.last_ack.take()) {
            self.limits.entry(dev.id.clone()).or_default().remember_op(&op, ack);
        }
        outs.extend(local);
    }
}

/// The mode a run is steered under: the LOOSER of its live effective mode and the recorded `Meta.permission` (a run with no live session
/// counts as recorded, so a recorded Bypass stays Bypass although a resume would start in Automatic).
fn steering_mode(run: &AgentSummary) -> PermissionMode {
    let live = run.effective.as_ref().map(|e| e.permission);
    live.filter(|l| l.strictness() > run.permission.strictness()).unwrap_or(run.permission)
}

impl GatewayCore {
    /// The mode the verdicts treat a run as having: the LOOSER of its live effective mode and the recorded one (a recorded Bypass counts as Bypass
    /// although a resume would start in Automatic). `None` = unknown run.
    fn run_mode_of(&self, agent_id: &str) -> Option<PermissionMode> {
        self.hub.list_runs().iter().find(|r| r.agent_id == agent_id).map(steering_mode)
    }

    /// Capability and rate gate shared by prompt/stop/start. `Err((code, message))` is what the phone is told.
    #[allow(clippy::too_many_arguments)]
    fn guard(&mut self, dev: &Device, cap: Capability, action: RemoteAction, run_mode: Option<PermissionMode>, bucket: Option<Bucket>, _op: &str, _agent: &str) -> Result<(), (String, String)> {
        match verdict(action, cap, run_mode) {
            Verdict::Never(why) => {
                let why = if cap < dev.capability { "Your session needs a passkey check first (re-authenticate).".to_string() } else { why.to_string() };
                return Err(("forbidden".into(), why));
            }
            Verdict::Allowed | Verdict::StepUp => {}
        }
        if let Some(b) = bucket {
            let now = self.now();
            match self.limits.entry(dev.id.clone()).or_default().check(b, now) {
                RateVerdict::Ok => {}
                RateVerdict::Limited => return Err(("rateLimited".into(), "Too many requests; wait a moment.".into())),
                RateVerdict::Anomaly => {
                    if self.store.set_capability(&dev.id, Capability::View).is_ok() {
                        self.store.audit(Record::new("device.demoted").device(&dev.id).detail("repeated rate-limit hits"));
                    }
                    return Err(("rateLimited".into(), "This device was set to view-only after too many requests.".into()));
                }
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn reject(&mut self, link: &str, dev: &Device, op_id: &str, what: &str, code: &str, message: &str, agent: &str, outs: &mut Vec<Out>) {
        let event = format!("rejected.{what}");
        let mut rec = Record::new(&event).device(&dev.id).detail(code);
        if !agent.is_empty() {
            rec = rec.agent(agent);
        }
        self.store.audit(rec);
        self.push_msg(link, &ack_err(op_id, code, &display(message, 200)), outs);
        if code == "rateLimited" && self.store.device(&dev.id).is_some_and(|d| d.capability == Capability::View) && dev.capability == Capability::Reply {
            outs.push(Out::Host(HostEvent::Anomaly { device_id: dev.id.clone() }));
            let (cap, re) = (Capability::View, false);
            self.push_msg(link, &ServerMsg::CapabilityChanged { capability: cap, reauth_required: re }, outs);
        }
    }

    fn rank_of(&self, p: &PendingRequest) -> usize {
        let mut same: Vec<&PendingRequest> = Vec::new();
        let all = self.hub.pending_requests();
        for q in all.iter().filter(|q| q.agent_id == p.agent_id) {
            same.push(q);
        }
        same.sort_by(|a, b| a.expires_at.cmp(&b.expires_at).then(a.req_id.cmp(&b.req_id)));
        same.iter().position(|q| q.req_id == p.req_id).unwrap_or(0)
    }

    fn on_answer(&mut self, link: &str, dev: &Device, cap: Capability, a: AnswerArgs, outs: &mut Vec<Out>) {
        let origin = Origin::Remote { device_id: dev.id.clone() };
        let op = a.op_id.clone();
        let pending = self.hub.pending_requests().into_iter().find(|p| p.req_id == a.req_id);
        let risk = pending.as_ref().map(|p| risk_str(p.risk)).unwrap_or("unknown").to_string();
        let ihash = pending.as_ref().map(|p| p.intent_hash.clone()).unwrap_or_default();
        let now = self.now();

        if let Err((code, msg)) = self.guard(dev, cap, RemoteAction::AnswerQuestion, None, Some(Bucket::Answer), &op, &a.agent_id) {
            self.store.audit(Record::new("rejected.answer").device(&dev.id).req(&a.req_id).agent(&a.agent_id).risk(&risk).detail(&code));
            return self.reject_quiet(link, &op, &code, &msg, outs);
        }
        let Some(p) = pending else {
            // unknown or already resolved: first answer wins, the loser learns who won; anything else is forged and audited
            return match self.hub.resolved_origin(&a.req_id) {
                Some(by) => {
                    self.store.audit(Record::new("answer.lost").device(&dev.id).req(&a.req_id).agent(&a.agent_id).detail("already resolved"));
                    let who = match by {
                        Origin::Desktop => "on the Mac".to_string(),
                        Origin::Remote { device_id } => format!("by device {}", display(&device_id, 24)),
                    };
                    self.push_msg(link, &ack_err(&op, "alreadyResolved", &format!("Already answered {who}.")), outs);
                }
                None => {
                    self.store.audit(Record::new("answer.forged").device(&dev.id).req(&a.req_id).agent(&a.agent_id).detail("unknown request id"));
                    self.push_msg(link, &ack_err(&op, "unknownRequest", "That request does not exist."), outs);
                }
            };
        };
        if p.agent_id != a.agent_id {
            self.store.audit(Record::new("answer.forged").device(&dev.id).req(&a.req_id).agent(&a.agent_id).risk(&risk).detail("request belongs to another run"));
            return self.push_msg(link, &ack_err(&op, "wrongRun", "That request belongs to another run."), outs);
        }
        if a.intent_hash.as_deref() != Some(p.intent_hash.as_str()) {
            self.store.audit(Record::new("answer.forged").device(&dev.id).req(&a.req_id).agent(&a.agent_id).risk(&risk).detail("intent hash does not match the displayed intent"));
            return self.push_msg(link, &ack_err(&op, "intentMismatch", "The request changed; review it again."), outs);
        }
        let forced = self.limits.entry(dev.id.clone()).or_default().step_up_forced(now);
        let rank = self.rank_of(&p);
        let (elig, why) = self.effective_eligibility(cap, &p, rank, forced);
        if elig == Eligibility::DesktopOnly {
            self.store.audit(Record::new("answer.forged").device(&dev.id).req(&a.req_id).agent(&a.agent_id).risk(&risk).intent(&ihash).detail("desktop-only request answered remotely"));
            return self.push_msg(link, &ack_err(&op, "desktopOnly", why.as_deref().unwrap_or("This can only be decided on the Mac.")), outs);
        }

        match (a.decision, a.question.clone()) {
            (Some(decision), None) => {
                if p.kind != PendingKind::Permission {
                    return self.push_msg(link, &ack_err(&op, "wrongKind", "That request is not a permission."), outs);
                }
                let allow = !matches!(decision, PermissionDecision::Deny);
                let action = match decision {
                    PermissionDecision::AllowAlways => RemoteAction::AllowAlways,
                    PermissionDecision::AllowRun => RemoteAction::AllowForRun,
                    _ => RemoteAction::ApproveOnce(elig),
                };
                let need_step_up = match verdict(action, cap, None) {
                    Verdict::Never(w) => {
                        self.store.audit(Record::new("rejected.answer").device(&dev.id).req(&a.req_id).agent(&a.agent_id).risk(&risk).detail("never remote"));
                        return self.push_msg(link, &ack_err(&op, "notRemote", w), outs);
                    }
                    Verdict::StepUp => allow,
                    Verdict::Allowed => allow && forced && elig == Eligibility::StepUp,
                };
                if need_step_up {
                    if let Err(msg) = self.verify_step_up(dev, &a.req_id, a.step_up.as_ref()) {
                        self.store.audit(Record::new("stepup.failed").device(&dev.id).req(&a.req_id).agent(&a.agent_id).risk(&risk).intent(&ihash).detail(&msg));
                        return self.push_msg(link, &ack_err(&op, "stepUpRequired", &msg), outs);
                    }
                    self.store.audit(Record::new("stepup.ok").device(&dev.id).req(&a.req_id).risk(&risk).intent(&ihash));
                }
                match self.hub.answer_permission(&a.req_id, &a.agent_id, decision, a.intent_hash.as_deref(), &origin) {
                    Ok(_) => {
                        let lim = self.limits.entry(dev.id.clone()).or_default();
                        if allow {
                            lim.approved(now);
                        } else {
                            lim.denied();
                        }
                        let ev = if allow { "answer.allow" } else { "answer.deny" };
                        self.store.audit(Record::new(ev).device(&dev.id).req(&a.req_id).agent(&a.agent_id).risk(&risk).intent(&ihash).detail(&format!("{decision:?}")));
                        self.push_msg(link, &ack_ok(&op), outs);
                    }
                    Err(e) => {
                        let ev = if matches!(e, HubError::AlreadyResolved { .. }) { "answer.lost" } else { "answer.forged" };
                        self.store.audit(Record::new(ev).device(&dev.id).req(&a.req_id).agent(&a.agent_id).risk(&risk).detail(e.code()));
                        self.push_msg(link, &ack_err(&op, e.code(), &e.to_string()), outs);
                    }
                }
            }
            (None, Some(mut q)) => {
                if p.kind != PendingKind::Question {
                    return self.push_msg(link, &ack_err(&op, "wrongKind", "That request is not a question."), outs);
                }
                q.option_ids.truncate(12);
                q.text = q.text.map(|t| t.chars().take(2000).collect());
                match self.hub.answer_question(&a.req_id, &a.agent_id, q, a.intent_hash.as_deref(), &origin) {
                    Ok(_) => {
                        self.store.audit(Record::new("answer.question").device(&dev.id).req(&a.req_id).agent(&a.agent_id));
                        self.push_msg(link, &ack_ok(&op), outs);
                    }
                    Err(e) => {
                        let ev = if matches!(e, HubError::AlreadyResolved { .. }) { "answer.lost" } else { "answer.forged" };
                        self.store.audit(Record::new(ev).device(&dev.id).req(&a.req_id).agent(&a.agent_id).detail(e.code()));
                        self.push_msg(link, &ack_err(&op, e.code(), &e.to_string()), outs);
                    }
                }
            }
            _ => self.push_msg(link, &ack_err(&op, "malformed", "Send either a decision or a question answer."), outs),
        }
    }

    fn reject_quiet(&mut self, link: &str, op: &str, code: &str, msg: &str, outs: &mut Vec<Out>) {
        self.push_msg(link, &ack_err(op, code, &display(msg, 200)), outs);
    }

    /// Checks a passkey assertion against the challenge issued for `key` (a request id, `reauth` or `start:<template>`).
    fn verify_step_up(&mut self, dev: &Device, key: &str, proof: Option<&StepUpProof>) -> Result<(), String> {
        let proof = proof.ok_or_else(|| "A passkey check is required for this request.".to_string())?;
        let k = (dev.id.clone(), key.to_string());
        let (ch, _) = self.challenges.get(&k).cloned().ok_or_else(|| "Ask for a challenge first.".to_string())?;
        let now = self.now();
        let fresh = self.store.device(&dev.id).ok_or_else(|| "device removed".to_string())?;
        let counter = verify(proof, &ch, fresh.passkey.as_ref(), &self.cfg.rp_id, &self.cfg.origin, now).map_err(|e| e.to_string())?;
        self.challenges.remove(&k); // single use
        self.store.with_registry(|r| r.passkey_used(&dev.id, counter, now)).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn on_stepup_begin(&mut self, link: &str, dev: &Device, cap: Capability, op: &str, req_id: &str, outs: &mut Vec<Out>) {
        if cap < Capability::Reply {
            return self.reject(link, dev, op, "stepup", "forbidden", "This device is view-only.", "", outs);
        }
        let ihash = if let Some(tpl) = req_id.strip_prefix("start:") {
            sha256_hex(tpl.as_bytes())
        } else if let Some((agent, _)) = parse_prompt_step_up_key(req_id) {
            // a follow-up to an Automatic run: the challenge is bound to the run and the text hash named in the key
            match self.run_mode_of(agent) {
                Some(PermissionMode::Automatic) => sha256_hex(req_id.as_bytes()),
                _ => return self.reject(link, dev, op, "stepup", "unknownRequest", "That request cannot be confirmed here.", agent, outs),
            }
        } else {
            match self.hub.pending_requests().into_iter().find(|p| p.req_id == req_id) {
                Some(p) if p.eligibility != Eligibility::DesktopOnly => p.intent_hash,
                _ => return self.reject(link, dev, op, "stepup", "unknownRequest", "That request cannot be confirmed here.", "", outs),
            }
        };
        self.issue_challenge(link, dev, op, req_id, &ihash, outs);
    }

    fn issue_challenge(&mut self, link: &str, dev: &Device, op: &str, key: &str, ihash: &str, outs: &mut Vec<Out>) {
        if dev.passkey.is_none() {
            return self.reject(link, dev, op, "stepup", "noPasskey", "No passkey is registered for this device. Re-pair it on the Mac.", "", outs);
        }
        let now = self.now();
        self.challenges.retain(|_, (c, _)| c.expires_at > now);
        if self.challenges.keys().filter(|(d, _)| d == &dev.id).count() >= 8 {
            return self.reject(link, dev, op, "stepup", "rateLimited", "Too many open challenges.", "", outs);
        }
        let ch = Challenge::issue(&dev.id, key, ihash, now);
        let msg = ServerMsg::StepUpChallenge { op_id: op.into(), req_id: key.into(), challenge: ch.encoded(), rp_id: self.cfg.rp_id.clone(), expires_at: ch.expires_at };
        self.challenges.insert((dev.id.clone(), key.to_string()), (ch, ihash.to_string()));
        self.push_msg(link, &msg, outs);
    }

    fn on_reauth(&mut self, link: &str, dev: &Device, op: &str, proof: Option<StepUpProof>, outs: &mut Vec<Out>) {
        let Some(proof) = proof else { return self.issue_challenge(link, dev, op, "reauth", "reauth", outs) };
        match self.verify_step_up(dev, "reauth", Some(&proof)) {
            Ok(()) => {
                self.store.audit(Record::new("reauth.ok").device(&dev.id));
                let cap = self.store.device(&dev.id).map_or(Capability::View, |d| d.capability);
                self.push_msg(link, &ack_ok(op), outs);
                self.push_msg(link, &ServerMsg::CapabilityChanged { capability: cap, reauth_required: false }, outs);
            }
            Err(msg) => {
                self.store.audit(Record::new("reauth.failed").device(&dev.id).detail(&msg));
                self.push_msg(link, &ack_err(op, "stepUpRequired", &msg), outs);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn on_start(&mut self, link: &str, dev: &Device, cap: Capability, op: &str, template_id: String, params: serde_json::Value, step_up: Option<StepUpProof>, outs: &mut Vec<Out>) {
        if let Err((code, msg)) = self.guard(dev, cap, RemoteAction::StartRun, None, Some(Bucket::Start), op, "") {
            return self.reject(link, dev, op, "start", &code, &msg, "", outs);
        }
        if params.to_string().len() > 4096 || template_id.len() > 128 {
            return self.reject(link, dev, op, "start", "malformed", "Parameters too large.", "", outs);
        }
        if let Err(msg) = self.verify_step_up(dev, &format!("start:{template_id}"), step_up.as_ref()) {
            self.store.audit(Record::new("stepup.failed").device(&dev.id).detail(&format!("start {}", display(&template_id, 60))));
            return self.push_msg(link, &ack_err(op, "stepUpRequired", &msg), outs);
        }
        match self.hub.start_run(StartParams { template_id: template_id.clone(), params }, &Origin::Remote { device_id: dev.id.clone() }) {
            Ok(s) => {
                self.store.audit(Record::new("start").device(&dev.id).agent(&s.agent_id).detail(&display(&template_id, 60)));
                self.push_msg(link, &ack_ok(op), outs);
            }
            Err(e) => self.reject(link, dev, op, "start", e.code(), &e.to_string(), "", outs),
        }
    }

    fn on_diff(&mut self, link: &str, op: &str, agent: &str, tool_id: &str, outs: &mut Vec<Out>) {
        let found = self.hub.log().read(agent).ok().and_then(|evs| {
            evs.into_iter().find_map(|e| match e.kind {
                EventKind::ToolResult { tool_id: t, diff: Some(d), .. } if t == tool_id => Some(d),
                _ => None,
            })
        });
        match found.and_then(|d| self.redactor.wire_diff(&d)) {
            Some((path, old, new, truncated)) => self.push_msg(link, &ServerMsg::Diff { op_id: op.into(), agent_id: agent.into(), tool_id: tool_id.into(), path, old, new, truncated }, outs),
            None => self.push_msg(link, &ack_err(op, "noDiff", "No diff available (or it is hidden because the path is secret)."), outs),
        }
    }

    // ---------------------------------------------------------------- timers, kill switch, panic

    /// Housekeeping, driven by the runner's timer (which exists only while Remote is on).
    pub fn tick(&mut self) -> Vec<Out> {
        let mut outs = Vec::new();
        if !self.enabled {
            return outs;
        }
        let now = self.now();
        // pairing timeouts
        let stale_wait: Vec<LinkId> = self.links.iter().filter_map(|(k, l)| matches!(l, Link::PairWait { since, .. } if now.saturating_sub(*since) >= HELLO_TIMEOUT_MS).then(|| k.clone())).collect();
        for l in stale_wait {
            self.fail_pair_attempt(&l, &mut outs);
            outs.push(Out::Close(l));
        }
        let confirm_expired = self.links.values().any(|l| matches!(l, Link::PairAwait { since, .. } if now.saturating_sub(*since) >= CONFIRM_TIMEOUT_MS));
        if confirm_expired {
            self.end_pairing("confirmTimedOut", &mut outs);
        } else if self.offer.as_ref().is_some_and(|o| now >= o.expires_at) && !self.links.values().any(|l| matches!(l, Link::PairWait { .. } | Link::PairAwait { .. })) {
            self.end_pairing("expired", &mut outs);
        }
        self.challenges.retain(|_, (c, _)| c.expires_at > now);
        // registry integrity: external edits stop Remote
        if now.saturating_sub(self.last_verify) >= 30_000 {
            self.last_verify = now;
            if let Err(e) = self.store.verify_registry() {
                self.store.audit(Record::new("tamper.registry").detail(&e.to_string()));
                outs.push(Out::Host(HostEvent::Tampered(e.to_string())));
                outs.extend(self.kill());
                return outs;
            }
            let _ = self.store.with_registry(|r| r.flush());
            if let Ok(gone) = self.store.with_registry(|r| r.expire_unused(now)) {
                for id in gone {
                    self.store.audit(Record::new("device.expired").device(&id));
                    outs.push(Out::Admin(Admin::DevRevoke { id }));
                    outs.push(Out::Host(HostEvent::DevicesChanged));
                }
            }
        }
        self.sweep_revoked(&mut outs);
        // questions answered on the Mac
        for (link, _) in self.sessions_of() {
            let agents: HashSet<String> = self.hub.pending_requests().into_iter().map(|p| p.agent_id).collect();
            let announced: Vec<String> = match self.links.get(&link) {
                Some(Link::Session(s)) => s.announced.iter().cloned().collect(),
                _ => continue,
            };
            if !announced.is_empty() {
                let any = agents.iter().next().cloned().unwrap_or_default();
                self.reconcile_questions(&link, &any, &mut outs);
            }
        }
        // an unanswered ask is announced once more after 10 minutes (iOS pushes can be missed)
        let open: HashSet<String> = self.hub.pending_requests().into_iter().map(|p| p.req_id).collect();
        self.first_seen.retain(|r, _| open.contains(r));
        let aging: Vec<String> = self.first_seen.iter().filter(|(r, t)| now.saturating_sub(**t) >= REPUSH_MS && !self.repushed.contains(*r)).map(|(r, _)| r.clone()).collect();
        for r in aging {
            self.repushed.insert(r);
            outs.push(Out::Admin(Admin::Notify { kind: NotifyKind::NeedsYou, collapse_key: Some("aging".into()) }));
            outs.push(Out::Host(HostEvent::NeedsYouAging));
        }
        self.refresh_status();
        outs
    }

    /// Kill switch: every session closes at once, the offer is withdrawn, new frames are ignored until the slot restarts the gateway.
    pub fn kill(&mut self) -> Vec<Out> {
        let mut outs = Vec::new();
        for (link, _) in self.sessions_of() {
            self.push_msg(&link, &ServerMsg::Bye { reason: "Remote was switched off on the Mac.".into() }, &mut outs);
        }
        let links: Vec<LinkId> = self.links.keys().cloned().collect();
        for l in links {
            outs.push(Out::Close(l));
        }
        self.links.clear();
        self.offer = None;
        self.enabled = false;
        let n = self.hub.disable_claude_remote_control();
        self.store.audit(Record::new("remote.killed").detail(&format!("{n} Claude queries had Remote Control disabled")));
        self.refresh_status();
        outs
    }

    /// Panic / "Lock all": tell every phone, revoke everything, rotate key, room and token, wipe the relay room, stop.
    pub fn panic(&mut self) -> Vec<Out> {
        let mut outs = Vec::new();
        for (link, dev) in self.sessions_of() {
            self.kick(&link, &dev, &mut outs);
        }
        match self.store.revoke_all("panic") {
            Ok(_) => outs.push(Out::Admin(Admin::RoomWipe)),
            Err(e) => self.store.audit(Record::new("panic.failed").detail(&e.to_string())),
        }
        outs.push(Out::Host(HostEvent::DevicesChanged));
        outs.extend(self.kill());
        outs
    }
}

/// Last resort when a message is over the frame cap: cut the text, never send a partial structure.
fn shrink(msg: &ServerMsg) -> Option<ServerMsg> {
    match msg {
        ServerMsg::Event { agent_id, seq, ev } => {
            let mut ev = ev.clone();
            match &mut ev.kind {
                EventKind::TextDelta { text, .. } | EventKind::TextDone { text, .. } | EventKind::UserMessage { text, .. } => *text = crate::redact::cap(text, 4096),
                EventKind::ToolStart { input, .. } => *input = serde_json::json!({"truncated": true}),
                EventKind::ToolUpdate { output: Some(o), .. } | EventKind::ToolResult { output: Some(o), .. } => *o = crate::redact::cap(o, 1024),
                _ => return None,
            }
            Some(ServerMsg::Event { agent_id: agent_id.clone(), seq: *seq, ev })
        }
        _ => None,
    }
}

impl GatewayCore {
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// "Send my build key to paired phones": every live session gets `welcome` now (others at their next session start).
    pub fn send_welcome_all(&mut self) -> Vec<Out> {
        let mut outs = Vec::new();
        let Some(bundle_pub) = self.cfg.bundle_pub.clone() else { return outs };
        for (link, id) in self.sessions_of() {
            self.push_msg(&link, &ServerMsg::Welcome { bundle_pub: bundle_pub.clone() }, &mut outs);
            self.store.with_registry(|r| r.mark_pinned(&id));
        }
        outs
    }

    /// A device was promoted or demoted on the Mac: tell its live session.
    pub fn on_capability_changed(&mut self, device_id: &str) -> Vec<Out> {
        let mut outs = Vec::new();
        let Some(dev) = self.store.device(device_id) else { return self.on_registry_changed() };
        let (cap, reauth) = self.cap_of(&dev);
        let links: Vec<LinkId> = self.links.iter().filter_map(|(k, l)| matches!(l, Link::Session(s) if s.device_id == device_id).then(|| k.clone())).collect();
        for l in links {
            self.push_msg(&l, &ServerMsg::CapabilityChanged { capability: cap, reauth_required: reauth }, &mut outs);
        }
        outs
    }
}
