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
        "home",
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
    w("home/tool.py", "print(1)\n");
    World { _dir: dir, root, backend, admin, mobile, scratch }
}

fn auto(w: &World) -> PolicyContext {
    let mut c = ctx_at(&w.backend);
    c.add_dirs = vec![w.admin.clone(), w.mobile.clone()];
    c.scratch_dirs = vec![w.scratch.clone()];
    c.home = Some(w.root.join("home"));
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
    // a script in the scratch folder is judged like one in a repository: a git write is a hard stop, spawning programs next to git is a risk
    let (d, by, rule, reason) = judge(&w, "cd {admin} && sh {scratch}/commit.sh");
    assert_eq!((d, by), (Decision::Deny, DecidedBy::HardStop), "{rule}: {reason}");
    refused(&w, "exec.auto.script-risk", &["cd {admin} && python3 {scratch}/spawn.py"]);
    // a script anywhere else, or one that does not exist yet, is still not read
    refused(&w, "exec.auto.unjudgeable", &["cd {admin} && python3 {root}/home/tool.py"]);
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
