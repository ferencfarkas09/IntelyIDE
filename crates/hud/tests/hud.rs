use intely_hud::notify::{applescript, applescript_quote};
use intely_hud::*;

fn raw(pid: u32, ppid: u32, rss_kb: u64, command: &str) -> RawProc {
    RawProc { pid, ppid, rss_kb, command: command.into() }
}

fn fixture() -> Vec<RawProc> {
    vec![
        raw(1, 0, 10, "/sbin/launchd"),
        raw(100, 1, 200_000, "/Applications/IntelySwitchIDE.app/Contents/MacOS/intely-switch-ide"),
        raw(101, 100, 90_000, "/usr/local/bin/node /app/sidecar/dist/index.js"),
        raw(102, 101, 150_000, "claude --output-format stream-json"),
        raw(103, 102, 5_000, "/bin/zsh -c ls"),
        raw(104, 100, 3_000, "/usr/bin/git status"),
        raw(200, 1, 120_000, "/System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent"),
        raw(201, 1, 80_000, "/System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent"),
        raw(300, 1, 999_999, "/Applications/Safari.app/Contents/MacOS/Safari"),
    ]
}

fn snap() -> Snapshot {
    // only 200 is attributed to our app; 201 belongs to someone else
    build_snapshot(&fixture(), 100, Some(101), &|pid| (pid == 200).then_some(100))
}

#[test]
fn the_snapshot_covers_the_app_tree_and_its_own_webkit_helpers_only() {
    let s = snap();
    let kind = |pid| s.rows.iter().find(|r| r.pid == pid).map(|r| r.kind);
    assert_eq!(kind(100), Some(ProcKind::App));
    assert_eq!(kind(101), Some(ProcKind::Sidecar));
    assert_eq!(kind(102), Some(ProcKind::Agent));
    assert_eq!(kind(103), Some(ProcKind::Agent));
    assert_eq!(kind(104), Some(ProcKind::Child));
    assert_eq!(kind(200), Some(ProcKind::WebKit));
    assert_eq!(kind(201), None, "another app's WebContent is not ours");
    assert_eq!(kind(300), None);
    assert_eq!(s.total_bytes, (200_000 + 90_000 + 150_000 + 5_000 + 3_000 + 120_000) * 1024);
    assert_eq!(s.rows[0].pid, 100, "largest first");
    assert_eq!(s.sidecar_pid, Some(101));
}

#[test]
fn only_the_app_is_protected_from_kill() {
    let s = snap();
    assert_eq!(kill_in_snapshot(&s, 100), Err(KillError::Protected));
    assert_eq!(kill_in_snapshot(&s, 300), Err(KillError::NotOurs));
    assert_eq!(kill_in_snapshot(&s, 1), Err(KillError::NotOurs));
}

#[test]
fn a_real_child_is_listed_and_can_be_killed_but_a_stranger_cannot() {
    let mut child = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let s = scan(None);
    let me = std::process::id();
    assert!(s.rows.iter().any(|r| r.pid == me && r.kind == ProcKind::App && r.rss_bytes > 0));
    let row = s.rows.iter().find(|r| r.pid == child.id()).expect("the sleep child is in the tree");
    assert_eq!(row.kind, ProcKind::Child);
    assert_eq!(kill_in_snapshot(&s, 1), Err(KillError::NotOurs));
    kill_in_snapshot(&s, child.id()).unwrap();
    let status = child.wait().unwrap();
    assert!(!status.success());
}

#[test]
fn parse_ps_skips_garbage() {
    let rows = parse_ps("  12   1  2048 /bin/x --a b\nnot a line\n  7 1 5\n 8 1 100 /y\n");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0], RawProc { pid: 12, ppid: 1, rss_kb: 2048, command: "/bin/x --a b".into() });
}

#[test]
fn eco_enters_after_the_unfocused_time_and_leaves_on_focus() {
    let mut e = Eco::new(true, 60_000);
    assert_eq!(e.focus(false, 1_000), None);
    assert_eq!(e.tick(30_000), None);
    assert_eq!(e.next_check_in(30_000), Some(31_000));
    assert_eq!(e.tick(61_000), Some(EcoChange::Enter));
    assert_eq!(e.tick(90_000), None, "enters once");
    assert_eq!(e.next_check_in(90_000), None, "no timer needed while eco");
    assert_eq!(e.focus(true, 100_000), Some(EcoChange::Leave));
    assert!(!e.active());
    assert_eq!(e.next_check_in(100_000), None, "no timer while focused");
}

#[test]
fn a_short_blur_never_enters_eco_and_disabling_leaves_it() {
    let mut e = Eco::new(true, 60_000);
    e.focus(false, 0);
    assert_eq!(e.focus(true, 10_000), None);
    e.focus(false, 20_000);
    assert_eq!(e.tick(80_000), Some(EcoChange::Enter));
    assert_eq!(e.configure(false, 60_000, 81_000), Some(EcoChange::Leave));
    assert_eq!(e.tick(500_000), None);
    let mut off = Eco::new(false, 1000);
    off.focus(false, 0);
    assert_eq!(off.tick(1_000_000), None);
}

#[test]
fn notifications_respect_kind_focus_and_throttle() {
    let prefs = NotifyPrefs { finished: false, throttle_ms: 10_000, ..NotifyPrefs::default() };
    let mut g = NotifyGate::default();
    assert_eq!(g.check(Kind::Finished, &prefs, false, 0), Verdict::Disabled);
    assert_eq!(g.check(Kind::Permission, &prefs, true, 0), Verdict::Focused);
    assert_eq!(g.check(Kind::Permission, &prefs, false, 1_000), Verdict::Show);
    assert_eq!(g.check(Kind::Permission, &prefs, false, 5_000), Verdict::Throttled);
    assert_eq!(g.check(Kind::Error, &prefs, false, 5_000), Verdict::Show, "the throttle is per kind");
    assert_eq!(g.check(Kind::Permission, &prefs, false, 11_001), Verdict::Show);
}

#[test]
fn applescript_cannot_be_broken_out_of() {
    assert_eq!(applescript_quote("a\"b\\c\nd"), "\"a\\\"b\\\\c d\"");
    let s = applescript("t\" & (do shell script \"x\") & \"", "body");
    assert!(s.starts_with("display notification \"body\" with title \"t\\\" & (do shell script"));
    let unescaped = s.char_indices().filter(|(i, c)| *c == '"' && !s[..*i].ends_with('\\')).count();
    assert_eq!(unescaped, 4, "only the two literals' delimiters are bare quotes: {s}");
}

#[test]
fn the_tray_title_and_menu_follow_the_counts() {
    let idle = TrayStatus::default();
    assert_eq!(title_text(&idle), "");
    assert_eq!(title_text(&TrayStatus { running: 2, needs_you: 1, ..idle.clone() }), "! 1 / 2");
    let items = menu_items(&TrayStatus { running: 0, needs_you: 0, ..idle.clone() });
    let en = |id: &str| items.iter().find_map(|i| match i { MenuItem::Action { id: x, enabled, .. } if *x == id => Some(*enabled), _ => None });
    assert_eq!(en("stop-all"), Some(false));
    assert_eq!(en("needs-you"), Some(false));
    assert_eq!(en("open"), Some(true));
    let busy = menu_items(&TrayStatus { running: 3, needs_you: 2, timer: "running".into(), timer_label: "PROJ-1".into() });
    assert!(busy.iter().any(|i| matches!(i, MenuItem::Info { text, .. } if text == "Timer running: PROJ-1")));
}
