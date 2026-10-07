//! The supplier (MCP spec 9.2 "resolve"): selection in, SDK config and broker rules out; secrets resolved only here.

mod common;

use std::collections::BTreeMap;
use std::sync::Arc;

use common::*;
use intely_agent_core::mcp::{fit, McpPolicy, McpSelection, McpServerRules, McpToolRule};
use intely_core::jail::Jail;
use intely_mcp::error::code;
use intely_mcp::types::*;
use intely_settings::SecretStore;
use serde_json::json;

fn sel(ids: &[&str], strict: bool, run_dirs: &[&std::path::Path]) -> McpSelection {
    McpSelection { ids: ids.iter().map(|s| (*s).to_owned()).collect(), strict, run_dirs: run_dirs.iter().map(|p| p.to_path_buf()).collect() }
}

fn patch(tool: &str, policy: Option<McpPolicy>) -> McpPolicyPatch {
    McpPolicyPatch { default_policy: None, tools: Some(vec![McpToolPatch { tool: tool.into(), policy, acknowledge_blocked: Some(true) }]) }
}

#[test]
fn stdio_and_http_resolve_to_the_sdk_shape_with_their_secrets() {
    let fx = Fx::new();
    let a = fx.save_confirmed(stdio_input("fixture", vec![var_in("FIXTURE_TOKEN", CANARY), var_plain("LOG_LEVEL", "info")]));
    let b = fx.save_confirmed(http_input("web", "https://example.com/mcp", vec![var_in("Authorization", &format!("Bearer {CANARY}")), var_plain("X-Region", "eu")]));
    let r = fx.store.resolve(&sel(&[&a.id, &b.id], true, &[])).unwrap();
    let servers = serde_json::to_value(&r.servers).unwrap();
    assert_eq!(servers["fixture"]["type"], "stdio");
    assert_eq!(servers["fixture"]["command"], server_script().to_string_lossy().as_ref());
    assert_eq!(servers["fixture"]["env"], json!({ "FIXTURE_TOKEN": CANARY, "LOG_LEVEL": "info" }));
    assert_eq!(servers["web"], json!({ "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": format!("Bearer {CANARY}"), "X-Region": "eu" } }));
    assert_eq!(r.names, ["fixture", "web"]);
    assert_eq!(r.ids["fixture"], a.id);
    assert_eq!(r.ids["web"], b.id);
    assert!(r.rules.contains_key("fixture") && r.rules.contains_key("web"));
    assert_eq!(r.code_paths, vec![std::fs::canonicalize(server_script()).unwrap()], "the canonical code file of the stdio server");
    assert!(r.skipped.is_empty());
    // nothing prints a secret
    assert!(!format!("{r:?}").contains(CANARY));
    assert!(!format!("{:?}", r.servers).contains(CANARY));
    assert!(!format!("{:?}", fx.store.resolve(&sel(&["mnope"], true, &[])).err()).contains(CANARY));
}

#[test]
fn an_empty_selection_resolves_to_nothing() {
    let fx = Fx::with(|c| c.jail = Arc::new(Jail::read_only()));
    let r = fx.store.resolve(&sel(&[], true, &[])).unwrap();
    assert!(r.servers.is_empty() && r.names.is_empty());
}

#[test]
fn strict_fails_and_a_resume_skips() {
    let fx = Fx::new();
    let a = fx.save_confirmed(stdio_input("fixture", vec![var_in("FIXTURE_TOKEN", CANARY)]));
    let b = fx.save_confirmed(http_input("web", "https://example.com/mcp", vec![]));
    fx.secrets.remove(&format!("mcp.{}:env.FIXTURE_TOKEN", a.id)).unwrap();
    let e = fx.store.resolve(&sel(&[&a.id, &b.id], true, &[])).err().unwrap();
    assert_eq!(e.code, code::SECRET_MISSING);
    assert!(e.message.contains("fixture") && !e.message.contains(CANARY));
    let r = fx.store.resolve(&sel(&[&a.id, &b.id, "mgone"], false, &[])).unwrap();
    assert_eq!(r.names, ["web"]);
    assert_eq!(r.skipped.iter().map(|s| (s.name.as_str(), s.reason.as_str())).collect::<Vec<_>>(), [("fixture", code::SECRET_MISSING), ("mgone", code::UNKNOWN_SERVER)]);
    assert_eq!(fx.store.resolve(&sel(&["mgone"], true, &[])).err().unwrap().code, code::UNKNOWN_SERVER);
}

#[test]
fn an_unconfirmed_or_edited_server_does_not_start() {
    let fx = Fx::new();
    let v = fx.store.save(http_input("web", "https://example.com/mcp", vec![])).unwrap();
    assert_eq!(fx.store.resolve(&sel(&[&v.id], true, &[])).err().unwrap().code, code::CONFIRMATION_REQUIRED);
    let v = fx.store.confirm(&v.id, &v.confirm_hash).unwrap();
    assert!(fx.store.resolve(&sel(&[&v.id], true, &[])).is_ok());
    let mut i = http_input("web", "https://example.com/other", vec![]);
    i.id = Some(v.id.clone());
    fx.store.save(i).unwrap();
    assert_eq!(fx.store.resolve(&sel(&[&v.id], true, &[])).err().unwrap().code, code::CONFIRMATION_REQUIRED);
}

#[test]
fn the_jail_and_the_auth_mode_refuse_a_selection() {
    let fx = Fx::new();
    let v = fx.save_confirmed(http_input("web", "https://example.com/mcp", vec![]));
    // the read-only jail
    let ro = Fx::with(|c| c.jail = Arc::new(Jail::read_only()));
    let w = ro.save_confirmed(http_input("web", "https://example.com/mcp", vec![]));
    assert_eq!(ro.store.resolve(&sel(&[&w.id], true, &[])).err().unwrap().code, code::READ_ONLY);
    assert_eq!(ro.store.run_servers(None, "claude").unwrap()[0].unavailable.as_deref(), Some("readOnlyJail"));
    // the e2e jail allows loopback http only
    let root = tempfile::tempdir().unwrap();
    let e2e = Fx::with(|c| c.jail = Arc::new(Jail::e2e(root.path())));
    let w = e2e.save_confirmed(http_input("web", "https://example.com/mcp", vec![]));
    assert_eq!(e2e.store.resolve(&sel(&[&w.id], true, &[])).err().unwrap().code, code::TEST_JAIL);
    let l = e2e.save_confirmed(http_input("local", "http://127.0.0.1:9/mcp", vec![]));
    assert!(e2e.store.resolve(&sel(&[&l.id], true, &[])).is_ok());
    // apiKey mode: the key would reach every server
    let api = Fx::with(|c| c.auth_mode = Arc::new(|| "apiKey".to_owned()));
    let w = api.save_confirmed(http_input("web", "https://example.com/mcp", vec![]));
    assert_eq!(api.store.resolve(&sel(&[&w.id], true, &[])).err().unwrap().code, code::AUTH_MODE_UNSUPPORTED);
    assert!(api.store.run_servers(None, "claude").unwrap().iter().all(|s| s.unavailable.as_deref() == Some("unsupportedAuth")));
    assert!(fx.store.run_servers(None, "claude").unwrap()[0].available);
    let _ = v;
}

#[test]
fn the_run_picker_data() {
    let fx = Fx::new();
    let a = fx.save_confirmed(stdio_input("fixture", vec![var_in("FIXTURE_TOKEN", CANARY)]));
    let b = fx.store.save(http_input("web", "https://example.com/mcp", vec![])).unwrap();
    let c = fx.save_confirmed(stdio_input("lost", vec![McpVarInput { name: "FIXTURE_TOKEN".into(), secret: true, value: None, secret_value: None }]));
    let list = fx.store.run_servers(None, "claude").unwrap();
    let get = |id: &str| list.iter().find(|s| s.id == id).unwrap();
    assert!(get(&a.id).available && get(&a.id).has_secret_env);
    assert_eq!(get(&b.id).unavailable.as_deref(), Some("needsConfirm"));
    assert_eq!(get(&c.id).unavailable.as_deref(), Some("secretMissing"));
    assert!(fx.store.run_servers(None, "codex").unwrap().iter().all(|s| s.unavailable.as_deref() == Some("unsupportedProvider")));
    assert!(fx.store.run_servers(None, "mock").unwrap().iter().any(|s| s.available));
    assert!(!get(&a.id).has_denied);
    fx.store.set_policy(&a.id, McpPolicyPatch { default_policy: Some(McpPolicy::Deny), tools: None }).unwrap();
    assert!(fx.store.run_servers(None, "claude").unwrap().iter().find(|s| s.id == a.id).unwrap().has_denied);
}

#[tokio::test]
async fn rules_come_from_the_last_test_and_follow_the_policies() {
    need_node!();
    let fx = Fx::new();
    let name = "a-server-with-a-long-name"; // 25 characters: the long tool name no longer fits
    let v = fx.save_confirmed(stdio_input(name, vec![]));
    // never tested: nothing is learned or fresh
    let r = fx.store.resolve(&sel(&[&v.id], true, &[])).unwrap();
    let rules = &r.rules[name];
    assert!(!rules.fresh && rules.tools.is_empty());
    assert!(fx.store.test(&v.id, None).await.unwrap().ok);
    fx.store.set_policy(&v.id, patch("write_note", Some(McpPolicy::Deny))).unwrap();
    fx.store.set_policy(&v.id, patch("dup_", Some(McpPolicy::Allow))).unwrap();
    fx.store.set_policy(&v.id, patch("gone_tool", Some(McpPolicy::Deny))).unwrap();
    let r = fx.store.resolve(&sel(&[&v.id], true, &[])).unwrap();
    let rules = &r.rules[name];
    assert!(rules.fresh);
    let tool = |k: &str| rules.tools.get(k).unwrap_or_else(|| panic!("{k} in {:?}", rules.tools.keys().collect::<Vec<_>>()));
    assert_eq!(*tool("echo"), McpToolRule { policy: None, read_only: true, learned: true });
    assert!(!tool("mystery").read_only && tool("mystery").learned);
    assert_eq!(tool("write_note").policy, Some(McpPolicy::Deny), "an override is carried");
    assert_eq!(tool("git_commit").policy, Some(McpPolicy::Deny), "the seeded Deny is an ordinary override for the broker");
    assert!(!tool("dup_").read_only && tool("dup_").learned, "two tools with one exposed name get no read-only flag");
    assert_eq!(*tool("gone_tool"), McpToolRule { policy: Some(McpPolicy::Deny), read_only: false, learned: false }, "an override for an unlisted tool stays");
    let long = "a_very_long_tool_name_that_pushes_the_whole_exposed_name_over_sixty_four_chars";
    let fitted = fit(name, long);
    assert!(fitted.len() < long.len() && format!("mcp__{name}__{fitted}").len() <= 64);
    assert!(rules.tools.contains_key(&fitted), "keys are cut with the CURRENT server name");
    assert_eq!(rules.effective("echo").read_only, true);
    assert!(rules.exposed() >= 1);
    // a changed command line makes the list stale: every read-only flag goes, overrides stay
    let cur = fx.store.list(None).unwrap().servers.remove(0);
    let mut i = stdio_input(name, vec![]);
    i.id = Some(cur.id.clone());
    i.args = Some(vec!["--extra".into()]);
    let edited = fx.store.save(i).unwrap();
    assert!(edited.tools_stale);
    fx.store.confirm(&edited.id, &edited.confirm_hash).unwrap();
    let r = fx.store.resolve(&sel(&[&v.id], true, &[])).unwrap();
    let rules = &r.rules[name];
    assert!(!rules.fresh);
    assert!(rules.tools.values().all(|t| !t.read_only), "a stale list has no read-only flag");
    assert_eq!(rules.tools["write_note"].policy, Some(McpPolicy::Deny));
    assert!(rules.tools["echo"].learned, "learned stays: it names what the last Test saw");
    assert!(!rules.effective("echo").listed);
}

#[tokio::test]
async fn the_live_rules_query_uses_the_name_the_run_knows() {
    need_node!();
    let fx = Fx::new();
    let v = fx.save_confirmed(stdio_input("fixture", vec![]));
    assert!(fx.store.test(&v.id, None).await.unwrap().ok);
    fx.store.set_policy(&v.id, patch("write_note", Some(McpPolicy::Deny))).unwrap();
    let mut i = stdio_input("renamed-fixture", vec![]);
    i.id = Some(v.id.clone());
    fx.store.save(i).unwrap();
    let up = fx.store.rules_for(&[(v.id.clone(), "fixture".into()), ("mgone".into(), "x".into())]);
    assert_eq!(up.len(), 2);
    let rules = up[0].rules.as_ref().unwrap();
    assert_eq!(rules.tools["write_note"].policy, Some(McpPolicy::Deny), "keyed with the run's name, so it lines up with the snapshot");
    assert!(up[1].rules.is_none(), "a removed server");
}

#[test]
fn the_scrub_list_has_every_secret_value_and_never_prints() {
    let fx = Fx::new();
    let a = fx.save_confirmed(stdio_input("fixture", vec![var_in("FIXTURE_TOKEN", CANARY)]));
    let b = fx.save_confirmed(http_input("web", "https://example.com/mcp", vec![var_in("Authorization", "Bearer other-secret-9")]));
    let s = fx.store.scrub_secrets(&[a.id.clone(), b.id.clone(), "mgone".into()]).unwrap();
    let mut v = s.values().to_vec();
    v.sort();
    assert_eq!(v, ["Bearer other-secret-9", CANARY]);
    assert!(!format!("{s:?}").contains(CANARY));
}

#[test]
fn code_that_lies_where_the_agent_can_write_is_refused() {
    let run = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let inside = run.path().join("srv.sh");
    std::fs::write(&inside, "echo hi\n").unwrap();
    let outside = elsewhere.path().join("srv.sh");
    std::fs::write(&outside, "echo hi\n").unwrap();
    let fx = Fx::with(|c| c.temp_dirs = vec![]);
    let mk = |name: &str, cmd: &str, args: &[&str]| {
        let mut i = stdio_input(name, vec![]);
        i.command = Some(cmd.into());
        i.args = Some(args.iter().map(|s| (*s).to_owned()).collect());
        fx.save_confirmed(i).id
    };
    let cases = [
        ("exe-in-run", mk("exe-in-run", "/bin/sh", &[inside.to_str().unwrap()])),
        ("relative", mk("relative", "/bin/sh", &["srv.sh"])),
    ];
    for (n, id) in &cases {
        assert_eq!(fx.store.resolve(&sel(&[id], true, &[run.path()])).err().unwrap().code, code::CODE_IN_RUN_DIR, "{n}");
    }
    let ok = mk("outside", "/bin/sh", &[outside.to_str().unwrap()]);
    assert!(fx.store.resolve(&sel(&[&ok], true, &[run.path()])).is_ok());
    // the same file, reached through a symlink inside the run directory, is judged by its target
    let link_dir = run.path().join("bin");
    std::fs::create_dir(&link_dir).unwrap();
    std::os::unix::fs::symlink(&outside, link_dir.join("link.sh")).unwrap();
    let via = mk("via-link", "/bin/sh", &[link_dir.join("link.sh").to_str().unwrap()]);
    assert!(fx.store.resolve(&sel(&[&via], true, &[run.path()])).is_ok(), "the target is outside the run directory");
    // the message names the server and no path of the run
    let msg = fx.store.resolve(&sel(&[&cases[0].1], true, &[run.path()])).err().unwrap().message;
    assert!(msg.contains("exe-in-run") && !msg.contains(run.path().to_str().unwrap()), "{msg}");
    // a temporary directory (jail off)
    let fx2 = Fx::new();
    let mut i = stdio_input("tmp-code", vec![]);
    i.command = Some("/bin/sh".into());
    i.args = Some(vec![outside.to_string_lossy().into_owned()]);
    let t = fx2.save_confirmed(i);
    assert_eq!(fx2.store.resolve(&sel(&[&t.id], true, &[])).err().unwrap().code, code::CODE_IN_RUN_DIR);
    // a package runner with a planted copy
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("repo");
    std::fs::create_dir_all(project.join("node_modules/.bin")).unwrap();
    std::fs::write(project.join("node_modules/.bin/pkg"), "x").unwrap();
    let npx = mk("npx-pkg", "npx", &["-y", "pkg"]);
    assert_eq!(fx.store.resolve(&sel(&[&npx], true, &[&project.join("sub")])).err().unwrap().code, code::CODE_IN_RUN_DIR);
    std::fs::remove_file(project.join("node_modules/.bin/pkg")).unwrap();
    assert!(fx.store.resolve(&sel(&[&npx], true, &[&project.join("sub")])).is_ok(), "no planted copy, no refusal");
}

// ---- McpServerRules::tighten ----------------------------------------------------------------------------------------------------------------

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }

    fn policy(&mut self) -> McpPolicy {
        [McpPolicy::Allow, McpPolicy::Ask, McpPolicy::Deny][(self.next() % 3) as usize]
    }

    fn rules(&mut self) -> McpServerRules {
        let mut tools = BTreeMap::new();
        for k in ["a", "b", "c", "d", "e"] {
            if self.next() % 3 != 0 {
                let policy = (self.next() % 2 == 0).then(|| self.policy());
                tools.insert(k.to_owned(), McpToolRule { policy, read_only: self.next() % 2 == 0, learned: self.next() % 4 != 0 });
            }
        }
        McpServerRules { default_policy: self.policy(), tools, fresh: self.next() % 2 == 0 }
    }
}

#[test]
fn tighten_never_loosens_property() {
    let mut rng = Lcg(0x5eed);
    for round in 0..500 {
        let (old, newer) = (rng.rules(), rng.rules());
        let mut merged = old.clone();
        merged.tighten(&newer);
        for key in ["a", "b", "c", "d", "e", "unknown"] {
            let before = old.effective(key);
            let after = merged.effective(key);
            assert!(after.policy == before.policy || after.policy == before.policy.stricter(after.policy), "round {round} {key}: {before:?} -> {after:?}");
            assert_eq!(after.policy.stricter(before.policy), after.policy, "round {round} {key}: the policy got weaker");
            assert!(!after.read_only || before.read_only, "round {round} {key}: read_only appeared");
            assert!(!merged.fresh || old.fresh, "round {round}: fresh appeared");
        }
        assert_eq!(merged.default_policy.stricter(old.default_policy), merged.default_policy);
    }
    // a removed server tightens to deny-all
    let mut live = Lcg(7).rules();
    live.tighten(&McpServerRules { default_policy: McpPolicy::Deny, tools: BTreeMap::new(), fresh: false });
    assert_eq!(live.default_policy, McpPolicy::Deny);
    assert!(!live.fresh);
    assert_eq!(live.effective("anything").policy, McpPolicy::Deny);
}
