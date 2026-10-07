//! Shared harness: a temp relay kit (with a stand-in wrangler file that is never executed), a scripted spawner, a fake relay `Http` that
//! serves the staged bundle, a fake clock and a fake durable Keychain. Nothing here starts a process (except where a test says so),
//! touches the network, or reads the real repo's `node_modules`.
#![allow(dead_code)]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use intely_core::jail::Jail;
use intely_relay_bundle::{BundleError, Http, HttpFuture, HttpRequest, HttpResponse};
use intely_relay_deploy::output::Account;
use intely_relay_deploy::pipeline::{DeployRequest, PreviewRequest};
use intely_relay_deploy::{AuthMode, Clock, Deployer, Deps, Op, PlanRequest, Reply, RelayKit, ScriptedSpawner, Spawner};
use intely_settings::secrets::{MemorySecretStore, Secret, SecretStore, SecretsHealth};
use intely_settings::SettingsError;

pub const WORKER: &str = "intely-relay-0123456789ab";
pub const HOST: &str = "intely-relay-0123456789ab.my-sub.workers.dev";
pub const ACCOUNT_ID: &str = "0123456789abcdef0123456789abcdef";
pub const NOW: u64 = 1_790_000_000;

pub fn repo_wrangler_jsonc() -> String {
    fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../remote-relay/wrangler.jsonc")).expect("remote-relay/wrangler.jsonc")
}

pub fn account() -> Account {
    Account { id: ACCOUNT_ID.to_owned(), name: "Test Account".to_owned() }
}

/// A keychain-shaped store (durable) or a degraded one.
pub struct FakeKeychain {
    inner: MemorySecretStore,
    pub degraded: bool,
}

impl FakeKeychain {
    pub fn durable() -> Arc<Self> {
        Arc::new(Self { inner: MemorySecretStore::new(), degraded: false })
    }
    pub fn degraded() -> Arc<Self> {
        Arc::new(Self { inner: MemorySecretStore::new(), degraded: true })
    }
}

impl SecretStore for FakeKeychain {
    fn has(&self, key: &str) -> Result<bool, SettingsError> {
        self.inner.has(key)
    }
    fn set(&self, key: &str, value: Secret) -> Result<(), SettingsError> {
        self.inner.set(key, value)
    }
    fn remove(&self, key: &str) -> Result<(), SettingsError> {
        self.inner.remove(key)
    }
    fn get(&self, key: &str) -> Result<Option<Secret>, SettingsError> {
        self.inner.get(key)
    }
    fn health(&self) -> SecretsHealth {
        SecretsHealth { backend: if self.degraded { "memory" } else { "keychain" }, degraded: self.degraded, message: None }
    }
}

pub struct FakeClock {
    pub now: AtomicU64,
    pub sleeps: Mutex<Vec<Duration>>,
}

impl FakeClock {
    pub fn new(now: u64) -> Arc<Self> {
        Arc::new(Self { now: AtomicU64::new(now), sleeps: Mutex::new(Vec::new()) })
    }
    pub fn advance(&self, secs: u64) {
        self.now.fetch_add(secs, Ordering::SeqCst);
    }
}

impl Clock for FakeClock {
    fn now(&self) -> u64 {
        self.now.load(Ordering::SeqCst)
    }
    fn sleep(&self, d: Duration) {
        self.sleeps.lock().unwrap().push(d);
        self.now.fetch_add(d.as_secs().max(1), Ordering::SeqCst);
    }
}

/// The relay as the Health and Verify steps see it: serves the staged directory, with knobs for faults.
#[derive(Default)]
pub struct FakeRelay {
    pub dir: Mutex<Option<PathBuf>>,
    /// Answer `/api/status` with this HTTP status this many times first (a fresh workers.dev deploy answers 523 for a while).
    pub status_failures: Mutex<u32>,
    pub status_code: Mutex<u16>,
    pub overrides: Mutex<HashMap<String, Vec<u8>>>,
    pub requests: Mutex<Vec<String>>,
}

impl FakeRelay {
    pub fn new() -> Arc<Self> {
        let r = Self::default();
        *r.status_code.lock().unwrap() = 523;
        Arc::new(r)
    }
    pub fn serve(&self, dir: &Path) {
        *self.dir.lock().unwrap() = Some(dir.to_path_buf());
    }
    pub fn override_file(&self, path: &str, bytes: &[u8]) {
        self.overrides.lock().unwrap().insert(path.to_owned(), bytes.to_vec());
    }
}

fn resp(status: u16, body: Vec<u8>) -> HttpResponse {
    HttpResponse { status, headers: vec![], body }
}

impl Http for FakeRelay {
    fn get(&self, req: HttpRequest) -> HttpFuture<'_> {
        let rest = req.url.split_once("://").map(|x| x.1).unwrap_or("");
        let path = rest.find('/').map(|i| rest[i..].to_owned()).unwrap_or_else(|| "/".to_owned());
        self.requests.lock().unwrap().push(path.clone());
        let out: Result<HttpResponse, BundleError> = (|| {
            if path == "/api/status" {
                let mut n = self.status_failures.lock().unwrap();
                if *n > 0 {
                    *n -= 1;
                    return Ok(resp(*self.status_code.lock().unwrap(), vec![]));
                }
                let dir = self.dir.lock().unwrap().clone().ok_or(BundleError::Net("network"))?;
                let manifest = fs::read_to_string(dir.join("bundle.json")).unwrap_or_default();
                let hash = serde_json::from_str::<serde_json::Value>(&manifest).ok().and_then(|v| v["manifestSha256"].as_str().map(str::to_owned)).unwrap_or_default();
                let body = format!(r#"{{"ok":true,"relay":{{"version":"0.0.0","protocol":"intely.v1"}},"bundle":{{"hash":"{hash}"}},"push":{{"configured":false}}}}"#);
                return Ok(resp(200, body.into_bytes()));
            }
            let rel = path.trim_start_matches('/');
            // Like the Worker's asset binding: `/` is the shell.
            let rel = if rel.is_empty() { "index.html" } else { rel };
            if let Some(b) = self.overrides.lock().unwrap().get(rel) {
                return Ok(resp(200, b.clone()));
            }
            let dir = self.dir.lock().unwrap().clone().ok_or(BundleError::Net("network"))?;
            match fs::read(dir.join(rel)) {
                Ok(b) => Ok(resp(200, b)),
                Err(_) => Ok(resp(404, vec![])),
            }
        })();
        Box::pin(async move { out })
    }
}

/// A kit in `root`: `remote-relay` (source, package.json, wrangler.jsonc of the real repo, installed wrangler at the pinned version)
/// and `remote-web` (a tiny built dist with `index.html` and `sw.js`).
pub fn make_kit(root: &Path) -> RelayKit {
    let relay = root.join("remote-relay");
    let web = root.join("remote-web");
    fs::create_dir_all(relay.join("src")).unwrap();
    fs::create_dir_all(relay.join("node_modules/wrangler/bin")).unwrap();
    fs::create_dir_all(relay.join("node_modules/.bin")).unwrap();
    fs::create_dir_all(web.join("dist/assets")).unwrap();
    fs::write(relay.join("package.json"), r#"{"name":"intely-remote-relay","version":"0.1.0","devDependencies":{"wrangler":"4.147.0"}}"#).unwrap();
    fs::write(relay.join("wrangler.jsonc"), repo_wrangler_jsonc()).unwrap();
    fs::write(relay.join("src/index.ts"), "import pkg from \"../package.json\" with { type: \"json\" };\nexport default { fetch() { return new Response(pkg.version); } };\n").unwrap();
    fs::write(relay.join("src/config.ts"), "export const PROTOCOL = \"intely.v1\";\n").unwrap();
    fs::write(relay.join("node_modules/wrangler/package.json"), r#"{"name":"wrangler","version":"4.147.0"}"#).unwrap();
    fs::write(relay.join("node_modules/wrangler/bin/wrangler.js"), "#!/usr/bin/env node\nconsole.log('stand-in, never executed');\n").unwrap();
    std::os::unix::fs::symlink("../wrangler/bin/wrangler.js", relay.join("node_modules/.bin/wrangler")).unwrap();
    fs::write(web.join("package.json"), r#"{"name":"intely-remote-web","version":"0.0.0"}"#).unwrap();
    fs::write(web.join("dist/index.html"), "<!doctype html><title>IntelyIDE</title><script src=\"/assets/app.js\"></script>\n").unwrap();
    fs::write(web.join("dist/sw.js"), "self.addEventListener('install', () => {});\n").unwrap();
    fs::write(web.join("dist/assets/app.js"), "console.log('app');\n").unwrap();
    RelayKit::at(root).unwrap()
}

pub struct Fixture {
    pub tmp: tempfile::TempDir,
    pub kit: RelayKit,
    pub data: PathBuf,
    pub spawner: Arc<ScriptedSpawner>,
    pub relay: Arc<FakeRelay>,
    pub clock: Arc<FakeClock>,
    pub store: Arc<FakeKeychain>,
    pub deployer: Deployer,
}

pub fn deploy_ndjson(worker: &str, target: &str) -> String {
    format!("{{\"version\":1,\"type\":\"wrangler-session\"}}\n{{\"version\":1,\"type\":\"deploy\",\"worker_name\":\"{worker}\",\"version_id\":\"11111111-2222-3333-4444-555555555555\",\"targets\":[\"{target}\"]}}\n")
}

/// The scripted wrangler of a healthy account: dry run ok (with a source map inside the snapshot), the name is free, the deploy
/// writes its output file, secrets go through.
pub fn base_spawner(worker: &str) -> ScriptedSpawner {
    let w = worker.to_owned();
    ScriptedSpawner::new()
        .on(
            Op::DeployDryRun,
            Reply::ok().lines(&["--dry-run: exiting now."]).hook(move |inv| {
                let i = inv.argv.iter().position(|a| a == "--outdir").unwrap();
                let out = PathBuf::from(&inv.argv[i + 1]);
                fs::create_dir_all(&out).unwrap();
                let map = format!("{{\"version\":3,\"sources\":[\"../{w}/kit/src/index.ts\",\"../../../kit/remote-relay/node_modules/zod/index.js\"]}}");
                fs::write(out.join("index.js.map"), map).unwrap();
            }),
        )
        .on(Op::DeploymentsList, Reply::exit(1, &["✘ [ERROR] This Worker does not exist on your account. [code: 10007]"]))
        .on(Op::SecretPut, Reply::ok().lines(&["Success! Uploaded secret"]))
}

pub fn deploy_ok(worker: &str) -> Reply {
    Reply::ok().lines(&["Uploaded intely-relay (1.00 sec)", "Deployed intely-relay triggers"]).output_file(&deploy_ndjson(worker, &format!("https://{HOST}")))
}

pub fn happy_spawner(worker: &str) -> ScriptedSpawner {
    base_spawner(worker).on(Op::Deploy, deploy_ok(worker))
}

pub struct FixtureOpts {
    pub jail: Jail,
    pub cloud: bool,
    pub store: Arc<FakeKeychain>,
    pub env: Vec<(&'static str, String)>,
    /// Puts a stand-in `pnpm` (never executed by the scripted spawner) first on PATH.
    pub pnpm_stub: bool,
}

impl Default for FixtureOpts {
    fn default() -> Self {
        Self { jail: Jail::off(), cloud: false, store: FakeKeychain::durable(), env: Vec::new(), pnpm_stub: false }
    }
}

pub fn fixture(spawner: ScriptedSpawner) -> Fixture {
    fixture_with(spawner, FixtureOpts::default())
}

pub fn fixture_with(spawner: ScriptedSpawner, o: FixtureOpts) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let kit = make_kit(&tmp.path().join("kit"));
    let data = tmp.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let spawner = Arc::new(spawner);
    let relay = FakeRelay::new();
    let clock = FakeClock::new(NOW);
    let mut vars: HashMap<String, String> = HashMap::new();
    vars.insert("PATH".into(), "/usr/bin:/bin".into());
    if o.pnpm_stub {
        let bin = tmp.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        // prepare needs both: pnpm to run and node for its shebang (a Finder-launched app has neither on its bare PATH)
        for tool in ["pnpm", "node"] {
            fs::write(bin.join(tool), "#!/bin/sh\n").unwrap();
            fs::set_permissions(bin.join(tool), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        }
        vars.insert("PATH".into(), format!("{}:/usr/bin:/bin", bin.display()));
    }
    vars.insert("HOME".into(), tmp.path().join("home").to_string_lossy().into_owned());
    for (k, v) in o.env {
        vars.insert(k.to_owned(), v);
    }
    let deployer = Deployer::new(Deps {
        kit: kit.clone(),
        data_dir: data.clone(),
        jail: o.jail,
        cloud: o.cloud,
        spawner: spawner.clone() as Arc<dyn Spawner>,
        http: relay.clone() as Arc<dyn Http>,
        clock: clock.clone() as Arc<dyn Clock>,
        store: o.store.clone() as Arc<dyn SecretStore>,
        var: Arc::new(move |k| vars.get(k).cloned()),
        install_id: "install-123".to_owned(),
    });
    Fixture { tmp, kit, data, spawner, relay, clock, store: o.store, deployer }
}

impl Fixture {
    pub fn preview_req(&self, push: bool) -> PreviewRequest {
        PreviewRequest { worker_name: WORKER.to_owned(), push, custom_domain: None, account: account(), auth_mode: AuthMode::Oauth, allow_seq_clock_skew: false }
    }

    /// Previews, points the fake relay at the staged directory and returns the preview.
    pub fn preview(&self, push: bool) -> intely_relay_deploy::DeployPreview {
        let p = self.deployer.preview(&self.preview_req(push), &mut |_| {}).expect("preview");
        self.relay.serve(&self.deployer.root().join(WORKER).join("dist"));
        *self.relay.status_failures.lock().unwrap() = 0;
        p
    }

    /// A deploy request with a fresh plan nonce for the preview (the plan must be asked for while the preview is still live and
    /// unchanged). The unverified-module acknowledgement is given, so the tests that are not about it stay out of its way.
    pub fn request(&self, p: &intely_relay_deploy::DeployPreview) -> DeployRequest {
        let plan = self.deployer.plan(&PlanRequest::Deploy { preview_id: p.preview_id.clone() }).expect("plan");
        DeployRequest { preview_id: p.preview_id.clone(), confirm_name: p.worker_name.clone(), overwrite_phrase: None, plan_id: plan.plan_id, acknowledge_unverified: true }
    }

    pub fn worker_dir(&self) -> PathBuf {
        self.deployer.root().join(WORKER)
    }
}
