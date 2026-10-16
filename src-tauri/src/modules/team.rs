//! Tauri glue of Team (docs/team.md, phase T1): commands and state on top of `intely_team`. Listed under the "team commands" marker in
//! `lib.rs`; the state is created in `setup`.
//!
//! Zero cost when unused: `setup` creates an empty state and, only if a `team.json` already exists, resumes the relay link in the
//! background. The webview never sees keys, tokens or Noise state, only [`TeamView`], the one-time invite and the 6-digit codes.
//! Creating, inviting, approving, revoking and leaving are commands only the webview can call (an agent has no IPC path to them).
//!
//! Events: `team:changed {view}` after any change, `team:presence {id, online, state}` when a member comes or goes.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use intely_core::EngineError;
use intely_remote::relay_ws::{parse_relay, RelayTrust};
use intely_settings::{SecretStore, SettingsStore};
use intely_team::audit::{event, TeamAudit};
use intely_team::client::{out, In, LinkHandle, ServerMsg, TeamWs};
use intely_team::envelope::Envelope;
use intely_team::identity::Identity;
use intely_team::inbox::{AckGate, Verdict};
use intely_team::invite::{InviteCode, Joined, Joiner, Offer, Pending, OFFER_TTL_MS};
use intely_team::roster::Role;
use intely_team::share::{RunStore, ShareMsg};
use intely_team::state::TeamState;
use intely_team::wire::{frame, tag, unframe};
use intely_team::TeamError;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;

use super::settings::SettingsState;

pub mod collab;
pub mod memsync;
pub mod share;

type Res<T> = Result<T, EngineError>;

const NS: &str = "team";
const DEFAULT_RELAY: &str = "ws://127.0.0.1:8787";

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn err(code: &str, message: impl Into<String>) -> EngineError {
    EngineError::new(code, message)
}

fn team_err(e: TeamError) -> EngineError {
    match e {
        TeamError::InviteSpent => err("inviteSpent", "the invite is expired or already used"),
        TeamError::Full => err("full", "the team is full"),
        TeamError::NotAdmin => err("notAdmin", "only an admin can do this"),
        TeamError::Transport(c) if c == intely_team::client::RELAY_OLD => err("relayOld", "the relay does not support teams yet; update it in Settings > Remote"),
        TeamError::Transport(c) => err("relay", c),
        // the relay refusal codes of the Remote link (`hostNotAllowed`, `readOnly`, ...) arrive as `code: message`
        TeamError::Crypto(m) | TeamError::Invalid(m) => match m.split_once(": ") {
            Some((code @ ("invalidCode" | "urlSyntax" | "scheme" | "userinfo" | "ipLiteral" | "idn" | "insecure" | "readOnly" | "testJail" | "hostNotAllowed"), rest)) => err(code, rest.to_string()),
            _ => err("team", m),
        },
        other => err("team", other.to_string()),
    }
}

// ---------------------------------------------------------------- views

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MemberRow {
    id: String,
    name: String,
    role: String,
    online: bool,
    state: String,
    me: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InviteView {
    /// The text the joiner pastes; also the QR payload.
    code: String,
    qr: String,
    expires_at: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JoinRequestView {
    id: String,
    name: String,
    sas: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JoiningView {
    /// `connecting`, `waitingAdmin`, `confirm`, `waitingWelcome`.
    stage: String,
    sas: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TeamView {
    /// `none`, `joining` or `member`.
    state: String,
    team_id: Option<String>,
    relay: String,
    epoch: u32,
    connected: bool,
    role: Option<String>,
    members: Vec<MemberRow>,
    invite: Option<InviteView>,
    join_request: Option<JoinRequestView>,
    joining: Option<JoiningView>,
    audit_entries: u64,
    /// The relay closed this member's socket as removed. Nothing is wiped until the person confirms (`team_forget`).
    removed: bool,
    /// The audit log could not be opened (for example it was changed outside the app); Team keeps working without it.
    audit_error: Option<String>,
    /// The last frame that had to be given up, or another problem the person should know about.
    error: Option<String>,
}

// ---------------------------------------------------------------- state

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Connecting,
    WaitingAdmin,
    Confirm,
    WaitingWelcome,
}

impl Stage {
    fn as_str(self) -> &'static str {
        match self {
            Stage::Connecting => "connecting",
            Stage::WaitingAdmin => "waitingAdmin",
            Stage::Confirm => "confirm",
            Stage::WaitingWelcome => "waitingWelcome",
        }
    }
}

struct Joining {
    code: InviteCode,
    name: String,
    stage: Stage,
    joiner: Option<Joiner>,
    joined: Option<Joined>,
    sas: Option<String>,
    welcome: Option<Vec<u8>>,
    confirmed: bool,
    /// This join added the relay host to `team.trustedRelayHosts` (the person ticked the box): a join that ends without a team takes it back.
    acknowledged: bool,
}

struct AdminJoin {
    offer: Offer,
    code: String,
    from: Option<String>,
    pending: Option<Pending>,
    verified: bool,
}

#[derive(Default)]
struct Inner {
    identity: Option<Identity>,
    team: Option<TeamState>,
    audit: Option<TeamAudit>,
    state_dir: Option<PathBuf>,
    tx: Option<mpsc::Sender<Value>>,
    pump: Option<tauri::async_runtime::JoinHandle<()>>,
    connected: bool,
    online: std::collections::HashMap<String, (bool, String)>,
    /// The version of the roster the relay holds (for `roster.put`'s compare-and-swap).
    relay_roster: u64,
    admin_join: Option<AdminJoin>,
    joining: Option<Joining>,
    gate: AckGate,
    audit_error: Option<String>,
    error: Option<String>,
    removed: bool,
    /// What the other members share (T2); in memory only.
    store: RunStore,
    /// Notes and workspace snapshots (T3, T4); in memory only.
    collab: collab::Collab,
    /// Events for the webview collected under the lock and emitted after it (`team:runs`, `team:run-events`).
    ui: Vec<(&'static str, Value)>,
    share: Arc<share::Share>,
    last_save: Option<std::time::Instant>,
    /// For the one thing a join that ends without a team must undo: the relay host the person acknowledged for it (`Joining::acknowledged`).
    settings: Option<Arc<SettingsStore>>,
}

pub struct TeamModState {
    inner: Mutex<Inner>,
    share: Arc<share::Share>,
    settings: Option<Arc<SettingsStore>>,
    secrets: Option<Arc<dyn SecretStore>>,
}

/// Called once from `setup`. Starts the relay link in the background only if this install already is in a team.
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let parts = app.try_state::<SettingsState>().and_then(|s| s.parts());
    let (settings, secrets) = match parts {
        Some((s, k)) => (Some(s), Some(k)),
        None => (None, None),
    };
    let share = Arc::new(share::Share::default());
    share::init(&share, settings.as_ref());
    app.manage(TeamModState { inner: Mutex::new(Inner { share: share.clone(), settings: settings.clone(), ..Inner::default() }), share, settings, secrets });
    memsync::start(app.handle());
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        // the agent slot (which knows the data folder) is managed later in the same setup
        for _ in 0..100 {
            if handle.try_state::<crate::agents::AgentSlot>().is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let _ = resume(&handle);
    });
    Ok(())
}

/// `RunEvent::Exit`: the socket ends with the app.
pub fn shutdown(app: &AppHandle) {
    if let Some(st) = app.try_state::<TeamModState>() {
        if let Some(p) = lock(&st.inner).pump.take() {
            p.abort();
        }
    }
}

fn parts(st: &TeamModState) -> Res<(Arc<dyn SecretStore>, Arc<SettingsStore>)> {
    match (&st.secrets, &st.settings) {
        (Some(k), Some(s)) => Ok((k.clone(), s.clone())),
        _ => Err(err("unavailable", "Settings are unavailable, so Team cannot start")),
    }
}

fn data_dir(app: &AppHandle) -> Res<PathBuf> {
    app.try_state::<crate::agents::AgentSlot>().map(|a| a.data_dir().to_path_buf()).ok_or_else(|| err("unavailable", "the agent host is not ready yet"))
}

/// Relay hosts this person acknowledged while joining a team (`team.trustedRelayHosts`), as `host[:port]` in lower case.
fn trusted_relay_hosts(team: &serde_json::Map<String, Value>) -> Vec<String> {
    team.get("trustedRelayHosts").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_ascii_lowercase).collect()).unwrap_or_default()
}

/// The relay the team lives on: `team.relayUrl` if set, else the Remote relay, else the local development relay. The host rules
/// (acknowledged hosts, jails) are the Remote ones, plus the hosts the person acknowledged when joining a team.
fn relay_base(settings: &SettingsStore) -> (String, RelayTrust) {
    let team = settings.get(NS).unwrap_or_default();
    let remote = settings.get("remote").unwrap_or_default();
    let url = team.get("relayUrl").and_then(Value::as_str).filter(|s| !s.is_empty()).or_else(|| remote.get("relayUrl").and_then(Value::as_str)).unwrap_or(DEFAULT_RELAY).to_string();
    let mut allowed_hosts: Vec<String> = remote.get("trust").and_then(|t| t.get("allowedHosts")).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_ascii_lowercase).collect()).unwrap_or_default();
    allowed_hosts.extend(trusted_relay_hosts(&team));
    (url, RelayTrust { allowed_hosts, jail: super::remote::relay_jail(), resolver: None })
}

/// At most this many relay hosts are kept as acknowledged by joins.
const MAX_TRUSTED_RELAYS: usize = 16;

/// Remembers a relay host the person acknowledged while joining. `Ok(true)` when it was not there before.
fn remember_relay_host(settings: &SettingsStore, authority: &str) -> Res<bool> {
    let mut hosts = trusted_relay_hosts(&settings.get(NS).unwrap_or_default());
    let host = authority.to_ascii_lowercase();
    if hosts.contains(&host) {
        return Ok(false);
    }
    hosts.push(host);
    while hosts.len() > MAX_TRUSTED_RELAYS {
        hosts.remove(0);
    }
    let mut patch = serde_json::Map::new();
    patch.insert("trustedRelayHosts".into(), Value::from(hosts));
    settings.set(NS, patch).map_err(|e| err("settings", e.to_string()))?;
    Ok(true)
}

/// The inverse: the host of this relay URL is no longer acknowledged by a join (it stays acknowledged when Remote lists it).
fn forget_relay_host(settings: &SettingsStore, relay: &str) {
    let Ok(parsed) = parse_relay(relay) else { return };
    let host = parsed.authority().to_ascii_lowercase();
    let mut hosts = trusted_relay_hosts(&settings.get(NS).unwrap_or_default());
    let before = hosts.len();
    hosts.retain(|h| *h != host);
    if hosts.len() != before {
        let mut patch = serde_json::Map::new();
        patch.insert("trustedRelayHosts".into(), Value::from(hosts));
        let _ = settings.set(NS, patch);
    }
}

fn remember_name(settings: &SettingsStore, name: &str) {
    let mut patch = serde_json::Map::new();
    patch.insert("displayName".into(), Value::String(name.to_string()));
    let _ = settings.set(NS, patch);
}

fn clean_name(name: &str) -> Res<String> {
    let n: String = name.trim().chars().filter(|c| !c.is_control()).take(60).collect();
    if n.is_empty() {
        return Err(err("name", "give yourself a name the team can see"));
    }
    Ok(n)
}

fn audit(inner: &mut Inner, ev: &str, member: Option<&str>, detail: Option<&str>) {
    if let Some(a) = inner.audit.as_mut() {
        let _ = a.record(ev, member, detail, now_ms());
    }
}

/// Saves the team state if it changed. `false` when the file could not be written (the caller must not go on as if it had).
fn save(inner: &mut Inner, secrets: &Arc<dyn SecretStore>) -> bool {
    if let (Some(t), Some(dir)) = (inner.team.as_mut(), inner.state_dir.as_ref()) {
        if t.take_dirty() {
            if let Err(e) = t.save(dir, secrets) {
                inner.error = Some(format!("the team state could not be saved: {e}"));
                return false;
            }
        }
    }
    true
}

/// Opens the audit log. A log that was changed outside the app is reported to the person instead of silently turning auditing off.
fn open_audit(inner: &mut Inner, dir: &std::path::Path, secrets: &Arc<dyn SecretStore>) {
    match TeamAudit::open(dir, secrets.clone()) {
        Ok(a) => {
            inner.audit = Some(a);
            inner.audit_error = None;
        }
        Err(e) => {
            inner.audit = None;
            inner.audit_error = Some(e.to_string());
        }
    }
}

fn view(inner: &Inner) -> TeamView {
    let (state, team_id, relay) = match (&inner.team, &inner.joining) {
        (Some(t), _) => ("member", Some(t.team_id.clone()), t.relay.clone()),
        (None, Some(j)) => ("joining", Some(j.code.team_id.clone()), j.code.relay.clone()),
        _ => ("none", None, String::new()),
    };
    let members = inner
        .team
        .as_ref()
        .map(|t| {
            t.body()
                .members
                .iter()
                .map(|m| {
                    let me = m.id == t.me;
                    let (online, st) = inner.online.get(&m.id).cloned().unwrap_or((false, String::new()));
                    MemberRow { id: m.id.clone(), name: m.name.clone(), role: if m.role == Role::Admin { "admin" } else { "member" }.into(), online: online || (me && inner.connected), state: st, me }
                })
                .collect()
        })
        .unwrap_or_default();
    let now = now_ms();
    TeamView {
        state: state.into(),
        team_id,
        relay,
        epoch: inner.team.as_ref().map_or(0, TeamState::epoch),
        connected: inner.connected,
        role: inner.team.as_ref().and_then(TeamState::role).map(|r| if r == Role::Admin { "admin" } else { "member" }.to_string()),
        members,
        invite: inner.admin_join.as_ref().filter(|j| j.offer.is_open(now)).map(|j| InviteView { code: j.code.clone(), qr: j.code.clone(), expires_at: j.offer.expires_at }),
        join_request: inner.admin_join.as_ref().filter(|j| j.verified).and_then(|j| j.pending.as_ref()).map(|p| JoinRequestView { id: p.joiner.id.clone(), name: p.joiner.name.clone(), sas: p.sas.clone() }),
        joining: inner.joining.as_ref().map(|j| JoiningView { stage: j.stage.as_str().into(), sas: j.sas.clone() }),
        audit_entries: inner.audit.as_ref().map_or(0, TeamAudit::len),
        removed: inner.removed,
        audit_error: inner.audit_error.clone(),
        error: inner.error.clone(),
    }
}

fn emit_changed(app: &AppHandle, inner: &Inner) {
    inner.share.set_team(inner.team.is_some());
    let _ = app.emit("team:changed", view(inner));
}

/// `false` when the frame could not be handed to the link. Anything that must not be lost lives in the saved outbox and is sent
/// again on reconnect, so a refusal here is not an error for those.
fn send(inner: &Inner, v: Value) -> bool {
    inner.tx.as_ref().is_some_and(|tx| tx.try_send(v).is_ok())
}

/// A handshake frame: delivered now or not at all (it must not wait in a queue).
fn direct(inner: &Inner, to: &str, t: u8, body: &[u8]) -> bool {
    send(inner, out::direct(to, &frame(t, body), false, "hs"))
}

// ---------------------------------------------------------------- link

fn start_link(app: &AppHandle, inner: &mut Inner, ws: TeamWs, team_id: &str) -> Res<()> {
    let id = inner.identity.clone().ok_or_else(|| err("team", "no identity"))?;
    if let Some(p) = inner.pump.take() {
        p.abort();
    }
    let mut link: LinkHandle = ws.spawn(team_id, &id);
    let tx = link.tx.clone();
    inner.tx = Some(tx);
    let handle = app.clone();
    inner.pump = Some(tauri::async_runtime::spawn(async move {
        // the task owns the handle: aborting it closes the socket
        while let Some(m) = link.rx.recv().await {
            on_link(&handle, m);
        }
    }));
    Ok(())
}

fn st(app: &AppHandle) -> State<'_, TeamModState> {
    app.state::<TeamModState>()
}

/// Everything the relay link reports. Runs on the pump task; state is touched under the lock, sends are non-blocking.
fn on_link(app: &AppHandle, m: In) {
    let state = st(app);
    let Ok((secrets, _)) = parts(&state) else { return };
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    match m {
        In::Connected => {
            inner.connected = true;
        }
        In::Disconnected => {
            inner.connected = false;
            for v in inner.online.values_mut() {
                v.0 = false;
            }
        }
        In::Revoked => {
            // The relay says this member was removed. A hostile or confused relay could say so too, so nothing is wiped here: the
            // person is told and decides (`team_forget`). The link has stopped.
            inner.removed = true;
            inner.connected = false;
            audit(inner, event::REJECTED, None, Some("closed 4401"));
        }
        In::Msg(msg) => on_server(app, inner, &secrets, msg),
    }
    for (name, payload) in inner.ui.drain(..) {
        let _ = app.emit(name, payload);
    }
    emit_changed(app, inner);
}

fn reset(inner: &mut Inner, secrets: &Arc<dyn SecretStore>) {
    if let Some(p) = inner.pump.take() {
        p.abort();
    }
    inner.tx = None;
    inner.team = None;
    if let (Some(j), Some(settings)) = (inner.joining.as_ref(), inner.settings.as_ref()) {
        if j.acknowledged {
            forget_relay_host(settings, &j.code.relay);
        }
    }
    inner.joining = None;
    inner.admin_join = None;
    inner.connected = false;
    inner.online.clear();
    inner.relay_roster = 0;
    inner.removed = false;
    inner.error = None;
    // the threads of this machine's own runs hold teammates' words: they go with the team
    if let Some(dir) = inner.state_dir.as_ref() {
        let _ = std::fs::remove_dir_all(dir.join(collab::CHAT_DIR));
    }
    share::forget_all(inner);
    inner.identity = Identity::rotate(secrets).ok();
}

fn on_server(app: &AppHandle, inner: &mut Inner, secrets: &Arc<dyn SecretStore>, msg: ServerMsg) {
    match msg {
        ServerMsg::Hello(h) => {
            inner.gate.new_connection();
            inner.online = h.members.iter().map(|m| (m.id.clone(), (m.online, m.state.clone()))).collect();
            // a joiner starts its handshake as soon as the relay accepted its credentials
            let go = inner.joining.as_ref().is_some_and(|j| j.stage == Stage::Connecting);
            if go {
                start_handshake(inner);
            }
            if inner.team.is_some() {
                announce(inner);
                // anything decided while offline (a removal, a key hand-over) goes out again now
                resend_pending(inner);
            }
        }
        ServerMsg::Presence { id, online, state } => {
            inner.online.insert(id.clone(), (online, state.clone()));
            if online && inner.team.as_ref().is_some_and(|t| t.me != id) {
                inner.share.send(share::Cmd::Snapshot(id.clone()));
            }
            let _ = app.emit("team:presence", serde_json::json!({ "id": id, "online": online, "state": state }));
        }
        ServerMsg::MemberRevoked(id) => {
            inner.online.remove(&id);
            share::member_gone(inner, &id);
            // Somebody left (or was removed by another admin client): a member still on our roster means the key must change.
            let still_listed = inner.team.as_ref().is_some_and(|t| t.is_admin() && t.body().member(&id).is_some_and(|m| m.role == Role::Member));
            if still_listed {
                if let Err(e) = revoke_member(inner, secrets, &id) {
                    inner.error = Some(e.message);
                }
            }
        }
        ServerMsg::MemberPending(id) => {
            if let Some(aj) = inner.admin_join.as_mut() {
                aj.offer.set_redeemer(&id);
            }
        }
        ServerMsg::BlobChanged { .. } => memsync::poke(),
        // The relay let this member in. A joiner that finished before that moment was still "pending" when it announced itself.
        ServerMsg::MemberJoined(id) => {
            if inner.team.is_some() && inner.identity.as_ref().is_some_and(|i| i.member_id == id) {
                announce(inner);
            }
        }
        ServerMsg::Other => {}
        ServerMsg::RosterChanged(_) => {
            send(inner, out::roster_get());
        }
        ServerMsg::Reply(v) => on_reply(inner, secrets, &v),
        ServerMsg::Msg(m) => {
            // Applied and saved first, acknowledged after: an acknowledged frame is gone from the relay for good.
            let ok = on_payload(app, inner, secrets, &m.from, &m.p);
            match inner.gate.handled(m.qid, ok) {
                Verdict::Ack(q) => {
                    send(inner, out::ack(q));
                }
                Verdict::GaveUp(q) => {
                    inner.error = Some("A message from another member could not be applied and was dropped.".into());
                    audit(inner, event::REJECTED, Some(&m.from), Some("dropped after retries"));
                    send(inner, out::ack(q));
                }
                Verdict::NoAck => {}
            }
        }
    }
}

/// Tells the team this member is here and asks for what the others share: on every connect, and right after joining (a socket that
/// was opened before the person confirmed the code has already said hello, to nobody).
fn announce(inner: &mut Inner) {
    for f in out::announce() {
        send(inner, f);
    }
    share::send_share(inner, &intely_team::share::Dest::All, &ShareMsg::Request);
    memsync::poke();
}

/// Sends what is saved as unconfirmed: first the relay-side removals (they free the removed member's queued rows), then the key
/// hand-overs, then the roster. Each is answered with an `ok` that clears it (`on_reply`).
fn resend_pending(inner: &mut Inner) {
    let Some(team) = inner.team.as_ref() else { return };
    let revokes: Vec<String> = team.pending_revokes().to_vec();
    let outbox = team.outbox().to_vec();
    for id in revokes {
        send(inner, out::with_op(out::member_revoke(&id), &format!("rv:{id}")));
    }
    for item in outbox {
        send(inner, out::direct(&item.to, &item.payload, true, &format!("rk:{}", item.to)));
    }
    publish_roster(inner);
}

/// Admin: removes a member and starts the next key epoch. The decision is saved (outbox and pending removal included) before a
/// single frame is sent; if the save fails nothing changes and nothing is sent.
fn revoke_member(inner: &mut Inner, secrets: &Arc<dyn SecretStore>, target: &str) -> Res<u32> {
    let (Some(team), Some(admin)) = (inner.team.as_ref(), inner.identity.clone()) else { return Err(err("notInTeam", "create or join a team first")) };
    let dir = inner.state_dir.clone().ok_or_else(|| err("unavailable", "no data folder"))?;
    let mut next = team.clone();
    let rev = next.revoke(&admin, target, now_ms()).map_err(team_err)?;
    next.save(&dir, secrets).map_err(team_err)?;
    inner.team = Some(next);
    inner.online.remove(target);
    audit(inner, event::MEMBER_REVOKED, Some(target), None);
    audit(inner, event::KEY_ROTATED, None, Some(&format!("epoch {}", rev.epoch)));
    resend_pending(inner);
    Ok(rev.epoch)
}

fn on_reply(inner: &mut Inner, secrets: &Arc<dyn SecretStore>, v: &Value) {
    if memsync::deliver(v) {
        return;
    }
    let op = v["op"].as_str().unwrap_or("");
    let code = v["code"].as_str().unwrap_or("");
    match (v["t"].as_str(), v["re"].as_str()) {
        (Some("roster"), _) => {
            let cur = &v["current"];
            inner.relay_roster = cur["version"].as_u64().unwrap_or(0);
            let mut relay_version = 0;
            if let (Some(p), Some(team)) = (cur["p"].as_str(), inner.team.as_mut()) {
                match team.open_roster(p) {
                    Ok(signed) => {
                        relay_version = signed.parse().map_or(0, |b| b.version);
                        if team.apply_roster(signed).unwrap_or(false) {
                            save(inner, secrets);
                        }
                    }
                    // the key of that epoch has not reached us yet: the rekey will, and then the roster is read again
                    Err(TeamError::NoKey(_)) => {}
                    Err(_) => audit(inner, event::REJECTED, None, Some("roster payload")),
                }
            }
            // the relay holds nothing, or an older roster than ours: an admin publishes
            let behind = inner.team.as_ref().is_some_and(|t| t.is_admin() && t.body().version > relay_version);
            if behind {
                publish_roster(inner);
            }
        }
        (Some("ok"), Some("roster.put")) => {
            if let Some(ver) = v["version"].as_u64() {
                inner.relay_roster = ver;
            }
        }
        (Some("err"), Some("roster.put")) => {
            // somebody else wrote first: read what is there; an admin whose roster is newer publishes on top of it
            send(inner, out::roster_get());
        }
        (Some("ok"), Some("direct")) | (Some("err"), Some("direct")) if op.starts_with("rk:") => {
            // handed to the relay (delivered or queued), or the recipient is gone: either way it is not ours to resend
            if v["t"] == "ok" || code == "unknown" {
                if let Some(t) = inner.team.as_mut() {
                    t.outbox_done(&op[3..]);
                }
                save(inner, secrets);
            }
        }
        (Some("ok"), Some("member.revoke")) | (Some("err"), Some("member.revoke")) if op.starts_with("rv:") => {
            if v["t"] == "ok" || matches!(code, "unknown" | "admin") {
                if let Some(t) = inner.team.as_mut() {
                    t.revoke_done(&op[3..]);
                }
                save(inner, secrets);
            }
        }
        _ => {}
    }
}

fn publish_roster(inner: &Inner) {
    if let Some(t) = &inner.team {
        if let Ok(p) = t.seal_roster() {
            send(inner, out::roster_put(inner.relay_roster, &p));
        }
    }
}

/// A frame from another member (`direct` or `fanout`): the tag says what it is. `true` = handled (applied and saved, or nothing to
/// do), `false` = it failed and must not be acknowledged.
fn on_payload(app: &AppHandle, inner: &mut Inner, secrets: &Arc<dyn SecretStore>, from: &str, p: &str) -> bool {
    let Ok((t, body)) = unframe(p) else { return false };
    let now = now_ms();
    match t {
        tag::JOIN_INIT => {
            let Some(aj) = inner.admin_join.as_mut() else { return true };
            let Some(admin) = inner.identity.as_ref() else { return true };
            // a handshake that never produced its hello is dropped (and counts as a failed attempt)
            let stale = match &aj.pending {
                Some(p) => aj.offer.drop_stale(p, now),
                None => false,
            };
            if stale {
                aj.pending = None;
                aj.from = None;
                aj.verified = false;
            }
            if aj.pending.is_some() {
                return true;
            }
            // only the member that redeemed this invite is heard; everybody else costs nothing and leaves no trace
            let redeemer = aj.offer.is_redeemer(from);
            match aj.offer.accept(admin, from, &body, now) {
                Ok(pending) => {
                    let resp = frame(tag::JOIN_RESP, &pending.msg2);
                    aj.from = Some(from.to_string());
                    aj.pending = Some(pending);
                    aj.verified = false;
                    send(inner, out::direct(from, &resp, false, "hs"));
                }
                Err(_) if redeemer => audit(inner, event::INVITE_FAILED, Some(from), Some("handshake")),
                Err(_) => {}
            }
            true
        }
        tag::JOIN_HELLO => {
            let Some(aj) = inner.admin_join.as_mut() else { return true };
            if aj.from.as_deref() != Some(from) {
                return true;
            }
            let Some(mut pending) = aj.pending.take() else { return true };
            match aj.offer.hello(&mut pending, from, &body, now) {
                Ok(()) => {
                    aj.pending = Some(pending);
                    aj.verified = true;
                }
                Err(_) => {
                    aj.from = None;
                    audit(inner, event::INVITE_FAILED, Some(from), Some("hello"));
                }
            }
            true
        }
        tag::JOIN_RESP => {
            let Some(j) = inner.joining.as_mut() else { return true };
            if from != j.code.admin_id {
                return true;
            }
            let Some(joiner) = j.joiner.take() else { return true };
            match joiner.on_msg2(&body) {
                Ok(mut joined) => {
                    let hello = joined.hello();
                    j.sas = Some(joined.sas.clone());
                    j.joined = Some(joined);
                    j.stage = Stage::Confirm;
                    let admin = j.code.admin_id.clone();
                    if let Ok(h) = hello {
                        direct(inner, &admin, tag::JOIN_HELLO, &h);
                    }
                }
                Err(_) => abort_join(inner, secrets), // the code was wrong or the admin is not the one the invite names
            }
            true
        }
        tag::WELCOME => {
            if let Some(j) = inner.joining.as_mut() {
                if from == j.code.admin_id {
                    j.welcome = Some(body);
                    if j.stage == Stage::Confirm && j.confirmed {
                        j.stage = Stage::WaitingWelcome;
                    }
                }
            }
            try_finish(inner, secrets);
            true
        }
        tag::REKEY => {
            let (Some(team), Some(me)) = (inner.team.as_mut(), inner.identity.as_ref()) else { return true };
            match team.apply_rekey(me, p) {
                Ok(epoch) => {
                    // acknowledged only if the new key is on disk
                    if !save(inner, secrets) {
                        return false;
                    }
                    audit(inner, event::KEY_ROTATED, Some(from), Some(&format!("epoch {epoch}")));
                    // the roster at the relay is now readable
                    send(inner, out::roster_get());
                    true
                }
                Err(_) => {
                    audit(inner, event::REJECTED, Some(from), Some("rekey"));
                    false
                }
            }
        }
        tag::ENVELOPE => {
            let Some(team) = inner.team.as_mut() else { return true };
            let opened = Envelope::decode(p).and_then(|e| team.open(&e).map(|plain| (e.sender, plain)));
            match opened {
                // Shared runs (T2). Live frames only, so the replay counter is saved at most every few seconds, not on every delta.
                Ok((sender, plain)) if ShareMsg::parse(&plain).is_some() => {
                    if let Some(msg) = ShareMsg::parse(&plain) {
                        share::share_in(inner, &sender, msg);
                    }
                    if inner.last_save.is_none_or(|t| t.elapsed() > std::time::Duration::from_secs(5)) {
                        inner.last_save = Some(std::time::Instant::now());
                        return save(inner, secrets);
                    }
                    true
                }
                // Notes into a run and workspace snapshots (T3, T4): the only requests a teammate can make. Anything else is dropped below.
                Ok((sender, plain)) if intely_team::collab::CollabMsg::parse(&plain).is_some() => {
                    if let Some(msg) = intely_team::collab::CollabMsg::parse(&plain) {
                        collab::collab_in(app, inner, &sender, msg);
                    }
                    save(inner, secrets)
                }
                // Reserved: a later phase (memory) consumes the plaintext here. Unknown kinds are ignored, never acted on.
                Ok(_) => save(inner, secrets),
                // already applied (a redelivery after a reconnect)
                Err(TeamError::Replay) => true,
                Err(_) => {
                    audit(inner, event::REJECTED, Some(from), Some("envelope"));
                    false
                }
            }
        }
        _ => true,
    }
}

fn start_handshake(inner: &mut Inner) {
    let Some(me) = inner.identity.clone() else { return };
    let Some(j) = inner.joining.as_mut() else { return };
    match Joiner::start(&j.code, &me, &j.name) {
        Ok((joiner, msg1)) => {
            j.joiner = Some(joiner);
            j.stage = Stage::WaitingAdmin;
            let admin = j.code.admin_id.clone();
            direct(inner, &admin, tag::JOIN_INIT, &msg1);
        }
        Err(_) => {}
    }
}

fn abort_join(inner: &mut Inner, secrets: &Arc<dyn SecretStore>) {
    reset(inner, secrets);
}

/// The welcome arrived and the person confirmed the code: open it.
fn try_finish(inner: &mut Inner, secrets: &Arc<dyn SecretStore>) {
    let ready = inner.joining.as_ref().is_some_and(|j| j.confirmed && j.welcome.is_some() && j.joined.is_some());
    if !ready {
        return;
    }
    let (Some(mut j), Some(me)) = (inner.joining.take(), inner.identity.clone()) else { return };
    let (Some(joined), Some(welcome)) = (j.joined.take(), j.welcome.take()) else { return };
    match joined.finish(&welcome, &me) {
        Ok(mut team) => {
            if let Some(dir) = inner.state_dir.clone() {
                let _ = team.save(&dir, secrets);
            }
            inner.team = Some(team);
            audit(inner, event::MEMBER_JOINED, Some(&me.member_id), Some("self"));
            announce(inner);
        }
        Err(_) => abort_join(inner, secrets),
    }
}

// ---------------------------------------------------------------- start / resume

/// Loads an existing team from disk and connects. A no-op when this install is in no team.
fn resume(app: &AppHandle) -> Res<()> {
    let state = st(app);
    let (secrets, settings) = parts(&state)?;
    let dir = data_dir(app)?;
    if !TeamState::path_in(&dir).exists() {
        return Ok(());
    }
    let team = TeamState::load(&dir, &secrets).map_err(team_err)?.ok_or_else(|| err("team", "no team"))?;
    let identity = Identity::load_or_create(&secrets).map_err(team_err)?;
    let (_, trust) = relay_base(&settings);
    let ws = TeamWs::new_with(&team.relay, &trust).map_err(team_err)?;
    let mut inner = lock(&state.inner);
    open_audit(&mut inner, &dir, &secrets);
    inner.state_dir = Some(dir);
    inner.identity = Some(identity);
    let id = team.team_id.clone();
    inner.team = Some(team);
    start_link(app, &mut inner, ws, &id)?;
    emit_changed(app, &inner);
    Ok(())
}

fn prepare(app: &AppHandle, state: &TeamModState) -> Res<(Arc<dyn SecretStore>, Arc<SettingsStore>)> {
    let (secrets, settings) = parts(state)?;
    let dir = data_dir(app)?;
    let mut inner = lock(&state.inner);
    if inner.state_dir.is_none() {
        inner.state_dir = Some(dir.clone());
    }
    if inner.audit.is_none() && inner.audit_error.is_none() {
        open_audit(&mut inner, &dir, &secrets);
    }
    Ok((secrets, settings))
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn team_status(app: AppHandle, state: State<'_, TeamModState>) -> Res<TeamView> {
    let _ = prepare(&app, &state);
    Ok(view(&lock(&state.inner)))
}

#[tauri::command]
pub fn team_members(state: State<'_, TeamModState>) -> Res<Vec<MemberRow>> {
    Ok(view(&lock(&state.inner)).members)
}

#[tauri::command]
pub async fn team_create(app: AppHandle, state: State<'_, TeamModState>, name: String) -> Res<TeamView> {
    let name = clean_name(&name)?;
    let (secrets, settings) = prepare(&app, &state)?;
    {
        let inner = lock(&state.inner);
        if inner.team.is_some() || inner.joining.is_some() {
            return Err(err("alreadyInTeam", "this install is already in a team"));
        }
    }
    let (url, trust) = relay_base(&settings);
    let ws = TeamWs::new_with(&url, &trust).map_err(team_err)?;
    let identity = Identity::load_or_create(&secrets).map_err(team_err)?;
    let team = TeamState::create(&identity, ws.base(), &name, now_ms()).map_err(team_err)?;
    ws.create_team(&team.team_id, &identity).await.map_err(team_err)?;
    remember_name(&settings, &name);
    let mut inner = lock(&state.inner);
    let mut team = team;
    if let Some(dir) = inner.state_dir.clone() {
        team.save(&dir, &secrets).map_err(team_err)?;
    }
    let id = team.team_id.clone();
    inner.identity = Some(identity.clone());
    inner.team = Some(team);
    inner.relay_roster = 0;
    audit(&mut inner, event::TEAM_CREATED, Some(&identity.member_id), None);
    start_link(&app, &mut inner, ws, &id)?;
    emit_changed(&app, &inner);
    Ok(view(&inner))
}

/// Admin: opens a one-time invite (10 minutes, one joiner) and returns the code and the QR payload.
#[tauri::command]
pub fn team_invite(app: AppHandle, state: State<'_, TeamModState>) -> Res<InviteView> {
    prepare(&app, &state)?;
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    let (Some(team), Some(admin)) = (inner.team.as_ref(), inner.identity.as_ref()) else { return Err(err("notInTeam", "create or join a team first")) };
    if !team.is_admin() {
        return Err(err("notAdmin", "only an admin can invite"));
    }
    let now = now_ms();
    let offer = Offer::new(now);
    let code = offer.code(team, admin).to_link();
    let hash = offer.relay_token_hash();
    let expires_at = offer.expires_at;
    send(inner, out::invite_open(&hash, OFFER_TTL_MS));
    inner.admin_join = Some(AdminJoin { offer, code: code.clone(), from: None, pending: None, verified: false });
    audit(inner, event::INVITE_OPENED, None, None);
    emit_changed(&app, inner);
    Ok(InviteView { qr: code.clone(), code, expires_at })
}

/// Admin: the person compared the 6-digit code with the joiner's screen and decides.
#[tauri::command]
pub fn team_join_decide(app: AppHandle, state: State<'_, TeamModState>, accept: bool) -> Res<TeamView> {
    let (secrets, _) = prepare(&app, &state)?;
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    let aj = inner.admin_join.take().ok_or_else(|| err("noRequest", "nobody is asking to join"))?;
    let AdminJoin { pending, verified, .. } = aj;
    let (Some(pending), true) = (pending, verified) else { return Err(err("noRequest", "nobody is asking to join")) };
    let joiner_id = pending.joiner.id.clone();
    if !accept {
        send(inner, out::member_revoke(&joiner_id));
        audit(inner, event::INVITE_FAILED, Some(&joiner_id), Some("declined"));
        emit_changed(&app, inner);
        return Ok(view(inner));
    }
    let (Some(team), Some(admin)) = (inner.team.as_mut(), inner.identity.as_ref()) else { return Err(err("notInTeam", "create or join a team first")) };
    let (welcome, _roster, id) = pending.approve(team, admin, now_ms()).map_err(team_err)?;
    send_after(inner, &id, &welcome);
    publish_roster(inner);
    audit(inner, event::MEMBER_JOINED, Some(&id), None);
    save(inner, &secrets);
    emit_changed(&app, inner);
    Ok(view(inner))
}

/// The welcome goes first, then the relay lets the member in.
fn send_after(inner: &Inner, id: &str, welcome: &[u8]) {
    direct(inner, id, tag::WELCOME, welcome);
    send(inner, out::member_join(id));
}

/// What the join form shows once an invite code is pasted: the relay the code points to and whether this Mac already trusts it. It
/// reads nothing but the code and the settings: no connection is made.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinPreview {
    /// `host` or `host:port`, lower case: what the person is asked to trust.
    relay_host: String,
    /// The host is acknowledged already (Remote's list, an earlier join) or the relay is on this machine.
    trusted: bool,
    local: bool,
    /// The first characters of the team id and of the inviting admin's id, to read aloud.
    team_id: String,
    admin_id: String,
}

fn join_preview(settings: &SettingsStore, code: &str) -> Res<JoinPreview> {
    let code = InviteCode::parse(code).map_err(team_err)?;
    let (_, trust) = relay_base(settings);
    // the same rules as the join itself, so what the form says is what the join will do
    let trusted = match TeamWs::new_with(&code.relay, &trust) {
        Ok(_) => true,
        Err(e) => {
            let e = team_err(e);
            if e.code != "hostNotAllowed" {
                return Err(e);
            }
            false
        }
    };
    let parsed = parse_relay(&code.relay).map_err(|_| err("urlSyntax", "the relay address in the invite looks wrong"))?;
    let short = |s: &str| s.chars().take(8).collect::<String>();
    Ok(JoinPreview { relay_host: parsed.authority(), trusted, local: parsed.local, team_id: short(&code.team_id), admin_id: short(&code.admin_id) })
}

#[tauri::command]
pub fn team_join_preview(state: State<'_, TeamModState>, code: String) -> Res<JoinPreview> {
    let settings = state.settings.as_ref().ok_or_else(|| err("unavailable", "Settings are unavailable, so Team cannot start"))?;
    join_preview(settings, &code)
}

/// The relay host an invite names, to be acknowledged when the person said so (`trust_relay`). A relay on this machine needs no
/// acknowledgement. The caller still builds the connection with the normal host rules (a restricted mode refuses it all the same).
fn host_to_acknowledge(code: &InviteCode, trust_relay: Option<bool>) -> Option<String> {
    if trust_relay != Some(true) {
        return None;
    }
    parse_relay(&code.relay).ok().filter(|p| !p.local).map(|p| p.authority())
}

#[tauri::command]
pub async fn team_join(app: AppHandle, state: State<'_, TeamModState>, code: String, name: String, trust_relay: Option<bool>) -> Res<TeamView> {
    let name = clean_name(&name)?;
    let (secrets, settings) = prepare(&app, &state)?;
    let code = InviteCode::parse(&code).map_err(team_err)?;
    {
        let inner = lock(&state.inner);
        if inner.team.is_some() || inner.joining.is_some() {
            return Err(err("alreadyInTeam", "this install is already in a team"));
        }
    }
    let (_, mut trust) = relay_base(&settings);
    // The person ticked "I trust this relay": that acknowledgement is theirs and is kept, so the team still connects after a restart.
    let acknowledge = host_to_acknowledge(&code, trust_relay);
    if let Some(h) = &acknowledge {
        trust.allowed_hosts.push(h.clone());
    }
    let ws = TeamWs::new_with(&code.relay, &trust).map_err(team_err)?;
    let identity = Identity::load_or_create(&secrets).map_err(team_err)?;
    // the host is written last of what can fail before the redeem; from here every way out of the join takes it back (`reset`)
    let added = match &acknowledge {
        Some(h) => remember_relay_host(&settings, h)?,
        None => false,
    };
    if let Err(e) = ws.redeem_invite(&code.team_id, &code.relay_token(), &identity).await {
        // a host that did not answer like a team relay is not kept as trusted
        if added {
            forget_relay_host(&settings, &code.relay);
        }
        return Err(team_err(e));
    }
    remember_name(&settings, &name);
    let mut inner = lock(&state.inner);
    inner.identity = Some(identity);
    let team_id = code.team_id.clone();
    inner.joining = Some(Joining { code, name, stage: Stage::Connecting, joiner: None, joined: None, sas: None, welcome: None, confirmed: false, acknowledged: added });
    if let Err(e) = start_link(&app, &mut inner, ws, &team_id) {
        let inner = &mut *inner;
        reset(inner, &secrets);
        return Err(e);
    }
    emit_changed(&app, &inner);
    Ok(view(&inner))
}

/// Joiner: the person compared the 6-digit code with the admin's screen.
#[tauri::command]
pub fn team_join_confirm(app: AppHandle, state: State<'_, TeamModState>, accept: bool) -> Res<TeamView> {
    let (secrets, _) = prepare(&app, &state)?;
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    if inner.joining.is_none() {
        return Err(err("noRequest", "no join is in progress"));
    }
    if !accept {
        abort_join(inner, &secrets);
    } else if let Some(j) = inner.joining.as_mut() {
        j.confirmed = true;
        if j.welcome.is_none() {
            j.stage = Stage::WaitingWelcome;
        }
        try_finish(inner, &secrets);
    }
    emit_changed(&app, inner);
    Ok(view(inner))
}

#[tauri::command]
pub fn team_revoke(app: AppHandle, state: State<'_, TeamModState>, member_id: String) -> Res<TeamView> {
    let (secrets, _) = prepare(&app, &state)?;
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    revoke_member(inner, &secrets, &member_id)?;
    emit_changed(&app, inner);
    Ok(view(inner))
}

/// The person confirmed that this member was removed (or wants out): forget the team on this machine and start over with a new identity.
/// Never called by the app on its own, and refused for an admin while other members remain.
#[tauri::command]
pub fn team_forget(app: AppHandle, state: State<'_, TeamModState>) -> Res<TeamView> {
    let (secrets, settings) = prepare(&app, &state)?;
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    if inner.team.as_ref().is_some_and(|t| t.is_admin() && t.body().members.len() > 1) {
        return Err(err("adminLeave", "an admin cannot forget the team while other members remain; revoke them first"));
    }
    if let Some(t) = inner.team.as_ref() {
        forget_relay_host(&settings, &t.relay);
    }
    if let Some(dir) = inner.state_dir.clone() {
        let _ = TeamState::forget(&dir, &secrets);
    }
    audit(inner, event::LEFT, None, Some("forgotten"));
    reset(inner, &secrets);
    emit_changed(&app, inner);
    Ok(view(inner))
}

/// Leave the team: the relay drops this member, this machine forgets the team and the identity is replaced. An admin can only leave a
/// team of one (there is no hand-over of the admin role yet).
#[tauri::command]
pub async fn team_leave(app: AppHandle, state: State<'_, TeamModState>) -> Res<TeamView> {
    let (secrets, settings) = prepare(&app, &state)?;
    let said_leave = {
        let inner = lock(&state.inner);
        match inner.team.as_ref() {
            Some(team) if team.is_admin() && team.body().members.len() > 1 => return Err(err("adminLeave", "an admin cannot leave while other members remain; revoke them first")),
            Some(team) if !team.is_admin() => {
                send(&inner, out::leave());
                true
            }
            _ => false,
        }
    };
    if said_leave {
        // give the relay a moment to see `leave` before the socket closes
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    }
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    if let Some(t) = inner.team.as_ref() {
        forget_relay_host(&settings, &t.relay);
    }
    if let Some(dir) = inner.state_dir.clone() {
        let _ = TeamState::forget(&dir, &secrets);
    }
    audit(inner, event::LEFT, None, None);
    reset(inner, &secrets);
    emit_changed(&app, inner);
    Ok(view(inner))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store() -> (tempfile::TempDir, SettingsStore) {
        let dir = tempfile::tempdir().unwrap();
        let s = SettingsStore::open(dir.path().join("settings.json")).unwrap();
        (dir, s)
    }

    fn code(relay: &str) -> InviteCode {
        InviteCode { relay: relay.into(), team_id: "CEx5c2s4WAO1kx7iTVzL9g".into(), admin_id: "gKAK926tlsM_abcdef".into(), admin_noise_pub: [7; 32], otp: [9; 16] }
    }

    fn put(s: &SettingsStore, ns: &str, v: Value) {
        s.set(ns, v.as_object().unwrap().clone()).unwrap();
    }

    #[test]
    fn a_relay_host_nobody_acknowledged_is_shown_as_not_trusted_and_trusted_once_the_person_said_so() {
        let (_d, s) = store();
        let link = code("wss://Relay.Example.workers.dev").to_link();
        let p = join_preview(&s, &link).unwrap();
        assert_eq!((p.relay_host.as_str(), p.trusted, p.local), ("relay.example.workers.dev", false, false));
        assert_eq!((p.team_id.as_str(), p.admin_id.as_str()), ("CEx5c2s4", "gKAK926t"), "the first eight characters, to read aloud");
        // the person trusts it while joining: the next preview says so, and a restart still connects (relay_base carries the host)
        assert!(remember_relay_host(&s, "relay.example.workers.dev").unwrap());
        assert!(!remember_relay_host(&s, "RELAY.example.workers.dev").unwrap(), "a second time (any case) changes nothing");
        assert!(join_preview(&s, &link).unwrap().trusted);
        assert!(relay_base(&s).1.allowed_hosts.contains(&"relay.example.workers.dev".to_string()));
        // another host is still not trusted
        assert!(!join_preview(&s, &code("wss://other.example.workers.dev").to_link()).unwrap().trusted);
    }

    #[test]
    fn hosts_acknowledged_for_remote_count_as_well_and_a_relay_on_this_machine_needs_none() {
        let (_d, s) = store();
        put(&s, "remote", json!({ "trust": { "allowedHosts": ["Mine.workers.dev"] } }));
        assert!(join_preview(&s, &code("wss://mine.workers.dev").to_link()).unwrap().trusted);
        for local in ["ws://127.0.0.1:8787", "ws://localhost:8787", "ws://[::1]:8787"] {
            let p = join_preview(&s, &code(local).to_link()).unwrap();
            assert!(p.trusted && p.local, "{local}");
        }
    }

    #[test]
    fn a_preview_refuses_what_a_join_would_refuse_and_says_why_in_a_code_the_form_knows() {
        let (_d, s) = store();
        let e = |relay: &str| join_preview(&s, &code(relay).to_link()).err().map(|e| e.code).unwrap_or_default();
        assert_eq!(e("ws://relay.example.workers.dev"), "insecure", "a relay outside this machine must be encrypted");
        assert_eq!(e("https://relay.example.com"), "scheme");
        assert_eq!(e(&format!("wss://{}@relay.example.workers.dev", ["user", "pw"].join(":"))), "userinfo");
        assert_eq!(e("wss://203.0.113.7"), "ipLiteral");
        assert_eq!(e("wss://relay.example.workers.dev/a/b"), "urlSyntax");
        for text in ["", "hello", "https://example.com", "intely-team://join#wss://x"] {
            assert_eq!(join_preview(&s, text).err().map(|e| e.code).as_deref(), Some("invalidCode"), "{text:?}");
        }
    }

    #[test]
    fn only_a_ticked_box_acknowledges_a_host_and_never_a_local_one() {
        let c = code("wss://Relay.Example.workers.dev:8443");
        assert_eq!(host_to_acknowledge(&c, Some(true)).as_deref(), Some("relay.example.workers.dev:8443"));
        assert_eq!(host_to_acknowledge(&c, Some(false)), None);
        assert_eq!(host_to_acknowledge(&c, None), None);
        assert_eq!(host_to_acknowledge(&code("ws://127.0.0.1:8787"), Some(true)), None);
    }

    #[test]
    fn leaving_forgets_the_acknowledgement_that_a_join_made_and_only_that() {
        let (_d, s) = store();
        put(&s, "remote", json!({ "trust": { "allowedHosts": ["mine.workers.dev"] } }));
        remember_relay_host(&s, "relay.example.workers.dev").unwrap();
        remember_relay_host(&s, "mine.workers.dev").unwrap();
        forget_relay_host(&s, "wss://relay.example.workers.dev");
        let hosts = relay_base(&s).1.allowed_hosts;
        assert!(!hosts.contains(&"relay.example.workers.dev".to_string()));
        assert!(hosts.contains(&"mine.workers.dev".to_string()), "Remote's own list is not touched");
        forget_relay_host(&s, "not a url");
        forget_relay_host(&s, "wss://never-was.example.workers.dev");
    }

    #[test]
    fn a_join_that_ends_without_a_team_takes_back_the_host_it_acknowledged_and_only_that() {
        let (_d, s) = store();
        let s = Arc::new(s);
        put(&s, "remote", json!({ "trust": { "allowedHosts": ["mine.workers.dev"] } }));
        let secrets: Arc<dyn SecretStore> = Arc::new(intely_settings::MemorySecretStore::new());
        let joining = |ack: bool| Joining { code: code("wss://relay.example.workers.dev"), name: "N".into(), stage: Stage::Connecting, joiner: None, joined: None, sas: None, welcome: None, confirmed: false, acknowledged: ack };
        let trusted = |s: &SettingsStore, host: &str| relay_base(s).1.allowed_hosts.contains(&host.to_string());
        remember_relay_host(&s, "relay.example.workers.dev").unwrap();

        // this join added nothing (the host was acknowledged by an earlier one): ending it leaves the host in place
        let mut inner = Inner { settings: Some(s.clone()), joining: Some(joining(false)), ..Inner::default() };
        reset(&mut inner, &secrets);
        assert!(trusted(&s, "relay.example.workers.dev"));

        // this join added it: a refused code, a declined comparison or any other end without a team takes it back
        inner.joining = Some(joining(true));
        reset(&mut inner, &secrets);
        assert!(!trusted(&s, "relay.example.workers.dev"));
        assert!(trusted(&s, "mine.workers.dev"), "Remote's own list is not touched");
        assert!(inner.joining.is_none());
    }

    #[test]
    fn the_list_of_acknowledged_hosts_stays_small() {
        let (_d, s) = store();
        for i in 0..(MAX_TRUSTED_RELAYS + 5) {
            remember_relay_host(&s, &format!("relay{i}.example.workers.dev")).unwrap();
        }
        let hosts = trusted_relay_hosts(&s.get(NS).unwrap());
        assert_eq!(hosts.len(), MAX_TRUSTED_RELAYS);
        assert_eq!(hosts.last().map(String::as_str), Some(format!("relay{}.example.workers.dev", MAX_TRUSTED_RELAYS + 4).as_str()), "the newest stay");
    }
}
