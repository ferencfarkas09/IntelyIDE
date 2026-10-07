//! The `ProcessGate`: leases, per-tree RSS, idle reaper, cancel protocol and orphan protection.

pub mod cancel;
pub mod lease;
pub mod orphans;
pub mod procinfo;
pub mod reaper;
pub mod rss;

pub use cancel::{CancelPlan, CancelReport, CancelSink, CancelTracker};
pub use lease::{
    AcquireReq, AdmissionError, AdmissionKind, Gate, GateConfig, Lease, LeaseInfo, ReclaimReason, Reclaimed,
    RenewError, RenewOk,
};
pub use orphans::{OrphanRegistry, SweepReport};
