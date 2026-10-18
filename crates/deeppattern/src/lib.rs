//! DeepPattern's Decision Engine on this computer: is it installed, is it activated, what does its Doctor say, and the commands that
//! install and activate it. The engine is a hosted service by invitation; its own installer asks for the endpoint and the activation key
//! in a masked window of its own and keeps the device credentials in its own `config.json`. IntelyIDE never holds, asks for or sends
//! them: from that file only two facts are read (is an endpoint and a device credential there, and the host name of the endpoint),
//! and the Doctor output is scrubbed of anything that looks like a credential before it is shown.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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
        format!("\"{p}\"")
    } else {
        format!("'{}'", p.replace('\'', "'\\''"))
    }
}

pub fn commands(root: &Path) -> Commands {
    if cfg!(windows) {
        Commands {
            install: format!("git clone {PROJECT_URL} $HOME\\decision-engine; cd $HOME\\decision-engine; powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\dp-install.ps1"),
            activate: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\dp-install.ps1 -Activate".to_owned(),
            doctor: format!("powershell.exe -NoProfile -ExecutionPolicy Bypass -File {}", quote(&root.join("dp-doctor.ps1"))),
        }
    } else {
        Commands {
            install: format!("git clone {PROJECT_URL} ~/decision-engine && cd ~/decision-engine && bash ./dp-install.sh"),
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

/// Colour codes out, and every long run of key-like characters replaced: the Doctor says only whether a secret is set, but this does not rely on it.
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
    let out = plain
        .split(' ')
        .map(|word| {
            let keylike = word.chars().count() >= 32 && word.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+' | '=' | '.' | ':'));
            if keylike { "[hidden]" } else { word }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let out = out.trim();
    if out.chars().count() > MAX_LINE {
        format!("{}…", out.chars().take(MAX_LINE - 1).collect::<String>().trim_end())
    } else {
        out.to_owned()
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

fn drain(mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        while let Ok(n) = pipe.read(&mut chunk) {
            if n == 0 {
                break;
            }
            if buf.len() < MAX_OUTPUT {
                buf.extend_from_slice(&chunk[..n]);
            }
        }
        buf
    })
}

/// Runs the engine's own Doctor (`dp-doctor.sh`, `dp-doctor.ps1` on Windows) and returns what it says. It only reports.
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
    let started = Instant::now();
    let mut child = cmd.current_dir(root).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| DoctorError::Start(e.to_string()))?;
    let out = child.stdout.take().map(drain);
    let err = child.stderr.take().map(drain);
    let mut timed_out = false;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                timed_out = true;
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(DoctorError::Start(e.to_string())),
        }
    };
    // After a timeout a grandchild may still hold the pipes: do not wait for them, the readers end on their own.
    let join = |h: Option<std::thread::JoinHandle<Vec<u8>>>| if timed_out { Vec::new() } else { h.and_then(|h| h.join().ok()).unwrap_or_default() };
    let mut text = String::from_utf8_lossy(&join(out)).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&join(err)));
    Ok(parse_doctor(&text, code, started.elapsed().as_millis() as u64))
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
        let c = commands(Path::new("/Users/Jo O'Neil/.deeppattern/decision-engine"));
        if !cfg!(windows) {
            assert_eq!(c.activate, "cd '/Users/Jo O'\\''Neil/.deeppattern/decision-engine' && python3 -m installer.permanent_setup");
            assert!(c.doctor.starts_with("bash '/Users/Jo O'\\''Neil/") && c.doctor.ends_with("dp-doctor.sh'"));
            assert!(c.install.starts_with("git clone https://github.com/deeppatternai/decision-engine ~/decision-engine && cd ~/decision-engine") && c.install.ends_with("bash ./dp-install.sh"));
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
        std::fs::write(tmp.path().join("dp-doctor.sh"), "sleep 30\n").unwrap();
        let slow = run_doctor(tmp.path(), Duration::from_millis(300)).unwrap();
        assert_eq!(slow.verdict, Verdict::Error);
        assert_eq!(run_doctor(&tmp.path().join("nowhere"), Duration::from_secs(1)), Err(DoctorError::NotInstalled));
    }
}
