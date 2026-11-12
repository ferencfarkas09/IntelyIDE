//! The always-list of confirmable stops: "Always allow this for this repository" (`policy::confirm`).
//!
//! * One JSON file in the IDE's own state directory (`<data dir>/stop-allow.json`), never inside a repository. The state directory is a
//!   tier-1 path: an agent's write to it, and its read of it, are hard stops, so an agent cannot create, change or read the list.
//! * One entry names one exact thing in one repository: a canonical path (`SecretFile`, `SecretEdit`) or an exact CLI reason (`CliPrompt`).
//!   `"*"` is never stored (that is the run-wide grant, which ends with the run).
//! * At most [`MAX_ENTRIES`] entries. An entry is removed from the file and from the live runs by [`StopAllow::revoke`].

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use intely_agent_core::policy::confirm::{ConfirmKind, StopGrant, ALL_OF_KIND};
use serde::{Deserialize, Serialize};

/// The most entries the list holds.
pub const MAX_ENTRIES: usize = intely_agent_core::policy::confirm::MAX_ALLOW_ENTRIES;

const FILE: &str = "stop-allow.json";

static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// One remembered "always allow".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowEntry {
    pub id: String,
    /// The folder of the run that holds the thing (the repository the entry belongs to).
    pub repo: String,
    pub kind: ConfirmKind,
    /// A canonical path or an exact CLI reason.
    pub scope: String,
    /// The rule that stopped it, for the Settings list.
    pub rule: String,
    pub added_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddError {
    /// The list holds [`MAX_ENTRIES`] already.
    Full,
    /// A scope that names more than one thing, or no repository.
    Invalid,
    /// The file could not be written; nothing was added.
    Io(String),
}

#[derive(Serialize, Deserialize, Default)]
struct FileForm {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    entries: Vec<AllowEntry>,
}

pub struct StopAllow {
    path: PathBuf,
    entries: Mutex<Vec<AllowEntry>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl StopAllow {
    /// Opens (or starts) the list in `data_dir`. A file that cannot be read or parsed is an empty list: nothing is allowed that was not
    /// readable, and the file is replaced by the next change.
    pub fn open(data_dir: &Path) -> Self {
        let path = data_dir.join(FILE);
        let entries = read_file(&path).unwrap_or_default();
        Self { path, entries: Mutex::new(entries) }
    }

    pub fn list(&self) -> Vec<AllowEntry> {
        lock(&self.entries).clone()
    }

    /// Adds an entry (idempotent for the same repo, kind and scope: the existing entry is returned).
    pub fn add(&self, repo: &str, kind: ConfirmKind, scope: &str, rule: &str, now_ms: u64) -> Result<AllowEntry, AddError> {
        if !valid(repo, scope) {
            return Err(AddError::Invalid);
        }
        let mut list = lock(&self.entries);
        // another IDE window or instance may have changed the file since: start from what is on disk
        if let Some(on_disk) = read_file(&self.path) {
            *list = on_disk;
        }
        if let Some(e) = list.iter().find(|e| e.repo == repo && e.kind == kind && e.scope == scope) {
            return Ok(e.clone());
        }
        if list.len() >= MAX_ENTRIES {
            return Err(AddError::Full);
        }
        // (a unique id: the time and a counter, never reused after a revoke)
        let mut n = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut id = format!("sa-{now_ms:x}-{n:x}");
        while list.iter().any(|e| e.id == id) {
            n = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            id = format!("sa-{now_ms:x}-{n:x}");
        }
        let entry = AllowEntry { id, repo: repo.to_string(), kind, scope: scope.to_string(), rule: rule.to_string(), added_ms: now_ms };
        let mut next = list.clone();
        next.push(entry.clone());
        self.save(&next).map_err(AddError::Io)?;
        *list = next;
        Ok(entry)
    }

    /// Removes one entry. `Ok(None)` = there was none with that id.
    pub fn revoke(&self, id: &str) -> Result<Option<AllowEntry>, String> {
        let mut list = lock(&self.entries);
        if let Some(on_disk) = read_file(&self.path) {
            *list = on_disk;
        }
        let Some(i) = list.iter().position(|e| e.id == id) else { return Ok(None) };
        let mut next = list.clone();
        let gone = next.remove(i);
        self.save(&next)?;
        *list = next;
        Ok(Some(gone))
    }

    /// The grants for a run whose folders are `repos`: the entries of exactly those repositories.
    pub fn grants_for(&self, repos: &[PathBuf]) -> Vec<StopGrant> {
        lock(&self.entries).iter().filter(|e| repos.iter().any(|r| r.to_string_lossy() == e.repo)).map(|e| StopGrant { kind: e.kind, scope: e.scope.clone(), tool_id: None, from_list: true }).collect()
    }

    fn save(&self, entries: &[AllowEntry]) -> Result<(), String> {
        let form = FileForm { version: 1, entries: entries.to_vec() };
        let text = serde_json::to_string_pretty(&form).map_err(|e| e.to_string())?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }
}

/// The entries of the file that count: a hand-edited file may hold a wildcard, an empty scope, a repeated id or too many entries.
fn read_file(path: &Path) -> Option<Vec<AllowEntry>> {
    let mut entries: Vec<AllowEntry> = serde_json::from_str::<FileForm>(&std::fs::read_to_string(path).ok()?).ok()?.entries;
    entries.retain(|e| valid(&e.repo, &e.scope));
    let mut seen = std::collections::HashSet::new();
    entries.retain(|e| seen.insert(e.id.clone()));
    entries.truncate(MAX_ENTRIES);
    Some(entries)
}

fn valid(repo: &str, scope: &str) -> bool {
    !repo.is_empty() && !scope.is_empty() && scope != ALL_OF_KIND && !scope.contains('\0')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_survive_a_restart_and_are_listed_per_repository() {
        let d = tempfile::tempdir().unwrap();
        let s = StopAllow::open(d.path());
        let a = s.add("/r/a", ConfirmKind::SecretFile, "/r/a/.env", "read.never-read", 1).unwrap();
        s.add("/r/b", ConfirmKind::CliPrompt, "Contains brace with quote character", "cli.prompt-denied", 2).unwrap();
        let again = StopAllow::open(d.path());
        assert_eq!(again.list().len(), 2);
        assert_eq!(again.grants_for(&[PathBuf::from("/r/a")]).len(), 1, "another repository's entries do not apply");
        assert_eq!(again.grants_for(&[PathBuf::from("/r/a/sub")]), vec![], "a sub folder is another repository");
        assert_eq!(again.revoke(&a.id).unwrap().map(|e| e.id), Some(a.id.clone()));
        assert_eq!(StopAllow::open(d.path()).list().len(), 1);
        assert_eq!(again.revoke(&a.id).unwrap(), None);
    }

    #[test]
    fn a_wildcard_or_empty_scope_is_never_stored() {
        let d = tempfile::tempdir().unwrap();
        let s = StopAllow::open(d.path());
        assert_eq!(s.add("/r", ConfirmKind::SecretFile, "*", "x", 1), Err(AddError::Invalid));
        assert_eq!(s.add("/r", ConfirmKind::SecretFile, "", "x", 1), Err(AddError::Invalid));
        assert_eq!(s.add("", ConfirmKind::SecretFile, "/r/.env", "x", 1), Err(AddError::Invalid));
        // a hand-edited file with a wildcard entry does not count either
        std::fs::write(d.path().join(FILE), r#"{"version":1,"entries":[{"id":"x","repo":"/r","kind":"secretFile","scope":"*","rule":"x","addedMs":1}]}"#).unwrap();
        assert!(StopAllow::open(d.path()).list().is_empty());
    }

    #[test]
    fn the_list_holds_at_most_one_hundred_entries() {
        let d = tempfile::tempdir().unwrap();
        let s = StopAllow::open(d.path());
        for i in 0..MAX_ENTRIES {
            s.add("/r", ConfirmKind::SecretFile, &format!("/r/k{i}.key"), "read.never-read", i as u64).unwrap();
        }
        assert_eq!(s.add("/r", ConfirmKind::SecretFile, "/r/one-more.key", "read.never-read", 999), Err(AddError::Full));
        assert_eq!(s.list().len(), MAX_ENTRIES);
        // the same entry again is not "one more"
        assert!(s.add("/r", ConfirmKind::SecretFile, "/r/k3.key", "read.never-read", 1000).is_ok());
        // a file with more than the cap is cut on load
        let big: Vec<AllowEntry> = (0..150).map(|i| AllowEntry { id: format!("e{i}"), repo: "/r".into(), kind: ConfirmKind::SecretFile, scope: format!("/r/{i}.key"), rule: "x".into(), added_ms: 0 }).collect();
        std::fs::write(d.path().join(FILE), serde_json::to_string(&FileForm { version: 1, entries: big }).unwrap()).unwrap();
        assert_eq!(StopAllow::open(d.path()).list().len(), MAX_ENTRIES);
    }

    #[test]
    fn ids_are_not_reused_after_a_revoke_and_two_instances_do_not_lose_each_others_entries() {
        let d = tempfile::tempdir().unwrap();
        let a = StopAllow::open(d.path());
        let e1 = a.add("/r", ConfirmKind::SecretFile, "/r/1.key", "x", 5).unwrap();
        let e2 = a.add("/r", ConfirmKind::SecretFile, "/r/2.key", "x", 5).unwrap();
        a.revoke(&e1.id).unwrap();
        let e3 = a.add("/r", ConfirmKind::SecretFile, "/r/3.key", "x", 5).unwrap();
        assert!(e3.id != e1.id && e3.id != e2.id, "{e1:?} {e2:?} {e3:?}");
        // a second instance (another window of the IDE) writes; the first one starts from the file, not from its memory
        let b = StopAllow::open(d.path());
        b.add("/r", ConfirmKind::SecretFile, "/r/4.key", "x", 6).unwrap();
        a.add("/r", ConfirmKind::SecretFile, "/r/5.key", "x", 7).unwrap();
        let scopes: Vec<String> = StopAllow::open(d.path()).list().into_iter().map(|e| e.scope).collect();
        assert_eq!(scopes, ["/r/2.key", "/r/3.key", "/r/4.key", "/r/5.key"]);
    }

    #[test]
    fn a_broken_file_is_an_empty_list() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(FILE), "{not json").unwrap();
        assert!(StopAllow::open(d.path()).list().is_empty());
    }
}
