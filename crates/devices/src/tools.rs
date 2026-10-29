//! Finding and running `xcrun`, `adb` and `emulator`. Short calls (lists, boot, shutdown) run to completion with a timeout
//! and a cap on the output; the emulator itself is started detached. Every start asks the jail first.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use intely_core::jail::Jail;
use intely_core::{code, EngineError};

use crate::parse::{parse_adb, parse_avds, parse_simctl, valid_avd, valid_serial, valid_udid};
use crate::types::{DeviceList, ToolStatus};

const CALL_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_OUT: usize = 4 * 1024 * 1024;

/// Where each tool is, if it is installed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tools {
    pub xcrun: Option<PathBuf>,
    pub adb: Option<PathBuf>,
    pub emulator: Option<PathBuf>,
}

fn is_exec(p: &Path) -> bool {
    p.metadata().is_ok_and(|m| m.is_file() && intely_core::sys::is_executable(&m, p))
}

impl Tools {
    /// Looks on the `PATH` of `env` (the login-shell environment) and in the Android SDK. Starts nothing.
    pub fn find(env: &HashMap<String, String>, sdk: Option<&Path>) -> Self {
        let path = env.get("PATH").cloned().or_else(|| std::env::var("PATH").ok()).unwrap_or_default();
        let from = |sub: &str, bin: &str| sdk.map(|s| s.join(sub).join(intely_core::sys::executable_names(bin).remove(0))).filter(|p| is_exec(p));
        Self {
            xcrun: if cfg!(target_os = "macos") { Some(PathBuf::from("/usr/bin/xcrun")).filter(|p| is_exec(p)) } else { None },
            adb: intely_core::sys::find_in_path(&path, "adb").filter(|p| p.is_absolute()).or_else(|| from("platform-tools", "adb")),
            emulator: intely_core::sys::find_in_path(&path, "emulator").filter(|p| p.is_absolute()).or_else(|| from("emulator", "emulator")),
        }
    }

    pub fn status(&self) -> Vec<ToolStatus> {
        let mk = |name: &str, found: &Option<PathBuf>, hint: &str| ToolStatus { name: name.to_owned(), available: found.is_some(), hint: found.is_none().then(|| hint.to_owned()) };
        vec![
            mk("xcrun", &self.xcrun, if cfg!(target_os = "macos") { "xcode" } else { "macOnly" }),
            mk("adb", &self.adb, "androidPlatformTools"),
            mk("emulator", &self.emulator, "androidEmulator"),
        ]
    }
}

/// Output collected by a reader thread. The thread ends at end of file; a background daemon that inherited the pipe can keep
/// it open long after the tool exited, so the caller takes what is there after a short drain instead of joining.
#[derive(Default)]
struct Collected {
    bytes: Mutex<Vec<u8>>,
    done: AtomicBool,
}

impl Collected {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes.lock().unwrap_or_else(|e| e.into_inner())).into_owned()
    }
}

/// How long the output is drained after the tool exited.
const DRAIN: Duration = Duration::from_millis(500);

fn read_capped(mut r: impl Read + Send + 'static) -> Arc<Collected> {
    let out = Arc::new(Collected::default());
    let sink = out.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        while let Ok(n) = r.read(&mut chunk) {
            if n == 0 {
                break;
            }
            let mut buf = sink.bytes.lock().unwrap_or_else(|e| e.into_inner());
            if buf.len() < MAX_OUT {
                let room = MAX_OUT - buf.len();
                buf.extend_from_slice(&chunk[..n.min(room)]);
            }
        }
        sink.done.store(true, Ordering::SeqCst);
    });
    out
}

/// Waits (at most [`DRAIN`]) for the readers to reach end of file.
fn drain(readers: &[&Collected]) {
    let until = Instant::now() + DRAIN;
    while Instant::now() < until && !readers.iter().all(|r| r.done.load(Ordering::SeqCst)) {
        std::thread::sleep(Duration::from_millis(10));
    }
}

struct Captured {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Applies the environment shared by every child: the login `PATH`, no `INTELY_*`, no prompts.
pub(crate) fn prepare(cmd: &mut Command, env: &HashMap<String, String>) {
    cmd.stdin(Stdio::null());
    for key in std::env::vars_os().filter_map(|(k, _)| k.into_string().ok()).filter(|k| k.starts_with("INTELY_")) {
        cmd.env_remove(key);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    intely_core::sys::NewGroup::new_group(cmd);
}


fn run_capture(program: &Path, args: &[&str], env: &HashMap<String, String>, timeout: Duration) -> Result<Captured, EngineError> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    prepare(&mut cmd, env);
    let mut child = cmd.spawn().map_err(|e| EngineError::new(code::IO, format!("could not start {}: {e}", program.file_name().map(|n| n.to_string_lossy()).unwrap_or_default())))?;
    let out = read_capped(child.stdout.take().expect("piped"));
    let err = read_capped(child.stderr.take().expect("piped"));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if started.elapsed() > timeout => {
                intely_core::sys::kill_group(child.id() as _, true);
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => break None,
        }
    };
    drain(&[&out, &err]);
    match status {
        Some(s) => Ok(Captured { code: s.code(), stdout: out.text(), stderr: err.text() }),
        None => Err(EngineError::new("timeout", "the tool did not answer in time")),
    }
}

/// The device operations. The jail decision is the same as for the Run panel: refused in read-only mode unless "Allow
/// processes" is on.
pub struct Devices {
    jail: Arc<Jail>,
    allow: Arc<dyn Fn() -> bool + Send + Sync>,
    timeout: Duration,
}

impl Devices {
    pub fn new(jail: Arc<Jail>, allow: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        Self { jail, allow, timeout: CALL_TIMEOUT }
    }

    /// How long a short call may take before it is ended.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn check(&self, cwd: &Path) -> Result<(), EngineError> {
        intely_runner::guard::check_process(&self.jail, (self.allow)(), cwd)
    }

    /// The jail's environment for children (hardened git and friends), then the caller's login environment.
    pub fn child_env(&self, login: &HashMap<String, String>) -> HashMap<String, String> {
        let mut env = login.clone();
        for (k, v) in self.jail.env() {
            env.insert(k.to_string(), v.to_string());
        }
        env
    }

    pub fn list(&self, cwd: &Path, tools: &Tools, env: &HashMap<String, String>) -> Result<DeviceList, EngineError> {
        self.check(cwd)?;
        let mut list = DeviceList { tools: tools.status(), ..DeviceList::default() };
        if let Some(x) = &tools.xcrun {
            match run_capture(x, &["simctl", "list", "devices", "available", "-j"], env, self.timeout) {
                Ok(c) if c.code == Some(0) => list.ios = parse_simctl(&c.stdout),
                Ok(_) => list.notes.push("simctlFailed".to_owned()),
                Err(_) => list.notes.push("simctlTimeout".to_owned()),
            }
        }
        if let Some(e) = &tools.emulator {
            match run_capture(e, &["-list-avds"], env, self.timeout) {
                Ok(c) if c.code == Some(0) => list.avds = parse_avds(&c.stdout),
                Ok(_) => list.notes.push("emulatorFailed".to_owned()),
                Err(_) => list.notes.push("emulatorTimeout".to_owned()),
            }
        }
        if let Some(a) = &tools.adb {
            match run_capture(a, &["devices", "-l"], env, self.timeout) {
                Ok(c) if c.code == Some(0) => list.android = parse_adb(&c.stdout),
                Ok(_) => list.notes.push("adbFailed".to_owned()),
                Err(_) => list.notes.push("adbTimeout".to_owned()),
            }
        }
        Ok(list)
    }

    fn need<'a>(tool: &'a Option<PathBuf>, name: &str) -> Result<&'a Path, EngineError> {
        tool.as_deref().ok_or_else(|| EngineError::new("toolMissing", format!("{name} is not installed")))
    }

    fn simctl(&self, cwd: &Path, tools: &Tools, env: &HashMap<String, String>, verb: &str, udid: &str) -> Result<(), EngineError> {
        self.check(cwd)?;
        if !valid_udid(udid) {
            return Err(EngineError::new("invalidDevice", "not a simulator id"));
        }
        let c = run_capture(Self::need(&tools.xcrun, "xcrun")?, &["simctl", verb, udid], env, self.timeout)?;
        // Booting a booted simulator (and shutting down a shut-down one) exits 149 with "Unable to boot device in current state".
        let benign = c.stderr.contains("current state: Booted") || c.stderr.contains("current state: Shutdown");
        if c.code == Some(0) || benign {
            Ok(())
        } else {
            Err(EngineError::new("deviceFailed", crate::parse::clean(c.stderr.lines().next().unwrap_or("simctl failed"), 200)))
        }
    }

    /// Boots the simulator and brings the Simulator app to the front.
    pub fn boot_simulator(&self, cwd: &Path, tools: &Tools, env: &HashMap<String, String>, udid: &str) -> Result<(), EngineError> {
        self.simctl(cwd, tools, env, "boot", udid)?;
        if cfg!(target_os = "macos") {
            let mut cmd = Command::new("/usr/bin/open");
            cmd.args(["-a", "Simulator"]).stdout(Stdio::null()).stderr(Stdio::null());
            prepare(&mut cmd, env);
            let _ = cmd.status();
        }
        Ok(())
    }

    pub fn shutdown_simulator(&self, cwd: &Path, tools: &Tools, env: &HashMap<String, String>, udid: &str) -> Result<(), EngineError> {
        self.simctl(cwd, tools, env, "shutdown", udid)
    }

    /// Starts the emulator window detached (it outlives the app on purpose: closing the IDE should not close a device the
    /// person is looking at). The call returns as soon as the process exists.
    pub fn boot_avd(&self, cwd: &Path, tools: &Tools, env: &HashMap<String, String>, avd: &str) -> Result<(), EngineError> {
        self.check(cwd)?;
        if !valid_avd(avd) {
            return Err(EngineError::new("invalidDevice", "not an emulator name"));
        }
        let mut cmd = Command::new(Self::need(&tools.emulator, "emulator")?);
        cmd.args(["-avd", avd]).stdout(Stdio::null()).stderr(Stdio::null());
        prepare(&mut cmd, env);
        let mut child = cmd.spawn().map_err(|e| EngineError::new(code::IO, format!("could not start the emulator: {e}")))?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }

    pub fn shutdown_android(&self, cwd: &Path, tools: &Tools, env: &HashMap<String, String>, serial: &str) -> Result<(), EngineError> {
        self.check(cwd)?;
        if !valid_serial(serial) || !serial.starts_with("emulator-") {
            return Err(EngineError::new("invalidDevice", "only emulators can be shut down from here"));
        }
        let c = run_capture(Self::need(&tools.adb, "adb")?, &["-s", serial, "emu", "kill"], env, self.timeout)?;
        if c.code == Some(0) {
            Ok(())
        } else {
            Err(EngineError::new("deviceFailed", crate::parse::clean(c.stderr.lines().next().unwrap_or("adb failed"), 200)))
        }
    }
}
