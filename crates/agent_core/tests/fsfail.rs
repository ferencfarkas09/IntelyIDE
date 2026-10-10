//! A decision on a view that could not answer is denied, and one decision's failure is not lost to another that runs beside it.
//!
//! The permission broker of a run on a server asks the sidecar there for every file it needs. "The server did not reply" is not "the
//! file is not there": the second can only make a decision stricter or equal to a missing file, the first could hide a hard stop. These
//! tests pin the difference with a view that answers from a script and fails on demand.

mod common;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};

use common::bash;
use intely_agent_core::policy::decide::{session_allow_for, Decision, PolicyContext};
use intely_agent_core::policy::fsrpc::{FsTransport, RpcFs};
use intely_agent_core::policy::fsview::FsView;
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
    let intent = ToolIntent::from_claude_tool("Bash", &json!({"command": "npm run build"}));
    let c = ctx_of(&server, PermissionMode::Ask);
    // (with the link up, whatever the answer is, it is the ordinary one)
    let ordinary = session_allow_for(&c, &intent);
    server.down.store(true, Ordering::SeqCst);
    assert!(session_allow_for(&c, &intent).is_none());
    server.down.store(false, Ordering::SeqCst);
    assert_eq!(session_allow_for(&c, &intent).map(|x| x.0), ordinary.map(|x| x.0));
}

/// The mark of a failed look belongs to its decision. Two decisions run at once on two threads (the host judges every tool call on
/// a thread of its own, and Claude issues tool calls in parallel): the one whose look fails is denied however the other one goes.
#[test]
fn a_failure_is_not_lost_to_a_decision_that_runs_beside_it() {
    let server = Arc::new(Server::new());
    let (reached_tx, reached_rx) = channel::<()>();
    let reached_tx = Mutex::new(reached_tx);
    let (go_tx, go_rx) = channel::<()>();
    let go_rx = Mutex::new(go_rx);
    let first = Mutex::new(true);
    // the first request of the "slow" decision (the one that looks at /srv/work/app/slow.js) waits until the other decision is finished,
    // then fails; every other request answers
    *server.on_request.lock().unwrap() = {
        let server = server.clone();
        Arc::new(move |path: &str| {
            if path.ends_with("slow.js") && std::mem::replace(&mut *first.lock().unwrap(), false) {
                reached_tx.lock().unwrap().send(()).unwrap();
                go_rx.lock().unwrap().recv().unwrap();
                server.down.store(true, Ordering::SeqCst);
            }
        })
    };
    let slow = {
        let c = ctx_of(&server, PermissionMode::Automatic);
        std::thread::spawn(move || bash(&c, "cat slow.js"))
    };
    reached_rx.recv().unwrap();
    // the fast decision runs completely, and ends before the slow one's request fails
    let fast = bash(&ctx_of(&server, PermissionMode::Automatic), "cat a.js");
    assert_eq!(fast.decision, Decision::Allow, "{fast:?}");
    go_tx.send(()).unwrap();
    let slow = slow.join().unwrap();
    assert_eq!((slow.decision, slow.rule.as_deref()), (Decision::Deny, Some("fail-closed")), "{slow:?}");
}
