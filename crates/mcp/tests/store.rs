//! The config store (MCP spec 9.2 "store"): persistence, the proof in the Keychain, secrets, policies, workspace overrides, seeding and the Test.

mod common;

use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use intely_agent_core::mcp::McpPolicy;
use intely_mcp::error::code;
use intely_mcp::types::*;
use intely_settings::{SecretStore, SettingsStore};
use serde_json::{json, Value};

fn ids(l: &McpList) -> Vec<String> {
    l.servers.iter().map(|s| s.name.clone()).collect()
}

fn patch_tool(tool: &str, policy: Option<McpPolicy>, ack: bool) -> McpPolicyPatch {
    McpPolicyPatch { default_policy: None, tools: Some(vec![McpToolPatch { tool: tool.into(), policy, acknowledge_blocked: ack.then_some(true) }]) }
}

fn code_of<T>(r: Result<T, intely_mcp::McpErr>) -> String {
    r.err().map(|e| e.code).unwrap_or_default()
}

#[test]
fn an_empty_store_lists_nothing_and_writes_nothing() {
    let fx = Fx::new();
    let l = fx.store.list(None).unwrap();
    assert!(l.servers.is_empty() && l.problems.is_empty() && l.schema == 1 && l.read_only_reason.is_none());
    assert_eq!(l.jail, McpJail::Off);
    assert!(!fx.settings.path().exists(), "reading creates no file");
}

#[test]
fn awkward_names_round_trip_unchanged_and_the_file_has_no_user_chosen_keys() {
    let fx = Fx::new();
    let v = fx.store.save(stdio_input("fs", vec![var_in("GITHUB_TOKEN", CANARY), var_plain("LOG_LEVEL", "info")])).unwrap();
    // a tool called api_key_rotate as a policy entry: the settings store would refuse it as an object KEY, never as an array entry
    fx.store.set_policy(&v.id, patch_tool("api_key_rotate", Some(McpPolicy::Deny), false)).unwrap();
    let back = fx.store.list(None).unwrap().servers.remove(0);
    assert_eq!(back.env.iter().map(|e| (e.name.as_str(), e.secret, e.present)).collect::<Vec<_>>(), [("GITHUB_TOKEN", true, true), ("LOG_LEVEL", false, true)]);
    assert_eq!(back.env[1].value.as_deref(), Some("info"));
    assert!(back.env[0].value.is_none(), "a secret value is never returned");
    assert_eq!(back.stale_tool_policies, vec![McpStalePolicy { tool: "api_key_rotate".into(), policy: McpPolicy::Deny }]);
    let file: Value = serde_json::from_str(&fx.settings_text()).unwrap();
    assert_eq!(file["mcp"]["schema"], 1);
    assert_eq!(file["mcp"]["servers"][0]["toolPolicies"][0], json!({ "tool": "api_key_rotate", "policy": "deny" }));
    assert_eq!(file["mcp"]["servers"][0]["env"][0], json!({ "name": "GITHUB_TOKEN", "secret": true }));
}

#[test]
fn no_secret_value_reaches_the_settings_file_or_any_file() {
    let fx = Fx::new();
    let mut input = stdio_input("fs", vec![var_in("API_TOKEN", CANARY)]);
    input.command = Some("/bin/echo".into());
    let v = fx.store.save(input).unwrap();
    fx.store.confirm(&v.id, &v.confirm_hash).unwrap();
    fx.store.save(http_input("web", "https://example.com/mcp", vec![var_in("Authorization", &format!("Bearer {CANARY}"))])).unwrap();
    assert!(!fx.all_text().contains(CANARY), "the canary is in a file");
    let key = format!("mcp.{}:env.API_TOKEN", v.id);
    assert_eq!(fx.secrets.get(&key).unwrap().unwrap().expose(), CANARY, "it is in the secret store");
    assert!(fx.secrets.has(&format!("mcp.{}:confirmed", v.id)).unwrap());
}

#[test]
fn unknown_keys_survive_every_write() {
    let existing = json!({ "version": 1, "other": { "x": 1 }, "mcp": { "schema": 1, "futureTop": [1, 2], "servers": [
        { "id": "m0123456789ab", "name": "old", "transport": "stdio", "command": "/bin/echo", "args": [], "enabled": false, "futureField": { "a": 1 } }
    ], "workspaces": [] } });
    let fx = Fx::with_file(&existing.to_string());
    fx.store.save(http_input("web", "https://example.com/mcp", vec![])).unwrap();
    let file: Value = serde_json::from_str(&fx.settings_text()).unwrap();
    assert_eq!(file["other"], json!({ "x": 1 }));
    assert_eq!(file["mcp"]["futureTop"], json!([1, 2]));
    assert_eq!(file["mcp"]["servers"][0]["futureField"], json!({ "a": 1 }));
    assert_eq!(file["mcp"]["servers"][1]["name"], "web");
}

#[test]
fn a_newer_schema_is_read_only_and_never_overwritten() {
    let text = json!({ "version": 1, "mcp": { "schema": 2, "servers": [] } }).to_string();
    let fx = Fx::with_file(&text);
    let l = fx.store.list(None).unwrap();
    assert_eq!(l.read_only_reason.as_deref(), Some("newerSchema"));
    assert_eq!(l.schema, 2);
    assert_eq!(code_of(fx.store.save(http_input("web", "https://example.com/mcp", vec![]))), code::UNSUPPORTED_VERSION);
    assert_eq!(code_of(fx.store.remove("m0123456789ab")), code::UNSUPPORTED_VERSION);
    assert_eq!(code_of(fx.store.workspace_set("w", "m0123456789ab", McpWorkspaceState::On)), code::UNSUPPORTED_VERSION);
    assert_eq!(fx.settings_text(), text, "the file bytes are unchanged");
}

#[test]
fn a_malformed_record_is_skipped_listed_kept_and_removable_by_index() {
    let existing = json!({ "version": 1, "mcp": { "schema": 1, "servers": [
        { "id": "m0123456789ab", "name": "good", "transport": "stdio", "command": "/bin/echo", "enabled": false },
        { "id": "mbad", "name": 5, "transport": "nonsense" }
    ] } });
    let fx = Fx::with_file(&existing.to_string());
    let l = fx.store.list(None).unwrap();
    assert_eq!(ids(&l), ["good"]);
    assert_eq!(l.problems.len(), 1);
    assert_eq!(l.problems[0].index, 1);
    let before = fx.settings_text();
    fx.store.list(None).unwrap();
    assert_eq!(fx.settings_text(), before, "listing never rewrites the file");
    fx.store.save(http_input("web", "https://example.com/mcp", vec![])).unwrap();
    let file: Value = serde_json::from_str(&fx.settings_text()).unwrap();
    assert_eq!(file["mcp"]["servers"][1]["id"], "mbad", "the malformed entry is kept as it was");
    assert_eq!(code_of(fx.store.remove("index:0")), code::UNKNOWN_SERVER, "only a problem entry can be removed by index");
    fx.store.remove("index:1").unwrap();
    assert!(fx.store.list(None).unwrap().problems.is_empty());
}

#[test]
fn what_needs_a_new_confirmation() {
    let fx = Fx::new();
    let a = fx.save_confirmed(stdio_input("fs", vec![var_in("API_TOKEN", "first-secret-value"), var_plain("LOG_LEVEL", "info")]));
    assert!(a.confirmed && a.state == McpState::Ready, "{:?}", a.state);
    let again = |change: &dyn Fn(&mut McpSaveInput)| {
        let mut i = stdio_input("fs", vec![var_in("API_TOKEN", "first-secret-value"), var_plain("LOG_LEVEL", "info")]);
        i.id = Some(a.id.clone());
        change(&mut i);
        fx.store.save(i).unwrap()
    };
    // a secret VALUE edit and a policy edit keep the proof
    assert!(again(&|i| i.env.as_mut().unwrap()[0] = var_in("API_TOKEN", "second-secret-value")).confirmed);
    fx.store.set_policy(&a.id, McpPolicyPatch { default_policy: Some(McpPolicy::Deny), tools: None }).unwrap();
    assert!(fx.store.list(None).unwrap().servers[0].confirmed);
    // a plain value, the command line, a variable name or flag need a new confirmation
    assert!(!again(&|i| i.env.as_mut().unwrap()[1] = var_plain("LOG_LEVEL", "debug")).confirmed, "a plain value");
    let reconfirm = |v: McpServerView| fx.store.confirm(&v.id, &v.confirm_hash).unwrap();
    reconfirm(again(&|_| {}));
    assert!(!again(&|i| i.args = Some(vec!["--flag".into()])).confirmed, "an argument");
    reconfirm(again(&|_| {}));
    assert!(!again(&|i| i.env.as_mut().unwrap()[0] = var_in("OTHER_TOKEN", "x-secret-value")).confirmed, "a secret NAME");
}

#[test]
fn a_confirmed_hash_written_into_the_file_proves_nothing() {
    // first make a real record and read its hash, then plant a record that claims it
    let fx = Fx::new();
    let v = fx.store.save(http_input("web", "https://example.com/mcp", vec![])).unwrap();
    let claimed = v.confirm_hash.clone();
    let planted = json!({ "version": 1, "mcp": { "schema": 1, "servers": [
        { "id": "m0123456789ab", "name": "web", "transport": "http", "url": "https://example.com/mcp", "enabled": true, "confirmedHash": claimed }
    ] } });
    let fx = Fx::with_file(&planted.to_string());
    let l = fx.store.list(None).unwrap();
    assert!(!l.servers[0].confirmed && l.servers[0].state == McpState::NeedsConfirm, "{:?}", l.servers[0].state);
    assert_eq!(code_of(fx.store.set_enabled("m0123456789ab", true)), code::CONFIRMATION_REQUIRED);
    let sel = intely_agent_core::mcp::McpSelection { ids: vec!["m0123456789ab".into()], strict: true, run_dirs: vec![] };
    assert_eq!(fx.store.resolve(&sel).err().unwrap().code, code::CONFIRMATION_REQUIRED, "an enabled server in the file runs nothing");
    fx.store.save({
        let mut i = http_input("web", "https://example.com/mcp", vec![]);
        i.id = Some("m0123456789ab".into());
        i
    })
    .unwrap();
    let file: Value = serde_json::from_str(&fx.settings_text()).unwrap();
    assert!(file["mcp"]["servers"][0].get("confirmedHash").is_none(), "dropped at the next save");
}

#[test]
fn confirm_needs_the_recomputed_hash_and_removal_deletes_every_item() {
    let fx = Fx::new();
    let v = fx.store.save(stdio_input("fs", vec![var_in("API_TOKEN", CANARY)])).unwrap();
    assert_eq!(fx.store.confirm(&v.id, "deadbeef").err().map(|e| e.code), Some(code::CONFIRMATION_REQUIRED.to_owned()));
    assert!(!fx.secrets.has(&format!("mcp.{}:confirmed", v.id)).unwrap());
    fx.store.confirm(&v.id, &v.confirm_hash).unwrap();
    assert!(fx.secrets.has(&format!("mcp.{}:confirmed", v.id)).unwrap());
    fx.store.workspace_set("w1", &v.id, McpWorkspaceState::On).unwrap();
    fx.store.remove(&v.id).unwrap();
    for key in [format!("mcp.{}:confirmed", v.id), format!("mcp.{}:env.API_TOKEN", v.id)] {
        assert!(!fx.secrets.has(&key).unwrap(), "{key} remains");
    }
    let l = fx.store.list(Some("w1")).unwrap();
    assert!(l.servers.is_empty() && l.workspace.overrides.is_empty(), "the overrides go with the server");
    assert_eq!(code_of(fx.store.remove(&v.id)), code::UNKNOWN_SERVER);
}

#[test]
fn secret_slots_follow_the_record() {
    let fx = Fx::new();
    let v = fx.store.save(stdio_input("fs", vec![var_in("A_TOKEN", "value-a-secret"), var_in("B_TOKEN", "value-b-secret")])).unwrap();
    let key = |n: &str| format!("mcp.{}:env.{n}", v.id);
    assert!(fx.secrets.has(&key("A_TOKEN")).unwrap() && fx.secrets.has(&key("B_TOKEN")).unwrap());
    // keep A (no secretValue), drop B, make C a secret slot with no value yet
    let mut i = stdio_input("fs", vec![McpVarInput { name: "A_TOKEN".into(), secret: true, value: None, secret_value: None }, McpVarInput { name: "C_TOKEN".into(), secret: true, value: None, secret_value: None }]);
    i.id = Some(v.id.clone());
    let v2 = fx.store.save(i).unwrap();
    assert!(fx.secrets.has(&key("A_TOKEN")).unwrap(), "an untouched slot keeps its item");
    assert!(!fx.secrets.has(&key("B_TOKEN")).unwrap(), "a removed slot loses its item");
    assert_eq!(v2.state, McpState::NeedsConfirm);
    let c = v2.env.iter().find(|e| e.name == "C_TOKEN").unwrap();
    assert!(c.secret && !c.present, "a slot without an item is reported missing");
    // a secret becoming plain loses its item (the plain value has to be typed: a stored secret is never revealed)
    let mut i = stdio_input("fs", vec![var_in("LOG_LEVEL", "secret-log-level")]);
    i.id = Some(v.id.clone());
    fx.store.save(i).unwrap();
    assert!(fx.secrets.has(&key("LOG_LEVEL")).unwrap());
    let mut i = stdio_input("fs", vec![var_plain("LOG_LEVEL", "info")]);
    i.id = Some(v.id.clone());
    fx.store.save(i).unwrap();
    assert!(!fx.secrets.has(&key("LOG_LEVEL")).unwrap());
    // changing the transport clears the other transport's items
    let mut h = http_input("fs", "https://example.com/mcp", vec![var_in("Authorization", "Bearer secret-header-value")]);
    h.id = Some(v.id.clone());
    fx.store.save(h).unwrap();
    assert!(fx.secrets.has(&format!("mcp.{}:hdr.Authorization", v.id)).unwrap());
    let mut back = stdio_input("fs", vec![]);
    back.id = Some(v.id.clone());
    fx.store.save(back).unwrap();
    assert!(!fx.secrets.has(&format!("mcp.{}:hdr.Authorization", v.id)).unwrap());
}

#[test]
fn a_failed_namespace_write_rolls_back_the_new_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let locked = dir.path().join("locked");
    std::fs::create_dir(&locked).unwrap();
    let settings = Arc::new(SettingsStore::open(locked.join("settings.json")).unwrap());
    let secrets = Arc::new(intely_settings::MemorySecretStore::new());
    let store = intely_mcp::McpStore::new(settings, Arc::clone(&secrets) as Arc<dyn SecretStore>, intely_mcp::StoreConfig::new(Arc::new(intely_core::jail::Jail::off())));
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o500)).unwrap();
    let r = store.save(stdio_input("fs", vec![var_in("API_TOKEN", CANARY)]));
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(code_of(r), code::IO);
    let dbg = format!("{secrets:?}");
    assert!(!dbg.contains("API_TOKEN"), "the just-written item was deleted again: {dbg}");
    assert!(store.list(None).unwrap().servers.is_empty());
}

#[test]
fn save_validates_and_names_the_field() {
    let fx = Fx::new();
    let first = fx.store.save(stdio_input("fs", vec![])).unwrap();
    assert_eq!(code_of(fx.store.save(stdio_input("fs", vec![]))), code::NAME_TAKEN);
    assert_eq!(code_of(fx.store.save(stdio_input("Bad Name", vec![]))), code::BAD_NAME);
    let mut i = stdio_input("other", vec![var_in("A_TOKEN", "")]);
    assert_eq!(code_of(fx.store.save(i.clone())), code::BAD_SECRET);
    i.command = Some("./relative".into());
    i.env = None;
    let e = fx.store.save(i).err().unwrap();
    assert_eq!((e.code.as_str(), e.detail.as_deref()), (code::RELATIVE_PATH, Some("command")));
    let mut i = stdio_input("fs2", vec![]);
    i.id = Some("m000000000000".into());
    assert_eq!(code_of(fx.store.save(i)), code::UNKNOWN_SERVER);
    // renaming to the same name keeps the id
    let mut i = stdio_input("fs", vec![]);
    i.id = Some(first.id.clone());
    assert_eq!(fx.store.save(i).unwrap().id, first.id);
    // the 32-server cap
    let fx = Fx::new();
    for n in 0..32 {
        fx.store.save(http_input(&format!("s{n}"), "https://example.com/mcp", vec![])).unwrap();
    }
    assert_eq!(code_of(fx.store.save(http_input("one-more", "https://example.com/mcp", vec![]))), code::TOO_MANY);
}

#[test]
fn a_four_thousand_character_argument_is_stored_and_shown_complete() {
    let fx = Fx::new();
    let long = format!("{}TAIL-MARKER", "a".repeat(4085));
    assert_eq!(long.len(), 4096);
    let mut i = stdio_input("fs", vec![]);
    i.args = Some(vec![long.clone(), "  padded  ".into(), "\u{e9}".into()]);
    let v = fx.store.save(i).unwrap();
    assert_eq!(v.args_display[0], long, "never truncated: the tail is in the dialog's text");
    assert_eq!(v.args_display[1], "\u{2423}\u{2423}padded\u{2423}\u{2423}", "padding is made visible");
    assert_eq!(v.args_display[2], "\\u{e9}", "non-ASCII is escaped");
    assert!(v.command_line.as_deref().unwrap().contains("\\u{e9}"));
    let mut tab = stdio_input("fs2", vec![]);
    tab.args = Some(vec!["tab\there".into()]);
    assert_eq!(code_of(fx.store.save(tab)), code::BAD_CHARS);
}

#[test]
fn workspace_overrides_are_a_tri_state() {
    let fx = Fx::new();
    let mut on = http_input("a", "https://example.com/mcp", vec![]);
    on.enabled = true;
    let a = fx.store.save(on).unwrap();
    let b = fx.store.save(http_input("b", "https://example.com/mcp", vec![])).unwrap();
    assert_eq!(code_of(fx.store.workspace_set("", &a.id, McpWorkspaceState::Off)), code::NO_WORKSPACE);
    assert_eq!(code_of(fx.store.workspace_set("w1", "mnope", McpWorkspaceState::Off)), code::UNKNOWN_SERVER);
    let l = fx.store.workspace_set("w1", &a.id, McpWorkspaceState::Off).unwrap();
    assert_eq!(l.workspace.overrides, vec![McpWorkspaceOverride { server_id: a.id.clone(), state: McpWorkspaceState::Off }]);
    fx.store.workspace_set("w1", &b.id, McpWorkspaceState::On).unwrap();
    let defaults = |w: &str| fx.store.run_servers(Some(w), "claude").unwrap().into_iter().filter(|s| s.default_on).map(|s| s.name).collect::<Vec<_>>();
    assert_eq!(defaults("w1"), ["b"], "the override beats the server's own flag");
    assert_eq!(defaults("w2"), ["a"], "another workspace inherits");
    let l = fx.store.workspace_set("w1", &a.id, McpWorkspaceState::Inherit).unwrap();
    assert_eq!(l.workspace.overrides.len(), 1);
    fx.store.workspace_set("w1", &b.id, McpWorkspaceState::Inherit).unwrap();
    let file: Value = serde_json::from_str(&fx.settings_text()).unwrap();
    assert_eq!(file["mcp"]["workspaces"], json!([]), "an empty workspace entry is dropped");
}

#[test]
fn enabling_needs_a_confirmed_record_and_disabling_never_does() {
    let fx = Fx::new();
    let v = fx.store.save(stdio_input("fs", vec![])).unwrap();
    let e = fx.store.set_enabled(&v.id, true).err().unwrap();
    assert_eq!(e.code, code::CONFIRMATION_REQUIRED);
    assert_eq!(e.detail.as_deref(), Some(v.confirm_hash.as_str()), "the detail is the hash to confirm");
    fx.store.confirm(&v.id, &v.confirm_hash).unwrap();
    assert!(fx.store.set_enabled(&v.id, true).unwrap().enabled);
    let mut i = stdio_input("fs", vec![var_plain("LOG_LEVEL", "debug")]);
    i.id = Some(v.id.clone());
    fx.store.save(i).unwrap();
    assert!(!fx.store.set_enabled(&v.id, false).unwrap().enabled, "switching off never needs the proof");
}

#[test]
fn policies_validate_and_never_touch_the_proof() {
    let fx = Fx::new();
    let v = fx.save_confirmed(stdio_input("fs", vec![]));
    assert_eq!(code_of(fx.store.set_policy(&v.id, patch_tool("bad tool!", Some(McpPolicy::Deny), false))), code::BAD_POLICY);
    let v2 = fx.store.set_policy(&v.id, patch_tool("resources", Some(McpPolicy::Deny), false)).unwrap();
    assert!(v2.confirmed);
    assert_eq!(v2.stale_tool_policies, vec![McpStalePolicy { tool: "resources".into(), policy: McpPolicy::Deny }]);
    let v3 = fx.store.set_policy(&v.id, patch_tool("resources", None, false)).unwrap();
    assert!(v3.stale_tool_policies.is_empty());
    assert_eq!(code_of(fx.store.set_policy("mnope", McpPolicyPatch::default_for_test())), code::UNKNOWN_SERVER);
}

trait PatchExt {
    fn default_for_test() -> McpPolicyPatch;
}

impl PatchExt for McpPolicyPatch {
    fn default_for_test() -> McpPolicyPatch {
        McpPolicyPatch { default_policy: Some(McpPolicy::Ask), tools: None }
    }
}

// ---- the code files ------------------------------------------------------------------------------------------------------------------

fn script_input(name: &str, script: &std::path::Path) -> McpSaveInput {
    let mut i = stdio_input(name, vec![]);
    i.command = Some("/bin/sh".into());
    i.args = Some(vec![script.to_string_lossy().into_owned()]);
    i
}

#[test]
fn the_proof_covers_the_content_of_the_files_the_command_names() {
    let fx = Fx::new();
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("server.sh");
    std::fs::write(&script, "echo one\n").unwrap();
    let v = fx.save_confirmed(script_input("fs", &script));
    assert!(v.confirmed);
    assert!(v.code_files.iter().any(|f| f.path.ends_with("server.sh") && f.sha256.len() == 12), "{:?}", v.code_files);
    let listed = |fx: &Fx| fx.store.list(None).unwrap().servers.remove(0);
    assert!(listed(&fx).confirmed, "unchanged content keeps the proof");
    std::thread::sleep(Duration::from_millis(20));
    std::fs::write(&script, "echo two\n").unwrap();
    assert!(!listed(&fx).confirmed, "a rewritten script needs a new confirmation");
    let again = listed(&fx);
    fx.store.confirm(&again.id, &again.confirm_hash).unwrap();
    assert!(listed(&fx).confirmed);
    // a file that was absent and appears later changes the proof too
    let later = dir.path().join("later.sh");
    let mut i = script_input("fs", &script);
    i.id = Some(v.id.clone());
    i.args = Some(vec![script.to_string_lossy().into_owned(), later.to_string_lossy().into_owned()]);
    let v = fx.store.save(i).unwrap();
    fx.store.confirm(&v.id, &v.confirm_hash).unwrap();
    assert!(listed(&fx).confirmed);
    std::fs::write(&later, "x").unwrap();
    assert!(!listed(&fx).confirmed, "the later appearance of an absent file");
}

// ---- the Test, seeding and the report -------------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_test_learns_seeds_and_reports() {
    need_node!();
    let fx = Fx::new();
    let v = fx.save_confirmed(stdio_input("fixture", vec![var_in("FIXTURE_TOKEN", CANARY), var_plain("FIXTURE_INSTRUCTIONS", "Use with care.")]));
    let r = fx.store.test(&v.id, None).await.unwrap();
    assert!(r.ok, "{:?}", r.error);
    assert_eq!(r.tool_count, 13);
    assert_eq!(r.server_info.as_ref().map(|s| s.name.as_str()), Some("fixture"));
    assert!(r.new_tools.is_empty() && r.removed_tools.is_empty(), "no baseline yet");
    let mut blocked = r.blocked_by_default.clone();
    blocked.sort();
    assert_eq!(blocked, ["delete_file", "git_commit"], "the first Test seeds git and destructive tools with Deny");
    assert_eq!(r.instructions.as_deref(), Some("Use with care."));
    assert_eq!(r.instructions_changed, None);
    let tool = |n: &str| r.tools.iter().find(|t| t.key == n).unwrap_or_else(|| panic!("{n}"));
    assert!(tool("echo").read_only && tool("echo").read_only_hint == Some(true));
    assert!(!tool("mystery").read_only && tool("mystery").read_only_hint.is_none());
    assert_eq!(tool("do_thing").name, "do.thing", "the key is normalised, the name stays");
    assert_eq!(tool("dup_").collision, Some(true));
    assert!(!tool("dup_").read_only);
    assert_eq!((tool("git_commit").policy, tool("git_commit").seeded, tool("git_commit").blocked_by_default), (Some(McpPolicy::Deny), true, true));
    assert_eq!(tool("echo").effective_policy, McpPolicy::Ask);
    let listed = fx.store.list(None).unwrap().servers.remove(0);
    assert!(listed.tools_tested_at.is_some() && !listed.tools_stale && listed.tools.len() == 13);
    assert_eq!(listed.server_info.as_ref().map(|s| s.protocol_version.as_str()), Some("2025-06-18"));
    assert!(!fx.all_text().contains(CANARY));

    // loosening a seeded tool needs the acknowledgement, which also clears the seed
    assert_eq!(code_of(fx.store.set_policy(&v.id, patch_tool("git_commit", Some(McpPolicy::Allow), false))), code::BLOCKED_BY_DEFAULT);
    assert_eq!(code_of(fx.store.set_policy(&v.id, patch_tool("git_commit", None, false))), code::BLOCKED_BY_DEFAULT);
    fx.store.set_policy(&v.id, patch_tool("git_commit", Some(McpPolicy::Deny), false)).unwrap();
    let kept = fx.store.list(None).unwrap().servers.remove(0);
    assert!(kept.tools.iter().find(|t| t.key == "git_commit").unwrap().seeded, "setting Deny again changes nothing");
    let loosened = fx.store.set_policy(&v.id, patch_tool("git_commit", Some(McpPolicy::Allow), true)).unwrap();
    let t = loosened.tools.iter().find(|t| t.key == "git_commit").unwrap();
    assert_eq!((t.policy, t.seeded), (Some(McpPolicy::Allow), false));
    // a user's own rule survives the next Test, and only NEW names are seeded then
    fx.store.set_policy(&v.id, patch_tool("write_note", Some(McpPolicy::Allow), false)).unwrap();
    let cur = fx.store.list(None).unwrap().servers.remove(0);
    let mut i = stdio_input("fixture", vec![var_in("FIXTURE_TOKEN", CANARY), var_plain("FIXTURE_INSTRUCTIONS", "Use with care."), var_plain("FIXTURE_RENAME", "1")]);
    i.id = Some(cur.id.clone());
    let edited = fx.store.save(i).unwrap();
    assert!(!edited.confirmed, "a plain value changed");
    assert_eq!(fx.store.test(&v.id, None).await.unwrap().error.map(|e| e.code), Some(code::CONFIRMATION_REQUIRED.to_owned()));
    fx.store.confirm(&edited.id, &edited.confirm_hash).unwrap();
    let r2 = fx.store.test(&v.id, None).await.unwrap();
    assert!(r2.ok, "{:?}", r2.error);
    assert_eq!(r2.new_tools, ["write_note_v2"]);
    assert_eq!(r2.removed_tools, ["write_note"]);
    assert!(r2.blocked_by_default.is_empty(), "git_commit was already in the previous list");
    let git = r2.tools.iter().find(|t| t.key == "git_commit").unwrap();
    assert_eq!(git.policy, Some(McpPolicy::Allow), "the user's choice is never overruled");
    assert_eq!(fx.store.list(None).unwrap().servers[0].stale_tool_policies, vec![McpStalePolicy { tool: "write_note".into(), policy: McpPolicy::Allow }]);
}

#[tokio::test]
async fn instructions_changes_are_flagged_by_hash() {
    need_node!();
    let fx = Fx::new();
    let v = fx.save_confirmed(stdio_input("fixture", vec![var_plain("FIXTURE_INSTRUCTIONS", "one")]));
    assert_eq!(fx.store.test(&v.id, None).await.unwrap().instructions_changed, None);
    assert_eq!(fx.store.test(&v.id, None).await.unwrap().instructions_changed, Some(false));
    let mut i = stdio_input("fixture", vec![var_plain("FIXTURE_INSTRUCTIONS", "two")]);
    i.id = Some(v.id.clone());
    let e = fx.store.save(i).unwrap();
    fx.store.confirm(&e.id, &e.confirm_hash).unwrap();
    let r = fx.store.test(&v.id, None).await.unwrap();
    assert_eq!(r.instructions_changed, Some(true));
    assert_eq!(r.instructions.as_deref(), Some("two"));
}

#[tokio::test]
async fn a_failed_test_writes_nothing_and_the_previous_list_stays() {
    need_node!();
    let fx = Fx::new();
    let v = fx.save_confirmed(stdio_input("fixture", vec![]));
    assert!(fx.store.test(&v.id, None).await.unwrap().ok);
    let before = fx.settings_text();
    let mut i = stdio_input("fixture", vec![var_plain("FIXTURE_MODE", "exit")]);
    i.id = Some(v.id.clone());
    let e = fx.store.save(i).unwrap();
    fx.store.confirm(&e.id, &e.confirm_hash).unwrap();
    let after_save = fx.settings_text();
    assert_ne!(before, after_save);
    let r = fx.store.test(&v.id, None).await.unwrap();
    assert!(!r.ok);
    assert_eq!(r.error.as_ref().map(|e| e.code.as_str()), Some(code::EXITED));
    assert_eq!(r.tools.len(), 13, "the report still carries the stored list");
    assert_eq!(fx.settings_text(), after_save, "a failed Test writes nothing");
}

#[tokio::test]
async fn the_deadline_is_clamped_and_a_second_test_of_the_same_server_is_busy() {
    need_node!();
    let fx = Fx::new();
    let v = fx.save_confirmed(stdio_input("fixture", vec![var_plain("FIXTURE_MODE", "hang")]));
    let store = Arc::clone(&fx.store);
    let id = v.id.clone();
    let first = tokio::spawn(async move {
        let t = Instant::now();
        let r = store.test(&id, Some(1)).await.unwrap();
        (r, t.elapsed())
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    let busy = fx.store.test(&v.id, None).await.unwrap();
    assert_eq!(busy.error.map(|e| e.code), Some(code::BUSY.to_owned()));
    let (r, took) = first.await.unwrap();
    assert_eq!(r.error.map(|e| e.code), Some(code::TIMEOUT.to_owned()));
    assert!(took >= Duration::from_millis(2900), "1 ms is clamped to 3 s: {took:?}");
    assert!(took < Duration::from_secs(8));
    // the flag is released
    assert_ne!(fx.store.test(&v.id, Some(3000)).await.unwrap().error.map(|e| e.code), Some(code::BUSY.to_owned()));
}

#[tokio::test]
async fn code_in_a_temporary_directory_is_not_tested_while_the_jail_is_off() {
    need_node!();
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("srv.mjs");
    std::fs::copy(server_script(), &script).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let fx = Fx::with(|c| c.temp_dirs = vec![dir.path().to_path_buf()]);
    let mut i = stdio_input("fixture", vec![]);
    i.command = Some(script.to_string_lossy().into_owned());
    let v = fx.save_confirmed(i);
    let r = fx.store.test(&v.id, None).await.unwrap();
    assert_eq!(r.error.map(|e| e.code), Some(code::CODE_IN_RUN_DIR.to_owned()));
    // the same store with no temp directories refuses nothing
    let fx2 = Fx::with(|c| c.temp_dirs = vec![]);
    let mut i = stdio_input("fixture", vec![]);
    i.command = Some(script.to_string_lossy().into_owned());
    let v = fx2.save_confirmed(i);
    // a script written a moment ago can meet `ETXTBSY` while a parallel test forks: retry the spawn failure
    let mut r = fx2.store.test(&v.id, None).await.unwrap();
    for _ in 0..4 {
        if r.error.as_ref().is_none_or(|e| e.code != code::SPAWN_FAILED) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        r = fx2.store.test(&v.id, None).await.unwrap();
    }
    assert!(r.ok, "{:?}", r.error);
}

#[tokio::test]
async fn the_read_only_jail_refuses_the_test_and_reports_it_in_the_list() {
    let fx = Fx::with(|c| c.jail = Arc::new(intely_core::jail::Jail::read_only()));
    let v = fx.save_confirmed(stdio_input("fixture", vec![]));
    assert_eq!(fx.store.list(None).unwrap().jail, McpJail::ReadOnly);
    let r = fx.store.test(&v.id, None).await.unwrap();
    assert_eq!(r.error.map(|e| e.code), Some(code::READ_ONLY.to_owned()));
    assert_eq!(code_of(fx.store.test("mnope", None).await), code::UNKNOWN_SERVER);
}

#[tokio::test]
async fn a_missing_secret_is_a_report_not_a_crash() {
    need_node!();
    let fx = Fx::new();
    let mut i = stdio_input("fixture", vec![]);
    i.env = Some(vec![McpVarInput { name: "FIXTURE_TOKEN".into(), secret: true, value: None, secret_value: None }]);
    let v = fx.save_confirmed(i);
    assert_eq!(v.state, McpState::SecretMissing);
    let r = fx.store.test(&v.id, None).await.unwrap();
    assert_eq!(r.error.map(|e| e.code), Some(code::SECRET_MISSING.to_owned()));
}
