//! The AI find pipeline: every step except the model call is deterministic Rust.
//!
//! `prepare` (steps 1-4: intent hint, schema digest, compaction, masked prompt, payload preview) never calls the model,
//! so the UI can show "What is sent?" before consent and before every send. `generate` (steps 5-9) calls the model,
//! validates, explains (dry run) and repairs within a bound. **Nothing here executes the query** and the ports have no
//! method that could.

use serde_json::Value;

use super::clock;
use super::describe;
use super::dryrun::{self, DryRun};
use super::errors::{self, DbError};
use super::history::{self, HistoryEntry};
use super::ports::{DbPort, ModelPort, Usage};
use super::privacy::{self, AiPolicy, Masker, PrivacyMode, SchemaView};
use super::prompt::{self, FewShot, GenRequest, ModelTier, PayloadPreview, PromptParts};
use super::reply::GenReply;
use super::resolve;
use super::schema::{self, DigestCache, DIGEST_BUDGET_CHARS};
use super::validate::{self, ValidateCtx, ValidatedFind};
use crate::api::Domain;
use crate::digest::{CompactOpts, Digest};
use crate::presets::Preset;
use crate::explain::PlanSummary;
use crate::shell::{self, ParseOptions};

pub const MAX_REPAIRS_FIND: usize = 2;
pub const MAX_REPAIRS_PIPELINE: usize = 3;
pub const FAILED_MESSAGE: &str = "The AI could not produce a valid query. Try rephrasing, or write the filter yourself.";

#[derive(Debug, Clone, PartialEq)]
pub enum AiError {
    /// P0: AI is off for this connection. Raised before any port is touched.
    Off,
    NoCollection(String),
    UnknownCollection(String),
    /// Value-free text.
    Db(String),
}
impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AiError::Off => f.write_str("AI is off for this connection"),
            AiError::NoCollection(m) | AiError::UnknownCollection(m) | AiError::Db(m) => f.write_str(m),
        }
    }
}
impl std::error::Error for AiError {}

/// What the user has in the editors (for refinement and Fix).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EditorState {
    pub filter: String,
    pub projection: String,
    pub sort: String,
    pub limit: Option<i64>,
    /// Fix only: how many documents the current query returned (counts only, never rows).
    pub returned: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct AskInput<'a> {
    pub question: &'a str,
    pub selected: Option<&'a str>,
    pub editor: Option<EditorState>,
    pub now_ms: i64,
    pub think_harder: bool,
    pub refresh_schema: bool,
    /// The caller's UTC offset (minutes) and zone name: a generic data set words dates in them (D24); Happy keeps Budapest.
    pub utc_offset_min: Option<i32>,
    pub tz_name: Option<&'a str>,
}

pub struct Prepared {
    pub preview: PayloadPreview,
    /// UI notes, for example "I only generate read queries".
    pub notes: Vec<String>,
    masker: Masker,
    view: SchemaView,
    digest: Digest,
    collections: Vec<String>,
    question: String,
    now_ms: i64,
    editor: Option<EditorState>,
    request: GenRequest,
}

impl Prepared {
    pub fn request(&self) -> &GenRequest {
        &self.request
    }
    /// The masked question as the model sees it.
    pub fn masked_question(&self) -> &str {
        &self.question
    }
    pub fn selected(&self) -> &str {
        &self.digest.collection
    }
}

#[derive(Debug, Clone)]
pub struct Round {
    pub tier: ModelTier,
    pub cache_key: String,
    /// ok | clarify | schema | validator | server | identical
    pub result: &'static str,
    pub problems: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Draft {
    pub reply: GenReply,
    pub validated: ValidatedFind,
    pub filter_text: String,
    pub projection_text: String,
    pub sort_text: String,
    /// Generated from the validated query, never from the model's draft.
    pub explanation: String,
    /// The model's own note: untrusted plain text.
    pub model_note: String,
    pub assumptions: Vec<String>,
    pub warnings: Vec<String>,
    pub plan: PlanSummary,
    pub index_suggestion: Option<String>,
    /// Editor fields that differ from the user's current content.
    pub changed_fields: Vec<&'static str>,
    /// COLLSCAN on a big collection: the Run click needs one extra confirmation.
    pub extra_confirm: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// A validated, explained draft. The user reviews it and presses Run; nothing runs by itself.
    Ready,
    NeedsClarification,
    Failed,
}

#[derive(Debug, Clone)]
pub struct Outcome {
    pub status: Status,
    pub draft: Option<Draft>,
    pub clarification: Option<String>,
    pub message: String,
    pub problems: Vec<String>,
    pub rounds: Vec<Round>,
    pub requests: Vec<GenRequest>,
    pub usage: Usage,
    pub notes: Vec<String>,
}

impl Outcome {
    pub fn repairs(&self) -> usize {
        self.rounds.len().saturating_sub(1)
    }
}

pub struct Pipeline<'a, M: ModelPort, D: DbPort> {
    pub model: &'a M,
    pub db: &'a D,
    pub policy: &'a AiPolicy,
    pub conn: &'a str,
    pub history: &'a [HistoryEntry],
    pub cache: DigestCache,
    /// Wording of the data set (prompt, examples, glossary). Defaults to Happy, the behaviour before presets existed.
    pub preset: &'static Preset,
}

fn editor_block(m: &mut Masker, e: &EditorState) -> String {
    let mut s = format!("filter: {}\n", m.mask_query(if e.filter.trim().is_empty() { "{}" } else { &e.filter }, true));
    if !e.projection.trim().is_empty() {
        s.push_str(&format!("projection: {}\n", m.mask_query(&e.projection, true)));
    }
    if !e.sort.trim().is_empty() {
        s.push_str(&format!("sort: {}\n", m.mask_query(&e.sort, true)));
    }
    if let Some(l) = e.limit {
        s.push_str(&format!("limit: {l}\n"));
    }
    if let Some(n) = e.returned {
        s.push_str(&format!("This query returned {n} documents and the user says the result is wrong or empty.\n"));
    }
    s
}

impl<'a, M: ModelPort, D: DbPort> Pipeline<'a, M, D> {
    pub fn new(model: &'a M, db: &'a D, policy: &'a AiPolicy, conn: &'a str, history: &'a [HistoryEntry]) -> Self {
        Self { model, db, policy, conn, history, cache: DigestCache::default(), preset: Preset::of(Domain::Happy) }
    }

    pub fn with_preset(mut self, preset: &'static Preset) -> Self {
        self.preset = preset;
        self
    }

    fn db_err(e: &DbError) -> AiError {
        AiError::Db(errors::value_free(e))
    }

    /// Steps 1-4. Refuses in P0 before touching a port.
    pub async fn prepare(&mut self, input: &AskInput<'_>) -> Result<Prepared, AiError> {
        if self.policy.mode == PrivacyMode::P0 {
            return Err(AiError::Off);
        }
        let collections = self.db.list_collections().await.map_err(|e| Self::db_err(&e))?;
        let selected = match input.selected {
            Some(s) if collections.iter().any(|c| c == s) => s.to_string(),
            Some(s) => return Err(AiError::UnknownCollection(format!("unknown collection \"{}\"", errors::clean_line(s)))),
            None => schema::rank_collections_in(input.question, &collections, &self.policy.glossary, self.preset.glossary)
                .into_iter()
                .next()
                .map(|(c, _)| c)
                .ok_or_else(|| AiError::NoCollection("Pick a collection first: the question does not name one.".into()))?,
        };
        // The question names another listed collection: describe that one, so the model sees its fields instead of asking.
        let selected = schema::better_collection_in(input.question, &collections, &selected, &self.policy.glossary, self.preset.glossary).unwrap_or(selected);
        let digest = self.cache.get_or_fetch(self.db, self.conn, &selected, input.now_ms, input.refresh_schema).await.map_err(|e| Self::db_err(&e))?;
        let mut view = privacy::sanitize_schema(&digest, &collections, self.policy);
        let mut masker = Masker::new();
        let question = masker.mask_question(input.question);
        let mut notes = Vec::new();
        if let Some(h) = prompt::intent_hint(input.question) {
            notes.push(h.to_string());
        }
        let editor = input.editor.as_ref().map(|e| editor_block(&mut masker, e));
        let mut shots: Vec<FewShot> = history::select_few_shot(self.history, &selected, &question, 3);
        shots.extend(prompt::preset_few_shot(self.preset).into_iter().take(10 - shots.len().min(3)));
        // Enum VALUES are rendered only in P1Enum, and only those that survived the value filter in `sanitize_schema`.
        let opts = CompactOpts { include_enum_values: self.policy.with_enums(), ..CompactOpts::default() };
        let digest_text = view.digest.compact_to_budget(&view.collections, &opts, DIGEST_BUDGET_CHARS);
        let tops = self.cache.top_fields(self.conn, input.now_ms);
        let tops = privacy::sanitize_top_fields(&mut view, &tops, self.policy);
        let others = schema::others_section_in(&view.digest.collection, &view.collections, &question, &self.policy.glossary, &tops, self.preset.glossary);
        let tier = prompt::route_for(&question, collections.len(), input.think_harder, self.preset.hungarian);
        let zone = if self.preset.hungarian { clock::Zone::Budapest } else { clock::Zone::fixed(input.utc_offset_min, input.tz_name) };
        let hint = notes.first().map(String::as_str);
        let request = prompt::build_request(&PromptParts {
            system: self.preset.system_prompt,
            view: &view,
            others: &others,
            few_shot: &shots,
            now_ms: input.now_ms,
            zone: &zone,
            hungarian: self.preset.hungarian,
            selected: &view.digest.collection,
            editor: editor.as_deref(),
            hint: hint.map(|_| "The question may ask to change data; you can only return a read query that selects the matching documents"),
            question: &question,
            tier,
            digest_text: &digest_text,
        });
        let preview = PayloadPreview::of(&request, self.policy.mode, &view, masker.count());
        Ok(Prepared { preview, notes, masker, view, digest, collections, question, now_ms: input.now_ms, editor: input.editor.clone(), request })
    }

    /// Everything bound for the model goes through this: known originals back to placeholders, then bounded and cleaned.
    fn feedback(p: &Prepared, s: &str) -> String {
        errors::clean_line(&p.view.scrub_excluded(&p.view.names.hide(&p.masker.remask(s))))
    }

    fn unmask_reply(p: &Prepared, r: &GenReply) -> GenReply {
        let q = |s: &str| p.masker.unmask_query(&p.view.names.restore_query(s));
        let t = |s: &str| p.masker.unmask(&p.view.names.restore(s));
        GenReply {
            mode: r.mode.clone(),
            collection: p.view.names.restore(&r.collection),
            filter: q(&r.filter),
            projection: r.projection.as_deref().map(q),
            sort: r.sort.as_deref().map(q),
            skip: r.skip,
            limit: r.limit,
            assumptions: r.assumptions.iter().map(|a| t(a)).collect(),
            explanation: t(&r.explanation),
            confidence: r.confidence.clone(),
            needs_clarification: r.needs_clarification.as_deref().map(t),
        }
    }

    /// Steps 5-9 on a prepared request.
    pub async fn generate(&mut self, p: Prepared) -> Outcome {
        let mut out = Outcome { status: Status::Failed, draft: None, clarification: None, message: FAILED_MESSAGE.into(), problems: vec![], rounds: vec![], requests: vec![], usage: Usage::default(), notes: p.notes.clone() };
        let max_repairs = MAX_REPAIRS_FIND;
        let mut req = p.request.clone();
        let mut previous: Vec<GenReply> = Vec::new();
        for attempt in 0..=max_repairs {
            out.requests.push(req.clone());
            let mr = match self.model.complete(&req).await {
                Ok(m) => m,
                Err(e) => {
                    let lower = e.0.to_lowercase();
                    out.message = if lower == "cancelled" {
                        "Cancelled.".into()
                    } else if lower.contains("maximum number of turns") || lower.contains("no structured output") || lower.contains("timed out") {
                        "The model did not finish. Try again.".into()
                    } else {
                        "The AI provider did not answer. Check the provider in Settings and try again.".into()
                    };
                    out.problems = vec![errors::clean_line(&e.0)];
                    out.rounds.push(Round { tier: req.tier, cache_key: req.cache_key.clone(), result: "provider", problems: out.problems.clone() });
                    return out;
                }
            };
            add_usage(&mut out.usage, &mr.usage);
            let raw_text = mr.reply.to_string();
            let mut round = Round { tier: req.tier, cache_key: req.cache_key.clone(), result: "ok", problems: vec![] };
            let problems: Vec<String> = match serde_json::from_value::<GenReply>(mr.reply.clone()) {
                Err(e) => {
                    round.result = "schema";
                    vec![format!("the reply does not match the output schema: {}", Self::feedback(&p, &e.to_string()))]
                }
                Ok(raw) => {
                    if previous.iter().any(|x| x.same_query(&raw)) {
                        round.result = "identical";
                        round.problems = vec!["the reply repeats an earlier attempt".into()];
                        out.rounds.push(round);
                        out.problems = vec!["the AI repeated the same query".into()];
                        return out;
                    }
                    previous.push(raw.clone());
                    let reply = Self::unmask_reply(&p, &raw);
                    if let Some(q) = reply.needs_clarification.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
                        round.result = "clarify";
                        out.rounds.push(round);
                        out.status = Status::NeedsClarification;
                        out.clarification = Some(errors::clean_line(q));
                        out.message = out.clarification.clone().unwrap_or_default();
                        return out;
                    }
                    match self.check(&p, &reply).await {
                        Ok((reply, validated, dry)) => {
                            round.result = "ok";
                            out.rounds.push(round);
                            out.status = Status::Ready;
                            out.message = String::new();
                            out.draft = Some(self.draft(&p, reply, validated, dry));
                            return out;
                        }
                        Err((kind, probs)) => {
                            round.result = kind;
                            probs
                        }
                    }
                }
            };
            round.problems = problems.clone();
            out.rounds.push(round);
            out.problems = problems.clone();
            if attempt == max_repairs {
                break;
            }
            let tier = if attempt + 1 == max_repairs { req.tier.up() } else { req.tier };
            let prev_text = Self::feedback(&p, &raw_text);
            req = prompt::repair_request(&p.request, &prev_text, &problems, tier);
        }
        out
    }

    /// Validate and dry-run one unmasked reply. Problems are already value-free.
    /// Returns the reply too: enum values the model guessed are mapped to the stored ones locally (see `resolve`).
    async fn check(&mut self, p: &Prepared, reply: &GenReply) -> Result<(GenReply, ValidatedFind, DryRun), (&'static str, Vec<String>)> {
        let digest_owned: Option<Digest> = if reply.collection == p.digest.collection || !p.collections.iter().any(|c| *c == reply.collection) {
            None
        } else {
            self.cache.get_or_fetch(self.db, self.conn, &reply.collection, p.now_ms, false).await.ok()
        };
        let digest: Option<&Digest> = if reply.collection == p.digest.collection { Some(&p.digest) } else { digest_owned.as_ref() };
        let mut reply = reply.clone();
        if let Some(d) = digest {
            if let Ok(mut f) = shell::parse_document(&reply.filter, &ParseOptions { now_ms: Some(p.now_ms) }) {
                let rw = resolve::resolve_filter(&mut f, d);
                if !rw.is_empty() {
                    reply.filter = resolve::patch_text(&reply.filter, &rw, &f);
                    reply.assumptions.extend(rw.iter().map(resolve::describe));
                }
            }
        }
        let reply = &reply;
        let mut ctx = ValidateCtx::new(&p.collections, digest, p.now_ms);
        ctx.tenant_field = self.policy.tenant_field.as_deref();
        ctx.tenant_lock = self.policy.tenant_lock;
        let v = validate::validate_find_ctx(reply, &ctx).map_err(|e| ("validator", e.iter().map(|m| Self::feedback(p, m)).collect::<Vec<_>>()))?;
        match dryrun::dry_run(self.db, &v, digest).await {
            Ok(d) => Ok((reply.clone(), v, d)),
            Err(e) => Err(("server", vec![errors::value_free(&e)])),
        }
    }

    fn draft(&self, p: &Prepared, reply: GenReply, v: ValidatedFind, dry: DryRun) -> Draft {
        let mut warnings = v.warnings.clone();
        warnings.extend(dry.warnings.iter().cloned());
        if reply.collection != p.digest.collection {
            warnings.push(format!("the query targets \"{}\", not the selected collection \"{}\"", reply.collection, p.digest.collection));
        }
        let extra_confirm = dry.plan.collscan && p.digest.estimated.is_none_or(|n| n > 50_000);
        let filter_text = reply.filter.trim().to_string();
        let projection_text = reply.projection.clone().unwrap_or_default();
        let sort_text = reply.sort.clone().unwrap_or_default();
        let mut changed = Vec::new();
        if let Some(e) = &p.editor {
            let norm = |s: &str| s.split_whitespace().collect::<String>();
            if norm(&e.filter) != norm(&filter_text) {
                changed.push("filter");
            }
            if norm(&e.projection) != norm(&projection_text) {
                changed.push("projection");
            }
            if norm(&e.sort) != norm(&sort_text) {
                changed.push("sort");
            }
            if e.limit != reply.limit {
                changed.push("limit");
            }
        }
        let original_question = p.masker.unmask(&p.question);
        Draft {
            explanation: describe::describe_find_for(&v, &original_question, self.preset.hungarian),
            model_note: errors::clean_line(&reply.explanation),
            assumptions: reply.assumptions.iter().map(|a| errors::clean_line(a)).collect(),
            warnings,
            plan: dry.plan,
            index_suggestion: dry.index_suggestion,
            changed_fields: changed,
            extra_confirm,
            filter_text,
            projection_text,
            sort_text,
            validated: v,
            reply,
        }
    }

    /// `prepare` + `generate`.
    pub async fn ask(&mut self, input: &AskInput<'_>) -> Result<Outcome, AiError> {
        let p = self.prepare(input).await?;
        Ok(self.generate(p).await)
    }
}

fn add_usage(t: &mut Usage, u: &Usage) {
    let add = |a: &mut Option<u64>, b: Option<u64>| *a = match (*a, b) {
        (None, None) => None,
        (x, y) => Some(x.unwrap_or(0) + y.unwrap_or(0)),
    };
    add(&mut t.input_tokens, u.input_tokens);
    add(&mut t.output_tokens, u.output_tokens);
    t.cost_usd = match (t.cost_usd, u.cost_usd) {
        (None, None) => None,
        (x, y) => Some(x.unwrap_or(0.0) + y.unwrap_or(0.0)),
    };
    t.ms = match (t.ms, u.ms) {
        (None, None) => None,
        (x, y) => Some(x.unwrap_or(0) + y.unwrap_or(0)),
    };
}

/// `now` in the prompt format, for callers that only have the epoch.
pub fn now_label(now_ms: i64) -> String {
    clock::iso_budapest(now_ms)
}

#[allow(dead_code)]
fn _assert_value_unused(_: &Value) {}
