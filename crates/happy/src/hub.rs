//! The integration hub: provider state machine, supervisor tasks, token and settings handling.
//!
//! Zero cost when off ((design notes: integrations-plan) 1.5): `Hub::new` builds no HTTP client, spawns nothing and reads no
//! Keychain item. A provider task, and the shared client, exist only while the master switch, the provider switch and a
//! token are all there and the connection is not signed out.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use intely_core::jail::Jail;
use intely_settings::secrets::{Secret, SecretStore};
use intely_settings::{Object, SettingsError, SettingsStore};
use serde_json::{json, Value};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::chat_hub::{ChatState, RtBridge};
use crate::external::is_https;
use crate::net::{check_jail, resolve_base_with, ApiError, Client, Presets, Kind, Method, Scope};
use crate::parse;
use crate::sched::{self, Next};
use crate::socket::{Realtime, Timing};
use crate::time::now_ms;
use crate::types::{
    ChatEvent, ConfigPatch, ConnectionTest, Env, HappyConfig, HappyStatus, LastError, MeetView, MeetingStatus, PrefsPatch, ProviderCheck, ProviderPrefs, ProviderState, ProviderStatus, TimerPhase, TimerView, Trackable, UserInfo,
};

mod inbox;
mod mytasks;
mod timer;

const NS: &str = "happy";
const START_DELAY: Duration = Duration::from_secs(2);

/// Receives what changed; the Tauri glue forwards it as `happy:state`, `happy:timer` and `happy:meetings`.
pub trait Sink: Send + Sync + 'static {
    fn state(&self, status: &HappyStatus);
    fn timer(&self, view: &TimerView);
    fn meetings(&self, view: &MeetView);
    /// Team chat deltas (`happy:chat`). Defaulted so older sinks keep compiling.
    fn chat(&self, _event: &ChatEvent) {}
    /// Notifications inbox (`happy:notifications`) and my tasks (`happy:tasks`). Defaulted like `chat`.
    fn notifications(&self, _view: &crate::notifications::NotificationsView) {}
    fn tasks(&self, _view: &crate::tasks::TasksView) {}
}

/// Opens a link in the system browser. Must not put the URL into its error.
pub trait Opener: Send + Sync + 'static {
    fn open(&self, url: &str) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Id {
    Timer,
    Meet,
    Chat,
    Notifications,
    Tasks,
}

/// How often the Time Tracer polls while the window is blurred (the owner's bound is about 5 s for a timer changed elsewhere).
const BLURRED_TIMER_EVERY: Duration = Duration::from_secs(5);

impl Id {
    pub(crate) const ALL: [Id; 5] = [Id::Timer, Id::Meet, Id::Chat, Id::Notifications, Id::Tasks];

    pub(crate) fn name(self) -> &'static str {
        match self {
            Id::Timer => "timer",
            Id::Meet => "meet",
            Id::Chat => "chat",
            Id::Notifications => "notifications",
            Id::Tasks => "tasks",
        }
    }

    pub(crate) fn idx(self) -> usize {
        self as usize
    }

    /// Focused poll interval (plan 2.1 and 2.3).
    fn every(self) -> Duration {
        Duration::from_secs(match self {
            Id::Timer => 4,
            Id::Meet => 30,
            Id::Chat => 15,
            Id::Notifications => 45,
            Id::Tasks => 300,
        })
    }

    fn missing_hint(self) -> &'static str {
        match self {
            Id::Timer => "Needs the Projects module with time tracking enabled for this store",
            Id::Meet | Id::Chat => "Needs the team chat module and the chat.page.access permission",
            Id::Notifications => "The notifications endpoint is not available for this account",
            Id::Tasks => "Needs the Projects module with tasks assigned to you (the path is a guess until the real API is probed)",
        }
    }
}

fn prefs(cfg: &HappyConfig, id: Id) -> &ProviderPrefs {
    match id {
        Id::Timer => &cfg.timer,
        Id::Meet => &cfg.meet,
        Id::Chat => &cfg.chat,
        Id::Notifications => &cfg.notifications,
        Id::Tasks => &cfg.tasks,
    }
}

pub(crate) struct Prov {
    pub(crate) state: ProviderState,
    pub(crate) last_error: Option<LastError>,
    pub(crate) task: Option<JoinHandle<()>>,
    /// A poll succeeded since the loop (re)started: a later 403/404 is then a hiccup, not "this account may not use it".
    pub(crate) answered: bool,
}

impl Prov {
    fn new() -> Self {
        Self { state: ProviderState::Off, last_error: None, task: None, answered: false }
    }

    fn stop(&mut self) {
        self.answered = false;
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

impl St {
    pub(crate) fn user_due(&self) -> bool {
        let gap = Duration::from_secs((30u64 << self.user_failures.saturating_sub(1).min(4)).min(300));
        self.user_try_at.map_or(true, |t| t.elapsed() >= gap)
    }
}

pub(crate) struct St {
    pub(crate) cfg: HappyConfig,
    /// `None` until the Keychain was asked (a status request or the first start).
    token_saved: Option<bool>,
    pub(crate) user: Option<UserInfo>,
    /// When `/api/user/me` was last asked for and how many asks in a row left the user unknown: the retries are spaced
    /// (`user_gap`), so a failing `/me` never turns into a loop.
    user_try_at: Option<tokio::time::Instant>,
    user_failures: u32,
    validated_at: Option<i64>,
    pub(crate) signed_out: Option<LastError>,
    pub(crate) client: Option<Arc<Client>>,
    setup_error: Option<ApiError>,
    pub(crate) prov: [Prov; 5],
    timer: TimerView,
    timer_misses: u32,
    /// Bumped by every timer action: a poll that started before one is stale and dropped.
    timer_seq: u64,
    /// When the widgets summary (work-order timers, task titles) was last read by the timer poll.
    timer_summary_at: Option<tokio::time::Instant>,
    /// Project titles resolved for search results, by project id.
    project_titles: std::collections::HashMap<String, String>,
    pub(crate) meetings: MeetView,
    meet_misses: u32,
    pub(crate) chat: ChatState,
    nt: inbox::InboxState,
    tk: mytasks::TaskState,
    /// The server refused the socket for a reason other than the credentials: not retried until a new token or test.
    pub(crate) socket_blocked: bool,
    last_published: Option<HappyStatus>,
    /// Preset base URLs (env vars, then settings.json `happy.baseUrls`), read once at start-up.
    presets: Presets,
}

pub(crate) struct Inner {
    pub(crate) settings: Arc<SettingsStore>,
    secrets: Arc<dyn SecretStore>,
    pub(crate) sink: Arc<dyn Sink>,
    opener: Arc<dyn Opener>,
    jail: Jail,
    pub(crate) focus: watch::Sender<bool>,
    pub(crate) rt: Realtime,
    /// Ends the chat loop's wait early (the dock opened, a reconnect needs a catch-up).
    pub(crate) chat_wake: Arc<tokio::sync::Notify>,
    pub(crate) st: Mutex<St>,
}

#[derive(Clone)]
pub struct Hub(pub(crate) Arc<Inner>);

fn token_key(env: &Env) -> String {
    let slot = match env {
        Env::Production => "production",
        Env::Sandbox => "sandbox",
        Env::Custom => "custom",
    };
    format!("happy.token.{slot}")
}

/// A login JWT: three dot-separated base64url parts. Anything else is refused before it is sent anywhere.
fn looks_like_jwt(token: &str) -> bool {
    let parts: Vec<&str> = token.split('.').collect();
    token.len() <= 4096 && parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'=')))
}

pub(crate) fn last_error(e: &ApiError) -> LastError {
    LastError { code: e.code.clone(), message: e.message.clone(), at_ms: now_ms() }
}

pub(crate) fn random_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let bits = |salt: u64| {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(salt ^ now_ms() as u64);
        h.finish()
    };
    let (a, b) = (bits(1), bits(2));
    format!("{:08x}-{:04x}-4{:03x}-a{:03x}-{:012x}", a >> 32, a >> 16 & 0xffff, a & 0xfff, b >> 52 & 0xfff, b & 0xffff_ffff_ffff)
}

/// The stored `happy` namespace laid over the defaults, so a missing key (or an older file) never loses the others. A
/// value of the wrong type falls back to everything off.
fn load_config(stored: Object) -> HappyConfig {
    let Ok(Value::Object(mut base)) = serde_json::to_value(HappyConfig::default()) else { return HappyConfig::default() };
    base.insert("customBaseUrl".to_owned(), Value::Null);
    for (key, value) in stored {
        match (base.get_mut(&key), value) {
            (Some(Value::Object(slot)), Value::Object(over)) => slot.extend(over),
            (Some(slot), value) => *slot = value,
            (None, _) => {}
        }
    }
    serde_json::from_value(Value::Object(base)).unwrap_or_default()
}

fn failed(e: &ApiError) -> ConnectionTest {
    ConnectionTest { ok: false, user: None, message: Some(format!("{} ({})", e.message, e.code)), providers: Vec::new() }
}

impl Hub {
    pub fn new(settings: Arc<SettingsStore>, secrets: Arc<dyn SecretStore>, sink: Arc<dyn Sink>, opener: Arc<dyn Opener>) -> Self {
        Self::with_jail(settings, secrets, sink, opener, (*Jail::global()).clone())
    }

    pub fn with_jail(settings: Arc<SettingsStore>, secrets: Arc<dyn SecretStore>, sink: Arc<dyn Sink>, opener: Arc<dyn Opener>, jail: Jail) -> Self {
        Self::with_timing(settings, secrets, sink, opener, jail, Timing::default())
    }

    /// [`Hub::with_jail`] with the socket's reconnect timing (tests shorten it).
    pub fn with_timing(settings: Arc<SettingsStore>, secrets: Arc<dyn SecretStore>, sink: Arc<dyn Sink>, opener: Arc<dyn Opener>, jail: Jail, timing: Timing) -> Self {
        let stored = settings.get(NS).unwrap_or_default();
        let presets = Presets::load(&stored);
        let cfg = load_config(stored);
        let st = St {
            cfg,
            presets,
            token_saved: None,
            user: None,
            validated_at: None,
            user_try_at: None,
            user_failures: 0,
            signed_out: None,
            client: None,
            setup_error: None,
            prov: [Prov::new(), Prov::new(), Prov::new(), Prov::new(), Prov::new()],
            timer: TimerView::idle(),
            timer_misses: 0,
            timer_seq: 0,
            timer_summary_at: None,
            project_titles: std::collections::HashMap::new(),
            meetings: MeetView { meetings: Vec::new(), stale: false },
            meet_misses: 0,
            chat: ChatState::default(),
            nt: inbox::InboxState::default(),
            tk: mytasks::TaskState::default(),
            socket_blocked: false,
            last_published: None,
        };
        // The socket handler holds a weak reference back: the hub owns the connection, never the other way round.
        Hub(Arc::new_cyclic(|me| Inner { settings, secrets, sink, opener, jail, focus: watch::channel(true).0, rt: Realtime::with_timing(Arc::new(RtBridge(me.clone())), timing), chat_wake: Arc::default(), st: Mutex::new(st) }))
    }

    pub(crate) fn st(&self) -> MutexGuard<'_, St> {
        self.0.st.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The window focus from Rust (`WindowEvent::Focused`). Providers poll only while it is true.
    pub fn set_focus(&self, focused: bool) {
        if focused && !*self.0.focus.borrow() {
            // The catch-up the plan asks for: one bootstrap (and a refresh of the open channel) on regaining focus; the timer reads
            // its work-order source (the summary) too, so what was started or stopped meanwhile is right when the window comes back.
            let mut st = self.st();
            st.chat.catchup = true;
            st.timer_summary_at = None;
        }
        self.0.focus.send_if_modified(|f| std::mem::replace(f, focused) != focused);
    }

    /// Provider tasks that are alive: 0 whenever integrations are off.
    pub fn running_tasks(&self) -> usize {
        self.st().prov.iter().filter(|p| p.task.as_ref().is_some_and(|t| !t.is_finished())).count()
    }

    /// Whether the HTTP client exists (it is created lazily and dropped with the last provider).
    pub fn has_client(&self) -> bool {
        self.st().client.is_some()
    }

    fn wants_run(st: &St) -> bool {
        st.cfg.master && st.signed_out.is_none() && (st.cfg.timer.enabled || st.cfg.meet.enabled || st.cfg.chat.enabled || st.cfg.notifications.enabled || st.cfg.tasks.enabled)
    }

    /// Startup: when integrations are on, start the providers shortly after first paint. When they are off this returns
    /// at once and nothing is left behind.
    pub async fn start(&self) {
        if !Self::wants_run(&self.st()) {
            return;
        }
        tokio::time::sleep(START_DELAY).await;
        self.apply().await;
    }

    fn build_status(st: &St) -> HappyStatus {
        HappyStatus {
            config: st.cfg.clone(),
            base_url: resolve_base_with(&st.cfg.env, st.cfg.custom_base_url.as_deref(), &st.presets).ok().map(|u| u.as_str().trim_end_matches('/').to_owned()),
            token_saved: st.token_saved.unwrap_or(false),
            user: st.user.clone(),
            validated_at_ms: st.validated_at,
            signed_out: st.signed_out.clone(),
            providers: Id::ALL.iter().map(|id| ProviderStatus { id: id.name().to_owned(), state: st.prov[id.idx()].state.clone(), last_error: st.prov[id.idx()].last_error.clone() }).collect(),
        }
    }

    pub(crate) fn publish(&self) {
        self.reconcile_socket();
        let status = {
            let mut st = self.st();
            let status = Self::build_status(&st);
            if st.last_published.as_ref() == Some(&status) {
                return;
            }
            st.last_published = Some(status.clone());
            status
        };
        self.0.sink.state(&status);
    }

    pub async fn status(&self) -> HappyStatus {
        let unknown = self.st().token_saved.is_none();
        if unknown {
            let env = self.st().cfg.env.clone();
            let saved = self.read_token_flag(&env).await;
            self.st().token_saved = Some(saved);
        }
        self.publish();
        Self::build_status(&self.st())
    }

    async fn read_token_flag(&self, env: &Env) -> bool {
        let (secrets, key) = (Arc::clone(&self.0.secrets), token_key(env));
        tokio::task::spawn_blocking(move || secrets.has(&key).unwrap_or(false)).await.unwrap_or(false)
    }

    async fn read_token(&self, env: &Env) -> Option<Secret> {
        let (secrets, key) = (Arc::clone(&self.0.secrets), token_key(env));
        tokio::task::spawn_blocking(move || secrets.get(&key).ok().flatten()).await.ok().flatten()
    }

    fn device_id(&self) -> String {
        if let Some(id) = self.0.settings.get(NS).ok().and_then(|o| o.get("deviceId").and_then(Value::as_str).map(str::to_owned)) {
            return id;
        }
        let id = random_id();
        let mut patch = Object::new();
        patch.insert("deviceId".to_owned(), json!(id));
        let _ = self.0.settings.set(NS, patch);
        id
    }

    fn persist(&self, cfg: &HappyConfig) {
        if let Value::Object(mut patch) = serde_json::to_value(cfg).unwrap_or(Value::Null) {
            // `null` removes the key: a cleared custom URL must not linger in settings.json.
            patch.entry("customBaseUrl").or_insert(Value::Null);
            if let Err(e) = self.0.settings.set(NS, patch) {
                eprintln!("happy: settings not saved: {}", crate::redact::redact(&e.message));
            }
        }
    }

    /// The base URL of an environment, if the jail lets the app talk to it.
    fn base(&self, env: &Env, custom: Option<&str>) -> Result<reqwest::Url, ApiError> {
        let presets = self.st().presets.clone();
        let base = resolve_base_with(env, custom, &presets)?;
        check_jail(&self.0.jail, &base)?;
        Ok(base)
    }

    /// Brings the running tasks in line with the configuration, the token and the connection state.
    pub async fn apply(&self) {
        let (wanted, env, custom, had_client) = {
            let st = self.st();
            (Self::wants_run(&st), st.cfg.env.clone(), st.cfg.custom_base_url.clone(), st.client.is_some())
        };
        let mut built = None;
        let mut token_checked = None;
        if wanted && !had_client {
            built = Some(match self.base(&env, custom.as_deref()) {
                Err(e) => Err(e),
                Ok(base) => match self.read_token(&env).await {
                    None => {
                        token_checked = Some(false);
                        Err(ApiError::new(Kind::Invalid, None, "noToken", "No token is saved for this environment"))
                    }
                    Some(token) => {
                        token_checked = Some(true);
                        Client::new(base, token, self.device_id()).map(Arc::new)
                    }
                },
            });
        }
        let fresh_client = {
            let mut st = self.st();
            if let Some(saved) = token_checked {
                st.token_saved = Some(saved);
            }
            match built {
                Some(Ok(client)) => {
                    st.client = Some(client);
                    (st.user_try_at, st.user_failures) = (None, 0);
                    st.setup_error = None;
                }
                Some(Err(e)) => st.setup_error = (e.code != "noToken").then_some(e),
                None => {}
            }
            let (master, signed_out) = (st.cfg.master, st.signed_out.is_some());
            let have_client = st.client.is_some();
            let waiting = !have_client && st.setup_error.is_none() && st.token_saved != Some(true);
            let setup_error = st.setup_error.as_ref().map(last_error);
            for id in Id::ALL {
                let enabled = master && prefs(&st.cfg, id).enabled;
                let want = enabled && have_client && !signed_out;
                if want {
                    if st.prov[id.idx()].state != ProviderState::NotPermitted && st.prov[id.idx()].task.is_none() {
                        let task = self.spawn_provider(id);
                        let p = &mut st.prov[id.idx()];
                        (p.state, p.last_error, p.task) = (ProviderState::Probing, None, Some(task));
                    }
                    continue;
                }
                let p = &mut st.prov[id.idx()];
                p.stop();
                if p.state == ProviderState::NotPermitted && enabled {
                    continue;
                }
                (p.state, p.last_error) = match (enabled, signed_out, &setup_error, waiting) {
                    (false, ..) => (ProviderState::Off, None),
                    (true, true, ..) => (ProviderState::SignedOut, None),
                    (true, false, Some(e), _) => (ProviderState::Error, Some(e.clone())),
                    (true, false, None, true) => (ProviderState::WaitingForToken, None),
                    (true, false, None, false) => (ProviderState::Probing, None),
                };
            }
            if st.prov.iter().all(|p| p.task.is_none()) {
                st.client = None;
            }
            !had_client && st.client.is_some()
        };
        if fresh_client {
            let hub = self.clone();
            tokio::spawn(async move { hub.refresh_user().await });
        }
        self.publish();
    }

    fn spawn_provider(&self, id: Id) -> JoinHandle<()> {
        let hub = self.clone();
        let focus = self.0.focus.subscribe();
        // Only the chat loop is woken by `chat_wake`; the others get a Notify nobody signals, so a wake never reaches the
        // wrong provider nor cuts a provider's backoff short.
        let wake = if id == Id::Chat { Arc::clone(&self.0.chat_wake) } else { Arc::default() };
        // The Time Tracer follows a timer started or stopped elsewhere (the phone, the browser) while the window is not in front too:
        // one small request every few seconds, nothing at all when the provider is off. The others stay quiet while blurred.
        let blurred = (id == Id::Timer).then_some(BLURRED_TIMER_EVERY);
        tokio::spawn(async move {
            let period = hub.clone();
            sched::run_with(focus, move || period.period(id), blurred, wake, || {
                let hub = hub.clone();
                async move { hub.tick(id).await }
            })
            .await;
        })
    }

    /// The wait between two ticks of a provider. The socket relaxes the meeting poll (live events carry the changes);
    /// the chat loop ticks often while the dock is open and rarely otherwise (what is due is decided in `tick_chat`).
    fn period(&self, id: Id) -> Duration {
        match id {
            Id::Meet if self.0.rt.is_live() => Duration::from_secs(90),
            Id::Chat => crate::chat_api::tick_period(self.st().chat.dock_open),
            _ => id.every(),
        }
    }

    /// Who is connected: asked once per client, in the background, so Settings can show the name after a restart.
    pub(crate) async fn refresh_user(&self) {
        let client = {
            let mut st = self.st();
            // Two starters at once (a fresh client and the socket's need for the user) make one ask, not two.
            if st.user_try_at.is_some_and(|t| t.elapsed() < Duration::from_secs(2)) {
                return;
            }
            let Some(client) = st.client.clone() else { return };
            st.user_try_at = Some(tokio::time::Instant::now());
            client
        };
        let answer = client.call(Scope::Connection, Method::Get, "/api/user/me", &[], None, false).await;
        {
            let mut st = self.st();
            if st.client.as_ref().is_some_and(|c| Arc::ptr_eq(c, &client)) {
                if let Ok(v) = &answer {
                    st.user = parse::user(v);
                    st.validated_at = Some(now_ms());
                }
                st.user_failures = if st.user.is_some() { 0 } else { st.user_failures.saturating_add(1) };
            }
        }
        // A failed ask does not publish: `publish` would only start the next ask (see `user_due`).
        if answer.is_ok() {
            self.publish();
        }
    }

    /// Whether an unknown user may be asked for again: never before 30 s after the last ask, doubling up to 5 min while
    /// the asks keep failing.
    pub(crate) fn user_due(&self) -> bool {
        self.st().user_due()
    }

    /// The signed-in user's id, asking once for it when it is unknown (and an ask is due, or at least `min_gap` after the last
    /// one when the caller needs it now). `None` when it stays unknown.
    pub(crate) async fn ensure_user(&self, min_gap: Option<Duration>) -> Option<String> {
        let known = |h: &Self| h.st().user.as_ref().map(|u| u.id.clone());
        if let Some(id) = known(self) {
            return Some(id);
        }
        let ask = match min_gap {
            Some(gap) => self.st().user_try_at.map_or(true, |t| t.elapsed() >= gap),
            None => self.user_due(),
        };
        if ask {
            self.refresh_user().await;
        }
        known(self)
    }

    async fn tick(&self, id: Id) -> Next {
        // A user that stayed unknown (the first ask failed) is asked for again, spaced by `user_due`.
        self.ensure_user(None).await;
        let result = match id {
            Id::Timer => self.poll_timer().await,
            Id::Meet => self.poll_meet().await,
            Id::Chat => self.tick_chat().await,
            Id::Notifications => self.poll_inbox().await,
            Id::Tasks => self.poll_tasks().await,
        };
        match result {
            Ok(()) => {
                {
                    let mut st = self.st();
                    let p = &mut st.prov[id.idx()];
                    // A REST success clears a REST error, not the socket's (that one is cleared by a new token or test).
                    let socket_error = p.last_error.take().filter(|e| e.code.starts_with("socket"));
                    (p.state, p.last_error, p.answered) = (ProviderState::Ready, socket_error, true);
                }
                self.publish();
                Next::Again
            }
            Err(e) => self.fail(id, &e),
        }
    }

    pub(crate) fn fail(&self, id: Id, e: &ApiError) -> Next {
        if e.kind != Kind::Unauthorized {
            // A tick that was mid-flight when the connection was signed out (or switched off) must not overwrite the
            // SignedOut / Off state with its own "notConnected" failure.
            let st = self.st();
            if st.signed_out.is_some() || st.client.is_none() {
                return Next::Stop;
            }
        }
        let last = last_error(e);
        let next = match e.kind {
            Kind::Unauthorized => {
                self.sign_out(last);
                return Next::Stop;
            }
            Kind::Forbidden | Kind::NotFound if self.has_answered(id) => {
                // It answered before: one 403/404 (a gateway, a deploy, a store switch) does not mean "this account may not use it".
                // The poll goes on with a backoff and the data is marked old instead of silently freezing on the last state.
                self.mark_stale(id);
                let mut st = self.st();
                let p = &mut st.prov[id.idx()];
                (p.state, p.last_error) = (ProviderState::Degraded, Some(last));
                Next::Backoff
            }
            Kind::Forbidden | Kind::NotFound => {
                let mut st = self.st();
                let p = &mut st.prov[id.idx()];
                (p.state, p.last_error, p.task) = (ProviderState::NotPermitted, Some(last), None);
                if st.prov.iter().all(|p| p.task.is_none()) {
                    st.client = None;
                }
                Next::Stop
            }
            Kind::Credits => {
                self.st().prov[id.idx()].last_error = Some(last);
                Next::Backoff
            }
            Kind::Backoff | Kind::Offline => {
                self.mark_stale(id);
                let mut st = self.st();
                let p = &mut st.prov[id.idx()];
                (p.state, p.last_error) = (ProviderState::Degraded, Some(last));
                Next::Backoff
            }
            Kind::Blocked | Kind::Invalid | Kind::Conflict => {
                let mut st = self.st();
                let p = &mut st.prov[id.idx()];
                (p.state, p.last_error) = (ProviderState::Error, Some(last));
                Next::Backoff
            }
        };
        self.publish();
        next
    }

    /// 401: stop everything on the connection and keep the banner until a new token is saved.
    pub(crate) fn sign_out(&self, last: LastError) {
        {
            let mut st = self.st();
            st.signed_out = Some(last);
            st.client = None;
            st.chat.reset();
            st.nt = inbox::InboxState::default();
            st.tk = mytasks::TaskState::default();
            let cfg = st.cfg.clone();
            for id in Id::ALL {
                let p = &mut st.prov[id.idx()];
                p.stop();
                p.last_error = None;
                p.state = if cfg.master && prefs(&cfg, id).enabled { ProviderState::SignedOut } else { ProviderState::Off };
            }
        }
        self.publish();
    }

    /// 403 states are re-probed only on a manual test or a new token.
    fn reset_not_permitted(&self) {
        for p in &mut self.st().prov {
            if p.state == ProviderState::NotPermitted {
                (p.state, p.last_error) = (ProviderState::Off, None);
            }
        }
    }

    pub(crate) async fn request(&self, scope: Scope, method: Method, path: &str, query: &[(&str, &str)], body: Option<&Value>) -> Result<Value, ApiError> {
        let (client, actions) = {
            let st = self.st();
            let actions = match scope {
                Scope::Timer => st.cfg.timer.allow_actions,
                Scope::Meet => st.cfg.meet.allow_actions,
                Scope::Chat => st.cfg.chat.allow_actions,
                Scope::Notifications => st.cfg.notifications.allow_actions,
                Scope::Tasks => st.cfg.tasks.allow_actions,
                Scope::Connection => false,
            };
            (st.client.clone(), actions)
        };
        let client = client.ok_or_else(|| ApiError::new(Kind::Invalid, None, "notConnected", "Happy is not connected: switch the integration on and save a token"))?;
        let result = client.call(scope, method, path, query, body, actions).await;
        if let Err(e) = &result {
            if e.kind == Kind::Unauthorized {
                self.sign_out(last_error(e));
            }
        }
        result
    }

    pub(crate) fn require(&self, id: Id) -> Result<(), ApiError> {
        let st = self.st();
        if st.cfg.master && prefs(&st.cfg, id).enabled && st.client.is_some() {
            Ok(())
        } else {
            Err(ApiError::new(Kind::Invalid, None, "notConnected", "Switch the integration on and save a token first"))
        }
    }

    // ---- configuration and token ----

    pub async fn set_config(&self, patch: ConfigPatch) -> Result<HappyStatus, ApiError> {
        let (cfg, connection_changed, url_changed) = {
            let st = self.st();
            let mut cfg = st.cfg.clone();
            let merge = |into: &mut ProviderPrefs, p: Option<PrefsPatch>| {
                if let Some(p) = p {
                    into.enabled = p.enabled.unwrap_or(into.enabled);
                    into.show_in_status_bar = p.show_in_status_bar.unwrap_or(into.show_in_status_bar);
                    into.allow_actions = p.allow_actions.unwrap_or(into.allow_actions);
                }
            };
            cfg.master = patch.master.unwrap_or(cfg.master);
            cfg.env = patch.env.unwrap_or(cfg.env);
            if let Some(url) = patch.custom_base_url {
                cfg.custom_base_url = Some(url.trim().to_owned()).filter(|u| !u.is_empty());
            }
            merge(&mut cfg.timer, patch.timer);
            merge(&mut cfg.meet, patch.meet);
            merge(&mut cfg.chat, patch.chat);
            merge(&mut cfg.notifications, patch.notifications);
            merge(&mut cfg.tasks, patch.tasks);
            let changed = cfg.env != st.cfg.env || (cfg.env == Env::Custom && cfg.custom_base_url != st.cfg.custom_base_url);
            let url_changed = cfg.custom_base_url != st.cfg.custom_base_url;
            (cfg, changed, url_changed)
        };
        if cfg.env == Env::Custom {
            resolve_base_with(&cfg.env, cfg.custom_base_url.as_deref(), &self.st().presets)?;
        }
        if url_changed {
            // The custom slot is not tied to a host, so a token saved for one URL must never be sent to another.
            let (secrets, key) = (Arc::clone(&self.0.secrets), token_key(&Env::Custom));
            let _ = tokio::task::spawn_blocking(move || secrets.remove(&key)).await;
        }
        self.persist(&cfg);
        {
            let mut st = self.st();
            st.cfg = cfg;
            if connection_changed || url_changed {
                // A different environment has its own token slot, user and session.
                st.client = None;
                st.token_saved = None;
                st.user = None;
                st.validated_at = None;
                st.signed_out = None;
                st.setup_error = None;
                for p in &mut st.prov {
                    p.stop();
                    (p.state, p.last_error) = (ProviderState::Off, None);
                }
                st.timer = TimerView::idle();
                st.chat.reset();
                st.nt = inbox::InboxState::default();
                st.tk = mytasks::TaskState::default();
                st.socket_blocked = false;
            }
        }
        self.apply().await;
        Ok(self.status().await)
    }

    /// Validates a pasted token with `GET /api/user/me` and saves it only on a 200. The value is never kept anywhere else.
    pub async fn save_token(&self, token: &str) -> ConnectionTest {
        let token = token.trim();
        if !looks_like_jwt(token) {
            return ConnectionTest { ok: false, user: None, message: Some("That does not look like a Happy login token (three parts separated by dots)".to_owned()), providers: Vec::new() };
        }
        let (env, custom) = {
            let st = self.st();
            (st.cfg.env.clone(), st.cfg.custom_base_url.clone())
        };
        let client = match self.base(&env, custom.as_deref()).and_then(|base| Client::new(base, Secret::new(token), self.device_id())) {
            Ok(c) => Arc::new(c),
            Err(e) => return failed(&e),
        };
        let test = self.run_test(&client, false).await;
        if !test.ok {
            return test;
        }
        let (secrets, key, value) = (Arc::clone(&self.0.secrets), token_key(&env), Secret::new(token));
        let saved = tokio::task::spawn_blocking(move || secrets.set(&key, value)).await.unwrap_or_else(|_| Err(SettingsError::new("io", "the secret store task failed")));
        if let Err(e) = saved {
            return ConnectionTest { ok: false, user: test.user, message: Some(format!("The token is valid but could not be saved: {}", crate::redact::redact(&e.message))), providers: test.providers };
        }
        {
            let mut st = self.st();
            st.token_saved = Some(true);
            st.signed_out = None;
            st.setup_error = None;
            st.user = test.user.clone();
            st.validated_at = Some(now_ms());
            st.client = None;
            st.socket_blocked = false;
            st.chat.reset();
            st.nt = inbox::InboxState::default();
            st.tk = mytasks::TaskState::default();
            for p in &mut st.prov {
                p.stop();
                (p.state, p.last_error) = (ProviderState::Off, None);
            }
        }
        self.apply().await;
        test
    }

    /// Tests the saved token: the current user and, per provider, whether it is allowed.
    pub async fn test_connection(&self) -> ConnectionTest {
        let existing = self.st().client.clone();
        let client = match existing {
            Some(c) => c,
            None => {
                let (env, custom) = {
                    let st = self.st();
                    (st.cfg.env.clone(), st.cfg.custom_base_url.clone())
                };
                let base = match self.base(&env, custom.as_deref()) {
                    Ok(b) => b,
                    Err(e) => return failed(&e),
                };
                let Some(token) = self.read_token(&env).await else {
                    return ConnectionTest { ok: false, user: None, message: Some("No token is saved for this environment".to_owned()), providers: Vec::new() };
                };
                match Client::new(base, token, self.device_id()) {
                    Ok(c) => Arc::new(c),
                    Err(e) => return failed(&e),
                }
            }
        };
        let test = self.run_test(&client, true).await;
        if test.ok {
            self.reset_not_permitted();
            for check in test.providers.iter().filter(|c| !c.allowed) {
                if let Some(id) = Id::ALL.into_iter().find(|id| id.name() == check.id) {
                    let mut st = self.st();
                    if prefs(&st.cfg, id).enabled && st.cfg.master {
                        let p = &mut st.prov[id.idx()];
                        p.stop();
                        (p.state, p.last_error) = (ProviderState::NotPermitted, Some(LastError { code: "forbidden".to_owned(), message: check.hint.clone().unwrap_or_default(), at_ms: now_ms() }));
                    }
                }
            }
            self.st().token_saved = Some(true);
            self.apply().await;
        }
        test
    }

    async fn run_test(&self, client: &Arc<Client>, stored: bool) -> ConnectionTest {
        let me = match client.call(Scope::Connection, Method::Get, "/api/user/me", &[], None, false).await {
            Ok(v) => v,
            Err(e) => {
                if stored && e.kind == Kind::Unauthorized {
                    self.sign_out(last_error(&e));
                }
                return failed(&e);
            }
        };
        let user = parse::user(&me);
        if stored {
            let mut st = self.st();
            st.user = user.clone();
            st.validated_at = Some(now_ms());
        }
        let mut providers = Vec::new();
        for id in Id::ALL {
            let probe = match id {
                Id::Timer => client.call(Scope::Timer, Method::Get, "/api/projects/me/running-timer", &[], None, false).await,
                Id::Meet => client.call(Scope::Meet, Method::Get, "/api/chat/meetings", &[("status", "live")], None, false).await,
                Id::Chat => client.call(Scope::Chat, Method::Get, "/api/chat/bootstrap", &[], None, false).await,
                Id::Notifications => client.call(Scope::Notifications, Method::Get, "/api/notifications/badge", &[], None, false).await,
                Id::Tasks => client.call(Scope::Tasks, Method::Get, "/api/tasks", &[("assignee", "me"), ("limit", "1")], None, false).await,
            };
            providers.push(match probe {
                Ok(_) => ProviderCheck { id: id.name().to_owned(), allowed: true, hint: None },
                Err(e) if e.code == crate::chat::NOT_ENABLED => ProviderCheck { id: id.name().to_owned(), allowed: false, hint: Some("Team chat is not enabled for this store yet (pilot)".to_owned()) },
                Err(e) if matches!(e.kind, Kind::Forbidden | Kind::NotFound) => ProviderCheck { id: id.name().to_owned(), allowed: false, hint: Some(id.missing_hint().to_owned()) },
                Err(e) => ProviderCheck { id: id.name().to_owned(), allowed: false, hint: Some(e.message) },
            });
        }
        self.publish();
        ConnectionTest { ok: true, user, message: None, providers }
    }

    /// Removes the saved token of the current environment and stops everything.
    pub async fn disconnect(&self) -> HappyStatus {
        let env = self.st().cfg.env.clone();
        let (secrets, key) = (Arc::clone(&self.0.secrets), token_key(&env));
        let _ = tokio::task::spawn_blocking(move || secrets.remove(&key)).await;
        {
            let mut st = self.st();
            st.client = None;
            st.token_saved = Some(false);
            st.user = None;
            st.validated_at = None;
            st.signed_out = None;
            st.setup_error = None;
            st.timer = TimerView::idle();
            st.meetings = MeetView { meetings: Vec::new(), stale: false };
            st.chat.reset();
            st.nt = inbox::InboxState::default();
            st.tk = mytasks::TaskState::default();
            st.socket_blocked = false;
        }
        self.apply().await;
        self.0.sink.timer(&TimerView::idle());
        self.0.sink.meetings(&MeetView { meetings: Vec::new(), stale: false });
        self.0.sink.notifications(&crate::notifications::NotificationsView::empty());
        self.0.sink.tasks(&crate::tasks::TasksView::empty());
        self.status().await
    }

    // ---- Time Tracer ----

    pub fn timer_current(&self) -> TimerView {
        self.st().timer.clone()
    }

    fn offset(&self) -> i64 {
        self.st().client.as_ref().map_or(0, |c| c.offset_ms())
    }

    fn set_timer(&self, mut view: TimerView) -> TimerView {
        view.offset_ms = self.offset();
        let changed = {
            let mut st = self.st();
            st.timer_misses = 0;
            st.timer_seq += 1;
            let changed = TimerView { offset_ms: view.offset_ms, ..st.timer.clone() } != view;
            st.timer = view.clone();
            changed
        };
        if changed {
            self.0.sink.timer(&view);
        }
        view
    }

    /// Whether the provider has had a successful reply since its loop (re)started.
    fn has_answered(&self, id: Id) -> bool {
        self.st().prov[id.idx()].answered
    }

    fn mark_stale(&self, id: Id) {
        let mut st = self.st();
        match id {
            Id::Timer => {
                st.timer_misses += 1;
                if st.timer_misses >= 2 && st.timer.phase != TimerPhase::Idle && !st.timer.stale {
                    st.timer.stale = true;
                    let view = st.timer.clone();
                    drop(st);
                    self.0.sink.timer(&view);
                }
            }
            Id::Meet => {
                st.meet_misses += 1;
                if st.meet_misses >= 2 && !st.meetings.stale && !st.meetings.meetings.is_empty() {
                    st.meetings.stale = true;
                    let view = st.meetings.clone();
                    drop(st);
                    self.0.sink.meetings(&view);
                }
            }
            Id::Chat => {
                st.chat.misses += 1;
                if st.chat.misses >= 2 && !st.chat.cache.stale && st.chat.cache.loaded {
                    st.chat.cache.stale = true;
                    drop(st);
                    self.emit_summary();
                }
            }
            Id::Notifications => {
                drop(st);
                self.inbox_missed();
            }
            Id::Tasks => {
                drop(st);
                self.tasks_missed();
            }
        }
    }

    /// After a failed action the real state is read again (plan 2.1).
    async fn reread_timer(&self, e: ApiError) -> ApiError {
        if e.kind != Kind::Unauthorized {
            let _ = self.poll_timer().await;
        }
        e
    }

    pub async fn timer_start(&self, target: Trackable) -> Result<TimerView, ApiError> {
        self.require(Id::Timer)?;
        let mut body = json!({ "kind": target.kind, "id": target.id });
        if let Some(task) = target.task_id {
            body["taskId"] = json!(task);
        }
        match self.request(Scope::Timer, Method::Post, "/api/widgets/timer/start", &[], Some(&body)).await {
            Ok(v) => Ok(self.set_timer(parse::timer_from_widget(&v))),
            Err(e) => Err(self.reread_timer(e).await),
        }
    }

    /// 404 on stop means it was already stopped: the state is cleared, not an error.
    pub async fn timer_stop(&self) -> Result<TimerView, ApiError> {
        self.require(Id::Timer)?;
        match self.request(Scope::Timer, Method::Post, "/api/widgets/timer/stop", &[], Some(&json!({}))).await {
            Ok(_) => Ok(self.set_timer(TimerView::idle())),
            Err(e) if e.kind == Kind::NotFound => Ok(self.set_timer(TimerView::idle())),
            Err(e) => Err(self.reread_timer(e).await),
        }
    }

    async fn timer_verb(&self, verb: &str) -> Result<TimerView, ApiError> {
        self.require(Id::Timer)?;
        let path = format!("/api/widgets/timer/{verb}");
        match self.request(Scope::Timer, Method::Post, &path, &[], Some(&json!({}))).await {
            Ok(v) => Ok(self.set_timer(parse::timer_from_widget(&v))),
            Err(e) if e.kind == Kind::NotFound => Ok(self.set_timer(TimerView::idle())),
            Err(e) => Err(self.reread_timer(e).await),
        }
    }

    pub async fn timer_pause(&self) -> Result<TimerView, ApiError> {
        self.timer_verb("pause").await
    }

    pub async fn timer_resume(&self) -> Result<TimerView, ApiError> {
        self.timer_verb("resume").await
    }

    // ---- Meet ----

    pub fn meet_current(&self) -> MeetView {
        self.st().meetings.clone()
    }

    async fn fetch_meetings(&self) -> Result<MeetView, ApiError> {
        let mut meetings = Vec::new();
        for (status, query) in [(MeetingStatus::Live, "live"), (MeetingStatus::Scheduled, "scheduled")] {
            let v = self.request(Scope::Meet, Method::Get, "/api/chat/meetings", &[("status", query)], None).await?;
            meetings.extend(parse::meetings(&v, status));
        }
        // The lobby count only arrives as a live event: keep it until another event (or the meeting's end) changes it.
        let before = self.st().meetings.clone();
        for m in &mut meetings {
            m.waiting = m.waiting.or_else(|| before.meetings.iter().find(|b| b.id == m.id).and_then(|b| b.waiting));
        }
        Ok(MeetView { meetings, stale: false })
    }

    pub(crate) fn set_meetings(&self, view: MeetView) {
        let changed = {
            let mut st = self.st();
            st.meet_misses = 0;
            let changed = st.meetings != view;
            st.meetings = view.clone();
            changed
        };
        if changed {
            self.0.sink.meetings(&view);
        }
    }

    pub(crate) async fn poll_meet(&self) -> Result<(), ApiError> {
        let view = self.fetch_meetings().await?;
        self.set_meetings(view);
        Ok(())
    }

    /// Fetches the live and scheduled meetings now.
    pub async fn meet_list(&self) -> Result<MeetView, ApiError> {
        self.require(Id::Meet)?;
        let view = self.fetch_meetings().await?;
        self.set_meetings(view.clone());
        Ok(view)
    }

    /// Asks the server for a fresh join link and opens it in the system browser. The link is dropped right after.
    pub async fn meet_join(&self, id: &str) -> Result<(), ApiError> {
        self.require(Id::Meet)?;
        let path = format!("/api/chat/meetings/{id}/join");
        let v = self.request(Scope::Meet, Method::Post, &path, &[], Some(&json!({}))).await?;
        let url = parse::join_url(&v).filter(|u| is_https(u)).ok_or_else(|| ApiError::invalid("invalidJoinUrl", "The server returned an unusable join link"))?;
        self.0.opener.open(&url).map_err(|_| ApiError::invalid("openFailed", "The browser could not be opened"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(v: Value) -> Object {
        match v {
            Value::Object(o) => o,
            _ => unreachable!(),
        }
    }

    #[test]
    fn a_partial_or_foreign_namespace_still_loads() {
        let cfg = load_config(obj(json!({ "master": true, "env": "custom", "customBaseUrl": "http://localhost:1", "timer": { "enabled": true }, "deviceId": "x", "future": 1 })));
        assert!(cfg.master && cfg.timer.enabled && cfg.timer.show_in_status_bar && cfg.timer.allow_actions && !cfg.meet.enabled);
        assert_eq!((cfg.env, cfg.custom_base_url.as_deref()), (Env::Custom, Some("http://localhost:1")));
        assert_eq!(load_config(Object::new()), HappyConfig::default());
        assert_eq!(load_config(obj(json!({ "master": "yes" }))), HappyConfig::default(), "a wrong type means everything off");
    }

    struct Quiet;
    impl Sink for Quiet {
        fn state(&self, _: &HappyStatus) {}
        fn timer(&self, _: &TimerView) {}
        fn meetings(&self, _: &MeetView) {}
    }
    impl Opener for Quiet {
        fn open(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
    }

    async fn chat_state(hub: &Hub) -> ProviderState {
        hub.status().await.providers.into_iter().find(|p| p.id == "chat").unwrap().state
    }

    /// A tick that was mid-flight while a 401 signed the connection out used to overwrite SignedOut with its own
    /// "notConnected" failure (Chat tab: "could not start" next to the "session expired" banner).
    #[tokio::test]
    async fn a_late_failure_does_not_overwrite_the_signed_out_state() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Arc::new(SettingsStore::open(&dir.path().join("settings.json")).unwrap());
        let hub = Hub::new(settings, Arc::new(intely_settings::secrets::MemorySecretStore::new()), Arc::new(Quiet), Arc::new(Quiet));
        let on = Some(PrefsPatch { enabled: Some(true), ..Default::default() });
        hub.set_config(ConfigPatch { master: Some(true), env: Some(Env::Custom), custom_base_url: Some("http://localhost:1".into()), chat: on, ..Default::default() }).await.unwrap();
        assert_eq!(chat_state(&hub).await, ProviderState::WaitingForToken);
        let late = ApiError::new(Kind::Invalid, None, "notConnected", "Happy is not connected");
        // No client (switched off / token gone): the late failure changes nothing.
        assert!(matches!(hub.fail(Id::Chat, &late), Next::Stop));
        assert_eq!(chat_state(&hub).await, ProviderState::WaitingForToken);
        hub.sign_out(LastError { code: "DEVICE_LOGGED_OUT".into(), message: "Session revoked".into(), at_ms: 1 });
        assert_eq!(chat_state(&hub).await, ProviderState::SignedOut);
        for kind in [Kind::Invalid, Kind::Offline, Kind::Blocked, Kind::Forbidden] {
            assert!(matches!(hub.fail(Id::Chat, &ApiError::new(kind, None, "late", "late")), Next::Stop));
            assert_eq!(chat_state(&hub).await, ProviderState::SignedOut);
        }
        assert_eq!(hub.status().await.signed_out.map(|s| s.code), Some("DEVICE_LOGGED_OUT".to_owned()));
    }

    #[test]
    fn only_a_three_part_token_passes_the_shape_check() {
        assert!(looks_like_jwt("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln"));
        for bad in ["", "a.b", "a.b.c.d", "a b.c.d", "a..c", "Bearer a.b.c"] {
            assert!(!looks_like_jwt(bad), "{bad}");
        }
    }
}
