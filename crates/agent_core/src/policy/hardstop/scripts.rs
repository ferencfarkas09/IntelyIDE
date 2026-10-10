//! Script indirection: `npm run x`, `make x`, `bash x.sh`, `node x.js`, `python x.py`, `./x.sh`.
//!
//! The string the model wrote says nothing about what runs, so the script text is resolved and judged: a shell script
//! (a `package.json` script, a make recipe, a `.sh` file) is walked like any command string, so a git write verb or a
//! protected path in it is a hard stop; a script in another language is scanned for git write verbs and protected
//! paths. What is left stays an Ask, now with the resolved text shown (`Analysis::scripts`), and is never a saved allow.

use std::path::{Path, PathBuf};

use super::protected_args::code_tokens;
use crate::policy::fsview;
use super::{mentions_git_write, paths, Walker, Word, SHELLS};

const MAX_SCRIPT_BYTES: u64 = 256 * 1024;
/// How much of a script is shown on the approval card.
const SHOWN_CHARS: usize = 600;
const PM_LIFECYCLE_INSTALL: &[&str] = &["preinstall", "install", "postinstall", "prepare"];
const PM_BUILTINS: &[&str] = &[
    "install", "i", "ci", "add", "remove", "rm", "uninstall", "un", "up", "update", "upgrade", "link", "unlink", "exec", "dlx", "x", "create", "init", "publish", "pack", "audit",
    "outdated", "list", "ls", "why", "config", "cache", "dedupe", "prune", "rebuild", "store", "env", "patch", "import", "set", "get", "info", "login", "logout", "whoami",
    "help", "version", "fetch", "root", "bin", "run", "run-script", "workspaces", "workspace", "-r",
];
/// Hook installers: they write `.husky` or point `core.hooksPath` at a directory the human did not review.
const HOOK_INSTALLERS: &[&str] = &["husky", "simple-git-hooks", "lefthook", "pre-commit", "git-hooks-install"];

fn shown(text: &str) -> String {
    let flat: String = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ; ");
    let mut out: String = flat.chars().take(SHOWN_CHARS).collect();
    if flat.chars().count() > SHOWN_CHARS {
        out.push('…');
    }
    out
}

impl<'a> Walker<'a> {
    pub(super) fn script_indirection(&mut self, base: &str, first: &Word, words: &[Word], depth: usize) {
        if self.a.hard_stop.is_some() {
            return;
        }
        // `base_name(".")` is empty: the dot builtin is the command word itself
        let base = if first.text == "." { "." } else { base };
        if HOOK_INSTALLERS.contains(&base) && words[1..].iter().any(|w| matches!(w.text.as_str(), "install" | "init" | "add" | "set" | "uninstall")) {
            self.stop("hooks.install", &format!("{base} installs or changes git hooks: human-only"));
            return;
        }
        match base {
            "npm" | "pnpm" | "yarn" | "bun" | "cnpm" => self.package_script(base, words, depth),
            "make" | "gmake" => self.make_script(words, depth),
            b if SHELLS.contains(&b) && b != "su" => {
                if let Some(file) = operand_file(words, b) {
                    self.script_file(&file, depth, true);
                }
            }
            "source" | "." => {
                if let Some(file) = words.get(1) {
                    self.script_file(file, depth, true);
                }
            }
            "node" | "nodejs" | "deno" | "bun-run" | "ruby" | "perl" | "php" | "lua" | "tsx" | "ts-node" => {
                if let Some(file) = operand_file(words, base) {
                    self.script_file(&file, depth, false);
                }
            }
            b if b.starts_with("python") => {
                if let Some(file) = operand_file(words, b) {
                    self.script_file(&file, depth, false);
                }
            }
            _ => {
                // `./build.sh`, `scripts/release`: a file inside the working directory run by its path
                if first.text.contains('/') && !first.dynamic {
                    let p = paths::resolve(&self.cwd, &first.text, self.jail.home.as_deref());
                    if self.jail.contains(&p) && fsview::is_file(&p) {
                        self.script_file(first, depth, false);
                    }
                }
            }
        }
    }

    fn run_text(&mut self, label: &str, text: &str, shell: bool, depth: usize) {
        if self.script_stack.iter().any(|s| s == label) || self.script_stack.len() >= 6 {
            return;
        }
        self.a.scripts.push(format!("{label}: {}", shown(text)));
        self.script_stack.push(label.to_string());
        if shell {
            let saved = (self.cwd.clone(), self.cwd_known);
            self.script(text, depth + 1);
            (self.cwd, self.cwd_known) = saved;
        } else {
            if mentions_git_write(text) {
                self.stop("script.git-write", &format!("{label} runs a git write command"));
            }
            if self.a.hard_stop.is_none() {
                for tok in code_tokens(text) {
                    let p = paths::resolve(&self.cwd, tok, self.jail.home.as_deref());
                    if let Some(why) = self.jail.mention_protected_reason(&p) {
                        self.stop("script.protected-path", &format!("{label} names {why} ({tok})"));
                        break;
                    }
                }
            }
            if self.a.hard_stop.is_none() {
                self.script_text_facts(label, text);
            }
        }
        self.script_stack.pop();
    }

    fn script_file(&mut self, word: &Word, depth: usize, shell: bool) {
        if word.dynamic {
            self.issue("script path is not known statically");
            return;
        }
        let p = paths::resolve(&self.cwd, &word.text, self.jail.home.as_deref());
        let Some(meta) = fsview::metadata(&p) else { return };
        if !meta.is_file {
            return;
        }
        // a script the run keeps in its scratch folder (`/tmp/fix.py`) is read like one in a repository: the agent may write both
        if !self.jail.contains(&p) && !self.jail.in_scratch(&p) {
            self.issue("script outside the working directories");
            if !self.a.outside_scripts.contains(&word.text) {
                self.a.outside_scripts.push(word.text.clone());
            }
            return;
        }
        if meta.len > MAX_SCRIPT_BYTES {
            self.issue("script is too large to scan");
            return;
        }
        let Some(text) = fsview::read_to_string_max(&p, MAX_SCRIPT_BYTES as usize) else {
            self.issue("script is not readable text");
            return;
        };
        let ext = p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        let head = text.lines().next().unwrap_or("");
        let is_shell = shell || matches!(ext.as_str(), "sh" | "bash" | "zsh" | "command") || (head.starts_with("#!") && SHELLS.iter().any(|s| head.contains(s)));
        let rel = p.strip_prefix(&self.jail.cwd).unwrap_or(&p).display().to_string();
        let outer_dir = std::mem::replace(&mut self.script_dir, p.parent().map(Path::to_path_buf));
        self.run_text(&rel, &text, is_shell, depth);
        self.script_dir = outer_dir;
    }

    /// Nearest `package.json` from the working directory up to the edge of the jail.
    fn package_json(&self) -> Option<(PathBuf, serde_json::Value)> {
        let mut dir: &Path = &self.cwd;
        loop {
            if self.jail.contains(dir) {
                if let Some(v) = fsview::read_to_string(&dir.join("package.json")).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) {
                    return Some((dir.to_path_buf(), v));
                }
            }
            dir = dir.parent().filter(|p| self.jail.contains(p))?;
        }
    }

    fn package_script(&mut self, base: &str, words: &[Word], depth: usize) {
        let positional: Vec<&Word> = words[1..].iter().take_while(|w| w.text != "--").filter(|w| !w.text.starts_with('-')).collect();
        let Some(sub) = positional.first() else { return };
        if sub.dynamic {
            self.issue("package script name is not known statically");
            return;
        }
        let sub = sub.text.as_str();
        let Some((dir, pkg)) = self.package_json() else { return };
        let scripts = &pkg["scripts"];
        let mut names: Vec<String> = Vec::new();
        match sub {
            "run" | "run-script" | "rum" | "urn" => {
                if let Some(n) = positional.get(1) {
                    if n.dynamic {
                        self.issue("package script name is not known statically");
                        return;
                    }
                    names.push(n.text.clone());
                }
            }
            "test" | "t" | "tst" => names.push("test".into()),
            "start" | "stop" | "restart" => names.push(sub.to_string()),
            "install" | "i" | "ci" | "add" | "update" | "up" | "upgrade" | "rebuild" => names.extend(PM_LIFECYCLE_INSTALL.iter().map(|s| s.to_string())),
            other if base != "npm" && !PM_BUILTINS.contains(&other) => names.push(other.to_string()),
            _ => {}
        }
        for name in names {
            for key in [format!("pre{name}"), name.clone(), format!("post{name}")] {
                let Some(text) = scripts[key.as_str()].as_str() else { continue };
                let label = format!("{} script `{key}`", dir.join("package.json").strip_prefix(&self.jail.cwd).unwrap_or(&dir).display());
                // the same script name in another package would be a different label; key on the directory too
                let label_key = format!("{}#{key}", dir.display());
                if self.script_stack.contains(&label_key) {
                    continue;
                }
                self.script_stack.push(label_key);
                self.a.scripts.push(format!("{label}: {}", shown(text)));
                let saved = (self.cwd.clone(), self.cwd_known);
                self.cwd = dir.clone();
                self.script(text, depth + 1);
                (self.cwd, self.cwd_known) = saved;
                self.script_stack.pop();
            }
        }
    }

    fn make_script(&mut self, words: &[Word], depth: usize) {
        let mut file: Option<String> = None;
        let mut targets: Vec<String> = Vec::new();
        let mut i = 1;
        while let Some(w) = words.get(i) {
            let t = w.text.as_str();
            match t {
                "-f" | "--file" | "--makefile" => {
                    file = words.get(i + 1).map(|w| w.text.clone());
                    i += 2;
                    continue;
                }
                "-C" | "--directory" => {
                    self.issue("make -C runs in another directory");
                    return;
                }
                _ if t.starts_with('-') || t.contains('=') => {}
                _ => {
                    if w.dynamic {
                        self.issue("make target is not known statically");
                        return;
                    }
                    targets.push(t.to_string());
                }
            }
            i += 1;
        }
        let names = file.map(|f| vec![f]).unwrap_or_else(|| ["GNUmakefile", "makefile", "Makefile"].iter().map(|s| s.to_string()).collect());
        let Some((path, text)) = names.iter().find_map(|n| {
            let p = paths::resolve(&self.cwd, n, self.jail.home.as_deref());
            (self.jail.contains(&p) && fsview::is_file(&p)).then(|| fsview::read_to_string(&p).map(|t| (p, t))).flatten()
        }) else {
            return;
        };
        let rules = parse_make(&text);
        let whole = text.lines().any(|l| l.trim_start().starts_with("include ") || l.contains("$(shell") || l.starts_with("define "));
        let mut recipe = String::new();
        if whole || rules.is_empty() {
            recipe = rules.iter().flat_map(|r| r.recipe.iter().cloned()).collect::<Vec<_>>().join("\n");
        } else {
            let wanted: Vec<String> = if targets.is_empty() { rules.first().map(|r| r.names[0].clone()).into_iter().collect() } else { targets };
            let mut seen: Vec<String> = Vec::new();
            let mut queue = wanted;
            while let Some(t) = queue.pop() {
                if seen.contains(&t) || seen.len() > 40 {
                    continue;
                }
                seen.push(t.clone());
                match rules.iter().find(|r| r.names.contains(&t)) {
                    Some(r) => {
                        recipe.push_str(&r.recipe.join("\n"));
                        recipe.push('\n');
                        queue.extend(r.prereqs.iter().cloned());
                    }
                    // a target without a rule here (pattern rule, built-in): look at the whole file to be safe
                    None => recipe = rules.iter().flat_map(|r| r.recipe.iter().cloned()).collect::<Vec<_>>().join("\n"),
                }
            }
        }
        if recipe.trim().is_empty() {
            return;
        }
        let rel = path.strip_prefix(&self.jail.cwd).unwrap_or(&path).display().to_string();
        let label = format!("{rel} (make)");
        self.run_text(&label, &recipe, true, depth);
    }
}

struct MakeRule {
    names: Vec<String>,
    prereqs: Vec<String>,
    recipe: Vec<String>,
}

/// Rules of a Makefile: `a b: p q` plus the tab-indented recipe lines (continuations joined).
fn parse_make(text: &str) -> Vec<MakeRule> {
    let mut rules: Vec<MakeRule> = Vec::new();
    let mut lines = text.lines().peekable();
    while let Some(line) = lines.next() {
        if line.starts_with('\t') {
            if let Some(r) = rules.last_mut() {
                let mut cmd = line.trim_start_matches('\t').to_string();
                while cmd.ends_with('\\') {
                    cmd.pop();
                    match lines.next() {
                        Some(n) => cmd.push_str(n.trim_start_matches('\t')),
                        None => break,
                    }
                }
                r.recipe.push(cmd.trim_start_matches(['@', '-', '+']).to_string());
            }
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((head, tail)) = trimmed.split_once(':') else { continue };
        if tail.starts_with('=') || head.contains(['=', '$', '%']) {
            continue;
        }
        let (prereq_part, inline) = tail.split_once(';').map_or((tail, None), |(a, b)| (a, Some(b)));
        let mut rule = MakeRule {
            names: head.split_whitespace().map(str::to_string).collect(),
            prereqs: prereq_part.split('|').next().unwrap_or("").split_whitespace().map(str::to_string).collect(),
            recipe: Vec::new(),
        };
        if let Some(c) = inline {
            rule.recipe.push(c.trim().to_string());
        }
        if !rule.names.is_empty() {
            rules.push(rule);
        }
    }
    rules
}

/// The script file a runner is given: its first operand, unless inline code (`-e`, `-c`, `-p`, `-m`) or a syntax check
/// replaces it.
fn operand_file(words: &[Word], base: &str) -> Option<Word> {
    let takes_value: &[&str] = match base {
        "node" | "nodejs" => &["-r", "--require", "--import", "--loader", "--env-file", "--experimental-loader"],
        "ruby" => &["-I", "-r"],
        "perl" => &["-I", "-M"],
        b if b.starts_with("python") => &["-W", "-X", "-Q"],
        _ => &["-o", "+o", "--rcfile", "--init-file"],
    };
    let mut i = 1;
    while let Some(w) = words.get(i) {
        let t = w.text.as_str();
        if t == "--" {
            return words.get(i + 1).cloned();
        }
        if !t.starts_with('-') && !t.starts_with('+') || t == "-" {
            return Some(w.clone());
        }
        let inline = matches!(t, "-e" | "-p" | "-c" | "-m" | "--eval" | "--print" | "--check" | "-E" | "-pe" | "-ne" | "-pi") || t.starts_with("--eval=") || t.starts_with("--print=");
        let shell_c = SHELLS.contains(&base) && t.starts_with('-') && !t.starts_with("--") && t.contains('c');
        if inline || shell_c {
            return None;
        }
        i += if takes_value.contains(&t) { 2 } else { 1 };
    }
    None
}
