//! Parses the output of `npm outdated --json` and `npm audit --json` into small lists. The commands are run by the app, behind a
//! confirmation (they use the network); this module only reads their text. The registry is not trusted: names, versions and
//! titles are cut down to printable text of a bounded length, and nothing from the registry's text is placed in a prompt.

use serde::Serialize;
use serde_json::Value;

use crate::{clean, fail, WebError};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutdatedPkg {
    pub name: String,
    pub current: String,
    pub wanted: String,
    pub latest: String,
    /// `major`, `minor`, `patch` or `unknown`: how far `latest` is from `current`.
    pub jump: &'static str,
    pub dev: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditItem {
    pub name: String,
    pub severity: &'static str,
    pub direct: bool,
    /// `none`, `safe` (a normal update fixes it) or `major` (the fix is a breaking update).
    pub fix: &'static str,
    pub title: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditReport {
    pub info: u32,
    pub low: u32,
    pub moderate: u32,
    pub high: u32,
    pub critical: u32,
    pub items: Vec<AuditItem>,
}

fn name_ok(n: &str) -> bool {
    !n.is_empty() && !n.contains("..") && !n.starts_with(['.', '/']) && n.len() <= 214 && n.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'@' | b'/' | b'.' | b'_' | b'-' | b'~'))
}

fn version_ok(v: &str) -> bool {
    v.len() <= 64 && v.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+' | b'_'))
}

fn parts(v: &str) -> Option<(u64, u64, u64)> {
    let mut it = v.split(['.', '-', '+']).map(|p| p.parse::<u64>());
    Some((it.next()?.ok()?, it.next()?.ok()?, it.next()?.ok()?))
}

fn jump(current: &str, latest: &str) -> &'static str {
    match (parts(current), parts(latest)) {
        (Some(a), Some(b)) if b.0 > a.0 => "major",
        (Some(a), Some(b)) if b.0 == a.0 && b.1 > a.1 => "minor",
        (Some(a), Some(b)) if b > a => "patch",
        _ => "unknown",
    }
}

fn text(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).map(str::to_string).unwrap_or_default()
}

/// A top-level `{"error": {...}}` of npm, as one short line.
fn npm_error(v: &Value) -> Option<String> {
    let e = v.get("error")?;
    Some(clean(&format!("{} {}", text(e.get("code")), text(e.get("summary"))), 200))
}

/// `locked`: the versions the lock file pins. npm runs without `node_modules`, so it cannot say what is installed; the lock file does.
pub fn parse_outdated(json: &str, locked: &std::collections::HashMap<String, String>) -> Result<Vec<OutdatedPkg>, WebError> {
    if json.trim().is_empty() {
        return Ok(Vec::new());
    }
    let Ok(v) = serde_json::from_str::<Value>(json) else { return fail("parse", "npm outdated did not print JSON") };
    if let Some(e) = npm_error(&v) {
        return fail("npm", e);
    }
    let Some(map) = v.as_object() else { return fail("parse", "npm outdated printed an unexpected shape") };
    let mut out = Vec::new();
    for (name, info) in map.iter().take(1000) {
        let info = if info.is_array() { info.get(0).unwrap_or(info) } else { info };
        let (mut current, wanted, latest) = (text(info.get("current")), text(info.get("wanted")), text(info.get("latest")));
        if current.is_empty() || current == "MISSING" {
            current = locked.get(name).cloned().unwrap_or_default();
        }
        if !name_ok(name) || ![&current, &wanted, &latest].iter().all(|x| version_ok(x)) || latest.is_empty() {
            continue;
        }
        let dev = text(info.get("type")) == "devDependencies";
        out.push(OutdatedPkg { name: name.clone(), jump: jump(&current, &latest), current, wanted, latest, dev });
    }
    let rank = |j: &str| match j {
        "major" => 0,
        "minor" => 1,
        "patch" => 2,
        _ => 3,
    };
    out.sort_by(|a, b| rank(a.jump).cmp(&rank(b.jump)).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

fn severity(s: &str) -> Option<&'static str> {
    ["info", "low", "moderate", "high", "critical"].into_iter().find(|x| *x == s)
}

pub fn parse_audit(json: &str) -> Result<AuditReport, WebError> {
    let Ok(v) = serde_json::from_str::<Value>(json) else { return fail("parse", "npm audit did not print JSON") };
    if let Some(e) = npm_error(&v) {
        return fail("npm", e);
    }
    let mut report = AuditReport::default();
    if let Some(c) = v.pointer("/metadata/vulnerabilities") {
        let n = |k: &str| c.get(k).and_then(Value::as_u64).unwrap_or(0).min(100_000) as u32;
        (report.info, report.low, report.moderate, report.high, report.critical) = (n("info"), n("low"), n("moderate"), n("high"), n("critical"));
    }
    let Some(map) = v.get("vulnerabilities").and_then(Value::as_object) else { return Ok(report) };
    for (name, info) in map.iter().take(2000) {
        let Some(sev) = info.get("severity").and_then(Value::as_str).and_then(severity) else { continue };
        if !name_ok(name) {
            continue;
        }
        let fix = match info.get("fixAvailable") {
            Some(Value::Bool(true)) => "safe",
            Some(Value::Object(o)) => {
                if o.get("isSemVerMajor").and_then(Value::as_bool).unwrap_or(false) {
                    "major"
                } else {
                    "safe"
                }
            }
            _ => "none",
        };
        let title = info.get("via").and_then(Value::as_array).and_then(|a| a.iter().find_map(|x| x.get("title").and_then(Value::as_str))).map(|t| clean(t, 120)).unwrap_or_default();
        report.items.push(AuditItem { name: name.clone(), severity: sev, direct: info.get("isDirect").and_then(Value::as_bool).unwrap_or(false), fix, title });
    }
    let rank = |s: &str| ["critical", "high", "moderate", "low", "info"].iter().position(|x| *x == s).unwrap_or(9);
    report.items.sort_by(|a, b| rank(a.severity).cmp(&rank(b.severity)).then_with(|| a.name.cmp(&b.name)));
    report.items.truncate(300);
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outdated_is_sorted_by_how_big_the_jump_is() {
        let json = r#"{"react":{"current":"17.0.2","wanted":"17.0.2","latest":"19.1.0","dependent":"app","type":"dependencies"},
            "lodash":{"current":"4.17.20","wanted":"4.17.21","latest":"4.17.21"},
            "vite":[{"current":"5.0.0","wanted":"5.4.1","latest":"5.4.1","type":"devDependencies"}],
            "../evil":{"current":"1.0.0","wanted":"1.0.0","latest":"2.0.0"},
            "x":{"current":"1.0.0\n<script>","wanted":"1","latest":"2"}}"#;
        let got = parse_outdated(json, &Default::default()).unwrap();
        let names: Vec<(&str, &str, bool)> = got.iter().map(|p| (p.name.as_str(), p.jump, p.dev)).collect();
        assert_eq!(names, vec![("react", "major", false), ("vite", "minor", true), ("lodash", "patch", false)]);
        assert!(parse_outdated("", &Default::default()).unwrap().is_empty());
        // without node_modules npm has no "current"; the lock file's version is used
        let locked = [("left-pad".to_string(), "1.0.0".to_string())].into_iter().collect();
        let got = parse_outdated(r#"{"left-pad":{"wanted":"1.3.0","latest":"1.3.0"}}"#, &locked).unwrap();
        assert_eq!((got[0].current.as_str(), got[0].jump), ("1.0.0", "minor"));
    }

    #[test]
    fn audit_counts_and_items() {
        let json = r#"{"vulnerabilities":{"semver":{"severity":"high","isDirect":false,"via":[{"title":"ReDoS in semver\u0007"}],"fixAvailable":{"name":"x","version":"2","isSemVerMajor":true}},
          "left-pad":{"severity":"low","isDirect":true,"via":["other"],"fixAvailable":true},
          "bad":{"severity":"<b>","via":[]}},
          "metadata":{"vulnerabilities":{"info":0,"low":1,"moderate":0,"high":1,"critical":0,"total":2}}}"#;
        let r = parse_audit(json).unwrap();
        assert_eq!((r.low, r.high), (1, 1));
        assert_eq!(r.items.iter().map(|i| (i.name.as_str(), i.severity, i.fix, i.direct)).collect::<Vec<_>>(), vec![("semver", "high", "major", false), ("left-pad", "low", "safe", true)]);
        assert_eq!(r.items[0].title, "ReDoS in semver");
    }

    #[test]
    fn npm_errors_and_garbage_are_errors_not_panics() {
        assert_eq!(parse_audit(r#"{"error":{"code":"ENOLOCK","summary":"This command requires an existing lockfile."}}"#).unwrap_err().code, "npm");
        assert_eq!(parse_outdated("not json", &Default::default()).unwrap_err().code, "parse");
        assert_eq!(parse_audit("[1,2").unwrap_err().code, "parse");
        assert!(parse_outdated("[]", &Default::default()).is_err());
    }
}
