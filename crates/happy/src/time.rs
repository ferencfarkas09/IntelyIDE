//! Civil-time helpers without a date crate: epoch milliseconds from and to ISO 8601 and HTTP dates.

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn digits(b: &[u8]) -> Option<i64> {
    (!b.is_empty() && b.iter().all(u8::is_ascii_digit)).then(|| b.iter().fold(0, |n, d| n * 10 + i64::from(d - b'0')))
}

/// `2026-10-03T10:00:00(.123)(Z|+02:00)`; a missing zone is UTC.
pub fn parse_iso(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || !matches!(b[10], b'T' | b't' | b' ') || b[4] != b'-' || b[7] != b'-' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d) = (digits(&b[0..4])?, digits(&b[5..7])?, digits(&b[8..10])?);
    let (h, mi, sec) = (digits(&b[11..13])?, digits(&b[14..16])?, digits(&b[17..19])?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let mut rest = &b[19..];
    let mut millis = 0;
    if rest.first() == Some(&b'.') {
        let n = rest[1..].iter().take_while(|c| c.is_ascii_digit()).count();
        let frac = &rest[1..1 + n];
        millis = digits(&frac[..frac.len().min(3)]).map(|v| v * 10_i64.pow(3 - frac.len().min(3) as u32))?;
        rest = &rest[1 + n..];
    }
    let offset_min = match rest {
        [] | [b'Z' | b'z'] => 0,
        [sign @ (b'+' | b'-'), tz @ ..] if tz.len() == 5 && tz[2] == b':' => {
            let v = digits(&tz[0..2])? * 60 + digits(&tz[3..5])?;
            if *sign == b'+' {
                v
            } else {
                -v
            }
        }
        _ => return None,
    };
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + sec - offset_min * 60;
    Some(secs * 1000 + millis)
}

/// `2026-10-03T10:00:00.000Z`.
pub fn to_iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let tod = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", tod / 3600, tod % 3600 / 60, tod % 60, ms.rem_euclid(1000))
}

/// The `Date` response header: `Sun, 06 Nov 1994 08:49:37 GMT`.
pub fn parse_http_date(s: &str) -> Option<i64> {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let mut parts = s.split_whitespace().skip(1);
    let day = parts.next()?.parse::<i64>().ok()?;
    let name = parts.next()?;
    let month = MONTHS.iter().position(|m| m.eq_ignore_ascii_case(name))? as i64 + 1;
    let year = parts.next()?.parse::<i64>().ok()?;
    let mut clock = parts.next()?.split(':').map(|p| p.parse::<i64>().ok());
    let (h, mi, sec) = (clock.next()??, clock.next()??, clock.next()??);
    Some((days_from_civil(year, month, day) * 86_400 + h * 3600 + mi * 60 + sec) * 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_round_trips_and_honours_the_offset() {
        let ms = parse_iso("2026-10-03T08:15:30.250Z").unwrap();
        assert_eq!(to_iso(ms), "2026-10-03T08:15:30.250Z");
        assert_eq!(parse_iso("2026-10-03T10:15:30.250+02:00"), Some(ms));
        assert_eq!(parse_iso("2026-10-03T08:15:30"), Some(ms - 250));
        assert_eq!(parse_iso("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(to_iso(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn garbage_is_not_a_date() {
        for s in ["", "yesterday", "2026-13-01T00:00:00Z", "2026-10-03T25:00:00Z", "2026-10-03T10:00:00+0200"] {
            assert_eq!(parse_iso(s), None, "{s}");
        }
    }

    #[test]
    fn the_http_date_header_parses() {
        assert_eq!(parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT"), Some(784_111_777_000));
        assert_eq!(parse_http_date("nonsense"), None);
    }
}
