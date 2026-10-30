//! `read.never-read` on program text (inline code, heredocs, the text of a script a command runs): a bare name that is secret only by
//! its extension (`line.key`, `event.key`, `props.key`: a property access in code) counts only when a file of that name is in the
//! directory the command runs in. Exact secret names (`.env`, `id_rsa`), names with a folder (`./certs/server.pem`) and home or
//! absolute paths stay judged by their spelling; operands a program opens stay resolved. The verdict is the same in every mode.

mod common;

use common::*;
use intely_agent_core::events::types::DecidedBy;
use intely_agent_core::policy::decide::Decision;
use intely_agent_core::providers::PermissionMode;

/// The property accesses the false positive came from (a React or DOM code base is full of them).
const PROPS: &[&str] = &["line.key", "event.key", "e.key", "props.key", "item.key"];

fn modes() -> [PermissionMode; 5] {
    PermissionMode::ALL
}

/// Every mode is a hard stop by `read.never-read`; returns the reason of the last mode.
fn stopped(fx: &Fx, cmd: &str) -> String {
    let mut reason = String::new();
    for mode in modes() {
        let d = bash(&ctx(fx, mode), cmd);
        assert_eq!((d.decision, d.by, d.rule.as_deref()), (Decision::Deny, DecidedBy::HardStop, Some("read.never-read")), "{mode:?} {cmd}: {}", d.reason);
        reason = d.reason;
    }
    reason
}

/// No mode is a hard stop (whatever the mode then decides: allow or ask).
fn not_stopped(fx: &Fx, cmd: &str) {
    for mode in modes() {
        let d = bash(&ctx(fx, mode), cmd);
        assert_ne!(d.by, DecidedBy::HardStop, "{mode:?} {cmd}: {:?} {}", d.rule, d.reason);
    }
}

fn py_heredoc(code: &str) -> String {
    format!("python3 - <<'EOF'\n{code}\nEOF")
}

fn node_e(code: &str) -> String {
    format!("node -e \"{code}\"")
}

#[test]
fn a_property_access_ending_in_dot_key_is_not_a_secret_file_when_no_such_file_is_there() {
    let fx = mfx();
    for prop in PROPS {
        not_stopped(&fx, &py_heredoc(&format!("import re\np = {prop}\nprint(re.sub('a', 'b', {prop}))")));
        not_stopped(&fx, &node_e(&format!("const x = {{key: 1}}; console.log({prop})")));
        std::fs::write(fx.cwd.join("p1.py"), format!("print({prop})\n")).unwrap();
        not_stopped(&fx, "python3 p1.py");
        std::fs::write(fx.cwd.join("p1.js"), format!("items.map((item) => <Row key={{{prop}}} />)\n")).unwrap();
        not_stopped(&fx, "node p1.js");
    }
    // the commands of the report: `cd` into a folder, then a heredoc; a script run before a type check
    std::fs::create_dir_all(fx.cwd.join("src/modules")).unwrap();
    not_stopped(&fx, &format!("cd src/modules && {}", py_heredoc("import re\np='catalog/domain/type.ts'\nk = line.key")));
    std::fs::write(fx.cwd.join("p1.py"), "for line in lines:\n    print(line.key)\n").unwrap();
    not_stopped(&fx, "python3 p1.py && npx tsc --noEmit 2>&1 | head -20");
    // every extension entry behaves the same
    for name in ["cfg.pem", "a.p8", "b.p12", "c.jks", "d.keystore", "e.pfx"] {
        not_stopped(&fx, &node_e(&format!("console.log({name})")));
    }
}

#[test]
fn the_same_name_is_a_hard_stop_when_a_file_of_that_name_is_in_the_folder() {
    let fx = mfx();
    std::fs::write(fx.cwd.join("line.key"), "-----BEGIN PRIVATE KEY-----\n").unwrap();
    let why = stopped(&fx, &py_heredoc("print(open('line.key').read())"));
    assert!(why.contains("mentions line.key") && why.contains("secret file"), "the reason says where the name came from: {why}");
    stopped(&fx, &node_e("console.log(line.key)"));
    std::fs::write(fx.cwd.join("p1.py"), "print(line.key)\n").unwrap();
    stopped(&fx, "python3 p1.py");
    // a string literal that names an existing key file
    std::fs::write(fx.cwd.join("server.key"), "k").unwrap();
    stopped(&fx, &py_heredoc("data = open('server.key').read()"));
    stopped(&fx, &node_e("require('fs').readFileSync('server.key')"));
    // a different case of the same name (macOS and Windows fold it; the lookup asks the file system)
    std::fs::write(fx.cwd.join("Upper.PEM"), "k").unwrap();
    stopped(&fx, &node_e("console.log(Upper.PEM)"));
}

#[test]
fn operands_exact_names_folders_and_home_paths_stay_judged_as_before() {
    let fx = mfx();
    // an operand the program opens: resolved, a hard stop whether or not the file exists
    stopped(&fx, "cat server.key");
    std::fs::write(fx.cwd.join("server.key"), "k").unwrap();
    stopped(&fx, "cat server.key");
    // judged by spelling, with no file on the disk
    stopped(&fx, "cat ~/.ssh/id_rsa");
    stopped(&fx, &py_heredoc("open('.env').read()"));
    stopped(&fx, &node_e("require('dotenv').config({path: '.env.local'})"));
    stopped(&fx, &py_heredoc("open('./certs/server.pem').read()"));
    stopped(&fx, &node_e("readFileSync('certs/server.pem')"));
    stopped(&fx, &py_heredoc("open('../server.pem').read()"));
    stopped(&fx, &py_heredoc("open('~/.ssh/id_rsa').read()"));
    stopped(&fx, &node_e("readFileSync('/etc/ssl/private/server.key')"));
    stopped(&fx, &py_heredoc("open('id_rsa').read()"));
    stopped(&fx, &py_heredoc("open('id_rsa.key').read()"));
    stopped(&fx, &py_heredoc("open('.env.key').read()"));
    stopped(&fx, &py_heredoc("open('credentials.json').read()"));
    std::fs::write(fx.cwd.join("p2.py"), "open('.npmrc').read()\n").unwrap();
    stopped(&fx, "python3 p2.py");
}

#[test]
fn the_folder_is_the_one_the_command_runs_in_after_a_cd() {
    let fx = mfx();
    std::fs::write(fx.cwd.join("sub/line.key"), "k").unwrap();
    // the file is in `sub`: from `sub` the name counts, from the run folder or another folder it does not
    stopped(&fx, &format!("cd sub && {}", node_e("console.log(line.key)")));
    stopped(&fx, &format!("cd sub && {}", py_heredoc("print(line.key)")));
    not_stopped(&fx, &node_e("console.log(line.key)"));
    not_stopped(&fx, &format!("cd src && {}", node_e("console.log(line.key)")));
    // `( ... )` ends what a `cd` inside it did
    not_stopped(&fx, &format!("(cd src) && {}", node_e("console.log(line.key)")));
    stopped(&fx, &format!("(cd sub && {})", node_e("console.log(line.key)")));
}

#[test]
fn a_symbolic_link_with_a_key_name_counts_even_when_it_points_outside_or_nowhere() {
    let fx = mfx();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("target.txt"), "k").unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.path().join("target.txt"), fx.cwd.join("x.key")).unwrap();
        stopped(&fx, &node_e("console.log(x.key)"));
        std::os::unix::fs::symlink(outside.path().join("missing.txt"), fx.cwd.join("dangling.key")).unwrap();
        stopped(&fx, &py_heredoc("print(dangling.key)"));
    }
}

#[test]
fn past_the_look_up_cap_every_further_name_counts_as_found() {
    let fx = mfx();
    // repeats of one name are looked up once
    let repeated = vec!["line.key"; 500].join(", ");
    not_stopped(&fx, &py_heredoc(&format!("print([{repeated}])")));
    // 64 distinct names that do not exist: all looked up, none there
    let names = |n: usize| (0..n).map(|i| format!("row{i}.key")).collect::<Vec<_>>().join(", ");
    not_stopped(&fx, &py_heredoc(&format!("print([{}])", names(64))));
    // the 65th distinct name is not looked up: it counts as a secret file (fail closed)
    stopped(&fx, &py_heredoc(&format!("print([{}])", names(65))));
    std::fs::write(fx.cwd.join("many.py"), format!("print([{}])\n", names(65))).unwrap();
    stopped(&fx, "python3 many.py");
}

#[test]
fn an_unknown_folder_still_fails_closed_in_bypass() {
    let fx = mfx();
    // a `cd` to a folder the analyser cannot know: the command is not judged as safe in any mode, and Bypass hard-stops it
    // on its text (a relative name of program text is not looked up anywhere)
    let cmd = format!("cd \"$DIR\" && {}", node_e("console.log(line.key)"));
    for mode in modes() {
        let d = bash(&ctx(&fx, mode), &cmd);
        assert_ne!(d.decision, Decision::Allow, "{mode:?} {cmd}: {:?}", d.rule);
    }
    let d = bash(&ctx(&fx, PermissionMode::Bypass), &cmd);
    assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop), "{:?} {}", d.rule, d.reason);
}
