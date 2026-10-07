//! Bounded, cancellable scan for Git repositories below a folder ((design notes: workspaces-spec) 5.7).
//!
//! Skips dot-directories, build and cache folders, symlinks (counted, never followed) and other filesystems; never
//! descends into a found repository; checks the jail for every candidate; stops at the depth, directory, repository and
//! time limits and says which one it hit.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use intely_core::EngineError;

use crate::fsops::StatInfo;
use crate::protected::classify;
use crate::tokens::PathTokens;
use crate::types::{codes, Picked, ScanOpts, ScanProgress, ScanReason};
use crate::validate::{err, Purpose, Validator};

pub const DEFAULT_DEPTH: u32 = 3;
pub const MAX_DEPTH: u32 = 5;
pub const MAX_REPOS: u32 = 200;
pub const MAX_DIRS: u32 = 20_000;
pub const TIME_LIMIT: Duration = Duration::from_secs(15);

const SKIP: [&str; 15] = [
    "node_modules", ".git", "target", "dist", "build", "out", ".venv", "venv", "__pycache__", "Pods", "DerivedData", ".Trash",
    "Library", ".cache", ".gradle",
];

pub trait ScanClock: Send + Sync {
    fn elapsed(&self) -> Duration;
}

pub struct InstantClock(Instant);

impl InstantClock {
    pub fn start() -> Self {
        Self(Instant::now())
    }
}

impl ScanClock for InstantClock {
    fn elapsed(&self) -> Duration {
        self.0.elapsed()
    }
}

/// A clock a test moves by hand.
#[derive(Default)]
pub struct FakeScanClock(AtomicU64);

impl FakeScanClock {
    pub fn advance(&self, d: Duration) {
        self.0.fetch_add(d.as_millis() as u64, Ordering::SeqCst);
    }
}

impl ScanClock for FakeScanClock {
    fn elapsed(&self) -> Duration {
        Duration::from_millis(self.0.load(Ordering::SeqCst))
    }
}

#[derive(Debug, Clone)]
pub struct ScanConfig {
    pub depth: u32,
    pub max_repos: u32,
    pub max_dirs: u32,
    pub include_hidden: bool,
    pub time_limit: Duration,
}

impl ScanConfig {
    pub fn from_opts(o: &ScanOpts) -> Self {
        Self {
            depth: o.depth.unwrap_or(DEFAULT_DEPTH).clamp(1, MAX_DEPTH),
            max_repos: o.max_repos.unwrap_or(MAX_REPOS).clamp(1, MAX_REPOS),
            max_dirs: MAX_DIRS,
            include_hidden: o.include_hidden,
            time_limit: TIME_LIMIT,
        }
    }
}

impl Default for ScanConfig {
    fn default() -> Self {
        Self::from_opts(&ScanOpts { depth: None, max_repos: None, include_hidden: false })
    }
}

/// Refuses roots a scan can never make sense of (`/`).
pub fn check_root(root: &Path) -> Result<(), EngineError> {
    if root == Path::new("/") {
        return Err(err(codes::SCAN_TOO_BROAD, "choose a more specific folder to scan"));
    }
    Ok(())
}

/// Runs the scan on the calling thread. `root` must be a canonical directory the caller validated.
/// `on_found` gets each repository (already validated, with its token); `on_progress` is called after every directory.
pub fn run_scan(
    v: &Validator,
    tokens: &PathTokens,
    scan_id: &str,
    root: &Path,
    cfg: &ScanConfig,
    clock: &dyn ScanClock,
    cancel: &AtomicBool,
    on_found: &mut dyn FnMut(Picked),
    on_progress: &mut dyn FnMut(&ScanProgress),
) -> ScanProgress {
    let home = v.policy.home.clone();
    let mut p = ScanProgress {
        scan_id: scan_id.to_owned(),
        visited: 0,
        found: 0,
        done: false,
        cancelled: false,
        truncated: false,
        reason: None,
        skipped_protected: Vec::new(),
        skipped_symlinks: 0,
    };
    let root_dev = v.fs.stat(root).map(|s| s.dev).unwrap_or(0);
    let wide_root = root == home || root == Path::new("/Users") || root == Path::new("/Volumes");
    let cross_ok = root == Path::new("/Volumes");
    let purpose = Purpose::WorkspaceRepo;

    // The root itself may be a repository.
    if v.fs.symlink_stat(&root.join(".git")).is_ok() {
        if let Ok(val) = v.validate_path(root, &purpose) {
            on_found(tokens.issue(val, &purpose));
            p.found = 1;
        }
        p.done = true;
        on_progress(&p);
        return p;
    }

    let mut stack: Vec<(PathBuf, u32)> = vec![(root.to_path_buf(), 0)];
    'walk: while let Some((dir, depth)) = stack.pop() {
        if cancel.load(Ordering::SeqCst) {
            p.cancelled = true;
            break;
        }
        if clock.elapsed() >= cfg.time_limit {
            p.truncated = true;
            p.reason = Some(ScanReason::Time);
            break;
        }
        if p.visited >= cfg.max_dirs {
            p.truncated = true;
            p.reason = Some(ScanReason::Dirs);
            break;
        }
        p.visited += 1;
        let Ok(raw) = v.fs.read_dir(&dir, 20_000) else {
            on_progress(&p);
            continue;
        };
        let mut names: Vec<(String, Option<StatInfo>)> = raw.entries;
        names.sort_by(|a, b| a.0.cmp(&b.0));
        let mut children: Vec<PathBuf> = Vec::new();
        for (name, stat) in names {
            let Some(stat) = stat else { continue };
            if stat.is_symlink {
                p.skipped_symlinks += 1;
                continue;
            }
            if !stat.is_dir {
                continue;
            }
            if SKIP.contains(&name.as_str()) && !(name == "Library" && dir != home) {
                continue;
            }
            if name.starts_with('.') && !cfg.include_hidden {
                continue;
            }
            if !cross_ok && stat.dev != root_dev {
                continue;
            }
            let child = dir.join(&name);
            if wide_root && dir == root && classify(&child, &home).is_some() {
                p.skipped_protected.push(name);
                continue;
            }
            if v.policy.check_read(&child).is_err() {
                continue;
            }
            if v.fs.symlink_stat(&child.join(".git")).is_ok() {
                // A repository: validate it fully, never descend into it.
                if let Ok(val) = v.validate_path(&child, &purpose) {
                    on_found(tokens.issue(val, &purpose));
                    p.found += 1;
                    if p.found >= cfg.max_repos {
                        p.truncated = true;
                        p.reason = Some(ScanReason::Repos);
                        on_progress(&p);
                        break 'walk;
                    }
                }
                continue;
            }
            children.push(child);
        }
        if depth + 1 >= cfg.depth {
            if !children.is_empty() {
                p.truncated = true;
                p.reason.get_or_insert(ScanReason::Depth);
            }
        } else {
            // Reverse so the stack pops in name order.
            for c in children.into_iter().rev() {
                stack.push((c, depth + 1));
            }
        }
        on_progress(&p);
    }
    p.done = true;
    on_progress(&p);
    p
}
