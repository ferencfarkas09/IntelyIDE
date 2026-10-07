//! T4a: the ssh argv and environment builders, the askpass helper and FIFO, the known-hosts builder and the host-key
//! status, the binary check. No real sshd and no network: a closure-driven fake runner stands in for `ssh`, `ssh-keyscan`
//! and (mostly) `ssh-keygen`; the few tests that run the real `/usr/bin/ssh-keygen` and `/bin/sh` do so on files in a
//! temp directory with a cleared environment and skip with a printed reason when the tool is missing.
#![cfg(all(feature = "mongo", unix))]

use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use intely_mongo::api::HostKeyStatus;
use intely_mongo::connspec::{SshSpec, TunnelAuth};
use intely_mongo::error::code;
use intely_mongo::jail::{Jail, NetworkPolicy};
use intely_mongo::tunnel::askpass::{self, AskpassKind, FifoOutcome};
use intely_mongo::tunnel::knownhosts::{self, ScannedKey};
use intely_mongo::tunnel::ssh::{self, CommandRunner, EnvInputs, FileFacts, MasterParams, RunOutput, RunRequest, SshBinary, SshCtx, SystemRunner};
use intely_settings::Secret;

// ---------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------

type Handler = Box<dyn Fn(&str, &[String], Option<&[u8]>) -> Option<RunOutput> + Send + Sync>;

struct FnRunner {
    f: Handler,
    calls: AtomicUsize,
    log: Mutex<Vec<String>>,
}

impl FnRunner {
    fn new(f: impl Fn(&str, &[String], Option<&[u8]>) -> Option<RunOutput> + Send + Sync + 'static) -> Self {
        Self { f: Box::new(f), calls: AtomicUsize::new(0), log: Mutex::new(Vec::new()) }
    }
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}

impl CommandRunner for FnRunner {
    fn run(&self, req: &RunRequest<'_>) -> io::Result<RunOutput> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let name = req.program.file_name().unwrap().to_string_lossy().into_owned();
        self.log.lock().unwrap().push(format!("{name} {}", req.args.join(" ")));
        (self.f)(&name, req.args, req.stdin).ok_or_else(|| io::Error::other("unexpected command"))
    }
}

fn out(code: i32, stdout: &str) -> RunOutput {
    RunOutput { code: Some(code), stdout: stdout.as_bytes().to_vec(), stderr: Vec::new(), timed_out: false }
}

fn bin() -> SshBinary {
    SshBinary { ssh: "/usr/bin/ssh".into(), keygen: "/usr/bin/ssh-keygen".into(), keyscan: "/usr/bin/ssh-keyscan".into(), version: None, overridden: false }
}

fn env_inputs(home: &str) -> EnvInputs {
    EnvInputs { home: home.into(), user: "tester".into(), auth_sock: Some("/tmp/agent.sock".into()) }
}

fn jail(policy: NetworkPolicy, tmp: &Path) -> Jail {
    Jail::new(policy, tmp, None)
}

fn spec(host: &str) -> SshSpec {
    SshSpec { host: host.into(), port: Some(2222), user: "alice".into(), ..Default::default() }
}

/// A synthetic ed25519 key: the real wire layout with 32 arbitrary bytes.
fn ed_key(seed: u8) -> (String, String) {
    let mut blob = vec![0, 0, 0, 11];
    blob.extend_from_slice(b"ssh-ed25519");
    blob.extend_from_slice(&[0, 0, 0, 32]);
    blob.extend((0..32u8).map(|i| i.wrapping_mul(7).wrapping_add(seed)));
    ("ssh-ed25519".into(), knownhosts::b64_encode(&blob, true))
}

fn scan_line(host: &str, key: &(String, String)) -> String {
    format!("{host} {} {}\n", key.0, key.1)
}

fn scanned(key: &(String, String)) -> ScannedKey {
    knownhosts::parse_key(&key.0, &key.1).unwrap()
}

/// `tempfile` creates 0755 directories; the tunnel directory is 0700.
fn tmpdir() -> tempfile::TempDir {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    std::fs::set_permissions(d.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    d
}

fn skip(why: &str) {
    eprintln!("SKIPPED: {why}");
}

fn real_keygen_available() -> bool {
    Path::new("/usr/bin/ssh-keygen").is_file()
}

// ---------------------------------------------------------------------------------------------------------------------
// Binary check
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn binary_check_rejects_untrusted_files() {
    let ok = FileFacts { is_file: true, uid: 0, mode: 0o755 };
    assert!(ssh::check_trusted(Some(ok)).is_ok());
    for bad in [None, Some(FileFacts { is_file: false, ..ok }), Some(FileFacts { uid: 501, ..ok }), Some(FileFacts { mode: 0o775, ..ok }), Some(FileFacts { mode: 0o757, ..ok })] {
        let e = ssh::check_trusted(bad).unwrap_err();
        assert_eq!(e.code, code::TUNNEL);
        assert!(e.message.starts_with("tunnel.noSsh:"), "{}", e.message);
    }
}

#[test]
fn locate_uses_usr_bin_only_and_honours_the_override_only_under_the_e2e_jail() {
    let good = |_: &Path| Some(FileFacts { is_file: true, uid: 0, mode: 0o755 });
    let b = SshBinary::locate(NetworkPolicy::Full, None, &good).unwrap();
    assert_eq!(b.ssh, PathBuf::from("/usr/bin/ssh"));
    assert_eq!(b.keygen, PathBuf::from("/usr/bin/ssh-keygen"));
    assert_eq!(b.keyscan, PathBuf::from("/usr/bin/ssh-keyscan"));
    assert!(!b.overridden);
    // not owned by root: refused
    let user_owned = |p: &Path| if p.ends_with("ssh-keyscan") { Some(FileFacts { is_file: true, uid: 501, mode: 0o755 }) } else { good(p) };
    assert!(SshBinary::locate(NetworkPolicy::Full, None, &user_owned).is_err());
    // the override is ignored outside the E2E jail (and never used to skip the root check)
    let fake = |p: &Path| if p.starts_with("/fx") { (p == Path::new("/fx/ssh")).then_some(FileFacts { is_file: true, uid: 501, mode: 0o755 }) } else { good(p) };
    let b = SshBinary::locate(NetworkPolicy::Full, Some("/fx/ssh"), &fake).unwrap();
    assert_eq!(b.ssh, PathBuf::from("/usr/bin/ssh"));
    let b = SshBinary::locate(NetworkPolicy::Refused, Some("/fx/ssh"), &fake).unwrap();
    assert_eq!(b.ssh, PathBuf::from("/usr/bin/ssh"));
    let b = SshBinary::locate(NetworkPolicy::LoopbackOnly, Some("/fx/ssh"), &fake).unwrap();
    assert_eq!(b.ssh, PathBuf::from("/fx/ssh"));
    assert!(b.overridden);
    assert_eq!(b.keygen, PathBuf::from("/usr/bin/ssh-keygen"), "no sibling: the trusted system tool is used");
    assert!(SshBinary::locate(NetworkPolicy::LoopbackOnly, Some("relative/ssh"), &fake).is_err());
    assert!(SshBinary::locate(NetworkPolicy::LoopbackOnly, Some("/fx/missing"), &|p: &Path| if p.starts_with("/fx") { None } else { good(p) }).is_err());
}

#[test]
fn old_openssh_refuses_secret_modes_only() {
    let tmp = tmpdir();
    let j = jail(NetworkPolicy::Full, tmp.path());
    let old = FnRunner::new(|name, args, _| (name == "ssh" && args == ["-V"]).then(|| RunOutput { code: Some(0), stderr: b"OpenSSH_8.2p1 Ubuntu-4ubuntu0.5, OpenSSL 1.1.1f".to_vec(), ..Default::default() }));
    let mut b = bin();
    b.probe_version(&old, &j, &ssh::base_env(&env_inputs("/h"))).unwrap();
    assert_eq!(b.version, Some(ssh::SshVersion { major: 8, minor: 2 }));
    let e = b.require_secret_mode().unwrap_err();
    assert!(e.message.starts_with("tunnel.noSsh:") && e.message.contains("8.2"), "{}", e.message);
    // agent and unencrypted-key argv do not depend on the version
    let p = MasterParams { spec: &spec("bastion.example.com"), control: Path::new("/tmp/d/c"), app_known_hosts: Path::new("/s/kh"), home_known_hosts: None, connect_timeout_s: 10, policy: NetworkPolicy::Full, has_secret: false };
    assert!(ssh::master_argv(&p).is_ok());
    let modern = FnRunner::new(|_, _, _| Some(RunOutput { code: Some(0), stderr: b"OpenSSH_10.3p1, LibreSSL 3.3.6\n".to_vec(), ..Default::default() }));
    let mut b = bin();
    b.probe_version(&modern, &j, &[]).unwrap();
    assert!(b.require_secret_mode().is_ok());
    // an unreadable version is refused for the real binary
    let junk = FnRunner::new(|_, _, _| Some(RunOutput { code: Some(0), stderr: b"???".to_vec(), ..Default::default() }));
    assert!(bin().probe_version(&junk, &j, &[]).is_err());
}

// ---------------------------------------------------------------------------------------------------------------------
// Argv goldens
// ---------------------------------------------------------------------------------------------------------------------

const COMMON_OPTS: &str = "-o\nControlPersist=no\n-o\nExitOnForwardFailure=yes\n-o\nClearAllForwardings=yes\n-o\nForwardAgent=no\n-o\nForwardX11=no\n-o\nForwardX11Trusted=no\n-o\nPermitLocalCommand=no\n-o\nRemoteCommand=none\n-o\nRequestTTY=no\n-o\nTunnel=no\n-o\nPKCS11Provider=none\n-o\nAddKeysToAgent=no\n-o\nStrictHostKeyChecking=yes\n-o\nCheckHostIP=no\n-o\nVerifyHostKeyDNS=no\n-o\nUpdateHostKeys=no\n-o\nHashKnownHosts=no\n-o\nGlobalKnownHostsFile=/dev/null\n";

fn golden(parts: &[&str]) -> Vec<String> {
    parts.iter().flat_map(|p| p.lines().map(str::to_string)).collect()
}

#[test]
fn master_argv_golden_agent_with_config_and_a_state_path_with_a_space() {
    let s = spec("bastion.example.com");
    let p = MasterParams {
        spec: &s,
        control: Path::new("/tmp/intely-ssh-501-0123456789abcdef/c"),
        app_known_hosts: Path::new("/Users/x y/Library/Application Support/mongo_known_hosts"),
        home_known_hosts: Some(Path::new("/Users/x y/.ssh/known_hosts")),
        connect_timeout_s: 10,
        policy: NetworkPolicy::Full,
        has_secret: false,
    };
    let want = golden(&[
        "-N\n-T\n-M\n-S\n/tmp/intely-ssh-501-0123456789abcdef/c\n",
        COMMON_OPTS,
        "-o\nUserKnownHostsFile=\"/Users/x y/Library/Application Support/mongo_known_hosts\" \"/Users/x y/.ssh/known_hosts\"\n",
        "-o\nServerAliveInterval=15\n-o\nServerAliveCountMax=3\n-o\nConnectTimeout=10\n",
        "-p\n2222\n-l\nalice\n-o\nBatchMode=yes\n-o\nPreferredAuthentications=publickey\n--\nbastion.example.com\n",
    ]);
    assert_eq!(ssh::master_argv(&p).unwrap(), want);
}

#[test]
fn master_argv_golden_key_file_without_config_percent_paths() {
    let mut s = spec("bastion.example.com");
    s.port = None;
    s.auth = TunnelAuth::KeyFile;
    s.key_file = Some("/keys/my%key".into());
    s.use_ssh_config = false;
    let mk = |has_secret| MasterParams {
        spec: &s,
        control: Path::new("/tmp/a%b/c"),
        app_known_hosts: Path::new("/st%ate/mongo_known_hosts"),
        // dropped because the ssh config is off (-F /dev/null): only the app file is consulted
        home_known_hosts: Some(Path::new("/home/u/.ssh/known_hosts")),
        connect_timeout_s: 100,
        policy: NetworkPolicy::Full,
        has_secret,
    };
    let head = golden(&[
        "-N\n-T\n-M\n-S\n/tmp/a%%b/c\n",
        COMMON_OPTS,
        "-o\nUserKnownHostsFile=\"/st%%ate/mongo_known_hosts\"\n",
        "-o\nServerAliveInterval=15\n-o\nServerAliveCountMax=3\n-o\nConnectTimeout=60\n-F\n/dev/null\n-l\nalice\n-i\n/keys/my%%key\n-o\nIdentitiesOnly=yes\n-o\nIdentityAgent=none\n",
    ]);
    let mut plain = head.clone();
    plain.extend(golden(&["-o\nBatchMode=yes\n--\nbastion.example.com\n"]));
    assert_eq!(ssh::master_argv(&mk(false)).unwrap(), plain);
    // a passphrase must be askable: BatchMode=yes would make ssh give up on an encrypted key without asking
    let mut asked = head;
    asked.extend(golden(&["-o\nBatchMode=no\n-o\nPreferredAuthentications=publickey\n-o\nNumberOfPasswordPrompts=1\n--\nbastion.example.com\n"]));
    assert_eq!(ssh::master_argv(&mk(true)).unwrap(), asked);
}

#[test]
fn master_argv_golden_password() {
    let mut s = spec("bastion.example.com");
    s.auth = TunnelAuth::Password;
    let p = MasterParams { spec: &s, control: Path::new("/t/c"), app_known_hosts: Path::new("/s/kh"), home_known_hosts: None, connect_timeout_s: 7, policy: NetworkPolicy::Full, has_secret: true };
    let got = ssh::master_argv(&p).unwrap();
    let tail = golden(&["-p\n2222\n-l\nalice\n-o\nIdentityAgent=none\n-o\nBatchMode=no\n-o\nPreferredAuthentications=password,keyboard-interactive\n-o\nPubkeyAuthentication=no\n-o\nNumberOfPasswordPrompts=1\n--\nbastion.example.com\n"]);
    assert!(got.ends_with(&tail), "{got:?}");
    assert!(got.contains(&"ConnectTimeout=7".to_string()));
    assert!(!got.iter().any(|a| a == "-i"));
}

#[test]
fn stream_argv_golden() {
    let s = spec("bastion.example.com");
    let got = ssh::stream_argv(&s, Path::new("/tmp/d%/c"), NetworkPolicy::Full, "Db-1.Internal", 27017).unwrap();
    let want = golden(&["-S\n/tmp/d%%/c\n-o\nControlMaster=no\n-o\nProxyCommand=false\n-o\nBatchMode=yes\n-o\nStrictHostKeyChecking=yes\n-W\ndb-1.internal:27017\n-q\n--\nbastion.example.com\n"]);
    assert_eq!(got, want);
    // without the ssh config the children carry -F /dev/null too
    let mut s2 = s.clone();
    s2.use_ssh_config = false;
    let got = ssh::stream_argv(&s2, Path::new("/t/c"), NetworkPolicy::Full, "db", 1).unwrap();
    assert_eq!(&got[..2], ["-F", "/dev/null"]);
}

#[test]
fn ssh_g_argv_golden() {
    let s = spec("bastion.example.com");
    assert_eq!(ssh::ssh_g_argv(&s, NetworkPolicy::Full).unwrap(), golden(&["-G\n-p\n2222\n-l\nalice\n--\nbastion.example.com\n"]));
    let mut s2 = s;
    s2.port = None;
    s2.use_ssh_config = false;
    assert_eq!(ssh::ssh_g_argv(&s2, NetworkPolicy::Full).unwrap(), golden(&["-F\n/dev/null\n-G\n-l\nalice\n--\nbastion.example.com\n"]));
}

#[test]
fn a_jail_forces_no_config_no_proxy_and_a_loopback_host() {
    let s = spec("127.0.0.1");
    let p = |policy, host: &SshSpec| {
        ssh::master_argv(&MasterParams { spec: host, control: Path::new("/t/c"), app_known_hosts: Path::new("/s/kh"), home_known_hosts: Some(Path::new("/h/.ssh/known_hosts")), connect_timeout_s: 10, policy, has_secret: false })
    };
    let got = p(NetworkPolicy::LoopbackOnly, &s).unwrap();
    let joined = got.join(" ");
    assert!(joined.contains("-F /dev/null"), "{joined}");
    assert!(joined.contains("-o ProxyCommand=none -o ProxyJump=none"), "{joined}");
    assert!(joined.contains("UserKnownHostsFile=\"/s/kh\" "), "{joined}");
    assert!(!joined.contains("/h/.ssh/known_hosts"), "only the app file is consulted under a jail: {joined}");
    for h in ["localhost", "127.0.0.1"] {
        assert!(p(NetworkPolicy::LoopbackOnly, &spec(h)).is_ok());
    }
    let e = p(NetworkPolicy::LoopbackOnly, &spec("bastion.example.com")).unwrap_err();
    assert_eq!(e.code, code::TEST_JAIL);
    // the read-only jail builds nothing
    assert_eq!(p(NetworkPolicy::Refused, &s).unwrap_err().code, code::READ_ONLY_JAIL);
    assert_eq!(ssh::stream_argv(&s, Path::new("/t/c"), NetworkPolicy::Refused, "127.0.0.1", 1).unwrap_err().code, code::READ_ONLY_JAIL);
    assert_eq!(ssh::stream_argv(&spec("bastion.example.com"), Path::new("/t/c"), NetworkPolicy::LoopbackOnly, "127.0.0.1", 1).unwrap_err().code, code::TEST_JAIL);
    // without a jail the user's config is used and no proxy override is added
    let free = p(NetworkPolicy::Full, &s).unwrap().join(" ");
    assert!(!free.contains("-F /dev/null") && !free.contains("ProxyCommand=none"), "{free}");
}

// ---------------------------------------------------------------------------------------------------------------------
// Hostile input
// ---------------------------------------------------------------------------------------------------------------------

const HOSTILE: [&str; 14] = [
    "-oProxyCommand=touch /tmp/x",
    "-o",
    "--",
    "host name",
    "host\nname",
    "host\tname",
    "ho\"st",
    "ho'st",
    "$(touch /tmp/x)",
    "`id`",
    "a;b",
    "a|b",
    "host%h",
    "",
];

fn plain_master(s: &SshSpec) -> intely_mongo::error::Result<Vec<String>> {
    ssh::master_argv(&MasterParams { spec: s, control: Path::new("/t/c"), app_known_hosts: Path::new("/s/kh"), home_known_hosts: None, connect_timeout_s: 10, policy: NetworkPolicy::Full, has_secret: false })
}

#[test]
fn hostile_hosts_users_keys_and_targets_are_rejected() {
    for bad in HOSTILE {
        let mut s = spec("bastion.example.com");
        s.host = bad.into();
        assert!(plain_master(&s).is_err(), "host {bad:?}");
        assert!(ssh::ssh_g_argv(&s, NetworkPolicy::Full).is_err(), "host {bad:?}");
        assert!(ssh::stream_argv(&s, Path::new("/t/c"), NetworkPolicy::Full, "db", 1).is_err());
        let mut s = spec("bastion.example.com");
        s.user = bad.into();
        assert!(plain_master(&s).is_err(), "user {bad:?}");
        assert!(ssh::check_target(bad, 27017).is_err(), "target {bad:?}");
        assert!(ssh::stream_argv(&spec("bastion.example.com"), Path::new("/t/c"), NetworkPolicy::Full, bad, 27017).is_err(), "target {bad:?}");
    }
    // IPv6 literals are their own code
    let e = ssh::check_target("[::1]", 27017).unwrap_err();
    assert!(e.message.starts_with("tunnel.ipv6:"), "{}", e.message);
    assert!(ssh::check_target("db", 0).is_err());
    // key files: only absolute, no control characters, only with key file auth
    for bad in ["relative/key", "/k/../etc/passwd", "/k/a\nb", "-i"] {
        let mut s = spec("bastion.example.com");
        s.auth = TunnelAuth::KeyFile;
        s.key_file = Some(bad.into());
        assert!(plain_master(&s).is_err(), "key {bad:?}");
    }
    let mut s = spec("bastion.example.com");
    s.auth = TunnelAuth::KeyFile;
    assert!(plain_master(&s).is_err(), "key file auth without a key file");
    let mut s = spec("bastion.example.com");
    s.key_file = Some("/k/id".into());
    assert!(plain_master(&s).is_err(), "a key file with agent auth");
    // paths that ssh would parse as quoted text
    for bad in ["/s/a\"b", "/s/a\\b", "/s/a'b", "/s/a\nb", "rel/kh"] {
        let s = spec("bastion.example.com");
        let r = ssh::master_argv(&MasterParams { spec: &s, control: Path::new("/t/c"), app_known_hosts: Path::new(bad), home_known_hosts: None, connect_timeout_s: 10, policy: NetworkPolicy::Full, has_secret: false });
        assert!(r.is_err(), "state path {bad:?}");
    }
    // a control path over the sun_path budget
    let long = format!("/{}/c", "a".repeat(120));
    let s = spec("bastion.example.com");
    assert!(ssh::master_argv(&MasterParams { spec: &s, control: Path::new(&long), app_known_hosts: Path::new("/s/kh"), home_known_hosts: None, connect_timeout_s: 10, policy: NetworkPolicy::Full, has_secret: false }).is_err());
    // the destination is always behind `--`
    let ok = plain_master(&spec("bastion.example.com")).unwrap();
    assert_eq!(&ok[ok.len() - 2..], ["--", "bastion.example.com"]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Secrets never reach an argv or an environment
// ---------------------------------------------------------------------------------------------------------------------

fn random_secret(state: &mut u64) -> String {
    const CH: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_{|}~";
    (0..24)
        .map(|_| {
            *state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            CH[((*state >> 33) as usize) % CH.len()] as char
        })
        .collect()
}

#[test]
fn no_random_secret_substring_appears_in_any_argv_or_env() {
    let mut st = 0xC0FFEEu64;
    for round in 0..40 {
        let tmp = tmpdir();
        let j = jail(NetworkPolicy::Full, tmp.path());
        let secret = random_secret(&mut st);
        let mut s = spec("bastion.example.com");
        s.auth = if round % 2 == 0 { TunnelAuth::Password } else { TunnelAuth::KeyFile };
        if s.auth == TunnelAuth::KeyFile {
            s.key_file = Some("/keys/id_ed25519".into());
        }
        let kind = match s.auth {
            TunnelAuth::Password => AskpassKind::Password { user: "alice".into(), host: "bastion.example.com".into() },
            _ => AskpassKind::KeyPassphrase { key_path: "/keys/id_ed25519".into() },
        };
        let setup = askpass::install(&j, tmp.path(), &kind).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let h = askpass::spawn_writer(setup.fifo_path(), &Secret::new(secret.clone()), Duration::from_secs(5), cancel.clone()).unwrap();
        let mut hay: Vec<String> = ssh::master_argv(&MasterParams {
            spec: &s,
            control: &tmp.path().join("c"),
            app_known_hosts: &tmp.path().join("kh"),
            home_known_hosts: None,
            connect_timeout_s: 10,
            policy: NetworkPolicy::Full,
            has_secret: true,
        })
        .unwrap();
        hay.extend(ssh::stream_argv(&s, &tmp.path().join("c"), NetworkPolicy::Full, "db.internal", 27017).unwrap());
        hay.extend(ssh::ssh_g_argv(&s, NetworkPolicy::Full).unwrap());
        for (k, v) in ssh::ssh_env(&env_inputs("/home/u"), s.auth, Some(&setup)).into_iter().chain(ssh::base_env(&env_inputs("/home/u"))) {
            hay.push(k);
            hay.push(v);
        }
        for a in &hay {
            assert!(!a.contains(&secret), "secret leaked into {a:?}");
        }
        cancel.store(true, Ordering::SeqCst);
        assert!(matches!(h.join().unwrap(), FifoOutcome::Cancelled | FifoOutcome::Delivered));
    }
}

#[test]
fn the_environment_is_rebuilt_from_nothing() {
    let i = env_inputs("/Users/u");
    let keys = |auth, ask: Option<&askpass::AskpassSetup>| -> BTreeSet<String> { ssh::ssh_env(&i, auth, ask).into_iter().map(|(k, _)| k).collect() };
    let set = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<BTreeSet<_>>();
    assert_eq!(keys(TunnelAuth::Agent, None), set(&["HOME", "USER", "LOGNAME", "PATH", "LANG", "SSH_AUTH_SOCK"]));
    // the agent socket is for agent sign-in only
    assert_eq!(keys(TunnelAuth::Password, None), set(&["HOME", "USER", "LOGNAME", "PATH", "LANG"]));
    assert_eq!(keys(TunnelAuth::KeyFile, None), set(&["HOME", "USER", "LOGNAME", "PATH", "LANG"]));
    let env = ssh::ssh_env(&i, TunnelAuth::Agent, None);
    assert!(env.contains(&("PATH".into(), "/usr/bin:/bin".into())) && env.contains(&("LANG".into(), "C".into())));
    let setup = askpass::AskpassSetup { dir: "/t/d".into(), prompt: "P: ".into(), alt_prompt: Some("Password: ".into()) };
    let with = ssh::ssh_env(&i, TunnelAuth::Password, Some(&setup));
    for (k, v) in [
        ("SSH_ASKPASS", "/t/d/askpass"),
        ("SSH_ASKPASS_REQUIRE", "force"),
        ("DISPLAY", ":0"),
        ("INTELY_ASKPASS_DIR", "/t/d"),
        ("INTELY_ASKPASS_PROMPT", "P: "),
        ("INTELY_ASKPASS_PROMPT_ALT", "Password: "),
    ] {
        assert!(with.contains(&(k.to_string(), v.to_string())), "{k}");
    }
    // a NUL in a value would make the spawn fail: it is dropped
    let nul = EnvInputs { home: "/a\0b".into(), user: "u".into(), auth_sock: None };
    assert!(ssh::base_env(&nul).contains(&("HOME".into(), "/ab".into())));
}

// ---------------------------------------------------------------------------------------------------------------------
// Askpass
// ---------------------------------------------------------------------------------------------------------------------

const FROZEN_SCRIPT: &str = "#!/bin/sh\nif [ -n \"$INTELY_ASKPASS_PROMPT\" ] && [ \"$1\" = \"$INTELY_ASKPASS_PROMPT\" ]; then\n  exec /bin/cat \"$INTELY_ASKPASS_DIR/s\" 2>/dev/null\nfi\nif [ -n \"$INTELY_ASKPASS_PROMPT_ALT\" ] && [ \"$1\" = \"$INTELY_ASKPASS_PROMPT_ALT\" ]; then\n  exec /bin/cat \"$INTELY_ASKPASS_DIR/s\" 2>/dev/null\nfi\nexit 1\n";

#[test]
fn the_askpass_script_content_is_frozen() {
    assert_eq!(askpass::SCRIPT, FROZEN_SCRIPT);
}

#[test]
fn prompt_strings_and_which_auth_needs_askpass() {
    assert_eq!(askpass::key_passphrase_prompt("/k/id"), "Enter passphrase for key '/k/id': ");
    assert_eq!(askpass::password_prompt("alice", "127.0.0.1"), "alice@127.0.0.1's password: ");
    assert_eq!(askpass::KBDINT_PROMPT, "Password: ");
    assert!(!askpass::needs_askpass(TunnelAuth::Agent, true));
    assert!(!askpass::needs_askpass(TunnelAuth::KeyFile, false));
    assert!(askpass::needs_askpass(TunnelAuth::KeyFile, true));
    assert!(askpass::needs_askpass(TunnelAuth::Password, true));
}

fn run_askpass(setup: &askpass::AskpassSetup, prompt: &str) -> (Option<i32>, String) {
    let o = std::process::Command::new(setup.script_path()).arg(prompt).env_clear().envs(setup.env()).stdin(std::process::Stdio::null()).output().unwrap();
    (o.status.code(), String::from_utf8_lossy(&o.stdout).into_owned())
}

fn installed(kind: &AskpassKind) -> (tempfile::TempDir, askpass::AskpassSetup) {
    let tmp = tmpdir();
    let setup = askpass::install(&jail(NetworkPolicy::Full, tmp.path()), tmp.path(), kind).unwrap();
    (tmp, setup)
}

fn key_kind() -> AskpassKind {
    AskpassKind::KeyPassphrase { key_path: "/keys/id".into() }
}

fn writer(setup: &askpass::AskpassSetup, secret: &str, ms: u64) -> std::thread::JoinHandle<FifoOutcome> {
    askpass::spawn_writer(setup.fifo_path(), &Secret::new(secret), Duration::from_millis(ms), Arc::new(AtomicBool::new(false))).unwrap()
}

#[test]
fn the_exact_prompt_releases_the_secret_once_and_the_fifo_is_gone_afterwards() {
    let (tmp, setup) = installed(&key_kind());
    // exactly the script and one FIFO, with the right modes
    let mut names: Vec<String> = std::fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    assert_eq!(names, ["askpass", "s"]);
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(setup.script_path()).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(std::fs::metadata(setup.fifo_path()).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::read_to_string(setup.script_path()).unwrap(), askpass::SCRIPT);
    // a second FIFO in the same directory is refused
    assert!(askpass::install(&jail(NetworkPolicy::Full, tmp.path()), tmp.path(), &key_kind()).is_err());

    let h = writer(&setup, "pa ss$word", 10_000);
    let (status, stdout) = run_askpass(&setup, &askpass::key_passphrase_prompt("/keys/id"));
    assert_eq!((status, stdout.as_str()), (Some(0), "pa ss$word"));
    assert_eq!(h.join().unwrap(), FifoOutcome::Delivered);
    assert!(!setup.fifo_path().exists(), "the FIFO is unlinked after one read");
    // "asks twice": the second prompt (a wrong password) finds nothing
    let (status, stdout) = run_askpass(&setup, &askpass::key_passphrase_prompt("/keys/id"));
    assert_eq!((status, stdout.as_str()), (Some(1), ""));
}

#[test]
fn only_the_exact_prompt_is_answered_and_a_wrong_one_leaves_the_fifo_for_the_deadline() {
    let (_tmp, setup) = installed(&key_kind());
    let h = writer(&setup, "topsecret", 600);
    for wrong in [
        "alice@passphrase.example.com's password: ",
        "Password: ",
        "password: ",
        "Enter passphrase for key '/keys/id':",
        "Enter passphrase for key '/keys/id': x",
        "x Enter passphrase for key '/keys/id': ",
        "Enter passphrase for key '/other/id': ",
        "Enter passphrase for key",
        "Verification code: ",
        "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
        "Enter PIN for ED25519-SK key: ",
        "",
    ] {
        let (status, stdout) = run_askpass(&setup, wrong);
        assert_eq!((status, stdout.as_str()), (Some(1), ""), "prompt {wrong:?}");
    }
    // nobody read the FIFO: the writer gives up at the deadline and removes it
    assert_eq!(h.join().unwrap(), FifoOutcome::TimedOut);
    assert!(!setup.fifo_path().exists());
}

#[test]
fn password_auth_accepts_its_prompt_and_the_exact_keyboard_interactive_string_only() {
    let kind = AskpassKind::Password { user: "alice".into(), host: "passphrase.example.com".into() };
    let (_t, setup) = installed(&kind);
    assert_eq!(setup.prompt, "alice@passphrase.example.com's password: ");
    assert_eq!(setup.alt_prompt.as_deref(), Some("Password: "));
    // a host named like a passphrase prompt gives nothing to the wrong prompts
    let w = writer(&setup, "pw1", 400);
    assert_eq!(run_askpass(&setup, "Enter passphrase for key '/keys/id': ").0, Some(1));
    assert_eq!(run_askpass(&setup, "Password:").0, Some(1));
    assert_eq!(run_askpass(&setup, "Password: x").0, Some(1));
    assert_eq!(w.join().unwrap(), FifoOutcome::TimedOut);
    // the keyboard-interactive string is accepted (fresh FIFO: it is single-use)
    let (_t2, setup2) = installed(&kind);
    let w = writer(&setup2, "pw2", 10_000);
    assert_eq!(run_askpass(&setup2, "Password: "), (Some(0), "pw2".to_string()));
    assert_eq!(w.join().unwrap(), FifoOutcome::Delivered);
    // the password prompt itself works too
    let (_t4, setup4) = installed(&kind);
    let w = writer(&setup4, "pw4", 10_000);
    assert_eq!(run_askpass(&setup4, "alice@passphrase.example.com's password: "), (Some(0), "pw4".to_string()));
    assert_eq!(w.join().unwrap(), FifoOutcome::Delivered);
    // a key-passphrase setup does not accept "Password: " at all
    let (_t3, setup3) = installed(&key_kind());
    assert_eq!(setup3.alt_prompt, None);
    assert_eq!(run_askpass(&setup3, "Password: ").0, Some(1));
}

#[test]
fn the_fifo_writer_honours_cancel_and_the_deadline_and_ssh_never_asking() {
    let (_t, setup) = installed(&key_kind());
    let cancel = Arc::new(AtomicBool::new(false));
    let start = std::time::Instant::now();
    let h = askpass::spawn_writer(setup.fifo_path(), &Secret::new("x"), Duration::from_secs(30), cancel.clone()).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    cancel.store(true, Ordering::SeqCst);
    assert_eq!(h.join().unwrap(), FifoOutcome::Cancelled);
    assert!(start.elapsed() < Duration::from_secs(5));
    assert!(!setup.fifo_path().exists());
    // "ssh never asks": a short deadline ends the thread without a reader
    let (_t2, setup2) = installed(&key_kind());
    assert_eq!(writer(&setup2, "x", 150).join().unwrap(), FifoOutcome::TimedOut);
    // a vanished FIFO is a failure, not a spin
    assert_eq!(writer(&setup2, "x", 5_000).join().unwrap(), FifoOutcome::Failed);
}

#[test]
fn unusable_secrets_and_dirs_are_refused() {
    let (_t, setup) = installed(&key_kind());
    let long = "x".repeat(1001);
    for bad in ["", "a\nb", "a\rb", "a\0b", long.as_str()] {
        assert!(askpass::check_secret(&Secret::new(bad)).is_err(), "{bad:?}");
        assert!(askpass::spawn_writer(setup.fifo_path(), &Secret::new(bad), Duration::from_millis(10), Arc::new(AtomicBool::new(false))).is_err());
    }
    assert!(askpass::check_secret(&Secret::new("x".repeat(1000))).is_ok());
    // a world-readable directory is not a private tunnel directory
    let open = tmpdir();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(open.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(askpass::install(&jail(NetworkPolicy::Full, open.path()), open.path(), &key_kind()).is_err());
    assert!(!open.path().join("askpass").exists());
    // a missing directory
    assert!(askpass::install(&jail(NetworkPolicy::Full, open.path()), &open.path().join("nope"), &key_kind()).is_err());
}

#[test]
fn askpass_writes_are_jail_gated() {
    let tmp = tmpdir();
    // READONLY: nothing is created
    let e = askpass::install(&jail(NetworkPolicy::Refused, tmp.path()), tmp.path(), &key_kind()).unwrap_err();
    assert_eq!(e.code, code::READ_ONLY_JAIL);
    assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
    // E2E: only below the temp or fixture root
    let other = tmpdir();
    let elsewhere = Jail::new(NetworkPolicy::LoopbackOnly, other.path(), None);
    let e = askpass::install(&elsewhere, tmp.path(), &key_kind()).unwrap_err();
    assert_eq!(e.code, code::TEST_JAIL);
    assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
    assert!(askpass::install(&jail(NetworkPolicy::LoopbackOnly, tmp.path()), tmp.path(), &key_kind()).is_ok());
}

// ---------------------------------------------------------------------------------------------------------------------
// Known hosts
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn base64_roundtrips_and_rejects_non_canonical_input() {
    for n in 1..40usize {
        let data: Vec<u8> = (0..n as u8).map(|b| b.wrapping_mul(37).wrapping_add(11)).collect();
        let padded = knownhosts::b64_encode(&data, true);
        assert_eq!(knownhosts::b64_decode(&padded).unwrap(), data, "n={n}");
    }
    assert_eq!(knownhosts::b64_encode(b"hello", true), "aGVsbG8=");
    assert_eq!(knownhosts::b64_encode(b"hello", false), "aGVsbG8");
    for bad in ["", "aGVsbG8", "aGVsbG9=", "aGV sbG8=", "aGVsbG8==", "a===", "aGVs\nbG8=", "====", "aGVsbG8-"] {
        assert!(knownhosts::b64_decode(bad).is_none(), "{bad:?}");
    }
}

#[test]
fn keys_are_validated_and_fingerprinted() {
    let k = ed_key(1);
    let p = knownhosts::parse_key(&k.0, &k.1).unwrap();
    assert!(p.fingerprint.starts_with("SHA256:") && p.fingerprint.len() == 7 + 43);
    assert_eq!(p, scanned(&k));
    // a different key type than the blob says, an unknown type, bad base64, a truncated blob
    assert!(knownhosts::parse_key("ssh-rsa", &k.1).is_none());
    assert!(knownhosts::parse_key("ssh-dss", &k.1).is_none());
    assert!(knownhosts::parse_key("ssh-ed25519", "not base64!").is_none());
    assert!(knownhosts::parse_key("ssh-ed25519", &knownhosts::b64_encode(&[0, 0, 0, 11, b's'], true)).is_none());
    assert!(knownhosts::parse_key("ssh-ed25519", &"A".repeat(9000)).is_none());
    // different keys, different fingerprints
    assert_ne!(scanned(&ed_key(1)).fingerprint, scanned(&ed_key(2)).fingerprint);
}

#[test]
fn the_fingerprint_equals_what_the_real_ssh_keygen_prints() {
    if !real_keygen_available() {
        return skip("/usr/bin/ssh-keygen not found");
    }
    let tmp = tmpdir();
    let key = tmp.path().join("k");
    let st = std::process::Command::new("/usr/bin/ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-C", "t", "-f"]).arg(&key).env_clear().env("HOME", tmp.path()).status().unwrap();
    assert!(st.success());
    let pubtext = std::fs::read_to_string(key.with_extension("pub")).unwrap();
    let f: Vec<&str> = pubtext.split_whitespace().collect();
    let ours = knownhosts::parse_key(f[0], f[1]).unwrap().fingerprint;
    let o = std::process::Command::new("/usr/bin/ssh-keygen").arg("-lf").arg(key.with_extension("pub")).env_clear().env("HOME", tmp.path()).output().unwrap();
    let printed = String::from_utf8_lossy(&o.stdout);
    assert!(printed.contains(&ours), "ssh-keygen printed {printed:?}, we computed {ours}");
}

#[test]
fn scan_and_known_entries_parsing_ignores_comments_markers_and_garbage() {
    let (a, b) = (ed_key(1), ed_key(2));
    let text = format!("# bastion:22 SSH-2.0-OpenSSH_9\n{}{}nonsense\nh ssh-dss AAAA\n@revoked [h]:22 {} {}\n", scan_line("h", &a), scan_line("h", &a), b.0, b.1);
    let keys = knownhosts::parse_keyscan(&text);
    assert_eq!(keys.len(), 1, "duplicates collapse, unknown types and markers are dropped");
    assert_eq!(keys[0], scanned(&a));
    let entries = knownhosts::parse_known_entries(&format!("# Host h found: line 1\n|1|salt=|hash= {} {}\n@cert-authority * {} {}\n", a.0, a.1, b.0, b.1));
    assert_eq!(entries, vec![scanned(&a)], "hashed entries parse, markers never count");
}

#[test]
fn the_known_hosts_line_builder_rebuilds_the_line_from_validated_parts() {
    let k = ed_key(3);
    assert_eq!(knownhosts::known_hosts_line("Bastion.Example.com", 22, &k.0, &k.1).unwrap(), format!("bastion.example.com {} {}\n", k.0, k.1));
    assert_eq!(knownhosts::known_hosts_line("127.0.0.1", 2222, &k.0, &k.1).unwrap(), format!("[127.0.0.1]:2222 {} {}\n", k.0, k.1));
    for host in ["*", "*.example.com", "a?b", "!a", "a,b", "|1|x", "@cert-authority", "a b", "a\nb", "[::1]", "", "-h"] {
        assert!(knownhosts::known_hosts_line(host, 22, &k.0, &k.1).is_err(), "host {host:?}");
    }
    assert!(knownhosts::known_hosts_line("h", 0, &k.0, &k.1).is_err());
    assert!(knownhosts::known_hosts_line("h", 22, "@cert-authority", &k.1).is_err());
    assert!(knownhosts::known_hosts_line("h", 22, "ssh-ed25519 extra", &k.1).is_err());
    assert!(knownhosts::known_hosts_line("h", 22, &k.0, "AAAA\nssh-rsa AAAA").is_err());
    // base64 is re-encoded and validated: a truncated spelling is refused rather than copied
    assert!(knownhosts::known_hosts_line("h", 22, &k.0, &k.1[..k.1.len() - 1]).is_err());
}

#[test]
fn the_status_table_and_changed_never_allows_trust() {
    let (a, b) = (scanned(&ed_key(1)), scanned(&ed_key(2)));
    use HostKeyStatus::*;
    assert_eq!(knownhosts::classify_status(&[], &[a.clone()]), Unknown);
    assert_eq!(knownhosts::classify_status(&[a.clone()], &[a.clone()]), Known);
    assert_eq!(knownhosts::classify_status(&[b.clone(), a.clone()], &[a.clone()]), Known);
    assert_eq!(knownhosts::classify_status(&[b.clone()], &[a.clone()]), Changed);
    let rsa_blob = {
        let mut v = vec![0, 0, 0, 7];
        v.extend_from_slice(b"ssh-rsa");
        v.extend_from_slice(&[0, 0, 0, 1, 3, 0, 0, 0, 1, 7]);
        v
    };
    let rsa = knownhosts::parse_key("ssh-rsa", &knownhosts::b64_encode(&rsa_blob, true)).unwrap();
    assert_eq!(knownhosts::classify_status(&[rsa], &[a.clone()]), Changed, "an entry of another type does not make a new type known");
    assert!(knownhosts::trust_allowed(Unknown));
    assert!(!knownhosts::trust_allowed(Changed));
    assert_eq!(knownhosts::host_pattern("H", 22), "h");
    assert_eq!(knownhosts::host_pattern("h", 2222), "[h]:2222");
    let files = knownhosts::known_files(Path::new("/s/kh"), Some(Path::new("/h/kh")), false);
    assert_eq!(files, [PathBuf::from("/s/kh"), PathBuf::from("/h/kh")]);
    assert_eq!(knownhosts::known_files(Path::new("/s/kh"), Some(Path::new("/h/kh")), true), [PathBuf::from("/s/kh")]);
}

// ---------------------------------------------------------------------------------------------------------------------
// ssh -G, scan, inspect, trust, forget (fake runner)
// ---------------------------------------------------------------------------------------------------------------------

fn g_output(host: &str, port: u16, extra: &str) -> String {
    format!("user alice\nhostname {host}\nport {port}\n{extra}identityfile ~/.ssh/id_ed25519\n")
}

#[test]
fn ssh_g_output_is_parsed_and_proxy_hops_make_the_bastion_unscannable() {
    let r = ssh::parse_ssh_g(&g_output("Bastion.Example.com", 2200, "")).unwrap();
    assert_eq!((r.hostname.as_str(), r.port, r.user.as_str()), ("bastion.example.com", 2200, "alice"));
    assert!(r.scannable());
    assert!(!ssh::parse_ssh_g(&g_output("h", 22, "proxyjump other\n")).unwrap().scannable());
    assert!(!ssh::parse_ssh_g(&g_output("h", 22, "proxycommand nc %h %p\n")).unwrap().scannable());
    assert!(ssh::parse_ssh_g(&g_output("h", 22, "proxycommand none\nproxyjump none\n")).unwrap().scannable());
    for bad in ["user a\nport 22\n", "user a\nhostname h h\nport 22\n", "user a\nhostname h\nport 0\n", "user a\nhostname -oX\nport 22\n", "hostname h\nport 22\n", ""] {
        assert!(ssh::parse_ssh_g(bad).is_err(), "{bad:?}");
    }
}

struct World {
    tmp: tempfile::TempDir,
    app_file: PathBuf,
    /// The key the fake `ssh-keyscan` returns.
    hk: Arc<Mutex<(String, String)>>,
}

fn world() -> World {
    let tmp = tmpdir();
    let app_file = tmp.path().join("mongo_known_hosts");
    World { tmp, app_file, hk: Arc::new(Mutex::new(ed_key(1))) }
}

/// A fake `ssh -G` and `ssh-keyscan` (it returns `w.hk`), and either the real `ssh-keygen` (`real_keygen`) or a fake that
/// reports "no entry".
fn runner(w: &World, real_keygen: bool, g: String) -> FnRunner {
    let hk = w.hk.clone();
    FnRunner::new(move |name, args, stdin| match name {
        "ssh" => Some(out(0, &g)),
        "ssh-keyscan" => {
            let k = hk.lock().unwrap().clone();
            Some(out(0, &format!("# h:22 SSH-2.0-Fake\n{}", scan_line("h", &k))))
        }
        "ssh-keygen" if real_keygen => SystemRunner.run(&RunRequest { program: Path::new("/usr/bin/ssh-keygen"), args, env: &[("HOME".into(), "/nonexistent".into())], stdin, timeout: Duration::from_secs(5) }).ok(),
        "ssh-keygen" => Some(out(1, "")),
        _ => None,
    })
}

/// Fake tools where `ssh-keygen -F` reports `entry` for the host and the scan returns key 1.
fn entry_runner(entry: (String, String)) -> FnRunner {
    FnRunner::new(move |name, args, _| match name {
        "ssh" => Some(out(0, &g_output("h", 22, ""))),
        "ssh-keyscan" => Some(out(0, &scan_line("h", &ed_key(1)))),
        "ssh-keygen" => {
            assert_eq!(args[0], "-F");
            Some(out(0, &format!("# Host h found: line 1\n{}", scan_line("h", &entry))))
        }
        _ => None,
    })
}

fn ctx_with<'a>(r: &'a FnRunner, b: &'a SshBinary, j: &'a Jail, env: &'a [(String, String)]) -> SshCtx<'a> {
    SshCtx { runner: r, bin: b, jail: j, env }
}

#[test]
fn inspect_resolves_scans_and_looks_the_resolved_host_up() {
    let w = world();
    let j = jail(NetworkPolicy::Full, w.tmp.path());
    let r = runner(&w, false, g_output("real-host.example.com", 2200, ""));
    let b = bin();
    let env = ssh::base_env(&env_inputs("/h"));
    let rep = knownhosts::inspect_host_key(&ctx_with(&r, &b, &j, &env), &spec("alias"), &w.app_file, Some(Path::new("/h/.ssh/known_hosts"))).unwrap();
    assert_eq!(rep.status, HostKeyStatus::Unknown);
    assert_eq!(rep.keys.len(), 1);
    assert_eq!((rep.keys[0].host.as_str(), rep.keys[0].port, rep.keys[0].key_type.as_str()), ("real-host.example.com", 2200, "ssh-ed25519"));
    assert_eq!(rep.keys[0].fingerprint, scanned(&ed_key(1)).fingerprint);
    let log = r.log();
    // the resolved name and port are scanned and looked up, never the alias; both known_hosts files are consulted
    assert_eq!(log[0], "ssh -G -p 2222 -l alice -- alias");
    assert!(log.iter().any(|l| l == "ssh-keyscan -T 5 -p 2200 -t ed25519,ecdsa,rsa -- real-host.example.com"), "{log:?}");
    assert!(log.iter().any(|l| l.starts_with("ssh-keygen -F [real-host.example.com]:2200 -f ") && l.ends_with("mongo_known_hosts")), "{log:?}");
    assert!(log.iter().any(|l| l.ends_with("-f /h/.ssh/known_hosts")), "{log:?}");
    // a bastion behind a hop cannot be scanned
    let r2 = runner(&w, false, g_output("h", 22, "proxyjump hop\n"));
    let e = knownhosts::inspect_host_key(&ctx_with(&r2, &b, &j, &env), &spec("alias"), &w.app_file, None).unwrap_err();
    assert_eq!(e.code, code::HOST_KEY);
    assert!(e.message.starts_with("tunnel.hostKeyUnscannable:"), "{}", e.message);
    assert!(!r2.log().iter().any(|l| l.starts_with("ssh-keyscan")), "no scan of an unscannable host");
}

#[test]
fn status_comes_from_the_keygen_lookup_not_from_ssh_stderr() {
    let w = world();
    let j = jail(NetworkPolicy::Full, w.tmp.path());
    let b = bin();
    let env = ssh::base_env(&env_inputs("/h"));
    let rk = entry_runner(ed_key(1));
    let rep = knownhosts::inspect_host_key(&ctx_with(&rk, &b, &j, &env), &spec("h"), &w.app_file, None).unwrap();
    assert_eq!(rep.status, HostKeyStatus::Known);
    let rc = entry_runner(ed_key(9));
    let rep = knownhosts::inspect_host_key(&ctx_with(&rc, &b, &j, &env), &spec("h"), &w.app_file, None).unwrap();
    assert_eq!(rep.status, HostKeyStatus::Changed);
    assert!(rep.keys.iter().all(|k| k.status == HostKeyStatus::Changed));
}

#[test]
fn trust_appends_a_rebuilt_line_after_a_matching_rescan_and_never_for_a_changed_key() {
    let w = world();
    let j = jail(NetworkPolicy::Full, w.tmp.path());
    let b = bin();
    let env = ssh::base_env(&env_inputs("/h"));
    let r = runner(&w, false, g_output("h", 22, ""));
    let fp = scanned(&ed_key(1)).fingerprint;
    let files = vec![w.app_file.clone()];
    // a confirmation for another fingerprint is refused (the server no longer offers it) and nothing is written
    let e = knownhosts::trust_host_key(&ctx_with(&r, &b, &j, &env), "127.0.0.1", 2222, &scanned(&ed_key(5)).fingerprint, &w.app_file, &files).unwrap_err();
    assert!(e.message.starts_with("tunnel.hostKeyChanged:"), "{}", e.message);
    assert!(!w.app_file.exists());
    // malformed requests
    for (h, p, f) in [("*", 22u16, fp.as_str()), ("h", 0, fp.as_str()), ("h", 22, "SHA256:short"), ("h", 22, "MD5:aa")] {
        assert!(knownhosts::trust_host_key(&ctx_with(&r, &b, &j, &env), h, p, f, &w.app_file, &files).is_err(), "{h} {p} {f}");
    }
    // the real thing
    knownhosts::trust_host_key(&ctx_with(&r, &b, &j, &env), "127.0.0.1", 2222, &fp, &w.app_file, &files).unwrap();
    let key = ed_key(1);
    assert_eq!(std::fs::read_to_string(&w.app_file).unwrap(), format!("[127.0.0.1]:2222 {} {}\n", key.0, key.1));
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(&w.app_file).unwrap().permissions().mode() & 0o777, 0o600);
    // Changed: an entry exists for the host and differs. The fake keygen reports it; the trust is refused, file untouched.
    let before = std::fs::read_to_string(&w.app_file).unwrap();
    let changed = entry_runner(ed_key(9));
    let e = knownhosts::trust_host_key(&ctx_with(&changed, &b, &j, &env), "127.0.0.1", 2222, &fp, &w.app_file, &files).unwrap_err();
    assert_eq!(e.code, code::HOST_KEY);
    assert!(e.message.starts_with("tunnel.hostKeyChanged:"), "{}", e.message);
    assert_eq!(std::fs::read_to_string(&w.app_file).unwrap(), before);
    // Known already: a no-op
    let known = entry_runner(ed_key(1));
    knownhosts::trust_host_key(&ctx_with(&known, &b, &j, &env), "127.0.0.1", 2222, &fp, &w.app_file, &files).unwrap();
    assert_eq!(std::fs::read_to_string(&w.app_file).unwrap(), before);
}

#[test]
fn trust_caps_the_file_and_repairs_a_missing_final_newline() {
    let w = world();
    let j = jail(NetworkPolicy::Full, w.tmp.path());
    let b = bin();
    let env = ssh::base_env(&env_inputs("/h"));
    let r = runner(&w, false, g_output("h", 22, ""));
    let fp = scanned(&ed_key(1)).fingerprint;
    let line = scan_line("[other]:22", &ed_key(4));
    std::fs::write(&w.app_file, line.repeat(knownhosts::MAX_ENTRIES)).unwrap();
    let e = knownhosts::trust_host_key(&ctx_with(&r, &b, &j, &env), "127.0.0.1", 22, &fp, &w.app_file, &[]).unwrap_err();
    assert_eq!(e.code, code::HOST_KEY);
    assert_eq!(std::fs::read_to_string(&w.app_file).unwrap().lines().count(), knownhosts::MAX_ENTRIES);
    std::fs::write(&w.app_file, "# comment without newline").unwrap();
    knownhosts::trust_host_key(&ctx_with(&r, &b, &j, &env), "127.0.0.1", 22, &fp, &w.app_file, &[]).unwrap();
    let text = std::fs::read_to_string(&w.app_file).unwrap();
    assert!(text.starts_with("# comment without newline\n127.0.0.1 ssh-ed25519 "), "{text:?}");
    // a symlink in place of the file is never followed
    let target = w.tmp.path().join("victim");
    std::fs::write(&target, "keep\n").unwrap();
    let link = w.tmp.path().join("link");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert!(knownhosts::trust_host_key(&ctx_with(&r, &b, &j, &env), "127.0.0.1", 22, &fp, &link, &[]).is_err());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep\n");
}

#[test]
fn a_real_keygen_finds_the_trusted_line_and_forget_removes_only_that_host() {
    if !real_keygen_available() {
        return skip("/usr/bin/ssh-keygen not found");
    }
    let w = world();
    let j = jail(NetworkPolicy::Full, w.tmp.path());
    let b = bin();
    let env = ssh::base_env(&env_inputs("/nonexistent"));
    let r = runner(&w, true, g_output("h", 22, ""));
    let ctx = ctx_with(&r, &b, &j, &env);
    let fp1 = scanned(&ed_key(1)).fingerprint;
    // trust two different hosts (2222 and the default port), with the real keygen doing the lookups
    knownhosts::trust_host_key(&ctx, "127.0.0.1", 2222, &fp1, &w.app_file, &[w.app_file.clone()]).unwrap();
    *w.hk.lock().unwrap() = ed_key(2);
    let fp2 = scanned(&ed_key(2)).fingerprint;
    knownhosts::trust_host_key(&ctx, "localhost", 22, &fp2, &w.app_file, &[w.app_file.clone()]).unwrap();
    // the status of each, via the real `ssh-keygen -F`
    let status = |host: &str, port: u16, key: u8| {
        let keys = vec![scanned(&ed_key(key))];
        let entries = knownhosts::lookup_entries(&ctx, &[w.app_file.clone()], host, port).unwrap();
        knownhosts::classify_status(&entries, &keys)
    };
    assert_eq!(status("127.0.0.1", 2222, 1), HostKeyStatus::Known);
    assert_eq!(status("127.0.0.1", 2222, 7), HostKeyStatus::Changed);
    assert_eq!(status("localhost", 22, 2), HostKeyStatus::Known);
    assert_eq!(status("nowhere", 22, 2), HostKeyStatus::Unknown);
    // forgetting needs the typed host
    let e = knownhosts::forget_host_key(&ctx, "127.0.0.1", 2222, "wrong", &w.app_file).unwrap_err();
    assert_eq!(e.code, code::CONFIRM);
    assert_eq!(status("127.0.0.1", 2222, 1), HostKeyStatus::Known);
    *w.hk.lock().unwrap() = ed_key(8);
    let rep = knownhosts::forget_host_key(&ctx, "127.0.0.1", 2222, "127.0.0.1", &w.app_file).unwrap();
    assert_eq!(rep.old, [fp1]);
    assert_eq!(rep.current, [scanned(&ed_key(8)).fingerprint]);
    assert_eq!(status("127.0.0.1", 2222, 1), HostKeyStatus::Unknown);
    assert_eq!(status("localhost", 22, 2), HostKeyStatus::Known, "the other host is untouched");
    assert!(!PathBuf::from(format!("{}.old", w.app_file.display())).exists(), "the ssh-keygen backup is removed");
}

#[test]
fn nothing_runs_and_nothing_is_written_under_the_read_only_jail() {
    let w = world();
    let j = jail(NetworkPolicy::Refused, w.tmp.path());
    let b = bin();
    let env = ssh::base_env(&env_inputs("/h"));
    let r = runner(&w, false, g_output("127.0.0.1", 22, ""));
    let ctx = ctx_with(&r, &b, &j, &env);
    let fp = scanned(&ed_key(1)).fingerprint;
    let s = spec("127.0.0.1");
    let refused = |e: intely_mongo::error::StudioError| assert_eq!(e.code, code::READ_ONLY_JAIL, "{e}");
    refused(ssh::resolve_host(&ctx, &s).unwrap_err());
    refused(knownhosts::scan_host_key(&ctx, "127.0.0.1", 22).unwrap_err());
    refused(knownhosts::lookup_entries(&ctx, &[w.app_file.clone()], "127.0.0.1", 22).unwrap_err());
    refused(knownhosts::inspect_host_key(&ctx, &s, &w.app_file, None).unwrap_err());
    refused(knownhosts::trust_host_key(&ctx, "127.0.0.1", 22, &fp, &w.app_file, &[]).unwrap_err());
    refused(knownhosts::forget_host_key(&ctx, "127.0.0.1", 22, "127.0.0.1", &w.app_file).unwrap_err());
    refused(bin().probe_version(&r, &j, &env).unwrap_err());
    assert_eq!(r.calls(), 0, "no child process started: {:?}", r.log());
    assert!(!w.app_file.exists());
}

#[test]
fn the_e2e_jail_allows_loopback_only_and_writes_below_its_root_only() {
    let w = world();
    let j = jail(NetworkPolicy::LoopbackOnly, w.tmp.path());
    let b = bin();
    let env = ssh::base_env(&env_inputs("/h"));
    let r = runner(&w, false, g_output("bastion.example.com", 22, ""));
    let ctx = ctx_with(&r, &b, &j, &env);
    let fp = scanned(&ed_key(1)).fingerprint;
    // a remote bastion is refused before any process
    assert_eq!(knownhosts::scan_host_key(&ctx, "bastion.example.com", 22).unwrap_err().code, code::TEST_JAIL);
    assert_eq!(knownhosts::trust_host_key(&ctx, "bastion.example.com", 22, &fp, &w.app_file, &[]).unwrap_err().code, code::TEST_JAIL);
    assert_eq!(ssh::resolve_host(&ctx, &spec("bastion.example.com")).unwrap_err().code, code::TEST_JAIL);
    assert_eq!(r.calls(), 0);
    // a loopback alias that `ssh -G` would map to a real host is refused too (the answer is re-checked)
    let e = ssh::resolve_host(&ctx, &spec("localhost")).unwrap_err();
    assert_eq!(e.code, code::TEST_JAIL);
    // the app file outside the jail's root is a write the jail refuses, before any process
    let elsewhere = std::env::temp_dir().join("intely-never-created").join("kh");
    let other = tmpdir();
    let j2 = Jail::new(NetworkPolicy::LoopbackOnly, other.path(), None);
    let ctx2 = ctx_with(&r, &b, &j2, &env);
    let before = r.calls();
    assert_eq!(knownhosts::trust_host_key(&ctx2, "127.0.0.1", 22, &fp, &w.app_file, &[]).unwrap_err().code, code::TEST_JAIL);
    assert_eq!(knownhosts::forget_host_key(&ctx2, "127.0.0.1", 22, "127.0.0.1", &elsewhere).unwrap_err().code, code::TEST_JAIL);
    assert_eq!(r.calls(), before);
}

// ---------------------------------------------------------------------------------------------------------------------
// stderr
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn stderr_is_sanitised_and_capped() {
    let raw = "ok\u{1b}[31m red\u{0}\r\nbidi \u{202E}evil\u{2066}x\u{2069} \u{200F}\u{061C}tab\there\n".as_bytes();
    let s = ssh::sanitize_stderr(raw);
    assert_eq!(s, "ok[31m red\nbidi evilx tab\there\n");
    let big = vec![b'a'; 100_000];
    assert_eq!(ssh::sanitize_stderr(&big).len(), 8 * 1024);
    // a multi-byte character cut at the cap does not panic
    let mut mb = vec![b'a'; 8 * 1024 - 1];
    mb.extend_from_slice("é".as_bytes());
    mb.extend_from_slice(b"tail");
    assert!(ssh::sanitize_stderr(&mb).starts_with("aaa"));
}

// ---------------------------------------------------------------------------------------------------------------------
// The real runner
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn the_system_runner_clears_the_environment_caps_output_and_kills_at_the_timeout() {
    let sh = Path::new("/bin/sh");
    if !sh.is_file() {
        return skip("/bin/sh not found");
    }
    let path = ("PATH".to_string(), "/usr/bin:/bin".to_string());
    let run = |script: &str, env: &[(String, String)], stdin: Option<&[u8]>, t: u64| {
        let args = vec!["-c".to_string(), script.to_string()];
        SystemRunner.run(&RunRequest { program: sh, args: &args, env, stdin, timeout: Duration::from_secs(t) }).unwrap()
    };
    std::env::set_var("INTELY_T4A_LEAK", "leak");
    let o = run("printf '%s|%s' \"${INTELY_T4A_LEAK-unset}\" \"$KEPT\"", &[("KEPT".into(), "yes".into())], None, 5);
    assert_eq!((o.code, String::from_utf8_lossy(&o.stdout).as_ref()), (Some(0), "unset|yes"));
    let o = run("cat", &[path.clone()], Some(b"piped in"), 5);
    assert_eq!(o.stdout, b"piped in");
    let o = run("head -c 600000 /dev/zero; head -c 20000 /dev/zero >&2; exit 3", &[path.clone()], None, 10);
    assert_eq!((o.code, o.stdout.len(), o.stderr.len()), (Some(3), 256 * 1024, 8 * 1024));
    let start = std::time::Instant::now();
    let o = run("exec sleep 30", &[path], None, 1);
    assert!(o.timed_out && o.code.is_none() && start.elapsed() < Duration::from_secs(10));
}

#[test]
fn the_real_home_known_hosts_is_never_touched() {
    // metadata only: the file's content is never read
    let Some(home) = std::env::var_os("HOME") else { return skip("no HOME") };
    let real = Path::new(&home).join(".ssh").join("known_hosts");
    let before = std::fs::metadata(&real).ok().map(|m| (m.len(), m.modified().ok()));
    let w = world();
    let j = jail(NetworkPolicy::Full, w.tmp.path());
    let b = bin();
    let env = ssh::base_env(&env_inputs(w.tmp.path().to_str().unwrap()));
    let r = runner(&w, real_keygen_available(), g_output("127.0.0.1", 22, ""));
    let fp = scanned(&ed_key(1)).fingerprint;
    let _ = knownhosts::trust_host_key(&ctx_with(&r, &b, &j, &env), "127.0.0.1", 22, &fp, &w.app_file, &[w.app_file.clone()]);
    let _ = knownhosts::forget_host_key(&ctx_with(&r, &b, &j, &env), "127.0.0.1", 22, "127.0.0.1", &w.app_file);
    let after = std::fs::metadata(&real).ok().map(|m| (m.len(), m.modified().ok()));
    assert_eq!(before, after);
}
