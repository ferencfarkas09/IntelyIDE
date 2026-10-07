//! Resource HUD and menu-bar logic (wave3 X3, ideas #27 and #23). Tauri-free and synchronous: the process-tree
//! snapshot, the Eco-mode clock and the native-notification gate are plain data in, plain data out, so `cargo test`
//! needs no window. The Tauri glue is `src-tauri/src/modules/{hud,tray}.rs`.

pub mod eco;
pub mod notify;
pub mod procs;
pub mod tray;
pub mod viewer;

pub use eco::{Eco, EcoChange};
pub use notify::{Kind, NotifyGate, NotifyPrefs, Verdict};
pub use procs::{build_snapshot, kill_in_snapshot, parse_ps, responsible_pid, scan, KillError, ProcKind, ProcRow, RawProc, Snapshot};
pub use tray::{menu_items, title_text, MenuItem, TrayStatus};
