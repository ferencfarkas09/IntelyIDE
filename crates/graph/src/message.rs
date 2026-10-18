//! Commit message helpers: the Conventional Commits validator and the two-part "Extended English" template (the draft
//! for a selection of changes lives in `draft.rs`). The helpers never add trailers (no `Signed-off-by`, no attribution):
//! that stays with the person committing.

use std::future::Future;
use std::pin::Pin;

use intely_core::EngineError;

use crate::types::{MessageCheck, MessageIssue, MessageStyle, ParsedHeader, Severity};

pub const TYPES: [&str; 11] = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"];
pub const ENGLISH_LABEL: &str = "Extended English:";
pub const HUNGARIAN_LABEL: &str = "Magyar bővített leírás:";
/// The rule between the two parts, as in the project's `.gitmessage`.
pub const DIVIDER: &str = "-------";
const HEADER_LIMIT: usize = 100;

/// The utility model behind `draftMessage`: a tool-less one-shot completion (the shell plugs in the `claude -p` one-shot).
/// Without one, or when it fails, the draft is composed locally.
pub trait DraftModel: Send + Sync {
    fn complete<'a>(&'a self, prompt: String) -> Pin<Box<dyn Future<Output = Result<String, EngineError>> + Send + 'a>>;
}

fn issue(severity: Severity, code: &str, message: impl Into<String>) -> MessageIssue {
    MessageIssue { severity, code: code.to_owned(), message: message.into() }
}

pub(crate) fn parse_header(header: &str) -> Result<ParsedHeader, MessageIssue> {
    let bad = || issue(Severity::Error, "header.format", "the first line must look like `type(scope): description`");
    let (prefix, description) = header.split_once(": ").ok_or_else(bad)?;
    let (prefix, breaking) = prefix.strip_suffix('!').map_or((prefix, false), |p| (p, true));
    let (kind, scope) = match prefix.split_once('(') {
        Some((kind, rest)) => {
            let scope = rest.strip_suffix(')').ok_or_else(bad)?;
            (kind, Some(scope))
        }
        None => (prefix, None),
    };
    if kind.is_empty() || !kind.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err(bad());
    }
    Ok(ParsedHeader { kind: kind.to_owned(), scope: scope.map(str::to_owned), breaking, description: description.trim().to_owned() })
}

/// The text after `label` up to the next blank line / label, if the label starts a line.
fn labelled(message: &str, label: &str) -> Option<String> {
    let at = message.lines().position(|l| l.starts_with(label))?;
    let mut text = message.lines().nth(at)?[label.len()..].trim().to_owned();
    for line in message.lines().skip(at + 1) {
        if line.trim().is_empty() || line.starts_with(ENGLISH_LABEL) || line.starts_with(HUNGARIAN_LABEL) {
            break;
        }
        text.push(' ');
        text.push_str(line.trim());
    }
    Some(text.trim().to_owned())
}

/// A trailer or footer that credits an AI tool. Prose that merely says something was "generated with" a tool, or links to a vendor's
/// documentation, is not one.
pub(crate) fn is_ai_attribution(line: &str) -> bool {
    const TOOLS: [&str; 7] = ["claude", "anthropic", "copilot", "chatgpt", "openai", "gemini", "codex"];
    let l = line.trim().to_lowercase();
    let names_a_tool = TOOLS.iter().any(|t| l.contains(t));
    l.starts_with("generated-by:")
        || l.starts_with("assisted-by:")
        || (l.starts_with("co-authored-by:") && names_a_tool)
        || (l.contains("generated with") && names_a_tool)
        || l.contains("noreply@anthropic.com")
        || l.contains('\u{1F916}')
}

pub fn validate(message: &str, style: &MessageStyle) -> MessageCheck {
    let mut issues = Vec::new();
    let message = message.trim_end();
    let mut lines = message.lines();
    let header_line = lines.next().unwrap_or_default();
    let header = if header_line.trim().is_empty() {
        issues.push(issue(Severity::Error, "header.empty", "the message is empty"));
        None
    } else {
        match parse_header(header_line) {
            Ok(h) => {
                if !TYPES.contains(&h.kind.as_str()) {
                    issues.push(issue(Severity::Error, "type.unknown", format!("unknown type `{}` (use {})", h.kind, TYPES.join(", "))));
                }
                if h.scope.as_deref() == Some("") {
                    issues.push(issue(Severity::Error, "scope.empty", "the scope in parentheses is empty"));
                }
                if h.description.is_empty() {
                    issues.push(issue(Severity::Error, "description.empty", "the description after the colon is empty"));
                } else if h.description.ends_with('.') {
                    issues.push(issue(Severity::Warning, "description.period", "the description should not end with a period"));
                }
                Some(h)
            }
            Err(i) => {
                issues.push(i);
                None
            }
        }
    };
    if header_line.chars().count() > HEADER_LIMIT {
        issues.push(issue(Severity::Warning, "header.tooLong", format!("the first line is longer than {HEADER_LIMIT} characters")));
    }
    if lines.next().is_some_and(|second| !second.trim().is_empty()) {
        issues.push(issue(Severity::Error, "body.blankLine", "leave a blank line between the first line and the body"));
    }
    if matches!(style, MessageStyle::Extended) {
        match labelled(message, ENGLISH_LABEL) {
            None => issues.push(issue(Severity::Error, "extended.missingEnglish", format!("add a paragraph starting with `{ENGLISH_LABEL}`"))),
            Some(t) if t.is_empty() => issues.push(issue(Severity::Error, "extended.emptyEnglish", format!("`{ENGLISH_LABEL}` has no text"))),
            Some(_) => {}
        }
        match labelled(message, HUNGARIAN_LABEL) {
            None => issues.push(issue(Severity::Error, "extended.missingHungarian", format!("add a paragraph starting with `{HUNGARIAN_LABEL}`"))),
            Some(t) if t.is_empty() => issues.push(issue(Severity::Error, "extended.emptyHungarian", format!("`{HUNGARIAN_LABEL}` has no text"))),
            Some(t) if t.chars().count() > 60 && !t.chars().any(|c| "áéíóöőúüűÁÉÍÓÖŐÚÜŰ".contains(c)) => {
                issues.push(issue(Severity::Warning, "extended.notHungarian", "the Hungarian paragraph has no accented letters: is it really Hungarian?"));
            }
            Some(_) => {}
        }
        let (en, hu) = (message.find(ENGLISH_LABEL), message.find(HUNGARIAN_LABEL));
        if let (Some(en), Some(hu)) = (en, hu) {
            if hu < en {
                issues.push(issue(Severity::Error, "extended.order", "the English paragraph comes first"));
            }
        }
    }
    if message.lines().any(is_ai_attribution) {
        issues.push(issue(Severity::Error, "attribution.ai", "remove the AI attribution line: commits carry only the developer's name"));
    }
    MessageCheck { ok: !issues.iter().any(|i| matches!(i.severity, Severity::Error)), header, issues }
}

/// A fill-in-the-blanks message: the labels are present and empty, so the validator flags what is still missing.
pub fn template(style: &MessageStyle, subject: Option<&str>) -> String {
    let header = subject.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("type(scope): description");
    match style {
        MessageStyle::Conventional => format!("{header}\n"),
        MessageStyle::Extended => format!("{header}\n\n{ENGLISH_LABEL}\n\n{DIVIDER}\n{HUNGARIAN_LABEL}\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codes(check: &MessageCheck) -> Vec<&str> {
        check.issues.iter().map(|i| i.code.as_str()).collect()
    }

    const GOOD: &str = "feat(crm): let users edit quick statuses\n\nExtended English: Adds an editor modal. Users can reorder the pills.\n\nMagyar bővített leírás: Új szerkesztő modal. A felhasználó átrendezheti a státuszokat.\n\nSigned-off-by: Someone <a@b.c>\n";

    #[test]
    fn the_users_extended_format_validates() {
        let check = validate(GOOD, &MessageStyle::Extended);
        assert!(check.ok, "{:?}", check.issues);
        let h = check.header.expect("header");
        assert_eq!((h.kind.as_str(), h.scope.as_deref(), h.breaking), ("feat", Some("crm"), false));
    }

    #[test]
    fn conventional_header_problems_are_reported() {
        assert_eq!(codes(&validate("Fix the thing", &MessageStyle::Conventional)), vec!["header.format"]);
        assert_eq!(codes(&validate("wip: stuff", &MessageStyle::Conventional)), vec!["type.unknown"]);
        assert_eq!(codes(&validate("fix(): x", &MessageStyle::Conventional)), vec!["scope.empty"]);
        assert_eq!(codes(&validate("fix: x\nbody right away", &MessageStyle::Conventional)), vec!["body.blankLine"]);
        let breaking = validate("feat(api)!: drop v1", &MessageStyle::Conventional);
        assert!(breaking.ok && breaking.header.expect("h").breaking);
    }

    #[test]
    fn the_extended_style_needs_both_paragraphs_in_order() {
        let c = validate("fix: x\n\nExtended English: only english\n", &MessageStyle::Extended);
        assert_eq!(codes(&c), vec!["extended.missingHungarian"]);
        let c = validate("fix: x\n\nMagyar bővített leírás: első\n\nExtended English: second\n", &MessageStyle::Extended);
        assert_eq!(codes(&c), vec!["extended.order"]);
        assert!(!validate(&template(&MessageStyle::Extended, Some("fix: x")), &MessageStyle::Extended).ok);
    }

    #[test]
    fn ai_attribution_is_an_error_but_a_human_coauthor_is_not() {
        assert!(codes(&validate("fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n", &MessageStyle::Conventional)).contains(&"attribution.ai"));
        assert!(validate("fix: x\n\nCo-Authored-By: Peter D <p@example.com>\n", &MessageStyle::Conventional).ok);
    }

    #[test]
    fn templates_carry_no_trailer() {
        let t = template(&MessageStyle::Extended, None);
        assert!(t.contains(ENGLISH_LABEL) && t.contains(HUNGARIAN_LABEL));
        assert!(!t.to_lowercase().contains("signed-off") && !t.to_lowercase().contains("co-authored"));
    }
}
