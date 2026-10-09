//! POSIX-ish shell tokeniser for the permission broker (providers-plan 1.6, 5.4).
//!
//! It never executes or expands anything: it splits a command string into simple commands, resolves quoting
//! (`git "com"mit` is `git commit`), and *flags* what it cannot know (variables, brace expansion, command
//! and process substitution, heredocs it could not read). Bodies of `$(...)`, backticks and `<(...)` are
//! parsed recursively and merged in (marked `nested`), so a hard stop inside them is still found; the
//! substitution itself is recorded as an [`Issue`], which makes the whole command "unparseable" (ask, never saved).

use std::fmt;

pub const MAX_DEPTH: usize = 8;

const RESERVED: [&str; 14] = ["!", "{", "}", "if", "then", "elif", "else", "fi", "do", "done", "while", "until", "function", "coproc"];

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Word {
    /// The word with quoting removed. For dynamic words the unexpanded source text (`$HOME/x`).
    pub text: String,
    /// The value is unknown statically: variable, brace expansion, substitution.
    pub dynamic: bool,
    /// An unquoted glob metacharacter (`*`, `?`, `[`) is present.
    pub glob: bool,
    /// A quote or an escape is part of the word: `""` is an (empty) word, an empty `$x` alone is no word at all.
    pub quoted: bool,
    /// A dynamic word that holds only literal text and plain `$name` / `${name}` expansions: its pieces in order, so a caller that
    /// knows the variables can read the word the way the shell will (what is quoted is not split). `None` for every other word, and
    /// for a dynamic one with any other expansion (`$(...)`, `${x:-y}`, `$1`, braces).
    pub parts: Option<Vec<Part>>,
}

/// One piece of a [`Word`] that holds only literal text and plain parameter expansions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Part {
    /// Text as the shell sees it (quotes removed; whatever it holds is not expanded again).
    Lit(String),
    /// `$name` or `${name}`. `quoted` when it stands inside double quotes: its value is then one piece of the word.
    Var { name: String, quoted: bool },
}

impl Word {
    pub fn lit(text: &str) -> Self {
        Self { text: text.to_string(), ..Self::default() }
    }
}

/// `[A-Za-z_][A-Za-z0-9_]*`
pub fn is_name(n: &str) -> bool {
    let mut chars = n.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedirKind {
    /// `>`, `>>`, `>|`, `&>`, `&>>`
    Write,
    /// `<`
    Read,
    /// `<>`
    ReadWrite,
    /// `>&`, `<&` (a numeric or `-` target is a descriptor, anything else a file)
    Dup,
    HereDoc,
    HereString,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redirect {
    pub kind: RedirKind,
    pub target: Word,
    /// Heredoc body or here-string text (a script when the consumer is a shell).
    pub body: Option<String>,
}

impl Redirect {
    /// True when the redirect writes to a file named by `target`.
    pub fn writes_file(&self) -> bool {
        match self.kind {
            RedirKind::Write | RedirKind::ReadWrite => true,
            RedirKind::Dup => !(self.target.text == "-" || self.target.text.chars().all(|c| c.is_ascii_digit())),
            _ => false,
        }
    }
}

/// How a command is joined to the one before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Sep {
    /// `;`, a newline, a parenthesis or the start of the script.
    #[default]
    Seq,
    /// `&&`: runs only when the command before it succeeded.
    And,
    /// `||`: runs only when the command before it failed.
    Or,
    /// `|` and `|&`: both sides run in subshells.
    Pipe,
    /// The command before it ended with `&` (it ran in the background).
    Bg,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Command {
    pub assigns: Vec<(String, Word)>,
    pub words: Vec<Word>,
    pub redirects: Vec<Redirect>,
    /// Directly after a `|`: stdin is another command's output.
    pub piped_from_prev: bool,
    /// Came from inside a substitution.
    pub nested: bool,
    /// How it is joined to the command before it.
    pub after: Sep,
    /// The reserved words that were peeled off its front (`do`, `then`, `done` ...). A `done` that is left with nothing to run is kept
    /// as a command without words, so the end of a `for` loop can be found in the flat list.
    pub reserved: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Issue {
    Substitution,
    ProcessSubstitution,
    Unterminated(&'static str),
    TooDeep,
    /// A parenthesis stuck to a word (`*(D)`, `.e(n)v`, `f(){`, `a=(1 2)`) or text stuck to a closing one (`(.)env`): in zsh a glob qualifier
    /// or a group of a pattern, which names files the words do not show.
    Parenthesis,
}

impl fmt::Display for Issue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Issue::Substitution => f.write_str("command substitution"),
            Issue::ProcessSubstitution => f.write_str("process substitution"),
            Issue::Unterminated(what) => write!(f, "unterminated {what}"),
            Issue::TooDeep => f.write_str("nesting too deep"),
            Issue::Parenthesis => f.write_str("a parenthesis inside a word (zsh reads it as part of a glob)"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Script {
    pub commands: Vec<Command>,
    pub issues: Vec<Issue>,
    /// The string has a construct whose effect on the variables the flat command list cannot show: a parenthesis outside a
    /// substitution (a subshell, a function, an array), an arithmetic expansion (`$((x=1))`, `$[x=1]`) or a parameter expansion that
    /// assigns (`${x:=y}`). What an assignment did is not followed then (see `hardstop/vars.rs`).
    pub opaque: bool,
}

pub fn parse(src: &str) -> Script {
    parse_at(src, 0)
}

/// Splits `src` into plain words (quotes resolved, nothing else): used for `env -S`.
pub fn split_words(src: &str) -> Vec<Word> {
    parse(src).commands.into_iter().flat_map(|c| c.words).collect()
}

fn parse_at(src: &str, depth: usize) -> Script {
    let mut lx = Lexer::new(src, depth);
    lx.run();
    lx.script
}

struct HereDocSpec {
    delim: String,
    strip_tabs: bool,
    expands: bool,
}

#[derive(Default)]
struct WordBuf {
    text: String,
    dynamic: bool,
    glob: bool,
    quoted: bool,
    brace_open: u32,
    brace_comma: bool,
    /// A dynamic part that is not a plain `$name` / `${name}`: the word cannot be read from its pieces.
    impure: bool,
    /// The plain expansions in order (see [`Word::parts`]).
    exps: Vec<Exp>,
}

/// A plain expansion inside [`WordBuf::text`]: its raw source is `text[start..start + len]`.
struct Exp {
    start: usize,
    len: usize,
    name: String,
    quoted: bool,
}

impl WordBuf {
    /// Pushes the raw source of an expansion; a plain one (`name` is a valid variable name) is remembered so the word can be read
    /// from its pieces later.
    fn expansion(&mut self, raw: &str, name: Option<String>, in_dq: bool) {
        self.dynamic = true;
        match name {
            Some(name) => self.exps.push(Exp { start: self.text.len(), len: raw.len(), name, quoted: in_dq }),
            None => self.impure = true,
        }
        self.text.push_str(raw);
    }

    fn parts(&self) -> Option<Vec<Part>> {
        if !self.dynamic || self.impure || self.exps.is_empty() {
            return None;
        }
        // zsh reads `$x[1,4]` and `${x}[1,4]` as a slice of the value, bash as the value followed by text: not read from its pieces
        let end_of = |e: &Exp| e.start + e.len;
        if self.exps.iter().any(|e| self.text[end_of(e)..].starts_with('[')) {
            return None;
        }
        let mut out = Vec::new();
        let mut pos = 0;
        for e in &self.exps {
            if e.start > pos {
                out.push(Part::Lit(self.text[pos..e.start].to_string()));
            }
            out.push(Part::Var { name: e.name.clone(), quoted: e.quoted });
            pos = e.start + e.len;
        }
        if pos < self.text.len() {
            out.push(Part::Lit(self.text[pos..].to_string()));
        }
        Some(out)
    }
}

struct Lexer {
    c: Vec<char>,
    i: usize,
    depth: usize,
    script: Script,
    cur: Option<WordBuf>,
    words: Vec<Word>,
    redirects: Vec<Redirect>,
    pending: Option<RedirKind>,
    piped: bool,
    /// How the command being read is joined to the one before it (set by the separator that ended the previous one).
    sep: Sep,
    heredoc_specs: Vec<HereDocSpec>,
    heredoc_bodies: Vec<String>,
}

impl Lexer {
    fn new(src: &str, depth: usize) -> Self {
        Self {
            c: src.chars().collect(),
            i: 0,
            depth,
            script: Script::default(),
            cur: None,
            words: Vec::new(),
            redirects: Vec::new(),
            pending: None,
            piped: false,
            sep: Sep::Seq,
            heredoc_specs: Vec::new(),
            heredoc_bodies: Vec::new(),
        }
    }

    fn peek(&self, n: usize) -> Option<char> {
        self.c.get(self.i + n).copied()
    }

    fn buf(&mut self) -> &mut WordBuf {
        self.cur.get_or_insert_with(WordBuf::default)
    }

    fn run(&mut self) {
        while self.i < self.c.len() {
            let ch = self.c[self.i];
            match ch {
                ' ' | '\t' | '\r' => {
                    self.end_word();
                    self.i += 1;
                }
                '\n' => {
                    self.end_word();
                    self.end_command();
                    self.i += 1;
                    self.read_heredoc_bodies();
                }
                '#' if self.cur.is_none() => {
                    while self.i < self.c.len() && self.c[self.i] != '\n' {
                        self.i += 1;
                    }
                }
                '\\' => match self.peek(1) {
                    Some('\n') => self.i += 2,
                    Some(next) => {
                        let b = self.buf();
                        b.text.push(next);
                        b.quoted = true;
                        self.i += 2;
                    }
                    None => {
                        self.buf().text.push('\\');
                        self.i += 1;
                    }
                },
                '\'' => self.single_quoted(),
                '"' => self.double_quoted(),
                '`' => self.backtick(),
                '$' => self.dollar(false),
                ';' | '(' | ')' => {
                    // `*(D)`, `.e(n)v`, `f(){`, `a=(1 2)`: a parenthesis stuck to a word; `(.)env`: text stuck to a closing one
                    let stuck_before = ch == '(' && self.cur.as_ref().is_some_and(|b| !b.text.is_empty());
                    let stuck_after = ch == ')' && self.peek(1).is_some_and(|n| !n.is_whitespace() && !matches!(n, ';' | '&' | '|' | '<' | '>' | ')' | '#'));
                    if stuck_before || stuck_after {
                        self.script.issues.push(Issue::Parenthesis);
                    }
                    self.end_word();
                    self.end_command();
                    self.i += 1;
                    if ch != ';' {
                        self.script.opaque = true;
                    }
                }
                '&' => {
                    self.end_word();
                    match self.peek(1) {
                        Some('>') => {
                            self.i += if self.peek(2) == Some('>') { 3 } else { 2 };
                            self.pending = Some(RedirKind::Write);
                        }
                        Some('&') => {
                            self.end_command();
                            self.i += 2;
                            self.sep = Sep::And;
                        }
                        _ => {
                            self.end_command();
                            self.i += 1;
                            self.sep = Sep::Bg;
                        }
                    }
                }
                '|' => {
                    self.end_word();
                    self.end_command();
                    let or = self.peek(1) == Some('|');
                    self.i += if or || self.peek(1) == Some('&') { 2 } else { 1 };
                    self.piped = !or;
                    self.sep = if or { Sep::Or } else { Sep::Pipe };
                }
                '<' | '>' => self.redirect(),
                _ => {
                    self.plain(ch);
                    self.i += 1;
                }
            }
        }
        self.end_word();
        self.end_command();
        self.finish_heredocs();
    }

    fn plain(&mut self, ch: char) {
        let b = self.buf();
        match ch {
            '*' | '?' | '[' => b.glob = true,
            '{' => b.brace_open += 1,
            ',' if b.brace_open > 0 => b.brace_comma = true,
            '.' if b.brace_open > 0 && b.text.ends_with('.') => b.brace_comma = true,
            '}' if b.brace_open > 0 => {
                b.brace_open -= 1;
                if b.brace_comma {
                    b.dynamic = true;
                    b.impure = true;
                    b.brace_comma = false;
                }
            }
            _ => {}
        }
        b.text.push(ch);
    }

    fn single_quoted(&mut self) {
        self.i += 1;
        let start = self.i;
        while self.i < self.c.len() && self.c[self.i] != '\'' {
            self.i += 1;
        }
        let s: String = self.c[start..self.i].iter().collect();
        if self.i >= self.c.len() {
            self.script.issues.push(Issue::Unterminated("single quote"));
        } else {
            self.i += 1;
        }
        let b = self.buf();
        b.text.push_str(&s);
        b.quoted = true;
    }

    fn double_quoted(&mut self) {
        self.i += 1;
        self.buf().quoted = true;
        loop {
            match self.peek(0) {
                None => {
                    self.script.issues.push(Issue::Unterminated("double quote"));
                    return;
                }
                Some('"') => {
                    self.i += 1;
                    return;
                }
                Some('\\') => match self.peek(1) {
                    Some('\n') => self.i += 2,
                    Some(n @ ('$' | '"' | '\\' | '`')) => {
                        self.buf().text.push(n);
                        self.i += 2;
                    }
                    _ => {
                        self.buf().text.push('\\');
                        self.i += 1;
                    }
                },
                Some('$') => self.dollar(true),
                Some('`') => self.backtick(),
                Some(ch) => {
                    self.buf().text.push(ch);
                    self.i += 1;
                }
            }
        }
    }

    fn dollar(&mut self, in_dq: bool) {
        match self.peek(1) {
            Some('(') => {
                self.i += 2;
                // `$((...))` is arithmetic, which can assign (`$((x=1))`): the variables after it are not followed
                if self.peek(0) == Some('(') {
                    self.script.opaque = true;
                }
                let (body, terminated) = self.paren_body();
                if !terminated {
                    self.script.issues.push(Issue::Unterminated("command substitution"));
                }
                self.nested(&body, Issue::Substitution);
                self.buf().expansion("$()", None, in_dq);
            }
            Some('{') => {
                let start = self.i;
                self.i += 2;
                while self.i < self.c.len() && self.c[self.i] != '}' {
                    self.i += 1;
                }
                let closed = self.i < self.c.len();
                let end = (self.i + 1).min(self.c.len());
                let raw: String = self.c[start..end].iter().collect();
                self.i = end;
                let inner = raw.strip_prefix("${").and_then(|r| r.strip_suffix('}'));
                // `${x}` is a plain expansion; `${x:-y}`, `${#x}`, `${x[0]}` are not, and `${x:=y}` / `${x=y}` also assign
                let name = inner.filter(|n| is_name(n)).map(str::to_string);
                if !closed || inner.is_some_and(|n| n.contains('=')) {
                    self.script.opaque = true;
                }
                self.buf().expansion(&raw, name, in_dq);
            }
            Some('[') => {
                // the old arithmetic expansion `$[x=1]`
                self.i += 2;
                self.script.opaque = true;
                self.buf().expansion("$[]", None, in_dq);
            }
            Some('\'') if !in_dq => {
                self.i += 2;
                let s = self.ansi_c();
                let b = self.buf();
                b.text.push_str(&s);
                b.quoted = true;
            }
            Some('"') if !in_dq => self.i += 1,
            Some(n) if n.is_alphabetic() || n == '_' => {
                let start = self.i;
                self.i += 1;
                while self.i < self.c.len() && (self.c[self.i].is_alphanumeric() || self.c[self.i] == '_') {
                    self.i += 1;
                }
                let raw: String = self.c[start..self.i].iter().collect();
                let name = Some(raw[1..].to_string()).filter(|n| is_name(n));
                self.buf().expansion(&raw, name, in_dq);
            }
            Some(n) if "?$!#@*-0123456789".contains(n) => {
                let raw = format!("${n}");
                self.i += 2;
                self.buf().expansion(&raw, None, in_dq);
            }
            _ => {
                self.buf().text.push('$');
                self.i += 1;
            }
        }
    }

    /// `$'...'` with its escapes decoded (`$'\x63ommit'` is `commit`).
    fn ansi_c(&mut self) -> String {
        let mut out = String::new();
        while let Some(ch) = self.peek(0) {
            self.i += 1;
            match ch {
                '\'' => return out,
                '\\' => {
                    let Some(e) = self.peek(0) else { break };
                    self.i += 1;
                    match e {
                        'n' => out.push('\n'),
                        't' => out.push('\t'),
                        'r' => out.push('\r'),
                        'a' => out.push('\u{7}'),
                        'b' => out.push('\u{8}'),
                        'e' | 'E' => out.push('\u{1b}'),
                        'f' => out.push('\u{c}'),
                        'v' => out.push('\u{b}'),
                        'x' | 'u' | 'U' => {
                            let max = match e {
                                'x' => 2,
                                'u' => 4,
                                _ => 8,
                            };
                            let mut v = 0u32;
                            let mut n = 0;
                            while n < max {
                                match self.peek(0).and_then(|d| d.to_digit(16)) {
                                    Some(d) => {
                                        v = v * 16 + d;
                                        self.i += 1;
                                        n += 1;
                                    }
                                    None => break,
                                }
                            }
                            out.push(char::from_u32(v).unwrap_or('\u{fffd}'));
                        }
                        '0'..='7' => {
                            let mut v = e.to_digit(8).unwrap_or(0);
                            let mut n = 1;
                            while n < 3 {
                                match self.peek(0).and_then(|d| d.to_digit(8)) {
                                    Some(d) => {
                                        v = v * 8 + d;
                                        self.i += 1;
                                        n += 1;
                                    }
                                    None => break,
                                }
                            }
                            out.push(char::from_u32(v).unwrap_or('\u{fffd}'));
                        }
                        other => out.push(other),
                    }
                }
                other => out.push(other),
            }
        }
        self.script.issues.push(Issue::Unterminated("$'...' string"));
        out
    }

    fn backtick(&mut self) {
        self.i += 1;
        let mut body = String::new();
        let mut terminated = false;
        while let Some(ch) = self.peek(0) {
            self.i += 1;
            match ch {
                '`' => {
                    terminated = true;
                    break;
                }
                '\\' => match self.peek(0) {
                    Some(n @ ('`' | '\\' | '$')) => {
                        body.push(n);
                        self.i += 1;
                    }
                    _ => body.push('\\'),
                },
                other => body.push(other),
            }
        }
        if !terminated {
            self.script.issues.push(Issue::Unterminated("backtick substitution"));
        }
        self.nested(&body, Issue::Substitution);
        self.buf().expansion("$()", None, false);
    }

    /// Reads up to the matching `)` (index is just after the opening paren); returns the body.
    fn paren_body(&mut self) -> (String, bool) {
        let start = self.i;
        let mut depth = 1u32;
        while self.i < self.c.len() {
            match self.c[self.i] {
                '\\' => self.i += 1,
                '\'' => {
                    self.i += 1;
                    while self.i < self.c.len() && self.c[self.i] != '\'' {
                        self.i += 1;
                    }
                }
                '"' => {
                    self.i += 1;
                    while self.i < self.c.len() && self.c[self.i] != '"' {
                        if self.c[self.i] == '\\' {
                            self.i += 1;
                        }
                        self.i += 1;
                    }
                }
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        let body: String = self.c[start..self.i].iter().collect();
                        self.i += 1;
                        return (body, true);
                    }
                }
                _ => {}
            }
            self.i += 1;
        }
        self.i = self.c.len();
        (self.c[start..].iter().collect(), false)
    }

    fn nested(&mut self, body: &str, issue: Issue) {
        self.script.issues.push(issue);
        self.merge(expand_nested(body, self.depth));
    }

    fn merge(&mut self, inner: Script) {
        for mut cmd in inner.commands {
            cmd.nested = true;
            self.script.commands.push(cmd);
        }
        self.script.issues.extend(inner.issues);
    }

    fn redirect(&mut self) {
        let ch = self.c[self.i];
        if self.peek(1) == Some('(') {
            self.i += 2;
            let (body, terminated) = self.paren_body();
            if !terminated {
                self.script.issues.push(Issue::Unterminated("process substitution"));
            }
            self.nested(&body, Issue::ProcessSubstitution);
            self.buf().expansion("/dev/fd/N", None, false);
            return;
        }
        // `2>file`: a purely numeric unquoted word right before the operator is the descriptor.
        match &self.cur {
            Some(b) if !b.quoted && !b.text.is_empty() && b.text.chars().all(|d| d.is_ascii_digit()) => self.cur = None,
            _ => self.end_word(),
        }
        let rest = |lx: &Self, s: &str| s.chars().enumerate().all(|(n, c)| lx.peek(n) == Some(c));
        let (kind, len) = if ch == '>' {
            if rest(self, ">>") {
                (RedirKind::Write, 2)
            } else if rest(self, ">&") {
                (RedirKind::Dup, 2)
            } else if rest(self, ">|") {
                (RedirKind::Write, 2)
            } else {
                (RedirKind::Write, 1)
            }
        } else if rest(self, "<<<") {
            (RedirKind::HereString, 3)
        } else if rest(self, "<<-") {
            (RedirKind::HereDoc, 3)
        } else if rest(self, "<<") {
            (RedirKind::HereDoc, 2)
        } else if rest(self, "<&") {
            (RedirKind::Dup, 2)
        } else if rest(self, "<>") {
            (RedirKind::ReadWrite, 2)
        } else {
            (RedirKind::Read, 1)
        };
        if kind == RedirKind::HereDoc {
            // remember `<<-` for the body reader
            self.heredoc_specs.push(HereDocSpec { delim: String::new(), strip_tabs: len == 3, expands: true });
        }
        self.i += len;
        self.pending = Some(kind);
    }

    fn end_word(&mut self) {
        let Some(mut b) = self.cur.take() else { return };
        // zsh expands an unquoted `=git` to the path of the program: the word is not what it says
        if !b.quoted && b.text.len() > 1 && b.text.starts_with('=') && b.text[1..].chars().next().is_some_and(|c| c.is_alphanumeric() || matches!(c, '_' | '/' | '.' | '-')) {
            b.dynamic = true;
            b.impure = true;
        }
        let parts = b.parts();
        let word = Word { text: b.text, dynamic: b.dynamic, glob: b.glob, quoted: b.quoted, parts };
        match self.pending.take() {
            Some(kind) => {
                let mut body = None;
                match kind {
                    RedirKind::HereDoc => {
                        if let Some(spec) = self.heredoc_specs.last_mut() {
                            spec.delim = word.text.clone();
                            spec.expands = !b.quoted;
                        }
                    }
                    RedirKind::HereString => body = Some(word.text.clone()),
                    _ => {}
                }
                self.redirects.push(Redirect { kind, target: word, body });
            }
            None => self.words.push(word),
        }
    }

    fn end_command(&mut self) {
        self.pending = None;
        let mut words = std::mem::take(&mut self.words);
        let redirects = std::mem::take(&mut self.redirects);
        let mut assigns = Vec::new();
        let mut reserved = Vec::new();
        loop {
            match words.first() {
                Some(w) if !w.dynamic && RESERVED.contains(&w.text.as_str()) => {
                    reserved.push(words.remove(0).text);
                }
                Some(w) if assignment_name(&w.text).is_some() => {
                    let w = words.remove(0);
                    let name = assignment_name(&w.text).unwrap_or_default();
                    let cut = name.len() + 1;
                    let mut value = Word { text: w.text[cut..].to_string(), parts: w.parts.as_deref().and_then(|p| strip_prefix_parts(p, cut)), ..w.clone() };
                    // `X+=y` appends to a value the parser does not know: the result is not known either (the marker cannot be expanded)
                    if name.ends_with('+') {
                        value.dynamic = true;
                        value.parts = None;
                        value.text.insert_str(0, "${+=}");
                    }
                    // a word that was dynamic only through its name part cannot be (the name is plain text), but never leave a dynamic
                    // word without pieces looking known
                    if w.dynamic && !value.dynamic && value.parts.is_none() {
                        value.dynamic = true;
                    }
                    assigns.push((name.trim_end_matches('+').to_string(), value));
                }
                _ => break,
            }
        }
        let piped = std::mem::take(&mut self.piped);
        if words.is_empty() && assigns.is_empty() && redirects.is_empty() {
            // an empty command is dropped, but the end of a loop stays visible
            if reserved.iter().any(|r| r == "done") {
                let after = std::mem::take(&mut self.sep);
                self.script.commands.push(Command { reserved, after, ..Command::default() });
            }
            return;
        }
        let after = std::mem::take(&mut self.sep);
        self.script.commands.push(Command { assigns, words, redirects, piped_from_prev: piped, nested: false, after, reserved });
    }

    /// Called right after a newline was consumed: reads the bodies of the heredocs opened on that line.
    fn read_heredoc_bodies(&mut self) {
        for spec in std::mem::take(&mut self.heredoc_specs) {
            let mut body = String::new();
            loop {
                if self.i >= self.c.len() {
                    self.script.issues.push(Issue::Unterminated("heredoc"));
                    break;
                }
                let line_start = self.i;
                while self.i < self.c.len() && self.c[self.i] != '\n' {
                    self.i += 1;
                }
                let line: String = self.c[line_start..self.i].iter().collect();
                self.i = (self.i + 1).min(self.c.len());
                let cmp = if spec.strip_tabs { line.trim_start_matches('\t') } else { line.as_str() };
                if cmp == spec.delim {
                    break;
                }
                body.push_str(&line);
                body.push('\n');
            }
            if spec.expands {
                let mut shell = Lexer::new(&body, self.depth);
                shell.scan_expansions();
                self.merge(shell.script);
            }
            self.heredoc_bodies.push(body);
        }
    }

    /// Finds `$(...)` / backticks in plain text (an unquoted heredoc body) and parses their bodies.
    fn scan_expansions(&mut self) {
        while self.i < self.c.len() {
            match (self.c[self.i], self.peek(1)) {
                ('\\', _) => self.i += 2,
                ('$', Some('(')) => {
                    self.i += 2;
                    let (body, _) = self.paren_body();
                    self.nested(&body, Issue::Substitution);
                }
                ('`', _) => self.backtick(),
                _ => self.i += 1,
            }
        }
    }

    fn finish_heredocs(&mut self) {
        // A heredoc operator on a last line without newline has no body.
        let mut bodies = std::mem::take(&mut self.heredoc_bodies).into_iter();
        for cmd in self.script.commands.iter_mut().filter(|c| !c.nested) {
            for r in cmd.redirects.iter_mut().filter(|r| r.kind == RedirKind::HereDoc) {
                r.body = Some(bodies.next().unwrap_or_default());
            }
        }
    }
}

/// Parses a substitution body one level deeper than its parent.
fn expand_nested(body: &str, parent_depth: usize) -> Script {
    if parent_depth + 1 > MAX_DEPTH {
        Script { commands: Vec::new(), issues: vec![Issue::TooDeep], opaque: false }
    } else {
        parse_at(body, parent_depth + 1)
    }
}

/// The pieces of an assignment word without its `NAME=` prefix of `cut` bytes (always literal text, so it sits in the first piece).
fn strip_prefix_parts(parts: &[Part], cut: usize) -> Option<Vec<Part>> {
    let mut out = parts.to_vec();
    match out.first_mut() {
        Some(Part::Lit(s)) if s.len() >= cut && s.is_char_boundary(cut) => {
            s.drain(..cut);
        }
        _ => return None,
    }
    out.retain(|p| !matches!(p, Part::Lit(s) if s.is_empty()));
    Some(out)
}

/// `NAME=` or `NAME+=` prefix of an assignment word.
fn assignment_name(text: &str) -> Option<&str> {
    let eq = text.find('=')?;
    let name = &text[..eq];
    let bare = name.strip_suffix('+').unwrap_or(name);
    let mut chars = bare.chars();
    let first = chars.next()?;
    if !(first.is_ascii_alphabetic() || first == '_') || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    Some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(src: &str) -> Vec<Vec<String>> {
        parse(src).commands.iter().map(|c| c.words.iter().map(|w| w.text.clone()).collect()).collect()
    }

    #[test]
    fn splits_simple_commands_and_resolves_quotes() {
        assert_eq!(words("git commit -m 'a b' && echo \"x y\" | cat; ls"), vec![
            vec!["git", "commit", "-m", "a b"],
            vec!["echo", "x y"],
            vec!["cat"],
            vec!["ls"],
        ]);
        assert_eq!(words(r#"git "com"mit"#), vec![vec!["git", "commit"]]);
        assert_eq!(words(r"\git com\mit"), vec![vec!["git", "commit"]]);
        assert_eq!(words("git $'\\x63ommit'"), vec![vec!["git", "commit"]]);
        assert_eq!(words("a\\\nb"), vec![vec!["ab"]]);
    }

    #[test]
    fn flags_unknown_values() {
        let s = parse("echo $HOME ${X:-a} {a,b} {1..3} *.rs 'q*' ~/x");
        let w = &s.commands[0].words;
        assert!(!w[0].dynamic);
        assert!(w[1].dynamic && w[2].dynamic && w[3].dynamic && w[4].dynamic);
        assert!(w[5].glob && !w[5].dynamic);
        assert!(!w[6].glob, "quoted star is not a glob for the shell");
        assert!(!w[7].dynamic);
        assert!(s.issues.is_empty());
    }

    #[test]
    fn substitutions_are_parsed_recursively_and_flagged() {
        let s = parse("echo \"$(git commit -m x)\" `git push`");
        assert_eq!(s.issues, vec![Issue::Substitution, Issue::Substitution]);
        let inner: Vec<_> = s.commands.iter().filter(|c| c.nested).map(|c| c.words[0].text.clone() + " " + &c.words[1].text).collect();
        assert_eq!(inner, vec!["git commit", "git push"]);
        let s = parse("diff <(git show a) <(git show b)");
        assert_eq!(s.issues, vec![Issue::ProcessSubstitution, Issue::ProcessSubstitution]);
        let s = parse("echo $((1+2))");
        assert_eq!(s.issues, vec![Issue::Substitution]);
    }

    #[test]
    fn unterminated_things_are_issues() {
        assert!(parse("echo 'abc").issues.contains(&Issue::Unterminated("single quote")));
        assert!(parse("echo \"abc").issues.contains(&Issue::Unterminated("double quote")));
        assert!(parse("echo $(abc").issues.contains(&Issue::Unterminated("command substitution")));
        let deep = format!("{}x{}", "$(".repeat(12), ")".repeat(12));
        assert!(parse(&deep).issues.contains(&Issue::TooDeep));
    }

    #[test]
    fn assignments_and_reserved_words_are_peeled() {
        let c = &parse("FOO=1 BAR+=$X git status").commands[0];
        assert_eq!(c.assigns.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), vec!["FOO", "BAR"]);
        assert_eq!(c.words[0].text, "git");
        assert_eq!(words("if true; then git commit; fi"), vec![vec!["true"], vec!["git", "commit"]]);
        assert_eq!(words("for f in a b; do git push; done")[1], vec!["git", "push"]);
        assert_eq!(words("g() { git commit; }"), vec![vec!["g"], vec!["git", "commit"]]);
        assert_eq!(words("(git commit)"), vec![vec!["git", "commit"]]);
    }

    #[test]
    fn redirects_are_split_from_words() {
        let c = &parse("echo hi 2>/dev/null >> out.txt >&2 >| z").commands[0];
        assert_eq!(c.words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(), vec!["echo", "hi"]);
        let targets: Vec<_> = c.redirects.iter().map(|r| (r.target.text.as_str(), r.writes_file())).collect();
        assert_eq!(targets, vec![("/dev/null", true), ("out.txt", true), ("2", false), ("z", true)]);
        let c = &parse("cmd &> all.log").commands[0];
        assert_eq!(c.redirects[0].target.text, "all.log");
    }

    #[test]
    fn heredocs_are_consumed_and_attached() {
        let s = parse("cat <<EOF > a.txt\ngit commit\nEOF\nls");
        assert_eq!(s.commands.len(), 2, "heredoc body must not become commands");
        assert_eq!(s.commands[0].redirects[0].body.as_deref(), Some("git commit\n"));
        assert_eq!(s.commands[1].words[0].text, "ls");
        let s = parse("bash <<-'X'\n\tgit push\n\tX\n");
        assert_eq!(s.commands[0].redirects[0].body.as_deref(), Some("\tgit push\n"));
        let s = parse("cat <<EOF\n$(git commit)\nEOF");
        assert_eq!(s.issues, vec![Issue::Substitution]);
        assert!(s.commands.iter().any(|c| c.nested && c.words[0].text == "git"));
        let s = parse("cat <<'EOF'\n$(git commit)\nEOF");
        assert!(s.issues.is_empty(), "quoted delimiter: no expansion");
        let s = parse("bash <<< 'git commit'");
        assert_eq!(s.commands[0].redirects[0].body.as_deref(), Some("git commit"));
    }

    #[test]
    fn separators_markers_and_groups_are_kept() {
        let s = parse("a && b || c | d; e & f\ng");
        assert_eq!(s.commands.iter().map(|c| c.after).collect::<Vec<_>>(), vec![Sep::Seq, Sep::And, Sep::Or, Sep::Pipe, Sep::Seq, Sep::Bg, Sep::Seq]);
        // the end of a loop stays visible although `done` has nothing to run
        let s = parse("for f in a b; do cat $f; done; ls");
        assert_eq!(s.commands.len(), 4, "{:?}", s.commands);
        assert!(s.commands[2].reserved == ["done"] && s.commands[2].words.is_empty());
        assert!(s.commands[1].reserved == ["do"]);
        let s = parse("for f in a\ndo\n cat $f\ndone < list");
        assert!(s.commands.iter().any(|c| c.reserved.iter().any(|r| r == "done") && !c.redirects.is_empty()));
        assert!(parse("(cd x; ls)").opaque && parse("g() { ls; }").opaque);
        assert!(!parse("echo $(ls) <(ls)").opaque);
        // an expansion that can assign hides what the variables hold afterwards
        assert!(parse("echo $((x=1))").opaque && parse("echo $[x=1]").opaque && parse("echo ${x:=y}").opaque && parse("echo ${x=y}").opaque);
        assert!(!parse("echo ${x:-y} ${x} $x").opaque);
        // `+=` appends to something the parser does not know: its value cannot be expanded
        let c = &parse("F+=x cmd").commands[0];
        assert!(c.assigns[0].1.dynamic && c.assigns[0].1.text.starts_with("${+=}"), "{:?}", c.assigns);
        assert!(!parse("F=x cmd").commands[0].assigns[0].1.dynamic);
    }

    #[test]
    fn dynamic_words_keep_their_pieces() {
        let w = |src: &str| parse(src).commands.into_iter().find(|c| !c.nested).map(|c| c.words[1].clone()).unwrap_or_default();
        let lit = |t: &str| Part::Lit(t.to_string());
        let var = |n: &str, quoted: bool| Part::Var { name: n.to_string(), quoted };
        assert_eq!(w("echo $a").parts, Some(vec![var("a", false)]));
        assert_eq!(w("echo \"$a\"").parts, Some(vec![var("a", true)]));
        assert_eq!(w("echo x${a}y").parts, Some(vec![lit("x"), var("a", false), lit("y")]));
        // literal text keeps its quotes removed, an expansion is told apart from a `$` that was quoted or escaped
        assert_eq!(w("echo \"a b\"$c'$d'").parts, Some(vec![lit("a b"), var("c", false), lit("$d")]));
        assert_eq!(w("echo \"p $a q\"$b").parts, Some(vec![lit("p "), var("a", true), lit(" q"), var("b", false)]));
        assert_eq!(w("echo \\$a$b").parts, Some(vec![lit("$a"), var("b", false)]));
        // every other expansion leaves the word without pieces
        for src in ["echo $(ls)", "echo `ls`", "echo ${a:-b}", "echo ${#a}", "echo ${a[0]}", "echo $1", "echo $@", "echo {a,b}$c", "echo $a$(ls)", "echo <(ls)"] {
            let w = w(src);
            assert!(w.dynamic && w.parts.is_none(), "{src}: {w:?}");
        }
        assert!(!w("echo plain").dynamic && w("echo plain").parts.is_none());
        assert!(w("echo ''").quoted && !w("echo x").quoted);
        // the value of an assignment loses the `NAME=` prefix, and its pieces with it
        let c = &parse("F=a$b\"$c\" cmd").commands[0];
        assert_eq!(c.assigns[0].1.parts, Some(vec![lit("a"), var("b", false), var("c", true)]));
        let c = &parse("F=$b cmd").commands[0];
        assert_eq!(c.assigns[0].1.parts, Some(vec![var("b", false)]));
        assert_eq!(c.assigns[0].1.text, "$b");
    }

    #[test]
    fn comments_and_pipes() {
        assert_eq!(words("ls # git commit\necho a#b"), vec![vec!["ls"], vec!["echo", "a#b"]]);
        let s = parse("echo x | sh");
        assert!(!s.commands[0].piped_from_prev && s.commands[1].piped_from_prev);
        let s = parse("a || b");
        assert!(!s.commands[1].piped_from_prev);
    }
}
