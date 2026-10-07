use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Wry};

/// Menu item ids handled in `lib.rs`.
pub const CLOSE_WINDOW: &str = "close_window";
pub const QUIT: &str = "quit";
pub const CHECK_UPDATES: &str = "check_updates";
/// Event the UI listens to (modules/updates): the menu item runs a manual check and shows the result.
pub const CHECK_UPDATES_EVENT: &str = "menu:check-updates";

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let app_menu = Submenu::with_items(
        app,
        "IntelyIDE",
        true,
        &[
            &PredefinedMenuItem::about(
                app,
                None,
                Some(AboutMetadata {
                    website: Some("https://github.com/IntelyHome".into()),
                    website_label: Some("IntelyHome on GitHub".into()),
                    comments: Some("GitHub: https://github.com/ferencfarkas09\nIntelyHome: https://github.com/IntelyHome".into()),
                    ..Default::default()
                }),
            )?,
            &MenuItem::with_id(app, CHECK_UPDATES, "Check for Updates…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            // Custom items: the predefined ones quit and close without asking the UI about unsaved buffers.
            &MenuItem::with_id(app, QUIT, "Quit IntelyIDE", true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            // Cmd+W belongs to the UI (close the active tab); the window closes with Cmd+Shift+W or the red button.
            &MenuItem::with_id(app, CLOSE_WINDOW, "Close Window", true, Some("CmdOrCtrl+Shift+W"))?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])
}
