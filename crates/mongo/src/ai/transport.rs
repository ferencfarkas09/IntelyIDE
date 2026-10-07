//! Real ports (feature `mongo`): the driver session as a [`DbPort`], and the toolless Claude one-shot as a [`ModelPort`].
//!
//! The one-shot is the M0-proven fallback transport: a short-lived Node process that runs the Agent SDK `query()` with no
//! tools, no MCP, no settings sources and an empty temp cwd (script `scripts/mongo-fixture/claude-complete.mjs`). The
//! native `complete()` of the provider layer replaces it when that slice exists; the port boundary does not change.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::errors::DbError;
use super::ports::{DbPort, ExplainFind, ModelError, ModelPort, ModelReply, SampleKind, Usage};
use super::prompt::{GenRequest, ModelTier};
use crate::digest;
use crate::driver::{CancelToken, Error, Session};
use crate::explain::PlanSummary;
use crate::types::ReadCommand;

/// [`DbPort`] over a driver session. Every call carries the session's `maxTimeMS`; there is no execute method.
#[derive(Clone)]
pub struct SessionDb {
    pub session: Session,
    pub db: String,
}

fn de(e: Error) -> DbError {
    match e {
        Error::Server(m) => DbError::from_driver_text(&m),
        other => DbError { code: None, code_name: None, message: other.to_string() },
    }
}

fn docs(r: &crate::driver::RunResult) -> Vec<Value> {
    r.docs.iter().filter_map(|d| serde_json::from_str(d).ok()).collect()
}

impl SessionDb {
    pub fn new(session: Session, db: impl Into<String>) -> Self {
        Self { session, db: db.into() }
    }
    async fn run(&self, c: ReadCommand) -> Result<crate::driver::RunResult, DbError> {
        self.session.run(&c, &CancelToken::new()).await.map_err(de)
    }
}

impl DbPort for SessionDb {
    async fn list_collections(&self) -> Result<Vec<String>, DbError> {
        let r = self.run(ReadCommand::ListCollections { db: self.db.clone() }).await?;
        let mut v: Vec<String> = docs(&r).iter().filter_map(|d| d["name"].as_str().map(str::to_string)).filter(|n| !n.starts_with("system.")).collect();
        v.sort();
        Ok(v)
    }
    async fn sample(&self, collection: &str, kind: SampleKind) -> Result<Vec<Value>, DbError> {
        let cmd = match kind {
            SampleKind::Random(n) => ReadCommand::Aggregate { db: self.db.clone(), collection: collection.into(), pipeline: format!("[{{$sample: {{size: {n}}}}}]") },
            SampleKind::Latest(n) => ReadCommand::Find { db: self.db.clone(), collection: collection.into(), filter: String::new(), projection: None, sort: Some("{_id: -1}".into()), skip: None, limit: Some(n as i64) },
        };
        Ok(docs(&self.run(cmd).await?))
    }
    async fn indexes(&self, collection: &str) -> Result<Vec<String>, DbError> {
        let r = self.run(ReadCommand::ListIndexes { db: self.db.clone(), collection: collection.into() }).await?;
        Ok(docs(&r).iter().map(|i| digest::plain(&i["key"]).to_string()).collect())
    }
    async fn estimated_count(&self, collection: &str) -> Result<u64, DbError> {
        let r = self.run(ReadCommand::Count { db: self.db.clone(), collection: collection.into(), filter: String::new() }).await?;
        docs(&r).first().and_then(|d| d["count"].as_u64()).ok_or_else(|| DbError::new(None, None, "no count"))
    }
    async fn explain_find(&self, q: &ExplainFind) -> Result<PlanSummary, DbError> {
        let inner = ReadCommand::Find { db: self.db.clone(), collection: q.collection.clone(), filter: q.filter.clone(), projection: q.projection.clone(), sort: q.sort.clone(), skip: q.skip, limit: Some(q.limit) };
        let r = self.run(ReadCommand::Explain { inner: Box::new(inner), execution_stats: false }).await?;
        r.plan.ok_or_else(|| DbError::new(None, None, "explain returned no plan"))
    }
}

/// Toolless Claude one-shot through a short-lived Node process.
#[derive(Debug, Clone)]
pub struct ClaudeOneShotPort {
    pub node: PathBuf,
    pub script: PathBuf,
    /// Model ids per tier, from provider discovery (tests use the Haiku id for every tier).
    pub models: [String; 3],
    /// Hard cap on real calls, enforced by the script through a counter file.
    pub call_cap: u32,
    pub counter_file: PathBuf,
    pub timeout: Duration,
    /// The `claude` executable the Agent SDK drives; `None` leaves the script's own default.
    pub claude_bin: Option<PathBuf>,
    /// Set by the UI's Cancel: the child process is killed and the call ends with [`CANCELLED_MESSAGE`].
    pub cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

/// The message of the `ModelError` a user cancel produces (the gateway maps it to its own error code).
pub const CANCELLED_MESSAGE: &str = "cancelled";

/// A failure worth one automatic retry: the model ran out of turns or returned no structured answer.
pub fn is_transient(message: &str) -> bool {
    let m = message.to_lowercase();
    m.contains("maximum number of turns") || m.contains("no structured output") || m.contains("error_max_turns")
}

impl ClaudeOneShotPort {
    fn model_for(&self, t: ModelTier) -> &str {
        &self.models[match t {
            ModelTier::Fast => 0,
            ModelTier::Strong => 1,
            ModelTier::Max => 2,
        }]
    }

    fn run_blocking(&self, req: &GenRequest) -> Result<ModelReply, ModelError> {
        let payload = json!({
            "system": req.system, "schema": req.schema, "user": req.user,
            "model": self.model_for(req.tier), "cap": self.call_cap, "counter": self.counter_file,
        });
        let mut cmd = Command::new(&self.node);
        cmd.arg(&self.script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(bin) = &self.claude_bin {
            cmd.env("CLAUDE_BIN", bin);
        }
        // Same scrub as the sidecar: no database URIs in a model process.
        for (k, _) in std::env::vars() {
            if k.starts_with("MONGO") || k == "DB_STRING" || k.ends_with("_URI") || k.starts_with("INTELY_MONGO") {
                cmd.env_remove(k);
            }
        }
        let mut child = cmd.spawn().map_err(|e| ModelError(format!("cannot start node: {e}")))?;
        child.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).map_err(|e| ModelError(e.to_string()))?;
        let mut out = child.stdout.take().unwrap();
        let mut err = child.stderr.take().unwrap();
        let t_out = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = out.read_to_string(&mut s);
            s
        });
        let t_err = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = err.read_to_string(&mut s);
            s
        });
        let start = Instant::now();
        loop {
            if self.cancel.as_ref().is_some_and(|c| c.load(std::sync::atomic::Ordering::Relaxed)) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ModelError(CANCELLED_MESSAGE.into()));
            }
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if start.elapsed() > self.timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(ModelError(format!("the model call timed out after {} s", self.timeout.as_secs())));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(e) => return Err(ModelError(e.to_string())),
            }
        }
        let stdout = t_out.join().unwrap_or_default();
        let stderr = t_err.join().unwrap_or_default();
        let line = stdout.lines().rev().find(|l| l.trim_start().starts_with('{')).ok_or_else(|| ModelError(format!("no JSON from the model process: {}", stderr.chars().take(200).collect::<String>())))?;
        let v: Value = serde_json::from_str(line).map_err(|e| ModelError(e.to_string()))?;
        if let Some(e) = v["error"].as_str() {
            return Err(ModelError(e.chars().take(200).collect()));
        }
        // init-facts assertion: the utility session may have at most the synthetic StructuredOutput tool
        if v["tools"].as_u64().is_some_and(|n| n > 1) {
            return Err(ModelError("the utility session reported tools; refusing".into()));
        }
        let structured = v["structured"].clone();
        if structured.is_null() {
            return Err(ModelError("the model returned no structured output".into()));
        }
        Ok(ModelReply { reply: structured, usage: Usage { input_tokens: v["usage"]["input_tokens"].as_u64(), output_tokens: v["usage"]["output_tokens"].as_u64(), cost_usd: v["costUsd"].as_f64(), ms: v["ms"].as_u64() } })
    }
}

impl ModelPort for ClaudeOneShotPort {
    async fn complete(&self, req: &GenRequest) -> Result<ModelReply, ModelError> {
        let me = self.clone();
        let req = req.clone();
        let first = {
            let (me, req) = (me.clone(), req.clone());
            tokio::task::spawn_blocking(move || me.run_blocking(&req)).await.map_err(|e| ModelError(e.to_string()))?
        };
        match first {
            // one automatic retry for a model that did not finish; a cancel is never retried
            Err(ModelError(m)) if is_transient(&m) => tokio::task::spawn_blocking(move || me.run_blocking(&req)).await.map_err(|e| ModelError(e.to_string()))?,
            other => other,
        }
    }
}
