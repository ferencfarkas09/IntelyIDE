//! The relay client, modeled on `intely_remote::relay_ws` and sharing its network rules: one strict URL parse, the host must be
//! acknowledged (`RelayTrust::allowed_hosts`), never a non-loopback host under the read-only or test jail, never plain `ws://` off
//! this machine, DNS resolved once and refused when it answers with a private address, no redirects, inbound frames capped.
//! Protocol: `remote-relay/src/team.ts`; credentials travel as the subprotocol `intely.v1, dev.<memberId>.<token>`.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use intely_remote::relay_ws::{pin_address, RelayTrust, RelayWs, PROTOCOL, STEP};
use intely_remote::util::{random, sha256_hex};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{sleep, Instant};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use crate::error::{Result, TeamError};
use crate::identity::Identity;

const PING_EVERY: Duration = Duration::from_secs(25);
const CLOSE_REVOKED: u16 = 4401;
/// A `blob.get` reply carries up to 256 KB of ciphertext as base64url (shared memory); the Remote link's limit is smaller.
const MAX_INBOUND_TEAM: usize = 384 * 1024;

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct MemberView {
    pub id: String,
    pub role: String,
    pub status: String,
    #[serde(default)]
    pub online: bool,
    #[serde(default)]
    pub state: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Hello {
    pub id: String,
    pub role: String,
    pub status: String,
    pub members: Vec<MemberView>,
    #[serde(default)]
    pub queued: u32,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RelayMsg {
    /// `fanout` or `direct`.
    pub kind: String,
    pub from: String,
    #[serde(default)]
    pub ts: u64,
    /// Present on a frame that waited in the relay's queue: it stays there until [`out::ack`] covers it.
    #[serde(default)]
    pub qid: Option<u64>,
    /// The opaque payload (`wire::frame`).
    pub p: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "t")]
enum Typed {
    #[serde(rename = "hello")]
    Hello(Hello),
    #[serde(rename = "msg")]
    Msg(RelayMsg),
    #[serde(rename = "presence")]
    Presence { id: String, online: bool, #[serde(default)] state: String },
    #[serde(rename = "member.pending")]
    MemberPending { id: String },
    #[serde(rename = "member.joined")]
    MemberJoined { id: String },
    #[serde(rename = "member.revoked")]
    MemberRevoked { id: String },
    #[serde(rename = "roster.changed")]
    RosterChanged { version: u64 },
    #[serde(rename = "blob.changed")]
    BlobChanged { key: String, version: u64, author: String },
}

#[derive(Debug, Clone, PartialEq)]
pub enum ServerMsg {
    Hello(Hello),
    Msg(RelayMsg),
    Presence { id: String, online: bool, state: String },
    MemberPending(String),
    MemberJoined(String),
    MemberRevoked(String),
    RosterChanged(u64),
    BlobChanged { key: String, version: u64, author: String },
    /// `ok`, `err`, `roster`, `blob`, `blobs`: replies to a request, matched by their `op`.
    Reply(Value),
    Other,
}

impl ServerMsg {
    pub fn parse(text: &str) -> Self {
        let Ok(v) = serde_json::from_str::<Value>(text) else { return Self::Other };
        if matches!(v["t"].as_str(), Some("ok" | "err" | "roster" | "blob" | "blobs")) {
            return Self::Reply(v);
        }
        match serde_json::from_value::<Typed>(v) {
            Ok(Typed::Hello(h)) => Self::Hello(h),
            Ok(Typed::Msg(m)) => Self::Msg(m),
            Ok(Typed::Presence { id, online, state }) => Self::Presence { id, online, state },
            Ok(Typed::MemberPending { id }) => Self::MemberPending(id),
            Ok(Typed::MemberJoined { id }) => Self::MemberJoined(id),
            Ok(Typed::MemberRevoked { id }) => Self::MemberRevoked(id),
            Ok(Typed::RosterChanged { version }) => Self::RosterChanged(version),
            Ok(Typed::BlobChanged { key, version, author }) => Self::BlobChanged { key, version, author },
            Err(_) => Self::Other,
        }
    }
}

#[derive(Debug)]
pub enum In {
    Connected,
    Disconnected,
    Msg(ServerMsg),
    /// The relay closed the socket with 4401: this member is revoked. The link has stopped.
    Revoked,
}

/// Control frames to the relay (`{"t": ..}`), built by the helpers below.
pub mod out {
    use super::*;

    pub fn invite_open(token_hash: &str, ttl_ms: u64) -> Value {
        json!({"t": "invite.open", "hash": token_hash, "ttlMs": ttl_ms})
    }
    pub fn member_join(id: &str) -> Value {
        json!({"t": "member.join", "id": id})
    }
    pub fn member_revoke(id: &str) -> Value {
        json!({"t": "member.revoke", "id": id})
    }
    pub fn leave() -> Value {
        json!({"t": "leave"})
    }
    pub fn presence(state: &str) -> Value {
        json!({"t": "presence", "state": state})
    }
    /// What a member sends once it is in the team and connected (after every hello, and right after joining): it is online, and the
    /// roster it holds may be behind the relay's.
    pub fn announce() -> [Value; 2] {
        [presence("online"), roster_get()]
    }
    pub fn fanout(p: &str, queue: bool) -> Value {
        json!({"t": "fanout", "p": p, "q": queue})
    }
    /// `queue` false = deliver now or fail (handshake frames must not wait in a queue). `op` comes back in the relay's reply.
    pub fn direct(to: &str, p: &str, queue: bool, op: &str) -> Value {
        json!({"t": "direct", "to": to, "p": p, "q": queue, "op": op})
    }
    pub fn ack(up_to: u64) -> Value {
        json!({"t": "ack", "upTo": up_to})
    }
    pub fn with_op(mut v: Value, op: &str) -> Value {
        v["op"] = Value::String(op.to_string());
        v
    }
    pub fn roster_put(base_version: u64, p: &str) -> Value {
        json!({"t": "roster.put", "baseVersion": base_version, "p": p})
    }
    pub fn roster_get() -> Value {
        json!({"t": "roster.get"})
    }
    pub fn blob_put(key: &str, base_version: u64, p: &str) -> Value {
        json!({"t": "blob.put", "key": key, "baseVersion": base_version, "p": p})
    }
    pub fn blob_get(key: &str) -> Value {
        json!({"t": "blob.get", "key": key})
    }
    pub fn blob_list() -> Value {
        json!({"t": "blob.list"})
    }
}

pub struct LinkHandle {
    pub tx: mpsc::Sender<Value>,
    pub rx: mpsc::Receiver<In>,
    task: Option<JoinHandle<()>>,
}

impl Drop for LinkHandle {
    fn drop(&mut self) {
        if let Some(t) = self.task.take() {
            t.abort();
        }
    }
}

#[derive(Clone, Debug)]
pub struct TeamWs {
    relay: RelayWs,
}

impl TeamWs {
    /// Applies the same host rules as the Remote relay link.
    pub fn new_with(base: &str, trust: &RelayTrust) -> Result<Self> {
        Ok(Self { relay: RelayWs::new_with(base, trust)? })
    }

    pub fn base(&self) -> &str {
        &self.relay.base
    }

    fn ws_url(&self, team_id: &str) -> String {
        format!("{}/t/{team_id}/ws", self.relay.base)
    }

    fn http_url(&self, team_id: &str, sub: &str) -> String {
        format!("{}/t/{team_id}{sub}", self.relay.http_base())
    }

    async fn http(&self) -> Result<reqwest::Client> {
        let pin = pin_address(&self.relay).await.map_err(|c| TeamError::Transport(c.to_string()))?;
        let mut b = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(STEP);
        if let Some(addr) = pin {
            b = b.resolve(&self.relay.parsed().host, addr);
        }
        b.build().map_err(|_| TeamError::Transport("tls".into()))
    }

    /// A relay deployed before Team collaboration has no `/t/*` routes (it answers 403, 404 or 405 there). `GET /api/status` lists the
    /// relay's `features`; no `team` in it, or no such answer, is `Transport("relayOld")` before anything is sent to `/t/`.
    async fn require_team_support(&self) -> Result<()> {
        let r = self.http().await?.get(format!("{}/api/status", self.relay.http_base())).header("accept", "application/json").send().await.map_err(net_err)?;
        if !r.status().is_success() {
            return Err(relay_old());
        }
        let body = r.bytes().await.map_err(net_err)?;
        let v: Value = serde_json::from_slice(&body[..body.len().min(64 * 1024)]).map_err(|_| relay_old())?;
        if v["relay"]["features"].as_array().is_some_and(|f| f.iter().any(|x| x == "team")) {
            Ok(())
        } else {
            Err(relay_old())
        }
    }

    /// `PUT /t/<team>/create`: the founder's credentials. `Ok(true)` when created, `Ok(false)` when it already existed with these.
    pub async fn create_team(&self, team_id: &str, me: &Identity) -> Result<bool> {
        self.require_team_support().await?;
        let r = self.http().await?.put(self.http_url(team_id, "/create")).bearer_auth(&me.token).header("x-intely-member", &me.member_id).send().await.map_err(net_err)?;
        match r.status().as_u16() {
            201 => Ok(true),
            200 => Ok(false),
            403..=405 => Err(relay_old()),
            s => Err(TeamError::Transport(format!("create:{s}"))),
        }
    }

    /// `POST /t/<team>/join` with the invite token: enrolls this member as pending.
    pub async fn redeem_invite(&self, team_id: &str, invite_token: &str, me: &Identity) -> Result<()> {
        self.require_team_support().await?;
        let body = json!({"id": me.member_id, "hash": sha256_hex(me.token.as_bytes())}).to_string();
        let r = self.http().await?.post(self.http_url(team_id, "/join")).bearer_auth(invite_token).body(body).send().await.map_err(net_err)?;
        match r.status().as_u16() {
            201 => Ok(()),
            401 => Err(TeamError::InviteSpent),
            429 => Err(TeamError::Full),
            403 | 404 | 405 => Err(relay_old()),
            s => Err(TeamError::Transport(format!("join:{s}"))),
        }
    }

    /// Starts the socket task (reconnects with jittered backoff; stops on revoke or when the handle drops).
    pub fn spawn(self, team_id: &str, me: &Identity) -> LinkHandle {
        let (out_tx, out_rx) = mpsc::channel::<Value>(256);
        let (in_tx, in_rx) = mpsc::channel::<In>(256);
        let (url, protocol) = (self.ws_url(team_id), format!("{PROTOCOL}, dev.{}.{}", me.member_id, me.token));
        let task = tokio::spawn(async move { run(self, url, protocol, out_rx, in_tx).await });
        LinkHandle { tx: out_tx, rx: in_rx, task: Some(task) }
    }
}

/// The relay answers, but has no Team routes: it was deployed before Team collaboration. The UI says "update the relay".
pub const RELAY_OLD: &str = "relayOld";

fn relay_old() -> TeamError {
    TeamError::Transport(RELAY_OLD.into())
}

fn net_err(e: reqwest::Error) -> TeamError {
    TeamError::Transport(if e.is_timeout() { "timeout" } else { "http" }.into())
}

type Stream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(team: &TeamWs, url: &str, protocol: &str) -> std::result::Result<Stream, &'static str> {
    let pin = pin_address(&team.relay).await?;
    let mut req = url.into_client_request().map_err(|_| "handshake")?;
    req.headers_mut().insert("Sec-WebSocket-Protocol", protocol.parse().map_err(|_| "handshake")?);
    let (host, port) = (team.relay.parsed().host.clone(), team.relay.parsed().connect_port());
    let tcp = match pin {
        Some(addr) => tokio::time::timeout(STEP, tokio::net::TcpStream::connect(addr)).await,
        None => tokio::time::timeout(STEP, tokio::net::TcpStream::connect((host.as_str(), port))).await,
    }
    .map_err(|_| "timeout")?
    .map_err(|_| "tcp")?;
    let cfg = WebSocketConfig::default().max_message_size(Some(MAX_INBOUND_TEAM)).max_frame_size(Some(MAX_INBOUND_TEAM));
    let (stream, _) = tokio::time::timeout(STEP + STEP, tokio_tungstenite::client_async_tls_with_config(req, tcp, Some(cfg), None)).await.map_err(|_| "timeout")?.map_err(|_| "handshake")?;
    Ok(stream)
}

async fn run(team: TeamWs, url: String, protocol: String, mut out_rx: mpsc::Receiver<Value>, in_tx: mpsc::Sender<In>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match connect(&team, &url, &protocol).await {
            Ok(stream) => {
                backoff = Duration::from_secs(1);
                let _ = in_tx.send(In::Connected).await;
                let (mut sink, mut stream) = stream.split();
                let mut ping = tokio::time::interval_at(Instant::now() + PING_EVERY, PING_EVERY);
                let revoked = loop {
                    tokio::select! {
                        m = stream.next() => match m {
                            Some(Ok(Message::Text(t))) => {
                                // Queued mail stays at the relay until the consumer sends `out::ack` after it applied and saved the frame.
                                if in_tx.send(In::Msg(ServerMsg::parse(t.as_str()))).await.is_err() { return; }
                            }
                            Some(Ok(Message::Close(c))) => break c.is_some_and(|c| c.code == CloseCode::Library(CLOSE_REVOKED)),
                            Some(Ok(_)) => {}
                            Some(Err(_)) | None => break false,
                        },
                        o = out_rx.recv() => match o {
                            None => { let _ = sink.close().await; return; }
                            Some(v) => { if sink.send(Message::text(v.to_string())).await.is_err() { break false; } }
                        },
                        _ = ping.tick() => { if sink.send(Message::text("ping")).await.is_err() { break false; } }
                    }
                };
                let _ = in_tx.send(In::Disconnected).await;
                if revoked {
                    let _ = in_tx.send(In::Revoked).await;
                    return;
                }
            }
            Err(_) => {
                let _ = in_tx.send(In::Disconnected).await;
            }
        }
        let deadline = Instant::now() + backoff + Duration::from_millis(u64::from(random::<2>()[0]) * 4);
        while Instant::now() < deadline {
            tokio::select! {
                _ = sleep(Duration::from_millis(200)) => {}
                o = out_rx.recv() => if o.is_none() { return; },
            }
        }
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn announce_says_online_and_asks_for_the_roster() {
        let f = out::announce();
        assert_eq!(f[0], json!({"t": "presence", "state": "online"}));
        assert_eq!(f[1], json!({"t": "roster.get"}));
    }
}
