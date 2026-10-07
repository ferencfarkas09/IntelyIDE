//! Temp-index staging used by the commit sequence: whole files (deletions first) and filtered partial patches.
//!
//! Partial selection port of `spikes/commit-temp-index/filter-patch.mjs`. Hunk indexes are 0-based positions in
//! `git diff HEAD -U3`; `HunkSelection::lines` index the hunk body lines (` `, `+`, `-` in order, the
//! `\ No newline at end of file` markers are not counted), which is the layout of `Hunk::lines`.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;

use unicode_normalization::UnicodeNormalization;

use crate::exec::{clean_rel_path, run_git, GitCtx, RunOpts};
use crate::git::common::{git_ok, index_env, literal_env, lossy, read_only};
use crate::{code, EngineError, FileSelection, HunkSelection, RepoConfig};

/// Why a partial selection cannot be turned into a patch.
#[derive(Debug, Clone, PartialEq)]
pub enum PatchError {
    Binary,
    Unsupported,
    NoSuchHunk(u32),
    NothingSelected,
}

impl From<PatchError> for EngineError {
    fn from(e: PatchError) -> Self {
        let msg = match e {
            PatchError::Binary => "partial selection is not possible in a binary file".to_owned(),
            PatchError::Unsupported => {
                "partial selection is only possible in modified text files (not new, deleted, renamed or mode-changed)"
                    .to_owned()
            }
            PatchError::NoSuchHunk(i) => format!("the file has no hunk {i}; it changed since the diff was shown"),
            PatchError::NothingSelected => "the selection contains no changed line".to_owned(),
        };
        EngineError::new(code::INVALID_SELECTION, msg)
    }
}

type Lines<'a> = Vec<&'a [u8]>;

struct Hunk<'a> {
    old_start: i64,
    /// Text after the closing `@@` (the function context).
    tail: &'a [u8],
    body: Lines<'a>,
}

fn parse_hunk_header(line: &[u8]) -> Option<(i64, &[u8])> {
    let rest = line.strip_prefix(b"@@ -")?;
    let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
    let old_start = std::str::from_utf8(&rest[..digits]).ok()?.parse().ok()?;
    let at = rest.windows(3).position(|w| w == b" @@")?;
    Some((old_start, &rest[at + 3..]))
}

fn starts_with_any(line: &[u8], prefixes: &[&[u8]]) -> bool {
    prefixes.iter().any(|p| line.starts_with(p))
}

/// Keeps the selected changes of a one-file unified diff: an unselected `-` line becomes context, an unselected `+`
/// line is dropped, hunk headers are rewritten (counts and new start) and hunks without a change disappear.
pub fn filter_patch(patch: &[u8], selection: &[HunkSelection]) -> Result<Vec<u8>, PatchError> {
    let mut lines: Lines = patch.split(|&b| b == b'\n').collect();
    if lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    if lines.iter().any(|l| *l == b"GIT binary patch" || l.starts_with(b"Binary files ")) {
        return Err(PatchError::Binary);
    }
    let first_hunk = lines.iter().position(|l| l.starts_with(b"@@ ")).unwrap_or(lines.len());
    let (header, rest) = lines.split_at(first_hunk);
    const UNSUPPORTED: [&[u8]; 7] = [
        b"new file mode",
        b"deleted file mode",
        b"rename from",
        b"rename to",
        b"old mode",
        b"new mode",
        b"similarity index",
    ];
    if header.iter().any(|l| starts_with_any(l, &UNSUPPORTED)) {
        return Err(PatchError::Unsupported);
    }

    let mut hunks: Vec<Hunk> = Vec::new();
    for &l in rest {
        if l.starts_with(b"@@ ") {
            let (old_start, tail) = parse_hunk_header(l).ok_or(PatchError::Unsupported)?;
            hunks.push(Hunk { old_start, tail, body: Vec::new() });
        } else if let Some(h) = hunks.last_mut() {
            h.body.push(l);
        }
    }

    let mut chosen: HashMap<u32, Option<HashSet<u32>>> = HashMap::new();
    for s in selection {
        if s.index as usize >= hunks.len() {
            return Err(PatchError::NoSuchHunk(s.index));
        }
        chosen.insert(s.index, s.lines.as_ref().map(|l| l.iter().copied().collect()));
    }

    let mut out: Vec<Vec<u8>> = header.iter().map(|l| l.to_vec()).collect();
    let mut delta: i64 = 0;
    let mut emitted = false;
    for (n, h) in hunks.iter().enumerate() {
        let Some(sel) = chosen.get(&(n as u32)) else { continue };
        let body = select_lines(&h.body, sel.as_ref());
        if !body.iter().any(|l| matches!(l.first(), Some(b'+' | b'-'))) {
            continue;
        }
        let (mut old_count, mut new_count) = (0i64, 0i64);
        for l in &body {
            match l.first() {
                Some(b'-') => old_count += 1,
                Some(b'+') => new_count += 1,
                Some(b' ') => {
                    old_count += 1;
                    new_count += 1;
                }
                _ => {}
            }
        }
        let new_start = match (old_count, new_count) {
            (0, _) => h.old_start + delta + 1,
            (_, 0) => h.old_start + delta - 1,
            _ => h.old_start + delta,
        };
        let mut head = format!("@@ -{},{} +{},{} @@", h.old_start, old_count, new_start, new_count).into_bytes();
        head.extend_from_slice(h.tail);
        out.push(head);
        out.extend(body);
        delta += new_count - old_count;
        emitted = true;
    }
    if !emitted {
        return Err(PatchError::NothingSelected);
    }
    let mut text = out.join(&b'\n');
    text.push(b'\n');
    Ok(text)
}

/// The body of one hunk with only `picked` change lines applied (`None` keeps the hunk as it is).
fn select_lines(body: &[&[u8]], picked: Option<&HashSet<u32>>) -> Vec<Vec<u8>> {
    let Some(picked) = picked else {
        return body.iter().map(|l| l.to_vec()).collect();
    };
    let mut out = Vec::new();
    let mut index = 0u32;
    let mut after_dropped = false;
    for &l in body {
        if l.first() == Some(&b'\\') {
            // `\ No newline at end of file` belongs to the line before it
            if !after_dropped {
                out.push(l.to_vec());
            }
            continue;
        }
        after_dropped = false;
        let keep = picked.contains(&index);
        index += 1;
        match l.first() {
            Some(b'-') if !keep => out.push([b" ", &l[1..]].concat()),
            Some(b'+') if !keep => after_dropped = true,
            // an empty line is a context line whose leading space was stripped
            None => out.push(b" ".to_vec()),
            Some(_) => out.push(l.to_vec()),
        }
    }
    out
}

/// NFC-normalises and validates every path (git does not precompose `--stdin` input); rejects collapsed
/// untracked directories, absolute paths and `..` components.
pub fn normalise(files: &[FileSelection]) -> Result<Vec<FileSelection>, EngineError> {
    let path = |p: &str| -> Result<String, EngineError> {
        let n = clean_rel_path(&p.nfc().collect::<String>())?;
        if n.ends_with('/') {
            return Err(EngineError::new(code::INVALID_SELECTION, format!("a directory cannot be committed: {p:?}")));
        }
        Ok(n)
    };
    files
        .iter()
        .map(|f| {
            Ok(match f {
                FileSelection::Whole { path: p, orig_path } => FileSelection::Whole {
                    path: path(p)?,
                    orig_path: orig_path.as_deref().map(path).transpose()?,
                },
                FileSelection::Partial { path: p, hunks } => {
                    FileSelection::Partial { path: path(p)?, hunks: hunks.clone() }
                }
            })
        })
        .collect()
}

/// Every path a selection touches: both rename halves and the partial files.
pub fn touched_paths(files: &[FileSelection]) -> Vec<String> {
    let mut set = BTreeSet::new();
    for f in files {
        match f {
            FileSelection::Whole { path, orig_path } => {
                set.insert(path.clone());
                set.extend(orig_path.clone());
            }
            FileSelection::Partial { path, .. } => {
                set.insert(path.clone());
            }
        }
    }
    set.into_iter().collect()
}

fn nul_list(paths: &[String]) -> Vec<u8> {
    let mut v = Vec::new();
    for p in paths {
        v.extend_from_slice(p.as_bytes());
        v.push(0);
    }
    v
}

/// On a case-insensitive filesystem git cannot tell `Foo.txt` from `foo.txt`; a selection naming both (a
/// case-only rename) would write both into the tree.
async fn refuse_case_collisions(ctx: &GitCtx, repo: &Path, paths: &[String]) -> Result<(), EngineError> {
    let out = run_git(ctx, repo, &["config", "--type=bool", "core.ignorecase"], &read_only()).await?;
    if lossy(&out.stdout).trim() != "true" {
        return Ok(());
    }
    let mut seen: HashMap<String, &str> = HashMap::new();
    for p in paths {
        if let Some(other) = seen.insert(p.to_lowercase(), p) {
            return Err(EngineError::new(
                code::INVALID_SELECTION,
                format!("{other} and {p} differ only in letter case; case-only renames are not supported on a case-insensitive filesystem, rename the file in two steps"),
            ));
        }
    }
    Ok(())
}

/// Applies `files` to the index at `index_file` (absolute path inside the git dir): deletions first, then adds, then
/// the filtered patches of partial files.
pub async fn apply_selection(
    ctx: &GitCtx,
    repo: &RepoConfig,
    index_file: &Path,
    files: &[FileSelection],
) -> Result<(), EngineError> {
    let root = Path::new(&repo.path);
    let files = normalise(files)?;
    refuse_case_collisions(ctx, root, &touched_paths(&files)).await?;

    // Not a file, symlink or submodule in the worktree means deleted, the old half of a rename, or the
    // file half of a file/directory swap.
    let present = |p: &str| {
        let full = root.join(p);
        std::fs::symlink_metadata(&full).is_ok_and(|m| !m.is_dir() || full.join(".git").exists())
    };
    let (mut deletions, mut adds) = (Vec::new(), Vec::new());
    for f in &files {
        if let FileSelection::Whole { path, orig_path } = f {
            for p in std::iter::once(path).chain(orig_path) {
                let list = if present(p) { &mut adds } else { &mut deletions };
                if !list.contains(p) {
                    list.push(p.clone());
                }
            }
        }
    }
    let env = index_env(index_file);
    for (args, list) in [
        (["update-index", "--force-remove", "-z", "--stdin"], &deletions),
        (["update-index", "--add", "-z", "--stdin"], &adds),
    ] {
        if !list.is_empty() {
            let opts = RunOpts { stdin: Some(nul_list(list)), extra_env: env.clone(), ..Default::default() };
            git_ok(ctx, root, &args, &opts).await?;
        }
    }

    for f in &files {
        let FileSelection::Partial { path, hunks } = f else { continue };
        let diff_opts = RunOpts { read_only: true, extra_env: literal_env(), ..Default::default() };
        let diff_args = [
            "diff", "HEAD", "-U3", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/",
            "--", path,
        ];
        let diff = git_ok(ctx, root, &diff_args, &diff_opts).await?;
        if diff.stdout.is_empty() {
            return Err(EngineError::new(code::INVALID_SELECTION, format!("{path} has no changes against HEAD")));
        }
        let patch = filter_patch(&diff.stdout, hunks)?;
        let opts = RunOpts { stdin: Some(patch), extra_env: env.clone(), ..Default::default() };
        let out = run_git(ctx, root, &["apply", "--cached", "--recount", "--whitespace=nowarn"], &opts).await?;
        if out.code != Some(0) {
            let msg = format!("git rejected the partial selection of {path}");
            return Err(EngineError::new(code::INVALID_SELECTION, msg).with_detail(lossy(&out.stderr)));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    /// A tiny deterministic generator, so the property tests need no dependency.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    #[derive(Clone, Debug)]
    enum Op {
        Keep(String),
        Del(String),
        Add(String),
    }

    /// Unified diff (`-U3`) of an edit script, split into hunks the way git does it.
    fn render_diff(ops: &[Op]) -> String {
        let changed: Vec<usize> = ops.iter().enumerate().filter(|(_, o)| !matches!(o, Op::Keep(_))).map(|(i, _)| i).collect();
        let mut ranges: Vec<(usize, usize)> = Vec::new();
        for &i in &changed {
            let (lo, hi) = (i.saturating_sub(3), (i + 3).min(ops.len() - 1));
            match ranges.last_mut() {
                Some(r) if lo <= r.1 + 1 => r.1 = r.1.max(hi),
                _ => ranges.push((lo, hi)),
            }
        }
        let mut out = String::from("diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n");
        for (lo, hi) in ranges {
            let old_start = ops[..lo].iter().filter(|o| !matches!(o, Op::Add(_))).count() + 1;
            let new_start = ops[..lo].iter().filter(|o| !matches!(o, Op::Del(_))).count() + 1;
            let slice = &ops[lo..=hi];
            let oc = slice.iter().filter(|o| !matches!(o, Op::Add(_))).count();
            let nc = slice.iter().filter(|o| !matches!(o, Op::Del(_))).count();
            out += &format!("@@ -{old_start},{oc} +{new_start},{nc} @@ fn ctx\n");
            for o in slice {
                match o {
                    Op::Keep(l) => out += &format!(" {l}\n"),
                    Op::Del(l) => out += &format!("-{l}\n"),
                    Op::Add(l) => out += &format!("+{l}\n"),
                }
            }
        }
        out
    }

    /// Minimal applier that checks the rewritten headers are exact (start, old count, new count).
    fn apply(old: &[String], patch: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut pos = 0usize;
        let mut lines = patch.lines().skip_while(|l| !l.starts_with("@@")).peekable();
        while let Some(h) = lines.next() {
            let nums: Vec<i64> = h[3..h.find(" @@").unwrap()]
                .split([' ', ',', '-', '+'])
                .filter(|s| !s.is_empty())
                .map(|s| s.parse().unwrap())
                .collect();
            let (os, oc, ns, nc) = (nums[0] as usize, nums[1] as usize, nums[2] as usize, nums[3] as usize);
            let start = if oc == 0 { os } else { os - 1 };
            out.extend_from_slice(&old[pos..start]);
            pos = start;
            assert_eq!(out.len() + 1, if nc == 0 { ns + 1 } else { ns }, "new start of {h}");
            let (mut o, mut n) = (0, 0);
            while lines.peek().is_some_and(|l| !l.starts_with("@@")) {
                let l = lines.next().unwrap();
                let text = l[1..].to_owned();
                match &l[..1] {
                    " " => {
                        assert_eq!(old[pos], text);
                        out.push(text);
                        pos += 1;
                        o += 1;
                        n += 1;
                    }
                    "-" => {
                        assert_eq!(old[pos], text);
                        pos += 1;
                        o += 1;
                    }
                    _ => {
                        out.push(text);
                        n += 1;
                    }
                }
            }
            assert_eq!((o, n), (oc, nc), "counts of {h}");
        }
        out.extend_from_slice(&old[pos..]);
        out
    }

    fn random_script(rng: &mut Rng) -> Vec<Op> {
        let mut ops = Vec::new();
        let mut serial = 0;
        for _ in 0..(10 + rng.below(30)) {
            serial += 1;
            let line = format!("line {serial}");
            match rng.below(6) {
                0 => ops.push(Op::Del(line)),
                1 => ops.push(Op::Add(format!("new {serial}"))),
                2 => {
                    ops.push(Op::Del(line));
                    ops.push(Op::Add(format!("repl {serial}")));
                }
                _ => ops.push(Op::Keep(line)),
            }
        }
        ops
    }

    #[test]
    fn selecting_every_hunk_reproduces_the_diff_and_selecting_lines_matches_the_expected_text() {
        let mut rng = Rng(0x9e3779b97f4a7c15);
        for case in 0..300 {
            let ops = random_script(&mut rng);
            if ops.iter().all(|o| matches!(o, Op::Keep(_))) {
                continue;
            }
            let diff = render_diff(&ops);
            let old: Vec<String> = ops.iter().filter_map(|o| if let Op::Keep(l) | Op::Del(l) = o { Some(l.clone()) } else { None }).collect();
            let new: Vec<String> = ops.iter().filter_map(|o| if let Op::Keep(l) | Op::Add(l) = o { Some(l.clone()) } else { None }).collect();

            let hunk_count = diff.lines().filter(|l| l.starts_with("@@")).count() as u32;
            let all: Vec<HunkSelection> = (0..hunk_count).map(|index| HunkSelection { index, lines: None }).collect();
            let full = filter_patch(diff.as_bytes(), &all).unwrap();
            assert_eq!(apply(&old, &String::from_utf8(full).unwrap()), new, "case {case}: all hunks");

            // pick random change lines per hunk; ops outside the picked lines stay as in `old`
            let mut picked_ops: Vec<Op> = Vec::new();
            let mut sel = Vec::new();
            let mut hunk = None::<(u32, u32)>; // (hunk index, line index inside it)
            let mut in_hunk_until = 0usize;
            let ranges: Vec<(usize, usize)> = {
                let mut r: Vec<(usize, usize)> = Vec::new();
                for (i, _) in ops.iter().enumerate().filter(|(_, o)| !matches!(o, Op::Keep(_))) {
                    let (lo, hi) = (i.saturating_sub(3), (i + 3).min(ops.len() - 1));
                    match r.last_mut() {
                        Some(x) if lo <= x.1 + 1 => x.1 = x.1.max(hi),
                        _ => r.push((lo, hi)),
                    }
                }
                r
            };
            let mut line_picks: Vec<Vec<u32>> = vec![Vec::new(); ranges.len()];
            for (i, o) in ops.iter().enumerate() {
                if let Some(h) = ranges.iter().position(|r| r.0 == i) {
                    hunk = Some((h as u32, 0));
                    in_hunk_until = ranges[h].1;
                }
                let take = !matches!(o, Op::Keep(_)) && rng.below(2) == 0;
                if let Some((h, idx)) = hunk.as_mut() {
                    if take {
                        line_picks[*h as usize].push(*idx);
                    }
                    *idx += 1;
                    if i == in_hunk_until {
                        hunk = None;
                    }
                }
                match o {
                    Op::Keep(l) => picked_ops.push(Op::Keep(l.clone())),
                    Op::Del(l) if take => picked_ops.push(Op::Del(l.clone())),
                    Op::Del(l) => picked_ops.push(Op::Keep(l.clone())),
                    Op::Add(l) if take => picked_ops.push(Op::Add(l.clone())),
                    Op::Add(_) => {}
                }
            }
            for (h, lines) in line_picks.iter().enumerate() {
                sel.push(HunkSelection { index: h as u32, lines: Some(lines.clone()) });
            }
            let expected: Vec<String> = picked_ops.iter().filter_map(|o| if let Op::Keep(l) | Op::Add(l) = o { Some(l.clone()) } else { None }).collect();
            match filter_patch(diff.as_bytes(), &sel) {
                Ok(p) => assert_eq!(apply(&old, &String::from_utf8(p).unwrap()), expected, "case {case}: line selection {sel:?}"),
                Err(PatchError::NothingSelected) => assert_eq!(expected, old, "case {case}"),
                Err(e) => panic!("case {case}: {e:?}"),
            }
        }
    }

    const PATCH: &str = "diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@ top\n a\n-b\n+B\n c\n@@ -20,2 +20,3 @@\n x\n+y\n z\n";

    #[test]
    fn unselected_hunks_vanish_and_headers_follow_the_applied_delta() {
        let p = filter_patch(PATCH.as_bytes(), &[HunkSelection { index: 1, lines: None }]).unwrap();
        assert_eq!(
            String::from_utf8(p).unwrap(),
            "diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -20,2 +20,3 @@\n x\n+y\n z\n"
        );
    }

    #[test]
    fn half_a_replacement_keeps_both_lines() {
        // select only the `+B` line (index 2 of the hunk: a, -b, +B, c): `-b` stays as context
        let p = filter_patch(PATCH.as_bytes(), &[HunkSelection { index: 0, lines: Some(vec![2]) }]).unwrap();
        let text = String::from_utf8(p).unwrap();
        assert!(text.contains("@@ -1,3 +1,4 @@ top\n a\n b\n+B\n c\n"), "{text}");
    }

    #[test]
    fn no_newline_marker_follows_its_line_and_is_dropped_with_an_unselected_addition() {
        let patch = "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n";
        // select nothing of the hunk's changes except the whole hunk: kept verbatim
        let whole = filter_patch(patch.as_bytes(), &[HunkSelection { index: 0, lines: None }]).unwrap();
        assert_eq!(String::from_utf8(whole).unwrap(), patch);
        // select only the deletion: the unselected `+b` is dropped
        let del = filter_patch(patch.as_bytes(), &[HunkSelection { index: 0, lines: Some(vec![1]) }]).unwrap();
        assert_eq!(String::from_utf8(del).unwrap(), "--- a/f\n+++ b/f\n@@ -1,2 +1,1 @@\n a\n-b\n\\ No newline at end of file\n");
        // select only the addition: `-b` becomes context (its marker stays attached), `+b` has no marker of its own
        let add = filter_patch(patch.as_bytes(), &[HunkSelection { index: 0, lines: Some(vec![2]) }]).unwrap();
        assert_eq!(String::from_utf8(add).unwrap(), "--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n b\n\\ No newline at end of file\n+b\n");
        // a marker after a dropped `+` line goes away with it
        let patch2 = "--- a/f\n+++ b/f\n@@ -1,1 +1,2 @@\n a\n+b\n\\ No newline at end of file\n";
        assert_eq!(filter_patch(patch2.as_bytes(), &[HunkSelection { index: 0, lines: Some(vec![]) }]), Err(PatchError::NothingSelected));
    }

    #[test]
    fn refuses_binary_new_deleted_renamed_and_bad_indexes() {
        let sel = [HunkSelection { index: 0, lines: None }];
        assert_eq!(filter_patch(b"diff --git a/x b/x\nBinary files a/x and b/x differ\n", &sel), Err(PatchError::Binary));
        assert_eq!(filter_patch(b"diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+x\n", &sel), Err(PatchError::Unsupported));
        assert_eq!(filter_patch(b"diff --git a/x b/y\nsimilarity index 90%\nrename from x\nrename to y\n", &sel), Err(PatchError::Unsupported));
        assert_eq!(filter_patch(PATCH.as_bytes(), &[HunkSelection { index: 5, lines: None }]), Err(PatchError::NoSuchHunk(5)));
        assert_eq!(filter_patch(PATCH.as_bytes(), &[]), Err(PatchError::NothingSelected));
    }

    #[test]
    fn crlf_and_non_utf8_bytes_round_trip() {
        let patch = b"--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\r\n-b\xff\r\n+c\xfe\r\n";
        let out = filter_patch(patch, &[HunkSelection { index: 0, lines: None }]).unwrap();
        assert_eq!(out, patch.to_vec());
    }

    #[test]
    fn normalise_composes_and_rejects_unsafe_paths() {
        let nfd = "a\u{0301}rv.txt".to_owned();
        let files = [FileSelection::Whole { path: nfd, orig_path: None }];
        let FileSelection::Whole { path, .. } = &normalise(&files).unwrap()[0] else { panic!() };
        assert_eq!(path, "\u{e1}rv.txt");
        for bad in ["dir/", "/abs", "../x", "a/../b", ""] {
            assert!(normalise(&[FileSelection::Whole { path: bad.into(), orig_path: None }]).is_err(), "{bad}");
        }
    }
}
