//! Low-risk read-only commands that need no approval (Edit mode stops asking for `ls`, `git status` and `cd <repo> && git diff`; Plan runs them too), the
//! "stays inside the run's folders" test of Automatic (`automatic_refusal`) and the URL rules Automatic shares between the web
//! tools and network programs.
//!
//! The list is deliberately short and every condition is structural: the whole command string must parse cleanly, no
//! command may redirect output into a file (`/dev/null` is no file) or run a script, every program and option must be on the
//! allow-list below (the few options that write files or run programs are not), and every operand must point to a path inside the
//! working directories that is neither a secret nor protected. The paths are those the analyser worked out (`Analysis::paths` and
//! `probes`): resolved from the directory the command ran in after a `cd`, a search pattern is not one, a glob is the files it matches.
//! A `VAR=value` prefix is never low-risk. Anything else stays an Ask.

use super::hardstop::{long_opt, Analysis, HARMLESS_DEVICES};
use super::paths::Jail;
use super::shellparse::Word;

/// `git` subcommands that read history and files and take revisions and paths as operands.
const GIT_READ: &[&str] = &[
    "status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "rev-list", "describe", "ls-tree", "cat-file", "shortlog", "show-ref", "for-each-ref", "merge-base", "name-rev", "diff-tree",
    "diff-index", "count-objects", "whatchanged", "grep",
];
const READ_TOOLS: &[&str] = &["ls", "pwd", "cat", "grep", "egrep", "fgrep", "rg"];
/// Long options of git/rg that write a file or run a program (also as abbreviations, min 3 letters).
const DANGEROUS_LONG: &[&str] = &["output", "ext-diff", "open-files-in-pager", "no-index", "exec-path", "textconv", "filters", "pre", "pre-glob", "hostname-bin", "config-path", "output-indicator-new"];

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
    /// most operands (`uniq IN OUT` writes OUT)
    max_operands: Option<usize>,
}

const NONE: Spec = Spec { bools: "", valued: &[], long_bool: &[], long_valued: &[], digits: false, max_operands: None };

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
        // `uniq IN OUT` writes OUT: one operand at most
        "uniq" => Spec {
            bools: "cdiu",
            valued: &[('f', Val::Num), ('s', Val::Num), ('w', Val::Num)],
            long_bool: &["count", "repeated", "unique", "ignore-case"],
            long_valued: &[("skip-fields", Val::Num), ("skip-chars", Val::Num), ("check-chars", Val::Num)],
            max_operands: Some(1),
            ..NONE
        },
        "cut" => Spec {
            bools: "sn",
            valued: &[('d', Val::Text), ('f', Val::Text), ('c', Val::Text), ('b', Val::Text)],
            long_bool: &["only-delimited", "complement"],
            long_valued: &[("delimiter", Val::Text), ("fields", Val::Text), ("characters", Val::Text), ("bytes", Val::Text)],
            ..NONE
        },
        // `tr` reads its input from stdin; its operands are the two sets
        "tr" => Spec { bools: "cdsC", max_operands: Some(2), ..NONE },
        "tac" | "rev" => NONE,
        "column" => Spec { bools: "tx", valued: &[('s', Val::Text), ('c', Val::Num), ('o', Val::Text)], ..NONE },
        "uname" => Spec { bools: "amnprsv", ..NONE },
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
        "which" => Spec { bools: "as", ..NONE },
        "basename" => Spec { bools: "a", valued: &[('s', Val::Text)], ..NONE },
        "dirname" | "whoami" => NONE,
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

/// True when every word of `args` is one of the options the spec lists, or an operand (its path is judged by where it points).
fn spec_ok(sp: &Spec, args: &[Word]) -> bool {
    let mut i = 0;
    let mut after_dd = false;
    let mut operands = 0usize;
    while let Some(w) = args.get(i) {
        i += 1;
        let t = w.text.as_str();
        if after_dd || !t.starts_with('-') || t == "-" {
            operands += 1;
            if sp.max_operands.is_some_and(|m| operands > m) {
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

/// `find` reads names only. Only `-P`/`-H` may precede the start paths (judged where they point, like every operand); the expression
/// may use only the listed side-effect-free predicates.
fn find_ok(args: &[Word]) -> bool {
    const FLAG: &[&str] = &["-print", "-print0", "-prune", "-quit", "-not", "!", "-a", "-o", "-and", "-or", "(", ")", "-depth", "-empty"];
    const VALUE: &[&str] = &[
        "-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-type", "-maxdepth", "-mindepth", "-size", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-perm", "-user", "-group",
    ];
    let mut i = 0;
    while args.get(i).is_some_and(|w| matches!(w.text.as_str(), "-P" | "-H")) {
        i += 1;
    }
    while let Some(w) = args.get(i) {
        if w.text.starts_with('-') || w.text == "(" || w.text == "!" || w.text == ")" {
            break;
        }
        i += 1;
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

/// `sed` as a viewer: `-n`, `-E`, `-r` and a script of addresses with `p`, `d`, `=` or `q`, and `s` / `y` without a flag that writes a
/// file or runs a command. `-i`, `-f` and every other command (`w`, `r`, `e` ...) are refused.
fn sed_ok(args: &[Word]) -> bool {
    let mut scripts = 0usize;
    let mut explicit = false;
    let mut after_dd = false;
    let mut i = 0;
    while let Some(w) = args.get(i) {
        i += 1;
        let t = w.text.as_str();
        if after_dd || !t.starts_with('-') || t == "-" {
            // the first plain word is the script unless `-e` gave it; the others are files
            if !after_dd && !explicit && scripts == 0 {
                if !sed_script_ok(t) {
                    return false;
                }
                scripts += 1;
            }
            continue;
        }
        if t == "--" {
            after_dd = true;
            continue;
        }
        if let Some(long) = t.strip_prefix("--") {
            match long.split_once('=') {
                Some(("expression", script)) if sed_script_ok(script) => {
                    scripts += 1;
                    explicit = true;
                }
                None if long == "expression" => {
                    let Some(script) = args.get(i) else { return false };
                    i += 1;
                    if !sed_script_ok(&script.text) {
                        return false;
                    }
                    scripts += 1;
                    explicit = true;
                }
                None if matches!(long, "quiet" | "silent" | "regexp-extended" | "unbuffered" | "separate") => {}
                _ => return false,
            }
            continue;
        }
        let mut chars = t[1..].char_indices();
        while let Some((at, c)) = chars.next() {
            match c {
                'n' | 'E' | 'r' | 'u' | 's' | 'z' => {}
                'e' => {
                    // the script is the rest of the word (`-es/a/b/`) or the next word (`-ne 5p`)
                    let rest = &t[1 + at + 1..];
                    let script = if rest.is_empty() {
                        let Some(next) = args.get(i) else { return false };
                        i += 1;
                        next.text.as_str()
                    } else {
                        rest
                    };
                    if !sed_script_ok(script) {
                        return false;
                    }
                    scripts += 1;
                    explicit = true;
                    break;
                }
                _ => return false,
            }
        }
    }
    scripts > 0
}

/// A script of `;` or newline separated commands: `[addr[,addr]][!]` and one of `p d = q Q`, `s/re/text/flags` (flags `g p i I m M` and
/// digits only), `y/from/to/`.
fn sed_script_ok(script: &str) -> bool {
    let c: Vec<char> = script.chars().collect();
    let mut i = 0;
    let mut commands = 0;
    loop {
        while c.get(i).is_some_and(|ch| ch.is_whitespace() || *ch == ';') {
            i += 1;
        }
        if i >= c.len() {
            return commands > 0;
        }
        match sed_address(&c, i, false) {
            Err(()) => return false,
            Ok(Some(next)) => {
                i = next;
                if c.get(i) == Some(&',') {
                    match sed_address(&c, i + 1, true) {
                        Ok(Some(n)) => i = n,
                        _ => return false,
                    }
                }
            }
            Ok(None) => {}
        }
        while c.get(i) == Some(&' ') {
            i += 1;
        }
        if c.get(i) == Some(&'!') {
            i += 1;
            while c.get(i) == Some(&' ') {
                i += 1;
            }
        }
        match c.get(i) {
            Some('p' | 'd' | '=') => i += 1,
            Some('q' | 'Q') => {
                i += 1;
                while c.get(i).is_some_and(|d| d.is_ascii_digit()) {
                    i += 1;
                }
            }
            Some('s') => match sed_delimited(&c, i + 1, 2, "gpiImM0123456789") {
                Some(n) => i = n,
                None => return false,
            },
            Some('y') => match sed_delimited(&c, i + 1, 2, "") {
                Some(n) => i = n,
                None => return false,
            },
            _ => return false,
        }
        commands += 1;
        while c.get(i).is_some_and(|ch| *ch == ' ' || *ch == '\t') {
            i += 1;
        }
        if !matches!(c.get(i), None | Some(';' | '\n')) {
            return false;
        }
    }
}

/// One address at `at`: `Ok(None)` when there is none, `Ok(Some(next))` after it, `Err` when it is cut off.
fn sed_address(c: &[char], at: usize, second: bool) -> Result<Option<usize>, ()> {
    let mut i = at;
    match c.get(i) {
        Some(d) if d.is_ascii_digit() => {
            while c.get(i).is_some_and(|d| d.is_ascii_digit()) {
                i += 1;
            }
            // `first~step`
            if c.get(i) == Some(&'~') && c.get(i + 1).is_some_and(|d| d.is_ascii_digit()) {
                i += 1;
                while c.get(i).is_some_and(|d| d.is_ascii_digit()) {
                    i += 1;
                }
            }
            Ok(Some(i))
        }
        Some('$') => Ok(Some(i + 1)),
        Some('+' | '~') if second && c.get(i + 1).is_some_and(|d| d.is_ascii_digit()) => {
            i += 1;
            while c.get(i).is_some_and(|d| d.is_ascii_digit()) {
                i += 1;
            }
            Ok(Some(i))
        }
        Some(&d) if d == '/' || (d == '\\' && c.get(i + 1).is_some_and(|x| !matches!(x, '\n' | '\\'))) => {
            let delim = if d == '/' {
                i += 1;
                '/'
            } else {
                i += 2;
                c[i - 1]
            };
            loop {
                match c.get(i) {
                    None | Some('\n') => return Err(()),
                    Some('\\') => i += 2,
                    Some(x) if *x == delim => {
                        i += 1;
                        break;
                    }
                    Some(_) => i += 1,
                }
            }
            while matches!(c.get(i), Some('I' | 'M')) {
                i += 1;
            }
            Ok(Some(i))
        }
        _ => Ok(None),
    }
}

/// After `s` or `y` at `at`: the delimiter, `parts` text parts that end with it, then only characters of `flags`. The end of the command.
fn sed_delimited(c: &[char], at: usize, parts: usize, flags: &str) -> Option<usize> {
    let delim = *c.get(at)?;
    if delim.is_alphanumeric() || delim.is_whitespace() || delim == '\\' || delim == ';' {
        return None;
    }
    let mut i = at + 1;
    for _ in 0..parts {
        loop {
            match c.get(i)? {
                '\\' => i += 2,
                x if *x == delim => {
                    i += 1;
                    break;
                }
                _ => i += 1,
            }
        }
    }
    while c.get(i).is_some_and(|f| flags.contains(*f)) {
        i += 1;
    }
    Some(i)
}

/// `awk` as a column extractor: `-F SEP` and a program of an optional pattern and `{print items}`; nothing that runs a command or writes a file.
fn awk_ok(args: &[Word]) -> bool {
    let mut program: Option<&str> = None;
    let mut i = 0;
    while let Some(w) = args.get(i) {
        i += 1;
        let t = w.text.as_str();
        if program.is_some() {
            // the files
            continue;
        }
        if t == "-F" {
            match args.get(i) {
                Some(sep) if value_ok(&sep.text, Val::Text) => i += 1,
                _ => return false,
            }
        } else if let Some(sep) = t.strip_prefix("-F").filter(|s| !s.is_empty()) {
            if !value_ok(sep, Val::Text) {
                return false;
            }
        } else if t.starts_with('-') && t != "-" {
            return false;
        } else {
            program = Some(t);
        }
    }
    program.is_some_and(awk_program_ok)
}

/// `[pattern] [{print item, item ...}]` where an item is `$N`, `$NF`, `NR`, `NF` or a string, and a pattern is `/re/` or comparisons of
/// `NR`, `NF`, `$N` with a number or a string (joined by `&&` or `||`). A pattern alone prints the lines it matches.
fn awk_program_ok(p: &str) -> bool {
    let c: Vec<char> = p.chars().collect();
    let ws = |i: &mut usize| {
        while c.get(*i).is_some_and(|ch| ch.is_whitespace()) {
            *i += 1;
        }
    };
    let mut i = 0;
    ws(&mut i);
    let mut has_pattern = false;
    match c.get(i) {
        None | Some('{') => {}
        Some(_) => match awk_pattern(&c, i) {
            Some(n) => {
                i = n;
                has_pattern = true;
            }
            None => return false,
        },
    }
    ws(&mut i);
    if i >= c.len() {
        return has_pattern;
    }
    if c.get(i) != Some(&'{') {
        return false;
    }
    i += 1;
    ws(&mut i);
    if !c[i..].starts_with(&['p', 'r', 'i', 'n', 't']) {
        return false;
    }
    i += 5;
    loop {
        ws(&mut i);
        match c.get(i) {
            Some('}') => {
                i += 1;
                break;
            }
            Some(',' | ';') => i += 1,
            Some('$') => {
                i += 1;
                if c[i..].starts_with(&['N', 'F']) {
                    i += 2;
                } else if c.get(i).is_some_and(|d| d.is_ascii_digit()) {
                    while c.get(i).is_some_and(|d| d.is_ascii_digit()) {
                        i += 1;
                    }
                } else {
                    return false;
                }
            }
            Some('"') => match awk_string(&c, i) {
                Some(n) => i = n,
                None => return false,
            },
            Some('N') if c[i..].starts_with(&['N', 'R']) || c[i..].starts_with(&['N', 'F']) => i += 2,
            _ => return false,
        }
    }
    ws(&mut i);
    i >= c.len()
}

/// A string literal at `at` (which holds the opening quote): the index after it.
fn awk_string(c: &[char], at: usize) -> Option<usize> {
    let mut i = at + 1;
    loop {
        match c.get(i)? {
            '\n' => return None,
            '\\' => i += 2,
            '"' => return Some(i + 1),
            _ => i += 1,
        }
    }
}

/// `/re/` or `term OP value [&& | || ...]`; the index after it.
fn awk_pattern(c: &[char], at: usize) -> Option<usize> {
    let mut i = at;
    loop {
        while c.get(i).is_some_and(|ch| ch.is_whitespace()) {
            i += 1;
        }
        if c.get(i) == Some(&'/') {
            i += 1;
            loop {
                match c.get(i)? {
                    '\n' => return None,
                    '\\' => i += 2,
                    '/' => {
                        i += 1;
                        break;
                    }
                    _ => i += 1,
                }
            }
        } else {
            // term
            if c[i..].starts_with(&['N', 'R']) || c[i..].starts_with(&['N', 'F']) {
                i += 2;
            } else if c.get(i) == Some(&'$') {
                i += 1;
                if c[i..].starts_with(&['N', 'F']) {
                    i += 2;
                } else if c.get(i).is_some_and(|d| d.is_ascii_digit()) {
                    while c.get(i).is_some_and(|d| d.is_ascii_digit()) {
                        i += 1;
                    }
                } else {
                    return None;
                }
            } else {
                return None;
            }
            while c.get(i).is_some_and(|ch| ch.is_whitespace()) {
                i += 1;
            }
            // operator
            let rest: String = c[i..].iter().take(2).collect();
            let op = ["==", "!=", "<=", ">=", "!~"].iter().find(|o| rest == **o).map(|o| o.len()).or_else(|| matches!(c.get(i), Some('<' | '>' | '~')).then_some(1))?;
            i += op;
            while c.get(i).is_some_and(|ch| ch.is_whitespace()) {
                i += 1;
            }
            // value
            match c.get(i)? {
                '"' => i = awk_string(c, i)?,
                d if d.is_ascii_digit() => {
                    while c.get(i).is_some_and(|d| d.is_ascii_digit()) {
                        i += 1;
                    }
                }
                '/' => {
                    i += 1;
                    loop {
                        match c.get(i)? {
                            '\n' => return None,
                            '\\' => i += 2,
                            '/' => {
                                i += 1;
                                break;
                            }
                            _ => i += 1,
                        }
                    }
                }
                _ => return None,
            }
        }
        while c.get(i).is_some_and(|ch| ch.is_whitespace()) {
            i += 1;
        }
        if c[i..].starts_with(&['&', '&']) || c[i..].starts_with(&['|', '|']) {
            i += 2;
        } else {
            return Some(i);
        }
    }
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
        // a here-string or a here-document with an expansion puts the environment (or anything) into the command's input
        && !a.stdin_expands
        // a subshell, a function, an array or an arithmetic expansion: what runs is not what the flat list of words shows
        && !a.opaque
        // `2>/dev/null` discards output; any other target is a file written
        && a.write_redirects.iter().all(|w| !w.dynamic && HARMLESS_DEVICES.contains(&w.text.as_str()))
        && a.scripts.is_empty()
        && a.read_redirects.iter().all(|w| !w.dynamic && !w.text.starts_with('~'))
        && cmds.iter().all(|w| command_ok(w, jail))
        // where every operand really points: from the directory its command ran in, a search pattern is not a path, a glob is its matches
        && a.paths.iter().chain(&a.probes).all(|p| read_path_ok(p, jail))
}

fn command_ok(words: &[Word], jail: &Jail) -> bool {
    // a computed word is not judged; a word that starts with `~` (or `~user`) expands to a home folder, and a glob must not name a program
    if words.iter().any(|w| w.dynamic || w.text.starts_with('~')) || (words[0].glob && words[0].text != "[") {
        return false;
    }
    let name = words[0].text.as_str();
    let args = &words[1..];
    match name {
        "find" => find_ok(args),
        "sed" | "gsed" => sed_ok(args),
        "awk" | "gawk" | "mawk" | "nawk" => awk_ok(args),
        // text and tests: they open nothing but the paths they are given, which are judged where they point
        "echo" | ":" | "false" | "true" => true,
        // a test of a path tells whether it exists: a path outside the run's folders is not asked about
        "test" | "[" => args.iter().all(|w| w.text.starts_with('-') || !(w.text.contains('/') || w.text.starts_with('.')) || operand_ok(&w.text, jail)),
        "printf" => !args.first().is_some_and(|w| w.text.starts_with("-v")),
        n if spec_of(n).is_some() => spec_ok(&spec_of(n).unwrap_or(NONE), args),
        n if READ_TOOLS.contains(&n) => args_ok(n, args),
        "git" => git_ok(args, jail),
        // `cd <dir> && git diff`: every command of an agent that works in several repositories starts like this. The directory is judged
        // where it points, like any operand, so a later relative path cannot leave the run's folders; no bare `cd` and no `cd -`.
        "cd" => matches!(args, [dir] if !dir.text.starts_with('-')),
        "node" => matches!(args, [flag, file] if matches!(flag.text.as_str(), "--check" | "-c") && !file.text.starts_with('-')),
        _ => false,
    }
}

/// A path an operand really points to: inside the run's folders, neither a secret nor protected (the discard devices are fine).
fn read_path_ok(p: &str, jail: &Jail) -> bool {
    if HARMLESS_DEVICES.contains(&p) {
        return true;
    }
    operand_ok(p, jail)
}

fn dangerous_option(t: &str) -> bool {
    if t.starts_with("--") {
        let name = t[2..].split('=').next().unwrap_or("");
        return DANGEROUS_LONG.iter().any(|d| d == &name || ((name.len() >= 3 || (name.len() == 2 && d.starts_with("pre"))) && d.starts_with(name)));
    }
    // short options that name an output file or a program: `-o`, `-O`
    t.starts_with('-') && t.len() > 1 && t[1..].chars().any(|c| matches!(c, 'o' | 'O')) && !t.starts_with("-n") && !t[1..].chars().all(|c| c.is_ascii_digit())
}

fn args_ok(cmd: &str, args: &[Word]) -> bool {
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
                return !dangerous_option(t) && !reads_file;
            }
            // a bundled `-f` (`-rnf FILE`, `-fFILE`) takes patterns from a file
            let follows = match cmd {
                "grep" | "egrep" | "fgrep" => t[1..].contains('R'),
                "rg" => t[1..].contains('L'),
                _ => false,
            };
            return !t[1..].contains('f') && !follows;
        }
        // an operand, a pattern or the value of an option: where a path points is judged from the analysis
        true
    })
}

fn operand_ok(text: &str, jail: &Jail) -> bool {
    if text.is_empty() {
        return true;
    }
    let p = jail.resolve(text);
    jail.contains(&p) && jail.never_read_reason(&p).is_none() && jail.protected_reason(&p).is_none()
}

/// The revisions and paths after a git read subcommand; a protected or secret path is not auto-allowed, also as `rev:path`.
fn git_operands_ok(args: &[Word], jail: &Jail) -> bool {
    let mut after_dd = false;
    args.iter().all(|a| {
        let t = a.text.as_str();
        if !after_dd && t == "--" {
            after_dd = true;
            return true;
        }
        if !after_dd && t.starts_with('-') {
            return !dangerous_option(t) && !long_opt(t, "output", 3) && !matches!(t, "-c" | "-C" | "-O" | "-o");
        }
        let t = t.rsplit_once(':').map_or(t, |(_, path)| path);
        operand_ok(t, jail)
    })
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
    let rest = &args[i + 1..];
    let flag = |w: &Word, names: &[&str]| names.contains(&w.text.as_str());
    match sub.text.as_str() {
        s if GIT_READ.contains(&s) => git_operands_ok(rest, jail),
        // listing branches (`git branch NAME` creates one)
        "branch" => {
            let listing = rest.iter().any(|w| flag(w, &["-l", "--list"]));
            rest.iter().all(|w| flag(w, &["--show-current", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "-l", "--list", "--no-color", "--color", "--no-column"]) || (listing && !w.text.starts_with('-')))
        }
        // `git remote -v` and `git remote get-url NAME` (`git remote show` talks to the server)
        "remote" => match rest {
            [] => true,
            [v] => flag(v, &["-v", "--verbose"]),
            [g, name] => g.text == "get-url" && !name.text.starts_with('-'),
            _ => false,
        },
        // listing tags (`git tag NAME` creates one)
        "tag" => {
            rest.iter().any(|w| flag(w, &["-l", "--list"]))
                && rest.iter().all(|w| flag(w, &["-l", "--list", "-n", "--no-color", "--color"]) || w.text.starts_with("--sort=") || w.text.strip_prefix("-n").is_some_and(|d| d.chars().all(|c| c.is_ascii_digit())) || !w.text.starts_with('-'))
        }
        "stash" => rest.first().is_some_and(|w| matches!(w.text.as_str(), "list" | "show")) && git_operands_ok(&rest[1..], jail),
        // `git reflog expire` and `git reflog delete` rewrite it
        "reflog" => rest.iter().all(|w| if w.text.starts_with('-') { !dangerous_option(&w.text) && !w.text.starts_with("--expire") && !w.text.starts_with("--rewrite") && !w.text.starts_with("--updateref") } else { !matches!(w.text.as_str(), "expire" | "delete") }),
        _ => false,
    }
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
