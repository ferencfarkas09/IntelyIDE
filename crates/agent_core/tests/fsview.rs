//! The policy looks at the files of the run through `FsView` (a remote server's files, reached over an RPC).
//!
//! Three things are pinned here: the policy honours an injected view (an in-memory tree with paths that do not exist on this machine),
//! the `fs/query` wire contract is enough for the whole policy (a view that serializes every call into the JSON ops and answers them from
//! a real directory gives the same decisions as the local file system), and a decision costs few round trips.

mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use common::bash;
use intely_agent_core::policy::decide::{Decision, PolicyContext};
use intely_agent_core::policy::fsview::{self, FsEntry, FsMeta, FsView};
use intely_agent_core::policy::paths;
use intely_agent_core::providers::PermissionMode;
use serde_json::{json, Value};

// ---------------------------------------------------------------------------------------------------------------------------------
// MemFs: an in-memory tree

enum Node {
    Dir,
    File { text: String, exec: bool },
    Link(PathBuf),
}

#[derive(Default)]
struct MemFs {
    nodes: BTreeMap<PathBuf, Node>,
}

impl MemFs {
    fn new() -> Self {
        let mut m = Self::default();
        m.nodes.insert(PathBuf::from("/"), Node::Dir);
        m
    }

    fn dir(mut self, p: &str) -> Self {
        let mut cur = PathBuf::from("/");
        for c in Path::new(p).components().skip(1) {
            cur.push(c);
            self.nodes.entry(cur.clone()).or_insert(Node::Dir);
        }
        self
    }

    fn file(self, p: &str, text: &str) -> Self {
        self.put(p, Node::File { text: text.into(), exec: false })
    }

    fn exe(self, p: &str, text: &str) -> Self {
        self.put(p, Node::File { text: text.into(), exec: true })
    }

    fn link(self, p: &str, target: &str) -> Self {
        self.put(p, Node::Link(PathBuf::from(target)))
    }

    fn put(mut self, p: &str, n: Node) -> Self {
        self = self.dir(Path::new(p).parent().unwrap().to_str().unwrap());
        self.nodes.insert(PathBuf::from(p), n);
        self
    }

    /// Walks `p` like a kernel: links in the middle are always followed, the last one only when `follow_last`.
    fn walk(&self, p: &Path, follow_last: bool) -> Option<(PathBuf, &Node)> {
        if !p.is_absolute() {
            return None;
        }
        let mut work: Vec<PathBuf> = p.components().rev().map(|c| PathBuf::from(c.as_os_str())).collect();
        let mut out = PathBuf::new();
        let mut hops = 0;
        while let Some(c) = work.pop() {
            match Path::new(&c).components().next() {
                Some(std::path::Component::RootDir) => out = PathBuf::from("/"),
                Some(std::path::Component::ParentDir) => {
                    out.pop();
                }
                Some(std::path::Component::Normal(name)) => {
                    if !matches!(self.nodes.get(&out), Some(Node::Dir)) {
                        return None;
                    }
                    let cand = out.join(name);
                    match self.nodes.get(&cand)? {
                        Node::Link(t) if follow_last || !work.is_empty() => {
                            hops += 1;
                            if hops > 40 {
                                return None;
                            }
                            if t.is_absolute() {
                                out = PathBuf::from("/");
                            }
                            work.extend(t.components().rev().map(|c| PathBuf::from(c.as_os_str())));
                        }
                        _ => out = cand,
                    }
                }
                _ => {}
            }
        }
        self.nodes.get(&out).map(|n| (out, n))
    }

    fn meta(n: &Node) -> FsMeta {
        match n {
            Node::Dir => FsMeta { is_dir: true, executable: true, ..FsMeta::default() },
            Node::File { text, exec } => FsMeta { is_file: true, len: text.len() as u64, executable: *exec, ..FsMeta::default() },
            Node::Link(_) => FsMeta { is_symlink: true, ..FsMeta::default() },
        }
    }
}

impl FsView for MemFs {
    fn metadata(&self, p: &Path) -> Option<FsMeta> {
        self.walk(p, true).map(|(_, n)| Self::meta(n))
    }
    fn symlink_metadata(&self, p: &Path) -> Option<FsMeta> {
        self.walk(p, false).map(|(_, n)| Self::meta(n))
    }
    fn read_link(&self, p: &Path) -> Option<PathBuf> {
        match self.walk(p, false)? {
            (_, Node::Link(t)) => Some(t.clone()),
            _ => None,
        }
    }
    fn canonicalize(&self, p: &Path) -> Option<PathBuf> {
        self.walk(p, true).map(|(real, _)| real)
    }
    fn read_dir(&self, p: &Path) -> Option<Vec<FsEntry>> {
        let (real, n) = self.walk(p, true)?;
        if !matches!(n, Node::Dir) {
            return None;
        }
        Some(
            self.nodes
                .iter()
                .filter(|(k, _)| k.parent() == Some(real.as_path()) && *k != &real)
                .map(|(k, n)| FsEntry { name: k.file_name().unwrap().to_string_lossy().into_owned(), is_dir: matches!(n, Node::Dir), is_symlink: matches!(n, Node::Link(_)) })
                .collect(),
        )
    }
    fn read_to_string(&self, p: &Path, max: usize) -> Option<String> {
        match self.walk(p, true)? {
            (_, Node::File { text, .. }) if text.len() <= max => Some(text.clone()),
            _ => None,
        }
    }
}

fn mem_ctx(mode: PermissionMode, cwd: &str, fs: MemFs) -> PolicyContext {
    let mut c = PolicyContext::new(mode, cwd).with_fs(Arc::new(fs));
    c.home = Some(PathBuf::from("/home/u"));
    c
}

fn work_tree() -> MemFs {
    MemFs::new()
        .file("/srv/work/backend/.env", "SECRET=1\n")
        .file("/srv/work/backend/package.json", r#"{"scripts":{"build":"node build.js"}}"#)
        .file("/srv/work/backend/src/a.js", "export const a = 1;\n")
        .file("/srv/work/backend/src/b.js", "export const b = 2;\n")
        .exe("/srv/work/backend/scripts/x.sh", "#!/bin/sh\necho hi\ngit push origin main\n")
        .exe("/srv/work/backend/scripts/ok.sh", "#!/bin/sh\necho fine\n")
        .file("/srv/work/backend/build.js", "console.log('build');\n")
        .file("/srv/secrets/data.txt", "top secret\n")
        .link("/srv/work/backend/out", "/srv/secrets")
        .link("/srv/work/backend/inside", "src")
        .file("/srv/work/admin/index.js", "x\n")
}

#[test]
fn the_policy_reads_the_injected_files_not_this_machine() {
    // none of these paths exist here
    assert!(!Path::new("/srv/work/backend").exists());
    let c = mem_ctx(PermissionMode::Automatic, "/srv/work/backend", work_tree());

    // a glob that the shell expands to `.env`
    let d = bash(&c, "cat .e*");
    assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("read.never-read")), "{d:?}");
    // the same command on a view without the file is judged as what it is: a read of nothing
    let empty = mem_ctx(PermissionMode::Automatic, "/srv/work/backend", MemFs::new().dir("/srv/work/backend"));
    assert_ne!(bash(&empty, "cat .e*").rule.as_deref(), Some("read.never-read"));

    // a script whose text pushes
    let d = bash(&c, "bash scripts/x.sh");
    assert_eq!(d.decision, Decision::Deny, "{d:?}");
    assert!(d.rule.as_deref().is_some_and(|r| r.starts_with("git")), "{d:?}");
    let d = bash(&c, "bash scripts/ok.sh");
    assert_eq!(d.decision, Decision::Allow, "{d:?}");
    let d = bash(&c, "./scripts/x.sh");
    assert_eq!(d.decision, Decision::Deny, "{d:?}");

    // a link inside the folder that leads outside it
    let d = bash(&c, "cat out/data.txt");
    assert_eq!(d.decision, Decision::Deny, "{d:?}");
    assert!(d.reason.contains("outside"), "{d:?}");
    // a link that stays inside is fine
    let d = bash(&c, "cat inside/a.js");
    assert_eq!(d.decision, Decision::Allow, "{d:?}");
}

#[test]
fn cd_into_a_directory_of_the_view_then_a_relative_read() {
    let c = mem_ctx(PermissionMode::Automatic, "/srv/work/backend", work_tree());
    assert_eq!(bash(&c, "cd src && cat a.js").decision, Decision::Allow);
    // `cd` only counts for a folder that exists in the view: the secret is reached through the new directory
    let d = bash(&c, "cd /srv/work/backend && cat .env");
    assert_eq!(d.decision, Decision::Deny, "{d:?}");
    assert_eq!(bash(&c, "cd ../admin && cat index.js").decision, Decision::Deny, "admin is not a run folder here");
    let mut c2 = c.clone();
    c2.add_dirs = vec![PathBuf::from("/srv/work/admin")];
    assert_eq!(bash(&c2, "cd ../admin && cat index.js").decision, Decision::Allow);
    assert_eq!(bash(&c2, "cat ../admin/*.js").decision, Decision::Allow);
}

#[test]
fn resolution_and_the_local_only_checks_follow_the_view() {
    let c = mem_ctx(PermissionMode::Automatic, "/srv/work/backend", work_tree());
    let fs = c.fs.clone();
    fsview::with_fs(fs, || {
        assert!(!fsview::is_local());
        assert_eq!(paths::canonical_lossy(Path::new("/srv/work/backend/out/data.txt")), PathBuf::from("/srv/secrets/data.txt"));
        assert_eq!(paths::canonical_lossy(Path::new("/srv/work/backend/inside/../build.js")), PathBuf::from("/srv/work/backend/build.js"));
        assert_eq!(paths::canonical_lossy(Path::new("/srv/work/backend/nope/x")), PathBuf::from("/srv/work/backend/nope/x"));
    });
    assert!(fsview::is_local());
}

#[test]
fn a_context_with_a_view_prints_and_compares() {
    let a = mem_ctx(PermissionMode::Automatic, "/srv/work/backend", MemFs::new());
    assert!(format!("{a:?}").contains("FsView"));
    assert_eq!(a, a.clone());
    let b = mem_ctx(PermissionMode::Automatic, "/srv/work/backend", MemFs::new());
    assert_ne!(a, b);
    let json = serde_json::to_string(&a).unwrap();
    assert!(!json.contains("fs\""));
    let back: PolicyContext = serde_json::from_str(&json).unwrap();
    assert!(back.fs.is_none());
}

#[test]
fn the_scope_is_entered_on_the_thread_that_judges() {
    let c = mem_ctx(PermissionMode::Automatic, "/srv/work/backend", work_tree());
    let d = std::thread::spawn(move || bash(&c, "cat .e*")).join().unwrap();
    assert_eq!(d.rule.as_deref(), Some("read.never-read"));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// JsonFs: every call becomes the `fs/query` ops of the wire contract and is answered from a real directory

/// The sidecar side of `fs/query`: answers one op from this machine's files.
fn serve_op(op: &Value) -> Value {
    let path = op["path"].as_str().map(PathBuf::from);
    let Some(path) = path.filter(|p| p.is_absolute() && p.as_os_str().len() <= 4096) else { return json!({"ok": false}) };
    let kind = |m: &std::fs::Metadata| {
        use std::os::unix::fs::PermissionsExt;
        let t = m.file_type();
        let k = if t.is_symlink() {
            "symlink"
        } else if t.is_dir() {
            "dir"
        } else if t.is_file() {
            "file"
        } else {
            "other"
        };
        json!({"ok": true, "kind": k, "size": m.len(), "exec": m.permissions().mode() & 0o111 != 0})
    };
    match op["op"].as_str().unwrap_or_default() {
        "canonical" => json!({"ok": true, "path": fsview::with_fs(None, || paths::canonical_lossy(&path)).to_string_lossy()}),
        "stat" => std::fs::metadata(&path).map(|m| kind(&m)).unwrap_or(json!({"ok": false})),
        "lstat" => std::fs::symlink_metadata(&path).map(|m| kind(&m)).unwrap_or(json!({"ok": false})),
        "readlink" => std::fs::read_link(&path).map(|t| json!({"ok": true, "target": t.to_string_lossy()})).unwrap_or(json!({"ok": false})),
        "readdir" => {
            let max = op["max"].as_u64().unwrap_or(20000) as usize;
            let Ok(rd) = std::fs::read_dir(&path) else { return json!({"ok": false}) };
            let mut entries = Vec::new();
            let mut truncated = false;
            for e in rd.flatten() {
                if entries.len() >= max {
                    truncated = true;
                    break;
                }
                let k = e.file_type().map(|t| if t.is_symlink() { "symlink" } else if t.is_dir() { "dir" } else if t.is_file() { "file" } else { "other" }).unwrap_or("other");
                entries.push(json!({"name": e.file_name().to_string_lossy(), "kind": k}));
            }
            json!({"ok": true, "entries": entries, "truncated": truncated})
        }
        "read" => {
            let max = (op["max"].as_u64().unwrap_or(262_144) as usize).min(1_048_576);
            match std::fs::metadata(&path) {
                Ok(m) if !m.is_file() => json!({"ok": false, "code": "notfile"}),
                Ok(m) if m.len() as usize > max => json!({"ok": false, "code": "toobig"}),
                Ok(_) => match std::fs::read(&path) {
                    Ok(b) => String::from_utf8(b).map(|t| json!({"ok": true, "text": t})).unwrap_or(json!({"ok": false, "code": "binary"})),
                    Err(_) => json!({"ok": false, "code": "io"}),
                },
                Err(_) => json!({"ok": false, "code": "io"}),
            }
        }
        _ => json!({"ok": false}),
    }
}

fn serve(request: &str) -> String {
    let req: Value = serde_json::from_str(request).unwrap();
    let ops = req["ops"].as_array().unwrap();
    assert!((1..=64).contains(&ops.len()));
    json!({"results": ops.iter().map(serve_op).collect::<Vec<_>>()}).to_string()
}

#[derive(Default)]
struct JsonFs {
    requests: AtomicUsize,
    ops: AtomicUsize,
    log: Mutex<Vec<String>>,
}

impl JsonFs {
    /// One request (one round trip) with these ops; the reply is parsed from its JSON text.
    fn query(&self, ops: Vec<Value>) -> Vec<Value> {
        self.requests.fetch_add(1, Ordering::SeqCst);
        self.ops.fetch_add(ops.len(), Ordering::SeqCst);
        self.log.lock().unwrap().extend(ops.iter().map(|o| format!("{} {}", o["op"].as_str().unwrap(), o["path"].as_str().unwrap_or(""))));
        let reply = serve(&json!({ "ops": ops }).to_string());
        let reply: Value = serde_json::from_str(&reply).unwrap();
        reply["results"].as_array().unwrap().clone()
    }

    fn one(&self, op: &str, p: &Path, extra: Value) -> Option<Value> {
        let p = p.to_str().filter(|s| p.is_absolute() && s.len() <= 4096)?;
        let mut o = json!({"op": op, "path": p});
        if let (Some(e), Some(m)) = (extra.as_object(), o.as_object_mut()) {
            m.extend(e.clone());
        }
        let r = self.query(vec![o]).into_iter().next()?;
        (r["ok"] == true).then_some(r)
    }

    fn meta(r: &Value) -> FsMeta {
        let k = r["kind"].as_str().unwrap_or("other");
        FsMeta { is_file: k == "file", is_dir: k == "dir", is_symlink: k == "symlink", len: r["size"].as_u64().unwrap_or(0), executable: r["exec"].as_bool().unwrap_or(false) }
    }
}

impl FsView for JsonFs {
    fn metadata(&self, p: &Path) -> Option<FsMeta> {
        self.one("stat", p, json!({})).map(|r| Self::meta(&r))
    }
    fn symlink_metadata(&self, p: &Path) -> Option<FsMeta> {
        self.one("lstat", p, json!({})).map(|r| Self::meta(&r))
    }
    fn read_link(&self, p: &Path) -> Option<PathBuf> {
        self.one("readlink", p, json!({})).and_then(|r| r["target"].as_str().map(PathBuf::from))
    }
    fn canonicalize(&self, p: &Path) -> Option<PathBuf> {
        // plain realpath = stat + canonical, in one request
        let s = p.to_str().filter(|s| p.is_absolute() && s.len() <= 4096)?;
        let r = self.query(vec![json!({"op": "stat", "path": s}), json!({"op": "canonical", "path": s})]);
        (r[0]["ok"] == true).then(|| r[1]["path"].as_str().map(PathBuf::from)).flatten()
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
                .map(|e| FsEntry { name: e["name"].as_str().unwrap_or_default().to_string(), is_dir: e["kind"] == "dir", is_symlink: e["kind"] == "symlink" })
                .collect(),
        )
    }
    fn read_to_string(&self, p: &Path, max: usize) -> Option<String> {
        self.one("read", p, json!({"max": max.min(1_048_576)})).and_then(|r| r["text"].as_str().map(str::to_string))
    }
}

struct World {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

fn world() -> World {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    for d in [
        "backend/src/api/models",
        "backend/src/api/controllers",
        "backend/scripts",
        "backend/.git/hooks",
        "backend/node_modules/x",
        "admin/src/localization",
        "admin/src/components/pages/stock",
        "outside",
        "userdir",
    ] {
        std::fs::create_dir_all(root.join(d)).unwrap();
    }
    let w = |rel: &str, text: &str| std::fs::write(root.join(rel), text).unwrap();
    w("backend/package.json", r#"{"scripts":{"build":"node scripts/build.mjs","push":"git push","test":"node --test"}}"#);
    w("backend/.env", "SECRET=1\n");
    w("backend/.env.local", "SECRET=2\n");
    w("backend/Makefile", "build:\n\tnode scripts/build.mjs\npublish:\n\tgit push origin main\n");
    w("backend/src/api/models/customer.model.js", "const a = 1;\nconst link = 'x';\n");
    w("backend/src/api/models/mailbox.model.js", "const b = 2;\n");
    w("backend/src/api/controllers/x.js", "export {};\n");
    w("backend/scripts/build.mjs", "console.log('build');\n");
    w("backend/scripts/ok.sh", "#!/bin/sh\necho fine\nls\n");
    w("backend/scripts/push.sh", "#!/bin/sh\ngit push origin main\n");
    w("backend/scripts/spawn.py", "import subprocess\nsubprocess.run(['git', 'status'])\n");
    w("backend/scripts/big.txt", &"x".repeat(300_000));
    w("backend/node_modules/x/index.js", "x\n");
    w("admin/src/localization/index.js", "export default {};\n");
    w("admin/src/Router.js", "export default [];\n");
    w("admin/src/components/pages/stock/index.js", "import x from 'y';\n");
    w("outside/secret.txt", "secret\n");
    w("outside.txt", "secret\n");
    std::os::unix::fs::symlink(root.join("outside"), root.join("backend/out")).unwrap();
    std::os::unix::fs::symlink(root.join("outside/secret.txt"), root.join("backend/leak.txt")).unwrap();
    std::os::unix::fs::symlink("src/api", root.join("backend/api")).unwrap();
    std::os::unix::fs::symlink("../.git", root.join("backend/src/g")).unwrap();
    std::os::unix::fs::symlink(root.join("backend/missing"), root.join("backend/dangling")).unwrap();
    World { _dir: dir, root }
}

fn context(w: &World, mode: PermissionMode) -> PolicyContext {
    let mut c = PolicyContext::new(mode, w.root.join("backend"));
    c.add_dirs = vec![w.root.join("admin")];
    c.home = Some(w.root.join("userdir"));
    c.scratch_dirs = vec![w.root.join("outside")];
    c
}

/// Representative commands of `automatic_everyday.rs` and `readonly_everyday.rs` (copied), plus the shapes that need the files: globs,
/// scripts, links, `cd`, make targets and package scripts.
const CORPUS: &[&str] = &[
    "cd {admin}/src/localization && sed -n 140,175p index.js; cd ../components/pages/stock; ls .; grep -rniE \"minStock|lowStock\" ../../../../../../backend/src/api/models/*.js | head",
    "cd {backend}/src/api && sed -n 8,30p models/customer.model.js | grep -nE \"^\\s+\\w+:\"; grep -n \"build\" ../../package.json",
    "cd {backend}/src/api && ls ../../scripts/*.mjs | head -3",
    "cd {admin}/src && sed -n 190,230p components/pages/stock/index.js; grep -rn \"reorderQuantity\" {backend}/src/api/models/*.js | head; grep -n \"stock\" Router.js | head -5",
    "sed -n 1,200p src/api/models/customer.model.js",
    "sed -n '140,175p' src/api/models/customer.model.js",
    "sed -n 1,5p package.json; sed -n 2,3p package.json",
    "sed -n '/^const a/,/^const b/p' src/api/models/customer.model.js",
    "cat package.json | sed -n 1,147p",
    "sed -En '/link/p' src/api/models/customer.model.js",
    "sed 's/const/let/' src/api/models/customer.model.js | head",
    "sed '/^$/d' package.json",
    "grep -rn \"const\" src --include=*.js | sort | uniq -c",
    "grep -rn \"/api/\" src/api/controllers/x.js",
    "grep -n \"const\" src/api/models/*.js | head -20",
    "cd src/api && echo \"--- models\"; grep -c const models/*.js 2>/dev/null | head",
    "ls src/api/*",
    "ls -la src/api/models | head",
    "wc -l src/api/models/*.js",
    "find src -name '*.js' | head",
    "git branch --show-current",
    "git status --short",
    "git log --oneline -n 5",
    "git diff --stat",
    "f=src/api/models/customer.model.js; git status $f",
    "for f in src/api/models/*.js; do echo $f; head -2 $f; done",
    "cat .e*",
    "cat .env",
    "cat .env.*",
    "cat src/../.env",
    "head -1 .en?",
    "cat out/secret.txt",
    "cat leak.txt",
    "cat {root}/outside.txt",
    "cat api/models/customer.model.js",
    "cat dangling",
    "cat src/g/config",
    "ls src/g/hooks",
    "bash scripts/ok.sh",
    "bash scripts/push.sh",
    "sh scripts/push.sh",
    "./scripts/push.sh",
    "./scripts/ok.sh",
    "python3 scripts/spawn.py",
    "node scripts/build.mjs",
    "node scripts/missing.js",
    "bash scripts/big.txt",
    "npm run build",
    "npm run push",
    "npm test",
    "make build",
    "make publish",
    "cd src/api && cat models/mailbox.model.js",
    "cd out && cat secret.txt",
    "cd {admin}/src && cat Router.js && cd ../.. && cat .env",
    "mkdir -p src/new/deep && cat src/new/deep/x",
    "echo hi > src/api/models/new.js",
    "echo hi > leak.txt",
    "echo hi > out/new.txt",
    "touch src/g/hooks/pre-commit",
    "cp package.json src/api/copy.json",
    "rm -rf node_modules",
    "ls ~/.ssh",
    "cat ~/x.txt",
    "ls {root}",
    "cat {root}/outside/*",
    "grep -r secret {root}/outside",
    "cat src/**/*.js",
    "ls src/***/models",
];

fn decisions(c: &PolicyContext, w: &World, cmd: &str) -> String {
    let cmd = cmd.replace("{backend}", &w.root.join("backend").display().to_string()).replace("{admin}", &w.root.join("admin").display().to_string()).replace("{root}", &w.root.display().to_string());
    let d = bash(c, &cmd);
    format!("{:?}/{:?}/{:?}/{}", d.decision, d.by, d.rule, d.reason)
}

#[test]
fn the_wire_ops_are_enough_for_the_whole_policy() {
    assert!(CORPUS.len() >= 40);
    let w = world();
    let view = Arc::new(JsonFs::default());
    let mut verdicts = std::collections::BTreeSet::new();
    for mode in [PermissionMode::Automatic, PermissionMode::ReadOnly, PermissionMode::Edit] {
        let local = context(&w, mode);
        let remote = context(&w, mode).with_fs(view.clone());
        for cmd in CORPUS {
            let (a, b) = (decisions(&local, &w, cmd), decisions(&remote, &w, cmd));
            assert_eq!(a, b, "{mode:?}: {cmd}");
            verdicts.insert(a.split('/').next().unwrap().to_string());
        }
    }
    // the corpus really covers allowing and refusing
    assert!(verdicts.contains("Allow") && verdicts.contains("Deny"), "{verdicts:?}");
    assert!(view.ops.load(Ordering::SeqCst) > 500, "the view was used");
}

#[test]
fn a_decision_costs_few_round_trips() {
    let w = world();
    let mut worst = 0;
    let mut total = (0, 0);
    for cmd in ["ls", "cat src/api/models/customer.model.js", "cat .e*", "bash scripts/ok.sh", "cd src/api && grep -n const models/*.js", "npm run build", "make build", "git status --short", "cat out/secret.txt"] {
        let view = Arc::new(JsonFs::default());
        let c = context(&w, PermissionMode::Automatic).with_fs(view.clone());
        let before = view.requests.load(Ordering::SeqCst);
        let _ = decisions(&c, &w, cmd);
        let (req, ops) = (view.requests.load(Ordering::SeqCst) - before, view.ops.load(Ordering::SeqCst));
        println!("fs/query cost of `{cmd}`: {req} requests, {ops} ops");
        worst = worst.max(req);
        total = (total.0 + req, total.1 + ops);
    }
    println!("fs/query total over 9 commands: {} requests, {} ops, worst {worst}", total.0, total.1);
    assert!(worst <= 20, "worst case {worst} round trips");
}
