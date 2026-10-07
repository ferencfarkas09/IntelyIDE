//! Import from Claude Code (MCP spec 9.2 "import"): fixture files only, never the real `~/.claude.json`.

mod common;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use common::*;
use intely_agent_core::mcp::McpPolicy;
use intely_mcp::error::code;
use intely_mcp::types::*;
use intely_settings::SecretStore;
use serde_json::{json, Value};

const OTHER_CANARY: &str = "CANARY-OAUTH-9c1d";
const ENV_CANARY: &str = "CANARY-IMPORT-ENV-5b2e";

fn claude_json() -> Value {
    json!({
        "numStartups": 12,
        "oauthAccount": { "emailAddress": "someone@example.com", "accessToken": OTHER_CANARY },
        "projects": { "/Users/x/repo": { "mcpServers": { "project-only": { "command": "npx", "env": { "SOME_TOKEN": OTHER_CANARY } } } } },
        "mcpServers": {
            "github": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github@1.0.0"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": ENV_CANARY, "LOG_LEVEL": "debug" } },
            "fs": { "command": "/usr/local/bin/node", "args": ["/opt/mcp/server.js"], "env": { "NODE_ENV": "production", "API_PORT": "8080", "AWS_REGION": "eu-west-1", "TZ": "UTC" } },
            "web": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": format!("Bearer {ENV_CANARY}"), "X-Api-Key": "k-123456" } },
            "sse-one": { "type": "sse", "url": "https://example.com/sse" },
            "sdk-one": { "type": "sdk", "name": "x" },
            "leaky": { "command": "npx", "args": ["--api-key=abc"] },
            "urlsecret": { "type": "http", "url": "https://example.com/mcp?api_key=zzz" },
            "refd": { "command": "npx", "args": ["x@1.0.0"], "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}", "LOG_LEVEL": "${LEVEL:-info}" } },
            "rel": { "command": "./server.js" },
            "rel-arg": { "command": "node", "args": ["../x.js"] },
            "bidi": { "command": "node", "args": ["a\u{202e}b"] },
            "exec-var": { "command": "node", "env": { "NODE_OPTIONS": "--require /tmp/x.js" } },
            "My Server": { "command": "/bin/echo" },
            "claude-tools": { "command": "/bin/echo" },
            "junk": 5
        }
    })
}

fn write_json(dir: &Path, name: &str, v: &Value) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, serde_json::to_vec_pretty(v).unwrap()).unwrap();
    p
}

fn entry<'a>(p: &'a McpImportPreview, key: &str) -> &'a McpImportEntry {
    p.entries.iter().find(|e| e.key == key).unwrap_or_else(|| panic!("entry {key}"))
}

fn issues(p: &McpImportPreview, key: &str) -> Vec<McpImportIssue> {
    entry(p, key).issues.clone()
}

#[test]
fn the_preview_classifies_every_entry_and_carries_names_only() {
    let fx = Fx::new();
    let dir = tempfile::tempdir().unwrap();
    let path = write_json(dir.path(), ".claude.json", &claude_json());
    let p = fx.store.import_preview(&path).unwrap();
    assert_eq!(p.file_name, ".claude.json");
    assert_eq!(p.skipped_keys, 1, "the non-object key");
    assert_eq!(p.entries.len(), 14);
    use McpImportIssue::*;
    // plain versus hidden secret slots (the allow-list)
    let github = entry(&p, "github");
    assert!(github.importable && github.issues.is_empty());
    assert_eq!(github.env, vec![McpImportVar { name: "GITHUB_PERSONAL_ACCESS_TOKEN".into(), secret: true }, McpImportVar { name: "LOG_LEVEL".into(), secret: false }]);
    let fs = entry(&p, "fs");
    assert!(fs.importable && fs.env.iter().all(|v| !v.secret), "{:?}", fs.env);
    assert_eq!(fs.command_line.as_deref(), Some("/usr/local/bin/node /opt/mcp/server.js"));
    let web = entry(&p, "web");
    assert!(web.importable && web.headers.iter().all(|h| h.secret), "every header is a hidden slot");
    assert_eq!(web.url_host.as_deref(), Some("example.com"));
    assert_eq!(web.transport, "http");
    // refusals
    assert_eq!(issues(&p, "sse-one"), [UnsupportedTransport]);
    assert_eq!(entry(&p, "sse-one").transport, "unknown");
    assert!(!entry(&p, "sdk-one").importable);
    assert_eq!(issues(&p, "leaky"), [SecretInArgs]);
    assert_eq!(issues(&p, "urlsecret"), [SecretInUrl]);
    assert_eq!(issues(&p, "rel"), [RelativePath]);
    assert_eq!(issues(&p, "rel-arg"), [RelativePath]);
    assert_eq!(issues(&p, "bidi"), [BadChars]);
    assert_eq!(issues(&p, "exec-var"), [BadVar]);
    for k in ["leaky", "urlsecret", "rel", "rel-arg", "bidi", "exec-var", "sse-one", "sdk-one"] {
        assert!(!entry(&p, k).importable, "{k}");
    }
    // `${VAR}` is never expanded: a secret slot with no value, importable, flagged
    let refd = entry(&p, "refd");
    assert!(refd.importable && refd.issues.contains(&UnresolvedRef), "{:?}", refd.issues);
    assert!(refd.env.iter().all(|v| v.secret), "{:?}", refd.env);
    // names
    let mine = entry(&p, "My Server");
    assert_eq!((mine.suggested_name.as_str(), mine.importable), ("my-server", true));
    assert!(mine.issues.contains(&BadName));
    assert_eq!(entry(&p, "claude-tools").suggested_name, "my-claude-tools");
    // the canaries (another project's server, the oauth account, every value) are nowhere in the preview
    let text = serde_json::to_string(&p).unwrap();
    for leaked in [OTHER_CANARY, ENV_CANARY, "k-123456", "someone@example.com", "production", "8080", "project-only"] {
        assert!(!text.contains(leaked), "{leaked} leaked into the preview");
    }
    assert!(!format!("{p:?}").contains(ENV_CANARY));
}

#[test]
fn the_variable_allow_list_table() {
    let fx = Fx::new();
    let dir = tempfile::tempdir().unwrap();
    let mut servers = serde_json::Map::new();
    let names = [
        ("UV_INDEX_URL", false), ("PIP_INDEX_URL", false), ("YARN_NPM_REGISTRY_SERVER", false), ("OPENSSL_CONF", false), ("JAVA_HOME", false), ("CARGO_HOME", false), ("API_URL", false), ("MY_HOST", false),
        ("DATA_DIR", false), ("TOOL_PATH", false), ("LOG_LEVEL", true), ("NODE_ENV", true), ("API_PORT", true), ("GITHUB_TOKEN", true), ("OPENAI_API_KEY", true), ("STRIPE_SECRET", true),
    ];
    for (n, _) in names {
        servers.insert(format!("e-{}", n.to_ascii_lowercase().replace('_', "-")), json!({ "command": "node", "env": { n: "value1" } }));
    }
    let path = write_json(dir.path(), "mcp.json", &json!({ "mcpServers": servers }));
    let p = fx.store.import_preview(&path).unwrap();
    for (n, importable) in names {
        let e = entry(&p, &format!("e-{}", n.to_ascii_lowercase().replace('_', "-")));
        assert_eq!(e.importable, importable, "{n}: {:?}", e.issues);
        if !importable {
            assert_eq!(e.issues, [McpImportIssue::BadVar], "{n}");
        }
    }
    let secret_of = |n: &str| entry(&p, &format!("e-{}", n.to_ascii_lowercase().replace('_', "-"))).env[0].secret;
    assert!(!secret_of("LOG_LEVEL") && !secret_of("NODE_ENV") && !secret_of("API_PORT"));
    assert!(secret_of("GITHUB_TOKEN") && secret_of("OPENAI_API_KEY"));
    // a credential-shaped value under a benign name is not plain
    let path = write_json(dir.path(), "mcp2.json", &json!({ "mcpServers": { "x": { "command": "node", "env": { "LOG_LEVEL": "ghp_0123456789abcdefghijklmnopqrstuvwxyz" } } } }));
    assert!(!entry(&fx.store.import_preview(&path).unwrap(), "x").importable);
}

#[test]
fn a_name_that_is_taken_is_a_conflict_and_apply_needs_replace() {
    let fx = Fx::new();
    fx.store.save(stdio_input("fs", vec![])).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = write_json(dir.path(), "mcp.json", &claude_json());
    let p = fx.store.import_preview(&path).unwrap();
    let fs = entry(&p, "fs");
    assert!(fs.conflict && fs.issues.contains(&McpImportIssue::NameTaken) && fs.importable);
    let r = fx.store.import_apply(&p.import_id, &[McpImportPick { key: "fs".into(), name: "fs".into(), replace: false }]).unwrap();
    assert!(r.imported.is_empty());
    assert_eq!(r.skipped[0].reason, "nameTaken");
}

#[test]
fn apply_creates_disabled_unconfirmed_servers_and_keeps_every_secret_out_of_the_files() {
    let fx = Fx::new();
    let dir = tempfile::tempdir().unwrap();
    let path = write_json(dir.path(), ".claude.json", &claude_json());
    let p = fx.store.import_preview(&path).unwrap();
    let picks = |keys: &[(&str, &str)]| keys.iter().map(|(k, n)| McpImportPick { key: (*k).into(), name: (*n).into(), replace: false }).collect::<Vec<_>>();
    let r = fx
        .store
        .import_apply(&p.import_id, &picks(&[("github", "github"), ("web", "web"), ("refd", "refd"), ("leaky", "leaky"), ("My Server", "my-server"), ("nope", "nope"), ("fs", "Bad Name")]))
        .unwrap();
    assert_eq!(r.imported.iter().map(|i| i.key.as_str()).collect::<Vec<_>>(), ["github", "web", "refd", "My Server"]);
    let skipped: Vec<(&str, &str)> = r.skipped.iter().map(|s| (s.key.as_str(), s.reason.as_str())).collect();
    assert_eq!(skipped, [("leaky", "secretInArgs"), ("nope", "unknown"), ("fs", "badName")]);
    let list = fx.store.list(None).unwrap();
    assert_eq!(list.servers.len(), 4);
    for s in &list.servers {
        assert!(!s.enabled && !s.confirmed && s.imported, "{}", s.name);
        assert_eq!(s.state == McpState::NeedsConfirm || s.state == McpState::SecretMissing || s.state == McpState::Invalid, true);
    }
    let github = list.servers.iter().find(|s| s.name == "github").unwrap();
    assert_eq!(github.env.iter().map(|e| (e.name.as_str(), e.secret, e.present)).collect::<Vec<_>>(), [("GITHUB_PERSONAL_ACCESS_TOKEN", true, true), ("LOG_LEVEL", false, true)]);
    assert!(github.fetches_code == false, "a pinned version");
    let key = format!("mcp.{}:env.GITHUB_PERSONAL_ACCESS_TOKEN", github.id);
    assert_eq!(fx.secrets.get(&key).unwrap().unwrap().expose(), ENV_CANARY, "the value went straight to the secret store");
    let web = list.servers.iter().find(|s| s.name == "web").unwrap();
    assert_eq!(fx.secrets.get(&format!("mcp.{}:hdr.Authorization", web.id)).unwrap().unwrap().expose(), format!("Bearer {ENV_CANARY}"));
    let refd = list.servers.iter().find(|s| s.name == "refd").unwrap();
    assert!(refd.env.iter().any(|e| e.secret && !e.present), "an unresolved reference leaves the slot empty: the server shows secretMissing after confirmation");
    // nothing about the source file or any value reached a file the app wrote
    let all = fx.all_text();
    for leaked in [ENV_CANARY, OTHER_CANARY, "k-123456", "someone@example.com"] {
        assert!(!all.contains(leaked), "{leaked} leaked into a file");
    }
    // the staged import is gone
    assert_eq!(fx.store.import_apply(&p.import_id, &[]).err().unwrap().code, code::IMPORT_EXPIRED);
    assert_eq!(fx.store.import_apply("nonsense", &[]).err().unwrap().code, code::IMPORT_EXPIRED);
}

#[test]
fn replace_keeps_the_id_and_the_policies_but_loses_the_proof() {
    let fx = Fx::new();
    let existing = fx.save_confirmed(stdio_input("github", vec![]));
    fx.store.set_policy(&existing.id, McpPolicyPatch { default_policy: Some(McpPolicy::Deny), tools: None }).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = write_json(dir.path(), "mcp.json", &claude_json());
    let p = fx.store.import_preview(&path).unwrap();
    let r = fx.store.import_apply(&p.import_id, &[McpImportPick { key: "github".into(), name: "github".into(), replace: true }]).unwrap();
    assert_eq!(r.imported[0].id, existing.id);
    let now = fx.store.list(None).unwrap().servers.remove(0);
    assert_eq!(now.default_policy, McpPolicy::Deny, "policies stay");
    assert_eq!(now.command.as_deref(), Some("npx"), "the connection fields are replaced");
    assert!(!now.confirmed && now.state == McpState::NeedsConfirm && !now.enabled);
    assert!(fx.secrets.has(&format!("mcp.{}:env.GITHUB_PERSONAL_ACCESS_TOKEN", existing.id)).unwrap());
}

#[test]
fn the_staged_preview_expires_after_five_minutes() {
    let now = Arc::new(AtomicU64::new(1_000_000));
    let clock = Arc::clone(&now);
    let fx = Fx::with(move |c| c.now_ms = Arc::new(move || clock.load(Ordering::SeqCst)));
    let dir = tempfile::tempdir().unwrap();
    let path = write_json(dir.path(), "mcp.json", &claude_json());
    let p = fx.store.import_preview(&path).unwrap();
    assert_eq!(p.expires_at, 1_000_000 + 5 * 60 * 1000);
    now.store(p.expires_at + 1, Ordering::SeqCst);
    assert_eq!(fx.store.import_apply(&p.import_id, &[]).err().unwrap().code, code::IMPORT_EXPIRED);
    // a newer preview replaces the older one
    now.store(1_000_000, Ordering::SeqCst);
    let first = fx.store.import_preview(&path).unwrap();
    let second = fx.store.import_preview(&path).unwrap();
    assert_eq!(fx.store.import_apply(&first.import_id, &[]).err().unwrap().code, code::IMPORT_EXPIRED);
    assert!(fx.store.import_apply(&second.import_id, &[]).is_ok(), "a stale id does not destroy the current preview");
}

#[test]
fn bad_files_are_refused_without_an_excerpt() {
    let fx = Fx::new();
    let dir = tempfile::tempdir().unwrap();
    let bad = dir.path().join("bad.json");
    std::fs::write(&bad, format!("{{ \"mcpServers\": {{ \"x\": \"{ENV_CANARY}\" ")).unwrap();
    let e = fx.store.import_preview(&bad).err().unwrap();
    assert_eq!(e.code, code::IMPORT_INVALID);
    assert!(e.message.contains("line") && !format!("{e:?}").contains(ENV_CANARY), "{e:?}");
    let none = write_json(dir.path(), "none.json", &json!({ "other": 1 }));
    assert_eq!(fx.store.import_preview(&none).err().unwrap().code, code::IMPORT_INVALID);
    assert_eq!(fx.store.import_preview(dir.path()).err().unwrap().code, code::IMPORT_INVALID, "a directory is not a regular file");
    assert_eq!(fx.store.import_preview(&dir.path().join("missing.json")).err().unwrap().code, code::IMPORT_INVALID);
    // more than 16 MiB: a sparse file keeps the test cheap
    let big = dir.path().join("big.json");
    let f = std::fs::File::create(&big).unwrap();
    f.set_len(17 << 20).unwrap();
    assert_eq!(fx.store.import_preview(&big).err().unwrap().code, code::IMPORT_INVALID);
}

#[test]
fn only_the_top_level_key_is_read() {
    // a project's servers and everything else in the file are never turned into entries
    let fx = Fx::new();
    let dir = tempfile::tempdir().unwrap();
    let path = write_json(dir.path(), ".claude.json", &json!({ "projects": { "/x": { "mcpServers": { "inner": { "command": "node" } } } }, "mcpServers": { "outer": { "command": "/bin/echo" } } }));
    let p = fx.store.import_preview(&path).unwrap();
    assert_eq!(p.entries.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(), ["outer"]);
}

#[test]
fn the_picker_accepts_a_dotfile_directly_under_home_and_redeems_it_for_the_import() {
    use intely_pathpick::{PathTokens, Policy, Purpose, Validator};
    let home = tempfile::tempdir().unwrap();
    let home_path = std::fs::canonicalize(home.path()).unwrap();
    std::fs::write(home_path.join(".claude.json"), serde_json::to_vec(&claude_json()).unwrap()).unwrap();
    let validator = Validator::new(Policy::new(Arc::new(intely_core::jail::Jail::off()), home_path.clone(), home_path.join("state")));
    let purpose = Purpose::parse("file:mcpImport").unwrap();
    let validated = validator.validate("~/.claude.json", &purpose).expect("a dotfile under home is accepted");
    let tokens = PathTokens::new();
    let picked = tokens.issue(validated, &purpose);
    let redeemed = tokens.redeem(&picked.token, &[Purpose::File("mcpImport".into())], &validator).expect("redeem");
    let fx = Fx::new();
    let p = fx.store.import_preview(&redeemed.validated.path).unwrap();
    assert_eq!(p.file_name, ".claude.json");
    // the token is single-use and bound to its purpose
    assert!(tokens.redeem(&picked.token, &[Purpose::File("mcpImport".into())], &validator).is_err());
    let other = tokens.issue(validator.validate("~/.claude.json", &Purpose::File("caFile".into())).unwrap(), &Purpose::File("caFile".into()));
    assert!(tokens.redeem(&other.token, &[Purpose::File("mcpImport".into())], &validator).is_err());
}
