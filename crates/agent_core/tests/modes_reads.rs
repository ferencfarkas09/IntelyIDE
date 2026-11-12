//! The wider set of low-risk reads (find, tail, stat, sort ...) and the actionable denial texts of Automatic and the read-only roles.

#![cfg(unix)]
mod common;

use common::*;
use intely_agent_core::policy::decide::{Decision, PolicyContext};
use intely_agent_core::policy::hardstop::analyze;
use intely_agent_core::policy::paths::Jail;
use intely_agent_core::providers::PermissionMode;

const PLAN: PermissionMode = PermissionMode::ReadOnly;
const AUTO: PermissionMode = PermissionMode::Automatic;

fn low_risk(fx: &Fx, cmd: &str) -> bool {
    let d = bash(&ctx(fx, PLAN), cmd);
    d.decision == Decision::Allow && d.rule.as_deref() == Some("exec.low-risk-read")
}

#[test]
fn the_added_readers_are_low_risk_inside_the_run_folders() {
    let fx = mfx();
    let ok = [
        "tail -n 20 a.txt",
        "stat a.txt",
        "file a.txt",
        "tree -L 2 src",
        "du -sh src",
        "diff a.txt package.json",
        "cmp a.txt package.json",
        "sort a.txt",
        "sort -n -r a.txt",
        "basename src/a.ts",
        "dirname src/a.ts",
        "realpath src",
        "which node",
        "echo hello world",
        "true",
        "find . -name \"*.js\" | head -1",
        "find src -type f -name '*.ts'",
        "find . -maxdepth 2 -type d \\( -name src -o -name sub \\)",
        "find -P . -name a.txt -type f -maxdepth 2",
        "find -H src -type d -not -name sub -print",
        "find . -type f -print0",
        "find",
        "git log --oneline | head -5",
        "git status | wc -l",
        "cat a.txt | sort | head -3",
        "grep -rn foo src | sort | head",
        "find . -name '*.js' | wc -l",
        "ls src | tail -3",
        "cd src && find . -name '*.ts' | head",
    ];
    let misses: Vec<&str> = ok.iter().copied().filter(|c| !low_risk(&fx, c)).collect();
    assert!(misses.is_empty(), "not low-risk: {misses:?}");
}

#[test]
fn the_added_readers_stay_refused_when_they_write_run_or_leave_the_folders() {
    let fx = mfx();
    let bad = [
        "find . -exec rm {} ;",
        "find . -name a.txt -exec cat {} +",
        "find . -execdir ls ;",
        "find . -ok ls ;",
        "find . -okdir ls ;",
        "find . -delete",
        "find . -fprint out.txt",
        "find . -fprint0 out.txt",
        "find . -fprintf out.txt x",
        "find . -fls out.txt",
        "find . -files0-from list",
        "find / -name x",
        "find .. -name x",
        "find /tmp -name x",
        "find .git -name config",
        "find . .env",
        "sort -o out.txt a.txt",
        "sort -ro out.txt a.txt",
        "sort --output=out.txt a.txt",
        "sort --out=out.txt a.txt",
        "sort --compress-program=sh a.txt",
        "sort -T /tmp a.txt",
        "sort .git/config",
        "tree -o out.txt",
        "tree --output out.txt",
        "tail -f a.txt",
        "tail -F a.txt",
        "tail --follow a.txt",
        "file -C",
        "stat /etc/hosts",
        "tail /etc/hosts",
        "du ..",
        "diff a.txt /etc/hosts",
        "realpath ../x",
        "echo x > out.txt",
        "echo $(ls)",
        "echo x | tee out.txt",
        "sort a.txt > out.txt",
        "find . -name a.txt | xargs rm",
        "cat .env | sort",
        "tail .env",
        "stat .git/config",
    ];
    let misses: Vec<&str> = bad.iter().copied().filter(|c| low_risk(&fx, c)).collect();
    assert!(misses.is_empty(), "wrongly low-risk: {misses:?}");
}

#[test]
fn protected_paths_stay_a_hard_stop_for_the_added_writers_of_a_file() {
    let fx = mfx();
    for cmd in ["sort -o .git/config a.txt", "tree -o .git/hooks/pre-commit", "find . -fprint .git/hooks/pre-commit", "find . -delete .git"] {
        let d = bash(&ctx(&fx, AUTO), cmd);
        assert_eq!(d.decision, Decision::Deny, "{cmd}: {d:?}");
        assert_ne!(d.rule.as_deref(), Some("exec.auto"), "{cmd}");
    }
}

fn two_folders() -> (Fx, PolicyContext) {
    let fx = fx();
    let other = tempfile::tempdir().unwrap();
    let other_dir = std::fs::canonicalize(other.path()).unwrap();
    // keep the directory alive for the whole test by leaking the guard (the OS removes it with the temp dir cleanup of the run)
    std::mem::forget(other);
    let mut c = ctx(&fx, AUTO);
    c.add_dirs.push(other_dir);
    (fx, c)
}

#[test]
fn automatic_names_the_run_folders_when_a_read_is_outside_them() {
    let (fx, c) = two_folders();
    let d = decide_tool(&c, "Grep", serde_json::json!({ "pattern": "x", "path": "/var/outside-dir" }));
    assert_eq!(d.decision, Decision::Deny);
    assert_eq!(d.rule.as_deref(), Some("read.auto.outside"));
    let want = format!(
        "/var/outside-dir is outside the run's folders; Automatic reads only inside them. The run's folders are: {}, {}. Search each repository separately, or ask the user to switch to Bypass or to add the folder",
        fx.cwd.display(),
        c.add_dirs[0].display()
    );
    assert_eq!(d.reason.replace("/private/var", "/var"), want.replace("/private/var", "/var"));
}

#[test]
fn the_folder_list_is_capped_at_six_with_a_count_of_the_rest() {
    let fx = fx();
    let mut c = ctx(&fx, AUTO);
    let dirs: Vec<tempfile::TempDir> = (0..8).map(|_| tempfile::tempdir().unwrap()).collect();
    c.add_dirs = dirs.iter().map(|d| std::fs::canonicalize(d.path()).unwrap()).collect();
    let jail = Jail::new(&c.cwd, &c.add_dirs, c.home.as_deref());
    let hint = jail.folders_hint();
    assert!(hint.ends_with(", and 3 more"), "{hint}");
    assert_eq!(hint.matches(", ").count(), 6, "{hint}");
    assert!(hint.starts_with(&fx.cwd.display().to_string()));
    // a short list has no tail
    let one = Jail::new(&fx.cwd, &[], None).folders_hint();
    assert_eq!(one, fx.cwd.display().to_string());
}

#[test]
fn automatic_exec_and_write_outside_the_folders_name_them_too() {
    let (fx, c) = two_folders();
    let hint = Jail::new(&c.cwd, &c.add_dirs, c.home.as_deref()).folders_hint();
    let d = bash(&c, "cat /etc/hosts");
    assert_eq!(d.rule.as_deref(), Some("exec.auto.outside-jail"));
    assert!(d.reason.contains(&format!("The run's folders are: {hint}.")), "{}", d.reason);
    let d = decide_tool(&c, "Write", serde_json::json!({ "file_path": "/var/outside-dir/x.txt", "content": "x" }));
    assert_eq!(d.rule.as_deref(), Some("write.auto.outside"));
    assert!(d.reason.contains(&format!("The run's folders are: {hint}.")), "{}", d.reason);
    let _ = fx;
}

#[test]
fn a_read_only_role_gets_the_folders_and_the_wider_command_list_in_the_denial() {
    let fx = mfx();
    let d = bash(&ctx(&fx, PLAN), "npm test");
    assert_eq!(d.rule.as_deref(), Some("role.read-only"));
    assert!(d.reason.contains("find") && d.reason.contains("tail"), "{}", d.reason);
    assert!(d.reason.ends_with(&format!("The run's folders are: {}", fx.cwd.display())), "{}", d.reason);
    let d = decide_tool(&ctx(&fx, PLAN), "Read", serde_json::json!({ "file_path": "/var/outside-dir/x" }));
    assert_eq!(d.rule.as_deref(), Some("read.outside"));
    assert!(d.reason.contains("The run's folders are:"), "{}", d.reason);
}

#[test]
fn a_script_outside_the_folders_is_named_instead_of_the_misleading_static_check_text() {
    let fx = mfx();
    let outside = tempfile::tempdir().unwrap();
    let script = std::fs::canonicalize(outside.path()).unwrap().join("gen.py");
    std::fs::write(&script, "print(1)\n").unwrap();
    let cmd = format!("python3 {} && node -e \"console.log(1)\"", script.display());
    let a = analyze(&cmd, &Jail::new(&fx.cwd, &[], None));
    assert_eq!(a.outside_scripts, vec![script.display().to_string()]);
    let d = bash(&ctx(&fx, AUTO), &cmd);
    assert_eq!(d.decision, Decision::Deny);
    assert_eq!(d.rule.as_deref(), Some("exec.auto.unjudgeable"));
    let want = format!(
        "the script {} is outside the run's folders and cannot be checked; keep the script inside a repository or in /tmp (and delete it afterwards) or run the code inline, or ask the user to switch to Bypass. The run's folders are: {}",
        script.display(),
        fx.cwd.display()
    );
    assert_eq!(d.reason, want);
    // a real substitution keeps the old wording
    let d = bash(&ctx(&fx, AUTO), "echo $(date)");
    assert!(d.reason.starts_with("this command cannot be checked statically"), "{}", d.reason);
}

#[test]
fn tool_search_only_loads_tool_definitions_and_runs_in_every_mode() {
    let fx = mfx();
    for mode in [PLAN, PermissionMode::Ask, PermissionMode::Edit, AUTO, PermissionMode::Bypass] {
        let d = decide_tool(&ctx(&fx, mode), "ToolSearch", serde_json::json!({ "query": "select:mcp__fx__echo", "max_results": 5 }));
        assert_eq!((d.decision, d.rule.as_deref()), (Decision::Allow, Some("other.tool-search")), "{mode:?}: {d:?}");
    }
    // a role whose tool list does not name it still decides first
    let mut c = ctx(&fx, AUTO);
    c.role_deny = vec!["ToolSearch".into()];
    let d = decide_tool(&c, "ToolSearch", serde_json::json!({ "query": "x" }));
    assert_eq!(d.decision, Decision::Deny, "{d:?}");
}

/// Not a low-risk read in Plan (read-only run) and not allowed without a card in Edit; Automatic is checked where it matters.
fn refused_everywhere(fx: &Fx, cmds: &[&str]) {
    let mut misses = Vec::new();
    for cmd in cmds {
        for mode in [PLAN, PermissionMode::Edit] {
            let d = bash(&ctx(fx, mode), cmd);
            if d.decision == Decision::Allow && d.rule.as_deref() == Some("exec.low-risk-read") {
                misses.push(format!("{mode:?} {cmd}"));
            }
        }
    }
    assert!(misses.is_empty(), "wrongly low-risk: {misses:#?}");
}

#[test]
fn find_leading_options_cannot_hide_a_start_path() {
    let fx = mfx();
    refused_everywhere(
        &fx,
        &[
            "find -E /etc -name x",
            "find -X /usr",
            "find -d /etc",
            "find -s /etc",
            "find -x /etc",
            "find -D tree /etc",
            "find -f /etc -print0",
            "find -f /Users",
            "find -- /etc",
            "find -L /etc",
            "find -L . -name a.txt",
            "find /etc -name x",
            "find . /etc",
            "find -P /etc",
            "find -H / -maxdepth 1",
            "find ~ -name x",
            "find ~root -name x",
        ],
    );
    // the same strings are not run by Automatic either
    for cmd in ["find -E /etc -name x", "find -f /etc -print0", "find -- /etc", "find /etc -name x"] {
        let d = bash(&ctx(&fx, AUTO), cmd);
        assert_ne!(d.rule.as_deref(), Some("exec.auto.unreachable"));
        assert!(!(d.decision == Decision::Allow && d.rule.as_deref() == Some("exec.low-risk-read")), "{cmd}: {d:?}");
    }
}

#[test]
fn find_runs_only_the_listed_side_effect_free_predicates() {
    let fx = mfx();
    refused_everywhere(
        &fx,
        &[
            "find . -newer package.json",
            "find . -anewer package.json",
            "find . -cnewer package.json",
            "find . -samefile a.txt",
            "find . -fstype ext4",
            "find . -ls",
            "find . -exec cat {} +",
            "find . -execdir cat {} +",
            "find . -ok cat {} ;",
            "find . -okdir cat {} ;",
            "find . -delete",
            "find . -fprint o.txt",
            "find . -fprint0 o.txt",
            "find . -fprintf o.txt x",
            "find . -fls o.txt",
            "find . -files0-from list",
            "find . -name a.txt -printf x",
            "find . -newerXY a.txt",
            "find . -name",
            "find . -type f stray",
        ],
    );
}

#[test]
fn sort_takes_only_the_listed_options_not_abbreviations() {
    let fx = mfx();
    refused_everywhere(
        &fx,
        &[
            "sort --ou=a.txt a.txt",
            "sort --o=out a.txt",
            "sort --o=/etc/x a.txt",
            "sort --o=../x a.txt",
            "sort -S 1b --co=sh a.txt",
            "sort --te=/tmp a.txt",
            "sort --tmp=/etc a.txt",
            "sort --output=out a.txt",
            "sort --compress-program=sh a.txt",
            "sort --temporary-directory=/tmp a.txt",
            "sort --files0-from=list",
            "sort -R --random-source=/etc/passwd a.txt",
            "sort -o out a.txt",
            "sort -oout a.txt",
            "sort -nro out a.txt",
            "sort -T /tmp a.txt",
            "sort -T/tmp a.txt",
            "sort --reverse=x a.txt",
            "sort --rev a.txt",
            "sort --numeric a.txt",
        ],
    );
    assert!(low_risk(&fx, "sort -n -r -u a.txt") && low_risk(&fx, "sort -t, -k2,2 -S 1M a.txt") && low_risk(&fx, "sort --numeric-sort --reverse --key=1 a.txt"));
}

#[test]
fn head_and_tail_take_only_the_listed_options() {
    let fx = mfx();
    refused_everywhere(
        &fx,
        &[
            "tail --fo a.txt",
            "tail --f a.txt",
            "tail --follow a.txt",
            "tail --follow=name a.txt",
            "tail -f a.txt",
            "tail -F a.txt",
            "tail -fn1 a.txt",
            "tail -nf a.txt",
            "tail -n1f a.txt",
            "tail --pid=1 a.txt",
            "tail --retry a.txt",
            "tail --line=3 a.txt",
            "tail --lines 3 a.txt",
            "tail -s 1 a.txt",
            "head --pid=1 a.txt",
            "head --li=3 a.txt",
            "head -z a.txt",
            "head -n x a.txt",
            "head -n a.txt",
        ],
    );
    for ok in ["tail -n 5 a.txt", "tail -n5 a.txt", "tail -n +2 a.txt", "tail -c 10 a.txt", "tail -5 a.txt", "tail -qv a.txt", "tail --lines=5 a.txt", "head --bytes=5 --quiet a.txt", "head -1 a.txt"] {
        assert!(low_risk(&fx, ok), "{ok}");
    }
}

#[test]
fn attached_option_values_that_read_files_are_refused() {
    let fx = mfx();
    refused_everywhere(
        &fx,
        &[
            "file --files-from=/etc/passwd",
            "file --fil=/etc/passwd",
            "file -f/etc/passwd",
            "file -f /etc/passwd",
            "file -C",
            "file -m /etc/magic a.txt",
            "file -L a.txt",
            "du --files0-from=/etc/passwd",
            "du --files0 /etc/passwd",
            "du -X /etc/passwd",
            "du --exclude-from=/etc/passwd .",
            "diff --from-file=/etc/passwd a.txt",
            "diff --to-file=/etc/passwd a.txt",
            "diff --from-file /etc/passwd a.txt",
            "diff -o x a.txt a.txt",
            "tree --fromfile=/etc/passwd",
            "tree --fromfile /etc/passwd",
            "tree -o x",
            "tree --output=x",
            "stat -f/etc/passwd",
            "stat --file-system /etc",
            "stat /etc/passwd",
            "realpath --relative-to=/etc .",
            "realpath --relative-base=/etc .",
            "wc --files0-from=/etc/passwd",
            "wc --files0 /etc/passwd",
            "cmp -i 1 a.txt /etc/passwd",
            "which -p /etc/passwd",
            "basename --suffix=x a.txt",
            "cat --files0 a.txt < /etc/passwd",
        ],
    );
    for ok in ["file -b --mime-type a.txt", "du -sh -d 1 .", "du --max-depth=1 src", "diff -ur a.txt package.json", "diff --unified=3 a.txt package.json", "tree -L 2 -I node_modules src", "stat -c %s a.txt", "wc -l a.txt", "realpath -e src"] {
        assert!(low_risk(&fx, ok), "{ok}");
    }
}

#[test]
fn grep_and_rg_pattern_files_are_judged_or_refused() {
    let fx = mfx();
    refused_everywhere(
        &fx,
        &[
            "grep --file=/etc/passwd a.txt",
            "grep --fil=/etc/passwd a.txt",
            "grep --f=/etc/passwd a.txt",
            "grep -f /etc/passwd a.txt",
            "grep -f/etc/passwd a.txt",
            "grep -rnf /etc/passwd .",
            "grep -rf /etc/passwd .",
            "rg --file=/etc/passwd .",
            "rg --fil=/etc/passwd .",
            "rg -f /etc/passwd .",
            "rg -f.env .",
            "rg --ignore-file=/etc/passwd x",
            "grep --exclude-from=/etc/passwd x .",
            "egrep -f /etc/passwd a.txt",
            "fgrep --file=.env a.txt",
        ],
    );
    assert!(low_risk(&fx, "grep -rn --include=*.ts foo src") || !low_risk(&fx, "grep -rn --include=*.ts foo src"));
    assert!(low_risk(&fx, "grep -rn foo src") && low_risk(&fx, "rg -n --files-with-matches foo src"));
}

#[test]
fn input_redirects_are_judged_like_operands() {
    let fx = mfx();
    refused_everywhere(
        &fx,
        &[
            "sort < /etc/passwd",
            "tail < /etc/passwd",
            "cat < /etc/passwd",
            "cat < ../outside.txt",
            "head -1 < ~/.ssh/id_rsa",
            "wc -l < /etc/passwd",
            "cat < .env",
            "cat < .git/config",
            "sort a.txt < /etc/hosts",
            "grep x < /etc/passwd",
            "echo hi < /etc/passwd",
            "cat <$F",
        ],
    );
    assert!(low_risk(&fx, "cat < a.txt") && low_risk(&fx, "sort < a.txt | head -2"));
}

#[test]
fn a_word_starting_with_a_tilde_is_never_a_low_risk_operand() {
    let fx = mfx();
    refused_everywhere(&fx, &["echo ~", "echo ~root", "which ~/x", "du ~", "du -sh ~/Library", "basename ~/x", "dirname ~", "ls ~", "cat ~/.ssh/id_rsa", "true ~", "stat ~root", "find ~ -name x"]);
}

#[test]
fn echo_which_basename_and_dirname_stay_plain() {
    let fx = mfx();
    refused_everywhere(&fx, &["echo $HOME", "echo $(ls)", "echo `ls`", "echo /etc/*", "which $X", "which /etc/passwd", "dirname /etc/passwd", "basename /etc/passwd", "echo > a.txt", "echo hi >> a.txt"]);
    // the text of echo is never a file: a label that starts with dashes is printed like any other word
    for ok in ["echo hello world", "echo -n hi", "echo /etc/passwd", "echo --- label ---", "echo \"--recent/search/palette\"", "echo -x", "which node", "basename src/a.ts", "dirname src/a.ts", "true", "echo *"] {
        assert!(low_risk(&fx, ok), "{ok}");
    }
}

fn linked() -> Fx {
    let fx = mfx();
    std::os::unix::fs::symlink("/etc", fx.cwd.join("lnk")).unwrap();
    std::os::unix::fs::symlink("/etc/hosts", fx.cwd.join("hostsln")).unwrap();
    std::os::unix::fs::symlink("src", fx.cwd.join("inlink")).unwrap();
    std::os::unix::fs::symlink("a.txt", fx.cwd.join("inf")).unwrap();
    fx
}

#[test]
fn automatic_does_not_follow_a_symlink_out_of_the_run_folders() {
    let fx = linked();
    for cmd in ["cat lnk/hosts", "tail -n1 hostsln", "tail -n1 lnk/hosts", "stat -L lnk/hosts", "diff -r . lnk", "cd lnk && ls", "grep root lnk/passwd", "cat --number=lnk/hosts a.txt", "cp lnk/hosts x.txt", "echo hi > hostsln"] {
        let d = bash(&ctx(&fx, AUTO), cmd);
        assert!(d.decision == Decision::Deny && d.rule.as_deref() == Some("exec.auto.outside-jail"), "{cmd}: {d:?}");
        assert!(d.reason.contains("is outside the run's folders") && d.reason.contains("The run's folders are:"), "{cmd}: {}", d.reason);
    }
    refused_everywhere(&fx, &["cat lnk/hosts", "tail -n1 hostsln", "stat -L lnk/hosts", "diff -r . lnk", "cd lnk && ls", "ls lnk", "find lnk -name hosts"]);
    // a link that stays inside the folder and a file that does not exist yet keep working
    for cmd in ["cat inf", "ls inlink", "cat inlink/a.ts", "touch new-file.txt", "echo x > fresh.txt", "mkdir -p brand/new/dir"] {
        let d = bash(&ctx(&fx, AUTO), cmd);
        assert!(d.decision == Decision::Allow, "{cmd}: {d:?}");
    }
    assert!(low_risk(&fx, "cat inf") && low_risk(&fx, "ls inlink"));
}

#[test]
fn recursive_search_that_follows_symlinks_is_not_low_risk() {
    let fx = linked();
    refused_everywhere(
        &fx,
        &[
            "grep -R x .",
            "grep -Rn x .",
            "grep -nR x .",
            "grep --dereference-recursive x .",
            "grep --dereference-rec x .",
            "grep --de x .",
            "egrep -R x .",
            "fgrep -R x .",
            "rg -L x .",
            "rg -nL x .",
            "rg -Ln x .",
            "rg --follow x .",
            "rg --fol x .",
            "rg --fo x .",
            "rg --pr=sh x",
            "rg --pre=sh x",
            "rg --pre-glob=x x",
            "rg --pre-g=x x",
        ],
    );
    for ok in ["grep -r x .", "grep -rn x src", "grep -L x a.txt", "rg x .", "rg -n x src"] {
        assert!(low_risk(&fx, ok), "{ok}");
    }
}

/// The owner's agents were refused the Claude memory notes of the project they work in (`~/.claude/projects/<folder>/memory/*.md`) as
/// "Claude Code user data". Those notes, and only those, are readable; the rest of `~/.claude` and every write stay refused.
#[test]
fn a_run_may_read_the_claude_memory_notes_of_its_own_folders_and_nothing_else_of_dot_claude() {
    use intely_agent_core::policy::paths::claude_project_slug;
    use serde_json::json;
    use std::path::Path;

    let fx = mfx();
    let home = fx.cwd.join("home");
    let projects = home.join(".claude").join("projects");
    let memory = projects.join(claude_project_slug(&fx.cwd)).join("memory");
    let other = projects.join(claude_project_slug(Path::new("/somewhere/else"))).join("memory");
    for d in [&memory, &other, &memory.join("sub"), &home.join(".claude").join("plans")] {
        std::fs::create_dir_all(d).unwrap();
    }
    for p in [memory.join("topic.md"), memory.join("MEMORY.md"), memory.join("notes.jsonl"), memory.join(".hidden.md"), memory.join("sub").join("a.md"), other.join("topic.md"), projects.join(claude_project_slug(&fx.cwd)).join("session.jsonl"), home.join(".claude").join("settings.json"), home.join(".claude").join(".credentials.json"), home.join(".claude").join("plans").join("p.md")] {
        std::fs::write(p, "x").unwrap();
    }
    std::os::unix::fs::symlink(home.join(".claude").join("settings.json"), memory.join("link.md")).unwrap();

    let all = [PermissionMode::ReadOnly, PermissionMode::Ask, PermissionMode::Edit, PermissionMode::Automatic, PermissionMode::Bypass];
    let read = |mode: PermissionMode, p: &Path| decide_tool(&ctx(&fx, mode), "Read", json!({ "file_path": p }));
    for mode in all {
        for p in [memory.join("topic.md"), memory.join("MEMORY.md")] {
            let d = read(mode, &p);
            assert_eq!((d.decision, d.rule.as_deref()), (Decision::Allow, Some("read.memory-note")), "{mode:?} {p:?}");
        }
        // a note by name, for the search tool as well
        let d = decide_tool(&ctx(&fx, mode), "Grep", json!({ "pattern": "x", "path": memory.join("topic.md") }));
        assert_eq!((d.decision, d.rule.as_deref()), (Decision::Allow, Some("read.memory-note")), "{mode:?} Grep of a note");
        // the folder itself is listed, not searched: a search would go into subfolders and other kinds of file
        for tool in [("Glob", json!({ "pattern": "*.md", "path": memory })), ("LS", json!({ "path": memory }))] {
            let d = decide_tool(&ctx(&fx, mode), tool.0, tool.1);
            assert_eq!((d.decision, d.rule.as_deref()), (Decision::Allow, Some("read.memory-note")), "{mode:?} {}", tool.0);
        }
        for tool in [("Grep", json!({ "pattern": "x", "path": memory })), ("Read", json!({ "file_path": memory }))] {
            let d = decide_tool(&ctx(&fx, mode), tool.0, tool.1);
            assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("read.never-read")), "{mode:?} {} of the folder", tool.0);
        }
    }

    // what stays on the never-read list, in every mode
    let never = [
        memory.join("notes.jsonl"),                                   // a transcript-like file
        memory.join(".hidden.md"),                                    // a hidden file
        memory.join("sub").join("a.md"),                              // a subfolder of the notes
        memory.join("link.md"),                                       // a link that leads out: judged by where it leads
        memory.join("..").join("session.jsonl"),                      // `..` out of the notes folder
        memory.join("..").join("..").join(claude_project_slug(Path::new("/somewhere/else"))).join("memory").join("topic.md"),
        other.join("topic.md"),                                       // the notes of a project this run does not work in
        projects.join(claude_project_slug(&fx.cwd)).join("session.jsonl"),
        home.join(".claude").join("settings.json"),
        home.join(".claude").join(".credentials.json"),
        home.join(".claude").join("plans").join("p.md"),
    ];
    for mode in all {
        for p in &never {
            let d = read(mode, p);
            assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("read.never-read")), "{mode:?} {p:?}");
        }
    }
    // a read that names one note and one forbidden file is judged as a whole
    let both = decide_tool(&ctx(&fx, AUTO), "Read", json!({ "file_path": memory.join("topic.md").join("..").join("notes.jsonl") }));
    assert_eq!(both.decision, Decision::Deny);

    // nothing under `~/.claude` becomes writable, and a shell command that reads a note is still judged by the shell rules
    for mode in all {
        for tool in ["Write", "Edit"] {
            let d = decide_tool(&ctx(&fx, mode), tool, json!({ "file_path": memory.join("topic.md"), "content": "x", "old_string": "x", "new_string": "y" }));
            assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("fs.protected")), "{mode:?} {tool}");
        }
    }
    // (a program that only prints a note may read it in the modes that let a command read: the owner's runs were refused
    // `cd <memory> && ls && cat MEMORY.md`, see `a_shell_command_may_list_and_print_the_claude_memory_notes_...` below)
    let d = bash(&ctx(&fx, PermissionMode::Automatic), &format!("cat {}", memory.join("topic.md").display()));
    assert_eq!(d.decision, Decision::Allow, "Automatic: a program that only prints a note may read it: {:?}", d.reason);
}

/// The home folder of these tests is OUTSIDE the run's folder (the fixture's `home` is inside it, which hides every boundary of Automatic).
struct MemFx {
    fx: Fx,
    home: tempfile::TempDir,
    claude: std::path::PathBuf,
    projects: std::path::PathBuf,
    project: std::path::PathBuf,
    memory: std::path::PathBuf,
    other: std::path::PathBuf,
}

fn mem_fx() -> MemFx {
    use intely_agent_core::policy::paths::claude_project_slug;
    use std::path::Path;
    let fx = mfx();
    let home = tempfile::tempdir().unwrap();
    let claude = std::fs::canonicalize(home.path()).unwrap().join(".claude");
    let projects = claude.join("projects");
    let project = projects.join(claude_project_slug(&fx.cwd));
    let memory = project.join("memory");
    let other = projects.join(claude_project_slug(Path::new("/somewhere/else"))).join("memory");
    for d in [&memory, &other, &memory.join("sub"), &memory.join("dir.md"), &claude.join("plans")] {
        std::fs::create_dir_all(d).unwrap();
    }
    for p in [
        memory.join("topic.md"),
        memory.join("MEMORY.md"),
        memory.join("notes.jsonl"),
        memory.join(".hidden.md"),
        memory.join("sub").join("a.md"),
        other.join("topic.md"),
        project.join("session.jsonl"),
        claude.join("settings.json"),
        claude.join(".credentials.json"),
    ] {
        std::fs::write(p, "x").unwrap();
    }
    std::os::unix::fs::symlink(claude.join("settings.json"), memory.join("link.md")).unwrap();
    // links a cloned repository could ship, named like a count or a program
    for (name, to) in [("21", claude.join("settings.json")), ("5", claude.join(".credentials.json"))] {
        std::os::unix::fs::symlink(to, fx.cwd.join(name)).unwrap();
    }
    std::fs::create_dir_all(fx.cwd.join("bin")).unwrap();
    for exe in [fx.cwd.join("cat"), fx.cwd.join("ls"), fx.cwd.join("bin").join("cat")] {
        std::fs::write(&exe, "#!/bin/sh\ncat \"$1\"/../../settings.json\n").unwrap();
        std::os::unix::fs::PermissionsExt::set_mode(&mut std::fs::metadata(&exe).unwrap().permissions(), 0o755);
    }
    MemFx { fx, home, claude, projects, project, memory, other }
}

fn mem_ctx(m: &MemFx, mode: PermissionMode) -> PolicyContext {
    let mut c = ctx(&m.fx, mode);
    c.home = Some(std::fs::canonicalize(m.home.path()).unwrap());
    c
}

/// The owner's run in the repository `admin` was refused `cd ~/.claude/projects/<folder>/memory && ls -la ... && cat MEMORY.md` ("a secret or
/// IDE-state path"), although the dedicated tools may read those notes. The shell may do it too, but only with a program that lists names or
/// prints the files it is given and no option that recurses, searches, follows or writes; the rest of `~/.claude` stays refused.
#[test]
fn a_shell_command_may_list_and_print_the_claude_memory_notes_of_its_own_folders_and_nothing_else_of_dot_claude() {
    use serde_json::json;

    let m = mem_fx();
    let all = [PermissionMode::ReadOnly, PermissionMode::Ask, PermissionMode::Edit, PermissionMode::Automatic, PermissionMode::Bypass];
    let run = |mode: PermissionMode, cmd: &str| decide_tool(&mem_ctx(&m, mode), "Bash", json!({ "command": cmd }));
    let (mem, o, pr, cl) = (m.memory.display(), m.other.display(), m.project.display(), m.claude.display());
    let _ = &m.projects;

    // what a program that only lists names or prints a note may do: never the never-read hard stop, in any mode
    let allowed = [
        format!("cd {mem}"),
        format!("cd {mem} && ls -la"),
        format!("ls -la {mem}"),
        format!("ls -1 {mem}/"),
        format!("cat {mem}/MEMORY.md"),
        format!("cat {mem}/topic*.md"),
        format!("head -n 20 {mem}/topic.md"),
        format!("tail -20 {mem}/topic.md"),
        format!("tail -n 5 {mem}/topic.md"),
        format!("wc -l {mem}/topic.md"),
        format!("stat {mem}/topic.md"),
        format!("cd {mem} && cat MEMORY.md"),
        format!("cd {mem} && head -n 3 MEMORY.md"),
        // the command of the report
        format!("cd {mem} && ls -la {mem} && cat MEMORY.md"),
        format!("ls -la {mem} && cat {mem}/MEMORY.md"),
    ];
    for cmd in &allowed {
        for mode in all {
            let d = run(mode, cmd);
            assert_ne!(d.rule.as_deref(), Some("read.never-read"), "{mode:?} {cmd}: {:?}", d.reason);
            // the one thing a run without any folder boundary or with Automatic's must do: let it through
            if matches!(mode, PermissionMode::Bypass | PermissionMode::Automatic) {
                assert_eq!(d.decision, Decision::Allow, "{mode:?} {cmd}: {:?} {:?}", d.rule, d.reason);
            }
            // the modes that ask or keep a boundary never refuse it as a secret: they ask, or refuse for the folder boundary
            if matches!(mode, PermissionMode::Ask | PermissionMode::Edit) {
                assert!(matches!(d.decision, Decision::Allow | Decision::Ask), "{mode:?} {cmd}: {:?} {:?} {:?}", d.decision, d.rule, d.reason);
            }
        }
    }

    // what stays on the never-read list, in every mode
    let refused = [
        format!("cd {o}"),                                  // the notes of a project this run does not work in
        format!("ls {o}"),
        format!("cat {o}/topic.md"),
        format!("ls {pr}"),                                 // the project folder (transcripts) around the notes
        format!("cat {pr}/session.jsonl"),
        format!("ls {cl}"),
        format!("cat {cl}/settings.json"),
        format!("cat {cl}/.credentials.json"),
        format!("cat {mem}/notes.jsonl"),                   // not a note
        format!("cat {mem}/.hidden.md"),                    // hidden
        format!("cat {mem}/sub/a.md"),                      // a subfolder of the notes
        format!("ls {mem}/sub"),
        format!("ls {mem}/dir.md"),                         // a folder called like a note is no note
        format!("cat {mem}/dir.md"),
        format!("cat {mem}/link.md"),                       // a link that leads out: judged by where it leads
        format!("cat {mem}/../settings.json"),              // `..` out of the notes folder
        format!("cat {mem}/../session.jsonl"),
        format!("cd {mem} && cat ../settings.json"),
        format!("cd {mem}/.. && ls"),
        format!("ls -R {mem}"),                             // an option that recurses
        format!("tail -f {mem}/topic.md"),                  // an option that follows a growing file
        format!("less -o /tmp/log {mem}/topic.md"),         // an option that writes
        format!("less -N {mem}/topic.md"),                  // no option at all for the pager
        format!("stat -f {mem}/topic.md"),
        format!("grep -r x {mem}"),                         // programs that search
        format!("grep x {mem}/topic.md"),
        format!("rg x {mem}"),
        format!("find {mem} -name '*.md'"),
        format!("sed -n 1p {mem}/topic.md"),
        format!("awk 1 {mem}/topic.md"),
        format!("python3 -c \"print(open('{mem}/topic.md').read())\""), // a program that opens it by a name in its own code
        format!("cd {mem} && grep -r x ."),
        format!("cat {mem}/topic.md {cl}/settings.json"),   // one allowed note next to a refused file
        // a link a cloned repository ships, named like a count: judged by where it leads, as every operand is
        "cat 21".to_string(),
        "cat 5 6".to_string(),
        "head -n 5 21".to_string(),
        "tail -n 5 21".to_string(),
        "wc -l 21".to_string(),
        "cat -n 21".to_string(),
        "ls 21".to_string(),
        // a program of the repository that is called like a reader
        format!("./cat {mem}/MEMORY.md"),
        format!("bin/cat {mem}/MEMORY.md"),
        format!("./ls {mem}"),
        format!("{}/cat {mem}/MEMORY.md", m.fx.cwd.display()),
    ];
    for cmd in &refused {
        for mode in all {
            let d = run(mode, cmd);
            assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("read.never-read")), "{mode:?} {cmd}: {:?}", d.reason);
        }
    }

    // `cd <memory>` is allowed, but from then on every program but the readers (and the printers) is refused while the walker is in the folder:
    // they would run there without naming a path. Same verdict in every mode, Bypass included.
    let in_folder = [
        format!("cd {mem} && ls | xargs rm"),
        format!("cd {mem} && ls -la | xargs rm -r"),
        format!("cd {mem} && cat MEMORY.md | xargs rm"),
        format!("cd {mem} && ls | xargs mv"),
        format!("cd {mem} && ls | xargs chmod 777"),
        format!("cd {mem} && ls | xargs touch"),
        format!("cd {mem} && sudo --chdir . rm MEMORY.md"),
        format!("cd {mem} && grep -r x"),
        format!("cd {mem} && rg x"),
        format!("cd {mem} && rg --hidden x"),
        format!("cd {mem} && rg --files"),
        format!("cd {mem} && find"),
        format!("cd {mem} && fd"),
        format!("cd {mem} && ls -R"),
        format!("cd {mem} && du -a"),
        format!("cd {mem} && tree -a"),
        format!("cd {mem} && sort"),
        format!("cd {mem} && python3 -c 'print(1)'"),
        format!("cd {mem} && env rm MEMORY.md"),
        format!("cd {mem} && rm MEMORY.md"),
        format!("cd {mem} && less '+!rm MEMORY.md' MEMORY.md"),
        format!("(cd {mem}; ls | xargs rm)"),
        format!("true && cd {mem} && ls | xargs rm"),
    ];
    for cmd in &in_folder {
        for mode in all {
            let d = run(mode, cmd);
            assert_eq!(d.decision, Decision::Deny, "{mode:?} {cmd}: {:?} {:?}", d.rule, d.reason);
        }
    }
    // a reader prints the path it was given: the writer behind the pipe must not take it from stdin; and the readers' own loaders
    let piped = [
        format!("ls {mem}/MEMORY.md | xargs rm"),
        format!("ls -d {mem}/topic.md | xargs rm"),
        format!("ls {mem}/topic.md {mem}/MEMORY.md | xargs rm"),
        format!("ls {mem}/topic.md | xargs sed -i s/x/y/"),
        format!("ls -d {mem} | xargs rm -r"),
        format!("wc -c {mem}/topic.md | xargs rm"),
        format!("head -n1 {mem}/topic.md {mem}/MEMORY.md | xargs rm"),
        format!("stat {mem}/topic.md | xargs rm"),
        format!("file {mem}/topic.md | xargs rm"),
        format!("ls {mem}/topic.md | parallel rm"),
        format!("LESSOPEN='|rm %s' less {mem}/topic.md"),
        format!("MAGIC=/etc/passwd file {mem}/topic.md"),
    ];
    for cmd in &piped {
        for mode in all {
            let d = run(mode, cmd);
            assert_eq!(d.decision, Decision::Deny, "{mode:?} {cmd}: {:?} {:?}", d.rule, d.reason);
        }
    }
    // printers are fine between the readers
    for cmd in [format!("cd {mem} && ls -la && echo ---- && cat MEMORY.md"), format!("cd {mem} && pwd && cat MEMORY.md")] {
        for mode in [PermissionMode::Automatic, PermissionMode::Bypass] {
            let d = run(mode, &cmd);
            assert_eq!(d.decision, Decision::Allow, "{mode:?} {cmd}: {:?} {:?}", d.rule, d.reason);
        }
    }

    // a wrapper or an option value that names the folder, after a read of the same note: the read must not clear the way for the write.
    // Automatic keeps its folder boundary (`exec.auto.outside-jail`) for what is not a plain read; the lower modes ask or refuse.
    // (Bypass has no folder boundary and let `env -C ~/.claude touch x` through before this change as well: not decided here.)
    let wrapped = [
        format!("env -C {mem} rm MEMORY.md"),
        format!("echo x | env -C {mem} tee MEMORY.md"),
        format!("env --chdir={mem} touch x.md"),
        format!("env -C {mem} sed -i s/x/y/ topic.md"),
        format!("env -C {mem} mv topic.md MEMORY.md"),
        format!("env -C {mem} mkdir newdir"),
        format!("sudo -D {mem} rm MEMORY.md"),
        format!("env time -o {mem}/new.md ls"),
        format!("time -o {mem}/new.md ls"),
        format!("ls {mem} && env -C {mem} rm MEMORY.md"),
        format!("ls {mem}; sudo --chdir {mem} rm MEMORY.md"),
        format!("ls {mem}; sudo -R {mem} rm MEMORY.md"),
        format!("cat {mem}/MEMORY.md; time --output {mem}/MEMORY.md ls"),
        format!("cat {mem}/MEMORY.md; env time --output {mem}/MEMORY.md ls"),
        format!("cat {mem}/MEMORY.md; command time --output {mem}/MEMORY.md ls"),
        format!("cat {mem}/MEM*; time -o {mem}/MEM* ls"),
        format!("cat {mem}/MEMORY.m?; time -o {mem}/MEMORY.m? ls"),
        format!("git -C {mem} status"),
    ];
    for cmd in &wrapped {
        for mode in [PermissionMode::ReadOnly, PermissionMode::Ask, PermissionMode::Edit] {
            let d = run(mode, cmd);
            assert_ne!(d.decision, Decision::Allow, "{mode:?} {cmd}: {:?} {:?}", d.rule, d.reason);
        }
        let d = run(PermissionMode::Automatic, cmd);
        assert_eq!(d.decision, Decision::Deny, "Automatic {cmd}: {:?} {:?}", d.rule, d.reason);
        assert!(matches!(d.rule.as_deref(), Some("exec.auto.outside-jail" | "read.never-read")), "Automatic {cmd}: {:?} {:?}", d.rule, d.reason);
    }
    // the same line with the writer relative to the folder
    for cmd in [format!("cd {mem} && cat MEM*; time -o MEM* ls")] {
        for mode in [PermissionMode::Automatic, PermissionMode::Bypass] {
            let d = run(mode, &cmd);
            assert_eq!(d.decision, Decision::Deny, "{mode:?} {cmd}: {:?} {:?}", d.rule, d.reason);
        }
    }
}

/// Reading the notes from the shell does not make `~/.claude` writable: every way a command may write into the notes folder stays refused.
#[test]
fn a_shell_command_still_cannot_write_into_the_claude_memory_folder() {
    use serde_json::json;

    let m = mem_fx();
    let mem = m.memory.display();
    let all = [PermissionMode::ReadOnly, PermissionMode::Ask, PermissionMode::Edit, PermissionMode::Automatic, PermissionMode::Bypass];
    for cmd in [
        format!("echo x >> {mem}/MEMORY.md"),
        format!("echo x > {mem}/new.md"),
        format!("cat {mem}/topic.md > {mem}/copy.md"),
        format!("cat {mem}/topic.md | tee {mem}/MEMORY.md"),
        format!("cd {mem} && echo x >> MEMORY.md"),
        format!("rm {mem}/topic.md"),
        format!("mv {mem}/topic.md {mem}/old.md"),
        format!("cp {mem}/topic.md {mem}/copy.md"),
        format!("touch {mem}/x.md"),
        format!("sed -i s/x/y/ {mem}/topic.md"),
        format!("ls -la {mem} && rm {mem}/MEMORY.md"),
    ] {
        for mode in all {
            let d = decide_tool(&mem_ctx(&m, mode), "Bash", json!({ "command": cmd }));
            assert_eq!(d.decision, Decision::Deny, "{mode:?} {cmd}: {:?} {:?}", d.rule, d.reason);
        }
    }
    // and the file is untouched
    assert_eq!(std::fs::read_to_string(m.memory.join("MEMORY.md")).unwrap(), "x");
}
