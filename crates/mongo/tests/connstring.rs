//! Connection-string parser and renderer (T2): the golden corpus, the round-trip law, hostile passwords, the secret
//! canaries, a no-panic fuzz and (with `--features mongo`) a differential test against the driver's own parser.
//! Pure, no server, no network.

use intely_mongo::api::Note;
use intely_mongo::connspec::*;
use intely_mongo::connstring::*;
use intely_settings::Secret;
use serde_json::{json, Value};

const GOLDEN: &str = include_str!("golden/connstrings.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).unwrap()
}

fn fmt_note(n: &Note) -> String {
    match &n.option {
        Some(o) => format!("{}:{o}", n.code),
        None => n.code.clone(),
    }
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().map(|s| s.as_str().unwrap().to_string()).collect()).unwrap_or_default()
}

/// Every key of `want` must be in `got` with a matching value; arrays match element by element with the same rule.
fn subset(want: &Value, got: &Value, path: &str) -> Result<(), String> {
    match (want, got) {
        (Value::Object(w), Value::Object(g)) => {
            for (k, wv) in w {
                let gv = g.get(k).ok_or_else(|| format!("{path}.{k}: missing"))?;
                subset(wv, gv, &format!("{path}.{k}"))?;
            }
            Ok(())
        }
        (Value::Array(w), Value::Array(g)) => {
            if w.len() != g.len() {
                return Err(format!("{path}: length {} != {}", g.len(), w.len()));
            }
            w.iter().zip(g).enumerate().try_for_each(|(i, (a, b))| subset(a, b, &format!("{path}[{i}]")))
        }
        _ if want == got => Ok(()),
        _ => Err(format!("{path}: got {got}, want {want}")),
    }
}

fn secret_of(v: Option<&Secret>) -> Option<String> {
    v.map(|s| s.expose().to_string())
}

fn parse(s: &str) -> Parsed {
    parse_connection_string(s).unwrap_or_else(|e| panic!("parse failed ({}) for a corpus entry", e.message))
}

fn render_full(p: &Parsed, tls_relax: bool) -> String {
    render_ext(&p.spec, &RenderSecrets { password: p.secrets.password.clone() }, Mask::Full, tls_relax).unwrap()
}

#[test]
fn corpus_is_large_enough() {
    let g = golden();
    let ok = g["ok"].as_array().unwrap().len();
    let bad = g["errors"].as_array().unwrap().len();
    assert!(ok + bad >= 80, "{ok} + {bad} cases");
    assert!(ok >= 80);
}

#[test]
fn corpus_parses_as_expected() {
    let g = golden();
    let mut failures = Vec::new();
    for case in g["ok"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let input = case["input"].as_str().unwrap();
        let p = parse(input);
        let mut problems = Vec::new();
        if let Some(want) = case.get("spec") {
            if let Err(e) = subset(want, &serde_json::to_value(&p.spec).unwrap(), "spec") {
                problems.push(e);
            }
        }
        let want_pw = case.get("password").and_then(Value::as_str).map(str::to_string);
        if secret_of(p.secrets.password.as_ref()) != want_pw {
            problems.push("password differs".into());
        }
        let want_kp = case.get("keyPassword").and_then(Value::as_str).map(str::to_string);
        if secret_of(p.secrets.key_password.as_ref()) != want_kp {
            problems.push("key password differs".into());
        }
        if p.tls_relax != case.get("relax").and_then(Value::as_bool).unwrap_or(false) {
            problems.push(format!("tls_relax is {}", p.tls_relax));
        }
        let notes: Vec<String> = p.notes.iter().map(fmt_note).collect();
        if notes != strings(case.get("notes")) {
            problems.push(format!("notes {notes:?}"));
        }
        let unsupported: Vec<String> = p.unsupported.iter().map(fmt_note).collect();
        if unsupported != strings(case.get("unsupported")) {
            problems.push(format!("unsupported {unsupported:?}"));
        }
        if let Some(want) = case.get("masked").and_then(Value::as_str) {
            let got = render(&p.spec, &RenderSecrets { password: p.secrets.password.clone() }, Mask::Masked).unwrap();
            if got != want {
                problems.push(format!("masked {got}"));
            }
        }
        if !problems.is_empty() {
            failures.push(format!("{name}: {}", problems.join("; ")));
        }
    }
    assert!(failures.is_empty(), "{} failing corpus entries:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn corpus_errors_have_codes_and_never_echo_the_input() {
    let g = golden();
    for case in g["errors"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let input = case["input"].as_str().unwrap();
        let e = parse_connection_string(input).expect_err(name);
        assert_eq!(e.message, case["code"].as_str().unwrap(), "{name}");
        assert_eq!(e.code, "mongoInvalid", "{name}");
    }
}

#[test]
fn round_trip_law_holds_for_the_corpus() {
    // parse(render(parse(x))) == parse(x) for the spec and the secrets. Notes may shrink: render drops what it ignored.
    for case in golden()["ok"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let first = parse(case["input"].as_str().unwrap());
        let text = render_full(&first, first.tls_relax);
        let second = parse(&text);
        assert_eq!(first.spec, second.spec, "{name}: {text}");
        assert_eq!(first.secrets.password, second.secrets.password, "{name}");
        assert_eq!(first.tls_relax, second.tls_relax, "{name}");
        // rendering is a fixed point after one round
        assert_eq!(text, render_full(&second, second.tls_relax), "{name}");
    }
}

#[test]
fn masked_render_never_contains_a_secret() {
    let canary = "Zq9!canary/pw:with@odd%chars";
    let key_canary = "KeyPassCanary77";
    let input = format!("mongodb://user:{}@h.example.com:27017/db?tls=true&tlsCertificateKeyFile=%2Fc.pem&tlsCertificateKeyFilePassword={key_canary}", urlenc(canary));
    let p = parse(&input);
    assert_eq!(p.secrets.password.as_ref().unwrap().expose(), canary);
    assert_eq!(p.secrets.key_password.as_ref().unwrap().expose(), key_canary);
    let secrets = RenderSecrets { password: p.secrets.password.clone() };
    let masked = render(&p.spec, &secrets, Mask::Masked).unwrap();
    assert!(masked.contains("user:***@"), "{masked}");
    assert!(!masked.contains("Zq9") && !masked.contains(key_canary) && !masked.contains("canary"), "{masked}");
    // the full string has the encoded password but never the key passphrase
    let full = render(&p.spec, &secrets, Mask::Full).unwrap();
    assert!(full.contains(&urlenc(canary)), "{full}");
    assert!(!full.contains(key_canary));
    // Debug of the parse result and of the render secrets never shows a value
    for dbg in [format!("{p:?}"), format!("{secrets:?}"), format!("{:?}", p.secrets)] {
        assert!(!dbg.contains("Zq9") && !dbg.contains(key_canary), "{dbg}");
    }
    // notes and errors never carry the input
    let all: String = p.notes.iter().chain(&p.unsupported).map(fmt_note).collect();
    assert!(!all.contains("Zq9"));
    let e = parse_connection_string(&format!("mongodb://user:{}@h:99999", urlenc(canary))).unwrap_err();
    assert!(!format!("{e:?} {e}").contains("Zq9"));
}

/// The test's own encoder (everything but the unreserved set), independent of the implementation.
fn urlenc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

#[test]
fn hostile_passwords_survive_a_render_and_parse() {
    let passwords = [
        "p@ss", "a:b", "a/b", "a%b", "100%", "%41", "%zz", "a#b", "a?b", "a[b]c", "a b", "  lead and trail  ", "pässwörd", "密码", "🔑🔒", "a+b", "a=b&c=d", "a;b", "a\\b", "a'b\"c", "<password>x", "'; drop--", "mongodb://x", "tab\tinside",
        "p@ss:w/rd?#[]%", "~-._", "%00",
    ];
    for pw in passwords {
        let spec = ConnSpec { hosts: vec![HostPort { host: "db.example.com".into(), port: Some(27017) }], auth: AuthSpec { username: Some("us:er@x".into()), ..Default::default() }, ..Default::default() };
        let text = render(&spec, &RenderSecrets { password: Some(Secret::new(pw)) }, Mask::Full).unwrap();
        // the string is a single userinfo: no raw delimiter of the password reaches the output
        assert_eq!(text.matches('@').count(), 1, "{text}");
        let back = parse(&text);
        assert_eq!(back.secrets.password.as_ref().map(Secret::expose), Some(pw), "{pw}");
        assert_eq!(back.spec.auth.username.as_deref(), Some("us:er@x"));
        assert_eq!(back.spec.hosts, spec.hosts);
        assert!(back.notes.is_empty(), "{pw}: {:?}", back.notes);
    }
}

#[test]
fn render_encodes_every_field_so_none_can_inject_an_option() {
    let spec = ConnSpec {
        hosts: vec![HostPort { host: "h".into(), port: Some(27017) }],
        database: Some("db?x=1".into()),
        topology: TopologySpec { replica_set: Some("rs&tls=false".into()), ..Default::default() },
        app_name: Some("a&authSource=evil".into()),
        auth: AuthSpec { mechanism: AuthMechanism::Default, username: Some("u&x=1".into()), source: Some("admin&y=2".into()), save_password: false },
        extra: vec![ExtraOption { key: "maxPoolSize".into(), value: "3&z=9".into() }, ExtraOption { key: "evil&k".into(), value: "v".into() }],
        ..Default::default()
    };
    let text = render(&spec, &RenderSecrets::default(), Mask::Full).unwrap();
    for injected in ["&tls=false", "&authSource=evil", "&y=2", "&z=9", "&x=1", "k=v"] {
        assert!(!text.contains(injected), "{injected} in {text}");
    }
    assert_eq!(text.matches('?').count(), 1, "{text}");
    let back = parse(&text);
    assert_eq!(back.spec.database.as_deref(), Some("db?x=1"));
    assert_eq!(back.spec.topology.replica_set.as_deref(), Some("rs&tls=false"));
    assert_eq!(back.spec.auth.source.as_deref(), Some("admin&y=2"));
    assert_eq!(back.spec.tls.mode, TlsMode::Auto);
}

#[test]
fn render_refuses_hosts_that_could_change_the_destination() {
    for bad in ["", "a b", "h/evil", "h@evil", "h,other", "-x", "h:1", "h?x=1"] {
        let spec = ConnSpec { hosts: vec![HostPort { host: bad.into(), port: None }], ..Default::default() };
        assert!(render(&spec, &RenderSecrets::default(), Mask::Full).is_err(), "{bad:?}");
    }
    assert!(render(&ConnSpec::default(), &RenderSecrets::default(), Mask::Full).is_err());
}

#[test]
fn render_covers_the_spec_table() {
    let spec: ConnSpec = serde_json::from_value(json!({
        "scheme": "standard",
        "hosts": [{"host": "a.example.com", "port": 1}, {"host": "[::1]", "port": 2}],
        "database": "app",
        "auth": {"mechanism": "scramSha256", "username": "u", "source": "admin", "savePassword": true},
        "tls": {"mode": "on", "caFile": "/etc/ca.pem", "clientCertFile": "/etc/c.pem", "saveKeyPassword": true},
        "topology": {"replicaSet": "rs", "directConnection": false, "readPreference": "secondary", "maxStalenessS": 100},
        "compressors": ["zlib"],
        "timeouts": {"connectMs": 3000, "serverSelectionMs": 4000},
        "appName": "X",
        "extra": [{"key": "MAXPOOLSIZE", "value": "2"}]
    }))
    .unwrap();
    let full = render_ext(&spec, &RenderSecrets { password: Some(Secret::new("pw")) }, Mask::Full, true).unwrap();
    assert_eq!(
        full,
        "mongodb://u:pw@a.example.com:1,[::1]:2/app?authMechanism=SCRAM-SHA-256&authSource=admin&replicaSet=rs&directConnection=false&tls=true&tlsCAFile=%2Fetc%2Fca.pem&tlsCertificateKeyFile=%2Fetc%2Fc.pem&tlsAllowInvalidCertificates=true&readPreference=secondary&maxStalenessSeconds=100&compressors=zlib&connectTimeoutMS=3000&serverSelectionTimeoutMS=4000&appName=X&maxPoolSize=2"
    );
    // never the insecure or hostname-only switches
    assert!(!full.contains("tlsInsecure") && !full.contains("tlsAllowInvalidHostnames"));
    // a saved password shows as *** even when none is supplied (the preview of a stored profile)
    let masked = render(&spec, &RenderSecrets::default(), Mask::Masked).unwrap();
    assert!(masked.starts_with("mongodb://u:***@"), "{masked}");
    // SRV drops ports, Auto read preference and an unsupported staleness are not rendered
    let srv = ConnSpec { scheme: Scheme::Srv, hosts: vec![HostPort { host: "c.example.com".into(), port: Some(27017) }], topology: TopologySpec { max_staleness_s: Some(120), ..Default::default() }, ..Default::default() };
    assert_eq!(render(&srv, &RenderSecrets::default(), Mask::Full).unwrap(), "mongodb+srv://c.example.com");
}

#[test]
fn password_less_mechanisms_never_render_a_password() {
    let spec = ConnSpec { hosts: vec![HostPort { host: "h".into(), port: None }], auth: AuthSpec { mechanism: AuthMechanism::X509, username: Some("CN=me".into()), ..Default::default() }, ..Default::default() };
    let s = RenderSecrets { password: Some(Secret::new("leftover")) };
    for m in [Mask::Full, Mask::Masked] {
        let t = render(&spec, &s, m).unwrap();
        assert!(!t.contains("leftover") && !t.contains("***") && t.starts_with("mongodb://CN%3Dme@h"), "{t}");
    }
    let none = ConnSpec { auth: AuthSpec { mechanism: AuthMechanism::None, username: Some("ignored".into()), ..Default::default() }, ..spec };
    assert_eq!(render(&none, &s, Mask::Full).unwrap(), "mongodb://h");
}

#[test]
fn atlas_placeholders_are_never_a_credential() {
    for pw in ["<password>", "<db_password>", "<PASSWORD>", "%3Cdb_password%3E"] {
        let p = parse(&format!("mongodb+srv://me:{pw}@c.example.net/?retryWrites=true"));
        assert!(p.secrets.password.is_none(), "{pw}");
        assert!(p.notes.iter().any(|n| n.code == "uri.passwordPlaceholder"));
        let text = render_full(&p, false);
        assert!(!text.contains("password") && !text.contains("%3C"), "{text}");
    }
    let p = parse("mongodb+srv://<username>:<password>@c.example.net/");
    assert_eq!(p.spec.auth.username, None);
    assert_eq!(p.spec.auth.mechanism, AuthMechanism::None);
}

#[test]
fn ignored_read_only_options_collapse_into_one_info_note() {
    let p = parse("mongodb+srv://u:p@c.example.net/?retryWrites=true&w=majority&appName=Cluster0");
    assert_eq!(p.notes.len(), 1);
    assert_eq!(p.notes[0].code, "info.ignoredReadOnly");
    assert!(p.unsupported.is_empty());
}

#[test]
fn spec_from_a_paste_validates_when_the_paste_was_sane() {
    for input in [
        "mongodb+srv://u:p@cluster0.ab1cd.mongodb.net/mydb?retryWrites=true&w=majority&appName=Cluster0",
        "mongodb://root:example@localhost:27017/?authSource=admin",
        "mongodb://a.example.com:27017,b.example.com:27017/?replicaSet=rs0&tls=true",
    ] {
        let p = parse(input);
        assert!(p.spec.errors().is_empty(), "{input}: {:?}", p.spec.errors());
    }
    // a pasted problem shows up in validate, not as a parse failure
    let p = parse("mongodb://h/?tls=true&tlsCAFile=ca.pem");
    assert!(p.spec.errors().iter().any(|f| f.code == "file.path"));
}

#[test]
fn tilde_and_relative_paths_are_flagged() {
    let p = parse("mongodb://h/?tls=true&tlsCAFile=~%2Fca.pem&tlsCertificateKeyFile=rel%2Fc.pem");
    let codes: Vec<String> = p.notes.iter().map(fmt_note).collect();
    assert_eq!(codes, ["uri.pathTilde:tlsCAFile", "uri.pathRelative:tlsCertificateKeyFile"]);
}

#[test]
fn unsupported_things_are_listed_not_dropped() {
    let p = parse("mongodb://u:p@h/?authMechanism=MONGODB-AWS&proxyHost=x&compressors=lz4&bogus=1");
    let u: Vec<String> = p.unsupported.iter().map(fmt_note).collect();
    assert_eq!(u, ["unsupported.authMechanism:MONGODB-AWS", "unsupported.proxy:proxyHost", "unsupported.compressor:lz4", "unsupported.option:bogus"]);
}

#[test]
fn huge_and_degenerate_inputs_are_refused_quickly() {
    assert!(parse_connection_string(&"a".repeat(1_000_000)).is_err());
    assert!(parse_connection_string(&format!("mongodb://{}", ",".repeat(10_000))).is_err());
    // at the limit but still valid
    let many = format!("mongodb://{}", (0..600).map(|i| format!("h{i}.e.com")).collect::<Vec<_>>().join(","));
    let p = parse_connection_string(&many).unwrap();
    assert_eq!(p.spec.hosts.len(), 600);
    assert!(p.spec.errors().iter().any(|f| f.code == "host.count"));
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn pick<'a>(&mut self, xs: &[&'a str]) -> &'a str {
        xs[(self.next() % xs.len() as u64) as usize]
    }
}

#[test]
fn two_thousand_random_strings_never_panic() {
    let atoms = [
        "mongodb://", "mongodb+srv://", "MONGODB://", "@", ":", "/", "?", "&", "=", ",", "%", "%2", "%41", "%FF", "%00", "[", "]", "::1", "h", "host.example.com", "27017", "99999", "0", "user", "pw", "<password>", "retryWrites", "tls", "ssl", "authMechanism",
        "tlsCAFile", "compressors", "readPreference", "maxPoolSize", "-1", "true", "false", " ", "\t", "é", "密", "🔑", "\u{0}", "\u{202e}", "#", "~", "\\", "'", "\"", "..", "+", ";",
    ];
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut parsed = 0;
    for _ in 0..2000 {
        let n = 1 + rng.next() % 14;
        let mut s = String::new();
        if rng.next() % 2 == 0 {
            s.push_str(rng.pick(&["mongodb://", "mongodb+srv://"]));
        }
        for _ in 0..n {
            s.push_str(rng.pick(&atoms));
        }
        if let Ok(p) = parse_connection_string(&s) {
            parsed += 1;
            // whatever parsed must render without panicking (an invalid host may be refused) and the masked form has no secret
            if let Ok(m) = render(&p.spec, &RenderSecrets { password: p.secrets.password.clone() }, Mask::Masked) {
                if let Some(pw) = p.secrets.password.as_ref().map(Secret::expose).filter(|pw| pw.len() > 4) {
                    assert!(!m.contains(pw), "{m}");
                }
            }
            let _ = p.spec.validate();
        }
    }
    assert!(parsed > 20, "fuzz produced only {parsed} parsable strings; the generator is too hostile to be useful");
}

#[test]
fn zstd_is_parsed_and_flagged_by_validate_not_by_the_parser() {
    let p = parse("mongodb://h/?compressors=zstd");
    assert_eq!(p.spec.compressors, [Compressor::Zstd]);
    assert!(p.spec.validate().iter().any(|f| f.code == "compressor.unsupported"));
}

#[test]
fn duplicate_options_keep_the_last_value_and_say_so() {
    let p = parse("mongodb://h/?appName=A&APPNAME=B");
    assert_eq!(p.spec.app_name.as_deref(), Some("B"));
    assert_eq!(p.notes.iter().map(fmt_note).collect::<Vec<_>>(), ["uri.duplicate:APPNAME"]);
}

// ---- differential test against the driver's parser ------------------------------------------------------------

#[cfg(feature = "mongo")]
mod differential {
    use super::*;
    use mongodb::options::ClientOptions;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    fn drv(rt: &tokio::runtime::Runtime, s: &str) -> mongodb::error::Result<ClientOptions> {
        rt.block_on(async { ClientOptions::parse(s).await })
    }

    fn expected_hosts(spec: &ConnSpec) -> Vec<String> {
        spec.hosts.iter().map(|h| format!("{}:{}", h.host.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase(), h.port.unwrap_or(27017))).collect()
    }

    /// `ClientOptions::parse(render(spec))` accepts every corpus entry and yields the same hosts. `mongodb+srv://` entries
    /// need a DNS lookup and are skipped here (they are listed in the report as not proven by this test); so are entries
    /// marked `"driver": false` (a compressor or option this build refuses on purpose).
    #[test]
    fn driver_accepts_every_rendered_corpus_entry_with_the_same_hosts() {
        let rt = rt();
        let (mut checked, mut skipped) = (0, 0);
        let mut failures = Vec::new();
        for case in golden()["ok"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let p = parse(case["input"].as_str().unwrap());
            if p.spec.scheme == Scheme::Srv || case.get("driver").and_then(Value::as_bool) == Some(false) {
                skipped += 1;
                continue;
            }
            let text = render_full(&p, p.tls_relax);
            match drv(&rt, text.as_str()) {
                Ok(co) => {
                    let got: Vec<String> = co.hosts.iter().map(|h| h.to_string().to_ascii_lowercase()).collect();
                    if got != expected_hosts(&p.spec) {
                        failures.push(format!("{name}: hosts {got:?}"));
                    }
                }
                Err(e) => failures.push(format!("{name}: driver refused the rendered string: {}", mask(&e.to_string(), &p))),
            }
            checked += 1;
        }
        assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
        assert!(checked >= 70, "only {checked} entries checked ({skipped} skipped)");
    }

    fn mask(s: &str, p: &Parsed) -> String {
        match p.secrets.password.as_ref() {
            Some(pw) => s.replace(pw.expose(), "***"),
            None => s.to_string(),
        }
    }

    #[test]
    fn driver_agrees_on_the_secret_free_options() {
        let rt = rt();
        let p = parse("mongodb://u:p@a.example.com:1,b.example.com:2/db?replicaSet=rs0&authSource=admin&tls=true&readPreference=secondaryPreferred&maxStalenessSeconds=120&compressors=zlib,snappy&connectTimeoutMS=3000&serverSelectionTimeoutMS=4000&appName=Probe&maxPoolSize=3");
        let co = drv(&rt, render_full(&p, false).as_str()).unwrap();
        assert_eq!(co.repl_set_name.as_deref(), Some("rs0"));
        assert_eq!(co.app_name.as_deref(), Some("Probe"));
        assert_eq!(co.max_pool_size, Some(3));
        assert_eq!(co.connect_timeout, Some(std::time::Duration::from_millis(3000)));
        assert_eq!(co.server_selection_timeout, Some(std::time::Duration::from_millis(4000)));
        let cred = co.credential.as_ref().unwrap();
        assert_eq!(cred.username.as_deref(), Some("u"));
        assert_eq!(cred.password.as_deref(), Some("p"));
        assert_eq!(cred.source.as_deref(), Some("admin"));
        assert!(matches!(co.tls, Some(mongodb::options::Tls::Enabled(_))));
    }

    #[test]
    fn driver_decodes_hostile_passwords_like_we_encode_them() {
        let rt = rt();
        for pw in ["p@ss:w/rd%#?[] ", "pässwörd🔑", "a+b=c&d", "100%", "<password>x"] {
            let spec = ConnSpec { hosts: vec![HostPort { host: "h.example.com".into(), port: Some(27017) }], auth: AuthSpec { username: Some("u@x".into()), ..Default::default() }, ..Default::default() };
            let text = render(&spec, &RenderSecrets { password: Some(Secret::new(pw)) }, Mask::Full).unwrap();
            let co = drv(&rt, text.as_str()).unwrap();
            let cred = co.credential.unwrap();
            assert_eq!(cred.username.as_deref(), Some("u@x"));
            assert_eq!(cred.password.as_deref(), Some(pw));
        }
    }

    #[test]
    fn relaxed_certificates_reach_the_driver_only_through_the_one_switch() {
        let rt = rt();
        let p = parse("mongodb://h.example.com/?tls=true&tlsInsecure=true");
        assert!(p.tls_relax);
        let plain = drv(&rt, render_full(&p, false).as_str()).unwrap();
        let relaxed = drv(&rt, render_full(&p, true).as_str()).unwrap();
        let allow = |co: &ClientOptions| matches!(&co.tls, Some(mongodb::options::Tls::Enabled(t)) if t.allow_invalid_certificates == Some(true));
        assert!(!allow(&plain));
        assert!(allow(&relaxed));
    }
}
