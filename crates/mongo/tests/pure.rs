//! Server-free tests: host classification and redaction, closed command set, explain walker (classic and slot-based
//! shapes), role classification, digest, AI validator and question filter.

use intely_mongo::ai::{self, GenReply};
use intely_mongo::digest::{self, CompactOpts};
use intely_mongo::explain;
use intely_mongo::host::{self, effective_level, parse_uri, redact};
use intely_mongo::types::{classify_connection_status, EffectiveLevel, ReadCommand, RoleChip};
use serde_json::{json, Value};

#[test]
fn any_non_loopback_host_is_production_level() {
    let local = ["mongodb://localhost/x", "mongodb://127.0.0.1:27017/x", "mongodb://[::1]:27017/x", "mongodb://user:pw@127.0.0.5/x?authSource=admin"];
    for u in local {
        assert_eq!(effective_level(&parse_uri(u).unwrap()), EffectiveLevel::Local, "{u}");
    }
    let prod = ["mongodb://db.example.com/x", "mongodb+srv://u:p@cluster0.abcd.mongodb.net/x", "mongodb://127.0.0.1,db.example.com/x", "mongodb://10.0.0.5/x", "mongodb://192.168.1.10:27017/x", "mongodb+srv://localhost/x", "mongodb://127.0.0.1.evil.example/x", "mongodb://localhost.example.com/x", "mongodb://db.localhost/x", "mongodb://0.0.0.0/x"];
    for u in prod {
        assert_eq!(effective_level(&parse_uri(u).unwrap()), EffectiveLevel::ProductionLevel, "{u}");
    }
    assert!(parse_uri("postgres://x").is_err());
    assert!(parse_uri("mongodb://").is_err());
    let i = parse_uri("mongodb://u:p%40ss@h1:1,h2:2/db?replicaSet=rs").unwrap();
    assert_eq!((i.hosts.clone(), i.has_credentials, i.database.as_deref()), (vec!["h1".to_string(), "h2".to_string()], true, Some("db")));
}

#[test]
fn redaction_canary() {
    let canary = "CANARY-s3cr3t-Pa55";
    let msgs = [
        format!("connect failed for mongodb://app:{canary}@db.example.com:27017/prod?authSource=admin: timeout"),
        format!("mongodb+srv://app:{canary}@cluster0.example.net/x and again mongodb://u:{canary}@h/y"),
        format!("error \"mongodb://u:{canary}@h\" end"),
        format!("({})", format!("mongodb://u:{canary}@h:1")),
    ];
    for m in &msgs {
        let r = redact(m);
        assert!(!r.contains(canary), "{r}");
        assert!(r.contains("***@"), "{r}");
    }
    assert_eq!(redact("no uri here, mongodb is a database"), "no uri here, mongodb is a database");
    assert_eq!(redact("mongodb://127.0.0.1:27017/x"), "mongodb://127.0.0.1:27017/x");
}

#[test]
fn command_set_is_closed_and_read_only() {
    for bad in ["insertOne", "updateMany", "deleteMany", "dropCollection", "createIndex", "runCommand", "eval", "drop", "rename"] {
        let j = json!({"cmd": bad, "db": "d", "collection": "c"});
        assert!(serde_json::from_value::<ReadCommand>(j).is_err(), "{bad} must not deserialize");
    }
    // unknown fields are refused too (no smuggling of options such as "upsert" or "$out")
    assert!(serde_json::from_value::<ReadCommand>(json!({"cmd": "find", "db": "d", "collection": "c", "upsert": true})).is_err());
    let ok: ReadCommand = serde_json::from_value(json!({"cmd": "find", "db": "d", "collection": "c", "filter": "{a: 1}"})).unwrap();
    assert_eq!(ok.kind(), "find");
    let ex: ReadCommand = serde_json::from_value(json!({"cmd": "explain", "inner": {"cmd": "aggregate", "db": "d", "collection": "c", "pipeline": "[]"}})).unwrap();
    assert_eq!(ex.kind(), "explain");
}

#[test]
fn explain_walker_classic_and_slot_based() {
    let classic = json!({"queryPlanner": {"winningPlan": {"stage": "FETCH", "inputStage": {"stage": "IXSCAN", "indexName": "status_1"}}, "rejectedPlans": [{"stage": "COLLSCAN"}]},
        "executionStats": {"nReturned": {"$numberInt": "5"}, "totalKeysExamined": {"$numberInt": "5"}, "totalDocsExamined": {"$numberLong": "5"}}});
    let s = explain::summarize(&classic);
    assert_eq!((s.collscan, s.engine.as_str(), s.rejected_plans), (false, "classic", 1));
    assert_eq!(s.stages, ["FETCH", "IXSCAN"]);
    assert_eq!((s.docs_examined, s.keys_examined, s.n_returned), (Some(5), Some(5), Some(5)));
    // 8.x shape: winningPlan.queryPlan + slotBasedPlan
    let sbe = json!({"queryPlanner": {"winningPlan": {"isCached": false, "queryPlan": {"stage": "SORT", "inputStage": {"stage": "COLLSCAN"}}, "slotBasedPlan": {"slots": "$$RESULT=s5", "stages": "[1] sort ... scan"}}}});
    let s = explain::summarize(&sbe);
    assert_eq!((s.collscan, s.engine.as_str()), (true, "sbe"));
    assert_eq!(s.stages, ["SORT", "COLLSCAN"]);
    // aggregate: $cursor wrapper and a sub-pipeline; rejected plans never count
    let agg = json!({"stages": [{"$cursor": {"queryPlanner": {"winningPlan": {"stage": "PROJECTION_SIMPLE", "inputStage": {"stage": "FETCH", "inputStage": {"stage": "IXSCAN", "indexName": "a_1"}}}}}}, {"$group": {"_id": "$a"}}]});
    let s = explain::summarize(&agg);
    assert_eq!(s.index_names, ["a_1"]);
    // $lookup-style pipelines expose several winningPlans (facet / unionWith)
    let two = json!({"stages": [{"$cursor": {"queryPlanner": {"winningPlan": {"stage": "COLLSCAN"}}}}, {"$unionWith": {"pipeline": [{"$cursor": {"queryPlanner": {"winningPlan": {"stage": "IXSCAN"}}}}]}}]});
    assert!(explain::summarize(&two).collscan);
    let big = explain::summarize(&json!({"queryPlanner": {"winningPlan": {"stage": "COLLSCAN"}}, "executionStats": {"nReturned": 3, "totalDocsExamined": 90000, "totalKeysExamined": 0}}));
    assert_eq!(explain::warnings(&big, Some(90_000)).len(), 2);
    assert!(explain::warnings(&big, Some(1_000)).iter().all(|w| !w.contains("COLLSCAN")));
}

fn status(users: Value, privs: Option<Value>) -> Value {
    let mut ai = json!({"authenticatedUsers": users, "authenticatedUserRoles": []});
    if let Some(p) = privs {
        ai["authenticatedUserPrivileges"] = p;
    }
    json!({"authInfo": ai, "ok": 1})
}

#[test]
fn role_chip_classification() {
    let user = json!([{"user": "u", "db": "admin"}]);
    // no access control at all: every action is allowed
    assert!(matches!(classify_connection_status(&status(json!([]), None)), RoleChip::CanWrite { no_auth: true, .. }));
    // read-only role
    let ro = json!([{"resource": {"db": "d", "collection": ""}, "actions": ["find", "listCollections", "listIndexes", "collStats"]}]);
    assert_eq!(classify_connection_status(&status(user.clone(), Some(ro))), RoleChip::ReadOnly);
    // readWrite
    let rw = json!([{"resource": {"db": "d", "collection": ""}, "actions": ["find", "insert", "update", "remove", "createIndex"]}]);
    match classify_connection_status(&status(user.clone(), Some(rw))) {
        RoleChip::CanWrite { actions, no_auth } => assert!(!no_auth && actions.contains(&"insert".to_string()) && actions.contains(&"createIndex".to_string())),
        o => panic!("{o:?}"),
    }
    // privileges missing or empty: unknown, never "read-only"
    assert!(matches!(classify_connection_status(&status(user.clone(), None)), RoleChip::Unknown { .. }));
    assert!(matches!(classify_connection_status(&status(user, Some(json!([])))), RoleChip::Unknown { .. }));
    assert!(matches!(classify_connection_status(&json!({"ok": 1})), RoleChip::CanWrite { no_auth: true, .. }));
}

fn status_of(i: usize) -> &'static str {
    ["open", "closed", "cancelled"][i % 3]
}

fn docs(n: usize) -> Vec<Value> {
    (0..n)
        .map(|i| {
            let mut d = json!({
                "_id": {"$oid": format!("{:024x}", i)},
                "restaurant": {"$oid": format!("{:024x}", 1000 + i % 3)},
                "createdAt": {"$date": {"$numberLong": (1_700_000_000_000i64 + i as i64 * 1000).to_string()}},
                "status": status_of(i),
                "total": if i % 25 == 0 { json!(format!("{}", 1000 + i)) } else { json!({"$numberInt": (1000 + i).to_string()}) },
                "items": [{"name": "Gulyásleves", "qty": {"$numberInt": "1"}}, {"name": "Kávé", "qty": {"$numberInt": "2"}}],
                "tip": null,
                "email": format!("p{i}@example.test"),
            });
            if i % 4 == 0 {
                d["note"] = json!("x");
            }
            d
        })
        .collect()
}

#[test]
fn digest_arrays_traps_enums_and_p1_hides_values() {
    let d = digest::build("orders", &docs(200), Some(50_000), vec![r#"{"restaurant":1}"#.into()]);
    let names = vec!["restaurants".to_string(), "orders".to_string()];
    let p1 = d.compact(&names, &CompactOpts::default());
    assert!(p1.contains("items: Array<object>"), "{p1}");
    assert!(p1.contains("items.name: Array<string>"), "{p1}");
    assert!(p1.contains("restaurant: ObjectId") && p1.contains("ref restaurants"), "{p1}");
    assert!(p1.contains("total:") && p1.contains("TRAP mixed types"), "{p1}");
    assert!(p1.contains("status: string /* 100%, enum-like, 3 values"), "{p1}");
    assert!(!p1.contains("'closed'") && !p1.contains("Gulyásleves"), "P1 must not leak values:\n{p1}");
    assert!(p1.contains("tip: null") && p1.contains("note: string /* 25%"), "{p1}");
    let p2 = d.compact(&names, &CompactOpts { include_enum_values: true, ..CompactOpts::default() });
    assert!(p2.contains("'cancelled'|'closed'|'open'"), "{p2}");
    // too few samples: nothing is called an enum
    let small = digest::build("orders", &docs(50), None, vec![]);
    assert!(!small.compact(&names, &CompactOpts::default()).contains("enum-like"));
}

fn reply(filter: &str) -> GenReply {
    GenReply { mode: "find".into(), collection: "orders".into(), filter: filter.into(), ..Default::default() }
}

#[test]
fn validator_guards_the_find_path() {
    let known = vec!["orders".to_string(), "customers".to_string()];
    let dg = digest::build("orders", &docs(200), Some(50_000), vec![]);
    let now = 1_790_000_000_000;
    let ok = ai::validate_find(&reply("{status: 'open', createdAt: {$gte: {\"$date\": \"2026-09-26T10:00:00Z\"}}}"), &known, Some(&dg), now).unwrap();
    assert_eq!(ok.limit, 50);
    // deny list at any depth, also inside $and / $expr
    for bad in ["{$where: 'sleep(10)'}", "{$and: [{$or: [{$expr: {$function: {body: 'x', args: [], lang: 'js'}}}]}]}", "{a: {$accumulator: {}}}"] {
        let e = ai::validate_find(&reply(bad), &known, None, now).unwrap_err();
        assert!(e.iter().any(|m| m.contains("not allowed")), "{bad}: {e:?}");
    }
    // structural
    assert!(ai::validate_find(&GenReply { mode: "aggregate".into(), ..reply("{}") }, &known, None, now).is_err());
    assert!(ai::validate_find(&GenReply { collection: "secrets".into(), ..reply("{}") }, &known, None, now).is_err());
    assert!(ai::validate_find(&reply("{status: }"), &known, None, now).is_err());
    // paths and types against the digest
    let e = ai::validate_find(&reply("{statuss: 'open'}"), &known, Some(&dg), now).unwrap_err();
    assert!(e[0].contains("unknown field"), "{e:?}");
    let e = ai::validate_find(&reply("{createdAt: {$gte: '2026-09-26'}}"), &known, Some(&dg), now).unwrap_err();
    assert!(e[0].contains("is Date but compared with a plain string"), "{e:?}");
    let e = ai::validate_find(&reply("{restaurant: '507f1f77bcf86cd799439011'}"), &known, Some(&dg), now).unwrap_err();
    assert!(e[0].contains("ObjectId"), "{e:?}");
    // limits and sort direction
    let v = ai::validate_find(&GenReply { limit: Some(50_000), ..reply("{}") }, &known, None, now).unwrap();
    assert_eq!(v.limit, 1000);
    assert!(!v.warnings.is_empty());
    let v = ai::validate_find(&GenReply { sort: Some("{total: -1}".into()), limit: Some(5), ..reply("{}") }, &known, Some(&dg), now).unwrap();
    assert!(v.warnings.iter().any(|w| w.contains("sort on total: mixed types")), "{:?}", v.warnings);
    assert!(ai::validate_find(&GenReply { sort: Some("{createdAt: -1}".into()), ..reply("{}") }, &known, Some(&dg), now).unwrap().warnings.is_empty());
    assert!(ai::validate_find(&GenReply { sort: Some("{createdAt: 2}".into()), ..reply("{}") }, &known, None, now).is_err());
    assert!(ai::validate_find(&GenReply { sort: Some("{createdAt: -1}".into()), ..reply("{}") }, &known, None, now).is_ok());
}

#[test]
fn question_filter_and_intent_hint() {
    let (m, kept) = ai::mask_question("Vendég info@example.test rendelései, azonosító 507f1f77bcf86cd799439011, tel +36 30 123 4567 vagy 20123456789");
    assert!(!m.contains("info@example.test") && !m.contains("507f1f77") && !m.contains("20123456789"), "{m}");
    assert!(m.contains("<email>") && m.contains("<objectid>") && m.contains("<number>"), "{m}");
    assert!(!kept.is_empty());
    let (same, none) = ai::mask_question("Az elmúlt 7 nap lezárt rendelései 10 000 Ft felett");
    assert_eq!(same, "Az elmúlt 7 nap lezárt rendelései 10 000 Ft felett");
    assert!(none.is_empty());
    assert!(ai::intent_hint("Töröld az összes sztornózott rendelést").is_some());
    assert!(ai::intent_hint("delete all cancelled orders").is_some());
    assert!(ai::intent_hint("Törölt vendégek").is_none(), "'törölt' (deleted) is a read, not a write request");
}

#[test]
fn reply_schema_is_flat_and_non_recursive() {
    let s = ai::reply_schema();
    assert_eq!(s["additionalProperties"], false);
    let props = s["properties"].as_object().unwrap();
    assert!(props.values().all(|p| p.get("$ref").is_none() && p["type"] != "object"));
    assert!(host::is_loopback_host("localhost"));
}
