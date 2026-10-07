//! Keychain items of the relay (spec 4.10, 4.12.9): the Ed25519 signing key, its monotonic `seq` counter, the VAPID private key and
//! the optional Cloudflare API token. Keys and the sequence are only created or used when the secret store is durable: the fallback
//! store drops to memory after the first Keychain failure, and a key generated in memory is lost at quit (every phone would then show
//! `keyChanged`). The E2E jail runs on a memory store on purpose and is the only exception.

use intely_core::jail::{Jail, Mode};
use intely_relay_bundle::{generate_signing_key, generate_vapid, public_from_private, public_key_of, VapidKeys};
use intely_settings::secrets::SecretStore;

use crate::error::{DeployError, Result};
use crate::Secret;

pub const KEY_SIGNING: &str = "remote.bundle.key";
/// A rotated signing key that is not active yet: it replaces `KEY_SIGNING` only after the redeploy that ships it and the relay check
/// passed (`commit_staged_signing_key`); until then the old key stays the active one and a failure leaves it untouched.
pub const KEY_SIGNING_NEXT: &str = "remote.bundle.key.next";
/// The same for the VAPID private key (`vapid_for_deploy`, `commit_staged_vapid`).
pub const KEY_VAPID_NEXT: &str = "remote.vapid.private.next";
/// Set once a deploy shipped a bundle signed with the staged key (public half as the value): from then on the relay serves it, so the
/// staged key may no longer be discarded or replaced, only committed by the verified redeploy that finishes the rotation. The VAPID
/// twin is set before the secrets that carry the staged private key go out.
pub const KEY_SIGNING_NEXT_SHIPPED: &str = "remote.bundle.key.next.shipped";
pub const KEY_VAPID_NEXT_SHIPPED: &str = "remote.vapid.private.next.shipped";
pub const KEY_SEQ: &str = "remote.bundle.seq";
pub const KEY_VAPID_PRIVATE: &str = "remote.vapid.private";
pub const KEY_API_TOKEN: &str = "remote.cf.apiToken";

fn keychain(e: intely_settings::SettingsError) -> DeployError {
    DeployError::coded("keychain", format!("the secret store failed ({})", e.code))
}

/// `secretStoreVolatile` unless the store reports the macOS Keychain and no remembered failure.
pub fn require_durable(store: &dyn SecretStore, jail: &Jail) -> Result<()> {
    let h = store.health();
    let durable = h.backend == "keychain" && !h.degraded;
    let test_store = jail.mode() == Mode::E2e && h.backend == "memory" && !h.degraded;
    if durable || test_store {
        Ok(())
    } else {
        Err(DeployError::coded("secretStoreVolatile", "the Keychain is not usable, so a signing key would be lost at quit"))
    }
}

/// The signing key and its public half; creates and stores a new key when none exists. `(secret, pub_b64u, created)`.
pub fn signing_key(store: &dyn SecretStore, jail: &Jail) -> Result<(Secret, String, bool)> {
    require_durable(store, jail)?;
    if let Some(k) = store.get(KEY_SIGNING).map_err(keychain)? {
        let public = public_key_of(&k)?;
        return Ok((k, public, false));
    }
    let (secret, public) = generate_signing_key()?;
    store.set(KEY_SIGNING, secret.clone()).map_err(keychain)?;
    Ok((secret, public, true))
}

/// Rotation, step 1: generates a new signing key and holds it STAGED. The active key is not touched, so a failed redeploy loses
/// nothing. The next preview signs with the staged key; `commit_staged_signing_key` makes it the active one after the relay check.
/// Staging again replaces an earlier staged key unless the relay already serves a bundle signed with it (`rotationShipped`).
/// Returns the new public key.
pub fn stage_signing_key(store: &dyn SecretStore, jail: &Jail) -> Result<String> {
    require_durable(store, jail)?;
    refuse_if_shipped(store, KEY_SIGNING_NEXT_SHIPPED)?;
    let (secret, public) = generate_signing_key()?;
    store.set(KEY_SIGNING_NEXT, secret).map_err(keychain)?;
    Ok(public)
}

/// The staged key and its public half, when a rotation is pending.
pub fn staged_signing_key(store: &dyn SecretStore) -> Result<Option<(Secret, String)>> {
    match store.get(KEY_SIGNING_NEXT).map_err(keychain)? {
        Some(k) => {
            let public = public_key_of(&k)?;
            Ok(Some((k, public)))
        }
        None => Ok(None),
    }
}

/// The key a preview signs with: the staged one when a rotation is pending, otherwise the active one (created when missing).
/// `(secret, pub_b64u, staged)`.
pub fn signing_key_for_deploy(store: &dyn SecretStore, jail: &Jail) -> Result<(Secret, String, bool)> {
    require_durable(store, jail)?;
    if let Some((k, public)) = staged_signing_key(store)? {
        return Ok((k, public, true));
    }
    let (k, public, _) = signing_key(store, jail)?;
    Ok((k, public, false))
}

/// Rotation, last step: the verified redeploy was signed with the staged key whose public half is `public`; it becomes the active
/// key and the staged slot is emptied. `false` when no such staged key exists (nothing changes). The active key is written first, so
/// a crash between the two writes leaves the same key in both slots and the next call finishes the job.
pub fn commit_staged_signing_key(store: &dyn SecretStore, public: &str) -> Result<bool> {
    let Some((k, staged_public)) = staged_signing_key(store)? else { return Ok(false) };
    if staged_public != public {
        return Ok(false);
    }
    store.set(KEY_SIGNING, k).map_err(keychain)?;
    store.remove(KEY_SIGNING_NEXT).map_err(keychain)?;
    store.remove(KEY_SIGNING_NEXT_SHIPPED).map_err(keychain)?;
    Ok(true)
}

/// The staged key reached the relay (the deploy step ran with a bundle signed by it): record it, public half as the value.
pub fn mark_signing_shipped(store: &dyn SecretStore, public: &str) -> Result<()> {
    store.set(KEY_SIGNING_NEXT_SHIPPED, Secret::new(public)).map_err(keychain)
}

/// The staged push pair is about to reach the relay (`secret put`): record it.
pub fn mark_vapid_shipped(store: &dyn SecretStore, public: &str) -> Result<()> {
    store.set(KEY_VAPID_NEXT_SHIPPED, Secret::new(public)).map_err(keychain)
}

fn refuse_if_shipped(store: &dyn SecretStore, marker: &str) -> Result<()> {
    if store.get(marker).map_err(keychain)?.is_some() {
        return Err(DeployError::coded("rotationShipped", "the relay already serves the staged key: finish the redeploy, it cannot be rolled back any more"));
    }
    Ok(())
}

/// Rotation rolled back: the staged key is deleted and the active key stays. `true` when there was one. Refused (`rotationShipped`)
/// once a deploy put a bundle signed with it on the relay: the relay would keep serving a key this Mac no longer holds.
pub fn discard_staged_signing_key(store: &dyn SecretStore) -> Result<bool> {
    refuse_if_shipped(store, KEY_SIGNING_NEXT_SHIPPED)?;
    let had = store.get(KEY_SIGNING_NEXT).map_err(keychain)?.is_some();
    store.remove(KEY_SIGNING_NEXT).map_err(keychain)?;
    Ok(had)
}

pub fn read_seq(store: &dyn SecretStore) -> Result<Option<u64>> {
    Ok(store.get(KEY_SEQ).map_err(keychain)?.and_then(|s| s.expose().trim().parse().ok()))
}

/// Persisted at SIGN time, not at Record (spec 4.5).
pub fn write_seq(store: &dyn SecretStore, seq: u64) -> Result<()> {
    store.set(KEY_SEQ, Secret::new(seq.to_string())).map_err(keychain)
}

/// `(private, public)`; `None` when no VAPID key was generated yet.
pub fn vapid(store: &dyn SecretStore) -> Result<Option<(Secret, String)>> {
    match store.get(KEY_VAPID_PRIVATE).map_err(keychain)? {
        Some(p) => {
            let public = public_from_private(&p)?;
            Ok(Some((p, public)))
        }
        None => Ok(None),
    }
}

/// The VAPID pair; generated and stored when missing (durable store only).
pub fn ensure_vapid(store: &dyn SecretStore, jail: &Jail) -> Result<(Secret, String)> {
    require_durable(store, jail)?;
    if let Some(v) = vapid(store)? {
        return Ok(v);
    }
    let VapidKeys { private, public } = generate_vapid()?;
    store.set(KEY_VAPID_PRIVATE, private.clone()).map_err(keychain)?;
    Ok((private, public))
}

/// Rotation, step 1 for the push keys: a new VAPID pair is held STAGED (the active pair, and so the relay's push, keep working).
/// The next preview with push uses it; `commit_staged_vapid` makes it active after the verified redeploy that carries it.
/// Returns the new public key.
pub fn stage_vapid(store: &dyn SecretStore, jail: &Jail) -> Result<String> {
    require_durable(store, jail)?;
    refuse_if_shipped(store, KEY_VAPID_NEXT_SHIPPED)?;
    let VapidKeys { private, public } = generate_vapid()?;
    store.set(KEY_VAPID_NEXT, private).map_err(keychain)?;
    Ok(public)
}

pub fn staged_vapid(store: &dyn SecretStore) -> Result<Option<(Secret, String)>> {
    match store.get(KEY_VAPID_NEXT).map_err(keychain)? {
        Some(p) => {
            let public = public_from_private(&p)?;
            Ok(Some((p, public)))
        }
        None => Ok(None),
    }
}

/// The pair a preview with push uses: the staged one when a rotation is pending, otherwise the active one (created when missing).
/// `(private, public, staged)`.
pub fn vapid_for_deploy(store: &dyn SecretStore, jail: &Jail) -> Result<(Secret, String, bool)> {
    require_durable(store, jail)?;
    if let Some((k, public)) = staged_vapid(store)? {
        return Ok((k, public, true));
    }
    let (k, public) = ensure_vapid(store, jail)?;
    Ok((k, public, false))
}

/// Active key first, then the staged slot is emptied (see `commit_staged_signing_key`). `false` when `public` is not the staged key.
pub fn commit_staged_vapid(store: &dyn SecretStore, public: &str) -> Result<bool> {
    let Some((k, staged_public)) = staged_vapid(store)? else { return Ok(false) };
    if staged_public != public {
        return Ok(false);
    }
    store.set(KEY_VAPID_PRIVATE, k).map_err(keychain)?;
    store.remove(KEY_VAPID_NEXT).map_err(keychain)?;
    store.remove(KEY_VAPID_NEXT_SHIPPED).map_err(keychain)?;
    Ok(true)
}

pub fn discard_staged_vapid(store: &dyn SecretStore) -> Result<bool> {
    refuse_if_shipped(store, KEY_VAPID_NEXT_SHIPPED)?;
    let had = store.get(KEY_VAPID_NEXT).map_err(keychain)?.is_some();
    store.remove(KEY_VAPID_NEXT).map_err(keychain)?;
    Ok(had)
}

pub fn api_token(store: &dyn SecretStore) -> Result<Option<Secret>> {
    store.get(KEY_API_TOKEN).map_err(keychain)
}
