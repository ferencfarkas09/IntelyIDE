//! Tauri glue of the agent-UX extras (Wave 4) on top of `intely_runindex`: session search over the run logs, the night
//! queue and the Morning brief. Search and the brief only read (the JSONL logs, the runs' meta files, read-only git).
//! The night queue starts runs through the existing supervisor, one at a time: the process gate, the write lease and
//! the mandatory Rewind snapshot apply exactly as for a run started by hand, and the queue itself never commits or
//! pushes. It is paused on battery and while the IDE is read-only, and a restart never resumes it.
//! `agentux_brief_summarise` is the only model call (a one-shot Haiku session, on a click, over scrubbed facts).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use intely_agent_core::api::AgentStartRequest;
use intely_agent_host::StartOptions;
use intely_core::jail::{Jail, Mode};
use intely_core::EngineError;
use intely_roles::types::RunState;
use intely_runindex::brief::facts_text;
use intely_runindex::index::{Facets, Query, SearchResult};
use intely_runindex::night::{parse_on_battery, Effect, NewItem, NightPlan, Observation, Paused, Phase, RunObs, MAX_RUNS_PER_NIGHT};
use intely_runindex::{build_brief, Brief, GitDiff, Index, UsageIndex, UsageReport};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use super::switchhook;
use crate::agents::{blocking, repos};
use crate::commands::EngineSlot;
use crate::modules::roles::RolesSlot;

type Res<T> = Result<T, EngineError>;

/// The index is re-read from the logs at most this often while the search panel is used.
const STALE: Duration = Duration::from_secs(4);
const TICK: Duration = Duration::from_secs(2);
const BATTERY_TTL: Duration = Duration::from_secs(30);
/// When the night has no run ids yet, the brief covers runs started in the last 14 hours.
const BRIEF_WINDOW_MS: u64 = 14 * 3600 * 1000;

struct IndexSlot {
    index: Option<Index>,
    refreshed: Option<Instant>,
}

/// The workspace an item was queued in and where its repositories were then. The plan itself (a type of
/// `intely-runindex`) has no such field, so the stamp lives in `night-queue-workspaces.json` next to it, keyed by item id.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemStamp {
    pub workspace_id: String,
    pub repo_paths: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Stamps {
    #[serde(default)]
    items: BTreeMap<String, ItemStamp>,
}

/// The workspace an item without a stamp belongs to: the migrated one, never "any".
const UNSTAMPED_OWNER: &str = "w-migrated";

/// May the item start in the open workspace? `active` is `None` when no workspace module exists (nothing is filtered).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fits {
    Yes,
    /// Queued in another workspace: it stays queued.
    OtherWorkspace,
    /// Same workspace, but a repository id now points at another folder than when the item was queued.
    PathsDiffer,
}

pub fn fits(stamp: Option<&ItemStamp>, active: Option<&str>, repo_ids: &[String], now: &BTreeMap<String, String>) -> Fits {
    let Some(active) = active else { return Fits::Yes };
    let owner = stamp.map_or(UNSTAMPED_OWNER, |s| s.workspace_id.as_str());
    if owner != active {
        return Fits::OtherWorkspace;
    }
    let Some(stamp) = stamp.filter(|s| !s.repo_paths.is_empty()) else { return Fits::Yes };
    let same = repo_ids.iter().all(|id| match (stamp.repo_paths.get(id), now.get(id)) {
        (Some(then), Some(now)) => then == now,
        _ => false,
    });
    if same {
        Fits::Yes
    } else {
        Fits::PathsDiffer
    }
}

struct Inner {
    data_dir: PathBuf,
    index: Mutex<IndexSlot>,
    stamps: Mutex<Option<Stamps>>,
    plan: Mutex<Option<NightPlan>>,
    driver: AtomicBool,
    battery: Mutex<Option<(Instant, bool)>>,
    /// What the Usage view has read of the run logs; each log is read again only when it changed.
    usage: Mutex<UsageIndex>,
}

#[derive(Clone)]
pub struct AgentuxState(Arc<Inner>);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn err(code: &str, message: impl Into<String>) -> EngineError {
    EngineError::new(code, message)
}

/// Called once from `setup`. Reads and starts nothing: the index loads on the first search, the plan on the first queue call.
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = std::env::var_os("INTELY_DATA_DIR").map(PathBuf::from).or_else(intely_agent_core::events::log::JsonlEventLog::default_base_dir).unwrap_or_else(|| PathBuf::from("."));
    app.manage(AgentuxState(Arc::new(Inner { data_dir, index: Mutex::new(IndexSlot { index: None, refreshed: None }), stamps: Mutex::new(None), plan: Mutex::new(None), driver: AtomicBool::new(false), battery: Mutex::new(None), usage: Mutex::new(UsageIndex::new()) })));
    Ok(())
}

impl Inner {
    fn runs_dir(&self) -> PathBuf {
        self.data_dir.join("runs")
    }

    fn index_path(&self) -> PathBuf {
        self.data_dir.join("runindex.json")
    }

    fn plan_path(&self) -> PathBuf {
        self.data_dir.join("night-queue.json")
    }

    /// Runs `f` on the index, loading it and re-reading changed logs first when it is stale (or `force`).
    fn with_index<T>(&self, force: bool, f: impl FnOnce(&Index) -> T) -> T {
        let mut slot = lock(&self.index);
        if slot.index.is_none() {
            slot.index = Some(Index::load(&self.index_path()));
            slot.refreshed = None;
        }
        let fresh = slot.refreshed.is_some_and(|t| t.elapsed() < STALE);
        if force || !fresh {
            let stats = slot.index.as_mut().expect("loaded").refresh(&self.runs_dir());
            slot.refreshed = Some(Instant::now());
            if stats.added + stats.updated + stats.removed > 0 {
                let _ = slot.index.as_ref().expect("loaded").save(&self.index_path());
            }
        }
        f(slot.index.as_ref().expect("loaded"))
    }

    fn with_plan<T>(&self, f: impl FnOnce(&mut NightPlan) -> T) -> T {
        let mut slot = lock(&self.plan);
        let plan = slot.get_or_insert_with(|| NightPlan::load(&self.plan_path()));
        let out = f(plan);
        let _ = plan.save(&self.plan_path());
        out
    }

    fn stamps_path(&self) -> PathBuf {
        self.data_dir.join("night-queue-workspaces.json")
    }

    fn with_stamps<T>(&self, f: impl FnOnce(&mut Stamps) -> T) -> T {
        let mut slot = lock(&self.stamps);
        let stamps = slot.get_or_insert_with(|| std::fs::read(self.stamps_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default());
        let out = f(stamps);
        if let Ok(mut json) = serde_json::to_vec_pretty(&*stamps) {
            json.push(b'\n');
            let _ = std::fs::write(self.stamps_path(), json);
        }
        out
    }

    /// Forgets the stamps of items that left the plan.
    fn prune_stamps(&self) {
        let ids: Vec<String> = self.with_plan(|p| p.items.iter().map(|i| i.id.clone()).collect());
        self.with_stamps(|s| s.items.retain(|id, _| ids.contains(id)));
    }

    fn on_battery(&self) -> bool {
        if let Ok(v) = std::env::var("INTELY_FAKE_POWER") {
            return v == "battery";
        }
        let mut cache = lock(&self.battery);
        if let Some((at, v)) = *cache {
            if at.elapsed() < BATTERY_TTL {
                return v;
            }
        }
        let v = Command::new("/usr/bin/pmset").args(["-g", "batt"]).output().map(|o| parse_on_battery(&String::from_utf8_lossy(&o.stdout))).unwrap_or(false);
        *cache = Some((Instant::now(), v));
        v
    }
}

// ---- session search --------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOut {
    #[serde(flatten)]
    result: SearchResult,
    facets: Facets,
    /// Runs in the index.
    indexed: u32,
    took_ms: u32,
}

#[tauri::command]
pub async fn agentux_search(state: State<'_, AgentuxState>, query: Query, reindex: Option<bool>) -> Res<SearchOut> {
    let inner = state.0.clone();
    blocking(move || {
        let started = Instant::now();
        Ok(inner.with_index(reindex.unwrap_or(false), |idx| SearchOut { result: idx.search(&query), facets: idx.facets(), indexed: idx.len() as u32, took_ms: started.elapsed().as_millis() as u32 }))
    })
    .await
}

/// Tokens and API-equivalent cost of the runs the IDE keeps logs of, by local day, hour and weekday, as of now. `tz_offset_min` is the
/// reader's time zone in minutes east of UTC (`-new Date().getTimezoneOffset()`), so days and hours are the reader's own.
#[tauri::command]
pub async fn agentux_usage(state: State<'_, AgentuxState>, tz_offset_min: i32) -> Res<UsageReport> {
    let inner = state.0.clone();
    blocking(move || {
        let mut usage = lock(&inner.usage);
        usage.refresh(&inner.runs_dir());
        Ok(usage.report(tz_offset_min, now_ms()))
    })
    .await
}

// ---- night queue -----------------------------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NightView {
    #[serde(flatten)]
    plan: NightPlan,
    cap: u32,
    paused: Option<Paused>,
    on_battery: bool,
    read_only: bool,
    now_ms: u64,
}

fn read_only() -> bool {
    Jail::global().mode() == Mode::ReadOnly
}

fn view(inner: &Inner) -> NightView {
    let (on_battery, read_only) = (inner.on_battery(), read_only());
    inner.with_plan(|p| {
        let obs = Observation { on_battery, read_only, ..Observation::default() };
        NightView { paused: p.paused(&obs), plan: p.clone(), cap: MAX_RUNS_PER_NIGHT as u32, on_battery, read_only, now_ms: now_ms() }
    })
}

fn emit(app: &AppHandle, inner: &Inner) {
    let _ = app.emit("agentux:night", view(inner));
}

/// What the supervisor says about one run: its phase and the tokens it has used.
fn observe_run(app: &AppHandle, run_id: &str) -> Option<RunObs> {
    let slot = app.try_state::<RolesSlot>()?;
    let sup = slot.supervisor();
    let record = sup.list().into_iter().find(|r| r.agent_id == run_id)?;
    let tokens = sup.usage().runs.iter().find(|u| u.agent_id == run_id).map_or(0.0, |u| u.totals.input_tokens + u.totals.output_tokens) as u64;
    let phase = match record.status {
        RunState::Queued | RunState::Running => Phase::Working,
        RunState::NeedsYou => Phase::NeedsYou,
        RunState::Done => Phase::Finished { ok: true },
        RunState::Error => Phase::Finished { ok: false },
    };
    Some(RunObs { phase, tokens })
}

/// One step of the driver. Returns whether the driver still has work (armed, or a run in progress).
fn tick(app: &AppHandle, inner: &Arc<Inner>) -> bool {
    // A workspace switch is under way: nothing starts and nothing is stopped by the budgets until the new page is up.
    if switchhook::gate_check(app).is_err() {
        return inner.with_plan(|p| p.armed || p.running().is_some());
    }
    let running = inner.with_plan(|p| p.running().and_then(|i| i.run_id.clone()));
    let run = running.as_deref().and_then(|id| observe_run(app, id));
    let armed = inner.with_plan(|p| p.armed);
    let (on_battery, ro) = if armed { (inner.on_battery(), read_only()) } else { (false, read_only()) };
    let obs = Observation { now_ms: now_ms(), on_battery, read_only: ro, run };
    let effects = inner.with_plan(|p| p.tick(&obs));
    for effect in effects {
        match effect {
            Effect::Stop { run_id, .. } => {
                if let Some(slot) = app.try_state::<RolesSlot>() {
                    let _ = slot.supervisor().stop(&run_id);
                }
            }
            Effect::Start { item_id } => start_item(app, inner, &item_id),
        }
    }
    emit(app, inner);
    inner.with_plan(|p| p.armed || p.running().is_some())
}

fn start_item(app: &AppHandle, inner: &Arc<Inner>, item_id: &str) {
    let Some(item) = inner.with_plan(|p| p.items.iter().find(|i| i.id == item_id).cloned()) else { return };
    let (Some(engine), Some(roles)) = (app.try_state::<EngineSlot>(), app.try_state::<RolesSlot>()) else { return };
    let repos = match tauri::async_runtime::block_on(repos(&engine)) {
        Ok(r) => r,
        Err(e) => return inner.with_plan(|p| p.on_start_failed(item_id, &e.code, &e.message, now_ms())),
    };
    // An item queued in another workspace (or whose repositories moved) is not started here; it goes to the back of the
    // line so the items of this workspace are not blocked behind it.
    if switchhook::has_workspaces(app) {
        let now: BTreeMap<String, String> = repos.iter().map(|r| (r.id.clone(), r.path.to_string_lossy().into_owned())).collect();
        let stamp = inner.with_stamps(|s| s.items.get(item_id).cloned());
        let verdict = fits(stamp.as_ref(), switchhook::active_workspace_id(app).as_deref(), &item.repo_ids, &now);
        if verdict != Fits::Yes {
            let why = if verdict == Fits::OtherWorkspace { "otherWorkspace" } else { "pathsDiffer" };
            return inner.with_plan(|p| {
                if let Some(i) = p.items.iter_mut().find(|i| i.id == item_id) {
                    i.waiting = Some(why.into());
                }
                for _ in 0..p.items.len() {
                    if p.move_item(item_id, 1).is_err() {
                        break;
                    }
                }
            });
        }
    }
    let req = AgentStartRequest { role: item.role_id.clone(), repo_ids: item.repo_ids.clone(), prompt: item.prompt.clone(), mode: None, mcp_servers: None };
    // Never `run_without_safety_net`: a repo that cannot be snapshotted fails the item with `noSafetyNet`.
    match roles.supervisor().start_now_with(req, &repos, StartOptions::default()) {
        Ok(summary) => inner.with_plan(|p| p.on_started(item_id, &summary.agent_id, now_ms())),
        Err(e) => inner.with_plan(|p| p.on_start_failed(item_id, &e.code, &e.message, now_ms())),
    }
}

/// Starts the driver thread unless one is alive. It ends when the queue is disarmed and nothing runs.
fn ensure_driver(app: &AppHandle, inner: &Arc<Inner>) {
    if inner.driver.swap(true, Ordering::SeqCst) {
        return;
    }
    let (app, worker) = (app.clone(), inner.clone());
    let spawned = std::thread::Builder::new().name("agentux-night".into()).spawn(move || loop {
        let keep = tick(&app, &worker);
        if !keep {
            worker.driver.store(false, Ordering::SeqCst);
            // Armed again between the decision and the flag: take the driver back.
            if worker.with_plan(|p| p.armed) && !worker.driver.swap(true, Ordering::SeqCst) {
                continue;
            }
            return;
        }
        std::thread::sleep(TICK);
    });
    if spawned.is_err() {
        inner.driver.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn agentux_night_state(state: State<'_, AgentuxState>) -> Res<NightView> {
    let inner = state.0.clone();
    blocking(move || Ok(view(&inner))).await
}

#[tauri::command]
pub async fn agentux_night_add(app: AppHandle, engine: State<'_, EngineSlot>, state: State<'_, AgentuxState>, item: NewItem) -> Res<NightView> {
    let inner = state.0.clone();
    // Where the item's repositories are now; at fire time they must still be there (nothing is stamped without a workspace module).
    let stamp = match switchhook::active_workspace_id(&app) {
        Some(workspace_id) => {
            let all = repos(&engine).await?;
            let repo_paths = item.repo_ids.iter().filter_map(|id| all.iter().find(|r| &r.id == id).map(|r| (id.clone(), r.path.to_string_lossy().into_owned()))).collect();
            Some(ItemStamp { workspace_id, repo_paths })
        }
        None => None,
    };
    blocking(move || {
        let id = inner.with_plan(|p| p.add(item).map(|i| i.id.clone())).map_err(|r| err(r.code, r.message))?;
        if let Some(stamp) = stamp {
            inner.with_stamps(|s| s.items.insert(id, stamp));
        }
        emit(&app, &inner);
        Ok(view(&inner))
    })
    .await
}

#[tauri::command]
pub async fn agentux_night_remove(app: AppHandle, state: State<'_, AgentuxState>, id: String) -> Res<NightView> {
    let inner = state.0.clone();
    blocking(move || {
        inner.with_plan(|p| p.remove(&id)).map_err(|r| err(r.code, r.message))?;
        inner.prune_stamps();
        emit(&app, &inner);
        Ok(view(&inner))
    })
    .await
}

#[tauri::command]
pub async fn agentux_night_move(app: AppHandle, state: State<'_, AgentuxState>, id: String, delta: i32) -> Res<NightView> {
    let inner = state.0.clone();
    blocking(move || {
        inner.with_plan(|p| p.move_item(&id, delta)).map_err(|r| err(r.code, r.message))?;
        emit(&app, &inner);
        Ok(view(&inner))
    })
    .await
}

/// Arms or disarms the queue. Disarming with `cancel_rest` also skips every item still waiting; a run in progress
/// always finishes (or is stopped with `agentux_night_stop`).
#[tauri::command]
pub async fn agentux_night_arm(app: AppHandle, state: State<'_, AgentuxState>, armed: bool, cancel_rest: Option<bool>) -> Res<NightView> {
    let inner = state.0.clone();
    blocking(move || {
        inner.with_plan(|p| {
            p.set_armed(armed, now_ms());
            if !armed && cancel_rest.unwrap_or(false) {
                p.skip_queued(now_ms());
            }
        });
        if armed {
            ensure_driver(&app, &inner);
        }
        emit(&app, &inner);
        Ok(view(&inner))
    })
    .await
}

#[tauri::command]
pub async fn agentux_night_stop(app: AppHandle, state: State<'_, AgentuxState>) -> Res<NightView> {
    let inner = state.0.clone();
    blocking(move || {
        let effect = inner.with_plan(|p| {
            p.set_armed(false, now_ms());
            p.request_stop()
        });
        if let (Some(Effect::Stop { run_id, .. }), Some(slot)) = (effect, app.try_state::<RolesSlot>()) {
            let _ = slot.supervisor().stop(&run_id);
        }
        ensure_driver(&app, &inner);
        emit(&app, &inner);
        Ok(view(&inner))
    })
    .await
}

#[tauri::command]
pub async fn agentux_night_clear(app: AppHandle, state: State<'_, AgentuxState>) -> Res<NightView> {
    let inner = state.0.clone();
    blocking(move || {
        inner.with_plan(|p| p.clear_finished());
        inner.prune_stamps();
        emit(&app, &inner);
        Ok(view(&inner))
    })
    .await
}

// ---- morning brief ---------------------------------------------------------------------------------------------

fn brief_of(inner: &Inner, run_ids: Option<Vec<String>>) -> Brief {
    let ids = match run_ids.filter(|r| !r.is_empty()) {
        Some(ids) => ids,
        None => {
            let from_plan = inner.with_plan(|p| p.run_ids());
            if from_plan.is_empty() {
                inner.with_index(true, |idx| idx.ids_since(now_ms().saturating_sub(BRIEF_WINDOW_MS)))
            } else {
                from_plan
            }
        }
    };
    build_brief(&inner.runs_dir(), &ids, &GitDiff { jail: Jail::global() }, now_ms())
}

/// The brief of the night's runs (or of `run_ids`), from the event logs and read-only git. No model call.
#[tauri::command]
pub async fn agentux_brief(state: State<'_, AgentuxState>, run_ids: Option<Vec<String>>) -> Res<Brief> {
    let inner = state.0.clone();
    blocking(move || Ok(brief_of(&inner, run_ids))).await
}

/// The only model call of this module: a one-shot Haiku summary of the brief's scrubbed facts, on a click.
#[tauri::command]
pub async fn agentux_brief_summarise(state: State<'_, AgentuxState>, run_ids: Option<Vec<String>>) -> Res<String> {
    let inner = state.0.clone();
    blocking(move || {
        let facts = facts_text(&brief_of(&inner, run_ids));
        if facts.trim().is_empty() {
            return Err(err("empty", "there is nothing to summarise"));
        }
        if std::env::var_os("INTELY_AGENTUX_FAKE").is_some() {
            return Ok(format!("Summary (fake model): {} lines of facts.", facts.lines().count()));
        }
        if read_only() {
            return Err(err(intely_core::jail::READ_ONLY, "read-only mode (INTELY_READONLY): summarising needs the network"));
        }
        let prompt = format!("Below are facts about agent runs that worked overnight. Write a short morning summary in at most 8 lines: what was done, what failed, what needs the developer's attention first. Use only these facts and do not invent anything.\n\n{facts}");
        crate::modules::l10n::run_claude(&prompt).map(|s| s.trim().to_owned())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamp(ws: &str, paths: &[(&str, &str)]) -> ItemStamp {
        ItemStamp { workspace_id: ws.into(), repo_paths: paths.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect() }
    }

    fn now(paths: &[(&str, &str)]) -> BTreeMap<String, String> {
        paths.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect()
    }

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn nothing_is_filtered_without_a_workspace_module() {
        assert_eq!(fits(None, None, &ids(&["a"]), &now(&[])), Fits::Yes);
        assert_eq!(fits(Some(&stamp("other", &[])), None, &ids(&["a"]), &now(&[])), Fits::Yes);
    }

    #[test]
    fn an_item_of_another_workspace_stays_queued() {
        let s = stamp("w3f9a1c2b4", &[("a", "/x/a")]);
        assert_eq!(fits(Some(&s), Some("w-migrated"), &ids(&["a"]), &now(&[("a", "/x/a")])), Fits::OtherWorkspace);
        assert_eq!(fits(Some(&s), Some("w3f9a1c2b4"), &ids(&["a"]), &now(&[("a", "/x/a")])), Fits::Yes);
    }

    #[test]
    fn an_unstamped_item_belongs_to_the_migrated_workspace_never_to_any() {
        assert_eq!(fits(None, Some("w-migrated"), &ids(&["a"]), &now(&[])), Fits::Yes);
        assert_eq!(fits(None, Some("w3f9a1c2b4"), &ids(&["a"]), &now(&[("a", "/x/a")])), Fits::OtherWorkspace);
    }

    #[test]
    fn an_item_whose_repo_ids_now_resolve_to_other_folders_does_not_fire() {
        let s = stamp("w1", &[("a", "/x/a"), ("b", "/x/b")]);
        assert_eq!(fits(Some(&s), Some("w1"), &ids(&["a", "b"]), &now(&[("a", "/x/a"), ("b", "/x/b")])), Fits::Yes);
        assert_eq!(fits(Some(&s), Some("w1"), &ids(&["a", "b"]), &now(&[("a", "/x/a"), ("b", "/elsewhere/b")])), Fits::PathsDiffer);
        assert_eq!(fits(Some(&s), Some("w1"), &ids(&["a", "b"]), &now(&[("a", "/x/a")])), Fits::PathsDiffer, "a repo that is gone is a difference");
        // only the item's own repos count
        assert_eq!(fits(Some(&s), Some("w1"), &ids(&["a"]), &now(&[("a", "/x/a"), ("b", "/moved/b")])), Fits::Yes);
    }

    #[test]
    fn stamps_are_kept_beside_the_plan_and_pruned_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let inner = Inner { data_dir: dir.path().to_path_buf(), index: Mutex::new(IndexSlot { index: None, refreshed: None }), stamps: Mutex::new(None), plan: Mutex::new(None), driver: AtomicBool::new(false), battery: Mutex::new(None), usage: Mutex::new(UsageIndex::new()) };
        let added = inner
            .with_plan(|p| p.add(NewItem { role_id: "r".into(), prompt: "p".into(), repo_ids: vec!["a".into()], max_minutes: None, max_tokens: None }).map(|i| i.id.clone()))
            .unwrap();
        inner.with_stamps(|s| s.items.insert(added.clone(), stamp("w1", &[("a", "/x/a")])));
        inner.with_stamps(|s| s.items.insert("ghost".into(), stamp("w1", &[])));
        inner.prune_stamps();
        assert_eq!(inner.with_stamps(|s| s.items.keys().cloned().collect::<Vec<_>>()), vec![added.clone()]);
        // survives a restart
        *lock(&inner.stamps) = None;
        assert_eq!(inner.with_stamps(|s| s.items.get(&added).cloned()), Some(stamp("w1", &[("a", "/x/a")])));
        assert!(dir.path().join("night-queue-workspaces.json").is_file());
    }

    #[test]
    fn the_gate_stops_the_driver_from_starting_anything() {
        use crate::modules::switchhook::{check_optional, testing::FakeClock, SwitchGate};
        let gate = SwitchGate::new(Arc::new(FakeClock::new()));
        gate.set().hold();
        assert_eq!(check_optional(Some(&gate)).unwrap_err().code, intely_core::code::WORKSPACE_SWITCHING);
    }
}
