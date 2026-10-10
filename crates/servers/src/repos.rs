//! Repositories on the server under `<root>/<name>`: state check and clone.

use crate::cfg::{valid_repo_dir_name, ServerCfg};
use crate::quote::{sh_quote, sh_quote_path_for_remote};
use crate::ssh::{tail, Ssh, SshError};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// What is at `<root>/<name>` on the server.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    /// Repository directory name.
    pub name: String,
    /// Full path on the server.
    pub path: String,
    /// The directory exists.
    pub exists: bool,
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

/// Removes `user:password@` from `scheme://user:password@host/...`.
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
fn normalize_origin(url: &str) -> String {
    let u = url.trim();
    let path = if let Some((_, rest)) = u.split_once("://") {
        // scheme://[user[:password]@]host[:port]/path
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

fn states_script(root: &str, names: &[String]) -> String {
    let list: Vec<String> = names.iter().map(|n| sh_quote(n)).collect();
    format!(
        r#"root={root}
GIT_OPTIONAL_LOCKS=0; export GIT_OPTIONAL_LOCKS
for n in {names}; do
  printf 'repo=%s\n' "$n"
  d="$root/$n"
  if [ -d "$d" ]; then
    printf 'exists=yes\n'
    if [ -e "$d/.git" ]; then
      printf 'git=yes\n'
      b=$(git -c core.fsmonitor=false -C "$d" symbolic-ref --short -q HEAD </dev/null 2>/dev/null || git -C "$d" rev-parse --short HEAD </dev/null 2>/dev/null)
      printf 'branch=%s\n' "$b"
      if [ -n "$(git -c core.fsmonitor=false -C "$d" status --porcelain </dev/null 2>/dev/null | head -n 1)" ]; then printf 'dirty=yes\n'; else printf 'dirty=no\n'; fi
      printf 'origin=%s\n' "$(git -C "$d" remote get-url origin </dev/null 2>/dev/null | head -n 1)"
    fi
  fi
done
"#,
        root = sh_quote_path_for_remote(root),
        names = list.join(" ")
    )
}

fn parse_states(root: &str, names: &[String], text: &str) -> Vec<RepoState> {
    let base = root.trim_end_matches('/');
    let mut out: Vec<RepoState> = Vec::new();
    for line in text.lines().map(|l| l.trim_end_matches('\r')) {
        let Some((k, v)) = line.split_once('=') else { continue };
        if k == "repo" {
            if let Some(n) = names.iter().find(|n| n.as_str() == v) {
                out.push(RepoState { name: n.clone(), path: format!("{base}/{n}"), ..RepoState::default() });
            }
            continue;
        }
        let Some(cur) = out.last_mut() else { continue };
        let v = v.trim();
        match k {
            "exists" => cur.exists = v == "yes",
            "git" => cur.is_git = v == "yes",
            "branch" => cur.branch = (!v.is_empty()).then(|| v.to_string()),
            "dirty" => cur.dirty = Some(v == "yes"),
            "origin" => cur.origin = (!v.is_empty()).then(|| redact_url(v)),
            _ => {}
        }
    }
    // Names the script did not answer for are reported as missing.
    names
        .iter()
        .map(|n| {
            out.iter()
                .find(|s| &s.name == n)
                .cloned()
                .unwrap_or_else(|| RepoState { name: n.clone(), path: format!("{base}/{n}"), ..RepoState::default() })
        })
        .collect()
}

/// State of each repo under the server's root, with one ssh call. Names must match `[A-Za-z0-9._-]{1,100}`, not start
/// with `-` and not be `.` or `..`.
pub fn repo_states(ssh: &Ssh, cfg: &ServerCfg, names: &[String]) -> Result<Vec<RepoState>, SshError> {
    cfg.validate().map_err(|e| SshError::invalid(e.to_string()))?;
    if names.iter().any(|n| !valid_repo_dir_name(n)) {
        return Err(invalid("repository name"));
    }
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let out = ssh.exec(cfg, &states_script(&cfg.root, names), Duration::from_secs(90))?;
    if !out.success() {
        return Err(SshError::other(out.stderr));
    }
    Ok(parse_states(&cfg.root, names, &out.stdout_text()))
}

/// Clones `url` into `<root>/<name>` on the server, with the server's own git credentials.
pub fn clone_repo(ssh: &Ssh, cfg: &ServerCfg, name: &str, url: &str) -> Result<(), SshError> {
    cfg.validate().map_err(|e| SshError::invalid(e.to_string()))?;
    if !valid_repo_dir_name(name) {
        return Err(invalid("repository name"));
    }
    validate_git_url(url).map_err(|m| invalid(&format!("git url: {m}")))?;
    let script = format!(
        r#"set -eu
root={root}
mkdir -p "$root"
if [ -e "$root"/{name} ]; then echo "{name_plain} already exists on the server" >&2; exit 17; fi
GIT_TERMINAL_PROMPT=0; export GIT_TERMINAL_PROMPT
GIT_SSH_COMMAND='ssh -o BatchMode=yes'; export GIT_SSH_COMMAND
git clone -c protocol.ext.allow=never -c protocol.file.allow=never -- {url} "$root"/{name} </dev/null
"#,
        root = sh_quote_path_for_remote(&cfg.root),
        name = sh_quote(name),
        name_plain = name,
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
            "https://user:pw@host/x",
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
        assert_eq!(redact_url("https://u:tok@git.example.com/a/b.git"), "https://git.example.com/a/b.git");
        assert_eq!(redact_url("https://git.example.com/a/b.git"), "https://git.example.com/a/b.git");
        assert_eq!(redact_url("git@git.example.com:a/b.git"), "git@git.example.com:a/b.git");
        assert_eq!(redact_url("https://host/a@b"), "https://host/a@b");
        assert_eq!(redact_url("ssh://git@host/x"), "ssh://host/x");
    }

    #[test]
    fn script_quotes_names_and_root() {
        let s = states_script("~/my work", &["a".into(), "b.c".into()]);
        assert!(s.contains("root=\"$HOME\"/'my work'"));
        assert!(s.contains("for n in 'a' 'b.c'; do"));
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
            ("https://user:token@git.example.com/org/repo.git", "ssh://git@git.example.com/org/repo"),
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
        let cfg = ServerCfg { id: "s".into(), name: "S".into(), destination: "dev@host".into(), port: None, root: "~".into(), max_agents: 1, enabled: true };
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
        git(&clean, &["remote", "add", "origin", "https://user:secret@example.com/o/r.git"]);
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
}
