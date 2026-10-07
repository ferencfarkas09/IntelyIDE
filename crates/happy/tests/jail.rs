//! The jail keeps Happy off the network: nothing at all in read-only mode, loopback only in the test jail.

mod common;

use std::sync::Arc;

use common::*;
use intely_core::jail::Jail;
use intely_happy::types::{ConfigPatch, Env, PrefsPatch};
use intely_happy::{Hub, Opener, Sink};
use intely_settings::secrets::{MemorySecretStore, SecretStore};
use intely_settings::SettingsStore;

async fn jailed_hub(jail: Jail, url: &str) -> (Hub, Arc<MemorySecretStore>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let settings = Arc::new(SettingsStore::open(&dir.path().join("settings.json")).unwrap());
    let secrets = Arc::new(MemorySecretStore::new());
    let hub = Hub::with_jail(
        settings,
        Arc::clone(&secrets) as Arc<dyn SecretStore>,
        Arc::new(RecordingSink::default()) as Arc<dyn Sink>,
        Arc::new(RecordingOpener::default()) as Arc<dyn Opener>,
        jail,
    );
    hub.set_config(ConfigPatch { env: Some(Env::Custom), custom_base_url: Some(url.to_owned()), ..Default::default() }).await.unwrap();
    (hub, secrets, dir)
}

#[tokio::test]
async fn read_only_mode_sends_nothing_and_saves_nothing() {
    let stub = Stub::start(fixtures).await;
    let (hub, secrets, _dir) = jailed_hub(Jail::read_only(), &stub.url()).await;
    let test = hub.save_token(JWT).await;
    assert!(!test.ok && test.message.as_deref().is_some_and(|m| m.contains("readOnly")), "{test:?}");
    assert!(secrets.get("happy.token.custom").unwrap().is_none());
    let prefs = Some(PrefsPatch { enabled: Some(true), ..Default::default() });
    hub.set_config(ConfigPatch { master: Some(true), timer: prefs, ..Default::default() }).await.unwrap();
    assert!(!hub.test_connection().await.ok);
    assert!(stub.requests.lock().unwrap().is_empty(), "no request reached the server");
}

#[tokio::test]
async fn the_test_jail_allows_loopback_and_refuses_everything_else() {
    let stub = Stub::start(fixtures).await;
    let tmp = tempfile::tempdir().unwrap();
    let (hub, _secrets, _dir) = jailed_hub(Jail::e2e(tmp.path()), &stub.url()).await;
    assert!(hub.save_token(JWT).await.ok, "the local mock server is fine");

    let (hub, _secrets, _dir) = jailed_hub(Jail::e2e(tmp.path()), "https://happy.example.test").await;
    let test = hub.save_token(JWT).await;
    assert!(!test.ok && test.message.as_deref().is_some_and(|m| m.contains("testJail")), "{test:?}");
}

#[tokio::test]
async fn a_token_saved_for_one_custom_url_is_dropped_when_the_url_changes() {
    let stub = Stub::start(fixtures).await;
    let rig = Rig::new(&stub).await;
    rig.give_token();
    assert!(rig.secrets.has("happy.token.custom").unwrap());
    rig.hub.set_config(ConfigPatch { custom_base_url: Some(stub.url()), ..Default::default() }).await.unwrap();
    assert!(rig.secrets.has("happy.token.custom").unwrap(), "the same URL keeps the token");
    rig.hub.set_config(ConfigPatch { custom_base_url: Some("https://other.example.test".into()), ..Default::default() }).await.unwrap();
    assert!(!rig.secrets.has("happy.token.custom").unwrap(), "another host starts without a token");
}
