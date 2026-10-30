//! Tauri-free engine of the agent-UX extras (Wave 4): session search over the run logs (`index`, `doc`), the night
//! queue state machine (`night`), the Morning brief (`brief`) and the per-run summary (`digest`). A read-only consumer of the JSONL event log: it never
//! changes the event schema and never writes into a repository. Glue: `src-tauri/src/modules/agentux.rs`.

pub mod brief;
pub mod digest;
pub mod doc;
pub mod index;
pub mod night;
pub mod usage;

pub use brief::{build as build_brief, Brief, DiffSource, GitDiff};
pub use digest::{load_or_build as load_or_build_digest, RunDigest};
pub use doc::{extract, parse_log, scrub, RunDoc};
pub use index::{Facets, Hit, Index, Query, RefreshStats, SearchResult, Snippet};
pub use usage::{rows_of, DayUsage, ModelUsage, Totals as UsageTotals, UsageIndex, UsageReport, UsageRow};
pub use night::{Effect, ItemState, NewItem, NightItem, NightPlan, Observation, Paused, Phase, RunObs, MAX_RUNS_PER_NIGHT};
