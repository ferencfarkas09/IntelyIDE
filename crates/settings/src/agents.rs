//! Typed accessors of the `agents` settings namespace (the rest of it, the model, the cap and the kill switches, is read by the
//! agent host from the raw object at every start).

use serde_json::{json, Value};

use crate::error::Result;
use crate::store::{Object, SettingsStore};

pub const NAMESPACE: &str = "agents";
/// `agents.includeUserMemory`: put the user's own `~/.claude/CLAUDE.md` into the prompt of an agent run (default on).
pub const INCLUDE_USER_MEMORY_KEY: &str = "includeUserMemory";

/// The switch as stored in an `agents` object; absent or not a boolean means on.
pub fn include_user_memory_in(ns: &Object) -> bool {
    ns.get(INCLUDE_USER_MEMORY_KEY).and_then(Value::as_bool).unwrap_or(true)
}

/// `agents.includeUserMemory` (default true).
pub fn include_user_memory(store: &SettingsStore) -> Result<bool> {
    Ok(include_user_memory_in(&store.get(NAMESPACE)?))
}

/// `agents.tokenHabits`: append the token-saving habits to the prompt of a Claude run (default off; docs/token-saver.md).
pub const TOKEN_HABITS_KEY: &str = "tokenHabits";

/// The switch as stored in an `agents` object; absent or not a boolean means off.
pub fn token_habits_in(ns: &Object) -> bool {
    ns.get(TOKEN_HABITS_KEY).and_then(Value::as_bool).unwrap_or(false)
}

pub fn set_include_user_memory(store: &SettingsStore, on: bool) -> Result<bool> {
    Ok(include_user_memory_in(&store.set(NAMESPACE, Object::from_iter([(INCLUDE_USER_MEMORY_KEY.to_owned(), json!(on))]))?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, SettingsStore) {
        let dir = tempfile::tempdir().unwrap();
        let s = SettingsStore::open(dir.path().join("settings.json")).unwrap();
        (dir, s)
    }

    #[test]
    fn user_memory_is_on_by_default_and_junk_reads_as_on() {
        let (_d, s) = store();
        assert!(include_user_memory(&s).unwrap());
        s.set(NAMESPACE, Object::from_iter([(INCLUDE_USER_MEMORY_KEY.to_owned(), json!("no"))])).unwrap();
        assert!(include_user_memory(&s).unwrap(), "a non-boolean value is ignored");
    }

    #[test]
    fn token_habits_are_off_by_default_and_only_a_true_switches_them_on() {
        let (_d, s) = store();
        assert!(!token_habits_in(&s.get(NAMESPACE).unwrap()));
        s.set(NAMESPACE, Object::from_iter([(TOKEN_HABITS_KEY.to_owned(), json!("yes"))])).unwrap();
        assert!(!token_habits_in(&s.get(NAMESPACE).unwrap()), "a non-boolean value is ignored");
        s.set(NAMESPACE, Object::from_iter([(TOKEN_HABITS_KEY.to_owned(), json!(true))])).unwrap();
        assert!(token_habits_in(&s.get(NAMESPACE).unwrap()));
        assert!(include_user_memory(&s).unwrap(), "the other switch is untouched");
    }

    #[test]
    fn the_switch_is_remembered_and_leaves_the_other_agent_keys_alone() {
        let (d, s) = store();
        s.set(NAMESPACE, Object::from_iter([("delegationCap".to_owned(), json!(7))])).unwrap();
        assert!(!set_include_user_memory(&s, false).unwrap());
        let again = SettingsStore::open(d.path().join("settings.json")).unwrap();
        assert!(!include_user_memory(&again).unwrap());
        assert_eq!(again.get(NAMESPACE).unwrap()["delegationCap"], json!(7));
        assert!(set_include_user_memory(&again, true).unwrap());
    }
}
