//! No process inspection (Windows): nothing is listed, so the gate sees no process groups and never reports a tree. The
//! cancel path ends a run by killing the process tree of the leader instead (see `cancel::signal_groups`).

use super::pid_t;

pub fn is_alive(_pid: pid_t) -> bool {
    false
}

pub fn start_sec(_pid: pid_t) -> Option<u64> {
    None
}

pub fn parent_of(_pid: pid_t) -> Option<pid_t> {
    None
}

pub fn pgid_of(_pid: pid_t) -> Option<pid_t> {
    None
}

pub fn rss_bytes(_pid: pid_t) -> Option<u64> {
    None
}

pub fn child_pids(_pid: pid_t) -> Vec<pid_t> {
    Vec::new()
}

pub fn group_pids(_pgid: pid_t) -> Vec<pid_t> {
    Vec::new()
}

pub fn live_group_pids(_pgid: pid_t) -> Vec<pid_t> {
    Vec::new()
}
