//! OS accessibility settings the webview cannot report itself.
//!
//! WKWebView does not implement the `prefers-reduced-transparency` media query, so macOS "Reduce transparency" is read here
//! and the UI folds it into its own check (`theme/skin.ts`). Other platforms answer false: their webviews implement the query.

/// True when macOS "Reduce transparency" (System Settings > Accessibility > Display) is on. Never fails: unknown is false.
#[tauri::command]
pub async fn os_reduce_transparency() -> bool {
    tauri::async_runtime::spawn_blocking(reduce_transparency).await.unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn reduce_transparency() -> bool {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let Ok(mut child) = Command::new("/usr/bin/defaults")
        .args(["read", "com.apple.universalaccess", "reduceTransparency"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take().is_some_and(|mut s| s.read_to_string(&mut out).is_ok()) && parse_flag(&out)
}

#[cfg(not(target_os = "macos"))]
fn reduce_transparency() -> bool {
    false
}

/// `defaults read` prints `1` or `0`; a missing key (never changed) fails and prints nothing.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_flag(out: &str) -> bool {
    matches!(out.trim(), "1" | "true" | "YES")
}

#[cfg(test)]
mod tests {
    use super::parse_flag;

    #[test]
    fn only_a_set_flag_counts() {
        assert!(parse_flag("1\n"));
        assert!(!parse_flag("0\n"));
        assert!(!parse_flag(""));
        assert!(!parse_flag("The domain/default pair does not exist"));
    }
}
