mod common;

use common::*;
use intely_files::{SearchBatch, SearchHit, SearchOptions};

fn opts() -> SearchOptions {
    SearchOptions { repo_ids: None, regex: false, case_sensitive: false, glob: None }
}

fn hits(batches: &[SearchBatch]) -> Vec<SearchHit> {
    let mut all: Vec<SearchHit> = batches.iter().flat_map(|b| b.hits.clone()).collect();
    all.sort_by(|a, b| (&a.repo_id, &a.path, a.line).cmp(&(&b.repo_id, &b.path, b.line)));
    all
}

fn summary(h: &[SearchHit]) -> Vec<(String, String, u32, u32)> {
    h.iter().map(|h| (h.repo_id.clone(), h.path.clone(), h.line, h.col)).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn git_grep_search_streams_hits_and_skips_guarded_ignored_files() {
    let sb = Sandbox::new();
    let (a, b) = (sb.repo("a"), sb.repo("b"));
    a.write(".gitignore", "build/\n");
    a.write("src/one.ts", "const Needle = 1;\n  // needle again\nnothing\n");
    a.write("src/two.js", "needle\n");
    a.write("build/out.js", "needle\n");
    a.write(".env", "needle=secret\n");
    a.write("dump_1/x.txt", "needle\n");
    a.write("ünï/céé.txt", "é needle\n");
    a.commit_all("files");
    a.write("untracked.txt", "needle in untracked\n");
    b.write("b.txt", "needle\n");
    b.commit_all("b");
    let (files, rec) = files();
    let roots = vec![a.root(), b.root()];

    let id = files.search_start(roots.clone(), "needle", opts()).await.unwrap();
    let batches = rec.wait_done(&id);
    assert_eq!(batches.iter().filter(|b| b.done).count(), 1);
    assert!(batches.last().unwrap().done && batches.iter().all(|b| b.error.is_none() && !b.truncated));
    // Without ripgrep the last batch carries the one-line install hint, and only the last.
    assert!(batches.last().unwrap().notice.as_deref().is_some_and(|n| n.contains("brew install ripgrep")));
    assert!(batches.iter().filter(|b| !b.done).all(|b| b.notice.is_none()));
    let got = summary(&hits(&batches));
    assert_eq!(
        got,
        [
            ("a", "src/one.ts", 1, 7),
            ("a", "src/one.ts", 2, 6),
            ("a", "src/two.js", 1, 1),
            ("a", "untracked.txt", 1, 1),
            ("a", "ünï/céé.txt", 1, 3),
            ("b", "b.txt", 1, 1),
        ]
        .map(|(r, p, l, c)| (r.to_owned(), p.to_owned(), l, c))
    );
    assert_eq!(hits(&batches)[0].preview, "const Needle = 1;");

    // Case sensitivity, regex, glob and the repo filter.
    let run = |q: &'static str, o: SearchOptions| {
        let (files, rec, roots) = (files.clone(), rec.clone(), roots.clone());
        async move {
            let id = files.search_start(roots, q, o).await.unwrap();
            rec.wait_done(&id)
        }
    };
    let sensitive = hits(&run("Needle", SearchOptions { case_sensitive: true, ..opts() }).await);
    assert_eq!(summary(&sensitive), [("a".to_owned(), "src/one.ts".to_owned(), 1, 7)]);
    let regex = hits(&run("^need.e$", SearchOptions { regex: true, ..opts() }).await);
    assert_eq!(regex.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(), ["src/two.js", "b.txt"]);
    let globbed = hits(&run("needle", SearchOptions { glob: Some("*.ts".into()), ..opts() }).await);
    assert!(globbed.iter().all(|h| h.path.ends_with(".ts")) && globbed.len() == 2);
    let nested = hits(&run("needle", SearchOptions { glob: Some("src/**/*.js".into()), ..opts() }).await);
    assert_eq!(nested.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(), ["src/two.js"]);
    let literal = hits(&run("a.b", SearchOptions { regex: false, ..opts() }).await);
    assert!(literal.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_invalid_regex_is_reported_and_an_empty_query_refused() {
    let sb = Sandbox::new();
    let a = sb.repo("a");
    let (files, rec) = files();
    let id = files.search_start(vec![a.root()], "(", SearchOptions { regex: true, ..opts() }).await.unwrap();
    let batches = rec.wait_done(&id);
    let last = batches.last().unwrap();
    assert!(last.done && last.hits.is_empty() && last.error.as_deref().is_some_and(|e| e.starts_with("a:")), "{last:?}");
    assert!(files.search_start(vec![a.root()], "", opts()).await.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_hit_limit_truncates_and_cancel_ends_the_search() {
    let sb = Sandbox::new();
    let a = sb.repo("a");
    a.write("many.txt", "needle\n".repeat(5200));
    a.commit_all("many");
    let (files, rec) = files();

    let id = files.search_start(vec![a.root()], "needle", opts()).await.unwrap();
    let batches = rec.wait_done(&id);
    assert_eq!(hits(&batches).len(), 5000);
    assert!(batches.last().unwrap().truncated);

    let id = files.search_start(vec![a.root()], "needle", opts()).await.unwrap();
    files.search_cancel(&id);
    let batches = rec.wait_done(&id);
    assert!(batches.last().unwrap().done && hits(&batches).len() < 5000);
}
