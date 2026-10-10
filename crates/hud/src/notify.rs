//! Native notification gate: per-kind switches, a throttle per run, a burst limit and "never while the window is focused".

use std::collections::{HashMap, VecDeque};

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
    /// The master switch: off, nothing is shown whatever the kinds say.
    pub enabled: bool,
    pub permission: bool,
    pub question: bool,
    pub finished: bool,
    pub error: bool,
    /// Minimum gap between two notifications of the same kind for the same run.
    pub throttle_ms: u64,
    /// Most banners per minute over all runs (ten agents on three servers must not bury the desktop); 0 = no limit.
    pub burst: u32,
    /// Play the default notification sound.
    pub sound: bool,
}

impl Default for NotifyPrefs {
    fn default() -> Self {
        Self { enabled: true, permission: true, question: true, finished: true, error: true, throttle_ms: 10_000, burst: 12, sound: false }
    }
}

impl NotifyPrefs {
    fn allows(&self, kind: Kind) -> bool {
        self.enabled
            && match kind {
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
    /// More banners in the last minute than `burst` allows.
    Flooded,
}

/// How long a throttle entry is worth keeping; older ones are dropped so a long session does not grow the table.
const KEEP_MS: u64 = 10 * 60_000;
const MINUTE_MS: u64 = 60_000;

#[derive(Debug, Default)]
pub struct NotifyGate {
    last: HashMap<(Kind, String), u64>,
    recent: VecDeque<u64>,
}

impl NotifyGate {
    /// Decides whether to show a notification now; records the time only for a shown one. The throttle is per kind (and run).
    pub fn check(&mut self, kind: Kind, prefs: &NotifyPrefs, window_focused: bool, now: u64) -> Verdict {
        self.check_run(kind, "", prefs, window_focused, now)
    }

    /// Like [`check`](Self::check), for one run: two runs that both need you each get their banner, while one run that asks
    /// again within `throttle_ms` does not.
    pub fn check_run(&mut self, kind: Kind, run: &str, prefs: &NotifyPrefs, window_focused: bool, now: u64) -> Verdict {
        if !prefs.allows(kind) {
            return Verdict::Disabled;
        }
        if window_focused {
            return Verdict::Focused;
        }
        let key = (kind, run.to_string());
        if self.last.get(&key).is_some_and(|t| now.saturating_sub(*t) < prefs.throttle_ms) {
            return Verdict::Throttled;
        }
        while self.recent.front().is_some_and(|t| now.saturating_sub(*t) >= MINUTE_MS) {
            self.recent.pop_front();
        }
        if prefs.burst > 0 && self.recent.len() >= prefs.burst as usize {
            return Verdict::Flooded;
        }
        if self.last.len() > 512 {
            self.last.retain(|_, t| now.saturating_sub(*t) < KEEP_MS);
        }
        self.last.insert(key, now);
        self.recent.push_back(now);
        Verdict::Show
    }

    /// How many (kind, run) throttle entries are kept (tests).
    pub fn tracked(&self) -> usize {
        self.last.len()
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

/// The AppleScript program for one notification (title and body are length-capped).
pub fn applescript(title: &str, body: &str) -> String {
    applescript_with(title, None, body, false)
}

/// Like [`applescript`], with an optional subtitle (the run's title under the heading) and a sound.
pub fn applescript_with(title: &str, subtitle: Option<&str>, body: &str, sound: bool) -> String {
    let cap = |s: &str, n: usize| s.chars().take(n).collect::<String>();
    let mut s = format!("display notification {} with title {}", applescript_quote(&cap(body, 200)), applescript_quote(&cap(title, 80)));
    if let Some(sub) = subtitle.filter(|s| !s.trim().is_empty()) {
        s.push_str(&format!(" subtitle {}", applescript_quote(&cap(sub, 120))));
    }
    if sound {
        s.push_str(" sound name \"Glass\"");
    }
    s
}
