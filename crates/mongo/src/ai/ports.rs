//! The two ports of the pipeline. `crates/mongo` has no provider dependency and, for the pipeline, no write or execute
//! capability: [`DbPort`] can sample, list, count and **explain**, but it has no method that runs a user query. Nothing
//! generated here can run; running is a separate, user-clicked path.

use std::future::Future;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::errors::DbError;
use super::prompt::GenRequest;
use crate::explain::PlanSummary;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleKind {
    /// `aggregate([{$sample:{size:n}}])`: `$sample` must be the first stage so the cheap path is used.
    Random(usize),
    /// Latest by `_id` descending: catches drift that a random sample of an old collection misses.
    Latest(usize),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExplainFind {
    pub collection: String,
    /// Canonical EJSON text of the validated bodies.
    pub filter: String,
    pub projection: Option<String>,
    pub sort: Option<String>,
    pub skip: Option<u64>,
    pub limit: i64,
}

/// Read-only database access for the AI pipeline. Implementations apply `maxTimeMS` to every call.
pub trait DbPort: Send + Sync {
    fn list_collections(&self) -> impl Future<Output = Result<Vec<String>, DbError>> + Send;
    /// Canonical EJSON documents.
    fn sample(&self, collection: &str, kind: SampleKind) -> impl Future<Output = Result<Vec<Value>, DbError>> + Send;
    /// Index key texts like `{"restaurant":1,"createdAt":-1}`.
    fn indexes(&self, collection: &str) -> impl Future<Output = Result<Vec<String>, DbError>> + Send;
    fn estimated_count(&self, collection: &str) -> impl Future<Output = Result<u64, DbError>> + Send;
    /// queryPlanner explain: does not execute the query.
    fn explain_find(&self, q: &ExplainFind) -> impl Future<Output = Result<PlanSummary, DbError>> + Send;
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
    pub ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelReply {
    /// The structured reply as JSON; the pipeline checks its shape (an invalid shape is a repairable error).
    pub reply: Value,
    pub usage: Usage,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelError(pub String);
impl std::fmt::Display for ModelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ModelError {}

/// One-shot, toolless, structured-output completion. Wired to the sidecar utility session or the provider layer in the app;
/// a fake or a cassette replayer in tests.
pub trait ModelPort: Send + Sync {
    fn complete(&self, req: &GenRequest) -> impl Future<Output = Result<ModelReply, ModelError>> + Send;
}
