//! Server-free tests of the connection profiles: secrets only in the secret store, safe defaults, the lowering
//! confirmations, the tamper check (outside edit, generic settings write, lost key), the effective-level rule and the
//! redaction canaries.

use std::sync::Arc;

use intely_mongo::api::{AiMode, AiPrefs, Domain, Environment, GlossaryPair, ProfileInput, ReadPreference, SecretKind, SessionSecrets, TlsRelax, UriParse, WireSecret};
use intely_mongo::connspec::{AuthMechanism, ConnSpec, HostPort, ProxySpec, SshSpec, TlsMode, Tunnel, TunnelAuth};
use intely_mongo::audit::{self, AuditLog, AuditRecord};
use intely_mongo::error::code;
use intely_mongo::host;
use intely_mongo::profile::ProfileStore;
use intely_mongo::types::EffectiveLevel;
use intely_settings::{MemorySecretStore, Object, SecretStore, SettingsStore};
use serde_json::{json, Value};

const CANARY: &str = "CANARY-pw-7d41f";

struct Fixture {
    dir: tempfile::TempDir,
    secrets: Arc<MemorySecretStore>,
    settings: Arc<SettingsStore>,
    store: ProfileStore,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecretStore::new());
    let settings = Arc::new(SettingsStore::open(dir.path().join("settings.json")).unwrap());
    let store = ProfileStore::new(settings.clone(), secrets.clone());
    Fixture { dir, secrets, settings, store }
}

fn input(name: &str, env: Environment, uri: &str) -> ProfileInput {
    ProfileInput { name: name.into(), environment: env, uri: Some(uri.into()), ..Default::default() }
}

fn settings_text(f: &Fixture) -> String {
    std::fs::read_to_string(f.dir.path().join("settings.json")).unwrap_or_default()
}

fn reopen(f: &Fixture) -> ProfileStore {
    let settings = Arc::new(SettingsStore::open(f.dir.path().join("settings.json")).unwrap());
    ProfileStore::new(settings, f.secrets.clone())
}

#[test]
fn a_new_profile_is_read_only_with_ai_off_and_the_uri_lives_only_in_the_secret_store() {
    let f = fixture();
    let uri = format!("mongodb://app:{CANARY}@127.0.0.1:27017/intely_test_x?authSource=admin");
    let p = f.store.save(input("Fixture", Environment::Local, &uri)).unwrap();
    assert!(p.safety.read_only && p.safety.ai_mode == AiMode::Off && p.safety.level_override.is_none());
    assert!(p.has_uri);
    // the settings file, the view and every Debug/JSON rendering are free of the credentials
    let view = serde_json::to_string(&p.view()).unwrap();
    let listed = serde_json::to_string(&f.store.list().unwrap().iter().map(|p| p.view()).collect::<Vec<_>>()).unwrap();
    let file = settings_text(&f);
    for text in [&view, &listed, &file, &format!("{p:?}")] {
        assert!(!text.contains(CANARY) && !text.contains("mongodb://"), "{text}");
    }
    assert_eq!(f.store.uri(&p.id).unwrap().unwrap().expose(), uri);
    // the file mode is 0600
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(f.dir.path().join("settings.json")).unwrap().permissions().mode() & 0o777, 0o600);
}

#[test]
fn lowering_a_safety_setting_needs_the_typed_name() {
    let f = fixture();
    let p = f.store.save(input("Sandbox DB", Environment::Sandbox, "mongodb://127.0.0.1/intely_test_x")).unwrap();
    let ask = |patch: &dyn Fn(&mut ProfileInput)| {
        let mut i = input("Sandbox DB", Environment::Sandbox, "");
        i.id = Some(p.id.clone());
        i.uri = None;
        patch(&mut i);
        f.store.save(i)
    };
    assert_eq!(ask(&|i| i.read_only = Some(false)).unwrap_err().code, code::CONFIRM);
    assert_eq!(ask(&|i| i.ai_mode = Some(AiMode::SchemaOnly)).unwrap_err().code, code::CONFIRM);
    assert_eq!(ask(&|i| {
        i.read_only = Some(false);
        i.confirm = Some("sandbox db".into());
    })
    .unwrap_err()
    .code, code::CONFIRM, "the confirmation is exact, case included");
    // nothing changed on the failures
    assert!(f.store.get(&p.id).unwrap().safety.read_only);
    // the exact name lowers; raising never asks
    let lowered = ask(&|i| {
        i.read_only = Some(false);
        i.ai_mode = Some(AiMode::SchemaOnly);
        i.confirm = Some("Sandbox DB".into());
    })
    .unwrap();
    assert!(!lowered.safety.read_only && lowered.safety.ai_mode == AiMode::SchemaOnly);
    let raised = ask(&|i| {
        i.read_only = Some(true);
        i.ai_mode = Some(AiMode::Off);
    })
    .unwrap();
    assert!(raised.safety.read_only && raised.safety.ai_mode == AiMode::Off);
    // an unrelated edit (rename, colour) keeps the safety fields and asks for nothing
    let renamed = ask(&|i| {
        i.name = "Sandbox DB 2".into();
        i.color = Some("#4c8".into());
    })
    .unwrap();
    assert!(renamed.safety.read_only && renamed.name == "Sandbox DB 2");
}

#[test]
fn a_non_loopback_host_is_production_level_whatever_the_tag_says() {
    let f = fixture();
    let p = f.store.save(input("Remote", Environment::Local, &format!("mongodb://u:{CANARY}@db.example.com:27017/app"))).unwrap();
    let v = p.view();
    assert_eq!(v.effective_level, EffectiveLevel::ProductionLevel);
    assert_eq!(v.read_preference, ReadPreference::SecondaryPreferred);
    assert_eq!(v.host, "db***.example.com"); // first three characters of the first label, then the rest
    let srv = f.store.save(input("Atlas", Environment::Sandbox, "mongodb+srv://u:p@cluster0.abcd.mongodb.net/app")).unwrap().view();
    assert_eq!(srv.effective_level, EffectiveLevel::ProductionLevel);
    let local = f.store.save(input("Local", Environment::Local, "mongodb://localhost:27017/intely_test_x")).unwrap().view();
    assert_eq!((local.effective_level, local.read_preference), (EffectiveLevel::Local, ReadPreference::PrimaryPreferred));
    // the Production tag raises a loopback host
    let tagged = f.store.save(input("Tagged", Environment::Production, "mongodb://127.0.0.1/intely_test_x")).unwrap().view();
    assert_eq!(tagged.effective_level, EffectiveLevel::ProductionLevel);
}

#[test]
fn the_level_override_needs_the_typed_host_and_dies_with_a_new_uri() {
    let f = fixture();
    let p = f.store.save(input("Staging", Environment::Sandbox, "mongodb://db.stage.example.com/app")).unwrap();
    let lower = |typed: &str, confirm: Option<&str>| {
        let mut i = input("Staging", Environment::Sandbox, "");
        i.id = Some(p.id.clone());
        i.uri = None;
        i.level_override_host = Some(typed.into());
        i.confirm = confirm.map(str::to_string);
        f.store.save(i)
    };
    assert_eq!(lower("db.other.example.com", Some("Staging")).unwrap_err().code, code::CONFIRM);
    assert_eq!(lower("db.stage.example.com", None).unwrap_err().code, code::CONFIRM, "the name confirmation is still needed");
    let v = lower("DB.stage.example.com", Some("Staging")).unwrap().view();
    assert!(v.level_override);
    assert_eq!(v.effective_level, EffectiveLevel::Local);
    // pasting a URI for another host drops the override
    let mut replace = input("Staging", Environment::Sandbox, "mongodb://db.prod.example.com/app");
    replace.id = Some(p.id.clone());
    let v = f.store.save(replace).unwrap().view();
    assert!(!v.level_override);
    assert_eq!(v.effective_level, EffectiveLevel::ProductionLevel);
    // a loopback connection has nothing to override
    let l = f.store.save(input("L", Environment::Local, "mongodb://127.0.0.1/intely_test_x")).unwrap();
    let mut i = input("L", Environment::Local, "");
    i.id = Some(l.id);
    i.uri = None;
    i.level_override_host = Some("127.0.0.1".into());
    assert_eq!(f.store.save(i).unwrap_err().code, code::INVALID);
}

#[test]
fn an_edit_from_outside_resets_the_safety_fields_and_leaves_a_notice() {
    let f = fixture();
    let p = f.store.save(input("Tamper", Environment::Production, "mongodb://db.example.com/app")).unwrap();
    // an attacker edits the file: read-only off, AI on, tag Local
    let path = f.dir.path().join("settings.json");
    let mut root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let prof = &mut root["mongo"]["profiles"][&p.id];
    prof["safety"]["readOnly"] = json!(false);
    prof["safety"]["aiMode"] = json!("schemaOnly");
    prof["safety"]["environment"] = json!("local");
    std::fs::write(&path, serde_json::to_vec_pretty(&root).unwrap()).unwrap();
    let store = reopen(&f);
    let got = store.list().unwrap().remove(0);
    assert!(got.safety.read_only && got.safety.ai_mode == AiMode::Off && got.safety.environment == Environment::Production, "{got:?}");
    let notices = store.notices();
    assert_eq!(notices.len(), 1);
    assert!(notices[0].message.contains("Tamper") && notices[0].profile_id == p.id);
    // the reset is persisted and signed: a second start is quiet
    let again = reopen(&f);
    assert!(again.list().unwrap()[0].safety.read_only);
    assert!(again.notices().is_empty());
    // an unsigned edit of a harmless field (name) is also caught only if it is signed: the name is not
    let mut root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    root["mongo"]["profiles"][&p.id]["name"] = json!("Renamed outside");
    std::fs::write(&path, serde_json::to_vec_pretty(&root).unwrap()).unwrap();
    assert!(reopen(&f).notices().is_empty());
}

#[test]
fn restoring_an_older_signed_record_is_detected() {
    let f = fixture();
    let p = f.store.save(input("Replay", Environment::Sandbox, "mongodb://127.0.0.1/intely_test_x")).unwrap();
    let edit = |ai: AiMode, ro: bool, env: Environment, confirm: bool| {
        let mut i = input("Replay", env, "");
        i.id = Some(p.id.clone());
        i.uri = None;
        i.ai_mode = Some(ai);
        i.read_only = Some(ro);
        i.confirm = confirm.then(|| "Replay".to_string());
        f.store.save(i).unwrap()
    };
    // the weak state (AI on, read-only off) is saved, and a copy of its signed record is kept by the attacker
    edit(AiMode::SchemaOnly, false, Environment::Sandbox, true);
    let path = f.dir.path().join("settings.json");
    let weak: Value = serde_json::from_str::<Value>(&std::fs::read_to_string(&path).unwrap()).unwrap()["mongo"]["profiles"][&p.id].clone();
    // the user tightens it again
    edit(AiMode::Off, true, Environment::Production, false);
    assert!(f.store.verified(&p.id).unwrap().safety.read_only);
    // the old record goes back into settings.json: its signature is valid, but it is not the newest revision
    let mut root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    root["mongo"]["profiles"][&p.id] = weak;
    std::fs::write(&path, serde_json::to_vec_pretty(&root).unwrap()).unwrap();
    let store = reopen(&f);
    let got = store.verified(&p.id).unwrap();
    assert!(got.safety.read_only && got.safety.ai_mode == AiMode::Off && got.safety.environment == Environment::Production, "{got:?}");
    assert_eq!(store.notices().len(), 1, "a replay leaves the same notice as an edit");
    // and the reset sticks
    assert!(reopen(&f).list().unwrap()[0].safety.read_only);
}

#[test]
fn a_max_time_of_zero_in_the_file_loads_as_the_floor() {
    let f = fixture();
    let p = f.store.save(input("Time", Environment::Sandbox, "mongodb://127.0.0.1/intely_test_x")).unwrap();
    let path = f.dir.path().join("settings.json");
    let mut root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    root["mongo"]["profiles"][&p.id]["maxTimeMs"] = json!(0);
    std::fs::write(&path, serde_json::to_vec_pretty(&root).unwrap()).unwrap();
    assert_eq!(reopen(&f).list().unwrap()[0].view().max_time_ms, 1_000);
    root["mongo"]["profiles"][&p.id]["maxTimeMs"] = json!(4_000_000);
    std::fs::write(&path, serde_json::to_vec_pretty(&root).unwrap()).unwrap();
    assert_eq!(reopen(&f).list().unwrap()[0].view().max_time_ms, 60_000);
}

#[test]
fn the_generic_settings_command_cannot_unlock_a_profile() {
    let f = fixture();
    let settings = Arc::new(SettingsStore::open(f.dir.path().join("settings.json")).unwrap());
    let store = ProfileStore::new(settings.clone(), f.secrets.clone());
    let p = store.save(input("Guarded", Environment::Sandbox, "mongodb://127.0.0.1/intely_test_x")).unwrap();
    assert!(store.verified(&p.id).unwrap().safety.read_only);
    // what `settings_set("mongo", ...)` from the webview would do
    let mut ns = settings.get("mongo").unwrap();
    let mut profiles = ns.remove("profiles").unwrap().as_object().unwrap().clone();
    profiles.get_mut(&p.id).unwrap()["safety"]["readOnly"] = json!(false);
    let mut patch = Object::new();
    patch.insert("profiles".into(), Value::Object(profiles));
    settings.set("mongo", patch).unwrap();
    // the very next verified read (the run path) resets it
    let after = store.verified(&p.id).unwrap();
    assert!(after.safety.read_only && after.safety.environment == Environment::Production);
    assert_eq!(store.notices().len(), 1);
    store.clear_notices();
    assert!(store.notices().is_empty());
}

#[test]
fn a_lost_signing_key_fails_closed() {
    let f = fixture();
    let p = f.store.save(input("KeyLoss", Environment::Sandbox, "mongodb://127.0.0.1/intely_test_x")).unwrap();
    let mut lowered = input("KeyLoss", Environment::Sandbox, "");
    lowered.id = Some(p.id.clone());
    lowered.uri = None;
    lowered.read_only = Some(false);
    lowered.confirm = Some("KeyLoss".into());
    assert!(!f.store.save(lowered).unwrap().safety.read_only);
    // the Keychain item holding the key is gone
    f.secrets.remove("tamper-key").unwrap();
    let store = reopen(&f);
    assert!(store.list().unwrap()[0].safety.read_only);
    assert_eq!(store.notices().len(), 1);
}

#[test]
fn delete_and_duplicate_move_the_secret_with_the_profile() {
    let f = fixture();
    let uri = format!("mongodb://app:{CANARY}@127.0.0.1/intely_test_x");
    let p = f.store.save(input("Orig", Environment::Local, &uri)).unwrap();
    let d = f.store.duplicate(&p.id).unwrap();
    assert_eq!(d.name, "Orig copy");
    assert_eq!(f.store.uri(&d.id).unwrap().unwrap().expose(), uri);
    assert!(!settings_text(&f).contains(CANARY));
    f.store.delete(&p.id).unwrap();
    assert!(f.store.uri(&p.id).unwrap().is_none());
    assert!(f.store.uri(&d.id).unwrap().is_some());
    assert_eq!(f.store.delete(&p.id).unwrap_err().code, code::NOT_FOUND);
    assert!(f.secrets.has(&format!("uri.{}", d.id)).unwrap());
}

#[test]
fn bad_input_is_refused_before_anything_is_stored() {
    let f = fixture();
    assert_eq!(f.store.save(input("", Environment::Local, "mongodb://127.0.0.1/x")).unwrap_err().code, code::INVALID);
    assert_eq!(f.store.save(input("x", Environment::Local, "postgres://u:p@h/x")).unwrap_err().code, code::INVALID);
    let mut no_uri = input("x", Environment::Local, "");
    no_uri.uri = None;
    assert_eq!(f.store.save(no_uri).unwrap_err().code, code::NO_URI);
    let e = f.store.save(input("x", Environment::Local, &format!("postgres://u:{CANARY}@h/x"))).unwrap_err();
    assert!(!e.message.contains(CANARY));
    assert!(f.store.list().unwrap().is_empty());
    // a reload of a never-written store is empty and writes nothing
    assert!(!f.dir.path().join("settings.json").exists());
}

#[test]
fn scrub_removes_credential_fragments_that_are_not_in_a_uri() {
    let uri = format!("mongodb://svc-user:{CANARY}@h1:27017,h2:27017/db?replicaSet=rs");
    let frags = host::credential_fragments(&uri);
    assert!(frags.contains(&CANARY.to_string()) && frags.contains(&"svc-user".to_string()), "{frags:?}");
    for msg in [format!("auth failed for {CANARY}"), format!("user svc-user with password {CANARY} refused"), format!("connect {uri} failed")] {
        let s = host::scrub(&msg, &frags);
        assert!(!s.contains(CANARY) && !s.contains("svc-user:"), "{s}");
    }
    // percent-encoded passwords are caught in both spellings
    let frags = host::credential_fragments("mongodb://u:p%40ss%2Fw0rd@h/x");
    assert!(frags.contains(&"p%40ss%2Fw0rd".to_string()) && frags.contains(&"p@ss/w0rd".to_string()), "{frags:?}");
    assert!(host::credential_fragments("mongodb://127.0.0.1/x").is_empty());
}

#[test]
fn the_audit_line_has_a_shape_and_a_hash_but_no_values() {
    let dir = tempfile::tempdir().unwrap();
    let log = AuditLog::new(dir.path().join("mongo-audit.jsonl"));
    let filter = "{status: 'KIZAROLT-secret', restaurant: ObjectId('65f0c0ffee0000000000abcd'), total: {$gt: 424242}}";
    let shape = audit::filter_shape(&intely_mongo::shell::parse_document(filter, &Default::default()).unwrap());
    let rec = AuditRecord {
        ts: audit::iso_utc(1_790_000_000_000),
        connection_id: "c1".into(),
        environment: "local".into(),
        level: "Local".into(),
        class: "read".into(),
        op: "find".into(),
        db: Some("intely_test_happy".into()),
        collection: Some("orders".into()),
        filter_shape: Some(shape),
        filter_hash: Some(audit::filter_hash("c1", filter)),
        count: Some(3),
        truncated: false,
        origin: "desktop".into(),
        duration_ms: 12,
        outcome: "ok".into(),
    };
    log.append(&rec).unwrap();
    log.append(&rec).unwrap();
    let text = std::fs::read_to_string(log.path()).unwrap();
    assert_eq!(text.lines().count(), 2);
    for lit in ["KIZAROLT", "65f0c0ffee", "424242", "mongodb://"] {
        assert!(!text.contains(lit), "{text}");
    }
    assert!(text.contains("<ObjectId>") && text.contains("\"origin\":\"desktop\"") && text.contains(&audit::filter_hash("c1", filter)));
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(log.path()).unwrap().permissions().mode() & 0o777, 0o600);
}


// ---- v3: structured connections, secrets bundle, identity, review ---------------------------------------------------

const PW: &str = "CANARY-spec-pw-91c2";
const PASSPHRASE: &str = "CANARY-key-pass-55aa";
const SSHPW: &str = "CANARY-ssh-pw-0b3e";

fn spec_for(host: &str) -> ConnSpec {
    let mut s = ConnSpec { hosts: vec![HostPort { host: host.into(), port: Some(27017) }], ..Default::default() };
    s.auth.username = Some("reader".into());
    s.auth.save_password = true;
    s
}

fn sinput(name: &str, env: Environment, spec: ConnSpec) -> ProfileInput {
    ProfileInput { name: name.into(), environment: env, spec: Some(spec), password: Some(WireSecret::new(PW)), ..Default::default() }
}

fn edit_record(f: &Fixture, id: &str, edit: impl FnOnce(&mut Value)) {
    let path = f.dir.path().join("settings.json");
    let mut root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    edit(&mut root["mongo"]["profiles"][id]);
    std::fs::write(&path, serde_json::to_vec_pretty(&root).unwrap()).unwrap();
}

fn resave(f: &Fixture, id: &str, name: &str, env: Environment, spec: ConnSpec) -> ProfileInput {
    let _ = f;
    ProfileInput { id: Some(id.into()), name: name.into(), environment: env, spec: Some(spec), ..Default::default() }
}

#[test]
fn a_spec_profile_signs_v3_and_keeps_secrets_only_in_the_bundle() {
    let f = fixture();
    let p = f.store.save(sinput("Spec", Environment::Sandbox, spec_for("db.example.com"))).unwrap();
    assert!(p.conn.is_some() && !p.has_uri && !p.needs_review && p.secrets.password && p.secrets.identity_matches);
    assert_eq!(p.domain, Domain::Generic);
    // the profile survives a restart and verifies
    let again = reopen(&f).list().unwrap().remove(0);
    assert!(!again.needs_review && again.secrets.password);
    assert!(f.secrets.has(&format!("sec.{}", p.id)).unwrap());
    // nothing secret in the file, the view, Debug output
    let view = p.view();
    assert!(view.has_password && view.spec.is_some() && !view.legacy_uri);
    for text in [settings_text(&f), serde_json::to_string(&view).unwrap(), format!("{p:?}"), format!("{view:?}")] {
        assert!(!text.contains(PW), "{text}");
    }
    // a host with a loopback address saved as fields is Local-level, a remote one is Production-level
    assert_eq!(p.view().effective_level, EffectiveLevel::ProductionLevel);
    let l = f.store.save(sinput("Loop", Environment::Local, spec_for("127.0.0.1"))).unwrap();
    assert_eq!(l.view().effective_level, EffectiveLevel::Local);
}

#[test]
fn uri_and_spec_together_are_invalid_and_a_bad_spec_stores_nothing() {
    let f = fixture();
    let mut both = sinput("Both", Environment::Local, spec_for("127.0.0.1"));
    both.uri = Some("mongodb://127.0.0.1/x".into());
    assert_eq!(f.store.save(both).unwrap_err().code, code::INVALID);
    let mut bad = spec_for("127.0.0.1");
    bad.hosts[0].host = "-oProxyCommand=x".into();
    let e = f.store.save(sinput("Bad", Environment::Local, bad)).unwrap_err();
    assert_eq!(e.code, code::INVALID);
    assert!(e.message.contains("host.invalid"));
    assert!(f.store.list().unwrap().is_empty());
}

#[test]
fn editing_the_connection_outside_the_ide_puts_the_profile_in_review() {
    let f = fixture();
    let p = f.store.save(sinput("Conn", Environment::Sandbox, spec_for("db.example.com"))).unwrap();
    edit_record(&f, &p.id, |r| r["conn"]["hosts"][0]["host"] = json!("evil.example.net"));
    let store = reopen(&f);
    let got = store.list().unwrap().remove(0);
    assert!(got.needs_review, "{got:?}");
    assert!(got.safety.read_only && got.safety.ai_mode == AiMode::Off && got.safety.environment == Environment::Production);
    let n = store.notices();
    assert_eq!(n.len(), 1);
    assert_eq!(n[0].message, "Connection settings of Conn were changed outside the IDE. Review and save them again.");
    // connect and test answer mongoNeedsReview, and a secret is never handed out
    assert_eq!(store.connectable(&p.id).unwrap_err().code, code::NEEDS_REVIEW);
    let spec = got.conn.clone().unwrap();
    assert_eq!(store.resolve_secrets(Some(&p.id), &spec, &SessionSecrets::default()).unwrap_err().code, code::NEEDS_REVIEW);
    // the flag survives a restart and a second quiet start posts no new notice
    let third = reopen(&f);
    assert!(third.list().unwrap()[0].needs_review);
    assert!(third.notices().is_empty());
    // a hostile edit that also removes the flag-bearing fields does not help: the flag lives in the secret store
    edit_record(&f, &p.id, |r| {
        r["conn"]["hosts"][0]["host"] = json!("db.example.com");
    });
    assert!(reopen(&f).list().unwrap()[0].needs_review, "restoring the text does not clear the review state");
    // the profile view says so
    assert!(store.list().unwrap()[0].view().needs_review);
}

#[test]
fn saving_after_review_clears_every_secret_and_re_signs_with_the_safe_state() {
    let f = fixture();
    let p = f.store.save(sinput("Rev", Environment::Sandbox, spec_for("db.example.com"))).unwrap();
    edit_record(&f, &p.id, |r| r["conn"]["hosts"][0]["host"] = json!("evil.example.net"));
    let store = reopen(&f);
    assert!(store.list().unwrap()[0].needs_review);
    // saving without the fields is refused: the reviewed fields must come from the user
    let mut blind = ProfileInput { id: Some(p.id.clone()), name: "Rev".into(), environment: Environment::Sandbox, ..Default::default() };
    assert_eq!(store.save(blind.clone()).unwrap_err().code, code::NEEDS_REVIEW);
    // the user reviews the fields (the host as the form shows it) and saves: no password is supplied
    blind.spec = Some(spec_for("evil.example.net"));
    blind.confirm = Some("Rev".into());
    let saved = store.save(blind).unwrap();
    assert!(!saved.needs_review && !saved.secrets.password, "the old password must not follow a changed destination");
    assert!(!f.secrets.has(&format!("sec.{}", p.id)).unwrap());
    assert!(saved.safety.read_only && saved.safety.ai_mode == AiMode::Off);
    assert!(!reopen(&f).list().unwrap()[0].needs_review);
}

#[test]
fn a_sigv_downgrade_or_a_conn_on_a_legacy_record_is_caught() {
    let f = fixture();
    let p = f.store.save(sinput("Down", Environment::Sandbox, spec_for("db.example.com"))).unwrap();
    // the attacker marks a v3 record as legacy
    edit_record(&f, &p.id, |r| r["sigv"] = json!(2));
    let store = reopen(&f);
    let got = store.list().unwrap().remove(0);
    assert!(got.needs_review || got.safety.read_only, "{got:?}");
    assert!(got.conn.is_none() || got.needs_review, "a legacy record must not carry a conn that blocks nothing");
    // and the same on a legacy profile that gains a `conn` while keeping its v2 signature
    let f2 = fixture();
    let q = f2.store.save(input("Legacy", Environment::Sandbox, "mongodb://127.0.0.1/x")).unwrap();
    edit_record(&f2, &q.id, |r| {
        r["sigv"] = json!(0);
        r["conn"] = json!({"hosts": [{"host": "evil.example.net", "port": 27017}]});
    });
    let g = reopen(&f2).list().unwrap().remove(0);
    assert!(g.needs_review && g.safety.read_only, "{g:?}");
}

#[test]
fn deny_fields_glossary_domain_and_relax_are_signed() {
    let f = fixture();
    let mut i = sinput("Wording", Environment::Sandbox, spec_for("127.0.0.1"));
    i.ai_prefs = Some(AiPrefs { deny_fields: vec!["ssn".into(), "iban".into()], glossary: vec![GlossaryPair { from: "shop".into(), to: "restaurant".into() }] });
    i.domain = Some(Domain::Generic);
    let p = f.store.save(i).unwrap();
    assert_eq!(p.ai_prefs.deny_fields, vec!["ssn", "iban"]);
    assert!(!reopen(&f).list().unwrap()[0].needs_review);
    for (what, edit) in [
        ("deny", Box::new(|r: &mut Value| r["aiPrefs"]["denyFields"] = json!(["ssn"])) as Box<dyn Fn(&mut Value)>),
        ("glossary", Box::new(|r: &mut Value| r["aiPrefs"]["glossary"] = json!([]))),
        ("domain", Box::new(|r: &mut Value| r["domain"] = json!("happy"))),
        ("domain removed", Box::new(|r: &mut Value| { r.as_object_mut().unwrap().remove("domain"); })),
        ("relax", Box::new(|r: &mut Value| r["safety"]["tlsRelax"] = json!("certificates"))),
    ] {
        let g = fixture();
        let mut i = sinput("Wording", Environment::Sandbox, spec_for("127.0.0.1"));
        i.ai_prefs = Some(AiPrefs { deny_fields: vec!["ssn".into(), "iban".into()], glossary: vec![GlossaryPair { from: "shop".into(), to: "restaurant".into() }] });
        let p = g.store.save(i).unwrap();
        edit_record(&g, &p.id, |r| edit(r));
        assert!(reopen(&g).list().unwrap()[0].needs_review, "{what}");
    }
    // removing a deny field needs the typed name
    let mut less = resave(&f, &p.id, "Wording", Environment::Sandbox, spec_for("127.0.0.1"));
    less.ai_prefs = Some(AiPrefs { deny_fields: vec!["ssn".into()], glossary: p.ai_prefs.glossary.clone() });
    assert_eq!(f.store.save(less.clone()).unwrap_err().code, code::CONFIRM);
    less.confirm = Some("Wording".into());
    assert_eq!(f.store.save(less).unwrap().ai_prefs.deny_fields, vec!["ssn"]);
}

#[test]
fn new_profiles_name_their_preset() {
    let f = fixture();
    let p = f.store.save(input("Old", Environment::Sandbox, "mongodb://127.0.0.1/x")).unwrap();
    assert_eq!(p.domain, Domain::Generic, "a profile saved by this build names its preset");
    let q = f.store.save(sinput("New", Environment::Sandbox, spec_for("127.0.0.1"))).unwrap();
    assert_eq!(q.domain, Domain::Generic);
    let mut h = sinput("Hap", Environment::Sandbox, spec_for("127.0.0.1"));
    h.domain = Some(Domain::Happy);
    let err = f.store.save(h.clone()).unwrap_err();
    assert!(err.code == code::INVALID && err.message.starts_with("config.happyPresetOff"), "the switch is off: {err}");
    set_happy_switch(&f, true);
    assert_eq!(f.store.save(h).unwrap().domain, Domain::Happy);
}

fn set_happy_switch(f: &Fixture, on: bool) {
    let mut patch = Object::new();
    patch.insert("happyPreset".into(), Value::Bool(on));
    f.settings.set("mongo", patch).unwrap();
}

/// Writes the switch through a fresh handle on the file (what a restart sees).
fn write_happy_switch(f: &Fixture, on: bool) {
    let mut patch = Object::new();
    patch.insert("happyPreset".into(), Value::Bool(on));
    SettingsStore::open(f.dir.path().join("settings.json")).unwrap().set("mongo", patch).unwrap();
}

#[test]
fn the_rust_side_refuses_the_happy_preset_while_its_switch_is_off_but_keeps_an_existing_happy_profile() {
    let f = fixture();
    set_happy_switch(&f, true);
    let mut h = sinput("Hap", Environment::Sandbox, spec_for("127.0.0.1"));
    h.domain = Some(Domain::Happy);
    let hap = f.store.save(h).unwrap();
    let generic = f.store.save(sinput("Gen", Environment::Sandbox, spec_for("127.0.0.1"))).unwrap();
    // with the switch on a Happy profile can be copied (the copy is removed again: the counts below are of two profiles)
    let copy = f.store.duplicate(&hap.id).unwrap();
    assert_eq!(copy.domain, Domain::Happy);
    f.store.delete(&copy.id).unwrap();
    set_happy_switch(&f, false);
    let store = reopen(&f);
    // an existing Happy profile can be edited and keeps its preset
    let mut keep = resave(&f, &hap.id, "Hap", Environment::Sandbox, spec_for("127.0.0.1"));
    keep.max_time_ms = Some(20_000);
    assert_eq!(store.save(keep).unwrap().domain, Domain::Happy);
    // a new profile, or a generic one switched over, is refused
    let mut new = sinput("Hap2", Environment::Sandbox, spec_for("127.0.0.1"));
    new.domain = Some(Domain::Happy);
    assert_eq!(store.save(new).unwrap_err().code, code::INVALID);
    let mut over = resave(&f, &generic.id, "Gen", Environment::Sandbox, spec_for("127.0.0.1"));
    over.domain = Some(Domain::Happy);
    assert_eq!(store.save(over).unwrap_err().code, code::INVALID);
    // a copy of a Happy profile is a new Happy profile: refused as well, a copy of a generic one is fine
    let e = store.duplicate(&hap.id).unwrap_err();
    assert!(e.code == code::INVALID && e.message.starts_with("config.happyPresetOff"), "{e}");
    assert_eq!(store.list().unwrap().len(), 2, "nothing was added or changed");
    assert_eq!(store.duplicate(&generic.id).unwrap().domain, Domain::Generic);
    assert_eq!(store.list().unwrap().len(), 3);
    // generic stays possible, and the missing field means generic
    assert_eq!(store.save(sinput("Gen2", Environment::Sandbox, spec_for("127.0.0.1"))).unwrap().domain, Domain::Generic);
}

#[test]
fn upgrading_turns_the_happy_switch_on_once_when_profiles_exist_and_never_for_a_fresh_install() {
    // upgrade: profiles exist, the switch was never written
    let f = fixture();
    f.store.save(input("Old", Environment::Sandbox, "mongodb://127.0.0.1/x")).unwrap();
    assert!(!f.store.happy_preset());
    assert!(reopen(&f).migrate_happy_preset().unwrap(), "D26: on");
    assert!(reopen(&f).happy_preset());
    // once: the user turns it off, a second start leaves it off
    write_happy_switch(&f, false);
    assert!(!reopen(&f).migrate_happy_preset().unwrap());
    assert!(!reopen(&f).happy_preset());
    // fresh install: nothing flips, and a profile created later does not trigger it either
    let g = fixture();
    assert!(!g.store.migrate_happy_preset().unwrap());
    g.store.save(input("New", Environment::Sandbox, "mongodb://127.0.0.1/x")).unwrap();
    assert!(!reopen(&g).migrate_happy_preset().unwrap());
    assert!(!reopen(&g).happy_preset());
    // a switch the user already set is respected
    let h = fixture();
    h.store.save(input("Old", Environment::Sandbox, "mongodb://127.0.0.1/x")).unwrap();
    write_happy_switch(&h, false);
    assert!(!reopen(&h).migrate_happy_preset().unwrap());
    assert!(!reopen(&h).happy_preset());
}

#[test]
fn convert_a_legacy_profile_to_fields_moves_the_secret_and_removes_the_uri() {
    let f = fixture();
    let uri = format!("mongodb://reader:{PW}@db.example.com:27017/app");
    let p = f.store.save(input("Legacy", Environment::Sandbox, &uri)).unwrap();
    assert!(p.has_uri && p.view().legacy_uri);
    // the convert draft (built by the parser in T2): fields + the password the string carried
    let mut c = resave(&f, &p.id, "Legacy", Environment::Sandbox, spec_for("db.example.com"));
    c.password = Some(WireSecret::new(PW));
    let q = f.store.save(c).unwrap();
    assert!(!q.has_uri && q.conn.is_some() && q.secrets.password);
    assert!(!f.secrets.has(&format!("uri.{}", p.id)).unwrap(), "the legacy account is gone");
    assert!(f.secrets.has(&format!("sec.{}", p.id)).unwrap());
    assert!(!q.view().legacy_uri && q.view().has_uri);
    // a pasted string over a profile that already has fields is refused
    let mut paste = input("Legacy", Environment::Sandbox, "mongodb://127.0.0.1/x");
    paste.id = Some(p.id.clone());
    assert_eq!(f.store.save(paste).unwrap_err().code, code::INVALID);
}

#[test]
fn delete_leaves_no_account_behind() {
    let f = fixture();
    let mut spec = spec_for("db.example.com");
    spec.tls.save_key_password = true;
    let mut i = sinput("Del", Environment::Sandbox, spec);
    i.key_password = Some(WireSecret::new(PASSPHRASE));
    let p = f.store.save(i).unwrap();
    let legacy = f.store.save(input("DelLegacy", Environment::Local, "mongodb://127.0.0.1/x")).unwrap();
    f.store.delete(&p.id).unwrap();
    f.store.delete(&legacy.id).unwrap();
    for id in [&p.id, &legacy.id] {
        for k in ["uri", "sec", "rev"] {
            assert!(!f.secrets.has(&format!("{k}.{id}")).unwrap(), "{k}.{id} survived the delete");
        }
    }
}

#[test]
fn replaying_an_older_v3_record_puts_the_profile_in_review() {
    let f = fixture();
    let p = f.store.save(sinput("Replay3", Environment::Sandbox, spec_for("127.0.0.1"))).unwrap();
    let path = f.dir.path().join("settings.json");
    let old: Value = serde_json::from_str::<Value>(&std::fs::read_to_string(&path).unwrap()).unwrap()["mongo"]["profiles"][&p.id].clone();
    let mut again = resave(&f, &p.id, "Replay3", Environment::Sandbox, spec_for("127.0.0.1"));
    again.max_time_ms = Some(30_000);
    f.store.save(again).unwrap();
    edit_record(&f, &p.id, |r| *r = old);
    let store = reopen(&f);
    assert!(store.list().unwrap()[0].needs_review);
    assert_eq!(store.notices().len(), 1);
}

#[test]
fn a_changed_identity_clears_or_refuses_the_stored_secrets() {
    type Change = Box<dyn Fn(&mut ConnSpec)>;
    let changes: Vec<(&str, Change)> = vec![
        ("host", Box::new(|s: &mut ConnSpec| s.hosts[0].host = "other.example.com".into())),
        ("port", Box::new(|s: &mut ConnSpec| s.hosts[0].port = Some(27018))),
        ("mechanism", Box::new(|s: &mut ConnSpec| s.auth.mechanism = AuthMechanism::ScramSha256)),
        ("username", Box::new(|s: &mut ConnSpec| s.auth.username = Some("admin".into()))),
        ("tls mode", Box::new(|s: &mut ConnSpec| s.tls.mode = TlsMode::On)),
        ("tunnel host", Box::new(|s: &mut ConnSpec| s.tunnel = Tunnel::Ssh(SshSpec { host: "evil-bastion".into(), user: "u".into(), ..Default::default() }))),
        ("proxy", Box::new(|s: &mut ConnSpec| s.tunnel = Tunnel::Socks5(ProxySpec { host: "127.0.0.1".into(), port: 1080, ..Default::default() }))),
    ];
    for (what, change) in changes {
        let f = fixture();
        let p = f.store.save(sinput("Ident", Environment::Sandbox, spec_for("db.example.com"))).unwrap();
        assert!(p.secrets.password);
        let mut changed = spec_for("db.example.com");
        change(&mut changed);
        // test / connect path: the stored password is not handed to the changed destination
        let e = f.store.resolve_secrets(Some(&p.id), &changed, &SessionSecrets::default()).unwrap_err();
        assert_eq!((e.code, e.message.as_str()), (code::NEED_SECRET, "needs:password"), "{what}");
        // a fresh value is used
        let fresh = SessionSecrets { password: Some(WireSecret::new("typed-now")), ..Default::default() };
        assert_eq!(f.store.resolve_secrets(Some(&p.id), &changed, &fresh).unwrap().password.unwrap().expose(), "typed-now", "{what}");
        // save path: the secret is cleared, not carried over
        let saved = f.store.save(resave(&f, &p.id, "Ident", Environment::Sandbox, changed)).unwrap();
        assert!(!saved.secrets.password, "{what}");
        assert!(!f.secrets.has(&format!("sec.{}", p.id)).unwrap(), "{what}");
    }
    // an unchanged identity keeps the secret across a save and an unrelated edit
    let f = fixture();
    let p = f.store.save(sinput("Same", Environment::Sandbox, spec_for("db.example.com"))).unwrap();
    let mut s = spec_for("db.example.com");
    s.database = Some("other".into());
    let saved = f.store.save(resave(&f, &p.id, "Same", Environment::Sandbox, s.clone())).unwrap();
    assert!(saved.secrets.password);
    assert_eq!(f.store.resolve_secrets(Some(&p.id), &s, &SessionSecrets::default()).unwrap().password.unwrap().expose(), PW);
}

#[test]
fn secrets_with_the_save_switch_off_are_never_written_and_an_empty_value_clears() {
    let f = fixture();
    let mut s = spec_for("db.example.com");
    s.auth.save_password = false;
    let p = f.store.save(sinput("NoSave", Environment::Sandbox, s.clone())).unwrap();
    assert!(!p.secrets.password && !f.secrets.has(&format!("sec.{}", p.id)).unwrap());
    // connect asks for it
    assert_eq!(f.store.resolve_secrets(Some(&p.id), &s, &SessionSecrets::default()).unwrap_err().message, "needs:password");
    // set_secret refuses while the switch is off
    assert_eq!(f.store.set_secret(&p.id, SecretKind::Password, Some(WireSecret::new(PW))).unwrap_err().code, code::INVALID);
    // with the switch on, set and clear work and read back is impossible
    let mut on = s.clone();
    on.auth.save_password = true;
    f.store.save(resave(&f, &p.id, "NoSave", Environment::Sandbox, on)).unwrap();
    assert!(f.store.set_secret(&p.id, SecretKind::Password, Some(WireSecret::new(PW))).unwrap().secrets.password);
    assert!(!f.store.set_secret(&p.id, SecretKind::Password, None).unwrap().secrets.password);
    let mut clear = resave(&f, &p.id, "NoSave", Environment::Sandbox, f.store.get(&p.id).unwrap().conn.unwrap());
    clear.password = Some(WireSecret::new(PW));
    assert!(f.store.save(clear).unwrap().secrets.password);
    let mut empty = resave(&f, &p.id, "NoSave", Environment::Sandbox, f.store.get(&p.id).unwrap().conn.unwrap());
    empty.password = Some(WireSecret::new(""));
    assert!(!f.store.save(empty).unwrap().secrets.password);
}

#[test]
fn the_ssh_and_proxy_secrets_are_required_and_bundled() {
    let f = fixture();
    let mut s = spec_for("db.internal");
    s.auth.username = None;
    s.tunnel = Tunnel::Ssh(SshSpec { host: "bastion.example.com".into(), user: "ops".into(), auth: TunnelAuth::Password, save_secret: true, ..Default::default() });
    let mut i = sinput("Tun", Environment::Sandbox, s.clone());
    i.ssh_secret = Some(WireSecret::new(SSHPW));
    i.password = None;
    let p = f.store.save(i).unwrap();
    assert!(p.secrets.ssh_secret && !p.secrets.password);
    assert_eq!(p.view().effective_level, EffectiveLevel::ProductionLevel, "any tunnel is Production-level");
    assert_eq!(p.remote_host.as_deref(), Some("bastion.example.com"));
    let got = f.store.resolve_secrets(Some(&p.id), &s, &SessionSecrets::default()).unwrap();
    assert_eq!(got.ssh_secret.unwrap().expose(), SSHPW);
    // one Keychain item per profile
    assert!(f.secrets.has(&format!("sec.{}", p.id)).unwrap());
    assert!(!settings_text(&f).contains(SSHPW));
    // a proxy with a user needs its password
    let mut px = spec_for("db.internal");
    px.auth.username = None;
    px.tunnel = Tunnel::Socks5(ProxySpec { host: "127.0.0.1".into(), port: 1080, username: Some("pu".into()), save_password: false });
    let q = f.store.save(ProfileInput { name: "Prox".into(), environment: Environment::Sandbox, spec: Some(px.clone()), ..Default::default() }).unwrap();
    assert_eq!(f.store.resolve_secrets(Some(&q.id), &px, &SessionSecrets::default()).unwrap_err().message, "needs:proxyPassword");
}

#[test]
fn relaxed_tls_needs_the_typed_name_and_is_refused_on_a_production_level_connection() {
    let f = fixture();
    // refused at the effective level, whatever the tag
    let mut remote = sinput("Relax", Environment::Sandbox, spec_for("db.example.com"));
    remote.tls_relax = Some(TlsRelax::Certificates);
    remote.confirm = Some("Relax".into());
    let e = f.store.save(remote).unwrap_err();
    assert!(e.message.contains("config.tlsRelaxRefused"), "{e}");
    let mut tagged = sinput("Relax", Environment::Production, spec_for("127.0.0.1"));
    tagged.tls_relax = Some(TlsRelax::Certificates);
    tagged.confirm = Some("Relax".into());
    assert!(f.store.save(tagged).unwrap_err().message.contains("tlsRelaxRefused"));
    // allowed on a local connection, but only with the typed confirmation
    let mut local = sinput("Relax", Environment::Local, spec_for("127.0.0.1"));
    local.tls_relax = Some(TlsRelax::Certificates);
    assert_eq!(f.store.save(local.clone()).unwrap_err().code, code::CONFIRM);
    local.confirm = Some("Relax".into());
    let p = f.store.save(local).unwrap();
    assert_eq!(p.safety.tls_relax, TlsRelax::Certificates);
    assert_eq!(p.view().tls_relax, TlsRelax::Certificates);
    // a tunnel is Production-level: relaxed checks are refused there too
    let mut s = spec_for("127.0.0.1");
    s.tunnel = Tunnel::Ssh(SshSpec { host: "b".into(), user: "u".into(), ..Default::default() });
    let mut t = sinput("Relax2", Environment::Local, s);
    t.tls_relax = Some(TlsRelax::Certificates);
    t.confirm = Some("Relax2".into());
    assert!(f.store.save(t).unwrap_err().message.contains("tlsRelaxRefused"));
}

#[test]
fn the_typed_host_override_of_a_tunnel_is_the_bastion() {
    let f = fixture();
    let mut s = spec_for("127.0.0.1");
    s.tunnel = Tunnel::Ssh(SshSpec { host: "bastion.example.com".into(), user: "u".into(), ..Default::default() });
    let mut i = sinput("TunOv", Environment::Sandbox, s);
    i.level_override_host = Some("db.example.com".into());
    i.confirm = Some("TunOv".into());
    assert_eq!(f.store.save(i.clone()).unwrap_err().code, code::CONFIRM, "the wrong host does not lower it");
    i.level_override_host = Some("Bastion.Example.com".into());
    let p = f.store.save(i).unwrap();
    assert_eq!(p.view().effective_level, EffectiveLevel::Local);
}

#[test]
fn a_secret_never_appears_in_debug_or_json_of_the_input_types() {
    let mut i = sinput("Canary", Environment::Sandbox, spec_for("db.example.com"));
    i.key_password = Some(WireSecret::new(PASSPHRASE));
    i.ssh_secret = Some(WireSecret::new(SSHPW));
    i.proxy_password = Some(WireSecret::new("CANARY-proxy-1"));
    i.uri = Some(format!("mongodb://u:{PW}@h/x").into());
    i.spec = None;
    let secrets = SessionSecrets { password: Some(WireSecret::new(PW)), ssh_secret: Some(WireSecret::new(SSHPW)), key_password: Some(WireSecret::new(PASSPHRASE)), proxy_password: Some(WireSecret::new("CANARY-proxy-1")) };
    let parse = UriParse { spec: spec_for("h"), has_password: true, has_key_password: false, draft: Some("tok".into()), warnings: vec![], unsupported: vec![] };
    for text in [format!("{i:?}"), format!("{i:#?}"), format!("{secrets:?}"), format!("{:?}", secrets.password), format!("{parse:?}"), serde_json::to_string(&i).unwrap(), serde_json::to_string(&secrets).unwrap()] {
        for c in [PW, PASSPHRASE, SSHPW, "CANARY-proxy-1"] {
            assert!(!text.contains(c), "{c} in {text}");
        }
    }
    // the wire shape still accepts them on the way in
    let back: ProfileInput = serde_json::from_value(json!({"name": "n", "environment": "local", "password": "x", "keyPassword": "y"})).unwrap();
    assert_eq!(back.password.unwrap().expose(), "x");
    assert!(serde_json::from_value::<ProfileInput>(json!({"name": "n", "environment": "local", "bogus": 1})).is_err());
}

#[test]
fn meta_edits_are_cosmetic_and_do_not_resign_or_need_confirmation() {
    use intely_mongo::api::ProfileMeta;
    let f = fixture();
    let p = f.store.save(sinput("Meta", Environment::Production, spec_for("db.example.com"))).unwrap();
    let q = f.store.set_meta(&p.id, ProfileMeta { group: Some("Acme".into()), favorite: Some(true), color: Some("#5b8def".into()) }).unwrap();
    assert_eq!((q.group.as_deref(), q.favorite, q.color.as_str()), (Some("Acme"), true, "#5b8def"));
    let again = reopen(&f).list().unwrap().remove(0);
    assert!(!again.needs_review && again.group.as_deref() == Some("Acme") && again.favorite);
    assert!(f.store.set_meta(&p.id, ProfileMeta { group: Some("x".repeat(41)), ..Default::default() }).is_err());
    let cleared = f.store.set_meta(&p.id, ProfileMeta { group: Some(String::new()), ..Default::default() }).unwrap();
    assert!(cleared.group.is_none());
    assert_eq!(f.store.set_meta("nope", ProfileMeta::default()).unwrap_err().code, code::NOT_FOUND);
}

#[test]
fn duplicate_of_a_spec_profile_copies_the_bundle_but_a_reviewed_one_cannot_be_copied() {
    let f = fixture();
    let p = f.store.save(sinput("Dup", Environment::Sandbox, spec_for("db.example.com"))).unwrap();
    let d = f.store.duplicate(&p.id).unwrap();
    assert!(d.conn.is_some() && d.secrets.password && !d.needs_review);
    assert!(!reopen(&f).list().unwrap().iter().any(|x| x.needs_review));
    edit_record(&f, &p.id, |r| r["conn"]["hosts"][0]["host"] = json!("evil.example.net"));
    assert_eq!(reopen(&f).duplicate(&p.id).unwrap_err().code, code::NEEDS_REVIEW);
}

#[test]
fn secrets_status_reports_the_store_and_the_flags() {
    let f = fixture();
    let st = f.store.secrets_status(None).unwrap();
    assert_eq!(st.store, intely_mongo::api::SecretStoreKind::Session, "the in-memory store is session-only");
    let p = f.store.save(sinput("St", Environment::Sandbox, spec_for("db.example.com"))).unwrap();
    let st = f.store.secrets_status(Some(&p.id)).unwrap();
    assert!(st.has_password && st.identity_matches && !st.has_ssh_secret);
}

#[test]
fn explicit_read_preferences_reach_the_view() {
    let f = fixture();
    let mut s = spec_for("db.example.com");
    s.topology.read_preference = intely_mongo::connspec::ReadPrefMode::Nearest;
    let p = f.store.save(sinput("RP", Environment::Sandbox, s)).unwrap();
    assert_eq!(p.view().read_preference, ReadPreference::Nearest);
    assert!(p.view().read_preference.secondary_ok());
    let auto = f.store.save(sinput("RP2", Environment::Sandbox, spec_for("db.example.com"))).unwrap();
    assert_eq!(auto.view().read_preference, ReadPreference::SecondaryPreferred, "Auto keeps the rule by level");
}
