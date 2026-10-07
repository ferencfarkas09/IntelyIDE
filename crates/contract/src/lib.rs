//! Contract-drift detector and API explorer logic for IntelySwitchIDE (Tauri-free, read-only, fixture-tested).
//! Reads the backend's swagger (swagger 2 / openapi 3, JSON or the backend's YAML fragments), scans the client repos
//! for API calls and reports where the two disagree. Everything is a heuristic and every finding carries a confidence.
//! Nothing here writes to a repository or touches the network.

pub mod analyze;
pub mod git;
pub mod matcher;
pub mod scan;
pub mod spec;
pub mod yaml;

pub use analyze::{analyze, Cache, ClientInput, Report};
