//! The project key: the same repository must get the same key on every machine, whatever way each person cloned it. It is a hash of
//! the normalized `git remote origin` URL (docs/team.md). A project without an origin has no key and cannot be shared.

use ring::digest;

/// `https://user:pw@GitHub.com:443/Owner/Repo.git/`, `git@github.com:owner/repo.git` and `ssh://git@github.com:22/owner/repo` all
/// become `github.com/owner/repo`. Scheme, credentials, port, a trailing `.git` and slashes do not matter, and the host is lowercased.
/// The path keeps its case, except on hosts that ignore it (github.com, gitlab.com, bitbucket.org). A remote that is not on a host
/// (a relative or absolute path, `file://`) has no key: it names a folder of one machine, not a project.
pub fn normalize_origin(url: &str) -> Option<String> {
    let u = url.trim();
    if u.is_empty() || u.chars().any(|c| c.is_control()) {
        return None;
    }
    let (authority, path) = match u.split_once("://") {
        Some((scheme, rest)) => {
            if scheme.eq_ignore_ascii_case("file") || scheme.is_empty() {
                return None;
            }
            let rest = rest.replace('\\', "/");
            let (a, p) = rest.split_once('/')?;
            (a.to_string(), p.to_string())
        }
        None => {
            // scp-like `[user@]host:path`; a local path never has a host
            if u.starts_with(['/', '.', '~']) {
                return None;
            }
            let after_user = u.rsplit_once('@').map_or(u, |(_, h)| h);
            let at = u.len() - after_user.len();
            let colon = if after_user.starts_with('[') { after_user.find("]:").map(|i| i + 1)? } else { after_user.find(':')? };
            let (host, path) = (&u[at..at + colon], &u[at + colon + 1..]);
            if host.contains('/') {
                return None;
            }
            (host.to_string(), path.replace('\\', "/"))
        }
    };
    let host_port = authority.rsplit_once('@').map_or(authority.as_str(), |(_, h)| h);
    let host = if let Some(inner) = host_port.strip_prefix('[') {
        let end = inner.find(']')?;
        let ip = &inner[..end];
        if ip.is_empty() || !ip.chars().all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.') {
            return None;
        }
        format!("[{}]", ip.to_ascii_lowercase())
    } else {
        let h = host_port.split(':').next().unwrap_or("").to_ascii_lowercase();
        let label_ok = |l: &str| !l.is_empty() && !l.starts_with('-') && !l.ends_with('-') && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if h.len() < 2 || !h.split('.').all(label_ok) {
            return None;
        }
        h
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path).trim_matches('/');
    if path.is_empty() || path.split('/').any(|seg| seg == "..") {
        return None;
    }
    let mut path = path.to_string();
    while path.contains("//") {
        path = path.replace("//", "/");
    }
    if matches!(host.as_str(), "github.com" | "gitlab.com" | "bitbucket.org") {
        path = path.to_lowercase();
    }
    Some(format!("{host}/{path}"))
}

/// 128 bits of SHA-256 over a fixed label and the normalized URL, hex. `None` if the URL has no host and path.
pub fn project_key(origin_url: &str) -> Option<String> {
    let n = normalize_origin(origin_url)?;
    let mut ctx = digest::Context::new(&digest::SHA256);
    ctx.update(b"intely-team/project/v1\0");
    ctx.update(n.as_bytes());
    Some(hex::encode(&ctx.finish().as_ref()[..16]))
}

/// The last path segment of the normalized URL: what the team sees as the project's name.
pub fn project_name(origin_url: &str) -> Option<String> {
    normalize_origin(origin_url)?.rsplit('/').next().map(str::to_string).filter(|n| !n.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_name_is_the_last_segment() {
        assert_eq!(project_name("git@github.com:Acme/Widgets.git").as_deref(), Some("widgets"));
        assert_eq!(project_name(""), None);
    }

    #[test]
    fn every_spelling_of_one_remote_gets_one_key() {
        let same = [
            "https://github.com/Acme/Widgets.git",
            "https://github.com/acme/widgets",
            "https://user:token@GitHub.com/acme/widgets.git/",
            "https://github.com:443/acme/widgets",
            "git@github.com:acme/widgets.git",
            "ssh://git@github.com:22/acme/widgets.git",
            "ssh://git@GITHUB.COM/ACME/Widgets",
            "  git@github.com:acme/widgets.git\n",
        ];
        let k = project_key(same[0]).unwrap();
        for s in same {
            assert_eq!(project_key(s).as_deref(), Some(k.as_str()), "{s}");
            assert_eq!(normalize_origin(s).as_deref(), Some("github.com/acme/widgets"), "{s}");
        }
        assert_eq!(k.len(), 32);
    }

    #[test]
    fn different_repositories_and_hosts_differ() {
        let a = project_key("git@github.com:acme/widgets.git");
        assert_ne!(a, project_key("git@github.com:acme/gadgets.git"));
        assert_ne!(a, project_key("git@gitlab.com:acme/widgets.git"));
    }

    #[test]
    fn local_paths_and_odd_hosts_have_no_key() {
        for s in ["/home/u/repo", "./repo", "../repo", "~/repo", "file:///home/u/repo", "file://host/x/y", "C:\\work\\repo", "host name:a/b", "https://exa_mple.com/a/b", "https://-bad.com/a/b", "https://github.com/a/../b"] {
            assert_eq!(project_key(s), None, "{s:?}");
        }
    }

    #[test]
    fn ipv6_authorities_and_case_on_other_hosts() {
        assert_eq!(normalize_origin("ssh://git@[2001:DB8::1]:2222/Team/Repo.git").as_deref(), Some("[2001:db8::1]/Team/Repo"));
        assert_eq!(normalize_origin("git@[::1]:Team/Repo.git").as_deref(), Some("[::1]/Team/Repo"));
        assert_eq!(normalize_origin("https://Git.Example.com/Team/Repo").as_deref(), Some("git.example.com/Team/Repo"));
        assert_ne!(project_key("https://git.example.com/Team/Repo"), project_key("https://git.example.com/team/repo"));
        assert_eq!(project_key("https://GitHub.com/Team/Repo"), project_key("git@github.com:team/repo.git"));
    }

    #[test]
    fn no_origin_means_no_key() {
        for s in ["", "   ", "https://github.com", "https://github.com/", "just-a-word", "git@host:", "a\nb"] {
            assert_eq!(project_key(s), None, "{s:?}");
        }
    }
}
