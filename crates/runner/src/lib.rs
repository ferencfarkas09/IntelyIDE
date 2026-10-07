//! Tauri-free backend of the `run` module (Scripts/Run panel): script discovery with safety classification and secret
//! masking, and managed dev-server processes (process group per start, port detection, tree RSS, bounded masked log).
//! Starting a process is a human action only; the jail refuses it in read-only mode unless the user switched on
//! "Allow processes" for the session (docs/safety.md). Types that cross the IPC boundary live in `types` and are
//! exported to `ui/src/bindings/run.ts` by `pnpm bindings`.

pub mod catalog;
pub mod guard;
pub mod manager;
pub mod mask;
pub mod port;
pub mod types;

pub use manager::{RunManager, RunSink, StartOpts};
