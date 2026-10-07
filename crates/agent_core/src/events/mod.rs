//! Normalized agent events, their invariants, and the append-only log (providers-plan 1.5, 5.1).

pub mod invariants;
pub mod log;
pub mod samples;
pub mod types;

pub use invariants::{check, InvariantChecker, Violation, ViolationCode};
pub use log::{EventLog, JsonlEventLog, LogError};
pub use types::*;
