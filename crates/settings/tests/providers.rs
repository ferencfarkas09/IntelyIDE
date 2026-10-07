//! Provider registry against fake CLIs in a temp PATH. No real CLI, no Keychain (the in-memory secret store), no network.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use intely_settings::providers::{detect_cli, CliDef, ProviderRegistry};
use intely_settings::secrets::{provider_key, MemorySecretStore, Secret, SecretStore};
use intely_settings::store::SettingsStore;
use intely_settings::types::{DoctorLevel, ProviderInfo, ProviderState, ProviderStateChange};
use intely_settings::{code, Object};
use serde_json::{json, Value};

/// Generous: other builds can load this machine to a load average in the hundreds.
const SLOW_OK: Duration = Duration::from_secs(120);
const CANARY: &str = "sk-CANARY-0d4e8b1f6a3c9e2b7d5f";

struct Fixture {
    dir: tempfile::TempDir,
    bin: String,
    secrets: Arc<MemorySecretStore>,
    settings: Arc<SettingsStore>,
    registry: ProviderRegistry,
    events: Arc<Mutex<Vec<ProviderStateChange>>>,
}

fn script(dir: &Path, name: &str, body: &str) {
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let bin_dir = dir.path().join("bin");
    std::fs::create_dir(&bin_dir).unwrap();
    script(&bin_dir, "claude", "echo 'claude 2.1.284 (Claude Code)'");
    script(&bin_dir, "codex", "echo 'boom: not logged in' >&2; exit 1");
    let settings = Arc::new(SettingsStore::open(dir.path().join("settings.json")).unwrap());
    let secrets = Arc::new(MemorySecretStore::new());
    let registry = ProviderRegistry::new(Arc::clone(&settings), secrets.clone()).with_timeout(SLOW_OK);
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    registry.subscribe(move |e| sink.lock().unwrap().push(e.clone()));
    Fixture { bin: bin_dir.display().to_string(), dir, secrets, settings, registry, events }
}

fn find<'a>(list: &'a [ProviderInfo], id: &str) -> &'a ProviderInfo {
    list.iter().find(|p| p.id == id).unwrap()
}

#[test]
fn defaults_claude_on_the_rest_off_and_nothing_detected_before_asked() {
    let f = fixture();
    let list = f.registry.list().unwrap();
    assert_eq!(list.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["claude", "codex", "gemini", "copilot", "opencode", "goose", "qwen", "acp"]);
    assert_eq!(list.iter().filter(|p| p.enabled).map(|p| p.id.as_str()).collect::<Vec<_>>(), ["claude"]);
    assert_eq!(find(&list, "claude").state, ProviderState::Probing);
    assert_eq!(find(&list, "codex").state, ProviderState::Off);
    assert!(list.iter().all(|p| p.cli.is_none() && !p.has_key));
    assert!(!f.dir.path().join("settings.json").exists(), "listing must not write");
}

#[test]
fn detect_finds_versions_and_reports_missing_and_failing_clis() {
    let f = fixture();
    let list = f.registry.detect(&f.bin).unwrap();
    let claude = find(&list, "claude");
    assert_eq!(claude.state, ProviderState::Ready);
    assert_eq!(claude.cli.as_ref().unwrap().version.as_deref(), Some("2.1.284"));
    assert!(claude.cli.as_ref().unwrap().path.as_deref().unwrap().ends_with("/bin/claude"));
    assert!(claude.configured);
    // Disabled providers still show what was detected.
    assert_eq!(find(&list, "gemini").cli.as_ref().unwrap().path, None);
    let codex = find(&list, "codex").cli.as_ref().unwrap();
    assert!(codex.path.is_some() && codex.version.is_none());
    assert!(codex.error.as_deref().unwrap().contains("not logged in"));
}

#[test]
fn the_switch_drives_the_state_and_fires_events() {
    let f = fixture();
    f.registry.detect(&f.bin).unwrap();
    assert!(f.events.lock().unwrap().is_empty() || f.events.lock().unwrap().iter().all(|e| e.id == "claude"));
    f.registry.set_experimental(true).unwrap();
    f.events.lock().unwrap().clear();

    let gemini = f.registry.set_enabled("gemini", true).unwrap();
    assert_eq!(gemini.state, ProviderState::NotInstalled);
    assert_eq!(gemini.message.as_deref(), Some("gemini was not found on PATH"));
    let codex = f.registry.set_enabled("codex", true).unwrap();
    assert_eq!(codex.state, ProviderState::Error, "the stub codex fails --version");
    f.registry.set_enabled("codex", false).unwrap();
    f.registry.set_enabled("claude", false).unwrap();

    let seen: Vec<_> = f.events.lock().unwrap().iter().map(|e| (e.id.clone(), e.state.clone())).collect();
    assert_eq!(
        seen,
        [
            ("gemini".to_owned(), ProviderState::NotInstalled),
            ("codex".to_owned(), ProviderState::Error),
            ("codex".to_owned(), ProviderState::Off),
            ("claude".to_owned(), ProviderState::Off),
        ]
    );
    // The intent is persisted in the `providers` namespace, other keys of a provider entry are kept.
    let saved = f.settings.get("providers").unwrap();
    assert_eq!(Value::Object(saved), json!({ "experimental": true, "gemini": { "enabled": true }, "codex": { "enabled": false }, "claude": { "enabled": false } }));
    assert!(f.registry.set_enabled("nope", true).is_err_and(|e| e.code == code::UNKNOWN_PROVIDER));
}

#[test]
fn key_modes_follow_the_secret_store_without_revealing_the_key() {
    let f = fixture();
    f.registry.detect(&f.bin).unwrap();
    let info = f.registry.set_auth_mode("claude", "apiKey").unwrap();
    assert_eq!((info.state, info.has_key, info.configured), (ProviderState::NeedsKey, false, false));

    f.secrets.set(&provider_key("claude"), Secret::new(CANARY)).unwrap();
    f.registry.key_changed(&provider_key("claude"), true);
    let info = find(&f.registry.list().unwrap(), "claude").clone();
    assert_eq!((info.state, info.has_key, info.configured), (ProviderState::Ready, true, true));

    f.secrets.remove(&provider_key("claude")).unwrap();
    f.registry.key_changed(&provider_key("claude"), false);
    assert_eq!(find(&f.registry.list().unwrap(), "claude").state, ProviderState::NeedsKey);

    assert!(f.registry.set_auth_mode("claude", "magic").is_err_and(|e| e.code == code::INVALID_AUTH_MODE));
    f.registry.set_auth_mode("claude", "subscription").unwrap();
    assert_eq!(find(&f.registry.list().unwrap(), "claude").state, ProviderState::Ready);
}

#[test]
fn the_secret_store_is_asked_only_for_enabled_key_modes() {
    struct Spy(Mutex<Vec<String>>);
    impl SecretStore for Spy {
        fn has(&self, key: &str) -> intely_settings::error::Result<bool> {
            self.0.lock().unwrap().push(key.to_owned());
            Ok(false)
        }
        fn set(&self, _: &str, _: Secret) -> intely_settings::error::Result<()> {
            unreachable!()
        }
        fn remove(&self, _: &str) -> intely_settings::error::Result<()> {
            unreachable!()
        }
        fn get(&self, _: &str) -> intely_settings::error::Result<Option<Secret>> {
            unreachable!()
        }
    }
    let f = fixture();
    let spy = Arc::new(Spy(Mutex::default()));
    let registry = ProviderRegistry::new(Arc::clone(&f.settings), spy.clone()).with_timeout(SLOW_OK);
    registry.list().unwrap();
    registry.detect(&f.bin).unwrap();
    assert!(spy.0.lock().unwrap().is_empty(), "default claude uses its subscription: no Keychain query");
    registry.set_auth_mode("claude", "apiKey").unwrap();
    assert_eq!(*spy.0.lock().unwrap(), [provider_key("claude")]);
}

#[test]
fn test_probes_one_provider_and_reports_why_it_fails() {
    let f = fixture();
    let ok = f.registry.test("claude", &f.bin).unwrap();
    assert!(ok.ok && ok.latency_ms.is_some());
    assert!(ok.message.unwrap().starts_with("claude 2.1.284 at "));
    let missing = f.registry.test("gemini", &f.bin).unwrap();
    assert!(!missing.ok);
    assert_eq!(missing.message.as_deref(), Some("gemini was not found on PATH"));
    // A disabled provider is still testable: the switch is intent, the test is about the CLI.
    assert!(!f.registry.test("codex", &f.bin).unwrap().ok);
    assert!(f.registry.test("nope", &f.bin).is_err_and(|e| e.code == code::UNKNOWN_PROVIDER));
}

#[test]
fn detection_uses_a_scrubbed_environment() {
    let f = fixture();
    let bin_dir = Path::new(&f.bin);
    script(bin_dir, "gemini", r#"[ -z "$INTELY_F1_CANARY_ENV" ] || exit 3; echo 'gemini 0.9.1'"#);
    std::env::set_var("INTELY_F1_CANARY_ENV", "leaked");
    let list = f.registry.detect(&f.bin).unwrap();
    std::env::remove_var("INTELY_F1_CANARY_ENV");
    assert_eq!(find(&list, "gemini").cli.as_ref().unwrap().version.as_deref(), Some("0.9.1"));
}

#[test]
fn a_hanging_cli_is_killed_at_the_timeout() {
    let f = fixture();
    script(Path::new(&f.bin), "hang", "exec sleep 30");
    let def = CliDef { bin: "hang", version_args: &["--version"], min_version: None };
    let started = std::time::Instant::now();
    let det = detect_cli(&def, &f.bin, Duration::from_millis(300));
    assert!(started.elapsed() < Duration::from_secs(60));
    assert!(det.path.is_some() && det.version.is_none());
    assert!(det.error.unwrap().contains("did not answer"));
}

#[test]
fn a_minimum_version_is_enforced_when_set() {
    let f = fixture();
    let old = CliDef { bin: "claude", version_args: &["--version"], min_version: Some("3.0.0") };
    let det = detect_cli(&old, &f.bin, SLOW_OK);
    assert_eq!((det.version.as_deref(), det.meets_min), (Some("2.1.284"), Some(false)));
    let ok = CliDef { bin: "claude", version_args: &["--version"], min_version: Some("2.1.9") };
    assert_eq!(detect_cli(&ok, &f.bin, SLOW_OK).meets_min, Some(true));
}

#[test]
fn doctor_reports_cli_state_and_stray_variables_by_name_only() {
    let f = fixture();
    f.registry.set_experimental(true).unwrap();
    f.registry.set_enabled("codex", true).unwrap();
    f.registry.detect(&f.bin).unwrap();
    let env = |name: &str| matches!(name, "ANTHROPIC_API_KEY" | "ANTHROPIC_BASE_URL" | "OPENAI_API_KEY");
    let findings = f.registry.doctor(&env).unwrap();
    let codes: Vec<_> = findings.iter().map(|d| (d.provider.as_deref().unwrap(), d.code.as_str())).collect();
    assert_eq!(
        codes,
        [("claude", "cliFound"), ("claude", "strayEnv"), ("claude", "strayEnv"), ("codex", "cliProbeFailed"), ("codex", "strayEnv")]
    );
    assert!(findings.iter().filter(|d| d.code == "strayEnv").all(|d| d.level == DoctorLevel::Warn));
    assert!(findings.iter().any(|d| d.message.contains("ANTHROPIC_BASE_URL") && d.message.contains("value not shown")));
    // In API-key mode the key variable is expected; the base-URL override is still surfaced.
    f.registry.set_auth_mode("claude", "apiKey").unwrap();
    let again = f.registry.doctor(&env).unwrap();
    let stray: Vec<_> = again.iter().filter(|d| d.provider.as_deref() == Some("claude") && d.code == "strayEnv").collect();
    assert_eq!(stray.len(), 1);
    assert!(stray[0].message.contains("ANTHROPIC_BASE_URL"));
}

#[test]
fn redaction_canary_a_secret_never_reaches_state_logs_or_the_settings_file() {
    let f = fixture();
    f.registry.set_auth_mode("claude", "apiKey").unwrap();
    f.secrets.set(&provider_key("claude"), Secret::new(CANARY)).unwrap();
    f.registry.key_changed(&provider_key("claude"), true);
    let list = f.registry.detect(&f.bin).unwrap();
    assert!(find(&list, "claude").has_key);
    let doctor = f.registry.doctor(&|_| true).unwrap();
    let test = f.registry.test("claude", &f.bin).unwrap();

    // The webview-facing serialisations.
    let wire = [
        serde_json::to_string(&list).unwrap(),
        serde_json::to_string(&doctor).unwrap(),
        serde_json::to_string(&test).unwrap(),
        serde_json::to_string(&f.events.lock().unwrap().iter().map(|e| (&e.id, &e.state)).collect::<Vec<_>>()).unwrap(),
    ];
    // Debug output (what a log line would carry) and the persisted file.
    let debug = [format!("{f_secrets:?}", f_secrets = f.secrets), format!("{list:?}"), format!("{doctor:?}"), format!("{:?}", Secret::new(CANARY))];
    let file = std::fs::read_to_string(f.settings.path()).unwrap();
    for text in wire.iter().chain(debug.iter()).chain([&file]) {
        assert!(!text.contains(CANARY), "secret leaked into: {text}");
    }

    // And the settings store refuses the secret even if a caller tries.
    let mut patch = Object::new();
    patch.insert("apiKey".into(), json!(CANARY));
    let err = f.settings.set("providers", patch).unwrap_err();
    assert_eq!(err.code, code::SECRET_IN_SETTINGS);
    assert!(!format!("{err} {err:?}").contains(CANARY));
    assert!(!std::fs::read_to_string(f.settings.path()).unwrap().contains(CANARY));
}


// ---- Wave4 providers: experimental switch, confirmed command lines, weak-writer override ----

fn good_script(f: &Fixture, name: &str) -> String {
    script(&Path::new(&f.bin), name, "echo '1.2.3'");
    format!("{}/{name}", f.bin)
}

#[test]
fn the_experimental_switch_is_off_by_default_remembered_and_gates_every_non_claude_provider() {
    let f = fixture();
    f.registry.detect(&f.bin).unwrap();
    assert!(!f.registry.experimental().unwrap());
    // the per-provider switch alone does nothing: the state stays off and nothing is launchable
    let gemini = f.registry.set_enabled("gemini", true).unwrap();
    assert!(gemini.enabled && gemini.experimental);
    assert_eq!(gemini.state, ProviderState::Off);
    assert!(f.registry.launch_table().unwrap().is_empty());
    assert!(!find(&f.registry.list().unwrap(), "claude").experimental);
    assert!(f.registry.set_experimental(true).unwrap());
    assert!(f.registry.experimental().unwrap());
    // a second registry on the same file sees it (remembered)
    let again = ProviderRegistry::new(Arc::clone(&f.settings), f.secrets.clone());
    assert!(again.experimental().unwrap());
    assert_eq!(find(&f.registry.list().unwrap(), "gemini").state, ProviderState::NotInstalled);
}

#[test]
fn a_command_line_must_be_confirmed_once_and_a_change_asks_again() {
    let f = fixture();
    let bin = good_script(&f, "codex");
    f.registry.set_experimental(true).unwrap();
    f.registry.detect(&f.bin).unwrap();
    let p = f.registry.set_enabled("codex", true).unwrap();
    assert_eq!(p.state, ProviderState::NeedsConfirm, "{p:?}");
    let launch = p.launch.unwrap();
    assert_eq!(launch.status, intely_settings::types::LaunchStatus::Unconfirmed);
    assert_eq!(launch.args, ["app-server"]);
    assert!(f.registry.launch_table().unwrap().is_empty(), "an unconfirmed line is never launchable");

    // fixed arguments cannot be altered, relative or missing programs are refused
    assert!(f.registry.confirm_launch("codex", &bin, vec!["app-server".into(), "--yolo".into()]).is_err_and(|e| e.code == code::INVALID_LAUNCH));
    assert!(f.registry.confirm_launch("codex", "codex", vec!["app-server".into()]).is_err_and(|e| e.code == code::INVALID_LAUNCH));
    assert!(f.registry.confirm_launch("codex", "/nope/codex", vec!["app-server".into()]).is_err_and(|e| e.code == code::INVALID_LAUNCH));
    assert!(f.registry.confirm_launch("claude", &bin, vec![]).is_err_and(|e| e.code == code::INVALID_LAUNCH));

    let p = f.registry.confirm_launch("codex", &bin, vec!["app-server".into()]).unwrap();
    assert_eq!(p.state, ProviderState::Ready, "{p:?}");
    let table = f.registry.launch_table().unwrap();
    assert_eq!(table.len(), 1);
    assert_eq!((table[0].id.as_str(), table[0].adapter.as_str(), table[0].command.as_str()), ("codex", "codex", bin.as_str()));
    assert!(!table[0].allow_weak_writer);

    // the stored line is edited behind the IDE's back: the hash no longer matches and it asks again
    let mut entry = f.settings.get("providers").unwrap().get("codex").unwrap().as_object().unwrap().clone();
    entry["confirmed"]["args"] = json!(["app-server", "--yolo"]);
    f.settings.set("providers", Object::from_iter([("codex".to_owned(), Value::Object(entry))])).unwrap();
    let p = find(&f.registry.list().unwrap(), "codex").clone();
    assert_eq!(p.state, ProviderState::NeedsConfirm);
    assert_eq!(p.launch.unwrap().status, intely_settings::types::LaunchStatus::Stale);
    assert!(f.registry.launch_table().unwrap().is_empty());

    // confirmed again, then the program disappears: stale as well
    f.registry.confirm_launch("codex", &bin, vec!["app-server".into()]).unwrap();
    assert_eq!(f.registry.launch_table().unwrap().len(), 1);
    std::fs::remove_file(&bin).unwrap();
    assert!(f.registry.launch_table().unwrap().is_empty());
    f.registry.revoke_launch("codex").unwrap();
    assert!(f.settings.get("providers").unwrap()["codex"].get("confirmed").is_none());
}

#[test]
fn the_custom_acp_agent_takes_a_typed_command_line_and_has_nothing_to_detect() {
    let f = fixture();
    let bin = good_script(&f, "my-agent");
    f.registry.set_experimental(true).unwrap();
    let detected = f.registry.detect(&f.bin).unwrap();
    assert!(find(&detected, "acp").cli.is_none(), "no program to look for");
    let p = f.registry.set_enabled("acp", true).unwrap();
    assert_eq!(p.state, ProviderState::NeedsConfirm);
    assert!(p.launch.as_ref().unwrap().editable);
    let p = f.registry.confirm_launch("acp", &bin, vec!["--stdio".into(), "--mode=acp".into()]).unwrap();
    assert_eq!(p.state, ProviderState::Ready);
    assert!(p.configured);
    let t = f.registry.launch_table().unwrap();
    assert_eq!(t[0].args, ["--stdio", "--mode=acp"]);
    assert!(f.registry.confirm_launch("acp", &bin, vec!["a\nb".into()]).is_err());
    assert!(f.registry.confirm_launch("acp", &bin, vec![String::new()]).is_err());
}

#[test]
fn key_modes_of_experimental_providers_cannot_run_yet() {
    let f = fixture();
    let bin = good_script(&f, "gemini");
    f.registry.set_experimental(true).unwrap();
    f.registry.detect(&f.bin).unwrap();
    f.registry.set_enabled("gemini", true).unwrap();
    f.registry.confirm_launch("gemini", &bin, vec!["--acp".into()]).unwrap();
    assert_eq!(f.registry.launch_table().unwrap().len(), 1);
    let p = f.registry.set_auth_mode("gemini", "apiKey").unwrap();
    assert_eq!(p.state, ProviderState::NeedsLogin);
    assert!(f.registry.launch_table().unwrap().is_empty());
}

#[test]
fn allow_weak_writer_needs_the_provider_id_typed_and_defaults_off() {
    let f = fixture();
    let list = f.registry.list().unwrap();
    assert!(list.iter().all(|p| !p.allow_weak_writer));
    for typed in ["", "yes", "GEMINI", "codex"] {
        assert!(f.registry.set_allow_weak_writer("gemini", true, typed).is_err_and(|e| e.code == code::CONFIRMATION_REQUIRED), "{typed}");
    }
    assert!(f.registry.set_allow_weak_writer("claude", true, "claude").is_err());
    assert!(!find(&f.registry.list().unwrap(), "gemini").allow_weak_writer);
    let on = f.registry.set_allow_weak_writer("gemini", true, "gemini").unwrap();
    assert!(on.allow_weak_writer);
    // per provider, persisted, and turning it off needs no ceremony
    assert!(!find(&f.registry.list().unwrap(), "codex").allow_weak_writer);
    assert!(f.settings.get("providers").unwrap()["gemini"]["allowWeakWriter"] == json!(true));
    assert!(!f.registry.set_allow_weak_writer("gemini", false, "").unwrap().allow_weak_writer);
}
