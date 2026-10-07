//! T6c: tunnel ownership inside the gateway and the lifecycle audit lines. No real sshd and no network beyond loopback:
//! `scripts/mongo-fixture/fake-ssh` (selected through `INTELY_SSH_BINARY`, honoured only under the E2E jail) stands in
//! for ssh. Everything happens below a `tempfile` root that is also the jail's fixture root.
#![cfg(all(feature = "mongo", unix))]

use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use intely_mongo::api::TunnelState;
use intely_mongo::audit::{event, AuditEvent, AuditLog, AuditRecord, MAX_LOG_BYTES};
use intely_mongo::connspec::{AllowedHost, HostPort, SshSpec};
use intely_mongo::error::code;
use intely_mongo::jail::{Jail, NetworkPolicy};
use intely_mongo::profile::ProfileStore;
use intely_mongo::studio::tunnels::{Owner, Who};
use intely_mongo::studio::Studio;
use intely_mongo::tunnel::dir;
use intely_mongo::tunnel::ssh::{CommandRunner, RunOutput, RunRequest, SystemRunner};
use intely_mongo::tunnel::sweep;
use intely_mongo::tunnel::{AllowList, MasterLauncher, Socks5Endpoint, SystemLauncher, TunnelEnv, TunnelSecrets};
use intely_settings::{MemorySecretStore, SettingsStore};

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------------

/// Appears in no audit line: the ssh user, the profile name, the key path and the URI password are all canaries.
const SSH_USER: &str = "canary-sshuser";
const NAME: &str = "Canary Bastion DB";
const KEY_FILE: &str = "/canary/keys/id_canary";
const URI_PW: &str = "uri-PW-CANARY-31337";

struct Fx {
    root: tempfile::TempDir,
    fake: PathBuf,
    state: PathBuf,
}

fn fx() -> Fx {
    let root = tempfile::tempdir().unwrap();
    let fake = root.path().join("fake");
    let state = root.path().join("state");
    std::fs::create_dir_all(&fake).unwrap();
    std::fs::create_dir_all(&state).unwrap();
    std::fs::create_dir_all(root.path().join("home")).unwrap();
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/mongo-fixture/fake-ssh");
    for (name, exec) in [("ssh", true), ("ssh-keyscan", true), ("bridge.mjs", false)] {
        std::fs::copy(src.join(name), fake.join(name)).unwrap();
        std::fs::set_permissions(fake.join(name), std::fs::Permissions::from_mode(if exec { 0o755 } else { 0o644 })).unwrap();
    }
    Fx { root, fake, state }
}

impl Fx {
    fn mode(&self, m: &str) {
        std::fs::write(self.fake.join("mode"), m).unwrap();
    }
    fn jail(&self, policy: NetworkPolicy) -> Jail {
        Jail::new(policy, &std::env::temp_dir(), Some(self.root.path()))
    }
    /// Names below the root that belong to a tunnel.
    fn leftovers(&self) -> Vec<String> {
        std::fs::read_dir(self.root.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with(dir::PREFIX)).collect()
    }
    fn audit_path(&self) -> PathBuf {
        self.state.join("mongo-audit.jsonl")
    }
    /// The parsed audit lines of the live file.
    fn audit(&self) -> Vec<Value> {
        std::fs::read_to_string(self.audit_path()).unwrap_or_default().lines().map(|l| serde_json::from_str(l).expect("an audit line is JSON")).collect()
    }
    fn audit_of(&self, op: &str) -> Vec<Value> {
        self.audit().into_iter().filter(|v| v["op"] == op).collect()
    }
}

#[derive(Default)]
struct CountingLauncher(AtomicUsize);

impl MasterLauncher for CountingLauncher {
    fn launch(&self, program: &Path, args: &[String], env: &[(String, String)]) -> io::Result<std::process::Child> {
        self.0.fetch_add(1, Ordering::SeqCst);
        SystemLauncher.launch(program, args, env)
    }
}

/// Every process a tunnel starts is a real child of this test; the table only has to say "alive".
struct AlwaysAlive;

impl sweep::ProcessTable for AlwaysAlive {
    fn start_time(&self, pid: u32) -> Option<String> {
        Some(format!("t{pid}"))
    }
    fn command(&self, _pid: u32) -> Option<String> {
        None
    }
    fn terminate(&self, _pid: u32) {}
}

#[derive(Default)]
struct PlainRunner;

impl CommandRunner for PlainRunner {
    fn run(&self, req: &RunRequest<'_>) -> io::Result<RunOutput> {
        SystemRunner.run(req)
    }
}

fn env_for(fx: &Fx) -> TunnelEnv {
    let mut e = TunnelEnv::new(fx.jail(NetworkPolicy::LoopbackOnly), fx.state.clone());
    e.temp_dir = fx.root.path().to_path_buf();
    e.home = fx.root.path().join("home");
    e.local_user = "tester".into();
    e.auth_sock = None;
    e.ssh_override = Some(fx.fake.join("ssh").to_string_lossy().into_owned());
    e.procs = Arc::new(AlwaysAlive);
    e.runner = Arc::new(PlainRunner);
    e.connect_timeout_s = 10;
    e.poll = Duration::from_millis(30);
    e
}

fn spec() -> SshSpec {
    SshSpec { host: "127.0.0.1".into(), port: Some(2222), user: SSH_USER.into(), ..Default::default() }
}

fn allow() -> AllowList {
    AllowList { entries: vec![HostPort { host: "127.0.0.1".into(), port: Some(27017) }] }
}

fn who() -> Who {
    Who { name: NAME.into(), environment: "production".into(), level: "ProductionLevel".into(), label: "db.prod.example.com".into() }
}

fn flag() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

fn studio(fx: &Fx) -> Arc<Studio> {
    let settings = Arc::new(SettingsStore::open(fx.state.join("settings.json")).unwrap());
    let profiles = Arc::new(ProfileStore::new(settings, Arc::new(MemorySecretStore::new())));
    let s = Arc::new(Studio::new(profiles, NetworkPolicy::LoopbackOnly));
    assert_eq!(s.audit_path(), fx.audit_path(), "the gateway and the tunnel registry write the same file");
    s
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

fn wait_until(limit: Duration, mut f: impl FnMut() -> bool) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < limit {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    f()
}

fn master_pids(fx: &Fx) -> Vec<i32> {
    sweep::read_entries(&fx.state).iter().map(|e| e.pid as i32).collect()
}

async fn open_owner(s: &Studio, e: &TunnelEnv, owner: Owner, cancel: Arc<AtomicBool>) -> intely_mongo::error::Result<intely_mongo::studio::tunnels::Lease> {
    s.tunnels().open(e, owner, who(), &spec(), &TunnelSecrets::default(), allow(), cancel).await
}

async fn open_conn(s: &Studio, e: &TunnelEnv, id: &str) -> intely_mongo::error::Result<intely_mongo::studio::tunnels::Lease> {
    open_owner(s, e, Owner::Connection(id.into()), flag()).await
}

async fn open_test(s: &Studio, e: &TunnelEnv, id: &str) -> intely_mongo::error::Result<intely_mongo::studio::tunnels::Lease> {
    open_owner(s, e, Owner::Test(id.into()), flag()).await
}

async fn socks_connect(ep: &Socks5Endpoint, host: &str, port: u16) -> io::Result<u8> {
    let mut s = TcpStream::connect(("127.0.0.1", ep.port)).await?;
    s.write_all(&[5, 1, 2]).await?;
    let mut m = [0u8; 2];
    s.read_exact(&mut m).await?;
    let mut auth = vec![1, ep.user.len() as u8];
    auth.extend(ep.user.as_bytes());
    auth.push(ep.pass.len() as u8);
    auth.extend(ep.pass.as_bytes());
    s.write_all(&auth).await?;
    let mut a = [0u8; 2];
    s.read_exact(&mut a).await?;
    let mut req = vec![5, 1, 0, 3, host.len() as u8];
    req.extend(host.as_bytes());
    req.extend(port.to_be_bytes());
    s.write_all(&req).await?;
    let mut r = [0u8; 10];
    s.read_exact(&mut r).await?;
    Ok(r[1])
}

/// None of the canaries may be in the audit file or its rolled siblings.
fn assert_audit_clean(fx: &Fx) {
    for suffix in ["", ".1", ".2"] {
        let p = format!("{}{suffix}", fx.audit_path().display());
        let text = std::fs::read_to_string(&p).unwrap_or_default();
        for bad in [SSH_USER, NAME, KEY_FILE, URI_PW, "canary", "mongodb://", "mongodb+srv://"] {
            assert!(!text.to_lowercase().contains(&bad.to_lowercase()), "{bad} leaked into {p}: {text}");
        }
        let root = fx.root.path().to_string_lossy().into_owned();
        assert!(!text.contains(&root), "a path leaked into {p}");
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_test_and_a_connection_never_share_a_tunnel() {
    let fx = fx();
    let launcher = Arc::new(CountingLauncher::default());
    let mut e = env_for(&fx);
    e.launcher = launcher.clone();
    let s = studio(&fx);

    let conn = open_conn(&s, &e, "p1").await.unwrap();
    let test = open_test(&s, &e, "t-1").await.unwrap();
    assert_eq!(launcher.0.load(Ordering::SeqCst), 2, "two owners, two ssh masters");
    assert_eq!(fx.leftovers().len(), 2, "two private directories");
    assert_eq!(master_pids(&fx).len(), 2);
    assert_ne!(conn.proxy().port, test.proxy().port);
    assert_ne!(conn.proxy().pass, test.proxy().pass, "separate SOCKS credentials too");
    assert_eq!(s.tunnels().count(), 2);

    // a test id that is in use cannot be opened a second time, and the first one is untouched
    let again = open_test(&s, &e, "t-1").await.unwrap_err();
    assert_eq!(again.code, code::BUSY);
    assert_eq!(launcher.0.load(Ordering::SeqCst), 2);
    assert!(s.tunnels().info(&Owner::Test("t-1".into())).is_some());

    // the test ends: the connection's tunnel is still up and is the same one
    let conn_port = conn.proxy().port;
    test.close().await;
    assert_eq!(s.tunnels().connection_state("p1"), Some(TunnelState::Up));
    assert_eq!(fx.leftovers().len(), 1);
    assert_eq!(conn.proxy().port, conn_port);
    assert!(s.tunnels().info(&Owner::Test("t-1".into())).is_none());

    conn.close().await;
    assert!(fx.leftovers().is_empty());
    assert_eq!(s.tunnels().count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_relay_refusals_and_allow_more_are_reachable_per_owner() {
    let fx = fx();
    let e = env_for(&fx);
    let s = studio(&fx);
    let l1 = open_conn(&s, &e, "p1").await.unwrap();
    let l2 = open_conn(&s, &e, "p2").await.unwrap();
    let ep = l2.proxy();
    l1.keep();
    l2.keep();
    // a destination that is not on the list is refused and recorded (the diagnosis turns it into `tunnel.notAllowed`)
    let rep = socks_connect(&ep, "10.9.9.9", 27017).await.unwrap();
    assert_ne!(rep, 0);
    assert!(wait_until(Duration::from_secs(3), || !s.tunnels().info(&Owner::Connection("p2".into())).unwrap().refused.is_empty()));
    let info = s.tunnels().info(&Owner::Connection("p2".into())).unwrap();
    assert_eq!(info.state, TunnelState::Up);
    assert_eq!(info.refused, vec![HostPort { host: "10.9.9.9".into(), port: Some(27017) }]);
    assert!(s.tunnels().info(&Owner::Connection("p1".into())).unwrap().refused.is_empty(), "p1 saw nothing");
    // "Allow this host": a metadata address is still refused, a normal one is accepted
    assert!(s.tunnels().allow_more(&Owner::Connection("p2".into()), &[AllowedHost { host: "169.254.169.254".into(), port: 80 }]).is_err());
    s.tunnels().allow_more(&Owner::Connection("p2".into()), &[AllowedHost { host: "db2.internal".into(), port: 27017 }]).unwrap();
    assert!(s.tunnels().allow_more(&Owner::Connection("nobody".into()), &[]).is_err());
    s.tunnels().close_all().await;
    assert!(fx.leftovers().is_empty());
}

// ---------------------------------------------------------------------------------------------------------------------
// Every failure path closes the tunnel
// ---------------------------------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_open_leaves_nothing_and_is_audited_with_its_code() {
    let fx = fx();
    fx.mode("auth-denied");
    let e = env_for(&fx);
    let s = studio(&fx);
    let err = open_conn(&s, &e, "p1").await.unwrap_err();
    assert!(err.message.starts_with("tunnel.auth"), "{err}");
    assert!(fx.leftovers().is_empty());
    assert!(sweep::read_entries(&fx.state).is_empty());
    assert_eq!(s.tunnels().count(), 0);
    let lines = fx.audit_of(event::TUNNEL_OPEN);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["outcome"], "error");
    assert_eq!(lines[0]["errorClass"], "tunnel");
    assert_eq!(lines[0]["errorCode"], "tunnel.auth");
    assert_eq!(lines[0]["label"], "db.prod.example.com");
    assert_eq!(lines[0]["environment"], "production");
    assert_audit_clean(&fx);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lease_dropped_without_keep_closes_the_tunnel() {
    let fx = fx();
    let s = studio(&fx);
    let e = env_for(&fx);

    // the pipeline failed after the tunnel was up: the lease goes out of scope
    let pid = {
        let lease = open_conn(&s, &e, "p1").await.unwrap();
        let _ = lease.proxy();
        let pid = master_pids(&fx)[0];
        assert!(alive(pid));
        pid
    };
    assert!(wait_until(Duration::from_secs(5), || fx.leftovers().is_empty() && !alive(pid)), "the dropped lease closed the tunnel");
    assert!(sweep::read_entries(&fx.state).is_empty());
    assert_eq!(s.tunnels().count(), 0);
    assert!(wait_until(Duration::from_secs(3), || fx.audit_of(event::TUNNEL_CLOSE).len() == 1));

    // an explicit, awaited close is deterministic
    let lease = open_conn(&s, &e, "p1").await.unwrap();
    lease.close().await;
    assert!(fx.leftovers().is_empty());
    assert_eq!(fx.audit_of(event::TUNNEL_CLOSE).len(), 2);

    // a lease that was kept survives its own drop and is closed by the registry
    let lease = open_conn(&s, &e, "p1").await.unwrap();
    lease.keep();
    assert_eq!(s.tunnels().connection_state("p1"), Some(TunnelState::Up));
    s.tunnels().close_connection("p1").await;
    assert!(fx.leftovers().is_empty());
    assert_eq!(s.tunnels().connection_state("p1"), None);
    assert_audit_clean(&fx);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_a_test_stops_an_open_in_progress_and_closes_a_finished_tunnel() {
    let fx = fx();
    let s = studio(&fx);
    let e = env_for(&fx);

    // never-ready: the master starts but never becomes ready, so the open is still polling when the test is cancelled
    fx.mode("never-ready");
    let cancel = flag();
    let (s2, e2, c2) = (s.clone(), e.clone(), cancel.clone());
    let pending = tokio::spawn(async move { open_owner(&s2, &e2, Owner::Test("t-9".into()), c2).await });
    assert!(wait_until(Duration::from_secs(5), || !fx.leftovers().is_empty()), "the open is in progress");
    s.tunnels().cancel_test("t-9").await;
    assert!(cancel.load(Ordering::SeqCst), "the test's cancel flag was set");
    let err = tokio::time::timeout(Duration::from_secs(10), pending).await.expect("the open returned").unwrap().unwrap_err();
    assert_eq!(err.code, code::CANCELLED, "{err}");
    assert!(wait_until(Duration::from_secs(5), || fx.leftovers().is_empty()), "the half-built tunnel was removed");
    assert!(sweep::read_entries(&fx.state).is_empty());
    assert_eq!(s.tunnels().count(), 0);

    // a finished tunnel is closed and awaited
    fx.mode("ok");
    open_test(&s, &e, "t-10").await.unwrap().keep();
    assert_eq!(s.tunnels().count(), 1);
    s.tunnels().cancel_test("t-10").await;
    assert_eq!(s.tunnels().count(), 0);
    assert!(fx.leftovers().is_empty());
}

// ---------------------------------------------------------------------------------------------------------------------
// Disconnect, switch-off, quit
// ---------------------------------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnect_and_the_switch_off_close_the_tunnels() {
    let fx = fx();
    let s = studio(&fx);
    s.set_enabled(true).unwrap();
    let e = env_for(&fx);

    open_conn(&s, &e, "p1").await.unwrap().keep();
    open_conn(&s, &e, "p2").await.unwrap().keep();
    assert_eq!(s.tunnels().count(), 2);
    // disconnect closes that connection's tunnel and only that one
    s.disconnect("p1");
    assert!(wait_until(Duration::from_secs(5), || fx.leftovers().len() == 1), "p1's tunnel closed");
    assert_eq!(s.tunnels().connection_state("p1"), None);
    assert_eq!(s.tunnels().connection_state("p2"), Some(TunnelState::Up));

    // an open test is closed by the switch too
    open_test(&s, &e, "t-1").await.unwrap().keep();
    let pids = master_pids(&fx);
    assert_eq!(pids.len(), 2);

    s.set_enabled(false).unwrap();
    assert!(wait_until(Duration::from_secs(5), || fx.leftovers().is_empty() && pids.iter().all(|p| !alive(*p))), "the switch-off closed every tunnel and master");
    assert_eq!(s.tunnels().count(), 0);
    // the sweep entries are removed by the closing task after the master is gone: wait for them like for everything else
    assert!(wait_until(Duration::from_secs(5), || sweep::read_entries(&fx.state).is_empty()), "the sweep file is emptied");
    assert!(wait_until(Duration::from_secs(3), || fx.audit_of(event::TUNNEL_CLOSE).len() == 3));
    assert_audit_clean(&fx);
}

#[test]
fn quitting_closes_every_tunnel_without_a_runtime() {
    let fx = fx();
    let s = studio(&fx);
    let e = env_for(&fx);
    // the tunnels are opened on a runtime that is still alive but unused when the app quits
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    rt.block_on(async {
        open_conn(&s, &e, "p1").await.unwrap().keep();
        open_conn(&s, &e, "p2").await.unwrap().keep();
        open_conn(&s, &e, "p3").await.unwrap().keep();
    });
    let pids = master_pids(&fx);
    assert_eq!(pids.len(), 3);
    assert!(pids.iter().all(|p| alive(*p)));

    // this thread has no runtime: `RunEvent::Exit`
    assert!(tokio::runtime::Handle::try_current().is_err());
    let t0 = Instant::now();
    s.close_all_blocking(Duration::from_secs(3));
    assert!(t0.elapsed() < Duration::from_secs(8), "three tunnels close in parallel: {:?}", t0.elapsed());
    assert!(fx.leftovers().is_empty(), "{:?}", fx.leftovers());
    assert!(wait_until(Duration::from_secs(3), || pids.iter().all(|p| !alive(*p))), "every master is gone");
    assert!(sweep::read_entries(&fx.state).is_empty());
    assert_eq!(s.tunnels().count(), 0);
    assert_eq!(fx.audit_of(event::TUNNEL_CLOSE).len(), 3);
    drop(rt);
}

// ---------------------------------------------------------------------------------------------------------------------
// The master dies
// ---------------------------------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_master_that_dies_posts_a_notice_is_queued_and_is_never_reopened() {
    let fx = fx();
    fx.mode("die-after-n-seconds 1");
    let launcher = Arc::new(CountingLauncher::default());
    let mut e = env_for(&fx);
    e.launcher = launcher.clone();
    let s = studio(&fx);
    let hits: Arc<Mutex<Vec<String>>> = Arc::default();
    let h = hits.clone();
    s.tunnels().set_ended_hook(move |id| h.lock().unwrap().push(id.to_string()));

    open_conn(&s, &e, "p1").await.unwrap().keep();
    // a test tunnel that dies is not a connection: no notice, no queue entry, but it is cleaned up
    open_test(&s, &e, "t-1").await.unwrap().keep();
    assert_eq!(launcher.0.load(Ordering::SeqCst), 2);

    assert!(wait_until(Duration::from_secs(10), || !s.profiles().notices().is_empty()), "the notice was posted");
    assert!(wait_until(Duration::from_secs(10), || s.tunnels().count() == 0 && fx.leftovers().is_empty()), "both dead tunnels were cleaned up");
    let notices = s.profiles().notices();
    assert_eq!(notices.len(), 1, "one notice, for the connection only: {notices:?}");
    assert_eq!(notices[0].profile_id, "p1");
    assert!(notices[0].message.contains("The SSH tunnel for Canary Bastion DB ended"), "{:?}", notices[0]);
    assert_eq!(*hits.lock().unwrap(), vec!["p1".to_string()], "the hook ran once, for the connection");
    assert_eq!(s.tunnels().take_ended(), vec!["p1".to_string()]);
    assert!(s.tunnels().take_ended().is_empty(), "drained");
    assert_eq!(s.tunnels().connection_state("p1"), None);

    // nothing reconnects by itself
    std::thread::sleep(Duration::from_millis(700));
    assert_eq!(launcher.0.load(Ordering::SeqCst), 2, "no new ssh master was started");
    assert!(sweep::read_entries(&fx.state).is_empty());

    let dropped: Vec<Value> = fx.audit_of(event::TUNNEL_CLOSE).into_iter().filter(|v| v["outcome"] == "dropped").collect();
    assert_eq!(dropped.len(), 2);
    assert!(dropped.iter().all(|v| v["errorClass"] == "tunnel" && v["errorCode"] == "tunnel.dropped"));
    assert_audit_clean(&fx);
}

// ---------------------------------------------------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn every_lifecycle_event_carries_only_ids_tags_labels_codes_and_counts() {
    let fx = fx();
    let s = studio(&fx);
    // zero cost: building the gateway touched nothing
    assert!(!fx.audit_path().exists());
    assert_eq!(s.tunnels().count(), 0);

    let label = format!("mongodb://{SSH_USER}:{URI_PW}@host.example.com/db");
    for name in event::ALL {
        let ev = AuditEvent::new(name, "p-123").with_tag("production", "ProductionLevel").with_label(&label).with_count(3).with_duration(Duration::from_millis(42));
        s.audit_event(&ev);
    }
    s.audit_event(&AuditEvent::new(event::CONNECT, "p-123").with_tag("sandbox", "Local").failed(intely_mongo::api::ErrorClass::Auth, "auth.failed"));
    // a hostile code (a path with a password) cannot get into the file
    s.audit_event(&AuditEvent::new(event::CONNECT, "p-123").failed(intely_mongo::api::ErrorClass::Other, &format!("{KEY_FILE} {URI_PW}")));

    let lines = fx.audit();
    assert_eq!(lines.len(), event::ALL.len() + 2);
    for (i, name) in event::ALL.iter().enumerate() {
        let v = &lines[i];
        assert_eq!(v["op"], *name);
        assert_eq!(v["class"], "lifecycle");
        assert_eq!(v["connectionId"], "p-123");
        assert_eq!(v["environment"], "production");
        assert_eq!(v["level"], "ProductionLevel");
        assert_eq!(v["count"], 3);
        assert_eq!(v["durationMs"], 42);
        assert_eq!(v["origin"], "desktop");
        assert_eq!(v["outcome"], "ok");
        let ts = v["ts"].as_str().unwrap();
        assert!(ts.len() == 24 && ts.ends_with('Z') && ts.as_bytes()[10] == b'T', "{ts}");
        // the label is the scrubbed text: the URI is replaced, never copied
        assert!(!v["label"].as_str().unwrap().contains(URI_PW) && !v["label"].as_str().unwrap().contains(SSH_USER), "{}", v["label"]);
        // the exact key set: no free text field exists
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["class", "connectionId", "count", "durationMs", "environment", "label", "level", "op", "origin", "outcome", "truncated", "ts"]);
    }
    let failed = &lines[event::ALL.len()];
    assert_eq!((failed["outcome"].clone(), failed["errorClass"].clone(), failed["errorCode"].clone()), ("error".into(), "auth".into(), "auth.failed".into()));
    let hostile = &lines[event::ALL.len() + 1];
    assert_eq!(hostile["errorCode"], "other");
    assert_audit_clean(&fx);

    // a reader of the old read lines reads these too
    let text = std::fs::read_to_string(fx.audit_path()).unwrap();
    for l in text.lines() {
        serde_json::from_str::<AuditRecord>(l).expect("an event line is also an AuditRecord");
    }
    assert_eq!(std::fs::metadata(fx.audit_path()).unwrap().permissions().mode() & 0o777, 0o600);
}

#[test]
fn the_audit_log_rolls_and_keeps_three_files() {
    assert_eq!(MAX_LOG_BYTES, 5 * 1024 * 1024, "about 5 MiB");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mongo-audit.jsonl");
    let log = AuditLog::with_limit(&path, 3_000);
    let numbered = |n: u32| PathBuf::from(format!("{}.{n}", path.display()));
    let marker = |i: usize| format!("\"count\":{i},");
    for i in 0..400 {
        log.append_event(&AuditEvent::new(event::CONNECT, "p1").with_tag("local", "Local").with_label("127.0.0.1").with_count(i)).unwrap();
    }
    assert!(path.exists() && numbered(1).exists() && numbered(2).exists(), "live file plus two rolled generations");
    assert!(!numbered(3).exists(), "never more than three files");
    for p in [path.clone(), numbered(1), numbered(2)] {
        let len = std::fs::metadata(&p).unwrap().len();
        assert!(len < 3_000 + 400, "{} is {len} bytes", p.display());
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600, "rolled files keep 0600");
    }
    let all: String = [numbered(2), numbered(1), path.clone()].iter().map(|p| std::fs::read_to_string(p).unwrap()).collect();
    assert!(!all.contains(&marker(0)), "the oldest lines were dropped");
    assert!(all.contains("\"count\":399"), "the newest line is there");
    // order is preserved across the files: the counts only go up
    let counts: Vec<u64> = all.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()["count"].as_u64().unwrap()).collect();
    assert!(counts.windows(2).all(|w| w[0] < w[1]), "{counts:?}");
    // two writers on the same file (the gateway and the registry) interleave whole lines
    let a = AuditLog::with_limit(&path, 1_000_000);
    let b = AuditLog::with_limit(&path, 1_000_000);
    std::thread::scope(|sc| {
        sc.spawn(|| (0..100).for_each(|_| a.append_event(&AuditEvent::new(event::DISCONNECT, "a")).unwrap()));
        sc.spawn(|| (0..100).for_each(|_| b.append_event(&AuditEvent::new(event::DISCONNECT, "b")).unwrap()));
    });
    for l in std::fs::read_to_string(&path).unwrap().lines() {
        serde_json::from_str::<Value>(l).expect("no torn line");
    }
}
