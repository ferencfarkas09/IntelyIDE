//! Orphan protection (providers-plan 5.6): every process group the IDE starts for an agent is recorded in a state
//! file (`gate.json`) together with the identity of the IDE process that owns it. After a crash the next start
//! sweeps the groups whose owner is gone. Identities are pid + start time, so a reused pid is never mistaken for
//! one of ours, and a group that contains a process older than its recorded leader is treated as foreign and left
//! alone.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use libc::pid_t;
use serde::{Deserialize, Serialize};

use super::cancel::{terminate_group, usable_pgid};
use super::procinfo::{self, ProcKey};

const SWEEP_GRACE: Duration = Duration::from_secs(3);
/// A group member that started this much before the group was registered cannot belong to it.
const MEMBER_SLACK_SECS: u64 = 300;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    pgid: i32,
    /// Start time of the leader process (pid == pgid) at record time.
    #[serde(default)]
    leader_start: Option<u64>,
    owner: ProcKey,
    lease_id: String,
    agent_id: String,
    recorded_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StateFile {
    version: u32,
    entries: Vec<Entry>,
}

#[derive(Serialize)]
struct StateRef<'a> {
    version: u32,
    entries: &'a [Entry],
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepReport {
    /// Groups of dead owners that were terminated.
    pub killed: Vec<i32>,
    /// Entries whose owner IDE instance is still running (kept).
    pub live_owner: Vec<i32>,
    /// Entries that no longer match what we recorded (pid reused, foreign member): dropped without a signal.
    pub foreign: Vec<i32>,
    /// Entries whose group was already empty.
    pub stale: Vec<i32>,
}

pub struct OrphanRegistry {
    path: PathBuf,
    lock_path: PathBuf,
    owner: ProcKey,
}

impl OrphanRegistry {
    /// State file at `path`; the owner is the current process.
    pub fn open(path: impl Into<PathBuf>) -> io::Result<Self> {
        Self::open_as(path, ProcKey::current())
    }

    pub fn open_as(path: impl Into<PathBuf>, owner: ProcKey) -> io::Result<Self> {
        let path = path.into();
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let lock_path = path.with_extension("lock");
        Ok(Self { path, lock_path, owner })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn record(&self, pgid: pid_t, lease_id: &str, agent_id: &str) -> io::Result<()> {
        if !usable_pgid(pgid) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "refusing to track pgid <= 1 or the gate's own group"));
        }
        let entry = Entry {
            pgid,
            leader_start: procinfo::start_sec(pgid),
            owner: self.owner,
            lease_id: lease_id.into(),
            agent_id: agent_id.into(),
            recorded_at: now_secs(),
        };
        self.update(|s| {
            s.entries.retain(|e| !(e.pgid == pgid && e.owner == entry.owner));
            s.entries.push(entry);
        })
    }

    pub fn forget(&self, pgid: pid_t) -> io::Result<()> {
        let owner = self.owner;
        self.update(|s| s.entries.retain(|e| !(e.pgid == pgid && e.owner == owner)))
    }

    /// Process groups currently recorded for this owner.
    pub fn recorded(&self) -> io::Result<Vec<i32>> {
        let owner = self.owner;
        Ok(self.read()?.entries.into_iter().filter(|e| e.owner == owner).map(|e| e.pgid).collect())
    }

    /// Startup sweep: terminates leftover groups whose owner IDE instance is gone. Blocks up to the SIGTERM grace.
    pub fn sweep(&self) -> io::Result<SweepReport> {
        let _guard = self.lock()?;
        let state = self.read()?;
        let mut report = SweepReport::default();
        let mut keep = Vec::new();
        let mut doomed = Vec::new();
        for e in state.entries {
            if e.owner.is_alive() {
                report.live_owner.push(e.pgid);
                keep.push(e);
                continue;
            }
            match classify(&e) {
                Verdict::Stale => report.stale.push(e.pgid),
                Verdict::Foreign => report.foreign.push(e.pgid),
                Verdict::Ours => doomed.push(e.pgid),
            }
        }
        let kills: Vec<_> = doomed.iter().map(|&g| std::thread::spawn(move || terminate_group(g, SWEEP_GRACE))).collect();
        for k in kills {
            let _ = k.join();
        }
        report.killed = doomed;
        self.write(&StateFile { version: 1, entries: keep })?;
        Ok(report)
    }

    fn update(&self, f: impl FnOnce(&mut StateFile)) -> io::Result<()> {
        let _guard = self.lock()?;
        let mut state = self.read()?;
        f(&mut state);
        self.write(&state)
    }

    fn read(&self) -> io::Result<StateFile> {
        match fs::read(&self.path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(StateFile::default()),
            Err(e) => Err(e),
        }
    }

    fn write(&self, state: &StateFile) -> io::Result<()> {
        let tmp = self.path.with_extension("json.tmp");
        let mut f = File::create(&tmp)?;
        f.write_all(&serde_json::to_vec_pretty(&StateRef { version: 1, entries: &state.entries })?)?;
        f.sync_all()?;
        fs::rename(tmp, &self.path)
    }

    /// Exclusive advisory lock so two IDE instances never interleave a read-modify-write.
    fn lock(&self) -> io::Result<LockGuard> {
        let file = OpenOptions::new().create(true).truncate(false).write(true).open(&self.lock_path)?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(LockGuard(file))
    }
}

struct LockGuard(File);

impl Drop for LockGuard {
    fn drop(&mut self) {
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}

enum Verdict {
    Ours,
    Stale,
    Foreign,
}

fn classify(e: &Entry) -> Verdict {
    if !usable_pgid(e.pgid) {
        return Verdict::Foreign;
    }
    let members = procinfo::live_group_pids(e.pgid);
    if members.is_empty() {
        return Verdict::Stale;
    }
    // The leader's pid was reused by something else: the group is not the one we recorded.
    if let (Some(recorded), Some(now)) = (e.leader_start, procinfo::start_sec(e.pgid)) {
        if procinfo::is_alive(e.pgid) && now != recorded {
            return Verdict::Foreign;
        }
    }
    let oldest_allowed = e.leader_start.unwrap_or_else(|| e.recorded_at.saturating_sub(MEMBER_SLACK_SECS));
    let foreign_member = members.iter().any(|&m| procinfo::start_sec(m).is_some_and(|s| s < oldest_allowed));
    if foreign_member {
        Verdict::Foreign
    } else {
        Verdict::Ours
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}
