//! The prompt: stable prefix first (system text and JSON schema never change between calls, so providers can cache
//! them), volatile parts last. The request below is the **single** value that is previewed, hashed for cassettes and sent.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::clock;
use crate::api::Domain;
use crate::presets::Preset;
use super::privacy::{PrivacyMode, SchemaView};
use super::reply::reply_schema;

/// Cheap tier first; model ids come from provider discovery in the wiring layer, never from this crate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelTier {
    Fast,
    Strong,
    Max,
}

impl ModelTier {
    pub fn up(self) -> Self {
        match self {
            ModelTier::Fast => ModelTier::Strong,
            _ => ModelTier::Max,
        }
    }
}

/// Everything the model port receives. Equal requests produce equal wire text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenRequest {
    pub system: String,
    pub schema: Value,
    pub user: String,
    pub tier: ModelTier,
    /// Hash of everything except the digest (which comes from a random `$sample`), see [`cache_key`].
    pub cache_key: String,
}

impl GenRequest {
    /// The exact text that reaches the model. The payload preview shows this string.
    pub fn wire_text(&self) -> String {
        format!("[system]\n{}\n[output schema]\n{}\n[user]\n{}\n", self.system, self.schema, self.user)
    }
}

/// The Happy preset's prompt (kept here for the existing callers; the text lives in `presets/happy.rs`).
pub use crate::presets::happy::SYSTEM_PROMPT;

/// Hungarian / English write verbs: a UI note, not a gate (the output type has no write variants).
pub fn intent_hint(question: &str) -> Option<&'static str> {
    let q = super::privacy::fold(question);
    const WORDS: &[&str] = &[
        "torold", "modositsd", "frissitsd", "ird at", "dobd el", "torolj", "szurj be", "toroljuk", "hozz letre", "drop ", "delete ", "update ", "insert ", "remove ", "create index", "index letre", "export ", "exportald", "write ", "modify ", "set all",
    ];
    WORDS.iter().any(|w| q.contains(w)).then_some("I only generate read queries")
}

/// Rust heuristic (never an LLM call): which tier answers first. Pipelines and joins are M2; find stays on the cheap tier
/// unless the question is long or asks for grouping / joining.
pub fn route(question: &str, n_collections: usize, think_harder: bool) -> ModelTier {
    route_for(question, n_collections, think_harder, true)
}

/// [`route`] with the Hungarian "hard" words switched by the preset (a generic data set only knows the English ones).
pub fn route_for(question: &str, n_collections: usize, think_harder: bool, hungarian: bool) -> ModelTier {
    if think_harder {
        return ModelTier::Max;
    }
    let q = super::privacy::fold(question);
    const HARD: &[&str] = &["per ", "grouped", "group by", "average", "avg", "top ", "join", "lookup"];
    const HARD_HU: &[&str] = &["atlag", "csoportos", "osszesit", "darab szerint", "szerint csoport", "mindegyik", "minden etterem"];
    let hard = HARD.iter().any(|w| q.contains(w)) || (hungarian && HARD_HU.iter().any(|w| q.contains(w)));
    if question.chars().count() > 220 || hard || n_collections > 40 {
        ModelTier::Strong
    } else {
        ModelTier::Fast
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FewShot {
    pub question: String,
    pub query: String,
}

fn shot(question: &str, collection: &str, filter: &str, sort: Option<&str>, limit: Option<i64>) -> FewShot {
    let mut q = serde_json::json!({ "collection": collection, "filter": filter });
    if let Some(s) = sort {
        q["sort"] = Value::String(s.into());
    }
    if let Some(l) = limit {
        q["limit"] = Value::from(l);
    }
    FewShot { question: question.into(), query: q.to_string() }
}

/// The preset's worked examples as prompt few-shots (`{"collection","filter"[,"limit"][,"sort"]}` rendered by serde_json).
pub fn preset_few_shot(preset: &Preset) -> Vec<FewShot> {
    preset.few_shots.iter().map(|s| shot(s.question, s.collection, s.filter, s.sort, s.limit)).collect()
}

/// The Happy examples (the pre-preset behaviour).
pub fn builtin_few_shot() -> Vec<FewShot> {
    preset_few_shot(Preset::of(Domain::Happy))
}

pub struct PromptParts<'a> {
    /// The preset's system prompt (stable per preset, so it stays cacheable).
    pub system: &'a str,
    pub view: &'a SchemaView,
    pub others: &'a str,
    pub few_shot: &'a [FewShot],
    pub now_ms: i64,
    /// The wall clock the Context block speaks in: Budapest for Happy, the caller's own offset and name otherwise.
    pub zone: &'a clock::Zone,
    /// The preset's `hungarian` flag: the Context block carries the Hungarian rolling-window phrase only then.
    pub hungarian: bool,
    /// Selected collection, as the model sees it (post-sanitizing).
    pub selected: &'a str,
    /// Current editor content (already masked), when the user refines.
    pub editor: Option<&'a str>,
    pub hint: Option<&'a str>,
    /// Question after the masking filter.
    pub question: &'a str,
    pub tier: ModelTier,
    pub digest_text: &'a str,
}

/// FNV-1a 64: stable across runs and platforms, unlike `DefaultHasher`.
pub fn fnv(parts: &[&str]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for p in parts {
        for b in p.bytes().chain(std::iter::once(0xff)) {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{h:016x}")
}

pub fn build_request(p: &PromptParts) -> GenRequest {
    let schema = reply_schema();
    let mut shots = String::new();
    if !p.few_shot.is_empty() {
        shots.push_str("Examples (format only; the field names are illustrative, use only the schema above):\n");
        for s in p.few_shot {
            shots.push_str(&format!("Q: {}\nA: {}\n", s.question, s.query));
        }
    }
    let ctx = clock::context_block_in(p.now_ms, p.zone, p.hungarian);
    let mut tail = format!("{ctx}\nSelected collection: {}\n", p.selected);
    if let Some(e) = p.editor {
        tail.push_str(&format!("The user's editor currently contains (refine it, keep what the question does not change):\n{e}\n"));
    }
    if let Some(h) = p.hint {
        tail.push_str(&format!("Note: {h}.\n"));
    }
    let question = format!("<question>\n{}\n</question>", p.question);
    let user = format!("Schema:\n{}\n{}\n{shots}\nContext:\n{tail}\n{question}", p.digest_text, p.others);
    let cache_key = fnv(&[p.system, &schema.to_string(), &shots, &tail, &question]);
    GenRequest { system: p.system.to_string(), schema, user, tier: p.tier, cache_key }
}

/// Repair request: the same prefix, the model's own previous output and value-free problems.
pub fn repair_request(base: &GenRequest, previous_reply: &str, problems: &[String], tier: ModelTier) -> GenRequest {
    let mut block = format!("\nYour previous output was:\n{previous_reply}\nIt was not accepted:\n");
    for p in problems {
        block.push_str(&format!("- {p}\n"));
    }
    block.push_str("Return a corrected JSON object. Do not repeat the same mistake; if the question cannot be answered, set needsClarification.\n");
    let user = format!("{}{block}", base.user);
    let cache_key = fnv(&[&base.cache_key, &block]);
    GenRequest { system: base.system.clone(), schema: base.schema.clone(), user, tier, cache_key }
}

/// "What is sent?": the exact post-filter payload plus the facts the user decides on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadPreview {
    pub mode: PrivacyMode,
    /// Equals `request.wire_text()` byte for byte.
    pub text: String,
    pub request: GenRequest,
    pub bytes: usize,
    pub tokens_estimate: usize,
    /// Names that stay visible to the model (the user can add them to the per-connection deny list).
    pub kept_names: Vec<String>,
    pub replaced_names: usize,
    pub excluded_fields: usize,
    pub masked_literals: usize,
}

impl PayloadPreview {
    pub fn of(request: &GenRequest, mode: PrivacyMode, view: &SchemaView, masked_literals: usize) -> Self {
        let text = request.wire_text();
        Self {
            mode,
            bytes: text.len(),
            tokens_estimate: text.len().div_ceil(4),
            kept_names: view.kept_names.clone(),
            replaced_names: view.names.replaced(),
            excluded_fields: view.excluded.len(),
            masked_literals,
            request: request.clone(),
            text,
        }
    }
}
