//! Process inspection for the gate, one implementation per OS: libproc on macOS, `/proc` on Linux and, where neither
//! exists (Windows has no process groups), an implementation that reports every process as gone. A process can vanish
//! between listing and inspecting it, so every function reports "gone" as `None` / empty / `false` instead of failing.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod other;

#[cfg(target_os = "linux")]
pub use linux::*;
#[cfg(target_os = "macos")]
pub use macos::*;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub use other::*;

/// Process and process-group ids (`libc::pid_t` does not exist on Windows).
#[allow(non_camel_case_types)]
pub type pid_t = i32;

/// A process identity that survives pid reuse: the pid plus its start time (seconds).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProcKey {
    pub pid: i32,
    pub start_sec: u64,
}

impl ProcKey {
    pub fn of(pid: pid_t) -> Option<Self> {
        start_sec(pid).map(|start_sec| Self { pid, start_sec })
    }

    pub fn current() -> Self {
        let pid = std::process::id() as pid_t;
        Self::of(pid).unwrap_or(Self { pid, start_sec: 0 })
    }

    /// The same process is still running (a zombie counts as gone).
    pub fn is_alive(&self) -> bool {
        start_sec(self.pid).is_some() && is_alive(self.pid) && start_sec(self.pid) == Some(self.start_sec)
    }
}
