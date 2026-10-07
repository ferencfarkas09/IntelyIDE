//! Native dialog backends ((design notes: workspaces-spec) 5.3). The trait lives here, the real `rfd` backend in `src-tauri`.
//!
//! `FakeBackend` answers from `INTELY_PICK_SCRIPT` and works **only** under the e2e jail; in any other mode it is
//! unavailable and the variable is ignored, so a stray variable cannot script a normal run.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use intely_core::jail::{Jail, Mode};
use intely_core::EngineError;

use crate::types::{codes, NativeKind};
use crate::validate::err;

#[derive(Debug, Clone, PartialEq)]
pub struct NativeRequest {
    pub kind: NativeKind,
    /// At most 80 characters, control characters stripped ([`sanitize_title`]).
    pub title: String,
    /// A validated directory, never a webview string.
    pub start: Option<PathBuf>,
    pub extensions: Vec<String>,
    pub can_create: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum NativeAnswer {
    Cancelled,
    Paths(Vec<PathBuf>),
}

pub trait PickBackend: Send + Sync {
    fn available(&self) -> bool;
    /// Blocking; called off the async threads. A failure to open the dialog is `nativeFailed`, a cancel is `Cancelled`.
    fn pick(&self, req: &NativeRequest) -> Result<NativeAnswer, EngineError>;
}

pub fn sanitize_title(raw: &str) -> String {
    raw.chars().filter(|c| !c.is_control()).take(80).collect::<String>().trim().to_owned()
}

/// Tries the available backends in order; a `nativeFailed` error falls through to the next one.
pub struct BackendChain(pub Vec<Box<dyn PickBackend>>);

impl PickBackend for BackendChain {
    fn available(&self) -> bool {
        self.0.iter().any(|b| b.available())
    }

    fn pick(&self, req: &NativeRequest) -> Result<NativeAnswer, EngineError> {
        let mut last = err(codes::NATIVE_FAILED, "no native picker is available");
        for b in self.0.iter().filter(|b| b.available()) {
            match b.pick(req) {
                Err(e) if e.code == codes::NATIVE_FAILED => last = e,
                other => return other,
            }
        }
        Err(last)
    }
}

pub struct FakeBackend {
    jail: Arc<Jail>,
    script: Option<PathBuf>,
    consumed: AtomicUsize,
}

impl FakeBackend {
    pub fn new(jail: Arc<Jail>, script: Option<PathBuf>) -> Self {
        Self { jail, script, consumed: AtomicUsize::new(0) }
    }

    pub fn from_env(jail: Arc<Jail>) -> Self {
        let script = std::env::var_os("INTELY_PICK_SCRIPT").filter(|v| !v.is_empty()).map(PathBuf::from);
        Self::new(jail, script)
    }
}

impl PickBackend for FakeBackend {
    fn available(&self) -> bool {
        self.jail.mode() == Mode::E2e
    }

    fn pick(&self, _req: &NativeRequest) -> Result<NativeAnswer, EngineError> {
        if !self.available() {
            return Err(err(codes::NATIVE_FAILED, "the scripted picker works only in e2e mode"));
        }
        let Some(script) = &self.script else { return Ok(NativeAnswer::Cancelled) };
        // Re-read on every call: a shell harness may append while the app runs.
        let text = std::fs::read_to_string(script).unwrap_or_default();
        let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        let i = self.consumed.fetch_add(1, Ordering::SeqCst);
        let Some(line) = lines.get(i) else {
            // Exhausted: do not run ahead of a script that is still being appended.
            self.consumed.fetch_sub(1, Ordering::SeqCst);
            return Ok(NativeAnswer::Cancelled);
        };
        let v: serde_json::Value = serde_json::from_str(line).map_err(|_| err(codes::NATIVE_FAILED, "bad pick script line"))?;
        if v.get("cancel").and_then(|c| c.as_bool()) == Some(true) {
            return Ok(NativeAnswer::Cancelled);
        }
        let paths = v
            .get("paths")
            .and_then(|p| p.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).map(PathBuf::from).collect::<Vec<_>>())
            .ok_or_else(|| err(codes::NATIVE_FAILED, "bad pick script line"))?;
        Ok(NativeAnswer::Paths(paths))
    }
}
