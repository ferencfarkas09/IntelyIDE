//! The swap: replace the installed app by the staged one, atomically where the volume allows it
//! ((design notes: updater-spec) 4.11 A4), with an in-process rollback and a repair for an interrupted swap.
//!
//! Layout after a successful swap, for both methods: the new bundle is at `app_path` and the OLD
//! bundle is at `<stage>/<bundle dir>` (never under a `.old` name). The swap is symmetric, so the
//! same call undoes it (`undo_swap`).
//!
//! * `Method::Exchange`: one `renamex_np(RENAME_SWAP)`; at no instant is `app_path` missing.
//! * `Method::ThreeStep` (EINVAL/ENOTSUP, e.g. exFAT): three renames through `<stage>/<dir>.new`.
//!   Between its second and third rename `app_path` does not exist (unavoidable: `rename(2)` cannot
//!   replace a non-empty directory). A failure of a step is undone in-process; a process death in
//!   that window leaves both bundles in the stage directory and `repair_interrupted` puts the old
//!   one back. This residual is stated in the spec report, not hidden.
//!
//! The direction of a three-step swap is encoded in its side name, so a repair never has to guess
//! which bundle is which: the forward swap parks the NEW bundle under `<dir>.new`, a swap back
//! (post-swap check failed, `undo_swap`) parks the OLD one under `<dir>.back`. For `RENAME_SWAP`
//! (one atomic call, no side name) `swap_in` first writes an intent file into the stage holding the
//! inode of the new bundle (stable on the volumes that have `RENAME_SWAP`); it is removed once the
//! swap is verified or has been swapped back. A leftover intent whose bundle sits at `app_path`
//! tells the repair that a bundle that was never accepted is installed.
//!
//! All file-system mutation goes through `FsOps`, so the tests can fail or "kill" the process at
//! every operation. `unsafe` is limited to the single `renamex_np` call in `renamex`.

use std::ffi::CString;
use std::fs;
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use crate::stage::is_stage_dir_name;
use crate::{ErrorCode, UpdateError};

/// The file-system operations the swap needs, injectable for failure and crash tests.
pub trait FsOps {
    /// Atomically exchange two existing directory entries (`RENAME_SWAP`).
    fn exchange(&self, a: &Path, b: &Path) -> io::Result<()>;
    /// Rename `from` to `to`, which must NOT exist (`RENAME_EXCL`); never replaces anything.
    fn rename_new(&self, from: &Path, to: &Path) -> io::Result<()>;
}

/// The real file system.
pub struct SystemFs;

impl FsOps for SystemFs {
    fn exchange(&self, a: &Path, b: &Path) -> io::Result<()> {
        renamex(a, b, libc::RENAME_SWAP)
    }

    fn rename_new(&self, from: &Path, to: &Path) -> io::Result<()> {
        match renamex(from, to, libc::RENAME_EXCL) {
            Err(e) if is_unsupported(&e) => {
                // The volume has no RENAME_EXCL: check by hand and fall back to a plain rename.
                match fs::symlink_metadata(to) {
                    Ok(_) => Err(io::Error::from_raw_os_error(libc::EEXIST)),
                    Err(e) if e.kind() == io::ErrorKind::NotFound => fs::rename(from, to),
                    Err(e) => Err(e),
                }
            }
            other => other,
        }
    }
}

fn renamex(from: &Path, to: &Path, flags: libc::c_uint) -> io::Result<()> {
    let f = CString::new(from.as_os_str().as_bytes()).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
    let t = CString::new(to.as_os_str().as_bytes()).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
    // SAFETY: both pointers come from live, NUL-terminated CStrings that outlive the call; the
    // call only reads them, and its result is checked below.
    let rc = unsafe { libc::renamex_np(f.as_ptr(), t.as_ptr(), flags) };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// `EINVAL`/`ENOTSUP`: the volume does not implement the flag (spec A4).
pub fn is_unsupported(e: &io::Error) -> bool {
    matches!(e.raw_os_error(), Some(libc::EINVAL) | Some(libc::ENOTSUP))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Exchange,
    ThreeStep,
}

/// What `swap_in` needs. Every value is a constant or derived by the caller, never taken from the
/// archive: `bundle_dir_name` is `Config.bundle_dir_name`.
#[derive(Clone, Debug)]
pub struct SwapSpec {
    /// The canonical installed app, `<parent>/<bundle dir>`.
    pub app_path: PathBuf,
    /// `<parent>/.IntelyIDE.update-<16 hex>`; must be a direct child of the same `<parent>`.
    pub stage_dir: PathBuf,
    pub bundle_dir_name: String,
    /// The only accepted `CFBundleIdentifier` after the swap.
    pub bundle_id: String,
    /// The `CFBundleShortVersionString` the new bundle must report after the swap.
    pub new_short_version: String,
    /// The effective uid; both bundles must be owned by it (a foreign owner is `sharedInstall`).
    pub owner_uid: u32,
}

/// Which way a three-step swap runs; it picks the side name (see the module comment).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Direction {
    /// Install the staged (new) bundle: the new bundle waits under `<dir>.new`.
    Forward,
    /// Put the old bundle back: the old bundle waits under `<dir>.back`.
    Back,
}

/// The intent file of a `RENAME_SWAP` swap, in the stage directory (next to `STAGE_MARKER`).
const INTENT_FILE: &str = ".swap-intent";

fn side_name(bundle_dir_name: &str, dir: Direction) -> String {
    match dir {
        Direction::Forward => format!("{bundle_dir_name}.new"),
        Direction::Back => format!("{bundle_dir_name}.back"),
    }
}

/// The three slots a swap works with.
struct Slots {
    app: PathBuf,
    staged: PathBuf,
    stage_dir: PathBuf,
    side: PathBuf,
}

impl Slots {
    fn new(app: &Path, stage_dir: &Path, bundle_dir_name: &str, dir: Direction) -> Slots {
        Slots { app: app.to_path_buf(), staged: stage_dir.join(bundle_dir_name), stage_dir: stage_dir.to_path_buf(), side: stage_dir.join(side_name(bundle_dir_name, dir)) }
    }

    fn of(spec: &SwapSpec, dir: Direction) -> Slots {
        Slots::new(&spec.app_path, &spec.stage_dir, &spec.bundle_dir_name, dir)
    }
}

impl SwapSpec {
    fn staged(&self) -> PathBuf {
        self.stage_dir.join(&self.bundle_dir_name)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Swapped {
    pub method: Method,
}

fn swap_err(detail: impl Into<String>) -> UpdateError {
    UpdateError::with(ErrorCode::SwapFailed, detail)
}

fn map_io(e: &io::Error, what: &str) -> UpdateError {
    match e.raw_os_error() {
        // EPERM is also what macOS App Management answers (spec R-3).
        Some(libc::EACCES) | Some(libc::EPERM) => UpdateError::with(ErrorCode::NotWritable, format!("{what}: {e}")),
        Some(libc::EROFS) => UpdateError::with(ErrorCode::ReadOnlyVolume, what.to_string()),
        _ => swap_err(format!("{what}: {e}")),
    }
}

fn real_dir(path: &Path, what: &str) -> Result<fs::Metadata, UpdateError> {
    let m = fs::symlink_metadata(path).map_err(|e| swap_err(format!("{what} is missing: {e}")))?;
    if !m.file_type().is_dir() {
        return Err(swap_err(format!("{what} is not a real directory")));
    }
    Ok(m)
}

/// All the refusals that happen before anything is renamed.
pub fn check_preconditions(spec: &SwapSpec) -> Result<(), UpdateError> {
    let parent = spec.app_path.parent().ok_or_else(|| swap_err("app path has no parent"))?;
    if spec.app_path.file_name().and_then(|n| n.to_str()) != Some(spec.bundle_dir_name.as_str()) {
        return Err(swap_err("app path does not end in the bundle directory name"));
    }
    let stage_name = spec.stage_dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !is_stage_dir_name(stage_name) {
        return Err(swap_err("not a stage directory name"));
    }
    if spec.stage_dir.parent() != Some(parent) {
        return Err(swap_err("stage and app are not in the same directory"));
    }
    // A symlink at `app_path` is refused (lstat); so is anything that is not a directory.
    let app = real_dir(&spec.app_path, "installed app")?;
    let stage = real_dir(&spec.stage_dir, "stage directory")?;
    let staged = real_dir(&spec.staged(), "staged bundle")?;
    if app.uid() != spec.owner_uid {
        return Err(UpdateError::with(ErrorCode::SharedInstall, "the installed app belongs to another user"));
    }
    if staged.uid() != spec.owner_uid || stage.uid() != spec.owner_uid {
        return Err(swap_err("the staged bundle belongs to another user"));
    }
    if app.dev() != staged.dev() || app.dev() != stage.dev() {
        return Err(swap_err("stage and app are on different volumes"));
    }
    for dir in [Direction::Forward, Direction::Back] {
        if fs::symlink_metadata(&Slots::of(spec, dir).side).is_ok() {
            return Err(swap_err("a leftover side directory exists in the stage"));
        }
    }
    Ok(())
}

/// Record the inode of the new bundle before anything moves (see the module comment).
fn write_intent(spec: &SwapSpec) -> Result<(), UpdateError> {
    let path = spec.stage_dir.join(INTENT_FILE);
    let _ = fs::remove_file(&path);
    let ino = fs::symlink_metadata(spec.staged()).map_err(|e| map_io(&e, "intent"))?.ino();
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .and_then(|mut f| f.write_all(format!("{ino}\n").as_bytes()))
        .map_err(|e| map_io(&e, "intent"))
}

fn clear_intent(stage_dir: &Path) {
    let _ = fs::remove_file(stage_dir.join(INTENT_FILE));
}

/// The error text of a swap that left things for `repair_interrupted` to finish.
fn needs_repair(e: &UpdateError) -> bool {
    e.detail.as_deref().unwrap_or("").contains("repair_interrupted")
}

/// Exchange `a` and `b` (both exist) through the side name `t` (not existing) with only
/// `rename_new`. A failed step is undone; the error says whether the undo succeeded.
fn three_step(fs_ops: &dyn FsOps, a: &Path, b: &Path, t: &Path) -> Result<(), UpdateError> {
    fs_ops.rename_new(a, t).map_err(|e| map_io(&e, "step 1"))?;
    if let Err(e) = fs_ops.rename_new(b, a) {
        // b is untouched, a is at t: put a back.
        let undo = fs_ops.rename_new(t, a);
        return Err(with_undo(map_io(&e, "step 2"), undo));
    }
    if let Err(e) = fs_ops.rename_new(t, b) {
        // b is now at a, the first bundle at t: undo step 2, then step 1.
        let undo = match fs_ops.rename_new(a, b) {
            Ok(()) => fs_ops.rename_new(t, a),
            Err(e) => Err(e),
        };
        return Err(with_undo(map_io(&e, "step 3"), undo));
    }
    Ok(())
}

fn with_undo(mut e: UpdateError, undo: io::Result<()>) -> UpdateError {
    if undo.is_err() {
        let d = e.detail.take().unwrap_or_default();
        e.detail = Some(format!("{d}; the undo failed, run repair_interrupted"));
        e.code = ErrorCode::SwapFailed;
    }
    e
}

/// Exchange the staged bundle and the installed app (the same pair both ways).
fn exchange_pair(fs_ops: &dyn FsOps, slots: &Slots, prefer: Option<Method>) -> Result<Method, UpdateError> {
    if prefer != Some(Method::ThreeStep) {
        match fs_ops.exchange(&slots.staged, &slots.app) {
            Ok(()) => return Ok(Method::Exchange),
            Err(e) if is_unsupported(&e) => {}
            Err(e) => return Err(map_io(&e, "swap")),
        }
    }
    three_step(fs_ops, &slots.staged, &slots.app, &slots.side)?;
    Ok(Method::ThreeStep)
}

/// Check that the installed bundle is the new one (identifier and short version).
pub fn verify_installed(app: &Path, bundle_id: &str, short_version: &str) -> Result<(), UpdateError> {
    let plist_path = app.join("Contents/Info.plist");
    let value = plist::Value::from_file(&plist_path).map_err(|_| swap_err("Info.plist of the installed bundle is unreadable"))?;
    let dict = value.as_dictionary().ok_or_else(|| swap_err("Info.plist is not a dictionary"))?;
    let get = |k: &str| dict.get(k).and_then(|v| v.as_string()).unwrap_or("");
    if get("CFBundleIdentifier") != bundle_id {
        return Err(swap_err("the installed bundle has another identifier"));
    }
    if get("CFBundleShortVersionString") != short_version {
        return Err(swap_err("the installed bundle has another version"));
    }
    Ok(())
}

/// Spec A4. On success the new bundle is at `app_path`. Any error leaves a valid app at
/// `app_path` (the old one) unless the error text says `run repair_interrupted`.
pub fn swap_in(fs_ops: &dyn FsOps, spec: &SwapSpec) -> Result<Swapped, UpdateError> {
    swap_in_with(fs_ops, spec, None)
}

/// `swap_in` with the method forced (`Some(ThreeStep)` skips `RENAME_SWAP`; tests and diagnosis).
pub fn swap_in_with(fs_ops: &dyn FsOps, spec: &SwapSpec, prefer: Option<Method>) -> Result<Swapped, UpdateError> {
    check_preconditions(spec)?;
    write_intent(spec)?;
    let method = match exchange_pair(fs_ops, &Slots::of(spec, Direction::Forward), prefer) {
        Ok(m) => m,
        Err(e) => {
            if !needs_repair(&e) {
                clear_intent(&spec.stage_dir);
            }
            return Err(e);
        }
    };
    if let Err(why) = verify_installed(&spec.app_path, &spec.bundle_id, &spec.new_short_version) {
        // The post-swap check failed: swap straight back, in the same way. If that fails too the
        // refused bundle stays installed and the intent file stays, so `repair_interrupted` can
        // finish the job at the next start.
        return Err(match exchange_pair(fs_ops, &Slots::of(spec, Direction::Back), Some(method)) {
            Ok(_) => {
                clear_intent(&spec.stage_dir);
                why
            }
            Err(e) => swap_err(format!("{}; swapping back failed: {}; run repair_interrupted", why.detail.unwrap_or_default(), e)),
        });
    }
    clear_intent(&spec.stage_dir);
    Ok(Swapped { method })
}

/// Undo a successful `swap_in` in-process (A5: the relauncher could not be spawned). Afterwards
/// the old bundle is at `app_path` again and the new one at `<stage>/<bundle dir>`.
pub fn undo_swap(fs_ops: &dyn FsOps, spec: &SwapSpec, swapped: Swapped) -> Result<(), UpdateError> {
    exchange_pair(fs_ops, &Slots::of(spec, Direction::Back), Some(swapped.method)).map(|_| ())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Repair {
    /// Nothing to do: `app_path` is a bundle and the stage has no side directory.
    Nothing,
    /// The side directory was moved back to its place in the stage; `app_path` was intact.
    TidiedSide,
    /// `app_path` was missing and the OLD bundle was put back.
    RestoredOld,
}

/// Repair the layout a process death (or a failed swap back) can leave. Idempotent. Always rolls
/// BACK to the old bundle: no relauncher exists yet at that point. It needs no knowledge of the
/// new version, so `state::recover` can call it at every start. Which bundle is which comes from
/// the side name (`.new` holds the new bundle, `.back` the old one) or, for `RENAME_SWAP`, from the
/// intent file (module comment).
pub fn repair_interrupted(fs_ops: &dyn FsOps, app_path: &Path, stage_dir: &Path, bundle_dir_name: &str) -> Result<Repair, UpdateError> {
    let fwd = Slots::new(app_path, stage_dir, bundle_dir_name, Direction::Forward);
    let back = Slots::new(app_path, stage_dir, bundle_dir_name, Direction::Back);
    let (staged, app) = (&fwd.staged, &fwd.app);
    let app_ok = fs::symlink_metadata(app).map(|m| m.file_type().is_dir()).unwrap_or(false);
    let staged_there = fs::symlink_metadata(staged).is_ok();
    let new_there = fs::symlink_metadata(&fwd.side).is_ok();
    let back_there = fs::symlink_metadata(&back.side).is_ok();
    let repaired = match (app_ok, staged_there, new_there, back_there) {
        (_, _, true, true) => Err(swap_err("both side directories exist; refusing to guess")),
        // No side directory: a complete layout. Only an intent file can say it is the wrong one.
        (true, _, false, false) => return repair_by_intent(fs_ops, &fwd, &back),
        // Forward swap, after step 1: the new bundle waits under the side name, the stage slot is empty.
        (true, false, true, false) => fs_ops.rename_new(&fwd.side, staged).map_err(|e| map_io(&e, "repair")).map(|_| Repair::TidiedSide),
        // Forward swap, after step 2: the app slot is empty, the old bundle is in the stage slot.
        (false, true, true, false) => fs_ops
            .rename_new(staged, app)
            .and_then(|_| fs_ops.rename_new(&fwd.side, staged))
            .map_err(|e| map_io(&e, "repair"))
            .map(|_| Repair::RestoredOld),
        // Swap back, after step 1: the refused bundle is still at the app slot, the old one waits
        // under the side name and the stage slot is empty.
        (true, false, false, true) => fs_ops
            .rename_new(app, staged)
            .and_then(|_| fs_ops.rename_new(&back.side, app))
            .map_err(|e| map_io(&e, "repair"))
            .map(|_| Repair::RestoredOld),
        // Swap back, after step 2: the app slot is empty, the refused bundle is in the stage slot.
        (false, true, false, true) => fs_ops.rename_new(&back.side, app).map_err(|e| map_io(&e, "repair")).map(|_| Repair::RestoredOld),
        (true, true, _, _) => Err(swap_err("both stage slots are occupied next to a bundle; refusing to guess")),
        (false, true, false, false) => Err(swap_err("the app slot is empty and only one bundle is left; refusing to guess which")),
        (false, false, _, _) => Err(swap_err("no bundle left to restore")),
    }?;
    clear_intent(stage_dir);
    Ok(repaired)
}

/// A complete layout (a bundle at the app slot and one in the stage slot, no side directory) with
/// an intent file: if the bundle the intent names is installed, it never was accepted (the process
/// died before the swap was verified, or the swap back failed), so put the old one back.
fn repair_by_intent(fs_ops: &dyn FsOps, fwd: &Slots, back: &Slots) -> Result<Repair, UpdateError> {
    let intent = fwd.stage_dir.join(INTENT_FILE);
    let Ok(text) = fs::read_to_string(&intent) else { return Ok(Repair::Nothing) };
    let new_ino = text.trim().parse::<u64>().ok();
    let installed = fs::symlink_metadata(&fwd.app).ok().filter(|m| m.file_type().is_dir()).map(|m| m.ino());
    let staged = fs::symlink_metadata(&fwd.staged).ok().filter(|m| m.file_type().is_dir()).map(|m| m.ino());
    if new_ino.is_some() && installed == new_ino && staged.is_some() {
        exchange_pair(fs_ops, back, None)?;
        clear_intent(&fwd.stage_dir);
        return Ok(Repair::RestoredOld);
    }
    // The new bundle is still in the stage (the swap never ran), the swap is complete and was
    // accepted, or the file is garbage: nothing to roll back.
    clear_intent(&fwd.stage_dir);
    Ok(Repair::Nothing)
}
