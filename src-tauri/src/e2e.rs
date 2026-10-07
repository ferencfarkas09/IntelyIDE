//! End-to-end harness: `INTELY_E2E_SCRIPT=<file.js>` is evaluated in the webview after load and drives the real UI
//! through the DOM; it reports with the `e2e_report` command, after which the app exits (0 = ok, 1 = failed, 3 = timeout).
//! Inert unless `INTELY_E2E=1` and a script is given (in any build profile): without both nothing is read or injected,
//! and `e2e_report`/`e2e_screenshot`/`e2e_resize` refuse to run.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::time::Duration;

use tauri::{AppHandle, State};

pub struct E2e {
    script: Option<String>,
    report_path: Option<PathBuf>,
    timeout: Duration,
    store: Option<[u8; 16]>,
}

/// `INTELY_E2E_STORE`: 32 hex digits naming a persistent, isolated webview data store, so a scenario can relaunch the
/// app and find its localStorage again. Without it every run gets a fresh incognito store.
fn parse_store(value: &str) -> Option<[u8; 16]> {
    if value.len() != 32 || !value.is_ascii() {
        return None;
    }
    let mut id = [0u8; 16];
    for (i, byte) in id.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(id)
}

/// The script file to run, or `None` unless the flag is exactly `1` and a non-empty script path is present.
fn gated_script(flag: Option<&OsStr>, script: Option<OsString>) -> Option<PathBuf> {
    script.filter(|p| !p.is_empty() && flag.is_some_and(|v| v == "1")).map(PathBuf::from)
}

impl E2e {
    pub fn from_env() -> Self {
        let script = gated_script(std::env::var_os("INTELY_E2E").as_deref(), std::env::var_os("INTELY_E2E_SCRIPT"))
            .map(|p| std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("INTELY_E2E_SCRIPT {}: {e}", p.display())));
        let secs = std::env::var("INTELY_E2E_TIMEOUT_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(180);
        Self {
            script,
            report_path: std::env::var_os("INTELY_E2E_REPORT").map(PathBuf::from),
            timeout: Duration::from_secs(secs),
            store: std::env::var("INTELY_E2E_STORE").ok().and_then(|v| parse_store(&v)),
        }
    }

    pub fn store(&self) -> Option<[u8; 16]> {
        self.store
    }

    pub fn enabled(&self) -> bool {
        self.script.is_some()
    }

    /// The script wrapped so that it runs once after `load`, may use `await`, and reports its own exceptions.
    pub fn init_script(&self) -> Option<String> {
        let script = self.script.as_ref()?;
        let scenario = std::env::var("INTELY_E2E_SCENARIO").unwrap_or_else(|_| "e2e".to_owned());
        Some(format!(
            "window.__e2e_scenario = {};\n{}\nwindow.addEventListener('load', () => setTimeout(async () => {{ try {{\n{script}\n}} catch (e) {{ \
             window.__TAURI_INTERNALS__.invoke('e2e_report', {{ ok: false, report: {{ error: String(e && e.message || e) + ' | ' + String(e && e.stack || '') }} }}); }} }}, 0));",
            serde_json::to_string(&scenario).unwrap_or_default(),
            include_str!("e2e_helper.js"),
        ))
    }

    /// Ends the app with a timeout report if the script never reports.
    pub fn start_watchdog(&self, app: &AppHandle) {
        if !self.enabled() {
            return;
        }
        let (app, timeout, path) = (app.clone(), self.timeout, self.report_path.clone());
        std::thread::spawn(move || {
            std::thread::sleep(timeout);
            write_report(path.as_ref(), &serde_json::json!({ "ok": false, "error": "e2e timeout" }));
            app.exit(3);
            std::thread::sleep(Duration::from_secs(10));
            std::process::exit(3);
        });
    }
}

fn write_report(path: Option<&PathBuf>, report: &serde_json::Value) {
    let text = serde_json::to_string_pretty(report).unwrap_or_default();
    match path {
        Some(p) => {
            if let Err(e) = std::fs::write(p, &text) {
                eprintln!("e2e report {}: {e}", p.display());
            }
        }
        None => println!("INTELY_E2E_REPORT {text}"),
    }
}

/// Only works while a script is active; the engine is shut down by the `Exit` handler.
/// Whether a process is still alive (`kill -0`): scenarios use it to prove that a switch ended what it said it ended.
#[tauri::command]
pub fn e2e_pid_alive(e2e: State<'_, E2e>, pid: u32) -> Result<bool, String> {
    if !e2e.enabled() {
        return Err("e2e harness is not enabled".to_owned());
    }
    Ok(std::process::Command::new("/bin/kill").args(["-0", &pid.to_string()]).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success()))
}

#[tauri::command]
pub fn e2e_report(app: AppHandle, e2e: State<'_, E2e>, ok: bool, report: serde_json::Value) -> Result<(), String> {
    if !e2e.enabled() {
        return Err("e2e harness is not enabled".to_owned());
    }
    write_report(e2e.report_path.as_ref(), &serde_json::json!({ "ok": ok, "report": report }));
    app.exit(if ok { 0 } else { 1 });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate(flag: Option<&str>, script: Option<&str>) -> Option<PathBuf> {
        gated_script(flag.map(OsStr::new), script.map(OsString::from))
    }

    #[test]
    fn the_harness_needs_both_the_flag_and_a_script() {
        assert_eq!(gate(Some("1"), Some("/x/script.js")), Some(PathBuf::from("/x/script.js")));
        assert_eq!(gate(None, Some("/x/script.js")), None, "a script alone does nothing");
        assert_eq!(gate(Some("1"), None), None, "the flag alone does nothing");
        assert_eq!(gate(None, None), None);
    }

    #[test]
    fn only_the_exact_flag_value_one_enables_it() {
        for flag in ["0", "", "true", "yes", "11", " 1"] {
            assert_eq!(gate(Some(flag), Some("/x/script.js")), None, "INTELY_E2E={flag:?}");
        }
        assert_eq!(gate(Some("1"), Some("")), None, "an empty script path is no script");
    }

    #[test]
    fn the_store_id_is_32_hex_digits() {
        assert_eq!(parse_store("00112233445566778899aabbccddeeff"), Some([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]));
        for bad in ["", "abc", "00112233445566778899aabbccddeef", "00112233445566778899aabbccddeeffa", "zz112233445566778899aabbccddeeff", "é0112233445566778899aabbccddeef"] {
            assert_eq!(parse_store(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_disabled_harness_is_off_and_injects_nothing() {
        let off = E2e { script: None, report_path: None, timeout: Duration::from_secs(1), store: None };
        assert!(!off.enabled());
        assert!(off.init_script().is_none());
    }
}
