//! What is on the server: one POSIX `sh` script prints `key=value` lines, `parse_probe` reads them, `probe` runs it.

use crate::cfg::{valid_version, ServerCfg};
use crate::quote::sh_quote_path_for_remote;
use crate::ssh::{Ssh, SshError};
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Wall-clock limit of the probe (the script itself takes a few seconds).
const PROBE_TIMEOUT: Duration = Duration::from_secs(60);

/// Minimum Node major version the sidecar needs.
pub const MIN_NODE_MAJOR: u32 = 24;

/// The probe script. It never fails (always exits 0). With `app_version` it also runs `<node> <index.js> --probe` of
/// that bundle, when present, and prints the answer as `sidecar_probe=<json>`.
pub fn probe_script(app_version: Option<&str>) -> String {
    let mut s = String::from(
        r#"LC_ALL=C; export LC_ALL
kv() { printf '%s=%s\n' "$1" "$(printf %s "$2" | head -n 1 | tr -d '\r')"; }
kv os "$(uname -s 2>/dev/null)"
kv arch "$(uname -m 2>/dev/null)"
kv home "$HOME"
kv user "$(id -un 2>/dev/null)"
node=""
if [ -x "$HOME/.intely/node/bin/node" ]; then node="$HOME/.intely/node/bin/node"
else c=$(command -v node 2>/dev/null); if [ -n "$c" ] && [ -x "$c" ]; then node="$c"; fi; fi
if [ -n "$node" ]; then kv node "$node"; kv node_version "$("$node" --version </dev/null 2>/dev/null)"; fi
claude=""
for c in "$HOME/.intely/claude/bin/claude" "$(command -v claude 2>/dev/null)" "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" /usr/local/bin/claude; do
  if [ -n "$c" ] && [ -x "$c" ]; then claude="$c"; break; fi
done
if [ -n "$claude" ]; then kv claude "$claude"; kv claude_version "$("$claude" --version </dev/null 2>/dev/null)"; fi
g=$(command -v git 2>/dev/null)
if [ -n "$g" ]; then kv git "$g"; kv git_version "$("$g" --version </dev/null 2>/dev/null)"; fi
for t in tar curl wget; do if command -v "$t" >/dev/null 2>&1; then kv "have_$t" yes; else kv "have_$t" no; fi; done
if command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1; then kv have_sha256 yes; else kv have_sha256 no; fi
kv free_kb "$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2{print $4}')"
if [ -f "$HOME/.claude/.credentials.json" ]; then kv claude_login yes
elif [ -f "$HOME/.claude.json" ] && grep -q oauthAccount "$HOME/.claude.json" 2>/dev/null; then kv claude_login yes
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then kv claude_login apikey
else kv claude_login unknown; fi
for f in "$HOME"/.intely/*/resources/sidecar/index.js; do
  [ -f "$f" ] || continue
  v=${f#"$HOME"/.intely/}; v=${v%%/*}; kv bundle "$v"
done
"#,
    );
    if let Some(v) = app_version.filter(|v| valid_version(v)) {
        let js = sh_quote_path_for_remote(&format!("~/.intely/{v}/resources/sidecar/index.js"));
        s.push_str(&format!(
            "js={js}\nif [ -n \"$node\" ] && [ -f \"$js\" ]; then kv sidecar_probe \"$(\"$node\" \"$js\" --probe </dev/null 2>/dev/null)\"; fi\n"
        ));
    }
    s.push_str("exit 0\n");
    s
}

/// The raw facts of one probe run. Missing keys stay `None`/`false`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProbeFacts {
    /// `uname -s`.
    pub os: Option<String>,
    /// `uname -m`.
    pub arch: Option<String>,
    /// `$HOME`.
    pub home: Option<String>,
    /// The login name.
    pub user: Option<String>,
    /// Path of a `node`.
    pub node: Option<String>,
    /// `node --version`, like `v24.13.0`.
    pub node_version: Option<String>,
    /// Path of a `claude`.
    pub claude: Option<String>,
    /// `claude --version`.
    pub claude_version: Option<String>,
    /// Path of `git`.
    pub git: Option<String>,
    /// `git --version`.
    pub git_version: Option<String>,
    /// `tar` exists.
    pub have_tar: bool,
    /// `curl` exists.
    pub have_curl: bool,
    /// `wget` exists.
    pub have_wget: bool,
    /// `sha256sum` or `shasum` exists.
    pub have_sha256: bool,
    /// Free space under `$HOME` in KiB.
    pub free_kb: Option<u64>,
    /// `yes`, `apikey` or `unknown`.
    pub claude_login: Option<String>,
    /// Versions with an uploaded bundle.
    pub bundles: Vec<String>,
    /// The first line of `<node> index.js --probe`, unparsed.
    pub sidecar_probe: Option<String>,
}

/// Reads probe output. Tolerates CRLF, noise lines (motd, banners), unknown keys and missing keys; the last value of a
/// key wins, except `bundle` which collects.
pub fn parse_probe(text: &str) -> ProbeFacts {
    let mut f = ProbeFacts::default();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        let Some((k, v)) = line.split_once('=') else { continue };
        if k.is_empty() || !k.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_') {
            continue;
        }
        let some = || (!v.trim().is_empty()).then(|| v.trim().to_string());
        let yes = || v.trim() == "yes";
        match k {
            "os" => f.os = some(),
            "arch" => f.arch = some(),
            "home" => f.home = some(),
            "user" => f.user = some(),
            "node" => f.node = some(),
            "node_version" => f.node_version = some(),
            "claude" => f.claude = some(),
            "claude_version" => f.claude_version = some(),
            "git" => f.git = some(),
            "git_version" => f.git_version = some(),
            "have_tar" => f.have_tar = yes(),
            "have_curl" => f.have_curl = yes(),
            "have_wget" => f.have_wget = yes(),
            "have_sha256" => f.have_sha256 = yes(),
            "free_kb" => f.free_kb = v.trim().parse().ok(),
            "claude_login" => f.claude_login = some(),
            "bundle" => {
                if let Some(b) = some().filter(|b| valid_version(b)) {
                    if !f.bundles.contains(&b) {
                        f.bundles.push(b);
                    }
                }
            }
            "sidecar_probe" => f.sidecar_probe = some(),
            _ => {}
        }
    }
    f
}

impl ProbeFacts {
    /// Major version of `node_version` (`v24.13.0` -> 24).
    pub fn node_major(&self) -> Option<u32> {
        let v = self.node_version.as_deref()?.trim().trim_start_matches('v');
        v.split('.').next()?.parse().ok()
    }
    /// A Node that is new enough.
    pub fn node_ok(&self) -> bool {
        self.node.is_some() && self.node_major().is_some_and(|m| m >= MIN_NODE_MAJOR)
    }
    /// The SDK state from `sidecar_probe`: `(ok, version, detail)`. Absent or garbage reads as "unknown".
    pub fn sdk(&self) -> SdkStatus {
        let unknown = SdkStatus { ok: false, version: None, detail: Some("sdk unknown".into()) };
        let Some(raw) = &self.sidecar_probe else { return unknown };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else { return unknown };
        let Some(sdk) = v.get("sdk").filter(|s| s.is_object()) else { return unknown };
        let text = |k: &str| sdk.get(k).and_then(|x| x.as_str()).map(|s| s.chars().take(300).collect::<String>());
        SdkStatus {
            ok: sdk.get("ok").and_then(|b| b.as_bool()).unwrap_or(false),
            version: text("version"),
            detail: text("detail").or_else(|| text("code")),
        }
    }
}

/// Node on the server.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatus {
    /// `v24.13.0`.
    pub version: Option<String>,
    /// Path of the binary.
    pub path: Option<String>,
    /// Found and version >= 24.
    pub ok: bool,
}

/// The Claude CLI on the server.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    /// Path of the binary.
    pub path: Option<String>,
    /// `claude --version`.
    pub version: Option<String>,
    /// The server has a login (`true`), or nothing is known (`None`).
    pub logged_in: Option<bool>,
}

/// git on the server.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Path of the binary.
    pub path: Option<String>,
    /// `git --version`.
    pub version: Option<String>,
}

/// The uploaded sidecar bundle of the current app version.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleStatus {
    /// The app version, when its bundle is present.
    pub version: Option<String>,
    /// Present.
    pub ok: bool,
}

/// The Agent SDK as the sidecar reports it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkStatus {
    /// Installed and verified.
    pub ok: bool,
    /// SDK version.
    pub version: Option<String>,
    /// Why not, when not.
    pub detail: Option<String>,
}

/// Why the probe could not reach the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusError {
    /// Stable class code (`host_key`, `auth`, ...).
    pub code: String,
    /// One line for the UI.
    pub message: String,
    /// What to do about it.
    pub hint: Option<String>,
}

/// Everything the UI shows about one server.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    /// ssh worked.
    pub reachable: bool,
    /// `Linux`, `Darwin`, ...
    pub os: Option<String>,
    /// `x86_64`, `aarch64`, ...
    pub arch: Option<String>,
    /// `$HOME` on the server.
    pub home: Option<String>,
    /// Node.
    pub node: NodeStatus,
    /// Claude CLI.
    pub claude: ClaudeStatus,
    /// git.
    pub git: GitStatus,
    /// Bundle of this app version.
    pub bundle: BundleStatus,
    /// Agent SDK.
    pub sdk: SdkStatus,
    /// Everything needed to run an agent is there.
    pub ready: bool,
    /// RFC 3339 UTC time of the probe.
    pub checked_at: String,
    /// Set when `reachable` is false.
    pub error: Option<StatusError>,
}

/// Builds the status from parsed facts. `app_version` decides which bundle counts.
pub fn status_from_facts(f: &ProbeFacts, app_version: &str) -> ServerStatus {
    let bundle_ok = f.bundles.iter().any(|b| b == app_version);
    let mut st = ServerStatus {
        reachable: true,
        os: f.os.clone(),
        arch: f.arch.clone(),
        home: f.home.clone(),
        node: NodeStatus { version: f.node_version.clone(), path: f.node.clone(), ok: f.node_ok() },
        claude: ClaudeStatus {
            path: f.claude.clone(),
            version: f.claude_version.clone(),
            logged_in: match f.claude_login.as_deref() {
                Some("yes") | Some("apikey") => Some(true),
                _ => None,
            },
        },
        git: GitStatus { path: f.git.clone(), version: f.git_version.clone() },
        bundle: BundleStatus { version: bundle_ok.then(|| app_version.to_string()), ok: bundle_ok },
        sdk: if bundle_ok { f.sdk() } else { SdkStatus { ok: false, version: None, detail: Some("sidecar bundle missing".into()) } },
        ready: false,
        checked_at: now_rfc3339(),
        error: None,
    };
    st.ready = st.reachable
        && st.node.ok
        && st.claude.path.is_some()
        && st.git.path.is_some()
        && st.bundle.ok
        && st.sdk.ok
        && st.home.is_some();
    st
}

impl ServerStatus {
    /// A status for a failed ssh call.
    pub fn unreachable(e: &SshError) -> Self {
        Self {
            checked_at: now_rfc3339(),
            error: Some(StatusError {
                code: e.kind.code().into(),
                message: e.to_string(),
                hint: e.hint.clone(),
            }),
            ..Self::default()
        }
    }
    /// Names of the missing pieces, for error messages.
    pub fn missing(&self) -> Vec<&'static str> {
        let mut m = Vec::new();
        if !self.reachable {
            m.push("connection");
        }
        if !self.node.ok {
            m.push("node >= 24");
        }
        if self.claude.path.is_none() {
            m.push("claude CLI");
        }
        if self.git.path.is_none() {
            m.push("git");
        }
        if !self.bundle.ok {
            m.push("sidecar bundle");
        }
        if !self.sdk.ok {
            m.push("agent SDK");
        }
        m
    }
}

/// Runs the probe script and parses it. Errors are ssh errors.
pub fn probe_facts(ssh: &Ssh, cfg: &ServerCfg, app_version: &str) -> Result<ProbeFacts, SshError> {
    let out = ssh.exec(cfg, &probe_script(Some(app_version)), PROBE_TIMEOUT)?;
    if !out.success() && out.stdout.is_empty() {
        return Err(SshError { kind: crate::ssh::SshErrorKind::Other, detail: crate::ssh::tail(&out.stderr), hint: None });
    }
    Ok(parse_probe(&out.stdout_text()))
}

/// Probes a server. Never panics: an ssh error becomes `reachable: false` with the classified error.
pub fn probe(ssh: &Ssh, cfg: &ServerCfg, app_version: &str) -> ServerStatus {
    match probe_facts(ssh, cfg, app_version) {
        Ok(f) => status_from_facts(&f, app_version),
        Err(e) => ServerStatus::unreachable(&e),
    }
}

/// Current UTC time as RFC 3339 (`2026-10-10T08:30:00Z`), without a time crate.
pub fn now_rfc3339() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    rfc3339_utc(secs)
}

/// Unix seconds to RFC 3339 UTC (days-to-civil algorithm by Howard Hinnant).
pub fn rfc3339_utc(secs: u64) -> String {
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::*;

    const GOOD: &str = "os=Linux\narch=x86_64\nhome=/home/dev\nuser=dev\nnode=/usr/bin/node\nnode_version=v24.13.0\nclaude=/home/dev/.local/bin/claude\nclaude_version=2.1.0 (Claude Code)\ngit=/usr/bin/git\ngit_version=git version 2.43.0\nhave_tar=yes\nhave_curl=yes\nhave_wget=no\nhave_sha256=yes\nfree_kb=1234567\nclaude_login=yes\nbundle=1.1.0\nbundle=1.1.1\nsidecar_probe={\"sidecar\":\"1.1.1\",\"sdk\":{\"ok\":true,\"version\":\"0.3.287\"}}\n";

    #[test]
    fn parses_a_full_probe() {
        let f = parse_probe(GOOD);
        assert_eq!(f.os.as_deref(), Some("Linux"));
        assert_eq!(f.home.as_deref(), Some("/home/dev"));
        assert_eq!(f.node_version.as_deref(), Some("v24.13.0"));
        assert_eq!(f.claude_version.as_deref(), Some("2.1.0 (Claude Code)"));
        assert!(f.have_tar && f.have_curl && !f.have_wget && f.have_sha256);
        assert_eq!(f.free_kb, Some(1234567));
        assert_eq!(f.bundles, ["1.1.0", "1.1.1"]);
        assert!(f.node_ok());
        assert_eq!(f.sdk(), SdkStatus { ok: true, version: Some("0.3.287".into()), detail: None });
    }

    #[test]
    fn tolerates_crlf_and_noise() {
        let text = format!("Welcome to big!\r\nLast login: Mon\r\n\r\n{}\r\nmotd line = with equals\r\nBAD KEY=1\r\n", GOOD.replace('\n', "\r\n"));
        let f = parse_probe(&text);
        assert_eq!(f.os.as_deref(), Some("Linux"));
        assert_eq!(f.git_version.as_deref(), Some("git version 2.43.0"));
        assert_eq!(f.bundles.len(), 2);
        assert!(f.sdk().ok);
    }

    #[test]
    fn missing_keys_leave_defaults() {
        let f = parse_probe("os=Linux\n");
        assert_eq!(f.os.as_deref(), Some("Linux"));
        assert!(f.node.is_none() && !f.node_ok() && f.bundles.is_empty() && !f.have_tar);
        assert_eq!(f.sdk().detail.as_deref(), Some("sdk unknown"));
        assert_eq!(parse_probe(""), ProbeFacts::default());
    }

    #[test]
    fn old_node_is_not_ok() {
        let f = parse_probe("node=/usr/bin/node\nnode_version=v18.19.1\n");
        assert_eq!(f.node_major(), Some(18));
        assert!(!f.node_ok());
        let f = parse_probe("node=/usr/bin/node\nnode_version=v24.0.0\n");
        assert!(f.node_ok());
        let f = parse_probe("node=/usr/bin/node\nnode_version=v100.1.0\n");
        assert!(f.node_ok());
        let f = parse_probe("node=/usr/bin/node\nnode_version=garbage\n");
        assert!(!f.node_ok());
        let f = parse_probe("node_version=v24.1.0\n");
        assert!(!f.node_ok(), "no path, no node");
    }

    #[test]
    fn garbage_sidecar_probe_reads_as_unknown() {
        for g in ["sidecar_probe=not json", "sidecar_probe={\"sdk\":1}", "sidecar_probe={}", "sidecar_probe=[1]", "sidecar_probe="] {
            let s = parse_probe(g).sdk();
            assert!(!s.ok, "{g}");
        }
    }

    #[test]
    fn failing_sdk_keeps_the_detail() {
        let f = parse_probe("sidecar_probe={\"sdk\":{\"ok\":false,\"code\":\"sdk_missing\",\"detail\":\"not installed\"}}\n");
        let s = f.sdk();
        assert!(!s.ok);
        assert_eq!(s.detail.as_deref(), Some("not installed"));
    }

    #[test]
    fn hostile_bundle_names_are_dropped() {
        let f = parse_probe("bundle=../../x\nbundle=1.0.0\nbundle=a b\nbundle=1.0.0\n");
        assert_eq!(f.bundles, ["1.0.0"]);
    }

    #[test]
    fn status_ready_needs_everything() {
        let f = parse_probe(GOOD);
        let st = status_from_facts(&f, "1.1.1");
        assert!(st.ready && st.reachable && st.error.is_none());
        assert_eq!(st.claude.logged_in, Some(true));
        assert_eq!(st.bundle.version.as_deref(), Some("1.1.1"));
        assert!(st.missing().is_empty());
        // wrong app version: bundle missing, sdk not trusted
        let st = status_from_facts(&f, "2.0.0");
        assert!(!st.ready && !st.bundle.ok);
        assert!(!st.sdk.ok);
        assert_eq!(st.missing(), ["sidecar bundle", "agent SDK"]);
        for drop in ["node=", "claude=", "git="] {
            let text: String = GOOD.lines().filter(|l| !l.starts_with(drop)).map(|l| format!("{l}\n")).collect();
            assert!(!status_from_facts(&parse_probe(&text), "1.1.1").ready, "{drop}");
        }
    }

    #[test]
    fn status_serializes_in_camel_case() {
        let st = status_from_facts(&parse_probe(GOOD), "1.1.1");
        let v = serde_json::to_value(&st).unwrap();
        assert_eq!(v["claude"]["loggedIn"], true);
        assert!(v["checkedAt"].as_str().unwrap().ends_with('Z'));
        assert_eq!(v["node"]["ok"], true);
        let back: ServerStatus = serde_json::from_value(v).unwrap();
        assert_eq!(back, st);
    }

    #[test]
    fn rfc3339_known_values() {
        assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339_utc(1_791_590_400), "2026-10-10T00:00:00Z");
        assert_eq!(rfc3339_utc(4_102_444_799), "2099-12-31T23:59:59Z");
        let n = now_rfc3339();
        assert_eq!((n.len(), &n[10..11]), (20, "T"));
    }

    #[test]
    fn script_embeds_only_a_validated_version() {
        let s = probe_script(Some("1.1.1"));
        assert!(s.contains("\"$HOME\"/'.intely/1.1.1/resources/sidecar/index.js'"));
        assert!(s.ends_with("exit 0\n"));
        let s = probe_script(Some("1.0; rm -rf /"));
        assert!(!s.contains("rm -rf") && !s.contains("sidecar_probe"));
        assert!(!probe_script(None).contains("sidecar_probe"));
    }

    #[test]
    fn probe_on_the_fake_server() {
        let f = Fake::new();
        if fixed_claude_present() {
            return;
        }
        f.stub_node("v24.9.0");
        let st = probe(&f.ssh, &f.cfg, "1.1.1");
        assert!(st.reachable, "{:?}", st.error);
        assert_eq!(st.home.as_deref(), Some(f.home.to_str().unwrap()));
        assert_eq!(st.node.path.as_deref(), Some(f.stubs.join("node").to_str().unwrap()));
        assert_eq!(st.node.version.as_deref(), Some("v24.9.0"));
        assert!(st.node.ok);
        assert!(st.git.path.is_some());
        assert!(st.claude.path.is_none());
        assert!(!st.bundle.ok && !st.ready);
        assert_eq!(st.os.as_deref(), Some(if cfg!(target_os = "macos") { "Darwin" } else { "Linux" }));
    }

    #[test]
    fn probe_finds_managed_node_before_the_system_one_and_claude_candidates() {
        let f = Fake::new();
        f.stub_node("v18.0.0");
        write_exec(&f.home.join(".intely/node/bin/node"), "#!/bin/sh\necho v24.13.0\n");
        write_exec(&f.home.join(".local/bin/claude"), "#!/bin/sh\necho 2.0.0\n");
        let st = probe(&f.ssh, &f.cfg, "1.1.1");
        assert_eq!(st.node.version.as_deref(), Some("v24.13.0"));
        assert!(st.node.path.unwrap().ends_with(".intely/node/bin/node"));
        assert!(st.claude.path.unwrap().ends_with(".local/bin/claude"));
        assert_eq!(st.claude.version.as_deref(), Some("2.0.0"));
        // managed claude wins over ~/.local/bin
        write_exec(&f.home.join(".intely/claude/bin/claude"), "#!/bin/sh\necho 2.2.0\n");
        let st = probe(&f.ssh, &f.cfg, "1.1.1");
        assert_eq!(st.claude.version.as_deref(), Some("2.2.0"));
    }

    #[test]
    fn probe_reads_login_state() {
        let f = Fake::new();
        assert_eq!(probe(&f.ssh, &f.cfg, "1").claude.logged_in, None);
        std::fs::write(f.home.join(".claude.json"), "{\"oauthAccount\":{}}").unwrap();
        assert_eq!(probe(&f.ssh, &f.cfg, "1").claude.logged_in, Some(true));
        std::fs::remove_file(f.home.join(".claude.json")).unwrap();
        std::fs::create_dir_all(f.home.join(".claude")).unwrap();
        std::fs::write(f.home.join(".claude/.credentials.json"), "{}").unwrap();
        assert_eq!(probe(&f.ssh, &f.cfg, "1").claude.logged_in, Some(true));
    }

    #[test]
    fn probe_runs_the_sidecar_probe_of_the_current_bundle() {
        let f = Fake::new();
        f.stub_node("v24.9.0");
        f.stub_claude();
        let res = f.resources("res", true);
        copy_dir(&res, &f.home.join(".intely/1.1.1/resources"));
        let st = probe(&f.ssh, &f.cfg, "1.1.1");
        assert!(st.bundle.ok && st.sdk.ok, "{st:?}");
        assert_eq!(st.sdk.version.as_deref(), Some("0.3.1"));
        assert!(st.ready);
        // another version is not probed
        assert!(!probe(&f.ssh, &f.cfg, "1.1.2").ready);
    }

    #[test]
    fn unreachable_servers_become_a_status_not_a_panic() {
        let f = Fake::new();
        for (dest, code) in [("refused.test", "refused"), ("badkey.test", "host_key"), ("denied.test", "auth")] {
            let c = ServerCfg { destination: dest.into(), ..f.cfg.clone() };
            let st = probe(&f.ssh, &c, "1.1.1");
            assert!(!st.reachable && !st.ready, "{dest}");
            let e = st.error.unwrap();
            assert_eq!(e.code, code);
            assert!(e.hint.is_some() && !e.message.is_empty());
        }
        let bad = ServerCfg { destination: "-oX=y".into(), ..f.cfg.clone() };
        assert!(!probe(&f.ssh, &bad, "1").reachable);
    }
}
