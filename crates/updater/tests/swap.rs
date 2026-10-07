//! U4: the swap, its in-process rollback and the repair of an interrupted swap
//! ((design notes: updater-spec) 10.2 `swap`). Real directories; failures and "power loss" are injected
//! through `FsOps` so every point between two file-system operations is exercised.
mod common;

use std::cell::{Cell, RefCell};
use std::fs;
use std::io;
use std::os::unix::fs::{symlink, MetadataExt};
use std::path::{Path, PathBuf};
use std::process::Command;

use common::fixture_app::{make_app, AppSpec, TEST_BUNDLE_ID};
use intely_updater::stage::create_stage_dir;
use intely_updater::swap::*;
use intely_updater::{ErrorCode, UpdateError};

const DIR: &str = "IntelyIDE.app";

fn repair(spec: &SwapSpec) -> Result<Repair, UpdateError> {
    repair_interrupted(&SystemFs, &spec.app_path, &spec.stage_dir, &spec.bundle_dir_name)
}

fn euid() -> u32 {
    // The owner of a file we just created is the effective uid; no unsafe needed.
    let t = tempfile::tempdir().unwrap();
    fs::metadata(t.path()).unwrap().uid()
}

fn version_at(app: &Path) -> Option<String> {
    let v = plist::Value::from_file(app.join("Contents/Info.plist")).ok()?;
    Some(v.as_dictionary()?.get("CFBundleShortVersionString")?.as_string()?.to_string())
}

struct Rig {
    _tmp: tempfile::TempDir,
    parent: PathBuf,
    spec: SwapSpec,
}

impl Rig {
    fn app(&self) -> &Path {
        &self.spec.app_path
    }
    fn staged(&self) -> PathBuf {
        self.spec.stage_dir.join(DIR)
    }
    fn side(&self) -> PathBuf {
        self.spec.stage_dir.join(format!("{DIR}.new"))
    }
    fn side_back(&self) -> PathBuf {
        self.spec.stage_dir.join(format!("{DIR}.back"))
    }
    fn intent(&self) -> PathBuf {
        self.spec.stage_dir.join(".swap-intent")
    }
    /// Versions found in the app slot, the stage slot and the two side slots (None = empty slot).
    fn slots(&self) -> [Option<String>; 4] {
        [version_at(self.app()), version_at(&self.staged()), version_at(&self.side()), version_at(&self.side_back())]
    }
    /// The layout every repair must reach: the old bundle installed, the new one in the stage.
    fn assert_rolled_back(&self, ctx: &str) {
        assert_eq!(version_at(self.app()).as_deref(), Some("0.1.0"), "old app must be installed ({ctx}): {:?}", self.slots());
        assert_eq!(version_at(&self.staged()).as_deref(), Some("0.1.1"), "{ctx}");
        assert!(!self.side().exists() && !self.side_back().exists() && !self.intent().exists(), "{ctx}");
    }
    /// Nothing lost: exactly the old and the new bundle exist somewhere.
    fn assert_no_loss(&self, ctx: &str) {
        let mut found: Vec<String> = self.slots().into_iter().flatten().collect();
        found.sort();
        assert_eq!(found, vec!["0.1.0".to_string(), "0.1.1".to_string()], "bundles lost or duplicated ({ctx}): {:?}", self.slots());
    }
}

fn rig_in(root: &Path) -> Rig {
    let parent = root.canonicalize().unwrap().join("apps");
    fs::create_dir_all(&parent).unwrap();
    let old = AppSpec { version: "0.1.0".into(), short_version: "0.1.0".into(), ..Default::default() };
    let new = AppSpec { version: "0.1.1".into(), short_version: "0.1.1".into(), ..Default::default() };
    let app = make_app(&parent, DIR, &old);
    let stage = create_stage_dir(&parent).unwrap();
    make_app(&stage, DIR, &new);
    let spec = SwapSpec {
        app_path: app,
        stage_dir: stage,
        bundle_dir_name: DIR.into(),
        bundle_id: TEST_BUNDLE_ID.into(),
        new_short_version: "0.1.1".into(),
        owner_uid: euid(),
    };
    Rig { _tmp: tempfile::tempdir().unwrap(), parent, spec }
}

fn rig() -> Rig {
    let tmp = tempfile::tempdir().unwrap();
    let mut r = rig_in(tmp.path());
    r._tmp = tmp;
    r
}

/// A file system that fails (or "dies") at the n-th operation.
struct FaultFs {
    inner: SystemFs,
    count: Cell<usize>,
    fail_at: Option<usize>,
    /// After the failure every later operation fails too: the process is dead, no cleanup runs.
    crash: bool,
    dead: Cell<bool>,
    /// `exchange` reports EINVAL (a volume without RENAME_SWAP) and does not count as an operation.
    no_exchange: bool,
    ops: RefCell<Vec<String>>,
}

impl FaultFs {
    fn new(fail_at: Option<usize>, crash: bool, no_exchange: bool) -> FaultFs {
        FaultFs { inner: SystemFs, count: Cell::new(0), fail_at, crash, dead: Cell::new(false), no_exchange, ops: RefCell::new(Vec::new()) }
    }
    fn tick(&self, what: &str) -> io::Result<()> {
        if self.dead.get() {
            return Err(io::Error::from_raw_os_error(libc::EIO));
        }
        let n = self.count.get();
        self.count.set(n + 1);
        self.ops.borrow_mut().push(what.to_string());
        if Some(n) == self.fail_at {
            if self.crash {
                self.dead.set(true);
            }
            return Err(io::Error::from_raw_os_error(libc::EIO));
        }
        Ok(())
    }
}

impl FsOps for FaultFs {
    fn exchange(&self, a: &Path, b: &Path) -> io::Result<()> {
        if self.no_exchange {
            return Err(io::Error::from_raw_os_error(libc::EINVAL));
        }
        self.tick("exchange")?;
        self.inner.exchange(a, b)
    }
    fn rename_new(&self, from: &Path, to: &Path) -> io::Result<()> {
        self.tick("rename")?;
        self.inner.rename_new(from, to)
    }
}

// ------------------------------------------------------------------------------------------
// The two methods
// ------------------------------------------------------------------------------------------

fn ino(p: &Path) -> u64 {
    fs::symlink_metadata(p).unwrap().ino()
}

#[test]
fn exchange_swaps_two_bundles_atomically() {
    let r = rig();
    let (app_ino, staged_ino) = (ino(r.app()), ino(&r.staged()));
    let swapped = swap_in(&SystemFs, &r.spec).unwrap();
    assert_eq!(swapped.method, Method::Exchange, "APFS temp volume must support RENAME_SWAP");
    // The new bundle is the old staged inode, the old bundle sits in the stage slot.
    assert_eq!(ino(r.app()), staged_ino);
    assert_eq!(ino(&r.staged()), app_ino);
    assert_eq!(version_at(r.app()).as_deref(), Some("0.1.1"));
    assert_eq!(version_at(&r.staged()).as_deref(), Some("0.1.0"));
    assert!(!r.side().exists());
    r.assert_no_loss("after exchange");
}

#[test]
fn three_step_gives_the_same_layout() {
    let r = rig();
    let swapped = swap_in_with(&SystemFs, &r.spec, Some(Method::ThreeStep)).unwrap();
    assert_eq!(swapped.method, Method::ThreeStep);
    assert_eq!(version_at(r.app()).as_deref(), Some("0.1.1"));
    // Never under a `.old` name: the old bundle is in the stage slot.
    assert_eq!(version_at(&r.staged()).as_deref(), Some("0.1.0"));
    assert!(!r.side().exists() && !r.side_back().exists() && !r.intent().exists());
    let names: Vec<String> = fs::read_dir(&r.spec.stage_dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
    assert!(names.iter().all(|n| !n.ends_with(".old")), "{names:?}");
}

#[test]
fn unsupported_exchange_falls_back_to_three_step() {
    let r = rig();
    let fs_ops = FaultFs::new(None, false, true);
    let swapped = swap_in(&fs_ops, &r.spec).unwrap();
    assert_eq!(swapped.method, Method::ThreeStep);
    assert_eq!(fs_ops.count.get(), 3);
    assert_eq!(version_at(r.app()).as_deref(), Some("0.1.1"));
}

#[test]
fn undo_swap_restores_the_old_bundle_for_both_methods() {
    for prefer in [None, Some(Method::ThreeStep)] {
        let r = rig();
        let swapped = swap_in_with(&SystemFs, &r.spec, prefer).unwrap();
        undo_swap(&SystemFs, &r.spec, swapped).unwrap();
        assert_eq!(version_at(r.app()).as_deref(), Some("0.1.0"), "{prefer:?}");
        assert_eq!(version_at(&r.staged()).as_deref(), Some("0.1.1"));
        assert!(!r.side().exists() && !r.side_back().exists());
        r.assert_no_loss("after undo");
    }
}

#[test]
fn post_swap_check_mismatch_swaps_back() {
    for prefer in [None, Some(Method::ThreeStep)] {
        let mut r = rig();
        r.spec.new_short_version = "9.9.9".into(); // the staged bundle says 0.1.1
        let err = swap_in_with(&SystemFs, &r.spec, prefer).unwrap_err();
        assert_eq!(err.code, ErrorCode::SwapFailed, "{prefer:?}");
        assert_eq!(version_at(r.app()).as_deref(), Some("0.1.0"), "the old app must be back ({prefer:?})");
        assert_eq!(version_at(&r.staged()).as_deref(), Some("0.1.1"));
        assert!(!r.side().exists() && !r.side_back().exists() && !r.intent().exists(), "a clean swap back leaves no trace ({prefer:?})");
        r.assert_no_loss("post-swap mismatch");
    }
    // A wrong identifier is refused the same way.
    let mut r = rig();
    r.spec.bundle_id = "other.id".into();
    assert_eq!(swap_in(&SystemFs, &r.spec).unwrap_err().code, ErrorCode::SwapFailed);
    assert_eq!(version_at(r.app()).as_deref(), Some("0.1.0"));
}

// ------------------------------------------------------------------------------------------
// Failure injection: an operation fails, the process lives and rolls back
// ------------------------------------------------------------------------------------------

#[test]
fn every_failing_operation_leaves_the_old_app_in_place() {
    for no_exchange in [false, true] {
        let mut finished = false;
        for k in 0..12 {
            let r = rig();
            let fs_ops = FaultFs::new(Some(k), false, no_exchange);
            let res = swap_in(&fs_ops, &r.spec);
            let ctx = format!("no_exchange={no_exchange} fail_at={k} ops={:?}", fs_ops.ops.borrow());
            match res {
                Ok(_) => {
                    // The failing index is beyond the operations the swap needs.
                    assert_eq!(version_at(r.app()).as_deref(), Some("0.1.1"), "{ctx}");
                    finished = true;
                    break;
                }
                Err(e) => {
                    assert!(!e.detail.clone().unwrap_or_default().contains("repair_interrupted"), "in-process undo must succeed: {e} ({ctx})");
                    assert_eq!(version_at(r.app()).as_deref(), Some("0.1.0"), "the old app must stay at appPath ({ctx})");
                    assert_eq!(version_at(&r.staged()).as_deref(), Some("0.1.1"), "{ctx}");
                    assert!(!r.side().exists(), "{ctx}");
                    r.assert_no_loss(&ctx);
                }
            }
        }
        assert!(finished, "the injected failure index never ran past the last operation");
    }
}

// ------------------------------------------------------------------------------------------
// Power loss: the process dies at every point between two operations
// ------------------------------------------------------------------------------------------

#[test]
fn power_loss_at_every_point_loses_nothing_and_repair_restores_the_old_app() {
    let mut window_seen = false;
    for no_exchange in [false, true] {
        let mut finished = false;
        for k in 0..12 {
            let r = rig();
            let fs_ops = FaultFs::new(Some(k), true, no_exchange);
            let res = swap_in(&fs_ops, &r.spec);
            let ctx = format!("no_exchange={no_exchange} die_at={k} ops={:?}", fs_ops.ops.borrow());
            if res.is_ok() {
                assert_eq!(version_at(r.app()).as_deref(), Some("0.1.1"), "{ctx}");
                finished = true;
                break;
            }
            // Whatever the moment: both bundles exist exactly once.
            r.assert_no_loss(&ctx);
            if version_at(r.app()).is_none() {
                // The one residual window of the three-step fallback: the app slot is empty.
                assert!(no_exchange, "RENAME_SWAP must never leave the app slot empty ({ctx})");
                window_seen = true;
            }
            // After a restart, the repair brings the old app back and tidies the stage.
            let outcome = repair(&r.spec).unwrap();
            assert_eq!(version_at(r.app()).as_deref(), Some("0.1.0"), "repair must restore the old app ({ctx}, {outcome:?})");
            assert_eq!(version_at(&r.staged()).as_deref(), Some("0.1.1"), "{ctx}");
            assert!(!r.side().exists(), "{ctx}");
            // Idempotent.
            assert_eq!(repair(&r.spec).unwrap(), Repair::Nothing, "{ctx}");
        }
        assert!(finished);
    }
    assert!(window_seen, "the test must have hit the empty-app-slot window of the three-step fallback");
}

/// The regression for the verifier's DEFECT 1 and 2: the post-swap check refuses the new bundle
/// and the process dies (or the swap back fails) at every point of the swap back. Whatever the
/// moment, nothing is lost and the repair puts the OLD bundle at `app_path` (it used to install the
/// refused one for the three-step layout, or leave it for `RENAME_SWAP`).
#[test]
fn a_death_in_the_swap_back_after_a_refused_bundle_is_repaired_to_the_old_app() {
    for no_exchange in [false, true] {
        for crash in [true, false] {
            let mut finished = false;
            let mut back_hit = false;
            for k in 0..14 {
                let mut r = rig();
                r.spec.new_short_version = "9.9.9".into(); // the staged bundle says 0.1.1
                let fs_ops = FaultFs::new(Some(k), crash, no_exchange);
                let res = swap_in(&fs_ops, &r.spec);
                let ctx = format!("no_exchange={no_exchange} crash={crash} fail_at={k} ops={:?}", fs_ops.ops.borrow());
                let hit = crash && fs_ops.dead.get() || !crash && fs_ops.count.get() > k;
                if !hit {
                    // The injected index is past the last operation: the clean swap back happened.
                    assert_eq!(res.unwrap_err().code, ErrorCode::SwapFailed, "{ctx}");
                    r.assert_rolled_back(&ctx);
                    finished = true;
                    break;
                }
                let e = res.unwrap_err();
                let detail = e.detail.clone().unwrap_or_default();
                r.assert_no_loss(&ctx);
                if detail.contains("swapping back failed") {
                    back_hit = true;
                    // The refused bundle is installed; the error must say the repair is needed.
                    assert!(detail.contains("repair_interrupted"), "{ctx}: {detail}");
                }
                repair(&r.spec).unwrap_or_else(|e| panic!("repair failed: {e} ({ctx})"));
                r.assert_rolled_back(&ctx);
                assert_eq!(repair(&r.spec).unwrap(), Repair::Nothing, "idempotent ({ctx})");
            }
            assert!(finished && back_hit, "no_exchange={no_exchange} crash={crash}: finished={finished} back_hit={back_hit}");
        }
    }
}

/// `undo_swap` (the relauncher could not be spawned) dying half way: the repair must never roll
/// FORWARD to the bundle that was being undone.
#[test]
fn a_death_in_undo_swap_is_repaired_without_rolling_forward() {
    for prefer in [None, Some(Method::ThreeStep)] {
        let mut finished = false;
        let mut half_way = false;
        for k in 0..6 {
            let r = rig();
            let swapped = swap_in_with(&SystemFs, &r.spec, prefer).unwrap();
            let fs_ops = FaultFs::new(Some(k), true, false);
            let res = undo_swap(&fs_ops, &r.spec, swapped);
            let ctx = format!("{prefer:?} die_at={k} ops={:?}", fs_ops.ops.borrow());
            if res.is_ok() {
                r.assert_rolled_back(&ctx);
                finished = true;
                break;
            }
            r.assert_no_loss(&ctx);
            let outcome = repair(&r.spec).unwrap();
            if outcome == Repair::RestoredOld {
                half_way = true;
            }
            match version_at(r.app()).as_deref() {
                // The undo never started: the new bundle stays installed, the old one in the stage.
                Some("0.1.1") => {
                    assert_eq!(outcome, Repair::Nothing, "{ctx}");
                    assert_eq!(version_at(&r.staged()).as_deref(), Some("0.1.0"), "{ctx}");
                }
                _ => r.assert_rolled_back(&ctx),
            }
            assert!(!r.side().exists() && !r.side_back().exists(), "{ctx}");
        }
        assert!(finished);
        if prefer == Some(Method::ThreeStep) {
            assert!(half_way, "the three-step undo was never interrupted half way");
        }
    }
}

#[test]
fn a_leftover_intent_is_harmless_unless_its_bundle_is_installed() {
    // The swap never ran: the new bundle is still in the stage.
    let r = rig();
    fs::write(r.intent(), format!("{}\n", ino(&r.staged()))).unwrap();
    assert_eq!(repair(&r.spec).unwrap(), Repair::Nothing);
    assert!(!r.intent().exists());
    untouched(&r);
    // Garbage in the file.
    let r = rig();
    fs::write(r.intent(), "not a number").unwrap();
    assert_eq!(repair(&r.spec).unwrap(), Repair::Nothing);
    assert!(!r.intent().exists());
    untouched(&r);
    // The new bundle is installed and was never accepted: roll back.
    let r = rig();
    fs::write(r.intent(), format!("{}\n", ino(&r.staged()))).unwrap();
    swap_in(&SystemFs, &r.spec).unwrap();
    fs::write(r.intent(), format!("{}\n", ino(r.app()))).unwrap();
    assert_eq!(repair(&r.spec).unwrap(), Repair::RestoredOld);
    r.assert_rolled_back("intent names the installed bundle");
}

#[test]
fn repair_refuses_when_both_side_directories_exist() {
    let r = rig();
    fs::create_dir_all(r.side().join("Contents")).unwrap();
    fs::create_dir_all(r.side_back().join("Contents")).unwrap();
    fs::remove_dir_all(r.staged()).unwrap();
    assert_eq!(repair(&r.spec).unwrap_err().code, ErrorCode::SwapFailed);
}

#[test]
fn a_leftover_back_side_directory_is_refused() {
    let r = rig();
    fs::create_dir_all(r.side_back()).unwrap();
    assert_eq!(swap_in(&SystemFs, &r.spec).unwrap_err().code, ErrorCode::SwapFailed);
    untouched(&r);
}

#[test]
fn repair_refuses_to_guess() {
    let r = rig();
    // Both stage slots occupied next to an app.
    fs::create_dir_all(r.side().join("Contents")).unwrap();
    assert_eq!(repair(&r.spec).unwrap_err().code, ErrorCode::SwapFailed);
    // No app, only the stage slot.
    let r = rig();
    fs::remove_dir_all(r.app()).unwrap();
    assert_eq!(repair(&r.spec).unwrap_err().code, ErrorCode::SwapFailed);
    // Nothing at all.
    fs::remove_dir_all(r.staged()).unwrap();
    assert_eq!(repair(&r.spec).unwrap_err().code, ErrorCode::SwapFailed);
}

// ------------------------------------------------------------------------------------------
// Refusals before anything moves
// ------------------------------------------------------------------------------------------

fn untouched(r: &Rig) {
    assert_eq!(version_at(r.app()).as_deref(), Some("0.1.0"));
    assert_eq!(version_at(&r.staged()).as_deref(), Some("0.1.1"));
}

#[test]
fn a_symlink_at_app_path_is_refused() {
    let r = rig();
    let real = r.parent.join("Real.app");
    fs::rename(r.app(), &real).unwrap();
    symlink(&real, r.app()).unwrap();
    let e = swap_in(&SystemFs, &r.spec).unwrap_err();
    assert_eq!(e.code, ErrorCode::SwapFailed);
    assert_eq!(version_at(&real).as_deref(), Some("0.1.0"));
    assert_eq!(version_at(&r.staged()).as_deref(), Some("0.1.1"));
}

#[test]
fn a_symlink_as_staged_bundle_is_refused() {
    let r = rig();
    let real = r.parent.join("Elsewhere.app");
    fs::rename(r.staged(), &real).unwrap();
    symlink(&real, r.staged()).unwrap();
    assert_eq!(swap_in(&SystemFs, &r.spec).unwrap_err().code, ErrorCode::SwapFailed);
    assert_eq!(version_at(r.app()).as_deref(), Some("0.1.0"));
}

#[test]
fn stage_in_another_directory_is_refused() {
    let r = rig();
    let other = r.parent.join("sub");
    fs::create_dir(&other).unwrap();
    let stage2 = create_stage_dir(&other).unwrap();
    make_app(&stage2, DIR, &AppSpec { version: "0.1.1".into(), short_version: "0.1.1".into(), ..Default::default() });
    let mut spec = r.spec.clone();
    spec.stage_dir = stage2;
    assert_eq!(swap_in(&SystemFs, &spec).unwrap_err().code, ErrorCode::SwapFailed);
    assert_eq!(version_at(r.app()).as_deref(), Some("0.1.0"));
}

#[test]
fn a_stage_without_the_stage_name_is_refused() {
    let r = rig();
    let odd = r.parent.join("not-a-stage");
    fs::create_dir(&odd).unwrap();
    make_app(&odd, DIR, &AppSpec { version: "0.1.1".into(), short_version: "0.1.1".into(), ..Default::default() });
    let mut spec = r.spec.clone();
    spec.stage_dir = odd;
    assert_eq!(swap_in(&SystemFs, &spec).unwrap_err().code, ErrorCode::SwapFailed);
}

#[test]
fn an_app_owned_by_another_uid_is_a_shared_install() {
    let mut r = rig();
    // We cannot chown in a test; the owner the caller expects differs from the real one.
    r.spec.owner_uid = euid() + 1;
    assert_eq!(swap_in(&SystemFs, &r.spec).unwrap_err().code, ErrorCode::SharedInstall);
    untouched(&r);
}

#[test]
fn a_leftover_side_directory_is_refused() {
    let r = rig();
    fs::create_dir_all(r.side()).unwrap();
    assert_eq!(swap_in(&SystemFs, &r.spec).unwrap_err().code, ErrorCode::SwapFailed);
    untouched(&r);
}

#[test]
fn rename_new_never_replaces_an_existing_directory() {
    let r = rig();
    // The destination exists (empty): a plain rename(2) would silently replace it.
    let e = SystemFs.rename_new(&r.staged(), &r.parent.join("sentinel"));
    assert!(e.is_ok(), "control: a free name works");
    fs::create_dir(r.parent.join("occupied")).unwrap();
    let err = SystemFs.rename_new(&r.parent.join("sentinel"), &r.parent.join("occupied")).unwrap_err();
    assert_eq!(err.raw_os_error(), Some(libc::EEXIST));
    assert!(r.parent.join("sentinel").exists());
}

#[test]
fn a_missing_staged_bundle_is_an_error() {
    let r = rig();
    fs::remove_dir_all(r.staged()).unwrap();
    assert_eq!(swap_in(&SystemFs, &r.spec).unwrap_err().code, ErrorCode::SwapFailed);
    assert_eq!(version_at(r.app()).as_deref(), Some("0.1.0"));
}

// ------------------------------------------------------------------------------------------
// Real volumes (disk images): refusal across volumes and the natural fallback on exFAT
// ------------------------------------------------------------------------------------------

/// A mounted disk image, detached on drop.
struct Image {
    mount: PathBuf,
}

impl Image {
    fn attach(dir: &Path, fs_type: &str, name: &str) -> Option<Image> {
        let mount = dir.join(format!("mnt-{name}"));
        fs::create_dir_all(&mount).ok()?;
        Image::attach_at(dir, fs_type, name, &mount)
    }

    fn attach_at(dir: &Path, fs_type: &str, name: &str, mount: &Path) -> Option<Image> {
        let img = dir.join(format!("{name}.dmg"));
        let out = Command::new("/usr/bin/hdiutil").args(["create", "-size", "40m", "-fs", fs_type, "-volname", name, "-ov"]).arg(&img).output().ok()?;
        if !out.status.success() {
            return None;
        }
        let out = Command::new("/usr/bin/hdiutil").args(["attach", "-nobrowse", "-noverify", "-mountpoint"]).arg(mount).arg(&img).output().ok()?;
        if !out.status.success() {
            return None;
        }
        Some(Image { mount: mount.to_path_buf() })
    }
}

impl Drop for Image {
    fn drop(&mut self) {
        let _ = Command::new("/usr/bin/hdiutil").args(["detach", "-force"]).arg(&self.mount).output();
    }
}

#[test]
fn a_staged_bundle_on_another_volume_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir(tmp.path().join("main")).unwrap();
    let r = rig_in(&tmp.path().join("main"));
    // The staged slot becomes the mount point of another volume.
    fs::remove_dir_all(r.staged()).unwrap();
    fs::create_dir(r.staged()).unwrap();
    let Some(_img) = Image::attach_at(tmp.path(), "APFS", "SwapOther", &r.staged()) else {
        eprintln!("SKIP: hdiutil could not create or attach an image here");
        return;
    };
    make_app_at(&r.staged(), "0.1.1");
    let e = swap_in(&SystemFs, &r.spec).unwrap_err();
    eprintln!("RESULT cross-volume refusal: {e}");
    assert!(matches!(e.code, ErrorCode::SwapFailed), "{e:?}");
    assert_eq!(version_at(r.app()).as_deref(), Some("0.1.0"));
    assert_eq!(version_at(&r.staged()).as_deref(), Some("0.1.1"));
}

/// Copies the contents of a fresh bundle into `dir`, which already is the bundle directory.
fn make_app_at(dir: &Path, version: &str) {
    let tmp = tempfile::tempdir().unwrap();
    let a = make_app(tmp.path(), DIR, &AppSpec { version: version.into(), short_version: version.into(), ..Default::default() });
    let st = Command::new("/bin/cp").arg("-R").arg(a.join("Contents")).arg(dir).status().unwrap();
    assert!(st.success());
}

#[test]
fn swap_on_real_volumes_of_every_kind_keeps_one_valid_app() {
    // Appendix F item 4: APFS (temp dir) and, when disk images can be made, HFS+ and exFAT. Which
    // method each volume takes is printed; the invariant is the same for all.
    let tmp = tempfile::tempdir().unwrap();
    for (fs_type, name) in [("HFS+", "SwapHfs"), ("ExFAT", "SwapExfat"), ("APFS", "SwapApfs")] {
        let Some(img) = Image::attach(tmp.path(), fs_type, name) else {
            eprintln!("SKIP {fs_type}: no disk image");
            continue;
        };
        let r = rig_in(&img.mount);
        let res = swap_in(&SystemFs, &r.spec);
        match res {
            Ok(s) => {
                eprintln!("RESULT {fs_type}: swap method {:?}", s.method);
                assert_eq!(version_at(r.app()).as_deref(), Some("0.1.1"));
                r.assert_no_loss(fs_type);
                undo_swap(&SystemFs, &r.spec, s).unwrap();
                assert_eq!(version_at(r.app()).as_deref(), Some("0.1.0"));
            }
            Err(e) => {
                eprintln!("RESULT {fs_type}: swap error {e}");
                assert_eq!(version_at(r.app()).as_deref(), Some("0.1.0"), "{fs_type}: the old app must be intact after a refusal");
            }
        }
    }
}

#[allow(dead_code)]
fn _use(_: UpdateError) {}
