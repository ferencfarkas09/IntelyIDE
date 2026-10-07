//! The constrained model reply: query bodies are EJSON **strings** (Claude structured outputs reject recursive schemas)
//! and the type has no write variant, so even a perfect injection yields at worst a wrong read-only query.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenReply {
    pub mode: String,
    pub collection: String,
    #[serde(default)]
    pub filter: String,
    #[serde(default)]
    pub projection: Option<String>,
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default)]
    pub skip: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub assumptions: Vec<String>,
    #[serde(default)]
    pub explanation: String,
    /// "low" | "medium" | "high"
    #[serde(default)]
    pub confidence: Option<String>,
    #[serde(default)]
    pub needs_clarification: Option<String>,
}

impl GenReply {
    /// Same text in every field the pipeline reads: used to stop the repair loop on identical output.
    pub fn same_query(&self, o: &GenReply) -> bool {
        (&self.collection, &self.filter, &self.projection, &self.sort, self.skip, self.limit) == (&o.collection, &o.filter, &o.projection, &o.sort, o.skip, o.limit)
    }
}

/// JSON Schema for Claude structured output. Not recursive; `mode` is `find` only in this round.
pub fn reply_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "mode": { "type": "string", "enum": ["find"] },
            "collection": { "type": "string" },
            "filter": { "type": "string", "description": "MongoDB filter as strict Extended JSON, e.g. {\"status\":\"paid\",\"createdAt\":{\"$gte\":{\"$date\":\"2025-01-01T00:00:00Z\"}}}" },
            "projection": { "type": "string" },
            "sort": { "type": "string" },
            "skip": { "type": "integer" },
            "limit": { "type": "integer" },
            "assumptions": { "type": "array", "items": { "type": "string" } },
            "explanation": { "type": "string" },
            "confidence": { "type": "string", "enum": ["low", "medium", "high"] },
            "needsClarification": { "type": "string" }
        },
        "required": ["mode", "collection", "filter", "explanation"],
        "additionalProperties": false
    })
}
