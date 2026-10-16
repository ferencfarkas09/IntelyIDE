//! Invite links: `intely-team://join#<code>` clicked in a chat, a mail or a web page. macOS hands the link to the app (the scheme is
//! registered in `Info.plist`); the app brings its window forward and tells the page, which opens Settings > Team with the code in the join
//! form. Nothing is joined or trusted here: the person still reads the relay host, ticks the box and presses Join.
//!
//! The link carries the one-time code of an invite, so it is never logged and never leaves this process. It waits in one slot until the
//! page takes it (`team_take_invite_link`): a link that starts the app arrives before the page has loaded.

use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

/// The URL scheme registered in `Info.plist` (`CFBundleURLSchemes`).
pub const SCHEME: &str = "intely-team";
/// An invite link is a few hundred characters; anything much longer is not one.
const MAX_LINK_BYTES: usize = 2048;

/// A link brings the window forward at most once in this time: a page that opens link after link must not keep stealing the focus.
const FOCUS_GAP: Duration = Duration::from_secs(2);

static PENDING: Mutex<Option<String>> = Mutex::new(None);
static LAST_FOCUS: Mutex<Option<Instant>> = Mutex::new(None);

fn slot() -> std::sync::MutexGuard<'static, Option<String>> {
    PENDING.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The text of an invite link the system handed over: `intely-team://join#<code>` and nothing else (no credentials, port, path or query).
/// The code is judged by the join form, not here; the text is passed on as it was written.
pub fn invite_from_url(link: &str) -> Option<String> {
    let link = link.trim();
    if link.is_empty() || link.len() > MAX_LINK_BYTES || link.chars().any(char::is_control) {
        return None;
    }
    let url = tauri::Url::parse(link).ok()?;
    let plain = url.scheme() == SCHEME
        && url.host_str().is_some_and(|h| h.eq_ignore_ascii_case("join"))
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && matches!(url.path(), "" | "/")
        && url.query().is_none()
        && url.fragment().is_some_and(|f| !f.is_empty());
    plain.then(|| link.to_owned())
}

/// Whether a link may bring the window forward now; the time is noted when it may.
fn may_take_focus(now: Instant, last: &mut Option<Instant>) -> bool {
    if last.is_some_and(|t| now.saturating_duration_since(t) < FOCUS_GAP) {
        return false;
    }
    *last = Some(now);
    true
}

/// The system opened the app with these URLs (macOS only). The last invite link wins; every other URL is ignored.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn on_opened(app: &AppHandle, urls: &[tauri::Url]) {
    let Some(code) = urls.iter().rev().find_map(|u| invite_from_url(u.as_str())) else { return };
    *slot() = Some(code);
    let focus = may_take_focus(Instant::now(), &mut LAST_FOCUS.lock().unwrap_or_else(PoisonError::into_inner));
    if let Some(window) = app.get_webview_window("main").filter(|_| focus) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    // no payload: the page asks for the text, so the code is not broadcast to every listener
    let _ = app.emit_to("main", "team:invite-link", ());
}

/// The page asks for the link that opened the app (once: the slot is emptied).
#[tauri::command]
pub fn team_take_invite_link() -> Option<String> {
    slot().take()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODE: &str = "wss://relay.example.workers.dev,CEx5c2s4WAO1kx7iTVzL9g,gKAK926tlsM_abcdef,AAAAAAAAAAAAAAAAAAAAAA,BBBBBBBBBBBBBBBBBBBBBB";

    #[test]
    fn an_invite_link_is_taken_as_it_was_written() {
        let link = format!("intely-team://join#{CODE}");
        assert_eq!(invite_from_url(&link).as_deref(), Some(link.as_str()));
        // the way a chat or a mail client may spell it: capitals, a slash, spaces around it
        for variant in [format!("INTELY-TEAM://JOIN#{CODE}"), format!("intely-team://join/#{CODE}"), format!("  intely-team://join#{CODE}\n")] {
            assert_eq!(invite_from_url(&variant).as_deref(), Some(variant.trim()), "{variant:?}");
        }
        // percent-escaped commas are still one link; the join form unescapes them
        let escaped = format!("intely-team://join#{}", CODE.replace(',', "%2C"));
        assert_eq!(invite_from_url(&escaped).as_deref(), Some(escaped.as_str()));
    }

    #[test]
    fn nothing_but_the_join_link_is_accepted() {
        for not_a_link in [
            "",
            "intely-team://join",
            "intely-team://join#",
            "intely-team://other#x",
            "intely-team://join?x=1#x",
            "intely-team://join/extra#x",
            "intely-team://user:pw@join#x",
            "intely-team://join:80#x",
            "https://intelyhome.com/join#x",
            "intely://join#x",
            "file:///etc/passwd",
            "not a url",
            "javascript:alert(1)",
        ] {
            assert_eq!(invite_from_url(not_a_link), None, "{not_a_link:?}");
        }
    }

    #[test]
    fn a_link_that_is_too_long_or_holds_control_characters_is_refused() {
        assert_eq!(invite_from_url(&format!("intely-team://join#{}", "a".repeat(MAX_LINK_BYTES))), None);
        assert!(invite_from_url(&format!("intely-team://join#{}", "a".repeat(MAX_LINK_BYTES - 40))).is_some());
        assert_eq!(invite_from_url("intely-team://join#abc\u{0}def"), None);
        assert_eq!(invite_from_url("intely-team://join#abc\ndef"), None);
        assert_eq!(invite_from_url("intely-team://join#abc\u{7f}def"), None);
    }

    #[test]
    fn a_link_that_follows_another_one_at_once_does_not_take_the_focus_again() {
        let t0 = Instant::now();
        let mut last = None;
        assert!(may_take_focus(t0, &mut last), "the first link may");
        assert!(!may_take_focus(t0 + Duration::from_millis(300), &mut last), "a second one right behind it may not");
        assert!(!may_take_focus(t0 + FOCUS_GAP - Duration::from_millis(1), &mut last));
        assert!(may_take_focus(t0 + FOCUS_GAP, &mut last), "after the gap it may again");
        assert!(!may_take_focus(t0, &mut last), "a clock that went back is not a reason to take the focus");
    }

    #[test]
    fn the_slot_gives_the_link_once() {
        *slot() = Some("intely-team://join#x".into());
        assert_eq!(team_take_invite_link().as_deref(), Some("intely-team://join#x"));
        assert_eq!(team_take_invite_link(), None);
    }
}
