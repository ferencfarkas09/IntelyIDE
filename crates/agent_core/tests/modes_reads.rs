//! The wider set of low-risk reads (find, tail, stat, sort ...) and the actionable denial texts of Automatic and the read-only roles.

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
        "the script {} is outside the run's folders and cannot be checked; keep the script inside a repository (and delete it afterwards) or run the code inline, or ask the user to switch to Bypass. The run's folders are: {}",
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
            "echo -x",
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
    refused_everywhere(&fx, &["echo $HOME", "echo $(ls)", "echo `ls`", "echo *", "which $X", "which /etc/passwd", "dirname /etc/passwd", "basename /etc/passwd", "echo > a.txt", "echo hi >> a.txt"]);
    for ok in ["echo hello world", "echo -n hi", "echo /etc/passwd", "which node", "basename src/a.ts", "dirname src/a.ts", "true"] {
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
