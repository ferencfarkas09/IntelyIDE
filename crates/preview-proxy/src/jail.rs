//! The message channel back to the IDE carries `{file, line, col, componentName}` and nothing else. The page is
//! untrusted, so the message is only a hint: it is validated here and the path must resolve (symlinks included) to an
//! existing file inside a registered repo. The UI repeats the lexical part of these checks before it opens a tab.

use std::path::{Component, Path, PathBuf};

pub const MAX_PATH: usize = 1024;
pub const MAX_NAME: usize = 128;
pub const MAX_LINE: u32 = 10_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceHint {
    /// Absolute, or relative to the repo of the preview tab; empty for a name-only hint.
    pub file: String,
    pub line: u32,
    pub col: u32,
    pub component_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HintError {
    BadPath,
    BadName,
    BadPosition,
    NothingToResolve,
    OutsideRepos,
    NotFound,
}

fn clean_path_text(p: &str) -> bool {
    !p.is_empty() && p.len() <= MAX_PATH && !p.chars().any(|c| c.is_control()) && !p.contains('\\')
}

fn clean_name(n: &str) -> bool {
    n.len() <= MAX_NAME && n.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '$' | '.' | '-' | ' ' | '<' | '>' | '(' | ')'))
}

pub fn validate_hint(file: &str, line: i64, col: i64, name: &str) -> Result<SourceHint, HintError> {
    if !clean_name(name) {
        return Err(HintError::BadName);
    }
    if file.is_empty() {
        return if name.is_empty() { Err(HintError::NothingToResolve) } else { Ok(SourceHint { file: String::new(), line: 0, col: 0, component_name: name.to_string() }) };
    }
    if !clean_path_text(file) {
        return Err(HintError::BadPath);
    }
    if Path::new(file).components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(HintError::BadPath);
    }
    if !(1..=MAX_LINE as i64).contains(&line) || !(0..=MAX_LINE as i64).contains(&col) {
        return Err(HintError::BadPosition);
    }
    Ok(SourceHint { file: file.to_string(), line: line as u32, col: col.max(1) as u32, component_name: name.to_string() })
}

/// `(repo id, repo-relative path)` of an existing file under one of `roots`, or why not.
pub fn resolve_in_repos(roots: &[(String, PathBuf)], hint: &SourceHint, default_repo: Option<&str>) -> Result<(String, PathBuf), HintError> {
    if hint.file.is_empty() {
        return Err(HintError::NothingToResolve);
    }
    let canon_roots: Vec<(&String, PathBuf)> = roots.iter().filter_map(|(id, p)| p.canonicalize().ok().map(|c| (id, c))).collect();
    let given = Path::new(&hint.file);
    let candidate = if given.is_absolute() {
        given.to_path_buf()
    } else {
        let root = default_repo.and_then(|d| roots.iter().find(|(id, _)| id == d)).ok_or(HintError::OutsideRepos)?;
        root.1.join(given)
    };
    let real = candidate.canonicalize().map_err(|_| HintError::NotFound)?;
    let (id, root) = canon_roots.iter().find(|(_, r)| real.starts_with(r)).ok_or(HintError::OutsideRepos)?;
    if !real.is_file() {
        return Err(HintError::NotFound);
    }
    let rel = real.strip_prefix(root).map_err(|_| HintError::OutsideRepos)?.to_path_buf();
    Ok(((*id).clone(), rel))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn repo() -> (tempfile::TempDir, Vec<(String, PathBuf)>) {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join("admin/src")).unwrap();
        fs::create_dir_all(d.path().join("other")).unwrap();
        fs::write(d.path().join("admin/src/App.js"), "x").unwrap();
        fs::write(d.path().join("other/secret.txt"), "x").unwrap();
        let roots = vec![("admin".to_string(), d.path().join("admin"))];
        (d, roots)
    }

    #[test]
    fn hints_are_validated_before_use() {
        assert!(validate_hint("/r/src/a.js", 12, 3, "Login").is_ok());
        assert_eq!(validate_hint("", 0, 0, "Login").unwrap().component_name, "Login");
        assert_eq!(validate_hint("", 0, 0, ""), Err(HintError::NothingToResolve));
        assert_eq!(validate_hint("../etc/passwd", 1, 1, ""), Err(HintError::BadPath));
        assert_eq!(validate_hint("a/../../b", 1, 1, ""), Err(HintError::BadPath));
        assert_eq!(validate_hint("a\0b", 1, 1, ""), Err(HintError::BadPath));
        assert_eq!(validate_hint("a\nb", 1, 1, ""), Err(HintError::BadPath));
        assert_eq!(validate_hint("a\\b", 1, 1, ""), Err(HintError::BadPath));
        assert_eq!(validate_hint("a.js", 0, 1, ""), Err(HintError::BadPosition));
        assert_eq!(validate_hint("a.js", -3, 1, ""), Err(HintError::BadPosition));
        assert_eq!(validate_hint("a.js", i64::MAX, 1, ""), Err(HintError::BadPosition));
        assert_eq!(validate_hint("a.js", 1, 1, "<script>alert(1)</script>/x"), Err(HintError::BadName));
        assert_eq!(validate_hint("a.js", 1, 1, &"N".repeat(MAX_NAME + 1)), Err(HintError::BadName));
        assert_eq!(validate_hint(&"p".repeat(MAX_PATH + 1), 1, 1, ""), Err(HintError::BadPath));
    }

    #[test]
    fn paths_must_land_inside_a_registered_repo() {
        let (d, roots) = repo();
        let abs = d.path().join("admin/src/App.js");
        let h = |f: &str| SourceHint { file: f.to_string(), line: 1, col: 1, component_name: String::new() };
        let (id, rel) = resolve_in_repos(&roots, &h(abs.to_str().unwrap()), None).unwrap();
        assert_eq!((id.as_str(), rel), ("admin", PathBuf::from("src/App.js")));
        assert_eq!(resolve_in_repos(&roots, &h("src/App.js"), Some("admin")).unwrap().1, PathBuf::from("src/App.js"));
        assert_eq!(resolve_in_repos(&roots, &h("src/App.js"), None), Err(HintError::OutsideRepos));
        assert_eq!(resolve_in_repos(&roots, &h(d.path().join("other/secret.txt").to_str().unwrap()), None), Err(HintError::OutsideRepos));
        assert_eq!(resolve_in_repos(&roots, &h("/etc/hosts"), None), Err(HintError::OutsideRepos));
        assert_eq!(resolve_in_repos(&roots, &h("src/Nope.js"), Some("admin")), Err(HintError::NotFound));
        assert_eq!(resolve_in_repos(&roots, &h("src"), Some("admin")), Err(HintError::NotFound), "a directory is not a source file");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_repo_is_refused() {
        let (d, roots) = repo();
        std::os::unix::fs::symlink(d.path().join("other/secret.txt"), d.path().join("admin/src/link.js")).unwrap();
        let hint = SourceHint { file: "src/link.js".into(), line: 1, col: 1, component_name: String::new() };
        assert_eq!(resolve_in_repos(&roots, &hint, Some("admin")), Err(HintError::OutsideRepos));
        // a sibling directory whose name merely starts with the repo name is not inside it
        fs::create_dir_all(d.path().join("admin-evil")).unwrap();
        fs::write(d.path().join("admin-evil/x.js"), "x").unwrap();
        let hint = SourceHint { file: d.path().join("admin-evil/x.js").to_str().unwrap().into(), line: 1, col: 1, component_name: String::new() };
        assert_eq!(resolve_in_repos(&roots, &hint, None), Err(HintError::OutsideRepos));
    }
}
