//! Team against a REAL relay (`remote-relay`, `wrangler dev --local`), three clients with separate state and secret stores, driven
//! through the same crate APIs the Tauri glue (`src-tauri/src/modules/team/*.rs`) uses. Ignored by default:
//!
//! ```text
//! (cd remote-relay && npx wrangler dev --local --ip 127.0.0.1 --port 8787 --assets <empty dir with an index.html>)
//! INTELY_TEAM_LIVE=ws://127.0.0.1:8787 cargo test -p intely-team --test live_relay -- --ignored --nocapture
//! ```
//!
//! Only a loopback URL is accepted. Secrets live in `MemorySecretStore`, never in the Keychain.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use intely_agent_core::events::{AgentEvent, EventKind, ToolKind, ToolStatus};
use intely_remote::relay_ws::RelayTrust;
use intely_remote::util::{b64u, b64u_decode, random};
use intely_settings::{MemorySecretStore, SecretStore};
use intely_team::client::{out, In, LinkHandle, ServerMsg, TeamWs};
use intely_team::collab::{self, build_snapshot, chunk_snapshot, judge_note, CollabMsg, NoteStatus, RawFile, Reassembly, RunFacts, Snapshot};
use intely_team::envelope::Envelope;
use intely_team::identity::Identity;
use intely_team::inbox::{AckGate, Verdict};
use intely_team::invite::{InviteCode, Joined, Joiner, Offer, Pending, OFFER_TTL_MS};
use intely_team::memsync::{self, Blob, Ctx, Head, MemState, PutOutcome, Remote, Roots};
use intely_team::share::{Dest, Project, Publisher, RunStore, ShareMsg, ShareSettings};
use intely_team::state::TeamState;
use intely_team::wire::{frame, tag, unframe};
use intely_team::TeamError;
use serde_json::{json, Value};

const SECRET: &str = concat!("sk-", "ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
const AWS: &str = concat!("AKIA", "IOSFODNN7EXAMPLE");

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

struct AdminJoin {
    offer: Offer,
    pending: Option<Pending>,
    verified: bool,
}

struct Joining {
    code: InviteCode,
    name: String,
    started: bool,
    joiner: Option<Joiner>,
    joined: Option<Joined>,
    welcome: Option<Vec<u8>>,
}

struct Peer {
    name: &'static str,
    secrets: Arc<dyn SecretStore>,
    dir: tempfile::TempDir,
    id: Identity,
    ws: TeamWs,
    team: Option<TeamState>,
    link: Option<LinkHandle>,
    connected: bool,
    revoked: bool,
    online: HashMap<String, (bool, String)>,
    gate: AckGate,
    relay_roster: u64,
    replies: HashMap<String, Value>,
    seq: u64,
    admin_join: Option<AdminJoin>,
    joining: Option<Joining>,
    store: RunStore,
    reasm: Reassembly,
    snapshots: Vec<Snapshot>,
    denied: Vec<String>,
    notes_in: Vec<(String, String, String, String)>,
    statuses: Vec<(String, NoteStatus, Option<String>)>,
    /// What this peer would serve as a workspace snapshot.
    workspace: Vec<RawFile>,
    log: Vec<String>,
}

fn ws_base() -> String {
    let url = std::env::var("INTELY_TEAM_LIVE").expect("set INTELY_TEAM_LIVE=ws://127.0.0.1:<port>");
    assert!(url.starts_with("ws://127.0.0.1") || url.starts_with("ws://localhost"), "the live test only talks to a loopback relay");
    url
}

impl Peer {
    fn new(name: &'static str) -> Self {
        let secrets: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::new());
        let id = Identity::load_or_create(&secrets).unwrap();
        let ws = TeamWs::new_with(&ws_base(), &RelayTrust::default()).unwrap();
        Self {
            name,
            secrets,
            dir: tempfile::tempdir().unwrap(),
            id,
            ws,
            team: None,
            link: None,
            connected: false,
            revoked: false,
            online: HashMap::new(),
            gate: AckGate::default(),
            relay_roster: 0,
            replies: HashMap::new(),
            seq: 0,
            admin_join: None,
            joining: None,
            store: RunStore::new(),
            reasm: Reassembly::default(),
            snapshots: Vec::new(),
            denied: Vec::new(),
            notes_in: Vec::new(),
            statuses: Vec::new(),
            workspace: Vec::new(),
            log: Vec::new(),
        }
    }

    fn t(&self) -> &TeamState {
        self.team.as_ref().expect("in a team")
    }

    fn send(&self, v: Value) {
        self.link.as_ref().expect("link").tx.try_send(v).expect("outgoing queue");
    }

    fn save(&mut self) {
        let (dir, secrets) = (self.dir.path().to_path_buf(), self.secrets.clone());
        if let Some(t) = self.team.as_mut() {
            if t.take_dirty() {
                t.save(&dir, &secrets).unwrap();
            }
        }
    }

    // ------------------------------------------------------------ pumping

    async fn pump(&mut self, ms: u64) {
        let end = Instant::now() + Duration::from_millis(ms);
        loop {
            let left = end.saturating_duration_since(Instant::now());
            let Some(link) = self.link.as_mut() else { return tokio::time::sleep(left).await };
            match tokio::time::timeout(left, link.rx.recv()).await {
                Ok(Some(m)) => self.on_link(m),
                _ => return,
            }
        }
    }

    async fn wait(&mut self, what: &str, f: impl Fn(&Peer) -> bool) {
        let end = Instant::now() + Duration::from_secs(15);
        while !f(self) {
            assert!(Instant::now() < end, "{}: timed out waiting for {what}; log: {:?}", self.name, self.log);
            self.pump(50).await;
        }
    }

    async fn call(&mut self, frame: Value) -> Value {
        self.seq += 1;
        let op = format!("t:{}", self.seq);
        self.send(out::with_op(frame, &op));
        let end = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(v) = self.replies.remove(&op) {
                return v;
            }
            assert!(Instant::now() < end, "{}: no reply to {op}", self.name);
            self.pump(50).await;
        }
    }

    fn on_link(&mut self, m: In) {
        match m {
            In::Connected => self.connected = true,
            In::Disconnected => {
                self.connected = false;
                self.online.values_mut().for_each(|v| v.0 = false);
            }
            In::Revoked => {
                self.revoked = true;
                self.connected = false;
            }
            In::Msg(msg) => self.on_server(msg),
        }
    }

    fn on_server(&mut self, msg: ServerMsg) {
        match msg {
            ServerMsg::Hello(h) => {
                self.gate.new_connection();
                self.online = h.members.iter().map(|m| (m.id.clone(), (m.online, m.state.clone()))).collect();
                if self.joining.as_ref().is_some_and(|j| !j.started) {
                    let me = self.id.clone();
                    let j = self.joining.as_mut().unwrap();
                    let (joiner, msg1) = Joiner::start(&j.code, &me, &j.name).unwrap();
                    j.joiner = Some(joiner);
                    j.started = true;
                    let admin = j.code.admin_id.clone();
                    self.send(out::direct(&admin, &frame(tag::JOIN_INIT, &msg1), false, "hs"));
                }
                if self.team.is_some() {
                    self.announce();
                    self.resend_pending();
                }
            }
            ServerMsg::Presence { id, online, state } => {
                self.online.insert(id, (online, state));
            }
            ServerMsg::MemberRevoked(id) => {
                self.online.remove(&id);
            }
            ServerMsg::MemberPending(id) => {
                if let Some(aj) = self.admin_join.as_mut() {
                    aj.offer.set_redeemer(&id);
                }
            }
            ServerMsg::RosterChanged(_) => self.send(out::roster_get()),
            ServerMsg::MemberJoined(id) => {
                if self.team.is_some() && id == self.id.member_id {
                    self.announce();
                }
            }
            ServerMsg::BlobChanged { .. } | ServerMsg::Other => {}
            ServerMsg::Reply(v) => self.on_reply(v),
            ServerMsg::Msg(m) => {
                let ok = self.on_payload(&m.from, &m.p);
                match self.gate.handled(m.qid, ok) {
                    Verdict::Ack(q) => self.send(out::ack(q)),
                    Verdict::GaveUp(q) => {
                        self.log.push("gave up on a frame".into());
                        self.send(out::ack(q));
                    }
                    Verdict::NoAck => {}
                }
            }
        }
    }

    /// Mirrors `team.rs::announce`.
    fn announce(&self) {
        for f in out::announce() {
            self.send(f);
        }
        let _ = ShareMsg::Request;
    }

    fn resend_pending(&mut self) {
        let Some(team) = self.team.as_ref() else { return };
        let (revokes, outbox) = (team.pending_revokes().to_vec(), team.outbox().to_vec());
        for id in revokes {
            self.send(out::with_op(out::member_revoke(&id), &format!("rv:{id}")));
        }
        for item in outbox {
            self.send(out::direct(&item.to, &item.payload, true, &format!("rk:{}", item.to)));
        }
        self.publish_roster();
    }

    fn publish_roster(&self) {
        if let Some(t) = &self.team {
            if let Ok(p) = t.seal_roster() {
                self.send(out::roster_put(self.relay_roster, &p));
            }
        }
    }

    fn on_reply(&mut self, v: Value) {
        let op = v["op"].as_str().unwrap_or("").to_string();
        let code = v["code"].as_str().unwrap_or("").to_string();
        match (v["t"].as_str(), v["re"].as_str()) {
            (Some("roster"), _) => {
                let cur = &v["current"];
                self.relay_roster = cur["version"].as_u64().unwrap_or(0);
                let mut relay_version = 0;
                if let Some(p) = cur["p"].as_str() {
                    let mut applied = false;
                    if let Some(team) = self.team.as_mut() {
                        match team.open_roster(p) {
                            Ok(signed) => {
                                relay_version = signed.parse().map_or(0, |b| b.version);
                                applied = team.apply_roster(signed).unwrap_or(false);
                            }
                            Err(TeamError::NoKey(_)) => {}
                            Err(e) => self.log.push(format!("roster payload: {e}")),
                        }
                    }
                    if applied {
                        self.save();
                    }
                }
                if self.team.as_ref().is_some_and(|t| t.is_admin() && t.body().version > relay_version) {
                    self.publish_roster();
                }
            }
            (Some("ok"), Some("roster.put")) => {
                if let Some(ver) = v["version"].as_u64() {
                    self.relay_roster = ver;
                }
            }
            (Some("err"), Some("roster.put")) => self.send(out::roster_get()),
            (Some("ok" | "err"), Some("direct")) if op.starts_with("rk:") => {
                if v["t"] == "ok" || code == "unknown" {
                    if let Some(t) = self.team.as_mut() {
                        t.outbox_done(&op[3..]);
                    }
                    self.save();
                }
            }
            (Some("ok" | "err"), Some("member.revoke")) if op.starts_with("rv:") => {
                if v["t"] == "ok" || matches!(code.as_str(), "unknown" | "admin") {
                    if let Some(t) = self.team.as_mut() {
                        t.revoke_done(&op[3..]);
                    }
                    self.save();
                }
            }
            _ => {}
        }
        if !op.is_empty() && !op.starts_with("rk:") && !op.starts_with("rv:") && op != "hs" {
            self.replies.insert(op, v);
        }
    }

    // ------------------------------------------------------------ payloads (mirrors `team.rs::on_payload`)

    fn on_payload(&mut self, from: &str, p: &str) -> bool {
        let Ok((t, body)) = unframe(p) else { return false };
        let n = now();
        match t {
            tag::JOIN_INIT => {
                let admin = self.id.clone();
                let Some(aj) = self.admin_join.as_mut() else { return true };
                if aj.pending.is_some() {
                    return true;
                }
                match aj.offer.accept(&admin, from, &body, n) {
                    Ok(pending) => {
                        let resp = frame(tag::JOIN_RESP, &pending.msg2);
                        aj.pending = Some(pending);
                        self.send(out::direct(from, &resp, false, "hs"));
                    }
                    Err(e) => self.log.push(format!("accept: {e}")),
                }
                true
            }
            tag::JOIN_HELLO => {
                let Some(aj) = self.admin_join.as_mut() else { return true };
                let Some(mut pending) = aj.pending.take() else { return true };
                match aj.offer.hello(&mut pending, from, &body, n) {
                    Ok(()) => {
                        aj.pending = Some(pending);
                        aj.verified = true;
                    }
                    Err(e) => self.log.push(format!("hello: {e}")),
                }
                true
            }
            tag::JOIN_RESP => {
                let Some(j) = self.joining.as_mut() else { return true };
                let Some(joiner) = j.joiner.take() else { return true };
                match joiner.on_msg2(&body) {
                    Ok(mut joined) => {
                        let hello = joined.hello().unwrap();
                        let admin = j.code.admin_id.clone();
                        j.joined = Some(joined);
                        self.send(out::direct(&admin, &frame(tag::JOIN_HELLO, &hello), false, "hs"));
                    }
                    Err(e) => self.log.push(format!("msg2: {e}")),
                }
                true
            }
            tag::WELCOME => {
                if let Some(j) = self.joining.as_mut() {
                    j.welcome = Some(body);
                }
                true
            }
            tag::REKEY => {
                let id = self.id.clone();
                let Some(team) = self.team.as_mut() else { return true };
                match team.apply_rekey(&id, p) {
                    Ok(_) => {
                        self.save();
                        self.send(out::roster_get());
                        true
                    }
                    Err(e) => {
                        self.log.push(format!("rekey: {e}"));
                        false
                    }
                }
            }
            tag::ENVELOPE => {
                let Some(team) = self.team.as_mut() else { return true };
                let opened = Envelope::decode(p).and_then(|e| team.open(&e).map(|plain| (e.sender, plain)));
                match opened {
                    Ok((sender, plain)) => {
                        if let Some(msg) = ShareMsg::parse(&plain) {
                            if msg != ShareMsg::Request {
                                let _ = self.store.apply(&sender, msg);
                            }
                        } else if let Some(msg) = CollabMsg::parse(&plain) {
                            self.collab_in(&sender, msg);
                        }
                        self.save();
                        true
                    }
                    Err(TeamError::Replay) => true,
                    Err(e) => {
                        self.log.push(format!("envelope from {from}: {e}"));
                        false
                    }
                }
            }
            _ => true,
        }
    }

    fn send_collab(&mut self, to: &str, msg: &CollabMsg) {
        let id = self.id.clone();
        let env = self.team.as_mut().unwrap().seal(&id, &msg.encode()).unwrap();
        self.send(out::direct(to, &env.encode(), false, "cl"));
    }

    fn collab_in(&mut self, sender: &str, msg: CollabMsg) {
        match msg {
            CollabMsg::NoteSend { run_id, note_id, text } => {
                let known = self.t().body().member(sender).is_some();
                let facts = Some(RunFacts { shared: true, live: true, claude: true });
                let (status, reason) = match judge_note(known, facts) {
                    Ok(()) => (NoteStatus::Received, None),
                    Err(r) => (NoteStatus::Refused, Some(r.to_string())),
                };
                self.notes_in.push((sender.into(), run_id.clone(), note_id.clone(), collab::clean_note(&text)));
                self.send_collab(sender, &CollabMsg::NoteStatus { run_id, note_id, status, reason });
            }
            CollabMsg::NoteStatus { note_id, status, reason, .. } => self.statuses.push((note_id, status, reason)),
            CollabMsg::WsRequest { project_key } => {
                let raw = self.workspace.clone();
                let snap = collab::fit_snapshot(build_snapshot(&b64u(&random::<8>()), &project_key, Some("main".into()), 1, 0, now(), raw));
                for c in chunk_snapshot(&snap) {
                    self.send_collab(sender, &c);
                }
            }
            CollabMsg::WsChunk { .. } => match self.reasm.push(sender, &msg) {
                Ok(Some(s)) => self.snapshots.push(s),
                Ok(None) => {}
                Err(why) => self.denied.push(why.into()),
            },
            CollabMsg::WsDenied { reason, .. } => self.denied.push(reason),
            // Chat and follow-ups are decided by the app (the run owner is the hub); this harness only
            // proves the relay carries notes and snapshots, so the other messages are dropped here.
            CollabMsg::FollowUpSend { .. }
            | CollabMsg::FollowUpStatus { .. }
            | CollabMsg::ChatSend { .. }
            | CollabMsg::ChatMsg { .. }
            | CollabMsg::ChatRequest { .. }
            | CollabMsg::ChatHistory { .. }
            | CollabMsg::ChatDenied { .. } => {}
        }
    }

    // ------------------------------------------------------------ flows

    async fn create_team(&mut self, display: &str) {
        let team = TeamState::create(&self.id, self.ws.base(), display, now()).unwrap();
        assert!(self.ws.create_team(&team.team_id, &self.id).await.unwrap());
        assert!(!self.ws.create_team(&team.team_id, &self.id).await.unwrap(), "a second create with the same credentials is idempotent");
        let id = team.team_id.clone();
        self.team = Some(team);
        self.save();
        self.link = Some(self.ws.clone().spawn(&id, &self.id));
        self.wait("connected", |p| p.connected).await;
    }

    /// Admin: opens the invite and returns the code text.
    fn invite(&mut self) -> String {
        let offer = Offer::new(now());
        let code = offer.code(self.t(), &self.id).to_link();
        self.send(out::invite_open(&offer.relay_token_hash(), OFFER_TTL_MS));
        self.admin_join = Some(AdminJoin { offer, pending: None, verified: false });
        code
    }

    /// Joiner: redeems the code and starts the handshake.
    async fn join(&mut self, code_text: &str, name: &str) {
        let code = InviteCode::parse(code_text).unwrap();
        self.ws.redeem_invite(&code.team_id, &code.relay_token(), &self.id).await.unwrap();
        let id = code.team_id.clone();
        self.joining = Some(Joining { code, name: name.into(), started: false, joiner: None, joined: None, welcome: None });
        self.link = Some(self.ws.clone().spawn(&id, &self.id));
    }
}

/// Runs the whole invite between an admin and a joiner and returns the SAS both showed.
async fn invite_and_join(admin: &mut Peer, joiner: &mut Peer, name: &str) -> String {
    let code = admin.invite();
    // the invite must reach the relay before it is redeemed
    admin.pump(300).await;
    joiner.join(&code, name).await;
    let end = Instant::now() + Duration::from_secs(15);
    loop {
        admin.pump(50).await;
        joiner.pump(50).await;
        let a = admin.admin_join.as_ref().is_some_and(|a| a.verified);
        let j = joiner.joining.as_ref().is_some_and(|j| j.joined.is_some());
        if a && j {
            break;
        }
        assert!(Instant::now() < end, "handshake timed out; admin {:?} joiner {:?}", admin.log, joiner.log);
    }
    let a_sas = admin.admin_join.as_ref().unwrap().pending.as_ref().unwrap().sas.clone();
    let j_sas = joiner.joining.as_ref().unwrap().joined.as_ref().unwrap().sas.clone();
    assert_eq!(a_sas, j_sas, "both screens show the same code");
    assert_eq!(a_sas.len(), 6);
    // admin approves: welcome first, then the relay lets the member in
    let aj = admin.admin_join.take().unwrap();
    let id = admin.id.clone();
    let (welcome, _, member_id) = aj.pending.unwrap().approve(admin.team.as_mut().unwrap(), &id, now()).unwrap();
    assert_eq!(member_id, joiner.id.member_id);
    admin.send(out::direct(&member_id, &frame(tag::WELCOME, &welcome), false, "welcome"));
    admin.send(out::member_join(&member_id));
    admin.publish_roster();
    admin.save();
    joiner.wait("welcome", |p| p.joining.as_ref().is_some_and(|j| j.welcome.is_some())).await;
    let j = joiner.joining.take().unwrap();
    let me = joiner.id.clone();
    let team = j.joined.unwrap().finish(&j.welcome.unwrap(), &me).unwrap();
    joiner.team = Some(team);
    joiner.save();
    joiner.announce();
    a_sas
}

struct Mem<'a>(&'a mut Peer);

impl Remote for Mem<'_> {
    async fn list(&mut self) -> intely_team::Result<Vec<Head>> {
        let v = self.0.call(out::blob_list()).await;
        assert_eq!(v["t"], "blobs", "{v}");
        Ok(v["items"].as_array().unwrap().iter().map(|i| Head { key: i["key"].as_str().unwrap().into(), version: i["version"].as_u64().unwrap(), author: i["author"].as_str().unwrap().into(), ts: i["ts"].as_u64().unwrap_or(0) }).collect())
    }
    async fn get(&mut self, key: &str) -> intely_team::Result<Option<Blob>> {
        let v = self.0.call(out::blob_get(key)).await;
        if v["code"] == "notFound" {
            return Ok(None);
        }
        assert_eq!(v["t"], "blob", "{v}");
        Ok(Some(Blob { version: v["version"].as_u64().unwrap(), author: v["author"].as_str().unwrap().into(), data: b64u_decode(v["p"].as_str().unwrap()).unwrap() }))
    }
    async fn put(&mut self, key: &str, base_version: u64, data: &[u8]) -> intely_team::Result<PutOutcome> {
        let v = self.0.call(out::blob_put(key, base_version, &b64u(data))).await;
        Ok(match (v["t"].as_str(), v["code"].as_str()) {
            (Some("ok"), _) => PutOutcome::Ok(v["version"].as_u64().unwrap_or(base_version + 1)),
            (_, Some("conflict")) => PutOutcome::Conflict,
            (_, Some("teamFull")) => PutOutcome::Full,
            _ => panic!("blob.put: {v}"),
        })
    }
}

struct Repo {
    roots: Roots,
    _dir: tempfile::TempDir,
}

fn repo(claude_md: bool) -> Repo {
    let dir = tempfile::tempdir().unwrap();
    let (r, m) = (dir.path().join("repo"), dir.path().join("memory"));
    std::fs::create_dir_all(&r).unwrap();
    std::fs::create_dir_all(&m).unwrap();
    Repo { roots: Roots { project: "ab".repeat(16), repo: r, memory_dir: m, claude_md }, _dir: dir }
}

async fn sync(p: &mut Peer, r: &Repo, st: &mut MemState) -> memsync::Report {
    let team = p.team.clone().unwrap();
    let me = p.id.clone();
    let cx = Ctx { team_id: &team.team_id, keys: team.keys(), me: &me, roster: team.body() };
    memsync::sync(&mut Mem(p), &cx, std::slice::from_ref(&r.roots), st, now()).await.unwrap()
}

fn ev(run: &str, seq: u64, kind: EventKind) -> AgentEvent {
    AgentEvent { agent_id: run.into(), seq, ts: now() + seq, turn_id: None, provider: "claude".into(), kind, raw: None }
}

fn flush(a: &mut Peer, publisher: &mut Publisher) {
    for o in publisher.tick(1000) {
        let id = a.id.clone();
        let env = a.team.as_mut().unwrap().seal(&id, &o.msg.encode()).unwrap();
        let p = env.encode();
        a.send(match &o.dest {
            Dest::All => out::fanout(&p, false),
            Dest::One(to) => out::direct(to, &p, false, "sh"),
        });
    }
    a.save();
}

#[tokio::test]
#[ignore = "needs a local relay: INTELY_TEAM_LIVE=ws://127.0.0.1:8787"]
async fn team_end_to_end_against_a_real_relay() {
    let (mut a, mut b, mut c) = (Peer::new("A"), Peer::new("B"), Peer::new("C"));

    // ---- create, invite, join (SAS equal), presence
    a.create_team("Ada").await;
    let sas_b = invite_and_join(&mut a, &mut b, "Bob").await;
    println!("B joined, SAS {sas_b}");
    b.wait("connected", |p| p.connected).await;
    let (a_id, b_id, c_id) = (a.id.member_id.clone(), b.id.member_id.clone(), c.id.member_id.clone());
    a.wait("B online", |p| p.online.get(&b_id).is_some_and(|v| v.0)).await;
    assert_eq!(b.t().body().members.len(), 2);
    assert_eq!(b.t().epoch(), 1);

    let sas_c = invite_and_join(&mut a, &mut c, "Cyd").await;
    println!("C joined, SAS {sas_c}");
    c.wait("connected", |p| p.connected).await;
    for p in [&mut a, &mut b, &mut c] {
        p.send(out::roster_get());
        p.wait("3 members", |p| p.t().body().members.len() == 3).await;
    }
    b.wait("A and C online", |p| p.online.get(&a_id).is_some_and(|v| v.0) && p.online.get(&c_id).is_some_and(|v| v.0)).await;

    // a presence state change reaches the others
    a.send(out::presence("busy"));
    b.wait("presence", |p| p.online.get(&a_id).is_some_and(|v| v.1 == "busy")).await;

    // ---- A publishes a shared run
    let mut publisher = Publisher::new();
    let s = ShareSettings { projects: ["k1".to_string()].into(), unshared_runs: Default::default() };
    let proj = Project::single("k1", "widgets");
    let mut seq = 0;
    let mut push = |p: &mut Publisher, k: EventKind| {
        seq += 1;
        p.on_event(&ev("run1", seq, k), Some(&proj), &s);
    };
    push(&mut publisher, EventKind::UserMessage { message_id: "u".into(), text: "fix the build".into(), attachments: vec![] });
    let (first, second) = SECRET.split_at(20);
    push(&mut publisher, EventKind::TextDelta { message_id: "m".into(), text: format!("the key is {first}"), parent_tool_id: None });
    push(&mut publisher, EventKind::TextDelta { message_id: "m".into(), text: format!("{second} ok\n"), parent_tool_id: None });
    push(&mut publisher, EventKind::ToolStart { tool_id: "t1".into(), name: "Bash".into(), tool_kind: ToolKind::Exec, input: json!({"command": "cat .env"}), parent_tool_id: None });
    push(&mut publisher, EventKind::ToolResult { tool_id: "t1".into(), status: ToolStatus::Ok, output: Some(format!("DB_PASSWORD=hunter2hunter2\nAWS={AWS}\n")), diff: None, duration_ms: None });
    push(&mut publisher, EventKind::ToolStart { tool_id: "t2".into(), name: "Bash".into(), tool_kind: ToolKind::Exec, input: json!({"command": "env"}), parent_tool_id: None });
    push(&mut publisher, EventKind::ToolResult { tool_id: "t2".into(), status: ToolStatus::Ok, output: Some(format!("token = \"{AWS}\"\n")), diff: None, duration_ms: None });
    flush(&mut a, &mut publisher);
    for p in [&mut b, &mut c] {
        p.wait("run events", |p| p.store.events(&a_id, "run1").len() >= 5).await;
    }
    let seen = serde_json::to_string(&b.store.events(&a_id, "run1")).unwrap();
    for needle in [SECRET, first, second, "hunter2", AWS] {
        assert!(!seen.contains(needle), "B must not see {needle}: {seen}");
    }
    assert!(seen.contains("fix the build"), "{seen}");
    assert_eq!(b.store.cards().len(), 1);
    assert_eq!(b.store.cards()[0].1.project_name, "widgets");

    // a member that asks again (Publisher::snapshot_for) gets the same redacted run
    publisher.snapshot_for(&b_id, now());
    flush(&mut a, &mut publisher);
    b.pump(500).await;
    assert!(b.store.events(&a_id, "run1").len() >= 5);

    // ---- B sends a note into A's run, A judges, accepts, status returns
    let note_id = b64u(&random::<6>());
    b.send_collab(&a_id, &CollabMsg::NoteSend { run_id: "run1".into(), note_id: note_id.clone(), text: "try the other branch".into() });
    a.wait("note", |p| !p.notes_in.is_empty()).await;
    assert_eq!(a.notes_in[0], (b_id.clone(), "run1".into(), note_id.clone(), "try the other branch".into()));
    b.wait("received", |p| p.statuses.iter().any(|s| s.1 == NoteStatus::Received)).await;
    a.send_collab(&b_id, &CollabMsg::NoteStatus { run_id: "run1".into(), note_id: note_id.clone(), status: NoteStatus::Accepted, reason: None });
    a.send_collab(&b_id, &CollabMsg::NoteStatus { run_id: "run1".into(), note_id: note_id.clone(), status: NoteStatus::Delivered, reason: None });
    b.wait("accepted+delivered", |p| p.statuses.iter().any(|s| s.1 == NoteStatus::Accepted) && p.statuses.iter().any(|s| s.1 == NoteStatus::Delivered)).await;

    // ---- B asks for A's workspace; many chunks reassemble; the secret file is listed without content
    let big: String = (0..3000).map(|i| format!("+line {i} of a long change with some text\n")).collect();
    a.workspace = vec![
        RawFile { path: "src/main.rs".into(), status: "M".into(), binary: false, guarded: false, too_large: false, diff: Some(format!("@@ -1 +1 @@\n+let key = \"{SECRET}\";\n{big}")) },
        RawFile { path: ".env".into(), status: "U".into(), binary: false, guarded: false, too_large: false, diff: Some("DB_PASSWORD=hunter2hunter2".into()) },
        RawFile { path: "logo.png".into(), status: "A".into(), binary: true, guarded: false, too_large: false, diff: None },
    ];
    b.send_collab(&a_id, &CollabMsg::WsRequest { project_key: "k1".into() });
    a.pump(500).await; // A serves the request
    b.wait("snapshot", |p| !p.snapshots.is_empty()).await;
    let snap = b.snapshots[0].clone();
    assert_eq!(snap.files.len(), 3);
    let text = serde_json::to_string(&snap).unwrap();
    assert!(!text.contains(SECRET) && !text.contains("hunter2"), "snapshot leaks");
    assert_eq!(snap.files[1].skipped.as_deref(), Some("secret"));
    assert!(chunk_snapshot(&snap).len() > 1, "the snapshot really was several chunks");

    // ---- memory: A writes memory/x.md, B pulls
    let (ra, rb, rc) = (repo(true), repo(true), repo(true));
    let (mut sa, mut sb, mut sc) = (MemState::default(), MemState::default(), MemState::default());
    std::fs::write(ra.roots.memory_dir.join("x.md"), "# x\nfrom A\n").unwrap();
    let rep = sync(&mut a, &ra, &mut sa).await;
    assert_eq!(rep.pushed, 1, "{rep:?}");
    let rep = sync(&mut b, &rb, &mut sb).await;
    assert_eq!(std::fs::read_to_string(rb.roots.memory_dir.join("x.md")).unwrap_or_default(), "# x\nfrom A\n", "{rep:?}");
    let rep = sync(&mut c, &rc, &mut sc).await;
    assert_eq!(std::fs::read_to_string(rc.roots.memory_dir.join("x.md")).unwrap(), "# x\nfrom A\n", "{rep:?}");

    // concurrent edits: both change x.md, A pushes first, B's pull makes a conflict copy and keeps both texts
    std::fs::write(ra.roots.memory_dir.join("x.md"), "# x\nA edit\n").unwrap();
    std::fs::write(rb.roots.memory_dir.join("x.md"), "# x\nB edit\n").unwrap();
    sync(&mut a, &ra, &mut sa).await;
    let rep = sync(&mut b, &rb, &mut sb).await;
    assert_eq!(sb.conflicts.len(), 1, "{rep:?}");
    let copy = rb.roots.memory_dir.join(&sb.conflicts[0].file);
    let both = [std::fs::read_to_string(rb.roots.memory_dir.join("x.md")).unwrap(), std::fs::read_to_string(&copy).unwrap()].join("|");
    assert!(both.contains("A edit") && both.contains("B edit"), "{both}");

    // CLAUDE.md: a teammate's version waits for a person, it is not written
    std::fs::write(ra.roots.repo.join("CLAUDE.md"), "# rules from A\n").unwrap();
    sync(&mut a, &ra, &mut sa).await;
    let rep = sync(&mut b, &rb, &mut sb).await;
    assert!(!rb.roots.repo.join("CLAUDE.md").exists(), "CLAUDE.md must be held, not written: {rep:?}");
    assert_eq!(sb.pending.len(), 1, "{rep:?}");

    // ---- revoke B: A rekeys, C gets epoch 2, B cannot read it and is out
    {
        let admin = a.id.clone();
        let rev = a.team.as_mut().unwrap().revoke(&admin, &b_id, now()).unwrap();
        assert_eq!(rev.epoch, 2);
    }
    a.save();
    a.resend_pending();
    c.wait("epoch 2", |p| p.t().epoch() == 2 && !p.t().waiting_for_key()).await;
    c.wait("2 members", |p| p.t().body().members.len() == 2).await;
    b.wait("closed with 4401", |p| p.revoked).await;
    a.wait("rekey confirmed", |p| p.t().outbox().is_empty() && p.t().pending_revokes().is_empty()).await;

    // new traffic is epoch 2: C reads it, B cannot
    let id = a.id.clone();
    let env = a.team.as_mut().unwrap().seal(&id, &ShareMsg::Gone { run_id: "zz".into() }.encode()).unwrap();
    assert_eq!(env.epoch, 2);
    assert!(b.team.as_mut().unwrap().open(&env).is_err(), "B cannot open an epoch-2 frame");
    assert!(c.team.as_mut().unwrap().open(&env).is_ok());

    // B's token is rejected on a new connection
    let team_id = b.t().team_id.clone();
    let mut again = b.ws.clone().spawn(&team_id, &b.id);
    let end = Instant::now() + Duration::from_secs(3);
    while Instant::now() < end {
        if let Ok(Some(In::Connected)) = tokio::time::timeout(Duration::from_millis(300), again.rx.recv()).await {
            panic!("a revoked member's token was accepted");
        }
    }
    drop(again);
    // A's live fan-out reaches C only
    publisher.on_event(&ev("run1", 99, EventKind::TextDelta { message_id: "m2".into(), text: "after revoke\n".into(), parent_tool_id: None }), Some(&proj), &s);
    flush(&mut a, &mut publisher);
    c.wait("post-revoke event", |p| p.store.events(&a_id, "run1").iter().any(|e| e.to_string().contains("after revoke"))).await;
    assert!(!b.store.events(&a_id, "run1").iter().any(|e| e.to_string().contains("after revoke")));
    // C can still sync memory under epoch 2
    std::fs::write(ra.roots.memory_dir.join("y.md"), "after rekey\n").unwrap();
    sync(&mut a, &ra, &mut sa).await;
    sync(&mut c, &rc, &mut sc).await;
    assert_eq!(std::fs::read_to_string(rc.roots.memory_dir.join("y.md")).unwrap(), "after rekey\n");
    println!("live relay run OK; A log {:?} B log {:?} C log {:?}", a.log, b.log, c.log);
}
