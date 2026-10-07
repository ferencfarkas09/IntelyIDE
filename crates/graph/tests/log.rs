mod common;

use common::Sandbox;
use intely_graph::types::{FileKind, LaneEdgeKind, LogFilters, RefKind};
use intely_graph::Graph;

fn graph() -> Graph {
    Graph::new(None)
}

/// main: a - b - m (merge of feat), feat: a - c
fn branched(sb: &Sandbox, name: &str) -> common::Repo {
    let r = sb.repo(name);
    r.commit("a", &[("f.txt", "1\n")]);
    r.git(&["checkout", "-q", "-b", "feat"]);
    r.commit("c", &[("g.txt", "g\n")]);
    r.git(&["checkout", "-q", "main"]);
    r.commit("b", &[("h.txt", "h\n")]);
    r.git(&["merge", "-q", "--no-ff", "-m", "m", "feat"]);
    r.git(&["tag", "v1"]);
    r
}

#[tokio::test]
async fn the_graph_has_lanes_decorations_and_stable_pages() {
    let sb = Sandbox::new();
    let r = branched(&sb, "api");
    let env = sb.env(&[&r]);
    let ids = vec!["api".to_owned()];

    let all = graph().log_page(&env, &ids, None, &LogFilters::default(), None).await.expect("log");
    assert_eq!(all.rows.iter().map(|r| r.subject.as_str()).collect::<Vec<_>>().len(), 4);
    assert!(all.next_cursor.is_none());
    let merge = &all.rows[0];
    assert_eq!(merge.subject, "m");
    assert_eq!(merge.parents.len(), 2);
    assert_eq!(merge.edges.iter().filter(|e| e.kind == LaneEdgeKind::Down).count(), 2);
    assert!(merge.decorations.iter().any(|d| d.name == "main" && d.kind == RefKind::Branch && d.current));
    assert!(merge.decorations.iter().any(|d| d.name == "v1" && d.kind == RefKind::Tag));
    assert_eq!(all.repos[0].repo_id, "api");

    // pages of 2 resume the lanes exactly where the previous page stopped
    let mut paged = Vec::new();
    let mut cursor = None;
    loop {
        let page = graph().log_page(&env, &ids, cursor.as_deref(), &LogFilters::default(), Some(2)).await.expect("page");
        assert!(page.rows.len() <= 2);
        paged.extend(page.rows);
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(paged, all.rows);
}

#[tokio::test]
async fn repos_are_interleaved_by_commit_time() {
    let sb = Sandbox::new();
    let (a, b) = (sb.repo("api"), sb.repo("web"));
    a.commit_at("a1", &[("x", "1")], 1000);
    b.commit_at("b1", &[("x", "1")], 1100);
    a.commit_at("a2", &[("x", "2")], 1200);
    b.commit_at("b2", &[("x", "2")], 1300);
    let env = sb.env(&[&a, &b]);
    let ids = vec!["api".to_owned(), "web".to_owned()];

    let page = graph().log_page(&env, &ids, None, &LogFilters::default(), None).await.expect("log");
    assert_eq!(page.rows.iter().map(|r| (r.repo_id.as_str(), r.subject.as_str())).collect::<Vec<_>>(), vec![("web", "b2"), ("api", "a2"), ("web", "b1"), ("api", "a1")]);
    assert_eq!(page.repos.len(), 2);

    let first = graph().log_page(&env, &ids, None, &LogFilters::default(), Some(3)).await.expect("p1");
    let second = graph().log_page(&env, &ids, first.next_cursor.as_deref(), &LogFilters::default(), Some(3)).await.expect("p2");
    let both: Vec<_> = first.rows.iter().chain(&second.rows).map(|r| r.subject.as_str()).collect();
    assert_eq!(both, vec!["b2", "a2", "b1", "a1"]);
    assert!(second.next_cursor.is_none());
}

#[tokio::test]
async fn filters_narrow_the_log_and_an_empty_repo_is_an_empty_log() {
    let sb = Sandbox::new();
    let r = sb.repo("api");
    let empty = sb.repo("empty");
    r.commit("feat: alpha", &[("a/x.txt", "1")]);
    r.commit("fix: beta", &[("b/y.txt", "1")]);
    let env = sb.env(&[&r, &empty]);
    let ids = vec!["api".to_owned(), "empty".to_owned()];

    let by_text = LogFilters { text: Some("BETA".into()), ..LogFilters::default() };
    assert_eq!(graph().log_page(&env, &ids, None, &by_text, None).await.expect("text").rows.len(), 1);
    let by_path = LogFilters { path: Some("a/x.txt".into()), ..LogFilters::default() };
    assert_eq!(graph().log_page(&env, &ids, None, &by_path, None).await.expect("path").rows[0].subject, "feat: alpha");
    // a date after every commit that git accepts as such (newer versions refuse an absurd one, older ones read it as "now")
    let by_time = LogFilters { since_ms: Some(4_000_000_000_000), ..LogFilters::default() };
    assert!(graph().log_page(&env, &ids, None, &by_time, None).await.expect("time").rows.is_empty());
    let bad = LogFilters { branch: Some("--output=/tmp/graph-test".into()), ..LogFilters::default() };
    assert_eq!(graph().log_page(&env, &ids, None, &bad, None).await.unwrap_err().code, "invalidArgument");
}

#[tokio::test]
async fn commit_detail_lists_files_with_stats_for_renames_binaries_and_roots() {
    let sb = Sandbox::new();
    let r = sb.repo("api");
    let root = r.commit("root", &[("keep.txt", "k\n"), ("old.txt", "one\ntwo\nthree\nfour\nfive\n"), ("gone.txt", "bye\n")]);
    r.git(&["mv", "old.txt", "new.txt"]);
    r.write("new.txt", "one\ntwo\nthree\nfour\nfive\nsix\n");
    std::fs::write(r.path.join("img.bin"), [0u8, 159, 146, 150, 0, 1, 2]).expect("bin");
    std::fs::remove_file(r.path.join("gone.txt")).expect("rm");
    let oid = r.commit("change", &[("keep.txt", "k\nk2\n")]);
    let env = sb.env(&[&r]);

    let d = graph().commit_detail(&env, "api", &oid).await.expect("detail");
    let kind = |p: &str| d.files.iter().find(|f| f.path == p).unwrap_or_else(|| panic!("{p} missing in {:?}", d.files));
    assert_eq!(kind("new.txt").kind, FileKind::Renamed);
    assert_eq!(kind("new.txt").orig_path.as_deref(), Some("old.txt"));
    assert_eq!(kind("keep.txt").additions, Some(1));
    assert!(kind("img.bin").binary);
    assert_eq!(kind("gone.txt").kind, FileKind::Deleted);
    assert_eq!(d.message, "change");
    assert_eq!(d.parents.len(), 1);

    let rd = graph().commit_detail(&env, "api", &root[..10]).await.expect("root");
    assert!(rd.parents.is_empty());
    assert_eq!(rd.files.len(), 3);
    assert!(rd.files.iter().all(|f| f.kind == FileKind::Added));
    assert_eq!(graph().commit_detail(&env, "api", "--stat").await.unwrap_err().code, "invalidArgument");
}

#[tokio::test]
async fn file_history_follows_renames() {
    let sb = Sandbox::new();
    let r = sb.repo("api");
    r.commit("create", &[("a.txt", "line one\nline two\nline three\nline four\n")]);
    r.git(&["mv", "a.txt", "b.txt"]);
    r.commit("rename", &[]);
    r.commit("edit", &[("b.txt", "line one\nline two\nline three\nline four\nline five\n")]);
    let env = sb.env(&[&r]);
    let rows = graph().file_history(&env, &"api".to_owned(), "b.txt").await.expect("history");
    assert_eq!(rows.iter().map(|r| r.subject.as_str()).collect::<Vec<_>>(), vec!["edit", "rename", "create"]);
}

#[tokio::test]
async fn blame_reports_authorship_per_line_and_the_caret_info() {
    let sb = Sandbox::new();
    let r = sb.repo("api");
    let first = r.commit_at("first", &[("f.txt", "one\ntwo\n")], 1_000_000);
    let second = r.commit_at("second", &[("f.txt", "one\nTWO\nthree\n")], 2_000_000);
    let env = sb.env(&[&r]);
    let g = graph();

    let lines = g.blame(&env, "api", "f.txt", Some("HEAD")).await.expect("blame");
    assert_eq!(lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), vec!["one", "TWO", "three"]);
    assert_eq!(lines[0].oid, first);
    assert_eq!(lines[1].oid, second);
    assert_eq!(lines[1].summary, "second");
    assert_eq!(lines[1].date_ms, 2_000_000_000);
    assert_eq!(lines[1].author, "Fixture User");
    assert!(lines[0].boundary);

    let caret = g.blame_caret(&env, "api", "f.txt", 2, Some("HEAD")).await.expect("caret");
    assert_eq!((caret.subject.as_str(), caret.author.as_str()), ("second", "Fixture User"));
    assert!(caret.relative_time.ends_with("ago"));
    assert_eq!(g.blame_caret(&env, "api", "f.txt", 9, Some("HEAD")).await.unwrap_err().code, "invalidArgument");

    // the working tree: an edit shows up as uncommitted, and the cache follows the file
    r.write("f.txt", "one\nTWO\nthree\nfour\n");
    let wt = g.blame(&env, "api", "f.txt", None).await.expect("worktree blame");
    assert!(wt[3].uncommitted);
    assert_eq!(g.blame_caret(&env, "api", "f.txt", 4, None).await.expect("c").relative_time, "Not committed yet");
    assert_eq!(g.blame(&env, "api", "f.txt", Some("--bad")).await.unwrap_err().code, "invalidArgument");
}
