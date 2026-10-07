//! Opening a link in the system browser: https only, and the URL is never logged or put into an error.

use reqwest::Url;

/// Bidi overrides and zero-width characters: they make a shown link text lie about its target.
fn is_invisible(c: char) -> bool {
    matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
}

/// Callers pass server-supplied links (Meet's join URL carries a short-lived token in its fragment).
pub fn is_https(url: &str) -> bool {
    url.len() <= 4096 && !url.chars().any(|c| c.is_control() || c.is_whitespace() || is_invisible(c)) && Url::parse(url).is_ok_and(|u| u.scheme() == "https" && u.host_str().is_some() && u.username().is_empty() && u.password().is_none())
}

/// `open <url>` on macOS. Errors say nothing about the URL.
pub fn open_in_browser(url: &str) -> Result<(), String> {
    if !is_https(url) {
        return Err("only https links can be opened".to_owned());
    }
    // The e2e harness must not open a browser on the desktop: it records the host (never the URL: its fragment is a token).
    if std::env::var("INTELY_E2E").is_ok_and(|v| v == "1") {
        if let (Some(dir), Some(host)) = (std::env::var_os("INTELY_DATA_DIR"), Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_owned))) {
            use std::io::Write;
            let logged = std::fs::OpenOptions::new().create(true).append(true).open(std::path::Path::new(&dir).join("opened-urls.log")).and_then(|mut f| writeln!(f, "{host}"));
            return logged.map_err(|_| "the browser could not be opened".to_owned());
        }
        return Err("the browser is not opened under the e2e harness".to_owned());
    }
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("/usr/bin/open").arg(url).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status();
    #[cfg(not(target_os = "macos"))]
    let status: std::io::Result<std::process::ExitStatus> = Err(std::io::Error::other("unsupported platform"));
    match status {
        Ok(s) if s.success() => Ok(()),
        _ => Err("the browser could not be opened".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_https_links_pass() {
        assert!(is_https("https://meet.example.test/meet/join#server=wss://lk.example.test&token=abc"));
        for bad in ["http://meet.example.test", "file:///etc/passwd", "javascript:alert(1)", "https://", "https://a.test/ x", "https://a.test/\n", "-a", "", "ssh://a.test", "https://user:pw@a.test/", "https://user@a.test/", "https://a.test/a\u{202e}gnp.exe", "https://a.test/\u{200b}"] {
            assert!(!is_https(bad), "{bad:?}");
        }
        assert!(open_in_browser("http://a.test").is_err());
    }
}
