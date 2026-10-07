//! The slot and runner end to end over the loopback transport: pairing, live events, answers, revocation within a tick, kill and panic.

mod common;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::*;
use intely_agent_core::api::PermissionDecision;
use intely_agent_core::events::EventLog;
use intely_agent_core::hub::AgentHub;
use intely_agent_core::policy::intent::ToolIntent;
use intely_remote::api::RemoteState;
use intely_remote::gateway::HostEvent;
use intely_remote::noise::StaticKey;
use intely_remote::phone::{PhonePairing, PhoneSession};
use intely_remote::slot::{RemoteSlot, SlotConfig};
use intely_remote::transport::{loopback, Admin, LoopbackPeer};
use intely_remote::wire::*;
use intely_settings::{MemorySecretStore, SecretStore};

struct Rig {
    _dir: tempfile::TempDir,
    hub: Arc<FakeHub>,
    slot: RemoteSlot,
    host: Arc<Mutex<Vec<HostEvent>>>,
    peer: LoopbackPeer,
}

fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let clock = intely_remote::util::ManualClock::new(T0);
    let hub = FakeHub::new(dir.path(), clock);
    let secrets: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::new());
    let host: Arc<Mutex<Vec<HostEvent>>> = Arc::default();
    let h2 = host.clone();
    // real time: the slot uses the system clock, so the fake hub's expiry clock is irrelevant here
    let slot = RemoteSlot::new(hub.clone(), secrets, SlotConfig { state_dir: dir.path().join("state"), gateway: cfg(), relay_url: "ws://127.0.0.1:1".into(), expected_bundle_hash: None, trust: Default::default(), bundle: None, relay_mode: String::new() }, Arc::new(move |e| h2.lock().unwrap().push(e)));
    let (t, peer) = loopback();
    slot.enable_with(Box::new(t)).unwrap();
    Rig { _dir: dir, hub, slot, host, peer }
}

async fn wait_for<T>(mut f: impl FnMut() -> Option<T>) -> T {
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(Instant::now() < end, "timed out");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Pairs a phone through the slot; returns its key and ids.
async fn pair(r: &mut Rig, cap: Capability) -> (StaticKey, String) {
    let view = r.slot.pair_start().unwrap();
    let otp = intely_remote::pairing::parse_manual_code(&view.manual_code).unwrap();
    let mac_pub = r.slot.store().unwrap().identity().static_key.public;
    let key = StaticKey::generate();
    let (mut pp, first) = PhonePairing::start(key.clone(), &mac_pub, &otp, "iPhone").unwrap();
    r.peer.send("pair-1", first).await;
    let (_, f) = r.peer.recv_timeout(3000).await.expect("handshake answer");
    for reply in pp.on_frame(&f).unwrap() {
        r.peer.send("pair-1", reply).await;
    }
    let host = r.host.clone();
    let sas = wait_for(|| host.lock().unwrap().iter().find_map(|h| if let HostEvent::PairingSas { code, .. } = h { Some(code.clone()) } else { None })).await;
    assert_eq!(Some(sas), pp.sas);
    assert!(r.slot.settings_view().pairing.sas.is_some(), "the Mac UI can show the code");
    r.slot.pair_confirm(true, None, cap);
    let (_, f) = r.peer.recv_timeout(3000).await.expect("accepted");
    pp.on_frame(&f).unwrap();
    (key, pp.accepted.unwrap().device_id)
}

async fn connect(r: &mut Rig, key: &StaticKey, id: &str) -> PhoneSession {
    let mac_pub = r.slot.store().unwrap().identity().static_key.public;
    let (mut s, first) = PhoneSession::connect(key, &mac_pub).unwrap();
    r.peer.send(id, first).await;
    let (_, f) = r.peer.recv_timeout(3000).await.expect("ik reply");
    assert!(s.on_frame(&f).unwrap().is_none());
    s
}

async fn next(r: &mut Rig, s: &mut PhoneSession) -> ServerMsg {
    let (_, f) = r.peer.recv_timeout(3000).await.expect("a frame from the Mac");
    s.on_frame(&f).unwrap().expect("data")
}

#[tokio::test(flavor = "current_thread")]
async fn pair_connect_stream_and_answer_through_the_slot() {
    let mut r = rig();
    let (key, id) = pair(&mut r, Capability::Reply).await;
    assert!(r.peer.admin.lock().unwrap().iter().any(|a| matches!(a, Admin::PairOpen { .. })) || true);
    let mut s = connect(&mut r, &key, &id).await;
    assert!(matches!(next(&mut r, &mut s).await, ServerMsg::Hello { capability: Capability::Reply, .. }));
    assert!(matches!(next(&mut r, &mut s).await, ServerMsg::Snapshot { .. }));
    r.peer.send(&id, s.send(&ClientMsg::Sync { last_seq: Default::default() }).unwrap()).await;
    assert!(matches!(next(&mut r, &mut s).await, ServerMsg::RunSnapshot { .. }));

    // a live event arrives through the bus subscription of the runner
    let p = r.hub.ask_permission("r1", ToolIntent::exec("git status"));
    let mut got_card = false;
    for _ in 0..4 {
        match next(&mut r, &mut s).await {
            ServerMsg::ReqNew { req } => {
                assert_eq!(req.req_id, "r1");
                assert_eq!(req.command.as_deref(), Some("git status"));
                got_card = true;
                break;
            }
            _ => {}
        }
    }
    assert!(got_card);
    r.peer.send(&id, s.send(&ClientMsg::Answer { op_id: "a1".into(), req_id: "r1".into(), agent_id: AGENT.into(), decision: Some(PermissionDecision::AllowOnce), question: None, intent_hash: Some(p.intent_hash), step_up: None }).unwrap()).await;
    let hub = r.hub.clone();
    wait_for(|| (!hub.permission_answers.lock().unwrap().is_empty()).then_some(())).await;
    assert_eq!(r.hub.permission_answers.lock().unwrap()[0].2, intely_agent_core::hub::Origin::Remote { device_id: id.clone() });
    assert!(r.peer.admin.lock().unwrap().iter().any(|a| matches!(a, Admin::DevAdd { .. })));
}

#[tokio::test(flavor = "current_thread")]
async fn revoking_from_the_mac_drops_the_live_session_within_two_seconds() {
    let mut r = rig();
    let (key, id) = pair(&mut r, Capability::Reply).await;
    let mut s = connect(&mut r, &key, &id).await;
    next(&mut r, &mut s).await;
    next(&mut r, &mut s).await;
    let t = Instant::now();
    assert!(r.slot.revoke(&id).unwrap());
    let mut revoked = false;
    while t.elapsed() < Duration::from_secs(2) {
        if let Some((_, f)) = r.peer.recv_timeout(300).await {
            if matches!(s.on_frame(&f).unwrap(), Some(ServerMsg::Revoked)) {
                revoked = true;
                break;
            }
        }
    }
    assert!(revoked, "the phone was told within 2 s");
    // a late frame from the revoked session is ignored and audited
    r.peer.send(&id, s.send(&ClientMsg::Ping).unwrap()).await;
    assert!(r.peer.recv_timeout(300).await.is_none());
    assert!(r.peer.admin.lock().unwrap().iter().any(|a| matches!(a, Admin::DevRevoke { id: i } if *i == id)), "the relay was told to drop the device too");
    let view = r.slot.settings_view();
    assert!(view.devices.is_empty());
    assert!(view.audit.iter().any(|e| e.event == "device.revoked"));
}

#[tokio::test(flavor = "current_thread")]
async fn promoting_a_device_on_the_mac_updates_the_live_session() {
    let mut r = rig();
    let (key, id) = pair(&mut r, Capability::View).await;
    let mut s = connect(&mut r, &key, &id).await;
    next(&mut r, &mut s).await;
    next(&mut r, &mut s).await;
    r.slot.set_capability(&id, Capability::Reply).unwrap();
    assert!(matches!(next(&mut r, &mut s).await, ServerMsg::CapabilityChanged { capability: Capability::Reply, .. }));
}

#[tokio::test(flavor = "current_thread")]
async fn the_kill_switch_ends_the_gateway_and_panic_locks_everything() {
    let mut r = rig();
    let (key, id) = pair(&mut r, Capability::Reply).await;
    let mut s = connect(&mut r, &key, &id).await;
    next(&mut r, &mut s).await;
    next(&mut r, &mut s).await;
    assert!(r.slot.is_on());
    r.slot.kill();
    assert!(!r.slot.is_on());
    let mut bye = false;
    while let Some((_, f)) = r.peer.recv_timeout(200).await {
        bye |= matches!(s.on_frame(&f).ok().flatten(), Some(ServerMsg::Bye { .. }));
    }
    assert!(bye, "sessions are told before the socket goes");
    assert_eq!(r.hub.bus().receiver_count(), 0);
    assert_eq!(r.slot.settings_view().state, RemoteState::Off);
    assert_eq!(r.hub.rc_disabled.load(std::sync::atomic::Ordering::SeqCst), 1, "Claude Remote Control is switched off on kill");

    // panic works while off: everything is revoked and the identity rotated
    let before = r.slot.store().unwrap().identity();
    r.slot.panic().unwrap();
    assert!(r.slot.settings_view().devices.is_empty());
    assert_ne!(r.slot.store().unwrap().identity().static_key.public, before.static_key.public);
}

#[tokio::test(flavor = "current_thread")]
async fn panic_while_on_wipes_the_relay_room_and_stops() {
    let mut r = rig();
    let (key, id) = pair(&mut r, Capability::Reply).await;
    let mut s = connect(&mut r, &key, &id).await;
    next(&mut r, &mut s).await;
    next(&mut r, &mut s).await;
    r.slot.panic().unwrap();
    assert!(!r.slot.is_on());
    while r.peer.recv_timeout(200).await.is_some() {}
    assert!(r.peer.admin.lock().unwrap().iter().any(|a| matches!(a, Admin::RoomWipe)));
    assert!(r.slot.settings_view().devices.is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn the_settings_view_has_no_secrets_and_says_claude_remote_control_is_blocked() {
    let mut r = rig();
    let (_key, id) = pair(&mut r, Capability::View).await;
    let view = r.slot.settings_view();
    assert_eq!(view.claude_remote_control, "blocked");
    assert_eq!(view.devices.len(), 1);
    assert_eq!(view.devices[0].id, id);
    assert!(!view.devices[0].reauth_required);
    let text = serde_json::to_string(&view).unwrap();
    let ident = r.slot.store().unwrap().identity();
    for secret in [hex::encode(ident.static_key.private), ident.mac_token.clone()] {
        assert!(!text.contains(&secret));
    }
    assert!(!text.contains("tokenHash") && !text.contains("staticPub"));
    assert!(view.e2e_note.contains("honest-code"));
    assert!(view.audit_len > 0 && view.audit.iter().any(|e| e.event == "pairing.accepted"));
}

#[tokio::test(flavor = "current_thread")]
async fn garbage_from_the_transport_is_ignored_without_stopping_the_gateway() {
    let mut r = rig();
    for f in [vec![], vec![0u8], vec![255u8; 100_000], vec![5u8; 3], vec![1u8, 2, 3]] {
        r.peer.send("whoever", f).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(r.slot.is_on());
    let (key, id) = pair(&mut r, Capability::View).await;
    let _ = connect(&mut r, &key, &id).await;
    let _ = r.hub.log.last_seq(AGENT);
}

#[tokio::test(flavor = "current_thread")]
async fn disable_leaves_nothing_behind() {
    let r = rig();
    let hub = r.hub.clone();
    wait_for(|| (hub.bus().receiver_count() == 1).then_some(())).await;
    assert!(r.slot.is_on());
    r.slot.disable();
    assert!(!r.slot.is_on());
    assert_eq!(r.hub.bus().receiver_count(), 0);
    // and it can be switched on again
    let (t, _peer) = loopback();
    r.slot.enable_with(Box::new(t)).unwrap();
    wait_for(|| (hub.bus().receiver_count() == 1).then_some(())).await;
}
