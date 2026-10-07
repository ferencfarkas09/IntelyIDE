//! The JSON messages inside the Noise channel (remote-plan 2.6). Versioned by `v`; every client command carries an idempotent
//! `opId` and gets an `ack`. Decoding is fail-closed: anything that is not exactly a known message of the current version is an
//! error the gateway counts, never a guess.

use std::collections::BTreeMap;

use intely_agent_core::api::{PermissionDecision, QuestionAnswer, RunStatus};
use intely_agent_core::events::{AgentEvent, PermissionOutcome, DecidedBy};
use intely_agent_core::hub::{Eligibility, Origin, PendingKind, PromptMode, Risk};
use intely_agent_core::providers::PermissionMode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
/// One Noise message carries at most 65535 bytes; we stay well below it so the relay's 64 KB frame cap never bites.
pub const MAX_PLAINTEXT: usize = 48 * 1024;
/// A client message is small; anything bigger is garbage or abuse.
pub const MAX_CLIENT_MSG: usize = 16 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum WireError {
    #[error("message is not valid JSON")]
    NotJson,
    #[error("message is not an object with a supported version")]
    BadEnvelope,
    #[error("unknown or malformed message: {0}")]
    Malformed(String),
    #[error("message too large")]
    TooLarge,
}

macro_rules! wire {
    ($($item:item)*) => {
        $(
            #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
            #[cfg_attr(feature = "specta", derive(specta::Type))]
            $item
        )*
    };
}

wire! {
    /// A WebAuthn assertion, all fields base64url. Bound to the challenge the Mac issued for one request.
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct StepUpProof {
        pub credential_id: String,
        pub authenticator_data: String,
        pub client_data_json: String,
        pub signature: String,
    }

    #[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
    pub enum ClientMsg {
        /// Resume: the last seq the phone holds per run (absent run = send the recent tail).
        Sync {
            #[cfg_attr(feature = "specta", specta(type = BTreeMap<String, specta_typescript::Number>))]
            last_seq: BTreeMap<String, u64>,
        },
        Answer {
            op_id: String,
            req_id: String,
            agent_id: String,
            #[serde(default)]
            decision: Option<PermissionDecision>,
            #[serde(default)]
            question: Option<QuestionAnswer>,
            #[serde(default)]
            intent_hash: Option<String>,
            #[serde(default)]
            step_up: Option<StepUpProof>,
        },
        /// A follow-up to a run. `step_up` is required for a run in Automatic mode (a passkey assertion for the challenge of
        /// `prompt_step_up_key`: bound to the run and the exact text); a Bypass run is steered on the Mac.
        Prompt {
            op_id: String,
            agent_id: String,
            text: String,
            mode: PromptMode,
            #[serde(default)]
            step_up: Option<StepUpProof>,
        },
        Stop { op_id: String, agent_id: String },
        StopAll { op_id: String },
        Start {
            op_id: String,
            template_id: String,
            #[serde(default)]
            #[cfg_attr(feature = "specta", specta(type = specta_typescript::Unknown))]
            params: Value,
            #[serde(default)]
            step_up: Option<StepUpProof>,
        },
        DiffGet { op_id: String, agent_id: String, tool_id: String },
        StepUpBegin { op_id: String, req_id: String },
        /// Restarts the re-auth window: without `step_up` the Mac answers with a challenge, with it the assertion is verified.
        Reauth {
            op_id: String,
            #[serde(default)]
            step_up: Option<StepUpProof>,
        },
        SignOut { op_id: String },
        Ping,
    }

    /// One run row of the Home screen.
    #[serde(rename_all = "camelCase")]
    pub struct RunCard {
        pub agent_id: String,
        pub title: String,
        pub role: String,
        pub provider: String,
        pub model: String,
        pub status: RunStatus,
        pub last_text: String,
        pub waiting_on: Vec<String>,
        #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
        pub last_seq: u64,
        #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
        pub started_at: u64,
        /// The mode the run is steered under: the looser of its live effective mode and the recorded one. The phone shows it as a chip, so the
        /// person who steers or approves sees what the step-up unlocks (permission-modes spec 5.7).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub mode: Option<PermissionMode>,
    }

    /// A permission or question card, built from structured intent fields only (never model prose).
    #[serde(rename_all = "camelCase")]
    pub struct ReqCard {
        pub req_id: String,
        pub agent_id: String,
        pub kind: PendingKind,
        pub tool_id: Option<String>,
        pub tool: Option<String>,
        /// Parsed command as the broker judged it, scrubbed and escaped; absent for non-shell tools.
        pub command: Option<String>,
        pub argv: Option<Vec<String>>,
        pub paths: Vec<String>,
        pub url: Option<String>,
        pub summary: String,
        pub question: Option<String>,
        pub options: Vec<String>,
        pub intent_hash: String,
        pub risk: Risk,
        /// What THIS device may do with it right now (capability, fatigue and re-auth window included).
        pub eligibility: Eligibility,
        /// Why `eligibility` is not `low`, in words.
        pub reason: Option<String>,
        #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
        pub expires_at: u64,
        /// ExitPlanMode: the first 2 KiB of the plan being approved (already redacted). Approving from the phone continues the run in Ask.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub plan_excerpt: Option<String>,
        /// The plan was longer than the excerpt.
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub plan_truncated: Option<bool>,
    }

    #[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
    pub enum ServerMsg {
        Hello {
            capability: Capability,
            device_id: String,
            mac_name: String,
            /// The device is `view` until it re-authenticates with its passkey on the phone (window expired).
            reauth_required: bool,
        },
        Snapshot {
            runs: Vec<RunCard>,
            needs_you: Vec<ReqCard>,
            #[cfg_attr(feature = "specta", specta(type = BTreeMap<String, specta_typescript::Number>))]
            seq_by_run: BTreeMap<String, u64>,
        },
        Event { agent_id: String, #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))] seq: u64, ev: AgentEvent },
        /// The log rotated past the phone's seq, or the live feed lagged: start this run over from here.
        RunSnapshot {
            run: RunCard,
            #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
            last_seq: u64,
            events: Vec<AgentEvent>,
        },
        ReqNew { req: ReqCard },
        ReqResolved { req_id: String, agent_id: String, outcome: PermissionOutcome, by: DecidedBy, origin: Origin },
        CapabilityChanged { capability: Capability, reauth_required: bool },
        Ack {
            op_id: String,
            ok: bool,
            #[serde(default)]
            code: Option<String>,
            #[serde(default)]
            message: Option<String>,
        },
        StepUpChallenge {
            op_id: String,
            req_id: String,
            /// base64url of the 32 challenge bytes the authenticator must sign (WebAuthn `challenge`).
            challenge: String,
            rp_id: String,
            #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
            expires_at: u64,
        },
        Diff {
            op_id: String,
            agent_id: String,
            tool_id: String,
            path: String,
            old: Option<String>,
            new: String,
            truncated: bool,
        },
        Pong,
        /// The Mac's build-signing public key (raw Ed25519, base64url) for the phone to pin; sent inside the Noise channel
        /// (never through the relay's own plain layer) when a session opens and on "send my build key to paired phones".
        Welcome { bundle_pub: String },
        /// The device was removed (or Remote was locked): the phone clears keys, queue and cache.
        Revoked,
        Bye { reason: String },
    }

    /// Sent by the phone inside the pairing channel.
    #[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
    pub enum PairMsg {
        Hello { name: String },
        /// Self-attested passkey public key (SPKI or SEC1 P-256), accepted only while pairing is open on the Mac.
        PasskeyRegister { credential_id: String, public_key: String },
    }

    #[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
    pub enum PairReply {
        Accepted { device_id: String, device_token: String, capability: Capability, mac_name: String },
        Rejected { reason: String },
        /// Sent before `Accepted` in the pairing channel (QR and manual-code pairing alike): the key the phone pins.
        /// Older phones ignore it (unknown tag).
        Welcome { bundle_pub: String },
    }
}



/// What a device may do. There is deliberately no admin level: pairing, promotion, revocation, settings and the kill switch
/// are desktop-only gestures. `control` found in an old file loads as `view`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    View,
    Reply,
}

/// Serializes a server message with its version.
pub fn encode_server(msg: &ServerMsg) -> Vec<u8> {
    encode(&serde_json::to_value(msg).expect("server messages serialize"))
}

pub fn encode_pair_reply(msg: &PairReply) -> Vec<u8> {
    encode(&serde_json::to_value(msg).expect("pair replies serialize"))
}

fn encode(v: &Value) -> Vec<u8> {
    let mut v = v.clone();
    if let Some(o) = v.as_object_mut() {
        o.insert("v".into(), PROTOCOL_VERSION.into());
    }
    serde_json::to_vec(&v).expect("a JSON value serializes")
}

fn decode_value(bytes: &[u8]) -> Result<Value, WireError> {
    if bytes.len() > MAX_CLIENT_MSG {
        return Err(WireError::TooLarge);
    }
    let mut v: Value = serde_json::from_slice(bytes).map_err(|_| WireError::NotJson)?;
    let Some(o) = v.as_object_mut() else { return Err(WireError::BadEnvelope) };
    match o.remove("v").and_then(|x| x.as_u64()) {
        Some(n) if n == PROTOCOL_VERSION as u64 => Ok(v),
        _ => Err(WireError::BadEnvelope),
    }
}

pub fn decode_client(bytes: &[u8]) -> Result<ClientMsg, WireError> {
    serde_json::from_value(decode_value(bytes)?).map_err(|e| WireError::Malformed(e.to_string()))
}

pub fn decode_pair(bytes: &[u8]) -> Result<PairMsg, WireError> {
    serde_json::from_value(decode_value(bytes)?).map_err(|e| WireError::Malformed(e.to_string()))
}

pub fn ack_ok(op_id: &str) -> ServerMsg {
    ServerMsg::Ack { op_id: op_id.into(), ok: true, code: None, message: None }
}

pub fn ack_err(op_id: &str, code: &str, message: &str) -> ServerMsg {
    ServerMsg::Ack { op_id: op_id.into(), ok: false, code: Some(code.into()), message: Some(message.into()) }
}
