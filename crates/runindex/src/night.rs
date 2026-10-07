//! The night queue: a plan of runs prepared in the evening and a pure state machine that decides, tick by tick, what the
//! app should do (start the next run, stop the current one on its budget). It owns no process: the Tauri glue feeds it an
//! [`Observation`] and carries out the [`Effect`]s through the existing supervisor (process gate, write lease, Rewind
//! snapshot first), so everything the IDE already enforces for a run still applies. It never commits or pushes: it only
//! starts runs, and a run's git is the agent allow-list's.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// A night holds at most this many runs (adding more is refused).
pub const MAX_RUNS_PER_NIGHT: usize = 8;
pub const MIN_MINUTES: u32 = 1;
pub const MAX_MINUTES: u32 = 480;
pub const MIN_TOKENS: u64 = 1_000;
pub const MAX_TOKENS: u64 = 5_000_000;
/// The `reason` of an item the user stopped by hand.
pub const USER_STOP: &str = "userStop";
pub const DEFAULT_MINUTES: u32 = 30;
pub const DEFAULT_TOKENS: u64 = 200_000;
const MAX_PROMPT: usize = 12_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemState {
    Queued,
    Running,
    Done,
    Failed,
    /// Stopped because a budget ran out.
    Stopped,
    /// Never started: removed from the night by the cap or by the user while armed.
    Skipped,
}

impl ItemState {
    pub fn is_final(self) -> bool {
        !matches!(self, Self::Queued | Self::Running)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NightItem {
    pub id: String,
    pub role_id: String,
    pub prompt: String,
    pub repo_ids: Vec<String>,
    pub max_minutes: u32,
    pub max_tokens: u64,
    pub state: ItemState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_ms: Option<u64>,
    #[serde(default)]
    pub tokens_used: u64,
    /// Why the item ended the way it did: `timeBudget`, `tokenBudget`, `needsYou`, `interrupted`, or an engine error code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Why a queued item is still waiting (a busy writer, no free slot): shown, retried on the next tick.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting: Option<String>,
}

/// What the webview sends to add an item.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewItem {
    pub role_id: String,
    pub prompt: String,
    pub repo_ids: Vec<String>,
    #[serde(default)]
    pub max_minutes: Option<u32>,
    #[serde(default)]
    pub max_tokens: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NightPlan {
    pub items: Vec<NightItem>,
    /// The queue is allowed to start runs. Never restored as true after a restart.
    pub armed: bool,
    #[serde(default)]
    pub next_id: u64,
    /// When the plan was armed (the brief covers runs from here).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub armed_ms: Option<u64>,
}

/// What the app tells the queue each tick.
#[derive(Debug, Clone, Default)]
pub struct Observation {
    pub now_ms: u64,
    pub on_battery: bool,
    pub read_only: bool,
    /// The run of the item that is running, if the host still knows it.
    pub run: Option<RunObs>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Working,
    NeedsYou,
    Finished { ok: bool },
}

#[derive(Debug, Clone, Copy)]
pub struct RunObs {
    pub phase: Phase,
    /// Input plus output tokens of the run so far (cache reads are not counted).
    pub tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    Start { item_id: String },
    Stop { run_id: String, reason: String },
}

/// Why the queue is not starting runs right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Paused {
    Battery,
    ReadOnly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    pub code: &'static str,
    pub message: String,
}

fn refuse<T>(code: &'static str, message: impl Into<String>) -> Result<T, Refused> {
    Err(Refused { code, message: message.into() })
}

impl NightPlan {
    pub fn load(path: &Path) -> Self {
        let mut plan: Self = fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        // A restart never resumes the night by itself, and a run that was running is gone from the host's point of view.
        plan.armed = false;
        for item in &mut plan.items {
            if item.state == ItemState::Running {
                item.state = ItemState::Failed;
                item.reason = Some("interrupted".into());
            }
        }
        plan
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        if let Some(dir) = path.parent() {
            intely_agent_core::events::log::create_private_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec(self).map_err(io::Error::other)?)?;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
        fs::rename(&tmp, path)
    }

    pub fn add(&mut self, new: NewItem) -> Result<&NightItem, Refused> {
        if self.items.len() >= MAX_RUNS_PER_NIGHT {
            return refuse("nightCap", format!("a night holds at most {MAX_RUNS_PER_NIGHT} runs"));
        }
        if new.role_id.trim().is_empty() {
            return refuse("noRole", "pick a role");
        }
        if new.repo_ids.is_empty() {
            return refuse("noRepo", "pick at least one repository");
        }
        let prompt = new.prompt.trim();
        if prompt.is_empty() {
            return refuse("emptyPrompt", "write a prompt first");
        }
        if prompt.chars().count() > MAX_PROMPT {
            return refuse("promptTooLong", format!("a prompt is at most {MAX_PROMPT} characters"));
        }
        let minutes = new.max_minutes.unwrap_or(DEFAULT_MINUTES);
        let tokens = new.max_tokens.unwrap_or(DEFAULT_TOKENS);
        if !(MIN_MINUTES..=MAX_MINUTES).contains(&minutes) {
            return refuse("badBudget", format!("the time budget is {MIN_MINUTES} to {MAX_MINUTES} minutes"));
        }
        if !(MIN_TOKENS..=MAX_TOKENS).contains(&tokens) {
            return refuse("badBudget", format!("the token budget is {MIN_TOKENS} to {MAX_TOKENS} tokens"));
        }
        self.next_id += 1;
        self.items.push(NightItem {
            id: format!("n-{}", self.next_id),
            role_id: new.role_id,
            prompt: prompt.to_owned(),
            repo_ids: new.repo_ids,
            max_minutes: minutes,
            max_tokens: tokens,
            state: ItemState::Queued,
            run_id: None,
            started_ms: None,
            ended_ms: None,
            tokens_used: 0,
            reason: None,
            waiting: None,
        });
        Ok(self.items.last().expect("just pushed"))
    }

    /// Removes a queued or finished item. A running one must be stopped first.
    pub fn remove(&mut self, id: &str) -> Result<(), Refused> {
        match self.items.iter().position(|i| i.id == id) {
            None => refuse("unknownItem", format!("no queue item {id}")),
            Some(p) if self.items[p].state == ItemState::Running => refuse("itemRunning", "stop the running item first"),
            Some(p) => {
                self.items.remove(p);
                Ok(())
            }
        }
    }

    /// Moves a queued item one place (`-1` earlier, `1` later) among the queued items.
    pub fn move_item(&mut self, id: &str, delta: i32) -> Result<(), Refused> {
        let Some(p) = self.items.iter().position(|i| i.id == id) else { return refuse("unknownItem", format!("no queue item {id}")) };
        if self.items[p].state != ItemState::Queued {
            return refuse("notQueued", "only a waiting item can be moved");
        }
        let target = p as i64 + i64::from(delta.signum());
        if target < 0 || target as usize >= self.items.len() || self.items[target as usize].state != ItemState::Queued {
            return Ok(());
        }
        self.items.swap(p, target as usize);
        Ok(())
    }

    pub fn clear_finished(&mut self) {
        self.items.retain(|i| !i.state.is_final());
        if self.items.is_empty() {
            self.armed_ms = None;
        }
    }

    pub fn set_armed(&mut self, armed: bool, now_ms: u64) {
        if armed && !self.armed {
            self.armed_ms = Some(now_ms);
        }
        self.armed = armed;
    }

    pub fn running(&self) -> Option<&NightItem> {
        self.items.iter().find(|i| i.state == ItemState::Running)
    }

    pub fn paused(&self, obs: &Observation) -> Option<Paused> {
        if obs.read_only {
            Some(Paused::ReadOnly)
        } else if obs.on_battery {
            Some(Paused::Battery)
        } else {
            None
        }
    }

    /// One decision step. Updates the items from what was observed and returns what to do now (at most one effect).
    pub fn tick(&mut self, obs: &Observation) -> Vec<Effect> {
        if let Some(i) = self.items.iter().position(|i| i.state == ItemState::Running) {
            return self.tick_running(i, obs);
        }
        if !self.armed {
            return Vec::new();
        }
        let Some(next) = self.items.iter().find(|i| i.state == ItemState::Queued) else {
            // Nothing left to start and nothing running: the night is over.
            self.armed = false;
            return Vec::new();
        };
        if self.paused(obs).is_some() {
            return Vec::new();
        }
        vec![Effect::Start { item_id: next.id.clone() }]
    }

    fn tick_running(&mut self, i: usize, obs: &Observation) -> Vec<Effect> {
        let item = &mut self.items[i];
        let Some(run) = obs.run else {
            // The host no longer knows the run: it ended without us seeing it.
            item.state = ItemState::Failed;
            item.reason.get_or_insert_with(|| "interrupted".into());
            item.ended_ms = Some(obs.now_ms);
            return Vec::new();
        };
        item.tokens_used = item.tokens_used.max(run.tokens);
        if let Phase::Finished { ok } = run.phase {
            item.ended_ms = Some(obs.now_ms);
            // A budget stop was already decided: keep that state, the run just reports an interruption.
            item.state = if item.reason.as_deref().is_some_and(|r| r.ends_with("Budget") || r == USER_STOP) {
                ItemState::Stopped
            } else if ok {
                ItemState::Done
            } else {
                ItemState::Failed
            };
            return Vec::new();
        }
        if item.reason.is_some() {
            // A stop was requested; waiting for the run to wind down.
            return Vec::new();
        }
        let elapsed_ms = obs.now_ms.saturating_sub(item.started_ms.unwrap_or(obs.now_ms));
        let reason = if elapsed_ms >= u64::from(item.max_minutes) * 60_000 {
            Some("timeBudget")
        } else if run.tokens >= item.max_tokens {
            Some("tokenBudget")
        } else {
            None
        };
        match (reason, item.run_id.clone()) {
            (Some(r), Some(run_id)) => {
                item.reason = Some(r.into());
                vec![Effect::Stop { run_id, reason: r.into() }]
            }
            _ => Vec::new(),
        }
    }

    /// The user stops the running item: one stop effect, the item ends as Stopped.
    pub fn request_stop(&mut self) -> Option<Effect> {
        let item = self.items.iter_mut().find(|i| i.state == ItemState::Running && i.reason.is_none())?;
        let run_id = item.run_id.clone()?;
        item.reason = Some(USER_STOP.into());
        Some(Effect::Stop { run_id, reason: USER_STOP.into() })
    }

    /// The glue started the run for `item_id`.
    pub fn on_started(&mut self, item_id: &str, run_id: &str, now_ms: u64) {
        if let Some(i) = self.items.iter_mut().find(|i| i.id == item_id) {
            i.state = ItemState::Running;
            i.run_id = Some(run_id.to_owned());
            i.started_ms = Some(now_ms);
            i.waiting = None;
            i.reason = None;
        }
    }

    /// The start was refused. A busy writer or a full slot only makes the item wait; anything else fails it for good.
    pub fn on_start_failed(&mut self, item_id: &str, code: &str, message: &str, now_ms: u64) {
        if let Some(i) = self.items.iter_mut().find(|i| i.id == item_id) {
            if matches!(code, "writeLease" | "noSlot") {
                i.waiting = Some(message.to_owned());
            } else {
                i.state = ItemState::Failed;
                i.reason = Some(code.to_owned());
                i.ended_ms = Some(now_ms);
            }
        }
    }

    /// Everything still queued becomes skipped (the user disarmed with "cancel the rest").
    pub fn skip_queued(&mut self, now_ms: u64) {
        for i in self.items.iter_mut().filter(|i| i.state == ItemState::Queued) {
            i.state = ItemState::Skipped;
            i.ended_ms = Some(now_ms);
        }
    }

    pub fn run_ids(&self) -> Vec<String> {
        self.items.iter().filter_map(|i| i.run_id.clone()).collect()
    }
}

/// Whether `pmset -g batt` output says the machine runs on its battery.
pub fn parse_on_battery(pmset: &str) -> bool {
    pmset.lines().next().is_some_and(|l| l.contains("Battery Power"))
}
