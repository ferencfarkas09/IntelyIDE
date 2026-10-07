//! Shared helpers for the integration tests: the committed cross-implementation vectors of `remote-relay/tests/fixtures/bundle-v2`,
//! a temp dist builder and a scriptable fake `Http`. Nothing here touches the network or a real Cloudflare account.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use intely_relay_bundle::manifest::Json;
use intely_relay_bundle::{BundleError, Http, HttpFuture, HttpRequest, HttpResponse, Secret};

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("repo root")
}

pub fn vectors_text() -> String {
    fs::read_to_string(repo_root().join("remote-relay/tests/fixtures/bundle-v2/vectors.json")).expect("vectors.json")
}

pub fn vectors() -> Json {
    serde_json::from_str(&vectors_text()).expect("vectors.json parses")
}

pub fn jstr(j: &Json, key: &str) -> String {
    j.get(key).and_then(Json::as_str).unwrap_or_else(|| panic!("missing string {key}")).to_owned()
}

/// `(path, bytes)` of the vector site (decoded from the base64 `files` map, bundle.json not included).
pub fn site_files(v: &Json) -> BTreeMap<String, Vec<u8>> {
    let Some(Json::Obj(kv)) = v.get("files") else { panic!("files") };
    kv.iter().map(|(k, b)| (k.clone(), STANDARD.decode(b.as_str().unwrap()).unwrap())).collect()
}

pub fn write_site(dir: &Path, files: &BTreeMap<String, Vec<u8>>) {
    for (p, b) in files {
        let t = dir.join(p);
        fs::create_dir_all(t.parent().unwrap()).unwrap();
        fs::write(t, b).unwrap();
    }
}

/// The PEM of a vector key ("A" or "B") as a `Secret` (the signer accepts PEM).
pub fn vector_key(v: &Json, name: &str) -> Secret {
    Secret::new(jstr(v.get("keys").unwrap().get(name).unwrap(), "pkcs8Pem"))
}

pub fn vector_pub(v: &Json, name: &str) -> String {
    jstr(v.get("keys").unwrap().get(name).unwrap(), "pub")
}

type Handler = Box<dyn Fn(&HttpRequest) -> Result<HttpResponse, BundleError> + Send + Sync>;

/// A scriptable `Http`: records every request, answers through a closure.
pub struct FakeHttp {
    pub log: Mutex<Vec<HttpRequest>>,
    handler: Handler,
}

impl FakeHttp {
    pub fn new(handler: impl Fn(&HttpRequest) -> Result<HttpResponse, BundleError> + Send + Sync + 'static) -> Self {
        Self { log: Mutex::new(Vec::new()), handler: Box::new(handler) }
    }
    pub fn requests(&self) -> Vec<HttpRequest> {
        self.log.lock().unwrap().clone()
    }
    pub fn paths(&self) -> Vec<String> {
        self.requests().iter().map(|r| r.url.clone()).collect()
    }
}

impl Http for FakeHttp {
    fn get(&self, req: HttpRequest) -> HttpFuture<'_> {
        self.log.lock().unwrap().push(req.clone());
        let r = (self.handler)(&req);
        Box::pin(async move { r })
    }
}

pub fn ok(body: impl Into<Vec<u8>>) -> HttpResponse {
    HttpResponse { status: 200, headers: vec![], body: body.into() }
}

pub fn status(code: u16) -> HttpResponse {
    HttpResponse { status: code, headers: vec![], body: vec![] }
}

pub fn header<'a>(req: &'a HttpRequest, name: &str) -> Option<&'a str> {
    req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

pub fn path_of(req: &HttpRequest) -> String {
    let rest = req.url.split_once("://").unwrap().1;
    rest.find('/').map(|i| rest[i..].to_owned()).unwrap_or_else(|| "/".into())
}
