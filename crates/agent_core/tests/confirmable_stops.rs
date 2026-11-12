//! Confirmable (tier 2) stops: an offer on the refusal, a grant that lifts exactly that stop, and tier 1 that no grant touches.

mod common;

use common::*;
use intely_agent_core::events::types::DecidedBy;
use intely_agent_core::policy::confirm::{ConfirmKind, StopGrant, ALL_OF_KIND};
use intely_agent_core::policy::decide::{decide, Decision, PolicyContext};
use intely_agent_core::policy::intent::ToolIntent;
use intely_agent_core::providers::PermissionMode as M;
use serde_json::json;

const ALL_MODES: [M; 5] = [M::Ask, M::Edit, M::Automatic, M::Bypass, M::ReadOnly];
const WORKING_MODES: [M; 4] = [M::Ask, M::Edit, M::Automatic, M::Bypass];

fn with(fx: &Fx, mode: M, f: impl FnOnce(&mut PolicyContext)) -> PolicyContext {
    let mut c = ctx(fx, mode);
    f(&mut c);
    c
}

fn read_env(c: &PolicyContext, fx: &Fx) -> intely_agent_core::policy::decide::PolicyDecision {
    decide_tool(c, "Read", json!({ "file_path": fx.cwd.join(".env").to_string_lossy() }))
}

fn grant(kind: ConfirmKind, scope: &str, tool: Option<&str>) -> StopGrant {
    StopGrant { kind, scope: scope.to_string(), tool_id: tool.map(str::to_string) }
}

#[test]
fn a_secret_file_in_the_project_is_refused_with_an_offer_in_every_working_mode() {
    let fx = fx();
    std::fs::write(fx.cwd.join(".env"), "A=1\n").unwrap();
    for m in WORKING_MODES.into_iter().chain([M::ReadOnly]) {
        let d = read_env(&ctx(&fx, m), &fx);
        assert_eq!((d.decision, d.by), (Decision::Deny, DecidedBy::HardStop), "{m:?}");
        let o = d.confirm.clone().unwrap_or_else(|| panic!("no offer in {m:?}: {d:?}"));
        assert_eq!(o.kind, ConfirmKind::SecretFile);
        assert_eq!(o.scope, fx.cwd.join(".env").to_string_lossy());
        assert_eq!(o.repo, fx.cwd.to_string_lossy());
    }
}

#[test]
fn only_a_grant_in_the_context_lifts_the_stop_and_only_that_one() {
    let fx = fx();
    std::fs::write(fx.cwd.join(".env"), "A=1\n").unwrap();
    std::fs::write(fx.cwd.join("other.pem"), "x").unwrap();
    let env = fx.cwd.join(".env").to_string_lossy().into_owned();
    for m in WORKING_MODES {
        // once: this tool call only
        let once = with(&fx, m, |c| c.stop_grants.push(grant(ConfirmKind::SecretFile, &env, Some("t1"))));
        assert_eq!(read_env(&once, &fx).decision, Decision::Allow, "{m:?}");
        let other_call = decide(&once, &intely_agent_core::policy::intent::PolicyRequest { tool_id: "t2".into(), ..request(ToolIntent::from_claude_tool("Read", &json!({"file_path": env}))) });
        assert_eq!(other_call.decision, Decision::Deny, "a once grant names its tool call: {m:?}");
        // the same grant does not cover another file, nor an edit
        let other = decide_tool(&once, "Read", json!({ "file_path": fx.cwd.join("other.pem").to_string_lossy() }));
        assert_eq!(other.decision, Decision::Deny, "{m:?}");
        // for the run
        let run = with(&fx, m, |c| c.stop_grants.push(grant(ConfirmKind::SecretFile, ALL_OF_KIND, None)));
        assert_eq!(read_env(&run, &fx).decision, Decision::Allow, "{m:?}");
        assert_eq!(decide_tool(&run, "Read", json!({ "file_path": fx.cwd.join("other.pem").to_string_lossy() })).decision, Decision::Allow, "{m:?}");
        let edit = decide_tool(&run, "Edit", json!({ "file_path": env, "old_string": "A", "new_string": "B" }));
        assert_eq!(edit.decision, Decision::Deny, "allowing a read never allows an edit: {m:?}");
    }
}

#[test]
fn a_grant_for_the_wrong_kind_or_scope_does_nothing() {
    let fx = fx();
    std::fs::write(fx.cwd.join(".env"), "A=1\n").unwrap();
    let c = with(&fx, M::Automatic, |c| {
        c.stop_grants.push(grant(ConfirmKind::CliPrompt, ALL_OF_KIND, None));
        c.stop_grants.push(grant(ConfirmKind::SecretEdit, ALL_OF_KIND, None));
        c.stop_grants.push(grant(ConfirmKind::SecretFile, "/elsewhere/.env", None));
    });
    assert_eq!(read_env(&c, &fx).decision, Decision::Deny);
}

#[test]
fn an_env_edit_is_offered_and_lifted_separately() {
    let fx = fx();
    std::fs::write(fx.cwd.join(".env"), "A=1\n").unwrap();
    let env = fx.cwd.join(".env").to_string_lossy().into_owned();
    let input = json!({ "file_path": env, "old_string": "A", "new_string": "B" });
    for m in WORKING_MODES {
        let d = decide_tool(&ctx(&fx, m), "Edit", input.clone());
        assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("fs.protected")), "{m:?}");
        assert_eq!(d.confirm.as_ref().map(|o| o.kind), Some(ConfirmKind::SecretEdit), "{m:?}");
        // (lifting the stop leaves the ordinary rules of the mode: Ask still asks, the rest allow)
        let c = with(&fx, m, |c| c.stop_grants.push(grant(ConfirmKind::SecretEdit, &env, None)));
        let after = decide_tool(&c, "Edit", input.clone()).decision;
        assert_eq!(after, if m == M::Ask { Decision::Ask } else { Decision::Allow }, "{m:?}");
    }
    // plan mode: a write is never allowed and never offered
    let d = decide_tool(&ctx(&fx, M::ReadOnly), "Edit", input.clone());
    assert_eq!(d.decision, Decision::Deny);
    assert!(d.confirm.is_none(), "{d:?}");
    let c = with(&fx, M::ReadOnly, |c| c.stop_grants.push(grant(ConfirmKind::SecretEdit, ALL_OF_KIND, None)));
    assert_eq!(decide_tool(&c, "Edit", input).decision, Decision::Deny, "a grant never makes a write possible in plan mode");
}

#[test]
fn a_shell_command_naming_a_secret_file_gets_an_offer() {
    let fx = fx();
    std::fs::write(fx.cwd.join(".env"), "A=1\n").unwrap();
    for m in WORKING_MODES {
        let d = bash(&ctx(&fx, m), "cat .env");
        assert_eq!((d.decision, d.rule.as_deref()), (Decision::Deny, Some("read.never-read")), "{m:?}");
        assert_eq!(d.confirm.as_ref().map(|o| o.kind), Some(ConfirmKind::SecretFile), "{m:?}");
    }
    let c = with(&fx, M::Automatic, |c| c.stop_grants.push(grant(ConfirmKind::SecretFile, ALL_OF_KIND, None)));
    assert_eq!(bash(&c, "cat .env").decision, Decision::Allow);
    // a script that spells the name is judged by its spelling and offered the same way
    std::fs::write(fx.cwd.join("a.js"), "require('fs').readFileSync('.env');\n").unwrap();
    let d = bash(&ctx(&fx, M::Automatic), "node a.js");
    assert_eq!(d.decision, Decision::Deny);
    assert_eq!(d.rule.as_deref(), Some("script.protected-path"));
    assert_eq!(d.confirm.as_ref().map(|o| o.kind), Some(ConfirmKind::SecretEdit), "{d:?}");
}

#[test]
fn tier_one_never_carries_an_offer_and_no_grant_lifts_it() {
    let fx = fx();
    let all = [
        grant(ConfirmKind::SecretFile, ALL_OF_KIND, None),
        grant(ConfirmKind::SecretEdit, ALL_OF_KIND, None),
        grant(ConfirmKind::CliPrompt, ALL_OF_KIND, None),
    ];
    let cmds = [
        "git commit -m x",
        "git push",
        "git add -A",
        "git reset --hard",
        "git update-ref refs/heads/x HEAD",
        "git log refs/intely/x",
        "cat ~/.ssh/id_rsa",
        "cat ~/.aws/credentials",
        "cat ~/.gnupg/pubring.kbx",
        "cat ~/.kube/config",
        "cat ~/.azure/x",
        "cat ~/.config/gh/hosts.yml",
        "cat ~/Library/Keychains/login.keychain-db",
        "cat ~/.zsh_history",
        "cat ~/.claude/.credentials.json",
        "cat .npmrc",
        "cat .netrc",
        "cat id_rsa",
        "cat .git-credentials",
        "echo x > .git/config",
        "echo x > .claude/settings.json",
        "echo x > .claude/hooks/a.sh",
        "echo x >> package-lock.json",
        "git -c core.hooksPath=x status",
        "GIT_DIR=x git status",
        "dd if=/dev/zero of=/dev/disk2",
        "rm -rf ~",
    ];
    for m in ALL_MODES {
        for cmd in cmds {
            for granted in [false, true] {
                let c = with(&fx, m, |c| {
                    if granted {
                        c.stop_grants.extend(all.clone());
                    }
                });
                let d = bash(&c, cmd);
                assert_eq!(d.decision, Decision::Deny, "{cmd} in {m:?} (grants: {granted}): {d:?}");
                assert!(d.confirm.is_none(), "{cmd} in {m:?} must carry no offer: {d:?}");
            }
        }
    }
    // tools: the .git and .claude trees, lockfiles, the credential folders
    for m in ALL_MODES {
        for (tool, path) in [
            ("Edit", ".git/config"),
            ("Write", ".git/hooks/pre-commit"),
            ("Write", ".claude/settings.json"),
            ("Write", ".claude/agents/a.md"),
            ("Edit", "package-lock.json"),
            ("Edit", "Cargo.lock"),
            ("Write", ".envrc"),
        ] {
            for granted in [false, true] {
                let c = with(&fx, m, |c| {
                    if granted {
                        c.stop_grants.extend(all.clone());
                    }
                });
                let d = decide_tool(&c, tool, json!({ "file_path": fx.cwd.join(path).to_string_lossy(), "content": "x", "old_string": "a", "new_string": "b" }));
                // (.envrc is not a secret name: it is an ordinary write that Ask and Edit would ask about, Automatic and Bypass allow;
                //  what matters is that it never carries an offer)
                assert!(d.confirm.is_none(), "{tool} {path} in {m:?}: {d:?}");
                if path != ".envrc" {
                    assert_eq!(d.decision, Decision::Deny, "{tool} {path} in {m:?} (grants: {granted}): {d:?}");
                }
            }
        }
    }
    let home = fx.cwd.join("home");
    for p in [".ssh/id_rsa", ".aws/credentials", ".claude/.credentials.json", ".zsh_history"] {
        for m in ALL_MODES {
            let c = with(&fx, m, |c| c.stop_grants.extend(all.clone()));
            let d = decide_tool(&c, "Read", json!({ "file_path": home.join(p).to_string_lossy() }));
            assert_eq!(d.decision, Decision::Deny, "{p} in {m:?}: {d:?}");
            assert!(d.confirm.is_none(), "{p} in {m:?}: {d:?}");
        }
    }
}

#[test]
fn a_secret_outside_the_run_or_behind_a_link_or_dotdot_is_tier_one() {
    let fx = fx();
    let sibling = tempfile::tempdir().unwrap();
    let sib = std::fs::canonicalize(sibling.path()).unwrap();
    std::fs::write(sib.join(".env"), "S=1\n").unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(sib.join(".env"), fx.cwd.join("link.env")).unwrap();
        std::os::unix::fs::symlink(&sib, fx.cwd.join("linkdir")).unwrap();
    }
    let rel_up = format!("../{}/.env", sib.file_name().unwrap().to_string_lossy());
    let mut targets = vec![sib.join(".env").to_string_lossy().into_owned(), fx.cwd.join(&rel_up).to_string_lossy().into_owned()];
    if cfg!(unix) {
        targets.push(fx.cwd.join("link.env").to_string_lossy().into_owned());
        targets.push(fx.cwd.join("linkdir/.env").to_string_lossy().into_owned());
    }
    let granted = [grant(ConfirmKind::SecretFile, ALL_OF_KIND, None), grant(ConfirmKind::SecretFile, &sib.join(".env").to_string_lossy(), None)];
    for m in ALL_MODES {
        for t in &targets {
            let d = decide_tool(&ctx(&fx, m), "Read", json!({ "file_path": t }));
            assert_eq!(d.decision, Decision::Deny, "{t} in {m:?}");
            assert!(d.confirm.is_none(), "{t} in {m:?}: {d:?}");
            let c = with(&fx, m, |c| c.stop_grants.extend(granted.clone()));
            // (the wildcard covers secrets INSIDE the run only; a path out of the run is judged as before)
            let d = decide_tool(&c, "Read", json!({ "file_path": t }));
            if m != M::Bypass || !t.starts_with(&*sib.to_string_lossy()) {
                assert_eq!(d.decision, Decision::Deny, "{t} in {m:?} with grants: {d:?}");
            }
            assert!(d.decision == Decision::Deny, "{t} in {m:?} with grants: {d:?}");
        }
    }
}

#[test]
fn an_always_entry_is_an_exact_path_of_one_repository() {
    let fx = fx();
    std::fs::write(fx.cwd.join(".env"), "A=1\n").unwrap();
    std::fs::create_dir_all(fx.cwd.join("sub")).unwrap();
    std::fs::write(fx.cwd.join("sub/.env"), "B=1\n").unwrap();
    let c = with(&fx, M::Automatic, |c| c.stop_grants.push(grant(ConfirmKind::SecretFile, &fx.cwd.join(".env").to_string_lossy(), None)));
    assert_eq!(read_env(&c, &fx).decision, Decision::Allow);
    // a sibling file with the same name in a sub folder is another path
    let d = decide_tool(&c, "Read", json!({ "file_path": fx.cwd.join("sub/.env").to_string_lossy() }));
    assert_eq!(d.decision, Decision::Deny);
    assert!(d.confirm.is_some(), "it is offered, as its own card");
    // `./sub/../.env` is the same file: the grant matches the normalized path
    let d = decide_tool(&c, "Read", json!({ "file_path": fx.cwd.join("sub/../.env").to_string_lossy() }));
    assert_eq!(d.decision, Decision::Allow);
}

#[test]
fn the_wire_form_of_the_decision_and_the_context_round_trips() {
    let fx = fx();
    std::fs::write(fx.cwd.join(".env"), "A=1\n").unwrap();
    let d = read_env(&ctx(&fx, M::Automatic), &fx);
    let v = serde_json::to_value(&d).unwrap();
    assert_eq!(v["confirm"]["kind"], "secretFile");
    assert_eq!(v["confirm"]["rule"], "read.never-read");
    let back: intely_agent_core::policy::decide::PolicyDecision = serde_json::from_value(v).unwrap();
    assert_eq!(back, d);
    let c = with(&fx, M::Ask, |c| c.stop_grants.push(grant(ConfirmKind::CliPrompt, "Contains brace with quote character", None)));
    let j = serde_json::to_value(&c).unwrap();
    assert_eq!(j["stopGrants"][0]["kind"], "cliPrompt");
    let c2: PolicyContext = serde_json::from_value(j).unwrap();
    assert_eq!(c2.stop_grants, c.stop_grants);
}
