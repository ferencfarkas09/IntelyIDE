//! Bundle staging and Ed25519 signing (spec 4.5, 4.12.2). Signing happens in-process with `ring`: no key is written to disk and no
//! key reaches a child process, an argument list or an environment.

use std::fs;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde::Serialize;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::error::{BundleError, Result};
use crate::manifest::{
    b64u_bytes, manifest_hash, signed_message, valid_path, verify_manifest_str, FileEntry, VerifyOpts, MANIFEST_NAME, MAX_SEQ,
};
use crate::stage::{self, Limits, Skip, PUSH_CONFIG};
use crate::Secret;

/// A staged and signed copy of `remote-web/dist`, ready to be deployed as the Worker's static assets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedBundle {
    pub dir: PathBuf,
    /// `manifestSha256` (lowercase hex).
    pub hash: String,
    /// Raw Ed25519 public key, base64url.
    pub pubkey: String,
    pub seq: u64,
    pub files: usize,
    pub bytes: u64,
}

/// Knobs beyond the contract function. `Default` is what `stage_and_sign` uses.
#[derive(Debug, Clone, Default)]
pub struct SignOptions {
    pub limits: Limits,
    /// Extra public files (for example `licenses.txt`): `(path, bytes)`. They go through the same name rules as the build files.
    pub extra_files: Vec<(String, Vec<u8>)>,
    /// The typed override of spec 4.5: sign although the stored `seq` is more than 24 hours ahead of the clock.
    pub allow_seq_clock_skew: bool,
}

/// What `stage_and_sign_with` returns besides the bundle: the complete signed file list (path, size, sha256) for the review screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Staged {
    pub bundle: StagedBundle,
    pub file_list: Vec<FileEntry>,
    /// Unix seconds the manifest records as `builtAt`.
    pub built_at: u64,
}

/// New Ed25519 signing key: `(pkcs8 secret, public key base64url)`. The secret is the PKCS#8 DER, standard base64 (no PEM).
pub fn generate_signing_key() -> Result<(Secret, String)> {
    let rng = SystemRandom::new();
    let doc = Ed25519KeyPair::generate_pkcs8(&rng).map_err(|_| BundleError::BadKey)?;
    let pair = Ed25519KeyPair::from_pkcs8(doc.as_ref()).map_err(|_| BundleError::BadKey)?;
    let pubkey = URL_SAFE_NO_PAD.encode(pair.public_key().as_ref());
    let secret = Secret::new(STANDARD.encode(doc.as_ref()));
    Ok((secret, pubkey))
}

/// The public key (base64url) of a signing key made by `generate_signing_key` (or a PEM/base64 PKCS#8 from `gen-bundle-key.mjs`).
pub fn public_key_of(key: &Secret) -> Result<String> {
    let pair = load_key(key)?;
    Ok(URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()))
}

/// `"a1b2 c3d4 e5f6 0718"`: the first 8 bytes of sha256 of the raw public key, hex, in groups of four. Empty when `pub_b64u` is not a
/// 32-byte base64url key.
pub fn fingerprint(pub_b64u: &str) -> String {
    let Some(raw) = b64u_bytes(pub_b64u, 32) else { return String::new() };
    let h = hex::encode(&Sha256::digest(&raw)[..8]);
    h.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap_or("")).collect::<Vec<_>>().join(" ")
}

/// Accepts a PKCS#8 DER in standard or URL-safe base64, or a PEM block (what `gen-bundle-key.mjs` writes).
fn load_key(key: &Secret) -> Result<Ed25519KeyPair> {
    let text = key.expose().trim();
    let b64: String = if text.starts_with("-----BEGIN") {
        text.lines().filter(|l| !l.starts_with("-----")).collect::<Vec<_>>().join("")
    } else {
        text.to_owned()
    };
    let der = Zeroizing::new(
        STANDARD
            .decode(b64.as_bytes())
            .or_else(|_| URL_SAFE_NO_PAD.decode(b64.as_bytes()))
            .map_err(|_| BundleError::BadKey)?,
    );
    // `maybe_unchecked` also accepts the PKCS#8 v1 form node writes (no embedded public key).
    Ed25519KeyPair::from_pkcs8_maybe_unchecked(&der).map_err(|_| BundleError::BadKey)
}

#[derive(Serialize)]
struct Manifest<'a> {
    v: u8,
    files: &'a [FileEntry],
    #[serde(rename = "manifestSha256")]
    manifest_sha256: &'a str,
    seq: u64,
    #[serde(rename = "builtAt")]
    built_at: u64,
    sig: &'a str,
    pubkey: &'a str,
}

/// Walks `web_dist` with `lstat` (regular files only, allow-listed extensions, caps), copies it to `staging`, writes `bundle.json`
/// v2 and signs `"intely-bundle-v2\n" + manifestSha256 + "\n" + seq`. `prev_seq` is the highest `seq` signed before; `now` is Unix seconds.
///
/// `seq` is `now` for the first signature and `prev_seq + 1` after that. `push-config.json` is written with `vapid_public` (or the
/// public default `{"vapidPublicKey":null}`), replacing whatever the build contained. Signing is refused when `prev_seq` is more
/// than 24 hours ahead of `now` (`BundleError::SeqClock`).
pub fn stage_and_sign(
    web_dist: &Path,
    staging: &Path,
    key: &Secret,
    vapid_public: Option<&str>,
    prev_seq: Option<u64>,
    now: u64,
) -> Result<StagedBundle> {
    stage_and_sign_with(web_dist, staging, key, vapid_public, prev_seq, now, &SignOptions::default()).map(|s| s.bundle)
}

pub fn stage_and_sign_with(
    web_dist: &Path,
    staging: &Path,
    key: &Secret,
    vapid_public: Option<&str>,
    prev_seq: Option<u64>,
    now: u64,
    opts: &SignOptions,
) -> Result<Staged> {
    if let Some(p) = vapid_public {
        // Only the text is checked (it goes into a JSON file); the key itself comes from `generate_vapid`.
        if p.is_empty() || p.len() > 128 || !p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err(BundleError::Invalid("the VAPID public key must be base64url text".into()));
        }
    }
    let seq = next_seq(prev_seq, now, opts.allow_seq_clock_skew)?;
    let pair = load_key(key)?;
    let pubkey = URL_SAFE_NO_PAD.encode(pair.public_key().as_ref());
    for (path, _) in &opts.extra_files {
        if !valid_path(path) || path == MANIFEST_NAME || path == PUSH_CONFIG {
            return Err(BundleError::Invalid(format!("extra file path {path:?} is not allowed")));
        }
    }

    check_staging_location(web_dist, staging)?;
    let found = stage::walk(web_dist, &opts.limits, Skip { push_config: true })?;

    // Build in a private sibling directory and swap it in at the end, so a failure leaves the previous staging untouched.
    let parent = staging.parent().ok_or_else(|| BundleError::Invalid("staging has no parent directory".into()))?;
    stage::create_dir_private(parent)?;
    let work = parent.join(format!(".{}.stage-{}", staging.file_name().and_then(|n| n.to_str()).unwrap_or("dist"), std::process::id()));
    let _ = fs::remove_dir_all(&work);
    stage::create_dir_private(&work)?;
    let built = (|| -> Result<Staged> {
        for f in &found {
            let bytes = stage::read_regular(&f.abs, &f.meta, opts.limits.max_file_bytes, &f.rel)?;
            put(&work, &f.rel, &bytes)?;
        }
        let push = match vapid_public {
            Some(p) => format!("{{\"vapidPublicKey\":\"{p}\"}}\n"),
            None => "{\"vapidPublicKey\":null}\n".to_owned(),
        };
        put(&work, PUSH_CONFIG, push.as_bytes())?;
        for (path, bytes) in &opts.extra_files {
            if work.join(path).exists() {
                return Err(BundleError::Invalid(format!("extra file {path:?} collides with a build file")));
            }
            put(&work, path, bytes)?;
        }
        // The manifest is computed from the staged copy, in the walk order, so it equals what `listFiles` yields for this directory.
        let staged_found = stage::walk(&work, &opts.limits, Skip { push_config: false })?;
        let file_list = stage::entries(&staged_found, &opts.limits)?;
        let hash = manifest_hash(&file_list);
        let sig = URL_SAFE_NO_PAD.encode(pair.sign(&signed_message(&hash, seq)).as_ref());
        let manifest = Manifest { v: 2, files: &file_list, manifest_sha256: &hash, seq, built_at: now, sig: &sig, pubkey: &pubkey };
        let text = serde_json::to_string(&manifest).map_err(|e| BundleError::Io(e.to_string()))?;
        stage::write_new(&work.join(MANIFEST_NAME), text.as_bytes())?;
        let bytes = file_list.iter().map(|f| f.size).sum();
        Ok(Staged {
            bundle: StagedBundle { dir: staging.to_path_buf(), hash, pubkey: pubkey.clone(), seq, files: file_list.len(), bytes },
            file_list,
            built_at: now,
        })
    })();
    match built {
        Ok(staged) => {
            replace_dir(&work, staging)?;
            Ok(staged)
        }
        Err(e) => {
            let _ = fs::remove_dir_all(&work);
            Err(e)
        }
    }
}

fn next_seq(prev: Option<u64>, now: u64, allow_skew: bool) -> Result<u64> {
    let seq = match prev {
        None => now,
        Some(p) if p >= MAX_SEQ => return Err(BundleError::SeqExhausted),
        Some(p) if p > now.saturating_add(86_400) && !allow_skew => return Err(BundleError::SeqClock { stored: p, now }),
        Some(p) => p + 1,
    };
    if seq > MAX_SEQ {
        return Err(BundleError::SeqExhausted);
    }
    Ok(seq)
}

fn put(root: &Path, rel: &str, bytes: &[u8]) -> Result<()> {
    let target = root.join(rel);
    if let Some(dir) = target.parent() {
        stage::create_dir_private(dir)?;
    }
    stage::write_new(&target, bytes)
}

/// The staging directory must not be (inside) the web build or contain it, must not be a link, and when it exists it must be empty or
/// a previous staged bundle (it has a `bundle.json`): this function is about to delete it.
fn check_staging_location(web_dist: &Path, staging: &Path) -> Result<()> {
    let src = fs::canonicalize(web_dist).map_err(|e| BundleError::Io(format!("cannot read the build directory: {e}")))?;
    let name = staging.file_name().ok_or_else(|| BundleError::Invalid("staging path has no name".into()))?;
    let parent = staging.parent().ok_or_else(|| BundleError::Invalid("staging has no parent directory".into()))?;
    let canon_parent = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    let dst = canon_parent.join(name);
    if dst.starts_with(&src) || src.starts_with(&dst) {
        return Err(BundleError::Invalid("the staging directory overlaps the web build".into()));
    }
    match fs::symlink_metadata(staging) {
        Ok(m) if m.file_type().is_symlink() || !m.is_dir() => Err(BundleError::Invalid("the staging path is not a plain directory".into())),
        Ok(_) => {
            let empty = fs::read_dir(staging)?.next().is_none();
            if empty || staging.join(MANIFEST_NAME).is_file() {
                Ok(())
            } else {
                Err(BundleError::Invalid("the staging directory is not empty and holds no staged bundle".into()))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn replace_dir(work: &Path, staging: &Path) -> Result<()> {
    if fs::symlink_metadata(staging).is_ok() {
        let old = work.with_extension("old");
        let _ = fs::remove_dir_all(&old);
        fs::rename(staging, &old)?;
        fs::rename(work, staging)?;
        let _ = fs::remove_dir_all(&old);
    } else {
        fs::rename(work, staging)?;
    }
    Ok(())
}

/// Re-checks a staged directory right before a deploy: walks it again (same rules, links refused), re-hashes every file and compares
/// with the signed manifest in `bundle.json` under `pin` (when given). Returns the verified file list.
pub fn verify_staged(dir: &Path, pin: Option<&str>, min_seq: Option<u64>) -> Result<Vec<FileEntry>> {
    let limits = Limits::default();
    let manifest_path = dir.join(MANIFEST_NAME);
    let meta = fs::symlink_metadata(&manifest_path).map_err(|_| BundleError::Changed("bundle.json is missing".into()))?;
    if !meta.is_file() {
        return Err(BundleError::Changed("bundle.json is not a regular file".into()));
    }
    let text = String::from_utf8(stage::read_regular(&manifest_path, &meta, 8 * 1024 * 1024, MANIFEST_NAME)?)
        .map_err(|_| BundleError::Changed("bundle.json is not text".into()))?;
    let verified = verify_manifest_str(&text, &VerifyOpts { pin, min_seq, allow_v1: false })
        .map_err(|f| BundleError::Changed(format!("manifest check failed: {}", f.code.as_str())))?;
    let changed = |e: BundleError| BundleError::Changed(e.to_string());
    let found = stage::walk(dir, &limits, Skip { push_config: false }).map_err(changed)?;
    let entries = stage::entries(&found, &limits).map_err(changed)?;
    if entries != verified.files {
        return Err(BundleError::Changed("the staged files differ from the signed manifest".into()));
    }
    Ok(entries)
}
