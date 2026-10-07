//! Read-only directory listing for the in-app browser ((design notes: workspaces-spec) 5.4) and the start-up places.
//! `read_dir` + `lstat` only; never file contents. Children of guarded folders are never probed for `.git`.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use intely_core::jail::Mode;
use intely_core::EngineError;
use unicode_normalization::UnicodeNormalization;

use crate::fsops::{mount_key, StatInfo};
use crate::protected::classify;
use crate::types::{codes, DirEntry, DirListing, EntryKind, ListOpts, Place, StartInfo, Volume};
use crate::validate::{err, hygiene, io_error, Validator};

pub const MAX_ENTRIES: usize = 2000;
pub const READ_CAP: usize = 20_000;
pub const GIT_PROBES: usize = 400;
pub const WALK_BUDGET: Duration = Duration::from_secs(3);
const UF_HIDDEN: u32 = 0x8000;

impl Validator {
    /// `picker_list`: hygiene, resolve, jail, directory check, then the guarded walk.
    pub fn list(&self, raw: &str, opts: &ListOpts) -> Result<DirListing, EngineError> {
        let path = hygiene(raw, &self.policy.home)?;
        let me = self.clone();
        let opts = opts.clone();
        let mount = mount_key(&path);
        self.guard.run(&mount, self.deadline, move || me.list_path(&path, &opts))?
    }

    pub fn list_path(&self, path: &Path, opts: &ListOpts) -> Result<DirListing, EngineError> {
        let home = &self.policy.home;
        let canonical = self.fs.canonicalize(path).map_err(|e| io_error(&e, path, home))?;
        self.policy.check_read(&canonical)?;
        let stat = self.fs.stat(&canonical).map_err(|e| io_error(&e, &canonical, home))?;
        if !stat.is_dir {
            return Err(err(codes::NOT_A_DIRECTORY, "not a directory"));
        }
        let started = Instant::now();
        let raw = self.fs.read_dir(&canonical, READ_CAP).map_err(|e| io_error(&e, &canonical, home))?;
        let guarded_parent = classify(&canonical, home).is_some();
        let want_ext: Option<Vec<String>> =
            opts.extensions.as_ref().map(|v| v.iter().map(|e| e.trim_start_matches('.').to_ascii_lowercase()).collect());
        let mut entries: Vec<DirEntry> = Vec::new();
        let mut seen = 0u32;
        for (name, stat) in raw.entries {
            seen += 1;
            let hidden = name.starts_with('.') || stat.is_some_and(|s| s.flags & UF_HIDDEN != 0);
            if hidden && !opts.hidden {
                continue;
            }
            let (kind, size) = self.entry_kind(&canonical, &name, stat.as_ref());
            let is_file_kind = matches!(kind, EntryKind::File | EntryKind::SymlinkFile);
            if is_file_kind {
                if !opts.files {
                    continue;
                }
                if let Some(exts) = &want_ext {
                    let ext = Path::new(&name).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
                    if !exts.is_empty() && !ext.is_some_and(|e| exts.contains(&e)) {
                        continue;
                    }
                }
            }
            let child_path = canonical.join(&name);
            entries.push(DirEntry {
                label: name.nfc().collect(),
                package: matches!(kind, EntryKind::Dir) && name.ends_with(".app"),
                protected_folder: classify(&child_path, home),
                name,
                kind,
                hidden,
                is_repo: None,
                size: if is_file_kind { size.map(|s| s as f64) } else { None },
            });
        }
        entries.sort_by(|a, b| {
            let rank = |e: &DirEntry| u8::from(matches!(e.kind, EntryKind::File | EntryKind::SymlinkFile | EntryKind::Other));
            rank(a)
                .cmp(&rank(b))
                .then_with(|| a.label.to_lowercase().cmp(&b.label.to_lowercase()))
                .then_with(|| a.label.cmp(&b.label))
        });
        let truncated = entries.len() > MAX_ENTRIES || raw.hit_limit;
        entries.truncate(MAX_ENTRIES);
        if !guarded_parent {
            let mut probes = 0;
            for e in entries.iter_mut() {
                if probes >= GIT_PROBES || started.elapsed() > WALK_BUDGET {
                    break;
                }
                if matches!(e.kind, EntryKind::Dir) && e.protected_folder.is_none() {
                    probes += 1;
                    e.is_repo = Some(self.fs.symlink_stat(&canonical.join(&e.name).join(".git")).is_ok());
                }
            }
        }
        let parent = canonical.parent().filter(|p| self.policy.check_read(p).is_ok()).map(|p| p.to_string_lossy().into_owned());
        Ok(DirListing {
            path: canonical.to_string_lossy().into_owned(),
            parent,
            entries,
            truncated,
            total_seen: seen,
            skipped_unreadable: raw.skipped_unreadable,
            protected_folder: classify(&canonical, home),
        })
    }

    /// Kind of one entry. A symlink is judged by its target; in e2e mode a target outside the fixture is `other`
    /// (never followed out of the jail).
    fn entry_kind(&self, dir: &Path, name: &str, lstat: Option<&StatInfo>) -> (EntryKind, Option<u64>) {
        let Some(l) = lstat else { return (EntryKind::Other, None) };
        if !l.is_symlink {
            return if l.is_dir {
                (EntryKind::Dir, None)
            } else if l.is_file {
                (EntryKind::File, Some(l.size))
            } else {
                (EntryKind::Other, None)
            };
        }
        let child = dir.join(name);
        if self.policy.mode() == Mode::E2e {
            match self.fs.canonicalize(&child) {
                Ok(target) if self.policy.check_read(&target).is_ok() => {}
                _ => return (EntryKind::Other, None),
            }
        }
        match self.fs.stat(&child) {
            Ok(t) if t.is_dir => (EntryKind::SymlinkDir, None),
            Ok(t) if t.is_file => (EntryKind::SymlinkFile, Some(t.size)),
            _ => (EntryKind::Other, None),
        }
    }

    /// `picker_start`: home, the start folder, places that exist and mounted volumes (names only, nothing inside touched).
    pub fn start_info(&self, last_dir: Option<&Path>) -> StartInfo {
        let root = self.policy.start_root();
        let home = &self.policy.home;
        let e2e = self.policy.mode() == Mode::E2e;
        let start = last_dir
            .filter(|p| self.policy.check_read(p).is_ok() && p.is_dir())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| root.clone());
        let mut places = vec![Place { id: "home".into(), label: "Home".into(), path: s(&root), exists: true }];
        if !e2e {
            for (id, label) in [("desktop", "Desktop"), ("documents", "Documents"), ("downloads", "Downloads")] {
                let p: PathBuf = home.join(label);
                if p.is_dir() {
                    places.push(Place { id: id.into(), label: label.into(), path: s(&p), exists: true });
                }
            }
        }
        let volumes = if e2e {
            Vec::new()
        } else {
            std::fs::read_dir("/Volumes")
                .map(|rd| {
                    let mut v: Vec<Volume> = rd
                        .flatten()
                        .filter_map(|e| {
                            let name = e.file_name().into_string().ok()?;
                            Some(Volume { path: format!("/Volumes/{name}"), name })
                        })
                        .collect();
                    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                    v
                })
                .unwrap_or_default()
        };
        StartInfo { home: s(&root), start_path: s(&start), places, volumes }
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}
