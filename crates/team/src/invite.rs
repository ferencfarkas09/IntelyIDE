//! Joining a team. The admin opens a one-time offer (a 128-bit code, valid 10 minutes, single use). The code is the PSK of
//! `Noise_IKpsk2` between joiner and admin and, derived a second time, the relay's single-use invite token. Both screens show the
//! 6-digit SAS of the handshake; only after the admin confirms does the admin send the welcome (team keys + signed roster)
//! through the finished Noise channel. The relay carries ciphertext only and cannot enroll anybody on its own: its "pending"
//! member can talk to admins and nothing else until an admin confirms.

use std::collections::BTreeMap;

use intely_remote::noise::{new_otp, pair_token_from_otp, psk_from_otp, Handshake, Kind, Transport};
use intely_remote::util::{b64u, b64u_decode, sha256_hex};
use serde::{Deserialize, Serialize};

use crate::envelope::ReplayGuard;
use crate::error::{Result, TeamError};
use crate::identity::Identity;
use crate::keyring::Keyring;
use crate::roster::{Role, RosterMember, SignedRoster};
use crate::state::{member_entry, TeamState};

pub const OFFER_TTL_MS: u64 = 10 * 60_000;
pub const MAX_FAILED_ATTEMPTS: u32 = 3;
/// After the handshake the joiner must prove the code with its hello within this time (as in `intely_remote::pairing`).
pub const HELLO_TIMEOUT_MS: u64 = 15_000;
const HELLO: &[u8] = b"intely-team/hello/v1";
const SCHEME: &str = "intely-team://join#";
/// What the scheme looks like in a pasted line once case, the slashes and the `join` word are left out.
const SCHEME_NAME: &str = "intely-team:";
/// The one-time code is 16 bytes: 22 characters of base64url without padding.
const OTP_CHARS: usize = 22;

/// What carries no meaning in a pasted line: every kind of white space (a chat, a mail client or a terminal wraps a long line) and the
/// invisible characters some editors and chats add (zero-width space and joiner, directional marks, word joiner, byte order mark, soft hyphen).
fn invisible(c: char) -> bool {
    c.is_whitespace() || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}' | '\u{feff}' | '\u{00ad}')
}

/// `%XX` escapes undone (and nothing else): a chat or a mail client may encode the commas and colons of a link. A sequence that is not two
/// hexadecimal digits stays as it is.
fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() {
            out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap_or(b'%'));
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The code inside whatever was pasted: the text after the scheme (any case, the two slashes, a slash before the `#` and the `join` word as
/// people retype them), or a bare code that is the whole text and starts with the relay address. `None` when the text holds neither.
fn fragment(text: &str) -> Option<String> {
    let clean: String = text.chars().filter(|c| !invisible(*c)).collect();
    let clean = if clean.contains('%') { unescape(&clean) } else { clean };
    let lower = clean.to_ascii_lowercase(); // ASCII only: every byte offset is the same in both
    if let Some(at) = lower.find(SCHEME_NAME) {
        let rest = clean[at + SCHEME_NAME.len()..].trim_start_matches('/');
        let rest = rest.get(..4).filter(|w| w.eq_ignore_ascii_case("join")).map(|_| &rest[4..])?;
        return rest.trim_start_matches('/').strip_prefix('#').map(str::to_string);
    }
    // a bare code is the part after the `#`: it starts with the relay address, maybe inside quotes or brackets, and nothing comes before it
    let bare = clean.trim_start_matches(['<', '"', '\'', '`', '(', '[', '{']);
    let head = bare.get(..6).unwrap_or(bare).to_ascii_lowercase();
    (head.starts_with("wss://") || head.starts_with("ws://")).then(|| bare.to_string())
}

fn id_chars(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The relay's team id format: 128 random bits as base64url (22 characters), up to 64.
pub fn valid_team_id(s: &str) -> bool {
    (22..=64).contains(&s.len()) && id_chars(s)
}

/// A member id as the relay accepts it (`pair-` is reserved for its own temporary ids).
pub fn valid_member_id(s: &str) -> bool {
    (1..=64).contains(&s.len()) && id_chars(s) && !s.starts_with("pair-")
}

/// What the code (and the QR) carries: `intely-team://join#<relay>,<team>,<adminId>,<adminNoisePub>,<otp>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteCode {
    pub relay: String,
    pub team_id: String,
    pub admin_id: String,
    pub admin_noise_pub: [u8; 32],
    pub otp: [u8; 16],
}

impl InviteCode {
    pub fn to_link(&self) -> String {
        format!("{SCHEME}{},{},{},{},{}", self.relay, self.team_id, self.admin_id, b64u(&self.admin_noise_pub), b64u(&self.otp))
    }

    /// Reads a code as people really hand it over: the link `to_link` makes, but also with its line wrapped or surrounded by other words
    /// ("Join us: intely-team://join#..."), in any case of the scheme, with `%2C`-style escapes, in quotes or angle brackets, or as the bare
    /// `wss://relay,...` part. Nothing is guessed: every field still has to be exactly what the relay and the handshake need.
    pub fn parse(text: &str) -> Result<Self> {
        let bad = || TeamError::Invalid("invalidCode: that is not a team invite code".into());
        let frag = fragment(text).ok_or_else(bad)?;
        let parts: Vec<&str> = frag.splitn(5, ',').collect();
        let [relay, team_id, admin_id, noise, rest] = parts[..] else { return Err(bad()) };
        // the last field has a fixed length: whatever follows it (a full stop, a closing bracket, more words) is not part of the code
        let otp: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')).take(OTP_CHARS).collect();
        if relay.is_empty() || !valid_team_id(team_id) || !valid_member_id(admin_id) {
            return Err(bad());
        }
        Ok(Self {
            relay: relay.to_string(),
            team_id: team_id.to_string(),
            admin_id: admin_id.to_string(),
            admin_noise_pub: b64u_decode(noise).and_then(|b| b.try_into().ok()).ok_or_else(bad)?,
            otp: b64u_decode(&otp).and_then(|b| b.try_into().ok()).ok_or_else(bad)?,
        })
    }

    /// The relay's `Authorization: Bearer` for `POST /join` and its hash for `invite.open`.
    pub fn relay_token(&self) -> String {
        pair_token_from_otp(&self.otp)
    }
}

/// Sent inside the (encrypted) first handshake message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinerInfo {
    pub id: String,
    pub name: String,
    pub sign_pub: String,
}

// ---------- admin ----------

pub struct Offer {
    otp: [u8; 16],
    pub expires_at: u64,
    failed: u32,
    spent: bool,
    /// When the handshake in progress started; one at a time.
    in_flight: Option<u64>,
    /// The relay id of the one member that redeemed this invite (the relay reports it as `member.pending`). Only it may run the
    /// handshake, so other members cannot burn the invite with garbage.
    redeemer: Option<String>,
}

impl Offer {
    pub fn new(now: u64) -> Self {
        Self { otp: new_otp(), expires_at: now + OFFER_TTL_MS, failed: 0, spent: false, in_flight: None, redeemer: None }
    }

    pub fn code(&self, state: &TeamState, admin: &Identity) -> InviteCode {
        InviteCode { relay: state.relay.clone(), team_id: state.team_id.clone(), admin_id: admin.member_id.clone(), admin_noise_pub: admin.noise.public, otp: self.otp }
    }

    /// The hash the admin registers with the relay (`invite.open`).
    pub fn relay_token_hash(&self) -> String {
        sha256_hex(pair_token_from_otp(&self.otp).as_bytes())
    }

    pub fn is_open(&self, now: u64) -> bool {
        !self.spent && now <= self.expires_at
    }

    /// Remembers who redeemed the invite (the first call wins).
    pub fn set_redeemer(&mut self, id: &str) {
        if self.redeemer.is_none() && valid_member_id(id) {
            self.redeemer = Some(id.to_string());
        }
    }

    pub fn is_redeemer(&self, id: &str) -> bool {
        self.redeemer.as_deref() == Some(id)
    }

    /// A handshake that never sent its hello in time counts as a failed attempt and frees the offer for the next try.
    pub fn drop_stale(&mut self, pending: &Pending, now: u64) -> bool {
        let stale = pending.is_stale(now);
        if stale {
            self.strike();
        }
        stale
    }

    fn strike(&mut self) {
        self.in_flight = None;
        self.failed += 1;
        if self.failed >= MAX_FAILED_ATTEMPTS {
            self.spent = true;
        }
    }

    /// Runs the responder side on the joiner's first message. In `IKpsk2` the code enters at message 2, so reading message 1
    /// proves nothing about the joiner: the offer stays open until [`Offer::hello`] shows that the joiner holds the code.
    ///
    /// `from` is the sender id the relay put on the frame. It must be the member that redeemed the invite (anyone else is ignored
    /// without a strike), and the id inside the join request must be the same one.
    pub fn accept(&mut self, admin: &Identity, from: &str, msg1: &[u8], now: u64) -> Result<Pending> {
        if !self.is_open(now) || self.in_flight.is_some_and(|t| now < t + HELLO_TIMEOUT_MS) {
            return Err(TeamError::InviteSpent);
        }
        if self.redeemer.as_deref() != Some(from) {
            return Err(TeamError::Invalid("not the member that redeemed this invite".into()));
        }
        let psk = psk_from_otp(&self.otp);
        let attempt = (|| -> Result<Pending> {
            let mut hs = Handshake::responder(Kind::Pairing, &admin.noise, Some(&psk))?;
            let payload = hs.read(msg1)?;
            let info: JoinerInfo = serde_json::from_slice(&payload)?;
            let sign_ok = b64u_decode(&info.sign_pub).is_some_and(|k| k.len() == 32);
            if !valid_member_id(&info.id) || info.id != from || !sign_ok {
                return Err(TeamError::Invalid("bad join request".into()));
            }
            let noise_pub = hs.remote_static().ok_or_else(|| TeamError::Crypto("no joiner key".into()))?;
            let msg2 = hs.write(&[])?;
            let sas = hs.sas();
            Ok(Pending { msg2, sas, joiner: info, noise_pub, transport: hs.into_transport()?, verified: false, relay_from: from.to_string(), started: now })
        })();
        match attempt {
            Ok(p) => {
                self.in_flight = Some(now);
                Ok(p)
            }
            Err(e) => {
                self.strike();
                Err(e)
            }
        }
    }

    /// The joiner's first transport message. Only a joiner that knows the code produces one that decrypts: success burns the
    /// offer (single use), anything else is a strike and three strikes burn it too.
    pub fn hello(&mut self, pending: &mut Pending, from: &str, ct: &[u8], now: u64) -> Result<()> {
        if !self.is_open(now) || self.in_flight.is_none() {
            return Err(TeamError::InviteSpent);
        }
        if from != pending.relay_from {
            return Err(TeamError::Invalid("the hello came from another member".into())); // not the joiner's strike
        }
        match pending.transport.decrypt(ct) {
            Ok(p) if p == HELLO => {
                pending.verified = true;
                self.spent = true;
                self.in_flight = None;
                Ok(())
            }
            _ => {
                self.strike();
                Err(TeamError::Crypto("the joiner did not prove the code".into()))
            }
        }
    }
}

pub struct Pending {
    pub msg2: Vec<u8>,
    pub sas: String,
    pub joiner: JoinerInfo,
    pub noise_pub: [u8; 32],
    transport: Transport,
    verified: bool,
    /// The sender id the relay put on the first frame.
    relay_from: String,
    started: u64,
}

#[derive(Serialize, Deserialize)]
struct Welcome {
    team_id: String,
    relay: String,
    current: u32,
    keys: BTreeMap<u32, String>,
    roster: SignedRoster,
}

impl Pending {
    /// No hello within [`HELLO_TIMEOUT_MS`]: the joiner is not going to prove the code.
    pub fn is_stale(&self, now: u64) -> bool {
        !self.verified && now >= self.started + HELLO_TIMEOUT_MS
    }

    /// The admin confirmed the SAS: add the joiner to the roster and produce the welcome (inside the Noise channel) plus the
    /// new signed roster to publish on the relay.
    pub fn approve(mut self, state: &mut TeamState, admin: &Identity, now: u64) -> Result<(Vec<u8>, SignedRoster, String)> {
        if !self.verified {
            return Err(TeamError::Crypto("the joiner has not proven the code yet".into()));
        }
        if self.joiner.id != self.relay_from {
            return Err(TeamError::Invalid("the relay sender is not the member that asked to join".into()));
        }
        let member = RosterMember {
            id: self.joiner.id.clone(),
            name: self.joiner.name.chars().take(60).collect(),
            role: Role::Member,
            sign_pub: self.joiner.sign_pub.clone(),
            noise_pub: b64u(&self.noise_pub),
        };
        let roster = state.add_member(admin, member, now)?;
        let w = Welcome {
            team_id: state.team_id.clone(),
            relay: state.relay.clone(),
            current: state.keys().current(),
            keys: state.keys().all().into_iter().map(|(e, k)| (e, hex::encode(k))).collect(),
            roster: roster.clone(),
        };
        let welcome = self.transport.encrypt(&serde_json::to_vec(&w)?)?;
        Ok((welcome, roster, self.joiner.id))
    }
}

// ---------- joiner ----------

pub struct Joiner {
    hs: Handshake,
    code: InviteCode,
}

pub struct Joined {
    pub sas: String,
    transport: Transport,
    code: InviteCode,
}

impl Joiner {
    pub fn start(code: &InviteCode, me: &Identity, name: &str) -> Result<(Self, Vec<u8>)> {
        let psk = psk_from_otp(&code.otp);
        let mut hs = Handshake::initiator(Kind::Pairing, &me.noise, &code.admin_noise_pub, Some(&psk))?;
        let info = JoinerInfo { id: me.member_id.clone(), name: name.chars().take(60).collect(), sign_pub: b64u(&me.sign_public()) };
        let msg1 = hs.write(&serde_json::to_vec(&info)?)?;
        Ok((Self { hs, code: code.clone() }, msg1))
    }

    pub fn on_msg2(mut self, msg2: &[u8]) -> Result<Joined> {
        self.hs.read(msg2)?;
        if !self.hs.is_finished() {
            return Err(TeamError::Crypto("the handshake did not finish".into()));
        }
        let sas = self.hs.sas();
        Ok(Joined { sas, transport: self.hs.into_transport()?, code: self.code })
    }
}

impl Joined {
    /// Sent right after the handshake: proves to the admin that this joiner holds the code.
    pub fn hello(&mut self) -> Result<Vec<u8>> {
        Ok(self.transport.encrypt(HELLO)?)
    }

    /// The joiner confirmed the SAS and the welcome arrived. Everything in it is checked against what the invite pinned: the
    /// roster must be signed by the admin whose Noise key opened this channel, and must list this member with its own keys.
    pub fn finish(mut self, welcome: &[u8], me: &Identity) -> Result<TeamState> {
        let plain = self.transport.decrypt(welcome)?;
        let w: Welcome = serde_json::from_slice(&plain)?;
        if w.team_id != self.code.team_id || w.relay != self.code.relay {
            return Err(TeamError::Invalid("the welcome is for another team".into()));
        }
        let body = w.roster.verify_first(&w.team_id, &self.code.admin_id, &self.code.admin_noise_pub)?;
        let mine = body.member(&me.member_id).ok_or_else(|| TeamError::Invalid("the roster does not list this member".into()))?;
        if mine.sign_key().as_deref() != Some(&me.sign_public()[..]) || mine.noise_key() != Some(me.noise.public) {
            return Err(TeamError::Invalid("the roster lists other keys for this member".into()));
        }
        let keys = w.keys.iter().map(|(e, k)| Some((*e, hex::decode(k).ok()?.try_into().ok()?))).collect::<Option<Vec<(u32, [u8; 32])>>>().ok_or_else(|| TeamError::Invalid("bad keys".into()))?;
        let ring = Keyring::from_parts(w.current, keys)?;
        if ring.current() != body.epoch {
            return Err(TeamError::Invalid("the welcome epoch does not match its roster".into()));
        }
        Ok(TeamState::assemble(w.team_id, w.relay, me.member_id.clone(), w.roster, body, ring, ReplayGuard::default(), 0))
    }
}

/// Convenience for the glue: the roster entry of an identity.
pub fn entry_of(id: &Identity, name: &str, role: Role) -> RosterMember {
    member_entry(id, name, role)
}
