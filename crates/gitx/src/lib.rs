//! Tauri-free backend of the Wave 4 GitX extras: the PR bridge on the GitHub CLI (backlog #17) and the expanded Doctor
//! (#29). The PR bridge is human-initiated and read-only except for one thing, `gh pr create`, which is a draft by
//! default, never pushes, never merges, edits, closes, approves or comments, and runs only after the repo name and the
//! head branch were typed. Everything goes through the jail (docs/safety.md); the Doctor only reports.

pub mod doctor;
pub mod gh;
pub mod git;
pub mod pr;
pub mod proc;
pub mod types;
