//! Prompt and answer handling for "Translate missing". The model call itself lives in the Tauri glue; everything that
//! decides what a draft may look like (placeholders must survive) is here and testable without a model.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::rules::placeholders;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftItem {
    pub id: String,
    pub lang: String,
    pub reference: String,
    pub ref_lang: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Drafted {
    pub id: String,
    pub text: String,
    /// False when the placeholders differ from the reference: the UI shows it as a warning and refuses a blind accept.
    pub valid: bool,
    pub note: Option<String>,
}

pub fn lang_name(code: &str) -> &'static str {
    match code.split(['-', '_']).next().unwrap_or(code) {
        "en" => "English",
        "hu" => "Hungarian",
        "de" => "German",
        "cz" | "cs" => "Czech",
        "sk" => "Slovak",
        "fr" => "French",
        "it" => "Italian",
        "es" => "Spanish",
        "ro" => "Romanian",
        "pl" => "Polish",
        "cn" | "zh" => "Simplified Chinese",
        "svn" | "sl" => "Slovenian",
        "sv" => "Swedish",
        "pt" => "Portuguese",
        "nl" => "Dutch",
        "ru" => "Russian",
        "uk" => "Ukrainian",
        "hr" => "Croatian",
        "sr" => "Serbian",
        "bg" => "Bulgarian",
        "ja" => "Japanese",
        "ko" => "Korean",
        "tr" => "Turkish",
        _ => "the language named by the code",
    }
}

pub fn prompt(items: &[DraftItem]) -> String {
    let list: Vec<_> = items.iter().map(|i| serde_json::json!({ "id": i.id, "from": lang_name(&i.ref_lang), "to": lang_name(&i.lang), "text": i.reference })).collect();
    format!(
        "You are the docs-writer for a business application. Translate each UI string into the target language.\n\
         Rules: keep every placeholder exactly as written ({{{{name}}}}, %s, %d, %1$s); keep emoji, punctuation style and capitalisation conventions of the target language; \
         do not add quotes or explanations; plural-form entries (names ending _one/_few/_many/_other) mean the text for that plural category.\n\
         Answer with ONLY a JSON array of {{\"id\": ..., \"text\": ...}} objects, one per input, same ids.\n\nINPUT:\n{}\n",
        serde_json::to_string(&list).unwrap_or_default()
    )
}

/// Pulls the JSON array out of the model answer (it may be wrapped in a code fence) and checks the placeholders.
pub fn parse(output: &str, items: &[DraftItem]) -> Result<Vec<Drafted>, String> {
    let (a, b) = (output.find('['), output.rfind(']'));
    let (Some(a), Some(b)) = (a, b) else { return Err("the model answered without a JSON array".into()) };
    if b < a {
        return Err("the model answered without a JSON array".into());
    }
    #[derive(Deserialize)]
    struct Raw {
        id: String,
        text: String,
    }
    let raw: Vec<Raw> = serde_json::from_str(&output[a..=b]).map_err(|e| format!("unreadable model answer: {e}"))?;
    let wanted: BTreeSet<&str> = items.iter().map(|i| i.id.as_str()).collect();
    let mut out = Vec::new();
    for r in raw {
        let Some(item) = items.iter().find(|i| i.id == r.id).filter(|_| wanted.contains(r.id.as_str())) else { continue };
        let text = r.text.trim().to_string();
        let (want, have) = (placeholders(&item.reference), placeholders(&text));
        let (valid, note) = if text.is_empty() {
            (false, Some("empty".to_string()))
        } else if want != have {
            (false, Some(format!("placeholders differ: expected {}, got {}", join(&want), join(&have))))
        } else {
            (true, None)
        };
        out.push(Drafted { id: r.id, text, valid, note });
    }
    Ok(out)
}

fn join(s: &BTreeSet<String>) -> String {
    if s.is_empty() {
        "none".into()
    } else {
        s.iter().cloned().collect::<Vec<_>>().join(" ")
    }
}
