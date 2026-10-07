//! U4: the real-process proof ((design notes: updater-spec) 10.1, gate G5). `#[ignore]`: run in a GUI session with
//!
//! ```text
//! cargo test -p intely-updater --test relaunch_real -- --ignored --test-threads 1 --nocapture
//! ```
//!
//! Real `/usr/bin/open`, real `/bin/sh` watchdog, real swap, real processes: ad-hoc signed
//! `LSBackgroundOnly` fixture apps built from the tiny program of `common/fixture_bin.rs`. The
//! fixture apps live in a temp directory, or under `$INTELY_REAL_APPS_DIR` (for example
//! `~/Applications` or `/Applications`, where macOS App Management applies). The test process plays
//! the role of the old app (it passes a short-lived stand-in pid as the process to wait for) and,
//! where the spec says "the new instance", the fixture program writes the markers itself.
//! Everything started here is killed afterwards.
mod common;

use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

use common::fixture_bin::{have_cc, make_fixture_app, Behavior};
use intely_updater::relaunch::{self, RelaunchArgs, OPEN_BINARY};
use intely_updater::stage::create_stage_dir;
use intely_updater::state::*;
use intely_updater::swap::{swap_in, SwapSpec, SystemFs};
use semver::Version;

fn version_at(app: &Path) -> Option<String> {
    let v = plist::Value::from_file(app.join("Contents/Info.plist")).ok()?;
    Some(v.as_dictionary()?.get("CFBundleShortVersionString")?.as_string()?.to_string())
}

fn read_log(p: &Path) -> Vec<String> {
    fs::read_to_string(p).map(|s| s.lines().map(str::to_string).collect()).unwrap_or_default()
}

fn logged(p: &Path, what: &str) -> Vec<u32> {
    read_log(p).iter().filter_map(|l| l.strip_prefix(&format!("{what} "))).filter_map(|n| n.trim().parse().ok()).collect()
}

fn wait_for(dur: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + dur;
    while Instant::now() < end {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    cond()
}

fn command_of(pid: u32) -> String {
    let o = Command::new("/bin/ps").args(["-p", &pid.to_string(), "-o", "command="]).output().unwrap();
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

fn alive(pid: u32) -> bool {
    PsProbe.alive(pid)
}

fn kill(pid: u32) {
    let _ = Command::new("/bin/kill").args(["-9", &pid.to_string()]).stderr(Stdio::null()).status();
}

/// A stand-in for the old app's process: exits by itself after `secs` and is reaped.
fn short_lived(secs: u32) -> u32 {
    let mut c = Command::new("/bin/sleep").arg(secs.to_string()).spawn().unwrap();
    let pid = c.id();
    std::thread::spawn(move || {
        let _ = c.wait();
    });
    pid
}

struct Real {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    apps: PathBuf,
    app: PathBuf,
    stage: PathBuf,
    dirs: UpdateDirs,
    token: Token,
    uid: u32,
    name: String,
    files: Vec<PathBuf>,
    old_log: PathBuf,
    new_log: PathBuf,
    watchdog: Option<Child>,
}

impl Real {
    /// `new_behavior` adjusts what the NEW app does; the old app only logs its start.
    fn setup(tag: &str, new_behavior: impl FnOnce(&mut Behavior)) -> Real {
        assert!(have_cc(), "/usr/bin/cc is needed to build the fixture program");
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let uid = fs::metadata(&root).unwrap().uid();
        let apps = match std::env::var_os("INTELY_REAL_APPS_DIR") {
            Some(d) => {
                let p = PathBuf::from(d).join(format!("intely-fixture-{}-{tag}", std::process::id()));
                fs::create_dir_all(&p).unwrap();
                p
            }
            None => root.join("apps"),
        };
        fs::create_dir_all(&apps).unwrap();
        let apps = apps.canonicalize().unwrap();
        let dirs = UpdateDirs::new(root.join("state/updates"));
        dirs.ensure().unwrap();
        let name = format!("IntelyFixture{tag}.app");
        let bundle_id = format!("test.example.updater.{}", tag.to_lowercase());
        let old_log = root.join("old.log");
        let new_log = root.join("new.log");
        let token = Token::new().unwrap();
        let old = Behavior { log: Some(old_log.clone()), max_life: Some(40), ..Default::default() };
        let app = make_fixture_app(&apps, &name, &bundle_id, "0.1.0", &old);
        let stage = create_stage_dir(&apps).unwrap();
        let mut nb = Behavior { state_dir: Some(dirs.root().to_path_buf()), token: Some(token.as_str().to_string()), log: Some(new_log.clone()), max_life: Some(40), ..Default::default() };
        new_behavior(&mut nb);
        make_fixture_app(&stage, &name, &bundle_id, "0.1.1", &nb);
        let settings = root.join("state/settings.json");
        fs::write(&settings, b"{\"v\":\"old settings\"}").unwrap();
        let absent = root.join("state/absent.json");
        Real { _tmp: tmp, root, apps, app, stage, dirs, token, uid, name, files: vec![settings, absent], old_log, new_log, watchdog: None }
    }

    fn spec(&self) -> SwapSpec {
        SwapSpec {
            app_path: self.app.clone(),
            stage_dir: self.stage.clone(),
            bundle_dir_name: self.name.clone(),
            bundle_id: format!("test.example.updater.{}", self.name.trim_start_matches("IntelyFixture").trim_end_matches(".app").to_lowercase()),
            new_short_version: "0.1.1".into(),
            owner_uid: self.uid,
        }
    }

    /// A3, A4, A5 exactly as the engine does them, with the real `open` and the real swap.
    fn apply(&mut self, old_pid: u32) {
        // A staged state, then the apply.
        let st = UpdateState::staged("0.1.1", "x64", "IntelyFixture_0.1.1_x64.app.tar.gz", &self.stage, &self.app, SystemTime::now(), 1);
        write_state(&self.dirs, &st).unwrap();
        begin_apply_with(&self.dirs, &ApplyBegin { from: "0.1.0", to: "0.1.1", stage_dir: &self.stage, app_path: &self.app, snapshot_files: &self.files }, self.token.clone()).unwrap();
        let swapped = swap_in(&SystemFs, &self.spec()).unwrap();
        eprintln!("swap method: {:?}", swapped.method);
        let args = RelaunchArgs {
            pid: old_pid,
            app_path: &self.app,
            stage_dir: &self.stage,
            token: self.token.as_str(),
            state_dir: self.dirs.root(),
            open_binary: Path::new(OPEN_BINARY),
            bundle_dir_name: &self.name,
        };
        self.watchdog = Some(relaunch::spawn(&args).unwrap());
    }

    fn wait_watchdog(&mut self, dur: Duration) -> Option<std::process::ExitStatus> {
        let end = Instant::now() + dur;
        let w = self.watchdog.as_mut().unwrap();
        loop {
            if let Some(s) = w.try_wait().unwrap() {
                return Some(s);
            }
            if Instant::now() >= end {
                return None;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn started_pid(&self) -> Option<u32> {
        fs::read_to_string(self.dirs.marker(Marker::Started, &self.token)).ok()?.trim().parse().ok()
    }

    fn recover_as(&self, running: &str) -> RecoverOutcome {
        let running = Version::parse(running).unwrap();
        recover(&RecoverCtx {
            dirs: &self.dirs,
            running: &running,
            app_path: Some(&self.app),
            bundle_dir_name: &self.name,
            uid: self.uid,
            now: SystemTime::now(),
            boot_ready: true,
            withdrawn: &[],
            stage_check: &|_| Ok(()),
            log: None,
        })
    }

    fn boot_as(&self, running: &str, pid: u32) -> BootOutcome {
        let running = Version::parse(running).unwrap();
        early_boot(&BootCtx { dirs: &self.dirs, running: &running, pid, snapshot_files: &self.files, log: None, now: SystemTime::now() })
    }
}

impl Drop for Real {
    fn drop(&mut self) {
        if let Some(w) = self.watchdog.as_mut() {
            let _ = w.kill();
            let _ = w.wait();
        }
        for log in [&self.old_log, &self.new_log] {
            for what in ["start", "child"] {
                for pid in logged(log, what) {
                    kill(pid);
                }
            }
        }
        if let Some(p) = self.started_pid() {
            kill(p);
        }
        // An apps directory outside the temp root (INTELY_REAL_APPS_DIR) is removed too.
        if !self.apps.starts_with(&self.root) {
            let _ = fs::remove_dir_all(&self.apps);
        }
    }
}

/// The app opened by the watchdog must run the bundle at the canonical path.
fn assert_runs_from(pid: u32, app: &Path) {
    let cmd = command_of(pid);
    assert!(cmd.starts_with(&app.display().to_string()), "pid {pid} runs {cmd:?}, expected a binary under {}", app.display());
}

#[test]
#[ignore = "real processes and LaunchServices: run in a GUI session"]
fn real_update_confirms_and_the_old_bundle_is_removed() {
    let mut r = Real::setup("Ok", |b| {
        b.write_started = true;
        b.confirm_after = Some(2);
    });
    r.apply(short_lived(1));
    // The watchdog waits for the stand-in, opens the new app; the new app writes started, then confirmed.
    assert!(wait_for(Duration::from_secs(40), || r.dirs.marker_exists(Marker::Confirmed, &r.token)), "the new app never confirmed; new.log={:?}", read_log(&r.new_log));
    let pid = r.started_pid().expect("started marker with the pid");
    assert!(alive(pid));
    assert_runs_from(pid, &r.app);
    assert_eq!(version_at(&r.app).as_deref(), Some("0.1.1"));
    // The new instance's recover() after the webview is ready: confirm, delete the old bundle.
    let out = r.recover_as("0.1.1");
    assert!(matches!(out, RecoverOutcome::Confirmed { .. }), "{out:?}");
    assert!(!r.stage.exists());
    // The watchdog ended without touching anything.
    let st = r.wait_watchdog(Duration::from_secs(20)).expect("watchdog must end after the confirm");
    assert!(st.success());
    assert_eq!(version_at(&r.app).as_deref(), Some("0.1.1"));
    assert!(!r.dirs.marker_exists(Marker::RolledBack, &r.token));
    kill(pid);
}

#[test]
#[ignore = "real processes and LaunchServices: run in a GUI session"]
fn real_crash_after_start_rolls_the_bundle_and_the_state_back() {
    let mut r = Real::setup("Crash", |b| {
        b.write_started = true;
        b.exit_after = Some(1); // starts, then dies before it confirms
    });
    let settings = r.files[0].clone();
    r.apply(short_lived(1));
    // The new version "migrates" the small state before it dies.
    fs::write(&settings, b"{\"v\":\"MIGRATED BY 0.1.1\"}").unwrap();
    fs::write(&r.files[1], b"created by 0.1.1").unwrap();
    let st = r.wait_watchdog(Duration::from_secs(60)).expect("watchdog must finish");
    assert!(st.success(), "{st:?}");
    assert!(r.dirs.marker_exists(Marker::RolledBack, &r.token));
    assert_eq!(version_at(&r.app).as_deref(), Some("0.1.0"), "the old bundle must be back");
    assert_eq!(version_at(&r.stage.join(format!("{}.failed", r.name))).as_deref(), Some("0.1.1"));
    // The watchdog opened the old app again: it logged its start from the canonical path.
    assert!(wait_for(Duration::from_secs(30), || !logged(&r.old_log, "start").is_empty()), "the old app never started again");
    let old_pid = *logged(&r.old_log, "start").last().unwrap();
    assert_runs_from(old_pid, &r.app);
    // The old instance's first act: restore the snapshot.
    let b = r.boot_as("0.1.0", old_pid);
    assert!(matches!(b, BootOutcome::RolledBack { .. }), "{b:?}");
    assert_eq!(fs::read_to_string(&settings).unwrap(), "{\"v\":\"old settings\"}");
    assert!(!r.files[1].exists());
    assert_eq!(r.recover_as("0.1.0"), RecoverOutcome::RolledBack { failed_version: "0.1.1".into() });
    ack_rollback(&r.dirs);
    assert!(read_state(&r.dirs).is_none());
}

#[test]
#[ignore = "real processes and LaunchServices: run in a GUI session (takes about 35 s)"]
fn real_app_that_never_starts_is_rolled_back_after_the_window() {
    let mut r = Real::setup("Dead", |b| {
        b.write_started = false;
        b.exit_after = Some(0); // exits at once without writing anything
    });
    let t0 = Instant::now();
    r.apply(short_lived(1));
    let st = r.wait_watchdog(Duration::from_secs(80)).expect("watchdog must finish");
    assert!(st.success());
    assert!(t0.elapsed() >= Duration::from_secs(29), "the 30 s window is real: {:?}", t0.elapsed());
    assert_eq!(version_at(&r.app).as_deref(), Some("0.1.0"));
    assert!(r.dirs.marker_exists(Marker::RolledBack, &r.token));
    assert!(wait_for(Duration::from_secs(30), || !logged(&r.old_log, "start").is_empty()), "the old app never started again");
}

#[test]
#[ignore = "real processes and LaunchServices: run in a GUI session"]
fn real_orphan_sidecar_does_not_keep_a_crashed_app_alive() {
    let mut r = Real::setup("Orphan", |b| {
        b.write_started = true;
        b.spawn_child = true; // an orphan whose command line contains the app path
        b.exit_after = Some(1);
    });
    r.apply(short_lived(1));
    let st = r.wait_watchdog(Duration::from_secs(60)).expect("watchdog must finish");
    assert!(st.success());
    let orphans = logged(&r.new_log, "child");
    assert_eq!(orphans.len(), 1);
    assert!(alive(orphans[0]), "the orphan is still running while the watchdog decided");
    assert_eq!(version_at(&r.app).as_deref(), Some("0.1.0"), "rolled back although a process with the app path lives");
    kill(orphans[0]);
}

#[test]
#[ignore = "real processes and LaunchServices: run in a GUI session"]
fn real_living_app_without_confirm_is_left_alone() {
    let mut r = Real::setup("Hang", |b| {
        b.write_started = true; // no confirm, no exit
    });
    r.apply(short_lived(1));
    assert!(wait_for(Duration::from_secs(40), || r.started_pid().is_some()), "the new app never started");
    std::thread::sleep(Duration::from_secs(5));
    assert!(r.watchdog.as_mut().unwrap().try_wait().unwrap().is_none(), "the watchdog keeps waiting");
    assert_eq!(version_at(&r.app).as_deref(), Some("0.1.1"));
    assert_eq!(version_at(&r.stage.join(&r.name)).as_deref(), Some("0.1.0"));
    assert!(!r.dirs.marker_exists(Marker::RolledBack, &r.token));
}

#[test]
#[ignore = "real processes and LaunchServices: run in a GUI session"]
fn real_quit_before_confirm_is_not_a_crash() {
    let mut r = Real::setup("Quit", |b| {
        b.write_started = true;
        b.clean_exit = true;
        b.exit_after = Some(1);
    });
    r.apply(short_lived(1));
    let st = r.wait_watchdog(Duration::from_secs(60)).expect("watchdog must finish");
    assert!(st.success());
    assert_eq!(version_at(&r.app).as_deref(), Some("0.1.1"), "a clean exit must not roll back");
    assert!(!r.dirs.marker_exists(Marker::RolledBack, &r.token));
}
