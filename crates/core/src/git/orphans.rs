//! Leftovers of a killed app: a SIGKILL or crash skips `Engine::shutdown`, so a `git commit` (with its hooks) can
//! outlive the app, and its temp index (`ide-index.<pid>.<n>`, named after the dead app) stays in the git dir.
//! The orphan is recognised by its command line (`ps` hides the environment of other processes on current macOS).

use std::path::Path;
#[cfg(unix)]
use std::process::Command;
use std::time::Duration;

const PREFIX: &str = "ide-index.";

/// Stops orphaned commits that belong to a dead app and removes their temp indexes. A no-op unless such a file
/// exists, so it costs one directory read per repo on a clean start.
pub fn sweep_stale_temp_indexes(repo_root: &Path) {
    let git_dir = repo_root.join(".git");
    let Ok(entries) = std::fs::read_dir(git_dir) else { return };
    let own = std::process::id();
    let stale: Vec<_> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let pid: u32 = name.strip_prefix(PREFIX)?.split('.').next()?.parse().ok()?;
            (pid != own && !pid_alive(pid)).then(|| (e.path(), name))
        })
        .collect();
    if stale.is_empty() {
        return;
    }
    // An orphaned commit would read a vanished temp index as empty and could commit a tree without any files.
    let orphans = orphaned_commits(repo_root);
    for kill in [false, true] {
        for pid in &orphans {
            // Each git child leads its own process group, so this takes the hooks down with it.
            stop_orphan(*pid, kill);
        }
        if !orphans.is_empty() && !kill {
            std::thread::sleep(Duration::from_millis(300));
        }
    }
    for (path, _) in stale {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(unix)]
fn stop_orphan(pid: u32, kill: bool) {
    let sig = if kill { libc::SIGKILL } else { libc::SIGTERM };
    // SAFETY: plain signal delivery to a pid/group we just found.
    unsafe {
        let target = if libc::getpgid(pid as i32) == pid as i32 { -(pid as i32) } else { pid as i32 };
        libc::kill(target, sig);
    }
}

#[cfg(not(unix))]
fn stop_orphan(pid: u32, kill: bool) {
    crate::sys::kill_group(pid as i32, kill);
}

fn pid_alive(pid: u32) -> bool {
    crate::sys::pid_alive(pid)
}

/// Pids re-parented to launchd (ppid 1) that run this engine's `git -C <repo> ... commit -F - --cleanup=whitespace`.
#[cfg(not(unix))]
fn orphaned_commits(_repo_root: &Path) -> Vec<u32> {
    // No `ps` and no reparenting to an init process on Windows: nothing to find.
    Vec::new()
}

#[cfg(unix)]
fn orphaned_commits(repo_root: &Path) -> Vec<u32> {
    let Ok(out) = Command::new("ps").args(["-axww", "-o", "pid=,ppid=,command="]).output() else { return Vec::new() };
    let root = format!("-C {}", repo_root.display());
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid: u32 = fields.next()?.parse().ok()?;
            let ppid: u32 = fields.next()?.parse().ok()?;
            let ours = line.contains(&root) && line.contains(" commit -F - --cleanup=whitespace");
            (ppid == 1 && ours).then_some(pid)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[cfg_attr(not(unix), allow(unused_imports))]
    use super::*;

    #[cfg(unix)]
    #[test]
    fn dead_apps_leave_nothing_behind_and_live_ones_are_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let gd = dir.path().join(".git");
        std::fs::create_dir(&gd).unwrap();
        let dead = {
            let mut c = Command::new("true").spawn().unwrap();
            let pid = c.id();
            c.wait().unwrap();
            pid
        };
        let stale = gd.join(format!("{PREFIX}{dead}.0"));
        let stale_lock = gd.join(format!("{PREFIX}{dead}.0.lock"));
        let own = gd.join(format!("{PREFIX}{}.0", std::process::id()));
        let other = gd.join("index");
        for f in [&stale, &stale_lock, &own, &other] {
            std::fs::write(f, "x").unwrap();
        }
        // an orphan: a background child re-parented to launchd whose command line looks like the engine's commit
        let root = dir.path().display().to_string();
        Command::new("sh")
            .arg("-c")
            .arg(format!("(sh -c 'sleep 8 # -C {root} commit -F - --cleanup=whitespace' </dev/null >/dev/null 2>&1 &)"))
            .status()
            .unwrap();
        std::thread::sleep(Duration::from_millis(300));

        sweep_stale_temp_indexes(dir.path());

        assert!(!stale.exists() && !stale_lock.exists());
        assert!(own.exists() && other.exists());
        let alive = Command::new("pgrep").args(["-f", &format!("sleep 8 # -C {root}")]).output().unwrap();
        assert!(alive.stdout.is_empty(), "the orphan survived the sweep");
    }
}
