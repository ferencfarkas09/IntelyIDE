//! Repositories on the server, at `<root>/<name>` or at the folder mapped for them (`ServerCfg::repo_paths`): state check and clone.

use crate::cfg::{valid_repo_dir_name, validate_repo_path, ServerCfg};
use crate::paths::default_path;
use crate::quote::{sh_quote, sh_quote_path_for_remote};
use crate::ssh::{tail, Ssh, SshError};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// What is at the folder of a repository on the server.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    /// Repository directory name.
    pub name: String,
    /// Full path on the server (`~/...` or absolute, as configured).
    pub path: String,
    /// The path comes from the server's `repoPaths`, not from `<root>/<name>`.
    #[serde(default)]
    pub mapped: bool,
    /// The directory exists.
    pub exists: bool,
    /// Where `path` really is (links followed, `cd -P; pwd -P`); `None` when it does not exist or the server did not say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub physical: Option<String>,
    /// It has a `.git`.
    pub is_git: bool,
    /// Current branch (or a short commit id when detached).
    pub branch: Option<String>,
    /// Uncommitted changes.
    pub dirty: Option<bool>,
    /// URL of `origin`, with any credentials removed.
    pub origin: Option<String>,
}

fn invalid(m: &str) -> SshError {
    SshError::invalid(m.to_string())
}

/// Removes the credentials in front of the host of a URL.
fn redact_url(u: &str) -> String {
    if let Some((scheme, rest)) = u.split_once("://") {
        let (auth_end, _) = rest.split_once('/').map_or((rest.len(), ""), |(a, _)| (a.len(), ""));
        if let Some(at) = rest[..auth_end].rfind('@') {
            return format!("{scheme}://{}", &rest[at + 1..]);
        }
    }
    u.to_string()
}

/// Which repository a git URL names, apart from where it is reached: the path (`owner/repo`) without the scheme, the user name, the host
/// and the port, without a trailing `.git` or `/`, and in lower case. The host is left out on purpose. An alias from `~/.ssh/config`
/// (`git@gh-work:org/repo`), another port of the same service (`ssh.example.com:443`) and the plain address are one place that this
/// program cannot tell apart, and refusing a run for the spelling of an address is worse than accepting two hosts that happen to serve
/// the same `owner/repo`. A fork has another owner, a different project another path: those are told apart.
pub(crate) fn normalize_origin(url: &str) -> String {
    let u = url.trim();
    let path = if let Some((_, rest)) = u.split_once("://") {
        // the scheme, then optionally credentials, the host, optionally a port, and the path
        rest.split_once('/').map_or("", |(_, path)| path)
    } else {
        match u.split_once(':') {
            // scp style, [user@]host:path (a colon after a slash is part of a path)
            Some((host, path)) if !host.contains('/') => path,
            _ => u,
        }
    };
    let path = path.trim_matches('/');
    path.strip_suffix(".git").unwrap_or(path).trim_matches('/').to_ascii_lowercase()
}

/// Do these two `origin` URLs name the same repository?
pub fn same_origin(a: &str, b: &str) -> bool {
    let (a, b) = (normalize_origin(a), normalize_origin(b));
    !a.is_empty() && a == b
}

/// One repository to look at: its display name and its folder on the server (`~/...` or absolute).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoSpec {
    pub name: String,
    pub path: String,
    pub mapped: bool,
}

impl RepoSpec {
    /// The default place, `<root>/<name>`; `None` for a name that may not be put on the server's disk.
    pub fn at_root(cfg: &ServerCfg, name: &str) -> Option<Self> {
        Some(Self { name: name.to_string(), path: default_path(&cfg.root, name)?, mapped: false })
    }
}

fn states_script(specs: &[RepoSpec]) -> String {
    let mut calls = String::new();
    for (i, s) in specs.iter().enumerate() {
        calls.push_str(&format!("check {i} {}\n", sh_quote_path_for_remote(&s.path)));
    }
    format!(
        r#"GIT_OPTIONAL_LOCKS=0; export GIT_OPTIONAL_LOCKS
check() {{
  printf 'repo=%s\n' "$1"
  d="$2"
  if [ -d "$d" ]; then
    printf 'exists=yes\n'
    p=$(cd -P -- "$d" 2>/dev/null && pwd -P)
    case "$p" in *[[:cntrl:]]*) p=;; esac
    printf 'physical=%s\n' "$p"
    if [ -e "$d/.git" ]; then
      printf 'git=yes\n'
      b=$(git -c core.fsmonitor=false -C "$d" symbolic-ref --short -q HEAD </dev/null 2>/dev/null || git -C "$d" rev-parse --short HEAD </dev/null 2>/dev/null)
      printf 'branch=%s\n' "$b"
      if [ -n "$(git -c core.fsmonitor=false -C "$d" status --porcelain </dev/null 2>/dev/null | head -n 1)" ]; then printf 'dirty=yes\n'; else printf 'dirty=no\n'; fi
      printf 'origin=%s\n' "$(git -C "$d" remote get-url origin </dev/null 2>/dev/null | head -n 1)"
    fi
  fi
}}
{calls}"#
    )
}

fn blank(s: &RepoSpec) -> RepoState {
    RepoState { name: s.name.clone(), path: s.path.clone(), mapped: s.mapped, ..RepoState::default() }
}

fn parse_states(specs: &[RepoSpec], text: &str) -> Vec<RepoState> {
    let mut out: Vec<Option<RepoState>> = vec![None; specs.len()];
    let mut cur: Option<usize> = None;
    for line in text.lines().map(|l| l.trim_end_matches('\r')) {
        let Some((k, v)) = line.split_once('=') else { continue };
        if k == "repo" {
            cur = v.trim().parse::<usize>().ok().filter(|i| *i < specs.len());
            if let Some(i) = cur {
                out[i] = Some(blank(&specs[i]));
            }
            continue;
        }
        let Some(cur) = cur.and_then(|i| out[i].as_mut()) else { continue };
        let v = v.trim();
        match k {
            "exists" => cur.exists = v == "yes",
            "physical" => cur.physical = (v.starts_with('/') && !v.chars().any(char::is_control)).then(|| v.to_string()),
            "git" => cur.is_git = v == "yes",
            "branch" => cur.branch = (!v.is_empty()).then(|| v.to_string()),
            "dirty" => cur.dirty = Some(v == "yes"),
            "origin" => cur.origin = (!v.is_empty()).then(|| redact_url(v)),
            _ => {}
        }
    }
    // Repositories the script did not answer for are reported as missing.
    out.into_iter().zip(specs).map(|(o, s)| o.unwrap_or_else(|| blank(s))).collect()
}

fn check_spec(s: &RepoSpec) -> Result<(), SshError> {
    if s.name.is_empty() || s.name.chars().any(char::is_control) {
        return Err(invalid("repository name"));
    }
    validate_repo_path(&s.path).map_err(|e| SshError::invalid(format!("repository folder: {}", e.reason)))
}

/// State of each repository at its folder on the server, with one ssh call. Every folder is validated and quoted for the shell.
pub fn repo_states_at(ssh: &Ssh, cfg: &ServerCfg, specs: &[RepoSpec]) -> Result<Vec<RepoState>, SshError> {
    cfg.validate().map_err(|e| SshError::invalid(e.to_string()))?;
    for s in specs {
        check_spec(s)?;
    }
    if specs.is_empty() {
        return Ok(Vec::new());
    }
    let out = ssh.exec(cfg, &states_script(specs), Duration::from_secs(90))?;
    if !out.success() {
        return Err(SshError::other(out.stderr));
    }
    Ok(parse_states(specs, &out.stdout_text()))
}

/// State of each repo under the server's root (`<root>/<name>`), with one ssh call. Names must match `[A-Za-z0-9._-]{1,100}`, not
/// start with `-` or `.`.
pub fn repo_states(ssh: &Ssh, cfg: &ServerCfg, names: &[String]) -> Result<Vec<RepoState>, SshError> {
    cfg.validate().map_err(|e| SshError::invalid(e.to_string()))?;
    let specs: Option<Vec<RepoSpec>> = names.iter().map(|n| if valid_repo_dir_name(n) { RepoSpec::at_root(cfg, n) } else { None }).collect();
    repo_states_at(ssh, cfg, &specs.ok_or_else(|| invalid("repository name"))?)
}

/// Clones `url` into `<root>/<name>` on the server, with the server's own git credentials.
pub fn clone_repo(ssh: &Ssh, cfg: &ServerCfg, name: &str, url: &str) -> Result<(), SshError> {
    cfg.validate().map_err(|e| SshError::invalid(e.to_string()))?;
    if !valid_repo_dir_name(name) {
        return Err(invalid("repository name"));
    }
    let dest = default_path(&cfg.root, name).ok_or_else(|| invalid("repository name"))?;
    clone_repo_at(ssh, cfg, name, &dest, url)
}

/// Clones `url` into the folder `dest` (`~/...` or absolute; its parent is created) on the server. `label` names it in messages.
pub fn clone_repo_at(ssh: &Ssh, cfg: &ServerCfg, label: &str, dest: &str, url: &str) -> Result<(), SshError> {
    cfg.validate().map_err(|e| SshError::invalid(e.to_string()))?;
    validate_repo_path(dest).map_err(|e| SshError::invalid(format!("repository folder: {}", e.reason)))?;
    validate_git_url(url).map_err(|m| invalid(&format!("git url: {m}")))?;
    let label: String = label.chars().filter(|c| c.is_ascii_alphanumeric() || "._- ".contains(*c)).collect();
    let script = format!(
        r#"set -eu
dest={dest}
mkdir -p -- "$(dirname -- "$dest")"
if [ -e "$dest" ]; then echo "{label} already exists on the server" >&2; exit 17; fi
GIT_TERMINAL_PROMPT=0; export GIT_TERMINAL_PROMPT
GIT_SSH_COMMAND='ssh -o BatchMode=yes'; export GIT_SSH_COMMAND
git clone -c protocol.ext.allow=never -c protocol.file.allow=never -- {url} "$dest" </dev/null
"#,
        dest = sh_quote_path_for_remote(dest),
        url = sh_quote(url),
    );
    let out = ssh.exec(cfg, &script, Duration::from_secs(900))?;
    if out.success() {
        Ok(())
    } else {
        Err(SshError::other(format!("git clone failed (exit {}): {}", out.code, tail(&out.stderr))))
    }
}

fn host_ok(h: &str) -> bool {
    let (host, port) = h.split_once(':').map_or((h, None), |(a, p)| (a, Some(p)));
    !host.is_empty()
        && host.len() <= 253
        && !host.starts_with(['.', '-'])
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && port.map_or(true, |p| !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()))
}

fn user_ok(u: &str) -> bool {
    !u.is_empty() && u.len() <= 64 && !u.starts_with('-') && u.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

fn path_ok(p: &str) -> bool {
    !p.is_empty()
        && p.split('/').all(|c| c != "..")
        && p.chars().all(|c| c.is_ascii_alphanumeric() || "._~/%+@:-".contains(c))
}

/// Accepts `https://host/path`, `ssh://[user@]host[:port]/path` and scp-like `user@host:path`. Everything else is
/// refused: `ext::`, `file:`, `git:`, `http:`, local paths, option-like values, whitespace, control chars, `..`, over 500 chars.
pub fn validate_git_url(url: &str) -> Result<(), &'static str> {
    if url.is_empty() || url.len() > 500 {
        return Err("must be 1..500 characters");
    }
    if url.starts_with('-') {
        return Err("must not start with '-'");
    }
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("must not contain whitespace or control characters");
    }
    if let Some(rest) = url.strip_prefix("https://") {
        let (host, path) = rest.split_once('/').ok_or("expected https://host/path")?;
        if !host_ok(host) || !path_ok(path) {
            return Err("invalid https url");
        }
        return Ok(());
    }
    if let Some(rest) = url.strip_prefix("ssh://") {
        let (auth, path) = rest.split_once('/').ok_or("expected ssh://host/path")?;
        let host = match auth.split_once('@') {
            Some((u, h)) if user_ok(u) => h,
            Some(_) => return Err("invalid ssh user"),
            None => auth,
        };
        if !host_ok(host) || !path_ok(path) {
            return Err("invalid ssh url");
        }
        return Ok(());
    }
    if url.contains("://") || url.contains("::") {
        return Err("only https://, ssh:// and user@host:path are allowed");
    }
    // scp-like: user@host:path
    let (userhost, path) = url.split_once(':').ok_or("only https://, ssh:// and user@host:path are allowed")?;
    let (u, h) = userhost.split_once('@').ok_or("only https://, ssh:// and user@host:path are allowed")?;
    if user_ok(u) && host_ok(h) && !h.contains(':') && path_ok(path) && !path.starts_with(':') {
        Ok(())
    } else {
        Err("invalid scp-like url")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::*;
    use std::process::Command;

    #[test]
    fn url_whitelist() {
        for u in [
            "https://git.example.com/owner/repo.git",
            "https://gitlab.example.com:8443/group/sub/repo",
            "ssh://git@git.example.com/owner/repo.git",
            "ssh://git@host:2222/srv/repo",
            "ssh://host/repo",
            "git@git.example.com:owner/repo.git",
            "dev@10.0.0.5:/srv/git/repo.git",
            "deploy.bot@git.example.org:team/x",
        ] {
            assert_eq!(validate_git_url(u), Ok(()), "{u}");
        }
    }

    #[test]
    fn url_blacklist() {
        let long = format!("https://h/{}", "a".repeat(500));
        for u in [
            "",
            "ext::sh -c 'touch /tmp/x'",
            "ext::sh",
            "file:///etc/passwd",
            "file:/etc",
            "/srv/git/repo",
            "./repo",
            "../repo",
            "~/repo",
            "repo",
            "-uevil",
            "--upload-pack=touch /tmp/x",
            "-oProxyCommand=x",
            "http://example.com/x.git",
            "git://example.com/x.git",
            "ftp://example.com/x",
            "https://",
            "https:///path",
            "https://host",
            concat!("https://user:", "pw@host/x"),
            "https://host/../x",
            "https://host/a b",
            "https://host/a\nb",
            "https://host/a\tb",
            "https://host/a;b",
            "https://host/$(id)",
            "https://host/`id`",
            "https://host/a'b",
            "https://ho st/x",
            "https://-host/x",
            "https://host:port/x",
            "ssh://-oProxyCommand=x/repo",
            "ssh://-u@host/x",
            "ssh://u s@host/x",
            "ssh://host",
            "git@host",
            "git@host:",
            "git@-host:x",
            "-git@host:x",
            "git@host:../x",
            "git@host::x",
            "@host:x",
            "git@:x",
            "a@b@c:x",
            "ext::x@y:z",
            "\u{202e}https://host/x",
            "https://hôst/x",
            &long,
        ] {
            assert!(validate_git_url(u).is_err(), "{u:?}");
        }
        assert!(validate_git_url(&format!("https://h/{}", "a".repeat(400))).is_ok());
    }

    #[test]
    fn redaction() {
        assert_eq!(redact_url(concat!("https://u:", "tok@git.example.com/a/b.git")), "https://git.example.com/a/b.git");
        assert_eq!(redact_url("https://git.example.com/a/b.git"), "https://git.example.com/a/b.git");
        assert_eq!(redact_url("git@git.example.com:a/b.git"), "git@git.example.com:a/b.git");
        assert_eq!(redact_url("https://host/a@b"), "https://host/a@b");
        assert_eq!(redact_url("ssh://git@host/x"), "ssh://host/x");
    }

    #[test]
    fn script_quotes_names_and_root() {
        let spec = |p: &str| RepoSpec { name: "x".into(), path: p.into(), mapped: true };
        let s = states_script(&[spec("~/my work/a"), spec("/srv/it's here/b")]);
        assert!(s.contains("check 0 \"$HOME\"/'my work/a'\n"));
        assert!(s.contains("check 1 '/srv/it'\\''s here/b'\n"));
    }

    fn git(dir: &std::path::Path, args: &[&str]) {
        let st = Command::new("git").arg("-C").arg(dir).args(args).status().unwrap();
        assert!(st.success(), "{args:?}");
    }

    #[test]
    fn two_spellings_of_one_origin_are_one_repository() {
        for (a, b) in [
            ("https://git.example.com/org/repo.git", "git@git.example.com:org/repo.git"),
            ("https://git.example.com/org/repo", "https://git.example.com/org/repo.git"),
            (concat!("https://user:", "token@git.example.com/org/repo.git"), "ssh://git@git.example.com/org/repo"),
            ("ssh://git@git.example.com:22/org/repo.git", "git.example.com:org/repo"),
            ("https://Git.Example.com/Org/Repo/", "git@git.example.com:org/repo.git"),
            ("git://example.com/o/r.git", "https://example.com/o/r"),
            // an alias of ~/.ssh/config and another port of the same service are the same repository
            ("git@gh-work:org/repo.git", "https://git.example.com/org/repo"),
            ("ssh://git@ssh.example.com:443/org/repo.git", "https://git.example.com/org/repo"),
            // a folder on a disk, spelled as a path and as a file URL
            ("/srv/git/app.git", "file:///srv/git/app"),
            // a project in a subgroup
            ("git@git.example.com:team/sub/app.git", "https://git.example.com/team/sub/app"),
        ] {
            assert!(same_origin(a, b), "{a} vs {b}");
            assert!(same_origin(b, a), "{b} vs {a}");
        }
        for (a, b) in [
            ("https://git.example.com/org/repo.git", "https://git.example.com/org/other.git"),
            // a fork has another owner
            ("https://git.example.com/org/repo.git", "https://git.example.com/fork/repo.git"),
            ("git@git.example.com:org/repo.git", "git@git.example.com:org/repo-two.git"),
            ("git@git.example.com:team/sub/app.git", "https://git.example.com/team/app"),
            ("https://git.example.com/org/repo.git", "https://git.example.com/"),
            ("", ""),
            ("   ", "https://git.example.com/"),
        ] {
            assert!(!same_origin(a, b), "{a} vs {b}");
        }
    }

    #[test]
    fn a_hidden_folder_is_not_a_repository_name() {
        let ssh = Ssh::from_bin(Some("/nonexistent/ssh".into()), std::path::PathBuf::new());
        let cfg = ServerCfg { id: "s".into(), name: "S".into(), destination: "dev@host".into(), port: None, root: "~".into(), max_agents: 1, enabled: true, repo_paths: Default::default() };
        assert!(repo_states(&ssh, &cfg, &[".ssh".to_string()]).is_err());
        assert!(clone_repo(&ssh, &cfg, ".aws", "https://example.com/o/r.git").is_err());
    }

    #[test]
    fn repo_states_on_the_fake_server() {
        let f = Fake::new();
        let root = f.home.join("work");
        std::fs::create_dir_all(root.join("plain")).unwrap();
        let clean = root.join("clean");
        std::fs::create_dir_all(&clean).unwrap();
        git(&clean, &["init", "-q", "-b", "main"]);
        git(&clean, &["remote", "add", "origin", concat!("https://user:", "secret@example.com/o/r.git")]);
        let dirty = root.join("dirty.repo");
        std::fs::create_dir_all(&dirty).unwrap();
        git(&dirty, &["init", "-q", "-b", "dev"]);
        std::fs::write(dirty.join("new.txt"), "x").unwrap();
        let names: Vec<String> = ["clean", "dirty.repo", "plain", "absent"].iter().map(|s| s.to_string()).collect();
        let st = repo_states(&f.ssh, &f.cfg, &names).unwrap();
        assert_eq!(st.len(), 4);
        let by = |n: &str| st.iter().find(|s| s.name == n).unwrap().clone();
        let c = by("clean");
        assert!(c.exists && c.is_git);
        assert_eq!(c.branch.as_deref(), Some("main"));
        assert_eq!(c.dirty, Some(false));
        assert_eq!(c.origin.as_deref(), Some("https://example.com/o/r.git"));
        assert_eq!(c.path, "~/work/clean");
        let d = by("dirty.repo");
        assert_eq!((d.branch.as_deref(), d.dirty, d.origin.clone()), (Some("dev"), Some(true), None));
        let p = by("plain");
        assert!(p.exists && !p.is_git && p.branch.is_none() && p.dirty.is_none());
        let a = by("absent");
        assert!(!a.exists && !a.is_git);
    }

    #[test]
    fn repo_states_validates_names_and_handles_empty() {
        let f = Fake::new();
        assert_eq!(repo_states(&f.ssh, &f.cfg, &[]).unwrap(), vec![]);
        for bad in ["", ".", "..", "-x", "a/b", "a b", "a;b", "$(id)", "a\n", "'"] {
            let e = repo_states(&f.ssh, &f.cfg, &[bad.to_string()]).unwrap_err();
            assert!(e.detail.contains("repository name"), "{bad:?}");
        }
        assert!(repo_states(&f.ssh, &f.cfg, &["ok".into(), "bad name".into()]).is_err());
    }

    #[test]
    fn repo_states_survive_hostile_repo_config() {
        // core.fsmonitor in the repo's own config must not run a command.
        let f = Fake::new();
        let r = f.home.join("work/evil");
        std::fs::create_dir_all(&r).unwrap();
        git(&r, &["init", "-q", "-b", "main"]);
        let marker = f.home.join("pwned");
        git(&r, &["config", "core.fsmonitor", &format!("touch {}; true", marker.display())]);
        let st = repo_states(&f.ssh, &f.cfg, &["evil".into()]).unwrap();
        assert!(st[0].is_git);
        assert!(!marker.exists());
    }

    #[test]
    fn clone_runs_git_with_the_protection_flags() {
        let f = Fake::new();
        f.stub(
            "git",
            "printf '%s\\n' \"$@\" > \"$HOME/git-args\"\nfor last; do :; done\nmkdir -p \"$last/.git\"",
        );
        clone_repo(&f.ssh, &f.cfg, "my-repo", "https://git.example.com/o/it's.git").unwrap_err();
        // the apostrophe is not in the whitelist
        assert!(!f.home.join("git-args").exists());
        clone_repo(&f.ssh, &f.cfg, "my-repo", "https://git.example.com/o/r.git").unwrap();
        let args: Vec<String> = std::fs::read_to_string(f.home.join("git-args")).unwrap().lines().map(String::from).collect();
        assert_eq!(args[..5], ["clone", "-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never"]);
        assert_eq!(args[5], "--");
        assert_eq!(args[6], "https://git.example.com/o/r.git");
        assert_eq!(args[7], f.home.join("work/my-repo").to_str().unwrap());
        assert!(f.home.join("work/my-repo/.git").is_dir());
    }

    #[test]
    fn clone_refuses_an_existing_directory_and_reports_git_errors() {
        let f = Fake::new();
        f.stub("git", "echo 'fatal: repository not found' >&2; exit 128");
        std::fs::create_dir_all(f.home.join("work/there")).unwrap();
        let e = clone_repo(&f.ssh, &f.cfg, "there", "https://h.example/x.git").unwrap_err();
        assert!(e.detail.contains("already exists"), "{e}");
        let e = clone_repo(&f.ssh, &f.cfg, "fresh", "https://h.example/x.git").unwrap_err();
        assert!(e.detail.contains("repository not found") && e.detail.contains("128"), "{e}");
    }

    #[test]
    fn clone_validates_before_connecting() {
        let f = Fake::new();
        let cfg = ServerCfg { destination: "refused.test".into(), ..f.cfg.clone() };
        for (n, u) in [("-x", "https://h/x"), ("a/b", "https://h/x"), ("ok", "ext::sh -c id"), ("ok", "file:///x"), ("ok", "-u")] {
            let e = clone_repo(&f.ssh, &cfg, n, u).unwrap_err();
            assert!(e.detail.starts_with("invalid input"), "{n} {u}: {e}");
        }
    }

    #[test]
    fn the_physical_folder_is_reported_for_a_link() {
        let f = Fake::new();
        let real = f.home.join("data/real app");
        std::fs::create_dir_all(real.join(".git")).unwrap();
        std::os::unix::fs::symlink(&real, f.home.join("link")).unwrap();
        std::os::unix::fs::symlink("/", f.home.join("rootlink")).unwrap();
        let specs = ["~/link", "~/rootlink", "~/absent"].map(|p| RepoSpec { name: "x".into(), path: p.into(), mapped: true });
        let st = repo_states_at(&f.ssh, &f.cfg, &specs).unwrap();
        assert_eq!(st[0].physical.as_deref(), Some(real.to_str().unwrap()));
        assert_eq!(st[1].physical.as_deref(), Some("/"));
        assert_eq!(st[2].physical, None);
        // the rules for a folder apply to where the link really leads
        assert!(crate::cfg::forbidden_repo_dir("/", Some(f.home.to_str().unwrap())).is_some());
    }

    #[test]
    fn mapped_folders_with_spaces_and_quotes_are_looked_at_and_cloned_into() {
        let f = Fake::new();
        f.stub("git", "printf '%s\\n' \"$@\" > \"$HOME/git-args\"\nfor last; do :; done\nmkdir -p \"$last/.git\"");
        let odd = f.home.join("code/it's mine/orders api");
        std::fs::create_dir_all(odd.join(".git")).unwrap();
        let specs = vec![
            RepoSpec { name: "orders-api".into(), path: "~/code/it's mine/orders api".into(), mapped: true },
            RepoSpec { name: "gone".into(), path: "/srv/$(id)/`x`".into(), mapped: true },
        ];
        let st = repo_states_at(&f.ssh, &f.cfg, &specs).unwrap();
        assert!(st[0].exists && st[0].is_git && st[0].mapped);
        assert_eq!(st[0].path, "~/code/it's mine/orders api");
        assert!(!st[1].exists);
        clone_repo_at(&f.ssh, &f.cfg, "web-shop", "~/new place/'q'/web shop", "https://git.example.com/o/r.git").unwrap();
        assert!(f.home.join("new place/'q'/web shop/.git").is_dir());
        let e = clone_repo_at(&f.ssh, &f.cfg, "orders-api", "~/code/it's mine/orders api", "https://git.example.com/o/r.git").unwrap_err();
        assert!(e.detail.contains("already exists"), "{e}");
    }

    #[test]
    fn hostile_folders_are_refused_before_ssh() {
        let f = Fake::new();
        let cfg = ServerCfg { destination: "refused.test".into(), ..f.cfg.clone() };
        for bad in ["", "rel/x", "/a\nb", "/a/../b", "~", "/", "~/x\u{0}"] {
            let s = [RepoSpec { name: "x".into(), path: bad.into(), mapped: true }];
            let e = repo_states_at(&f.ssh, &cfg, &s).unwrap_err();
            assert!(e.detail.starts_with("invalid input"), "{bad:?}: {e}");
            assert!(clone_repo_at(&f.ssh, &cfg, "x", bad, "https://h.example/x.git").is_err(), "{bad:?}");
        }
    }
}
