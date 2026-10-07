//! The relay WebSocket client against an in-process fake relay that speaks the framing of `remote-relay/src/frames.ts`
//! (loopback only; nothing leaves the machine).

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::*;
use futures_util::{SinkExt, StreamExt};
use intely_remote::noise::StaticKey;
use intely_remote::phone::{PhonePairing, PhoneSession};
use intely_remote::relay_ws::*;
use intely_remote::slot::{RemoteSlot, SlotConfig};
use intely_remote::util::sha256_hex;
use intely_remote::wire::*;
use intely_settings::{MemorySecretStore, SecretStore};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

#[derive(Default)]
struct Spy {
    ws_connections: AtomicUsize,
    creates: AtomicUsize,
    create_auth: Mutex<Vec<String>>,
    paths: Mutex<Vec<String>>,
    protocols: Mutex<Vec<String>>,
    from_mac: Mutex<Vec<Message>>,
    drop_now: AtomicUsize,
}

struct FakeRelay {
    port: u16,
    spy: Arc<Spy>,
    to_mac: mpsc::UnboundedSender<Message>,
    _rt: tokio::task::JoinHandle<()>,
}

async fn fake_relay() -> FakeRelay {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let spy: Arc<Spy> = Arc::default();
    let (to_mac, rx) = mpsc::unbounded_channel::<Message>();
    let rx = Arc::new(tokio::sync::Mutex::new(rx));
    let s2 = spy.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let (spy, rx) = (s2.clone(), rx.clone());
            tokio::spawn(async move {
                let mut peek = [0u8; 4];
                let _ = stream.peek(&mut peek).await;
                if &peek == b"PUT " {
                    let mut buf = vec![0u8; 4096];
                    let n = stream.read(&mut buf).await.unwrap();
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    spy.paths.lock().unwrap().push(req.lines().next().unwrap_or("").to_string());
                    if let Some(l) = req.lines().find(|l| l.to_ascii_lowercase().starts_with("authorization:")) {
                        spy.create_auth.lock().unwrap().push(l.split_once(':').unwrap().1.trim().to_string());
                    }
                    spy.creates.fetch_add(1, Ordering::SeqCst);
                    let _ = stream.write_all(b"HTTP/1.1 201 Created\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await;
                    return;
                }
                let spy2 = spy.clone();
                let ws = tokio_tungstenite::accept_hdr_async(stream, move |req: &tokio_tungstenite::tungstenite::handshake::server::Request, mut resp: tokio_tungstenite::tungstenite::handshake::server::Response| {
                    spy2.paths.lock().unwrap().push(format!("GET {}", req.uri().path()));
                    if let Some(p) = req.headers().get("sec-websocket-protocol") {
                        spy2.protocols.lock().unwrap().push(p.to_str().unwrap().to_string());
                    }
                    resp.headers_mut().insert("sec-websocket-protocol", "intely.v1".parse().unwrap());
                    Ok(resp)
                })
                .await;
                let Ok(mut ws) = ws else { return };
                spy.ws_connections.fetch_add(1, Ordering::SeqCst);
                let mut rx = rx.lock().await;
                loop {
                    tokio::select! {
                        m = ws.next() => match m {
                            Some(Ok(m)) => spy.from_mac.lock().unwrap().push(m),
                            _ => break,
                        },
                        m = rx.recv() => match m {
                            Some(m) => { if ws.send(m).await.is_err() { break; } }
                            None => break,
                        },
                        _ = tokio::time::sleep(Duration::from_millis(20)) => {
                            if spy.drop_now.swap(0, Ordering::SeqCst) == 1 { let _ = ws.close(None).await; break; }
                        }
                    }
                }
            });
        }
    });
    FakeRelay { port, spy, to_mac, _rt: task }
}

fn to_mac_frame(from: &str, body: &[u8], qid: u32) -> Message {
    let mut v = vec![1u8, 0];
    v.extend_from_slice(&qid.to_be_bytes());
    v.push(from.len() as u8);
    v.extend_from_slice(from.as_bytes());
    v.extend_from_slice(body);
    Message::binary(v)
}

fn from_mac_binary(spy: &Spy) -> Vec<(String, Vec<u8>)> {
    spy.from_mac
        .lock()
        .unwrap()
        .iter()
        .filter_map(|m| if let Message::Binary(b) = m { Some((String::from_utf8(b[2..2 + b[1] as usize].to_vec()).unwrap(), b[2 + b[1] as usize..].to_vec())) } else { None })
        .collect()
}

fn from_mac_json(spy: &Spy) -> Vec<serde_json::Value> {
    spy.from_mac.lock().unwrap().iter().filter_map(|m| if let Message::Text(t) = m { serde_json::from_str(t.as_str()).ok() } else { None }).collect()
}

async fn wait_for<T>(mut f: impl FnMut() -> Option<T>) -> T {
    let end = Instant::now() + Duration::from_secs(8);
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(Instant::now() < end, "timed out");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[test]
fn the_client_refuses_any_non_local_relay_host() {
    std::env::remove_var("INTELY_REMOTE_STAGING");
    assert!(RelayWs::new("wss://relay.example.workers.dev").is_err());
    assert!(RelayWs::new("wss://intely.example.com").is_err());
    assert!(RelayWs::new("https://localhost").is_err(), "must be ws(s)");
    for ok in ["ws://127.0.0.1:8787", "ws://localhost:8787", "ws://[::1]:8787"] {
        assert!(RelayWs::new(ok).is_ok(), "{ok}");
    }
    assert!(RelayWs::new("wss://relay.localhost").is_err(), "*.localhost is not a loopback literal any more");
    assert!(!host_is_local("wss://localhost.evil.example"));
    assert!(!host_is_local("wss://evil.example/localhost"));
}

#[test]
fn frames_match_the_relay_framing() {
    let f = encode_mac_frame("dev1", b"cipher").unwrap();
    assert_eq!(&f[..2], &[1, 4]);
    assert_eq!(&f[2..6], b"dev1");
    let mut incoming = vec![1u8, 0, 0, 0, 0, 7, 4];
    incoming.extend_from_slice(b"dev1");
    incoming.extend_from_slice(b"cipher");
    assert_eq!(decode_relay_frame(&incoming), Some((7, "dev1".into(), b"cipher".to_vec())));
    for bad in [vec![], vec![2, 0, 0, 0, 0, 0, 0], vec![1, 0, 0, 0, 0, 0, 9, 1], vec![1, 0, 0]] {
        assert_eq!(decode_relay_frame(&bad), None);
    }
    assert!(encode_mac_frame("d", &vec![0u8; 70_000]).is_none(), "over the relay's 64 KB cap");
}

#[tokio::test(flavor = "current_thread")]
async fn pairing_reconnect_and_an_answer_through_the_relay_client() {
    let relay = fake_relay().await;
    let dir = tempfile::tempdir().unwrap();
    let hub = FakeHub::new(dir.path(), intely_remote::util::ManualClock::new(T0));
    let secrets: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::new());
    let host = Arc::new(Mutex::new(Vec::new()));
    let h2 = host.clone();
    let slot = RemoteSlot::new(hub.clone(), secrets, SlotConfig { state_dir: dir.path().join("state"), gateway: cfg(), relay_url: format!("ws://127.0.0.1:{}", relay.port), expected_bundle_hash: None, trust: Default::default(), bundle: None, relay_mode: String::new() }, Arc::new(move |e| h2.lock().unwrap().push(e)));
    assert_eq!(relay.spy.ws_connections.load(Ordering::SeqCst), 0, "off: no connection exists");
    slot.enable().unwrap();
    let ident = slot.store().unwrap().identity();

    // room creation, then the socket with the credential in the subprotocol (never in the URL)
    wait_for(|| (relay.spy.ws_connections.load(Ordering::SeqCst) == 1).then_some(())).await;
    assert_eq!(relay.spy.creates.load(Ordering::SeqCst), 1);
    assert_eq!(relay.spy.create_auth.lock().unwrap()[0], format!("Bearer {}", ident.mac_token));
    let paths = relay.spy.paths.lock().unwrap().clone();
    assert!(paths.iter().any(|p| p.starts_with(&format!("PUT /r/{}/create", ident.room_id))));
    assert!(paths.iter().any(|p| p == &format!("GET /r/{}/ws", ident.room_id)), "{paths:?}");
    assert!(!paths.iter().any(|p| p.contains(&ident.mac_token)), "the token is never in a URL");
    assert_eq!(relay.spy.protocols.lock().unwrap()[0], format!("intely.v1, mac.{}", ident.mac_token));

    // pairing: the Mac registers the one-time token hash with the relay
    let view = slot.pair_start().unwrap();
    let otp = intely_remote::pairing::parse_manual_code(&view.manual_code).unwrap();
    let open = wait_for(|| from_mac_json(&relay.spy).into_iter().find(|j| j["t"] == "pair.open")).await;
    assert_eq!(open["hash"], sha256_hex(intely_remote::noise::pair_token_from_otp(&otp).as_bytes()));
    assert_eq!(open["ttlMs"], 60_000);

    let key = StaticKey::generate();
    let (mut pp, first) = PhonePairing::start(key.clone(), &ident.static_key.public, &otp, "iPhone").unwrap();
    relay.to_mac.send(to_mac_frame("pair-ab12", &first, 0)).unwrap();
    let n = from_mac_binary(&relay.spy).len();
    let (_, reply) = wait_for(|| from_mac_binary(&relay.spy).get(n).cloned()).await;
    for r in pp.on_frame(&reply).unwrap() {
        relay.to_mac.send(to_mac_frame("pair-ab12", &r, 9)).unwrap(); // a queued frame: must be acked
    }
    wait_for(|| from_mac_json(&relay.spy).into_iter().find(|j| j["t"] == "ack" && j["upTo"] == 9)).await;
    let h3 = host.clone();
    wait_for(|| h3.lock().unwrap().iter().any(|h| matches!(h, intely_remote::gateway::HostEvent::PairingSas { .. })).then_some(())).await;
    slot.pair_confirm(true, None, Capability::Reply);
    let n = from_mac_binary(&relay.spy).len();
    let (to, accepted) = wait_for(|| from_mac_binary(&relay.spy).get(n).cloned()).await;
    assert_eq!(to, "pair-ab12");
    pp.on_frame(&accepted).unwrap();
    let acc = pp.accepted.clone().unwrap();
    let add = wait_for(|| from_mac_json(&relay.spy).into_iter().find(|j| j["t"] == "dev.add")).await;
    assert_eq!(add["id"], acc.device_id);
    assert_eq!(add["hash"], sha256_hex(acc.device_token.as_bytes()), "the relay stores the hash of the token the phone holds");

    // reconnect as the device and answer a request
    let (mut s, first) = PhoneSession::connect(&key, &ident.static_key.public).unwrap();
    let n = from_mac_binary(&relay.spy).len();
    relay.to_mac.send(to_mac_frame(&acc.device_id, &first, 0)).unwrap();
    let (to, ik) = wait_for(|| from_mac_binary(&relay.spy).get(n).cloned()).await;
    assert_eq!(to, acc.device_id);
    s.on_frame(&ik).unwrap();
    let p = hub.ask_permission("r1", intely_agent_core::policy::intent::ToolIntent::exec("git status"));
    let ans = s.send(&ClientMsg::Answer { op_id: "o1".into(), req_id: "r1".into(), agent_id: AGENT.into(), decision: Some(intely_agent_core::api::PermissionDecision::AllowOnce), question: None, intent_hash: Some(p.intent_hash), step_up: None }).unwrap();
    relay.to_mac.send(to_mac_frame(&acc.device_id, &ans, 0)).unwrap();
    let h = hub.clone();
    wait_for(|| (!h.permission_answers.lock().unwrap().is_empty()).then_some(())).await;
    // a content-free notification went to the relay for the request
    let note = wait_for(|| from_mac_json(&relay.spy).into_iter().find(|j| j["t"] == "notify")).await;
    assert_eq!(note["kind"], "needsYou");
    assert!(!note.to_string().contains("git status"));

    // the socket drops: the client reconnects by itself
    relay.spy.drop_now.store(1, Ordering::SeqCst);
    wait_for(|| (relay.spy.ws_connections.load(Ordering::SeqCst) >= 2).then_some(())).await;
    let before = relay.spy.ws_connections.load(Ordering::SeqCst);
    slot.disable();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(relay.spy.ws_connections.load(Ordering::SeqCst), before, "disabled: no reconnect");
}
