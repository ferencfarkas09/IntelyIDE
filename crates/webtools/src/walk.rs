//! Lists the files of a repository for the static analysis. Bounded in folders, files, depth and file size; never follows a
//! symbolic link; skips dependency, build and hidden folders (a repository is hostile input: `node_modules` holds other people's
//! code, a link can lead anywhere, and a generated tree can hold millions of files).

use std::path::Path;
use std::time::UNIX_EPOCH;

/// Folders that never hold the project's own sources (dependencies, build output, caches). Hidden folders are skipped too.
pub(crate) const SKIP_DIRS: &[&str] = &[
    "node_modules", "dist", "build", "out", "coverage", "Pods", "Carthage", "DerivedData", "vendor", "target", "storybook-static", "web-build", "__pycache__", "venv",
    "bower_components", "jspm_packages",
];
pub(crate) const MAX_DIRS: usize = 6000;
pub(crate) const MAX_FILES: usize = 40_000;
pub(crate) const MAX_DEPTH: usize = 14;
/// A single folder is read only up to this many entries (a hostile folder can hold millions).
pub(crate) const MAX_ENTRIES: usize = 20_000;

pub(crate) struct Entry {
    /// Relative to the repository, `/`-separated.
    pub rel: String,
    pub size: u64,
    /// Lowercase extension without the dot ("" for none).
    pub ext: String,
    pub mtime: u64,
}

#[derive(Default)]
pub(crate) struct Walk {
    pub files: Vec<Entry>,
    pub notes: Vec<String>,
}

pub(crate) fn walk(root: &Path) -> Walk {
    walk_in(root, "", SKIP_DIRS, true)
}

/// Walks `start` (a repo-relative folder, "" for the root). `skip_hidden`: hidden folders are not entered (hidden files always are listed, `.env` is one).
pub(crate) fn walk_in(root: &Path, start: &str, skip: &[&str], skip_hidden: bool) -> Walk {
    let mut out = Walk::default();
    let mut visited = 0usize;
    let mut stack = vec![(root.join(start), start.to_string(), 0usize)];
    while let Some((dir, rel, depth)) = stack.pop() {
        visited += 1;
        if visited > MAX_DIRS {
            out.notes.push(format!("stopped after {MAX_DIRS} folders"));
            break;
        }
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = read.flatten().take(MAX_ENTRIES + 1).collect();
        if entries.len() > MAX_ENTRIES {
            entries.truncate(MAX_ENTRIES);
            let note = format!("{} has more than {MAX_ENTRIES} entries: only some are read", if rel.is_empty() { "the repository root" } else { rel.as_str() });
            if out.notes.len() < 20 {
                out.notes.push(note);
            }
        }
        // a fixed order: the caps below must cut the same files on every run
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if ft.is_dir() {
                if depth < MAX_DEPTH && !(skip_hidden && name.starts_with('.')) && !skip.contains(&name.as_str()) {
                    stack.push((entry.path(), child, depth + 1));
                }
            } else if ft.is_file() {
                if out.files.len() >= MAX_FILES {
                    if !out.notes.iter().any(|n| n.starts_with("stopped after") && n.contains("files")) {
                        out.notes.push(format!("stopped after {MAX_FILES} files"));
                    }
                    return out;
                }
                let meta = entry.metadata().ok();
                let ext = name.rsplit_once('.').filter(|(stem, _)| !stem.is_empty()).map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
                out.files.push(Entry {
                    rel: child,
                    size: meta.as_ref().map_or(0, |m| m.len()),
                    ext,
                    mtime: meta.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs()),
                });
            }
        }
    }
    out.files.sort_by(|a, b| a.rel.cmp(&b.rel));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn touch(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn lists_sources_and_skips_dependencies_build_output_and_hidden_folders() {
        let d = tempfile::tempdir().unwrap();
        for f in ["src/a.tsx", "src/b.scss", "node_modules/x/i.js", "dist/o.js", "build/o.js", ".git/config", ".next/x.js", ".env", "src/.hidden/z.css"] {
            touch(d.path(), f, "x");
        }
        let w = walk(d.path());
        let rels: Vec<&str> = w.files.iter().map(|e| e.rel.as_str()).collect();
        assert_eq!(rels, vec![".env", "src/a.tsx", "src/b.scss"]);
        assert_eq!(w.files[1].ext, "tsx");
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_to_files_and_folders_are_not_followed_even_in_a_loop() {
        let d = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        touch(outside.path(), "secret.css", "x");
        touch(d.path(), "src/a.css", "x");
        std::os::unix::fs::symlink(outside.path(), d.path().join("linked")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.css"), d.path().join("src/s.css")).unwrap();
        std::os::unix::fs::symlink(d.path(), d.path().join("src/loop")).unwrap();
        let w = walk(d.path());
        let rels: Vec<&str> = w.files.iter().map(|e| e.rel.as_str()).collect();
        assert_eq!(rels, vec!["src/a.css"]);
    }

    #[test]
    fn a_very_deep_tree_stops_at_the_depth_cap() {
        let d = tempfile::tempdir().unwrap();
        let deep = (0..MAX_DEPTH + 4).map(|i| format!("d{i}")).collect::<Vec<_>>().join("/");
        touch(d.path(), &format!("{deep}/a.css"), "x");
        touch(d.path(), "ok.css", "x");
        assert_eq!(walk(d.path()).files.len(), 1);
    }

    #[test]
    fn one_enormous_folder_is_read_only_up_to_a_cap() {
        let d = tempfile::tempdir().unwrap();
        for i in 0..MAX_ENTRIES + 500 {
            std::fs::write(d.path().join(format!("f{i}.css")), "").unwrap();
        }
        let w = walk(d.path());
        assert_eq!(w.files.len(), MAX_ENTRIES);
        assert!(w.notes.iter().any(|n| n.contains("more than")), "{:?}", w.notes);
    }
}
