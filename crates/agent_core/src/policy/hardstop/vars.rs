//! Variables and `for` loops of one command string: what the analyser can know from the string itself.
//!
//! `f=src/a.js; git status $f` and `for l in cn de; do node -e "...$l..."; done` are everyday commands, and a word holding `$f` used to
//! make the whole string "not known statically". The walker now remembers what a plain sequence of commands assigned and reads `$f` as
//! its value, and it walks a `for` loop over known words once per word with the variable bound, so every iteration is judged on the
//! words the shell will really see.
//!
//! Soundness over reach: only a plain sequence is followed (no condition, no `while`, no `case`, no function, no subshell). An
//! assignment that may not have run, or ran in a copy of the shell (after `&&` or `||`, in a pipe or in the background, `+=`), a loop
//! whose words are unknown or too many, and `read` and `unset` forget the variable. A word with any other expansion (`$(...)`,
//! `${f:-x}`, `$1`, a variable that is not known) stays dynamic, so the old refusal for it stands.

use super::{Walker, Word};
use crate::policy::shellparse::{Command, RedirKind, Sep};

/// Most words a `for` list may hold.
const MAX_LOOP_VALUES: usize = 40;
/// Most commands that all the loops of one string may walk.
const MAX_LOOP_WORK: usize = 800;

/// Reserved words that make an assignment conditional (or local to a copy of the shell).
const CONTROL_WORDS: &[&str] = &["if", "elif", "else", "then", "fi", "while", "until", "function", "coproc", "{", "}", "!"];
/// Commands that open a construct the flat command list cannot follow.
const CONTROL_COMMANDS: &[&str] = &["case", "esac", "select", "function"];

/// A command that only assigns (`f=src/a.js`, `a=1 b=2`).
pub(super) fn is_pure_assignment(cmd: &Command) -> bool {
    cmd.words.is_empty() && !cmd.assigns.is_empty() && cmd.redirects.is_empty()
}

/// Nothing to run and nothing to judge (the `done` that ends a loop).
pub(super) fn is_marker(cmd: &Command) -> bool {
    cmd.words.is_empty() && cmd.assigns.is_empty() && cmd.redirects.is_empty()
}

/// Variables and loops are followed only in a plain sequence of commands.
pub(super) fn const_prop_ok(cmds: &[Command], grouped: bool) -> bool {
    !grouped
        && !cmds.iter().any(|c| {
            c.reserved.iter().any(|r| CONTROL_WORDS.contains(&r.as_str())) || c.words.first().is_some_and(|w| !w.dynamic && CONTROL_COMMANDS.contains(&w.text.as_str()))
        })
}

fn is_for(cmd: &Command) -> bool {
    cmd.assigns.is_empty() && cmd.words.first().is_some_and(|w| !w.dynamic && w.text == "for")
}

/// The index of the `done` that ends the `for` at `from` (nested `for` loops are counted).
fn matching_done(cmds: &[Command], from: usize) -> Option<usize> {
    let mut depth = 1usize;
    for (j, c) in cmds.iter().enumerate().skip(from + 1) {
        if is_for(c) {
            depth += 1;
        }
        if c.reserved.iter().any(|r| r == "done") {
            depth -= 1;
            if depth == 0 {
                return Some(j);
            }
        }
    }
    None
}

/// A command that is taken to succeed: the walker already follows a `cd` as if it worked, so `cd dir && f=x` assigns.
fn always_ok(cmd: &Command) -> bool {
    is_pure_assignment(cmd) || cmd.words.first().is_some_and(|w| !w.dynamic && matches!(w.text.as_str(), "cd" | "pushd" | "true" | ":" | "echo" | "printf"))
}

/// The command at `i` runs every time: it follows `;`, a newline or an `&` directly, or only `&&` of commands that always succeed.
fn chain_always_runs(cmds: &[Command], mut i: usize) -> bool {
    loop {
        match cmds[i].after {
            Sep::Seq | Sep::Bg => return true,
            Sep::Or | Sep::Pipe => return false,
            Sep::And => {
                if i == 0 || !always_ok(&cmds[i - 1]) {
                    return false;
                }
                i -= 1;
            }
        }
    }
}

fn valid_name(n: &str) -> bool {
    let mut chars = n.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn literal(text: &str) -> Word {
    Word { text: text.to_string(), dynamic: false, glob: text.contains(['*', '?', '[']) }
}

impl<'a> Walker<'a> {
    /// Walks the commands of one string in order. With `track`, variables and `for` loops over known words are followed.
    pub(super) fn walk(&mut self, cmds: &[Command], depth: usize, track: bool) {
        let mut i = 0;
        while i < cmds.len() {
            let cmd = &cmds[i];
            if track && is_for(cmd) {
                if let Some(end) = matching_done(cmds, i) {
                    self.for_loop(cmd, &cmds[i + 1..end], depth);
                    // `done` may carry redirects (`done < list`)
                    self.run(&cmds[end], depth);
                    i = end + 1;
                    continue;
                }
            }
            self.run(cmd, depth);
            if track {
                self.note_assignment(cmds, i);
                self.note_forgotten(cmd);
            }
            i += 1;
        }
    }

    /// Judges one command with the variables of the string replaced by their values.
    fn run(&mut self, cmd: &Command, depth: usize) {
        if self.vars.is_empty() {
            self.command(cmd, depth);
        } else {
            let expanded = self.expand_command(cmd);
            self.command(&expanded, depth);
        }
    }

    fn for_loop(&mut self, header: &Command, body: &[Command], depth: usize) {
        let name = header.words.get(1).filter(|w| !w.dynamic && valid_name(&w.text)).map(|w| w.text.clone());
        let values: Option<Vec<String>> = if name.is_some() && header.words.get(2).is_some_and(|w| !w.dynamic && w.text == "in") {
            let words: Vec<Word> = header.words[3..].iter().flat_map(|w| self.expand_word(w)).collect();
            words.iter().all(|w| !w.dynamic).then(|| words.into_iter().map(|w| w.text).collect())
        } else {
            None
        };
        let before = self.vars.clone();
        match (&name, values) {
            (Some(n), Some(values)) if values.len() <= MAX_LOOP_VALUES && self.loop_work + values.len() * (body.len() + 1) <= MAX_LOOP_WORK => {
                self.loop_work += values.len() * (body.len() + 1);
                for v in values {
                    self.vars.insert(n.clone(), v);
                    self.walk(body, depth, true);
                }
                self.vars.remove(n);
            }
            _ => {
                // the words are not known (or too many): the body is judged once with the variable unknown, and what it assigned
                // is not known afterwards (it ran an unknown number of times, perhaps never)
                if let Some(n) = &name {
                    self.vars.remove(n);
                }
                self.walk(body, depth, true);
                self.vars.retain(|k, v| before.get(k) == Some(v));
                if let Some(n) = &name {
                    self.vars.remove(n);
                }
            }
        }
    }

    /// A command that only assigns: remember a value that is known and certain, forget the rest.
    fn note_assignment(&mut self, cmds: &[Command], i: usize) {
        let cmd = &cmds[i];
        if !is_pure_assignment(cmd) {
            return;
        }
        let conditional = !chain_always_runs(cmds, i) || cmds.get(i + 1).is_some_and(|n| matches!(n.after, Sep::Pipe | Sep::Bg));
        for (name, value) in &cmd.assigns {
            match (!conditional).then(|| self.known_value(value)).flatten() {
                Some(v) => {
                    self.vars.insert(name.clone(), v);
                }
                None => {
                    self.vars.remove(name);
                }
            }
        }
    }

    /// `read x y` and `unset x`: the variables they name are not what they were.
    fn note_forgotten(&mut self, cmd: &Command) {
        if cmd.words.first().is_some_and(|w| !w.dynamic && matches!(w.text.as_str(), "read" | "unset" | "export" | "declare" | "typeset" | "local" | "readonly")) {
            for w in &cmd.words[1..] {
                let name = w.text.split_once('=').map_or(w.text.as_str(), |(n, _)| n);
                self.vars.remove(name);
            }
        }
    }

    /// The value of an assignment when it is known: a literal, or words of known variables.
    fn known_value(&self, w: &Word) -> Option<String> {
        if !w.dynamic {
            return Some(w.text.clone());
        }
        self.substitute(&w.text)
    }

    /// `$name` and `${name}` of known variables replaced by their values; `None` when the text holds any other expansion.
    fn substitute(&self, text: &str) -> Option<String> {
        let chars: Vec<char> = text.chars().collect();
        let mut out = String::with_capacity(text.len());
        let mut i = 0;
        while i < chars.len() {
            if chars[i] != '$' {
                out.push(chars[i]);
                i += 1;
                continue;
            }
            let (name, next) = match chars.get(i + 1) {
                Some('{') => {
                    let close = chars[i + 2..].iter().position(|c| *c == '}')? + i + 2;
                    (chars[i + 2..close].iter().collect::<String>(), close + 1)
                }
                Some(c) if c.is_ascii_alphabetic() || *c == '_' => {
                    let end = chars[i + 1..].iter().position(|c| !(c.is_ascii_alphanumeric() || *c == '_')).map_or(chars.len(), |p| p + i + 1);
                    (chars[i + 1..end].iter().collect::<String>(), end)
                }
                _ => return None,
            };
            if !valid_name(&name) {
                return None;
            }
            out.push_str(self.vars.get(&name)?);
            i = next;
        }
        // a value that still holds `$` or a backtick would need another round of expansion: not judged
        (!out.contains(['$', '`'])).then_some(out)
    }

    /// One word of a command with the known variables replaced. An unquoted value splits at white space, which is the reading that
    /// judges the most words; an empty value leaves no word.
    pub(super) fn expand_word(&self, w: &Word) -> Vec<Word> {
        if !w.dynamic {
            return vec![w.clone()];
        }
        match self.substitute(&w.text) {
            Some(v) => v.split_whitespace().map(literal).collect(),
            None => vec![w.clone()],
        }
    }

    fn expand_command(&self, cmd: &Command) -> Command {
        let mut out = cmd.clone();
        out.words = cmd.words.iter().flat_map(|w| self.expand_word(w)).collect();
        for r in &mut out.redirects {
            if !matches!(r.kind, RedirKind::HereDoc | RedirKind::HereString) && r.target.dynamic {
                if let Some(v) = self.substitute(&r.target.text) {
                    r.target = literal(&v);
                }
            }
        }
        for (_, v) in &mut out.assigns {
            if v.dynamic {
                if let Some(k) = self.substitute(&v.text) {
                    *v = literal(&k);
                }
            }
        }
        out
    }
}
