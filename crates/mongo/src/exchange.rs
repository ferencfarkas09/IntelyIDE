//! Profile export and import (T5): the export document, the strict importer and the URI-list importer. The parsing is
//! pure; the only IO is the two small file helpers at the end ([`read_import_file`] through a [`FileSource`], and
//! [`write_export_file`]), and they only ever see a path that a one-time dialog handle gave to Rust (the webview never
//! supplies or sees a path).
//!
//! Hard rules (spec 5.10, threat 9): an export has no secret, no `uri`, no signature, no `rev`, no `levelOverride`, no
//! `tlsRelax`, no host-level facts. An import is untrusted input: size and count caps, unknown fields refused, every
//! profile validated, every file path re-checked, every result read-only with AI off and no relaxation, the tag never
//! below Production when the profile reaches out through a tunnel, a proxy, PLAIN, plain TCP or a non-loopback host, and
//! errors that name a line number and a code, never input text.

use std::collections::HashSet;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api::{AiMode, AiPrefs, Domain, Environment, ImportItem, ImportPreview, Note, ProfileInput, TlsRelax, WireSecret};
use crate::connspec::{valid_file_path, AuthMechanism, ConnSpec, Scheme, TlsMode, Tunnel, TunnelAuth};
use crate::connstring::{parse_connection_string, Parsed};
use crate::error::{code, Result, StudioError};
use crate::host;
use crate::profile::Profile;

pub const FORMAT: &str = "intely-mongo-profiles";
pub const VERSION: u32 = 1;
pub const MAX_BYTES: usize = 1024 * 1024;
pub const MAX_PROFILES: usize = 200;
pub const MAX_URI_LINES: usize = 50;
pub const MAX_GLOSSARY_PAIRS: usize = 50;
pub const MAX_GLOSSARY_CHARS: usize = 64;
const MAX_SPEC_BYTES: usize = 16 * 1024;
const MAX_NAME_CHARS: usize = 64;
const MAX_GROUP_CHARS: usize = 40;
const MAX_TENANT_CHARS: usize = 120;
const MAX_DENY_FIELDS: usize = 200;

#[derive(Debug, Clone, Copy, Default)]
pub struct ExportOptions {
    pub include_tunnel: bool,
    pub include_paths: bool,
}

/// What an import needs to know from the running app.
#[derive(Debug, Clone, Default)]
pub struct ImportOptions {
    /// `mongo.happyPreset`: a file's `domain: happy` is honoured only when this is on (else it becomes generic).
    pub happy_preset: bool,
    /// Names of the profiles that exist already (a clash gets a numeric suffix).
    pub existing_names: Vec<String>,
}

// ---- the file format (Appendix B3) ------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Need {
    Needed,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileSecrets {
    password: Need,
    key_password: Need,
    ssh_secret: Need,
    proxy_password: Need,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutDoc {
    format: &'static str,
    version: u32,
    profiles: Vec<OutProfile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutProfile {
    name: String,
    color: Option<String>,
    environment: Environment,
    group: Option<String>,
    favorite: bool,
    domain: Domain,
    tenant_lock: Option<String>,
    ai_prefs: AiPrefs,
    spec: ConnSpec,
    secrets: FileSecrets,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InDoc {
    format: String,
    version: u32,
    profiles: Vec<InProfile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InProfile {
    name: String,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    environment: Option<Environment>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    favorite: Option<bool>,
    #[serde(default)]
    domain: Option<Domain>,
    #[serde(default)]
    tenant_lock: Option<String>,
    #[serde(default)]
    ai_prefs: Option<AiPrefs>,
    spec: ConnSpec,
    #[serde(default)]
    secrets: Option<FileSecrets>,
}

/// Can this profile be exported? Legacy connection-string profiles have no structured spec, and a profile whose
/// signature failed is not trusted.
pub fn exportable(p: &Profile) -> bool {
    p.conn.is_some() && !p.needs_review
}

fn needs(spec: &ConnSpec) -> FileSecrets {
    let n = |b: bool| if b { Need::Needed } else { Need::None };
    FileSecrets {
        password: n(spec.auth.mechanism.uses_password()),
        key_password: n(spec.tls.client_cert_file.is_some()),
        ssh_secret: n(matches!(&spec.tunnel, Tunnel::Ssh(s) if s.auth != TunnelAuth::Agent)),
        proxy_password: n(matches!(&spec.tunnel, Tunnel::Socks5(p) if p.username.is_some())),
    }
}

/// The export document for the exportable profiles of `profiles` (pretty JSON, field order frozen). Secrets appear only
/// as `needed` / `none`; paths only with `include_paths`; the tunnel only with `include_tunnel` (without it the
/// exported spec has no tunnel).
pub fn export_document(profiles: &[Profile], opts: ExportOptions) -> Result<String> {
    let mut out = Vec::new();
    for p in profiles.iter().filter(|p| exportable(p)) {
        let Some(orig) = p.conn.as_ref() else { continue };
        let secrets = needs(orig);
        let mut spec = orig.clone();
        if !opts.include_tunnel {
            spec.tunnel = Tunnel::None;
        }
        if !opts.include_paths {
            spec.tls.ca_file = None;
            spec.tls.client_cert_file = None;
            if let Tunnel::Ssh(s) = &mut spec.tunnel {
                s.key_file = None;
            }
        }
        out.push(OutProfile {
            name: p.name.clone(),
            color: Some(p.color.clone()).filter(|c| !c.is_empty()),
            environment: p.safety.environment,
            group: p.group.clone(),
            favorite: p.favorite,
            domain: p.domain,
            tenant_lock: p.safety.tenant_lock.clone(),
            ai_prefs: p.ai_prefs.clone(),
            spec,
            secrets,
        });
    }
    if out.is_empty() {
        return Err(StudioError::new(code::IMPORT, "import.nothingToExport"));
    }
    serde_json::to_string_pretty(&OutDoc { format: FORMAT, version: VERSION, profiles: out }).map_err(|_| StudioError::new(code::IMPORT, "import.serialize"))
}

// ---- import -----------------------------------------------------------------------------------------------------

fn err(c: &str, line: Option<usize>) -> StudioError {
    StudioError::new(code::IMPORT, match line {
        Some(l) if l > 0 => format!("{c} (line {l})"),
        _ => c.to_string(),
    })
}

fn json_err(e: &serde_json::Error) -> StudioError {
    use serde_json::error::Category;
    let c = match e.classify() {
        Category::Syntax | Category::Eof | Category::Io => "import.syntax",
        Category::Data if e.to_string().starts_with("unknown field") => "import.unknownField",
        Category::Data => "import.invalid",
    };
    err(c, Some(e.line()))
}

fn note(c: &str, option: Option<String>) -> Note {
    Note { code: c.to_string(), option }
}

/// `true` when the first non-blank character opens a JSON object.
pub fn looks_like_json(bytes: &[u8]) -> bool {
    let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    b.iter().find(|c| !c.is_ascii_whitespace()) == Some(&b'{')
}

/// Keys of `orig` that the typed value does not know (serde ignores them on `ConnSpec`/`AiPrefs`, which the strict
/// import must not): compared against the re-serialised value, nulls ignored.
fn has_unknown_keys(orig: &Value, typed: &Value) -> bool {
    match (orig, typed) {
        (Value::Object(o), Value::Object(t)) => o.iter().any(|(k, v)| match t.get(k) {
            Some(tv) => has_unknown_keys(v, tv),
            None => !v.is_null(),
        }),
        (Value::Array(o), Value::Array(t)) => o.len() != t.len() || o.iter().zip(t).any(|(a, b)| has_unknown_keys(a, b)),
        _ => false,
    }
}

fn has_control(v: &Value) -> bool {
    match v {
        Value::String(s) => s.chars().any(char::is_control),
        Value::Array(a) => a.iter().any(has_control),
        Value::Object(o) => o.iter().any(|(k, v)| k.chars().any(char::is_control) || has_control(v)),
        _ => false,
    }
}

/// What makes a profile reach beyond a plain connection to a loopback server.
fn risk_causes(spec: &ConnSpec) -> Vec<&'static str> {
    let mut v = Vec::new();
    match &spec.tunnel {
        Tunnel::None => {}
        Tunnel::Ssh(_) => v.push("tunnel"),
        Tunnel::Socks5(_) => v.push("proxy"),
    }
    if spec.auth.mechanism == AuthMechanism::Plain {
        v.push("plain");
    }
    if spec.tls.mode == TlsMode::Off {
        v.push("tlsOff");
    }
    let remote = spec.scheme == Scheme::Srv || spec.hosts.iter().any(|h| !host::is_loopback_host(&h.host.trim_matches(['[', ']']).to_ascii_lowercase()));
    if remote {
        v.push("remoteHost");
    }
    v
}

/// Every outbound endpoint: database hosts, the bastion with its allowed targets, the proxy.
fn endpoints(spec: &ConnSpec) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    for h in &spec.hosts {
        v.push(match (spec.scheme, h.port) {
            (Scheme::Srv, _) => h.host.clone(),
            (_, p) => format!("{}:{}", h.host, p.unwrap_or(27017)),
        });
    }
    match &spec.tunnel {
        Tunnel::None => {}
        Tunnel::Ssh(s) => {
            v.push(format!("{}:{}", s.host, s.port.unwrap_or(22)));
            v.extend(s.allowed_hosts.iter().map(|a| format!("{}:{}", a.host, a.port)));
        }
        Tunnel::Socks5(p) => v.push(format!("{}:{}", p.host, p.port)),
    }
    let mut seen = HashSet::new();
    v.retain(|e| seen.insert(e.clone()));
    v
}

/// Drops file paths that are not absolute and clean, re-validates, and checks for control characters and size.
fn finish_spec(mut spec: ConnSpec, notes: &mut Vec<Note>) -> std::result::Result<ConnSpec, Note> {
    let drop_path =|p: &mut Option<String>, what: &str, notes: &mut Vec<Note>| {
        if p.as_deref().is_some_and(|s| !valid_file_path(s)) {
            *p = None;
            notes.push(note("import.pathDropped", Some(what.to_string())));
        }
    };
    drop_path(&mut spec.tls.ca_file, "tls.caFile", notes);
    drop_path(&mut spec.tls.client_cert_file, "tls.clientCertFile", notes);
    if let Tunnel::Ssh(s) = &mut spec.tunnel {
        drop_path(&mut s.key_file, "tunnel.keyFile", notes);
    }
    let v = serde_json::to_value(&spec).map_err(|_| note("import.invalid", None))?;
    if has_control(&v) {
        return Err(note("import.controlChars", None));
    }
    if v.to_string().len() > MAX_SPEC_BYTES {
        return Err(note("import.tooLong", Some("spec".into())));
    }
    if let Some(p) = spec.errors().into_iter().next() {
        return Err(note("import.specInvalid", Some(format!("{} {}", p.path, p.code))));
    }
    Ok(spec)
}

fn unique_name(base: &str, taken: &mut HashSet<String>) -> String {
    let key = |s: &str| s.to_lowercase();
    if taken.insert(key(base)) {
        return base.to_string();
    }
    for n in 2..1000 {
        let suffix = format!(" ({n})");
        let keep = MAX_NAME_CHARS.saturating_sub(suffix.chars().count());
        let cand = format!("{}{suffix}", base.chars().take(keep).collect::<String>());
        if taken.insert(key(&cand)) {
            return cand;
        }
    }
    base.to_string()
}

fn clean_color(c: Option<String>) -> Option<String> {
    c.filter(|c| c.len() >= 4 && c.len() <= 9 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit()))
}

/// The common tail of both importers: policy applied, preview item built.
struct Built {
    input: ProfileInput,
    item: ImportItem,
}

fn build(name: String, spec: ConnSpec, file_env: Option<Environment>, mut warnings: Vec<Note>) -> Built {
    let causes = risk_causes(&spec);
    let mut environment = file_env.unwrap_or(Environment::Production);
    if !causes.is_empty() && environment != Environment::Production {
        environment = Environment::Production;
        warnings.push(note("import.tagRaised", None));
    }
    for c in &causes {
        warnings.push(note(&format!("import.risk.{c}"), None));
    }
    let item = ImportItem { name: name.clone(), warnings, endpoints: endpoints(&spec), needs_confirm: !causes.is_empty() };
    let input = ProfileInput {
        name,
        environment,
        read_only: Some(true),
        ai_mode: Some(AiMode::Off),
        tls_relax: Some(TlsRelax::None),
        spec: Some(spec),
        ..Default::default()
    };
    Built { input, item }
}

fn ai_prefs_ok(p: &AiPrefs) -> bool {
    p.deny_fields.len() <= MAX_DENY_FIELDS
        && p.deny_fields.iter().all(|d| d.chars().count() <= MAX_GLOSSARY_CHARS && !d.chars().any(char::is_control))
        && p.glossary.len() <= MAX_GLOSSARY_PAIRS
        && p.glossary.iter().all(|g| {
            g.from.chars().count() <= MAX_GLOSSARY_CHARS && g.to.chars().count() <= MAX_GLOSSARY_CHARS && !g.from.chars().chain(g.to.chars()).any(char::is_control)
        })
}

/// Parses an export file with default options (no Happy preset, no existing names).
pub fn import_preview(bytes: &[u8]) -> Result<(ImportPreview, Vec<ProfileInput>)> {
    import_json(bytes, &ImportOptions::default())
}

/// The strict JSON importer. `ImportPreview.items[i]` describes `Vec<ProfileInput>[i]`. A profile that fails its
/// checks is left out with a note; a file that fails the size, count, format or syntax checks is an error.
pub fn import_json(bytes: &[u8], opts: &ImportOptions) -> Result<(ImportPreview, Vec<ProfileInput>)> {
    if bytes.len() > MAX_BYTES {
        return Err(err("import.tooLarge", None));
    }
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let doc: InDoc = serde_json::from_slice(bytes).map_err(|e| json_err(&e))?;
    if doc.format != FORMAT {
        return Err(err("import.format", None));
    }
    if doc.version != VERSION {
        return Err(err("import.version", None));
    }
    if doc.profiles.len() > MAX_PROFILES {
        return Err(err("import.tooManyProfiles", None));
    }
    // serde ignores unknown keys inside `spec` and `aiPrefs`; compare against the raw tree.
    let raw: Value = serde_json::from_slice(bytes).map_err(|e| json_err(&e))?;
    let raw_profiles = raw.get("profiles").and_then(Value::as_array).cloned().unwrap_or_default();

    let mut taken: HashSet<String> = opts.existing_names.iter().map(|n| n.to_lowercase()).collect();
    let mut notes = Vec::new();
    let mut items = Vec::new();
    let mut inputs = Vec::new();
    for (i, p) in doc.profiles.into_iter().enumerate() {
        let n = i + 1;
        let skip = |notes: &mut Vec<Note>, c: &str, opt: Option<String>| notes.push(note(c, Some(format!("#{n}{}", opt.map(|o| format!(" {o}")).unwrap_or_default()))));
        let raw_p = raw_profiles.get(i).cloned().unwrap_or(Value::Null);
        let typed_spec = serde_json::to_value(&p.spec).unwrap_or(Value::Null);
        let typed_prefs = p.ai_prefs.as_ref().and_then(|a| serde_json::to_value(a).ok()).unwrap_or(Value::Null);
        if has_unknown_keys(raw_p.get("spec").unwrap_or(&Value::Null), &typed_spec) || has_unknown_keys(raw_p.get("aiPrefs").unwrap_or(&Value::Null), &typed_prefs) {
            skip(&mut notes, "import.unknownField", None);
            continue;
        }
        let name = p.name.trim().to_string();
        if name.is_empty() || name.chars().count() > MAX_NAME_CHARS || name.chars().any(char::is_control) {
            skip(&mut notes, "import.tooLong", Some("name".into()));
            continue;
        }
        let group = p.group.map(|g| g.trim().to_string()).filter(|g| !g.is_empty());
        if group.as_deref().is_some_and(|g| g.chars().count() > MAX_GROUP_CHARS || g.chars().any(char::is_control)) {
            skip(&mut notes, "import.tooLong", Some("group".into()));
            continue;
        }
        let tenant = p.tenant_lock.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        if tenant.as_deref().is_some_and(|t| t.chars().count() > MAX_TENANT_CHARS || t.chars().any(char::is_control)) {
            skip(&mut notes, "import.tooLong", Some("tenantLock".into()));
            continue;
        }
        let prefs = p.ai_prefs.unwrap_or_default();
        if !ai_prefs_ok(&prefs) {
            skip(&mut notes, "import.tooLong", Some("aiPrefs".into()));
            continue;
        }
        let mut warnings = Vec::new();
        let spec = match finish_spec(p.spec, &mut warnings) {
            Ok(s) => s,
            Err(nt) => {
                skip(&mut notes, &nt.code, nt.option);
                continue;
            }
        };
        let domain = match p.domain {
            Some(Domain::Happy) if opts.happy_preset => Domain::Happy,
            Some(Domain::Happy) => {
                warnings.push(note("import.domainGeneric", None));
                Domain::Generic
            }
            _ => Domain::Generic,
        };
        if let Some(s) = &p.secrets {
            for (kind, need) in [("password", s.password), ("keyPassword", s.key_password), ("sshSecret", s.ssh_secret), ("proxyPassword", s.proxy_password)] {
                if need == Need::Needed {
                    warnings.push(note("import.secretNeeded", Some(kind.to_string())));
                }
            }
        }
        let mut b = build(unique_name(&name, &mut taken), spec, p.environment, warnings);
        b.input.color = clean_color(p.color);
        b.input.group = group;
        b.input.favorite = Some(p.favorite.unwrap_or(false));
        b.input.tenant_lock = tenant;
        b.input.domain = Some(domain);
        b.input.ai_prefs = Some(prefs);
        items.push(b.item);
        inputs.push(b.input);
    }
    Ok((ImportPreview { items, notes }, inputs))
}

/// The URI-list importer with the real parser.
pub fn import_uri_list(text: &str, opts: &ImportOptions) -> Result<(ImportPreview, Vec<ProfileInput>)> {
    import_uri_list_with(text, opts, &parse_connection_string)
}

fn is_uri_line(l: &str) -> bool {
    let l = l.to_ascii_lowercase();
    l.starts_with("mongodb://") || l.starts_with("mongodb+srv://")
}

/// One connection string per line (blank lines and `#` comments are ignored; other lines are skipped with a note that
/// carries the line number). At most [`MAX_URI_LINES`] strings. The password a string carries goes straight into
/// `ProfileInput.password` (Rust only: it has a redacted `Debug`, wipes on drop and reaches the Keychain through
/// `save()`); it never appears in the preview. `parse` is injectable so the tests need no driver.
pub fn import_uri_list_with(text: &str, opts: &ImportOptions, parse: &dyn Fn(&str) -> Result<Parsed>) -> Result<(ImportPreview, Vec<ProfileInput>)> {
    if text.len() > MAX_BYTES {
        return Err(err("import.tooLarge", None));
    }
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines: Vec<(usize, &str)> = text.lines().enumerate().map(|(i, l)| (i + 1, l.trim())).filter(|(_, l)| !l.is_empty() && !l.starts_with('#')).collect();
    if lines.iter().filter(|(_, l)| is_uri_line(l)).count() > MAX_URI_LINES {
        return Err(err("import.tooManyLines", None));
    }
    let mut taken: HashSet<String> = opts.existing_names.iter().map(|n| n.to_lowercase()).collect();
    let (mut items, mut inputs, mut notes) = (Vec::new(), Vec::new(), Vec::new());
    for (line, l) in lines {
        let at = |c: &str| note(c, Some(format!("line {line}")));
        if !is_uri_line(l) {
            notes.push(at("import.lineIgnored"));
            continue;
        }
        // The parser's own message may quote the string: only the code survives.
        let Ok(parsed) = parse(l) else {
            notes.push(at("import.uriInvalid"));
            continue;
        };
        let mut warnings: Vec<Note> = parsed.notes.iter().chain(parsed.unsupported.iter()).cloned().collect();
        if parsed.tls_relax {
            // An import never relaxes certificate checks; the user can turn it on later with the typed confirmation.
            warnings.push(note("import.tlsRelaxDropped", None));
        }
        let spec = match finish_spec(parsed.spec, &mut warnings) {
            Ok(s) => s,
            Err(nt) => {
                notes.push(note(&nt.code, Some(format!("line {line}"))));
                continue;
            }
        };
        let base: String = spec.hosts.first().map(|h| h.host.clone()).unwrap_or_else(|| "MongoDB".into()).chars().take(MAX_NAME_CHARS).collect();
        let mut b = build(unique_name(&base, &mut taken), spec, None, warnings);
        b.input.domain = Some(Domain::Generic);
        b.input.password = parsed.secrets.password.as_ref().map(|s| WireSecret::new(s.expose()));
        b.input.key_password = parsed.secrets.key_password.as_ref().map(|s| WireSecret::new(s.expose()));
        items.push(b.item);
        inputs.push(b.input);
    }
    Ok((ImportPreview { items, notes }, inputs))
}

// ---- the two file helpers ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Regular,
    Symlink,
    Fifo,
    Device,
    Directory,
    Other,
}

pub struct OpenedFile {
    pub kind: FileKind,
    pub len: u64,
    pub reader: Box<dyn Read>,
}

/// Where an import file is opened from; the real one is [`OsFiles`], the tests use a fake.
pub trait FileSource {
    fn open(&self, path: &Path) -> std::io::Result<OpenedFile>;
}

/// The real file system: `O_NOFOLLOW | O_NONBLOCK` (a symlink is not followed, a FIFO or device cannot block the open),
/// then `fstat` on the opened descriptor.
#[derive(Debug, Default, Clone, Copy)]
pub struct OsFiles;

impl FileSource for OsFiles {
    #[cfg(unix)]
    fn open(&self, path: &Path) -> std::io::Result<OpenedFile> {
        use std::os::unix::fs::{FileTypeExt, OpenOptionsExt};
        let f = match std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path) {
            Ok(f) => f,
            Err(e) if e.raw_os_error() == Some(libc::ELOOP) => return Ok(OpenedFile { kind: FileKind::Symlink, len: 0, reader: Box::new(std::io::empty()) }),
            Err(e) => return Err(e),
        };
        let m = f.metadata()?;
        let t = m.file_type();
        let kind = if t.is_file() {
            FileKind::Regular
        } else if t.is_dir() {
            FileKind::Directory
        } else if t.is_fifo() {
            FileKind::Fifo
        } else if t.is_char_device() || t.is_block_device() {
            FileKind::Device
        } else {
            FileKind::Other
        };
        Ok(OpenedFile { kind, len: m.len(), reader: Box::new(f) })
    }

    #[cfg(not(unix))]
    fn open(&self, path: &Path) -> std::io::Result<OpenedFile> {
        let f = std::fs::File::open(path)?;
        let m = f.metadata()?;
        Ok(OpenedFile { kind: if m.is_file() { FileKind::Regular } else { FileKind::Other }, len: m.len(), reader: Box::new(f) })
    }
}

/// Reads an import file: regular files only, at most [`MAX_BYTES`]. Errors carry a code, never the path.
pub fn read_import_file(path: &Path, files: &dyn FileSource) -> Result<Vec<u8>> {
    let f = files.open(path).map_err(|_| err("import.unreadable", None))?;
    if f.kind != FileKind::Regular {
        return Err(err("import.notRegular", None));
    }
    if f.len > MAX_BYTES as u64 {
        return Err(err("import.tooLarge", None));
    }
    let mut buf = Vec::new();
    f.reader.take(MAX_BYTES as u64 + 1).read_to_end(&mut buf).map_err(|_| err("import.unreadable", None))?;
    if buf.len() > MAX_BYTES {
        return Err(err("import.tooLarge", None));
    }
    Ok(buf)
}

/// Writes an export file: a fresh 0600 temp file next to the target (`create_new`, no symlink followed), synced, then
/// renamed over the target. The rename replaces a symlink at the target instead of writing through it. Overwriting an
/// existing file is the native dialog's confirmed choice.
pub fn write_export_file(path: &Path, contents: &str) -> Result<()> {
    use std::io::Write;
    let fail = || err("import.writeFailed", None);
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    let name = path.file_name().ok_or_else(fail)?;
    if path.is_dir() {
        return Err(fail());
    }
    let mut rnd = [0u8; 6];
    getrandom::fill(&mut rnd).map_err(|_| fail())?;
    let tmp = dir.join(format!(".{}.{}.tmp", name.to_string_lossy(), rnd.iter().map(|b| format!("{b:02x}")).collect::<String>()));
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let result = (|| -> std::io::Result<()> {
        let mut f = o.open(&tmp)?;
        f.write_all(contents.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err(fail());
    }
    Ok(())
}
