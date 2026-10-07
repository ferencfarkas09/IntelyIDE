//! Timings on a fixture with a few hundred commits. `cargo test -p intely-graph --test perf -- --ignored --nocapture`.

mod common;

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Instant;

use common::{Repo, Sandbox};
use intely_core::exec::pinned_git_path;
use intely_graph::types::LogFilters;
use intely_graph::Graph;

const MAIN_COMMITS: usize = 600;

/// One `git fast-import` run: a linear `main` that grows `src/big.txt`, with a three-commit feature branch merged every 20 commits.
fn populate(repo: &Repo, commits: usize) {
    let mut s = String::new();
    let mut mark = 0usize;
    let mut file: Vec<String> = Vec::new();
    let mut t = 1_700_000_000i64;
    let mut commit = |s: &mut String, branch: &str, from: Option<usize>, merge: Option<usize>, subject: &str, files: &[(String, String)], t: i64| {
        mark += 1;
        let msg = format!("{subject}\n");
        s.push_str(&format!("commit refs/heads/{branch}\nmark :{mark}\ncommitter Fixture User <fixture@example.invalid> {t} +0000\ndata {}\n{msg}", msg.len()));
        if let Some(f) = from {
            s.push_str(&format!("from :{f}\n"));
        }
        if let Some(m) = merge {
            s.push_str(&format!("merge :{m}\n"));
        }
        for (p, c) in files {
            s.push_str(&format!("M 100644 inline {p}\ndata {}\n{c}\n", c.len()));
        }
        mark
    };
    let mut head: Option<usize> = None;
    for i in 0..commits {
        t += 3600;
        file.push(format!("line {i} added in commit {i}"));
        if i % 7 == 0 && i > 0 {
            let mid = i / 2;
            file[mid] = format!("line {mid} reworked in commit {i}");
        }
        let body = file.join("\n") + "\n";
        head = Some(commit(&mut s, "main", head, None, &format!("feat: step {i}"), &[("src/big.txt".to_owned(), body)], t));
        if i % 20 == 19 {
            let mut tip = head.expect("head");
            for k in 0..3 {
                t += 60;
                tip = commit(&mut s, &format!("topic-{i}"), Some(tip), None, &format!("fix: topic {i} part {k}"), &[(format!("topic/{i}-{k}.txt"), format!("{i}-{k}\n"))], t);
            }
            t += 60;
            let body = file.join("\n") + "\n";
            head = Some(commit(&mut s, "main", head, Some(tip), &format!("Merge topic-{i}"), &[("src/big.txt".to_owned(), body), (format!("topic/{i}-merged.txt"), "merged\n".to_owned())], t));
        }
    }
    s.push_str(&format!("reset refs/heads/main\nfrom :{}\n", head.expect("head")));
    let mut child = Command::new(pinned_git_path())
        .arg("-C")
        .arg(&repo.path)
        .args(["fast-import", "--quiet"])
        .stdin(Stdio::piped())
        .spawn()
        .expect("fast-import");
    child.stdin.take().expect("stdin").write_all(s.as_bytes()).expect("stream");
    assert!(child.wait().expect("wait").success());
    repo.git(&["checkout", "-q", "-f", "main"]);
}

fn ms(t: Instant) -> u128 {
    t.elapsed().as_millis()
}

#[tokio::test]
#[ignore = "timing run"]
async fn timings_on_a_few_hundred_commits() {
    let sb = Sandbox::new();
    let a = sb.repo("alpha");
    let b = sb.repo("beta");
    let t = Instant::now();
    populate(&a, MAIN_COMMITS);
    populate(&b, MAIN_COMMITS);
    eprintln!("fixture: 2 repos with {MAIN_COMMITS} main commits each, built in {} ms", ms(t));
    let total: usize = a.git(&["rev-list", "--all", "--count"]).parse().expect("count");
    eprintln!("alpha has {total} commits in total");

    let env = sb.env(&[&a, &b]);
    let ids = vec!["alpha".to_owned(), "beta".to_owned()];
    let g = Graph::new(None);

    let t = Instant::now();
    let first = g.log_page(&env, &ids, None, &LogFilters::default(), None).await.expect("page");
    eprintln!("log first page: {} rows in {} ms", first.rows.len(), ms(t));
    let t = Instant::now();
    let mut rows = first.rows.len();
    let mut cursor = first.next_cursor;
    let mut pages = 1;
    while let Some(c) = cursor {
        let p = g.log_page(&env, &ids, Some(&c), &LogFilters::default(), None).await.expect("next");
        rows += p.rows.len();
        pages += 1;
        cursor = p.next_cursor;
    }
    eprintln!("log remaining pages: {pages} pages, {rows} rows total in {} ms", ms(t));
    assert!(rows >= total, "every commit of alpha shows up in the merged log");

    let t = Instant::now();
    let filtered = g.log_page(&env, &ids, None, &LogFilters { text: Some("topic 399".into()), ..LogFilters::default() }, None).await.expect("filtered");
    eprintln!("log text filter: {} rows in {} ms", filtered.rows.len(), ms(t));

    let oid = first.rows[0].oid.clone();
    let t = Instant::now();
    let d = g.commit_detail(&env, "alpha", &oid).await.expect("detail");
    eprintln!("commit detail: {} files in {} ms", d.files.len(), ms(t));

    let t = Instant::now();
    let lines = g.blame(&env, "alpha", "src/big.txt", None).await.expect("blame");
    eprintln!("blame cold: {} lines in {} ms", lines.len(), ms(t));
    let t = Instant::now();
    g.blame(&env, "alpha", "src/big.txt", None).await.expect("blame");
    eprintln!("blame cached: {} ms", ms(t));
    let t = Instant::now();
    let caret = g.blame_caret(&env, "alpha", "src/big.txt", 100, None).await.expect("caret");
    eprintln!("blame caret: {:?} in {} ms", caret.author, ms(t));

    let t = Instant::now();
    let h = g.file_history(&env, &"alpha".to_owned(), "src/big.txt").await.expect("history");
    eprintln!("file history: {} rows in {} ms", h.len(), ms(t));

    let t = Instant::now();
    let m = g.branch_matrix(&env, &ids).await.expect("matrix");
    eprintln!("branch matrix: {} branches in {} ms", m.branches.len(), ms(t));
    let t = Instant::now();
    let bundles = g.bundles(&env, &ids, None).await.expect("bundles");
    eprintln!("bundles heuristic: {} in {} ms", bundles.len(), ms(t));
    assert!(!bundles.is_empty(), "identical subjects at identical times in both repos form bundles");

    // JSON of the real engine for the UI contract check (`INTELY_DUMP_DIR=<dir>`).
    if let Ok(dir) = std::env::var("INTELY_DUMP_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).expect("dump dir");
        let put = |name: &str, v: serde_json::Value| std::fs::write(dir.join(name), serde_json::to_string(&v).expect("json")).expect("write");
        let small = g.log_page(&env, &ids, None, &LogFilters::default(), Some(60)).await.expect("small page");
        put("logPage.json", serde_json::to_value(&small).expect("log"));
        put("commitDetail.json", serde_json::to_value(&d).expect("detail"));
        put("blame.json", serde_json::to_value(&*lines).expect("blame"));
        put("blameCaret.json", serde_json::to_value(&caret).expect("caret"));
        put("fileHistory.json", serde_json::to_value(&h).expect("history"));
        put("branchMatrix.json", serde_json::to_value(&m).expect("matrix"));
        put("bundles.json", serde_json::to_value(&bundles).expect("bundles"));
        for i in 0..4 {
            a.commit(&format!("wip: tail {i}"), &[("tail.txt", &format!("{i}\n"))]);
        }
        let onto = a.git(&["rev-parse", "HEAD~3"]);
        let plan = g.rebase_plan(&env, "alpha", &onto).await.expect("plan");
        put("rebasePlan.json", serde_json::to_value(&plan).expect("plan"));
    }

    // rebase and cherry-pick on the big history
    a.git(&["checkout", "-q", "-b", "work", "main"]);
    for i in 0..20 {
        a.commit(&format!("work {i}"), &[(&format!("work/{i}.txt"), "w\n")]);
    }
    let t = Instant::now();
    let mut plan = g.rebase_plan(&env, "alpha", "main").await.expect("plan");
    for (i, step) in plan.steps.iter_mut().enumerate() {
        if i % 2 == 1 {
            step.action = intely_graph::types::RebaseAction::Fixup;
        }
    }
    let out = g.rebase_run(&env, &plan, None).await.expect("rebase run");
    assert_eq!(out.status, intely_graph::types::OpStatus::Done, "{out:?}");
    assert_eq!(a.git(&["rev-list", "--count", "main..work"]), "10");
    eprintln!("rebase of 20 commits (10 fixups): {} ms", ms(t));

    a.git(&["checkout", "-q", "-b", "target", "main~30"]);
    let picks = a.git(&["rev-list", "--reverse", "-n5", "main..work"]).lines().map(str::to_owned).collect::<Vec<_>>();
    let t = Instant::now();
    let out = g.cherry_pick(&env, "alpha", &picks, None).await.expect("cherry-pick");
    assert_eq!(out.status, intely_graph::types::OpStatus::Done, "{out:?}");
    assert_eq!(a.git(&["rev-list", "--count", "main~30..target"]), "5");
    eprintln!("cherry-pick of 5 commits: {} ms", ms(t));
}
