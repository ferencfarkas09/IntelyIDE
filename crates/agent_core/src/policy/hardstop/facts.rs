//! What the unattended modes need to know about a command, and the command-route hard stops of permission-modes spec 2.3.1:
//! the path list (`Analysis::paths`), network operands, inline interpreter code and script risks (2.5), plus
//! `read.never-read` on operands and redirects, `exec.proc-env` and `exec.catastrophic`. Everything here is best-effort TEXT
//! analysis like the rest of `hardstop.rs`: it closes the routes the analyser can see.

use std::path::Path;

use super::protected_args::{candidates, code_like, code_tokens};
use super::{base_name, paths, Ctx, NetOperand, Walker, Word, PM_PUBLISH};
use crate::policy::fsview;
use crate::policy::glob;

/// Programs that print the environment of other processes or read another process's memory, where MCP servers and tools keep their
/// secrets (`ps` only with an `e` or `E` flag, `sysctl` only with `kern.procargs*`, `launchctl` only with `procinfo`, `print`,
/// `print-cache`, `dumpstate`, `blame` or `export`; the rest always). One list for the hard stop `exec.proc-env` and for the
/// script scan (`script_risks`). `lsof` is deliberately not on it: it prints open files, not environments (mcp-management spec 13 #19).
pub const PROC_ENV_PROGRAMS: &[&str] = &["ps", "sysctl", "launchctl", "lldb", "gdb", "gcore", "dtrace", "dtruss", "vmmap"];
const LAUNCHCTL_ENV_VERBS: &[&str] = &["procinfo", "print", "print-cache", "dumpstate", "blame", "export"];
/// Programs a script may start that reach secrets or publish: together with a process-spawn API they make a script risky.
const SYSTEM_PROGRAMS: &[&str] = &["security", "osascript", "dscl", "wrangler"];
const PM_WORDS: &[&str] = &["npm", "pnpm", "yarn", "bun", "cnpm", "cargo", "twine", "gem", "poetry", "uv", "hatch", "flit"];

/// Builtins and printers whose arguments are not paths a program opens: no never-read test on their words.
const PRINTERS: &[&str] = &["echo", "printf", "true", "false", ":", "test", "[", "tr"];
/// Programs whose dynamic arguments cannot turn into a file access (the redirect target is judged separately).
const HARMLESS_DYNAMIC: &[&str] = &["echo", "printf", "true", "false", ":", "test", "[", "sleep", "exit", "return", "shift", "wait", "set", "unset", "read"];

const SPAWN_APIS: &[&str] = &[
    "child_process", "execSync", "spawnSync", "execFile", "Deno.Command", "Bun.spawn", "Bun.$", "os.system", "os.popen", "subprocess", "Popen", "pty.spawn", "system(", "popen(",
    "exec(", "Open3", "IO.popen", "%x(", "posix_spawn", "fork",
];
const HOME_APIS: &[&str] = &["os.homedir", "homedir()", "expanduser", "Path.home", "process.env.HOME", "os.environ[\"HOME\"]", "$HOME", "ENV['HOME']"];

/// Devices a command may name whatever the mode.
pub(crate) const HARMLESS_DEVICES: &[&str] = &["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty"];

/// Directories (resolved, exact match) whose removal wipes the system or the user's data.
const SYSTEM_DIRS: &[&str] = &["/", "/Users", "/Library", "/System", "/Applications", "/Volumes", "/usr", "/bin", "/sbin", "/etc", "/var", "/private", "/opt", "/cores", "/private/etc", "/private/var"];

/// A path-like candidate: starts with `/`, `~` or `file://`, or has a `..` component.
pub(crate) fn is_path_like(c: &str) -> bool {
    if c.starts_with("file://") || c.starts_with('/') || c.starts_with('~') {
        return !c.starts_with("//");
    }
    !c.contains("://") && c.split('/').any(|p| p == "..")
}

fn strip_file_scheme(c: &str) -> &str {
    c.strip_prefix("file://").unwrap_or(c)
}

/// The part of a glob word before its first metacharacter.
fn literal_prefix(c: &str) -> &str {
    c.find(['*', '?', '[']).map_or(c, |i| &c[..i])
}

/// The directory a glob word names: its literal prefix cut back to the last `/`; `None` for a relative glob without one.
fn glob_dir(c: &str) -> Option<&str> {
    let lit = literal_prefix(c);
    if lit.len() == c.len() {
        return Some(c);
    }
    lit.rfind('/').map(|i| if i == 0 { "/" } else { &lit[..i] })
}

/// Indices (into the words after the command name) of the operands that are a search pattern or an editing program, not a file:
/// `grep PATTERN file`, `sed -n '/x/p' file`, `awk 'prog' file`, `rg -e PATTERN`, the glob of `rg -g '*.js'` and the value of
/// `grep -A 3`, the pattern of `find -name '*.js'`. Such a word is matched against content or names, never opened.
fn pattern_operands(base: &str, rest: &[Word]) -> Vec<usize> {
    if base == "find" {
        let names = ["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-lname", "-ilname"];
        return (1..rest.len()).filter(|i| names.contains(&rest[i - 1].text.as_str())).collect();
    }
    // the short options whose value is the rest of the bundle or the next word and is never a path; `-e` (the pattern or program) and
    // `-f` (a file that holds it) are told apart below
    let valued = match base {
        "grep" | "egrep" | "fgrep" => "ABCDdm",
        "rg" | "ag" | "ack" => "ABCEMTgjmrt",
        "sed" | "gsed" => "l",
        "awk" | "gawk" | "mawk" | "nawk" => "Fv",
        _ => return Vec::new(),
    };
    let mut skip = Vec::new();
    // the program or pattern comes from `-e`, `--regexp`, `--expression` or a file, not from the first operand
    let mut explicit = false;
    let mut first: Option<usize> = None;
    let mut i = 0;
    while i < rest.len() {
        let t = rest[i].text.as_str();
        if t == "--" {
            if first.is_none() && i + 1 < rest.len() {
                first = Some(i + 1);
            }
            break;
        }
        if let Some(long) = t.strip_prefix("--") {
            let (name, attached) = long.split_once('=').map_or((long, false), |(n, _)| (n, true));
            match name {
                "regexp" | "expression" => {
                    explicit = true;
                    if !attached && i + 1 < rest.len() {
                        skip.push(i + 1);
                        i += 1;
                    }
                }
                // (`rg --files DIR` lists files: it takes no pattern, its first operand is a folder)
                "file" | "files" | "type-list" => explicit = true,
                _ => {}
            }
            i += 1;
            continue;
        }
        if t.starts_with('-') && t.len() > 1 {
            // a bundle read from the left: the first letter that takes a value ends it, the value is the rest of the word or the next word
            let body = &t[1..];
            let mut next_taken = false;
            for (at, c) in body.char_indices() {
                let tail = &body[at + c.len_utf8()..];
                if c == 'e' {
                    explicit = true;
                    if tail.is_empty() && i + 1 < rest.len() {
                        skip.push(i + 1);
                        next_taken = true;
                    }
                    break;
                }
                if c == 'f' {
                    // the file that holds the patterns stays an operand
                    explicit = true;
                    break;
                }
                if valued.contains(c) {
                    if tail.is_empty() && i + 1 < rest.len() {
                        skip.push(i + 1);
                        next_taken = true;
                    }
                    break;
                }
            }
            i += 1 + usize::from(next_taken);
            continue;
        }
        if !t.starts_with('-') && first.is_none() {
            first = Some(i);
        }
        i += 1;
    }
    if !explicit {
        skip.extend(first);
    }
    skip
}

/// `candidates` of one word, less the value of an option that holds text (`cut -d/`, `sort -t:`, `uniq -f1`): a delimiter is not a path.
fn operand_candidates<'t>(base: &str, t: &'t str) -> Vec<&'t str> {
    if let Some(opt) = t.strip_prefix('-').filter(|o| !o.starts_with('-')).and_then(|o| o.chars().next()) {
        let text = match base {
            "cut" => "dfcb",
            "sort" => "tkS",
            "uniq" => "fsw",
            "column" => "sco",
            "head" | "tail" => "nc",
            "fold" => "w",
            "paste" => "d",
            _ => "",
        };
        if text.contains(opt) {
            return Vec::new();
        }
    }
    if t.starts_with("--") && matches!(base, "cut" | "sort" | "uniq" | "column" | "head" | "tail" | "fold" | "paste") {
        let name = t[2..].split('=').next().unwrap_or("");
        if matches!(name, "delimiter" | "field-separator" | "separator" | "fields" | "characters" | "bytes" | "key" | "lines" | "width" | "skip-fields" | "skip-chars" | "check-chars") {
            return Vec::new();
        }
    }
    candidates(t)
}

/// `git` subcommands that print names or status and never the content of the paths they are given.
fn git_names_only(rest: &[Word]) -> bool {
    let mut i = 0;
    while let Some(w) = rest.get(i) {
        match w.text.as_str() {
            "-C" | "-c" | "--git-dir" | "--work-tree" | "--namespace" => i += 2,
            t if t.starts_with('-') => i += 1,
            t => return matches!(t, "check-ignore" | "check-attr" | "ls-files" | "ls-tree" | "status" | "rev-parse"),
        }
    }
    false
}

/// A word with white space in it that is shaped like a file name rather than like program text: it has none of the characters of
/// code (`"../../My Docs/x.txt"`, `"my notes.md"`, not `"require('../x')"`).
fn spaced_path(t: &str) -> bool {
    t.contains(char::is_whitespace) && !t.trim().is_empty() && !t.contains(['\n', ';', '|', '&', '<', '>', '(', ')', '{', '}', '"', '\'', '`', '$'])
}

/// A token of program text names something that exists, or sits in a directory that does (a URL route such as `/api/users`
/// does not): only those count as a path the program could open.
fn plausible(p: &Path) -> bool {
    fsview::exists(p) || p.parent().is_some_and(|d| d != Path::new("/") && fsview::exists(d))
}

impl<'a> Walker<'a> {
    /// A redirect source or target: never-read test, path list, and an issue when the file is not known statically.
    pub(super) fn redirect_fact(&mut self, target: &Word) {
        if target.dynamic {
            if self.script_stack.is_empty() {
                self.issue("redirect target is not known statically");
            }
            return;
        }
        if target.text.chars().all(|c| c.is_ascii_digit()) || target.text == "-" {
            return;
        }
        let text = target.text.clone();
        self.probe(&text);
        self.note_candidate(&text, true, false, true);
    }

    /// Records where an operand points ([`Analysis::probes`]): resolved from the directory the walker is in, symlinks of the existing
    /// part resolved. A relative word after a `cd` that could not be followed is not recorded (that `cd` is an issue already).
    pub(super) fn probe(&mut self, cand: &str) {
        let t = strip_file_scheme(cand);
        if t.is_empty() || t.starts_with('-') || (!self.cwd_known && !t.starts_with('/') && !t.starts_with('~')) {
            return;
        }
        if self.made_links && t.split('/').any(|c| c == "..") {
            self.issue("a path with .. after a command that makes a symbolic link (where the link leads is not known)");
        }
        let p = paths::resolve(&self.cwd, t, self.jail.home.as_deref()).display().to_string();
        if !self.a.probes.contains(&p) {
            self.a.probes.push(p);
        }
    }

    /// The words of a printer whose output goes to `xargs`: they are the names the next program opens, so each is judged like an operand
    /// (`echo ~/.ssh/id_rsa | xargs cat`). `xargs` splits its input at white space.
    pub(super) fn feed_operands(&mut self, words: &[Word]) {
        for w in words.iter().filter(|w| !w.dynamic && !w.text.is_empty() && !w.text.starts_with('-')) {
            let pieces = std::iter::once(w.text.as_str()).chain(w.text.split_whitespace());
            for t in pieces {
                for c in candidates(t) {
                    self.probe(c);
                    self.note_candidate(c, true, false, true);
                }
                if self.a.hard_stop.is_some() {
                    return;
                }
            }
        }
    }

    /// An unquoted glob stands for the files it matches: each one is judged like a plain operand (so `cat .e*` is `cat .env`). A pattern
    /// that matches nothing is passed to the program as written and judged as written by the caller. One that matches more than is
    /// listed has the matches found so far judged and then makes the command unjudgeable.
    fn glob_operands(&mut self, t: &str, secret: bool) {
        let t = strip_file_scheme(t);
        if !self.cwd_known && !t.starts_with('/') && !t.starts_with('~') {
            return;
        }
        if self.glob_untrusted {
            self.issue("a glob after setopt, shopt or set -o, which change what it matches");
            return;
        }
        let (list, too_many) = match glob::expand(&self.lexical_path(t)) {
            glob::Expansion::Files(list) => (list, false),
            glob::Expansion::TooMany(partial) => (partial, true),
        };
        for m in list {
            let m = m.display().to_string();
            self.probe(&m);
            self.note_candidate(&m, true, false, secret);
            if self.a.hard_stop.is_some() {
                return;
            }
        }
        if too_many {
            self.issue("a glob matches too many files to judge (name the folder, or quote the pattern)");
        }
    }

    /// One option or operand of a wrapper (`xargs -a list`, `env -C dir`, `time -o file`): judged like the operand of a program.
    pub(super) fn probe_wrapper_word(&mut self, w: &Word) {
        if w.dynamic {
            return;
        }
        for c in candidates(&w.text) {
            self.probe(c);
        }
        if let Some((_, v)) = w.text.split_once('=') {
            self.probe(v);
        }
    }

    /// One candidate path of the command being walked: judged against the never-read list (a hard stop) and recorded in
    /// `Analysis::paths` when path-like and `record` is set. `program_text` marks a token of script or inline code, which only
    /// counts when it is plausible (names something that exists).
    fn note_candidate(&mut self, cand: &str, record: bool, program_text: bool, secret: bool) {
        if cand.is_empty() || cand.starts_with('-') {
            return;
        }
        let known = self.cwd_known || cand.starts_with('/') || cand.starts_with('~') || cand.starts_with("file://");
        if known && secret {
            let lit = strip_file_scheme(literal_prefix(cand));
            if !lit.is_empty() {
                // A token of program text is judged by its spelling (no filesystem calls: a script has thousands of tokens); an
                // operand the program opens is resolved, symlinks included.
                let p = if program_text { self.lexical_path(lit) } else { paths::resolve(&self.cwd, lit, self.jail.home.as_deref()) };
                if let Some(why) = self.jail.never_read_reason(&p) {
                    self.stop("read.never-read", &format!("{} is a secret or IDE-state path and is never read by an agent ({why})", p.display()));
                    return;
                }
            }
        }
        if record && is_path_like(cand) {
            let mut text = strip_file_scheme(cand).to_string();
            if known && (program_text || (self.cwd != self.jail.cwd && !text.starts_with('/') && !text.starts_with('~'))) {
                let p = paths::resolve(&self.cwd, &text, self.jail.home.as_deref());
                // a relative token of program text (`'../../seed'` in a string that is being written into a source file) counts only
                // when it names something that exists: a module specifier or a name for another directory is not a file this program opens
                let relative = !text.starts_with('/') && !text.starts_with('~');
                // a token that is only slashes and dots (`/.` out of a regex literal such as `/(^|[/.\s])x/i`) resolves to the root, which no
                // program text names as a file
                if program_text && (!plausible(&p) || self.jail.contains(&p) || (relative && !fsview::exists(&p)) || p == Path::new("/")) {
                    return;
                }
                text = p.display().to_string();
            }
            if !self.a.paths.contains(&text) {
                self.a.paths.push(text);
            }
        }
    }

    /// `~` expanded, joined to the working directory and normalised, without touching the filesystem.
    fn lexical_path(&self, raw: &str) -> std::path::PathBuf {
        let expanded = paths::tilde_expanded(raw, self.jail.home.as_deref());
        paths::normalize_lexical(&if expanded.is_absolute() { expanded } else { self.cwd.join(expanded) })
    }

    /// Facts and stops of the command at the leaf of the walk (wrappers are already peeled).
    pub(super) fn leaf_facts(&mut self, base: &str, words: &[Word], ctx: &Ctx) {
        if super::SHELLS.contains(&base) || matches!(base, "eval" | "export" | "declare" | "typeset" | "readonly" | "local" | "alias" | "unalias" | "trap" | "source" | ".") {
            return;
        }
        self.catastrophic(base, words);
        if self.a.hard_stop.is_some() {
            return;
        }
        self.inline_and_network(base, words, ctx);
        let printer = PRINTERS.contains(&base);
        let code_runner = is_code_runner(base);
        let rest = words.get(1..).unwrap_or(&[]);
        if super::follows_links(base, rest) {
            self.issue("an option that follows symbolic links, which can lead out of the run's folders");
        }
        let patterns = pattern_operands(base, rest);
        // `git check-ignore .env` prints a name, it does not read the file.
        let names_only = base == "git" && git_names_only(rest);
        let mut after_dd = false;
        for (idx, w) in rest.iter().enumerate() {
            if self.a.hard_stop.is_some() {
                return;
            }
            if w.dynamic {
                if !HARMLESS_DYNAMIC.contains(&base) && self.script_stack.is_empty() {
                    self.issue("an argument is not known statically");
                }
                continue;
            }
            let t = w.text.as_str();
            if t.is_empty() {
                continue;
            }
            // an unquoted glob names the files it matches, also where the program reads a pattern: the shell expands it first
            if w.glob && !t.starts_with('-') && !code_like(t) {
                // (the names a printer lists are no secret, but they must be inside the run's folders)
                self.glob_operands(t, !names_only && !printer);
                if self.a.hard_stop.is_some() {
                    return;
                }
            }
            if patterns.contains(&idx) {
                // a name pattern of `find` (`-name .env`) is no path to open, but it asks for a secret by name
                if base == "find" {
                    self.note_candidate(t, false, false, true);
                    if self.a.hard_stop.is_some() {
                        return;
                    }
                }
                continue;
            }
            if !after_dd && t == "--" {
                after_dd = true;
                continue;
            }
            if code_like(t) {
                if !printer {
                    // a path with a space in it (`~/Library/Application Support/x`) is one operand, not program text
                    if t.starts_with('/') || t.starts_with('~') || t.starts_with("file://") {
                        self.probe(t);
                        self.note_candidate(t, true, false, !names_only);
                    } else if !code_runner && spaced_path(t) {
                        // `"../../My Docs/x.txt"`: a relative path with a space in it names one file; where it points is judged whole
                        self.probe(t);
                    }
                    for tok in code_tokens(t) {
                        self.note_candidate(tok, code_runner, true, !names_only);
                    }
                }
                continue;
            }
            if printer {
                continue;
            }
            // `git show HEAD:.env`: the part after the colon is the path.
            // (`//host/x` is what is left of a URL after its scheme, not a path)
            let colon = (base == "git").then(|| t.rsplit_once(':').map(|(_, p)| p)).flatten().filter(|p| !p.starts_with("//"));
            for c in operand_candidates(base, t).into_iter().chain(colon) {
                self.probe(c);
                self.note_candidate(c, true, false, !names_only);
            }
        }
    }

    /// `exec.proc-env`: commands that print the environment of other processes (the list is [`PROC_ENV_PROGRAMS`]).
    pub(super) fn proc_env(&mut self, base: &str, words: &[Word]) {
        if !PROC_ENV_PROGRAMS.contains(&base) {
            return;
        }
        let rest = words.get(1..).unwrap_or(&[]);
        let hit = match base {
            "ps" => ps_prints_environment(rest),
            "sysctl" => rest.iter().any(|w| w.text.to_ascii_lowercase().contains("kern.procargs") || w.dynamic),
            "launchctl" => rest.iter().find(|w| !w.text.starts_with('-')).is_some_and(|w| LAUNCHCTL_ENV_VERBS.contains(&w.text.as_str()) || w.dynamic),
            _ => true,
        };
        if hit {
            self.stop("exec.proc-env", &format!("{base} prints the environment of other processes, which can hold secrets (ps -p <pid> -o pid,ppid,comm shows what you need)"));
        }
    }

    /// `exec.catastrophic` for the program at the leaf; also the run-root `destructive` facts of GZ-15.
    fn catastrophic(&mut self, base: &str, words: &[Word]) {
        let rest = words.get(1..).unwrap_or(&[]);
        let operands = || -> Vec<&Word> {
            let mut dd = false;
            rest.iter()
                .filter(|w| {
                    if !dd && w.text == "--" {
                        dd = true;
                        return false;
                    }
                    dd || !w.text.starts_with('-')
                })
                .collect()
        };
        match base {
            "rm" | "rmdir" | "unlink" | "shred" | "srm" => {
                for w in operands() {
                    self.catastrophic_operand(base, w);
                }
            }
            "chmod" | "chown" | "chgrp" if rest.iter().any(|w| matches!(w.text.as_str(), "-R" | "-r" | "--recursive") || (w.text.starts_with('-') && !w.text.starts_with("--") && (w.text.contains('R') || w.text.contains('r')))) => {
                for w in operands() {
                    self.catastrophic_operand(base, w);
                }
            }
            "dd" => {
                if rest.iter().any(|w| w.text.strip_prefix("of=").is_some_and(|v| v.starts_with("/dev/") && !HARMLESS_DEVICES.contains(&v) && !v.starts_with("/dev/fd/"))) {
                    self.stop("exec.catastrophic", "dd to a device would overwrite a disk; do it by hand in a terminal if you mean it");
                }
            }
            "diskutil" => {
                let plain: Vec<String> = rest.iter().filter(|w| !w.text.starts_with('-')).map(|w| w.text.to_ascii_lowercase()).collect();
                let verb = plain.first().map(String::as_str).unwrap_or("");
                let apfs_delete = verb == "apfs" && plain.get(1).is_some_and(|w| w.starts_with("delete"));
                if verb.starts_with("erase") || verb.starts_with("partition") || matches!(verb, "secureerase" | "zerodisk" | "randomdisk") || apfs_delete {
                    self.stop("exec.catastrophic", "diskutil erase, partition and delete commands wipe disks; do it by hand in a terminal if you mean it");
                }
            }
            b if b.starts_with("mkfs") || b.starts_with("newfs") => {
                self.stop("exec.catastrophic", "creating a filesystem wipes a disk; do it by hand in a terminal if you mean it");
            }
            _ => {}
        }
    }

    /// `find` that deletes (or runs a destructive program with `-exec`): its starting points are judged like `rm` operands.
    pub(super) fn find_destructive(&mut self, words: &[Word]) {
        let rest = words.get(1..).unwrap_or(&[]);
        let destructive_exec = rest.iter().enumerate().any(|(i, w)| {
            matches!(w.text.as_str(), "-exec" | "-execdir" | "-ok" | "-okdir") && rest.get(i + 1).is_some_and(|n| matches!(base_name(&n.text).as_str(), "rm" | "rmdir" | "unlink" | "shred" | "srm" | "chmod" | "chown" | "chgrp"))
        });
        if !destructive_exec && !rest.iter().any(|w| w.text == "-delete") {
            return;
        }
        let starts: Vec<&Word> = rest.iter().skip_while(|w| matches!(w.text.as_str(), "-H" | "-L" | "-P")).take_while(|w| !w.text.starts_with('-') && w.text != "(" && w.text != "!").collect();
        if starts.is_empty() {
            self.note_destructive("find", ".");
        }
        for w in starts {
            self.catastrophic_operand("find", w);
        }
    }

    fn note_destructive(&mut self, what: &str, target: &str) {
        let line = format!("{what} {target}");
        if !self.a.destructive.contains(&line) {
            self.a.destructive.push(line);
        }
    }

    /// One operand of a destructive program: the system, the home folder or a folder above a run root is a hard stop in every
    /// mode; a run directory itself is only recorded (`Analysis::destructive`, an Automatic-only refusal).
    fn catastrophic_operand(&mut self, base: &str, w: &Word) {
        let mut text = w.text.clone();
        if w.dynamic {
            // `$HOME` and `${HOME}` written literally are the home folder; any other computed word is an issue elsewhere.
            let home = ["${HOME}", "$HOME"].iter().find_map(|h| text.strip_prefix(h).map(|r| r.to_string()));
            let Some(rest) = home else { return };
            let Some(home_dir) = self.jail.home_dir().map(Path::to_path_buf) else { return };
            text = if rest.contains('$') { home_dir.display().to_string() } else { format!("{}{rest}", home_dir.display()) };
        }
        if text.is_empty() || (!self.cwd_known && !text.starts_with('/') && !text.starts_with('~')) {
            return;
        }
        let Some(dir) = glob_dir(&text) else { return };
        let p = paths::resolve(&self.cwd, if dir.is_empty() { "." } else { dir }, self.jail.home.as_deref());
        let system = SYSTEM_DIRS.iter().any(|s| p == Path::new(s)) || self.jail.home_dir().is_some_and(|h| p == h);
        if system || self.jail.is_ancestor_of_root(&p) {
            self.stop(
                "exec.catastrophic",
                &format!("{base} {} would delete or overwrite the system, your home folder or a folder that holds the run's repositories; do it by hand in a terminal if you mean it", p.display()),
            );
        } else if self.jail.is_run_root(&p) {
            self.note_destructive(base, &text);
        }
    }

    /// Inline interpreter code and network clients.
    fn inline_and_network(&mut self, base: &str, words: &[Word], ctx: &Ctx) {
        let rest = words.get(1..).unwrap_or(&[]);
        if is_code_runner(base) && inline_flag(base, rest, ctx) {
            // The text of `python3 - <<'EOF'` or `node -e '...'` is in the command: it is read like a script file (never-read tokens
            // are a hard stop, a program-spawning script that names git, a system program or an outside path is a risk). Only code
            // that comes from another command in a pipe is unknown, and stays `inline_code`.
            match inline_code_text(rest, ctx) {
                Some(text) => self.script_text_facts(&format!("inline {base} code"), &text),
                None => self.a.inline_code = true,
            }
        }
        if base == "git" {
            self.git_destructive(rest);
        }
        let upload_by_redirect = ctx.stdin_file;
        let mut ops: Vec<NetOperand> = Vec::new();
        let mut add = |text: &str, upload: bool| ops.push(NetOperand { text: text.to_string(), upload: upload || upload_by_redirect });
        match base {
            "curl" => curl_operands(rest, &mut add),
            "wget" => wget_operands(rest, &mut add),
            "nc" | "ncat" | "netcat" | "socat" | "ssh" | "scp" | "sftp" | "ftp" | "telnet" => {
                let operands: Vec<&Word> = rest.iter().filter(|w| !w.text.starts_with('-')).collect();
                if operands.is_empty() {
                    add(base, false);
                }
                for w in operands {
                    add(&w.text, false);
                }
            }
            "rsync" => {
                for w in rest.iter().filter(|w| !w.text.starts_with('-')) {
                    if looks_remote(&w.text) {
                        add(&w.text, false);
                    }
                }
            }
            "git" => {
                let mut it = rest.iter().filter(|w| !w.text.starts_with('-'));
                if let Some(sub) = it.next() {
                    if matches!(sub.text.as_str(), "clone" | "fetch" | "pull" | "ls-remote") {
                        for w in it.filter(|w| w.text.contains("://") || (w.text.contains('@') && w.text.contains(':'))) {
                            add(&w.text, false);
                        }
                    }
                }
            }
            _ => {}
        }
        for op in ops {
            if !self.a.network.contains(&op) {
                self.a.network.push(op);
            }
        }
    }

    /// `git clean`, `git restore`, `git checkout -- <path>` (GZ-15): they discard uncommitted work.
    fn git_destructive(&mut self, args: &[Word]) {
        let mut i = 0;
        while let Some(w) = args.get(i) {
            match w.text.as_str() {
                "-C" | "-c" | "--git-dir" | "--work-tree" | "--namespace" => i += 2,
                t if t.starts_with('-') => i += 1,
                _ => break,
            }
        }
        let Some(sub) = args.get(i) else { return };
        let rest: Vec<&str> = args[i + 1..].iter().map(|w| w.text.as_str()).collect();
        let discards = match sub.text.as_str() {
            "clean" => !rest.iter().any(|a| matches!(*a, "-n" | "--dry-run") || (a.starts_with('-') && !a.starts_with("--") && a.contains('n'))),
            "restore" => !(rest.iter().any(|a| matches!(*a, "--staged" | "-S")) && !rest.iter().any(|a| matches!(*a, "--worktree" | "-W"))),
            "checkout" => rest.iter().any(|a| matches!(*a, "--" | "." | "-f" | "--force")),
            _ => false,
        };
        if discards {
            let name = sub.text.clone();
            self.note_destructive("git", &name);
        }
    }

    /// The text of a non-shell script the analyser read: never-read tokens (a hard stop), path tokens, and the risk heuristic.
    pub(super) fn script_text_facts(&mut self, label: &str, text: &str) {
        let body = if text.starts_with("#!") { text.split_once('\n').map_or("", |(_, rest)| rest) } else { text };
        let script_dir = self.script_dir.clone();
        for tok in code_tokens(body) {
            if self.a.hard_stop.is_some() {
                return;
            }
            self.script_token(tok, script_dir.as_deref());
        }
        if let Some(why) = self.script_risk(label, body) {
            self.a.script_risks.push(format!("{label}: {why}"));
        }
    }

    fn script_token(&mut self, tok: &str, script_dir: Option<&Path>) {
        if tok.starts_with('-') || tok.starts_with("//") {
            return;
        }
        let relative = !tok.starts_with('/') && !tok.starts_with('~') && !tok.starts_with("file://");
        if let (true, Some(dir)) = (relative, script_dir) {
            if tok.split('/').any(|p| p == "..") {
                // `../x` relative to the script's own directory: only what leaves the run directories is recorded.
                let p = paths::resolve(dir, tok, self.jail.home.as_deref());
                if !self.jail.contains(&p) && plausible(&p) {
                    let text = p.display().to_string();
                    if !self.a.paths.contains(&text) {
                        self.a.paths.push(text);
                    }
                }
                return;
            }
        }
        self.note_candidate(tok, true, true, true);
    }

    fn script_risk(&self, label: &str, body: &str) -> Option<String> {
        if HOME_APIS.iter().any(|a| body.contains(a)) {
            return Some("reads the home directory".to_string());
        }
        let ext = label.rsplit('.').next().unwrap_or("");
        let spawns = SPAWN_APIS.iter().any(|a| body.contains(a)) || (matches!(ext, "rb" | "pl" | "pm") && body.contains('`'));
        if !spawns {
            return None;
        }
        let lower = body.to_ascii_lowercase();
        let tokens: Vec<&str> = lower.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_')).filter(|t| !t.is_empty()).collect();
        let names_git = tokens.contains(&"git");
        let names_system = tokens.iter().any(|t| PROC_ENV_PROGRAMS.contains(t) || SYSTEM_PROGRAMS.contains(t)) || lower.contains("procargs");
        let publishes = tokens.windows(4).any(|w| PM_WORDS.contains(&w[0]) && w[1..].iter().any(|t| PM_PUBLISH.contains(t) && !matches!(*t, "access" | "token" | "owner")));
        let outside = code_tokens(body).any(|tok| {
            let tok = tok.trim_start_matches("file://");
            !tok.starts_with("//") && (tok.starts_with('/') || tok.starts_with('~')) && {
                let p = paths::resolve(&self.cwd, tok, self.jail.home.as_deref());
                !self.jail.contains(&p) && !self.jail.in_scratch(&p) && !p.starts_with("/dev/") && plausible(&p)
            }
        });
        let what = if names_git {
            "git"
        } else if names_system || publishes {
            "a program that reads secrets or publishes"
        } else if outside {
            "a path outside the run's folders"
        } else {
            return None;
        };
        Some(format!("starts other programs and mentions {what}"))
    }
}

fn is_code_runner(base: &str) -> bool {
    matches!(base, "node" | "nodejs" | "ruby" | "perl" | "php" | "deno" | "bun" | "lua" | "tclsh" | "awk" | "gawk" | "mawk" | "nawk") || base.starts_with("python")
}

/// The options before the first operand; the word after a value-taking option is skipped.
fn leading_options<'w>(rest: &'w [Word], value_flags: &[&str]) -> Vec<&'w str> {
    let mut out = Vec::new();
    let mut skip = false;
    for w in rest {
        let t = w.text.as_str();
        if skip {
            skip = false;
            continue;
        }
        if !t.starts_with('-') || t == "-" {
            break;
        }
        skip = value_flags.contains(&t);
        out.push(t);
    }
    out
}

/// The inline code of an interpreter call when the analyser has its text: the words after the interpreter and a heredoc or here-string.
/// `None` for code that arrives from another command in a pipe (`echo '...' | python3 -`) or that holds a variable.
fn inline_code_text(rest: &[Word], ctx: &Ctx) -> Option<String> {
    if rest.iter().any(|w| w.dynamic) {
        return None;
    }
    let mut code = rest.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
    match &ctx.stdin_script {
        Some(body) => {
            code.push('\n');
            code.push_str(body);
        }
        None if ctx.piped && rest.iter().all(|w| w.text.starts_with('-')) => return None,
        None => {}
    }
    Some(code)
}

/// `-e`, `-c`, `-p`, `--eval`, a heredoc or here-string, an awk program.
fn inline_flag(base: &str, rest: &[Word], ctx: &Ctx) -> bool {
    if ctx.stdin_script.is_some() {
        return true;
    }
    // `echo '...' | python3 -`: the code comes from another command in the pipe
    if ctx.piped && rest.first().is_some_and(|w| w.text == "-") && (base.starts_with("python") || matches!(base, "node" | "nodejs" | "deno" | "bun" | "ruby" | "perl" | "php")) {
        return true;
    }
    let scan_group = |t: &str, hit: &[char], stop: &[char]| -> bool {
        if !t.starts_with('-') || t.starts_with("--") {
            return false;
        }
        for c in t.chars().skip(1) {
            if hit.contains(&c) {
                return true;
            }
            if stop.contains(&c) {
                return false;
            }
        }
        false
    };
    match base {
        "node" | "nodejs" => {
            let opts = leading_options(rest, &["-r", "--require", "--import", "--loader", "--env-file", "--experimental-loader"]);
            opts.iter().any(|t| matches!(*t, "-e" | "-p" | "--eval" | "--print" | "-pe" | "-ep") || t.starts_with("--eval=") || t.starts_with("--print="))
        }
        b if b.starts_with("python") => leading_options(rest, &["-W", "-X", "-Q"]).iter().any(|t| scan_group(t, &['c'], &['m', 'W', 'X', 'Q'])),
        "ruby" => leading_options(rest, &["-I", "-r"]).iter().any(|t| scan_group(t, &['e'], &['I', 'r', 'C', 'x', 'K'])),
        "perl" => leading_options(rest, &[]).iter().any(|t| scan_group(t, &['e', 'E'], &['M', 'm', 'I', 'x', 'C', 'd'])),
        "php" => leading_options(rest, &[]).iter().any(|t| scan_group(t, &['r'], &[])),
        "deno" => rest.first().is_some_and(|t| t.text == "eval") || leading_options(rest, &[]).iter().any(|t| matches!(*t, "-e" | "--eval")),
        "bun" => leading_options(rest, &[]).iter().any(|t| matches!(*t, "-e" | "-p" | "--eval" | "--print")),
        "lua" => leading_options(rest, &[]).iter().any(|t| scan_group(t, &['e'], &[])),
        "awk" | "gawk" | "mawk" | "nawk" => {
            let texts: Vec<&str> = rest.iter().map(|w| w.text.as_str()).collect();
            !texts.iter().any(|t| *t == "-f" || t.starts_with("-f") || t.starts_with("--file")) && texts.iter().any(|t| !t.starts_with('-'))
        }
        _ => false,
    }
}

/// An operand that names another machine: a URL with a scheme, `user@host:path` or `host:path`.
fn looks_remote(t: &str) -> bool {
    if t.contains("://") {
        return true;
    }
    if t.starts_with('/') || t.starts_with('.') || t.starts_with('~') || t.starts_with('-') {
        return false;
    }
    t.split_once(':').is_some_and(|(host, _)| !host.is_empty() && !host.contains('/'))
}

/// `ps` flags that print the environment on macOS: an `e` or `E` in a flag cluster, with or without a leading dash (`ps eww`,
/// `ps auxe`, `ps -E`, `ps -ef`, `ps -eo ...`); the values of `-p`, `-o`, `-u` ... are not flags.
fn ps_prints_environment(rest: &[Word]) -> bool {
    const VALUE_FLAGS: &[char] = &['p', 'o', 'u', 'U', 'g', 'G', 't', 'C', 'O', 's', 'D'];
    let mut skip_next = false;
    let mut first_operand = true;
    for w in rest {
        let t = w.text.as_str();
        if w.dynamic {
            return true;
        }
        if skip_next {
            skip_next = false;
            continue;
        }
        if let Some(group) = t.strip_prefix('-').filter(|g| !g.is_empty() && !g.starts_with('-')) {
            for (i, c) in group.char_indices() {
                if c == 'e' || c == 'E' {
                    return true;
                }
                if VALUE_FLAGS.contains(&c) {
                    skip_next = i + c.len_utf8() == group.len();
                    break;
                }
            }
        } else if !t.starts_with('-') && first_operand {
            first_operand = false;
            if t.chars().all(|c| c.is_ascii_alphabetic()) && t.chars().any(|c| c == 'e' || c == 'E') {
                return true;
            }
        }
    }
    false
}

/// Value-taking options of `curl`: their value is not an operand.
const CURL_VALUE_OPTS: &[&str] = &[
    "-o", "--output", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "-F", "--form", "--form-string", "-X", "--request", "-u", "--user", "-A",
    "--user-agent", "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "-T", "--upload-file", "-w", "--write-out", "-m", "--max-time", "--connect-timeout", "--retry", "--retry-delay",
    "-x", "--proxy", "--cacert", "--cert", "--key", "-K", "--config", "-r", "--range", "--resolve", "--limit-rate", "-C", "--continue-at", "--interface", "-D", "--dump-header", "-z", "--time-cond",
    "--oauth2-bearer", "--json", "--max-redirs", "-Y", "-y", "--proxy-user", "--aws-sigv4", "-E", "--output-dir", "-Q", "--quote",
];

fn curl_operands(rest: &[Word], out: &mut dyn FnMut(&str, bool)) {
    let mut i = 0;
    let mut after_dd = false;
    while let Some(w) = rest.get(i) {
        let t = w.text.as_str();
        i += 1;
        if !after_dd && t == "--" {
            after_dd = true;
            continue;
        }
        if after_dd || !t.starts_with('-') || t == "-" {
            out(t, false);
            continue;
        }
        if t == "--url" {
            if let Some(n) = rest.get(i) {
                out(&n.text, false);
            }
            i += 1;
            continue;
        }
        let (name, glued): (String, Option<String>) = match t.strip_prefix("--") {
            Some(long) => match long.split_once('=') {
                Some((n, v)) => (format!("--{n}"), Some(v.to_string())),
                None => (t.to_string(), None),
            },
            None if t.len() > 2 => (t[..2].to_string(), Some(t[2..].to_string())),
            None => (t.to_string(), None),
        };
        if !CURL_VALUE_OPTS.contains(&name.as_str()) {
            continue;
        }
        let value = match glued {
            Some(v) => v,
            None => {
                i += 1;
                rest.get(i - 1).map(|n| n.text.clone()).unwrap_or_default()
            }
        };
        let upload = match name.as_str() {
            "-T" | "--upload-file" => true,
            "-d" | "--data" | "--data-binary" | "--data-ascii" | "--json" => value.starts_with('@'),
            "--data-urlencode" => value.contains('@'),
            "-F" | "--form" => value.contains("=@") || value.contains("=<") || value.starts_with('@'),
            _ => false,
        };
        if upload {
            out("(upload)", true);
        }
    }
}

fn wget_operands(rest: &[Word], out: &mut dyn FnMut(&str, bool)) {
    const VALUE_OPTS: &[&str] = &["-O", "-o", "-P", "-U", "-e", "-t", "-T", "-w", "-a", "-B", "-l", "-Q", "--header", "--user", "--password", "--output-document", "--directory-prefix", "--user-agent", "--timeout", "--tries", "--wait"];
    let mut i = 0;
    while let Some(w) = rest.get(i) {
        let t = w.text.as_str();
        i += 1;
        if t.starts_with("--post-file") || t.starts_with("--body-file") {
            out("(upload)", true);
            if !t.contains('=') {
                i += 1;
            }
            continue;
        }
        if t == "-i" || t == "--input-file" || t.starts_with("--input-file=") {
            out("(urls read from a file)", false);
            if !t.contains('=') {
                i += 1;
            }
            continue;
        }
        if t.starts_with('-') && t != "-" {
            if VALUE_OPTS.contains(&t) {
                i += 1;
            }
            continue;
        }
        out(t, false);
    }
}

/// The programs that `exec.catastrophic` is about, for the raw-text fallback.
const DESTRUCTIVE_WORDS: &[&str] = &["rm", "rmdir", "unlink", "shred", "srm", "find", "dd", "chmod", "chown", "chgrp", "diskutil"];

/// Bypass only: the raw-text scan of a command the analyser could not judge (`exec.raw-text`, permission-modes spec 2.3.1). The
/// command is not understood, so its TEXT is searched for what must never happen: a git write, a secret or IDE-state path, a
/// destructive program next to the system or home folder. A path assembled from several variables is not seen.
pub fn raw_text_stop(raw: &str, jail: &super::Jail) -> Option<String> {
    const MAX_CANDIDATES: usize = 4000;
    if super::mentions_git_write(raw) {
        return Some("this command cannot be analysed and its text names a git write".to_string());
    }
    let home = jail.home_dir().map(|h| h.display().to_string());
    let text = match &home {
        Some(h) => raw.replace("${HOME}", h).replace("$HOME", h),
        None => raw.to_string(),
    };
    let flat = text.replace("\\ ", " ");
    let mut cands: Vec<String> = code_tokens(&flat).map(str::to_string).collect();
    cands.extend(flat.split_whitespace().map(|f| f.trim_matches(|c: char| matches!(c, '"' | '\'' | ';' | '|' | '&' | '(' | ')' | '<' | '>' | '`')).to_string()));
    for seg in flat.split(|c: char| matches!(c, ';' | '|' | '&' | '<' | '>' | '(' | ')' | '`' | '"' | '\'' | '\n')) {
        for (i, c) in seg.char_indices() {
            if (c == '/' || c == '~') && (i == 0 || seg[..i].chars().last().is_some_and(|p| p.is_whitespace() || p == '=')) {
                cands.push(seg[i..].trim().to_string());
            }
        }
    }
    for c in cands.iter().filter(|c| !c.is_empty() && !c.starts_with('-')).take(MAX_CANDIDATES) {
        let p = jail.resolve(strip_file_scheme(literal_prefix(c)));
        if jail.never_read_reason(&p).is_some() {
            return Some("this command cannot be analysed and its text names a secret or IDE-state path".to_string());
        }
    }
    let words: Vec<String> = raw.split_whitespace().map(|f| f.trim_matches(|c: char| matches!(c, '"' | '\'' | ';' | '|' | '&' | '(' | ')' | '`')).to_string()).collect();
    let destructive = words.iter().any(|w| {
        let b = base_name(w);
        DESTRUCTIVE_WORDS.contains(&b.as_str()) || b.starts_with("mkfs") || b.starts_with("newfs")
    });
    if destructive && words.iter().any(|w| bare_root_token(w)) {
        return Some("this command cannot be analysed and its text pairs a destructive program with the system or home folder".to_string());
    }
    None
}

/// `/`, `~`, `$HOME`, `${HOME}`, or one of them followed by `/`, `/*` or a computed part: the whole folder, not a child of it.
fn bare_root_token(w: &str) -> bool {
    let w = w.trim();
    if matches!(w, "/" | "/*" | "~" | "~/" | "~/*" | "$HOME" | "${HOME}" | "$HOME/" | "${HOME}/" | "$HOME/*" | "${HOME}/*") {
        return true;
    }
    ["$HOME", "${HOME}", "~"].iter().any(|r| w.strip_prefix(r).is_some_and(|rest| rest.starts_with('/') && rest.contains('$')))
}
