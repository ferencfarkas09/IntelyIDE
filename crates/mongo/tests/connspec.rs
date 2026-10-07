//! `ConnSpec`: the validation table, the frozen serialized field order, the canonical `conn_hash` (golden, stable when a
//! defaulted field is missing), the secret identity and the tunnel rule of the host level. Pure, no server.

use intely_mongo::connspec::*;
use intely_mongo::types::EffectiveLevel;
use serde_json::{json, Value};

fn spec(v: Value) -> ConnSpec {
    serde_json::from_value(v).unwrap()
}

fn std_spec(host: &str) -> ConnSpec {
    ConnSpec { hosts: vec![HostPort { host: host.into(), port: Some(27017) }], ..Default::default() }
}

fn codes(s: &ConnSpec) -> Vec<String> {
    s.validate().into_iter().map(|p| p.code).collect()
}

fn full() -> ConnSpec {
    spec(json!({
        "scheme": "standard",
        "hosts": [{"host": "db1.example.com", "port": 27017}, {"host": "db2.example.com", "port": 27018}],
        "database": "app",
        "auth": {"mechanism": "scramSha256", "username": "reader", "source": "admin", "savePassword": true},
        "tls": {"mode": "on", "caFile": "/etc/ca.pem", "clientCertFile": "/etc/client.pem", "saveKeyPassword": true},
        "topology": {"replicaSet": "rs0", "directConnection": false, "readPreference": "secondaryPreferred", "maxStalenessS": 120},
        "compressors": ["zlib", "snappy"],
        "timeouts": {"connectMs": 8000, "serverSelectionMs": 9000},
        "appName": "Probe",
        "extra": [{"key": "maxPoolSize", "value": "3"}],
        "tunnel": {"kind": "ssh", "host": "bastion", "port": 2222, "user": "ops", "auth": "keyFile", "keyFile": "/home/u/.ssh/id",
                   "saveSecret": true, "useSshConfig": false, "allowedHosts": [{"host": "db1.example.com", "port": 27017}]}
    }))
}

/// Records, for every object in `v`, the keys in serialization order (`path` uses `[]` for array elements).
fn key_orders(v: &Value, path: &str, out: &mut serde_json::Map<String, Value>) {
    match v {
        Value::Object(m) => {
            out.insert(path.to_string(), json!(m.keys().collect::<Vec<_>>()));
            for (k, c) in m {
                key_orders(c, &format!("{path}.{k}"), out);
            }
        }
        Value::Array(a) => {
            if let Some(first) = a.first() {
                key_orders(first, &format!("{path}[]"), out);
            }
        }
        _ => {}
    }
}

fn golden_samples() -> Vec<(&'static str, ConnSpec)> {
    vec![
        ("minimal", std_spec("127.0.0.1")),
        ("atlas", spec(json!({"scheme": "srv", "hosts": [{"host": "cluster0.abc12.mongodb.net"}], "auth": {"username": "u", "source": "admin"}}))),
        ("full", full()),
        ("socks5", spec(json!({"hosts": [{"host": "db.internal", "port": 27017}], "tunnel": {"kind": "socks5", "host": "127.0.0.1", "port": 1080, "username": "p", "savePassword": true}}))),
        ("x509", spec(json!({"hosts": [{"host": "db", "port": 27017}], "auth": {"mechanism": "x509"}, "tls": {"mode": "on", "clientCertFile": "/c.pem"}}))),
    ]
}

#[test]
fn the_serialized_field_order_and_the_conn_hash_are_frozen() {
    let mut ssh_minimal = serde_json::Map::new();
    let sample = serde_json::to_value(full()).unwrap();
    key_orders(&sample, "spec", &mut ssh_minimal);
    let socks = serde_json::to_value(&golden_samples()[3].1).unwrap();
    key_orders(&socks, "spec", &mut ssh_minimal);
    let hashes: serde_json::Map<String, Value> = golden_samples().iter().map(|(n, s)| ((*n).to_string(), json!(s.conn_hash()))).collect();
    let now = json!({ "fieldOrder": ssh_minimal, "connHash": hashes });
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/conn_hash.json");
    if std::env::var_os("INTELY_UPDATE_GOLDEN").is_some() {
        std::fs::write(&path, serde_json::to_string_pretty(&now).unwrap() + "\n").unwrap();
    }
    let want: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("tests/golden/conn_hash.json")).unwrap();
    assert_eq!(now, want, "a serialized field order or a conn_hash changed: that invalidates every signed profile");
    // serde_json's preserve_order feature makes object equality order-insensitive for maps; compare the key lists as text too
    assert_eq!(serde_json::to_string(&now["fieldOrder"]).unwrap(), serde_json::to_string(&want["fieldOrder"]).unwrap());
}

#[test]
fn a_defaulted_field_that_is_missing_or_present_leaves_the_hash_alone() {
    // a record written before a defaulted field existed is the same spec once loaded
    let old = spec(json!({"hosts": [{"host": "127.0.0.1", "port": 27017}]}));
    let explicit = spec(json!({
        "scheme": "standard", "hosts": [{"host": "127.0.0.1", "port": 27017}], "database": null,
        "auth": {"mechanism": "default", "username": null, "source": null, "savePassword": false},
        "tls": {"mode": "auto", "caFile": null, "clientCertFile": null, "saveKeyPassword": false},
        "topology": {"replicaSet": null, "directConnection": null, "readPreference": "auto", "maxStalenessS": null},
        "compressors": [], "timeouts": {}, "appName": null, "extra": [], "tunnel": {"kind": "none"}
    }));
    assert_eq!(old, explicit);
    assert_eq!(old.conn_hash(), explicit.conn_hash());
    // every real setting does change it
    let base = old.conn_hash();
    let mut variants: Vec<ConnSpec> = Vec::new();
    for f in [
        |s: &mut ConnSpec| s.scheme = Scheme::Srv,
        |s: &mut ConnSpec| s.hosts[0].port = Some(27018),
        |s: &mut ConnSpec| s.database = Some("x".into()),
        |s: &mut ConnSpec| s.auth.mechanism = AuthMechanism::None,
        |s: &mut ConnSpec| s.auth.username = Some("u".into()),
        |s: &mut ConnSpec| s.tls.mode = TlsMode::Off,
        |s: &mut ConnSpec| s.tls.ca_file = Some("/ca".into()),
        |s: &mut ConnSpec| s.topology.read_preference = ReadPrefMode::Nearest,
        |s: &mut ConnSpec| s.compressors = vec![Compressor::Zlib],
        |s: &mut ConnSpec| s.timeouts.connect_ms = Some(2000),
        |s: &mut ConnSpec| s.extra = vec![ExtraOption { key: "maxPoolSize".into(), value: "2".into() }],
        |s: &mut ConnSpec| s.tunnel = Tunnel::Socks5(ProxySpec { host: "p".into(), port: 1, ..Default::default() }),
    ] {
        let mut s = old.clone();
        f(&mut s);
        variants.push(s);
    }
    let mut seen = std::collections::HashSet::from([base]);
    for v in variants {
        assert!(seen.insert(v.conn_hash()), "two different specs share a hash: {v:?}");
    }
}

#[test]
fn an_outside_edit_of_bastion_key_or_allow_list_changes_the_hash() {
    let a = full();
    let mut b = a.clone();
    let Tunnel::Ssh(s) = &mut b.tunnel else { panic!() };
    s.host = "evil".into();
    assert_ne!(a.conn_hash(), b.conn_hash());
    let mut c = a.clone();
    let Tunnel::Ssh(s) = &mut c.tunnel else { panic!() };
    s.key_file = Some("/tmp/other".into());
    assert_ne!(a.conn_hash(), c.conn_hash());
    let mut d = a.clone();
    let Tunnel::Ssh(s) = &mut d.tunnel else { panic!() };
    s.allowed_hosts.push(AllowedHost { host: "169.0.0.1".into(), port: 1 });
    assert_ne!(a.conn_hash(), d.conn_hash());
}

#[test]
fn the_secret_identity_follows_the_destination_and_nothing_else() {
    let base = full();
    let id = base.secret_identity();
    let mut same = base.clone();
    same.database = Some("other".into());
    same.app_name = Some("Other".into());
    same.timeouts.connect_ms = Some(1000);
    same.topology.replica_set = Some("rs9".into());
    same.tls.ca_file = Some("/other/ca".into());
    assert_eq!(id, same.secret_identity(), "options that do not change where a secret goes keep the identity");
    let changes: Vec<(&str, Box<dyn Fn(&mut ConnSpec)>)> = vec![
        ("host", Box::new(|s: &mut ConnSpec| s.hosts[0].host = "evil.example.com".into())),
        ("port", Box::new(|s: &mut ConnSpec| s.hosts[1].port = Some(1))),
        ("scheme", Box::new(|s: &mut ConnSpec| s.scheme = Scheme::Srv)),
        ("mechanism", Box::new(|s: &mut ConnSpec| s.auth.mechanism = AuthMechanism::Plain)),
        ("username", Box::new(|s: &mut ConnSpec| s.auth.username = Some("admin".into()))),
        ("tls", Box::new(|s: &mut ConnSpec| s.tls.mode = TlsMode::Off)),
        ("tunnel host", Box::new(|s: &mut ConnSpec| if let Tunnel::Ssh(t) = &mut s.tunnel { t.host = "other".into() })),
        ("tunnel user", Box::new(|s: &mut ConnSpec| if let Tunnel::Ssh(t) = &mut s.tunnel { t.user = "root".into() })),
        ("tunnel port", Box::new(|s: &mut ConnSpec| if let Tunnel::Ssh(t) = &mut s.tunnel { t.port = Some(22) })),
        // a key passphrase must never be offered as a bastion password, nor for another key (verifier finding)
        ("tunnel auth kind", Box::new(|s: &mut ConnSpec| if let Tunnel::Ssh(t) = &mut s.tunnel { t.auth = TunnelAuth::Password })),
        ("tunnel key file", Box::new(|s: &mut ConnSpec| if let Tunnel::Ssh(t) = &mut s.tunnel { t.key_file = Some("/home/u/.ssh/other".into()) })),
        ("tunnel kind", Box::new(|s: &mut ConnSpec| s.tunnel = Tunnel::Socks5(ProxySpec { host: "p".into(), port: 1, ..Default::default() }))),
        ("tunnel removed", Box::new(|s: &mut ConnSpec| s.tunnel = Tunnel::None)),
    ];
    for (what, f) in changes {
        let mut s = base.clone();
        f(&mut s);
        assert_ne!(id, s.secret_identity(), "{what}");
    }
}

#[test]
fn the_tunnel_serializes_as_a_tagged_object() {
    assert_eq!(serde_json::to_value(Tunnel::None).unwrap(), json!({"kind": "none"}));
    let v = serde_json::to_value(Tunnel::Socks5(ProxySpec { host: "p".into(), port: 1080, username: None, save_password: false })).unwrap();
    assert_eq!(v["kind"], "socks5");
    let back: Tunnel = serde_json::from_value(json!({"kind": "ssh", "host": "b", "user": "u"})).unwrap();
    let Tunnel::Ssh(s) = back else { panic!() };
    assert!(s.use_ssh_config && s.auth == TunnelAuth::Agent, "defaults: use ~/.ssh/config, agent auth");
}

#[test]
fn any_tunnel_is_production_level_and_the_typed_host_is_the_bastion() {
    let mut s = std_spec("127.0.0.1");
    assert_eq!(s.host_level(), EffectiveLevel::Local);
    assert_eq!(s.remote_host(), None);
    s.tunnel = Tunnel::Ssh(SshSpec { host: "Bastion.Example.com".into(), user: "u".into(), ..Default::default() });
    assert_eq!(s.host_level(), EffectiveLevel::ProductionLevel, "a bastion's 127.0.0.1 is not this computer");
    assert_eq!(s.remote_host().as_deref(), Some("bastion.example.com"));
    s.tunnel = Tunnel::Socks5(ProxySpec { host: "127.0.0.1".into(), port: 1080, ..Default::default() });
    assert_eq!(s.host_level(), EffectiveLevel::ProductionLevel);
    assert_eq!(std_spec("db.example.com").host_level(), EffectiveLevel::ProductionLevel);
    assert_eq!(spec(json!({"scheme": "srv", "hosts": [{"host": "localhost"}]})).host_level(), EffectiveLevel::ProductionLevel, "+srv is Production-level");
    assert_eq!(spec(json!({"hosts": [{"host": "[::1]", "port": 1}]})).host_level(), EffectiveLevel::Local);
}

#[test]
fn validation_table() {
    let ok = |s: &ConnSpec| assert!(s.errors().is_empty(), "{:?}", s.errors());
    ok(&std_spec("db.example.com"));
    ok(&full());
    ok(&spec(json!({"scheme": "srv", "hosts": [{"host": "cluster0.abc.mongodb.net"}]})));
    ok(&spec(json!({"hosts": [{"host": "[2001:db8::1]", "port": 27017}]})));

    let bad: Vec<(&str, Value, &str)> = vec![
        ("no host", json!({}), "host.required"),
        ("leading dash", json!({"hosts": [{"host": "-oProxyCommand=x"}]}), "host.invalid"),
        ("space in host", json!({"hosts": [{"host": "a b"}]}), "host.invalid"),
        ("newline in host", json!({"hosts": [{"host": "a\nb"}]}), "host.invalid"),
        ("port zero", json!({"hosts": [{"host": "a", "port": 0}]}), "port.range"),
        ("srv two hosts", json!({"scheme": "srv", "hosts": [{"host": "a"}, {"host": "b"}]}), "srv.oneHost"),
        ("srv with port", json!({"scheme": "srv", "hosts": [{"host": "a", "port": 1}]}), "srv.noPort"),
        ("srv direct", json!({"scheme": "srv", "hosts": [{"host": "a"}], "topology": {"directConnection": true}}), "srv.direct"),
        ("srv loadBalanced", json!({"scheme": "srv", "hosts": [{"host": "a"}], "extra": [{"key": "loadBalanced", "value": "true"}]}), "srv.loadBalanced"),
        ("db with dot", json!({"hosts": [{"host": "a"}], "database": "a.b"}), "database.invalid"),
        ("db with dollar", json!({"hosts": [{"host": "a"}], "database": "a$b"}), "database.invalid"),
        ("replica set chars", json!({"hosts": [{"host": "a"}], "topology": {"replicaSet": "rs/0"}}), "replicaSet.invalid"),
        ("app name chars", json!({"hosts": [{"host": "a"}], "appName": "a;b"}), "appName.invalid"),
        ("source chars", json!({"hosts": [{"host": "a"}], "auth": {"source": "a b"}}), "auth.sourceInvalid"),
        ("x509 source", json!({"hosts": [{"host": "a"}], "auth": {"mechanism": "x509", "source": "admin"}, "tls": {"clientCertFile": "/c"}}), "auth.sourceExternal"),
        ("x509 without cert", json!({"hosts": [{"host": "a"}], "auth": {"mechanism": "x509"}}), "tls.clientCertNeeded"),
        ("relative ca", json!({"hosts": [{"host": "a"}], "tls": {"caFile": "ca.pem"}}), "file.path"),
        ("tilde ca", json!({"hosts": [{"host": "a"}], "tls": {"caFile": "~/ca.pem"}}), "file.path"),
        ("dotdot cert", json!({"hosts": [{"host": "a"}], "tls": {"clientCertFile": "/a/../b.pem"}}), "file.path"),
        ("nul in path", json!({"hosts": [{"host": "a"}], "tls": {"caFile": "/a\u{0}b"}}), "file.path"),
        ("staleness", json!({"hosts": [{"host": "a"}], "topology": {"maxStalenessS": 30}}), "staleness.min"),
        ("duplicate compressor", json!({"hosts": [{"host": "a"}], "compressors": ["zlib", "zlib"]}), "compressor.duplicate"),
        ("zstd not compiled", json!({"hosts": [{"host": "a"}], "compressors": ["zstd"]}), "compressor.unsupported"),
        ("extra key", json!({"hosts": [{"host": "a"}], "extra": [{"key": "tlsInsecure", "value": "true"}]}), "extra.key"),
        ("extra proxy", json!({"hosts": [{"host": "a"}], "extra": [{"key": "proxyHost", "value": "x"}]}), "extra.key"),
        ("loadBalanced many hosts", json!({"hosts": [{"host": "a"}, {"host": "b"}], "extra": [{"key": "loadBalanced", "value": "true"}]}), "extra.loadBalanced"),
        ("ssh host dash", json!({"hosts": [{"host": "a"}], "tunnel": {"kind": "ssh", "host": "-oProxyCommand=x", "user": "u"}}), "ssh.host"),
        ("ssh host ipv6", json!({"hosts": [{"host": "a"}], "tunnel": {"kind": "ssh", "host": "[::1]", "user": "u"}}), "ssh.host"),
        ("ssh user dash", json!({"hosts": [{"host": "a"}], "tunnel": {"kind": "ssh", "host": "b", "user": "-x"}}), "ssh.user"),
        ("ssh user empty", json!({"hosts": [{"host": "a"}], "tunnel": {"kind": "ssh", "host": "b", "user": ""}}), "ssh.user"),
        ("ssh key without keyfile auth", json!({"hosts": [{"host": "a"}], "tunnel": {"kind": "ssh", "host": "b", "user": "u", "keyFile": "/k"}}), "ssh.keyFileAuth"),
        ("ssh keyfile auth without key", json!({"hosts": [{"host": "a"}], "tunnel": {"kind": "ssh", "host": "b", "user": "u", "auth": "keyFile"}}), "ssh.keyFileRequired"),
        ("ssh relative key", json!({"hosts": [{"host": "a"}], "tunnel": {"kind": "ssh", "host": "b", "user": "u", "auth": "keyFile", "keyFile": "id"}}), "file.path"),
        ("allowed metadata", json!({"hosts": [{"host": "a"}], "tunnel": {"kind": "ssh", "host": "b", "user": "u", "allowedHosts": [{"host": "169.254.169.254", "port": 80}]}}), "ssh.allowedLinkLocal"),
        ("allowed link local v6", json!({"hosts": [{"host": "a"}], "tunnel": {"kind": "ssh", "host": "b", "user": "u", "allowedHosts": [{"host": "fe80::1", "port": 80}]}}), "ssh.allowedHost"),
        ("allowed bad host", json!({"hosts": [{"host": "a"}], "tunnel": {"kind": "ssh", "host": "b", "user": "u", "allowedHosts": [{"host": "a b", "port": 80}]}}), "ssh.allowedHost"),
        ("proxy host", json!({"hosts": [{"host": "a"}], "tunnel": {"kind": "socks5", "host": "a b", "port": 1}}), "proxy.host"),
        ("proxy port", json!({"hosts": [{"host": "a"}], "tunnel": {"kind": "socks5", "host": "p", "port": 0}}), "port.range"),
        ("plain over tls off", json!({"hosts": [{"host": "db.example.com"}], "auth": {"mechanism": "plain", "username": "u"}, "tls": {"mode": "off"}}), "config.plainRemote"),
        ("saved scram password over tls off", json!({"hosts": [{"host": "db.example.com"}], "auth": {"username": "u", "savePassword": true}, "tls": {"mode": "off"}}), "config.plainRemote"),
        ("17 hosts", json!({"hosts": (0..17).map(|i| json!({"host": format!("h{i}")})).collect::<Vec<_>>()}), "host.count"),
    ];
    for (what, v, want) in bad {
        let s = spec(v);
        assert!(codes(&s).iter().any(|c| c == want), "{what}: wanted {want}, got {:?}", s.validate());
    }

    // not problems
    ok(&spec(json!({"hosts": [{"host": "127.0.0.1"}], "auth": {"mechanism": "plain", "username": "u", "source": "$external"}, "tls": {"mode": "off"}})));
    ok(&spec(json!({"hosts": [{"host": "db.example.com"}], "auth": {"username": "u"}, "tls": {"mode": "off"}})));
    ok(&spec(json!({"hosts": [{"host": "a"}], "extra": [{"key": "MAXPOOLSIZE", "value": "2"}]})));
    // a warning, not an error
    let w = spec(json!({"hosts": [{"host": "a"}], "topology": {"readPreference": "secondary"}}));
    assert!(w.errors().is_empty() && w.validate().iter().any(|p| p.warning && p.code == "readPref.noReplicaSet"));
}

#[test]
fn a_spec_holds_no_secret_field() {
    // by construction: serializing a populated spec never mentions a password key
    let text = serde_json::to_string(&full()).unwrap().to_lowercase();
    for k in ["\"password\"", "passphrase", "\"secret\"", "\"uri\""] {
        assert!(!text.contains(k), "{k} in {text}");
    }
}

#[test]
fn timeouts_default_to_ten_seconds_and_clamp() {
    let t = Timeouts::default();
    assert_eq!((t.connect(), t.server_selection()), (10_000, 10_000));
    assert_eq!(Timeouts { connect_ms: Some(5), server_selection_ms: Some(999_999) }.connect(), 1_000);
    assert_eq!(Timeouts { connect_ms: Some(5), server_selection_ms: Some(999_999) }.server_selection(), 60_000);
}
