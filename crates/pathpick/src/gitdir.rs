//! Git directory inspection by reading files only. **No git process is spawned anywhere in this crate**, so a hostile
//! `.git/config` cannot run anything while a folder is being validated ((design notes: workspaces-spec) 5.5, T4).
//!
//! Every file a folder controls is read through [`crate::fsio::read_small`]. Config values never leave this module:
//! callers get key names and a digest.

use std::path::{Path, PathBuf};

use intely_core::EngineError;
use sha2::{Digest, Sha256};

use crate::fsio::{read_small, read_small_string, CONFIG_CAP, HEAD_CAP};
use crate::types::{codes, PickedRemote};

pub enum Shape {
    Repo { git_dir: PathBuf },
    Worktree { git_dir: PathBuf, commondir: Option<PathBuf> },
    Submodule { git_dir: PathBuf },
    /// A `.git` file pointing somewhere that is neither `worktrees/` nor `modules/`.
    Redirect { git_dir: PathBuf, target: String },
    Bare,
    NotGit,
}

pub struct Found {
    pub shape: Shape,
    pub git_symlink: bool,
}

fn unreadable(what: &str) -> EngineError {
    EngineError::new(codes::IO, format!("unreadable: {what}"))
}

fn is_regular(path: &Path) -> bool {
    std::fs::symlink_metadata(path).map(|m| m.is_file()).unwrap_or(false)
}

/// Whether `path` exists as anything (no open, so a FIFO cannot block).
fn exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// Classifies `dir` (a canonical directory) by looking at `.git`. A `HEAD` that exists but is not a regular file (FIFO,
/// device, link) is an error: the folder is hostile or broken and is never opened.
pub fn shape_of(dir: &Path) -> Result<Found, EngineError> {
    let dot_git = dir.join(".git");
    match std::fs::symlink_metadata(&dot_git) {
        Ok(link_md) => {
            let git_symlink = link_md.file_type().is_symlink();
            let md = std::fs::metadata(&dot_git).map_err(|_| unreadable(".git"))?;
            if md.is_dir() {
                let head = dot_git.join("HEAD");
                if !exists(&head) {
                    return Ok(Found { shape: Shape::NotGit, git_symlink });
                }
                if !is_regular(&head) {
                    return Err(unreadable("HEAD"));
                }
                return Ok(Found { shape: Shape::Repo { git_dir: dot_git }, git_symlink });
            }
            if !md.is_file() {
                return Err(unreadable(".git"));
            }
            let text = read_small_string(&dot_git, HEAD_CAP).map_err(|_| unreadable(".git"))?;
            let Some(raw) = text.lines().next().and_then(|l| l.strip_prefix("gitdir:")) else {
                return Ok(Found { shape: Shape::NotGit, git_symlink });
            };
            let raw = raw.trim();
            let target_path = if Path::new(raw).is_absolute() { PathBuf::from(raw) } else { dir.join(raw) };
            let Ok(git_dir) = std::fs::canonicalize(&target_path) else {
                return Ok(Found { shape: Shape::NotGit, git_symlink });
            };
            if !exists(&git_dir.join("HEAD")) {
                return Ok(Found { shape: Shape::NotGit, git_symlink });
            }
            let shown = git_dir.to_string_lossy().into_owned();
            let shape = if shown.contains("/worktrees/") {
                Shape::Worktree { commondir: read_commondir(&git_dir), git_dir }
            } else if shown.contains("/modules/") {
                Shape::Submodule { git_dir }
            } else {
                Shape::Redirect { git_dir, target: shown }
            };
            Ok(Found { shape, git_symlink })
        }
        // A folder that cannot be searched says nothing about Git: not "not a repository", but "access denied" (macOS
        // privacy prompts and chmod 000 land here).
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Err(EngineError::new(codes::PERMISSION_DENIED, "access was denied")),
        Err(_) => {
            let bare = is_regular(&dir.join("HEAD")) && dir.join("objects").is_dir() && dir.join("refs").is_dir();
            Ok(Found { shape: if bare { Shape::Bare } else { Shape::NotGit }, git_symlink: false })
        }
    }
}

fn read_commondir(git_dir: &Path) -> Option<PathBuf> {
    let text = read_small_string(&git_dir.join("commondir"), HEAD_CAP).ok()?;
    let line = text.lines().next()?.trim();
    if line.is_empty() {
        return None;
    }
    let p = if Path::new(line).is_absolute() { PathBuf::from(line) } else { git_dir.join(line) };
    std::fs::canonicalize(p).ok()
}

/// `(branch, detached)` from `<git_dir>/HEAD`; no git process.
pub fn read_head(git_dir: &Path) -> Result<(Option<String>, bool), EngineError> {
    let bytes = read_small(&git_dir.join("HEAD"), HEAD_CAP).map_err(|_| unreadable("HEAD"))?;
    let text = String::from_utf8_lossy(&bytes);
    let line = text.lines().next().unwrap_or("").trim();
    if let Some(r) = line.strip_prefix("ref:") {
        let r = r.trim();
        return Ok((r.strip_prefix("refs/heads/").map(str::to_owned), false));
    }
    let hex = line.len() == 40 || line.len() == 64;
    Ok((None, hex && line.bytes().all(|b| b.is_ascii_hexdigit())))
}

// ---------------------------------------------------------------------------------------------------------------------
// config

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IniEntry {
    pub section: String,
    pub sub: Option<String>,
    pub key: String,
    /// `None`: the key has no `=` (git reads that as boolean true).
    pub value: Option<String>,
}

/// A small git-config reader: sections, subsections (`[a "B"]` and legacy `[a.b]`), case-insensitive section and key
/// names, `#`/`;` comments, quoted values, backslash continuation lines and `[s] key = v` on one line.
pub fn parse_ini(text: &str) -> Vec<IniEntry> {
    let mut lines: Vec<String> = Vec::new();
    let mut carry = String::new();
    for raw in text.lines() {
        let trailing = raw.bytes().rev().take_while(|b| *b == b'\\').count();
        if trailing % 2 == 1 {
            carry.push_str(&raw[..raw.len() - 1]);
            continue;
        }
        carry.push_str(raw);
        lines.push(std::mem::take(&mut carry));
    }
    if !carry.is_empty() {
        lines.push(carry);
    }
    let mut out = Vec::new();
    let mut section = String::new();
    let mut sub: Option<String> = None;
    for line in lines {
        let mut rest = line.trim();
        if rest.is_empty() || rest.starts_with('#') || rest.starts_with(';') {
            continue;
        }
        if let Some(after) = rest.strip_prefix('[') {
            let Some(end) = after.find(']') else { continue };
            let head = &after[..end];
            if let Some((name, quoted)) = head.split_once(char::is_whitespace) {
                section = name.trim().to_ascii_lowercase();
                let q = quoted.trim().trim_matches('"');
                sub = Some(q.replace("\\\"", "\"").replace("\\\\", "\\"));
            } else if let Some((name, legacy)) = head.split_once('.') {
                section = name.to_ascii_lowercase();
                sub = Some(legacy.to_ascii_lowercase());
            } else {
                section = head.trim().to_ascii_lowercase();
                sub = None;
            }
            rest = after[end + 1..].trim();
            if rest.is_empty() || rest.starts_with('#') || rest.starts_with(';') {
                continue;
            }
        }
        if section.is_empty() {
            continue;
        }
        let (key, value) = match rest.split_once('=') {
            Some((k, v)) => (k.trim(), Some(clean_value(v))),
            None => (strip_comment(rest).trim(), None),
        };
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            continue;
        }
        out.push(IniEntry { section: section.clone(), sub: sub.clone(), key: key.to_ascii_lowercase(), value });
    }
    out
}

fn strip_comment(s: &str) -> &str {
    let mut quoted = false;
    for (i, c) in s.char_indices() {
        match c {
            '"' => quoted = !quoted,
            '#' | ';' if !quoted => return &s[..i],
            _ => {}
        }
    }
    s
}

fn clean_value(v: &str) -> String {
    let v = strip_comment(v).trim();
    let mut out = String::new();
    let mut chars = v.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => {}
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(o) => out.push(o),
                None => {}
            },
            o => out.push(o),
        }
    }
    out
}

fn is_bool_text(v: &Option<String>) -> bool {
    match v {
        None => true,
        Some(s) => matches!(s.trim().to_ascii_lowercase().as_str(), "" | "true" | "false" | "yes" | "no" | "on" | "off" | "1" | "0"),
    }
}

fn is_true_text(v: &Option<String>) -> bool {
    match v {
        None => true,
        Some(s) => matches!(s.trim().to_ascii_lowercase().as_str(), "" | "true" | "yes" | "on" | "1"),
    }
}

/// The reported (generalised) name when this entry can start a program or redirect git, else `None`.
pub fn risk_name(e: &IniEntry) -> Option<String> {
    let k = e.key.as_str();
    let v = &e.value;
    let sub = e.sub.is_some();
    let name = match (e.section.as_str(), sub, k) {
        ("core", false, "fsmonitor") if !is_bool_text(v) => "core.fsmonitor".to_owned(),
        ("core", false, "sshcommand" | "hookspath" | "pager" | "editor" | "askpass" | "gitproxy" | "worktree" | "attributesfile") => {
            format!("core.{k}")
        }
        ("core", false, "bare") if is_true_text(v) => "core.bare".to_owned(),
        ("credential", false, "helper") => "credential.helper".to_owned(),
        ("credential", true, "helper") => "credential.*.helper".to_owned(),
        ("filter", true, "clean" | "smudge" | "process") => format!("filter.*.{k}"),
        ("diff", true, "textconv" | "command") => format!("diff.*.{k}"),
        ("diff", false, "external") => "diff.external".to_owned(),
        ("merge", true, "driver") => "merge.*.driver".to_owned(),
        ("alias", false, _) if v.as_deref().is_some_and(|s| s.trim_start().starts_with('!')) => format!("alias.{k}"),
        ("uploadpack", false, "packobjectshook") => "uploadpack.packObjectsHook".to_owned(),
        ("gpg", false, "program") => "gpg.program".to_owned(),
        ("gpg", true, "program") => "gpg.*.program".to_owned(),
        ("include", false, "path") => "include.path".to_owned(),
        ("includeif", true, "path") => "includeIf.*.path".to_owned(),
        ("extensions", _, _) => format!("extensions.{k}"),
        ("url", true, "insteadof" | "pushinsteadof") => format!("url.*.{k}"),
        ("http", false, _) => format!("http.{k}"),
        ("http", true, _) => format!("http.*.{k}"),
        ("remote", true, "proxy" | "vcs") => format!("remote.*.{k}"),
        _ => return None,
    };
    Some(name)
}

/// Host of a remote URL, credentials and path stripped. Local paths report `local`.
pub fn host_of(url: &str) -> String {
    let u = url.trim();
    let hostport = if let Some((_, rest)) = u.split_once("://") {
        let auth = rest.split('/').next().unwrap_or("");
        auth.rsplit('@').next().unwrap_or("").to_owned()
    } else if let Some((before, _)) = u.split_once(':').filter(|(b, _)| !b.contains('/') && !b.is_empty()) {
        before.rsplit('@').next().unwrap_or("").to_owned()
    } else {
        String::new()
    };
    let host = strip_port(&hostport);
    if host.is_empty() {
        "local".to_owned()
    } else {
        host
    }
}

fn strip_port(hp: &str) -> String {
    if let Some(rest) = hp.strip_prefix('[') {
        return rest.split(']').next().unwrap_or("").to_owned();
    }
    match hp.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => h.to_owned(),
        _ => hp.to_owned(),
    }
}

pub struct RiskScan {
    /// Sorted, de-duplicated key names (never values).
    pub keys: Vec<String>,
    /// sha256 over the sorted `fullkey=value` lines that produced `keys` (values go in, never out).
    pub digest: String,
    pub remotes: Vec<PickedRemote>,
}

/// Scans `<config_dir>/config`, the hooks directory and the root `.gitattributes`. A missing config is empty; a config
/// that exists but is not a regular file is an error (never opened).
pub fn scan_risks(work_dir: Option<&Path>, git_dir: &Path, config_dir: Option<&Path>) -> Result<RiskScan, EngineError> {
    let mut keys: Vec<String> = Vec::new();
    let mut digest_lines: Vec<String> = Vec::new();
    let mut remotes = Vec::new();
    let mut hooks_path: Option<String> = None;
    if let Some(cfg_dir) = config_dir {
        let cfg = cfg_dir.join("config");
        match read_small(&cfg, CONFIG_CAP) {
            Ok(bytes) => {
                for e in parse_ini(&String::from_utf8_lossy(&bytes)) {
                    if let Some(name) = risk_name(&e) {
                        let full = match &e.sub {
                            Some(s) => format!("{}.{}.{}", e.section, s, e.key),
                            None => format!("{}.{}", e.section, e.key),
                        };
                        digest_lines.push(format!("{full}={}", e.value.clone().unwrap_or_default()));
                        if name == "core.hookspath" {
                            hooks_path = e.value.clone();
                        }
                        keys.push(name);
                    }
                    if e.section == "core" && e.key == "hookspath" {
                        hooks_path = e.value.clone();
                    }
                    if e.section == "remote" && e.key == "url" {
                        if let (Some(name), Some(url)) = (e.sub.as_ref(), e.value.as_ref()) {
                            remotes.push(PickedRemote { name: name.clone(), host: host_of(url) });
                        }
                    }
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(unreadable("config")),
        }
    }
    // Executable hooks run on the user's own commit and push; report them by name.
    let hooks_dir = match (&hooks_path, work_dir) {
        (Some(p), Some(w)) if !p.is_empty() => {
            let p = Path::new(p);
            if p.is_absolute() {
                p.to_path_buf()
            } else {
                w.join(p)
            }
        }
        _ => config_dir.unwrap_or(git_dir).join("hooks"),
    };
    if let Ok(rd) = std::fs::read_dir(&hooks_dir) {
        use std::os::unix::fs::PermissionsExt;
        for item in rd.flatten().take(200) {
            let Ok(name) = item.file_name().into_string() else { continue };
            if name.ends_with(".sample") {
                continue;
            }
            if let Ok(md) = std::fs::symlink_metadata(item.path()) {
                if (md.is_file() || md.file_type().is_symlink()) && md.permissions().mode() & 0o111 != 0 {
                    digest_lines.push(format!("hook:{name}={}", md.len()));
                    keys.push(format!("hook:{name}"));
                }
            }
        }
    }
    // `filter=` in .gitattributes makes git run a configured filter during `git status`.
    let mut attr_files = vec![git_dir.join("info/attributes")];
    if let Some(w) = work_dir {
        attr_files.push(w.join(".gitattributes"));
    }
    for f in attr_files {
        if let Ok(text) = read_small_string(&f, CONFIG_CAP) {
            if text.lines().any(has_filter_attr) {
                keys.push("gitattributes.filter".to_owned());
                digest_lines.push("gitattributes.filter=1".to_owned());
                break;
            }
        }
    }
    keys.sort();
    keys.dedup();
    digest_lines.sort();
    let mut h = Sha256::new();
    for l in &digest_lines {
        h.update(l.as_bytes());
        h.update(b"\n");
    }
    let digest = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    Ok(RiskScan { keys, digest, remotes })
}

fn has_filter_attr(line: &str) -> bool {
    let line = line.trim();
    if line.starts_with('#') {
        return false;
    }
    line.split_whitespace().skip(1).any(|t| t.starts_with("filter=") && t.len() > "filter=".len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sections_continuations_and_comments() {
        let text = "[core]\n\tbare = false\n\tfsmonitor = /tmp/x \\\n y # c\n[remote \"origin\"]\n url = https://u:p@host.example:8443/a/b.git\n[Alias]\n\tst = !echo hi\n";
        let e = parse_ini(text);
        assert!(e.iter().any(|x| x.section == "core" && x.key == "fsmonitor" && x.value.as_deref() == Some("/tmp/x  y")));
        assert!(e.iter().any(|x| x.section == "alias" && x.key == "st"));
        assert_eq!(host_of("https://u:p@host.example:8443/a/b.git"), "host.example");
        assert_eq!(host_of("git@github.com:org/repo.git"), "github.com");
        assert_eq!(host_of("ssh://git@host:22/x"), "host");
        assert_eq!(host_of("/srv/git/repo"), "local");
    }

    #[test]
    fn boolean_fsmonitor_is_not_a_risk_but_a_program_is() {
        let e = parse_ini("[core]\nfsmonitor = true\n");
        assert!(risk_name(&e[0]).is_none());
        let e = parse_ini("[core]\nfsmonitor = /tmp/hook.sh\n");
        assert_eq!(risk_name(&e[0]).as_deref(), Some("core.fsmonitor"));
        let e = parse_ini("[core]\nbare = false\n");
        assert!(risk_name(&e[0]).is_none());
    }
}
