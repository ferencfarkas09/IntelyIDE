//! Eco mode: after the window has been unfocused for `after_ms` the app pauses watchers and polling and suspends idle
//! agents; the next focus resumes everything. A pure clock (the caller passes `now` in ms), tested without timers.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EcoChange {
    Enter,
    Leave,
}

#[derive(Debug, Clone)]
pub struct Eco {
    enabled: bool,
    after_ms: u64,
    unfocused_since: Option<u64>,
    active: bool,
}

impl Eco {
    /// A focused window, nothing paused. `after_ms` below one second is raised to one second.
    pub fn new(enabled: bool, after_ms: u64) -> Self {
        Self { enabled, after_ms: after_ms.max(1000), unfocused_since: None, active: false }
    }

    pub fn active(&self) -> bool {
        self.active
    }

    pub fn configure(&mut self, enabled: bool, after_ms: u64, now: u64) -> Option<EcoChange> {
        self.enabled = enabled;
        self.after_ms = after_ms.max(1000);
        if !enabled && self.active {
            self.active = false;
            return Some(EcoChange::Leave);
        }
        self.tick(now)
    }

    pub fn focus(&mut self, focused: bool, now: u64) -> Option<EcoChange> {
        if focused {
            self.unfocused_since = None;
            return std::mem::take(&mut self.active).then_some(EcoChange::Leave);
        }
        self.unfocused_since.get_or_insert(now);
        self.tick(now)
    }

    /// Call from any timer; returns `Enter` once when the unfocused time reaches the limit.
    pub fn tick(&mut self, now: u64) -> Option<EcoChange> {
        match self.unfocused_since {
            Some(since) if self.enabled && !self.active && now.saturating_sub(since) >= self.after_ms => {
                self.active = true;
                Some(EcoChange::Enter)
            }
            _ => None,
        }
    }

    /// Milliseconds until the next possible `Enter`, for arming a single timeout (no polling while focused or already eco).
    pub fn next_check_in(&self, now: u64) -> Option<u64> {
        let since = self.unfocused_since?;
        (self.enabled && !self.active).then(|| (since + self.after_ms).saturating_sub(now))
    }
}
