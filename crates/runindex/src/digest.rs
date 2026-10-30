//! The run summary ("What this run did"): one finished run folded into plain facts the UI turns into sentences. Built
//! deterministically from the JSONL event log, the run's meta file and read-only git (through [`DiffSource`], the same
//! numbers the Morning brief shows); no model is involved. Files are grouped by purpose (screens, styles, tests, config,
//! packages, native iOS / Android, ...), the agent's shell commands are listed (first line only), and risks are typed
//! codes with evidence (paths, package names, host names; never file contents). Every text goes through [`scrub`], every
//! list is capped and the serialized digest stays under [`MAX_BYTES`]. A finished run's digest is cached as
//! `<runs>/<id>.digest.json` (owner-only, written atomically) with a fingerprint of the log, so a changed log rebuilds
//! it. Nothing is ever written into a repository.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::Path;
use std::time::UNIX_EPOCH;

use intely_agent_core::events::types::{AgentEvent, EventKind, ToolKind, ToolStatus};
use serde::{Deserialize, Serialize};

use crate::brief::{brief_run, DiffSource};
use crate::doc::{input_paths, parse_log, scrub, MetaFile};

/// Format of the cached file; a different number rebuilds it.
pub const VERSION: u32 = 1;
/// The serialized digest stays below this size (examples are dropped first).
pub const MAX_BYTES: usize = 64 * 1024;
const MAX_EXAMPLES: usize = 3;
const MAX_COMMANDS: usize = 10;
const MAX_DECISIONS: usize = 8;
const MAX_TODOS: usize = 6;
const MAX_EVIDENCE: usize = 6;
const MAX_REPOS: usize = 20;
const MAX_FAILURES: usize = 3;
const MAX_LINE: usize = 200;

/// The purposes a changed file is grouped by, in the order the UI lists them.
pub const PURPOSES: [&str; 12] = ["ui", "styles", "tests", "config", "dependencies", "docs", "ios", "android", "server", "code", "assets", "other"];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    pub size: u64,
    pub mtime_ms: u64,
}

/// Changed files of one purpose, over all repositories of the run.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    /// One of [`PURPOSES`].
    pub purpose: String,
    pub created: u32,
    pub modified: u32,
    pub deleted: u32,
    /// A few paths (repo-relative; prefixed with the repo id when the run had more than one).
    pub examples: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDigest {
    pub repo_id: String,
    /// `git` (snapshot against the tree), `log` (the files the agent's tools touched; no line numbers) or `none`.
    pub source: String,
    pub file_count: u32,
    pub created: u32,
    pub modified: u32,
    pub deleted: u32,
    pub additions: u32,
    pub deletions: u32,
    /// The purposes of the files changed here (sorted as [`PURPOSES`]).
    pub purposes: Vec<String>,
    /// Native iOS or Android files changed (a rebuild of the app is needed, a reload is not enough).
    pub ios: bool,
    pub android: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    /// The first line of the command, scrubbed and clipped.
    pub text: String,
    pub failed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    /// `plan` (a line of the approved plan), `todo` (an item of the agent's task list) or `final` (its last message).
    pub kind: String,
    pub text: String,
    /// `todo` only: the item was completed.
    #[serde(default)]
    pub done: bool,
}

/// A hint the UI turns into a "what to check" sentence.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// `devServer` | `reinstall` | `iosBuild` | `androidBuild` | `runTests` | `reviewDeleted` | `reviewFailures` | `answerNeeds`
    pub code: String,
    #[serde(default)]
    pub repo_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Risk {
    /// `configTouched` | `lockfileChanged` | `envFileTouched` | `permissionsTouched` | `filesDeleted` | `newDependencies` |
    /// `networkCalls` | `gitHistory` | `failures` | `needsYou`
    pub code: String,
    pub count: u32,
    /// Paths, package names, host names or git subcommands; never contents.
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDigest {
    pub version: u32,
    pub run_id: String,
    pub title: String,
    /// `running` | `done` | `failed` | `cancelled`
    pub status: String,
    pub started_ms: u64,
    pub ended_ms: u64,
    pub generated_ms: u64,
    pub fingerprint: Fingerprint,
    pub file_count: u32,
    pub created: u32,
    pub modified: u32,
    pub deleted: u32,
    pub additions: u32,
    pub deletions: u32,
    pub groups: Vec<Group>,
    pub repos: Vec<RepoDigest>,
    pub commands: Vec<Command>,
    /// Distinct commands seen (the list is capped).
    pub command_count: u32,
    pub decisions: Vec<Decision>,
    pub checks: Vec<Check>,
    pub risks: Vec<Risk>,
    pub failure_count: u32,
    /// The first failure lines (scrubbed), for the explanation prompt.
    pub failures: Vec<String>,
    pub needs_you: u32,
    /// Something was dropped to keep the digest small.
    pub truncated: bool,
}

// ---- helpers --------------------------------------------------------------------------------------------------

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

/// The first non-empty line, bounded before scrubbing (a huge line costs nothing) and clipped after it.
fn line_of(text: &str, max: usize) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let bounded: String = line.chars().take(4 * max).collect();
    clip(scrub(&bounded).trim(), max)
}

/// A plan or todo line without its Markdown decoration (`#`, list markers, emphasis, code ticks).
fn plain_line(line: &str) -> String {
    let mut s = line.trim();
    s = s.trim_start_matches(['#', '-', '*', '>', '+', ' ']);
    let digits = s.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 && s[digits..].starts_with(['.', ')']) {
        s = &s[digits + 1..];
    }
    s.replace("**", "").replace('`', "").trim().to_owned()
}

fn file_name(lower: &str) -> &str {
    lower.rsplit('/').next().unwrap_or(lower)
}

fn ext(name: &str) -> &str {
    name.rsplit_once('.').map_or("", |(_, e)| e)
}

fn has_segment(lower: &str, segs: &[&str]) -> bool {
    let parts: Vec<&str> = lower.split('/').collect();
    parts.len() > 1 && parts[..parts.len() - 1].iter().any(|p| segs.contains(p))
}

const LOCKFILES: [&str; 9] = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "podfile.lock", "cargo.lock", "gemfile.lock", "bun.lockb", "bun.lock", "npm-shrinkwrap.json"];

pub fn is_lockfile(path: &str) -> bool {
    LOCKFILES.contains(&file_name(&path.to_ascii_lowercase()))
}

pub fn is_env_file(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let name = file_name(&lower);
    name == ".env" || name.starts_with(".env.") || name.ends_with(".env")
}

/// Files that grant an app powers on the phone: entitlements always; Info.plist and AndroidManifest.xml are config whose
/// permission part the log may show (see [`grants_permission`]).
fn is_permission_file(lower: &str) -> bool {
    lower.ends_with(".entitlements")
}

fn is_manifest(lower: &str) -> bool {
    let name = file_name(lower);
    name == "info.plist" || name == "androidmanifest.xml"
}

/// Text that adds or changes an app permission (an iOS usage description, an Android `<uses-permission>`).
fn grants_permission(text: &str) -> bool {
    text.contains("UsageDescription") || text.contains("uses-permission") || text.contains("android.permission.")
}

/// Native iOS or Android files: changing them needs a rebuild of the app.
fn touches_ios(lower: &str) -> bool {
    let name = file_name(lower);
    has_segment(lower, &["ios"]) || matches!(ext(name), "swift" | "m" | "mm" | "pbxproj" | "xcodeproj" | "entitlements" | "storyboard" | "xib" | "plist") || name == "podfile" || name == "podfile.lock"
}

fn touches_android(lower: &str) -> bool {
    let name = file_name(lower);
    has_segment(lower, &["android"]) || matches!(ext(name), "kt" | "kts" | "gradle") || name == "androidmanifest.xml" || name == "gradle.properties"
}

/// The purpose of a changed file, one of [`PURPOSES`]. Order matters: a lockfile is a dependency before it is config,
/// a test is a test before it is a screen, a manifest is config before it is native code.
pub fn classify(path: &str) -> &'static str {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    let name = file_name(&lower);
    let e = ext(name);
    let stem_has = |s: &str| name.split('.').any(|p| p == s);
    if LOCKFILES.contains(&name) || matches!(name, "package.json" | "gemfile" | "requirements.txt" | "pipfile" | "pubspec.yaml") || name.starts_with("requirements") && e == "txt" {
        return "dependencies";
    }
    if has_segment(&lower, &["__tests__", "__mocks__", "test", "tests", "e2e", "spec", "androidtest", "uitests"]) || stem_has("test") || stem_has("spec") || name.ends_with("_test.go") || name.ends_with("tests.swift") || name.ends_with("test.kt") || name.ends_with("test.java") {
        return "tests";
    }
    if lower.contains(".xcassets/") || has_segment(&lower, &["drawable", "mipmap", "fonts", "images", "img"]) && !matches!(e, "ts" | "tsx" | "js" | "jsx") {
        return "assets";
    }
    const CONFIG_NAMES: [&str; 14] = ["app.json", "eas.json", "podfile", "info.plist", "androidmanifest.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle.properties", "dockerfile", ".gitignore", ".npmrc", ".nvmrc"];
    const CONFIG_STEMS: [&str; 16] = ["babel", "metro", "vite", "webpack", "tsconfig", "jsconfig", "eslint", ".eslintrc", "prettier", ".prettierrc", "next", "tailwind", "postcss", "jest", "vitest", "app"];
    let first = name.split('.').next().unwrap_or("");
    if CONFIG_NAMES.contains(&name)
        || is_env_file(&lower)
        || e == "entitlements"
        || matches!(e, "yaml" | "yml" | "toml" | "xcconfig" | "properties")
        || (CONFIG_STEMS.contains(&first) || name.starts_with(".eslintrc") || name.starts_with(".prettierrc") || name.starts_with("tsconfig")) && (stem_has("config") || matches!(e, "json" | "js" | "cjs" | "mjs" | "ts") && first != "app" || name.starts_with('.'))
        || e == "json" && (!lower.contains('/') || stem_has("config") || name.ends_with("rc.json"))
        || name.starts_with("docker-compose")
    {
        return "config";
    }
    if matches!(e, "md" | "mdx" | "rst") {
        return "docs";
    }
    if matches!(e, "css" | "scss" | "sass" | "less" | "styl" | "pcss") || name.contains(".styles.") || name.contains(".style.") || first == "styles" || first == "styled" || stem_has("styled") {
        return "styles";
    }
    if matches!(e, "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "ico" | "icns" | "ttf" | "otf" | "woff" | "woff2" | "mp3" | "mp4" | "wav" | "lottie") {
        return "assets";
    }
    if touches_ios(&lower) {
        return "ios";
    }
    if has_segment(&lower, &["android"]) || matches!(e, "kt" | "kts" | "gradle") {
        return "android";
    }
    if matches!(e, "tsx" | "jsx" | "vue" | "svelte" | "astro" | "html") || matches!(name, "app.js" | "app.ts") || matches!(e, "ts" | "js" | "mjs") && has_segment(&lower, &["components", "screens", "pages", "app", "views", "ui", "layouts", "navigation", "hooks"]) {
        return "ui";
    }
    let code = matches!(e, "js" | "ts" | "mjs" | "cjs" | "py" | "go" | "rb" | "php" | "rs" | "cs" | "dart" | "java");
    if code && has_segment(&lower, &["server", "api", "routes", "backend", "functions", "controllers", "middleware", "handlers", "services", "db", "migrations"]) {
        return "server";
    }
    if code || matches!(e, "sh" | "sql" | "graphql") {
        return "code";
    }
    "other"
}

/// A run id the commands accept: letters, digits, `.`, `_`, `-`, at most 64 characters, not starting with a dot.
pub fn valid_run_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && !id.starts_with('.') && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

// ---- commands ---------------------------------------------------------------------------------------------------

fn command_of(input: &serde_json::Value) -> Option<String> {
    let v = input.get("command").or_else(|| input.get("cmd"))?;
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Array(a) => Some(a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" ")),
        _ => None,
    }
    .filter(|s| !s.trim().is_empty())
}

/// `exit code 1` / `Exit status: 2` in a failed tool's output (only the first lines are looked at).
fn exit_code(output: &str) -> Option<i32> {
    for line in output.lines().take(200) {
        let lower = line.to_ascii_lowercase();
        for key in ["exit code", "exit status", "exited with code"] {
            if let Some(at) = lower.find(key) {
                let rest = lower[at + key.len()..].trim_start_matches([' ', ':', '=']);
                let digits: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '-').take(6).collect();
                if let Ok(n) = digits.parse() {
                    return Some(n);
                }
            }
        }
    }
    None
}

/// The simple commands of a shell line (split on `&&`, `||`, `;`, `|` and new lines), as word lists.
fn simple_commands(cmd: &str) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    for part in cmd.split(['\n', ';', '|', '&']) {
        let words: Vec<String> = part.split_whitespace().map(|w| w.trim_matches(['"', '\'', '(', ')', '`']).to_owned()).filter(|w| !w.is_empty()).collect();
        // Leading `VAR=value` assignments and `sudo` / `npx` are not the program.
        let skip = words.iter().take_while(|w| w.contains('=') && !w.starts_with('-') || matches!(w.as_str(), "sudo" | "env" | "time" | "command")).count();
        if words.len() > skip {
            out.push(words[skip..].to_vec());
        }
    }
    out
}

/// A package name as written on an install line, without a version, or None when it is not one.
fn package_name(word: &str, python: bool) -> Option<String> {
    if word.starts_with('-') || word.contains("://") || word.starts_with('.') || word.starts_with('/') || word.contains('=') && !python {
        return None;
    }
    let name = if python {
        word.split(['=', '<', '>', '~', '!', '[', ';']).next().unwrap_or("")
    } else {
        // `@scope/name@1.2.3`, `name@latest`: drop the version, keep the scope's `@`.
        match word.char_indices().skip(1).find(|(_, c)| *c == '@') {
            Some((i, _)) => &word[..i],
            None => word,
        }
    };
    let ok = !name.is_empty() && name.len() <= 100 && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '/' | '.' | '_' | '-'));
    ok.then(|| name.to_owned())
}

/// Packages a shell command installs by name (npm/pnpm/yarn/bun add|install, expo install, pip install, cargo add, gem install).
fn installed_packages(words: &[String]) -> Vec<String> {
    let w: Vec<&str> = words.iter().map(String::as_str).collect();
    let (from, python) = match w.as_slice() {
        ["npm" | "pnpm" | "bun", "add" | "install" | "i", ..] => (2, false),
        ["yarn", "add", ..] | ["cargo", "add", ..] | ["gem", "install", ..] => (2, false),
        ["npx" | "bunx", "expo", "install", ..] => (3, false),
        ["expo", "install", ..] => (2, false),
        ["pip" | "pip3", "install", ..] => (2, true),
        ["python" | "python3", "-m", "pip", "install", ..] => (4, true),
        _ => return Vec::new(),
    };
    let mut out = Vec::new();
    let mut skip_next = false;
    for word in &w[from..] {
        if skip_next {
            skip_next = false;
            continue;
        }
        // Options that take a value (`-r requirements.txt`, `--registry <url>`, `-w <pkg>`).
        if matches!(*word, "-r" | "--requirement" | "--registry" | "-w" | "--workspace" | "--filter" | "-F" | "--prefix" | "-C" | "--index-url" | "-i") {
            skip_next = true;
            continue;
        }
        if let Some(n) = package_name(word, python) {
            out.push(n);
        }
    }
    out
}

/// The host of an `http(s)://` URL, without user info or port.
pub fn host_of(url: &str) -> Option<String> {
    let at = url.find("://")?;
    let scheme = url[..at].to_ascii_lowercase();
    if !scheme.ends_with("http") && !scheme.ends_with("https") && !scheme.ends_with("ws") && !scheme.ends_with("wss") {
        return None;
    }
    let rest = &url[at + 3..];
    let auth = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = auth.rsplit('@').next().unwrap_or("");
    let host = if host.starts_with('[') { host.split(']').next().map(|h| format!("{h}]")).unwrap_or_default() } else { host.split(':').next().unwrap_or("").to_owned() };
    let host = host.to_ascii_lowercase();
    let ok = !host.is_empty() && host.len() <= 253 && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '[' | ']' | ':'));
    ok.then_some(host)
}

/// The git subcommand of a word list starting with `git`, skipping global options (`-C dir`, `-c k=v`, `--no-pager`).
fn git_subcommand(words: &[String]) -> Option<&str> {
    if words.first().map(String::as_str) != Some("git") {
        return None;
    }
    let mut i = 1;
    while i < words.len() {
        let w = words[i].as_str();
        if w == "-C" || w == "-c" || w == "--git-dir" || w == "--work-tree" {
            i += 2;
        } else if w.starts_with('-') {
            i += 1;
        } else {
            return Some(w);
        }
    }
    None
}

// ---- building ---------------------------------------------------------------------------------------------------

#[derive(Default)]
struct Bag {
    /// Ordered, deduplicated, capped evidence and the true count.
    items: Vec<String>,
    seen: BTreeSet<String>,
    count: u32,
}

impl Bag {
    fn add(&mut self, item: String) {
        if item.is_empty() || !self.seen.insert(item.clone()) {
            return;
        }
        self.count += 1;
        if self.items.len() < MAX_EVIDENCE {
            self.items.push(item);
        }
    }

    fn risk(self, code: &str) -> Option<Risk> {
        (self.count > 0).then(|| Risk { code: code.into(), count: self.count, evidence: self.items })
    }
}

/// A file a tool of the log changed (used when git cannot say).
struct LogFile {
    change: &'static str,
}

/// Facts the event log alone gives.
#[derive(Default)]
struct LogFacts {
    commands: Vec<Command>,
    command_count: u32,
    decisions: Vec<Decision>,
    files: BTreeMap<String, LogFile>,
    /// Paths whose new content in the log adds an app permission.
    permission_paths: BTreeSet<String>,
    packages: Bag,
    hosts: Bag,
    network_calls: u32,
    git: Bag,
    chmod: Bag,
}

/// Records a command line once; returns it so the tool's result can mark it failed.
fn push_command(f: &mut LogFacts, seen: &mut BTreeMap<String, usize>, text: String) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    if !seen.contains_key(&text) {
        f.command_count += 1;
        let slot = if f.commands.len() < MAX_COMMANDS {
            f.commands.push(Command { text: text.clone(), failed: false, exit_code: None });
            f.commands.len() - 1
        } else {
            usize::MAX
        };
        seen.insert(text.clone(), slot);
    }
    Some(text)
}

fn read_log(events: &[AgentEvent]) -> LogFacts {
    let mut f = LogFacts::default();
    let mut seen_cmds: BTreeMap<String, usize> = BTreeMap::new();
    let mut cmd_of_tool: BTreeMap<String, String> = BTreeMap::new();
    let mut pending: BTreeMap<String, (ToolKind, Vec<String>, bool)> = BTreeMap::new();
    let mut plan: Vec<Decision> = Vec::new();
    let mut todos: Vec<Decision> = Vec::new();
    let mut last_reply: Option<String> = None;
    for e in events {
        match &e.kind {
            EventKind::ToolStart { tool_id, name, tool_kind, input, .. } => {
                let cmd = if matches!(tool_kind, ToolKind::Exec) { command_of(input) } else { None };
                if let Some(cmd) = cmd {
                    // Facts from the whole command, never stored as such: package names, hosts, git subcommands.
                    let bounded: String = cmd.chars().take(16_000).collect();
                    for words in simple_commands(&bounded) {
                        for p in installed_packages(&words) {
                            f.packages.add(scrub(&p));
                        }
                        if let Some(sub) = git_subcommand(&words).filter(|s| matches!(*s, "commit" | "push" | "reset" | "rebase")) {
                            f.git.add(format!("git {sub}"));
                        }
                        let prog = words[0].rsplit('/').next().unwrap_or("");
                        if prog == "chmod" || prog == "chown" {
                            f.chmod.add(prog.to_owned());
                        }
                        if matches!(prog, "curl" | "wget" | "http" | "https" | "xh" | "Invoke-WebRequest" | "iwr") {
                            f.network_calls += 1;
                            let hosts: Vec<String> = words.iter().filter_map(|w| host_of(w)).collect();
                            if hosts.is_empty() {
                                f.hosts.add(prog.to_owned());
                            }
                            for h in hosts {
                                f.hosts.add(scrub(&h));
                            }
                        }
                    }
                    if let Some(text) = push_command(&mut f, &mut seen_cmds, line_of(&cmd, MAX_LINE)) {
                        cmd_of_tool.insert(tool_id.clone(), text);
                    }
                    continue;
                }
                if matches!(tool_kind, ToolKind::Fetch) || matches!(name.as_str(), "WebFetch" | "WebSearch" | "web_fetch" | "web_search") {
                    f.network_calls += 1;
                    if let Some(h) = input.get("url").and_then(|v| v.as_str()).and_then(host_of) {
                        f.hosts.add(scrub(&h));
                    }
                }
                if name == "TodoWrite" {
                    if let Some(items) = input.get("todos").and_then(|v| v.as_array()) {
                        todos = items
                            .iter()
                            .filter_map(|t| Some((t.get("content")?.as_str()?, t.get("status").and_then(|s| s.as_str()) == Some("completed"))))
                            .map(|(c, done)| Decision { kind: "todo".into(), text: line_of(&plain_line(c), 160), done })
                            .filter(|d| !d.text.is_empty())
                            .take(MAX_TODOS)
                            .collect();
                    }
                }
                if matches!(tool_kind, ToolKind::Edit | ToolKind::Delete | ToolKind::Move) {
                    let text = serde_json::to_string(input).unwrap_or_default();
                    pending.insert(tool_id.clone(), (*tool_kind, input_paths(input), grants_permission(&text)));
                }
            }
            EventKind::ToolResult { tool_id, status, output, diff, .. } => {
                if matches!(status, ToolStatus::Error) {
                    if let Some(i) = cmd_of_tool.get(tool_id).and_then(|t| seen_cmds.get(t)).copied().filter(|i| *i != usize::MAX) {
                        f.commands[i].failed = true;
                        f.commands[i].exit_code = output.as_deref().and_then(exit_code);
                    }
                }
                let Some((kind, mut paths, mut perm)) = pending.remove(tool_id) else { continue };
                if !matches!(status, ToolStatus::Ok) {
                    continue;
                }
                let mut change = if matches!(kind, ToolKind::Delete) { "deleted" } else { "modified" };
                if let Some(d) = diff {
                    if d.old.is_none() && change == "modified" {
                        change = "created";
                    }
                    perm |= grants_permission(&d.new);
                    if !paths.contains(&d.path) {
                        paths.push(d.path.clone());
                    }
                }
                for p in paths {
                    let p = scrub(&p);
                    if perm {
                        f.permission_paths.insert(p.clone());
                    }
                    let entry = f.files.entry(p).or_insert(LogFile { change });
                    // created then edited stays created; anything then deleted is deleted.
                    if change == "deleted" {
                        entry.change = "deleted";
                    }
                }
            }
            EventKind::PermissionRequest { plan: Some(p), .. } => {
                plan = p.lines().take(400).map(plain_line).filter(|l| l.chars().any(char::is_alphanumeric)).take(3).map(|l| Decision { kind: "plan".into(), text: line_of(&l, 160), done: false }).collect();
            }
            EventKind::Plan { items } => {
                todos = items.iter().map(|i| Decision { kind: "todo".into(), text: line_of(&plain_line(&i.content), 160), done: i.status.as_deref() == Some("completed") }).filter(|d| !d.text.is_empty()).take(MAX_TODOS).collect();
            }
            EventKind::TextDone { text, parent_tool_id: None, .. } if !text.trim().is_empty() => last_reply = Some(text.clone()),
            _ => {}
        }
    }
    let mut seen = BTreeSet::new();
    let final_line = last_reply.map(|t| Decision { kind: "final".into(), text: line_of(&t.lines().take(400).map(plain_line).find(|l| !l.is_empty()).unwrap_or_default(), MAX_LINE), done: false });
    f.decisions = plan.into_iter().chain(todos).chain(final_line).filter(|d| !d.text.is_empty() && seen.insert(d.text.clone())).take(MAX_DECISIONS).collect();
    f
}

/// One changed file as the digest counts it.
struct Changed {
    repo: String,
    path: String,
    change: String,
}

fn rel_path<'a>(path: &'a str, repo_path: &str) -> Option<&'a str> {
    let base = repo_path.trim_end_matches('/');
    if base.is_empty() {
        return None;
    }
    path.strip_prefix(base).and_then(|r| r.strip_prefix('/'))
}

/// A path for display: relative when it lies in a repo, otherwise its last two parts (never a home directory).
fn short_path(path: &str) -> String {
    if !path.starts_with('/') && !path.contains(":\\") {
        return path.to_owned();
    }
    let parts: Vec<&str> = path.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    parts[parts.len().saturating_sub(2)..].join("/")
}

/// The digest of a run from its events, meta and git. Pure apart from `git`; `fingerprint` and `generated_ms` are the caller's.
pub fn digest_run(id: &str, events: &[AgentEvent], meta: Option<&MetaFile>, git: &dyn DiffSource) -> RunDigest {
    let brief = brief_run(id, events, meta, git);
    let log = read_log(events);
    let repo_paths: Vec<(String, String)> = meta.map(|m| m.repos.iter().map(|r| (r.id.clone(), r.path.clone())).collect()).unwrap_or_default();

    let mut changed: Vec<Changed> = Vec::new();
    let mut repos: Vec<RepoDigest> = Vec::new();
    let single = brief.repos.len() <= 1;
    for r in &brief.repos {
        let mut rd = RepoDigest { repo_id: r.repo_id.clone(), source: "git".into(), ..RepoDigest::default() };
        if r.note.is_none() {
            rd.file_count = r.file_count;
            rd.additions = r.additions;
            rd.deletions = r.deletions;
            for f in &r.files {
                changed.push(Changed { repo: r.repo_id.clone(), path: scrub(&f.path), change: f.change.clone() });
            }
            // Beyond the brief's listed files only the count is known: they count as modified.
            rd.modified += r.file_count.saturating_sub(r.files.len() as u32);
        } else {
            // No snapshot or no git: the files the agent's tools touched in this repo.
            let base = repo_paths.iter().find(|(rid, _)| rid == &r.repo_id).map(|(_, p)| p.as_str()).unwrap_or("");
            rd.source = "log".into();
            for (p, lf) in &log.files {
                let rel = rel_path(p, base).map(str::to_owned).or_else(|| (single && !p.starts_with('/')).then(|| p.clone())).or_else(|| (single && repo_paths.len() <= 1).then(|| short_path(p)));
                if let Some(rel) = rel {
                    rd.file_count += 1;
                    changed.push(Changed { repo: r.repo_id.clone(), path: rel, change: lf.change.into() });
                }
            }
            if rd.file_count == 0 {
                rd.source = "none".into();
            }
        }
        repos.push(rd);
    }
    // A run without repos (no meta): the files of the log, under no repo.
    if brief.repos.is_empty() && !log.files.is_empty() {
        let mut rd = RepoDigest { source: "log".into(), ..RepoDigest::default() };
        for (p, lf) in &log.files {
            rd.file_count += 1;
            changed.push(Changed { repo: String::new(), path: short_path(p), change: lf.change.into() });
        }
        repos.push(rd);
    }

    let mut groups: BTreeMap<&'static str, Group> = BTreeMap::new();
    let mut config = Bag::default();
    let mut lockfiles = Bag::default();
    let mut env = Bag::default();
    let mut perms = Bag::default();
    let mut deleted = Bag::default();
    let mut repo_purposes: BTreeMap<String, BTreeSet<&'static str>> = BTreeMap::new();
    let mut repo_native: BTreeMap<String, (bool, bool)> = BTreeMap::new();
    let mut deps_repos: BTreeSet<String> = BTreeSet::new();
    let multi = repos.len() > 1;
    for c in &changed {
        let purpose = classify(&c.path);
        let shown = if multi && !c.repo.is_empty() { format!("{}/{}", c.repo, c.path) } else { c.path.clone() };
        let shown = clip(&shown, 160);
        let g = groups.entry(purpose).or_insert_with(|| Group { purpose: purpose.into(), ..Group::default() });
        match c.change.as_str() {
            "created" => g.created += 1,
            "deleted" => g.deleted += 1,
            _ => g.modified += 1,
        }
        if g.examples.len() < MAX_EXAMPLES {
            g.examples.push(shown.clone());
        }
        if let Some(rd) = repos.iter_mut().find(|r| r.repo_id == c.repo) {
            match c.change.as_str() {
                "created" => rd.created += 1,
                "deleted" => rd.deleted += 1,
                _ => rd.modified += 1,
            }
        }
        repo_purposes.entry(c.repo.clone()).or_default().insert(purpose);
        let lower = c.path.replace('\\', "/").to_ascii_lowercase();
        let native = repo_native.entry(c.repo.clone()).or_default();
        native.0 |= touches_ios(&lower);
        native.1 |= touches_android(&lower);
        if c.change == "deleted" {
            deleted.add(shown.clone());
        }
        if is_lockfile(&c.path) {
            lockfiles.add(shown.clone());
            deps_repos.insert(c.repo.clone());
        } else if file_name(&lower) == "package.json" {
            deps_repos.insert(c.repo.clone());
        }
        let log_perm = log.permission_paths.iter().any(|p| p == &c.path || p.ends_with(&format!("/{}", c.path)));
        if is_env_file(&c.path) {
            env.add(shown.clone());
        } else if is_permission_file(&lower) || is_manifest(&lower) && log_perm {
            perms.add(shown.clone());
        } else if purpose == "config" {
            config.add(shown.clone());
        }
    }
    for rd in &mut repos {
        let set = repo_purposes.get(&rd.repo_id).cloned().unwrap_or_default();
        rd.purposes = PURPOSES.iter().filter(|p| set.contains(*p)).map(|p| (*p).to_owned()).collect();
        let (ios, android) = repo_native.get(&rd.repo_id).copied().unwrap_or_default();
        rd.ios = ios;
        rd.android = android;
    }

    // What to check, per repo.
    let ids_where = |pred: &dyn Fn(&RepoDigest) -> bool| -> Vec<String> { repos.iter().filter(|r| pred(r)).map(|r| r.repo_id.clone()).collect() };
    let has = |r: &RepoDigest, ps: &[&str]| r.purposes.iter().any(|p| ps.contains(&p.as_str()));
    let mut checks = Vec::new();
    // A run without repositories in its meta has one unnamed entry: the check applies, without a repository id.
    let mut check = |code: &str, repo_ids: Vec<String>, always: bool| {
        if always || !repo_ids.is_empty() {
            checks.push(Check { code: code.into(), repo_ids: repo_ids.into_iter().filter(|r| !r.is_empty()).collect() });
        }
    };
    let installs = log.packages.count > 0;
    check("reinstall", ids_where(&|r| deps_repos.contains(&r.repo_id) || installs && repos.len() == 1 && r.file_count > 0), false);
    check("devServer", ids_where(&|r| has(r, &["ui", "styles", "assets"]) || deps_repos.contains(&r.repo_id)), false);
    check("iosBuild", ids_where(&|r| r.ios), false);
    check("androidBuild", ids_where(&|r| r.android), false);
    check("runTests", ids_where(&|r| has(r, &["tests", "server", "code", "ui"])), false);
    if deleted.count > 0 {
        check("reviewDeleted", Vec::new(), true);
    }
    if brief.failure_count > 0 {
        check("reviewFailures", Vec::new(), true);
    }
    if !brief.needs_you.is_empty() {
        check("answerNeeds", Vec::new(), true);
    }

    let mut perms_all = perms;
    for c in log.chmod.items {
        perms_all.add(c);
    }
    let mut risks: Vec<Risk> = [
        env.risk("envFileTouched"),
        perms_all.risk("permissionsTouched"),
        log.packages.risk("newDependencies"),
        lockfiles.risk("lockfileChanged"),
        config.risk("configTouched"),
        deleted.risk("filesDeleted"),
        log.git.risk("gitHistory"),
    ]
    .into_iter()
    .flatten()
    .collect();
    if log.network_calls > 0 {
        risks.push(Risk { code: "networkCalls".into(), count: log.network_calls, evidence: log.hosts.items });
    }
    if brief.failure_count > 0 {
        risks.push(Risk { code: "failures".into(), count: brief.failure_count, evidence: Vec::new() });
    }
    if !brief.needs_you.is_empty() {
        risks.push(Risk { code: "needsYou".into(), count: brief.needs_you.len() as u32, evidence: Vec::new() });
    }

    let groups: Vec<Group> = PURPOSES.iter().filter_map(|p| groups.remove(p)).collect();
    let repos: Vec<RepoDigest> = repos.into_iter().take(MAX_REPOS).collect();
    let mut d = RunDigest {
        version: VERSION,
        run_id: id.to_owned(),
        title: clip(&brief.title, 120),
        status: brief.status,
        started_ms: brief.started_ms,
        ended_ms: brief.ended_ms,
        file_count: repos.iter().map(|r| r.file_count).sum(),
        created: groups.iter().map(|g| g.created).sum(),
        modified: 0,
        deleted: groups.iter().map(|g| g.deleted).sum(),
        additions: repos.iter().map(|r| r.additions).sum(),
        deletions: repos.iter().map(|r| r.deletions).sum(),
        groups,
        repos,
        commands: log.commands,
        command_count: log.command_count,
        decisions: log.decisions,
        checks,
        risks,
        failure_count: brief.failure_count,
        failures: brief.failures.iter().take(MAX_FAILURES).map(|f| clip(&f.text, MAX_LINE)).collect(),
        needs_you: brief.needs_you.len() as u32,
        ..RunDigest::default()
    };
    d.modified = d.file_count.saturating_sub(d.created + d.deleted);
    cap_size(&mut d);
    d
}

/// Keeps the serialized digest under [`MAX_BYTES`]: examples go first, then evidence, then commands and decisions.
fn cap_size(d: &mut RunDigest) {
    let size = |d: &RunDigest| serde_json::to_vec(d).map_or(usize::MAX, |v| v.len());
    if size(d) <= MAX_BYTES {
        return;
    }
    d.truncated = true;
    for g in &mut d.groups {
        g.examples.clear();
    }
    if size(d) <= MAX_BYTES {
        return;
    }
    for r in &mut d.risks {
        r.evidence.truncate(2);
    }
    for c in &mut d.commands {
        c.text = clip(&c.text, 80);
    }
    for x in &mut d.decisions {
        x.text = clip(&x.text, 80);
    }
    d.failures.truncate(1);
    while size(d) > MAX_BYTES && (!d.commands.is_empty() || !d.decisions.is_empty() || d.repos.len() > 1) {
        d.commands.pop();
        d.decisions.pop();
        if d.repos.len() > 1 {
            d.repos.pop();
        }
    }
    if size(d) > MAX_BYTES {
        d.title = clip(&d.title, 40);
        d.failures.clear();
        for r in &mut d.risks {
            r.evidence.clear();
        }
    }
}

// ---- files --------------------------------------------------------------------------------------------------------

fn log_path(runs_dir: &Path, id: &str) -> std::path::PathBuf {
    runs_dir.join(format!("{id}.jsonl"))
}

pub fn digest_path(runs_dir: &Path, id: &str) -> std::path::PathBuf {
    runs_dir.join(format!("{id}.digest.json"))
}

fn fingerprint(path: &Path) -> Option<Fingerprint> {
    let m = fs::metadata(path).ok()?;
    let mtime_ms = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
    Some(Fingerprint { size: m.len(), mtime_ms })
}

/// Builds the digest of run `id` from `<runs>/<id>.jsonl` (and its meta file). None when the log is missing.
pub fn build(runs_dir: &Path, id: &str, git: &dyn DiffSource, now_ms: u64) -> Option<RunDigest> {
    let path = log_path(runs_dir, id);
    let fp = fingerprint(&path)?;
    let text = fs::read_to_string(&path).ok()?;
    let meta = fs::read(runs_dir.join(format!("{id}.meta.json"))).ok().and_then(|b| serde_json::from_slice::<MetaFile>(&b).ok());
    let mut d = digest_run(id, &parse_log(&text), meta.as_ref(), git);
    d.fingerprint = fp;
    d.generated_ms = now_ms;
    Some(d)
}

/// The cached digest when it matches the log, else a fresh one, stored when the run has finished (a running run's
/// digest is returned but not stored). `refresh` ignores the cache. None when the log is missing (a stale cache is removed).
pub fn load_or_build(runs_dir: &Path, id: &str, git: &dyn DiffSource, now_ms: u64, refresh: bool) -> Option<RunDigest> {
    if !valid_run_id(id) {
        return None;
    }
    let cache = digest_path(runs_dir, id);
    let Some(fp) = fingerprint(&log_path(runs_dir, id)) else {
        let _ = fs::remove_file(&cache);
        return None;
    };
    if !refresh {
        let cached = fs::read(&cache).ok().filter(|b| b.len() <= 2 * MAX_BYTES).and_then(|b| serde_json::from_slice::<RunDigest>(&b).ok());
        if let Some(c) = cached.filter(|c| c.version == VERSION && c.fingerprint == fp && c.run_id == id) {
            return Some(c);
        }
    }
    let d = build(runs_dir, id, git, now_ms)?;
    if d.status != "running" {
        let _ = save(&cache, &d);
    }
    Some(d)
}

/// Writes the digest owner-only and atomically (temp file, then rename).
pub fn save(path: &Path, d: &RunDigest) -> io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(d).map_err(io::Error::other)?;
    write_private(&tmp, &bytes)?;
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
    f.write_all(bytes)?;
    intely_core::sys::set_mode_best_effort(path, 0o600);
    Ok(())
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::write(path, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_grouped_by_purpose() {
        let cases = [
            ("src/components/Button.tsx", "ui"),
            ("app/(tabs)/index.tsx", "ui"),
            ("src/screens/Home.js", "ui"),
            ("src/App.css", "styles"),
            ("src/theme.module.scss", "styles"),
            ("src/Button.styles.ts", "styles"),
            ("src/__tests__/cart.ts", "tests"),
            ("src/cart.test.tsx", "tests"),
            ("e2e/login.spec.ts", "tests"),
            ("package.json", "dependencies"),
            ("package-lock.json", "dependencies"),
            ("ios/Podfile.lock", "dependencies"),
            ("yarn.lock", "dependencies"),
            ("tsconfig.json", "config"),
            ("babel.config.js", "config"),
            ("metro.config.js", "config"),
            ("vite.config.ts", "config"),
            (".eslintrc.json", "config"),
            ("app.json", "config"),
            ("ios/Podfile", "config"),
            ("ios/App/Info.plist", "config"),
            ("android/app/src/main/AndroidManifest.xml", "config"),
            ("android/app/build.gradle", "config"),
            ("ios/App/App.entitlements", "config"),
            (".env.local", "config"),
            ("docs/setup.md", "docs"),
            ("README.md", "docs"),
            ("ios/App/AppDelegate.swift", "ios"),
            ("ios/App.xcodeproj/project.pbxproj", "ios"),
            ("android/app/src/main/java/com/app/MainActivity.kt", "android"),
            ("server/routes/orders.js", "server"),
            ("src/api/client.ts", "server"),
            ("src/utils/format.ts", "code"),
            ("assets/logo.png", "assets"),
            ("ios/App/Images.xcassets/AppIcon.appiconset/Contents.json", "assets"),
            ("src/fonts/Inter.woff2", "assets"),
            ("LICENSE", "other"),
        ];
        for (p, want) in cases {
            assert_eq!(classify(p), want, "{p}");
        }
    }

    #[test]
    fn install_lines_give_names_without_versions() {
        let words = |s: &str| simple_commands(s).remove(0);
        assert_eq!(installed_packages(&words("npm install axios@1.7.2 --save")), vec!["axios"]);
        assert_eq!(installed_packages(&words("pnpm add -D @types/node@20 vitest")), vec!["@types/node", "vitest"]);
        assert_eq!(installed_packages(&words("yarn add react-native-maps")), vec!["react-native-maps"]);
        assert_eq!(installed_packages(&words("pip install requests==2.31 'flask>=3'")), vec!["requests", "flask"]);
        assert_eq!(installed_packages(&words("pip install -r requirements.txt")), Vec::<String>::new());
        assert_eq!(installed_packages(&words("npx expo install expo-camera")), vec!["expo-camera"]);
        assert_eq!(installed_packages(&words("cargo add serde")), vec!["serde"]);
        assert_eq!(installed_packages(&words("npm install")), Vec::<String>::new());
        assert_eq!(installed_packages(&words("npm install https://x.example/pkg.tgz ./local")), Vec::<String>::new());
        assert_eq!(installed_packages(&words("NODE_ENV=dev npm i lodash")), vec!["lodash"]);
    }

    #[test]
    fn hosts_drop_user_info_ports_and_paths() {
        assert_eq!(host_of(&format!("https://{}@API.example.com:8443/v1?token=x", ["user", "pw"].join(":"))).as_deref(), Some("api.example.com"));
        assert_eq!(host_of("http://localhost:3000/").as_deref(), Some("localhost"));
        assert_eq!(host_of("ftp://x.example").as_deref(), None);
        assert_eq!(host_of("example.com").as_deref(), None);
    }

    #[test]
    fn git_subcommands_skip_global_options() {
        let w = |s: &str| simple_commands(s).remove(0);
        assert_eq!(git_subcommand(&w("git -C repo -c user.name=x commit -m hi")), Some("commit"));
        assert_eq!(git_subcommand(&w("git --no-pager log")), Some("log"));
        assert_eq!(git_subcommand(&w("gitk")), None);
    }

    #[test]
    fn run_ids_are_validated() {
        assert!(valid_run_id("a-1730000000000-3"));
        for bad in ["", "../x", "a/b", "a\\b", ".hidden", "a b", &"x".repeat(65)] {
            assert!(!valid_run_id(bad), "{bad}");
        }
    }

    #[test]
    fn exit_codes_are_read_from_failed_output() {
        assert_eq!(exit_code("npm ERR!\nExit code 1"), Some(1));
        assert_eq!(exit_code("Command exited with code 127"), Some(127));
        assert_eq!(exit_code("nothing"), None);
    }
}
