//! Hard stops (providers-plan 1.6, 3.3, 5.4): the operations only the human may do, judged on parsed argv.
//!
//! A shell string is parsed (`shellparse`), wrappers are peeled (`sh -c`, `env`, `command`, `sudo`, `xargs`,
//! `find -exec`, absolute and relative paths to the binary, `git -C`, `git-commit`), and every simple command
//! that results is judged. Anything that cannot be judged statically (variables in command position, `eval`,
//! a shell reading stdin) is recorded as an *issue*; the broker then asks and never uses a saved allow.
//! Best effort by design: scripts and `npm run x` are opaque, the OS-level layers cover those (3.1).

use std::path::{Path, PathBuf};

use super::paths::{self, Jail};
use super::shellparse::{self, Command, RedirKind, Word, MAX_DEPTH};

mod facts;
mod protected_args;
mod scripts;
mod vars;

pub use facts::{raw_text_stop, PROC_ENV_PROGRAMS};
pub(crate) use facts::HARMLESS_DEVICES;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HardStop {
    pub rule: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Analysis {
    pub hard_stop: Option<HardStop>,
    /// Why the command could not be fully judged. Non-empty = "unparseable": ask, never a saved allow.
    pub issues: Vec<String>,
    /// Top-level simple commands as written (wrappers not peeled): saved allows match on these.
    pub simple: Vec<Vec<Word>>,
    /// Some command in the string redirects its output into a file (the auto-allow of read-only commands needs to know).
    pub redirects_write: bool,
    /// Scripts the command runs (`npm run x`, `make x`, `bash x.sh`, `node x.js`), as `<where>: <text>`. Their text was
    /// scanned; what is left is an Ask that shows this text. A command that runs a script is never a saved allow.
    pub scripts: Vec<String>,
    /// Some command starts with `VAR=value` assignments (they steer the program: `PATH=`, `NODE_OPTIONS=`, `LD_PRELOAD=`).
    pub has_assigns: bool,
    /// Files a command writes (redirect target, `tee`, `cp` destination, `sed -i` ...) that run code when the human
    /// commits, pushes, installs, lints, tests or builds. Non-empty = Ask (`exec.write-exec-surface`), never a saved allow.
    pub exec_surface_writes: Vec<String>,
    /// Every path-like string of every simple command the walker visited (wrappers peeled, the command name itself excluded), as
    /// written: operand words through `candidates` (the word, the value of `--opt=value`, `key=value`, `of=value` and the glued
    /// value of a short option), every redirect target, and for program text (the text of non-shell scripts, inline code) every
    /// `code_tokens` token. Path-like = starts with `/`, `~` or `file://` (the scheme is stripped) or has a `..` component. After a
    /// `cd` that moved the walker, a relative `..` path is recorded already resolved. The unattended modes resolve each entry with
    /// `Jail::resolve` and refuse what leaves the run directories (permission-modes spec 2.5).
    pub paths: Vec<String>,
    /// Operands of network clients (`curl`, `wget`, `nc`, `ssh`, `scp`, `rsync` with a remote, `git clone` of a URL ...).
    pub network: Vec<NetOperand>,
    /// Interpreter code given inline (`-e`, `-c`, `-p`, `--eval`, a heredoc or here-string fed to an interpreter, an awk program).
    pub inline_code: bool,
    /// Scripts whose text has a risk: a process-spawn API together with `git`, a path outside the run directories or a program of
    /// `PROC_ENV_PROGRAMS`, or a home-directory API.
    pub script_risks: Vec<String>,
    /// `VAR=value` overrides that make an interpreter load code (`NODE_OPTIONS`, `PYTHON*`, `RUBYOPT`, `TMPDIR` ...). `PATH`,
    /// `HOME` and the other overrides that remove the git shim are hard stops, not listed here.
    pub env_overrides: Vec<String>,
    /// Operations that destroy work no Rewind snapshot may hold, on a run directory itself (`rm -rf .`, `git clean`,
    /// `git restore`, `find . -delete`): the Automatic-only `exec.auto.destructive` refusal. The wider set is `exec.catastrophic`.
    pub destructive: Vec<String>,
    /// Script files the command runs that exist outside the run's folders (as written): their text cannot be scanned, which is the
    /// issue `script outside the working directories`; kept apart so the refusal can name the file.
    pub outside_scripts: Vec<String>,
    /// Targets of input redirects (`< file`) of every command: the auto-allow of read-only commands judges them like operands.
    pub read_redirects: Vec<Word>,
    /// Targets of output redirects (`> file`, `>> file`): Automatic resolves them like any other path (a symlink may point out).
    pub write_redirects: Vec<Word>,
    /// Where every operand really points: the operand words of every command (also the value of `--opt=value` and `key=value`, and the
    /// options and operands of a wrapper such as `xargs` or `env`), a command word that names a path, and every redirect target,
    /// resolved from the directory the walker was in when it saw the word (a `cd` earlier in the string is followed), symlinks of the
    /// existing part resolved. A search pattern, a sed or awk program and the text a printer prints are not operands of this kind
    /// (`grep /x/ f`, `sed -n '/^a/,/^b/p' f`, `echo /etc/hosts`) and are left out. Automatic refuses what leaves the run's folders
    /// (`cat lnk/hosts` and `cd lnk` are judged by where the link goes).
    pub probes: Vec<String>,
}

/// One operand of a network client. `upload` is true when an option or a redirect sends a file out.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct NetOperand {
    pub text: String,
    pub upload: bool,
}

/// Judges a shell command string.
pub fn analyze(raw: &str, jail: &Jail) -> Analysis {
    let mut w = Walker::new(jail);
    if raw.contains("INTELY_HUMAN_TOKEN") || raw.contains("token.sha256") {
        w.stop("shim.token", "references the human-only IDE token");
    }
    if raw.len() > MAX_COMMAND_LEN {
        // Too long to parse in bounded time: a visible git write still stops, anything else is unjudged.
        if mentions_git_write(raw) {
            w.stop("exec.too-long", "oversized command that mentions a git write");
        }
        if wrangler::mentions_wrangler_sub(raw) || wrangler::mentions_cf_api(raw) || wrangler::has_cf_env_ref(raw) || wrangler::secret_in_text(raw).is_some() {
            w.cf_stop("exec.too-long", "oversized command that mentions wrangler, the Cloudflare API or their credentials");
        }
        w.issue("command is too long to analyse");
        return w.a;
    }
    w.script(raw, 0);
    w.a
}

/// Judges an already-split argv (ACP style), which may itself be `sh -c <script>`.
pub fn analyze_argv(argv: &[String], jail: &Jail) -> Analysis {
    let mut w = Walker::new(jail);
    let words: Vec<Word> = argv.iter().map(|a| Word::lit(a)).collect();
    w.exec(&words, 0, &Ctx::default());
    w.a.simple.push(words);
    w.a
}

const GIT_HARD_VERBS: &[&str] = &[
    "commit",
    "push",
    "tag",
    "update-ref",
    "cherry-pick",
    "rebase",
    "merge",
    "pull",
    "am",
    "revert",
    "notes",
    "replace",
    "commit-tree",
    "send-pack",
    "receive-pack",
    "fast-import",
    "filter-branch",
    "filter-repo",
    "send-email",
    "subtree",
    "citool",
    "gui",
    "svn",
    "cvsexportcommit",
    "http-push",
];

/// `-c` / `git config` keys that change identity, run commands or redirect remotes.
const DANGEROUS_KEY_PREFIXES: &[&str] = &["user.", "author.", "committer.", "alias.", "include.", "includeif.", "credential.", "gpg.", "url.", "filter.", "pager.", "remote."];
const DANGEROUS_KEYS: &[&str] = &[
    "core.hookspath",
    "core.sshcommand",
    "core.fsmonitor",
    "core.pager",
    "core.editor",
    "core.askpass",
    "core.gitproxy",
    "help.autocorrect",
    "sequence.editor",
    "diff.external",
    "commit.gpgsign",
];

/// Variables that name a program or script the next command runs (pager, editor, shell startup file).
const LOADER_ENV_EXACT: &[&str] = &["PAGER", "EDITOR", "VISUAL", "BASH_ENV", "ENV", "BROWSER", "PROMPT_COMMAND", "SHELLOPTS", "BASHOPTS", "PS4"];
const GIT_ENV_EXACT: &[&str] = &[
    "GIT_SSH_COMMAND",
    "GIT_SSH",
    "GIT_EXEC_PATH",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_EDITOR",
    "GIT_SEQUENCE_EDITOR",
    "GIT_EXTERNAL_DIFF",
    "GIT_PAGER",
    "GIT_PROXY_COMMAND",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
];

/// Variables that make an interpreter load code from the environment (they cannot remove the git shim, so they are not hard stops;
/// Automatic refuses them as `exec.auto.env-override`).
const INTERPRETER_LOADER_ENV: &[&str] = &["NODE_OPTIONS", "NODE_PATH", "RUBYOPT", "RUBYLIB", "PERLLIB", "TMPDIR", "CLASSPATH", "JAVA_TOOL_OPTIONS"];
const INTERPRETER_LOADER_PREFIXES: &[&str] = &["PYTHON", "PERL5"];

const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "fish", "csh", "tcsh", "su"];
const FS_MUTATORS: &[&str] = &[
    "rm", "rmdir", "mv", "cp", "ln", "tee", "touch", "chmod", "chown", "chgrp", "truncate", "dd", "install", "mkdir", "rsync", "patch",
    "unlink", "shred", "sponge", "curl", "wget", "vi", "vim", "nvim", "nano", "ed", "ex", "emacs", "sed", "perl",
    "tar", "bsdtar", "gtar", "unzip", "ditto", "pax", "cpio",
];
/// Commands that copy or link a file: copying the git binary under another name defeats name-based checks.
const COPIERS: &[&str] = &["cp", "ln", "mv", "install", "rsync", "ditto", "dd"];
/// Readers whose output, redirected into a file, makes a copy of the git binary under another name.
const STREAM_COPIERS: &[&str] = &["cat", "head", "tail", "pv", "gzcat", "zcat", "base64", "xxd"];
/// Longest command string analysed; the walker is quadratic on some pathological nestings.
const MAX_COMMAND_LEN: usize = 64 * 1024;
/// Real git binaries on this machine, for recognising a renamed copy by content.
const GIT_BINARIES: &[&str] = &["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git", "/Library/Developer/CommandLineTools/usr/bin/git"];
/// Programs that run another command line somewhere else (remote shell, container, multiplexer).
const REMOTE_RUNNERS: &[&str] = &["ssh", "docker", "podman", "kubectl", "tmux", "screen", "script", "watch", "at", "batch", "crontab", "limactl", "orb", "multipass", "lldb", "gdb"];
/// Package and version managers that run `<tool> exec|run|x [--] <command>`.
const TOOL_RUNNERS: &[&str] = &["mise", "rtx", "asdf", "volta", "bundle", "poetry", "uv", "pipenv", "pdm", "rye", "hatch", "devbox", "op", "doppler", "dotenvx", "fnm", "rbenv", "pyenv"];
const INTERPRETERS: &[&str] = &["node", "nodejs", "ruby", "perl", "php", "deno", "osascript", "lua", "bun", "awk", "gawk", "mawk", "nawk", "expect", "tclsh"];
const INLINE_GIT_VERBS: &[&str] = &["commit", "push", "update-ref", "cherry-pick", "rebase", "commit-tree", "merge", "reset", "revert"];
const PM_PUBLISH: &[&str] = &["publish", "unpublish", "deprecate", "dist-tag", "owner", "access", "token", "login"];

#[derive(Clone, Default)]
struct Ctx {
    /// Script fed on stdin by a heredoc or here-string.
    stdin_script: Option<String>,
    piped: bool,
    /// Extra arguments arrive from stdin (`xargs`, `find -exec`).
    xargs: bool,
    /// A `<` redirect feeds a file to this command (an upload when the command is a network client).
    stdin_file: bool,
}

struct Walker<'a> {
    jail: &'a Jail,
    cwd: PathBuf,
    cwd_known: bool,
    alias_depth: usize,
    /// `alias name=value` seen earlier in the script (non-interactive shells need `expand_aliases`; assumed on).
    shell_aliases: std::collections::HashMap<String, String>,
    /// The `-I`/`-J` replace string of the xargs or parallel being peeled: it stands for words from stdin.
    repl: Option<String>,
    /// The script being walked (a substitution's body is judged on its own, so a computed word only has this).
    src: String,
    /// Scripts being resolved right now (a script that runs itself is judged once).
    script_stack: Vec<String>,
    /// Directory of the non-shell script whose text is being scanned (relative `..` tokens in it are judged from there).
    script_dir: Option<PathBuf>,
    /// Variables the string assigned from words it knows (`f=src/a.js`, the variable of a `for` over known words): `$f` later in the
    /// string is read as the value. Only a plain sequence of commands is followed (see `const_prop_ok`); anything else stays unknown.
    vars: std::collections::HashMap<String, String>,
    /// Commands walked for loop iterations so far: the work a loop may cost is bounded.
    loop_work: usize,
    a: Analysis,
}

impl<'a> Walker<'a> {
    fn new(jail: &'a Jail) -> Self {
        Self { jail, cwd: jail.cwd.clone(), cwd_known: true, alias_depth: 0, shell_aliases: Default::default(), repl: None, src: String::new(), script_stack: Vec::new(), script_dir: None, vars: Default::default(), loop_work: 0, a: Analysis::default() }
    }

    fn stop(&mut self, rule: &str, reason: &str) {
        if self.a.hard_stop.is_none() {
            self.a.hard_stop = Some(HardStop { rule: rule.to_string(), reason: reason.to_string() });
        }
    }

    fn issue(&mut self, why: &str) {
        if !self.a.issues.iter().any(|i| i == why) {
            self.a.issues.push(why.to_string());
        }
    }

    fn script(&mut self, src: &str, depth: usize) {
        if depth > MAX_DEPTH {
            self.issue("nesting too deep");
            return;
        }
        self.wrangler_script_text(src);
        let s = shellparse::parse(src);
        for i in &s.issues {
            self.issue(&i.to_string());
        }
        let outer = std::mem::replace(&mut self.src, src.to_string());
        // a nested script (`sh -c`, a script file, a trap) starts without the variables of the shell around it
        let outer_vars = (depth > 0).then(|| std::mem::take(&mut self.vars));
        if depth == 0 {
            for cmd in s.commands.iter().filter(|c| !c.nested && !vars::is_marker(c)) {
                self.a.simple.push(cmd.words.clone());
            }
        }
        let track = vars::const_prop_ok(&s.commands, s.grouped);
        self.walk(&s.commands, depth, track);
        if let Some(v) = outer_vars {
            self.vars = v;
        }
        self.src = outer;
    }

    fn command(&mut self, cmd: &Command, depth: usize) {
        for (name, _) in &cmd.assigns {
            self.check_env(name);
            self.a.has_assigns = true;
        }
        for r in cmd.redirects.iter().filter(|r| r.writes_file()) {
            self.a.redirects_write = true;
            self.write_target(&r.target);
        }
        for r in cmd.redirects.iter().filter(|r| !matches!(r.kind, RedirKind::HereDoc | RedirKind::HereString)) {
            self.redirect_fact(&r.target);
        }
        self.a.write_redirects.extend(cmd.redirects.iter().filter(|r| r.writes_file()).map(|r| r.target.clone()));
        self.a.read_redirects.extend(cmd.redirects.iter().filter(|r| r.kind == RedirKind::Read).map(|r| r.target.clone()));
        self.wrangler_command(cmd);
        if cmd.words.is_empty() {
            return;
        }
        if cmd.redirects.iter().any(|r| r.writes_file()) && !cmd.words[0].dynamic && STREAM_COPIERS.contains(&base_name(&cmd.words[0].text).as_str()) && cmd.words[1..].iter().any(|w| self.is_git_source(w)) {
            self.stop("git.binary-copy", "writing the git binary to a file would hide it from name-based checks");
            return;
        }
        let stdin_script = cmd
            .redirects
            .iter()
            .find(|r| matches!(r.kind, RedirKind::HereDoc | RedirKind::HereString))
            .and_then(|r| r.body.clone());
        let stdin_file = cmd.redirects.iter().any(|r| matches!(r.kind, RedirKind::Read | RedirKind::ReadWrite));
        self.exec(&cmd.words, depth, &Ctx { stdin_script, piped: cmd.piped_from_prev, xargs: false, stdin_file });
    }

    /// Variables that change git identity, config or target, or unlock the human-only token.
    fn check_env(&mut self, name: &str) {
        let n = name.to_ascii_uppercase();
        if wrangler::is_cf_secret_env(&n) {
            self.cf_stop("wrangler.env", &format!("sets {n}, a Cloudflare or wrangler token, account or path variable"));
        } else if n.starts_with("GIT_CONFIG") || n.starts_with("GIT_AUTHOR_") || n.starts_with("GIT_COMMITTER_") || GIT_ENV_EXACT.contains(&n.as_str()) || n == "INTELY_HUMAN_TOKEN" {
            self.stop("env.git-override", &format!("sets {n}, which changes git identity, config or target"));
        } else if n.starts_with("GIT_") || n.starts_with("LD_") || n.starts_with("DYLD_") || LOADER_ENV_EXACT.contains(&n.as_str()) {
            self.stop("env.loader-override", &format!("sets {n}, which makes git or the loader run other code"));
        } else if matches!(n.as_str(), "PATH" | "HOME" | "ZDOTDIR" | "SHELL") || n.starts_with("XDG_") {
            self.stop("env.path-override", &format!("sets {n}, which changes where the shell finds git or its configuration and removes the git shim"));
        } else if INTERPRETER_LOADER_ENV.contains(&n.as_str()) || INTERPRETER_LOADER_PREFIXES.iter().any(|p| n.starts_with(p)) {
            if !self.a.env_overrides.contains(&n) {
                self.a.env_overrides.push(n);
            }
        }
    }

    fn write_target(&mut self, word: &Word) {
        if word.dynamic {
            self.issue("dynamic write target");
            return;
        }
        if word.text.is_empty() {
            return;
        }
        if !self.cwd_known && !word.text.starts_with('/') && !word.text.starts_with('~') {
            self.issue("relative path after a cd that could not be followed");
            return;
        }
        let p = paths::resolve(&self.cwd, &word.text, self.jail.home.as_deref());
        if let Some(why) = self.jail.protected_reason(&p) {
            self.stop("fs.protected", &format!("writes {why}"));
        } else {
            self.note_exec_surface(&p, &word.text);
        }
    }

    /// Records a write to a file that executes code (hooks, lint-staged, `package.json` scripts, tool configs, CI).
    pub(super) fn note_exec_surface(&mut self, resolved: &Path, shown: &str) {
        if self.jail.exec_surface_reason(resolved).is_some() && !self.a.exec_surface_writes.iter().any(|x| x == shown) {
            self.a.exec_surface_writes.push(shown.to_string());
        }
    }

    fn exec(&mut self, words: &[Word], depth: usize, ctx: &Ctx) {
        if self.a.hard_stop.is_some() {
            return;
        }
        let Some(first) = words.first() else { return };
        if first.dynamic || first.glob {
            self.wrangler_unknown_command(first);
            self.issue("command name is not known statically");
            return;
        }
        if first.text.contains('/') {
            self.probe(&first.text);
        }
        if let Some(value) = self.shell_aliases.get(&first.text).cloned().filter(|_| self.alias_depth < 4) {
            let mut expanded = shellparse::split_words(&value);
            expanded.extend_from_slice(&words[1..]);
            self.alias_depth += 1;
            self.exec(&expanded, depth, ctx);
            self.alias_depth -= 1;
            return;
        }
        let mut base = base_name(&first.text);
        // `git-core/git-push` is the git binary itself and dispatches on its name: it stays `git-push`.
        if base != "git" && !base.starts_with("git-") && first.text.contains('/') && self.is_git_copy(&first.text) {
            base = "git".to_string();
        }

        self.wrangler_pre(&base, words, depth);
        if self.a.hard_stop.is_some() {
            return;
        }
        self.proc_env(&base, words);
        if self.a.hard_stop.is_some() {
            return;
        }
        if let Some((inner, xargs)) = self.peel(&base, words) {
            for w in &words[1..words.len().saturating_sub(inner.len()).max(1)] {
                self.probe_wrapper_word(w);
            }
            self.wrangler_wrapper(&words[1..words.len().saturating_sub(inner.len()).max(1)], inner.is_empty(), ctx.xargs || xargs);
            if self.a.hard_stop.is_some() {
                return;
            }
            if depth >= MAX_DEPTH {
                self.issue("nesting too deep");
                return;
            }
            if !inner.is_empty() {
                self.exec(&inner, depth + 1, &Ctx { xargs: ctx.xargs || xargs, ..ctx.clone() });
            }
            return;
        }
        self.wrangler_leaf(&base, first, words, ctx);
        if self.a.hard_stop.is_some() {
            return;
        }
        self.leaf_facts(&base, words, ctx);
        if self.a.hard_stop.is_some() {
            return;
        }
        match base.as_str() {
            b if SHELLS.contains(&b) => self.shell(b == "su", words, depth, ctx),
            "eval" => {
                self.issue("eval");
                let joined = words[1..].iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
                self.script(&joined, depth + 1);
            }
            "git" => self.git(words, ctx),
            b if b.starts_with("git-") => {
                let mut synth = vec![Word::lit("git"), Word::lit(&b[4..])];
                synth.extend_from_slice(&words[1..]);
                self.git(&synth, ctx);
            }
            "gh" => self.gh(words),
            "security" | "osascript" | "dscl" => self.stop("exec.system-secrets", &format!("{base} reaches the Keychain, user accounts or system scripting: human-only")),
            "export" | "declare" | "typeset" | "readonly" | "local" => {
                for w in &words[1..] {
                    if let Some((name, _)) = w.text.split_once('=') {
                        self.check_env(name);
                    }
                }
            }
            "alias" => {
                if words[1..].iter().any(|w| mentions_git_write(&w.text)) {
                    self.stop("alias.git-write", "alias that runs a git write command");
                }
                for w in &words[1..] {
                    if let Some((name, value)) = w.text.split_once('=').filter(|_| !w.dynamic) {
                        self.shell_aliases.insert(name.to_string(), value.to_string());
                    }
                }
            }
            "trap" => {
                // `trap 'cmd' SIGNAL`: the first operand runs later, in this shell.
                if let Some(action) = words[1..].iter().find(|w| !w.text.starts_with('-') || w.text == "-").filter(|w| w.text != "-") {
                    if action.dynamic {
                        self.issue("trap action is not known statically");
                    } else {
                        self.script(&action.text.clone(), depth + 1);
                    }
                }
            }
            "tar" | "bsdtar" | "gtar" | "rsync" | "zip" | "scp" | "sftp" => {
                // Options whose value is a command line the program runs.
                let runs: &[(&[&str], &[&str])] = match base.as_str() {
                    "rsync" => &[(&["-e"], &["rsh", "rsync-path"])],
                    "zip" => &[(&["-TT"], &["unzip-command"])],
                    "scp" | "sftp" => &[(&["-S"], &[])],
                    _ => &[(&["-I", "-F"], &["to-command", "checkpoint-action", "use-compress-program", "rsh-command", "info-script", "new-volume-script"])],
                };
                for (short, long) in runs {
                    for value in option_values(words, short, long) {
                        self.script(value.strip_prefix("exec=").unwrap_or(&value), depth + 1);
                    }
                }
            }
            "at" | "batch" => {
                if let Some(body) = &ctx.stdin_script {
                    self.script(&body.clone(), depth + 1);
                }
            }
            "cd" | "pushd" => self.cd(words),
            "popd" => {
                self.cwd_known = false;
                if self.script_stack.is_empty() {
                    self.issue("popd goes to a directory that is not known statically");
                }
            }
            "find" => self.find(words, depth, ctx),
            _ => {}
        }
        if self.a.hard_stop.is_some() {
            return;
        }
        self.publish_and_inline(&base, words, ctx);
        if FS_MUTATORS.contains(&base.as_str()) {
            self.fs_mutator(&base, words);
        }
        if self.a.hard_stop.is_some() {
            return;
        }
        // Any tool that names a protected path is a hard stop unless it only reads (sort -o, awk -i inplace, xxd -r, ...).
        if base != "git" && !base.starts_with("git-") {
            self.protected_args(&base, words);
        }
        self.script_indirection(&base, first, words, depth);
    }

    /// Wrappers: returns the inner command (empty when there is none) and whether stdin supplies arguments.
    fn peel(&mut self, base: &str, words: &[Word]) -> Option<(Vec<Word>, bool)> {
        let skip_from = |start: usize, with_arg: &[&str]| -> usize {
            let mut i = start;
            while let Some(w) = words.get(i) {
                let t = w.text.as_str();
                if t == "--" {
                    return i + 1;
                }
                if !t.starts_with('-') || t == "-" {
                    return i;
                }
                i += if with_arg.contains(&t) { 2 } else { 1 };
            }
            i
        };
        let skip = |with_arg: &[&str]| skip_from(1, with_arg);
        let rest = |i: usize| words.get(i..).map(<[Word]>::to_vec).unwrap_or_default();
        Some(match base {
            "env" => {
                let mut i = 1;
                while let Some(w) = words.get(i) {
                    let t = w.text.as_str();
                    if t == "--" {
                        i += 1;
                        break;
                    }
                    let split = if t == "-S" || t == "--split-string" {
                        Some((words.get(i + 1).map(|w| w.text.clone()).unwrap_or_default(), 2))
                    } else if t.len() > 2 && t.starts_with("-S") {
                        Some((t[2..].to_string(), 1))
                    } else {
                        None
                    };
                    if let Some((value, consumed)) = split {
                        let mut inner = shellparse::split_words(&value);
                        inner.extend(rest(i + consumed));
                        return Some((inner, false));
                    }
                    if t.starts_with('-') {
                        if env_option_overrides_path(t, words.get(i + 1).map(|w| w.text.as_str())) {
                            self.stop("env.path-override", "env clears or replaces the environment or the search path, which removes the git shim");
                        }
                        i += if matches!(t, "-u" | "-C" | "--unset" | "--chdir") { 2 } else { 1 };
                    } else if let Some((name, _)) = t.split_once('=') {
                        self.check_env(name);
                        i += 1;
                    } else {
                        break;
                    }
                }
                (rest(i), false)
            }
            "command" => {
                let mut i = 1;
                while let Some(w) = words.get(i).map(|w| w.text.as_str()).filter(|t| t.starts_with('-') && *t != "-") {
                    if w[1..].chars().any(|c| c == 'v' || c == 'V') {
                        return Some((Vec::new(), false));
                    }
                    if !w.starts_with("--") && w[1..].contains('p') {
                        self.stop("env.path-override", "command -p searches a default PATH, which skips the git shim");
                    }
                    i += 1;
                }
                (rest(i), false)
            }
            "builtin" => (rest(1), false),
            "exec" => {
                if words[1..].iter().take_while(|w| w.text.starts_with('-') && w.text != "--").any(|w| !w.text.starts_with("--") && w.text[1..].contains('c')) {
                    self.stop("env.path-override", "exec -c clears the environment, which removes the git shim");
                }
                (rest(skip(&["-a"])), false)
            }
            "nohup" | "setsid" | "unbuffer" => (rest(skip(&[])), false),
            "time" => (rest(skip(&["-f", "-o"])), false),
            "nice" | "gnice" => (rest(skip(&["-n", "--adjustment"])), false),
            "ionice" => (rest(skip(&["-c", "-n", "-p", "-P", "-u"])), false),
            "timeout" | "gtimeout" => (rest(skip(&["-k", "-s", "--kill-after", "--signal"]) + 1), false),
            "stdbuf" => (rest(skip(&["-i", "-o", "-e"])), false),
            "caffeinate" => (rest(skip(&["-t", "-w"])), false),
            "arch" => (rest(skip(&["-e"])), false),
            "xcrun" => (rest(skip(&["-sdk", "--sdk", "--toolchain", "-toolchain"])), false),
            "sudo" => (rest(skip(&["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U", "--user", "--group"])), false),
            "doas" => (rest(skip(&["-u", "-C"])), false),
            "xargs" | "parallel" => {
                self.repl = words.iter().enumerate().find_map(|(i, w)| {
                    let t = w.text.as_str();
                    match t {
                        "-I" | "-J" => words.get(i + 1).map(|n| n.text.clone()),
                        "-i" | "--replace" => Some("{}".to_string()),
                        _ => t.strip_prefix("--replace=").or_else(|| t.strip_prefix("-I")).or_else(|| t.strip_prefix("-J")).filter(|v| !v.is_empty()).map(str::to_string),
                    }
                }).or_else(|| (base == "parallel").then(|| "{}".to_string()));
                (rest(skip(&["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "-J", "-j", "-N", "-S", "--jobs", "--sshlogin", "--arg-file"])), true)
            }
            "chroot" => (rest(skip(&["--userspec", "--groups"]) + 1), false),
            "entr" => (rest(skip(&[])), false),
            "dtruss" => (rest(skip(&["-p", "-n", "-t", "-f", "-o"])), false),
            "flock" => (rest(skip(&["-w", "-E", "--wait", "--timeout", "--conflict-exit-code"]) + 1), false),
            "gosu" | "su-exec" => (rest(2), false),
            "pkexec" => (rest(skip(&["--user"])), false),
            "sandbox-exec" => (rest(skip(&["-f", "-p", "-n", "-D"])), false),
            "launchctl" if words.get(1).is_some_and(|w| w.text == "submit") => (rest(words.iter().position(|w| w.text == "--").map_or(words.len(), |p| p + 1)), false),
            "open" if words.iter().any(|w| w.text == "--args") => (rest(words.iter().position(|w| w.text == "--args").map_or(words.len(), |p| p + 1)), false),
            "direnv" if words.get(1).is_some_and(|w| w.text == "exec") => (rest(skip_from(2, &[]) + 1), false),
            b if TOOL_RUNNERS.contains(&b) => {
                let at = words[1..].iter().position(|w| !w.text.starts_with('-'))? + 1;
                if !matches!(words[at].text.as_str(), "exec" | "run" | "x") {
                    return None;
                }
                (rest(skip_from(at + 1, &[])), false)
            }
            "nix-shell" | "nix" if words.iter().any(|w| matches!(w.text.as_str(), "--run" | "--command" | "-c")) => {
                let at = words.iter().position(|w| matches!(w.text.as_str(), "--run" | "--command" | "-c"))? + 1;
                if base == "nix-shell" {
                    (vec![Word::lit("sh"), Word::lit("-c"), words.get(at)?.clone()], false)
                } else {
                    (rest(at), false)
                }
            }
            "corepack" => (rest(skip(&[])), false),
            "npx" | "bunx" | "pnpx" => match call_string(words, 1) {
                Some(script) => (vec![Word::lit("sh"), Word::lit("-c"), script], false),
                None => (rest(skip(&["-p", "--package"])), false),
            },
            "npm" | "pnpm" | "yarn" | "bun" => {
                let at = words[1..].iter().position(|w| !w.text.starts_with('-'))? + 1;
                if !matches!(words[at].text.as_str(), "exec" | "dlx" | "x") {
                    return None;
                }
                match call_string(words, at + 1) {
                    Some(script) => (vec![Word::lit("sh"), Word::lit("-c"), script], false),
                    None => (rest(skip_from(at + 1, &["-p", "--package"])), false),
                }
            }
            _ => return None,
        })
    }

    fn shell(&mut self, is_su: bool, words: &[Word], depth: usize, ctx: &Ctx) {
        let mut i = 1;
        // `su user -c cmd`: the options may follow the user name
        let mut script_at = if is_su { words.iter().position(|w| w.text == "-c").map(|p| p + 1) } else { None };
        let mut reads_stdin = false;
        let mut has_c = false;
        // Options run up to the first operand; with `-c` that operand is the script (`bash -c -- 'x'`, `bash -c -x 'x'`).
        while script_at.is_none() {
            let Some(w) = words.get(i) else { break };
            let t = w.text.as_str();
            if t == "--" {
                i += 1;
                break;
            }
            if t.starts_with("--") {
                i += if matches!(t, "--rcfile" | "--init-file") { 2 } else { 1 };
            } else if (t.starts_with('-') || t.starts_with('+')) && t.len() > 1 {
                let letters = &t[1..];
                has_c |= t.starts_with('-') && letters.contains('c');
                reads_stdin |= t.starts_with('-') && letters.contains('s');
                i += if letters.ends_with('o') || letters.ends_with('O') { 2 } else { 1 };
            } else {
                break;
            }
        }
        if has_c && script_at.is_none() {
            script_at = Some(i);
        }
        if ctx.xargs {
            self.issue("command text may come from stdin");
        }
        if let Some(at) = script_at {
            match words.get(at) {
                Some(w) if w.dynamic => self.issue("shell -c script is not known statically"),
                Some(w) => self.script(&w.text.clone(), depth + 1),
                None => {}
            }
            return;
        }
        let has_file = words.get(i).is_some();
        if let Some(body) = &ctx.stdin_script {
            self.script(&body.clone(), depth + 1);
        } else if reads_stdin || (!has_file && ctx.piped) {
            self.issue("shell reads its script from stdin");
        }
    }

    fn git(&mut self, words: &[Word], ctx: &Ctx) {
        let mut i = 1;
        let mut sub_at = None;
        while let Some(w) = words.get(i) {
            if w.dynamic {
                self.issue("git option or subcommand is not known statically");
                return;
            }
            let t = w.text.as_str();
            match t {
                "-C" | "--git-dir" | "--work-tree" | "--namespace" | "--attr-source" | "--super-prefix" => i += 2,
                "-c" | "--config-env" => {
                    match words.get(i + 1) {
                        Some(kv) if kv.dynamic => self.issue("git -c key is not known statically"),
                        Some(kv) => self.config_key(kv.text.split('=').next().unwrap_or(""), "git -c"),
                        None => {}
                    }
                    i += 2;
                }
                _ if t.starts_with("--config-env=") => {
                    self.config_key(t["--config-env=".len()..].split('=').next().unwrap_or(""), "git --config-env");
                    i += 1;
                }
                _ if t.starts_with('-') => i += 1,
                _ => {
                    sub_at = Some(i);
                    break;
                }
            }
        }
        let Some(at) = sub_at else {
            if ctx.xargs {
                self.stop("git.xargs", "git subcommand would come from stdin");
            }
            return;
        };
        let sub = words[at].text.to_ascii_lowercase();
        if ctx.xargs && self.repl.as_deref().is_some_and(|r| sub.contains(&r.to_ascii_lowercase())) {
            self.stop("git.xargs", "git subcommand would come from stdin");
            return;
        }
        let args = &words[at + 1..];
        self.git_options(args);
        if !protected_args::GIT_PATH_SAFE.contains(&sub.as_str()) {
            self.protected_args("git", args);
        }
        self.git_alias(&sub, args, ctx);
        if self.a.hard_stop.is_some() {
            return;
        }
        if GIT_HARD_VERBS.contains(&sub.as_str()) && !is_listing(&sub, args) {
            self.stop(&format!("git.{sub}"), &format!("git {sub} is human-only"));
            return;
        }
        if sub.starts_with("credential") {
            self.stop("git.credential", "git credential helpers hand out stored secrets");
            return;
        }
        match sub.as_str() {
            "reset" if args.iter().any(|a| long_opt(&a.text, "hard", 2)) => self.stop("git.reset-hard", "git reset --hard is human-only"),
            "add" | "stage" => self.git_add(args, ctx),
            "lfs" if args.iter().find(|a| !a.text.starts_with('-')).is_some_and(|a| matches!(a.text.as_str(), "push" | "migrate")) => {
                self.stop("git.lfs-push", "git lfs push uploads to the remote");
            }
            "stash" => {
                let first = args.first().map(|a| a.text.as_str());
                let moves = match first {
                    None => true,
                    Some(f) if f.starts_with('-') => true,
                    Some(f) => matches!(f, "push" | "save" | "drop" | "pop" | "clear" | "create" | "store" | "branch"),
                };
                if moves {
                    self.stop("git.stash", "git stash push/drop/pop rewrites the working tree and stash list");
                }
            }
            "branch" => {
                let risky = args.iter().any(|a| {
                    let t = a.text.as_str();
                    if let Some(letters) = t.strip_prefix('-').filter(|l| !l.starts_with('-')) {
                        letters.chars().any(|c| "dDmMfcCu".contains(c))
                    } else {
                        ["delete", "move", "force", "copy", "set-upstream-to", "unset-upstream", "edit-description"].iter().any(|l| long_opt(t, l, 2))
                    }
                });
                if risky {
                    self.stop("git.branch", "git branch delete/move/force/upstream changes refs");
                }
            }
            "checkout" | "switch" => {
                let force_create = args.iter().any(|a| {
                    let t = a.text.as_str();
                    match t.strip_prefix('-').filter(|l| !l.starts_with('-')) {
                        Some(letters) => letters.contains(if sub == "checkout" { 'B' } else { 'C' }),
                        None => long_opt(t, "force-create", 7),
                    }
                });
                if force_create {
                    self.stop("git.branch", "git checkout -B / switch -C resets a branch pointer");
                }
            }
            "remote" => {
                let first = args.iter().find(|a| !a.text.starts_with('-')).map(|a| a.text.as_str());
                if matches!(first, Some("add" | "set-url" | "remove" | "rm" | "rename" | "set-head" | "set-branches" | "prune")) {
                    self.stop("git.remote", "git remote changes where pushes go");
                }
            }
            "reflog" => {
                if matches!(args.first().map(|a| a.text.as_str()), Some("expire" | "delete")) {
                    self.stop("git.reflog", "git reflog expire/delete destroys recovery points");
                }
            }
            "symbolic-ref" => {
                let positional = args.iter().filter(|a| !a.text.starts_with('-')).count();
                if positional >= 2 || args.iter().any(|a| a.text == "-d" || long_opt(&a.text, "delete", 2)) {
                    self.stop("git.symbolic-ref", "git symbolic-ref write moves HEAD");
                }
            }
            "config" => self.git_config(args),
            "submodule" if args.first().is_some_and(|a| a.text == "foreach") => {
                let script = args[1..].iter().filter(|w| !w.text.starts_with('-')).map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
                self.issue("git submodule foreach runs a shell command");
                self.script(&script, 1);
            }
            "bisect" if args.first().is_some_and(|a| a.text == "run") => self.exec(&args[1..], 1, &Ctx::default()),
            _ => {}
        }
    }

    /// Options that run a program or write a file wherever they appear.
    fn git_options(&mut self, args: &[Word]) {
        let mut i = 0;
        while i < args.len() {
            let t = args[i].text.as_str();
            if t == "--" {
                break;
            }
            if long_opt(t, "upload-pack", 3) || long_opt(t, "receive-pack", 3) || long_opt(t, "exec", 3) || long_opt(t, "ssh-command", 3) {
                self.stop("git.exec-option", "git option that runs another program");
                return;
            }
            let output = if t == "-o" || t == "--output" {
                i += 1;
                args.get(i)
            } else {
                None
            };
            let inline = t.strip_prefix("--output=");
            if let Some(path) = output.map(|w| w.text.as_str()).or(inline) {
                self.write_target(&Word::lit(path));
            }
            i += 1;
        }
    }

    fn config_key(&mut self, key: &str, via: &str) {
        let k = key.to_ascii_lowercase();
        if DANGEROUS_KEY_PREFIXES.iter().any(|p| k.starts_with(p)) || DANGEROUS_KEYS.contains(&k.as_str()) {
            self.stop("git.config", &format!("{via} {key} changes identity, executes commands or redirects remotes"));
        }
    }

    fn git_config(&mut self, args: &[Word]) {
        const READ_FLAGS: &[&str] = &["get", "get-all", "get-regexp", "list", "get-urlmatch", "get-color"];
        const WRITE_FLAGS: &[&str] = &["add", "replace-all", "unset", "unset-all", "rename-section", "remove-section", "edit"];
        let is_flag = |a: &Word, set: &[&str]| {
            let t = a.text.as_str();
            set.iter().any(|f| t == format!("--{f}") || (t.starts_with("--") && t.len() > 3 && f.starts_with(&t[2..])))
        };
        let mut it = args.iter();
        while let Some(a) = it.next() {
            let target = match a.text.as_str() {
                "-f" | "--file" => it.next().map(|w| w.text.clone()),
                t => t.strip_prefix("--file=").map(str::to_string),
            };
            if let Some(path) = target {
                self.write_target(&Word::lit(&path));
            }
        }
        if self.a.hard_stop.is_some() || args.iter().any(|a| is_flag(a, &READ_FLAGS) || a.text == "-l") {
            return;
        }
        let writes = args.iter().any(|a| is_flag(a, &WRITE_FLAGS) || a.text == "-e");
        let positional: Vec<&Word> = args.iter().filter(|a| !a.text.starts_with('-')).collect();
        if let Some(key) = positional.first() {
            if key.dynamic {
                self.issue("git config key is not known statically");
            } else if writes || positional.len() >= 2 {
                self.config_key(&key.text, "git config");
            }
        } else if writes {
            self.stop("git.config", "git config --edit");
        }
    }

    fn git_add(&mut self, args: &[Word], ctx: &Ctx) {
        if ctx.xargs {
            self.stop("git.add-xargs", "git add with paths from stdin could stage everything");
            return;
        }
        let mut after_dd = false;
        for a in args {
            if a.dynamic {
                self.issue("git add argument is not known statically");
                continue;
            }
            let t = a.text.as_str();
            if !after_dd && t == "--" {
                after_dd = true;
                continue;
            }
            if !after_dd && t.starts_with("--") {
                if long_opt(t, "all", 1) {
                    self.stop("git.add-all", "git add --all stages everything");
                } else if t.starts_with("--pathspec-") {
                    self.stop("git.add-pathspec-file", "git add --pathspec-from-file hides the paths");
                }
                continue;
            }
            if !after_dd && t.starts_with('-') && t.len() > 1 {
                if t[1..].contains('A') {
                    self.stop("git.add-all", "git add -A stages everything");
                }
                continue;
            }
            if a.glob || t.contains(['*', '?', '[']) {
                self.stop("git.add-glob", "git add with a glob pathspec can stage unintended files");
            } else if t.starts_with(':') {
                self.stop("git.add-magic", "git add with pathspec magic can stage unintended files");
            } else if self.is_tree_root(t) {
                self.stop("git.add-root", "git add of the whole tree");
            }
        }
    }

    /// The pathspec names the working directory or one of its ancestors.
    fn is_tree_root(&self, text: &str) -> bool {
        let lexical = paths::normalize_lexical(Path::new(text));
        if lexical.as_os_str().is_empty() || lexical.components().all(|c| matches!(c, std::path::Component::ParentDir)) && !lexical.is_absolute() {
            return true;
        }
        self.cwd_known && self.cwd.starts_with(paths::resolve(&self.cwd, text, self.jail.home.as_deref()))
    }

    fn gh(&mut self, words: &[Word]) {
        let mut pos: Vec<String> = Vec::new();
        let mut flags: Vec<&str> = Vec::new();
        let mut i = 1;
        while let Some(w) = words.get(i) {
            if w.dynamic {
                self.issue("gh argument is not known statically");
                return;
            }
            let t = w.text.as_str();
            if t.starts_with('-') {
                flags.push(t);
                i += if matches!(t, "-R" | "--repo" | "--hostname") { 2 } else { 1 };
            } else {
                pos.push(t.to_ascii_lowercase());
                i += 1;
            }
        }
        let group = pos.first().map(String::as_str).unwrap_or("");
        let action = pos.get(1).map(String::as_str).unwrap_or("");
        let hit = match group {
            "repo" | "release" | "auth" | "secret" | "ssh-key" | "gpg-key" => true,
            "pr" => matches!(action, "merge" | "create" | "close" | "reopen" | "review"),
            "workflow" => matches!(action, "run" | "enable" | "disable"),
            "alias" => matches!(action, "set" | "import" | "delete"),
            "config" => action == "set",
            "api" => flags.iter().any(|f| {
                matches!(*f, "-f" | "-F" | "--field" | "--raw-field" | "--input")
                    || f.starts_with("--input=")
                    || f.starts_with("--field=")
                    || f.starts_with("--raw-field=")
            }) || self.gh_api_method_writes(words),
            _ => false,
        };
        if hit {
            self.stop(&format!("gh.{group}"), &format!("gh {} publishes or changes remote state", [group, action].join(" ").trim()));
        }
    }

    fn gh_api_method_writes(&self, words: &[Word]) -> bool {
        let mut it = words.iter().map(|w| w.text.as_str());
        while let Some(t) = it.next() {
            let value = match t {
                "-X" | "--method" => it.next(),
                _ => t.strip_prefix("--method=").or_else(|| t.strip_prefix("-X").filter(|v| !v.is_empty())),
            };
            if let Some(v) = value {
                if !v.eq_ignore_ascii_case("GET") && !v.eq_ignore_ascii_case("HEAD") {
                    return true;
                }
            }
        }
        false
    }

    fn publish_and_inline(&mut self, base: &str, words: &[Word], ctx: &Ctx) {
        let positionals = || words[1..].iter().filter(|w| !w.text.starts_with('-')).map(|w| w.text.to_ascii_lowercase());
        let publishes = match base {
            "npm" | "pnpm" | "yarn" | "bun" | "cnpm" => positionals().take(4).any(|p| PM_PUBLISH.contains(&p.as_str())),
            "cargo" => positionals().next().is_some_and(|p| matches!(p.as_str(), "publish" | "yank" | "login" | "owner")),
            "twine" => positionals().next().is_some_and(|p| matches!(p.as_str(), "upload" | "register")),
            "gem" => positionals().next().is_some_and(|p| matches!(p.as_str(), "push" | "yank" | "owner" | "signin")),
            "poetry" | "uv" | "hatch" | "flit" => positionals().next().is_some_and(|p| p == "publish"),
            _ => false,
        };
        if publishes {
            self.stop("pm.publish", &format!("{base} publish/login changes a package registry"));
            return;
        }
        if REMOTE_RUNNERS.contains(&base) {
            let mut line = words[1..].iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
            line.push(' ');
            line.push_str(ctx.stdin_script.as_deref().unwrap_or(""));
            if mentions_git_write(&line) {
                self.stop("remote.git-write", &format!("{base} would run a git write command elsewhere"));
            }
        }
        if matches!(base, "sed" | "gsed") {
            let code = words[1..].iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
            if mentions_git_write(&code) && sed_runs_commands(&code) {
                self.stop("inline.git-write", "sed script that runs a git write command");
            }
        }
        if INTERPRETERS.contains(&base) || base.starts_with("python") {
            let mut code = words[1..].iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
            code.push(' ');
            code.push_str(ctx.stdin_script.as_deref().unwrap_or(""));
            if mentions_git_write(&code) {
                self.stop("inline.git-write", &format!("{base} code that runs a git write command"));
            } else if words.len() == 1 && ctx.piped {
                self.issue("interpreter reads its code from stdin");
            }
        }
    }

    /// A word that names the git executable (or a link to it), wherever it lives outside the working directories.
    fn names_git_binary(&self, w: &Word) -> bool {
        let is_git = |n: &str| n == "git" || (n.starts_with("git-") && !n.contains('.'));
        if w.dynamic {
            // `$(which git)`, `$(command -v git)`: the source is computed (the word is only `$()`), but the script asks for git.
            return format!("{} {}", w.text, self.src).to_ascii_lowercase().split(|c: char| !c.is_ascii_alphanumeric() && c != '-').any(|t| t == "git");
        }
        let resolved = paths::resolve(&self.cwd, &w.text, self.jail.home.as_deref());
        let named = is_git(&base_name(&w.text)) || resolved.file_name().is_some_and(|n| is_git(&n.to_string_lossy().to_ascii_lowercase()));
        if !named {
            return false;
        }
        // A directory or file called `git` inside the repo is ordinary source; only an executable (or an unknown outside path) counts.
        !self.jail.contains(&resolved) || is_executable_file(&resolved)
    }

    /// An operand that names the git executable, also as `if=/usr/bin/git` (dd).
    fn is_git_source(&self, w: &Word) -> bool {
        if w.text.starts_with('-') {
            return false;
        }
        let value = w.text.split_once('=').filter(|(k, _)| !k.is_empty() && k.chars().all(|c| c.is_ascii_lowercase())).map_or(w.text.as_str(), |(_, v)| v);
        self.names_git_binary(&Word { text: value.to_string(), ..w.clone() })
    }

    /// The command word runs the real git under another name: a link to it, or a byte-identical copy inside the jail.
    fn is_git_copy(&self, text: &str) -> bool {
        let p = paths::resolve(&self.cwd, text, self.jail.home.as_deref());
        if p.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("git")) && is_executable_file(&p) {
            return true;
        }
        let Ok(meta) = std::fs::metadata(&p) else { return false };
        if !meta.is_file() || meta.len() < 4096 {
            return false;
        }
        GIT_BINARIES.iter().any(|g| std::fs::metadata(g).is_ok_and(|m| m.len() == meta.len()) && matches!((std::fs::read(g), std::fs::read(&p)), (Ok(a), Ok(b)) if a == b))
    }

    /// Expands `[alias]` entries of the repository and user git config, so `git ci` is judged as the command it runs.
    fn git_alias(&mut self, sub: &str, args: &[Word], ctx: &Ctx) {
        if self.alias_depth >= 4 {
            return;
        }
        let Some(value) = alias_lookup(&self.cwd, self.jail.home.as_deref(), sub) else { return };
        self.alias_depth += 1;
        if let Some(shell) = value.strip_prefix('!') {
            self.script(shell, 1);
        } else {
            let mut synth = vec![Word::lit("git")];
            synth.extend(shellparse::split_words(&value));
            synth.extend_from_slice(args);
            self.git(&synth, ctx);
        }
        self.alias_depth -= 1;
    }

    fn cd(&mut self, words: &[Word]) {
        let target = words[1..].iter().find(|w| !w.text.starts_with('-') || w.text == "-");
        match target {
            Some(w) if !w.dynamic && w.text != "-" => {
                self.cwd = paths::resolve(&self.cwd, &w.text, self.jail.home.as_deref());
            }
            None if self.jail.home.is_some() => {
                self.cwd = paths::resolve(&self.cwd, "~", self.jail.home.as_deref());
            }
            _ => {
                self.cwd_known = false;
                if self.script_stack.is_empty() {
                    self.issue("cd target is not known statically");
                }
            }
        }
    }

    fn find(&mut self, words: &[Word], depth: usize, ctx: &Ctx) {
        self.find_destructive(words);
        if self.a.hard_stop.is_some() {
            return;
        }
        let mut i = 1;
        while i < words.len() {
            if matches!(words[i].text.as_str(), "-exec" | "-execdir" | "-ok" | "-okdir") {
                let end = words[i + 1..].iter().position(|w| w.text == ";" || w.text == "+").map_or(words.len(), |p| i + 1 + p);
                let inner = words[i + 1..end].to_vec();
                self.exec(&inner, depth + 1, &Ctx { xargs: true, ..ctx.clone() });
                i = end;
            }
            i += 1;
        }
    }

    fn fs_mutator(&mut self, base: &str, words: &[Word]) {
        if COPIERS.contains(&base) && words[1..].iter().any(|w| self.is_git_source(w)) {
            self.stop("git.binary-copy", "copying or linking the git binary would hide it from name-based checks");
            return;
        }
        let in_place = |w: &Word| {
            let t = w.text.as_str();
            t == "--in-place" || t.starts_with("--in-place=") || (t.starts_with('-') && !t.starts_with("--") && t[1..].contains('i'))
        };
        if matches!(base, "sed" | "perl") && !words[1..].iter().any(in_place) {
            return;
        }
        for w in &words[1..] {
            let mut cand = w.text.as_str();
            if let Some((k, v)) = cand.split_once('=') {
                if cand.starts_with('-') || k.chars().all(|c| c.is_ascii_lowercase()) {
                    cand = v;
                }
            }
            if cand.starts_with('-') || cand.is_empty() {
                continue;
            }
            if w.dynamic {
                self.issue("dynamic path argument");
                continue;
            }
            self.write_target(&Word { text: cand.to_string(), ..w.clone() });
        }
    }
}

/// `env -i`, `env -`, `env -u PATH`, `env -P dir` and their long forms: the child runs without the shim's PATH.
fn env_option_overrides_path(t: &str, next: Option<&str>) -> bool {
    let named = |n: &str| matches!(n, "PATH" | "HOME" | "ZDOTDIR" | "SHELL") || n.starts_with("XDG_");
    if t == "-" || t == "--ignore-environment" || t == "-P" || t.starts_with("--default-path") {
        return true;
    }
    if t == "--unset" || t == "-u" {
        return next.is_some_and(named);
    }
    if let Some(v) = t.strip_prefix("--unset=") {
        return named(v);
    }
    if t.starts_with("--") {
        return false;
    }
    for (idx, c) in t.char_indices().skip(1) {
        match c {
            'i' | 'P' => return true,
            'u' => {
                let rest = &t[idx + 1..];
                return if rest.is_empty() { next.is_some_and(named) } else { named(rest) };
            }
            'C' | 'S' | 'a' => return false,
            _ => {}
        }
    }
    false
}

/// Last path component, lowercased (APFS is case-insensitive, so `GIT` runs git).
pub(super) fn base_name(text: &str) -> String {
    Path::new(text).file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

/// The read-only forms of `tag`, `notes` and `replace` (they list, they do not write).
fn is_listing(sub: &str, args: &[Word]) -> bool {
    let first = args.first().map(|a| a.text.as_str());
    match sub {
        "tag" => match first {
            None => true,
            Some(f) => {
                matches!(f, "-l" | "--list" | "-v" | "--verify") || (f.starts_with("-n") && f[2..].chars().all(|c| c.is_ascii_digit())) || {
                    ["contains", "no-contains", "merged", "no-merged", "points-at", "sort", "format"].iter().any(|l| long_opt(f, l, 3))
                }
            }
        },
        "notes" => first.is_none() || args.iter().find(|a| !a.text.starts_with('-')).is_some_and(|a| matches!(a.text.as_str(), "list" | "show")),
        "replace" => args.iter().any(|a| a.text == "-l" || long_opt(&a.text, "list", 3) || long_opt(&a.text, "format", 3)),
        _ => false,
    }
}

/// `--name` or an unambiguous-looking abbreviation of it (git accepts `--ha` for `--hard`).
pub(super) fn long_opt(arg: &str, full: &str, min: usize) -> bool {
    let Some(name) = arg.strip_prefix("--") else { return false };
    let name = name.split('=').next().unwrap_or("");
    name.len() >= min && full.starts_with(name)
}

/// The script word of `npx -c` / `npm exec --call`, searched among the leading options.
fn call_string(words: &[Word], from: usize) -> Option<Word> {
    let mut i = from;
    while let Some(w) = words.get(i) {
        let t = w.text.as_str();
        if !t.starts_with('-') {
            return None;
        }
        if t == "-c" || t == "--call" {
            return words.get(i + 1).cloned();
        }
        if let Some(v) = t.strip_prefix("--call=") {
            return Some(Word::lit(v));
        }
        i += 1;
    }
    None
}

pub(super) fn is_executable_file(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// Values given to the options `short` (`-e cmd`, `-ecmd`) and `long` (`--name cmd`, `--name=cmd`).
fn option_values(words: &[Word], short: &[&str], long: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    for (i, w) in words.iter().enumerate().skip(1) {
        let t = w.text.as_str();
        for l in long {
            if t == format!("--{l}") {
                out.extend(words.get(i + 1).map(|n| n.text.clone()));
            } else if let Some(v) = t.strip_prefix(&format!("--{l}=")) {
                out.push(v.to_string());
            }
        }
        for sh in short {
            if t == *sh {
                out.extend(words.get(i + 1).map(|n| n.text.clone()));
            } else if sh.len() == 2 && t.len() > 2 && t.starts_with(sh) {
                out.push(t[2..].to_string());
            }
        }
    }
    out
}

/// sed can run a command line with the `e` command or the `e` flag of `s///`.
fn sed_runs_commands(code: &str) -> bool {
    // `e` alone or after an address (`1e cmd`, `$e cmd`): the whole token is address characters and `e`.
    if code.split(|c: char| c.is_whitespace() || matches!(c, ';' | '{' | '}')).any(|t| t.strip_suffix('e').is_some_and(|a| a.chars().all(|c| c.is_ascii_digit() || matches!(c, '$' | ',' | '~' | '!' | '+')))) {
        return true;
    }
    let t = code.trim_start();
    if t.starts_with("e ") || [";e ", "{e ", "\ne ", "; e ", "'e ", "\"e "].iter().any(|m| code.contains(m)) {
        return true;
    }
    let b = code.as_bytes();
    (0..b.len()).filter(|&i| b[i] == b'/').any(|i| {
        let run = b[i + 1..].iter().take_while(|c| c.is_ascii_lowercase()).count();
        let after = b.get(i + 1 + run).copied();
        run > 0 && b[i + 1..i + 1 + run].contains(&b'e') && after.is_none_or(|c| c.is_ascii_whitespace() || matches!(c, b';' | b'}' | b'\'' | b'"'))
    })
}

/// `[alias]` value `name` from the repository config (walking up to the `.git` directory) or the user's git config.
fn alias_lookup(cwd: &Path, home: Option<&Path>, name: &str) -> Option<String> {
    let mut files: Vec<PathBuf> = Vec::new();
    if let Some(root) = cwd.ancestors().find(|d| d.join(".git").is_dir()) {
        files.push(root.join(".git/config"));
    }
    if let Some(h) = home {
        files.push(h.join(".gitconfig"));
        files.push(h.join(".config/git/config"));
    }
    files.iter().find_map(|f| alias_in_config(&std::fs::read_to_string(f).ok()?, name))
}

fn alias_in_config(text: &str, name: &str) -> Option<String> {
    let mut in_alias = false;
    for line in text.lines() {
        let line = line.trim();
        if let Some(section) = line.strip_prefix('[') {
            in_alias = section.trim_end_matches(']').trim().eq_ignore_ascii_case("alias");
        } else if in_alias {
            let Some((key, value)) = line.split_once('=') else { continue };
            if key.trim().eq_ignore_ascii_case(name) {
                return Some(value.trim().trim_matches('"').to_string());
            }
        }
    }
    None
}

/// Inline interpreter code that mentions `git` and a write verb as separate words.
pub(super) fn mentions_git_write(code: &str) -> bool {
    let lower = code.to_ascii_lowercase();
    let tokens: Vec<&str> = lower.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_')).filter(|t| !t.is_empty()).collect();
    tokens.contains(&"git") && tokens.iter().any(|t| INLINE_GIT_VERBS.contains(t))
}

/// Agent hard stops for wrangler and Cloudflare deployment tooling (remote spec 4.9, T10). The IDE deploys the relay
/// from Settings after a typed confirmation; an agent never runs wrangler, reads its credentials or calls the Cloudflare
/// API. Judged like every other hard stop, on parsed words: the program, its package-manager and interpreter spellings,
/// the paths and hosts it names, the scripts it resolves to. Best effort by design (see the module docs).
mod wrangler {
    use std::path::PathBuf;

    use super::*;

    const CF_TOOLS: &[&str] = &["wrangler", "wrangler2", "cloudflared", "flarectl", "cf-terraforming", "create-cloudflare"];
    /// A file called `wrangler.<ext>` runs only with these extensions (`wrangler.jsonc`, `wrangler.toml`, `wrangler.ts` are config or source).
    const RUNNABLE_EXTS: &[&str] = &["", "js", "cjs", "mjs", "cmd", "bat", "exe", "ps1", "sh"];
    /// Directories of an installed or downloaded package (`node_modules/wrangler/bin/wrangler.js`, `~/.npm/_npx/<id>/...`).
    const PKG_TREE: &[&str] = &["node_modules", "_npx", ".pnpm", "dlx"];
    const SUBCOMMANDS: &[&str] = &[
        "deploy", "publish", "delete", "login", "logout", "secret", "rollback", "versions", "deployments", "d1", "kv", "r2", "queues", "hyperdrive", "vectorize", "pages", "tail", "whoami",
        "triggers", "dev", "containers", "workflows", "tunnel", "mtls-certificate", "dispatch-namespace", "pubsub", "cert",
    ];
    /// Words that make inline interpreter code run or load something (`execSync`, `subprocess`, `require`, `import`).
    const SCRIPT_MARKERS: &[&str] = &["exec", "spawn", "system", "popen", "subprocess", "fork", "shell", "getline", "`", "child_process", "proc_open", "passthru", "eval"];
    const API_HOSTS: &[&str] = &["api.cloudflare.com", "dash.cloudflare.com/api", "cloudflare.com/client/v4"];
    /// Programs that print or test their words without opening any of them as a file.
    const PURE_TEXT: &[&str] = &["echo", "printf", "which", "type", "whereis", "hash", "test", "["];
    /// Programs that read or search files and never connect anywhere (a Cloudflare host as their word is a search term).
    const NO_NETWORK: &[&str] = &[
        "cat", "head", "tail", "less", "more", "ls", "wc", "grep", "egrep", "fgrep", "zgrep", "rg", "ag", "ack", "diff", "cmp", "file", "stat", "tree", "bat", "echo", "printf", "realpath", "dirname",
        "basename", "readlink", "shasum", "md5", "md5sum", "sha256sum", "cksum", "hexdump", "od", "strings", "nl", "pwd", "which", "test", "[", "true", "false", "cd", "pushd", "popd", "git", "sort",
        "uniq", "cut", "tr", "sed", "gsed", "jq", "type",
    ];
    const NET_CLIENTS: &[&str] = &[
        "curl", "wget", "http", "https", "httpie", "xh", "nc", "ncat", "netcat", "socat", "telnet", "openssl", "aria2c", "lynx", "w3m", "links", "ftp", "sftp", "fetch", "hurl", "grpcurl", "websocat",
    ];
    /// Programs that walk a whole directory tree: handed `~` or `~/Library`, they reach the credential directory without naming it.
    const RECURSIVE_TOOLS: &[&str] = &["find", "grep", "egrep", "fgrep", "zgrep", "rg", "ag", "ack", "fd", "cp", "rsync", "ditto", "tar", "bsdtar", "gtar", "zip", "cpio", "pax", "scp"];
    /// Package-manager verbs that manage dependencies: `pnpm add -D wrangler` installs the package, it runs nothing.
    const PM_MANAGE: &[&str] = &[
        "install", "i", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "why", "ls", "list", "info", "view", "show", "outdated", "audit", "pack", "link", "unlink", "dedupe",
        "prune", "search", "explain", "fund", "doctor", "bin", "root", "config", "cache", "store", "patch",
    ];
    /// Git subcommands that only list names or states: a path as their argument is not opened.
    const GIT_NAME_ONLY: &[&str] = &["check-ignore", "ls-files", "status"];
    /// Directories never entered when looking for workspace packages.
    const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "coverage", "out"];

    fn components(text: &str) -> Vec<&str> {
        text.split(['/', '\\', ':', '#']).filter(|c| !c.is_empty()).collect()
    }

    /// `(stem, extension)` of a path component without a `@version` suffix: `wrangler@4.1.0` and `wrangler.mjs`.
    fn stem_ext(comp: &str) -> (String, String) {
        let c = comp.to_ascii_lowercase();
        let c = match c.char_indices().skip(1).find(|(_, ch)| *ch == '@') {
            Some((i, _)) => c[..i].to_string(),
            None => c,
        };
        match c.split_once('.') {
            Some((stem, rest)) => (stem.to_string(), rest.rsplit('.').next().unwrap_or("").to_string()),
            None => (c, String::new()),
        }
    }

    fn is_tool_comp(comp: &str) -> bool {
        let (stem, ext) = stem_ext(comp);
        CF_TOOLS.contains(&stem.as_str()) && RUNNABLE_EXTS.contains(&ext.as_str())
    }

    /// The word runs, or is, a Cloudflare tool: its last component is the program (`wrangler`, `.bin/wrangler`,
    /// `npm:wrangler@4`, `wrangler.js`), or it sits in `wrangler-dist` or in a package directory called `wrangler`.
    pub(super) fn cf_tool_name(text: &str) -> bool {
        let comps = components(text);
        let in_pkg_tree = comps.iter().any(|c| PKG_TREE.contains(&c.to_ascii_lowercase().as_str()));
        let pkg_dir = |c: &str| {
            let (stem, ext) = stem_ext(c);
            stem == "wrangler" && ext.is_empty()
        };
        comps.last().is_some_and(|c| is_tool_comp(c)) || comps.iter().any(|c| c.eq_ignore_ascii_case("wrangler-dist") || (in_pkg_tree && pkg_dir(c)))
    }

    fn word_names_tool(text: &str) -> bool {
        cf_tool_name(text) || text.split_once('=').is_some_and(|(_, v)| cf_tool_name(v))
    }

    fn tokens(text: &str) -> Vec<String> {
        text.to_ascii_lowercase()
            .split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '@' | '/' | ':' | '#' | '\\')))
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .collect()
    }

    fn has_wrangler(toks: &[String]) -> bool {
        toks.iter().any(|t| cf_tool_name(t))
    }

    fn has_subcommand(toks: &[String]) -> bool {
        toks.iter().any(|t| SUBCOMMANDS.contains(&t.as_str()))
    }

    /// Text that names wrangler together with a subcommand (`ssh host wrangler deploy`, `tmux send-keys 'wrangler secret put'`).
    pub(super) fn mentions_wrangler_sub(text: &str) -> bool {
        let t = tokens(text);
        has_wrangler(&t) && has_subcommand(&t)
    }

    /// Inline interpreter code that runs or loads wrangler (`execSync('wrangler deploy')`, `import('wrangler')`, `subprocess.run(['npx','wrangler'...`).
    fn mentions_wrangler_inline(code: &str) -> bool {
        let t = tokens(code);
        let lower = code.to_ascii_lowercase();
        has_wrangler(&t) && (has_subcommand(&t) || SCRIPT_MARKERS.iter().chain(["require", "import"].iter()).any(|m| lower.contains(*m)))
    }

    /// A script file that spawns wrangler: all three of the word, a subcommand and a spawning call.
    fn mentions_wrangler_script(text: &str) -> bool {
        let t = tokens(text);
        let lower = text.to_ascii_lowercase();
        has_wrangler(&t) && has_subcommand(&t) && SCRIPT_MARKERS.iter().any(|m| lower.contains(*m))
    }

    pub(super) fn mentions_cf_api(text: &str) -> bool {
        let lower = text.to_ascii_lowercase();
        API_HOSTS.iter().any(|h| lower.contains(*h))
    }

    /// `CLOUDFLARE_*`, `CF_API_*`, `CF_ACCOUNT*` and `WRANGLER_*`: the token, account and path variables wrangler reads.
    pub(super) fn is_cf_secret_env(name: &str) -> bool {
        let n = name.to_ascii_uppercase();
        n.starts_with("CLOUDFLARE_") || n.starts_with("WRANGLER_") || n.starts_with("CF_API_") || n.starts_with("CF_ACCOUNT") || n == "CF_TOKEN" || n == "CF_ZONE_ID"
    }

    /// `$CLOUDFLARE_API_TOKEN`, `${CF_API_TOKEN:-x}`, `${!CLOUDFLARE_*}` anywhere in the text.
    pub(super) fn has_cf_env_ref(text: &str) -> bool {
        let b = text.as_bytes();
        (0..b.len()).filter(|&i| b[i] == b'$').any(|i| {
            let mut j = i + 1;
            if b.get(j) == Some(&b'{') {
                j += 1;
                while matches!(b.get(j), Some(b'!' | b'#')) {
                    j += 1;
                }
            }
            let start = j;
            while b.get(j).is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_') {
                j += 1;
            }
            j > start && is_cf_secret_env(&text[start..j])
        })
    }

    /// The upper-case name of a token variable inside inline code (`process.env.CLOUDFLARE_API_TOKEN`, `ENVIRON["CF_API_TOKEN"]`).
    fn env_name_in_code(code: &str) -> bool {
        code.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).any(|t| !t.is_empty() && t == t.to_ascii_uppercase() && is_cf_secret_env(t))
    }

    /// `{a,b}` brace expansion (bounded), so `~/.{wrangler,x}/config` is judged as both words.
    fn brace_expand(s: &str) -> Vec<String> {
        fn go(s: &str, out: &mut Vec<String>, budget: &mut usize) {
            if *budget == 0 {
                return;
            }
            let chars: Vec<char> = s.chars().collect();
            let mut from = 0;
            while let Some(open) = chars[from..].iter().position(|c| *c == '{').map(|p| p + from) {
                let (mut depth, mut close, mut commas) = (0usize, None, Vec::new());
                for (i, c) in chars.iter().enumerate().skip(open) {
                    match c {
                        '{' => depth += 1,
                        '}' => {
                            depth -= 1;
                            if depth == 0 {
                                close = Some(i);
                                break;
                            }
                        }
                        ',' if depth == 1 => commas.push(i),
                        _ => {}
                    }
                }
                let Some(close) = close else { break };
                if commas.is_empty() {
                    from = open + 1;
                    continue;
                }
                let pre: String = chars[..open].iter().collect();
                let post: String = chars[close + 1..].iter().collect();
                let mut bounds = vec![open];
                bounds.extend(&commas);
                bounds.push(close);
                for w in bounds.windows(2) {
                    let alt: String = chars[w[0] + 1..w[1]].iter().collect();
                    go(&format!("{pre}{alt}{post}"), out, budget);
                }
                return;
            }
            if *budget > 0 {
                *budget -= 1;
                out.push(s.to_string());
            }
        }
        let mut out = Vec::new();
        go(s, &mut out, &mut 64);
        out
    }

    /// `name` as a path component of `v` (the characters around it are not part of a longer name).
    fn has_component(v: &str, name: &str, dev_vars: bool) -> bool {
        let mut from = 0;
        while let Some(i) = v[from..].find(name) {
            let (s, e) = (from + i, from + i + name.len());
            from = s + 1;
            if s > 0 && !matches!(v.as_bytes()[s - 1], b'/' | b'=' | b'@' | b':' | b' ' | b'\'' | b'"' | b'~' | b'(' | b',' | b'{' | b'<' | b'>' | b'`' | b';' | b'|' | b'&' | b'\t' | b'\n') {
                continue;
            }
            let rest = &v[e..];
            let ok = match rest.chars().next() {
                None => true,
                Some(c) if c.is_ascii_alphanumeric() || matches!(c, '_' | '-') => false,
                Some('.') if dev_vars => ![".example", ".sample", ".template"].iter().any(|t| rest.starts_with(t) && !rest[t.len()..].starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-')),
                Some('.') => false,
                Some(_) => true,
            };
            if ok {
                return true;
            }
        }
        false
    }

    /// Why this text (a word, a script) names a wrangler credential location, judged on the spelling alone, so dynamic
    /// words (`$HOME/.wrangler/...`) and brace expansions count too.
    pub(super) fn secret_in_text(text: &str) -> Option<&'static str> {
        for v in brace_expand(&text.to_ascii_lowercase()) {
            if [".wrangler", ".cloudflared", ".cloudflare"].iter().any(|n| has_component(&v, n, false)) {
                return Some("a wrangler/Cloudflare credential directory");
            }
            if has_component(&v, ".dev.vars", true) {
                return Some("a wrangler .dev.vars secrets file");
            }
            if v.contains(".config/cloudflare") || v.contains("intelyswitchide/relay-deploy") {
                return Some("wrangler/Cloudflare credentials or deploy state");
            }
        }
        None
    }

    fn fnmatch(p: &[char], n: &[char]) -> bool {
        match p.first() {
            None => n.is_empty(),
            Some('*') => (0..=n.len()).any(|i| fnmatch(&p[1..], &n[i..])),
            Some('?') => !n.is_empty() && fnmatch(&p[1..], &n[1..]),
            Some('[') => {
                let Some(first) = n.first() else { return false };
                match p.iter().position(|c| *c == ']').filter(|&e| e > 1) {
                    Some(end) => {
                        let set = &p[1..end];
                        let (neg, set) = if matches!(set.first(), Some('!' | '^')) { (true, &set[1..]) } else { (false, set) };
                        let (mut hit, mut i) = (false, 0);
                        while i < set.len() {
                            if i + 2 < set.len() && set[i + 1] == '-' {
                                hit |= set[i] <= *first && *first <= set[i + 2];
                                i += 3;
                            } else {
                                hit |= set[i] == *first;
                                i += 1;
                            }
                        }
                        hit != neg && fnmatch(&p[end + 1..], &n[1..])
                    }
                    None => *first == '[' && fnmatch(&p[1..], &n[1..]),
                }
            }
            Some(c) => n.first() == Some(c) && fnmatch(&p[1..], &n[1..]),
        }
    }

    /// sed's `r file`, `R file`, `w file`, `W file` commands (and the `w` flag of `s///`) with a credential file as the name.
    fn sed_file_command_hits_secret(code: &str) -> bool {
        let chars: Vec<char> = code.chars().collect();
        (0..chars.len()).any(|i| {
            let prev_ok = i == 0 || matches!(chars[i - 1], ' ' | ';' | '{' | '}' | '\n' | '/' | '$' | '0'..='9');
            let cmd = matches!(chars[i], 'r' | 'R' | 'w' | 'W') && chars.get(i + 1).is_some_and(|c| c.is_whitespace());
            cmd && prev_ok && {
                let name: String = chars[i + 1..].iter().take_while(|c| **c != '\n').collect();
                secret_in_text(name.trim()).is_some()
            }
        })
    }

    /// First argument of the inline-code options of an interpreter (the code is in the words, not in a file).
    fn has_inline_flag(words: &[Word]) -> bool {
        words[1..].iter().any(|w| matches!(w.text.as_str(), "-e" | "-p" | "-c" | "-E" | "-pe" | "-ne" | "-pi" | "--eval" | "--print") || w.text.starts_with("--eval=") || w.text.starts_with("--print="))
    }

    /// One past the index of the script operand of an interpreter or shell (`node -r x a.js` -> index of `a.js` + 1).
    fn operand_end(words: &[Word], base: &str) -> usize {
        let takes: &[&str] = match base {
            "node" | "nodejs" | "tsx" | "ts-node" => &["-r", "--require", "--import", "--loader", "--env-file", "--experimental-loader", "-C", "--conditions"],
            "ruby" => &["-I", "-r"],
            "perl" => &["-I", "-M"],
            b if b.starts_with("python") => &["-W", "-X", "-Q"],
            _ => &["-o", "+o", "--rcfile", "--init-file", "--config", "-c"],
        };
        let mut i = 1;
        while let Some(w) = words.get(i) {
            let t = w.text.as_str();
            if t == "--" {
                return (i + 2).min(words.len());
            }
            if !(t.starts_with('-') || t.starts_with('+')) || t == "-" {
                // `deno run npm:wrangler`, `bun x wrangler`: the package follows the subcommand
                return (i + if matches!(base, "deno" | "bun") { 2 } else { 1 }).min(words.len());
            }
            i += if takes.contains(&t) { 2 } else { 1 };
        }
        words.len()
    }

    /// The words of `base` that name something: not the text of `echo`, not the pattern or script of `grep`/`sed`/`awk`.
    fn operands<'w>(base: &str, words: &'w [Word]) -> Vec<&'w Word> {
        let rest = &words[1..];
        if base == "git" {
            return if rest.iter().any(|w| GIT_NAME_ONLY.contains(&w.text.as_str())) { Vec::new() } else { rest.iter().collect() };
        }
        if !matches!(base, "grep" | "egrep" | "fgrep" | "zgrep" | "rg" | "ag" | "ack" | "sed" | "gsed" | "awk" | "gawk" | "mawk" | "nawk") {
            return rest.iter().collect();
        }
        let mut pattern_skipped = rest.iter().any(|w| {
            let t = w.text.as_str();
            matches!(t, "-e" | "-f" | "--regexp" | "--file" | "--expression") || t.starts_with("--regexp=") || t.starts_with("--expression=") || t.starts_with("--file=")
        });
        let (mut out, mut skip_next) = (Vec::new(), false);
        for w in rest {
            let t = w.text.as_str();
            if std::mem::take(&mut skip_next) {
                continue;
            }
            if matches!(t, "-e" | "--regexp" | "--expression") {
                skip_next = true;
            } else if t.starts_with('-') && t.len() > 1 {
                out.push(w);
            } else if !std::mem::replace(&mut pattern_skipped, true) {
                continue;
            } else {
                out.push(w);
            }
        }
        out
    }

    impl<'a> Walker<'a> {
        pub(super) fn cf_stop(&mut self, rule: &str, what: &str) {
            self.stop(rule, &format!("{what}; wrangler and Cloudflare deployment are human-only (the IDE deploys the relay from Settings)"));
        }

        /// `$CLOUDFLARE_API_TOKEN` and friends anywhere in a script text.
        pub(super) fn wrangler_script_text(&mut self, src: &str) {
            if has_cf_env_ref(src) {
                self.cf_stop("wrangler.env", "uses a Cloudflare or wrangler token variable");
            }
        }

        /// Credential locations named by redirect targets and assignments, and wrangler copied by a redirect (`cat .bin/wrangler > w`).
        pub(super) fn wrangler_command(&mut self, cmd: &Command) {
            for (_, value) in &cmd.assigns {
                self.secret_word(value);
            }
            for r in cmd.redirects.iter().filter(|r| !matches!(r.kind, RedirKind::HereDoc | RedirKind::HereString)) {
                self.secret_word(&r.target);
            }
            if cmd.redirects.iter().any(|r| r.writes_file())
                && cmd.words.first().is_some_and(|f| !f.dynamic && STREAM_COPIERS.contains(&base_name(&f.text).as_str()))
                && cmd.words[1..].iter().any(|w| word_names_tool(&w.text))
            {
                self.cf_stop("wrangler.binary-copy", "writing the wrangler program to a file would hide it from name-based checks");
            }
        }

        /// A command name that is not known statically: a computed path to wrangler, a glob that matches it, `w=wrangler; $w deploy`.
        pub(super) fn wrangler_unknown_command(&mut self, first: &Word) {
            if self.a.hard_stop.is_some() {
                return;
            }
            let glob_hit = first.glob && !first.dynamic && self.glob_paths(&first.text).iter().any(|p| cf_tool_name(&p.to_string_lossy()));
            if glob_hit || cf_tool_name(&first.text) || has_wrangler(&tokens(&self.src)) {
                self.cf_stop("wrangler.exec", "a command name that is computed or globbed, in a script that names wrangler");
            }
        }

        /// Everything about a leaf command (wrappers are peeled already) that reaches wrangler, its credentials or the Cloudflare API.
        pub(super) fn wrangler_leaf(&mut self, base: &str, first: &Word, words: &[Word], ctx: &Ctx) {
            if self.a.hard_stop.is_some() {
                return;
            }
            if cf_tool_name(&first.text) {
                self.cf_stop("wrangler.exec", &format!("{} is wrangler or Cloudflare deployment tooling", first.text));
                return;
            }
            let shell = SHELLS.contains(&base);
            let inline_shell = shell && words[1..].iter().any(|w| w.text.starts_with('-') && !w.text.starts_with("--") && w.text.contains('c'));
            let interp = !shell && (INTERPRETERS.contains(&base) || base.starts_with("python") || matches!(base, "tsx" | "ts-node" | "ts-node-esm"));
            let text_only = PURE_TEXT.contains(&base);
            let mut args = operands(base, words);
            if inline_shell {
                // the script is walked on its own; what follows it (`bash -c 'cat "$0"' file`) are operands
                if let Some(script) = words.iter().position(|w| w.text.starts_with('-') && !w.text.starts_with("--") && w.text.contains('c')).and_then(|p| words.get(p + 1)) {
                    args.retain(|w| !std::ptr::eq(*w, script));
                }
            }
            // a command word that stdin or `find` fills in (`xargs -I{} {} deploy`) in a line that names wrangler
            if ctx.xargs && (first.text.contains("{}") || self.repl.as_deref().is_some_and(|r| first.text.contains(r))) && has_wrangler(&tokens(&self.src)) {
                self.cf_stop("wrangler.exec", "the program to run comes from stdin or find in a command line that names wrangler");
                return;
            }

            // credential paths (also `~/.{wrangler,x}`, globs, `$HOME/...`, `--file=...`, symlinks)
            if !text_only {
                for w in &args {
                    self.secret_word(w);
                }
                if ctx.xargs {
                    if let Some(why) = secret_in_text(&self.src) {
                        self.cf_stop("wrangler.credentials", &format!("the command line names {why} and hands it to {base} through xargs"));
                    }
                }
            }
            if self.a.hard_stop.is_some() {
                return;
            }
            if RECURSIVE_TOOLS.contains(&base) {
                for w in args.iter().filter(|w| !w.dynamic && !w.text.starts_with('-')) {
                    if self.reaches_credential_dir(&w.text) {
                        self.cf_stop("wrangler.credentials", &format!("{base} walks {}, which contains the wrangler credential directory", w.text));
                        return;
                    }
                }
            }
            // the token variables
            if matches!(base, "printenv" | "launchctl") && args.iter().any(|w| is_cf_secret_env(&w.text)) {
                self.cf_stop("wrangler.env", &format!("{base} reads a Cloudflare or wrangler token variable"));
                return;
            }
            // Cloudflare API hosts
            if !text_only && !interp && !NO_NETWORK.contains(&base) && (args.iter().any(|w| mentions_cf_api(&w.text)) || ctx.stdin_script.as_deref().is_some_and(mentions_cf_api)) {
                self.cf_stop("wrangler.api", &format!("{base} reaches the Cloudflare API"));
                return;
            }
            if (NET_CLIENTS.contains(&base) || ctx.xargs) && mentions_cf_api(&self.src) {
                self.cf_stop("wrangler.api", &format!("{base} is fed the Cloudflare API address by the command line"));
                return;
            }
            if NET_CLIENTS.contains(&base) {
                self.net_config_files(base, words);
            }
            if matches!(base, "sed" | "gsed") {
                let code = words[1..].iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
                if sed_file_command_hits_secret(&code) || (sed_runs_commands(&code) && (has_wrangler(&tokens(&code)) || mentions_cf_api(&code) || secret_in_text(&code).is_some())) {
                    self.cf_stop("wrangler.credentials", "sed script that reads or writes a credential file, or runs wrangler");
                    return;
                }
            }
            // programs that copy or link wrangler under another name
            if COPIERS.contains(&base) && words[1..].iter().any(|w| word_names_tool(&w.text)) {
                self.cf_stop("wrangler.binary-copy", "copying or linking the wrangler program would hide it from name-based checks");
                return;
            }
            // interpreters and shells: the entry file or package is wrangler's, the inline code or the script file runs it
            let runs_file = shell || matches!(base, "node" | "nodejs" | "deno" | "bun" | "tsx" | "ts-node" | "ts-node-esm" | "ruby" | "perl" | "php" | "lua") || base.starts_with("python");
            if runs_file && !inline_shell && !has_inline_flag(words) {
                let end = operand_end(words, base);
                if words[1..end].iter().any(|w| cf_tool_name(&w.text)) {
                    self.cf_stop("wrangler.node-entry", &format!("{base} runs the wrangler entry point"));
                    return;
                }
            }
            if interp {
                self.inline_code(base, words, ctx);
                if self.a.hard_stop.is_none() && !has_inline_flag(words) {
                    if let Some(file) = words.get(operand_end(words, base).saturating_sub(1)).filter(|_| operand_end(words, base) > 1).cloned() {
                        self.script_file_threat(&file);
                    }
                }
            } else if first.text.contains('/') && !first.dynamic && !shell {
                self.script_file_threat(first);
            }
            if self.a.hard_stop.is_some() {
                return;
            }
            // programs that run a command line somewhere else
            if REMOTE_RUNNERS.contains(&base) {
                let mut line = words[1..].iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
                line.push(' ');
                line.push_str(ctx.stdin_script.as_deref().unwrap_or(""));
                if mentions_wrangler_sub(&line) {
                    self.cf_stop("wrangler.remote", &format!("{base} would run wrangler elsewhere"));
                    return;
                }
            }
            if base == "nix-shell" || (base == "nix" && words[1..].iter().any(|w| matches!(w.text.as_str(), "run" | "shell" | "develop"))) {
                if words[1..].iter().any(|w| cf_tool_name(&w.text)) {
                    self.cf_stop("wrangler.exec", "nix would run wrangler");
                }
            }
        }

        /// Checks that need the command as written, before a wrapper is peeled: the package managers, and the programs that dump the
        /// whole environment (`env | grep -i cloudflare`).
        pub(super) fn wrangler_pre(&mut self, base: &str, words: &[Word], depth: usize) {
            self.package_manager(base, words, depth);
            let dumps = matches!(base, "env" | "printenv" | "export" | "declare" | "typeset" | "compgen") && words[1..].iter().all(|w| w.text.starts_with('-'));
            if self.a.hard_stop.is_none() && dumps {
                let src = self.src.to_ascii_lowercase();
                if ["cloudflare", "wrangler", "cf_"].iter().any(|m| src.contains(*m)) {
                    self.cf_stop("wrangler.env", &format!("{base} dumps the environment, which holds the Cloudflare token"));
                }
            }
        }

        /// A wrapper (`env`, `xargs`, `sudo`, `npx`) was peeled: its own options may name a credential file (`xargs -a ~/.wrangler/x`), and a wrapper
        /// with nothing left to run takes the program from stdin (`echo wrangler | xargs npx`).
        pub(super) fn wrangler_wrapper(&mut self, options: &[Word], inner_empty: bool, xargs: bool) {
            for w in options {
                self.secret_word(w);
            }
            if inner_empty && xargs && self.a.hard_stop.is_none() && has_wrangler(&tokens(&self.src)) {
                self.cf_stop("wrangler.exec", "the program to run comes from stdin in a command line that names wrangler");
            }
        }

        /// `npm exec`, `pnpm dlx`, `yarn wrangler`, `pnpm --filter x exec wrangler`, `npm create cloudflare`: the package manager runs a Cloudflare tool.
        /// Called before the wrapper is peeled, so the options of `npx -p wrangler` are seen too.
        pub(super) fn package_manager(&mut self, base: &str, words: &[Word], depth: usize) {
            if !matches!(base, "npm" | "pnpm" | "yarn" | "bun" | "cnpm" | "npx" | "bunx" | "pnpx" | "corepack") {
                return;
            }
            let pos: Vec<String> = words[1..].iter().filter(|w| !w.text.starts_with('-')).map(|w| w.text.to_ascii_lowercase()).collect();
            let execish = pos.iter().take(6).any(|p| matches!(p.as_str(), "exec" | "dlx" | "x" | "run" | "run-script" | "rum" | "urn" | "create" | "init"));
            let manages = !execish && pos.iter().take(4).any(|p| PM_MANAGE.contains(&p.as_str()));
            if !manages && words[1..].iter().any(|w| word_names_tool(&w.text)) {
                self.cf_stop("wrangler.pm-exec", &format!("{base} would run wrangler or Cloudflare tooling"));
                return;
            }
            if pos.iter().any(|p| matches!(p.as_str(), "create" | "init")) && words[1..].iter().any(|w| components(&w.text).last().is_some_and(|c| stem_ext(c).0 == "cloudflare")) {
                self.cf_stop("wrangler.pm-exec", &format!("{base} create cloudflare scaffolds and deploys a Worker"));
                return;
            }
            if matches!(base, "npm" | "pnpm" | "yarn" | "bun" | "cnpm") {
                self.workspace_scripts(base, words, depth);
            }
        }

        /// `pnpm -C remote-relay run deploy`, `npm --prefix x run y`, `pnpm --filter relay deploy`, `pnpm -r run y`, `yarn workspace relay deploy`:
        /// the script lives in another package than the nearest `package.json`, so its text is walked here.
        fn workspace_scripts(&mut self, base: &str, words: &[Word], depth: usize) {
            let (mut dirs, mut multi, mut pos) = (Vec::<String>::new(), false, Vec::<&str>::new());
            let mut i = 1;
            while let Some(w) = words.get(i) {
                let t = w.text.as_str();
                if t == "--" {
                    break;
                }
                let inline = ["--dir=", "--prefix=", "--cwd="].iter().find_map(|f| t.strip_prefix(f));
                if let Some(v) = inline {
                    dirs.push(v.to_string());
                } else if matches!(t, "-C" | "--dir" | "--prefix" | "--cwd") {
                    dirs.extend(words.get(i + 1).map(|n| n.text.clone()));
                    i += 1;
                } else if matches!(t, "-F" | "--filter" | "--filter-prod" | "-w" | "--workspace") {
                    multi = true;
                    i += 1;
                } else if t.starts_with("--filter=") || t.starts_with("--workspace=") || matches!(t, "-r" | "--recursive" | "--workspaces" | "-ws" | "--workspace-root") {
                    multi = true;
                } else if !t.starts_with('-') {
                    pos.push(t);
                }
                i += 1;
            }
            let first = pos.first().copied();
            if dirs.is_empty() && !multi && !matches!(first, Some("workspace" | "workspaces")) {
                return;
            }
            let name = match first {
                Some("run" | "run-script" | "rum" | "urn") => pos.get(1).copied(),
                Some("workspace") => pos.get(2).copied(),
                Some("workspaces") => pos.iter().rev().find(|p| !matches!(**p, "foreach" | "run" | "workspaces")).copied(),
                Some("test" | "t" | "tst") => Some("test"),
                Some(p) if base != "npm" => Some(p),
                _ => None,
            };
            let Some(name) = name.map(str::to_string) else { return };
            let mut cands: Vec<PathBuf> = dirs.iter().map(|d| paths::resolve(&self.cwd, d, self.jail.home.as_deref())).collect();
            if multi || matches!(first, Some("workspace" | "workspaces")) {
                cands.extend(self.workspace_dirs());
            }
            for dir in cands {
                if !self.jail.contains(&dir) {
                    self.issue("package directory outside the working directories");
                    continue;
                }
                let Some(pkg) = std::fs::read_to_string(dir.join("package.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else { continue };
                for key in [format!("pre{name}"), name.clone(), format!("post{name}")] {
                    let Some(text) = pkg["scripts"][key.as_str()].as_str() else { continue };
                    let label_key = format!("{}#{key}", dir.display());
                    if self.script_stack.contains(&label_key) {
                        continue;
                    }
                    self.script_stack.push(label_key);
                    let saved = (self.cwd.clone(), self.cwd_known);
                    self.cwd = dir.clone();
                    self.cwd_known = true;
                    self.script(text, depth + 1);
                    (self.cwd, self.cwd_known) = saved;
                    self.script_stack.pop();
                    if self.a.hard_stop.is_some() {
                        return;
                    }
                }
            }
        }

        /// Directories under the working directory (three levels, no hidden or build directories) that hold a `package.json`.
        fn workspace_dirs(&self) -> Vec<PathBuf> {
            let mut found = Vec::new();
            let mut level = vec![self.jail.cwd.clone()];
            let mut seen = 0usize;
            for _ in 0..4 {
                let mut next = Vec::new();
                for dir in &level {
                    if dir.join("package.json").is_file() {
                        found.push(dir.clone());
                    }
                    let Ok(rd) = std::fs::read_dir(dir) else { continue };
                    for e in rd.flatten() {
                        seen += 1;
                        let name = e.file_name().to_string_lossy().to_string();
                        if seen > 3000 || found.len() >= 80 || name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                            continue;
                        }
                        if e.file_type().is_ok_and(|t| t.is_dir()) {
                            next.push(e.path());
                        }
                    }
                }
                level = next;
            }
            found
        }

        /// A word that names a credential location: by its spelling, by where it resolves (symlinks, `~`, `..`) or by what its glob matches.
        fn secret_word(&mut self, w: &Word) {
            if self.a.hard_stop.is_some() || w.text.is_empty() {
                return;
            }
            let t = w.text.as_str();
            if let Some(why) = secret_in_text(t) {
                self.cf_stop("wrangler.credentials", &format!("{t} names {why}"));
                return;
            }
            // `$HOME/...` is the home directory the jail knows: judged like `~/...`
            let home_form = t.strip_prefix("$HOME/").or_else(|| t.strip_prefix("${HOME}/")).map(|r| format!("~/{r}"));
            let t = home_form.as_deref().unwrap_or(t);
            if (w.dynamic && home_form.is_none()) || t.contains(['$', '`', '{']) {
                return;
            }
            let mut cands = vec![t];
            cands.extend(t.split_once('=').map(|(_, v)| v));
            cands.extend(t.strip_prefix('@'));
            if t.starts_with('-') && !t.starts_with("--") {
                cands.extend(t.char_indices().nth(2).map(|(i, _)| &t[i..]));
            }
            for c in cands.into_iter().filter(|c| !c.is_empty() && !c.starts_with('-')) {
                if !self.cwd_known && !c.starts_with('/') && !c.starts_with('~') {
                    continue;
                }
                let p = paths::resolve(&self.cwd, c, self.jail.home.as_deref());
                if let Some(why) = self.jail.wrangler_secret_reason(&p) {
                    self.cf_stop("wrangler.credentials", &format!("{t} resolves to {} ({why})", p.display()));
                    return;
                }
            }
            if w.glob {
                let hit = self.glob_paths(t).into_iter().find_map(|p| {
                    let p = paths::canonical_lossy(&p);
                    self.jail.wrangler_secret_reason(&p).map(|why| (p, why))
                });
                if let Some((p, why)) = hit {
                    self.cf_stop("wrangler.credentials", &format!("{t} matches {} ({why})", p.display()));
                }
            }
        }

        /// What an unquoted glob matches on disk (bounded). Hidden names match only a pattern that starts with a dot.
        fn glob_paths(&self, text: &str) -> Vec<PathBuf> {
            let (start, rest) = if let Some(r) = text.strip_prefix("~/") {
                match self.jail.home.clone() {
                    Some(h) => (h, r),
                    None => return Vec::new(),
                }
            } else if let Some(r) = text.strip_prefix('/') {
                (PathBuf::from("/"), r)
            } else if self.cwd_known {
                (self.cwd.clone(), text)
            } else {
                return Vec::new();
            };
            let mut level = vec![start];
            let mut seen = 0usize;
            for comp in rest.split('/').filter(|c| !c.is_empty()) {
                let mut next = Vec::new();
                for dir in &level {
                    if !comp.contains(['*', '?', '[']) {
                        next.push(dir.join(comp));
                        continue;
                    }
                    let pat: Vec<char> = comp.to_ascii_lowercase().chars().collect();
                    let Ok(rd) = std::fs::read_dir(dir) else { continue };
                    for e in rd.flatten() {
                        seen += 1;
                        let name = e.file_name().to_string_lossy().to_ascii_lowercase();
                        if seen > 5000 || next.len() >= 256 {
                            break;
                        }
                        if name.starts_with('.') && !comp.starts_with('.') {
                            continue;
                        }
                        if fnmatch(&pat, &name.chars().collect::<Vec<_>>()) {
                            next.push(e.path());
                        }
                    }
                }
                level = next;
                if level.is_empty() {
                    break;
                }
            }
            level
        }

        /// The word is the home directory or one of its ancestors, or `~/.config`, `~/Library`, `~/Library/Preferences`: a recursive tool
        /// started there reads the wrangler credential directory without naming it.
        fn reaches_credential_dir(&self, text: &str) -> bool {
            let Some(home) = self.jail.home.as_deref() else { return false };
            if !self.cwd_known && !text.starts_with('/') && !text.starts_with('~') {
                return false;
            }
            let p = paths::resolve(&self.cwd, text, Some(home));
            let home = paths::canonical_lossy(home);
            p == home || (home.starts_with(&p) && !self.jail.contains(&p)) || [".config", "Library", "Library/Preferences"].iter().any(|d| p == home.join(d))
        }

        /// `curl -K cfg` and `wget -i list` read their URLs from a file: a local file that names the Cloudflare API stops the command.
        fn net_config_files(&mut self, base: &str, words: &[Word]) {
            let mut files: Vec<&str> = Vec::new();
            for (i, w) in words.iter().enumerate().skip(1) {
                let t = w.text.as_str();
                let next = words.get(i + 1).map(|n| n.text.as_str());
                match t {
                    "-K" | "--config" | "-i" | "--input-file" => files.extend(next),
                    _ => files.extend(t.strip_prefix("--config=").or_else(|| t.strip_prefix("--input-file="))),
                }
            }
            for f in files.into_iter().filter(|f| *f != "-") {
                let p = paths::resolve(&self.cwd, f, self.jail.home.as_deref());
                if !self.jail.contains(&p) {
                    continue;
                }
                if std::fs::metadata(&p).is_ok_and(|m| m.is_file() && m.len() <= 256 * 1024) && std::fs::read_to_string(&p).is_ok_and(|t| mentions_cf_api(&t)) {
                    self.cf_stop("wrangler.api", &format!("{base} reads the Cloudflare API address from {f}"));
                    return;
                }
            }
        }

        /// Interpreter code in the words, in a heredoc, or piped in (`echo 'require("wrangler")' | node`).
        fn inline_code(&mut self, base: &str, words: &[Word], ctx: &Ctx) {
            let mut code = words[1..].iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
            code.push(' ');
            code.push_str(ctx.stdin_script.as_deref().unwrap_or(""));
            if words.len() == 1 && ctx.piped {
                code.push(' ');
                code.push_str(&self.src);
            }
            let lower = code.to_ascii_lowercase();
            if mentions_wrangler_inline(&code) {
                self.cf_stop("wrangler.inline", &format!("{base} code that runs or loads wrangler"));
            } else if lower.contains("env") && env_name_in_code(&code) {
                self.cf_stop("wrangler.env", &format!("{base} code that reads a Cloudflare or wrangler token variable"));
            } else if secret_in_text(&code).is_some() && ["system", "getline", "popen", "open", "read", "exec", "spawn", "write", "|", "<", ">"].iter().any(|m| lower.contains(*m)) {
                self.cf_stop("wrangler.credentials", &format!("{base} code that opens a credential file"));
            } else if mentions_cf_api(&code) && ["http", "fetch", "request", "socket", "curl", "urllib", "net", "exec", "system", "open"].iter().any(|m| lower.contains(m)) {
                self.cf_stop("wrangler.api", &format!("{base} code that calls the Cloudflare API"));
            }
        }

        /// A local script in a language the walker does not execute: scanned for a spawned wrangler, a token variable or the API host.
        /// Shell scripts are walked as commands instead (`scripts.rs`).
        fn script_file_threat(&mut self, word: &Word) {
            if word.dynamic {
                return;
            }
            let p = paths::resolve(&self.cwd, &word.text, self.jail.home.as_deref());
            if !self.jail.contains(&p) || !std::fs::metadata(&p).is_ok_and(|m| m.is_file() && m.len() <= 256 * 1024) {
                return;
            }
            let Ok(text) = std::fs::read_to_string(&p) else { return };
            let ext = p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
            let head = text.lines().next().unwrap_or("");
            let non_shell = matches!(ext.as_str(), "js" | "mjs" | "cjs" | "ts" | "mts" | "py" | "rb" | "pl" | "php" | "lua")
                || (head.starts_with("#!") && ["node", "python", "ruby", "perl", "php", "deno", "bun", "tsx"].iter().any(|i| head.contains(i)));
            if !non_shell {
                return;
            }
            let rel = p.strip_prefix(&self.jail.cwd).unwrap_or(&p).display().to_string();
            if mentions_wrangler_script(&text) {
                self.cf_stop("wrangler.script", &format!("{rel} spawns wrangler"));
            } else if text.to_ascii_lowercase().contains("env") && env_name_in_code(&text) {
                self.cf_stop("wrangler.script", &format!("{rel} reads a Cloudflare or wrangler token variable"));
            } else if mentions_cf_api(&text) {
                self.cf_stop("wrangler.script", &format!("{rel} calls the Cloudflare API"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jail() -> Jail {
        Jail::new(Path::new("/work/repo"), &[], Some(Path::new("/home/u")))
    }

    fn rule(cmd: &str) -> Option<String> {
        analyze(cmd, &jail()).hard_stop.map(|h| h.rule)
    }

    #[test]
    fn long_option_abbreviations() {
        assert!(long_opt("--hard", "hard", 2));
        assert!(long_opt("--ha", "hard", 2));
        assert!(!long_opt("--h", "hard", 2));
        assert!(long_opt("--all", "all", 1) && long_opt("--al", "all", 1) && long_opt("--a", "all", 1) && !long_opt("--", "all", 1) && !long_opt("--allx", "all", 1));
        assert!(long_opt("--method=POST", "method", 2));
    }

    #[test]
    fn peels_wrappers_to_the_real_command() {
        for cmd in [
            "git commit -m x",
            "/usr/bin/git commit -m x",
            "./bin/git commit",
            "GIT commit",
            "git-commit -m x",
            "env git commit",
            "env -i FOO=1 git commit",
            "env -S 'git commit -m x'",
            "command git commit",
            "command -p git commit",
            "exec git commit",
            "nohup git commit",
            "time git commit",
            "nice -n 5 git commit",
            "timeout 5 git commit",
            "timeout -k 1 5 git commit",
            "sudo -u root git commit",
            "xargs git",
            "find . -exec git commit {} ;",
            "sh -c 'git commit'",
            "bash -lc \"git -C x commit\"",
            "zsh -c 'sh -c \"git push\"'",
            "xcrun git commit",
        ] {
            assert!(rule(cmd).is_some(), "{cmd}");
        }
    }

    #[test]
    fn heredoc_and_herestring_scripts_are_judged_for_shells_only() {
        assert!(rule("bash <<EOF\ngit commit\nEOF").is_some());
        assert!(rule("sh <<< 'git push'").is_some());
        assert!(rule("cat <<EOF\ngit commit\nEOF").is_none());
        let a = analyze("echo 'git commit' | sh", &jail());
        assert!(a.hard_stop.is_none() && a.issues.contains(&"shell reads its script from stdin".to_string()));
    }

    #[test]
    fn unknowns_are_issues_not_hard_stops() {
        for cmd in ["eval \"git commit\"", "$g commit", "git $verb", "sh -c \"$X\"", "echo $(date)", "git -c \"$K\" status"] {
            let a = analyze(cmd, &jail());
            assert!(!a.issues.is_empty(), "{cmd}");
        }
        assert!(analyze("git status", &jail()).issues.is_empty());
        assert!(rule("echo $(git commit -m x)").is_some(), "a hard stop inside a substitution still counts");
    }

    #[test]
    fn cd_is_followed_for_relative_targets() {
        assert_eq!(rule("cd .git && echo x > hooks/pre-commit").as_deref(), Some("fs.protected"));
        assert_eq!(rule("cd src && echo x > ../.husky/pre-commit").as_deref(), Some("fs.protected"));
        assert!(rule("cd src && echo x > out.txt").is_none());
        let a = analyze("cd $D && echo x > out.txt", &jail());
        assert!(a.hard_stop.is_none() && !a.issues.is_empty());
    }

    #[test]
    fn argv_form_is_judged_like_a_string() {
        let j = jail();
        let argv = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(analyze_argv(&argv(&["/usr/bin/git", "push"]), &j).hard_stop.is_some());
        assert!(analyze_argv(&argv(&["sh", "-c", "git commit"]), &j).hard_stop.is_some());
        assert!(analyze_argv(&argv(&["git", "status"]), &j).hard_stop.is_none());
    }
}
