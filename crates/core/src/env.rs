//! Login-shell environment resolution (contract section 6.2).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::process::Command;

use crate::{EngineError, EnvSource, EnvState, EnvStatus};

pub const FALLBACK_PATH: &str = "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin";
/// Timeout of the `$SHELL -ilc 'env -0'` probe.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// A cached environment older than this is resolved again even when the invalidation hash still matches.
const CACHE_TTL_MS: i64 = 12 * 60 * 60 * 1000;
const CACHE_VERSION: u32 = 1;
const BEGIN_MARKER: &str = "__INTELY_ENV_BEGIN__";

/// Keys that survive from the login shell into hook environments.
fn whitelisted(key: &str) -> bool {
    matches!(key, "PATH" | "HOME" | "USER" | "LANG" | "SSH_AUTH_SOCK" | "NVM_DIR" | "GNUPGHOME") || key.starts_with("LC_")
}

pub struct EnvOptions {
    /// Where the resolved environment is cached; `None` disables the cache.
    pub cache_path: Option<PathBuf>,
    /// Shell to probe; default `$SHELL`, else `/bin/zsh`.
    pub shell: Option<PathBuf>,
    pub timeout: Duration,
}

impl Default for EnvOptions {
    fn default() -> Self {
        Self { cache_path: default_cache_path(), shell: None, timeout: PROBE_TIMEOUT }
    }
}

/// `~/Library/Application Support/IntelySwitchIDE/env.json`
pub fn default_cache_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Application Support/IntelySwitchIDE/env.json"))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    version: u32,
    hash: String,
    resolved_at_ms: i64,
    vars: BTreeMap<String, String>,
}

struct Inner {
    status: EnvStatus,
    vars: Option<HashMap<String, String>>,
}

type Listener = Arc<dyn Fn(EnvStatus) + Send + Sync>;

/// Resolves the login-shell environment once, off the critical path, and caches it.
pub struct EnvResolver {
    inner: Mutex<Inner>,
    opts: EnvOptions,
    listener: Mutex<Option<Listener>>,
}

impl EnvResolver {
    pub fn new(git_path: &str) -> Self {
        Self::with_options(git_path, EnvOptions::default())
    }

    pub fn with_options(git_path: &str, opts: EnvOptions) -> Self {
        Self {
            inner: Mutex::new(Inner {
                status: EnvStatus {
                    state: EnvState::Resolving,
                    git_path: git_path.to_owned(),
                    node_path: None,
                    source: EnvSource::Fallback,
                    message: None,
                },
                vars: None,
            }),
            opts,
            listener: Mutex::new(None),
        }
    }

    /// Registers the callback that receives every status change (`engine:env`); replaces a previous one.
    pub fn on_status(&self, cb: impl Fn(EnvStatus) + Send + Sync + 'static) {
        *self.listener.lock().expect("env listener lock") = Some(Arc::new(cb));
    }

    pub fn status(&self) -> EnvStatus {
        self.inner.lock().expect("env status lock").status.clone()
    }

    /// Runs `$SHELL -ilc 'env -0'` (8 s timeout) unless a valid cache entry exists, updates the status and returns it.
    /// Never fails: a failed probe leaves `state: failed` with the fallback environment and a message.
    pub async fn resolve(&self) -> Result<EnvStatus, EngineError> {
        self.resolve_inner(false).await
    }

    /// Like [`resolve`](Self::resolve) but ignores and replaces the cache (e.g. after the user changed their shell setup).
    pub async fn resolve_fresh(&self) -> Result<EnvStatus, EngineError> {
        self.resolve_inner(true).await
    }

    /// Drops the cached environment (memory and file); the next [`resolve`](Self::resolve) probes the shell again.
    pub fn invalidate(&self) {
        {
            let mut g = self.inner.lock().expect("env status lock");
            g.vars = None;
            g.status = EnvStatus { state: EnvState::Resolving, source: EnvSource::Fallback, node_path: None, message: None, ..g.status.clone() };
        }
        if let Some(p) = &self.opts.cache_path {
            let _ = std::fs::remove_file(p);
        }
    }

    /// Whitelisted environment for hook-running commands. Until the login-shell probe succeeded this is the process
    /// `PATH` extended by [`FALLBACK_PATH`].
    pub fn hook_env(&self) -> HashMap<String, String> {
        let g = self.inner.lock().expect("env status lock");
        match &g.vars {
            Some(v) => v.clone(),
            None => HashMap::from([("PATH".to_owned(), fallback_path())]),
        }
    }

    async fn resolve_inner(&self, fresh: bool) -> Result<EnvStatus, EngineError> {
        self.publish(|s| {
            s.state = EnvState::Resolving;
            s.message = None;
        });
        let shell = self.opts.shell.clone().unwrap_or_else(default_shell);
        let hash = fingerprint(&shell);
        let cached = if fresh { None } else { self.read_cache(&hash) };
        let outcome = match cached {
            Some(vars) => Ok(vars),
            None => {
                let probed = probe_shell(&shell, self.opts.timeout).await;
                if let Ok(vars) = &probed {
                    self.write_cache(&hash, vars);
                }
                probed
            }
        };
        match outcome {
            Ok(vars) => {
                let node = find_in_path(vars.get("PATH").map(String::as_str).unwrap_or(""), "node");
                self.inner.lock().expect("env status lock").vars = Some(vars.into_iter().collect());
                self.publish(|s| {
                    s.state = EnvState::Ready;
                    s.source = EnvSource::LoginShell;
                    s.node_path = node.map(|p| p.to_string_lossy().into_owned());
                    s.message = None;
                });
            }
            Err(msg) => {
                self.inner.lock().expect("env status lock").vars = None;
                self.publish(|s| {
                    s.state = EnvState::Failed;
                    s.source = EnvSource::Fallback;
                    s.node_path = find_in_path(&fallback_path(), "node").map(|p| p.to_string_lossy().into_owned());
                    s.message = Some(msg);
                });
            }
        }
        Ok(self.status())
    }

    fn publish(&self, f: impl FnOnce(&mut EnvStatus)) {
        let status = {
            let mut g = self.inner.lock().expect("env status lock");
            f(&mut g.status);
            g.status.clone()
        };
        let cb = self.listener.lock().expect("env listener lock").clone();
        if let Some(cb) = cb {
            cb(status);
        }
    }

    fn read_cache(&self, hash: &str) -> Option<BTreeMap<String, String>> {
        let text = std::fs::read_to_string(self.opts.cache_path.as_ref()?).ok()?;
        let c: CacheFile = serde_json::from_str(&text).ok()?;
        let fresh = now_ms() - c.resolved_at_ms < CACHE_TTL_MS && c.resolved_at_ms <= now_ms() + 60_000;
        (c.version == CACHE_VERSION && c.hash == hash && fresh && c.vars.contains_key("PATH")).then_some(c.vars)
    }

    fn write_cache(&self, hash: &str, vars: &BTreeMap<String, String>) {
        let Some(path) = &self.opts.cache_path else { return };
        let file = CacheFile { version: CACHE_VERSION, hash: hash.to_owned(), resolved_at_ms: now_ms(), vars: vars.clone() };
        let Ok(json) = serde_json::to_vec_pretty(&file) else { return };
        // best effort: a read-only support dir must not break the engine
        let _ = (|| -> std::io::Result<()> {
            std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))?;
            let tmp = path.with_extension(format!("json.tmp{}", std::process::id()));
            std::fs::write(&tmp, json)?;
            std::fs::rename(tmp, path)
        })();
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn default_shell() -> PathBuf {
    std::env::var_os("SHELL").filter(|s| !s.is_empty()).map_or_else(|| PathBuf::from("/bin/zsh"), PathBuf::from)
}

/// Process `PATH` followed by the fallback directories it does not contain yet.
fn fallback_path() -> String {
    let mut dirs: Vec<String> = std::env::var("PATH").unwrap_or_default().split(':').filter(|d| !d.is_empty()).map(str::to_owned).collect();
    for d in FALLBACK_PATH.split(':') {
        if !dirs.iter().any(|x| x == d) {
            dirs.push(d.to_owned());
        }
    }
    dirs.join(":")
}

fn find_in_path(path: &str, bin: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    path.split(':')
        .filter(|d| !d.is_empty())
        .map(|d| Path::new(d).join(bin))
        .find(|p| p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

/// Hash of everything that decides the shell's environment: the shell, its startup files and the nvm default alias.
/// A change in any of them invalidates the cache.
fn fingerprint(shell: &Path) -> String {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let zdot = std::env::var_os("ZDOTDIR").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| home.clone());
    let nvm = std::env::var_os("NVM_DIR").map(PathBuf::from).unwrap_or_else(|| home.join(".nvm"));
    let mut files: Vec<PathBuf> = ["/etc/zshenv", "/etc/zprofile", "/etc/zshrc", "/etc/profile", "/etc/paths"].iter().map(PathBuf::from).collect();
    files.extend([".zshenv", ".zprofile", ".zshrc", ".zlogin"].iter().map(|f| zdot.join(f)));
    files.extend([".bash_profile", ".bash_login", ".bashrc", ".profile"].iter().map(|f| home.join(f)));
    files.push(nvm.join("alias/default"));
    let mut h = Sha256::new();
    h.update(shell.as_os_str().as_encoded_bytes());
    for f in files {
        h.update(b"\0");
        h.update(f.as_os_str().as_encoded_bytes());
        match f.metadata() {
            Ok(m) => {
                let mtime = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
                h.update(format!(":{}:{mtime}", m.len()));
            }
            Err(_) => h.update(b":absent"),
        }
    }
    hex::encode(h.finalize())
}

async fn probe_shell(shell: &Path, timeout: Duration) -> Result<BTreeMap<String, String>, String> {
    let script = format!("printf %s {BEGIN_MARKER}; env -0");
    let child = Command::new(shell)
        .arg("-ilc")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("TERM", "dumb")
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("cannot start {}: {e}", shell.display()))?;
    let pgid = child.id().map(|p| p as i32);
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Err(_) => {
            if let Some(pgid) = pgid.filter(|p| *p > 1) {
                // SAFETY: plain syscall on the group this function created.
                unsafe { libc::killpg(pgid, libc::SIGKILL) };
            }
            Err(format!("{} -ilc did not finish within {} s", shell.display(), timeout.as_secs()))
        }
        Ok(Err(e)) => Err(format!("{} failed: {e}", shell.display())),
        Ok(Ok(out)) => parse_env_dump(&out.stdout).ok_or_else(|| {
            let how = out.status.code().map_or("a signal".to_owned(), |c| format!("exit code {c}"));
            format!("{} -ilc produced no environment ({how})", shell.display())
        }),
    }
}

/// Parses `env -0` output (after the marker, which hides banners printed by rc files) and keeps the whitelisted keys.
fn parse_env_dump(stdout: &[u8]) -> Option<BTreeMap<String, String>> {
    let marker = BEGIN_MARKER.as_bytes();
    let at = stdout.windows(marker.len()).position(|w| w == marker)? + marker.len();
    let vars: BTreeMap<String, String> = stdout[at..]
        .split(|&b| b == 0)
        .filter_map(|rec| {
            let rec = String::from_utf8_lossy(rec);
            let (k, v) = rec.split_once('=')?;
            whitelisted(k).then(|| (k.to_owned(), v.to_owned()))
        })
        .collect();
    vars.contains_key("PATH").then_some(vars)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// How long a fake login shell may take before the resolver gives up: far above its real cost, so a loaded machine cannot turn
    /// "the shell was slow to start" into a failed resolve.
    const SHELL_BUDGET: Duration = Duration::from_secs(60);

    fn fake_shell(dir: &Path, body: &str) -> PathBuf {
        let p = dir.join("fakeshell");
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    fn resolver(dir: &Path, shell: PathBuf, cache: bool, timeout: Duration) -> EnvResolver {
        EnvResolver::with_options("/usr/local/bin/git", EnvOptions { cache_path: cache.then(|| dir.join("cache/env.json")), shell: Some(shell), timeout })
    }

    #[test]
    fn dump_parsing_skips_banners_and_filters_the_whitelist() {
        let raw = b"Welcome banner\n\x1b[0m__INTELY_ENV_BEGIN__PATH=/a/bin:/b/bin\0HOME=/Users/x\0SECRET_TOKEN=abc\0LC_ALL=en_US.UTF-8\0LANG=en_US.UTF-8\0SSH_AUTH_SOCK=/tmp/agent\0MULTI=line1\nline2\0";
        let v = parse_env_dump(raw).unwrap();
        assert_eq!(v.keys().map(String::as_str).collect::<Vec<_>>(), vec!["HOME", "LANG", "LC_ALL", "PATH", "SSH_AUTH_SOCK"]);
        assert_eq!(v["PATH"], "/a/bin:/b/bin");
        assert!(parse_env_dump(b"no marker PATH=/x\0").is_none());
        assert!(parse_env_dump(b"__INTELY_ENV_BEGIN__HOME=/x\0").is_none(), "PATH is required");
    }

    #[test]
    fn fallback_path_keeps_the_process_path_and_appends_the_documented_dirs() {
        let p = fallback_path();
        for d in FALLBACK_PATH.split(':') {
            assert!(p.split(':').any(|x| x == d), "{d} missing in {p}");
        }
        let r = EnvResolver::with_options("git", EnvOptions { cache_path: None, ..Default::default() });
        assert_eq!(r.hook_env()["PATH"], p);
        assert_eq!(r.status().state, EnvState::Resolving);
    }

    #[tokio::test]
    async fn resolves_through_the_shell_with_marker_and_reports_node() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("nodebin");
        std::fs::create_dir_all(&bin).unwrap();
        let node = bin.join("node");
        std::fs::write(&node, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        let sh = fake_shell(tmp.path(), &format!("echo noisy banner; printf '%s' \"$2\" | grep -q __INTELY_ENV_BEGIN__ || exit 9\nprintf '__INTELY_ENV_BEGIN__PATH={}:/usr/bin\\0HOME=/h\\0OTHER=1\\0'", bin.display()));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let r = resolver(tmp.path(), sh, false, SHELL_BUDGET);
        let s2 = seen.clone();
        r.on_status(move |s| s2.lock().unwrap().push(s.state));
        let st = r.resolve().await.unwrap();
        assert_eq!((st.state, st.source), (EnvState::Ready, EnvSource::LoginShell));
        assert_eq!(st.node_path.as_deref(), Some(node.to_string_lossy().as_ref()));
        assert!(r.hook_env()["PATH"].starts_with(&bin.to_string_lossy().to_string()));
        assert!(!r.hook_env().contains_key("OTHER"));
        assert_eq!(*seen.lock().unwrap(), vec![EnvState::Resolving, EnvState::Ready]);
    }

    #[tokio::test]
    async fn timeout_and_garbage_fall_back_with_a_message() {
        let tmp = tempfile::tempdir().unwrap();
        let slow = fake_shell(tmp.path(), "sleep 20");
        let r = resolver(tmp.path(), slow, false, Duration::from_millis(400));
        let started = std::time::Instant::now();
        let st = r.resolve().await.unwrap();
        assert!(started.elapsed() < SHELL_BUDGET);
        assert_eq!((st.state, st.source), (EnvState::Failed, EnvSource::Fallback));
        assert!(st.message.unwrap().contains("did not finish"));
        assert_eq!(r.hook_env()["PATH"], fallback_path());

        let tmp2 = tempfile::tempdir().unwrap();
        let junk = fake_shell(tmp2.path(), "echo not an env dump");
        let st = resolver(tmp2.path(), junk, false, SHELL_BUDGET).resolve().await.unwrap();
        assert_eq!(st.state, EnvState::Failed);
        let st = resolver(tmp2.path(), tmp2.path().join("missing-shell"), false, SHELL_BUDGET).resolve().await.unwrap();
        assert!(st.message.unwrap().contains("cannot start"));
    }

    #[tokio::test]
    async fn cache_is_used_until_the_fingerprint_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let count = tmp.path().join("count");
        let sh = fake_shell(tmp.path(), &format!("echo x >> {}\nprintf '__INTELY_ENV_BEGIN__PATH=/cached/bin\\0'", count.display()));
        let runs = || std::fs::read_to_string(&count).map_or(0, |s| s.lines().count());

        let r1 = resolver(tmp.path(), sh.clone(), true, SHELL_BUDGET);
        assert_eq!(r1.resolve().await.unwrap().state, EnvState::Ready);
        assert_eq!(runs(), 1);
        // a fresh resolver (new app start) reads the cache without spawning the shell
        let r2 = resolver(tmp.path(), sh.clone(), true, SHELL_BUDGET);
        let st = r2.resolve().await.unwrap();
        assert_eq!((st.state, runs()), (EnvState::Ready, 1));
        assert_eq!(r2.hook_env()["PATH"], "/cached/bin");
        // a different shell binary changes the hash
        let sh2 = tmp.path().join("fakeshell2");
        // a hard link: copying leaves a writable fd that a concurrently forked test child can inherit (ETXTBSY on exec)
        std::fs::hard_link(&sh, &sh2).unwrap();
        resolver(tmp.path(), sh2, true, SHELL_BUDGET).resolve().await.unwrap();
        assert_eq!(runs(), 2);
        // resolve_fresh and invalidate bypass the cache
        r2.resolve_fresh().await.unwrap();
        assert_eq!(runs(), 3);
        r2.invalidate();
        assert!(!tmp.path().join("cache/env.json").exists());
        assert_eq!(r2.status().state, EnvState::Resolving);
        r2.resolve().await.unwrap();
        assert_eq!(runs(), 4);
    }

    #[tokio::test]
    async fn expired_or_corrupt_cache_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let sh = fake_shell(tmp.path(), "printf '__INTELY_ENV_BEGIN__PATH=/p\\0'");
        let r = resolver(tmp.path(), sh.clone(), true, SHELL_BUDGET);
        let cache = tmp.path().join("cache/env.json");
        std::fs::create_dir_all(cache.parent().unwrap()).unwrap();
        std::fs::write(&cache, "{not json").unwrap();
        assert_eq!(r.resolve().await.unwrap().state, EnvState::Ready);
        let mut file: CacheFile = serde_json::from_str(&std::fs::read_to_string(&cache).unwrap()).unwrap();
        file.resolved_at_ms -= CACHE_TTL_MS + 1000;
        file.vars.insert("PATH".into(), "/stale".into());
        std::fs::write(&cache, serde_json::to_string(&file).unwrap()).unwrap();
        let r = resolver(tmp.path(), sh, true, SHELL_BUDGET);
        r.resolve().await.unwrap();
        assert_eq!(r.hook_env()["PATH"], "/p");
    }

    /// Runs the real login shell of the developer machine; skipped where there is none.
    #[tokio::test]
    async fn real_login_shell_resolves_a_path() {
        if !Path::new("/bin/zsh").exists() {
            eprintln!("skipped: no /bin/zsh");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let r = resolver(tmp.path(), default_shell(), false, PROBE_TIMEOUT);
        let started = std::time::Instant::now();
        let st = r.resolve().await.unwrap();
        eprintln!("login shell probe: {:?} in {:?}, node = {:?}", st.state, started.elapsed(), st.node_path);
        assert_eq!(st.state, EnvState::Ready, "{:?}", st.message);
        assert!(r.hook_env()["PATH"].contains("/usr/bin"));
    }
}
