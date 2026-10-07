//! `EventLog`: where normalized events are persisted (providers-plan 1.5, 5.1). Phase 2 is one append-only JSONL
//! file per run, no index, no search; Phase 6 adds a SQLite implementation behind the same trait and runs the same
//! [`contract::check`].

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use super::types::AgentEvent;

pub const RETENTION_DAYS: u64 = 30;

#[derive(Debug, thiserror::Error)]
pub enum LogError {
    #[error("invalid agent id {0:?} (only letters, digits, '-', '_' and '.' are allowed)")]
    InvalidAgentId(String),
    #[error("event seq {got} does not follow seq {last} of {agent}")]
    OutOfOrder { agent: String, last: u64, got: u64 },
    #[error("corrupt event on line {line} of the log of {agent}: {message}")]
    Corrupt { agent: String, line: usize, message: String },
    #[error("event log I/O: {0}")]
    Io(#[from] io::Error),
}

pub trait EventLog: Send + Sync {
    /// Appends one event. `seq` must be greater than the last stored one of that agent.
    fn append(&self, event: &AgentEvent) -> Result<(), LogError>;

    fn append_batch(&self, events: &[AgentEvent]) -> Result<(), LogError> {
        events.iter().try_for_each(|e| self.append(e))
    }

    /// All events of a run in order; an unknown run is empty.
    fn read(&self, agent_id: &str) -> Result<Vec<AgentEvent>, LogError>;

    /// Ids of all runs that have a log, sorted.
    fn runs(&self) -> Result<Vec<String>, LogError>;

    /// Up to `limit` events of a run with `seq >= from_seq`, in order (providers-plan 5.10, remote-plan R1: a
    /// reconnecting reader asks for `last_seen + 1`). If the log no longer holds `from_seq` (rotated), the first
    /// event returned has a higher `seq`: the caller compares and falls back to a snapshot. Backends with an index
    /// override this; the default reads the whole run.
    fn read_from(&self, agent_id: &str, from_seq: u64, limit: usize) -> Result<Vec<AgentEvent>, LogError> {
        Ok(self.read(agent_id)?.into_iter().filter(|e| e.seq >= from_seq).take(limit).collect())
    }

    /// Highest stored `seq` of a run; `None` for an unknown or empty run. A resumed run continues from here.
    fn last_seq(&self, agent_id: &str) -> Result<Option<u64>, LogError> {
        Ok(self.read(agent_id)?.last().map(|e| e.seq))
    }
}

/// `<base>/runs/<agentId>.jsonl`, 30-day rotation by file age.
pub struct JsonlEventLog {
    dir: PathBuf,
    /// Open append handles and the last stored `seq` per agent.
    open: Mutex<HashMap<String, (File, Option<u64>)>>,
}

impl JsonlEventLog {
    /// `base` is the IDE's data directory (see [`Self::default_base_dir`]); tests pass a temp dir.
    pub fn new(base: &Path) -> Self {
        Self { dir: base.join("runs"), open: Mutex::new(HashMap::new()) }
    }

    /// `~/Library/Application Support/IntelySwitchIDE`
    pub fn default_base_dir() -> Option<PathBuf> {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support/IntelySwitchIDE"))
    }

    fn path(&self, agent_id: &str) -> Result<PathBuf, LogError> {
        let ok = !agent_id.is_empty()
            && agent_id.len() <= 128
            && !agent_id.starts_with('.')
            && agent_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
        if ok {
            Ok(self.dir.join(format!("{agent_id}.jsonl")))
        } else {
            Err(LogError::InvalidAgentId(agent_id.to_string()))
        }
    }

    /// Deletes run files not modified for [`RETENTION_DAYS`]; returns the agent ids removed.
    pub fn prune(&self, now: SystemTime) -> Result<Vec<String>, LogError> {
        let max_age = Duration::from_secs(RETENTION_DAYS * 24 * 3600);
        let mut removed = Vec::new();
        let entries = match fs::read_dir(&self.dir) {
            Ok(e) => e,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(removed),
            Err(e) => return Err(e.into()),
        };
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            let Some(id) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".jsonl")).map(str::to_string) else { continue };
            let modified = entry.metadata()?.modified()?;
            if now.duration_since(modified).is_ok_and(|age| age > max_age) {
                self.open.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
                fs::remove_file(&path)?;
                removed.push(id);
            }
        }
        removed.sort();
        Ok(removed)
    }
}

/// Last stored `seq` of a log file, and the length to cut it to when it ends in a torn (unterminated) line.
fn scan_tail(path: &Path, agent: &str) -> Result<(Option<u64>, Option<u64>), LogError> {
    let mut text = String::new();
    match File::open(path) {
        Ok(mut f) => {
            f.read_to_string(&mut text)?;
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((None, None)),
        Err(e) => return Err(e.into()),
    }
    let torn = !text.is_empty() && !text.ends_with('\n');
    let complete = if torn { text.rsplit_once('\n').map_or("", |(head, _)| head) } else { text.as_str() };
    let cut = torn.then(|| text.rfind('\n').map_or(0, |i| i as u64 + 1));
    let last = match complete.lines().rev().find(|l| !l.trim().is_empty()) {
        Some(line) => {
            let event: AgentEvent = serde_json::from_str(line).map_err(|e| LogError::Corrupt { agent: agent.to_string(), line: complete.lines().count(), message: e.to_string() })?;
            Some(event.seq)
        }
        None => None,
    };
    Ok((last, cut))
}

/// Creates `dir` (and parents) and makes `dir` itself owner-only: run logs and metadata live below it.
pub fn create_private_dir_all(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

impl EventLog for JsonlEventLog {
    fn append(&self, event: &AgentEvent) -> Result<(), LogError> {
        let path = self.path(&event.agent_id)?;
        let mut open = self.open.lock().unwrap_or_else(|p| p.into_inner());
        if !open.contains_key(&event.agent_id) {
            create_private_dir_all(&self.dir)?;
            let (last, cut) = scan_tail(&path, &event.agent_id)?;
            let file = OpenOptions::new().create(true).append(true).mode(0o600).open(&path)?;
            // logs hold tool output and home paths: owner only, also for files an older build created world-readable
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
            if let Some(len) = cut {
                // a crash cut the last line: drop the fragment so only that event is lost
                file.set_len(len)?;
            }
            open.insert(event.agent_id.clone(), (file, last));
        }
        let Some((file, last)) = open.get_mut(&event.agent_id) else { unreachable!("inserted above") };
        if let Some(last_seq) = *last {
            if event.seq <= last_seq {
                return Err(LogError::OutOfOrder { agent: event.agent_id.clone(), last: last_seq, got: event.seq });
            }
        }
        let mut line = serde_json::to_vec(event).map_err(io::Error::other)?;
        line.push(b'\n');
        file.write_all(&line)?;
        *last = Some(event.seq);
        Ok(())
    }

    fn read(&self, agent_id: &str) -> Result<Vec<AgentEvent>, LogError> {
        let path = self.path(agent_id)?;
        let text = match fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let torn_tail = !text.is_empty() && !text.ends_with('\n');
        let lines: Vec<&str> = text.lines().collect();
        let mut out = Vec::with_capacity(lines.len());
        for (i, line) in lines.iter().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<AgentEvent>(line) {
                Ok(e) => out.push(e),
                Err(_) if torn_tail && i + 1 == lines.len() => {}
                Err(e) => return Err(LogError::Corrupt { agent: agent_id.to_string(), line: i + 1, message: e.to_string() }),
            }
        }
        Ok(out)
    }

    fn runs(&self) -> Result<Vec<String>, LogError> {
        let mut ids: Vec<String> = match fs::read_dir(&self.dir) {
            Ok(entries) => entries
                .filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".jsonl")).map(str::to_string))
                .collect(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        ids.sort();
        Ok(ids)
    }
}

/// Behavior every `EventLog` must have; the SQLite log of Phase 6 reuses it. Panics on a violation.
pub mod contract {
    use super::{EventLog, LogError};
    use crate::events::samples::sample_events;

    pub fn check<L: EventLog>(log: &L) {
        let stream = sample_events();
        let a1 = &stream;
        let a2: Vec<_> = stream.iter().cloned().map(|mut e| { e.agent_id = "a2".into(); e }).collect();

        assert_eq!(log.read("a1").unwrap(), vec![], "unknown run reads as empty");
        assert_eq!(log.runs().unwrap(), Vec::<String>::new());

        // interleaved appends of two runs stay separate and ordered
        for (x, y) in a1.iter().zip(a2.iter()) {
            log.append(x).unwrap();
            log.append(y).unwrap();
        }
        assert_eq!(&log.read("a1").unwrap(), a1);
        assert_eq!(log.read("a2").unwrap(), a2);
        assert_eq!(log.runs().unwrap(), vec!["a1".to_string(), "a2".to_string()]);

        // a repeated or older seq is refused and changes nothing
        let err = log.append(&a1[3]).unwrap_err();
        assert!(matches!(err, LogError::OutOfOrder { .. }), "got {err:?}");
        assert_eq!(log.read("a1").unwrap().len(), a1.len());

        // ids that could escape the run directory are refused
        for bad in ["", "../x", "a/b", ".hidden", "a b"] {
            let mut e = a1[0].clone();
            e.agent_id = bad.to_string();
            assert!(matches!(log.append(&e), Err(LogError::InvalidAgentId(_))), "{bad:?}");
            assert!(matches!(log.read(bad), Err(LogError::InvalidAgentId(_))), "{bad:?}");
        }

        // seq resume (R1): a reader that reconnects with its last seq gets exactly the missing events
        assert_eq!(log.last_seq("a1").unwrap(), a1.last().map(|e| e.seq));
        assert_eq!(log.last_seq("nope").unwrap(), None);
        let cut = a1[a1.len() / 2].seq;
        let missing: Vec<_> = a1.iter().filter(|e| e.seq > cut).cloned().collect();
        assert_eq!(log.read_from("a1", cut + 1, usize::MAX).unwrap(), missing);
        assert_eq!(log.read_from("a1", cut + 1, 1).unwrap(), missing.iter().take(1).cloned().collect::<Vec<_>>(), "limit applies");
        assert_eq!(log.read_from("a1", a1.last().unwrap().seq + 1, 10).unwrap(), vec![], "nothing newer than the last seq");
        assert_eq!(log.read_from("nope", 1, 10).unwrap(), vec![]);

        // batches are appends in order
        let mut tail = a1[0].clone();
        tail.agent_id = "a3".into();
        let batch: Vec<_> = (1..=3).map(|i| { let mut e = tail.clone(); e.seq = i; e }).collect();
        log.append_batch(&batch).unwrap();
        assert_eq!(log.read("a3").unwrap(), batch);
    }
}
