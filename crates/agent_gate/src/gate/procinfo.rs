//! Thin libproc wrappers (macOS). A process can vanish between listing and inspecting it, so every function
//! reports "gone" as `None` / empty / `false` instead of failing.

use std::mem;

use libc::{c_int, c_void, pid_t};

const SZOMB: u32 = 5;

/// A process identity that survives pid reuse: the pid plus its start time (seconds).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProcKey {
    pub pid: i32,
    pub start_sec: u64,
}

impl ProcKey {
    pub fn of(pid: pid_t) -> Option<Self> {
        start_sec(pid).map(|start_sec| Self { pid, start_sec })
    }

    pub fn current() -> Self {
        let pid = std::process::id() as pid_t;
        Self::of(pid).unwrap_or(Self { pid, start_sec: 0 })
    }

    /// The same process is still running (a zombie counts as gone).
    pub fn is_alive(&self) -> bool {
        bsd_info(self.pid).is_some_and(|i| i.pbi_status != SZOMB && i.pbi_start_tvsec == self.start_sec)
    }
}

fn bsd_info(pid: pid_t) -> Option<libc::proc_bsdinfo> {
    if pid <= 0 {
        return None;
    }
    // SAFETY: plain-old-data struct, filled by the kernel up to the size we pass.
    let mut info: libc::proc_bsdinfo = unsafe { mem::zeroed() };
    let size = mem::size_of::<libc::proc_bsdinfo>() as c_int;
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut c_void, size) };
    (n == size).then_some(info)
}

/// The process exists and is not a zombie.
pub fn is_alive(pid: pid_t) -> bool {
    bsd_info(pid).is_some_and(|i| i.pbi_status != SZOMB)
}

pub fn start_sec(pid: pid_t) -> Option<u64> {
    bsd_info(pid).map(|i| i.pbi_start_tvsec)
}

pub fn parent_of(pid: pid_t) -> Option<pid_t> {
    bsd_info(pid).map(|i| i.pbi_ppid as pid_t)
}

pub fn pgid_of(pid: pid_t) -> Option<pid_t> {
    bsd_info(pid).map(|i| i.pbi_pgid as pid_t)
}

/// Resident set size in bytes; `None` for a vanished process or a zombie.
pub fn rss_bytes(pid: pid_t) -> Option<u64> {
    if pid <= 0 {
        return None;
    }
    let mut info: libc::proc_taskinfo = unsafe { mem::zeroed() };
    let size = mem::size_of::<libc::proc_taskinfo>() as c_int;
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTASKINFO, 0, &mut info as *mut _ as *mut c_void, size) };
    (n == size).then_some(info.pti_resident_size)
}

/// Both libproc list calls return the number of pids; the buffer grows until the list fits.
fn list_pids(call: impl Fn(*mut c_void, c_int) -> c_int) -> Vec<pid_t> {
    let mut cap = 256usize;
    loop {
        let mut buf = vec![0 as pid_t; cap];
        let n = call(buf.as_mut_ptr() as *mut c_void, (cap * mem::size_of::<pid_t>()) as c_int);
        if n <= 0 {
            return Vec::new();
        }
        let n = n as usize;
        if n >= cap && cap < 65_536 {
            cap *= 4;
            continue;
        }
        buf.truncate(n.min(cap));
        buf.retain(|p| *p > 0);
        return buf;
    }
}

/// Direct children only (use [`crate::gate::rss::descendants`] for the whole tree).
pub fn child_pids(pid: pid_t) -> Vec<pid_t> {
    list_pids(|buf, size| unsafe { libc::proc_listchildpids(pid, buf, size) })
}

/// Every process (zombies included) whose process group is `pgid`.
pub fn group_pids(pgid: pid_t) -> Vec<pid_t> {
    list_pids(|buf, size| unsafe { libc::proc_listpgrppids(pgid, buf, size) })
}

/// Live (non-zombie) members of a process group.
pub fn live_group_pids(pgid: pid_t) -> Vec<pid_t> {
    group_pids(pgid).into_iter().filter(|p| is_alive(*p)).collect()
}
