//! Protected paths named as an argument of ANY tool are a hard stop, unless the tool only reads them.
//!
//! The name-based checks (`rm`, `cp`, `tee`, redirects ...) miss every program that writes a file it is merely given:
//! `sort -o .git/config`, `awk -i inplace`, `xxd -r hex .git/hooks/pre-commit`, `git checkout-index --prefix=.git/hooks/`,
//! `python x.py .husky/pre-commit`. So the rule is by the argument, not by the tool: a path under `.git`, `.husky`,
//! `.claude`, the IDE state directory, or a lockfile stops the command, except for a short list of readers (and
//! the read-only git verbs), and only while none of their output options is present.

use super::{base_name, paths, Walker, Word};

/// Programs that only read the files they are given. An output option (`-o`, `--output`) takes them off the list.
const READERS: &[&str] = &[
    "cat", "head", "tail", "less", "more", "ls", "wc", "grep", "egrep", "fgrep", "rg", "diff", "cmp", "file", "stat", "tree", "du", "bat", "echo", "printf",
    "realpath", "dirname", "basename", "readlink", "shasum", "md5", "md5sum", "sha256sum", "cksum", "hexdump", "od", "strings", "nl", "pwd", "which", "test", "[",
    "true", "false", "cd", "pushd", "popd",
];

/// Programs that run a script given as an argument; their code-like arguments are scanned token by token.
const CODE_RUNNERS: &[&str] = &["sed", "gsed", "awk", "gawk", "mawk", "nawk", "perl", "ruby", "php", "lua", "node", "nodejs", "deno", "bun", "expect", "tclsh"];

/// Shells (their `-c` text is walked as a script), builtins that take no file, and wrappers that are peeled.
const SKIP: &[&str] = &["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "fish", "csh", "tcsh", "su", "eval", "export", "declare", "typeset", "readonly", "local", "alias", "unalias", "trap", "source", "."];

/// Git subcommands that read or stage; every other one with a protected path among its arguments is a hard stop
/// (`checkout -- package-lock.json`, `restore .husky/x`, `checkout-index --prefix=.git/hooks/`, `apply`, `archive -o`).
pub(super) const GIT_PATH_SAFE: &[&str] = &[
    "status", "diff", "log", "show", "blame", "annotate", "ls-files", "ls-tree", "cat-file", "rev-parse", "rev-list", "describe", "shortlog", "grep", "branch", "config", "remote",
    "stash", "merge-base", "reflog", "add", "stage", "fetch", "show-ref", "for-each-ref", "name-rev", "diff-tree", "diff-index", "diff-files", "whatchanged", "count-objects",
    "tag", "ls-remote", "check-ignore", "check-attr", "var", "help", "version", "verify-commit", "verify-tag", "range-diff", "cherry", "show-branch",
];

fn is_output_flag(t: &str) -> bool {
    matches!(t, "-o" | "-O" | "--output" | "--log-file" | "-fprint" | "-fprint0" | "-fprintf" | "-fls") || t.starts_with("--output=") || t.starts_with("--log-file=")
}

/// A word that is a piece of program text rather than a file name.
pub(super) fn code_like(t: &str) -> bool {
    t.chars().any(|c| c.is_whitespace() || matches!(c, '(' | ')' | ';' | '{' | '}' | '"' | '\'' | '`' | '|' | '&' | '<' | '>'))
}

/// Path-shaped tokens inside program text (`'.git/hooks/x'`, `"package-lock.json"`).
pub(super) fn code_tokens(code: &str) -> impl Iterator<Item = &str> {
    code.split(|c: char| !(c.is_alphanumeric() || matches!(c, '_' | '.' | '/' | '~' | '@' | '+' | '-' | '%' | '=')))
        .filter(|t| t.len() > 1 && !t.starts_with('-'))
        .map(|t| t.split_once('=').map_or(t, |(_, v)| if v.is_empty() { t } else { v }))
}

/// The strings of one argument that could be a path: itself, the value of `--opt=value` / `of=value`, the glued value
/// of a short option (`-o.git/x`).
pub(super) fn candidates(t: &str) -> Vec<&str> {
    let mut out = Vec::new();
    if !t.starts_with('-') {
        out.push(t);
    }
    if let Some((k, v)) = t.split_once('=') {
        if t.starts_with('-') || k.chars().all(|c| c.is_ascii_lowercase()) {
            out.push(v);
        }
    }
    if t.starts_with('-') && !t.starts_with("--") {
        if let Some(glued) = t.char_indices().nth(2).map(|(i, _)| &t[i..]) {
            out.push(glued);
        }
    }
    out
}

impl<'a> Walker<'a> {
    /// `base` is the program (`git` for the arguments after the subcommand), `words` its words (command word first
    /// unless it is `git`, whose `args` come without it).
    pub(super) fn protected_args(&mut self, base: &str, words: &[Word]) {
        if self.a.hard_stop.is_some() || SKIP.contains(&base) {
            return;
        }
        let rest: &[Word] = if base == "git" { words } else { words.get(1..).unwrap_or(&[]) };
        let wrote_flag = rest.iter().any(|w| is_output_flag(&w.text));
        let in_place = rest.iter().any(|w| {
            let t = w.text.as_str();
            t == "--in-place" || t.starts_with("--in-place=") || (t.starts_with('-') && !t.starts_with("--") && t[1..].contains('i') && matches!(base, "sed" | "gsed" | "perl"))
        });
        let awk_include = rest.iter().any(|w| w.text == "-i" || w.text == "--include" || w.text.starts_with("-i") && w.text.len() > 2 || w.text.contains("inplace"));
        let xxd_reverse = base == "xxd" && rest.iter().any(|w| w.text.starts_with("-r") || w.text == "-revert");
        let find_writes = base == "find" && rest.iter().any(|w| matches!(w.text.as_str(), "-delete" | "-fprint" | "-fprint0" | "-fprintf" | "-fls"));
        // Does this program only read the files it is given?
        let reads_only = !wrote_flag
            && !xxd_reverse
            && match base {
                "sed" | "gsed" => !in_place,
                "awk" | "gawk" | "mawk" | "nawk" => !awk_include,
                // `xxd in out` writes `out`
                "xxd" => rest.iter().filter(|w| !w.text.starts_with('-')).count() <= 1,
                "find" => !find_writes,
                b => READERS.contains(&b),
            };
        let code_runner = CODE_RUNNERS.contains(&base) || base.starts_with("python");
        if reads_only && !code_runner {
            return;
        }
        for w in rest {
            if w.dynamic {
                continue;
            }
            let t = w.text.as_str();
            let is_code = code_like(t);
            if !is_code && !(reads_only && code_runner) {
                for c in candidates(t) {
                    if self.names_protected(base, c, !reads_only, false) {
                        return;
                    }
                }
            }
            if is_code && code_runner {
                for tok in code_tokens(t) {
                    if self.names_protected(base, tok, !reads_only, true) {
                        return;
                    }
                }
            }
        }
    }

    /// `mention`: the candidate is a token of program text (inline code), which only names a path; an operand is something the program
    /// opens, so the full protected list applies to it.
    fn names_protected(&mut self, base: &str, cand: &str, writes: bool, mention: bool) -> bool {
        if cand.is_empty() || cand.starts_with('-') {
            return false;
        }
        if !self.cwd_known && !cand.starts_with('/') && !cand.starts_with('~') {
            return false;
        }
        let p = paths::resolve(&self.cwd, cand, self.jail.home.as_deref());
        match if mention { self.jail.mention_protected_reason(&p) } else { self.jail.protected_reason(&p) } {
            Some(why) => {
                let name = if base.is_empty() { base_name(cand) } else { base.to_string() };
                self.stop("fs.protected-arg", &format!("{name} names {why} ({cand}); only the human edits it"));
                true
            }
            None => {
                if writes {
                    self.note_exec_surface(&p, cand);
                }
                false
            }
        }
    }
}
