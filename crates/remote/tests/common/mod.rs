//! Shared fixtures: a fake hub (the desktop side), a fake phone, and a harness around the gateway core.
#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use intely_agent_core::api::*;
use intely_agent_core::bus::EventBus;
use intely_agent_core::events::{AgentEvent, DecidedBy, EventKind, EventLog, JsonlEventLog, PermissionOption, PermissionOutcome};
use intely_agent_core::hub::*;
use intely_agent_core::policy::decide::PolicyContext;
use intely_agent_core::policy::enforcement::Tier;
use intely_agent_core::policy::intent::ToolIntent;
use intely_agent_core::providers::{PermissionMode, ProviderCaps};
use intely_remote::gateway::{GatewayCfg, GatewayCore, HostEvent, Out};
use intely_remote::noise::StaticKey;
use intely_remote::phone::{PhonePairing, PhoneSession};
use intely_remote::policy::{pending_permission, pending_question, LowList};
use intely_remote::store::Store;
use intely_remote::util::{Clock, ManualClock};
use intely_remote::wire::*;
use intely_settings::{MemorySecretStore, SecretStore};
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};

pub const AGENT: &str = "agent-1";
pub const T0: u64 = 1_790_000_000_000;

pub struct FakeHub {
    pub log: Arc<JsonlEventLog>,
    pub bus: EventBus,
    pub table: PendingTable,
    pub clock: ManualClock,
    pub ctx: Mutex<PolicyContext>,
    pub runs: Mutex<Vec<AgentSummary>>,
    pub prompts: Mutex<Vec<(String, String, PromptMode, Origin)>>,
    pub interrupts: Mutex<Vec<(String, Origin)>>,
    pub permission_answers: Mutex<Vec<(String, PermissionDecision, Origin)>>,
    pub question_answers: Mutex<Vec<(String, Origin)>>,
    pub starts: Mutex<Vec<(StartParams, Origin)>>,
    pub rc_disabled: AtomicUsize,
}

pub fn summary(agent: &str) -> AgentSummary {
    AgentSummary {
        agent_id: agent.into(),
        provider: "claude".into(),
        role: "developer".into(),
        model: "claude-haiku-4-5".into(),
        title: "Fix the thing".into(),
        status: RunStatus::Running,
        permission: PermissionMode::Ask,
        requested: Requested { effort: None, permission: PermissionMode::Ask },
        effective: None,
        repo_ids: vec!["admin".into()],
        caps: ProviderCaps::default(),
        enforcement: Tier::BestEffort,
        started_at: T0,
        usage: None,
        delegates: Vec::new(),
        switchable_modes: Vec::new(),
        mcp: Vec::new(),
        location: None,
    }
}

impl FakeHub {
    pub fn new(dir: &std::path::Path, clock: ManualClock) -> Arc<Self> {
        let log = Arc::new(JsonlEventLog::new(&dir.join("state")));
        let bus = EventBus::new(log.clone());
        let ws = dir.join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let mut ctx = PolicyContext::new(PermissionMode::Ask, &ws);
        ctx.state_dir = Some(dir.join("state"));
        ctx.home = Some(dir.join("home"));
        Arc::new(Self {
            log,
            bus,
            table: PendingTable::new(),
            clock,
            ctx: Mutex::new(ctx),
            runs: Mutex::new(vec![summary(AGENT)]),
            prompts: Mutex::default(),
            interrupts: Mutex::default(),
            permission_answers: Mutex::default(),
            question_answers: Mutex::default(),
            starts: Mutex::default(),
            rc_disabled: AtomicUsize::new(0),
        })
    }

    pub fn workspace(&self) -> PathBuf {
        self.ctx.lock().unwrap().cwd.clone()
    }

    pub fn publish_for(&self, agent: &str, kind: EventKind) -> AgentEvent {
        let seq = self.log.last_seq(agent).unwrap().unwrap_or(0) + 1;
        let e = AgentEvent { agent_id: agent.into(), seq, ts: self.clock.now_ms(), turn_id: Some("turn-1".into()), provider: "claude".into(), kind, raw: Some(serde_json::json!({"provider_payload": "RAW-CANARY"})) };
        self.bus.publish(&e).unwrap();
        e
    }

    pub fn publish(&self, kind: EventKind) -> AgentEvent {
        self.publish_for(AGENT, kind)
    }

    pub fn text(&self, s: &str) -> AgentEvent {
        self.publish(EventKind::TextDelta { message_id: "m1".into(), text: s.into(), parent_tool_id: None })
    }

    /// Registers the pending request first and publishes the event after (the host's order).
    pub fn ask_permission(&self, req: &str, intent: ToolIntent) -> PendingRequest {
        let ctx = self.ctx.lock().unwrap().clone();
        let p = pending_permission(AGENT, req, "tool-1", &intent, &ctx, &LowList::default(), self.clock.now_ms());
        self.table.register(p.clone());
        self.publish(EventKind::PermissionRequest { req_id: req.into(), tool_id: "tool-1".into(), intent, options: vec![PermissionOption::AllowOnce, PermissionOption::Deny], session_allow: None, plan: None, plan_truncated: None, modes: Vec::new() });
        p
    }

    pub fn ask_question(&self, req: &str, prompt: &str) -> PendingRequest {
        let p = pending_question(AGENT, req, Some("tool-q"), prompt, self.clock.now_ms());
        self.table.register(p.clone());
        self.publish(EventKind::QuestionRequest { req_id: req.into(), tool_id: Some("tool-q".into()), prompt: prompt.into(), options: vec![intely_agent_core::events::QuestionOption { label: "Yes".into(), description: None }, intely_agent_core::events::QuestionOption { label: "No".into(), description: None }] });
        p
    }

    /// The desktop answers (the fake desktop side of first-answer-wins).
    pub fn desktop_allow(&self, req: &str) -> Result<Resolution, HubError> {
        self.answer_permission(req, AGENT, PermissionDecision::AllowOnce, None, &Origin::Desktop)
    }
}

impl AgentHub for FakeHub {
    fn list_runs(&self) -> Vec<AgentSummary> {
        self.runs.lock().unwrap().clone()
    }
    fn pending_requests(&self) -> Vec<PendingRequest> {
        self.table.open()
    }
    fn policy_context(&self, _agent_id: &str) -> Option<PolicyContext> {
        Some(self.ctx.lock().unwrap().clone())
    }
    fn log(&self) -> Arc<dyn EventLog> {
        self.log.clone()
    }
    fn bus(&self) -> EventBus {
        self.bus.clone()
    }
    fn send_prompt(&self, agent_id: &str, text: &str, mode: PromptMode, origin: &Origin) -> Result<(), HubError> {
        self.prompts.lock().unwrap().push((agent_id.into(), text.into(), mode, origin.clone()));
        Ok(())
    }
    fn answer_permission(&self, req_id: &str, agent_id: &str, decision: PermissionDecision, intent_hash: Option<&str>, origin: &Origin) -> Result<Resolution, HubError> {
        self.table.resolve(req_id, agent_id, PendingKind::Permission, intent_hash, origin, self.clock.now_ms())?;
        self.permission_answers.lock().unwrap().push((req_id.into(), decision, origin.clone()));
        let outcome = if matches!(decision, PermissionDecision::Deny) { PermissionOutcome::Deny } else { PermissionOutcome::Allow };
        self.publish_for(agent_id, EventKind::PermissionResolved { req_id: req_id.into(), outcome, by: DecidedBy::User });
        Ok(Resolution { req_id: req_id.into(), agent_id: agent_id.into(), origin: origin.clone() })
    }
    fn answer_question(&self, req_id: &str, agent_id: &str, _answer: QuestionAnswer, intent_hash: Option<&str>, origin: &Origin) -> Result<Resolution, HubError> {
        self.table.resolve(req_id, agent_id, PendingKind::Question, intent_hash, origin, self.clock.now_ms())?;
        self.question_answers.lock().unwrap().push((req_id.into(), origin.clone()));
        Ok(Resolution { req_id: req_id.into(), agent_id: agent_id.into(), origin: origin.clone() })
    }
    fn interrupt(&self, agent_id: &str, origin: &Origin) -> Result<(), HubError> {
        self.interrupts.lock().unwrap().push((agent_id.into(), origin.clone()));
        Ok(())
    }
    fn start_run(&self, start: StartParams, origin: &Origin) -> Result<AgentSummary, HubError> {
        if start.template_id != "tpl-ok" {
            return Err(HubError::Unavailable("template is not remoteStartable".into()));
        }
        self.starts.lock().unwrap().push((start, origin.clone()));
        Ok(summary("agent-new"))
    }
    fn resolved_origin(&self, req_id: &str) -> Option<Origin> {
        self.table.resolved_origin(req_id)
    }
    fn disable_claude_remote_control(&self) -> usize {
        self.rc_disabled.fetch_add(1, Ordering::SeqCst);
        2
    }
}

/// A paired fake phone with a passkey.
pub struct Phone {
    pub key: StaticKey,
    pub device_id: String,
    pub passkey: SigningKey,
    pub credential_id: String,
    pub counter: u32,
    pub session: Option<PhoneSession>,
    pub inbox: Vec<ServerMsg>,
    pub op: u32,
}

impl Phone {
    pub fn next_op(&mut self) -> String {
        self.op += 1;
        format!("op-{}", self.op)
    }
}

pub struct Env {
    pub dir: tempfile::TempDir,
    pub clock: ManualClock,
    pub hub: Arc<FakeHub>,
    pub store: Arc<Store>,
    pub core: GatewayCore,
    pub secrets: Arc<dyn SecretStore>,
    pub host: Vec<HostEvent>,
    pub admin: Vec<intely_remote::transport::Admin>,
}

pub fn cfg() -> GatewayCfg {
    GatewayCfg { mac_name: "Test Mac".into(), rp_id: "relay.localhost".into(), origin: "https://relay.localhost".into(), relay_host: "relay.localhost".into(), ..GatewayCfg::default() }
}

impl Env {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::new(T0);
        let hub = FakeHub::new(dir.path(), clock.clone());
        let secrets: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::new());
        let store = Store::open(&dir.path().join("state"), secrets.clone(), Arc::new(clock.clone())).unwrap();
        let core = GatewayCore::new(cfg(), hub.clone(), store.clone());
        Self { dir, clock, hub, store, core, secrets, host: vec![], admin: vec![] }
    }

    pub fn mac_pub(&self) -> [u8; 32] {
        self.store.identity().static_key.public
    }

    /// Splits core outputs into frames for `link` and bookkeeping (host events, admin).
    pub fn route(&mut self, outs: Vec<Out>, link: &str) -> Vec<Vec<u8>> {
        let mut frames = Vec::new();
        for o in outs {
            match o {
                Out::Frame { link: l, bytes } if l == link => frames.push(bytes),
                Out::Frame { .. } | Out::Close(_) => {}
                Out::Admin(a) => self.admin.push(a),
                Out::Host(h) => self.host.push(h),
            }
        }
        frames
    }

    /// Full pairing; the Mac user accepts with `cap`. The phone has a passkey registered.
    pub fn pair(&mut self, name: &str, cap: Capability) -> Phone {
        let key = StaticKey::generate();
        let passkey = SigningKey::from_bytes(&p256::FieldBytes::from(intely_remote::util::random::<32>())).unwrap();
        let (view, outs) = self.core.pair_start();
        self.route(outs, "x");
        let otp = intely_remote::pairing::parse_manual_code(&view.manual_code).unwrap();
        let link = "pair-test";
        let (mut pp, first) = PhonePairing::start(key.clone(), &self.mac_pub(), &otp, name).unwrap();
        let outs = self.core.on_frame(link, &first);
        for f in self.route(outs, link) {
            for reply in pp.on_frame(&f).unwrap() {
                let outs = self.core.on_frame(link, &reply);
                self.route(outs, link);
            }
        }
        // register a passkey inside the pairing channel
        let point = passkey.verifying_key().to_sec1_point(false);
        let reg = pp.send_pair_msg(&PairMsg::PasskeyRegister { credential_id: "cred-1".into(), public_key: intely_remote::util::b64u(point.as_bytes()) }).unwrap();
        let outs = self.core.on_frame(link, &reg);
        self.route(outs, link);
        let sas = self.host.iter().rev().find_map(|h| if let HostEvent::PairingSas { code, .. } = h { Some(code.clone()) } else { None }).expect("SAS shown on the Mac");
        assert_eq!(Some(sas), pp.sas.clone(), "both screens show the same 6 digits");
        let outs = self.core.pair_confirm(true, None, cap);
        for f in self.route(outs, link) {
            pp.on_frame(&f).unwrap();
        }
        let acc = pp.accepted.clone().expect("accepted");
        Phone { key, device_id: acc.device_id, passkey, credential_id: "cred-1".into(), counter: 0, session: None, inbox: vec![], op: 0 }
    }

    /// IK reconnect; returns what the Mac sent on connect (hello, snapshot).
    pub fn connect(&mut self, p: &mut Phone) -> Vec<ServerMsg> {
        let (mut s, first) = PhoneSession::connect(&p.key, &self.mac_pub()).unwrap();
        let outs = self.core.on_frame(&p.device_id, &first);
        let mut got = Vec::new();
        for f in self.route(outs, &p.device_id.clone()) {
            if let Some(m) = s.on_frame(&f).unwrap() {
                got.push(m);
            }
        }
        p.session = Some(s);
        p.inbox.extend(got.clone());
        got
    }

    pub fn deliver(&mut self, p: &mut Phone, outs: Vec<Out>) -> Vec<ServerMsg> {
        let mut got = Vec::new();
        for f in self.route(outs, &p.device_id.clone()) {
            if let Some(s) = p.session.as_mut() {
                if let Ok(Some(m)) = s.on_frame(&f) {
                    got.push(m);
                }
            }
        }
        p.inbox.extend(got.clone());
        got
    }

    pub fn send(&mut self, p: &mut Phone, msg: ClientMsg) -> Vec<ServerMsg> {
        let frame = p.session.as_mut().unwrap().send(&msg).unwrap();
        let outs = self.core.on_frame(&p.device_id, &frame);
        self.deliver(p, outs)
    }

    pub fn sync(&mut self, p: &mut Phone, last: &[(&str, u64)]) -> Vec<ServerMsg> {
        let map = last.iter().map(|(a, n)| (a.to_string(), *n)).collect();
        self.send(p, ClientMsg::Sync { last_seq: map })
    }

    /// Publishes nothing; feeds one event the bus would carry to the core and delivers the result to the phone.
    pub fn live(&mut self, p: &mut Phone, e: &AgentEvent) -> Vec<ServerMsg> {
        let outs = self.core.on_event(e);
        self.deliver(p, outs)
    }

    pub fn ack_of(msgs: &[ServerMsg], op: &str) -> Option<(bool, Option<String>)> {
        msgs.iter().find_map(|m| match m {
            ServerMsg::Ack { op_id, ok, code, .. } if op_id == op => Some((*ok, code.clone())),
            _ => None,
        })
    }

    /// A passkey assertion for a challenge, exactly as an authenticator would produce it.
    pub fn assertion(&self, p: &mut Phone, challenge_b64: &str, rp_id: &str, origin: &str) -> StepUpProof {
        use intely_remote::util::sha256;
        p.counter += 1;
        let client = serde_json::json!({"type": "webauthn.get", "challenge": challenge_b64, "origin": origin}).to_string();
        let mut auth = sha256(rp_id.as_bytes()).to_vec();
        auth.push(0x05);
        auth.extend_from_slice(&p.counter.to_be_bytes());
        let mut signed = auth.clone();
        signed.extend_from_slice(&sha256(client.as_bytes()));
        let sig: Signature = p.passkey.sign(&signed);
        StepUpProof {
            credential_id: p.credential_id.clone(),
            authenticator_data: intely_remote::util::b64u(&auth),
            client_data_json: intely_remote::util::b64u(client.as_bytes()),
            signature: intely_remote::util::b64u(sig.to_der().as_bytes()),
        }
    }

    /// Asks for a challenge and answers it correctly; returns the proof.
    pub fn step_up(&mut self, p: &mut Phone, key: &str) -> StepUpProof {
        let op = p.next_op();
        let msgs = self.send(p, ClientMsg::StepUpBegin { op_id: op, req_id: key.into() });
        let ch = msgs.iter().find_map(|m| if let ServerMsg::StepUpChallenge { challenge, .. } = m { Some(challenge.clone()) } else { None }).expect("challenge");
        self.assertion(p, &ch, "relay.localhost", "https://relay.localhost")
    }
}

pub fn intent_hash_of(env: &Env, req: &str) -> String {
    env.hub.table.get(req).unwrap().intent_hash
}
