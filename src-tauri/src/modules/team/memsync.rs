//! Team, shared Claude memory (beta; docs/team.md). The Tauri side of `intely_team::memsync`: a background task that, for each project the
//! person opted in (`team.memoryProjects: {<projectKey>: true}`), pushes changed memory files and `CLAUDE.md` and pulls the team's.
//!
//! Zero cost when unused: while no project is opted in, or this install is not in a connected team, the task only wakes every 5 s to
//! read one setting. Local changes are noticed by a stat fingerprint every 5 s; the relay is asked every 60 s, on a `blob.changed`
//! push and after (re)connecting. The relay link is the one `team.rs` owns: requests carry an `mem:<n>` op and `on_reply` hands the
//! answer back through [`deliver`]. Only the app writes these files; an agent has no path to any of this.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use intely_remote::util::{b64u, b64u_decode};
use intely_team::memsync::{self, Blob, Ctx, Head, MemState, PutOutcome, Remote, Roots};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use super::*;

const LOCAL_POLL: Duration = Duration::from_secs(5);
const REMOTE_POLL: Duration = Duration::from_secs(60);
const REPLY_WAIT: Duration = Duration::from_secs(20);
const STATE_FILE: &str = "team-memory.json";

#[derive(Default)]
struct Hub {
    replies: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    poke: tokio::sync::Notify,
    seq: AtomicU64,
    /// Held for a whole round and for a resolve, so the two never interleave.
    state: tokio::sync::Mutex<Option<(String, MemState)>>,
    roots: Mutex<Vec<(Roots, String)>>,
    snap: Mutex<Snapshot>,
}

static HUB: OnceLock<Arc<Hub>> = OnceLock::new();

fn hub() -> Arc<Hub> {
    HUB.get_or_init(Default::default).clone()
}

/// Wakes the task (a `blob.changed` push, a reconnect, a settings change, "Sync now").
pub(super) fn poke() {
    if let Some(h) = HUB.get() {
        h.poke.notify_one();
    }
}

/// Called from `on_reply`: `true` if the answer was for a request of this module.
pub(super) fn deliver(v: &Value) -> bool {
    let Some(op) = v["op"].as_str().filter(|o| o.starts_with("mem:")) else { return false };
    if let Some(tx) = HUB.get().and_then(|h| lock(&h.replies).remove(op)) {
        let _ = tx.send(v.clone());
    }
    true
}

// ---------------------------------------------------------------- views

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileRow {
    path: String,
    version: u64,
    author: String,
    ts: u64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConflictRow {
    path: String,
    file: String,
    /// The teammate whose text is now the file.
    theirs: String,
    ts: u64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PendingRow {
    path: String,
    author: String,
    ts: u64,
    /// The teammate deleted the file.
    deleted: bool,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMem {
    key: String,
    name: String,
    /// `CLAUDE.md` is shared for this project (its own switch).
    claude_md: bool,
    /// Teammates' `CLAUDE.md` versions that wait for "Apply" or "Ignore".
    pending: Vec<PendingRow>,
    files: Vec<FileRow>,
    conflicts: Vec<ConflictRow>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    projects: Vec<ProjectMem>,
    last_sync: u64,
    error: Option<String>,
    rejected: u32,
    skipped: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatus {
    /// At least one project is opted in.
    enabled: bool,
    connected: bool,
    syncing: bool,
    #[serde(flatten)]
    snap: Snapshot,
}

fn enabled_projects(app: &AppHandle) -> Vec<String> {
    flagged(app, "memoryProjects")
}

fn flagged(app: &AppHandle, field: &str) -> Vec<String> {
    let st = st(app);
    let map = st.settings.as_ref().and_then(|s| s.get(NS).ok()).and_then(|m| m.get(field).and_then(Value::as_object).cloned()).unwrap_or_default();
    let mut v: Vec<String> = map.into_iter().filter(|(k, on)| *on == Value::Bool(true) && share::is_key(k)).map(|(k, _)| k).collect();
    v.sort();
    v
}

pub(super) fn is_enabled(settings: &SettingsStore, key: &str) -> bool {
    is_flagged(settings, "memoryProjects", key)
}

pub(super) fn claude_md_enabled(settings: &SettingsStore, key: &str) -> bool {
    is_flagged(settings, "claudeMdProjects", key)
}

fn is_flagged(settings: &SettingsStore, field: &str, key: &str) -> bool {
    settings.get(NS).ok().and_then(|m| m.get(field).and_then(|p| p.get(key).cloned())) == Some(Value::Bool(true))
}

// ---------------------------------------------------------------- relay seam

struct Link {
    app: AppHandle,
    hub: Arc<Hub>,
}

impl Link {
    async fn call(&self, frame: impl FnOnce() -> Value) -> intely_team::Result<Value> {
        let op = format!("mem:{}", self.hub.seq.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        lock(&self.hub.replies).insert(op.clone(), tx);
        let tx_link = lock(&st(&self.app).inner).tx.clone();
        if !tx_link.is_some_and(|t| t.try_send(out::with_op(frame(), &op)).is_ok()) {
            lock(&self.hub.replies).remove(&op);
            return Err(TeamError::Transport("offline".into()));
        }
        match tokio::time::timeout(REPLY_WAIT, rx).await {
            Ok(Ok(v)) => Ok(v),
            _ => {
                lock(&self.hub.replies).remove(&op);
                Err(TeamError::Transport("timeout".into()))
            }
        }
    }
}

fn failed(v: &Value) -> TeamError {
    TeamError::Transport(format!("relay: {}", v["code"].as_str().unwrap_or("error")))
}

impl Remote for Link {
    async fn list(&mut self) -> intely_team::Result<Vec<Head>> {
        let v = self.call(out::blob_list).await?;
        if v["t"] != "blobs" {
            return Err(failed(&v));
        }
        Ok(v["items"]
            .as_array()
            .map(|a| a.iter().filter_map(|i| Some(Head { key: i["key"].as_str()?.into(), version: i["version"].as_u64()?, author: i["author"].as_str()?.into(), ts: i["ts"].as_u64().unwrap_or(0) })).collect())
            .unwrap_or_default())
    }

    async fn get(&mut self, key: &str) -> intely_team::Result<Option<Blob>> {
        let v = self.call(|| out::blob_get(key)).await?;
        if v["code"] == "notFound" {
            return Ok(None);
        }
        let parsed = (v["t"] == "blob").then(|| Some(Blob { version: v["version"].as_u64()?, author: v["author"].as_str()?.into(), data: b64u_decode(v["p"].as_str()?)? })).flatten();
        parsed.map(Some).ok_or_else(|| failed(&v))
    }

    async fn put(&mut self, key: &str, base_version: u64, data: &[u8]) -> intely_team::Result<PutOutcome> {
        let v = self.call(|| out::blob_put(key, base_version, &b64u(data))).await?;
        match (v["t"].as_str(), v["code"].as_str()) {
            (Some("ok"), _) => Ok(PutOutcome::Ok(v["version"].as_u64().unwrap_or(base_version + 1))),
            (_, Some("conflict")) => Ok(PutOutcome::Conflict),
            (_, Some("teamFull")) => Ok(PutOutcome::Full),
            _ => Err(failed(&v)),
        }
    }
}

// ---------------------------------------------------------------- the task

/// `~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects`.
fn claude_projects_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::Path::new(&h).join(".claude")))
        .unwrap_or_else(|| PathBuf::from(".claude"))
        .join("projects")
}

/// Called once from `team::setup`.
pub(super) fn start(app: &AppHandle) {
    let (app, hub) = (app.clone(), hub());
    tauri::async_runtime::spawn(async move {
        let (mut last_full, mut fp) = (None::<Instant>, String::new());
        loop {
            let woken = tokio::time::timeout(LOCAL_POLL, hub.poke.notified()).await.is_ok();
            if enabled_projects(&app).is_empty() || !lock(&st(&app).inner).connected {
                last_full = None;
                continue;
            }
            let roots: Vec<Roots> = lock(&hub.roots).iter().map(|r| r.0.clone()).collect();
            let now_fp = if roots.is_empty() { String::new() } else { crate::agents::blocking(move || Ok(fingerprint(&roots))).await.unwrap_or_default() };
            let due = last_full.is_none_or(|t| t.elapsed() >= REMOTE_POLL);
            if woken || due || now_fp != fp {
                round(&app, &hub).await;
                let roots: Vec<Roots> = lock(&hub.roots).iter().map(|r| r.0.clone()).collect();
                fp = crate::agents::blocking(move || Ok(fingerprint(&roots))).await.unwrap_or_default();
                last_full = Some(Instant::now());
            }
        }
    });
}

/// Name, size and mtime of every candidate file: cheap enough to run every 5 s.
fn fingerprint(roots: &[Roots]) -> String {
    let mut s = String::new();
    for r in roots {
        let mut files = vec![r.repo.join("CLAUDE.md")];
        if let Ok(rd) = std::fs::read_dir(&r.memory_dir) {
            files.extend(rd.flatten().take(2000).map(|e| e.path()));
        }
        for f in files {
            if let Ok(m) = std::fs::symlink_metadata(&f) {
                let t = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
                s.push_str(&format!("{}|{}|{t};", f.display(), m.len()));
            }
        }
    }
    s
}

/// The enabled projects that are open in the workspace, with where their files live here.
async fn find_roots(app: &AppHandle, enabled: &[String], claude: &[String]) -> Vec<(Roots, String)> {
    let Some(engine) = app.try_state::<crate::commands::EngineSlot>() else { return vec![] };
    let Ok(repos) = crate::agents::repos(&engine).await else { return vec![] };
    let (git, enabled, claude, base) = (share::git_of(app), enabled.to_vec(), claude.to_vec(), claude_projects_dir());
    crate::agents::blocking(move || {
        let mut out: Vec<(Roots, String)> = vec![];
        for r in repos {
            let Some(p) = share::project_at(&git, &r.path) else { continue };
            if !enabled.contains(&p.key) || out.iter().any(|(x, _)| x.project == p.key) {
                continue;
            }
            let name = r.path.file_name().map_or_else(|| p.name.clone(), |n| n.to_string_lossy().into_owned());
            let memory_dir = base.join(memsync::encode_project_dir(&r.path)).join("memory");
            let claude_md = claude.contains(&p.key);
            out.push((Roots { project: p.key, repo: r.path, memory_dir, claude_md }, name));
        }
        Ok(out)
    })
    .await
    .unwrap_or_default()
}

fn load(dir: &std::path::Path, team_id: &str) -> MemState {
    let saved: Option<(String, MemState)> = std::fs::read_to_string(dir.join(STATE_FILE)).ok().and_then(|s| serde_json::from_str(&s).ok());
    saved.filter(|(t, _)| t == team_id).map(|(_, s)| s).unwrap_or_default()
}

fn store(dir: &std::path::Path, team_id: &str, s: &MemState) {
    if let Ok(json) = serde_json::to_string(&(team_id, s)) {
        let tmp = dir.join(format!("{STATE_FILE}.tmp"));
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, dir.join(STATE_FILE));
        }
    }
}

fn snapshot(state: &MemState, roots: &[(Roots, String)], names: &dyn Fn(&str) -> String, error: Option<String>, rejected: u32, skipped: u32) -> Snapshot {
    let projects = roots
        .iter()
        .map(|(r, name)| ProjectMem {
            key: r.project.clone(),
            name: name.clone(),
            claude_md: r.claude_md,
            pending: state.pending.iter().filter(|p| p.project == r.project).map(|p| PendingRow { path: p.path.clone(), author: names(&p.author), ts: p.ts, deleted: p.text.is_none() }).collect(),
            files: state.files.values().filter(|f| f.project == r.project && !f.deleted).map(|f| FileRow { path: f.path.clone(), version: f.version, author: names(&f.author), ts: f.ts }).collect(),
            conflicts: state.conflicts.iter().filter(|c| c.project == r.project).map(|c| ConflictRow { path: c.path.clone(), file: c.file.clone(), theirs: names(&c.theirs_author), ts: c.ts }).collect(),
        })
        .collect();
    Snapshot { projects, last_sync: state.last_sync, error, rejected, skipped }
}

async fn round(app: &AppHandle, hub: &Arc<Hub>) {
    let enabled = enabled_projects(app);
    let found = find_roots(app, &enabled, &flagged(app, "claudeMdProjects")).await;
    *lock(&hub.roots) = found.clone();
    let (team, me, dir) = {
        let s = st(app);
        let inner = lock(&s.inner);
        (inner.team.clone(), inner.identity.clone(), inner.state_dir.clone())
    };
    let (Some(team), Some(me), Some(dir)) = (team, me, dir) else { return };
    let mut guard = hub.state.lock().await;
    if guard.as_ref().is_none_or(|(t, _)| *t != team.team_id) {
        *guard = Some((team.team_id.clone(), load(&dir, &team.team_id)));
    }
    let Some((_, state)) = guard.as_mut() else { return };
    let roots: Vec<Roots> = found.iter().map(|r| r.0.clone()).collect();
    let names = |id: &str| team.body().member(id).map_or_else(|| "?".to_string(), |m| m.name.clone());
    if roots.is_empty() {
        *lock(&hub.snap) = snapshot(state, &found, &names, None, 0, 0);
        let _ = app.emit("team:memory", ());
        return;
    }
    let cx = Ctx { team_id: &team.team_id, keys: team.keys(), me: &me, roster: team.body() };
    let mut link = Link { app: app.clone(), hub: hub.clone() };
    let result = memsync::sync(&mut link, &cx, &roots, state, now_ms()).await;
    let (error, rejected, skipped) = match result {
        Ok(rep) => {
            if !rep.applied.is_empty() || !rep.pending_new.is_empty() || rep.rejected > 0 {
                let s = st(app);
                let mut inner = lock(&s.inner);
                for a in rep.applied.iter().chain(&rep.pending_new) {
                    audit(&mut inner, event::MEMORY_WRITE, Some(&a.author), Some(&format!("{} {}", a.kind, a.path)));
                }
                if rep.rejected > 0 {
                    audit(&mut inner, event::REJECTED, None, Some(&format!("memory payloads {}", rep.rejected)));
                }
            }
            for a in &rep.pending_new {
                let name = found.iter().find(|r| r.0.project == a.project).map(|r| r.1.clone()).unwrap_or_default();
                let _ = app.emit("team:memory-pending", serde_json::json!({ "project": a.project, "projectName": name, "path": a.path, "author": names(&a.author) }));
            }
            (None, rep.rejected, rep.skipped)
        }
        Err(e) => (Some(team_err(e).message), 0, 0),
    };
    store(&dir, &team.team_id, state);
    *lock(&hub.snap) = snapshot(state, &found, &names, error, rejected, skipped);
    drop(guard);
    let _ = app.emit("team:memory", ());
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn team_memory_status(app: AppHandle) -> Res<MemoryStatus> {
    let h = hub();
    let snap = lock(&h.snap).clone();
    let connected = lock(&st(&app).inner).connected;
    let syncing = h.state.try_lock().is_err();
    Ok(MemoryStatus { enabled: !enabled_projects(&app).is_empty(), connected, syncing, snap })
}

/// "Sync now": a round as soon as the task wakes.
#[tauri::command]
pub fn team_memory_sync_now() -> Res<()> {
    poke();
    Ok(())
}

/// `choice`: `mine` (put the conflict copy back as the file; it goes out on the next round) or `theirs` (drop the copy).
#[tauri::command]
pub async fn team_memory_resolve(app: AppHandle, project: String, path: String, choice: String) -> Res<()> {
    let mine = match choice.as_str() {
        "mine" => true,
        "theirs" => false,
        _ => return Err(err("invalid", "choice must be mine or theirs")),
    };
    let h = hub();
    let root = lock(&h.roots).iter().find(|r| r.0.project == project).map(|r| r.0.clone()).ok_or_else(|| err("memory", "this project is not shared on this machine"))?;
    let mut guard = h.state.lock().await;
    let (_, state) = guard.as_mut().ok_or_else(|| err("memory", "nothing is synced yet"))?;
    memsync::resolve(&root, state, &path, mine).map_err(team_err)?;
    let dir = lock(&st(&app).inner).state_dir.clone();
    let team = lock(&st(&app).inner).team.clone();
    if let (Some(dir), Some(team)) = (dir, team) {
        store(&dir, &team.team_id, state);
        let names = |id: &str| team.body().member(id).map_or_else(|| "?".to_string(), |m| m.name.clone());
        let found = lock(&h.roots).clone();
        let prev = lock(&h.snap).clone();
        *lock(&h.snap) = snapshot(state, &found, &names, prev.error, prev.rejected, prev.skipped);
    }
    drop(guard);
    let _ = app.emit("team:memory", ());
    if mine {
        poke();
    }
    Ok(())
}

/// The per-project opt-in (default off).
#[tauri::command]
pub fn team_set_memory(state: State<'_, TeamModState>, project_key: String, enabled: bool) -> Res<()> {
    set_flag(&state, "memoryProjects", project_key, enabled)
}

fn set_flag(state: &TeamModState, field: &str, project_key: String, enabled: bool) -> Res<()> {
    if !share::is_key(&project_key) {
        return Err(err("invalid", "not a project key"));
    }
    let settings = state.settings.as_ref().ok_or_else(|| err("unavailable", "Settings are unavailable"))?;
    let mut map = settings.get(NS).ok().and_then(|m| m.get(field).and_then(Value::as_object).cloned()).unwrap_or_default();
    if enabled {
        map.insert(project_key, Value::Bool(true));
    } else {
        map.remove(&project_key);
    }
    let mut patch = serde_json::Map::new();
    patch.insert(field.into(), Value::Object(map));
    settings.set(NS, patch).map_err(|e| err("settings", e.to_string()))?;
    poke();
    Ok(())
}

// ---------------------------------------------------------------- CLAUDE.md (its own switch, and a teammate's change waits)

/// What a person sees under "View diff": this machine's `CLAUDE.md` and the teammate's held version.
#[derive(Serialize)]
pub struct PendingDiff {
    current: String,
    incoming: String,
}

fn root_of(h: &Hub, project: &str) -> Res<Roots> {
    lock(&h.roots).iter().find(|r| r.0.project == project).map(|r| r.0.clone()).ok_or_else(|| err("memory", "this project is not shared on this machine"))
}

#[tauri::command]
pub async fn team_memory_pending_diff(project: String, path: String) -> Res<PendingDiff> {
    let h = hub();
    let root = root_of(&h, &project)?;
    let guard = h.state.lock().await;
    let (_, state) = guard.as_ref().ok_or_else(|| err("memory", "nothing is synced yet"))?;
    let (current, incoming) = memsync::pending_texts(&root, state, &path).map_err(team_err)?;
    Ok(PendingDiff { current, incoming })
}

/// `choice`: `apply` writes the teammate's `CLAUDE.md` (your unsaved-to-the-team edits go to a conflict copy first) or `ignore`.
#[tauri::command]
pub async fn team_memory_pending_resolve(app: AppHandle, project: String, path: String, choice: String) -> Res<()> {
    let apply = match choice.as_str() {
        "apply" => true,
        "ignore" => false,
        _ => return Err(err("invalid", "choice must be apply or ignore")),
    };
    let h = hub();
    let root = root_of(&h, &project)?;
    let (team, me, dir) = {
        let s = st(&app);
        let inner = lock(&s.inner);
        (inner.team.clone(), inner.identity.clone(), inner.state_dir.clone())
    };
    let (Some(team), Some(me), Some(dir)) = (team, me, dir) else { return Err(err("notInTeam", "create or join a team first")) };
    let mut guard = h.state.lock().await;
    let (_, state) = guard.as_mut().ok_or_else(|| err("memory", "nothing is synced yet"))?;
    if apply {
        let cx = Ctx { team_id: &team.team_id, keys: team.keys(), me: &me, roster: team.body() };
        let done = memsync::apply_pending(&cx, &root, state, &path, now_ms()).map_err(team_err)?;
        let s = st(&app);
        audit(&mut lock(&s.inner), event::MEMORY_WRITE, Some(&done.author), Some(&format!("{} {}", done.kind, done.path)));
    } else {
        memsync::ignore_pending(&root, state, &path).map_err(team_err)?;
    }
    store(&dir, &team.team_id, state);
    let names = |id: &str| team.body().member(id).map_or_else(|| "?".to_string(), |m| m.name.clone());
    let found = lock(&h.roots).clone();
    let prev = lock(&h.snap).clone();
    *lock(&h.snap) = snapshot(state, &found, &names, prev.error, prev.rejected, prev.skipped);
    drop(guard);
    let _ = app.emit("team:memory", ());
    poke();
    Ok(())
}

/// The `CLAUDE.md` switch of a project (default off, separate from the memory switch).
#[tauri::command]
pub fn team_set_claude_md(state: State<'_, TeamModState>, project_key: String, enabled: bool) -> Res<()> {
    set_flag(&state, "claudeMdProjects", project_key, enabled)
}
