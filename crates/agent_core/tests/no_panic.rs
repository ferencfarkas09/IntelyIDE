//! The analysis runs on text written by a model: whatever it is, it must neither panic nor hang, and a plain
//! `git commit` / `git push` hidden in random surroundings must stay a hard stop.

mod common;

use common::*;
use intely_agent_core::events::types::DecidedBy;
use intely_agent_core::policy::decide::Decision;
use intely_agent_core::policy::shellparse;
use intely_agent_core::providers::PermissionMode;

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.next() as usize % items.len()]
    }
}

const PIECES: &[&str] = &[
    " ", " ", " ", "\n", "\t", ";", "&&", "||", "|", "&", "(", ")", "{", "}", "<", ">", ">>", "<<", "<<<", "<<EOF\n", "EOF\n", "'", "\"", "`", "$", "$(", "${", "$'", "\\", "#", "*", "?", "[", "]", "=", "-", "--", ".", "/",
    "git", "commit", "push", "add", "-A", "-c", "-C", "env", "sh", "-c", "bash", "eval", "xargs", "find", "-exec", "sudo", "cd", "echo", "x", "é", "日本", "\u{0}", "\r", "~", ".git", "$X", "{a,b}", "2>&1", "gh", "pr", "merge", "npm", "publish",
];

/// `echo`, `true` and a `find` without predicates read and run nothing, so a random string whose every command is one of them is a legitimate low-risk read.
fn only_prints(fx: &Fx, cmd: &str) -> bool {
    let a = intely_agent_core::policy::hardstop::analyze(cmd, &intely_agent_core::policy::paths::Jail::new(&fx.cwd, &[], None));
    // a `find` without predicates lists names and nothing else; every predicate that writes or runs something is refused by the policy itself
    a.simple.iter().filter(|w| !w.is_empty()).all(|w| match w[0].text.as_str() {
        "echo" | "true" => true,
        "find" => w[1..].iter().all(|x| !["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls", "-files0-from"].contains(&x.text.as_str())),
        _ => false,
    })
}

fn random_command(rng: &mut Lcg) -> String {
    (0..rng.next() % 24 + 1).map(|_| rng.pick(PIECES)).collect()
}

#[test]
fn random_text_never_panics_or_hangs() {
    let fx = fx();
    let mut rng = Lcg(0x5eed);
    let c = ctx(&fx, PermissionMode::Edit);
    for _ in 0..20_000 {
        let cmd = random_command(&mut rng);
        let _ = shellparse::parse(&cmd);
        let d = bash(&c, &cmd);
        assert!(d.decision != Decision::Allow || only_prints(&fx, &cmd), "an unsaved command is never allowed outright: {cmd:?}");
    }
}

#[test]
fn random_text_never_panics_or_asks_in_the_unattended_modes() {
    let fx = fx();
    let mut rng = Lcg(0xa070);
    for mode in [PermissionMode::Automatic, PermissionMode::Bypass, PermissionMode::ReadOnly] {
        let c = ctx(&fx, mode);
        for _ in 0..6_000 {
            let cmd = random_command(&mut rng);
            let d = bash(&c, &cmd);
            if mode.is_unattended() {
                assert_ne!(d.decision, Decision::Ask, "{mode:?}: the unattended modes never ask: {cmd:?}");
            } else {
                assert!(d.decision != Decision::Allow || only_prints(&fx, &cmd), "{mode:?}: Plan never allows a random string: {cmd:?}");
            }
        }
    }
}

#[test]
fn deeply_nested_input_is_bounded() {
    let fx = fx();
    let c = ctx(&fx, PermissionMode::Edit);
    for depth in [50usize, 500, 5000] {
        let nested = format!("{}git commit{}", "$(".repeat(depth), ")".repeat(depth));
        let d = bash(&c, &nested);
        assert_eq!(d.decision, Decision::Ask, "too deep to judge: ask, not allow (depth {depth})");
    }
    // each level of quoting roughly quadruples the string, so stay small
    for depth in [3usize, 8, 10] {
        let sh = (0..depth).fold("git commit".to_string(), |inner, _| format!("sh -c '{}'", inner.replace('\'', "'\\''")));
        let d = bash(&c, &sh);
        assert!(matches!(d.decision, Decision::Ask | Decision::Deny), "{depth}: {d:?}");
        if depth <= 8 {
            assert_eq!(d.by, DecidedBy::HardStop, "{depth}: still within the nesting limit");
        }
    }
    let long = "a ".repeat(200_000);
    assert_eq!(bash(&c, &long).decision, Decision::Ask);
    // too deep to judge: refused in Automatic, and in Bypass only the raw-text scan decides
    for depth in [50usize, 500] {
        let nested = format!("{}ls{}", "$(".repeat(depth), ")".repeat(depth));
        assert_eq!(bash(&ctx(&fx, PermissionMode::Automatic), &nested).decision, Decision::Deny, "depth {depth}");
        let nested = format!("{}git commit{}", "$(".repeat(depth), ")".repeat(depth));
        assert_eq!((bash(&ctx(&fx, PermissionMode::Bypass), &nested).decision, bash(&ctx(&fx, PermissionMode::Bypass), &nested).by), (Decision::Deny, DecidedBy::HardStop), "depth {depth}");
    }
    assert_eq!(bash(&ctx(&fx, PermissionMode::Automatic), &long).decision, Decision::Deny);
}

#[test]
fn a_plain_commit_or_push_is_a_hard_stop_in_any_surrounding() {
    let fx = fx();
    let mut rng = Lcg(42);
    let c = ctx(&fx, PermissionMode::Edit);
    let before = ["", "echo hi; ", "true && ", "cd sub; ", "FOO=1 ", "(", "{ ", "if true; then ", "for x in 1; do ", "echo 'a b' | ", "x=$(date); "];
    let wrap = ["", "env ", "sudo ", "command ", "nohup ", "time ", "/usr/bin/", "xcrun ", "nice -n 3 ", "timeout 9 "];
    let verbs = ["git commit -m x", "git push", "git -C sub tag v1", "git add -A", "git reset --hard", "gh pr merge 3"];
    let after = ["", "; echo done", " && ls", " | cat", " &", "\n", " # note", " 2>&1"];
    for _ in 0..2000 {
        let verb = rng.pick(&verbs);
        // `gh` and `git add -A` do not combine with every wrapper the same way, but all of these peel to the real command
        let cmd = format!("{}{}{}{}", rng.pick(&before), rng.pick(&wrap), verb, rng.pick(&after));
        // the same string in every mode: no mode loosens a hard stop
        for mode in PermissionMode::ALL {
            let d = bash(&ctx(&fx, mode), &cmd);
            assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop), "{mode:?} {cmd:?}: {d:?}");
        }
    }
    let _ = c;
}
