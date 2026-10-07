//! MongoDB Studio AI query pipeline ((design notes: mongo-studio-plan) section 2), Beta-M1-AI scope: AI **find**, privacy modes
//! P0 (off, default) and P1 (schema only), nothing auto-runs. Everything except the model call is deterministic Rust and
//! testable offline through the [`ports::ModelPort`] and [`ports::DbPort`] traits.
//!
//! | module | plan step |
//! |---|---|
//! | [`privacy`] | modes, the masking filter for every text path, name sanitizing, payload preview inputs |
//! | [`schema`] | digest fetch (sample 200 + latest 100), cache, collection routing, other-collections section |
//! | [`prompt`] | stable-prefix prompt, request type, tier routing, `PayloadPreview` |
//! | [`reply`] | constrained reply type and JSON schema |
//! | [`validate`] | stage allow-list, deny-list at any depth, typed-literal and path checks, limits, tenant rule |
//! | [`dryrun`] | explain dry run, COLLSCAN and regex warnings, copyable index suggestion |
//! | [`errors`] | value-free server error text |
//! | [`pipeline`] | prepare / generate / bounded repair |
//! | [`history`], [`describe`], [`clock`] | placeholder-only history and few-shot, explanation from the validated query, Budapest day boundaries |
//! | [`eval`] | golden-set scoring and cassettes |
//! | `transport` (feature `mongo`) | `DbPort` over the driver session, Claude one-shot `ModelPort` |

pub mod clock;
pub mod describe;
pub mod dryrun;
pub mod errors;
pub mod eval;
pub mod history;
pub mod pipeline;
pub mod ports;
pub mod privacy;
pub mod prompt;
pub mod reply;
pub mod resolve;
pub mod schema;
pub mod validate;

#[cfg(feature = "mongo")]
pub mod transport;

pub use privacy::mask_question;
pub use prompt::{intent_hint, SYSTEM_PROMPT};
pub use reply::{reply_schema, GenReply};
pub use validate::{validate_find, walk_deny, ValidatedFind};

/// M0 probe prompt shape (kept for the recorded M0 cassettes and `tests/ai_probe.rs`).
pub fn build_user_prompt(question: &str, digest_text: &str, now_iso: &str) -> String {
    format!("Current time: {now_iso} (timezone Europe/Budapest, UTC offset +01:00 or +02:00; use Z dates in the query).\n\nSchema:\n{digest_text}\n<question>\n{question}\n</question>")
}
