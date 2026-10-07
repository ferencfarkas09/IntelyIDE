//! Tauri-free engine of the agent-UX extras (Wave 4): session search over the run logs (`index`, `doc`), the night
//! queue state machine (`night`) and the Morning brief (`brief`). A read-only consumer of the JSONL event log: it never
//! changes the event schema and never writes into a repository. Glue: `src-tauri/src/modules/agentux.rs`.

pub mod brief;
pub mod doc;
pub mod index;
pub mod night;

pub use brief::{build as build_brief, Brief, DiffSource, GitDiff};
pub use doc::{extract, parse_log, scrub, RunDoc};
pub use index::{Facets, Hit, Index, Query, RefreshStats, SearchResult, Snippet};
pub use night::{Effect, ItemState, NewItem, NightItem, NightPlan, Observation, Paused, Phase, RunObs, MAX_RUNS_PER_NIGHT};
