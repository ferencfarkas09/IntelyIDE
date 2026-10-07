//! Value-free error text for everything that goes back to a model (repair loop, Fix input).
//!
//! Server messages can echo values (duplicate-key and cast errors name the offending value), so the message string is
//! dropped entirely: only the numeric code, the code name and a generic hint from a fixed table survive.

use serde::{Deserialize, Serialize};

/// Error from the database port. `message` is kept for local logs only and never leaves through [`value_free`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DbError {
    pub code: Option<i32>,
    pub code_name: Option<String>,
    pub message: String,
}

impl DbError {
    pub fn new(code: Option<i32>, code_name: Option<&str>, message: impl Into<String>) -> Self {
        Self { code, code_name: code_name.map(str::to_string), message: message.into() }
    }
    /// Parses the driver's formatted text `CodeName (123): message`; anything else becomes a code-less error.
    pub fn from_driver_text(text: &str) -> Self {
        if let Some((head, _rest)) = text.split_once("): ") {
            if let Some((name, code)) = head.rsplit_once(" (") {
                if let Ok(c) = code.parse::<i32>() {
                    if name.chars().all(|ch| ch.is_ascii_alphanumeric()) {
                        return Self { code: Some(c), code_name: Some(name.to_string()), message: text.to_string() };
                    }
                }
            }
        }
        Self { code: None, code_name: None, message: text.to_string() }
    }
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for DbError {}

fn hint(code: i32) -> &'static str {
    match code {
        2 => "a value or operator has the wrong form (BadValue); check operator arguments",
        9 | 15 | 40 | 52 | 17287 => "the query text could not be parsed or an operator is misused; check braces, operator names and argument types",
        14 | 16 | 241 => "a value has the wrong type for its operator; check number, string, date and ObjectId types",
        26 => "the collection does not exist; use one of the listed collections",
        50 => "the query ran into the time limit; add a more selective filter or an index-friendly condition",
        96 | 292 => "the operation needs more memory than allowed; add a filter or a limit",
        13 | 18 | 8000 => "not authorized for this query",
        66 | 10334 => "the document or result is too large",
        _ => "the server rejected the query; simplify it",
    }
}

fn safe_name(n: &str) -> Option<&str> {
    (!n.is_empty() && n.len() <= 48 && n.chars().all(|c| c.is_ascii_alphanumeric())).then_some(n)
}

/// `server error 2 BadValue: ...hint...`; never the message.
pub fn value_free(e: &DbError) -> String {
    let code = e.code.map_or(String::new(), |c| format!(" {c}"));
    let name = e.code_name.as_deref().and_then(safe_name).map_or(String::new(), |n| format!(" {n}"));
    format!("server error{code}{name}: {}", hint(e.code.unwrap_or(0)))
}

/// Generic cap for any other feedback line (validator and parser messages): single line, bounded, no control characters.
pub fn clean_line(s: &str) -> String {
    let mut o: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    if o.chars().count() > 240 {
        o = o.chars().take(240).collect::<String>() + "...";
    }
    o
}
