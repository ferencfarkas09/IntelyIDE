//! T4c: the tunnel lifecycle, the private directory, the pid file and the orphan sweep. No real sshd and no network
//! beyond loopback: `scripts/mongo-fixture/fake-ssh` (a `/bin/sh` double selected through `INTELY_SSH_BINARY`, honoured
//! only under the E2E jail) stands in for ssh, `ssh-keyscan` is a fixed-key double, and a fake process table stands in
//! for `/bin/ps`. Everything happens below a `tempfile` root that is also the jail's fixture root.
#![cfg(all(feature = "mongo", unix))]

use std::collections::{HashMap, HashSet};
use std::io;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use intely_mongo::api::{HostKeyStatus, TunnelState};
use intely_mongo::connspec::{AllowedHost, HostPort, SshSpec, TunnelAuth};
use intely_mongo::error::code;
use intely_mongo::jail::{Jail, NetworkPolicy};
use intely_mongo::tunnel::dir::{self, TunnelDir};
use intely_mongo::tunnel::ssh::{CommandRunner, RunOutput, RunRequest, SystemRunner};
use intely_mongo::tunnel::sweep::{self, PidEntry, ProcessTable, SystemProcs};
use intely_mongo::tunnel::{AllowList, MasterLauncher, Socks5Endpoint, SystemLauncher, Tunnel, TunnelEnv, TunnelSecrets};
use intely_settings::Secret;

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------------

const CANARY: &str = "pw-CANARY-9f3a71c2";

struct Fx {
    root: tempfile::TempDir,
    fake: PathBuf,
    state: PathBuf,
    node: Option<String>,
}

fn find_node() -> Option<String> {
    let out = std::process::Command::new("/bin/sh").arg("-c").arg("command -v node").output().ok()?;
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!p.is_empty() && Path::new(&p).is_absolute()).then_some(p)
}

fn fx() -> Fx {
    let root = tempfile::tempdir().unwrap();
    let fake = root.path().join("fake");
    let state = root.path().join("state");
    std::fs::create_dir_all(&fake).unwrap();
    std::fs::create_dir_all(&state).unwrap();
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/mongo-fixture/fake-ssh");
    for (name, exec) in [("ssh", true), ("ssh-keyscan", true), ("bridge.mjs", false)] {
        std::fs::copy(src.join(name), fake.join(name)).unwrap();
        std::fs::set_permissions(fake.join(name), std::fs::Permissions::from_mode(if exec { 0o755 } else { 0o644 })).unwrap();
    }
    let node = find_node();
    if let Some(n) = &node {
        std::fs::write(fake.join("node-bin"), n).unwrap();
    }
    std::fs::write(fake.join("expect-secret"), CANARY).unwrap();
    std::fs::create_dir_all(root.path().join("home")).unwrap();
    Fx { root, fake, state, node }
}

impl Fx {
    fn mode(&self, m: &str) {
        std::fs::write(self.fake.join("mode"), m).unwrap();
    }
    fn targets(&self, lines: &str) {
        std::fs::write(self.fake.join("targets"), lines).unwrap();
    }
    fn calls(&self) -> String {
        std::fs::read_to_string(self.fake.join("calls.log")).unwrap_or_default()
    }
    fn jail(&self, policy: NetworkPolicy) -> Jail {
        Jail::new(policy, &std::env::temp_dir(), Some(self.root.path()))
    }
    /// Names below the root that belong to a tunnel.
    fn leftovers(&self) -> Vec<String> {
        std::fs::read_dir(self.root.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with(dir::PREFIX)).collect()
    }
}

#[derive(Default)]
struct FakeProcs {
    table: Mutex<HashMap<u32, (String, String)>>,
    dead: Mutex<HashSet<u32>>,
    terminated: Mutex<Vec<u32>>,
    calls: AtomicUsize,
    /// Any pid not listed is alive with start time `t<pid>` (the real master and this test process).
    permissive: bool,
}

impl FakeProcs {
    fn permissive() -> Arc<Self> {
        Arc::new(Self { permissive: true, ..Default::default() })
    }
    fn strict() -> Arc<Self> {
        Arc::new(Self::default())
    }
    fn set(&self, pid: u32, start: &str, cmd: &str) {
        self.table.lock().unwrap().insert(pid, (start.into(), cmd.into()));
    }
    fn kill_pid(&self, pid: u32) {
        self.dead.lock().unwrap().insert(pid);
    }
    fn terminated(&self) -> Vec<u32> {
        self.terminated.lock().unwrap().clone()
    }
}

impl ProcessTable for FakeProcs {
    fn start_time(&self, pid: u32) -> Option<String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.dead.lock().unwrap().contains(&pid) {
            return None;
        }
        if let Some((s, _)) = self.table.lock().unwrap().get(&pid) {
            return Some(s.clone());
        }
        self.permissive.then(|| format!("t{pid}"))
    }
    fn command(&self, pid: u32) -> Option<String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.table.lock().unwrap().get(&pid).map(|(_, c)| c.clone())
    }
    fn terminate(&self, pid: u32) {
        self.terminated.lock().unwrap().push(pid);
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

#[derive(Default)]
struct CountingRunner(AtomicUsize);

impl CommandRunner for CountingRunner {
    fn run(&self, req: &RunRequest<'_>) -> io::Result<RunOutput> {
        self.0.fetch_add(1, Ordering::SeqCst);
        SystemRunner.run(req)
    }
}

fn env_for(fx: &Fx, procs: Arc<dyn ProcessTable>) -> TunnelEnv {
    let mut e = TunnelEnv::new(fx.jail(NetworkPolicy::LoopbackOnly), fx.state.clone());
    e.temp_dir = fx.root.path().to_path_buf();
    e.home = fx.root.path().join("home");
    e.local_user = "tester".into();
    e.auth_sock = None;
    e.ssh_override = Some(fx.fake.join("ssh").to_string_lossy().into_owned());
    e.procs = procs;
    e.connect_timeout_s = 10;
    e.poll = Duration::from_millis(30);
    e
}

fn spec() -> SshSpec {
    SshSpec { host: "127.0.0.1".into(), port: Some(2222), user: "tester".into(), ..Default::default() }
}

fn allow() -> AllowList {
    AllowList { entries: vec![HostPort { host: "127.0.0.1".into(), port: Some(27017) }] }
}

fn cancel() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

async fn open(e: &TunnelEnv, s: &SshSpec, secrets: &TunnelSecrets) -> intely_mongo::error::Result<Tunnel> {
    Tunnel::open(e, s, secrets, allow(), cancel()).await
}

fn no_secrets() -> TunnelSecrets {
    TunnelSecrets::default()
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

fn master_pid(fx: &Fx, t: &Tunnel) -> i32 {
    let _ = t;
    let entries = sweep::read_entries(&fx.state);
    entries.first().map(|e| e.pid as i32).expect("a pid entry")
}

async fn socks_connect(ep: &Socks5Endpoint, host: &str, port: u16) -> io::Result<(TcpStream, u8)> {
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
    Ok((s, r[1]))
}

async fn echo_server() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                while let Ok(n) = s.read(&mut buf).await {
                    if n == 0 || s.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    port
}

// ---------------------------------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_whole_lifecycle_runs_on_the_fake_ssh_and_leaves_nothing() {
    let fx = fx();
    let launcher = Arc::new(CountingLauncher::default());
    let mut e = env_for(&fx, FakeProcs::permissive());
    e.launcher = launcher.clone();
    let t = open(&e, &spec(), &no_secrets()).await.unwrap();
    assert_eq!(t.state(), TunnelState::Up);
    assert_eq!(launcher.0.load(Ordering::SeqCst), 1);
    assert!(t.proxy().port > 0);
    assert!(!format!("{t:?}").contains(&t.proxy().pass), "Debug must not show the SOCKS credentials");

    // one private directory with the control file, mode 0700, and one pid-file line that names it
    let dirs = fx.leftovers();
    assert_eq!(dirs.len(), 1, "{dirs:?}");
    let d = fx.root.path().join(&dirs[0]);
    assert_eq!(std::fs::metadata(&d).unwrap().permissions().mode() & 0o777, 0o700);
    assert!(d.join("c").exists());
    let entries = sweep::read_entries(&fx.state);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].dir, d.to_string_lossy());
    assert_eq!(entries[0].owner_pid, std::process::id());
    assert_eq!(std::fs::metadata(sweep::pid_path(&fx.state)).unwrap().permissions().mode() & 0o777, 0o600);
    let pid = master_pid(&fx, &t);
    assert!(alive(pid));
    assert!(fx.calls().contains("-O check"), "the ready check ran `ssh -O check`");
    // the master was started with the controlled argv
    let calls = fx.calls();
    assert!(calls.contains("-N -T -M -S"), "{calls}");
    assert!(calls.contains("ProxyCommand=none") && calls.contains("-F /dev/null"), "the jail forces config off: {calls}");

    t.close().await;
    assert!(fx.calls().contains("-O exit"), "the graceful close asked the master to exit");
    assert!(fx.leftovers().is_empty(), "no directory is left: {:?}", fx.leftovers());
    assert!(sweep::read_entries(&fx.state).is_empty(), "no pid-file residue");
    assert!(wait_until(Duration::from_secs(3), || !alive(pid)), "the master is gone");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bytes_flow_through_the_relay_and_the_fake_dash_w() {
    let fx = fx();
    if fx.node.is_none() {
        eprintln!("SKIPPED: node is not on this machine, the fake ssh -W bridge needs it");
        return;
    }
    let echo = echo_server().await;
    fx.targets(&format!("127.0.0.1:27017 {echo}\n"));
    let e = env_for(&fx, FakeProcs::permissive());
    let t = open(&e, &spec(), &no_secrets()).await.unwrap();
    let (mut s, rep) = socks_connect(&t.proxy(), "127.0.0.1", 27017).await.unwrap();
    assert_eq!(rep, 0);
    s.write_all(b"hello through the tunnel").await.unwrap();
    let mut buf = vec![0u8; 24];
    tokio::time::timeout(Duration::from_secs(10), s.read_exact(&mut buf)).await.unwrap().unwrap();
    assert_eq!(&buf, b"hello through the tunnel");
    // a destination that is not on the allow-list is refused and recorded
    let (_s2, rep2) = socks_connect(&t.proxy(), "10.9.9.9", 27017).await.unwrap();
    assert_ne!(rep2, 0);
    assert_eq!(t.refused(), vec![HostPort { host: "10.9.9.9".into(), port: Some(27017) }]);
    // "Allow this host" widens it (link-local is still refused)
    assert!(t.allow_more(&[AllowedHost { host: "169.254.169.254".into(), port: 80 }]).is_err());
    drop(s);
    t.close().await;
    assert!(fx.leftovers().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_user_without_forwarding_gets_the_forwarding_disabled_cause() {
    let fx = fx();
    fx.mode("forwarding-disabled");
    fx.targets("127.0.0.1:27017 1\n");
    let e = env_for(&fx, FakeProcs::permissive());
    let t = open(&e, &spec(), &no_secrets()).await.unwrap();
    let _ = socks_connect(&t.proxy(), "127.0.0.1", 27017).await;
    assert!(wait_until(Duration::from_secs(5), || t.last_failure().is_some()), "the failed -W child is recorded");
    assert_eq!(t.last_failure().unwrap().code, Some("tunnel.forwardingDisabled"));
    t.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failure_modes_map_to_their_codes_and_leave_nothing_behind() {
    for (mode, want, kind) in [
        ("hostkey-unknown", "tunnel.hostKeyUnknown", code::HOST_KEY),
        ("auth-denied", "tunnel.auth", code::TUNNEL),
        ("dns-fail", "tunnel.dns", code::TUNNEL),
        ("network-fail", "tunnel.network", code::TUNNEL),
    ] {
        let fx = fx();
        fx.mode(mode);
        let e = env_for(&fx, FakeProcs::permissive());
        let err = open(&e, &spec(), &no_secrets()).await.unwrap_err();
        assert_eq!(err.code, kind, "{mode}: {err}");
        assert!(err.message.starts_with(want), "{mode}: {err}");
        assert!(fx.leftovers().is_empty(), "{mode}: {:?}", fx.leftovers());
        assert!(sweep::read_entries(&fx.state).is_empty(), "{mode}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_changed_host_key_has_its_own_code_and_no_trust_path() {
    let fx = fx();
    fx.mode("hostkey-changed");
    // the saved key differs from the one the (fake) server offers
    let mut blob = Vec::new();
    blob.extend(11u32.to_be_bytes());
    blob.extend(b"ssh-ed25519");
    blob.extend(32u32.to_be_bytes());
    blob.extend([0x42u8; 32]);
    let line = intely_mongo::tunnel::knownhosts::known_hosts_line("127.0.0.1", 2222, "ssh-ed25519", &intely_mongo::tunnel::knownhosts::b64_encode(&blob, true)).unwrap();
    std::fs::write(fx.state.join("mongo_known_hosts"), format!("{line}\n")).unwrap();
    let e = env_for(&fx, FakeProcs::permissive());
    let err = open(&e, &spec(), &no_secrets()).await.unwrap_err();
    assert_eq!(err.code, code::HOST_KEY);
    assert!(err.message.starts_with("tunnel.hostKeyChanged"), "{err}");
    assert!(intely_mongo::tunnel::knownhosts::trust_allowed(HostKeyStatus::Unknown));
    assert!(!intely_mongo::tunnel::knownhosts::trust_allowed(HostKeyStatus::Changed));
    assert!(fx.leftovers().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_master_that_dies_is_reported_once_and_never_reopened() {
    let fx = fx();
    fx.mode("die-after-n-seconds 1");
    let launcher = Arc::new(CountingLauncher::default());
    let mut e = env_for(&fx, FakeProcs::permissive());
    e.launcher = launcher.clone();
    let t = open(&e, &spec(), &no_secrets()).await.unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let h = hits.clone();
    t.on_exit(Box::new(move || {
        h.fetch_add(1, Ordering::SeqCst);
    }));
    assert!(wait_until(Duration::from_secs(8), || hits.load(Ordering::SeqCst) == 1), "the exit callback fired");
    assert_eq!(t.state(), TunnelState::Down);
    // a callback registered afterwards runs at once
    let late = Arc::new(AtomicUsize::new(0));
    let l = late.clone();
    t.on_exit(Box::new(move || {
        l.fetch_add(1, Ordering::SeqCst);
    }));
    assert_eq!(late.load(Ordering::SeqCst), 1);
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(hits.load(Ordering::SeqCst), 1, "fired once");
    assert_eq!(launcher.0.load(Ordering::SeqCst), 1, "nothing re-opened the tunnel");
    t.close().await;
    assert!(fx.leftovers().is_empty());
    assert!(sweep::read_entries(&fx.state).is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_password_goes_through_the_one_fifo_and_never_into_an_error() {
    let fx = fx();
    fx.mode("ask-password");
    let e = env_for(&fx, FakeProcs::permissive());
    let mut s = spec();
    s.auth = TunnelAuth::Password;
    let t = open(&e, &s, &TunnelSecrets { ssh_secret: Some(Secret::new(CANARY)), key_password: None }).await.unwrap();
    assert_eq!(t.state(), TunnelState::Up);
    // the helper and the FIFO are gone as soon as the master is ready
    let d = fx.root.path().join(&fx.leftovers()[0]);
    assert!(!d.join("s").exists() && !d.join("askpass").exists());
    assert!(!fx.calls().contains(CANARY), "no secret in any argv");
    t.close().await;

    // a wrong password: tunnel.auth, the secret is in no message, nothing is left
    let wrong = "wrong-pw-CANARY-77";
    let err = open(&e, &s, &TunnelSecrets { ssh_secret: Some(Secret::new(wrong)), key_password: None }).await.unwrap_err();
    assert!(err.message.starts_with("tunnel.auth"), "{err}");
    assert!(!err.to_string().contains(wrong) && !err.to_string().contains(CANARY));
    assert!(fx.leftovers().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_key_passphrase_uses_the_exact_key_prompt() {
    let fx = fx();
    fx.mode("ask-passphrase");
    let e = env_for(&fx, FakeProcs::permissive());
    let mut s = spec();
    s.auth = TunnelAuth::KeyFile;
    s.key_file = Some("/keys/my key.pem".into());
    let t = open(&e, &s, &TunnelSecrets { ssh_secret: None, key_password: Some(Secret::new(CANARY)) }).await.unwrap();
    assert_eq!(t.state(), TunnelState::Up);
    t.close().await;
    assert!(fx.leftovers().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_missing_password_asks_for_it_before_anything_starts() {
    let fx = fx();
    let launcher = Arc::new(CountingLauncher::default());
    let mut e = env_for(&fx, FakeProcs::permissive());
    e.launcher = launcher.clone();
    let mut s = spec();
    s.auth = TunnelAuth::Password;
    let err = open(&e, &s, &no_secrets()).await.unwrap_err();
    assert_eq!(err.code, code::NEED_SECRET);
    assert!(err.message.contains("sshSecret"));
    assert_eq!(launcher.0.load(Ordering::SeqCst), 0);
    assert!(fx.leftovers().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_while_waiting_for_the_master_cleans_up() {
    let fx = fx();
    fx.mode("never-ready");
    let e = env_for(&fx, FakeProcs::permissive());
    let flag = cancel();
    let f2 = flag.clone();
    let task = tokio::spawn({
        let e = e.clone();
        async move { Tunnel::open(&e, &spec(), &TunnelSecrets::default(), allow(), f2).await }
    });
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(fx.leftovers().len(), 1, "the directory exists while we wait");
    flag.store(true, Ordering::SeqCst);
    let err = task.await.unwrap().unwrap_err();
    assert_eq!(err.code, code::CANCELLED);
    assert!(fx.leftovers().is_empty());
    assert!(sweep::read_entries(&fx.state).is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn drop_kills_the_master_and_writes_no_residue() {
    let fx = fx();
    let e = env_for(&fx, FakeProcs::permissive());
    let t = open(&e, &spec(), &no_secrets()).await.unwrap();
    let pid = master_pid(&fx, &t);
    assert!(alive(pid));
    drop(t);
    assert!(fx.leftovers().is_empty());
    assert!(sweep::read_entries(&fx.state).is_empty());
    assert!(wait_until(Duration::from_secs(3), || !alive(pid)));
}

#[test]
fn close_blocking_works_without_a_runtime() {
    let fx = fx();
    let e = env_for(&fx, FakeProcs::permissive());
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let t = rt.block_on(open(&e, &spec(), &no_secrets())).unwrap();
    let pid = master_pid(&fx, &t);
    // the runtime is gone before the tunnel is closed (quit path)
    drop(rt);
    t.close_blocking(Duration::from_secs(2));
    assert!(fx.leftovers().is_empty());
    assert!(sweep::read_entries(&fx.state).is_empty());
    assert!(wait_until(Duration::from_secs(3), || !alive(pid)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_jails_spawn_and_create_nothing() {
    let fx = fx();
    // read-only jail: no child process, no directory, no pid file
    let launcher = Arc::new(CountingLauncher::default());
    let runner = Arc::new(CountingRunner::default());
    let procs = FakeProcs::permissive();
    let mut e = env_for(&fx, procs.clone());
    e.jail = fx.jail(NetworkPolicy::Refused);
    e.launcher = launcher.clone();
    e.runner = runner.clone();
    let err = open(&e, &spec(), &no_secrets()).await.unwrap_err();
    assert_eq!(err.code, code::READ_ONLY_JAIL);
    assert_eq!(launcher.0.load(Ordering::SeqCst), 0);
    assert_eq!(runner.0.load(Ordering::SeqCst), 0);
    assert_eq!(procs.calls.load(Ordering::SeqCst), 0);
    assert!(fx.leftovers().is_empty());
    assert!(!sweep::pid_path(&fx.state).exists());
    assert!(sweep::add_entry(&e.jail, &fx.state, PidEntry { pid: 5, start_time: "x".into(), owner_pid: 6, owner_start: "y".into(), dir: "/x".into() }).is_err());

    // test jail: a bastion that is not loopback is refused before anything is touched
    let mut e2 = env_for(&fx, FakeProcs::permissive());
    e2.launcher = launcher.clone();
    let mut remote = spec();
    remote.host = "bastion.example.com".into();
    let err = open(&e2, &remote, &no_secrets()).await.unwrap_err();
    assert_eq!(err.code, code::TEST_JAIL);
    // ... and so is a remote database host
    let far = AllowList { entries: vec![HostPort { host: "db.example.com".into(), port: Some(27017) }] };
    let err = Tunnel::open(&e2, &spec(), &no_secrets(), far, cancel()).await.unwrap_err();
    assert_eq!(err.code, code::TEST_JAIL);
    assert_eq!(launcher.0.load(Ordering::SeqCst), 0);
    assert!(fx.leftovers().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_real_home_known_hosts_is_untouched() {
    let fx = fx();
    let real = std::env::var("HOME").map(|h| PathBuf::from(h).join(".ssh/known_hosts")).ok();
    let before = real.as_ref().and_then(|p| std::fs::metadata(p).ok()).map(|m| (m.len(), m.modified().ok()));
    let e = env_for(&fx, FakeProcs::permissive());
    let t = open(&e, &spec(), &no_secrets()).await.unwrap();
    t.close().await;
    let after = real.as_ref().and_then(|p| std::fs::metadata(p).ok()).map(|m| (m.len(), m.modified().ok()));
    assert_eq!(before, after);
}

// ---------------------------------------------------------------------------------------------------------------------
// The directory
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn the_directory_is_created_private_and_a_pre_existing_path_is_refused() {
    let fx = fx();
    let jail = fx.jail(NetworkPolicy::LoopbackOnly);
    let d = TunnelDir::create(&jail, fx.root.path()).unwrap();
    assert_eq!(std::fs::metadata(d.path()).unwrap().permissions().mode() & 0o777, 0o700);
    assert!(dir::valid_dir_name(d.path().file_name().unwrap().to_str().unwrap(), dir::current_uid()));
    assert!(d.control().to_string_lossy().len() < dir::MAX_CONTROL_PATH);

    // an existing directory, file or symlink of the chosen name is never reused
    let name = dir::dir_name(dir::current_uid(), "aaaaaaaaaaaaaaaa");
    let target = fx.root.path().join(&name);
    std::fs::DirBuilder::new().mode(0o755).create(&target).unwrap();
    assert!(TunnelDir::create_at(&jail, target.clone()).is_err());
    assert_eq!(std::fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o755, "left alone");
    std::fs::remove_dir(&target).unwrap();
    std::fs::write(&target, "x").unwrap();
    assert!(TunnelDir::create_at(&jail, target.clone()).is_err());
    std::fs::remove_file(&target).unwrap();
    let victim = fx.root.path().join("victim");
    std::fs::create_dir(&victim).unwrap();
    std::os::unix::fs::symlink(&victim, &target).unwrap();
    assert!(TunnelDir::create_at(&jail, target.clone()).is_err());
    assert!(victim.exists());
    // removal never follows a link
    let fake_owner = TunnelDir::create_at(&jail, fx.root.path().join(dir::dir_name(dir::current_uid(), "bbbbbbbbbbbbbbbb"))).unwrap();
    fake_owner.remove();
    assert!(!fake_owner.path().exists());
    d.remove();
    assert!(!d.path().exists());
    d.remove(); // idempotent
}

#[test]
fn a_deep_temp_directory_moves_the_tunnel_directory_to_tmp_so_that_ssh_can_bind_its_socket() {
    // real sshd, macOS: ssh binds `<ctl>.<16 characters>`, so `<dir>/c` plus 17 bytes must fit the 103 usable bytes of sun_path
    let fx = fx();
    let deep = fx.root.path().join("d".repeat(45));
    std::fs::create_dir_all(&deep).unwrap();
    let free = TunnelDir::create(&fx.jail(NetworkPolicy::Full), &deep).unwrap();
    assert!(free.path().starts_with("/tmp"), "{:?}", free.path());
    assert!(free.control().to_string_lossy().len() + 17 <= 103);
    free.remove();
    // the test jail allows writes below the fixture or temp directory only: the long base is kept there (fake ssh)
    let jailed = TunnelDir::create(&fx.jail(NetworkPolicy::LoopbackOnly), &deep).unwrap();
    assert!(jailed.path().starts_with(&deep));
    jailed.remove();
    // the default macOS temp directory (TMPDIR) fits, so nothing moves there in the normal case
    let uid = dir::current_uid();
    let default_macos_tmp = "/var/folders/ry/fs3hhy3n1tz4c5gkptjkj2h00000gp/T/".len();
    assert!(default_macos_tmp + 1 + dir::dir_name(uid, "0000000000000000").len() + 2 < dir::SSH_SAFE_CONTROL_PATH);
}

#[test]
fn the_directory_respects_the_write_jail() {
    let fx = fx();
    let other = tempfile::tempdir_in("/tmp").unwrap();
    assert_eq!(TunnelDir::create(&fx.jail(NetworkPolicy::LoopbackOnly), other.path()).unwrap_err().code, code::TEST_JAIL);
    assert_eq!(TunnelDir::create(&fx.jail(NetworkPolicy::Refused), fx.root.path()).unwrap_err().code, code::READ_ONLY_JAIL);
    assert!(std::fs::read_dir(other.path()).unwrap().next().is_none());
    assert!(fx.leftovers().is_empty());
}

#[test]
fn dir_names_are_matched_exactly() {
    let uid = 501;
    assert!(dir::valid_dir_name("intely-ssh-501-0123456789abcdef", uid));
    for bad in ["intely-ssh-502-0123456789abcdef", "intely-ssh-501-0123456789abcde", "intely-ssh-501-0123456789ABCDEF", "intely-ssh-501-0123456789abcdeg", "intely-ssh-501-0123456789abcdef/x", "xintely-ssh-501-0123456789abcdef", "intely-ssh-5010123456789abcdef", ""] {
        assert!(!dir::valid_dir_name(bad, uid), "{bad}");
    }
}

#[test]
fn no_code_here_can_remove_a_tree() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tunnel");
    for f in ["dir.rs", "sweep.rs", "mod.rs"] {
        let text = std::fs::read_to_string(root.join(f)).unwrap();
        assert!(!text.contains("remove_dir_all("), "{f} must never remove a tree");
    }
    assert_eq!(sweep::PS, "/bin/ps");
}

// ---------------------------------------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------------------------------------

fn mk_dir(base: &Path, uid: u32, tag: &str, mode: u32) -> PathBuf {
    let p = base.join(dir::dir_name(uid, tag));
    std::fs::DirBuilder::new().mode(mode).create(&p).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
    for f in ["c", "askpass", "s"] {
        std::fs::write(p.join(f), "x").unwrap();
    }
    p
}

fn pid_entry(pid: u32, owner: u32, d: &Path) -> PidEntry {
    PidEntry { pid, start_time: "S".into(), owner_pid: owner, owner_start: "O".into(), dir: d.to_string_lossy().into_owned() }
}

fn bases(fx: &Fx) -> Vec<PathBuf> {
    vec![fx.root.path().to_path_buf()]
}

#[test]
fn the_sweep_removes_what_a_dead_owner_left_and_signals_only_its_own_ssh() {
    let fx = fx();
    let jail = fx.jail(NetworkPolicy::LoopbackOnly);
    let uid = dir::current_uid();
    let procs = FakeProcs::strict();

    // 1: owner dead, ssh pid is the master of that directory: terminated, files and directory removed
    let d1 = mk_dir(fx.root.path(), uid, "1111111111111111", 0o700);
    procs.set(7001, "S", &format!("ssh -N -T -M -S {}/c -o X=y -- host", d1.display()));
    sweep::add_entry(&jail, &fx.state, pid_entry(7001, 9001, &d1)).unwrap();
    // 2: owner dead, the pid now belongs to another program: directory cleaned, nothing signalled
    let d2 = mk_dir(fx.root.path(), uid, "2222222222222222", 0o700);
    procs.set(7002, "S", "/usr/bin/vim notes.txt");
    sweep::add_entry(&jail, &fx.state, pid_entry(7002, 9001, &d2)).unwrap();
    // 3: owner's pid was reused by another start time: dead too; an unknown file keeps the directory (no recursive delete)
    let d3 = mk_dir(fx.root.path(), uid, "3333333333333333", 0o700);
    std::fs::write(d3.join("keep.txt"), "mine").unwrap();
    procs.set(9003, "OTHER", "whatever");
    sweep::add_entry(&jail, &fx.state, pid_entry(7003, 9003, &d3)).unwrap();
    // 4: a second running IDE owns this one: left alone
    let d4 = mk_dir(fx.root.path(), uid, "4444444444444444", 0o700);
    procs.set(9004, "O", "intely");
    procs.set(7004, "S", &format!("ssh -S {}/c", d4.display()));
    sweep::add_entry(&jail, &fx.state, pid_entry(7004, 9004, &d4)).unwrap();

    let r = sweep::sweep(&jail, &fx.state, &bases(&fx), &*procs, uid);
    assert_eq!((r.swept, r.terminated, r.dropped, r.kept), (3, 1, 0, 1), "{r:?}");
    assert_eq!(procs.terminated(), vec![7001]);
    assert!(!d1.exists() && !d2.exists());
    assert!(d3.join("keep.txt").exists() && !d3.join("c").exists(), "only the known files were removed");
    assert!(d4.join("c").exists(), "a live second owner keeps its tunnel");
    let left = sweep::read_entries(&fx.state);
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].pid, 7004);
}

#[test]
fn a_tampered_pid_line_is_dropped_without_touching_the_disk() {
    let fx = fx();
    let jail = fx.jail(NetworkPolicy::LoopbackOnly);
    let uid = dir::current_uid();
    let procs = FakeProcs::strict();
    let outside = tempfile::tempdir_in("/tmp").unwrap();
    let victim = fx.root.path().join("victim");
    std::fs::create_dir(&victim).unwrap();
    std::fs::write(victim.join("c"), "precious").unwrap();

    let mut bad: Vec<PathBuf> = Vec::new();
    // not below the temp directory
    bad.push(mk_dir(outside.path(), uid, "5555555555555555", 0o700));
    // wrong uid in the name
    bad.push(mk_dir(fx.root.path(), uid + 1, "6666666666666666", 0o700));
    // wrong mode
    bad.push(mk_dir(fx.root.path(), uid, "7777777777777777", 0o755));
    // a symlink with a perfect name pointing at a directory that holds a file called c
    let link = fx.root.path().join(dir::dir_name(uid, "8888888888888888"));
    std::os::unix::fs::symlink(&victim, &link).unwrap();
    bad.push(link.clone());
    // not even the right name
    let other = fx.root.path().join("some-dir");
    std::fs::create_dir(&other).unwrap();
    std::fs::write(other.join("c"), "mine").unwrap();
    bad.push(other.clone());
    // `..` and relative spellings
    bad.push(fx.root.path().join("x/../victim"));
    bad.push(PathBuf::from("intely-ssh-0-0000000000000000"));
    for (i, d) in bad.iter().enumerate() {
        procs.set(8100 + i as u32, "S", &format!("ssh -S {}/c", d.display()));
        sweep::add_entry(&jail, &fx.state, pid_entry(8100 + i as u32, 9100, d)).unwrap();
    }
    // garbage lines in the file are ignored
    let mut text = std::fs::read_to_string(sweep::pid_path(&fx.state)).unwrap();
    text.push_str("not json\n{\"pid\":1}\n");
    std::fs::write(sweep::pid_path(&fx.state), text).unwrap();

    let r = sweep::sweep(&jail, &fx.state, &bases(&fx), &*procs, uid);
    assert_eq!(r.dropped, bad.len(), "{r:?}");
    assert_eq!((r.swept, r.terminated), (0, 0));
    assert!(procs.terminated().is_empty());
    assert_eq!(std::fs::read_to_string(victim.join("c")).unwrap(), "precious");
    assert_eq!(std::fs::read_to_string(other.join("c")).unwrap(), "mine");
    for d in &bad[..3] {
        assert!(d.join("c").exists(), "{}", d.display());
    }
    assert!(link.exists());
    assert!(sweep::read_entries(&fx.state).is_empty());
}

#[test]
fn the_sweep_does_nothing_under_the_read_only_jail() {
    let fx = fx();
    let uid = dir::current_uid();
    let d = mk_dir(fx.root.path(), uid, "9999999999999999", 0o700);
    sweep::add_entry(&fx.jail(NetworkPolicy::LoopbackOnly), &fx.state, pid_entry(7777, 9777, &d)).unwrap();
    let before = std::fs::read(sweep::pid_path(&fx.state)).unwrap();
    let procs = FakeProcs::strict();
    let r = sweep::sweep(&fx.jail(NetworkPolicy::Refused), &fx.state, &bases(&fx), &*procs, uid);
    assert_eq!(r, sweep::SweepReport::default());
    assert_eq!(procs.calls.load(Ordering::SeqCst), 0, "no process was looked at");
    assert!(procs.terminated().is_empty());
    assert!(d.join("c").exists());
    assert_eq!(std::fs::read(sweep::pid_path(&fx.state)).unwrap(), before);
    assert!(sweep::remove_entry(&fx.jail(NetworkPolicy::Refused), &fx.state, &d).is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_first_open_sweeps_orphans_once_and_leaves_a_live_owner_alone() {
    let fx = fx();
    let uid = dir::current_uid();
    let jail = fx.jail(NetworkPolicy::LoopbackOnly);
    let dead_dir = mk_dir(fx.root.path(), uid, "aaaa000000000000", 0o700);
    let live_dir = mk_dir(fx.root.path(), uid, "bbbb000000000000", 0o700);
    let procs = FakeProcs::permissive();
    procs.kill_pid(9201);
    procs.kill_pid(7201);
    sweep::add_entry(&jail, &fx.state, pid_entry(7201, 9201, &dead_dir)).unwrap();
    // the permissive table says this owner is alive with start time t<pid>
    let mut live = pid_entry(7202, 9202, &live_dir);
    live.owner_start = "t9202".into();
    sweep::add_entry(&jail, &fx.state, live).unwrap();

    let e = env_for(&fx, procs.clone());
    let t = open(&e, &spec(), &no_secrets()).await.unwrap();
    assert!(!dead_dir.exists(), "the orphan of a dead app was swept by the first open");
    assert!(live_dir.exists(), "a live second owner is left alone");
    assert_eq!(sweep::read_entries(&fx.state).len(), 2, "the live line and this tunnel's line");
    t.close().await;

    // a second open in the same process does not sweep again
    let again = mk_dir(fx.root.path(), uid, "cccc000000000000", 0o700);
    procs.kill_pid(9203);
    sweep::add_entry(&jail, &fx.state, pid_entry(7203, 9203, &again)).unwrap();
    let t2 = open(&e, &spec(), &no_secrets()).await.unwrap();
    assert!(again.exists(), "once per process");
    t2.close().await;
}

#[test]
fn the_real_process_table_uses_absolute_ps() {
    // the real /bin/ps answers for this very process
    let me = std::process::id();
    let start = SystemProcs.start_time(me);
    assert!(start.is_some_and(|s| !s.is_empty()));
    assert!(SystemProcs.command(me).is_some());
    assert!(SystemProcs.start_time(4_000_000).is_none());
}
