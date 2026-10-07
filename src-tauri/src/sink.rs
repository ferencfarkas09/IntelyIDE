use intely_core::{EnvStatus, EventSink, OpEvent, OpResult, RepoSnapshot};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Forwards engine events to the webview as Tauri events (contract section 5).
pub struct TauriSink {
    app: AppHandle,
}

impl TauriSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        if let Err(e) = self.app.emit(event, payload) {
            eprintln!("emit {event} failed: {e}");
        }
    }
}

impl EventSink for TauriSink {
    fn snapshot(&self, s: RepoSnapshot) {
        self.emit("repo:snapshot", s);
    }

    fn op_event(&self, e: OpEvent) {
        self.emit("op:event", e);
    }

    fn op_result(&self, r: OpResult) {
        self.emit("op:result", r);
    }

    fn env(&self, e: EnvStatus) {
        self.emit("engine:env", e);
    }
}
