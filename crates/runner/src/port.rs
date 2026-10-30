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

/// One listening TCP socket that `lsof` proved, on a loopback or wildcard address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listener {
    /// The process that owns the socket.
    pub pid: i32,
    pub port: u16,
    /// Reachable through 127.0.0.1 (bound to it or to 0.0.0.0 / `*` over IPv4).
    pub v4: bool,
    /// Reachable through ::1 (bound to it or to `[::]` / `*` over IPv6).
    pub v6: bool,
}

/// The listeners of `pids` as `lsof` lists them right now. `None` when `lsof` cannot be started (it is missing, as on Windows), which is
/// different from "nothing listens" (`Some(vec![])`). Nothing is taken from what a process prints.
pub fn listeners(pids: &[i32]) -> Option<Vec<Listener>> {
    if pids.is_empty() {
        return Some(Vec::new());
    }
    let list: Vec<String> = pids.iter().take(256).map(i32::to_string).collect();
    let out = Command::new("lsof").args(["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", &list.join(",")]).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    Some(parse_listeners(&String::from_utf8_lossy(&out.stdout)))
}

pub fn parse_listeners(text: &str) -> Vec<Listener> {
    let mut out: Vec<Listener> = Vec::new();
    for line in text.lines().filter(|l| l.contains("(LISTEN)")) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        let (Some(pid), Some(kind)) = (cols.get(1).and_then(|c| c.parse::<i32>().ok()), cols.get(4)) else { continue };
        let Some(name) = cols.iter().rev().nth(1) else { continue };
        let Some((host, port)) = name.rsplit_once(':') else { continue };
        let Ok(port) = port.parse::<u16>() else { continue };
        let ipv6 = *kind == "IPv6";
        let (v4, v6) = match host {
            "127.0.0.1" | "0.0.0.0" => (true, false),
            "[::1]" | "[::]" => (false, true),
            "*" => (!ipv6, ipv6),
            _ => continue,
        };
        match out.iter_mut().find(|l| l.pid == pid && l.port == port) {
            Some(l) => {
                l.v4 |= v4;
                l.v6 |= v6;
            }
            None => out.push(Listener { pid, port, v4, v6 }),
        }
    }
    out
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
    fn listeners_carry_their_owner_and_the_address_family_lsof_proved() {
        let out = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n\
                   node 11 u 20u IPv4 0x1 0t0 TCP 127.0.0.1:41234 (LISTEN)\n\
                   node 12 u 21u IPv6 0x2 0t0 TCP *:8082 (LISTEN)\n\
                   node 12 u 22u IPv4 0x3 0t0 TCP *:8082 (LISTEN)\n\
                   node 13 u 23u IPv6 0x4 0t0 TCP [::1]:5173 (LISTEN)\n\
                   node 14 u 24u IPv4 0x5 0t0 TCP 192.168.1.5:9999 (LISTEN)\n";
        let l = parse_listeners(out);
        assert_eq!(l.len(), 3, "{l:?}");
        assert_eq!(l[0], Listener { pid: 11, port: 41234, v4: true, v6: false });
        assert_eq!(l[1], Listener { pid: 12, port: 8082, v4: true, v6: true });
        assert_eq!(l[2], Listener { pid: 13, port: 5173, v4: false, v6: true });
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

    /// The review's attack: a dev script that only PRINTS a port (`echo "Local: http://localhost:2375/"; sleep 999`) must not make that
    /// port count; only a socket the process tree really listens on does, and a socket of another process never counts.
    #[cfg(unix)]
    #[test]
    fn a_printed_port_is_not_a_listener_and_another_process_listener_is_not_ours() {
        if Command::new("lsof").arg("-v").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_err() {
            eprintln!("lsof is not installed: skipped");
            return;
        }
        let mut liar = Command::new("sh").args(["-c", "echo 'Local: http://localhost:2375/'; exec sleep 30"]).stdin(Stdio::null()).stdout(Stdio::null()).spawn().unwrap();
        let mine = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let my_port = mine.local_addr().unwrap().port();
        std::thread::sleep(std::time::Duration::from_millis(150));
        let liar_pid = liar.id() as i32;
        let of_liar = listeners(&[liar_pid]).expect("lsof ran");
        assert!(of_liar.is_empty(), "{of_liar:?}");
        assert!(ports_in_line("Local: http://localhost:2375/").contains(&2375), "the log parser would have believed the script");
        // the listening socket of THIS process is found for this process and not for the other one
        let of_me = listeners(&[std::process::id() as i32]).expect("lsof ran");
        assert!(of_me.iter().any(|l| l.port == my_port && l.v4 && l.pid == std::process::id() as i32), "{of_me:?}");
        assert!(!of_liar.iter().any(|l| l.port == my_port));
        let _ = liar.kill();
        let _ = liar.wait();
    }
}
