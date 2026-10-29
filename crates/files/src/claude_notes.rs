//! What a Claude run is told from `CLAUDE.md` files: the same files, order, caps and refusals as the sidecar's
//! `sidecar/src/adapters/claude-sdk/project-notes.ts`, so the Project notes panel can show exactly what a run started now
//! would put into its system prompt. Read-only: nothing here writes, and `@imports` inside the files are not followed.
//!
//! The two implementations are kept in step by `the_constants_and_the_file_order_match_the_sidecar` below, which reads
//! the TypeScript source. Lengths are counted the way the sidecar counts them (UTF-16 code units of the decoded text).

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Per file of a run directory (bytes read from disk).
pub const PROJECT_FILE_MAX_BYTES: usize = 32 * 1024;
/// All files together, the global one included (UTF-16 code units, like `text.length` in the sidecar).
pub const PROJECT_TOTAL_MAX_BYTES: usize = 96 * 1024;
/// The user's own global `CLAUDE.md` (bytes read from disk).
pub const USER_MEMORY_MAX_BYTES: usize = 32 * 1024;
/// In the order the sidecar reads them for one directory.
pub const FILES: [&str; 3] = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFile {
    /// `user` (the global file of the Claude folder) or `project` (a file of a run directory).
    pub scope: String,
    /// Index into the run directories given; `None` for the user's file.
    pub dir_index: Option<usize>,
    /// `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md`.
    pub rel: String,
    /// The path the prompt names.
    pub path: String,
    /// Size on disk in bytes.
    pub size: u64,
    /// What the run is told from this file, as the sidecar would put it (before trimming).
    pub text: String,
    /// Length of `text` in the sidecar's units.
    pub length: usize,
    /// Cut by the per-file cap or by the total cap: the prompt says "(shortened)".
    pub shortened: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesPlan {
    pub files: Vec<NoteFile>,
    /// Sum of `length` over the files.
    pub total: usize,
    pub file_max: usize,
    pub total_max: usize,
    pub user_max: usize,
    /// Files that exist in a run directory but get no room because the total cap was reached first.
    pub left_out: Vec<String>,
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The longest prefix of `s` that is at most `units` UTF-16 code units (never splitting a character).
fn utf16_prefix(s: &str, units: usize) -> &str {
    let mut n = 0;
    for (i, c) in s.char_indices() {
        n += c.len_utf16();
        if n > units {
            return &s[..i];
        }
    }
    s
}

fn inside(root: &Path, p: &Path) -> bool {
    p.starts_with(root)
}

/// `readOne` of the sidecar: a file whose real path stays inside `root` (or no link at all with `no_link`), not empty,
/// at most `max` bytes read. Returns the text, whether it was cut and the size on disk.
fn read_one(root: &Path, rel: &str, max: usize, no_link: bool) -> Option<(String, bool, u64)> {
    let file = root.join(rel);
    if no_link && fs::symlink_metadata(&file).ok()?.file_type().is_symlink() {
        return None;
    }
    let real = fs::canonicalize(&file).ok()?;
    if !inside(root, &real) {
        return None;
    }
    let md = fs::metadata(&real).ok()?;
    if !md.is_file() || md.len() == 0 {
        return None;
    }
    let mut buf = Vec::with_capacity((md.len() as usize).min(max));
    fs::File::open(&real).ok()?.take(max as u64).read_to_end(&mut buf).ok()?;
    Some((String::from_utf8_lossy(&buf).into_owned(), md.len() as usize > max, md.len()))
}

/// The Claude config directory the way the CLI finds it: `CLAUDE_CONFIG_DIR`, else `<home>/.claude`.
pub fn claude_config_dir(config_dir: Option<&str>, home: Option<&Path>) -> Option<PathBuf> {
    match config_dir.map(str::trim).filter(|s| !s.is_empty()) {
        Some(d) => Some(PathBuf::from(d)),
        None => home.map(|h| h.join(".claude")),
    }
}

/// The files a run in `run_dirs` (the working directory first) is told about, with the user's global file first when
/// `user_dir` (the Claude config directory) is given.
pub fn plan(run_dirs: &[PathBuf], user_dir: Option<&Path>) -> NotesPlan {
    let mut files = Vec::new();
    let mut left_out = Vec::new();
    let mut total = 0usize;
    if let Some(dir) = user_dir.and_then(|d| fs::canonicalize(d).ok()) {
        if let Some((text, cut, size)) = read_one(&dir, "CLAUDE.md", USER_MEMORY_MAX_BYTES, true) {
            if !text.trim().is_empty() {
                let length = utf16_len(&text);
                total += length;
                files.push(NoteFile { scope: "user".into(), dir_index: None, rel: "CLAUDE.md".into(), path: dir.join("CLAUDE.md").to_string_lossy().into_owned(), size, text, length, shortened: cut });
            }
        }
    }
    let mut seen: Vec<PathBuf> = Vec::new();
    for (index, dir) in run_dirs.iter().enumerate() {
        let Ok(root) = fs::canonicalize(dir) else { continue };
        if seen.contains(&root) {
            continue;
        }
        seen.push(root.clone());
        for rel in FILES {
            let Some((text, cut, size)) = read_one(&root, rel, PROJECT_FILE_MAX_BYTES, false) else { continue };
            let path = root.join(rel).to_string_lossy().into_owned();
            if total >= PROJECT_TOTAL_MAX_BYTES {
                left_out.push(path);
                continue;
            }
            let room = PROJECT_TOTAL_MAX_BYTES - total;
            let kept = utf16_prefix(&text, room);
            let shortened = cut || kept.len() < text.len();
            let kept = kept.to_owned();
            let length = utf16_len(&kept);
            total += length;
            files.push(NoteFile { scope: "project".into(), dir_index: Some(index), rel: rel.into(), path, size, text: kept, length, shortened });
        }
    }
    NotesPlan { files, total, file_max: PROJECT_FILE_MAX_BYTES, total_max: PROJECT_TOTAL_MAX_BYTES, user_max: USER_MEMORY_MAX_BYTES, left_out }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, rel: &str, text: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    #[test]
    fn the_constants_and_the_file_order_match_the_sidecar() {
        let src = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sidecar/src/adapters/claude-sdk/project-notes.ts")).unwrap();
        assert!(src.contains("export const PROJECT_FILE_MAX_BYTES = 32 * 1024;"), "the per-file cap changed in the sidecar");
        assert!(src.contains("export const PROJECT_TOTAL_MAX_BYTES = 96 * 1024;"), "the total cap changed in the sidecar");
        assert!(src.contains("export const USER_MEMORY_MAX_BYTES = 32 * 1024;"), "the user cap changed in the sidecar");
        assert!(src.contains("const FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];"), "the file list or order changed in the sidecar");
        // the user's file goes first and counts against the total; a symlinked user file is refused
        assert!(src.contains("let total = user.bytes;"));
        assert!(src.contains("readOne(dir, 'CLAUDE.md', USER_MEMORY_MAX_BYTES, true)"));
        // the run directories are the working directory and then the added ones (the repositories in run order)
        let session = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sidecar/src/adapters/claude-sdk/session.ts")).unwrap();
        assert!(session.contains("projectInstructions([spec.cwd, ...spec.addDirs]"), "the sidecar now passes other directories");
    }

    #[test]
    fn files_come_in_the_sidecar_order_with_the_user_file_first_and_each_directory_once() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        write(a.path(), "CLAUDE.local.md", "local");
        write(a.path(), "CLAUDE.md", "root");
        write(a.path(), ".claude/CLAUDE.md", "dot");
        write(b.path(), "CLAUDE.md", "second");
        write(home.path(), "CLAUDE.md", "mine");
        write(a.path(), "empty/CLAUDE.md", "");
        let p = plan(&[a.path().into(), b.path().into(), a.path().into()], Some(home.path()));
        let got: Vec<(&str, &str)> = p.files.iter().map(|f| (f.scope.as_str(), f.text.as_str())).collect();
        assert_eq!(got, vec![("user", "mine"), ("project", "root"), ("project", "dot"), ("project", "local"), ("project", "second")]);
        assert_eq!(p.total, 4 + 4 + 3 + 5 + 6);
        assert_eq!(p.files[4].dir_index, Some(1));
    }

    #[test]
    fn a_link_out_of_the_directory_is_not_project_content_and_a_linked_user_file_is_refused() {
        let a = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        write(outside.path(), "CLAUDE.md", "elsewhere");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path().join("CLAUDE.md"), a.path().join("CLAUDE.md")).unwrap();
            std::os::unix::fs::symlink(outside.path().join("CLAUDE.md"), home.path().join("CLAUDE.md")).unwrap();
            // a link that stays inside the directory is read
            write(a.path(), "notes.md", "inside");
            std::os::unix::fs::symlink(a.path().join("notes.md"), a.path().join("CLAUDE.local.md")).unwrap();
            let p = plan(&[a.path().into()], Some(home.path()));
            assert_eq!(p.files.iter().map(|f| f.text.as_str()).collect::<Vec<_>>(), vec!["inside"]);
        }
    }

    #[test]
    fn the_caps_cut_a_file_and_leave_out_what_has_no_room() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let c = tempfile::tempdir().unwrap();
        let d = tempfile::tempdir().unwrap();
        write(a.path(), "CLAUDE.md", &"a".repeat(40 * 1024));
        write(b.path(), "CLAUDE.md", &"b".repeat(32 * 1024));
        write(c.path(), "CLAUDE.md", &"c".repeat(32 * 1024));
        write(d.path(), "CLAUDE.md", "d");
        let p = plan(&[a.path().into(), b.path().into(), c.path().into(), d.path().into()], None);
        assert_eq!(p.files.len(), 3);
        assert!(p.files[0].shortened && p.files[0].length == 32 * 1024 && p.files[0].size == 40 * 1024);
        assert!(!p.files[1].shortened);
        assert!(!p.files[2].shortened);
        assert_eq!(p.total, 96 * 1024);
        assert_eq!(p.left_out.len(), 1);
    }

    #[test]
    fn the_total_cut_counts_utf16_units_and_never_splits_a_character() {
        assert_eq!(utf16_prefix("aé😀b", 3), "aé");
        assert_eq!(utf16_prefix("aé😀b", 4), "aé😀");
        assert_eq!(utf16_len("😀"), 2);
    }

    #[test]
    fn the_config_dir_follows_the_cli() {
        assert_eq!(claude_config_dir(Some(" /x/y "), Some(Path::new("/h"))), Some(PathBuf::from("/x/y")));
        assert_eq!(claude_config_dir(Some(""), Some(Path::new("/h"))), Some(PathBuf::from("/h/.claude")));
        assert_eq!(claude_config_dir(None, None), None);
    }
}
