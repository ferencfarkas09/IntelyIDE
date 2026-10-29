//! Static helpers for people who build web and Node apps mostly by prompting a coding agent: design tokens and unused styles
//! in CSS/SCSS, heuristic React checks, a bundle size report, a route map of Node backends, a `.env` comparison, a loopback-only
//! request sender and the parsing of `npm outdated` / `npm audit` (Tauri-free, no network except [`tryit`], which can only reach
//! 127.0.0.1 / ::1, and no process of its own).
//!
//! A repository is hostile input. Folders are walked with caps and never through a link (`walk`), every file is read through
//! directory handles that do not follow links, with a size cap, and invalid UTF-8 is replaced (`safefs`). All scanning is done
//! with linear loops over bytes, never with backtracking patterns, so a minified megabyte or a crafted file costs time in
//! proportion to its size. Nothing here writes a file of the repository or deletes anything. An env file is loaded as text (at most
//! 256 KB) and dropped as soon as its variable names are taken: no value reaches a struct, an error message or a log.

mod bundle;
mod color;
mod cssscan;
mod deps;
mod detect;
mod envcheck;
mod findrule;
mod jsmask;
pub mod npmrun;
mod react;
mod routes;
mod safefs;
mod styles;
mod tokens;
pub mod tryit;
mod walk;

use std::fmt;
use std::path::Path;

use serde::Serialize;

pub use bundle::{bundle_report, Asset, BundleDir, BundleReport, KindSize};
pub use deps::{parse_audit, parse_outdated, AuditItem, AuditReport, OutdatedPkg};
pub use detect::{detect, Detect, PackageDir};
pub use envcheck::{env_report, EnvDir, EnvFile, EnvReport, MissingKey};
pub use findrule::{find_rule, RuleMatch, RuleQuery};
pub use react::{react_checks, ReactFinding, ReactOptions, ReactReport};
pub use routes::{route_map, Route, RouteMap};
pub use styles::{unused_styles, StyleFile, UnusedClass, UnusedReport};
pub use tokens::{token_report, DuplicateColor, HardCoded, Swatch, Token, TokensReport};

#[derive(Debug, Clone)]
pub struct WebError {
    pub code: &'static str,
    pub message: String,
}

impl fmt::Display for WebError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for WebError {}

pub(crate) fn fail<T>(code: &'static str, message: impl Into<String>) -> Result<T, WebError> {
    Err(WebError { code, message: message.into() })
}

pub(crate) fn io_err(e: std::io::Error) -> WebError {
    WebError { code: "io", message: e.to_string() }
}

/// A file of source code is read up to this size; a bigger one (a bundle checked in by mistake) is named and skipped.
pub(crate) const SRC_CAP: u64 = 1536 * 1024;
pub(crate) const STYLE_CAP: u64 = 4 * 1024 * 1024;
/// What a scan may keep of the style sheets it has read (the estimate of `cssscan::Facts::approx_bytes`, summed). Past it, further sheets
/// are named and left out instead of growing the process without a bound.
pub(crate) const FACT_BUDGET: usize = 32 * 1024 * 1024;
/// All the files one scan reads together.
pub(crate) const TOTAL_BUDGET: u64 = 160 * 1024 * 1024;

/// What one scan has read so far, and what it left out.
pub(crate) struct Reader<'a> {
    root: &'a Path,
    left: u64,
    pub skipped: Vec<String>,
    pub truncated: bool,
}

impl<'a> Reader<'a> {
    pub fn new(root: &'a Path) -> Self {
        Self { root, left: TOTAL_BUDGET, skipped: Vec::new(), truncated: false }
    }

    pub fn read(&mut self, e: &walk::Entry, cap: u64) -> Option<String> {
        if e.size > cap {
            if self.skipped.len() < 20 {
                self.skipped.push(format!("{} is too large to read", e.rel));
            }
            return None;
        }
        if e.size > self.left {
            if !self.truncated {
                self.skipped.push("stopped reading: the files are very large together".into());
            }
            self.truncated = true;
            return None;
        }
        self.left -= e.size;
        safefs::read(self.root, &e.rel, cap).ok()
    }
}

pub(crate) const STYLE_EXTS: &[&str] = &["css", "scss", "sass", "less"];
pub(crate) const CODE_EXTS: &[&str] = &["tsx", "jsx", "ts", "js", "mjs", "cjs", "mts", "cts"];
pub(crate) const MARKUP_EXTS: &[&str] = &["html", "htm", "vue", "svelte", "mdx", "astro"];

pub(crate) fn is_style(ext: &str) -> bool {
    STYLE_EXTS.contains(&ext)
}

pub(crate) fn is_source(ext: &str) -> bool {
    CODE_EXTS.contains(&ext) || MARKUP_EXTS.contains(&ext)
}

/// A finding's confidence, shown to the person: the tools are static and say how sure they are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Confidence {
    High,
    Medium,
    Low,
}

/// 1-based line of a byte offset, from a table of line starts.
pub(crate) fn line_starts(text: &[u8]) -> Vec<usize> {
    let mut v = vec![0];
    v.extend(text.iter().enumerate().filter(|(_, b)| **b == b'\n').map(|(i, _)| i + 1));
    v
}

pub(crate) fn line_of(starts: &[usize], offset: usize) -> u32 {
    match starts.binary_search(&offset) {
        Ok(i) => (i + 1) as u32,
        Err(i) => i as u32,
    }
}

/// A short, printable single-line piece of text from a repository, for the screen and prompts.
pub(crate) fn clean(s: &str, max: usize) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if out.len() + c.len_utf8() > max {
            out.push('…');
            break;
        }
        if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}') {
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out.trim().to_string()
}
