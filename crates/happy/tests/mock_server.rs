//! Runs the hub against the real mock Happy server (scripts/mock-happy/server.mjs). Ignored by default because it needs a
//! running server:
//!
//!   node scripts/mock-happy/server.mjs --port 4010 &
//!   INTELY_MOCK_HAPPY_URL=http://127.0.0.1:4010 INTELY_MOCK_HAPPY_TOKEN=<token printed by the server> \
//!     cargo test -p intely-happy --test mock_server -- --ignored --test-threads=1
//!
//! One server is shared and the failure injection is global, so the tests must not run in parallel.
mod common;

use common::Rig;
use intely_happy::types::{ProviderState, TimerPhase};
use intely_settings::secrets::SecretStore;

/// Threads, the pushed notification, history jumps and the channel verbs against the real-shaped mock (and its real
/// `socket.io` server): the contract the offline tests in `realtime.rs` assert with fixtures.
#[tokio::test]
#[ignore = "needs scripts/mock-happy/server.mjs running (with socket.io installed)"]
async fn threads_notifications_and_channels_talk_to_the_mock_server() {
    use intely_happy::types::{ChatEvent, ChatKind, ChatLink, ConfigPatch, MessageChange, PrefsPatch};

    let url = std::env::var("INTELY_MOCK_HAPPY_URL").expect("INTELY_MOCK_HAPPY_URL");
    let token = std::env::var("INTELY_MOCK_HAPPY_TOKEN").expect("INTELY_MOCK_HAPPY_TOKEN");
    assert!(url.starts_with("http://127.0.0.1:"), "the mock server is loopback only");
    mock_post(&url, "/__mock/reset", serde_json::json!({})).await;
    let rig = Rig::fast(url.clone()).await;
    let on = |on| Some(PrefsPatch { enabled: Some(on), ..Default::default() });
    rig.hub.set_config(ConfigPatch { master: Some(true), chat: on(true), notifications: on(true), ..Default::default() }).await.unwrap();
    assert!(rig.hub.save_token(&token).await.ok);
    rig.wait_state("chat", ProviderState::Ready).await;
    rig.wait_state("notifications", ProviderState::Ready).await;
    common::wait_for(|| async { rig.hub.socket_link() == ChatLink::Live }).await;
    assert_eq!(rig.hub.socket_attempts(), 1, "chat and the inbox share one socket");

    let summary = rig.hub.chat_summary();
    assert_eq!((summary.thread_unread, summary.can_create_channel), (1, true), "the unread thread of #ops, and the store lets the user create channels");
    let id_of = |name: &str| rig.hub.chat_summary().channels.iter().find(|c| c.name == name).map(|c| c.id.clone()).unwrap_or_else(|| panic!("no channel {name}"));
    let (general, ops) = (id_of("general"), id_of("ops"));
    assert!(rig.hub.chat_summary().channels.iter().any(|c| c.kind == ChatKind::Group && c.name.contains(',')), "a group DM is named after its peers");

    // The thread of #ops: root + replies; opening it marks it read.
    let threads = rig.hub.chat_threads(true).await.unwrap();
    assert_eq!((threads.len(), threads[0].channel_name.as_str()), (1, "ops"));
    let root = threads[0].root.id.clone();
    let view = rig.hub.chat_thread(&root).await.unwrap();
    assert!(!view.replies.is_empty() && view.replies.iter().all(|r| r.thread_root.as_deref() == Some(root.as_str())));
    assert_eq!(rig.hub.chat_summary().thread_unread, 0);

    // A reply from somebody else, with its notification: the thread event, no channel unread, the inbox at once.
    let unread0 = rig.hub.chat_summary().unread_total;
    let inbox0 = rig.hub.notifications_current().unread;
    mock_post(&url, "/__mock/chat/say", serde_json::json!({ "channelId": "ops", "text": "valasz a szalban", "from": "u_3", "mention": true, "threadRootId": root, "notify": true })).await;
    common::wait_for(|| async { rig.sink.chats.lock().unwrap().iter().any(|e| matches!(e, ChatEvent::Message { message, change: MessageChange::New, .. } if message.thread_root.as_deref() == Some(root.as_str()) && message.text == "valasz a szalban")) }).await;
    common::wait_for(|| async { rig.hub.notifications_current().unread > inbox0 }).await;
    assert_eq!(rig.hub.chat_summary().unread_total, unread0, "a thread reply never bumps the channel");
    assert!(rig.hub.notifications_current().items.iter().any(|i| i.thread_root.as_deref() == Some(root.as_str()) && i.channel_id.as_deref() == Some(ops.as_str())), "the pushed notification carries its target");
    // My own reply.
    let reply = rig.hub.chat_send(&ops, "en is valaszolok", vec![], None, Some(root.clone())).await.unwrap();
    assert_eq!(reply.thread_root.as_deref(), Some(root.as_str()));
    assert!(rig.hub.chat_open(&ops).await.unwrap().messages.iter().all(|m| m.thread_root.is_none()));

    // History: a jump around an old message, then back.
    let newest = rig.hub.chat_open(&general).await.unwrap();
    let old = rig.hub.chat_older(&general, newest.cursor.as_deref().unwrap()).await.unwrap();
    let target = old.messages[old.messages.len() / 2].id.clone();
    let window = rig.hub.chat_around(&general, &target).await.unwrap();
    assert!(window.messages.iter().any(|m| m.id == target) && window.has_newer && window.anchor_id.as_deref() == Some(target.as_str()));

    // Channels: create (+ the refusals), browse, join, leave, invite.
    let made = rig.hub.chat_create_channel("mock-projekt", "teszt", false, &[]).await.unwrap();
    assert_eq!(made.kind, ChatKind::Channel);
    assert_eq!(rig.hub.chat_create_channel("mock-projekt", "", false, &[]).await.unwrap_err().code, "CHANNEL_NAME_TAKEN");
    mock_post(&url, "/__mock/chat/create-forbidden", serde_json::json!({ "on": true })).await;
    assert_eq!(rig.hub.chat_create_channel("masik", "", false, &[]).await.unwrap_err().code, "CREATE_FORBIDDEN");
    let browse = rig.hub.chat_browse("").await.unwrap();
    let random = browse.iter().find(|c| c.name == "random").expect("random is browsable").id.clone();
    assert!(!browse[0].is_member);
    assert!(rig.hub.chat_join(&random).await.unwrap().is_member);
    rig.hub.chat_leave(&random).await.unwrap();
    let people = rig.hub.chat_directory("").await.unwrap();
    let anna = people.iter().find(|p| p.name.contains("Anna")).expect("Anna in the directory").id.clone();
    let members = rig.hub.chat_members(&ops).await.unwrap();
    assert!(!members.is_empty());
    let dm = rig.hub.chat_summary().channels.iter().find(|c| c.kind == ChatKind::Direct).map(|c| c.id.clone()).unwrap();
    assert_eq!(rig.hub.chat_add_members(&dm, &[anna]).await.unwrap_err().code, "DIRECT_IMMUTABLE");

    // The pilot gate: every chat route refuses, the hub shows a friendly state and does not hammer the server.
    mock_post(&url, "/__mock/chat-disabled", serde_json::json!({ "on": true })).await;
    assert_eq!(rig.hub.chat_refresh().await.unwrap_err().code, "TEAM_CHAT_NOT_ENABLED");
    mock_post(&url, "/__mock/reset", serde_json::json!({})).await;
}

#[tokio::test]
#[ignore = "needs scripts/mock-happy/server.mjs running"]
async fn the_hub_talks_to_the_mock_server() {
    let url = std::env::var("INTELY_MOCK_HAPPY_URL").expect("INTELY_MOCK_HAPPY_URL");
    let token = std::env::var("INTELY_MOCK_HAPPY_TOKEN").expect("INTELY_MOCK_HAPPY_TOKEN");
    assert!(url.starts_with("http://127.0.0.1:"), "the mock server is loopback only");
    mock_post(&url, "/__mock/reset", serde_json::json!({})).await;
    let rig = Rig::at(url).await;
    rig.switch_on(true, true).await;
    let test = rig.hub.save_token(&token).await;
    assert!(test.ok, "{test:?}");
    assert_eq!(test.user.as_ref().map(|u| u.name.as_str()), Some("Teszt Elek"));
    assert!(rig.secrets.has("happy.token.custom").unwrap());
    rig.wait_state("timer", ProviderState::Ready).await;
    rig.wait_state("meet", ProviderState::Ready).await;

    let trackables = rig.hub.timer_trackables().await.unwrap();
    assert_eq!(trackables.len(), 4, "a work order, two projects with a task and one without");
    let receipts = trackables.iter().find(|t| t.title == "Receipts").unwrap().clone();
    assert_eq!(rig.hub.timer_start(receipts).await.unwrap().phase, TimerPhase::Running);
    assert_eq!(rig.hub.timer_pause().await.unwrap().phase, TimerPhase::Paused);
    assert_eq!(rig.hub.timer_resume().await.unwrap().phase, TimerPhase::Running);
    let now = intely_happy::time::now_ms();
    let day = rig.hub.timer_entries(now - 2 * 86_400_000, now + 86_400_000).await.unwrap();
    assert!(day.entries.iter().any(|e| e.ended_at_ms.is_none()) && day.entries.iter().any(|e| e.abandoned));
    let found = rig.hub.timer_search("rece").await.unwrap();
    assert_eq!(found.tasks[0].title, "Receipts");
    let made = rig.hub.timer_create_task("p_pos", "Gift cards").await.unwrap();
    assert_eq!(rig.hub.timer_start(made).await.unwrap().title, "Gift cards");
    assert_eq!(rig.hub.timer_stop().await.unwrap().phase, TimerPhase::Idle);

    let meetings = rig.hub.meet_list().await.unwrap().meetings;
    assert_eq!(meetings.len(), 3);
    rig.hub.meet_join("m_live_1").await.unwrap();
    let opened = rig.opener.opened.lock().unwrap().clone();
    assert!(opened.len() == 1 && opened[0].starts_with("https://meet.mock.test/"));
    assert!(!format!("{:?}", rig.hub.status().await).contains("MOCK-LIVEKIT-CANARY"));
}

async fn mock_post(base: &str, path: &str, body: serde_json::Value) {
    let r = reqwest::Client::new().post(format!("{base}{path}")).header("content-type", "application/json").body(body.to_string()).send().await.expect("mock control request");
    assert!(r.status().is_success(), "{path}: {}", r.status());
}

#[tokio::test]
#[ignore = "needs scripts/mock-happy/server.mjs running"]
async fn injected_403_and_401_are_handled_by_the_hub() {
    let url = std::env::var("INTELY_MOCK_HAPPY_URL").expect("INTELY_MOCK_HAPPY_URL");
    let token = std::env::var("INTELY_MOCK_HAPPY_TOKEN").expect("INTELY_MOCK_HAPPY_TOKEN");
    assert!(url.starts_with("http://127.0.0.1:"), "the mock server is loopback only");

    mock_post(&url, "/__mock/reset", serde_json::json!({})).await;
    mock_post(&url, "/__mock/fail", serde_json::json!({ "status": 403, "path": "/api/chat/meetings" })).await;
    let rig = Rig::at(url.clone()).await;
    rig.switch_on(true, true).await;
    assert!(rig.hub.save_token(&token).await.ok);
    rig.wait_state("timer", ProviderState::Ready).await;
    rig.wait_state("meet", ProviderState::NotPermitted).await;
    assert!(rig.hub.status().await.signed_out.is_none(), "a 403 does not sign the connection out");

    mock_post(&url, "/__mock/reset", serde_json::json!({})).await;
    mock_post(&url, "/__mock/fail", serde_json::json!({ "status": 401, "code": "DEVICE_LOGGED_OUT" })).await;
    assert!(rig.hub.timer_trackables().await.is_err());
    rig.wait_state("timer", ProviderState::SignedOut).await;
    rig.wait_state("meet", ProviderState::SignedOut).await;
    assert_eq!(rig.hub.status().await.signed_out.map(|b| b.code), Some("DEVICE_LOGGED_OUT".to_string()));
    assert_eq!((rig.hub.running_tasks(), rig.hub.has_client()), (0, false));
    mock_post(&url, "/__mock/reset", serde_json::json!({})).await;
}

/// The hand-written Socket.IO client against the real `socket.io` npm server: auth, join, live events, replay dedupe, a
/// server-side drop with reconnect, meeting live events, and a revoked token ending in the persistent signed-out state.
#[tokio::test]
#[ignore = "needs scripts/mock-happy/server.mjs running (with socket.io installed)"]
async fn chat_and_the_socket_talk_to_the_real_socket_io_server() {
    use intely_happy::types::{ChatEvent, ChatLink, MessageChange, SendState};

    let url = std::env::var("INTELY_MOCK_HAPPY_URL").expect("INTELY_MOCK_HAPPY_URL");
    let token = std::env::var("INTELY_MOCK_HAPPY_TOKEN").expect("INTELY_MOCK_HAPPY_TOKEN");
    assert!(url.starts_with("http://127.0.0.1:"), "the mock server is loopback only");
    mock_post(&url, "/__mock/reset", serde_json::json!({})).await;
    let rig = Rig::fast(url.clone()).await;
    rig.switch_chat(true, true).await;
    assert!(rig.hub.save_token(&token).await.ok);
    rig.wait_state("chat", ProviderState::Ready).await;
    rig.wait_state("meet", ProviderState::Ready).await;
    common::wait_for(|| async { rig.hub.socket_link() == ChatLink::Live }).await;
    assert_eq!(rig.hub.socket_attempts(), 1, "chat and meet share one socket");

    let summary = rig.hub.chat_summary();
    assert_eq!(summary.channels.len(), 4, "general, ops, the DM and the group DM (random is only browsable)");
    let id_of = |name: &str| rig.hub.chat_summary().channels.iter().find(|c| c.name == name).map(|c| c.id.clone()).unwrap_or_else(|| panic!("no channel {name}"));
    let (general, ops) = (id_of("general"), id_of("ops"));
    let new_ids = || -> Vec<String> {
        rig.sink.chats.lock().unwrap().iter().filter_map(|e| match e { ChatEvent::Message { message, change: MessageChange::New, .. } => Some(message.id.clone()), _ => None }).collect()
    };
    mock_post(&url, "/__mock/chat/say", serde_json::json!({ "channelId": "ops", "text": "hotfix", "from": "u_3", "mention": true, "replay": true })).await;
    common::wait_for(|| async { !new_ids().is_empty() }).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(new_ids().len(), 1, "the replayed event is deduplicated");
    assert_eq!(rig.hub.chat_summary().channels.iter().find(|c| c.id == ops).map(|c| c.mention_count >= 1), Some(true));

    // Server-side drop: reconnect with the same auth, still one live socket afterwards.
    mock_post(&url, "/__mock/chat/drop", serde_json::json!({})).await;
    common::wait_for(|| async { rig.hub.socket_attempts() >= 2 && rig.hub.socket_link() == ChatLink::Live }).await;

    let page = rig.hub.chat_open(&general).await.unwrap();
    assert_eq!((page.messages.len(), page.has_more), (50, true));
    let sent = rig.hub.chat_send(&general, "szia a mock szervernek", vec![], None, None).await.unwrap();
    assert_eq!(sent.send_state, SendState::Sent);
    assert_eq!(rig.hub.chat_open(&general).await.unwrap().messages.iter().filter(|m| m.text == "szia a mock szervernek").count(), 1, "REST copy and socket echo are one message");

    mock_post(&url, "/__mock/chat/script", serde_json::json!({ "name": "meeting-lobby" })).await;
    common::wait_for(|| async { rig.hub.meet_current().meetings.iter().any(|m| m.id == "m_live_2" && m.waiting == Some(2)) }).await;

    mock_post(&url, "/__mock/revoke", serde_json::json!({})).await;
    common::wait_for(|| async { rig.hub.status().await.signed_out.is_some() }).await;
    assert_eq!((rig.hub.socket_running(), rig.hub.has_client()), (false, false));
    mock_post(&url, "/__mock/reset", serde_json::json!({})).await;
}
