//! Process-tree RSS (providers-plan 4.4): the agent CLI plus its MCP servers, language servers and sandbox
//! shells. A tree is the union of the descendants of each root pid and every live member of the given process
//! groups, so a child that called `setsid` or was reparented after its parent died is still counted.

use std::collections::HashSet;

use super::procinfo::pid_t;

use super::procinfo;

const MAX_TREE: usize = 4096;

/// `root` and all its descendants (breadth first, cycle-safe, capped).
pub fn descendants(root: pid_t) -> Vec<pid_t> {
    let mut seen = HashSet::new();
    let mut order = Vec::new();
    let mut queue = std::collections::VecDeque::from([root]);
    while let Some(pid) = queue.pop_front() {
        if pid <= 0 || !seen.insert(pid) || order.len() >= MAX_TREE {
            continue;
        }
        order.push(pid);
        queue.extend(procinfo::child_pids(pid));
    }
    order
}

/// Union of the descendants of `roots` and the live members of `pgids`, without duplicates.
pub fn tree_pids(roots: &[pid_t], pgids: &[pid_t]) -> Vec<pid_t> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for pid in roots.iter().flat_map(|r| descendants(*r)).chain(pgids.iter().flat_map(|g| procinfo::live_group_pids(*g))) {
        if seen.insert(pid) {
            out.push(pid);
        }
    }
    out
}

/// Process groups of everything in the trees below `pgids` (live members and all their descendants), the given
/// groups themselves left out. The Bash tool puts every command in a group of its own, so a lease that only knows
/// the CLI's group would leave a stubborn foreground command running after the CLI is killed.
pub fn descendant_pgids(pgids: &[pid_t]) -> Vec<pid_t> {
    let roots: Vec<pid_t> = pgids.iter().flat_map(|g| procinfo::live_group_pids(*g)).collect();
    let mut out: Vec<pid_t> = Vec::new();
    for pid in roots.iter().flat_map(|r| descendants(*r)) {
        if let Some(g) = procinfo::pgid_of(pid).filter(|g| *g > 1 && !pgids.contains(g) && !out.contains(g)) {
            out.push(g);
        }
    }
    out
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeRss {
    pub bytes: u64,
    pub procs: usize,
}

impl TreeRss {
    pub fn mb(&self) -> u64 {
        self.bytes / (1024 * 1024)
    }
}

/// Sum of the resident sizes of the whole tree; vanished processes and zombies count as 0.
pub fn tree_rss(roots: &[pid_t], pgids: &[pid_t]) -> TreeRss {
    tree_pids(roots, pgids).into_iter().filter_map(procinfo::rss_bytes).fold(TreeRss::default(), |acc, bytes| TreeRss {
        bytes: acc.bytes + bytes,
        procs: acc.procs + 1,
    })
}

/// The physical memory of this machine in bytes; `None` where it cannot be read (an unsupported platform). The default memory budget of
/// the runs is a share of it.
pub fn physical_memory_bytes() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        let mut size: u64 = 0;
        let mut len = std::mem::size_of::<u64>();
        // SAFETY: the name is NUL-terminated; `size` and `len` are valid for the call and `len` is the size of `size`.
        let rc = unsafe { libc::sysctlbyname(c"hw.memsize".as_ptr(), (&mut size as *mut u64).cast(), &mut len, std::ptr::null_mut(), 0) };
        (rc == 0 && size > 0).then_some(size)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // SAFETY: `sysconf` has no preconditions.
        let (pages, page) = unsafe { (libc::sysconf(libc::_SC_PHYS_PAGES), libc::sysconf(libc::_SC_PAGESIZE)) };
        (pages > 0 && page > 0).then(|| pages as u64 * page as u64)
    }
    #[cfg(not(unix))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_physical_memory_is_known_on_the_platforms_that_run_agents() {
        if cfg!(unix) {
            let bytes = physical_memory_bytes().expect("macOS and Linux can tell");
            assert!((256 << 20..64 << 40).contains(&bytes), "{bytes} bytes is not a plausible amount of memory");
        }
    }
}
