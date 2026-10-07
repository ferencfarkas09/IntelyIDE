//! Wall-clock helpers (no tz database): Europe/Budapest for the Happy preset, the caller's fixed UTC offset otherwise: the prompt gives the model explicit local day boundaries as
//! UTC instants, because month and "last 7 days" windows were the main near-miss class in the M0 probe.

const DAY: i64 = 86_400_000;

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 0 = Sunday.
fn weekday(days: i64) -> i64 {
    (days + 4).rem_euclid(7)
}

fn last_sunday_utc_0100(year: i64, month: i64) -> i64 {
    let last = days_from_civil(year, month, 31);
    let back = weekday(last);
    (last - back) * DAY + 3_600_000
}

/// Offset of Europe/Budapest from UTC in minutes: +120 between the last Sunday of March and of October (01:00 UTC).
pub fn budapest_offset_minutes(utc_ms: i64) -> i64 {
    let (y, _, _) = civil_from_days(utc_ms.div_euclid(DAY));
    if utc_ms >= last_sunday_utc_0100(y, 3) && utc_ms < last_sunday_utc_0100(y, 10) {
        120
    } else {
        60
    }
}

pub fn iso_z(ms: i64) -> String {
    let (y, m, d) = civil_from_days(ms.div_euclid(DAY));
    let r = ms.rem_euclid(DAY);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", r / 3_600_000, r / 60_000 % 60, r / 1000 % 60)
}

/// The wall clock the Context block speaks in. Happy keeps Europe/Budapest with its DST rule; every other data set uses
/// the caller's own UTC offset and zone name (D24). A fixed offset cannot know about a DST change inside the shown
/// range: the boundaries use the offset the caller had at "now".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Zone {
    Budapest,
    Fixed { offset_min: i64, name: String },
}

impl Zone {
    /// UTC when the caller sent nothing; offsets are clamped to the real range (-12:00 .. +14:00) and the name is
    /// reduced to a safe, short label because it goes into the prompt.
    pub fn fixed(offset_min: Option<i32>, name: Option<&str>) -> Zone {
        let off = i64::from(offset_min.unwrap_or(0)).clamp(-720, 840);
        let name: String = name.unwrap_or("").chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '+')).take(40).collect();
        Zone::Fixed { offset_min: off, name: if name.is_empty() { "UTC".to_string() } else { name } }
    }

    pub fn offset_minutes(&self, utc_ms: i64) -> i64 {
        match self {
            Zone::Budapest => budapest_offset_minutes(utc_ms),
            Zone::Fixed { offset_min, .. } => *offset_min,
        }
    }

    pub fn label(&self) -> &str {
        match self {
            Zone::Budapest => "Europe/Budapest",
            Zone::Fixed { name, .. } => name,
        }
    }
}

pub fn iso_in(zone: &Zone, ms: i64) -> String {
    let off = zone.offset_minutes(ms);
    let z = iso_z(ms + off * 60_000);
    format!("{}{}{:02}:{:02}", &z[..19], if off >= 0 { '+' } else { '-' }, off.abs() / 60, off.abs() % 60)
}

pub fn iso_budapest(ms: i64) -> String {
    iso_in(&Zone::Budapest, ms)
}

/// UTC instant of local midnight of the local day that contains `ms`, shifted by `days` local days.
pub fn local_midnight_in(zone: &Zone, ms: i64, days: i64) -> i64 {
    let off = zone.offset_minutes(ms) * 60_000;
    let local_day = (ms + off).div_euclid(DAY) + days;
    let guess = local_day * DAY - off;
    // Re-evaluate the offset at the target instant (DST changes inside the shifted range).
    local_day * DAY - zone.offset_minutes(guess) * 60_000
}

pub fn local_midnight_utc(ms: i64, days: i64) -> i64 {
    local_midnight_in(&Zone::Budapest, ms, days)
}

/// First local day of the month that contains `ms`, shifted by `months`, as a UTC instant.
pub fn local_month_start_in(zone: &Zone, ms: i64, months: i64) -> i64 {
    let off = zone.offset_minutes(ms) * 60_000;
    let (y, m, _) = civil_from_days((ms + off).div_euclid(DAY));
    let total = y * 12 + (m - 1) + months;
    let (ny, nm) = (total.div_euclid(12), total.rem_euclid(12) + 1);
    let local = days_from_civil(ny, nm, 1) * DAY;
    local - zone.offset_minutes(local - 2 * 3_600_000) * 60_000
}

pub fn local_month_start_utc(ms: i64, months: i64) -> i64 {
    local_month_start_in(&Zone::Budapest, ms, months)
}

/// January 1st 00:00 local of the year that contains `ms`.
pub fn local_year_start_in(zone: &Zone, ms: i64) -> i64 {
    let off = zone.offset_minutes(ms) * 60_000;
    let (_, m, _) = civil_from_days((ms + off).div_euclid(DAY));
    local_month_start_in(zone, ms, -(m - 1))
}

pub fn local_year_start_utc(ms: i64) -> i64 {
    local_year_start_in(&Zone::Budapest, ms)
}

/// Monday 00:00 local of the week that contains `ms`.
pub fn local_week_start_in(zone: &Zone, ms: i64) -> i64 {
    let off = zone.offset_minutes(ms) * 60_000;
    let day = (ms + off).div_euclid(DAY);
    let since_monday = (weekday(day) + 6) % 7;
    local_midnight_in(zone, ms, -since_monday)
}

pub fn local_week_start_utc(ms: i64) -> i64 {
    local_week_start_in(&Zone::Budapest, ms)
}

/// Local January 1st of the year that contains `ms`, shifted by `years`, as a UTC instant.
pub fn local_year_start_shifted_in(zone: &Zone, ms: i64, years: i64) -> i64 {
    let off = zone.offset_minutes(ms) * 60_000;
    let (y, _, _) = civil_from_days((ms + off).div_euclid(DAY));
    let local = days_from_civil(y + years, 1, 1) * DAY;
    local - zone.offset_minutes(local - 2 * 3_600_000) * 60_000
}

pub fn local_year_start_shifted_utc(ms: i64, years: i64) -> i64 {
    local_year_start_shifted_in(&Zone::Budapest, ms, years)
}

/// The block that goes into the prompt: explicit boundaries so the model never has to do calendar arithmetic.
/// Calendar ranges (today, last month, last year...) and rolling windows (the last N days = now minus N*24 h) are
/// separate lists on purpose: mixing them was the main Hungarian date failure ("az elmúlt 3 nap" is rolling).
/// This is the Happy block, byte for byte what it was before presets existed.
pub fn context_block(now_ms: i64) -> String {
    context_block_in(now_ms, &Zone::Budapest, true)
}

/// `hungarian` adds the Hungarian rolling-window phrase (Happy only); a generic block contains no Hungarian.
pub fn context_block_in(now_ms: i64, zone: &Zone, hungarian: bool) -> String {
    let off = zone.offset_minutes(now_ms);
    let rolling = |label: &str, ms: i64| format!("- {label} {}", iso_z(now_ms - ms));
    let words = if hungarian { "\"in the last N hours/days\", \"elmúlt N nap\"" } else { "\"in the last N hours/days\"" };
    let lines = [
        format!("Now: {} ({}, UTC{:+03}:{:02}); as UTC: {}.", iso_in(zone, now_ms), zone.label(), off / 60, off.abs() % 60, iso_z(now_ms)),
        "Calendar ranges, local boundaries as UTC instants (use these exact values; a range is [start, next start)):".to_string(),
        format!("- yesterday starts {}", iso_z(local_midnight_in(zone, now_ms, -1))),
        format!("- today starts {}", iso_z(local_midnight_in(zone, now_ms, 0))),
        format!("- tomorrow starts {}", iso_z(local_midnight_in(zone, now_ms, 1))),
        format!("- last week (Monday) starts {}", iso_z(local_midnight_in(zone, local_week_start_in(zone, now_ms) + 12 * 3_600_000, -7))),
        format!("- this week (Monday) starts {}", iso_z(local_week_start_in(zone, now_ms))),
        format!("- last month starts {}", iso_z(local_month_start_in(zone, now_ms, -1))),
        format!("- this month starts {}", iso_z(local_month_start_in(zone, now_ms, 0))),
        format!("- next month starts {}", iso_z(local_month_start_in(zone, now_ms, 1))),
        format!("- last year starts {}", iso_z(local_year_start_shifted_in(zone, now_ms, -1))),
        format!("- this year starts {}", iso_z(local_year_start_in(zone, now_ms))),
        format!("- next year starts {}", iso_z(local_year_start_shifted_in(zone, now_ms, 1))),
        format!("Rolling windows ({words}): the instant is now minus exactly N*24 h and there is no upper bound:"),
        rolling("24 hours ago", DAY),
        rolling("3 days ago", 3 * DAY),
        rolling("7 days ago", 7 * DAY),
        rolling("14 days ago", 14 * DAY),
        rolling("30 days ago", 30 * DAY),
        rolling("90 days ago", 90 * DAY),
        rolling("365 days ago", 365 * DAY),
    ];
    lines.join("\n")
}
