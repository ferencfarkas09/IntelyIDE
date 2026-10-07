//! `EventBus` (providers-plan 5.10, remote-plan R2): the one place an event is made visible. An event is appended to the
//! durable [`EventLog`] first and published second, so a subscriber never sees an event the log does not hold (a crash
//! between the two steps leaves the log ahead, never behind). A subscriber that falls behind gets `Lagged` and
//! re-syncs from the log. With no subscriber a publish is one failed `send` on an empty channel: zero cost when Remote is off.

use std::sync::Arc;

use tokio::sync::broadcast;

use crate::events::{AgentEvent, EventLog, LogError};

/// Receivers lag after this many unread events (the log still has them).
pub const BUS_CAPACITY: usize = 1024;

pub type BusReceiver = broadcast::Receiver<Arc<AgentEvent>>;
pub use broadcast::error::{RecvError, TryRecvError};

#[derive(Clone)]
pub struct EventBus {
    log: Arc<dyn EventLog>,
    tx: broadcast::Sender<Arc<AgentEvent>>,
}

impl EventBus {
    pub fn new(log: Arc<dyn EventLog>) -> Self {
        Self::with_capacity(log, BUS_CAPACITY)
    }

    pub fn with_capacity(log: Arc<dyn EventLog>, capacity: usize) -> Self {
        Self { log, tx: broadcast::channel(capacity.max(1)).0 }
    }

    /// Appends, then publishes. When the append fails nothing is published and the error is returned.
    pub fn publish(&self, event: &AgentEvent) -> Result<(), LogError> {
        self.log.append(event)?;
        // `Err` only means "no receiver": that is the zero-cost case, not a failure.
        let _ = self.tx.send(Arc::new(event.clone()));
        Ok(())
    }

    pub fn subscribe(&self) -> BusReceiver {
        self.tx.subscribe()
    }

    pub fn receiver_count(&self) -> usize {
        self.tx.receiver_count()
    }

    pub fn log(&self) -> &Arc<dyn EventLog> {
        &self.log
    }
}
