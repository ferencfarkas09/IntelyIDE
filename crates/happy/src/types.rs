//! Serde types of the `ipc.happy` namespace (camelCase, like `intely-core`). Normalised DTOs only: the webview never sees raw
//! Happy JSON, tokens or join links ((design notes: integrations-plan) 1.1).

use serde::{Deserialize, Serialize};
#[cfg(feature = "specta")]
use specta_typescript::Number;

macro_rules! api_types {
    ($($item:item)*) => {
        $(
            #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
            #[cfg_attr(feature = "specta", derive(specta::Type))]
            $item
        )*
    };
}

api_types! {
    /// Which Happy backend the connection talks to. Each environment has its own token slot.
    #[serde(rename_all = "camelCase")]
    pub enum Env {
        Production,
        Sandbox,
        Custom,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ProviderPrefs {
        pub enabled: bool,
        pub show_in_status_bar: bool,
        /// Mutating calls (start/stop, join) are refused while this is off.
        pub allow_actions: bool,
    }

    /// What is persisted in `settings.json` under `happy`. No secrets.
    #[serde(rename_all = "camelCase")]
    pub struct HappyConfig {
        /// The master switch: off stops every provider without touching their own switches.
        pub master: bool,
        pub env: Env,
        /// Only used with `env: custom`: https, or http on a loopback host.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub custom_base_url: Option<String>,
        pub timer: ProviderPrefs,
        pub meet: ProviderPrefs,
        /// Team chat (Beta 2): REST plus the shared Socket.IO connection. Sending costs store credits on the real service.
        pub chat: ProviderPrefs,
        /// Notifications inbox: badge, list and mark-read (polled, no socket).
        pub notifications: ProviderPrefs,
        /// My tasks: the list by status, with the timer and agent shortcuts.
        pub tasks: ProviderPrefs,
    }

    #[serde(rename_all = "camelCase")]
    pub struct PrefsPatch {
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub enabled: Option<bool>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub show_in_status_bar: Option<bool>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub allow_actions: Option<bool>,
    }

    /// A partial update of [`HappyConfig`]; an empty `customBaseUrl` clears it.
    #[serde(rename_all = "camelCase")]
    pub struct ConfigPatch {
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub master: Option<bool>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub env: Option<Env>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub custom_base_url: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub timer: Option<PrefsPatch>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub meet: Option<PrefsPatch>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub chat: Option<PrefsPatch>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub notifications: Option<PrefsPatch>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub tasks: Option<PrefsPatch>,
    }

    /// `off -> waitingForToken -> probing -> ready <-> degraded`, side exits `notPermitted` (403: no polling until a manual
    /// test or a new token), `signedOut` (401: shared by the whole connection) and `error`. The switch stores the intent,
    /// the state says what actually runs.
    #[serde(rename_all = "camelCase")]
    pub enum ProviderState {
        Off,
        WaitingForToken,
        Probing,
        Ready,
        Degraded,
        NotPermitted,
        SignedOut,
        Error,
    }

    #[serde(rename_all = "camelCase")]
    pub struct LastError {
        /// The server's `code` when it sent one (`DEVICE_LOGGED_OUT`, `INSUFFICIENT_CREDITS`), else a short name.
        pub code: String,
        /// Already redacted.
        pub message: String,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub at_ms: i64,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ProviderStatus {
        /// `timer`, `meet` or `chat`.
        pub id: String,
        pub state: ProviderState,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub last_error: Option<LastError>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct UserInfo {
        pub id: String,
        pub name: String,
        pub roles: Vec<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub restaurant_id: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub restaurant_name: Option<String>,
    }

    /// Event `happy:state` carries the same shape.
    #[serde(rename_all = "camelCase")]
    pub struct HappyStatus {
        pub config: HappyConfig,
        /// The resolved base URL (host only is shown in the UI), `None` when a custom URL is invalid.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub base_url: Option<String>,
        pub token_saved: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub user: Option<UserInfo>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        #[cfg_attr(feature = "specta", specta(type = Option<Number>))]
        pub validated_at_ms: Option<i64>,
        /// Set after a 401: the whole connection is stopped and the UI shows a persistent banner until a new token is saved.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub signed_out: Option<LastError>,
        pub providers: Vec<ProviderStatus>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ProviderCheck {
        pub id: String,
        pub allowed: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub hint: Option<String>,
    }

    /// Result of `testConnection` and `saveToken`: the current user from `GET /api/user/me` and, per provider, whether the
    /// token may use it.
    #[serde(rename_all = "camelCase")]
    pub struct ConnectionTest {
        pub ok: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub user: Option<UserInfo>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub message: Option<String>,
        pub providers: Vec<ProviderCheck>,
    }

    #[serde(rename_all = "camelCase")]
    pub enum TimerPhase {
        Idle,
        Running,
        Paused,
        Break,
    }

    /// One shape for both server payloads (the `running-timer` entry and the widget's timer state). The clock ticks in the
    /// webview from `startedAtMs`, `accumulatedSec` and `offsetMs` (server time minus local time).
    #[serde(rename_all = "camelCase")]
    pub struct TimerView {
        pub phase: TimerPhase,
        /// `project` or `workOrder`; empty while idle.
        pub kind: String,
        pub target_id: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub task_id: Option<String>,
        pub title: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub project: Option<String>,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub started_at_ms: i64,
        /// Seconds counted before `startedAtMs` (pauses excluded); the whole value while paused.
        pub accumulated_sec: u32,
        pub can_break: bool,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub offset_ms: i64,
        /// Two polls in a row failed: the clock keeps running but the state may be out of date.
        pub stale: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct Trackable {
        pub kind: String,
        pub id: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub task_id: Option<String>,
        pub title: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub project: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct TimeEntry {
        pub id: String,
        pub title: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub project: Option<String>,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub started_at_ms: i64,
        /// `None` while the entry is still running.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        #[cfg_attr(feature = "specta", specta(type = Option<Number>))]
        pub ended_at_ms: Option<i64>,
        pub seconds: u32,
        /// Closed by the server after being left open (shown as 0 s and labelled).
        pub abandoned: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct TodayView {
        pub entries: Vec<TimeEntry>,
        pub total_seconds: u32,
        /// More rows exist than the paging cap loaded (the oldest ones are missing).
        pub truncated: bool,
    }

    /// A project the picker search found; its tasks come back as [`Trackable`] rows grouped under `project`.
    #[serde(rename_all = "camelCase")]
    pub struct ProjectHit {
        pub id: String,
        pub title: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub code: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub customer: Option<String>,
    }

    /// `timer.search`: matching projects, and tasks (each with its project title) of the matches.
    #[serde(rename_all = "camelCase")]
    pub struct TaskSearch {
        pub projects: Vec<ProjectHit>,
        pub tasks: Vec<Trackable>,
    }

    /// Settled seconds of the current day, week and month (`/api/projects/time-entries/summary`); the running entry is not in it.
    #[serde(rename_all = "camelCase")]
    pub struct TimeTotals {
        pub day_sec: u32,
        pub week_sec: u32,
        pub month_sec: u32,
    }

    #[serde(rename_all = "camelCase")]
    pub enum MeetingStatus {
        Live,
        Scheduled,
    }

    /// Never carries a join URL: joining is a Rust-side call that opens the browser.
    #[serde(rename_all = "camelCase")]
    pub struct Meeting {
        pub id: String,
        pub title: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub channel: Option<String>,
        pub status: MeetingStatus,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        #[cfg_attr(feature = "specta", specta(type = Option<Number>))]
        pub start_ms: Option<i64>,
        pub participants: u32,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub host: Option<String>,
        /// Guests waiting in the lobby (`chat:meeting:lobby`); only set while someone waits.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub waiting: Option<u32>,
    }

    /// Event `happy:meetings` carries the same shape.
    #[serde(rename_all = "camelCase")]
    pub struct MeetView {
        pub meetings: Vec<Meeting>,
        pub stale: bool,
    }
}

// ---- Team chat (Beta 2). Normalised from the real backend's payloads (see `chat.rs`); these DTOs are the contract. ----

api_types! {
    #[serde(rename_all = "camelCase")]
    pub enum ChatKind {
        /// A public channel (`type: "public"`).
        Channel,
        Private,
        Direct,
        /// A group conversation (a direct channel with several other people).
        Group,
        Record,
        Customer,
    }

    /// The member's notification preference per channel; drives which messages ask for a toast.
    #[serde(rename_all = "camelCase")]
    pub enum NotifyLevel {
        All,
        Mentions,
        None,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ChatChannel {
        pub id: String,
        pub kind: ChatKind,
        pub name: String,
        pub unread_count: u32,
        pub mention_count: u32,
        pub muted: bool,
        pub notify_level: NotifyLevel,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        #[cfg_attr(feature = "specta", specta(type = Option<Number>))]
        pub last_message_at_ms: Option<i64>,
        pub topic: String,
        pub description: String,
        pub member_count: u32,
        pub archived: bool,
        pub starred: bool,
        /// False for a channel seen through `browse` that the user has not joined.
        pub is_member: bool,
        /// The user's role in the channel (`admin`, `member`), when a member.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub role: Option<String>,
        /// The other people of a direct or group channel.
        pub peers: Vec<ChatPerson>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub last_preview: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub last_sender: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ChatReaction {
        pub emoji: String,
        pub count: u32,
        /// The current user reacted with it.
        pub mine: bool,
    }

    /// Attachment metadata only: files are not downloaded by the chat (no remote content in the webview).
    #[serde(rename_all = "camelCase")]
    pub struct ChatAttachment {
        pub name: String,
        pub mime_type: String,
        pub size: u32,
    }

    /// `pending` and `failed` only exist for the user's own optimistic sends; the socket echo (same `clientMessageId`)
    /// replaces them with a `sent` message.
    #[serde(rename_all = "camelCase")]
    pub enum SendState {
        Sent,
        Pending,
        Failed,
    }

    /// Plain text only: no HTML, no remote images (the webview renders links itself and opens them through Rust).
    #[serde(rename_all = "camelCase")]
    pub struct ChatMessage {
        pub id: String,
        pub channel_id: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub client_message_id: Option<String>,
        pub sender_id: String,
        pub sender_name: String,
        pub text: String,
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub created_at_ms: i64,
        pub edited: bool,
        pub deleted: bool,
        /// A system line ("X joined"), shown muted.
        pub system: bool,
        pub mine: bool,
        /// The message mentions the current user.
        pub mentions_me: bool,
        pub send_state: SendState,
        /// Why a `failed` send failed (`INSUFFICIENT_CREDITS`, `offline`, ...).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub error_code: Option<String>,
        /// `text`, `system`, `meeting` or `record`.
        pub kind: String,
        /// Set on a thread reply: the id of the root message. Replies are never shown inline in the channel.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub thread_root: Option<String>,
        /// On a root message: how many replies, who replied and when last.
        pub reply_count: u32,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        #[cfg_attr(feature = "specta", specta(type = Option<Number>))]
        pub last_reply_at_ms: Option<i64>,
        pub reply_users: Vec<ChatPerson>,
        pub reactions: Vec<ChatReaction>,
        pub attachments: Vec<ChatAttachment>,
        pub pinned: bool,
    }

    /// Oldest first. `cursor` is the id to pass as `before` for the next older page, `None` at the start of history.
    /// `hasNewer` and `anchorId` are set by an `around` window (a jump to a message).
    #[serde(rename_all = "camelCase")]
    pub struct MessagePage {
        pub channel_id: String,
        pub messages: Vec<ChatMessage>,
        pub has_more: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub cursor: Option<String>,
        pub has_newer: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub anchor_id: Option<String>,
    }

    /// A thread: the root message and its replies, oldest first.
    #[serde(rename_all = "camelCase")]
    pub struct ThreadView {
        pub channel_id: String,
        pub root: ChatMessage,
        pub replies: Vec<ChatMessage>,
    }

    /// One row of the "Threads" list.
    #[serde(rename_all = "camelCase")]
    pub struct ThreadSummary {
        pub root: ChatMessage,
        pub channel_id: String,
        pub channel_name: String,
        pub channel_kind: ChatKind,
        pub reply_count: u32,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        #[cfg_attr(feature = "specta", specta(type = Option<Number>))]
        pub last_reply_at_ms: Option<i64>,
        pub unread_count: u32,
    }

    /// A member of a channel (the members panel).
    #[serde(rename_all = "camelCase")]
    pub struct ChatMember {
        pub id: String,
        pub name: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub email: Option<String>,
        /// `admin` or `member`.
        pub role: String,
        pub online: bool,
        pub portal: bool,
    }

    #[serde(rename_all = "camelCase")]
    pub struct SearchHit {
        pub message: ChatMessage,
        pub channel_name: String,
    }

    /// `GET /api/chat/search` (server-side, up to 30 each).
    #[serde(rename_all = "camelCase")]
    pub struct ChatSearch {
        pub messages: Vec<SearchHit>,
        pub channels: Vec<ChatChannel>,
        pub people: Vec<ChatPerson>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct ChatPerson {
        pub id: String,
        pub name: String,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub detail: Option<String>,
    }

    /// The shared socket, as the chat UI needs it: `reconnecting` makes the chip say so and the poll cadence faster.
    #[serde(rename_all = "camelCase")]
    pub enum ChatLink {
        Off,
        Connecting,
        Live,
        Reconnecting,
    }

    #[serde(rename_all = "camelCase")]
    pub enum MessageChange {
        New,
        Updated,
        Deleted,
        /// The optimistic message was replaced by the server's copy.
        Replaced,
        /// A send failed (the message stays visible with Retry).
        Failed,
    }
}

macro_rules! partial_types {
    ($($item:item)*) => {
        $(
            #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
            #[cfg_attr(feature = "specta", derive(specta::Type))]
            $item
        )*
    };
}

partial_types! {
    /// The channel list with counters. `credits` and `sendCost` are store credits: every send spends `sendCost` on the real
    /// service (the plan says 0.02, unverified), so the UI shows a hint and a blocked state when `creditsEmpty`.
    #[serde(rename_all = "camelCase")]
    pub struct ChatSummary {
        pub channels: Vec<ChatChannel>,
        pub unread_total: u32,
        pub mention_total: u32,
        /// How many threads have replies the user has not seen (server-driven, from `GET /api/chat/threads?unread=true`).
        pub thread_unread: u32,
        /// What the store's settings let this user do (bootstrap `permissions`).
        pub can_create_channel: bool,
        pub can_manage_channels: bool,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub credits: Option<f64>,
        pub send_cost: f64,
        /// The last send was answered with 402, or the bootstrap says the balance is 0. Cleared by the next good bootstrap or send.
        pub credits_empty: bool,
        pub link: ChatLink,
        /// The last bootstrap failed (offline/backoff): the data may be out of date.
        pub stale: bool,
        /// A bootstrap has succeeded since the provider started.
        pub loaded: bool,
    }

    /// Event `happy:chat`. Deltas only: the webview subscribes and applies them to what `chatOpen` returned.
    #[serde(tag = "type", rename_all = "camelCase")]
    pub enum ChatEvent {
        /// Channel list or counters changed.
        #[serde(rename_all = "camelCase")]
        Summary { summary: ChatSummary },
        /// `notify` is true when the message deserves a toast: someone else's, not in the channel the user is looking at,
        /// and allowed by the channel's `notifyLevel` (`none` never, `mentions` only mentions and direct messages, `all`
        /// everything; a muted channel only for mentions).
        #[serde(rename_all = "camelCase")]
        Message { channel_id: String, message: ChatMessage, change: MessageChange, notify: bool },
        /// Who is typing in a channel right now (expires by itself after about 5 s).
        #[serde(rename_all = "camelCase")]
        Typing { channel_id: String, names: Vec<String> },
        /// The socket state changed.
        #[serde(rename_all = "camelCase")]
        Link { link: ChatLink },
    }
}

impl ChatKind {
    /// A direct or group conversation: it has no name of its own, nobody can be invited and it lives in "Direct messages".
    pub fn is_direct(&self) -> bool {
        matches!(self, ChatKind::Direct | ChatKind::Group)
    }
}

impl Default for ProviderPrefs {
    fn default() -> Self {
        Self { enabled: false, show_in_status_bar: true, allow_actions: true }
    }
}

impl Default for HappyConfig {
    /// Everything off, Sandbox until the user switches ((design notes: integrations-plan) 1.3).
    fn default() -> Self {
        Self { master: false, env: Env::Sandbox, custom_base_url: None, timer: ProviderPrefs::default(), meet: ProviderPrefs::default(), chat: ProviderPrefs::default(), notifications: ProviderPrefs::default(), tasks: ProviderPrefs::default() }
    }
}

impl Default for PrefsPatch {
    fn default() -> Self {
        Self { enabled: None, show_in_status_bar: None, allow_actions: None }
    }
}

impl Default for ConfigPatch {
    fn default() -> Self {
        Self { master: None, env: None, custom_base_url: None, timer: None, meet: None, chat: None, notifications: None, tasks: None }
    }
}

impl TimerView {
    pub fn idle() -> Self {
        Self {
            phase: TimerPhase::Idle,
            kind: String::new(),
            target_id: String::new(),
            task_id: None,
            title: String::new(),
            project: None,
            started_at_ms: 0,
            accumulated_sec: 0,
            can_break: false,
            offset_ms: 0,
            stale: false,
        }
    }
}

#[cfg(feature = "specta")]
pub fn type_collection() -> specta::Types {
    specta::Types::default()
        .register::<HappyConfig>()
        .register::<ConfigPatch>()
        .register::<HappyStatus>()
        .register::<ConnectionTest>()
        .register::<TimerView>()
        .register::<Trackable>()
        .register::<TodayView>()
        .register::<TaskSearch>()
        .register::<TimeTotals>()
        .register::<MeetView>()
        .register::<crate::notifications::NotificationsView>()
        .register::<crate::tasks::TasksView>()
        .register::<ChatSummary>()
        .register::<ChatEvent>()
        .register::<MessagePage>()
        .register::<ChatMessage>()
        .register::<ChatPerson>()
        .register::<ChatChannel>()
        .register::<ThreadView>()
        .register::<ThreadSummary>()
        .register::<ChatMember>()
        .register::<ChatSearch>()
}

#[cfg(all(test, feature = "specta"))]
mod tests {
    #[test]
    fn the_type_collection_exports_to_typescript() {
        specta_typescript::Typescript::default().export(&super::type_collection(), specta_serde::Format).expect("export");
    }
}
