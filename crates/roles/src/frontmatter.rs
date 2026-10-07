//! Markdown files with a YAML frontmatter block (`~/.claude/agents/*.md`), edited in place. Only the keys the caller
//! sets are rewritten; every other line (unknown keys, comments, multi-line values, formatting) and the body survive
//! byte for byte, and a value that is already equal is not rewritten at all.

#[derive(Debug, Clone, PartialEq)]
struct Entry {
    /// `None` for comments and blank lines.
    key: Option<String>,
    lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    eol: &'static str,
    bom: bool,
    entries: Vec<Entry>,
    has_block: bool,
    body: String,
}

fn key_of(line: &str) -> Option<(&str, &str)> {
    let (k, rest) = line.split_once(':')?;
    let ok = !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    (ok && (rest.is_empty() || rest.starts_with(' ') || rest.starts_with('\t'))).then_some((k, rest.trim()))
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    let b = v.as_bytes();
    if b.len() >= 2 && ((b[0] == b'"' && b[b.len() - 1] == b'"') || (b[0] == b'\'' && b[b.len() - 1] == b'\'')) {
        if b[0] == b'"' {
            if let Ok(s) = serde_json::from_str::<String>(v) {
                return s;
            }
        }
        return v[1..v.len() - 1].to_string();
    }
    v.to_string()
}

/// The value of a list key as [`Document::list_declared`] read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListValue {
    pub items: Vec<String>,
    /// False when the value was not a list of names (`tools: {a: b}`, an unbalanced `Bash(`): `items` is then empty.
    pub ok: bool,
}

/// Splits on commas that are not inside parentheses or quotes.
fn split_top(s: &str) -> Vec<String> {
    let (mut out, mut cur, mut depth, mut quote) = (Vec::new(), String::new(), 0i32, None::<char>);
    for c in s.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '(') => depth += 1,
            (None, ')') => depth -= 1,
            (None, ',') if depth <= 0 => {
                out.push(std::mem::take(&mut cur).trim().to_string());
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    out.push(cur.trim().to_string());
    out
}

/// A tool name: letters, digits, `_`, `-`, `.`, optionally followed by one balanced `( ... )` pattern.
fn valid_item(item: &str) -> bool {
    let base = item.split('(').next().unwrap_or("");
    let pattern_ok = match item.find('(') {
        None => true,
        Some(i) => item.ends_with(')') && item[i..].matches('(').count() == item[i..].matches(')').count(),
    };
    !base.is_empty() && base.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':')) && pattern_ok
}

/// Drops a trailing YAML comment (` #` outside quotes) from a plain value.
fn strip_comment(v: &str) -> String {
    let mut quote = None::<char>;
    let mut prev = ' ';
    for (i, c) in v.char_indices() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '#') if prev.is_whitespace() => return v[..i].trim_end().to_string(),
            _ => {}
        }
        prev = c;
    }
    v.to_string()
}

fn quote_if_needed(v: &str) -> String {
    let plain = !v.is_empty()
        && v == v.trim()
        && !v.contains(": ")
        && !v.contains(" #")
        && !v.contains(['\n', '\r', '"', '\''])
        && !v.starts_with(['[', ']', '{', '}', '&', '*', '!', '|', '>', '%', '@', '`', '#', '-', '?', ',']);
    if plain {
        v.to_string()
    } else {
        serde_json::to_string(v).unwrap_or_else(|_| format!("\"{v}\""))
    }
}

impl Document {
    pub fn parse(text: &str) -> Self {
        let (bom, text) = match text.strip_prefix('\u{feff}') {
            Some(t) => (true, t),
            None => (false, text),
        };
        let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
        let mut doc = Self { eol, bom, entries: Vec::new(), has_block: false, body: text.to_string() };
        let mut lines = text.split_inclusive('\n');
        let strip = |l: &str| l.trim_end_matches(['\n', '\r']).to_string();
        if lines.next().map(|l| strip(l)) != Some("---".into()) {
            return doc;
        }
        let mut consumed = text.split_inclusive('\n').next().map_or(0, str::len);
        let mut entries: Vec<Entry> = Vec::new();
        for raw in lines {
            consumed += raw.len();
            let line = strip(raw);
            if line == "---" {
                doc.entries = entries;
                doc.has_block = true;
                doc.body = text[consumed..].to_string();
                return doc;
            }
            let continuation = line.is_empty() || line.starts_with([' ', '\t']) || line.starts_with("- ");
            match (continuation, entries.last_mut()) {
                (true, Some(last)) if last.key.is_some() => last.lines.push(line),
                _ => entries.push(Entry { key: key_of(&line).filter(|_| !line.starts_with('#')).map(|(k, _)| k.to_string()), lines: vec![line] }),
            }
        }
        doc // no closing fence: not a frontmatter block, the whole text is the body
    }

    /// True when the file opens with a closed `---` block. Without one (no fence, a fence never closed) Claude Code
    /// does not read the file as an agent definition, so none of its lines can be trusted to say what it may do.
    pub fn has_frontmatter(&self) -> bool {
        self.has_block
    }

    pub fn body(&self) -> &str {
        &self.body
    }

    /// The body without the blank lines around it.
    pub fn prompt(&self) -> &str {
        self.body.trim()
    }

    pub fn set_prompt(&mut self, prompt: &str) {
        if self.prompt() == prompt.trim() {
            return;
        }
        let eol = self.eol;
        self.body = format!("{eol}{}{eol}", prompt.trim()).replace("\r\n", "\n").replace('\n', eol);
        self.has_block = true;
    }

    pub fn keys(&self) -> Vec<&str> {
        self.entries.iter().filter_map(|e| e.key.as_deref()).collect()
    }

    fn entry(&self, key: &str) -> Option<&Entry> {
        self.entries.iter().find(|e| e.key.as_deref() == Some(key))
    }

    /// The scalar value of `key` (quotes removed, block scalars joined).
    pub fn get(&self, key: &str) -> Option<String> {
        let e = self.entry(key)?;
        let (_, first) = key_of(&e.lines[0])?;
        let rest: Vec<&str> = e.lines[1..].iter().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
        let joined = match first {
            "|" | "|-" | "|+" => rest.join("\n"),
            ">" | ">-" | ">+" => rest.join(" "),
            "" if rest.iter().all(|l| l.starts_with("- ")) && !rest.is_empty() => return None,
            _ if rest.is_empty() => return Some(unquote(first)).filter(|v| !v.is_empty()),
            _ => std::iter::once(first).chain(rest.iter().copied()).collect::<Vec<_>>().join(" "),
        };
        Some(joined).filter(|v| !v.is_empty())
    }

    /// A list value: `[a, b]`, `a, b` or a block of `- item` lines. Commas inside parentheses do not split
    /// (`Bash(git status:*), Read` is two items).
    pub fn get_list(&self, key: &str) -> Vec<String> {
        self.list_declared(key).map(|l| l.items).unwrap_or_default()
    }

    /// Like [`Self::get_list`], but tells an ABSENT key (`None`) from one that is present and empty or unparsable
    /// (`Some` with no items; `ok` is false when the value could not be read as a list of names). The permission
    /// derivation needs the difference: an absent `tools` means "all tools", a broken one never does.
    pub fn list_declared(&self, key: &str) -> Option<ListValue> {
        let e = self.entry(key)?;
        let Some((_, first)) = key_of(&e.lines[0]) else { return Some(ListValue { items: Vec::new(), ok: false }) };
        let first = strip_comment(first);
        let first = first.as_str();
        let items: Vec<String> = if first.is_empty() {
            e.lines[1..].iter().filter_map(|l| l.trim().strip_prefix("- ")).map(unquote).collect()
        } else if first.starts_with(['|', '>', '{']) {
            return Some(ListValue { items: Vec::new(), ok: false });
        } else {
            let inner = first.strip_prefix('[').map_or(first, |f| f.strip_suffix(']').unwrap_or(f));
            split_top(inner).iter().map(|s| unquote(s)).collect()
        };
        let items: Vec<String> = items.into_iter().filter(|s| !s.is_empty()).collect();
        if items.iter().all(|i| valid_item(i)) {
            Some(ListValue { items, ok: true })
        } else {
            Some(ListValue { items: Vec::new(), ok: false })
        }
    }

    /// Claude Code's `permissionMode` key (read only; the editor never writes it). A trailing YAML comment
    /// (`plan # note`) is not part of the value.
    pub fn permission_mode(&self) -> Option<String> {
        self.get("permissionMode").map(|m| unquote(&strip_comment(&m)))
    }

    pub fn disallowed_tools(&self) -> Vec<String> {
        self.get_list("disallowedTools")
    }

    pub fn max_turns(&self) -> Option<u32> {
        self.get("maxTurns").and_then(|v| v.trim().parse().ok())
    }

    /// Sets (or with `None` removes) a scalar. Equal values leave the file untouched.
    pub fn set(&mut self, key: &str, value: Option<&str>) {
        if self.get(key).as_deref() == value.filter(|v| !v.is_empty()) {
            return;
        }
        self.replace(key, value.filter(|v| !v.is_empty()).map(|v| format!("{key}: {}", quote_if_needed(v))));
    }

    /// Sets a list as `key: a, b, c` (the style Claude Code writes `tools` in); an empty list removes the key.
    pub fn set_list(&mut self, key: &str, values: &[String]) {
        if self.get_list(key) == values {
            return;
        }
        self.replace(key, (!values.is_empty()).then(|| format!("{key}: {}", values.join(", "))));
    }

    fn replace(&mut self, key: &str, line: Option<String>) {
        self.has_block = true;
        match (self.entries.iter().position(|e| e.key.as_deref() == Some(key)), line) {
            (Some(i), Some(l)) => self.entries[i].lines = vec![l],
            (Some(i), None) => {
                self.entries.remove(i);
            }
            (None, Some(l)) => self.entries.push(Entry { key: Some(key.to_string()), lines: vec![l] }),
            (None, None) => {}
        }
    }

    pub fn render(&self) -> String {
        let eol = self.eol;
        let mut out = String::new();
        if self.bom {
            out.push('\u{feff}');
        }
        if self.has_block {
            out.push_str(&format!("---{eol}"));
            for l in self.entries.iter().flat_map(|e| &e.lines) {
                out.push_str(l);
                out.push_str(eol);
            }
            out.push_str(&format!("---{eol}"));
        }
        out.push_str(&self.body);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\nname: reviewer\n# kept comment\ndescription: Reviews: carefully\nmodel: sonnet\ntools:\n  - Read\n  - Grep\nhooks:\n  pre: |\n    echo hi\ncustom-key: 'keep me'\n---\n\nYou review code.\n\nSecond paragraph.\n";

    #[test]
    fn reads_scalars_lists_and_the_prompt() {
        let d = Document::parse(SAMPLE);
        assert_eq!(d.get("name").as_deref(), Some("reviewer"));
        assert_eq!(d.get("description").as_deref(), Some("Reviews: carefully"));
        assert_eq!(d.get_list("tools"), ["Read", "Grep"]);
        assert_eq!(d.get("custom-key").as_deref(), Some("keep me"));
        assert_eq!(d.prompt(), "You review code.\n\nSecond paragraph.");
        assert_eq!(d.keys(), ["name", "description", "model", "tools", "hooks", "custom-key"]);
    }

    #[test]
    fn an_unchanged_document_renders_byte_for_byte() {
        assert_eq!(Document::parse(SAMPLE).render(), SAMPLE);
        let mut d = Document::parse(SAMPLE);
        d.set("model", Some("sonnet"));
        d.set_list("tools", &["Read".into(), "Grep".into()]);
        d.set_prompt("You review code.\n\nSecond paragraph.");
        assert_eq!(d.render(), SAMPLE);
    }

    #[test]
    fn editing_known_keys_keeps_unknown_keys_comments_and_the_body() {
        let mut d = Document::parse(SAMPLE);
        d.set("model", Some("opus"));
        d.set("effort", Some("high"));
        d.set_list("tools", &["Read".into(), "Glob".into()]);
        d.set("color", None);
        let out = d.render();
        assert!(out.contains("model: opus\n") && out.contains("effort: high\n") && out.contains("tools: Read, Glob\n"));
        assert!(out.contains("# kept comment\n") && out.contains("hooks:\n  pre: |\n    echo hi\n") && out.contains("custom-key: 'keep me'\n"));
        assert!(out.ends_with("---\n\nYou review code.\n\nSecond paragraph.\n"));
        assert!(!out.contains("  - Read"));
        let back = Document::parse(&out);
        assert_eq!(back.get("effort").as_deref(), Some("high"));
        assert_eq!(back.get_list("tools"), ["Read", "Glob"]);
    }

    #[test]
    fn awkward_values_are_quoted_and_survive_a_round_trip() {
        let mut d = Document::parse("---\nname: x\n---\nbody\n");
        d.set("description", Some("Fixes: bugs # fast\nsecond line"));
        let back = Document::parse(&d.render());
        assert_eq!(back.get("description").as_deref(), Some("Fixes: bugs # fast\nsecond line"));
        assert_eq!(back.prompt(), "body");
    }

    #[test]
    fn a_file_without_frontmatter_gets_one_and_keeps_its_text() {
        let mut d = Document::parse("Just a prompt.\n");
        assert!(d.keys().is_empty());
        d.set("name", Some("helper"));
        assert_eq!(d.render(), "---\nname: helper\n---\nJust a prompt.\n");
        let unclosed = Document::parse("---\nname: x\nno end\n");
        assert!(unclosed.keys().is_empty());
        assert_eq!(unclosed.render(), "---\nname: x\nno end\n");
    }

    #[test]
    fn crlf_and_bom_are_preserved() {
        let text = "\u{feff}---\r\nname: a\r\n---\r\nBody\r\n";
        let mut d = Document::parse(text);
        assert_eq!(d.render(), text);
        d.set("model", Some("haiku"));
        d.set_prompt("New\nbody");
        assert_eq!(d.render(), "\u{feff}---\r\nname: a\r\nmodel: haiku\r\n---\r\n\r\nNew\r\nbody\r\n");
    }

    #[test]
    fn block_scalars_join_and_inline_lists_parse() {
        let d = Document::parse("---\ndescription: >\n  one\n  two\ntools: [Read, \"Bash\"]\n---\n");
        assert_eq!(d.get("description").as_deref(), Some("one two"));
        assert_eq!(d.get_list("tools"), ["Read", "Bash"]);
    }

    #[test]
    fn lists_split_outside_parentheses_only() {
        let d = Document::parse("---\ntools: Bash(git status:*), Read\n---\n");
        assert_eq!(d.get_list("tools"), ["Bash(git status:*)", "Read"]);
        let d = Document::parse("---\ntools: [Bash(a, b), \"Read\"]\n---\n");
        assert_eq!(d.get_list("tools"), ["Bash(a, b)", "Read"]);
    }

    #[test]
    fn a_missing_list_differs_from_an_empty_or_broken_one() {
        let d = Document::parse("---\nname: a\ntools:\nempty: []\nbroken: {a: b}\nunbalanced: Bash(x, Read\ninline-empty: []\n---\n");
        assert_eq!(d.list_declared("nope"), None);
        assert_eq!(d.list_declared("tools"), Some(ListValue { items: vec![], ok: true }));
        assert_eq!(d.list_declared("inline-empty"), Some(ListValue { items: vec![], ok: true }));
        assert_eq!(d.list_declared("broken"), Some(ListValue { items: vec![], ok: false }));
        assert_eq!(d.list_declared("unbalanced"), Some(ListValue { items: vec![], ok: false }));
        let d = Document::parse("---\npermissionMode: plan\nmaxTurns: 12\ndisallowedTools: Edit, Write\n---\n");
        assert_eq!((d.permission_mode().as_deref(), d.max_turns(), d.disallowed_tools()), (Some("plan"), Some(12), vec!["Edit".to_string(), "Write".into()]));
    }
}
