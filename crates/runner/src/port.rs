//! Port detection: first from what a dev server prints (cheap, instant), then confirmed from `lsof` (authoritative).
//! Only loopback / wildcard listeners count; the URL chip is always `http://localhost:<port>`.

use std::process::{Command, Stdio};

/// `text` without ANSI escape sequences (CSI and OSC).
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for n in chars.by_ref() {
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
            Some(']') => {
                for n in chars.by_ref() {
                    if n == '\u{7}' {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

const HOSTS: [&str; 6] = ["localhost:", "127.0.0.1:", "0.0.0.0:", "[::1]:", "[::]:", "://*:"];

/// Ports named in one output line: `http://localhost:8082/`, `0.0.0.0:3000`, `listening on port 8080`.
pub fn ports_in_line(line: &str) -> Vec<u16> {
    let plain = strip_ansi(line);
    let lower = format!(" {}", plain.to_ascii_lowercase());
    let mut out = Vec::new();
    let mut push = |digits: &str| {
        if let Ok(p) = digits.parse::<u32>() {
            if (1024..=65535).contains(&p) && !out.contains(&(p as u16)) {
                out.push(p as u16);
            }
        }
    };
    for host in HOSTS {
        let mut rest = lower.as_str();
        while let Some(at) = rest.find(host) {
            rest = &rest[at + host.len()..];
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            push(&digits);
        }
    }
    for key in [" listening on port ", " listening on ", " running on port ", " started on port ", " on port ", " port: ", " port "] {
        if let Some(at) = lower.find(key) {
            let digits: String = lower[at + key.len()..].chars().take_while(char::is_ascii_digit).collect();
            push(&digits);
        }
    }
    out
}

/// Listening loopback / wildcard TCP ports of `pids`, sorted. Empty when `lsof` is missing or nothing listens.
pub fn listening_ports(pids: &[i32]) -> Vec<u16> {
    if pids.is_empty() {
        return Vec::new();
    }
    let list: Vec<String> = pids.iter().take(256).map(i32::to_string).collect();
    let Ok(out) = Command::new("lsof")
        .args(["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", &list.join(",")])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    parse_lsof(&String::from_utf8_lossy(&out.stdout))
}

pub fn parse_lsof(text: &str) -> Vec<u16> {
    let mut ports: Vec<u16> = Vec::new();
    for line in text.lines().filter(|l| l.contains("(LISTEN)")) {
        let Some(name) = line.split_whitespace().rev().nth(1) else { continue };
        let Some((host, port)) = name.rsplit_once(':') else { continue };
        let loopback = matches!(host, "*" | "127.0.0.1" | "[::1]" | "[::]" | "localhost" | "0.0.0.0");
        if let (true, Ok(p)) = (loopback, port.parse::<u16>()) {
            if !ports.contains(&p) {
                ports.push(p);
            }
        }
    }
    ports.sort_unstable();
    ports
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ports_come_out_of_typical_dev_server_lines() {
        assert_eq!(ports_in_line("\u{1b}[32m  Local:\u{1b}[0m   http://localhost:\u{1b}[1m5173\u{1b}[0m/"), vec![5173]);
        assert_eq!(ports_in_line("Server running at http://127.0.0.1:8082/ and http://0.0.0.0:8082"), vec![8082]);
        assert_eq!(ports_in_line("listening on port 3000"), vec![3000]);
        assert_eq!(ports_in_line("Project is running at: http://[::1]:8080/"), vec![8080]);
        assert!(ports_in_line("Compiled 80 modules in 4s, size 2048").is_empty());
        assert!(ports_in_line("port 80 is privileged").is_empty());
    }

    #[test]
    fn lsof_output_is_parsed_for_loopback_listeners_only() {
        let out = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n\
                   node 1 u 20u IPv4 0x1 0t0 TCP 127.0.0.1:41234 (LISTEN)\n\
                   node 1 u 21u IPv6 0x2 0t0 TCP *:8082 (LISTEN)\n\
                   node 1 u 22u IPv4 0x3 0t0 TCP 192.168.1.5:9999 (LISTEN)\n\
                   node 1 u 23u IPv4 0x4 0t0 TCP 127.0.0.1:5000->127.0.0.1:6000 (ESTABLISHED)\n";
        assert_eq!(parse_lsof(out), vec![8082, 41234]);
    }
}
