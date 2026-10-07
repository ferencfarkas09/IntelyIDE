//! One file per feature module; each owner edits only their own file (see (design notes: alpha-contract), Ownership).

pub mod agentux;
pub mod attachments;
pub mod checks;
pub mod contract;
pub mod files;
pub mod graph;
pub mod gitx;
pub mod happy;
pub mod happy_chat;
pub mod happy_inbox;
pub mod hud;
pub mod l10n;
pub mod mcp;
#[cfg(feature = "mongo-studio")]
pub mod mongo;
#[cfg(test)]
mod mongo_lean;
pub mod picker;
pub mod preview;
pub mod providers;
pub mod relay_cloud;
pub mod remote;
pub mod roles;
pub mod runner;
pub mod settings;
pub mod switchhook;
pub mod term;
pub mod tray;
pub mod updates;
pub mod viewers;
pub mod workspaces;
pub mod workspaces_switch;
