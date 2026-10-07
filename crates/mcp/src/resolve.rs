//! The supplier the agent host consumes (MCP spec 5.1, 5.2): a run's selection of server ids becomes the SDK `mcpServers` object (secrets
//! resolved HERE, at `session/start`, and nowhere else) plus the per-server rules the broker judges calls with. Also the live rules query
//! of the tighten-only update, the transcript scrub list, and the data of the run picker.

use std::collections::BTreeMap;
use std::sync::Arc;

use intely_agent_core::mcp::{McpError, McpPolicy, McpResolved, McpRuleUpdate, McpRulesSupplier, McpScrubSupplier, McpSecrets, McpSelection, McpSkipped, McpSupplier, McpWire};
use intely_core::jail::Mode;
use serde_json::{json, Map, Value};

use crate::codefiles::{check_code_location, code_lines, CodeFile, Forbidden};
use crate::error::{code, McpErr, Result};
use crate::model::{confirm_hash, url_host, validate_record, McpServerRecord};
use crate::store::{build_rules, env_key, header_key, McpStore};
use crate::types::*;

fn is_loopback(host: &str) -> bool {
    matches!(host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase().as_str(), "127.0.0.1" | "::1" | "localhost")
}

/// One resolved server, before it joins the result.
struct One {
    name: String,
    json: Value,
    rules: intely_agent_core::mcp::McpServerRules,
    code_paths: Vec<std::path::PathBuf>,
}

impl McpStore {
    fn forbidden_for(&self, run_dirs: &[std::path::PathBuf]) -> Forbidden {
        let mut state_dirs = self.cfg.state_dirs.clone();
        if let Some(dir) = self.settings.path().parent() {
            state_dirs.push(dir.to_path_buf());
        }
        // Under the E2E jail every configured server is a fixture by construction, and fixtures live in temporary directories.
        let temp_dirs = if self.jail_mode() == Mode::Off { self.cfg.temp_dirs.clone() } else { Vec::new() };
        Forbidden { run_dirs: run_dirs.to_vec(), state_dirs, temp_dirs }
    }

    fn resolve_one(&self, l: &crate::store::Loaded, id: &str, forbidden: &Forbidden) -> Result<One> {
        let rec = l.find(id).ok_or_else(|| McpErr::new(code::UNKNOWN_SERVER, "an MCP server of this run no longer exists"))?;
        let named = |code_: &str, why: &str| McpErr::new(code_, format!("MCP server \"{}\": {why}", rec.name));
        validate_record(rec).map_err(|_| named(code::BAD_CONFIG, "the stored configuration is no longer valid"))?;
        if self.jail_mode() == Mode::E2e && rec.transport == McpTransport::Http && !rec.url.as_deref().and_then(url_host).is_some_and(|h| is_loopback(&h)) {
            return Err(named(code::TEST_JAIL, "the test jail only talks to loopback addresses"));
        }
        let files = self.code_info(rec).map_err(|e| named(&e.code, &e.message))?;
        let hash = confirm_hash(&rec.entry(), &code_lines(&files));
        if self.proof(&rec.id).as_deref() != Some(hash.as_str()) {
            return Err(named(code::CONFIRMATION_REQUIRED, "confirm what it runs in Settings first"));
        }
        check_code_location(rec, &files, forbidden).map_err(|e| McpErr { code: e.code, message: e.message, detail: None })?;
        let (json, ok) = self.sdk_config(rec)?;
        debug_assert!(ok);
        Ok(One {
            name: rec.name.clone(),
            json,
            rules: build_rules(rec, &rec.name, McpStore::is_fresh(rec)),
            code_paths: files.iter().filter(|f: &&CodeFile| f.exists()).map(|f| f.path.clone()).collect(),
        })
    }

    /// The SDK object of one server with its secret values resolved. `mcpSecretMissing` for a slot without an item.
    fn sdk_config(&self, rec: &McpServerRecord) -> Result<(Value, bool)> {
        let missing = |name: &str| McpErr::new(code::SECRET_MISSING, format!("MCP server \"{}\": a secret value is missing: {name}", rec.name));
        let read = |key: &str, name: &str| -> Result<String> {
            match self.secrets.get(key) {
                Ok(Some(s)) => Ok(s.expose().to_owned()),
                Ok(None) => Err(missing(name)),
                Err(e) => Err(McpErr::new(&e.code, format!("MCP server \"{}\": the Keychain could not be read", rec.name))),
            }
        };
        let vars = |header: bool, list: &[crate::model::McpVar]| -> Result<Map<String, Value>> {
            let mut m = Map::new();
            for v in list {
                let value = if v.secret { read(&if header { header_key(&rec.id, &v.name) } else { env_key(&rec.id, &v.name) }, &v.name)? } else { v.value.clone().unwrap_or_default() };
                m.insert(v.name.clone(), Value::String(value));
            }
            Ok(m)
        };
        let json = match rec.transport {
            McpTransport::Stdio => json!({ "type": "stdio", "command": rec.command, "args": rec.args, "env": vars(false, &rec.env)? }),
            McpTransport::Http => json!({ "type": "http", "url": rec.url, "headers": vars(true, &rec.headers)? }),
        };
        Ok((json, true))
    }

    /// The supplier body (5.1): fails with a code of 3.2 naming only the server. `strict == false` (a resume) skips an unavailable server.
    pub fn resolve(&self, sel: &McpSelection) -> Result<McpResolved> {
        let mut resolved = McpResolved { servers: McpWire::new(json!({})), names: vec![], ids: BTreeMap::new(), rules: BTreeMap::new(), code_paths: vec![], skipped: vec![] };
        if sel.ids.is_empty() {
            return Ok(resolved);
        }
        if self.jail_mode() == Mode::ReadOnly {
            return Err(McpErr::new(code::READ_ONLY, "the read-only mode refuses to start MCP servers"));
        }
        let l = self.load()?;
        if l.newer {
            return Err(McpErr::new(code::UNSUPPORTED_VERSION, "the MCP settings were written by a newer version of this app"));
        }
        if (self.cfg.auth_mode)() == "apiKey" {
            return Err(McpErr::new(code::AUTH_MODE_UNSUPPORTED, "MCP servers are not available while the Claude provider uses an API key: the key would reach every server"));
        }
        let forbidden = self.forbidden_for(&sel.run_dirs);
        let mut servers = Map::new();
        let mut seen = std::collections::HashSet::new();
        for id in sel.ids.iter().filter(|i| seen.insert((*i).clone())) {
            match self.resolve_one(&l, id, &forbidden) {
                Ok(one) => {
                    resolved.names.push(one.name.clone());
                    resolved.ids.insert(one.name.clone(), id.clone());
                    resolved.rules.insert(one.name.clone(), one.rules);
                    resolved.code_paths.extend(one.code_paths);
                    servers.insert(one.name, one.json);
                }
                Err(e) if !sel.strict => {
                    let name = l.find(id).map_or_else(|| id.clone(), |r| r.name.clone());
                    resolved.skipped.push(McpSkipped { id: id.clone(), name, reason: e.code });
                }
                Err(e) => return Err(e),
            }
        }
        resolved.code_paths.sort();
        resolved.code_paths.dedup();
        resolved.servers = McpWire::new(Value::Object(servers));
        Ok(resolved)
    }

    /// The live rules of the servers of running runs, by `(server id, the name the run knows)`; no secret and no config. `rules == None` =
    /// the server was removed.
    pub fn rules_for(&self, queries: &[(String, String)]) -> Vec<McpRuleUpdate> {
        let Ok(l) = self.load() else { return Vec::new() };
        if l.newer {
            return Vec::new();
        }
        queries
            .iter()
            .map(|(id, name)| McpRuleUpdate { id: id.clone(), rules: l.find(id).map(|rec| build_rules(rec, name, McpStore::is_fresh(rec))) })
            .collect()
    }

    /// Secret values of the given servers, for scrubbing a transcript the CLI wrote. One Keychain `get` per slot.
    pub fn scrub_secrets(&self, ids: &[String]) -> Result<McpSecrets> {
        let l = self.load()?;
        let mut values = Vec::new();
        for id in ids {
            let Some(rec) = l.find(id) else { continue };
            for key in crate::store::slot_keys(rec) {
                match self.secrets.get(&key) {
                    Ok(Some(s)) => values.push(s.expose().to_owned()),
                    Ok(None) => {}
                    Err(e) => return Err(McpErr::new(&e.code, "the Keychain could not be read")),
                }
            }
        }
        Ok(McpSecrets::new(values))
    }

    /// Command 12, `mcp_run_servers`: the data of the run picker. Never a secret, never a command line.
    pub fn run_servers(&self, workspace_id: Option<&str>, provider: &str) -> Result<Vec<McpRunServer>> {
        let l = self.load()?;
        let supported = matches!(provider, "claude" | "mock");
        let api_key = (self.cfg.auth_mode)() == "apiKey";
        let read_only = self.jail_mode() == Mode::ReadOnly;
        Ok(l
            .records()
            .map(|rec| {
                let fresh = McpStore::is_fresh(rec);
                let unavailable = if !supported {
                    Some("unsupportedProvider")
                } else if read_only {
                    Some("readOnlyJail")
                } else if api_key {
                    Some("unsupportedAuth")
                } else if validate_record(rec).is_err() {
                    Some("invalid")
                } else if !self.is_confirmed(rec) {
                    Some("needsConfirm")
                } else if self.secret_missing(rec) {
                    Some("secretMissing")
                } else {
                    None
                };
                let rules = build_rules(rec, &rec.name, fresh);
                McpRunServer {
                    id: rec.id.clone(),
                    name: rec.name.clone(),
                    transport: rec.transport,
                    default_on: workspace_id.and_then(|w| l.ws_override(w, &rec.id)).unwrap_or(rec.enabled),
                    available: unavailable.is_none(),
                    unavailable: unavailable.map(str::to_owned),
                    tool_count: rec.tools.len() as u32,
                    read_only_count: rules.tools.values().filter(|t| t.learned && t.read_only).count() as u32,
                    default_policy: rec.default_policy,
                    has_denied: rec.default_policy == McpPolicy::Deny || rec.tool_policies.iter().any(|p| p.policy == McpPolicy::Deny),
                    has_secret_env: rec.transport == McpTransport::Stdio && rec.env.iter().any(|v| v.secret),
                    exposed_count: rules.exposed(),
                }
            })
            .collect())
    }
}

/// `McpSupplier` over a store: the closure `HostConfig.mcp_supplier` carries.
pub fn supplier(store: Arc<McpStore>) -> McpSupplier {
    Arc::new(move |sel| store.resolve(sel).map_err(McpError::from))
}

pub fn rules_supplier(store: Arc<McpStore>) -> McpRulesSupplier {
    Arc::new(move |q| store.rules_for(q))
}

pub fn scrub_supplier(store: Arc<McpStore>) -> McpScrubSupplier {
    Arc::new(move |ids| store.scrub_secrets(ids).map_err(McpError::from))
}
