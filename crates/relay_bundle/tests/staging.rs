//! Stage rules (spec 4.12.2), seq rules (4.5) and the "no key on disk" guarantee, all on throwaway directories.

mod common;

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use intely_relay_bundle::manifest::{manifest_hash, verify_manifest_str, VerifyOpts};
use intely_relay_bundle::{
    generate_signing_key, public_key_of, stage_and_sign, stage_and_sign_with, verify_staged, BundleError, Limits, Secret, SignOptions,
};

const NOW: u64 = 1_790_000_000;

fn dist_with(files: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let dist = tmp.path().join("dist");
    for (p, c) in files {
        let t = dist.join(p);
        fs::create_dir_all(t.parent().unwrap()).unwrap();
        fs::write(t, c).unwrap();
    }
    (tmp, dist)
}

fn basic() -> (tempfile::TempDir, PathBuf) {
    dist_with(&[("index.html", "<!doctype html>"), ("assets/app.js", "console.log(1)"), ("_headers", "/*\n  X-Test: 1\n")])
}

fn stage(dist: &Path, tmp: &Path) -> Result<intely_relay_bundle::StagedBundle, BundleError> {
    let (key, _) = generate_signing_key().unwrap();
    stage_and_sign(dist, &tmp.join("out/dist"), &key, None, None, NOW)
}

fn refused(r: Result<intely_relay_bundle::StagedBundle, BundleError>) -> (&'static str, String) {
    match r {
        Err(BundleError::Stage { code, path }) => (code, path),
        other => panic!("expected a stage refusal, got {other:?}"),
    }
}

#[test]
fn generated_key_signs_and_verifies_under_its_pin() {
    let (tmp, dist) = basic();
    let (key, pubkey) = generate_signing_key().unwrap();
    assert_eq!(public_key_of(&key).unwrap(), pubkey);
    let out = tmp.path().join("out/dist");
    let s = stage_and_sign(&dist, &out, &key, Some("BPUBLICKEYTEXT"), None, NOW).unwrap();
    assert_eq!(s.seq, NOW);
    assert_eq!(s.pubkey, pubkey);
    let text = fs::read_to_string(out.join("bundle.json")).unwrap();
    let v = verify_manifest_str(&text, &VerifyOpts { pin: Some(&pubkey), min_seq: Some(NOW), allow_v1: false }).unwrap();
    assert_eq!(v.hash, s.hash);
    assert_eq!(v.built_at, Some(NOW));
    // push-config.json is the one the stager wrote; the build's own copy is ignored.
    assert_eq!(fs::read_to_string(out.join("push-config.json")).unwrap(), "{\"vapidPublicKey\":\"BPUBLICKEYTEXT\"}\n");
    assert_eq!(s.files, 4);
    verify_staged(&out, Some(&pubkey), None).unwrap();
}

#[test]
fn push_off_writes_the_null_default_and_replaces_a_stale_build_copy() {
    let (tmp, dist) = dist_with(&[("index.html", "x"), ("push-config.json", "{\"vapidPublicKey\":\"STALE\"}")]);
    let (key, _) = generate_signing_key().unwrap();
    let out = tmp.path().join("out/dist");
    stage_and_sign(&dist, &out, &key, None, None, NOW).unwrap();
    assert_eq!(fs::read_to_string(out.join("push-config.json")).unwrap(), "{\"vapidPublicKey\":null}\n");
}

#[test]
fn a_vapid_public_key_that_could_break_the_json_is_refused() {
    let (tmp, dist) = basic();
    let (key, _) = generate_signing_key().unwrap();
    for bad in ["", "a\"b", "a b", "a\nb", "é", &"A".repeat(200)] {
        let r = stage_and_sign(&dist, &tmp.path().join("o/d"), &key, Some(bad), None, NOW);
        assert!(matches!(r, Err(BundleError::Invalid(_))), "{bad:?}");
    }
}

#[test]
fn seq_is_now_first_then_previous_plus_one_and_clock_far_behind_is_refused() {
    let (tmp, dist) = basic();
    let (key, _) = generate_signing_key().unwrap();
    let out = tmp.path().join("o/d");
    assert_eq!(stage_and_sign(&dist, &out, &key, None, None, NOW).unwrap().seq, NOW);
    assert_eq!(stage_and_sign(&dist, &out, &key, None, Some(NOW), NOW + 5).unwrap().seq, NOW + 1);
    // Months later: still prev + 1 (monotonic), not the clock.
    assert_eq!(stage_and_sign(&dist, &out, &key, None, Some(NOW), NOW + 200 * 86_400).unwrap().seq, NOW + 1);
    // Stored value less than 24 h ahead: fine.
    assert_eq!(stage_and_sign(&dist, &out, &key, None, Some(NOW + 3_600), NOW).unwrap().seq, NOW + 3_601);
    // More than 24 h ahead of the clock: typed refusal, then the override works.
    let r = stage_and_sign(&dist, &out, &key, None, Some(NOW + 2 * 86_400), NOW);
    assert!(matches!(r, Err(BundleError::SeqClock { stored, now }) if stored == NOW + 2 * 86_400 && now == NOW), "{r:?}");
    assert_eq!(r.unwrap_err().code(), "seqClock");
    let opts = SignOptions { allow_seq_clock_skew: true, ..Default::default() };
    let s = stage_and_sign_with(&dist, &out, &key, None, Some(NOW + 2 * 86_400), NOW, &opts).unwrap();
    assert_eq!(s.bundle.seq, NOW + 2 * 86_400 + 1);
    // The 2^53-1 ceiling.
    let max = (1u64 << 53) - 1;
    assert!(matches!(stage_and_sign_with(&dist, &out, &key, None, Some(max), max, &opts), Err(BundleError::SeqExhausted)));
    assert!(matches!(stage_and_sign(&dist, &out, &key, None, None, max + 1), Err(BundleError::SeqExhausted)));
}

#[test]
fn symlinks_hardlinks_special_files_and_odd_names_are_refused() {
    // symlink to a file outside
    let (tmp, dist) = basic();
    fs::write(tmp.path().join("secret.txt"), "s").unwrap();
    symlink(tmp.path().join("secret.txt"), dist.join("link.txt")).unwrap();
    assert_eq!(refused(stage(&dist, tmp.path())), ("symlink", "link.txt".into()));

    // symlinked directory
    let (tmp, dist) = basic();
    fs::create_dir(tmp.path().join("elsewhere")).unwrap();
    symlink(tmp.path().join("elsewhere"), dist.join("assets2")).unwrap();
    assert_eq!(refused(stage(&dist, tmp.path())), ("symlink", "assets2".into()));

    // the build directory itself is a link
    let (tmp, dist) = basic();
    let real = tmp.path().join("realdist");
    fs::rename(&dist, &real).unwrap();
    symlink(&real, &dist).unwrap();
    assert_eq!(refused(stage(&dist, tmp.path())).0, "symlink");

    // hardlink to a file outside (nlink > 1)
    let (tmp, dist) = basic();
    fs::write(tmp.path().join("outside.txt"), "o").unwrap();
    fs::hard_link(tmp.path().join("outside.txt"), dist.join("hard.txt")).unwrap();
    assert_eq!(refused(stage(&dist, tmp.path())), ("hardlink", "hard.txt".into()));

    // named pipe
    let (tmp, dist) = basic();
    let fifo = dist.join("pipe.txt");
    assert!(std::process::Command::new("mkfifo").arg(&fifo).status().unwrap().success());
    assert_eq!(refused(stage(&dist, tmp.path())), ("special", "pipe.txt".into()));
}

#[test]
fn dotfiles_secret_names_and_unlisted_extensions_are_refused() {
    for (name, code) in [
        (".env", "dotfile"),
        (".env.local", "dotfile"),
        (".DS_Store", "dotfile"),
        ("server.pem", "secretName"),
        ("tls.key", "secretName"),
        ("id_rsa", "secretName"),
        ("id_ed25519.txt", "secretName"),
        ("app.js.map", "extension"),
        ("run.sh", "extension"),
        ("noext", "extension"),
        ("page.php", "extension"),
        ("data.sqlite", "extension"),
        ("bad name.txt", "name"),
        ("caf\u{e9}.txt", "name"),
    ] {
        let (tmp, dist) = basic();
        fs::write(dist.join(name), "x").unwrap();
        let (got, path) = refused(stage(&dist, tmp.path()));
        assert_eq!((got, path.as_str()), (code, name), "{name}");
    }
    // nested dotfile and dot directory
    let (tmp, dist) = basic();
    fs::create_dir_all(dist.join("assets/.git")).unwrap();
    fs::write(dist.join("assets/.git/config"), "x").unwrap();
    assert_eq!(refused(stage(&dist, tmp.path())), ("dotfile", "assets/.git".into()));
    // upper-case extensions are matched case-insensitively and stay allowed
    let (tmp, dist) = basic();
    fs::write(dist.join("Logo.PNG"), "x").unwrap();
    stage(&dist, tmp.path()).unwrap();
}

#[test]
fn every_allowed_extension_and_the_headers_file_pass() {
    let (tmp, dist) = dist_with(&[
        ("a.html", "x"), ("a.js", "x"), ("a.css", "x"), ("a.json", "x"), ("a.svg", "x"), ("a.png", "x"), ("a.webp", "x"),
        ("a.ico", "x"), ("a.woff2", "x"), ("a.txt", "x"), ("a.webmanifest", "x"), ("_headers", "x"),
    ]);
    assert_eq!(stage(&dist, tmp.path()).unwrap().files, 13);
}

#[test]
fn caps_on_files_size_and_total_are_enforced() {
    let (tmp, dist) = basic();
    let (key, _) = generate_signing_key().unwrap();
    let out = tmp.path().join("o/d");
    let run = |limits: Limits| stage_and_sign_with(&dist, &out, &key, None, None, NOW, &SignOptions { limits, ..Default::default() });
    // the cap applies to the final set: the 3 build files plus the stager's push-config.json
    let ok = Limits { max_files: 4, max_file_bytes: 100, max_total_bytes: 1000 };
    run(ok.clone()).unwrap();
    assert!(matches!(run(Limits { max_files: 3, ..ok.clone() }), Err(BundleError::Stage { code: "tooManyFiles", .. })));
    assert!(matches!(run(Limits { max_files: 2, ..ok.clone() }), Err(BundleError::Stage { code: "tooManyFiles", .. })));
    assert!(matches!(run(Limits { max_file_bytes: 10, ..ok.clone() }), Err(BundleError::Stage { code: "fileTooBig", .. })));
    assert!(matches!(run(Limits { max_total_bytes: 20, ..ok }), Err(BundleError::Stage { code: "totalTooBig", .. })));
    // the defaults are Cloudflare's asset limits
    let d = Limits::default();
    assert_eq!((d.max_files, d.max_file_bytes), (20_000, 25 * 1024 * 1024));
}

#[test]
fn a_deep_tree_beyond_the_depth_limit_is_refused() {
    let (tmp, dist) = basic();
    let mut p = dist.clone();
    for i in 0..20 {
        p = p.join(format!("d{i}"));
    }
    fs::create_dir_all(&p).unwrap();
    fs::write(p.join("x.txt"), "x").unwrap();
    assert_eq!(refused(stage(&dist, tmp.path())).0, "depth");
}

#[test]
fn staging_location_rules_protect_the_build_and_unrelated_directories() {
    let (tmp, dist) = basic();
    let (key, _) = generate_signing_key().unwrap();
    // inside the build, or the build itself
    assert!(matches!(stage_and_sign(&dist, &dist.join("staged"), &key, None, None, NOW), Err(BundleError::Invalid(_))));
    assert!(matches!(stage_and_sign(&dist, &dist, &key, None, None, NOW), Err(BundleError::Invalid(_))));
    // a parent of the build
    assert!(matches!(stage_and_sign(&dist, tmp.path(), &key, None, None, NOW), Err(BundleError::Invalid(_))));
    // an existing non-empty directory that is not a previous bundle must not be deleted
    let precious = tmp.path().join("precious");
    fs::create_dir(&precious).unwrap();
    fs::write(precious.join("keep.txt"), "mine").unwrap();
    assert!(matches!(stage_and_sign(&dist, &precious, &key, None, None, NOW), Err(BundleError::Invalid(_))));
    assert_eq!(fs::read_to_string(precious.join("keep.txt")).unwrap(), "mine");
    // a symlink as staging path
    let link = tmp.path().join("link");
    symlink(&precious, &link).unwrap();
    assert!(matches!(stage_and_sign(&dist, &link, &key, None, None, NOW), Err(BundleError::Invalid(_))));
    // an empty existing directory and a previous staged bundle are replaced
    let empty = tmp.path().join("empty");
    fs::create_dir(&empty).unwrap();
    stage_and_sign(&dist, &empty, &key, None, None, NOW).unwrap();
    stage_and_sign(&dist, &empty, &key, None, Some(NOW), NOW + 1).unwrap();
    let names: Vec<_> = fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert!(!names.iter().any(|n| n.contains(".stage-")), "no work directory is left behind: {names:?}");
}

#[test]
fn a_failed_run_leaves_the_previous_staging_untouched() {
    let (tmp, dist) = basic();
    let (key, _) = generate_signing_key().unwrap();
    let out = tmp.path().join("o/d");
    let first = stage_and_sign(&dist, &out, &key, None, None, NOW).unwrap();
    fs::write(dist.join(".env"), "TOKEN=x").unwrap();
    assert!(stage_and_sign(&dist, &out, &key, None, Some(NOW), NOW + 1).is_err());
    verify_staged(&out, Some(&first.pubkey), None).unwrap();
    let names: Vec<_> = fs::read_dir(tmp.path().join("o")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, vec!["d".to_string()]);
}

#[test]
fn extra_files_are_staged_signed_and_checked() {
    let (tmp, dist) = basic();
    let (key, pubkey) = generate_signing_key().unwrap();
    let out = tmp.path().join("o/d");
    let opts = SignOptions { extra_files: vec![("licenses.txt".into(), b"GPL-3.0-or-later".to_vec())], ..Default::default() };
    let s = stage_and_sign_with(&dist, &out, &key, None, None, NOW, &opts).unwrap();
    assert!(s.file_list.iter().any(|f| f.path == "licenses.txt" && f.size == 16));
    assert_eq!(manifest_hash(&s.file_list), s.bundle.hash);
    verify_staged(&out, Some(&pubkey), None).unwrap();
    for bad in ["bundle.json", "push-config.json", "../x.txt", "/abs.txt", "a b.txt"] {
        let o = SignOptions { extra_files: vec![(bad.into(), b"x".to_vec())], ..Default::default() };
        assert!(matches!(stage_and_sign_with(&dist, &out, &key, None, None, NOW, &o), Err(BundleError::Invalid(_))), "{bad}");
    }
    // collides with a build file
    let o = SignOptions { extra_files: vec![("index.html".into(), b"x".to_vec())], ..Default::default() };
    assert!(stage_and_sign_with(&dist, &out, &key, None, None, NOW, &o).is_err());
    // refused names inside extras go through the same rules
    let o = SignOptions { extra_files: vec![("x.sh".into(), b"x".to_vec())], ..Default::default() };
    assert!(matches!(stage_and_sign_with(&dist, &out, &key, None, None, NOW, &o), Err(BundleError::Stage { code: "extension", .. })));
}

#[test]
fn verify_staged_detects_every_kind_of_change() {
    let (tmp, dist) = basic();
    let (key, pubkey) = generate_signing_key().unwrap();
    let out = tmp.path().join("o/d");
    stage_and_sign(&dist, &out, &key, None, None, NOW).unwrap();
    verify_staged(&out, Some(&pubkey), None).unwrap();
    assert!(verify_staged(&out, Some(&pubkey), Some(NOW + 1)).is_err(), "rollback");
    let (_, other_pub) = generate_signing_key().unwrap();
    assert!(verify_staged(&out, Some(&other_pub), None).is_err(), "wrong pin");

    let changed = |f: &dyn Fn()| {
        f();
        assert!(matches!(verify_staged(&out, Some(&pubkey), None), Err(BundleError::Changed(_))));
    };
    let orig = fs::read(out.join("index.html")).unwrap();
    changed(&|| fs::write(out.join("index.html"), b"tampered").unwrap());
    fs::write(out.join("index.html"), &orig).unwrap();
    verify_staged(&out, Some(&pubkey), None).unwrap();
    changed(&|| fs::write(out.join("extra.js"), b"x").unwrap());
    fs::remove_file(out.join("extra.js")).unwrap();
    changed(&|| fs::remove_file(out.join("assets/app.js")).unwrap());
    fs::write(out.join("assets/app.js"), "console.log(1)").unwrap();
    verify_staged(&out, Some(&pubkey), None).unwrap();
    changed(&|| symlink("/etc/hosts", out.join("hosts.txt")).unwrap());
}

#[test]
fn no_key_material_is_written_anywhere() {
    let (tmp, dist) = basic();
    let (key, _) = generate_signing_key().unwrap();
    let der_b64 = key.expose().to_owned();
    let out = tmp.path().join("o/d");
    stage_and_sign(&dist, &out, &key, None, None, NOW).unwrap();
    // every file under the temp root, including staged copies and the manifest
    let mut stack = vec![tmp.path().to_path_buf()];
    let mut seen = 0;
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(d).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                stack.push(p);
            } else {
                let bytes = fs::read(&p).unwrap();
                let text = String::from_utf8_lossy(&bytes);
                assert!(!text.contains(&der_b64), "key text found in {}", p.display());
                let raw = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &der_b64).unwrap();
                assert!(!bytes.windows(raw.len()).any(|w| w == raw.as_slice()), "key bytes found in {}", p.display());
                seen += 1;
            }
        }
    }
    assert!(seen >= 5);
    // Debug of the key and of every error stays quiet
    assert_eq!(format!("{key:?}"), "Secret([redacted])");
    let err = stage_and_sign(&dist, &out, &Secret::new("not a key"), None, None, NOW).unwrap_err();
    assert!(matches!(err, BundleError::BadKey));
    assert!(!format!("{err} {err:?}").contains("not a key"));
}

#[test]
fn a_vector_style_pkcs8_v1_key_and_a_pem_both_load() {
    let v = common::vectors();
    let (tmp, dist) = basic();
    let pem = common::vector_key(&v, "A");
    assert_eq!(public_key_of(&pem).unwrap(), common::vector_pub(&v, "A"));
    // the same key as bare base64 DER
    let body: String = pem.expose().lines().filter(|l| !l.starts_with("-----")).collect();
    assert_eq!(public_key_of(&Secret::new(body.clone())).unwrap(), common::vector_pub(&v, "A"));
    stage_and_sign(&dist, &tmp.path().join("o/d"), &Secret::new(body), None, None, NOW).unwrap();
    assert!(matches!(public_key_of(&Secret::new("")), Err(BundleError::BadKey)));
    assert!(matches!(public_key_of(&Secret::new("AAAA")), Err(BundleError::BadKey)));
}

#[test]
fn walk_order_is_depth_first_with_sorted_entries() {
    let v = common::vectors();
    let site = common::site_files(&v);
    let tmp = tempfile::tempdir().unwrap();
    let dist = tmp.path().join("dist");
    common::write_site(&dist, &site);
    let (key, _) = generate_signing_key().unwrap();
    let s = stage_and_sign_with(&dist, &tmp.path().join("o/d"), &key, None, None, NOW, &SignOptions::default()).unwrap();
    let order: Vec<String> = s.file_list.iter().map(|f| f.path.clone()).collect();
    let jv = v.get("valid").unwrap().get("fileOrder").unwrap();
    let expect: Vec<String> = jv.as_array().unwrap().iter().map(|j| j.as_str().unwrap().to_owned()).collect();
    assert_eq!(order, expect);
}

#[test]
fn a_key_cross_check_with_node_agrees_when_node_exists() {
    // The committed vectors are the primary proof (tests/vectors.rs). This asks the reference verifier itself to accept a bundle
    // signed here. It fails (not skips) when node is missing, because the spec demands the cross-check be real.
    let root = common::repo_root();
    let (tmp, dist) = basic();
    let (key, pubkey) = generate_signing_key().unwrap();
    let out = tmp.path().join("o/d");
    stage_and_sign(&dist, &out, &key, Some("BPUBLICKEYTEXT"), None, NOW).unwrap();
    let run = |extra: &[&str]| {
        std::process::Command::new("node")
            .arg(root.join("remote-relay/scripts/verify-bundle.mjs"))
            .args(["--dist", out.to_str().unwrap(), "--pub", &pubkey])
            .args(extra)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .output()
            .expect("node is required for the cross-implementation check")
    };
    let ok = run(&[]);
    assert!(ok.status.success(), "node verify-bundle rejected the Rust-signed bundle: {}", String::from_utf8_lossy(&ok.stdout));
    let rollback = run(&["--min-seq", &(NOW + 1).to_string()]);
    assert!(!rollback.status.success());
    fs::write(out.join("index.html"), "tampered").unwrap();
    assert!(!run(&[]).status.success());
}
