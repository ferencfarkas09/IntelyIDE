use super::*;
use std::io::Write;
use crate::testkit::Fake;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = intely_core::exec::hardened_git("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "f@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "f@example.invalid")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

struct Pair {
    f: Fake,
    server: PathBuf,
    local: LocalRepo,
}

/// A bare origin, a clone on the "server" (`~/work/app`) and a clone "here"; both at the same commit.
fn pair() -> Pair {
    let f = Fake::new();
    let root = f.dir.path().canonicalize().unwrap();
    let bare = root.join("origin.git");
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "-q", "--bare", "-b", "main"]);
    let seed = root.join("seed");
    std::fs::create_dir_all(&seed).unwrap();
    git(&seed, &["init", "-q", "-b", "main"]);
    std::fs::write(seed.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    std::fs::write(seed.join("b.txt"), "bee\n").unwrap();
    git(&seed, &["add", "-A"]);
    git(&seed, &["commit", "-q", "-m", "init"]);
    let url = format!("file://{}", bare.display());
    git(&seed, &["remote", "add", "origin", &url]);
    git(&seed, &["push", "-q", "origin", "main"]);
    let server = f.home.join("work/app");
    std::fs::create_dir_all(server.parent().unwrap()).unwrap();
    git(&root, &["clone", "-q", &url, server.to_str().unwrap()]);
    let local_path = root.join("mac/app");
    std::fs::create_dir_all(local_path.parent().unwrap()).unwrap();
    git(&root, &["clone", "-q", &url, local_path.to_str().unwrap()]);
    Pair { f, server, local: LocalRepo { path: local_path, origin: Some(url) } }
}

fn status(dir: &Path) -> String {
    git(dir, &["status", "--porcelain"])
}

fn plan_of(p: &Pair, d: Direction, busy: bool) -> TransferPlan {
    plan(d, &p.f.ssh, &p.f.cfg, "~/work/app", &p.local, &Jail::off(), busy).unwrap()
}

/// The person looks at the plan, ticks what is offered and confirms: the id of the plan they saw goes with the click.
fn bring_acc(p: &Pair, on_top: bool, accept: bool) -> Res<Applied> {
    let id = plan_of(p, Direction::Bring, false).patch_id;
    bring_changes(&p.f.ssh, &p.f.cfg, "~/work/app", &p.local, &Jail::off(), on_top, &id, accept)
}

fn bring(p: &Pair, on_top: bool) -> Res<Applied> {
    bring_acc(p, on_top, false)
}

fn send_acc(p: &Pair, on_top: bool, busy: bool, accept: bool) -> Res<Applied> {
    let id = plan_of(p, Direction::Send, busy).patch_id;
    send_changes(&p.f.ssh, &p.f.cfg, "~/work/app", &p.local, &Jail::off(), on_top, &id, accept, &|| busy)
}

fn send(p: &Pair, on_top: bool, busy: bool) -> Res<Applied> {
    send_acc(p, on_top, busy, false)
}

fn read(p: &Path, f: &str) -> String {
    std::fs::read_to_string(p.join(f)).unwrap()
}

fn new_file_patch(path: &str) -> String {
    format!("diff --git a/{path} b/{path}\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1 @@\n+x\n")
}

const LINK_PATCH: &str = "diff --git a/l b/l\nnew file mode 120000\nindex 0000000..e69de29\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n";

#[test]
fn bring_makes_the_servers_changes_uncommitted_here_and_nothing_else() {
    let p = pair();
    std::fs::write(p.server.join("a.txt"), "one\nTWO\nthree\n").unwrap();
    std::fs::remove_file(p.server.join("b.txt")).unwrap();
    std::fs::write(p.server.join("new file.txt"), "fresh\n").unwrap();
    std::fs::create_dir_all(p.server.join("sub")).unwrap();
    std::fs::write(p.server.join("sub/c.txt"), "see\n").unwrap();
    git(&p.server, &["add", "sub/c.txt"]);
    let head = git(&p.local.path, &["rev-parse", "HEAD"]);
    let pl = plan(Direction::Bring, &p.f.ssh, &p.f.cfg, "~/work/app", &p.local, &Jail::off(), false).unwrap();
    assert!(pl.refusal.is_none() && pl.blocked.is_empty(), "{pl:?}");
    assert_eq!((pl.tracked, pl.untracked, pl.destination_clean), (3, 1, true));
    assert_eq!(bring(&p, false).unwrap().files, 4);
    assert_eq!(read(&p.local.path, "a.txt"), "one\nTWO\nthree\n");
    assert!(!p.local.path.join("b.txt").exists());
    assert_eq!(read(&p.local.path, "new file.txt"), "fresh\n");
    assert_eq!(read(&p.local.path, "sub/c.txt"), "see\n");
    // nothing staged, no new commit
    assert_eq!(git(&p.local.path, &["diff", "--cached", "--name-only"]), "");
    assert_eq!(git(&p.local.path, &["rev-parse", "HEAD"]), head);
    let st = status(&p.local.path);
    assert!(st.contains(" M a.txt") && st.contains(" D b.txt") && st.contains("?? "), "{st}");
    // the server was not touched either
    assert!(status(&p.server).contains("A  sub/c.txt"));
}

#[test]
fn a_binary_change_to_a_tracked_file_travels() {
    let p = pair();
    for d in [&p.server, &p.local.path] {
        std::fs::write(d.join("img.bin"), [0u8, 1, 2, 3]).unwrap();
        git(d, &["add", "img.bin"]);
        git(d, &["commit", "-q", "-m", "bin"]);
    }
    std::fs::write(p.server.join("img.bin"), [0u8, 9, 9, 9, 0, 7]).unwrap();
    bring(&p, false).unwrap();
    assert_eq!(std::fs::read(p.local.path.join("img.bin")).unwrap(), [0u8, 9, 9, 9, 0, 7]);
}

#[test]
fn different_commits_or_origins_are_refused_with_the_way_out() {
    let p = pair();
    std::fs::write(p.server.join("a.txt"), "x\n").unwrap();
    std::fs::write(p.local.path.join("z.txt"), "z\n").unwrap();
    git(&p.local.path, &["add", "z.txt"]);
    git(&p.local.path, &["commit", "-q", "-m", "z"]);
    let e = bring(&p, false).unwrap_err();
    assert_eq!(e.code, "headDiffers");
    assert!(e.message.contains("Pull or push") && e.message.contains("nothing is fetched"), "{}", e.message);
    assert_eq!(read(&p.local.path, "a.txt"), "one\ntwo\nthree\n");
    assert_eq!(send(&p, false, false).unwrap_err().code, "headDiffers");
    // another origin, and no origin
    let q = pair();
    std::fs::write(q.server.join("a.txt"), "x\n").unwrap();
    let mut other = q.local.clone();
    other.origin = Some("https://example.invalid/other/thing.git".into());
    assert_eq!(bring_changes(&q.f.ssh, &q.f.cfg, "~/work/app", &other, &Jail::off(), false, "", false).unwrap_err().code, "originDiffers");
    other.origin = None;
    assert_eq!(bring_changes(&q.f.ssh, &q.f.cfg, "~/work/app", &other, &Jail::off(), false, "", false).unwrap_err().code, "originDiffers");
}

#[test]
fn a_dirty_destination_needs_apply_on_top_and_a_check_that_passes() {
    let p = pair();
    std::fs::write(p.server.join("a.txt"), "ONE\ntwo\nthree\n").unwrap();
    std::fs::write(p.local.path.join("b.txt"), "bee, edited here\n").unwrap();
    assert_eq!(bring(&p, false).unwrap_err().code, "destinationDirty");
    assert_eq!(read(&p.local.path, "a.txt"), "one\ntwo\nthree\n");
    bring(&p, true).unwrap();
    assert_eq!(read(&p.local.path, "a.txt"), "ONE\ntwo\nthree\n");
    assert_eq!(read(&p.local.path, "b.txt"), "bee, edited here\n");
    // a conflicting local edit: the check fails and the tree stays exactly as it was
    let p = pair();
    std::fs::write(p.server.join("a.txt"), "one\nSERVER\nthree\n").unwrap();
    std::fs::write(p.local.path.join("a.txt"), "one\nLOCAL\nthree\n").unwrap();
    assert_eq!(bring(&p, true).unwrap_err().code, "applyCheck");
    assert_eq!(read(&p.local.path, "a.txt"), "one\nLOCAL\nthree\n");
}

#[test]
fn untracked_binary_big_secret_and_many_files_block_the_whole_transfer() {
    for (name, bytes, code) in [("pic.png", vec![0u8, 1, 2, 0, 3], "binary"), ("big.txt", b"x\n".repeat(700_000), "tooLarge"), (".env", b"TOKEN=1\n".to_vec(), "secret")] {
        let p = pair();
        std::fs::write(p.server.join("a.txt"), "changed\n").unwrap();
        std::fs::write(p.server.join(name), bytes).unwrap();
        let pl = plan(Direction::Bring, &p.f.ssh, &p.f.cfg, "~/work/app", &p.local, &Jail::off(), false).unwrap();
        assert!(pl.blocked.iter().any(|b| b.code == code && b.path == name), "{name}: {:?}", pl.blocked);
        let e = bring(&p, false).unwrap_err();
        assert_eq!(e.code, "blocked", "{name}");
        assert!(e.message.contains(name));
        assert_eq!(read(&p.local.path, "a.txt"), "one\ntwo\nthree\n", "nothing is applied");
    }
    let p = pair();
    std::fs::create_dir_all(p.server.join("many")).unwrap();
    for i in 0..201 {
        std::fs::write(p.server.join(format!("many/f{i}.txt")), "x\n").unwrap();
    }
    let pl = plan(Direction::Bring, &p.f.ssh, &p.f.cfg, "~/work/app", &p.local, &Jail::off(), false).unwrap();
    assert!(pl.blocked.iter().any(|b| b.code == "tooMany"));
}

#[test]
fn a_new_symlink_on_the_server_blocks_the_transfer() {
    let p = pair();
    std::os::unix::fs::symlink("/etc/passwd", p.server.join("link")).unwrap();
    let pl = plan(Direction::Bring, &p.f.ssh, &p.f.cfg, "~/work/app", &p.local, &Jail::off(), false).unwrap();
    assert!(pl.blocked.iter().any(|b| b.code == "symlink" && b.path == "link"), "{:?}", pl.blocked);
}

#[test]
fn send_makes_my_changes_uncommitted_on_the_server_and_waits_for_a_free_repo() {
    let p = pair();
    std::fs::write(p.local.path.join("a.txt"), "one\nMINE\nthree\n").unwrap();
    std::fs::write(p.local.path.join("added.txt"), "added\n").unwrap();
    std::fs::remove_file(p.local.path.join("b.txt")).unwrap();
    assert_eq!(send(&p, false, true).unwrap_err().code, "runActive");
    assert_eq!(status(&p.server), "");
    assert_eq!(send(&p, false, false).unwrap().files, 3);
    assert_eq!(read(&p.server, "a.txt"), "one\nMINE\nthree\n");
    assert_eq!(read(&p.server, "added.txt"), "added\n");
    assert!(!p.server.join("b.txt").exists());
    assert_eq!(git(&p.server, &["diff", "--cached", "--name-only"]), "");
    assert_eq!(git(&p.server, &["rev-parse", "HEAD"]), git(&p.local.path, &["rev-parse", "HEAD"]));
    // the server is dirty now: a second send needs "apply on top", and a conflicting one changes nothing
    std::fs::write(p.local.path.join("a.txt"), "one\nOTHER\nthree\n").unwrap();
    assert_eq!(send(&p, false, false).unwrap_err().code, "destinationDirty");
    assert_eq!(send(&p, true, false).unwrap_err().code, "applyCheck");
    assert_eq!(read(&p.server, "a.txt"), "one\nMINE\nthree\n");
}

#[test]
fn the_server_script_refuses_git_control_paths_links_and_absolute_paths() {
    let p = pair();
    let head = git(&p.server, &["rev-parse", "HEAD"]).trim().to_string();
    let go = |patch: &str, on_top: bool, head: &str| send_patch(&p.f.ssh, &p.f.cfg, "~/work/app", head, on_top, false, patch.as_bytes(), 1);
    for path in [".git/hooks/pre-commit", "sub/.git/config", ".GIT/x", ".gitmodules", ".gitattributes", ".githooks/pre-commit", "../escape.txt", "a/../../escape.txt"] {
        let e = go(&new_file_patch(path), false, &head).unwrap_err();
        assert!(matches!(e.code.as_str(), "badPatch" | "applyCheck"), "{path}: {e:?}");
    }
    assert_eq!(go(LINK_PATCH, false, &head).unwrap_err().code, "badPatch");
    assert!(go(&new_file_patch("/tmp/intely-abs-test.txt"), false, &head).is_err());
    assert!(!p.server.join(".git/hooks/pre-commit").exists() && !p.server.join(".gitmodules").exists() && !p.f.home.join("work/escape.txt").exists());
    assert_eq!(status(&p.server), "");
    // a harmless patch goes through, a stale head does not
    assert!(go(&new_file_patch("ok.txt"), false, &head).is_ok());
    assert_eq!(go(&new_file_patch("ok2.txt"), true, &"0".repeat(40)).unwrap_err().code, "headDiffers");
}

#[test]
fn the_local_validation_refuses_the_same_hostile_patches() {
    let p = pair();
    for path in [".git/hooks/pre-commit", "sub/.git/config", ".GIT/x", ".gitmodules", ".githooks/pre-commit", "../escape.txt", "a/../../escape.txt"] {
        let e = apply_local(&Jail::off(), &p.local.path, new_file_patch(path).as_bytes(), 1).unwrap_err();
        assert!(matches!(e.code.as_str(), "badPatch" | "applyCheck"), "{path}: {e:?}");
    }
    assert_eq!(apply_local(&Jail::off(), &p.local.path, LINK_PATCH.as_bytes(), 1).unwrap_err().code, "badPatch");
    assert!(!p.local.path.join("l").exists() && !p.local.path.join(".gitmodules").exists());
    for good in ["a.txt", "dir/sub/x.rs", ".github/workflows/ci.yml", ".gitignore"] {
        assert!(valid_patch_path(good), "{good}");
    }
    for bad in ["", "/abs", "a/../b", "..", ".git", "x/.Git/y", ".gitmodules", "a\\b", "a\nb"] {
        assert!(!valid_patch_path(bad), "{bad:?}");
    }
}

#[test]
fn the_local_apply_obeys_the_mutation_jail() {
    let p = pair();
    std::fs::write(p.server.join("a.txt"), "changed\n").unwrap();
    for jail in [Jail::read_only(), Jail::e2e(p.f.dir.path().join("elsewhere"))] {
        let e = bring_changes(&p.f.ssh, &p.f.cfg, "~/work/app", &p.local, &jail, false, "", false).unwrap_err();
        assert!(e.code == "readOnly" || e.code == "testJail", "{e:?}");
        assert_eq!(read(&p.local.path, "a.txt"), "one\ntwo\nthree\n");
    }
    // inside the fixture root the apply is allowed
    let jail = Jail::e2e(p.f.dir.path());
    let id = plan(Direction::Bring, &p.f.ssh, &p.f.cfg, "~/work/app", &p.local, &jail, false).unwrap().patch_id;
    assert!(bring_changes(&p.f.ssh, &p.f.cfg, "~/work/app", &p.local, &jail, false, &id, false).is_ok());
}

#[test]
fn a_hostile_folder_name_is_not_a_command() {
    let p = pair();
    let marker = p.f.home.join("pwned");
    let evil = format!("~/work/app'; touch {}; echo '", marker.display());
    let _ = plan(Direction::Bring, &p.f.ssh, &p.f.cfg, &evil, &p.local, &Jail::off(), false);
    let _ = send_patch(&p.f.ssh, &p.f.cfg, &evil, "0", false, false, b"x", 1);
    assert!(!marker.exists());
}

// ---- security review fixes -------------------------------------------------------------------------------------------------------

fn patch_of(path: &str, mode_line: &str, body: &str) -> String {
    format!("diff --git a/{path} b/{path}\n{mode_line}\nindex 0000000..e69de29\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1 @@\n+{body}\n\\ No newline at end of file\n")
}

#[test]
fn git_reads_a_mode_with_leading_zeros_as_a_link_and_so_do_we() {
    let p = pair();
    // control: plain git really creates a symbolic link from this header, so the text "120000" is not the whole truth
    let ctl = p.f.dir.path().canonicalize().unwrap().join("ctl");
    std::fs::create_dir_all(&ctl).unwrap();
    git(&ctl, &["init", "-q", "-b", "main"]);
    let evil = patch_of("l", "new file mode 0120000", "/etc/passwd");
    let mut c = intely_core::exec::hardened_git("git");
    c.current_dir(&ctl).args(["apply", "-"]).stdin(std::process::Stdio::piped());
    let mut child = c.spawn().unwrap();
    child.stdin.take().unwrap().write_all(evil.as_bytes()).unwrap();
    assert!(child.wait().unwrap().success());
    assert!(std::fs::symlink_metadata(ctl.join("l")).unwrap().file_type().is_symlink(), "the control patch no longer creates a link; the test is moot");
    let head = git(&p.server, &["rev-parse", "HEAD"]).trim().to_string();
    for header in ["new file mode 0120000", "new file mode 00120000", "new file mode 0160000", "new file mode 120000", "new file mode 40000"] {
        let patch = patch_of("l", header, "/etc/passwd");
        let e = apply_local(&Jail::off(), &p.local.path, patch.as_bytes(), 1).unwrap_err();
        assert!(matches!(e.code.as_str(), "badPatch" | "applyCheck"), "{header}: {e:?}");
        assert!(std::fs::symlink_metadata(p.local.path.join("l")).is_err(), "{header}: a link was created here");
        let e = send_patch(&p.f.ssh, &p.f.cfg, "~/work/app", &head, false, false, patch.as_bytes(), 1).unwrap_err();
        assert!(matches!(e.code.as_str(), "badPatch" | "applyCheck"), "{header}: {e:?}");
        assert!(std::fs::symlink_metadata(p.server.join("l")).is_err(), "{header}: a link was created on the server");
    }
    // the header text alone is caught too, and a change of an existing file to a link
    assert!(creates_link_or_submodule(patch_of("l", "new file mode 0120000", "x").as_bytes()));
    let to_link = "diff --git a/a.txt b/a.txt\nold mode 100644\nnew mode 0120000\n";
    assert!(creates_link_or_submodule(to_link.as_bytes()));
    assert!(check_summary(" create mode 120000 l\n").is_err() && check_summary(" mode change 100644 => 160000 s\n").is_err());
    assert_eq!(check_summary(" create mode 100755 run.sh\n mode change 100644 => 100644 a\n").unwrap(), vec!["run.sh".to_string()]);
}

#[test]
fn what_is_applied_is_the_plan_that_was_confirmed() {
    let p = pair();
    std::fs::write(p.server.join("a.txt"), "one\nTWO\nthree\n").unwrap();
    let confirmed = plan_of(&p, Direction::Bring, false);
    assert!(!confirmed.patch_id.is_empty() && confirmed.bytes > 0 && confirmed.stat.iter().any(|s| s.path == "a.txt" && s.added == Some(1) && s.deleted == Some(1)));
    // the agent keeps working: the next read of the server is another patch
    std::fs::write(p.server.join("a.txt"), "one\nTWO\nthree\nfour\n").unwrap();
    let e = bring_changes(&p.f.ssh, &p.f.cfg, "~/work/app", &p.local, &Jail::off(), false, &confirmed.patch_id, false).unwrap_err();
    assert_eq!(e.code, "changedSinceReview");
    assert_eq!(read(&p.local.path, "a.txt"), "one\ntwo\nthree\n");
    // an extra file appearing is another patch too, and an empty id never matches
    assert_eq!(bring_changes(&p.f.ssh, &p.f.cfg, "~/work/app", &p.local, &Jail::off(), false, "", false).unwrap_err().code, "changedSinceReview");
    // the same plan goes through
    let again = plan_of(&p, Direction::Bring, false);
    assert!(bring_changes(&p.f.ssh, &p.f.cfg, "~/work/app", &p.local, &Jail::off(), false, &again.patch_id, false).is_ok());
    // send: the same rule
    let p = pair();
    std::fs::write(p.local.path.join("a.txt"), "mine\n").unwrap();
    let seen = plan_of(&p, Direction::Send, false);
    std::fs::write(p.local.path.join("a.txt"), "mine, edited\n").unwrap();
    let e = send_changes(&p.f.ssh, &p.f.cfg, "~/work/app", &p.local, &Jail::off(), false, &seen.patch_id, false, &|| false).unwrap_err();
    assert_eq!(e.code, "changedSinceReview");
    assert_eq!(status(&p.server), "");
}

#[test]
fn files_that_run_or_configure_things_need_the_extra_tick_in_both_directions() {
    for (path, body, mode) in [(".vscode/tasks.json", "{}\n", false), ("Makefile", "all:\n", false), (".husky/pre-commit", "x\n", false), (".cargo/config.toml", "x\n", false), ("tools/run.sh", "echo\n", true)] {
        let p = pair();
        let put = |root: &Path| {
            let f = root.join(path);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(&f, body).unwrap();
            if mode {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        };
        put(&p.server);
        let pl = plan_of(&p, Direction::Bring, false);
        assert!(pl.risky.iter().any(|r| r.path == path), "{path}: {:?}", pl.risky);
        assert_eq!(bring(&p, false).unwrap_err().code, "riskyPaths", "{path}");
        assert!(!p.local.path.join(path).exists());
        bring_acc(&p, false, true).unwrap();
        assert!(p.local.path.join(path).exists(), "{path}");
        // and the mirror, enforced by the server script itself
        let q = pair();
        put(&q.local.path);
        assert_eq!(plan_of(&q, Direction::Send, false).risky.len(), 1, "{path}");
        assert_eq!(send(&q, false, false).unwrap_err().code, "riskyPaths", "{path}");
        assert!(!q.server.join(path).exists());
        let head = git(&q.server, &["rev-parse", "HEAD"]).trim().to_string();
        let raw = format!("diff --git a/{path} b/{path}\nnew file mode {}\nindex 0000000..e69de29\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1 @@\n+x\n", if mode { "100755" } else { "100644" });
        assert_eq!(send_patch(&q.f.ssh, &q.f.cfg, "~/work/app", &head, false, false, raw.as_bytes(), 1).unwrap_err().code, "riskyPaths", "{path}: the script must refuse by itself");
        assert!(!q.server.join(path).exists());
        send_acc(&q, false, false, true).unwrap();
        assert!(q.server.join(path).exists(), "{path}");
    }
    // templates and ordinary files are not flagged; package.json is when a lifecycle script changes
    assert!(risky_path(".env.example").is_none() && risky_path("src/a.rs").is_none() && risky_path("docs/make.md").is_none());
    assert_eq!(risky_path("a/.env.local"), Some("env"));
    let p = pair();
    std::fs::write(p.server.join("package.json"), "{\n  \"name\": \"x\",\n  \"scripts\": { \"postinstall\": \"node x.js\" }\n}\n").unwrap();
    assert!(plan_of(&p, Direction::Bring, false).risky.iter().any(|r| r.path == "package.json" && r.code == "packageScripts"));
}

#[test]
fn a_secret_hidden_in_the_patch_is_caught_even_when_the_plan_did_not_list_it() {
    let p = pair();
    let facts = Facts { stat: vec![StatEntry { path: "creds/.env".into(), added: Some(1), deleted: Some(0), binary: false }, StatEntry { path: "img.bin".into(), added: None, deleted: None, binary: true }], ..Facts::default() };
    let files = vec![PlanFile { path: "img.bin".into(), orig_path: None, kind: ChangeKind::Untracked, untracked: true }];
    let b = patch_blocked(&files, &facts, b"diff --git a/creds/.env b/creds/.env\n");
    assert!(b.iter().any(|x| x.code == "secret" && x.path == "creds/.env") && b.iter().any(|x| x.code == "binary" && x.path == "img.bin"), "{b:?}");
    drop(p);
}

#[test]
fn a_send_waits_for_the_folder_lock_and_asks_again_whether_a_run_is_there() {
    let p = pair();
    std::fs::write(p.local.path.join("a.txt"), "mine\n").unwrap();
    let id = plan_of(&p, Direction::Send, false).patch_id;
    // a run is registered between the plan and the apply: the second look sees it
    let calls = std::cell::Cell::new(0);
    let e = send_changes(&p.f.ssh, &p.f.cfg, "~/work/app", &p.local, &Jail::off(), false, &id, false, &|| {
        calls.set(calls.get() + 1);
        calls.get() > 1
    })
    .unwrap_err();
    assert_eq!(e.code, "runActive");
    assert_eq!(status(&p.server), "");
    // a run that is starting holds the mark: the send refuses and nothing is written
    let physical = crate::cfg::canonical_path(p.server.to_str().unwrap());
    let starting = crate::repolock::begin_run(&p.f.cfg.id, &[physical.clone()]).unwrap();
    assert_eq!(send_changes(&p.f.ssh, &p.f.cfg, "~/work/app", &p.local, &Jail::off(), false, &id, false, &|| false).unwrap_err().code, "repoBusy");
    assert_eq!(status(&p.server), "");
    drop(starting);
    assert!(send_changes(&p.f.ssh, &p.f.cfg, "~/work/app", &p.local, &Jail::off(), false, &id, false, &|| false).is_ok());
    // and the lock is gone afterwards: a run may start again
    assert!(crate::repolock::begin_run(&p.f.cfg.id, &[physical]).is_ok());
}

#[test]
fn a_local_git_that_hangs_is_killed_and_one_that_prints_too_much_is_an_error() {
    let p = pair();
    let t = std::time::Instant::now();
    let e = git_local_with(&Jail::off(), &p.local.path, &["status"], None, Duration::ZERO, LOCAL_OUT_CAP).err().expect("a zero deadline must fire");
    assert!(e.message.contains("did not finish") && t.elapsed() < Duration::from_secs(5), "{e:?}");
    let e = git_local_with(&Jail::off(), &p.local.path, &["log", "-p", "--stat"], None, LOCAL_TIMEOUT, 10).err().expect("a 10 byte cap must fire");
    assert_eq!(e.code, "tooLarge");
    assert!(git_local(&Jail::off(), &p.local.path, &["status", "--porcelain"], None).unwrap().ok);
}

#[test]
fn file_system_tricks_in_names_are_refused_here_and_by_the_server_script() {
    for bad in ["dir./x", "a /x", "x:y", "a/b:stream", ".git\u{200C}/config", ".git\u{FEFF}", "a\u{202E}b.txt", ".git./hooks/x", ".GIT /x"] {
        assert!(!valid_patch_path(bad), "{bad:?}");
    }
    assert!(valid_patch_path("src/ünï/ő.rs") && valid_patch_path(".github/workflows/ci.yml"));
    let p = pair();
    let head = git(&p.server, &["rev-parse", "HEAD"]).trim().to_string();
    for name in ["dir./x.txt", "x:y.txt", ".git\u{200C}/config", "a\u{FEFF}b.txt", ".git./hooks/pre-commit"] {
        let patch = patch_of(name, "new file mode 100644", "x");
        let e = send_patch(&p.f.ssh, &p.f.cfg, "~/work/app", &head, false, false, patch.as_bytes(), 1).unwrap_err();
        assert!(matches!(e.code.as_str(), "badPatch" | "applyCheck"), "{name:?}: {e:?}");
        let e = apply_local(&Jail::off(), &p.local.path, patch.as_bytes(), 1).unwrap_err();
        assert!(matches!(e.code.as_str(), "badPatch" | "applyCheck"), "{name:?}: {e:?}");
    }
    assert_eq!(status(&p.server), "");
    assert_eq!(status(&p.local.path), "");
}
