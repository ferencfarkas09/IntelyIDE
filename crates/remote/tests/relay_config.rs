//! Relay trust, network rules, live apply, the `welcome` pin and the new view fields ((design notes: remote-cloudflare-spec), T3).
//! Loopback only: nothing here contacts a real host; DNS is a fake resolver.

mod common;

use std::net::IpAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::*;
use futures_util::{SinkExt, StreamExt};
use intely_remote::api::{BundleSource, BundleView};
use intely_remote::devices::Device;
use intely_remote::gateway::{GatewayCfg, GatewayCore};
use intely_remote::identity::Identity;
use intely_remote::relay_ws::*;
use intely_remote::slot::{ApplyHooks, RelayConfig, RemoteSlot, SlotConfig};
use intely_remote::transport::{loopback, Admin, Transport};
use intely_remote::wire::{Capability, ServerMsg};
use intely_remote::RemoteError;
use intely_settings::{MemorySecretStore, SecretStore};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

fn msg(e: RemoteError) -> String {
    e.to_string()
}

fn trust(hosts: &[&str]) -> RelayTrust {
    RelayTrust { allowed_hosts: hosts.iter().map(|h| h.to_string()).collect(), ..RelayTrust::default() }
}

struct FixedResolver(Vec<IpAddr>);

impl Resolver for FixedResolver {
    fn resolve(&self, _host: &str, _port: u16) -> std::io::Result<Vec<IpAddr>> {
        Ok(self.0.clone())
    }
}

fn resolver(ips: &[&str]) -> Option<Arc<dyn Resolver>> {
    Some(Arc::new(FixedResolver(ips.iter().map(|i| i.parse().unwrap()).collect())))
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

// ------------------------------------------------------------------ URL rules (4.2, 4.12.5)

#[test]
fn the_url_table_accepts_only_plain_ws_urls() {
    std::env::remove_var("INTELY_REMOTE_STAGING");
    let t = trust(&["my-relay.example.workers.dev", "relay.example:8443", "xn--bcher-kva.example"]);
    for ok in [
        "ws://127.0.0.1:8787",
        "ws://127.0.0.1:8787/",
        "ws://localhost:8787",
        "ws://[::1]:8787",
        "wss://my-relay.example.workers.dev",
        "wss://my-relay.example.workers.dev/",
        "wss://MY-RELAY.example.workers.dev", // normalised to lowercase
        "wss://relay.example:8443",
        "wss://xn--bcher-kva.example",
    ] {
        assert!(RelayWs::new_with(ok, &t).is_ok(), "{ok} should be accepted: {:?}", RelayWs::new_with(ok, &t).err());
    }
    for (bad, code) in [
        ("", "urlSyntax"),
        ("https://my-relay.example.workers.dev", "scheme"),
        ("http://127.0.0.1:8787", "scheme"),
        ("wss:my-relay.example.workers.dev", "scheme"),
        ("ws://my-relay.example.workers.dev", "insecure"),
        ("wss://user@my-relay.example.workers.dev", "userinfo"),
        ("wss://user:pw@my-relay.example.workers.dev", "userinfo"),
        ("wss://my-relay.example.workers.dev/path", "urlSyntax"),
        ("wss://my-relay.example.workers.dev//", "urlSyntax"),
        ("wss://my-relay.example.workers.dev?x=1", "urlSyntax"),
        ("wss://my-relay.example.workers.dev/?x=1", "urlSyntax"),
        ("wss://my-relay.example.workers.dev#frag", "urlSyntax"),
        ("wss://my-relay.example.workers.dev\\@evil.example", "urlSyntax"),
        ("wss://my-relay.example.workers.dev/%2e", "urlSyntax"),
        ("wss://my-relay.example%2eworkers.dev", "urlSyntax"),
        ("wss://my-relay.example.workers.dev\t", "urlSyntax"),
        ("wss://my-relay.example.workers.dev\n", "urlSyntax"),
        ("wss://my-relay.example.workers.dev ", "urlSyntax"),
        ("wss://my-relay.example.workers.dev.", "urlSyntax"),
        ("wss://bücher.example", "idn"),
        ("wss://127.0.0.2", "ipLiteral"),
        ("ws://127.1:8787", "ipLiteral"),
        ("ws://0x7f.1:8787", "ipLiteral"),
        ("ws://2130706433:8787", "ipLiteral"),
        ("ws://0.0.0.0:8787", "ipLiteral"),
        ("wss://10.0.0.5", "ipLiteral"),
        ("wss://[::ffff:127.0.0.1]", "ipLiteral"),
        ("wss://[2001:db8::1]", "ipLiteral"),
        ("wss://relay.example:0", "urlSyntax"),
        ("wss://relay.example:99999", "urlSyntax"),
        ("wss://-bad.example", "urlSyntax"),
    ] {
        let e = RelayWs::new_with(bad, &t).expect_err(bad);
        assert!(msg(e).starts_with(code), "{bad} should fail with {code}");
    }
    // labels over 63 and total over 253
    assert!(parse_relay(&format!("wss://{}.example", "a".repeat(64))).is_err());
    assert!(parse_relay(&format!("wss://{}", vec!["a".repeat(60); 5].join("."))).is_err());
    // *.localhost is not a loopback literal
    assert!(msg(RelayWs::new_with("wss://relay.localhost", &RelayTrust::default()).unwrap_err()).starts_with("hostNotAllowed"));
    assert!(msg(RelayWs::new_with("ws://relay.localhost", &t).unwrap_err()).starts_with("insecure"));
}

#[test]
fn a_rebuilt_base_comes_from_the_parsed_parts() {
    let t = trust(&["relay.example"]);
    assert_eq!(RelayWs::new_with("wss://RELAY.example/", &t).unwrap().base, "wss://relay.example");
    assert_eq!(RelayWs::new_with("ws://[::1]:8787", &t).unwrap().base, "ws://[::1]:8787");
    assert_eq!(parse_relay("wss://relay.example:443").unwrap().authority(), "relay.example");
}

#[test]
fn trust_and_the_jail_decide_which_hosts_are_reachable() {
    std::env::remove_var("INTELY_REMOTE_STAGING");
    let url = "wss://relay.example";
    assert!(msg(RelayWs::new_with(url, &RelayTrust::default()).unwrap_err()).starts_with("hostNotAllowed"));
    assert!(RelayWs::new_with(url, &trust(&["Relay.Example"])).is_ok());
    assert!(RelayWs::new_with("wss://relay.example:8443", &trust(&["relay.example"])).is_err(), "another port is another host");
    // the read-only and test jails refuse every non-loopback host, acknowledged or not, staging variable or not
    std::env::set_var("INTELY_REMOTE_STAGING", "1");
    assert!(RelayWs::new_with(url, &RelayTrust::default()).is_ok(), "staging variable works with the jail off");
    for (jail, code) in [(RelayJail::ReadOnly, "readOnly"), (RelayJail::E2e, "testJail")] {
        let t = RelayTrust { allowed_hosts: vec!["relay.example".into()], jail, resolver: None };
        assert!(msg(RelayWs::new_with(url, &t).unwrap_err()).starts_with(code), "{jail:?}");
        assert!(RelayWs::new_with("ws://127.0.0.1:8787", &t).is_ok(), "loopback stays allowed under {jail:?}");
    }
    std::env::remove_var("INTELY_REMOTE_STAGING");
}

#[test]
fn only_public_addresses_pass_the_resolver_check() {
    for ok in ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"] {
        assert!(is_public_ip(&ok.parse().unwrap()), "{ok}");
    }
    for bad in [
        "127.0.0.1", "127.1.2.3", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1",
        "255.255.255.255", "240.0.0.1", "198.18.0.1", "192.0.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
        "64:ff9b::7f00:1", "fec0::1",
    ] {
        assert!(!is_public_ip(&bad.parse().unwrap()), "{bad}");
    }
}

// ------------------------------------------------------------------ a fake relay for the network rules

#[derive(Default)]
struct Spy {
    puts: AtomicUsize,
    ws: AtomicUsize,
    ws_closed_by_client: AtomicUsize,
}

enum Mode {
    /// 302 to the given URL on the create request.
    Redirect(String),
    /// Normal create, then a websocket that sends one oversized frame.
    BigFrame,
    Plain,
}

async fn fake_relay(mode: Mode) -> (u16, Arc<Spy>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let spy: Arc<Spy> = Arc::default();
    let mode = Arc::new(mode);
    let (s2, m2) = (spy.clone(), mode.clone());
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { return };
            let (spy, mode) = (s2.clone(), m2.clone());
            tokio::spawn(async move {
                let mut peek = [0u8; 4];
                let _ = stream.peek(&mut peek).await;
                if &peek == b"PUT " {
                    let mut buf = vec![0u8; 4096];
                    let _ = stream.read(&mut buf).await;
                    spy.puts.fetch_add(1, Ordering::SeqCst);
                    let reply = match &*mode {
                        Mode::Redirect(t) => format!("HTTP/1.1 302 Found\r\nlocation: {t}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"),
                        _ => "HTTP/1.1 201 Created\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_string(),
                    };
                    let _ = stream.write_all(reply.as_bytes()).await;
                    return;
                }
                if matches!(&*mode, Mode::Redirect(_)) {
                    spy.ws.fetch_add(1, Ordering::SeqCst);
                    return;
                }
                let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(stream, |_: &tokio_tungstenite::tungstenite::handshake::server::Request, mut resp: tokio_tungstenite::tungstenite::handshake::server::Response| {
                    resp.headers_mut().insert("sec-websocket-protocol", "intely.v1".parse().unwrap());
                    Ok(resp)
                })
                .await
                else {
                    return;
                };
                spy.ws.fetch_add(1, Ordering::SeqCst);
                if matches!(&*mode, Mode::BigFrame) {
                    let _ = ws.send(Message::binary(vec![0u8; 200 * 1024])).await;
                }
                // the client must hang up; a well-behaved client sends nothing but text control here
                loop {
                    match tokio::time::timeout(Duration::from_secs(4), ws.next()).await {
                        Ok(Some(Ok(Message::Text(_)))) | Ok(Some(Ok(Message::Binary(_)))) | Ok(Some(Ok(Message::Ping(_)))) | Ok(Some(Ok(Message::Pong(_)))) => continue,
                        _ => break,
                    }
                }
                spy.ws_closed_by_client.fetch_add(1, Ordering::SeqCst);
            });
        }
    });
    (port, spy, task)
}

fn start_transport(relay: RelayWs) -> (intely_remote::transport::TransportHandle, Identity) {
    let id = Identity::fresh();
    let h = Box::new(relay).start(&id);
    (h, id)
}

#[tokio::test(flavor = "current_thread")]
async fn a_redirect_from_the_relay_is_never_followed() {
    let (other_port, other, _t1) = fake_relay(Mode::Plain).await; // the "internal" target a redirect would reach
    let (port, spy, _t2) = fake_relay(Mode::Redirect(format!("http://127.0.0.1:{other_port}/r/x/create"))).await;
    let stats = Arc::new(RelayStats::default());
    let relay = RelayWs::new(&format!("ws://127.0.0.1:{port}")).unwrap().with_stats(stats.clone());
    let (_h, _id) = start_transport(relay);
    wait_for(|| (stats.last_error().as_deref() == Some("roomCreate:302")).then_some(())).await;
    assert_eq!(spy.puts.load(Ordering::SeqCst), 1);
    assert_eq!(other.puts.load(Ordering::SeqCst), 0, "the redirect target was never contacted");
    assert_eq!(spy.ws.load(Ordering::SeqCst), 0, "no websocket after a refused create");
    assert!(stats.consecutive_failures() >= 1);
}

#[tokio::test(flavor = "current_thread")]
async fn a_name_that_resolves_to_a_private_address_is_refused_before_any_socket() {
    for answer in [&["10.0.0.5"][..], &["127.0.0.1"], &["93.184.216.34", "192.168.0.7"], &["169.254.169.254"], &["::1"], &["100.64.1.1"]] {
        let t = RelayTrust { allowed_hosts: vec!["relay.example".into()], jail: RelayJail::Off, resolver: resolver(answer) };
        let stats = Arc::new(RelayStats::default());
        let (_h, _id) = start_transport(RelayWs::new_with("wss://relay.example", &t).unwrap().with_stats(stats.clone()));
        wait_for(|| (stats.last_error().as_deref() == Some("blockedAddress")).then_some(())).await;
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a_frame_over_128_kb_ends_the_connection() {
    let (port, spy, _t) = fake_relay(Mode::BigFrame).await;
    let (_h, _id) = start_transport(RelayWs::new(&format!("ws://127.0.0.1:{port}")).unwrap());
    wait_for(|| (spy.ws.load(Ordering::SeqCst) >= 1).then_some(())).await;
    wait_for(|| (spy.ws_closed_by_client.load(Ordering::SeqCst) >= 1).then_some(())).await;
}

#[tokio::test(flavor = "current_thread")]
async fn sent_frames_are_counted_and_the_error_clears_on_connect() {
    let (port, spy, _t) = fake_relay(Mode::Plain).await;
    let stats = Arc::new(RelayStats::default());
    let (h, _id) = start_transport(RelayWs::new(&format!("ws://127.0.0.1:{port}")).unwrap().with_stats(stats.clone()));
    wait_for(|| (spy.ws.load(Ordering::SeqCst) == 1).then_some(())).await;
    assert!(stats.last_error().is_none());
    for _ in 0..3 {
        h.tx.send(intely_remote::transport::Outbound::Frame { link: "dev1".into(), bytes: vec![1, 2, 3] }).await.unwrap();
    }
    h.tx.send(intely_remote::transport::Outbound::Admin(Admin::RoomWipe)).await.unwrap(); // text control frames are not counted
    wait_for(|| (stats.frames_today().1 == 3).then_some(())).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(stats.frames_today().1, 3);
}

#[test]
fn the_frame_counter_rolls_over_at_midnight_utc() {
    let s = RelayStats::default();
    s.count_frame_on(20_000);
    s.count_frame_on(20_000);
    assert_eq!(s.frames_on(20_000), (20_000, 2));
    assert_eq!(s.frames_on(20_001), (20_001, 0), "a counter from yesterday reads as zero");
    s.count_frame_on(20_001);
    assert_eq!(s.frames_on(20_001), (20_001, 1));
    assert_eq!(day_string(0), "1970-01-01");
    assert_eq!(day_string(19_723), "2024-01-01");
    assert_eq!(day_string(19_782), "2024-02-29");
}

#[tokio::test(flavor = "current_thread")]
async fn a_failing_relay_records_a_short_code_and_a_growing_count() {
    let stats = Arc::new(RelayStats::default());
    let (_h, _id) = start_transport(RelayWs::new("ws://127.0.0.1:1").unwrap().with_stats(stats.clone()));
    wait_for(|| (stats.consecutive_failures() >= 1).then_some(())).await;
    let e = stats.last_error().unwrap();
    assert!(!e.contains("127.0.0.1") && !e.contains("/"), "an error code never carries a host or URL: {e}");
}

// ------------------------------------------------------------------ the slot: set_relay, apply_relay

fn dev(n: usize) -> Device {
    Device { id: format!("dev{n}"), name: format!("Phone {n}"), static_pub: format!("{n:064x}"), passkey: None, capability: Capability::View, created_at: 1, last_seen_at: 1, last_reauth_at: 1, token_hash: "h".into(), push_endpoint_hash: None, pinned: false }
}

fn target(url: &str, host: &str, rp: &str) -> RelayConfig {
    RelayConfig {
        relay_url: url.into(),
        relay_host: host.into(),
        rp_id: rp.into(),
        origin: format!("https://{rp}"),
        expected_bundle_hash: None,
        bundle: None,
        bundle_pub: None,
        // the resolver answers a private address, so even a re-enabled slot never opens a socket to a real host
        trust: RelayTrust { allowed_hosts: vec!["relay.example".into()], jail: RelayJail::Off, resolver: resolver(&["10.0.0.9"]) },
        mode: "custom".into(),
    }
}

struct Rig {
    _dir: tempfile::TempDir,
    slot: RemoteSlot,
}

fn rig(relay: &str) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let hub = FakeHub::new(dir.path(), intely_remote::util::ManualClock::new(T0));
    let secrets: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::new());
    let gateway = GatewayCfg { rp_id: "localhost".into(), origin: "http://localhost".into(), relay_host: "127.0.0.1:1".into(), ..cfg() };
    let slot = RemoteSlot::new(hub, secrets, SlotConfig { state_dir: dir.path().join("state"), gateway, relay_url: relay.into(), expected_bundle_hash: None, trust: Default::default(), bundle: None, relay_mode: "local".into() }, Arc::new(|_| {}));
    Rig { _dir: dir, slot }
}

/// Starts the slot on a loopback transport and drains the "relay" side in a thread; returns the admin messages it saw.
fn start_on_loopback(r: &Rig) -> Arc<Mutex<Vec<Admin>>> {
    let (t, mut peer) = loopback();
    let admin = peer.admin.clone();
    r.slot.enable_with(Box::new(t)).unwrap();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async move { while peer.recv().await.is_some() {} });
    });
    admin
}

#[test]
fn set_relay_is_busy_while_on_and_applies_while_off() {
    let r = rig("ws://127.0.0.1:1");
    let _admin = start_on_loopback(&r);
    let e = r.slot.set_relay(target("wss://relay.example", "relay.example", "relay.example")).unwrap_err();
    assert!(msg(e).starts_with("busy"));
    r.slot.disable();
    r.slot.set_relay(target("wss://relay.example", "relay.example", "relay.example")).unwrap();
    let v = r.slot.settings_view();
    assert_eq!(v.relay, "wss://relay.example");
    assert_eq!(v.relay_mode, "custom");
    assert!(v.relay_host_allowed);
    // an unacknowledged host is refused and changes nothing
    let mut bad = target("wss://other.example", "other.example", "other.example");
    bad.trust.allowed_hosts.clear();
    assert!(msg(r.slot.set_relay(bad).unwrap_err()).starts_with("hostNotAllowed"));
    assert_eq!(r.slot.settings_view().relay, "wss://relay.example");
}

#[test]
fn a_host_whose_pairing_qr_would_not_fit_is_refused() {
    let r = rig("ws://127.0.0.1:1");
    assert!(intely_remote::pairing::qr_fits("my-relay.example.workers.dev"));
    let long = format!("{}.{}.{}", "b".repeat(50), "c".repeat(50), "d".repeat(50));
    assert!(!intely_remote::pairing::qr_fits(&long));
    let mut t = target(&format!("wss://{long}"), &long, &long);
    t.trust.allowed_hosts = vec![long.clone()];
    assert!(msg(r.slot.set_relay(t).unwrap_err()).starts_with("qrBudget"));
}

#[test]
fn needs_repair_has_no_side_effect() {
    let r = rig("ws://127.0.0.1:1");
    r.slot.store().unwrap().with_registry(|reg| reg.add(dev(1))).unwrap();
    let admin = start_on_loopback(&r);
    let calls = Mutex::new(Vec::<&str>::new());
    let (mut persist, mut restore) = (|| -> intely_remote::Result<()> { calls.lock().unwrap().push("persist"); Ok(()) }, || calls.lock().unwrap().push("restore"));
    let (stop, start) = (|| calls.lock().unwrap().push("stop"), || calls.lock().unwrap().push("start"));
    let e = r.slot.apply_relay(target("wss://relay.example", "relay.example", "relay.example"), false, ApplyHooks { persist: &mut persist, restore: &mut restore, stop_worker: &stop, start_worker: &start }).unwrap_err();
    assert_eq!(msg(e), "needsRepair: 1");
    assert!(calls.lock().unwrap().is_empty(), "no hook ran");
    assert!(r.slot.is_on(), "still on");
    assert_eq!(r.slot.settings_view().relay, "ws://127.0.0.1:1");
    assert_eq!(r.slot.store().unwrap().devices().len(), 1);
    assert!(admin.lock().unwrap().is_empty(), "nothing was sent to the relay");
    r.slot.disable();
}

#[test]
fn apply_wipes_the_old_room_while_connected_then_switches_and_comes_back_on() {
    let r = rig("ws://127.0.0.1:1");
    r.slot.store().unwrap().with_registry(|reg| reg.add(dev(1))).unwrap();
    let admin = start_on_loopback(&r);
    let calls = Mutex::new(Vec::<&str>::new());
    let admin2 = admin.clone();
    let (mut persist, mut restore) = (
        || -> intely_remote::Result<()> {
            assert!(admin2.lock().unwrap().is_empty(), "settings are written before anything irreversible");
            calls.lock().unwrap().push("persist");
            Ok(())
        },
        || calls.lock().unwrap().push("restore"),
    );
    let (stop, start) = (|| calls.lock().unwrap().push("stop"), || calls.lock().unwrap().push("start"));
    let out = r.slot.apply_relay(target("wss://relay.example", "relay.example", "relay.example"), true, ApplyHooks { persist: &mut persist, restore: &mut restore, stop_worker: &stop, start_worker: &start }).unwrap();
    assert!(out.host_changed && out.unpaired && out.was_on);
    assert_eq!(*calls.lock().unwrap(), vec!["persist", "stop", "start"]);
    assert!(admin.lock().unwrap().contains(&Admin::RoomWipe), "the OLD relay saw room.wipe while the Mac was still connected");
    assert!(r.slot.store().unwrap().devices().is_empty(), "phones are unpaired");
    assert_eq!(r.slot.settings_view().relay, "wss://relay.example");
    assert!(r.slot.is_on(), "Remote was on and is on again");
    r.slot.disable();
}

#[test]
fn a_settings_write_failure_aborts_before_the_panic() {
    let r = rig("ws://127.0.0.1:1");
    r.slot.store().unwrap().with_registry(|reg| reg.add(dev(1))).unwrap();
    let admin = start_on_loopback(&r);
    let calls = Mutex::new(Vec::<&str>::new());
    let (mut persist, mut restore) = (|| -> intely_remote::Result<()> { Err(RemoteError::Invalid("disk full".into())) }, || calls.lock().unwrap().push("restore"));
    let (stop, start) = (|| calls.lock().unwrap().push("stop"), || calls.lock().unwrap().push("start"));
    let e = r.slot.apply_relay(target("wss://relay.example", "relay.example", "relay.example"), true, ApplyHooks { persist: &mut persist, restore: &mut restore, stop_worker: &stop, start_worker: &start }).unwrap_err();
    assert_eq!(msg(e), "disk full");
    assert!(calls.lock().unwrap().is_empty());
    assert!(admin.lock().unwrap().is_empty(), "no room.wipe was sent");
    assert_eq!(r.slot.store().unwrap().devices().len(), 1, "phones stay paired");
    assert!(r.slot.is_on());
    assert_eq!(r.slot.settings_view().relay, "ws://127.0.0.1:1");
    r.slot.disable();
}

#[test]
fn the_same_host_switches_without_unpairing_and_an_off_slot_stays_off() {
    let r = rig("ws://127.0.0.1:1");
    r.slot.store().unwrap().with_registry(|reg| reg.add(dev(1))).unwrap();
    let (mut persist, mut restore) = (|| -> intely_remote::Result<()> { Ok(()) }, || {});
    let (stop, start) = (|| {}, || {});
    let mut t = target("ws://127.0.0.1:2", "127.0.0.1:2", "localhost");
    t.mode = "local".into();
    let out = r.slot.apply_relay(t, false, ApplyHooks { persist: &mut persist, restore: &mut restore, stop_worker: &stop, start_worker: &start }).unwrap();
    assert!(!out.host_changed && !out.unpaired && !out.was_on);
    assert!(!r.slot.is_on(), "was off, stays off");
    assert_eq!(r.slot.store().unwrap().devices().len(), 1);
    assert_eq!(r.slot.settings_view().relay, "ws://127.0.0.1:2");
}

// ------------------------------------------------------------------ the welcome pin (4.6)

const PUB: &str = "A3x0yS3QYb0r0Z0fQ0b0c0d0e0f0g0h0i0j0k0l0m0n"; // opaque to the gateway

fn env_with_pin(pin: Option<&str>) -> Env {
    let mut env = Env::new();
    env.core = GatewayCore::new(GatewayCfg { bundle_pub: pin.map(str::to_string), ..cfg() }, env.hub.clone(), env.store.clone());
    env
}

#[test]
fn pairing_delivers_the_build_key_before_accepted_and_marks_the_device_pinned() {
    let mut env = env_with_pin(Some(PUB));
    let phone = env.pair("iPhone", Capability::View);
    assert!(env.store.device(&phone.device_id).unwrap().pinned, "the Mac recorded that it delivered the key");
    // the QR stays at four fields
    let (view, _) = env.core.pair_start();
    assert_eq!(view.qr_fragment.trim_start_matches("#p=").split(',').count(), 4);
}

#[test]
fn a_phone_paired_without_a_key_is_unpinned_and_gets_welcome_on_its_next_session() {
    let mut env = env_with_pin(None);
    let mut phone = env.pair("iPhone", Capability::View);
    assert!(!env.store.device(&phone.device_id).unwrap().pinned);
    let first = env.connect(&mut phone);
    assert!(!first.iter().any(|m| matches!(m, ServerMsg::Welcome { .. })));
    // a cloud profile appears: the core now knows the key; the next session carries it
    env.core = GatewayCore::new(GatewayCfg { bundle_pub: Some(PUB.into()), ..cfg() }, env.hub.clone(), env.store.clone());
    let again = env.connect(&mut phone);
    assert!(again.iter().any(|m| matches!(m, ServerMsg::Welcome { bundle_pub } if bundle_pub == PUB)), "{again:?}");
    assert!(env.store.device(&phone.device_id).unwrap().pinned);
}

#[test]
fn send_my_build_key_reaches_live_sessions_only_when_a_key_exists() {
    let mut env = env_with_pin(None);
    let mut phone = env.pair("iPhone", Capability::View);
    env.connect(&mut phone);
    assert!(env.core.send_welcome_all().is_empty(), "no key, nothing to send");
    env.core = GatewayCore::new(GatewayCfg { bundle_pub: Some(PUB.into()), ..cfg() }, env.hub.clone(), env.store.clone());
    env.connect(&mut phone);
    let outs = env.core.send_welcome_all();
    let got = env.deliver(&mut phone, outs);
    assert!(got.iter().any(|m| matches!(m, ServerMsg::Welcome { .. })));
}

// ------------------------------------------------------------------ view fields

#[test]
fn the_view_carries_mode_trust_bundle_and_stats_and_never_a_secret() {
    let r = rig("ws://127.0.0.1:1");
    let bundle = BundleView::new("a1b2c3d4e5f60718aaaa", "", 7, 1_700_000_000, BundleSource::SignedLocal);
    assert_eq!(bundle.hash_short, "a1b2 c3d4 e5f6 0718");
    let mut t = target("wss://relay.example", "relay.example", "relay.example");
    t.bundle = Some(bundle);
    r.slot.set_relay(t).unwrap();
    let j = serde_json::to_value(r.slot.settings_view()).unwrap();
    assert_eq!(j["relayMode"], "custom");
    assert_eq!(j["relayHostAllowed"], true);
    assert_eq!(j["bundle"]["hashShort"], "a1b2 c3d4 e5f6 0718");
    assert_eq!(j["bundle"]["source"], "signedLocal");
    assert_eq!(j["relayStats"]["framesSent"], 0);
    assert_eq!(j["relayStats"]["lastError"], serde_json::Value::Null);
    let text = j.to_string().to_ascii_lowercase();
    assert!(!text.contains("mactoken") && !text.contains("mac_token"));
}

#[test]
fn the_fingerprint_is_the_first_eight_bytes_of_the_key_hash() {
    use intely_remote::util::{b64u, sha256_hex};
    let raw = [7u8; 32];
    let fp = intely_remote::api::fingerprint(&b64u(&raw));
    assert_eq!(fp.replace(' ', ""), sha256_hex(&raw)[..16]);
    assert_eq!(fp.split(' ').count(), 4);
    assert_eq!(intely_remote::api::fingerprint("not a key"), "");
}
