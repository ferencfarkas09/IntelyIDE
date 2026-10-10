//! Server setup: Prepare, Node, Bundle, Sdk, Claude, Verify. Each step skips itself when already satisfied, runs without
//! sudo and stops the run at the first failure.
//!
//! Events of the SDK step are replayed after the installer exits (the exec call returns the whole output at once).

use crate::cfg::{valid_version, ServerCfg};
use crate::probe::{probe_facts, status_from_facts, ProbeFacts, ServerStatus};
use crate::quote::{sh_quote, sh_quote_path_for_remote};
use crate::ssh::{tail, ExecOut, Ssh, SshError};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Node version that Setup installs when no Node >= 24 exists.
pub const NODE_VERSION: &str = "v24.13.0";
// sha256 of the official Linux tarballs, copied from https://nodejs.org/dist/v24.13.0/SHASUMS256.txt (2026-10-10).
// A value that is not 64 hex chars makes the Node step fail closed (see `node_pin_for`).
const NODE_SHA_LINUX_X64: &str = "e798599612f4bb71333a3397ab0d095fd62214e115aea45aa858a145fc72d67e";
const NODE_SHA_LINUX_ARM64: &str = "aa881151bd0f9f154a0424dd60a72e9ce10672619121658c278a24327ef46831";

const T_SHORT: Duration = Duration::from_secs(60);
const T_LONG: Duration = Duration::from_secs(600);

/// What to install and from where.
#[derive(Debug, Clone)]
pub struct SetupOptions {
    /// Local dir with `sidecar/{index.js,sdk-install.js,package.json}` and `sdk-pin/`.
    pub resources_dir: PathBuf,
    /// The running app version; names the bundle dir on the server.
    pub app_version: String,
    /// Install Node when none >= 24 is found.
    pub install_node: bool,
    /// Upload the sidecar bundle when missing.
    pub install_bundle: bool,
    /// Run the SDK installer when the sidecar reports no SDK.
    pub install_sdk: bool,
    /// Install the Claude CLI when none is found.
    pub install_claude: bool,
}

/// The setup steps, in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupStep {
    /// Look at the server.
    Probe,
    /// Create `~/.intely` (mode 700).
    Prepare,
    /// Install Node.
    Node,
    /// Upload the sidecar bundle.
    Bundle,
    /// Install the Agent SDK.
    Sdk,
    /// Install the Claude CLI.
    Claude,
    /// Probe again.
    Verify,
}

/// What happened to a step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    /// Running.
    Started,
    /// Finished.
    Done,
    /// Nothing to do.
    Skipped,
    /// Stopped the run.
    Failed,
    /// A progress line inside a running step.
    Info,
}

/// One progress event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SetupEvent {
    /// The step.
    pub step: SetupStep,
    /// Its state.
    pub state: StepState,
    /// A short plain-English line.
    pub message: String,
}

/// The step that failed, why, and the last 2 KiB of the server's output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SetupError {
    /// The failed step.
    pub step: SetupStep,
    /// One line.
    pub message: String,
    /// Stderr tail, max 2 KiB.
    pub tail: String,
}

impl std::fmt::Display for SetupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "setup step {:?} failed: {}", self.step, self.message)
    }
}
impl std::error::Error for SetupError {}

/// A pinned Node download.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodePin {
    /// Download URL (https, nodejs.org).
    pub url: String,
    /// Expected sha256 (64 hex chars).
    pub sha256: &'static str,
    /// File name of the tarball.
    pub file: String,
    /// Directory name below `~/.intely`.
    pub dir: String,
}

/// The pinned Node for `uname -s` / `uname -m` values. `None` for anything but Linux x64/arm64, and when the pinned hash
/// is not a real sha256 (fail closed).
pub fn node_pin_for(os: &str, arch: &str) -> Option<NodePin> {
    if os != "Linux" {
        return None;
    }
    let (tag, sha) = match arch {
        "x86_64" | "amd64" => ("x64", NODE_SHA_LINUX_X64),
        "aarch64" | "arm64" => ("arm64", NODE_SHA_LINUX_ARM64),
        _ => return None,
    };
    if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let dir = format!("node-{NODE_VERSION}-linux-{tag}");
    let file = format!("{dir}.tar.xz");
    Some(NodePin { url: format!("https://nodejs.org/dist/{NODE_VERSION}/{file}"), sha256: sha, file, dir })
}

const MANAGED_NODE: &str = "~/.intely/node/bin/node";

fn prepare_script() -> String {
    "mkdir -p \"$HOME/.intely\" && chmod 700 \"$HOME/.intely\"\n".into()
}

fn node_script(pin: &NodePin) -> String {
    let (url, sha, file, dir) = (sh_quote(&pin.url), sh_quote(pin.sha256), sh_quote(&pin.file), sh_quote(&pin.dir));
    format!(
        r#"set -eu
d="$HOME/.intely"; dl="$d/downloads"
mkdir -p "$dl"
f="$dl"/{file}
command -v xz >/dev/null 2>&1 || {{ echo "xz is needed to unpack Node (install xz-utils)" >&2; exit 14; }}
if command -v curl >/dev/null 2>&1; then curl -fsSL --proto '=https' --tlsv1.2 -o "$f.part" {url} </dev/null
elif command -v wget >/dev/null 2>&1; then wget -q -O "$f.part" {url} </dev/null
else echo "curl or wget is needed to download Node" >&2; exit 12; fi
if command -v sha256sum >/dev/null 2>&1; then sum=$(sha256sum "$f.part" </dev/null | awk '{{print $1}}')
else sum=$(shasum -a 256 "$f.part" </dev/null | awk '{{print $1}}'); fi
if [ "$sum" != {sha} ]; then rm -f "$f.part"; echo "sha256 mismatch for the Node download: $sum" >&2; exit 13; fi
mv "$f.part" "$f"
rm -rf "$d"/{dir}.tmp; mkdir "$d"/{dir}.tmp
tar -xJf "$f" -C "$d"/{dir}.tmp --strip-components=1 </dev/null
rm -rf "$d"/{dir}; mv "$d"/{dir}.tmp "$d"/{dir}
rm -f "$d/node"; ln -s {dir} "$d/node"
rm -f "$f"
"$d/node/bin/node" --version </dev/null
"#
    )
}

fn bundle_prep_script(v: &str) -> String {
    let tmp = sh_quote_path_for_remote(&format!("~/.intely/{v}.tmp"));
    format!("set -eu\nrm -rf {tmp}\nmkdir -p {tmp}/resources\n")
}

/// Moves the uploaded tree into place and keeps the two newest bundles (the new one always stays).
fn bundle_finish_script(v: &str) -> String {
    let qv = sh_quote(v);
    format!(
        r#"set -eu
d="$HOME/.intely"; v={qv}
chmod 600 "$d/$v.tmp/resources/sidecar/index.js" "$d/$v.tmp/resources/sidecar/sdk-install.js"
rm -rf "$d/$v"
mv "$d/$v.tmp" "$d/$v"
n=1
for p in $(ls -1t "$d" 2>/dev/null); do
  case $p in *[!A-Za-z0-9._+-]*|*.tmp) continue;; esac
  [ "$p" = "$v" ] && continue
  [ -f "$d/$p/resources/sidecar/index.js" ] || continue
  n=$((n+1))
  if [ "$n" -gt 2 ]; then rm -rf "$d/$p"; fi
done
"#
    )
}

fn node_dir_of(node: &str) -> &str {
    node.rsplit_once('/').map_or("", |(d, _)| d)
}

fn sdk_script(node: &str, v: &str) -> String {
    let js = sh_quote_path_for_remote(&format!("~/.intely/{v}/resources/sidecar/sdk-install.js"));
    format!(
        "PATH={}:\"$PATH\"; export PATH\nexec {} {js} --yes </dev/null\n",
        sh_quote_path_for_remote(node_dir_of(node)),
        sh_quote_path_for_remote(node)
    )
}

fn claude_script(node: &str) -> String {
    format!(
        r#"set -eu
PATH={}:"$PATH"; export PATH
mkdir -p "$HOME/.intely/claude"
npm install -g --no-audit --no-fund --prefix "$HOME/.intely/claude" @anthropic-ai/claude-code </dev/null
test -x "$HOME/.intely/claude/bin/claude"
"$HOME/.intely/claude/bin/claude" --version </dev/null
"#,
        sh_quote_path_for_remote(node_dir_of(node))
    )
}

/// Reads the installer's JSON lines: `(progress lines, final result)`. The final `result` is `Ok(summary)` for
/// `{"result":"ok"}` and `Err(reason)` for `{"result":"error"}`; `None` when no result line came.
pub fn parse_sdk_lines(stdout: &str) -> (Vec<String>, Option<Result<String, String>>) {
    let (mut progress, mut result) = (Vec::new(), None);
    for line in stdout.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let Some(o) = v.as_object() else { continue };
        let s = |k: &str| o.get(k).and_then(|x| x.as_str()).map(str::to_string);
        match o.get("result").and_then(|r| r.as_str()) {
            Some("ok") => result = Some(Ok(s("version").map_or("SDK installed".into(), |x| format!("SDK {x}")))),
            Some("error") => {
                let code = s("code").unwrap_or_default();
                let detail = s("detail").unwrap_or_default();
                result = Some(Err(format!("{code} {detail}").trim().to_string()));
            }
            Some(_) => {}
            None => {
                let text = match (s("stage").or_else(|| s("phase")), s("detail").or_else(|| s("message"))) {
                    (Some(a), Some(b)) => format!("{a}: {b}"),
                    (Some(a), None) | (None, Some(a)) => a,
                    (None, None) => line.chars().take(200).collect(),
                };
                progress.push(text.chars().take(300).collect());
            }
        }
    }
    (progress, result)
}

fn ev(on: &dyn Fn(SetupEvent), step: SetupStep, state: StepState, msg: impl Into<String>) {
    on(SetupEvent { step, state, message: msg.into() });
}

fn fail(step: SetupStep, message: impl Into<String>, tail_text: &str) -> SetupError {
    SetupError { step, message: message.into(), tail: tail(tail_text) }
}

fn from_ssh(step: SetupStep, e: SshError) -> SetupError {
    fail(step, e.to_string(), &e.detail)
}

/// Runs a script and requires exit 0.
fn run_step(ssh: &Ssh, cfg: &ServerCfg, step: SetupStep, script: &str, timeout: Duration) -> Result<ExecOut, SetupError> {
    let out = ssh.exec(cfg, script, timeout).map_err(|e| from_ssh(step, e))?;
    if out.success() {
        return Ok(out);
    }
    let both = format!("{}\n{}", out.stderr, out.stdout_text());
    Err(fail(step, format!("the command on the server exited with {}", out.code), &both))
}

fn check_resources(dir: &Path) -> Result<(), String> {
    for f in ["sidecar/index.js", "sidecar/sdk-install.js"] {
        if !dir.join(f).is_file() {
            return Err(format!("{f} is missing in {}", dir.display()));
        }
    }
    if !dir.join("sdk-pin").is_dir() {
        return Err(format!("sdk-pin is missing in {}", dir.display()));
    }
    Ok(())
}

/// Brings a server to the state where agents can run. Stops at the first failing step.
pub fn setup(
    ssh: &Ssh,
    cfg: &ServerCfg,
    opts: &SetupOptions,
    on_event: &dyn Fn(SetupEvent),
) -> Result<ServerStatus, SetupError> {
    let r = run_setup(ssh, cfg, opts, on_event);
    if let Err(e) = &r {
        ev(on_event, e.step, StepState::Failed, e.message.clone());
    }
    r
}

fn run_setup(
    ssh: &Ssh,
    cfg: &ServerCfg,
    opts: &SetupOptions,
    on: &dyn Fn(SetupEvent),
) -> Result<ServerStatus, SetupError> {
    use SetupStep as S;
    use StepState as T;
    let v = opts.app_version.as_str();
    if !valid_version(v) {
        return Err(fail(S::Probe, "the app version is not usable as a directory name", v));
    }

    ev(on, S::Probe, T::Started, "looking at the server");
    let facts: ProbeFacts = probe_facts(ssh, cfg, v).map_err(|e| from_ssh(S::Probe, e))?;
    ev(
        on,
        S::Probe,
        T::Done,
        format!("{} {}", facts.os.as_deref().unwrap_or("?"), facts.arch.as_deref().unwrap_or("?")),
    );

    ev(on, S::Prepare, T::Started, "creating ~/.intely");
    run_step(ssh, cfg, S::Prepare, &prepare_script(), T_SHORT)?;
    ev(on, S::Prepare, T::Done, "~/.intely is ready");

    // Node
    let mut node_path: Option<String> = if facts.node_ok() { facts.node.clone() } else { None };
    if !opts.install_node {
        ev(on, S::Node, T::Skipped, "installing Node is turned off");
    } else if node_path.is_some() {
        ev(on, S::Node, T::Skipped, format!("Node {} found", facts.node_version.as_deref().unwrap_or("?")));
    } else {
        ev(on, S::Node, T::Started, format!("installing Node {NODE_VERSION}"));
        let (os, arch) = (facts.os.as_deref().unwrap_or(""), facts.arch.as_deref().unwrap_or(""));
        let Some(pin) = node_pin_for(os, arch) else {
            return Err(fail(
                S::Node,
                format!("no Node download is pinned for {os} {arch}; install Node 24 or newer on the server yourself"),
                "",
            ));
        };
        if !facts.have_tar || !(facts.have_curl || facts.have_wget) || !facts.have_sha256 {
            return Err(fail(S::Node, "tar, curl or wget and sha256sum are needed to install Node", ""));
        }
        run_step(ssh, cfg, S::Node, &node_script(&pin), T_LONG)?;
        node_path = Some(MANAGED_NODE.to_string());
        ev(on, S::Node, T::Done, format!("Node {NODE_VERSION} installed in ~/.intely/node"));
    }

    // Bundle
    let bundle_before = facts.bundles.iter().any(|b| b == v);
    let mut bundle_ready = bundle_before;
    if !opts.install_bundle {
        ev(on, S::Bundle, T::Skipped, "uploading the sidecar is turned off");
    } else if bundle_before {
        ev(on, S::Bundle, T::Skipped, format!("bundle {v} is already there"));
    } else {
        ev(on, S::Bundle, T::Started, format!("uploading the sidecar {v}"));
        check_resources(&opts.resources_dir).map_err(|m| fail(S::Bundle, m, ""))?;
        run_step(ssh, cfg, S::Bundle, &bundle_prep_script(v), T_SHORT)?;
        ssh.push_tar(
            cfg,
            &opts.resources_dir,
            &["sidecar", "sdk-pin"],
            &format!("~/.intely/{v}.tmp/resources"),
            Duration::from_secs(300),
        )
        .map_err(|e| from_ssh(S::Bundle, e))?;
        run_step(ssh, cfg, S::Bundle, &bundle_finish_script(v), T_SHORT)?;
        bundle_ready = true;
        ev(on, S::Bundle, T::Done, format!("bundle {v} installed"));
    }

    // Sdk
    if !opts.install_sdk {
        ev(on, S::Sdk, T::Skipped, "installing the SDK is turned off");
    } else if bundle_before && facts.sdk().ok {
        ev(on, S::Sdk, T::Skipped, "the SDK is already installed");
    } else if !bundle_ready {
        return Err(fail(S::Sdk, "the sidecar bundle is missing, so the SDK installer cannot run", ""));
    } else if let Some(node) = &node_path {
        ev(on, S::Sdk, T::Started, "installing the Agent SDK");
        let out = ssh.exec(cfg, &sdk_script(node, v), T_LONG).map_err(|e| from_ssh(S::Sdk, e))?;
        let text = out.stdout_text();
        let (progress, result) = parse_sdk_lines(&text);
        for p in progress {
            ev(on, S::Sdk, T::Info, p);
        }
        match result {
            Some(Ok(msg)) if out.success() => ev(on, S::Sdk, T::Done, msg),
            Some(Err(why)) => return Err(fail(S::Sdk, format!("the SDK installer failed: {why}"), &out.stderr)),
            _ => {
                let both = format!("{}\n{text}", out.stderr);
                return Err(fail(S::Sdk, format!("the SDK installer ended without a result (exit {})", out.code), &both));
            }
        }
    } else {
        return Err(fail(S::Sdk, "Node 24 or newer is needed to install the SDK", ""));
    }

    // Claude
    if !opts.install_claude {
        ev(on, S::Claude, T::Skipped, "installing the Claude CLI is turned off");
    } else if facts.claude.is_some() {
        ev(on, S::Claude, T::Skipped, "the Claude CLI is already installed");
    } else if let Some(node) = &node_path {
        ev(on, S::Claude, T::Started, "installing the Claude CLI");
        run_step(ssh, cfg, S::Claude, &claude_script(node), T_LONG)?;
        ev(on, S::Claude, T::Done, "the Claude CLI is installed in ~/.intely/claude");
    } else {
        return Err(fail(S::Claude, "Node and npm are needed to install the Claude CLI", ""));
    }

    // Verify
    ev(on, S::Verify, T::Started, "checking the server again");
    let again = probe_facts(ssh, cfg, v).map_err(|e| from_ssh(S::Verify, e))?;
    let status = status_from_facts(&again, v);
    if !status.ready {
        let missing = status.missing().join(", ");
        return Err(fail(S::Verify, format!("the server is not ready, missing: {missing}"), &missing));
    }
    ev(on, S::Verify, T::Done, "the server is ready");
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::*;
    use std::cell::RefCell;

    fn opts(f: &Fake, res: PathBuf) -> SetupOptions {
        let _ = f;
        SetupOptions {
            resources_dir: res,
            app_version: "1.1.1".into(),
            install_node: false,
            install_bundle: true,
            install_sdk: true,
            install_claude: false,
        }
    }

    fn run(f: &Fake, o: &SetupOptions) -> (Result<ServerStatus, SetupError>, Vec<SetupEvent>) {
        let events = RefCell::new(Vec::new());
        let r = setup(&f.ssh, &f.cfg, o, &|e| events.borrow_mut().push(e));
        (r, events.into_inner())
    }

    fn state_of(ev: &[SetupEvent], step: SetupStep) -> Vec<StepState> {
        ev.iter().filter(|e| e.step == step).map(|e| e.state).collect()
    }

    fn ready_fake() -> Fake {
        let f = Fake::new();
        f.stub_node("v24.9.0");
        f.stub_claude();
        f
    }

    #[test]
    fn node_pins() {
        let p = node_pin_for("Linux", "x86_64").unwrap();
        assert_eq!(p.url, "https://nodejs.org/dist/v24.13.0/node-v24.13.0-linux-x64.tar.xz");
        assert_eq!(p.sha256, "e798599612f4bb71333a3397ab0d095fd62214e115aea45aa858a145fc72d67e");
        assert_eq!(p.dir, "node-v24.13.0-linux-x64");
        let p = node_pin_for("Linux", "aarch64").unwrap();
        assert!(p.url.ends_with("linux-arm64.tar.xz") && p.sha256.starts_with("aa88"));
        assert_eq!(node_pin_for("Linux", "arm64"), node_pin_for("Linux", "aarch64"));
        for (o, a) in [("Darwin", "arm64"), ("Linux", "armv7l"), ("Linux", "ppc64le"), ("FreeBSD", "x86_64"), ("", "")] {
            assert!(node_pin_for(o, a).is_none(), "{o} {a}");
        }
    }

    #[test]
    fn node_script_checks_the_pinned_hash_and_quotes_everything() {
        let s = node_script(&node_pin_for("Linux", "x86_64").unwrap());
        assert!(s.contains("'e798599612f4bb71333a3397ab0d095fd62214e115aea45aa858a145fc72d67e'"));
        assert!(s.contains("--proto '=https'"));
        assert!(s.contains("sha256 mismatch") && s.contains("exit 13"));
        assert!(!s.contains("sudo"));
        assert!(s.contains("ln -s 'node-v24.13.0-linux-x64' \"$d/node\""));
        // The hash check comes before the unpack.
        assert!(s.find("mismatch").unwrap() < s.find("tar -xJf").unwrap());
    }

    #[test]
    fn scripts_never_use_sudo_and_quote_the_version() {
        for s in [prepare_script(), bundle_prep_script("1.0"), bundle_finish_script("1.0"), sdk_script(MANAGED_NODE, "1.0"), claude_script(MANAGED_NODE)] {
            assert!(!s.contains("sudo"));
        }
        assert!(bundle_finish_script("1.0").contains("v='1.0'"));
        assert!(sdk_script("/opt/n d/bin/node", "1.0").contains("'/opt/n d/bin'"));
        assert!(sdk_script(MANAGED_NODE, "1.0").contains("\"$HOME\"/'.intely/node/bin'"));
    }

    #[test]
    fn sdk_lines_parse() {
        let (p, r) = parse_sdk_lines("{\"stage\":\"download\",\"detail\":\"x\"}\nnoise\n{\"phase\":\"verify\"}\n{\"result\":\"ok\",\"version\":\"0.3.1\"}\n");
        assert_eq!(p, ["download: x", "verify"]);
        assert_eq!(r, Some(Ok("SDK 0.3.1".into())));
        let (_, r) = parse_sdk_lines("{\"result\":\"error\",\"code\":\"hash\",\"detail\":\"mismatch\"}\n");
        assert_eq!(r, Some(Err("hash mismatch".into())));
        assert_eq!(parse_sdk_lines("nothing\n").1, None);
        assert_eq!(parse_sdk_lines("").0.len(), 0);
        let (_, r) = parse_sdk_lines("{\"result\":\"plan\"}\n[1]\n");
        assert_eq!(r, None);
    }

    #[test]
    fn sdk_installer_runs_and_its_progress_is_forwarded() {
        let f = ready_fake();
        let res = f.resources("res", false);
        let o = opts(&f, res);
        // The fixture's probe keeps saying "no SDK", so Verify fails after the installer ran: that is the point here.
        let (r, ev) = run(&f, &o);
        let err = r.unwrap_err();
        assert_eq!(err.step, SetupStep::Verify);
        assert!(err.message.contains("agent SDK"));
        assert_eq!(state_of(&ev, SetupStep::Sdk), [StepState::Started, StepState::Info, StepState::Done]);
        assert_eq!(state_of(&ev, SetupStep::Verify), [StepState::Started, StepState::Failed]);
        assert!(f.home.join("sdk-install-ran").is_file());
    }

    #[test]
    fn setup_reaches_ready_and_a_second_run_skips_everything() {
        let f = ready_fake();
        let res = f.resources("res", true);
        let mut o = opts(&f, res);
        o.install_sdk = false;
        let (r, ev) = run(&f, &o);
        let st = r.unwrap();
        assert!(st.ready);
        assert_eq!(state_of(&ev, SetupStep::Prepare), [StepState::Started, StepState::Done]);
        assert_eq!(state_of(&ev, SetupStep::Bundle), [StepState::Started, StepState::Done]);
        assert_eq!(state_of(&ev, SetupStep::Node), [StepState::Skipped]);
        assert_eq!(state_of(&ev, SetupStep::Verify), [StepState::Started, StepState::Done]);

        o.install_sdk = true;
        o.install_node = true;
        o.install_claude = true;
        let (r, ev) = run(&f, &o);
        assert!(r.unwrap().ready);
        for s in [SetupStep::Node, SetupStep::Bundle, SetupStep::Sdk, SetupStep::Claude] {
            assert_eq!(state_of(&ev, s), [StepState::Skipped], "{s:?}");
        }
        assert!(!f.home.join("sdk-install-ran").exists(), "SDK is ok, the installer must not run");
    }

    #[test]
    fn bundle_is_uploaded_atomically_with_private_files() {
        let f = ready_fake();
        let res = f.resources("res", true);
        let mut o = opts(&f, res);
        o.install_sdk = false;
        run(&f, &o).0.unwrap();
        let base = f.home.join(".intely/1.1.1/resources");
        assert!(base.join("sidecar/index.js").is_file() && base.join("sdk-pin/tree.sha256").is_file());
        assert!(!f.home.join(".intely/1.1.1.tmp").exists());
        use std::os::unix::fs::PermissionsExt;
        for n in ["index.js", "sdk-install.js"] {
            let mode = std::fs::metadata(base.join("sidecar").join(n)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode & 0o077, 0, "{n} {mode:o}");
        }
        let mode = std::fs::metadata(f.home.join(".intely")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[test]
    fn old_bundles_are_pruned_to_the_two_newest() {
        let f = ready_fake();
        for (v, t) in [("0.9.0", "202001010000"), ("0.9.1", "202002010000"), ("0.9.2", "202003010000")] {
            let d = f.home.join(".intely").join(v);
            std::fs::create_dir_all(d.join("resources/sidecar")).unwrap();
            std::fs::write(d.join("resources/sidecar/index.js"), "x").unwrap();
            assert!(std::process::Command::new("touch").args(["-t", t]).arg(&d).status().unwrap().success());
        }
        // Not a bundle: must survive.
        std::fs::create_dir_all(f.home.join(".intely/shims/a1")).unwrap();
        let res = f.resources("res", true);
        let mut o = opts(&f, res);
        o.install_sdk = false;
        run(&f, &o).0.unwrap();
        let left: Vec<bool> = ["0.9.0", "0.9.1", "0.9.2", "1.1.1"].iter().map(|v| f.home.join(".intely").join(v).exists()).collect();
        assert_eq!(left, [false, false, true, true]);
        assert!(f.home.join(".intely/shims/a1").exists());
    }

    #[test]
    fn a_failed_upload_leaves_no_half_installed_bundle() {
        let f = ready_fake();
        let res = f.resources("res", true);
        std::fs::remove_dir_all(res.join("sdk-pin")).unwrap();
        let o = opts(&f, res);
        let (r, ev) = run(&f, &o);
        let e = r.unwrap_err();
        assert_eq!(e.step, SetupStep::Bundle);
        assert!(e.message.contains("sdk-pin"));
        assert!(!f.home.join(".intely/1.1.1").exists());
        assert_eq!(state_of(&ev, SetupStep::Bundle).last(), Some(&StepState::Failed));
        assert!(state_of(&ev, SetupStep::Sdk).is_empty(), "the run stops at the first failure");
    }

    #[test]
    fn setup_stops_when_the_server_is_unreachable() {
        let f = ready_fake();
        let res = f.resources("res", true);
        let mut o = opts(&f, res);
        o.install_sdk = false;
        let cfg = ServerCfg { destination: "badkey.test".into(), ..f.cfg.clone() };
        let ev = RefCell::new(Vec::new());
        let e = setup(&f.ssh, &cfg, &o, &|x| ev.borrow_mut().push(x)).unwrap_err();
        assert_eq!(e.step, SetupStep::Probe);
        assert!(e.message.contains("host key"));
        assert_eq!(ev.borrow().len(), 2);
    }

    #[test]
    fn sdk_installer_error_is_reported() {
        let f = ready_fake();
        let res = f.resources("res", false);
        std::fs::write(
            res.join("sidecar/sdk-install.js"),
            "echo '{\"stage\":\"download\"}'\necho '{\"result\":\"error\",\"code\":\"hash\",\"detail\":\"tree mismatch\"}'\nexit 1\n",
        )
        .unwrap();
        let (r, ev) = run(&f, &opts(&f, res));
        let e = r.unwrap_err();
        assert_eq!(e.step, SetupStep::Sdk);
        assert!(e.message.contains("hash tree mismatch"), "{}", e.message);
        assert!(state_of(&ev, SetupStep::Sdk).contains(&StepState::Info));
    }

    #[test]
    fn sdk_installer_without_a_result_line_fails() {
        let f = ready_fake();
        let res = f.resources("res", false);
        std::fs::write(res.join("sidecar/sdk-install.js"), "echo hello\nexit 0\n").unwrap();
        let e = run(&f, &opts(&f, res)).0.unwrap_err();
        assert_eq!(e.step, SetupStep::Sdk);
        assert!(e.message.contains("without a result"));
    }

    #[test]
    fn missing_node_without_permission_to_install_it_fails_the_sdk_step() {
        let f = Fake::new();
        f.stub("node", "case \"$1\" in --version) echo v18.0.0; exit 0;; esac\nexit 1");
        let res = f.resources("res", false);
        let e = run(&f, &opts(&f, res)).0.unwrap_err();
        assert_eq!(e.step, SetupStep::Sdk);
        assert!(e.message.contains("Node 24"));
    }

    #[test]
    fn node_step_fails_clearly_on_an_unsupported_platform() {
        // The fake server is this machine: macOS has no pinned download, and old Node must be replaced.
        if cfg!(target_os = "linux") {
            return;
        }
        let f = Fake::new();
        f.stub("node", "case \"$1\" in --version) echo v18.0.0; exit 0;; esac\nexit 1");
        let res = f.resources("res", false);
        let mut o = opts(&f, res);
        o.install_node = true;
        let (r, ev) = run(&f, &o);
        let e = r.unwrap_err();
        assert_eq!(e.step, SetupStep::Node);
        assert!(e.message.contains("no Node download is pinned for Darwin"));
        assert_eq!(state_of(&ev, SetupStep::Node), [StepState::Started, StepState::Failed]);
    }

    #[test]
    fn claude_step_installs_with_npm_into_the_managed_prefix() {
        let f = Fake::new();
        if fixed_claude_present() {
            return;
        }
        f.stub_node("v24.9.0");
        // A fake npm that records its arguments and creates the binary.
        f.stub(
            "npm",
            "printf '%s\\n' \"$@\" > \"$HOME/npm-args\"\nprefix=\"\"\nwhile [ $# -gt 0 ]; do [ \"$1\" = --prefix ] && prefix=$2; shift; done\nmkdir -p \"$prefix/bin\"\nprintf '#!/bin/sh\\necho 2.0.0\\n' > \"$prefix/bin/claude\"\nchmod +x \"$prefix/bin/claude\"",
        );
        let res = f.resources("res", true);
        let mut o = opts(&f, res);
        o.install_sdk = false;
        o.install_claude = true;
        let (r, ev) = run(&f, &o);
        assert!(r.unwrap().ready);
        assert_eq!(state_of(&ev, SetupStep::Claude), [StepState::Started, StepState::Done]);
        let args = std::fs::read_to_string(f.home.join("npm-args")).unwrap();
        assert!(args.contains("install\n-g\n") && args.contains("@anthropic-ai/claude-code"));
        assert!(args.contains(&format!("{}/.intely/claude", f.home.display())));
    }

    #[test]
    fn verify_names_the_missing_pieces() {
        let f = Fake::new();
        if fixed_claude_present() {
            return;
        }
        f.stub_node("v24.9.0");
        let res = f.resources("res", true);
        let mut o = opts(&f, res);
        o.install_sdk = false;
        let e = run(&f, &o).0.unwrap_err();
        assert_eq!(e.step, SetupStep::Verify);
        assert_eq!(e.message, "the server is not ready, missing: claude CLI");
    }

    #[test]
    fn bad_app_versions_are_refused_before_anything_runs() {
        let f = ready_fake();
        let res = f.resources("res", true);
        for v in ["../x", "a b", "1;rm", ""] {
            let mut o = opts(&f, res.clone());
            o.app_version = v.into();
            let (r, ev) = run(&f, &o);
            assert!(r.is_err() && ev.len() == 1, "{v:?}");
        }
        assert!(!f.home.join(".intely").exists());
    }

    #[test]
    fn setup_error_tail_is_capped() {
        let f = ready_fake();
        let res = f.resources("res", true);
        let mut o = opts(&f, res.clone());
        o.install_sdk = false;
        // Make the finish script fail with a lot of output: the index.js chmod target is gone.
        std::fs::remove_file(res.join("sidecar/sdk-install.js")).unwrap();
        let e = run(&f, &o).0.unwrap_err();
        assert!(e.tail.len() <= 2048);
        assert_eq!(e.step, SetupStep::Bundle);
        assert!(e.to_string().contains("Bundle"));
    }
}
