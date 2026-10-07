//! Tauri-free backend of the `term` module: pty sessions behind `TermManager`. Types that cross the IPC boundary live in
//! `types` and are exported to `ui/src/bindings/term.ts` by `pnpm bindings`.

pub mod manager;
pub mod types;
mod utf8;

pub use manager::{default_shell, Emit, Opened, SpawnSpec, TermManager, BATCH_WINDOW};
