//! The app's process tree: the app itself, its WebKit helpers, the agent sidecar and what the sidecar started.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcKind {
    App,
    WebKit,
    Sidecar,
    Agent,
    Child,
}

/// One line of `ps -axo pid=,ppid=,rss=,command=`; `rss_kb` is in kilobytes as `ps` prints it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawProc {
    pub pid: u32,
    pub ppid: u32,
    pub rss_kb: u64,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcRow {
    pub pid: u32,
    pub name: String,
    pub kind: ProcKind,
    pub rss_bytes: u64,
    /// The app itself is never killable from the HUD.
    pub can_kill: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub total_bytes: u64,
    pub rows: Vec<ProcRow>,
    pub sidecar_pid: Option<u32>,
}

/// Parses `ps -axo pid=,ppid=,rss=,command=` output; malformed lines are skipped.
pub fn parse_ps(out: &str) -> Vec<RawProc> {
    out.lines()
        .filter_map(|line| {
            let mut it = line.split_whitespace();
            let (pid, ppid, rss) = (it.next()?.parse().ok()?, it.next()?.parse().ok()?, it.next()?.parse().ok()?);
            let command = it.collect::<Vec<_>>().join(" ");
            (!command.is_empty()).then_some(RawProc { pid, ppid, rss_kb: rss, command })
        })
        .collect()
}

fn short_name(command: &str) -> String {
    let first = command.split(" -").next().unwrap_or(command);
    let exe = first.split_whitespace().next().unwrap_or(first);
    let base = exe.rsplit('/').next().unwrap_or(exe);
    // `node /path/sidecar/dist/index.js` reads better than `node`
    if base == "node" {
        if let Some(script) = command.split_whitespace().nth(1) {
            let parts: Vec<&str> = script.rsplit('/').take(3).collect();
            if parts.len() > 1 {
                return format!("node {}", parts.into_iter().rev().collect::<Vec<_>>().join("/"));
            }
        }
    }
    base.to_owned()
}

fn is_webkit_helper(command: &str) -> bool {
    let exe = command.split(" -").next().unwrap_or(command);
    exe.contains("com.apple.WebKit.") || exe.contains("WebKit.WebContent") || exe.contains("WebKit.Networking") || exe.contains("WebKit.GPU")
}

/// Builds the HUD view. `responsible(pid)` answers "which app is this helper running for" (macOS launchd attribution), because
/// WebKit helpers are XPC services and not children of the app. A helper counts only when it is attributed to `app_pid`.
pub fn build_snapshot(raw: &[RawProc], app_pid: u32, sidecar_pid: Option<u32>, responsible: &dyn Fn(u32) -> Option<u32>) -> Snapshot {
    let mut kids: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in raw {
        kids.entry(p.ppid).or_default().push(p.pid);
    }
    let by_pid: HashMap<u32, &RawProc> = raw.iter().map(|p| (p.pid, p)).collect();
    let walk = |root: u32| -> Vec<u32> {
        let (mut seen, mut order, mut q) = (HashSet::new(), Vec::new(), VecDeque::from([root]));
        while let Some(pid) = q.pop_front() {
            if !seen.insert(pid) || order.len() > 4096 {
                continue;
            }
            order.push(pid);
            q.extend(kids.get(&pid).into_iter().flatten().copied());
        }
        order
    };
    let sidecar_tree: HashSet<u32> = sidecar_pid.map(|s| walk(s).into_iter().collect()).unwrap_or_default();
    let mut rows = Vec::new();
    let mut taken = HashSet::new();
    for pid in walk(app_pid) {
        let Some(p) = by_pid.get(&pid) else { continue };
        let kind = if pid == app_pid {
            ProcKind::App
        } else if Some(pid) == sidecar_pid {
            ProcKind::Sidecar
        } else if sidecar_tree.contains(&pid) {
            ProcKind::Agent
        } else if is_webkit_helper(&p.command) {
            ProcKind::WebKit
        } else {
            ProcKind::Child
        };
        taken.insert(pid);
        rows.push(ProcRow { pid, name: short_name(&p.command), kind, rss_bytes: p.rss_kb * 1024, can_kill: kind != ProcKind::App });
    }
    for p in raw {
        if !taken.contains(&p.pid) && is_webkit_helper(&p.command) && responsible(p.pid) == Some(app_pid) {
            rows.push(ProcRow { pid: p.pid, name: short_name(&p.command), kind: ProcKind::WebKit, rss_bytes: p.rss_kb * 1024, can_kill: true });
        }
    }
    rows.sort_by(|a, b| b.rss_bytes.cmp(&a.rss_bytes).then(a.pid.cmp(&b.pid)));
    Snapshot { total_bytes: rows.iter().map(|r| r.rss_bytes).sum(), rows, sidecar_pid }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KillError {
    /// The pid is not in the app's tree (never kill an arbitrary process).
    NotOurs,
    /// The app itself.
    Protected,
    Signal(i32),
}

/// Sends SIGTERM to `pid` if and only if it is a killable row of `snap` (a fresh snapshot taken by the caller).
pub fn kill_in_snapshot(snap: &Snapshot, pid: u32) -> Result<(), KillError> {
    let row = snap.rows.iter().find(|r| r.pid == pid).ok_or(KillError::NotOurs)?;
    if !row.can_kill {
        return Err(KillError::Protected);
    }
    // SAFETY: plain kill(2) on a pid that belongs to our own tree
    let rc = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    if rc == 0 { Ok(()) } else { Err(KillError::Signal(std::io::Error::last_os_error().raw_os_error().unwrap_or(-1))) }
}

#[cfg(target_os = "macos")]
pub fn responsible_pid(pid: u32) -> Option<u32> {
    use std::sync::OnceLock;
    type F = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;
    static SYM: OnceLock<Option<F>> = OnceLock::new();
    let f = SYM.get_or_init(|| {
        let name = c"responsibility_get_pid_responsible_for_pid";
        // SAFETY: dlsym on the default namespace; a missing symbol is None and the helpers are then simply not attributed
        let p = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
        (!p.is_null()).then(|| unsafe { std::mem::transmute::<*mut libc::c_void, F>(p) })
    });
    let r = unsafe { (*f.as_ref()?)(pid as libc::pid_t) };
    (r > 0).then_some(r as u32)
}

#[cfg(not(target_os = "macos"))]
pub fn responsible_pid(_pid: u32) -> Option<u32> {
    None
}

/// Runs `ps` once and builds the snapshot of this process's tree.
pub fn scan(sidecar_pid: Option<u32>) -> Snapshot {
    let out = std::process::Command::new("/bin/ps").args(["-axo", "pid=,ppid=,rss=,command="]).output();
    let raw = out.ok().map(|o| parse_ps(&String::from_utf8_lossy(&o.stdout))).unwrap_or_default();
    build_snapshot(&raw, std::process::id(), sidecar_pid, &responsible_pid)
}
