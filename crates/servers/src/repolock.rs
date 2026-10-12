//! A per-(server, folder) lock between "send my changes there" and the start of a run in that folder.
//!
//! A transfer holds the lock while it checks that no run works there and applies the patch; a run that is starting holds a "starting"
//! mark from the moment its folders are settled until it is registered (and so visible to the transfer's busy check). Each side refuses
//! while the other holds its mark, so a run cannot slip in between the transfer's check and its apply. Folders are the real
//! (physical) ones, compared as equal-or-nested. It only knows runs started by THIS IDE: a run started from another IDE or from a
//! terminal on the server is not seen.

use std::sync::{Mutex, MutexGuard};

use crate::paths::equal_or_nested;

#[derive(Default)]
struct State {
    transfers: Vec<(String, String)>,
    starting: Vec<(String, String)>,
}

static STATE: Mutex<State> = Mutex::new(State { transfers: Vec::new(), starting: Vec::new() });

fn state() -> MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

fn clash(a: &str, b: &str) -> bool {
    equal_or_nested(a, b) || equal_or_nested(b, a)
}

/// Held while a transfer works in a folder.
pub struct TransferLock {
    key: (String, String),
}

impl Drop for TransferLock {
    fn drop(&mut self) {
        let mut st = state();
        if let Some(i) = st.transfers.iter().position(|k| *k == self.key) {
            st.transfers.remove(i);
        }
    }
}

/// Held by a run that is starting, until it is registered.
pub struct StartGuard {
    keys: Vec<(String, String)>,
}

impl Drop for StartGuard {
    fn drop(&mut self) {
        let mut st = state();
        for k in &self.keys {
            if let Some(i) = st.starting.iter().position(|s| s == k) {
                st.starting.remove(i);
            }
        }
    }
}

/// For a transfer into `physical` on `server`; `Err` while a run is starting there or another transfer works there.
pub fn lock_for_transfer(server: &str, physical: &str) -> Result<TransferLock, String> {
    let mut st = state();
    if st.starting.iter().any(|(s, p)| s == server && clash(p, physical)) {
        return Err("a run is starting in that repository on this server; try again in a moment".into());
    }
    if st.transfers.iter().any(|(s, p)| s == server && clash(p, physical)) {
        return Err("another transfer is working in that repository".into());
    }
    let key = (server.to_string(), physical.to_string());
    st.transfers.push(key.clone());
    Ok(TransferLock { key })
}

/// For a run that starts in `dirs` on `server`; `Err` while a transfer works in one of them.
pub fn begin_run(server: &str, dirs: &[String]) -> Result<StartGuard, String> {
    let mut st = state();
    if st.transfers.iter().any(|(s, p)| s == server && dirs.iter().any(|d| clash(p, d))) {
        return Err("the changes of this repository are being copied to the server right now; start the run again in a moment".into());
    }
    let keys: Vec<(String, String)> = dirs.iter().map(|d| (server.to_string(), d.clone())).collect();
    st.starting.extend(keys.iter().cloned());
    Ok(StartGuard { keys })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_transfer_and_a_starting_run_exclude_each_other_in_both_orders() {
        let t = lock_for_transfer("lock-s1", "/srv/app").unwrap();
        assert!(begin_run("lock-s1", &["/srv/app".into()]).is_err());
        assert!(begin_run("lock-s1", &["/srv/app/sub".into()]).is_err());
        assert!(begin_run("lock-s2", &["/srv/app".into()]).is_ok());
        assert!(lock_for_transfer("lock-s1", "/srv/app").is_err());
        drop(t);
        let g = begin_run("lock-s1", &["/srv/app".into()]).unwrap();
        assert!(lock_for_transfer("lock-s1", "/srv/app").is_err());
        assert!(lock_for_transfer("lock-s1", "/srv/other").is_ok());
        drop(g);
        assert!(lock_for_transfer("lock-s1", "/srv/app").is_ok());
    }
}
