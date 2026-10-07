//! Throwaway signing keys, one per role, generated inside the test (spec 10.1). They produce the
//! exact file formats of `tauri signer`: the `.pub` and `.sig` files are the base64 of the minisign
//! text, signatures are prehashed (`ED`, Blake2b-512 of the data) with a trusted comment and a
//! global signature. Hand-assembled with `ring` + `blake2` (both already in the tree); the golden
//! test in tests/verify.rs checks the verifier against the real `tauri` CLI when it is installed.
//! Nothing here is ever a production key.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use blake2::{Blake2b512, Digest};
use intely_updater::keys::{key_id_hex, KeySet, Revocations, Role, TrustedKey};
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{Ed25519KeyPair, KeyPair};

pub struct TestKey {
    pub role: Role,
    pair: Ed25519KeyPair,
    id_bytes: [u8; 8],
}

impl TestKey {
    pub fn generate(role: Role) -> TestKey {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let mut id_bytes = [0u8; 8];
        rng.fill(&mut id_bytes).unwrap();
        TestKey { role, pair, id_bytes }
    }

    /// 16 hex digits, upper case, as minisign prints it.
    pub fn id(&self) -> String {
        key_id_hex(&self.id_bytes)
    }

    /// Contents of the `.pub` file.
    pub fn public_b64(&self) -> String {
        let mut bin = vec![0x45, 0x64];
        bin.extend_from_slice(&self.id_bytes);
        bin.extend_from_slice(self.pair.public_key().as_ref());
        let text = format!("untrusted comment: minisign public key: {}\n{}\n", self.id(), B64.encode(bin));
        B64.encode(text)
    }

    pub fn trusted(&self) -> TrustedKey {
        TrustedKey { id: self.id().into(), public_b64: self.public_b64().into(), role: self.role }
    }

    /// Contents of the `.sig` file for `data` with the given trusted comment.
    pub fn sign(&self, data: &[u8], trusted_comment: &str) -> String {
        self.sign_with(b"ED", &Blake2b512::digest(data), trusted_comment)
    }

    /// A legacy (non-prehashed `Ed`) signature, which production must reject.
    pub fn sign_legacy(&self, data: &[u8], trusted_comment: &str) -> String {
        self.sign_with(b"Ed", data, trusted_comment)
    }

    fn sign_with(&self, alg: &[u8; 2], message: &[u8], trusted_comment: &str) -> String {
        let sig = self.pair.sign(message);
        let mut line = alg.to_vec();
        line.extend_from_slice(&self.id_bytes);
        line.extend_from_slice(sig.as_ref());
        let mut global_msg = sig.as_ref().to_vec();
        global_msg.extend_from_slice(trusted_comment.as_bytes());
        let global = self.pair.sign(&global_msg);
        let text = format!(
            "untrusted comment: signature from tauri secret key\n{}\ntrusted comment: {}\n{}\n",
            B64.encode(line),
            trusted_comment,
            B64.encode(global.as_ref())
        );
        B64.encode(text)
    }

    /// The comment `tauri signer sign --app-version <v>` writes.
    pub fn comment(file: &str, version: &str) -> String {
        format!("timestamp:1790000000\tfile:{file}\tversion:{version}")
    }
}

/// One key per role plus a spare Artifact key, the layout of the real set (4.7).
pub struct TestKeys {
    pub feed: TestKey,
    pub standby: TestKey,
    pub artifact: TestKey,
    pub spare: TestKey,
}

impl TestKeys {
    pub fn generate() -> TestKeys {
        TestKeys {
            feed: TestKey::generate(Role::Feed),
            standby: TestKey::generate(Role::FeedStandby),
            artifact: TestKey::generate(Role::Artifact),
            spare: TestKey::generate(Role::Artifact),
        }
    }

    pub fn key_set(&self) -> KeySet {
        KeySet::new(vec![self.feed.trusted(), self.standby.trusted(), self.artifact.trusted(), self.spare.trusted()])
    }

    pub fn none_revoked() -> Revocations {
        Revocations::new()
    }
}
