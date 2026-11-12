//! Which shell commands a secret-file grant may lift (an allow-list, not a deny-list).
//!
//! A grant lifts a stop for the dedicated file tools (Read and Grep on the exact file; Edit and Write for an edit grant) and for a shell command
//! whose ANALYSED words (quotes and escapes removed by the analyser, never the raw text) are made only of the readers below, joined by `&&`, `;`
//! and `|`: no interpreter, no network tool, no git except a read-only list, no command substitution, no unknown program, no redirect (an edit
//! grant also allows the writers below and redirects). Everything else that names the file stays refused even with the grant, and carries no
//! offer, because the card would promise something the command cannot get.

use super::hardstop::Analysis;
use super::shellparse::Word;

const READERS: &[&str] = &["cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "cut", "sort", "uniq", "diff", "jq", "stat", "file", "nl", "tr", "echo", "printf", "true", "pwd", "cd", "ls", "basename", "dirname"];
const WRITERS: &[&str] = &["tee", "cp", "mv", "rm", "touch", "mkdir"];
const GIT_READ_VERBS: &[&str] = &["status", "diff", "log", "show"];
const GIT_READ_OPTIONS: &[&str] = &["--short", "--stat", "--name-only", "--name-status", "--oneline", "--cached", "--staged", "-1", "-2", "-3", "-5", "-10", "-s", "-sb", "--porcelain"];

/// The program name when it is a plain name or a system path of the usual places.
fn program(w: &Word) -> Option<&str> {
    if w.dynamic || w.glob || w.eq {
        return None;
    }
    let t = w.text.as_str();
    match t.rsplit_once('/') {
        None => Some(t),
        Some((dir, name)) if matches!(dir, "/bin" | "/usr/bin" | "/usr/local/bin" | "/opt/homebrew/bin") => Some(name),
        _ => None,
    }
}

fn is_option(w: &Word) -> bool {
    w.text.starts_with('-') && w.text != "-"
}

/// A sed script that only prints lines (`-n '1,20p'`), or only substitutes (`-i 's/a/b/g'`).
fn sed_print_script(s: &str) -> bool {
    let mut parts = s.splitn(2, 'p');
    let (range, rest) = (parts.next().unwrap_or(""), parts.next());
    rest == Some("") && !range.is_empty() && range.chars().all(|c| c.is_ascii_digit() || c == ',' || c == '$')
}

fn sed_subst_script(s: &str) -> bool {
    let mut cs = s.chars();
    if cs.next() != Some('s') {
        return false;
    }
    let Some(delim) = cs.next().filter(|d| !d.is_alphanumeric() && !d.is_whitespace() && *d != '\\') else { return false };
    let body: Vec<&str> = s[2..].split(delim).collect();
    // s<d>from<d>to<d>flags: no `e` or `w` flag, no escapes that hide a delimiter
    body.len() == 3 && !body[0].contains('\\') && !body[1].contains('\\') && body[2].chars().all(|c| matches!(c, 'g' | 'G' | 'p' | 'i' | 'I' | '0'..='9'))
}

fn command_ok(words: &[Word], allow_writers: bool) -> bool {
    let Some(first) = words.first() else { return false };
    if words.iter().any(|w| w.dynamic || w.glob) {
        return false;
    }
    let Some(name) = program(first) else { return false };
    let args = &words[1..];
    let opts = || args.iter().filter(|w| is_option(w)).map(|w| w.text.as_str());
    match name {
        "git" => match args.first().map(|w| w.text.as_str()) {
            Some("branch") => args.len() == 2 && args[1].text == "--show-current",
            Some(v) if GIT_READ_VERBS.contains(&v) => args[1..].iter().all(|w| !is_option(w) || GIT_READ_OPTIONS.contains(&w.text.as_str())),
            _ => false,
        },
        "tail" => opts().all(|o| !(o.starts_with("--follow") || (!o.starts_with("--") && o.contains(['f', 'F'])))),
        "sort" => opts().all(|o| !(o.starts_with("-o") || o.starts_with("--output") || o.starts_with("--compress") || o.starts_with("-T") || o.starts_with("--temporary"))),
        "grep" | "egrep" | "fgrep" => opts().all(|o| {
            let long = o.starts_with("--");
            !(o.starts_with("--recursive") || o.starts_with("--dereference") || o.starts_with("--directories") || o.starts_with("--devices") || (!long && o.contains(['r', 'R', 'd', 'D'])))
        }),
        "jq" => opts().all(|o| !(o.starts_with("--from-file") || o.starts_with("-f") || o.starts_with("--rawfile") || o.starts_with("--slurpfile"))),
        n if READERS.contains(&n) => true,
        "sed" => {
            let plain: Vec<&Word> = args.iter().collect();
            match plain.as_slice() {
                [n, script, files @ ..] if n.text == "-n" && sed_print_script(&script.text) && files.iter().all(|f| !is_option(f)) => true,
                [i, script, files @ ..] if allow_writers && (i.text == "-i" || i.text == "-i''") && sed_subst_script(&script.text) && files.iter().all(|f| !is_option(f)) => true,
                _ => false,
            }
        }
        "rm" => allow_writers && opts().all(|o| o == "-f"),
        "tee" => allow_writers && opts().all(|o| o == "-a"),
        "cp" | "mv" => allow_writers && opts().all(|o| matches!(o, "-f" | "-n" | "-p")),
        "touch" | "mkdir" => allow_writers && opts().all(|o| o == "-p"),
        _ => false,
    }
}

/// Whether the analysed command is only what a grant may lift. `allow_writers`: an edit grant (writers and redirects) is in play.
pub fn reader_only(a: &Analysis, allow_writers: bool) -> bool {
    !a.simple.is_empty()
        && a.issues.is_empty()
        && !a.opaque
        && !a.stdin_expands
        && !a.has_assigns
        && a.scripts.is_empty()
        && a.outside_scripts.is_empty()
        && (allow_writers || !a.redirects_write)
        && a.simple.iter().all(|c| command_ok(c, allow_writers) && (allow_writers || !WRITERS.contains(&program(&c[0]).unwrap_or(""))))
}
