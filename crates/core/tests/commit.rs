//! Commit sequence against real git: RESULTS.md cases C1-C17 re-expressed on `git::commit::run_commit`.

mod common;

use std::time::{Duration, Instant};

use common::*;
use intely_core::git::{commit, stage};
use intely_core::parse::status_v2::parse_status_v2;
use intely_core::{FailureKind, HunkSelection, OpKind, StepStatus};

fn changed_in_head(fx: &Fixture) -> Vec<String> {
    let out = fx.git(&["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]);
    out.lines().map(str::to_owned).collect()
}

#[tokio::test]
async fn c1_whole_files_leave_every_other_staged_entry_alone() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c1");
    for f in ["a.txt", "b.txt", "c.txt", "d.txt"] {
        fx.write(f, &format!("{f} v1\n"));
    }
    fx.commit_all("base");
    for f in ["a.txt", "b.txt", "c.txt", "d.txt"] {
        fx.write(f, &format!("{f} v2\n"));
    }
    fx.stage(&["c.txt", "d.txt"]);
    let c_before = fx.index_line("c.txt");
    let b_bytes = fx.read("b.txt");

    let o = h.commit(&fx, vec![whole("a.txt"), whole("d.txt")], "commit a and d").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert!(o.reconciled && o.failure.is_none() && o.hook_modified_files.is_empty());
    assert_eq!(o.commit_oid.as_deref(), Some(fx.head().as_str()));
    assert_eq!(changed_in_head(&fx), ["a.txt", "d.txt"]);
    assert_eq!(fx.index_line("c.txt"), c_before, "unchecked staged entry changed");
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]).lines().collect::<Vec<_>>(), ["c.txt"]);
    assert_eq!(fx.read("b.txt"), b_bytes);
    assert!(fx.temp_indexes().is_empty());
    fx.assert_clean_commit("HEAD");

    // C17: the engine's own status parser sees exactly the leftovers
    let raw = fx.git_bytes(&["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=normal"]);
    let parsed = parse_status_v2(&raw).unwrap();
    let mut left: Vec<(&str, bool)> = parsed.changes.iter().map(|c| (c.path.as_str(), c.staged)).collect();
    left.sort();
    assert_eq!(left, [("b.txt", false), ("c.txt", true)]);
}

#[tokio::test]
async fn c2_checked_untracked_file_is_committed_and_the_rest_stays_untracked() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c2");
    fx.write("tracked.txt", "t\n");
    fx.commit_all("base");
    fx.write("new.txt", "new\n");
    fx.write("other.txt", "other\n");
    fx.write("dir/inner.txt", "inner\n");

    let o = h.commit(&fx, vec![whole("new.txt")], "add new").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(changed_in_head(&fx), ["new.txt"]);
    let status = fx.status();
    assert_eq!(status.lines().collect::<Vec<_>>(), ["?? dir/", "?? other.txt"]);
}

#[tokio::test]
async fn c3_renames_and_deletions_commit_both_halves() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c3");
    let body = numbered(20);
    fx.write("old.txt", &body);
    fx.write("x.txt", &numbered(15).replace("line", "other"));
    fx.write("gone.txt", &numbered(12).replace("line", "doomed"));
    fx.commit_all("base");
    fx.git(&["mv", "old.txt", "new.txt"]); // staged rename
    fx.write("new.txt", &edit_lines(&body, &[(3, "tweaked")]));
    std::fs::rename(fx.path.join("x.txt"), fx.path.join("y.txt")).unwrap(); // unstaged rename
    fx.remove("gone.txt");

    let files = vec![renamed("new.txt", "old.txt"), renamed("y.txt", "x.txt"), whole("gone.txt")];
    let o = h.commit(&fx, files, "renames").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    let shown = fx.git(&["show", "--name-status", "-M", "--format=", "HEAD"]);
    let mut lines: Vec<String> = shown
        .lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .map(|l| if l.starts_with('R') && !l.starts_with("R100") { l.replacen(|c: char| c.is_ascii_digit(), "", 3) } else { l })
        .collect();
    lines.sort();
    assert_eq!(lines, ["D gone.txt", "R old.txt new.txt", "R100 x.txt y.txt"]);
    assert_eq!(fx.status(), "");
}

#[tokio::test]
async fn c3_deletion_half_alone_leaves_the_new_path_untracked() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c3b");
    fx.write("x.txt", &numbered(10));
    fx.commit_all("base");
    std::fs::rename(fx.path.join("x.txt"), fx.path.join("y.txt")).unwrap();

    let o = h.commit(&fx, vec![whole("x.txt")], "remove x").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(changed_in_head(&fx), ["x.txt"]);
    assert_eq!(fx.status(), "?? y.txt\n");
}

#[tokio::test]
async fn a_file_that_becomes_a_directory_does_not_conflict_in_the_index() {
    // D/F: `x` (file) becomes `x/y` (directory); deletions must reach update-index first
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("df");
    fx.write("x", "was a file\n");
    fx.commit_all("base");
    fx.remove("x");
    fx.write("x/y", "now below a directory\n");

    let o = h.commit(&fx, vec![whole("x"), whole("x/y")], "file to directory").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.tree(), vec![b"x/y".to_vec()]);
    assert_eq!(fx.status(), "");
}

fn three_hunk_setup(sb: &Sandbox, name: &str) -> (Fixture, String) {
    let fx = sb.repo(name);
    let base = numbered(30);
    fx.write("f.txt", &base);
    fx.commit_all("base");
    let edited = edit_lines(&base, &[(2, "CHANGED 2"), (15, "CHANGED 15"), (28, "CHANGED 28")]);
    fx.write("f.txt", &edited);
    (fx, base)
}

#[tokio::test]
async fn c4_one_hunk_is_committed_and_the_worktree_is_untouched() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let (fx, base) = three_hunk_setup(&sb, "c4a");
    let before = sha(&fx.read("f.txt"));

    let o = h.commit(&fx, vec![partial("f.txt", &[(1, None)])], "middle hunk").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.show("HEAD:f.txt"), edit_lines(&base, &[(15, "CHANGED 15")]).into_bytes());
    assert_eq!(sha(&fx.read("f.txt")), before, "worktree bytes changed");
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "");
    let rest = hunk_lines(&fx, "f.txt");
    assert_eq!(rest.len(), 2);
    assert!(rest[0].contains(&"+CHANGED 2".to_owned()) && rest[1].contains(&"+CHANGED 28".to_owned()));
}

#[tokio::test]
async fn c4_line_level_selection_is_exact() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c4b");
    let lines: Vec<String> = (1..=20).map(|i| format!("line {i}")).collect();
    fx.write("f.txt", &(lines.join("\n") + "\n"));
    fx.commit_all("base");
    // NEW-A is inserted before line 10, line 10 is replaced by NEW-B
    let mut edited = lines[..9].to_vec();
    edited.extend(["NEW-A".to_owned(), "NEW-B".to_owned()]);
    edited.extend(lines[10..].iter().cloned());
    fx.write("f.txt", &(edited.join("\n") + "\n"));
    let before = fx.read("f.txt");
    let del = line_index(&fx, "f.txt", 0, "-line 10");
    let add_b = line_index(&fx, "f.txt", 0, "+NEW-B");

    let o = h.commit(&fx, vec![partial("f.txt", &[(0, Some(vec![del, add_b]))])], "b only").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    let mut want = lines[..9].to_vec();
    want.push("NEW-B".to_owned());
    want.extend(lines[10..].iter().cloned());
    assert_eq!(fx.show("HEAD:f.txt"), (want.join("\n") + "\n").into_bytes());
    assert_eq!(fx.read("f.txt"), before);
    let rest = hunk_lines(&fx, "f.txt");
    assert!(rest[0].contains(&"+NEW-A".to_owned()) && !rest[0].iter().any(|l| l.starts_with('-')), "{rest:?}");
}

#[tokio::test]
async fn c4_selecting_only_the_plus_half_of_a_replacement_keeps_both_lines() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c4c");
    fx.write("f.txt", &numbered(20));
    fx.commit_all("base");
    fx.write("f.txt", &edit_lines(&numbered(20), &[(10, "NEW-B")]));
    let add_b = line_index(&fx, "f.txt", 0, "+NEW-B");

    let o = h.commit(&fx, vec![partial("f.txt", &[(0, Some(vec![add_b]))])], "plus half").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    let committed = String::from_utf8(fx.show("HEAD:f.txt")).unwrap();
    assert!(committed.contains("line 10\n") && committed.contains("NEW-B\n"), "{committed}");
}

#[tokio::test]
async fn c4_previously_staged_other_hunk_loses_its_staging() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let (fx, _) = three_hunk_setup(&sb, "c4d");
    fx.stage(&["f.txt"]);

    let o = h.commit(&fx, vec![partial("f.txt", &[(1, None)])], "middle hunk").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "", "the other hunks are still staged");
    assert_eq!(hunk_lines(&fx, "f.txt").len(), 2);
}

#[tokio::test]
async fn c4_rewritten_headers_apply_without_recount() {
    let sb = Sandbox::new();
    let (fx, base) = three_hunk_setup(&sb, "c4e");
    let diff = fx.git_bytes(&["diff", "HEAD", "-U3", "--no-color", "--", "f.txt"]);
    let sel = [HunkSelection { index: 2, lines: None }, HunkSelection { index: 0, lines: None }];

    let patch = stage::filter_patch(&diff, &sel).unwrap();
    let (code, _, err) = fx.git_stdin(&["apply", "--cached"], &patch);

    assert_eq!(code, 0, "{err}");
    let staged = fx.git_bytes(&["show", ":f.txt"]);
    assert_eq!(staged, edit_lines(&base, &[(2, "CHANGED 2"), (28, "CHANGED 28")]).into_bytes());
}

#[tokio::test]
async fn c4_no_newline_at_end_of_file_survives_line_selection() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c4eof");
    // old: no trailing newline; new: a changed last line, still without one, plus an edit far above
    let base = format!("{}last", numbered(20));
    fx.write("f.txt", &base);
    fx.commit_all("base");
    let edited = format!("{}LAST", edit_lines(&numbered(20), &[(2, "CHANGED 2")]));
    fx.write("f.txt", &edited);

    let o = h.commit(&fx, vec![partial("f.txt", &[(1, None)])], "last line only").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.show("HEAD:f.txt"), format!("{}LAST", numbered(20)).into_bytes());
    assert_eq!(fx.read("f.txt"), edited.into_bytes());
}

#[tokio::test]
async fn c5_autocrlf_input_keeps_blobs_free_of_cr_and_worktree_bytes_unchanged() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c5a");
    fx.git(&["config", "core.autocrlf", "input"]);
    let base = numbered(20);
    fx.write("f.txt", &base);
    fx.commit_all("base");
    let crlf = edit_lines(&base, &[(2, "CHANGED 2"), (18, "CHANGED 18")]).replace('\n', "\r\n");
    fx.write("f.txt", &crlf);
    let before = fx.read("f.txt");

    let o = h.commit(&fx, vec![partial("f.txt", &[(1, None)])], "hunk 2").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    let blob = fx.show("HEAD:f.txt");
    assert!(!blob.contains(&b'\r'), "CR leaked into the blob");
    assert_eq!(blob, edit_lines(&base, &[(18, "CHANGED 18")]).into_bytes());
    assert_eq!(fx.read("f.txt"), before);
}

#[tokio::test]
async fn c5_legacy_crlf_blob_keeps_its_cr_on_both_sides_of_the_patch() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c5b");
    fx.git(&["config", "core.autocrlf", "false"]);
    let base = numbered(20).replace('\n', "\r\n");
    fx.write("f.txt", &base);
    fx.commit_all("base");
    fx.git(&["config", "core.autocrlf", "input"]);
    let edited = edit_lines(&numbered(20), &[(2, "CHANGED 2"), (18, "CHANGED 18")]).replace('\n', "\r\n");
    fx.write("f.txt", &edited);
    let before = fx.read("f.txt");

    let o = h.commit(&fx, vec![partial("f.txt", &[(1, None)])], "hunk 2").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    let want = edit_lines(&numbered(20), &[(18, "CHANGED 18")]).replace('\n', "\r\n");
    assert_eq!(fx.show("HEAD:f.txt"), want.into_bytes());
    assert_eq!(fx.read("f.txt"), before);
}

#[tokio::test]
async fn c5_cr_added_to_an_lf_blob_is_stripped_on_the_way_in() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c5c");
    fx.git(&["config", "core.autocrlf", "input"]);
    fx.write("f.txt", &numbered(5));
    fx.commit_all("base");
    fx.write("f.txt", &edit_lines(&numbered(5), &[(3, "CHANGED")]).replace('\n', "\r\n"));

    let o = h.commit(&fx, vec![whole("f.txt")], "crlf worktree").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert!(!fx.show("HEAD:f.txt").contains(&b'\r'));
    assert_eq!(fx.status(), "");
}

#[tokio::test]
async fn c6_binary_files_commit_byte_exact_and_refuse_partial_selection() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c6");
    let v1: Vec<u8> = (0..=255u8).chain(*b"\r\n\r\n").collect();
    fx.write_bytes("bin.dat", &v1);
    fx.write_bytes("old.bin", &v1);
    fx.commit_all("base");
    let v2: Vec<u8> = v1.iter().rev().copied().collect();
    fx.write_bytes("bin.dat", &v2);
    fx.write_bytes("new.bin", &v2);
    fx.remove("old.bin");

    let o = h.commit(&fx, vec![whole("bin.dat"), whole("new.bin"), whole("old.bin")], "binaries").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.show("HEAD:bin.dat"), v2);
    assert_eq!(fx.show("HEAD:new.bin"), v2);
    assert!(!fx.tree().contains(&b"old.bin".to_vec()));

    fx.write_bytes("bin.dat", &v1);
    let head = fx.head();
    let o = h.commit(&fx, vec![partial("bin.dat", &[(0, None)])], "partial binary").await;
    assert_eq!(failure_kind(&o), FailureKind::InvalidSelection);
    assert_eq!(fx.head(), head);
    assert!(fx.temp_indexes().is_empty());
}

#[tokio::test]
async fn c7_amend_keeps_the_author_cleans_the_message_and_allows_message_only() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c7");
    fx.write("a.txt", "v1\n");
    fx.git(&["add", "-A"]);
    fx.git(&["commit", "-q", "-m", "first line\n\nbody", "--date=2020-01-02T03:04:05+00:00"]);
    let (ctx, _) = h.run(OpKind::Commit);
    assert_eq!(commit::last_message(&ctx, &fx.cfg).await.unwrap(), "first line\n\nbody");

    fx.write("a.txt", "v2\n");
    let msg = "Second  \n\n\n\nbody line   \n# keep me\n\n";
    let o = h.commit_with(&fx, vec![whole("a.txt")], msg, true, false).await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.git(&["rev-list", "--count", "HEAD"]).trim(), "1");
    assert_eq!(fx.git(&["log", "-1", "--format=%B"]).trim_end(), "Second\n\nbody line\n# keep me");
    assert_eq!(fx.git(&["log", "-1", "--format=%aN %aI"]).trim(), format!("{NAME} 2020-01-02T03:04:05Z"));
    assert_eq!(fx.show("HEAD:a.txt"), b"v2\n");
    fx.assert_clean_commit("HEAD");

    let tree_before = fx.git(&["rev-parse", "HEAD^{tree}"]);
    let head_before = fx.head();
    let o = h.commit_with(&fx, vec![], "only the message", true, false).await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_ne!(fx.head(), head_before);
    assert_eq!(fx.git(&["rev-parse", "HEAD^{tree}"]), tree_before);
    assert_eq!(fx.git(&["log", "-1", "--format=%s"]).trim(), "only the message");
}

#[tokio::test]
async fn c8_failing_pre_commit_changes_nothing_and_its_output_is_captured() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c8");
    fx.write("a.txt", "v1\n");
    fx.write("b.txt", "v1\n");
    fx.commit_all("base");
    fx.write("a.txt", "v2\n");
    fx.write("b.txt", "v2\n");
    fx.stage(&["b.txt"]);
    fx.hook("pre-commit", "echo 'lint failed: bad things' >&2\necho \"index=$GIT_INDEX_FILE\" >&2\nexit 1");
    let (index, head, tree_sha, a_bytes) = (fx.index_bytes(), fx.head(), fx.ls_files_s(), fx.read("a.txt"));

    let o = h.commit(&fx, vec![whole("a.txt")], "will fail").await;

    assert_eq!(o.status, StepStatus::Failed);
    assert_eq!(failure_kind(&o), FailureKind::HookRejected);
    let out = failure_output(&o);
    assert!(out.contains("lint failed: bad things"), "{out}");
    assert!(out.contains(".git/ide-index."), "hook did not see the temp index: {out}");
    assert_eq!(fx.index_bytes(), index, "real index changed");
    assert_eq!((fx.head(), fx.ls_files_s(), fx.read("a.txt")), (head, tree_sha, a_bytes));
    assert!(fx.temp_indexes().is_empty());
    let streamed = h.events(fx.id());
    assert!(streamed.iter().any(|e| e.status == StepStatus::Hooks
        && e.line.as_ref().is_some_and(|l| l.text == "lint failed: bad things")));

    let o = h.commit_with(&fx, vec![whole("a.txt")], "skip hooks", false, true).await;
    assert_eq!(o.status, StepStatus::Done, "--no-verify must bypass the hook: {o:?}");
}

#[tokio::test]
async fn c10_hooks_run_with_the_resolved_path_and_a_missing_tool_rejects_the_commit() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c10");
    fx.write("a.txt", "v1\n");
    fx.commit_all("base");
    fx.write("a.txt", "v2\n");
    fx.hook("pre-commit", "echo \"PATH=$PATH\" >&2\nexit 1");

    let o = h.commit(&fx, vec![whole("a.txt")], "path probe").await;

    let want = h.plain().env.hook_env()["PATH"].clone();
    assert!(failure_output(&o).contains(&want), "hook PATH lacks {want}: {}", failure_output(&o));

    fx.hook("pre-commit", "intely-no-such-tool");
    let o = h.commit(&fx, vec![whole("a.txt")], "missing tool").await;
    assert_eq!(failure_kind(&o), FailureKind::HookRejected);
    assert!(failure_output(&o).contains("not found"), "{}", failure_output(&o));
}

#[tokio::test]
async fn c11_a_missing_commit_template_does_not_matter() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c11");
    fx.write("a.txt", "v1\n");
    fx.commit_all("base");
    fx.write("a.txt", "v2\n");
    fx.stage(&["a.txt"]);
    // the editor path dies on the missing template, which is why the engine always uses -F -
    let (code, _, err) = fx.git_try(&["commit"]);
    assert_ne!(code, 0);
    assert!(err.contains("could not read"), "{err}");

    let o = h.commit(&fx, vec![whole("a.txt")], "with message from stdin").await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    fx.write("a.txt", "v3\n");
    let o = h.commit_with(&fx, vec![whole("a.txt")], "amended without editor", true, false).await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
}

#[tokio::test]
async fn c12_odd_file_names_commit_exactly_and_never_act_as_globs() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c12");
    fx.write("i.tsx", "i v1\n");
    fx.write("d.tsx", "d v1\n");
    fx.commit_all("base");
    fx.write("i.tsx", "i v2\n");
    fx.write("d.tsx", "d v2\n");
    fx.stage(&["i.tsx", "d.tsx"]); // pre-staged siblings that `[id].tsx` would match as a glob
    let (i_line, d_line) = (fx.index_line("i.tsx"), fx.index_line("d.tsx"));
    let odd = [
        "with space.txt",
        "[id].tsx",
        "(tabs)/index.tsx",
        "-dash.txt",
        ":magic.txt",
        "new\nline.txt",
        "tab\there.txt",
        "q\"uote.txt",
        "back\\slash.txt",
        "*.glob",
        "\u{e1}rv\u{ed}zt\u{171}r\u{151}.txt",
    ];
    for name in odd {
        fx.write(name, &format!("content of {name:?}\n"));
    }

    let o = h.commit(&fx, odd.iter().map(|n| whole(n)).collect(), "odd names").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    let mut want: Vec<Vec<u8>> = odd.iter().map(|n| n.as_bytes().to_vec()).collect();
    want.extend([b"i.tsx".to_vec(), b"d.tsx".to_vec()]);
    let mut got = fx.tree();
    got.sort();
    want.sort();
    assert_eq!(got, want);
    assert_eq!(fx.index_line("i.tsx"), i_line, "glob trap: sibling unstaged");
    assert_eq!(fx.index_line("d.tsx"), d_line, "glob trap: sibling unstaged");
}

#[tokio::test]
async fn c12_nfd_spelling_commits_the_nfc_name_without_a_phantom_duplicate() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c12nfd");
    fx.write("README", "r\n");
    fx.commit_all("base");
    let nfc = "\u{e1}rv\u{ed}z.txt";
    let nfd = "a\u{301}rvi\u{301}z.txt";
    fx.write(nfc, "hungarian\n");

    let o = h.commit(&fx, vec![whole(nfd)], "nfd selection").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert!(fx.tree().contains(&nfc.as_bytes().to_vec()), "{:?}", fx.tree());
    assert_eq!(fx.status(), "", "phantom duplicate after an NFD selection");
}

fn merge_setup(sb: &Sandbox, name: &str, conflict: bool) -> Fixture {
    let fx = sb.repo(name);
    fx.write("f.txt", "base\n");
    fx.write("g.txt", "g base\n");
    fx.commit_all("base");
    fx.git(&["checkout", "-q", "-b", "feature"]);
    fx.write("f.txt", "feature\n");
    fx.write("h.txt", "from feature\n");
    fx.commit_all("feature");
    fx.git(&["checkout", "-q", "main"]);
    if conflict {
        fx.write("f.txt", "main\n");
    } else {
        fx.write("g.txt", "g main\n");
    }
    fx.commit_all("main");
    let (code, _, _) = fx.git_try(&["merge", "--no-commit", "--no-ff", "feature"]);
    assert_eq!(code, i32::from(conflict), "merge setup");
    fx
}

#[tokio::test]
async fn c13_a_resolved_merge_commits_the_whole_index_as_a_two_parent_commit() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = merge_setup(&sb, "c13a", false);

    // only f.txt is "checked", but a merge commit has to take the whole merge result (h.txt included)
    let o = h.commit(&fx, vec![whole("f.txt")], "merge feature").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    let parents = fx.git(&["rev-list", "--parents", "-n", "1", "HEAD"]);
    assert_eq!(parents.split_whitespace().count(), 3, "{parents}");
    assert!(fx.tree().contains(&b"h.txt".to_vec()));
    assert_eq!(fx.status(), "");
    fx.assert_clean_commit("HEAD");
}

#[tokio::test]
async fn c13_partial_selection_and_amend_are_refused_during_a_merge() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = merge_setup(&sb, "c13b", false);
    let head = fx.head();

    let o = h.commit(&fx, vec![partial("f.txt", &[(0, None)])], "partial in merge").await;
    assert_eq!(failure_kind(&o), FailureKind::InvalidSelection);
    let o = h.commit_with(&fx, vec![whole("f.txt")], "amend in merge", true, false).await;
    assert_eq!(failure_kind(&o), FailureKind::InvalidSelection);

    assert_eq!(fx.head(), head);
    assert!(fx.git_dir().join("MERGE_HEAD").exists());
}

#[tokio::test]
async fn c13_unmerged_files_are_a_conflict_until_resolved() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = merge_setup(&sb, "c13c", true);
    let head = fx.head();

    let o = h.commit(&fx, vec![whole("f.txt")], "too early").await;
    assert_eq!(failure_kind(&o), FailureKind::Conflict);
    assert_eq!(fx.head(), head);

    fx.write("f.txt", "resolved\n");
    fx.stage(&["f.txt"]);
    let o = h.commit(&fx, vec![whole("f.txt")], "merge feature").await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.status(), "");
}

#[tokio::test]
async fn c13_cherry_pick_state_commits_from_the_real_index_and_keeps_the_original_author() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c13d");
    fx.write("f.txt", "base\n");
    fx.commit_all("base");
    fx.git(&["checkout", "-q", "-b", "feature"]);
    fx.write("f.txt", "feature\n");
    let picked = fx.commit_all("feature change");
    fx.git(&["checkout", "-q", "main"]);
    fx.write("f.txt", "main\n");
    fx.commit_all("main change");
    let (code, _, _) = fx.git_try(&["cherry-pick", &picked]);
    assert_ne!(code, 0);
    fx.write("f.txt", "resolved\n");
    fx.stage(&["f.txt"]);

    let o = h.commit(&fx, vec![whole("f.txt")], "feature change (picked)").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.git(&["rev-list", "--parents", "-n", "1", "HEAD"]).split_whitespace().count(), 2);
    assert_eq!(fx.show("HEAD:f.txt"), b"resolved\n");
    assert!(!fx.git_dir().join("CHERRY_PICK_HEAD").exists());
    fx.assert_clean_commit("HEAD");
}

#[tokio::test]
async fn c13_a_rebase_marker_takes_the_plain_commit_path() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c13e");
    fx.write("a.txt", "a\n");
    fx.commit_all("base");
    fx.write("a.txt", "a2\n");
    fx.write("staged.txt", "staged\n");
    fx.stage(&["staged.txt"]);
    std::fs::create_dir(fx.git_dir().join("rebase-merge")).unwrap();

    let o = h.commit(&fx, vec![whole("a.txt")], "during rebase").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    // the plain path commits the index: the ticked a.txt is staged first, the unticked staged file rides along
    assert_eq!(changed_in_head(&fx), ["a.txt", "staged.txt"]);
}

#[tokio::test]
async fn c15_an_existing_index_lock_is_reported_before_anything_happens() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c15a");
    fx.write("a.txt", "v1\n");
    fx.commit_all("base");
    fx.write("a.txt", "v2\n");
    std::fs::write(fx.git_dir().join("index.lock"), "").unwrap();
    let head = fx.head();

    let o = h.commit(&fx, vec![whole("a.txt")], "locked").await;

    assert_eq!(failure_kind(&o), FailureKind::LockBusy);
    assert_eq!(fx.head(), head);
    assert!(fx.git_dir().join("index.lock").exists(), "the lock must never be deleted");
    assert!(fx.temp_indexes().is_empty());
}

#[tokio::test]
async fn c15_a_lock_taken_during_the_commit_leaves_it_committed_but_unreconciled_until_retried() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c15b");
    fx.write("a.txt", "v1\n");
    fx.commit_all("base");
    fx.write("a.txt", "v2\n");
    fx.hook("pre-commit", "touch .git/index.lock");
    let started = Instant::now();

    let o = h.commit(&fx, vec![whole("a.txt")], "lock during commit").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert!(!o.reconciled);
    assert_eq!(o.failure.as_ref().map(|f| f.kind.clone()), Some(FailureKind::LockBusy));
    assert!(started.elapsed() >= Duration::from_millis(2500), "the reconcile gave up after {:?}", started.elapsed());
    assert_eq!(fx.show("HEAD:a.txt"), b"v2\n");
    assert!(fx.git_dir().join("index.lock").exists(), "the lock must never be deleted");
    assert!(fx.status().contains("MM a.txt"), "{}", fx.status());

    std::fs::remove_file(fx.git_dir().join("index.lock")).unwrap();
    let (ctx, _) = h.run(OpKind::Commit);
    commit::reconcile(&ctx, &fx.cfg, &[whole("a.txt")]).await.unwrap();
    assert_eq!(fx.status(), "");
}

#[tokio::test]
async fn c15_a_lock_that_vanishes_is_waited_out_by_the_backoff() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c15c");
    fx.write("a.txt", "v1\n");
    fx.commit_all("base");
    fx.write("a.txt", "v2\n");
    fx.hook("pre-commit", "touch .git/index.lock\n(sleep 1; rm -f .git/index.lock) >/dev/null 2>&1 &");

    let o = h.commit(&fx, vec![whole("a.txt")], "transient lock").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert!(o.reconciled && o.failure.is_none(), "{o:?}");
    assert_eq!(fx.status(), "");
}

#[tokio::test]
async fn c16_every_spawn_disables_gc_and_maintenance() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("c16");
    fx.write("a.txt", "v1\n");
    fx.commit_all("base");
    fx.write("a.txt", "v2\n");
    // -c options travel to hooks through GIT_CONFIG_PARAMETERS
    fx.hook("pre-commit", "echo \"gc=$(git config gc.auto) maint=$(git config maintenance.auto)\" >&2\nexit 1");

    let o = h.commit(&fx, vec![whole("a.txt")], "probe").await;

    assert!(failure_output(&o).contains("gc=0 maint=false"), "{}", failure_output(&o));
}

#[tokio::test]
async fn an_empty_message_and_an_empty_selection_are_refused_up_front() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("validate");
    fx.write("a.txt", "v1\n");
    fx.commit_all("base");
    fx.write("a.txt", "v2\n");
    let head = fx.head();

    let o = h.commit(&fx, vec![whole("a.txt")], "  \n\t\n").await;
    assert_eq!(failure_kind(&o), FailureKind::EmptyMessage);
    let o = h.commit(&fx, vec![], "no files").await;
    assert_eq!(failure_kind(&o), FailureKind::NothingToCommit);
    fx.write("a.txt", "v1\n");
    let o = h.commit(&fx, vec![whole("a.txt")], "unchanged file").await;
    assert_eq!(failure_kind(&o), FailureKind::NothingToCommit);
    let o = h.commit(&fx, vec![whole("nested/")], "a directory").await;
    assert_eq!(failure_kind(&o), FailureKind::InvalidSelection);
    let o = h.commit(&fx, vec![whole("../escape.txt")], "traversal").await;
    assert_eq!(failure_kind(&o), FailureKind::InvalidSelection);

    assert_eq!(fx.head(), head);
    assert!(fx.temp_indexes().is_empty());
}

#[tokio::test]
async fn guarded_files_are_refused() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("guard");
    fx.write("a.txt", "v1\n");
    fx.commit_all("base");
    fx.write(".env", "SECRET=1\n");
    fx.write("dump_db/x.sql", "select 1;\n");
    fx.write("ok.txt", "fine\n");
    let head = fx.head();

    for (file, name) in [(".env", "secret"), ("dump_db/x.sql", "never-add")] {
        let o = h.commit(&fx, vec![whole("ok.txt"), whole(file)], "guarded").await;
        assert_eq!(failure_kind(&o), FailureKind::GuardBlocked, "{name}");
        assert!(o.failure.unwrap().message.contains(file));
    }
    assert_eq!(fx.head(), head);

    let o = h.commit(&fx, vec![whole("ok.txt")], "the allowed one").await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
}

#[tokio::test]
async fn the_first_commit_of_an_unborn_branch_works_and_amend_needs_a_commit() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("unborn");
    fx.write("a.txt", "a\n");
    fx.write("b.txt", "b\n");

    let o = h.commit_with(&fx, vec![whole("a.txt")], "amend nothing", true, false).await;
    assert_eq!(failure_kind(&o), FailureKind::NothingToCommit);

    let o = h.commit(&fx, vec![whole("a.txt")], "root commit").await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.tree(), vec![b"a.txt".to_vec()]);
    assert_eq!(fx.status(), "?? b.txt\n");
    let (ctx, _) = h.run(OpKind::Commit);
    assert_eq!(commit::last_message(&ctx, &fx.cfg).await.unwrap(), "root commit");
}

#[tokio::test]
async fn case_only_renames_are_refused_instead_of_corrupting_head() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("case");
    fx.git(&["config", "core.ignorecase", "true"]);
    fx.write("Foo.txt", &numbered(5));
    fx.commit_all("base");
    fx.git(&["mv", "Foo.txt", "foo.txt"]);
    let head = fx.head();

    let o = h.commit(&fx, vec![renamed("foo.txt", "Foo.txt")], "case rename").await;

    assert_eq!(failure_kind(&o), FailureKind::InvalidSelection);
    assert!(o.failure.unwrap().message.contains("letter case"));
    assert_eq!(fx.head(), head);
    assert_eq!(fx.tree(), vec![b"Foo.txt".to_vec()]);
    assert!(fx.temp_indexes().is_empty());
}

#[tokio::test]
async fn files_rewritten_by_a_hook_are_reported_and_ride_along_in_the_commit() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("hookmod");
    fx.write("a.txt", "v1\n");
    fx.write("b.txt", "v1\n");
    fx.commit_all("base");
    fx.write("a.txt", "v2\n");
    fx.write("b.txt", "v2\n");
    // a formatter: rewrites the checked file and re-adds it to the (temp) index the hook runs against
    fx.hook("pre-commit", "echo formatted >> a.txt\ngit add a.txt");

    let o = h.commit(&fx, vec![whole("a.txt"), whole("b.txt")], "formatted").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(o.hook_modified_files, ["a.txt"]);
    assert_eq!(fx.show("HEAD:a.txt"), b"v2\nformatted\n");
    assert_eq!(fx.status(), "");
}

#[tokio::test]
async fn x4_head_moving_during_preparation_aborts_the_commit() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("x4");
    fx.write("a.txt", "v1\n");
    fx.commit_all("base");
    fx.write("a.txt", "v2\n");
    // another tool commits right after the temp index was written (the hook fires for the temp index only)
    fx.hook(
        "post-index-change",
        "[ -n \"$GIT_INDEX_FILE\" ] || exit 0\n[ -e .git/x4-done ] && exit 0\ntouch .git/x4-done\n(unset GIT_INDEX_FILE; git commit -q --allow-empty -m 'other tool')",
    );
    let before = fx.head();

    let o = h.commit(&fx, vec![whole("a.txt")], "ours").await;

    assert_eq!(failure_kind(&o), FailureKind::HeadMoved, "{o:?}");
    assert_ne!(fx.head(), before);
    assert_eq!(fx.git(&["log", "-1", "--format=%s"]).trim(), "other tool");
    assert_eq!(fx.git(&["rev-list", "--count", "HEAD"]).trim(), "2", "our commit must not exist");
    assert!(fx.temp_indexes().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelling_a_slow_hook_kills_its_process_group_and_leaves_no_trace() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("cancel-commit");
    fx.write("a.txt", "v1\n");
    fx.commit_all("base");
    fx.write("a.txt", "v2\n");
    let (p1, p2) = (fx.path.join("hook.pid"), fx.path.join("sleep.pid"));
    fx.hook(
        "pre-commit",
        &format!("echo $$ > {}\nsleep 60 &\necho $! > {}\nwait", p1.display(), p2.display()),
    );
    let head = fx.head();
    let (ctx, cancel) = h.run(OpKind::Commit);
    let rc = intely_core::RepoCommit {
        repo_id: fx.id().to_owned(),
        files: vec![whole("a.txt")],
        message: "never".to_owned(),
        amend: false,
    };
    let canceller = tokio::spawn({
        let (p1, p2) = (p1.clone(), p2.clone());
        async move {
            while !p2.exists() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let _ = p1;
            tokio::time::sleep(Duration::from_millis(300)).await;
            cancel.cancel();
        }
    });

    let o = commit::run_commit(&ctx, &fx.cfg, &rc, false).await;
    canceller.await.unwrap();

    assert_eq!(o.status, StepStatus::Cancelled, "{o:?}");
    assert_eq!(fx.head(), head);
    assert!(fx.temp_indexes().is_empty());
    for pid in [p1, p2].iter().filter_map(|p| read_pid(p)) {
        assert!(wait_until(Duration::from_secs(4), || !pid_alive(pid)), "process {pid} survived the cancel");
    }
}

#[tokio::test]
async fn progress_events_follow_the_commit_steps() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("events");
    fx.write("a.txt", "v1\n");
    fx.commit_all("base");
    fx.write("a.txt", "v2\n");
    fx.hook("pre-commit", "echo checking >&2");

    let o = h.commit(&fx, vec![whole("a.txt")], "events").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    let mut statuses: Vec<StepStatus> = h.events(fx.id()).into_iter().map(|e| e.status).collect();
    statuses.dedup();
    assert_eq!(
        statuses,
        [StepStatus::Preparing, StepStatus::Hooks, StepStatus::Reconciling, StepStatus::Done]
    );
    assert!(h.lines(fx.id()).contains(&"checking".to_owned()));
}

#[tokio::test]
async fn a_message_only_amend_keeps_the_users_staged_state() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("amend-keeps-staged");
    fx.write("a.txt", "a\n");
    fx.write("b.txt", "b\n");
    fx.commit_all("base");
    fx.write("b.txt", "b2\n");
    fx.write("c.txt", "c\n");
    fx.stage(&["b.txt", "c.txt"]);

    let o = h.commit_with(&fx, vec![], "new message", true, false).await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.git(&["log", "-1", "--format=%s"]).trim(), "new message");
    assert_eq!(fx.status().lines().collect::<Vec<_>>(), ["M  b.txt", "A  c.txt"]);
    // reconcile with nothing to reset is a no-op as well
    let (ctx, _) = h.run(OpKind::Commit);
    commit::reconcile(&ctx, &fx.cfg, &[]).await.unwrap();
    assert_eq!(fx.status().lines().collect::<Vec<_>>(), ["M  b.txt", "A  c.txt"]);
}

#[tokio::test]
async fn files_a_hook_adds_to_the_commit_are_reconciled_and_reported() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("hook-adds");
    fx.write("a.txt", "v1\n");
    fx.write("gen.txt", "g1\n");
    fx.commit_all("base");
    fx.write("a.txt", "v2\n");
    fx.hook("pre-commit", "echo new > gen-new.txt\necho g2 > gen.txt\ngit add gen-new.txt gen.txt");

    let o = h.commit(&fx, vec![whole("a.txt")], "codegen").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(changed_in_head(&fx), ["a.txt", "gen-new.txt", "gen.txt"]);
    assert_eq!(o.hook_modified_files, ["gen-new.txt", "gen.txt"]);
    assert_eq!(fx.status(), "", "the real index must match HEAD for the hook-added files");
}

#[tokio::test]
async fn a_merge_commit_stages_the_ticked_unstaged_edit() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = merge_setup(&sb, "merge-unstaged", false);
    fx.write("g.txt", "resolved by hand\n");

    let o = h.commit(&fx, vec![whole("g.txt")], "merge feature").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.show("HEAD:g.txt"), b"resolved by hand\n");
    assert_eq!(fx.status(), "");
}

#[tokio::test]
async fn a_guarded_path_staged_in_a_merge_blocks_the_whole_commit() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = merge_setup(&sb, "merge-guard", false);
    fx.write("dump_x/leak.txt", "secret-ish\n");
    fx.stage(&["dump_x/leak.txt"]);
    let head = fx.head();

    let o = h.commit(&fx, vec![whole("g.txt")], "merge feature").await;

    assert_eq!(failure_kind(&o), FailureKind::GuardBlocked);
    assert_eq!(fx.head(), head);
}

#[tokio::test]
async fn a_failing_hook_in_a_merge_leaves_the_real_index_untouched() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = merge_setup(&sb, "merge-hook-fails", false);
    fx.write("g.txt", "resolved by hand\n");
    fx.hook("pre-commit", "echo no >&2\nexit 1");
    let (head, index, cached) = (fx.head(), fx.index_bytes(), fx.git(&["diff", "--cached", "--name-only"]));
    assert_eq!(cached.trim(), "f.txt\nh.txt");

    let o = h.commit(&fx, vec![whole("g.txt")], "merge feature").await;

    assert_eq!(failure_kind(&o), FailureKind::HookRejected, "{o:?}");
    assert_eq!(fx.head(), head);
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), cached, "the ticked edit must stay unstaged");
    assert_eq!(fx.index_bytes(), index);
    assert!(fx.status().contains(" M g.txt"), "{}", fx.status());
    assert!(fx.git_dir().join("MERGE_HEAD").exists());
    assert!(fx.temp_indexes().is_empty(), "{:?}", fx.temp_indexes());

    // the same commit goes through once the hook passes, and then takes the edit along
    fx.remove_hook("pre-commit");
    let o = h.commit(&fx, vec![whole("g.txt")], "merge feature").await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.show("HEAD:g.txt"), b"resolved by hand\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cancelled_merge_commit_restores_the_real_index_too() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = merge_setup(&sb, "merge-cancel", false);
    fx.write("g.txt", "resolved by hand\n");
    fx.hook("pre-commit", "sleep 30");
    let index = fx.index_bytes();
    let (ctx, cancel) = h.run(OpKind::Commit);
    let rc = intely_core::RepoCommit { repo_id: fx.id().to_owned(), files: vec![whole("g.txt")], message: "never".to_owned(), amend: false };
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        cancel.cancel();
    });

    let o = commit::run_commit(&ctx, &fx.cfg, &rc, false).await;

    assert_eq!(o.status, StepStatus::Cancelled, "{o:?}");
    assert_eq!(fx.index_bytes(), index);
    assert!(fx.temp_indexes().is_empty());
}

/// `.npmrc` is tracked, a merge brings in files whose names look guarded, and a stranger is staged by hand.
fn guarded_names_merge_setup(sb: &Sandbox, name: &str) -> Fixture {
    let fx = sb.repo(name);
    fx.write(".npmrc", "registry=a\n");
    fx.write("g.txt", "g base\n");
    fx.commit_all("base");
    fx.git(&["checkout", "-q", "-b", "feature"]);
    fx.write(".npmrc", "registry=b\n");
    fx.write(".env.ci", "CI=1\n");
    fx.write("backup_old/x.txt", "x\n");
    fx.commit_all("feature");
    fx.git(&["checkout", "-q", "main"]);
    fx.write("g.txt", "g main\n");
    fx.commit_all("main");
    let (code, _, _) = fx.git_try(&["merge", "--no-commit", "--no-ff", "feature"]);
    assert_eq!(code, 0, "merge setup");
    fx
}

#[tokio::test]
async fn a_tracked_secret_named_file_can_be_committed_but_a_new_one_cannot() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("npmrc");
    fx.write(".npmrc", "registry=a\n");
    fx.write("a.txt", "v1\n");
    fx.commit_all("base");
    fx.write(".npmrc", "registry=b\n");
    fx.write("id_rsa", "not really\n");

    let o = h.commit(&fx, vec![whole(".npmrc")], "switch registry").await;
    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.show("HEAD:.npmrc"), b"registry=b\n");

    let head = fx.head();
    let o = h.commit(&fx, vec![whole("id_rsa")], "oops").await;
    assert_eq!(failure_kind(&o), FailureKind::GuardBlocked);
    // staged by hand it is still new to the repo
    fx.stage(&["id_rsa"]);
    let o = h.commit(&fx, vec![whole("id_rsa")], "oops").await;
    assert_eq!(failure_kind(&o), FailureKind::GuardBlocked);
    assert_eq!(fx.head(), head);
}

#[tokio::test]
async fn a_merge_may_bring_in_guarded_names_and_a_tracked_secret_edit_may_be_ticked() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = guarded_names_merge_setup(&sb, "merge-brings-guarded");
    fx.write("g.txt", "resolved\n");
    fx.write(".npmrc", "registry=c\n");

    let o = h.commit(&fx, vec![whole("g.txt"), whole(".npmrc")], "merge feature").await;

    assert_eq!(o.status, StepStatus::Done, "{o:?}");
    assert_eq!(fx.show("HEAD:.npmrc"), b"registry=c\n");
    assert_eq!(fx.show("HEAD:.env.ci"), b"CI=1\n");
    assert!(fx.tree().contains(&b"backup_old/x.txt".to_vec()));
    assert_eq!(fx.status(), "");
}

#[tokio::test]
async fn a_guarded_file_staged_by_hand_during_a_merge_still_blocks() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = guarded_names_merge_setup(&sb, "merge-hand-staged");
    fx.write(".env.local", "SECRET=1\n");
    fx.stage(&[".env.local"]);
    let (head, index) = (fx.head(), fx.index_bytes());

    let o = h.commit(&fx, vec![whole("g.txt")], "merge feature").await;

    assert_eq!(failure_kind(&o), FailureKind::GuardBlocked);
    assert!(o.failure.unwrap().message.contains(".env.local"));
    assert_eq!((fx.head(), fx.index_bytes()), (head, index));
}

#[tokio::test]
async fn unmerged_entries_without_a_merge_marker_are_a_conflict() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = merge_setup(&sb, "unmerged-no-marker", true);
    std::fs::remove_file(fx.git_dir().join("MERGE_HEAD")).unwrap();
    let head = fx.head();

    let o = h.commit(&fx, vec![whole("h.txt")], "should not land").await;

    assert_eq!(failure_kind(&o), FailureKind::Conflict);
    assert_eq!(fx.head(), head);
}

#[tokio::test]
async fn hook_output_that_mentions_auth_or_conflicts_is_still_a_hook_rejection() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("hook-words");
    fx.write("a.txt", "v1\n");
    fx.commit_all("base");
    fx.write("a.txt", "v2\n");
    fx.hook("pre-commit", "echo 'The requested URL returned error: 403' >&2\necho 'CONFLICT markers' >&2\nexit 1");

    let o = h.commit(&fx, vec![whole("a.txt")], "tests failed").await;

    assert_eq!(failure_kind(&o), FailureKind::HookRejected, "{o:?}");
    assert!(failure_output(&o).contains("403"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelling_while_preparing_reports_cancelled_not_a_failure() {
    let sb = Sandbox::new();
    let h = Harness::new();
    let fx = sb.repo("cancel-preparing");
    fx.write("a.txt", "v1\n");
    fx.write(".gitattributes", "a.txt filter=slow\n");
    fx.commit_all("base");
    fx.write("a.txt", "v2\n");
    // hashing a.txt waits for the clean filter, which keeps the preparing phase busy (core.fsmonitor can no longer do
    // that: every IDE git runs with it disabled)
    fx.git(&["config", "filter.slow.clean", "sleep 5; cat"]);
    let (ctx, cancel) = h.run(OpKind::Commit);
    let rc = intely_core::RepoCommit {
        repo_id: fx.id().to_owned(),
        files: vec![whole("a.txt")],
        message: "never".to_owned(),
        amend: false,
    };
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        cancel.cancel();
    });

    let o = commit::run_commit(&ctx, &fx.cfg, &rc, false).await;

    assert_eq!(o.status, StepStatus::Cancelled, "{o:?}");
    assert!(fx.temp_indexes().is_empty());
}
