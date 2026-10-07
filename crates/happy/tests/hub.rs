mod common;

use std::time::Duration;

use common::{fixtures, wait_for, Resp, Rig, Stub, JWT};
use intely_happy::types::{ConfigPatch, Env, PrefsPatch, ProviderState, TimerPhase, Trackable};
use serde_json::json;

fn no_requests_for_a_moment() -> impl std::future::Future<Output = ()> {
    tokio::time::sleep(Duration::from_millis(300))
}

#[tokio::test]
async fn switched_off_costs_nothing_even_with_a_token_and_provider_switches_on() {
    let stub = Stub::start(fixtures).await;
    let rig = Rig::new(&stub).await;
    rig.give_token();
    // Providers enabled, master off.
    let prefs = |on| Some(PrefsPatch { enabled: Some(on), ..Default::default() });
    rig.hub.set_config(ConfigPatch { master: Some(false), timer: prefs(true), meet: prefs(true), ..Default::default() }).await.unwrap();
    rig.hub.start().await;
    no_requests_for_a_moment().await;
    assert_eq!((stub.count(), rig.hub.running_tasks(), rig.hub.has_client()), (0, 0, false));
    assert_eq!(rig.state_of("timer").await, ProviderState::Off);
    // Master on but no provider on: still nothing.
    rig.hub.set_config(ConfigPatch { master: Some(true), timer: prefs(false), meet: prefs(false), ..Default::default() }).await.unwrap();
    no_requests_for_a_moment().await;
    assert_eq!((stub.count(), rig.hub.running_tasks(), rig.hub.has_client()), (0, 0, false));
}

#[tokio::test]
async fn without_a_token_the_providers_wait_and_nothing_is_sent() {
    let stub = Stub::start(fixtures).await;
    let rig = Rig::new(&stub).await;
    rig.switch_on(true, true).await;
    no_requests_for_a_moment().await;
    assert_eq!(rig.state_of("timer").await, ProviderState::WaitingForToken);
    assert_eq!((stub.count(), rig.hub.running_tasks(), rig.hub.has_client()), (0, 0, false));
    assert!(!rig.hub.status().await.token_saved);
}

#[tokio::test]
async fn a_saved_token_starts_the_enabled_providers_and_the_timer_is_normalised() {
    let stub = Stub::start(fixtures).await;
    let rig = Rig::new(&stub).await;
    rig.switch_on(true, true).await;
    let test = rig.hub.save_token(JWT).await;
    assert!(test.ok, "{test:?}");
    assert!(test.providers.iter().all(|p| p.allowed));
    rig.wait_state("timer", ProviderState::Ready).await;
    rig.wait_state("meet", ProviderState::Ready).await;
    let timer = rig.hub.timer_current();
    assert_eq!((timer.phase, timer.title.as_str(), timer.project.as_deref()), (TimerPhase::Running, "Receipts", Some("Shop POS")));
    assert_eq!(rig.sink.timers.lock().unwrap().len(), 1, "one event for one change");
    assert_eq!(rig.hub.meet_current().meetings[0].title, "Standup");
    let status = rig.hub.status().await;
    assert!(status.token_saved && status.signed_out.is_none());
    wait_for(|| async { rig.hub.status().await.user.is_some() }).await;
    let reqs = stub.requests.lock().unwrap().clone();
    let auth = reqs.iter().find(|r| r.path == "/api/projects/me/running-timer").unwrap();
    assert_eq!(auth.headers.get("authorization").map(String::as_str), Some(format!("Bearer {JWT}").as_str()));
    assert!(auth.headers.contains_key("x-device-id") && auth.headers.get("x-device-name").is_some_and(|n| n == "Intely IDE"));
}

#[tokio::test]
async fn a_bad_token_is_not_saved() {
    let stub = Stub::start(|_| Resp::json(401, json!({ "code": "ACCOUNT_INACTIVE" }))).await;
    let rig = Rig::new(&stub).await;
    let test = rig.hub.save_token(JWT).await;
    assert!(!test.ok);
    assert!(test.message.unwrap().contains("ACCOUNT_INACTIVE"));
    assert!(!rig.hub.status().await.token_saved);
    let not_a_jwt = rig.hub.save_token("not a token").await;
    assert!(!not_a_jwt.ok);
    assert_eq!(stub.count(), 1, "a malformed token is refused before anything is sent");
}

#[tokio::test]
async fn a_401_stops_the_whole_connection_and_the_banner_stays() {
    let stub = Stub::start(fixtures).await;
    let rig = Rig::new(&stub).await;
    rig.switch_on(true, true).await;
    assert!(rig.hub.save_token(JWT).await.ok);
    rig.wait_state("timer", ProviderState::Ready).await;
    // The session is revoked server side.
    let revoked = Stub::start(|_| Resp::json(401, json!({ "code": "DEVICE_LOGGED_OUT", "message": format!("token {JWT} revoked") }))).await;
    rig.hub.set_config(ConfigPatch { env: Some(Env::Custom), custom_base_url: Some(revoked.url()), ..Default::default() }).await.unwrap();
    rig.give_token();
    rig.hub.apply().await;
    rig.wait_state("timer", ProviderState::SignedOut).await;
    rig.wait_state("meet", ProviderState::SignedOut).await;
    let status = rig.hub.status().await;
    let banner = status.signed_out.clone().expect("banner");
    assert_eq!(banner.code, "DEVICE_LOGGED_OUT");
    assert!(!banner.message.contains("Y2FuYXJ5"), "{}", banner.message);
    assert_eq!((rig.hub.running_tasks(), rig.hub.has_client()), (0, false));
    let seen = revoked.count();
    no_requests_for_a_moment().await;
    assert_eq!(revoked.count(), seen, "no retry after a 401");
    assert!(!format!("{status:?}").contains("Y2FuYXJ5"));
}

#[tokio::test]
async fn a_403_marks_only_that_provider_not_permitted() {
    let stub = Stub::start(|r| if r.path == "/api/chat/meetings" { Resp::json(403, json!({ "code": "forbidden_scope" })) } else { fixtures(r) }).await;
    let rig = Rig::new(&stub).await;
    rig.switch_on(true, true).await;
    let test = rig.hub.save_token(JWT).await;
    assert!(test.ok);
    assert!(test.providers.iter().any(|p| p.id == "meet" && !p.allowed && p.hint.is_some()));
    rig.wait_state("timer", ProviderState::Ready).await;
    rig.wait_state("meet", ProviderState::NotPermitted).await;
    assert_eq!(rig.hub.running_tasks(), 1);
    assert!(rig.hub.status().await.signed_out.is_none());
}

#[tokio::test]
async fn a_blurred_window_polls_the_timer_slowly_and_focus_catches_up_at_once() {
    let stub = Stub::start(fixtures).await;
    let rig = Rig::new(&stub).await;
    rig.give_token();
    rig.hub.set_focus(false);
    rig.switch_on(true, false).await;
    // The Time Tracer follows a timer changed elsewhere while the window is not in front (about every 5 s), so it comes up without focus.
    rig.wait_state("timer", ProviderState::Ready).await;
    let polls = || stub.paths().iter().filter(|p| p.contains("running-timer")).count();
    let first = polls();
    assert!(first >= 1, "{:?}", stub.paths());
    no_requests_for_a_moment().await;
    assert_eq!(polls(), first, "the blurred pace is slow, not the focused 4 s");
    rig.hub.set_focus(true);
    wait_for(|| async { polls() > first }).await;
}

#[tokio::test]
async fn a_redirect_is_not_followed_and_the_token_goes_nowhere_else() {
    let elsewhere = Stub::start(fixtures).await;
    let target = format!("{}/api/user/me", elsewhere.url());
    let stub = Stub::start(move |_| Resp { status: 302, body: String::new(), headers: vec![("location".into(), target.clone())] }).await;
    let rig = Rig::new(&stub).await;
    rig.give_token();
    let test = rig.hub.test_connection().await;
    assert!(!test.ok);
    assert!(test.message.unwrap().contains("redirect"));
    assert_eq!(elsewhere.count(), 0);
}

#[tokio::test]
async fn actions_off_blocks_mutating_calls_before_they_are_sent() {
    let stub = Stub::start(fixtures).await;
    let rig = Rig::new(&stub).await;
    rig.switch_on(true, true).await;
    assert!(rig.hub.save_token(JWT).await.ok);
    rig.wait_state("timer", ProviderState::Ready).await;
    let off = Some(PrefsPatch { allow_actions: Some(false), ..Default::default() });
    rig.hub.set_config(ConfigPatch { timer: off.clone(), meet: off, ..Default::default() }).await.unwrap();
    rig.wait_state("timer", ProviderState::Ready).await;
    let target = Trackable { kind: "project".into(), id: "p_pos".into(), task_id: None, title: "x".into(), project: None };
    assert_eq!(rig.hub.timer_start(target).await.unwrap_err().code, "blocked");
    assert_eq!(rig.hub.meet_join("m_live_1").await.unwrap_err().code, "blocked");
    assert!(!stub.paths().iter().any(|p| p.starts_with("POST")), "{:?}", stub.paths());
}

#[tokio::test]
async fn stopping_an_already_stopped_timer_clears_the_state() {
    let stub = Stub::start(fixtures).await;
    let rig = Rig::new(&stub).await;
    rig.switch_on(true, false).await;
    assert!(rig.hub.save_token(JWT).await.ok);
    rig.wait_state("timer", ProviderState::Ready).await;
    assert_eq!(rig.hub.timer_current().phase, TimerPhase::Running);
    let view = rig.hub.timer_stop().await.unwrap();
    assert_eq!(view.phase, TimerPhase::Idle);
    assert_eq!(rig.sink.timers.lock().unwrap().last().unwrap().phase, TimerPhase::Idle);
}

#[tokio::test]
async fn joining_opens_the_https_link_in_the_browser_and_never_returns_or_logs_it() {
    let stub = Stub::start(fixtures).await;
    let rig = Rig::new(&stub).await;
    rig.switch_on(false, true).await;
    assert!(rig.hub.save_token(JWT).await.ok);
    rig.wait_state("meet", ProviderState::Ready).await;
    rig.hub.meet_join("m_live_1").await.unwrap();
    assert_eq!(rig.opener.opened.lock().unwrap().len(), 1);
    assert!(rig.opener.opened.lock().unwrap()[0].starts_with("https://meet.example.test/"));
    assert!(!format!("{:?}{:?}", rig.sink.meetings.lock().unwrap(), rig.sink.states.lock().unwrap()).contains("LIVEKIT-CANARY"));
    let err = rig.hub.meet_join("../../etc/passwd").await.unwrap_err();
    assert_eq!(err.code, "blocked");
}

#[tokio::test]
async fn an_http_join_link_is_refused() {
    let stub = Stub::start(|r| if r.method == "POST" { Resp::json(200, json!({ "joinUrl": "http://insecure.example.test/j#token=LIVEKIT-CANARY" })) } else { fixtures(r) }).await;
    let rig = Rig::new(&stub).await;
    rig.switch_on(false, true).await;
    assert!(rig.hub.save_token(JWT).await.ok);
    rig.wait_state("meet", ProviderState::Ready).await;
    let err = rig.hub.meet_join("m_live_1").await.unwrap_err();
    assert_eq!(err.code, "invalidJoinUrl");
    assert!(!err.to_string().contains("LIVEKIT-CANARY") && !err.to_string().contains("insecure"));
    assert!(rig.opener.opened.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_token_never_reaches_settings_json_or_the_status() {
    let stub = Stub::start(fixtures).await;
    let rig = Rig::new(&stub).await;
    rig.switch_on(true, true).await;
    assert!(rig.hub.save_token(JWT).await.ok);
    rig.wait_state("timer", ProviderState::Ready).await;
    let file = std::fs::read_to_string(&rig.settings_path).unwrap();
    assert!(!file.contains("Y2FuYXJ5") && !file.contains("eyJ"), "{file}");
    assert!(file.contains("deviceId") && file.contains("customBaseUrl"));
    assert!(!format!("{:?}", rig.hub.status().await).contains("eyJ"));
}

#[tokio::test]
async fn disconnect_removes_the_token_and_stops_everything() {
    let stub = Stub::start(fixtures).await;
    let rig = Rig::new(&stub).await;
    rig.switch_on(true, true).await;
    assert!(rig.hub.save_token(JWT).await.ok);
    rig.wait_state("timer", ProviderState::Ready).await;
    let status = rig.hub.disconnect().await;
    assert!(!status.token_saved && status.user.is_none());
    assert_eq!((rig.hub.running_tasks(), rig.hub.has_client()), (0, false));
    assert_eq!(rig.state_of("timer").await, ProviderState::WaitingForToken);
}

#[tokio::test]
async fn an_invalid_custom_url_is_rejected_and_not_saved() {
    let stub = Stub::start(fixtures).await;
    let rig = Rig::new(&stub).await;
    let err = rig.hub.set_config(ConfigPatch { custom_base_url: Some("http://evil.example.test".into()), ..Default::default() }).await.unwrap_err();
    assert_eq!(err.code, "invalidBaseUrl");
    assert_eq!(rig.hub.status().await.config.custom_base_url.as_deref(), Some(stub.url().as_str()));
}
