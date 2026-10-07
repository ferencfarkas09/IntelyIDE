//! The member pre-flight of a jailed session (E2E / read-only jail): topology discovery follows the members a seed
//! announces, so a loopback seed that names a remote member could make the driver dial it before any check saw it. The
//! pre-flight asks every seed alone (`directConnection=true`, `hello`) and refuses the connection before the real client
//! exists. Fakes only (no `mongod`, no Docker); the real three-member set is in `matrix.rs`.
#![cfg(feature = "mongo")]

mod fakes;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use intely_mongo::api::{Environment, ProfileInput};
use intely_mongo::connspec::{ConnSpec, ExtraOption, HostPort};
use intely_mongo::diagnose::classify_text;
use intely_mongo::driver::{hello_members, Error, Session, SessionOpts, SpecConnect};
use intely_mongo::error::code;
use intely_mongo::jail::NetworkPolicy;
use intely_mongo::profile::ProfileStore;
use intely_mongo::studio::Studio;
use intely_settings::{MemorySecretStore, SettingsStore};

use fakes::servers::{self, Fake};

const REMOTE: &str = "10.255.255.254:27017";

fn spec(ports: &[u16]) -> ConnSpec {
    let mut s = ConnSpec::default();
    s.hosts = ports.iter().map(|p| HostPort { host: "127.0.0.1".into(), port: Some(*p) }).collect();
    s.timeouts.connect_ms = Some(1_500);
    s.timeouts.server_selection_ms = Some(1_500);
    s
}

fn jailed() -> SessionOpts {
    SessionOpts { allow_remote: true, preflight_members: true, ..SessionOpts::default() }
}

fn unjailed() -> SessionOpts {
    SessionOpts { allow_remote: true, ..SessionOpts::default() }
}

/// Two members of `rs0` on loopback ports; each announces both of them and, when `extra` is given, one more host.
async fn pair(extra: Option<&'static str>) -> (Fake, Fake) {
    let (pa, pb) = (servers::closed_port().await, servers::closed_port().await);
    let list = || -> Vec<String> {
        let mut v = vec![format!("127.0.0.1:{pa}"), format!("127.0.0.1:{pb}")];
        v.extend(extra.map(str::to_string));
        v
    };
    (servers::spawn_member_on(pa, "rs0", list()).await, servers::spawn_member_on(pb, "rs0", list()).await)
}

#[test]
fn hello_members_reads_hosts_passives_and_arbiters_in_order() {
    let d = bson::doc! { "hosts": ["a:1", "b:2"], "passives": ["c:3"], "arbiters": ["[::1]:4"], "setName": "rs0" };
    assert_eq!(hello_members(&d), vec!["a:1", "b:2", "c:3", "[::1]:4"]);
    assert!(hello_members(&bson::doc! { "ismaster": true }).is_empty());
}

#[tokio::test]
async fn a_member_outside_the_seeds_is_refused_before_the_real_client_exists() {
    let (a, b) = pair(Some(REMOTE)).await;
    let s = spec(&[a.port, b.port]);
    let err = match Session::connect_spec(SpecConnect::new(&s), jailed()).await {
        Ok(_) => panic!("the pre-flight must refuse a set that announces a remote member"),
        Err(e) => e,
    };
    match &err {
        Error::Members(m) => assert_eq!(m, &vec![REMOTE.to_string()], "only the outsider is named"),
        other => panic!("wrong error: {other}"),
    }
    assert!(err.to_string().contains(REMOTE));
    // each seed was asked, and only by a short-lived pre-flight client
    assert!(a.accepted.load(std::sync::atomic::Ordering::SeqCst) >= 1 && b.accepted.load(std::sync::atomic::Ordering::SeqCst) >= 1);
    // without the pre-flight the session is built (lazily) and would run discovery: that is the hole this closes
    let lazy = Session::connect_spec(SpecConnect::new(&s), unjailed()).await.expect("no pre-flight, no check");
    lazy.close();
}

#[tokio::test]
async fn one_seed_that_names_a_remote_member_is_enough_even_when_the_other_does_not() {
    let (pa, pb) = (servers::closed_port().await, servers::closed_port().await);
    let clean = servers::spawn_member_on(pa, "rs0", vec![format!("127.0.0.1:{pa}"), format!("127.0.0.1:{pb}")]).await;
    let dirty = servers::spawn_member_on(pb, "rs0", vec![format!("127.0.0.1:{pa}"), format!("127.0.0.1:{pb}"), "db3.corp.example:27017".into()]).await;
    let s = spec(&[clean.port, dirty.port]);
    let err = Session::connect_spec(SpecConnect::new(&s), jailed()).await.map(|_| ()).expect_err("the dirty seed is asked too");
    assert!(matches!(&err, Error::Members(m) if m == &vec!["db3.corp.example:27017".to_string()]), "{err}");
}

#[tokio::test]
async fn loopback_members_pass_and_the_probe_lists_them() {
    let (a, b) = pair(None).await;
    let s = spec(&[a.port, b.port]);
    let sess = Session::connect_spec(SpecConnect::new(&s), jailed()).await.expect("all members are loopback");
    let probe = sess.probe().await.expect("probe");
    assert_eq!(probe.members, vec![format!("127.0.0.1:{}", a.port), format!("127.0.0.1:{}", b.port)]);
    assert!(!probe.remote_members);
    sess.close();
}

#[tokio::test]
async fn a_single_seed_is_pinned_so_there_is_no_discovery_and_nothing_to_pre_flight() {
    let (a, _b) = pair(Some(REMOTE)).await;
    // one loopback seed: the driver is set to directConnection by `connect_spec`, it never follows the announced member
    let s = spec(&[a.port]);
    let sess = Session::connect_spec(SpecConnect::new(&s), jailed()).await.expect("pinned seed");
    // the probe still sees the announcement: the connection is judged Production-level
    let probe = sess.probe().await.expect("probe");
    assert!(probe.remote_members, "the member rule raises the level");
    assert!(probe.members.iter().any(|m| m == REMOTE));
    sess.close();
    // the same seed with discovery switched on by hand IS pre-flighted
    let mut open = spec(&[a.port]);
    open.topology.direct_connection = Some(false);
    let err = Session::connect_spec(SpecConnect::new(&open), jailed()).await.map(|_| ()).expect_err("directConnection=false runs discovery");
    assert!(matches!(err, Error::Members(_)), "{err}");
}

#[tokio::test]
async fn a_seed_that_does_not_answer_is_left_to_the_real_connection_and_its_usual_diagnosis() {
    let closed = servers::closed_port().await;
    let (a, b) = pair(None).await;
    let s = spec(&[closed, a.port, b.port]);
    // the dead seed advertises nothing; the others are clean: the session is built and the pre-flight said nothing
    let sess = Session::connect_spec(SpecConnect::new(&s), jailed()).await.expect("a down seed is not a pre-flight failure");
    sess.close();
    // when nobody answers, the error comes from the real client with the diagnosis a user already knows
    let nobody = spec(&[closed, servers::closed_port().await]);
    let sess = Session::connect_spec(SpecConnect::new(&nobody), jailed()).await.expect("lazy");
    let e = sess.probe().await.expect_err("nothing listens");
    let code = classify_text(&e.to_string(), &Default::default()).code;
    assert!(code == "net.refused" || code == "select.noServer" || code == "select.memberUnreachable", "{code}: {e}");
    sess.close();
}

// ---- the pre-flight is a point in time: the dial gate covers the rest ------------------------------------------------------

/// Two members whose announcements the test changes while the session is alive. `None` is a member that stays silent.
async fn dynamic_pair() -> (Fake, Fake, Arc<Mutex<Option<Vec<String>>>>, Arc<Mutex<Option<Vec<String>>>>, [u16; 2]) {
    let ports = [servers::closed_port().await, servers::closed_port().await];
    let (ha, hb) = (Arc::new(Mutex::new(None)), Arc::new(Mutex::new(None)));
    let a = servers::spawn_member_dynamic(ports[0], "rs0", ha.clone()).await;
    let b = servers::spawn_member_dynamic(ports[1], "rs0", hb.clone()).await;
    (a, b, ha, hb, ports)
}

fn fast_heartbeat(s: &mut ConnSpec) {
    s.extra.push(ExtraOption { key: "heartbeatFrequencyMS".into(), value: "500".into() });
}

#[tokio::test]
async fn a_set_that_starts_announcing_a_lan_member_after_the_connect_is_never_dialled() {
    let Some(trap) = servers::spawn_lan_trap().await else {
        eprintln!("skipped: this computer has no LAN address to listen on");
        return;
    };
    let (_a, _b, ha, hb, ports) = dynamic_pair().await;
    let clean = vec![format!("127.0.0.1:{}", ports[0]), format!("127.0.0.1:{}", ports[1])];
    *ha.lock().unwrap() = Some(clean.clone());
    *hb.lock().unwrap() = Some(clean.clone());
    let mut s = spec(&ports);
    fast_heartbeat(&mut s);
    // the answer is clean at connect time, so the pre-flight passes
    let sess = Session::connect_spec(SpecConnect::new(&s), jailed()).await.expect("clean at connect time");
    sess.probe().await.expect("probe");
    // now the set names a LAN member; the driver's monitors learn it on their next heartbeats
    let mut dirty = clean;
    dirty.push(trap.addr.clone());
    *ha.lock().unwrap() = Some(dirty.clone());
    *hb.lock().unwrap() = Some(dirty);
    tokio::time::sleep(Duration::from_millis(3_500)).await;
    assert_eq!(trap.hits.load(Ordering::SeqCst), 0, "the driver dialled {} although it is outside the connection", trap.addr);
    // the refusal is visible: the connection check names the member instead of quietly ignoring it
    let e = sess.probe().await.expect_err("an announced outsider fails the connection check");
    assert!(matches!(&e, Error::Members(m) if m.iter().any(|x| x == &trap.addr)), "{e}");
    sess.close();
}

#[tokio::test]
async fn a_seed_that_was_silent_during_the_pre_flight_is_not_trusted_when_it_starts_to_answer() {
    let Some(trap) = servers::spawn_lan_trap().await else {
        eprintln!("skipped: this computer has no LAN address to listen on");
        return;
    };
    let (_a, _b, ha, hb, ports) = dynamic_pair().await;
    let clean = vec![format!("127.0.0.1:{}", ports[0]), format!("127.0.0.1:{}", ports[1])];
    *ha.lock().unwrap() = Some(clean.clone()); // answers, clean
    // seed B says nothing while the pre-flight runs
    let mut s = spec(&ports);
    fast_heartbeat(&mut s);
    let sess = Session::connect_spec(SpecConnect::new(&s), jailed()).await.expect("the pre-flight skips a silent seed");
    let mut dirty = clean;
    dirty.push(trap.addr.clone());
    *hb.lock().unwrap() = Some(dirty);
    sess.probe().await.ok();
    tokio::time::sleep(Duration::from_millis(5_000)).await;
    assert_eq!(trap.hits.load(Ordering::SeqCst), 0, "the driver dialled {} although it is outside the connection", trap.addr);
    sess.close();
}

#[tokio::test]
async fn the_gate_does_not_change_what_a_loopback_set_can_do() {
    // several loopback seeds, discovery on, the gate in between: reads, the member list and a clean shutdown work as before
    let (a, b) = pair(None).await;
    let mut s = spec(&[a.port, b.port]);
    fast_heartbeat(&mut s);
    let sess = Session::connect_spec(SpecConnect::new(&s), jailed()).await.expect("all members are loopback");
    let probe = sess.probe().await.expect("probe through the gate");
    assert_eq!(probe.members.len(), 2);
    assert!(!probe.remote_members);
    tokio::time::sleep(Duration::from_millis(1_200)).await;
    sess.probe().await.expect("still fine after several heartbeats");
    sess.close();
}

// ---- through the Studio: the jail decides what the refusal looks like --------------------------------------------------

fn studio(network: NetworkPolicy) -> (tempfile::TempDir, Studio) {
    let dir = tempfile::tempdir().unwrap();
    let settings = Arc::new(SettingsStore::open(dir.path().join("settings.json")).unwrap());
    let studio = Studio::new(Arc::new(ProfileStore::new(settings, Arc::new(MemorySecretStore::new()))), network).with_test_gap(Duration::ZERO);
    studio.set_enabled(true).unwrap();
    (dir, studio)
}

fn input(name: &str, spec: ConnSpec) -> ProfileInput {
    ProfileInput { name: name.into(), environment: Environment::Local, spec: Some(spec), ..Default::default() }
}

#[tokio::test]
async fn the_test_pipeline_reports_a_refused_member_as_a_jail_diagnosis_and_a_passed_test_lists_the_members() {
    let (a, b) = pair(Some(REMOTE)).await;
    let (_dir, e2e) = studio(NetworkPolicy::LoopbackOnly);
    let r = e2e.test_with(input("RemoteMember", spec(&[a.port, b.port])), "t-pf1").await.expect("a report, not an error");
    assert!(!r.ok, "{r:?}");
    let d = r.diagnosis.as_ref().expect("diagnosis");
    assert_eq!(d.code, "config.invalid");
    assert!(d.params.iter().any(|(k, v)| k == "reason" && v == code::TEST_JAIL), "{d:?}");
    assert!(d.detail.contains(REMOTE), "the refused member is in the detail: {}", d.detail);
    // a clean set under the same jail passes, and the report carries hello.hosts
    let (c, d2) = pair(None).await;
    let r = e2e.test_with(input("Clean", spec(&[c.port, d2.port])), "t-pf2").await.expect("report");
    assert!(r.ok, "{r:?}");
    assert_eq!(r.members, vec![format!("127.0.0.1:{}", c.port), format!("127.0.0.1:{}", d2.port)]);
}

#[tokio::test]
async fn a_saved_connection_hits_the_same_refusal_with_the_jail_code() {
    let (a, b) = pair(Some(REMOTE)).await;
    let (_dir, e2e) = studio(NetworkPolicy::LoopbackOnly);
    let saved = e2e.profile_save(input("Saved", spec(&[a.port, b.port]))).expect("save");
    let err = e2e.connect(&saved.id).await.expect_err("refused");
    assert_eq!(err.code, code::TEST_JAIL, "{err}");
    assert!(err.message.contains(REMOTE), "{}", err.message);
    assert!(e2e.status().connections.is_empty(), "nothing stays open");
}
