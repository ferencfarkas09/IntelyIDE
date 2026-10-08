//! Usage across the runs: the tokens and the API-equivalent cost of every turn, bucketed by local day, hour of the day and
//! weekday.
//!
//! Read-only like the rest of this crate: the `usage` events of the JSONL run logs are the only input, the log schema is not
//! touched and nothing is written. A log is read once and again only when its size or time changes; the report is a fold over
//! what was read, so asking for it again (another time zone, another minute) costs no file access.
//!
//! Only what the IDE itself ran is counted (the runs it keeps logs of), and the scripted demo provider is left out. The cost is
//! what the provider reported for the turn: on a subscription it is the API-equivalent estimate, not a bill.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use intely_agent_core::events::types::{AgentEvent, EventKind};
use serde::Serialize;

/// A log larger than this is not read (the same bound as the search index).
const MAX_LOG_BYTES: u64 = 64 * 1024 * 1024;
const DAY_MS: i64 = 86_400_000;
const HOUR_MS: i64 = 3_600_000;
/// Time zones reach from UTC-12 to UTC+14.
const MAX_OFFSET_MIN: i32 = 14 * 60;

/// What one `usage` event added: the usage of the turn that just ended.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageRow {
    pub ts: u64,
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost_usd: f64,
}

/// Sums of turns. `input` and `output` are the fresh tokens; the cache numbers are shown beside them, never folded in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost_usd: f64,
    pub turns: u32,
}

impl Totals {
    fn add(&mut self, r: &UsageRow) {
        self.input += r.input;
        self.output += r.output;
        self.cache_read += r.cache_read;
        self.cache_write += r.cache_write;
        self.cost_usd += r.cost_usd;
        self.turns += 1;
    }

    /// Fresh tokens: what was read from the prompt and written back, without the cached context.
    pub fn tokens(&self) -> u64 {
        self.input + self.output
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    /// The local calendar day, `YYYY-MM-DD`.
    pub date: String,
    #[serde(flatten)]
    pub totals: Totals,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    #[serde(flatten)]
    pub totals: Totals,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub generated_ms: u64,
    /// Minutes east of UTC the days and hours are counted in.
    pub tz_offset_min: i32,
    /// The local day of `generated_ms`: "today" for the reader, whatever its own clock says.
    pub today: String,
    /// Runs that have at least one counted turn.
    pub runs: u32,
    pub first_ms: Option<u64>,
    pub last_ms: Option<u64>,
    pub total: Totals,
    /// Days with usage, oldest first.
    pub days: Vec<DayUsage>,
    /// Hour of the local day, 24 entries from 0.
    pub hours: Vec<Totals>,
    /// Monday first, 7 entries.
    pub weekdays: Vec<Totals>,
    /// Per model, the most used first.
    pub models: Vec<ModelUsage>,
}

/// The `usage` events of one log, oldest first. A torn tail, a blank line and a line of another shape are skipped, and so is
/// the scripted demo provider.
pub fn rows_of(text: &str) -> Vec<UsageRow> {
    text.lines()
        .filter(|l| l.contains("\"usage\""))
        .filter_map(|l| serde_json::from_str::<AgentEvent>(l).ok())
        .filter(|e| e.provider != "mock")
        .filter_map(|e| match e.kind {
            EventKind::Usage { usage } => Some(UsageRow {
                ts: e.ts,
                model: usage.model,
                input: u64::from(usage.per_turn.input_tokens),
                output: u64::from(usage.per_turn.output_tokens),
                cache_read: u64::from(usage.per_turn.cache_read),
                cache_write: u64::from(usage.per_turn.cache_write),
                cost_usd: usage.per_turn.cost_usd.filter(|c| c.is_finite() && *c > 0.0).unwrap_or(0.0),
            }),
            _ => None,
        })
        .filter(|r| r.input + r.output + r.cache_read + r.cache_write > 0 || r.cost_usd > 0.0)
        .collect()
}

/// Year, month and day of a day count since 1970-01-01 (proleptic Gregorian; Howard Hinnant's `civil_from_days`).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

fn date_of(day: i64) -> String {
    let (y, m, d) = civil(day);
    format!("{y:04}-{m:02}-{d:02}")
}

/// (days since 1970-01-01, hour of day) of an instant in the zone `offset_min` minutes east of UTC.
fn local(ts_ms: u64, offset_min: i32) -> (i64, usize) {
    let ms = i64::try_from(ts_ms).unwrap_or(i64::MAX / 2) + i64::from(offset_min) * 60_000;
    (ms.div_euclid(DAY_MS), (ms.rem_euclid(DAY_MS) / HOUR_MS) as usize)
}

struct RunRows {
    len: u64,
    mtime_ms: u64,
    rows: Vec<UsageRow>,
}

/// The usage rows of every run log of a folder, kept between calls.
#[derive(Default)]
pub struct UsageIndex {
    runs: BTreeMap<String, RunRows>,
}

impl UsageIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reads the logs that are new or changed since the last call and forgets the ones that are gone. Returns how many logs were read.
    pub fn refresh(&mut self, runs_dir: &Path) -> usize {
        let mut read = 0;
        let mut seen = BTreeSet::new();
        let listing = fs::read_dir(runs_dir).map(|d| d.flatten().collect::<Vec<_>>()).unwrap_or_default();
        for item in listing {
            let path = item.path();
            let Some(id) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".jsonl")).map(str::to_owned) else { continue };
            let Ok(md) = item.metadata() else { continue };
            if md.len() > MAX_LOG_BYTES {
                continue;
            }
            let mtime_ms = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
            seen.insert(id.clone());
            if self.runs.get(&id).is_some_and(|r| r.len == md.len() && r.mtime_ms == mtime_ms) {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else { continue };
            self.runs.insert(id, RunRows { len: md.len(), mtime_ms, rows: rows_of(&text) });
            read += 1;
        }
        self.runs.retain(|id, _| seen.contains(id));
        read
    }

    /// Adds the rows of a run that has no file (tests, and a caller that holds the events already).
    pub fn insert_rows(&mut self, id: &str, rows: Vec<UsageRow>) {
        self.runs.insert(id.to_owned(), RunRows { len: u64::MAX, mtime_ms: 0, rows });
    }

    /// The report for a reader `tz_offset_min` minutes east of UTC, as of `now_ms`.
    pub fn report(&self, tz_offset_min: i32, now_ms: u64) -> UsageReport {
        let offset = tz_offset_min.clamp(-MAX_OFFSET_MIN, MAX_OFFSET_MIN);
        let mut days: BTreeMap<i64, Totals> = BTreeMap::new();
        let mut hours = vec![Totals::default(); 24];
        let mut weekdays = vec![Totals::default(); 7];
        let mut models: BTreeMap<&str, Totals> = BTreeMap::new();
        let mut total = Totals::default();
        let (mut first, mut last) = (None::<u64>, None::<u64>);
        let mut runs = 0;
        for run in self.runs.values() {
            if run.rows.is_empty() {
                continue;
            }
            runs += 1;
            for r in &run.rows {
                let (day, hour) = local(r.ts, offset);
                days.entry(day).or_default().add(r);
                hours[hour].add(r);
                // 1970-01-01 was a Thursday; Monday is 0
                weekdays[(day + 3).rem_euclid(7) as usize].add(r);
                models.entry(r.model.as_str()).or_default().add(r);
                total.add(r);
                first = Some(first.map_or(r.ts, |f| f.min(r.ts)));
                last = Some(last.map_or(r.ts, |l| l.max(r.ts)));
            }
        }
        let mut models: Vec<ModelUsage> = models.into_iter().map(|(model, totals)| ModelUsage { model: model.to_owned(), totals }).collect();
        models.sort_by(|a, b| b.totals.tokens().cmp(&a.totals.tokens()).then_with(|| a.model.cmp(&b.model)));
        UsageReport {
            generated_ms: now_ms,
            tz_offset_min: offset,
            today: date_of(local(now_ms, offset).0),
            runs,
            first_ms: first,
            last_ms: last,
            total,
            days: days.into_iter().map(|(day, totals)| DayUsage { date: date_of(day), totals }).collect(),
            hours,
            weekdays,
            models,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 2026-10-07 22:30:00 UTC, a Wednesday.
    const WED_2230_UTC: u64 = 1_791_412_200_000;

    fn line(ts: u64, provider: &str, model: &str, input: u32, output: u32, cache_read: u32, cost: Option<f64>) -> String {
        json!({
            "agentId": "a1", "seq": 1, "ts": ts, "provider": provider, "kind": "usage",
            "usage": {
                "model": model, "costBasis": "estimated",
                "perTurn": { "inputTokens": input, "outputTokens": output, "cacheRead": cache_read, "cacheWrite": 0, "reasoningTokens": 0, "costUsd": cost },
                "cumulative": { "inputTokens": input, "outputTokens": output, "cacheRead": cache_read, "cacheWrite": 0, "reasoningTokens": 0 },
            }
        })
        .to_string()
    }

    #[test]
    fn dates_hours_and_weekdays_follow_the_calendar() {
        assert_eq!(date_of(0), "1970-01-01");
        assert_eq!(date_of(19_723), "2024-01-01");
        assert_eq!(date_of(19_782), "2024-02-29");
        assert_eq!(date_of(-1), "1969-12-31");
        assert_eq!(local(WED_2230_UTC, 0), (20_733, 22));
        assert_eq!(date_of(20_733), "2026-10-07");
        // two hours east it is already Thursday, 00:30
        assert_eq!(local(WED_2230_UTC, 120), (20_734, 0));
        // a day count never goes below the epoch's zone offset in a way that breaks: a time before 1970 in a zone west of UTC
        assert_eq!(local(0, -300), (-1, 19));
        assert_eq!(date_of(local(0, -300).0), "1969-12-31");
    }

    #[test]
    fn a_turn_lands_in_the_local_day_hour_and_weekday() {
        let mut idx = UsageIndex::new();
        idx.insert_rows("r1", rows_of(&line(WED_2230_UTC, "claude", "opus", 1000, 200, 5000, Some(0.5))));
        let utc = idx.report(0, WED_2230_UTC);
        assert_eq!((utc.today.as_str(), utc.days[0].date.as_str(), utc.hours[22].turns, utc.weekdays[2].turns), ("2026-10-07", "2026-10-07", 1, 1));
        let east = idx.report(120, WED_2230_UTC);
        assert_eq!((east.today.as_str(), east.days[0].date.as_str(), east.hours[0].turns, east.weekdays[3].turns, east.weekdays[2].turns), ("2026-10-08", "2026-10-08", 1, 1, 0));
        assert_eq!(east.total, Totals { input: 1000, output: 200, cache_read: 5000, cache_write: 0, cost_usd: 0.5, turns: 1 });
        assert_eq!((east.total.tokens(), east.runs, east.first_ms, east.last_ms), (1200, 1, Some(WED_2230_UTC), Some(WED_2230_UTC)));
    }

    #[test]
    fn days_models_and_totals_add_up() {
        let day = 86_400_000;
        let log = [
            line(WED_2230_UTC, "claude", "opus", 100, 10, 0, Some(1.0)),
            line(WED_2230_UTC + 1_000, "claude", "haiku", 50, 5, 1000, Some(0.1)),
            line(WED_2230_UTC + day, "claude", "opus", 300, 30, 0, Some(2.0)),
        ]
        .join("\n");
        let mut idx = UsageIndex::new();
        idx.insert_rows("r1", rows_of(&log));
        idx.insert_rows("r2", rows_of(&line(WED_2230_UTC, "claude", "opus", 1, 1, 0, None)));
        let r = idx.report(0, WED_2230_UTC + day);
        assert_eq!(r.runs, 2);
        assert_eq!(r.days.iter().map(|d| (d.date.as_str(), d.totals.turns, d.totals.input)).collect::<Vec<_>>(), vec![("2026-10-07", 3, 151), ("2026-10-08", 1, 300)]);
        assert_eq!(r.models.iter().map(|m| (m.model.as_str(), m.totals.turns)).collect::<Vec<_>>(), vec![("opus", 3), ("haiku", 1)]);
        assert!((r.total.cost_usd - 3.1).abs() < 1e-9);
        assert_eq!(r.hours.iter().map(|h| h.turns).sum::<u32>(), 4);
        assert_eq!(r.weekdays.iter().map(|h| h.turns).sum::<u32>(), 4);
        assert_eq!(r.today, "2026-10-08");
    }

    #[test]
    fn what_is_not_a_counted_turn_is_left_out() {
        let log = [
            line(WED_2230_UTC, "mock", "mock-1", 5, 5, 0, None),                 // the scripted demo provider
            line(WED_2230_UTC, "claude", "opus", 0, 0, 0, None),                   // nothing in it
            line(WED_2230_UTC, "claude", "opus", 0, 0, 0, Some(f64::NAN)),         // a cost that is not a number
            "{\"agentId\":\"a1\",\"seq\":2,\"ts\":1,\"provider\":\"claude\",\"kind\":\"usage\"".to_string(), // a torn tail
            "not json at all, but it says \"usage\"".to_string(),
            String::new(),
            json!({"agentId": "a1", "seq": 3, "ts": WED_2230_UTC, "provider": "claude", "kind": "text.delta", "messageId": "m", "text": "usage"}).to_string(),
            line(WED_2230_UTC, "claude", "opus", 7, 3, 0, Some(-1.0)),             // a negative cost counts as none
        ]
        .join("\n");
        let rows = rows_of(&log);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!((rows[0].input, rows[0].output, rows[0].cost_usd), (7, 3, 0.0));
    }

    #[test]
    fn an_empty_folder_gives_a_report_of_zeros_with_all_the_hours() {
        let dir = tempfile::tempdir().unwrap();
        let mut idx = UsageIndex::new();
        assert_eq!(idx.refresh(dir.path()), 0);
        assert_eq!(idx.refresh(&dir.path().join("missing")), 0);
        let r = idx.report(60, WED_2230_UTC);
        assert_eq!((r.runs, r.days.len(), r.hours.len(), r.weekdays.len(), r.models.len(), r.total), (0, 0, 24, 7, 0, Totals::default()));
        assert_eq!((r.first_ms, r.last_ms), (None, None));
        // an offset outside every real zone is held to the widest one
        assert_eq!(idx.report(99_999, 0).tz_offset_min, 840);
    }

    #[test]
    fn refresh_reads_each_log_once_and_follows_changes_and_deletions() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.jsonl");
        std::fs::write(&a, line(WED_2230_UTC, "claude", "opus", 10, 1, 0, Some(0.1))).unwrap();
        std::fs::write(dir.path().join("a.meta.json"), "{}").unwrap();
        std::fs::write(dir.path().join("notes.txt"), "not a log").unwrap();
        let mut idx = UsageIndex::new();
        assert_eq!(idx.refresh(dir.path()), 1);
        assert_eq!(idx.refresh(dir.path()), 0, "an unchanged log is not read again");
        assert_eq!(idx.report(0, WED_2230_UTC).total.turns, 1);
        // the run goes on: the log grows
        let mut more = std::fs::read_to_string(&a).unwrap();
        more.push('\n');
        more.push_str(&line(WED_2230_UTC + 5_000, "claude", "opus", 20, 2, 0, Some(0.2)));
        std::fs::write(&a, more).unwrap();
        assert_eq!(idx.refresh(dir.path()), 1);
        assert_eq!(idx.report(0, WED_2230_UTC).total.turns, 2);
        // the run is deleted
        std::fs::remove_file(&a).unwrap();
        assert_eq!(idx.refresh(dir.path()), 0);
        assert_eq!(idx.report(0, WED_2230_UTC).runs, 0);
    }

    #[test]
    fn the_report_serialises_in_the_shape_the_ui_reads() {
        let mut idx = UsageIndex::new();
        idx.insert_rows("r1", rows_of(&line(WED_2230_UTC, "claude", "opus", 1000, 200, 5000, Some(0.5))));
        let v = serde_json::to_value(idx.report(0, WED_2230_UTC)).unwrap();
        assert_eq!(v["today"], "2026-10-07");
        assert_eq!(v["days"][0], json!({"date": "2026-10-07", "input": 1000, "output": 200, "cacheRead": 5000, "cacheWrite": 0, "costUsd": 0.5, "turns": 1}));
        assert_eq!(v["models"][0]["model"], "opus");
        assert_eq!(v["hours"].as_array().map(Vec::len), Some(24));
        assert_eq!(v["firstMs"], WED_2230_UTC);
        assert_eq!(v["tzOffsetMin"], 0);
    }
}
