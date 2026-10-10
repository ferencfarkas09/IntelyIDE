//! A file-system view that asks another machine over the `fs/query` request of the sidecar.
//!
//! A run on a server is judged against the SERVER's files. The sidecar that runs there answers `fs/query` (see
//! `sidecar/src/fsquery.ts`): a batch of ops (`canonical`, `stat`, `lstat`, `readlink`, `readdir`, `read`) in, the results in the same
//! order out. [`RpcFs`] turns each call of [`FsView`] into such a request; how the request travels is the business of an
//! [`FsTransport`] (the agent host sends it down the sidecar's pipe, tests answer it from a directory).
//!
//! A look that fails (no sidecar, a timeout, an error reply, a malformed answer) is `None`, the same as a missing file; the transport
//! remembers that it failed, and the caller that judged with this view then denies instead of trusting the answer
//! (`RemoteFs::failed` in the agent host).

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::fsview::{FsEntry, FsMeta, FsView};

/// Longest path the wire accepts.
const MAX_PATH: usize = 4096;
/// Largest text one `read` may return (the sidecar's own hard cap).
const MAX_READ: usize = 1_048_576;

/// Sends one `fs/query` request.
pub trait FsTransport: Send + Sync {
    /// `ops` has 1..=64 entries. The answer has one result per op in the same order; `None` = the request itself failed.
    fn query(&self, ops: Vec<Value>) -> Option<Vec<Value>>;
}

/// [`FsView`] over an [`FsTransport`]: one round trip per look (two for a plain `realpath`).
pub struct RpcFs<T: FsTransport> {
    transport: T,
}

impl<T: FsTransport> RpcFs<T> {
    pub fn new(transport: T) -> Self {
        Self { transport }
    }

    pub fn transport(&self) -> &T {
        &self.transport
    }

    fn arg(p: &Path) -> Option<&str> {
        p.to_str().filter(|s| p.is_absolute() && !s.is_empty() && s.len() <= MAX_PATH && !s.contains('\0'))
    }

    /// One op, answered `ok:true`.
    fn one(&self, op: &str, p: &Path, extra: Value) -> Option<Value> {
        let mut o = json!({"op": op, "path": Self::arg(p)?});
        if let (Some(e), Some(m)) = (extra.as_object(), o.as_object_mut()) {
            m.extend(e.clone());
        }
        let r = self.transport.query(vec![o])?.into_iter().next()?;
        (r["ok"] == true).then_some(r)
    }

    fn meta(r: &Value) -> FsMeta {
        let k = r["kind"].as_str().unwrap_or("other");
        FsMeta { is_file: k == "file", is_dir: k == "dir", is_symlink: k == "symlink", len: r["size"].as_u64().unwrap_or(0), executable: r["exec"].as_bool().unwrap_or(false) }
    }
}

impl<T: FsTransport> FsView for RpcFs<T> {
    fn metadata(&self, p: &Path) -> Option<FsMeta> {
        self.one("stat", p, json!({})).map(|r| Self::meta(&r))
    }

    fn symlink_metadata(&self, p: &Path) -> Option<FsMeta> {
        self.one("lstat", p, json!({})).map(|r| Self::meta(&r))
    }

    fn read_link(&self, p: &Path) -> Option<PathBuf> {
        self.one("readlink", p, json!({})).and_then(|r| r["target"].as_str().filter(|t| !t.is_empty()).map(PathBuf::from))
    }

    fn canonicalize(&self, p: &Path) -> Option<PathBuf> {
        // plain realpath = it exists (stat) and the canonical form, in one request
        let s = Self::arg(p)?;
        let r = self.transport.query(vec![json!({"op": "stat", "path": s}), json!({"op": "canonical", "path": s})])?;
        (r.first()?["ok"] == true).then(|| r.get(1)?["path"].as_str().map(PathBuf::from)).flatten()
    }

    fn canonical_lossy(&self, p: &Path) -> Option<PathBuf> {
        self.one("canonical", p, json!({})).and_then(|r| r["path"].as_str().map(PathBuf::from))
    }

    fn read_dir(&self, p: &Path) -> Option<Vec<FsEntry>> {
        let r = self.one("readdir", p, json!({}))?;
        Some(
            r["entries"]
                .as_array()?
                .iter()
                .filter_map(|e| Some(FsEntry { name: e["name"].as_str()?.to_string(), is_dir: e["kind"] == "dir", is_symlink: e["kind"] == "symlink" }))
                .collect(),
        )
    }

    fn read_to_string(&self, p: &Path, max: usize) -> Option<String> {
        self.one("read", p, json!({"max": max.clamp(1, MAX_READ)})).and_then(|r| r["text"].as_str().map(str::to_string))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Answers from a script and records what was asked.
    struct Script {
        asked: Mutex<Vec<Value>>,
        reply: Box<dyn Fn(&[Value]) -> Option<Vec<Value>> + Send + Sync>,
    }

    impl FsTransport for Script {
        fn query(&self, ops: Vec<Value>) -> Option<Vec<Value>> {
            self.asked.lock().unwrap().push(Value::Array(ops.clone()));
            (self.reply)(&ops)
        }
    }

    fn view(reply: impl Fn(&[Value]) -> Option<Vec<Value>> + Send + Sync + 'static) -> RpcFs<Script> {
        RpcFs::new(Script { asked: Mutex::new(Vec::new()), reply: Box::new(reply) })
    }

    #[test]
    fn each_call_is_the_op_of_the_contract() {
        let v = view(|ops| {
            Some(
                ops.iter()
                    .map(|o| match o["op"].as_str().unwrap() {
                        "stat" | "lstat" => json!({"ok": true, "kind": "file", "size": 12, "exec": true}),
                        "readlink" => json!({"ok": true, "target": "../x"}),
                        "canonical" => json!({"ok": true, "path": "/real/a"}),
                        "readdir" => json!({"ok": true, "entries": [{"name": "a", "kind": "dir"}, {"name": "l", "kind": "symlink"}, {"name": "f", "kind": "file"}], "truncated": false}),
                        "read" => json!({"ok": true, "text": "hello"}),
                        _ => json!({"ok": false}),
                    })
                    .collect(),
            )
        });
        let p = Path::new("/srv/a");
        assert_eq!(v.metadata(p), Some(FsMeta { is_file: true, is_dir: false, is_symlink: false, len: 12, executable: true }));
        assert!(v.symlink_metadata(p).is_some());
        assert_eq!(v.read_link(p), Some(PathBuf::from("../x")));
        assert_eq!(v.canonical_lossy(p), Some(PathBuf::from("/real/a")));
        assert_eq!(v.canonicalize(p), Some(PathBuf::from("/real/a")));
        let dir = v.read_dir(p).unwrap();
        assert_eq!(dir.iter().map(|e| (e.name.as_str(), e.is_dir, e.is_symlink)).collect::<Vec<_>>(), [("a", true, false), ("l", false, true), ("f", false, false)]);
        assert_eq!(v.read_to_string(p, 99), Some("hello".into()));
        let asked = v.transport().asked.lock().unwrap().clone();
        assert_eq!(asked[0], json!([{"op": "stat", "path": "/srv/a"}]));
        assert_eq!(asked[4], json!([{"op": "stat", "path": "/srv/a"}, {"op": "canonical", "path": "/srv/a"}]), "a plain realpath is one request");
        assert_eq!(asked[6], json!([{"op": "read", "path": "/srv/a", "max": 99}]));
    }

    #[test]
    fn a_failed_request_or_a_failed_op_is_none() {
        let down = view(|_| None);
        let p = Path::new("/srv/a");
        assert!(down.metadata(p).is_none() && down.canonicalize(p).is_none() && down.read_dir(p).is_none() && down.read_to_string(p, 10).is_none());
        let missing = view(|ops| Some(ops.iter().map(|_| json!({"ok": false, "code": "io"})).collect()));
        assert!(missing.metadata(p).is_none() && missing.canonicalize(p).is_none() && missing.read_link(p).is_none());
        // a short answer is a malformed answer
        let short = view(|_| Some(Vec::new()));
        assert!(short.metadata(p).is_none() && short.canonicalize(p).is_none());
    }

    #[test]
    fn only_absolute_sane_paths_leave_the_machine() {
        let v = view(|ops| Some(ops.iter().map(|_| json!({"ok": true, "kind": "file"})).collect()));
        assert!(v.metadata(Path::new("relative/a")).is_none());
        assert!(v.metadata(Path::new("")).is_none());
        assert!(v.metadata(Path::new(&format!("/{}", "a".repeat(5000)))).is_none());
        assert!(v.transport().asked.lock().unwrap().is_empty(), "nothing was sent");
        assert!(v.metadata(Path::new("/ok")).is_some());
    }

    #[test]
    fn a_read_is_capped_at_the_wire_limit() {
        let v = view(|ops| Some(ops.iter().map(|_| json!({"ok": true, "text": ""})).collect()));
        let _ = v.read_to_string(Path::new("/a"), usize::MAX);
        assert_eq!(v.transport().asked.lock().unwrap()[0][0]["max"], json!(MAX_READ));
    }
}
