//! U1: feed parse/validate, sequence rule, kill-switch verdicts, endpoints and the project-link
//! rule (spec 10.2 `feed`).
mod common;

use common::fixture_text;
use intely_updater::endpoints::{self, validate_project_link, Endpoints, Hop};
use intely_updater::feed::{check_seq, parse_rfc3339, validate_notes, BlockReason, Feed};
use intely_updater::keys::Role;
use intely_updater::limits::*;
use intely_updater::version::{parse_strict, Arch, Channel};
use intely_updater::ErrorCode;
use serde_json::{json, Value};

fn golden() -> Value {
    serde_json::from_str(&fixture_text("feed_valid.json")).unwrap()
}

fn parse_value(v: &Value) -> Result<Feed, ErrorCode> {
    Feed::parse(serde_json::to_string(v).unwrap().as_bytes(), Channel::Stable, &Endpoints::production())
}

fn with(f: impl FnOnce(&mut Value)) -> Result<Feed, ErrorCode> {
    let mut v = golden();
    f(&mut v);
    parse_value(&v)
}

#[test]
fn golden_feed_parses() {
    let f = Feed::parse(fixture_text("feed_valid.json").as_bytes(), Channel::Stable, &Endpoints::production()).unwrap();
    assert_eq!(f.version.to_string(), "0.1.1");
    assert_eq!(f.seq, 2);
    assert_eq!(f.channel, Channel::Stable);
    assert_eq!(f.min_os.as_deref(), Some("13.5"));
    assert!(!f.native_switch_ok && !f.entitlements_change);
    let x = f.entry_for(Arch::X64).unwrap();
    assert_eq!(x.bytes, 74448896);
    assert_eq!(x.sha256.len(), 64);
    assert!(f.entry_for(Arch::Aarch64).is_ok());
    assert_eq!(f.valid_until, parse_rfc3339("2026-12-04T09:00:00Z"));
}

#[test]
fn unknown_fields_and_platforms_are_ignored() {
    let f = with(|v| {
        v["somethingNew"] = json!({"a": 1});
        v["platforms"]["windows-x86_64"] = json!({"nonsense": true});
        v["platforms"]["darwin-x86_64"]["extra"] = json!(1);
    })
    .unwrap();
    assert_eq!(f.platforms.len(), 2);
}

#[test]
fn schema_channel_and_size() {
    assert_eq!(with(|v| v["schema"] = json!(2)).unwrap_err(), ErrorCode::FeedSchema);
    assert_eq!(with(|v| v["schema"] = json!("1")).unwrap_err(), ErrorCode::FeedSchema);
    assert_eq!(with(|v| { v.as_object_mut().unwrap().remove("schema"); }).unwrap_err(), ErrorCode::FeedInvalid);
    assert_eq!(with(|v| v["channel"] = json!("alpha")).unwrap_err(), ErrorCode::FeedChannel);
    assert_eq!(with(|v| v["channel"] = json!("nightly")).unwrap_err(), ErrorCode::FeedChannel);
    assert_eq!(Feed::parse(b"not json", Channel::Stable, &Endpoints::production()).unwrap_err(), ErrorCode::FeedInvalid);
    assert_eq!(Feed::parse(b"[]", Channel::Stable, &Endpoints::production()).unwrap_err(), ErrorCode::FeedInvalid);
    // body limit: exactly 256 KiB parses as far as JSON goes, one byte more is feedTooLarge
    let big = vec![b' '; FEED_MAX_BYTES as usize + 1];
    assert_eq!(Feed::parse(&big, Channel::Stable, &Endpoints::production()).unwrap_err(), ErrorCode::FeedTooLarge);
    let at_limit = vec![b' '; FEED_MAX_BYTES as usize];
    assert_eq!(Feed::parse(&at_limit, Channel::Stable, &Endpoints::production()).unwrap_err(), ErrorCode::FeedInvalid);
}

#[test]
fn alpha_feed_served_at_the_stable_url_fails_with_feed_channel() {
    let mut v = golden();
    v["channel"] = json!("alpha");
    let bytes = serde_json::to_vec(&v).unwrap();
    assert_eq!(Feed::parse(&bytes, Channel::Stable, &Endpoints::production()).unwrap_err(), ErrorCode::FeedChannel);
    assert!(Feed::parse(&bytes, Channel::Alpha, &Endpoints::production()).is_ok());
}

#[test]
fn version_rules() {
    assert_eq!(with(|v| v["version"] = json!("v0.1.1")).unwrap_err(), ErrorCode::FeedInvalid);
    assert_eq!(with(|v| v["version"] = json!("0.1.1+b")).unwrap_err(), ErrorCode::FeedInvalid);
    // stable forbids a pre-release part
    assert_eq!(
        with(|v| {
            v["version"] = json!("0.2.0-rc.1");
            for k in ["darwin-x86_64", "darwin-aarch64"] {
                let a = if k == "darwin-x86_64" { "x64" } else { "aarch64" };
                v["platforms"][k]["url"] = json!(format!(
                    "https://github.com/ferencfarkas09/IntelyIDE/releases/download/v0.2.0-rc.1/IntelyIDE_0.2.0-rc.1_{a}.app.tar.gz"
                ));
            }
        })
        .unwrap_err(),
        ErrorCode::FeedInvalid
    );
}

#[test]
fn seq_and_timestamp_fields() {
    assert!(with(|v| v["seq"] = json!(1)).is_ok());
    assert!(with(|v| v["seq"] = json!(SEQ_MAX)).is_ok());
    assert_eq!(with(|v| v["seq"] = json!(0)).unwrap_err(), ErrorCode::FeedInvalid);
    assert_eq!(with(|v| v["seq"] = json!(SEQ_MAX + 1)).unwrap_err(), ErrorCode::FeedInvalid);
    assert_eq!(with(|v| v["seq"] = json!(-1)).unwrap_err(), ErrorCode::FeedInvalid);
    assert_eq!(with(|v| v["seq"] = json!(1.5)).unwrap_err(), ErrorCode::FeedInvalid);
    assert_eq!(with(|v| v["generatedAt"] = json!("yesterday")).unwrap_err(), ErrorCode::FeedInvalid);
    assert_eq!(with(|v| v["validUntil"] = json!("2026-13-01T00:00:00Z")).unwrap_err(), ErrorCode::FeedInvalid);
    assert_eq!(with(|v| v["pub_date"] = json!(5)).unwrap_err(), ErrorCode::FeedInvalid);
}

#[test]
fn rfc3339_parser() {
    assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(parse_rfc3339("2000-03-01T00:00:00Z"), Some(951868800));
    assert_eq!(parse_rfc3339("2026-10-20T09:00:00Z"), Some(1792486800));
    assert_eq!(parse_rfc3339("2026-10-20T11:00:00+02:00"), parse_rfc3339("2026-10-20T09:00:00Z"));
    assert_eq!(parse_rfc3339("2026-10-20T09:00:00.123456Z"), parse_rfc3339("2026-10-20T09:00:00Z"));
    assert_eq!(parse_rfc3339("2024-02-29T00:00:00Z").is_some(), true);
    for bad in [
        "", "2026-10-20", "2026-10-20 09:00:00Z", "2026-10-20t09:00:00z", "2026-10-20T09:00:00", "2026-02-29T00:00:00Z",
        "2026-04-31T00:00:00Z", "2026-10-20T24:00:00Z", "2026-10-20T09:60:00Z", "2026-10-20T09:00:60Z", "2026-10-20T09:00:00.Z",
        "2026-10-20T09:00:00+0200", "2026-10-20T09:00:00+24:00", "2026-10-20T09:00:00Zjunk", "1969-12-31T23:59:59Z", "2026-1-20T09:00:00Z",
    ] {
        assert_eq!(parse_rfc3339(bad), None, "{bad:?}");
    }
}

#[test]
fn notes_limits() {
    let eight_kib = "a".repeat(NOTES_MAX_BYTES);
    assert!(validate_notes(&eight_kib).is_ok());
    assert!(validate_notes(&format!("{eight_kib}a")).is_err(), "8 KiB + 1 is oversized");
    let lines = |n: usize| (0..n).map(|_| "x").collect::<Vec<_>>().join("\n");
    assert!(validate_notes(&lines(200)).is_ok());
    assert!(validate_notes(&format!("{}\n", lines(200))).is_ok());
    assert!(validate_notes(&lines(201)).is_err());
    assert!(validate_notes("tab\tand\nnewline are fine").is_ok());
    assert!(validate_notes("").is_ok());
    for c in ['\r', '\u{0}', '\u{7}', '\u{1b}', '\u{7f}', '\u{85}', '\u{9f}'] {
        assert!(validate_notes(&format!("a{c}b")).is_err(), "control {:?}", c);
    }
    for c in [
        '\u{202e}', '\u{202a}', '\u{2066}', '\u{2069}', '\u{200b}', '\u{200c}', '\u{200d}', '\u{200e}', '\u{200f}', '\u{2060}',
        '\u{feff}', '\u{00ad}', '\u{061c}', '\u{2028}', '\u{2029}', '\u{e0041}',
    ] {
        assert!(validate_notes(&format!("a{c}b")).is_err(), "format char {:?}", c);
    }
    assert!(validate_notes("Grüße, 你好, emoji \u{1f600}").is_ok());
    let f = with(|v| v["notes"] = json!(format!("{eight_kib}a")));
    assert_eq!(f.unwrap_err(), ErrorCode::FeedInvalid);
}

#[test]
fn artifact_entry_rules() {
    let url_x64 = "https://github.com/ferencfarkas09/IntelyIDE/releases/download/v0.1.1/IntelyIDE_0.1.1_x64.app.tar.gz";
    // url must equal the rebuilt one: another host, another path, another arch, a query
    for bad in [
        "https://evil.example/ferencfarkas09/IntelyIDE/releases/download/v0.1.1/IntelyIDE_0.1.1_x64.app.tar.gz",
        "https://github.com/ferencfarkas09/IntelyIDE/releases/download/v0.1.1/IntelyIDE_0.1.1_aarch64.app.tar.gz",
        "https://github.com/Other/Repo/releases/download/v0.1.1/IntelyIDE_0.1.1_x64.app.tar.gz",
        "https://github.com/ferencfarkas09/IntelyIDE/releases/download/v0.1.0/IntelyIDE_0.1.0_x64.app.tar.gz",
        "http://github.com/ferencfarkas09/IntelyIDE/releases/download/v0.1.1/IntelyIDE_0.1.1_x64.app.tar.gz",
        "https://github.com/ferencfarkas09/IntelyIDE/releases/download/v0.1.1/IntelyIDE_0.1.1_x64.app.tar.gz?x=1",
        "",
    ] {
        assert_eq!(with(|v| v["platforms"]["darwin-x86_64"]["url"] = json!(bad)).unwrap_err(), ErrorCode::BadUrl, "{bad}");
    }
    assert!(with(|v| v["platforms"]["darwin-x86_64"]["url"] = json!(url_x64)).is_ok());

    let e = |k: &str, val: Value| with(|v| v["platforms"]["darwin-x86_64"][k] = val);
    // bytes: 1 MiB ..= 512 MiB
    assert!(e("bytes", json!(ARTIFACT_MIN_BYTES)).is_ok());
    assert_eq!(e("bytes", json!(ARTIFACT_MIN_BYTES - 1)).unwrap_err(), ErrorCode::FeedInvalid);
    assert!(e("bytes", json!(ARTIFACT_MAX_BYTES)).is_ok());
    assert_eq!(e("bytes", json!(ARTIFACT_MAX_BYTES + 1)).unwrap_err(), ErrorCode::TooLarge);
    assert_eq!(e("bytes", json!(-5)).unwrap_err(), ErrorCode::FeedInvalid);
    // unpackedBytes <= 1.5 GiB
    assert!(e("unpackedBytes", json!(UNPACKED_MAX_BYTES)).is_ok());
    assert_eq!(e("unpackedBytes", json!(UNPACKED_MAX_BYTES + 1)).unwrap_err(), ErrorCode::TooLarge);
    assert_eq!(e("unpackedBytes", json!(0)).unwrap_err(), ErrorCode::FeedInvalid);
    // sha256: 64 lowercase hex
    let h = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    assert!(e("sha256", json!(h)).is_ok());
    for bad in [h.to_uppercase(), h[..63].to_string(), format!("{h}0"), "g".repeat(64), String::new()] {
        assert_eq!(e("sha256", json!(bad)).unwrap_err(), ErrorCode::FeedInvalid);
    }
    // signature: base64 text, <= 2 KiB
    assert!(e("signature", json!("A".repeat(ENTRY_SIG_MAX_BYTES))).is_ok());
    assert_eq!(e("signature", json!("A".repeat(ENTRY_SIG_MAX_BYTES + 1))).unwrap_err(), ErrorCode::FeedInvalid);
    assert_eq!(e("signature", json!("")).unwrap_err(), ErrorCode::FeedInvalid);
    assert_eq!(e("signature", json!("not base64 !")).unwrap_err(), ErrorCode::FeedInvalid);
    // missing field
    assert_eq!(with(|v| { v["platforms"]["darwin-x86_64"].as_object_mut().unwrap().remove("sha256"); }).unwrap_err(), ErrorCode::FeedInvalid);
}

#[test]
fn missing_platform_is_no_platform() {
    let f = with(|v| { v["platforms"].as_object_mut().unwrap().remove("darwin-aarch64"); }).unwrap();
    assert!(f.entry_for(Arch::X64).is_ok());
    assert_eq!(f.entry_for(Arch::Aarch64).unwrap_err(), ErrorCode::NoPlatform);
    let none = with(|v| v["platforms"] = json!({})).unwrap();
    assert_eq!(none.entry_for(Arch::X64).unwrap_err(), ErrorCode::NoPlatform);
}

#[test]
fn notes_url_must_be_a_project_link() {
    assert!(with(|v| v["notesUrl"] = json!("https://ferencfarkas09.github.io/IntelyIDE/")).is_ok());
    for bad in [
        "https://evil.example/x",
        "https://github.com/ferencfarkas09/IntelyIDE/../../evil/x",
        "https://github.com/ferencfarkas09/IntelyIDE/%2e%2e/evil",
        "http://github.com/ferencfarkas09/IntelyIDE/",
        "javascript:alert(1)",
    ] {
        assert_eq!(with(|v| v["notesUrl"] = json!(bad)).unwrap_err(), ErrorCode::FeedInvalid, "{bad}");
    }
}

#[test]
fn min_os_and_booleans() {
    assert!(with(|v| v["minOs"] = json!("13")).is_ok());
    assert_eq!(with(|v| v["minOs"] = json!("thirteen")).unwrap_err(), ErrorCode::FeedInvalid);
    let f = with(|v| {
        v["nativeSwitchOk"] = json!(true);
        v["entitlementsChange"] = json!(true);
    })
    .unwrap();
    assert!(f.native_switch_ok && f.entitlements_change);
    assert_eq!(with(|v| v["nativeSwitchOk"] = json!("yes")).unwrap_err(), ErrorCode::FeedInvalid);
}

#[test]
fn list_fields_and_their_limits() {
    let id = |i: u32| format!("{:016X}", 0xABCD_0000_0000_0000u64 + i as u64);
    let ids = |n: u32| (0..n).map(id).collect::<Vec<_>>();
    assert_eq!(with(|v| v["revoke"] = json!(ids(8))).unwrap().revoke.len(), REVOKE_MAX);
    assert_eq!(with(|v| v["revoke"] = json!(ids(9))).unwrap_err(), ErrorCode::FeedInvalid);
    assert_eq!(with(|v| v["revoke"] = json!(["abcd"])).unwrap_err(), ErrorCode::FeedInvalid);
    assert_eq!(with(|v| v["revoke"] = json!(["zzzzzzzzzzzzzzzz"])).unwrap_err(), ErrorCode::FeedInvalid);
    assert_eq!(with(|v| v["revoke"] = json!(["abcdef0123456789"])).unwrap().revoke, vec!["ABCDEF0123456789"]);

    let block = |n: usize| (0..n).map(|_| json!({"upTo": "0.1.0", "reason": "updaterBug"})).collect::<Vec<_>>();
    assert_eq!(with(|v| v["blockInstall"] = json!(block(4))).unwrap().block_install.len(), BLOCK_INSTALL_MAX);
    assert_eq!(with(|v| v["blockInstall"] = json!(block(5))).unwrap_err(), ErrorCode::FeedInvalid);
    assert_eq!(with(|v| v["blockInstall"] = json!([{"upTo": "0.1.0", "reason": "because"}])).unwrap_err(), ErrorCode::FeedInvalid);
    assert_eq!(with(|v| v["blockInstall"] = json!([{"upTo": "1.0", "reason": "security"}])).unwrap_err(), ErrorCode::FeedInvalid);
    assert_eq!(with(|v| v["blockInstall"] = json!([{"reason": "security"}])).unwrap_err(), ErrorCode::FeedInvalid);

    let vers = |n: u32| (0..n).map(|i| format!("0.0.{i}")).collect::<Vec<_>>();
    assert_eq!(with(|v| v["withdrawn"] = json!(vers(16))).unwrap().withdrawn.len(), WITHDRAWN_MAX);
    assert_eq!(with(|v| v["withdrawn"] = json!(vers(17))).unwrap_err(), ErrorCode::FeedInvalid);
    assert_eq!(with(|v| v["withdrawn"] = json!(["v0.1.1"])).unwrap_err(), ErrorCode::FeedInvalid);

    assert_eq!(with(|v| v["minFrom"] = json!("0.1.0")).unwrap().min_from, Some(parse_strict("0.1.0").unwrap()));
    assert_eq!(with(|v| v["minFrom"] = json!("0.1")).unwrap_err(), ErrorCode::FeedInvalid);
    assert_eq!(with(|v| v["minFrom"] = json!("0.1.0+b")).unwrap_err(), ErrorCode::FeedInvalid);

    assert_eq!(with(|v| v["floorReset"] = json!(7)).unwrap().floor_reset, Some(7));
    assert_eq!(with(|v| v["floorReset"] = json!(0)).unwrap_err(), ErrorCode::FeedInvalid);
}

#[test]
fn kill_switch_verdicts() {
    let v = |s: &str| parse_strict(s).unwrap();
    let plain = with(|_| {}).unwrap();
    let now = parse_rfc3339("2026-11-01T00:00:00Z").unwrap();
    let ok = plain.verdict(&v("0.1.0"), now);
    assert_eq!((ok.block, ok.withdrawn, ok.too_old_for_direct, ok.stale), (None, false, false, false));

    let blocked = with(|f| f["blockInstall"] = json!([{"upTo": "0.1.0", "reason": "updaterBug"}])).unwrap();
    assert_eq!(blocked.verdict(&v("0.1.0"), now).block, Some(BlockReason::UpdaterBug));
    assert_eq!(blocked.verdict(&v("0.0.9"), now).block, Some(BlockReason::UpdaterBug));
    assert_eq!(blocked.verdict(&v("0.1.0-rc.1"), now).block, Some(BlockReason::UpdaterBug));
    assert_eq!(blocked.verdict(&v("0.1.1"), now).block, None, "only versions <= upTo are blocked");

    let w = with(|f| f["withdrawn"] = json!(["0.1.1"])).unwrap();
    assert!(w.verdict(&v("0.1.0"), now).withdrawn);
    assert!(w.is_withdrawn(&v("0.1.1")));
    assert!(!w.is_withdrawn(&v("0.1.0")));
    let other = with(|f| f["withdrawn"] = json!(["0.1.0"])).unwrap();
    assert!(!other.verdict(&v("0.0.5"), now).withdrawn, "withdrawn names the candidate version");

    let mf = with(|f| f["minFrom"] = json!("0.1.0")).unwrap();
    assert!(mf.verdict(&v("0.0.9"), now).too_old_for_direct);
    assert!(!mf.verdict(&v("0.1.0"), now).too_old_for_direct);

    // validUntil in the past: accepted, flagged stale; never rejects
    assert!(plain.verdict(&v("0.1.0"), parse_rfc3339("2026-12-04T09:00:00Z").unwrap()).stale == false);
    assert!(plain.verdict(&v("0.1.0"), parse_rfc3339("2026-12-04T09:00:01Z").unwrap()).stale);
    let no_valid_until = with(|f| { f.as_object_mut().unwrap().remove("validUntil"); }).unwrap();
    assert!(!no_valid_until.verdict(&v("0.1.0"), i64::MAX).stale);
}

#[test]
fn sequence_rule() {
    use Role::{Feed, FeedStandby};
    let ok = |role, floor, initial, seq, reset| check_seq(role, floor, initial, seq, reset);
    // fresh install: INITIAL_FEED_FLOOR is the floor
    assert_eq!(ok(Feed, None, 5, 5, None).unwrap().new_floor, 5);
    assert_eq!(ok(Feed, None, 5, 4, None).unwrap_err(), ErrorCode::FeedStale);
    assert_eq!(ok(Feed, None, 0, 1, None).unwrap().new_floor, 1);
    // below the floor: stale; equal: accepted; +1000: accepted; +1001: rejected
    assert_eq!(ok(Feed, Some(10), 0, 9, None).unwrap_err(), ErrorCode::FeedStale);
    assert_eq!(ok(Feed, Some(10), 0, 10, None).unwrap().new_floor, 10);
    assert_eq!(ok(Feed, Some(10), 0, 11, None).unwrap().new_floor, 11);
    assert_eq!(ok(Feed, Some(10), 0, 1010, None).unwrap().new_floor, 1010);
    assert_eq!(ok(Feed, Some(10), 0, 1011, None).unwrap_err(), ErrorCode::FeedStale);
    // the compiled-in floor wins over a lower persisted one
    assert_eq!(ok(Feed, Some(3), 8, 7, None).unwrap_err(), ErrorCode::FeedStale);
    // the standby bypasses the floor in both directions and is unlimited upwards
    assert_eq!(ok(FeedStandby, Some(10), 0, 3, None).unwrap().new_floor, 10, "never lowers the floor");
    assert_eq!(ok(FeedStandby, Some(10), 0, 5000, None).unwrap().new_floor, 5000);
    // floorReset is honoured only from the standby, and sets the floor exactly
    assert_eq!(ok(FeedStandby, Some(5000), 0, 6, Some(7)).unwrap().new_floor, 7);
    let ignored = ok(Feed, Some(10), 0, 12, Some(1)).unwrap();
    assert_eq!(ignored.new_floor, 12);
    assert!(ignored.floor_reset_ignored);
    // a stolen Feed key at +1000 leaves the standby room to revoke or reset
    let poisoned = ok(Feed, Some(10), 0, 1010, None).unwrap().new_floor;
    assert_eq!(ok(FeedStandby, Some(poisoned), 0, 11, Some(11)).unwrap().new_floor, 11);
    // an Artifact key never signs a feed
    assert_eq!(ok(Role::Artifact, None, 0, 1, None).unwrap_err(), ErrorCode::FeedSignature);
}

// ----------------------------------------------------------------------------------------------
// endpoints

#[test]
fn constants_and_builders() {
    assert_eq!(endpoints::REPO_SLUG, "ferencfarkas09/IntelyIDE");
    assert_eq!(endpoints::REPO_SLUG, format!("{}/{}", endpoints::REPO_OWNER, endpoints::REPO_NAME));
    let e = Endpoints::production();
    assert_eq!(e.feed_base_count(), 2);
    assert_eq!(e.feed_url(0, Channel::Stable).unwrap(), "https://ferencfarkas09.github.io/IntelyIDE/update/stable.json");
    assert_eq!(e.feed_sig_url(0, Channel::Alpha).unwrap(), "https://ferencfarkas09.github.io/IntelyIDE/update/alpha.json.sig");
    assert_eq!(
        e.feed_url(1, Channel::Stable).unwrap(),
        "https://raw.githubusercontent.com/ferencfarkas09/IntelyIDE/main/site/data/update/stable.json"
    );
    assert_eq!(e.feed_url(2, Channel::Stable), None);
    let v = parse_strict("0.1.1").unwrap();
    assert_eq!(endpoints::artifact_name(&v, Arch::X64), "IntelyIDE_0.1.1_x64.app.tar.gz");
    assert_eq!(endpoints::artifact_name(&v, Arch::Aarch64), "IntelyIDE_0.1.1_aarch64.app.tar.gz");
    assert_eq!(
        e.artifact_url(&v, Arch::Aarch64),
        "https://github.com/ferencfarkas09/IntelyIDE/releases/download/v0.1.1/IntelyIDE_0.1.1_aarch64.app.tar.gz"
    );
    assert_eq!(endpoints::tag_name(&v), "v0.1.1");
    assert!(!e.is_loopback());
}

#[test]
fn production_hop_validation() {
    let e = Endpoints::production();
    let ok = |hop, u: &str| e.validate_hop(hop, u);
    for u in [
        "https://ferencfarkas09.github.io/IntelyIDE/update/stable.json",
        "https://ferencfarkas09.github.io/IntelyIDE/update/alpha.json.sig",
        "https://raw.githubusercontent.com/ferencfarkas09/IntelyIDE/main/site/data/update/stable.json.sig",
    ] {
        assert!(ok(Hop::FeedFirst, u).is_ok(), "{u}");
    }
    for u in [
        "http://ferencfarkas09.github.io/IntelyIDE/update/stable.json",
        "https://ferencfarkas09.github.io/IntelyIDE/update/stable.json?x=1",
        "https://ferencfarkas09.github.io/IntelyIDE/update/stable.json#a",
        "https://ferencfarkas09.github.io:8443/IntelyIDE/update/stable.json",
        "https://ferencfarkas09.github.io:443/IntelyIDE/update/stable.json",
        "https://u@ferencfarkas09.github.io/IntelyIDE/update/stable.json",
        "https://ferencfarkas09.github.io/IntelyIDE/update/beta.json",
        "https://ferencfarkas09.github.io/IntelyIDE/update/../update/stable.json",
        "https://ferencfarkas09.github.io/IntelyIDE//update/stable.json",
        "https://ferencfarkas09.github.io/other/update/stable.json",
        "https://evil.example/IntelyIDE/update/stable.json",
        "https://raw.githubusercontent.com/Other/Repo/main/site/data/update/stable.json",
        "https://127.0.0.1/IntelyIDE/update/stable.json",
        "https://[::1]/IntelyIDE/update/stable.json",
        "http://127.0.0.1:8080/update/stable.json",
        "ftp://ferencfarkas09.github.io/IntelyIDE/update/stable.json",
        "file:///etc/passwd",
        "not a url",
        "",
    ] {
        assert!(ok(Hop::FeedFirst, u).is_err(), "{u:?} must be refused");
    }

    let art = "https://github.com/ferencfarkas09/IntelyIDE/releases/download/v0.1.1/IntelyIDE_0.1.1_x64.app.tar.gz";
    assert!(ok(Hop::ArtifactFirst, art).is_ok());
    for u in [
        "https://github.com/ferencfarkas09/IntelyIDE/releases/download/v0.1.1/x.tar.gz?token=1",
        "https://github.com/ferencfarkas09/IntelyIDE/releases/latest/download/x.tar.gz",
        "https://github.com/Other/Repo/releases/download/v0.1.1/x.tar.gz",
        "https://github.com/ferencfarkas09/IntelyIDE/releases/download/../../../evil/x",
        "https://objects.githubusercontent.com/github-production-release-asset/x",
        "http://github.com/ferencfarkas09/IntelyIDE/releases/download/v0.1.1/x.tar.gz",
        "https://github.com:444/ferencfarkas09/IntelyIDE/releases/download/v0.1.1/x.tar.gz",
        "https://IntelyHome@github.com/ferencfarkas09/IntelyIDE/releases/download/v0.1.1/x.tar.gz",
    ] {
        assert!(ok(Hop::ArtifactFirst, u).is_err(), "{u:?} must be refused");
    }
}

#[test]
fn cdn_redirect_rule() {
    let e = Endpoints::production();
    let r = |u: &str| e.validate_hop(Hop::ArtifactRedirect, u);
    for u in [
        "https://objects.githubusercontent.com/github-production-release-asset/1/abc?X-Amz-Signature=1&b=2",
        "https://release-assets.githubusercontent.com/github-production-release-asset/2",
        "https://a.b.githubusercontent.com/x",
        "https://github.com.githubusercontent.com/x",
    ] {
        assert!(r(u).is_ok(), "{u}");
    }
    // A signed redirect target with a long JWT query is real (verifier finding); the cap is 8 KiB
    // on redirect hops only, 2 KiB elsewhere.
    let long = |n: usize| format!("https://release-assets.githubusercontent.com/github-production-release-asset/2?jwt={}", "a".repeat(n));
    assert!(r(&long(3000)).is_ok());
    assert!(r(&long(8000)).is_ok());
    assert_eq!(r(&long(8200)).unwrap_err(), ErrorCode::BadUrl);
    assert_eq!(e.validate_hop(Hop::ArtifactFirst, &format!("https://github.com{}/{}", "/ferencfarkas09/IntelyIDE/releases/download", "a".repeat(2100))).unwrap_err(), ErrorCode::BadUrl);
    assert_eq!(r("https://evilgithubusercontent.com/x").unwrap_err(), ErrorCode::HostNotAllowed);
    assert_eq!(r("https://githubusercontent.com/x").unwrap_err(), ErrorCode::HostNotAllowed);
    assert_eq!(r("https://x.githubusercontent.com.evil.example/x").unwrap_err(), ErrorCode::HostNotAllowed);
    assert_eq!(r("https://x.githubusercontent.com./x").unwrap_err(), ErrorCode::HostNotAllowed);
    assert_eq!(r("https://evil.example/x").unwrap_err(), ErrorCode::HostNotAllowed);
    assert_eq!(r("https://github.com/ferencfarkas09/IntelyIDE/x").unwrap_err(), ErrorCode::HostNotAllowed);
    assert_eq!(r("https://objects.githubusercontent.com:8443/x").unwrap_err(), ErrorCode::HostNotAllowed);
    assert_eq!(r("https://u:p@objects.githubusercontent.com/x").unwrap_err(), ErrorCode::HostNotAllowed);
    assert_eq!(r("https://127.0.0.1/x").unwrap_err(), ErrorCode::HostNotAllowed);
    assert_eq!(r("https://10.0.0.1/x").unwrap_err(), ErrorCode::HostNotAllowed);
    assert_eq!(r("https://[::1]/x").unwrap_err(), ErrorCode::HostNotAllowed);
    assert_eq!(r("http://objects.githubusercontent.com/x").unwrap_err(), ErrorCode::RedirectRefused);
    assert_eq!(r("https://objects.githubusercontent.com/a/../b").unwrap_err(), ErrorCode::BadUrl);
    assert_eq!(r("https://objects.githubusercontent.com/a#frag").unwrap_err(), ErrorCode::BadUrl);
    assert!(endpoints::is_cdn_host("objects.githubusercontent.com"));
    assert!(!endpoints::is_cdn_host(".githubusercontent.com"));
    assert!(!endpoints::is_cdn_host("a..githubusercontent.com"));
    assert!(!endpoints::is_cdn_host("-a.githubusercontent.com"));
    assert!(!endpoints::is_cdn_host("A.githubusercontent.com"), "host names arrive lower-cased from the url crate");
}

#[test]
fn loopback_endpoints_accept_exactly_one_origin() {
    let e = Endpoints::loopback("http://127.0.0.1:4455").unwrap();
    assert!(e.is_loopback());
    assert_eq!(e.feed_base_count(), 1);
    assert_eq!(e.feed_url(0, Channel::Stable).unwrap(), "http://127.0.0.1:4455/update/stable.json");
    assert_eq!(e.feed_url(1, Channel::Stable), None);
    let v = parse_strict("0.1.1").unwrap();
    assert_eq!(e.artifact_url(&v, Arch::X64), "http://127.0.0.1:4455/releases/download/v0.1.1/IntelyIDE_0.1.1_x64.app.tar.gz");
    assert!(e.validate_hop(Hop::FeedFirst, "http://127.0.0.1:4455/update/stable.json.sig").is_ok());
    assert!(e.validate_hop(Hop::ArtifactFirst, &e.artifact_url(&v, Arch::X64)).is_ok());
    for u in [
        "http://127.0.0.1:4456/update/stable.json",
        "http://localhost:4455/update/stable.json",
        "http://127.0.0.2:4455/update/stable.json",
        "https://127.0.0.1:4455/update/stable.json",
        "http://127.0.0.1:4455/other/stable.json",
        "https://ferencfarkas09.github.io/IntelyIDE/update/stable.json",
    ] {
        assert!(e.validate_hop(Hop::FeedFirst, u).is_err(), "{u}");
    }
    // the production endpoints refuse the loopback origin
    assert!(Endpoints::production().validate_hop(Hop::FeedFirst, "http://127.0.0.1:4455/update/stable.json").is_err());
    for bad in ["http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:99999", "http://127.0.0.1:80/x", "https://127.0.0.1:80", "http://localhost:80", ""] {
        assert!(Endpoints::loopback(bad).is_err(), "{bad:?}");
    }
}

#[derive(serde::Deserialize)]
struct LinkCase {
    url: String,
    ok: bool,
    why: Option<String>,
}

#[test]
fn project_link_table() {
    #[derive(serde::Deserialize)]
    struct Table {
        cases: Vec<LinkCase>,
    }
    let t: Table = serde_json::from_str(&fixture_text("project_links.json")).unwrap();
    assert!(t.cases.len() > 30);
    for c in &t.cases {
        let got = validate_project_link(&c.url).is_some();
        assert_eq!(got, c.ok, "{:?} ({})", c.url, c.why.as_deref().unwrap_or("accepted"));
    }
    // the prefix table the UI mirrors
    assert_eq!(
        endpoints::PROJECT_LINK_PREFIXES,
        [("github.com", "/ferencfarkas09/IntelyIDE/"), ("ferencfarkas09.github.io", "/IntelyIDE/")]
    );
}
