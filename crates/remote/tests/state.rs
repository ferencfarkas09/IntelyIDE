//! Persistent state: the device registry, the audit chain and the identity.

use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;

use intely_remote::audit::{AuditLog, Record};
use intely_remote::devices::{Device, DeviceRegistry, MAX_DEVICES};
use intely_remote::identity::{Identity, KEY_AUDIT_HEAD};
use intely_remote::wire::Capability;
use intely_remote::RemoteError;
use intely_settings::{MemorySecretStore, Secret, SecretStore};

fn secrets() -> Arc<dyn SecretStore> {
    Arc::new(MemorySecretStore::new())
}

fn dev(n: usize) -> Device {
    Device { id: format!("dev{n}"), name: format!("Phone {n}"), static_pub: format!("{n:064x}"), passkey: None, capability: Capability::View, created_at: 1, last_seen_at: 1, last_reauth_at: 1, token_hash: "h".into(), push_endpoint_hash: None, pinned: false }
}

#[test]
fn the_registry_is_private_atomic_and_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let s = secrets();
    let mut r = DeviceRegistry::open(dir.path(), s.clone()).unwrap();
    r.add(dev(1)).unwrap();
    let mode = std::fs::metadata(DeviceRegistry::path_in(dir.path())).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    assert!(!dir.path().join("devices.json.tmp").exists());
    drop(r);
    let r = DeviceRegistry::open(dir.path(), s).unwrap();
    assert_eq!(r.list().len(), 1);
    assert_eq!(r.list()[0].name, "Phone 1");
}

#[test]
fn an_edited_registry_is_tampered_and_nothing_is_adopted() {
    let dir = tempfile::tempdir().unwrap();
    let s = secrets();
    let mut r = DeviceRegistry::open(dir.path(), s.clone()).unwrap();
    r.add(dev(1)).unwrap();
    let path = DeviceRegistry::path_in(dir.path());
    // an agent (or anything) adds its own device
    let mut v: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    v["devices"].as_array_mut().unwrap().push(serde_json::to_value(dev(2)).unwrap());
    std::fs::write(&path, serde_json::to_vec(&v).unwrap()).unwrap();
    assert!(matches!(r.verify_on_disk(), Err(RemoteError::Tampered(_))), "the running process notices");
    assert!(matches!(DeviceRegistry::open(dir.path(), s.clone()), Err(RemoteError::Tampered(_))), "and a restart refuses the file");
    // a forged MAC does not help
    v["mac"] = serde_json::Value::String("00".repeat(32));
    std::fs::write(&path, serde_json::to_vec(&v).unwrap()).unwrap();
    assert!(matches!(DeviceRegistry::open(dir.path(), s.clone()), Err(RemoteError::Tampered(_))));
    // garbage and a missing key
    std::fs::write(&path, b"{not json").unwrap();
    assert!(matches!(DeviceRegistry::open(dir.path(), s), Err(RemoteError::Tampered(_))));
    assert!(matches!(DeviceRegistry::open(dir.path(), secrets()), Err(RemoteError::Tampered(_))), "a registry without its MAC key is not trusted");
}

#[test]
fn a_deleted_registry_is_noticed_while_running() {
    let dir = tempfile::tempdir().unwrap();
    let mut r = DeviceRegistry::open(dir.path(), secrets()).unwrap();
    r.add(dev(1)).unwrap();
    std::fs::remove_file(DeviceRegistry::path_in(dir.path())).unwrap();
    assert!(matches!(r.verify_on_disk(), Err(RemoteError::Tampered(_))));
}

#[test]
fn an_admin_level_in_the_file_loads_as_view_and_the_device_count_is_capped() {
    let dir = tempfile::tempdir().unwrap();
    let s = secrets();
    let mut r = DeviceRegistry::open(dir.path(), s).unwrap();
    for n in 0..MAX_DEVICES {
        r.add(dev(n)).unwrap();
    }
    assert!(r.add(dev(99)).is_err());
    assert!(r.add(dev(0)).is_err(), "no duplicate key");
    let json = serde_json::to_string(&dev(7)).unwrap().replace("\"view\"", "\"control\"");
    let d: Device = serde_json::from_str(&json).unwrap();
    assert_eq!(d.capability, Capability::View);
}

#[test]
fn unused_devices_expire_after_30_days_and_revoke_works() {
    let dir = tempfile::tempdir().unwrap();
    let mut r = DeviceRegistry::open(dir.path(), secrets()).unwrap();
    r.add(dev(1)).unwrap();
    r.add(dev(2)).unwrap();
    r.touch("dev2", 29 * 24 * 3600 * 1000);
    let gone = r.expire_unused(31 * 24 * 3600 * 1000).unwrap();
    assert_eq!(gone, vec!["dev1".to_string()]);
    assert!(r.revoke("dev2").unwrap());
    assert!(!r.revoke("dev2").unwrap());
}

#[test]
fn the_audit_chain_detects_edits_truncation_and_deletion() {
    let dir = tempfile::tempdir().unwrap();
    let s = secrets();
    let mut a = AuditLog::open(dir.path(), s.clone()).unwrap();
    for i in 0..5 {
        a.append(Record::new("test.event").device("d1").detail(&format!("n{i}")), 1000 + i).unwrap();
    }
    assert_eq!(a.len(), 5);
    let path = AuditLog::path_in(dir.path());
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    drop(a);
    assert_eq!(AuditLog::open(dir.path(), s.clone()).unwrap().len(), 5);
    let original = std::fs::read_to_string(&path).unwrap();
    let lines: Vec<&str> = original.lines().collect();

    // edit a line
    std::fs::write(&path, original.replace("n2", "n9")).unwrap();
    assert!(matches!(AuditLog::open(dir.path(), s.clone()), Err(RemoteError::Tampered(_))));
    // drop the last two lines (head hash in the secret store no longer matches)
    std::fs::write(&path, format!("{}\n", lines[..3].join("\n"))).unwrap();
    assert!(matches!(AuditLog::open(dir.path(), s.clone()), Err(RemoteError::Tampered(_))));
    // drop a middle line
    std::fs::write(&path, format!("{}\n", [lines[0], lines[1], lines[3], lines[4]].join("\n"))).unwrap();
    assert!(matches!(AuditLog::open(dir.path(), s.clone()), Err(RemoteError::Tampered(_))));
    // delete the file
    std::fs::remove_file(&path).unwrap();
    assert!(matches!(AuditLog::open(dir.path(), s.clone()), Err(RemoteError::Tampered(_))));
    // the explicit desktop action starts a new chain and keeps the old file aside
    std::fs::write(&path, &original).unwrap();
    AuditLog::reset_after_tamper(dir.path(), &s, 42).unwrap();
    assert!(dir.path().join("remote-audit.jsonl.tampered-42").exists());
    assert!(AuditLog::open(dir.path(), s).unwrap().is_empty());
}

#[test]
fn a_crash_between_the_line_and_the_head_update_heals() {
    let dir = tempfile::tempdir().unwrap();
    let s = secrets();
    let mut a = AuditLog::open(dir.path(), s.clone()).unwrap();
    a.append(Record::new("one"), 1).unwrap();
    let head_after_one = s.get(KEY_AUDIT_HEAD).unwrap().unwrap().expose().to_string();
    a.append(Record::new("two"), 2).unwrap();
    drop(a);
    s.set(KEY_AUDIT_HEAD, Secret::new(head_after_one)).unwrap(); // the head update of "two" never happened
    let a = AuditLog::open(dir.path(), s.clone()).unwrap();
    assert_eq!(a.len(), 2);
    drop(a);
    assert!(AuditLog::open(dir.path(), s).is_ok(), "and the store was healed");
}

#[test]
fn audit_entries_are_scrubbed_capped_and_hold_no_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = AuditLog::open(dir.path(), secrets()).unwrap();
    let e = a.append(Record::new("x").detail(&format!("token ghp_CANARYCANARYCANARYCANARYCANARY0123 {}", "z".repeat(5000))), 1).unwrap();
    assert!(!e.detail.as_ref().unwrap().contains("ghp_"));
    assert!(e.detail.unwrap().len() < 400);
    assert_eq!(a.tail(10).len(), 1);
}

#[test]
fn identity_is_stable_until_rotated_and_rotation_changes_key_room_and_token() {
    let s = secrets();
    let a = Identity::load_or_create(&s).unwrap();
    let b = Identity::load_or_create(&s).unwrap();
    assert_eq!(a.static_key.public, b.static_key.public);
    assert_eq!(a.room_id.len(), 22);
    let c = Identity::rotate(&s).unwrap();
    assert_ne!(a.static_key.public, c.static_key.public);
    assert_ne!(a.room_id, c.room_id);
    assert_ne!(a.mac_token, c.mac_token);
    assert_eq!(Identity::load_or_create(&s).unwrap().room_id, c.room_id);
    assert!(!format!("{c:?}").contains(&c.mac_token), "Debug never prints the token");
}
