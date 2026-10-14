use std::sync::Arc;

use intely_settings::{MemorySecretStore, SecretStore};
use intely_team::audit::{event, TeamAudit};
use intely_team::client::ServerMsg;
use intely_team::envelope::{self, Envelope, ReplayGuard};
use intely_team::identity::Identity;
use intely_team::invite::{InviteCode, Joiner, Offer};
use intely_team::roster::{Role, SignedRoster};
use intely_team::state::TeamState;
use intely_team::TeamError;

const NOW: u64 = 1_000_000;

fn secrets() -> Arc<dyn SecretStore> {
    Arc::new(MemorySecretStore::new())
}

/// Runs the whole invite: handshake, both SAS, approve, welcome. Returns the new member and its state.
fn join(admin: &Identity, admin_state: &mut TeamState, name: &str) -> (Identity, TeamState) {
    let me = Identity::fresh();
    let mut offer = Offer::new(NOW);
    offer.set_redeemer(&me.member_id);
    let code = InviteCode::parse(&offer.code(admin_state, admin).to_link()).unwrap();
    let (joiner, msg1) = Joiner::start(&code, &me, name).unwrap();
    let pending = offer.accept(admin, &me.member_id, &msg1, NOW + 1).unwrap();
    let mut joined = joiner.on_msg2(&pending.msg2).unwrap();
    let mut pending = pending;
    offer.hello(&mut pending, &me.member_id, &joined.hello().unwrap(), NOW + 1).unwrap();
    assert_eq!(joined.sas, pending.sas, "both screens show the same code");
    assert_eq!(pending.sas.len(), 6);
    assert_eq!(pending.joiner.id, me.member_id);
    let (welcome, _roster, id) = pending.approve(admin_state, admin, NOW + 2).unwrap();
    assert_eq!(id, me.member_id);
    let state = joined.finish(&welcome, &me).unwrap();
    (me, state)
}

fn team() -> (Identity, TeamState) {
    let admin = Identity::fresh();
    let state = TeamState::create(&admin, "wss://relay.example", "Ada", NOW).unwrap();
    (admin, state)
}

#[test]
fn handshake_sas_and_welcome_bring_a_member_in() {
    let (admin, mut a) = team();
    let (bob, mut b) = join(&admin, &mut a, "Bob");
    assert_eq!(b.team_id, a.team_id);
    assert_eq!(b.body().members.len(), 2);
    assert_eq!(b.role(), Some(Role::Member));
    assert_eq!(b.epoch(), 1);
    // traffic flows both ways under the shared key
    let e = a.seal(&admin, b"hello bob").unwrap();
    assert_eq!(b.open(&e).unwrap(), b"hello bob");
    let e = b.seal(&bob, b"hello ada").unwrap();
    assert_eq!(a.open(&e).unwrap(), b"hello ada");
}

/// A joiner that redeemed the offer: its identity, the offer bound to it, and the first handshake message.
fn redeem(offer: &mut Offer, code: &InviteCode, name: &str) -> (Identity, Joiner, Vec<u8>) {
    let me = Identity::fresh();
    offer.set_redeemer(&me.member_id);
    let (j, msg1) = Joiner::start(code, &me, name).unwrap();
    (me, j, msg1)
}

#[test]
fn a_wrong_code_never_gets_a_welcome_and_three_failed_hellos_burn_the_offer() {
    let (admin, a) = team();
    let mut offer = Offer::new(NOW);
    let good = offer.code(&a, &admin);
    let mut bad = good.clone();
    bad.otp = [7; 16];
    let eve = Identity::fresh();
    offer.set_redeemer(&eve.member_id);
    for i in 0..3u64 {
        let (j, msg1) = Joiner::start(&bad, &eve, "Eve").unwrap();
        let mut pending = offer.accept(&admin, &eve.member_id, &msg1, NOW + i * 20_000).unwrap(); // message 1 does not carry the code
        assert!(j.on_msg2(&pending.msg2).is_err(), "the joiner cannot finish without the code");
        assert!(offer.hello(&mut pending, &eve.member_id, &[1u8; 40], NOW + i * 20_000).is_err());
        assert!(pending.approve(&mut team().1, &admin, NOW).is_err(), "an unverified joiner cannot be approved");
    }
    let (_j, msg1) = Joiner::start(&good, &eve, "Bob").unwrap();
    assert!(matches!(offer.accept(&admin, &eve.member_id, &msg1, NOW + 70_000), Err(TeamError::InviteSpent)), "burned after three strikes");
}

#[test]
fn only_the_member_that_redeemed_the_invite_can_use_it_and_strangers_cost_nothing() {
    let (admin, a) = team();
    let mut offer = Offer::new(NOW);
    let code = offer.code(&a, &admin);
    let (bob, j, msg1) = redeem(&mut offer, &code, "Bob");
    // another team member sends garbage and a copy of Bob's message: no strike, no state
    let mallory = Identity::fresh();
    for _ in 0..5 {
        assert!(offer.accept(&admin, &mallory.member_id, &[9u8; 60], NOW).is_err());
        assert!(offer.accept(&admin, &mallory.member_id, &msg1, NOW).is_err());
    }
    // the join request names another id than the relay sender: refused (and a strike for the redeemer)
    let (_x, wrong) = Joiner::start(&code, &Identity::fresh(), "Imposter").unwrap();
    assert!(offer.accept(&admin, &bob.member_id, &wrong, NOW).is_err());
    let mut pending = offer.accept(&admin, &bob.member_id, &msg1, NOW).unwrap();
    let mut joined = j.on_msg2(&pending.msg2).unwrap();
    // a hello that arrives from somebody else is not Bob's
    assert!(offer.hello(&mut pending, &mallory.member_id, &joined.hello().unwrap(), NOW).is_err());
    assert!(pending.approve(&mut team().1, &admin, NOW).is_err());
}

#[test]
fn a_stalled_handshake_goes_stale_and_three_stalls_burn_the_offer() {
    let (admin, a) = team();
    let mut offer = Offer::new(NOW);
    let code = offer.code(&a, &admin);
    let me = Identity::fresh();
    offer.set_redeemer(&me.member_id);
    for i in 0..3u64 {
        let t = NOW + i * 16_000;
        let (_j, msg1) = Joiner::start(&code, &me, "Staller").unwrap();
        let pending = offer.accept(&admin, &me.member_id, &msg1, t).unwrap();
        assert!(!pending.is_stale(t + 14_000));
        assert!(offer.drop_stale(&pending, t + 15_000));
    }
    let (_j, msg1) = Joiner::start(&code, &me, "Staller").unwrap();
    assert!(matches!(offer.accept(&admin, &me.member_id, &msg1, NOW + 60_000), Err(TeamError::InviteSpent)));
}

#[test]
fn an_offer_is_single_use_and_expires() {
    let (admin, a) = team();
    let mut offer = Offer::new(NOW);
    let code = offer.code(&a, &admin);
    let (bob, j, msg1) = redeem(&mut offer, &code, "Bob");
    let mut p = offer.accept(&admin, &bob.member_id, &msg1, NOW).unwrap();
    // one handshake at a time
    let (_j2, other) = Joiner::start(&code, &Identity::fresh(), "Carol").unwrap();
    assert!(matches!(offer.accept(&admin, &bob.member_id, &other, NOW + 1), Err(TeamError::InviteSpent)));
    let mut joined = j.on_msg2(&p.msg2).unwrap();
    offer.hello(&mut p, &bob.member_id, &joined.hello().unwrap(), NOW + 2).unwrap();
    let (_j3, again) = Joiner::start(&code, &bob, "Bob").unwrap();
    assert!(matches!(offer.accept(&admin, &bob.member_id, &again, NOW + 60_000), Err(TeamError::InviteSpent)), "spent after the first success");
    let mut late = Offer::new(NOW);
    let code = late.code(&a, &admin);
    let (erin, _j, msg1) = redeem(&mut late, &code, "Erin");
    assert!(matches!(late.accept(&admin, &erin.member_id, &msg1, NOW + 11 * 60_000), Err(TeamError::InviteSpent)));
}

#[test]
fn a_welcome_from_somebody_else_is_refused() {
    let (admin, mut a) = team();
    let mut offer = Offer::new(NOW);
    let code = offer.code(&a, &admin);
    let (me, joiner, msg1) = redeem(&mut offer, &code, "Bob");
    let mut pending = offer.accept(&admin, &me.member_id, &msg1, NOW).unwrap();
    let mut joined = joiner.on_msg2(&pending.msg2).unwrap();
    offer.hello(&mut pending, &me.member_id, &joined.hello().unwrap(), NOW).unwrap();
    let (_w, _r, _id) = pending.approve(&mut a, &admin, NOW).unwrap();
    // a man in the middle cannot produce a welcome the Noise channel accepts
    assert!(joined.finish(&[0u8; 80], &me).is_err());
}

#[test]
fn a_revoked_member_cannot_read_the_new_epoch() {
    let (admin, mut a) = team();
    let (bob, mut b) = join(&admin, &mut a, "Bob");
    let (carol, mut c) = join(&admin, &mut a, "Carol");
    b.apply_roster(a.roster().clone()).unwrap();
    c.apply_roster(a.roster().clone()).unwrap();
    assert_eq!(a.epoch(), 1);

    let r = a.revoke(&admin, &bob.member_id, NOW + 10).unwrap();
    assert_eq!(r.epoch, 2);
    assert_eq!(a.epoch(), 2);
    assert_eq!(a.body().members.len(), 2);
    assert_eq!(r.deliveries.len(), 1, "only the remaining non-admin member gets a key");
    assert_eq!(r.deliveries[0].0, carol.member_id);

    // Carol takes the new key; Bob cannot take Carol's delivery
    assert_eq!(c.apply_rekey(&carol, &r.deliveries[0].1).unwrap(), 2);
    assert!(b.apply_rekey(&bob, &r.deliveries[0].1).is_err());
    assert_eq!(c.epoch(), 2);
    assert!(c.body().member(&bob.member_id).is_none());

    let e = a.seal(&admin, b"secret after the revoke").unwrap();
    assert_eq!(e.epoch, 2);
    assert_eq!(c.open(&e).unwrap(), b"secret after the revoke");
    // Bob, stale: refuses (epoch ahead of his roster); Bob, informed of the new roster: has no key for epoch 2
    assert!(b.open(&e).is_err());
    b.apply_roster(r.roster.clone()).unwrap();
    assert!(matches!(b.open(&e), Err(TeamError::NoKey(2))), "he never gets the key");
    // even with the roster stub left as it was, the key is simply not there
    assert!(b.keys().key(2).is_none());
    // Bob cannot speak to the team any more: Carol rejects his epoch-1 envelope as from a non-member
    let from_bob = b.seal(&bob, b"let me back in").unwrap();
    assert!(matches!(c.open(&from_bob), Err(TeamError::UnknownSender)));
}

#[test]
fn only_an_admin_revokes_and_an_admin_cannot_be_removed() {
    let (admin, mut a) = team();
    let (bob, mut b) = join(&admin, &mut a, "Bob");
    assert!(matches!(b.revoke(&bob, &admin.member_id, NOW), Err(TeamError::NotAdmin)));
    assert!(a.revoke(&admin, &admin.member_id, NOW).is_err());
    assert!(a.revoke(&admin, "nobody", NOW).is_err());
}

#[test]
fn a_rekey_not_sent_by_an_admin_is_refused() {
    let (admin, mut a) = team();
    let (bob, mut b) = join(&admin, &mut a, "Bob");
    let (carol, mut c) = join(&admin, &mut a, "Carol");
    b.apply_roster(a.roster().clone()).unwrap();
    c.apply_roster(a.roster().clone()).unwrap();
    // a genuine delivery, but sent to Carol by Bob (re-sealed with Bob's static key): Carol only trusts admins
    let r = a.revoke(&admin, &bob.member_id, NOW).unwrap();
    let wrapped = intely_team::rekey::seal(&bob.noise, &carol.noise.public, b"{}").unwrap();
    let p = intely_team::wire::frame(intely_team::wire::tag::REKEY, &wrapped);
    assert!(matches!(c.apply_rekey(&carol, &p), Err(TeamError::NotAdmin)));
    assert_eq!(c.epoch(), 1);
    assert_eq!(c.apply_rekey(&carol, &r.deliveries[0].1).unwrap(), 2);
}

#[test]
fn forged_signatures_and_impersonation_are_rejected() {
    let (admin, mut a) = team();
    let (bob, mut b) = join(&admin, &mut a, "Bob");
    let (carol, mut c) = join(&admin, &mut a, "Carol");
    b.apply_roster(a.roster().clone()).unwrap();
    c.apply_roster(a.roster().clone()).unwrap();

    // Bob holds the team key but signs "as Carol": the roster has Carol's key, so the signature fails
    let mut e = b.seal(&bob, b"carol says hi").unwrap();
    e.sender = carol.member_id.clone();
    assert!(matches!(a.open(&e), Err(TeamError::Forged)));
    // a tampered ciphertext breaks the signature before anything is decrypted
    let mut e = b.seal(&bob, b"payload").unwrap();
    e.ct.replace_range(0..2, if e.ct.starts_with("AA") { "BB" } else { "AA" });
    assert!(matches!(a.open(&e), Err(TeamError::Forged)));
    // a changed epoch or sequence number is covered by the signature too
    let mut e = b.seal(&bob, b"payload").unwrap();
    e.seq += 5;
    assert!(matches!(a.open(&e), Err(TeamError::Forged)));
    // an outsider with a perfectly valid signature of their own is not on the roster
    let eve = Identity::fresh();
    let e = envelope::seal(&a.team_id, a.keys(), &eve, 1, b"hi").unwrap();
    assert!(matches!(a.open(&e), Err(TeamError::UnknownSender)));
    // the real thing still works afterwards: forged frames did not burn a sequence number
    let e = b.seal(&bob, b"real").unwrap();
    assert_eq!(a.open(&e).unwrap(), b"real");
}

#[test]
fn replays_and_reordered_copies_are_rejected() {
    let (admin, mut a) = team();
    let (bob, mut b) = join(&admin, &mut a, "Bob");
    b.apply_roster(a.roster().clone()).unwrap();
    let e1 = b.seal(&bob, b"one").unwrap();
    let e2 = b.seal(&bob, b"two").unwrap();
    assert_eq!(a.open(&e2).unwrap(), b"two");
    assert!(matches!(a.open(&e2), Err(TeamError::Replay)));
    assert!(matches!(a.open(&e1), Err(TeamError::Replay)), "older than the newest seen");
    // the wire form round-trips
    let e3 = b.seal(&bob, b"three").unwrap();
    let again = Envelope::decode(&e3.encode()).unwrap();
    assert_eq!(a.open(&again).unwrap(), b"three");
    // a second team with the same members' keys cannot be replayed into this one
    let mut g = ReplayGuard::default();
    assert!(envelope::open("another-team", a.keys(), a.body(), &mut g, &e3).is_err());
}

#[test]
fn a_tampered_or_misattributed_roster_is_rejected() {
    let (admin, mut a) = team();
    let (bob, mut b) = join(&admin, &mut a, "Bob");
    let (_carol, _c) = join(&admin, &mut a, "Carol");
    let good = a.roster().clone();

    // edit the signed body (promote Bob)
    let mut t = good.clone();
    t.body = t.body.replace(&format!("\"id\":\"{}\",\"name\":\"Bob\",\"role\":\"member\"", bob.member_id), &format!("\"id\":\"{}\",\"name\":\"Bob\",\"role\":\"admin\"", bob.member_id));
    assert_ne!(t.body, good.body);
    assert!(b.apply_roster(t).is_err());
    // a roster Bob signs himself is not from an admin
    let mut body = good.parse().unwrap();
    body.version += 1;
    let by_bob = SignedRoster::sign(&body, &bob).unwrap();
    assert!(matches!(b.apply_roster(by_bob), Err(TeamError::NotAdmin)));
    // the real one is accepted, and an older one is a no-op
    assert!(b.apply_roster(good.clone()).unwrap());
    assert!(!b.apply_roster(good).unwrap());
    // the first roster of a joiner must come from the admin the invite pinned
    let (_, a2) = team();
    assert!(a.roster().verify_first(&a.team_id, &admin.member_id, &[9; 32]).is_err());
    assert!(a.roster().verify_first(&a.team_id, &admin.member_id, &admin.noise.public).is_ok());
    assert!(a2.roster().verify_first(&a.team_id, &admin.member_id, &admin.noise.public).is_err());
}

#[test]
fn identity_and_state_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let s = secrets();
    let id = Identity::load_or_create(&s).unwrap();
    assert_eq!(Identity::load_or_create(&s).unwrap().member_id, id.member_id);
    assert_eq!(Identity::load_or_create(&s).unwrap().sign_public(), id.sign_public());
    assert_ne!(Identity::rotate(&s).unwrap().member_id, id.member_id);

    let mut st = TeamState::create(&id, "wss://relay.example", "Ada", NOW).unwrap();
    let e1 = st.seal(&id, b"x").unwrap();
    st.save(dir.path(), &s).unwrap();
    assert!(!st.take_dirty());
    let mut back = TeamState::load(dir.path(), &s).unwrap().unwrap();
    assert_eq!(back.team_id, st.team_id);
    assert_eq!(back.epoch(), 1);
    // the send counter resumes after the reserved block, never reusing a number
    let e2 = back.seal(&id, b"y").unwrap();
    assert!(e2.seq > e1.seq);
    // the keys are in the secret store, not in team.json
    let text = std::fs::read_to_string(TeamState::path_in(dir.path())).unwrap();
    assert!(!text.contains(&hex::encode(st.keys().key(1).unwrap())));
    TeamState::forget(dir.path(), &s).unwrap();
    assert!(TeamState::load(dir.path(), &s).unwrap().is_none());
}

#[test]
fn the_audit_chain_has_its_own_file_and_detects_tampering() {
    let dir = tempfile::tempdir().unwrap();
    let s = secrets();
    let mut log = TeamAudit::open(dir.path(), s.clone()).unwrap();
    log.record(event::TEAM_CREATED, Some("m1"), None, 1).unwrap();
    log.record(event::MEMBER_JOINED, Some("m2"), Some("sas"), 2).unwrap();
    assert_eq!(log.len(), 2);
    assert!(TeamAudit::path_in(dir.path()).ends_with("team-audit.jsonl"));
    drop(log);
    let log = TeamAudit::open(dir.path(), s.clone()).unwrap();
    assert_eq!(log.tail(5).len(), 2);
    drop(log);
    let p = TeamAudit::path_in(dir.path());
    let text = std::fs::read_to_string(&p).unwrap().replace("m2", "m9");
    std::fs::write(&p, text).unwrap();
    assert!(TeamAudit::open(dir.path(), s).is_err());
}

#[test]
fn invite_codes_and_relay_messages_parse() {
    let (admin, a) = team();
    let offer = Offer::new(NOW);
    let code = offer.code(&a, &admin);
    let link = code.to_link();
    assert!(link.len() < 288, "fits a QR code");
    assert_eq!(InviteCode::parse(&link).unwrap(), code);
    assert!(InviteCode::parse("https://example.com").is_err());
    assert!(InviteCode::parse(&link.replace("intely-team://", "x://")).is_err());
    assert_eq!(offer.relay_token_hash().len(), 64);

    assert!(matches!(ServerMsg::parse(r#"{"t":"presence","id":"m1","online":true,"state":"busy"}"#), ServerMsg::Presence { online: true, .. }));
    assert!(matches!(ServerMsg::parse(r#"{"t":"msg","kind":"direct","from":"m1","ts":1,"p":"AAAA"}"#), ServerMsg::Msg(_)));
    assert!(matches!(ServerMsg::parse(r#"{"t":"err","code":"conflict","status":409}"#), ServerMsg::Reply(_)));
    assert!(matches!(ServerMsg::parse(r#"{"t":"hello","id":"m1","role":"admin","status":"active","members":[]}"#), ServerMsg::Hello(_)));
    assert!(matches!(ServerMsg::parse("not json"), ServerMsg::Other));
}

#[test]
fn the_roster_at_the_relay_is_encrypted_and_only_current_members_can_read_it() {
    let (admin, mut a) = team();
    let (bob, mut b) = join(&admin, &mut a, "Bob");
    let (carol, mut c) = join(&admin, &mut a, "Carol");
    b.apply_roster(a.roster().clone()).unwrap();
    c.apply_roster(a.roster().clone()).unwrap();
    let p = a.seal_roster().unwrap();
    assert!(!p.contains("Bob"), "names are not readable in the payload");
    let plain = intely_remote::util::b64u_decode(&p).unwrap();
    assert!(!String::from_utf8_lossy(&plain).contains("Carol"));
    assert_eq!(b.open_roster(&p).unwrap(), *a.roster());
    // a flipped bit fails the AEAD; another team's payload fails on its associated data
    let mut bad = plain.clone();
    let last = bad.len() - 1;
    bad[last] ^= 1;
    assert!(b.open_roster(&intely_remote::util::b64u(&bad)).is_err());
    let (_, other) = team();
    assert!(other.open_roster(&p).is_err());
    // after a revoke the new roster is sealed under epoch 2: the removed member never gets that key
    let r = a.revoke(&admin, &bob.member_id, NOW + 5).unwrap();
    let p2 = a.seal_roster().unwrap();
    assert!(matches!(b.open_roster(&p2), Err(TeamError::NoKey(2))));
    assert!(matches!(c.open_roster(&p2), Err(TeamError::NoKey(2))), "Carol needs the rekey first");
    c.apply_rekey(&carol, &r.deliveries[0].1).unwrap();
    assert_eq!(c.open_roster(&p2).unwrap().signer, admin.member_id);
}

#[test]
fn a_revoke_is_saved_as_an_outbox_until_confirmed_and_a_resend_is_harmless() {
    let dir = tempfile::tempdir().unwrap();
    let s = secrets();
    let (admin, mut a) = team();
    let (bob, mut b) = join(&admin, &mut a, "Bob");
    let (carol, mut c) = join(&admin, &mut a, "Carol");
    b.apply_roster(a.roster().clone()).unwrap();
    c.apply_roster(a.roster().clone()).unwrap();
    let r = a.revoke(&admin, &bob.member_id, NOW + 5).unwrap();
    // the intent is in the state before anything is sent, and survives a restart
    assert_eq!(a.outbox().len(), 1);
    assert_eq!(a.outbox()[0].to, carol.member_id);
    assert_eq!(a.pending_revokes(), [bob.member_id.clone()]);
    a.save(dir.path(), &s).unwrap();
    let mut back = TeamState::load(dir.path(), &s).unwrap().unwrap();
    assert_eq!(back.outbox(), a.outbox());
    assert_eq!(back.pending_revokes(), a.pending_revokes());
    // delivered twice (a resend after a reconnect): the second one is a no-op, not an error
    assert_eq!(c.apply_rekey(&carol, &r.deliveries[0].1).unwrap(), 2);
    assert_eq!(c.apply_rekey(&carol, &back.outbox()[0].payload).unwrap(), 2);
    assert_eq!(c.epoch(), 2);
    // relay confirmations clear it
    back.outbox_done(&carol.member_id);
    back.revoke_done(&bob.member_id);
    assert!(back.outbox().is_empty() && back.pending_revokes().is_empty());
    // a second revoke replaces a hand-over that was never confirmed (the newest one carries every key)
    let (dan, mut d) = join(&admin, &mut a, "Dan");
    d.apply_roster(a.roster().clone()).unwrap();
    let r2 = a.revoke(&admin, &carol.member_id, NOW + 9).unwrap();
    assert!(a.outbox().iter().all(|o| o.to == dan.member_id && o.epoch == 3), "{:?}", a.outbox());
    assert_eq!(d.apply_rekey(&dan, &r2.deliveries[0].1).unwrap(), 3);
    assert!(d.keys().key(2).is_some() && d.keys().key(3).is_some());
}

#[test]
fn queued_frames_are_acknowledged_only_after_they_were_applied() {
    use intely_team::inbox::{AckGate, Verdict, MAX_ATTEMPTS};
    let mut g = AckGate::default();
    assert_eq!(g.handled(None, true), Verdict::NoAck, "a live frame has nothing to ack");
    assert_eq!(g.handled(Some(1), true), Verdict::Ack(1));
    // 2 fails: it and everything after it stay at the relay (an ack of 3 would delete 2)
    assert_eq!(g.handled(Some(2), false), Verdict::NoAck);
    assert_eq!(g.handled(Some(3), true), Verdict::NoAck);
    // each reconnect tries again; the last try gives up so the queue cannot block forever
    for _ in 1..MAX_ATTEMPTS - 1 {
        g.new_connection();
        assert_eq!(g.handled(Some(2), false), Verdict::NoAck);
    }
    g.new_connection();
    assert_eq!(g.handled(Some(2), false), Verdict::GaveUp(2));
    assert_eq!(g.handled(Some(3), true), Verdict::Ack(3));
}

#[test]
fn invite_codes_with_odd_ids_are_refused() {
    let (admin, a) = team();
    let link = Offer::new(NOW).code(&a, &admin).to_link();
    assert!(InviteCode::parse(&link).is_ok());
    let team_id = &a.team_id;
    assert!(InviteCode::parse(&link.replace(team_id.as_str(), "short")).is_err());
    assert!(InviteCode::parse(&link.replace(team_id.as_str(), &format!("{}../x", &team_id[..20]))).is_err());
    assert!(InviteCode::parse(&link.replace(&admin.member_id, "pair-abc")).is_err());
    assert!(InviteCode::parse(&link.replace(&admin.member_id, "a b")).is_err());
}

/// The biggest chat history answer the owner's store can produce, with the text escaping as badly as it can, is still one frame of the
/// relay (`TEAM_MAX_FRAME`: 64 KiB of JSON text, wrapper included).
#[test]
fn the_largest_chat_history_fits_one_relay_frame() {
    use intely_team::chat::{ChatEntry, ChatStore};
    use intely_team::collab::CollabMsg;
    let (admin, mut a) = team();
    let (bob, mut b) = join(&admin, &mut a, "Bob");
    // short messages carry the most id and author per byte of text; quotes and newlines take two bytes each in JSON
    for text in ["\"", "\"\"\"\"\"\"\"\"\"\"", &"\"".repeat(300), &"\"".repeat(1900), &format!("{}x", "x\n".repeat(949)), &"\u{1F600}".repeat(1900)] {
        let mut store = ChatStore::default();
        for i in 0..250u64 {
            store.push("o", "r", ChatEntry { msg_id: format!("{}.{i:011}", bob.member_id), author: bob.member_id.clone(), text: text.to_string(), at: 1_700_000_000_000 + i });
        }
        let msgs = store.history("o", "r");
        assert!(!msgs.is_empty());
        let msg = CollabMsg::ChatHistory { run_id: "r".repeat(80), msgs };
        assert!(CollabMsg::parse(&msg.encode()).is_some(), "the answer is a valid message");
        let env = b.seal(&bob, &msg.encode()).unwrap();
        let wire = env.encode().len();
        assert!(wire + 1024 < 64 * 1024, "a history answer of {} bytes of JSON takes {wire} bytes on the wire", msg.encode().len());
        assert!(a.open(&env).is_ok());
    }
}
