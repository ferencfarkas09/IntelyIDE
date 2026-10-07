//! Command 8, `mcp_test` (MCP spec 4): prepare (confirmation, secrets, code location), run the probe, then persist what it learned and report.
//! Everything that goes wrong after the record was found is a report with `ok: false` and an `error` the panel words; only an unknown
//! server, a newer settings schema and a broken store are command errors.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use intely_agent_core::mcp::McpPolicy;
use intely_core::jail::Mode;
use intely_settings::secrets::redact;
use intely_settings::Secret;

use crate::codefiles::{check_code_location, code_lines, resolve_command, Forbidden};
use crate::error::{code, McpErr, Result};
use crate::model::{blocked_by_default, confirm_hash, fetches_code, validate_record, McpServerRecord, ServerInfo, ToolPolicyEntry};
use crate::probe::{probe, ProbeOk, ProbeOptions, ProbeServer, ProbeVar};
use crate::store::{env_key, header_key, McpStore};
use crate::types::*;

pub const DEFAULT_TEST_MS: u64 = 10_000;
pub const MIN_TEST_MS: u64 = 3_000;
pub const MAX_TEST_MS: u64 = 30_000;

/// Releases the per-server busy flag.
struct Busy<'a>(&'a McpStore, String);

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.tests.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&self.1);
    }
}

struct Prepared {
    rec: McpServerRecord,
    server: ProbeServer,
    fingerprint: String,
}

enum Stop {
    /// A command error.
    Fatal(McpErr),
    /// A report with `ok: false`.
    Report(McpErr),
}

impl McpStore {
    fn prepare_test(&self, id: &str) -> std::result::Result<Prepared, Stop> {
        let l = self.load().map_err(Stop::Fatal)?;
        if l.newer {
            return Err(Stop::Fatal(McpErr::new(code::UNSUPPORTED_VERSION, "the MCP settings were written by a newer version of this app")));
        }
        let rec = l.find(id).cloned().ok_or_else(|| Stop::Fatal(McpErr::new(code::UNKNOWN_SERVER, "that server does not exist")))?;
        validate_record(&rec).map_err(|e| Stop::Report(McpErr::new(code::BAD_CONFIG, format!("the stored configuration is no longer valid: {}", e.message))))?;
        let files = self.code_info(&rec).map_err(Stop::Report)?;
        let hash = confirm_hash(&rec.entry(), &code_lines(&files));
        if self.proof(&rec.id).as_deref() != Some(hash.as_str()) {
            return Err(Stop::Report(McpErr::new(code::CONFIRMATION_REQUIRED, "confirm what this server runs first").with_detail(hash)));
        }
        // the state directory and temporary directories (a Test has no run directories); temporary ones only while the jail is off
        let temp_dirs = if self.jail_mode() == Mode::Off { self.cfg.temp_dirs.clone() } else { Vec::new() };
        let mut state_dirs = self.cfg.state_dirs.clone();
        if let Some(d) = self.settings.path().parent() {
            state_dirs.push(d.to_path_buf());
        }
        check_code_location(&rec, &files, &Forbidden { run_dirs: vec![], state_dirs, temp_dirs }).map_err(|e| Stop::Report(McpErr { detail: None, ..e }))?;
        let var = |header: bool, v: &crate::model::McpVar| -> std::result::Result<ProbeVar, Stop> {
            if !v.secret {
                return Ok(ProbeVar { name: v.name.clone(), value: Secret::new(v.value.clone().unwrap_or_default()), secret: false });
            }
            let key = if header { header_key(&rec.id, &v.name) } else { env_key(&rec.id, &v.name) };
            match self.secrets.get(&key) {
                Ok(Some(s)) => Ok(ProbeVar { name: v.name.clone(), value: s, secret: true }),
                Ok(None) => Err(Stop::Report(McpErr::new(code::SECRET_MISSING, "a secret value of this server is missing").with_detail(v.name.clone()))),
                Err(e) => Err(Stop::Report(McpErr::from(e))),
            }
        };
        let env = rec.env.iter().map(|v| var(false, v)).collect::<std::result::Result<Vec<_>, _>>()?;
        let headers = rec.headers.iter().map(|v| var(true, v)).collect::<std::result::Result<Vec<_>, _>>()?;
        let command = match (rec.transport, rec.command.as_deref()) {
            (McpTransport::Stdio, Some(c)) => Some(resolve_command(c, &self.path_env()).ok_or_else(|| Stop::Report(McpErr::new(code::SPAWN_FAILED, "command not found on the login PATH")))?),
            _ => None,
        };
        let server = ProbeServer { name: rec.name.clone(), transport: rec.transport, command, args: rec.args.clone(), url: rec.url.clone(), env, headers };
        let fingerprint = rec.fingerprint();
        Ok(Prepared { rec, server, fingerprint })
    }

    fn failure_report(&self, rec: Option<&McpServerRecord>, err: McpErr, ms: u64, stderr_tail: Option<String>) -> McpTestReport {
        McpTestReport {
            ok: false,
            ms: ms as f64,
            protocol_version: None,
            server_info: None,
            capabilities: None,
            tools: rec.map(McpStore::tool_views).unwrap_or_default(),
            tool_count: rec.map_or(0, |r| r.tools.len() as u32),
            truncated: false,
            new_tools: vec![],
            removed_tools: vec![],
            blocked_by_default: vec![],
            fetches_code: rec.is_some_and(|r| fetches_code(r.command.as_deref(), &r.args)),
            instructions: None,
            instructions_changed: None,
            stderr_tail,
            error: Some(McpTestError { code: err.code, message: redact(&err.message), detail: err.detail.map(|d| redact(&d)) }),
        }
    }

    /// Persists what a successful Test learned (a single store write) and builds the report. The learned tools REPLACE the stored list;
    /// overrides stay. Tools that look like git or deploy writes and are new since the previous successful Test are seeded with Deny (4.4).
    fn apply_test(&self, prepared: &Prepared, ok: &ProbeOk, ms: u64, stderr_tail: String) -> Result<McpTestReport> {
        let now = self.now();
        let records = Self::tool_records(&ok.tools);
        let applied = self.mutate(|l| {
            let Some(rec) = l.find_mut(&prepared.rec.id) else { return Ok(None) };
            if rec.fingerprint() != prepared.fingerprint {
                // edited while the Test ran: what it learned is for another command line
                return Ok(None);
            }
            let previous: Option<HashSet<String>> = rec.tools_tested_at.map(|_| rec.tools.iter().map(|t| t.key.clone()).collect());
            let new_keys: Vec<String> = records.iter().map(|t| t.key.clone()).collect();
            let mut seeded = Vec::new();
            for t in &records {
                let was_listed = previous.as_ref().is_some_and(|p| p.contains(&t.key));
                if !was_listed && rec.override_for(&t.key).is_none() && blocked_by_default(&t.key, t.destructive_hint) {
                    rec.tool_policies.push(ToolPolicyEntry { tool: t.key.clone(), policy: McpPolicy::Deny, seeded: true });
                    seeded.push(t.key.clone());
                }
            }
            let new_tools = previous.as_ref().map(|p| new_keys.iter().filter(|k| !p.contains(*k)).cloned().collect::<Vec<_>>()).unwrap_or_default();
            let removed_tools = previous.as_ref().map(|p| p.iter().filter(|k| !new_keys.contains(k)).cloned().collect::<Vec<_>>()).unwrap_or_default();
            let instructions_changed = previous.as_ref().map(|_| rec.instructions_hash != ok.instructions_hash);
            rec.tools = records.clone();
            rec.tools_tested_at = Some(now);
            rec.tools_fingerprint = Some(prepared.fingerprint.clone());
            rec.server_info = Some(ServerInfo { name: ok.server_name.clone(), version: ok.server_version.clone(), protocol_version: ok.protocol_version.clone() });
            rec.instructions_hash = ok.instructions_hash.clone();
            rec.updated_at = now;
            Ok(Some((rec.clone(), new_tools, removed_tools, seeded, instructions_changed)))
        })?;
        let (rec, new_tools, removed_tools, seeded, instructions_changed) = match applied {
            Some(a) => a,
            None => {
                // not persisted: report the tools against the record as it was
                let mut rec = prepared.rec.clone();
                rec.tools = records.clone();
                rec.tools_tested_at = Some(now);
                rec.tools_fingerprint = Some(prepared.fingerprint.clone());
                (rec, vec![], vec![], vec![], None)
            }
        };
        Ok(McpTestReport {
            ok: true,
            ms: ms as f64,
            protocol_version: Some(ok.protocol_version.clone()),
            server_info: Some(McpTestServerInfo { name: ok.server_name.clone(), version: ok.server_version.clone() }),
            capabilities: Some(McpTestCapabilities { tools: ok.capabilities.0, resources: ok.capabilities.1, prompts: ok.capabilities.2 }),
            tools: McpStore::tool_views(&rec),
            tool_count: ok.tools.len() as u32,
            truncated: ok.truncated,
            new_tools,
            removed_tools,
            blocked_by_default: seeded,
            fetches_code: fetches_code(rec.command.as_deref(), &rec.args),
            instructions: ok.instructions.clone(),
            instructions_changed,
            stderr_tail: (rec.transport == McpTransport::Stdio).then_some(stderr_tail),
            error: None,
        })
    }

    /// Command 8. `timeout_ms` defaults to 10 s and is clamped to 3 s to 30 s.
    pub async fn test(self: &Arc<Self>, id: &str, timeout_ms: Option<u64>) -> Result<McpTestReport> {
        let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TEST_MS).clamp(MIN_TEST_MS, MAX_TEST_MS));
        {
            let mut running = self.tests.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if !running.insert(id.to_owned()) {
                return Ok(self.failure_report(None, McpErr::new(code::BUSY, "a test of this server is already running"), 0, None));
            }
        }
        let _busy = Busy(self, id.to_owned());
        if self.jail_mode() == Mode::ReadOnly {
            let stored = self.load()?.find(id).cloned().ok_or_else(|| McpErr::new(code::UNKNOWN_SERVER, "that server does not exist"))?;
            return Ok(self.failure_report(Some(&stored), McpErr::new(code::READ_ONLY, "the read-only mode refuses to start MCP servers"), 0, None));
        }
        let me = Arc::clone(self);
        let owned = id.to_owned();
        let prepared = tokio::task::spawn_blocking(move || me.prepare_test(&owned)).await.map_err(|e| McpErr::new(code::IO, format!("the test task failed: {e}")))?;
        let prepared = match prepared {
            Ok(p) => p,
            Err(Stop::Fatal(e)) => return Err(e),
            Err(Stop::Report(e)) => {
                let stored = self.load().ok().and_then(|l| l.find(id).cloned());
                return Ok(self.failure_report(stored.as_ref(), e, 0, None));
            }
        };
        let opts = ProbeOptions { timeout, env: (self.cfg.env)(), client_version: self.cfg.client_version.clone() };
        let result = probe(&prepared.server, opts, &self.cfg.jail).await;
        match result.outcome {
            Ok(ok) => {
                let me = Arc::clone(self);
                let (ms, tail) = (result.ms, result.stderr_tail);
                tokio::task::spawn_blocking(move || me.apply_test(&prepared, &ok, ms, tail)).await.map_err(|e| McpErr::new(code::IO, format!("the test task failed: {e}")))?
            }
            Err(e) => Ok(self.failure_report(Some(&prepared.rec), e, result.ms, (prepared.rec.transport == McpTransport::Stdio).then_some(result.stderr_tail))),
        }
    }
}
