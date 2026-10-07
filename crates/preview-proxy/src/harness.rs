//! Component preview harness, Rust side ((design notes: preview-plan) Stage B): validation of what the webview asks for, the JSON
//! argument of the IDE-owned Node harness (`scripts/preview/harness/server.mjs`) and the lookup of `node`.
//!
//! The webview sends a repo id, a repo-relative path and an export name; the glue resolves the repo root itself. Nothing here
//! starts a process or touches the network, and nothing is written into the repository: the Node harness writes to the IDE's
//! state directory only.

use std::fmt;
use std::path::{Component as PathPart, Path, PathBuf};

const EXTENSIONS: [&str; 5] = ["js", "jsx", "ts", "tsx", "mjs"];
const MAX_PATH: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HarnessError {
    /// Absolute path, `..`, control characters, NUL, or longer than 1024 bytes.
    BadPath,
    /// Not one of `.js .jsx .ts .tsx .mjs`.
    BadFile,
    /// The file does not exist.
    NotFound,
    /// After symlinks are resolved the file is outside the repository, or inside `node_modules`.
    OutsideRepo,
    /// The export is not `default` or an identifier.
    BadExport,
}

impl HarnessError {
    pub fn code(&self) -> &'static str {
        match self {
            HarnessError::BadPath => "badPath",
            HarnessError::BadFile => "badFile",
            HarnessError::NotFound => "notFound",
            HarnessError::OutsideRepo => "outsideRepo",
            HarnessError::BadExport => "badExport",
        }
    }
}

impl fmt::Display for HarnessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            HarnessError::BadPath => "the component path must be relative to the repository and stay inside it",
            HarnessError::BadFile => "only .js, .jsx, .ts, .tsx and .mjs files can be previewed",
            HarnessError::NotFound => "that file does not exist in the repository",
            HarnessError::OutsideRepo => "the component resolves outside the repository (or into node_modules)",
            HarnessError::BadExport => "the export name must be `default` or a plain identifier",
        })
    }
}

impl std::error::Error for HarnessError {}

/// A component the harness may bundle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Component {
    /// Canonical repository root.
    pub root: PathBuf,
    /// Repo-relative, `/`-separated, as the webview wrote it (normalised).
    pub file: String,
    pub export: String,
}

impl Component {
    /// Stable key of a component (one harness process per key): `<root>\0<file>`.
    pub fn key(&self) -> String {
        format!("{}\0{}", self.root.display(), self.file)
    }
}

/// `default` or `[A-Za-z_$][A-Za-z0-9_$]{0,99}`.
pub fn valid_export(name: &str) -> bool {
    if name == "default" {
        return true;
    }
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$') && name.len() <= 100 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// Checks a request against a repository root: same rules as the Node harness (it re-checks), so a refusal here never
/// costs a process.
pub fn validate(root: &Path, file: &str, export: &str) -> Result<Component, HarnessError> {
    if !valid_export(export) {
        return Err(HarnessError::BadExport);
    }
    if file.is_empty() || file.len() > MAX_PATH || file.chars().any(|c| c.is_control()) || file.starts_with('/') || file.contains('\\') || Path::new(file).is_absolute() {
        return Err(HarnessError::BadPath);
    }
    if Path::new(file).components().any(|c| !matches!(c, PathPart::Normal(_) | PathPart::CurDir)) {
        return Err(HarnessError::BadPath);
    }
    let ext = Path::new(file).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    if !ext.as_deref().is_some_and(|e| EXTENSIONS.contains(&e)) {
        return Err(HarnessError::BadFile);
    }
    let root = root.canonicalize().map_err(|_| HarnessError::NotFound)?;
    let abs = root.join(file).canonicalize().map_err(|_| HarnessError::NotFound)?;
    if !abs.starts_with(&root) || abs.components().any(|c| c.as_os_str() == "node_modules") {
        return Err(HarnessError::OutsideRepo);
    }
    let file = abs.strip_prefix(&root).map_err(|_| HarnessError::OutsideRepo)?.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
    Ok(Component { root, file, export: export.to_owned() })
}

/// JSON string literal (RFC 8259): quotes, backslashes and control characters escaped.
pub fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The single argument of `server.mjs`.
pub fn config_json(c: &Component, state_dir: &Path, ide_root: &Path) -> String {
    format!(
        "{{\"repoRoot\":{},\"stateDir\":{},\"file\":{},\"exportName\":{},\"ideRoot\":{}}}",
        json_str(&c.root.to_string_lossy()),
        json_str(&state_dir.to_string_lossy()),
        json_str(&c.file),
        json_str(&c.export),
        json_str(&ide_root.to_string_lossy()),
    )
}

/// First executable `node` on `path` (a `PATH`-style value), then the usual install locations. A GUI app started from the
/// Finder has a minimal `PATH`, so the fallbacks matter.
pub fn find_node(path: Option<&std::ffi::OsStr>, home: Option<&Path>) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = path.map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    if let Some(h) = home {
        dirs.push(h.join(".volta/bin"));
        dirs.push(h.join(".local/share/fnm/aliases/default/bin"));
        // nvm: newest installed version
        if let Ok(rd) = std::fs::read_dir(h.join(".nvm/versions/node")) {
            let mut v: Vec<PathBuf> = rd.flatten().map(|e| e.path().join("bin")).collect();
            v.sort();
            v.reverse();
            dirs.extend(v);
        }
    }
    dirs.into_iter().map(|d| d.join("node")).find(|p| p.is_absolute() && p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn repo() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join("src/components")).unwrap();
        fs::create_dir_all(d.path().join("node_modules/react")).unwrap();
        fs::write(d.path().join("src/components/A.jsx"), "export default () => null").unwrap();
        fs::write(d.path().join("src/data.json"), "{}").unwrap();
        fs::write(d.path().join("node_modules/react/index.js"), "").unwrap();
        d
    }

    #[test]
    fn accepts_a_repo_file_and_normalises_the_path() {
        let d = repo();
        let c = validate(d.path(), "./src/components/A.jsx", "default").unwrap();
        assert_eq!(c.file, "src/components/A.jsx");
        assert_eq!(c.export, "default");
        assert_eq!(c.root, d.path().canonicalize().unwrap());
        assert_eq!(validate(d.path(), "src/components/A.jsx", "A").unwrap().export, "A");
    }

    #[test]
    fn refuses_paths_that_leave_the_repository() {
        let d = repo();
        for bad in ["../x.jsx", "src/../../x.jsx", "/etc/passwd.js", "", "src\\a.jsx", "src/a\u{0}.jsx", "src/a\n.jsx"] {
            assert_eq!(validate(d.path(), bad, "default").unwrap_err(), HarnessError::BadPath, "{bad:?}");
        }
        assert_eq!(validate(d.path(), &"a/".repeat(600), "default").unwrap_err(), HarnessError::BadPath);
    }

    #[test]
    fn refuses_other_file_types_and_node_modules_and_missing_files() {
        let d = repo();
        assert_eq!(validate(d.path(), "src/data.json", "default").unwrap_err(), HarnessError::BadFile);
        assert_eq!(validate(d.path(), "src/components/A", "default").unwrap_err(), HarnessError::BadFile);
        assert_eq!(validate(d.path(), "node_modules/react/index.js", "default").unwrap_err(), HarnessError::OutsideRepo);
        assert_eq!(validate(d.path(), "src/nope.jsx", "default").unwrap_err(), HarnessError::NotFound);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_out_of_the_repository_and_a_sibling_with_a_shared_prefix() {
        let d = repo();
        let out = tempfile::tempdir().unwrap();
        fs::write(out.path().join("x.jsx"), "").unwrap();
        std::os::unix::fs::symlink(out.path().join("x.jsx"), d.path().join("src/linked.jsx")).unwrap();
        assert_eq!(validate(d.path(), "src/linked.jsx", "default").unwrap_err(), HarnessError::OutsideRepo);
        // /tmp/repo-evil must not count as inside /tmp/repo
        let parent = tempfile::tempdir().unwrap();
        fs::create_dir_all(parent.path().join("repo")).unwrap();
        fs::create_dir_all(parent.path().join("repo-evil")).unwrap();
        fs::write(parent.path().join("repo-evil/x.jsx"), "").unwrap();
        std::os::unix::fs::symlink(parent.path().join("repo-evil/x.jsx"), parent.path().join("repo/y.jsx")).unwrap();
        assert_eq!(validate(&parent.path().join("repo"), "y.jsx", "default").unwrap_err(), HarnessError::OutsideRepo);
    }

    #[test]
    fn export_names_are_identifiers_only() {
        for ok in ["default", "Button", "_Private", "$x", "A1"] {
            assert!(valid_export(ok), "{ok}");
        }
        for bad in ["", "1A", "a-b", "a b", "ev;il()", "a.b", "a\"b", &"x".repeat(101)] {
            assert!(!valid_export(bad), "{bad}");
        }
        let d = repo();
        assert_eq!(validate(d.path(), "src/components/A.jsx", "x;y").unwrap_err(), HarnessError::BadExport);
    }

    #[test]
    fn the_config_is_valid_json_even_with_hostile_characters() {
        let c = Component { root: PathBuf::from("/r/with \"quote\" and \\ back"), file: "src/a\tb.jsx".into(), export: "default".into() };
        let s = config_json(&c, Path::new("/state/dir"), Path::new("/ide"));
        assert!(s.contains(r#""repoRoot":"/r/with \"quote\" and \\ back""#));
        assert!(s.contains(r#""file":"src/a\tb.jsx""#));
        assert!(!s.contains('\n'));
        assert_eq!(json_str("\u{1}"), "\"\\u0001\"");
    }

    #[test]
    fn finds_node_on_a_given_path_and_ignores_directories_called_node() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join("a/node")).unwrap();
        fs::create_dir_all(d.path().join("b")).unwrap();
        fs::write(d.path().join("b/node"), "").unwrap();
        let path = std::env::join_paths([d.path().join("a"), d.path().join("b")]).unwrap();
        assert_eq!(find_node(Some(&path), None), Some(d.path().join("b/node")));
    }
}
