//! `settings.json`: one versioned JSON object, namespaced by module (`{"version":1,"editor":{...}}`).
//!
//! Unknown namespaces and keys survive every write, a corrupt or newer file is reported and never overwritten, writes
//! are atomic (temp file, fsync, rename) with mode 0600. The file lives in the IDE state directory, which the agent
//! hard stop already denies to agents. Secrets never belong here: [`SettingsStore::set`] refuses secret-looking keys.

use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};

use serde_json::{Map, Value};

use crate::error::{code, Result, SettingsError};
use crate::events::Listeners;

pub type Object = Map<String, Value>;

pub const VERSION: u64 = 1;
const VERSION_KEY: &str = "version";

/// `~/Library/Application Support/IntelySwitchIDE`, the same state directory as `workspace.json` and the agent runs.
pub fn state_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join("Library/Application Support/IntelySwitchIDE")
}

/// `INTELY_SETTINGS` if set (tests), else `<state dir>/settings.json`.
pub fn resolve_path() -> PathBuf {
    std::env::var_os("INTELY_SETTINGS").map(PathBuf::from).unwrap_or_else(|| state_dir().join("settings.json"))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub ns: String,
    pub value: Object,
}

pub struct SettingsStore {
    path: PathBuf,
    root: Mutex<Object>,
    listeners: Listeners<Change>,
}

impl SettingsStore {
    /// A missing file is an empty store (nothing is written until the first `set`).
    pub fn open(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        let root = match std::fs::read(&path) {
            Ok(bytes) => parse(&bytes, &path)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Object::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self { path, root: Mutex::new(root), listeners: Listeners::default() })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// One namespace; unknown (or non-object) namespaces read as `{}`.
    pub fn get(&self, ns: &str) -> Result<Object> {
        check_namespace(ns)?;
        Ok(self.lock().get(ns).and_then(Value::as_object).cloned().unwrap_or_default())
    }

    /// Shallow-merges `patch` into the namespace (a `null` value removes the key) and returns the result. The file keeps
    /// every other namespace and key as it was.
    pub fn set(&self, ns: &str, patch: Object) -> Result<Object> {
        check_namespace(ns)?;
        if let Some(path) = find_secret(&Value::Object(patch.clone()), String::new()) {
            return Err(SettingsError::new(code::SECRET_IN_SETTINGS, format!("`{path}` looks like a secret; store it with ipc.secrets instead")));
        }
        let merged = {
            let mut root = self.lock();
            let mut value = root.get(ns).and_then(Value::as_object).cloned().unwrap_or_default();
            for (key, v) in patch {
                if v.is_null() {
                    value.remove(&key);
                } else {
                    value.insert(key, v);
                }
            }
            let mut next = root.clone();
            next.insert(VERSION_KEY.to_owned(), Value::from(VERSION));
            next.insert(ns.to_owned(), Value::Object(value.clone()));
            write_atomic(&self.path, &next)?;
            *root = next;
            value
        };
        self.listeners.emit(&Change { ns: ns.to_owned(), value: merged.clone() });
        Ok(merged)
    }

    pub fn subscribe(&self, cb: impl Fn(&Change) + Send + Sync + 'static) {
        self.listeners.add(cb);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Object> {
        self.root.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn parse(bytes: &[u8], path: &Path) -> Result<Object> {
    let invalid = |why: String| SettingsError::new(code::INVALID_SETTINGS, "settings.json is not valid").with_detail(format!("{}: {why}", path.display()));
    let Value::Object(root) = serde_json::from_slice(bytes).map_err(|e| invalid(e.to_string()))? else {
        return Err(invalid("not a JSON object".to_owned()));
    };
    match root.get(VERSION_KEY) {
        None => {}
        Some(v) => match v.as_u64() {
            Some(n) if n <= VERSION => {}
            Some(n) => {
                return Err(SettingsError::new(code::UNSUPPORTED_VERSION, format!("settings.json has version {n}, this build understands {VERSION}")));
            }
            None => return Err(invalid("version is not a number".to_owned())),
        },
    }
    Ok(root)
}

/// Namespaces equal module names: lowercase, digits and `-`.
fn check_namespace(ns: &str) -> Result<()> {
    let mut chars = ns.chars();
    let ok = ns.len() <= 32
        && chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && ns != VERSION_KEY;
    ok.then_some(()).ok_or_else(|| SettingsError::new(code::INVALID_NAMESPACE, format!("`{ns}` is not a valid settings namespace")))
}

/// The path of the first non-empty string stored under a key that names a secret.
fn find_secret(value: &Value, path: String) -> Option<String> {
    let Value::Object(map) = value else { return None };
    map.iter().find_map(|(key, v)| {
        let here = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
        match v {
            Value::String(s) if !s.is_empty() && looks_secret(key) => Some(here),
            Value::Object(_) => find_secret(v, here),
            _ => None,
        }
    })
}

fn looks_secret(key: &str) -> bool {
    let k: String = key.chars().filter(|c| !matches!(c, '-' | '_' | '.')).collect::<String>().to_ascii_lowercase();
    k == "token" || ["secret", "password", "passwd", "apikey", "bearer", "authtoken", "accesstoken", "privatekey"].iter().any(|n| k.contains(n))
}

fn write_atomic(path: &Path, root: &Object) -> Result<()> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".settings.{}.{}.tmp", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed)));
    let mut json = serde_json::to_vec_pretty(root).map_err(|e| SettingsError::new(code::IO, e.to_string()))?;
    json.push(b'\n');
    let written = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp).and_then(|mut f| {
        f.write_all(&json)?;
        f.sync_all()
    });
    if let Err(e) = written.and_then(|()| std::fs::rename(&tmp, path)) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::*;

    fn obj(v: Value) -> Object {
        v.as_object().cloned().expect("object")
    }

    fn open(dir: &tempfile::TempDir) -> SettingsStore {
        SettingsStore::open(dir.path().join("settings.json")).expect("open")
    }

    #[test]
    fn a_missing_file_is_empty_and_is_not_created_by_reading() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        assert_eq!(store.get("editor").unwrap(), Object::new());
        assert!(!dir.path().join("settings.json").exists());
    }

    #[test]
    fn set_merges_shallowly_persists_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        store.set("editor", obj(json!({ "fontSize": 13, "wrap": true }))).unwrap();
        let merged = store.set("editor", obj(json!({ "fontSize": 14, "tabs": { "size": 2 } }))).unwrap();
        assert_eq!(Value::Object(merged), json!({ "fontSize": 14, "wrap": true, "tabs": { "size": 2 } }));
        let reopened = open(&dir);
        assert_eq!(reopened.get("editor").unwrap(), store.get("editor").unwrap());
        let file: Value = serde_json::from_slice(&std::fs::read(store.path()).unwrap()).unwrap();
        assert_eq!(file["version"], json!(1));
    }

    #[test]
    fn null_removes_a_key() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        store.set("editor", obj(json!({ "a": 1, "b": 2 }))).unwrap();
        let merged = store.set("editor", obj(json!({ "a": null }))).unwrap();
        assert_eq!(Value::Object(merged), json!({ "b": 2 }));
    }

    #[test]
    fn unknown_namespaces_and_keys_pass_through_every_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"version":1,"future":{"x":[1,2]},"editor":{"newKey":"kept"},"topLevelExtra":true}"#).unwrap();
        let store = SettingsStore::open(&path).unwrap();
        store.set("editor", obj(json!({ "fontSize": 12 }))).unwrap();
        store.set("terminal", obj(json!({ "shell": "zsh" }))).unwrap();
        let file: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(file["future"], json!({ "x": [1, 2] }));
        assert_eq!(file["topLevelExtra"], json!(true));
        assert_eq!(file["editor"], json!({ "newKey": "kept", "fontSize": 12 }));
        assert_eq!(file["terminal"], json!({ "shell": "zsh" }));
    }

    #[test]
    fn the_file_is_private_and_no_temp_file_is_left() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        store.set("editor", obj(json!({ "a": 1 }))).unwrap();
        let mode = std::fs::metadata(store.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(names, vec!["settings.json"]);
    }

    #[test]
    fn a_corrupt_or_newer_file_is_reported_and_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(SettingsStore::open(&path).err().unwrap().code, code::INVALID_SETTINGS);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
        std::fs::write(&path, r#"{"version":2,"editor":{}}"#).unwrap();
        assert_eq!(SettingsStore::open(&path).err().unwrap().code, code::UNSUPPORTED_VERSION);
        std::fs::write(&path, "[]").unwrap();
        assert_eq!(SettingsStore::open(&path).err().unwrap().code, code::INVALID_SETTINGS);
    }

    #[test]
    fn invalid_namespaces_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        for ns in ["", "Editor", "../x", "a b", "version", "1x"] {
            assert_eq!(store.get(ns).err().unwrap().code, code::INVALID_NAMESPACE, "{ns}");
        }
    }

    #[test]
    fn secret_looking_keys_are_refused_but_ordinary_ones_pass() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        for patch in [json!({ "apiKey": "x" }), json!({ "nested": { "Client_Secret": "x" } }), json!({ "token": "x" }), json!({ "dbPassword": "x" })] {
            assert_eq!(store.set("providers", obj(patch)).err().unwrap().code, code::SECRET_IN_SETTINGS);
        }
        store.set("providers", obj(json!({ "maxTokens": "4096", "token": "", "hasApiKey": true, "keybinding": "k" }))).unwrap();
        assert!(store.get("providers").unwrap().contains_key("maxTokens"));
    }

    #[test]
    fn change_events_fire_after_a_successful_write_only() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        store.subscribe(move |c| sink.lock().unwrap().push(c.clone()));
        store.set("editor", obj(json!({ "a": 1 }))).unwrap();
        assert!(store.set("editor", obj(json!({ "apiKey": "x" }))).is_err());
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].ns, "editor");
        assert_eq!(Value::Object(seen[0].value.clone()), json!({ "a": 1 }));
    }

    #[test]
    fn a_failed_write_leaves_memory_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let locked = dir.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o500)).unwrap();
        let store = SettingsStore::open(locked.join("settings.json")).unwrap();
        let err = store.set("editor", obj(json!({ "a": 1 }))).err().unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(err.code, code::IO);
        assert_eq!(store.get("editor").unwrap(), Object::new());
    }

    #[test]
    fn the_default_settings_file_is_inside_the_agent_protected_state_directory() {
        assert!(state_dir().ends_with("Library/Application Support/IntelySwitchIDE"));
    }
}
