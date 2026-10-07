//! IntelySwitchIDE engine: git/workspace logic with no Tauri dependency (contract: (design notes: phase1-contract)).

pub mod diff;
pub mod engine;
pub mod env;
pub mod exec;
pub mod git;
pub mod guard;
pub mod jail;
pub mod parse;
pub mod registry;
pub mod repo_actor;
pub mod status;
pub mod types;
pub mod watcher;
pub mod workspace;

pub use engine::{termination_signal, Engine, EngineBusy, MutationGuard, ProtectionSource, SwitchTicket};
pub use types::*;

/// Receiver of engine events; the shell forwards them to the UI (`repo:snapshot`, `op:event`, `op:result`, `engine:env`).
pub trait EventSink: Send + Sync {
    fn snapshot(&self, s: RepoSnapshot);
    fn op_event(&self, e: OpEvent);
    fn op_result(&self, r: OpResult);
    fn env(&self, e: EnvStatus);
}
