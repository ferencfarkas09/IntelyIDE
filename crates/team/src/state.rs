//! Everything one member keeps for its team: the trusted roster, the key epochs, the replay guard and the send counter.
//! Keys live in the secret store, the rest in `team.json` (no secrets in it). Revoking starts a new epoch.

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use intely_remote::util::{b64u, b64u_decode, random};
use intely_settings::{Secret, SecretStore};
use serde::{Deserialize, Serialize};

use crate::envelope::{self, Envelope, ReplayGuard};
use crate::error::{Result, TeamError};
use crate::identity::{Identity, KEY_KEYS};
use crate::keyring::Keyring;
use crate::rekey;
use crate::roster::{Role, RosterBody, RosterMember, SignedRoster, MAX_MEMBERS};
use crate::wire::{frame, tag, unframe};

/// Sequence numbers are reserved in blocks, so a crash never reuses one and a send does not write a file.
const SEQ_BLOCK: u64 = 1000;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    team_id: String,
    relay: String,
    me: String,
    roster: SignedRoster,
    replay: ReplayGuard,
    seq_reserved: u64,
    #[serde(default)]
    outbox: Vec<OutboxItem>,
    #[serde(default)]
    pending_revokes: Vec<String>,
}

/// A key hand-over that was decided (and saved) but is not yet known to be at the relay. Sent again on every reconnect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxItem {
    pub to: String,
    pub epoch: u32,
    /// The relay payload (`wire::frame` of a `Noise_X` message).
    pub payload: String,
}

#[derive(Clone)]
pub struct TeamState {
    pub team_id: String,
    /// `wss://host` (no path) of the relay this team lives on.
    pub relay: String,
    pub me: String,
    roster: SignedRoster,
    body: RosterBody,
    keys: Keyring,
    replay: ReplayGuard,
    seq: u64,
    seq_reserved: u64,
    dirty: bool,
    outbox: Vec<OutboxItem>,
    pending_revokes: Vec<String>,
}

impl std::fmt::Debug for TeamState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TeamState").field("team_id", &self.team_id).field("me", &self.me).field("roster_version", &self.body.version).field("keys", &self.keys).finish()
    }
}

/// What an admin must deliver after a revoke.
#[derive(Debug)]
pub struct Revocation {
    pub roster: SignedRoster,
    pub epoch: u32,
    /// `(member id, relay payload)` for every remaining member except the admin.
    pub deliveries: Vec<(String, String)>,
}

#[derive(Serialize, Deserialize)]
struct RekeyPayload {
    epoch: u32,
    /// Every epoch key (hex), so a member that missed an earlier rekey catches up with this one.
    keys: BTreeMap<u32, String>,
    roster: SignedRoster,
}

pub fn member_entry(id: &Identity, name: &str, role: Role) -> RosterMember {
    RosterMember { id: id.member_id.clone(), name: name.chars().take(60).collect(), role, sign_pub: b64u(&id.sign_public()), noise_pub: b64u(&id.noise.public) }
}

impl TeamState {
    pub fn create(me: &Identity, relay: &str, name: &str, now: u64) -> Result<Self> {
        let team_id = b64u(&random::<16>());
        let body = RosterBody { team_id: team_id.clone(), version: 1, epoch: 1, ts: now, members: vec![member_entry(me, name, Role::Admin)] };
        let roster = SignedRoster::sign(&body, me)?;
        Ok(Self::assemble(team_id, relay.to_string(), me.member_id.clone(), roster, body, Keyring::genesis(), ReplayGuard::default(), 0))
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn assemble(team_id: String, relay: String, me: String, roster: SignedRoster, body: RosterBody, keys: Keyring, replay: ReplayGuard, seq_reserved: u64) -> Self {
        Self { team_id, relay, me, roster, body, keys, replay, seq: seq_reserved, seq_reserved, dirty: true, outbox: Vec::new(), pending_revokes: Vec::new() }
    }

    pub fn roster(&self) -> &SignedRoster {
        &self.roster
    }

    pub fn body(&self) -> &RosterBody {
        &self.body
    }

    pub fn epoch(&self) -> u32 {
        self.keys.current()
    }

    pub fn keys(&self) -> &Keyring {
        &self.keys
    }

    pub fn role(&self) -> Option<Role> {
        self.body.member(&self.me).map(|m| m.role)
    }

    pub fn is_admin(&self) -> bool {
        self.role() == Some(Role::Admin)
    }

    /// Key hand-overs not yet confirmed by the relay.
    pub fn outbox(&self) -> &[OutboxItem] {
        &self.outbox
    }

    pub fn outbox_done(&mut self, to: &str) {
        self.outbox.retain(|o| o.to != to);
        self.dirty = true;
    }

    /// Members the relay has not yet confirmed as revoked (their token and socket are still alive there).
    pub fn pending_revokes(&self) -> &[String] {
        &self.pending_revokes
    }

    pub fn revoke_done(&mut self, id: &str) {
        self.pending_revokes.retain(|r| r != id);
        self.dirty = true;
    }

    /// The roster as stored at the relay: encrypted under the current epoch key.
    pub fn seal_roster(&self) -> Result<String> {
        self.roster.seal_payload(&self.team_id, &self.keys)
    }

    pub fn open_roster(&self, payload: &str) -> Result<SignedRoster> {
        SignedRoster::open_payload(payload, &self.team_id, &self.keys)
    }

    /// True once since the last call if the state changed and wants saving.
    pub fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    // ---------- traffic ----------
    pub fn seal(&mut self, me: &Identity, plaintext: &[u8]) -> Result<Envelope> {
        if self.seq >= self.seq_reserved {
            self.seq_reserved += SEQ_BLOCK;
            self.dirty = true;
        }
        self.seq += 1;
        envelope::seal(&self.team_id, &self.keys, me, self.seq, plaintext)
    }

    pub fn open(&mut self, e: &Envelope) -> Result<Vec<u8>> {
        let before = self.replay.clone();
        let out = envelope::open(&self.team_id, &self.keys, &self.body, &mut self.replay, e)?;
        self.dirty |= before != self.replay;
        Ok(out)
    }

    // ---------- membership ----------
    /// Admin: adds a confirmed joiner and signs the next roster. The key epoch stays; the joiner gets every key in the welcome.
    pub fn add_member(&mut self, me: &Identity, member: RosterMember, now: u64) -> Result<SignedRoster> {
        if !self.is_admin() {
            return Err(TeamError::NotAdmin);
        }
        if self.body.members.len() >= MAX_MEMBERS {
            return Err(TeamError::Full);
        }
        if self.body.member(&member.id).is_some() {
            return Err(TeamError::Invalid("that member id is already in the team".into()));
        }
        let mut body = self.body.clone();
        body.version += 1;
        body.ts = now;
        body.members.push(member);
        let signed = SignedRoster::sign(&body, me)?;
        self.adopt(signed.clone(), body);
        Ok(signed)
    }

    /// Admin: removes a member, starts a new epoch and prepares the pairwise key hand-over to everyone who stays.
    pub fn revoke(&mut self, me: &Identity, target: &str, now: u64) -> Result<Revocation> {
        if !self.is_admin() {
            return Err(TeamError::NotAdmin);
        }
        let victim = self.body.member(target).ok_or(TeamError::UnknownSender)?;
        if victim.role == Role::Admin {
            return Err(TeamError::Invalid("an admin leaves the team by itself; nobody removes one".into()));
        }
        let mut keys = self.keys.clone();
        let (epoch, _) = keys.rotate();
        let mut body = self.body.clone();
        body.version += 1;
        body.epoch = epoch;
        body.ts = now;
        body.members.retain(|m| m.id != target);
        let signed = SignedRoster::sign(&body, me)?;
        let payload = serde_json::to_vec(&RekeyPayload { epoch, keys: keys.all().into_iter().map(|(e, k)| (e, hex::encode(k))).collect(), roster: signed.clone() })?;
        let mut deliveries = Vec::new();
        for m in body.members.iter().filter(|m| m.id != self.me) {
            let public = m.noise_key().ok_or_else(|| TeamError::Invalid("a member has no valid Noise key".into()))?;
            deliveries.push((m.id.clone(), frame(tag::REKEY, &rekey::seal(&me.noise, &public, &payload)?)));
        }
        // The intent is part of the state, so the caller saves it before anything is sent; the newest hand-over replaces older ones.
        self.outbox.retain(|o| o.to != target && !deliveries.iter().any(|(to, _)| *to == o.to));
        self.outbox.extend(deliveries.iter().map(|(to, payload)| OutboxItem { to: to.clone(), epoch, payload: payload.clone() }));
        if !self.pending_revokes.iter().any(|r| r == target) {
            self.pending_revokes.push(target.to_string());
        }
        self.keys = keys;
        self.replay.forget(target);
        self.adopt(signed.clone(), body);
        Ok(Revocation { roster: signed, epoch, deliveries })
    }

    /// Member: a new epoch key and roster from an admin (Noise_X). Refused unless the sender is an admin of the roster we trust and
    /// the new roster is a valid successor of it.
    pub fn apply_rekey(&mut self, me: &Identity, relay_payload: &str) -> Result<u32> {
        let (t, msg) = unframe(relay_payload)?;
        if t != tag::REKEY {
            return Err(TeamError::Invalid("not a rekey".into()));
        }
        let (sender, plain) = rekey::open(&me.noise, &msg)?;
        let admin = self.body.members.iter().find(|m| m.role == Role::Admin && m.noise_key() == Some(sender)).ok_or(TeamError::NotAdmin)?;
        let p: RekeyPayload = serde_json::from_slice(&plain)?;
        if p.roster.signer != admin.id {
            return Err(TeamError::Forged);
        }
        let keys = p.keys.iter().map(|(e, k)| Some((*e, hex::decode(k).ok()?.try_into().ok()?))).collect::<Option<Vec<(u32, [u8; 32])>>>().ok_or_else(|| TeamError::Invalid("bad key".into()))?;
        if !keys.iter().any(|(e, _)| *e == p.epoch) {
            return Err(TeamError::Invalid("the rekey has no key for its epoch".into()));
        }
        let announced = p.roster.parse()?;
        if announced.team_id == self.team_id && announced.version <= self.body.version && announced.epoch == p.epoch && announced.member(&self.me).is_some() {
            // Already known (a resend, or the roster arrived before the key): take the keys, nothing else changes. The sender is an
            // authenticated admin of the roster we trust (Noise_X above).
            for (e, k) in keys {
                self.keys.insert(e, k)?;
            }
            self.dirty = true;
            return Ok(p.epoch);
        }
        let body = p.roster.verify_next(&self.team_id, &self.body)?;
        if body.epoch != p.epoch || body.member(&self.me).is_none() {
            return Err(TeamError::Invalid("the rekey does not match its roster".into()));
        }
        for (e, k) in keys {
            self.keys.insert(e, k)?;
        }
        self.adopt(p.roster, body);
        Ok(p.epoch)
    }

    /// Member: a roster fetched from the relay (or pushed with `roster.changed`).
    pub fn apply_roster(&mut self, signed: SignedRoster) -> Result<bool> {
        if let Ok(b) = signed.parse() {
            if b.version <= self.body.version {
                return Ok(false);
            }
        }
        let body = signed.verify_next(&self.team_id, &self.body)?;
        self.adopt(signed, body);
        Ok(true)
    }

    fn adopt(&mut self, signed: SignedRoster, body: RosterBody) {
        self.roster = signed;
        self.body = body;
        self.dirty = true;
    }

    /// True while the roster asks for an epoch whose key we do not hold yet (the rekey is still on its way).
    pub fn waiting_for_key(&self) -> bool {
        self.keys.key(self.body.epoch).is_none()
    }

    // ---------- persistence ----------
    pub fn path_in(state_dir: &Path) -> PathBuf {
        state_dir.join("team.json")
    }

    pub fn save(&mut self, state_dir: &Path, secrets: &Arc<dyn SecretStore>) -> Result<()> {
        secrets.set(KEY_KEYS, Secret::new(self.keys.to_secret()))?;
        let p = Persisted { team_id: self.team_id.clone(), relay: self.relay.clone(), me: self.me.clone(), roster: self.roster.clone(), replay: self.replay.clone(), seq_reserved: self.seq_reserved, outbox: self.outbox.clone(), pending_revokes: self.pending_revokes.clone() };
        fs::create_dir_all(state_dir)?;
        let tmp = state_dir.join("team.json.tmp");
        let mut options = OpenOptions::new();
        options.create(true).write(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options.open(&tmp)?.write_all(&serde_json::to_vec_pretty(&p)?)?;
        fs::rename(tmp, Self::path_in(state_dir))?;
        self.dirty = false;
        Ok(())
    }

    /// `None` when this install is not in a team. A roster that no longer verifies, or a missing key, is an error.
    pub fn load(state_dir: &Path, secrets: &Arc<dyn SecretStore>) -> Result<Option<Self>> {
        let text = match fs::read_to_string(Self::path_in(state_dir)) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let p: Persisted = serde_json::from_str(&text)?;
        let keys = secrets.get(KEY_KEYS)?.and_then(|s| Keyring::from_secret(s.expose())).ok_or_else(|| TeamError::Secret("the team keys are missing from the secret store".into()))?;
        let body = p.roster.parse()?;
        if body.team_id != p.team_id || b64u_decode(&p.roster.sig).is_none() {
            return Err(TeamError::Invalid("team.json does not match its roster".into()));
        }
        // seq resumes at the reserved block's end: numbers handed out before a crash are never reused
        let mut s = Self::assemble(p.team_id, p.relay, p.me, p.roster, body, keys, p.replay, p.seq_reserved);
        s.outbox = p.outbox;
        s.pending_revokes = p.pending_revokes;
        s.dirty = false;
        Ok(Some(s))
    }

    /// Leaving or being removed: forget the team on this machine (the identity is rotated by the caller).
    pub fn forget(state_dir: &Path, secrets: &Arc<dyn SecretStore>) -> Result<()> {
        secrets.remove(KEY_KEYS)?;
        match fs::remove_file(Self::path_in(state_dir)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
}
