//! What may leave the machine (remote-plan 2.6, 4.2). `AgentEvent` -> wire event: no `raw` provider payload, no thinking text,
//! secrets and credential-bearing URLs masked, tool output and prose capped, diffs only on demand (`diff.get`), displayed
//! strings escaped so invisible and bidi characters cannot disguise a command. Scrubbing is best effort on prose (a secret
//! split across two text deltas can slip through), strict on structured fields.

use std::collections::{HashSet, VecDeque};

use intely_agent_core::events::{AgentEvent, EventKind, ToolDiff};
use intely_agent_core::policy::intent::ToolIntent;
use intely_agent_core::policy::paths;
use serde_json::{Map, Value};

pub const MASK: &str = "[redacted]";
pub const TOOL_OUTPUT_CAP: usize = 4096;
pub const TEXT_CAP: usize = 8 * 1024;
pub const COMMAND_CAP: usize = 2048;
pub const DIFF_CAP: usize = 40 * 1024;
const INPUT_VALUE_CAP: usize = 1024;
const INPUT_TOTAL_CAP: usize = 6 * 1024;

const TOKEN_PREFIXES: &[(&str, usize)] = &[
    ("sk-ant-", 8),
    ("sk-proj-", 8),
    ("sk_live_", 8),
    ("rk_live_", 8),
    ("pk_live_", 8),
    ("sk-", 20),
    ("ghp_", 20),
    ("gho_", 20),
    ("ghu_", 20),
    ("ghs_", 20),
    ("ghr_", 20),
    ("github_pat_", 20),
    ("glpat-", 16),
    ("xoxb-", 10),
    ("xoxp-", 10),
    ("xoxa-", 10),
    ("xoxs-", 10),
    ("npm_", 20),
    ("AIza", 30),
    ("ya29.", 20),
    ("AKIA", 16),
    ("ASIA", 16),
];

const SECRET_WORDS: &[&str] = &["secret", "token", "password", "passwd", "passphrase", "apikey", "api_key", "api-key", "credential", "private_key", "privatekey", "auth", "cookie", "session_key", "access_key", "client_secret"];

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '+' | '/' | '=')
}

fn name_is_secret(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    SECRET_WORDS.iter().any(|w| n.contains(w)) || n.ends_with("_key") || n.ends_with("key") && n.len() > 3 && n.chars().any(|c| c == '_' || c == '-') || n == "key" || n == "pwd"
}

/// Masks secret-looking material in free text.
pub fn scrub_text(input: &str) -> String {
    let s = scrub_private_keys(input);
    let s = scrub_urls(&s);
    let s: String = s.split_inclusive('\n').map(scrub_line).collect();
    scrub_tokens(&s)
}

fn scrub_private_keys(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("-----BEGIN ") {
        let head = &rest[start..];
        let line_end = head.find("-----").and_then(|_| head[11..].find("-----")).map(|i| i + 11 + 5);
        let is_key = line_end.is_some_and(|e| head[..e].contains("PRIVATE KEY"));
        out.push_str(&rest[..start]);
        if !is_key {
            out.push_str("-----BEGIN ");
            rest = &rest[start + 11..];
            continue;
        }
        out.push_str("[redacted private key]");
        rest = match head.find("-----END ") {
            Some(e) => {
                let tail = &head[e + 9..];
                tail.find("-----").map_or("", |i| &tail[i + 5..])
            }
            None => "",
        };
    }
    out.push_str(rest);
    out
}

/// `scheme://user:pass@host` -> `scheme://[redacted]@host`, and sensitive query values.
fn scrub_urls(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("://") {
        out.push_str(&rest[..i + 3]);
        rest = &rest[i + 3..];
        let end = rest.find(|c: char| c.is_whitespace() || matches!(c, '/' | '?' | '#' | '"' | '\'' | '<' | '>' | '`')).unwrap_or(rest.len());
        let authority = &rest[..end];
        match authority.rfind('@') {
            Some(at) => {
                out.push_str(MASK);
                out.push_str(&authority[at..]);
            }
            None => out.push_str(authority),
        }
        rest = &rest[end..];
        // path and query: mask values of secret-looking parameters
        let tail_end = rest.find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '`')).unwrap_or(rest.len());
        let tail = &rest[..tail_end];
        match tail.find('?') {
            Some(q) => {
                let (query, frag) = match tail[q + 1..].find('#') {
                    Some(h) => (&tail[q + 1..q + 1 + h], &tail[q + 1 + h..]),
                    None => (&tail[q + 1..], ""),
                };
                let masked: Vec<String> = query
                    .split('&')
                    .map(|kv| match kv.split_once('=') {
                        Some((k, _)) if name_is_secret(k) || k.eq_ignore_ascii_case("code") || k.eq_ignore_ascii_case("sig") || k.eq_ignore_ascii_case("signature") => format!("{k}={MASK}"),
                        _ => kv.to_string(),
                    })
                    .collect();
                out.push_str(&tail[..q + 1]);
                out.push_str(&masked.join("&"));
                out.push_str(frag);
            }
            None => out.push_str(tail),
        }
        rest = &rest[tail_end..];
    }
    out.push_str(rest);
    out
}

/// `NAME=value`, `export NAME=value`, `Authorization: ...`, and JSON/YAML `"name": "value"` lines.
fn scrub_line(line: &str) -> String {
    let (body, nl) = match line.strip_suffix('\n') {
        Some(b) => (b, "\n"),
        None => (line, ""),
    };
    let trimmed = body.trim_start();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("authorization:") || lower.starts_with("proxy-authorization:") || lower.starts_with("cookie:") || lower.starts_with("set-cookie:") || lower.starts_with("x-api-key:") {
        let indent = &body[..body.len() - trimmed.len()];
        let name = trimmed.split(':').next().unwrap_or("");
        return format!("{indent}{name}: {MASK}{nl}");
    }
    let mut out = String::with_capacity(body.len());
    let rest = body;
    // env assignments anywhere in a line: NAME=value (value up to whitespace or quote end)
    let bytes = rest.as_bytes();
    let mut i = 0;
    let mut last = 0;
    while i < bytes.len() {
        if bytes[i] == b'=' && i > 0 {
            let name_start = rest[..i].rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).map_or(0, |p| p + 1);
            let name = &rest[name_start..i];
            if !name.is_empty() && name.chars().any(|c| c.is_ascii_uppercase() || c == '_') && name_is_secret(name) {
                let vstart = i + 1;
                let (quote, vs) = match rest[vstart..].chars().next() {
                    Some(q @ ('"' | '\'')) => (Some(q), vstart + 1),
                    _ => (None, vstart),
                };
                if rest[vs..].starts_with(MASK) {
                    i = vs + MASK.len();
                    continue;
                }
                let vend = match quote {
                    Some(q) => rest[vs..].find(q).map_or(rest.len(), |p| vs + p),
                    None => rest[vs..].find(char::is_whitespace).map_or(rest.len(), |p| vs + p),
                };
                if vend > vs {
                    out.push_str(&rest[last..vs]);
                    out.push_str(MASK);
                    last = vend;
                    i = vend;
                    continue;
                }
            }
        }
        i += 1;
    }
    out.push_str(&rest[last..]);
    let mut out = scrub_keyed_values(&out);
    out.push_str(nl);
    out
}

/// `"password": "hunter2"` / `password: hunter2`
fn scrub_keyed_values(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    loop {
        // find the next quoted key or bare key followed by ':'
        let Some(colon) = rest.find(':') else { break };
        let before = &rest[..colon];
        let key_end = before.trim_end_matches(['"', '\'', ' ']).len();
        let key_start = before[..key_end].rfind(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))).map_or(0, |p| p + 1);
        let key = &before[key_start..key_end];
        let after = &rest[colon + 1..];
        let after_trim = after.trim_start();
        let skipped = after.len() - after_trim.len();
        let is_url_scheme = after_trim.starts_with("//");
        if !key.is_empty() && !is_url_scheme && name_is_secret(key) && !after_trim.is_empty() {
            let (vlen, quoted) = match after_trim.chars().next() {
                Some(q @ ('"' | '\'')) => (after_trim[1..].find(q).map_or(after_trim.len() - 1, |p| p), true),
                _ => (after_trim.find(|c: char| c.is_whitespace() || c == ',' || c == '}').unwrap_or(after_trim.len()), false),
            };
            if vlen > 0 && !after_trim.starts_with(MASK) {
                out.push_str(&rest[..colon + 1 + skipped]);
                if quoted {
                    out.push(after_trim.chars().next().unwrap());
                }
                out.push_str(MASK);
                let consumed = colon + 1 + skipped + usize::from(quoted) + vlen;
                rest = &rest[consumed..];
                continue;
            }
        }
        out.push_str(&rest[..colon + 1]);
        rest = &rest[colon + 1..];
    }
    out.push_str(rest);
    out
}

fn scrub_tokens(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_alnum = false;
    let mut i = 0;
    while i < s.len() {
        let rest = &s[i..];
        if !prev_alnum {
            if let Some(n) = token_len(rest) {
                out.push_str(MASK);
                i += n;
                prev_alnum = false;
                continue;
            }
        }
        let c = rest.chars().next().expect("i < len");
        out.push(c);
        prev_alnum = c.is_ascii_alphanumeric();
        i += c.len_utf8();
    }
    out
}

/// Length of a secret token starting exactly at `rest`, if one does.
fn token_len(rest: &str) -> Option<usize> {
    if let Some(r) = rest.strip_prefix("Bearer ") {
        let n = r.find(|c: char| !is_token_char(c)).unwrap_or(r.len());
        return (n >= 8).then_some(7 + n);
    }
    for (prefix, min) in TOKEN_PREFIXES {
        if rest.starts_with(prefix) {
            let n = rest[prefix.len()..].find(|c: char| !is_token_char(c)).unwrap_or(rest.len() - prefix.len());
            if n >= *min {
                return Some(prefix.len() + n);
            }
        }
    }
    if rest.starts_with("eyJ") {
        let n = rest.find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))).unwrap_or(rest.len());
        if n > 30 && rest[..n].matches('.').count() >= 2 {
            return Some(n);
        }
    }
    None
}

/// Shortens to head + tail with a marker; counts characters, never splits one.
pub fn cap(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max / 2).collect();
    let tail: String = s.chars().skip(n - max / 2).collect();
    format!("{head}\n[... {} characters omitted ...]\n{tail}", n - 2 * (max / 2))
}

/// Replaces control, zero-width and bidi characters by a visible `<U+XXXX>` so a command cannot disguise itself.
pub fn escape_invisible(s: &str) -> String {
    s.chars()
        .map(|c| {
            let bad = (c.is_control() && c != '\n' && c != '\t') || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}' | '\u{00AD}');
            if bad {
                format!("<U+{:04X}>", c as u32)
            } else {
                c.to_string()
            }
        })
        .collect()
}

/// A string for display: scrubbed, escaped, capped.
pub fn display(s: &str, max: usize) -> String {
    escape_invisible(&cap(&scrub_text(s), max))
}

fn scrub_value(v: &Value, key: Option<&str>, budget: &mut usize) -> Value {
    match v {
        Value::String(s) => {
            if key.is_some_and(name_is_secret) {
                return Value::String(MASK.into());
            }
            let t = cap(&scrub_text(s), INPUT_VALUE_CAP);
            *budget = budget.saturating_sub(t.len());
            Value::String(t)
        }
        Value::Array(a) => Value::Array(a.iter().take(32).map(|x| scrub_value(x, key, budget)).collect()),
        Value::Object(o) => {
            let mut m = Map::new();
            for (k, x) in o.iter().take(48) {
                if *budget == 0 {
                    m.insert("...".into(), Value::String("omitted".into()));
                    break;
                }
                m.insert(k.clone(), scrub_value(x, Some(k), budget));
            }
            Value::Object(m)
        }
        other => other.clone(),
    }
}

/// Paths named by a tool input that point at secrets (`.env`, key files, credential dirs).
fn secret_paths(input: &Value) -> bool {
    let mut found = false;
    fn walk(v: &Value, found: &mut bool) {
        match v {
            Value::String(s) if s.len() < 512 && !s.contains('\n') => {
                // a path-ish string
                if (s.contains('/') || s.starts_with('.') || s.contains('.')) && paths::never_read_reason(std::path::Path::new(s)).is_some() {
                    *found = true;
                }
            }
            Value::Array(a) => a.iter().for_each(|x| walk(x, found)),
            Value::Object(o) => o.values().for_each(|x| walk(x, found)),
            _ => {}
        }
    }
    walk(input, &mut found);
    found
}

pub fn is_secret_path(path: &str) -> bool {
    paths::never_read_reason(std::path::Path::new(path)).is_some()
}

/// Scrubs a tool intent for a card or an event: structured fields only.
pub fn wire_intent(i: &ToolIntent) -> ToolIntent {
    let mut o = i.clone();
    o.raw_command = i.raw_command.as_deref().map(|c| display(c, COMMAND_CAP));
    o.argv = i.argv.as_ref().map(|a| a.iter().take(64).map(|x| display(x, 512)).collect());
    o.paths = i.paths.iter().take(32).map(|p| display(p, 512)).collect();
    o.url = i.url.as_deref().map(|u| display(u, 400));
    o.summary = display(&i.summary, 200);
    o.tool = i.tool.as_deref().map(|t| display(t, 120));
    o
}

/// Stateful because a tool result must be hidden when its start named a secret path.
pub struct Redactor {
    hidden: HashSet<(String, String)>,
    order: VecDeque<(String, String)>,
}

impl Default for Redactor {
    fn default() -> Self {
        Self::new()
    }
}

impl Redactor {
    pub fn new() -> Self {
        Self { hidden: HashSet::new(), order: VecDeque::new() }
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

    fn is_hidden(&self, agent: &str, tool: &str) -> bool {
        self.hidden.contains(&(agent.to_string(), tool.to_string()))
    }

    /// The event as it may be sent; `None` = never sent (thinking text).
    pub fn wire_event(&mut self, e: &AgentEvent) -> Option<AgentEvent> {
        let mut o = e.clone();
        o.raw = None;
        o.kind = match &e.kind {
            EventKind::ThinkingDelta { .. } => return None,
            EventKind::SessionStarted { model, effective, auth, assertions, caps_delta, .. } => EventKind::SessionStarted {
                native_id: None,
                model: model.clone(),
                effective: effective.clone(),
                auth: auth.clone().map(|mut a| {
                    a.warning = a.warning.map(|w| display(&w, 300));
                    a
                }),
                assertions: assertions.iter().map(|a| display(a, 300)).collect(),
                caps_delta: caps_delta.clone(),
            },
            EventKind::UserMessage { message_id, text, attachments } => EventKind::UserMessage {
                message_id: message_id.clone(),
                text: cap(&scrub_text(text), TEXT_CAP),
                attachments: attachments.iter().map(|a| intely_agent_core::events::AttachmentRef { sha256: String::new(), name: display(&a.name, 120), ..a.clone() }).collect(),
            },
            EventKind::TextDelta { message_id, text, parent_tool_id } => EventKind::TextDelta { message_id: message_id.clone(), text: cap(&scrub_text(text), TEXT_CAP), parent_tool_id: parent_tool_id.clone() },
            EventKind::TextDone { message_id, text, parent_tool_id } => EventKind::TextDone { message_id: message_id.clone(), text: cap(&scrub_text(text), TEXT_CAP), parent_tool_id: parent_tool_id.clone() },
            EventKind::ToolStart { tool_id, name, tool_kind, input, parent_tool_id } => {
                if secret_paths(input) {
                    self.hide(&e.agent_id, tool_id);
                }
                let mut budget = INPUT_TOTAL_CAP;
                EventKind::ToolStart { tool_id: tool_id.clone(), name: display(name, 80), tool_kind: *tool_kind, input: scrub_value(input, None, &mut budget), parent_tool_id: parent_tool_id.clone() }
            }
            EventKind::ToolUpdate { tool_id, status, output } => EventKind::ToolUpdate { tool_id: tool_id.clone(), status: *status, output: output.as_deref().map(|t| self.output(&e.agent_id, tool_id, t)) },
            EventKind::ToolResult { tool_id, status, output, duration_ms, .. } => {
                EventKind::ToolResult { tool_id: tool_id.clone(), status: *status, output: output.as_deref().map(|t| self.output(&e.agent_id, tool_id, t)), diff: None, duration_ms: *duration_ms }
            }
            // behaviour: host (remote spec 5.7: the phone gets a plan excerpt through its own field; until then it sees no plan, no
            // session-allow offer, no mode list and no "allow always in this session" option)
            EventKind::PermissionRequest { req_id, tool_id, intent, options, .. } => EventKind::PermissionRequest {
                req_id: req_id.clone(),
                tool_id: tool_id.clone(),
                intent: wire_intent(intent),
                options: options.iter().copied().filter(|o| *o != intely_agent_core::events::PermissionOption::AllowRun).collect(),
                session_allow: None,
                plan: None,
                plan_truncated: None,
                modes: Vec::new(),
            },
            EventKind::PermissionResolved { .. } => e.kind.clone(),
            EventKind::QuestionRequest { req_id, tool_id, prompt, options } => EventKind::QuestionRequest {
                req_id: req_id.clone(),
                tool_id: tool_id.clone(),
                prompt: display(prompt, 2048),
                options: options.iter().take(12).map(|o| intely_agent_core::events::QuestionOption { label: display(&o.label, 160), description: o.description.as_deref().map(|d| display(d, 300)) }).collect(),
            },
            EventKind::Plan { items } => EventKind::Plan {
                items: items.iter().take(40).map(|i| intely_agent_core::events::PlanItem { content: display(&i.content, 300), status: i.status.clone() }).collect(),
            },
            EventKind::Usage { .. } | EventKind::Status { .. } | EventKind::TurnEnd { .. } => e.kind.clone(),
            EventKind::Error { class, message, retryable } => EventKind::Error { class: *class, message: display(message, 1024), retryable: *retryable },
            EventKind::SessionInfo { title, caps, effective, .. } => {
                EventKind::SessionInfo { title: title.as_deref().map(|t| display(t, 120)), native_id: None, models: Vec::new(), caps: caps.clone(), effective: effective.clone(), delegates: Vec::new(), slash_commands: Vec::new(), mcp_servers: Vec::new() }
            }
        };
        Some(o)
    }

    fn output(&self, agent: &str, tool: &str, text: &str) -> String {
        if self.is_hidden(agent, tool) {
            return "[hidden: this tool touched a secret file]".to_string();
        }
        escape_invisible(&cap(&scrub_text(text), TOOL_OUTPUT_CAP))
    }

    /// The diff of one tool result for `diff.get`: secret paths are hidden, size capped.
    pub fn wire_diff(&self, d: &ToolDiff) -> Option<(String, Option<String>, String, bool)> {
        if is_secret_path(&d.path) {
            return None;
        }
        let trunc = d.new.len() > DIFF_CAP || d.old.as_ref().is_some_and(|o| o.len() > DIFF_CAP);
        let clip = |s: &str| -> String { escape_invisible(&scrub_text(&s.chars().take(DIFF_CAP / 2).collect::<String>())) };
        Some((display(&d.path, 400), d.old.as_deref().map(clip), clip(&d.new), trunc))
    }
}
