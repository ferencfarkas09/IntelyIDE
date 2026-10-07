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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuItem {
    /// A disabled informational line.
    Info { id: &'static str, text: String },
    Action { id: &'static str, text: String, enabled: bool },
    Separator,
}

/// Text beside the icon: empty when nothing needs attention, so an idle IDE costs no menu-bar room.
pub fn title_text(s: &TrayStatus) -> String {
    match (s.needs_you, s.running) {
        (0, 0) => String::new(),
        (0, r) => format!("{r}"),
        (n, 0) => format!("! {n}"),
        (n, r) => format!("! {n} / {r}"),
    }
}

pub fn menu_items(s: &TrayStatus) -> Vec<MenuItem> {
    let mut v = vec![
        MenuItem::Info { id: "running", text: format!("{} running", s.running) },
        MenuItem::Action { id: "needs-you", text: format!("Needs you ({})", s.needs_you), enabled: s.needs_you > 0 },
    ];
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
