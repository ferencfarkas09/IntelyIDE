//! The Tauri-free logic of every `picker_*` command ((design notes: workspaces-spec) 5.3 to 5.7, 3.12, 3.6.5).
//!
//! `src-tauri/src/modules/picker.rs` is a thin shell around [`Picker`]: it adds the `rfd` backend, event emission, the
//! window drag-drop hook and the async `git init` call. Everything testable lives here, behind fakes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use intely_core::jail::Mode;
use intely_core::EngineError;
use unicode_normalization::UnicodeNormalization;

use crate::backend::{sanitize_title, NativeAnswer, NativeRequest, PickBackend};
use crate::scan::{check_root, run_scan, InstantClock, ScanConfig};
use crate::tokens::{Clock, PathTokens, SystemClock};
use crate::types::*;
use crate::validate::{err, Purpose, Validator};

pub const DROP_INBOX_MAX: usize = 64;
pub const DROP_TTL_MS: u64 = 30_000;
const MAX_SCANS: usize = 4;
pub const INIT_LARGE_ENTRIES: usize = 5000;

pub struct ScanJob {
    cancel: AtomicBool,
    progress: Mutex<ScanProgress>,
    results: Mutex<Vec<Picked>>,
}

pub struct Picker {
    pub validator: Validator,
    pub tokens: Arc<PathTokens>,
    backend: Arc<dyn PickBackend>,
    inapp_forced: bool,
    native_busy: AtomicBool,
    last_dir: Mutex<Option<PathBuf>>,
    listening: AtomicBool,
    inbox: Mutex<Vec<(u64, Picked)>>,
    clock: Arc<dyn Clock>,
    scans: Mutex<HashMap<String, Arc<ScanJob>>>,
}

struct BusyGuard<'a>(&'a AtomicBool);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Picker {
    pub fn new(validator: Validator, tokens: Arc<PathTokens>, backend: Arc<dyn PickBackend>) -> Self {
        Self {
            validator,
            tokens,
            backend,
            inapp_forced: false,
            native_busy: AtomicBool::new(false),
            last_dir: Mutex::new(None),
            listening: AtomicBool::new(false),
            inbox: Mutex::new(Vec::new()),
            clock: Arc::new(SystemClock),
            scans: Mutex::new(HashMap::new()),
        }
    }

    /// `INTELY_PICKER=inapp`: native is reported unavailable.
    pub fn force_inapp(mut self, on: bool) -> Self {
        self.inapp_forced = on;
        self
    }

    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    fn mode(&self) -> Mode {
        self.validator.policy.mode()
    }

    pub fn capabilities(&self) -> Capabilities {
        let mode = match self.mode() {
            Mode::Off => PickerMode::Off,
            Mode::ReadOnly => PickerMode::ReadOnly,
            Mode::E2e => PickerMode::E2e,
        };
        Capabilities { native: !self.inapp_forced && self.backend.available(), fake: self.mode() == Mode::E2e, mode }
    }

    pub fn start(&self) -> StartInfo {
        let last = self.last_dir.lock().unwrap().clone();
        self.validator.start_info(last.as_deref())
    }

    pub fn list(&self, path: &str, opts: &ListOpts) -> Result<DirListing, EngineError> {
        self.validator.list(path, opts)
    }

    pub fn pick(&self, path: &str, purpose: &str) -> Result<Picked, EngineError> {
        let purpose = Purpose::parse(purpose)?;
        let v = self.validator.validate(path, &purpose)?;
        self.remember(&v.path, purpose.is_file());
        Ok(self.tokens.issue(v, &purpose))
    }

    fn remember(&self, path: &Path, is_file: bool) {
        let dir = if is_file { path.parent().map(Path::to_path_buf) } else { Some(path.to_path_buf()) };
        *self.last_dir.lock().unwrap() = dir;
    }

    /// `picker_native`: blocking. `None` is a cancel. Every answer goes through the full validation and the jail.
    pub fn native(&self, o: &NativeOptions) -> Result<Option<Vec<Picked>>, EngineError> {
        let purpose = Purpose::parse(&o.purpose)?;
        let files = matches!(o.kind, NativeKind::File | NativeKind::Files);
        if files != purpose.is_file() {
            return Err(err(codes::PATH_INVALID, "the purpose does not match the kind of dialog"));
        }
        if !self.capabilities().native {
            return Err(err(codes::NATIVE_FAILED, "no native picker is available"));
        }
        if self.native_busy.swap(true, Ordering::SeqCst) {
            return Err(err(codes::BUSY, "a folder dialog is already open"));
        }
        let _busy = BusyGuard(&self.native_busy);
        let start = o
            .start_token
            .as_deref()
            .and_then(|t| self.tokens.peek(t))
            .map(|(v, _)| if matches!(v.kind, PathKind::File) { v.path.parent().map(Path::to_path_buf).unwrap_or(v.path) } else { v.path })
            .or_else(|| self.last_dir.lock().unwrap().clone());
        let req = NativeRequest {
            kind: o.kind.clone(),
            title: sanitize_title(o.title.as_deref().unwrap_or("")),
            start,
            extensions: o
                .extensions
                .clone()
                .unwrap_or_default()
                .into_iter()
                .map(|e| e.trim_start_matches('.').to_owned())
                .filter(|e| !e.is_empty() && e.len() <= 16 && e.chars().all(|c| c.is_ascii_alphanumeric()))
                .collect(),
            can_create: !files,
        };
        let paths = match self.backend.pick(&req)? {
            NativeAnswer::Cancelled => return Ok(None),
            NativeAnswer::Paths(p) if p.is_empty() => return Ok(None),
            NativeAnswer::Paths(p) => p,
        };
        let multi = matches!(o.kind, NativeKind::Folders | NativeKind::Files);
        let mut out = Vec::new();
        for p in paths.into_iter().take(if multi { 200 } else { 1 }) {
            let v = self.validator.validate(&p.to_string_lossy(), &purpose)?;
            self.remember(&v.path, purpose.is_file());
            out.push(self.tokens.issue(v, &purpose));
        }
        Ok(Some(out))
    }

    // -- drag and drop -------------------------------------------------------------------------------------------

    pub fn drop_listen(&self, on: bool) {
        self.listening.store(on, Ordering::SeqCst);
        if !on {
            self.inbox.lock().unwrap().clear();
        }
    }

    pub fn is_listening(&self) -> bool {
        self.listening.load(Ordering::SeqCst)
    }

    /// A window drop. Ignored unless a screen declared itself a drop target; otherwise validates each path and stores
    /// the result in the bounded inbox. Returns how many items the inbox holds afterwards (0 when ignored).
    pub fn on_drop(&self, paths: &[PathBuf]) -> usize {
        if !self.is_listening() {
            return 0;
        }
        let now = self.clock.now_ms();
        let mut fresh: Vec<Picked> = Vec::new();
        for p in paths.iter().take(DROP_INBOX_MAX) {
            if let Ok(picked) = self.validate_dropped(p) {
                fresh.push(picked);
            }
        }
        let mut inbox = self.inbox.lock().unwrap();
        inbox.retain(|(at, _)| now.saturating_sub(*at) <= DROP_TTL_MS);
        for f in fresh {
            if inbox.len() >= DROP_INBOX_MAX {
                break;
            }
            inbox.push((now, f));
        }
        inbox.len()
    }

    fn validate_dropped(&self, p: &Path) -> Result<Picked, EngineError> {
        let text = p.to_string_lossy();
        let lower = text.to_lowercase();
        let unusable = [".app", ".dmg", ".iso", ".pkg", ".sparseimage", ".sparsebundle"].iter().any(|e| lower.ends_with(e));
        let is_dir = std::fs::symlink_metadata(p).map(|m| m.is_dir()).unwrap_or(false)
            || std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false);
        if unusable || !is_dir {
            // Reported as a `file` so the UI can say "Drop a folder, not a file." (its parent is never opened).
            let (purpose, kind_override) = if is_dir { (Purpose::ScanRoot, true) } else { (Purpose::File("drop".into()), false) };
            let mut v = self.validator.validate(&text, &purpose)?;
            if kind_override {
                v.kind = PathKind::File;
            }
            return Ok(self.tokens.issue(v, &purpose));
        }
        let purpose = Purpose::WorkspaceRoot;
        let v = self.validator.validate(&text, &purpose)?;
        Ok(self.tokens.issue(v, &purpose))
    }

    /// `picker_take_drop`: the validated items and an empty inbox. Items past the TTL are dropped.
    pub fn take_drop(&self) -> Vec<Picked> {
        let now = self.clock.now_ms();
        let mut inbox = self.inbox.lock().unwrap();
        let out = inbox.drain(..).filter(|(at, _)| now.saturating_sub(*at) <= DROP_TTL_MS).map(|(_, p)| p).collect();
        out
    }

    // -- scan ----------------------------------------------------------------------------------------------------

    /// Starts a scan on its own thread; `emit` receives progress (the caller throttles and forwards it as `picker:scan`).
    pub fn scan_start(
        self: &Arc<Self>,
        root: &str,
        opts: &ScanOpts,
        emit: Arc<dyn Fn(&ScanProgress) + Send + Sync>,
    ) -> Result<ScanStarted, EngineError> {
        let v = self.validator.validate(root, &Purpose::ScanRoot)?;
        check_root(&v.path)?;
        let scan_id = uuid::Uuid::new_v4().simple().to_string();
        let job = Arc::new(ScanJob {
            cancel: AtomicBool::new(false),
            progress: Mutex::new(ScanProgress {
                scan_id: scan_id.clone(),
                visited: 0,
                found: 0,
                done: false,
                cancelled: false,
                truncated: false,
                reason: None,
                skipped_protected: Vec::new(),
                skipped_symlinks: 0,
            }),
            results: Mutex::new(Vec::new()),
        });
        {
            let mut scans = self.scans.lock().unwrap();
            scans.retain(|_, j| !j.progress.lock().unwrap().done);
            if scans.len() >= MAX_SCANS {
                return Err(err(codes::BUSY, "too many scans are running"));
            }
            scans.insert(scan_id.clone(), job.clone());
        }
        let me = self.clone();
        let cfg = ScanConfig::from_opts(opts);
        let root_path = v.path.clone();
        let id = scan_id.clone();
        std::thread::Builder::new()
            .name("pathpick-scan".into())
            .spawn(move || {
                let clock = InstantClock::start();
                let j = job.clone();
                let mut on_found = |p: Picked| j.results.lock().unwrap().push(p);
                let j2 = job.clone();
                let mut on_progress = |p: &ScanProgress| {
                    *j2.progress.lock().unwrap() = p.clone();
                    emit(p);
                };
                run_scan(&me.validator, &me.tokens, &id, &root_path, &cfg, &clock, &job.cancel, &mut on_found, &mut on_progress);
            })
            .map_err(|_| err(codes::IO, "could not start the scan"))?;
        Ok(ScanStarted { scan_id })
    }

    pub fn scan_results(&self, scan_id: &str, after: Option<u32>) -> Result<ScanResults, EngineError> {
        let job = self.scans.lock().unwrap().get(scan_id).cloned().ok_or_else(|| err(codes::NOT_FOUND, "unknown scan"))?;
        let all = job.results.lock().unwrap();
        let from = (after.unwrap_or(0) as usize).min(all.len());
        let progress = Some(job.progress.lock().unwrap().clone());
        Ok(ScanResults { repos: all[from..].to_vec(), next: all.len() as u32, progress })
    }

    pub fn scan_progress(&self, scan_id: &str) -> Option<ScanProgress> {
        self.scans.lock().unwrap().get(scan_id).map(|j| j.progress.lock().unwrap().clone())
    }

    pub fn scan_cancel(&self, scan_id: &str) {
        if let Some(j) = self.scans.lock().unwrap().get(scan_id) {
            j.cancel.store(true, Ordering::SeqCst);
        }
    }

    // -- git init ------------------------------------------------------------------------------------------------

    /// Every refusal of `picker_git_init` that does not need git, in the order the user would hit them. The token is
    /// consumed only when all of them pass, so a refusal leaves the dialog usable. Returns the canonical path to
    /// initialise (never the typed string).
    pub fn init_prepare(&self, token: &str, confirm: &str, confirm_large: bool) -> Result<PathBuf, EngineError> {
        if self.mode() == Mode::ReadOnly {
            return Err(err(codes::READ_ONLY, "read-only mode: nothing can be created"));
        }
        let Some((v, _purpose)) = self.tokens.peek(token) else {
            // Unknown, spent or expired: redeem answers with the precise code.
            let purposes = [Purpose::WorkspaceRoot, Purpose::WorkspaceRepo];
            return Err(self.tokens.redeem(token, &purposes, &self.validator).err().unwrap_or_else(|| err(codes::TOKEN_EXPIRED, "that choice expired")));
        };
        if v.kind != PathKind::NotGit {
            return Err(err(codes::PATH_INVALID, "only a folder that is not a Git repository can be initialised"));
        }
        self.validator.policy.check_read(&v.path)?;
        if self.init_too_broad(&v.path) {
            return Err(err(codes::INIT_TOO_BROAD, "git cannot be initialised in this folder"));
        }
        if !confirm_large && count_entries(&v.path, INIT_LARGE_ENTRIES + 1) > INIT_LARGE_ENTRIES {
            return Err(err(codes::INIT_TOO_BROAD, "the folder has more than 5000 entries").with_detail("large"));
        }
        let want: String = v.name.nfc().collect();
        let got: String = confirm.trim().nfc().collect();
        if want != got {
            return Err(err(codes::PATH_INVALID, "the typed name does not match the folder name").with_detail("confirm"));
        }
        self.validator.policy.jail.check_op("git init", &v.path)?;
        let redeemed = self.tokens.redeem(token, &[Purpose::WorkspaceRoot, Purpose::WorkspaceRepo], &self.validator)?;
        Ok(redeemed.validated.path)
    }

    /// After a successful `git init`: the folder is validated again and continues as a repository.
    pub fn init_finish(&self, path: &Path) -> Result<Picked, EngineError> {
        self.pick(&path.to_string_lossy(), "workspaceRoot")
    }

    pub fn init_too_broad(&self, path: &Path) -> bool {
        let home = &self.validator.policy.home;
        if self.validator.too_broad(path) {
            return true;
        }
        const EXACT: [&str; 9] = ["/", "/Users", "/Applications", "/System", "/Library", "/private", "/var", "/etc", "/tmp"];
        if EXACT.iter().any(|e| path == Path::new(e)) || ["/opt", "/cores", "/usr", "/bin", "/sbin"].iter().any(|e| path.starts_with(e)) {
            return true;
        }
        if ["/System", "/Library", "/Applications"].iter().any(|e| path.starts_with(e)) {
            return true;
        }
        ["Desktop", "Documents", "Downloads"].iter().any(|d| path == home.join(d))
    }
}

fn count_entries(dir: &Path, cap: usize) -> usize {
    std::fs::read_dir(dir).map(|rd| rd.take(cap).count()).unwrap_or(0)
}
