//! "Allow always in this session" (D10, permission-modes spec 2.7): which commands may be offered for a session allow, and when a
//! saved prefix matches. The allowlist is the only door: what is not listed is never offered, and a saved prefix applies only when
//! the WHOLE command is clean (no assignment, no write redirect, no script, no exec-surface write, no outside path, no network
//! operand, no inline code, no refused option). Hard stops run before any saved allow, so a saved `git add` never lets `git add -A`
//! or `git push` through.

use super::hardstop::Analysis;
use super::paths::Jail;
use super::shellparse::Word;
use super::decide::SavedAllow;

/// (program, verbs). `Some(verbs)`: the prefix is the program word plus the next word, which must be one of `verbs`. `None`: the
/// program word alone. Every entry is a program that reads or edits files, starts no other program and executes no code that the
/// repository (or the agent) supplies. No package manager and no `cargo` entry on purpose: `cargo check`, `clippy` and `tree` run
/// `build.rs` and proc macros, `yarn` runs the file named by `yarnPath`, so one "allow always" would run agent-authored code
/// unprompted for the rest of the session. Not `sort`, `uniq`, `tree`: they write the file named by `-o` or a second operand.
pub const SESSION_ALLOW_EXEC: &[(&str, Option<&[&str]>)] = &[
    ("git", Some(&["status", "log", "diff", "show", "blame", "rev-parse", "ls-files", "ls-tree", "cat-file", "describe", "shortlog", "rev-list", "add"])),
    ("ls", None),
    ("cat", None),
    ("head", None),
    ("tail", None),
    ("wc", None),
    ("rg", None),
    ("grep", None),
    ("egrep", None),
    ("fgrep", None),
    ("stat", None),
    ("file", None),
    ("du", None),
    ("pwd", None),
    ("which", None),
    ("echo", None),
    ("diff", None),
    ("cmp", None),
    ("cut", None),
    ("tr", None),
    ("basename", None),
    ("dirname", None),
    ("realpath", None),
    ("mkdir", None),
    ("touch", None),
];

/// Options that make an otherwise listed program run another program or write a file; a command that has one is never offered and
/// never matches (an `--output=` form counts too).
const REFUSED_OPTIONS: &[&str] = &["--pre", "--pre-glob", "--hostname-bin", "--compress-program", "--ext-diff", "--textconv", "--exec-path", "--upload-pack", "--receive-pack", "--output"];
/// An option whose name contains one of these runs something.
const REFUSED_FRAGMENTS: &[&str] = &["exec", "command", "program", "shell", "pager", "editor"];

const SHELL_NAMES: &[&str] = &["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "fish", "csh", "tcsh", "su", "eval"];

fn refused_option(words: &[Word]) -> bool {
    words.iter().skip(1).any(|w| {
        let t = w.text.as_str();
        let Some(rest) = t.strip_prefix("--") else { return false };
        let name = rest.split('=').next().unwrap_or("");
        REFUSED_OPTIONS.iter().any(|o| o.strip_prefix("--") == Some(name)) || REFUSED_FRAGMENTS.iter().any(|f| name.contains(f))
    })
}

/// The whole-command conditions shared by the offer and the match.
fn command_is_clean(a: &Analysis, jail: &Jail) -> bool {
    a.hard_stop.is_none()
        && a.issues.is_empty()
        && !a.has_assigns
        && !a.redirects_write
        && a.scripts.is_empty()
        && a.exec_surface_writes.is_empty()
        && !a.inline_code
        && a.network.is_empty()
        && a.paths.iter().all(|p| jail.contains(&jail.resolve(p)) || super::hardstop::HARMLESS_DEVICES.contains(&p.as_str()))
}

/// The argv prefix a session allow of this command would save, or `None` when it must not be offered.
pub(super) fn exec_offer(a: &Analysis, jail: &Jail) -> Option<Vec<String>> {
    let cmds: Vec<&Vec<Word>> = a.simple.iter().filter(|w| !w.is_empty()).collect();
    let [words] = cmds.as_slice() else { return None };
    if !command_is_clean(a, jail) || words.iter().any(|w| w.dynamic || w.glob) || refused_option(words) {
        return None;
    }
    let program = words[0].text.as_str();
    if program.contains('/') {
        return None;
    }
    let (_, verbs) = SESSION_ALLOW_EXEC.iter().find(|(p, _)| *p == program)?;
    match verbs {
        None => Some(vec![program.to_string()]),
        Some(verbs) => {
            let verb = words.get(1)?.text.as_str();
            verbs.contains(&verb).then(|| vec![program.to_string(), verb.to_string()])
        }
    }
}

/// True when every simple command of the analysed string matches a saved prefix by exact word text and the command as a whole is
/// clean. A prefix never matches a shell, `./git` or `/tmp/x/cat`, and never a command with a dynamic or glob word.
pub(super) fn saved_exec_allows(saved: &[SavedAllow], a: &Analysis, jail: &Jail) -> bool {
    let cmds: Vec<&Vec<Word>> = a.simple.iter().filter(|w| !w.is_empty()).collect();
    !cmds.is_empty()
        && !saved.is_empty()
        && command_is_clean(a, jail)
        && cmds.iter().all(|words| {
            if words.iter().any(|w| w.dynamic || w.glob) || refused_option(words) {
                return false;
            }
            let first = std::path::Path::new(&words[0].text).file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
            if SHELL_NAMES.contains(&first.as_str()) {
                return false;
            }
            saved.iter().any(|s| match s {
                SavedAllow::ExecPrefix { argv } => !argv.is_empty() && argv.len() <= words.len() && argv.iter().zip(words.iter()).all(|(p, w)| *p == w.text),
                _ => false,
            })
        })
}
