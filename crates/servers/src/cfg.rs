//! Server configuration and its strict validation.
//!
//! The destination is the dangerous field: it becomes an argument of `ssh`, so a value like `-oProxyCommand=...` would
//! run a local command. It is limited to a small character set, must not start with `-`, and `Ssh::command` also puts it
//! after `--`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A configured server, as stored in the settings and sent to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCfg {
    /// Stable id, `[a-z0-9][a-z0-9-]{0,31}`.
    pub id: String,
    /// Display name, 1..60 chars.
    pub name: String,
    /// `host`, `user@host` or an alias from `~/.ssh/config`.
    pub destination: String,
    /// ssh port; `None` leaves it to `~/.ssh/config`.
    #[serde(default)]
    pub port: Option<u16>,
    /// Directory on the server that holds the repositories (`/abs` or `~/rel`).
    #[serde(default = "default_root")]
    pub root: String,
    /// How many agents may run at the same time on this server.
    #[serde(default = "default_max_agents")]
    pub max_agents: u32,
    /// Disabled servers stay in the list but are never used.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// Where a repository lives on this server when it is not `<root>/<its folder name>`: the key is [`crate::paths::repo_key`]
    /// (the normalized origin, or the folder name of a repository without one), the value an absolute or `~/` path.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub repo_paths: BTreeMap<String, String>,
}

fn default_root() -> String {
    "~/work".into()
}
fn default_max_agents() -> u32 {
    4
}
fn default_enabled() -> bool {
    true
}

/// A rejected config value: which field and why. The text is safe to show in the UI.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize)]
#[error("{field}: {reason}")]
pub struct CfgError {
    /// Field name as the UI knows it.
    pub field: &'static str,
    /// Plain-English reason.
    pub reason: &'static str,
}

fn err(field: &'static str, reason: &'static str) -> CfgError {
    CfgError { field, reason }
}

impl ServerCfg {
    /// Checks every field. Nothing from an unvalidated config may reach `ssh` or a remote script.
    pub fn validate(&self) -> Result<(), CfgError> {
        validate_id(&self.id)?;
        validate_name(&self.name)?;
        validate_destination(&self.destination)?;
        if self.port == Some(0) {
            return Err(err("port", "must be 1..65535"));
        }
        validate_remote_path("root", &self.root)?;
        if !(1..=64).contains(&self.max_agents) {
            return Err(err("maxAgents", "must be 1..64"));
        }
        if self.repo_paths.len() > 500 {
            return Err(err("repoPaths", "at most 500 repositories"));
        }
        for (k, v) in &self.repo_paths {
            validate_repo_key(k)?;
            validate_repo_path(v)?;
        }
        Ok(())
    }
}

/// `[a-z0-9][a-z0-9-]{0,31}`.
pub fn validate_id(id: &str) -> Result<(), CfgError> {
    let b = id.as_bytes();
    let ok = !b.is_empty()
        && b.len() <= 32
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-');
    if ok {
        Ok(())
    } else {
        Err(err("id", "use 1..32 chars of a-z, 0-9 and -, starting with a letter or digit"))
    }
}

/// 1..60 chars, no control characters, not blank.
pub fn validate_name(name: &str) -> Result<(), CfgError> {
    let n = name.chars().count();
    if n == 0 || n > 60 || name.trim().is_empty() {
        return Err(err("name", "must be 1..60 characters"));
    }
    if name.chars().any(char::is_control) {
        return Err(err("name", "must not contain control characters"));
    }
    Ok(())
}

/// `host`, `user@host` or an ssh_config alias: a small ASCII set, never a leading `-`, no whitespace.
pub fn validate_destination(d: &str) -> Result<(), CfgError> {
    if d.is_empty() || d.len() > 255 {
        return Err(err("destination", "must be 1..255 characters"));
    }
    if d.starts_with('-') {
        return Err(err("destination", "must not start with '-'"));
    }
    let allowed = |c: char| c.is_ascii_alphanumeric() || "._@:[]%-".contains(c);
    if !d.chars().all(allowed) {
        return Err(err("destination", "only letters, digits and . _ @ : [ ] % - are allowed"));
    }
    if d.matches('@').count() > 1 || d.starts_with('@') || d.ends_with('@') {
        return Err(err("destination", "expected host or user@host"));
    }
    Ok(())
}

/// An absolute (`/x`) or home-relative (`~`, `~/x`) path on the server: no control chars, no `..` component, max 1024.
pub fn validate_remote_path(field: &'static str, p: &str) -> Result<(), CfgError> {
    if p.is_empty() || p.len() > 1024 {
        return Err(err(field, "must be 1..1024 characters"));
    }
    if !(p.starts_with('/') || p.starts_with("~/") || p == "~") {
        return Err(err(field, "must start with / or ~/"));
    }
    if p.chars().any(char::is_control) {
        return Err(err(field, "must not contain control characters"));
    }
    if p.split('/').any(|c| c == "..") {
        return Err(err(field, "must not contain '..'"));
    }
    Ok(())
}

/// A key of `repoPaths`: 1..300 characters, no control characters.
pub fn validate_repo_key(k: &str) -> Result<(), CfgError> {
    if k.is_empty() || k.chars().count() > 300 || k.chars().any(char::is_control) {
        return Err(err("repoPaths", "a repository key must be 1..300 characters without control characters"));
    }
    Ok(())
}

/// Folders that are never a repository folder: system roots, and the places where the home folder keeps keys, settings and the IDE's own files.
const SYSTEM_ROOTS: [&str; 8] = ["/etc", "/root", "/proc", "/sys", "/dev", "/boot", "/bin", "/sbin"];
const HOME_PRIVATE: [&str; 4] = [".ssh", ".config", ".local", ".intely"];

fn within(p: &str, root: &str) -> bool {
    p == root || p.strip_prefix(root).is_some_and(|r| r.starts_with('/'))
}

/// A path with `.` components removed, `//` collapsed and no trailing `/` (`~` and `~/x` stay, `/` stays). Only text is looked at; links
/// are not followed. `..` and control characters are refused by the callers.
pub fn canonical_path(p: &str) -> String {
    let (head, rest) = if p == "~" || p.starts_with("~/") { ("~", &p[1..]) } else { ("", p) };
    let parts: Vec<&str> = rest.split('/').filter(|c| !c.is_empty() && *c != ".").collect();
    let abs = rest.starts_with('/');
    match (head, parts.is_empty()) {
        ("~", true) => "~".to_string(),
        ("~", false) => format!("~/{}", parts.join("/")),
        (_, true) => if abs { "/".to_string() } else { String::new() },
        _ => format!("{}{}", if abs { "/" } else { "" }, parts.join("/")),
    }
}

/// The reason a canonical folder of the server may not be a repository folder: the home folder, `/`, a top-level folder (`/srv`, `/opt`,
/// `/usr`, ...), a system root, or a private place of the home folder. `home` is the server's home when it is known (a physical path).
pub fn forbidden_repo_dir(canonical: &str, home: Option<&str>) -> Option<&'static str> {
    let home = home.map(|h| canonical_path(h)).filter(|h| h.starts_with('/') && h != "/");
    let rel_home = |p: &str| -> Option<String> {
        if p == "~" {
            return Some(String::new());
        }
        if let Some(r) = p.strip_prefix("~/") {
            return Some(r.to_string());
        }
        let h = home.as_deref()?;
        if p == h {
            return Some(String::new());
        }
        p.strip_prefix(h).and_then(|r| r.strip_prefix('/')).map(str::to_string)
    };
    if let Some(r) = rel_home(canonical) {
        if r.is_empty() {
            return Some("must be a folder inside the home folder, not the home folder itself");
        }
        let first = r.split('/').next().unwrap_or("");
        if HOME_PRIVATE.contains(&first) {
            return Some("must not be inside ~/.ssh, ~/.config, ~/.local or ~/.intely");
        }
        return None;
    }
    if canonical == "/" || canonical.trim_start_matches('/').split('/').count() < 2 {
        return Some("must be at least two levels deep (a top-level folder such as /srv or /opt is too broad)");
    }
    if SYSTEM_ROOTS.iter().any(|r| within(canonical, r)) {
        return Some("must not be inside a system folder such as /etc or /root");
    }
    None
}

/// The folder of one repository on the server: absolute or `~/...`, no control characters, no `..` and no empty or `.` result; after
/// the lexical clean-up ([`canonical_path`]) not the home folder, `/`, a top-level folder, a system folder or a private place of the home folder.
pub fn validate_repo_path(p: &str) -> Result<(), CfgError> {
    validate_remote_path("repoPaths", p)?;
    let c = canonical_path(p);
    if c.is_empty() {
        return Err(err("repoPaths", "must not be empty"));
    }
    match forbidden_repo_dir(&c, None) {
        Some(reason) => Err(err("repoPaths", reason)),
        None => Ok(()),
    }
}

/// An app version that is safe as a directory name: `[A-Za-z0-9._+-]{1,64}`, not starting with `.` or `-`.
pub fn valid_version(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && !v.starts_with(['.', '-'])
        && v.chars().all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c))
}

/// A directory-safe single name (repo, agent id): `[A-Za-z0-9._-]{1,100}`, not `.`/`..`, no leading `-`.
pub fn valid_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 100
        && n != "."
        && n != ".."
        && !n.starts_with('-')
        && n.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// A folder name the host puts under a server's repository root: [`valid_name`], and not hidden. A local folder called `.ssh` or
/// `.aws` must not become `<root>/.ssh`, which with the root `~` is the real one.
pub fn valid_repo_dir_name(n: &str) -> bool {
    valid_name(n) && !n.starts_with('.')
}

/// Turns a display name into an id candidate: lowercase, dashes, never empty, max 32.
/// The caller makes it unique.
pub fn slug_from_name(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.truncate(32);
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "server".into()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good() -> ServerCfg {
        ServerCfg {
            id: "big-1".into(),
            name: "Big server".into(),
            destination: "dev@big.example.com".into(),
            port: Some(2222),
            root: "~/work".into(),
            max_agents: 5,
            enabled: true,
            repo_paths: BTreeMap::new(),
        }
    }

    #[test]
    fn good_config_passes() {
        assert!(good().validate().is_ok());
    }

    #[test]
    fn defaults_apply_when_fields_are_missing() {
        let c: ServerCfg =
            serde_json::from_str(r#"{"id":"a","name":"A","destination":"h"}"#).unwrap();
        assert_eq!((c.root.as_str(), c.max_agents, c.enabled, c.port), ("~/work", 4, true, None));
    }

    #[test]
    fn serde_is_camel_case() {
        let v = serde_json::to_value(good()).unwrap();
        assert_eq!(v["maxAgents"], 5);
        assert!(v.get("max_agents").is_none());
    }

    #[test]
    fn bad_ids_are_rejected() {
        for id in ["", "-a", "A", "a_b", "a b", "a/b", "é", &"a".repeat(33), "a\n", "a;b"] {
            let mut c = good();
            c.id = id.into();
            assert!(c.validate().is_err(), "{id:?}");
        }
        let mut c = good();
        c.id = "a".repeat(32);
        assert!(c.validate().is_ok());
        c.id = "0-x".into();
        assert!(c.validate().is_ok());
    }

    #[test]
    fn bad_names_are_rejected() {
        for n in ["", "   ", "a\nb", "a\u{0}b", "a\u{1b}[31m", &"x".repeat(61)] {
            let mut c = good();
            c.name = n.into();
            assert!(c.validate().is_err(), "{n:?}");
        }
        let mut c = good();
        c.name = "Szerver ű".into();
        assert!(c.validate().is_ok());
        c.name = "ű".repeat(60);
        assert!(c.validate().is_ok());
    }

    #[test]
    fn hostile_destinations_are_rejected() {
        for d in [
            "",
            "-oProxyCommand=touch /tmp/x",
            "-oProxyCommand=x",
            "-J evil",
            "--help",
            "host name",
            "host\tname",
            "host\nname",
            "host;ls",
            "host$(id)",
            "host`id`",
            "host|cat",
            "host&x",
            "a@b@c",
            "@host",
            "user@",
            "host'x",
            "host\"x",
            "hôst",
            "host/path",
            "host=1",
            &"h".repeat(256),
        ] {
            assert!(validate_destination(d).is_err(), "{d:?}");
        }
    }

    #[test]
    fn real_destinations_pass() {
        for d in [
            "big",
            "user@big.example.com",
            "10.0.0.5",
            "u@[fe80::1%en0]",
            "fe80::1",
            "my_alias-2",
            "ci.build-01",
            &"h".repeat(255),
        ] {
            assert!(validate_destination(d).is_ok(), "{d:?}");
        }
    }

    #[test]
    fn port_bounds() {
        let mut c = good();
        c.port = Some(0);
        assert!(c.validate().is_err());
        c.port = Some(1);
        assert!(c.validate().is_ok());
        c.port = Some(65535);
        assert!(c.validate().is_ok());
        c.port = None;
        assert!(c.validate().is_ok());
    }

    #[test]
    fn root_rules() {
        for r in [
            "",
            "work",
            "./work",
            "~user/x",
            "~work",
            "/a/../b",
            "~/../x",
            "/..",
            "/a\nb",
            "/a\0b",
            "/a\tb",
            "/a\u{7f}b",
            &format!("/{}", "a".repeat(1024)),
        ] {
            assert!(validate_remote_path("root", r).is_err(), "{r:?}");
        }
        for r in ["/", "/srv/work", "~", "~/", "~/work", "~/a b", "/a/..b/c", "/a/b.."] {
            assert!(validate_remote_path("root", r).is_ok(), "{r:?}");
        }
        assert!(validate_remote_path("root", &format!("/{}", "a".repeat(1023))).is_ok());
    }

    #[test]
    fn repo_paths_are_validated() {
        let mut c = good();
        c.repo_paths.insert("acme/orders-api".into(), "/srv/apps/orders api".into());
        c.repo_paths.insert("dir:web-shop".into(), "~/code/web-shop".into());
        assert!(c.validate().is_ok());
        for bad in ["", "~", "~/", "/", "//", "rel/x", "/a/../b", "/a\nb", "/a\u{0}b", "~user/x", "~/.", "~/./", "/srv", "/srv/", "/./srv", "//opt//", "/home", "/etc/x", "/root/app", "/proc/1", "~/.ssh", "~/.ssh/keys", "~/.config/x", "~/.local/share/x", "~/.intely/node", "/usr", "/var"] {
            let mut c = good();
            c.repo_paths.insert("k".into(), bad.into());
            assert!(c.validate().is_err(), "{bad:?}");
        }
        let mut c = good();
        c.repo_paths.insert("".into(), "/x".into());
        assert!(c.validate().is_err());
        let mut c = good();
        c.repo_paths.insert("a\nb".into(), "/x".into());
        assert!(c.validate().is_err());
    }

    #[test]
    fn repo_paths_are_cleaned_up_lexically() {
        for (raw, want) in [("/srv//apps/./x/", "/srv/apps/x"), ("~/./code//x/", "~/code/x"), ("~", "~"), ("~/", "~"), ("//", "/"), ("/a/b", "/a/b")] {
            assert_eq!(canonical_path(raw), want, "{raw}");
        }
        let mut c = good();
        c.repo_paths.insert("k".into(), "/srv//apps/./x/".into());
        assert!(c.validate().is_ok());
    }

    #[test]
    fn a_physical_path_is_judged_with_the_servers_home() {
        for bad in ["/", "/home/me", "/home/me/", "/home", "/srv", "/home/me/.ssh", "/home/me/.config/a", "/home/me/.intely/x", "/etc/app", "/root/x"] {
            assert!(forbidden_repo_dir(&canonical_path(bad), Some("/home/me")).is_some(), "{bad}");
        }
        for ok in ["/home/me/work/x", "/srv/apps/x", "/opt/x/y", "/home/alice/x"] {
            assert!(forbidden_repo_dir(ok, Some("/home/me")).is_none(), "{ok}");
        }
    }

    #[test]
    fn repo_paths_default_to_empty_and_stay_out_of_the_json() {
        let c: ServerCfg = serde_json::from_str(r#"{"id":"a","name":"A","destination":"h","repoPaths":{"k":"/x"}}"#).unwrap();
        assert_eq!(c.repo_paths.get("k").map(String::as_str), Some("/x"));
        assert!(serde_json::to_value(good()).unwrap().get("repoPaths").is_none());
    }

    #[test]
    fn max_agents_bounds() {
        let mut c = good();
        for (n, ok) in [(0, false), (1, true), (64, true), (65, false), (u32::MAX, false)] {
            c.max_agents = n;
            assert_eq!(c.validate().is_ok(), ok, "{n}");
        }
    }

    #[test]
    fn slugs() {
        assert_eq!(slug_from_name("Big Server #1"), "big-server-1");
        assert_eq!(slug_from_name("  --Hello__World--  "), "hello-world");
        assert_eq!(slug_from_name(""), "server");
        assert_eq!(slug_from_name("ű ő"), "server");
        assert_eq!(slug_from_name("../../etc"), "etc");
        let long = slug_from_name(&"ab ".repeat(30));
        assert!(long.len() <= 32 && !long.ends_with('-'));
        for n in ["Big Server #1", "x", "ű", &"a-".repeat(40), "$(id)"] {
            assert!(validate_id(&slug_from_name(n)).is_ok(), "{n:?}");
        }
    }

    #[test]
    fn version_and_name_helpers() {
        assert!(valid_version("1.1.1"));
        assert!(valid_version("1.2.0-beta.1+7"));
        for v in ["", ".x", "-x", "a/b", "a b", "..", "a;b", &"1".repeat(65)] {
            assert!(!valid_version(v), "{v:?}");
        }
        assert!(valid_name("my-repo_1.git"));
        for n in ["", ".", "..", "-x", "a/b", "a b", "a\n", "a$b", &"a".repeat(101)] {
            assert!(!valid_name(n), "{n:?}");
        }
        assert!(valid_repo_dir_name("my-repo_1.git") && valid_repo_dir_name("a.b"));
        for n in [".ssh", ".aws", ".gnupg", ".hidden", "..x", ".", ".."] {
            assert!(!valid_repo_dir_name(n), "{n:?}");
        }
    }
}
