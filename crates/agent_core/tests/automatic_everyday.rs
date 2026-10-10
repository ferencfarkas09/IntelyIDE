//! Automatic mode and the commands a developer agent really writes (permission-modes spec 2.2, rows `exec.auto.*`).
//!
//! A run over several repositories uses `cd <repo>/<dir> && ...; cd ..; grep ... ../../x`, `grep "/api/" file`, `sed -n '/^a/,/^b/p' f`,
//! `f=file; git status $f`, `for f in a b; do ...; done`, a Python or Node heredoc that edits a file, and a helper script kept in `/tmp`.
//! Each of them was refused with "outside the run's folders" or "not known statically" although every path stays inside the run's folders
//! and every value is written in the command itself. They must run, and the same shapes pointed at something outside must still be refused.

mod common;

use common::*;
use intely_agent_core::events::types::DecidedBy;
use intely_agent_core::policy::decide::{Decision, PolicyContext};
use intely_agent_core::providers::PermissionMode;
use std::path::PathBuf;

/// Three repositories side by side, a scratch folder, and files outside the run's folders.
struct World {
    _dir: tempfile::TempDir,
    root: PathBuf,
    backend: PathBuf,
    admin: PathBuf,
    mobile: PathBuf,
    scratch: PathBuf,
}

fn world() -> World {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let (backend, admin, mobile, scratch) = (root.join("backend"), root.join("admin"), root.join("mobile"), root.join("scratch"));
    for d in [
        "backend/src/api/models",
        "backend/src/api/controllers",
        "backend/src/api/tests",
        "backend/scripts",
        "admin/src/localization/modules/crm",
        "admin/src/components/pages/stock/procurement/requisitions",
        "admin/src/components/pages/stock/procurement/reorder-rules",
        "admin/src/components/pages/stock/components/table",
        "admin/src/config/pages",
        "mobile/app/helpers",
        "mobile/app/screens",
        "scratch",
        "userdir",
    ] {
        std::fs::create_dir_all(root.join(d)).unwrap();
    }
    let w = |rel: &str, text: &str| std::fs::write(root.join(rel), text).unwrap();
    w("backend/package.json", r#"{"scripts":{"build:swagger":"node scripts/swagger.mjs"}}"#);
    w("backend/src/api/models/customer.model.js", "const a = 1;\n");
    w("backend/src/api/models/ingredient.model.js", "const a = 1;\n");
    w("backend/scripts/swagger.mjs", "console.log('swagger');\n");
    w("admin/src/localization/index.js", "export default {};\n");
    w("admin/src/Router.js", "export default [];\n");
    w("admin/src/components/pages/stock/components/table/index.js", "import x from 'y';\n");
    w("admin/src/config/pages/admin.js", "export default [];\n");
    w("mobile/app/helpers/api.js", "export const x = 1;\n};\n");
    // files outside every run folder
    w("outside.txt", "secret\n");
    // scratch scripts: a harmless one, one that runs git, one that spawns programs and names git
    w("scratch/edit_stock_table.py", "p = 'src/components/pages/stock/components/table/index.js'\ns = open(p).read()\nopen(p, 'w').write(s)\n");
    w("scratch/apply_i18n.js", "const fs = require('fs');\nconsole.log(fs.existsSync('src/localization/index.js'));\n");
    w("scratch/commit.sh", "git commit -m x\n");
    w("scratch/spawn.py", "import subprocess\nsubprocess.run(['git', 'status'])\n");
    // a shell script with a function, an array and a pattern test: ordinary shell, not a glob qualifier
    w("scratch/fn.sh", "#!/bin/bash\nset -e\nlog() { echo \"$1\"; }\nfiles=(a b c)\nfor f in \"${files[@]}\"; do log \"$f\"; done\nif [[ $x == (a|b) ]]; then echo ok; fi\n");
    w("backend/scripts/fn.sh", "#!/bin/bash\nlog() { echo \"$1\"; }\nfiles=(a b)\nfor f in \"${files[@]}\"; do log \"$f\"; done\n");
    w("userdir/tool.py", "print(1)\n");
    World { _dir: dir, root, backend, admin, mobile, scratch }
}

fn auto(w: &World) -> PolicyContext {
    let mut c = ctx_at(&w.backend);
    c.add_dirs = vec![w.admin.clone(), w.mobile.clone()];
    c.scratch_dirs = vec![w.scratch.clone()];
    c.home = Some(w.root.join("userdir"));
    c
}

fn ctx_at(cwd: &std::path::Path) -> PolicyContext {
    PolicyContext::new(PermissionMode::Automatic, cwd)
}

/// The command with `{backend}`, `{admin}`, `{mobile}`, `{scratch}` and `{root}` replaced.
fn text(w: &World, cmd: &str) -> String {
    cmd.replace("{backend}", &w.backend.display().to_string())
        .replace("{admin}", &w.admin.display().to_string())
        .replace("{mobile}", &w.mobile.display().to_string())
        .replace("{scratch}", &w.scratch.display().to_string())
        .replace("{root}", &w.root.display().to_string())
}

fn judge(w: &World, cmd: &str) -> (Decision, DecidedBy, String, String) {
    let d = bash(&auto(w), &text(w, cmd));
    (d.decision, d.by, d.rule.unwrap_or_default(), d.reason)
}

/// Every command must be allowed; the misses are reported together with the rule that refused them.
fn allowed(w: &World, cmds: &[&str]) {
    let misses: Vec<String> = cmds
        .iter()
        .filter_map(|c| {
            let (d, by, rule, reason) = judge(w, c);
            (d != Decision::Allow).then(|| format!("{c}\n   -> {d:?}/{by:?} {rule}: {reason}"))
        })
        .collect();
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

/// Every command must be refused with the given rule.
fn refused(w: &World, rule: &str, cmds: &[&str]) {
    let misses: Vec<String> = cmds
        .iter()
        .filter_map(|c| {
            let (d, _, r, reason) = judge(w, c);
            (d != Decision::Deny || r != rule).then(|| format!("{c}\n   -> {d:?} {r}: {reason}  (wanted deny {rule})"))
        })
        .collect();
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

#[test]
fn a_cd_chain_is_judged_from_the_directory_it_moved_to() {
    let w = world();
    allowed(
        &w,
        &[
            "cd {admin}/src/localization && sed -n 140,175p index.js; cd ../components/pages/stock/procurement; ls requisitions reorder-rules; grep -rniE \"minStock|lowStock\" ../../../../../../backend/src/api/models/ingredient*.js | head",
            "cd {backend}/src/api && sed -n 8,30p models/customer.model.js | grep -nE \"^\\s+\\w+:\"; grep -n \"build:swagger\" ../../package.json",
            "cd {backend}/src/api && ls ../../scripts/*.mjs | head -3",
            "cd {admin}/src/components/pages/stock && sed -n 190,230p components/table/index.js; grep -rn \"reorderQuantity\" {backend}/src/api/models/*.js | head; grep -n \"requisitions\" ../../Router.js | head -5",
            "cd {admin}/src && cd .. && cat src/Router.js | head -3",
        ],
    );
}

#[test]
fn a_relative_path_that_leaves_the_run_folders_after_a_cd_is_still_refused() {
    let w = world();
    refused(
        &w,
        "exec.auto.outside-jail",
        &[
            "cd {admin}/src && cat ../../outside.txt",
            "cd {admin} && ls ../../outside.txt",
            "cd {admin}/src/components && grep -n x ../../../../outside.txt",
            "cd {admin}/src; cd ..; cd ..; cat outside.txt",
            "cd {admin} && cat /etc/hosts",
            "cd {admin}/src && grep -rn needle {root}/outside.txt",
        ],
    );
}

#[test]
fn a_search_pattern_or_a_program_is_not_a_path() {
    let w = world();
    allowed(
        &w,
        &[
            "cd {admin} && grep -rn \"/projects/\" src/config/pages/admin.js | grep link | head -3",
            "cd {mobile} && sed -n '/^export const x/,/^};/p' app/helpers/api.js | head -20",
            "cd {mobile} && grep -rl \"contacts/lead\" app --include=*.js | grep -v tests | head -6",
            "cd {backend}/src/api && grep -rn \"api/v1\" . | head",
            "cd {backend}/src/api && awk '/\\/api\\//{print}' controllers/*.js | head",
            "cd {admin} && sed -i 's#/old/path#/new/path#g' src/Router.js",
            "grep -n -e /etc/passwd src/api/models/customer.model.js",
            "echo /etc/hosts /nonexistent",
        ],
    );
    // the operand after the pattern is a file, and a flag that names a file still counts
    refused(
        &w,
        "exec.auto.outside-jail",
        &["grep -n needle /etc/hosts", "sed -n '1p' /etc/hosts", "awk '{print}' /etc/hosts", "grep -rn needle /etc", "cat /etc/hosts", "grep -f /etc/hosts src", "sed -f /etc/hosts src/api/models/customer.model.js"],
    );
}

#[test]
fn a_variable_assigned_in_the_command_is_read_as_its_value() {
    let w = world();
    allowed(
        &w,
        &[
            "cd {admin} && f=src/Router.js; git status --short $f; grep -n \"export\" $f | head -8",
            "cd {backend} && F=\"src/api/models/customer.model.js src/api/models/ingredient.model.js\"; npx eslint --fix $F; npx jest src/api/tests --silent | tail -n 40",
            "cd {admin} && d=src/localization && ls ${d} && cat $d/index.js",
            "cd {admin} && a=src; b=$a/config; cat $b/pages/admin.js",
        ],
    );
    refused(
        &w,
        "exec.auto.outside-jail",
        &["f=/etc/passwd; cat $f", "cd {admin} && f=../outside.txt; cat $f", "cd {admin} && d=/etc; ls $d", "cd {admin} && f=../../outside.txt; f2=$f; cat $f2", "true && f=/etc/passwd; cat $f", "cd {admin} && f=/etc/passwd && cat $f"],
    );
}

#[test]
fn a_variable_the_command_does_not_know_stays_unjudgeable() {
    let w = world();
    refused(
        &w,
        "exec.auto.unjudgeable",
        &[
            "cat $UNSET",
            "f=$(echo /etc/passwd); cat $f",
            "f=`echo x`; cat $f",
            "cat ${f:-/etc/passwd}",
            // an assignment that may not have run, ran in a copy of the shell, or appends
            "test -f a && f=/etc/passwd; cat $f",
            "true || f=a; cat $f",
            "f=a; test -f a && f=/etc/passwd; cat $f",
            "test -f a && cd src && f=/etc/passwd; cat $f",
            "f=src/a.js | cat; cat $f",
            "if true; then f=src/a.js; fi; cat $f",
            "f=src/a.js; (f=/etc/passwd); cat $f",
            "f=a; f+=/etc/passwd; cat $f",
            "f=a; read f; cat $f",
            "f=a; unset f; cat $f",
            "f=a; for f in x y; do :; done; cat $f",
            "while read f; do cat $f; done < src/a.js",
            "case $x in a) cat $f;; esac",
        ],
    );
}

#[test]
fn a_for_loop_over_known_words_is_judged_once_per_word() {
    let w = world();
    allowed(
        &w,
        &[
            "cd {backend}/src/api && for f in models/customer.model.js models/ingredient.model.js; do echo \"=== $f\"; grep -nE \"ref:|ObjectId\" $f | head -60; done; ls models | grep -iE \"work|service\"",
            "cd {admin} && for l in cn cz de; do node -e \"const fs=require('fs');const p='src/localization/modules/crm/$l.json';console.log('$l', fs.existsSync(p))\"; done",
            "cd {admin} && for d in src/config src/components; do ls $d; for e in a b; do ls $d/$e 2>/dev/null; done; done",
            "cd {admin} && for f in src/*.js; do head -n 1 $f; done",
        ],
    );
    refused(
        &w,
        "exec.auto.outside-jail",
        &[
            "for f in /etc/passwd /etc/hosts; do cat $f; done",
            "cd {admin} && for f in src/Router.js ../outside.txt; do cat $f; done",
            "cd {admin} && for d in src ..; do ls $d/..; done",
            "cd {admin} && for f in src/Router.js; do cat $f; done; for g in /etc/hosts; do cat $g; done",
        ],
    );
    // an unknown list, or too long a list, leaves the variable unknown inside the body
    refused(&w, "exec.auto.unjudgeable", &["for f in $(ls); do cat $f; done", "for f in $LIST; do cat $f; done"]);
    let many = (0..45).map(|i| format!("f{i}")).collect::<Vec<_>>().join(" ");
    refused(&w, "exec.auto.unjudgeable", &[&format!("for f in {many}; do cat $f; done")]);
}

#[test]
fn a_known_command_name_is_judged_as_what_it_is() {
    let w = world();
    for cmd in ["g=git; $g commit -m x", "for v in commit push; do git $v; done", "cd {admin} && c=\"git push\"; $c", "v=add; git $v -A", "cd {admin} && g=/usr/bin/git && $g push"] {
        let (d, by, rule, reason) = judge(&w, cmd);
        assert_eq!((d, by), (Decision::Deny, DecidedBy::HardStop), "{cmd}: {rule}: {reason}");
    }
    allowed(&w, &["g=git; $g status", "cd {admin} && g=git; $g log --oneline -3"]);
    // the variable is read as a path as well: this is `git -C /tmp status`
    refused(&w, "exec.auto.outside-jail", &["h=-C; d=/tmp; git $h $d status"]);
}

#[test]
fn inline_code_in_a_heredoc_is_not_read_for_module_specifiers() {
    let w = world();
    allowed(
        &w,
        &[
            "cd {admin} && python3 - <<'EOF'\np='src/components/pages/stock/components/table/index.js'\ns=open(p).read()\ns=s.replace(\"import x from 'y'\",\"import { REQ } from '../../procurementSeed'\",1)\nopen(p,'w').write(s)\nEOF",
            "cd {admin} && node - <<'EOF'\nconst fs = require('fs');\nconst s = fs.readFileSync('src/Router.js', 'utf8').replace(\"'./a'\", \"'../../b'\");\nfs.writeFileSync('src/Router.js', s);\nEOF",
        ],
    );
    // the slashes of a regex literal in the program are not a path
    allowed(&w, &["cd {admin} && python3 - <<'EOF'\np='src/Router.js'\ns=open(p).read()\ns=s.replace(\"x\",\"re: /(^|[/.\\\\s])(spam|junk|trash)/i\",1)\nopen(p,'w').write(s)\nEOF"]);
    // a file that exists outside the run's folders, or an absolute path, is still seen
    refused(
        &w,
        "exec.auto.outside-jail",
        &[
            "cd {admin} && python3 - <<'EOF'\nprint(open('../outside.txt').read())\nEOF",
            "cd {admin} && python3 - <<'EOF'\nprint(open('/etc/hosts').read())\nEOF",
            "cd {admin} && python3 -c \"print(open('/etc/hosts').read())\"",
        ],
    );
}

#[test]
fn a_file_written_by_a_heredoc_inside_a_repository_runs() {
    let w = world();
    allowed(
        &w,
        &[
            "cd {backend}/src/api && cat > controllers/related.controller.js <<'EOF'\nimport { a } from '../../scripts/helper.mjs';\nexport const b = () => ({ ok: true });\nEOF\nnpx eslint --fix controllers/related.controller.js | tail -5",
            "cd {backend} && cat > src/api/tests/x.test.js <<'EOF'\njest.mock('../models/a.js', () => ({ default: {} }));\nEOF\nnpx jest src/api/tests/x.test.js --silent --noStackTrace 2>&1 | tail -n 40",
        ],
    );
    refused(&w, "exec.auto.outside-jail", &["cd {backend} && cat > ../outside.txt <<'EOF'\nx\nEOF", "cd {backend} && cat > /etc/x <<'EOF'\nx\nEOF"]);
}

#[test]
fn a_helper_script_kept_in_the_scratch_folder_runs_after_its_text_is_scanned() {
    let w = world();
    allowed(&w, &["cd {admin} && python3 {scratch}/edit_stock_table.py && grep -n \"processedData\" src/components/pages/stock/components/table/index.js | head -3; git diff --stat src/components/pages/stock/components/table/index.js", "cd {admin} && node {scratch}/apply_i18n.js && git --no-pager diff --stat -- src/localization | tail -5"]);
    // functions and arrays are ordinary shell
    allowed(&w, &["cd {admin} && bash {scratch}/fn.sh", "cd {backend} && bash scripts/fn.sh", "f() { echo hi; }; f", "files=(a b); echo done", "cd {admin} && for f in src/Router.js; do cat $f; done"]);
    // a script in the scratch folder is judged like one in a repository: a git write is a hard stop, spawning programs next to git is a risk
    let (d, by, rule, reason) = judge(&w, "cd {admin} && sh {scratch}/commit.sh");
    assert_eq!((d, by), (Decision::Deny, DecidedBy::HardStop), "{rule}: {reason}");
    refused(&w, "exec.auto.script-risk", &["cd {admin} && python3 {scratch}/spawn.py"]);
    // a script anywhere else, or one that does not exist yet, is still not read
    refused(&w, "exec.auto.unjudgeable", &["cd {admin} && python3 {root}/userdir/tool.py"]);
}

/// A hard stop in every mode: the string runs `git commit`, whatever the variables hide.
fn hard_stopped(w: &World, cmds: &[&str]) {
    let misses: Vec<String> = cmds
        .iter()
        .filter_map(|c| {
            let (d, by, rule, reason) = judge(w, c);
            ((d, by) != (Decision::Deny, DecidedBy::HardStop)).then(|| format!("{c}\n   -> {d:?}/{by:?} {rule}: {reason}  (wanted a hard stop)"))
        })
        .collect();
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

// What the independent review of the variable following found: each of these once made the analyser read a different command than the
// shell runs. The ones below must still be judged on what the shell really does, or not be judged at all.

#[test]
fn a_quoted_variable_stays_one_word_and_an_unquoted_one_splits() {
    let w = world();
    // `"$c"` is one argument: `sh -c "git commit -m x"` runs git, where splitting it would have read `sh -c git`
    hard_stopped(
        &w,
        &[
            r#"c='git commit -m x'; bash -c "$c""#,
            r#"c='git commit -m x'; sh -c "$c""#,
            r#"c='git commit -m x'; eval "$c""#,
            r#"cd {admin} && c='git push'; zsh -c "$c""#,
            r#"c='git commit -m x'; bash -c "cd .; $c""#,
            r#"c='git commit'; $c -m x"#,
            r#"c='git'; "$c" commit -m x"#,
        ],
    );
    // a quoted value with a space is one operand (a file with a space in its name), an unquoted one is two
    allowed(&w, &[r#"cd {admin} && f="src/Router.js ../outside.txt"; cat "$f""#, r#"cd {admin} && f="src/My Docs"; ls "$f""#]);
    refused(&w, "exec.auto.outside-jail", &[r#"cd {admin} && f="src/Router.js ../outside.txt"; cat $f"#, r#"cd {admin} && f='src/Router.js  ../outside.txt'; cat x$f"#]);
    // an empty value leaves no word when unquoted and an empty word when quoted
    hard_stopped(&w, &["e=; $e git commit -m x"]);
    allowed(&w, &[r#"e=; ls $e src"#]);
}

#[test]
fn a_brace_list_or_a_computed_word_is_never_read_as_a_literal() {
    let w = world();
    refused(
        &w,
        "exec.auto.unjudgeable",
        &[
            "cd {admin} && for d in {src,..}; do ls $d; done",
            "cd {admin} && for f in {.,..}/../..; do cat $f/outside.txt; done",
            "cd {admin} && for f in {a..c}; do cat $f; done",
            "cd {admin} && d={src,..}; ls $d",
            "cd {admin} && for f in src/Router.js $(echo ../outside.txt); do cat $f; done",
            "cd {admin} && for f in ${LIST:-src}; do cat $f; done",
        ],
    );
}

#[test]
fn an_assignment_that_may_not_have_run_is_not_followed_past_its_list() {
    let w = world();
    // `cd` into a directory that does not exist fails, and the assignment after it is skipped: the old value is what `cat` reads
    refused(&w, "exec.auto.unjudgeable", &["f=/etc/passwd; cd {admin}/nodir && f=src/Router.js; cat $f", "f=/etc/passwd; false || f=src/Router.js; cat $f", "f=/etc/passwd; test -f nofile && f=src/Router.js; cat $f"]);
    // in the same `&&` list the value is certain, and after a `cd` into a directory that exists the list is certain as a whole
    allowed(&w, &["cd {admin} && f=src/Router.js && cat $f", "cd {admin} && f=src/Router.js; cat $f", "f=/etc/passwd; cd {admin} && f=src/Router.js; cat $f", "f=/etc/passwd; true && f=src/Router.js; cat $f"]);
    refused(&w, "exec.auto.outside-jail", &["f=src/Router.js; cd {admin}/nodir && f=/etc/passwd && cat $f", "cd {admin} && f=/etc/passwd; cat $f"]);
    // a list that ends with `&`, or a side of a pipe, ran in a copy of the shell
    refused(
        &w,
        "exec.auto.unjudgeable",
        &["f=/etc/passwd; f=src/Router.js && true & cat $f", "f=/etc/passwd; f=src/Router.js | cat; cat $f", "f=/etc/passwd; echo x | f=src/Router.js; cat $f", "f=/etc/passwd; f=src/Router.js > /nodir/log; cat $f"],
    );
    // the status of a substitution is the status of the assignment
    refused(&w, "exec.auto.unjudgeable", &["f=/etc/passwd; g=$(false) && f=src/Router.js; cat $f"]);
}

#[test]
fn a_substitution_runs_in_a_copy_of_the_shell_and_its_assignments_stay_there() {
    use intely_agent_core::policy::hardstop::analyze;
    use intely_agent_core::policy::paths::Jail;
    let w = world();
    let jail = Jail::new(&w.backend, &[], None);
    // (a substitution makes the string unjudgeable for Automatic anyway; the analysis still says where `cat` reads)
    for cmd in ["f=/etc/passwd; echo $(f=src/Router.js); cat $f", "f=/etc/passwd; echo `f=src/Router.js`; cat $f", "f=/etc/passwd; echo $(for f in a b; do :; done); cat $f"] {
        let probes = analyze(cmd, &jail).probes;
        assert!(probes.iter().any(|p| p.ends_with("/etc/passwd")), "{cmd}: {probes:?}");
    }
}

#[test]
fn a_loop_that_may_not_run_or_leaves_early_makes_what_it_assigns_unknown() {
    let w = world();
    refused(
        &w,
        "exec.auto.unjudgeable",
        &[
            // not run: `false &&`
            "f=/etc/passwd; false && for i in 1; do f=src/Router.js; done; cat $f",
            // run in a copy of the shell: a pipe, the background
            "f=/etc/passwd; for i in 1; do f=src/Router.js; done | cat; cat $f",
            "f=/etc/passwd; for i in 1; do f=src/Router.js; done & cat $f",
            "f=/etc/passwd; echo x | for i in 1; do f=src/Router.js; done; cat $f",
            // left early: the last assignment of the pass is not the last one that ran
            "cd {admin} && f=src/Router.js; for i in a b; do f=/etc/passwd; [ \"$i\" = a ] && break; f=src/Router.js; done; cat $f",
            "cd {admin} && f=src/Router.js; for i in a b; do f=/etc/passwd; [ \"$i\" = a ] && continue; f=src/Router.js; done; cat $f",
            "cd {admin} && f=src/Router.js; for i in a b; do cat $f; f=/etc/passwd; [ \"$i\" = a ] && continue; f=src/Router.js; done",
            // an unknown list: before, in and after the body
            "cd {admin} && f=src/Router.js; for i in $(ls); do cat $f; f=src/Router.js; done",
            "f=/etc/passwd; for i in $(ls); do f=src/Router.js; done; cat $f",
        ],
    );
    // a loop that runs for certain and does not leave early keeps what it assigned
    allowed(&w, &["cd {admin} && for i in a b; do f=src/Router.js; done; cat $f", "cd {admin} && f=src/Router.js; for i in a b; do cat $f; done"]);
    refused(&w, "exec.auto.outside-jail", &["cd {admin} && for i in a b; do f=/etc/passwd; done; cat $f", "cd {admin} && f=src/Router.js; for i in a b; do cat $f; f=/etc/passwd; done"]);
}

#[test]
fn a_command_that_can_change_a_variable_in_another_way_ends_the_following() {
    let w = world();
    refused(
        &w,
        "exec.auto.unjudgeable",
        &[
            "cd {admin} && f=src/Router.js; printf -v f '%s' /etc/passwd; cat $f",
            "cd {admin} && f=src/Router.js; let f=1; cat $f",
            "cd {admin} && f=src/Router.js; mapfile f < src/Router.js; cat $f",
            "cd {admin} && f=src/Router.js; readarray f < src/Router.js; cat $f",
            "cd {admin} && f=src/Router.js; getopts a f; cat $f",
            "cd {admin} && f=src/Router.js; eval 'f=/etc/passwd'; cat $f",
            "cd {admin} && f=src/Router.js; source ./x.sh; cat $f",
            "cd {admin} && f=src/Router.js; . ./x.sh; cat $f",
            "cd {admin} && f=src/Router.js; command read f; cat $f",
            "cd {admin} && f=src/Router.js; builtin read f; cat $f",
            "cd {admin} && f=src/Router.js; time read f; cat $f",
            "cd {admin} && f=src/Router.js; declare -n f=g; cat $f",
            "cd {admin} && f=src/Router.js; declare -i f; f=1+2; cat $f",
            "cd {admin} && f=src/Router.js; readonly f; f=/etc/passwd; cat $f",
            "cd {admin} && f=src/Router.js; unset -n f; cat $f",
            "cd {admin} && f=src/Router.js; trap 'f=/etc/passwd' DEBUG; cat $f",
            "cd {admin} && f=src/Router.js; x[0]=y; f[0]=/etc/passwd; cat $f",
            "cd {admin} && f=src/Router.js; export f=/etc/passwd; cat $f",
            "cd {admin} && f=src/Router.js; $unknown x; cat $f",
            // arithmetic and `${x:=y}` assign inside an expansion
            "cd {admin} && f=src/Router.js; echo $((f=1)); cat $f",
            "cd {admin} && f=src/Router.js; echo $[f=1]; cat $f",
            "cd {admin} && f=; echo ${f:=/etc/passwd}; cat $f",
            "cd {admin} && f=; echo ${f=/etc/passwd}; cat $f",
            // `IFS` changes how every word is split
            "cd {admin} && IFS=/; f=src/Router.js; cat $f",
            "cd {admin} && f=src/Router.js; IFS=/ cat $f",
            "cd {admin} && f=src/Router.js; export IFS=/; cat $f",
        ],
    );
    // a command that changes nothing the string follows does not stop the following
    allowed(&w, &["cd {admin} && f=src/Router.js; export NODE_ENV=test; printf '%s\\n' x; cat $f", "cd {admin} && f=src/Router.js; read x < /dev/null; cat $f"]);
}

#[test]
fn a_value_that_grows_without_end_is_not_followed() {
    let w = world();
    let mut cmd = String::from("cd {admin} && a0=0123456789abcdef");
    for i in 1..40 {
        cmd.push_str(&format!("; a{i}=$a{}$a{}", i - 1, i - 1));
    }
    cmd.push_str("; cat $a39");
    let started = std::time::Instant::now();
    refused(&w, "exec.auto.unjudgeable", &[&cmd]);
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "took {:?}", started.elapsed());
    // many variables are fine up to a limit, and a long list of words too
    let many = (0..200).map(|i| format!("v{i}=src/Router.js")).collect::<Vec<_>>().join("; ");
    allowed(&w, &[&format!("cd {{admin}} && {many}; cat $v0")]);
}

#[test]
fn a_relative_path_with_a_space_or_a_double_slash_is_judged_whole() {
    let w = world();
    refused(
        &w,
        "exec.auto.outside-jail",
        &[
            r#"cd {admin}/src && cat "../../My Docs/x.txt""#,
            r#"cd {admin}/src && ls '../../My Docs'"#,
            "cat //etc/passwd",
            "cd {admin} && cat //etc/hosts",
            "cd {admin} && head -n 1 ///etc/hosts",
        ],
    );
    allowed(&w, &[r#"cd {admin} && cat "src/My Docs/x.txt""#, r#"cd {admin} && ls "src/a b/../Router.js""#, "cd {admin} && git show HEAD:src/Router.js"]);
    // the rest of a URL is not a path: the network rule judges it, not the folders
    for cmd in ["git clone https://example.com/r.git", "git fetch ssh://git@example.com/r.git", "curl -s https://example.com/api/x"] {
        let (_, _, rule, reason) = judge(&w, cmd);
        assert_ne!(rule, "exec.auto.outside-jail", "{cmd}: {reason}");
    }
    // program text with a space and a slash is not mistaken for a path
    allowed(&w, &[r#"cd {admin} && node -e "const a = require('../../x/y'); console.log(a)""#, r#"cd {admin} && echo "see ../../x for details""#]);
}

// The second independent review, the part that concerns Automatic mode.

#[test]
fn a_cd_that_fails_does_not_move_the_paths_that_follow_it() {
    let w = world();
    // `nope` does not exist: the `cd` fails, and what follows `;` or `||` runs where the shell was, so it is judged from both places
    refused(
        &w,
        "exec.auto.outside-jail",
        &["cd nope; cat ../outside.txt", "cd nope; cd ..; cat outside.txt", "cd nope; echo x > ../outside.txt", "cd nope; git -C .. log", "cd {backend}/nope || cat ../outside.txt"],
    );
    // a folder the string makes, a folder that exists, and `&&` (the next command runs only if the `cd` worked) are fine
    allowed(&w, &["mkdir -p out; cd out; ls", "mkdir out && cd out && ls", "cd {admin}; cat src/Router.js | head -n 1", "cd {admin}/src && cat Router.js", "mkdir -p {scratch}/u && cd {admin}/src && ls; cat Router.js"]);
}

#[test]
fn the_directory_is_judged_from_every_place_a_cd_may_have_left_the_shell() {
    let w = world();
    // the `cd` may not have moved the shell: what follows the list is judged from the old place too, where `..` leaves the run's folders
    refused(
        &w,
        "exec.auto.outside-jail",
        &[
            "cd nope && cat src/Router.js; cat ../outside.txt",
            "cd nope && cat src/Router.js; echo x > ../outside.txt",
            "cd nope && ls; ls ..",
            "cd nope && :; ls ..",
            "cd nope && cd ..; ls ..",
            "cd nope && true || true; cat ../outside.txt",
            "test -f flag && cd {backend}/src; cat ../outside.txt",
            "if true; then cd {backend}/src; fi; cat ../outside.txt",
            "f() { cd {backend}/src; }; cat ../outside.txt",
            "mkdir nope; cd nope/deeper; cat ../../outside.txt",
            "mkdir nope/x; cd nope/x; cat ../../outside.txt",
            "(cd {backend}/src); cat ../outside.txt",
            "bash -c 'cd {backend}/src'; cat ../outside.txt",
        ],
    );
    // a `cd` in a pipe or in the background leaves the place of the shell unknown, and so does `CDPATH`
    refused(
        &w,
        "exec.auto.unjudgeable",
        &[
            "cd {backend}/src | cat; cat ../outside.txt",
            "cd {backend}/src & cat ../outside.txt",
            "CDPATH={root} cd backend; cat x",
            "export CDPATH={root}; cd src; cat x",
            "CDPATH={root}; cd src; cat x",
            "for d in $(ls); do cd {backend}/$d; done; cat ../outside.txt",
        ],
    );
    allowed(
        &w,
        &[
            "(cd {backend}/src && ls) && ls",
            "(cd {admin}/src; cat Router.js); cat src/api/models/customer.model.js",
            "mkdir -p out/deep; cd out/deep; ls ..",
            "mkdir out && cd out && ls ..",
            "for d in src scripts; do cd {backend}/$d && ls; done; ls",
            "cd {backend}/src && ls ..; cd ..; ls",
            "test -f flag && cd {backend}/src; ls",
        ],
    );
}

#[test]
fn a_program_expansion_of_zsh_is_read_as_the_program_it_names() {
    let w = world();
    // zsh runs `=git` as git (also when the equals sign is followed by an escape): the hard stops apply to it
    for cmd in ["=\\git commit -m x", "=git push", "=\\git add -A", "cd {admin} && =git commit -m x", "=\\rm -rf /"] {
        let (d, by, rule, reason) = judge(&w, cmd);
        assert_eq!((d, by), (Decision::Deny, DecidedBy::HardStop), "{cmd}: {rule}: {reason}");
    }
    allowed(&w, &["=ls", "cd {admin} && =git status"]);
    // a quoted equals sign is a plain character
    allowed(&w, &["echo '=git'", "echo \"=ls\""]);
}

#[test]
fn zsh_forms_of_a_glob_or_a_command_name_are_not_judged_as_plain_words() {
    let w = world();
    refused(
        &w,
        "exec.auto.unjudgeable",
        &["cat *(D)", "cat .e(n)v", "cat (.)env", "x=.envxx; cat $x[1,4]", "setopt GLOB_DOTS; cat *", "shopt -s dotglob; cat *"],
    );
}

#[test]
fn a_secret_asked_for_by_name_is_still_a_hard_stop() {
    let w = world();
    // the name pattern of find is no path to open, but `.env` and a key file asked for by name stay refused (as before)
    for cmd in ["find . -name .env", "find . -name \".env*\"", "find . -name .env | xargs cat", "find . -name id_rsa", "find . -iname id_rsa -o -name x", "grep -rn x --include=.env ."] {
        let (d, by, rule, reason) = judge(&w, cmd);
        assert_eq!((d, by), (Decision::Deny, DecidedBy::HardStop), "{cmd}: {rule}: {reason}");
    }
    // ordinary name patterns, with `-o` as the OR operator, are fine
    allowed(&w, &["find . -name \"*.js\" -o -name \"*.ts\"", "find . -path ./node_modules -prune -o -type f -name \"*.js\" -print", "find src -not -path './.git/*' -name \"*.json\""]);
}

#[test]
fn names_printed_into_xargs_are_judged_like_operands() {
    let w = world();
    std::fs::write(w.backend.join(".env"), "SECRET=1\n").unwrap();
    for cmd in ["echo .env | xargs cat", "echo ~/.ssh/id_rsa | xargs cat", "printf '%s\\n' .env | xargs cat", "echo a .env | xargs -n1 cat", "echo 'a .env' | xargs cat"] {
        let (d, by, rule, reason) = judge(&w, cmd);
        assert_eq!((d, by), (Decision::Deny, DecidedBy::HardStop), "{cmd}: {rule}: {reason}");
    }
    refused(&w, "exec.auto.outside-jail", &["echo ../outside.txt | xargs cat", "echo /etc/hosts | xargs cat", "printf '%s\\n' src/Router.js ../outside.txt | xargs head"]);
    allowed(&w, &["echo src/api/models/customer.model.js | xargs cat", "echo a b c | xargs -n1 echo", "cd {admin} && echo src/Router.js | xargs wc -l"]);
}

#[test]
fn a_glob_is_judged_by_the_files_it_matches() {
    let w = world();
    std::fs::write(w.backend.join(".env"), "SECRET=1\n").unwrap();
    for cmd in ["cat .e*", "cat .en?", "cat .en[v]", "cat **/.env", "head -n 1 .e*"] {
        let (d, by, rule, reason) = judge(&w, cmd);
        assert_eq!((d, by), (Decision::Deny, DecidedBy::HardStop), "{cmd}: {rule}: {reason}");
    }
    refused(&w, "exec.auto.outside-jail", &["cat ../*.txt", "ls /etc/h*"]);
    allowed(&w, &["ls src/api/models/*.js", "cat src/api/*/customer*.js | head -n 1", "wc -l src/**/*.js | tail -n 1"]);
}

#[test]
fn the_analysis_lists_where_each_operand_points() {
    use intely_agent_core::policy::hardstop::analyze;
    use intely_agent_core::policy::paths::Jail;
    let w = world();
    let jail = Jail::new(&w.backend, &[w.admin.clone()], None);
    let a = analyze(&text(&w, "cd {admin}/src/localization && ls ../Router.js; grep -n \"/x/\" index.js; echo /etc/hosts > /dev/null; sed -n '/^a/,/^b/p' index.js"), &jail);
    let probes: Vec<&str> = a.probes.iter().map(String::as_str).collect();
    let admin = w.admin.display().to_string();
    assert!(probes.contains(&format!("{admin}/src/Router.js").as_str()), "{probes:?}");
    assert!(probes.contains(&format!("{admin}/src/localization/index.js").as_str()), "{probes:?}");
    assert!(probes.contains(&"/dev/null"), "a redirect target is an operand too: {probes:?}");
    // a search pattern, a sed program and the text of echo are not operands of this kind
    assert!(!probes.iter().any(|p| p.ends_with("/x") || p.ends_with("/x/") || p.contains("etc/hosts") || p.contains("^a")), "{probes:?}");
    // a variable of the string is read as its value
    let a = analyze("f=src/a.ts; cat $f; for g in x y; do ls $g; done", &Jail::new(&w.backend, &[], None));
    assert!(a.issues.is_empty(), "{:?}", a.issues);
    let probes: Vec<&str> = a.probes.iter().map(String::as_str).collect();
    let b = w.backend.display().to_string();
    for want in ["src/a.ts", "x", "y"] {
        assert!(probes.contains(&format!("{b}/{want}").as_str()), "{want}: {probes:?}");
    }
}
