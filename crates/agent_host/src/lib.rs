//! Tauri-free agent host (providers-plan 5.2, 5.10): the lazily spawned Node sidecar, the NDJSON loop, policy
//! routing, leases and cancel through `intely-agent-gate`, the JSONL event log, Rewind snapshots and the per-run
//! git shim. `src-tauri` wraps it in commands and a sink that forwards events to the webview.

pub mod config;
pub mod host;
pub mod remote;
pub mod roles;
pub mod run;
pub mod sidecar;

pub use config::{scrub_env, AcpMock, AgentDefaults, DefaultsSupplier, UserMemorySupplier, EnvSupplier, HostConfig, LaunchSupplier, PolicyFault, ProviderLaunch, RoleResolver, VersionSupplier};
pub use host::{repo_files, AgentHost, AnswerExtra, HostSink, SetModeOpts, StartOptions, NO_SAFETY_NET};
pub use host::{ProbeReport, PROBE_ROLE};
pub use remote::{NotReady, ServerRegistry, ServersSupplier};
pub use run::{RemoteDirs, RepoRef};
