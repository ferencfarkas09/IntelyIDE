//! File contents and hunks for the diff view.

use std::io::Read;
use std::path::{Path, PathBuf};

use crate::exec::{clean_rel_path, resolve_in_repo, run_git, run_git_full, GitCtx, RunOpts};
use crate::git::common::rev_parse;
use crate::guard;
use crate::parse::diff::parse_unified_diff;
use crate::parse::nfc_path;
use crate::{code, DiffSource, EngineError, FileContents, GuardState, Hunk, HunkLineKind, RepoConfig};

/// Each side of a file larger than this is not loaded (`tooLarge`).
pub const MAX_DIFF_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Git treats a file as binary when there is a NUL in the first 8000 bytes; so do we.
const BINARY_SNIFF_BYTES: usize = 8000;
const MAX_DIFF_TEXT_BYTES: usize = 8 * 1024 * 1024;

/// One side of the comparison.
#[derive(Debug, PartialEq)]
enum Side {
    /// Absent (new file on the original side, deleted file on the modified side) or not a blob (submodule).
    Empty,
    Bytes(Vec<u8>),
    TooLarge,
}

/// Both sides of a file for `source`; `secret` files return empty contents unless `reveal`.
/// `orig_path` is the pre-rename path for the original side. Binary and over-sized files come back with empty contents
/// and the matching flag; text is decoded as UTF-8 (lossy).
pub async fn file_contents(
    ctx: &GitCtx,
    repo: &RepoConfig,
    path: &str,
    orig_path: Option<&str>,
    source: &DiffSource,
    reveal: bool,
) -> Result<FileContents, EngineError> {
    let root = PathBuf::from(&repo.path);
    let path = nfc_path(clean_rel_path(path)?.as_bytes());
    let orig = match orig_path {
        Some(o) => nfc_path(clean_rel_path(o)?.as_bytes()),
        None => path.clone(),
    };
    let full = resolve_in_repo(&root, &path)?;
    let language = language_for(&path);
    let result = |original: String, modified: String, binary: bool, too_large: bool, guard: GuardState| FileContents {
        path: path.clone(),
        original,
        modified,
        binary,
        too_large,
        guard,
        language: language.clone(),
    };

    let (orig_spec, modified_spec) = match source {
        DiffSource::WorktreeVsHead => (format!("HEAD:{orig}"), format!(":0:{path}")),
        DiffSource::StagedVsHead => (format!("HEAD:{orig}"), format!(":0:{path}")),
        DiffSource::Commit { oid } => {
            let oid = checked_oid(oid)?;
            (format!("{oid}^:{orig}"), format!("{oid}:{path}"))
        }
    };
    let worktree = matches!(source, DiffSource::WorktreeVsHead);

    // Secrets are recognised by name alone, so nothing is read for them without `reveal`. A new file is `secret`
    // (it cannot be committed), a tracked one `sensitive`. The old name of a rename counts too: its HEAD blob is the
    // old secret.
    let secret_name = guard::is_secret_name(&path) || guard::is_secret_name(&orig);
    if secret_name && !reveal {
        let untracked = worktree && !object_exists(ctx, &root, &orig_spec).await? && !object_exists(ctx, &root, &modified_spec).await?;
        return Ok(result(String::new(), String::new(), false, false, secret_state(untracked)));
    }

    // Worktree mode also asks for the index entry: a file in neither HEAD nor the index is untracked.
    let mut specs = vec![orig_spec];
    specs.push(modified_spec);
    let mut blobs = read_blobs(ctx, &root, &specs).await?;
    let in_index = blobs.pop().expect("modified side");
    let original = blobs.pop().expect("original side");
    let untracked = worktree && original.is_none_present() && in_index.is_none_present();
    let modified = if worktree { read_worktree_file(&full) } else { in_index.into_side() };
    let original = original.into_side();
    let (original, modified) = if worktree && orig == path { as_git_diffs(ctx, &root, &path, original, modified).await } else { (original, modified) };

    let disk_size = match &modified {
        Side::Bytes(b) => Some(b.len() as u64),
        _ => None,
    };
    let guard = match guard::classify(&path, untracked, disk_size.or_else(|| std::fs::symlink_metadata(&full).ok().map(|m| m.len()))) {
        GuardState::Ok if secret_name => secret_state(untracked),
        g => g,
    };

    let too_large = matches!(original, Side::TooLarge) || matches!(modified, Side::TooLarge) || guard == GuardState::TooLarge;
    if too_large {
        return Ok(result(String::new(), String::new(), false, true, guard));
    }
    let (original, modified) = (side_bytes(original), side_bytes(modified));
    if is_binary(&original) || is_binary(&modified) {
        return Ok(result(String::new(), String::new(), true, false, guard));
    }
    Ok(result(String::from_utf8_lossy(&original).into_owned(), String::from_utf8_lossy(&modified).into_owned(), false, false, guard))
}

/// Parsed hunks of one file. `worktreeVsHead` is `git diff HEAD` (index and worktree against HEAD), `stagedVsHead` is
/// `git diff --cached`, `commit` is the commit against its first parent. Untracked files have no hunks.
pub async fn file_hunks(ctx: &GitCtx, repo: &RepoConfig, path: &str, source: &DiffSource) -> Result<Vec<Hunk>, EngineError> {
    let root = PathBuf::from(&repo.path);
    let path = nfc_path(clean_rel_path(path)?.as_bytes());
    resolve_in_repo(&root, &path)?;
    // Hunk lines are file content: a secret's lines are never handed out (`file_contents` has the reveal path).
    if guard::is_secret_name(&path) {
        return Ok(Vec::new());
    }
    let common = ["-U3", "--no-color", "--no-ext-diff", "--no-textconv"];
    let oid;
    let mut args: Vec<&str> = match source {
        DiffSource::WorktreeVsHead => vec!["diff", "HEAD"],
        DiffSource::StagedVsHead => vec!["diff", "--cached"],
        DiffSource::Commit { oid: o } => {
            oid = checked_oid(o)?;
            vec!["diff-tree", "-p", "-r", "--root", "--no-commit-id", &oid]
        }
    };
    args.extend(common);
    args.extend(["--", &path]);
    let mut opts = RunOpts { read_only: true, max_output: Some(MAX_DIFF_TEXT_BYTES), ..Default::default() };
    opts.extra_env.insert("GIT_LITERAL_PATHSPECS".into(), "1".into());
    let run = run_git_full(ctx, &root, &args, &opts, None).await?;
    let out = run.output;
    if !out.success() {
        let err = out.stderr_text();
        // no commits yet: nothing to diff against
        if matches!(source, DiffSource::WorktreeVsHead) && (err.contains("ambiguous argument 'HEAD'") || err.contains("bad revision 'HEAD'")) {
            return Ok(Vec::new());
        }
        return Err(EngineError::new(code::GIT, "git diff failed").with_detail(err.trim().to_owned()));
    }
    if run.truncated {
        return Err(EngineError::new(code::GIT, "diff is too large to show").with_detail(format!("more than {MAX_DIFF_TEXT_BYTES} bytes")));
    }
    parse_unified_diff(&out.stdout_text())
}

fn secret_state(untracked: bool) -> GuardState {
    if untracked {
        GuardState::Secret
    } else {
        GuardState::Sensitive
    }
}

/// Whether an object spec resolves; nothing of the object is read.
async fn object_exists(ctx: &GitCtx, root: &Path, spec: &str) -> Result<bool, EngineError> {
    Ok(rev_parse(ctx, root, spec).await?.is_some())
}

/// The worktree side as `git diff HEAD` sees it: git applies its clean filters (`core.autocrlf`, `eol`/`text`
/// attributes) before comparing, so a CRLF file under `core.autocrlf=input` that only changed in one line differs
/// from its blob by that line alone, while the raw bytes differ everywhere. Both sides are rebuilt from the
/// whole-file diff git itself prints; any problem keeps the raw bytes.
async fn as_git_diffs(ctx: &GitCtx, root: &Path, path: &str, original: Side, modified: Side) -> (Side, Side) {
    let (Side::Bytes(o), Side::Bytes(m)) = (&original, &modified) else { return (original, modified) };
    if o == m || is_binary(o) || is_binary(m) {
        return (original, modified);
    }
    let args = ["diff", "HEAD", "-U9999999", "--no-color", "--no-ext-diff", "--no-textconv", "--", path];
    let mut opts = RunOpts { read_only: true, max_output: Some(MAX_DIFF_TEXT_BYTES), ..Default::default() };
    opts.extra_env.insert("GIT_LITERAL_PATHSPECS".into(), "1".into());
    let Ok(run) = run_git_full(ctx, root, &args, &opts, None).await else { return (original, modified) };
    if !run.output.success() || run.truncated {
        return (original, modified);
    }
    let Ok(hunks) = parse_unified_diff(&run.output.stdout_text()) else { return (original, modified) };
    match hunks.as_slice() {
        // git finds no difference once its filters ran
        [] => (Side::Bytes(o.clone()), Side::Bytes(o.clone())),
        [h] if h.old_start <= 1 && h.new_start <= 1 => {
            let side = |drop: HunkLineKind, final_newline: bool| {
                let lines: Vec<&str> = h.lines.iter().filter(|l| l.kind != drop).map(|l| l.text.as_str()).collect();
                let mut text = lines.join("\n");
                if final_newline && !lines.is_empty() {
                    text.push('\n');
                }
                Side::Bytes(text.into_bytes())
            };
            (side(HunkLineKind::Add, o.ends_with(b"\n")), side(HunkLineKind::Del, m.ends_with(b"\n")))
        }
        _ => (original, modified),
    }
}

fn checked_oid(oid: &str) -> Result<String, EngineError> {
    if (4..=64).contains(&oid.len()) && oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(oid.to_ascii_lowercase())
    } else {
        Err(EngineError::new(code::INVALID_SELECTION, format!("not a commit id: {oid:?}")))
    }
}

/// State of one object spec after the size check.
#[derive(Debug)]
enum Blob {
    Missing,
    NotBlob,
    TooLarge,
    Data(Vec<u8>),
}

impl Blob {
    fn is_none_present(&self) -> bool {
        matches!(self, Blob::Missing)
    }

    fn into_side(self) -> Side {
        match self {
            Blob::Missing | Blob::NotBlob => Side::Empty,
            Blob::TooLarge => Side::TooLarge,
            Blob::Data(d) => Side::Bytes(d),
        }
    }
}

fn side_bytes(s: Side) -> Vec<u8> {
    match s {
        Side::Bytes(b) => b,
        _ => Vec::new(),
    }
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0)
}

/// Loads objects by spec (`HEAD:path`, `:0:path`, `<oid>:path`): one `cat-file --batch-check` for the sizes, then one
/// `cat-file --batch` for the blobs that are small enough.
async fn read_blobs(ctx: &GitCtx, root: &Path, specs: &[String]) -> Result<Vec<Blob>, EngineError> {
    if specs.iter().any(|s| s.contains('\n')) {
        return Err(EngineError::new(code::INVALID_SELECTION, "paths containing a newline cannot be diffed"));
    }
    let input = specs.iter().map(|s| format!("{s}\n")).collect::<String>().into_bytes();
    let check = RunOpts { read_only: true, stdin: Some(input.clone()), ..Default::default() };
    let out = run_git(ctx, root, &["cat-file", "--batch-check=%(objecttype) %(objectsize)"], &check).await?;
    if !out.success() {
        return Err(EngineError::new(code::GIT, "git cat-file failed").with_detail(out.stderr_text().trim().to_owned()));
    }
    let text = out.stdout_text();
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() != specs.len() {
        return Err(EngineError::new(code::GIT, "unexpected cat-file output").with_detail(text.into_owned()));
    }
    let mut blobs: Vec<Blob> = Vec::with_capacity(specs.len());
    let mut wanted = String::new();
    for (line, spec) in lines.iter().zip(specs) {
        blobs.push(match line.split_once(' ') {
            Some(("blob", size)) => match size.parse::<u64>() {
                Ok(n) if n > MAX_DIFF_FILE_BYTES => Blob::TooLarge,
                Ok(_) => {
                    wanted.push_str(spec);
                    wanted.push('\n');
                    Blob::Data(Vec::new())
                }
                Err(_) => Blob::Missing,
            },
            Some((_, rest)) if rest.parse::<u64>().is_ok() => Blob::NotBlob,
            _ => Blob::Missing,
        });
    }
    if wanted.is_empty() {
        return Ok(blobs);
    }
    let fetch = RunOpts { read_only: true, stdin: Some(wanted.into_bytes()), max_output: Some(2 * MAX_DIFF_FILE_BYTES as usize + 4096), ..Default::default() };
    let run = run_git_full(ctx, root, &["cat-file", "--batch"], &fetch, None).await?;
    let out = run.output;
    if !out.success() || run.truncated {
        return Err(EngineError::new(code::GIT, "git cat-file failed").with_detail(out.stderr_text().trim().to_owned()));
    }
    let mut pos = 0;
    for blob in blobs.iter_mut().filter(|b| matches!(b, Blob::Data(_))) {
        let bad = || EngineError::new(code::GIT, "malformed cat-file --batch output");
        let nl = out.stdout[pos..].iter().position(|&b| b == b'\n').ok_or_else(bad)? + pos;
        let header = std::str::from_utf8(&out.stdout[pos..nl]).map_err(|_| bad())?;
        let size: usize = header.rsplit(' ').next().and_then(|n| n.parse().ok()).ok_or_else(bad)?;
        let start = nl + 1;
        let data = out.stdout.get(start..start + size).ok_or_else(bad)?;
        *blob = Blob::Data(data.to_vec());
        pos = start + size + 1;
    }
    Ok(blobs)
}

/// The worktree side: file bytes, a symlink's target text (as git stores it), or empty for a missing path / directory.
fn read_worktree_file(full: &Path) -> Side {
    let Ok(meta) = std::fs::symlink_metadata(full) else { return Side::Empty };
    if meta.file_type().is_symlink() {
        return std::fs::read_link(full).map_or(Side::Empty, |t| Side::Bytes(t.as_os_str().as_encoded_bytes().to_vec()));
    }
    if !meta.is_file() {
        return Side::Empty;
    }
    if meta.len() > MAX_DIFF_FILE_BYTES {
        return Side::TooLarge;
    }
    let mut buf = Vec::with_capacity(meta.len() as usize);
    match std::fs::File::open(full).and_then(|f| f.take(MAX_DIFF_FILE_BYTES + 1).read_to_end(&mut buf)) {
        Ok(_) if buf.len() as u64 > MAX_DIFF_FILE_BYTES => Side::TooLarge,
        Ok(_) => Side::Bytes(buf),
        Err(_) => Side::Empty,
    }
}

/// Editor language id by file name / extension (CodeMirror-style names; `tsx`/`jsx` are separate ids).
pub fn language_for(path: &str) -> Option<String> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let lower = name.to_ascii_lowercase();
    let by_name = match lower.as_str() {
        "dockerfile" => Some("dockerfile"),
        "makefile" | "gnumakefile" => Some("makefile"),
        ".gitignore" | ".dockerignore" | ".npmignore" | ".prettierignore" => Some("gitignore"),
        ".env" => Some("properties"),
        "cargo.lock" => Some("toml"),
        ".babelrc" | ".eslintrc" | ".prettierrc" | "tsconfig.json" | "composer.lock" => Some("json"),
        _ => None,
    };
    if by_name.is_some() {
        return by_name.map(str::to_owned);
    }
    if lower.starts_with(".env.") {
        return Some("properties".to_owned());
    }
    let ext = lower.rsplit_once('.')?.1;
    let lang = match ext {
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "jsx",
        "json" | "jsonc" | "map" | "webmanifest" => "json",
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "html" | "htm" => "html",
        "vue" => "vue",
        "svelte" => "svelte",
        "md" | "markdown" | "mdx" => "markdown",
        "yml" | "yaml" => "yaml",
        "toml" => "toml",
        "rs" => "rust",
        "py" | "pyw" => "python",
        "sh" | "bash" | "zsh" => "shell",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "swift" => "swift",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" => "cpp",
        "cs" => "csharp",
        "rb" => "ruby",
        "php" => "php",
        "sql" => "sql",
        "xml" | "svg" | "plist" | "xib" | "storyboard" => "xml",
        "gradle" | "groovy" => "groovy",
        "properties" | "env" | "ini" | "conf" => "properties",
        "txt" | "log" => "text",
        _ => return None,
    };
    Some(lang.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::fixture::*;

    fn commit_oid(f: &Fixture) -> String {
        f.git(&["rev-parse", "HEAD"])
    }

    async fn contents(f: &Fixture, path: &str, source: DiffSource) -> FileContents {
        file_contents(&ctx(), &f.config(), path, None, &source, false).await.unwrap()
    }

    #[test]
    fn language_by_extension_and_name() {
        for (p, l) in [
            ("src/app.ts", Some("typescript")),
            ("a/B.TSX", Some("tsx")),
            ("x.mjs", Some("javascript")),
            ("Dockerfile", Some("dockerfile")),
            ("deep/dir/Cargo.toml", Some("toml")),
            (".env.local", Some("properties")),
            ("README.md", Some("markdown")),
            ("noext", None),
            ("weird.zzz", None),
        ] {
            assert_eq!(language_for(p).as_deref(), l, "{p}");
        }
    }

    #[tokio::test]
    async fn worktree_vs_head_modified_added_deleted_untracked() {
        let f = Fixture::new();
        f.write("src/a.rs", "fn a() {}\n");
        f.write("gone.txt", "bye\n");
        f.commit_all("base");
        f.write("src/a.rs", "fn a() { 1 }\n");
        std::fs::remove_file(f.root.join("gone.txt")).unwrap();
        f.write("fresh.txt", "new\n");
        let m = contents(&f, "src/a.rs", DiffSource::WorktreeVsHead).await;
        assert_eq!((m.original.as_str(), m.modified.as_str(), m.language.as_deref(), m.binary, m.too_large, m.guard.clone()), ("fn a() {}\n", "fn a() { 1 }\n", Some("rust"), false, false, GuardState::Ok));
        let d = contents(&f, "gone.txt", DiffSource::WorktreeVsHead).await;
        assert_eq!((d.original.as_str(), d.modified.as_str()), ("bye\n", ""));
        let u = contents(&f, "fresh.txt", DiffSource::WorktreeVsHead).await;
        assert_eq!((u.original.as_str(), u.modified.as_str()), ("", "new\n"));
    }

    #[tokio::test]
    async fn staged_vs_head_reads_the_index_not_the_worktree() {
        let f = Fixture::new();
        f.write("a.txt", "v1\n");
        f.commit_all("base");
        f.write("a.txt", "v2-staged\n");
        f.git(&["add", "a.txt"]);
        f.write("a.txt", "v3-worktree\n");
        let s = contents(&f, "a.txt", DiffSource::StagedVsHead).await;
        assert_eq!((s.original.as_str(), s.modified.as_str()), ("v1\n", "v2-staged\n"));
        let w = contents(&f, "a.txt", DiffSource::WorktreeVsHead).await;
        assert_eq!(w.modified, "v3-worktree\n");
    }

    #[tokio::test]
    async fn commit_source_with_rename_and_root_commit() {
        let f = Fixture::unborn();
        f.write("old.txt", "one\ntwo\n");
        f.commit_all("root");
        let root_oid = commit_oid(&f);
        f.git(&["mv", "old.txt", "new.txt"]);
        f.write("new.txt", "one\ntwo\nthree\n");
        f.commit_all("rename+edit");
        let oid = commit_oid(&f);
        let r = file_contents(&ctx(), &f.config(), "new.txt", Some("old.txt"), &DiffSource::Commit { oid: oid.clone() }, false).await.unwrap();
        assert_eq!((r.original.as_str(), r.modified.as_str()), ("one\ntwo\n", "one\ntwo\nthree\n"));
        let root = contents(&f, "old.txt", DiffSource::Commit { oid: root_oid }).await;
        assert_eq!((root.original.as_str(), root.modified.as_str()), ("", "one\ntwo\n"));
        let short = contents(&f, "new.txt", DiffSource::Commit { oid: oid[..8].to_owned() }).await;
        assert_eq!(short.modified, "one\ntwo\nthree\n");
        let e = file_contents(&ctx(), &f.config(), "new.txt", None, &DiffSource::Commit { oid: "--output=x".into() }, false).await.unwrap_err();
        assert_eq!(e.code, code::INVALID_SELECTION);
    }

    #[tokio::test]
    async fn binary_and_large_files_return_flags_without_contents() {
        let f = Fixture::new();
        f.write("img.png", [0x89, b'P', b'N', b'G', 0, 1, 2, 3]);
        f.write("big.txt", vec![b'a'; 3 * 1024 * 1024]);
        f.commit_all("assets");
        f.write("img.png", [0x89, b'P', b'N', b'G', 0, 9, 9, 9]);
        f.write("big.txt", vec![b'b'; 3 * 1024 * 1024]);
        f.write("untracked.bin", [0u8, 1, 2]);
        let b = contents(&f, "img.png", DiffSource::WorktreeVsHead).await;
        assert!(b.binary && !b.too_large && b.original.is_empty() && b.modified.is_empty());
        let l = contents(&f, "big.txt", DiffSource::WorktreeVsHead).await;
        assert!(l.too_large && !l.binary && l.original.is_empty() && l.modified.is_empty());
        let c = contents(&f, "big.txt", DiffSource::Commit { oid: commit_oid(&f) }).await;
        assert!(c.too_large);
        assert!(contents(&f, "untracked.bin", DiffSource::WorktreeVsHead).await.binary);
    }

    #[tokio::test]
    async fn untracked_file_over_5_mb_is_guarded_too_large() {
        let f = Fixture::new();
        f.write("huge.log", vec![b'x'; 6 * 1024 * 1024]);
        let c = contents(&f, "huge.log", DiffSource::WorktreeVsHead).await;
        assert!(c.too_large);
        assert_eq!(c.guard, GuardState::TooLarge);
    }

    #[tokio::test]
    async fn secret_files_are_hidden_unless_revealed() {
        let f = Fixture::new();
        f.write(".env", "TOKEN=hunter2\n");
        f.write("config/google-services.json", "{\"k\":1}");
        for p in [".env", "config/google-services.json"] {
            let hidden = contents(&f, p, DiffSource::WorktreeVsHead).await;
            assert_eq!((hidden.original.as_str(), hidden.modified.as_str(), hidden.guard.clone()), ("", "", GuardState::Secret), "{p}");
            let shown = file_contents(&ctx(), &f.config(), p, None, &DiffSource::WorktreeVsHead, true).await.unwrap();
            assert_eq!(shown.guard, GuardState::Secret);
            assert!(!shown.modified.is_empty(), "{p}");
        }
        // templates are not secrets
        f.write(".env.example", "TOKEN=\n");
        let ex = contents(&f, ".env.example", DiffSource::WorktreeVsHead).await;
        assert_eq!((ex.guard, ex.modified.as_str()), (GuardState::Ok, "TOKEN=\n"));
    }

    #[tokio::test]
    async fn a_tracked_secret_named_file_is_sensitive_and_still_needs_reveal() {
        let f = Fixture::new();
        f.write(".npmrc", "registry=https://example.invalid\n");
        f.commit_all("npmrc");
        f.write(".npmrc", "//example.invalid/:_authToken=hunter2\n");
        let hidden = contents(&f, ".npmrc", DiffSource::WorktreeVsHead).await;
        assert_eq!((hidden.original.as_str(), hidden.modified.as_str(), hidden.guard.clone()), ("", "", GuardState::Sensitive));
        let shown = file_contents(&ctx(), &f.config(), ".npmrc", None, &DiffSource::WorktreeVsHead, true).await.unwrap();
        assert_eq!(shown.guard, GuardState::Sensitive);
        assert!(shown.original.contains("registry=") && shown.modified.contains("hunter2"));
        assert!(file_hunks(&ctx(), &f.config(), ".npmrc", &DiffSource::WorktreeVsHead).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn crlf_files_under_autocrlf_input_diff_like_git_does() {
        let f = Fixture::new();
        f.git(&["config", "core.autocrlf", "input"]);
        f.write("win.txt", "one\ntwo\nthree\n");
        f.write("tail.txt", "a\nb");
        f.write("same.txt", "x\n");
        f.commit_all("lf in the repo");
        // the checkout on a Windows-minded machine: CRLF in the worktree, one real change
        f.write("win.txt", "one\r\nTWO\r\nthree\r\n");
        f.write("tail.txt", "a\r\nB");
        f.write("same.txt", "x\r\n");

        let c = contents(&f, "win.txt", DiffSource::WorktreeVsHead).await;
        assert_eq!((c.original.as_str(), c.modified.as_str()), ("one\ntwo\nthree\n", "one\nTWO\nthree\n"));
        let c = contents(&f, "tail.txt", DiffSource::WorktreeVsHead).await;
        assert_eq!((c.original.as_str(), c.modified.as_str()), ("a\nb", "a\nB"));
        // git sees no difference at all after its filters
        let c = contents(&f, "same.txt", DiffSource::WorktreeVsHead).await;
        assert_eq!((c.original.as_str(), c.modified.as_str()), ("x\n", "x\n"));
        // and the hunks agree with the contents
        let hunks = file_hunks(&ctx(), &f.config(), "win.txt", &DiffSource::WorktreeVsHead).await.unwrap();
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].lines.iter().filter(|l| l.kind != HunkLineKind::Context).count(), 2);
    }

    #[tokio::test]
    async fn crlf_files_stay_crlf_when_the_repo_stores_crlf() {
        let f = Fixture::new();
        f.git(&["config", "core.autocrlf", "false"]);
        f.write("dos.txt", "one\r\ntwo\r\n");
        f.commit_all("crlf in the repo");
        f.write("dos.txt", "one\r\nTWO\r\n");
        let c = contents(&f, "dos.txt", DiffSource::WorktreeVsHead).await;
        assert_eq!((c.original.as_str(), c.modified.as_str()), ("one\r\ntwo\r\n", "one\r\nTWO\r\n"));
    }

    #[tokio::test]
    async fn a_secret_cannot_leak_through_a_rename_or_the_hunks() {
        let f = Fixture::new();
        f.write(".env", "TOKEN=hunter2\n");
        f.commit_all("env");
        f.git(&["mv", ".env", "env.bak"]);
        f.commit_all("rename");
        let oid = commit_oid(&f);
        let hidden = file_contents(&ctx(), &f.config(), "env.bak", Some(".env"), &DiffSource::Commit { oid: oid.clone() }, false).await.unwrap();
        assert_eq!((hidden.original.as_str(), hidden.modified.as_str(), hidden.guard.clone()), ("", "", GuardState::Sensitive));
        let shown = file_contents(&ctx(), &f.config(), "env.bak", Some(".env"), &DiffSource::Commit { oid }, true).await.unwrap();
        assert!(shown.original.contains("hunter2"));

        f.write(".env", "TOKEN=hunter3\n");
        f.commit_all("env again");
        f.write(".env", "TOKEN=hunter4\n");
        assert!(file_hunks(&ctx(), &f.config(), ".env", &DiffSource::WorktreeVsHead).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn paths_must_stay_inside_the_repo() {
        let f = Fixture::new();
        std::fs::write(f.dir.path().join("outside.txt"), "outside").unwrap();
        std::os::unix::fs::symlink(f.dir.path(), f.root.join("escape")).unwrap();
        for bad in ["../outside.txt", "escape/outside.txt", "/etc/passwd", "a/../../outside.txt", ""] {
            let e = file_contents(&ctx(), &f.config(), bad, None, &DiffSource::WorktreeVsHead, false).await.unwrap_err();
            assert_eq!(e.code, code::INVALID_SELECTION, "{bad:?}");
            let e = file_hunks(&ctx(), &f.config(), bad, &DiffSource::WorktreeVsHead).await.unwrap_err();
            assert_eq!(e.code, code::INVALID_SELECTION, "{bad:?}");
        }
        let e = file_contents(&ctx(), &f.config(), "a.txt", Some("../outside.txt"), &DiffSource::WorktreeVsHead, false).await.unwrap_err();
        assert_eq!(e.code, code::INVALID_SELECTION);
        let e = file_contents(&ctx(), &f.config(), "bad\nname.txt", None, &DiffSource::StagedVsHead, false).await.unwrap_err();
        assert_eq!(e.code, code::INVALID_SELECTION);
    }

    #[tokio::test]
    async fn tracked_symlink_shows_its_target_not_the_target_file() {
        let f = Fixture::new();
        std::fs::write(f.dir.path().join("outside.txt"), "outside secret").unwrap();
        std::os::unix::fs::symlink("../outside.txt", f.root.join("lnk")).unwrap();
        f.commit_all("link");
        std::fs::remove_file(f.root.join("lnk")).unwrap();
        std::os::unix::fs::symlink("../elsewhere", f.root.join("lnk")).unwrap();
        let c = contents(&f, "lnk", DiffSource::WorktreeVsHead).await;
        assert_eq!((c.original.as_str(), c.modified.as_str()), ("../outside.txt", "../elsewhere"));
    }

    #[tokio::test]
    async fn special_file_names_round_trip() {
        let f = Fixture::new();
        let names = ["sp ace.txt", "[id].tsx", ":magic.txt", "-dash.txt", "(tabs)/index.tsx", "árvíztűrő.txt", "quo\"te.txt"];
        for n in names {
            f.write(n, format!("v1 {n}\n"));
        }
        f.commit_all("names");
        for n in names {
            f.write(n, format!("v2 {n}\n"));
            let c = contents(&f, n, DiffSource::WorktreeVsHead).await;
            assert_eq!((c.original, c.modified), (format!("v1 {n}\n"), format!("v2 {n}\n")), "{n}");
        }
    }

    #[tokio::test]
    async fn hunks_for_all_three_sources() {
        let f = Fixture::new();
        let base: String = (1..=40).map(|i| format!("line {i}\n")).collect();
        f.write("f.txt", &base);
        f.commit_all("base");
        let edited = base.replace("line 2\n", "LINE 2\n").replace("line 35\n", "line 35\nextra\n");
        f.write("f.txt", &edited);
        let w = file_hunks(&ctx(), &f.config(), "f.txt", &DiffSource::WorktreeVsHead).await.unwrap();
        assert_eq!(w.len(), 2);
        assert_eq!((w[0].index, w[0].old_start, w[0].new_start), (0, 1, 1));
        assert!(w[0].lines.iter().any(|l| l.kind == HunkLineKind::Del && l.text == "line 2"));
        assert!(w[1].lines.iter().any(|l| l.kind == HunkLineKind::Add && l.text == "extra"));
        assert!(file_hunks(&ctx(), &f.config(), "f.txt", &DiffSource::StagedVsHead).await.unwrap().is_empty());
        f.git(&["add", "f.txt"]);
        assert_eq!(file_hunks(&ctx(), &f.config(), "f.txt", &DiffSource::StagedVsHead).await.unwrap().len(), 2);
        f.git(&["commit", "-q", "-m", "edit"]);
        let c = file_hunks(&ctx(), &f.config(), "f.txt", &DiffSource::Commit { oid: commit_oid(&f) }).await.unwrap();
        assert_eq!(c.len(), 2);
        // untracked and unchanged files have no hunks
        f.write("new.txt", "x\n");
        assert!(file_hunks(&ctx(), &f.config(), "new.txt", &DiffSource::WorktreeVsHead).await.unwrap().is_empty());
        assert!(file_hunks(&ctx(), &f.config(), "f.txt", &DiffSource::WorktreeVsHead).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn hunks_use_literal_pathspecs_and_work_on_root_commit_and_unborn_repos() {
        let f = Fixture::unborn();
        assert!(file_hunks(&ctx(), &f.config(), "a.txt", &DiffSource::WorktreeVsHead).await.unwrap().is_empty());
        f.write("[id].tsx", "a\n");
        f.write("i.tsx", "a\n");
        f.commit_all("root");
        f.write("[id].tsx", "b\n");
        f.write("i.tsx", "b\n");
        let h = file_hunks(&ctx(), &f.config(), "[id].tsx", &DiffSource::WorktreeVsHead).await.unwrap();
        assert_eq!(h.len(), 1, "the glob [id] must not also match i.tsx");
        let root_hunks = file_hunks(&ctx(), &f.config(), "i.tsx", &DiffSource::Commit { oid: commit_oid(&f) }).await.unwrap();
        assert_eq!(root_hunks.len(), 1);
        assert_eq!(root_hunks[0].lines.len(), 1);
    }
}
