//! Native notification gate: per-kind switches, a throttle and "never while the window is focused".

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Permission,
    Question,
    Finished,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotifyPrefs {
    pub permission: bool,
    pub question: bool,
    pub finished: bool,
    pub error: bool,
    /// Minimum gap between two notifications of the same kind.
    pub throttle_ms: u64,
}

impl Default for NotifyPrefs {
    fn default() -> Self {
        Self { permission: true, question: true, finished: true, error: true, throttle_ms: 10_000 }
    }
}

impl NotifyPrefs {
    fn allows(&self, kind: Kind) -> bool {
        match kind {
            Kind::Permission => self.permission,
            Kind::Question => self.question,
            Kind::Finished => self.finished,
            Kind::Error => self.error,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    Show,
    Focused,
    Disabled,
    Throttled,
}

#[derive(Debug, Default)]
pub struct NotifyGate {
    last: HashMap<Kind, u64>,
}

impl NotifyGate {
    /// Decides whether to show a notification now; records the time only for a shown one.
    pub fn check(&mut self, kind: Kind, prefs: &NotifyPrefs, window_focused: bool, now: u64) -> Verdict {
        if !prefs.allows(kind) {
            return Verdict::Disabled;
        }
        if window_focused {
            return Verdict::Focused;
        }
        if self.last.get(&kind).is_some_and(|t| now.saturating_sub(*t) < prefs.throttle_ms) {
            return Verdict::Throttled;
        }
        self.last.insert(kind, now);
        Verdict::Show
    }
}

/// Escapes a string for an AppleScript double-quoted literal; control characters become spaces.
pub fn applescript_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The `osascript -e` program for one notification (title and body are length-capped).
pub fn applescript(title: &str, body: &str) -> String {
    let cap = |s: &str, n: usize| s.chars().take(n).collect::<String>();
    format!("display notification {} with title {}", applescript_quote(&cap(body, 200)), applescript_quote(&cap(title, 80)))
}
