//! A file-system view that asks another machine over the `fs/query` request of the sidecar.
//!
//! A run on a server is judged against the SERVER's files. The sidecar that runs there answers `fs/query` (see
//! `sidecar/src/fsquery.ts`): a batch of ops (`canonical`, `stat`, `lstat`, `readlink`, `readdir`, `read`) in, the results in the same
//! order out. [`RpcFs`] turns each call of [`FsView`] into such a request; how the request travels is the business of an
//! [`FsTransport`] (the agent host sends it down the sidecar's pipe, tests answer it from a directory).
//!
//! Two kinds of "no". A file that is not there, or that the server's account may not look at, is `None` and nothing more, the same as an
//! error of `std::fs`. A look that could not be answered at all (no sidecar, a timeout, an error reply, an answer that makes no sense, a
//! directory too big to list, a file too big to read) is also `None`, but it is reported with [`fsview::mark_failed`]: the decision in
//! progress then knows it did not see everything and is denied (`decide_with`). After the first failed look of a decision the rest are
//! not sent, because the decision is lost anyway and a dead link would cost a timeout for every path.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::fsview::{self, FsEntry, FsMeta, FsView};

/// Longest path the wire accepts.
const MAX_PATH: usize = 4096;
/// Largest text one `read` may return (the sidecar's own hard cap).
const MAX_READ: usize = 1_048_576;
/// Most entries one `readdir` may list (the sidecar's own hard cap). A bigger directory is a failed look, not a short list.
const MAX_ENTRIES: u64 = 100_000;

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

    /// One request, with the checks every answer needs: as many results as ops, each a JSON object. Anything else is a failed look.
    fn ask(&self, ops: Vec<Value>) -> Option<Vec<Value>> {
        if fsview::failed() {
            return None;
        }
        let n = ops.len();
        let got = self.transport.query(ops).filter(|r| r.len() == n && r.iter().all(Value::is_object));
        if got.is_none() {
            fsview::mark_failed();
        }
        got
    }

    /// One result: `ok:true` is the answer. `ok:false` is "not there" or "may not look" unless its code says that the look itself could
    /// not be done (`toobig`, `budget`: the file is there but was not read; `invalid`: the request was refused). No `ok` at all is a
    /// broken answer.
    fn settle(r: Value) -> Option<Value> {
        match r["ok"].as_bool() {
            Some(true) => Some(r),
            Some(false) => {
                if matches!(r["code"].as_str(), Some("toobig" | "budget" | "invalid")) {
                    fsview::mark_failed();
                }
                None
            }
            None => {
                fsview::mark_failed();
                None
            }
        }
    }

    /// One op, answered `ok:true`.
    fn one(&self, op: &str, p: &Path, extra: Value) -> Option<Value> {
        let mut o = json!({"op": op, "path": Self::arg(p)?});
        if let (Some(e), Some(m)) = (extra.as_object(), o.as_object_mut()) {
            m.extend(e.clone());
        }
        Self::settle(self.ask(vec![o])?.into_iter().next()?)
    }

    /// `kind`, `size` and `exec` of an `ok:true` stat; an answer without them is broken.
    fn meta(r: &Value) -> Option<FsMeta> {
        let (Some(k), Some(len), Some(executable)) = (r["kind"].as_str(), r["size"].as_u64(), r["exec"].as_bool()) else {
            fsview::mark_failed();
            return None;
        };
        Some(FsMeta { is_file: k == "file", is_dir: k == "dir", is_symlink: k == "symlink", len, executable })
    }

    /// A field every `ok:true` answer of this op must carry.
    fn field<'a>(r: &'a Value, name: &str) -> Option<&'a str> {
        let v = r[name].as_str();
        if v.is_none() {
            fsview::mark_failed();
        }
        v
    }
}

impl<T: FsTransport> FsView for RpcFs<T> {
    fn metadata(&self, p: &Path) -> Option<FsMeta> {
        self.one("stat", p, json!({})).and_then(|r| Self::meta(&r))
    }

    fn symlink_metadata(&self, p: &Path) -> Option<FsMeta> {
        self.one("lstat", p, json!({})).and_then(|r| Self::meta(&r))
    }

    fn read_link(&self, p: &Path) -> Option<PathBuf> {
        let r = self.one("readlink", p, json!({}))?;
        Self::field(&r, "target").filter(|t| !t.is_empty()).map(PathBuf::from)
    }

    fn canonicalize(&self, p: &Path) -> Option<PathBuf> {
        // plain realpath = it exists (stat) and the canonical form, in one request
        let s = Self::arg(p)?;
        let mut r = self.ask(vec![json!({"op": "stat", "path": s}), json!({"op": "canonical", "path": s})])?.into_iter();
        Self::settle(r.next()?)?;
        let canonical = Self::settle(r.next()?)?;
        Self::field(&canonical, "path").map(PathBuf::from)
    }

    fn canonical_lossy(&self, p: &Path) -> Option<PathBuf> {
        let r = self.one("canonical", p, json!({}))?;
        Self::field(&r, "path").map(PathBuf::from)
    }

    fn read_dir(&self, p: &Path) -> Option<Vec<FsEntry>> {
        let r = self.one("readdir", p, json!({"max": MAX_ENTRIES}))?;
        // a cut-off listing is not "the entries there are": a glob over it could miss the one file that matters
        let (Some(entries), false) = (r["entries"].as_array(), r["truncated"] == true) else {
            fsview::mark_failed();
            return None;
        };
        let mut out = Vec::with_capacity(entries.len());
        for e in entries {
            let Some(name) = e["name"].as_str() else {
                fsview::mark_failed();
                return None;
            };
            out.push(FsEntry { name: name.to_string(), is_dir: e["kind"] == "dir", is_symlink: e["kind"] == "symlink" });
        }
        Some(out)
    }

    fn read_to_string(&self, p: &Path, max: usize) -> Option<String> {
        let r = self.one("read", p, json!({"max": max.clamp(1, MAX_READ)}))?;
        Self::field(&r, "text").map(str::to_string)
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
        let v = view(|ops| Some(ops.iter().map(|_| json!({"ok": true, "kind": "file", "size": 1, "exec": false})).collect()));
        assert!(v.metadata(Path::new("relative/a")).is_none());
        assert!(v.metadata(Path::new("")).is_none());
        assert!(v.metadata(Path::new(&format!("/{}", "a".repeat(5000)))).is_none());
        assert!(v.transport().asked.lock().unwrap().is_empty(), "nothing was sent");
        assert!(v.metadata(Path::new("/ok")).is_some());
    }

    use crate::policy::fsview::{failed, with_fs};
    use std::sync::Arc;

    /// What a decision sees: the answers of `view`, and whether the decision was told that a look failed.
    fn judged<R>(v: RpcFs<Script>, f: impl FnOnce(&RpcFs<Script>) -> R) -> (R, bool) {
        let v: Arc<RpcFs<Script>> = Arc::new(v);
        let view: Arc<dyn FsView> = v.clone();
        with_fs(Some(view), || {
            let r = f(&v);
            (r, failed())
        })
    }

    #[test]
    fn a_look_that_could_not_be_answered_is_told_to_the_decision() {
        let p = Path::new("/srv/a");
        // no answer at all, an answer of the wrong length, one that is not an object
        for reply in [None, Some(Vec::new()), Some(vec![json!("x")])] {
            let (got, failed) = judged(view(move |_| reply.clone()), |v| v.metadata(p));
            assert!(got.is_none() && failed);
        }
        // an answer with no `ok`, and a stat that lacks what a stat carries
        let (_, failed) = judged(view(|ops| Some(ops.iter().map(|_| json!({"kind": "file"})).collect())), |v| v.metadata(p));
        assert!(failed);
        let (got, failed) = judged(view(|ops| Some(ops.iter().map(|_| json!({"ok": true, "kind": "file"})).collect())), |v| v.metadata(p));
        assert!(got.is_none() && failed);
        // the request itself was refused
        let (_, failed) = judged(view(|ops| Some(ops.iter().map(|_| json!({"ok": false, "code": "invalid"})).collect())), |v| v.metadata(p));
        assert!(failed);
    }

    #[test]
    fn a_file_that_is_not_there_is_not_a_failed_look() {
        let p = Path::new("/srv/a");
        // ENOENT, EACCES, ELOOP ... of stat, readlink, readdir and canonical: no code
        let (r, failed) = judged(view(|ops| Some(ops.iter().map(|_| json!({"ok": false})).collect())), |v| (v.metadata(p), v.read_link(p), v.read_dir(p), v.canonicalize(p), v.canonical_lossy(p)));
        assert!(r.0.is_none() && r.1.is_none() && r.2.is_none() && r.3.is_none() && r.4.is_none() && !failed);
        // a read that found nothing to read: not a file, binary, or an open that failed
        for code in ["notfile", "binary", "io"] {
            let (got, failed) = judged(view(move |ops| Some(ops.iter().map(|_| json!({"ok": false, "code": code})).collect())), |v| v.read_to_string(p, 100));
            assert!(got.is_none() && !failed, "{code}");
        }
    }

    #[test]
    fn a_file_that_is_there_but_was_not_read_is_a_failed_look() {
        let p = Path::new("/srv/.git/config");
        for code in ["toobig", "budget"] {
            let (got, failed) = judged(view(move |ops| Some(ops.iter().map(|_| json!({"ok": false, "code": code})).collect())), |v| v.read_to_string(p, 100));
            assert!(got.is_none() && failed, "{code}");
        }
    }

    #[test]
    fn a_cut_off_listing_is_a_failed_look() {
        let p = Path::new("/srv/certs");
        let (got, failed) = judged(view(|ops| Some(ops.iter().map(|_| json!({"ok": true, "entries": [{"name": "a", "kind": "file"}], "truncated": true})).collect())), |v| v.read_dir(p));
        assert!(got.is_none() && failed, "the first part of a listing is not the directory");
        let (got, failed) = judged(view(|ops| Some(ops.iter().map(|_| json!({"ok": true, "entries": [{"name": "a", "kind": "file"}, {"kind": "file"}], "truncated": false})).collect())), |v| v.read_dir(p));
        assert!(got.is_none() && failed, "an entry without a name");
        // the listing asks for the most the sidecar gives
        let v = view(|ops| Some(ops.iter().map(|_| json!({"ok": true, "entries": [], "truncated": false})).collect()));
        let (got, failed) = judged(v, |v| (v.read_dir(p), v.transport().asked.lock().unwrap()[0].clone()));
        assert!(!failed);
        assert_eq!(got.0, Some(Vec::new()));
        assert_eq!(got.1[0]["max"], json!(MAX_ENTRIES));
    }

    #[test]
    fn after_a_failed_look_the_rest_of_the_decision_asks_nothing() {
        let (asked, failed) = judged(view(|_| None), |v| {
            for i in 0..10 {
                assert!(v.metadata(Path::new(&format!("/srv/p{i}"))).is_none());
            }
            v.transport().asked.lock().unwrap().len()
        });
        assert!(failed);
        assert_eq!(asked, 1, "a dead link costs one timeout, not one per path");
    }

    #[test]
    fn outside_a_decision_nothing_is_remembered() {
        let v = view(|_| None);
        assert!(v.metadata(Path::new("/a")).is_none() && v.metadata(Path::new("/b")).is_none());
        assert_eq!(v.transport().asked.lock().unwrap().len(), 2);
        assert!(!failed());
    }

    #[test]
    fn a_read_is_capped_at_the_wire_limit() {
        let v = view(|ops| Some(ops.iter().map(|_| json!({"ok": true, "text": ""})).collect()));
        let _ = v.read_to_string(Path::new("/a"), usize::MAX);
        assert_eq!(v.transport().asked.lock().unwrap()[0][0]["max"], json!(MAX_READ));
    }
}
