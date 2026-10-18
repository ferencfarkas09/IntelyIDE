//! DeepPattern's Decision Engine on this computer: is it installed, is it activated, what does its Doctor say, and the commands that
//! install and activate it. The engine is a hosted service by invitation; its own installer asks for the endpoint and the activation key
//! in a masked window of its own and keeps the device credentials in its own `config.json`. IntelyIDE never holds, asks for or sends
//! them: from that file only two facts are read (is an endpoint and a device credential there, and the host name of the endpoint),
//! and the Doctor output is scrubbed of anything that looks like a credential before it is shown.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// The public source of the engine and its installer.
pub const PROJECT_URL: &str = "https://github.com/deeppatternai/decision-engine";
/// Where the installer puts its signed copy, under the home directory.
const ROOT_UNDER_HOME: [&str; 2] = [".deeppattern", "decision-engine"];
const MAX_CONFIG: u64 = 64 * 1024;
const MAX_OUTPUT: usize = 256 * 1024;
const MAX_LINES: usize = 60;
const MAX_LINE: usize = 200;
/// Doctor starts Python and checks the pop-up backend; a minute is generous.
pub const DOCTOR_TIMEOUT: Duration = Duration::from_secs(60);

/// The installer's folder: `INTELY_DEEPPATTERN_HOME` when set (tests, a moved install), else `~/.deeppattern/decision-engine`.
pub fn root(home: &Path, override_dir: Option<&Path>) -> PathBuf {
    override_dir.map_or_else(|| ROOT_UNDER_HOME.iter().fold(home.to_path_buf(), |p, s| p.join(s)), Path::to_path_buf)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commands {
    /// Gets the sources into `~/decision-engine` and runs the installer, from any folder.
    pub install: String,
    /// The installer's activation step on an installed engine: asks for the endpoint and key in its own masked window.
    pub activate: String,
    /// The engine's own health check.
    pub doctor: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The installer's folder exists and holds the engine.
    pub installed: bool,
    /// An endpoint and a device credential are in its config (the Doctor is the proof).
    pub activated: bool,
    /// The host name of the endpoint, never the endpoint or a credential.
    pub endpoint_host: Option<String>,
    /// A half-finished activation that the installer asks to be recovered by hand.
    pub recovery_required: bool,
    /// The installer's folder, as shown to the person.
    pub root: String,
    /// A Doctor script is there to run.
    pub doctor: bool,
    pub commands: Commands,
}

fn quote(path: &Path) -> String {
    let p = path.to_string_lossy();
    if cfg!(windows) {
        // PowerShell: single quotes do not expand `$` or backticks; a quote inside is doubled
        format!("'{}'", p.replace('\'', "''"))
    } else {
        format!("'{}'", p.replace('\'', "'\\''"))
    }
}

pub fn commands(root: &Path) -> Commands {
    if cfg!(windows) {
        let clone = format!("$HOME\\decision-engine");
        Commands {
            // clones the first time, updates the folder when an earlier attempt left it there
            install: format!("if (Test-Path {clone}) {{ git -C {clone} pull --ff-only }} else {{ git clone {PROJECT_URL} {clone} }}; cd {clone}; powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\dp-install.ps1"),
            activate: format!("cd {clone}; powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\dp-install.ps1 -Activate"),
            doctor: format!("powershell.exe -NoProfile -ExecutionPolicy Bypass -File {}", quote(&root.join("dp-doctor.ps1"))),
        }
    } else {
        Commands {
            install: format!("(git clone {PROJECT_URL} ~/decision-engine || git -C ~/decision-engine pull --ff-only) && cd ~/decision-engine && bash ./dp-install.sh"),
            activate: format!("cd {} && python3 -m installer.permanent_setup", quote(root)),
            doctor: format!("bash {}", quote(&root.join("dp-doctor.sh"))),
        }
    }
}

fn doctor_script(root: &Path) -> PathBuf {
    root.join(if cfg!(windows) { "dp-doctor.ps1" } else { "dp-doctor.sh" })
}

/// `https://user:pw@host:8443/path` -> `host:8443`; nothing for a value that is not a URL.
fn host_of(endpoint: &str) -> Option<String> {
    let rest = endpoint.trim().split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?;
    (!host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))).then(|| host.to_owned())
}

/// What `config.json` says, without keeping a value: (an endpoint host, a device credential is present).
fn read_config(root: &Path) -> (Option<String>, bool, bool) {
    let path = root.join("config.json");
    let Ok(meta) = std::fs::metadata(&path) else { return (None, false, false) };
    if !meta.is_file() || meta.len() > MAX_CONFIG {
        return (None, false, false);
    }
    let Ok(bytes) = std::fs::read(&path) else { return (None, false, false) };
    let Ok(serde_json::Value::Object(map)) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return (None, false, false) };
    let text = |keys: &[&str]| keys.iter().find_map(|k| map.get(*k).and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()));
    let endpoint = text(&["endpoint", "base_url", "baseUrl", "server_url", "serverUrl", "url"]);
    let credential = text(&["access_token", "accessToken", "device_token", "deviceToken", "token", "device_secret"]).is_some();
    (endpoint.and_then(host_of), endpoint.is_some(), credential)
}

pub fn status(root: &Path) -> Status {
    let installed = root.is_dir() && (root.join("installer").is_dir() || root.join("config.json").is_file() || doctor_script(root).is_file());
    let (host, has_endpoint, has_credential) = if installed { read_config(root) } else { (None, false, false) };
    Status {
        installed,
        activated: has_endpoint && has_credential,
        endpoint_host: host,
        recovery_required: installed && root.join(".runtime").join("activation-recovery-required.json").is_file(),
        root: root.to_string_lossy().into_owned(),
        doctor: doctor_script(root).is_file(),
        commands: commands(root),
    }
}

// ---------------------------------------------------------------- the Doctor

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Pass,
    Warn,
    Fail,
    /// It could not be run or ended in an unexpected way.
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    Ok,
    Warn,
    Fail,
    Info,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorLine {
    pub tone: Tone,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub verdict: Verdict,
    pub exit_code: Option<i32>,
    pub lines: Vec<DoctorLine>,
    pub took_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DoctorError {
    NotInstalled,
    Start(String),
}

const WRAPPERS: &str = "\"'()[]<>{},;";
const SECRET_WORDS: [&str; 11] = ["token", "secret", "password", "passwd", "apikey", "api_key", "api-key", "authorization", "credential", "credentials", "bearer"];

/// A word that looks like a key: at least 20 characters mixing letters and digits, not a path. (A long word without a digit, such as a
/// dotted name, is not one.)
fn keylike(core: &str) -> bool {
    let pathlike = core.starts_with('/') || core.starts_with('~') || core.contains(":\\");
    let chars = core.chars().count();
    let alphabet = core.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+' | '=' | '.' | ':' | '/'));
    let mixed = core.chars().any(|c| c.is_ascii_digit()) && core.chars().any(|c| c.is_ascii_alphabetic());
    !pathlike && alphabet && chars >= 20 && mixed
}

/// One word of a line, with its wrapping quotes and brackets kept: an address is cut down to its host, the value of `key=value` or the
/// word after `token:` is hidden, and anything that looks like a key is hidden.
fn scrub_word(word: &str, after_key: bool) -> String {
    let core = word.trim_matches(|c| WRAPPERS.contains(c));
    if core.is_empty() {
        return word.to_owned();
    }
    let start = word.find(core).unwrap_or(0);
    let (head, tail) = (&word[..start], &word[start + core.len()..]);
    let hidden = if core.contains("://") {
        let scheme = core.split("://").next().unwrap_or("https");
        match host_of(core) {
            Some(host) if scheme.chars().all(|c| c.is_ascii_alphabetic()) => format!("{scheme}://{host}"),
            _ => "[hidden]".to_owned(),
        }
    } else if after_key {
        "[hidden]".to_owned()
    } else if let Some((key, value)) = core.split_once(['=', ':']).filter(|(k, v)| !k.is_empty() && !v.is_empty()) {
        let secret_key = SECRET_WORDS.iter().any(|w| key.to_lowercase().contains(w));
        if secret_key || keylike(value) {
            let lead: String = value.chars().take_while(|c| WRAPPERS.contains(*c)).collect();
            format!("{key}{}{lead}[hidden]", &core[key.len()..key.len() + 1])
        } else {
            return word.to_owned();
        }
    } else if keylike(core) {
        "[hidden]".to_owned()
    } else {
        return word.to_owned();
    };
    format!("{head}{hidden}{tail}")
}

/// Colour codes out; addresses cut to their host; and every value that is, or sits next to the name of, a credential replaced. The Doctor
/// says only whether a secret is set, but nothing here relies on that.
pub fn scrub(line: &str) -> String {
    let mut plain = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for n in chars.by_ref() {
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else if !c.is_control() || c == '\t' {
            plain.push(c);
        }
    }
    let mut out: Vec<String> = Vec::new();
    let mut previous = String::new();
    for word in plain.split_whitespace() {
        // the name before this word ends in a colon or an equals sign, or is "Bearer"/"Basic": this word is its value
        let name = previous.trim_matches(|c: char| WRAPPERS.contains(c) || c == ':' || c == '=').to_lowercase();
        let separated = previous.trim_end_matches(|c: char| "\"'".contains(c)).ends_with([':', '=']);
        let after_key = (separated && SECRET_WORDS.iter().any(|w| name == *w || name.ends_with(w))) || matches!(name.as_str(), "bearer" | "basic");
        out.push(scrub_word(word, after_key));
        previous = word.to_owned();
    }
    let out = out.join(" ");
    if out.chars().count() > MAX_LINE {
        format!("{}…", out.chars().take(MAX_LINE - 1).collect::<String>().trim_end())
    } else {
        out
    }
}

fn tone_of(line: &str) -> Tone {
    let up = line.to_uppercase();
    let has = |words: &[&str]| words.iter().any(|w| up.contains(w));
    if has(&["FAIL", "ERROR", "✗", "✘", "[X]"]) {
        Tone::Fail
    } else if has(&["WARN"]) {
        Tone::Warn
    } else if has(&["PASS", "[OK]", " OK", "✓", "✔"]) || up.starts_with("OK") {
        Tone::Ok
    } else {
        Tone::Info
    }
}

/// The report of one Doctor run: the exit code decides (0 PASS or WARN, 1 a real failure, 2 invalid arguments), the lines are shown as they came.
pub fn parse_doctor(output: &str, exit_code: Option<i32>, took_ms: u64) -> DoctorReport {
    let lines: Vec<DoctorLine> = output.lines().map(scrub).filter(|l| !l.is_empty()).take(MAX_LINES).map(|text| DoctorLine { tone: tone_of(&text), text }).collect();
    let verdict = match exit_code {
        Some(0) if lines.iter().any(|l| l.tone == Tone::Warn) => Verdict::Warn,
        Some(0) => Verdict::Pass,
        Some(1) => Verdict::Fail,
        _ => Verdict::Error,
    };
    DoctorReport { verdict, exit_code, lines, took_ms }
}

/// Reads a pipe to its end into the shared buffer (kept to [`MAX_OUTPUT`]), so that what came is there even if the program never ends.
fn drain(mut pipe: impl Read + Send + 'static, into: Arc<Mutex<Vec<u8>>>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        while let Ok(n) = pipe.read(&mut chunk) {
            if n == 0 {
                break;
            }
            let mut buf = into.lock().unwrap_or_else(|e| e.into_inner());
            if buf.len() < MAX_OUTPUT {
                buf.extend_from_slice(&chunk[..n]);
            }
        }
    })
}

/// Stops the check and whatever it started: on Unix it ran in its own process group, so the whole group gets the signal.
fn stop(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-KILL", "--", &format!("-{}", child.id())]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Runs the engine's own Doctor (`dp-doctor.sh`, `dp-doctor.ps1` on Windows) and returns what it says. It only reports. A check that
/// runs past `timeout` is stopped with everything it started, and what it had said so far is kept.
pub fn run_doctor(root: &Path, timeout: Duration) -> Result<DoctorReport, DoctorError> {
    let script = doctor_script(root);
    if !script.is_file() {
        return Err(DoctorError::NotInstalled);
    }
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("powershell.exe");
        c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]).arg(&script);
        c
    } else {
        let mut c = Command::new("bash");
        c.arg(&script);
        c
    };
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000); // CREATE_NO_WINDOW
    let started = Instant::now();
    let mut child = cmd.current_dir(root).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| DoctorError::Start(e.to_string()))?;
    let out = Arc::new(Mutex::new(Vec::new()));
    let err = Arc::new(Mutex::new(Vec::new()));
    let readers: Vec<_> = [child.stdout.take().map(|p| drain(p, out.clone())), child.stderr.take().map(|p| drain(p, err.clone()))].into_iter().flatten().collect();
    let mut timed_out = false;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if started.elapsed() > timeout => {
                stop(&mut child);
                timed_out = true;
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(DoctorError::Start(e.to_string())),
        }
    };
    // the readers end with the pipes; a program that left a child holding them does not hold us: wait a moment, then go on with what there is
    let grace = Instant::now();
    while grace.elapsed() < Duration::from_secs(1) && !readers.iter().all(|r| r.is_finished()) {
        std::thread::sleep(Duration::from_millis(10));
    }
    let take = |b: &Arc<Mutex<Vec<u8>>>| String::from_utf8_lossy(&b.lock().unwrap_or_else(|e| e.into_inner())).into_owned();
    let text = format!("{}\n{}", take(&out), take(&err));
    let mut report = parse_doctor(&text, code, started.elapsed().as_millis() as u64);
    if timed_out {
        report.lines.push(DoctorLine { tone: Tone::Fail, text: format!("Stopped: the check took longer than {} seconds.", timeout.as_secs()) });
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine(dir: &Path, config: Option<&str>) {
        std::fs::create_dir_all(dir.join("installer")).unwrap();
        if let Some(c) = config {
            std::fs::write(dir.join("config.json"), c).unwrap();
        }
    }

    #[test]
    fn the_root_is_under_home_unless_told_otherwise() {
        assert_eq!(root(Path::new("/home/a"), None), Path::new("/home/a/.deeppattern/decision-engine"));
        assert_eq!(root(Path::new("/home/a"), Some(Path::new("/opt/de"))), Path::new("/opt/de"));
    }

    #[test]
    fn nothing_there_is_not_installed() {
        let tmp = tempfile::tempdir().unwrap();
        let s = status(&tmp.path().join("missing"));
        assert!(!s.installed && !s.activated && s.endpoint_host.is_none() && !s.doctor);
    }

    #[test]
    fn an_installed_engine_without_credentials_is_not_activated() {
        let tmp = tempfile::tempdir().unwrap();
        engine(tmp.path(), None);
        let s = status(tmp.path());
        assert!(s.installed && !s.activated);
        std::fs::write(tmp.path().join("config.json"), r#"{"endpoint":"https://de.example.com/api"}"#).unwrap();
        let s = status(tmp.path());
        assert!(!s.activated, "an endpoint alone is not an activation");
        assert_eq!(s.endpoint_host.as_deref(), Some("de.example.com"));
    }

    #[test]
    fn an_endpoint_and_a_device_credential_mean_activated_and_only_the_host_is_returned() {
        let tmp = tempfile::tempdir().unwrap();
        engine(tmp.path(), Some(r#"{"endpoint":"https://user:pw@de.example.com:8443/v1","access_token":"SECRET-TOKEN-VALUE","device_id":"d-1"}"#));
        let s = status(tmp.path());
        assert!(s.activated);
        assert_eq!(s.endpoint_host.as_deref(), Some("de.example.com:8443"));
        let shown = format!("{s:?}");
        assert!(!shown.contains("SECRET-TOKEN-VALUE") && !shown.contains("pw@"), "{shown}");
    }

    #[test]
    fn a_broken_or_huge_config_is_ignored_and_a_recovery_marker_is_reported() {
        let tmp = tempfile::tempdir().unwrap();
        engine(tmp.path(), Some("not json"));
        assert!(status(tmp.path()).installed && !status(tmp.path()).activated);
        std::fs::write(tmp.path().join("config.json"), vec![b' '; 70_000]).unwrap();
        assert!(!status(tmp.path()).activated);
        std::fs::create_dir_all(tmp.path().join(".runtime")).unwrap();
        std::fs::write(tmp.path().join(".runtime/activation-recovery-required.json"), "{}").unwrap();
        assert!(status(tmp.path()).recovery_required);
    }

    #[test]
    fn the_commands_quote_the_folder() {
        let c = commands(Path::new("/Users/me/Jo O'Neil/.deeppattern/decision-engine"));
        if !cfg!(windows) {
            assert_eq!(c.activate, "cd '/Users/me/Jo O'\\''Neil/.deeppattern/decision-engine' && python3 -m installer.permanent_setup");
            assert!(c.doctor.starts_with("bash '/Users/me/Jo O'\\''Neil/") && c.doctor.ends_with("dp-doctor.sh'"));
            // an earlier attempt that left the folder is updated, not a failure
            assert!(c.install.starts_with("(git clone https://github.com/deeppatternai/decision-engine ~/decision-engine || git -C ~/decision-engine pull --ff-only) && cd ~/decision-engine") && c.install.ends_with("bash ./dp-install.sh"));
        }
    }

    #[test]
    fn scrub_removes_colours_and_anything_that_looks_like_a_key() {
        assert_eq!(scrub("\u{1b}[32mPASS\u{1b}[0m python 3.12.4"), "PASS python 3.12.4");
        assert_eq!(scrub("token abcdefghijklmnopqrstuvwxyz0123456789ABCDEF set"), "token [hidden] set");
        assert_eq!(scrub("/Users/me/.deeppattern/decision-engine/dp-doctor.sh ok"), "/Users/me/.deeppattern/decision-engine/dp-doctor.sh ok");
        assert!(scrub(&"x ".repeat(300)).chars().count() <= MAX_LINE);
    }

    #[test]
    fn scrub_cuts_addresses_to_the_host_and_hides_values_in_every_shape_a_line_can_show_them() {
        assert_eq!(scrub("endpoint https://dev:SUPERSECRETPASSWORD123@de.example.com/api/v1/tenant-9f8e7d6c ok"), "endpoint https://de.example.com ok");
        assert_eq!(scrub(r#"{"access_token": "eyJhbGciOi.abc.def", "ok": true}"#), r#"{"access_token": "[hidden]", "ok": true}"#);
        assert_eq!(scrub(r#"token="s3cr3t-v4lue" set"#), r#"token="[hidden]" set"#);
        assert_eq!(scrub("key:\tK9f8a7sd6f5a4s3d2f1g"), "key: [hidden]");
        assert_eq!(scrub("Authorization: Bearer abc"), "Authorization: [hidden] [hidden]");
        assert_eq!(scrub("(A1b2C3d4E5f6G7h8I9j0K1l2)"), "([hidden])");
        assert_eq!(scrub("code DP-1234-ABCD-5678-EFGH printed"), "code [hidden] printed");
        assert_eq!(scrub("password=hunter2"), "password=[hidden]");
    }

    #[test]
    fn scrub_keeps_what_the_check_is_for() {
        for line in [
            "PASS Device activated (endpoint set, device credential set)",
            "installer.permanent_setup.activation_recovery_required",
            "PASS Python 3.12.7 at /Users/me/.deeppattern/decision-engine/python/bin/python3",
            "WARN LibreOffice not found (optional)",
            "device key is present",
        ] {
            assert_eq!(scrub(line), line);
        }
    }

    #[test]
    fn the_exit_code_decides_and_the_lines_get_a_tone() {
        let pass = parse_doctor("PASS python 3.12\nPASS skills linked\n", Some(0), 5);
        assert_eq!(pass.verdict, Verdict::Pass);
        assert!(pass.lines.iter().all(|l| l.tone == Tone::Ok));
        let warn = parse_doctor("PASS a\nWARN libreoffice missing\n", Some(0), 5);
        assert_eq!(warn.verdict, Verdict::Warn);
        assert_eq!(warn.lines[1].tone, Tone::Warn);
        let fail = parse_doctor("FAIL device not activated\n", Some(1), 5);
        assert_eq!((fail.verdict, fail.lines[0].tone), (Verdict::Fail, Tone::Fail));
        assert_eq!(parse_doctor("", Some(2), 5).verdict, Verdict::Error);
        assert_eq!(parse_doctor("", None, 5).verdict, Verdict::Error);
        let many = parse_doctor(&"line\n".repeat(200), Some(0), 5);
        assert_eq!(many.lines.len(), MAX_LINES);
    }

    #[cfg(unix)]
    #[test]
    fn the_doctor_script_is_run_and_its_output_scrubbed() {
        let tmp = tempfile::tempdir().unwrap();
        engine(tmp.path(), None);
        std::fs::write(tmp.path().join("dp-doctor.sh"), "echo 'PASS python 3.12'\necho 'WARN libreoffice missing'\necho 'secret ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd' >&2\nexit 0\n").unwrap();
        assert!(status(tmp.path()).doctor);
        let report = run_doctor(tmp.path(), Duration::from_secs(10)).unwrap();
        assert_eq!(report.verdict, Verdict::Warn);
        assert!(report.lines.iter().any(|l| l.text == "PASS python 3.12"));
        assert!(report.lines.iter().any(|l| l.text == "secret [hidden]"), "{:?}", report.lines);
        std::fs::write(tmp.path().join("dp-doctor.sh"), "exit 1\n").unwrap();
        assert_eq!(run_doctor(tmp.path(), Duration::from_secs(10)).unwrap().verdict, Verdict::Fail);
        // a check that never ends, with a child that holds the pipes: stopped at the limit, what it said is kept, nothing is left running
        std::fs::write(tmp.path().join("dp-doctor.sh"), "echo 'PASS first line'\n(sleep 30 &)\nsleep 30\n").unwrap();
        let t = Instant::now();
        let slow = run_doctor(tmp.path(), Duration::from_millis(400)).unwrap();
        assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
        assert_eq!(slow.verdict, Verdict::Error);
        assert!(slow.lines.iter().any(|l| l.text == "PASS first line"), "{:?}", slow.lines);
        assert!(slow.lines.iter().any(|l| l.text.starts_with("Stopped: the check took longer than")), "{:?}", slow.lines);
        assert_eq!(run_doctor(&tmp.path().join("nowhere"), Duration::from_secs(1)), Err(DoctorError::NotInstalled));
    }
}
