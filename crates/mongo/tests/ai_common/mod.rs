//! Shared fakes for the offline AI pipeline tests: an in-memory `DbPort` that records every call, synthetic documents.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::sync::Mutex;

use intely_mongo::ai::errors::DbError;
use intely_mongo::ai::ports::{DbPort, ExplainFind, SampleKind};
use intely_mongo::explain::PlanSummary;
use serde_json::{json, Value};

pub const NOW: i64 = 1_790_000_000_000;

pub struct FakeDb {
    pub colls: BTreeMap<String, Vec<Value>>,
    pub estimated: BTreeMap<String, u64>,
    pub indexes: BTreeMap<String, Vec<String>>,
    pub calls: Mutex<Vec<String>>,
    pub plan: Mutex<Result<PlanSummary, DbError>>,
    pub explained: Mutex<Vec<ExplainFind>>,
}

impl FakeDb {
    pub fn new() -> Self {
        let mut colls = BTreeMap::new();
        colls.insert("orders".to_string(), orders(300));
        colls.insert("customers".to_string(), customers(150));
        colls.insert("restaurants".to_string(), (0..12).map(|i| json!({"_id": oid(i), "name": format!("R{i}"), "city": "Budapest"})).collect());
        let mut estimated = BTreeMap::new();
        estimated.insert("orders".to_string(), 60_000);
        estimated.insert("customers".to_string(), 2_000);
        let mut indexes = BTreeMap::new();
        indexes.insert("orders".to_string(), vec![r#"{"_id":1}"#.to_string(), r#"{"restaurant":1,"createdAt":-1}"#.to_string(), r#"{"status":1}"#.to_string()]);
        Self { colls, estimated, indexes, calls: Mutex::new(vec![]), plan: Mutex::new(Ok(PlanSummary { stages: vec!["FETCH".into(), "IXSCAN".into()], engine: "classic".into(), ..Default::default() })), explained: Mutex::new(vec![]) }
    }
    pub fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
    pub fn set_plan(&self, p: Result<PlanSummary, DbError>) {
        *self.plan.lock().unwrap() = p;
    }
}

pub fn oid(i: usize) -> Value {
    json!({"$oid": format!("{:024x}", 0x5000_0000_0000_0000_0000_0000u128 + i as u128)})
}
pub fn date(ms: i64) -> Value {
    json!({"$date": {"$numberLong": ms.to_string()}})
}

pub fn orders(n: usize) -> Vec<Value> {
    (0..n)
        .map(|i| {
            let status = ["open", "closed", "paid", "cancelled"][i % 4];
            let mut d = json!({
                "_id": oid(i), "restaurant": oid(i % 12), "status": status,
                "createdAt": date(1_780_000_000_000 + i as i64 * 3_600_000), "total": {"$numberInt": (1000 + i).to_string()},
                "items": [{"name": "Gulyás", "qty": {"$numberInt": "1"}}, {"name": "Kávé", "qty": {"$numberInt": "2"}}],
                "payments": [{"method": "card", "amount": {"$numberInt": "1000"}}],
            });
            if i % 25 == 0 {
                d["total"] = json!(format!("{}", 1000 + i));
            }
            if i % 3 == 0 {
                d["tip"] = Value::Null;
            }
            d
        })
        .collect()
}

pub fn customers(n: usize) -> Vec<Value> {
    (0..n)
        .map(|i| {
            let mut d = json!({"_id": oid(1000 + i), "restaurant": oid(i % 12), "name": format!("Kovács {i}"), "vevoNev": format!("V{i}"), "adoszam": format!("{:08}-1-42", i), "password": "x", "deleted": i % 10 == 0});
            if i % 4 != 0 {
                d["email"] = json!(format!("c{i}@example.test"));
            }
            d
        })
        .collect()
}

impl DbPort for FakeDb {
    async fn list_collections(&self) -> Result<Vec<String>, DbError> {
        self.calls.lock().unwrap().push("list_collections".into());
        Ok(self.colls.keys().cloned().collect())
    }
    async fn sample(&self, c: &str, k: SampleKind) -> Result<Vec<Value>, DbError> {
        self.calls.lock().unwrap().push(format!("sample:{c}:{k:?}"));
        let docs = self.colls.get(c).cloned().unwrap_or_default();
        Ok(match k {
            SampleKind::Random(n) => docs.into_iter().step_by(2).take(n).collect(),
            SampleKind::Latest(n) => docs.into_iter().rev().take(n).collect(),
        })
    }
    async fn indexes(&self, c: &str) -> Result<Vec<String>, DbError> {
        self.calls.lock().unwrap().push(format!("indexes:{c}"));
        Ok(self.indexes.get(c).cloned().unwrap_or_default())
    }
    async fn estimated_count(&self, c: &str) -> Result<u64, DbError> {
        self.calls.lock().unwrap().push(format!("count:{c}"));
        Ok(self.estimated.get(c).copied().unwrap_or(0))
    }
    async fn explain_find(&self, q: &ExplainFind) -> Result<PlanSummary, DbError> {
        self.calls.lock().unwrap().push(format!("explain:{}", q.collection));
        self.explained.lock().unwrap().push(q.clone());
        self.plan.lock().unwrap().clone()
    }
}

pub fn reply(coll: &str, filter: &str) -> Value {
    json!({"mode": "find", "collection": coll, "filter": filter, "explanation": "ok"})
}
