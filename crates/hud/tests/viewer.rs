use intely_hud::viewer::{base64, read_range, resolve, stat};

fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path().join("logs")).unwrap();
    std::fs::write(d.path().join("logs/a.log"), b"hello world").unwrap();
    std::fs::write(d.path().join(".env"), b"SECRET=1").unwrap();
    std::fs::create_dir_all(d.path().join(".git")).unwrap();
    std::fs::write(d.path().join(".git/config"), b"[remote]").unwrap();
    d
}

#[test]
fn base64_matches_the_standard_vectors() {
    assert_eq!(base64(b""), "");
    assert_eq!(base64(b"f"), "Zg==");
    assert_eq!(base64(b"fo"), "Zm8=");
    assert_eq!(base64(b"foo"), "Zm9v");
    assert_eq!(base64(b"foobar"), "Zm9vYmFy");
}

#[test]
fn ranged_reads_walk_a_file_and_report_eof() {
    let d = repo();
    let r = read_range(d.path(), "logs/a.log", 0, 5).unwrap();
    assert_eq!((r.base64.as_str(), r.len, r.eof), ("aGVsbG8=", 5, false));
    let r = read_range(d.path(), "logs/a.log", 6, 1000).unwrap();
    assert_eq!((r.base64.as_str(), r.len, r.eof), ("d29ybGQ=", 5, true));
    assert_eq!(read_range(d.path(), "logs/a.log", 99, 10).unwrap().len, 0);
    assert_eq!(stat(d.path(), "logs/a.log").unwrap().size, 11);
}

#[test]
fn escapes_secrets_git_and_symlinks_are_refused() {
    let d = repo();
    let code = |rel: &str| resolve(d.path(), rel).unwrap_err().code;
    assert_eq!(code("../etc/passwd"), "invalidSelection");
    assert_eq!(code("/etc/passwd"), "invalidSelection");
    assert_eq!(code("logs/../../x"), "invalidSelection");
    assert_eq!(code(".git/config"), "invalidSelection");
    assert_eq!(code(".env"), "guardBlocked");
    assert_eq!(code("logs"), "invalidSelection");
    assert_eq!(code(""), "invalidSelection");
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("o.txt"), b"x").unwrap();
    std::os::unix::fs::symlink(outside.path().join("o.txt"), d.path().join("link.txt")).unwrap();
    assert_eq!(code("link.txt"), "invalidSelection");
}
