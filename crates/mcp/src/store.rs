//! The config store of the MCP spec (2): the `mcp` namespace of `settings.json`, the secret slots and the confirmation proof in the
//! Keychain (through the `SecretStore`), and the commands that change them. Everything is re-read from the settings store at every
//! command; nothing in the file is trusted as proof of anything (the proof is a Keychain item, 2.4).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use intely_agent_core::mcp::{fit, normalize_tool_name, McpPolicy, RESOURCES_TOOL};
use intely_core::jail::{Jail, Mode};
use intely_settings::secrets::redact;
use intely_settings::{Secret, SecretStore, SettingsStore};
use serde_json::{json, Map, Value};

use crate::codefiles::{code_files, code_lines, default_temp_dirs, short_digest, CodeFile, DigestCache};
use crate::error::{code, McpErr, Result};
use crate::imports::ImportState;
use crate::model::{
    args_display_form, blocked_by_default, colliding_keys, command_line, confirm_hash, escape_display, fetches_code, validate_name, validate_policy_tool, validate_record, url_host, McpServerRecord,
    McpToolRecord, McpVar, Origin, ToolPolicyEntry, MAX_SERVERS,
};
use crate::types::*;

pub const NS: &str = "mcp";
/// The shape version of the namespace (2.7).
pub const SCHEMA: u64 = 1;

pub type EnvFn = Arc<dyn Fn() -> BTreeMap<String, String> + Send + Sync>;
pub type AuthModeFn = Arc<dyn Fn() -> String + Send + Sync>;
pub type ClockFn = Arc<dyn Fn() -> u64 + Send + Sync>;

/// What the store needs from the host application. `env` is the SCRUBBED login environment (the Tauri layer passes
/// `scrub_env(login env)`): the PATH that bare commands are resolved on and the base environment of a Test child.
#[derive(Clone)]
pub struct StoreConfig {
    pub env: EnvFn,
    /// The auth mode of the Claude provider (`subscription`, `apiKey`, ...): a run that selects servers is refused in `apiKey` mode (5.5).
    pub auth_mode: AuthModeFn,
    pub jail: Arc<Jail>,
    /// Code under these directories is refused. Only applied while the jail is off (under the E2E jail every configured server is a fixture).
    pub temp_dirs: Vec<PathBuf>,
    pub state_dirs: Vec<PathBuf>,
    pub now_ms: ClockFn,
    /// `clientInfo.version` of the Test and the `User-Agent`.
    pub client_version: String,
}

impl StoreConfig {
    /// Sensible defaults for tests and tools: PATH of this process, subscription auth, system clock.
    pub fn new(jail: Arc<Jail>) -> Self {
        Self {
            env: Arc::new(|| std::env::var("PATH").map(|p| BTreeMap::from([("PATH".to_owned(), p)])).unwrap_or_default()),
            auth_mode: Arc::new(|| "subscription".to_owned()),
            jail,
            temp_dirs: default_temp_dirs(),
            state_dirs: vec![intely_settings::store::state_dir()],
            now_ms: Arc::new(system_now_ms),
            client_version: env!("CARGO_PKG_VERSION").to_owned(),
        }
    }
}

pub fn system_now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

// ---- Keychain key names (2.8) -----------------------------------------------------------------------------------------------------

pub fn env_key(id: &str, name: &str) -> String {
    format!("mcp.{id}:env.{name}")
}

pub fn header_key(id: &str, name: &str) -> String {
    format!("mcp.{id}:hdr.{name}")
}

pub fn proof_key(id: &str) -> String {
    format!("mcp.{id}:confirmed")
}

/// The Keychain keys of the secret slots of a record (not the proof).
pub fn slot_keys(rec: &McpServerRecord) -> Vec<String> {
    let env = rec.env.iter().filter(|v| v.secret).map(|v| env_key(&rec.id, &v.name));
    let hdr = rec.headers.iter().filter(|v| v.secret).map(|v| header_key(&rec.id, &v.name));
    env.chain(hdr).collect()
}

fn new_id() -> String {
    format!("m{}", &uuid::Uuid::new_v4().simple().to_string()[..12])
}

// ---- the loaded namespace ----------------------------------------------------------------------------------------------------------

/// One entry of `servers`: a record, or the raw JSON of an entry that did not load (kept as it was, 2.7).
pub(crate) enum Slot {
    Ok(Box<McpServerRecord>),
    Bad { raw: Value, reason: String },
}

pub(crate) struct WsEntry {
    pub workspace_id: String,
    /// `(server id, enabled)`.
    pub overrides: Vec<(String, bool)>,
}

pub(crate) struct Loaded {
    pub schema: u64,
    pub newer: bool,
    pub slots: Vec<Slot>,
    pub workspaces: Vec<WsEntry>,
}

impl Loaded {
    pub fn records(&self) -> impl Iterator<Item = &McpServerRecord> {
        self.slots.iter().filter_map(|s| if let Slot::Ok(r) = s { Some(&**r) } else { None })
    }

    pub fn find(&self, id: &str) -> Option<&McpServerRecord> {
        self.records().find(|r| r.id == id)
    }

    pub fn find_mut(&mut self, id: &str) -> Option<&mut McpServerRecord> {
        self.slots.iter_mut().find_map(|s| match s {
            Slot::Ok(r) if r.id == id => Some(&mut **r),
            _ => None,
        })
    }

    pub fn ws_override(&self, workspace_id: &str, server_id: &str) -> Option<bool> {
        self.workspaces.iter().find(|w| w.workspace_id == workspace_id).and_then(|w| w.overrides.iter().find(|(s, _)| s == server_id)).map(|(_, e)| *e)
    }
}

pub struct McpStore {
    pub(crate) settings: Arc<SettingsStore>,
    pub(crate) secrets: Arc<dyn SecretStore>,
    pub(crate) cfg: StoreConfig,
    write: Mutex<()>,
    proofs: Mutex<HashMap<String, Option<String>>>,
    pub(crate) digests: DigestCache,
    pub(crate) tests: Mutex<HashSet<String>>,
    pub(crate) imports: ImportState,
}

impl McpStore {
    pub fn new(settings: Arc<SettingsStore>, secrets: Arc<dyn SecretStore>, cfg: StoreConfig) -> Self {
        Self { settings, secrets, cfg, write: Mutex::new(()), proofs: Mutex::new(HashMap::new()), digests: DigestCache::default(), tests: Mutex::new(HashSet::new()), imports: ImportState::default() }
    }

    pub fn config(&self) -> &StoreConfig {
        &self.cfg
    }

    pub fn secrets(&self) -> &Arc<dyn SecretStore> {
        &self.secrets
    }

    pub(crate) fn now(&self) -> u64 {
        (self.cfg.now_ms)()
    }

    pub(crate) fn path_env(&self) -> String {
        (self.cfg.env)().get("PATH").cloned().or_else(|| std::env::var("PATH").ok()).unwrap_or_default()
    }

    pub(crate) fn jail_mode(&self) -> Mode {
        self.cfg.jail.mode()
    }

    // ---- load and persist ---------------------------------------------------------------------------------------------------------

    pub(crate) fn load(&self) -> Result<Loaded> {
        let ns = self.settings.get(NS)?;
        let schema = ns.get("schema").and_then(Value::as_u64).unwrap_or(SCHEMA);
        let raw_servers = ns.get("servers").and_then(Value::as_array).cloned().unwrap_or_default();
        let slots = raw_servers
            .into_iter()
            .map(|raw| match serde_json::from_value::<McpServerRecord>(raw.clone()) {
                Ok(mut rec) => {
                    // a `confirmedHash` found in the file (a hand edit, an older draft) proves nothing and is dropped at the next save
                    rec.extra.remove("confirmedHash");
                    Slot::Ok(Box::new(rec))
                }
                Err(_) => Slot::Bad { raw, reason: "the entry is not a valid server record".to_owned() },
            })
            .collect();
        let workspaces = ns
            .get("workspaces")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|w| {
                        let workspace_id = w.get("workspaceId")?.as_str()?.to_owned();
                        let overrides = w.get("overrides")?.as_array()?.iter().filter_map(|o| Some((o.get("serverId")?.as_str()?.to_owned(), o.get("enabled")?.as_bool()?))).collect();
                        Some(WsEntry { workspace_id, overrides })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(Loaded { schema, newer: schema > SCHEMA, slots, workspaces })
    }

    fn persist(&self, l: &Loaded) -> Result<()> {
        let servers: Vec<Value> = l
            .slots
            .iter()
            .map(|s| match s {
                Slot::Ok(r) => serde_json::to_value(&**r).map_err(|e| McpErr::new(code::IO, e.to_string())),
                Slot::Bad { raw, .. } => Ok(raw.clone()),
            })
            .collect::<Result<_>>()?;
        let workspaces: Vec<Value> = l
            .workspaces
            .iter()
            .filter(|w| !w.overrides.is_empty())
            .map(|w| json!({ "workspaceId": w.workspace_id, "overrides": w.overrides.iter().map(|(s, e)| json!({ "serverId": s, "enabled": e })).collect::<Vec<_>>() }))
            .collect();
        let mut patch = Map::new();
        patch.insert("schema".into(), json!(SCHEMA));
        patch.insert("servers".into(), Value::Array(servers));
        patch.insert("workspaces".into(), Value::Array(workspaces));
        self.settings.set(NS, patch)?;
        Ok(())
    }

    fn unsupported() -> McpErr {
        McpErr::new(code::UNSUPPORTED_VERSION, "the MCP settings were written by a newer version of this app and are left untouched")
    }

    /// Runs `f` on the freshly loaded namespace under the write lock and persists the result.
    pub(crate) fn mutate<R>(&self, f: impl FnOnce(&mut Loaded) -> Result<R>) -> Result<R> {
        let _guard = self.write.lock().unwrap_or_else(PoisonError::into_inner);
        let mut l = self.load()?;
        if l.newer {
            return Err(Self::unsupported());
        }
        let r = f(&mut l)?;
        self.persist(&l)?;
        Ok(r)
    }

    // ---- the proof ------------------------------------------------------------------------------------------------------------------

    /// The confirmation proof of a server: the Keychain item, read once per process (2.9). A failing store reads as "no proof".
    pub(crate) fn proof(&self, id: &str) -> Option<String> {
        let mut cache = self.proofs.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(v) = cache.get(id) {
            return v.clone();
        }
        let v = self.secrets.get(&proof_key(id)).ok().flatten().map(|s| s.expose().to_owned());
        cache.insert(id.to_owned(), v.clone());
        v
    }

    fn set_proof_cache(&self, id: &str, v: Option<String>) {
        self.proofs.lock().unwrap_or_else(PoisonError::into_inner).insert(id.to_owned(), v);
    }

    /// The files the proof vouches for, with the CURRENT content.
    pub(crate) fn code_info(&self, rec: &McpServerRecord) -> Result<Vec<CodeFile>> {
        code_files(rec, &self.path_env(), &self.digests)
    }

    /// `confirmHash` of the record as it is now (re-reads and re-hashes the code files).
    pub(crate) fn current_hash(&self, rec: &McpServerRecord) -> Result<String> {
        Ok(confirm_hash(&rec.entry(), &code_lines(&self.code_info(rec)?)))
    }

    pub(crate) fn is_confirmed(&self, rec: &McpServerRecord) -> bool {
        self.current_hash(rec).ok().is_some_and(|h| self.proof(&rec.id).as_deref() == Some(h.as_str()))
    }

    /// A required secret slot has no Keychain item.
    pub(crate) fn secret_missing(&self, rec: &McpServerRecord) -> bool {
        slot_keys(rec).iter().any(|k| !self.secrets.has(k).unwrap_or(false))
    }

    // ---- views ----------------------------------------------------------------------------------------------------------------------

    pub(crate) fn is_fresh(rec: &McpServerRecord) -> bool {
        rec.tools_tested_at.is_some() && rec.tools_fingerprint.as_deref() == Some(rec.fingerprint().as_str())
    }

    fn var_views(&self, rec: &McpServerRecord, vars: &[McpVar], header: bool) -> Vec<McpVarView> {
        vars.iter()
            .map(|v| {
                let present = if v.secret { self.secrets.has(&if header { header_key(&rec.id, &v.name) } else { env_key(&rec.id, &v.name) }).unwrap_or(false) } else { true };
                McpVarView { name: v.name.clone(), secret: v.secret, value: (!v.secret).then(|| v.value.clone().unwrap_or_default()), present }
            })
            .collect()
    }

    pub(crate) fn tool_views(rec: &McpServerRecord) -> Vec<McpToolView> {
        let colliding = colliding_keys(&rec.name, &rec.tools);
        let stale = !Self::is_fresh(rec);
        let eff = effective_policies(rec);
        rec.tools
            .iter()
            .map(|t| {
                let ov = rec.override_for(&t.key);
                let collision = colliding.contains(&t.key);
                McpToolView {
                    name: t.name.clone(),
                    key: t.key.clone(),
                    title: t.title.clone(),
                    description: t.description.clone(),
                    read_only: t.read_only && !stale && !collision,
                    read_only_hint: t.read_only_hint,
                    destructive_hint: t.destructive_hint,
                    policy: ov.map(|o| o.policy),
                    effective_policy: eff.get(&t.key).copied().unwrap_or(rec.default_policy),
                    collision: collision.then_some(true),
                    blocked_by_default: blocked_by_default(&t.key, t.destructive_hint),
                    seeded: ov.is_some_and(|o| o.seeded),
                }
            })
            .collect()
    }

    pub(crate) fn view(&self, rec: &McpServerRecord) -> McpServerView {
        let files = self.code_info(rec);
        let (hash, code_view) = match &files {
            Ok(f) => (confirm_hash(&rec.entry(), &code_lines(f)), f.iter().map(|f| McpCodeFile { path: escape_display(&f.path.to_string_lossy()), sha256: short_digest(&f.digest) }).collect()),
            Err(_) => (String::new(), Vec::new()),
        };
        let confirmed = files.is_ok() && self.proof(&rec.id).as_deref() == Some(hash.as_str());
        let valid = validate_record(rec).is_ok() && files.is_ok();
        let state = if !valid {
            McpState::Invalid
        } else if !confirmed {
            McpState::NeedsConfirm
        } else if self.secret_missing(rec) {
            McpState::SecretMissing
        } else {
            McpState::Ready
        };
        let tools = Self::tool_views(rec);
        let listed: HashSet<&str> = rec.tools.iter().map(|t| t.key.as_str()).collect();
        let stale_tool_policies = rec.tool_policies.iter().filter(|p| !listed.contains(p.tool.as_str())).map(|p| McpStalePolicy { tool: p.tool.clone(), policy: p.policy }).collect();
        McpServerView {
            id: rec.id.clone(),
            name: rec.name.clone(),
            transport: rec.transport,
            command: rec.command.clone(),
            args: rec.args.clone(),
            url: rec.url.clone(),
            env: self.var_views(rec, &rec.env, false),
            headers: self.var_views(rec, &rec.headers, true),
            enabled: rec.enabled,
            default_policy: rec.default_policy,
            tools_tested_at: rec.tools_tested_at.map(|t| t as f64),
            tools_stale: rec.tools_tested_at.is_some() && !Self::is_fresh(rec),
            stale_tool_policies,
            server_info: rec.server_info.as_ref().map(|s| McpServerInfoView { name: s.name.clone(), version: s.version.clone(), protocol_version: s.protocol_version.clone() }),
            state,
            confirmed,
            imported: rec.origin == Origin::Import,
            confirm_hash: hash,
            command_line: rec.command.as_deref().filter(|_| rec.transport == McpTransport::Stdio).map(|c| command_line(c, &rec.args)),
            args_display: rec.args.iter().map(|a| args_display_form(a)).collect(),
            url_host: rec.url.as_deref().filter(|_| rec.transport == McpTransport::Http).and_then(url_host),
            code_files: code_view,
            fetches_code: fetches_code(rec.command.as_deref(), &rec.args),
            tools,
            created_at: rec.created_at as f64,
            updated_at: rec.updated_at as f64,
        }
    }

    // ---- commands -------------------------------------------------------------------------------------------------------------------

    /// Command 1, `mcp_list`.
    pub fn list(&self, workspace_id: Option<&str>) -> Result<McpList> {
        let l = self.load()?;
        let servers = l.records().map(|r| self.view(r)).collect();
        let problems = l.slots.iter().enumerate().filter_map(|(i, s)| if let Slot::Bad { reason, .. } = s { Some(McpProblem { index: i as u32, reason: reason.clone() }) } else { None }).collect();
        let overrides = workspace_id
            .map(|w| l.workspaces.iter().filter(|e| e.workspace_id == w).flat_map(|e| e.overrides.iter()).map(|(s, on)| McpWorkspaceOverride { server_id: s.clone(), state: if *on { McpWorkspaceState::On } else { McpWorkspaceState::Off } }).collect())
            .unwrap_or_default();
        let health = self.secrets.health();
        Ok(McpList {
            schema: l.schema as u32,
            servers,
            workspace: McpWorkspaceView { id: workspace_id.map(str::to_owned), overrides },
            secrets: McpSecretsView { backend: health.backend.to_owned(), degraded: health.degraded, message: health.message.map(|m| redact(&m)) },
            jail: match self.jail_mode() {
                Mode::Off => McpJail::Off,
                Mode::ReadOnly => McpJail::ReadOnly,
                Mode::E2e => McpJail::E2e,
            },
            read_only_reason: l.newer.then(|| "newerSchema".to_owned()),
            problems,
        })
    }

    /// Command 2, `mcp_save`: create (no id) or replace (id). Secrets are written first, then the namespace; the items written just now are
    /// deleted again when the namespace write fails.
    pub fn save(&self, input: McpSaveInput) -> Result<McpServerView> {
        let _guard = self.write.lock().unwrap_or_else(PoisonError::into_inner);
        let mut l = self.load()?;
        if l.newer {
            return Err(Self::unsupported());
        }
        let existing = match input.id.as_deref() {
            Some(id) => Some(l.find(id).cloned().ok_or_else(|| McpErr::new(code::UNKNOWN_SERVER, "that server does not exist"))?),
            None => None,
        };
        validate_name(&input.name)?;
        if l.records().any(|r| r.name == input.name && Some(&r.id) != existing.as_ref().map(|e| &e.id)) {
            return Err(McpErr::new(code::NAME_TAKEN, "a server with that name already exists").with_detail("name"));
        }
        if existing.is_none() && l.slots.len() >= MAX_SERVERS {
            return Err(McpErr::new(code::TOO_MANY, "at most 32 servers").with_detail("servers"));
        }
        let id = existing.as_ref().map_or_else(new_id, |e| e.id.clone());
        let stdio = input.transport == McpTransport::Stdio;
        let to_vars = |v: &Option<Vec<McpVarInput>>| -> Vec<McpVar> {
            v.iter().flatten().map(|v| McpVar { name: v.name.clone(), secret: v.secret, value: (!v.secret).then(|| v.value.clone().unwrap_or_default()) }).collect()
        };
        let (env_in, hdr_in) = if stdio { (input.env.clone(), None) } else { (None, input.headers.clone()) };
        let mut rec = existing.clone().unwrap_or_else(|| McpServerRecord {
            id: id.clone(),
            name: input.name.clone(),
            transport: input.transport,
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
            origin: Origin::Manual,
            created_at: self.now(),
            updated_at: self.now(),
            extra: Map::new(),
        });
        rec.name = input.name.clone();
        rec.transport = input.transport;
        rec.command = stdio.then(|| input.command.clone().unwrap_or_default());
        rec.args = if stdio { input.args.clone().unwrap_or_default() } else { vec![] };
        rec.url = (!stdio).then(|| input.url.clone().unwrap_or_default().trim().to_owned());
        rec.env = to_vars(&env_in);
        rec.headers = to_vars(&hdr_in);
        rec.enabled = input.enabled;
        rec.updated_at = self.now();
        crate::model::validate_entry(&rec.entry())?;
        // the secret values the caller sent, keyed by their Keychain item
        let mut writes: Vec<(String, String)> = Vec::new();
        for (kind_header, ins) in [(false, env_in.as_deref().unwrap_or_default()), (true, hdr_in.as_deref().unwrap_or_default())] {
            for v in ins.iter().filter(|v| v.secret) {
                if let Some(sv) = &v.secret_value {
                    if sv.is_empty() || sv.len() > crate::model::MAX_VALUE_LEN || sv.contains('\0') {
                        return Err(McpErr::new(code::BAD_SECRET, "a secret value is 1 to 8192 characters").with_detail(format!("{}:{}", if kind_header { "headers" } else { "env" }, v.name)));
                    }
                    writes.push((if kind_header { header_key(&id, &v.name) } else { env_key(&id, &v.name) }, sv.clone()));
                }
            }
        }
        let mut created: Vec<String> = Vec::new();
        for (key, value) in &writes {
            let was_there = self.secrets.has(key).unwrap_or(false);
            if let Err(e) = self.secrets.set(key, Secret::new(value.clone())) {
                self.rollback(&created);
                return Err(e.into());
            }
            if !was_there {
                created.push(key.clone());
            }
        }
        let keep: HashSet<String> = slot_keys(&rec).into_iter().collect();
        let stale_items: Vec<String> = existing.as_ref().map(|e| slot_keys(e).into_iter().filter(|k| !keep.contains(k)).collect()).unwrap_or_default();
        match l.slots.iter_mut().find(|s| matches!(s, Slot::Ok(r) if r.id == id)) {
            Some(slot) => *slot = Slot::Ok(Box::new(rec.clone())),
            None => l.slots.push(Slot::Ok(Box::new(rec.clone()))),
        }
        if let Err(e) = self.persist(&l) {
            self.rollback(&created);
            return Err(e);
        }
        for key in stale_items {
            let _ = self.secrets.remove(&key);
        }
        Ok(self.view(&rec))
    }

    fn rollback(&self, keys: &[String]) {
        for k in keys {
            let _ = self.secrets.remove(k);
        }
    }

    /// Command 3, `mcp_remove`. `index:<n>` removes an entry of `problems`.
    pub fn remove(&self, id: &str) -> Result<()> {
        let removed = self.mutate(|l| {
            if let Some(n) = id.strip_prefix("index:") {
                let i: usize = n.parse().map_err(|_| McpErr::new(code::UNKNOWN_SERVER, "not a problem entry"))?;
                return match l.slots.get(i) {
                    Some(Slot::Bad { .. }) => {
                        l.slots.remove(i);
                        Ok(None)
                    }
                    _ => Err(McpErr::new(code::UNKNOWN_SERVER, "not a problem entry")),
                };
            }
            let pos = l.slots.iter().position(|s| matches!(s, Slot::Ok(r) if r.id == id)).ok_or_else(|| McpErr::new(code::UNKNOWN_SERVER, "that server does not exist"))?;
            let Slot::Ok(rec) = l.slots.remove(pos) else { unreachable!("matched above") };
            for w in &mut l.workspaces {
                w.overrides.retain(|(s, _)| s != id);
            }
            l.workspaces.retain(|w| !w.overrides.is_empty());
            Ok(Some(rec))
        })?;
        if let Some(rec) = removed {
            let mut failed = Vec::new();
            for key in slot_keys(&rec).into_iter().chain([proof_key(&rec.id)]) {
                if self.secrets.remove(&key).is_err() {
                    failed.push(key.rsplit(':').next().unwrap_or_default().to_owned());
                }
            }
            self.set_proof_cache(&rec.id, None);
            if !failed.is_empty() {
                // the record is gone anyway; name what could not be removed
                return Err(McpErr::new(code::KEYCHAIN, "the server was removed, but some Keychain items could not be").with_detail(failed.join(", ")));
            }
        }
        Ok(())
    }

    /// Command 4, `mcp_set_enabled`: switching ON needs a confirmed record (`detail` = the current confirm hash), switching off never does.
    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<McpServerView> {
        if enabled {
            let l = self.load()?;
            let rec = l.find(id).ok_or_else(|| McpErr::new(code::UNKNOWN_SERVER, "that server does not exist"))?;
            if !self.is_confirmed(rec) {
                let hash = self.current_hash(rec).unwrap_or_default();
                return Err(McpErr::new(code::CONFIRMATION_REQUIRED, "confirm what this server runs first").with_detail(hash));
            }
        }
        let rec = self.mutate(|l| {
            let rec = l.find_mut(id).ok_or_else(|| McpErr::new(code::UNKNOWN_SERVER, "that server does not exist"))?;
            rec.enabled = enabled;
            rec.updated_at = system_now_ms();
            Ok(rec.clone())
        })?;
        Ok(self.view(&rec))
    }

    /// Command 5, `mcp_confirm`: writes the Keychain proof only when `confirm_hash` equals the RECOMPUTED hash, the code files re-read at
    /// this moment, so a dialog cannot confirm text the user did not see.
    pub fn confirm(&self, id: &str, confirm_hash_in: &str) -> Result<McpServerView> {
        let _guard = self.write.lock().unwrap_or_else(PoisonError::into_inner);
        let l = self.load()?;
        if l.newer {
            return Err(Self::unsupported());
        }
        let rec = l.find(id).ok_or_else(|| McpErr::new(code::UNKNOWN_SERVER, "that server does not exist"))?;
        validate_record(rec).map_err(|e| McpErr::new(code::BAD_CONFIG, format!("the stored server no longer validates: {}", e.message)))?;
        let current = self.current_hash(rec)?;
        if current != confirm_hash_in {
            return Err(McpErr::new(code::CONFIRMATION_REQUIRED, "what this server runs changed while you were looking; review it again").with_detail(current));
        }
        self.secrets.set(&proof_key(id), Secret::new(current.clone()))?;
        self.set_proof_cache(id, Some(current));
        Ok(self.view(rec))
    }

    /// Command 6, `mcp_workspace_set`.
    pub fn workspace_set(&self, workspace_id: &str, server_id: &str, state: McpWorkspaceState) -> Result<McpList> {
        if workspace_id.is_empty() {
            return Err(McpErr::new(code::NO_WORKSPACE, "open a workspace first"));
        }
        self.mutate(|l| {
            if l.find(server_id).is_none() {
                return Err(McpErr::new(code::UNKNOWN_SERVER, "that server does not exist"));
            }
            let at = match l.workspaces.iter().position(|w| w.workspace_id == workspace_id) {
                Some(i) => i,
                None => {
                    l.workspaces.push(WsEntry { workspace_id: workspace_id.to_owned(), overrides: vec![] });
                    l.workspaces.len() - 1
                }
            };
            let entry = &mut l.workspaces[at];
            entry.overrides.retain(|(s, _)| s != server_id);
            match state {
                McpWorkspaceState::Inherit => {}
                McpWorkspaceState::On => entry.overrides.push((server_id.to_owned(), true)),
                McpWorkspaceState::Off => entry.overrides.push((server_id.to_owned(), false)),
            }
            l.workspaces.retain(|w| !w.overrides.is_empty());
            Ok(())
        })?;
        self.list(Some(workspace_id))
    }

    /// Command 7, `mcp_set_policy`. A seeded (blocked by default) tool can only be loosened or un-set with `acknowledgeBlocked`.
    pub fn set_policy(&self, id: &str, patch: McpPolicyPatch) -> Result<McpServerView> {
        for t in patch.tools.iter().flatten() {
            validate_policy_tool(&t.tool)?;
        }
        let rec = self.mutate(|l| {
            let rec = l.find_mut(id).ok_or_else(|| McpErr::new(code::UNKNOWN_SERVER, "that server does not exist"))?;
            // validate everything before changing anything
            for t in patch.tools.iter().flatten() {
                let seeded = rec.override_for(&t.tool).is_some_and(|o| o.seeded);
                if seeded && t.policy != Some(McpPolicy::Deny) && t.acknowledge_blocked != Some(true) {
                    return Err(McpErr::new(code::BLOCKED_BY_DEFAULT, "this tool looks like it commits, pushes or deploys and is blocked by default; confirm to change it").with_detail(t.tool.clone()));
                }
            }
            if let Some(p) = patch.default_policy {
                rec.default_policy = p;
            }
            for t in patch.tools.iter().flatten() {
                let seeded_and_unchanged = t.policy == Some(McpPolicy::Deny) && rec.override_for(&t.tool).is_some_and(|o| o.seeded);
                if seeded_and_unchanged {
                    continue;
                }
                rec.tool_policies.retain(|o| o.tool != t.tool);
                if let Some(policy) = t.policy {
                    rec.tool_policies.push(ToolPolicyEntry { tool: t.tool.clone(), policy, seeded: false });
                }
            }
            if rec.tool_policies.len() > crate::model::MAX_TOOLS * 2 {
                return Err(McpErr::new(code::TOO_MANY, "too many rules").with_detail("tools"));
            }
            rec.updated_at = system_now_ms();
            Ok(rec.clone())
        })?;
        Ok(self.view(&rec))
    }

    /// Command 11, `mcp_secrets_present`: attributes only, no Keychain prompt.
    pub fn secrets_present(&self, ids: Option<&[String]>) -> Result<Vec<McpSecretPresence>> {
        let l = self.load()?;
        let mut out = Vec::new();
        for rec in l.records().filter(|r| ids.is_none_or(|ids| ids.contains(&r.id))) {
            for v in rec.env.iter().filter(|v| v.secret) {
                out.push(McpSecretPresence { server_id: rec.id.clone(), slot: format!("env:{}", v.name), present: self.secrets.has(&env_key(&rec.id, &v.name)).unwrap_or(false) });
            }
            for v in rec.headers.iter().filter(|v| v.secret) {
                out.push(McpSecretPresence { server_id: rec.id.clone(), slot: format!("hdr:{}", v.name), present: self.secrets.has(&header_key(&rec.id, &v.name)).unwrap_or(false) });
            }
        }
        Ok(out)
    }

    /// A tool list as the Test learned it, as records (names sanitised by the probe; keys normalised here).
    pub(crate) fn tool_records(tools: &[crate::probe::ProbedTool]) -> Vec<McpToolRecord> {
        tools
            .iter()
            .map(|t| McpToolRecord {
                name: t.name.clone(),
                key: normalize_tool_name(&t.name),
                title: t.title.clone(),
                description: t.description.clone(),
                read_only: t.read_only_hint == Some(true),
                read_only_hint: t.read_only_hint,
                destructive_hint: t.destructive_hint,
            })
            .collect()
    }
}

/// The effective policy of every learned tool key: the override or the server default, and for tools whose fitted keys collide the
/// STRICTER policy of the colliding tools (2.3).
pub fn effective_policies(rec: &McpServerRecord) -> BTreeMap<String, McpPolicy> {
    let mut by_fit: BTreeMap<String, McpPolicy> = BTreeMap::new();
    for t in &rec.tools {
        let eff = rec.override_for(&t.key).map_or(rec.default_policy, |o| o.policy);
        by_fit.entry(fit(&rec.name, &t.key)).and_modify(|p| *p = p.stricter(eff)).or_insert(eff);
    }
    rec.tools.iter().map(|t| (t.key.clone(), by_fit[&fit(&rec.name, &t.key)])).collect()
}

/// The broker's rules for one server (5.1), keyed by `fit(server_name, key)`. `server_name` is the name the RUN knows the server by, so a
/// live update lines up with the snapshot taken at the start even after a rename. A stale tool list (`fresh == false`) loses every
/// read-only flag; overrides stay.
pub fn build_rules(rec: &McpServerRecord, server_name: &str, fresh: bool) -> intely_agent_core::mcp::McpServerRules {
    use intely_agent_core::mcp::{McpServerRules, McpToolRule};
    let colliding = colliding_keys(server_name, &rec.tools);
    let mut tools: BTreeMap<String, McpToolRule> = BTreeMap::new();
    for t in &rec.tools {
        let fitted = fit(server_name, &t.key);
        let ov = rec.override_for(&t.key).map(|o| o.policy);
        match tools.get_mut(&fitted) {
            Some(existing) => {
                // two tools, one exposed name: no read-only flag, and the stricter policy wins
                existing.read_only = false;
                let prev = existing.policy.unwrap_or(rec.default_policy);
                existing.policy = Some(prev.stricter(ov.unwrap_or(rec.default_policy)));
            }
            None => {
                tools.insert(fitted, McpToolRule { policy: ov, read_only: t.read_only && fresh && !colliding.contains(&t.key), learned: true });
            }
        }
    }
    for o in &rec.tool_policies {
        let key = if o.tool == RESOURCES_TOOL { o.tool.clone() } else { fit(server_name, &o.tool) };
        if rec.tools.iter().any(|t| t.key == o.tool) {
            continue;
        }
        match tools.get_mut(&key) {
            Some(existing) => existing.policy = Some(existing.policy.unwrap_or(rec.default_policy).stricter(o.policy)),
            None => {
                tools.insert(key, McpToolRule { policy: Some(o.policy), read_only: false, learned: false });
            }
        }
    }
    McpServerRules { default_policy: rec.default_policy, tools, fresh }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{McpToolRecord, ToolPolicyEntry};
    use crate::types::McpTransport;

    fn rec(name: &str, tools: &[(&str, bool)]) -> McpServerRecord {
        McpServerRecord {
            id: "m0123456789ab".into(),
            name: name.into(),
            transport: McpTransport::Stdio,
            command: Some("/bin/echo".into()),
            args: vec![],
            url: None,
            env: vec![],
            headers: vec![],
            enabled: false,
            default_policy: McpPolicy::Ask,
            tool_policies: vec![],
            tools: tools
                .iter()
                .map(|(k, ro)| McpToolRecord { name: (*k).into(), key: normalize_tool_name(k), title: None, description: None, read_only: *ro, read_only_hint: Some(*ro), destructive_hint: None })
                .collect(),
            tools_tested_at: Some(1),
            tools_fingerprint: None,
            server_info: None,
            instructions_hash: None,
            origin: Origin::Manual,
            created_at: 0,
            updated_at: 0,
            extra: Map::new(),
        }
    }

    #[test]
    fn fit_keeps_the_whole_exposed_name_within_sixty_four_characters() {
        let long = "k".repeat(100);
        for server in ["a", &"s".repeat(20), &"s".repeat(32)] {
            let key = fit(server, &long);
            assert!(format!("mcp__{server}__{key}").len() <= 64, "{server}");
            assert!(!key.is_empty());
            assert_eq!(key, fit(server, &long), "equal inputs give equal outputs");
        }
    }

    #[test]
    fn two_keys_that_collide_after_the_cut_share_one_rule_with_the_stricter_policy() {
        let server = "s".repeat(20); // room for 37 characters
        let (a, b) = (format!("{}1", "x".repeat(60)), format!("{}2", "x".repeat(60)));
        let mut r = rec(&server, &[(&a, true), (&b, true), ("ok_tool", true)]);
        r.tool_policies.push(ToolPolicyEntry { tool: normalize_tool_name(&b), policy: McpPolicy::Deny, seeded: false });
        let rules = build_rules(&r, &server, true);
        let fitted = fit(&server, &normalize_tool_name(&a));
        assert_eq!(fitted, fit(&server, &normalize_tool_name(&b)));
        let shared = &rules.tools[&fitted];
        assert!(!shared.read_only, "colliding tools get no read-only flag");
        assert_eq!(shared.policy, Some(McpPolicy::Deny), "the stricter policy wins");
        assert!(rules.tools["ok_tool"].read_only);
        assert_eq!(rules.tools.len(), 2);
        let views = McpStore::tool_views(&r);
        assert!(views.iter().filter(|v| v.collision == Some(true)).count() == 2 && views.iter().all(|v| v.key != "ok_tool" || v.collision.is_none()));
        assert!(views.iter().filter(|v| v.collision == Some(true)).all(|v| v.effective_policy == McpPolicy::Deny && !v.read_only));
    }

    #[test]
    fn a_stale_list_loses_every_read_only_flag_and_overrides_stay() {
        let mut r = rec("fs", &[("read", true), ("write", false)]);
        r.tool_policies.push(ToolPolicyEntry { tool: "write".into(), policy: McpPolicy::Deny, seeded: false });
        r.tool_policies.push(ToolPolicyEntry { tool: "unlisted".into(), policy: McpPolicy::Allow, seeded: false });
        let fresh = build_rules(&r, "fs", true);
        assert!(fresh.tools["read"].read_only && fresh.fresh);
        let stale = build_rules(&r, "fs", false);
        assert!(!stale.fresh && stale.tools.values().all(|t| !t.read_only));
        assert_eq!(stale.tools["write"].policy, Some(McpPolicy::Deny));
        assert_eq!(stale.tools["unlisted"], intely_agent_core::mcp::McpToolRule { policy: Some(McpPolicy::Allow), read_only: false, learned: false });
        assert!(stale.tools["read"].learned);
    }

    #[test]
    fn exposure_counts_learned_tools_that_change_things_and_are_not_denied() {
        let mut r = rec("fs", &[("read", true), ("write", false), ("drop", false)]);
        r.tool_policies.push(ToolPolicyEntry { tool: "drop".into(), policy: McpPolicy::Deny, seeded: false });
        r.tool_policies.push(ToolPolicyEntry { tool: "unlisted".into(), policy: McpPolicy::Allow, seeded: false });
        assert_eq!(build_rules(&r, "fs", true).exposed(), 1);
    }
}
