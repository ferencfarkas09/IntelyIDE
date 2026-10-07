//! The persisted record of one MCP server and the validation rules of the MCP spec (2.2 to 2.4). `validate_entry` is the single function
//! that `mcp_save` and the import share, so "importable" in the preview and the outcome of the apply cannot disagree.

use std::collections::{BTreeMap, BTreeSet};

use intely_agent_core::mcp::{McpPolicy, RESOURCES_TOOL};
use intely_settings::hash::sha256_hex;
use intely_settings::name_looks_secret;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{code, McpErr, Result};
use crate::types::McpTransport;

pub const MAX_SERVERS: usize = 32;
pub const MAX_TOOLS: usize = 500;
pub const MAX_ENV: usize = 64;
pub const MAX_HEADERS: usize = 32;
pub const MAX_ARGS: usize = 64;
pub const MAX_ARG_LEN: usize = 4096;
pub const MAX_VALUE_LEN: usize = 8192;
pub const MAX_URL_LEN: usize = 2048;
pub const MAX_COMMAND_LEN: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    #[default]
    Manual,
    Import,
}

/// An environment variable (stdio) or header (http). A secret one keeps its value in the Keychain only: `value` is `None`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpVar {
    pub name: String,
    pub secret: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// A tool-policy override: an array entry of a fixed shape (2.6: no user-chosen object keys in the file).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPolicyEntry {
    pub tool: String,
    pub policy: McpPolicy,
    /// Put there by a Test (4.4), not chosen by the user.
    #[serde(default, skip_serializing_if = "is_false")]
    pub seeded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolRecord {
    pub name: String,
    /// `normalize_tool_name(name)`, not shortened.
    pub key: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// `annotations.readOnlyHint === true`.
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub read_only_hint: Option<bool>,
    #[serde(default)]
    pub destructive_hint: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
    pub protocol_version: String,
}

/// One server as stored in `settings.json` (namespace `mcp`, 2.2). Unknown keys survive a rewrite (`extra`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRecord {
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub env: Vec<McpVar>,
    #[serde(default)]
    pub headers: Vec<McpVar>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub default_policy: McpPolicy,
    #[serde(default)]
    pub tool_policies: Vec<ToolPolicyEntry>,
    #[serde(default)]
    pub tools: Vec<McpToolRecord>,
    #[serde(default)]
    pub tools_tested_at: Option<u64>,
    #[serde(default)]
    pub tools_fingerprint: Option<String>,
    #[serde(default)]
    pub server_info: Option<ServerInfo>,
    #[serde(default)]
    pub instructions_hash: Option<String>,
    #[serde(default)]
    pub origin: Origin,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl McpServerRecord {
    pub fn entry(&self) -> Entry<'_> {
        Entry { transport: self.transport, command: self.command.as_deref(), args: &self.args, url: self.url.as_deref(), env: &self.env, headers: &self.headers }
    }

    pub fn override_for(&self, tool_key: &str) -> Option<&ToolPolicyEntry> {
        self.tool_policies.iter().find(|p| p.tool == tool_key)
    }

    pub fn fingerprint(&self) -> String {
        fingerprint(&self.entry())
    }
}

/// The connection part of a record: what validation, the fingerprint and the confirmation hash look at.
#[derive(Debug, Clone, Copy)]
pub struct Entry<'a> {
    pub transport: McpTransport,
    pub command: Option<&'a str>,
    pub args: &'a [String],
    pub url: Option<&'a str>,
    pub env: &'a [McpVar],
    pub headers: &'a [McpVar],
}

// ---- names ----------------------------------------------------------------------------------------------------------------------

/// `^[a-z][a-z0-9-]{0,31}$`, not reserved (2.3).
pub fn validate_name(name: &str) -> Result<()> {
    let ok_shape = !name.is_empty()
        && name.len() <= 32
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok_shape {
        return Err(McpErr::new(code::BAD_NAME, "a server name is 1 to 32 characters: lower-case letters, digits and -, starting with a letter").with_detail("name"));
    }
    if reserved_name(name) {
        return Err(McpErr::new(code::BAD_NAME, "that name is reserved").with_detail("name"));
    }
    Ok(())
}

pub fn reserved_name(name: &str) -> bool {
    name.starts_with("claude") || name.starts_with("intely") || matches!(name, "mcp" | "agent" | "task")
}

/// A valid server name suggested for an arbitrary key (the import's `suggestedName`).
pub fn slugify(key: &str) -> String {
    let mut out = String::new();
    for c in key.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let mut out = out.trim_matches('-').to_owned();
    if out.is_empty() {
        out = "server".into();
    }
    if !out.starts_with(|c: char| c.is_ascii_lowercase()) {
        out = format!("s-{out}");
    }
    if reserved_name(&out) {
        out = format!("my-{out}");
    }
    out.truncate(32);
    out.trim_end_matches('-').to_owned()
}

// ---- characters -----------------------------------------------------------------------------------------------------------------

/// A control, bidirectional-control or zero-width character: text the user cannot read the way it is stored.
pub fn forbidden_char(c: char) -> bool {
    let u = c as u32;
    u < 0x20
        || (0x7f..=0x9f).contains(&u)
        || matches!(u, 0x061c | 0x200e | 0x200f | 0x202a..=0x202e | 0x2066..=0x2069 | 0x200b..=0x200d | 0x2060..=0x2064 | 0xfeff)
}

fn check_chars(text: &str, what: &str) -> Result<()> {
    if text.chars().any(forbidden_char) {
        return Err(McpErr::new(code::BAD_CHARS, "control, direction and zero-width characters cannot be stored").with_detail(what));
    }
    Ok(())
}

// ---- credential shape -----------------------------------------------------------------------------------------------------------

const CRED_PREFIXES: [&str; 9] = ["sk-", "ghp_", "gho_", "ghu_", "ghs_", "github_pat_", "xoxb-", "xoxp-", "AIza"];

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '/' | '=' | '.' | '-')
}

fn shannon_bits(token: &str) -> f64 {
    let mut counts = [0usize; 256];
    let bytes = token.as_bytes();
    for b in bytes {
        counts[*b as usize] += 1;
    }
    let n = bytes.len() as f64;
    counts
        .iter()
        .filter(|c| **c > 0)
        .map(|c| {
            let p = *c as f64 / n;
            -p * p.log2()
        })
        .sum::<f64>()
}

/// A known credential prefix at a word boundary with a tail (so `task-runner` is not `sk-...`).
fn credential_prefix_at_boundary(token: &str) -> bool {
    let mut prev_alnum = false;
    for (i, c) in token.char_indices() {
        if !prev_alnum {
            let rest = &token[i..];
            if CRED_PREFIXES.iter().any(|p| rest.starts_with(p) && rest.len() >= p.len() + 8) {
                return true;
            }
        }
        prev_alnum = c.is_ascii_alphanumeric();
    }
    false
}

/// Whether `text` is credential-shaped (2.4): a known credential prefix, `Bearer`/`Basic` followed by a long token, or a token of at least
/// 24 characters with two of the three classes lower/upper/digit and a Shannon entropy of at least 3.5 bits per character. A heuristic:
/// a short token or a human-chosen password is not caught, which is why the secret flag stays the user's explicit decision.
pub fn looks_credential(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    for scheme in ["bearer ", "basic "] {
        for (at, _) in lower.match_indices(scheme) {
            if text[at + scheme.len()..].chars().take_while(|c| is_token_char(*c)).count() >= 12 {
                return true;
            }
        }
    }
    text.split(|c: char| !is_token_char(c)).filter(|t| !t.is_empty()).any(|token| {
        if credential_prefix_at_boundary(token) {
            return true;
        }
        if token.len() < 24 || token.starts_with(['/', '~']) || token.starts_with("./") || token.starts_with("../") {
            return false;
        }
        let classes = [token.chars().any(|c| c.is_ascii_lowercase()), token.chars().any(|c| c.is_ascii_uppercase()), token.chars().any(|c| c.is_ascii_digit())];
        classes.iter().filter(|c| **c).count() >= 2 && shannon_bits(token) >= 3.5
    })
}

// ---- exec-affecting variable names ----------------------------------------------------------------------------------------------

/// Names that make a program run other code, load a library or a script, or fetch from another host (2.4), compared case-insensitively;
/// every name that starts with `npm_config_` is refused as well. Extending the list is one line here.
pub const EXEC_VARS: [&str; 38] = [
    "PATH", "HOME", "SHELL", "TMPDIR", "IFS", "ENV", "BASH_ENV", "BASHOPTS", "SHELLOPTS", "PS4", "PROMPT_COMMAND", "NODE_OPTIONS", "NODE_PATH",
    "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME", "PYTHONINSPECT", "RUBYOPT", "RUBYLIB",
    "PERL5OPT", "PERL5LIB", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "CLASSPATH", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GOFLAGS", "GOPROXY", "RUSTC_WRAPPER",
];

const REFUSED_VAR_PREFIXES: [&str; 6] = ["INTELY_", "DYLD_", "LD_", "GIT_", "ANTHROPIC_", "CLAUDE_"];

pub fn is_exec_var(name: &str) -> bool {
    let up = name.to_ascii_uppercase();
    up.starts_with("NPM_CONFIG_") || EXEC_VARS.iter().any(|v| *v == up)
}

/// A variable name refused by 2.4 whatever the value (shape, prefixes, the exec-affecting list).
pub fn refused_var_name(name: &str) -> bool {
    let up = name.to_ascii_uppercase();
    !var_name_ok(name) || REFUSED_VAR_PREFIXES.iter().any(|p| up.starts_with(p)) || is_exec_var(name)
}

fn var_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 64 && chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A header name refused by 2.4 (shape, or one the client owns).
pub fn refused_header_name(name: &str) -> bool {
    let mut chars = name.chars();
    let ok = name.len() <= 64 && chars.next().is_some_and(|c| c.is_ascii_alphanumeric()) && chars.all(|c| c.is_ascii_alphanumeric() || c == '-');
    !ok || REFUSED_HEADERS.contains(&name.to_ascii_lowercase().as_str())
}

const REFUSED_HEADERS: [&str; 8] = ["host", "content-length", "content-type", "accept", "mcp-session-id", "mcp-protocol-version", "transfer-encoding", "connection"];

// ---- validation -----------------------------------------------------------------------------------------------------------------

/// Words of a flag name (`--api-key` -> api, key), split on `-` and `_`.
fn flag_has_secret_word(flag: &str) -> bool {
    flag.trim_start_matches('-').to_ascii_lowercase().split(['-', '_']).any(|w| matches!(w, "key" | "token" | "secret" | "password" | "passwd" | "auth"))
}

fn pathish(value: &str) -> bool {
    value.starts_with('/') || value.starts_with("./") || value.starts_with("../") || value.starts_with('~')
}

fn has_credential_prefix(arg: &str) -> bool {
    CRED_PREFIXES.iter().any(|p| arg.starts_with(p) && arg.len() >= p.len() + 8)
}

fn validate_args(args: &[String]) -> Result<()> {
    if args.len() > MAX_ARGS {
        return Err(McpErr::new(code::TOO_MANY, "at most 64 arguments").with_detail("args"));
    }
    let mut prev_secret_flag = false;
    for (i, arg) in args.iter().enumerate() {
        let what = format!("args:{i}");
        if arg.len() > MAX_ARG_LEN {
            return Err(McpErr::new(code::BAD_COMMAND, "an argument is at most 4096 characters").with_detail(what));
        }
        check_chars(arg, &what)?;
        if arg.starts_with("./") || arg.starts_with("../") || arg.starts_with('~') {
            return Err(McpErr::new(code::RELATIVE_PATH, "an argument must not be a relative path: the server starts in the run's directory; use an absolute path").with_detail(what));
        }
        let mut secret = has_credential_prefix(arg);
        if arg.starts_with("--") {
            if let Some((flag, value)) = arg.split_once('=') {
                if (flag_has_secret_word(flag) && !value.is_empty() && !pathish(value)) || has_credential_prefix(value) {
                    secret = true;
                }
            }
        } else if prev_secret_flag && arg.len() >= 12 && !pathish(arg) && !arg.starts_with('-') {
            secret = true;
        }
        if secret {
            return Err(McpErr::new(code::SECRET_IN_ARGS, "a secret in an argument would be stored in plain text: put it in an environment variable marked secret").with_detail(what));
        }
        prev_secret_flag = arg.starts_with("--") && !arg.contains('=') && flag_has_secret_word(arg);
    }
    Ok(())
}

fn validate_command(command: Option<&str>) -> Result<()> {
    let Some(command) = command.filter(|c| !c.is_empty()) else {
        return Err(McpErr::new(code::BAD_COMMAND, "a program to run is required").with_detail("command"));
    };
    if command.len() > MAX_COMMAND_LEN {
        return Err(McpErr::new(code::BAD_COMMAND, "the command is at most 1024 characters").with_detail("command"));
    }
    check_chars(command, "command")?;
    if command.starts_with('~') || command.starts_with("./") || command.starts_with("../") || (!command.starts_with('/') && command.contains('/')) {
        return Err(McpErr::new(code::RELATIVE_PATH, "use an absolute path or a bare program name: a relative path would run whatever the agent put in the run's directory").with_detail("command"));
    }
    if !command.starts_with('/') && command.chars().any(char::is_whitespace) {
        return Err(McpErr::new(code::BAD_COMMAND, "a bare program name has no spaces: put the arguments in the arguments field").with_detail("command"));
    }
    Ok(())
}

/// The host of an http url as stored (ASCII, punycode form).
pub fn url_host(url: &str) -> Option<String> {
    url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_owned))
}

fn validate_url(raw: Option<&str>) -> Result<()> {
    let Some(raw) = raw.filter(|u| !u.is_empty()) else {
        return Err(McpErr::new(code::BAD_URL, "an address is required").with_detail("url"));
    };
    if raw.len() > MAX_URL_LEN {
        return Err(McpErr::new(code::BAD_URL, "the address is at most 2048 characters").with_detail("url"));
    }
    check_chars(raw, "url")?;
    if !raw.is_ascii() {
        return Err(McpErr::new(code::BAD_URL, "the address is ASCII only: enter an international host name in its xn-- form").with_detail("url"));
    }
    let url = url::Url::parse(raw).map_err(|_| McpErr::new(code::BAD_URL, "that is not a valid address").with_detail("url"))?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let loopback = matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]");
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return Err(McpErr::new(code::BAD_URL, "use https:// (http:// is accepted for localhost only)").with_detail("url")),
    }
    if host.is_empty() {
        return Err(McpErr::new(code::BAD_URL, "the address has no host").with_detail("url"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(McpErr::new(code::SECRET_IN_URL, "an address with a user name or password is refused: use a header").with_detail("url"));
    }
    if url.fragment().is_some() {
        return Err(McpErr::new(code::BAD_URL, "an address with a #fragment is refused").with_detail("url"));
    }
    if url.query_pairs().any(|(name, value)| name_looks_secret(&name) || looks_credential(&value)) {
        return Err(McpErr::new(code::SECRET_IN_URL, "a token in the address is refused: send it in a header marked secret").with_detail("url"));
    }
    if url.path().split('/').any(looks_credential) {
        return Err(McpErr::new(code::SECRET_IN_URL, "a token in the address path is refused: send it in a header marked secret").with_detail("url"));
    }
    Ok(())
}

fn validate_vars(vars: &[McpVar], headers: bool) -> Result<()> {
    let limit = if headers { MAX_HEADERS } else { MAX_ENV };
    let kind = if headers { "headers" } else { "env" };
    if vars.len() > limit {
        return Err(McpErr::new(code::TOO_MANY, if headers { "at most 32 headers" } else { "at most 64 environment variables" }).with_detail(kind));
    }
    let mut seen = BTreeSet::new();
    for v in vars {
        let what = format!("{kind}:{}", v.name);
        check_chars(&v.name, &what)?;
        if headers {
            if refused_header_name(&v.name) {
                return Err(McpErr::new(code::BAD_VAR, "that header name is not allowed").with_detail(what));
            }
            if !seen.insert(v.name.to_ascii_lowercase()) {
                return Err(McpErr::new(code::BAD_VAR, "a header name appears twice").with_detail(what));
            }
        } else {
            let up = v.name.to_ascii_uppercase();
            if !var_name_ok(&v.name) || REFUSED_VAR_PREFIXES.iter().any(|p| up.starts_with(p)) {
                return Err(McpErr::new(code::BAD_VAR, "that variable name is not allowed").with_detail(what));
            }
            if is_exec_var(&v.name) {
                return Err(McpErr::new(code::EXEC_VAR, "that variable can make a program run other code or fetch from another host; wrap the server in a script of your own instead").with_detail(what));
            }
            if !seen.insert(v.name.clone()) {
                return Err(McpErr::new(code::BAD_VAR, "a variable name appears twice").with_detail(what));
            }
        }
        if v.secret {
            continue;
        }
        let value = v.value.as_deref().unwrap_or_default();
        if value.len() > MAX_VALUE_LEN {
            return Err(McpErr::new(code::BAD_VAR, "a value is at most 8192 characters").with_detail(what));
        }
        check_chars(value, &what)?;
        if name_looks_secret(&v.name) || looks_credential(value) {
            return Err(McpErr::new(code::PLAIN_SECRET_NAME, "the name or the value looks like a credential: mark it secret so it is kept in the Keychain").with_detail(what));
        }
    }
    Ok(())
}

/// Validates the connection part of a record (everything of 2.4 except name uniqueness and policies).
pub fn validate_entry(e: &Entry<'_>) -> Result<()> {
    match e.transport {
        McpTransport::Stdio => {
            validate_command(e.command)?;
            validate_args(e.args)?;
            validate_vars(e.env, false)
        }
        McpTransport::Http => {
            validate_url(e.url)?;
            validate_vars(e.headers, true)
        }
    }
}

pub fn validate_policy_tool(tool: &str) -> Result<()> {
    let ok = tool == RESOURCES_TOOL || (!tool.is_empty() && tool.len() <= 256 && tool.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
    ok.then_some(()).ok_or_else(|| McpErr::new(code::BAD_POLICY, "a tool key is 1 to 256 letters, digits, _ and -").with_detail("tool"))
}

/// A stored record in full: name, connection, policies and counts. The supplier runs it again at every start (`mcpBadConfig`).
pub fn validate_record(rec: &McpServerRecord) -> Result<()> {
    validate_name(&rec.name)?;
    validate_entry(&rec.entry())?;
    if rec.tools.len() > MAX_TOOLS || rec.tool_policies.len() > MAX_TOOLS * 2 {
        return Err(McpErr::new(code::TOO_MANY, "too many tools").with_detail("tools"));
    }
    rec.tool_policies.iter().try_for_each(|p| validate_policy_tool(&p.tool))
}

// ---- fingerprint, confirmation hash ---------------------------------------------------------------------------------------------

fn transport_str(t: McpTransport) -> &'static str {
    match t {
        McpTransport::Stdio => "stdio",
        McpTransport::Http => "http",
    }
}

/// What a tool list is learned for: `sha256(transport \0 command \0 args.join(\0) \0 url)`. A list whose fingerprint differs is stale.
pub fn fingerprint(e: &Entry<'_>) -> String {
    let args = e.args.join("\0");
    sha256_hex(format!("{}\0{}\0{}\0{}", transport_str(e.transport), e.command.unwrap_or_default(), args, e.url.unwrap_or_default()).as_bytes())
}

/// The confirmation proof: the fingerprint, the variable names with their secret/plain flags and the plain values, and the `code_lines`
/// (`code:<realpath>:<sha256|absent|unresolved>`, see `codefiles`). Secret VALUES are not part of it (only their presence).
pub fn confirm_hash(e: &Entry<'_>, code_lines: &[String]) -> String {
    let var_line = |prefix: &str, v: &McpVar, lower: bool| {
        let name = if lower { v.name.to_ascii_lowercase() } else { v.name.clone() };
        format!("{prefix}:{name}:{}", if v.secret { "S".to_owned() } else { format!("P={}", v.value.as_deref().unwrap_or_default()) })
    };
    let mut env: Vec<String> = e.env.iter().map(|v| var_line("env", v, false)).collect();
    let mut hdr: Vec<String> = e.headers.iter().map(|v| var_line("hdr", v, true)).collect();
    let mut code: Vec<String> = code_lines.to_vec();
    env.sort();
    hdr.sort();
    code.sort();
    sha256_hex(format!("{}\0{}\0{}\0{}", fingerprint(e), env.join("\0"), hdr.join("\0"), code.join("\0")).as_bytes())
}

// ---- unpinned fetch ---------------------------------------------------------------------------------------------------------------

fn base_name(command: &str) -> &str {
    command.rsplit('/').next().unwrap_or(command)
}

/// The package a package runner would fetch or run, when `command` + `args` is one: `(runner, package argument)`.
pub fn runner_package<'a>(command: &str, args: &'a [String]) -> Option<(&'static str, &'a str)> {
    let first_non_flag = |from: usize| args.iter().skip(from).find(|a| !a.starts_with('-')).map(String::as_str);
    let runner: &'static str = match base_name(command) {
        "npx" => return first_non_flag(0).map(|p| ("npx", p)),
        "bunx" => return first_non_flag(0).map(|p| ("bunx", p)),
        "pnpx" => return first_non_flag(0).map(|p| ("pnpx", p)),
        "uvx" => return first_non_flag(0).map(|p| ("uvx", p)),
        "pnpm" => "pnpm",
        "yarn" => "yarn",
        "npm" => "npm",
        "pipx" => "pipx",
        "uv" => "uv",
        _ => return None,
    };
    let verb_at = args.iter().position(|a| !a.starts_with('-'))?;
    let skip = match args[verb_at].as_str() {
        "dlx" | "exec" | "x" | "run" => 1,
        "tool" if args.get(verb_at + 1).map(String::as_str) == Some("run") => 2,
        _ => return None,
    };
    first_non_flag(verb_at + skip).map(|p| (runner, p))
}

/// `pkg@1.2.3`, `@scope/pkg@1.2.3` and `pkg==1.2.3` are pinned; a range, a tag or no suffix is not.
fn pinned(package: &str) -> bool {
    let exact = |v: &str| {
        let core = v.split(['-', '+']).next().unwrap_or(v);
        let parts: Vec<&str> = core.split('.').collect();
        parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
    };
    if let Some((_, v)) = package.split_once("==") {
        return exact(v);
    }
    let body = package.strip_prefix('@').unwrap_or(package);
    body.rsplit_once('@').is_some_and(|(_, v)| exact(v))
}

/// An unpinned package runner: the code comes from a registry at EVERY start and no hash of the command line can cover it (2.4).
pub fn fetches_code(command: Option<&str>, args: &[String]) -> bool {
    command.and_then(|c| runner_package(c, args)).is_some_and(|(_, pkg)| !pinned(pkg))
}

/// The package name without its version suffix (`@scope/pkg@1.2` -> `@scope/pkg`).
pub fn package_name(package: &str) -> &str {
    let body_start = usize::from(package.starts_with('@'));
    let cut = package[body_start..].find(['@', '=']).map_or(package.len(), |i| i + body_start);
    &package[..cut]
}

// ---- blocked by default -----------------------------------------------------------------------------------------------------------

const BLOCKED_KEYS: [&str; 11] =
    ["push_files", "create_or_update_file", "delete_file", "merge_pull_request", "create_branch", "delete_branch", "create_release", "delete_release", "create_tag", "update_ref", "force_push"];
const GIT_WRITE_VERBS: [&str; 12] = ["commit", "push", "add", "reset", "rebase", "merge", "tag", "stash", "checkout", "cherry", "revert", "amend"];
const DEPLOY_WORDS: [&str; 5] = ["deploy", "deployment", "publish", "wrangler", "rollout"];

/// A tool that looks like a git write or a deploy (4.4): seeded with Deny by a Test. By name and destructive hint only, so it is a visible
/// default and not a guarantee.
pub fn blocked_by_default(key: &str, destructive_hint: Option<bool>) -> bool {
    if destructive_hint == Some(true) {
        return true;
    }
    let lower = key.to_ascii_lowercase();
    if BLOCKED_KEYS.contains(&lower.as_str()) {
        return true;
    }
    let segments: Vec<&str> = lower.split(['_', '-']).filter(|s| !s.is_empty()).collect();
    (segments.contains(&"git") && segments.iter().any(|s| GIT_WRITE_VERBS.contains(s))) || segments.iter().any(|s| DEPLOY_WORDS.contains(s))
}

// ---- display forms ------------------------------------------------------------------------------------------------------------------

/// Every non-printable or non-ASCII character as `\u{..}`; printable ASCII stays.
pub fn escape_display(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if (' '..='~').contains(&c) {
            out.push(c);
        } else {
            out.push_str(&format!("\\u{{{:x}}}", c as u32));
        }
    }
    out
}

/// `escape_display`, plus: a space at the start or the end of the text and every run of two or more spaces is shown as U+2423, so padding
/// cannot push the dangerous tail out of view.
pub fn args_display_form(text: &str) -> String {
    let escaped = escape_display(text);
    let chars: Vec<char> = escaped.chars().collect();
    let mut out = String::with_capacity(escaped.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == ' ' {
            let start = i;
            while i < chars.len() && chars[i] == ' ' {
                i += 1;
            }
            let run = i - start;
            let edge = start == 0 || i == chars.len();
            for _ in 0..run {
                out.push(if run >= 2 || edge { '\u{2423}' } else { ' ' });
            }
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// One line for the row and the import preview: an argument with whitespace or quotes in single quotes. Never run through a shell.
pub fn command_line(command: &str, args: &[String]) -> String {
    let quote = |s: &str| {
        let e = escape_display(s);
        if s.is_empty() || s.chars().any(|c| c.is_whitespace() || matches!(c, '\'' | '"' | '\\')) {
            format!("'{}'", e.replace('\'', "'\\''"))
        } else {
            e
        }
    };
    std::iter::once(command).chain(args.iter().map(String::as_str)).map(quote).collect::<Vec<_>>().join(" ")
}

// ---- tool lists ---------------------------------------------------------------------------------------------------------------------

/// The keys of the learned tools that collide after `fit` (two names, one exposed name).
pub fn colliding_keys(server: &str, tools: &[McpToolRecord]) -> BTreeSet<String> {
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for t in tools {
        *seen.entry(intely_agent_core::mcp::fit(server, &t.key)).or_default() += 1;
    }
    tools.iter().filter(|t| seen[&intely_agent_core::mcp::fit(server, &t.key)] > 1).map(|t| t.key.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(name: &str, value: &str) -> McpVar {
        McpVar { name: name.into(), secret: false, value: Some(value.into()) }
    }

    fn secret(name: &str) -> McpVar {
        McpVar { name: name.into(), secret: true, value: None }
    }

    fn stdio<'a>(command: &'a str, args: &'a [String], env: &'a [McpVar]) -> Entry<'a> {
        Entry { transport: McpTransport::Stdio, command: Some(command), args, url: None, env, headers: &[] }
    }

    fn http<'a>(url: &'a str, headers: &'a [McpVar]) -> Entry<'a> {
        Entry { transport: McpTransport::Http, command: None, args: &[], url: Some(url), env: &[], headers }
    }

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    fn code_of(r: Result<()>) -> String {
        r.err().map(|e| e.code).unwrap_or_default()
    }

    #[test]
    fn names_follow_the_slug_rule_and_reserved_words() {
        for ok in ["github", "a", "fs-2", &"a".repeat(32)] {
            assert!(validate_name(ok).is_ok(), "{ok}");
        }
        for bad in ["", "GitHub", "git_hub", "1abc", "-a", &"a".repeat(33), "claude-x", "intely", "mcp", "agent", "task", "a b"] {
            assert_eq!(code_of(validate_name(bad)), code::BAD_NAME, "{bad}");
        }
        assert_eq!(slugify("My Server!"), "my-server");
        assert_eq!(slugify("9lives"), "s-9lives");
        assert_eq!(slugify("claude"), "my-claude");
        assert!(validate_name(&slugify("@scope/Some Weird__name")).is_ok());
        assert!(validate_name(&slugify(&"x".repeat(80))).is_ok());
    }

    #[test]
    fn commands_are_absolute_or_bare() {
        let none = args(&[]);
        for ok in ["npx", "/usr/local/bin/node", "/Users/me/My Tools/server"] {
            assert!(validate_entry(&stdio(ok, &none, &[])).is_ok(), "{ok}");
        }
        for bad in ["./x", "../x", "bin/x", "~/x"] {
            assert_eq!(code_of(validate_entry(&stdio(bad, &none, &[]))), code::RELATIVE_PATH, "{bad}");
        }
        assert_eq!(code_of(validate_entry(&stdio("", &none, &[]))), code::BAD_COMMAND);
        assert_eq!(code_of(validate_entry(&stdio("my tool", &none, &[]))), code::BAD_COMMAND);
        assert_eq!(code_of(validate_entry(&stdio(&format!("/{}", "x".repeat(1025)), &none, &[]))), code::BAD_COMMAND);
        assert_eq!(code_of(validate_entry(&stdio("no\u{0}pe", &none, &[]))), code::BAD_CHARS);
    }

    #[test]
    fn secret_shaped_arguments_are_refused_and_lookalikes_pass() {
        let refused: [&[&str]; 7] = [
            &["--api-key=x"],
            &["--token", "abcdefghijkl"],
            &["--client_secret", "0123456789abcdef"],
            &["sk-abcdefghijklmnop"],
            &["--auth-token=ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
            &["--password=hunter2"],
            &["ghp_0123456789abcdefghijklmnopqrstuvwxyz"],
        ];
        for a in refused {
            assert_eq!(code_of(validate_entry(&stdio("npx", &args(a), &[]))), code::SECRET_IN_ARGS, "{a:?}");
        }
        let allowed: [&[&str]; 6] =
            [&["--max-tokens", "5"], &["--tokenizer", "x"], &["--token-file", "/p/q"], &["-y", "@modelcontextprotocol/server-github"], &["--max-tokens=1000000000000"], &["--token", "--verbose-mode-enabled"]];
        for a in allowed {
            assert!(validate_entry(&stdio("npx", &args(a), &[])).is_ok(), "{a:?}");
        }
        assert_eq!(code_of(validate_entry(&stdio("node", &args(&["./x.js"]), &[]))), code::RELATIVE_PATH);
        assert_eq!(code_of(validate_entry(&stdio("node", &args(&["../x.js"]), &[]))), code::RELATIVE_PATH);
        assert_eq!(code_of(validate_entry(&stdio("node", &args(&["~/x.js"]), &[]))), code::RELATIVE_PATH);
        assert_eq!(code_of(validate_entry(&stdio("node", &args(&["a\nb"]), &[]))), code::BAD_CHARS);
        assert!(validate_entry(&stdio("node", &["x".repeat(4096)], &[])).is_ok());
        assert_eq!(code_of(validate_entry(&stdio("node", &vec!["a".to_owned(); 65], &[]))), code::TOO_MANY);
    }

    #[test]
    fn urls_follow_the_rules() {
        for ok in ["https://example.com/mcp", "http://localhost:8080/mcp", "http://127.0.0.1:1/x", "http://[::1]:9/x", "https://api.example.com/v1/mcp?mode=fast"] {
            assert!(validate_entry(&http(ok, &[])).is_ok(), "{ok}");
        }
        for (bad, c) in [
            ("http://example.com/mcp", code::BAD_URL),
            ("ftp://example.com", code::BAD_URL),
            ("https://user:pw@example.com", code::SECRET_IN_URL),
            ("https://example.com/mcp?api_key=abc", code::SECRET_IN_URL),
            ("https://example.com/mcp#frag", code::BAD_URL),
            ("https://ex\u{e4}mple.com/mcp", code::BAD_URL),
            ("https://example.com/mcp?t=0123456789abcdef0123456789ABCDEF", code::SECRET_IN_URL),
            ("https://example.com/0123456789abcdef0123456789ABCDEF/mcp", code::SECRET_IN_URL),
            ("not a url", code::BAD_URL),
            ("", code::BAD_URL),
        ] {
            assert_eq!(code_of(validate_entry(&http(bad, &[]))), c, "{bad}");
        }
        assert_eq!(code_of(validate_entry(&http(&format!("https://example.com/{}", "a".repeat(2050)), &[]))), code::BAD_URL);
    }

    #[test]
    fn variable_names_prefixes_and_exec_vars() {
        let none = args(&[]);
        assert!(validate_entry(&stdio("npx", &none, &[plain("LOG_LEVEL", "info"), plain("API_HOST", "example.com"), secret("GITHUB_TOKEN")])).is_ok());
        for bad in ["INTELY_X", "dyld_insert_libraries", "LD_PRELOAD", "GIT_DIR", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "1BAD", "a-b", ""] {
            assert_eq!(code_of(validate_entry(&stdio("npx", &none, &[secret(bad)]))), code::BAD_VAR, "{bad}");
        }
        for name in EXEC_VARS.iter().copied().chain(["npm_config_registry", "NPM_CONFIG_SCRIPT_SHELL", "Npm_Config_Prefix", "node_options"]) {
            for v in [secret(name), plain(name, "x")] {
                assert_eq!(code_of(validate_entry(&stdio("npx", &none, &[v]))), code::EXEC_VAR, "{name}");
            }
        }
        assert_eq!(code_of(validate_entry(&stdio("npx", &none, &[plain("A", "1"), plain("A", "2")]))), code::BAD_VAR);
        let many: Vec<McpVar> = (0..65).map(|i| plain(&format!("V{i}"), "1")).collect();
        assert_eq!(code_of(validate_entry(&stdio("npx", &none, &many))), code::TOO_MANY);
    }

    #[test]
    fn plain_values_that_look_secret_are_refused() {
        let none = args(&[]);
        for v in [plain("GITHUB_TOKEN", "x"), plain("SESSION_SECRET", "x"), plain("PAT", "ghp_0123456789abcdefghijklmnopqrstuvwxyz"), plain("X", "0123456789abcdef0123456789abcdef")] {
            assert_eq!(code_of(validate_entry(&stdio("npx", &none, &[v]))), code::PLAIN_SECRET_NAME);
        }
        assert_eq!(code_of(validate_entry(&stdio("npx", &none, &[plain("X", "line\nbreak")]))), code::BAD_CHARS);
        let h = [plain("X-Trace", "0123456789abcdef0123456789abcdef")];
        assert_eq!(code_of(validate_entry(&http("https://example.com/", &h))), code::PLAIN_SECRET_NAME);
        let h = [plain("Authorization", "x")];
        assert_eq!(code_of(validate_entry(&http("https://example.com/", &h))), code::PLAIN_SECRET_NAME);
        for name in ["Host", "content-length", "Accept", "Mcp-Session-Id", "MCP-Protocol-Version", "Transfer-Encoding", "Connection", "Content-Type"] {
            assert_eq!(code_of(validate_entry(&http("https://example.com/", &[secret(name)]))), code::BAD_VAR, "{name}");
        }
        assert_eq!(code_of(validate_entry(&http("https://example.com/", &[secret("X-Key"), secret("x-key")]))), code::BAD_VAR);
        assert!(validate_entry(&http("https://example.com/", &[secret("Authorization"), plain("X-Region", "eu")])).is_ok());
    }

    #[test]
    fn bidi_zero_width_and_control_characters_are_refused_everywhere() {
        let none = args(&[]);
        for bad in ["\u{202e}", "\u{200b}", "\n", "\u{1b}", "\u{0}", "\u{feff}", "\u{2066}", "\u{85}", "\u{7f}"] {
            assert_eq!(code_of(validate_entry(&stdio(&format!("/bin/x{bad}"), &none, &[]))), code::BAD_CHARS, "{bad:?}");
            assert_eq!(code_of(validate_entry(&stdio("node", &args(&[&format!("a{bad}b")]), &[]))), code::BAD_CHARS);
            assert_eq!(code_of(validate_entry(&stdio("node", &none, &[plain("A", &format!("v{bad}"))]))), code::BAD_CHARS);
            assert_eq!(code_of(validate_entry(&http(&format!("https://example.com/a{bad}"), &[]))), code::BAD_CHARS);
        }
        // printable non-ASCII is fine in args and plain values
        assert!(validate_entry(&stdio("node", &args(&["\u{e1}rv\u{ed}z"]), &[plain("A", "t\u{fc}k\u{f6}r")])).is_ok());
    }

    #[test]
    fn the_credential_shape_table() {
        for yes in [
            "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
            "0123456789abcdef0123456789abcdef",
            "dGhpcyBpcyBhIHNlY3JldCB0b2tlbiB2YWx1ZQ==",
            "9b2c1f4e-7a33-4d68-b0e5-5c1d8e9f2a47",
            "Bearer abcdefghijkl",
            "Basic dXNlcjpwYXNzd29yZA",
            "token=sk-abcdefghijklmnop",
            "xoxb-1234567890-abcdefg",
        ] {
            assert!(looks_credential(yes), "{yes}");
        }
        for no in ["documentation-generator", "/usr/local/bin/something-quite-long-here", "a sentence with several ordinary words in it", "info", "/Users/example/Projects/IntelySwitchIDE", "task-runner", "Bearer short"] {
            assert!(!looks_credential(no), "{no}");
        }
    }

    #[test]
    fn fingerprint_and_confirm_hash_react_to_the_right_things() {
        let a = args(&["-y", "pkg@1.2.3"]);
        let base = fingerprint(&stdio("npx", &a, &[]));
        assert_eq!(base.len(), 64);
        assert_ne!(base, fingerprint(&stdio("npx", &args(&["-y", "pkg@1.2.4"]), &[])));
        assert_ne!(base, fingerprint(&stdio("npx2", &a, &[])));
        let code_lines = ["code:/x:abc".to_owned()];
        let h1 = confirm_hash(&stdio("npx", &a, &[plain("A", "1"), secret("T")]), &code_lines);
        assert_eq!(h1, confirm_hash(&stdio("npx", &a, &[secret("T"), plain("A", "1")]), &code_lines), "variable order does not matter");
        assert_ne!(h1, confirm_hash(&stdio("npx", &a, &[plain("A", "2"), secret("T")]), &code_lines), "a plain value matters");
        assert_ne!(h1, confirm_hash(&stdio("npx", &a, &[plain("A", "1"), secret("U")]), &code_lines), "a secret NAME matters");
        assert_ne!(h1, confirm_hash(&stdio("npx", &a, &[plain("A", "1"), secret("T")]), &["code:/x:def".to_owned()]), "code content matters");
    }

    #[test]
    fn fetches_code_table() {
        let f = |c: &str, a: &[&str]| fetches_code(Some(c), &args(a));
        assert!(f("npx", &["-y", "@x/y"]));
        assert!(f("npx", &["pkg@latest"]));
        assert!(f("/usr/local/bin/npx", &["pkg@^1.2.3"]));
        assert!(!f("npx", &["pkg@1.2.3"]));
        assert!(!f("npx", &["-y", "@scope/pkg@1.2.3"]));
        assert!(!f("uvx", &["pkg==1.2.3"]));
        assert!(f("uvx", &["pkg"]));
        assert!(!f("node", &["/abs/x.js"]));
        assert!(f("pnpm", &["dlx", "pkg"]));
        assert!(!f("pnpm", &["dlx", "pkg@2.0.1"]));
        assert!(f("uv", &["tool", "run", "pkg"]));
        assert!(!f("npm", &["install"]));
        assert_eq!(package_name("@scope/pkg@1.2.3"), "@scope/pkg");
        assert_eq!(package_name("pkg@latest"), "pkg");
        assert_eq!(package_name("pkg==1.0.0"), "pkg");
        assert_eq!(package_name("pkg"), "pkg");
    }

    #[test]
    fn blocked_by_default_table() {
        for yes in ["git_commit", "git-push", "push_files", "create_or_update_file", "merge_pull_request", "deploy_worker", "publish_package", "delete_file", "wrangler_deploy", "create_branch", "git_reset"] {
            assert!(blocked_by_default(yes, None), "{yes}");
        }
        assert!(blocked_by_default("anything_at_all", Some(true)));
        for no in ["get_commit", "list_branches", "git_log", "search_code", "echo", "write_note", "get_file_contents", "list_commits", "git_status"] {
            assert!(!blocked_by_default(no, None), "{no}");
            assert!(!blocked_by_default(no, Some(false)), "{no}");
        }
    }

    #[test]
    fn display_forms_escape_and_mark_padding() {
        assert_eq!(escape_display("a\u{202e}b\tc \u{e9}"), "a\\u{202e}b\\u{9}c \\u{e9}");
        assert_eq!(args_display_form("a  b"), "a\u{2423}\u{2423}b");
        assert_eq!(args_display_form(" a"), "\u{2423}a");
        assert_eq!(args_display_form("a b"), "a b");
        assert_eq!(args_display_form("a "), "a\u{2423}");
        assert_eq!(command_line("npx", &args(&["-y", "a b", "it's", ""])), "npx -y 'a b' 'it'\\''s' ''");
        assert_eq!(command_line("/x/y", &args(&["\u{e9}"])), "/x/y \\u{e9}");
    }

    #[test]
    fn a_record_keeps_unknown_keys_and_drops_nothing() {
        let v = serde_json::json!({
            "id": "m0123456789ab", "name": "fs", "transport": "stdio", "command": "node", "args": ["/x.js"], "enabled": true,
            "futureField": { "a": 1 }, "toolPolicies": [{ "tool": "api_key_rotate", "policy": "deny" }]
        });
        let rec: McpServerRecord = serde_json::from_value(v).unwrap();
        assert_eq!(rec.extra["futureField"], serde_json::json!({ "a": 1 }));
        let back = serde_json::to_value(&rec).unwrap();
        assert_eq!(back["futureField"], serde_json::json!({ "a": 1 }));
        assert_eq!(back["toolPolicies"][0]["tool"], "api_key_rotate");
        assert!(back["toolPolicies"][0].get("seeded").is_none());
        assert_eq!(rec.default_policy, McpPolicy::Ask);
    }

    #[test]
    fn colliding_tool_keys_are_found() {
        let t = |n: &str| McpToolRecord { name: n.into(), key: intely_agent_core::mcp::normalize_tool_name(n), title: None, description: None, read_only: false, read_only_hint: None, destructive_hint: None };
        let tools = [t("dup_"), t("dup!"), t("other")];
        let c = colliding_keys("fs", &tools);
        assert_eq!(c.len(), 1, "{c:?}");
        assert!(c.contains("dup_"));
    }
}
