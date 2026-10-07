//! The component preview harness processes (Stage B): one Node process per previewed component and export, started on a
//! click through `preview_component_start`, bound to `127.0.0.1` on a random port, stopped 45 s after the last view released it,
//! on the 4th start (oldest released one) and at app exit. The harness script is IDE-owned (`scripts/preview/harness`); it
//! writes only into the IDE state directory and never into the repository (see the header of `server.mjs`).
//!
//! Starting a process follows the run module's rule (`guard::check_process`: read-only needs "Allow processes", the E2E jail
//! only fixture repos). The webview sends a repo id, a repo-relative path and an export name; the root, the script and the
//! command line are resolved here.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use intely_core::EngineError;
use intely_preview_proxy::harness::{self, Component};
use serde_json::Value;

type Res<T> = Result<T, EngineError>;

pub const MAX_HARNESSES: usize = 3;
pub const IDLE_STOP: Duration = Duration::from_secs(45);
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const LOG_LINES: usize = 200;

struct Harness {
    id: String,
    child: Child,
    stdin: Option<ChildStdin>,
    port: u16,
    info: Value,
    released: Option<Instant>,
    log: Arc<Mutex<VecDeque<String>>>,
}

#[derive(Default)]
pub struct HarnessSet {
    map: Mutex<HashMap<String, Harness>>,
}

impl HarnessSet {
    /// Ports of the live harnesses (the E2E jail lets the click-to-source proxy front exactly these).
    pub fn ports(&self) -> Vec<u16> {
        self.map.lock().unwrap().values().map(|h| h.port).collect()
    }

    pub fn log(&self, id: &str) -> Vec<String> {
        self.map.lock().unwrap().values().find(|h| h.id == id).map(|h| h.log.lock().unwrap().iter().cloned().collect()).unwrap_or_default()
    }

    /// Marks a harness as unused; returns the stamp for the idle timer.
    pub fn release(&self, id: &str) -> Option<Instant> {
        let now = Instant::now();
        self.map.lock().unwrap().values_mut().find(|h| h.id == id).map(|h| {
            h.released = Some(now);
            now
        })
    }

    /// Stops the harness `id` if it is still released since `stamp` (a view that came back keeps it).
    pub fn stop_if_idle(&self, id: &str, stamp: Instant) {
        let victim = {
            let mut m = self.map.lock().unwrap();
            let key = m.iter().find(|(_, h)| h.id == id && h.released == Some(stamp)).map(|(k, _)| k.clone());
            key.and_then(|k| m.remove(&k))
        };
        if let Some(h) = victim {
            stop(h, STOP_GRACE);
        }
    }

    pub fn stop_all(&self) {
        let all: Vec<Harness> = self.map.lock().unwrap().drain().map(|(_, h)| h).collect();
        all.into_iter().for_each(|h| stop(h, STOP_GRACE));
    }

    /// Like [`Self::stop_all`], in parallel and with a shorter grace: a workspace switch has one second for it.
    pub fn stop_all_within(&self, grace: Duration) {
        let all: Vec<Harness> = self.map.lock().unwrap().drain().map(|(_, h)| h).collect();
        let threads: Vec<_> = all.into_iter().map(|h| std::thread::spawn(move || stop(h, grace))).collect();
        threads.into_iter().for_each(|t| drop(t.join()));
    }

    pub fn len(&self) -> usize {
        self.map.lock().unwrap().len()
    }

    /// Test fixture: registers an already running child as a harness.
    #[cfg(test)]
    pub fn adopt(&self, id: &str, child: Child, port: u16) {
        let h = Harness { id: id.to_owned(), child, stdin: None, port, info: Value::Null, released: None, log: Arc::new(Mutex::new(VecDeque::new())) };
        self.map.lock().unwrap().insert(id.to_owned(), h);
    }
}

const STOP_GRACE: Duration = Duration::from_secs(2);

/// Closing stdin is the polite stop (the harness exits when it ends); a harness that ignores it for `grace` is killed.
fn stop(mut h: Harness, grace: Duration) {
    drop(h.stdin.take());
    let until = Instant::now() + grace;
    while Instant::now() < until {
        if matches!(h.child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    let _ = h.child.kill();
    let _ = h.child.wait();
}

fn state_dir() -> PathBuf {
    std::env::var_os("INTELY_DATA_DIR").map(PathBuf::from).or_else(intely_agent_core::events::log::JsonlEventLog::default_base_dir).unwrap_or_else(std::env::temp_dir).join("preview")
}

fn ide_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().map(Path::to_path_buf).unwrap_or_default()
}

fn script() -> PathBuf {
    std::env::var_os("INTELY_HARNESS_DIR").map(PathBuf::from).unwrap_or_else(|| ide_root().join("scripts/preview/harness")).join("server.mjs")
}

/// `repo` is the resolved repository root (the glue looked the id up).
pub fn validate(repo: &Path, file: &str, export: &str) -> Res<Component> {
    harness::validate(repo, file, export).map_err(|e| EngineError::new(e.code(), e.to_string()))
}

/// Starts, or reuses, the harness for `component`. Blocking: call from `spawn_blocking`.
pub fn start(set: &HarnessSet, component: Component, env: &HashMap<String, String>) -> Res<Value> {
    let key = format!("{}\0{}", component.key(), component.export);
    {
        let mut m = set.map.lock().unwrap();
        if let Some(h) = m.get_mut(&key) {
            if matches!(h.child.try_wait(), Ok(None)) {
                h.released = None;
                return Ok(public(h));
            }
            m.remove(&key);
        }
        if m.len() >= MAX_HARNESSES {
            let oldest = m.iter().filter_map(|(k, h)| h.released.map(|t| (t, k.clone()))).min().map(|(_, k)| k);
            match oldest.and_then(|k| m.remove(&k)) {
                Some(h) => stop(h, STOP_GRACE),
                None => return Err(EngineError::new("tooMany", "three component previews are open: close one first")),
            }
        }
    }
    let path = env.get("PATH").map(std::ffi::OsString::from).or_else(|| std::env::var_os("PATH"));
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let node = harness::find_node(path.as_deref(), home.as_deref()).ok_or_else(|| EngineError::new("noNode", "Node.js was not found: install it, or start the IDE from a terminal where `node` works"))?;
    let server = script();
    if !server.is_file() {
        return Err(EngineError::new("noHarness", format!("the harness script is missing: {}", server.display())));
    }
    let state = state_dir();
    std::fs::create_dir_all(&state).map_err(|e| EngineError::new("io", format!("cannot create the preview state directory: {e}")))?;
    let mut cmd = Command::new(node);
    cmd.arg(&server)
        .arg(harness::config_json(&component, &state, &ide_root()))
        .current_dir(&state)
        .env_clear()
        .env("PATH", path.unwrap_or_default())
        .env("NODE_ENV", "development")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(h) = &home {
        cmd.env("HOME", h);
    }
    if let Some(d) = std::env::var_os("INTELY_ESBUILD_DIR") {
        cmd.env("INTELY_ESBUILD_DIR", d);
    }
    let mut child = cmd.spawn().map_err(|e| EngineError::new("spawn", format!("the harness could not start: {e}")))?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("piped");
    let stderr = child.stderr.take().expect("piped");
    let log = Arc::new(Mutex::new(VecDeque::new()));
    let sink = log.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut l = sink.lock().unwrap();
            if l.len() >= LOG_LINES {
                l.pop_front();
            }
            l.push_back(line.chars().take(300).collect());
        }
    });
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = tx.send(line);
        }
    });
    let kill = |mut c: Child| {
        let _ = c.kill();
        let _ = c.wait();
    };
    let line = match rx.recv_timeout(READY_TIMEOUT) {
        Ok(l) => l,
        Err(_) => {
            let tail = log.lock().unwrap().iter().rev().take(3).cloned().collect::<Vec<_>>().join(" | ");
            kill(child);
            return Err(EngineError::new("timeout", format!("the harness did not become ready in 60 s {tail}")));
        }
    };
    let info: Value = serde_json::from_str(&line).map_err(|_| {
        kill_quiet(&mut child);
        EngineError::new("badReply", "the harness sent an unreadable ready line")
    })?;
    if info["ready"] != Value::Bool(true) {
        let code = info["code"].as_str().unwrap_or("harness").to_owned();
        let msg = info["error"].as_str().unwrap_or("the harness failed").to_owned();
        kill_quiet(&mut child);
        return Err(EngineError::new(&code, msg));
    }
    let port = info["port"].as_u64().and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 1023).ok_or_else(|| {
        kill_quiet(&mut child);
        EngineError::new("badReply", "the harness reported no usable port")
    })?;
    let h = Harness { id: format!("pvc-{port}-{}", std::process::id()), child, stdin, port, info, released: None, log };
    let out = public(&h);
    set.map.lock().unwrap().insert(key, h);
    Ok(out)
}

fn kill_quiet(c: &mut Child) {
    let _ = c.kill();
    let _ = c.wait();
}

/// What the webview gets: the harness's own ready info plus the id and the loopback address.
fn public(h: &Harness) -> Value {
    let mut v = h.info.clone();
    v["id"] = Value::String(h.id.clone());
    v["url"] = Value::String(format!("http://127.0.0.1:{}/", h.port));
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory under the system temp dir, removed on drop (src-tauri has no tempfile dev-dependency).
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Tmp {
            let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let p = std::env::temp_dir().join(format!("intely-pvc-{tag}-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A repo without react: the real harness script must refuse it with a readable code and leave no process or port behind.
    #[test]
    fn a_repo_without_react_is_refused_and_leaves_nothing_running() {
        if harness::find_node(std::env::var_os("PATH").as_deref(), std::env::var_os("HOME").map(PathBuf::from).as_deref()).is_none() {
            return; // no Node on this machine: nothing to run the harness with
        }
        let repo = Tmp::new("repo");
        std::fs::create_dir_all(repo.path().join("src")).unwrap();
        std::fs::write(repo.path().join("package.json"), "{}").unwrap();
        std::fs::write(repo.path().join("src/A.jsx"), "export default () => <div/>").unwrap();
        let state = Tmp::new("state");
        std::env::set_var("INTELY_DATA_DIR", state.path());
        let set = HarnessSet::default();
        let component = validate(repo.path(), "src/A.jsx", "default").unwrap();
        let err = start(&set, component, &HashMap::new()).unwrap_err();
        assert_eq!(err.code, "noReact", "{err:?}");
        assert!(set.ports().is_empty());
        // nothing was written into the repository
        assert!(!repo.path().join(".intely").exists());
        let names: Vec<_> = std::fs::read_dir(repo.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names.len(), 2, "{names:?}");
    }

    #[test]
    fn releasing_or_stopping_an_unknown_harness_is_a_no_op() {
        let set = HarnessSet::default();
        assert!(set.release("pvc-0-0").is_none());
        set.stop_if_idle("pvc-0-0", Instant::now());
        assert!(set.log("pvc-0-0").is_empty());
        set.stop_all();
    }

    #[test]
    fn refuses_what_the_webview_must_not_ask_for() {
        let repo = Tmp::new("repo");
        std::fs::write(repo.path().join("a.jsx"), "").unwrap();
        for (file, export, code) in [("../a.jsx", "default", "badPath"), ("a.jsx", "x;y", "badExport"), ("a.css", "default", "badFile"), ("b.jsx", "default", "notFound")] {
            assert_eq!(validate(repo.path(), file, export).unwrap_err().code, code, "{file}");
        }
    }
}
