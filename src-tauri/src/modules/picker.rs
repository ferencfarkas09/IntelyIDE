//! Tauri glue of the folder picker ((design notes: workspaces-spec) section 5, task P2): the `picker_*` commands, the `rfd`
//! backend, the window drag-drop hook, event emission and `git init`. The logic lives in `intely_pathpick::Picker`;
//! everything here that does not need an `AppHandle` is a plain function so it is tested without a window.
//!
//! Wiring (owned by C5a/C5b, see the hand-off in the P2 report): `picker::setup(app)?` in `setup`, the commands below in
//! `generate_handler!`, and `picker::on_drag_drop(window.app_handle(), event)` for `WindowEvent::DragDrop` of `main`.
//!
//! The `rfd` dialog was NOT exercised here (no GUI session): `RfdBackend` drives `AsyncFileDialog` from a blocking
//! worker; rfd hops to the main thread itself on macOS. Manual check M1 decides whether the osascript fallback (P5) is needed.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use intely_core::jail::{Jail, Mode};
use intely_core::EngineError;
use intely_pathpick::backend::{NativeAnswer, NativeRequest, PickBackend};
use intely_pathpick::types::codes;
use intely_pathpick::{
    BackendChain, Capabilities, DirListing, DropEvent, FakeBackend, ListOpts, NativeKind, NativeOptions, PathTokens, Picked, Picker,
    Policy, ScanOpts, ScanProgress, ScanResults, ScanStarted, StartInfo, Validator,
};
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, State};

type Res<T> = Result<T, EngineError>;

/// `x-apple.systempreferences:` URL of Privacy & Security > Files and Folders. Fixed: the command takes no argument.
const PRIVACY_URL: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";
const SCAN_EVENT_GAP: Duration = Duration::from_millis(200);

pub struct PickerState {
    picker: Arc<Picker>,
}

impl PickerState {
    pub fn new(picker: Arc<Picker>) -> Self {
        Self { picker }
    }

    /// The token table, shared with the workspaces module (one `Arc` serves both, spec 5.6).
    pub fn tokens(&self) -> Arc<PathTokens> {
        self.picker.tokens.clone()
    }

    pub fn picker(&self) -> &Arc<Picker> {
        &self.picker
    }
}

/// The real macOS dialog (`NSOpenPanel` through `rfd`). Cancel is `Cancelled`; rfd reports no other failure.
pub struct RfdBackend {
    app: AppHandle,
}

impl PickBackend for RfdBackend {
    fn available(&self) -> bool {
        cfg!(target_os = "macos")
    }

    fn pick(&self, req: &NativeRequest) -> Result<NativeAnswer, EngineError> {
        let mut dialog = rfd::AsyncFileDialog::new().set_can_create_directories(req.can_create);
        if !req.title.is_empty() {
            dialog = dialog.set_title(req.title.clone());
        }
        if let Some(start) = &req.start {
            dialog = dialog.set_directory(start);
        }
        if !req.extensions.is_empty() {
            dialog = dialog.add_filter("files", &req.extensions);
        }
        if let Some(win) = self.app.get_webview_window("main") {
            dialog = dialog.set_parent(&win);
        }
        let kind = req.kind.clone();
        let picked: Option<Vec<PathBuf>> = tauri::async_runtime::block_on(async move {
            match kind {
                NativeKind::Folder => dialog.pick_folder().await.map(|h| vec![h.path().to_path_buf()]),
                NativeKind::Folders => dialog.pick_folders().await.map(|v| v.into_iter().map(|h| h.path().to_path_buf()).collect()),
                NativeKind::File => dialog.pick_file().await.map(|h| vec![h.path().to_path_buf()]),
                NativeKind::Files => dialog.pick_files().await.map(|v| v.into_iter().map(|h| h.path().to_path_buf()).collect()),
            }
        });
        Ok(match picked {
            Some(p) if !p.is_empty() => NativeAnswer::Paths(p),
            _ => NativeAnswer::Cancelled,
        })
    }
}

/// `INTELY_PICKER=inapp` reports the system dialog unavailable.
fn inapp_forced() -> bool {
    std::env::var("INTELY_PICKER").is_ok_and(|v| v.trim().eq_ignore_ascii_case("inapp"))
}

/// The state over an explicit backend (tests use a fake one).
pub fn state_with(policy: Policy, tokens: Arc<PathTokens>, backend: Arc<dyn PickBackend>, inapp: bool) -> PickerState {
    PickerState::new(Arc::new(Picker::new(Validator::new(policy), tokens, backend).force_inapp(inapp)))
}

pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let jail = Jail::global();
    let policy = Policy::real(jail.clone());
    // The scripted backend answers only under the e2e jail; the real dialog is the fallback.
    let chain = BackendChain(vec![Box::new(FakeBackend::from_env(jail)), Box::new(RfdBackend { app: app.handle().clone() })]);
    app.manage(state_with(policy, Arc::new(PathTokens::new()), Arc::new(chain), inapp_forced()));
    Ok(())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| EngineError::new(codes::IO, format!("picker task failed: {e}")))?
}

#[tauri::command]
pub async fn picker_capabilities(state: State<'_, PickerState>) -> Res<Capabilities> {
    Ok(state.picker.capabilities())
}

#[tauri::command]
pub async fn picker_start(state: State<'_, PickerState>) -> Res<StartInfo> {
    let p = state.picker.clone();
    blocking(move || Ok(p.start())).await
}

#[tauri::command]
pub async fn picker_list(state: State<'_, PickerState>, path: String, opts: ListOpts) -> Res<DirListing> {
    let p = state.picker.clone();
    blocking(move || p.list(&path, &opts)).await
}

#[tauri::command]
pub async fn picker_pick(state: State<'_, PickerState>, path: String, purpose: String) -> Res<Picked> {
    let p = state.picker.clone();
    blocking(move || p.pick(&path, &purpose)).await
}

#[tauri::command]
pub async fn picker_native(state: State<'_, PickerState>, opts: NativeOptions) -> Res<Option<Vec<Picked>>> {
    let p = state.picker.clone();
    blocking(move || p.native(&opts)).await
}

/// Progress is forwarded as `picker:scan`, at most every 200 ms and always the final one.
fn scan_emitter(app: AppHandle) -> Arc<dyn Fn(&ScanProgress) + Send + Sync> {
    let last = Mutex::new(None::<Instant>);
    Arc::new(move |p: &ScanProgress| {
        let mut last = last.lock().unwrap();
        if p.done || last.is_none_or(|t| t.elapsed() >= SCAN_EVENT_GAP) {
            *last = Some(Instant::now());
            let _ = app.emit("picker:scan", p);
        }
    })
}

#[tauri::command]
pub async fn picker_scan_start(app: AppHandle, state: State<'_, PickerState>, root: String, opts: ScanOpts) -> Res<ScanStarted> {
    let p = state.picker.clone();
    blocking(move || Picker::scan_start(&p, &root, &opts, scan_emitter(app))).await
}

#[tauri::command]
pub async fn picker_scan_results(state: State<'_, PickerState>, scan_id: String, after: Option<u32>) -> Res<ScanResults> {
    state.picker.scan_results(&scan_id, after)
}

#[tauri::command]
pub async fn picker_scan_cancel(state: State<'_, PickerState>, scan_id: String) -> Res<()> {
    state.picker.scan_cancel(&scan_id);
    Ok(())
}

#[tauri::command]
pub async fn picker_take_drop(state: State<'_, PickerState>) -> Res<Vec<Picked>> {
    Ok(state.picker.take_drop())
}

#[tauri::command]
pub async fn picker_drop_listen(state: State<'_, PickerState>, on: bool) -> Res<()> {
    state.picker.drop_listen(on);
    Ok(())
}

#[tauri::command]
pub async fn picker_open_privacy_settings() -> Res<()> {
    // Fixed argument, no shell, nothing from the webview.
    std::process::Command::new("open")
        .arg(PRIVACY_URL)
        .stdin(std::process::Stdio::null())
        .status()
        .map(|_| ())
        .map_err(|e| EngineError::new(codes::IO, e.to_string()))
}

/// `picker_git_init`: every refusal that needs no git first, then the (jailed) `git init`, then the folder is validated
/// again and comes back as a repository with a fresh token.
pub async fn git_init_inner(picker: &Arc<Picker>, token: String, confirm: String, confirm_large: bool) -> Res<Picked> {
    let p = picker.clone();
    let path = blocking(move || p.init_prepare(&token, &confirm, confirm_large)).await?;
    intely_core::git::init::init_repo(&picker.validator.policy.jail, &path, "main").await?;
    let p = picker.clone();
    blocking(move || p.init_finish(&path)).await
}

#[tauri::command]
pub async fn picker_git_init(state: State<'_, PickerState>, token: String, confirm: String, confirm_large: Option<bool>) -> Res<Picked> {
    git_init_inner(&state.picker, token, confirm, confirm_large.unwrap_or(false)).await
}

/// `e2e_drop`: feeds the drop inbox as the window hook would. The mode is checked here, because handlers are registered
/// statically and `cfg` alone cannot keep a command out of a normal run.
pub fn e2e_drop_inner(picker: &Picker, paths: &[String]) -> Res<u32> {
    if picker.validator.policy.mode() != Mode::E2e {
        return Err(EngineError::new(codes::TEST_JAIL, "e2e_drop works only under INTELY_E2E"));
    }
    let list: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    Ok(picker.on_drop(&list) as u32)
}

#[tauri::command]
pub async fn e2e_drop(app: AppHandle, state: State<'_, PickerState>, paths: Vec<String>) -> Res<u32> {
    let p = state.picker.clone();
    let count = blocking(move || e2e_drop_inner(&p, &paths)).await?;
    if count > 0 {
        let _ = app.emit("picker:drop", DropEvent { count });
    }
    Ok(count)
}

/// The `WindowEvent::DragDrop` hook for the main window. Acts only while a screen declared itself a drop target; the
/// validation runs off the event loop.
pub fn on_drag_drop(app: &AppHandle, event: &DragDropEvent) {
    let DragDropEvent::Drop { paths, .. } = event else { return };
    let Some(state) = app.try_state::<PickerState>() else { return };
    if !state.picker.is_listening() {
        return;
    }
    let picker = state.picker.clone();
    let paths: Vec<PathBuf> = paths.clone();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let count = picker.on_drop(&paths) as u32;
        if count > 0 {
            let _ = app.emit("picker:drop", DropEvent { count });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use intely_pathpick::types::PathKind;
    use std::path::Path;

    struct Env {
        _dir: tempfile::TempDir,
        root: PathBuf,
        state: PickerState,
        script: PathBuf,
    }

    fn env(jail: Jail) -> Env {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let fixture = root.join("fixture");
        std::fs::create_dir_all(&fixture).unwrap();
        let script = root.join("pick.jsonl");
        std::fs::write(&script, "").unwrap();
        let jail = Arc::new(match jail.mode() {
            Mode::E2e => Jail::e2e(&fixture),
            _ => jail,
        });
        let policy = Policy::new(jail.clone(), root.join("home"), root.join("home/state"));
        let backend = Arc::new(FakeBackend::new(jail, Some(script.clone())));
        let state = state_with(policy, Arc::new(PathTokens::new()), backend, false);
        Env { _dir: dir, root, state, script }
    }

    fn opts(kind: NativeKind, purpose: &str) -> NativeOptions {
        NativeOptions { kind, purpose: purpose.into(), title: None, extensions: None, start_token: None }
    }

    fn repo(dir: &Path) {
        std::fs::create_dir_all(dir.join(".git/objects")).unwrap();
        std::fs::create_dir_all(dir.join(".git/refs")).unwrap();
        std::fs::write(dir.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    }

    #[test]
    fn e2e_drop_errors_in_off_and_read_only_mode() {
        for jail in [Jail::off(), Jail::read_only()] {
            let e = env(jail);
            e.state.picker.drop_listen(true);
            let err = e2e_drop_inner(&e.state.picker, &[e.root.to_string_lossy().into_owned()]).unwrap_err();
            assert_eq!(err.code, "testJail");
        }
    }

    #[test]
    fn e2e_drop_fills_the_inbox_only_while_listening() {
        let e = env(Jail::e2e("/"));
        let r = e.root.join("fixture/r");
        repo(&r);
        let p = r.to_string_lossy().into_owned();
        assert_eq!(e2e_drop_inner(&e.state.picker, &[p.clone()]).unwrap(), 0, "ignored: nobody listens");
        e.state.picker.drop_listen(true);
        assert_eq!(e2e_drop_inner(&e.state.picker, &[p]).unwrap(), 1);
        let got = e.state.picker.take_drop();
        assert_eq!((got.len(), got[0].kind), (1, PathKind::Repo));
        assert!(e.state.picker.take_drop().is_empty());
    }

    #[test]
    fn the_scripted_dialog_works_only_in_e2e_and_validates_through_the_jail() {
        let e = env(Jail::e2e("/"));
        let r = e.root.join("fixture/api");
        repo(&r);
        std::fs::write(&e.script, format!("{{\"paths\":[\"{}\"]}}\n{{\"paths\":[\"{}\"]}}\n", r.display(), e.root.display())).unwrap();
        let ok = e.state.picker.native(&opts(NativeKind::Folder, "workspaceRoot")).unwrap().unwrap();
        assert_eq!(ok[0].kind, PathKind::Repo);
        let outside = e.state.picker.native(&opts(NativeKind::Folder, "workspaceRoot")).unwrap_err();
        assert_eq!(outside.code, "testJail");
        let off = env(Jail::off());
        assert!(!off.state.picker.capabilities().native);
        assert_eq!(off.state.picker.native(&opts(NativeKind::Folder, "workspaceRoot")).unwrap_err().code, "nativeFailed");
    }

    #[test]
    fn inapp_forces_native_off_even_in_e2e() {
        let e = env(Jail::e2e("/"));
        assert!(e.state.picker.capabilities().native);
        let jail = Arc::new(Jail::e2e(e.root.join("fixture")));
        let policy = Policy::new(jail.clone(), e.root.clone(), e.root.join("state"));
        let st = state_with(policy, Arc::new(PathTokens::new()), Arc::new(FakeBackend::new(jail, None)), true);
        assert!(!st.picker.capabilities().native);
    }

    fn init_env(jail: Jail) -> (Env, String) {
        let e = env(jail);
        let dir = e.root.join("fixture/proj");
        std::fs::create_dir_all(&dir).unwrap();
        let token = e.state.picker.pick(&dir.to_string_lossy(), "workspaceRoot").unwrap().token;
        (e, token)
    }

    #[test]
    fn git_init_is_refused_in_read_only_mode_and_outside_the_fixture() {
        // Read-only: refused before anything exists.
        let e = env(Jail::read_only());
        let dir = e.root.join("proj");
        std::fs::create_dir_all(&dir).unwrap();
        let token = e.state.picker.pick(&dir.to_string_lossy(), "workspaceRoot").unwrap().token;
        let err = tauri::async_runtime::block_on(git_init_inner(&e.state.picker, token, "proj".into(), false)).unwrap_err();
        assert_eq!(err.code, "readOnly");
        assert!(!dir.join(".git").exists());
        // E2e: a folder outside the fixture cannot even be picked.
        let e = env(Jail::e2e("/"));
        let out = e.root.join("outside");
        std::fs::create_dir_all(&out).unwrap();
        assert_eq!(e.state.picker.pick(&out.to_string_lossy(), "workspaceRoot").unwrap_err().code, "testJail");
    }

    #[test]
    fn git_init_needs_the_typed_name_and_then_creates_a_repository_in_the_fixture() {
        std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
        std::env::set_var("GIT_CONFIG_SYSTEM", "/dev/null");
        let (e, token) = init_env(Jail::e2e("/"));
        let dir = e.root.join("fixture/proj");
        let err = tauri::async_runtime::block_on(git_init_inner(&e.state.picker, token.clone(), "nope".into(), false)).unwrap_err();
        assert_eq!(err.code, "pathInvalid");
        assert!(!dir.join(".git").exists(), "nothing is created before the confirmation matches");
        let picked = tauri::async_runtime::block_on(git_init_inner(&e.state.picker, token.clone(), "proj".into(), false)).unwrap();
        assert!(dir.join(".git/HEAD").is_file());
        assert_eq!(picked.kind, PathKind::Repo);
        assert_eq!(picked.branch.as_deref(), Some("main"));
        // The old token is spent; the new one is a different token for the same folder.
        assert_ne!(picked.token, token);
        let again = tauri::async_runtime::block_on(git_init_inner(&e.state.picker, token, "proj".into(), false)).unwrap_err();
        assert_eq!(again.code, "tokenUsed");
    }

    #[test]
    fn git_init_refuses_broad_folders() {
        let e = env(Jail::off());
        let home = e.root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let t = e.state.picker.pick(&home.to_string_lossy(), "workspaceRoot").unwrap().token;
        let err = tauri::async_runtime::block_on(git_init_inner(&e.state.picker, t, "home".into(), false)).unwrap_err();
        assert_eq!(err.code, "initTooBroad");
        assert!(!home.join(".git").exists());
    }

    #[test]
    fn the_privacy_url_is_a_fixed_system_settings_url() {
        assert!(PRIVACY_URL.starts_with("x-apple.systempreferences:"));
        assert!(!PRIVACY_URL.contains(' '));
    }
}
