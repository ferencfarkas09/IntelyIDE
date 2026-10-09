//! Plan mode and the read-only roles (reviewer, researcher, manager) read code with the commands a developer agent really writes:
//! `sed -n 140,175p file`, `grep -rn "x" src --include=*.js | sort | uniq -c`, `cd repo/src && echo "--- label"; grep ... 2>/dev/null | head`,
//! `ls dir/*`, `git branch --show-current`. Each of them was refused as "not a read-only command" in a recorded run, so the role that exists to
//! read could not read. They must run without a card, and the same shapes pointed at a secret, at something outside the run's folders, or
//! that write a file must still be refused.

mod common;

use common::*;
use intely_agent_core::policy::decide::{Decision, PolicyContext};
use intely_agent_core::providers::PermissionMode;
use std::path::PathBuf;

struct World {
    _dir: tempfile::TempDir,
    root: PathBuf,
    backend: PathBuf,
    admin: PathBuf,
}

fn world() -> World {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let (backend, admin) = (root.join("backend"), root.join("admin"));
    for d in [
        "backend/src/api/models",
        "backend/src/api/services/i18n/catalog",
        "backend/src/api/modules/fleet",
        "backend/scripts",
        "admin/src/localization",
        "admin/src/components/pages/stock/procurement/requisitions",
        "admin/src/components/pages/stock/procurement/reorder-rules",
        "admin/node_modules/x",
    ] {
        std::fs::create_dir_all(root.join(d)).unwrap();
    }
    let w = |rel: &str, text: &str| std::fs::write(root.join(rel), text).unwrap();
    w("backend/package.json", r#"{"name":"b","version":"1.0.0"}"#);
    w("backend/.env", "SECRET=1\n");
    w("backend/src/api/models/customer.model.js", "const a = 1;\nconst link = 'x';\n");
    w("backend/src/api/models/mailbox.model.js", "const b = 2;\n");
    w("backend/src/api/services/i18n/catalog/hu.js", "export default {};\n");
    w("backend/src/api/services/i18n/catalog/en.js", "export default {};\n");
    w("backend/src/api/modules/fleet/index.js", "export const a = 1;\n");
    w("backend/scripts/swagger.mjs", "console.log(1);\n");
    w("admin/src/localization/index.js", "export default {};\n");
    w("admin/src/Router.js", "export default [];\n");
    w("admin/node_modules/x/index.js", "x\n");
    w("outside.txt", "secret\n");
    World { _dir: dir, root, backend, admin }
}

fn read_only(w: &World) -> PolicyContext {
    let mut c = PolicyContext::new(PermissionMode::ReadOnly, &w.backend);
    c.add_dirs = vec![w.admin.clone()];
    c
}

fn edit(w: &World) -> PolicyContext {
    let mut c = PolicyContext::new(PermissionMode::Edit, &w.backend);
    c.add_dirs = vec![w.admin.clone()];
    c
}

fn text(w: &World, cmd: &str) -> String {
    cmd.replace("{backend}", &w.backend.display().to_string()).replace("{admin}", &w.admin.display().to_string()).replace("{root}", &w.root.display().to_string())
}

/// Every command runs without a card in Plan (read-only) and in Edit, as a low-risk read.
fn runs(w: &World, cmds: &[&str]) {
    let mut misses = Vec::new();
    for cmd in cmds {
        let cmd = text(w, cmd);
        for (mode, c) in [("readOnly", read_only(w)), ("edit", edit(w))] {
            let d = bash(&c, &cmd);
            if d.decision != Decision::Allow || d.rule.as_deref() != Some("exec.low-risk-read") {
                misses.push(format!("{mode}: {cmd}\n   -> {:?}/{:?} {}", d.decision, d.rule, d.reason));
            }
        }
    }
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

/// Every command is not a low-risk read (Plan refuses it, Edit asks or stops it).
fn does_not_run(w: &World, cmds: &[&str]) {
    let mut misses = Vec::new();
    for cmd in cmds {
        let cmd = text(w, cmd);
        for (mode, c) in [("readOnly", read_only(w)), ("edit", edit(w))] {
            let d = bash(&c, &cmd);
            if d.decision == Decision::Allow {
                misses.push(format!("{mode}: {cmd}\n   -> {:?}/{:?} {}", d.decision, d.rule, d.reason));
            }
        }
    }
    assert!(misses.is_empty(), "\nwrongly allowed:\n{}", misses.join("\n"));
}

#[test]
fn a_line_range_is_read_with_sed() {
    let w = world();
    runs(
        &w,
        &[
            "sed -n 1,200p src/api/models/customer.model.js",
            "sed -n '140,175p' src/api/models/customer.model.js",
            "sed -n 1,5p package.json; sed -n 2,3p package.json",
            "sed -n '1,5p;8,9p' package.json",
            "sed -n '/^const a/,/^const b/p' src/api/models/customer.model.js",
            "sed -n '$p' package.json",
            "sed -n '2!p' package.json",
            "cat package.json | sed -n 1,147p",
            "sed -n 5p package.json | head -n 1",
            "sed -En '/link/p' src/api/models/customer.model.js",
            "sed -n -e 1,3p -e 5p package.json",
            "sed 's/const/let/' src/api/models/customer.model.js | head",
            "sed -n 's/const \\(a\\)/\\1/p' src/api/models/customer.model.js",
            "sed '/^$/d' package.json",
        ],
    );
}

#[test]
fn sed_that_writes_runs_or_reads_other_files_is_not_a_read() {
    let w = world();
    does_not_run(
        &w,
        &[
            "sed -i s/a/b/ package.json",
            "sed -i '' s/a/b/ package.json",
            "sed --in-place s/a/b/ package.json",
            "sed -n 'w out.txt' package.json",
            "sed -n '1w out.txt' package.json",
            "sed 's/a/b/w out.txt' package.json",
            "sed 's/a/b/e' package.json",
            "sed '1e echo hi' package.json",
            "sed '1r /etc/passwd' package.json",
            "sed 'R /etc/passwd' package.json",
            "sed -f script.sed package.json",
            "sed -n '1p' package.json > out.txt",
            "sed -n '1p' /etc/hosts",
            "sed -n '1p' ../outside.txt",
            "sed -n '1,3{p;w out.txt}' package.json",
            "sed 'a\\ text' package.json",
            "sed 'N;P;D' package.json",
            "sed -s -i s/a/b/ package.json",
            "sed -n",
            "sed",
            "sed -n '' package.json",
            "sed -n '/unterminated p' package.json",
            "sed 's/a/b' package.json",
        ],
    );
}

#[test]
fn awk_prints_columns_but_runs_nothing_and_writes_nothing() {
    let w = world();
    runs(
        &w,
        &[
            "awk '{print $1}' package.json",
            "awk -F: '{print $3}' package.json",
            "awk -F : '{print $1, $NF}' package.json",
            "grep -rn x src | awk -F: '{print $1}' | sort | uniq -c | sort -rn | head",
            "git --no-pager diff --numstat | awk '{print $2, $3, $1}' | sort -rn | head -n 12",
            "awk 'NR>=10 && NR<=20' package.json",
            "awk '/const/ {print NR, $2}' src/api/models/customer.model.js",
            "awk '$1 == \"const\" {print \"x\", $2}' src/api/models/customer.model.js",
            "awk -F'|' '{print $2;}' package.json",
        ],
    );
    does_not_run(
        &w,
        &[
            "awk '{system(\"ls\")}' package.json",
            "awk 'BEGIN{system(\"ls\")}'",
            "awk '{print > \"out.txt\"}' package.json",
            "awk '{print >> \"out.txt\"}' package.json",
            "awk '{print | \"sh\"}' package.json",
            "awk '{print $1} END{system(\"ls\")}' package.json",
            "awk 'BEGIN{while((\"ls\" | getline l) > 0) print l}'",
            "awk '{print $1; system(\"ls\")}' package.json",
            "awk '{print ENVIRON[\"HOME\"]}' package.json",
            "awk '{printf \"%s\", $1 > \"x\"}' package.json",
            "awk -f prog.awk package.json",
            "awk -i inplace '{print}' package.json",
            "awk -v x=1 '{print x}' package.json",
            "awk '{print $1}' ../outside.txt",
            "awk",
            "awk -F:",
            "awk ''",
            "awk '{print $1}",
        ],
    );
}

#[test]
fn searches_with_patterns_options_and_discarded_errors_are_reads() {
    let w = world();
    runs(
        &w,
        &[
            "grep -rn \"foo\" src --include=*.js | grep -v tests | head -30",
            "grep -rln \"needle\" src scripts 2>/dev/null | head -30",
            "grep -r \"link:\" src/api/models/customer.model.js | grep -oE \"link: '[^']+'\" | sort | uniq",
            "grep -rn -A 3 \"/api/v1/fleet|/api/driver\" src | head",
            "grep -rn -m 5 -B2 \"/api/\" src",
            "grep -rniE \"(project|invoice)[A-Za-z]*:\\s*\\{\" src/api/models 2>/dev/null | head -12",
            "grep -rlE \"quote.accepted|quote_accepted\" src 2>/dev/null | head -6",
            "grep -rIil \"nyilvantartasok\\|UTILITY_MODULE_ID\" src --exclude-dir=locales --exclude-dir=i18n | head -30",
            "grep -rn --include=*.js --include=*.ts --exclude-dir=node_modules -E \"MapView|DeliveryMap\" .",
            "grep -n \"link\" src/api/models/customer.model.js src/api/models/mailbox.model.js 2>&1 | head",
            "rg -n -g '*.js' \"const\" src | head",
            "rg -l --type js needle src",
            "rg --files src | head",
            "rg --files -g '*.js' src/api",
            "grep -c \"export\" src/api/services/i18n/catalog/*.js | head -40",
            "grep -rn \"const\" src/api/models/mail*.model.js 2>/dev/null | head -8",
            "grep -rn \"const\" src/api/models/*.model.js | sort | uniq -c | sort -rn | head",
            "wc -l src/api/models/*.js | tail -n 1",
        ],
    );
}

#[test]
fn listings_labels_and_chains_of_reads_run() {
    let w = world();
    runs(
        &w,
        &[
            "ls src/api/modules/fleet src/api/modules/fleet/* | head -80; wc -l package.json scripts/swagger.mjs",
            "ls -la src/api && ls src/api/models/*.js",
            "cd {admin}/src && echo \"--recent/search/palette\"; grep -rlEi \"recentDetailViews|RecentViews\" --include=*.js . 2>/dev/null | grep -v localization | head -12; echo \"--quote->project/invoice\"; ls components/pages/stock 2>/dev/null | head -10",
            "echo --- label ---; cat package.json | head -3; echo \"== done ==\"",
            "cd {admin}/src/localization && sed -n 1,2p index.js; cd ../components/pages/stock/procurement; ls requisitions reorder-rules",
            "cd {admin} && ls src && cat src/Router.js | head -3",
            "find src -name \"*.js\" -not -path \"*/node_modules/*\" | head",
            "find . -path ./node_modules -prune -o -type f -mmin -600 -not -path './.git/*' -print | head -20",
            "find src/api -type f -name \"*.model.js\" | sort | head",
            "cut -d: -f1 package.json | sort -u | head",
            "cat package.json | cut -d/ -f2 | head -3",
            "cat package.json | tr '/' '_' | head -3",
            "cat package.json | tr -d '\\n' | head -c 100",
            "test -f package.json && cat package.json | head -2",
            "[ -d src ] && ls src",
            "cat package.json | tac | rev | head -n 2",
        ],
    );
}

#[test]
fn the_history_is_read_with_git() {
    let w = world();
    runs(
        &w,
        &[
            "git status --short | head -30",
            "git log --oneline -5 && git diff HEAD --stat && git rev-parse HEAD",
            "git branch --show-current",
            "git branch -a",
            "git branch --list 'feat/*'",
            "git remote -v",
            "git remote get-url origin",
            "git stash list",
            "git tag -l 'v1*'",
            "git reflog -25 --date=format:'%m-%d %H:%M'",
            "git reflog show HEAD -n 5",
            "git rev-list --count HEAD",
            "git ls-tree -r HEAD --name-only | head",
            "git shortlog -sn | head",
            "git describe --tags",
            "git cat-file -p HEAD",
            "git for-each-ref --format='%(refname)' refs/heads",
            "git grep -n needle -- src | head",
        ],
    );
    does_not_run(
        &w,
        &[
            "git branch newbranch",
            "git branch -d old",
            "git branch -D old",
            "git branch -m a b",
            "git remote add x https://example.com/r.git",
            "git remote show origin",
            "git remote set-url origin x",
            "git tag v1",
            "git tag -d v1",
            "git stash",
            "git stash pop",
            "git stash drop",
            "git reflog expire --expire=now --all",
            "git reflog delete HEAD@{1}",
            "git config --get remote.origin.url",
            "git fetch",
            "git checkout main",
            "git log --output=out.txt",
            "git show HEAD:.env",
            "git grep --no-index needle /etc",
        ],
    );
}

#[test]
fn a_path_that_points_outside_or_to_a_secret_is_not_a_read_whatever_the_command() {
    let w = world();
    does_not_run(
        &w,
        &[
            "cat .env",
            "cat .e*",
            "cat .en?",
            "cat ../outside.txt",
            "cat ../*",
            "cat /etc/hosts",
            "cat /etc/h*",
            "ls /etc/*",
            "echo /etc/*",
            "grep -rn x ../..",
            "cd {admin}/src && cat ../../outside.txt",
            "cd {admin}/src && cat ../../../*.txt",
            "cd {admin}/src && ls ../../../",
            "cd .. && cat outside.txt",
            "cd .. && ls",
            "cd {root} && cat outside.txt",
            "find / -name x",
            "find .. -name x",
            "cut -d: -f1 /etc/passwd",
            "head -n 3 ../outside.txt",
            "sort ../outside.txt",
            "uniq ../outside.txt",
            "cat src/api/models/customer.model.js ../outside.txt",
            "grep -rn x src ../outside.txt",
            "rg --files /etc",
            "rg --files ../",
            "git cat-file --filters HEAD:package.json",
            "git cat-file --textconv HEAD:package.json",
            "cat package.json 2>../outside.txt",
            "cat package.json < ../outside.txt",
        ],
    );
}

#[test]
fn a_command_that_writes_runs_or_cannot_be_judged_is_not_a_read() {
    let w = world();
    does_not_run(
        &w,
        &[
            "echo hi > out.txt",
            "cat package.json > out.txt",
            "cat package.json >> out.txt",
            "cat package.json 2> out.txt",
            "cat package.json &> out.txt",
            "grep x package.json | tee out.txt",
            "sort -o out.txt package.json",
            "uniq package.json out.txt",
            "tr a b > out.txt",
            "ls; touch x",
            "tail -f package.json",
            "jq . package.json",
            "xargs cat",
            "find . -delete",
            "find . -exec cat {} \\;",
            "cat $(ls)",
            "cat `ls`",
            "echo $HOME",
            "f=package.json; cat $f",
            "FOO=1 cat package.json",
            "cat ~/x",
            "node -e 'console.log(1)'",
            "bash -c 'cat package.json'",
            "cat package.json | bash",
            "printf -v x %s hi",
            "env",
            "cd",
            "cd -",
        ],
    );
}

#[test]
fn what_is_discarded_is_not_a_file_written() {
    let w = world();
    runs(&w, &["grep -rn x src 2>/dev/null", "ls nodir 2>&1 | head", "cat package.json >/dev/null", "cat package.json 2>/dev/null | head -2", "cat package.json | head -n 2 2>&1"]);
    does_not_run(&w, &["cat package.json 2>/dev/nullx", "cat package.json > /dev/sda", "cat package.json > /dev/null.txt"]);
}

#[test]
fn a_glob_that_matches_thousands_of_files_is_judged_as_written() {
    let w = world();
    let many = w.backend.join("many");
    std::fs::create_dir_all(&many).unwrap();
    for i in 0..5100 {
        std::fs::write(many.join(format!("f{i}.txt")), "").unwrap();
    }
    // too many to judge one by one: the read-only modes do not run it, Automatic judges the pattern as written (as before globs were expanded)
    does_not_run(&w, &["cat many/*.txt | head -n 1", "wc -l many/*"]);
    let mut auto = PolicyContext::new(PermissionMode::Automatic, &w.backend);
    auto.add_dirs = vec![w.admin.clone()];
    let d = bash(&auto, "wc -l many/*.txt | tail -n 1");
    assert_eq!(d.decision, Decision::Allow, "{d:?}");
    // a small directory of the same shape is expanded and judged
    runs(&w, &["cat src/api/models/*.js | head -n 1"]);
}
