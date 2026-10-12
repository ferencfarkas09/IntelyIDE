//! Where a local repository lives on a server: the mapping in `ServerCfg::repo_paths`, the default `<root>/<folder name>`, and the
//! search for repositories on the server (one bounded, read-only ssh command).

use crate::cfg::{canonical_path, valid_repo_dir_name, validate_repo_path, ServerCfg};
use crate::quote::{sh_quote, sh_quote_path_for_remote};
use crate::repos::{normalize_origin, same_origin};
use crate::ssh::{Ssh, SshError};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// The key of a repository in `repoPaths`: its normalized origin (`origin:owner/repo`; the host is left out like in
/// [`same_origin`]), or, for a repository without an origin, its folder name on this Mac (`dir:name`).
pub fn repo_key(origin: Option<&str>, folder: &str) -> String {
    match origin.map(normalize_origin).filter(|n| !n.is_empty()) {
        Some(n) => format!("origin:{n}"),
        None => format!("dir:{folder}"),
    }
}

/// `<root>/<name>` with the root written as in the settings (`~`, `~/x` or absolute); `None` for a name that may not be used.
pub fn default_path(root: &str, name: &str) -> Option<String> {
    if !valid_repo_dir_name(name) {
        return None;
    }
    let base = root.trim_end_matches('/');
    Some(format!("{base}/{name}"))
}

/// The folder of one repository on a server, and where it came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPath {
    /// `~/...` or absolute.
    pub path: String,
    /// It comes from `repoPaths`.
    pub mapped: bool,
    /// The key it was (or would be) saved under.
    pub key: String,
}

/// Explicit mapping first (by origin, then by folder name), then `<root>/<folder>`. `None` when nothing is mapped and the folder name
/// cannot be put under the root.
pub fn resolve_repo_path(cfg: &ServerCfg, origin: Option<&str>, folder: &str) -> Option<ResolvedPath> {
    let key = repo_key(origin, folder);
    let dir_key = format!("dir:{folder}");
    if let Some(p) = cfg.repo_paths.get(&key).or_else(|| cfg.repo_paths.get(&dir_key)) {
        return Some(ResolvedPath { path: canonical_path(p), mapped: true, key });
    }
    Some(ResolvedPath { path: default_path(&cfg.root, folder)?, mapped: false, key })
}

/// A path as an absolute one: `~` is `home`; `.` components, `//` and a trailing `/` are removed (text only, links are not followed).
pub fn expand_home(path: &str, home: &str) -> String {
    let home = canonical_path(home);
    let p = canonical_path(path);
    if p == "~" {
        home
    } else if let Some(rest) = p.strip_prefix("~/") {
        canonical_path(&format!("{home}/{rest}"))
    } else {
        p
    }
}

/// Are the two folders the same, or is one inside the other? (Both canonical and absolute.)
pub fn equal_or_nested(a: &str, b: &str) -> bool {
    let inside = |outer: &str, inner: &str| outer == "/" || inner == outer || inner.strip_prefix(outer).is_some_and(|r| r.starts_with('/'));
    inside(a, b) || inside(b, a)
}

/// A repository found on the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundRepo {
    /// Absolute folder.
    pub path: String,
    /// `remote.origin.url` there, credentials removed.
    pub origin: Option<String>,
}

/// How many folders one search reports, and how long it may run on the server.
const MAX_FOUND: usize = 300;
const SEARCH_SECS: u32 = 20;
/// The longest origin URL taken from a search, and the most output text read.
const MAX_ORIGIN: usize = 512;
const MAX_OUTPUT: usize = 256 * 1024;

fn search_script(root: &str) -> String {
    let bases = [sh_quote_path_for_remote(root), "\"$HOME\"".into(), "\"$HOME\"/projects".into(), "\"$HOME\"/src".into(), "\"$HOME\"/code".into(), "\"$HOME\"/repos".into(), "/var/www".into(), "/srv".into(), "/opt".into()];
    let inner = format!(
        r#"GIT_OPTIONAL_LOCKS=0; export GIT_OPTIONAL_LOCKS
for base in {bases}; do
  [ -d "$base" ] || continue
  find "$base" -maxdepth 4 \( -name node_modules -o -name .cache -o -name vendor -o -name target \) -prune -o -name .git -prune -print 2>/dev/null
done | grep '^/.*/\.git$' | awk '!seen[$0]++' | head -n {max} | while IFS= read -r g; do
  case "$g" in *[[:cntrl:]]*) continue;; esac
  d=${{g%/.git}}
  printf 'path=%s\n' "$d"
  printf 'origin=%s\n' "$(git -C "$d" config --get remote.origin.url </dev/null 2>/dev/null | head -n 1)"
done
"#,
        bases = bases.join(" "),
        max = MAX_FOUND
    );
    // `timeout` is not on every machine (macOS has none): without it only the depth and the count bound the search
    format!("if command -v timeout >/dev/null 2>&1; then exec timeout {SEARCH_SECS} sh -c {q}; else exec sh -c {q}; fi\n", q = sh_quote(&inner))
}

fn redact(u: &str) -> String {
    if let Some((scheme, rest)) = u.split_once("://") {
        let auth_end = rest.find('/').unwrap_or(rest.len());
        if let Some(at) = rest[..auth_end].rfind('@') {
            return format!("{scheme}://{}", &rest[at + 1..]);
        }
    }
    u.to_string()
}

fn parse_search(text: &str) -> Vec<FoundRepo> {
    let mut out: Vec<FoundRepo> = Vec::new();
    let mut read = 0usize;
    // false while the folder in front of an origin line was refused: that origin is skipped
    let mut live = false;
    for line in text.lines().map(|l| l.trim_end_matches('\r')) {
        read += line.len() + 1;
        if read > MAX_OUTPUT || out.len() >= MAX_FOUND {
            break;
        }
        if let Some(p) = line.strip_prefix("path=") {
            // only folders that could be saved as they are
            live = p.starts_with('/') && !p.chars().any(char::is_control) && canonical_path(p) == p && validate_repo_path(p).is_ok();
            if live {
                out.push(FoundRepo { path: p.to_string(), origin: None });
            }
        } else if let (Some(o), true) = (line.strip_prefix("origin="), live) {
            let o = o.trim();
            if o.chars().count() > MAX_ORIGIN {
                // a URL this long is not a repository's address; the folder is not offered
                out.pop();
                live = false;
            } else if !o.is_empty() && !o.chars().any(char::is_control) {
                if let Some(last) = out.last_mut() {
                    last.origin = Some(redact(o));
                }
            }
        }
    }
    out
}

/// Looks for git repositories on the server with ONE read-only command: the root folder, `~`, `~/projects`, `~/src`, `~/code`,
/// `~/repos`, `/var/www`, `/srv` and `/opt`, four levels deep, without `node_modules`, `.cache`, `vendor` and `target`, for at most
/// 20 seconds, at most 300 folders. Nothing is changed on the server and nothing is saved.
pub fn find_repos(ssh: &Ssh, cfg: &ServerCfg) -> Result<Vec<FoundRepo>, SshError> {
    cfg.validate().map_err(|e| SshError::invalid(e.to_string()))?;
    let out = ssh.exec(cfg, &search_script(&cfg.root), Duration::from_secs(u64::from(SEARCH_SECS) + 15))?;
    // (a search cut off by the time limit exits 124 and still reports what it found)
    if !out.success() && out.code != 124 {
        return Err(SshError::other(out.stderr));
    }
    Ok(parse_search(&out.stdout_text()))
}

/// A repository of this Mac to look for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wanted {
    pub id: String,
    pub folder: String,
    pub origin: Option<String>,
}

/// The folders that can be the repository: by origin; for one without an origin, a folder with the same name that has no origin either.
pub fn candidates_for(w: &Wanted, found: &[FoundRepo]) -> Vec<FoundRepo> {
    let mut v: Vec<FoundRepo> = match w.origin.as_deref().filter(|o| !normalize_origin(o).is_empty()) {
        Some(o) => found.iter().filter(|f| f.origin.as_deref().is_some_and(|fo| same_origin(o, fo))).cloned().collect(),
        None => found.iter().filter(|f| f.origin.is_none() && f.path.rsplit('/').next() == Some(w.folder.as_str())).cloned().collect(),
    };
    v.sort_by(|a, b| a.path.cmp(&b.path));
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::testkit::*;
    #[cfg_attr(not(unix), allow(unused_imports))]
    use std::collections::BTreeMap;
    use std::process::Command;

    #[cfg_attr(not(unix), allow(dead_code))]
    fn git(dir: &std::path::Path, args: &[&str]) {
        assert!(Command::new("git").arg("-C").arg(dir).args(args).status().unwrap().success(), "{args:?}");
    }

    #[test]
    fn keys_use_the_origin_and_fall_back_to_the_folder() {
        assert_eq!(repo_key(Some("git@git.example.com:Org/Orders-API.git"), "orders"), "origin:org/orders-api");
        assert_eq!(repo_key(Some("https://git.example.com/org/orders-api"), "x"), "origin:org/orders-api");
        assert_eq!(repo_key(None, "web-shop"), "dir:web-shop");
        assert_eq!(repo_key(Some("  "), "web-shop"), "dir:web-shop");
    }

    #[cfg(unix)]
    #[test]
    fn resolution_order_is_mapping_then_the_default() {
        let mut cfg = test_cfg();
        let o = Some("https://git.example.com/org/orders-api.git");
        let r = resolve_repo_path(&cfg, o, "orders-api").unwrap();
        assert_eq!((r.path.as_str(), r.mapped), ("~/work/orders-api", false));
        cfg.repo_paths = BTreeMap::from([("dir:orders-api".to_string(), "/srv/a".to_string())]);
        assert_eq!(resolve_repo_path(&cfg, None, "orders-api").unwrap().path, "/srv/a");
        // the origin key wins over the folder-name key
        cfg.repo_paths.insert("origin:org/orders-api".into(), "~/code/orders".into());
        let r = resolve_repo_path(&cfg, o, "orders-api").unwrap();
        assert_eq!((r.path.as_str(), r.mapped), ("~/code/orders", true));
        // a mapped repository does not need a usable folder name; an unmapped one does
        cfg.repo_paths = BTreeMap::from([("dir:.hidden".to_string(), "/srv/h".to_string())]);
        assert!(resolve_repo_path(&cfg, None, ".hidden").unwrap().mapped);
        assert!(resolve_repo_path(&cfg, None, ".other").is_none());
        let root = ServerCfg { root: "~".into(), ..test_cfg() };
        assert_eq!(resolve_repo_path(&root, None, "a").unwrap().path, "~/a");
    }

    #[test]
    fn folders_that_are_equal_or_nested_overlap() {
        for (a, b) in [("/srv/a", "/srv/a"), ("/srv/a", "/srv/a/b"), ("/srv/a/b", "/srv/a")] {
            assert!(equal_or_nested(a, b), "{a} {b}");
        }
        for (a, b) in [("/srv/a", "/srv/ab"), ("/srv/a", "/srv/b"), ("/srv/a/x", "/srv/a/y")] {
            assert!(!equal_or_nested(a, b), "{a} {b}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_mapped_path_is_cleaned_and_resolved_the_same_way() {
        let mut cfg = test_cfg();
        cfg.repo_paths = BTreeMap::from([("dir:a".to_string(), "~/code//./a/".to_string())]);
        assert_eq!(resolve_repo_path(&cfg, None, "a").unwrap().path, "~/code/a");
        assert_eq!(expand_home("~/code//./a/", "/home/me/"), "/home/me/code/a");
        assert_eq!(expand_home("/srv//x/./", "/home/me"), "/srv/x");
    }

    #[test]
    fn home_is_expanded() {
        assert_eq!(expand_home("~", "/home/me/"), "/home/me");
        assert_eq!(expand_home("~/code/x/", "/home/me"), "/home/me/code/x");
        assert_eq!(expand_home("/srv/x/", "/home/me"), "/srv/x");
    }

    #[test]
    fn matching_by_origin_or_by_name() {
        let found = vec![
            FoundRepo { path: "/home/me/a/orders-api".into(), origin: Some("git@git.example.com:org/orders-api.git".into()) },
            FoundRepo { path: "/srv/orders-api".into(), origin: Some("https://git.example.com/org/orders-api".into()) },
            FoundRepo { path: "/home/me/web-shop".into(), origin: None },
            FoundRepo { path: "/home/me/fork".into(), origin: Some("https://git.example.com/other/orders-api".into()) },
        ];
        let w = |o: Option<&str>, f: &str| Wanted { id: "r".into(), folder: f.into(), origin: o.map(Into::into) };
        let c = candidates_for(&w(Some("https://git.example.com/org/orders-api.git"), "x"), &found);
        assert_eq!(c.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["/home/me/a/orders-api", "/srv/orders-api"]);
        assert_eq!(candidates_for(&w(None, "web-shop"), &found).len(), 1);
        assert!(candidates_for(&w(None, "orders-api"), &found).is_empty());
        assert!(candidates_for(&w(Some("https://git.example.com/org/none"), "none"), &found).is_empty());
    }

    #[test]
    fn the_search_script_quotes_the_root() {
        let s = search_script("~/my work's");
        // the whole search is one quoted word for `sh -c`, so the root is inside it with its own quoting
        assert!(s.contains("sh -c '") && s.contains("maxdepth 4") && s.contains("-name node_modules"));
        assert!(s.contains(r#""$HOME"/'"#));
    }

    #[cfg(unix)]
    #[test]
    fn finds_repositories_on_the_fake_server() {
        let f = Fake::new();
        let mk = |rel: &str, origin: Option<&str>| {
            let d = f.home.join(rel);
            std::fs::create_dir_all(&d).unwrap();
            git(&d, &["init", "-q", "-b", "main"]);
            if let Some(o) = origin {
                git(&d, &["remote", "add", "origin", o]);
            }
        };
        mk("code/orders api", Some("git@git.example.com:org/orders-api.git"));
        mk("work/web-shop", None);
        mk("projects/deep/er/web", Some(&format!("{}{}", "https://u:t", "@git.example.com/org/web.git")));
        mk("code/node_modules/dep", Some("https://git.example.com/x/dep"));
        mk("a/b/c/d/e/too-deep", None);
        let found = find_repos(&f.ssh, &f.cfg).unwrap();
        let by = |p: &str| found.iter().find(|r| r.path == f.home.join(p).to_str().unwrap()).cloned();
        assert_eq!(by("code/orders api").unwrap().origin.as_deref(), Some("git@git.example.com:org/orders-api.git"));
        assert!(by("work/web-shop").unwrap().origin.is_none());
        assert_eq!(by("projects/deep/er/web").unwrap().origin.as_deref(), Some("https://git.example.com/org/web.git"));
        assert!(by("code/node_modules/dep").is_none() && by("a/b/c/d/e/too-deep").is_none());
        // nothing is created or changed by a search
        assert!(!f.home.join("work/web-shop/.git/ide-index").exists());
    }

    #[test]
    fn a_hostile_folder_name_cannot_forge_a_result() {
        let found = parse_search("path=/ok/a\norigin=https://h/o/r\npath=relative\norigin=x\npath=/bad\u{1}x\norigin=y\npath=/\npath=/srv\npath=/etc/x\npath=/a//b\norigin=z\n");
        assert_eq!(found, vec![FoundRepo { path: "/ok/a".into(), origin: Some("https://h/o/r".into()) }]);
    }

    #[test]
    fn long_origins_and_long_output_are_capped() {
        let long = "x".repeat(MAX_ORIGIN + 1);
        let found = parse_search(&format!("path=/ok/a\norigin={long}\npath=/ok/b\norigin={}\n", "y".repeat(MAX_ORIGIN)));
        assert_eq!(found.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["/ok/b"]);
        let many: String = (0..MAX_FOUND + 50).map(|i| format!("path=/srv/r/{i}\n")).collect();
        assert_eq!(parse_search(&many).len(), MAX_FOUND);
        let big = format!("{}path=/ok/late\n", "origin=z\n".repeat(MAX_OUTPUT / 4));
        assert!(parse_search(&big).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn the_search_script_skips_folders_with_control_characters() {
        let f = Fake::new();
        let weird = f.home.join("code/a\tb");
        std::fs::create_dir_all(&weird).unwrap();
        git(&weird, &["init", "-q", "-b", "main"]);
        let fine = f.home.join("code/fine");
        std::fs::create_dir_all(&fine).unwrap();
        git(&fine, &["init", "-q", "-b", "main"]);
        let found = find_repos(&f.ssh, &f.cfg).unwrap();
        assert!(found.iter().any(|r| r.path.ends_with("code/fine")));
        assert!(!found.iter().any(|r| r.path.contains('\t')));
        assert!(search_script("~/w").contains("[[:cntrl:]]"));
    }
}
