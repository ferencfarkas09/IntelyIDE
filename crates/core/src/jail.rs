//! The test jail: technical guards against a mutation of (or a push from) a repo that must not be touched.
//! See docs/safety.md.
//!
//! Resolved from the environment once ([`Jail::global`]):
//! - `INTELY_READONLY=1`: every mutating command is refused (`readOnly`), and so is all network access.
//! - `INTELY_E2E=1` (or any run with `INTELY_E2E_SCRIPT`): mutations are allowed only in repos whose canonical path is
//!   under the fixture root (`INTELY_FIXTURE_ROOT`, else the temp dir), and remotes must be local paths under it
//!   (`testJail`).
//!
//! Enforced twice: by the engine entry points (before a run is queued) and by the git exec layer (before any process
//! is spawned), so a bug in a higher layer cannot bypass it. In an active jail the git environment is hardened too
//! ([`Jail::env`], [`Jail::config_args`]): no credentials can be found and no protocol but `file` is allowed.

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};

use crate::EngineError;

/// Mode `INTELY_READONLY`: a mutation was attempted.
pub const READ_ONLY: &str = "readOnly";
/// Mode `INTELY_E2E`: a mutation outside the fixture root, or a remote that is not a local fixture path.
pub const TEST_JAIL: &str = "testJail";
/// A push to a live branch without the typed confirmation (or with `--no-verify`).
pub const LIVE_BRANCH_CONFIRM: &str = "liveBranchConfirm";
/// A git process that an agent originated asked for something that is not on the agent allow-list.
pub const AGENT_GIT: &str = "agentGit";

/// Who asked for a git process. The IDE's own commit/push/pull buttons are [`Origin::Human`] (the deny-list guard and
/// the jail apply); anything started on behalf of an agent is [`Origin::Agent`] and passes only [`check_agent_git`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Origin {
    #[default]
    Human,
    Agent,
}

/// Subcommands an agent-originated git process may run (read-only; `add` for explicit files).
const AGENT_GIT_ALLOW: [&str; 20] = [
    "status", "diff", "log", "show", "blame", "rev-parse", "ls-files", "ls-tree", "cat-file", "describe", "shortlog", "rev-list", "grep", "merge-base", "show-ref", "for-each-ref",
    "name-rev", "diff-tree", "branch", "add",
];
/// Long options that write a file or run a program (abbreviations of at least 3 letters count).
const AGENT_GIT_DANGEROUS: [&str; 7] = ["output", "ext-diff", "open-files-in-pager", "upload-pack", "receive-pack", "exec-path", "no-index"];

/// The allow-list for agent-originated git (docs/safety.md, layer 3b): unlike the deny-list for the IDE's own git, a
/// subcommand or option that is not named here is refused.
pub fn check_agent_git(args: &[&str]) -> Result<(), EngineError> {
    let refuse = |why: String| Err(EngineError::new(AGENT_GIT, format!("agent git: {why} (agents read the repository; commits, pushes and other changes are made by the human in the IDE)")));
    let mut i = 0;
    while let Some(a) = args.get(i) {
        match *a {
            "--no-pager" | "--no-optional-locks" | "--no-replace-objects" | "--literal-pathspecs" => i += 1,
            t if t.starts_with('-') => return refuse(format!("global option {t} is not allowed")),
            _ => break,
        }
    }
    let Some(&sub) = args.get(i) else { return refuse("no subcommand".into()) };
    let rest = &args[i + 1..];
    let before_dd: Vec<&str> = rest.iter().copied().take_while(|a| *a != "--").collect();
    for a in &before_dd {
        if let Some(name) = a.strip_prefix("--") {
            let name = name.split('=').next().unwrap_or("");
            if name.len() >= 3 && AGENT_GIT_DANGEROUS.iter().any(|d| d.starts_with(name)) {
                return refuse(format!("option {a} can write files or run programs"));
            }
        } else if a.starts_with("-O") || *a == "-o" {
            return refuse(format!("option {a} can write files or run programs"));
        }
    }
    let flags: Vec<&str> = before_dd.iter().copied().filter(|a| a.starts_with('-')).collect();
    let positionals: Vec<&str> = before_dd.iter().copied().filter(|a| !a.starts_with('-')).collect();
    let has = |names: &[&str]| flags.iter().any(|f| names.contains(f));
    match sub {
        "branch" => {
            let write = has(&["-d", "-D", "-m", "-M", "-c", "-C", "-f", "--delete", "--move", "--copy", "--force", "--set-upstream-to", "-u", "--unset-upstream", "--edit-description"]);
            if write || (!has(&["--list", "-l"]) && !positionals.is_empty() && !has(&["--contains", "--no-contains", "--merged", "--no-merged", "--points-at"])) {
                return refuse("git branch may only list branches".into());
            }
        }
        "add" => {
            if rest.is_empty() || flags.iter().any(|f| *f != "--") {
                return refuse("git add takes explicit file names and no options".into());
            }
            if rest.iter().filter(|a| **a != "--").any(|p| p.is_empty() || p.starts_with(':') || p.contains(['*', '?', '[', '\\']) || matches!(*p, "." | "..") || p.ends_with('/')) {
                return refuse("git add of a glob, magic pathspec or directory".into());
            }
        }
        "config" => {
            if !has(&["--get", "--get-all", "--get-regexp", "--get-urlmatch", "-l", "--list"]) {
                return refuse("git config is read-only for agents (--get, --list)".into());
            }
        }
        "remote" => {
            let ok = match positionals.first().copied() {
                None => flags.iter().all(|f| matches!(*f, "-v" | "--verbose")),
                Some("get-url") => flags.iter().all(|f| matches!(*f, "--push" | "--all")),
                Some(_) => false,
            };
            if !ok {
                return refuse("git remote may only list remotes or print a URL".into());
            }
        }
        "stash" => {
            if !matches!(positionals.first().copied(), Some("list" | "show")) {
                return refuse("only git stash list/show is allowed".into());
            }
        }
        "tag" => {
            let list = has(&["-l", "--list"]) || positionals.is_empty() || has(&["--contains", "--no-contains", "--merged", "--no-merged", "--points-at"]);
            if !list || has(&["-d", "-f", "-a", "-s", "-u", "-m", "--delete", "--force", "--annotate", "--sign"]) {
                return refuse("git tag may only list tags".into());
            }
        }
        "reflog" => {
            if !matches!(positionals.first().copied(), None | Some("show" | "exists")) {
                return refuse("git reflog expire/delete is not allowed".into());
            }
        }
        s if AGENT_GIT_ALLOW.contains(&s) => {}
        s => return refuse(format!("git {s} is not on the allow-list")),
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Off,
    ReadOnly,
    E2e,
}

/// Commands that change a repo or the remote. Reserved names (rollback, stash, checkout) are included on purpose.
pub const MUTATING_COMMANDS: [&str; 18] = [
    "commit", "push", "pull", "fetch", "merge", "rebase", "reset", "checkout", "restore", "stash", "clean", "update-ref",
    "tag", "cherry-pick", "am", "revert", "add", "init",
];
/// Commands that talk to a remote (a subset of the above plus read-only network access).
const NETWORK_COMMANDS: [&str; 5] = ["push", "pull", "fetch", "ls-remote", "clone"];
/// `-c <key>=` prefixes that could re-enable credentials or other transports.
const DENIED_CONFIG: [&str; 17] = [
    "credential.", "core.sshcommand", "core.gitproxy", "core.askpass", "protocol.", "url.", "http.", "remote.", "core.fsmonitor",
    "include", "alias.", "core.pager", "pager.", "core.editor", "sequence.editor", "diff.external", "filter.",
];

#[derive(Debug, Clone)]
pub struct Jail {
    mode: Mode,
    fixture_root: Option<PathBuf>,
}

impl Jail {
    /// No restrictions (normal use).
    pub fn off() -> Self {
        Self { mode: Mode::Off, fixture_root: None }
    }

    pub fn read_only() -> Self {
        Self { mode: Mode::ReadOnly, fixture_root: None }
    }

    /// Mutations only under `root` (canonicalised; created paths that do not exist yet are judged by their parent).
    pub fn e2e(root: impl AsRef<Path>) -> Self {
        Self { mode: Mode::E2e, fixture_root: Some(canon_lenient(root.as_ref())) }
    }

    /// `INTELY_READONLY` wins over `INTELY_E2E` / `INTELY_E2E_SCRIPT`.
    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> Self {
        // Fails closed: "true", "yes" or " 1" switch the jail on too; only unset, empty, "0" and "false" leave it off.
        let on = |k: &str| var(k).is_some_and(|v| !matches!(v.trim().to_ascii_lowercase().as_str(), "" | "0" | "false"));
        if on("INTELY_READONLY") {
            return Self::read_only();
        }
        if on("INTELY_E2E") || var("INTELY_E2E_SCRIPT").is_some_and(|v| !v.is_empty()) {
            let temp = canon_lenient(&std::env::temp_dir());
            // The requested root is honoured only when it is itself a temp location, so a stray variable cannot widen
            // the jail to a real checkout.
            let root = var("INTELY_FIXTURE_ROOT")
                .filter(|r| !r.is_empty())
                .map(|r| canon_lenient(Path::new(&r)))
                .filter(|r| is_temp_location(r, &temp));
            return Self { mode: Mode::E2e, fixture_root: Some(root.unwrap_or(temp)) };
        }
        Self::off()
    }

    /// The process-wide jail, read from the environment on first use.
    pub fn global() -> Arc<Jail> {
        static GLOBAL: OnceLock<Arc<Jail>> = OnceLock::new();
        GLOBAL.get_or_init(|| Arc::new(Jail::from_vars(|k| std::env::var(k).ok()))).clone()
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn is_active(&self) -> bool {
        self.mode != Mode::Off
    }

    pub fn fixture_root(&self) -> Option<&Path> {
        self.fixture_root.as_deref()
    }

    /// Whether `path` (resolved through symlinks) is inside the fixture root.
    pub fn in_fixture(&self, path: &Path) -> bool {
        self.fixture_root.as_ref().is_some_and(|root| canon_lenient(path).starts_with(root))
    }

    fn refuse(&self, what: &str, repo: &Path) -> EngineError {
        match self.mode {
            Mode::ReadOnly => EngineError::new(READ_ONLY, format!("read-only mode (INTELY_READONLY): '{what}' is refused")),
            _ => EngineError::new(
                TEST_JAIL,
                format!("test jail (INTELY_E2E): '{what}' is refused, {} is outside the fixture root", repo.display()),
            ),
        }
    }

    /// Engine entry points: an operation that mutates `repo`.
    pub fn check_op(&self, op: &str, repo: &Path) -> Result<(), EngineError> {
        match self.mode {
            Mode::Off => Ok(()),
            Mode::ReadOnly => Err(self.refuse(op, repo)),
            Mode::E2e if self.in_fixture(repo) => Ok(()),
            Mode::E2e => Err(self.refuse(op, repo)),
        }
    }

    /// Exec layer: judges the argv (as passed to `run_git`, without the `-C` and the fixed `-c` options) and the repo.
    /// Remote URLs are checked separately ([`Jail::check_remotes`]), because they need the repo config.
    pub fn check_git(&self, repo: &Path, args: &[&str]) -> Result<(), EngineError> {
        if !self.is_active() {
            return Ok(());
        }
        let parsed = parse_args(args);
        if let Some(bad) = parsed.redirect {
            return Err(EngineError::new(TEST_JAIL, format!("git option '{bad}' is not allowed in a jail")));
        }
        if let Some(key) = parsed.config_keys.iter().find(|k| DENIED_CONFIG.iter().any(|d| k.to_lowercase().starts_with(d))) {
            return Err(EngineError::new(TEST_JAIL, format!("git config '-c {key}' is not allowed in a jail")));
        }
        let Some(sub) = parsed.subcommand else { return Ok(()) };
        if self.mode == Mode::ReadOnly && NETWORK_COMMANDS.contains(&sub) {
            return Err(self.refuse(&format!("git {sub}"), repo));
        }
        if MUTATING_COMMANDS.contains(&sub) || parsed.mutates() {
            self.check_op(&format!("git {sub}"), repo)?;
        }
        if NETWORK_COMMANDS.contains(&sub) {
            if !self.in_fixture(repo) {
                return Err(self.refuse(&format!("git {sub}"), repo));
            }
            if let Some(url) = parsed.positionals.iter().find(|p| looks_like_url(p)) {
                self.check_url(repo, url)?;
            }
        }
        Ok(())
    }

    /// Network commands: every remote configured in `repo` (fetch and push URLs) must be a local path under the
    /// fixture root. Fails closed when the URLs cannot be read.
    pub async fn check_remotes(&self, git: &Path, repo: &Path) -> Result<(), EngineError> {
        match self.mode {
            Mode::Off => return Ok(()),
            Mode::ReadOnly => return Err(self.refuse("network access", repo)),
            Mode::E2e => {}
        }
        if !self.in_fixture(repo) {
            return Err(self.refuse("network access", repo));
        }
        let unreadable = |what: &str| EngineError::new(TEST_JAIL, format!("test jail: cannot read the remotes of {} ({what})", repo.display()));
        let listing = self.git_read(git, repo, &["config", "--get-regexp", r"^remote\..*\.(url|pushurl)$"]).await.ok_or_else(|| unreadable("config"))?;
        let mut names: Vec<String> = Vec::new();
        for line in listing.lines() {
            let key = line.split_whitespace().next().unwrap_or("");
            if let Some(name) = key.strip_prefix("remote.").and_then(|k| k.rsplit_once('.')).map(|(n, _)| n.to_owned()) {
                if !names.contains(&name) {
                    names.push(name);
                }
            }
        }
        for name in &names {
            // The effective URLs (`insteadOf` rewrites applied), the raw configured values are covered by the same check.
            for args in [vec!["ls-remote", "--get-url", name.as_str()], vec!["remote", "get-url", "--push", "--all", name.as_str()]] {
                let out = self.git_read(git, repo, &args).await.ok_or_else(|| unreadable(&name.clone()))?;
                for url in out.lines().filter(|l| !l.trim().is_empty()) {
                    self.check_url(repo, url.trim())?;
                }
            }
        }
        for line in listing.lines() {
            if let Some((_, url)) = line.split_once(' ') {
                self.check_url(repo, url.trim())?;
            }
        }
        Ok(())
    }

    /// A remote URL passes only as a local path (or `file://`) that resolves under the fixture root.
    pub fn check_url(&self, repo: &Path, url: &str) -> Result<(), EngineError> {
        let refuse = |why: &str| EngineError::new(TEST_JAIL, format!("test jail: remote '{url}' is refused ({why})"));
        if url.contains("://") && !url.starts_with("file://") {
            return Err(refuse("only local fixture paths are allowed"));
        }
        let path = url.strip_prefix("file://").unwrap_or(url);
        // scp-like `host:path` / `user@host:path`
        if !path.starts_with('/') && !path.starts_with('.') && path.split('/').next().is_some_and(|first| first.contains(':')) {
            return Err(refuse("only local fixture paths are allowed"));
        }
        let full = if Path::new(path).is_absolute() { PathBuf::from(path) } else { repo.join(path) };
        if self.mode == Mode::ReadOnly || !self.in_fixture(&full) {
            return Err(refuse("not under the fixture root"));
        }
        Ok(())
    }

    /// Environment of every git process in an active jail: nothing can authenticate, only `file` transport works.
    pub fn env(&self) -> &'static [(&'static str, &'static str)] {
        if !self.is_active() {
            return &[];
        }
        &[
            ("GIT_ALLOW_PROTOCOL", "file"),
            ("GIT_CONFIG_NOSYSTEM", "1"),
            ("GIT_CONFIG_GLOBAL", "/dev/null"),
            ("GIT_CONFIG_SYSTEM", "/dev/null"),
            ("GIT_TERMINAL_PROMPT", "0"),
            ("GIT_ASKPASS", "true"),
            ("SSH_ASKPASS", "true"),
            ("GIT_SSH_COMMAND", "false"),
            ("GCM_INTERACTIVE", "never"),
        ]
    }

    /// Variables that could smuggle configuration or credentials back in.
    pub fn removed_env(&self) -> &'static [&'static str] {
        if !self.is_active() {
            return &[];
        }
        &["GIT_SSH", "GIT_PROXY_COMMAND", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_EXEC_PATH", "GIT_CONFIG"]
    }

    /// `-c` options placed before the subcommand in an active jail.
    pub fn config_args(&self) -> &'static [&'static str] {
        if !self.is_active() {
            return &[];
        }
        &[
            "-c", "credential.helper=", "-c", "protocol.https.allow=never", "-c", "protocol.http.allow=never", "-c",
            "protocol.ssh.allow=never", "-c", "protocol.git.allow=never",
        ]
    }

    /// Whether the argv is a command that talks to a remote.
    pub fn is_network(args: &[&str]) -> bool {
        parse_args(args).subcommand.is_some_and(|s| NETWORK_COMMANDS.contains(&s))
    }

    async fn git_read(&self, git: &Path, repo: &Path, args: &[&str]) -> Option<String> {
        let mut cmd = crate::exec::hardened_git_tokio(git);
        cmd.arg("-C").arg(repo).args(self.config_args()).arg("--no-optional-locks").args(args);
        for k in self.removed_env() {
            cmd.env_remove(k);
        }
        for (k, v) in self.env() {
            cmd.env(k, v);
        }
        cmd.env("LC_ALL", "C").stdin(std::process::Stdio::null()).kill_on_drop(true);
        let out = cmd.output().await.ok()?;
        // `config --get-regexp` exits 1 when nothing matches: that is an empty list, not a failure.
        let ok = out.status.success() || (args[0] == "config" && out.status.code() == Some(1));
        ok.then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }
}

/// Live-branch patterns: `*` matches any run of characters (including `/`).
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    if !text.starts_with(first) || text.len() < first.len() + last.len() || !text.ends_with(last) {
        return false;
    }
    let mut rest = &text[first.len()..text.len() - last.len()];
    for mid in &parts[1..parts.len() - 1] {
        match rest.find(mid) {
            Some(i) => rest = &rest[i + mid.len()..],
            None => return false,
        }
    }
    true
}

/// Whether a push to `remote_branch` needs the typed confirmation: `patterns` (protected plus live) or the remote's HEAD branch.
pub fn matches_live(patterns: &[String], remote_head_branch: Option<&str>, remote_branch: &str) -> bool {
    patterns.iter().any(|p| glob_match(p, remote_branch)) || remote_head_branch == Some(remote_branch)
}

/// The push-time confirmation rules. `confirm` is what the human typed.
pub fn check_live_push(live: bool, branch: &str, confirm: Option<&str>, no_verify: bool) -> Result<(), EngineError> {
    if !live {
        return Ok(());
    }
    if confirm != Some(branch) {
        return Err(EngineError::new(
            LIVE_BRANCH_CONFIRM,
            format!("'{branch}' is a live branch: type its exact name to confirm the push"),
        ));
    }
    if no_verify {
        return Err(EngineError::new(
            LIVE_BRANCH_CONFIRM,
            format!("'{branch}' is a live branch: pushing it with --no-verify (hooks off) is not allowed"),
        ));
    }
    Ok(())
}

struct ParsedArgs<'a> {
    subcommand: Option<&'a str>,
    positionals: Vec<&'a str>,
    config_keys: Vec<&'a str>,
    /// Options after the subcommand.
    flags: Vec<&'a str>,
    /// A global option that would point git elsewhere.
    redirect: Option<&'a str>,
}

impl ParsedArgs<'_> {
    /// Subcommands that are read-only or mutating depending on their arguments, and mutators missing from
    /// [`MUTATING_COMMANDS`] (which stays the list that tests iterate over). A guess from the argv: it errs on the side
    /// of refusing in an active jail.
    fn mutates(&self) -> bool {
        let has = |names: &[&str]| self.flags.iter().any(|f| names.contains(f));
        let first = self.positionals.first().copied();
        match self.subcommand {
            Some("switch" | "gc" | "mv" | "rm" | "prune" | "pack-refs" | "replace" | "filter-branch" | "update-index") => true,
            Some("worktree" | "submodule") => !matches!(first, Some("list" | "status")),
            Some("hash-object") => has(&["-w", "--write"]),
            Some("symbolic-ref") => self.positionals.len() >= 2 || has(&["-d", "--delete"]),
            Some("remote") => matches!(first, Some("add" | "remove" | "rm" | "rename" | "set-url" | "set-head" | "set-branches" | "prune" | "update")),
            Some("config") => {
                has(&["--unset", "--unset-all", "--add", "--replace-all", "--remove-section", "--rename-section", "-e", "--edit"])
                    || (self.positionals.len() >= 2 && !has(&["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"]))
            }
            Some("branch") => {
                let write = has(&["-d", "-D", "-m", "-M", "-c", "-C", "-f", "--delete", "--move", "--copy", "--force", "--set-upstream-to", "-u", "--unset-upstream", "--edit-description"]);
                let read = has(&["--list", "-l", "--show-current", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "-a", "-r", "--all", "--remotes", "-v", "-vv", "--verbose"]);
                write || (!read && !self.positionals.is_empty())
            }
            _ => false,
        }
    }
}

fn parse_args<'a>(args: &[&'a str]) -> ParsedArgs<'a> {
    let mut p = ParsedArgs { subcommand: None, positionals: Vec::new(), config_keys: Vec::new(), flags: Vec::new(), redirect: None };
    let mut i = 0;
    while i < args.len() {
        let a = args[i];
        if p.subcommand.is_none() {
            match a {
                "-c" => {
                    if let Some(kv) = args.get(i + 1) {
                        p.config_keys.push(kv.split('=').next().unwrap_or(kv));
                    }
                    i += 2;
                    continue;
                }
                "-C" | "--git-dir" | "--work-tree" | "--exec-path" | "--namespace" | "--super-prefix" | "--config-env" => {
                    p.redirect = Some(a);
                    i += 1;
                    continue;
                }
                _ if a.starts_with("--git-dir=") || a.starts_with("--work-tree=") || a.starts_with("--exec-path") || a.starts_with("--config-env=") => {
                    p.redirect = Some(a);
                }
                _ if a.starts_with('-') => {}
                _ => p.subcommand = Some(a),
            }
        } else if !a.starts_with('-') {
            p.positionals.push(a);
        } else {
            p.flags.push(a);
            if let Some((_, v)) = a.split_once('=') {
                // `--repo=<url>`, `--upload-pack=...` style values may carry a URL.
                if looks_like_url(v) {
                    p.positionals.push(v);
                }
            }
        }
        i += 1;
    }
    p
}

fn looks_like_url(s: &str) -> bool {
    s.contains("://") || (!s.starts_with('/') && !s.starts_with('.') && s.split('/').next().is_some_and(|f| f.contains(':') && f.contains('@')))
}

fn is_temp_location(path: &Path, temp: &Path) -> bool {
    ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]
        .iter()
        .map(|r| canon_lenient(Path::new(r)))
        .chain(std::iter::once(temp.to_path_buf()))
        .any(|root| path.starts_with(&root) && path != root && path.as_os_str().len() > 1)
}

/// Canonical path; for a path that does not exist (yet) the nearest existing ancestor is canonicalised and the rest is
/// appended, with `..` resolved lexically. Never resolves a missing path to somewhere it is not. A symlink that dangles
/// is replaced by its target (resolved against the link's parent), so it is judged by where a write would land.
pub fn canon_lenient(path: &Path) -> PathBuf {
    let path = if path.is_absolute() { follow_links(path) } else { path.to_path_buf() };
    let comps: Vec<Component> = path.components().collect();
    for split in (0..=comps.len()).rev() {
        let head: PathBuf = comps[..split].iter().collect();
        if head.as_os_str().is_empty() {
            continue;
        }
        if let Ok(mut real) = head.canonicalize() {
            for c in &comps[split..] {
                match c {
                    Component::ParentDir => {
                        real.pop();
                    }
                    Component::CurDir => {}
                    other => real.push(other),
                }
            }
            return real;
        }
    }
    normalize(&path)
}

/// Replaces every symlink on the way (dangling ones too) by its target; `..` goes up from the real directory. Stops
/// following after 40 links (a loop) and keeps the rest as spelled.
fn follow_links(path: &Path) -> PathBuf {
    let mut work: Vec<std::ffi::OsString> = path.components().rev().map(|c| c.as_os_str().to_owned()).collect();
    let mut out = PathBuf::new();
    let mut links = 0;
    while let Some(c) = work.pop() {
        match Path::new(&c).components().next() {
            Some(rc @ (Component::RootDir | Component::Prefix(_))) => out = PathBuf::from(rc.as_os_str()),
            Some(Component::CurDir) | None => {}
            Some(Component::ParentDir) => {
                out.pop();
            }
            Some(Component::Normal(name)) => {
                let cand = out.join(name);
                match std::fs::read_link(&cand) {
                    Ok(target) if links < 40 => {
                        links += 1;
                        if target.is_absolute() {
                            out = PathBuf::new();
                        }
                        work.extend(target.components().rev().map(|c| c.as_os_str().to_owned()));
                    }
                    _ => out = cand,
                }
            }
        }
    }
    out
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| (*v).to_owned())
    }

    #[test]
    fn mode_is_resolved_from_the_variables() {
        assert_eq!(Jail::from_vars(vars(&[])).mode(), Mode::Off);
        assert_eq!(Jail::from_vars(vars(&[("INTELY_E2E", "1")])).mode(), Mode::E2e);
        assert_eq!(Jail::from_vars(vars(&[("INTELY_E2E_SCRIPT", "/x.js")])).mode(), Mode::E2e);
        assert_eq!(Jail::from_vars(vars(&[("INTELY_E2E", "1"), ("INTELY_READONLY", "1")])).mode(), Mode::ReadOnly);
        assert_eq!(Jail::from_vars(vars(&[("INTELY_READONLY", "0")])).mode(), Mode::Off);
    }

    #[test]
    fn a_fixture_root_outside_the_temp_dir_is_ignored() {
        let j = Jail::from_vars(vars(&[("INTELY_E2E", "1"), ("INTELY_FIXTURE_ROOT", "/Users")]));
        assert_ne!(j.fixture_root(), Some(Path::new("/Users")));
        assert!(!j.in_fixture(Path::new("/fixture-elsewhere/admin")));
    }

    #[test]
    fn globs() {
        assert!(glob_match("release/*", "release/1.2"));
        assert!(glob_match("main", "main"));
        assert!(!glob_match("main", "mainline"));
        assert!(glob_match("*", "x"));
        assert!(glob_match("a*c*e", "abcde"));
        assert!(!glob_match("release/*", "hotfix/release/1"));
    }

    #[test]
    fn live_push_rules() {
        assert!(check_live_push(false, "x", None, true).is_ok());
        assert_eq!(check_live_push(true, "main", None, false).unwrap_err().code, LIVE_BRANCH_CONFIRM);
        assert_eq!(check_live_push(true, "main", Some("Main"), false).unwrap_err().code, LIVE_BRANCH_CONFIRM);
        assert_eq!(check_live_push(true, "main", Some("main "), false).unwrap_err().code, LIVE_BRANCH_CONFIRM);
        assert_eq!(check_live_push(true, "main", Some("main"), true).unwrap_err().code, LIVE_BRANCH_CONFIRM);
        assert!(check_live_push(true, "main", Some("main"), false).is_ok());
    }

    #[test]
    fn the_jail_variables_fail_closed_and_the_fixture_root_is_strictly_below_the_temp_dir() {
        let vars = |pairs: &'static [(&'static str, &'static str)]| Jail::from_vars(move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string()));
        for v in ["1", "true", "yes", " 1", "TRUE"] {
            let j = Jail::from_vars(|k| (k == "INTELY_READONLY").then(|| v.to_owned()));
            assert_eq!(j.mode(), Mode::ReadOnly, "{v:?}");
        }
        for v in ["", "0", "false", " False "] {
            let j = Jail::from_vars(|k| (k == "INTELY_READONLY").then(|| v.to_owned()));
            assert_eq!(j.mode(), Mode::Off, "{v:?}");
        }
        let temp = canon_lenient(&std::env::temp_dir());
        let j = Jail::from_vars(|k| match k {
            "INTELY_E2E" => Some("1".into()),
            "INTELY_FIXTURE_ROOT" => Some("/tmp".into()),
            _ => None,
        });
        assert_eq!(j.fixture_root(), Some(temp.as_path()), "/tmp itself is not accepted as a fixture root");
        assert_eq!(vars(&[("INTELY_E2E", "1")]).mode(), Mode::E2e);
    }

    #[test]
    fn urls() {
        let tmp = tempfile::tempdir().unwrap();
        let j = Jail::e2e(tmp.path());
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        assert!(j.check_url(&repo, &tmp.path().join("remote.git").to_string_lossy()).is_ok());
        assert!(j.check_url(&repo, &format!("file://{}/remote.git", tmp.path().display())).is_ok());
        assert!(j.check_url(&repo, "../remote.git").is_ok());
        for bad in ["https://github.com/x/y.git", "ssh://git@github.com/x/y.git", "git@github.com:x/y.git", "git://h/x", "/fixture-elsewhere/admin", "../../../x"] {
            assert_eq!(j.check_url(&repo, bad).unwrap_err().code, TEST_JAIL, "{bad}");
        }
    }

    #[test]
    fn mutators_missing_from_the_list_are_judged_by_their_arguments() {
        let tmp = tempfile::tempdir().unwrap();
        let ro = Jail::read_only();
        let repo = tmp.path();
        let refused: [&[&str]; 12] = [
            &["branch", "newbranch"], &["branch", "-D", "x"], &["config", "probe.key", "v"], &["config", "--unset", "a.b"], &["remote", "add", "o", "/x"],
            &["symbolic-ref", "HEAD", "refs/heads/x"], &["switch", "-c", "x"], &["update-index", "--add", "f"], &["hash-object", "-w", "f"], &["gc"],
            &["mv", "a", "b"], &["rm", "a"],
        ];
        for args in refused {
            assert_eq!(ro.check_git(repo, args).unwrap_err().code, READ_ONLY, "{args:?}");
        }
        for args in [&["branch", "--list"][..], &["branch"], &["branch", "-a"], &["config", "--get", "a.b"], &["config", "--type=bool", "core.ignorecase"], &["remote"], &["symbolic-ref", "-q", "--short", "HEAD"], &["hash-object", "--stdin"], &["worktree", "list"]] {
            assert!(ro.check_git(repo, args).is_ok(), "{args:?}");
        }
        // `-c alias.x=!cmd` would run an arbitrary shell command
        assert_eq!(ro.check_git(repo, &["-c", "alias.zz=!touch x", "zz"]).unwrap_err().code, TEST_JAIL);
        assert!(Jail::off().check_git(repo, &["-c", "alias.zz=!touch x", "zz"]).is_ok());
    }

    #[test]
    fn git_argv_is_judged_by_its_subcommand() {
        let tmp = tempfile::tempdir().unwrap();
        let inside = tmp.path().join("r");
        std::fs::create_dir_all(&inside).unwrap();
        let outside = Path::new("/definitely/not/a/fixture/repo");
        let e2e = Jail::e2e(tmp.path());
        let ro = Jail::read_only();
        assert!(e2e.check_git(&inside, &["commit", "-m", "x"]).is_ok());
        assert_eq!(e2e.check_git(outside, &["commit", "-m", "x"]).unwrap_err().code, TEST_JAIL);
        assert_eq!(e2e.check_git(&inside, &["push", "https://github.com/x/y.git", "main"]).unwrap_err().code, TEST_JAIL);
        assert!(e2e.check_git(outside, &["status", "--porcelain"]).is_ok());
        assert_eq!(ro.check_git(&inside, &["add", "-A"]).unwrap_err().code, READ_ONLY);
        assert_eq!(ro.check_git(&inside, &["ls-remote", "origin"]).unwrap_err().code, READ_ONLY);
        assert!(ro.check_git(&inside, &["--no-optional-locks", "status"]).is_ok());
        for sub in MUTATING_COMMANDS {
            assert_eq!(ro.check_git(&inside, &[sub]).unwrap_err().code, READ_ONLY, "{sub}");
            assert_eq!(e2e.check_git(outside, &[sub]).unwrap_err().code, TEST_JAIL, "{sub}");
        }
        // options that point git elsewhere or re-enable credentials
        for bad in [vec!["-C", "/x", "status"], vec!["--git-dir=/x", "status"], vec!["-c", "credential.helper=osxkeychain", "status"], vec!["-c", "url.x.insteadOf=y", "status"]] {
            assert_eq!(e2e.check_git(&inside, &bad).unwrap_err().code, TEST_JAIL, "{bad:?}");
        }
        // off: nothing is judged
        assert!(Jail::off().check_git(outside, &["push", "https://github.com/x/y.git"]).is_ok());
    }

    #[test]
    fn canon_follows_symlinks_and_resolves_missing_tails() {
        let tmp = tempfile::tempdir().unwrap();
        let root = canon_lenient(tmp.path());
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink("/", &link).unwrap();
        assert!(canon_lenient(&link.join("Users")) == Path::new("/Users"));
        assert_eq!(canon_lenient(&tmp.path().join("a/../b/c")), root.join("b/c"));
    }

    #[test]
    fn canon_judges_a_dangling_symlink_by_its_destination() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let root = canon_lenient(tmp.path());
        symlink("/nonexistent-intely-target/file.txt", root.join("out")).unwrap();
        symlink("later/new.txt", root.join("rel")).unwrap();
        std::fs::create_dir(root.join("real")).unwrap();
        symlink(root.join("real"), root.join("dirlink")).unwrap();
        assert_eq!(canon_lenient(&root.join("out")), Path::new("/nonexistent-intely-target/file.txt"));
        assert_eq!(canon_lenient(&root.join("rel")), root.join("later/new.txt"));
        // `..` after a linked directory goes up from the real directory
        assert_eq!(canon_lenient(&root.join("dirlink/../x")), root.join("x"));
        symlink("/tmp", root.join("up")).unwrap();
        assert_eq!(canon_lenient(&root.join("up/../x")), canon_lenient(Path::new("/tmp")).parent().unwrap().join("x"));
        // a loop terminates
        symlink("l2", root.join("l1")).unwrap();
        symlink("l1", root.join("l2")).unwrap();
        let _ = canon_lenient(&root.join("l1/x"));
    }

    #[test]
    fn the_agent_allow_list_passes_reads_and_explicit_adds_and_refuses_the_rest() {
        for ok in [
            &["status", "--porcelain"][..],
            &["--no-pager", "log", "--oneline", "-5"],
            &["diff", "--stat", "--", "src/a.ts"],
            &["show", "HEAD:README.md"],
            &["branch"],
            &["branch", "--list", "feat*"],
            &["branch", "-a", "-v"],
            &["config", "--get", "user.name"],
            &["remote", "-v"],
            &["remote", "get-url", "origin"],
            &["stash", "list"],
            &["tag"],
            &["tag", "-l", "v*"],
            &["reflog"],
            &["add", "--", "src/a.ts"],
            &["add", "a.txt", "b.txt"],
            &["rev-parse", "--show-toplevel"],
        ] {
            assert!(check_agent_git(ok).is_ok(), "{ok:?}");
        }
        for bad in [
            &["commit", "-m", "x"][..],
            &["push"],
            &["pull"],
            &["fetch"],
            &["checkout", "main"],
            &["checkout-index", "-a"],
            &["restore", "a.txt"],
            &["reset", "--hard"],
            &["clean", "-fd"],
            &["merge", "x"],
            &["rebase", "x"],
            &["stash"],
            &["stash", "pop"],
            &["tag", "v1"],
            &["tag", "-d", "v1"],
            &["branch", "new"],
            &["branch", "-D", "x"],
            &["config", "user.name", "x"],
            &["config", "--unset", "user.name"],
            &["remote", "add", "x", "y"],
            &["reflog", "expire"],
            &["-c", "alias.x=!sh", "status"],
            &["-C", "..", "status"],
            &["--git-dir=/x", "status"],
            &["add", "-A"],
            &["add", "."],
            &["add", "src/"],
            &["add", "*.ts"],
            &["add"],
            &["diff", "--output=x.patch"],
            &["diff", "--outp=x"],
            &["log", "--ext-diff"],
            &["diff", "--no-index", "a", "b"],
            &["grep", "-O", "x"],
            &["worktree", "add", "x"],
            &["update-ref", "-d", "x"],
            &[],
        ] {
            let e = check_agent_git(bad).unwrap_err();
            assert_eq!(e.code, AGENT_GIT, "{bad:?}");
        }
    }
}
