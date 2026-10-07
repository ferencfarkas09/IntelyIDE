//! Tauri-free backend of the `roles` and `runs` modules. Types that cross the IPC boundary live in `types` and are
//! exported to `ui/src/bindings/roles.ts` by `pnpm bindings`.
//!
//! * `store`: roles from `~/.claude/agents` and `<repo>/.claude/agents` plus the IDE overlay, drift, the Happy preset.
//! * `permission`: a role's permission derived from its own file; `groups`: one group per name with a winner, trust,
//!   pin and hide; `delete`: verified-backup deletion of role files.
//! * `ledger`: the usage ledger (tokens and cost estimates per run, no double counting across resume and fork).
//! * `supervisor`: runs on top of `intely-agent-host` (which owns the gate): write queue, resume, fork, history, Rewind.

pub mod delegates;
pub mod delete;
pub mod frontmatter;
pub mod groups;
pub mod ledger;
pub mod permission;
pub mod store;
pub mod supervisor;
pub mod types;

pub use store::{FileOverlay, MemoryOverlay, OverlayState, OverlayStore, RoleError, RoleStore};
pub use supervisor::{Observer, Supervisor, SupervisorConfig};
