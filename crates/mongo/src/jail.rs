//! The IDE-wide test jails applied to the database client (docs/safety.md): `INTELY_READONLY` refuses every network
//! connection, `INTELY_E2E` (or an e2e script run) allows loopback only. Neither mutates anything here, but a database
//! connection is network, and a test or smoke run must never reach a real database through it.

use std::path::{Component, Path, PathBuf};

use crate::connspec::{ConnSpec, HostPort, Scheme, Tunnel};
use crate::error::{code, Result, StudioError};
use crate::host;
use crate::types::EffectiveLevel;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkPolicy {
    Full,
    LoopbackOnly,
    Refused,
}

impl NetworkPolicy {
    /// `var(name)` is true when the environment variable is set and not empty.
    pub fn from_env(var: impl Fn(&str) -> bool) -> Self {
        if var("INTELY_READONLY") {
            Self::Refused
        } else if var("INTELY_E2E") || var("INTELY_E2E_SCRIPT") {
            Self::LoopbackOnly
        } else {
            Self::Full
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::LoopbackOnly => "loopbackOnly",
            Self::Refused => "refused",
        }
    }

    /// Checked before any socket is opened. `level` is the host rule of the URI (not the tag).
    pub fn check(self, host_level: EffectiveLevel) -> Result<()> {
        match (self, host_level) {
            (Self::Full, _) | (Self::LoopbackOnly, EffectiveLevel::Local) => Ok(()),
            (Self::LoopbackOnly, EffectiveLevel::ProductionLevel) => Err(StudioError::new(code::TEST_JAIL, "the test jail allows loopback databases only")),
            (Self::Refused, _) => Err(StudioError::new(code::READ_ONLY_JAIL, "the read-only jail refuses database connections")),
        }
    }
}

impl NetworkPolicy {
    /// [`check`](Self::check) for a legacy connection string, which can also name a SOCKS5 proxy (`proxyHost`): the host
    /// rule only judges the seeds, and the driver would dial the proxy, so the test jail refuses every `proxy*` option.
    pub fn check_legacy_uri(self, host_level: EffectiveLevel, uri: &str) -> Result<()> {
        self.check(host_level)?;
        if self == Self::LoopbackOnly && host::legacy_policy(uri).options.iter().any(|o| o.starts_with("proxy")) {
            return Err(StudioError::new(code::TEST_JAIL, "the test jail allows loopback databases, bastions and proxies only"));
        }
        Ok(())
    }
}

fn loopback(h: &str) -> bool {
    host::is_loopback_host(&h.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase())
}

impl NetworkPolicy {
    /// Gates every outward path of the tunnel feature (tunnel open, host-key scan, local detection, SOCKS5 proxy, DNS
    /// lookup). `targets` are the database hosts the tunnel will be asked to reach. `Refused` refuses everything (no
    /// child process, no socket); `LoopbackOnly` allows loopback SSH hosts, loopback proxies and loopback-only targets;
    /// `Full` allows all.
    pub fn check_tunnel(self, tunnel: &Tunnel, targets: &[HostPort]) -> Result<()> {
        match self {
            Self::Full => Ok(()),
            Self::Refused => Err(StudioError::new(code::READ_ONLY_JAIL, "the read-only jail refuses database connections and tunnels")),
            Self::LoopbackOnly => {
                let endpoint_ok = match tunnel {
                    Tunnel::None => true,
                    Tunnel::Ssh(s) => loopback(&s.host) && s.allowed_hosts.iter().all(|a| loopback(&a.host)),
                    Tunnel::Socks5(p) => loopback(&p.host),
                };
                if endpoint_ok && targets.iter().all(|t| loopback(&t.host)) {
                    Ok(())
                } else {
                    Err(StudioError::new(code::TEST_JAIL, "the test jail allows loopback databases, bastions and proxies only"))
                }
            }
        }
    }

    /// [`check_tunnel`](Self::check_tunnel) for a whole spec. A `+srv` name is resolved on this computer, which the test
    /// jail does not allow.
    pub fn check_spec(self, spec: &ConnSpec) -> Result<()> {
        if self == Self::LoopbackOnly && spec.scheme == Scheme::Srv {
            return Err(StudioError::new(code::TEST_JAIL, "the test jail does not resolve SRV names"));
        }
        self.check_tunnel(&spec.tunnel, &spec.hosts)
    }
}

/// The jail for **writes** this feature makes (trusting or forgetting a host key, export, import, the tunnel directory,
/// the pid file, the orphan sweep). `INTELY_READONLY` refuses every one with `readOnly`; `INTELY_E2E` allows a write only
/// below the fixture root (when it is inside the temp directory) or the temp directory itself, `testJail` elsewhere.
#[derive(Debug, Clone)]
pub struct Jail {
    policy: NetworkPolicy,
    /// Canonical roots a write may land under in the E2E jail.
    roots: Vec<PathBuf>,
}

/// The longest existing ancestor made canonical (so `/var` and `/private/var` compare equal), then the rest appended.
fn canonical_lenient(p: &Path) -> PathBuf {
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p.to_path_buf();
    loop {
        if let Ok(c) = cur.canonicalize() {
            let mut out = c;
            for seg in rest.iter().rev() {
                out.push(seg);
            }
            return out;
        }
        match (cur.file_name().map(std::ffi::OsString::from), cur.parent().map(Path::to_path_buf)) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                cur = parent;
            }
            _ => return p.to_path_buf(),
        }
    }
}

impl Jail {
    pub fn new(policy: NetworkPolicy, temp_dir: &Path, fixture_root: Option<&Path>) -> Self {
        let temp = canonical_lenient(temp_dir);
        let mut roots = vec![temp.clone()];
        // a fixture root only counts inside the temp directory, as for the git jail
        if let Some(f) = fixture_root {
            let f = canonical_lenient(f);
            if f.starts_with(&temp) {
                // the tunnel directory lives in the temp directory, which holds the fixture root anyway
                roots = vec![f, temp.clone()];
            }
        }
        Self { policy, roots }
    }

    /// `var(name)` is true when the variable is set and not empty; `get(name)` returns its value.
    pub fn from_env(var: impl Fn(&str) -> bool, get: impl Fn(&str) -> Option<String>) -> Self {
        let root = get("INTELY_FIXTURE_ROOT").filter(|r| !r.is_empty()).map(PathBuf::from);
        Self::new(NetworkPolicy::from_env(var), &std::env::temp_dir(), root.as_deref())
    }

    pub fn policy(&self) -> NetworkPolicy {
        self.policy
    }

    pub fn check_write(&self, path: &Path) -> Result<()> {
        match self.policy {
            NetworkPolicy::Full => Ok(()),
            NetworkPolicy::Refused => Err(StudioError::new(code::READ_ONLY_JAIL, "the read-only jail refuses writes")),
            NetworkPolicy::LoopbackOnly => {
                // lexical `..` is refused outright: it could climb out of the root after canonicalisation of a prefix
                if path.components().any(|c| matches!(c, Component::ParentDir)) {
                    return Err(StudioError::new(code::TEST_JAIL, "the test jail allows writes below the fixture or temp directory only"));
                }
                let c = canonical_lenient(path);
                if self.roots.iter().any(|r| c.starts_with(r)) {
                    Ok(())
                } else {
                    Err(StudioError::new(code::TEST_JAIL, "the test jail allows writes below the fixture or temp directory only"))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_jail_modes_gate_the_network() {
        let env = |set: &'static [&'static str]| NetworkPolicy::from_env(move |v| set.contains(&v));
        assert_eq!(env(&[]), NetworkPolicy::Full);
        assert_eq!(env(&["INTELY_E2E"]), NetworkPolicy::LoopbackOnly);
        assert_eq!(env(&["INTELY_E2E_SCRIPT"]), NetworkPolicy::LoopbackOnly);
        assert_eq!(env(&["INTELY_E2E", "INTELY_READONLY"]), NetworkPolicy::Refused);
        assert!(NetworkPolicy::Full.check(EffectiveLevel::ProductionLevel).is_ok());
        assert!(NetworkPolicy::LoopbackOnly.check(EffectiveLevel::Local).is_ok());
        assert_eq!(NetworkPolicy::LoopbackOnly.check(EffectiveLevel::ProductionLevel).unwrap_err().code, code::TEST_JAIL);
        assert_eq!(NetworkPolicy::Refused.check(EffectiveLevel::Local).unwrap_err().code, code::READ_ONLY_JAIL);
    }

    fn ssh(host: &str) -> Tunnel {
        Tunnel::Ssh(crate::connspec::SshSpec { host: host.into(), user: "u".into(), ..Default::default() })
    }

    fn hp(h: &str) -> HostPort {
        HostPort { host: h.into(), port: Some(27017) }
    }

    #[test]
    fn legacy_uri_proxy_options_are_refused_under_the_test_jail() {
        let proxied = "mongodb://127.0.0.1:27017/?proxyHost=127.0.0.1&proxyPort=1080";
        assert_eq!(NetworkPolicy::LoopbackOnly.check_legacy_uri(EffectiveLevel::Local, proxied).unwrap_err().code, code::TEST_JAIL);
        assert!(NetworkPolicy::LoopbackOnly.check_legacy_uri(EffectiveLevel::Local, "mongodb://127.0.0.1:27017/x?tls=false").is_ok());
        assert_eq!(NetworkPolicy::Refused.check_legacy_uri(EffectiveLevel::Local, proxied).unwrap_err().code, code::READ_ONLY_JAIL);
        assert!(NetworkPolicy::Full.check_legacy_uri(EffectiveLevel::Local, proxied).is_ok());
    }

    #[test]
    fn check_tunnel_table() {
        use NetworkPolicy::*;
        let remote = [hp("db.example.com")];
        let local = [hp("127.0.0.1"), hp("localhost"), hp("[::1]")];
        let none = Tunnel::None;
        // Full allows everything
        assert!(Full.check_tunnel(&ssh("bastion.example.com"), &remote).is_ok());
        // Refused refuses everything, even loopback: no child process, no socket
        for t in [&none, &ssh("127.0.0.1"), &Tunnel::Socks5(crate::connspec::ProxySpec { host: "127.0.0.1".into(), port: 1, ..Default::default() })] {
            assert_eq!(Refused.check_tunnel(t, &local).unwrap_err().code, code::READ_ONLY_JAIL);
        }
        // LoopbackOnly: loopback bastion / proxy / targets only
        assert!(LoopbackOnly.check_tunnel(&none, &local).is_ok());
        assert!(LoopbackOnly.check_tunnel(&ssh("127.0.0.1"), &local).is_ok());
        assert!(LoopbackOnly.check_tunnel(&ssh("localhost"), &local).is_ok());
        assert!(LoopbackOnly.check_tunnel(&Tunnel::Socks5(crate::connspec::ProxySpec { host: "127.0.0.1".into(), port: 1080, ..Default::default() }), &local).is_ok());
        for (t, targets) in [(&none, &remote[..]), (&ssh("bastion.example.com"), &local[..]), (&ssh("127.0.0.1"), &remote[..]), (&Tunnel::Socks5(crate::connspec::ProxySpec { host: "proxy.example.com".into(), port: 1, ..Default::default() }), &local[..])] {
            assert_eq!(LoopbackOnly.check_tunnel(t, targets).unwrap_err().code, code::TEST_JAIL);
        }
        // a loopback bastion whose allow-list names a remote host is refused
        let Tunnel::Ssh(mut s) = ssh("127.0.0.1") else { unreachable!() };
        s.allowed_hosts.push(crate::connspec::AllowedHost { host: "db.example.com".into(), port: 27017 });
        assert!(LoopbackOnly.check_tunnel(&Tunnel::Ssh(s), &local).is_err());
    }

    #[test]
    fn check_spec_refuses_srv_under_the_test_jail() {
        let srv = ConnSpec { scheme: Scheme::Srv, hosts: vec![HostPort { host: "localhost".into(), port: None }], ..Default::default() };
        assert_eq!(NetworkPolicy::LoopbackOnly.check_spec(&srv).unwrap_err().code, code::TEST_JAIL);
        assert!(NetworkPolicy::Full.check_spec(&srv).is_ok());
        assert_eq!(NetworkPolicy::Refused.check_spec(&srv).unwrap_err().code, code::READ_ONLY_JAIL);
    }

    #[test]
    fn check_write_table() {
        let temp = tempfile::tempdir().unwrap();
        let fixture = temp.path().join("fixture");
        std::fs::create_dir_all(&fixture).unwrap();
        // READONLY refuses every write, even below the fixture
        let ro = Jail::new(NetworkPolicy::Refused, temp.path(), Some(&fixture));
        assert_eq!(ro.check_write(&fixture.join("a")).unwrap_err().code, code::READ_ONLY_JAIL);
        // E2E: only below the fixture root
        let e2e = Jail::new(NetworkPolicy::LoopbackOnly, temp.path(), Some(&fixture));
        assert!(e2e.check_write(&fixture.join("sub/new.json")).is_ok());
        assert!(e2e.check_write(&temp.path().join("elsewhere")).is_ok());
        assert_eq!(e2e.check_write(Path::new("/etc/hosts")).unwrap_err().code, code::TEST_JAIL);
        assert_eq!(e2e.check_write(&fixture.join("../escape")).unwrap_err().code, code::TEST_JAIL);
        // without a fixture root: the temp directory
        let tmp_only = Jail::new(NetworkPolicy::LoopbackOnly, temp.path(), None);
        assert!(tmp_only.check_write(&temp.path().join("x/y")).is_ok());
        assert!(tmp_only.check_write(Path::new("/Users")).is_err());
        // a fixture root outside the temp directory is ignored
        let out = Path::new("/usr/local/share/intely-fixture-outside-temp");
        let ignoring = Jail::new(NetworkPolicy::LoopbackOnly, temp.path(), Some(out));
        assert!(ignoring.check_write(&out.join("x")).is_err());
        // Full allows
        assert!(Jail::new(NetworkPolicy::Full, temp.path(), None).check_write(Path::new("/anywhere")).is_ok());
        // from_env wiring
        let env = |k: &str| k == "INTELY_E2E";
        let get = |k: &str| (k == "INTELY_FIXTURE_ROOT").then(|| fixture.to_string_lossy().into_owned());
        assert_eq!(Jail::from_env(env, get).policy(), NetworkPolicy::LoopbackOnly);
    }
}
