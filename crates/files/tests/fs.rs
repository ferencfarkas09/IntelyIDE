mod common;

use std::os::unix::fs::{symlink, PermissionsExt};

use common::*;
use intely_core::jail::Jail;
use intely_core::GuardState;
use intely_files::{Encoding, Eol, FileChangeKind, FileKind};

#[tokio::test]
async fn list_dir_flags_ignored_never_read_status_and_symlinks() {
    let sb = Sandbox::new();
    let repo = sb.repo("r1");
    repo.write(".gitignore", "build/\n*.log\n");
    repo.write("src/a.ts", "a\n");
    repo.write("build/out.js", "x\n");
    repo.write("debug.log", "x\n");
    repo.write(".env", "SECRET=1\n");
    repo.write("dump_2026/users.json", "[]\n");
    repo.commit_all("more");
    repo.write("src/a.ts", "changed\n");
    repo.write("new.txt", "n\n");
    symlink("/etc", repo.path.join("outside")).unwrap();
    let (files, _) = files();

    let root = files.list_dir(&repo.root(), "").await.unwrap();
    let names: Vec<_> = root.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["build", "dump_2026", "src", ".env", ".gitignore", "debug.log", "new.txt", "outside", "README.md"]);
    let get = |n: &str| root.iter().find(|e| e.name == n).unwrap();
    assert!(get("build").ignored && get("debug.log").ignored && !get("src").ignored);
    assert!(get(".env").never_read && get("dump_2026").never_read && !get("README.md").never_read);
    assert_eq!(get("src").git_status.as_deref(), Some("M"));
    assert_eq!(get("new.txt").git_status.as_deref(), Some("?"));
    assert_eq!(get("README.md").git_status, None);
    assert_eq!(get("outside").kind, FileKind::Symlink);
    assert_eq!(get("README.md").size, Some(10.0));

    let src = files.list_dir(&repo.root(), "src").await.unwrap();
    assert_eq!(src.len(), 1);
    assert_eq!(src[0].git_status.as_deref(), Some("M"));

    // Ignored folders are listed, but without asking git for their status.
    assert_eq!(files.list_dir(&repo.root(), "build").await.unwrap()[0].name, "out.js");
}

#[tokio::test]
async fn list_dir_refuses_paths_that_leave_the_repo() {
    let sb = Sandbox::new();
    let repo = sb.repo("r1");
    symlink("/etc", repo.path.join("link")).unwrap();
    let (files, _) = files();
    for bad in ["..", "../x", "/etc", "link", "link/ssh", ".git", "README.md"] {
        assert!(files.list_dir(&repo.root(), bad).await.is_err(), "{bad} should be refused");
    }
    let root = files.list_dir(&repo.root(), "").await.unwrap();
    assert!(root.iter().all(|e| e.name != ".git"));
}

#[tokio::test]
async fn read_file_detects_eol_encoding_binary_and_size() {
    let sb = Sandbox::new();
    let repo = sb.repo("r1");
    repo.write("lf.txt", "a\nb\n");
    repo.write("crlf.txt", "a\r\nb\r\n");
    repo.write("bom.txt", [0xEF, 0xBB, 0xBF, b'h', b'i']);
    repo.write("latin.txt", [b'c', b'a', b'f', 0xE9]);
    repo.write("bin.dat", [0u8, 1, 2, 3]);
    repo.write("big.txt", vec![b'x'; 5 * 1024 * 1024 + 1]);
    let (files, _) = files();
    let root = repo.root();
    let read = |p: &'static str| files.read_file(&root, p, false);

    let lf = read("lf.txt").await.unwrap();
    assert_eq!((lf.text.as_deref(), lf.eol, lf.encoding, lf.guard), (Some("a\nb\n"), Eol::Lf, Encoding::Utf8, GuardState::Ok));
    assert!(lf.mtime_ms > 1.6e12 && lf.size == 4.0);
    assert_eq!(read("crlf.txt").await.unwrap().eol, Eol::Crlf);
    let bom = read("bom.txt").await.unwrap();
    assert_eq!((bom.text.as_deref(), bom.encoding), (Some("hi"), Encoding::Utf8Bom));
    let latin = read("latin.txt").await.unwrap();
    assert_eq!((latin.text.as_deref(), latin.encoding), (Some("caf\u{e9}"), Encoding::Latin1));
    let bin = read("bin.dat").await.unwrap();
    assert!(bin.binary && bin.text.is_none());
    let big = read("big.txt").await.unwrap();
    // Over 5 MiB the file opens as a read-only prefix.
    assert!(big.too_large && !big.binary && big.size == (5 * 1024 * 1024 + 1) as f64);
    assert_eq!(big.text.as_ref().map(String::len), Some(5 * 1024 * 1024));
    assert!(read("missing.txt").await.is_err());
}

#[tokio::test]
async fn hungarian_legacy_files_are_detected_reopened_and_saved_in_their_encoding() {
    let sb = Sandbox::new();
    let repo = sb.repo("r1");
    let latin2: &[u8] = b"\xe1rv\xedzt\xfbr\xf5 t\xfck\xf6rf\xfar\xf3g\xe9p\n";
    repo.write("hu.txt", latin2);
    let (files, _) = files();
    let root = repo.root();

    let read = files.read_file(&root, "hu.txt", false).await.unwrap();
    assert_eq!(read.encoding, Encoding::Latin2);
    assert_eq!(read.text.as_deref(), Some("\u{e1}rv\u{ed}zt\u{171}r\u{151} t\u{fc}k\u{f6}rf\u{fa}r\u{f3}g\u{e9}p\n"));
    // Reopen as UTF-8 fails (it would corrupt the file), as Windows-1250 works.
    assert!(files.read_file_as(&root, "hu.txt", false, Some(Encoding::Utf8)).await.is_err());
    let as_1250 = files.read_file_as(&root, "hu.txt", false, Some(Encoding::Windows1250)).await.unwrap();
    assert_eq!((as_1250.encoding, as_1250.text), (Encoding::Windows1250, read.text.clone()));

    // Saving with the original encoding gives back the same bytes.
    let text = read.text.unwrap();
    files.write_file(&root, "hu.txt", &text, read.mtime_ms, false, Some(Encoding::Latin2)).await.unwrap();
    assert_eq!(std::fs::read(repo.path.join("hu.txt")).unwrap(), latin2);
}

#[tokio::test]
async fn guarded_files_need_reveal_and_outside_paths_are_refused() {
    let sb = Sandbox::new();
    let repo = sb.repo("r1");
    repo.write(".env", "SECRET=1\n");
    repo.write("dump_x/a.txt", "dump\n");
    symlink("/etc/hosts", repo.path.join("hosts")).unwrap();
    let (files, _) = files();

    let hidden = files.read_file(&repo.root(), ".env", false).await.unwrap();
    assert!(hidden.text.is_none() && hidden.guard == GuardState::Secret);
    let shown = files.read_file(&repo.root(), ".env", true).await.unwrap();
    assert_eq!(shown.text.as_deref(), Some("SECRET=1\n"));
    assert!(files.read_file(&repo.root(), "dump_x/a.txt", false).await.unwrap().text.is_none());
    for bad in ["../x", "/etc/hosts", "hosts", ".git/config"] {
        assert!(files.read_file(&repo.root(), bad, true).await.is_err(), "{bad} should be refused");
    }
}

#[tokio::test]
async fn write_file_is_atomic_detects_conflicts_and_keeps_mode_and_encoding() {
    let sb = Sandbox::new();
    let repo = sb.repo("r1");
    repo.write("run.sh", "echo 1\n");
    std::fs::set_permissions(repo.path.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let (files, _) = files();
    let root = repo.root();

    let before = files.read_file(&root, "run.sh", false).await.unwrap();
    let saved = files.write_file(&root, "run.sh", "echo 2\n", before.mtime_ms, false, None).await.unwrap();
    assert_eq!(repo.read("run.sh"), "echo 2\n");
    assert_eq!(std::fs::metadata(repo.path.join("run.sh")).unwrap().permissions().mode() & 0o777, 0o755);
    assert_eq!(files.read_file(&root, "run.sh", false).await.unwrap().mtime_ms, saved.mtime_ms);

    // The mtime the editor holds is stale now.
    let stale = files.write_file(&root, "run.sh", "echo 3\n", before.mtime_ms - 5000.0, false, None).await.unwrap_err();
    assert_eq!(stale.code, "staleFile");
    assert_eq!(repo.read("run.sh"), "echo 2\n");

    // New files (expected mtime 0), also in new folders; an existing one is a conflict.
    files.write_file(&root, "deep/er/new.txt", "n\n", 0.0, false, None).await.unwrap();
    assert_eq!(repo.read("deep/er/new.txt"), "n\n");
    assert_eq!(files.write_file(&root, "deep/er/new.txt", "x", 0.0, false, None).await.unwrap_err().code, "staleFile");
    assert_eq!(files.write_file(&root, "gone.txt", "x", 123.0, false, None).await.unwrap_err().code, "staleFile");

    files.write_file(&root, "bom.txt", "caf\u{e9}", 0.0, false, Some(Encoding::Utf8Bom)).await.unwrap();
    assert_eq!(std::fs::read(repo.path.join("bom.txt")).unwrap(), [&[0xEF, 0xBB, 0xBF][..], "caf\u{e9}".as_bytes()].concat());

    let leftovers: Vec<_> = std::fs::read_dir(&repo.path).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
    assert!(leftovers.is_empty());
}

#[tokio::test]
async fn write_file_stays_inside_the_repo_and_respects_the_guard() {
    let sb = Sandbox::new();
    let repo = sb.repo("r1");
    let outside = sb.root.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("target.txt"), "keep\n").unwrap();
    symlink(&outside, repo.path.join("linkdir")).unwrap();
    symlink(outside.join("target.txt"), repo.path.join("linkfile")).unwrap();
    repo.write(".env", "A=1\n");
    let (files, _) = files();
    let root = repo.root();

    for bad in ["../escape.txt", "/tmp/abs.txt", "linkdir/new.txt", "linkfile", ".git/hooks/pre-commit", ".git/config"] {
        assert!(files.write_file(&root, bad, "pwn", 0.0, false, None).await.is_err(), "{bad} should be refused");
    }
    assert_eq!(std::fs::read_to_string(outside.join("target.txt")).unwrap(), "keep\n");
    assert!(!outside.join("new.txt").exists() && !sb.root.join("escape.txt").exists());

    let env = files.read_file(&root, ".env", true).await.unwrap();
    assert_eq!(files.write_file(&root, ".env", "A=2\n", env.mtime_ms, false, None).await.unwrap_err().code, "guardBlocked");
    files.write_file(&root, ".env", "A=2\n", env.mtime_ms, true, None).await.unwrap();
    assert_eq!(repo.read(".env"), "A=2\n");
}

#[tokio::test]
async fn the_jail_stops_writes_but_not_reads() {
    let sb = Sandbox::new();
    let repo = sb.repo("r1");
    let (ro, _) = files_with(Jail::read_only());
    assert_eq!(ro.write_file(&repo.root(), "x.txt", "x", 0.0, false, None).await.unwrap_err().code, "readOnly");
    assert!(ro.read_file(&repo.root(), "README.md", false).await.is_ok());
    assert!(ro.list_dir(&repo.root(), "").await.is_ok());

    let elsewhere = tempfile::Builder::new().prefix("intely-c1-fixture-").tempdir().unwrap();
    let (e2e, _) = files_with(Jail::e2e(elsewhere.path()));
    assert_eq!(e2e.write_file(&repo.root(), "x.txt", "x", 0.0, false, None).await.unwrap_err().code, "testJail");
    assert!(!repo.exists("x.txt"));
}

#[tokio::test]
async fn quick_open_index_lists_visible_files_and_follows_changes() {
    let sb = Sandbox::new();
    let repo = sb.repo("r1");
    repo.write(".gitignore", "build/\n");
    repo.write("src/a.ts", "a\n");
    repo.write("build/out.js", "x\n");
    repo.write(".env", "S=1\n");
    repo.write("dump_1/x.json", "[]\n");
    repo.commit_all("files");
    repo.write("untracked.txt", "u\n");
    std::fs::remove_file(repo.path.join("src/a.ts")).unwrap();
    let (files, _) = files();
    let root = repo.root();

    let index = files.quick_open_index(&root).await.unwrap();
    assert_eq!(*index, [".gitignore", "README.md", "untracked.txt"]);

    // The repo watcher (FSEvents) marks the cache dirty; the next request recomputes.
    repo.write("later.txt", "l\n");
    assert!(eventually(10, || {
        let files = files.clone();
        let root = root.clone();
        std::thread::spawn(move || tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(files.quick_open_index(&root)).unwrap())
            .join()
            .unwrap()
            .contains(&"later.txt".to_owned())
    }));

    // Our own writes invalidate immediately.
    files.write_file(&root, "mine.txt", "m\n", 0.0, false, None).await.unwrap();
    assert!(files.quick_open_index(&root).await.unwrap().contains(&"mine.txt".to_owned()));
}

#[tokio::test]
async fn watch_file_reports_external_changes_but_not_our_own_saves() {
    let sb = Sandbox::new();
    let repo = sb.repo("r1");
    repo.write("w.txt", "one\n");
    let (files, rec) = files();
    let root = repo.root();
    files.watch_file(&root, "w.txt").unwrap();
    files.watch_file(&root, "w.txt").unwrap();
    let kinds = || rec.changes.lock().unwrap().iter().map(|c| (c.path.clone(), c.kind)).collect::<Vec<_>>();
    std::thread::sleep(std::time::Duration::from_millis(300));

    let read = files.read_file(&root, "w.txt", false).await.unwrap();
    files.write_file(&root, "w.txt", "mine\n", read.mtime_ms, false, None).await.unwrap();
    std::thread::sleep(std::time::Duration::from_millis(700));
    assert!(kinds().is_empty(), "own save was echoed: {:?}", kinds());

    std::thread::sleep(std::time::Duration::from_millis(1100));
    repo.write("w.txt", "external\n");
    assert!(eventually(10, || kinds() == [("w.txt".to_owned(), FileChangeKind::Changed)]), "{:?}", kinds());

    std::fs::remove_file(repo.path.join("w.txt")).unwrap();
    assert!(eventually(10, || kinds().last().is_some_and(|k| k.1 == FileChangeKind::Deleted)), "{:?}", kinds());
    repo.write("w.txt", "back\n");
    assert!(eventually(10, || kinds().last().is_some_and(|k| k.1 == FileChangeKind::Created)), "{:?}", kinds());

    files.unwatch_file("r1", "w.txt");
    assert!(files.watch_file(&root, "../x").is_err());
}

#[tokio::test]
async fn create_rename_and_trash_stay_inside_the_repo_and_never_delete() {
    let sb = Sandbox::new();
    let repo = sb.repo("r1");
    symlink("/etc", repo.path.join("link")).unwrap();
    let trash = sb.root.join("trash");
    let (files, _) = files();
    let root = repo.root();

    files.create_entry(&root, "src/new.ts", FileKind::File).await.unwrap();
    files.create_entry(&root, "src/empty", FileKind::Dir).await.unwrap();
    assert_eq!(repo.read("src/new.ts"), "");
    assert!(repo.path.join("src/empty").is_dir());
    assert_eq!(files.create_entry(&root, "src/new.ts", FileKind::File).await.unwrap_err().code, "exists");
    for bad in ["../x", "/tmp/x", "link/x", ".git/x"] {
        assert!(files.create_entry(&root, bad, FileKind::File).await.is_err(), "{bad}");
    }

    repo.write("src/a.ts", "a\n");
    files.rename_entry(&root, "src/a.ts", "src/b.ts").await.unwrap();
    assert!(!repo.exists("src/a.ts") && repo.read("src/b.ts") == "a\n");
    assert_eq!(files.rename_entry(&root, "src/b.ts", "README.md").await.unwrap_err().code, "exists");
    for (from, to) in [("src/b.ts", "../b.ts"), ("src/b.ts", "link/b.ts"), ("README.md", ".git/x"), ("missing", "other")] {
        assert!(files.rename_entry(&root, from, to).await.is_err(), "{from} -> {to}");
    }

    files.trash_entry(&root, "src/b.ts", &trash).await.unwrap();
    repo.write("src/b.ts", "second\n");
    files.trash_entry(&root, "src/b.ts", &trash).await.unwrap();
    files.trash_entry(&root, "src", &trash).await.unwrap();
    assert!(!repo.exists("src"));
    assert_eq!(std::fs::read_to_string(trash.join("b.ts")).unwrap(), "a\n");
    assert_eq!(std::fs::read_to_string(trash.join("b.ts 2")).unwrap(), "second\n");
    assert!(trash.join("src/new.ts").exists());
    // Trashing a symlink moves the link, not its target.
    files.trash_entry(&root, "link", &trash).await.unwrap();
    assert!(!repo.exists("link") && std::path::Path::new("/etc").exists());
    assert!(files.trash_entry(&root, "../x", &trash).await.is_err());

    assert!(files.entry_path(&root, "README.md").unwrap().ends_with("work/r1/README.md"));
    assert!(files.entry_path(&root, "nope").is_err());
}

#[tokio::test]
async fn entry_mutations_are_refused_by_the_jail() {
    let sb = Sandbox::new();
    let repo = sb.repo("r1");
    let (ro, _) = files_with(Jail::read_only());
    let trash = sb.root.join("trash");
    assert_eq!(ro.create_entry(&repo.root(), "x.txt", FileKind::File).await.unwrap_err().code, "readOnly");
    assert_eq!(ro.rename_entry(&repo.root(), "README.md", "R.md").await.unwrap_err().code, "readOnly");
    assert_eq!(ro.trash_entry(&repo.root(), "README.md", &trash).await.unwrap_err().code, "readOnly");
    assert!(repo.exists("README.md") && !repo.exists("x.txt") && !trash.exists());
}
