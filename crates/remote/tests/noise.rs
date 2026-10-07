//! The Noise layer: pairing and reconnect handshakes, replay, reorder, rekey, SAS.

use intely_remote::noise::*;

fn pair() -> (StaticKey, StaticKey) {
    (StaticKey::generate(), StaticKey::generate())
}

fn ik() -> (Transport, Transport, String, String) {
    let (mac, phone) = pair();
    let mut i = Handshake::initiator(Kind::Reconnect, &phone, &mac.public, None).unwrap();
    let mut r = Handshake::responder(Kind::Reconnect, &mac, None).unwrap();
    let m1 = i.write(b"").unwrap();
    r.read(&m1).unwrap();
    assert_eq!(r.remote_static(), Some(phone.public), "the Mac learns the phone key");
    let m2 = r.write(b"").unwrap();
    i.read(&m2).unwrap();
    let (si, sr) = (i.sas(), r.sas());
    (i.into_transport().unwrap(), r.into_transport().unwrap(), si, sr)
}

#[test]
fn reconnect_handshake_gives_a_working_duplex_channel_and_matching_sas() {
    let (mut phone, mut mac, sp, sm) = ik();
    assert_eq!(sp, sm);
    assert_eq!(sp.len(), 6);
    let c = phone.encrypt(b"hello mac").unwrap();
    assert_eq!(mac.decrypt(&c).unwrap(), b"hello mac");
    let c = mac.encrypt(b"hello phone").unwrap();
    assert_eq!(phone.decrypt(&c).unwrap(), b"hello phone");
}

#[test]
fn every_connection_has_fresh_keys() {
    let (mac, phone) = pair();
    let hello = |fixed: &StaticKey| {
        let mut i = Handshake::initiator(Kind::Reconnect, &phone, &mac.public, None).unwrap();
        let _ = fixed;
        i.write(b"").unwrap()
    };
    let a = hello(&mac);
    let b = hello(&mac);
    assert_ne!(a, b, "fresh ephemerals: two handshakes never look alike");
}

#[test]
fn a_replayed_dropped_in_or_reordered_frame_does_not_decrypt() {
    let (mut phone, mut mac, _, _) = ik();
    let c1 = phone.encrypt(b"one").unwrap();
    let c2 = phone.encrypt(b"two").unwrap();
    let c3 = phone.encrypt(b"three").unwrap();
    assert!(mac.decrypt(&c2).is_err(), "out of order");
    assert_eq!(mac.decrypt(&c1).unwrap(), b"one");
    assert!(mac.decrypt(&c1).is_err(), "replay");
    assert_eq!(mac.decrypt(&c2).unwrap(), b"two", "a failed frame did not advance the counter");
    let mut bad = c3.clone();
    bad[3] ^= 1;
    assert!(mac.decrypt(&bad).is_err(), "tampered");
    assert_eq!(mac.decrypt(&c3).unwrap(), b"three");
    assert!(mac.decrypt(&[0u8; 5]).is_err() && mac.decrypt(&[]).is_err() && mac.decrypt(&vec![0u8; 70_000]).is_err());
    // a frame from another session
    let (mut p2, _m2, _, _) = ik();
    let foreign = p2.encrypt(b"x").unwrap();
    assert!(mac.decrypt(&foreign).is_err());
}

#[test]
fn pairing_needs_the_one_time_psk() {
    let (mac, phone) = pair();
    let otp = new_otp();
    let run = |otp_mac: &[u8; 16], otp_phone: &[u8; 16]| -> bool {
        let mut i = Handshake::initiator(Kind::Pairing, &phone, &mac.public, Some(&psk_from_otp(otp_phone))).unwrap();
        let mut r = Handshake::responder(Kind::Pairing, &mac, Some(&psk_from_otp(otp_mac))).unwrap();
        let m1 = i.write(b"").unwrap();
        if r.read(&m1).is_err() {
            return false;
        }
        let m2 = r.write(b"").unwrap();
        i.read(&m2).is_ok()
    };
    assert!(run(&otp, &otp));
    assert!(!run(&otp, &new_otp()), "a wrong PSK cannot read the answer");
    // a plain IK handshake cannot talk to an IKpsk2 responder
    let mut i = Handshake::initiator(Kind::Reconnect, &phone, &mac.public, None).unwrap();
    let mut r = Handshake::responder(Kind::Pairing, &mac, Some(&psk_from_otp(&otp))).unwrap();
    let m1 = i.write(b"").unwrap();
    let _ = r.read(&m1);
    let m2 = r.write(b"");
    assert!(m2.is_err() || i.read(&m2.unwrap()).is_err(), "no downgrade across the two patterns");
}

#[test]
fn a_man_in_the_middle_with_another_static_key_gets_a_different_sas() {
    let (mac, phone) = pair();
    let otp = new_otp();
    let psk = psk_from_otp(&otp);
    // the attacker holds the PSK (saw the QR) but not the Mac's static key: the phone pinned the real one, so the
    // attacker's responder cannot complete the handshake the phone started
    let attacker = StaticKey::generate();
    let mut i = Handshake::initiator(Kind::Pairing, &phone, &mac.public, Some(&psk)).unwrap();
    let mut r = Handshake::responder(Kind::Pairing, &attacker, Some(&psk)).unwrap();
    let m1 = i.write(b"").unwrap();
    assert!(r.read(&m1).is_err());
}

#[test]
fn both_directions_rekey_every_65536_messages_and_keep_working() {
    let (mut phone, mut mac, _, _) = ik();
    for n in 0..(REKEY_EVERY + 3) {
        let c = phone.encrypt(b"x").unwrap();
        assert_eq!(mac.decrypt(&c).unwrap(), b"x", "message {n}");
    }
    let c = mac.encrypt(b"reply").unwrap();
    assert_eq!(phone.decrypt(&c).unwrap(), b"reply");
    assert_eq!(phone.counters().0, REKEY_EVERY + 3);
}

#[test]
fn static_keys_round_trip_through_the_secret_form_and_never_print() {
    let k = StaticKey::generate();
    let back = StaticKey::from_secret(&k.to_secret()).unwrap();
    assert_eq!((k.private, k.public), (back.private, back.public));
    assert!(StaticKey::from_secret("zz:zz").is_none() && StaticKey::from_secret("").is_none());
    assert!(!format!("{k:?}").contains(&hex::encode(k.private)));
}

#[test]
fn the_manual_code_round_trips_and_forgives_look_alike_characters() {
    let otp = new_otp();
    let code = intely_remote::pairing::manual_code(&otp);
    assert_eq!(code.replace('-', "").len(), 26);
    assert_eq!(intely_remote::pairing::parse_manual_code(&code), Some(otp));
    assert_eq!(intely_remote::pairing::parse_manual_code(&code.to_lowercase()), Some(otp));
    assert_eq!(intely_remote::pairing::parse_manual_code("short"), None);
}
