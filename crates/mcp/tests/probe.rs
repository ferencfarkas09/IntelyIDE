//! The Test probe against the fixture servers (MCP spec 9.2 "probe stdio" and "probe http").

mod common;

use std::time::{Duration, Instant};

use common::*;
use intely_core::jail::Jail;
use intely_mcp::error::code;
use intely_mcp::probe::probe;

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

async fn gone_within(pid: i32, secs: u64) -> bool {
    let until = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < until {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    !alive(pid)
}

fn pids(path: &std::path::Path) -> Vec<i32> {
    for _ in 0..40 {
        if let Ok(t) = std::fs::read_to_string(path) {
            let v: Vec<i32> = t.split_whitespace().filter_map(|p| p.parse().ok()).collect();
            if !v.is_empty() {
                return v;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("no pidfile");
}

#[tokio::test]
async fn ok_returns_the_tools_with_their_annotations() {
    need_node!();
    let r = probe(&stdio_probe("ok", vec![]), probe_opts(10_000), &jail_off()).await;
    let ok = r.outcome.expect("ok");
    assert_eq!(ok.protocol_version, "2025-06-18");
    assert_eq!((ok.server_name.as_str(), ok.server_version.as_str()), ("fixture", "1.0.0"));
    assert_eq!(ok.capabilities, (true, true, false));
    assert!(!ok.truncated && ok.instructions.is_none() && ok.instructions_hash.is_none());
    let tool = |n: &str| ok.tools.iter().find(|t| t.name == n).unwrap_or_else(|| panic!("tool {n}"));
    assert_eq!(tool("echo").read_only_hint, Some(true));
    assert_eq!(tool("write_note").read_only_hint, Some(false));
    assert_eq!(tool("mystery").read_only_hint, None);
    assert_eq!(tool("delete_file").destructive_hint, Some(true));
    assert_eq!(tool("do.thing").name, "do.thing");
    assert_eq!(ok.tools.len(), 13);
    assert!(tool("echo").description.as_deref().unwrap().starts_with("Returns"));
}

#[tokio::test]
async fn many_stops_at_five_hundred_and_says_truncated() {
    need_node!();
    let ok = probe(&stdio_probe("many", vec![]), probe_opts(10_000), &jail_off()).await.outcome.expect("ok");
    assert_eq!(ok.tools.len(), 500);
    assert!(ok.truncated);
}

#[tokio::test]
async fn noannotations_reads_as_not_stated() {
    need_node!();
    let ok = probe(&stdio_probe("noannotations", vec![]), probe_opts(10_000), &jail_off()).await.outcome.expect("ok");
    assert!(ok.tools.iter().all(|t| t.read_only_hint.is_none()));
}

#[tokio::test]
async fn slow_and_hang_end_at_the_deadline_and_the_process_is_gone() {
    need_node!();
    for mode in ["slow", "hang"] {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("pids");
        let started = Instant::now();
        let r = probe(&stdio_probe(mode, vec![plain("FIXTURE_PIDFILE", pidfile.to_str().unwrap())]), probe_opts(800), &jail_off()).await;
        assert_eq!(r.outcome.err().expect("fails").code, code::TIMEOUT, "{mode}");
        assert!(started.elapsed() < Duration::from_secs(4), "{mode} took {:?}", started.elapsed());
        let pid = pids(&pidfile)[0];
        assert!(gone_within(pid, 3).await, "{mode}: the server process {pid} survived");
    }
}

#[tokio::test]
async fn a_grandchild_is_killed_with_the_group_after_a_successful_run() {
    need_node!();
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("pids");
    let r = probe(&stdio_probe("grandchild", vec![plain("FIXTURE_PIDFILE", pidfile.to_str().unwrap())]), probe_opts(10_000), &jail_off()).await;
    assert!(r.outcome.is_ok());
    let p = pids(&pidfile);
    assert_eq!(p.len(), 2, "{p:?}");
    assert!(gone_within(p[0], 3).await && gone_within(p[1], 3).await, "the group {p:?} survived");
}

#[tokio::test]
async fn an_early_exit_is_reported_with_the_scrubbed_stderr_tail() {
    need_node!();
    let r = probe(&stdio_probe("exit", vec![secret("FIXTURE_TOKEN", CANARY)]), probe_opts(10_000), &jail_off()).await;
    let e = r.outcome.err().expect("fails");
    assert_eq!(e.code, code::EXITED);
    let all = format!("{} {} {:?} {}", e.message, e.detail.clone().unwrap_or_default(), e, r.stderr_tail);
    assert!(!all.contains(CANARY), "{all}");
    assert!(r.stderr_tail.contains("[redacted]"), "{}", r.stderr_tail);
    assert!(e.detail.unwrap().contains("exit code 3"));
}

#[tokio::test]
async fn a_banner_on_stdout_and_a_giant_line_are_protocol_errors() {
    need_node!();
    let r = probe(&stdio_probe("badjson", vec![]), probe_opts(10_000), &jail_off()).await;
    let e = r.outcome.err().expect("fails");
    assert_eq!(e.code, code::PROTOCOL);
    assert!(e.message.contains("banner"), "{}", e.message);
    let r = probe(&stdio_probe("big", vec![]), probe_opts(10_000), &jail_off()).await;
    assert_eq!(r.outcome.err().expect("fails").code, code::PROTOCOL);
}

#[tokio::test]
async fn server_requests_are_answered_and_the_handshake_completes() {
    need_node!();
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("answers.jsonl");
    let r = probe(&stdio_probe("serverrequests", vec![plain("FIXTURE_LOG", log.to_str().unwrap())]), probe_opts(10_000), &jail_off()).await;
    assert!(r.outcome.is_ok(), "{:?}", r.outcome.err());
    let lines: Vec<serde_json::Value> = std::fs::read_to_string(&log).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    let by = |id: &str| lines.iter().find(|l| l["id"] == id).unwrap_or_else(|| panic!("answer to {id}: {lines:?}"));
    assert_eq!(by("s1")["result"], serde_json::json!({}), "ping answered");
    assert_eq!(by("s2")["error"]["code"], -32601, "roots/list refused");
    assert_eq!(by("s3")["error"]["code"], -32601, "sampling refused");
}

#[tokio::test]
async fn the_child_gets_a_clean_environment_and_a_private_working_directory() {
    need_node!();
    std::env::set_var("INTELY_PROBE_CANARY", "1");
    std::env::set_var("ANTHROPIC_API_KEY", "not-a-real-key");
    std::env::set_var("SSH_AUTH_SOCK", "/tmp/not-an-agent");
    let dir = tempfile::tempdir().unwrap();
    let envfile = dir.path().join("env.json");
    let r = probe(&stdio_probe("ok", vec![plain("FIXTURE_ENVFILE", envfile.to_str().unwrap()), plain("LOG_LEVEL", "info")]), probe_opts(10_000), &jail_off()).await;
    assert!(r.outcome.is_ok());
    let seen: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&envfile).unwrap()).unwrap();
    let names: Vec<&str> = seen["env"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
    for banned in ["INTELY_PROBE_CANARY", "ANTHROPIC_API_KEY", "SSH_AUTH_SOCK", "HOME", "USER"] {
        assert!(!names.contains(&banned), "{banned} reached the child: {names:?}");
    }
    assert!(names.contains(&"PATH") && names.contains(&"LOG_LEVEL"));
    let cwd = std::path::PathBuf::from(seen["cwd"].as_str().unwrap());
    assert!(cwd.file_name().unwrap().to_string_lossy().starts_with("intely-mcp-test-"), "{cwd:?}");
    assert!(!cwd.exists(), "the working directory is removed afterwards");
}

#[tokio::test]
async fn instructions_come_back_sanitised_cut_and_hashed() {
    need_node!();
    let raw = format!("Use me.\u{1b}[31m\u{202e}\nSecond line {CANARY}\n{}", "x".repeat(5000));
    let r = probe(&stdio_probe("ok", vec![plain("FIXTURE_INSTRUCTIONS", &raw), secret("FIXTURE_TOKEN", CANARY)]), probe_opts(10_000), &jail_off()).await;
    let ok = r.outcome.expect("ok");
    let text = ok.instructions.expect("instructions");
    assert!(!text.contains('\u{1b}') && !text.contains('\u{202e}') && text.contains("Second line"), "{text:.80}");
    assert!(!text.contains(CANARY) && text.contains("[redacted]"));
    assert!(text.ends_with("[...cut]") && text.chars().count() < 4100);
    assert_eq!(ok.instructions_hash.unwrap().len(), 64);
}

#[tokio::test]
async fn every_form_a_server_echoes_is_scrubbed_from_the_stderr_tail() {
    need_node!();
    for value in ["Bearer CANARYbare7f3atoken".to_owned(), format!("Basic {}", base64("alice:CANARYpw7f3a")), "CANARY&value/7f3a".to_owned()] {
        let r = probe(&stdio_probe("ok", vec![secret("FIXTURE_AUTH_VALUE", &value), plain("FIXTURE_ECHO", "FIXTURE_AUTH_VALUE")]), probe_opts(10_000), &jail_off()).await;
        // `ok` mode completes at once: the echo lines are written before the handshake
        let tail = r.stderr_tail;
        assert!(tail.contains("[redacted]"), "{value}: {tail}");
        for leaked in ["CANARYbare7f3atoken", "CANARYpw7f3a", "CANARY&value/7f3a", "CANARY%26value%2F7f3a", base64("alice:CANARYpw7f3a").as_str()] {
            assert!(!tail.contains(leaked), "{leaked} leaked in {tail}");
        }
    }
}

fn base64(text: &str) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in text.as_bytes().chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        for i in 0..4 {
            out.push(if i <= c.len() { A[((n >> (18 - 6 * i)) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

#[tokio::test]
async fn a_command_that_does_not_exist_fails_to_spawn() {
    let mut s = stdio_probe("ok", vec![]);
    s.command = Some("/nonexistent/definitely-not-here".into());
    assert_eq!(probe(&s, probe_opts(2000), &jail_off()).await.outcome.err().unwrap().code, code::SPAWN_FAILED);
    s.command = None;
    assert_eq!(probe(&s, probe_opts(2000), &jail_off()).await.outcome.err().unwrap().code, code::SPAWN_FAILED);
}

#[tokio::test]
async fn the_read_only_jail_refuses_before_any_process_or_socket() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("pids");
    let r = probe(&stdio_probe("ok", vec![plain("FIXTURE_PIDFILE", marker.to_str().unwrap())]), probe_opts(2000), &Jail::read_only()).await;
    assert_eq!(r.outcome.err().unwrap().code, code::READ_ONLY);
    assert!(!marker.exists(), "no process was started");
    let r = probe(&http_probe("http://127.0.0.1:9/mcp", vec![]), probe_opts(2000), &Jail::read_only()).await;
    assert_eq!(r.outcome.err().unwrap().code, code::READ_ONLY);
}

#[tokio::test]
async fn http_ok_resends_the_session_and_sends_the_credentials_without_leaking_them() {
    need_node!();
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("http.jsonl");
    let fx = HttpFixture::start("ok", None, Some(&log));
    let bearer = format!("Bearer {CANARY}");
    let r = probe(&http_probe(&fx.url(), vec![secret("Authorization", &bearer)]), probe_opts(10_000), &jail_off()).await;
    let ok = r.outcome.expect("ok");
    assert_eq!(ok.tools.len(), 2);
    assert_eq!(ok.server_name, "fixture-http");
    std::thread::sleep(Duration::from_millis(200));
    let lines: Vec<serde_json::Value> = std::fs::read_to_string(&log).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    let has = |l: &serde_json::Value, h: &str| l["headers"].as_array().unwrap().iter().any(|n| n == h);
    assert!(lines.iter().all(|l| has(l, "authorization")), "Authorization is sent with every request: {lines:?}");
    assert!(lines.iter().skip(1).filter(|l| l["method"] == "POST").all(|l| has(l, "mcp-session-id") && has(l, "mcp-protocol-version")), "{lines:?}");
    assert!(lines.iter().any(|l| l["method"] == "DELETE"), "the session is ended");
    assert!(!std::fs::read_to_string(&log).unwrap().contains(CANARY), "the fixture log records names only");
}

#[tokio::test]
async fn http_sse_replies_are_read() {
    need_node!();
    let fx = HttpFixture::start("sse", None, None);
    let ok = probe(&http_probe(&fx.url(), vec![]), probe_opts(10_000), &jail_off()).await.outcome.expect("ok");
    assert_eq!(ok.tools.len(), 2);
}

#[tokio::test]
async fn http_auth_failures_are_told_apart_from_oauth() {
    need_node!();
    let plain_fx = HttpFixture::start("needsauth", Some(CANARY), None);
    let r = probe(&http_probe(&plain_fx.url(), vec![]), probe_opts(10_000), &jail_off()).await;
    let e = r.outcome.err().expect("fails");
    assert_eq!((e.code.as_str(), e.detail), (code::AUTH, None));
    // with the right header it works, and the canary is in no report
    let r = probe(&http_probe(&plain_fx.url(), vec![secret("Authorization", &format!("Bearer {CANARY}"))]), probe_opts(10_000), &jail_off()).await;
    let ok = r.outcome.expect("ok");
    assert!(!format!("{ok:?}").contains(CANARY));
    let oauth = HttpFixture::start("oauth", Some(CANARY), None);
    let e = probe(&http_probe(&oauth.url(), vec![]), probe_opts(10_000), &jail_off()).await.outcome.err().expect("fails");
    assert_eq!((e.code.as_str(), e.detail.as_deref()), (code::AUTH, Some("oauth")));
}

#[tokio::test]
async fn http_redirects_are_not_followed_and_server_errors_carry_only_the_status() {
    need_node!();
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("r.jsonl");
    let fx = HttpFixture::start("redirect", None, Some(&log));
    let e = probe(&http_probe(&fx.url(), vec![secret("Authorization", &format!("Bearer {CANARY}"))]), probe_opts(10_000), &jail_off()).await.outcome.err().expect("fails");
    assert_eq!((e.code.as_str(), e.detail.as_deref()), (code::HTTP_STATUS, Some("302")));
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 1, "the redirect was not followed");
    let fx = HttpFixture::start("status500", None, None);
    let e = probe(&http_probe(&fx.url(), vec![]), probe_opts(10_000), &jail_off()).await.outcome.err().expect("fails");
    assert_eq!((e.code.as_str(), e.detail.as_deref()), (code::HTTP_STATUS, Some("500")));
    assert!(!format!("{e:?}").contains("boom"), "the body never leaves");
}

#[tokio::test]
async fn http_connection_refused_is_a_connect_error() {
    let e = probe(&http_probe("http://127.0.0.1:9/mcp", vec![]), probe_opts(3000), &jail_off()).await.outcome.err().expect("fails");
    assert!(matches!(e.code.as_str(), code::CONNECT | code::TIMEOUT), "{e:?}");
}

#[tokio::test]
async fn the_e2e_jail_talks_to_loopback_only() {
    need_node!();
    let root = tempfile::tempdir().unwrap();
    let jail = Jail::e2e(root.path());
    let e = probe(&http_probe("https://example.com/mcp", vec![]), probe_opts(3000), &jail).await.outcome.err().expect("refused");
    assert_eq!(e.code, code::TEST_JAIL);
    let e = probe(&http_probe("http://10.0.0.5/mcp", vec![]), probe_opts(3000), &jail).await.outcome.err().expect("refused");
    assert_eq!(e.code, code::TEST_JAIL);
    let fx = HttpFixture::start("ok", None, None);
    assert!(probe(&http_probe(&fx.url(), vec![]), probe_opts(10_000), &jail).await.outcome.is_ok(), "loopback is allowed");
    // stdio is allowed under the e2e jail
    assert!(probe(&stdio_probe("ok", vec![]), probe_opts(10_000), &jail).await.outcome.is_ok());
}
