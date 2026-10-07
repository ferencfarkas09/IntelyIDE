//! Diagnosis (T3): the golden corpus (`golden/diagnose.json`, all synthetic; `golden/diagnose.real.json` is loaded too when
//! it exists), step table, Atlas hints, relay refusals and the secret canaries. Pure: no server, no network.

use intely_mongo::api::{ErrorClass, StepId, StepState};
use intely_mongo::connspec::TlsMode;
use intely_mongo::diagnose::*;
use serde_json::Value;
use std::collections::BTreeSet;

const SYNTHETIC: &str = include_str!("golden/diagnose.json");

fn corpus() -> Vec<Value> {
    let mut all: Vec<Value> = serde_json::from_str(SYNTHETIC).unwrap();
    let real = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/diagnose.real.json");
    if let Ok(text) = std::fs::read_to_string(real) {
        all.extend(serde_json::from_str::<Vec<Value>>(&text).unwrap());
    }
    all
}

fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().map(|s| s.as_str().unwrap().to_string()).collect()).unwrap_or_default()
}

fn ctx_of(v: &Value) -> Ctx {
    let b = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    Ctx {
        hosts: strs(v.get("hosts")),
        is_atlas: b("isAtlas"),
        srv: b("srv"),
        tls_mode: match v.get("tlsMode").and_then(Value::as_str) {
            Some("on") => TlsMode::On,
            Some("off") => TlsMode::Off,
            _ => TlsMode::Auto,
        },
        has_ca: b("hasCa"),
        has_client_cert: b("hasClientCert"),
        tunnel: match v.get("tunnel").and_then(Value::as_str) {
            Some("ssh") => "ssh",
            Some("socks5") => "socks5",
            _ => "none",
        },
        relaxed: b("relaxed"),
        refused_hosts: strs(v.get("refusedHosts")),
        scrub: strs(v.get("scrub")),
    }
}

fn hint_of(s: &str) -> Hint {
    use std::io::ErrorKind as E;
    match s {
        "none" => Hint::None,
        "dns" => Hint::Dns,
        "invalidTls" => Hint::InvalidTls,
        "auth" => Hint::Auth,
        "selection" => Hint::Selection,
        "proxy" => Hint::Proxy,
        "io:refused" => Hint::Io(E::ConnectionRefused),
        "io:timedout" => Hint::Io(E::TimedOut),
        "io:unreachable" => Hint::Io(E::NetworkUnreachable),
        other => Hint::Command(other.strip_prefix("command:").expect(other).parse().unwrap()),
    }
}

fn run(entry: &Value) -> (intely_mongo::api::Diagnosis, Ctx) {
    let ctx = ctx_of(&entry["ctx"]);
    (classify_hint(hint_of(entry["hint"].as_str().unwrap()), entry["text"].as_str().unwrap(), &ctx), ctx)
}

fn hints(d: &intely_mongo::api::Diagnosis) -> Vec<String> {
    d.params.iter().filter(|(k, _)| k == "hint").map(|(_, v)| v.clone()).collect()
}

#[test]
fn corpus_entries_are_classified_as_recorded() {
    let mut bad = Vec::new();
    for e in corpus() {
        assert!(matches!(e["source"].as_str(), Some("real" | "synthetic")), "{}: source must be real or synthetic", e["name"]);
        let (d, _) = run(&e);
        let name = e["name"].as_str().unwrap();
        if d.code != e["code"].as_str().unwrap() {
            bad.push(format!("{name}: got {} want {}", d.code, e["code"]));
            continue;
        }
        assert_eq!(d.class, class_of(&d.code), "{name}");
        if let Some(want) = e.get("params") {
            let got: Vec<Value> = d.params.iter().filter(|(k, _)| k != "hint").map(|(k, v)| serde_json::json!([k, v])).collect();
            if &Value::Array(got.clone()) != want {
                bad.push(format!("{name}: params {got:?} want {want}"));
            }
        }
        for h in strs(e.get("hasHint")) {
            if !hints(&d).contains(&h) {
                bad.push(format!("{name}: missing hint {h}"));
            }
        }
        if e.get("noHint").is_some() && !hints(&d).is_empty() {
            bad.push(format!("{name}: unexpected hints {:?}", hints(&d)));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

#[test]
fn every_catalogue_code_is_producible_and_marked_synthetic_or_real() {
    let produced: BTreeSet<String> = corpus().iter().map(|e| run(e).0.code).collect();
    let missing: Vec<&&str> = ALL_CODES.iter().filter(|c| !produced.contains(**c)).collect();
    assert!(missing.is_empty(), "codes without a corpus entry: {missing:?}");
    // Appendix B2 has 49 codes plus `other`.
    assert_eq!(ALL_CODES.len(), 50);
    let unique: BTreeSet<&&str> = ALL_CODES.iter().collect();
    assert_eq!(unique.len(), ALL_CODES.len());
    let real = corpus().iter().filter(|e| e["source"] == "real").count();
    eprintln!("diagnose corpus: {} entries, {real} real, {} synthetic", corpus().len(), corpus().len() - real);
}

#[test]
fn from_code_builds_a_diagnosis_for_pipeline_raised_codes() {
    for c in ALL_CODES {
        let d = from_code(c, vec![], "x", &Ctx::default());
        assert_eq!(d.code, *c);
        assert_eq!(d.class, class_of(c));
    }
    assert_eq!(from_code("nope.nothing", vec![], "", &Ctx::default()).code, "other");
}

#[test]
fn unknown_text_is_other_and_kind_beats_text() {
    let ctx = Ctx::default();
    let d = classify_text("The flux capacitor is out of plutonium", &ctx);
    assert_eq!((d.class, d.code.as_str(), d.retryable), (ErrorClass::Other, "other", false));
    // Words that would say TLS in a text rule do not override a typed authentication error.
    let d = classify_hint(Hint::Auth, "TLS certificate handshake: authentication failed", &ctx);
    assert_eq!(d.code, "auth.failed");
    // A typed DNS error stays DNS even when the text mentions a timeout.
    assert_eq!(classify_hint(Hint::Dns, "lookup timed out", &ctx).code, "dns.notFound");
    // An ssh-looking word in a driver authentication error does not turn it into a tunnel failure.
    let ssh = Ctx { tunnel: "ssh", ..Ctx::default() };
    assert_eq!(classify_hint(Hint::Auth, "Authentication failed (ssh tunnel up)", &ssh).code, "auth.failed");
}

#[test]
fn retryable_follows_the_class_rule() {
    for e in corpus() {
        let d = run(&e).0;
        let want = matches!(d.class, ErrorClass::Network | ErrorClass::Timeout | ErrorClass::Selection | ErrorClass::Dns) || d.code == "tunnel.dropped";
        assert_eq!(d.retryable, want, "{}", d.code);
    }
}

#[test]
fn relay_refusals_yield_not_allowed_with_the_host_in_params() {
    let ctx = Ctx { hosts: vec!["a.test:27017".into()], tunnel: "ssh", refused_hosts: vec!["b.test:27017".into(), "c.test:27018".into()], ..Ctx::default() };
    let d = classify_hint(Hint::Selection, "Server selection timeout: No available servers.", &ctx);
    assert_eq!(d.code, "tunnel.notAllowed");
    assert_eq!(d.params, vec![("host".to_string(), "b.test:27017".to_string()), ("host".to_string(), "c.test:27018".to_string())]);
    // A typed auth failure is not hidden by an old refusal.
    assert_eq!(classify_hint(Hint::Auth, "bad auth", &ctx).code, "auth.failed");
    // Without refusals the same text is a plain selection failure.
    assert_eq!(classify_hint(Hint::Selection, "Server selection timeout: No available servers.", &Ctx::default()).code, "select.noServer");
}

#[test]
fn atlas_hints_are_keyed_on_is_atlas() {
    let text = "Server selection timeout: No available servers.";
    let plain = classify_hint(Hint::Selection, text, &Ctx { hosts: vec!["db.example.test".into()], ..Ctx::default() });
    assert!(hints(&plain).is_empty());
    let atlas = classify_hint(Hint::Selection, text, &Ctx { hosts: vec!["c0.abc.mongodb.net".into()], is_atlas: true, ..Ctx::default() });
    assert_eq!(hints(&atlas), vec!["atlas.networkAccess", "atlas.paused"]);
}

/// Every code: the failed step, the skipped ones and the rule that no step after the failed one is ever Ok, in each
/// tunnel configuration.
#[test]
fn step_table_never_shows_ok_after_the_failure() {
    let order = [StepId::Config, StepId::Tunnel, StepId::Dns, StepId::Connect, StepId::Tls, StepId::Auth, StepId::Permissions];
    let expect_failed = |code: &str| -> StepId {
        match code.split('.').next().unwrap() {
            "config" => StepId::Config,
            "tunnel" => StepId::Tunnel,
            "dns" => StepId::Dns,
            "tls" => StepId::Tls,
            "auth" => StepId::Auth,
            "authz" => StepId::Permissions,
            _ => StepId::Connect,
        }
    };
    for code in ALL_CODES {
        for (tunnel, srv) in [("none", false), ("none", true), ("ssh", false), ("socks5", true)] {
            let ctx = Ctx { tunnel, srv, ..Ctx::default() };
            let d = from_code(code, vec![], "", &ctx);
            let steps = steps_for(&d, &ctx);
            assert_eq!(steps.iter().map(|s| s.id).collect::<Vec<_>>(), order, "{code}");
            let at = order.iter().position(|s| *s == expect_failed(code)).unwrap();
            let want = if *code == "authz.listDatabases" { StepState::Warn } else { StepState::Failed };
            assert_eq!(steps[at].state, want, "{code} {tunnel}");
            for (i, s) in steps.iter().enumerate() {
                if i > at {
                    assert_eq!(s.state, StepState::Skipped, "{code}: {:?} after the failure must be Skipped", s.id);
                }
                if i < at {
                    assert!(matches!(s.state, StepState::Ok | StepState::Skipped), "{code}: {:?}", s.id);
                }
            }
            assert_eq!(steps.iter().filter(|s| matches!(s.state, StepState::Failed | StepState::Warn)).count(), 1, "{code}");
        }
    }
    // No tunnel: the tunnel step is skipped, not Ok; behind ssh the local DNS and TCP steps are skipped.
    let d = from_code("tls.hostname", vec![], "", &Ctx::default());
    let st = |ctx: &Ctx| steps_for(&d, ctx).into_iter().map(|s| s.state).collect::<Vec<_>>();
    use StepState::*;
    assert_eq!(st(&Ctx { tunnel: "none", ..Ctx::default() }), vec![Ok, Skipped, Ok, Ok, Failed, Skipped, Skipped]);
    assert_eq!(st(&Ctx { tunnel: "ssh", ..Ctx::default() }), vec![Ok, Ok, Skipped, Skipped, Failed, Skipped, Skipped]);
    assert_eq!(st(&Ctx { tunnel: "ssh", srv: true, ..Ctx::default() }), vec![Ok, Ok, Ok, Skipped, Failed, Skipped, Skipped]);
}

/// Canaries: nothing secret, no user name, no path and no URI credentials reach `detail` or `params`.
#[test]
fn detail_carries_no_secret_user_or_path() {
    let canary_pw = "pw-canary-7f3a9";
    let canary_user = "deploy_canary";
    let key_path = "/Users/someone/.ssh/id_canary_key";
    let texts = [
        format!("Authentication failed for mongodb://{canary_user}:{canary_pw}@db.example.test:27017/shop?authSource=admin"),
        format!("{canary_user}@bastion.example.test: Permission denied (publickey)."),
        format!("Load key \"{key_path}\": incorrect passphrase supplied"),
        format!("Warning: Identity file {key_path} not accessible: No such file or directory."),
        format!("identity_file={key_path} user={canary_user} failed"),
        format!("Invalid TLS configuration: cannot read /etc/ssl/private/{canary_user}-client.pem: No such file"),
        format!("C:\\Users\\{canary_user}\\certs\\ca.pem not found"),
        format!("~/{canary_user}/ca.pem missing"),
    ];
    let ctx = Ctx { scrub: vec![canary_user.into(), canary_pw.into()], tunnel: "ssh", hosts: vec!["db.example.test".into()], ..Ctx::default() };
    for hint in [Hint::None, Hint::Auth, Hint::InvalidTls, Hint::Selection] {
        for t in &texts {
            let d = classify_hint(hint, t, &ctx);
            let blob = format!("{} {:?}", d.detail, d.params);
            for c in [canary_pw, canary_user, "id_canary_key", "/Users/", "/etc/ssl", "C:\\"] {
                assert!(!blob.contains(c), "{c:?} leaked from {t:?} into {blob:?}");
            }
        }
    }
    // Without the caller's scrub list the structural scrubbers still remove URI credentials, user@ and absolute paths.
    let d = classify_text(&texts[0], &Ctx::default());
    assert!(!d.detail.contains(canary_pw) && !d.detail.contains(canary_user), "{}", d.detail);
    let d = classify_text(&texts[1], &Ctx { tunnel: "ssh", ..Ctx::default() });
    assert!(d.detail.contains("<user>@bastion.example.test"), "{}", d.detail);
    // Hostnames survive: they are what the user needs to see.
    assert!(d.detail.contains("bastion.example.test"));
}

#[test]
fn detail_strips_control_and_bidi_characters_and_is_capped() {
    let hostile = format!("bad\u{1b}[31m red \u{202E}evil\u{200F} text {}", "x".repeat(10_000));
    let d = classify_text(&hostile, &Ctx::default());
    assert!(!d.detail.chars().any(|c| c.is_control() && c != '\n' && c != '\t'));
    assert!(!d.detail.contains('\u{202E}') && !d.detail.contains('\u{200F}'));
    assert!(d.detail.len() <= 4096 + 4);
}

#[test]
fn explicit_codes_must_end_at_a_boundary() {
    // `dns.srvX` is not the code `dns.srv`.
    assert_eq!(classify_text("dns.srvX happened", &Ctx::default()).code, "other");
    assert_eq!(classify_text("dns.srv: gone", &Ctx::default()).code, "dns.srv");
}

/// The driver marks most error kinds `#[non_exhaustive]`, so only `Io` and a parse error can be built here; the kind
/// mapping of the others is covered through `classify_hint` above.
#[cfg(feature = "mongo")]
mod driver {
    use super::*;
    use mongodb::error::{Error, ErrorKind};

    #[test]
    fn io_errors_are_classified_by_kind() {
        let ctx = Ctx { hosts: vec!["db.example.test".into()], ..Ctx::default() };
        let e: Error = ErrorKind::Io(std::sync::Arc::new(std::io::Error::from(std::io::ErrorKind::ConnectionRefused))).into();
        assert_eq!(classify(&e, &ctx).code, "net.refused");
        let e: Error = ErrorKind::Io(std::sync::Arc::new(std::io::Error::from(std::io::ErrorKind::TimedOut))).into();
        assert_eq!(classify(&e, &ctx).code, "net.timeout");
    }

    #[tokio::test]
    async fn a_real_parse_error_is_other_with_a_scrubbed_detail() {
        let err = mongodb::options::ClientOptions::parse("mongodb://user:pw-canary-91@").await.unwrap_err();
        let d = classify(&err, &Ctx::default());
        assert!(!d.detail.contains("pw-canary-91"), "{}", d.detail);
    }
}
