//! The one-time plan nonce of the destructive relay operations (deploy, rollback, remove).
//!
//! Before any of them runs, the Rust side issues a plan: the exact wrangler argv, the working directory, the Worker name and a random
//! nonce that only this process holds, with a short expiry. The operation itself must present that nonce and the typed Worker name,
//! and runs only when both fit the plan that is still held; the plan is spent by that run. So a call that skipped the plan, replayed a
//! spent or expired one, or typed another name changes nothing, and the UI shows exactly the command the plan holds.
//!
//! This is a server-side gate, not a human check: a webview that is already compromised can ask for a plan and redeem it in one go.
//! The check against that is a native confirmation from Rust (decision D19, not in v1); see docs/safety.md.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

use crate::deployer::{lock, random_hex, AuthCtx};
use crate::error::{DeployError, Result};

/// A plan is good for five minutes: long enough to read the review and type the name, short enough that a stale plan is not kept.
pub const PLAN_TTL_SECS: u64 = 5 * 60;
/// Typing the name wrong this many times spends the plan; the user asks for a new one.
pub const MAX_WRONG_NAMES: u8 = 3;
/// Plans held at once; the oldest is dropped when a new one would exceed this.
const MAX_LIVE: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanOp {
    Deploy,
    Rollback,
    Remove,
}

impl PlanOp {
    pub fn name(self) -> &'static str {
        match self {
            PlanOp::Deploy => "deploy",
            PlanOp::Rollback => "rollback",
            PlanOp::Remove => "remove",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "deploy" => PlanOp::Deploy,
            "rollback" => PlanOp::Rollback,
            "remove" => PlanOp::Remove,
            _ => return None,
        })
    }
}

/// What a plan is asked for. The Worker name of a rollback or remove comes from the recorded profile, never from the webview.
#[derive(Debug, Clone)]
pub enum PlanRequest {
    Deploy { preview_id: String },
    Rollback { worker: String, auth: AuthCtx },
    Remove { worker: String, auth: AuthCtx, force: bool },
}

/// What the UI shows and what the operation is held to. `plan_id` is the nonce.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub plan_id: String,
    pub op: PlanOp,
    pub worker_name: String,
    pub account_id_tail: String,
    pub argv: Vec<String>,
    pub command_line: String,
    pub cwd: String,
    pub env_names: Vec<String>,
    pub expires_at: u64,
}

struct Held {
    plan: Plan,
    /// The preview a deploy plan belongs to, and the binding hash that preview had when the plan was issued.
    bound_preview: Option<(String, String)>,
    wrong_names: u8,
}

#[derive(Default)]
pub struct PlanStore {
    held: Mutex<HashMap<String, Held>>,
}

fn stale() -> DeployError {
    DeployError::coded("previewStale", "the review is no longer valid: review again")
}

impl PlanStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Holds a new plan and returns it (with its nonce). `bound_preview` is `(previewId, binding)` for a deploy plan.
    pub fn issue(&self, now: u64, mut plan: Plan, bound_preview: Option<(String, String)>) -> Result<Plan> {
        plan.plan_id = random_hex(16)?;
        plan.expires_at = now + PLAN_TTL_SECS;
        let mut m = lock(&self.held);
        m.retain(|_, h| h.plan.expires_at > now);
        while m.len() >= MAX_LIVE {
            let Some(oldest) = m.iter().min_by_key(|(_, h)| h.plan.expires_at).map(|(k, _)| k.clone()) else { break };
            m.remove(&oldest);
        }
        m.insert(plan.plan_id.clone(), Held { plan: plan.clone(), bound_preview, wrong_names: 0 });
        Ok(plan)
    }

    /// Checks `nonce` and the typed name against the plan still held and spends the plan. Fails closed with `previewStale` for an
    /// unknown, spent, expired, other-operation or other-preview nonce (the plan is dropped when it was presented for the wrong
    /// operation or preview), and with `confirmMismatch` for a wrong name (a wrong name does not spend the plan until the third try).
    /// `preview` is `(previewId, binding)` the caller sees now (deploy only).
    pub fn redeem(&self, now: u64, nonce: &str, op: PlanOp, typed_name: &str, preview: Option<(&str, &str)>) -> Result<Plan> {
        let mut m = lock(&self.held);
        m.retain(|_, h| h.plan.expires_at > now);
        let Some(h) = m.get_mut(nonce) else { return Err(stale()) };
        if h.plan.op != op {
            m.remove(nonce);
            return Err(stale());
        }
        let fits = match (&h.bound_preview, preview) {
            (None, None) => true,
            (Some((id, binding)), Some((pid, pbinding))) => id == pid && binding == pbinding,
            _ => false,
        };
        if !fits {
            m.remove(nonce);
            return Err(stale());
        }
        if typed_name != h.plan.worker_name {
            h.wrong_names += 1;
            if h.wrong_names >= MAX_WRONG_NAMES {
                m.remove(nonce);
            }
            return Err(DeployError::coded("confirmMismatch", "the typed Worker name does not match"));
        }
        m.remove(nonce).map(|h| h.plan).ok_or_else(stale)
    }

    /// Drops every plan of a Worker (a new preview or a finished removal makes them meaningless).
    pub fn forget_worker(&self, worker: &str) {
        lock(&self.held).retain(|_, h| h.plan.worker_name != worker);
    }

    pub fn live(&self, now: u64) -> usize {
        lock(&self.held).values().filter(|h| h.plan.expires_at > now).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(op: PlanOp) -> Plan {
        Plan {
            plan_id: String::new(),
            op,
            worker_name: "intely-relay-0123456789ab".into(),
            account_id_tail: "cdef".into(),
            argv: vec!["/x/wrangler".into(), "delete".into()],
            command_line: "/x/wrangler delete".into(),
            cwd: "/x".into(),
            env_names: vec![],
            expires_at: 0,
        }
    }

    const NAME: &str = "intely-relay-0123456789ab";

    #[test]
    fn a_plan_is_spent_by_its_one_run_and_a_replay_fails_closed() {
        let s = PlanStore::new();
        let p = s.issue(100, plan(PlanOp::Remove), None).unwrap();
        assert_eq!(p.plan_id.len(), 32);
        assert_eq!(p.expires_at, 100 + PLAN_TTL_SECS);
        assert_eq!(s.redeem(101, &p.plan_id, PlanOp::Remove, NAME, None).unwrap().argv, p.argv);
        assert_eq!(s.redeem(102, &p.plan_id, PlanOp::Remove, NAME, None).unwrap_err().code(), "previewStale");
        assert_eq!(s.live(102), 0);
    }

    #[test]
    fn an_expired_plan_is_refused_and_dropped() {
        let s = PlanStore::new();
        let p = s.issue(100, plan(PlanOp::Remove), None).unwrap();
        assert_eq!(s.redeem(100 + PLAN_TTL_SECS, &p.plan_id, PlanOp::Remove, NAME, None).unwrap_err().code(), "previewStale");
        assert_eq!(s.redeem(100 + PLAN_TTL_SECS - 1, &p.plan_id, PlanOp::Remove, NAME, None).unwrap_err().code(), "previewStale", "dropped for good");
    }

    #[test]
    fn a_missing_or_made_up_nonce_is_refused() {
        let s = PlanStore::new();
        let _ = s.issue(100, plan(PlanOp::Remove), None).unwrap();
        for n in ["", "0", &"0".repeat(32)] {
            assert_eq!(s.redeem(101, n, PlanOp::Remove, NAME, None).unwrap_err().code(), "previewStale");
        }
    }

    #[test]
    fn a_wrong_name_is_refused_and_the_third_one_spends_the_plan() {
        let s = PlanStore::new();
        let p = s.issue(100, plan(PlanOp::Remove), None).unwrap();
        for bad in ["", "other", "INTELY-RELAY-0123456789AB"] {
            assert_eq!(s.redeem(101, &p.plan_id, PlanOp::Remove, bad, None).unwrap_err().code(), "confirmMismatch");
        }
        assert_eq!(s.redeem(101, &p.plan_id, PlanOp::Remove, NAME, None).unwrap_err().code(), "previewStale", "three wrong names spent it");
        let q = s.issue(102, plan(PlanOp::Remove), None).unwrap();
        assert_eq!(s.redeem(103, &q.plan_id, PlanOp::Remove, "x", None).unwrap_err().code(), "confirmMismatch");
        assert!(s.redeem(103, &q.plan_id, PlanOp::Remove, NAME, None).is_ok(), "a typo does not burn the plan");
    }

    #[test]
    fn a_plan_of_one_operation_cannot_run_another() {
        let s = PlanStore::new();
        let p = s.issue(100, plan(PlanOp::Rollback), None).unwrap();
        assert_eq!(s.redeem(101, &p.plan_id, PlanOp::Remove, NAME, None).unwrap_err().code(), "previewStale");
        assert_eq!(s.redeem(101, &p.plan_id, PlanOp::Rollback, NAME, None).unwrap_err().code(), "previewStale", "and it was dropped by the attempt");
    }

    #[test]
    fn a_deploy_plan_is_bound_to_its_preview_and_binding() {
        let s = PlanStore::new();
        let bound = Some(("pv1".to_owned(), "bind1".to_owned()));
        let p = s.issue(100, plan(PlanOp::Deploy), bound.clone()).unwrap();
        assert_eq!(s.redeem(101, &p.plan_id, PlanOp::Deploy, NAME, Some(("pv2", "bind1"))).unwrap_err().code(), "previewStale");
        let p = s.issue(100, plan(PlanOp::Deploy), bound.clone()).unwrap();
        assert_eq!(s.redeem(101, &p.plan_id, PlanOp::Deploy, NAME, Some(("pv1", "changed"))).unwrap_err().code(), "previewStale");
        let p = s.issue(100, plan(PlanOp::Deploy), bound.clone()).unwrap();
        assert_eq!(s.redeem(101, &p.plan_id, PlanOp::Deploy, NAME, None).unwrap_err().code(), "previewStale");
        let p = s.issue(100, plan(PlanOp::Deploy), bound).unwrap();
        assert!(s.redeem(101, &p.plan_id, PlanOp::Deploy, NAME, Some(("pv1", "bind1"))).is_ok());
    }

    #[test]
    fn nonces_are_random_and_the_store_is_bounded() {
        let s = PlanStore::new();
        let mut ids = std::collections::HashSet::new();
        for i in 0..40u64 {
            ids.insert(s.issue(100 + i, plan(PlanOp::Remove), None).unwrap().plan_id);
        }
        assert_eq!(ids.len(), 40);
        assert!(s.live(140) <= MAX_LIVE);
    }

    #[test]
    fn forgetting_a_worker_drops_its_plans() {
        let s = PlanStore::new();
        let p = s.issue(100, plan(PlanOp::Remove), None).unwrap();
        s.forget_worker(NAME);
        assert_eq!(s.redeem(101, &p.plan_id, PlanOp::Remove, NAME, None).unwrap_err().code(), "previewStale");
    }
}
