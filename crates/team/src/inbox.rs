//! When to acknowledge a queued relay frame. The relay deletes every queued frame up to the acknowledged id, so a frame may only be
//! acknowledged after the handler applied and saved it, and never after a failed one (its successors then wait too). A frame that
//! keeps failing is given up after [`MAX_ATTEMPTS`] deliveries so it cannot block the queue forever; the caller surfaces that.

use std::collections::HashMap;

pub const MAX_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Nothing to acknowledge (a live frame, or an earlier one is still waiting).
    NoAck,
    Ack(u64),
    /// Acknowledge it anyway, and tell the person the frame was dropped.
    GaveUp(u64),
}

#[derive(Debug, Default)]
pub struct AckGate {
    attempts: HashMap<u64, u32>,
    blocked: bool,
}

impl AckGate {
    /// A new socket: the relay redelivers everything unacknowledged, in order.
    pub fn new_connection(&mut self) {
        self.blocked = false;
    }

    pub fn handled(&mut self, qid: Option<u64>, ok: bool) -> Verdict {
        let Some(qid) = qid else { return Verdict::NoAck };
        if ok {
            self.attempts.remove(&qid);
            return if self.blocked { Verdict::NoAck } else { Verdict::Ack(qid) };
        }
        let n = self.attempts.entry(qid).or_insert(0);
        *n += 1;
        if *n >= MAX_ATTEMPTS && !self.blocked {
            self.attempts.remove(&qid);
            return Verdict::GaveUp(qid);
        }
        self.blocked = true;
        Verdict::NoAck
    }
}
