//! Localization checker and release assistant logic for IntelySwitchIDE (Tauri-free, read-only git, fixture-tested).
//! Conventions were learned read-only from the Happy repos: flat or nested i18next JSON catalogs, one key per line,
//! `{{placeholders}}`, `_one/_other` plurals. Writes are single spliced lines (see `catalog::set_key`).

pub mod analyze;
pub mod catalog;
pub mod detect;
pub mod draft;
pub mod edit;
pub mod git;
pub mod release;
pub mod rules;

pub use analyze::{analyze, Report};
