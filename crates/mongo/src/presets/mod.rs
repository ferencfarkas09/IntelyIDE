//! Domain presets (T7a): the AI wording that belongs to a kind of data set. `Generic` is language-neutral; `Happy` keeps the
//! maintainer's Hungarian wording byte for byte. T1a left the final shapes with empty content.

use crate::api::Domain;

pub mod generic;
pub mod happy;

/// One worked example. The answer is rendered by `ai::prompt` from these parts (same JSON shape for every preset).
#[derive(Debug, Clone, Copy)]
pub struct FewShot {
    pub question: &'static str,
    pub collection: &'static str,
    pub filter: &'static str,
    pub sort: Option<&'static str>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Copy)]
pub struct Preset {
    pub id: Domain,
    pub system_prompt: &'static str,
    pub few_shots: &'static [FewShot],
    pub glossary: &'static [(&'static str, &'static str)],
    pub tenant_candidates: &'static [&'static str],
    pub hungarian: bool,
}

impl Preset {
    pub fn of(domain: Domain) -> &'static Preset {
        match domain {
            Domain::Generic => &generic::PRESET,
            Domain::Happy => &happy::PRESET,
        }
    }
}
