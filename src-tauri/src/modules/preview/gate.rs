//! The pure loopback gate of the preview: no Tauri, no serde, std only (so it also compiles and tests on its own).
//! The rules and the shared table of cases are the UI's: `ui/src/modules/preview/logic.ts`, `url-cases.json`.

use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// Ports of the IDE's own dev server: a frame there would share the app's origin.
const IDE_PORTS: [u16; 1] = [1420];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Empty,
    TooLong,
    BadChars,
    Scheme,
    Credentials,
    NotLoopback,
    BadPort,
    SelfOrigin,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Refusal::Empty => "empty",
            Refusal::TooLong => "tooLong",
            Refusal::BadChars => "badChars",
            Refusal::Scheme => "scheme",
            Refusal::Credentials => "credentials",
            Refusal::NotLoopback => "notLoopback",
            Refusal::BadPort => "badPort",
            Refusal::SelfOrigin => "selfOrigin",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Refusal::Empty => "Enter a loopback address, for example localhost:8082.",
            Refusal::TooLong => "The address is too long.",
            Refusal::BadChars => "The address has spaces, control or non-ASCII characters in the host part.",
            Refusal::Scheme => "Only http:// addresses load in the preview (dev servers on this machine).",
            Refusal::Credentials => "Addresses with a user name or password are refused.",
            Refusal::NotLoopback => "Only localhost and 127.0.0.1 are allowed (the frame policy lists exactly those). Remote hosts, other 127.x addresses and names that merely resolve to loopback are refused.",
            Refusal::BadPort => "The port must be a number from 1 to 65535.",
            Refusal::SelfOrigin => "That is the IDE's own address; a frame there would share the app's origin.",
        }
    }
}

/// An accepted address, normalised: `url` is exactly what the frame loads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gate {
    pub url: String,
    pub host: String,
    pub port: u16,
    pub origin: String,
}

fn starts_ci(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len() && s.is_char_boundary(prefix.len()) && s[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// `localhost` or `127.0.0.1` followed by `:`, `/`, `?`, `#` or the end.
fn loopback_prefix(s: &str) -> bool {
    ["localhost", "127.0.0.1"].iter().any(|h| starts_ci(s, h) && s[h.len()..].chars().next().map_or(true, |c| matches!(c, ':' | '/' | '?' | '#')))
}

fn is_scheme_start(s: &str) -> Option<usize> {
    let mut chars = s.char_indices();
    let (_, first) = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    for (i, c) in chars {
        if c == ':' {
            return Some(i);
        }
        if !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')) {
            return None;
        }
    }
    None
}

/// The URL gate. See the module docs; the rules and the table of cases are the UI's (`ui/src/modules/preview/logic.ts`).
pub fn validate(input: &str) -> Result<Gate, Refusal> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(Refusal::Empty);
    }
    if trimmed.len() > 2048 {
        return Err(Refusal::TooLong);
    }
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control() || c == '\\') {
        return Err(Refusal::BadChars);
    }
    let mut s = trimmed.to_owned();
    // Shorthands: `8082`, `:8082`, `localhost:8082/x`, `127.0.0.1`.
    let all_digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
    let port_shorthand = s.strip_prefix(':').is_some_and(|rest| {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        (1..=5).contains(&digits) && rest[digits..].chars().next().map_or(true, |c| matches!(c, '/' | '?' | '#'))
    });
    if (2..=5).contains(&s.len()) && all_digits(&s) {
        s = format!("http://localhost:{s}");
    } else if port_shorthand {
        s = format!("http://localhost{s}");
    } else if !s.starts_with(':') && loopback_prefix(&s) {
        s = format!("http://{s}");
    }
    match s.find("://") {
        Some(at) if is_scheme_start(&s[..=at]) == Some(at) => {
            if !s[..at].eq_ignore_ascii_case("http") {
                return Err(Refusal::Scheme);
            }
        }
        _ => {
            if let Some(colon) = is_scheme_start(&s) {
                // `host:1234/path` is an authority, anything else with a scheme-looking prefix (file:, javascript:, data:) is not.
                let after = &s[colon + 1..];
                let digits = after.bytes().take_while(u8::is_ascii_digit).count();
                let port_like = digits > 0 && after[digits..].chars().next().map_or(true, |c| matches!(c, '/' | '?' | '#'));
                if !port_like {
                    return Err(Refusal::Scheme);
                }
            }
            s = format!("http://{s}");
        }
    }
    let after_scheme = &s["http://".len()..];
    let end = after_scheme.find(['/', '?', '#']).unwrap_or(after_scheme.len());
    let (authority, rest) = after_scheme.split_at(end);
    if authority.contains('@') {
        return Err(Refusal::Credentials);
    }
    if authority.bytes().any(|b| !(0x21..=0x7e).contains(&b)) {
        return Err(Refusal::BadChars);
    }
    let (host_text, port_text) = match authority.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    let host = ["localhost", "127.0.0.1"].into_iter().find(|h| host_text.eq_ignore_ascii_case(h));
    let well_formed = port_text.map_or(true, |p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    let Some(host) = host else {
        return Err(Refusal::NotLoopback);
    };
    if !well_formed {
        return Err(Refusal::BadPort);
    }
    let port = match port_text {
        None => 80,
        Some(p) if p.len() > 5 => return Err(Refusal::BadPort),
        Some(p) => p.parse::<u32>().ok().filter(|n| (1..=65535).contains(n)).ok_or(Refusal::BadPort)? as u16,
    };
    if IDE_PORTS.contains(&port) {
        return Err(Refusal::SelfOrigin);
    }
    let origin = if port == 80 { format!("http://{host}") } else { format!("http://{host}:{port}") };
    let url = if rest.starts_with('/') { format!("{origin}{rest}") } else { format!("{origin}/{rest}") };
    Ok(Gate { url, host: host.to_owned(), port, origin })
}

/// Connects to the literal loopback addresses only (`localhost` is never resolved through DNS).
pub fn probe_port(host: &str, port: u16, timeout: Duration) -> bool {
    let mut addrs: Vec<SocketAddr> = vec![SocketAddr::from(([127, 0, 0, 1], port))];
    if host == "localhost" {
        addrs.push(SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port)));
    }
    addrs.into_iter().any(|a| TcpStream::connect_timeout(&a, timeout).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn a_valid_address_reports_host_port_and_origin() {
        let t = validate("127.0.0.1:8082/x?y=1").unwrap();
        assert_eq!((t.host.as_str(), t.port, t.origin.as_str(), t.url.as_str()), ("127.0.0.1", 8082, "http://127.0.0.1:8082", "http://127.0.0.1:8082/x?y=1"));
        assert_eq!(validate("localhost").unwrap().port, 80);
        assert_eq!(validate("http://localhost:1420"), Err(Refusal::SelfOrigin));
        assert_eq!(validate("http://127.0.0.1.nip.io:8082"), Err(Refusal::NotLoopback));
    }

    #[test]
    fn the_probe_sees_a_listener_and_a_closed_port() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(probe_port("127.0.0.1", port, Duration::from_millis(500)));
        assert!(probe_port("localhost", port, Duration::from_millis(500)));
        drop(listener);
        assert!(!probe_port("127.0.0.1", port, Duration::from_millis(300)));
    }
}
