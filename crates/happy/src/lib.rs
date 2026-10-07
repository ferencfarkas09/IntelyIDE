//! Tauri-free backend of the `happy` module: the integrations framework (HTTP client with allow-lists and redaction,
//! focus-gated scheduler, provider state machine) plus the Time Tracer, Meet and Team chat providers and the shared realtime (Socket.IO) connection. Types that cross the IPC
//! boundary live in `types` and are exported to `ui/src/bindings/happy.ts` by `pnpm bindings`.

pub mod cache;
pub mod chat;
pub mod chat_api;
pub mod chat_hub;
pub mod external;
pub mod hub;
pub mod net;
pub mod notifications;
pub mod parse;
pub mod redact;
pub mod sched;
pub mod socket;
pub mod tasks;
pub mod time;
pub mod types;

pub use hub::{Hub, Opener, Sink};
pub use net::{ApiError, Kind};
pub use socket::Timing;
