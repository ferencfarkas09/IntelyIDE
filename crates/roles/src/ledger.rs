//! The usage ledger: tokens and cost estimates per run, from the `usage` events (`modelUsage` of the Agent SDK).
//!
//! Only the `cumulative` counts are used, never a sum of `perTurn`: a resumed session's first result already carries
//! the totals its transcript saved, so adding per-turn numbers would count the earlier turns again. A run keeps the
//! latest cumulative; when it goes backwards (a session that restarted from zero) the old segment is settled and a
//! new one starts. A forked or adopted session starts from the total of the transcript it continues, which is
//! subtracted (`baseline`), so the parent's spend stays with the parent.

use std::collections::BTreeMap;
use std::path::PathBuf;

use intely_agent_core::usage::{TokenCounts, UsageRecord};
use serde::{Deserialize, Serialize};

use crate::types::{RunUsage, UsageSummary, UsageTotals};

fn totals(t: &TokenCounts) -> UsageTotals {
    UsageTotals {
        input_tokens: f64::from(t.input_tokens),
        output_tokens: f64::from(t.output_tokens),
        cache_read: f64::from(t.cache_read),
        cache_write: f64::from(t.cache_write),
        reasoning_tokens: f64::from(t.reasoning_tokens),
        cost_usd: t.cost_usd.unwrap_or(0.0),
    }
}

impl UsageTotals {
    fn plus(&self, o: &Self) -> Self {
        Self {
            input_tokens: self.input_tokens + o.input_tokens,
            output_tokens: self.output_tokens + o.output_tokens,
            cache_read: self.cache_read + o.cache_read,
            cache_write: self.cache_write + o.cache_write,
            reasoning_tokens: self.reasoning_tokens + o.reasoning_tokens,
            cost_usd: self.cost_usd + o.cost_usd,
        }
    }

    fn minus(&self, o: &Self) -> Self {
        let d = |a: f64, b: f64| (a - b).max(0.0);
        Self {
            input_tokens: d(self.input_tokens, o.input_tokens),
            output_tokens: d(self.output_tokens, o.output_tokens),
            cache_read: d(self.cache_read, o.cache_read),
            cache_write: d(self.cache_write, o.cache_write),
            reasoning_tokens: d(self.reasoning_tokens, o.reasoning_tokens),
            cost_usd: d(self.cost_usd, o.cost_usd),
        }
    }

    fn weight(&self) -> f64 {
        self.cost_usd * 1e6 + self.input_tokens + self.output_tokens + self.cache_read + self.cache_write
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    model: String,
    settled: UsageTotals,
    current: UsageTotals,
    baseline: UsageTotals,
    /// The baseline is taken from the first usage event instead of a known parent total.
    pending_baseline: bool,
    baseline_estimated: bool,
    updated_at: u64,
}

impl Entry {
    fn total(&self) -> UsageTotals {
        self.settled.plus(&self.current).minus(&self.baseline)
    }
}

#[derive(Default)]
pub struct Ledger {
    path: Option<PathBuf>,
    entries: BTreeMap<String, Entry>,
}

impl Ledger {
    pub fn in_memory() -> Self {
        Self::default()
    }

    pub fn open(path: PathBuf) -> Self {
        let entries = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { path: Some(path), entries }
    }

    /// The run continues an existing transcript: `parent` is that transcript's total when it is a run we know.
    pub fn continues(&mut self, agent_id: &str, parent: Option<UsageTotals>) {
        let entry = Entry { pending_baseline: parent.is_none(), baseline: parent.unwrap_or_default(), ..Entry::default() };
        self.entries.entry(agent_id.to_string()).or_insert(entry);
        self.save();
    }

    pub fn record(&mut self, agent_id: &str, usage: &UsageRecord, now_ms: u64) {
        let cumulative = totals(&usage.cumulative);
        let e = self.entries.entry(agent_id.to_string()).or_default();
        if e.pending_baseline {
            e.baseline = cumulative.minus(&totals(&usage.per_turn));
            e.pending_baseline = false;
            e.baseline_estimated = true;
        }
        if cumulative.weight() < e.current.weight() {
            e.settled = e.settled.plus(&e.current);
        }
        e.current = cumulative;
        e.model = usage.model.clone();
        e.updated_at = now_ms;
        self.save();
    }

    pub fn total_of(&self, agent_id: &str) -> Option<UsageTotals> {
        self.entries.get(agent_id).map(Entry::total)
    }

    pub fn summary(&self) -> UsageSummary {
        let mut runs: Vec<RunUsage> = self
            .entries
            .iter()
            .map(|(id, e)| RunUsage { agent_id: id.clone(), model: e.model.clone(), totals: e.total(), baseline_estimated: e.baseline_estimated, updated_at: e.updated_at as f64 })
            .collect();
        runs.sort_by(|a, b| b.updated_at.total_cmp(&a.updated_at).then_with(|| a.agent_id.cmp(&b.agent_id)));
        let total = runs.iter().fold(UsageTotals::default(), |acc, r| acc.plus(&r.totals));
        UsageSummary { runs, total }
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        let write = || -> std::io::Result<()> {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_vec_pretty(&self.entries).map_err(std::io::Error::other)?)?;
            std::fs::rename(&tmp, path)
        };
        if let Err(e) = write() {
            eprintln!("usage ledger: cannot write {}: {e}", path.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use intely_agent_core::usage::CostBasis;

    use super::*;

    fn counts(input: u32, output: u32, cost: f64) -> TokenCounts {
        TokenCounts { input_tokens: input, output_tokens: output, cache_read: 0, cache_write: 0, reasoning_tokens: 0, cost_usd: Some(cost) }
    }

    fn usage(per_turn: TokenCounts, cumulative: TokenCounts) -> UsageRecord {
        UsageRecord { model: "m".into(), cost_basis: CostBasis::Estimated, per_turn, cumulative, premium_requests: None, context_used: None, context_size: None, per_model: Vec::new() }
    }

    #[test]
    fn a_run_is_its_latest_cumulative_not_a_sum_of_turns() {
        let mut l = Ledger::in_memory();
        l.record("a", &usage(counts(100, 10, 0.01), counts(100, 10, 0.01)), 1);
        l.record("a", &usage(counts(50, 5, 0.005), counts(150, 15, 0.015)), 2);
        let t = l.total_of("a").unwrap();
        assert_eq!((t.input_tokens, t.output_tokens), (150.0, 15.0));
        assert!((t.cost_usd - 0.015).abs() < 1e-9);
    }

    #[test]
    fn resuming_does_not_count_the_earlier_turns_again() {
        let mut l = Ledger::in_memory();
        l.record("a", &usage(counts(100, 10, 0.01), counts(100, 10, 0.01)), 1);
        // after a resume the SDK's first result carries the saved total (the sidecar then reports it as the turn too)
        l.record("a", &usage(counts(130, 14, 0.013), counts(130, 14, 0.013)), 2);
        assert_eq!(l.total_of("a").unwrap().input_tokens, 130.0);
    }

    #[test]
    fn a_session_that_restarted_from_zero_keeps_its_earlier_segment() {
        let mut l = Ledger::in_memory();
        l.record("a", &usage(counts(100, 10, 0.01), counts(100, 10, 0.01)), 1);
        l.record("a", &usage(counts(20, 2, 0.002), counts(20, 2, 0.002)), 2);
        let t = l.total_of("a").unwrap();
        assert_eq!(t.input_tokens, 120.0);
        assert!((t.cost_usd - 0.012).abs() < 1e-9);
    }

    #[test]
    fn a_fork_pays_only_for_what_it_adds_to_a_known_parent() {
        let mut l = Ledger::in_memory();
        l.record("parent", &usage(counts(100, 10, 0.01), counts(100, 10, 0.01)), 1);
        let parent_total = l.total_of("parent");
        l.continues("fork", parent_total);
        l.record("fork", &usage(counts(40, 4, 0.004), counts(140, 14, 0.014)), 2);
        let (p, f) = (l.total_of("parent").unwrap(), l.total_of("fork").unwrap());
        assert_eq!((p.input_tokens, f.input_tokens), (100.0, 40.0));
        assert!((l.summary().total.cost_usd - 0.014).abs() < 1e-9);
    }

    #[test]
    fn an_adopted_unknown_session_takes_its_baseline_from_the_first_result_and_says_so() {
        let mut l = Ledger::in_memory();
        l.continues("adopted", None);
        l.record("adopted", &usage(counts(30, 3, 0.003), counts(530, 53, 0.053)), 1);
        let s = l.summary();
        assert!(s.runs[0].baseline_estimated);
        assert_eq!(s.runs[0].totals.input_tokens, 30.0);
    }

    #[test]
    fn the_ledger_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("intely-ledger-{}", std::process::id()));
        let path = dir.join("usage-ledger.json");
        {
            let mut l = Ledger::open(path.clone());
            l.record("a", &usage(counts(7, 1, 0.0007), counts(7, 1, 0.0007)), 5);
        }
        assert_eq!(Ledger::open(path).total_of("a").unwrap().input_tokens, 7.0);
        let _ = std::fs::remove_dir_all(dir);
    }
}
