//! Fixture loader for `scripts/mongo-fixture/local.sh`: reads canonical Extended JSON NDJSON files and inserts them with the
//! official driver, like `mongoimport` would. Used for the collections `mongosh` cannot load faithfully (its JS BSON turns a
//! DBPointer into a DBRef and drops `undefined`).
//!   fx_load <uri> <db> <dir> <collection>...
//! Only ever pointed at the throwaway loopback servers of local.sh: it refuses a URI whose host is not loopback.
use bson::{Bson, Document};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 5 {
        eprintln!("usage: fx_load <uri> <db> <dir> <collection>...");
        std::process::exit(2);
    }
    let info = intely_mongo::host::parse_uri(&a[1]).expect("uri");
    assert_eq!(intely_mongo::host::effective_level(&info), intely_mongo::types::EffectiveLevel::Local, "fx_load only loads loopback servers");
    let client = mongodb::Client::with_uri_str(&a[1]).await.expect("connect");
    let db = client.database(&a[2]);
    for coll in &a[4..] {
        let text = std::fs::read_to_string(format!("{}/{coll}.ndjson", a[3])).expect("read ndjson");
        let docs: Vec<Document> = text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| match Bson::try_from(serde_json::from_str::<serde_json::Value>(l).expect("json")).expect("extended json") {
                Bson::Document(d) => d,
                other => panic!("not a document: {other:?}"),
            })
            .collect();
        for chunk in docs.chunks(2000) {
            db.collection::<Document>(coll).insert_many(chunk.to_vec()).await.expect("insert");
        }
        println!("loaded {}.{coll}: {}", a[2], docs.len());
    }
}
