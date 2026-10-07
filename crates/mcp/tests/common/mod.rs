//! Shared helpers of the integration tests: the fixture MCP servers (`scripts/mcp-fixture`), a store over a temp directory and the memory
//! secret store (the real Keychain is never touched), and a canary scan.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;

use intely_core::jail::Jail;
use intely_mcp::probe::{ProbeOptions, ProbeServer, ProbeVar};
use intely_mcp::store::{McpStore, StoreConfig};
use intely_mcp::types::*;
use intely_settings::{MemorySecretStore, Secret, SecretStore, SettingsStore};

/// A value that must never appear anywhere it should not.
pub const CANARY: &str = "CANARY-MCP-7f3a-env";

pub fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts/mcp-fixture").canonicalize().expect("scripts/mcp-fixture exists")
}

pub fn server_script() -> PathBuf {
    fixture_dir().join("mcp-fixture-server.mjs")
}

pub fn http_script() -> PathBuf {
    fixture_dir().join("mcp-fixture-http.mjs")
}

/// `node` on the PATH; tests that need it skip with a printed reason when it is missing.
pub fn node_path() -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).map(|d| d.join("node")).find(|p| p.is_file())
}

#[macro_export]
macro_rules! need_node {
    () => {
        if $crate::common::node_path().is_none() {
            eprintln!("skipped: node is not on PATH");
            return;
        }
    };
}

pub fn process_path() -> String {
    std::env::var("PATH").unwrap_or_default()
}

/// The scrubbed base environment of a probe child in tests: PATH only (the script's shebang needs `node` on it).
pub fn base_env() -> BTreeMap<String, String> {
    BTreeMap::from([("PATH".to_owned(), process_path())])
}

pub fn probe_opts(timeout_ms: u64) -> ProbeOptions {
    ProbeOptions { timeout: std::time::Duration::from_millis(timeout_ms), env: base_env(), client_version: "0.0.0-test".into() }
}

pub fn plain(name: &str, value: &str) -> ProbeVar {
    ProbeVar { name: name.into(), value: Secret::new(value), secret: false }
}

pub fn secret(name: &str, value: &str) -> ProbeVar {
    ProbeVar { name: name.into(), value: Secret::new(value), secret: true }
}

pub fn stdio_probe(mode: &str, mut env: Vec<ProbeVar>) -> ProbeServer {
    env.push(plain("FIXTURE_MODE", mode));
    ProbeServer { name: "fixture".into(), transport: McpTransport::Stdio, command: Some(server_script()), args: vec![], url: None, env, headers: vec![] }
}

pub fn http_probe(url: &str, headers: Vec<ProbeVar>) -> ProbeServer {
    ProbeServer { name: "fixture-http".into(), transport: McpTransport::Http, command: None, args: vec![], url: Some(url.into()), env: vec![], headers }
}

pub fn jail_off() -> Jail {
    Jail::off()
}

/// The HTTP fixture on a free loopback port; killed on drop.
pub struct HttpFixture {
    child: Child,
    pub port: u16,
}

impl HttpFixture {
    pub fn start(mode: &str, token: Option<&str>, log: Option<&Path>) -> Self {
        let mut cmd = Command::new(http_script());
        cmd.env("PATH", process_path()).env("FIXTURE_MODE", mode).stdout(Stdio::piped()).stderr(Stdio::null());
        if let Some(t) = token {
            cmd.env("FIXTURE_TOKEN", t);
        }
        if let Some(l) = log {
            cmd.env("FIXTURE_LOG", l);
        }
        let mut child = cmd.spawn().expect("start the http fixture");
        let mut line = String::new();
        BufReader::new(child.stdout.take().expect("stdout")).read_line(&mut line).expect("listening line");
        let port = line.trim().strip_prefix("listening ").and_then(|p| p.parse().ok()).unwrap_or_else(|| panic!("unexpected first line {line:?}"));
        Self { child, port }
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.port)
    }
}

impl Drop for HttpFixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A store over a temp directory with the memory secret store.
pub struct Fx {
    pub dir: tempfile::TempDir,
    pub settings: Arc<SettingsStore>,
    pub secrets: Arc<MemorySecretStore>,
    pub store: Arc<McpStore>,
}

impl Fx {
    pub fn new() -> Self {
        Self::with(|_| {})
    }

    pub fn with(f: impl FnOnce(&mut StoreConfig)) -> Self {
        Self::build(None, f)
    }

    /// A store over a settings file that already exists (a hand edit, an older or a newer build).
    pub fn with_file(content: &str) -> Self {
        Self::build(Some(content), |_| {})
    }

    fn build(content: Option<&str>, f: impl FnOnce(&mut StoreConfig)) -> Self {
        let dir = tempfile::tempdir().unwrap();
        if let Some(c) = content {
            std::fs::write(dir.path().join("settings.json"), c).unwrap();
        }
        let settings = Arc::new(SettingsStore::open(dir.path().join("settings.json")).unwrap());
        let secrets = Arc::new(MemorySecretStore::new());
        let mut cfg = StoreConfig::new(Arc::new(Jail::off()));
        cfg.env = Arc::new(|| BTreeMap::from([("PATH".to_owned(), process_path())]));
        cfg.state_dirs = vec![dir.path().join("state")];
        f(&mut cfg);
        let store = Arc::new(McpStore::new(Arc::clone(&settings), Arc::clone(&secrets) as Arc<dyn SecretStore>, cfg));
        Self { dir, settings, secrets, store }
    }

    pub fn settings_text(&self) -> String {
        std::fs::read_to_string(self.settings.path()).unwrap_or_default()
    }

    /// Every file under the temp directory as text (the canary scan).
    pub fn all_text(&self) -> String {
        fn walk(p: &Path, out: &mut String) {
            if let Ok(rd) = std::fs::read_dir(p) {
                for e in rd.flatten() {
                    let path = e.path();
                    if path.is_dir() {
                        walk(&path, out);
                    } else if let Ok(t) = std::fs::read_to_string(&path) {
                        out.push_str(&t);
                    }
                }
            }
        }
        let mut out = String::new();
        walk(self.dir.path(), &mut out);
        out
    }
}

pub fn var_in(name: &str, secret_value: &str) -> McpVarInput {
    McpVarInput { name: name.into(), secret: true, value: None, secret_value: Some(secret_value.into()) }
}

pub fn var_plain(name: &str, value: &str) -> McpVarInput {
    McpVarInput { name: name.into(), secret: false, value: Some(value.into()), secret_value: None }
}

/// A stdio input that runs the fixture server script directly (its shebang finds `node`).
pub fn stdio_input(name: &str, env: Vec<McpVarInput>) -> McpSaveInput {
    McpSaveInput {
        id: None,
        name: name.into(),
        transport: McpTransport::Stdio,
        command: Some(server_script().to_string_lossy().into_owned()),
        args: None,
        url: None,
        env: Some(env),
        headers: None,
        enabled: false,
    }
}

pub fn http_input(name: &str, url: &str, headers: Vec<McpVarInput>) -> McpSaveInput {
    McpSaveInput { id: None, name: name.into(), transport: McpTransport::Http, command: None, args: None, url: Some(url.into()), env: None, headers: Some(headers), enabled: false }
}

impl Fx {
    /// Saves and confirms in one go.
    pub fn save_confirmed(&self, input: McpSaveInput) -> McpServerView {
        let v = self.store.save(input).expect("save");
        self.store.confirm(&v.id, &v.confirm_hash).expect("confirm")
    }
}
