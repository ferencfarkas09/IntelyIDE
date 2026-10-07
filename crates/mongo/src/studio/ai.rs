//! The AI half of the gateway (feature `mongo`): `mongo_ai_payload`, `mongo_ai_generate`, `mongo_ai_explain`.
//!
//! It wires the deterministic pipeline of [`crate::ai::pipeline`] to a live connection: the database port is the
//! connection's session (sample, list, count, explain; there is no method that runs a query) and the model port is
//! chosen by the caller. A draft is text for the user to review; running it is a separate `run` that passes every gate of
//! the read-only gateway again (tenant lock, validators, audit).

use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::ai::describe;
use crate::ai::pipeline::{AiError, AskInput, Draft, EditorState, Outcome, Pipeline, Prepared, Status};
use crate::ai::ports::{ModelError, ModelPort, ModelReply};
use crate::ai::prompt::GenRequest;
use crate::ai::privacy::{AiPolicy, PrivacyMode};
use crate::ai::prompt::ModelTier;
use crate::ai::reply::GenReply;
use crate::ai::transport::SessionDb;
use crate::ai::validate::{self, ValidateCtx};
use crate::api::*;
use crate::error::{code, Result, StudioError};
use crate::presets::Preset;
use crate::profile::Profile;
use crate::shell;
use crate::types::EffectiveLevel;

use super::Studio;

/// Model names per tier for the result's `model` label (the port itself owns the real ids).
pub type TierNames = [String; 3];

fn editor_of(e: &AiEditor) -> EditorState {
    EditorState { filter: e.filter.clone(), projection: e.projection.clone(), sort: e.sort.clone(), limit: e.limit.map(i64::from), returned: e.returned.map(u64::from) }
}

fn clamp_i32(n: i64) -> i32 {
    n.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

fn ai_error(e: AiError) -> StudioError {
    match e {
        AiError::Off => StudioError::new(code::AI_OFF, "AI is off for this connection"),
        AiError::NoCollection(m) => StudioError::new(code::INVALID, m),
        AiError::UnknownCollection(m) => StudioError::new(code::NOT_FOUND, m),
        AiError::Db(m) => StudioError::new(code::SERVER, m),
    }
}

fn payload_of(p: &Prepared) -> AiPayload {
    let v = &p.preview;
    AiPayload {
        mode: if p.preview.mode == PrivacyMode::P1Enum { "schemaEnums" } else { "schemaOnly" }.into(),
        text: v.text.clone(),
        bytes: v.bytes.min(u32::MAX as usize) as u32,
        tokens_estimate: v.tokens_estimate.min(u32::MAX as usize) as u32,
        kept_names: v.kept_names.clone(),
        replaced_names: v.replaced_names as u32,
        excluded_fields: v.excluded_fields as u32,
        masked_literals: v.masked_literals as u32,
        notes: p.notes.clone(),
    }
}

fn draft_of(d: &Draft) -> AiDraft {
    AiDraft {
        collection: d.reply.collection.clone(),
        filter: d.filter_text.clone(),
        projection: d.projection_text.clone(),
        sort: d.sort_text.clone(),
        limit: d.reply.limit.map(clamp_i32),
        explanation: d.explanation.clone(),
        model_note: d.model_note.clone(),
        assumptions: d.assumptions.clone(),
        warnings: d.warnings.clone(),
        plan: Some(AiPlan { collscan: d.plan.collscan, index_names: d.plan.index_names.clone(), estimated_docs: None }),
        index_suggestion: d.index_suggestion.clone(),
        changed_fields: d.changed_fields.iter().map(|s| s.to_string()).collect(),
        extra_confirm: d.extra_confirm,
    }
}

fn tier_index(t: ModelTier) -> usize {
    match t {
        ModelTier::Fast => 0,
        ModelTier::Strong => 1,
        ModelTier::Max => 2,
    }
}

fn result_of(o: &Outcome, names: &TierNames, took_ms: u32) -> Result<AiResult> {
    // A model that could not be reached is a provider problem, not "the AI could not produce a query".
    if o.status == Status::Failed && o.rounds.last().is_some_and(|r| r.result == "provider") {
        let text = format!("{} {}", o.message, o.problems.join("; ")).trim().to_string();
        let c = if o.message == "Cancelled." {
            code::CANCELLED
        } else if o.message.starts_with("The model did not finish") {
            code::MODEL_BUSY
        } else {
            code::NO_PROVIDER
        };
        return Err(StudioError::new(c, if c == code::CANCELLED { "Cancelled.".to_string() } else { text }));
    }
    let status = match o.status {
        Status::Ready => "ready",
        Status::NeedsClarification => "needsClarification",
        Status::Failed => "failed",
    };
    let tier = o.rounds.last().map_or(ModelTier::Fast, |r| r.tier);
    Ok(AiResult {
        status: status.into(),
        draft: o.draft.as_ref().map(draft_of),
        clarification: o.clarification.clone(),
        // the clarification question is carried once, in `clarification`
        message: if o.status == Status::NeedsClarification { String::new() } else { o.message.clone() },
        problems: o.problems.clone(),
        repairs: o.repairs() as u32,
        notes: o.notes.clone(),
        model: names[tier_index(tier)].clone(),
        took_ms,
    })
}

/// The AI policy of a profile: privacy mode, tenant lock, and the signed per-connection deny list and glossary.
pub fn ai_policy(profile: &Profile, level: EffectiveLevel) -> AiPolicy {
    AiPolicy {
        mode: if profile.safety.ai_mode == AiMode::SchemaEnums { PrivacyMode::P1Enum } else { PrivacyMode::P1 },
        level: Some(level),
        tenant_field: profile.safety.tenant_lock.clone(),
        tenant_lock: profile.safety.tenant_lock.is_some(),
        deny_fields: profile.ai_prefs.deny_fields.clone(),
        glossary: profile.ai_prefs.glossary.iter().map(|g| (g.from.clone(), g.to.clone())).collect(),
        ..Default::default()
    }
}

impl Studio {
    fn now(&self) -> i64 {
        self.now_ms.unwrap_or_else(|| SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64))
    }

    /// The gates in front of every AI call: switch on, connected, signature of the safety fields, AI not off (P0).
    fn ai_context(&self, req: &AiAsk) -> Result<(SessionDb, AiPolicy, Profile)> {
        self.ensure_enabled()?;
        let conn = self.conn(&req.connection)?;
        let profile = self.profiles.verified(&req.connection)?;
        if profile.safety.ai_mode == AiMode::Off {
            return Err(StudioError::new(code::AI_OFF, "AI is off for this connection (Connections > Edit > AI)"));
        }
        if req.db.trim().is_empty() || req.db.len() > 120 {
            return Err(StudioError::new(code::INVALID, "pick a database first"));
        }
        let policy = ai_policy(&profile, conn.view.effective_level);
        Ok((SessionDb::new(conn.session.clone(), req.db.clone()), policy, profile))
    }

    fn ask_of<'a>(&self, req: &'a AiAsk) -> AskInput<'a> {
        AskInput {
            question: &req.question,
            selected: Some(req.collection.as_str()).filter(|c| !c.is_empty()),
            editor: req.editor.as_ref().map(editor_of),
            now_ms: self.now(),
            think_harder: req.think_harder.unwrap_or(false),
            refresh_schema: req.refresh_schema.unwrap_or(false),
            utc_offset_min: req.utc_offset_min,
            tz_name: req.tz_name.as_deref(),
        }
    }

    /// "What is sent?": the exact post-filter payload, built without a model call. Uses the P1 mask, so the preview equals
    /// what [`Studio::ai_generate`] sends for the same inputs.
    pub async fn ai_payload(&self, req: &AiAsk) -> Result<AiPayload> {
        let (db, policy, profile) = self.ai_context(req)?;
        let started = Instant::now();
        let model = NoModel;
        let mut cache = lock(&self.ai_digests).remove(&req.connection).unwrap_or_default();
        let mut pipe = Pipeline::new(&model, &db, &policy, &req.connection, &[]).with_preset(Preset::of(profile.domain));
        std::mem::swap(&mut pipe.cache, &mut cache);
        let prepared = pipe.prepare(&self.ask_of(req)).await;
        std::mem::swap(&mut pipe.cache, &mut cache);
        lock(&self.ai_digests).insert(req.connection.clone(), cache);
        self.record_ai(&profile, policy.level, "ai-payload", &req.db, &req.collection, prepared.is_ok(), started);
        prepared.map(|p| payload_of(&p)).map_err(ai_error)
    }

    /// Steps 1-9: the draft, validated, dry-run with explain and (bounded) repaired. **Never runs the query.**
    pub async fn ai_generate<M: ModelPort>(&self, model: &M, names: &TierNames, req: &AiAsk) -> Result<AiResult> {
        let (db, policy, profile) = self.ai_context(req)?;
        if req.question.trim().is_empty() {
            return Err(StudioError::new(code::INVALID, "type a question first"));
        }
        let started = Instant::now();
        let mut cache = lock(&self.ai_digests).remove(&req.connection).unwrap_or_default();
        let mut pipe = Pipeline::new(model, &db, &policy, &req.connection, &[]).with_preset(Preset::of(profile.domain));
        std::mem::swap(&mut pipe.cache, &mut cache);
        let outcome = pipe.ask(&self.ask_of(req)).await;
        std::mem::swap(&mut pipe.cache, &mut cache);
        lock(&self.ai_digests).insert(req.connection.clone(), cache);
        self.record_ai(&profile, policy.level, "ai-generate", &req.db, &req.collection, outcome.is_ok(), started);
        let outcome = outcome.map_err(ai_error)?;
        result_of(&outcome, names, started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32)
    }

    /// Plain-language explanation of the query in the editors. Deterministic: built from the validated query, no model call,
    /// nothing leaves the machine.
    pub async fn ai_explain(&self, req: &AiAsk) -> Result<AiExplanation> {
        self.ensure_enabled()?;
        self.conn(&req.connection)?;
        let profile = self.profiles.verified(&req.connection)?;
        let e = req.editor.as_ref().ok_or_else(|| StudioError::new(code::INVALID, "there is no query to explain"))?;
        let po = self.parse_opts();
        let canon = |text: &str| -> Result<Option<String>> {
            if text.trim().is_empty() {
                return Ok(None);
            }
            shell::parse_document(text, &po).map(|v| Some(v.to_string())).map_err(|x| StudioError::new(code::PARSE, x.to_string()))
        };
        let reply = GenReply {
            mode: "find".into(),
            collection: req.collection.clone(),
            filter: canon(&e.filter)?.unwrap_or_else(|| "{}".into()),
            projection: canon(&e.projection)?,
            sort: canon(&e.sort)?,
            skip: None,
            limit: e.limit.map(i64::from),
            assumptions: vec![],
            explanation: String::new(),
            confidence: None,
            needs_clarification: None,
        };
        let known = vec![req.collection.clone()];
        let mut ctx = ValidateCtx::new(&known, None, self.now());
        ctx.tenant_field = profile.safety.tenant_lock.as_deref();
        ctx.tenant_lock = profile.safety.tenant_lock.is_some();
        let v = validate::validate_find_ctx(&reply, &ctx).map_err(|p| StudioError::new(code::REJECTED, p.join("; ")))?;
        let mut text = describe::describe_find_for(&v, &req.question, Preset::of(profile.domain).hungarian);
        if let Some(plan) = req.plan.as_ref().filter(|p| !p.is_empty()) {
            text.push_str("\n\n");
            text.push_str(&plan.iter().take(8).map(|l| l.chars().take(200).collect::<String>()).collect::<Vec<_>>().join("\n"));
        }
        Ok(AiExplanation { text })
    }
}

/// `prepare` never calls the model; this port makes that structural for the payload preview.
struct NoModel;

impl ModelPort for NoModel {
    async fn complete(&self, _req: &GenRequest) -> std::result::Result<ModelReply, ModelError> {
        Err(ModelError("the payload preview never calls a model".into()))
    }
}

fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::pipeline::Round;
    use crate::ai::ports::Usage;

    fn outcome(status: Status, message: &str, clarification: Option<&str>, provider_round: bool) -> Outcome {
        let rounds = if provider_round { vec![Round { tier: ModelTier::Fast, cache_key: String::new(), result: "provider", problems: vec![] }] } else { vec![] };
        Outcome { status, draft: None, clarification: clarification.map(str::to_string), message: message.into(), problems: vec![], rounds, requests: vec![], usage: Usage::default(), notes: vec![] }
    }
    const NAMES: fn() -> TierNames = || ["m".into(), "m".into(), "m".into()];

    #[test]
    fn a_clarification_is_carried_once() {
        let r = result_of(&outcome(Status::NeedsClarification, "Which restaurants?", Some("Which restaurants?"), false), &NAMES(), 5).unwrap();
        assert_eq!((r.clarification.as_deref(), r.message.as_str()), (Some("Which restaurants?"), ""));
    }

    #[test]
    fn a_cancel_and_an_unfinished_model_have_their_own_codes() {
        let cancelled = result_of(&outcome(Status::Failed, "Cancelled.", None, true), &NAMES(), 5).unwrap_err();
        assert_eq!(cancelled.code, code::CANCELLED);
        let busy = result_of(&outcome(Status::Failed, "The model did not finish. Try again.", None, true), &NAMES(), 5).unwrap_err();
        assert_eq!(busy.code, code::MODEL_BUSY);
        assert!(!busy.message.to_lowercase().contains("settings"), "{}", busy.message);
        let missing = result_of(&outcome(Status::Failed, "The AI provider did not answer. Check the provider in Settings and try again.", None, true), &NAMES(), 5).unwrap_err();
        assert_eq!(missing.code, code::NO_PROVIDER);
    }
}

#[cfg(test)]
mod policy_tests {
    use std::sync::Arc;

    use intely_settings::{MemorySecretStore, SettingsStore};

    use super::*;
    use crate::profile::ProfileStore;

    fn saved(domain: Option<Domain>, prefs: Option<AiPrefs>) -> Profile {
        let dir = tempfile::tempdir().unwrap();
        let settings = Arc::new(SettingsStore::open(dir.path().join("settings.json")).unwrap());
        let store = ProfileStore::new(settings, Arc::new(MemorySecretStore::new()));
        let input = ProfileInput { name: "P".into(), uri: Some("mongodb://127.0.0.1:27017/x".into()), ai_mode: Some(AiMode::SchemaOnly), domain, ai_prefs: prefs, confirm: Some("P".into()), ..Default::default() };
        store.save(input).unwrap()
    }

    #[test]
    fn glossary_and_deny_fields_of_the_profile_reach_the_policy() {
        let prefs = AiPrefs { deny_fields: vec!["ssn".into(), "iban".into()], glossary: vec![GlossaryPair { from: "shop".into(), to: "stores".into() }] };
        let p = saved(Some(Domain::Generic), Some(prefs));
        let policy = ai_policy(&p, EffectiveLevel::Local);
        assert_eq!(policy.deny_fields, vec!["ssn", "iban"]);
        assert_eq!(policy.glossary, vec![("shop".to_string(), "stores".to_string())]);
        assert_eq!(policy.mode, PrivacyMode::P1);
        assert_eq!(p.domain, Domain::Generic);
        assert!(!Preset::of(p.domain).hungarian);
    }
}
