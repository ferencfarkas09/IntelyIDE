//! The device operations against the fake `xcrun` / `adb` / `emulator` of scripts/devices-fixture (no device needed).

#![cfg(unix)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use intely_core::jail::Jail;
use intely_devices::types::{AdbState, Level, SimState};
use intely_devices::{Devices, LogHub, LogTarget, Tools};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/devices-fixture")
}

fn tools() -> Tools {
    let bin = fixture().join("fake-bin");
    Tools { xcrun: Some(bin.join("xcrun")), adb: Some(bin.join("adb")), emulator: Some(bin.join("emulator")) }
}

fn env(mode: &str, log: Option<&Path>) -> HashMap<String, String> {
    let mut e = HashMap::from([("FAKE_MODE".to_owned(), mode.to_owned()), ("PATH".to_owned(), "/usr/bin:/bin".to_owned())]);
    if let Some(l) = log {
        e.insert("FAKE_DEVICES_LOG".to_owned(), l.to_string_lossy().into_owned());
    }
    e
}

fn devices(allow: bool) -> Devices {
    Devices::new(Arc::new(Jail::read_only()), Arc::new(move || allow))
}

fn wait_until(what: &str, mut f: impl FnMut() -> bool) {
    let t = Instant::now();
    while !f() {
        assert!(t.elapsed() < Duration::from_secs(10), "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn the_lists_come_from_the_three_tools() {
    let list = devices(true).list(Path::new("/"), &tools(), &env("ok", None)).unwrap();
    assert_eq!(list.ios.len(), 4);
    assert_eq!(list.ios[0].state, SimState::Booted);
    assert_eq!(list.avds, ["Pixel_7_API_34", "Pixel_Tablet_API_33"]);
    assert_eq!(list.android.len(), 4);
    assert_eq!(list.android[2].state, AdbState::Unauthorized);
    assert!(list.tools.iter().all(|t| t.available && t.hint.is_none()) && list.notes.is_empty());
}

#[test]
fn a_missing_tool_is_a_disabled_state_with_a_hint_not_an_error() {
    let none = Tools::default();
    let list = devices(true).list(Path::new("/"), &none, &env("ok", None)).unwrap();
    assert!(list.ios.is_empty() && list.avds.is_empty() && list.android.is_empty());
    let hints: Vec<_> = list.tools.iter().map(|t| (t.name.as_str(), t.available, t.hint.as_deref().is_some())).collect();
    assert_eq!(hints, [("xcrun", false, true), ("adb", false, true), ("emulator", false, true)]);
    assert_eq!(devices(true).boot_avd(Path::new("/"), &none, &env("ok", None), "Pixel_7_API_34").unwrap_err().code, "toolMissing");
}

#[test]
fn tool_lookup_uses_the_path_and_the_sdk() {
    let sdk = tempfile::tempdir().unwrap();
    for (dir, bin) in [("platform-tools", "adb"), ("emulator", "emulator")] {
        let p = sdk.path().join(dir);
        std::fs::create_dir_all(&p).unwrap();
        std::fs::copy(fixture().join("fake-bin").join(bin), p.join(bin)).unwrap();
    }
    let found = Tools::find(&HashMap::from([("PATH".to_owned(), "/nonexistent".to_owned())]), Some(sdk.path()));
    assert!(found.adb.is_some_and(|p| p.starts_with(sdk.path())) && found.emulator.is_some());
    let by_path = Tools::find(&HashMap::from([("PATH".to_owned(), fixture().join("fake-bin").to_string_lossy().into_owned())]), None);
    assert!(by_path.adb.is_some() && by_path.emulator.is_some());
}

#[test]
fn garbled_and_failing_tools_give_empty_lists_and_a_note() {
    let list = devices(true).list(Path::new("/"), &tools(), &env("garbled", None)).unwrap();
    assert_eq!(list.ios.len(), 1);
    assert_eq!(list.avds, ["Good_One"]);
    assert_eq!(list.android.len(), 1);
    let failed = devices(true).list(Path::new("/"), &tools(), &env("fail", None)).unwrap();
    assert!(failed.ios.is_empty() && failed.android.is_empty());
    assert_eq!(failed.notes, ["simctlFailed", "emulatorFailed", "adbFailed"]);
    assert!(devices(true).list(Path::new("/"), &tools(), &env("empty", None)).unwrap().ios.is_empty());
}

#[test]
fn a_hanging_tool_is_ended_by_the_timeout() {
    let t = Instant::now();
    let list = devices(true).with_timeout(Duration::from_millis(500)).list(Path::new("/"), &Tools { xcrun: tools().xcrun, ..Tools::default() }, &env("hang", None)).unwrap();
    assert_eq!(list.notes, ["simctlTimeout"]);
    assert!(t.elapsed() < Duration::from_secs(10));
}

#[test]
fn nothing_starts_in_read_only_mode_without_allow_processes() {
    let err = devices(false).list(Path::new("/"), &tools(), &env("ok", None)).unwrap_err();
    assert_eq!(err.code, intely_core::jail::READ_ONLY);
    let hub = LogHub::new();
    assert!(hub.start(&devices(false), Path::new("/"), &tools(), &env("ok", None), &LogTarget::Android { serial: None }).is_err());
    assert!(devices(false).boot_simulator(Path::new("/"), &tools(), &env("ok", None), "6D0F0B7E-1A2B-4C3D-8E4F-5A6B7C8D9E01").is_err());
}

#[test]
fn boot_and_shutdown_pass_only_validated_ids_to_the_tools() {
    let log = tempfile::NamedTempFile::new().unwrap();
    let e = env("ok", Some(log.path()));
    let d = devices(true);
    let udid = "6D0F0B7E-1A2B-4C3D-8E4F-5A6B7C8D9E02";
    d.boot_simulator(Path::new("/"), &tools(), &e, udid).unwrap();
    d.shutdown_simulator(Path::new("/"), &tools(), &e, udid).unwrap();
    d.shutdown_android(Path::new("/"), &tools(), &e, "emulator-5554").unwrap();
    d.boot_avd(Path::new("/"), &tools(), &e, "Pixel_7_API_34").unwrap();
    wait_until("the emulator call", || std::fs::read_to_string(log.path()).unwrap().contains("emulator -avd Pixel_7_API_34"));
    let calls = std::fs::read_to_string(log.path()).unwrap();
    assert!(calls.contains(&format!("xcrun simctl boot {udid}")) && calls.contains(&format!("xcrun simctl shutdown {udid}")) && calls.contains("adb -s emulator-5554 emu kill"), "{calls}");
    for evil in ["x; reboot", "--all", "", "$(id)"] {
        assert_eq!(d.boot_simulator(Path::new("/"), &tools(), &e, evil).unwrap_err().code, "invalidDevice");
        assert_eq!(d.boot_avd(Path::new("/"), &tools(), &e, evil).unwrap_err().code, "invalidDevice");
    }
    assert_eq!(d.shutdown_android(Path::new("/"), &tools(), &e, "R58M12ABCDE").unwrap_err().code, "invalidDevice", "a physical phone is not shut down from here");
    let after = std::fs::read_to_string(log.path()).unwrap();
    assert_eq!(after, calls, "a refused id never reached a tool");
}

#[test]
fn booting_a_booted_simulator_is_not_an_error() {
    devices(true).boot_simulator(Path::new("/"), &tools(), &env("booted", None), "6D0F0B7E-1A2B-4C3D-8E4F-5A6B7C8D9E01").unwrap();
    let err = devices(true).boot_simulator(Path::new("/"), &tools(), &env("fail", None), "6D0F0B7E-1A2B-4C3D-8E4F-5A6B7C8D9E01").unwrap_err();
    assert_eq!(err.code, "deviceFailed");
}

#[test]
fn the_android_stream_is_read_masked_and_classified_until_it_ends() {
    let hub = LogHub::new();
    hub.start(&devices(true), Path::new("/"), &tools(), &env("ok", None), &LogTarget::Android { serial: Some("emulator-5554".into()) }).unwrap();
    wait_until("the stream to end", || !hub.chunk("android", 0).running);
    let c = hub.chunk("android", 0);
    assert_eq!(c.exit_code, Some(0));
    let levels: Vec<Level> = c.entries.iter().map(|e| e.level).collect();
    assert_eq!(levels, [Level::Info, Level::Info, Level::Warn, Level::Error, Level::Error, Level::Error]);
    assert!(c.entries.iter().any(|e| e.text.contains("Fatal signal 11")));
    hub.clear("android");
    assert!(hub.chunk("android", c.start_seq + c.entries.len() as u32).entries.is_empty());
}

#[test]
fn the_ios_stream_masks_secrets_and_a_stuck_stream_can_be_stopped() {
    let hub = LogHub::new();
    let target = LogTarget::Ios { udid: None, process: Some("MyApp".into()) };
    hub.start(&devices(true), Path::new("/"), &tools(), &env("ok", None), &target).unwrap();
    wait_until("the stream to end", || !hub.chunk("ios", 0).running);
    let c = hub.chunk("ios", 0);
    assert!(c.entries.iter().any(|e| e.text.contains("Invariant Violation")));
    assert!(c.entries.iter().all(|e| !e.text.contains("ghp_xxxxxxxxxxxx")), "{:?}", c.entries);
    // A stream that never ends (the hang mode keeps `sleep` alive) stops on request.
    let hub = LogHub::new();
    hub.start(&devices(true), Path::new("/"), &Tools { adb: tools().adb, ..Tools::default() }, &env("hang", None), &LogTarget::Android { serial: None }).unwrap();
    assert!(hub.chunk("android", 0).running);
    hub.stop("android");
    wait_until("the stream to stop", || !hub.chunk("android", 0).running);
}

fn alive(pid: i32) -> bool {
    intely_core::sys::pid_alive(pid as u32)
}

#[test]
fn a_restarted_stream_keeps_its_state_and_can_still_be_stopped() {
    let hub = LogHub::new();
    let pids = tempfile::NamedTempFile::new().unwrap();
    let mut e = env("hang", None);
    e.insert("FAKE_PIDS".to_owned(), pids.path().to_string_lossy().into_owned());
    let only_adb = Tools { adb: tools().adb, ..Tools::default() };
    let target = LogTarget::Android { serial: None };
    hub.start(&devices(true), Path::new("/"), &only_adb, &e, &target).unwrap();
    wait_until("the first stream", || std::fs::read_to_string(pids.path()).unwrap().lines().count() == 1);
    hub.start(&devices(true), Path::new("/"), &only_adb, &e, &target).unwrap();
    wait_until("the second stream", || std::fs::read_to_string(pids.path()).unwrap().lines().count() == 2);
    // The first stream's reader finishes after its kill; it must not touch the state of the second one.
    std::thread::sleep(Duration::from_millis(400));
    assert!(hub.chunk("android", 0).running, "the second stream is running");
    hub.stop("android");
    wait_until("the second stream to stop", || !hub.chunk("android", 0).running);
    let started: Vec<i32> = std::fs::read_to_string(pids.path()).unwrap().lines().filter_map(|l| l.trim().parse().ok()).collect();
    assert_eq!(started.len(), 2);
    wait_until("every stream process to be gone", || started.iter().all(|p| !alive(*p)));
}

#[test]
fn many_restarts_leave_no_process_behind() {
    let hub = LogHub::new();
    let pids = tempfile::NamedTempFile::new().unwrap();
    let mut e = env("hang", None);
    e.insert("FAKE_PIDS".to_owned(), pids.path().to_string_lossy().into_owned());
    let only_adb = Tools { adb: tools().adb, ..Tools::default() };
    let target = LogTarget::Android { serial: None };
    for _ in 0..40 {
        hub.start(&devices(true), Path::new("/"), &only_adb, &e, &target).unwrap();
    }
    std::thread::sleep(Duration::from_millis(300));
    assert!(hub.chunk("android", 0).running);
    hub.stop("android");
    wait_until("the stream to stop", || !hub.chunk("android", 0).running);
    let started: Vec<i32> = std::fs::read_to_string(pids.path()).unwrap().lines().filter_map(|l| l.trim().parse().ok()).collect();
    assert!(!started.is_empty());
    wait_until("every stream process to be gone", || started.iter().all(|p| !alive(*p)));
}

#[test]
fn a_background_daemon_that_keeps_the_pipe_open_does_not_block_the_list() {
    // `adb devices` starts the adb server, which inherits the pipes and outlives the call.
    let t = Instant::now();
    let list = devices(true).list(Path::new("/"), &Tools { adb: tools().adb, ..Tools::default() }, &env("daemon", None)).unwrap();
    assert_eq!(list.android.len(), 4, "what was printed before the exit is used: {:?}", list.notes);
    assert!(t.elapsed() < Duration::from_secs(10), "{:?}", t.elapsed());
}
