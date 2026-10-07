//! The workspace registry ((design notes: workspaces-spec) 4.2 to 4.6, 4.12, 9.1): storage, atomicity, locking, problems,
//! pinned mode, migration, instance lock, probing and identity-keyed protection. Fixtures only (`tempfile`).

use std::cell::Cell;
use std::collections::BTreeSet;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use intely_core::jail::{Jail, TEST_JAIL};
use intely_core::registry::{
    fs::FsProbe, risk_hash, Env, Fault, FakeBehavior, FakeFs, Location, NewRepo, NewWorkspace, Opened, RealFs, Registry, RepoKind, TrustState,
    ValidatedRepo, MIGRATED_ID, PALETTE,
};
use intely_core::types::code;
use intely_core::{ProblemKind, RepoStatus, Workspace, WorkspaceFileState, WorkspaceOrigin};

// ---- harness -------------------------------------------------------------------------------------------------------

thread_local! {
    static NOW: Cell<i64> = const { Cell::new(1_700_000_000_000) };
}

fn now() -> i64 {
    NOW.with(|n| {
        let v = n.get();
        n.set(v + 1000);
        v
    })
}

fn set_now(ms: i64) {
    NOW.with(|n| n.set(ms));
}

fn next_id() -> String {
    static SEQ: AtomicU32 = AtomicU32::new(1);
    format!("w{:05}", SEQ.fetch_add(1, Ordering::SeqCst))
}

fn env() -> Env {
    Env { now_ms: now, new_id: next_id, ..Env::real() }
}

struct Fx {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    dir: PathBuf,
}

fn fx() -> Fx {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let dir = root.join("state");
    Fx { _tmp: tmp, root, dir }
}

impl Fx {
    fn loc(&self) -> Location {
        Location { registry: self.dir.join("workspaces.json"), pinned: None, dir: self.dir.clone(), env_ignored: false }
    }
    fn open(&self) -> Opened {
        self.open_with(env())
    }
    fn open_with(&self, env: Env) -> Opened {
        Registry::open(self.loc(), Arc::new(Jail::off()), env)
    }
    fn registry_bytes(&self) -> Vec<u8> {
        std::fs::read(self.dir.join("workspaces.json")).unwrap()
    }
    fn names(&self, sub: &str) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(self.dir.join(sub)).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        v.sort();
        v
    }
    /// A directory that looks like a git work tree.
    fn repo(&self, name: &str) -> ValidatedRepo {
        let p = self.root.join("repos").join(name);
        std::fs::create_dir_all(p.join(".git")).unwrap();
        std::fs::write(p.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        validated(&p, name)
    }
}

fn validated(p: &Path, name: &str) -> ValidatedRepo {
    use std::os::unix::fs::MetadataExt;
    let canon = p.canonicalize().unwrap();
    let m = std::fs::metadata(&canon).unwrap();
    ValidatedRepo { canonical_path: canon.to_string_lossy().into_owned(), suggested_name: name.to_owned(), identity: format!("{}:{}", m.dev(), m.ino()), kind: RepoKind::Repo, main: None }
}

fn nw(name: &str, repos: &[&ValidatedRepo]) -> NewWorkspace {
    NewWorkspace { name: name.to_owned(), color: None, repos: repos.iter().map(|r| NewRepo::plain((*r).clone())).collect(), origin: WorkspaceOrigin::Created }
}

fn all_files(dir: &Path) -> BTreeSet<String> {
    fn walk(d: &Path, base: &Path, out: &mut BTreeSet<String>) {
        if let Ok(rd) = std::fs::read_dir(d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, base, out);
                } else {
                    out.insert(p.strip_prefix(base).unwrap().to_string_lossy().into_owned());
                }
            }
        }
    }
    let mut out = BTreeSet::new();
    walk(dir, dir, &mut out);
    out
}

// ---- location --------------------------------------------------------------------------------------------------------

fn vars<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
    move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| (*v).to_owned())
}

#[test]
fn location_precedence_and_jail_gating() {
    let default = Location::from_env(vars(&[("HOME", "/Users/x")]));
    assert_eq!(default.registry, PathBuf::from("/Users/x/Library/Application Support/IntelySwitchIDE/workspaces.json"));
    assert!(default.pinned.is_none() && !default.env_ignored);

    let pinned = Location::from_env(vars(&[("HOME", "/h"), ("INTELY_WORKSPACE", "/a/b/ws.json"), ("INTELY_WORKSPACES", "/z/w.json"), ("INTELY_READONLY", "1")]));
    assert_eq!(pinned.pinned, Some(PathBuf::from("/a/b/ws.json")));
    assert_eq!(pinned.dir, PathBuf::from("/a/b"));

    for jail_var in ["INTELY_READONLY", "INTELY_E2E"] {
        let l = Location::from_env(vars(&[("HOME", "/h"), ("INTELY_WORKSPACES", "/x/y/w.json"), (jail_var, "1")]));
        assert_eq!((l.registry, l.dir, l.env_ignored, l.pinned), (PathBuf::from("/x/y/w.json"), PathBuf::from("/x/y"), false, None), "{jail_var}");
    }
    // no jail: ignored, and the caller can show the warning
    let l = Location::from_env(vars(&[("HOME", "/h"), ("INTELY_WORKSPACES", "/x/y/w.json")]));
    assert!(l.env_ignored);
    assert_eq!(l.dir, PathBuf::from("/h/Library/Application Support/IntelySwitchIDE"));
    let l = Location::from_env(vars(&[("HOME", "/h"), ("INTELY_WORKSPACES", "/x/y/w.json"), ("INTELY_READONLY", "0")]));
    assert!(l.env_ignored, "INTELY_READONLY=0 is no jail");
    // INTELY_DATA_DIR moves the default state directory (and is beaten by an honoured INTELY_WORKSPACES)
    let l = Location::from_env(vars(&[("HOME", "/h"), ("INTELY_DATA_DIR", "/d")]));
    assert_eq!((l.registry, l.dir, l.env_ignored), (PathBuf::from("/d/workspaces.json"), PathBuf::from("/d"), false));
    let l = Location::from_env(vars(&[("HOME", "/h"), ("INTELY_DATA_DIR", "/d"), ("INTELY_WORKSPACES", "/x/w.json"), ("INTELY_E2E", "1")]));
    assert_eq!(l.dir, PathBuf::from("/x"));
}

// ---- basics ----------------------------------------------------------------------------------------------------------

#[test]
fn opening_an_empty_directory_writes_nothing_but_the_instance_lock() {
    let f = fx();
    let o = f.open();
    assert!(o.active.is_none() && o.problem.is_none());
    let v = o.registry.view();
    assert!(v.workspaces.is_empty() && v.active_id.is_none() && !v.pinned && v.problem.is_none());
    assert_eq!(all_files(&f.dir), BTreeSet::from([".app.lock".to_owned()]));
}

#[test]
fn open_sweeps_the_temp_files_a_killed_writer_left_behind() {
    let f = fx();
    let r = f.open().registry;
    r.create(nw("Alpha", &[&f.repo("a")])).unwrap();
    drop(r);
    let stale = [f.dir.join(".workspaces.json.4242.1.tmp"), f.dir.join("workspaces/.w-old.json.4242.2.tmp")];
    for p in &stale {
        std::fs::write(p, b"{").unwrap();
    }
    let before = f.registry_bytes();
    let _again = f.open();
    assert!(stale.iter().all(|p| !p.exists()), "stale temp files are gone after the next launch");
    assert_eq!(f.registry_bytes(), before, "the registry itself is untouched");
}

#[test]
fn create_rename_recolor_duplicate_reorder_remove() {
    let f = fx();
    let r = f.open().registry;
    let (a, b) = (f.repo("api"), f.repo("web"));
    let wa = r.create(nw("Alpha", &[&a, &b])).unwrap();
    assert!(intely_core::registry::model::valid_id(&wa.id));
    assert_eq!((wa.order, wa.color.as_str(), wa.last_opened_at, wa.origin.clone()), (0, PALETTE[0], None, WorkspaceOrigin::Created));
    let v = r.view();
    let alpha = &v.workspaces[0];
    assert_eq!(alpha.repos.len(), 2);
    assert_eq!(alpha.repos[0].color, PALETTE[0]);
    assert_eq!(alpha.repos[1].color, PALETTE[1]);
    assert_eq!((alpha.repos[0].badge.as_str(), alpha.repos[0].name.as_str()), ("AP", "api"));
    assert!(alpha.repos[0].id.starts_with("api-") && alpha.repos[0].path == a.canonical_path);
    let ws = r.load_workspace(&wa.id).unwrap();
    assert_eq!(ws.protected_branches, vec!["main", "master", "production", "release/*"]);
    assert_eq!(std::fs::metadata(r.workspace_path(&wa.id).unwrap()).unwrap().permissions().mode() & 0o777, 0o600);

    let wb = r.create(nw("Beta", &[])).unwrap();
    assert_eq!((wb.order, wb.color.as_str()), (1, PALETTE[1]));
    assert!(r.load_workspace(&wb.id).unwrap().repos.is_empty(), "a workspace without repositories is fine");

    assert_eq!(r.rename(&wa.id, "  Alpha 2 ").unwrap().name, "Alpha 2");
    assert_eq!(r.rename(&wa.id, "beta").unwrap_err().code, code::DUPLICATE_NAME);
    assert_eq!(r.rename(&wa.id, "BETA").unwrap_err().code, code::DUPLICATE_NAME);
    assert_eq!(r.rename(&wa.id, "Alpha 2").unwrap().name, "Alpha 2", "keeping the own name is not a clash");
    assert_eq!(r.rename("nope", "x").unwrap_err().code, code::WORKSPACE_NOT_FOUND);
    for bad in ["red", "#12345", "#gggggg", ""] {
        assert_eq!(r.recolor(&wa.id, bad).unwrap_err().code, code::INVALID_COLOR, "{bad}");
    }
    assert_eq!(r.recolor(&wa.id, "#AABBCC").unwrap().color, "#aabbcc");

    let d1 = r.duplicate(&wa.id, None).unwrap();
    assert_eq!((d1.name.as_str(), d1.last_opened_at, d1.origin.clone()), ("Alpha 2 copy", None, WorkspaceOrigin::Duplicate));
    assert_eq!(r.load_workspace(&d1.id).unwrap(), r.load_workspace(&wa.id).unwrap());
    assert_eq!(r.duplicate(&wa.id, None).unwrap().name, "Alpha 2 copy 2");
    assert_eq!(r.duplicate(&wa.id, Some("Mine")).unwrap().name, "Mine");

    let ids: Vec<String> = r.view().workspaces.iter().map(|w| w.id.clone()).collect();
    assert_eq!(r.reorder(&ids[..2]).unwrap_err().code, code::INVALID_SELECTION);
    let mut dup = ids.clone();
    dup[1] = dup[0].clone();
    assert_eq!(r.reorder(&dup).unwrap_err().code, code::INVALID_SELECTION);
    let reversed: Vec<String> = ids.iter().rev().cloned().collect();
    r.reorder(&reversed).unwrap();
    assert_eq!(r.view().workspaces.iter().map(|w| w.id.clone()).collect::<Vec<_>>(), reversed);

    assert_eq!(r.remove(&wb.id, false).unwrap_err().code, code::CONFIRM_REQUIRED);
    r.set_active(Some(&wb.id)).unwrap();
    assert_eq!(r.remove(&wb.id, true).unwrap_err().code, code::WORKSPACE_ACTIVE);
    assert!(r.view().workspaces.iter().any(|w| w.id == wb.id));
    r.set_active(None).unwrap();
    r.remove(&wb.id, true).unwrap();
    assert!(!r.view().workspaces.iter().any(|w| w.id == wb.id));
    assert!(!r.workspace_path(&wb.id).unwrap().exists());
    assert!(f.names("workspaces/removed").iter().any(|n| n.starts_with(&format!("{}-", wb.id))));
    assert_eq!(r.remove(&wb.id, true).unwrap_err().code, code::WORKSPACE_NOT_FOUND);
    // the folders on disk are untouched
    assert!(Path::new(&a.canonical_path).join(".git/HEAD").exists());
}

#[test]
fn set_active_stamps_last_opened_and_survives_a_reopen() {
    let f = fx();
    let id = {
        let r = f.open().registry;
        let w = r.create(nw("One", &[&f.repo("r1")])).unwrap();
        assert_eq!(r.set_active(Some("missing")).unwrap_err().code, code::WORKSPACE_NOT_FOUND);
        set_now(5_000);
        r.set_active(Some(&w.id)).unwrap();
        w.id
    };
    let o = f.open();
    let a = o.active.expect("the active workspace opens at launch");
    assert_eq!(a.id, id);
    assert_eq!(a.workspace.repos.len(), 1);
    assert_eq!(o.registry.view().workspaces[0].last_opened_at, Some(5_000));
    assert_eq!(o.registry.view().active_id, Some(id));
}

#[test]
fn name_rules() {
    let f = fx();
    let r = f.open().registry;
    for bad in ["", "   ", &"x".repeat(61), "a\nb", "tab\there", "bidi\u{202E}x", "zero\u{200B}width", "sep\u{2028}x", "nul\u{0}x"] {
        assert_eq!(r.create(nw(bad, &[])).unwrap_err().code, code::INVALID_NAME, "{bad:?}");
    }
    assert!(r.create(nw(&"x".repeat(60), &[])).is_ok());
    assert_eq!(r.create(nw("Caf\u{e9}", &[])).unwrap().name, "Caf\u{e9}");
    assert_eq!(r.create(nw("Cafe\u{301}", &[])).unwrap_err().code, code::DUPLICATE_NAME, "NFC and NFD are the same name");
    assert_eq!(r.create(nw("CAF\u{c9}", &[])).unwrap_err().code, code::DUPLICATE_NAME);
    assert_eq!(r.create(NewWorkspace { color: Some("blue".into()), ..nw("c", &[]) }).unwrap_err().code, code::INVALID_COLOR);
}

#[test]
fn limits_of_workspaces_and_repositories() {
    let f = fx();
    let r = f.open().registry;
    for i in 0..200 {
        r.create(nw(&format!("ws {i}"), &[])).unwrap();
    }
    assert_eq!(r.create(nw("one too many", &[])).unwrap_err().code, code::LIMIT_REACHED);
    let existing = r.view().workspaces[0].id.clone();
    assert_eq!(r.duplicate(&existing, None).unwrap_err().code, code::LIMIT_REACHED);
    // repositories: no filesystem needed for the count check
    let many: Vec<ValidatedRepo> = (0..101)
        .map(|i| ValidatedRepo { canonical_path: format!("/fixture/r{i}"), suggested_name: format!("r{i}"), identity: format!("1:{i}"), kind: RepoKind::Repo, main: None })
        .collect();
    let f2 = fx();
    let r2 = f2.open().registry;
    let refs: Vec<&ValidatedRepo> = many.iter().collect();
    assert_eq!(r2.create(nw("big", &refs)).unwrap_err().code, code::LIMIT_REACHED);
    assert!(r2.create(nw("ok", &refs[..100])).is_ok());
}

// ---- atomicity, backups, locking -------------------------------------------------------------------------------------

#[test]
fn a_failed_write_leaves_the_old_registry_and_no_temp_file() {
    let f = fx();
    let calls = Arc::new(AtomicUsize::new(0));
    let arm = Arc::new(AtomicBool::new(false));
    let (c, a) = (calls.clone(), arm.clone());
    let fault: Fault = Arc::new(move |stage| {
        if stage == "tmp-written" && a.load(Ordering::SeqCst) && c.fetch_add(1, Ordering::SeqCst) == 1 {
            return Err(io::Error::other("injected"));
        }
        Ok(())
    });
    let r = f.open_with(Env { fault: Some(fault), ..env() }).registry;
    r.create(nw("Keep", &[])).unwrap();
    let before = f.registry_bytes();
    arm.store(true, Ordering::SeqCst);
    // the first atomic write of a create is the workspace file, the second the registry: fail the second
    let err = r.create(nw("Lost", &[])).unwrap_err();
    assert_eq!(err.code, code::IO, "{err:?}");
    assert_eq!(f.registry_bytes(), before, "the previous registry is intact");
    assert!(all_files(&f.dir).iter().all(|n| !n.ends_with(".tmp")), "no temp file is left: {:?}", all_files(&f.dir));
    assert_eq!(r.view().workspaces.len(), 1);
    arm.store(false, Ordering::SeqCst);
    assert!(r.create(nw("Lost", &[])).is_ok(), "the name was not taken by the failed attempt");
}

#[test]
fn backups_are_taken_before_structural_writes_only_and_pruned_to_ten() {
    let f = fx();
    let r = f.open().registry;
    let w = r.create(nw("n0", &[])).unwrap();
    assert!(f.names("backups").is_empty(), "the first write has nothing to back up");
    for i in 1..=15 {
        r.rename(&w.id, &format!("n{i}")).unwrap();
    }
    let n = f.names("backups").len();
    assert_eq!(n, 10, "{:?}", f.names("backups"));
    r.set_active(Some(&w.id)).unwrap();
    r.set_active(None).unwrap();
    assert_eq!(f.names("backups").len(), 10);
    let newest = f.names("backups").into_iter().filter(|n| n.starts_with("workspaces.")).max_by_key(|n| intely_core::registry::fsutil::backup_timestamp(n, "workspaces.")).unwrap();
    let text = std::fs::read_to_string(f.dir.join("backups").join(newest)).unwrap();
    assert!(text.contains("\"n14\""), "the backup holds the state before the last rename: {text}");
}

#[test]
fn concurrent_writers_lose_no_updates() {
    let f = fx();
    let r = Arc::new(f.open_with(Env { lock_wait: Duration::from_secs(120), ..env() }).registry);
    let handles: Vec<_> = (0..4)
        .map(|t| {
            let r = r.clone();
            std::thread::spawn(move || {
                for i in 0..8 {
                    r.create(NewWorkspace { name: format!("t{t}-{i}"), color: None, repos: vec![], origin: WorkspaceOrigin::Created }).unwrap();
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    let v = r.view();
    assert_eq!(v.workspaces.len(), 32);
    let ids: BTreeSet<_> = v.workspaces.iter().map(|w| w.id.clone()).collect();
    assert_eq!(ids.len(), 32, "ids are unique");
    assert_eq!(v.rev, 32, "every write bumped the revision exactly once");
}

#[test]
fn a_second_process_holding_the_lock_makes_a_mutation_time_out_as_registry_busy() {
    let f = fx();
    let r = f.open_with(Env { lock_wait: Duration::from_millis(300), ..env() }).registry;
    r.create(nw("first", &[])).unwrap();
    let script = "import fcntl,sys,time\nf=open(sys.argv[1],'a+')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('locked',flush=True)\ntime.sleep(float(sys.argv[2]))\n";
    let mut child = std::process::Command::new("python3")
        .args(["-c", script, f.dir.join(".workspaces.lock").to_str().unwrap(), "2.5"])
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("python3");
    let mut line = String::new();
    io::BufRead::read_line(&mut io::BufReader::new(child.stdout.take().unwrap()), &mut line).unwrap();
    assert_eq!(line.trim(), "locked");
    let t = Instant::now();
    assert_eq!(r.create(nw("second", &[])).unwrap_err().code, code::REGISTRY_BUSY);
    assert!(t.elapsed() < Duration::from_secs(2));
    assert_eq!(r.view().workspaces.len(), 1, "readers do not lock");
    child.wait().unwrap();
    assert!(r.create(nw("second", &[])).is_ok());
}

// ---- problems --------------------------------------------------------------------------------------------------------

#[test]
fn a_corrupt_registry_is_reported_never_overwritten_and_restorable_from_a_backup() {
    let f = fx();
    let good = {
        let r = f.open().registry;
        let w = r.create(nw("Good", &[&f.repo("r")])).unwrap();
        r.rename(&w.id, "Good 2").unwrap();
        r.rename(&w.id, "Good 3").unwrap();
        f.registry_bytes()
    };
    let backups_before = f.names("backups");
    assert!(!backups_before.is_empty());
    std::fs::write(f.dir.join("workspaces.json"), b"{ not json").unwrap();
    let o = f.open();
    let p = o.problem.clone().expect("problem");
    assert_eq!(p.kind, ProblemKind::Corrupt);
    assert!(!p.backups.is_empty() && p.backups.windows(2).all(|w| w[0].at >= w[1].at), "newest first: {:?}", p.backups);
    assert!(p.backups.iter().all(|b| b.workspaces == 1));
    assert!(o.active.is_none());
    let r = o.registry;
    assert_eq!(r.create(nw("X", &[])).unwrap_err().code, code::REGISTRY_CORRUPT);
    assert_eq!(r.rename("any", "x").unwrap_err().code, code::REGISTRY_CORRUPT);
    assert_eq!(std::fs::read(f.dir.join("workspaces.json")).unwrap(), b"{ not json");
    assert_eq!(f.names("backups"), backups_before, "a damaged file never pushes a good backup out");
    assert_eq!(r.view().problem.unwrap().kind, ProblemKind::Corrupt);

    assert_eq!(r.restore_backup("../../etc/passwd").unwrap_err().code, code::INVALID_SELECTION);
    assert_eq!(r.restore_backup("not-listed.json").unwrap_err().code, code::INVALID_SELECTION);
    let pick = p.backups[0].name.clone();
    r.restore_backup(&pick).unwrap();
    assert!(r.view().problem.is_none());
    assert_eq!(r.view().workspaces.len(), 1);
    assert!(f.names("").iter().any(|n| n.starts_with("workspaces.json.corrupt-")), "the damaged file is kept: {:?}", f.names(""));
    let _ = good;
}

#[test]
fn start_fresh_moves_the_damaged_registry_aside() {
    let f = fx();
    std::fs::create_dir_all(&f.dir).unwrap();
    std::fs::write(f.dir.join("workspaces.json"), b"garbage").unwrap();
    let r = f.open().registry;
    r.start_fresh().unwrap();
    assert!(!f.dir.join("workspaces.json").exists());
    let kept: Vec<_> = f.names("").into_iter().filter(|n| n.starts_with("workspaces.json.corrupt-")).collect();
    assert_eq!(kept.len(), 1);
    assert_eq!(std::fs::read(f.dir.join(&kept[0])).unwrap(), b"garbage");
    assert!(r.view().problem.is_none());
    assert!(r.create(nw("fresh", &[])).is_ok());
}

#[test]
fn a_newer_registry_is_read_only_and_never_touched() {
    let f = fx();
    std::fs::create_dir_all(&f.dir).unwrap();
    let text = br#"{"version":2,"rev":9,"workspaces":[{"shape":"unknown"}]}"#;
    std::fs::write(f.dir.join("workspaces.json"), text).unwrap();
    let o = f.open();
    assert_eq!(o.problem.as_ref().unwrap().kind, ProblemKind::NewerVersion);
    let r = o.registry;
    assert_eq!(r.create(nw("x", &[])).unwrap_err().code, code::UNSUPPORTED_VERSION);
    assert_eq!(r.start_fresh().unwrap_err().code, code::UNSUPPORTED_VERSION);
    assert_eq!(r.restore_backup("x").unwrap_err().code, code::INVALID_SELECTION);
    assert_eq!(std::fs::read(f.dir.join("workspaces.json")).unwrap(), text);
}

#[test]
fn unknown_fields_survive_a_rewrite() {
    let f = fx();
    std::fs::create_dir_all(&f.dir).unwrap();
    std::fs::create_dir_all(f.dir.join("workspaces")).unwrap();
    std::fs::write(f.dir.join("workspaces/wa.json"), serde_json::to_vec(&intely_core::workspace::empty()).unwrap()).unwrap();
    let text = r##"{"version":1,"rev":3,"activeId":null,"future":{"x":[1,2]},"workspaces":[{"id":"wa","name":"A","color":"#8b6cf0","order":0,"createdAt":1,"lastOpenedAt":null,"origin":"created","pinnedAt":5}]}"##;
    std::fs::write(f.dir.join("workspaces.json"), text).unwrap();
    let r = f.open().registry;
    r.rename("wa", "A2").unwrap();
    let v: serde_json::Value = serde_json::from_slice(&f.registry_bytes()).unwrap();
    assert_eq!(v["future"], serde_json::json!({"x":[1,2]}));
    assert_eq!(v["workspaces"][0]["pinnedAt"], 5);
    assert_eq!(v["workspaces"][0]["name"], "A2");
    assert_eq!(v["rev"], 4);
}

#[test]
fn workspace_paths_are_computed_from_validated_ids_only() {
    let f = fx();
    let r = f.open().registry;
    assert_eq!(r.workspace_path("w-migrated").unwrap(), f.dir.join("workspaces/w-migrated.json"));
    for bad in ["../x", "A", "a/b", "", "a b", "..", ".hidden", "a\u{0}b", &"a".repeat(32)] {
        assert_eq!(r.workspace_path(bad).unwrap_err().code, code::WORKSPACE_NOT_FOUND, "{bad:?}");
    }
}

#[test]
fn a_missing_or_damaged_workspace_file_is_data_not_a_panic() {
    let f = fx();
    let r = f.open().registry;
    let (a, b) = (r.create(nw("A", &[])).unwrap(), r.create(nw("B", &[])).unwrap());
    r.set_active(Some(&a.id)).unwrap();
    std::fs::remove_file(r.workspace_path(&a.id).unwrap()).unwrap();
    std::fs::write(r.workspace_path(&b.id).unwrap(), b"{ broken").unwrap();
    let v = r.view();
    assert_eq!(v.workspaces[0].file_state, Some(WorkspaceFileState::Missing));
    assert_eq!(v.workspaces[1].file_state, Some(WorkspaceFileState::Damaged));
    assert_eq!(v.open_error.unwrap().id, a.id);
    assert_eq!(r.load_workspace(&a.id).unwrap_err().code, code::WORKSPACE_FILE_MISSING);
    assert_eq!(r.load_workspace(&b.id).unwrap_err().code, intely_core::workspace::INVALID_WORKSPACE);
    drop(r);
    let o = f.open();
    assert!(o.active.is_none(), "an active workspace whose file is gone opens as Welcome");
    assert!(o.registry.view().active_id.is_some(), "but the choice is kept");
}

// ---- pinned mode and the jail ----------------------------------------------------------------------------------------

#[test]
fn pinned_mode_bypasses_the_registry_entirely() {
    let f = fx();
    std::fs::create_dir_all(&f.root).unwrap();
    let file = f.root.join("legacy/workspace.json");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let mut ws = intely_core::workspace::empty();
    ws.repos.push(intely_core::RepoConfig { id: "x".into(), path: "/fixture/x".into(), name: "x".into(), color: "#4caf7d".into(), badge: "X".into(), order: 0, push_targets: Default::default() });
    std::fs::write(&file, serde_json::to_vec_pretty(&ws).unwrap()).unwrap();
    let before = all_files(&f.root);
    let loc = Location { registry: file.parent().unwrap().join("workspaces.json"), pinned: Some(file.clone()), dir: file.parent().unwrap().to_path_buf(), env_ignored: false };
    let o = Registry::open(loc, Arc::new(Jail::off()), env());
    let a = o.active.expect("pinned workspace");
    assert_eq!((a.id.as_str(), a.workspace.repos.len(), a.path.as_path()), ("pinned", 1, file.as_path()));
    let r = o.registry;
    let v = r.view();
    assert!(v.pinned && v.workspaces.len() == 1 && v.workspaces[0].id == "pinned" && v.workspaces[0].name == "pinned");
    assert_eq!(r.create(nw("x", &[])).unwrap_err().code, code::PINNED);
    assert_eq!(r.rename("pinned", "x").unwrap_err().code, code::PINNED);
    assert_eq!(r.set_active(None).unwrap_err().code, code::PINNED);
    assert_eq!(r.remove("pinned", true).unwrap_err().code, code::PINNED);
    assert_eq!(all_files(&f.root), before, "pinned mode creates no lock, no registry, nothing");
    // two pinned instances do not exclude each other (no lock)
    let loc2 = Location { registry: file.parent().unwrap().join("workspaces.json"), pinned: Some(file.clone()), dir: file.parent().unwrap().to_path_buf(), env_ignored: false };
    assert!(Registry::open(loc2, Arc::new(Jail::off()), env()).problem.is_none());
}

#[test]
fn a_missing_pinned_file_is_not_seeded() {
    let f = fx();
    std::fs::create_dir_all(&f.root).unwrap();
    let file = f.root.join("nowhere.json");
    let loc = Location { registry: f.root.join("workspaces.json"), pinned: Some(file.clone()), dir: f.root.clone(), env_ignored: false };
    let o = Registry::open(loc, Arc::new(Jail::off()), env());
    assert!(o.active.is_none());
    assert!(!file.exists());
}

#[test]
fn an_e2e_registry_outside_the_fixture_root_is_refused_and_nothing_is_written() {
    let fixture = fx();
    let elsewhere = fx();
    let loc = elsewhere.loc();
    let o = Registry::open(loc, Arc::new(Jail::e2e(&fixture.root)), env());
    assert_eq!(o.problem.as_ref().unwrap().kind, ProblemKind::TestJail);
    assert!(o.active.is_none());
    assert_eq!(o.registry.create(nw("x", &[])).unwrap_err().code, TEST_JAIL);
    assert!(!elsewhere.dir.exists(), "not even the directory is created");
    // inside the root it works
    let inside = Registry::open(Location { registry: fixture.dir.join("workspaces.json"), pinned: None, dir: fixture.dir.clone(), env_ignored: false }, Arc::new(Jail::e2e(&fixture.root)), env());
    assert!(inside.problem.is_none());
    assert!(inside.registry.create(nw("ok", &[])).is_ok());
}

#[test]
fn read_only_mode_still_registers_workspaces() {
    let f = fx();
    let o = Registry::open(f.loc(), Arc::new(Jail::read_only()), env());
    assert!(o.registry.create(nw("ro", &[&f.repo("r")])).is_ok(), "registering only writes the IDE's own state");
}

// ---- instance lock ---------------------------------------------------------------------------------------------------

#[test]
fn a_second_instance_on_one_directory_is_detached_and_writes_nothing() {
    let f = fx();
    let first = f.open();
    first.registry.create(nw("mine", &[])).unwrap();
    let before = all_files(&f.dir);
    let bytes = f.registry_bytes();
    let second = f.open();
    assert_eq!(second.problem.as_ref().unwrap().kind, ProblemKind::OtherInstance);
    assert!(second.active.is_none());
    assert_eq!(second.registry.create(nw("theirs", &[])).unwrap_err().code, code::OTHER_INSTANCE);
    assert_eq!(second.registry.set_active(None).unwrap_err().code, code::OTHER_INSTANCE);
    assert_eq!(second.registry.view().problem.unwrap().kind, ProblemKind::OtherInstance);
    assert_eq!(all_files(&f.dir), before);
    assert_eq!(f.registry_bytes(), bytes);
    // the first one is unaffected
    assert!(first.registry.create(nw("still fine", &[])).is_ok());
    // once the first one quits, "Try again" takes over
    drop(first);
    assert!(second.registry.view().problem.is_none());
    assert!(second.registry.create(nw("theirs", &[])).is_ok());
}

// ---- migration -------------------------------------------------------------------------------------------------------

fn legacy_workspace() -> Workspace {
    let mut ws = intely_core::workspace::empty();
    for (i, (id, name)) in [("shop-backend", "shop-backend"), ("admin", "admin"), ("shop-mobile", "shop-mobile"), ("shop-pos", "shop-pos")].into_iter().enumerate() {
        let mut push_targets = std::collections::BTreeMap::new();
        if id == "admin" {
            push_targets.insert("sandbox-light".to_owned(), intely_core::PushTargetMapping { remote: "origin".into(), branch: "admin-remote".into() });
        }
        ws.repos.push(intely_core::RepoConfig { id: id.into(), path: format!("/fixture/{name}"), name: name.into(), color: PALETTE[i].into(), badge: name[..2].to_uppercase(), order: i as u32, push_targets });
    }
    ws.protected_branches.push("custom/*".into());
    ws.live_branches.insert("admin".into(), vec!["sandbox*".into()]);
    ws.settings.message_mode = intely_core::MessageMode::PerRepo;
    ws
}

fn write_legacy(f: &Fx) -> Vec<u8> {
    std::fs::create_dir_all(&f.dir).unwrap();
    // deliberately not the engine's own formatting: the copy must be byte for byte
    let mut bytes = serde_json::to_vec(&legacy_workspace()).unwrap();
    bytes.extend_from_slice(b"\n\n");
    std::fs::write(f.dir.join("workspace.json"), &bytes).unwrap();
    bytes
}

#[test]
fn migration_is_lossless_idempotent_and_leaves_the_legacy_file_alone() {
    use sha2::{Digest, Sha256};
    let f = fx();
    let legacy = write_legacy(&f);
    let o = f.open();
    assert!(o.problem.is_none());
    let a = o.active.clone().expect("the migrated workspace opens");
    assert_eq!(a.id, MIGRATED_ID);
    assert_eq!(a.workspace, legacy_workspace());
    assert_eq!(std::fs::read(f.dir.join("workspaces/w-migrated.json")).unwrap(), legacy, "byte-identical");
    assert_eq!(std::fs::read(f.dir.join("workspace.json")).unwrap(), legacy, "the legacy file is untouched");
    let backups: Vec<_> = f.names("backups").into_iter().filter(|n| n.starts_with("workspace.pre-registry.")).collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(std::fs::read(f.dir.join("backups").join(&backups[0])).unwrap(), legacy);
    let v = o.registry.view();
    assert_eq!(v.workspaces.len(), 1);
    let w = &v.workspaces[0];
    assert_eq!((w.id.as_str(), w.name.as_str(), w.color.as_str(), w.origin.clone()), ("w-migrated", "Happy workspace", PALETTE[0], WorkspaceOrigin::Migrated));
    assert!(w.last_opened_at.is_some());
    assert_eq!(v.active_id.as_deref(), Some("w-migrated"));
    let reg: serde_json::Value = serde_json::from_slice(&f.registry_bytes()).unwrap();
    assert_eq!(reg["migrated"]["sha256"], hex::encode(Sha256::digest(&legacy)));
    assert!(reg["migrated"]["from"].as_str().unwrap().ends_with("workspace.json"));

    // a second launch changes no byte and takes no new backup
    let (reg_bytes, files) = (f.registry_bytes(), all_files(&f.dir));
    drop(o);
    let again = f.open();
    assert_eq!(again.active.unwrap().id, MIGRATED_ID);
    assert_eq!(f.registry_bytes(), reg_bytes);
    assert_eq!(all_files(&f.dir), files);
}

#[test]
fn the_launch_that_migrates_reports_it_once_and_a_later_launch_never() {
    let f = fx();
    write_legacy(&f);
    let o = f.open();
    assert!(o.registry.take_just_migrated(), "the first launch migrated");
    assert!(!o.registry.take_just_migrated(), "reported once");
    drop(o);
    assert!(!f.open().registry.take_just_migrated(), "the registry exists, nothing to migrate");
    let fresh = fx();
    assert!(!fresh.open().registry.take_just_migrated(), "no legacy file");
}

#[test]
fn an_absent_legacy_file_creates_no_state() {
    let f = fx();
    let o = f.open();
    assert!(o.active.is_none());
    assert_eq!(all_files(&f.dir), BTreeSet::from([".app.lock".to_owned()]));
}

#[test]
fn an_unreadable_legacy_file_is_a_problem_and_nothing_is_written() {
    for content in [b"{ broken".to_vec(), br#"{"version":2,"repos":[],"protectedBranches":[],"settings":{"messageMode":"shared","untrackedChecked":false}}"#.to_vec(), vec![b'x'; 2 * 1024 * 1024]] {
        let f = fx();
        std::fs::create_dir_all(&f.dir).unwrap();
        std::fs::write(f.dir.join("workspace.json"), &content).unwrap();
        let o = f.open();
        assert_eq!(o.problem.as_ref().unwrap().kind, ProblemKind::LegacyUnreadable);
        assert!(o.active.is_none());
        assert_eq!(all_files(&f.dir), BTreeSet::from([".app.lock".to_owned(), "workspace.json".to_owned()]));
        assert_eq!(std::fs::read(f.dir.join("workspace.json")).unwrap(), content);
        // "Open folder" and "New workspace" still work; the legacy file keeps being ignored afterwards
        assert!(o.registry.create(nw("fresh", &[])).is_ok());
        assert!(o.registry.view().problem.is_none());
    }
}

#[test]
fn a_crash_at_every_migration_step_converges_to_the_clean_result() {
    // the clean run
    let clean = fx();
    let legacy = write_legacy(&clean);
    drop(clean.open());
    let clean_ws = std::fs::read(clean.dir.join("workspaces/w-migrated.json")).unwrap();
    assert_eq!(clean_ws, legacy);

    for stage in ["migrate:backup", "migrate:workspace-file", "migrate:registry", "tmp-written", "renamed"] {
        let f = fx();
        write_legacy(&f);
        let armed = Arc::new(AtomicBool::new(true));
        let a = armed.clone();
        let want = stage.to_owned();
        let fault: Fault = Arc::new(move |s| if a.load(Ordering::SeqCst) && s == want { Err(io::Error::other("crash")) } else { Ok(()) });
        let first = f.open_with(Env { fault: Some(fault), ..env() });
        if stage != "migrate:registry" {
            assert!(first.active.is_none(), "{stage}: the crashed run has no active workspace");
        }
        let registry_exists = f.dir.join("workspaces.json").exists();
        assert!(!registry_exists || stage == "renamed" || stage == "migrate:registry", "{stage}: the registry is written last");
        drop(first);
        // restart
        armed.store(false, Ordering::SeqCst);
        let o = f.open();
        let a = o.active.unwrap_or_else(|| panic!("{stage}: the restart migrates"));
        assert_eq!(a.id, MIGRATED_ID, "{stage}");
        assert_eq!(std::fs::read(f.dir.join("workspaces/w-migrated.json")).unwrap(), clean_ws, "{stage}");
        assert_eq!(std::fs::read(f.dir.join("workspace.json")).unwrap(), legacy, "{stage}");
        assert_eq!(o.registry.view().workspaces.len(), 1, "{stage}");
        let backups = f.names("backups").into_iter().filter(|n| n.starts_with("workspace.pre-registry.")).count();
        assert_eq!(backups, 1, "{stage}: the backup is not duplicated");
        assert!(all_files(&f.dir).iter().all(|n| !n.ends_with(".tmp")), "{stage}");
    }
}

#[test]
fn migration_stamps_the_night_queue() {
    let f = fx();
    write_legacy(&f);
    let queue = f.root.join("night-queue.json");
    std::fs::write(&queue, r#"{"items":[{"id":1,"prompt":"a"},{"id":2,"workspaceId":"other"}],"armed":false,"nextId":3}"#).unwrap();
    drop(f.open_with(Env { night_queue: Some(queue.clone()), ..env() }));
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&queue).unwrap()).unwrap();
    assert_eq!(v["items"][0]["workspaceId"], "w-migrated");
    assert_eq!(v["items"][1]["workspaceId"], "other");
    assert_eq!(v["items"][0]["prompt"], "a");
    assert_eq!(v["nextId"], 3);
    assert_eq!(intely_core::registry::stamp_night_queue(&queue, "w-migrated", None).unwrap(), 0, "idempotent");
    assert_eq!(intely_core::registry::stamp_night_queue(&f.root.join("absent.json"), "x", None).unwrap(), 0);
}

// ---- probing ---------------------------------------------------------------------------------------------------------

fn with_repos(f: &Fx, r: &Registry, name: &str, paths: &[(&str, &Path)]) -> String {
    let id = r.create(nw(name, &[])).unwrap().id;
    r.update_workspace(&id, |ws| {
        for (i, (rid, p)) in paths.iter().enumerate() {
            ws.repos.push(intely_core::RepoConfig { id: (*rid).into(), path: p.to_string_lossy().into_owned(), name: (*rid).into(), color: PALETTE[i % PALETTE.len()].into(), badge: "R".into(), order: i as u32, push_targets: Default::default() });
        }
        Ok(())
    })
    .unwrap();
    let _ = f;
    id
}

#[test]
fn probe_reports_status_and_branch_from_file_reads() {
    let f = fx();
    let r = f.open().registry;
    let base = f.root.join("p");
    let mk = |name: &str, head: Option<&str>| {
        let d = base.join(name);
        std::fs::create_dir_all(d.join(".git")).unwrap();
        if let Some(h) = head {
            std::fs::write(d.join(".git/HEAD"), h).unwrap();
        }
        d
    };
    let ok = mk("ok", Some("ref: refs/heads/feature/x\n"));
    let detached = mk("detached", Some("0123456789abcdef0123456789abcdef01234567\n"));
    let nohead = mk("nohead", None);
    let plain = base.join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    let file = base.join("afile");
    std::fs::write(&file, "x").unwrap();
    let missing = base.join("missing");
    // a linked worktree: `.git` is a file pointing at a gitdir with HEAD
    let wt = base.join("wt");
    let wtgit = base.join("wt-gitdir");
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::create_dir_all(&wtgit).unwrap();
    std::fs::write(wt.join(".git"), format!("gitdir: {}\n", wtgit.display())).unwrap();
    std::fs::write(wtgit.join("HEAD"), "ref: refs/heads/wt-branch\n").unwrap();
    // FIFO as HEAD must not hang
    let fifo = mk("fifo", None);
    let c = std::ffi::CString::new(fifo.join(".git/HEAD").to_str().unwrap()).unwrap();
    // SAFETY: valid path.
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    // no permission: the parent denies search
    let locked = base.join("locked");
    std::fs::create_dir_all(locked.join("repo")).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let vol = Path::new("/Volumes/__intely_no_such_volume__/repo");

    let id = with_repos(
        &f,
        &r,
        "probed",
        &[("ok", &ok), ("detached", &detached), ("nohead", &nohead), ("plain", &plain), ("file", &file), ("missing", &missing), ("wt", &wt), ("fifo", &fifo), ("locked", &locked.join("repo")), ("vol", vol)],
    );
    let t = Instant::now();
    let out = r.probe(Some(&[id.clone()]), Duration::from_secs(3));
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
    assert_eq!(out.len(), 1);
    let by = |rid: &str| out[0].repos.iter().find(|p| p.repo_id == rid).unwrap().clone();
    assert_eq!((by("ok").status, by("ok").branch, by("ok").detached), (RepoStatus::Ok, Some("feature/x".into()), false));
    assert_eq!((by("detached").status, by("detached").branch, by("detached").detached), (RepoStatus::Ok, None, true));
    assert_eq!(by("nohead").status, RepoStatus::NotRepo);
    assert_eq!(by("plain").status, RepoStatus::NotRepo);
    assert_eq!(by("file").status, RepoStatus::NotRepo);
    assert_eq!(by("missing").status, RepoStatus::Missing);
    assert_eq!((by("wt").status, by("wt").branch), (RepoStatus::Ok, Some("wt-branch".into())));
    assert_eq!(by("fifo").status, RepoStatus::NotRepo, "a FIFO as HEAD is unreadable, not a hang");
    assert_eq!(by("locked").status, RepoStatus::NoAccess);
    assert_eq!(by("vol").status, RepoStatus::VolumeMissing);
    // ids filter
    assert!(r.probe(Some(&["nope".to_owned()]), Duration::from_secs(1)).is_empty());
    assert_eq!(r.probe(None, Duration::from_secs(1)).len(), 1);
}

#[test]
fn a_hanging_folder_is_unresponsive_within_the_deadline_and_not_asked_again() {
    let f = fx();
    let fake = FakeFs::new();
    let r = f.open_with(Env { fs: fake.clone() as Arc<dyn FsProbe>, ..env() }).registry;
    let good = f.repo("good");
    let hang_dir = f.root.join("hang/repo");
    std::fs::create_dir_all(hang_dir.join(".git")).unwrap();
    std::fs::write(hang_dir.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    let id = with_repos(&f, &r, "slow", &[("good", Path::new(&good.canonical_path)), ("hang", &hang_dir)]);
    fake.on(&hang_dir, FakeBehavior::Hang);
    let t = Instant::now();
    let out = r.probe(Some(&[id.clone()]), Duration::from_millis(400));
    assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
    let st = |rid: &str, out: &[intely_core::WorkspaceProbe]| out[0].repos.iter().find(|p| p.repo_id == rid).unwrap().status.clone();
    assert_eq!(st("good", &out), RepoStatus::Ok);
    assert_eq!(st("hang", &out), RepoStatus::Unresponsive);
    assert_eq!(r.prober().abandoned(), 1);
    let calls = fake.calls.load(Ordering::SeqCst);
    let t = Instant::now();
    let again = r.probe(Some(&[id]), Duration::from_millis(400));
    assert_eq!(st("hang", &again), RepoStatus::Unresponsive);
    assert!(t.elapsed() < Duration::from_millis(300), "the breaker answers at once");
    assert!(fake.calls.load(Ordering::SeqCst) - calls <= 6, "the hung folder was not probed again");
    fake.release();
}

#[test]
fn opening_the_registry_never_touches_a_repository_folder() {
    let f = fx();
    let seed = f.open();
    let id = seed.registry.create(nw("w", &[&f.repo("r")])).unwrap().id;
    seed.registry.set_active(Some(&id)).unwrap();
    drop(seed);
    let fake = FakeFs::new();
    fake.on(&f.root, FakeBehavior::Hang);
    let t = Instant::now();
    let o = f.open_with(Env { fs: fake.clone() as Arc<dyn FsProbe>, ..env() });
    assert!(o.active.is_some());
    let _ = o.registry.view();
    assert!(t.elapsed() < Duration::from_secs(2));
    assert_eq!(fake.calls.load(Ordering::SeqCst), 0, "open and view do not stat repos");
    fake.release();
}

// ---- identity and protection (4.12) -----------------------------------------------------------------------------------

#[test]
fn ids_are_reused_by_identity_across_workspaces_and_spellings() {
    let f = fx();
    let r = f.open().registry;
    let repo = f.repo("shared");
    let a = r.create(nw("A", &[&repo])).unwrap();
    let id_a = r.load_workspace(&a.id).unwrap().repos[0].id.clone();
    // the same folder reached through a symlink: other spelling, same (dev, ino)
    let link = f.root.join("link-to-shared");
    std::os::unix::fs::symlink(&repo.canonical_path, &link).unwrap();
    let other_spelling = ValidatedRepo { canonical_path: link.to_string_lossy().into_owned(), ..repo.clone() };
    let b = r.create(nw("B", &[&other_spelling])).unwrap();
    assert_eq!(r.load_workspace(&b.id).unwrap().repos[0].id, id_a, "same identity, same id");
    // inside one workspace the same folder twice is refused, even under another spelling
    let ws_a = r.load_workspace(&a.id).unwrap();
    assert_eq!(r.build_repo_configs(&ws_a, &[NewRepo::plain(other_spelling.clone())]).unwrap_err().code, code::ALREADY_IN_WORKSPACE);
    let other = f.repo("other");
    assert_eq!(r.build_repo_configs(&ws_a, &[NewRepo::plain(other.clone()), NewRepo::plain(other.clone())]).unwrap_err().code, code::ALREADY_IN_WORKSPACE);
    let fresh = r.build_repo_configs(&ws_a, &[NewRepo::plain(other.clone())]).unwrap();
    assert_eq!((fresh[0].order, fresh[0].color.as_str()), (1, PALETTE[1]));
    assert_ne!(fresh[0].id, id_a);
    // same basename, different folders: different ids
    let x1 = f.repo("dup1/app");
    let x2 = f.repo("dup2/app");
    let both = r.build_repo_configs(&ws_a, &[NewRepo::plain(x1), NewRepo::plain(x2)]).unwrap();
    assert_ne!(both[0].id, both[1].id);
    // overrides are validated
    let bad_badge = NewRepo { badge: Some("ABC".into()), ..NewRepo::plain(other.clone()) };
    assert!(r.build_repo_configs(&ws_a, &[bad_badge]).is_err());
    let bad_color = NewRepo { color: Some("red".into()), ..NewRepo::plain(other.clone()) };
    assert_eq!(r.build_repo_configs(&ws_a, &[bad_color]).unwrap_err().code, code::INVALID_COLOR);
    let named = NewRepo { name: Some("Pretty".into()), badge: Some("PR".into()), color: Some("#112233".into()), ..NewRepo::plain(other) };
    let c = r.build_repo_configs(&ws_a, &[named]).unwrap();
    assert_eq!((c[0].name.as_str(), c[0].badge.as_str(), c[0].color.as_str()), ("Pretty", "PR", "#112233"));
    let rel = ValidatedRepo { canonical_path: "relative/path".into(), ..repo };
    assert_eq!(r.build_repo_configs(&ws_a, &[NewRepo::plain(rel)]).unwrap_err().code, code::PATH_NOT_VALIDATED);
}

fn mark_live(r: &Registry, ws_id: &str, branches: &[&str], protected: &[&str]) {
    r.update_workspace(ws_id, |ws| {
        let rid = ws.repos[0].id.clone();
        ws.live_branches.entry(rid).or_default().extend(branches.iter().map(|b| (*b).to_owned()));
        ws.protected_branches.extend(protected.iter().map(|b| (*b).to_owned()));
        Ok(())
    })
    .unwrap();
}

#[test]
fn effective_protection_is_the_union_over_every_workspace_that_holds_the_repo() {
    let f = fx();
    let r = f.open().registry;
    let repo = f.repo("guarded");
    let path = Path::new(&repo.canonical_path).to_path_buf();
    let floor: Vec<String> = ["main", "master", "production", "release/*"].iter().map(|s| (*s).to_owned()).collect();

    // (a) a live mark in A applies when the same folder is opened from B
    let a = r.create(nw("A", &[&repo])).unwrap();
    mark_live(&r, &a.id, &["live-x"], &[]);
    let b = r.create(nw("B", &[&repo])).unwrap();
    assert!(r.load_workspace(&b.id).unwrap().live_branches.is_empty(), "nothing is copied at add time");
    let p = r.effective_protection(&path);
    assert_eq!(p.live, vec!["live-x"]);
    assert_eq!(p.protected, floor);

    // (b) a mark added in A after B exists applies at once
    mark_live(&r, &a.id, &["late"], &[]);
    assert_eq!(r.effective_protection(&path).live, vec!["live-x", "late"]);

    // (d) a custom protected pattern of A applies in a new workspace C and everywhere
    mark_live(&r, &a.id, &[], &["custom/*"]);
    let c = r.create(nw("C", &[&repo])).unwrap();
    assert!(r.load_workspace(&c.id).unwrap().protected_branches.contains(&"custom/*".to_owned()), "a new workspace seeds the patterns of the others");
    assert!(r.effective_protection(&path).protected.contains(&"custom/*".to_owned()));

    // (c) a linked worktree of the repo is the same repository
    let wt = f.root.join("worktree-of-guarded");
    let gitdir = path.join(".git/worktrees/wt1");
    std::fs::create_dir_all(&gitdir).unwrap();
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
    std::fs::write(gitdir.join("commondir"), "../..\n").unwrap();
    std::fs::write(gitdir.join("HEAD"), "ref: refs/heads/wt\n").unwrap();
    let p = r.effective_protection(&wt);
    assert_eq!(p.live, vec!["live-x", "late"], "the worktree inherits the main repository's live branches");
    assert!(p.protected.contains(&"custom/*".to_owned()));

    // an unrelated repo only has the floor
    let unrelated = f.repo("unrelated");
    let p = r.effective_protection(Path::new(&unrelated.canonical_path));
    assert_eq!((p.protected, p.live), (floor.clone(), vec![]));

    // (e) removing every workspace that held the repo keeps its marks in the live floor
    for w in [&a, &b, &c] {
        r.remove(&w.id, true).unwrap();
    }
    let p = r.effective_protection(&path);
    assert_eq!(p.live, vec!["live-x", "late"], "deleting the workspace that held a live mark never clears it");
    assert!(p.protected.contains(&"custom/*".to_owned()));
    assert_eq!(std::fs::metadata(f.dir.join("live-floor.json")).unwrap().permissions().mode() & 0o777, 0o600);
}

#[test]
fn find_by_identity_matches_the_exact_repository_set() {
    let f = fx();
    let r = f.open().registry;
    let (r1, r2) = (f.repo("one"), f.repo("two"));
    let a = r.create(nw("A", &[&r1, &r2])).unwrap();
    let b = r.create(nw("B", &[&r1])).unwrap();
    let id = |v: &ValidatedRepo| v.identity.clone();
    assert_eq!(r.find_by_identity(&[id(&r2), id(&r1)]).unwrap().id, a.id);
    assert_eq!(r.find_by_identity(&[id(&r1)]).unwrap().id, b.id);
    assert!(r.find_by_identity(&[id(&r2)]).is_none());
    assert!(r.find_by_identity(&[]).is_none());
    assert!(r.find_by_identity(&["1:1".into()]).is_none());
}

// ---- trust store -----------------------------------------------------------------------------------------------------

#[test]
fn trust_is_remembered_per_path_and_notices_a_changed_risk_set() {
    let f = fx();
    let h1 = risk_hash(&["core.fsmonitor".into()]);
    let h2 = risk_hash(&["core.fsmonitor".into(), "filter.x.clean".into()]);
    {
        let r = f.open().registry;
        assert_eq!(r.trust_state("/repo", &h1), TrustState::Unknown);
        r.trust_accept("/repo", &h1).unwrap();
        assert_eq!(r.trust_state("/repo", &h1), TrustState::Trusted);
        assert_eq!(r.trust_state("/repo", &h2), TrustState::Changed);
        assert_eq!(r.trust_state("/other", &h1), TrustState::Unknown);
        assert_eq!(std::fs::metadata(f.dir.join("trust.json")).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let r = f.open().registry;
    assert_eq!(r.trust_state("/repo", &h1), TrustState::Trusted, "survives a restart");
    std::fs::write(f.dir.join("trust.json"), b"garbage").unwrap();
    assert_eq!(r.trust_state("/repo", &h1), TrustState::Unknown, "an unreadable store trusts nothing");
    assert!(r.trust_accept("/repo", &h1).is_err(), "and is not overwritten");
    assert_eq!(std::fs::read(f.dir.join("trust.json")).unwrap(), b"garbage");
}

#[test]
fn real_fs_probe_sanity() {
    let d = tempfile::tempdir().unwrap();
    assert!(RealFs.stat(d.path()).is_ok());
    assert!(RealFs.stat(&d.path().join("nope")).is_err());
}
