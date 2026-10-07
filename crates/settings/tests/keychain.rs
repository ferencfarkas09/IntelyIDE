//! MANUAL TEST of the real macOS Keychain. `#[ignore]` by default: it talks to the user's login keychain and, in an
//! ad-hoc-signed dev build, can pop a permission dialog. Plan and what to look for: docs/safety.md, "Keychain: manual test plan".
//!
//!     cargo test -p intely-settings --test keychain -- --ignored --nocapture --test-threads=1
//!
//! It never touches the items of the real IDE: the service name is unique per run (`...intelyswitchide.test.<pid>.<nanos>`)
//! and a guard deletes every item it created, also when an assertion fails (the guard runs while unwinding).

#![cfg(target_os = "macos")]

use intely_settings::secrets::{Secret, SecretStore, SERVICE};
use intely_settings::ScopedKeychainStore;

const KEYS: [&str; 2] = ["test.alpha", "test.beta"];

/// Deletes the test items when it goes out of scope, panic or not.
struct Cleanup(ScopedKeychainStore);

impl Drop for Cleanup {
    fn drop(&mut self) {
        for key in KEYS {
            if let Err(e) = self.0.remove(key) {
                eprintln!("CLEANUP FAILED for {key} in service {}: {e}. Delete it by hand in Keychain Access (search for the service name).", self.0.service());
            }
        }
    }
}

fn unique_service() -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    format!("{SERVICE}.test.{}.{nanos}", std::process::id())
}

#[test]
#[ignore = "touches the real macOS Keychain (may show a permission dialog); run by hand, see docs/safety.md"]
fn the_keychain_round_trips_a_secret_under_a_throwaway_service_and_cleans_up() {
    let service = unique_service();
    assert!(service.starts_with(SERVICE) && service != SERVICE, "never the real service name");
    let store = ScopedKeychainStore::new(service);
    let _cleanup = Cleanup(store.clone());
    eprintln!("service under test: {} (a dialog may appear: choose Allow / Always Allow)", store.service());

    assert!(!store.has(KEYS[0]).unwrap(), "fresh service starts empty");
    store.set(KEYS[0], Secret::new("canary-value-1")).unwrap();
    assert!(store.has(KEYS[0]).unwrap());
    assert_eq!(store.get(KEYS[0]).unwrap().unwrap().expose(), "canary-value-1");
    // overwrite
    store.set(KEYS[0], Secret::new("canary-value-2")).unwrap();
    assert_eq!(store.get(KEYS[0]).unwrap().unwrap().expose(), "canary-value-2");
    // a second key is independent
    store.set(KEYS[1], Secret::new("other")).unwrap();
    store.remove(KEYS[0]).unwrap();
    assert!(!store.has(KEYS[0]).unwrap() && store.has(KEYS[1]).unwrap());
    // removing what is not there is fine
    store.remove(KEYS[0]).unwrap();
    assert!(store.get(KEYS[0]).unwrap().is_none());
}
