//! Low-risk read-only commands that need no approval (Edit mode stops asking for `ls`, `git status` and `cd <repo> && git diff`; Plan runs them too), the
//! "stays inside the run's folders" test of Automatic (`automatic_refusal`) and the URL rules Automatic shares between the web
//! tools and network programs.
//!
//! The list is deliberately short and every condition is structural: the whole command string must parse cleanly, no
//! command may redirect output into a file or run a script, every operand must be a path inside the working
//! directories that is neither a secret nor protected, and the few options that write files or run programs are
//! refused. A `VAR=value` prefix is never low-risk. Anything else stays an Ask.

use super::hardstop::{long_opt, Analysis, HARMLESS_DEVICES};
use super::paths::Jail;
use super::shellparse::Word;

const GIT_READ: &[&str] = &["status", "log", "diff", "show", "rev-parse", "ls-files", "blame"];
const READ_TOOLS: &[&str] = &["ls", "pwd", "cat", "grep", "egrep", "fgrep", "rg"];
/// Long options of git/rg that write a file or run a program (also as abbreviations, min 3 letters).
const DANGEROUS_LONG: &[&str] = &["output", "ext-diff", "open-files-in-pager", "no-index", "exec-path", "textconv", "pre", "pre-glob", "hostname-bin", "config-path", "output-indicator-new"];

/// What an option value may be.
#[derive(Clone, Copy, PartialEq)]
enum Val {
    /// digits, optionally signed (`+5`, `-5`)
    Num,
    /// free text that is never opened as a file (a separator, a key definition, a glob pattern, a format)
    Text,
}

/// The ALLOW-LIST of one command: only the options named here are low-risk, anything else (long, abbreviated, bundled, attached) is not.
struct Spec {
    /// single-letter flags without a value; they may be bundled (`-rn`)
    bools: &'static str,
    /// single-letter options with a value, as `-n 5` or attached `-n5`
    valued: &'static [(char, Val)],
    /// long flags written out in full
    long_bool: &'static [&'static str],
    /// long options with a value, as `--lines=5` (the value is attached; the separate form is refused)
    long_valued: &'static [(&'static str, Val)],
    /// `-5` style numbers (head/tail)
    digits: bool,
    /// operands are paths inside the run's folders (otherwise plain words; one with a `/` is still judged as a path when `slash_paths`)
    paths: bool,
    slash_paths: bool,
}

const NONE: Spec = Spec { bools: "", valued: &[], long_bool: &[], long_valued: &[], digits: false, paths: true, slash_paths: true };

fn spec_of(name: &str) -> Option<Spec> {
    Some(match name {
        "head" | "tail" => Spec { bools: "qv", valued: &[('n', Val::Num), ('c', Val::Num)], long_bool: &["quiet", "silent", "verbose"], long_valued: &[("lines", Val::Num), ("bytes", Val::Num)], digits: true, ..NONE },
        "wc" => Spec { bools: "lwcmL", long_bool: &["lines", "words", "bytes", "chars", "max-line-length"], ..NONE },
        "sort" => Spec {
            bools: "nrubdifhVscmz",
            valued: &[('k', Val::Text), ('t', Val::Text), ('S', Val::Text)],
            long_bool: &["numeric-sort", "reverse", "unique", "ignore-case", "ignore-leading-blanks", "dictionary-order", "ignore-nonprinting", "human-numeric-sort", "version-sort", "stable", "check", "merge", "zero-terminated"],
            long_valued: &[("key", Val::Text), ("field-separator", Val::Text), ("buffer-size", Val::Text)],
            ..NONE
        },
        "file" => Spec { bools: "bi", long_bool: &["brief", "mime", "mime-type", "mime-encoding"], ..NONE },
        "du" => Spec { bools: "shkmca", valued: &[('d', Val::Num)], long_bool: &["summarize", "human-readable", "total", "all", "apparent-size"], long_valued: &[("max-depth", Val::Num)], ..NONE },
        "diff" => Spec {
            bools: "urqNwbBiy",
            valued: &[('U', Val::Num)],
            long_bool: &["brief", "unified", "recursive", "new-file", "ignore-case", "side-by-side", "ignore-space-change", "ignore-blank-lines", "ignore-all-space"],
            long_valued: &[("unified", Val::Num)],
            ..NONE
        },
        "cmp" => Spec { bools: "sl", valued: &[('n', Val::Num)], long_bool: &["quiet", "silent", "verbose"], ..NONE },
        "tree" => Spec { bools: "daFshCnfi", valued: &[('L', Val::Num), ('I', Val::Text), ('P', Val::Text)], long_bool: &["noreport", "dirsfirst"], ..NONE },
        "stat" => Spec { bools: "tL", valued: &[('c', Val::Text), ('f', Val::Text)], long_bool: &["terse"], long_valued: &[("format", Val::Text), ("printf", Val::Text)], ..NONE },
        "realpath" => Spec { bools: "emsq", ..NONE },
        "which" => Spec { bools: "as", paths: false, ..NONE },
        "basename" => Spec { bools: "a", valued: &[('s', Val::Text)], paths: false, ..NONE },
        "dirname" => Spec { paths: false, ..NONE },
        "echo" => Spec { bools: "neE", paths: false, slash_paths: false, ..NONE },
        "true" => Spec { paths: false, slash_paths: false, ..NONE },
        _ => return None,
    })
}

fn value_ok(v: &str, kind: Val) -> bool {
    match kind {
        Val::Num => {
            let d = v.strip_prefix(['+', '-']).unwrap_or(v);
            !d.is_empty() && d.chars().all(|c| c.is_ascii_digit())
        }
        // a text value is never a path (`-f/etc/passwd`, `--o=../x`): such a value is refused
        Val::Text => !v.is_empty() && !(v.starts_with('/') && v.len() > 1) && !v.starts_with('~') && !v.contains(".."),
    }
}

/// True when every word of `args` is one of the options the spec lists, or an operand of the kind it names.
fn spec_ok(sp: &Spec, args: &[Word], jail: &Jail) -> bool {
    let mut i = 0;
    let mut after_dd = false;
    while let Some(w) = args.get(i) {
        i += 1;
        let t = w.text.as_str();
        if after_dd || !t.starts_with('-') || t == "-" {
            if !operand_for(sp, t, jail) {
                return false;
            }
            continue;
        }
        if t == "--" {
            after_dd = true;
            continue;
        }
        if let Some(long) = t.strip_prefix("--") {
            match long.split_once('=') {
                Some((name, v)) => match sp.long_valued.iter().find(|(n, _)| *n == name) {
                    Some((_, kind)) if value_ok(v, *kind) => {}
                    _ => return false,
                },
                None if sp.long_bool.contains(&long) => {}
                None => return false,
            }
            continue;
        }
        let body = &t[1..];
        if sp.digits && body.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        // bundled flags, ending at most with one valued option whose value is the rest of the word or the next word
        let mut chars = body.char_indices();
        while let Some((at, c)) = chars.next() {
            if sp.bools.contains(c) {
                continue;
            }
            let Some((_, kind)) = sp.valued.iter().find(|(l, _)| *l == c) else { return false };
            let rest = &body[at + c.len_utf8()..];
            if rest.is_empty() {
                match args.get(i) {
                    Some(v) if value_ok(&v.text, *kind) => i += 1,
                    _ => return false,
                }
            } else if !value_ok(rest, *kind) {
                return false;
            }
            break;
        }
    }
    true
}

fn operand_for(sp: &Spec, t: &str, jail: &Jail) -> bool {
    if sp.paths || (sp.slash_paths && t.contains('/')) {
        operand_ok(t, jail)
    } else {
        true
    }
}

/// `find` reads names only. Only `-P`/`-H` may precede the start paths; every plain word before the first expression token is a start
/// path judged like an operand; the expression may use only the listed side-effect-free predicates.
fn find_ok(args: &[Word], jail: &Jail) -> bool {
    const FLAG: &[&str] = &["-print", "-print0", "-prune", "-quit", "-not", "!", "-a", "-o", "-and", "-or", "(", ")", "-depth", "-empty"];
    const VALUE: &[&str] = &[
        "-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-type", "-maxdepth", "-mindepth", "-size", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-perm", "-user", "-group",
    ];
    let mut i = 0;
    while args.get(i).is_some_and(|w| matches!(w.text.as_str(), "-P" | "-H")) {
        i += 1;
    }
    let mut n = 0;
    while let Some(w) = args.get(i) {
        if w.text.starts_with('-') || w.text == "(" || w.text == "!" || w.text == ")" {
            break;
        }
        if !operand_ok(&w.text, jail) {
            return false;
        }
        n += 1;
        i += 1;
    }
    if n == 0 && !operand_ok(".", jail) {
        return false;
    }
    while let Some(w) = args.get(i) {
        i += 1;
        let t = w.text.as_str();
        if FLAG.contains(&t) {
            continue;
        }
        if VALUE.contains(&t) && args.get(i).is_some() {
            i += 1;
            continue;
        }
        return false;
    }
    true
}

/// True when every simple command of the analysed string is one of the low-risk reads.
pub fn is_low_risk_read(a: &Analysis, jail: &Jail) -> bool {
    let cmds: Vec<&Vec<Word>> = a.simple.iter().filter(|w| !w.is_empty()).collect();
    // a chain of nothing but `cd` is not a read: there must be a command to run in the directory
    !cmds.is_empty()
        && cmds.iter().any(|w| w[0].text != "cd")
        && a.issues.is_empty()
        && !a.has_assigns
        && a.hard_stop.is_none()
        && !a.redirects_write
        && a.scripts.is_empty()
        && a.read_redirects.iter().all(|w| !w.dynamic && !w.glob && !w.text.starts_with('~') && operand_ok(&w.text, jail))
        && cmds.iter().all(|w| command_ok(w, jail))
}

fn command_ok(words: &[Word], jail: &Jail) -> bool {
    // a word that starts with `~` (or `~user`) expands to a home folder: not judged
    if words.iter().any(|w| w.dynamic || w.glob || w.text.starts_with('~')) {
        return false;
    }
    let name = words[0].text.as_str();
    let args = &words[1..];
    match name {
        "find" => find_ok(args, jail),
        n if spec_of(n).is_some() => spec_ok(&spec_of(n).unwrap_or(NONE), args, jail),
        n if READ_TOOLS.contains(&n) => args_ok(n, args, jail),
        "git" => git_ok(args, jail),
        // `cd <dir> && git diff`: every command of an agent that works in several repositories starts like this. Only the directory change
        // is judged here (it must be inside the run's folders, so a later relative path cannot leave them); no bare `cd` and no `cd -`.
        "cd" => matches!(args, [dir] if !dir.text.starts_with('-') && operand_ok(&dir.text, jail)),
        "node" => matches!(args, [flag, file] if matches!(flag.text.as_str(), "--check" | "-c") && operand_ok(&file.text, jail)),
        _ => false,
    }
}

fn dangerous_option(t: &str) -> bool {
    if t.starts_with("--") {
        let name = t[2..].split('=').next().unwrap_or("");
        return DANGEROUS_LONG.iter().any(|d| d == &name || ((name.len() >= 3 || (name.len() == 2 && d.starts_with("pre"))) && d.starts_with(name)));
    }
    // short options that name an output file or a program: `-o`, `-O`
    t.starts_with('-') && t.len() > 1 && t[1..].chars().any(|c| matches!(c, 'o' | 'O')) && !t.starts_with("-n") && !t[1..].chars().all(|c| c.is_ascii_digit())
}

fn args_ok(cmd: &str, args: &[Word], jail: &Jail) -> bool {
    let mut after_dd = false;
    args.iter().all(|a| {
        let t = a.text.as_str();
        if !after_dd && t == "--" {
            after_dd = true;
            return true;
        }
        if !after_dd && t.starts_with('-') {
            // `grep -o` (only matching) is harmless, `rg -o` too; the dangerous short options are git/rg specific and
            // are caught by the long names above
            if t.starts_with("--") {
                let name = t[2..].split('=').next().unwrap_or("");
                // `--file=F`, `--fil=F`, `--f` ... read patterns from a file; a value that looks like a path is judged like an operand
                let reads_file = !name.is_empty() && "file".starts_with(name);
                // recursive search that follows symlinks reads through a link that points out of the run's folders
                if (name.len() >= 2 && ("dereference-recursive".starts_with(name) || "follow".starts_with(name))) && matches!(cmd, "grep" | "egrep" | "fgrep" | "rg") {
                    return false;
                }
                let value_ok = t.split_once('=').is_none_or(|(_, v)| !(v.starts_with('/') || v.starts_with('~') || v.contains("..")) || operand_ok(v, jail));
                return !dangerous_option(t) && !reads_file && value_ok;
            }
            // a bundled `-f` (`-rnf FILE`, `-fFILE`) takes patterns from a file
            let follows = match cmd {
                "grep" | "egrep" | "fgrep" => t[1..].contains('R'),
                "rg" => t[1..].contains('L'),
                _ => false,
            };
            return !t[1..].contains('f') && !follows;
        }
        operand_ok(t, jail)
    })
}

fn operand_ok(text: &str, jail: &Jail) -> bool {
    if text.is_empty() {
        return true;
    }
    let p = jail.resolve(text);
    jail.contains(&p) && jail.never_read_reason(&p).is_none() && jail.protected_reason(&p).is_none()
}

fn git_ok(args: &[Word], jail: &Jail) -> bool {
    let mut i = 0;
    while let Some(w) = args.get(i) {
        match w.text.as_str() {
            "-C" => {
                let Some(dir) = args.get(i + 1) else { return false };
                if !operand_ok(&dir.text, jail) {
                    return false;
                }
                i += 2;
            }
            "--no-pager" | "--no-optional-locks" | "--no-replace-objects" => i += 1,
            t if t.starts_with('-') => return false,
            _ => break,
        }
    }
    let Some(sub) = args.get(i) else { return false };
    if !GIT_READ.contains(&sub.text.as_str()) {
        return false;
    }
    let mut after_dd = false;
    args[i + 1..].iter().all(|a| {
        let t = a.text.as_str();
        if !after_dd && t == "--" {
            after_dd = true;
            return true;
        }
        if !after_dd && t.starts_with('-') {
            return !dangerous_option(t) && !long_opt(t, "output", 3) && !matches!(t, "-c" | "-C" | "-O" | "-o");
        }
        // revisions and paths; a protected or secret path is not auto-allowed, also as `rev:path`
        let t = t.rsplit_once(':').map_or(t, |(_, path)| path);
        let p = jail.resolve(t);
        jail.contains(&p) && jail.never_read_reason(&p).is_none() && jail.protected_reason(&p).is_none()
    })
}

/// Why Automatic refuses a command that otherwise analysed without a hard stop: the rule id and an actionable reason (the model
/// re-plans from the text).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoRefusal {
    pub rule: &'static str,
    pub reason: String,
}

fn refusal(rule: &'static str, reason: impl Into<String>) -> Option<AutoRefusal> {
    Some(AutoRefusal { rule, reason: reason.into() })
}

/// The Automatic rows of permission-modes spec 2.2 for a command that has no hard stop: `None` = the command analysed cleanly and
/// stays inside the run directories for every path the analyser could see (a script runner such as `npm test` counts as clean).
pub fn automatic_refusal(a: &Analysis, jail: &Jail) -> Option<AutoRefusal> {
    if let Some(script) = a.outside_scripts.first() {
        return refusal(
            "exec.auto.unjudgeable",
            format!("the script {script} is outside the run's folders and cannot be checked; keep the script inside a repository or in /tmp (and delete it afterwards) or run the code inline, or ask the user to switch to Bypass. The run's folders are: {}", jail.folders_hint()),
        );
    }
    if !a.issues.is_empty() {
        return refusal(
            "exec.auto.unjudgeable",
            format!(
                "this command cannot be checked statically ({}); rewrite it without command substitution, eval, `${{x:-y}}` or variables the command does not set from literal words (`f=src/a.js; cat $f` and `for f in a b; do cat $f; done` are fine), or ask the user to switch to Bypass",
                a.issues.join(", ")
            ),
        );
    }
    if a.inline_code {
        return refusal("exec.auto.inline-code", "this interpreter reads its code from another command in a pipe, which cannot be checked; give the code as a heredoc (python3 - <<'EOF') or write it to a file inside the repository, or ask the user to switch to Bypass");
    }
    // a relative word that is a symlink out of the run's folders (`cat lnk/hosts`, `cd lnk`) is not in `a.paths`: every operand is judged by
    // where it really points, from the directory its command ran in (`a.probes`; non-existing targets resolve lexically, so a new file
    // inside a folder stays fine, and a search pattern is not a path)
    for p in a.paths.iter().chain(&a.probes) {
        if HARMLESS_DEVICES.contains(&p.as_str()) {
            continue;
        }
        let resolved = jail.resolve(p);
        if !jail.contains(&resolved) && !jail.in_scratch(&resolved) && !HARMLESS_DEVICES.iter().any(|d| resolved == std::path::Path::new(d)) {
            return refusal("exec.auto.outside-jail", format!("{p} is outside the run's folders; Automatic works only inside them. The run's folders are: {}. Work inside one of them, or ask the user to switch to Bypass or to add the folder", jail.folders_hint()));
        }
    }
    for op in &a.network {
        if op.upload || net_auto_check(&op.text).is_err() {
            return refusal("exec.auto.network", format!("{}: Automatic allows only plain http(s) requests to public hosts without uploads (ask the user to switch to Bypass)", op.text));
        }
    }
    if let Some(name) = a.env_overrides.first() {
        return refusal("exec.auto.env-override", format!("{name} makes a program load code from the environment; run it without the variable or ask the user to switch to Bypass"));
    }
    if !a.destructive.is_empty() {
        return refusal("exec.auto.destructive", format!("this discards uncommitted work ({}); ask the user to switch to Bypass or do it by hand", a.destructive.join(", ")));
    }
    if let Some(risk) = a.script_risks.first() {
        return refusal("exec.auto.script-risk", format!("{risk}; Automatic does not run it (ask the user to switch to Bypass or run it by hand)"));
    }
    None
}

/// True when Automatic would run the command (no refusal).
pub fn is_safe_in_workspace(a: &Analysis, jail: &Jail) -> bool {
    a.hard_stop.is_none() && automatic_refusal(a, jail).is_none()
}

/// `host` of an http(s) URL without credentials, lower-cased; `None` for anything else.
pub fn url_host(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.contains('@') {
        return None;
    }
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next()?,
        None => authority.split(':').next()?,
    };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

fn is_ip_label(l: &str) -> bool {
    !l.is_empty() && (l.chars().all(|c| c.is_ascii_digit()) || l.strip_prefix("0x").is_some_and(|x| !x.is_empty() && x.chars().all(|c| c.is_ascii_hexdigit())))
}

/// Loopback, private, link-local, `.local`, `.internal`, `.localhost`, a bare name, or an IP literal in any notation (decimal, hex,
/// octal, IPv6, IPv4-mapped): the local services and cloud metadata endpoints that Automatic never fetches (SSRF), and the hosts
/// that are never offered as a session allow. A public NAME that resolves to a private address is not seen.
pub fn is_private_host(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    if h.is_empty() || h.contains(':') {
        return true;
    }
    if h == "localhost" || [".localhost", ".local", ".internal", ".lan", ".home.arpa"].iter().any(|s| h.ends_with(s)) {
        return true;
    }
    if h.split('.').all(is_ip_label) {
        return true;
    }
    !h.contains('.')
}

/// The Net rules of Automatic for one URL: `Ok(host)` for a plain http(s) URL of a public host, `Err((rule, reason))` otherwise.
pub fn net_auto_check(url: &str) -> Result<String, (&'static str, String)> {
    let Some(host) = url_host(url) else {
        return Err(("net.auto.odd-url", format!("{url}: not a plain http(s) URL (no other scheme, no credentials in the URL); ask the user to switch to Bypass")));
    };
    if url.len() > 300 || url.contains(['\n', '\r', '\0']) {
        return Err(("net.auto.exfil-shape", format!("URL to {host} is unusually long or has control characters and could carry file content; ask the user to switch to Bypass")));
    }
    if is_private_host(&host) {
        return Err(("net.auto.private-host", format!("{host} is a local, private or literal-IP address; Automatic fetches only public hosts (ask the user to switch to Bypass)")));
    }
    Ok(host)
}
