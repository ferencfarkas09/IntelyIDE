//! What may leave this machine as a shared run (docs/team.md). It builds on the Remote redactor (`intely_remote::redact`: secret
//! tokens, credential URLs, `password=`-style assignments, private keys, no `raw` payload, no thinking, tool output capped) and adds
//! what a teammate's screen needs and a phone's does not: JWTs, `Bearer` headers, any PEM block, secret files (`.env*`, `*.pem`,
//! `*.key`, `id_rsa*`, `id_ed25519*`, `*.p12`) whose contents and diffs never leave, and diffs of everything else, clipped.
//! Scrubbing is best effort on prose (a secret split across two text deltas can slip through); the share is opt-in per project.

use std::collections::{HashSet, VecDeque};

use intely_agent_core::events::{AgentEvent, EventKind, ToolDiff};
use intely_remote::redact as base;
use serde_json::{json, Value};

pub const MASK: &str = "[redacted]";
/// Tool output is cut at 8 KiB (the reused Remote redactor cuts at 4 KiB first, which is stricter).
pub const TOOL_OUTPUT_CAP: usize = 8 * 1024;
/// One side of a diff.
pub const DIFF_SIDE_CAP: usize = 8 * 1024;
const SCRUB_INPUT_CAP: usize = 256 * 1024;

/// Files whose contents and diffs are never shared, by name only (no path is read).
pub fn is_secret_file(path: &str) -> bool {
    let norm = path.replace('\\', "/").to_ascii_lowercase();
    if norm.split('/').any(|c| matches!(c, ".ssh" | ".aws" | ".gnupg")) {
        return true;
    }
    let name = norm.rsplit('/').next().unwrap_or(&norm);
    name.starts_with(".env")
        || [".pem", ".key", ".p12", ".pfx"].iter().any(|e| name.ends_with(e))
        || ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"].iter().any(|p| name.starts_with(p))
        || matches!(name, ".netrc" | ".npmrc" | ".pypirc")
}

fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '+' | '/' | '=' | '~')
}

/// Any `-----BEGIN ...-----` block (keys, certificates) up to its END line, or to the end of the text if it never ends.
fn mask_pem(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("-----BEGIN ") {
        out.push_str(&rest[..i]);
        out.push_str("[redacted pem block]");
        let head = &rest[i..];
        rest = match head.find("-----END ") {
            Some(e) => {
                let tail = &head[e + 9..];
                tail.find("-----").map_or("", |j| &tail[j + 5..])
            }
            None => "",
        };
    }
    out.push_str(rest);
    out
}

/// `eyJ...` header . payload . signature
fn mask_jwt(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pos = 0;
    while let Some(i) = s[pos..].find("eyJ").map(|i| i + pos) {
        let boundary = s[..i].chars().next_back().is_none_or(|c| !c.is_ascii_alphanumeric());
        let end = s[i..].find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))).map_or(s.len(), |e| e + i);
        let parts: Vec<&str> = s[i..end].split('.').collect();
        out.push_str(&s[pos..i]);
        if boundary && parts.len() == 3 && parts[0].len() >= 8 && parts[1].len() >= 8 && !parts[2].is_empty() {
            out.push_str(MASK);
            pos = end;
        } else {
            out.push_str("eyJ");
            pos = i + 3;
        }
    }
    out.push_str(&s[pos..]);
    out
}

fn mask_bearer(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let mut out = String::with_capacity(s.len());
    let mut pos = 0;
    while let Some(i) = lower[pos..].find("bearer ").map(|i| i + pos) {
        let start = i + 7;
        let len = s[start..].find(|c: char| !token_char(c)).unwrap_or(s.len() - start);
        out.push_str(&s[pos..start]);
        if len >= 8 {
            out.push_str(MASK);
            pos = start + len;
        } else {
            pos = start;
        }
    }
    out.push_str(&s[pos..]);
    out
}

const SECRET_NAMES: &[&str] = &["password", "passwd", "passphrase", "secret", "token", "apikey", "api_key", "api-key", "credential", "private_key", "access_key"];

/// `password=hunter2`, `?token=abc&x=1`, `api_key = "abc"`: the value after a secret-named key is masked, whatever the case of the
/// name (the Remote scrubber only knows `UPPER_CASE=` assignments). A bare value ends at whitespace, `&`, `,`, `;` or a quote.
fn mask_assignments(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let (mut last, mut i) = (0, 0);
    while i < b.len() {
        if b[i] != b'=' || b.get(i + 1) == Some(&b'=') || (i > 0 && matches!(b[i - 1], b'=' | b'!' | b'<' | b'>')) {
            i += 1;
            continue;
        }
        let before = s[..i].trim_end_matches(' ');
        let spaced = before.len() != i;
        let name_start = before.rfind(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))).map_or(0, |p| p + 1);
        let name = before[name_start..].to_ascii_lowercase();
        let after = &s[i + 1..];
        let ws = after.len() - after.trim_start_matches(' ').len();
        let v = &after[ws..];
        let quote = v.chars().next().filter(|c| matches!(c, '"' | '\''));
        // `token = foo()` in code is not a literal: with spaces only a quoted value counts
        if name.is_empty() || !SECRET_NAMES.iter().any(|w| name.contains(w)) || ((spaced || ws > 0) && quote.is_none()) || v.starts_with(MASK) {
            i += 1;
            continue;
        }
        let (vs, len) = match quote {
            Some(q) => (i + 1 + ws + 1, v[1..].find(q).unwrap_or(v.len() - 1)),
            None => (i + 1 + ws, v.find(|c: char| c.is_whitespace() || matches!(c, '&' | ',' | ';' | '"' | '\'')).unwrap_or(v.len())),
        };
        if len == 0 {
            i += 1;
            continue;
        }
        out.push_str(&s[last..vs]);
        out.push_str(MASK);
        last = vs + len;
        i = last;
    }
    out.push_str(&s[last..]);
    out
}

/// Secret-looking material in free text masked. Idempotent.
pub fn scrub(text: &str) -> String {
    let t: String = if text.len() > SCRUB_INPUT_CAP { text.chars().take(SCRUB_INPUT_CAP).collect() } else { text.to_string() };
    mask_assignments(&mask_jwt(&base::scrub_text(&mask_bearer(&mask_pem(&t)))))
}

/// Keeps the first `max` characters and says so.
pub fn clip(s: &str, max: usize) -> (String, bool) {
    if s.chars().count() <= max {
        return (s.to_string(), false);
    }
    (format!("{}\n[... truncated]", s.chars().take(max).collect::<String>()), true)
}

fn scrub_strings(v: &mut Value) {
    match v {
        Value::String(s) => *s = scrub(s),
        Value::Array(a) => a.iter_mut().for_each(scrub_strings),
        Value::Object(o) => o.values_mut().for_each(scrub_strings),
        _ => {}
    }
}

fn replace_home(v: &mut Value, home: &str) {
    match v {
        Value::String(s) if s.contains(home) => *s = s.replace(home, "~"),
        Value::Array(a) => a.iter_mut().for_each(|x| replace_home(x, home)),
        Value::Object(o) => o.values_mut().for_each(|x| replace_home(x, home)),
        _ => {}
    }
}

/// Words of a shell command or a path list: split on whitespace, quotes and the shell's operators, so `cat .env`,
/// `source .env`, `grep X config/.env.local`, `--env-file=.env` and `sed -n p ~/.ssh/id_rsa` each yield the file name.
fn tokens(s: &str) -> impl Iterator<Item = &str> {
    s.split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '`' | '=' | ';' | '|' | '&' | '<' | '>' | '(' | ')' | '{' | '}' | ',' | ':')).filter(|t| !t.is_empty())
}

fn text_names_secret(s: &str) -> bool {
    s.len() <= 16 * 1024 && (is_secret_file(s) || base::is_secret_path(s) || tokens(s).any(|t| is_secret_file(t) || base::is_secret_path(t)))
}

fn touches_secret(v: &Value) -> bool {
    match v {
        Value::String(s) => text_names_secret(s),
        Value::Array(a) => a.iter().any(touches_secret),
        Value::Object(o) => o.values().any(touches_secret),
        _ => false,
    }
}

/// Text that arrives in pieces (a streamed answer). A piece is scrubbed only together with what came before it: the text up to the
/// last complete line goes out scrubbed, the unfinished line is held back until it is complete (or the stream ends), and a PEM block
/// that starts in one piece is dropped until its END line, however many pieces it takes.
#[derive(Debug, Default)]
pub struct StreamScrub {
    raw: String,
    in_pem: bool,
}

const HOLD_LINE: usize = 512;
const HOLD_MAX: usize = 4096;

impl StreamScrub {
    /// The part of the text that is safe to send now (possibly empty).
    pub fn push(&mut self, chunk: &str) -> String {
        self.raw.push_str(chunk);
        let nl = self.raw.rfind('\n').map_or(0, |i| i + 1);
        let tail = self.raw.len() - nl;
        let cut = if tail > HOLD_MAX {
            self.raw.len()
        } else if tail > HOLD_LINE {
            // a very long line: cut at the last whitespace, a token never contains one
            self.raw.rfind(char::is_whitespace).map_or(nl, |i| (i + 1).max(nl))
        } else {
            nl
        };
        let take: String = self.raw.drain(..cut).collect();
        self.process(&take)
    }

    /// The end of the message: whatever is still held, scrubbed.
    pub fn finish(&mut self) -> String {
        let take = std::mem::take(&mut self.raw);
        let out = self.process(&take);
        self.in_pem = false;
        out
    }

    fn process(&mut self, text: &str) -> String {
        let mut out = String::new();
        let mut rest = text;
        loop {
            if self.in_pem {
                let Some(e) = rest.find("-----END ") else { return out };
                let tail = &rest[e + 9..];
                let Some(j) = tail.find("-----") else { return out };
                rest = &tail[j + 5..];
                self.in_pem = false;
            } else if let Some(b) = rest.find("-----BEGIN ") {
                out.push_str(&scrub(&rest[..b]));
                out.push_str("[redacted pem block]");
                rest = &rest[b + 11..];
                self.in_pem = true;
            } else {
                out.push_str(&scrub(rest));
                return out;
            }
        }
    }
}

/// A tool's output as it grows: pieces are joined (a longer text that starts with the old one replaces it), and only the complete
/// lines are returned scrubbed; the final `tool.result` carries the rest.
#[derive(Debug, Default)]
pub struct OutputScrub {
    acc: String,
}

impl OutputScrub {
    pub fn push(&mut self, chunk: &str) -> String {
        if chunk.starts_with(self.acc.as_str()) {
            self.acc = chunk.to_string();
        } else {
            self.acc.push_str(chunk);
        }
        if self.acc.len() > 64 * 1024 {
            let mut cut = self.acc.len() - 64 * 1024;
            while !self.acc.is_char_boundary(cut) {
                cut += 1;
            }
            self.acc.drain(..cut);
        }
        let nl = self.acc.rfind('\n').map_or(0, |i| i + 1);
        scrub(&self.acc[..nl])
    }
}

/// A diff as it may be shared: `None` for a secret file.
pub fn diff(d: &ToolDiff) -> Option<Value> {
    if is_secret_file(&d.path) || base::is_secret_path(&d.path) {
        return None;
    }
    let side = |s: &str| clip(&base::escape_invisible(&scrub(s)), DIFF_SIDE_CAP);
    let (new, t1) = side(&d.new);
    let old = d.old.as_deref().map(side);
    let truncated = t1 || old.as_ref().is_some_and(|o| o.1);
    Some(json!({ "path": base::display(&d.path, 400), "old": old.map(|o| o.0), "new": new, "truncated": truncated }))
}

/// Stateful because a tool result must be hidden when its start named a secret file.
pub struct Redactor {
    inner: base::Redactor,
    hidden: HashSet<(String, String)>,
    order: VecDeque<(String, String)>,
    /// The home folder, written as `~` in everything that leaves.
    home: Option<String>,
}

impl Default for Redactor {
    fn default() -> Self {
        Self::new()
    }
}

impl Redactor {
    pub fn new() -> Self {
        Self::with_home(std::env::var("HOME").ok())
    }

    pub fn with_home(home: Option<String>) -> Self {
        let home = home.map(|h| h.trim_end_matches('/').to_string()).filter(|h| h.len() > 1);
        Self { inner: base::Redactor::new(), hidden: HashSet::new(), order: VecDeque::new(), home }
    }

    /// A tool call (or the card that asks for it) names a secret file: its output never leaves.
    pub fn hide_tool(&mut self, agent_id: &str, tool_id: &str) {
        self.hide(agent_id, tool_id);
    }

    fn hide(&mut self, agent: &str, tool: &str) {
        let key = (agent.to_string(), tool.to_string());
        if self.hidden.insert(key.clone()) {
            self.order.push_back(key);
            if self.order.len() > 4096 {
                if let Some(old) = self.order.pop_front() {
                    self.hidden.remove(&old);
                }
            }
        }
    }

    /// The event as it may be sent (camelCase JSON, the `AgentEvent` wire shape); `None` = never sent. Thinking text and notes never
    /// leave; `raw` is gone; a secret file's contents, input and diff are replaced.
    pub fn event(&mut self, e: &AgentEvent) -> Option<Value> {
        if matches!(e.kind, EventKind::ThinkingDelta { .. } | EventKind::Note { .. }) {
            return None;
        }
        let wire = self.inner.wire_event(e)?;
        let mut v = serde_json::to_value(&wire).ok()?;
        v.as_object_mut()?.remove("raw");
        match &e.kind {
            EventKind::ToolStart { tool_id, input, .. } if touches_secret(input) => {
                self.hide(&e.agent_id, tool_id);
                v["input"] = json!({ "redacted": "secret file" });
            }
            EventKind::ToolUpdate { tool_id, .. } | EventKind::ToolResult { tool_id, .. } => {
                if self.hidden.contains(&(e.agent_id.clone(), tool_id.clone())) && v.get("output").is_some_and(|o| !o.is_null()) {
                    v["output"] = json!("[hidden: this tool touched a secret file]");
                }
                if let EventKind::ToolResult { diff: Some(d), .. } = &e.kind {
                    if let Some(shared) = diff(d) {
                        v["diff"] = shared;
                    }
                }
            }
            EventKind::PermissionRequest { tool_id, intent, .. } => {
                if serde_json::to_value(intent).is_ok_and(|i| touches_secret(&i)) {
                    self.hide(&e.agent_id, tool_id);
                }
            }
            _ => {}
        }
        scrub_strings(&mut v);
        if let Some(h) = &self.home {
            replace_home(&mut v, h);
        }
        if let Some(Value::String(o)) = v.get_mut("output") {
            *o = clip(o, TOOL_OUTPUT_CAP).0;
        }
        Some(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use intely_agent_core::events::{StopReason, ToolKind, ToolStatus};

    fn ev(kind: EventKind) -> AgentEvent {
        AgentEvent { agent_id: "a1".into(), seq: 1, ts: 1, turn_id: None, provider: "claude".into(), kind, raw: Some(json!({"secret": "x"})) }
    }

    #[test]
    fn token_shapes_are_masked() {
        let aws = "AKIAIOSFODNN7EXAMPLE";
        let anth = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
        let oai = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
        let gh = ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].concat();
        let gh2 = ["github_pat_", "11ABCDEFG0abcdefghijklmnop_qrstuvwxyz0123456789"].concat();
        let slack = ["xoxb-", "123456789012-abcdefghijklmnop"].concat();
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz";
        for s in [aws, anth, oai, gh.as_str(), gh2.as_str(), slack.as_str(), jwt] {
            let out = scrub(&format!("key is {s} ok"));
            assert!(!out.contains(s), "{s} survived: {out}");
            assert!(out.contains("ok"));
        }
    }

    #[test]
    fn pem_blocks_bearer_headers_and_assignments_are_masked() {
        let pem = "-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END CERTIFICATE-----";
        assert!(!scrub(&format!("a\n{pem}\nb")).contains("MIIBIj"));
        assert!(scrub(&format!("a\n{pem}\nb")).ends_with("\nb"));
        let rsa = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n";
        assert!(!scrub(rsa).contains("MIIEow"));
        let h = scrub("curl -H 'Authorization: Bearer abcdef0123456789xyz' https://x");
        assert!(!h.contains("abcdef0123456789xyz"), "{h}");
        let h = scrub("authorization: bearer abcdef0123456789xyz");
        assert!(!h.contains("abcdef0123456789xyz"), "{h}");
        for s in ["password=hunter2hunter2", "API_TOKEN=abcd1234efgh5678", "token: abcd1234efgh5678", "DB_PASSWORD='s3cr3t-value'"] {
            let out = scrub(s);
            assert!(!out.contains("hunter2hunter2") && !out.contains("abcd1234efgh5678") && !out.contains("s3cr3t-value"), "{s} -> {out}");
        }
    }

    #[test]
    fn plain_text_and_ids_survive_and_scrubbing_is_idempotent() {
        let t = "Fixed the build. toolu_01AbCdEf and the eyJ prefix alone are fine. Bearer is a word.";
        assert_eq!(scrub(t), t);
        let s = scrub("x AKIAIOSFODNN7EXAMPLE y Bearer abcdef0123456789xyz");
        assert_eq!(scrub(&s), s);
    }

    #[test]
    fn secret_file_names() {
        for p in [".env", "app/.env.local", "a/b/server.pem", "k.key", "/home/u/.ssh/config", "id_rsa", "id_rsa.pub", "x/id_ed25519", "cert.p12", "C:\\u\\.env.production"] {
            assert!(is_secret_file(p), "{p}");
        }
        for p in ["src/environment.ts", "README.md", "keyboard.rs", "src/main.rs", "env.d.ts", "monkey.js"] {
            assert!(!is_secret_file(p), "{p}");
        }
    }

    #[test]
    fn thinking_and_notes_never_leave_and_raw_is_gone() {
        let mut r = Redactor::new();
        assert!(r.event(&ev(EventKind::ThinkingDelta { message_id: "m".into(), text: "private".into(), parent_tool_id: None })).is_none());
        let v = r.event(&ev(EventKind::TurnEnd { stop_reason: StopReason::EndTurn })).unwrap();
        assert!(v.get("raw").is_none());
        assert_eq!(v["kind"], "turn.end");
    }

    #[test]
    fn a_secret_file_loses_input_output_and_diff() {
        let mut r = Redactor::new();
        let start = ev(EventKind::ToolStart { tool_id: "t1".into(), name: "Write".into(), tool_kind: ToolKind::Edit, input: json!({"file_path": "/repo/.env", "content": "FOO=bar"}), parent_tool_id: None });
        let v = r.event(&start).unwrap();
        assert!(!v.to_string().contains("FOO=bar"));
        let res = ev(EventKind::ToolResult { tool_id: "t1".into(), status: ToolStatus::Ok, output: Some("wrote FOO=bar".into()), diff: Some(ToolDiff { path: "/repo/.env".into(), old: None, new: "FOO=bar".into() }), duration_ms: None });
        let v = r.event(&res).unwrap();
        assert!(!v.to_string().contains("FOO=bar"), "{v}");
        assert!(v.get("diff").is_none_or(Value::is_null));
        // a key file is dropped by name even when the start did not mention it
        let res = ev(EventKind::ToolResult { tool_id: "t2".into(), status: ToolStatus::Ok, output: None, diff: Some(ToolDiff { path: "deploy/server.key".into(), old: None, new: "x".into() }), duration_ms: None });
        assert!(r.event(&res).unwrap().get("diff").is_none_or(Value::is_null));
    }

    #[test]
    fn a_normal_diff_travels_scrubbed_and_clipped() {
        let mut r = Redactor::new();
        let big = format!("token = \"AKIAIOSFODNN7EXAMPLE\"\n{}", "x".repeat(20_000));
        let res = ev(EventKind::ToolResult { tool_id: "t3".into(), status: ToolStatus::Ok, output: None, diff: Some(ToolDiff { path: "src/a.rs".into(), old: Some("old".into()), new: big }), duration_ms: Some(3) });
        let v = r.event(&res).unwrap();
        let d = &v["diff"];
        assert_eq!(d["path"], "src/a.rs");
        assert_eq!(d["old"], "old");
        assert_eq!(d["truncated"], true);
        assert!(!d["new"].as_str().unwrap().contains("AKIAIOSFODNN7EXAMPLE"));
        assert!(d["new"].as_str().unwrap().chars().count() < DIFF_SIDE_CAP + 40);
    }

    #[test]
    fn tool_output_is_capped_and_scrubbed() {
        let mut r = Redactor::new();
        let out = format!("Bearer abcdef0123456789xyz {}", "y".repeat(30_000));
        let v = r.event(&ev(EventKind::ToolResult { tool_id: "t4".into(), status: ToolStatus::Ok, output: Some(out), diff: None, duration_ms: None })).unwrap();
        let o = v["output"].as_str().unwrap();
        assert!(o.chars().count() <= TOOL_OUTPUT_CAP + 40, "{}", o.len());
        assert!(!o.contains("abcdef0123456789xyz"));
    }

    #[test]
    fn a_pem_block_split_over_three_pieces_never_leaks() {
        let mut st = StreamScrub::default();
        let mut out = String::new();
        for piece in ["Here is the key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7x", "9fQ3kZ\nLq8vPz0NNNN\n", "-----END RSA PRIVATE KEY-----\nDone.\n"] {
            out.push_str(&st.push(piece));
        }
        out.push_str(&st.finish());
        assert!(!out.contains("MIIEow") && !out.contains("9fQ3kZ") && !out.contains("Lq8vPz0"), "{out}");
        assert!(out.contains("Here is the key:") && out.contains("Done."), "{out}");
    }

    #[test]
    fn a_token_split_across_a_batch_boundary_is_masked() {
        let mut st = StreamScrub::default();
        let mut out = st.push("the key is AKIAIOSF");
        assert!(!out.contains("AKIA"), "the unfinished line is held back: {out}");
        out.push_str(&st.push("ODNN7EXAMPLE and more\n"));
        out.push_str(&st.finish());
        assert!(!out.contains("AKIAIOSF") && !out.contains("ODNN7EXAMPLE"), "{out}");
        assert!(out.contains("and more"));
        // an unterminated block at the end of the message is dropped too
        let mut st = StreamScrub::default();
        let a = st.push("x\n-----BEGIN PRIVATE KEY-----\nAAAA\n");
        assert!(!a.contains("AAAA") && st.finish().is_empty());
    }

    #[test]
    fn streamed_tool_output_is_scrubbed_over_the_joined_text() {
        let mut o = OutputScrub::default();
        assert!(!o.push("token=AKIAIOSF").contains("AKIA"));
        let out = o.push("ODNN7EXAMPLE\nnext");
        assert!(!out.contains("ODNN7EXAMPLE") && !out.contains("AKIAIOSF"), "{out}");
        assert!(!out.contains("next"), "the incomplete line waits");
    }

    #[test]
    fn shell_commands_that_name_a_secret_file_hide_their_output() {
        for (i, cmd) in ["cat .env", "source .env", "grep X config/.env.local", "sed -n p ~/.ssh/id_rsa", "echo hi && cat \"deploy/server.key\"", "docker run --env-file=.env x", "head -c 9 'a/id_ed25519'"].iter().enumerate() {
            let mut r = Redactor::new();
            let id = format!("t{i}");
            let start = ev(EventKind::ToolStart { tool_id: id.clone(), name: "Bash".into(), tool_kind: ToolKind::Exec, input: json!({"command": cmd}), parent_tool_id: None });
            let v = r.event(&start).unwrap();
            assert!(v["input"].get("redacted").is_some(), "{cmd}: {v}");
            let res = ev(EventKind::ToolResult { tool_id: id, status: ToolStatus::Ok, output: Some("FOO=bar".into()), diff: None, duration_ms: None });
            assert!(!r.event(&res).unwrap().to_string().contains("FOO=bar"), "{cmd}");
        }
        let mut r = Redactor::new();
        let ok = ev(EventKind::ToolStart { tool_id: "ok".into(), name: "Bash".into(), tool_kind: ToolKind::Exec, input: json!({"command": "cargo test --environment x"}), parent_tool_id: None });
        assert!(r.event(&ok).unwrap()["input"].get("redacted").is_none());
    }

    #[test]
    fn a_permission_card_for_a_secret_file_hides_the_tool_output() {
        use intely_agent_core::policy::intent::ToolIntent;
        let mut r = Redactor::new();
        let intent: ToolIntent = serde_json::from_value(json!({"class": "exec", "tool": "Bash", "rawCommand": "cat .env", "paths": [], "summary": "cat .env"})).unwrap();
        r.event(&ev(EventKind::PermissionRequest { req_id: "p".into(), tool_id: "tp".into(), intent, options: vec![], session_allow: None, plan: None, plan_truncated: None, modes: vec![] })).unwrap();
        let res = ev(EventKind::ToolResult { tool_id: "tp".into(), status: ToolStatus::Ok, output: Some("SECRET=1".into()), diff: None, duration_ms: None });
        assert!(!r.event(&res).unwrap().to_string().contains("SECRET=1"));
    }

    #[test]
    fn the_home_folder_becomes_a_tilde() {
        let mut r = Redactor::with_home(Some("/Users/alice".into()));
        let v = r.event(&ev(EventKind::Error { class: intely_agent_core::events::ErrorClass::Internal, message: "cannot open /Users/alice/work/a.txt".into(), retryable: false })).unwrap();
        assert_eq!(v["message"], "cannot open ~/work/a.txt");
    }
}
