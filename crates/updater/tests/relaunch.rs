//! U4: the relaunch and watchdog script ((design notes: updater-spec) Appendix D, 10.2 `relaunch`).
//! The shipped text is run with `/bin/sh` against fixture directories and a fake `open`. Real time
//! is used (the script sleeps with absolute `/bin/sleep`); where a cap is 10 minutes the cap
//! constant is scaled in a COPY of the text and the substitution is asserted, so the branch after
//! the cap is still exercised.
mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use common::fixture_app::{make_app, AppSpec};
use intely_updater::relaunch::{self, RelaunchArgs, SCRIPT};
use intely_updater::stage::create_stage_dir;
use intely_updater::state::Token;
use intely_updater::swap::{swap_in_with, Method, SwapSpec, SystemFs};

const DIR: &str = "IntelyIDE.app";

fn version_at(app: &Path) -> Option<String> {
    let v = plist::Value::from_file(app.join("Contents/Info.plist")).ok()?;
    Some(v.as_dictionary()?.get("CFBundleShortVersionString")?.as_string()?.to_string())
}

/// A process the test started; killed and reaped on drop.
struct Proc(Child);

impl Proc {
    fn sleeper(secs: u32) -> Proc {
        Proc(Command::new("/bin/sleep").arg(secs.to_string()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap())
    }
    fn pid(&self) -> u32 {
        self.0.id()
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A pid that existed and is gone (reaped, so `kill -0` fails).
fn dead_pid() -> u32 {
    let mut c = Command::new("/usr/bin/true").spawn().unwrap();
    let pid = c.id();
    c.wait().unwrap();
    pid
}

/// A process that ends by itself after `secs` and is reaped by a helper thread (no zombie that
/// would still answer `kill -0`).
fn short_lived(secs: u32) -> u32 {
    let mut c = Command::new("/bin/sleep").arg(secs.to_string()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let pid = c.id();
    std::thread::spawn(move || {
        let _ = c.wait();
    });
    pid
}

fn wait_timeout(child: &mut Child, dur: Duration) -> Option<ExitStatus> {
    let end = Instant::now() + dur;
    loop {
        if let Some(s) = child.try_wait().unwrap() {
            return Some(s);
        }
        if Instant::now() >= end {
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

struct Rig {
    _tmp: tempfile::TempDir,
    apps: PathBuf,
    app: PathBuf,
    stage: PathBuf,
    state: PathBuf,
    token: Token,
    open_bin: PathBuf,
    open_log: PathBuf,
    env_log: PathBuf,
}

impl Rig {
    /// `apps/IntelyIDE.app` holds the NEW bundle (0.1.1), `<stage>/IntelyIDE.app` the OLD one (0.1.0):
    /// the layout right after a swap.
    fn new() -> Rig {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let apps = root.join("apps");
        fs::create_dir(&apps).unwrap();
        let app = make_app(&apps, DIR, &AppSpec { version: "0.1.1".into(), short_version: "0.1.1".into(), ..Default::default() });
        let stage = create_stage_dir(&apps).unwrap();
        make_app(&stage, DIR, &AppSpec { version: "0.1.0".into(), short_version: "0.1.0".into(), ..Default::default() });
        let state = root.join("state");
        fs::create_dir(&state).unwrap();
        let open_log = root.join("open.log");
        let env_log = root.join("env.log");
        let open_bin = root.join("fake-open");
        fs::write(&open_bin, format!("#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\n/usr/bin/env > '{}'\n", open_log.display(), env_log.display())).unwrap();
        fs::set_permissions(&open_bin, fs::Permissions::from_mode(0o755)).unwrap();
        Rig { _tmp: tmp, apps, app, stage, state, token: Token::new().unwrap(), open_bin, open_log, env_log }
    }

    fn args(&self, pid: u32) -> RelaunchArgs<'_> {
        RelaunchArgs {
            pid,
            app_path: &self.app,
            stage_dir: &self.stage,
            token: self.token.as_str(),
            state_dir: &self.state,
            open_binary: &self.open_bin,
            bundle_dir_name: DIR,
        }
    }

    /// The shipped command.
    fn spawn(&self, pid: u32) -> Child {
        relaunch::command(&self.args(pid)).unwrap().spawn().unwrap()
    }

    /// The same positional parameters with a modified COPY of the script text.
    fn spawn_text(&self, script: &str, pid: u32) -> Child {
        Command::new("/bin/sh")
            .arg("-c")
            .arg(script)
            .arg("intely-relaunch")
            .arg(pid.to_string())
            .arg(&self.app)
            .arg(&self.stage)
            .arg(self.token.as_str())
            .arg(&self.state)
            .arg(&self.open_bin)
            .arg(DIR)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    fn marker(&self, kind: &str) -> PathBuf {
        self.state.join(format!("{kind}-{}", self.token.as_str()))
    }

    fn write_started(&self, pid: u32) {
        fs::write(self.marker("started"), format!("{pid}\n")).unwrap();
    }

    fn touch(&self, kind: &str) {
        fs::write(self.marker(kind), b"").unwrap();
    }

    fn open_calls(&self) -> Vec<String> {
        fs::read_to_string(&self.open_log).map(|s| s.lines().map(str::to_string).collect()).unwrap_or_default()
    }

    fn failed(&self) -> PathBuf {
        self.stage.join(format!("{DIR}.failed"))
    }

    fn assert_rolled_back(&self) {
        assert_eq!(version_at(&self.app).as_deref(), Some("0.1.0"), "the old app must be back at appPath");
        assert_eq!(version_at(&self.failed()).as_deref(), Some("0.1.1"), "the failed new app is kept for diagnosis");
        assert!(self.marker("rolled-back").exists(), "rolled-back marker");
        assert!(!self.stage.join(DIR).exists(), "the old app moved out of the stage slot");
        assert_eq!(self.open_calls(), vec![self.app.display().to_string(); 2], "open: the new app, then the old one");
    }

    fn assert_not_rolled_back(&self) {
        assert_eq!(version_at(&self.app).as_deref(), Some("0.1.1"), "the new app must stay");
        assert_eq!(version_at(&self.stage.join(DIR)).as_deref(), Some("0.1.0"));
        assert!(!self.failed().exists());
        assert!(!self.marker("rolled-back").exists());
    }
}

fn scaled(script: &str, from: &str, to: &str) -> String {
    assert_eq!(script.matches(from).count(), 1, "the constant {from:?} must appear exactly once");
    script.replace(from, to)
}

// ------------------------------------------------------------------------------------------
// The text itself
// ------------------------------------------------------------------------------------------

#[test]
fn script_passes_sh_n() {
    let out = Command::new("/bin/sh").arg("-n").arg("-c").arg(SCRIPT).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn script_interpolates_nothing_and_quotes_every_expansion() {
    assert!(!SCRIPT.contains('`'), "no backticks");
    assert!(!SCRIPT.contains("eval"), "no eval");
    // The spec text says "no `$(`", but its own counter uses arithmetic expansion `$((`: only that is allowed.
    assert_eq!(SCRIPT.matches("$(").count(), SCRIPT.matches("$((").count(), "no command substitution, arithmetic only");
    // Walk the text: outside comments, every `$` is inside double quotes or opens `$((`.
    let b = SCRIPT.as_bytes();
    let (mut i, mut in_q) = (0, false);
    let mut seen = Vec::new();
    while i < b.len() {
        match b[i] {
            b'#' if !in_q => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            b'"' => in_q = !in_q,
            b'$' => {
                let rest = &SCRIPT[i..];
                if rest.starts_with("$((") {
                    // arithmetic on the loop counter only
                    assert!(rest.starts_with("$((i + 1))"), "arithmetic other than the counter: {}", &rest[..rest.len().min(20)]);
                    i += 3;
                    continue;
                }
                assert!(in_q, "unquoted expansion at: {}", &rest[..rest.len().min(24)]);
                let name: String = rest[1..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
                seen.push(name);
            }
            _ => {}
        }
        i += 1;
    }
    assert!(!in_q, "unbalanced quotes");
    for n in &seen {
        assert!(matches!(n.as_str(), "1" | "2" | "3" | "4" | "5" | "6" | "7" | "i" | "OPEN" | "NEWPID"), "unexpected expansion ${n}");
    }
    // Every positional parameter is used.
    for p in ["1", "2", "3", "4", "5", "6", "7"] {
        assert!(seen.iter().any(|n| n == p), "${p} is never used");
    }
}

#[test]
fn command_wiring_and_validation() {
    let r = Rig::new();
    let cmd = relaunch::command(&r.args(4242)).unwrap();
    assert_eq!(cmd.get_program(), "/bin/sh");
    let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect();
    assert_eq!(args[0], "-c");
    assert_eq!(args[1], SCRIPT);
    assert_eq!(args[2], "intely-relaunch");
    assert_eq!(args.len(), 3 + 7, "all seven positional parameters are always passed");
    assert_eq!(args[3], "4242");
    assert_eq!(args[9], DIR);

    let bad = |f: &dyn Fn(&mut RelaunchArgs<'_>)| {
        let mut a = r.args(4242);
        f(&mut a);
        relaunch::command(&a).is_err()
    };
    assert!(bad(&|a| a.pid = 0));
    assert!(bad(&|a| a.token = "short"));
    assert!(bad(&|a| a.token = "ZZZZZZZZZZZZZZZZ"));
    assert!(bad(&|a| a.bundle_dir_name = "../Evil.app"));
    assert!(bad(&|a| a.bundle_dir_name = "NoSuffix"));
    assert!(bad(&|a| a.app_path = Path::new("relative.app")));
    assert!(bad(&|a| a.state_dir = Path::new("/tmp/with\nnewline")));
}

#[test]
fn the_relauncher_runs_with_a_scrubbed_environment() {
    let r = Rig::new();
    r.write_started(dead_pid());
    r.touch("clean-exit");
    let mut c = r.spawn(dead_pid());
    assert!(wait_timeout(&mut c, Duration::from_secs(20)).is_some());
    let env = fs::read_to_string(&r.env_log).unwrap();
    let names: Vec<&str> = env.lines().filter_map(|l| l.split('=').next()).collect();
    assert!(names.contains(&"PATH") && names.contains(&"LANG"), "{names:?}");
    for leaked in ["HOME", "USER", "TMPDIR", "SSH_AUTH_SOCK", "ANTHROPIC_API_KEY"] {
        assert!(!names.contains(&leaked), "{leaked} leaked into the relauncher");
    }
}

// ------------------------------------------------------------------------------------------
// The scenarios
// ------------------------------------------------------------------------------------------

#[test]
fn started_and_confirmed_means_no_rollback() {
    let r = Rig::new();
    let mut c = r.spawn(short_lived(1)); // the old process exits after a second
    let new = Proc::sleeper(60);
    std::thread::sleep(Duration::from_millis(300));
    r.write_started(new.pid());
    std::thread::sleep(Duration::from_millis(1500));
    r.touch("confirmed");
    let st = wait_timeout(&mut c, Duration::from_secs(20)).expect("script must end after the confirm");
    assert!(st.success());
    r.assert_not_rolled_back();
    assert_eq!(r.open_calls(), vec![r.app.display().to_string()], "open once, with the app path");
}

#[test]
fn the_old_process_is_waited_for_before_open() {
    let r = Rig::new();
    let mut c = r.spawn(short_lived(3));
    std::thread::sleep(Duration::from_millis(1200));
    assert!(r.open_calls().is_empty(), "open must wait for the old process to exit");
    r.write_started(Proc::sleeper(30).pid());
    r.touch("confirmed");
    assert!(wait_timeout(&mut c, Duration::from_secs(20)).unwrap().success());
    assert_eq!(r.open_calls().len(), 1);
}

#[test]
fn never_started_rolls_back_after_thirty_seconds() {
    let r = Rig::new();
    let mut c = r.spawn(dead_pid());
    let t0 = Instant::now();
    let st = wait_timeout(&mut c, Duration::from_secs(60)).expect("the watchdog must finish");
    assert!(st.success());
    assert!(t0.elapsed() >= Duration::from_secs(29), "the 30 s window is real: {:?}", t0.elapsed());
    r.assert_rolled_back();
}

#[test]
fn a_started_pid_that_died_without_confirm_rolls_back_at_once() {
    // "Crash before the webview": the new instance wrote its pid first thing and died.
    let r = Rig::new();
    r.write_started(dead_pid());
    let mut c = r.spawn(dead_pid());
    let st = wait_timeout(&mut c, Duration::from_secs(15)).expect("must not wait the 30 s window");
    assert!(st.success());
    r.assert_rolled_back();
}

#[test]
fn an_orphaned_sidecar_with_the_app_path_does_not_count_as_the_new_app() {
    let r = Rig::new();
    r.write_started(dead_pid());
    // A leftover child whose command line contains the app path, still alive.
    let orphan = Proc(Command::new("/bin/sh").arg("-c").arg("sleep 60").arg(&r.app).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap());
    let mut c = r.spawn(dead_pid());
    let st = wait_timeout(&mut c, Duration::from_secs(15)).unwrap();
    assert!(st.success());
    r.assert_rolled_back();
    drop(orphan);
}

#[test]
fn a_clean_exit_before_the_confirm_is_not_a_crash() {
    let r = Rig::new();
    r.write_started(dead_pid());
    r.touch("clean-exit");
    let mut c = r.spawn(dead_pid());
    let st = wait_timeout(&mut c, Duration::from_secs(15)).unwrap();
    assert!(st.success());
    r.assert_not_rolled_back();
    assert_eq!(r.open_calls().len(), 1, "no second open of the old app");
}

#[test]
fn a_living_unconfirmed_app_is_never_rolled_back() {
    let r = Rig::new();
    let new = Proc::sleeper(60);
    r.write_started(new.pid());
    let mut c = r.spawn(dead_pid());
    std::thread::sleep(Duration::from_secs(3));
    assert!(c.try_wait().unwrap().is_none(), "the script keeps waiting while the pid lives");
    r.assert_not_rolled_back();
    let _ = c.kill();
    let _ = c.wait();
}

#[test]
fn after_the_cap_a_living_app_is_still_left_alone() {
    // The 600 s cap is scaled to 3 s in a copy of the text; the branch after the loop is the point.
    let r = Rig::new();
    let new = Proc::sleeper(60);
    r.write_started(new.pid());
    let text = scaled(SCRIPT, "[ \"$i\" -lt 600 ]", "[ \"$i\" -lt 3 ]");
    let mut c = r.spawn_text(&text, dead_pid());
    let st = wait_timeout(&mut c, Duration::from_secs(20)).expect("the scaled cap must end the script");
    assert!(st.success(), "exit 0 after the cap");
    r.assert_not_rolled_back();
    assert_eq!(r.open_calls().len(), 1);
}

#[test]
fn a_late_confirm_inside_the_cap_is_fine() {
    let r = Rig::new();
    let new = Proc::sleeper(60);
    r.write_started(new.pid());
    let mut c = r.spawn(dead_pid());
    std::thread::sleep(Duration::from_secs(4));
    assert!(c.try_wait().unwrap().is_none());
    r.touch("confirmed");
    assert!(wait_timeout(&mut c, Duration::from_secs(10)).unwrap().success());
    r.assert_not_rolled_back();
}

#[test]
fn a_missing_old_app_changes_nothing() {
    let r = Rig::new();
    fs::remove_dir_all(r.stage.join(DIR)).unwrap();
    r.write_started(dead_pid());
    let mut c = r.spawn(dead_pid());
    let st = wait_timeout(&mut c, Duration::from_secs(15)).unwrap();
    assert_eq!(st.code(), Some(1));
    assert_eq!(version_at(&r.app).as_deref(), Some("0.1.1"), "appPath still holds the new app");
    assert!(!r.failed().exists());
    assert!(!r.marker("rolled-back").exists());
    assert_eq!(r.open_calls().len(), 1);
}

/// `chflags uchg` makes the rename of the old bundle fail while the first move still works.
struct Immutable(PathBuf);

impl Immutable {
    fn set(p: &Path) -> Immutable {
        assert!(Command::new("/usr/bin/chflags").arg("uchg").arg(p).status().unwrap().success());
        Immutable(p.to_path_buf())
    }
}

impl Drop for Immutable {
    fn drop(&mut self) {
        let _ = Command::new("/usr/bin/chflags").arg("nouchg").arg(&self.0).status();
    }
}

#[test]
fn when_the_second_move_fails_the_new_app_is_put_back() {
    let r = Rig::new();
    r.write_started(dead_pid());
    let _lock = Immutable::set(&r.stage.join(DIR));
    let mut c = r.spawn(dead_pid());
    let st = wait_timeout(&mut c, Duration::from_secs(15)).unwrap();
    assert_eq!(st.code(), Some(1));
    assert_eq!(version_at(&r.app).as_deref(), Some("0.1.1"), "appPath is never left empty");
    assert!(!r.failed().exists(), "the failed copy was moved back");
    assert!(!r.marker("rolled-back").exists());
    assert_eq!(version_at(&r.stage.join(DIR)).as_deref(), Some("0.1.0"));
}

#[test]
fn an_old_process_that_never_exits_stops_the_script() {
    // 150 x 0.2 s scaled to 5 x 0.2 s.
    let r = Rig::new();
    let old = Proc::sleeper(60);
    let text = scaled(SCRIPT, "[ \"$i\" -gt 150 ]", "[ \"$i\" -gt 5 ]");
    let mut c = r.spawn_text(&text, old.pid());
    let st = wait_timeout(&mut c, Duration::from_secs(20)).unwrap();
    assert_eq!(st.code(), Some(1));
    assert!(r.open_calls().is_empty(), "nothing is opened while the old process lives");
    r.assert_not_rolled_back();
}

#[test]
fn the_three_step_layout_rolls_back_correctly() {
    // Build the layout through the real fallback swap, then let the watchdog roll it back.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let apps = root.join("apps");
    fs::create_dir(&apps).unwrap();
    let app = make_app(&apps, DIR, &AppSpec { version: "0.1.0".into(), short_version: "0.1.0".into(), ..Default::default() });
    let stage = create_stage_dir(&apps).unwrap();
    make_app(&stage, DIR, &AppSpec { version: "0.1.1".into(), short_version: "0.1.1".into(), ..Default::default() });
    let spec = SwapSpec {
        app_path: app.clone(),
        stage_dir: stage.clone(),
        bundle_dir_name: DIR.into(),
        bundle_id: common::fixture_app::TEST_BUNDLE_ID.into(),
        new_short_version: "0.1.1".into(),
        owner_uid: fs::metadata(&apps).unwrap().uid(),
    };
    assert_eq!(swap_in_with(&SystemFs, &spec, Some(Method::ThreeStep)).unwrap().method, Method::ThreeStep);

    let mut r = Rig::new();
    r._tmp = tmp;
    r.apps = apps;
    r.app = app;
    r.stage = stage;
    r.state = root.join("state");
    fs::create_dir_all(&r.state).unwrap();
    let open_bin = root.join("fake-open");
    let open_log = root.join("open.log");
    fs::write(&open_bin, format!("#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\n", open_log.display())).unwrap();
    fs::set_permissions(&open_bin, fs::Permissions::from_mode(0o755)).unwrap();
    r.open_bin = open_bin;
    r.open_log = open_log;
    r.write_started(dead_pid());
    let mut c = r.spawn(dead_pid());
    assert!(wait_timeout(&mut c, Duration::from_secs(15)).unwrap().success());
    r.assert_rolled_back();
}

use std::os::unix::fs::MetadataExt;
