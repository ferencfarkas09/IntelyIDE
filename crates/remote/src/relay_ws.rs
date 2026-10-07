//! Outbound-only WebSocket client for the Cloudflare relay (`remote-relay/`), protocol as in `remote-relay/src/frames.ts`:
//! `wss://<host>/r/<roomId>/ws` with subprotocols `intely.v1, mac.<token>`; Mac -> relay binary frames are
//! `[1][idLen][deviceId][ciphertext]`, relay -> Mac `[1][0][qid u32 BE][idLen][deviceId][ciphertext]` (a queued frame, qid != 0,
//! is acknowledged with `{"t":"ack","upTo":qid}`); control is JSON text (`dev.add`, `dev.revoke`, `pair.open`, `notify`,
//! `room.wipe`). Reconnects with jittered backoff (1 s to 30 s; after `SLOW_AFTER_FAILURES` failures in a row the error is
//! recorded for Settings and retries slow down to 5 minutes). **Never contacts a non-local host** that the user has not
//! acknowledged (`RelayTrust::allowed_hosts`), never under the read-only or test jail, and never over plain `ws://`. Network
//! rules for a hostile relay ((design notes: remote-cloudflare-spec) 4.12.5): one strict URL parse, DNS resolved once and refused
//! when any answer is loopback, private, link-local, CGNAT or unspecified, the connection goes to that address with the
//! host name as SNI, no redirects, inbound frames capped at 128 KB.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::time::{sleep, Instant};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use url::{Host, Url};

use crate::error::{RemoteError, Result};
use crate::identity::Identity;
use crate::transport::{Admin, Inbound, Outbound, Transport, TransportHandle};
use crate::util::random;

pub const PROTOCOL: &str = "intely.v1";
pub const MAX_FRAME: usize = 64 * 1024;
/// Largest frame or message accepted from the relay (the relay's own cap is 64 KB).
pub const MAX_INBOUND: usize = 128 * 1024;
const PING_EVERY: Duration = Duration::from_secs(25);
const CLOSE_WIPED: u16 = 4410;
/// After this many failed attempts in a row the error is shown on the Mac and retries slow down to minutes.
pub const SLOW_AFTER_FAILURES: u32 = 5;
const STEP: Duration = Duration::from_secs(10);

/// What the launch mode allows (`intely_core::jail::Mode`, mirrored here because this crate has no `intely-core` dependency;
/// the Tauri layer sets it). `ReadOnly` and `E2e` never contact a non-loopback relay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RelayJail {
    #[default]
    Off,
    ReadOnly,
    E2e,
}

/// DNS seam so tests can prove that a name resolving to a private address is refused. Blocking; run on a blocking thread.
pub trait Resolver: Send + Sync {
    fn resolve(&self, host: &str, port: u16) -> std::io::Result<Vec<IpAddr>>;
}

pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve(&self, host: &str, port: u16) -> std::io::Result<Vec<IpAddr>> {
        Ok((host, port).to_socket_addrs()?.map(|a| a.ip()).collect())
    }
}

/// Which non-local hosts the Mac may talk to. `allowed_hosts` are lowercase `host[:non-default-port]` entries the user
/// acknowledged (or that this IDE deployed).
#[derive(Clone, Default)]
pub struct RelayTrust {
    pub allowed_hosts: Vec<String>,
    pub jail: RelayJail,
    pub resolver: Option<Arc<dyn Resolver>>,
}

impl std::fmt::Debug for RelayTrust {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayTrust").field("allowed_hosts", &self.allowed_hosts).field("jail", &self.jail).finish_non_exhaustive()
    }
}

fn bad(code: &str, msg: &str) -> RemoteError {
    RemoteError::Invalid(format!("{code}: {msg}"))
}

/// The relay address after strict parsing; everything else is rebuilt from these parts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRelay {
    pub secure: bool,
    /// Lowercase host name, or the loopback address without brackets.
    pub host: String,
    /// `None` = the scheme's default port.
    pub port: Option<u16>,
    pub local: bool,
}

impl ParsedRelay {
    /// `host[:port]` with a non-default port only, IPv6 in brackets: the form `allowed_hosts` is compared against.
    pub fn authority(&self) -> String {
        let h = if self.host.contains(':') { format!("[{}]", self.host) } else { self.host.clone() };
        match self.port {
            Some(p) => format!("{h}:{p}"),
            None => h,
        }
    }

    pub fn base(&self) -> String {
        format!("{}://{}", if self.secure { "wss" } else { "ws" }, self.authority())
    }

    fn connect_port(&self) -> u16 {
        self.port.unwrap_or(if self.secure { 443 } else { 80 })
    }
}

/// Parses once with `url::Url` and rejects everything that is not a plain `ws(s)://host[:port][/]`: userinfo, query, fragment,
/// any other path, backslashes, `%`, whitespace and control characters, non-ASCII hosts (give the `xn--` form), IP literals
/// other than the loopback literals (`127.1`, `0x7f.1` and `2130706433` count as other spellings), a trailing dot, over-long
/// labels and port 0. Error messages start with a stable code (`urlSyntax`, `scheme`, `userinfo`, `ipLiteral`, ...).
pub fn parse_relay(input: &str) -> Result<ParsedRelay> {
    if input.is_empty() || input.chars().any(|c| c <= ' ' || c == '\u{7f}' || c == '\\' || c == '%') {
        return Err(bad("urlSyntax", "the relay URL contains spaces, control characters, backslashes or percent escapes"));
    }
    if !input.is_ascii() {
        return Err(bad("idn", "use the ASCII (xn--) form of the host name"));
    }
    let lower = input.to_ascii_lowercase();
    let after = if let Some(r) = lower.strip_prefix("wss://") {
        r
    } else if let Some(r) = lower.strip_prefix("ws://") {
        r
    } else {
        return Err(bad("scheme", "the relay URL must start with ws:// or wss://"));
    };
    let secure = lower.starts_with("wss://");
    let end = after.find(['/', '?', '#']).unwrap_or(after.len());
    let authority = &after[..end];
    if authority.contains('@') {
        return Err(bad("userinfo", "the relay URL must not contain a user name or password"));
    }
    let raw_host = if authority.starts_with('[') {
        authority.split_once(']').map_or(authority, |(h, _)| &authority[..=h.len()])
    } else {
        authority.rsplit_once(':').map_or(authority, |(h, _)| h)
    };
    let url = Url::parse(input).map_err(|_| bad("urlSyntax", "the relay URL cannot be parsed"))?;
    if url.query().is_some() || url.fragment().is_some() {
        return Err(bad("urlSyntax", "the relay URL must not have a query or a fragment"));
    }
    if !matches!(url.path(), "" | "/") {
        return Err(bad("urlSyntax", "the relay URL must not have a path"));
    }
    if url.port() == Some(0) || authority.ends_with(":0") {
        return Err(bad("urlSyntax", "invalid port"));
    }
    let port = url.port();
    let (host, local) = match url.host() {
        Some(Host::Ipv4(ip)) => {
            if raw_host != ip.to_string() {
                return Err(bad("ipLiteral", "write IP addresses in their canonical form"));
            }
            if ip != Ipv4Addr::LOCALHOST {
                return Err(bad("ipLiteral", "IP addresses other than 127.0.0.1 are not accepted; use a host name"));
            }
            (ip.to_string(), true)
        }
        Some(Host::Ipv6(ip)) => {
            if ip != Ipv6Addr::LOCALHOST || raw_host != "[::1]" {
                return Err(bad("ipLiteral", "IP addresses other than ::1 are not accepted; use a host name"));
            }
            (ip.to_string(), true)
        }
        Some(Host::Domain(d)) => {
            if d != raw_host {
                return Err(bad("urlSyntax", "the host name is not in canonical form"));
            }
            if d.ends_with('.') || d.starts_with('.') || d.len() > 253 || d.split('.').any(|l| l.is_empty() || l.len() > 63 || l.starts_with('-') || l.ends_with('-') || !l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')) {
                return Err(bad("urlSyntax", "invalid host name"));
            }
            (d.to_string(), d == "localhost")
        }
        None => return Err(bad("urlSyntax", "the relay URL has no host")),
    };
    if !secure && !local {
        return Err(bad("insecure", "a relay on another host must use wss://"));
    }
    Ok(ParsedRelay { secure, host, port, local })
}

/// Frames the Mac sent today and the state of the relay link, for Settings (`relayStats`). Counting is per UTC day; the
/// 25 s text `ping` is auto-answered by the relay's hibernation and is not counted.
#[derive(Default)]
pub struct RelayStats {
    day: AtomicU64,
    frames: AtomicU64,
    failures: AtomicU32,
    last_error: Mutex<Option<String>>,
}

pub fn today_utc() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() / 86_400)
}

/// `YYYY-MM-DD` of a day number counted from 1970-01-01.
pub fn day_string(day: u64) -> String {
    let z = day as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

impl RelayStats {
    pub fn count_frame(&self) {
        self.count_frame_on(today_utc());
    }

    pub fn count_frame_on(&self, day: u64) {
        if self.day.swap(day, Ordering::SeqCst) != day {
            self.frames.store(0, Ordering::SeqCst);
        }
        self.frames.fetch_add(1, Ordering::SeqCst);
    }

    /// `(day number, frames)`; a counter from an earlier day reads as zero for `today`.
    pub fn frames_on(&self, today: u64) -> (u64, u64) {
        if self.day.load(Ordering::SeqCst) == today {
            (today, self.frames.load(Ordering::SeqCst))
        } else {
            (today, 0)
        }
    }

    pub fn frames_today(&self) -> (u64, u64) {
        self.frames_on(today_utc())
    }

    pub fn consecutive_failures(&self) -> u32 {
        self.failures.load(Ordering::SeqCst)
    }

    /// A short code (`dns`, `blockedAddress`, `tcp`, `timeout`, `roomCreate:503`, `handshake`), never a URL, host or token.
    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn failed(&self, code: &str) -> u32 {
        *self.last_error.lock().unwrap_or_else(PoisonError::into_inner) = Some(code.to_string());
        self.failures.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn connected(&self) {
        self.failures.store(0, Ordering::SeqCst);
        *self.last_error.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }
}

#[derive(Clone)]
pub struct RelayWs {
    /// `wss://relay.example` or `ws://127.0.0.1:8787` (no path), rebuilt from the parsed parts.
    pub base: String,
    parsed: ParsedRelay,
    resolver: Option<Arc<dyn Resolver>>,
    stats: Option<Arc<RelayStats>>,
}

impl std::fmt::Debug for RelayWs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayWs").field("base", &self.base).finish_non_exhaustive()
    }
}

/// Only the loopback literals are local (`*.localhost` is not).
pub fn host_is_local(base: &str) -> bool {
    parse_relay(base).is_ok_and(|p| p.local)
}

/// True for an address a public relay may have: not loopback, private, link-local, CGNAT, unspecified, multicast or reserved.
pub fn is_public_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !(v.is_loopback() || v.is_private() || v.is_link_local() || v.is_unspecified() || v.is_broadcast() || v.is_multicast() || o[0] == 0 || o[0] >= 240 || (o[0] == 100 && (64..=127).contains(&o[1])) || (o[0] == 192 && o[1] == 0 && o[2] == 0) || (o[0] == 198 && (o[1] == 18 || o[1] == 19)))
        }
        IpAddr::V6(v) => {
            if let Some(m) = v.to_ipv4_mapped() {
                return is_public_ip(&IpAddr::V4(m));
            }
            let s = v.segments();
            if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
                let o = v.octets();
                return is_public_ip(&IpAddr::V4(Ipv4Addr::new(o[12], o[13], o[14], o[15])));
            }
            !(v.is_loopback() || v.is_unspecified() || v.is_multicast() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80 || (s[0] & 0xffc0) == 0xfec0)
        }
    }
}

impl RelayWs {
    /// Local relays only, or a staging relay with `INTELY_REMOTE_STAGING=1` (never under a jail).
    pub fn new(base: &str) -> Result<Self> {
        Self::new_with(base, &RelayTrust::default())
    }

    /// A non-local host needs `wss://` and either an acknowledged host in `trust.allowed_hosts` or (jail Off only)
    /// `INTELY_REMOTE_STAGING=1`. Under `ReadOnly` and `E2e` every non-loopback host is refused whatever the variable says.
    pub fn new_with(base: &str, trust: &RelayTrust) -> Result<Self> {
        let parsed = parse_relay(base)?;
        if !parsed.local {
            match trust.jail {
                RelayJail::ReadOnly => return Err(bad("readOnly", "read-only mode never contacts a relay outside this machine")),
                RelayJail::E2e => return Err(bad("testJail", "the test jail only allows a relay on this machine")),
                RelayJail::Off => {
                    let staging = std::env::var("INTELY_REMOTE_STAGING").as_deref() == Ok("1");
                    let key = parsed.authority();
                    if !staging && !trust.allowed_hosts.iter().any(|h| h.eq_ignore_ascii_case(&key)) {
                        return Err(bad("hostNotAllowed", "this relay host has not been acknowledged"));
                    }
                }
            }
        }
        Ok(Self { base: parsed.base(), parsed, resolver: trust.resolver.clone(), stats: None })
    }

    pub fn with_stats(mut self, stats: Arc<RelayStats>) -> Self {
        self.stats = Some(stats);
        self
    }

    pub fn parsed(&self) -> &ParsedRelay {
        &self.parsed
    }

    pub fn ws_url(&self, room: &str) -> String {
        format!("{}/r/{room}/ws", self.base)
    }

    fn http_base(&self) -> String {
        self.base.replacen("wss://", "https://", 1).replacen("ws://", "http://", 1)
    }
}

pub fn encode_mac_frame(to: &str, body: &[u8]) -> Option<Vec<u8>> {
    let id = to.as_bytes();
    if id.len() > 255 || body.len() > MAX_FRAME {
        return None;
    }
    let mut v = Vec::with_capacity(2 + id.len() + body.len());
    v.push(1);
    v.push(id.len() as u8);
    v.extend_from_slice(id);
    v.extend_from_slice(body);
    Some(v)
}

/// `(qid, deviceId, ciphertext)` of a relay -> Mac frame.
pub fn decode_relay_frame(b: &[u8]) -> Option<(u32, String, Vec<u8>)> {
    if b.len() < 7 || b[0] != 1 {
        return None;
    }
    let qid = u32::from_be_bytes([b[2], b[3], b[4], b[5]]);
    let n = b[6] as usize;
    if b.len() < 7 + n {
        return None;
    }
    Some((qid, String::from_utf8(b[7..7 + n].to_vec()).ok()?, b[7 + n..].to_vec()))
}

fn admin_json(a: &Admin) -> String {
    match a {
        Admin::DevAdd { id, hash } => serde_json::json!({"t": "dev.add", "id": id, "hash": hash}),
        Admin::DevRevoke { id } => serde_json::json!({"t": "dev.revoke", "id": id}),
        Admin::PairOpen { hash, ttl_ms } => serde_json::json!({"t": "pair.open", "hash": hash, "ttlMs": ttl_ms}),
        Admin::Notify { kind, collapse_key } => serde_json::json!({"t": "notify", "kind": kind.as_str(), "collapseKey": collapse_key}),
        Admin::RoomWipe => serde_json::json!({"t": "room.wipe"}),
    }
    .to_string()
}

impl Transport for RelayWs {
    fn name(&self) -> &'static str {
        "relay-ws"
    }

    fn start(self: Box<Self>, identity: &Identity) -> TransportHandle {
        let (out_tx, out_rx) = mpsc::channel::<Outbound>(1024);
        let (in_tx, in_rx) = mpsc::channel::<Inbound>(1024);
        let (url, room, token, http) = (self.ws_url(&identity.room_id), identity.room_id.clone(), identity.mac_token.clone(), self.http_base());
        let this = *self;
        let task = tokio::spawn(async move { run(this, url, http, room, token, out_rx, in_tx).await });
        TransportHandle { tx: out_tx, rx: in_rx, task: Some(task) }
    }
}

/// Where to connect: `None` for the loopback literals (the system decides), the checked public address otherwise.
async fn pin_address(relay: &RelayWs) -> std::result::Result<Option<SocketAddr>, &'static str> {
    if relay.parsed.local {
        return Ok(None);
    }
    let (host, port) = (relay.parsed.host.clone(), relay.parsed.connect_port());
    let resolver: Arc<dyn Resolver> = relay.resolver.clone().unwrap_or_else(|| Arc::new(SystemResolver));
    let ips = tokio::time::timeout(STEP, tokio::task::spawn_blocking(move || resolver.resolve(&host, port)))
        .await
        .map_err(|_| "timeout")?
        .map_err(|_| "dns")?
        .map_err(|_| "dns")?;
    if ips.is_empty() {
        return Err("dns");
    }
    if ips.iter().any(|ip| !is_public_ip(ip)) {
        return Err("blockedAddress");
    }
    Ok(Some(SocketAddr::new(ips[0], port)))
}

async fn ensure_room(relay: &RelayWs, pin: Option<SocketAddr>, http: &str, room: &str, token: &str) -> std::result::Result<(), String> {
    let mut b = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(STEP);
    if let Some(addr) = pin {
        b = b.resolve(&relay.parsed.host, addr);
    }
    let r = b.build().map_err(|_| "tls".to_string())?.put(format!("{http}/r/{room}/create")).bearer_auth(token).send().await.map_err(|e| if e.is_timeout() { "timeout".to_string() } else { "http".to_string() })?;
    match r.status().as_u16() {
        200 | 201 => Ok(()),
        s => Err(format!("roomCreate:{s}")),
    }
}

async fn connect(relay: &RelayWs, url: &str, http: &str, room: &str, token: &str) -> std::result::Result<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, String> {
    let pin = pin_address(relay).await.map_err(str::to_string)?;
    ensure_room(relay, pin, http, room, token).await?;
    let mut req = url.into_client_request().map_err(|_| "handshake".to_string())?;
    req.headers_mut().insert("Sec-WebSocket-Protocol", format!("{PROTOCOL}, mac.{token}").parse().map_err(|_| "handshake".to_string())?);
    let port = relay.parsed.connect_port();
    let tcp = match pin {
        Some(addr) => tokio::time::timeout(STEP, tokio::net::TcpStream::connect(addr)).await,
        None => tokio::time::timeout(STEP, tokio::net::TcpStream::connect((relay.parsed.host.as_str(), port))).await,
    }
    .map_err(|_| "timeout".to_string())?
    .map_err(|_| "tcp".to_string())?;
    let cfg = WebSocketConfig::default().max_message_size(Some(MAX_INBOUND)).max_frame_size(Some(MAX_INBOUND));
    let (stream, _) = tokio::time::timeout(STEP + STEP, tokio_tungstenite::client_async_tls_with_config(req, tcp, Some(cfg), None)).await.map_err(|_| "timeout".to_string())?.map_err(|_| "handshake".to_string())?;
    Ok(stream)
}

async fn run(relay: RelayWs, url: String, http: String, room: String, token: String, mut out_rx: mpsc::Receiver<Outbound>, in_tx: mpsc::Sender<Inbound>) {
    let mut backoff = Duration::from_secs(1);
    let stats = relay.stats.clone();
    loop {
        let attempt = connect(&relay, &url, &http, &room, &token);
        let failed_code = match attempt.await {
            Ok(stream) => {
                backoff = Duration::from_secs(1);
                if let Some(s) = &stats {
                    s.connected();
                }
                let _ = in_tx.send(Inbound::Connected).await;
                let (mut sink, mut stream) = stream.split();
                let mut ping = tokio::time::interval_at(Instant::now() + PING_EVERY, PING_EVERY);
                let fatal = loop {
                    tokio::select! {
                        m = stream.next() => match m {
                            Some(Ok(Message::Binary(b))) => {
                                if let Some((qid, link, bytes)) = decode_relay_frame(&b) {
                                    if in_tx.send(Inbound::Frame { link, bytes }).await.is_err() { return; }
                                    if qid != 0 {
                                        let _ = sink.send(Message::text(serde_json::json!({"t": "ack", "upTo": qid}).to_string())).await;
                                    }
                                }
                            }
                            Some(Ok(Message::Text(t))) => {
                                if let Ok(v) = serde_json::from_str::<serde_json::Value>(t.as_str()) {
                                    if v["t"] == "peer" && v["state"] == "down" {
                                        if let Some(id) = v["id"].as_str() { let _ = in_tx.send(Inbound::PeerDown(id.to_string())).await; }
                                    }
                                }
                            }
                            Some(Ok(Message::Close(c))) => break c.is_some_and(|c| c.code == CloseCode::Library(CLOSE_WIPED)),
                            Some(Ok(_)) => {}
                            Some(Err(_)) | None => break false,
                        },
                        o = out_rx.recv() => match o {
                            None => { let _ = sink.close().await; return; }
                            Some(Outbound::Frame { link, bytes }) => {
                                if let Some(f) = encode_mac_frame(&link, &bytes) {
                                    if sink.send(Message::binary(f)).await.is_err() { break false; }
                                    if let Some(s) = &stats { s.count_frame(); }
                                }
                            }
                            Some(Outbound::Admin(a)) => { if sink.send(Message::text(admin_json(&a))).await.is_err() { break false; } }
                            Some(Outbound::Close(_)) => {}
                        },
                        _ = ping.tick() => { if sink.send(Message::text("ping")).await.is_err() { break false; } }
                    }
                };
                let _ = in_tx.send(Inbound::Disconnected).await;
                if fatal {
                    return;
                }
                None
            }
            Err(code) => {
                let _ = in_tx.send(Inbound::Disconnected).await;
                Some(code)
            }
        };
        let slow = match (&stats, failed_code) {
            (Some(s), Some(code)) => s.failed(&code) >= SLOW_AFTER_FAILURES,
            (None, Some(_)) => false,
            _ => false,
        };
        let cap = if slow { Duration::from_secs(300) } else { Duration::from_secs(30) };
        // jittered backoff, 1 s to 30 s; frames queued for a dead socket are dropped (the log has the events)
        let jitter = Duration::from_millis(u64::from(random::<2>()[0]) * 4);
        let wait = backoff + jitter;
        let deadline = Instant::now() + wait;
        while Instant::now() < deadline {
            tokio::select! {
                _ = sleep(Duration::from_millis(200)) => {}
                o = out_rx.recv() => if o.is_none() { return; },
            }
        }
        backoff = (backoff * 2).min(cap);
    }
}
