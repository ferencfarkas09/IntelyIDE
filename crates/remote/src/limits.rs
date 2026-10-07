//! Rate limits, approval-fatigue limits and the per-device re-auth window (remote-plan 4.2, 4.4). All counters are in memory and
//! exist only while the gateway runs; time comes from the injected clock.

use std::collections::{HashMap, VecDeque};

use crate::devices::Device;
use crate::wire::Capability;

pub const PROMPTS_PER_MIN: usize = 10;
pub const ANSWERS_PER_MIN: usize = 30;
pub const STARTS_PER_HOUR: usize = 3;
pub const PENDING_PER_RUN: usize = 5;
pub const PENDING_PER_DEVICE: usize = 8;
/// After this many approvals in the window, every further approval needs step-up for [`FATIGUE_LOCK_MS`].
pub const APPROVALS_IN_WINDOW: usize = 10;
pub const APPROVAL_WINDOW_MS: u64 = 10 * 60_000;
pub const CONSECUTIVE_TAPS: usize = 5;
pub const CONSECUTIVE_WINDOW_MS: u64 = 60_000;
pub const FATIGUE_LOCK_MS: u64 = 15 * 60_000;
/// This many rate-limit hits within a minute demote the device to view-only.
pub const ANOMALY_STRIKES: usize = 5;
pub const OPID_MEMORY: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Bucket {
    Prompt,
    Answer,
    Start,
}

impl Bucket {
    fn limit(self) -> (usize, u64) {
        match self {
            Bucket::Prompt => (PROMPTS_PER_MIN, 60_000),
            Bucket::Answer => (ANSWERS_PER_MIN, 60_000),
            Bucket::Start => (STARTS_PER_HOUR, 3_600_000),
        }
    }
}

#[derive(Default)]
pub struct DeviceLimits {
    windows: HashMap<Bucket, VecDeque<u64>>,
    approvals: VecDeque<u64>,
    taps: VecDeque<u64>,
    step_up_until: u64,
    strikes: VecDeque<u64>,
    ops: VecDeque<(String, Vec<u8>)>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RateVerdict {
    Ok,
    Limited,
    /// Limited too often: demote the device and tell the Mac.
    Anomaly,
}

impl DeviceLimits {
    pub fn check(&mut self, bucket: Bucket, now: u64) -> RateVerdict {
        let (max, span) = bucket.limit();
        let w = self.windows.entry(bucket).or_default();
        while w.front().is_some_and(|t| now.saturating_sub(*t) >= span) {
            w.pop_front();
        }
        if w.len() < max {
            w.push_back(now);
            return RateVerdict::Ok;
        }
        self.strikes.push_back(now);
        while self.strikes.front().is_some_and(|t| now.saturating_sub(*t) >= 60_000) {
            self.strikes.pop_front();
        }
        if self.strikes.len() >= ANOMALY_STRIKES {
            RateVerdict::Anomaly
        } else {
            RateVerdict::Limited
        }
    }

    /// Records an approval; may switch step-up on for 15 minutes.
    pub fn approved(&mut self, now: u64) {
        self.approvals.push_back(now);
        self.taps.push_back(now);
        while self.approvals.front().is_some_and(|t| now.saturating_sub(*t) >= APPROVAL_WINDOW_MS) {
            self.approvals.pop_front();
        }
        while self.taps.front().is_some_and(|t| now.saturating_sub(*t) >= CONSECUTIVE_WINDOW_MS) {
            self.taps.pop_front();
        }
        if self.approvals.len() >= APPROVALS_IN_WINDOW || self.taps.len() >= CONSECUTIVE_TAPS {
            self.step_up_until = now + FATIGUE_LOCK_MS;
        }
    }

    /// A deny breaks a run of consecutive "Allow" taps.
    pub fn denied(&mut self) {
        self.taps.clear();
    }

    pub fn step_up_forced(&self, now: u64) -> bool {
        now < self.step_up_until
    }

    /// Idempotency: the cached reply of an `opId` seen before.
    pub fn seen_op(&self, op: &str) -> Option<&Vec<u8>> {
        self.ops.iter().find(|(o, _)| o == op).map(|(_, r)| r)
    }

    pub fn remember_op(&mut self, op: &str, reply: Vec<u8>) {
        self.ops.push_back((op.to_string(), reply));
        while self.ops.len() > OPID_MEMORY {
            self.ops.pop_front();
        }
    }
}

/// The capability a device really has right now: `reply` only inside the re-auth window.
pub fn effective_capability(d: &Device, now: u64, reauth_hours: u64) -> Capability {
    if d.capability == Capability::Reply && now.saturating_sub(d.last_reauth_at) > reauth_hours.clamp(1, 72) * 3_600_000 {
        Capability::View
    } else {
        d.capability
    }
}
