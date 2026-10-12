//! `/proc` reader (Linux). Fields come from `/proc/<pid>/stat`; the command name is parenthesised and may hold spaces
//! and parentheses, so parsing starts after the LAST `)`.

use std::fs;

use super::pid_t;

struct Stat {
    state: char,
    ppid: pid_t,
    pgrp: pid_t,
    start_ticks: u64,
    rss_pages: u64,
}

fn stat(pid: pid_t) -> Option<Stat> {
    if pid <= 0 {
        return None;
    }
    let text = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = &text[text.rfind(')')? + 1..];
    // after the name: state(3) ppid(4) pgrp(5) session(6) ... starttime(22) vsize(23) rss(24)
    let f: Vec<&str> = rest.split_whitespace().collect();
    Some(Stat {
        state: f.first()?.chars().next()?,
        ppid: f.get(1)?.parse().ok()?,
        pgrp: f.get(2)?.parse().ok()?,
        start_ticks: f.get(19)?.parse().ok()?,
        rss_pages: f.get(21)?.parse().ok()?,
    })
}

fn ticks_per_sec() -> u64 {
    let t = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if t > 0 { t as u64 } else { 100 }
}

/// The process exists and is not a zombie.
pub fn is_alive(pid: pid_t) -> bool {
    stat(pid).is_some_and(|s| s.state != 'Z' && s.state != 'X')
}

/// Boot time in seconds since the epoch (`btime` of `/proc/stat`), read once.
fn boot_time() -> u64 {
    static BOOT: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *BOOT.get_or_init(|| {
        fs::read_to_string("/proc/stat").ok().and_then(|t| t.lines().find_map(|l| l.strip_prefix("btime ")?.trim().parse().ok())).unwrap_or(0)
    })
}

/// Seconds since the epoch at which the process started (like the macOS value): the orphan registry compares it with wall-clock times.
pub fn start_sec(pid: pid_t) -> Option<u64> {
    stat(pid).map(|s| boot_time() + s.start_ticks / ticks_per_sec())
}

pub fn parent_of(pid: pid_t) -> Option<pid_t> {
    stat(pid).map(|s| s.ppid)
}

pub fn pgid_of(pid: pid_t) -> Option<pid_t> {
    stat(pid).map(|s| s.pgrp)
}

/// Resident set size in bytes; `None` for a vanished process or a zombie.
pub fn rss_bytes(pid: pid_t) -> Option<u64> {
    let s = stat(pid).filter(|s| s.state != 'Z')?;
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    Some(s.rss_pages * if page > 0 { page as u64 } else { 4096 })
}

fn all_pids() -> Vec<pid_t> {
    let Ok(dir) = fs::read_dir("/proc") else { return Vec::new() };
    dir.flatten().filter_map(|e| e.file_name().to_str()?.parse::<pid_t>().ok()).filter(|p| *p > 0).collect()
}

/// Direct children only (use [`crate::gate::rss::descendants`] for the whole tree).
pub fn child_pids(pid: pid_t) -> Vec<pid_t> {
    all_pids().into_iter().filter(|p| stat(*p).is_some_and(|s| s.ppid == pid)).collect()
}

/// Every process (zombies included) whose process group is `pgid`.
pub fn group_pids(pgid: pid_t) -> Vec<pid_t> {
    all_pids().into_iter().filter(|p| stat(*p).is_some_and(|s| s.pgrp == pgid)).collect()
}

/// Live (non-zombie) members of a process group.
pub fn live_group_pids(pgid: pid_t) -> Vec<pid_t> {
    group_pids(pgid).into_iter().filter(|p| is_alive(*p)).collect()
}
