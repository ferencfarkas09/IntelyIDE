//! `mongo-audit.jsonl`: append-only, mode 0600, in the IDE state directory (an agent write hard stop and never-read
//! path). One line per executed operation: what ran, on which connection, the filter **shape** (literals replaced by
//! type names) and the SHA-256 of the exact filter text, counts, origin, duration, outcome. **No document bodies, no
//! URIs, no literal values.**

use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{code, Result, StudioError};
use crate::profile::sha256_hex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditRecord {
    pub ts: String,
    pub connection_id: String,
    pub environment: String,
    pub level: String,
    /// `read` for everything in M1 (`write`, `ai-read`, `export`, `agent-suggest` arrive with their milestones).
    pub class: String,
    pub op: String,
    pub db: Option<String>,
    pub collection: Option<String>,
    pub filter_shape: Option<Value>,
    pub filter_hash: Option<String>,
    pub count: Option<u32>,
    pub truncated: bool,
    /// Always `desktop`: no agent and no paired phone can reach a database.
    pub origin: String,
    pub duration_ms: u32,
    pub outcome: String,
}

/// The file rolls at about this size; `mongo-audit.jsonl`, `.1` and `.2` are kept (three files).
pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const KEEP_FILES: u32 = 3;

/// One lock for every writer in the process: the gateway and the tunnel manager each own an [`AuditLog`] on the same file.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub struct AuditLog {
    path: PathBuf,
    max_bytes: u64,
}

impl AuditLog {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into(), max_bytes: MAX_LOG_BYTES }
    }

    /// A smaller roll size (tests).
    pub fn with_limit(path: impl Into<PathBuf>, max_bytes: u64) -> Self {
        Self { path: path.into(), max_bytes: max_bytes.max(1) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn append(&self, rec: &AuditRecord) -> Result<()> {
        self.write_line(serde_json::to_vec(rec))
    }

    /// A lifecycle line (`connect`, `tunnel-open`, ...). Same file, same lock, same rolling.
    pub fn append_event(&self, ev: &AuditEvent) -> Result<()> {
        self.write_line(serde_json::to_vec(ev))
    }

    fn write_line(&self, line: serde_json::Result<Vec<u8>>) -> Result<()> {
        let mut line = line.map_err(|e| StudioError::new(code::AUDIT, e.to_string()))?;
        line.push(b'\n');
        let _g = WRITE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(dir) = self.path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).map_err(|e| StudioError::new(code::AUDIT, e.to_string()))?;
        }
        if std::fs::metadata(&self.path).is_ok_and(|m| m.len() >= self.max_bytes) {
            self.roll();
        }
        let mut f = std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(&self.path).map_err(|e| StudioError::new(code::AUDIT, e.to_string()))?;
        f.write_all(&line).map_err(|e| StudioError::new(code::AUDIT, e.to_string()))
    }

    fn numbered(&self, n: u32) -> PathBuf {
        let mut p = self.path.clone().into_os_string();
        p.push(format!(".{n}"));
        PathBuf::from(p)
    }

    /// `.2` is dropped, `.1` becomes `.2`, the live file becomes `.1` (renames keep the 0600 mode).
    fn roll(&self) {
        let _ = std::fs::remove_file(self.numbered(KEEP_FILES - 1));
        for n in (1..KEEP_FILES - 1).rev() {
            let _ = std::fs::rename(self.numbered(n), self.numbered(n + 1));
        }
        let _ = std::fs::rename(&self.path, self.numbered(1));
    }
}

/// Lifecycle events written to the audit log.
pub mod event {
    pub const CONNECT: &str = "connect";
    pub const DISCONNECT: &str = "disconnect";
    pub const TUNNEL_OPEN: &str = "tunnel-open";
    pub const TUNNEL_CLOSE: &str = "tunnel-close";
    pub const PROFILE_IMPORT: &str = "profile-import";
    pub const PROFILE_EXPORT: &str = "profile-export";
    pub const RESET: &str = "reset";
    pub const ALL: [&str; 7] = [CONNECT, DISCONNECT, TUNNEL_OPEN, TUNNEL_CLOSE, PROFILE_IMPORT, PROFILE_EXPORT, RESET];
}

/// One lifecycle line: when, which connection, its tag and level, the **masked** host label, the error class and code
/// on a failure, a count. Never a user name, a URI, a path or a secret: the label is scrubbed and clipped, the code is
/// restricted to a code charset, and there is no free-text field at all. The shape is a superset of [`AuditRecord`]
/// (`class` is `lifecycle`, `op` is the event), so a reader of the old lines reads these too.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub ts: String,
    pub connection_id: String,
    pub environment: String,
    pub level: String,
    pub class: String,
    pub op: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_class: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    pub truncated: bool,
    pub origin: String,
    pub duration_ms: u32,
    pub outcome: String,
}

fn clean_label(label: &str) -> String {
    // a URI that slipped into a label loses its scheme and credentials, whatever `redact` kept
    let red = crate::host::redact(label).replace("mongodb+srv://", "").replace("mongodb://", "").replace("***@", "");
    red.chars().filter(|c| !c.is_control()).take(120).collect()
}

fn clean_code(code: &str) -> Option<String> {
    let ok = !code.is_empty() && code.len() <= 64 && code.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'));
    ok.then(|| code.to_string())
}

impl AuditEvent {
    /// `connection_id` is the profile id (or a test id), not a name.
    pub fn new(event: &str, connection_id: &str) -> Self {
        Self {
            ts: iso_utc(now_ms()),
            connection_id: connection_id.chars().filter(|c| !c.is_control()).take(64).collect(),
            environment: String::new(),
            level: String::new(),
            class: "lifecycle".into(),
            op: event.into(),
            label: None,
            error_class: None,
            error_code: None,
            count: None,
            truncated: false,
            origin: "desktop".into(),
            duration_ms: 0,
            outcome: "ok".into(),
        }
    }

    /// The tag (`local`, `sandbox`, `production`) and the effective level (`Local`, `ProductionLevel`).
    pub fn with_tag(mut self, tag: &str, level: &str) -> Self {
        self.environment = tag.chars().filter(char::is_ascii_alphanumeric).take(16).collect();
        self.level = level.chars().filter(char::is_ascii_alphanumeric).take(24).collect();
        self
    }

    /// The masked host label (`host::display_host`).
    pub fn with_label(mut self, label: &str) -> Self {
        self.label = Some(clean_label(label)).filter(|l| !l.is_empty());
        self
    }

    pub fn with_count(mut self, n: usize) -> Self {
        self.count = Some(n.min(u32::MAX as usize) as u32);
        self
    }

    pub fn with_duration(mut self, d: std::time::Duration) -> Self {
        self.duration_ms = d.as_millis().min(u128::from(u32::MAX)) as u32;
        self
    }

    /// A failure: the class and the diagnosis/error code only (`tunnel.auth`, `mongoServer`).
    pub fn failed(mut self, class: crate::api::ErrorClass, code: &str) -> Self {
        self.outcome = "error".into();
        self.error_class = serde_json::to_value(class).ok().and_then(|v| v.as_str().map(str::to_string));
        self.error_code = clean_code(code).or_else(|| Some("other".into()));
        self
    }

    /// An outcome that is not a failure and not plain `ok` (`dropped`).
    pub fn with_outcome(mut self, outcome: &str) -> Self {
        self.outcome = outcome.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(24).collect();
        self
    }
}

/// `2026-10-03T17:04:05.123Z` from unix milliseconds (civil-from-days, no time crate).
pub fn iso_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, ms.rem_euclid(1000))
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// The query with every literal replaced by its type name; field names and operators stay. EJSON wrappers
/// (`{"$oid": ...}`, `{"$date": ...}`, `{"$numberInt": ...}`) collapse to one type token. Arrays keep one entry per
/// distinct shape, so `$in: [1, 2, 3]` becomes `["<number>"]`.
pub fn filter_shape(v: &Value) -> Value {
    match v {
        Value::Null => json!("<null>"),
        Value::Bool(_) => json!("<bool>"),
        Value::Number(_) => json!("<number>"),
        Value::String(_) => json!("<string>"),
        Value::Array(a) => {
            let mut out: Vec<Value> = Vec::new();
            for e in a {
                let s = filter_shape(e);
                if !out.contains(&s) {
                    out.push(s);
                }
            }
            Value::Array(out)
        }
        Value::Object(m) => {
            if m.len() == 1 {
                let (k, _) = m.iter().next().expect("one entry");
                let token = match k.as_str() {
                    "$oid" => Some("<ObjectId>"),
                    "$date" => Some("<date>"),
                    "$numberInt" | "$numberLong" | "$numberDouble" | "$numberDecimal" => Some("<number>"),
                    "$regularExpression" => Some("<regex>"),
                    "$timestamp" => Some("<timestamp>"),
                    "$binary" | "$uuid" => Some("<binary>"),
                    "$minKey" | "$maxKey" => Some("<key>"),
                    _ => None,
                };
                if let Some(t) = token {
                    return json!(t);
                }
            }
            Value::Object(m.iter().map(|(k, c)| (k.clone(), filter_shape(c))).collect())
        }
    }
}

/// SHA-256 of the exact query text as typed, salted with the connection id so that the same text on two connections
/// does not correlate and a dictionary of likely queries does not work across logs.
pub fn filter_hash(salt: &str, text: &str) -> String {
    sha256_hex(format!("{salt}\u{1f}{text}").as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_formatted_in_utc() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_utc(1_790_000_000_123), "2026-09-21T14:13:20.123Z");
        assert_eq!(iso_utc(-1), "1969-12-31T23:59:59.999Z");
        assert_eq!(iso_utc(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn a_shape_has_no_literal() {
        let f = json!({"status": "KIZAROLT-secret", "restaurant": {"$oid": "65f0c0ffee0000000000abcd"}, "total": {"$gt": {"$numberInt": "424242"}}, "tags": {"$in": ["alpha-x", "beta-y", 7]}, "createdAt": {"$gte": {"$date": "2026-09-01T00:00:00Z"}}, "$or": [{"a": null}, {"b": true}]});
        let shape = filter_shape(&f).to_string();
        for lit in ["KIZAROLT", "65f0c0ffee", "424242", "alpha-x", "beta-y", "2026-09-01"] {
            assert!(!shape.contains(lit), "{shape}");
        }
        assert!(shape.contains("<ObjectId>") && shape.contains("<date>") && shape.contains("\"status\":\"<string>\""), "{shape}");
        assert_eq!(filter_shape(&json!({"x": {"$in": [1, 2, 3]}})), json!({"x": {"$in": ["<number>"]}}));
        assert_eq!(filter_hash("c1", "{a: 1}").len(), 64);
        assert_ne!(filter_hash("c1", "{a: 1}"), filter_hash("c2", "{a: 1}"));
    }
}
