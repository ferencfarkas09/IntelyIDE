//! Variables and `for` loops of one command string: what the analyser can know from the string itself.
//!
//! `f=src/a.js; git status $f` and `for l in cn de; do node -e "...$l..."; done` are everyday commands, and a word holding `$f` used to
//! make the whole string "not known statically". The walker now remembers what a plain sequence of commands assigned and reads `$f` as
//! its value, and it walks a `for` loop over known words once per word with the variable bound, so every iteration is judged on the
//! words the shell will really see.
//!
//! Soundness over reach. A value is read only when the string itself makes it certain:
//!
//! - Only a plain sequence is followed: no condition, no `while`, no `case`, no function, no subshell, no arithmetic, no `IFS`.
//! - A word is read from its pieces (`Word::parts`): what is in double quotes stays one word, what is not is split at white space and may
//!   glob, a brace list or any other expansion leaves the word unknown.
//! - An assignment that may not have run (after `&&` of a command that can fail, after `||`), or ran in a copy of the shell (in a
//!   pipe, in the background, inside `$(...)`) is not followed past the end of its list. A loop that may not run, runs aside, or leaves
//!   early (`break`, `continue`, `exit`) makes every variable its body assigns unknown.
//! - The builtins that change a variable in some other way (`read`, `printf -v`, `let`, `eval`, `mapfile`, `getopts`, `declare -n` ...)
//!   forget the variable they name, or, when that cannot be told, everything: nothing is followed after them.
//! - A value is kept only up to `MAX_VALUE_LEN` bytes, and only `MAX_VARS` variables are followed.

use super::{Walker, Word};
use crate::policy::shellparse::{is_name, Command, Part, RedirKind, Sep};
use std::borrow::Cow;
use std::path::PathBuf;

/// Most words a `for` list may hold.
const MAX_LOOP_VALUES: usize = 40;
/// Most commands that all the loops of one string may walk.
const MAX_LOOP_WORK: usize = 800;
/// Longest value that is followed (a string that doubles a value on every line would grow without end).
const MAX_VALUE_LEN: usize = 4096;
/// Most variables that are followed at once.
const MAX_VARS: usize = 64;

/// Reserved words that make an assignment conditional (or local to a copy of the shell).
const CONTROL_WORDS: &[&str] = &["if", "elif", "else", "then", "fi", "while", "until", "function", "coproc", "{", "}", "!"];
/// Commands that open a construct the flat command list cannot follow.
const CONTROL_COMMANDS: &[&str] = &["case", "esac", "select", "function"];
/// Variables the shell sets by itself, or that change how it reads a command: never followed.
const SPECIAL_VARS: &[&str] = &[
    "IFS", "PWD", "OLDPWD", "CDPATH", "GLOBIGNORE", "RANDOM", "SRANDOM", "SECONDS", "LINENO", "BASHPID", "EPOCHSECONDS", "EPOCHREALTIME", "SHLVL", "REPLY", "OPTIND", "OPTARG", "UID",
    "EUID", "PPID", "_", "SHELLOPTS", "BASHOPTS", "BASH_VERSINFO", "BASH_COMMAND", "FUNCNAME", "PIPESTATUS", "BASH_REMATCH", "HISTCMD",
];
/// Builtins and keywords that run another command in the same shell.
const WRAPPERS: &[&str] = &["command", "builtin", "time", "exec"];
/// Builtins that can change any variable, or whose arguments name none of them: nothing is followed after one.
const POISON: &[&str] = &["let", "eval", "source", ".", "mapfile", "readarray", "getopts", "wait", "coproc", "select", "trap"];

/// Most places the shell may be in at once (after `cd` commands that may not have run) before the directory is called unknown.
const MAX_CWD_WORLDS: usize = 3;

/// Assignments that may not have run: the name and what the variable held before (`None` when it was not known).
type Pending = Vec<(String, Option<String>)>;

/// What a command does to the variables besides a plain assignment.
enum Effect {
    Nothing,
    /// These variables are not what they were.
    Forget(Vec<String>),
    /// It may have changed any variable (or made one unchangeable): nothing is followed from here.
    Poison,
}

/// The string has `if`, `while`, `case`, a function or `{ }`: a command in it may not run, or runs elsewhere.
pub(super) fn has_control_flow(cmds: &[Command]) -> bool {
    cmds.iter().any(|c| c.reserved.iter().any(|r| CONTROL_WORDS.contains(&r.as_str())) || c.words.first().is_some_and(|w| !w.dynamic && CONTROL_COMMANDS.contains(&w.text.as_str())))
}

/// A command that only assigns (`f=src/a.js`, `a=1 b=2`, `f=x > log`).
pub(super) fn is_pure_assignment(cmd: &Command) -> bool {
    cmd.words.is_empty() && !cmd.assigns.is_empty()
}

/// Nothing to run and nothing to judge (the `done` that ends a loop).
pub(super) fn is_marker(cmd: &Command) -> bool {
    cmd.words.is_empty() && cmd.assigns.is_empty() && cmd.redirects.is_empty()
}

/// Variables and loops are followed only in a plain sequence of commands.
pub(super) fn const_prop_ok(cmds: &[Command], opaque: bool) -> bool {
    !opaque
        && !cmds.iter().any(|c| {
            c.reserved.iter().any(|r| CONTROL_WORDS.contains(&r.as_str()))
                || c.words.first().is_some_and(|w| !w.dynamic && CONTROL_COMMANDS.contains(&w.text.as_str()))
                // `IFS` changes how every later word is split
                || c.assigns.iter().any(|(n, _)| n == "IFS")
                || c.words.iter().any(|w| w.text == "IFS" || w.text.starts_with("IFS="))
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

/// A command that succeeds whatever the state: an assignment without a substitution in it, `true`, `:`.
fn always_ok(cmd: &Command) -> bool {
    if !cmd.redirects.is_empty() {
        return false;
    }
    if is_pure_assignment(cmd) {
        // the status of `x=$(false)` is the status of the substitution
        return cmd.assigns.iter().all(|(_, v)| !v.dynamic || v.parts.is_some());
    }
    cmd.assigns.is_empty() && cmd.words.first().is_some_and(|w| !w.dynamic && matches!(w.text.as_str(), "true" | ":"))
}

/// The command at `i` runs every time: it follows `;`, a newline or an `&` directly, or only `&&` of commands that succeed (`ok`).
/// Commands of a substitution sit in the list too, but they are not part of the chain.
fn chain_always_runs(cmds: &[Command], mut i: usize, ok: &[bool]) -> bool {
    loop {
        match cmds[i].after {
            Sep::Seq | Sep::Bg => return true,
            Sep::Or | Sep::Pipe => return false,
            Sep::And => {
                let Some(p) = (0..i).rev().find(|&j| !cmds[j].nested) else { return false };
                if !ok[p] {
                    return false;
                }
                i = p;
            }
        }
    }
}

/// The command at `i` runs in a copy of the shell: it is a side of a pipe, or its whole list ends with `&`.
fn runs_aside(cmds: &[Command], i: usize) -> bool {
    if cmds[i].after == Sep::Pipe {
        return true;
    }
    let mut first = true;
    for n in cmds.iter().skip(i + 1).filter(|c| !c.nested) {
        match n.after {
            Sep::Pipe if first => return true,
            Sep::Pipe | Sep::And | Sep::Or => {}
            Sep::Bg => return true,
            Sep::Seq => return false,
        }
        first = false;
    }
    false
}

/// An `echo` or `printf` whose output goes straight into `xargs` or `parallel`: its words are the names they will open.
fn feeds_xargs(cmds: &[Command], i: usize) -> bool {
    let printer = cmds[i].words.first().is_some_and(|w| !w.dynamic && matches!(w.text.as_str(), "echo" | "printf"));
    printer
        && cmds
            .iter()
            .skip(i + 1)
            .find(|c| !c.nested)
            .is_some_and(|n| n.after == Sep::Pipe && n.words.first().is_some_and(|w| !w.dynamic && matches!(super::base_name(&w.text).as_str(), "xargs" | "parallel")))
}

/// `ln -s` (or `--symbolic`): a symbolic link comes into being where nothing was.
fn makes_symlink(cmd: &Command) -> bool {
    cmd.words.first().is_some_and(|w| !w.dynamic && super::base_name(&w.text) == "ln")
        && cmd.words[1..].iter().any(|w| w.text == "--symbolic" || (w.text.starts_with('-') && !w.text.starts_with("--") && w.text.contains('s')))
}

/// `break`, `continue`, `return`, `exit`: the commands after it may not run.
fn is_flow_control(cmd: &Command) -> bool {
    cmd.words.first().is_some_and(|w| !w.dynamic && matches!(w.text.as_str(), "break" | "continue" | "return" | "exit"))
}

/// The variable a word names (`x`, `x=1`, `x+=1`, `x[0]=1`), if it is a plain name.
fn name_of(text: &str) -> Option<String> {
    let name = text.split_once('=').map_or(text, |(n, _)| n);
    let name = name.split_once('[').map_or(name, |(n, _)| n).trim_end_matches('+');
    is_name(name).then(|| name.to_string())
}

/// `x[0]=1`: an assignment to an element of an array, which the parser reads as a word.
fn array_assignment(text: &str) -> Option<String> {
    let (name, rest) = text.split_once('[')?;
    (is_name(name) && (rest.contains("]=") || rest.contains("]+="))).then(|| name.to_string())
}

fn effect_of(cmd: &Command) -> Effect {
    let mut i = 0;
    // `command read x`, `builtin read x` and `time read x` still run the builtin in this shell
    while let Some(w) = cmd.words.get(i) {
        if w.dynamic {
            // a program name that is not known could be any of the builtins
            return Effect::Poison;
        }
        if !WRAPPERS.contains(&w.text.as_str()) {
            break;
        }
        i += 1;
        while cmd.words.get(i).is_some_and(|o| !o.dynamic && o.text.starts_with('-')) {
            i += 1;
        }
    }
    let Some(prog) = cmd.words.get(i) else { return Effect::Nothing };
    let args = &cmd.words[i + 1..];
    let prog = prog.text.as_str();
    // the variables the operands name; `None` when a name itself is computed (`export $x`, `read ${y}`)
    let operands = || -> Option<Vec<String>> {
        let mut out = Vec::new();
        for w in args.iter().filter(|w| w.dynamic || !w.text.starts_with('-')) {
            let head = w.text.split_once('=').map_or(w.text.as_str(), |(n, _)| n);
            if w.dynamic && head.contains(['$', '`', '{', '(', '<']) {
                return None;
            }
            out.extend(name_of(&w.text));
        }
        Some(out)
    };
    let forget = |names: Option<Vec<String>>| names.map_or(Effect::Poison, Effect::Forget);
    match prog {
        "read" => forget(operands().map(|mut n| {
            n.push("REPLY".to_string());
            n
        })),
        "unset" => {
            if args.iter().any(|w| w.text.starts_with('-') && w.text.contains('n')) {
                Effect::Poison
            } else {
                forget(operands())
            }
        }
        "export" | "declare" | "typeset" | "local" | "readonly" => {
            // attributes (`-n` reference, `-i` integer, `-l` lower case, `-a` array ...) change what a later assignment means, and a
            // read-only variable does not take one
            let plain = args.iter().filter(|w| w.dynamic || w.text.starts_with('-')).all(|w| !w.dynamic && w.text[1..].chars().all(|c| matches!(c, 'x' | 'g' | 'p' | 'f' | 'F')));
            if prog == "readonly" || !plain {
                Effect::Poison
            } else {
                forget(operands())
            }
        }
        // `printf -v name format ...` assigns (the options come first)
        "printf" if args.first().is_some_and(|w| w.dynamic || w.text.starts_with("-v")) => Effect::Poison,
        "for" => forget(cmd.words.get(i + 1).filter(|w| !w.dynamic).map(|w| name_of(&w.text).into_iter().collect())),
        p if POISON.contains(&p) => Effect::Poison,
        p => array_assignment(p).map_or(Effect::Nothing, |n| Effect::Forget(vec![n])),
    }
}

/// The variables a loop body can change: what it assigns, reads into, declares or loops over.
fn assigned_in(body: &[Command], var: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = var.into_iter().map(str::to_string).collect();
    for c in body.iter().filter(|c| !c.nested) {
        if is_pure_assignment(c) {
            out.extend(c.assigns.iter().map(|(n, _)| n.clone()));
        }
        if let Effect::Forget(names) = effect_of(c) {
            out.extend(names);
        }
    }
    out
}

fn literal(text: &str) -> Word {
    Word { text: text.to_string(), dynamic: false, glob: text.contains(['*', '?', '[']), quoted: true, eq: false, parts: None }
}

/// The unquoted value of an expansion, split at white space the way the shell does (`IFS` is untouched): the finished words go to
/// `words`, the word still being built stays in `cur`.
fn split_into(v: &str, cur: &mut Option<String>, words: &mut Vec<String>) {
    let ws = |c: char| matches!(c, ' ' | '\t' | '\n');
    let fields: Vec<&str> = v.split(ws).filter(|f| !f.is_empty()).collect();
    if fields.is_empty() {
        // an empty value leaves no word; white space alone only ends the word before it
        if !v.is_empty() {
            words.extend(cur.take());
        }
        return;
    }
    if v.starts_with(ws) {
        words.extend(cur.take());
    }
    for (k, f) in fields.iter().enumerate() {
        if k > 0 {
            words.extend(cur.take());
        }
        cur.get_or_insert_with(String::new).push_str(f);
    }
    if v.ends_with(ws) {
        words.extend(cur.take());
    }
}

impl<'a> Walker<'a> {
    /// Walks the commands of one string in order. With `track`, variables and `for` loops over known words are followed.
    pub(super) fn walk(&mut self, cmds: &[Command], depth: usize, track: bool) {
        let mut pending = Pending::new();
        // the commands taken to succeed: the ones that cannot fail, and a `cd` into a directory that exists (the walker follows it)
        let mut ok = vec![false; cmds.len()];
        let mut i = 0;
        while i < cmds.len() {
            let cmd = &cmds[i];
            if !cmd.nested {
                self.enter_or_leave_groups(cmd);
            }
            let follow = track && !self.vars_off && !cmd.nested;
            if follow && matches!(cmd.after, Sep::Seq | Sep::Bg | Sep::Or) {
                // a new list starts, or the commands after `||` run only when the ones before failed
                self.settle(&mut pending);
            }
            if follow && is_for(cmd) {
                if let Some(end) = matching_done(cmds, i) {
                    // the loop runs for certain when its header does and nothing sets it aside; `done` stays in the body, so
                    // its redirects (`done < list`) are judged with the loop and a `&` after the last command is seen
                    let aside = cmd.after == Sep::Pipe || runs_aside(cmds, end);
                    let runs = chain_always_runs(cmds, i, &ok);
                    let certain = runs && !aside;
                    let before = (self.cwd.clone(), self.cwd_known);
                    let exact = self.for_loop(cmd, &cmds[i + 1..=end], depth, certain);
                    // a `cd` in the body: in a pipe or in the background the shell around does not move; when the loop may not run, or
                    // runs a number of times that is not known, the directory is in doubt
                    if (self.cwd.clone(), self.cwd_known) != before {
                        if aside {
                            (self.cwd, self.cwd_known) = before;
                        } else if !runs || !exact {
                            self.cwd_pending.push(before);
                        }
                    }
                    i = end + 1;
                    continue;
                }
            }
            let before_cmd = (self.cwd.clone(), self.cwd_known);
            if !cmd.nested && feeds_xargs(cmds, i) {
                self.feed_operands(&cmd.words[1..]);
            }
            let expanded = self.run(cmd, depth);
            ok[i] = always_ok(cmd) || self.entered_dir(&expanded);
            if makes_symlink(&expanded) {
                self.made_links = true;
            }
            if !cmd.nested && self.moves_the_shell(&expanded) {
                self.after_cd(cmds, i, &ok, before_cmd);
            }
            if track && !self.vars_off && !cmd.nested {
                self.note_assignment(cmds, i, &mut pending, &ok);
                match effect_of(&expanded) {
                    Effect::Nothing => {}
                    Effect::Forget(names) => self.forget(&names),
                    Effect::Poison => self.poison(),
                }
            }
            i += 1;
        }
        self.settle(&mut pending);
    }

    /// Judges one command with the variables of the string replaced by their values; returns the command as it was judged. When the shell
    /// may be in more than one place (`cwd_alts`), the command is judged from each of them.
    fn run<'c>(&mut self, cmd: &'c Command, depth: usize) -> Cow<'c, Command> {
        let expanded = if self.vars.is_empty() { Cow::Borrowed(cmd) } else { Cow::Owned(self.expand_command(cmd)) };
        self.command(&expanded, depth);
        if !self.cwd_alts.is_empty() {
            let primary = (self.cwd.clone(), self.cwd_known);
            let mut alts = std::mem::take(&mut self.cwd_alts);
            for alt in &mut alts {
                (self.cwd, self.cwd_known) = alt.clone();
                self.command(&expanded, depth);
                *alt = (self.cwd.clone(), self.cwd_known);
            }
            (self.cwd, self.cwd_known) = primary.clone();
            // the places that met again are one place
            alts.retain(|a| *a != primary);
            alts.dedup();
            self.cwd_alts = alts;
        }
        expanded
    }

    /// `cd dir` (or `pushd`) that the walker followed into a directory that exists.
    fn entered_dir(&self, cmd: &Command) -> bool {
        cmd.words.first().is_some_and(|w| !w.dynamic && matches!(w.text.as_str(), "cd" | "pushd")) && self.cwd_known && self.cwd.is_dir()
    }

    /// `cd` or `pushd` with a known target (the walker moved into it).
    fn moves_the_shell(&self, cmd: &Command) -> bool {
        cmd.words.first().is_some_and(|w| !w.dynamic && matches!(w.text.as_str(), "cd" | "pushd")) && self.cwd_known
    }

    /// Where a `cd` leaves the shell is certain only when it is in the main shell, always runs and goes to a folder that exists. In a pipe
    /// or in the background the shell does not move at all (the directory is not known from there on). After a condition, in a function,
    /// or into a folder that does not exist (the `cd` fails) the shell may be where it was: the commands of the same `&&` list are judged
    /// from the new directory (they run only if the `cd` worked), and from the next list on from both places.
    fn after_cd(&mut self, cmds: &[Command], i: usize, ok: &[bool], before: (PathBuf, bool)) {
        if runs_aside(cmds, i) {
            self.cwd_known = false;
            self.issue("a cd in a pipe or in the background (the shell stays where it was)");
            return;
        }
        let certain = chain_always_runs(cmds, i, ok) && !self.cd_unreliable;
        let missing = !self.cwd.is_dir() && !self.made_dirs.contains(&self.cwd);
        if !certain || missing {
            self.cwd_pending.push(before);
        }
    }

    /// The start of a command: a `)` restores the directory from before the `(`, and from a new list on the shell may be in the place it
    /// was before a `cd` that may not have moved it.
    fn enter_or_leave_groups(&mut self, cmd: &Command) {
        while let Some((depth, dir, known, alts)) = self.cwd_stack.last().cloned() {
            if cmd.depth >= depth {
                break;
            }
            self.cwd_stack.pop();
            self.cwd = dir;
            self.cwd_known = known;
            self.cwd_alts = alts;
            self.cwd_pending.clear();
        }
        if !self.cwd_pending.is_empty() && cmd.after != Sep::And {
            let primary = (self.cwd.clone(), self.cwd_known);
            for place in std::mem::take(&mut self.cwd_pending) {
                if place == primary || self.cwd_alts.contains(&place) {
                    continue;
                }
                if self.cwd_alts.len() >= MAX_CWD_WORLDS {
                    self.cwd_known = false;
                    self.issue("too many places the shell may be in after cd commands that may not have run");
                    break;
                }
                self.cwd_alts.push(place);
            }
        }
        if cmd.depth > self.cwd_stack.last().map_or(0, |t| t.0) {
            self.cwd_stack.push((cmd.depth, self.cwd.clone(), self.cwd_known, self.cwd_alts.clone()));
        }
    }

    fn forget(&mut self, names: &[String]) {
        for n in names {
            self.vars.remove(n);
        }
    }

    /// Nothing is known about the variables from here on.
    fn poison(&mut self) {
        self.vars.clear();
        self.vars_off = true;
    }

    /// The end of a list: an assignment that may not have run keeps its value only when the variable held the same before.
    fn settle(&mut self, pending: &mut Pending) {
        let mut seen: Vec<String> = Vec::new();
        for (name, before) in pending.drain(..) {
            // the first entry of a name holds the value from before the list
            if seen.contains(&name) {
                continue;
            }
            if self.vars.get(&name) != before.as_ref() {
                self.vars.remove(&name);
            }
            seen.push(name);
        }
    }

    /// `body` ends with the `done` of the loop. A loop whose words are unknown or too many is judged once with its variable unknown.
    fn for_loop(&mut self, header: &Command, body: &[Command], depth: usize, certain: bool) -> bool {
        let name = header.words.get(1).filter(|w| !w.dynamic && is_name(&w.text) && !SPECIAL_VARS.contains(&w.text.as_str())).map(|w| w.text.clone());
        let values: Option<Vec<String>> = if name.is_some() && header.words.get(2).is_some_and(|w| !w.dynamic && w.text == "in") {
            let words: Vec<Word> = header.words[3..].iter().flat_map(|w| self.expand_word(w)).collect();
            // a glob (`src/*.js`) is bound as it is written and read again as a glob in the body, so the body is judged on the pattern
            words.iter().all(|w| !w.dynamic && w.text.len() <= MAX_VALUE_LEN).then(|| words.into_iter().map(|w| w.text).collect())
        } else {
            None
        };
        let assigned = assigned_in(body, name.as_deref());
        // the commands after a `break` or `continue` may not run, so what an iteration leaves behind is not what the next one finds
        let flow = body.iter().any(is_flow_control);
        match (&name, values) {
            (Some(n), Some(values)) if values.len() <= MAX_LOOP_VALUES && self.loop_work + values.len() * (body.len() + 1) <= MAX_LOOP_WORK => {
                self.loop_work += values.len() * (body.len() + 1);
                let runs_at_all = !values.is_empty();
                for v in values {
                    if flow {
                        self.forget(&assigned);
                    }
                    if !self.vars_off {
                        self.vars.insert(n.clone(), v);
                    }
                    self.walk(body, depth, true);
                }
                self.vars.remove(n);
                if flow || !certain {
                    self.forget(&assigned);
                }
                // the body ran once per word, all the way through
                runs_at_all && !flow
            }
            _ => {
                // the body runs an unknown number of times, perhaps never: what it assigns is not known before, in or after it
                self.forget(&assigned);
                self.walk(body, depth, true);
                self.forget(&assigned);
                false
            }
        }
    }

    /// A command that only assigns: remember a value that is known and certain, forget the rest.
    fn note_assignment(&mut self, cmds: &[Command], i: usize, pending: &mut Pending, ok: &[bool]) {
        let cmd = &cmds[i];
        if !is_pure_assignment(cmd) {
            return;
        }
        let aside = runs_aside(cmds, i);
        // a redirect that fails (`f=x > /missing/log`) stops the assignment
        let certain = chain_always_runs(cmds, i, ok) && cmd.redirects.is_empty();
        for (name, value) in &cmd.assigns {
            let before = self.vars.get(name).cloned();
            let known = if aside || SPECIAL_VARS.contains(&name.as_str()) { None } else { self.known_value(value) };
            match known {
                Some(v) if before.is_some() || self.vars.len() < MAX_VARS => {
                    self.vars.insert(name.clone(), v);
                }
                _ => {
                    self.vars.remove(name);
                }
            }
            if !aside && !certain {
                // the commands that follow in the same `&&` list run only when this one did; at the end of the list the variable is
                // what it was before unless both agree
                pending.push((name.clone(), before));
            }
        }
    }

    /// The value of an assignment when it is known: a literal, or words of known variables. An assignment is not split into words.
    fn known_value(&self, w: &Word) -> Option<String> {
        if !w.dynamic {
            return (w.text.len() <= MAX_VALUE_LEN).then(|| w.text.clone());
        }
        let mut out = String::new();
        for p in w.parts.as_deref()? {
            match p {
                Part::Lit(s) => out.push_str(s),
                Part::Var { name, .. } => out.push_str(self.vars.get(name)?),
            }
            if out.len() > MAX_VALUE_LEN {
                return None;
            }
        }
        // a value that still holds `$` or a backtick would need another round of expansion: not judged
        (!out.contains(['$', '`'])).then_some(out)
    }

    /// One word of a command with the known variables replaced, the way the shell reads it: what is in double quotes stays in one
    /// piece; an unquoted value splits at white space (the reading that judges the most words), may glob, and an empty one leaves no
    /// word. A word with an unknown variable or any other expansion stays as it is.
    pub(super) fn expand_word(&self, w: &Word) -> Vec<Word> {
        let Some(parts) = w.parts.as_deref().filter(|_| w.dynamic) else { return vec![w.clone()] };
        let mut words: Vec<String> = Vec::new();
        let mut cur: Option<String> = None;
        for p in parts {
            match p {
                Part::Lit(s) => cur.get_or_insert_with(String::new).push_str(s),
                Part::Var { name, quoted } => {
                    let Some(v) = self.vars.get(name) else { return vec![w.clone()] };
                    if *quoted {
                        cur.get_or_insert_with(String::new).push_str(v);
                    } else {
                        split_into(v, &mut cur, &mut words);
                    }
                }
            }
        }
        words.extend(cur);
        if words.is_empty() && w.quoted {
            words.push(String::new());
        }
        words.iter().map(|t| literal(t)).collect()
    }

    fn expand_command(&self, cmd: &Command) -> Command {
        let mut out = cmd.clone();
        out.words = cmd.words.iter().flat_map(|w| self.expand_word(w)).collect();
        for r in &mut out.redirects {
            if !matches!(r.kind, RedirKind::HereDoc | RedirKind::HereString) && r.target.dynamic {
                // a target that becomes several words is an "ambiguous redirect" error: it is left unknown
                if let [one] = self.expand_word(&r.target).as_slice() {
                    if !one.dynamic {
                        r.target = one.clone();
                    }
                }
            }
        }
        for (_, v) in &mut out.assigns {
            if v.dynamic {
                if let Some(k) = self.known_value(v) {
                    *v = literal(&k);
                }
            }
        }
        out
    }
}
