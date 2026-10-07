//! U4: state.json, snapshots, markers, lock, log, `early_boot` and `recover()`
//! ((design notes: updater-spec) 10.2 `state`, 7.2 failure cases by stage, T21, T29).
mod common;

use std::cell::{Cell, RefCell};
use std::fs;
use std::io;
use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use common::fixture_app::{make_app, AppSpec, TEST_BUNDLE_ID};
use intely_updater::keys::Revocations;
use intely_updater::relaunch::{self, RelaunchArgs};
use intely_updater::stage::{create_stage_dir, STAGE_MARKER};
use intely_updater::state::*;
use intely_updater::swap::{repair_interrupted, swap_in, FsOps, SwapSpec, SystemFs};
use intely_updater::version::Channel;
use intely_updater::{ErrorCode, UpdateError};
use semver::Version;

const DIR: &str = "IntelyIDE.app";
const TAR: &str = "IntelyIDE_0.1.1_x64.app.tar.gz";

fn v(s: &str) -> Version {
    Version::parse(s).unwrap()
}

fn version_at(app: &Path) -> Option<String> {
    let v = plist::Value::from_file(app.join("Contents/Info.plist")).ok()?;
    Some(v.as_dictionary()?.get("CFBundleShortVersionString")?.as_string()?.to_string())
}

struct Env {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    dirs: UpdateDirs,
    apps: PathBuf,
    app: PathBuf,
    stage: PathBuf,
    uid: u32,
    /// settings.json, registry.json (exist) and absent.json (does not exist).
    files: Vec<PathBuf>,
}

impl Env {
    fn tarball(&self) -> PathBuf {
        self.dirs.dl_dir().join(format!("{TAR}.verified"))
    }

    fn put_tarball(&self) {
        fs::write(self.tarball(), b"signed tarball bytes").unwrap();
        fs::set_permissions(self.tarball(), fs::Permissions::from_mode(0o600)).unwrap();
    }

    fn staged_state(&self) -> UpdateState {
        UpdateState::staged("0.1.1", "x64", TAR, &self.stage, &self.app, SystemTime::now(), 1234)
    }
}

/// An installed app (0.1.0), a stage beside it with the staged bundle (0.1.1), the kept tarball,
/// a `staged` state.json and three snapshot-able files.
fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let uid = fs::metadata(&root).unwrap().uid();
    let dirs = UpdateDirs::new(root.join("state/updates"));
    dirs.ensure().unwrap();
    let apps = root.join("apps");
    fs::create_dir(&apps).unwrap();
    let app = make_app(&apps, DIR, &AppSpec { version: "0.1.0".into(), short_version: "0.1.0".into(), ..Default::default() });
    let stage = create_stage_dir(&apps).unwrap();
    make_app(&stage, DIR, &AppSpec { version: "0.1.1".into(), short_version: "0.1.1".into(), ..Default::default() });
    let settings = root.join("state/settings.json");
    let registry = root.join("state/registry.json");
    let absent = root.join("state/absent.json");
    fs::write(&settings, b"{\"v\":\"old settings\"}").unwrap();
    fs::set_permissions(&settings, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&registry, b"{\"v\":\"old registry\"}").unwrap();
    let e = Env { _tmp: tmp, root, dirs, apps, app, stage, uid, files: vec![settings, registry, absent] };
    e.put_tarball();
    write_state(&e.dirs, &e.staged_state()).unwrap();
    e
}

fn text(p: &Path) -> String {
    fs::read_to_string(p).unwrap_or_else(|_| "<missing>".into())
}

fn in_days(d: u64) -> SystemTime {
    SystemTime::now() + Duration::from_secs(d * 86_400)
}

fn set_age(path: &Path, age: Duration) {
    let f = fs::File::open(path).unwrap();
    f.set_modified(SystemTime::now() - age).unwrap();
}

fn recover_with(e: &Env, running: &str, boot_ready: bool, withdrawn: &[Version], now: SystemTime, check: &dyn Fn(&UpdateState) -> Result<(), UpdateError>) -> RecoverOutcome {
    let running = v(running);
    recover(&RecoverCtx {
        dirs: &e.dirs,
        running: &running,
        app_path: Some(&e.app),
        bundle_dir_name: DIR,
        uid: e.uid,
        now,
        boot_ready,
        withdrawn,
        stage_check: check,
        log: None,
    })
}

fn recover_ok(e: &Env, running: &str, boot_ready: bool) -> RecoverOutcome {
    recover_with(e, running, boot_ready, &[], SystemTime::now(), &|_| Ok(()))
}

fn begin(e: &Env) -> Token {
    begin_apply(&e.dirs, &ApplyBegin { from: "0.1.0", to: "0.1.1", stage_dir: &e.stage, app_path: &e.app, snapshot_files: &e.files }).unwrap()
}

fn boot(e: &Env, running: &str, pid: u32) -> BootOutcome {
    let running = v(running);
    early_boot(&BootCtx { dirs: &e.dirs, running: &running, pid, snapshot_files: &e.files, log: None, now: SystemTime::now() })
}

fn swap_spec(e: &Env) -> SwapSpec {
    SwapSpec {
        app_path: e.app.clone(),
        stage_dir: e.stage.clone(),
        bundle_dir_name: DIR.into(),
        bundle_id: TEST_BUNDLE_ID.into(),
        new_short_version: "0.1.1".into(),
        owner_uid: e.uid,
    }
}

// ------------------------------------------------------------------------------------------
// Files: modes, atomic writes, tolerant reads
// ------------------------------------------------------------------------------------------

#[test]
fn directories_are_private_and_state_round_trips() {
    let e = env();
    for d in [e.dirs.root().to_path_buf(), e.dirs.dl_dir(), e.dirs.feed_cache_dir()] {
        assert_eq!(fs::metadata(&d).unwrap().mode() & 0o777, 0o700, "{d:?}");
    }
    assert_eq!(fs::metadata(e.dirs.state_file()).unwrap().mode() & 0o777, 0o600);
    let st = read_state(&e.dirs).unwrap();
    let mut expect = e.staged_state();
    expect.prepared_at = st.prepared_at;
    assert_eq!(st, expect);
    // No temp file is left behind by the atomic write.
    let leftovers: Vec<_> = fs::read_dir(e.dirs.root()).unwrap().map(|x| x.unwrap().file_name().to_string_lossy().to_string()).filter(|n| n.contains(".tmp-")).collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn state_json_is_only_a_hint_and_reads_never_panic() {
    let e = env();
    fs::write(e.dirs.state_file(), b"not json at all").unwrap();
    assert!(read_state(&e.dirs).is_none());
    fs::write(e.dirs.state_file(), b"{\"phase\":\"nonsense\"}").unwrap();
    assert!(read_state(&e.dirs).is_none());
    fs::write(e.dirs.state_file(), format!("{{\"phase\":\"staged\",\"pad\":\"{}\"}}", "x".repeat(70_000))).unwrap();
    assert!(read_state(&e.dirs).is_none(), "over the 64 KiB cap");
    fs::write(e.dirs.state_file(), b"{\"phase\":\"staged\",\"version\":\"0.1.1\",\"futureField\":[1,2]}").unwrap();
    assert!(read_state(&e.dirs).is_some(), "unknown fields are ignored");
    fs::remove_file(e.dirs.state_file()).unwrap();
    let real = e.root.join("real-state.json");
    fs::write(&real, b"{\"phase\":\"staged\"}").unwrap();
    symlink(&real, e.dirs.state_file()).unwrap();
    assert!(read_state(&e.dirs).is_none(), "a symlinked state.json is not followed");
}

#[test]
fn tokens_are_sixteen_lowercase_hex_digits() {
    for ok in ["0123456789abcdef", "ffffffffffffffff"] {
        assert!(is_token(ok), "{ok}");
    }
    for bad in ["", "0123456789abcde", "0123456789abcdeff", "0123456789ABCDEF", "0123456789abcdeg", "../etc/passwd....", "0123456789abcde/"] {
        assert!(!is_token(bad), "{bad}");
    }
    let t = Token::new().unwrap();
    assert!(is_token(t.as_str()));
    assert_ne!(t, Token::new().unwrap());
    assert!(Token::parse("nope").is_none());
}

#[test]
fn feed_state_trust_and_feed_cache_round_trip_and_corruption_is_loud() {
    let e = env();
    assert_eq!(load_feed_state(&e.dirs).unwrap(), FeedState::default());
    let mut st = FeedState::default();
    st.floor.set(Channel::Stable, 7);
    st.verified_at.set(Channel::Alpha, 1_700_000_000);
    st.highest_seen = Some("0.1.1".into());
    save_feed_state(&e.dirs, &st).unwrap();
    assert_eq!(load_feed_state(&e.dirs).unwrap(), st);
    assert_eq!(st.floor.get(Channel::Stable), Some(7));
    assert_eq!(st.floor.get(Channel::Alpha), None);
    fs::write(e.dirs.feedstate_file(), b"{\"floor\": [").unwrap();
    assert_eq!(load_feed_state(&e.dirs).unwrap_err().code, ErrorCode::FeedInvalid);
    let q = quarantine(&e.dirs.feedstate_file()).unwrap();
    assert!(q.exists() && !e.dirs.feedstate_file().exists());
    assert_eq!(load_feed_state(&e.dirs).unwrap(), FeedState::default());

    // trust.json
    assert!(load_revocations(&e.dirs).unwrap().is_empty());
    let rev = Revocations::from_json(r#"{"schema":1,"revoked":["0123456789ABCDEF"]}"#).unwrap();
    save_revocations(&e.dirs, &rev).unwrap();
    assert!(load_revocations(&e.dirs).unwrap().contains("0123456789abcdef"));
    assert_eq!(fs::metadata(e.dirs.trust_file()).unwrap().mode() & 0o777, 0o600);
    for tampered in [r#"{"schema":2,"revoked":[]}"#, r#"{"schema":1,"revoked":["zz"]}"#, "{", r#"{"schema":1}"#] {
        fs::write(e.dirs.trust_file(), tampered).unwrap();
        assert_eq!(load_revocations(&e.dirs).unwrap_err().code, ErrorCode::FeedInvalid, "{tampered}");
    }

    // feed cache
    assert!(read_feed_cache(&e.dirs, Channel::Stable).is_none());
    write_feed_cache(&e.dirs, Channel::Stable, b"{\"feed\":1}", "sig text").unwrap();
    assert_eq!(read_feed_cache(&e.dirs, Channel::Stable).unwrap(), (b"{\"feed\":1}".to_vec(), "sig text".to_string()));
    assert!(read_feed_cache(&e.dirs, Channel::Alpha).is_none());
    fs::remove_file(e.dirs.feed_cache_dir().join("stable.json.sig")).unwrap();
    assert!(read_feed_cache(&e.dirs, Channel::Stable).is_none(), "a half pair is not used");
}

// ------------------------------------------------------------------------------------------
// The snapshot (A3, T29)
// ------------------------------------------------------------------------------------------

#[test]
fn snapshot_restores_listed_files_only_and_removes_what_the_new_version_created() {
    let e = env();
    let token = Token::new().unwrap();
    snapshot_create(&e.dirs, &token, &e.files).unwrap();
    assert_eq!(fs::metadata(e.dirs.pre_dir(&token)).unwrap().mode() & 0o777, 0o700);
    // The new version migrates the files, creates the absent one, and touches an unlisted one.
    let unlisted = e.root.join("state/unlisted.json");
    fs::write(&unlisted, b"unlisted v1").unwrap();
    fs::write(&e.files[0], b"{\"v\":\"MIGRATED\"}").unwrap();
    fs::write(&e.files[1], b"{\"v\":\"MIGRATED\"}").unwrap();
    fs::write(&e.files[2], b"created by the new version").unwrap();
    fs::write(&unlisted, b"unlisted v2").unwrap();
    let r = snapshot_restore(&e.dirs, &token, &e.files).unwrap();
    assert_eq!(r, SnapshotRestore { restored: 2, removed: 1, skipped: 0 });
    assert_eq!(text(&e.files[0]), "{\"v\":\"old settings\"}");
    assert_eq!(text(&e.files[1]), "{\"v\":\"old registry\"}");
    assert!(!e.files[2].exists(), "a file that did not exist before is removed again");
    assert_eq!(text(&unlisted), "unlisted v2", "files not in the list are untouched");
    assert_eq!(fs::metadata(&e.files[0]).unwrap().mode() & 0o777, 0o600, "mode restored");
    snapshot_remove(&e.dirs, &token);
    assert!(!e.dirs.pre_dir(&token).exists());
}

#[test]
fn snapshot_restore_does_not_trust_the_manifest_for_paths_or_content() {
    let e = env();
    let token = Token::new().unwrap();
    snapshot_create(&e.dirs, &token, &e.files).unwrap();
    // Restoring with a narrower list leaves the other files alone.
    fs::write(&e.files[0], b"changed").unwrap();
    fs::write(&e.files[1], b"changed").unwrap();
    let r = snapshot_restore(&e.dirs, &token, &e.files[..1]).unwrap();
    assert_eq!(r.restored, 1);
    assert!(r.skipped >= 2);
    assert_eq!(text(&e.files[0]), "{\"v\":\"old settings\"}");
    assert_eq!(text(&e.files[1]), "changed");
    // A tampered copy fails its hash: skipped, the live file is not touched.
    fs::write(&e.files[0], b"live").unwrap();
    let copy = e.dirs.pre_dir(&token).join("f0000");
    fs::write(&copy, b"TAMPERED").unwrap();
    let r = snapshot_restore(&e.dirs, &token, &e.files).unwrap();
    assert!(r.skipped >= 1);
    assert_eq!(text(&e.files[0]), "live");
    // A manifest naming a path outside the allowed list is skipped even if its hash matches.
    let manifest = e.dirs.pre_dir(&token).join("manifest.json");
    let victim = e.root.join("victim.txt");
    fs::write(&victim, b"victim").unwrap();
    let m = fs::read_to_string(&manifest).unwrap().replace(&e.files[1].display().to_string(), &victim.display().to_string());
    fs::write(&manifest, m).unwrap();
    snapshot_restore(&e.dirs, &token, &e.files).unwrap();
    assert_eq!(text(&victim), "victim");
    // A broken manifest is an error the caller can see.
    fs::write(&manifest, b"nope").unwrap();
    assert_eq!(snapshot_restore(&e.dirs, &token, &e.files).unwrap_err().code, ErrorCode::FeedInvalid);
}

#[test]
fn a_snapshot_that_cannot_be_made_leaves_nothing_behind() {
    let e = env();
    let token = Token::new().unwrap();
    let dir_in_list = e.root.join("state/adir");
    fs::create_dir(&dir_in_list).unwrap();
    let mut files = e.files.clone();
    files.push(dir_in_list);
    assert_eq!(snapshot_create(&e.dirs, &token, &files).unwrap_err().code, ErrorCode::SwapFailed);
    assert!(!e.dirs.pre_dir(&token).exists());
    // Over the per-file cap.
    let big = e.root.join("state/big.bin");
    let f = fs::File::create(&big).unwrap();
    f.set_len(9 * 1024 * 1024).unwrap();
    assert!(snapshot_create(&e.dirs, &token, &[big]).is_err());
    assert!(!e.dirs.pre_dir(&token).exists());
}

#[test]
fn begin_and_abort_apply() {
    let e = env();
    let token = begin(&e);
    let st = read_state(&e.dirs).unwrap();
    assert_eq!(st.phase, Phase::Applying);
    assert_eq!(st.token.as_deref(), Some(token.as_str()));
    assert_eq!((st.from.as_deref(), st.to.as_deref()), (Some("0.1.0"), Some("0.1.1")));
    assert_eq!(st.tar_name.as_deref(), Some(TAR), "the staged fields are kept");
    assert_eq!(st.app_path.as_deref(), Some(e.app.as_path()));
    assert!(e.dirs.pre_dir(&token).join("manifest.json").exists());
    abort_apply(&e.dirs, &token);
    let st = read_state(&e.dirs).unwrap();
    assert_eq!((st.phase, st.token), (Phase::Staged, None));
    assert!(!e.dirs.pre_dir(&token).exists());
    // A failing snapshot aborts the begin and leaves the staged state as it was.
    let dir_in_list = e.root.join("state/adir");
    fs::create_dir(&dir_in_list).unwrap();
    let files = vec![dir_in_list];
    let err = begin_apply(&e.dirs, &ApplyBegin { from: "0.1.0", to: "0.1.1", stage_dir: &e.stage, app_path: &e.app, snapshot_files: &files }).unwrap_err();
    assert_eq!(err.code, ErrorCode::SwapFailed);
    assert_eq!(read_state(&e.dirs).unwrap().phase, Phase::Staged);
}

// ------------------------------------------------------------------------------------------
// early_boot (A7)
// ------------------------------------------------------------------------------------------

#[test]
fn early_boot_writes_started_only_when_the_running_version_is_the_target() {
    let e = env();
    // Not applying: nothing.
    assert_eq!(boot(&e, "0.1.1", 4242), BootOutcome::Nothing);
    let token = begin(&e);
    // The old version (crash between A3 and A4, or a manual start) writes nothing.
    assert_eq!(boot(&e, "0.1.0", 4242), BootOutcome::Nothing);
    assert!(!e.dirs.marker_exists(Marker::Started, &token));
    // Some third version: nothing.
    assert_eq!(boot(&e, "0.2.0", 4242), BootOutcome::Nothing);
    // The target version: the marker holds the pid.
    assert_eq!(boot(&e, "0.1.1", 4242), BootOutcome::Started { token: token.as_str().into() });
    assert_eq!(fs::read_to_string(e.dirs.marker(Marker::Started, &token)).unwrap().trim(), "4242");
    assert_eq!(fs::metadata(e.dirs.marker(Marker::Started, &token)).unwrap().mode() & 0o777, 0o600);
    // A garbage token in a tampered state.json writes nothing and no path is built from it.
    let mut st = read_state(&e.dirs).unwrap();
    st.token = Some("../../escape".into());
    write_state(&e.dirs, &st).unwrap();
    assert_eq!(boot(&e, "0.1.1", 1), BootOutcome::Nothing);
}

#[test]
fn early_boot_restores_the_snapshot_after_a_watchdog_rollback_and_only_once() {
    let e = env();
    let token = begin(&e);
    // The new version migrated the small files before it died.
    fs::write(&e.files[0], b"{\"v\":\"MIGRATED\"}").unwrap();
    fs::write(&e.files[2], b"new file").unwrap();
    // No rollback marker yet: the old version does not touch anything.
    assert_eq!(boot(&e, "0.1.0", 1), BootOutcome::Nothing);
    assert_eq!(text(&e.files[0]), "{\"v\":\"MIGRATED\"}");
    // The watchdog put the old app back and wrote its marker.
    e.dirs.write_marker(Marker::RolledBack, &token, "").unwrap();
    let out = boot(&e, "0.1.0", 1);
    let BootOutcome::RolledBack { token: t, failed_version, restore } = out else { panic!("{out:?}") };
    assert_eq!((t.as_str(), failed_version.as_str()), (token.as_str(), "0.1.1"));
    assert_eq!(restore.restored, 2);
    assert_eq!(restore.removed, 1);
    assert_eq!(text(&e.files[0]), "{\"v\":\"old settings\"}");
    assert!(!e.files[2].exists());
    assert!(e.dirs.marker_exists(Marker::Restored, &token));
    assert_eq!(read_state(&e.dirs).unwrap().phase, Phase::RolledBack);
    // A second start (before the user acknowledged) must not overwrite what the user did since.
    fs::write(&e.files[0], b"{\"v\":\"user changed it after the rollback\"}").unwrap();
    let out = boot(&e, "0.1.0", 2);
    assert!(matches!(out, BootOutcome::RolledBack { .. }));
    assert_eq!(text(&e.files[0]), "{\"v\":\"user changed it after the rollback\"}");
    // recover() reports the pending rollback; the acknowledgement cleans up.
    assert_eq!(recover_ok(&e, "0.1.0", true), RecoverOutcome::RolledBack { failed_version: "0.1.1".into() });
    ack_rollback(&e.dirs);
    assert!(read_state(&e.dirs).is_none());
    assert!(!e.dirs.pre_dir(&token).exists());
    assert!(!e.dirs.marker_exists(Marker::RolledBack, &token));
}

#[test]
fn a_broken_snapshot_does_not_stop_the_old_app_from_starting() {
    let e = env();
    let token = begin(&e);
    fs::remove_file(e.dirs.pre_dir(&token).join("manifest.json")).unwrap();
    e.dirs.write_marker(Marker::RolledBack, &token, "").unwrap();
    let out = boot(&e, "0.1.0", 1);
    let BootOutcome::RolledBack { restore, .. } = out else { panic!("{out:?}") };
    assert_eq!(restore, SnapshotRestore::default());
}

#[test]
fn clean_exit_is_marked_only_for_an_unconfirmed_new_version() {
    let e = env();
    mark_clean_exit(&e.dirs, &v("0.1.1")); // not applying
    let token = begin(&e);
    mark_clean_exit(&e.dirs, &v("0.1.0")); // wrong version
    assert!(!e.dirs.marker_exists(Marker::CleanExit, &token));
    mark_clean_exit(&e.dirs, &v("0.1.1"));
    assert!(e.dirs.marker_exists(Marker::CleanExit, &token));
    // Once confirmed there is no clean-exit marker to write.
    fs::remove_file(e.dirs.marker(Marker::CleanExit, &token)).unwrap();
    e.dirs.write_marker(Marker::Confirmed, &token, "").unwrap();
    mark_clean_exit(&e.dirs, &v("0.1.1"));
    assert!(!e.dirs.marker_exists(Marker::CleanExit, &token));
}

// ------------------------------------------------------------------------------------------
// recover(): every crash point of 7.2
// ------------------------------------------------------------------------------------------

#[test]
fn recover_with_nothing_to_do_is_idle() {
    let e = env();
    clear_state(&e.dirs);
    assert_eq!(recover_ok(&e, "0.1.0", true), RecoverOutcome::Idle);
}

#[test]
fn a_valid_stage_is_offered_again_after_a_restart() {
    let e = env();
    assert_eq!(recover_ok(&e, "0.1.0", true), RecoverOutcome::StageReady { version: "0.1.1".into() });
    assert!(e.tarball().exists() && e.stage.exists());
    assert_eq!(read_state(&e.dirs).unwrap().phase, Phase::Staged);
}

#[test]
fn crash_during_download_leaves_part_files_that_are_cleaned_after_an_hour() {
    let e = env();
    let part = e.dirs.dl_dir().join("IntelyIDE_0.1.2_x64.app.tar.gz.part");
    fs::write(&part, b"half").unwrap();
    let young = e.dirs.dl_dir().join("IntelyIDE_0.1.3_x64.app.tar.gz.part");
    fs::write(&young, b"half").unwrap();
    set_age(&part, Duration::from_secs(2 * 3600));
    recover_ok(&e, "0.1.0", true);
    assert!(!part.exists(), "an old .part is removed");
    assert!(young.exists(), "a recent .part (maybe a download in flight) is kept");
    assert!(e.tarball().exists(), "the tarball the state refers to is kept whatever its age");
    set_age(&e.tarball(), Duration::from_secs(5 * 3600));
    recover_ok(&e, "0.1.0", true);
    assert!(e.tarball().exists());
    // Without a state the old verified tarball is just a leftover.
    clear_state(&e.dirs);
    recover_ok(&e, "0.1.0", true);
    assert!(!e.tarball().exists());
}

#[test]
fn crash_during_unpack_leaves_a_stage_the_stale_cleanup_removes_after_seven_days() {
    let e = env();
    clear_state(&e.dirs); // no `staged` state: the crash happened before P7
    let orphan = create_stage_dir(&e.apps).unwrap();
    fs::create_dir(orphan.join(DIR)).unwrap();
    // Not old enough: kept.
    recover_with(&e, "0.1.0", true, &[], in_days(1), &|_| Ok(()));
    assert!(orphan.exists());
    // Old enough: removed, together with the stage of `env()` (also unreferenced now).
    recover_with(&e, "0.1.0", true, &[], in_days(8), &|_| Ok(()));
    assert!(!orphan.exists());
    assert!(!e.stage.exists());
    assert!(e.app.exists(), "the installed app is never touched");
}

#[test]
fn the_stale_cleanup_deletes_only_what_matches_pattern_marker_owner_and_age() {
    let e = env();
    clear_state(&e.dirs);
    // Pattern without the marker.
    let no_marker = e.apps.join(".IntelyIDE.update-aaaaaaaaaaaaaaaa");
    fs::create_dir(&no_marker).unwrap();
    fs::write(no_marker.join("keep"), b"x").unwrap();
    // A symlink with a stage name pointing at a victim directory that has the marker.
    let victim = e.root.join("victim-dir");
    fs::create_dir(&victim).unwrap();
    fs::write(victim.join(STAGE_MARKER), b"x").unwrap();
    fs::write(victim.join("precious"), b"x").unwrap();
    let link = e.apps.join(".IntelyIDE.update-bbbbbbbbbbbbbbbb");
    symlink(&victim, &link).unwrap();
    // A different name pattern.
    let other = e.apps.join(".IntelyIDE.update-short");
    fs::create_dir(&other).unwrap();
    fs::write(other.join(STAGE_MARKER), b"x").unwrap();
    let second = create_stage_dir(&e.apps).unwrap();
    let far = in_days(30);
    // Another uid than the owner: nothing is deleted.
    cleanup_stale(&e.dirs, Some(&e.app), None, e.uid + 1, far);
    assert!(e.stage.exists() && second.exists(), "a stage owned by another uid is never deleted");
    // The right uid: the two real stages go, the lookalikes stay.
    let rep = cleanup_stale(&e.dirs, Some(&e.app), None, e.uid, far);
    assert_eq!(rep.stages, 2, "{rep:?}");
    assert!(!e.stage.exists() && !second.exists());
    assert!(no_marker.join("keep").exists());
    assert!(victim.join("precious").exists(), "a symlink named like a stage is not followed");
    assert!(fs::symlink_metadata(&link).is_ok());
    assert!(other.exists());
    assert!(e.app.exists());
    // Young stages are never removed.
    let young = create_stage_dir(&e.apps).unwrap();
    assert_eq!(cleanup_stale(&e.dirs, Some(&e.app), None, e.uid, SystemTime::now()).stages, 0);
    assert!(young.exists());
}

#[test]
fn old_snapshots_and_markers_of_other_tokens_are_cleaned_but_never_the_current_ones() {
    let e = env();
    let stale = Token::new().unwrap();
    snapshot_create(&e.dirs, &stale, &e.files).unwrap();
    e.dirs.write_marker(Marker::Started, &stale, "1\n").unwrap();
    let cur = begin(&e);
    e.dirs.write_marker(Marker::Started, &cur, "1\n").unwrap();
    let st = read_state(&e.dirs);
    let far = in_days(10);
    let rep = cleanup_stale(&e.dirs, Some(&e.app), st.as_ref(), e.uid, far);
    assert_eq!((rep.snapshots, rep.markers), (1, 1), "{rep:?}");
    assert!(!e.dirs.pre_dir(&stale).exists() && !e.dirs.marker_exists(Marker::Started, &stale));
    assert!(e.dirs.pre_dir(&cur).exists() && e.dirs.marker_exists(Marker::Started, &cur));
}

#[test]
fn crash_between_a3_and_a4_gives_the_stage_back() {
    let e = env();
    let token = begin(&e); // applying, nothing swapped; the old version starts again
    assert_eq!(boot(&e, "0.1.0", 1), BootOutcome::Nothing);
    let out = recover_ok(&e, "0.1.0", true);
    assert_eq!(out, RecoverOutcome::StageReady { version: "0.1.1".into() });
    let st = read_state(&e.dirs).unwrap();
    assert_eq!((st.phase, st.token), (Phase::Staged, None));
    assert!(!e.dirs.pre_dir(&token).exists(), "the snapshot of the abandoned apply is removed");
    assert!(e.stage.exists() && e.tarball().exists());
}

#[test]
fn the_new_version_confirms_and_the_old_bundle_goes_away() {
    let e = env();
    let token = begin(&e);
    // A4: the new bundle is at appPath, the old one in the stage slot.
    swap_in(&SystemFs, &swap_spec(&e)).unwrap();
    assert_eq!(boot(&e, "0.1.1", 777), BootOutcome::Started { token: token.as_str().into() });
    assert_eq!(recover_ok(&e, "0.1.1", false), RecoverOutcome::AwaitingReady);
    assert!(e.stage.exists());
    let out = recover_ok(&e, "0.1.1", true);
    assert_eq!(out, RecoverOutcome::Confirmed { from: "0.1.0".into(), to: "0.1.1".into() });
    assert!(!e.stage.exists(), "the old bundle is deleted");
    assert!(!e.tarball().exists());
    assert!(!e.dirs.pre_dir(&token).exists());
    assert!(read_state(&e.dirs).is_none());
    assert_eq!(version_at(&e.app).as_deref(), Some("0.1.1"));
    // The confirmed marker stays: the watchdog may still poll it, and without it a later quit of
    // the new app would look like a crash.
    assert!(e.dirs.marker_exists(Marker::Confirmed, &token));
    assert!(e.dirs.marker_exists(Marker::Started, &token));
    // Idempotent.
    assert_eq!(recover_ok(&e, "0.1.1", true), RecoverOutcome::Idle);
}

#[test]
fn a_crash_after_the_confirm_marker_but_before_the_cleanup_is_finished_at_the_next_start() {
    let e = env();
    let token = begin(&e);
    swap_in(&SystemFs, &swap_spec(&e)).unwrap();
    e.dirs.write_marker(Marker::Confirmed, &token, "").unwrap();
    let mut st = read_state(&e.dirs).unwrap();
    st.phase = Phase::Confirmed;
    write_state(&e.dirs, &st).unwrap();
    let out = recover_ok(&e, "0.1.1", true);
    assert_eq!(out, RecoverOutcome::Confirmed { from: "0.1.0".into(), to: "0.1.1".into() });
    assert!(!e.stage.exists() && !e.tarball().exists());
    assert!(read_state(&e.dirs).is_none());
}

#[test]
fn neither_version_running_discards_the_apply() {
    // The user installed a newer DMG by hand while an apply was recorded.
    let e = env();
    begin(&e);
    let out = recover_ok(&e, "0.3.0", true);
    assert_eq!(out, RecoverOutcome::StageDiscarded(DiscardReason::NotNewer));
    assert!(!e.stage.exists() && !e.tarball().exists());
    assert!(read_state(&e.dirs).is_none());
}

#[test]
fn a_stage_is_discarded_for_each_of_the_reasons_of_a7() {
    // Not newer than the running version.
    let e = env();
    assert_eq!(recover_ok(&e, "0.1.1", true), RecoverOutcome::StageDiscarded(DiscardReason::NotNewer));
    assert!(!e.stage.exists() && !e.tarball().exists() && read_state(&e.dirs).is_none());
    let e = env();
    assert_eq!(recover_ok(&e, "0.2.0", true), RecoverOutcome::StageDiscarded(DiscardReason::NotNewer));
    // Withdrawn by the cached verified feed.
    let e = env();
    let out = recover_with(&e, "0.1.0", true, &[v("0.1.1")], SystemTime::now(), &|_| Ok(()));
    assert_eq!(out, RecoverOutcome::StageDiscarded(DiscardReason::Withdrawn));
    assert!(!e.stage.exists());
    // Prepared for another app path.
    let e = env();
    let mut st = e.staged_state();
    st.app_path = Some(PathBuf::from("/Applications/Other.app"));
    write_state(&e.dirs, &st).unwrap();
    assert_eq!(recover_ok(&e, "0.1.0", true), RecoverOutcome::StageDiscarded(DiscardReason::OtherApp));
    // The kept tarball is missing, a symlink, or not ours.
    let e = env();
    fs::remove_file(e.tarball()).unwrap();
    assert_eq!(recover_ok(&e, "0.1.0", true), RecoverOutcome::StageDiscarded(DiscardReason::TarballMissing));
    assert!(!e.stage.exists(), "the stage goes with its tarball");
    let e = env();
    fs::remove_file(e.tarball()).unwrap();
    let other = e.root.join("other.tar");
    fs::write(&other, b"x").unwrap();
    symlink(&other, e.tarball()).unwrap();
    assert_eq!(recover_ok(&e, "0.1.0", true), RecoverOutcome::StageDiscarded(DiscardReason::TarballMissing));
    assert!(other.exists(), "the symlink target is untouched");
    // The stage directory is gone.
    let e = env();
    fs::remove_dir_all(&e.stage).unwrap();
    assert_eq!(recover_ok(&e, "0.1.0", true), RecoverOutcome::StageDiscarded(DiscardReason::Unreadable));
    assert!(!e.tarball().exists());
    // The engine's A2 check fails (tampered tarball or a planted stage).
    let e = env();
    let out = recover_with(&e, "0.1.0", true, &[], SystemTime::now(), &|_| Err(UpdateError::new(ErrorCode::Stale)));
    assert_eq!(out, RecoverOutcome::StageDiscarded(DiscardReason::CheckFailed(ErrorCode::Stale)));
    assert!(!e.stage.exists() && !e.tarball().exists());
}

#[test]
fn a_tampered_state_json_cannot_redirect_a_deletion() {
    // T21: stageDir and tarName come from a file the same user can edit.
    let e = env();
    let victim = e.root.join("victim");
    fs::create_dir(&victim).unwrap();
    fs::write(victim.join(STAGE_MARKER), b"x").unwrap();
    fs::write(victim.join("precious"), b"x").unwrap();
    let outside_file = e.root.join("outside.app.tar.gz.verified");
    fs::write(&outside_file, b"x").unwrap();
    let foreign_stage = e.root.join(".IntelyIDE.update-cccccccccccccccc");
    fs::create_dir(&foreign_stage).unwrap();
    fs::write(foreign_stage.join(STAGE_MARKER), b"x").unwrap();
    fs::write(foreign_stage.join("precious"), b"x").unwrap();

    // (stageDir, tarName, the real stage may be removed because the name was merely invalid)
    let cases: Vec<(PathBuf, String, bool)> = vec![
        (victim.clone(), TAR.to_string(), false),
        (foreign_stage.clone(), TAR.to_string(), false),
        (e.apps.join("../victim"), TAR.to_string(), false),
        (e.stage.clone(), "../../outside.app.tar.gz".to_string(), true),
        (e.stage.clone(), "/etc/passwd".to_string(), true),
    ];
    for (stage_dir, tar_name, real_stage_may_go) in cases {
        e.put_tarball();
        let mut st = e.staged_state();
        st.stage_dir = Some(stage_dir.clone());
        st.tar_name = Some(tar_name.clone());
        write_state(&e.dirs, &st).unwrap();
        let out = recover_ok(&e, "0.1.0", true);
        assert!(matches!(out, RecoverOutcome::StageDiscarded(_)), "{stage_dir:?} {tar_name:?} -> {out:?}");
        assert!(victim.join("precious").exists(), "{stage_dir:?}");
        assert!(foreign_stage.join("precious").exists(), "{stage_dir:?}");
        assert!(outside_file.exists(), "{tar_name:?}");
        assert!(e.app.exists());
        if !real_stage_may_go {
            assert!(e.stage.exists(), "a stage the tampered file did not name must survive: {stage_dir:?}");
        }
    }
}

// ------------------------------------------------------------------------------------------
// The lock (T20)
// ------------------------------------------------------------------------------------------

struct FakeProbe(Vec<u32>);

impl ProcessProbe for FakeProbe {
    fn alive(&self, pid: u32) -> bool {
        self.0.contains(&pid)
    }
}

#[test]
fn the_lock_is_exclusive_stale_aware_and_released_on_drop() {
    let e = env();
    let probe = FakeProbe(vec![100]);
    let a = UpdateLock::acquire(&e.dirs, 100, &probe).unwrap();
    assert_eq!(fs::metadata(e.dirs.lock_file()).unwrap().mode() & 0o777, 0o600);
    assert_eq!(UpdateLock::acquire(&e.dirs, 200, &probe).unwrap_err().code, ErrorCode::AlreadyRunning);
    drop(a);
    assert!(!e.dirs.lock_file().exists());
    // A lock of a dead pid is replaced.
    fs::write(e.dirs.lock_file(), b"999\n").unwrap();
    let b = UpdateLock::acquire(&e.dirs, 200, &probe).unwrap();
    assert_eq!(text(&e.dirs.lock_file()).trim(), "200");
    // Garbage in the lock file counts as stale.
    drop(b);
    fs::write(e.dirs.lock_file(), b"not a pid").unwrap();
    let c = UpdateLock::acquire(&e.dirs, 300, &probe).unwrap();
    // A lock that was taken over by someone else is not deleted by the old holder's drop.
    fs::write(e.dirs.lock_file(), b"555\n").unwrap();
    drop(c);
    assert_eq!(text(&e.dirs.lock_file()).trim(), "555");
    // No temp or stale files are left behind.
    let names: Vec<String> = fs::read_dir(e.dirs.root()).unwrap().map(|x| x.unwrap().file_name().to_string_lossy().to_string()).collect();
    assert!(names.iter().all(|n| !n.starts_with("lock.stale") && !n.starts_with(".lock.tmp")), "{names:?}");
}

#[test]
fn concurrent_appliers_get_exactly_one_lock() {
    for round in 0..5 {
        let e = env();
        let probe = Arc::new(FakeProbe((1..=16).collect()));
        let wins = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(std::sync::Barrier::new(16));
        let held = Arc::new(std::sync::Mutex::new(Vec::new()));
        let handles: Vec<_> = (1..=16u32)
            .map(|pid| {
                let (dirs, probe, wins, barrier, held) = (e.dirs.clone(), probe.clone(), wins.clone(), barrier.clone(), held.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    if let Ok(l) = UpdateLock::acquire(&dirs, pid, probe.as_ref()) {
                        wins.fetch_add(1, Ordering::SeqCst);
                        held.lock().unwrap().push(l);
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(wins.load(Ordering::SeqCst), 1, "round {round}");
    }
}

#[test]
fn the_real_process_probe_tells_a_living_pid_from_a_dead_one() {
    assert!(PsProbe.alive(std::process::id()));
    let mut c = Command::new("/usr/bin/true").stdout(Stdio::null()).spawn().unwrap();
    let pid = c.id();
    c.wait().unwrap();
    assert!(!PsProbe.alive(pid));
}

// ------------------------------------------------------------------------------------------
// updates.log (T17)
// ------------------------------------------------------------------------------------------

#[test]
fn rfc3339_formats_known_instants() {
    assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
    assert_eq!(rfc3339(1_700_000_000), "2023-11-14T22:13:20Z");
    assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
    assert_eq!(rfc3339(4_102_444_799), "2099-12-31T23:59:59Z");
}

#[test]
fn log_redaction_masks_home_urls_signatures_and_user_names() {
    let home = Path::new("/Users/alice");
    assert_eq!(redact("failed at /Users/alice/Library/x.json", Some(home)), "failed at ~/Library/x.json");
    assert_eq!(redact("path /Users/ann/Documents/p", Some(home)), "path ~/Documents/p");
    assert_eq!(redact("GET https://github.com/a/b/releases/download/v1/x.tar.gz?token=SECRET&x=1#frag done", None), "GET https://github.com/a/b/releases/download/v1/x.tar.gz done");
    let sig = "RUQ".to_string() + &"abcdEFGH0123+/==".repeat(6);
    let out = redact(&format!("signature {sig} rejected"), None);
    assert_eq!(out, "signature <redacted> rejected");
    assert_eq!(redact("short token abc123", None), "short token abc123");
}

#[test]
fn the_log_has_only_the_listed_fields_is_private_rotates_and_tails() {
    let e = env();
    let log = UpdateLog::new(&e.dirs, Some(PathBuf::from("/Users/alice")));
    let ev = LogEvent {
        event: "download",
        code: Some(ErrorCode::HashMismatch),
        from: Some("0.1.0"),
        to: Some("0.1.1"),
        host: Some("https://objects.githubusercontent.com:443/path?sig=AAA#x"),
        bytes: Some(10),
        ms: Some(20),
        detail: Some("while reading /Users/alice/secret\nsecond\tline https://h.example/p?token=T"),
    };
    log.append(SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000), &ev);
    let lines = log.tail(5);
    assert_eq!(lines.len(), 1);
    let j: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
    assert_eq!(j["ts"], "2023-11-14T22:13:20Z");
    assert_eq!(j["event"], "download");
    assert_eq!(j["code"], "hashMismatch");
    assert_eq!(j["host"], "objects.githubusercontent.com");
    assert_eq!((j["bytes"].as_u64(), j["ms"].as_u64()), (Some(10), Some(20)));
    let detail = j["detail"].as_str().unwrap();
    assert!(!detail.contains("alice") && !detail.contains("token=") && !detail.contains('\n') && !detail.contains('\t'), "{detail}");
    let mut keys: Vec<&String> = j.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, vec!["bytes", "code", "detail", "event", "from", "host", "ms", "to", "ts"]);
    assert_eq!(fs::metadata(e.dirs.log_file()).unwrap().mode() & 0o777, 0o600);
    // Rotation at 256 KiB, one old file kept.
    let filler = LogEvent::new("filler").detail("x");
    for _ in 0..8000 {
        log.append(SystemTime::now(), &filler);
    }
    let sz = fs::metadata(e.dirs.log_file()).unwrap().len();
    assert!(sz < 300 * 1024, "the live log is rotated: {sz}");
    assert!(e.dirs.root().join("updates.log.1").exists());
    assert_eq!(log.tail(3).len(), 3);
}

// ------------------------------------------------------------------------------------------
// discard_all
// ------------------------------------------------------------------------------------------

#[test]
fn discard_all_removes_a_staged_update_and_the_downloads() {
    let e = env();
    fs::write(e.dirs.dl_dir().join("IntelyIDE_0.1.2_x64.app.tar.gz.part"), b"p").unwrap();
    discard_all(&e.dirs, Some(&e.app), e.uid);
    assert!(!e.stage.exists() && !e.tarball().exists() && read_state(&e.dirs).is_none());
    assert_eq!(fs::read_dir(e.dirs.dl_dir()).unwrap().count(), 0);
    assert!(e.app.exists());
    // An applying state is not a staged update: discard_all leaves it for recover().
    let e = env();
    begin(&e);
    discard_all(&e.dirs, Some(&e.app), e.uid);
    assert_eq!(read_state(&e.dirs).unwrap().phase, Phase::Applying);
    assert!(e.stage.exists());
}

// ------------------------------------------------------------------------------------------
// Power loss through the whole apply, and the full cycle with the real script
// ------------------------------------------------------------------------------------------

/// A file system that "dies" at operation `die_at`: that operation and every later one fail, so no
/// cleanup code gets to run, exactly like a process killed at that instant.
struct Crashy {
    count: Cell<usize>,
    die_at: usize,
    dead: Cell<bool>,
    ops: RefCell<Vec<String>>,
    no_exchange: bool,
}

impl Crashy {
    fn tick(&self, what: &str) -> io::Result<()> {
        if self.dead.get() {
            return Err(io::Error::from_raw_os_error(libc::EIO));
        }
        let n = self.count.get();
        self.count.set(n + 1);
        self.ops.borrow_mut().push(what.into());
        if n == self.die_at {
            self.dead.set(true);
            return Err(io::Error::from_raw_os_error(libc::EIO));
        }
        Ok(())
    }
}

impl FsOps for Crashy {
    fn exchange(&self, a: &Path, b: &Path) -> io::Result<()> {
        if self.no_exchange {
            return Err(io::Error::from_raw_os_error(libc::EINVAL));
        }
        self.tick("exchange")?;
        SystemFs.exchange(a, b)
    }
    fn rename_new(&self, from: &Path, to: &Path) -> io::Result<()> {
        self.tick("rename")?;
        SystemFs.rename_new(from, to)
    }
}

#[test]
fn power_loss_at_every_step_of_the_apply_converges_after_a_restart() {
    // Steps: 0 = nothing happened; 1 = snapshot written, state not yet; then begin_apply done and the
    // swap dies at operation k of the file system (k = 0.. until the swap completes, which is "swap
    // complete, relauncher never spawned"). After each, "the user starts the app again".
    for no_exchange in [false, true] {
        let mut window_hits = 0;
        let mut completed = 0;
        for step in 0..14usize {
            let e = env();
            let mut swap_done = false;
            let mut note = String::new();
            match step {
                0 => {}
                1 => {
                    let t = Token::new().unwrap();
                    snapshot_create(&e.dirs, &t, &e.files).unwrap();
                }
                k => {
                    begin(&e);
                    let c = Crashy { count: Cell::new(0), die_at: k - 2, dead: Cell::new(false), ops: RefCell::new(vec![]), no_exchange };
                    swap_done = swap_in(&c, &swap_spec(&e)).is_ok();
                    note = format!("{:?}", c.ops.borrow());
                }
            }
            let ctx = format!("no_exchange={no_exchange} step={step} {note}");
            // Nothing is lost, whatever the moment.
            let side = e.stage.join(format!("{DIR}.new"));
            let mut found: Vec<String> = [version_at(&e.app), version_at(&e.stage.join(DIR)), version_at(&side)].into_iter().flatten().collect();
            found.sort();
            assert_eq!(found, vec!["0.1.0".to_string(), "0.1.1".to_string()], "bundles lost ({ctx})");
            // The documented residual window of the three-step fallback: a restart needs the repair first.
            if version_at(&e.app).is_none() {
                window_hits += 1;
                assert!(no_exchange, "RENAME_SWAP must never leave appPath empty ({ctx})");
                repair_interrupted(&SystemFs, &e.app, &e.stage, DIR).unwrap();
            }
            let running = version_at(&e.app).unwrap();
            // The restarted app runs early_boot, then recover() once its webview is ready.
            let b = boot(&e, &running, 31337);
            let out = recover_ok(&e, &running, true);
            if running == "0.1.1" {
                completed += 1;
                assert!(swap_done, "{ctx}");
                assert!(matches!(b, BootOutcome::Started { .. }), "{ctx} {b:?}");
                assert!(matches!(out, RecoverOutcome::Confirmed { .. }), "{ctx} {out:?}");
                assert!(!e.stage.exists(), "old bundle deleted after the confirm ({ctx})");
                assert!(read_state(&e.dirs).is_none());
            } else {
                // The old app runs again: the update is still on offer, never wedged.
                assert!(!swap_done, "{ctx}");
                assert_eq!(b, BootOutcome::Nothing, "{ctx}");
                if step == 0 || step == 1 || step >= 2 {
                    assert!(matches!(out, RecoverOutcome::StageReady { .. }), "{ctx} {out:?}");
                }
                assert_eq!(version_at(&e.stage.join(DIR)).as_deref(), Some("0.1.1"), "the stage slot holds the new bundle again ({ctx})");
                assert!(!side.exists(), "{ctx}");
                assert!(read_state(&e.dirs).map(|s| s.phase != Phase::Applying).unwrap_or(true), "no apply left half-done ({ctx})");
            }
            // The small state files were never touched by any of this.
            assert_eq!(text(&e.files[0]), "{\"v\":\"old settings\"}", "{ctx}");
        }
        assert!(completed >= 1, "the swap must complete for some step (no_exchange={no_exchange})");
        if no_exchange {
            assert!(window_hits >= 1, "the three-step window was never hit");
        }
    }
}

/// The relaunch script with a fake `open`, as the engine would spawn it.
fn run_watchdog(e: &Env, token: &Token, pid: u32, open_log: &Path) -> std::process::ExitStatus {
    let open_bin = e.root.join("fake-open");
    fs::write(&open_bin, format!("#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\n", open_log.display())).unwrap();
    fs::set_permissions(&open_bin, fs::Permissions::from_mode(0o755)).unwrap();
    let args = RelaunchArgs { pid, app_path: &e.app, stage_dir: &e.stage, token: token.as_str(), state_dir: e.dirs.root(), open_binary: &open_bin, bundle_dir_name: DIR };
    let mut child = relaunch::command(&args).unwrap().spawn().unwrap();
    let end = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(s) = child.try_wait().unwrap() {
            return s;
        }
        assert!(std::time::Instant::now() < end, "watchdog did not finish");
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn dead_pid() -> u32 {
    let mut c = Command::new("/usr/bin/true").spawn().unwrap();
    let pid = c.id();
    c.wait().unwrap();
    pid
}

#[test]
fn full_cycle_rollback_restores_bundle_and_state_with_the_real_script() {
    let e = env();
    let token = begin(&e);
    swap_in(&SystemFs, &swap_spec(&e)).unwrap();
    // The new version starts, migrates its state, and dies before it confirms.
    assert!(matches!(boot(&e, "0.1.1", dead_pid()), BootOutcome::Started { .. }));
    fs::write(&e.files[0], b"{\"v\":\"MIGRATED BY 0.1.1\"}").unwrap();
    fs::write(&e.files[2], b"created by 0.1.1").unwrap();
    let open_log = e.root.join("open.log");
    let status = run_watchdog(&e, &token, dead_pid(), &open_log);
    assert!(status.success());
    // The old bundle is back and the failed one is kept beside it for diagnosis.
    assert_eq!(version_at(&e.app).as_deref(), Some("0.1.0"));
    assert_eq!(version_at(&e.stage.join(format!("{DIR}.failed"))).as_deref(), Some("0.1.1"));
    assert!(e.dirs.marker_exists(Marker::RolledBack, &token));
    // The old app starts: restores the small files before anything else reads them.
    let b = boot(&e, "0.1.0", 4711);
    assert!(matches!(b, BootOutcome::RolledBack { .. }), "{b:?}");
    assert_eq!(text(&e.files[0]), "{\"v\":\"old settings\"}");
    assert!(!e.files[2].exists());
    assert_eq!(recover_ok(&e, "0.1.0", true), RecoverOutcome::RolledBack { failed_version: "0.1.1".into() });
    // The failed bundle survives until the stale cleanup (7 days), then goes with its stage.
    assert!(e.stage.exists());
    ack_rollback(&e.dirs);
    recover_with(&e, "0.1.0", true, &[], in_days(8), &|_| Ok(()));
    assert!(!e.stage.exists());
    assert_eq!(version_at(&e.app).as_deref(), Some("0.1.0"));
}

#[test]
fn full_cycle_success_does_not_roll_back_a_confirmed_update_when_it_is_quit_later() {
    let e = env();
    let token = begin(&e);
    swap_in(&SystemFs, &swap_spec(&e)).unwrap();
    assert!(matches!(boot(&e, "0.1.1", dead_pid()), BootOutcome::Started { .. }));
    // The new version confirms and deletes the stage; the new process then exits (the user quits).
    let out = recover_ok(&e, "0.1.1", true);
    assert!(matches!(out, RecoverOutcome::Confirmed { .. }));
    assert!(!e.stage.exists());
    // The watchdog only now looks at the markers (its poll can be a second late): confirmed => no rollback.
    let open_log = e.root.join("open.log");
    let status = run_watchdog(&e, &token, dead_pid(), &open_log);
    assert!(status.success());
    assert_eq!(version_at(&e.app).as_deref(), Some("0.1.1"), "a confirmed update must survive the new app quitting");
    assert_eq!(text(&open_log).lines().count(), 1);
}
