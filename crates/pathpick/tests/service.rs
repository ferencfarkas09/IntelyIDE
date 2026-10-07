mod common;

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::*;
use intely_core::jail::Jail;
use intely_pathpick::*;

struct Setup {
    fx: Fx,
    picker: Arc<Picker>,
    clock: Arc<FakeClock>,
    script: PathBuf,
}

fn setup(mode: &str) -> Setup {
    let fx = Fx::new();
    let fixture = fx.dir("fixture");
    let script = fx.root.join("pick.jsonl");
    fs::write(&script, "").unwrap();
    let jail = Arc::new(match mode {
        "e2e" => Jail::e2e(&fixture),
        "ro" => Jail::read_only(),
        _ => Jail::off(),
    });
    let policy = Policy::new(jail.clone(), if mode == "e2e" { fixture.clone() } else { fx.home.clone() }, fx.state.clone());
    let clock = Arc::new(FakeClock::new(1_000));
    let tokens = Arc::new(PathTokens::with_clock(clock.clone()));
    let backend = Arc::new(FakeBackend::new(jail, Some(script.clone())));
    let picker = Arc::new(Picker::new(Validator::new(policy), tokens, backend).with_clock(clock.clone()));
    Setup { fx, picker, clock, script }
}

fn script(s: &Setup, lines: &[String]) {
    fs::write(&s.script, lines.join("\n") + "\n").unwrap();
}

fn opts(kind: NativeKind, purpose: &str) -> NativeOptions {
    NativeOptions { kind, purpose: purpose.into(), title: Some("T".into()), extensions: None, start_token: None }
}

#[test]
fn capabilities_follow_the_mode() {
    let e = setup("e2e").picker.capabilities();
    assert!(e.native && e.fake && e.mode == PickerMode::E2e);
    let o = setup("off").picker.capabilities();
    assert!(!o.native && !o.fake && o.mode == PickerMode::Off, "the fake backend is unavailable outside e2e");
    assert_eq!(setup("ro").picker.capabilities().mode, PickerMode::ReadOnly);
    let forced = setup("e2e");
    let p = Arc::try_unwrap(forced.picker).ok().unwrap().force_inapp(true);
    assert!(!p.capabilities().native);
}

#[test]
fn a_scripted_pick_is_validated_and_tokenised() {
    let s = setup("e2e");
    let repo = s.fx.repo("fixture/api");
    script(&s, &[format!("{{\"paths\":[\"{}\"]}}", repo.display())]);
    let got = s.picker.native(&opts(NativeKind::Folder, "workspaceRoot")).unwrap().unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].kind, PathKind::Repo);
    assert_eq!(got[0].token.len(), 32);
    // The next call has no more script lines: a cancel.
    assert!(s.picker.native(&opts(NativeKind::Folder, "workspaceRoot")).unwrap().is_none());
}

#[test]
fn multi_pick_and_file_pick() {
    let s = setup("e2e");
    let a = s.fx.repo("fixture/a");
    let b = s.fx.repo("fixture/b");
    let f = s.fx.root.join("fixture/ca.pem");
    fs::write(&f, "x").unwrap();
    script(
        &s,
        &[
            format!("{{\"paths\":[\"{}\",\"{}\"]}}", a.display(), b.display()),
            format!("{{\"paths\":[\"{}\"]}}", f.display()),
            format!("{{\"paths\":[\"{}\",\"{}\"]}}", a.display(), b.display()),
        ],
    );
    assert_eq!(s.picker.native(&opts(NativeKind::Folders, "scanRoot")).unwrap().unwrap().len(), 2);
    let got = s.picker.native(&opts(NativeKind::File, "file:caFile")).unwrap().unwrap();
    assert_eq!((got[0].kind, got[0].name.as_str()), (PathKind::File, "ca.pem"));
    // A single-folder dialog takes the first answer only.
    assert_eq!(s.picker.native(&opts(NativeKind::Folder, "workspaceRoot")).unwrap().unwrap().len(), 1);
}

#[test]
fn the_jail_refuses_a_scripted_path_outside_the_fixture() {
    let s = setup("e2e");
    let outside = tempfile::tempdir().unwrap();
    script(&s, &[format!("{{\"paths\":[\"{}\"]}}", outside.path().display())]);
    let e = s.picker.native(&opts(NativeKind::Folder, "workspaceRoot")).unwrap_err();
    assert_eq!(e.code, "testJail");
}

#[test]
fn kind_and_purpose_must_agree() {
    let s = setup("e2e");
    assert_eq!(s.picker.native(&opts(NativeKind::Folder, "file:x")).unwrap_err().code, "pathInvalid");
    assert_eq!(s.picker.native(&opts(NativeKind::File, "workspaceRoot")).unwrap_err().code, "pathInvalid");
    assert_eq!(s.picker.native(&opts(NativeKind::Folder, "bogus")).unwrap_err().code, "pathInvalid");
}

#[test]
fn native_is_unavailable_outside_e2e_without_a_real_backend() {
    let s = setup("off");
    assert_eq!(s.picker.native(&opts(NativeKind::Folder, "workspaceRoot")).unwrap_err().code, "nativeFailed");
}

#[test]
fn a_second_dialog_while_one_is_open_is_busy() {
    struct Slow(Arc<Mutex<()>>, Arc<std::sync::atomic::AtomicBool>);
    impl PickBackend for Slow {
        fn available(&self) -> bool {
            true
        }
        fn pick(&self, _: &NativeRequest) -> Result<NativeAnswer, intely_core::EngineError> {
            self.1.store(true, std::sync::atomic::Ordering::SeqCst);
            let _g = self.0.lock().unwrap();
            Ok(NativeAnswer::Cancelled)
        }
    }
    let fx = Fx::new();
    let gate = Arc::new(Mutex::new(()));
    let entered = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let hold = gate.lock().unwrap();
    let picker = Arc::new(Picker::new(fx.validator(), Arc::new(fx.tokens()), Arc::new(Slow(gate.clone(), entered.clone()))));
    let p2 = picker.clone();
    let first = std::thread::spawn(move || p2.native(&opts(NativeKind::Folder, "workspaceRoot")));
    let t = Instant::now();
    while !entered.load(std::sync::atomic::Ordering::SeqCst) {
        assert!(t.elapsed() < Duration::from_secs(2), "first dialog never opened");
        std::thread::sleep(Duration::from_millis(5));
    }
    loop {
        match picker.native(&opts(NativeKind::Folder, "workspaceRoot")) {
            Err(e) if e.code == "busy" => break,
            _ if t.elapsed() > Duration::from_secs(2) => panic!("never busy"),
            _ => std::thread::sleep(Duration::from_millis(5)),
        }
    }
    drop(hold);
    assert!(first.join().unwrap().unwrap().is_none());
    // Free again afterwards.
    assert!(picker.native(&opts(NativeKind::Folder, "workspaceRoot")).unwrap().is_none());
}

#[test]
fn the_start_folder_comes_from_a_token_or_memory_never_from_the_webview() {
    struct Spy(Mutex<Vec<Option<PathBuf>>>);
    impl PickBackend for Spy {
        fn available(&self) -> bool {
            true
        }
        fn pick(&self, r: &NativeRequest) -> Result<NativeAnswer, intely_core::EngineError> {
            self.0.lock().unwrap().push(r.start.clone());
            Ok(NativeAnswer::Cancelled)
        }
    }
    let fx = Fx::new();
    let spy = Arc::new(Spy(Mutex::new(vec![])));
    struct Shared(Arc<Spy>);
    impl PickBackend for Shared {
        fn available(&self) -> bool {
            true
        }
        fn pick(&self, r: &NativeRequest) -> Result<NativeAnswer, intely_core::EngineError> {
            self.0.pick(r)
        }
    }
    let picker = Picker::new(fx.validator(), Arc::new(fx.tokens()), Arc::new(Shared(spy.clone())));
    let repo = fx.repo("r");
    let picked = picker.pick(&s(&repo), "workspaceRoot").unwrap();
    let mut o = opts(NativeKind::Folder, "workspaceRoot");
    o.start_token = Some(picked.token.clone());
    picker.native(&o).unwrap();
    o.start_token = Some("f".repeat(32));
    picker.native(&o).unwrap();
    let seen = spy.0.lock().unwrap().clone();
    assert_eq!(seen[0], Some(repo.clone()));
    assert_eq!(seen[1], Some(repo), "an unknown token falls back to the last chosen folder");
}

#[test]
fn picking_a_typed_path_issues_a_token_and_remembers_the_folder() {
    let s = setup("off");
    let repo = s.fx.repo("r");
    let p = s.picker.pick(&format!("\"{}\"", repo.display()), "workspaceRoot").unwrap();
    assert_eq!(p.kind, PathKind::Repo);
    assert_eq!(s.picker.start().start_path, self::s(&repo));
    assert_eq!(s.picker.pick("/nope/nope", "workspaceRoot").unwrap_err().code, "notFound");
}

// -- drops ----------------------------------------------------------------------------------------------------------

#[test]
fn drops_are_ignored_unless_a_screen_is_listening() {
    let s = setup("off");
    let repo = s.fx.repo("r");
    assert_eq!(s.picker.on_drop(&[repo.clone()]), 0);
    assert!(s.picker.take_drop().is_empty());
    assert_eq!(s.picker.tokens.outstanding(), 0, "no tokens are minted for an ignored drop");
    s.picker.drop_listen(true);
    assert_eq!(s.picker.on_drop(&[repo]), 1);
    let got = s.picker.take_drop();
    assert_eq!((got.len(), got[0].kind), (1, PathKind::Repo));
    assert!(s.picker.take_drop().is_empty(), "taking empties the inbox");
}

#[test]
fn the_inbox_is_bounded_and_expires() {
    let s = setup("off");
    s.picker.drop_listen(true);
    let dirs: Vec<PathBuf> = (0..70).map(|i| s.fx.dir(&format!("d{i}"))).collect();
    assert_eq!(s.picker.on_drop(&dirs), 64);
    assert_eq!(s.picker.take_drop().len(), 64);
    s.picker.on_drop(&dirs[..2]);
    s.clock.advance(30_001);
    assert!(s.picker.take_drop().is_empty(), "items past 30 s are dropped");
}

#[test]
fn files_and_app_bundles_are_not_folders() {
    let s = setup("off");
    s.picker.drop_listen(true);
    let file = s.fx.root.join("notes.txt");
    fs::write(&file, "x").unwrap();
    let app = s.fx.dir("Tool.app");
    let plain = s.fx.dir("plain");
    assert_eq!(s.picker.on_drop(&[file, app, plain]), 3);
    let got = s.picker.take_drop();
    assert_eq!(got.iter().map(|p| p.kind).collect::<Vec<_>>(), vec![PathKind::File, PathKind::File, PathKind::NotGit]);
}

#[test]
fn leaving_the_screen_clears_the_inbox() {
    let s = setup("off");
    s.picker.drop_listen(true);
    s.picker.on_drop(&[s.fx.dir("a")]);
    s.picker.drop_listen(false);
    assert!(s.picker.take_drop().is_empty());
    assert!(!s.picker.is_listening());
}

#[test]
fn a_drop_outside_the_e2e_fixture_is_skipped() {
    let s = setup("e2e");
    s.picker.drop_listen(true);
    let inside = s.fx.dir("fixture/in");
    let outside = s.fx.dir("out");
    assert_eq!(s.picker.on_drop(&[inside, outside]), 1);
}

// -- scan through the service ---------------------------------------------------------------------------------------

#[test]
fn a_scan_streams_progress_and_results() {
    let s = setup("off");
    let parent = s.fx.dir("p");
    s.fx.repo("p/a");
    s.fx.repo("p/b");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let started = s
        .picker
        .scan_start(&self::s(&parent), &ScanOpts { depth: None, max_repos: None, include_hidden: false }, Arc::new(move |p| sink.lock().unwrap().push(p.clone())))
        .unwrap();
    let t = Instant::now();
    while !s.picker.scan_progress(&started.scan_id).is_some_and(|p| p.done) {
        assert!(t.elapsed() < Duration::from_secs(5), "scan did not finish");
        std::thread::sleep(Duration::from_millis(10));
    }
    let r = s.picker.scan_results(&started.scan_id, None).unwrap();
    assert_eq!((r.repos.len(), r.next), (2, 2));
    assert!(r.progress.as_ref().is_some_and(|p| p.done && p.found == 2), "a late page learns that the scan is over from the results");
    assert_eq!(s.picker.scan_results(&started.scan_id, Some(2)).unwrap().repos.len(), 0);
    assert!(seen.lock().unwrap().last().unwrap().done);
    assert_eq!(s.picker.scan_results("nope", None).unwrap_err().code, "notFound");
    assert_eq!(s.picker.scan_start("/", &ScanOpts { depth: None, max_repos: None, include_hidden: false }, Arc::new(|_| {})).unwrap_err().code, "scanTooBroad");
}

// -- git init refusals -------------------------------------------------------------------------------------------------

fn notgit(s: &Setup, rel: &str) -> Picked {
    let dir = s.fx.dir(rel);
    s.picker.pick(&self::s(&dir), "workspaceRoot").unwrap()
}

#[test]
fn init_needs_the_typed_folder_name_and_keeps_the_token_on_a_refusal() {
    let s = setup("off");
    let p = notgit(&s, "projects/new-app");
    let e = s.picker.init_prepare(&p.token, "wrong", false).unwrap_err();
    assert_eq!((e.code.as_str(), e.detail.as_deref()), ("pathInvalid", Some("confirm")));
    // The token survived the refusal, so the dialog can retry.
    let path = s.picker.init_prepare(&p.token, " new-app ", false).unwrap();
    assert_eq!(path, s.fx.root.join("projects/new-app"));
    assert_eq!(s.picker.init_prepare(&p.token, "new-app", false).unwrap_err().code, "tokenUsed");
}

#[test]
fn init_is_refused_in_read_only_mode() {
    let s = setup("ro");
    let p = notgit(&s, "projects/x");
    assert_eq!(s.picker.init_prepare(&p.token, "x", false).unwrap_err().code, "readOnly");
}

#[test]
fn init_is_refused_outside_the_e2e_fixture_and_allowed_inside() {
    let s = setup("e2e");
    let p = notgit(&s, "fixture/proj");
    assert!(s.picker.init_prepare(&p.token, "proj", false).is_ok());
    let outside = s.fx.dir("elsewhere");
    assert_eq!(s.picker.pick(&self::s(&outside), "workspaceRoot").unwrap_err().code, "testJail");
}

#[test]
fn init_refuses_broad_folders_and_only_not_git_folders() {
    let s = setup("off");
    let home = s.fx.home.clone();
    let p = s.picker.pick(&self::s(&home), "workspaceRoot").unwrap();
    assert_eq!(s.picker.init_prepare(&p.token, "home", false).unwrap_err().code, "initTooBroad");
    for dir in ["home/Desktop", "home/Documents", "home/Downloads"] {
        let p = notgit(&s, dir);
        assert_eq!(s.picker.init_prepare(&p.token, dir.rsplit('/').next().unwrap(), false).unwrap_err().code, "initTooBroad", "{dir}");
    }
    // Sub-folders of Documents are fine.
    let ok = notgit(&s, "home/Documents/side");
    assert!(s.picker.init_prepare(&ok.token, "side", false).is_ok());
    for p in ["/", "/Users", "/Applications", "/System", "/Library", "/private", "/Volumes/Backup"] {
        assert!(s.picker.init_too_broad(std::path::Path::new(p)), "{p}");
    }
    let repo = s.fx.repo("r");
    let rp = s.picker.pick(&self::s(&repo), "workspaceRoot").unwrap();
    assert_eq!(s.picker.init_prepare(&rp.token, "r", false).unwrap_err().code, "pathInvalid", "already a repository");
    assert_eq!(s.picker.init_prepare("f".repeat(32).as_str(), "x", false).unwrap_err().code, "pathNotValidated");
}

#[test]
fn init_refuses_huge_folders_unless_confirmed() {
    let s = setup("off");
    let big = s.fx.dir("projects/big");
    for i in 0..5100 {
        fs::write(big.join(format!("f{i}")), "").unwrap();
    }
    let p = s.picker.pick(&self::s(&big), "workspaceRoot").unwrap();
    let e = s.picker.init_prepare(&p.token, "big", false).unwrap_err();
    assert_eq!((e.code.as_str(), e.detail.as_deref()), ("initTooBroad", Some("large")));
    assert!(s.picker.init_prepare(&p.token, "big", true).is_ok());
}

#[test]
fn the_confirmation_is_compared_normalised() {
    use unicode_normalization::UnicodeNormalization;
    let s = setup("off");
    let nfc: String = "café-app".nfc().collect();
    let nfd: String = "café-app".nfd().collect();
    let dir = s.fx.dir(&format!("projects/{nfd}"));
    let p = s.picker.pick(&self::s(&dir), "workspaceRoot").unwrap();
    assert_eq!(p.name, nfc);
    assert!(s.picker.init_prepare(&p.token, &nfd, false).is_ok(), "NFD typed text matches the NFC name");
}
