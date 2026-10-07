mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;

use common::*;
use intely_pathpick::*;

const CANARY: &str = "CANARY-SECRET-7f3a";

fn picked(fx: &Fx, repo: &std::path::Path) -> Picked {
    let t = fx.tokens();
    let v = fx.validator();
    t.issue(v.validate(&s(repo), &root_purpose()).unwrap(), &root_purpose())
}

#[test]
fn every_risk_key_is_reported_by_name_and_no_value_leaks() {
    let fx = Fx::new();
    let repo = fx.repo("r");
    fx.set_config(
        &repo,
        &format!(
            "[core]\n fsmonitor = /tmp/{CANARY}.sh\n sshCommand = ssh -i {CANARY}\n hooksPath = {CANARY}\n pager = {CANARY}\n editor = {CANARY}\n askpass = {CANARY}\n gitProxy = {CANARY}\n worktree = /{CANARY}\n attributesFile = {CANARY}\n bare = true\n\
[credential]\n helper = {CANARY}\n[credential \"https://h\"]\n helper = {CANARY}\n[filter \"lfs\"]\n clean = {CANARY}\n smudge = {CANARY}\n process = {CANARY}\n\
[diff \"x\"]\n textconv = {CANARY}\n command = {CANARY}\n[diff]\n external = {CANARY}\n[merge \"m\"]\n driver = {CANARY}\n[alias]\n boom = !{CANARY}\n safe = status\n\
[uploadpack]\n packObjectsHook = {CANARY}\n[gpg]\n program = {CANARY}\n[include]\n path = {CANARY}\n[includeIf \"gitdir:/x\"]\n path = {CANARY}\n[extensions]\n worktreeConfig = true\n\
[url \"https://x\"]\n insteadOf = {CANARY}\n pushInsteadOf = {CANARY}\n[http]\n proxy = {CANARY}\n[http \"https://z\"]\n extraHeader = {CANARY}\n[remote \"origin\"]\n url = https://user:{CANARY}@github.com/o/r.git\n proxy = {CANARY}\n vcs = {CANARY}\n"
        ),
    );
    let p = picked(&fx, &repo);
    let want = [
        "alias.boom", "core.askpass", "core.attributesfile", "core.bare", "core.editor", "core.fsmonitor", "core.gitproxy",
        "core.hookspath", "core.pager", "core.sshcommand", "core.worktree", "credential.*.helper", "credential.helper",
        "diff.*.command", "diff.*.textconv", "diff.external", "extensions.worktreeconfig", "filter.*.clean", "filter.*.process",
        "filter.*.smudge", "gpg.program", "http.*.extraheader", "http.proxy", "include.path", "includeIf.*.path",
        "merge.*.driver", "remote.*.proxy", "remote.*.vcs", "uploadpack.packObjectsHook", "url.*.insteadof", "url.*.pushinsteadof",
    ];
    for w in want {
        assert!(p.config_risks.iter().any(|k| k == w), "missing {w} in {:?}", p.config_risks);
    }
    assert!(!p.config_risks.iter().any(|k| k == "alias.safe"));
    let json = serde_json::to_string(&p).unwrap();
    assert!(!json.contains(CANARY), "a config value leaked: {json}");
    assert_eq!(p.remotes.len(), 1);
    assert_eq!(p.remotes[0].host, "github.com");
}

#[test]
fn a_boolean_fsmonitor_and_a_plain_config_are_quiet() {
    let fx = Fx::new();
    let repo = fx.repo("r");
    assert!(picked(&fx, &repo).config_risks.is_empty());
    fx.set_config(&repo, "[core]\n fsmonitor = true\n bare = false\n");
    assert!(picked(&fx, &repo).config_risks.is_empty());
}

#[test]
fn hooks_and_gitattributes_filters_are_reported_by_name_only() {
    let fx = Fx::new();
    let repo = fx.repo("r");
    let hooks = repo.join(".git/hooks");
    fs::create_dir_all(&hooks).unwrap();
    fs::write(hooks.join("pre-commit"), "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(hooks.join("pre-commit"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(hooks.join("pre-push.sample"), "#!/bin/sh\n").unwrap();
    fs::set_permissions(hooks.join("pre-push.sample"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(hooks.join("commit-msg"), "not executable").unwrap();
    fs::write(repo.join(".gitattributes"), "# c\n*.bin filter=lfs diff=lfs\n").unwrap();
    let p = picked(&fx, &repo);
    assert_eq!(p.config_risks, vec!["gitattributes.filter".to_owned(), "hook:pre-commit".to_owned()]);
}

#[test]
fn a_config_edit_between_issue_and_redeem_is_risk_changed() {
    let fx = Fx::new();
    let repo = fx.repo("r");
    let t = fx.tokens();
    let v = fx.validator();
    let p = t.issue(v.validate(&s(&repo), &root_purpose()).unwrap(), &root_purpose());
    fx.set_config(&repo, "[core]\n fsmonitor = /tmp/evil.sh\n");
    let e = t.redeem(&p.token, &[root_purpose()], &v).err().expect("refused");
    assert_eq!(e.code, "riskChanged");
    // A changed value behind the same key is caught too (the digest covers values).
    fx.set_config(&repo, "[core]\n fsmonitor = /tmp/a.sh\n");
    let p = t.issue(v.validate(&s(&repo), &root_purpose()).unwrap(), &root_purpose());
    fx.set_config(&repo, "[core]\n fsmonitor = /tmp/b.sh\n");
    assert_eq!(t.redeem(&p.token, &[root_purpose()], &v).err().unwrap().code, "riskChanged");
}

#[test]
fn an_unchanged_repo_redeems_with_a_stable_digest() {
    let fx = Fx::new();
    let repo = fx.repo("r");
    fx.set_config(&repo, "[core]\n sshCommand = ssh -F x\n");
    let t = fx.tokens();
    let v = fx.validator();
    let a = v.validate(&s(&repo), &root_purpose()).unwrap();
    let p = t.issue(a.clone(), &root_purpose());
    let r = t.redeem(&p.token, &[root_purpose()], &v).unwrap();
    assert_eq!(r.validated.risk_digest, a.risk_digest);
    assert!(!r.validated.risk_digest.is_empty());
}
