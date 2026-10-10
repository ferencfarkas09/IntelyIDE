//! Path resolution and the filesystem hard-stop / never-read lists (providers-plan 3.5, 5.4).
//!
//! Paths are normalized lexically, then the longest existing ancestor is canonicalized, so a symlink inside
//! the repo that points into `.git` is judged by where it lands. Protected names are compared ASCII
//! case-insensitively because APFS is.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use super::fsview;

const PROTECTED_DIRS: &[&str] = &[".git", ".husky", ".claude"];
const LOCKFILES: &[&str] = &[
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "cargo.lock",
    "composer.lock",
    "gemfile.lock",
    "poetry.lock",
    "pipfile.lock",
    "uv.lock",
    "pdm.lock",
    "go.sum",
    "mix.lock",
    "podfile.lock",
    "packages.lock.json",
    "flake.lock",
];
/// Mirrors the commit guard's secret list (`intely-core` `guard.rs`); `*` matches any run.
const SECRET_GLOBS: &[&str] = &[
    ".env",
    ".env.*",
    "*.pfx",
    "*.pem",
    "*.key",
    "*.p12",
    "*.p8",
    "*.jks",
    "*.keystore",
    "id_rsa*",
    "id_ed25519*",
    ".npmrc",
    ".netrc",
    "credentials.json",
    ".credentials.json",
    ".git-credentials",
    ".zsh_history",
    ".bash_history",
    "google-services.json",
    // Credential files of other tools (permission-modes spec 2.3.1, the never-read extension).
    ".vault-token",
    ".pypirc",
    ".terraformrc",
];
const SECRET_DIRS: &[&str] = &[".ssh", ".aws", ".gnupg", ".kube", ".azure", ".op"];
/// Credential locations named by two consecutive path components (`~/.config/gh`, `~/Library/Keychains`).
const SECRET_DIR_PAIRS: &[(&str, &str)] = &[
    (".config", "gh"),
    ("library", "keychains"),
    (".docker", "config.json"),
    (".config", "gcloud"),
    (".config", "op"),
    (".cargo", "credentials"),
    (".cargo", "credentials.toml"),
];
/// Browser profile and cookie stores under `~/Library/Application Support` (`Google/Chrome` is a pair, see `home_never_read_reason`).
const APP_SUPPORT_SECRET_DIRS: &[&str] = &["1password", "claude", "chromium", "bravesoftware", "microsoft edge", "firefox", "arc", "vivaldi"];
/// Files that run code when the human commits, pushes, installs or builds (hook runners, task and CI configs).
const EXEC_SURFACE_NAMES: &[&str] = &[
    "package.json",
    ".lintstagedrc",
    ".lintstagedrc.json",
    ".lintstagedrc.js",
    ".lintstagedrc.cjs",
    ".lintstagedrc.mjs",
    ".lintstagedrc.yaml",
    ".lintstagedrc.yml",
    "lint-staged.config.js",
    "lint-staged.config.cjs",
    "lint-staged.config.mjs",
    "lefthook.yml",
    "lefthook.yaml",
    ".lefthook.yml",
    ".lefthook.yaml",
    "lefthook-local.yml",
    ".pre-commit-config.yaml",
    ".simple-git-hooks.json",
    ".simple-git-hooks.js",
    ".simple-git-hooks.cjs",
    "simple-git-hooks.js",
    "commitlint.config.js",
    "commitlint.config.cjs",
    ".commitlintrc.js",
    ".npmrc",
    ".yarnrc",
    ".yarnrc.yml",
    ".pnpmfile.cjs",
    "makefile",
    "gnumakefile",
    "justfile",
    "taskfile.yml",
    "taskfile.yaml",
    ".gitlab-ci.yml",
    // Launchers and runner configs a human triggers implicitly (permission-modes spec 2.7, exec-surface widening).
    ".envrc",
    "mise.toml",
    ".mise.toml",
    "rakefile",
    "noxfile.py",
    "tox.ini",
    "jenkinsfile",
    "azure-pipelines.yml",
];
/// Directories whose contents are executed (git hooks via `core.hooksPath`, CI workflows, editor tasks).
const EXEC_SURFACE_DIRS: &[(&str, Option<&str>)] = &[
    (".githooks", None),
    (".github", Some("workflows")),
    (".vscode", Some("tasks.json")),
    (".vscode", Some("settings.json")),
    (".idea", Some("workspace.xml")),
    (".cargo", Some("config.toml")),
    (".cargo", Some("config")),
    (".devcontainer", None),
    (".circleci", None),
    (".vscode", Some("launch.json")),
    (".idea", Some("runconfigurations")),
];
/// Config files a linter, test runner, bundler or build tool loads and executes as code (hooks and CI run them):
/// the whole name, or the name up to the first `.` after the prefix (`jest.config.` covers `.js`, `.ts`, `.cjs`...).
const EXEC_CONFIG_NAMES: &[&str] = &["build.rs", ".babelrc", ".mocharc.js", ".mocharc.cjs", "gulpfile.js", "conftest.py", "setup.py"];
const EXEC_CONFIG_PREFIXES: &[&str] = &[
    ".eslintrc.",
    "eslint.config.",
    "jest.config.",
    "vitest.config.",
    "vitest.workspace.",
    "vite.config.",
    "webpack.config",
    "babel.config.",
    ".babelrc.",
    "prettier.config.",
    ".prettierrc.",
    "rollup.config.",
    "playwright.config.",
    "tsup.config.",
];
const ENV_TEMPLATE_SUFFIXES: &[&str] = &[".example", ".sample", ".template"];
/// wrangler and Cloudflare credential, OAuth and log locations (remote spec 4.9): the wrangler config directory
/// (`~/.wrangler`, `~/.config/.wrangler`, `~/Library/Preferences/.wrangler`, a project's `.wrangler`) and `cloudflared`.
const WRANGLER_DIRS: &[&str] = &[".wrangler", ".cloudflared", ".cloudflare"];
/// Same, named by two consecutive components (`~/.config/cloudflared`, `<IDE state>/relay-deploy`).
const WRANGLER_DIR_PAIRS: &[(&str, &str)] = &[(".config", "cloudflared"), (".config", "cloudflare"), ("intelyswitchide", "relay-deploy")];

/// The private temp directory of one database SSH tunnel is `intely-ssh-<uid>-<random>` (intely-mongo `tunnel/dir.rs`).
/// It holds the ssh control socket (a full authenticated channel to the bastion), the askpass helper and, for a moment,
/// the FIFO that carries the password or key passphrase, so an agent may neither read nor write anything in it.
const TUNNEL_DIR_PREFIX: &str = "intely-ssh-";

/// Why this path is inside an SSH tunnel directory: judged on any component, case-insensitively, so a glob
/// (`/tmp/intely-ssh-*/c`) and a symlinked or `..`-resolved spelling are caught too.
pub fn tunnel_dir_reason(path: &Path) -> Option<&'static str> {
    path.components().filter_map(name_of).any(|n| n.to_ascii_lowercase().starts_with(TUNNEL_DIR_PREFIX)).then_some("a database SSH tunnel directory (control socket and secret FIFO)")
}

/// The private temp directory of one MCP server config is `intely-mcp-<random>` (mcp-management spec 5.5): it holds the
/// resolved server config with its secrets for a moment. Judged on any component, like the SSH tunnel directory.
const MCP_TEMP_PREFIX: &str = "intely-mcp-";

/// Why this path is inside an MCP temp directory (never read, never written by an agent).
pub fn mcp_temp_dir_reason(path: &Path) -> Option<&'static str> {
    path.components().filter_map(name_of).any(|n| n.to_ascii_lowercase().starts_with(MCP_TEMP_PREFIX)).then_some("an MCP server config directory (it holds resolved secrets)")
}

pub fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                if !out.pop() && !path.is_absolute() {
                    out.push("..");
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Follows `path` component by component: a symlink (also a dangling one) is replaced by its target, resolved against
/// the link's parent, and `..` goes up from the REAL directory, never from the name the path spelled. Components that
/// do not exist are appended as they are. Gives up after too many links (a loop) and keeps the rest lexical.
fn follow_links(path: &Path) -> PathBuf {
    const MAX_LINKS: usize = 40;
    let mut work: Vec<OsString> = Vec::new();
    let mut out = PathBuf::new();
    let mut links = 0;
    let push_rev = |work: &mut Vec<OsString>, p: &Path| work.extend(p.components().rev().map(|c| c.as_os_str().to_owned()));
    push_rev(&mut work, path);
    while let Some(c) = work.pop() {
        let c = Path::new(&c).components().next();
        match c {
            Some(Component::RootDir) | Some(Component::Prefix(_)) => out = PathBuf::from(c.map(|c| c.as_os_str()).unwrap_or_default()),
            Some(Component::CurDir) | None => {}
            Some(Component::ParentDir) => {
                if !out.pop() && !out.has_root() {
                    out.push("..");
                }
            }
            Some(Component::Normal(name)) => {
                let cand = out.join(name);
                match fsview::read_link(&cand) {
                    Some(target) if links < MAX_LINKS => {
                        links += 1;
                        if target.is_absolute() {
                            out = PathBuf::new();
                        }
                        push_rev(&mut work, &target);
                    }
                    _ => out = cand,
                }
            }
        }
    }
    out
}

/// Resolves symlinks (dangling ones too, see [`follow_links`]), then canonicalizes the longest existing ancestor
/// (case, `/tmp` -> `/private/tmp`) and re-appends the rest. A remote file system view may answer the whole thing in one go
/// ([`fsview::FsView::canonical_lossy`]); otherwise it is built from the view's `read_link` and `canonicalize`.
pub fn canonical_lossy(path: &Path) -> PathBuf {
    if path.is_absolute() {
        if let Some(done) = fsview::canonical_lossy_shortcut(path) {
            return done;
        }
    }
    let path = if path.is_absolute() { follow_links(path) } else { path.to_path_buf() };
    let mut tail: Vec<OsString> = Vec::new();
    let mut cur = path.clone();
    loop {
        if let Some(mut real) = fsview::canonicalize(&cur) {
            real.extend(tail.iter().rev());
            return real;
        }
        match (cur.file_name().map(|n| n.to_owned()), cur.parent().map(Path::to_path_buf)) {
            (Some(name), Some(parent)) => {
                tail.push(name);
                cur = parent;
            }
            _ => return path,
        }
    }
}

fn abs_or_lexical(p: &Path) -> PathBuf {
    if p.is_absolute() { p.to_path_buf() } else { normalize_lexical(p) }
}

/// What a word names before it is joined to a directory. `~` and `~/x` are the home folder. Any other word that starts with `~`
/// (`~root`, `~+`, `~-`, `~1`) is expanded by the shell to a folder this analyser does not know (another user's home, the working
/// directory, the previous one, an entry of the directory stack): it is put under the root of the file system, outside every run
/// folder, so it is judged as outside and never read as a folder of the working directory.
pub fn tilde_expanded(raw: &str, home: Option<&Path>) -> PathBuf {
    let Some(rest) = raw.strip_prefix('~') else { return PathBuf::from(raw) };
    match (rest.strip_prefix('/').or(rest.is_empty().then_some("")), home) {
        (Some(rest), Some(h)) => h.join(rest),
        _ => Path::new("/").join(raw),
    }
}

/// `~`, relative-to-`base`, `.`/`..`, symlinks.
pub fn resolve(base: &Path, raw: &str, home: Option<&Path>) -> PathBuf {
    let expanded = tilde_expanded(raw, home);
    let abs = if expanded.is_absolute() { expanded } else { base.join(expanded) };
    if abs.is_absolute() {
        canonical_lossy(&abs)
    } else {
        canonical_lossy(&normalize_lexical(&abs))
    }
}

fn name_of(c: Component<'_>) -> Option<String> {
    match c {
        Component::Normal(n) => Some(n.to_string_lossy().into_owned()),
        _ => None,
    }
}

/// `.dev.vars` (wrangler's local secrets file) and its per-environment variants; `.dev.vars.example` is a template.
fn is_dev_vars(name: &str) -> bool {
    name == ".dev.vars" || (name.starts_with(".dev.vars.") && !ENV_TEMPLATE_SUFFIXES.iter().any(|s| name.ends_with(s)))
}

/// Why this path holds wrangler or Cloudflare credentials, OAuth tokens, logs or deploy state: never read, never written
/// by an agent. Judged on any component, so it also catches a project-local `.wrangler` and `.dev.vars` next to the code.
pub fn wrangler_secret_reason(path: &Path) -> Option<&'static str> {
    let names: Vec<String> = path.components().filter_map(name_of).map(|n| n.to_ascii_lowercase()).collect();
    if names.iter().any(|n| WRANGLER_DIRS.contains(&n.as_str())) {
        return Some("wrangler/Cloudflare credential directory");
    }
    if names.windows(2).any(|w| WRANGLER_DIR_PAIRS.iter().any(|(a, b)| w[0] == *a && w[1] == *b)) {
        return Some("wrangler/Cloudflare credential or deploy state");
    }
    names.iter().any(|n| is_dev_vars(n)).then_some("wrangler .dev.vars secrets file")
}

/// Why writing here is a hard stop, if it is.
pub fn protected_reason(path: &Path) -> Option<&'static str> {
    for c in path.components() {
        if let Some(n) = name_of(c) {
            if let Some(dir) = PROTECTED_DIRS.iter().find(|d| n.eq_ignore_ascii_case(d)) {
                return Some(match *dir {
                    ".git" => ".git/**",
                    ".husky" => ".husky/**",
                    _ => ".claude/**",
                });
            }
        }
    }
    if let Some(why) = wrangler_secret_reason(path).or_else(|| tunnel_dir_reason(path)).or_else(|| mcp_temp_dir_reason(path)) {
        return Some(why);
    }
    let base = path.file_name()?.to_string_lossy().to_ascii_lowercase();
    if LOCKFILES.contains(&base.as_str()) {
        return Some("lockfile");
    }
    if base.starts_with(".env") {
        return Some(".env*");
    }
    None
}

/// Why a write here needs a human decision even inside the working directory: the file runs when the human
/// commits, pushes, installs or builds, so an agent edit would be an indirect route to a commit or push.
pub fn exec_surface_reason(path: &Path) -> Option<&'static str> {
    let comps: Vec<String> = path.components().filter_map(name_of).map(|c| c.to_ascii_lowercase()).collect();
    let base = comps.last()?;
    if EXEC_SURFACE_NAMES.contains(&base.as_str()) {
        return Some("a file that runs at commit, push or install time");
    }
    if EXEC_CONFIG_NAMES.contains(&base.as_str()) || (EXEC_CONFIG_PREFIXES.iter().any(|p| base.starts_with(p)) && !base.ends_with(".md")) {
        return Some("a linter, test-runner or build configuration the tools load and execute as code");
    }
    comps
        .iter()
        .enumerate()
        .any(|(i, c)| EXEC_SURFACE_DIRS.iter().any(|(dir, next)| c == dir && next.is_none_or(|n| comps.get(i + 1).is_some_and(|x| x == n))))
        .then_some("a hook, workflow or task configuration")
}

/// For the Commit panel: does this repo-relative path run code when the human commits, pushes, installs, lints, tests
/// or builds? The exec surface above plus the Husky hooks (protected from agents, but a changed hook still runs).
pub fn runs_code_on_commit(path: &Path) -> bool {
    exec_surface_reason(path).is_some() || protected_reason(path) == Some(".husky/**")
}

/// [`runs_code_on_commit`] for a list of repo-relative paths, one flag per path (the UI asks through one Tauri command).
pub fn exec_surface_flags(paths: &[String]) -> Vec<bool> {
    paths.iter().map(|p| runs_code_on_commit(Path::new(p))).collect()
}

/// Why an agent must not read this file (the guard's secret list plus credential directories).
pub fn never_read_reason(path: &Path) -> Option<&'static str> {
    if let Some(why) = wrangler_secret_reason(path).or_else(|| tunnel_dir_reason(path)).or_else(|| mcp_temp_dir_reason(path)) {
        return Some(why);
    }
    let names: Vec<String> = path.components().filter_map(name_of).map(|n| n.to_ascii_lowercase()).collect();
    if names.iter().any(|n| SECRET_DIRS.iter().any(|d| n.eq_ignore_ascii_case(d))) {
        return Some("credential directory");
    }
    if names.windows(2).any(|w| SECRET_DIR_PAIRS.iter().any(|(a, b)| w[0] == *a && w[1] == *b) || (w[0] == ".terraform.d" && w[1].starts_with("credentials"))) {
        return Some("credential store");
    }
    let base = path.file_name()?.to_string_lossy().to_ascii_lowercase();
    if base.starts_with(".env.") && ENV_TEMPLATE_SUFFIXES.iter().any(|s| base.ends_with(s)) {
        return None;
    }
    if base.ends_with(".pub") {
        return None;
    }
    SECRET_GLOBS.iter().any(|g| glob_match(&g.to_ascii_lowercase(), &base)).then_some("secret file")
}

fn glob_match(pattern: &str, text: &str) -> bool {
    match pattern.split_once('*') {
        None => pattern == text,
        Some((head, tail)) => {
            let Some(rest) = text.strip_prefix(head) else { return false };
            if tail.is_empty() {
                return true;
            }
            (0..=rest.len()).filter(|i| rest.is_char_boundary(*i)).any(|i| glob_match(tail, &rest[i..]))
        }
    }
}

/// The scratch roots every run gets (see [`Jail::in_scratch`]): where an agent keeps a temporary file.
pub fn default_scratch_dirs() -> Vec<PathBuf> {
    #[cfg(unix)]
    {
        vec![PathBuf::from("/tmp"), PathBuf::from("/private/tmp")]
    }
    #[cfg(not(unix))]
    {
        Vec::new()
    }
}

/// The directories an agent may touch: the working directory plus granted add-dirs.
#[derive(Debug, Clone)]
pub struct Jail {
    roots: Vec<PathBuf>,
    pub cwd: PathBuf,
    pub home: Option<PathBuf>,
    /// `home` with symlinks resolved: the anchor of the home-relative lists (`~/.claude`, `~/Library/...`).
    home_real: Option<PathBuf>,
    /// The IDE's own state directory: run logs, `enforcement.json`, the gate lease. Never agent-writable or readable.
    state_dir: Option<PathBuf>,
    /// Canonical code files of the run's stdio MCP servers (MCP spec 5.4 step 4c): never agent-writable.
    mcp_code_paths: Vec<PathBuf>,
    /// Scratch roots (`/tmp`): Automatic may keep temporary files there (a `git show HEAD:f > /tmp/x` next to an edit). Not part of
    /// the jail for any other purpose; see [`Jail::in_scratch`].
    scratch: Vec<PathBuf>,
}

impl Jail {
    pub fn new(cwd: &Path, add_dirs: &[PathBuf], home: Option<&Path>) -> Self {
        let cwd = canonical_lossy(&abs_or_lexical(cwd));
        let mut roots = vec![cwd.clone()];
        roots.extend(add_dirs.iter().map(|d| canonical_lossy(&abs_or_lexical(d))));
        let home_real = home.map(|h| canonical_lossy(&abs_or_lexical(h)));
        Self { roots, cwd, home: home.map(Path::to_path_buf), home_real, state_dir: None, mcp_code_paths: Vec::new(), scratch: Vec::new() }
    }

    pub fn with_state_dir(mut self, dir: Option<&Path>) -> Self {
        self.state_dir = dir.map(|d| canonical_lossy(&abs_or_lexical(d)));
        self
    }

    /// The code files of the run's stdio MCP servers (`PolicyContext::mcp_code_paths`): a write to one is `fs.protected`.
    pub fn with_mcp_code_paths(mut self, paths: &[PathBuf]) -> Self {
        self.mcp_code_paths = paths.iter().map(|p| canonical_lossy(&abs_or_lexical(p))).collect();
        self
    }

    /// The scratch roots of the run (`PolicyContext::scratch_dirs`).
    pub fn with_scratch(mut self, dirs: &[PathBuf]) -> Self {
        self.scratch = dirs.iter().map(|d| canonical_lossy(&abs_or_lexical(d))).collect();
        self
    }

    /// The path is inside a scratch root, below its first level: the root itself, hidden entries and the folders of other tools that
    /// keep their state there (`claude-*` task output and transcripts, `intely*`) are not scratch. Callers still test the never-read
    /// and protected lists first.
    pub fn in_scratch(&self, resolved: &Path) -> bool {
        self.scratch.iter().any(|root| {
            resolved.strip_prefix(root).ok().is_some_and(|rel| {
                rel.components().next().and_then(name_of).is_some_and(|first| {
                    let first = first.to_ascii_lowercase();
                    !first.starts_with('.') && !first.starts_with("claude") && !first.starts_with("intely")
                })
            })
        })
    }

    pub fn resolve(&self, raw: &str) -> PathBuf {
        resolve(&self.cwd, raw, self.home.as_deref())
    }

    /// The home directory with symlinks resolved, when the context knows one.
    pub fn home_dir(&self) -> Option<&Path> {
        self.home_real.as_deref()
    }

    /// `<state dir>/attachments`: files the user attached, readable by agents (writes stay hard-stopped by
    /// [`Jail::protected_reason`]). A secret-looking name inside it is still refused by [`never_read_reason`].
    fn in_attachments(&self, resolved: &Path) -> bool {
        self.state_dir.as_ref().is_some_and(|d| resolved.starts_with(d.join("attachments")))
    }

    fn in_state_dir(&self, resolved: &Path) -> bool {
        self.state_dir.as_ref().is_some_and(|d| resolved.starts_with(d))
    }

    /// [`never_read_reason`] plus the state directory and the home-anchored credential and browser stores.
    pub fn never_read_reason(&self, resolved: &Path) -> Option<&'static str> {
        if self.in_state_dir(resolved) && !self.in_attachments(resolved) {
            return Some("IDE state directory");
        }
        never_read_reason(resolved).or_else(|| self.home_never_read_reason(resolved))
    }

    /// Credential and profile locations that are only secret at one place, directly under the home directory: a repository's
    /// own `.claude` directory stays readable, `~/.claude` (transcripts, plans, settings, credentials) does not, except
    /// `~/.claude/agents/**` (the global role files the IDE manages).
    fn home_never_read_reason(&self, resolved: &Path) -> Option<&'static str> {
        let rel = resolved.strip_prefix(self.home_real.as_deref()?).ok()?;
        let c: Vec<String> = rel.components().filter_map(name_of).map(|n| n.to_ascii_lowercase()).collect();
        let at = |i: usize| c.get(i).map(String::as_str);
        match at(0)? {
            ".claude.json" => Some("the Claude Code user configuration (MCP environments and OAuth state)"),
            ".claude" if at(1) != Some("agents") => Some("the Claude Code user data (transcripts, plans, settings, credentials)"),
            "library" => match (at(1)?, at(2)) {
                ("application support", Some(app)) if APP_SUPPORT_SECRET_DIRS.contains(&app) || (app == "google" && at(3) == Some("chrome")) => Some("a browser profile, cookie store or password manager"),
                ("group containers", Some(g)) if g.contains("1password") => Some("a password manager data directory"),
                ("safari" | "cookies", _) => Some("the Safari profile or cookie store"),
                ("containers", Some("com.apple.safari")) => Some("the Safari profile or cookie store"),
                ("caches", Some("claude-cli-nodejs")) => Some("the Claude CLI cache (MCP logs)"),
                _ => None,
            },
            _ => None,
        }
    }

    /// [`wrangler_secret_reason`] plus `<IDE state>/relay-deploy`, wherever the state directory is.
    pub fn wrangler_secret_reason(&self, resolved: &Path) -> Option<&'static str> {
        wrangler_secret_reason(resolved).or_else(|| {
            self.state_dir.as_ref().is_some_and(|d| resolved.starts_with(d.join("relay-deploy"))).then_some("wrangler/Cloudflare credential or deploy state")
        })
    }

    /// [`exec_surface_reason`] judged relative to the root the path is in.
    pub fn exec_surface_reason(&self, resolved: &Path) -> Option<&'static str> {
        let rel = self.roots.iter().find_map(|r| resolved.strip_prefix(r).ok());
        exec_surface_reason(rel.unwrap_or(resolved))
    }

    /// The run's folders as an actionable hint for a refusal: at most 6 paths, comma separated, then `and N more` (deterministic: the
    /// working directory first, then the granted folders in the order given).
    pub fn folders_hint(&self) -> String {
        const MAX: usize = 6;
        let mut shown: Vec<String> = self.roots.iter().take(MAX).map(|r| r.display().to_string()).collect();
        if self.roots.len() > MAX {
            shown.push(format!("and {} more", self.roots.len() - MAX));
        }
        shown.join(", ")
    }

    pub fn contains(&self, resolved: &Path) -> bool {
        self.roots.iter().any(|r| resolved.starts_with(r))
    }

    /// The path is one of the run's directories itself.
    pub fn is_run_root(&self, resolved: &Path) -> bool {
        self.roots.iter().any(|r| r == resolved)
    }

    /// The path is a folder ABOVE a run directory (its parent, the home folder, `/`): removing it removes the run's repositories.
    pub fn is_ancestor_of_root(&self, resolved: &Path) -> bool {
        self.roots.iter().any(|r| r != resolved && r.starts_with(resolved))
    }

    /// [`protected_reason`] judged relative to the root the path is in, so a repo that itself lives under
    /// `.claude/worktrees` stays writable; outside every root the full path counts.
    pub fn protected_reason(&self, resolved: &Path) -> Option<&'static str> {
        if self.mcp_code_paths.iter().any(|c| c == resolved) {
            return Some("code of an enabled MCP server");
        }
        if self.in_state_dir(resolved) {
            return Some("the IDE state directory");
        }
        match self.roots.iter().find_map(|r| resolved.strip_prefix(r).ok()) {
            Some(rel) => protected_reason(rel),
            None => protected_reason(resolved).or_else(|| user_persistence_reason(resolved)).or_else(|| self.home_persistence_reason(resolved)),
        }
    }

    /// [`Jail::protected_reason`] for a path that a script or inline code only MENTIONS (not a write operand): the repository
    /// protections plus the original git and ssh places, without the system PATH directories and startup files.
    pub fn mention_protected_reason(&self, resolved: &Path) -> Option<&'static str> {
        if self.mcp_code_paths.iter().any(|c| c == resolved) {
            return Some("code of an enabled MCP server");
        }
        if self.in_state_dir(resolved) {
            return Some("the IDE state directory");
        }
        match self.roots.iter().find_map(|r| resolved.strip_prefix(r).ok()) {
            Some(rel) => protected_reason(rel),
            None => protected_reason(resolved).or_else(|| user_git_config_reason(resolved)),
        }
    }

    /// Persistence places directly under the home directory (`~/.local/bin`, `~/bin`): a write there plants a program that the
    /// user's own shell finds first.
    fn home_persistence_reason(&self, resolved: &Path) -> Option<&'static str> {
        let rel = resolved.strip_prefix(self.home_real.as_deref()?).ok()?;
        let c: Vec<String> = rel.components().filter_map(name_of).map(|n| n.to_ascii_lowercase()).collect();
        let hit = matches!(c.first().map(String::as_str), Some("bin")) || (c.first().map(String::as_str) == Some(".local") && c.get(1).map(String::as_str) == Some("bin"));
        hit.then_some("a program directory on the user's PATH")
    }
}

/// The part of [`user_persistence_reason`] that stays a stop when a path is merely MENTIONED in program text (a script or inline
/// code that names `~/.ssh` or `~/.gitconfig`): the original git and ssh places. System places such as `/usr/bin/env` or `/etc/paths`
/// are named by ordinary scripts (a shebang line) and are judged only where a command or tool WRITES to them.
fn user_git_config_reason(path: &Path) -> Option<&'static str> {
    let comps: Vec<String> = path.components().filter_map(name_of).map(|c| c.to_ascii_lowercase()).collect();
    if comps.iter().any(|c| matches!(c.as_str(), ".ssh" | ".gnupg")) {
        return Some("a ssh or gpg directory");
    }
    if comps.windows(2).any(|w| w[0] == ".config" && matches!(w[1].as_str(), "git" | "gh")) {
        return Some("the user git or gh configuration");
    }
    match comps.last()?.as_str() {
        ".gitconfig" | ".git-credentials" | ".netrc" => Some("the user git configuration or stored credentials"),
        "gitconfig" if comps.iter().rev().nth(1).is_some_and(|c| c == "etc") => Some("the system git configuration"),
        _ => None,
    }
}

/// Shell startup files: a write plants code that runs in the user's own terminal later.
const SHELL_STARTUP_FILES: &[&str] = &[".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile", ".inputrc"];
/// Directories (as leading components of an absolute path, after the macOS `private` prefix is dropped) that hold programs
/// found on a typical PATH.
/// Homebrew's `bin` entries are symlinks into its Cellar, so a write through `/usr/local/bin/git` resolves there: the Cellar and the
/// Command Line Tools `bin` count as PATH directories too.
const PATH_DIRS: &[&[&str]] = &[
    &["usr", "local", "bin"],
    &["usr", "local", "cellar"],
    &["usr", "local", "caskroom"],
    &["opt", "homebrew", "bin"],
    &["opt", "homebrew", "cellar"],
    &["usr", "bin"],
    &["bin"],
    &["usr", "sbin"],
    &["sbin"],
    &["library", "developer", "commandlinetools", "usr", "bin"],
];

/// User-level places where a write changes how git, ssh or the user's own shell behave for the next commit, push or terminal
/// session: global git config and aliases, stored credentials, ssh keys and config (the original list), plus shell startup files,
/// LaunchAgents and cron, `/etc/paths*`, tool configuration the user runs later (`.npmrc`, `.claude.json`) and the directories
/// of a typical PATH (permission-modes spec 2.3.1, the persistence list). Judged only outside the working directories, where a
/// path such as `~/.gitconfig` or `.zshrc` is not source code.
fn user_persistence_reason(path: &Path) -> Option<&'static str> {
    let comps: Vec<String> = path.components().filter_map(name_of).map(|c| c.to_ascii_lowercase()).collect();
    if comps.iter().any(|c| matches!(c.as_str(), ".ssh" | ".gnupg")) {
        return Some("a ssh or gpg directory");
    }
    if comps.windows(2).any(|w| w[0] == ".config" && matches!(w[1].as_str(), "git" | "gh")) {
        return Some("the user git or gh configuration");
    }
    if comps.windows(2).any(|w| w[0] == ".config" && w[1] == "fish") {
        return Some("the fish shell configuration");
    }
    if comps.windows(2).any(|w| w[0] == "library" && matches!(w[1].as_str(), "launchagents" | "launchdaemons")) {
        return Some("a LaunchAgents or LaunchDaemons directory (runs programs at login or boot)");
    }
    if comps.windows(3).any(|w| w[0] == "library" && w[1] == "application support" && w[2] == "claude") {
        return Some("the Claude application data");
    }
    if comps.windows(2).any(|w| w[0] == "library" && w[1] == "keychains") {
        return Some("the Keychain directory");
    }
    match comps.last()?.as_str() {
        ".gitconfig" | ".git-credentials" | ".netrc" => return Some("the user git configuration or stored credentials"),
        ".npmrc" | ".yarnrc" | ".yarnrc.yml" | ".claude.json" => return Some("a tool configuration the user runs later"),
        f if SHELL_STARTUP_FILES.contains(&f) => return Some("a shell startup file (runs in the user's terminal)"),
        "gitconfig" if comps.iter().rev().nth(1).is_some_and(|c| c == "etc") => return Some("the system git configuration"),
        _ => {}
    }
    // System directories: macOS spells /etc, /var and /tmp as /private/etc ..., so the `private` prefix is dropped first.
    if path.has_root() {
        let sys: Vec<&str> = match comps.first().map(String::as_str) {
            Some("private") => comps[1..].iter().map(String::as_str).collect(),
            _ => comps.iter().map(String::as_str).collect(),
        };
        match sys.as_slice() {
            ["etc", d, ..] if d.starts_with("cron") => return Some("a cron directory"),
            ["etc", "paths" | "paths.d" | "profile" | "zshrc", ..] => return Some("a system shell or PATH configuration"),
            ["var", "at", ..] | ["var", "spool", "cron", ..] | ["usr", "lib", "cron", ..] => return Some("a cron directory"),
            _ => {}
        }
        if PATH_DIRS.iter().any(|d| sys.len() >= d.len() && sys[..d.len()] == **d) {
            return Some("a program directory on the user's PATH");
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_commit_panel_flags_files_that_run_code() {
        let paths: Vec<String> = [
            ".husky/pre-commit", "apps/web/package.json", ".eslintrc.js", "ui/vite.config.ts", "build.rs", ".cargo/config.toml", ".github/workflows/ci.yml", "Makefile", "lint-staged.config.mjs",
            "src/a.ts", "docs/jest.config.md", "src/config.toml", ".github/CODEOWNERS", "README.md",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let flags = exec_surface_flags(&paths);
        assert_eq!(flags.len(), paths.len());
        assert!(flags[..9].iter().all(|f| *f), "{flags:?}");
        assert!(flags[9..].iter().all(|f| !*f), "{flags:?}");
        assert!(exec_surface_flags(&[]).is_empty());
    }

    #[test]
    fn lexical_normalization() {
        assert_eq!(normalize_lexical(Path::new("/a/b/../c/./d")), PathBuf::from("/a/c/d"));
        assert_eq!(normalize_lexical(Path::new("/../..")), PathBuf::from("/"));
        assert_eq!(normalize_lexical(Path::new("../x")), PathBuf::from("../x"));
    }

    #[test]
    fn protected_names_match_case_insensitively_anywhere() {
        for p in [
            "/r/.git/config",
            "/r/sub/.GIT/hooks/pre-commit",
            "/r/.husky/pre-commit",
            "/r/.claude/settings.json",
            "/r/package-lock.json",
            "/r/apps/x/pnpm-lock.yaml",
            "/r/Cargo.lock",
            "/r/.env",
            "/r/apps/api/.env.production",
            "/r/.envrc",
        ] {
            assert!(protected_reason(Path::new(p)).is_some(), "{p}");
        }
        for p in ["/r/.github/workflows/ci.yml", "/r/.gitignore", "/r/src/environment.ts", "/r/README.md", "/r/lock.txt"] {
            assert!(protected_reason(Path::new(p)).is_none(), "{p}");
        }
    }

    #[test]
    fn user_level_git_and_ssh_files_are_protected_only_outside_the_repo() {
        let jail = Jail::new(Path::new("/work/repo"), &[], Some(Path::new("/Users/me")));
        for p in ["/Users/me/.gitconfig", "/Users/me/.config/git/config", "/Users/me/.config/git/hooks/pre-push", "/Users/me/.ssh/config", "/Users/me/.git-credentials", "/Users/me/.netrc", "/Users/me/.config/gh/hosts.yml", "/etc/gitconfig", "/Users/me/.GITCONFIG"] {
            assert!(jail.protected_reason(Path::new(p)).is_some(), "{p}");
        }
        // inside the working directory these names are ordinary files (a dotfiles repo)
        assert_eq!(jail.protected_reason(Path::new("/work/repo/dotfiles/.gitconfig")), None);
        assert_eq!(jail.protected_reason(Path::new("/Users/me/notes.md")), None);
    }

    #[test]
    fn never_read_list_follows_the_guard() {
        for p in ["/r/.env", "/r/.env.local", "/r/k/server.pem", "/r/id_rsa", "/home/u/.ssh/config", "/r/.npmrc", "/r/google-services.json"] {
            assert!(never_read_reason(Path::new(p)).is_some(), "{p}");
        }
        for p in ["/r/.env.example", "/r/id_rsa.pub", "/r/src/key.ts", "/r/README.md"] {
            assert!(never_read_reason(Path::new(p)).is_none(), "{p}");
        }
    }

    #[test]
    fn wrangler_credential_paths_are_never_read_and_never_written() {
        for p in [
            "/Users/me/.wrangler/config/default.toml",
            "/Users/me/.config/.wrangler/config/default.toml",
            "/Users/me/Library/Preferences/.wrangler/config/default.toml",
            "/Users/me/Library/Preferences/.WRANGLER/logs/wrangler-1.log",
            "/r/remote-relay/.dev.vars",
            "/r/remote-relay/.dev.vars.production",
            "/r/.DEV.VARS",
            "/r/remote-relay/.wrangler/state/v3",
            "/Users/me/.cloudflared/cert.pem",
            "/Users/me/.config/cloudflared/config.yml",
            "/Users/me/Library/Application Support/IntelySwitchIDE/relay-deploy/plan.json",
        ] {
            assert!(never_read_reason(Path::new(p)).is_some(), "read {p}");
            assert!(protected_reason(Path::new(p)).is_some(), "write {p}");
        }
        for p in ["/r/remote-relay/.dev.vars.example", "/r/remote-relay/wrangler.jsonc", "/r/remote-relay/README.md", "/r/remote-relay/src/index.ts", "/r/docs/wrangler.md", "/r/x.dev.vars"] {
            assert!(wrangler_secret_reason(Path::new(p)).is_none(), "{p}");
        }
        let jail = Jail::new(Path::new("/work/repo"), &[], Some(Path::new("/Users/me"))).with_state_dir(Some(Path::new("/state")));
        assert!(jail.wrangler_secret_reason(Path::new("/state/relay-deploy/x")).is_some());
        assert!(jail.wrangler_secret_reason(Path::new("/state/runs/x")).is_none());
    }

    #[test]
    fn symlinks_are_judged_by_their_target() {
        let dir = tempfile::tempdir().unwrap();
        let repo = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(repo.join(".git/hooks")).unwrap();
        std::os::unix::fs::symlink(repo.join(".git"), repo.join("sneaky")).unwrap();
        std::os::unix::fs::symlink("/etc", repo.join("etc-link")).unwrap();
        let jail = Jail::new(&repo, &[], None);
        let p = jail.resolve("sneaky/hooks/pre-commit");
        assert_eq!(jail.protected_reason(&p), Some(".git/**"));
        assert!(jail.contains(&p));
        let outside = jail.resolve("etc-link/hosts");
        assert!(!jail.contains(&outside));
        assert!(jail.contains(&jail.resolve("new/dir/file.txt")), "non-existing paths resolve under the repo");
        assert!(!jail.contains(&jail.resolve("../elsewhere")));
    }

    #[test]
    fn dangling_symlinks_and_dotdot_through_linked_dirs_are_judged_by_their_real_destination() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let repo = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(repo.join(".git/hooks")).unwrap();
        std::fs::create_dir_all(repo.join("src")).unwrap();
        // relative dangling link to a hook that does not exist yet
        symlink(".git/hooks/pre-commit", repo.join("hooklink")).unwrap();
        symlink("../.git/hooks/pre-commit", repo.join("src/hooklink")).unwrap();
        // absolute dangling link, and a chain of two links ending in a dangling one
        symlink(repo.join(".git/hooks/pre-push"), repo.join("abslink")).unwrap();
        symlink("abslink", repo.join("chain")).unwrap();
        // a link to a not-yet-existing file in a protected directory that does not exist at all
        symlink(".husky/pre-commit", repo.join("huskylink")).unwrap();
        // a directory link: `..` after it goes up from the REAL directory
        symlink(repo.join(".git/hooks"), repo.join("src/hooks-dir")).unwrap();
        // a dangling link to an ordinary new file stays ordinary
        symlink("new-file.txt", repo.join("plain")).unwrap();
        // a dangling link leaving the repository
        symlink("../outside-new.txt", repo.join("leaving")).unwrap();
        let jail = Jail::new(&repo, &[], None);
        for rel in ["hooklink", "src/hooklink", "abslink", "chain", "huskylink", "src/hooks-dir/../config", "src/hooks-dir/new", "hooklink/../x"] {
            let p = jail.resolve(rel);
            assert!(jail.protected_reason(&p).is_some(), "{rel} -> {} must be protected", p.display());
        }
        assert_eq!(jail.resolve("plain"), repo.join("new-file.txt"));
        assert_eq!(jail.protected_reason(&jail.resolve("plain")), None);
        assert!(!jail.contains(&jail.resolve("leaving")), "a dangling link out of the repo is outside");
        assert!(jail.contains(&jail.resolve("src/../ordinary.txt")));
    }

    #[test]
    fn a_symlink_loop_does_not_hang_or_panic() {
        let dir = tempfile::tempdir().unwrap();
        let repo = std::fs::canonicalize(dir.path()).unwrap();
        std::os::unix::fs::symlink("b", repo.join("a")).unwrap();
        std::os::unix::fs::symlink("a", repo.join("b")).unwrap();
        let jail = Jail::new(&repo, &[], None);
        let _ = jail.resolve("a/x");
    }

    #[test]
    fn a_repo_below_a_protected_directory_name_stays_writable() {
        let jail = Jail::new(Path::new("/home/u/.claude/worktrees/x"), &[], None);
        assert_eq!(jail.protected_reason(&jail.resolve("src/a.ts")), None);
        assert_eq!(jail.protected_reason(&jail.resolve(".husky/pre-commit")), Some(".husky/**"));
        assert_eq!(jail.protected_reason(&jail.resolve("/home/u/.claude/settings.json")), Some(".claude/**"));
    }

    #[test]
    fn tilde_uses_the_injected_home() {
        let jail = Jail::new(Path::new("/r"), &[], Some(Path::new("/home/u")));
        assert_eq!(jail.resolve("~/.ssh/id_rsa"), canonical_lossy(Path::new("/home/u/.ssh/id_rsa")));
        assert_eq!(jail.resolve("~"), canonical_lossy(Path::new("/home/u")));
    }

    const SOCK: &str = "/var/folders/ab/xyz/T/intely-ssh-501-0123456789abcdef";

    #[test]
    fn ssh_tunnel_directories_are_never_read_and_never_written() {
        for p in [format!("{SOCK}/c"), format!("{SOCK}/s"), format!("{SOCK}/askpass"), "/tmp/INTELY-SSH-501-aa/c".to_string(), "/tmp/intely-ssh-*/c".to_string(), SOCK.to_string()] {
            assert!(never_read_reason(Path::new(&p)).is_some(), "read {p}");
            assert!(protected_reason(Path::new(&p)).is_some(), "write {p}");
            assert!(tunnel_dir_reason(Path::new(&p)).is_some(), "{p}");
        }
        for p in ["/tmp/intely-ssh/c", "/tmp/my-intely-ssh-notes/c", "/tmp/ssh-agent.sock", "/r/src/tunnel.rs", "/tmp/intely/ssh-1/c"] {
            assert!(tunnel_dir_reason(Path::new(p)).is_none(), "{p}");
        }
        // inside a working directory the name still counts (a copy of the directory is the same secret)
        let jail = Jail::new(Path::new("/work/repo"), &[], Some(Path::new("/home/u")));
        assert!(jail.protected_reason(Path::new("/work/repo/intely-ssh-1-aa/c")).is_some());
        assert!(jail.never_read_reason(Path::new(&format!("{SOCK}/s"))).is_some());
    }

    #[test]
    fn an_agent_command_naming_a_tunnel_directory_is_a_hard_stop() {
        use crate::policy::hardstop::analyze;
        let jail = Jail::new(Path::new("/work/repo"), &[], Some(Path::new("/home/u")));
        let stop = |cmd: &str| analyze(cmd, &jail).hard_stop.map(|h| h.rule);
        for cmd in [
            format!("nc -U {SOCK}/c"),
            format!("ssh -S {SOCK}/c -O exit x"),
            format!("ssh -S {SOCK}/c -W db.internal:27017 -- bastion"),
            format!("python3 -c \"import socket; s=socket.socket(socket.AF_UNIX); s.connect('{SOCK}/c')\""),
            format!("python3 poke.py {SOCK}/c"),
            format!("node -e \"require('net').connect('{SOCK}/c')\""),
            format!("perl -MIO::Socket::UNIX -e 'IO::Socket::UNIX->new(\"{SOCK}/c\")'"),
            "nc -U /tmp/intely-ssh-*/c".to_string(),
            format!("cp {SOCK}/askpass /work/repo/a.sh"),
        ] {
            let r = stop(&cmd);
            assert!(r.is_some(), "not stopped: {cmd}");
        }
        // a plain reader is not a hard stop, but it is never auto-allowed (the human decides): the FIFO would hand over the secret
        let a = analyze(&format!("cat {SOCK}/s"), &jail);
        assert!(!crate::policy::autoallow::is_low_risk_read(&a, &jail));
        for cmd in ["nc -z localhost 27017", "ssh -V", "ls /tmp", "python3 -c \"print('intely')\""] {
            assert_eq!(stop(cmd), None, "{cmd}");
        }
    }

    #[test]
    fn an_mcp_temp_directory_is_never_read_and_never_written_whatever_the_spelling() {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let real = base.join("intely-mcp-abc123");
        std::fs::create_dir_all(&real).unwrap();
        std::os::unix::fs::symlink(&real, base.join("innocent")).unwrap();
        let jail = Jail::new(Path::new("/work/repo"), &[], Some(Path::new("/home/u")));
        for p in [real.join("mcp.json"), jail.resolve(&format!("{}/innocent/mcp.json", base.display())), PathBuf::from("/private/tmp/intely-mcp-x/mcp.json"), jail.resolve("/tmp/intely-mcp-x/mcp.json"), PathBuf::from("/tmp/INTELY-MCP-*/x")] {
            assert!(never_read_reason(&p).is_some(), "read {}", p.display());
            assert!(protected_reason(&p).is_some(), "write {}", p.display());
            assert!(mcp_temp_dir_reason(&p).is_some(), "{}", p.display());
        }
        for p in ["/tmp/intely-mcp/x", "/tmp/my-intely-mcp-notes/x", "/r/src/mcp.rs"] {
            assert!(mcp_temp_dir_reason(Path::new(p)).is_none(), "{p}");
        }
    }

    #[test]
    fn the_code_of_an_enabled_mcp_server_is_write_protected_by_name_only() {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let server = base.join("tools/server.js");
        std::fs::create_dir_all(server.parent().unwrap()).unwrap();
        std::fs::write(&server, "x").unwrap();
        std::os::unix::fs::symlink(&server, base.join("alias.js")).unwrap();
        let jail = Jail::new(&base.join("repo"), &[], None).with_mcp_code_paths(&[server.clone()]);
        assert_eq!(jail.protected_reason(&jail.resolve(server.to_str().unwrap())), Some("code of an enabled MCP server"));
        assert_eq!(jail.protected_reason(&jail.resolve(base.join("alias.js").to_str().unwrap())), Some("code of an enabled MCP server"), "through a symlink");
        assert_eq!(jail.protected_reason(&jail.resolve(base.join("tools/other.js").to_str().unwrap())), None, "a sibling is not protected");
        assert_eq!(jail.mention_protected_reason(&server), Some("code of an enabled MCP server"));
    }

    #[test]
    fn the_never_read_extension_is_anchored_at_the_home_directory() {
        let jail = Jail::new(Path::new("/work/repo"), &[], Some(Path::new("/Users/me")));
        for p in [
            "/Users/me/.claude.json", "/Users/me/.claude/projects/x/y.jsonl", "/Users/me/.claude/settings.json", "/Users/me/Library/Application Support/Claude/x", "/Users/me/Library/Application Support/Google/Chrome/Default/Cookies",
            "/Users/me/Library/Application Support/Firefox/Profiles/x/cookies.sqlite", "/Users/me/Library/Application Support/1Password/x", "/Users/me/Library/Group Containers/2BUA8C4S2C.com.1password/x",
            "/Users/me/Library/Cookies/Cookies.binarycookies", "/Users/me/Library/Safari/History.db", "/Users/me/Library/Containers/com.apple.Safari/x", "/Users/me/Library/Caches/claude-cli-nodejs/x/y",
            "/Users/me/.config/gcloud/credentials.db", "/Users/me/.azure/x", "/Users/me/.vault-token", "/Users/me/.pypirc", "/Users/me/.terraformrc", "/Users/me/.terraform.d/credentials.tfrc.json", "/Users/me/.cargo/credentials.toml",
        ] {
            assert!(jail.never_read_reason(Path::new(p)).is_some(), "{p}");
        }
        for p in ["/Users/me/.claude/agents/x.md", "/Users/me/Library/Application Support/Code/x", "/Users/me/Library/Caches/other/x", "/Users/me/notes.md", "/Users/ann/.claude.json/../x", "/work/repo/.claude/settings.json", "/work/repo/.claude.json.example"] {
            assert!(jail.never_read_reason(Path::new(p)).is_none(), "{p}");
        }
    }

    #[test]
    fn the_persistence_list_covers_startup_files_launch_agents_cron_and_path_directories() {
        let jail = Jail::new(Path::new("/work/repo"), &[], Some(Path::new("/Users/me")));
        for p in [
            "/Users/me/.zshrc", "/Users/me/.zshenv", "/Users/me/.zprofile", "/Users/me/.bash_profile", "/Users/me/.bashrc", "/Users/me/.profile", "/Users/me/.config/fish/config.fish", "/Users/me/Library/LaunchAgents/x.plist",
            "/Library/LaunchDaemons/x.plist", "/Users/me/.npmrc", "/Users/me/.claude.json", "/Users/me/Library/Application Support/Claude/x", "/Users/me/Library/Keychains/login.keychain-db", "/usr/local/bin/git",
            "/usr/local/Cellar/git/2.52.0/bin/git", "/opt/homebrew/bin/x", "/usr/bin/env", "/bin/sh", "/Users/me/.local/bin/x", "/Users/me/bin/x", "/etc/paths", "/etc/paths.d/x", "/etc/zshrc", "/etc/cron.d/x",
            "/private/etc/paths", "/private/var/at/x", "/var/spool/cron/x",
        ] {
            assert!(jail.protected_reason(Path::new(p)).is_some(), "{p}");
        }
        for p in ["/Users/me/notes.md", "/Users/me/projects/bin/x", "/tmp/x", "/Users/me/.local/share/x", "/var/folders/ab/T/x", "/work/repo/.zshrc"] {
            assert_eq!(jail.protected_reason(Path::new(p)), None, "{p}");
        }
        // a mention in program text (a shebang) is not a write
        assert_eq!(jail.mention_protected_reason(Path::new("/usr/bin/env")), None);
        assert!(jail.mention_protected_reason(Path::new("/Users/me/.ssh/config")).is_some());
    }

    #[test]
    fn the_run_root_and_its_ancestors_are_told_apart() {
        let jail = Jail::new(Path::new("/Users/me/work/repo"), &[PathBuf::from("/Users/me/other")], Some(Path::new("/Users/me")));
        assert!(jail.is_run_root(Path::new("/Users/me/work/repo")) && jail.is_run_root(Path::new("/Users/me/other")));
        assert!(!jail.is_run_root(Path::new("/Users/me/work/repo/src")));
        for p in ["/", "/Users", "/Users/me", "/Users/me/work"] {
            assert!(jail.is_ancestor_of_root(Path::new(p)), "{p}");
        }
        for p in ["/Users/me/work/repo", "/Users/me/work/repo/src", "/Users/me/work2", "/tmp"] {
            assert!(!jail.is_ancestor_of_root(Path::new(p)), "{p}");
        }
        assert_eq!(jail.home_dir(), Some(Path::new("/Users/me")));
    }
}
