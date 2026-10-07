//! The costs and limits notice of spec 3.6, as constants so the UI and the docs cannot drift. Numbers are from the Cloudflare
//! documentation read on 2026-10-04 (Durable Objects pricing page updated 2026-09-30); the Cloudflare dashboard is the source of truth.

use serde::Serialize;

/// The day the figures were checked (ISO date; the UI formats it with `fmt.date`).
pub const CHECKED_ON: &str = "2026-10-04";
/// Days since 1970-01-01 of [`CHECKED_ON`].
pub const CHECKED_ON_DAY: i64 = 20_730;
/// After this many days the header of the notice turns into a warning.
pub const STALE_AFTER_DAYS: i64 = 180;
pub const FREE_DAILY_REQUESTS: u64 = 100_000;
/// The Mac warns at this share of the Free daily cap, counted from its local frames-sent counter.
pub const FRAME_WARN_PERCENT: u64 = 50;
pub const WEBSOCKET_INCOMING_RATIO: u64 = 20;
pub const PRICING_URL: &str = "https://developers.cloudflare.com/durable-objects/platform/pricing/";
pub const WORKERS_PRICING_URL: &str = "https://developers.cloudflare.com/workers/platform/pricing/";
pub const WORKERS_PAID_MINIMUM_USD: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Overage {
    pub usd: f64,
    pub per: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitRow {
    pub id: &'static str,
    /// What the numbers count (`requests`, `gbSeconds`, `rows`, `gigabytes`, `files`).
    pub unit: &'static str,
    pub free_per_day: Option<u64>,
    pub paid_included_per_month: Option<u64>,
    pub overage: Option<Overage>,
    /// False when the figure was not re-read on the check date (the notice links the pricing page instead of quoting it).
    pub figure_checked: bool,
}

const fn row(id: &'static str, unit: &'static str, free: Option<u64>, paid: Option<u64>, overage: Option<Overage>, checked: bool) -> LimitRow {
    LimitRow { id, unit, free_per_day: free, paid_included_per_month: paid, overage, figure_checked: checked }
}

pub const ROWS: [LimitRow; 8] = [
    row("workerRequests", "requests", Some(100_000), Some(10_000_000), None, false),
    row("doRequests", "requests", Some(100_000), Some(1_000_000), Some(Overage { usd: 0.15, per: 1_000_000 }), true),
    row("doDuration", "gbSeconds", Some(13_000), Some(400_000), Some(Overage { usd: 12.50, per: 1_000_000 }), true),
    row("sqliteRowsWritten", "rows", Some(100_000), Some(50_000_000), None, true),
    row("sqliteRowsRead", "rows", Some(5_000_000), Some(25_000_000_000), None, true),
    // Storage is not a per-day figure: free 5 GB total (1 GB per object), paid 10 GB per object at 0.20 USD per GB-month.
    row("sqliteStorage", "gigabytes", Some(5), Some(10), Some(Overage { usd: 0.20, per: 1 }), true),
    row("staticAssetFiles", "files", Some(20_000), Some(100_000), None, true),
    row("websocketIncomingRatio", "requests", Some(WEBSOCKET_INCOMING_RATIO), Some(WEBSOCKET_INCOMING_RATIO), None, true),
];

/// Ids of the plain statements under the table; the UI owns the wording (`remote.cloud.limits.<id>`).
pub const STATEMENTS: [&str; 7] = ["freeCapExhausted", "ratioUnverified", "expectedLoad", "assetsNotBilled", "publicTraffic", "billingAlert", "estimateOnly"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsNotice {
    pub checked_on: &'static str,
    pub stale_after_days: i64,
    pub pricing_url: &'static str,
    pub workers_pricing_url: &'static str,
    pub paid_minimum_usd: u32,
    pub free_daily_requests: u64,
    pub frame_warn_percent: u64,
    pub rows: Vec<LimitRow>,
    pub statements: Vec<&'static str>,
}

impl LimitsNotice {
    pub fn current() -> Self {
        Self {
            checked_on: CHECKED_ON,
            stale_after_days: STALE_AFTER_DAYS,
            pricing_url: PRICING_URL,
            workers_pricing_url: WORKERS_PRICING_URL,
            paid_minimum_usd: WORKERS_PAID_MINIMUM_USD,
            free_daily_requests: FREE_DAILY_REQUESTS,
            frame_warn_percent: FRAME_WARN_PERCENT,
            rows: ROWS.to_vec(),
            statements: STATEMENTS.to_vec(),
        }
    }

    /// Whole days between the check date and `now` (Unix seconds); negative when the clock is before the check date.
    pub fn age_days(now: u64) -> i64 {
        (now / 86_400) as i64 - CHECKED_ON_DAY
    }

    /// Days past the 180-day freshness window (0 while fresh). The header of the notice becomes a warning when this is above 0.
    pub fn stale_days(now: u64) -> i64 {
        (Self::age_days(now) - STALE_AFTER_DAYS).max(0)
    }

    pub fn is_stale(now: u64) -> bool {
        Self::stale_days(now) > 0
    }

    /// The Mac warns once this many frames were sent today.
    pub fn frame_warn_threshold() -> u64 {
        FREE_DAILY_REQUESTS * FRAME_WARN_PERCENT / 100
    }
}

/// Share of the Free daily cap used by `frames` (0 to 100+).
pub fn frame_percent(frames: u64) -> u64 {
    frames * 100 / FREE_DAILY_REQUESTS
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
    fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
        let y = if m <= 2 { y - 1 } else { y };
        let era = if y >= 0 { y } else { y - 399 } / 400;
        let yoe = y - era * 400;
        let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146_097 + doe - 719_468
    }

    #[test]
    fn the_check_date_constant_is_the_check_date() {
        let mut it = CHECKED_ON.split('-').map(|p| p.parse::<i64>().unwrap());
        let (y, m, d) = (it.next().unwrap(), it.next().unwrap(), it.next().unwrap());
        assert_eq!(days_from_civil(y, m, d), CHECKED_ON_DAY);
    }

    #[test]
    fn staleness_starts_after_180_days() {
        let day = |n: i64| ((CHECKED_ON_DAY + n) * 86_400) as u64;
        assert_eq!(LimitsNotice::stale_days(day(0)), 0);
        assert_eq!(LimitsNotice::stale_days(day(180)), 0);
        assert!(!LimitsNotice::is_stale(day(180)));
        assert_eq!(LimitsNotice::stale_days(day(181)), 1);
        assert!(LimitsNotice::is_stale(day(181)));
        assert_eq!(LimitsNotice::stale_days(day(300)), 120);
        assert_eq!(LimitsNotice::stale_days(0), 0, "a clock before the check date is not stale");
        assert_eq!(LimitsNotice::age_days(day(5) + 3_600), 5);
    }

    #[test]
    fn the_notice_carries_the_documented_numbers() {
        let n = LimitsNotice::current();
        assert_eq!(n.checked_on, "2026-10-04");
        assert_eq!(n.free_daily_requests, 100_000);
        assert_eq!(LimitsNotice::frame_warn_threshold(), 50_000);
        assert_eq!(frame_percent(50_000), 50);
        let row = |id: &str| n.rows.iter().find(|r| r.id == id).unwrap();
        assert_eq!(row("doRequests").paid_included_per_month, Some(1_000_000));
        assert_eq!(row("doRequests").overage, Some(Overage { usd: 0.15, per: 1_000_000 }));
        assert_eq!(row("doDuration").free_per_day, Some(13_000));
        assert_eq!(row("doDuration").overage.unwrap().usd, 12.50);
        assert_eq!(row("sqliteRowsRead").free_per_day, Some(5_000_000));
        assert_eq!(row("staticAssetFiles").free_per_day, Some(20_000));
        assert!(!row("workerRequests").figure_checked, "the Paid Worker request figure was not re-read");
        assert_eq!(row("websocketIncomingRatio").free_per_day, Some(20));
        assert!(n.statements.contains(&"ratioUnverified") && n.statements.contains(&"billingAlert"));
        let json = serde_json::to_value(&n).unwrap();
        assert_eq!(json["rows"][1]["freePerDay"], 100_000);
        assert_eq!(json["checkedOn"], "2026-10-04");
    }
}
