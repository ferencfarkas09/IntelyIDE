//! Process gate, rewind snapshots and the allow-list git shim for agent runs (providers-plan 3.1, 4.4, 5.2, 5.6).
//!
//! Tauri-free and synchronous (std threads), so `cargo test` needs no webview. The gate lives in its own crate
//! (not in `agent_core`) so both can be built in parallel; see CONTRACT-CHANGE in providers-plan 5.2.

pub mod gate;
pub mod rewind;
pub mod shim;

pub use gate::{
    AcquireReq, AdmissionError, AdmissionKind, CancelPlan, Gate, GateConfig, Lease, OrphanRegistry, ReclaimReason,
    Reclaimed,
};
