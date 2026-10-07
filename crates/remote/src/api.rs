//! Data for Settings > Remote and the status chip. Plain serializable views; secrets (keys, tokens) are never part of them.

use serde::{Deserialize, Serialize};

use crate::audit::AuditEntry;
use crate::pairing::OfferView;
use crate::wire::Capability;

macro_rules! view {
    ($($item:item)*) => {
        $(
            #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
            #[cfg_attr(feature = "specta", derive(specta::Type))]
            $item
        )*
    };
}

view! {
    #[serde(rename_all = "camelCase")]
    pub enum RemoteState {
        /// Not started: no thread, socket, timer or subscriber exists.
        Off,
        /// Running, relay not reachable (yet).
        Connecting,
        Online,
        /// `devices.json` or the audit log did not verify. Remote is stopped until the user resolves it on the Mac.
        Tampered,
    }

    #[serde(rename_all = "camelCase")]
    pub struct DeviceView {
        pub id: String,
        pub name: String,
        pub capability: Capability,
        /// `reply` device whose re-auth window ran out: effectively view-only until the passkey check.
        pub reauth_required: bool,
        pub has_passkey: bool,
        pub connected: bool,
        #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
        pub created_at: u64,
        #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
        pub last_seen_at: u64,
    }

    /// Where the shown bundle hash comes from.
    #[serde(rename_all = "camelCase")]
    pub enum BundleSource {
        /// Signed by this Mac's key and deployed by this IDE.
        SignedLocal,
        /// Checked against a public key the user entered or the phone pinned.
        SignedPinned,
        /// Seen on a custom relay, not independently verified.
        Observed,
        /// Legacy `expectedBundleHash` setting only.
        Settings,
        None,
    }

    /// The build the phone will be offered: short and full hash, key fingerprint, signing sequence number and time.
    #[serde(rename_all = "camelCase")]
    pub struct BundleView {
        /// First 16 hex digits in groups of four.
        pub hash_short: String,
        pub hash_full: String,
        /// First 8 bytes of sha256 of the raw public key, hex, grouped (`a1b2 c3d4 e5f6 0718`); empty when unsigned.
        pub pub_fingerprint: String,
        #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
        pub seq: u64,
        #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
        pub built_at: u64,
        pub source: BundleSource,
    }

    /// Mac-side frame counter (against the Free plan's daily cap) and the state of the relay link.
    #[serde(rename_all = "camelCase")]
    pub struct RelayStatsView {
        /// UTC date `YYYY-MM-DD` the counter belongs to.
        pub day: String,
        #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
        pub frames_sent: u64,
        pub consecutive_failures: u32,
        /// Short code of the last connect failure (`dns`, `blockedAddress`, `roomCreate:503`, ...), absent while connected.
        pub last_error: Option<String>,
    }

    #[serde(rename_all = "camelCase")]
    pub struct SasView {
        /// The 6 digits to compare with the phone.
        pub code: String,
        pub device_name: String,
    }

    #[serde(rename_all = "camelCase")]
    pub struct PairingView {
        pub offer: Option<OfferView>,
        pub sas: Option<SasView>,
    }

    /// Everything Settings > Remote shows.
    #[serde(rename_all = "camelCase")]
    pub struct RemoteSettingsView {
        pub state: RemoteState,
        pub tampered: Option<String>,
        pub relay: String,
        pub mac_name: String,
        pub devices: Vec<DeviceView>,
        pub pairing: PairingView,
        pub audit: Vec<AuditEntry>,
        #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
        pub audit_len: u64,
        pub reauth_hours: u32,
        /// The bundle hash the phone must show during pairing (from the Mac's own signed build); absent until a PWA build exists.
        pub expected_bundle_hash: Option<String>,
        /// `blocked`: every Claude run is launched with `disableRemoteControl: true`.
        pub claude_remote_control: String,
        pub e2e_note: String,
        /// `local` | `cloudflare` | `custom`.
        pub relay_mode: String,
        /// False when the relay host is not loopback and the user has not acknowledged it (or a jail forbids it).
        pub relay_host_allowed: bool,
        pub bundle: Option<BundleView>,
        pub relay_stats: RelayStatsView,
    }
}

impl BundleView {
    /// `hash_full` is the lowercase hex manifest hash; `pubkey` the raw Ed25519 key in base64url (empty = unsigned).
    pub fn new(hash_full: &str, pubkey: &str, seq: u64, built_at: u64, source: BundleSource) -> Self {
        let short: String = hash_full.chars().take(16).collect::<Vec<_>>().chunks(4).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join(" ");
        Self { hash_short: short, hash_full: hash_full.to_string(), pub_fingerprint: fingerprint(pubkey), seq, built_at, source }
    }
}

/// `a1b2 c3d4 e5f6 0718`: the first 8 bytes of sha256 of the raw key, hex, grouped. Empty for an unparsable key.
pub fn fingerprint(pub_b64u: &str) -> String {
    match crate::util::b64u_decode(pub_b64u) {
        Some(raw) if raw.len() == 32 => crate::util::sha256_hex(&raw)[..16].as_bytes().chunks(4).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join(" "),
        _ => String::new(),
    }
}

pub const E2E_NOTE: &str = "End-to-end encryption holds against an honest-code, passive relay only, until the native app: a compromised relay could serve hostile JavaScript. Compare the bundle hash when pairing.";

#[cfg(feature = "specta")]
pub fn type_collection() -> specta::Types {
    specta::Types::default()
        .register::<RemoteSettingsView>()
        .register::<DeviceView>()
        .register::<RemoteState>()
        .register::<PairingView>()
        .register::<BundleView>()
        .register::<BundleSource>()
        .register::<RelayStatsView>()
        .register::<OfferView>()
        .register::<AuditEntry>()
        .register::<crate::wire::ClientMsg>()
        .register::<crate::wire::ServerMsg>()
        .register::<crate::wire::Capability>()
}
