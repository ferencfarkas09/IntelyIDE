use std::fs;

use intely_attachments::*;

fn store() -> (tempfile::TempDir, Store) {
    let d = tempfile::tempdir().unwrap();
    let s = Store::new(d.path().join("attachments"));
    (d, s)
}

#[test]
fn imports_text_inline_and_dedupes_by_sha256() {
    let (_d, s) = store();
    let a = s.import_bytes("draft1", "notes.md", None, b"# hi", None).unwrap();
    assert_eq!(a.meta.kind, Kind::Text);
    assert!(a.meta.inline && !a.deduped && a.meta.guard.is_none());
    let b = s.import_bytes("draft1", "copy.md", None, b"# hi", None).unwrap();
    assert!(b.deduped);
    assert_eq!(b.meta.id, a.meta.id);
    assert_eq!(s.list("draft1").unwrap().len(), 1);
    // Another draft is a separate namespace.
    assert!(!s.import_bytes("draft2", "notes.md", None, b"# hi", None).unwrap().deduped);
}

#[test]
fn enforces_size_limits_per_kind() {
    let (_d, s) = store();
    let big_img = vec![1u8; (MAX_IMAGE_BYTES + 1) as usize];
    assert_eq!(s.import_bytes("d", "a.png", None, &big_img, None).unwrap_err().code, "tooLarge");
    let big_pdf = vec![2u8; (MAX_PDF_BYTES + 1) as usize];
    assert_eq!(s.import_bytes("d", "a.pdf", None, &big_pdf, None).unwrap_err().code, "tooLarge");
    let ok_img = vec![3u8; MAX_IMAGE_BYTES as usize];
    assert_eq!(s.import_bytes("d", "b.png", None, &ok_img, None).unwrap().meta.kind, Kind::Image);
    // Big text is stored but not inlined.
    let text = "x".repeat((MAX_TEXT_INLINE_BYTES + 10) as usize);
    let m = s.import_bytes("d", "big.txt", None, text.as_bytes(), None).unwrap().meta;
    assert_eq!(m.kind, Kind::Text);
    assert!(!m.inline);
}

#[test]
fn path_import_allows_a_larger_raw_image_but_caps_it() {
    let (d, s) = store();
    let p = d.path().join("shot.png");
    fs::write(&p, vec![9u8; (MAX_IMAGE_BYTES + 1000) as usize]).unwrap();
    assert_eq!(s.import_path("d", &p).unwrap().meta.kind, Kind::Image);
    let huge = d.path().join("huge.png");
    fs::write(&huge, vec![8u8; (MAX_IMAGE_RAW_BYTES + 1) as usize]).unwrap();
    assert_eq!(s.import_path("d", &huge).unwrap_err().code, "tooLarge");
}

#[test]
fn guards_flag_secret_names_dirs_and_key_contents() {
    let (d, s) = store();
    let env = d.path().join(".env");
    fs::write(&env, "TOKEN=1").unwrap();
    let g = s.import_path("d", &env).unwrap().meta.guard.unwrap();
    assert_eq!(g.reason, "secret");
    assert!(s.import_bytes("d", ".env.example", None, b"A=", None).unwrap().meta.guard.is_none());
    let k = s.import_bytes("d", "notes.txt", None, b"-----BEGIN RSA PRIVATE KEY-----\nabc", None).unwrap().meta;
    assert_eq!(k.guard.unwrap().reason, "key");
    let nd = d.path().join("dump_2024");
    fs::create_dir(&nd).unwrap();
    fs::write(nd.join("a.txt"), "rows").unwrap();
    assert_eq!(s.import_path("d", &nd.join("a.txt")).unwrap().meta.guard.unwrap().reason, "neverAdd");
    let cred = d.path().join(".ssh");
    fs::create_dir(&cred).unwrap();
    fs::write(cred.join("config"), "Host x").unwrap();
    assert_eq!(s.import_path("d", &cred.join("config")).unwrap().meta.guard.unwrap().reason, "neverRead");
}

#[test]
fn a_pasted_dotenv_keeps_its_name_and_is_guarded() {
    let (_d, s) = store();
    let m = s.import_bytes("d", ".env", None, b"A=1", None).unwrap().meta;
    assert_eq!(m.name, ".env");
    assert_eq!(m.guard.unwrap().reason, "secret");
    let k = s.import_bytes("d", "/tmp/.env.production", None, b"B=2", None).unwrap().meta;
    assert_eq!(k.guard.unwrap().reason, "secret");
}

#[test]
fn an_unconfirmed_guarded_file_cannot_be_resolved_for_sending() {
    let (_d, s) = store();
    let m = s.import_bytes("d", "id_rsa", None, b"data", None).unwrap().meta;
    assert!(m.guard.is_some());
    let ids = vec![m.id.clone()];
    assert_eq!(s.resolve_for_send("d", &ids).unwrap_err().code, "unconfirmedGuard");
    s.confirm("d", &m.id).unwrap();
    let r = s.resolve_for_send("d", &ids).unwrap();
    assert!(r[0].path.ends_with("id_rsa") && std::path::Path::new(&r[0].path).is_file());
}

#[test]
fn ids_and_names_cannot_escape_the_store() {
    let (d, s) = store();
    for bad in ["../x", "a/b", "", "a b", "..", &"x".repeat(65)] {
        assert_eq!(s.import_bytes(bad, "a.txt", None, b"1", None).unwrap_err().code, "badId", "{bad}");
        assert_eq!(s.read("ok", bad).unwrap_err().code, "badId");
        assert_eq!(s.remove("ok", bad).unwrap_err().code, "badId");
    }
    let m = s.import_bytes("d", "../../evil.sh", None, b"echo", None).unwrap().meta;
    assert_eq!(m.name, "evil.sh");
    let m2 = s.import_bytes("d", "..\\..\\.hidden", None, b"echo2", None).unwrap().meta;
    assert_eq!(m2.name, ".hidden");
    assert_eq!(sanitize_name(".."), "attachment");
    assert_eq!(sanitize_name("a/../.."), "attachment");
    assert_eq!(sanitize_name("/"), "attachment");
    assert!(!d.path().join("evil.sh").exists());
    let r = s.resolve_for_send("d", &[m.id]).unwrap();
    assert!(std::path::Path::new(&r[0].path).starts_with(s.root().join("d")));
}

#[test]
fn import_path_refuses_directories_missing_files_and_the_store_itself() {
    let (d, s) = store();
    assert_eq!(s.import_path("d", d.path()).unwrap_err().code, "notAFile");
    assert_eq!(s.import_path("d", &d.path().join("nope")).unwrap_err().code, "notFound");
    let m = s.import_bytes("d", "a.txt", None, b"one", None).unwrap().meta;
    let stored = s.root().join("d").join(&m.id).join("a.txt");
    assert_eq!(s.import_path("d", &stored).unwrap_err().code, "insideStore");
}

#[test]
fn locate_finds_an_attachment_by_id_alone() {
    let (_d, s) = store();
    let m = s.import_bytes("draftA", "a.txt", None, b"a", None).unwrap().meta;
    s.import_bytes("draftB", "b.txt", None, b"b", None).unwrap();
    assert_eq!(s.locate(&m.id).unwrap().draft_id, "draftA");
    assert_eq!(s.locate("nope").unwrap_err().code, "notFound");
    assert_eq!(s.locate("../x").unwrap_err().code, "badId");
}

#[test]
fn remove_read_and_inspect() {
    let (d, s) = store();
    let m = s.import_bytes("d", "a.txt", None, b"hello", None).unwrap().meta;
    assert_eq!(s.read("d", &m.id).unwrap(), b"hello");
    s.remove("d", &m.id).unwrap();
    assert!(s.list("d").unwrap().is_empty());
    assert_eq!(s.read("d", &m.id).unwrap_err().code, "notFound");
    let ins = Store::inspect(&[d.path().to_path_buf(), d.path().join("missing")]);
    assert!(ins[0].is_dir && !ins[1].is_dir);
}

#[test]
fn cleanup_removes_only_stale_drafts() {
    let (_d, s) = store();
    let old = s.import_bytes("old", "a.txt", None, b"1", None).unwrap().meta;
    s.import_bytes("fresh", "b.txt", None, b"2", None).unwrap();
    let far = old.created_ms + STALE_AFTER_MS + 1;
    // Pretend `fresh` was created just now relative to `far`.
    let fresh = s.list("fresh").unwrap().remove(0);
    let mut f = fresh.clone();
    f.created_ms = far;
    fs::write(s.root().join("fresh").join(format!("{}.json", f.id)), serde_json::to_vec(&f).unwrap()).unwrap();
    assert_eq!(s.cleanup(far, STALE_AFTER_MS), 1);
    assert!(s.list("old").unwrap().is_empty());
    assert_eq!(s.list("fresh").unwrap().len(), 1);
}

#[test]
fn a_draft_has_a_total_cap() {
    let (_d, s) = store();
    for i in 0..4u8 {
        s.import_bytes("d", &format!("f{i}.bin"), None, &vec![i; (MAX_FILE_BYTES - 1) as usize], None).unwrap();
    }
    assert_eq!(s.import_bytes("d", "g.bin", None, &vec![99u8; (MAX_FILE_BYTES - 1) as usize], None).unwrap_err().code, "draftFull");
}
