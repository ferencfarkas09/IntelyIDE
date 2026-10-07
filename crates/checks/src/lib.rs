//! Tauri-free backend of the Wave 3 X2 extras: pre-commit checks (#18), env and secret awareness (#19), branch hygiene
//! (#20) and the worktree manager (#21). Everything that mutates goes through the jail first (docs/safety.md);
//! everything that reads is read-only git or a bounded file walk. `.env` files are never opened (see `envnames`).

pub mod discover;
pub mod envnames;
pub mod git;
pub mod hygiene;
pub mod runner;
pub mod secrets;
pub mod types;
pub mod worktrees;
