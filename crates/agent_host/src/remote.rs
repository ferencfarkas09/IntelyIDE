//! Runs on servers (Settings > Servers): the servers the host may use, the policy's look at a server's files, and the folders of a run
//! there.
//!
//! A run on a server is the same run as one on this Mac: the same sidecar program speaks the same protocol, only through an `ssh`
//! pipe and with the Claude CLI and every tool call on the server. The permission broker stays in the IDE and judges the server's
//! paths through the sidecar's `fs/query` ([`RemoteFs`]); a decision that could not look at the files is denied, never guessed.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use intely_agent_core::policy::fsrpc::{FsTransport, RpcFs};
use intely_servers::{probe, remote_paths, RemotePaths, ServerCfg, ServerStatus, Ssh};
use serde_json::{json, Value};

/// The servers as the settings say right now.
pub type ServersSupplier = Arc<dyn Fn() -> Vec<ServerCfg> + Send + Sync>;

/// How long the answer of a probe is trusted when a run starts (a longer-lived answer is asked again).
pub const STATUS_TTL: Duration = Duration::from_secs(600);

/// How long a policy decision for a run on a server may take. Each look at a file is a round trip, so this is longer than the 2 s of a
/// run on this Mac; the sidecar on the server is told the same (`--policy-timeout`).
pub const REMOTE_POLICY_TIMEOUT_MS: u32 = 8000;

/// How long one `fs/query` may take.
pub const FS_QUERY_TIMEOUT: Duration = Duration::from_secs(5);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The servers, the way to reach them and what is known about each (the last probe).
pub struct ServerRegistry {
    servers: ServersSupplier,
    ssh: Ssh,
    app_version: String,
    statuses: Mutex<HashMap<String, (Instant, ServerStatus)>>,
}

/// Why a server cannot take a run now.
#[derive(Debug, Clone, PartialEq)]
pub enum NotReady {
    Unknown,
    Disabled(String),
    /// The probe's answer: unreachable, or something is missing.
    Status(Box<ServerStatus>, String),
}

impl NotReady {
    /// One sentence for the person who pressed Start.
    pub fn message(&self) -> String {
        match self {
            NotReady::Unknown => "this server is not in Settings > Servers any more".into(),
            NotReady::Disabled(name) => format!("{name} is switched off in Settings > Servers"),
            NotReady::Status(st, name) => {
                if !st.reachable {
                    return match &st.error {
                        Some(e) => match e.hint.as_deref().filter(|h| !h.is_empty()) {
                            Some(hint) => format!("{name} is not reachable: {} ({hint})", e.message),
                            None => format!("{name} is not reachable: {}", e.message),
                        },
                        None => format!("{name} is not reachable"),
                    };
                }
                let mut missing = Vec::new();
                if !st.node.ok {
                    missing.push("Node.js 24 or newer");
                }
                if st.claude.path.is_none() {
                    missing.push("Claude Code");
                }
                if st.git.path.is_none() {
                    missing.push("git");
                }
                if !st.bundle.ok {
                    missing.push("the IDE's agent files");
                }
                if !st.sdk.ok {
                    missing.push("the Agent SDK");
                }
                format!("{name} is not set up: {} missing. Use Settings > Servers > Set up", if missing.is_empty() { "something".to_string() } else { missing.join(", ") })
            }
        }
    }
}

impl ServerRegistry {
    pub fn new(servers: ServersSupplier, ssh: Ssh, app_version: impl Into<String>) -> Self {
        Self { servers, ssh, app_version: app_version.into(), statuses: Mutex::new(HashMap::new()) }
    }

    pub fn list(&self) -> Vec<ServerCfg> {
        (self.servers)()
    }

    pub fn cfg(&self, id: &str) -> Option<ServerCfg> {
        self.list().into_iter().find(|s| s.id == id)
    }

    pub fn ssh(&self) -> &Ssh {
        &self.ssh
    }

    pub fn app_version(&self) -> &str {
        &self.app_version
    }

    /// The last answer of a probe, however old.
    pub fn cached(&self, id: &str) -> Option<ServerStatus> {
        lock(&self.statuses).get(id).map(|(_, s)| s.clone())
    }

    pub fn set_status(&self, id: &str, status: ServerStatus) {
        lock(&self.statuses).insert(id.to_string(), (Instant::now(), status));
    }

    pub fn forget(&self, id: &str) {
        lock(&self.statuses).remove(id);
    }

    /// The server, its status and its paths, when it can take a run: a fresh answer of an earlier probe, otherwise one probe now (one
    /// `ssh` call, so this may take a few seconds).
    pub fn ready(&self, id: &str) -> Result<(ServerCfg, ServerStatus, RemotePaths), NotReady> {
        let cfg = self.cfg(id).ok_or(NotReady::Unknown)?;
        if !cfg.enabled {
            return Err(NotReady::Disabled(cfg.name));
        }
        let fresh = lock(&self.statuses).get(id).filter(|(at, st)| st.ready && at.elapsed() < STATUS_TTL).map(|(_, s)| s.clone());
        let status = match fresh {
            Some(s) => s,
            None => {
                let s = probe(&self.ssh, &cfg, &self.app_version);
                self.set_status(id, s.clone());
                s
            }
        };
        match remote_paths(&status, &cfg, &self.app_version) {
            Some(paths) => Ok((cfg, status, paths)),
            None => Err(NotReady::Status(Box::new(status), cfg.name)),
        }
    }
}

/// What a run's start needs of its server: the entry of the settings, where things are there, and the registry (for `ssh`).
pub struct RemoteEnv {
    pub cfg: ServerCfg,
    pub paths: RemotePaths,
    pub registry: Arc<ServerRegistry>,
}

/// A name the host puts on the server's disk: letters, digits, `.`, `_`, `-`; not empty, no leading dot (a hidden folder such as `.ssh`
/// would be the server's own) and no leading dash.
pub fn valid_dir_name(name: &str) -> bool {
    intely_servers::valid_repo_dir_name(name)
}

/// Where a local repository lives on a server: `<root>/<its folder name>`, with `~` of the root taken as the server's home.
pub fn remote_dir(cfg: &ServerCfg, home: &str, repo: &Path) -> Option<String> {
    let name = repo.file_name()?.to_str().filter(|n| valid_dir_name(n))?;
    let home = home.trim_end_matches('/');
    let root = if cfg.root == "~" {
        home.to_string()
    } else if let Some(rest) = cfg.root.strip_prefix("~/") {
        format!("{home}/{}", rest.trim_end_matches('/'))
    } else {
        cfg.root.trim_end_matches('/').to_string()
    };
    Some(format!("{root}/{name}"))
}

/// Sends `fs/query` down the sidecar of the server. A request that gets no usable answer (no sidecar, a timeout, an error reply, a
/// result list of the wrong length) is `None`; the view on top ([`RpcFs`]) tells the decision that used it, and the decision is denied.
pub struct SidecarFs {
    call: Box<dyn Fn(Value) -> Option<Value> + Send + Sync>,
}

impl SidecarFs {
    pub fn new(call: impl Fn(Value) -> Option<Value> + Send + Sync + 'static) -> Self {
        Self { call: Box::new(call) }
    }
}

impl FsTransport for SidecarFs {
    fn query(&self, ops: Vec<Value>) -> Option<Vec<Value>> {
        let n = ops.len();
        (self.call)(json!({"ops": ops})).and_then(|r| r.get("results").and_then(Value::as_array).cloned()).filter(|r| r.len() == n)
    }
}

/// The policy's view of a server's files.
pub type RemoteFs = RpcFs<SidecarFs>;

#[cfg(test)]
mod tests {
    use super::*;
    use intely_servers::ServerCfg;
    use std::path::PathBuf;

    fn cfg(root: &str) -> ServerCfg {
        ServerCfg { id: "build".into(), name: "Build server".into(), destination: "dev@build1".into(), port: None, root: root.into(), max_agents: 4, enabled: true }
    }

    #[test]
    fn a_repo_lives_under_the_root_of_the_server() {
        let repo = PathBuf::from("/Users/me/Projects/orders-api");
        assert_eq!(remote_dir(&cfg("~/work"), "/home/dev", &repo).as_deref(), Some("/home/dev/work/orders-api"));
        assert_eq!(remote_dir(&cfg("~"), "/home/dev/", &repo).as_deref(), Some("/home/dev/orders-api"));
        assert_eq!(remote_dir(&cfg("/srv/repos/"), "/home/dev", &repo).as_deref(), Some("/srv/repos/orders-api"));
        // a folder name the host would not put on a server's disk
        for bad in ["/x/-rf", "/x/a b", "/x/a;b", "/x/..", "/", "/x/ä", "/x/.ssh", "/x/.aws", "/x/.hidden"] {
            assert_eq!(remote_dir(&cfg("~/work"), "/home/dev", Path::new(bad)), None, "{bad}");
        }
    }

    #[test]
    fn the_message_says_what_is_missing() {
        let mut st = ServerStatus { reachable: true, ..ServerStatus::default() };
        st.node.ok = true;
        st.claude.path = Some("/c".into());
        st.git.path = Some("/g".into());
        st.bundle.ok = true;
        let m = NotReady::Status(Box::new(st.clone()), "Build server".into()).message();
        assert!(m.contains("the Agent SDK") && !m.contains("Node.js") && m.contains("Settings > Servers"), "{m}");
        st.reachable = false;
        assert!(NotReady::Status(Box::new(st), "Build server".into()).message().contains("not reachable"));
        assert!(NotReady::Disabled("X".into()).message().contains("switched off"));
        assert!(NotReady::Unknown.message().contains("not in Settings"));
    }

    #[test]
    fn a_look_without_a_usable_answer_is_none() {
        let fs = SidecarFs::new(|body| (body["ops"].as_array().map(Vec::len) == Some(1)).then(|| json!({"results": [{"ok": true}]})));
        assert!(fs.query(vec![json!({"op": "stat", "path": "/a"})]).is_some());
        // a reply with fewer results than ops is no answer; neither is no reply, nor an error reply
        assert!(fs.query(vec![json!({}), json!({})]).is_none());
        assert!(SidecarFs::new(|_| None).query(vec![json!({})]).is_none());
        assert!(SidecarFs::new(|_| Some(json!({"error": "bad_request"}))).query(vec![json!({})]).is_none());
    }

    #[test]
    fn the_registry_asks_the_supplier_every_time() {
        let reg = ServerRegistry::new(Arc::new(|| vec![cfg("~/work")]), Ssh::from_bin(Some("/nonexistent/ssh".into()), PathBuf::from("/tmp")), "1.2.0");
        assert_eq!(reg.cfg("build").map(|c| c.name), Some("Build server".into()));
        assert!(reg.cfg("other").is_none());
        assert_eq!(reg.ready("other").unwrap_err(), NotReady::Unknown);
        // a server that cannot be reached is not ready, and the answer is kept for the settings page
        let err = reg.ready("build").unwrap_err();
        assert!(matches!(err, NotReady::Status(..)), "{err:?}");
        assert!(reg.cached("build").is_some_and(|s| !s.reachable));
    }
}
