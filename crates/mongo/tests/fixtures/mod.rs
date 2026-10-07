//! Shared helpers for the Docker fixture matrix (`matrix.rs`, T14b). The containers come from
//! `scripts/mongo-fixture/matrix.sh up`, which prints `export INTELY_MONGO_FX_*` lines. Nothing here starts Docker.
//!
//! **A skipped test is not a PASS.** Every skip goes through [`skip`], which prints `MATRIX-SKIP <test>: <reason>` (greppable)
//! and counts it; the matrix header test prints the totals.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

static SKIPPED: AtomicUsize = AtomicUsize::new(0);
static RAN: AtomicUsize = AtomicUsize::new(0);

pub fn skipped() -> usize {
    SKIPPED.load(Ordering::SeqCst)
}

pub fn ran() -> usize {
    RAN.load(Ordering::SeqCst)
}

/// Prints and counts a skip. Returns `None` so a test can `let Some(fx) = ... else { return }`.
pub fn skip<T>(test: &str, reason: &str) -> Option<T> {
    SKIPPED.fetch_add(1, Ordering::SeqCst);
    eprintln!("MATRIX-SKIP {test}: {reason}");
    None
}

/// `INTELY_MONGO_MATRIX=1` is the explicit opt-in (the default test run never talks to Docker).
pub fn matrix_enabled() -> bool {
    std::env::var("INTELY_MONGO_MATRIX").is_ok_and(|v| !v.is_empty() && v != "0")
}

/// `docker info` answers within 15 s. Cached; only asked when the matrix was requested but the environment is missing.
pub fn docker_ok() -> bool {
    static OK: OnceLock<bool> = OnceLock::new();
    *OK.get_or_init(|| {
        let Ok(mut child) = Command::new("docker").arg("info").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else {
            return false;
        };
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return status.success(),
                Ok(None) if start.elapsed() < Duration::from_secs(15) => std::thread::sleep(Duration::from_millis(100)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
            }
        }
    })
}

/// One `INTELY_MONGO_FX_<name>` variable.
pub fn var(name: &str) -> Option<String> {
    std::env::var(format!("INTELY_MONGO_FX_{name}")).ok().filter(|v| !v.is_empty())
}

pub fn port(name: &str) -> Option<u16> {
    var(name)?.parse().ok()
}

/// The environment of one test: all `names` present, or a counted skip with the reason.
pub struct Fx {
    pub test: &'static str,
}

pub fn require(test: &'static str, names: &[&str]) -> Option<Fx> {
    if !matrix_enabled() {
        return skip(test, "INTELY_MONGO_MATRIX is not set (scripts/mongo-fixture/matrix.sh up)");
    }
    let missing: Vec<&&str> = names.iter().filter(|n| var(n).is_none()).collect();
    if !missing.is_empty() {
        let why = if docker_ok() { format!("fixture variables missing: {missing:?}; run `eval \"$(scripts/mongo-fixture/matrix.sh env)\"`") } else { "docker is not usable (docker info failed or timed out)".to_string() };
        return skip(test, &why);
    }
    RAN.fetch_add(1, Ordering::SeqCst);
    Some(Fx { test })
}

impl Fx {
    pub fn port(&self, name: &str) -> u16 {
        port(name).unwrap_or_else(|| panic!("{}: INTELY_MONGO_FX_{name} is not a port", self.test))
    }
    pub fn var(&self, name: &str) -> String {
        var(name).unwrap_or_else(|| panic!("{}: INTELY_MONGO_FX_{name} is missing", self.test))
    }
    /// A file below the TLS directory made by `tls.sh` (e.g. `ca.pem`).
    pub fn tls_file(&self, name: &str) -> PathBuf {
        let p = Path::new(&self.var("TLS_DIR")).join(name);
        assert!(p.is_file(), "{}: missing TLS material {name}", self.test);
        p
    }
}

// ---- real error corpus (T3) ----------------------------------------------------------------------------------------

/// Appends one JSON line to `$INTELY_MONGO_COLLECT` when set: the raw driver text of a failure the matrix produced, with
/// the code the test asserted. `scripts/mongo-fixture/collect-errors.sh` sanitises these into `golden/diagnose.real.json`.
pub fn record(name: &str, hint: &str, text: &str, ctx: serde_json::Value, code: &str) {
    let Ok(path) = std::env::var("INTELY_MONGO_COLLECT") else { return };
    if path.is_empty() {
        return;
    }
    use std::io::Write;
    let line = serde_json::json!({ "name": name, "source": "real", "hint": hint, "text": text, "ctx": ctx, "code": code });
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}
