//! Team, phase T2: sharing runs (docs/team.md). The publisher task that turns the host's events into redacted envelopes for the
//! team, the receiving side's in-memory run list, and the commands of the Team view. A child of `team.rs`, so it sees its state.
//!
//! Zero cost when unused: `tap` is an atomic load unless this install is in a team and at least one project is shared. The task
//! starts on the first event after that and keeps running; it does the git lookups and the redaction off the host's event path.
//! Nothing here answers a permission card, sends a prompt or starts a run: a teammate's data only ever flows into [`RunStore`] and
//! out to the webview as read-only events.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use intely_agent_core::events::types::AgentEvent;
use intely_team::project::{project_key, project_name};
use intely_team::share::{forgettable_opt_outs, Change, Dest, Out, Project, Publisher, ShareMsg, ShareSettings};

use super::*;

const FLUSH_EVERY: Duration = Duration::from_millis(250);
/// Messages per flush: the relay allows 300 frames per 10 s per socket, this stays at 24 a second.
const PER_FLUSH: usize = 6;
/// Opt-outs are only forgotten after this long, and only for runs that are finished or unknown to the host (a finished run can be resumed).
const MAX_UNSHARED: usize = 500;

pub(super) enum Cmd {
    Events(Vec<AgentEvent>),
    /// A member came online or asked: send it what is shared.
    Snapshot(String),
    /// The settings changed: withdraw what is no longer allowed.
    Recheck,
    Reset,
}

#[derive(Default)]
pub struct Share {
    team: AtomicBool,
    any: AtomicBool,
    tx: Mutex<Option<mpsc::UnboundedSender<Cmd>>>,
}

impl Share {
    pub(super) fn set_team(&self, on: bool) {
        self.team.store(on, Ordering::Relaxed);
    }

    pub(super) fn send(&self, c: Cmd) {
        if let Some(tx) = lock(&self.tx).as_ref() {
            let _ = tx.send(c);
        }
    }
}

/// Called from `team::setup`: reads whether anything is shared and follows the `team` settings from then on.
pub(super) fn init(share: &Arc<Share>, settings: Option<&Arc<SettingsStore>>) {
    let Some(settings) = settings else { return };
    let any = |m: &serde_json::Map<String, Value>| !ShareSettings::from_map(m).projects.is_empty();
    share.any.store(settings.get(NS).map(|m| any(&m)).unwrap_or(false), Ordering::Relaxed);
    let share = share.clone();
    settings.subscribe(move |c| {
        if c.ns == NS {
            share.any.store(any(&c.value), Ordering::Relaxed);
            share.send(Cmd::Recheck);
        }
    });
}

/// The one-line hook of `agents.rs` (`TauriHostSink::events`).
pub fn tap(app: &AppHandle, events: &[AgentEvent]) {
    super::collab::on_events(app, events);
    let Some(st) = app.try_state::<TeamModState>() else { return };
    let sh = &st.share;
    if !sh.team.load(Ordering::Relaxed) || !sh.any.load(Ordering::Relaxed) {
        return;
    }
    let mut tx = lock(&sh.tx);
    if tx.is_none() {
        let (t, rx) = mpsc::unbounded_channel();
        tauri::async_runtime::spawn(run(app.clone(), rx));
        *tx = Some(t);
    }
    if let Some(t) = tx.as_ref() {
        let _ = t.send(Cmd::Events(events.to_vec()));
    }
}

pub(super) fn read_settings(app: &AppHandle) -> ShareSettings {
    let st = app.state::<TeamModState>();
    st.settings.as_ref().and_then(|s| s.get(NS).ok()).map(|m| ShareSettings::from_map(&m)).unwrap_or_default()
}

/// The project of a repository folder: `None` without an `origin` (such a project cannot be shared).
pub(super) fn project_at(git: &std::path::Path, dir: &std::path::Path) -> Option<Project> {
    let out = intely_core::exec::hardened_git(git).arg("-C").arg(dir).args(["config", "--get", "remote.origin.url"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Some(Project::single(&project_key(&url)?, &project_name(&url)?))
}

pub(super) fn git_of(app: &AppHandle) -> std::path::PathBuf {
    app.try_state::<crate::agents::AgentSlot>().map(|a| a.git().to_path_buf()).unwrap_or_else(|| "git".into())
}

/// Blocking: the project of a run. `Err(())` = the host does not know the run (yet); `Ok(None)` = the run cannot be shared: it runs on
/// a server, or ANY of its repositories has no origin. The keys of all repositories are kept, and the run is shared only if all are.
pub(super) fn resolve_run(app: &AppHandle, run_id: &str) -> Result<Option<Project>, ()> {
    let slot = app.try_state::<crate::agents::AgentSlot>().ok_or(())?;
    let meta = slot.host().metas().into_iter().find(|m| m.agent_id == run_id).ok_or(())?;
    if meta.location.is_some() {
        return Ok(None);
    }
    let git = git_of(app);
    let mut all = Vec::new();
    for r in &meta.repos {
        match project_at(&git, &r.path) {
            Some(p) => all.push(p),
            None => return Ok(None),
        }
    }
    let Some(first) = all.first() else { return Ok(None) };
    Ok(Some(Project { key: first.key.clone(), name: first.name.clone(), keys: all.iter().map(|p| p.key.clone()).collect() }))
}

async fn resolve(app: &AppHandle, run_id: &str) -> Result<Option<Project>, ()> {
    let (a, id) = (app.clone(), run_id.to_string());
    tauri::async_runtime::spawn_blocking(move || resolve_run(&a, &id)).await.unwrap_or(Err(()))
}

/// Stores or removes a run's opt-out (`unsharedRuns`: run id -> when it was set). When the list is long, entries are forgotten only if
/// they are old AND the run is finished or no longer known to the host, so a live run (or one that may be resumed soon) never starts sharing.
fn write_unshared(app: &AppHandle, run_id: &str, unshared: bool) {
    let st = app.state::<TeamModState>();
    let Some(settings) = st.settings.as_ref() else { return };
    let mut map = settings.get(NS).ok().and_then(|m| m.get("unsharedRuns").and_then(Value::as_object).cloned()).unwrap_or_default();
    if unshared {
        map.insert(run_id.to_string(), Value::from(now_ms()));
        if map.len() > MAX_UNSHARED {
            let busy: HashSet<String> = app
                .try_state::<crate::agents::AgentSlot>()
                .map(|a| a.host().list().into_iter().filter(|r| matches!(r.status, intely_agent_core::api::RunStatus::Running | intely_agent_core::api::RunStatus::NeedsYou)).map(|r| r.agent_id).collect())
                .unwrap_or_default();
            for id in forgettable_opt_outs(&map, &busy, run_id, now_ms(), MAX_UNSHARED) {
                map.remove(&id);
            }
        }
    } else {
        map.remove(run_id);
    }
    let mut patch = serde_json::Map::new();
    patch.insert("unsharedRuns".into(), Value::Object(map));
    let _ = settings.set(NS, patch);
}

/// A run started with "share" off in the New run panel: recorded under its id before its first event (`StartOptions::on_created`).
pub(crate) fn opt_out(app: &AppHandle, run_id: &str) {
    write_unshared(app, run_id, true);
}

async fn run(app: AppHandle, mut rx: mpsc::UnboundedReceiver<Cmd>) {
    let mut publisher = Publisher::new();
    let mut by_run: HashMap<String, Option<Project>> = HashMap::new();
    let mut misses: HashMap<String, Instant> = HashMap::new();
    let mut tick = tokio::time::interval(FLUSH_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { break };
                match cmd {
                    Cmd::Events(events) => {
                        let s = read_settings(&app);
                        for e in events {
                            if !by_run.contains_key(&e.agent_id) && !misses.get(&e.agent_id).is_some_and(|t| t.elapsed() < Duration::from_secs(3)) {
                                match resolve(&app, &e.agent_id).await {
                                    Ok(p) => {
                                        by_run.insert(e.agent_id.clone(), p);
                                    }
                                    Err(()) => {
                                        misses.insert(e.agent_id.clone(), Instant::now());
                                    }
                                }
                            }
                            let project = by_run.get(&e.agent_id).and_then(Option::as_ref);
                            publisher.on_event(&e, project, &s);
                        }
                        if by_run.len() > 5000 {
                            by_run.clear();
                        }
                        misses.retain(|_, t| t.elapsed() < Duration::from_secs(60));
                    }
                    Cmd::Snapshot(to) => publisher.snapshot_for(&to, now_ms()),
                    Cmd::Recheck => publisher.retain(&read_settings(&app)),
                    Cmd::Reset => publisher.clear(),
                }
            }
            _ = tick.tick() => {
                if publisher.is_idle() {
                    continue;
                }
                publisher.retain(&read_settings(&app));
                let outs = publisher.tick(PER_FLUSH);
                if !outs.is_empty() {
                    send_outs(&app, outs);
                }
            }
        }
    }
}

fn send_outs(app: &AppHandle, outs: Vec<Out>) {
    let state = st(app);
    let Ok((secrets, _)) = parts(&state) else { return };
    let mut inner = lock(&state.inner);
    let inner = &mut *inner;
    for o in outs {
        send_share(inner, &o.dest, &o.msg);
    }
    save(inner, &secrets);
}

/// Seals one message and hands it to the relay. Live only (never queued): what a member missed while offline comes with its next snapshot.
pub(super) fn send_share(inner: &mut Inner, dest: &Dest, msg: &ShareMsg) -> bool {
    let (Some(team), Some(me)) = (inner.team.as_mut(), inner.identity.as_ref()) else { return false };
    if matches!(dest, Dest::All) && !inner.online.iter().any(|(id, (on, _))| *on && *id != team.me) {
        return false;
    }
    let Ok(env) = team.seal(me, &msg.encode()) else { return false };
    let p = env.encode();
    let frame = match dest {
        Dest::All => out::fanout(&p, false),
        Dest::One(to) => out::direct(to, &p, false, "sh"),
    };
    send(inner, frame)
}

// ---------------------------------------------------------------- receiving

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunRow {
    member_id: String,
    member_name: String,
    online: bool,
    run_id: String,
    project_key: String,
    project_name: String,
    title: String,
    state: String,
    provider: String,
    model: String,
    started_at: u64,
    updated_at: u64,
}

fn runs_view(inner: &Inner) -> Vec<TeamRunRow> {
    let Some(team) = inner.team.as_ref() else { return Vec::new() };
    inner
        .store
        .cards()
        .into_iter()
        .filter(|(m, _)| *m != team.me)
        .filter_map(|(m, c)| {
            let member = team.body().member(&m)?;
            let online = inner.online.get(&m).is_some_and(|o| o.0);
            Some(TeamRunRow { member_id: m, member_name: member.name.clone(), online, run_id: c.run_id, project_key: c.project_key, project_name: c.project_name, title: c.title, state: c.state, provider: c.provider, model: c.model, started_at: c.started_at, updated_at: c.updated_at })
        })
        .collect()
}

/// A verified message of a member (the envelope's signature named `sender`). Read-only: it only fills the store.
pub(super) fn share_in(inner: &mut Inner, sender: &str, msg: ShareMsg) {
    if inner.team.as_ref().is_none_or(|t| t.me == sender) {
        return;
    }
    if msg == ShareMsg::Request {
        inner.share.send(Cmd::Snapshot(sender.to_string()));
        return;
    }
    match inner.store.apply(sender, msg) {
        Change::None => {}
        Change::Runs => inner.ui.push(("team:runs", serde_json::to_value(runs_view(inner)).unwrap_or_default())),
        Change::Events { run_id, events } => inner.ui.push(("team:run-events", serde_json::json!({ "memberId": sender, "runId": run_id, "events": events }))),
    }
}

/// A member left, was removed or the team was forgotten: what they shared is gone.
pub(super) fn member_gone(inner: &mut Inner, id: &str) {
    super::collab::member_gone(inner, id);
    if inner.store.drop_member(id) {
        inner.ui.push(("team:runs", serde_json::to_value(runs_view(inner)).unwrap_or_default()));
    }
}

pub(super) fn forget_all(inner: &mut Inner) {
    inner.store.clear();
    super::collab::forget_all(inner);
    inner.ui.clear();
    inner.share.send(Cmd::Reset);
    inner.share.set_team(false);
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn team_runs(state: State<'_, TeamModState>) -> Res<Vec<TeamRunRow>> {
    Ok(runs_view(&lock(&state.inner)))
}

#[tauri::command]
pub fn team_run_events(state: State<'_, TeamModState>, member_id: String, run_id: String) -> Res<Vec<Value>> {
    Ok(lock(&state.inner).store.events(&member_id, &run_id))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRow {
    repo_id: String,
    name: String,
    /// `None` = the folder has no `git remote origin`, so it cannot be shared.
    key: Option<String>,
    shared: bool,
    /// Teammates may ask for a snapshot of its changes (`workspaceProjects`).
    workspace: bool,
    /// Memory files and CLAUDE.md are synced with the team (`memoryProjects`, beta).
    memory: bool,
    /// The repository's `CLAUDE.md` is shared too (`claudeMdProjects`, its own switch, off by default).
    claude_md: bool,
}

/// The open projects (repositories of the workspace) with their keys and whether they are shared.
#[tauri::command]
pub async fn team_projects(app: AppHandle, engine: State<'_, crate::commands::EngineSlot>, state: State<'_, TeamModState>) -> Res<Vec<ProjectRow>> {
    let repos = crate::agents::repos(&engine).await?;
    let settings = state.settings.as_ref().and_then(|s| s.get(NS).ok()).map(|m| ShareSettings::from_map(&m)).unwrap_or_default();
    let collab = state.settings.as_ref().and_then(|s| s.get(NS).ok()).map(|m| intely_team::collab::CollabSettings::from_map(&m)).unwrap_or_default();
    let git = git_of(&app);
    let settings_store = state.settings.clone();
    crate::agents::blocking(move || {
        Ok(repos
            .into_iter()
            .map(|r| {
                let project = project_at(&git, &r.path);
                let name = r.path.file_name().map_or_else(|| r.id.clone(), |n| n.to_string_lossy().into_owned());
                let shared = project.as_ref().is_some_and(|p| settings.projects.contains(&p.key));
                let workspace = project.as_ref().is_some_and(|p| collab.workspace_projects.contains(&p.key));
                let memory = project.as_ref().is_some_and(|p| settings_store.as_ref().is_some_and(|s| super::memsync::is_enabled(s, &p.key)));
                let claude_md = project.as_ref().is_some_and(|p| settings_store.as_ref().is_some_and(|s| super::memsync::claude_md_enabled(s, &p.key)));
                ProjectRow { repo_id: r.id, name, key: project.map(|p| p.key), shared, workspace, memory, claude_md }
            })
            .collect())
    })
    .await
}

pub(super) fn is_key(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

#[tauri::command]
pub fn team_set_share(state: State<'_, TeamModState>, project_key: String, shared: bool) -> Res<()> {
    if !is_key(&project_key) {
        return Err(err("invalid", "not a project key"));
    }
    let settings = state.settings.as_ref().ok_or_else(|| err("unavailable", "Settings are unavailable"))?;
    let mut map = settings.get(NS).ok().and_then(|m| m.get("shareProjects").and_then(Value::as_object).cloned()).unwrap_or_default();
    if shared {
        map.insert(project_key, Value::Bool(true));
    } else {
        map.remove(&project_key);
    }
    let mut patch = serde_json::Map::new();
    patch.insert("shareProjects".into(), Value::Object(map));
    settings.set(NS, patch).map_err(|e| err("settings", e.to_string()))?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunShareState {
    /// The run's project is shared, so the toggle means something.
    available: bool,
    shared: bool,
}

/// For the run header: can this run be shared at all, and is it?
#[tauri::command]
pub async fn team_run_share_state(app: AppHandle, state: State<'_, TeamModState>, run_id: String) -> Res<RunShareState> {
    let s = read_settings(&app);
    let in_team = state.share.team.load(Ordering::Relaxed);
    let project = if in_team { resolve(&app, &run_id).await.ok().flatten() } else { None };
    let available = project.as_ref().is_some_and(|p| s.allows(&p.keys, "") );
    Ok(RunShareState { available, shared: available && !s.unshared_runs.contains(&run_id) })
}

/// The run header's toggle: off withdraws the run from the team at once; on shares what happens from now on.
#[tauri::command]
pub fn team_run_share(app: AppHandle, run_id: String, shared: bool) -> Res<()> {
    if run_id.is_empty() || run_id.len() > 80 {
        return Err(err("invalid", "not a run id"));
    }
    write_unshared(&app, &run_id, !shared);
    Ok(())
}
