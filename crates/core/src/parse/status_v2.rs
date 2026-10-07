//! `git status --porcelain=v2 -z --branch` (contract section 6.3).

use super::nfc_path;
use crate::{code, Change, ChangeKind, EngineError, GuardState};

/// Branch header lines (`# branch.*`) of the status output.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BranchHeader {
    /// `None` on an unborn branch (`(initial)`).
    pub oid: Option<String>,
    /// `None` when detached.
    pub head: Option<String>,
    /// `<remote>/<branch>`
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// An upstream is configured but its ref no longer exists (git omits `# branch.ab` then).
    pub upstream_gone: bool,
    /// `# stash <n>`, only present with `--show-stash`.
    pub stash: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedStatus {
    pub branch: BranchHeader,
    /// Guard is `ok` and sizes unset; the snapshot builder classifies them. Ignored (`!`) records are dropped.
    pub changes: Vec<Change>,
}

fn bad(msg: impl Into<String>) -> EngineError {
    EngineError::new(code::GIT, format!("status v2: {}", msg.into()))
}

/// Splits off the first `n` space-separated fields; the rest (a path, which may contain spaces) is returned verbatim.
fn take_fields(rec: &[u8], n: usize) -> Result<(Vec<&[u8]>, &[u8]), EngineError> {
    let mut fields = Vec::with_capacity(n);
    let mut start = 0;
    for (i, &b) in rec.iter().enumerate() {
        if b == b' ' {
            fields.push(&rec[start..i]);
            start = i + 1;
            if fields.len() == n {
                return Ok((fields, &rec[start..]));
            }
        }
    }
    Err(bad(format!("expected {n} fields in {:?}", String::from_utf8_lossy(rec))))
}

fn status_char(b: u8) -> String {
    if b == b'.' { " ".to_owned() } else { (b as char).to_string() }
}

fn kind_of(x: u8, y: u8, submodule: bool) -> ChangeKind {
    match (x, y) {
        _ if submodule => ChangeKind::Submodule,
        (b'A', _) | (_, b'A') => ChangeKind::Added,
        (b'R', _) => ChangeKind::Renamed,
        (b'C', _) => ChangeKind::Copied,
        (b'D', _) | (_, b'D') => ChangeKind::Deleted,
        (b'T', _) | (_, b'T') => ChangeKind::TypeChanged,
        _ => ChangeKind::Modified,
    }
}

fn change(path: &[u8], orig: Option<&[u8]>, xy: &[u8], kind: ChangeKind) -> Change {
    let (x, y) = (xy[0], xy[1]);
    let conflicted = kind == ChangeKind::Conflicted;
    Change {
        path: nfc_path(path),
        orig_path: orig.map(nfc_path),
        kind,
        index_status: status_char(x),
        worktree_status: status_char(y),
        staged: x != b'.' && !conflicted,
        partially_staged: x != b'.' && y != b'.' && !conflicted,
        guard: GuardState::Ok,
        binary: None,
        size_bytes: None,
        dir: None,
    }
}

fn header(line: &str, out: &mut BranchHeader) {
    if let Some(v) = line.strip_prefix("# branch.oid ") {
        out.oid = (v != "(initial)").then(|| v.to_owned());
    } else if let Some(v) = line.strip_prefix("# branch.head ") {
        out.head = (v != "(detached)").then(|| v.to_owned());
    } else if let Some(v) = line.strip_prefix("# branch.upstream ") {
        out.upstream = Some(v.to_owned());
    } else if let Some(v) = line.strip_prefix("# branch.ab ") {
        let mut it = v.split(' ');
        if let (Some(a), Some(b)) = (it.next(), it.next()) {
            out.ahead = a.trim_start_matches('+').parse().unwrap_or(0);
            out.behind = b.trim_start_matches('-').parse().unwrap_or(0);
            out.upstream_gone = false;
        }
    } else if let Some(v) = line.strip_prefix("# stash ") {
        out.stash = v.parse().ok();
    }
    // unknown `# x` headers are ignored for forward compatibility
}

pub fn parse_status_v2(raw: &[u8]) -> Result<ParsedStatus, EngineError> {
    let mut out = ParsedStatus::default();
    let mut saw_ab = false;
    let mut recs = raw.split(|&b| b == 0);
    while let Some(rec) = recs.next() {
        // empty pieces: the trailing NUL (or a tolerated missing one) yields a final empty slice
        if rec.is_empty() {
            continue;
        }
        match rec[0] {
            b'#' => {
                let line = String::from_utf8_lossy(rec);
                saw_ab |= line.starts_with("# branch.ab ");
                header(&line, &mut out.branch);
            }
            b'1' => {
                let (f, path) = take_fields(&rec[2.min(rec.len())..], 7)?;
                let sub = f[1];
                let c = change(path, None, f[0], kind_of(f[0][0], f[0][1], sub.first() == Some(&b'S')));
                out.changes.push(c);
            }
            b'2' => {
                let (f, path) = take_fields(&rec[2.min(rec.len())..], 8)?;
                let orig = recs.next().filter(|o| !o.is_empty()).ok_or_else(|| bad("rename record without orig path"))?;
                let copied = f[7].first() == Some(&b'C');
                let kind = if copied { ChangeKind::Copied } else { ChangeKind::Renamed };
                // a submodule cannot be a rename; X is R/C so kind_of is not needed
                out.changes.push(change(path, Some(orig), f[0], kind));
            }
            b'u' => {
                let (f, path) = take_fields(&rec[2.min(rec.len())..], 9)?;
                out.changes.push(change(path, None, f[0], ChangeKind::Conflicted));
            }
            b'?' => {
                let path = &rec[2.min(rec.len())..];
                let mut c = change(path, None, b".?", ChangeKind::Untracked);
                c.worktree_status = "?".to_owned();
                if c.path.ends_with('/') {
                    c.dir = Some(true);
                }
                out.changes.push(c);
            }
            b'!' => {}
            _ => return Err(bad(format!("unknown record type {:?}", String::from_utf8_lossy(&rec[..rec.len().min(20)])))),
        }
    }
    out.branch.upstream_gone = out.branch.upstream.is_some() && !saw_ab;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const H: &str = "1111111111111111111111111111111111111111";
    const I: &str = "2222222222222222222222222222222222222222";

    fn parse(s: &str) -> ParsedStatus {
        parse_status_v2(s.as_bytes()).expect("parse")
    }

    fn summary(p: &ParsedStatus) -> Vec<(ChangeKind, String, String, String)> {
        p.changes.iter().map(|c| (c.kind.clone(), c.index_status.clone() + &c.worktree_status, c.path.clone(), c.orig_path.clone().unwrap_or_default())).collect()
    }

    #[test]
    fn branch_headers_tracking_with_ahead_behind() {
        let p = parse(&format!("# branch.oid {OID}\0# branch.head feature/x\0# branch.upstream origin/release-x\0# branch.ab +3 -1\0"));
        assert_eq!(
            p.branch,
            BranchHeader {
                oid: Some(OID.into()),
                head: Some("feature/x".into()),
                upstream: Some("origin/release-x".into()),
                ahead: 3,
                behind: 1,
                upstream_gone: false,
                stash: None,
            }
        );
        assert!(p.changes.is_empty());
    }

    #[test]
    fn branch_headers_unborn_without_upstream() {
        let p = parse("# branch.oid (initial)\0# branch.head main\0");
        assert_eq!(p.branch, BranchHeader { head: Some("main".into()), ..Default::default() });
    }

    #[test]
    fn branch_headers_detached() {
        let p = parse(&format!("# branch.oid {OID}\0# branch.head (detached)\0"));
        assert_eq!(p.branch.head, None);
        assert_eq!(p.branch.oid.as_deref(), Some(OID));
    }

    #[test]
    fn upstream_gone_when_ab_is_missing() {
        let p = parse(&format!("# branch.oid {OID}\0# branch.head main\0# branch.upstream origin/main\0"));
        assert!(p.branch.upstream_gone);
    }

    #[test]
    fn stash_header_and_unknown_header() {
        let p = parse("# stash 2\0# future.thing a b c\0");
        assert_eq!(p.branch.stash, Some(2));
    }

    #[test]
    fn ordinary_records() {
        let z = "0".repeat(40);
        let s = format!(
            "1 M. N... 100644 100644 100644 {H} {I} a.txt\01 .M N... 100644 100644 100644 {H} {H} dir/b.txt\0\
             1 MM N... 100644 100644 100644 {H} {I} c.txt\01 AD N... 000000 100644 000000 {z} {I} d.txt\0\
             1 .T N... 100644 100644 120000 {H} {H} lnk\01 .M S.M. 160000 160000 160000 {H} {H} sub\0"
        );
        let p = parse(&s);
        assert_eq!(
            p.changes.iter().map(|c| (c.kind.clone(), c.path.as_str(), c.index_status.as_str(), c.worktree_status.as_str(), c.staged, c.partially_staged)).collect::<Vec<_>>(),
            vec![
                (ChangeKind::Modified, "a.txt", "M", " ", true, false),
                (ChangeKind::Modified, "dir/b.txt", " ", "M", false, false),
                (ChangeKind::Modified, "c.txt", "M", "M", true, true),
                (ChangeKind::Added, "d.txt", "A", "D", true, true),
                (ChangeKind::TypeChanged, "lnk", " ", "T", false, false),
                (ChangeKind::Submodule, "sub", " ", "M", false, false),
            ]
        );
    }

    #[test]
    fn deleted_and_staged_delete() {
        let p = parse(&format!("1 .D N... 100644 100644 000000 {H} {H} gone.txt\01 D. N... 100644 000000 000000 {H} {H} gone2.txt\0"));
        assert!(p.changes.iter().all(|c| c.kind == ChangeKind::Deleted));
        assert!(!p.changes[0].staged && p.changes[1].staged);
    }

    #[test]
    fn rename_orig_path_is_the_next_nul_field() {
        let p = parse(&format!(
            "2 R. N... 100644 100644 100644 {H} {H} R100 new name.txt\0old name.txt\01 .M N... 100644 100644 100644 {H} {H} after.txt\0"
        ));
        assert_eq!(
            summary(&p),
            vec![
                (ChangeKind::Renamed, "R ".into(), "new name.txt".into(), "old name.txt".into()),
                (ChangeKind::Modified, " M".into(), "after.txt".into(), "".into()),
            ],
            "the record after a rename must not be swallowed"
        );
    }

    #[test]
    fn rename_with_worktree_modification_and_copy() {
        let p = parse(&format!("2 RM N... 100644 100644 100644 {H} {I} R098 b.txt\0a.txt\02 C. N... 100644 100644 100644 {H} {H} C075 copy.txt\0src.txt\0"));
        assert_eq!((p.changes[0].kind.clone(), p.changes[0].partially_staged), (ChangeKind::Renamed, true));
        assert_eq!(p.changes[0].orig_path.as_deref(), Some("a.txt"));
        assert_eq!((p.changes[1].kind.clone(), p.changes[1].orig_path.as_deref()), (ChangeKind::Copied, Some("src.txt")));
    }

    #[test]
    fn unmerged_records() {
        let z = "0".repeat(40);
        let s = format!(
            "u UU N... 100644 100644 100644 100644 {H} {I} {OID} conflict.txt\0u AU N... 000000 100644 100644 100644 {z} {I} {OID} added by us.txt\0\
             u UD N... 100644 100644 000000 100644 {H} {I} {z} del.txt\0"
        );
        let p = parse(&s);
        assert_eq!(
            p.changes.iter().map(|c| (c.kind.clone(), c.index_status.clone() + &c.worktree_status, c.path.as_str(), c.staged)).collect::<Vec<_>>(),
            vec![
                (ChangeKind::Conflicted, "UU".into(), "conflict.txt", false),
                (ChangeKind::Conflicted, "AU".into(), "added by us.txt", false),
                (ChangeKind::Conflicted, "UD".into(), "del.txt", false),
            ]
        );
    }

    #[test]
    fn untracked_collapsed_dir_and_ignored() {
        let p = parse("? new file.txt\0? dir/\0! build/out.js\0");
        assert_eq!(p.changes.len(), 2, "ignored records are dropped");
        assert_eq!((p.changes[0].kind.clone(), p.changes[0].dir, p.changes[0].worktree_status.as_str(), p.changes[0].index_status.as_str()), (ChangeKind::Untracked, None, "?", " "));
        assert_eq!((p.changes[1].path.as_str(), p.changes[1].dir), ("dir/", Some(true)));
    }

    #[test]
    fn odd_names_are_byte_exact() {
        let names = ["line\nbreak.txt", "tab\there.txt", "quo\"te\\back.txt", "-leading-dash.txt", "[id].tsx", "(tabs)/index.tsx", ":magic.txt", "  two  spaces .txt"];
        let s: String = names.iter().map(|n| format!("? {n}\0")).collect();
        let p = parse(&s);
        assert_eq!(p.changes.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), names);
    }

    #[test]
    fn odd_names_inside_ordinary_and_rename_records() {
        let p = parse(&format!("1 .M N... 100644 100644 100644 {H} {H} my file with  spaces.txt\02 R. N... 100644 100644 100644 {H} {H} R100 -dash new.txt\0old\nname.txt\0"));
        assert_eq!(p.changes[0].path, "my file with  spaces.txt");
        assert_eq!((p.changes[1].path.as_str(), p.changes[1].orig_path.as_deref()), ("-dash new.txt", Some("old\nname.txt")));
    }

    #[test]
    fn nfd_and_nfc_spellings_normalise_to_the_same_path() {
        let nfc = "árvíztűrő.txt";
        let nfd = "a\u{301}rvi\u{301}ztu\u{030b}ro\u{030b}.txt";
        assert_ne!(nfc, nfd);
        let a = parse(&format!("? {nfc}\0")).changes.remove(0).path;
        let b = parse(&format!("? {nfd}\0")).changes.remove(0).path;
        assert_eq!(a, b);
        assert_eq!(a, nfc);
    }

    #[test]
    fn non_utf8_path_bytes_are_lossy_not_fatal() {
        let mut raw = b"? bad-".to_vec();
        raw.extend([0xff, 0xfe]);
        raw.extend(b".txt\0");
        let p = parse_status_v2(&raw).unwrap();
        assert_eq!(p.changes[0].path, "bad-\u{fffd}\u{fffd}.txt");
    }

    #[test]
    fn missing_trailing_nul_is_tolerated_malformed_input_errors() {
        assert_eq!(parse("? x.txt").changes[0].path, "x.txt");
        let e = parse_status_v2(format!("2 R. N... 100644 100644 100644 {H} {H} R100 new.txt\0").as_bytes()).unwrap_err();
        assert!(e.message.contains("without orig"), "{e}");
        assert!(parse_status_v2(b"Z what\0").unwrap_err().message.contains("unknown record"));
        assert!(parse_status_v2(b"1 M. N...\0").is_err());
        assert!(parse_status_v2(b"").unwrap().changes.is_empty());
    }

    #[test]
    fn full_realistic_status() {
        let mut s: String = [format!("# branch.oid {OID}"), "# branch.head main".into(), "# branch.upstream origin/main".into(), "# branch.ab +0 -2".into()]
            .iter()
            .map(|x| format!("{x}\0"))
            .collect();
        s += &format!(
            "1 M. N... 100644 100644 100644 {H} {I} src/lib.rs\02 R. N... 100644 100644 100644 {H} {H} R100 src/b.rs\0src/a.rs\0\
             u UU N... 100644 100644 100644 100644 {H} {I} {OID} src/conflict.rs\0? notes.txt\0! target/\0"
        );
        let p = parse(&s);
        assert_eq!(p.branch.behind, 2);
        assert_eq!(p.changes.iter().map(|c| c.kind.clone()).collect::<Vec<_>>(), vec![ChangeKind::Modified, ChangeKind::Renamed, ChangeKind::Conflicted, ChangeKind::Untracked]);
    }
}
