//! What the menu-bar item shows, as data: the title next to the icon and the menu entries.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrayStatus {
    pub running: u32,
    pub needs_you: u32,
    /// "running", "paused" or "idle"/empty.
    pub timer: String,
    pub timer_label: String,
    /// Share of the 5-hour plan window used, 0-100, when the person asked for it in the menu bar (Settings > Dashboard).
    pub plan_percent: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuItem {
    /// A disabled informational line.
    Info { id: &'static str, text: String },
    Action { id: &'static str, text: String, enabled: bool },
    Separator,
}

/// Text beside the icon: empty when nothing needs attention, so an idle IDE costs no menu-bar room. The plan usage, when it is
/// switched on, follows the counts (`! 2 / 3 · 41%`) or stands alone (`41%`).
pub fn title_text(s: &TrayStatus) -> String {
    let counts = match (s.needs_you, s.running) {
        (0, 0) => String::new(),
        (0, r) => format!("{r}"),
        (n, 0) => format!("! {n}"),
        (n, r) => format!("! {n} / {r}"),
    };
    match (s.plan_percent.map(|p| p.min(100)), counts.is_empty()) {
        (None, _) => counts,
        (Some(p), true) => format!("{p}%"),
        (Some(p), false) => format!("{counts} \u{b7} {p}%"),
    }
}

pub fn menu_items(s: &TrayStatus) -> Vec<MenuItem> {
    let mut v = vec![
        MenuItem::Info { id: "running", text: format!("{} running", s.running) },
        MenuItem::Action { id: "needs-you", text: format!("Needs you ({})", s.needs_you), enabled: s.needs_you > 0 },
    ];
    if let Some(p) = s.plan_percent {
        v.push(MenuItem::Info { id: "plan", text: format!("Plan: {}% of the 5-hour limit used", p.min(100)) });
    }
    if !s.timer.is_empty() && s.timer != "idle" {
        let label = if s.timer_label.is_empty() { s.timer.clone() } else { format!("{}: {}", s.timer, s.timer_label) };
        v.push(MenuItem::Info { id: "timer", text: format!("Timer {label}") });
    }
    v.extend([
        MenuItem::Separator,
        MenuItem::Action { id: "open", text: "Open IntelySwitchIDE".into(), enabled: true },
        MenuItem::Action { id: "new-run", text: "New run...".into(), enabled: true },
        MenuItem::Action { id: "stop-all", text: "Stop all agents".into(), enabled: s.running > 0 },
        MenuItem::Separator,
        MenuItem::Action { id: "quit", text: "Quit".into(), enabled: true },
    ]);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(running: u32, needs_you: u32, plan_percent: Option<u8>) -> TrayStatus {
        TrayStatus { running, needs_you, plan_percent, ..TrayStatus::default() }
    }

    #[test]
    fn the_title_shows_the_counts_and_stays_empty_when_idle() {
        assert_eq!(title_text(&status(0, 0, None)), "");
        assert_eq!(title_text(&status(3, 0, None)), "3");
        assert_eq!(title_text(&status(0, 2, None)), "! 2");
        assert_eq!(title_text(&status(3, 2, None)), "! 2 / 3");
    }

    #[test]
    fn the_plan_percentage_follows_the_counts_or_stands_alone() {
        assert_eq!(title_text(&status(0, 0, Some(41))), "41%");
        assert_eq!(title_text(&status(3, 2, Some(41))), "! 2 / 3 \u{b7} 41%");
        assert_eq!(title_text(&status(1, 0, Some(0))), "1 \u{b7} 0%");
        assert_eq!(title_text(&status(0, 0, Some(250))), "100%");
    }

    #[test]
    fn the_plan_line_is_in_the_menu_only_when_switched_on() {
        let has_plan = |s: &TrayStatus| menu_items(s).iter().any(|i| matches!(i, MenuItem::Info { id: "plan", .. }));
        assert!(!has_plan(&status(1, 1, None)));
        assert!(has_plan(&status(1, 1, Some(12))));
    }

    #[test]
    fn a_status_without_the_plan_field_still_parses() {
        let s: TrayStatus = serde_json::from_str(r#"{"running":1,"needsYou":2,"timer":"","timerLabel":""}"#).unwrap();
        assert_eq!(s.plan_percent, None);
        let s: TrayStatus = serde_json::from_str(r#"{"running":0,"needsYou":0,"planPercent":7}"#).unwrap();
        assert_eq!(s.plan_percent, Some(7));
    }
}
