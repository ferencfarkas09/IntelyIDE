//! `AgentHub` (providers-plan 5.10, remote-plan R3/R4/R5): the single, Tauri-free command surface for agent runs. The
//! Tauri commands wrap it, and so does the Remote gateway, so a phone and the desktop go through one code path. Every
//! mutating call carries an [`Origin`]; an answer references a pending request and resolves it exactly once
//! ([`PendingTable`]: first answer wins, forged answers are rejected).
//!
//! This module defines the trait, the shared wire types and the pending-request table every implementation reuses.
//! Wiring the trait to the running host is the job of the Tauri layer.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};

#[cfg(feature = "specta")]
use specta_typescript::{Number, Unknown};

use crate::api::{AgentSummary, PermissionDecision, QuestionAnswer};
use crate::bus::EventBus;
use crate::events::EventLog;
use crate::policy::decide::PolicyContext;
use crate::policy::intent::ToolIntent;

wire_enums! {
    /// How a remote action is gated, computed by the policy (never by the client) and re-checked at answer time.
    pub enum Eligibility {
        /// One tap on the phone (strict allow-list).
        Low,
        /// A fresh passkey assertion bound to the request.
        StepUp,
        /// Never remote: the card is not offered and a remote answer is rejected and audited.
        DesktopOnly,
    }

    pub enum Risk {
        Low,
        Medium,
        High,
        Blocked,
    }

    pub enum PendingKind {
        Permission,
        Question,
    }

    /// A follow-up prompt while a turn runs: wait for the turn to end, or stop it first.
    pub enum PromptMode {
        Queue,
        Interrupt,
    }
}

wire_types! {
    /// Who made a call. Recorded with the resolution of a request ("answered on Mac" / "from <device>").
    #[derive(Eq, Hash)]
    #[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
    pub enum Origin {
        Desktop,
        Remote { device_id: String },
    }

    /// An open `permission.request` or `question.request`.
    #[serde(rename_all = "camelCase")]
    pub struct PendingRequest {
        pub req_id: String,
        pub agent_id: String,
        pub kind: PendingKind,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub tool_id: Option<String>,
        /// The tool intent a permission card shows (absent for questions). Judged again at answer time.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub intent: Option<ToolIntent>,
        /// Hash of the displayed intent; a remote answer must quote it back.
        pub intent_hash: String,
        pub risk: Risk,
        pub eligibility: Eligibility,
        /// Epoch ms. A remote answer after this is rejected; a pending ask is never auto-allowed.
        #[cfg_attr(feature = "specta", specta(type = Number))]
        pub expires_at: u64,
        /// ExitPlanMode only: the first 2 KiB of the (already redacted) plan, so the person who approves on the phone sees what they approve
        /// (permission-modes spec 5.7). Never part of the intent hash.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub plan_excerpt: Option<String>,
        /// The plan was longer than the excerpt.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub plan_truncated: Option<bool>,
    }

    /// The outcome of an answer: who won.
    #[serde(rename_all = "camelCase")]
    pub struct Resolution {
        pub req_id: String,
        pub agent_id: String,
        pub origin: Origin,
    }

    /// Settings of `start_run` that come from the user, not from the model: a vetted template plus parameters.
    #[serde(rename_all = "camelCase")]
    pub struct StartParams {
        pub template_id: String,
        #[cfg_attr(feature = "specta", specta(type = Unknown))]
        pub params: serde_json::Value,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HubError {
    #[error("unknown request")]
    Unknown,
    #[error("the request belongs to another run")]
    WrongRun,
    #[error("the request expired")]
    Expired,
    #[error("this request can only be answered on the Mac")]
    DesktopOnly,
    #[error("the answer does not match the displayed intent")]
    IntentMismatch,
    #[error("the request was already answered")]
    AlreadyResolved { by: Origin },
    #[error("that answer is not offered for this request")]
    NotOffered,
    #[error("the request is not a {0}")]
    WrongKind(&'static str),
    #[error("no such run")]
    NoSuchRun,
    #[error("not available: {0}")]
    Unavailable(String),
}

impl HubError {
    /// Stable machine code for acks and the audit log.
    pub fn code(&self) -> &'static str {
        match self {
            HubError::Unknown => "unknownRequest",
            HubError::WrongRun => "wrongRun",
            HubError::Expired => "expired",
            HubError::DesktopOnly => "desktopOnly",
            HubError::IntentMismatch => "intentMismatch",
            HubError::AlreadyResolved { .. } => "alreadyResolved",
            HubError::NotOffered => "notOffered",
            HubError::WrongKind(_) => "wrongKind",
            HubError::NoSuchRun => "noSuchRun",
            HubError::Unavailable(_) => "unavailable",
        }
    }
}

pub trait AgentHub: Send + Sync {
    fn list_runs(&self) -> Vec<AgentSummary>;
    fn pending_requests(&self) -> Vec<PendingRequest>;
    /// The broker context of a run, for re-judging a request at answer time. `None` = unknown run.
    fn policy_context(&self, agent_id: &str) -> Option<PolicyContext>;
    /// The durable log and the bus of events (publish happens only after the append, see [`EventBus`]).
    fn log(&self) -> Arc<dyn EventLog>;
    fn bus(&self) -> EventBus;

    fn send_prompt(&self, agent_id: &str, text: &str, mode: PromptMode, origin: &Origin) -> Result<(), HubError>;
    fn answer_permission(&self, req_id: &str, agent_id: &str, decision: PermissionDecision, intent_hash: Option<&str>, origin: &Origin) -> Result<Resolution, HubError>;
    fn answer_question(&self, req_id: &str, agent_id: &str, answer: QuestionAnswer, intent_hash: Option<&str>, origin: &Origin) -> Result<Resolution, HubError>;
    fn interrupt(&self, agent_id: &str, origin: &Origin) -> Result<(), HubError>;
    /// A vetted template only (never a raw role); the hub enforces `remoteStartable` for a remote origin.
    fn start_run(&self, start: StartParams, origin: &Origin) -> Result<AgentSummary, HubError>;
    /// Who resolved a request (for `permission.resolved`); `None` when unknown.
    fn resolved_origin(&self, req_id: &str) -> Option<Origin>;
    /// Kill switch / panic: `enableRemoteControl(false)` on every live Claude query; returns how many were reached.
    fn disable_claude_remote_control(&self) -> usize {
        0
    }
}

const DONE_KEEP: usize = 2048;

/// The pending-request table every [`AgentHub`] implementation uses. `resolve` is a compare-and-swap under one lock:
/// of any number of concurrent answers exactly one succeeds, the others get `AlreadyResolved { by }`.
#[derive(Default)]
pub struct PendingTable {
    inner: Mutex<TableInner>,
}

#[derive(Default)]
struct TableInner {
    open: HashMap<String, PendingRequest>,
    done: HashMap<String, Origin>,
    done_order: VecDeque<String>,
    expired: HashMap<String, ()>,
}

impl PendingTable {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, TableInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn register(&self, req: PendingRequest) {
        self.lock().open.insert(req.req_id.clone(), req);
    }

    pub fn open(&self) -> Vec<PendingRequest> {
        let mut v: Vec<_> = self.lock().open.values().cloned().collect();
        v.sort_by(|a, b| a.expires_at.cmp(&b.expires_at).then(a.req_id.cmp(&b.req_id)));
        v
    }

    pub fn get(&self, req_id: &str) -> Option<PendingRequest> {
        self.lock().open.get(req_id).cloned()
    }

    pub fn resolved_origin(&self, req_id: &str) -> Option<Origin> {
        self.lock().done.get(req_id).cloned()
    }

    /// The host could not apply a claimed answer (the provider process did not take it): the request is open again.
    pub fn reopen(&self, req: PendingRequest) {
        let mut t = self.lock();
        t.done.remove(&req.req_id);
        t.done_order.retain(|r| r != &req.req_id);
        t.open.insert(req.req_id.clone(), req);
    }

    /// The run ended or the provider cancelled the ask: later answers see `Unknown`, not `AlreadyResolved`.
    pub fn cancel(&self, req_id: &str) {
        self.lock().open.remove(req_id);
    }

    /// Claims the request for `origin`. Does not execute anything; the caller applies the decision after an `Ok`.
    /// Checks, in this order: known, same run, kind, remote-only gates (eligibility, intent hash, expiry), then the swap.
    pub fn resolve(&self, req_id: &str, agent_id: &str, kind: PendingKind, intent_hash: Option<&str>, origin: &Origin, now_ms: u64) -> Result<PendingRequest, HubError> {
        let mut t = self.lock();
        let Some(req) = t.open.get(req_id) else {
            if let Some(by) = t.done.get(req_id) {
                return Err(HubError::AlreadyResolved { by: by.clone() });
            }
            return Err(if t.expired.contains_key(req_id) { HubError::Expired } else { HubError::Unknown });
        };
        if req.agent_id != agent_id {
            return Err(HubError::WrongRun);
        }
        if req.kind != kind {
            return Err(HubError::WrongKind(match req.kind {
                PendingKind::Permission => "permission request",
                PendingKind::Question => "question",
            }));
        }
        if matches!(origin, Origin::Remote { .. }) {
            if req.eligibility == Eligibility::DesktopOnly {
                return Err(HubError::DesktopOnly);
            }
            if intent_hash != Some(req.intent_hash.as_str()) {
                return Err(HubError::IntentMismatch);
            }
            if now_ms >= req.expires_at {
                t.open.remove(req_id);
                t.expired.insert(req_id.to_string(), ());
                return Err(HubError::Expired);
            }
        }
        let req = t.open.remove(req_id).expect("checked above");
        t.done.insert(req_id.to_string(), origin.clone());
        t.done_order.push_back(req_id.to_string());
        while t.done_order.len() > DONE_KEEP {
            if let Some(old) = t.done_order.pop_front() {
                t.done.remove(&old);
            }
        }
        Ok(req)
    }
}
