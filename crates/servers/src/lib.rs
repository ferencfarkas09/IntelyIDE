//! Remote servers: run agents on machines reached with the system `ssh` binary.
//!
//! The crate is Tauri-free and has no async runtime: every remote call is one `ssh` child with a wall-clock timeout.
//! The IDE never handles secrets. Keys, agent and `ProxyJump` come from the user's `~/.ssh/config`, `BatchMode=yes`
//! forbids prompts, and an unknown host key is an error with a hint, never auto-accepted.
//!
//! Every value that ends up in a remote script goes through [`sh_quote`] or [`sh_quote_path_for_remote`], and every
//! config value is checked by [`ServerCfg::validate`] first.

pub mod cfg;
pub mod probe;
pub mod quote;
pub mod repos;
pub mod setup;
pub mod shim;
pub mod ssh;
#[cfg(test)]
mod testkit;

pub use cfg::{slug_from_name, CfgError, ServerCfg};
pub use probe::{
    parse_probe, probe, probe_script, status_from_facts, ProbeFacts, ServerStatus, StatusError,
};
pub use quote::{sh_quote, sh_quote_path_for_remote};
pub use repos::{clone_repo, repo_states, validate_git_url, RepoState};
pub use setup::{
    node_pin_for, setup, NodePin, SetupError, SetupEvent, SetupOptions, SetupStep, StepState,
};
pub use shim::{remote_paths, remove_shim, sidecar_command, upload_shim, RemotePaths};
pub use ssh::{classify, ExecOut, Ssh, SshError, SshErrorKind};
