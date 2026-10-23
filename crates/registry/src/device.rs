//! What the registry learns about this computer, and nothing else: the system and its version, the architecture, the number of
//! cores, the memory in whole gigabytes, the language and the time zone, and a fingerprint. The fingerprint is a SHA-256 of the
//! machine id of the operating system with a fixed prefix; the raw id never leaves this module, and the registry hashes it again
//! with a secret of its own. No host name, no user name, no disk, no network address.

#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::process::{Command, Stdio};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    /// 64 hex characters.
    pub id: String,
    pub os: &'static str,
    pub os_version: String,
    pub arch: &'static str,
    pub cpu_cores: u32,
    /// Whole gigabytes, 0 when the system did not say.
    pub ram_gb: u32,
    pub locale: String,
    pub tz: String,
}

impl Device {
    /// The part of the details that can change between two starts (the registry knows the id from the token).
    pub fn update_json(&self) -> Value {
        json!({ "os": self.os, "osVersion": self.os_version, "arch": self.arch, "cpuCores": self.cpu_cores, "ramGb": self.ram_gb, "locale": self.locale, "tz": self.tz })
    }

    pub fn full_json(&self) -> Value {
        let mut v = self.update_json();
        v["id"] = json!(self.id);
        v
    }
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// The fingerprint of a machine id: not reversible, and the same on every start.
pub fn fingerprint(raw_machine_id: &str) -> String {
    sha256_hex(&format!("intelyide:v1:{}", raw_machine_id.trim().to_ascii_lowercase()))
}

fn keep(s: &str, max: usize, allowed: impl Fn(char) -> bool, fallback: &str) -> String {
    let t: String = s.trim().chars().filter(|c| allowed(*c)).take(max).collect();
    if t.is_empty() {
        fallback.to_owned()
    } else {
        t
    }
}

pub fn clean_locale(s: &str) -> String {
    keep(s, 35, |c| c.is_ascii_alphanumeric() || matches!(c, '_' | '@' | '.' | '-'), "und")
}

pub fn clean_tz(s: &str) -> String {
    keep(s, 64, |c| c.is_ascii_alphanumeric() || matches!(c, '_' | '/' | '+' | '-'), "UTC")
}

fn clean_version(s: &str) -> String {
    keep(s, 40, |c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '+' | '(' | ')' | '-' | '_'), "unknown")
}

// ----------------------------------------------------------------------------------------------------- parsers (pure, tested)

/// `"IOPlatformUUID" = "564D1234-..."` out of `ioreg -rd1 -c IOPlatformExpertDevice`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn parse_ioreg_uuid(out: &str) -> Option<String> {
    let line = out.lines().find(|l| l.contains("IOPlatformUUID"))?;
    let value = line.split('=').nth(1)?.trim().trim_matches('"').trim();
    (value.len() >= 16 && value.chars().all(|c| c.is_ascii_hexdigit() || c == '-')).then(|| value.to_owned())
}

/// `MemTotal:       16384000 kB` out of `/proc/meminfo`, in whole gigabytes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn parse_meminfo_gb(text: &str) -> Option<u32> {
    let kb: u64 = text.lines().find_map(|l| l.strip_prefix("MemTotal:"))?.split_whitespace().next()?.parse().ok()?;
    Some(bytes_to_gb(kb.saturating_mul(1024)))
}

pub(crate) fn bytes_to_gb(bytes: u64) -> u32 {
    u32::try_from(bytes.saturating_add(1 << 29) >> 30).unwrap_or(u32::MAX).min(4096)
}

/// `VERSION_ID="24.04"` out of `/etc/os-release`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn parse_os_release(text: &str) -> Option<String> {
    let v = text.lines().find_map(|l| l.strip_prefix("VERSION_ID="))?.trim().trim_matches('"');
    (!v.is_empty()).then(|| v.to_owned())
}

/// `    MachineGuid    REG_SZ    4c4c4544-...` out of `reg query`.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn parse_reg_guid(out: &str) -> Option<String> {
    let line = out.lines().find(|l| l.contains("MachineGuid"))?;
    let v = line.split_whitespace().last()?;
    (v.len() >= 16 && v.chars().all(|c| c.is_ascii_hexdigit() || c == '-')).then(|| v.to_owned())
}

// ----------------------------------------------------------------------------------------------------- the system

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn run(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(target_os = "macos")]
fn system() -> (Option<String>, String, u32) {
    let id = run("/usr/sbin/ioreg", &["-rd1", "-c", "IOPlatformExpertDevice"]).and_then(|o| parse_ioreg_uuid(&o));
    let version = run("/usr/bin/sw_vers", &["-productVersion"]).map(|v| v.trim().to_owned()).unwrap_or_default();
    let ram = run("/usr/sbin/sysctl", &["-n", "hw.memsize"]).and_then(|v| v.trim().parse::<u64>().ok()).map_or(0, bytes_to_gb);
    (id, version, ram)
}

#[cfg(target_os = "linux")]
fn system() -> (Option<String>, String, u32) {
    let read = |p: &str| std::fs::read_to_string(p).ok();
    let id = read("/etc/machine-id").map(|s| s.trim().to_owned()).filter(|s| s.len() >= 16);
    let version = read("/etc/os-release").and_then(|t| parse_os_release(&t)).unwrap_or_default();
    let ram = read("/proc/meminfo").and_then(|t| parse_meminfo_gb(&t)).unwrap_or(0);
    (id, version, ram)
}

#[cfg(target_os = "windows")]
fn system() -> (Option<String>, String, u32) {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_owned());
    let reg = format!("{root}\\System32\\reg.exe");
    let id = run(&reg, &["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]).and_then(|o| parse_reg_guid(&o));
    (id, String::new(), 0)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn system() -> (Option<String>, String, u32) {
    (None, String::new(), 0)
}

fn os_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        "linux" => "linux",
        _ => "other",
    }
}

fn arch_name() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        "x86_64" => "x86_64",
        _ => "other",
    }
}

/// Reads this computer. `fallback_id` stands in for the machine id when the system has none (a random id kept in Settings).
/// Blocking: it starts a few small programs on macOS and Windows.
pub fn collect(locale: &str, tz: &str, fallback_id: &str) -> Device {
    let (machine, version, ram_gb) = system();
    let cores = std::thread::available_parallelism().map_or(1, |n| u32::try_from(n.get()).unwrap_or(1)).clamp(1, 1024);
    Device {
        id: fingerprint(machine.as_deref().unwrap_or(fallback_id)),
        os: os_name(),
        os_version: clean_version(&version),
        arch: arch_name(),
        cpu_cores: cores,
        ram_gb,
        locale: clean_locale(locale),
        tz: clean_tz(tz),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fingerprint_is_a_stable_hash_and_not_the_id() {
        let a = fingerprint("564D1234-ABCD-EF01-2345-6789ABCDEF01");
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_eq!(a, fingerprint(" 564d1234-abcd-ef01-2345-6789abcdef01\n"), "case and spaces do not matter");
        assert_ne!(a, fingerprint("564D1234-ABCD-EF01-2345-6789ABCDEF02"));
        assert!(!a.contains("564d1234"));
        assert_eq!(fingerprint("x"), sha256_hex("intelyide:v1:x"));
    }

    #[test]
    fn it_reads_the_macos_machine_id() {
        let out = "+-o Root  <class IORegistryEntry>\n  +-o MacBookPro18,3  <class IOPlatformExpertDevice>\n    {\n      \"IOPlatformSerialNumber\" = \"C02XXXXXXXXX\"\n      \"IOPlatformUUID\" = \"7A1B2C3D-0000-4E5F-8A9B-123456789ABC\"\n    }\n";
        assert_eq!(parse_ioreg_uuid(out).as_deref(), Some("7A1B2C3D-0000-4E5F-8A9B-123456789ABC"));
        assert_eq!(parse_ioreg_uuid("nothing here"), None);
        assert_eq!(parse_ioreg_uuid("\"IOPlatformUUID\" = \"not a uuid at all!\""), None);
    }

    #[test]
    fn it_reads_memory_and_versions() {
        assert_eq!(parse_meminfo_gb("MemTotal:       16384000 kB\nMemFree: 1 kB\n"), Some(16));
        assert_eq!(parse_meminfo_gb("MemTotal:        8000000 kB\n"), Some(8), "7.6 GiB rounds to 8");
        assert_eq!(parse_meminfo_gb("MemFree: 1 kB"), None);
        assert_eq!(bytes_to_gb(17_179_869_184), 16);
        assert_eq!(bytes_to_gb(0), 0);
        assert_eq!(bytes_to_gb(u64::MAX), 4096, "capped at what the registry accepts");
        assert_eq!(parse_os_release("NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\n").as_deref(), Some("24.04"));
        assert_eq!(parse_os_release("NAME=Arch\n"), None);
        assert_eq!(parse_reg_guid("\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\n    MachineGuid    REG_SZ    4c4c4544-0042-3510-8051-b8c04f4d4e32\n").as_deref(), Some("4c4c4544-0042-3510-8051-b8c04f4d4e32"));
    }

    #[test]
    fn what_the_webview_says_is_cleaned() {
        assert_eq!(clean_locale("hu-HU"), "hu-HU");
        assert_eq!(clean_locale("  <script>  "), "script");
        assert_eq!(clean_locale(""), "und");
        assert_eq!(clean_tz("Europe/Budapest"), "Europe/Budapest");
        assert_eq!(clean_tz("x; drop"), "xdrop");
        assert_eq!(clean_tz("   "), "UTC");
        assert_eq!(clean_locale(&"a".repeat(80)).len(), 35);
    }

    #[test]
    fn a_collected_device_fits_what_the_registry_accepts() {
        let d = collect("hu-HU", "Europe/Budapest", "fallback-id-for-the-test");
        assert_eq!(d.id.len(), 64);
        assert!(["macos", "windows", "linux", "other"].contains(&d.os));
        assert!(["aarch64", "x86_64", "other"].contains(&d.arch));
        assert!((1..=1024).contains(&d.cpu_cores));
        assert!(d.ram_gb <= 4096);
        assert!(!d.os_version.is_empty() && d.os_version.len() <= 40);
        let v = d.full_json();
        assert_eq!(v["id"].as_str().map(str::len), Some(64));
        assert!(v.get("hostname").is_none() && v.get("user").is_none());
        assert!(d.update_json().get("id").is_none());
    }
}
