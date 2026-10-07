//! Import from Claude Code (MCP spec 3.3). The user picks a file; only its top-level `mcpServers` key is ever materialised. Secret values go
//! from the staged memory straight to the Keychain and are never displayed, logged or returned. Every entry goes through the same
//! `validate_entry` as `mcp_save`, in the preview and again in the apply. Importing never starts a process: the servers are created
//! disabled and unconfirmed.

use std::collections::{BTreeMap, HashSet};
use std::io::Read;
use std::path::Path;
use std::sync::{Mutex, PoisonError};

use intely_agent_core::mcp::McpPolicy;
use intely_settings::{name_looks_secret, Secret};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::error::{code, McpErr, Result};
use crate::model::{
    command_line, looks_credential, refused_header_name, refused_var_name, slugify, url_host, validate_entry, validate_name, Entry, McpServerRecord, McpVar, Origin, MAX_ENV, MAX_HEADERS, MAX_SERVERS,
};
use crate::store::{env_key, header_key, slot_keys, McpStore, Slot};
use crate::types::*;

const MAX_FILE: u64 = 16 << 20;
const TTL_MS: u64 = 5 * 60 * 1000;

/// A staged value. `Drop` overwrites it (best effort, no new dependency).
struct Wiped(String);

impl Wiped {
    fn new(s: &str) -> Self {
        Self(s.to_owned())
    }
}

impl Drop for Wiped {
    fn drop(&mut self) {
        let mut bytes = std::mem::take(&mut self.0).into_bytes();
        bytes.fill(0);
    }
}

struct StagedVar {
    name: String,
    secret: bool,
    /// A plain value, or the secret value read from the file; `None` for an unresolved `${VAR}` reference.
    value: Option<Wiped>,
}

struct StagedEntry {
    key: String,
    suggested: String,
    transport: Option<McpTransport>,
    command: Option<String>,
    args: Vec<String>,
    url: Option<String>,
    env: Vec<StagedVar>,
    headers: Vec<StagedVar>,
    issues: Vec<McpImportIssue>,
    conflict: bool,
}

impl StagedEntry {
    fn importable(&self) -> bool {
        self.transport.is_some() && self.issues.iter().all(|i| matches!(i, McpImportIssue::BadName | McpImportIssue::NameTaken | McpImportIssue::UnresolvedRef))
    }
}

struct Staged {
    id: String,
    expires_at: u64,
    entries: Vec<StagedEntry>,
}

/// One slot, one staged import at a time (replaced by the next preview, dropped by apply, by the TTL and at exit).
#[derive(Default)]
pub struct ImportState {
    slot: Mutex<Option<Staged>>,
}

impl ImportState {
    /// Test hook: whether anything is staged.
    pub fn is_staged(&self) -> bool {
        self.slot.lock().unwrap_or_else(PoisonError::into_inner).is_some()
    }
}

#[derive(Deserialize)]
struct ClaudeFile {
    #[serde(rename = "mcpServers", default)]
    mcp_servers: Option<BTreeMap<String, Value>>,
}

/// Names that are plain by default: they locate nothing and redirect nothing (3.3 step 2). `*_HOST`, `*_DIR`, `*_PATH`, `*_ENV`, `*_URL` and
/// `*_ENDPOINT` are deliberately NOT here.
fn benign_name(name: &str) -> bool {
    let up = name.to_ascii_uppercase();
    matches!(up.as_str(), "LOG_LEVEL" | "DEBUG" | "NODE_ENV" | "TZ" | "LANG") || up.ends_with("_PORT") || up.ends_with("_REGION") || up.ends_with("_ENVIRONMENT")
}

/// `user:pass@host` anywhere in a value.
fn has_userinfo(value: &str) -> bool {
    value.split_whitespace().any(|w| {
        let after_scheme = w.split_once("://").map_or(w, |(_, r)| r);
        after_scheme.split('/').next().is_some_and(|authority| authority.contains('@') && authority.split('@').next().is_some_and(|u| u.contains(':')))
    })
}

/// Claude Code's environment expansion: `${VAR}` and `${VAR:-x}`.
fn is_env_ref(value: &str) -> bool {
    value.contains("${")
}

fn issue_of(code_: &str) -> McpImportIssue {
    match code_ {
        code::RELATIVE_PATH => McpImportIssue::RelativePath,
        code::SECRET_IN_ARGS => McpImportIssue::SecretInArgs,
        code::SECRET_IN_URL => McpImportIssue::SecretInUrl,
        code::BAD_CHARS => McpImportIssue::BadChars,
        code::TOO_MANY => McpImportIssue::TooMany,
        code::BAD_VAR | code::EXEC_VAR | code::PLAIN_SECRET_NAME => McpImportIssue::BadVar,
        _ => McpImportIssue::BadCommand,
    }
}

fn push_issue(issues: &mut Vec<McpImportIssue>, i: McpImportIssue) {
    if !issues.contains(&i) {
        issues.push(i);
    }
}

fn staged_from(key: &str, obj: &Map<String, Value>, taken: &HashSet<String>) -> StagedEntry {
    let mut issues = Vec::new();
    let ty = obj.get("type").and_then(Value::as_str);
    let transport = match (ty, obj.get("command").is_some(), obj.get("url").is_some()) {
        (Some("stdio"), ..) | (None, true, _) => Some(McpTransport::Stdio),
        (Some("http" | "streamable-http"), ..) | (None, false, true) => Some(McpTransport::Http),
        _ => None,
    };
    let suggested = if validate_name(key).is_ok() { key.to_owned() } else { slugify(key) };
    if suggested != key {
        push_issue(&mut issues, McpImportIssue::BadName);
    }
    let conflict = taken.contains(&suggested);
    if conflict {
        push_issue(&mut issues, McpImportIssue::NameTaken);
    }
    let mut e = StagedEntry { key: key.to_owned(), suggested, transport, command: None, args: vec![], url: None, env: vec![], headers: vec![], issues, conflict };
    let Some(transport) = transport else {
        push_issue(&mut e.issues, McpImportIssue::UnsupportedTransport);
        return e;
    };
    match transport {
        McpTransport::Stdio => {
            match obj.get("command").and_then(Value::as_str) {
                Some(c) => e.command = Some(c.to_owned()),
                None => push_issue(&mut e.issues, McpImportIssue::BadCommand),
            }
            match obj.get("args") {
                None => {}
                Some(Value::Array(a)) => {
                    for item in a {
                        match item.as_str() {
                            Some(s) => e.args.push(s.to_owned()),
                            None => push_issue(&mut e.issues, McpImportIssue::BadCommand),
                        }
                    }
                }
                Some(_) => push_issue(&mut e.issues, McpImportIssue::BadCommand),
            }
            if let Some(env) = obj.get("env") {
                let Some(env) = env.as_object() else {
                    push_issue(&mut e.issues, McpImportIssue::BadVar);
                    return finish(e);
                };
                if env.len() > MAX_ENV {
                    push_issue(&mut e.issues, McpImportIssue::TooMany);
                }
                for (name, val) in env.iter().take(MAX_ENV + 1) {
                    classify_env(&mut e, name, val);
                }
            }
        }
        McpTransport::Http => {
            match obj.get("url").and_then(Value::as_str) {
                Some(u) => e.url = Some(u.trim().to_owned()),
                None => push_issue(&mut e.issues, McpImportIssue::BadCommand),
            }
            if let Some(h) = obj.get("headers") {
                let Some(h) = h.as_object() else {
                    push_issue(&mut e.issues, McpImportIssue::BadVar);
                    return finish(e);
                };
                if h.len() > MAX_HEADERS {
                    push_issue(&mut e.issues, McpImportIssue::TooMany);
                }
                for (name, val) in h.iter().take(MAX_HEADERS + 1) {
                    classify_header(&mut e, name, val);
                }
            }
        }
    }
    finish(e)
}

/// The allow-list of 3.3, in order: a refused name -> not importable; a benign name with an ordinary value -> plain; a secret-looking name
/// -> a hidden secret slot; every other name -> not importable. A `${VAR}` value is never expanded: the slot is created without a value.
fn classify_env(e: &mut StagedEntry, name: &str, val: &Value) {
    let Some(value) = val.as_str() else {
        push_issue(&mut e.issues, McpImportIssue::BadVar);
        return;
    };
    if refused_var_name(name) {
        push_issue(&mut e.issues, McpImportIssue::BadVar);
        return;
    }
    let secret_name = name_looks_secret(name);
    let benign = benign_name(name) && !secret_name;
    let reference = is_env_ref(value);
    if benign && !reference && !looks_credential(value) && !has_userinfo(value) {
        e.env.push(StagedVar { name: name.to_owned(), secret: false, value: Some(Wiped::new(value)) });
    } else if secret_name || (benign && reference) {
        if reference {
            push_issue(&mut e.issues, McpImportIssue::UnresolvedRef);
            e.env.push(StagedVar { name: name.to_owned(), secret: true, value: None });
        } else {
            e.env.push(StagedVar { name: name.to_owned(), secret: true, value: Some(Wiped::new(value)) });
        }
    } else {
        push_issue(&mut e.issues, McpImportIssue::BadVar);
    }
}

/// Headers are not subject to the allow-list: a header value of a remote service cannot make a local program run code. Every header is a
/// hidden secret slot (a name refused by 2.4 still makes the entry not importable).
fn classify_header(e: &mut StagedEntry, name: &str, val: &Value) {
    let Some(value) = val.as_str() else {
        push_issue(&mut e.issues, McpImportIssue::BadVar);
        return;
    };
    if refused_header_name(name) {
        push_issue(&mut e.issues, McpImportIssue::BadVar);
        return;
    }
    if is_env_ref(value) {
        push_issue(&mut e.issues, McpImportIssue::UnresolvedRef);
        e.headers.push(StagedVar { name: name.to_owned(), secret: true, value: None });
    } else {
        e.headers.push(StagedVar { name: name.to_owned(), secret: true, value: Some(Wiped::new(value)) });
    }
}

fn plain_vars(vars: &[StagedVar]) -> Vec<McpVar> {
    vars.iter().map(|v| McpVar { name: v.name.clone(), secret: v.secret, value: (!v.secret).then(|| v.value.as_ref().map(|w| w.0.clone()).unwrap_or_default()) }).collect()
}

/// The final validation of an entry, shared with `mcp_save`: the first rule it breaks becomes an issue.
fn finish(mut e: StagedEntry) -> StagedEntry {
    if let Some(transport) = e.transport {
        let env = plain_vars(&e.env);
        let headers = plain_vars(&e.headers);
        let entry = Entry { transport, command: e.command.as_deref().or(Some("")), args: &e.args, url: e.url.as_deref(), env: &env, headers: &headers };
        if let Err(err) = validate_entry(&entry) {
            push_issue(&mut e.issues, issue_of(&err.code));
        }
    }
    e
}

impl McpStore {
    /// Command 9, `mcp_import_preview`, after the Tauri layer redeemed the picker token into `path`.
    pub fn import_preview(&self, path: &Path) -> Result<McpImportPreview> {
        let invalid = |why: &str| McpErr::new(code::IMPORT_INVALID, why.to_owned());
        let mut file = std::fs::File::open(path).map_err(|_| invalid("the file cannot be opened"))?;
        let md = file.metadata().map_err(|_| invalid("the file cannot be read"))?;
        if !md.is_file() {
            return Err(invalid("that is not a regular file"));
        }
        if md.len() > MAX_FILE {
            return Err(invalid("the file is larger than 16 MiB"));
        }
        let mut buf = Vec::with_capacity(md.len() as usize);
        let read = file.read_to_end(&mut buf);
        let parsed = read.map_err(|_| invalid("the file cannot be read")).and_then(|_| {
            serde_json::from_slice::<ClaudeFile>(&buf).map_err(|e| invalid(&format!("the file is not valid JSON (line {}, column {})", e.line(), e.column())))
        });
        buf.fill(0);
        drop(buf);
        let servers = parsed?.mcp_servers.ok_or_else(|| invalid("the file has no mcpServers"))?;
        let l = self.load()?;
        let taken: HashSet<String> = l.records().map(|r| r.name.clone()).collect();
        let mut entries = Vec::new();
        let mut skipped = 0u32;
        for (key, value) in &servers {
            match value.as_object() {
                Some(obj) => entries.push(staged_from(key, obj, &taken)),
                None => skipped += 1,
            }
        }
        let preview_entries: Vec<McpImportEntry> = entries
            .iter()
            .map(|e| McpImportEntry {
                key: e.key.clone(),
                suggested_name: e.suggested.clone(),
                transport: match e.transport {
                    Some(McpTransport::Stdio) => "stdio",
                    Some(McpTransport::Http) => "http",
                    None => "unknown",
                }
                .to_owned(),
                command_line: e.command.as_deref().filter(|_| e.transport == Some(McpTransport::Stdio)).map(|c| command_line(c, &e.args)),
                url_host: e.url.as_deref().filter(|_| e.transport == Some(McpTransport::Http)).and_then(url_host),
                env: e.env.iter().map(|v| McpImportVar { name: v.name.clone(), secret: v.secret }).collect(),
                headers: e.headers.iter().map(|v| McpImportVar { name: v.name.clone(), secret: v.secret }).collect(),
                issues: e.issues.clone(),
                importable: e.importable(),
                conflict: e.conflict,
            })
            .collect();
        let id = uuid::Uuid::new_v4().simple().to_string();
        let expires_at = self.now() + TTL_MS;
        *self.imports.slot.lock().unwrap_or_else(PoisonError::into_inner) = Some(Staged { id: id.clone(), expires_at, entries });
        let file_name = path.file_name().map(|n| crate::model::escape_display(&n.to_string_lossy())).unwrap_or_default();
        Ok(McpImportPreview { import_id: id, file_name, entries: preview_entries, skipped_keys: skipped, expires_at })
    }

    /// Command 10, `mcp_import_apply`: creates each picked server DISABLED and UNCONFIRMED, writes its secrets straight to the Keychain, and
    /// clears the staged import (a second apply with the same id fails).
    pub fn import_apply(&self, import_id: &str, picks: &[McpImportPick]) -> Result<McpImportResult> {
        let staged = {
            let mut slot = self.imports.slot.lock().unwrap_or_else(PoisonError::into_inner);
            let now = self.now();
            // an expired preview is dropped whoever asks; an id that is not the staged one leaves the staged preview alone
            if slot.as_ref().is_some_and(|s| s.expires_at < now) {
                *slot = None;
            }
            match slot.take_if(|s| s.id == import_id) {
                Some(s) => s,
                None => return Err(McpErr::new(code::IMPORT_EXPIRED, "that import preview expired; choose the file again")),
            }
        };
        self.mutate_import(&staged, picks)
    }

    fn mutate_import(&self, staged: &Staged, picks: &[McpImportPick]) -> Result<McpImportResult> {
        let mut result = McpImportResult { imported: vec![], skipped: vec![] };
        let mut created_keys: Vec<String> = Vec::new();
        let mut removable: Vec<String> = Vec::new();
        let outcome = self.mutate(|l| {
            let now = self.now();
            for pick in picks {
                let skip = |reason: &str| McpImportSkipped { key: pick.key.clone(), reason: reason.to_owned() };
                let Some(entry) = staged.entries.iter().find(|e| e.key == pick.key) else {
                    result.skipped.push(skip("unknown"));
                    continue;
                };
                if !entry.importable() {
                    result.skipped.push(skip(entry.issues.first().map_or("notImportable", issue_name)));
                    continue;
                }
                if validate_name(&pick.name).is_err() {
                    result.skipped.push(skip("badName"));
                    continue;
                }
                let existing_id = l.records().find(|r| r.name == pick.name).map(|r| r.id.clone());
                if existing_id.is_some() && !pick.replace {
                    result.skipped.push(skip("nameTaken"));
                    continue;
                }
                if existing_id.is_none() && l.slots.len() >= MAX_SERVERS {
                    result.skipped.push(skip("tooMany"));
                    continue;
                }
                let transport = entry.transport.unwrap_or(McpTransport::Stdio);
                let id = existing_id.clone().unwrap_or_else(|| format!("m{}", &uuid::Uuid::new_v4().simple().to_string()[..12]));
                let mut rec = existing_id.as_deref().and_then(|i| l.find(i).cloned()).unwrap_or_else(|| McpServerRecord {
                    id: id.clone(),
                    name: pick.name.clone(),
                    transport,
                    command: None,
                    args: vec![],
                    url: None,
                    env: vec![],
                    headers: vec![],
                    enabled: false,
                    default_policy: McpPolicy::Ask,
                    tool_policies: vec![],
                    tools: vec![],
                    tools_tested_at: None,
                    tools_fingerprint: None,
                    server_info: None,
                    instructions_hash: None,
                    origin: Origin::Import,
                    created_at: now,
                    updated_at: now,
                    extra: Map::new(),
                });
                let old_keys = slot_keys(&rec);
                rec.transport = transport;
                rec.origin = Origin::Import;
                rec.enabled = false;
                rec.command = (transport == McpTransport::Stdio).then(|| entry.command.clone().unwrap_or_default());
                rec.args = if transport == McpTransport::Stdio { entry.args.clone() } else { vec![] };
                rec.url = (transport == McpTransport::Http).then(|| entry.url.clone().unwrap_or_default());
                rec.env = if transport == McpTransport::Stdio { plain_vars(&entry.env) } else { vec![] };
                rec.headers = if transport == McpTransport::Http { plain_vars(&entry.headers) } else { vec![] };
                rec.updated_at = now;
                // the same validation as mcp_save, again: "importable" in the preview and the outcome here cannot disagree
                if let Err(e) = validate_entry(&rec.entry()) {
                    result.skipped.push(skip(&e.code));
                    continue;
                }
                for (header, vars) in [(false, &entry.env), (true, &entry.headers)] {
                    for v in vars.iter().filter(|v| v.secret) {
                        let Some(value) = &v.value else { continue };
                        let key = if header { header_key(&id, &v.name) } else { env_key(&id, &v.name) };
                        if !self.secrets.has(&key).unwrap_or(false) {
                            created_keys.push(key.clone());
                        }
                        self.secrets.set(&key, Secret::new(value.0.clone()))?;
                    }
                }
                let keep: HashSet<String> = slot_keys(&rec).into_iter().collect();
                removable.extend(old_keys.into_iter().filter(|k| !keep.contains(k)));
                match l.slots.iter_mut().find(|s| matches!(s, Slot::Ok(r) if r.id == id)) {
                    Some(slot) => *slot = Slot::Ok(Box::new(rec)),
                    None => l.slots.push(Slot::Ok(Box::new(rec))),
                }
                result.imported.push(McpImportedServer { key: pick.key.clone(), id });
            }
            Ok(())
        });
        match outcome {
            Ok(()) => {
                for k in removable {
                    let _ = self.secrets.remove(&k);
                }
                Ok(result)
            }
            Err(e) => {
                for k in created_keys {
                    let _ = self.secrets.remove(&k);
                }
                Err(e)
            }
        }
    }

    /// Drops a staged import (the Tauri layer calls it at exit).
    pub fn import_clear(&self) {
        *self.imports.slot.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }
}

fn issue_name(i: &McpImportIssue) -> &'static str {
    match i {
        McpImportIssue::UnsupportedTransport => "unsupportedTransport",
        McpImportIssue::BadName => "badName",
        McpImportIssue::NameTaken => "nameTaken",
        McpImportIssue::SecretInArgs => "secretInArgs",
        McpImportIssue::SecretInUrl => "secretInUrl",
        McpImportIssue::UnresolvedRef => "unresolvedRef",
        McpImportIssue::BadCommand => "badCommand",
        McpImportIssue::BadVar => "badVar",
        McpImportIssue::BadChars => "badChars",
        McpImportIssue::RelativePath => "relativePath",
        McpImportIssue::TooMany => "tooMany",
    }
}
