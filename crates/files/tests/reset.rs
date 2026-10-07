//! `Files::reset` ((design notes: workspaces-spec) 4.10 row 8): a workspace switch drops every watch, the quick-open index and
//! the running searches, and the module keeps working afterwards.

mod common;

use std::time::Duration;

use common::*;
use intely_files::SearchOptions;

fn opts() -> SearchOptions {
    SearchOptions { repo_ids: None, regex: false, case_sensitive: false, glob: None }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reset_leaves_zero_watches_an_empty_index_and_no_search() {
    let sb = Sandbox::new();
    let repo = sb.repo("r1");
    repo.write("a.txt", "needle\n");
    repo.write("b.txt", "needle\n");
    let (files, rec) = files();
    let root = repo.root();

    files.watch_file(&root, "a.txt").unwrap();
    files.watch_file(&root, "b.txt").unwrap();
    files.quick_open_index(&root).await.unwrap();
    let id = files.search_start(vec![root.clone()], "needle", opts()).await.unwrap();
    assert_eq!(files.open_resources(), (2, 1, 1));

    files.reset();
    assert_eq!(files.open_resources(), (0, 0, 0), "nothing is held open after a reset");
    // the cancelled search still finishes (its last batch is `done`) and does not come back
    let batches = rec.wait_done(&id);
    assert!(batches.last().unwrap().done);
    assert_eq!(files.open_resources().2, 0);

    // a dropped watch reports nothing any more
    repo.write("a.txt", "changed behind the editor\n");
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(rec.changes.lock().unwrap().is_empty(), "watchers are gone: {:?}", rec.changes.lock().unwrap());

    // idempotent
    files.reset();
    assert_eq!(files.open_resources(), (0, 0, 0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_module_is_usable_again_after_a_reset() {
    let sb = Sandbox::new();
    let (a, b) = (sb.repo("a"), sb.repo("b"));
    a.write("w.txt", "one\n");
    b.write("needle.txt", "needle\n");
    let (files, rec) = files();
    files.watch_file(&a.root(), "w.txt").unwrap();
    files.quick_open_index(&a.root()).await.unwrap();
    files.reset();

    // the "new workspace": another repo, fresh watches, a fresh index, a search
    files.watch_file(&b.root(), "needle.txt").unwrap();
    let index = files.quick_open_index(&b.root()).await.unwrap();
    assert!(index.iter().any(|f| f == "needle.txt"));
    assert_eq!(files.open_resources(), (1, 1, 0));
    let id = files.search_start(vec![b.root()], "needle", opts()).await.unwrap();
    let batches = rec.wait_done(&id);
    assert!(batches.iter().any(|x| !x.hits.is_empty()), "the search finds the match");
    b.write("needle.txt", "needle changed\n");
    let t = std::time::Instant::now();
    while rec.changes.lock().unwrap().is_empty() {
        assert!(t.elapsed() < Duration::from_secs(10), "the new watch reports changes");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
