//! Profile export and import (T5): the export document carries no secret and none of the forbidden keys; the importer
//! is strict (caps, unknown fields, hostile hosts and paths, special files) and hardens everything it accepts; errors
//! name a line and a code, never input text. No Docker, no network: fakes and temp directories only.

use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use intely_mongo::api::{AiMode, AiPrefs, Domain, Environment, GlossaryPair, ProfileInput, TlsRelax, WireSecret};
use intely_mongo::connspec::{AuthMechanism, ConnSpec, HostPort, ProxySpec, SshSpec, TlsMode, Tunnel, TunnelAuth};
use intely_mongo::connstring::{Parsed, ParsedSecrets};
use intely_mongo::error::{code, StudioError};
use intely_mongo::exchange::{self, ExportOptions, FileKind, FileSource, ImportOptions, OpenedFile, OsFiles};
use intely_mongo::profile::{Profile, ProfileStore};
use intely_settings::{MemorySecretStore, Secret, SettingsStore};
use serde_json::{json, Value};

const CANARY: &str = "CANARY-pw-91c3e";

fn store() -> (tempfile::TempDir, ProfileStore) {
    let dir = tempfile::tempdir().unwrap();
    let settings = Arc::new(SettingsStore::open(dir.path().join("settings.json")).unwrap());
    (dir, ProfileStore::new(settings, Arc::new(MemorySecretStore::new())))
}

fn host(h: &str, p: u16) -> HostPort {
    HostPort { host: h.into(), port: Some(p) }
}

fn spec_remote() -> ConnSpec {
    let mut s = ConnSpec { hosts: vec![host("db1.example.com", 27017)], database: Some("app".into()), ..Default::default() };
    s.auth.username = Some("reader".into());
    s.auth.save_password = true;
    s.tls.mode = TlsMode::On;
    s.tls.ca_file = Some("/etc/ssl/ca.pem".into());
    s.tls.client_cert_file = Some("/etc/ssl/client.pem".into());
    s
}

fn spec_tunnel() -> ConnSpec {
    let mut s = spec_remote();
    s.tunnel = Tunnel::Ssh(SshSpec {
        host: "bastion.example.com".into(),
        user: "ops".into(),
        auth: TunnelAuth::KeyFile,
        key_file: Some("/Users/me/.ssh/id_ed25519".into()),
        save_secret: true,
        allowed_hosts: vec![intely_mongo::connspec::AllowedHost { host: "db2.example.com".into(), port: 27017 }],
        ..Default::default()
    });
    s
}

fn save(st: &ProfileStore, name: &str, spec: ConnSpec) -> Profile {
    st.save(ProfileInput {
        name: name.into(),
        environment: Environment::Production,
        spec: Some(spec),
        password: Some(WireSecret::new(CANARY)),
        key_password: Some(WireSecret::new(CANARY)),
        ssh_secret: Some(WireSecret::new(CANARY)),
        proxy_password: Some(WireSecret::new(CANARY)),
        group: Some("Acme".into()),
        favorite: Some(true),
        ..Default::default()
    })
    .unwrap()
}

fn all(st: &ProfileStore) -> Vec<Profile> {
    st.list().unwrap()
}

fn file_spec() -> Value {
    json!({ "scheme": "standard", "hosts": [{ "host": "db1.example.com", "port": 27017 }], "database": "app",
            "auth": { "mechanism": "default", "username": "reader", "source": "admin", "savePassword": true },
            "tls": { "mode": "on", "caFile": null, "clientCertFile": null, "saveKeyPassword": false },
            "topology": { "replicaSet": "rs0", "directConnection": null, "readPreference": "auto", "maxStalenessS": null },
            "compressors": ["zlib"], "timeouts": {}, "appName": null, "extra": [], "tunnel": { "kind": "none" } })
}

fn file_profile(name: &str, spec: Value) -> Value {
    json!({ "name": name, "color": "#5b8def", "environment": "sandbox", "group": "Acme", "favorite": true, "domain": "generic",
            "tenantLock": null, "aiPrefs": { "denyFields": ["ssn"], "glossary": [] }, "spec": spec,
            "secrets": { "password": "needed", "keyPassword": "none", "sshSecret": "none", "proxyPassword": "none" } })
}

fn file(profiles: Vec<Value>) -> Vec<u8> {
    json!({ "format": "intely-mongo-profiles", "version": 1, "profiles": profiles }).to_string().into_bytes()
}

fn import(profiles: Vec<Value>) -> (intely_mongo::api::ImportPreview, Vec<ProfileInput>) {
    exchange::import_preview(&file(profiles)).unwrap()
}

// ---- export -------------------------------------------------------------------------------------------------------

#[test]
fn export_has_no_secret_and_none_of_the_forbidden_keys() {
    let (_d, st) = store();
    save(&st, "Acme remote", spec_remote());
    save(&st, "Acme bastion", spec_tunnel());
    let mut sp = spec_remote();
    sp.tunnel = Tunnel::Socks5(ProxySpec { host: "proxy.example.com".into(), port: 1080, username: Some("px".into()), save_password: true });
    save(&st, "Acme proxy", sp);
    for opts in [ExportOptions::default(), ExportOptions { include_tunnel: true, include_paths: true }] {
        let doc = exchange::export_document(&all(&st), opts).unwrap();
        assert!(!doc.contains(CANARY));
        let v: Value = serde_json::from_str(&doc).unwrap();
        assert_eq!(v["format"], "intely-mongo-profiles");
        assert_eq!(v["version"], 1);
        for key in ["\"uri\"", "\"sig\"", "\"sigv\"", "\"rev\"", "\"confirm\"", "\"levelOverride\"", "\"tlsRelax\"", "\"hostLevel\"", "\"remoteHost\""] {
            assert!(!doc.contains(key), "forbidden key {key}");
        }
        for p in v["profiles"].as_array().unwrap() {
            for (_, need) in p["secrets"].as_object().unwrap() {
                assert!(need == "needed" || need == "none");
            }
        }
    }
}

#[test]
fn export_strips_paths_and_tunnel_unless_asked() {
    let (_d, st) = store();
    save(&st, "Bastion", spec_tunnel());
    let plain: Value = serde_json::from_str(&exchange::export_document(&all(&st), ExportOptions::default()).unwrap()).unwrap();
    let s = &plain["profiles"][0]["spec"];
    assert_eq!(s["tunnel"]["kind"], "none");
    assert!(s["tls"]["caFile"].is_null() && s["tls"]["clientCertFile"].is_null());
    assert_eq!(plain["profiles"][0]["secrets"]["sshSecret"], "needed");
    assert_eq!(plain["profiles"][0]["secrets"]["keyPassword"], "needed");

    let tunnel_only: Value = serde_json::from_str(&exchange::export_document(&all(&st), ExportOptions { include_tunnel: true, include_paths: false }).unwrap()).unwrap();
    let s = &tunnel_only["profiles"][0]["spec"];
    assert_eq!(s["tunnel"]["kind"], "ssh");
    assert!(s["tunnel"]["keyFile"].is_null() && s["tls"]["caFile"].is_null());

    let full: Value = serde_json::from_str(&exchange::export_document(&all(&st), ExportOptions { include_tunnel: true, include_paths: true }).unwrap()).unwrap();
    assert_eq!(full["profiles"][0]["spec"]["tls"]["caFile"], "/etc/ssl/ca.pem");
    assert_eq!(full["profiles"][0]["spec"]["tunnel"]["keyFile"], "/Users/me/.ssh/id_ed25519");
}

#[test]
fn export_skips_legacy_and_unreviewed_profiles_and_refuses_an_empty_document() {
    let (_d, st) = store();
    st.save(ProfileInput { name: "Legacy".into(), uri: Some("mongodb://127.0.0.1:27017/x".into()), ..Default::default() }).unwrap();
    let legacy = all(&st);
    assert!(!exchange::exportable(&legacy[0]));
    let e = exchange::export_document(&legacy, ExportOptions::default()).unwrap_err();
    assert_eq!(e.code, code::IMPORT);
    save(&st, "Real", spec_remote());
    let v: Value = serde_json::from_str(&exchange::export_document(&all(&st), ExportOptions::default()).unwrap()).unwrap();
    assert_eq!(v["profiles"].as_array().unwrap().len(), 1);
    let mut p = all(&st).into_iter().find(|p| p.name == "Real").unwrap();
    p.needs_review = true;
    assert!(!exchange::exportable(&p));
}

#[test]
fn an_export_imports_back_hardened() {
    let (_d, st) = store();
    save(&st, "Acme remote", spec_remote());
    save(&st, "Acme bastion", spec_tunnel());
    let doc = exchange::export_document(&all(&st), ExportOptions { include_tunnel: true, include_paths: true }).unwrap();
    let (preview, inputs) = exchange::import_preview(doc.as_bytes()).unwrap();
    assert_eq!(preview.items.len(), 2);
    assert_eq!(inputs.len(), 2);
    for i in &inputs {
        assert_eq!(i.read_only, Some(true));
        assert_eq!(i.ai_mode, Some(AiMode::Off));
        assert_eq!(i.tls_relax, Some(TlsRelax::None));
        assert!(i.level_override_host.is_none() && i.confirm.is_none() && i.uri.is_none() && i.id.is_none());
        assert!(i.password.is_none() && i.ssh_secret.is_none() && i.key_password.is_none() && i.proxy_password.is_none());
        assert_eq!(i.environment, Environment::Production);
        assert_eq!(i.group.as_deref(), Some("Acme"));
        assert_eq!(i.favorite, Some(true));
    }
    let (_d2, st2) = store();
    for i in inputs {
        st2.save(i).unwrap();
    }
    assert_eq!(st2.list().unwrap().len(), 2);
}

// ---- import policy ------------------------------------------------------------------------------------------------

#[test]
fn a_loopback_profile_keeps_its_tag_and_a_remote_or_reaching_one_is_never_below_production() {
    let mut local = file_spec();
    local["hosts"] = json!([{ "host": "127.0.0.1", "port": 27017 }]);
    local["tls"]["mode"] = json!("off");
    local["auth"]["mechanism"] = json!("none");
    let (_, i) = import(vec![file_profile("Local", local.clone())]);
    assert_eq!(i[0].environment, Environment::Production);

    local["tls"]["mode"] = json!("auto");
    let (p, i) = import(vec![file_profile("Local", local.clone())]);
    assert_eq!(i[0].environment, Environment::Sandbox, "plain loopback keeps the file's tag");
    assert!(!p.items[0].needs_confirm);

    let mut missing_tag = file_profile("No tag", local);
    missing_tag.as_object_mut().unwrap().remove("environment");
    let (_, i) = import(vec![missing_tag]);
    assert_eq!(i[0].environment, Environment::Production, "a missing tag is Production");

    let mut local_tag = file_profile("Local tagged", file_spec());
    local_tag["environment"] = json!("local");
    let (p, i) = import(vec![local_tag]);
    assert_eq!(i[0].environment, Environment::Production, "tag=local on a remote host is raised");
    assert!(p.items[0].warnings.iter().any(|w| w.code == "import.tagRaised"));
}

#[test]
fn each_reaching_feature_raises_the_tag_and_asks_the_confirm() {
    let loop_spec = |f: &dyn Fn(&mut Value)| {
        let mut s = file_spec();
        s["hosts"] = json!([{ "host": "localhost", "port": 27017 }]);
        s["tls"]["mode"] = json!("auto");
        f(&mut s);
        let mut p = file_profile("X", s);
        p["environment"] = json!("local");
        p
    };
    let cases: Vec<(&str, Value)> = vec![
        ("tunnel", loop_spec(&|s| s["tunnel"] = json!({ "kind": "ssh", "host": "bastion.example.com", "user": "ops", "auth": "agent", "allowedHosts": [] }))),
        ("proxy", loop_spec(&|s| s["tunnel"] = json!({ "kind": "socks5", "host": "proxy.example.com", "port": 1080 }))),
        ("plain", loop_spec(&|s| {
            s["auth"]["mechanism"] = json!("plain");
            s["auth"]["source"] = json!("$external");
            s["tls"]["mode"] = json!("on");
        })),
        ("tlsOff", loop_spec(&|s| s["tls"]["mode"] = json!("off"))),
        ("remoteHost", loop_spec(&|s| s["hosts"] = json!([{ "host": "db.example.com", "port": 27017 }]))),
    ];
    for (cause, prof) in cases {
        let (p, i) = import(vec![prof]);
        assert_eq!(i.len(), 1, "{cause}: {:?}", p.notes);
        assert_eq!(i[0].environment, Environment::Production, "{cause}");
        assert!(p.items[0].needs_confirm, "{cause}");
        assert!(p.items[0].warnings.iter().any(|w| w.code == format!("import.risk.{cause}")), "{cause}");
    }
}

#[test]
fn the_preview_lists_every_outbound_endpoint() {
    let mut s = file_spec();
    s["hosts"] = json!([{ "host": "db1.example.com", "port": 27017 }, { "host": "db2.example.com" }]);
    s["tunnel"] = json!({ "kind": "ssh", "host": "bastion.example.com", "user": "ops", "auth": "agent",
                           "allowedHosts": [{ "host": "db3.example.com", "port": 27018 }] });
    let (p, _) = import(vec![file_profile("Eps", s)]);
    let e = &p.items[0].endpoints;
    for want in ["db1.example.com:27017", "db2.example.com:27017", "bastion.example.com:22", "db3.example.com:27018"] {
        assert!(e.iter().any(|x| x == want), "{want} in {e:?}");
    }
    let mut s = file_spec();
    s["tunnel"] = json!({ "kind": "socks5", "host": "proxy.example.com", "port": 1080 });
    let (p, _) = import(vec![file_profile("Px", s)]);
    assert!(p.items[0].endpoints.iter().any(|x| x == "proxy.example.com:1080"));
}

#[test]
fn imported_profiles_are_read_only_ai_off_and_cannot_relax_or_override() {
    let (_, i) = import(vec![file_profile("A", file_spec())]);
    let i = &i[0];
    assert_eq!((i.read_only, i.ai_mode, i.tls_relax), (Some(true), Some(AiMode::Off), Some(TlsRelax::None)));
    assert!(i.level_override_host.is_none());
    assert_eq!(i.tenant_lock, None);
    assert_eq!(i.ai_prefs.as_ref().unwrap().deny_fields, vec!["ssn".to_string()]);
}

#[test]
fn tls_relax_and_other_unknown_keys_are_refused() {
    for (key, val) in [("tlsRelax", json!("certificates")), ("levelOverride", json!("db1.example.com")), ("uri", json!("mongodb://x"))] {
        let mut p = file_profile("A", file_spec());
        p.as_object_mut().unwrap().insert(key.into(), val);
        let e = exchange::import_preview(&file(vec![p])).unwrap_err();
        assert_eq!(e.code, code::IMPORT, "{key}");
        assert!(e.message.contains("unknownField"), "{key}: {}", e.message);
    }
    // inside the spec serde would ignore it; the importer must not
    let mut s = file_spec();
    s["tls"]["tlsAllowInvalidCertificates"] = json!(true);
    let (pv, i) = import(vec![file_profile("A", s)]);
    assert!(i.is_empty());
    assert!(pv.notes.iter().any(|n| n.code == "import.unknownField"));
    let mut p = file_profile("B", file_spec());
    p["aiPrefs"]["sneaky"] = json!(1);
    let (pv, i) = import(vec![p]);
    assert!(i.is_empty() && pv.notes.iter().any(|n| n.code == "import.unknownField"));
    let e = exchange::import_preview(json!({ "format": "intely-mongo-profiles", "version": 1, "profiles": [], "extra": 1 }).to_string().as_bytes()).unwrap_err();
    assert!(e.message.contains("unknownField"));
}

#[test]
fn format_version_size_and_count_are_checked() {
    let bad = |v: Value| exchange::import_preview(v.to_string().as_bytes()).unwrap_err().message;
    assert!(bad(json!({ "format": "other", "version": 1, "profiles": [] })).contains("import.format"));
    assert!(bad(json!({ "format": "intely-mongo-profiles", "version": 2, "profiles": [] })).contains("import.version"));
    let big = vec![b' '; exchange::MAX_BYTES + 1];
    assert!(exchange::import_preview(&big).unwrap_err().message.contains("import.tooLarge"));
    let many: Vec<Value> = (0..201).map(|i| file_profile(&format!("P{i}"), file_spec())).collect();
    assert!(exchange::import_preview(&file(many)).unwrap_err().message.contains("import.tooManyProfiles"));
    let ok: Vec<Value> = (0..200).map(|i| file_profile(&format!("P{i}"), file_spec())).collect();
    assert_eq!(exchange::import_preview(&file(ok)).unwrap().1.len(), 200);
}

#[test]
fn hostile_ssh_hosts_and_users_are_left_out() {
    for (field, bad) in [("host", "-oProxyCommand=evil"), ("host", "bast ion"), ("host", "a\nb"), ("host", "$(id)"), ("user", "-l root"), ("user", "ops;rm")] {
        let mut t = json!({ "kind": "ssh", "host": "bastion.example.com", "user": "ops", "auth": "agent", "allowedHosts": [] });
        t[field] = json!(bad);
        let mut s = file_spec();
        s["tunnel"] = t;
        let (p, i) = import(vec![file_profile("Bad", s)]);
        assert!(i.is_empty(), "{field}={bad:?} must be refused");
        assert_eq!(p.items.len(), 0);
        assert_eq!(p.notes.len(), 1);
    }
    let mut s = file_spec();
    s["tunnel"] = json!({ "kind": "ssh", "host": "bastion.example.com", "user": "ops", "auth": "agent", "allowedHosts": [{ "host": "169.254.169.254", "port": 80 }] });
    let (_, i) = import(vec![file_profile("Meta", s)]);
    assert!(i.is_empty());
    let mut s = file_spec();
    s["tunnel"] = json!({ "kind": "ssh", "host": "-bad", "user": "ops", "auth": "agent", "allowedHosts": [] });
    let (p, i) = import(vec![file_profile("Bad", s), file_profile("Good", file_spec())]);
    assert_eq!((i.len(), p.items[0].name.as_str()), (1, "Good"));
}

#[test]
fn hostile_paths_are_dropped_with_a_note() {
    for path in ["../../etc/passwd", "relative/ca.pem", "~/ca.pem", "/etc/../etc/ca.pem", "/tmp/a\u{0}b"] {
        let mut s = file_spec();
        s["tls"]["caFile"] = json!(path);
        s["tls"]["clientCertFile"] = json!("/etc/ssl/client.pem");
        let (p, i) = import(vec![file_profile("P", s)]);
        assert_eq!(i.len(), 1, "{path:?}");
        let spec = i[0].spec.as_ref().unwrap();
        assert!(spec.tls.ca_file.is_none(), "{path:?}");
        assert_eq!(spec.tls.client_cert_file.as_deref(), Some("/etc/ssl/client.pem"), "a valid path stays");
        assert!(p.items[0].warnings.iter().any(|w| w.code == "import.pathDropped" && w.option.as_deref() == Some("tls.caFile")), "{path:?}");
    }
    let mut s = file_spec();
    s["tunnel"] = json!({ "kind": "ssh", "host": "bastion.example.com", "user": "ops", "auth": "keyFile", "keyFile": "../id", "allowedHosts": [] });
    let (_, i) = import(vec![file_profile("K", s)]);
    if let Some(i) = i.first() {
        assert!(matches!(&i.spec.as_ref().unwrap().tunnel, Tunnel::Ssh(s) if s.key_file.is_none()));
    }
}

#[test]
fn control_characters_in_the_spec_are_refused() {
    let mut s = file_spec();
    s["auth"]["username"] = json!("rea\nder");
    let (p, i) = import(vec![file_profile("C", s)]);
    assert!(i.is_empty() && p.notes[0].code == "import.controlChars");
}

#[test]
fn glossary_and_deny_field_caps() {
    let pair = |n: usize| GlossaryPair { from: format!("f{n}"), to: format!("t{n}") };
    let prof = |prefs: AiPrefs| {
        let mut p = file_profile("G", file_spec());
        p["aiPrefs"] = serde_json::to_value(prefs).unwrap();
        p
    };
    let (_, i) = import(vec![prof(AiPrefs { deny_fields: vec![], glossary: (0..50).map(pair).collect() })]);
    assert_eq!(i.len(), 1, "50 pairs are fine");
    let (p, i) = import(vec![prof(AiPrefs { deny_fields: vec![], glossary: (0..51).map(pair).collect() })]);
    assert!(i.is_empty() && p.notes[0].code == "import.tooLong");
    let (_, i) = import(vec![prof(AiPrefs { deny_fields: vec![], glossary: vec![GlossaryPair { from: "a".repeat(64), to: "b".repeat(64) }] })]);
    assert_eq!(i.len(), 1, "64 characters are fine");
    let (_, i) = import(vec![prof(AiPrefs { deny_fields: vec![], glossary: vec![GlossaryPair { from: "a".repeat(65), to: "b".into() }] })]);
    assert!(i.is_empty());
    let (_, i) = import(vec![prof(AiPrefs { deny_fields: vec!["x".repeat(65)], glossary: vec![] })]);
    assert!(i.is_empty());
}

#[test]
fn name_and_text_caps() {
    let long = "n".repeat(65);
    let (p, i) = import(vec![file_profile(&long, file_spec())]);
    assert!(i.is_empty() && p.notes[0].code == "import.tooLong");
    let mut g = file_profile("G", file_spec());
    g["group"] = json!("g".repeat(41));
    assert!(import(vec![g]).1.is_empty());
    let mut c = file_profile("C", file_spec());
    c["color"] = json!("url(javascript:1)");
    let (_, i) = import(vec![c]);
    assert_eq!(i[0].color, None, "a non-hex colour is dropped, the profile stays");
}

#[test]
fn names_that_clash_get_a_suffix() {
    let opts = ImportOptions { existing_names: vec!["Acme".into()], ..Default::default() };
    let bytes = file(vec![file_profile("Acme", file_spec()), file_profile("acme", file_spec()), file_profile("Other", file_spec())]);
    let (p, i) = exchange::import_json(&bytes, &opts).unwrap();
    let names: Vec<_> = i.iter().map(|x| x.name.as_str()).collect();
    assert_eq!(names, vec!["Acme (2)", "acme (3)", "Other"]);
    assert_eq!(p.items.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), names);
}

#[test]
fn domain_happy_needs_the_preset() {
    let mut p = file_profile("H", file_spec());
    p["domain"] = json!("happy");
    let bytes = file(vec![p]);
    let (pv, i) = exchange::import_json(&bytes, &ImportOptions::default()).unwrap();
    assert_eq!(i[0].domain, Some(Domain::Generic));
    assert!(pv.items[0].warnings.iter().any(|w| w.code == "import.domainGeneric"));
    let (_, i) = exchange::import_json(&bytes, &ImportOptions { happy_preset: true, ..Default::default() }).unwrap();
    assert_eq!(i[0].domain, Some(Domain::Happy));
}

#[test]
fn parse_errors_carry_a_line_number_and_a_code_only() {
    let doc = format!("{{\n  \"format\": \"intely-mongo-profiles\",\n  \"version\": 1,\n  \"profiles\": [ {{ \"name\": \"{CANARY}\" ,, }} ]\n}}");
    let e = exchange::import_preview(doc.as_bytes()).unwrap_err();
    assert_eq!(e.code, code::IMPORT);
    assert!(e.message.contains("import.syntax") && e.message.contains("line 4"), "{}", e.message);
    assert!(!e.message.contains(CANARY));
    let doc = json!({ "format": "intely-mongo-profiles", "version": CANARY, "profiles": [] }).to_string();
    let e = exchange::import_preview(doc.as_bytes()).unwrap_err();
    assert!(e.message.contains("import.invalid") && !e.message.contains(CANARY), "{}", e.message);
    let e = exchange::import_preview(format!("{CANARY} not json").as_bytes()).unwrap_err();
    assert!(!e.message.contains(CANARY));
    let e = exchange::import_preview(&[0xff, 0xfe, 0x00]).unwrap_err();
    assert_eq!(e.code, code::IMPORT);
    assert!(exchange::looks_like_json(b"  \n{\"a\":1}") && !exchange::looks_like_json(b"mongodb://x"));
}

// ---- URI-list import ----------------------------------------------------------------------------------------------

/// A tiny stand-in for the T2 parser: `mongodb://user:pass@host:port/db`, or an error that quotes the whole input.
fn fake_parse(s: &str) -> Result<Parsed, StudioError> {
    let rest = s.split_once("://").unwrap().1;
    if rest.contains("bad") {
        return Err(StudioError::new(code::PARSE, format!("cannot parse {s}")));
    }
    let (auth, hostpart) = rest.rsplit_once('@').map_or((None, rest), |(a, h)| (Some(a), h));
    let (hp, db) = hostpart.split_once('/').unwrap_or((hostpart, ""));
    let (h, port) = hp.split_once(':').map_or((hp, None), |(h, p)| (h, p.parse().ok()));
    let mut spec = ConnSpec { hosts: vec![HostPort { host: h.into(), port }], database: Some(db.to_string()).filter(|d| !d.is_empty()), ..Default::default() };
    let mut secrets = ParsedSecrets::default();
    if let Some((u, p)) = auth.and_then(|a| a.split_once(':')) {
        spec.auth.username = Some(u.into());
        spec.auth.mechanism = AuthMechanism::Default;
        secrets.password = Some(Secret::new(p));
    }
    Ok(Parsed { spec, secrets, tls_relax: rest.contains("insecure"), notes: vec![], unsupported: vec![] })
}

#[test]
fn a_uri_list_keeps_its_passwords_in_rust_only() {
    let list = format!("# my servers\n\nmongodb://app:{CANARY}@db1.example.com:27017/app\nnot a uri\nmongodb://mongodb-bad.example.com/x?{CANARY}\nmongodb://127.0.0.1:27017/dev\n");
    let (p, inputs) = exchange::import_uri_list_with(&list, &ImportOptions::default(), &fake_parse).unwrap();
    assert_eq!(inputs.len(), 2);
    assert_eq!(p.items.len(), 2);
    let wire = serde_json::to_string(&p).unwrap();
    assert!(!wire.contains(CANARY), "{wire}");
    assert!(p.notes.iter().any(|n| n.code == "import.lineIgnored" && n.option.as_deref() == Some("line 4")));
    assert!(p.notes.iter().any(|n| n.code == "import.uriInvalid" && n.option.as_deref() == Some("line 5")));
    assert_eq!(inputs[0].password.as_ref().map(WireSecret::expose), Some(CANARY));
    assert!(!format!("{:?}", inputs[0]).contains(CANARY));
    assert!(inputs[0].spec.as_ref().unwrap().auth.username.as_deref() == Some("app"));
    for i in &inputs {
        assert_eq!((i.read_only, i.ai_mode, i.tls_relax), (Some(true), Some(AiMode::Off), Some(TlsRelax::None)));
        assert_eq!(i.environment, Environment::Production);
        assert_eq!(i.domain, Some(Domain::Generic));
    }
    assert!(p.items[0].needs_confirm && !p.items[1].needs_confirm);
    assert_eq!(p.items[0].name, "db1.example.com");
}

#[test]
fn a_relaxed_tls_option_in_a_uri_is_dropped_with_a_note() {
    let (p, i) = exchange::import_uri_list_with("mongodb://127.0.0.1/x?insecure", &ImportOptions::default(), &fake_parse).unwrap();
    assert_eq!(i[0].tls_relax, Some(TlsRelax::None));
    assert!(p.items[0].warnings.iter().any(|w| w.code == "import.tlsRelaxDropped"));
}

#[test]
fn a_uri_list_is_capped_at_fifty_lines_and_names_are_made_unique() {
    let lines = |n: usize| (0..n).map(|_| "mongodb://127.0.0.1:27017/x".to_string()).collect::<Vec<_>>().join("\n");
    let (p, i) = exchange::import_uri_list_with(&lines(50), &ImportOptions::default(), &fake_parse).unwrap();
    assert_eq!((p.items.len(), i.len()), (50, 50));
    let names: std::collections::HashSet<_> = i.iter().map(|x| x.name.clone()).collect();
    assert_eq!(names.len(), 50, "clashing names get suffixes");
    let e = exchange::import_uri_list_with(&lines(51), &ImportOptions::default(), &fake_parse).unwrap_err();
    assert!(e.message.contains("import.tooManyLines"));
    let mixed = format!("{}\n# c\n\n", lines(50));
    assert!(exchange::import_uri_list_with(&mixed, &ImportOptions::default(), &fake_parse).is_ok());
}

// ---- reading and writing files ------------------------------------------------------------------------------------

struct Fake(FileKind, u64, Vec<u8>);

impl FileSource for Fake {
    fn open(&self, _: &Path) -> std::io::Result<OpenedFile> {
        Ok(OpenedFile { kind: self.0, len: self.1, reader: Box::new(std::io::Cursor::new(self.2.clone())) })
    }
}

#[test]
fn only_a_small_regular_file_is_read() {
    let p = Path::new("/never/touched");
    for kind in [FileKind::Symlink, FileKind::Fifo, FileKind::Device, FileKind::Directory, FileKind::Other] {
        let e = exchange::read_import_file(p, &Fake(kind, 3, b"abc".to_vec())).unwrap_err();
        assert!(e.message.contains("import.notRegular"), "{kind:?}");
    }
    assert_eq!(exchange::read_import_file(p, &Fake(FileKind::Regular, 3, b"abc".to_vec())).unwrap(), b"abc");
    let e = exchange::read_import_file(p, &Fake(FileKind::Regular, exchange::MAX_BYTES as u64 + 1, vec![])).unwrap_err();
    assert!(e.message.contains("import.tooLarge"));
    let e = exchange::read_import_file(p, &Fake(FileKind::Regular, 10, vec![b'x'; exchange::MAX_BYTES + 5])).unwrap_err();
    assert!(e.message.contains("import.tooLarge"));
    struct Gone;
    impl FileSource for Gone {
        fn open(&self, p: &Path) -> std::io::Result<OpenedFile> {
            Err(std::io::Error::other(format!("no {}", p.display())))
        }
    }
    let e = exchange::read_import_file(Path::new("/secret/place/file.json"), &Gone).unwrap_err();
    assert!(!e.message.contains("secret"));
}

#[cfg(unix)]
#[test]
fn the_real_file_source_refuses_symlinks_fifos_directories_and_big_files() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let d = tempfile::tempdir().unwrap();
    let ok = d.path().join("ok.json");
    std::fs::write(&ok, b"{}").unwrap();
    assert_eq!(exchange::read_import_file(&ok, &OsFiles).unwrap(), b"{}");

    let link = d.path().join("link.json");
    std::os::unix::fs::symlink(&ok, &link).unwrap();
    assert!(exchange::read_import_file(&link, &OsFiles).unwrap_err().message.contains("notRegular"));

    let fifo = d.path().join("fifo.json");
    let c = CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    assert!(exchange::read_import_file(&fifo, &OsFiles).unwrap_err().message.contains("notRegular"));

    assert!(exchange::read_import_file(d.path(), &OsFiles).unwrap_err().message.contains("notRegular"));
    let big = d.path().join("big.json");
    std::fs::write(&big, vec![b' '; exchange::MAX_BYTES + 1]).unwrap();
    assert!(exchange::read_import_file(&big, &OsFiles).unwrap_err().message.contains("tooLarge"));
    assert!(exchange::read_import_file(&d.path().join("missing.json"), &OsFiles).unwrap_err().message.contains("unreadable"));
    let mut sink = Vec::new();
    OsFiles.open(&ok).unwrap().reader.read_to_end(&mut sink).unwrap();
}

#[cfg(unix)]
#[test]
fn an_export_is_written_0600_and_never_through_a_symlink() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let out = d.path().join("profiles.json");
    exchange::write_export_file(&out, "{\"a\":1}").unwrap();
    assert_eq!(std::fs::read_to_string(&out).unwrap(), "{\"a\":1}");
    assert_eq!(std::fs::metadata(&out).unwrap().permissions().mode() & 0o777, 0o600);
    exchange::write_export_file(&out, "{\"a\":2}").unwrap();
    assert_eq!(std::fs::read_to_string(&out).unwrap(), "{\"a\":2}");

    let victim = d.path().join("victim.txt");
    std::fs::write(&victim, "precious").unwrap();
    let link = d.path().join("link.json");
    std::os::unix::fs::symlink(&victim, &link).unwrap();
    exchange::write_export_file(&link, "{\"b\":1}").unwrap();
    assert_eq!(std::fs::read_to_string(&victim).unwrap(), "precious");
    assert!(!std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert_eq!(std::fs::read_to_string(&link).unwrap(), "{\"b\":1}");

    assert!(exchange::write_export_file(d.path(), "x").is_err());
    assert!(exchange::write_export_file(&d.path().join("nope").join("f.json"), "x").is_err());
    let leftovers: Vec<_> = std::fs::read_dir(d.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
    assert!(leftovers.is_empty());
}
