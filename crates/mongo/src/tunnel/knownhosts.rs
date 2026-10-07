//! App-owned known_hosts, host-key scan, status and trust (T4a).
//!
//! The host key of the bastion is verified by ssh itself (`StrictHostKeyChecking=yes`) against the app-owned file
//! `mongo_known_hosts` plus the user's own `~/.ssh/known_hosts` (read only here). This module only helps the user decide
//! on a NEW key: it scans (`ssh-keyscan`), looks entries up (`ssh-keygen -F`) and, after an explicit confirmation bound
//! to a fresh scan, appends a line **it builds itself** from validated parts (scanned text is never appended verbatim,
//! so no wildcard, `@cert-authority` or marker can be smuggled in). A changed key has no trust path.

use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::ssh::{
    gate, host_key_error, host_ok, refuse_under_readonly, resolve_host, sanitize_stderr, tcode, tunnel_error, Resolved, RunRequest, SshCtx,
};
use crate::api::{ForgetReport, HostKeyStatus, HostKeyView};
use crate::connspec::SshSpec;
use crate::error::{code, Result, StudioError};

/// The entries of the app-owned file are capped.
pub const MAX_ENTRIES: usize = 256;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_B64: usize = 8192;
/// Key types accepted from a scan, in the order the UI prefers them.
pub const KEY_TYPES: [&str; 5] = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa"];

// ---------------------------------------------------------------------------------------------------------------------
// Base64 (std only; the keys are small)
// ---------------------------------------------------------------------------------------------------------------------

const ALPHA: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn b64_encode(data: &[u8], pad: bool) -> String {
    let mut out = String::with_capacity(data.len() * 4 / 3 + 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(ALPHA[(n >> 18 & 63) as usize] as char);
        out.push(ALPHA[(n >> 12 & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHA[(n >> 6 & 63) as usize] as char);
        } else if pad {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHA[(n & 63) as usize] as char);
        } else if pad {
            out.push('=');
        }
    }
    out
}

/// Strict standard-alphabet decoder: padded, canonical (re-encoding gives back the input), no whitespace.
pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    if s.is_empty() || s.len() % 4 != 0 {
        return None;
    }
    let trimmed = s.trim_end_matches('=');
    if s.len() - trimmed.len() > 2 {
        return None;
    }
    let (mut buf, mut bits, mut out) = (0u32, 0u32, Vec::with_capacity(s.len() * 3 / 4));
    for c in trimmed.bytes() {
        let v = ALPHA.iter().position(|a| *a == c)? as u32;
        buf = (buf << 6 | v) & 0xFFFF;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits & 0xFF) as u8);
        }
    }
    (b64_encode(&out, true) == s).then_some(out)
}

// ---------------------------------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedKey {
    pub key_type: String,
    /// Canonical padded base64 of the key blob.
    pub b64: String,
    /// `SHA256:` plus unpadded base64 of the SHA-256 of the blob (what `ssh-keygen -l` prints).
    pub fingerprint: String,
}

/// Validates a key: a known type, canonical base64, and a blob whose embedded type string equals `key_type`.
pub fn parse_key(key_type: &str, b64: &str) -> Option<ScannedKey> {
    if !KEY_TYPES.contains(&key_type) || b64.len() > MAX_B64 {
        return None;
    }
    let blob = b64_decode(b64)?;
    if blob.len() < 4 {
        return None;
    }
    let n = u32::from_be_bytes([blob[0], blob[1], blob[2], blob[3]]) as usize;
    if blob.get(4..4 + n)? != key_type.as_bytes() {
        return None;
    }
    Some(ScannedKey { key_type: key_type.to_string(), b64: b64_encode(&blob, true), fingerprint: format!("SHA256:{}", b64_encode(&Sha256::digest(&blob), false)) })
}

fn parse_lines(text: &str, skip_markers: bool) -> Vec<ScannedKey> {
    let mut out: Vec<ScannedKey> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || (skip_markers && line.starts_with('@')) {
            continue;
        }
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 3 {
            continue;
        }
        if let Some(k) = parse_key(f[1], f[2]) {
            if !out.iter().any(|o| o.fingerprint == k.fingerprint) && out.len() < 16 {
                out.push(k);
            }
        }
    }
    out
}

/// The keys in `ssh-keyscan` output (the host column is ignored: it is rebuilt from the validated host).
pub fn parse_keyscan(text: &str) -> Vec<ScannedKey> {
    let mut v = parse_lines(text, true);
    v.sort_by_key(|k| KEY_TYPES.iter().position(|t| *t == k.key_type));
    v
}

/// The keys in `ssh-keygen -F` output. Marker lines (`@revoked`, `@cert-authority`) never count as a match.
pub fn parse_known_entries(text: &str) -> Vec<ScannedKey> {
    parse_lines(text, true)
}

/// The `known_hosts` host field ssh matches: `host` on port 22, `[host]:port` otherwise.
pub fn host_pattern(host: &str, port: u16) -> String {
    let h = host.to_ascii_lowercase();
    if port == 22 {
        h
    } else {
        format!("[{h}]:{port}")
    }
}

/// The line that is appended on trust, built from validated parts only.
pub fn known_hosts_line(host: &str, port: u16, key_type: &str, b64: &str) -> Result<String> {
    if !host_ok(host) || port == 0 {
        return Err(host_key_error(tcode::CONFIG, "the host is not valid"));
    }
    let key = parse_key(key_type, b64).ok_or_else(|| host_key_error(tcode::CONFIG, "the host key is not valid"))?;
    Ok(format!("{} {} {}\n", host_pattern(host, port), key.key_type, key.b64))
}

/// Overall status: `Known` when any scanned key equals an entry; `Changed` when entries exist and none matches (also
/// when they are of another key type: ssh would refuse); `Unknown` when no entry exists.
pub fn classify_status(entries: &[ScannedKey], scanned: &[ScannedKey]) -> HostKeyStatus {
    if entries.is_empty() {
        HostKeyStatus::Unknown
    } else if scanned.iter().any(|s| entries.iter().any(|e| e.fingerprint == s.fingerprint)) {
        HostKeyStatus::Known
    } else {
        HostKeyStatus::Changed
    }
}

/// Only an unknown key may be trusted from the UI. `Changed` has no trust path.
pub fn trust_allowed(status: HostKeyStatus) -> bool {
    status == HostKeyStatus::Unknown
}

/// The files ssh consults (and `ssh-keygen -F` must look in): the app file, plus `~/.ssh/known_hosts` unless the ssh
/// config is off (`-F /dev/null`, always so under a jail).
pub fn known_files(app_file: &Path, home_file: Option<&Path>, config_off: bool) -> Vec<PathBuf> {
    let mut v = vec![app_file.to_path_buf()];
    if let (false, Some(h)) = (config_off, home_file) {
        v.push(h.to_path_buf());
    }
    v
}

// ---------------------------------------------------------------------------------------------------------------------
// Scan, lookup, inspect
// ---------------------------------------------------------------------------------------------------------------------

fn host_only_spec(host: &str) -> SshSpec {
    SshSpec { host: host.to_string(), ..Default::default() }
}

fn run_tool(ctx: &SshCtx<'_>, program: &Path, args: &[String], timeout: Duration) -> Result<super::ssh::RunOutput> {
    ctx.runner
        .run(&RunRequest { program, args, env: ctx.env, stdin: None, timeout })
        .map_err(|_| tunnel_error(tcode::NO_SSH, "an OpenSSH tool could not be started"))
}

/// `ssh-keyscan -T 5 -p <port> -t ed25519,ecdsa,rsa -- <host>`. Jail-gated; no credentials are ever sent.
pub fn scan_host_key(ctx: &SshCtx<'_>, host: &str, port: u16) -> Result<Vec<ScannedKey>> {
    if !host_ok(host) || port == 0 {
        return Err(host_key_error(tcode::CONFIG, "the host is not valid"));
    }
    gate(ctx.jail, &host_only_spec(host))?;
    let args: Vec<String> = ["-T", "5", "-p"].iter().map(|s| s.to_string()).chain([port.to_string(), "-t".into(), "ed25519,ecdsa,rsa".into(), "--".into(), host.to_string()]).collect();
    let out = run_tool(ctx, &ctx.bin.keyscan, &args, Duration::from_secs(15))?;
    let keys = parse_keyscan(&String::from_utf8_lossy(&out.stdout));
    if keys.is_empty() {
        let why = sanitize_stderr(&out.stderr);
        return Err(tunnel_error(tcode::NETWORK, format!("no host key was received{}", if why.is_empty() { String::new() } else { format!(": {}", why.trim()) })));
    }
    Ok(keys)
}

/// `ssh-keygen -F <pattern> -f <file>` over every file; a missing file or no entry is simply no entry.
pub fn lookup_entries(ctx: &SshCtx<'_>, files: &[PathBuf], host: &str, port: u16) -> Result<Vec<ScannedKey>> {
    refuse_under_readonly(ctx.jail)?;
    let pattern = host_pattern(host, port);
    let mut all: Vec<ScannedKey> = Vec::new();
    for f in files {
        let f = f.to_str().ok_or_else(|| tunnel_error(tcode::CONFIG, "a known_hosts path is not valid text"))?;
        let args = vec!["-F".to_string(), pattern.clone(), "-f".to_string(), f.to_string()];
        let out = run_tool(ctx, &ctx.bin.keygen, &args, Duration::from_secs(5))?;
        if out.timed_out {
            return Err(tunnel_error(tcode::CONFIG, "ssh-keygen did not answer"));
        }
        if out.code == Some(0) {
            for k in parse_known_entries(&String::from_utf8_lossy(&out.stdout)) {
                if !all.iter().any(|o| o.fingerprint == k.fingerprint) {
                    all.push(k);
                }
            }
        }
    }
    Ok(all)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostKeyReport {
    pub resolved: Resolved,
    pub status: HostKeyStatus,
    /// Every scanned key; each carries the overall status.
    pub keys: Vec<HostKeyView>,
}

/// `mongo_ssh_hostkey`: resolve with `ssh -G`, scan the resolved `HostName:Port`, look it up in the known files.
/// A bastion reached through `ProxyJump` or `ProxyCommand` cannot be scanned: `tunnel.hostKeyUnscannable`.
pub fn inspect_host_key(ctx: &SshCtx<'_>, spec: &SshSpec, app_file: &Path, home_file: Option<&Path>) -> Result<HostKeyReport> {
    let resolved = resolve_host(ctx, spec)?;
    if !resolved.scannable() {
        return Err(host_key_error(tcode::HOST_KEY_UNSCANNABLE, "this server is reached through a jump host or proxy command; run ssh to it once in a terminal, then retry"));
    }
    let scanned = scan_host_key(ctx, &resolved.hostname, resolved.port)?;
    let files = known_files(app_file, home_file, super::ssh::config_off(spec, ctx.jail.policy()));
    let entries = lookup_entries(ctx, &files, &resolved.hostname, resolved.port)?;
    let status = classify_status(&entries, &scanned);
    let keys = scanned
        .iter()
        .map(|k| HostKeyView { host: resolved.hostname.clone(), port: resolved.port, key_type: k.key_type.clone(), fingerprint: k.fingerprint.clone(), status })
        .collect();
    Ok(HostKeyReport { resolved, status, keys })
}

// ---------------------------------------------------------------------------------------------------------------------
// Trust and forget (writes: jail-gated, app-owned file only)
// ---------------------------------------------------------------------------------------------------------------------

fn valid_fingerprint(f: &str) -> bool {
    f.strip_prefix("SHA256:").is_some_and(|r| r.len() == 43 && r.bytes().all(|c| ALPHA.contains(&c)))
}

fn count_entries(path: &Path) -> Result<usize> {
    match std::fs::metadata(path) {
        Ok(m) if m.len() > MAX_FILE_BYTES => Err(host_key_error(tcode::CONFIG, "the saved host key file is too large")),
        Ok(_) => {
            let text = std::fs::read_to_string(path).map_err(|_| host_key_error(tcode::CONFIG, "the saved host key file could not be read"))?;
            Ok(text.lines().filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#')).count())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(_) => Err(host_key_error(tcode::CONFIG, "the saved host key file could not be read")),
    }
}

#[cfg(unix)]
fn append_line(path: &Path, line: &str) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let fail = |m: &str| host_key_error(tcode::CONFIG, m);
    let mut f = std::fs::OpenOptions::new().append(true).create(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(path).map_err(|_| fail("the saved host key file could not be opened"))?;
    if !f.metadata().map_err(|_| fail("the saved host key file could not be read"))?.is_file() {
        return Err(fail("the saved host key file is not a regular file"));
    }
    // a file that does not end in a newline would glue our line onto its last one
    let needs_nl = std::fs::read(path).map(|b| !b.is_empty() && b.last() != Some(&b'\n')).unwrap_or(false);
    let data = if needs_nl { format!("\n{line}") } else { line.to_string() };
    f.write_all(data.as_bytes()).map_err(|_| fail("the host key could not be saved"))
}

#[cfg(not(unix))]
fn append_line(_path: &Path, _line: &str) -> Result<()> {
    Err(tunnel_error(tcode::NO_SSH, "SSH tunnels are not available on this system"))
}

/// `mongo_ssh_trust`: re-scans, requires a key with exactly `fingerprint`, refuses when the status is `Changed`, builds the
/// line itself and appends it to the app-owned file. `files` are the files ssh consults ([`known_files`]).
pub fn trust_host_key(ctx: &SshCtx<'_>, host: &str, port: u16, fingerprint: &str, app_file: &Path, files: &[PathBuf]) -> Result<()> {
    if !host_ok(host) || port == 0 || !valid_fingerprint(fingerprint) {
        return Err(host_key_error(tcode::CONFIG, "the host key request is not valid"));
    }
    gate(ctx.jail, &host_only_spec(host))?;
    ctx.jail.check_write(app_file)?;
    let scanned = scan_host_key(ctx, host, port)?;
    let key = scanned
        .iter()
        .find(|k| k.fingerprint == fingerprint)
        .ok_or_else(|| host_key_error(tcode::HOST_KEY_CHANGED, "the server now offers a different key than the one you confirmed"))?;
    let entries = lookup_entries(ctx, files, host, port)?;
    match classify_status(&entries, &scanned) {
        HostKeyStatus::Known => return Ok(()),
        s if !trust_allowed(s) => return Err(host_key_error(tcode::HOST_KEY_CHANGED, "the saved key for this server differs; forget it first")),
        _ => {}
    }
    if count_entries(app_file)? >= MAX_ENTRIES {
        return Err(host_key_error(tcode::CONFIG, "the saved host key file is full"));
    }
    append_line(app_file, &known_hosts_line(host, port, &key.key_type, &key.b64)?)
}

/// `mongo_ssh_forget`: removes only the entries of `host:port` from the app-owned file (`ssh-keygen -R ... -f`), after the
/// user typed the host name. `old` are the removed fingerprints, `current` the fingerprints the server offers now (empty
/// when it cannot be reached).
pub fn forget_host_key(ctx: &SshCtx<'_>, host: &str, port: u16, typed_host: &str, app_file: &Path) -> Result<ForgetReport> {
    if !host_ok(host) || port == 0 {
        return Err(host_key_error(tcode::CONFIG, "the host key request is not valid"));
    }
    if !typed_host.trim().eq_ignore_ascii_case(host) {
        return Err(StudioError::new(code::CONFIRM, "type the host name to forget its saved key"));
    }
    gate(ctx.jail, &host_only_spec(host))?;
    let mut backup = app_file.as_os_str().to_os_string();
    backup.push(".old");
    let backup = PathBuf::from(backup);
    ctx.jail.check_write(app_file)?;
    ctx.jail.check_write(&backup)?;
    let old: Vec<String> = lookup_entries(ctx, &[app_file.to_path_buf()], host, port)?.into_iter().map(|k| k.fingerprint).collect();
    if !old.is_empty() {
        let f = app_file.to_str().ok_or_else(|| tunnel_error(tcode::CONFIG, "a known_hosts path is not valid text"))?;
        let args = vec!["-R".to_string(), host_pattern(host, port), "-f".to_string(), f.to_string()];
        let out = run_tool(ctx, &ctx.bin.keygen, &args, Duration::from_secs(5))?;
        let _ = std::fs::remove_file(&backup);
        if out.timed_out || out.code != Some(0) {
            return Err(host_key_error(tcode::CONFIG, "the saved host key could not be removed"));
        }
    }
    let current = scan_host_key(ctx, host, port).map(|v| v.into_iter().map(|k| k.fingerprint).collect()).unwrap_or_default();
    Ok(ForgetReport { old, current })
}
