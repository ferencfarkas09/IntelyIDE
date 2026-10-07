//! U3: safe unpack, tree hash, stage directory lifecycle ((design notes: updater-spec) 10.2 `stage`).
mod common;

use std::fs;
use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use common::tarball::*;
use intely_updater::stage::*;
use intely_updater::{ErrorCode, UpdateError};

const TOP: &str = "IntelyIDE.app";

struct Env {
    _tmp: tempfile::TempDir,
    parent: PathBuf,
    stage: PathBuf,
}

fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let parent = tmp.path().canonicalize().unwrap().join("apps");
    fs::create_dir(&parent).unwrap();
    // A sentinel that must never change.
    fs::create_dir(parent.join("sentinel")).unwrap();
    fs::write(parent.join("sentinel/keep"), b"keep").unwrap();
    let stage = create_stage_dir(&parent).unwrap();
    Env { _tmp: tmp, parent, stage }
}

/// Every path under `parent` that is not inside the stage directory.
fn outside(env: &Env) -> Vec<String> {
    fn rec(dir: &Path, skip: &Path, out: &mut Vec<String>) {
        for e in fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p == skip {
                continue;
            }
            let m = fs::symlink_metadata(&p).unwrap();
            out.push(format!("{} {:o} {}", p.display(), m.mode(), m.len()));
            if m.is_dir() {
                rec(&p, skip, out);
            }
        }
    }
    let mut v = Vec::new();
    rec(env.parent.parent().unwrap(), &env.stage, &mut v);
    v.sort();
    v
}

fn unpack_with(env: &Env, gz: &[u8], lim: &Limits) -> Result<Unpacked, UpdateError> {
    unpack(gz, &env.stage, TOP, lim)
}

/// The archive must be refused with `code`, leave nothing outside the stage and no bundle dir inside.
fn refused(gz: &[u8], code: ErrorCode) {
    refused_with(gz, code, &Limits::default());
}

fn refused_with(gz: &[u8], code: ErrorCode, lim: &Limits) {
    let env = env();
    let before = outside(&env);
    let err = unpack_with(&env, gz, lim).expect_err("must be refused");
    assert_eq!(err.code, code, "{err}");
    assert_eq!(before, outside(&env), "files outside the stage changed");
    assert!(!env.stage.join(TOP).exists(), "partial bundle left behind");
    // The streaming hash refuses the same archive with the same code.
    let scan = tree_hash_of_tarball(gz, TOP, lim).expect_err("scan must refuse too");
    assert_eq!(scan.code, code, "scan: {scan}");
    assert!(env.stage.join(STAGE_MARKER).exists());
}

fn mode_of(p: &Path) -> u32 {
    fs::symlink_metadata(p).unwrap().mode() & 0o7777
}

// ------------------------------------------------------------------------------------------
// The valid archive
// ------------------------------------------------------------------------------------------

#[test]
fn valid_tarball_unpacks_with_modes_and_symlinks() {
    let env = env();
    let gz = simple_app_tar(TOP);
    let u = unpack_with(&env, &gz, &Limits::default()).unwrap();
    assert_eq!(u.root, env.stage.join(TOP));
    let r = &u.root;
    assert_eq!(fs::read(r.join("Contents/Info.plist")).unwrap(), b"<plist/>");
    assert_eq!(mode_of(&r.join("Contents/MacOS/Exe")), 0o755);
    assert_eq!(mode_of(&r.join("Contents/Info.plist")), 0o644);
    assert_eq!(mode_of(&r.join("Contents/Frameworks/F.framework/Versions/A")), 0o755);
    let link = r.join("Contents/Frameworks/F.framework/Versions/Current");
    assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert_eq!(fs::read_link(&link).unwrap(), PathBuf::from("A"));
    assert_eq!(fs::read(r.join("Contents/Frameworks/F.framework/F")).unwrap(), b"framework");
    assert_eq!(u.summary.entries, 11);
    assert_eq!(u.summary.bytes, 8 + 17 + 9);
}

#[test]
fn streamed_tree_hash_equals_the_stage_tree_hash() {
    let env = env();
    let gz = simple_app_tar(TOP);
    let streamed = tree_hash_of_tarball(&gz[..], TOP, &Limits::default()).unwrap();
    let u = unpack_with(&env, &gz, &Limits::default()).unwrap();
    let on_disk = tree_hash_of_dir(&u.root, &Limits::default()).unwrap();
    assert_eq!(streamed, u.summary);
    assert_eq!(streamed, on_disk);
    assert_eq!(streamed.tree_hash.len(), 64);
}

#[test]
fn tree_hash_is_stable_and_sensitive() {
    let base = |content: &[u8], mode: u32, target: &str| {
        let mut t = RawTar::new();
        t.dir(&format!("{TOP}/"), 0o755).file(&format!("{TOP}/f"), mode, content).symlink(&format!("{TOP}/l"), target);
        t.gz()
    };
    let h = |gz: &[u8]| tree_hash_of_tarball(gz, TOP, &Limits::default()).unwrap().tree_hash;
    let a = base(b"abc", 0o644, "f");
    assert_eq!(h(&a), h(&base(b"abc", 0o644, "f")), "stable");
    assert_ne!(h(&a), h(&base(b"abd", 0o644, "f")), "one byte");
    assert_ne!(h(&a), h(&base(b"abc", 0o645, "f")), "one mode bit");
    assert_ne!(h(&a), h(&base(b"abc", 0o644, "g")), "one symlink target");
    // Two extractions of the same archive give the same disk hash.
    let (e1, e2) = (env(), env());
    let u1 = unpack_with(&e1, &a, &Limits::default()).unwrap();
    let u2 = unpack_with(&e2, &a, &Limits::default()).unwrap();
    assert_eq!(tree_hash_of_dir(&u1.root, &Limits::default()).unwrap(), tree_hash_of_dir(&u2.root, &Limits::default()).unwrap());
}

#[test]
fn disk_hash_changes_when_a_stage_file_changes() {
    let env = env();
    let u = unpack_with(&env, &simple_app_tar(TOP), &Limits::default()).unwrap();
    let before = tree_hash_of_dir(&u.root, &Limits::default()).unwrap();
    fs::write(u.root.join("Contents/Info.plist"), b"<plist!>").unwrap();
    assert_ne!(before, tree_hash_of_dir(&u.root, &Limits::default()).unwrap());
    fs::write(u.root.join("Contents/Info.plist"), b"<plist/>").unwrap();
    fs::set_permissions(u.root.join("Contents/Info.plist"), fs::Permissions::from_mode(0o600)).unwrap();
    assert_ne!(before, tree_hash_of_dir(&u.root, &Limits::default()).unwrap());
}

#[test]
fn implicit_parents_directory_order_and_mode_normalisation() {
    let env = env();
    let mut t = RawTar::new();
    // No directory entries for a/b: implicit, 0755. A file with mode 0 gets 0400; a dir 0555 gets 0755.
    t.file(&format!("{TOP}/a/b/c.txt"), 0o000, b"x")
        .dir(&format!("{TOP}/a/"), 0o555)
        .dir(&format!("{TOP}/ro/"), 0o500)
        .file(&format!("{TOP}/ro/f"), 0o444, b"y");
    let u = unpack_with(&env, &t.gz(), &Limits::default()).unwrap();
    assert_eq!(mode_of(&u.root.join("a/b")), 0o755);
    assert_eq!(mode_of(&u.root.join("a")), 0o755);
    assert_eq!(mode_of(&u.root.join("a/b/c.txt")), 0o400);
    assert_eq!(mode_of(&u.root.join("ro")), 0o700);
    assert_eq!(mode_of(&u.root.join("ro/f")), 0o444);
    assert_eq!(tree_hash_of_tarball(&t.gz()[..], TOP, &Limits::default()).unwrap(), u.summary);
    assert_eq!(tree_hash_of_dir(&u.root, &Limits::default()).unwrap(), u.summary);
}

#[test]
fn setuid_setgid_sticky_are_masked_off() {
    let env = env();
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o1755).file(&format!("{TOP}/suid"), 0o4755, b"x").file(&format!("{TOP}/sgid"), 0o2755, b"x").dir(&format!("{TOP}/sticky/"), 0o1777);
    let u = unpack_with(&env, &t.gz(), &Limits::default()).unwrap();
    assert_eq!(mode_of(&u.root.join("suid")), 0o755);
    assert_eq!(mode_of(&u.root.join("sgid")), 0o755);
    assert_eq!(mode_of(&u.root.join("sticky")), 0o777);
    assert_eq!(mode_of(&u.root), 0o755);
}

#[test]
fn extended_attributes_are_not_restored() {
    let env = env();
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755);
    t.pax(&[("SCHILY.xattr.user.test", b"1"), ("LIBARCHIVE.xattr.com.apple.quarantine", b"MA==")], false);
    t.file(&format!("{TOP}/f"), 0o644, b"x");
    let u = unpack_with(&env, &t.gz(), &Limits::default()).unwrap();
    let out = std::process::Command::new("/usr/bin/xattr").arg(u.root.join("f")).output().unwrap();
    // The updater itself writes no attribute; the OS may add `com.apple.provenance`, nothing else.
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        assert!(line.trim() == "com.apple.provenance", "unexpected xattr {line}");
    }
}

#[test]
fn gnu_long_names_and_pax_paths_are_honoured() {
    let env = env();
    let long = path_of_len(TOP, 300);
    let mut t = RawTar::new();
    t.file(&long, 0o644, b"long");
    let pax_path = path_of_len(TOP, 200).replace("/a", "/b");
    t.pax(&[("path", pax_path.as_bytes())], false);
    t.entry(format!("{TOP}/short").as_bytes(), FILE, 0o644, 3, b"", b"pax");
    let u = unpack_with(&env, &t.gz(), &Limits::default()).unwrap();
    assert_eq!(fs::read(env.stage.join(&long)).unwrap(), b"long");
    assert_eq!(fs::read(env.stage.join(&pax_path)).unwrap(), b"pax");
    assert!(!u.root.join("short").exists());
}

// ------------------------------------------------------------------------------------------
// Hostile archives
// ------------------------------------------------------------------------------------------

#[test]
fn traversal_is_refused() {
    for name in [format!("{TOP}/../evil"), "../evil".to_string(), format!("{TOP}/a/../../evil"), format!("{TOP}/./x"), format!("{TOP}//x")] {
        let mut t = RawTar::new();
        t.dir(&format!("{TOP}/"), 0o755).file(&name, 0o644, b"evil");
        refused(&t.gz(), ErrorCode::UnsafeEntry);
    }
}

#[test]
fn absolute_paths_are_refused() {
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755).file("/etc/evil", 0o644, b"x");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
    let mut t = RawTar::new();
    t.dir("/tmp/IntelyIDE.app/", 0o755);
    refused(&t.gz(), ErrorCode::UnsafeEntry);
}

#[test]
fn control_characters_and_nul_are_refused() {
    for name in [format!("{TOP}/a\nb"), format!("{TOP}/a\x07b"), format!("{TOP}/a\x7fb")] {
        let mut t = RawTar::new();
        t.entry(name.as_bytes(), FILE, 0o644, 1, b"", b"x");
        refused(&t.gz(), ErrorCode::UnsafeEntry);
    }
    // A NUL cannot sit in a ustar name field, but a pax path can carry one.
    let mut t = RawTar::new();
    t.pax(&[("path", format!("{TOP}/a\0b").as_bytes())], false);
    t.entry(format!("{TOP}/x").as_bytes(), FILE, 0o644, 1, b"", b"x");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
    // Not UTF-8.
    let mut t = RawTar::new();
    t.entry(&[TOP.as_bytes(), b"/\xff\xfe"].concat(), FILE, 0o644, 1, b"", b"x");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
}

#[test]
fn only_the_one_top_level_directory_is_allowed() {
    // Two top-level directories.
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755).file(&format!("{TOP}/f"), 0o644, b"x").dir("Other.app/", 0o755).file("Other.app/f", 0o644, b"x");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
    // Wrong top-level name.
    let mut t = RawTar::new();
    t.dir("Evil.app/", 0o755).file("Evil.app/f", 0o644, b"x");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
    // A file at the top level.
    let mut t = RawTar::new();
    t.file("evil", 0o644, b"x");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
    // The top-level name used by a file or a link.
    let mut t = RawTar::new();
    t.file(TOP, 0o644, b"x");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
    let mut t = RawTar::new();
    t.symlink(TOP, "x");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
    // Case differs.
    let mut t = RawTar::new();
    t.dir("intelyide.app/", 0o755).file("intelyide.app/f", 0o644, b"x");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
}

#[test]
fn symlink_targets_must_be_relative_and_free_of_dotdot() {
    for target in ["/etc", "/", "..", "../..", "a/../b", "a/..", "a\x01b", ""] {
        let mut t = RawTar::new();
        t.dir(&format!("{TOP}/"), 0o755).symlink(&format!("{TOP}/l"), target);
        refused(&t.gz(), ErrorCode::UnsafeEntry);
    }
    // A symlink entry without any target field.
    let mut t = RawTar::new();
    t.entry(format!("{TOP}/l").as_bytes(), SYMLINK, 0o755, 0, b"", b"");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
}

#[test]
fn symlink_chain_a_b_c_to_dotdot_dotdot_is_refused() {
    // a/b/c -> ../..   then   x -> a/b/c/..   then   x/evil
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755)
        .dir(&format!("{TOP}/a/"), 0o755)
        .dir(&format!("{TOP}/a/b/"), 0o755)
        .symlink(&format!("{TOP}/a/b/c"), "../..")
        .symlink(&format!("{TOP}/x"), "a/b/c/..")
        .file(&format!("{TOP}/x/evil"), 0o644, b"evil");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
    // Even if only the last two entries were present, each is refused on its own.
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755).symlink(&format!("{TOP}/x"), "a/b/c/..").file(&format!("{TOP}/x/evil"), 0o644, b"evil");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
}

#[test]
fn entry_below_a_symlink_to_a_directory_is_refused() {
    // l1 -> d, l2 -> l1 (a symlink to an existing directory symlink), then l2/evil and l1/evil.
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755).dir(&format!("{TOP}/d/"), 0o755).symlink(&format!("{TOP}/l1"), "d").symlink(&format!("{TOP}/l2"), "l1").file(&format!("{TOP}/l2/evil"), 0o644, b"x");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755).dir(&format!("{TOP}/d/"), 0o755).symlink(&format!("{TOP}/l1"), "d").dir(&format!("{TOP}/l1/sub/"), 0o755);
    refused(&t.gz(), ErrorCode::UnsafeEntry);
    // Below a regular file.
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755).file(&format!("{TOP}/f"), 0o644, b"x").file(&format!("{TOP}/f/g"), 0o644, b"y");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
}

#[test]
fn hard_links_devices_fifos_and_friends_are_refused() {
    for typ in [HARDLINK, CHAR, BLOCK, FIFO, b'7', b'S'] {
        let mut t = RawTar::new();
        t.dir(&format!("{TOP}/"), 0o755).file(&format!("{TOP}/target"), 0o644, b"x").entry(format!("{TOP}/special").as_bytes(), typ, 0o644, 0, format!("{TOP}/target").as_bytes(), b"");
        refused(&t.gz(), ErrorCode::UnsafeEntry);
    }
    // Unknown type letter.
    let mut t = RawTar::new();
    t.entry(format!("{TOP}/q").as_bytes(), b'Q', 0o644, 0, b"", b"");
    refused(&t.gz(), ErrorCode::BadArchive);
}

#[test]
fn duplicates_are_refused() {
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755).file(&format!("{TOP}/f"), 0o644, b"1").file(&format!("{TOP}/f"), 0o644, b"2");
    refused(&t.gz(), ErrorCode::BadArchive);
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755).dir(&format!("{TOP}/d/"), 0o755).dir(&format!("{TOP}/d/"), 0o755);
    refused(&t.gz(), ErrorCode::BadArchive);
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755).dir(&format!("{TOP}/"), 0o755);
    refused(&t.gz(), ErrorCode::BadArchive);
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755).symlink(&format!("{TOP}/l"), "x").file(&format!("{TOP}/l"), 0o644, b"x");
    refused(&t.gz(), ErrorCode::BadArchive);
}

#[test]
fn pax_record_length_overflow_is_refused_not_a_panic() {
    // Verifier finding: a second record declaring usize::MAX made `i + len` overflow.
    for lens in ["18446744073709551615", "18446744073709551610", "99999999999999999999"] {
        let data = format!("8 a=bcd\n{lens} x=y\n");
        let mut t = RawTar::new();
        t.dir(&format!("{TOP}/"), 0o755);
        t.entry(b"pax", b'x', 0o644, data.len() as u64, b"", data.as_bytes());
        t.file(&format!("{TOP}/f"), 0o644, b"x");
        let gz = t.gz();
        refused(&gz, ErrorCode::BadArchive);
        let r = tree_hash_of_tarball(&gz[..], TOP, &Limits::default());
        assert_eq!(r.unwrap_err().code, ErrorCode::BadArchive);
    }
}

#[test]
fn names_that_collide_on_a_case_insensitive_volume_are_refused() {
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755).dir(&format!("{TOP}/a/"), 0o755).dir(&format!("{TOP}/A/"), 0o755);
    refused(&t.gz(), ErrorCode::UnsafeEntry);
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755).file(&format!("{TOP}/a/x"), 0o644, b"1").file(&format!("{TOP}/A/y"), 0o644, b"2");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755).file(&format!("{TOP}/f"), 0o644, b"1").symlink(&format!("{TOP}/F"), "x");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
    // The same name twice is still the ordinary duplicate error, and unrelated names pass.
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755).file(&format!("{TOP}/a"), 0o644, b"1").file(&format!("{TOP}/b"), 0o644, b"2");
    assert!(tree_hash_of_tarball(&t.gz()[..], TOP, &Limits::default()).is_ok());
}

#[test]
fn decomposed_unicode_names_are_refused() {
    // NFC "e-acute" is fine; the NFD spelling (e + U+0301) would merge with it on APFS.
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755).file(&format!("{TOP}/caf\u{e9}"), 0o644, b"1");
    assert!(tree_hash_of_tarball(&t.gz()[..], TOP, &Limits::default()).is_ok());
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755).file(&format!("{TOP}/cafe\u{301}"), 0o644, b"1");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
}

#[test]
fn malformed_archives_are_refused() {
    // Not gzip.
    refused(b"this is not a gzip stream at all", ErrorCode::BadArchive);
    // Empty gzip, empty tar, only the top directory.
    refused(&gz(&[]), ErrorCode::BadArchive);
    refused(&gz(&[0u8; 1024]), ErrorCode::BadArchive);
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755);
    refused(&t.gz(), ErrorCode::BadArchive);
    // Truncated data section.
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755);
    t.entry(format!("{TOP}/f").as_bytes(), FILE, 0o644, 4096, b"", &[1u8; 100]);
    let mut raw = t.finish();
    raw.truncate(raw.len() - 1024 - 400);
    refused(&gz(&raw), ErrorCode::BadArchive);
    // Truncated gzip.
    let full = simple_app_tar(TOP);
    refused(&full[..full.len() / 2], ErrorCode::BadArchive);
    // Corrupt header checksum.
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755);
    let mut raw = t.finish();
    raw[10] ^= 0xff;
    refused(&gz(&raw), ErrorCode::BadArchive);
    // Global pax header, dangling extension header.
    let mut t = RawTar::new();
    t.pax(&[("comment", b"hi")], true).dir(&format!("{TOP}/"), 0o755).file(&format!("{TOP}/f"), 0o644, b"x");
    refused(&t.gz(), ErrorCode::BadArchive);
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755).file(&format!("{TOP}/f"), 0o644, b"x").long_name(b"IntelyIDE.app/dangling");
    refused(&t.gz(), ErrorCode::BadArchive);
    // A directory that claims data.
    let mut t = RawTar::new();
    t.entry(format!("{TOP}/").as_bytes(), DIR, 0o755, 512, b"", &[0u8; 512]);
    refused(&t.gz(), ErrorCode::BadArchive);
}

#[test]
fn a_lying_extension_header_cannot_allocate() {
    // A GNU long name claiming 1 GiB must be refused before anything is read into memory.
    let mut t = RawTar::new();
    t.raw_block(header_block(b"././@LongLink", b'L', 1 << 30));
    refused(&t.gz(), ErrorCode::BadArchive);
    let mut t = RawTar::new();
    t.raw_block(header_block(b"PaxHeader", b'x', 1 << 30));
    refused(&t.gz(), ErrorCode::BadArchive);
}

fn header_block(name: &[u8], typ: u8, size: u64) -> [u8; 512] {
    let mut h = tar::Header::new_gnu();
    h.as_old_mut().name[..name.len()].copy_from_slice(name);
    h.set_size(size);
    h.set_mode(0);
    h.set_entry_type(tar::EntryType::new(typ));
    h.set_cksum();
    *h.as_bytes()
}

// ------------------------------------------------------------------------------------------
// Limits at their boundary
// ------------------------------------------------------------------------------------------

#[test]
fn entry_count_boundary_with_the_real_limit() {
    let build = |n: usize| {
        let mut t = RawTar::new();
        t.dir(&format!("{TOP}/"), 0o755);
        for i in 0..n {
            t.file(&format!("{TOP}/f{i}"), 0o644, b"");
        }
        t.gz()
    };
    let lim = Limits::default();
    assert_eq!(lim.max_entries, 50_000);
    let ok = tree_hash_of_tarball(&build(50_000)[..], TOP, &lim).unwrap();
    assert_eq!(ok.entries, 50_000);
    let err = tree_hash_of_tarball(&build(50_001)[..], TOP, &lim).unwrap_err();
    assert_eq!(err.code, ErrorCode::BombEntries);
    // A bomb of 60,000 entries.
    assert_eq!(tree_hash_of_tarball(&build(60_000)[..], TOP, &lim).unwrap_err().code, ErrorCode::BombEntries);
}

#[test]
fn entry_count_boundary_on_disk_and_implicit_parents_count() {
    let lim = Limits { max_entries: 5, ..Limits::default() };
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755);
    for i in 0..5 {
        t.file(&format!("{TOP}/f{i}"), 0o644, b"x");
    }
    let env1 = env();
    unpack_with(&env1, &t.gz(), &lim).unwrap();
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755);
    for i in 0..6 {
        t.file(&format!("{TOP}/f{i}"), 0o644, b"x");
    }
    refused_with(&t.gz(), ErrorCode::BombEntries, &lim);
    // One entry with four implicit parents is five nodes: still fine; a sixth makes it too many.
    let mut t = RawTar::new();
    t.file(&format!("{TOP}/a/b/c/d/e"), 0o644, b"x");
    unpack_with(&env(), &t.gz(), &lim).unwrap();
    let mut t = RawTar::new();
    t.file(&format!("{TOP}/a/b/c/d/e/f"), 0o644, b"x");
    refused_with(&t.gz(), ErrorCode::BombEntries, &lim);
}

#[test]
fn path_length_boundary() {
    // The streaming hash applies the real limit of 1024 bytes exactly.
    let lim = Limits::default();
    let ok = path_of_len(TOP, 1024);
    assert_eq!(ok.len(), 1024);
    let mut t = RawTar::new();
    t.file(&ok, 0o644, b"x");
    tree_hash_of_tarball(&t.gz()[..], TOP, &lim).unwrap();
    let mut t = RawTar::new();
    t.file(&path_of_len(TOP, 1025), 0o644, b"x");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
    // On disk the absolute path (stage prefix + entry) must also fit PATH_MAX (1024): a 1024-byte
    // entry fails closed with unsafeEntry there; the boundary of the rule itself is shown with a
    // smaller limit.
    let mut t = RawTar::new();
    t.file(&ok, 0o644, b"x");
    assert_eq!(unpack_with(&env(), &t.gz(), &lim).unwrap_err().code, ErrorCode::UnsafeEntry);
    let small = Limits { max_path_bytes: 600, ..Limits::default() };
    let mut t = RawTar::new();
    t.file(&path_of_len(TOP, 600), 0o644, b"x");
    unpack_with(&env(), &t.gz(), &small).unwrap();
    let mut t = RawTar::new();
    t.file(&path_of_len(TOP, 601), 0o644, b"x");
    refused_with(&t.gz(), ErrorCode::UnsafeEntry, &small);
    // A component over 255 bytes.
    let mut t = RawTar::new();
    t.file(&format!("{TOP}/{}", "n".repeat(256)), 0o644, b"x");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
}

#[test]
fn depth_boundary() {
    // 32 components including the bundle directory are fine, 33 are not.
    let deep = |n: usize| {
        let mut p = String::from(TOP);
        for i in 1..n {
            p.push_str(&format!("/d{i}"));
        }
        p
    };
    let mut t = RawTar::new();
    t.file(&deep(32), 0o644, b"x");
    unpack_with(&env(), &t.gz(), &Limits::default()).unwrap();
    let mut t = RawTar::new();
    t.file(&deep(33), 0o644, b"x");
    refused(&t.gz(), ErrorCode::UnsafeEntry);
}

#[test]
fn unpacked_size_boundary() {
    let lim = Limits { max_unpacked_bytes: 1 << 20, ..Limits::default() };
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755).file(&format!("{TOP}/a"), 0o644, &vec![7u8; 1 << 19]).file(&format!("{TOP}/b"), 0o644, &vec![7u8; 1 << 19]);
    let u = unpack_with(&env(), &t.gz(), &lim).unwrap();
    assert_eq!(u.summary.bytes, 1 << 20);
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755).file(&format!("{TOP}/a"), 0o644, &vec![7u8; 1 << 19]).file(&format!("{TOP}/b"), 0o644, &vec![7u8; (1 << 19) + 1]);
    refused_with(&t.gz(), ErrorCode::BombSize, &lim);
}

#[test]
fn a_claimed_size_of_three_gib_is_refused_before_reading() {
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755);
    t.entry(format!("{TOP}/huge").as_bytes(), FILE, 0o644, 3 << 30, b"", b"tiny");
    refused(&t.gz_unterminated(), ErrorCode::BombSize);
    // The same through a pax size override.
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755);
    t.pax(&[("size", b"3221225472")], false);
    t.entry(format!("{TOP}/huge").as_bytes(), FILE, 0o644, 4, b"", b"tiny");
    refused(&t.gz_unterminated(), ErrorCode::BombSize);
}

#[test]
fn the_decompressed_stream_is_capped() {
    // Valid entries whose pax headers carry 60 KB of ignored records each: the stream grows far past
    // what 100 entries may need, while entries and file bytes stay within their limits.
    let lim = Limits { max_entries: 100, max_unpacked_bytes: 0, ..Limits::default() };
    let mut t = RawTar::new();
    t.dir(&format!("{TOP}/"), 0o755);
    for i in 0..100 {
        t.pax(&[("comment", &vec![b'x'; 60_000])], false);
        t.file(&format!("{TOP}/f{i}"), 0o644, b"");
    }
    refused_with(&t.gz(), ErrorCode::BombSize, &lim);
}

// ------------------------------------------------------------------------------------------
// The stage directory itself
// ------------------------------------------------------------------------------------------

#[test]
fn an_existing_symlink_is_never_followed() {
    let env = env();
    let outside_dir = env.parent.join("outside");
    fs::create_dir(&outside_dir).unwrap();
    // The bundle directory path in the stage is a symlink to an outside directory.
    symlink(&outside_dir, env.stage.join(TOP)).unwrap();
    let before = outside(&env);
    let err = unpack_with(&env, &simple_app_tar(TOP), &Limits::default()).unwrap_err();
    assert_eq!(err.code, ErrorCode::BadArchive);
    assert_eq!(before, outside(&env));
    assert_eq!(fs::read_dir(&outside_dir).unwrap().count(), 0);
    assert!(fs::symlink_metadata(env.stage.join(TOP)).unwrap().file_type().is_symlink(), "the foreign link must be left alone");
    // A symlinked stage directory is refused as well.
    let link = env.parent.join("stage-link");
    symlink(&env.stage, &link).unwrap();
    assert!(unpack(&simple_app_tar(TOP)[..], &link, TOP, &Limits::default()).is_err());
}

#[test]
fn symlinks_are_confined_after_the_unpack() {
    let env = env();
    let u = unpack_with(&env, &simple_app_tar(TOP), &Limits::default()).unwrap();
    verify_symlinks_confined(&u.root).unwrap();
    // A loop, an absolute link and a link that escapes through a planted parent link are refused.
    symlink("l2", u.root.join("l1")).unwrap();
    symlink("l1", u.root.join("l2")).unwrap();
    assert_eq!(verify_symlinks_confined(&u.root).unwrap_err().code, ErrorCode::UnsafeEntry);
    fs::remove_file(u.root.join("l1")).unwrap();
    fs::remove_file(u.root.join("l2")).unwrap();
    symlink("/etc/hosts", u.root.join("abs")).unwrap();
    assert_eq!(verify_symlinks_confined(&u.root).unwrap_err().code, ErrorCode::UnsafeEntry);
    fs::remove_file(u.root.join("abs")).unwrap();
    symlink("../../outside", u.root.join("Contents/up")).unwrap();
    assert_eq!(verify_symlinks_confined(&u.root).unwrap_err().code, ErrorCode::UnsafeEntry);
    fs::remove_file(u.root.join("Contents/up")).unwrap();
    // A dangling link inside the bundle is fine.
    symlink("does/not/exist", u.root.join("dangling")).unwrap();
    verify_symlinks_confined(&u.root).unwrap();
}

#[test]
fn stage_dir_name_mode_marker_and_pattern() {
    let env = env();
    let name = env.stage.file_name().unwrap().to_str().unwrap();
    assert!(is_stage_dir_name(name), "{name}");
    assert_eq!(env.stage.parent().unwrap(), env.parent);
    assert_eq!(mode_of(&env.stage), 0o700);
    assert!(fs::symlink_metadata(env.stage.join(STAGE_MARKER)).unwrap().is_file());
    let other = create_stage_dir(&env.parent).unwrap();
    assert_ne!(other, env.stage);
    for bad in [".IntelyIDE.update-", ".IntelyIDE.update-0123456789abcde", ".IntelyIDE.update-0123456789abcdeff", ".IntelyIDE.update-0123456789ABCDEF", ".IntelyIDE.update-0123456789abcdeg", "IntelyIDE.update-0123456789abcdef", "x.IntelyIDE.update-0123456789abcdef", ""] {
        assert!(!is_stage_dir_name(bad), "{bad}");
    }
    assert!(is_stage_dir_name(".IntelyIDE.update-0123456789abcdef"));
}

#[test]
fn create_stage_dir_reports_unwritable_parents() {
    let tmp = tempfile::tempdir().unwrap();
    let ro = tmp.path().join("ro");
    fs::create_dir(&ro).unwrap();
    fs::set_permissions(&ro, fs::Permissions::from_mode(0o500)).unwrap();
    let err = create_stage_dir(&ro).unwrap_err();
    fs::set_permissions(&ro, fs::Permissions::from_mode(0o700)).unwrap();
    if euid_is_root() {
        return;
    }
    assert_eq!(err.code, ErrorCode::NotWritable);
    assert!(fs::read_dir(&ro).unwrap().next().is_none());
}

fn euid_is_root() -> bool {
    my_uid() == 0
}

fn my_uid() -> u32 {
    fs::metadata(std::env::temp_dir()).unwrap().uid()
}

#[test]
fn only_real_marked_stage_directories_are_removed() {
    let env = env();
    let uid = my_uid();
    // The happy path: the stage with content, including a symlink to the outside, is removed and the
    // link target survives.
    let victim = env.parent.join("victim");
    fs::create_dir(&victim).unwrap();
    fs::write(victim.join("keep"), b"keep").unwrap();
    let u = unpack_with(&env, &simple_app_tar(TOP), &Limits::default()).unwrap();
    symlink(&victim, u.root.join("escape")).unwrap();
    inspect_stage_dir(&env.stage, uid).unwrap();
    remove_stage_dir(&env.stage, uid).unwrap();
    assert!(!env.stage.exists());
    assert_eq!(fs::read(victim.join("keep")).unwrap(), b"keep");

    // Wrong owner, wrong name, missing marker, marker not a file, symlink named like a stage, plain file.
    let stage = create_stage_dir(&env.parent).unwrap();
    assert_eq!(remove_stage_dir(&stage, uid + 1).unwrap_err().code, ErrorCode::Stale);
    assert!(stage.exists());
    let renamed = env.parent.join("not-a-stage");
    fs::create_dir(&renamed).unwrap();
    fs::write(renamed.join(STAGE_MARKER), b"x").unwrap();
    assert!(remove_stage_dir(&renamed, uid).is_err());
    assert!(renamed.exists());
    let no_marker = env.parent.join(".IntelyIDE.update-aaaaaaaaaaaaaaaa");
    fs::create_dir(&no_marker).unwrap();
    assert!(remove_stage_dir(&no_marker, uid).is_err());
    assert!(no_marker.exists());
    let marker_dir = env.parent.join(".IntelyIDE.update-bbbbbbbbbbbbbbbb");
    fs::create_dir_all(marker_dir.join(STAGE_MARKER)).unwrap();
    assert!(remove_stage_dir(&marker_dir, uid).is_err());
    assert!(marker_dir.exists());
    let link = env.parent.join(".IntelyIDE.update-cccccccccccccccc");
    symlink(&victim, &link).unwrap();
    assert!(remove_stage_dir(&link, uid).is_err());
    assert_eq!(fs::read(victim.join("keep")).unwrap(), b"keep");
    let file = env.parent.join(".IntelyIDE.update-dddddddddddddddd");
    fs::write(&file, b"x").unwrap();
    assert!(remove_stage_dir(&file, uid).is_err());
    assert!(remove_stage_dir(&env.parent.join(".IntelyIDE.update-eeeeeeeeeeeeeeee"), uid).is_err());
    // The right owner removes it.
    remove_stage_dir(&stage, uid).unwrap();
    assert!(!stage.exists());
}
