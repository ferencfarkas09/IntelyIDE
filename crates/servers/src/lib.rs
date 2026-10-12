//! Remote servers: run agents on machines reached with the system `ssh` binary.
//!
//! The crate is Tauri-free and has no async runtime: every remote call is one `ssh` child with a wall-clock timeout.
//! The IDE never handles secrets. Keys, agent and `ProxyJump` come from the user's `~/.ssh/config`, `BatchMode=yes`
//! forbids prompts, and an unknown host key is an error with a hint, never auto-accepted.
//!
//! Every value that ends up in a remote script goes through [`sh_quote`] or [`sh_quote_path_for_remote`], and every
//! config value is checked by [`ServerCfg::validate`] first.

pub mod cfg;
pub mod paths;
pub mod probe;
pub mod quote;
pub mod repos;
pub mod setup;
pub mod shim;
pub mod ssh;
#[cfg(all(test, unix))]
mod testkit;

pub use cfg::{canonical_path, forbidden_repo_dir, slug_from_name, valid_repo_dir_name, CfgError, ServerCfg};
pub use probe::{
    parse_probe, probe, probe_script, status_from_facts, ProbeFacts, ServerStatus, StatusError,
};
pub use quote::{sh_quote, sh_quote_path_for_remote};
pub use paths::{candidates_for, default_path, equal_or_nested, expand_home, find_repos, repo_key, resolve_repo_path, FoundRepo, ResolvedPath, Wanted};
pub use repos::{clone_repo, clone_repo_at, repo_states, repo_states_at, same_origin, validate_git_url, RepoSpec, RepoState};
pub use setup::{
    node_pin_for, setup, NodePin, SetupError, SetupEvent, SetupOptions, SetupStep, StepState,
};
pub use shim::{remote_paths, remove_shim, sidecar_command, upload_shim, RemotePaths};
pub use ssh::{classify, default_control_dirs, private_control_dir, ExecOut, Ssh, SshError, SshErrorKind};
