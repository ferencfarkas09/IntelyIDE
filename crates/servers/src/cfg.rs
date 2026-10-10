//! Server configuration and its strict validation.
//!
//! The destination is the dangerous field: it becomes an argument of `ssh`, so a value like `-oProxyCommand=...` would
//! run a local command. It is limited to a small character set, must not start with `-`, and `Ssh::command` also puts it
//! after `--`.

use serde::{Deserialize, Serialize};

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
    }
}
