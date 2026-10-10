//! A decision on a view that could not answer is denied, and one decision's failure is not lost to another that runs beside it.
//!
//! The permission broker of a run on a server asks the sidecar there for every file it needs. "The server did not reply" is not "the
//! file is not there": the second can only make a decision stricter or equal to a missing file, the first could hide a hard stop. These
//! tests pin the difference with a view that answers from a script and fails on demand.

mod common;

use std::path::PathBuf;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::bash;
use intely_agent_core::policy::decide::{session_allow_for, Decision, PolicyContext};
use intely_agent_core::policy::fsrpc::{FsTransport, RpcFs};
use intely_agent_core::policy::fsview::{self, FsEntry, FsMeta, FsView};
use intely_agent_core::policy::intent::ToolIntent;
use intely_agent_core::providers::PermissionMode;
use serde_json::{json, Value};

/// The sidecar side of `fs/query`, cut down to a tree of a few files; `down` makes every request fail like a dead link.
struct Server {
    down: AtomicBool,
    /// Called with the first path of every request; a test uses it to hold a request in flight.
    on_request: Mutex<Arc<dyn Fn(&str) + Send + Sync>>,
    /// Directory listings: (path, entries, truncated).
    dirs: Vec<(&'static str, Vec<(&'static str, &'static str)>, bool)>,
    files: Vec<(&'static str, &'static str)>,
}

impl Server {
    fn new() -> Self {
        Self {
            down: AtomicBool::new(false),
            on_request: Mutex::new(Arc::new(|_| {})),
            dirs: vec![("/srv/work/app", vec![(".env", "file"), ("a.js", "file")], false)],
            files: vec![("/srv/work/app/a.js", "export const a = 1;\n"), ("/srv/work/app/.env", "SECRET=1\n")],
        }
    }

    fn op(&self, o: &Value) -> Value {
        let p = o["path"].as_str().unwrap_or_default();
        let is_dir = self.dirs.iter().any(|d| d.0 == p) || p == "/srv" || p == "/srv/work" || p == "/";
        let file = self.files.iter().find(|f| f.0 == p);
        match o["op"].as_str().unwrap_or_default() {
            "stat" | "lstat" if is_dir => json!({"ok": true, "kind": "dir", "size": 0, "exec": true}),
            "stat" | "lstat" => file.map(|f| json!({"ok": true, "kind": "file", "size": f.1.len(), "exec": false})).unwrap_or(json!({"ok": false})),
            "canonical" => json!({"ok": true, "path": p}),
            "readlink" => json!({"ok": false}),
            "readdir" => match self.dirs.iter().find(|d| d.0 == p) {
                Some((_, entries, truncated)) => json!({"ok": true, "entries": entries.iter().map(|(n, k)| json!({"name": n, "kind": k})).collect::<Vec<_>>(), "truncated": truncated}),
                None => json!({"ok": false}),
            },
            "read" => file.map(|f| json!({"ok": true, "text": f.1})).unwrap_or(json!({"ok": false, "code": "io"})),
            _ => json!({"ok": false, "code": "invalid"}),
        }
    }
}

struct Wire(Arc<Server>);

impl FsTransport for Wire {
    fn query(&self, ops: Vec<Value>) -> Option<Vec<Value>> {
        let first = ops[0]["path"].as_str().unwrap_or_default().to_string();
        let hook = self.0.on_request.lock().unwrap().clone();
        hook(&first);
        if self.0.down.load(Ordering::SeqCst) {
            return None;
        }
        Some(ops.iter().map(|o| self.0.op(o)).collect())
    }
}

fn ctx_of(server: &Arc<Server>, mode: PermissionMode) -> PolicyContext {
    let fs: Arc<dyn FsView> = Arc::new(RpcFs::new(Wire(server.clone())));
    let mut c = PolicyContext::new(mode, "/srv/work/app").with_fs(fs);
    c.home = Some(PathBuf::from("/home/u"));
    c
}

#[test]
fn a_view_that_answers_gives_the_ordinary_decisions() {
    let server = Arc::new(Server::new());
    let c = ctx_of(&server, PermissionMode::Automatic);
    assert_eq!(bash(&c, "cat a.js").decision, Decision::Allow);
    let d = bash(&c, "cat .e*");
    assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("read.never-read")), "{d:?}");
}

#[test]
fn a_dead_link_denies_instead_of_judging_a_tree_nobody_saw() {
    let server = Arc::new(Server::new());
    server.down.store(true, Ordering::SeqCst);
    for mode in [PermissionMode::Automatic, PermissionMode::Edit, PermissionMode::Ask] {
        let c = ctx_of(&server, mode);
        let d = bash(&c, "cat a.js");
        assert_eq!(d.decision, Decision::Deny, "{mode:?}: {d:?}");
        assert_eq!(d.rule.as_deref(), Some("fail-closed"), "{mode:?}: {d:?}");
    }
    // the same context with the link up is allowed again: nothing stuck
    server.down.store(false, Ordering::SeqCst);
    assert_eq!(bash(&ctx_of(&server, PermissionMode::Automatic), "cat a.js").decision, Decision::Allow);
}

#[test]
fn a_denial_that_the_rules_gave_stays_what_it_was() {
    let server = Arc::new(Server::new());
    let c = ctx_of(&server, PermissionMode::Automatic);
    // a hard stop that needs no file: the link is down, the reason is the hard stop's
    server.down.store(true, Ordering::SeqCst);
    let d = bash(&c, "git push origin main");
    assert_eq!(d.decision, Decision::Deny);
    assert_ne!(d.rule.as_deref(), Some("fail-closed"), "{d:?}");
}

#[test]
fn a_cut_off_listing_is_not_a_complete_glob() {
    let mut s = Server::new();
    // the listing stops before `.env`: the glob would expand to nothing and the secret would be read
    s.dirs = vec![("/srv/work/app", vec![("a.js", "file")], true)];
    let server = Arc::new(s);
    let d = bash(&ctx_of(&server, PermissionMode::Automatic), "cat .e*");
    assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("fail-closed")), "{d:?}");
}

#[test]
fn a_session_allow_is_not_offered_on_a_half_seen_tree() {
    let server = Arc::new(Server::new());
    // `mkdir` inside the folder asks in Ask mode, and "allow always in this session" is on offer for it
    let intent = ToolIntent::exec("mkdir src/new");
    let c = ctx_of(&server, PermissionMode::Ask);
    let ordinary = session_allow_for(&c, &intent);
    assert!(ordinary.is_some(), "with the link up the offer is made, otherwise this test proves nothing");
    server.down.store(true, Ordering::SeqCst);
    assert!(session_allow_for(&c, &intent).is_none(), "nothing is offered on a tree that could not be seen");
    server.down.store(false, Ordering::SeqCst);
    assert_eq!(session_allow_for(&c, &intent).map(|x| x.0), ordinary.map(|x| x.0));
}

/// One view for every decision of a run, as the host has it. The first look at a path with "slow" in it fails (and says so); the next one
/// waits until the test lets it go; everything else is answered by the server double.
struct Gated {
    inner: RpcFs<Wire>,
    slow_looks: Arc<AtomicUsize>,
    failed: Mutex<std::sync::mpsc::Sender<()>>,
    release: Mutex<std::sync::mpsc::Receiver<()>>,
    released: AtomicBool,
}

impl Gated {
    /// `true` = this look must fail.
    fn fails(&self, p: &Path) -> bool {
        if !p.to_string_lossy().contains("slow") {
            return false;
        }
        match self.slow_looks.fetch_add(1, Ordering::SeqCst) {
            0 => {
                fsview::mark_failed();
                self.failed.lock().unwrap().send(()).unwrap();
                true
            }
            _ => {
                if !self.released.load(Ordering::SeqCst) {
                    let _ = self.release.lock().unwrap().recv_timeout(Duration::from_secs(10));
                    self.released.store(true, Ordering::SeqCst);
                }
                false
            }
        }
    }
}

impl FsView for Gated {
    fn metadata(&self, p: &Path) -> Option<FsMeta> {
        if self.fails(p) { None } else { self.inner.metadata(p) }
    }
    fn symlink_metadata(&self, p: &Path) -> Option<FsMeta> {
        if self.fails(p) { None } else { self.inner.symlink_metadata(p) }
    }
    fn read_link(&self, p: &Path) -> Option<PathBuf> {
        if self.fails(p) { None } else { self.inner.read_link(p) }
    }
    fn canonicalize(&self, p: &Path) -> Option<PathBuf> {
        if self.fails(p) { None } else { self.inner.canonicalize(p) }
    }
    fn canonical_lossy(&self, p: &Path) -> Option<PathBuf> {
        if self.fails(p) { None } else { self.inner.canonical_lossy(p) }
    }
    fn read_dir(&self, p: &Path) -> Option<Vec<FsEntry>> {
        if self.fails(p) { None } else { self.inner.read_dir(p) }
    }
    fn read_to_string(&self, p: &Path, max: usize) -> Option<String> {
        if self.fails(p) { None } else { self.inner.read_to_string(p, max) }
    }
}

/// The mark of a failed look belongs to its decision. Claude issues tool calls in parallel and the host judges each on a thread of its
/// own, all through ONE view. A decision whose look failed must still be denied when another decision of the same run starts and ends
/// after the failure and before the first one is done (a flag in the shared view, cleared at the start of a decision, loses the mark here).
#[test]
fn a_failure_is_not_lost_to_a_decision_that_runs_beside_it() {
    let server = Arc::new(Server::new());
    let (failed_tx, failed_rx) = channel::<()>();
    let (release_tx, release_rx) = channel::<()>();
    let slow_looks = Arc::new(AtomicUsize::new(0));
    let view: Arc<dyn FsView> = Arc::new(Gated {
        inner: RpcFs::new(Wire(server)),
        slow_looks: slow_looks.clone(),
        failed: Mutex::new(failed_tx),
        release: Mutex::new(release_rx),
        released: AtomicBool::new(false),
    });
    let mut ctx = PolicyContext::new(PermissionMode::Automatic, "/srv/work/app").with_fs(view);
    ctx.home = Some(PathBuf::from("/home/u"));

    let slow = {
        let ctx = ctx.clone();
        std::thread::spawn(move || bash(&ctx, "cat slow.js"))
    };
    failed_rx.recv_timeout(Duration::from_secs(10)).expect("the slow decision made its failing look");
    // wait until the slow decision stands in a second look (it waits there for the release): only then do the two decisions overlap
    let until = std::time::Instant::now() + Duration::from_secs(10);
    while slow_looks.load(Ordering::SeqCst) < 2 {
        assert!(std::time::Instant::now() < until, "the slow decision made no second look, so this test would prove nothing");
        std::thread::sleep(Duration::from_millis(5));
    }
    // another decision of the same run, on the same view, starts and ends while the first is still in flight
    let fast = bash(&ctx, "cat a.js");
    assert_eq!(fast.decision, Decision::Allow, "{fast:?}");
    release_tx.send(()).unwrap();
    let slow = slow.join().unwrap();
    assert_eq!((slow.decision, slow.rule.as_deref()), (Decision::Deny, Some("fail-closed")), "{slow:?}");
}
