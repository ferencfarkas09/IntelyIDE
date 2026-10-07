//! IntelyIDE relay deploy ((design notes: remote-cloudflare-spec) 4.1, 4.3, 4.4): finds the relay kit, builds and runs the pinned wrangler
//! against the user's own Cloudflare account, parses its output and orchestrates the deploy pipeline. Tauri-free;
//! `cargo test -p intely-relay-deploy`.
//!
//! Zero cost when off: no thread, socket, timer or process exists here between operations, and nothing is spawned unless a Tauri
//! command (the only place a [`LiveGesture`] can be minted) asks for it. Every test uses [`ScriptedSpawner`] or a fake wrangler script
//! in a temp kit and a fake `Http`; none reaches a real Cloudflare account.
//!
//! | module | contents |
//! |---|---|
//! | `kit` | kit discovery, wrangler pin, source snapshot, JSONC reader |
//! | `config` | generated `wrangler.jsonc` from an allow-list, Worker name rules |
//! | `wrangler` | invocation builders, child environment, process runner, scripted spawner |
//! | `output` | whoami / deploy-output parsers, target acceptance, error classifier, name check |
//! | `mask` | the output masker |
//! | `gate` | the jail table of spec 4.9 |
//! | `keys` | Keychain items, durable-store rule, `seq` |
//! | `runner` | single-operation guard, stop flag, log ring |
//! | `deployer`, `pipeline` | the operations and the deploy job |
//! | `ops_log`, `limits` | `ops.jsonl` debug log; the costs and limits notice |
//! | `plan` | the one-time plan nonce every deploy, rollback and remove must present |
//! | `cloud_audit` | `cloud-audit.jsonl`, the standalone hash-chained record of the cloud operations |

pub mod clock;
pub mod cloud_audit;
pub mod config;
pub mod deployer;
pub mod error;
pub mod gate;
pub mod keys;
pub mod kit;
pub mod limits;
pub mod mask;
pub mod ops_log;
pub mod output;
pub mod pipeline;
pub mod plan;
pub mod runner;
pub mod wrangler;

pub use clock::{Clock, SystemClock};
pub use cloud_audit::{AuditEntry, AuditRecord, CloudAudit};
pub use deployer::{AuthCtx, AuthMode, Deployer, Deps, JobEvent, Step, StepEvent, StepStatus, STEPS};
pub use error::{DeployError, Result};
pub use intely_relay_bundle::{Http, Secret, StagedBundle};
pub use kit::{tool_path, which_in, KitReport, RelayKit};
pub use limits::LimitsNotice;
pub use mask::Masker;
pub use pipeline::{DeployPreview, DeployRecord, DeployRequest, JobState, PreviewRequest};
pub use plan::{Plan, PlanOp, PlanRequest, PlanStore};
pub use runner::{LogChunk, OpRunner};
pub use wrangler::{EnvVal, Invocation, Line, LiveGesture, Op, Outcome, ProcessSpawner, Reply, ScriptedSpawner, Spawner};
